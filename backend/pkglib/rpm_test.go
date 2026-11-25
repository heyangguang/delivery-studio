package pkglib

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/openpgp"

	"delivery-studio/mwpack"
)

func TestRpmvercmpFollowsRpmOrdering(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"1.0", "1.0", 0},
		{"1.0", "1.0.1", -1},
		{"2.0", "10", -1},
		{"1.0a", "1.0", 1},
		{"1.0~rc1", "1.0", -1},
		{"1.0^git1", "1.0", 1},
		{"1.0^git1", "1.0.1", -1},
		{"5.3.0", "5.3.0", 0},
		{"el9_8.2", "el9_8.10", -1},
		{"1.a", "1.1", -1}, // a number is newer than letters
	} {
		if got := rpmvercmp(c.a, c.b); got != c.want {
			t.Errorf("rpmvercmp(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
		if got := rpmvercmp(c.b, c.a); got != -c.want {
			t.Errorf("rpmvercmp(%q, %q) = %d, want %d", c.b, c.a, got, -c.want)
		}
	}
	if CompareRPM("1:1.0-1", "2.0-1") <= 0 {
		t.Error("an epoch beats any version")
	}
	if !rpmSatisfies("1:3.5.8-2.el9_8", "GE", "1:3.5") {
		t.Error("a requirement without a release matches any release")
	}
}

func TestParseRichReadsBooleanDependencies(t *testing.T) {
	n := parseRich("(libfoo.so.1()(64bit) or (bar >= 2.0 if baz))")
	if n == nil || n.op != "or" || n.args[0].dep.Name != "libfoo.so.1()(64bit)" {
		t.Fatalf("parsed %+v", n)
	}
	r := n.args[1]
	if r.op != "if" || r.args[0].dep != (rpmDep{"bar", "GE", "2.0"}) || r.args[1].dep.Name != "baz" {
		t.Fatalf("right side %+v", r)
	}
	if parseRich("(a or") != nil {
		t.Error("an unfinished expression must not parse")
	}
}

// fakeRpmRepo is a signed rpm repository served over HTTP.
type fakeRpmRepo struct {
	srv      *httptest.Server
	entity   *openpgp.Entity
	primary  []byte
	revision string
}

func rpmPkgXML(name, ver, rel, srpm string, provides, requires, files []string) string {
	sum := sha256.Sum256([]byte(name + ver + rel))
	epoch := "0"
	if e, v, ok := strings.Cut(ver, ":"); ok {
		epoch, ver = e, v
	}
	var b strings.Builder
	fmt.Fprintf(&b, "<package type=\"rpm\">\n  <name>%s</name>\n  <arch>x86_64</arch>\n  <version epoch=\"%s\" ver=\"%s\" rel=\"%s\"/>\n  <checksum type=\"sha256\" pkgid=\"YES\">%s</checksum>\n  <summary>%s package</summary>\n  <size package=\"1000\" installed=\"2000\" archive=\"2000\"/>\n  <location href=\"Packages/%s-%s-%s.x86_64.rpm\"/>\n  <format>\n    <rpm:sourcerpm>%s</rpm:sourcerpm>\n    <rpm:provides>\n      <rpm:entry name=\"%s\" flags=\"EQ\" epoch=\"%s\" ver=\"%s\" rel=\"%s\"/>\n", name, epoch, ver, rel, hex.EncodeToString(sum[:]), name, name, ver, rel, srpm, name, epoch, ver, rel)
	// like real packages, every package also provides its name qualified with the architecture
	fmt.Fprintf(&b, "      <rpm:entry name=\"%s(x86-64)\" flags=\"EQ\" epoch=\"%s\" ver=\"%s\" rel=\"%s\"/>\n", name, epoch, ver, rel)
	for _, p := range provides {
		fmt.Fprintf(&b, "      <rpm:entry name=\"%s\"/>\n", p)
	}
	b.WriteString("    </rpm:provides>\n    <rpm:requires>\n")
	for _, r := range requires {
		if n, v, ok := strings.Cut(r, ">="); ok {
			e := parseEVR(strings.TrimSpace(v))
			fmt.Fprintf(&b, "      <rpm:entry name=\"%s\" flags=\"GE\" epoch=\"%d\" ver=\"%s\"/>\n", strings.TrimSpace(n), e.e, e.v)
		} else if n, v, ok := strings.Cut(r, "=="); ok {
			e := parseEVR(strings.TrimSpace(v))
			fmt.Fprintf(&b, "      <rpm:entry name=\"%s\" flags=\"EQ\" epoch=\"%d\" ver=\"%s\" rel=\"%s\"/>\n", strings.TrimSpace(n), e.e, e.v, e.r)
		} else {
			fmt.Fprintf(&b, "      <rpm:entry name=\"%s\"/>\n", strings.ReplaceAll(r, "\"", "&quot;"))
		}
	}
	b.WriteString("    </rpm:requires>\n")
	for _, f := range files {
		fmt.Fprintf(&b, "    <file>%s</file>\n", f)
	}
	b.WriteString("  </format>\n</package>\n")
	return b.String()
}

func newFakeRpmRepo(t *testing.T, revision string, pkgs ...string) *fakeRpmRepo {
	t.Helper()
	e, err := openpgp.NewEntity("test rpm repo", "", "r@example.invalid", nil)
	if err != nil {
		t.Fatal(err)
	}
	doc := fmt.Sprintf("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<metadata xmlns=\"http://linux.duke.edu/metadata/common\" xmlns:rpm=\"http://linux.duke.edu/metadata/rpm\" packages=\"%d\">\n%s</metadata>\n", len(pkgs), strings.Join(pkgs, ""))
	r := &fakeRpmRepo{entity: e, primary: gzipBytes(doc), revision: revision}
	r.srv = httptest.NewServer(http.HandlerFunc(r.serve))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *fakeRpmRepo) repomd() []byte {
	sum := sha256.Sum256(r.primary)
	return []byte(fmt.Sprintf("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<repomd xmlns=\"http://linux.duke.edu/metadata/repo\">\n  <revision>%s</revision>\n  <data type=\"primary\">\n    <checksum type=\"sha256\">%s</checksum>\n    <location href=\"repodata/primary.xml.gz\"/>\n    <size>%d</size>\n  </data>\n</repomd>\n", r.revision, hex.EncodeToString(sum[:]), len(r.primary)))
}

func (r *fakeRpmRepo) serve(w http.ResponseWriter, req *http.Request) {
	switch req.URL.Path {
	case "/repodata/repomd.xml":
		w.Write(r.repomd())
	case "/repodata/repomd.xml.asc":
		var sig bytes.Buffer
		openpgp.ArmoredDetachSign(&sig, r.entity, bytes.NewReader(r.repomd()), nil)
		w.Write(sig.Bytes())
	case "/repodata/primary.xml.gz":
		w.Write(r.primary)
	default:
		http.NotFound(w, req)
	}
}

// sources lists only this repository for el9, with its public key beside the list.
func (r *fakeRpmRepo) sources(t *testing.T) *Sources {
	t.Helper()
	dir := t.TempDir()
	yaml := filepath.Join(dir, "sources.yaml")
	off := ""
	for _, id := range []string{"rocky9-appstream"} {
		off += fmt.Sprintf("- id: %s\n  title: off\n  platforms: [el9-amd64]\n  kind: rpm\n  baseurl: %s/\n  key_file: test.gpg\n  disabled: true\n", id, r.srv.URL)
	}
	os.WriteFile(yaml, []byte(fmt.Sprintf("- id: rocky9-baseos\n  title: test rocky\n  platforms: [el9-amd64]\n  kind: rpm\n  baseurl: %s/\n  key_file: test.gpg\n", r.srv.URL)+off), 0o600)
	os.MkdirAll(filepath.Join(dir, "sources.keys"), 0o700)
	var key bytes.Buffer
	r.entity.Serialize(&key)
	os.WriteFile(filepath.Join(dir, "sources.keys", "test.gpg"), key.Bytes(), 0o600)
	s, err := LoadSources(yaml)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

var el9 = mwpack.PlatformDef{ID: "el9-amd64", Family: "rpm", Arch: "amd64", Title: "el9"}

// baseProvides is what a package of the base system provides, so a test package replacing it can provide the same.
func baseProvides(t *testing.T, name string) []string {
	b, _ := baseFS.ReadFile("base/el9-amd64.tsv")
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Split(line, "\t")
		if len(f) > 3 && f[0] == name {
			var out []string
			for _, p := range strings.Split(f[3], "|") {
				if fs := strings.Fields(p); len(fs) == 1 {
					out = append(out, fs[0])
				}
			}
			return out
		}
	}
	t.Fatalf("%s is not in the base system", name)
	return nil
}

func TestRpmIndexResolvesFileRichSameSourceAndBaseBreakage(t *testing.T) {
	repo := newFakeRpmRepo(t, "1700000000",
		// the app needs a file, a boolean alternative, a virtual capability and a newer libssl
		rpmPkgXML("app", "1.0", "1.el9", "app-1.0-1.el9.src.rpm", nil, []string{"/usr/bin/helper", "(fancy or plain)", "openssl-libs >= 1:3.5"}, nil),
		rpmPkgXML("helper-tools", "2.0", "1.el9", "helper-2.0-1.el9.src.rpm", nil, nil, []string{"/usr/bin/helper"}),
		rpmPkgXML("plain", "1.0", "1.el9", "plain-1.0-1.el9.src.rpm", nil, nil, nil),
		rpmPkgXML("fancy", "1.0", "1.el9", "fancy-1.0-1.el9.src.rpm", nil, []string{"never-there"}, nil),
		// two providers of ssl-provider, which openssl-libs needs: the one from openssl's own source package wins over
		// the one with the shorter name
		rpmPkgXML("a-ssl", "1.0", "1.el9", "a-ssl-1.0-1.el9.src.rpm", []string{"ssl-provider"}, nil, nil),
		rpmPkgXML("openssl-ssl-provider", "1:3.5.8", "2.el9", "openssl-3.5.8-2.el9.src.rpm", []string{"ssl-provider"}, nil, nil),
		rpmPkgXML("openssl-libs", "1:3.5.8", "2.el9", "openssl-3.5.8-2.el9.src.rpm", baseProvides(t, "openssl-libs"), []string{"ssl-provider"}, nil),
		rpmPkgXML("openssl", "1:3.5.8", "2.el9", "openssl-3.5.8-2.el9.src.rpm", nil, []string{"openssl-libs(x86-64) == 1:3.5.8-2.el9"}, nil),
	)
	srcs := repo.sources(t)
	x := OpenIndex(t.TempDir())
	if err := x.Update(context.Background(), el9, srcs, nil); err != nil {
		t.Fatal(err)
	}
	if st := x.State(el9.ID); st.Packages != 8 || len(st.Releases) != 1 || st.Releases[0].Sig == "" {
		t.Fatalf("state: %+v", st)
	}
	plan, err := x.Resolve(el9, mwpack.PackageRequest{Name: "app", Version: "1.0-1.el9"})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, p := range plan.Packages {
		got[p.Name] = p.Reason
	}
	for _, want := range []string{"app", "helper-tools", "plain", "openssl-ssl-provider", "openssl-libs", "openssl"} {
		if _, ok := got[want]; !ok {
			t.Errorf("%s missing from the plan %v", want, got)
		}
	}
	for _, not := range []string{"fancy", "a-ssl"} {
		if _, ok := got[not]; ok {
			t.Errorf("%s must not be chosen: %v", not, got)
		}
	}
	// openssl is in the base system at 3.0.7 and pins openssl-libs to that version, so replacing openssl-libs
	// upgrades it too
	if !strings.Contains(got["openssl"], "一起升级") {
		t.Errorf("openssl must come in as an upgrade the base system needs, got %q", got["openssl"])
	}
	if len(plan.Unresolved) != 0 {
		t.Errorf("unresolved: %v", plan.Unresolved)
	}

	// export, then import on a platform without network; tampering and rollback are refused
	var pack bytes.Buffer
	if err := x.Export(&pack, el9.ID); err != nil {
		t.Fatal(err)
	}
	offline := OpenIndex(t.TempDir())
	if _, err := offline.Import(bytes.NewReader(pack.Bytes()), el9, srcs); err != nil {
		t.Fatalf("import: %v", err)
	}
	if _, err := offline.Resolve(el9, mwpack.PackageRequest{Name: "app", Version: "1.0-1.el9"}); err != nil {
		t.Fatalf("resolving on the imported index: %v", err)
	}
	bad := repack(t, pack.Bytes(), func(n string, b []byte) []byte {
		if strings.HasSuffix(n, ".primary.xml.gz") {
			return gzipBytes("<metadata/>")
		}
		return b
	})
	if _, err := OpenIndex(t.TempDir()).Import(bytes.NewReader(bad), el9, srcs); err == nil || !strings.Contains(err.Error(), "不一致") {
		t.Errorf("a changed primary must be refused, got %v", err)
	}
	forged := repack(t, pack.Bytes(), func(n string, b []byte) []byte {
		if strings.HasSuffix(n, ".repomd.xml") {
			return bytes.Replace(b, []byte("1700000000"), []byte("1800000000"), 1)
		}
		return b
	})
	if _, err := OpenIndex(t.TempDir()).Import(bytes.NewReader(forged), el9, srcs); err == nil || !strings.Contains(err.Error(), "签名") {
		t.Errorf("a changed repomd must fail its signature, got %v", err)
	}
	newer := OpenIndex(t.TempDir())
	repo.revision = "1800000000"
	if err := newer.Update(context.Background(), el9, srcs, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := newer.Import(bytes.NewReader(pack.Bytes()), el9, srcs); err == nil || !strings.Contains(err.Error(), "更旧") {
		t.Errorf("an older index must be refused, got %v", err)
	}
}

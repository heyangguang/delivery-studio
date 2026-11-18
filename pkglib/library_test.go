package pkglib

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"middleware-deployer/mwpack"
)

func sha(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// fakeDeb makes a stand-in package file with a control stanza; Assemble never opens the archive itself.
func fakeDeb(t *testing.T, dir, file, name, version string, body string) (Meta, FileRef) {
	t.Helper()
	data := []byte(body)
	if err := os.WriteFile(filepath.Join(dir, file), data, 0o600); err != nil {
		t.Fatal(err)
	}
	control := "Package: " + name + "\nVersion: " + version + "\nArchitecture: amd64\nDepends: libfoo\nDescription: test package\n a second line"
	return Meta{File: file, Name: name, Version: version, Arch: "amd64", Control: control}, FileRef{File: file, SHA256: sha(data)}
}

func putFake(t *testing.T, l *Library, platform string, req mwpack.PackageRequest, files map[string]string) {
	t.Helper()
	src := t.TempDir()
	var metas []Meta
	var refs []FileRef
	var pkgs []PkgRef
	for file, body := range files {
		name := strings.SplitN(file, "_", 2)[0]
		m, r := fakeDeb(t, src, file, name, "1.0", body)
		metas, refs, pkgs = append(metas, m), append(refs, r), append(pkgs, PkgRef{name, "1.0"})
	}
	c := Closure{Request: req, Platform: platform, Files: refs, Packages: pkgs, Via: "test"}
	if err := l.Put(c, metas, func(f string) string { return filepath.Join(src, f) }); err != nil {
		t.Fatal(err)
	}
}

func TestLibraryPutHasMissingDelete(t *testing.T) {
	l, _ := Open(t.TempDir())
	const p = "ubuntu-24.04-amd64"
	a := mwpack.PackageRequest{Name: "haproxy", Version: "2.8"}
	b := mwpack.PackageRequest{Name: "keepalived", Version: "2.2"}
	putFake(t, l, p, a, map[string]string{"haproxy_2.8_amd64.deb": "H", "libfoo_1.0_amd64.deb": "LIB"})
	putFake(t, l, p, b, map[string]string{"keepalived_2.2_amd64.deb": "K", "libfoo_1.0_amd64.deb": "LIB"})
	if !l.Has(p, a) || !l.Has(p, b) {
		t.Fatal("stored closures not found")
	}
	if m := l.Missing(p, []mwpack.PackageRequest{a, {Name: "haproxy", Version: "9.9"}}); len(m) != 1 || m[0].Version != "9.9" {
		t.Fatalf("missing = %v", m)
	}
	if got := l.Stats(p); got.Closures != 2 || got.Files != 3 {
		t.Fatalf("shared dependency must be stored once: %+v", got)
	}
	if err := l.Delete(p, a); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(l.pdir(p, "pool", "haproxy_2.8_amd64.deb")); !os.IsNotExist(err) {
		t.Fatal("an unused file survived deletion")
	}
	if _, err := os.Stat(l.pdir(p, "pool", "libfoo_1.0_amd64.deb")); err != nil {
		t.Fatal("a file still used by another closure was removed")
	}
	// A file of the wrong size counts as missing; assembly additionally verifies every hash.
	if err := os.WriteFile(l.pdir(p, "pool", "keepalived_2.2_amd64.deb"), []byte("truncated-or-damaged"), 0o600); err != nil {
		t.Fatal(err)
	}
	if l.Has(p, b) {
		t.Fatal("a damaged file must not count as available")
	}
}

func TestPutRefusesDifferentContentForSameName(t *testing.T) {
	l, _ := Open(t.TempDir())
	const p = "ubuntu-24.04-amd64"
	putFake(t, l, p, mwpack.PackageRequest{Name: "a", Version: "1"}, map[string]string{"libx_1.0_amd64.deb": "ONE"})
	src := t.TempDir()
	m, r := fakeDeb(t, src, "libx_1.0_amd64.deb", "libx", "1.0", "TWO")
	err := l.Put(Closure{Request: mwpack.PackageRequest{Name: "b", Version: "1"}, Platform: p, Files: []FileRef{r}}, []Meta{m}, func(f string) string { return filepath.Join(src, f) })
	if err == nil || !strings.Contains(err.Error(), "拒绝覆盖") {
		t.Fatalf("same name with different content must be refused, got %v", err)
	}
}

func TestSafeFileKeepsEpochsOutOfNames(t *testing.T) {
	if got := SafeFile("percona-postgresql-17_2%3a17.11-1.noble_amd64.deb"); strings.ContainsAny(got, "%:") {
		t.Fatal(got)
	}
	if SafeFile("libstdc++6_14.2~rc1_amd64.deb") != "libstdc++6_14.2~rc1_amd64.deb" {
		t.Fatal("plus and tilde are legal in package file names")
	}
}

func readRepo(t *testing.T, path string) map[string][]byte {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	out := map[string][]byte{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			b, _ := io.ReadAll(tr)
			out[h.Name] = b
		}
	}
}

func TestAssembleAptIsDeterministicAndWellFormed(t *testing.T) {
	l, _ := Open(t.TempDir())
	def, _ := mwpack.PlatformByID("ubuntu-24.04-amd64")
	a := mwpack.PackageRequest{Name: "haproxy", Version: "2.8"}
	b := mwpack.PackageRequest{Name: "keepalived", Version: "2.2"}
	putFake(t, l, def.ID, a, map[string]string{"haproxy_2.8_amd64.deb": "H", "libfoo_1.0_amd64.deb": "LIB"})
	putFake(t, l, def.ID, b, map[string]string{"keepalived_2.2_amd64.deb": "K", "libfoo_1.0_amd64.deb": "LIB"})
	r1, err := l.Assemble(def, []mwpack.PackageRequest{a, b})
	if err != nil {
		t.Fatal(err)
	}
	r2, err := l.Assemble(def, []mwpack.PackageRequest{b, a})
	if err != nil || r1.SHA256 != r2.SHA256 || r1.Path != r2.Path {
		t.Fatalf("assembly must not depend on request order: %v %s %s", err, r1.SHA256, r2.SHA256)
	}
	if sum, _, _ := sumFile(r1.Path); sum != r1.SHA256 {
		t.Fatal("reported archive hash differs from the file")
	}
	repo := readRepo(t, r1.Path)
	for _, want := range []string{"repo/haproxy_2.8_amd64.deb", "repo/keepalived_2.2_amd64.deb", "repo/libfoo_1.0_amd64.deb", "repo/Packages", "repo/Release", "repo/.mw-repo"} {
		if _, ok := repo[want]; !ok {
			t.Errorf("missing %s", want)
		}
	}
	pk := string(repo["repo/Packages"])
	if strings.Count(pk, "Package: libfoo") != 1 {
		t.Errorf("a shared dependency must be indexed once:\n%s", pk)
	}
	for _, want := range []string{"Filename: ./haproxy_2.8_amd64.deb", "SHA256: " + sha([]byte("H")), "Size: 1", "MD5sum: ", " a second line"} {
		if !strings.Contains(pk, want) {
			t.Errorf("Packages lacks %q:\n%s", want, pk)
		}
	}
	if !strings.Contains(string(repo["repo/Release"]), sha(repo["repo/Packages"])) {
		t.Error("Release must carry the hash of Packages or apt rejects the repository")
	}
	// Changing one file changes the repository identity.
	putFake(t, l, def.ID, mwpack.PackageRequest{Name: "haproxy", Version: "2.9"}, map[string]string{"haproxy_2.9_amd64.deb": "H2"})
	r3, _ := l.Assemble(def, []mwpack.PackageRequest{{Name: "haproxy", Version: "2.9"}, b})
	if r3.SHA256 == r1.SHA256 {
		t.Error("different contents must give different repositories")
	}
}

func TestAssembleDetectsCorruption(t *testing.T) {
	l, _ := Open(t.TempDir())
	def, _ := mwpack.PlatformByID("ubuntu-24.04-amd64")
	a := mwpack.PackageRequest{Name: "haproxy", Version: "2.8"}
	putFake(t, l, def.ID, a, map[string]string{"haproxy_2.8_amd64.deb": "HELLO"})
	if err := os.WriteFile(l.pdir(def.ID, "pool", "haproxy_2.8_amd64.deb"), []byte("HELLX"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Assemble(def, []mwpack.PackageRequest{a}); err == nil || !strings.Contains(err.Error(), "损坏") {
		t.Fatalf("a corrupted pool file must stop assembly, got %v", err)
	}
	if _, err := l.Assemble(def, []mwpack.PackageRequest{{Name: "nope", Version: "1"}}); err == nil || !strings.Contains(err.Error(), "软件库没有") {
		t.Fatalf("an unknown package must be reported, got %v", err)
	}
}

func TestAssembleRpmMetadata(t *testing.T) {
	l, _ := Open(t.TempDir())
	def, _ := mwpack.PlatformByID("el9-amd64")
	src := t.TempDir()
	body := []byte("RPMDATA")
	file := "haproxy-2.8.14-3.el9.x86_64.rpm"
	os.WriteFile(filepath.Join(src, file), body, 0o600)
	meta := Meta{File: file, Name: "haproxy", Version: "2.8.14-3.el9", Arch: "x86_64",
		Primary:   `<package type="rpm"><name>haproxy</name><location href="old/name.rpm"/></package>`,
		Filelists: `<package pkgid="` + sha(body) + `" name="haproxy" arch="x86_64"></package>`,
		Other:     `<package pkgid="` + sha(body) + `" name="haproxy" arch="x86_64"></package>`}
	c := Closure{Request: mwpack.PackageRequest{Name: "haproxy", Version: "2.8.14-3.el9"}, Platform: def.ID, Files: []FileRef{{File: file, SHA256: sha(body)}}}
	if err := l.Put(c, []Meta{meta}, func(string) string { return filepath.Join(src, file) }); err != nil {
		t.Fatal(err)
	}
	r, err := l.Assemble(def, []mwpack.PackageRequest{c.Request})
	if err != nil {
		t.Fatal(err)
	}
	repo := readRepo(t, r.Path)
	var md struct {
		Data []struct {
			Type     string `xml:"type,attr"`
			Location struct {
				Href string `xml:"href,attr"`
			} `xml:"location"`
			Checksum string `xml:"checksum"`
		} `xml:"data"`
	}
	if err := xml.Unmarshal(repo["repo/repodata/repomd.xml"], &md); err != nil || len(md.Data) != 3 {
		t.Fatalf("repomd.xml invalid: %v %s", err, repo["repo/repodata/repomd.xml"])
	}
	for _, d := range md.Data {
		gz, ok := repo["repo/"+d.Location.Href]
		if !ok || sha(gz) != d.Checksum {
			t.Errorf("%s: file missing or checksum differs from repomd", d.Type)
		}
		zr, err := gzip.NewReader(bytes.NewReader(gz))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(zr)
		if err := xml.Unmarshal(raw, new(struct{})); err != nil {
			t.Errorf("%s.xml is not well-formed: %v", d.Type, err)
		}
		if d.Type == "primary" && !strings.Contains(string(raw), `<location href="`+file+`"/>`) {
			t.Errorf("primary must point at the file as stored:\n%s", raw)
		}
	}
}

func buildPack(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range entries {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(body)), Typeflag: tar.TypeReg})
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func TestExportImportRoundTripAndRejection(t *testing.T) {
	const p = "ubuntu-24.04-amd64"
	src, _ := Open(t.TempDir())
	req := mwpack.PackageRequest{Name: "haproxy", Version: "2.8"}
	putFake(t, src, p, req, map[string]string{"haproxy_2.8_amd64.deb": "H", "libfoo_1.0_amd64.deb": "LIB"})
	var pack bytes.Buffer
	if err := src.Export(&pack, p, []mwpack.PackageRequest{req}); err != nil {
		t.Fatal(err)
	}
	dst, _ := Open(t.TempDir())
	res, err := dst.Import(bytes.NewReader(pack.Bytes()))
	if err != nil || res.Closures != 1 || res.Files != 2 {
		t.Fatalf("import: %+v %v", res, err)
	}
	def, _ := mwpack.PlatformByID(p)
	a, _ := src.Assemble(def, []mwpack.PackageRequest{req})
	b, err := dst.Assemble(def, []mwpack.PackageRequest{req})
	if err != nil || a.SHA256 != b.SHA256 {
		t.Fatalf("an imported library must assemble to the identical repository: %v", err)
	}
	if again, err := dst.Import(bytes.NewReader(pack.Bytes())); err != nil || again.Files != 0 {
		t.Fatalf("importing twice is harmless: %+v %v", again, err)
	}

	// Tampering with a file inside the pack is detected.
	var tampered bytes.Buffer
	zr, _ := gzip.NewReader(bytes.NewReader(pack.Bytes()))
	tr := tar.NewReader(zr)
	entries := map[string]string{}
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		b, _ := io.ReadAll(tr)
		entries[h.Name] = string(b)
	}
	entries["library/"+p+"/pool/haproxy_2.8_amd64.deb"] = "EVIL"
	tampered.Write(buildPack(t, entries))
	other, _ := Open(t.TempDir())
	if _, err := other.Import(&tampered); err == nil || !strings.Contains(err.Error(), "哈希") {
		t.Fatalf("a modified package must be rejected, got %v", err)
	}
	if other.Stats(p).Closures != 0 {
		t.Fatal("a rejected pack left something behind")
	}
	for name, pk := range map[string][]byte{
		"path traversal": buildPack(t, map[string]string{"library/" + p + "/pool/../../evil": "x"}),
		"unknown system": buildPack(t, map[string]string{"library/windows-11/pool/x": "x"}),
		"stray file":     buildPack(t, map[string]string{"etc/passwd": "x"}),
		"empty":          buildPack(t, map[string]string{}),
		"not a pack":     []byte("hello"),
	} {
		if _, err := other.Import(bytes.NewReader(pk)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestSourcesValidationAndOverride(t *testing.T) {
	s, err := LoadSources("")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.ForPlatform("ubuntu-24.04-amd64")) < 2 || len(s.ForPlatform("el9-amd64")) < 2 {
		t.Fatalf("built-in sources missing: %+v", s.List)
	}
	for _, x := range s.List {
		if x.KeyFile != "" {
			if k, err := s.Key(x.KeyFile); err != nil || len(k) == 0 {
				t.Errorf("source %s: key %s not shipped", x.ID, x.KeyFile)
			}
		}
	}
	for name, bad := range map[string]string{
		"no scheme": "- {id: x, platforms: [el9-amd64], kind: rpm, baseurl: example.com/repo}",
		"bad kind":  "- {id: x, platforms: [el9-amd64], kind: zypper, baseurl: http://e/}",
		"duplicate": "- {id: x, platforms: [el9-amd64], kind: rpm, baseurl: http://e/}\n- {id: x, platforms: [el9-amd64], kind: rpm, baseurl: http://e/}",
		"quote":     "- {id: x, platforms: [el9-amd64], kind: rpm, baseurl: \"http://e/'x\"}",
		"key path":  "- {id: x, platforms: [el9-amd64], kind: rpm, baseurl: http://e/, key_file: ../x}",
		"unknown":   "- {id: x, platforms: [el9-amd64], kind: rpm, baseurl: http://e/, surprise: 1}",
		"no suites": "- {id: x, platforms: [ubuntu-24.04-amd64], kind: apt, url: http://e/}",
	} {
		if _, err := ParseSources([]byte(bad)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// An administrator can point a built-in source at an internal mirror and switch another one off.
	path := filepath.Join(t.TempDir(), "sources.yaml")
	custom := "- {id: ubuntu-noble, platforms: [ubuntu-24.04-amd64], kind: apt, url: https://mirror.corp/ubuntu, suites: [noble], components: [main], key_file: ubuntu-archive-keyring.gpg}\n- {id: percona-ppg17-noble, platforms: [ubuntu-24.04-amd64], kind: apt, url: http://x/, suites: [noble], components: [main], disabled: true}\n- {id: redis-noble, platforms: [ubuntu-24.04-amd64], kind: apt, url: http://x/, suites: [noble], components: [main], disabled: true}\n"
	if err := os.WriteFile(path, []byte(custom), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err = LoadSources(path)
	if err != nil {
		t.Fatal(err)
	}
	got := s.ForPlatform("ubuntu-24.04-amd64")
	if len(got) != 1 || got[0].URL != "https://mirror.corp/ubuntu" || got[0].Builtin {
		t.Fatalf("override not applied: %+v", got)
	}
}

package pkglib

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/openpgp"
	"golang.org/x/crypto/openpgp/clearsign"

	"delivery-studio/mwpack"
)

// fakeArchive is a signed apt repository served over HTTP, so updating, exporting and importing an index can be tested
// without the network.
type fakeArchive struct {
	srv      *httptest.Server
	entity   *openpgp.Entity
	date     string
	packages string
}

func newFakeArchive(t *testing.T, date string, names ...string) *fakeArchive {
	t.Helper()
	e, err := openpgp.NewEntity("test archive", "", "t@example.invalid", nil)
	if err != nil {
		t.Fatal(err)
	}
	a := &fakeArchive{entity: e, date: date}
	var b strings.Builder
	for _, n := range names {
		b.WriteString(stanza(n, "1.0", "", ""))
	}
	a.packages = b.String()
	a.srv = httptest.NewServer(http.HandlerFunc(a.serve))
	t.Cleanup(a.srv.Close)
	return a
}

func gzipBytes(s string) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write([]byte(s))
	zw.Close()
	return buf.Bytes()
}

func (a *fakeArchive) release() []byte {
	gz := gzipBytes(a.packages)
	sum := sha256.Sum256(gz)
	text := fmt.Sprintf("Origin: test\nSuite: noble\nDate: %s\nSHA256:\n %s %d main/binary-amd64/Packages.gz\n", a.date, hex.EncodeToString(sum[:]), len(gz))
	var out bytes.Buffer
	w, _ := clearsign.Encode(&out, a.entity.PrivateKey, nil)
	w.Write([]byte(text))
	w.Close()
	return out.Bytes()
}

func (a *fakeArchive) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/dists/noble/InRelease":
		w.Write(a.release())
	case "/dists/noble/main/binary-amd64/Packages.gz":
		w.Write(gzipBytes(a.packages))
	default:
		http.NotFound(w, r)
	}
}

// sources writes a source list with the archive's public key beside it, the way an administrator's override is laid out.
func (a *fakeArchive) sources(t *testing.T) *Sources {
	t.Helper()
	dir := t.TempDir()
	yaml := filepath.Join(dir, "sources.yaml")
	os.WriteFile(yaml, []byte(fmt.Sprintf("- id: ubuntu-noble\n  title: test archive\n  platforms: [ubuntu-24.04-amd64]\n  kind: apt\n  url: %s\n  suites: [noble]\n  components: [main]\n  key_file: test.gpg\n- id: percona-ppg17-noble\n  title: off\n  platforms: [ubuntu-24.04-amd64]\n  kind: apt\n  url: %s\n  suites: [noble]\n  components: [main]\n  key_file: test.gpg\n  disabled: true\n- id: redis-noble\n  title: off\n  platforms: [ubuntu-24.04-amd64]\n  kind: apt\n  url: %s\n  suites: [noble]\n  components: [main]\n  key_file: test.gpg\n  disabled: true\n- id: nginx-noble\n  title: off\n  platforms: [ubuntu-24.04-amd64]\n  kind: apt\n  url: %s\n  suites: [noble]\n  components: [nginx]\n  key_file: test.gpg\n  disabled: true\n", a.srv.URL, a.srv.URL, a.srv.URL, a.srv.URL)), 0o600)
	os.MkdirAll(filepath.Join(dir, "sources.keys"), 0o700)
	var key bytes.Buffer
	if err := a.entity.Serialize(&key); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "sources.keys", "test.gpg"), key.Bytes(), 0o600)
	s, err := LoadSources(yaml)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

var testDef = mwpack.PlatformDef{ID: "ubuntu-24.04-amd64", Family: "apt", Arch: "amd64", Title: "t"}

func TestIndexUpdateExportImportRoundTrip(t *testing.T) {
	online := newFakeArchive(t, "Fri, 23 Oct 2026 10:00:00 UTC", "alpha", "beta")
	srcs := online.sources(t)
	x := OpenIndex(t.TempDir())
	if err := x.Update(context.Background(), testDef, srcs, nil); err != nil {
		t.Fatal(err)
	}
	st := x.State(testDef.ID)
	if st.Packages != 2 || len(st.Releases) != 1 {
		t.Fatalf("state after update: %+v", st)
	}
	var pack bytes.Buffer
	if err := x.Export(&pack, testDef.ID); err != nil {
		t.Fatal(err)
	}

	// an offline platform has the same source definitions (and keys) but no network
	offline := OpenIndex(t.TempDir())
	got, err := offline.Import(bytes.NewReader(pack.Bytes()), testDef, srcs)
	if err != nil {
		t.Fatal(err)
	}
	if got.Packages != 2 || got.Imported == "" {
		t.Fatalf("state after import: %+v", got)
	}
	hits, err := offline.Search(testDef, "alpha", 5)
	if err != nil || len(hits) != 1 || hits[0].Name != "alpha" {
		t.Fatalf("search on the imported index: %v %+v", err, hits)
	}
	// importing the same pack again is fine (it is not older than itself)
	if _, err := offline.Import(bytes.NewReader(pack.Bytes()), testDef, srcs); err != nil {
		t.Fatalf("re-import: %v", err)
	}
}

// repack rewrites a pack with one entry changed, to play a tampered pack.
func repack(t *testing.T, pack []byte, change func(name string, body []byte) []byte) []byte {
	t.Helper()
	zr, _ := gzip.NewReader(bytes.NewReader(pack))
	tr := tar.NewReader(zr)
	var out bytes.Buffer
	zw := gzip.NewWriter(&out)
	tw := tar.NewWriter(zw)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(tr)
		body = change(h.Name, body)
		tw.WriteHeader(&tar.Header{Name: h.Name, Mode: 0o600, Size: int64(len(body)), Typeflag: tar.TypeReg})
		tw.Write(body)
	}
	tw.Close()
	zw.Close()
	return out.Bytes()
}

func TestIndexImportRefusesTamperedAndForeignPacks(t *testing.T) {
	online := newFakeArchive(t, "Fri, 23 Oct 2026 10:00:00 UTC", "alpha")
	srcs := online.sources(t)
	x := OpenIndex(t.TempDir())
	if err := x.Update(context.Background(), testDef, srcs, nil); err != nil {
		t.Fatal(err)
	}
	var pack bytes.Buffer
	x.Export(&pack, testDef.ID)
	try := func(name string, data []byte, s *Sources, want string) {
		t.Helper()
		_, err := OpenIndex(t.TempDir()).Import(bytes.NewReader(data), testDef, s)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: want an error containing %q, got %v", name, want, err)
		}
	}
	try("a changed Packages file", repack(t, pack.Bytes(), func(n string, b []byte) []byte {
		if strings.HasSuffix(n, ".Packages.gz") {
			return gzipBytes(strings.Replace("Package: evil\nVersion: 1\nArchitecture: amd64\nFilename: x\nSize: 1\nSHA256: aa\n\n", "evil", "evil2", 1))
		}
		return b
	}), srcs, "不一致")
	try("a changed signed release", repack(t, pack.Bytes(), func(n string, b []byte) []byte {
		if strings.HasSuffix(n, ".InRelease") {
			return bytes.Replace(b, []byte("Suite: noble"), []byte("Suite: jammy"), 1)
		}
		return b
	}), srcs, "签名")
	// a pack signed by some other key is not accepted by a platform that trusts a different one
	other := newFakeArchive(t, "Fri, 23 Oct 2026 10:00:00 UTC", "alpha")
	try("a source with another key", pack.Bytes(), other.sources(t), "签名")
	try("garbage", []byte("not a pack"), srcs, "有效")

	// an older index must not replace a newer one
	newer := newFakeArchive(t, "Sat, 24 Oct 2026 10:00:00 UTC", "alpha")
	newer.entity = online.entity
	newerSrcs := newer.sources(t)
	y := OpenIndex(t.TempDir())
	if err := y.Update(context.Background(), testDef, newerSrcs, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := y.Import(bytes.NewReader(pack.Bytes()), testDef, newerSrcs); err == nil || !strings.Contains(err.Error(), "更旧") {
		t.Errorf("an older index must be refused, got %v", err)
	}
}

func TestIndexExportAsksForAnUpdateWhenTheIndexHasNoSignedReleases(t *testing.T) {
	x := OpenIndex(t.TempDir())
	if err := x.Export(io.Discard, testDef.ID); err == nil {
		t.Fatal("exporting nothing must fail")
	}
	dir := x.pdir(testDef.ID)
	os.MkdirAll(dir, 0o700)
	writeJSONAtomic(filepath.Join(dir, "state.json"), IndexState{Platform: testDef.ID, Files: []IndexFile{{Source: "s", File: "f"}}})
	if err := x.Export(io.Discard, testDef.ID); err == nil || !strings.Contains(err.Error(), "更新索引") {
		t.Fatalf("an index without releases must say to update first, got %v", err)
	}
}

func TestIndexUpdateReportsEveryStepBeforeItRuns(t *testing.T) {
	a := newFakeArchive(t, "Fri, 23 Oct 2026 10:00:00 UTC", "alpha", "beta")
	srcs := a.sources(t)
	x := OpenIndex(t.TempDir())
	var events []StepEvent
	first := map[string]string{}
	last := map[string]StepEvent{}
	rep := &Reporter{Step: func(e StepEvent) {
		events = append(events, e)
		if _, ok := first[e.ID]; !ok {
			first[e.ID] = e.State
		}
		last[e.ID] = e
	}}
	if err := x.Update(context.Background(), testDef, srcs, rep); err != nil {
		t.Fatal(err)
	}
	if len(last) != 2 {
		t.Fatalf("one release and one Packages file make two steps, got %d: %+v", len(last), last)
	}
	for id, st := range first {
		if st != "pending" {
			t.Errorf("step %s must be announced as pending before it starts, was %s", id, st)
		}
		if last[id].State != "done" {
			t.Errorf("step %s must end done, ended %s (%s)", id, last[id].State, last[id].Detail)
		}
	}
	if d := last["pk|ubuntu-noble|noble|main"].Detail; !strings.Contains(d, "2 个版本") {
		t.Errorf("the Packages step must say how many versions it holds, got %q", d)
	}
	// a second update finds nothing new and says so instead of downloading again
	events = nil
	if err := x.Update(context.Background(), testDef, srcs, rep); err != nil {
		t.Fatal(err)
	}
	if last["pk|ubuntu-noble|noble|main"].State != "skipped" {
		t.Errorf("an unchanged file must be reported as skipped, got %s", last["pk|ubuntu-noble|noble|main"].State)
	}
}

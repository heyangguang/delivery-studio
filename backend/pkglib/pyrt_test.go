package pkglib

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
)

func TestComparePy(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{{"2.17.1", "2.17.10", -1}, {"2.17.0rc1", "2.17.0", -1}, {"3.1.6", "3.1.6", 0}, {"1.0.post1", "1.0", 1}, {"42.0.8", "43.0.1", -1}} {
		if got := ComparePy(c.a, c.b); (got > 0) != (c.want > 0) || (got < 0) != (c.want < 0) {
			t.Errorf("%s vs %s = %d", c.a, c.b, got)
		}
	}
}

func TestPyStoreImportArchiveExportImport(t *testing.T) {
	archive := os.Getenv("MW_RUNTIME_ARCHIVE")
	if archive == "" {
		t.Skip("set MW_RUNTIME_ARCHIVE to an ansible-runtime tar.gz")
	}
	s := NewPyStore(t.TempDir())
	id, err := s.ImportArchive(archive)
	if err != nil {
		t.Fatal(err)
	}
	r, ok := s.Runtime(id)
	if !ok || r.Ansible == "" || len(r.Wheels) < 5 || !strings.Contains(r.Lock(), "--hash=sha256:") {
		t.Fatalf("%+v", r)
	}
	var buf bytes.Buffer
	if err := s.Export(&buf, []string{id}); err != nil {
		t.Fatal(err)
	}
	other := NewPyStore(t.TempDir())
	got, err := other.Import(bytes.NewReader(buf.Bytes()))
	if err != nil || len(got) != 1 || got[0].ID != id {
		t.Fatal(err, got)
	}
	// offline: the same set resolves from the library alone; a pin to a version that is not there fails clearly
	if py := os.Getenv("MW_PYTHON"); py != "" {
		other.Python = py
		r2, err := other.Build(context.Background(), []string{"ansible-core==" + r.Ansible}, true, "test", "", nil)
		if err != nil || r2.ID != id {
			t.Fatal(err, r2.ID, id)
		}
		if _, err := other.Build(context.Background(), []string{"ansible-core==" + r.Ansible, "pip==1.0"}, true, "test", "", nil); err == nil {
			t.Fatal("a missing version resolved offline")
		}
	}
}

// TestPyStoreOnline downloads from PyPI; run with MW_PYTHON set and MW_PY_ONLINE=1.
func TestPyStoreOnline(t *testing.T) {
	if os.Getenv("MW_PY_ONLINE") == "" || os.Getenv("MW_PYTHON") == "" {
		t.Skip("set MW_PY_ONLINE=1 and MW_PYTHON")
	}
	s := NewPyStore(t.TempDir())
	s.Python = os.Getenv("MW_PYTHON")
	r, err := s.Build(context.Background(), []string{"ansible-core==2.20.10", "pip==26.2.0"}, false, "fixed pip", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	pip := ""
	for _, w := range r.Wheels {
		if w.Name == "pip" {
			pip = w.Version
		}
		t.Logf("%s %s", w.Name, w.Version)
	}
	if r.Ansible != "2.20.10" || ComparePy(pip, "26.2.0") != 0 {
		t.Fatalf("%+v", r)
	}
	vs, err := s.Versions(context.Background(), "ansible-core")
	if err != nil || len(vs) == 0 {
		t.Fatal(err)
	}
	t.Logf("ansible-core versions: %v", vs[:5])
}

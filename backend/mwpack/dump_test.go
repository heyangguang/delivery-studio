package mwpack_test

import (
	"os"
	"path/filepath"
	"testing"

	"delivery-studio/mwpack"
)

func TestDumpEtcd(t *testing.T) {
	if os.Getenv("MW_DUMP") == "" {
		t.Skip()
	}
	renderTo(t, mustSolve(t, loadCatalog(t), etcdOnly), os.Getenv("MW_DUMP"))
}

func TestDumpEcho(t *testing.T) {
	d := os.Getenv("MW_DUMP")
	if d == "" {
		t.Skip()
	}
	b := renderTo(t, mustSolve(t, fullCatalog(t), echoWithLB), d+"/project")
	for name, data := range b.Docs {
		os.WriteFile(d+"/"+name, data, 0o644)
	}
}

func TestDumpPG(t *testing.T) {
	d := os.Getenv("MW_DUMP")
	if d == "" {
		t.Skip()
	}
	plan := mustSolve(t, fullCatalog(t), pgHA)
	m := map[string][]byte{}
	for _, f := range []string{"server.crt", "server.key", "ca.crt"} {
		m["pg/tls/"+f] = []byte("x")
	}
	b, err := mwpack.Render(plan, mwpack.RenderOptions{Materials: m})
	if err != nil {
		t.Fatal(err)
	}
	for n, f := range b.Project {
		p := d + "/project/" + n
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, f.Data, 0o644)
	}
	for n, data := range b.Docs {
		os.WriteFile(d+"/"+n, data, 0o644)
	}
	renderT := renderTemplates
	got := renderT(t, plan, d+"/project")
	for n, c := range got {
		p := d + "/rendered/" + n
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(c), 0o644)
	}
}

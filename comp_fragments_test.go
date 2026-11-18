package main

import (
	"gopkg.in/yaml.v3"
	"middleware-deployer/mwpack"
	"strings"
	"testing"
)

func TestFragmentComponentWorkflow(t *testing.T) {
	s, _ := testStore(t)
	for _, name := range []string{"postgresql", "redis", "etcd"} {
		set, _, err := s.comps().liveSet(name)
		if err != nil {
			t.Fatal(err)
		}
		if chk := checkComponent(s.plat, name, set); !chk.OK {
			t.Fatal(name, chk.Problems)
		}
		for _, preset := range []string{"single"} {
			if pv := previewComponent(s.plat, ansibleEnv{}, name, set, nil, previewReq{Preset: preset}); !pv.OK {
				t.Fatal(name, pv.Error)
			}
		}
		fork, err := renameComponent(set, name, name+"-fork", "复制")
		if err != nil {
			t.Fatal(err)
		}
		if chk := checkComponent(s.plat, name+"-fork", fork); !chk.OK {
			t.Fatal(name, chk.Problems)
		}
	}
	set, _, _ := s.comps().liveSet("postgresql")
	set["manifest/schemes/single.yaml"] = []byte(strings.Replace(string(set["manifest/schemes/single.yaml"]), "failover: none", "failover: automatic", 1))
	chk := checkComponent(s.plat, "postgresql", set)
	found := false
	for _, p := range chk.Problems {
		found = found || p.File == "manifest/schemes/single.yaml" && p.Line > 0
	}
	if !found {
		t.Fatal("error not located in fragment", chk)
	}
	// Flattening and re-splitting preserve all typed component semantics.
	original, _, _ := s.comps().liveSet("postgresql")
	a, err := original.component()
	if err != nil {
		t.Fatal(err)
	}
	b, err := mwpack.ParseComponent(expandedTestManifest(t, original))
	if err != nil {
		t.Fatal(err)
	}
	aa, _ := yaml.Marshal(a)
	bb, _ := yaml.Marshal(b)
	if string(aa) != string(bb) {
		t.Fatal("split changed component semantics")
	}
}

func TestFragmentExportImportAndStatus(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	before, _, err := s.comps().liveSet("etcd")
	if err != nil {
		t.Fatal(err)
	}
	w := storeRequest(s, "GET", "/api/components/etcd/pack", nil, admin, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if result := importPack(t, s, admin, csrf, "etcd.tar.gz", w.Body.Bytes()); result.Code != 200 {
		t.Fatal(result.Code, result.Body.String())
	}
	after, _, err := s.comps().liveSet("etcd")
	if err != nil {
		t.Fatal(err)
	}
	for f, b := range before {
		if string(after[f]) != string(b) {
			t.Fatal("round trip changed", f)
		}
	}
	comp, err := before.component()
	if err != nil {
		t.Fatal(err)
	}
	api := &wb{t: t, s: s}
	status := "verifying"
	if comp.Versions[0].Status == status {
		status = "draft"
	}
	api.ok("POST", "/api/components/etcd/versions/"+comp.Versions[0].ID+"/status", map[string]any{"status": status, "note": "fragment status regression"})
	updated, _, err := s.comps().liveSet("etcd")
	if err != nil {
		t.Fatal(err)
	}
	changes := []string{}
	for f, b := range after {
		if string(updated[f]) != string(b) {
			changes = append(changes, f)
		}
	}
	if len(changes) != 1 || changes[0] != "manifest/common/versions.yaml" {
		t.Fatal("status changed unrelated files", changes)
	}
}

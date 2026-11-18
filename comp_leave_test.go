package main

import "testing"

func TestLeaveDraftPreservesChanges(t *testing.T) {
	s, _ := testStore(t)
	w := &wb{t: t, s: s}
	base := "/api/components/etcd/draft"
	w.ok("POST", base, map[string]any{"from": "live"})
	_, meta, _ := s.comps().readDraft("etcd")
	r := w.ok("POST", base+"/leave", map[string]any{"if_updated": meta.Updated})
	if r["removed"] != true || s.comps().hasDraft("etcd") {
		t.Fatal(r)
	}
	w.ok("POST", base+"/leave", map[string]any{"if_updated": meta.Updated})
	w.ok("POST", base, map[string]any{"from": "live"})
	original, meta, _ := s.comps().readDraft("etcd")
	w.ok("PUT", base, map[string]any{"files": map[string]string{"component.yaml": string(original["component.yaml"]) + "\n# unpublished edit\n"}})
	for _, stamp := range []string{"", meta.Updated} {
		r = w.ok("POST", base+"/leave", map[string]any{"if_updated": stamp})
		if r["removed"] != false {
			t.Fatal("concurrent edit removed", r)
		}
	}
	_, current, _ := s.comps().readDraft("etcd")
	r = w.ok("POST", base+"/leave", map[string]any{"if_updated": current.Updated})
	if r["removed"] != false {
		t.Fatal("changed draft removed", r)
	}
	w.ok("PUT", base, map[string]any{"files": map[string]string{"component.yaml": string(original["component.yaml"])}})
	_, current, _ = s.comps().readDraft("etcd")
	r = w.ok("POST", base+"/leave", map[string]any{"if_updated": current.Updated})
	if r["removed"] != true {
		t.Fatal("reverted draft retained", r)
	}
	w.ok("POST", "/api/components/new", map[string]any{"name": "leave-new", "title": "未发布组件", "kind": "single", "package": "memcached", "port": 11211})
	_, current, _ = s.comps().readDraft("leave-new")
	r = w.ok("POST", "/api/components/leave-new/draft/leave", map[string]any{"if_updated": current.Updated})
	if r["removed"] != false {
		t.Fatal("new component deleted", r)
	}
}

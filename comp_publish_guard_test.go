package main

import (
	"strings"
	"testing"
)

func TestPublishReviewedDraftAndChineseNote(t *testing.T) {
	s, _ := testStore(t)
	w := &wb{t: t, s: s}
	base := "/api/components/etcd/draft"
	w.ok("POST", base, map[string]any{"from": "live"})
	review := w.ok("POST", base+"/diff", map[string]any{})
	stamp, ok := review["updated"].(string)
	if !ok || stamp == "" {
		t.Fatal(review)
	}
	set, _, _ := s.comps().readDraft("etcd")
	w.ok("PUT", base, map[string]any{"files": map[string]string{"component.yaml": string(set["component.yaml"]) + "\n# reviewed revision test\n"}})
	if code, _ := w.do("POST", base+"/publish", map[string]any{"note": "检查后被修改", "if_updated": stamp}); code != 409 {
		t.Fatal("stale publication accepted", code)
	}
	if !s.comps().hasDraft("etcd") {
		t.Fatal("draft lost after rejection")
	}
	review = w.ok("POST", base+"/diff", map[string]any{})
	if code, _ := w.do("POST", base+"/publish", map[string]any{"note": strings.Repeat("中", 201), "if_updated": review["updated"]}); code != 400 {
		t.Fatal("overlong note accepted", code)
	}
	w.ok("POST", base+"/publish", map[string]any{"note": strings.Repeat("中", 200), "if_updated": review["updated"]})
}

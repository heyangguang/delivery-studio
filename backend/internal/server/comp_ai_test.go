package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A file longer than one read is given in parts, each saying where the next starts; nothing is lost between them.
func TestReadRangeContinues(t *testing.T) {
	var b strings.Builder
	for i := 1; i <= 3000; i++ {
		b.WriteString("line-" + strings.Repeat("x", 20) + "\n")
	}
	text := b.String()
	got, from := 0, 1
	for k := 0; k < 20; k++ {
		out := readRange(text, map[string]any{"from_line": float64(from)})
		if len(out) > aiMaxResult {
			t.Fatal("a part is longer than a tool result may be")
		}
		got += strings.Count(out, "line-")
		i := strings.Index(out, "from_line=")
		if i < 0 {
			break
		}
		n := 0
		for _, c := range out[i+len("from_line="):] {
			if c < '0' || c > '9' {
				break
			}
			n = n*10 + int(c-'0')
		}
		from = n
	}
	if got != 3001-1 && got != 3000 {
		t.Fatalf("read %d lines of 3000", got)
	}
}

// An accepted change is kept for review until the person confirms it, so a reload or a restart still shows it, and
// undo still knows what the files were.
func TestAcceptedComponentChangeIsKeptForReview(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	if w := storeRequest(s, "POST", "/api/components/etcd/draft", strings.NewReader(`{"from":"builtin"}`), admin, csrf); w.Code != 200 {
		t.Fatal("start draft", w.Code, w.Body.String())
	}
	set, _, _ := s.comps().readDraft("etcd")
	old := string(set["component.yaml"])
	p := compProposal{ID: "p1", Summary: "x", Status: "pending", Files: []compPropFile{
		{Path: "component.yaml", Op: "change", Content: old + "\n# changed\n"},
		{Path: "roles/etcd/tasks/zz_new.yml", Op: "add", Content: "- ansible.builtin.debug: {msg: ok}\n"},
	}}
	if err := s.saveCompProposals("etcd", []compProposal{p}); err != nil {
		t.Fatal(err)
	}
	if w := storeRequest(s, "POST", "/api/components/etcd/ai/proposals/p1/accept", nil, admin, csrf); w.Code != 200 {
		t.Fatal("accept", w.Code, w.Body.String())
	}
	again, err := newStoreServer(s.cfg)
	if err != nil {
		t.Fatal(err)
	}
	rv := again.loadCompReview("etcd")
	if rv.Before["component.yaml"] == nil || *rv.Before["component.yaml"] != old {
		t.Fatal("the file as it was is not kept", rv)
	}
	if v, ok := rv.Before["roles/etcd/tasks/zz_new.yml"]; !ok || v != nil {
		t.Fatal("a new file must be recorded as not there before", rv)
	}
	if w := storeRequest(again, "DELETE", "/api/components/etcd/ai/review", nil, admin, csrf); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if rv := again.loadCompReview("etcd"); len(rv.Before) != 0 {
		t.Fatal("confirming did not end the review")
	}
}

// Dropping or publishing a draft does not throw the assistant's conversation away: it is kept, and can be read later.
func TestComponentConversationIsKeptAfterTheDraftEnds(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	if w := storeRequest(s, "POST", "/api/components/etcd/draft", strings.NewReader(`{"from":"builtin"}`), admin, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	dir := s.compAIDir("etcd")
	os.MkdirAll(dir, 0o700)
	os.WriteFile(filepath.Join(dir, "session.json"), []byte(`{"messages":[{"role":"user","text":"加一个检查","at":"x"},{"role":"assistant","text":"好的","at":"x"}]}`), 0o600)
	if w := storeRequest(s, "DELETE", "/api/components/etcd/draft", nil, admin, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "session.json")); err == nil {
		t.Fatal("the next draft would start with the old conversation")
	}
	w := storeRequest(s, "GET", "/api/components/etcd/ai/history", nil, admin, "")
	var got struct{ History []compHistory }
	json.Unmarshal(w.Body.Bytes(), &got)
	if len(got.History) != 1 || got.History[0].Label != "草稿被放弃" || got.History[0].Title != "加一个检查" || got.History[0].Messages != 2 {
		t.Fatal(w.Body.String())
	}
	w = storeRequest(s, "GET", "/api/components/etcd/ai/history/"+got.History[0].ID, nil, admin, "")
	if !strings.Contains(w.Body.String(), "好的") {
		t.Fatal("the old conversation cannot be read", w.Body.String())
	}
	// a conversation with nothing in it leaves no trace
	if w := storeRequest(s, "POST", "/api/components/etcd/draft", strings.NewReader(`{"from":"builtin"}`), admin, csrf); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := storeRequest(s, "DELETE", "/api/components/etcd/draft", nil, admin, csrf); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if h := s.listCompHistory("etcd"); len(h) != 1 {
		t.Fatal("an empty conversation was filed", h)
	}
}

func TestAIChatsIncludesComponentWorkbenchSessions(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	if w := storeRequest(s, "POST", "/api/components/etcd/draft", strings.NewReader(`{"from":"builtin"}`), admin, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	dir := s.compAIDir("etcd")
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(filepath.Join(dir, "session.json"), []byte(`{"messages":[{"role":"user","text":"第一次草稿讨论","at":"2026-11-19T10:00:00Z"},{"role":"assistant","text":"收到","at":"2026-11-19T10:00:05Z"}]}`), 0o600)
	if w := storeRequest(s, "DELETE", "/api/components/etcd/draft", nil, admin, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := storeRequest(s, "POST", "/api/components/etcd/draft", strings.NewReader(`{"from":"builtin"}`), admin, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	_ = os.WriteFile(filepath.Join(dir, "session.json"), []byte(`{"messages":[{"role":"user","text":"当前草稿优化","at":"2026-11-19T11:00:00Z"},{"role":"assistant","text":"已检查","at":"2026-11-19T11:00:05Z"}]}`), 0o600)

	w := storeRequest(s, "GET", "/api/ai/chats", nil, admin, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var resp struct {
		CompSessions []compSession `json:"comp_sessions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.CompSessions) != 2 {
		t.Fatalf("expected 2 component workbench sessions (1 active + 1 archived), got %d: %+v", len(resp.CompSessions), resp.CompSessions)
	}
	var sawActive, sawArchived bool
	for _, cs := range resp.CompSessions {
		if cs.Comp != "etcd" {
			t.Fatalf("unexpected comp: %+v", cs)
		}
		if cs.Active && cs.HasDraft && cs.Title == "当前草稿优化" {
			sawActive = true
		}
		if !cs.Active && cs.HistoryID != "" && cs.Title == "第一次草稿讨论" {
			sawArchived = true
		}
	}
	if !sawActive || !sawArchived {
		t.Fatalf("missing active or archived session: %+v", resp.CompSessions)
	}

	// Regular user without component.edit permission must not see component workbench sessions
	alice, _ := storeLogin(t, s, "alice")
	w2 := storeRequest(s, "GET", "/api/ai/chats", nil, alice, "")
	if w2.Code != 200 {
		t.Fatal(w2.Code, w2.Body.String())
	}
	var resp2 struct {
		CompSessions []compSession `json:"comp_sessions"`
	}
	_ = json.Unmarshal(w2.Body.Bytes(), &resp2)
	if len(resp2.CompSessions) != 0 {
		t.Fatalf("non-editor should not see comp_sessions, got %+v", resp2.CompSessions)
	}

	// GET /api/components/etcd/ai/session includes has_draft: true
	ws := storeRequest(s, "GET", "/api/components/etcd/ai/session", nil, admin, "")
	if ws.Code != 200 || !strings.Contains(ws.Body.String(), `"has_draft":true`) {
		t.Fatalf("expected has_draft:true in session response, got %d %s", ws.Code, ws.Body.String())
	}
}

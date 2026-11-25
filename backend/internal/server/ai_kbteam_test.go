package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTeamKnowledgeBase(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, csrf := storeLogin(t, s, "alice")
	bob, bcsrf := storeLogin(t, s, "bob")
	// a team with alice only
	w := storeRequest(s, "POST", "/api/iam/teams", strings.NewReader(`{"name":"一组","members":["alice"]}`), admin, acsrf)
	var view struct {
		Teams []struct{ ID string } `json:"teams"`
	}
	json.Unmarshal(w.Body.Bytes(), &view)
	team := view.Teams[0].ID
	// an engineer proposes; it is not in the base until someone approves it
	w = storeRequest(s, "POST", "/api/kb/submissions", strings.NewReader(`{"title":"etcd 选主频繁","text":"现象：选主频繁。原因：机械盘 fsync 慢。处理：换 SSD。","source":"delivery x step:a"}`), alice, csrf)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var sub kbSubmission
	json.Unmarshal(w.Body.Bytes(), &sub)
	if strings.Contains(s.extFor("assistant", aiOpts{User: "alice"}).prompt, "etcd 选主频繁") {
		t.Fatal("a pending submission reached the assistant")
	}
	if w := storeRequest(s, "POST", "/api/kb/submissions/"+sub.ID+"/approve", strings.NewReader(`{}`), alice, csrf); w.Code != 403 {
		t.Fatal("approved own submission without kb.manage", w.Code)
	}
	if w := storeRequest(s, "POST", "/api/kb/submissions/"+sub.ID+"/approve", strings.NewReader(`{"team":"`+team+`"}`), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	// the team's document reaches alice's conversations, not bob's
	x := s.extFor("assistant", aiOpts{User: "alice"})
	if got := x.wrap(nil)("search_knowledge", `{"query":"选主"}`); !strings.Contains(got, "团队知识库") || !strings.Contains(got, "换 SSD") {
		t.Fatal(got)
	}
	if s.extFor("assistant", aiOpts{User: "bob"}).kb {
		t.Fatal("a team document reached someone outside the team")
	}
	if w := storeRequest(s, "GET", "/api/kb/search?q=%E9%80%89%E4%B8%BB", nil, bob, ""); strings.Contains(w.Body.String(), "选主") {
		t.Fatal("someone outside the team found it")
	}
	// writing to the base directly needs kb.manage
	if w := storeRequest(s, "POST", "/api/kb", strings.NewReader(`{"title":"x","text":"y"}`), bob, bcsrf); w.Code != 403 {
		t.Fatal("wrote to the team base without kb.manage", w.Code)
	}
	if w := storeRequest(s, "POST", "/api/kb", strings.NewReader(`{"title":"变更规范","text":"变更窗口：周二晚上"}`), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if !strings.Contains(s.extFor("assistant", aiOpts{User: "bob"}).prompt, "变更规范") {
		t.Fatal("a document for everyone did not reach bob")
	}
}

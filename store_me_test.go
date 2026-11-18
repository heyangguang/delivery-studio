package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOwnPasswordChange(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	other, _ := storeLogin(t, s, "alice")
	if w := storeRequest(s, "POST", "/api/me/password", strings.NewReader(`{"current":"wrong-password-1","next":"a-new-password-42"}`), alice, csrf); w.Code != 403 {
		t.Fatal("a wrong current password was accepted", w.Code)
	}
	if w := storeRequest(s, "POST", "/api/me/password", strings.NewReader(`{"current":"test-password-123456","next":"short"}`), alice, csrf); w.Code != 400 {
		t.Fatal("a short password was accepted", w.Code)
	}
	if w := storeRequest(s, "POST", "/api/me/password", strings.NewReader(`{"current":"test-password-123456","next":"a-new-password-42"}`), alice, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	// this sign-in stays, the other one ends
	if w := storeRequest(s, "GET", "/api/me", nil, alice, ""); w.Code != 200 {
		t.Fatal("the session that changed the password was ended", w.Code)
	}
	if w := storeRequest(s, "GET", "/api/me", nil, other, ""); w.Code != 401 {
		t.Fatal("another sign-in survived a password change", w.Code)
	}
	if w := storeRequest(s, "POST", "/api/login", strings.NewReader(`{"Username":"alice","Password":"a-new-password-42"}`), nil, ""); w.Code != 200 {
		t.Fatal("the new password does not work", w.Code)
	}
}

func TestOwnSkillsMCPAndKnowledge(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	bob, _ := storeLogin(t, s, "bob")
	// a skill of one's own: it cannot take a platform skill's name, and only its owner's conversations get it
	if w := storeRequest(s, "PUT", "/api/me/skills", strings.NewReader(`{"skills":[{"name":"ansible-debug","title":"x","description":"x","content":"x"}]}`), alice, csrf); w.Code != 400 {
		t.Fatal("a platform skill's name was taken", w.Code)
	}
	if w := storeRequest(s, "PUT", "/api/me/skills", strings.NewReader(`{"skills":[{"name":"site-net","title":"机房网络","description":"本机房的网络划分","content":"管理网 10.8.0.0/16"}]}`), alice, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	x := s.extFor("assistant", aiOpts{User: "alice"})
	if !strings.Contains(x.prompt, "site-net") {
		t.Fatal("the owner's skill is not offered")
	}
	if got := x.wrap(nil)("use_skill", `{"name":"site-net"}`); !strings.Contains(got, "10.8.0.0/16") {
		t.Fatal(got)
	}
	if strings.Contains(s.extFor("assistant", aiOpts{User: "bob"}).prompt, "site-net") {
		t.Fatal("someone else's skill was offered")
	}

	// an outside service of one's own only offers read-only tools, even when asked for more
	srv, _ := fakeMCP(t)
	w := storeRequest(s, "POST", "/api/me/mcp", strings.NewReader(`{"name":"我的监控","url":"`+srv.URL+`","enabled":true,"allow_write":true}`), alice, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var id struct{ ID string }
	json.Unmarshal(w.Body.Bytes(), &id)
	if w := storeRequest(s, "POST", "/api/me/mcp/"+id.ID+"/refresh", nil, alice, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	names := map[string]bool{}
	for _, d := range s.extFor("assistant", aiOpts{User: "alice"}).tools {
		names[d.Name] = true
	}
	if !names[mcpToolName(id.ID, "query_metrics")] || names[mcpToolName(id.ID, "restart_service")] {
		t.Fatal("own service tools", names)
	}
	for _, d := range s.extFor("assistant", aiOpts{User: "bob"}).tools {
		if strings.HasPrefix(d.Name, "mcp__"+id.ID) {
			t.Fatal("someone else's service was offered")
		}
	}
	if w := storeRequest(s, "GET", "/api/me/mcp", nil, bob, ""); strings.Contains(w.Body.String(), "我的监控") {
		t.Fatal("someone else's services are listed")
	}

	// the knowledge base: searched by its owner's conversations, with secrets taken out
	doc := `{"title":"机房变更记录","text":"2026-09 etcd 扩容时 node-04 磁盘满了，原因是 /data 没有挂载。\n\n数据库口令 password=hunter2-secret"}`
	if w := storeRequest(s, "POST", "/api/me/kb", strings.NewReader(doc), alice, csrf); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	x = s.extFor("assistant", aiOpts{User: "alice"})
	if !x.kb || !strings.Contains(x.prompt, "机房变更记录") {
		t.Fatal("the knowledge base is not offered")
	}
	got := x.wrap(nil)("search_knowledge", `{"query":"磁盘满"}`)
	if !strings.Contains(got, "/data 没有挂载") || strings.Contains(got, "hunter2-secret") {
		t.Fatal(got)
	}
	if w := storeRequest(s, "GET", "/api/me/kb/search?q=%E7%A3%81%E7%9B%98", nil, alice, ""); w.Code != 200 || !strings.Contains(w.Body.String(), "机房变更记录") {
		t.Fatal("search from the page", w.Code, w.Body.String())
	}
	if w := storeRequest(s, "GET", "/api/me/kb/search?q=%E7%A3%81%E7%9B%98", nil, bob, ""); strings.Contains(w.Body.String(), "机房变更记录") {
		t.Fatal("someone else's knowledge base was searched")
	}
	if s.extFor("assistant", aiOpts{User: "alice", NoKB: true}).kb || s.extFor("assistant", aiOpts{User: "bob"}).kb {
		t.Fatal("the knowledge base was offered where it should not be")
	}
	if w := storeRequest(s, "POST", "/api/me/kb", strings.NewReader(`{"title":"x","text":"   "}`), alice, csrf); w.Code != 400 {
		t.Fatal("an empty document was taken", w.Code)
	}
}

func TestKnowledgeTerms(t *testing.T) {
	got := strings.Join(kbTerms("etcd 磁盘满了 node-04"), "|")
	if got != "etcd|磁盘|盘满|满了|node-04" {
		t.Fatal(got)
	}
}

func TestActivityOfSomeoneWithoutDeliveries(t *testing.T) {
	s, _ := testStore(t)
	admin, _ := storeLogin(t, s, "admin")
	if w := storeRequest(s, "GET", "/api/users/bob/activity", nil, admin, ""); !strings.Contains(w.Body.String(), `"jobs":[]`) {
		t.Fatal("no deliveries must be an empty list, not null:", w.Body.String())
	}
}

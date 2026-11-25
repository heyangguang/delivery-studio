package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func auditRows(t *testing.T, s *storeServer, query string) []auditEvent {
	t.Helper()
	admin, _ := storeLogin(t, s, "admin")
	w := storeRequest(s, "GET", "/api/audit?size=200"+query, nil, admin, "")
	var out struct {
		Rows []auditEvent `json:"rows"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	return out.Rows
}

func TestAuditRecordsWhoWhatWhichAndHow(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	// a change: one record with the person, address, resource, what was sent (secrets masked) and the result
	storeRequest(s, "POST", "/api/me/password", strings.NewReader(`{"current":"wrong-password-1","next":"a-new-password-42"}`), alice, csrf)
	var pw *auditEvent
	for _, e := range auditRows(t, s, "&user=alice") {
		if e.Path == "/api/me/password" {
			e := e
			pw = &e
		}
	}
	if pw == nil || pw.Method != "POST" || pw.Result != "denied" || pw.Status != 403 || pw.Error == "" || pw.Resource == nil || pw.Resource.Type != "我的账户" {
		t.Fatalf("%+v", pw)
	}
	if strings.Contains(pw.Request, "wrong-password-1") || strings.Contains(pw.Request, "a-new-password-42") || !strings.Contains(pw.Request, "******") {
		t.Fatal("a password was kept in the audit:", pw.Request)
	}
	// a request that is refused for want of permission is recorded as such
	storeRequest(s, "POST", "/api/iam/roles", strings.NewReader(`{"name":"x","perms":[],"scope":"own"}`), alice, csrf)
	found := false
	for _, e := range auditRows(t, s, "&result=denied") {
		found = found || (e.Path == "/api/iam/roles" && e.User == "alice" && e.Resource != nil && e.Resource.Type == "角色")
	}
	if !found {
		t.Fatal("a refused request was not recorded")
	}
	// a delivery: created once, under its own name, not twice
	one := `{"id":"etcd-one","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	storeCreate(t, s, alice, csrf, one, nil)
	s.wg.Wait()
	n := 0
	for _, e := range auditRows(t, s, "&user=alice") {
		if e.Method == "POST" && e.Path == "/api/jobs" {
			n++
			if e.Action != "job-create" || e.Resource == nil || e.Resource.Type != "交付" || e.Resource.Name != "etcd-one" || !strings.Contains(e.Request, "etcd-one") {
				t.Fatalf("%+v", e)
			}
		}
	}
	if n != 1 {
		t.Fatal("the creation was recorded", n, "times")
	}
	// reads are not recorded, except what takes data away
	before := len(auditRows(t, s, "&user=alice"))
	storeRequest(s, "GET", "/api/jobs", nil, alice, "")
	if after := len(auditRows(t, s, "&user=alice")); after != before {
		t.Fatal("a plain read was recorded")
	}
	// export as a spreadsheet
	admin, _ := storeLogin(t, s, "admin")
	if w := storeRequest(s, "GET", "/api/audit/export", nil, admin, ""); w.Code != 200 || !strings.Contains(w.Body.String(), "请求内容") || !strings.Contains(w.Body.String(), "/api/jobs") {
		t.Fatal(w.Code, w.Body.String()[:min(300, w.Body.Len())])
	}
}

func TestDeleteUserKeepsDeliveries(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, csrf := storeLogin(t, s, "alice")
	one := `{"id":"etcd-one","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	storeCreate(t, s, alice, csrf, one, nil)
	s.wg.Wait()
	if w := storeRequest(s, "DELETE", "/api/users/admin", nil, admin, acsrf); w.Code != 409 {
		t.Fatal("deleted oneself", w.Code)
	}
	if w := storeRequest(s, "DELETE", "/api/users/alice", strings.NewReader(`{"move_to":"bob"}`), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := storeRequest(s, "GET", "/api/me", nil, alice, ""); w.Code != 401 {
		t.Fatal("a deleted account is still signed in", w.Code)
	}
	bob, _ := storeLogin(t, s, "bob")
	var js []storeJob
	json.Unmarshal(storeRequest(s, "GET", "/api/jobs", nil, bob, "").Body.Bytes(), &js)
	if len(js) != 1 || js[0].ClusterID != "etcd-one" {
		t.Fatal("the deliveries were not handed over", js)
	}
	// the name is not given out again
	if w := storeRequest(s, "POST", "/api/users", strings.NewReader(`{"username":"alice","password":"a-long-password-123","roles":["engineer"]}`), admin, acsrf); w.Code != 409 {
		t.Fatal("a removed name was reused", w.Code)
	}
	// the audit keeps the removal
	found := false
	for _, e := range auditRows(t, s, "&action=user-delete") {
		found = found || strings.Contains(e.Job, "alice")
	}
	if !found {
		t.Fatal("the removal is not in the audit")
	}
}

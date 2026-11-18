package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRolesTeamsAndScopes(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, csrf := storeLogin(t, s, "alice")
	bob, bcsrf := storeLogin(t, s, "bob")
	one := `{"id":"etcd-one","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	if w := storeCreate(t, s, alice, csrf, one, nil); w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	s.wg.Wait()
	list := func(who string) int {
		ck, _ := storeLogin(t, s, who)
		w := storeRequest(s, "GET", "/api/jobs", nil, ck, "")
		var js []storeJob
		json.Unmarshal(w.Body.Bytes(), &js)
		return len(js)
	}
	// the old roles carry on: engineers see their own, administrators everything
	if list("alice") != 1 || list("bob") != 0 || list("admin") != 1 {
		t.Fatal("default scopes", list("alice"), list("bob"), list("admin"))
	}
	// a team with scope "team": bob now sees alice's delivery
	w := storeRequest(s, "POST", "/api/iam/teams", strings.NewReader(`{"name":"一组","members":["alice","bob"]}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var view struct {
		Roles []role `json:"roles"`
		Teams []struct {
			ID      string   `json:"id"`
			Members []string `json:"members"`
		} `json:"teams"`
	}
	json.Unmarshal(w.Body.Bytes(), &view)
	if len(view.Teams) != 1 || len(view.Teams[0].Members) != 2 {
		t.Fatal(w.Body.String())
	}
	w = storeRequest(s, "POST", "/api/iam/roles", strings.NewReader(`{"name":"组内工程师","perms":["delivery.view","delivery.download","delivery.run"],"scope":"team"}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	json.Unmarshal(w.Body.Bytes(), &view)
	var teamRole string
	for _, r := range view.Roles {
		if r.Name == "组内工程师" {
			teamRole = r.ID
		}
	}
	if w := storeRequest(s, "PUT", "/api/users/bob/grant", strings.NewReader(`{"roles":["`+teamRole+`"],"teams":["`+view.Teams[0].ID+`"]}`), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if list("bob") != 1 {
		t.Fatal("a team member does not see the team's delivery")
	}
	// bob may look and record progress, but not create, delete or use AI: the buttons and the requests behind them agree
	if w := storeCreate(t, s, bob, bcsrf, one, nil); w.Code != 403 {
		t.Fatal("created without the permission", w.Code)
	}
	var js []storeJob
	ck, _ := storeLogin(t, s, "alice")
	json.Unmarshal(storeRequest(s, "GET", "/api/jobs", nil, ck, "").Body.Bytes(), &js)
	if w := storeRequest(s, "DELETE", "/api/jobs/"+js[0].ID, nil, bob, bcsrf); w.Code != 403 {
		t.Fatal("deleted without the permission", w.Code)
	}
	if w := storeRequest(s, "POST", "/api/ai/chats", strings.NewReader(`{}`), bob, bcsrf); w.Code != 403 {
		t.Fatal("AI without the permission", w.Code)
	}
	if w := storeRequest(s, "GET", "/api/session", nil, bob, ""); !strings.Contains(w.Body.String(), `"delivery.run"`) || strings.Contains(w.Body.String(), `"delivery.create"`) || !strings.Contains(w.Body.String(), `"scope":"team"`) {
		t.Fatal(w.Body.String())
	}
	// a person who manages people but not AI settings cannot hand out the administrator role
	w = storeRequest(s, "POST", "/api/iam/roles", strings.NewReader(`{"name":"人事","perms":["iam.user","delivery.view"],"scope":"own"}`), admin, acsrf)
	json.Unmarshal(w.Body.Bytes(), &view)
	var hr string
	for _, r := range view.Roles {
		if r.Name == "人事" {
			hr = r.ID
		}
	}
	if w := storeRequest(s, "PUT", "/api/users/alice/grant", strings.NewReader(`{"roles":["`+hr+`"]}`), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	alice, csrf = storeLogin(t, s, "alice")
	if w := storeRequest(s, "PUT", "/api/users/bob/grant", strings.NewReader(`{"roles":["sysadmin"]}`), alice, csrf); w.Code != 403 {
		t.Fatal("handed out more than held", w.Code, w.Body.String())
	}
	if w := storeRequest(s, "PUT", "/api/users/alice/grant", strings.NewReader(`{"roles":["sysadmin"]}`), alice, csrf); w.Code != 403 {
		t.Fatal("raised own permissions", w.Code)
	}
	if w := storeRequest(s, "POST", "/api/iam/roles", strings.NewReader(`{"name":"x","perms":["iam.user"],"scope":"own"}`), alice, csrf); w.Code != 403 {
		t.Fatal("made a role without iam.role", w.Code)
	}
	// someone must always be able to manage people and roles
	if w := storeRequest(s, "PUT", "/api/users/admin/grant", strings.NewReader(`{"roles":["engineer"]}`), admin, acsrf); w.Code != 409 {
		t.Fatal("the last keeper lost the role", w.Code, w.Body.String())
	}
	if w := storeRequest(s, "PUT", "/api/iam/roles/sysadmin", strings.NewReader(`{"name":"改内置","perms":[],"scope":"own"}`), admin, acsrf); w.Code != 404 {
		t.Fatal("a built-in role was changed", w.Code)
	}
	// an auditor reads but changes nothing
	if w := storeRequest(s, "PUT", "/api/users/bob/grant", strings.NewReader(`{"roles":["auditor"]}`), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := storeRequest(s, "GET", "/api/audit", nil, bob, ""); w.Code != 200 {
		t.Fatal("auditor cannot read the audit", w.Code)
	}
	if list("bob") != 1 {
		t.Fatal("auditor does not see all deliveries")
	}
	if w := storeRequest(s, "PATCH", "/api/jobs/"+js[0].ID, strings.NewReader(`{"outcome":"done"}`), bob, bcsrf); w.Code != 403 {
		t.Fatal("auditor marked outcome", w.Code)
	}
}

func TestEveryChangingRouteHasAPermission(t *testing.T) {
	if _, ok := routePermFor("POST", "/api/something-new"); ok {
		t.Fatal("an unknown changing request is allowed")
	}
	for _, c := range [][3]string{
		{"POST", "/api/jobs", "delivery.create"},
		{"POST", "/api/ai/toggle", "ai.settings"},
		{"GET", "/api/jobs/abc/archive", "delivery.download"},
		{"GET", "/api/clusters/pg1/rehearsals", "delivery.view"},
		{"POST", "/api/clusters/pg1/rehearsals", "ai.use"},
		{"POST", "/api/components/etcd/draft/publish", "component.publish"},
		{"PUT", "/api/components/etcd/draft", "component.edit"},
		{"GET", "/api/components/etcd/workspace", "component.edit"},
		{"GET", "/api/settings/ai/usage/stats", "ai.usage"},
		{"POST", "/api/me/kb", ""},
		{"POST", "/api/kb/submissions", "kb.submit"},
	} {
		if p, ok := routePermFor(c[0], c[1]); !ok || p != c[2] {
			t.Fatal(c, p, ok)
		}
	}
	for _, r := range routePerms {
		for _, p := range strings.Split(r.perm, "|") {
			if _, ok := permIndex[p]; p != "" && !ok {
				t.Fatal("unknown permission in the routes", p)
			}
		}
	}
	for _, r := range builtinRoles {
		for _, p := range r.Perms {
			if _, ok := permIndex[p]; !ok {
				t.Fatal("unknown permission in a role", r.ID, p)
			}
		}
	}
}

package server

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
		{"PUT", "/api/iam/clusters/pg-prod", "iam.user|iam.team"},
		{"GET", "/api/executions/unified-agents", "execution.manage|delivery.view"},
		{"POST", "/api/executions/unified-agents", "execution.manage|delivery.view|delivery.create|delivery.execute"},
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

func TestPerClusterPermissionsUserTeamAndReadOnlyGuard(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, acsrfUser := storeLogin(t, s, "alice")
	bob, bcsrf := storeLogin(t, s, "bob")

	// Alice creates cluster "pg-alpha"; Bob creates cluster "pg-beta".
	alphaSpec := `{"id":"pg-alpha","hosts":[{"name":"n1","ip":"10.1.0.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	betaSpec := `{"id":"pg-beta","hosts":[{"name":"n2","ip":"10.1.0.12"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n2"]}}]}`
	if w := storeCreate(t, s, alice, acsrfUser, alphaSpec, nil); w.Code != 202 {
		t.Fatal("create alpha:", w.Code, w.Body.String())
	}
	if w := storeCreate(t, s, bob, bcsrf, betaSpec, nil); w.Code != 202 {
		t.Fatal("create beta:", w.Code, w.Body.String())
	}
	s.wg.Wait()

	clustersFor := func(who string) map[string]string {
		ck, _ := storeLogin(t, s, who)
		w := storeRequest(s, "GET", "/api/clusters", nil, ck, "")
		if w.Code != 200 {
			t.Fatalf("GET /api/clusters for %s: %d %s", who, w.Code, w.Body.String())
		}
		var views []clusterView
		if err := json.Unmarshal(w.Body.Bytes(), &views); err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		for _, v := range views {
			out[v.ID] = v.AccessLevel
		}
		return out
	}

	// 1. Default creator ownership + admin sees all.
	aCls, bCls, admCls := clustersFor("alice"), clustersFor("bob"), clustersFor("admin")
	if len(aCls) != 1 || aCls["pg-alpha"] != "operate" {
		t.Fatalf("alice default clusters = %v", aCls)
	}
	if len(bCls) != 1 || bCls["pg-beta"] != "operate" {
		t.Fatalf("bob default clusters = %v", bCls)
	}
	if len(admCls) != 2 || admCls["pg-alpha"] != "operate" || admCls["pg-beta"] != "operate" {
		t.Fatalf("admin default clusters = %v", admCls)
	}

	// Find alpha's job ID.
	var aJobs []storeJob
	if err := json.Unmarshal(storeRequest(s, "GET", "/api/jobs", nil, alice, "").Body.Bytes(), &aJobs); err != nil || len(aJobs) != 1 {
		t.Fatalf("alice jobs = %v, err=%v", aJobs, err)
	}
	alphaJobID := aJobs[0].ID

	// 2. Grant Bob direct read-only ("view") access to pg-alpha via user grant endpoint.
	if w := storeRequest(s, "PUT", "/api/users/bob/grant", strings.NewReader(`{"roles":["engineer"],"teams":[],"clusters":{"pg-alpha":"view"}}`), admin, acsrf); w.Code != 200 {
		t.Fatalf("grant bob view on pg-alpha: %d %s", w.Code, w.Body.String())
	}
	bCls = clustersFor("bob")
	if bCls["pg-alpha"] != "view" || bCls["pg-beta"] != "operate" {
		t.Fatalf("bob clusters after view grant = %v", bCls)
	}
	// Bob can read docs & job detail of pg-alpha, and session/me expose clusters.
	if w := storeRequest(s, "GET", "/api/clusters/pg-alpha/docs", nil, bob, ""); w.Code != 200 {
		t.Fatalf("bob read pg-alpha docs: %d %s", w.Code, w.Body.String())
	}
	if w := storeRequest(s, "GET", "/api/jobs/"+alphaJobID, nil, bob, ""); w.Code != 200 {
		t.Fatalf("bob read alpha job: %d %s", w.Code, w.Body.String())
	}
	if w := storeRequest(s, "GET", "/api/session", nil, bob, ""); !strings.Contains(w.Body.String(), `"pg-alpha":"view"`) {
		t.Fatalf("session missing cluster grant: %s", w.Body.String())
	}
	if w := storeRequest(s, "GET", "/api/me", nil, bob, ""); !strings.Contains(w.Body.String(), `"pg-alpha":"view"`) {
		t.Fatalf("/api/me missing cluster grant: %s", w.Body.String())
	}
	// Bob is BLOCKED (403) on mutating pg-alpha (PATCH job, DELETE job, POST docs RCA, PUT doc meta).
	if w := storeRequest(s, "PATCH", "/api/jobs/"+alphaJobID, strings.NewReader(`{"outcome":"done"}`), bob, bcsrf); w.Code != 403 {
		t.Fatalf("read-only bob patched alpha job: %d %s", w.Code, w.Body.String())
	}
	if w := storeRequest(s, "DELETE", "/api/jobs/"+alphaJobID, nil, bob, bcsrf); w.Code != 403 {
		t.Fatalf("read-only bob deleted alpha job: %d %s", w.Code, w.Body.String())
	}
	if w := storeRequest(s, "POST", "/api/clusters/pg-alpha/docs", strings.NewReader(`{"title":"test"}`), bob, bcsrf); w.Code != 403 {
		t.Fatalf("read-only bob posted alpha doc: %d %s", w.Code, w.Body.String())
	}

	// 3. Upgrade via team cluster grant ("operate" > "view"): widest level wins!
	w := storeRequest(s, "POST", "/api/iam/teams", strings.NewReader(`{"name":"核心运维组","members":["bob"],"clusters":{"pg-alpha":"operate"}}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("create team with cluster grant: %d %s", w.Code, w.Body.String())
	}
	var iamResp struct {
		Teams []struct {
			ID       string            `json:"id"`
			Clusters map[string]string `json:"clusters"`
		} `json:"teams"`
		Clusters []struct {
			ID    string            `json:"id"`
			Owner string            `json:"owner"`
			Users map[string]string `json:"users"`
			Teams map[string]string `json:"teams"`
		} `json:"clusters"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &iamResp); err != nil {
		t.Fatal(err)
	}
	if len(iamResp.Teams) != 1 || iamResp.Teams[0].Clusters["pg-alpha"] != "operate" {
		t.Fatalf("team clusters missing: %s", w.Body.String())
	}
	teamID := iamResp.Teams[0].ID
	bCls = clustersFor("bob")
	if bCls["pg-alpha"] != "operate" {
		t.Fatalf("widest team grant should upgrade bob to operate, got %v", bCls)
	}
	// Now Bob CAN mark outcome on pg-alpha!
	if w := storeRequest(s, "PATCH", "/api/jobs/"+alphaJobID, strings.NewReader(`{"outcome":"done"}`), bob, bcsrf); w.Code != 200 {
		t.Fatalf("operate bob should patch alpha job: %d %s", w.Code, w.Body.String())
	}

	// 4. Cluster-centric API PUT /api/iam/clusters/{clusterID} revokes both user & team grants atomically.
	w = storeRequest(s, "PUT", "/api/iam/clusters/pg-alpha", strings.NewReader(`{"users":{},"teams":{}}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("PUT /api/iam/clusters/pg-alpha: %d %s", w.Code, w.Body.String())
	}
	bCls = clustersFor("bob")
	if _, has := bCls["pg-alpha"]; has {
		t.Fatalf("bob should no longer see pg-alpha after revoke: %v", bCls)
	}
	// Assign Bob back via cluster-centric API ("operate") and verify IAM view reflects it.
	w = storeRequest(s, "PUT", "/api/iam/clusters/pg-alpha", strings.NewReader(`{"users":{"bob":"view"},"teams":{"`+teamID+`":"view"}}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("PUT /api/iam/clusters/pg-alpha reassign: %d %s", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &iamResp); err != nil {
		t.Fatal(err)
	}
	foundAlpha := false
	for _, cl := range iamResp.Clusters {
		if cl.ID == "pg-alpha" {
			foundAlpha = true
			if cl.Owner != "alice" || cl.Users["bob"] != "view" || cl.Teams[teamID] != "view" {
				t.Fatalf("unexpected cluster view: %+v", cl)
			}
		}
	}
	if !foundAlpha {
		t.Fatalf("pg-alpha missing in /api/iam clusters")
	}

	// 5. Anti-escalation: delegated iam.user (scope=own) can grant own cluster pg-alpha, CANNOT grant Bob's pg-beta.
	w = storeRequest(s, "POST", "/api/iam/roles", strings.NewReader(`{"name":"项目负责人","perms":["iam.user","delivery.view"],"scope":"own"}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var roleResp struct {
		Roles []role `json:"roles"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &roleResp)
	var leadRole string
	for _, r := range roleResp.Roles {
		if r.Name == "项目负责人" {
			leadRole = r.ID
		}
	}
	if w := storeRequest(s, "PUT", "/api/users/alice/grant", strings.NewReader(`{"roles":["`+leadRole+`"]}`), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	alice, acsrfUser = storeLogin(t, s, "alice")
	// Alice CAN manage her own pg-alpha cluster access.
	if w := storeRequest(s, "PUT", "/api/iam/clusters/pg-alpha", strings.NewReader(`{"users":{"bob":"operate"}}`), alice, acsrfUser); w.Code != 200 {
		t.Fatalf("alice should be allowed to grant her own cluster pg-alpha: %d %s", w.Code, w.Body.String())
	}
	// Alice CANNOT grant Bob's cluster pg-beta (403).
	if w := storeRequest(s, "PUT", "/api/iam/clusters/pg-beta", strings.NewReader(`{"users":{"alice":"operate"}}`), alice, acsrfUser); w.Code != 403 {
		t.Fatalf("alice escalated onto pg-beta: %d %s", w.Code, w.Body.String())
	}
	if w := storeRequest(s, "PUT", "/api/users/alice/grant", strings.NewReader(`{"roles":["`+leadRole+`"],"teams":[],"clusters":{"pg-beta":"view"}}`), alice, acsrfUser); w.Code != 403 {
		t.Fatalf("alice self-granted pg-beta via user grant: %d %s", w.Code, w.Body.String())
	}
}

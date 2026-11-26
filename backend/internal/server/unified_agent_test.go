package server

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUnifiedAgentPerClusterOperatorBindAndHeartbeats(t *testing.T) {
	srv, _ := testStore(t)
	cookie, csrf := storeLogin(t, srv, "admin")
	bobCookie, bobCSRF := storeLogin(t, srv, "bob")

	// 1. Admin imports admin-pg-prod; bob imports bob-pg-own.
	adminCluster := `{"id":"admin-pg-prod","component":"postgresql","display_name":"PostgreSQL","version":"17","exact_version":"17.11","platform":"ubuntu2404","deploy_method":"systemd","hosts":[{"name":"db-01","ip":"10.30.0.11","role":"primary"}]}`
	if rr := storeRequest(srv, "POST", "/api/clusters/import", strings.NewReader(adminCluster), cookie, csrf); rr.Code != 200 && rr.Code != 201 {
		t.Fatalf("admin import cluster failed: %d %s", rr.Code, rr.Body.String())
	}
	bobCluster := `{"id":"bob-pg-own","component":"postgresql","display_name":"PostgreSQL","version":"17","exact_version":"17.11","platform":"ubuntu2404","deploy_method":"systemd","hosts":[{"name":"db-02","ip":"10.30.0.12","role":"primary"}]}`
	if rr := storeRequest(srv, "POST", "/api/clusters/import", strings.NewReader(bobCluster), bobCookie, bobCSRF); rr.Code != 200 && rr.Code != 201 {
		t.Fatalf("bob import cluster failed: %d %s", rr.Code, rr.Body.String())
	}

	// 2. Admin enrolls a shared Unified Agent and binds admin-pg-prod.
	enrollRR := storeRequest(srv, "POST", "/api/executions/unified-agents", strings.NewReader(`{"name":"jumpbox-01","ip":"10.30.0.5","clusters":["admin-pg-prod"]}`), cookie, csrf)
	if enrollRR.Code != 201 {
		t.Fatalf("enroll unified agent failed: %d %s", enrollRR.Code, enrollRR.Body.String())
	}
	var enrolled struct {
		Agent unifiedAgentView `json:"agent"`
		Token string           `json:"token"`
	}
	_ = json.Unmarshal(enrollRR.Body.Bytes(), &enrolled)

	// 3. Simulate heartbeat with probe telemetry -> verify Heartbeats history is recorded!
	pollReq := httptest.NewRequest("POST", "http://127.0.0.1:8090/api/execution-agent/poll", bytes.NewReader([]byte(`{"protocol":3,"version":"1.0.0","heartbeat":true,"probe":{"hostname":"jumpbox-01","cpu_cores":8,"load1":0.65,"mem_total_mb":16384,"mem_used_pct":31.5,"disk_total_gb":200,"disk_used_pct":42.0}}`)))
	pollReq.Header.Set("Authorization", "Bearer "+enrolled.Token)
	pollReq.Header.Set("Content-Type", "application/json")
	pollW := httptest.NewRecorder()
	srv.ServeHTTP(pollW, pollReq)
	if pollW.Code != 200 {
		t.Fatalf("unified agent poll failed: %d %s", pollW.Code, pollW.Body.String())
	}

	// 4. Bob CAN list Agents (sees jumpbox-01 & manageable_clusters=["bob-pg-own"], does NOT see admin's private cluster).
	bobListRR := storeRequest(srv, "GET", "/api/executions/unified-agents", nil, bobCookie, "")
	if bobListRR.Code != 200 {
		t.Fatalf("expected bob GET unified-agents 200, got %d %s", bobListRR.Code, bobListRR.Body.String())
	}
	var bobList struct {
		Agents             []unifiedAgentView `json:"agents"`
		ManageableClusters []string           `json:"manageable_clusters"`
	}
	_ = json.Unmarshal(bobListRR.Body.Bytes(), &bobList)
	if len(bobList.Agents) != 1 || len(bobList.Agents[0].Heartbeats) != 1 {
		t.Fatalf("expected bob to see 1 agent with 1 heartbeat sample, got %+v", bobList.Agents)
	}
	if len(bobList.ManageableClusters) != 1 || bobList.ManageableClusters[0] != "bob-pg-own" {
		t.Fatalf("expected bob manageable_clusters=[bob-pg-own], got %v", bobList.ManageableClusters)
	}
	if len(bobList.Agents[0].Clusters) != 0 {
		t.Fatalf("bob must not see admin's private cluster binding, got %v", bobList.Agents[0].Clusters)
	}

	// 5. Bob CANNOT bind admin-pg-prod (403), CANNOT globally disable Agent (403), CAN bind his own bob-pg-own (200)!
	if rr := storeRequest(srv, "PATCH", "/api/executions/unified-agents", strings.NewReader(`{"id":"`+enrolled.Agent.ID+`","bind_clusters":["admin-pg-prod"]}`), bobCookie, bobCSRF); rr.Code != 403 {
		t.Fatalf("expected 403 when bob binds admin's cluster, got %d", rr.Code)
	}
	if rr := storeRequest(srv, "PATCH", "/api/executions/unified-agents", strings.NewReader(`{"id":"`+enrolled.Agent.ID+`","disabled":true}`), bobCookie, bobCSRF); rr.Code != 403 {
		t.Fatalf("expected 403 when bob tries to globally disable agent, got %d", rr.Code)
	}
	bobBindRR := storeRequest(srv, "PATCH", "/api/executions/unified-agents", strings.NewReader(`{"id":"`+enrolled.Agent.ID+`","bind_clusters":["bob-pg-own"]}`), bobCookie, bobCSRF)
	if bobBindRR.Code != 200 {
		t.Fatalf("expected 200 when bob binds his own cluster, got %d %s", bobBindRR.Code, bobBindRR.Body.String())
	}

	// 6. Verify admin still has admin-pg-prod AND bob-pg-own (incremental merge preserved admin's private binding!).
	adminListRR := storeRequest(srv, "GET", "/api/executions/unified-agents", nil, cookie, "")
	var adminList struct {
		Agents []unifiedAgentView `json:"agents"`
	}
	_ = json.Unmarshal(adminListRR.Body.Bytes(), &adminList)
	if len(adminList.Agents) != 1 || len(adminList.Agents[0].Clusters) != 2 {
		t.Fatalf("expected both admin-pg-prod and bob-pg-own to be bound, got %+v", adminList.Agents)
	}
}

func TestLegacyNodeGrantsUnbindClusterDoesNotResurrect(t *testing.T) {
	srv, _ := testStore(t)
	cookie, csrf := storeLogin(t, srv, "admin")

	for _, cid := range []string{"ecs-pg-auto", "ecs-pg-keep"} {
		importBody := `{"id":"` + cid + `","component":"postgresql","display_name":"PostgreSQL","version":"17","exact_version":"17.11","platform":"ubuntu2404","deploy_method":"systemd","hosts":[{"name":"db-01","ip":"172.26.198.120","role":"primary"}]}`
		if rr := storeRequest(srv, "POST", "/api/clusters/import", strings.NewReader(importBody), cookie, csrf); rr.Code != 200 && rr.Code != 201 {
			t.Fatalf("import %s failed: %d %s", cid, rr.Code, rr.Body.String())
		}
	}

	tAllow := true
	executionMu.Lock()
	d, err := srv.readExecutions()
	if err != nil {
		executionMu.Unlock()
		t.Fatalf("readExecutions: %v", err)
	}
	if d.Nodes == nil {
		d.Nodes = map[string]executionNode{}
	}
	d.Nodes["ecs-pg-1-executor"] = executionNode{
		ID:             "ecs-pg-1-executor",
		Kind:           "independent",
		Name:           "ecs-pg-1-executor",
		ControllerIP:   "172.26.198.120",
		Clusters:       []string{"ecs-pg-auto", "ecs-pg-keep"},
		Grants:         map[string][]string{"ecs-pg-auto": {"172.26.198.120"}, "ecs-pg-keep": {"172.26.198.120"}},
		AllowDelivery:  &tAllow,
		AllowProbe:     &tAllow,
		AllowRehearsal: &tAllow,
	}
	if err := srv.saveExecutions(d); err != nil {
		executionMu.Unlock()
		t.Fatalf("saveExecutions: %v", err)
	}
	executionMu.Unlock()

	patchRR := storeRequest(srv, "PATCH", "/api/executions/unified-agents", strings.NewReader(`{"id":"ecs-pg-1-executor","unbind_clusters":["ecs-pg-auto"]}`), cookie, csrf)
	if patchRR.Code != 200 {
		t.Fatalf("PATCH unbind cluster failed: %d %s", patchRR.Code, patchRR.Body.String())
	}
	var updated unifiedAgentView
	_ = json.Unmarshal(patchRR.Body.Bytes(), &updated)
	if updated.ClusterModes["ecs-pg-auto"] != "" {
		t.Fatalf("ecs-pg-auto resurrected in PATCH response: %+v", updated.ClusterModes)
	}
	if updated.ClusterModes["ecs-pg-keep"] != "readwrite" {
		t.Fatalf("expected ecs-pg-keep to remain bound, got %+v", updated.ClusterModes)
	}
}

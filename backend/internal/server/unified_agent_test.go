package server

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestUnifiedAgentClusterGrantsAndOnDemandExec(t *testing.T) {
	srv, _ := testStore(t)
	cookie, csrf := storeLogin(t, srv, "admin")

	// 1. Import a production cluster WITHOUT configuring any 3-step automation wizard.
	importBody := `{
		"id": "pg-ondemand-prod",
		"component": "postgresql",
		"display_name": "PostgreSQL",
		"version": "17",
		"exact_version": "17.11",
		"platform": "ubuntu2404",
		"deploy_method": "systemd",
		"hosts": [
			{"name": "db-01", "ip": "10.30.0.11", "role": "primary"},
			{"name": "db-02", "ip": "10.30.0.12", "role": "replica"}
		]
	}`
	if rr := storeRequest(srv, "POST", "/api/clusters/import", strings.NewReader(importBody), cookie, csrf); rr.Code != 200 && rr.Code != 201 {
		t.Fatalf("import cluster failed: %d %s", rr.Code, rr.Body.String())
	}

	// 2. Enroll a Unified Agent via /api/executions/unified-agents (no cluster bound yet).
	enrollRR := storeRequest(srv, "POST", "/api/executions/unified-agents", strings.NewReader(`{"name":"jumpbox-01","ip":"10.30.0.5"}`), cookie, csrf)
	if enrollRR.Code != 201 {
		t.Fatalf("enroll unified agent failed: %d %s", enrollRR.Code, enrollRR.Body.String())
	}
	var enrolled struct {
		Agent unifiedAgentView `json:"agent"`
		Token string           `json:"token"`
	}
	_ = json.Unmarshal(enrollRR.Body.Bytes(), &enrolled)
	if enrolled.Agent.ID == "" || len(enrolled.Token) < 40 {
		t.Fatalf("unexpected unified agent enrollment response: %s", enrollRR.Body.String())
	}

	// Simulate heartbeat from Agent (with host probe telemetry).
	pollReq := httptest.NewRequest("POST", "http://127.0.0.1:8090/api/execution-agent/poll", bytes.NewReader([]byte(`{"protocol":3,"version":"1.0.0","heartbeat":true,"probe":{"hostname":"jumpbox-01","cpu_cores":8,"mem_used_pct":31.5}}`)))
	pollReq.Header.Set("Authorization", "Bearer "+enrolled.Token)
	pollReq.Header.Set("Content-Type", "application/json")
	pollW := httptest.NewRecorder()
	srv.ServeHTTP(pollW, pollReq)
	if pollW.Code != 200 {
		t.Fatalf("unified agent poll failed: %d %s", pollW.Code, pollW.Body.String())
	}

	// 3. Before granting cluster access, on-demand probe with agent_id must be rejected with 403.
	unauthProbe := storeRequest(srv, "POST", "/api/clusters/pg-ondemand-prod/automation/probe", strings.NewReader(`{"script":"#!/usr/bin/env bash\nhostname\n","agent_id":"`+enrolled.Agent.ID+`"}`), cookie, csrf)
	if unauthProbe.Code != 403 {
		t.Fatalf("expected 403 before cluster grant, got %d %s", unauthProbe.Code, unauthProbe.Body.String())
	}

	// 4. Grant "readonly" via IAM Cluster Permissions (PUT /api/iam/clusters/pg-ondemand-prod).
	grantRORR := storeRequest(srv, "PUT", "/api/iam/clusters/pg-ondemand-prod", strings.NewReader(`{"agents":{"`+enrolled.Agent.ID+`":"readonly"}}`), cookie, csrf)
	if grantRORR.Code != 200 {
		t.Fatalf("PUT /api/iam/clusters/pg-ondemand-prod readonly failed: %d %s", grantRORR.Code, grantRORR.Body.String())
	}

	// Verify bidirectional sync: GET /api/executions/unified-agents reflects cluster_modes["pg-ondemand-prod"] == "readonly".
	listAgentsRR := storeRequest(srv, "GET", "/api/executions/unified-agents", nil, cookie, "")
	var listAgents struct {
		Agents []unifiedAgentView `json:"agents"`
	}
	_ = json.Unmarshal(listAgentsRR.Body.Bytes(), &listAgents)
	if len(listAgents.Agents) != 1 || listAgents.Agents[0].ClusterModes["pg-ondemand-prod"] != "readonly" {
		t.Fatalf("expected unified agent cluster_modes readonly, got %+v", listAgents.Agents)
	}

	// 5. With "readonly", read-only baseline probe SUCCEEDS without any pre-wizard enabled flag!
	roProbeRR := storeRequest(srv, "POST", "/api/clusters/pg-ondemand-prod/automation/probe", strings.NewReader(`{"script":"#!/usr/bin/env bash\nhostname\n","agent_id":"`+enrolled.Agent.ID+`","ssh_user":"ops","ssh_port":2222}`), cookie, csrf)
	if roProbeRR.Code != 201 {
		t.Fatalf("expected 201 for readonly probe, got %d %s", roProbeRR.Code, roProbeRR.Body.String())
	}

	// Complete probe task so cluster lock is clean, and prepare a mutating rehearsal step.
	rh := changeRehearsal{
		ID:        "b1b2c3d4e5f6",
		ClusterID: "pg-ondemand-prod",
		AppID:     "postgresql",
		AppName:   "PostgreSQL",
		Title:     "Reload PG",
		Goal:      "Reload PG",
		Stage:     "rehearsing",
		Steps: []rehearsalStep{
			{
				ID:         "step-mut-1",
				Phase:      "execute",
				Order:      1,
				Title:      "Reload Service",
				TargetRole: "primary",
				Command:    "systemctl reload patroni",
				Expect:     "ok",
				Status:     "pending",
			},
		},
		CreatedAt: executionNow(),
		UpdatedAt: executionNow(),
	}
	if err := srv.saveRehearsal(rh); err != nil {
		t.Fatalf("saveRehearsal: %v", err)
	}
	ms, _ := fakeModel(t, "ok")
	enableAI(t, srv, ms.URL, 1)

	// 6. Mutating step MUST fail with 403 while Agent is only granted "readonly"!
	mutBlockedRR := storeRequest(srv, "POST", "/api/clusters/pg-ondemand-prod/rehearsals/"+rh.ID+"/exec/step", strings.NewReader(`{"step_id":"step-mut-1","agent_id":"`+enrolled.Agent.ID+`","targets":[{"host":"db-01","ip":"10.30.0.11"}]}`), cookie, csrf)
	if mutBlockedRR.Code != 403 {
		t.Fatalf("expected 403 for mutating step on readonly agent, got %d %s", mutBlockedRR.Code, mutBlockedRR.Body.String())
	}

	// 7. Upgrade Agent to "readwrite" via PATCH /api/executions/unified-agents -> mutating step SUCCEEDS!
	upgradeRWRR := storeRequest(srv, "PATCH", "/api/executions/unified-agents", strings.NewReader(`{"id":"`+enrolled.Agent.ID+`","set_cluster":{"cluster_id":"pg-ondemand-prod","mode":"readwrite"}}`), cookie, csrf)
	if upgradeRWRR.Code != 200 {
		t.Fatalf("upgrade to readwrite failed: %d %s", upgradeRWRR.Code, upgradeRWRR.Body.String())
	}

	mutOKRR := storeRequest(srv, "POST", "/api/clusters/pg-ondemand-prod/rehearsals/"+rh.ID+"/exec/step", strings.NewReader(`{"step_id":"step-mut-1","agent_id":"`+enrolled.Agent.ID+`","targets":[{"host":"db-01","ip":"10.30.0.11"}]}`), cookie, csrf)
	if mutOKRR.Code != 201 {
		t.Fatalf("expected 201 for mutating step on readwrite agent, got %d %s", mutOKRR.Code, mutOKRR.Body.String())
	}

	// Verify cluster summary remembers last_agent_id and ssh preferences!
	sumRR := storeRequest(srv, "GET", "/api/clusters/pg-ondemand-prod/automation", nil, cookie, "")
	var sum struct {
		Ready       bool               `json:"ready"`
		LastAgentID string             `json:"last_agent_id"`
		Config      clusterAutomationConfig `json:"config"`
		Unified     []unifiedAgentView `json:"unified_agents"`
	}
	_ = json.Unmarshal(sumRR.Body.Bytes(), &sum)
	if !sum.Ready || sum.LastAgentID != enrolled.Agent.ID || sum.Config.SSHUser != "ops" || sum.Config.SSHPort != 2222 || len(sum.Unified) != 1 {
		t.Fatalf("unexpected automation summary: %+v", sum)
	}

	// 8. Globally disabling Agent blocks new on-demand tasks with 409!
	disRR := storeRequest(srv, "PATCH", "/api/executions/unified-agents", strings.NewReader(`{"id":"`+enrolled.Agent.ID+`","disabled":true}`), cookie, csrf)
	if disRR.Code != 200 {
		t.Fatalf("disable unified agent failed: %d %s", disRR.Code, disRR.Body.String())
	}
	disProbeRR := storeRequest(srv, "POST", "/api/clusters/pg-ondemand-prod/automation/probe", strings.NewReader(`{"script":"#!/usr/bin/env bash\nhostname\n","agent_id":"`+enrolled.Agent.ID+`"}`), cookie, csrf)
	if disProbeRR.Code != 409 {
		t.Fatalf("expected 409 when agent is disabled, got %d %s", disProbeRR.Code, disProbeRR.Body.String())
	}
}

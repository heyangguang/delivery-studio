package server

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRehearsalAutomationDualTransportAndSafetyGates(t *testing.T) {
	srv, _ := testStore(t)
	cookie, csrf := storeLogin(t, srv, "admin")

	// Import a minimal existing PostgreSQL cluster so both imported and delivered clusters are exercised.
	importBody := `{
		"id": "pg-auto-prod",
		"component": "postgresql",
		"display_name": "PostgreSQL",
		"version": "17",
		"exact_version": "17.11",
		"platform": "ubuntu2404",
		"deploy_method": "systemd",
		"hosts": [
			{"name": "db-node-01", "ip": "10.10.0.11", "role": "primary"},
			{"name": "db-node-02", "ip": "10.10.0.12", "role": "replica"}
		]
	}`
	rr := storeRequest(srv, "POST", "/api/clusters/import", strings.NewReader(importBody), cookie, csrf)
	if rr.Code != 200 && rr.Code != 201 {
		t.Fatalf("import cluster failed: %d %s", rr.Code, rr.Body.String())
	}

	// Verify RBAC route registration on automation & rehearsal exec endpoints.
	if p, ok := routePermFor("GET", "/api/clusters/pg-auto-prod/automation"); !ok || p != "delivery.view" {
		t.Fatalf("expected delivery.view for GET automation, got %q %v", p, ok)
	}
	if p, ok := routePermFor("PUT", "/api/clusters/pg-auto-prod/automation"); !ok || p != "delivery.execute|execution.manage" {
		t.Fatalf("expected delivery.execute|execution.manage for PUT automation, got %q %v", p, ok)
	}
	if p, ok := routePermFor("POST", "/api/clusters/pg-auto-prod/rehearsals/abcdef012345/exec/step"); !ok || p != "delivery.execute" {
		t.Fatalf("expected delivery.execute for rehearsal exec/step, got %q %v", p, ok)
	}

	// 1. Register an execution-node (Controller SSH/Ansible path), heartbeat as Protocol v3, and authorize rehearsal capability.
	nodeRR := storeRequest(srv, "POST", "/api/settings/execution-nodes", strings.NewReader(`{"name":"ctrl-01","kind":"independent","controller_ip":"10.10.0.5"}`), cookie, csrf)
	if nodeRR.Code != 201 {
		t.Fatalf("create node failed: %d %s", nodeRR.Code, nodeRR.Body.String())
	}
	var nodeCreate struct {
		Node  executionNode `json:"node"`
		Token string        `json:"token"`
	}
	_ = json.Unmarshal(nodeRR.Body.Bytes(), &nodeCreate)

	// Poll once as Protocol v3 so the node goes online.
	agentCall := func(path, bearer string, body []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8090"+path, bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+bearer)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, r)
		return w
	}
	pollRR := agentCall("/api/execution-agent/poll", nodeCreate.Token, []byte(`{"protocol":3,"version":"1.0.0","heartbeat":true}`))
	if pollRR.Code != 200 {
		t.Fatalf("node heartbeat failed: %d %s", pollRR.Code, pollRR.Body.String())
	}

	// Enable node rehearsal capability via PATCH.
	patchNodeRR := storeRequest(srv, "PATCH", "/api/settings/execution-nodes", strings.NewReader(`{"id":"`+nodeCreate.Node.ID+`","allow_rehearsal":true,"allow_probe":true}`), cookie, csrf)
	if patchNodeRR.Code != 200 {
		t.Fatalf("patch node capabilities failed: %d %s", patchNodeRR.Code, patchNodeRR.Body.String())
	}

	// Configure cluster automation in "node" mode (prod, allow_prod_mutate=true).
	cfgBody := `{
		"enabled": true,
		"transport": "node",
		"node_id": "` + nodeCreate.Node.ID + `",
		"node_exec_method": "ansible",
		"ssh_user": "root",
		"ssh_port": 22,
		"env_kind": "prod",
		"default_pacing": "ai_gated_auto",
		"pause_before_mutate": true,
		"allow_prod_mutate": true
	}`
	cfgRR := storeRequest(srv, "PUT", "/api/clusters/pg-auto-prod/automation", strings.NewReader(cfgBody), cookie, csrf)
	if cfgRR.Code != 200 {
		t.Fatalf("save cluster automation failed: %d %s", cfgRR.Code, cfgRR.Body.String())
	}

	// 2. Verify Static Read-Only Safety Gate rejects mutating script on /automation/probe.
	badProbeRR := storeRequest(srv, "POST", "/api/clusters/pg-auto-prod/automation/probe", strings.NewReader(`{"script":"#!/usr/bin/env bash\nsystemctl restart postgresql\n"}`), cookie, csrf)
	if badProbeRR.Code != 403 {
		t.Fatalf("expected 403 for mutating probe, got %d %s", badProbeRR.Code, badProbeRR.Body.String())
	}

	// 3. Enqueue valid read-only probe -> node polls -> node streams redacted output -> task succeeds!
	okProbeRR := storeRequest(srv, "POST", "/api/clusters/pg-auto-prod/automation/probe", strings.NewReader(`{"script":"#!/usr/bin/env bash\nhostname\n"}`), cookie, csrf)
	if okProbeRR.Code != 201 {
		t.Fatalf("enqueue read-only probe failed: %d %s", okProbeRR.Code, okProbeRR.Body.String())
	}
	var task rehearsalExecTask
	_ = json.Unmarshal(okProbeRR.Body.Bytes(), &task)
	if task.Transport != "node" || len(task.Targets) != 2 || !task.ReadOnly {
		t.Fatalf("unexpected task shape: %+v", task)
	}

	poll2RR := agentCall("/api/execution-agent/poll", nodeCreate.Token, []byte(`{"protocol":3,"version":"1.0.0"}`))
	var pollResp struct {
		RehearsalTask *rehearsalExecDispatch `json:"rehearsal_task"`
	}
	_ = json.Unmarshal(poll2RR.Body.Bytes(), &pollResp)
	if pollResp.RehearsalTask == nil || pollResp.RehearsalTask.TaskID != task.ID {
		t.Fatalf("expected node to lease rehearsal task %s, got %s", task.ID, poll2RR.Body.String())
	}
	if err := verifyRehearsalDispatchSecurity(*pollResp.RehearsalTask); err != nil {
		t.Fatalf("runner security check unexpectedly failed: %v", err)
	}

	// Report events for both hosts including secret text that must be redacted.
	zero := 0
	for idx, tg := range task.Targets {
		for _, ev := range []rehearsalExecEvent{
			{TaskID: task.ID, TargetIndex: idx, Host: tg.Host, IP: tg.IP, Seq: 1, Kind: "started"},
			{TaskID: task.ID, TargetIndex: idx, Host: tg.Host, IP: tg.IP, Seq: 2, Kind: "log", Text: "HOST=" + tg.Host + " PGPASSWORD=supersecretpassword\n"},
			{TaskID: task.ID, TargetIndex: idx, Host: tg.Host, IP: tg.IP, Seq: 3, Kind: "finished", ExitCode: &zero},
		} {
			raw, _ := json.Marshal(ev)
			evRR := agentCall("/api/execution-agent/rehearsal-event", nodeCreate.Token, raw)
			if evRR.Code != 200 {
				t.Fatalf("node event failed: %d %s", evRR.Code, evRR.Body.String())
			}
		}
	}

	// Verify task reached succeeded and password was redacted.
	getTaskRR := storeRequest(srv, "GET", "/api/clusters/pg-auto-prod/automation/tasks/"+task.ID, nil, cookie, "")
	var finishedTask rehearsalExecTask
	_ = json.Unmarshal(getTaskRR.Body.Bytes(), &finishedTask)
	if finishedTask.State != "succeeded" {
		t.Fatalf("expected task succeeded, got %s", finishedTask.State)
	}
	if strings.Contains(finishedTask.CombinedOutput, "supersecretpassword") || !strings.Contains(finishedTask.CombinedOutput, "[REDACTED]") {
		t.Fatalf("secret redaction failed: %s", finishedTask.CombinedOutput)
	}

	// 4. Test Direct Target Agent transport (no SSH, no password, no control host!).
	enrRR := storeRequest(srv, "POST", "/api/clusters/pg-auto-prod/automation/agents", strings.NewReader(`{"host":"db-node-01","ip":"10.10.0.11","allow_mutating":true}`), cookie, csrf)
	if enrRR.Code != 201 {
		t.Fatalf("enroll direct target agent failed: %d %s", enrRR.Code, enrRR.Body.String())
	}
	var enrResp struct {
		Agent           targetAgent `json:"agent"`
		EnrollmentToken string      `json:"enrollment_token"`
	}
	_ = json.Unmarshal(enrRR.Body.Bytes(), &enrResp)
	if enrResp.Agent.Mode != "direct" || len(enrResp.EnrollmentToken) < 40 {
		t.Fatalf("unexpected direct agent enrollment: %+v", enrResp)
	}

	// Simulate target-agent enrolling and polling directly.
	agentToken := randomStoreToken(32)
	machineID := digest([]byte("test-machine-db-01"))
	agEnrollBody, _ := json.Marshal(map[string]any{
		"id":         enrResp.Agent.ID,
		"machine_id": machineID,
		"hostname":   "db-node-01",
		"ips":        []string{"10.10.0.11"},
		"token":      agentToken,
	})
	agEnrollRR := agentCall("/api/target-agent/enroll", enrResp.EnrollmentToken, agEnrollBody)
	if agEnrollRR.Code != 200 {
		t.Fatalf("direct agent enroll failed: %d %s", agEnrollRR.Code, agEnrollRR.Body.String())
	}

	// Switch cluster automation to Direct Target Agent mode.
	cfgAgentRR := storeRequest(srv, "PUT", "/api/clusters/pg-auto-prod/automation", strings.NewReader(`{"enabled":true,"transport":"agent","env_kind":"prod","default_pacing":"ai_gated_auto","allow_prod_mutate":true}`), cookie, csrf)
	if cfgAgentRR.Code != 200 {
		t.Fatalf("switch to agent transport failed: %d %s", cfgAgentRR.Code, cfgAgentRR.Body.String())
	}

	// Create a rehearsal with a mutating step and test prod confirm_cluster guard + direct agent execution!
	rh := changeRehearsal{
		ID:        "a1b2c3d4e5f6",
		ClusterID: "pg-auto-prod",
		AppID:     "postgresql",
		AppName:   "PostgreSQL",
		Title:     "Test Param Change",
		Goal:      "Update work_mem",
		Stage:     "rehearsing",
		Steps: []rehearsalStep{
			{
				ID:         "step-1",
				Phase:      "execute",
				Order:      1,
				Title:      "Reload PG Config",
				TargetRole: "primary",
				Command:    "systemctl reload patroni",
				Expect:     "reload ok",
				Status:     "pending",
			},
		},
		CreatedAt: executionNow(),
		UpdatedAt: executionNow(),
	}
	if err := srv.saveRehearsal(rh); err != nil {
		t.Fatalf("save rehearsal failed: %v", err)
	}

	// Enable AI master switch with fake model helper so /rehearsals routes accept execution calls.
	ms, _ := fakeModel(t, "ok")
	enableAI(t, srv, ms.URL, 1)

	// Missing confirm_cluster in prod must be rejected with 400!
	noConfirmRR := storeRequest(srv, "POST", "/api/clusters/pg-auto-prod/rehearsals/"+rh.ID+"/exec/step", strings.NewReader(`{"step_id":"step-1","targets":[{"host":"db-node-01","ip":"10.10.0.11","role":"primary"}]}`), cookie, csrf)
	if noConfirmRR.Code != 400 {
		t.Fatalf("expected 400 without prod confirm_cluster, got %d %s", noConfirmRR.Code, noConfirmRR.Body.String())
	}

	// With confirm_cluster, task enqueues cleanly on direct target agent!
	execStepRR := storeRequest(srv, "POST", "/api/clusters/pg-auto-prod/rehearsals/"+rh.ID+"/exec/step", strings.NewReader(`{"step_id":"step-1","confirm_cluster":"pg-auto-prod","targets":[{"host":"db-node-01","ip":"10.10.0.11","role":"primary"}]}`), cookie, csrf)
	if execStepRR.Code != 201 {
		t.Fatalf("enqueue rehearsal step via direct agent failed: %d %s", execStepRR.Code, execStepRR.Body.String())
	}
	var stepTask rehearsalExecTask
	_ = json.Unmarshal(execStepRR.Body.Bytes(), &stepTask)
	if stepTask.Transport != "agent" || stepTask.ReadOnly || len(stepTask.Targets) != 1 || stepTask.Targets[0].AgentID != enrResp.Agent.ID {
		t.Fatalf("unexpected direct agent step task: %+v", stepTask)
	}

	// Direct agent polls and leases the task!
	agPollBody, _ := json.Marshal(map[string]any{
		"machine_id":   machineID,
		"version":      "1.0.0",
		"capabilities": []string{"ssh_trust", "rehearsal_exec"},
	})
	agPollRR := agentCall("/api/target-agent/poll", agentToken, agPollBody)
	if agPollRR.Code != 200 {
		t.Fatalf("direct agent poll failed: %d %s", agPollRR.Code, agPollRR.Body.String())
	}
	var agInst targetAgentInstruction
	_ = json.Unmarshal(agPollRR.Body.Bytes(), &agInst)
	if agInst.Mode != "direct" || agInst.Task == nil || agInst.Task.TaskID != stepTask.ID {
		t.Fatalf("expected direct agent to receive task %s, got %s", stepTask.ID, agPollRR.Body.String())
	}

	// Direct agent reports started + log + finished via /api/target-agent/event!
	for _, ev := range []rehearsalExecEvent{
		{TaskID: stepTask.ID, TargetIndex: 0, Host: "db-node-01", IP: "10.10.0.11", Seq: 1, Kind: "started"},
		{TaskID: stepTask.ID, TargetIndex: 0, Host: "db-node-01", IP: "10.10.0.11", Seq: 2, Kind: "log", Text: "reloaded patroni successfully\n"},
		{TaskID: stepTask.ID, TargetIndex: 0, Host: "db-node-01", IP: "10.10.0.11", Seq: 3, Kind: "finished", ExitCode: &zero},
	} {
		evPayload, _ := json.Marshal(map[string]any{"machine_id": machineID, "event": ev})
		agEvRR := agentCall("/api/target-agent/event", agentToken, evPayload)
		if agEvRR.Code != 200 {
			t.Fatalf("direct agent event failed: %d %s", agEvRR.Code, agEvRR.Body.String())
		}
	}

	// Verify rehearsal task list contains the completed direct-agent run.
	listRR := storeRequest(srv, "GET", "/api/clusters/pg-auto-prod/rehearsals/"+rh.ID+"/exec/tasks", nil, cookie, "")
	var rhTasks []rehearsalExecTask
	_ = json.Unmarshal(listRR.Body.Bytes(), &rhTasks)
	if len(rhTasks) != 1 || rhTasks[0].State != "succeeded" || !strings.Contains(rhTasks[0].CombinedOutput, "reloaded patroni successfully") {
		t.Fatalf("unexpected rehearsal tasks list: %s", listRR.Body.String())
	}
}

func TestClusterAutomationCheckUsesDraftOverridesWhileDisabled(t *testing.T) {
	srv, _ := testStore(t)
	cookie, csrf := storeLogin(t, srv, "admin")

	importBody := `{
		"id": "pg-draft-check",
		"component": "postgresql",
		"display_name": "PostgreSQL",
		"version": "17",
		"exact_version": "17.11",
		"platform": "ubuntu2404",
		"deploy_method": "systemd",
		"hosts": [{"name": "db-01", "ip": "10.20.0.11", "role": "primary"}]
	}`
	rr := storeRequest(srv, "POST", "/api/clusters/import", strings.NewReader(importBody), cookie, csrf)
	if rr.Code != 200 && rr.Code != 201 {
		t.Fatalf("import cluster failed: %d %s", rr.Code, rr.Body.String())
	}

	nodeRR := storeRequest(srv, "POST", "/api/settings/execution-nodes", strings.NewReader(`{"name":"ctrl-draft","kind":"independent","controller_ip":"10.20.0.5"}`), cookie, csrf)
	if nodeRR.Code != 201 {
		t.Fatalf("create node failed: %d %s", nodeRR.Code, nodeRR.Body.String())
	}
	var nodeCreate struct {
		Node  executionNode `json:"node"`
		Token string        `json:"token"`
	}
	_ = json.Unmarshal(nodeRR.Body.Bytes(), &nodeCreate)

	// Heartbeat node as Protocol v3.
	r := httptest.NewRequest("POST", "http://127.0.0.1:8090/api/execution-agent/poll", bytes.NewReader([]byte(`{"protocol":3,"version":"1.0.0","heartbeat":true}`)))
	r.Header.Set("Authorization", "Bearer "+nodeCreate.Token)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("node heartbeat failed: %d %s", w.Code, w.Body.String())
	}

	// Automation is still disabled (wizard Step 2), yet /automation/check must apply draft SSH/method overrides.
	checkBody := `{
		"transport": "node",
		"node_id": "` + nodeCreate.Node.ID + `",
		"node_exec_method": "ssh",
		"ssh_user": "postgres",
		"ssh_port": 2222
	}`
	checkRR := storeRequest(srv, "POST", "/api/clusters/pg-draft-check/automation/check", strings.NewReader(checkBody), cookie, csrf)
	if checkRR.Code != 201 {
		t.Fatalf("expected 201 for draft connectivity check, got %d %s", checkRR.Code, checkRR.Body.String())
	}
	var task rehearsalExecTask
	_ = json.Unmarshal(checkRR.Body.Bytes(), &task)
	if task.NodeExecMethod != "ssh" || task.SSHUser != "postgres" || task.SSHPort != 2222 {
		t.Fatalf("expected draft overrides (ssh/postgres/2222), got method=%q user=%q port=%d", task.NodeExecMethod, task.SSHUser, task.SSHPort)
	}

	// Invalid SSH user or port in draft override must be rejected with 400.
	badUserRR := storeRequest(srv, "POST", "/api/clusters/pg-draft-check/automation/check", strings.NewReader(`{"transport":"node","node_id":"`+nodeCreate.Node.ID+`","ssh_user":"root;rm -rf /"}`), cookie, csrf)
	if badUserRR.Code != 400 {
		t.Fatalf("expected 400 for unsafe ssh_user override, got %d %s", badUserRR.Code, badUserRR.Body.String())
	}
	badPortRR := storeRequest(srv, "POST", "/api/clusters/pg-draft-check/automation/check", strings.NewReader(`{"transport":"node","node_id":"`+nodeCreate.Node.ID+`","ssh_port":70000}`), cookie, csrf)
	if badPortRR.Code != 400 {
		t.Fatalf("expected 400 for invalid ssh_port override, got %d %s", badPortRR.Code, badPortRR.Body.String())
	}
}

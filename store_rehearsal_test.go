package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"middleware-deployer/mwpack"
)

func TestAIMasterSwitchToggleAndIsolation(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	admin, acsrf := storeLogin(t, s, "admin")

	w := storeCreate(t, s, alice, csrf, `{"id":"etcd-sw","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	var job storeJob
	if err := json.Unmarshal(w.Body.Bytes(), &job); err != nil || w.Code != 202 {
		t.Fatalf("create job: %d %s", w.Code, w.Body.String())
	}

	// 1. Default state: AI master switch is OFF, unconfigured, zero features exposed.
	w = storeRequest(s, "GET", "/api/ai/status", nil, alice, "")
	var st aiStatus
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil || w.Code != 200 {
		t.Fatalf("status: %d %s", w.Code, w.Body.String())
	}
	if st.Enabled || st.MasterEnabled || st.Configured || len(st.Features) != 0 {
		t.Fatalf("expected clean Scheme-1 initial status, got %+v", st)
	}

	// 2. Non-admin cannot toggle the global AI switch.
	w = storeRequest(s, "POST", "/api/ai/toggle", strings.NewReader(`{"enabled":true}`), alice, csrf)
	if w.Code != 403 {
		t.Fatalf("expected 403 for non-admin toggle, got %d %s", w.Code, w.Body.String())
	}

	// 3. Admin flips master_enabled ON before configuring any model provider -> master_enabled=true, configured=false, enabled=false.
	w = storeRequest(s, "POST", "/api/ai/toggle", strings.NewReader(`{"enabled":true}`), admin, acsrf)
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil || w.Code != 200 {
		t.Fatalf("admin toggle on without provider: %d %s", w.Code, w.Body.String())
	}
	if !st.MasterEnabled || st.Configured || st.Enabled {
		t.Fatalf("unexpected pre-provider status: %+v", st)
	}

	// 4. Configure a provider -> enabled=true, configured=true, change_rehearsal=true.
	srv, _ := fakeModel(t, "你好")
	enableAI(t, s, srv.URL, 1)
	w = storeRequest(s, "GET", "/api/ai/status", nil, alice, "")
	st = aiStatus{}
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	if !st.Enabled || !st.MasterEnabled || !st.Configured || !st.Features["change_rehearsal"] {
		t.Fatalf("expected AI active with change_rehearsal, got %+v", st)
	}

	// 5. Admin one-click toggles AI OFF -> provider stays configured, but enabled=false, features={}, models={}, AI endpoints return 409.
	w = storeRequest(s, "POST", "/api/ai/toggle", strings.NewReader(`{"enabled":false}`), admin, acsrf)
	st = aiStatus{}
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil || w.Code != 200 {
		t.Fatalf("admin toggle off: %d %s", w.Code, w.Body.String())
	}
	if st.Enabled || st.MasterEnabled || !st.Configured || len(st.Features) != 0 {
		t.Fatalf("expected AI cleanly gated when OFF, got %+v", st)
	}

	w = storeRequest(s, "GET", "/api/ai/models", nil, alice, "")
	var modelsResp struct {
		Models   []any             `json:"models"`
		Defaults map[string]string `json:"defaults"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &modelsResp)
	if len(modelsResp.Models) != 0 || len(modelsResp.Defaults) != 0 {
		t.Fatalf("expected empty models when AI is OFF, got %s", w.Body.String())
	}

	if w = storeRequest(s, "POST", "/api/clusters/etcd-sw/rehearsals", strings.NewReader(`{"goal":"滚动调整参数并验证集群健康"}`), alice, csrf); w.Code != 409 {
		t.Fatalf("expected 409 creating rehearsal when AI is OFF, got %d %s", w.Code, w.Body.String())
	}
	if w = storeRequest(s, "POST", "/api/ai/chats/0123456789ab/chat", strings.NewReader(`{"message":"hi"}`), alice, csrf); w.Code != 409 {
		t.Fatalf("expected 409 on assistant chat when AI is OFF, got %d %s", w.Code, w.Body.String())
	}

	// 6. Admin one-click toggles AI back ON -> immediately active again without re-entering provider keys.
	w = storeRequest(s, "POST", "/api/ai/toggle", strings.NewReader(`{"enabled":true}`), admin, acsrf)
	st = aiStatus{}
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	if w.Code != 200 || !st.Enabled || !st.MasterEnabled || !st.Configured || !st.Features["change_rehearsal"] {
		t.Fatalf("expected immediate re-activation on toggle ON, got %d %+v", w.Code, st)
	}
}

func TestValidateReadOnlyProbeScript(t *testing.T) {
	safeScripts := []string{
		"#!/usr/bin/env bash\nset -uo pipefail\n# rm -rf / should be ignored inside comments\nhostname\nip -br addr 2>/dev/null\ndf -h >/dev/null 2>&1\nfree -m\nsystemctl status etcd --no-pager\netcdctl endpoint status --cluster -w table 2>/dev/null\n",
		"#!/bin/bash\npatronictl -c /etc/patroni/patroni.yml list\npsql -U postgres -Atc \"SELECT pg_is_in_recovery(), current_setting('max_connections');\" 2>/dev/null\nredis-cli -p 6379 info replication\n",
		"#!/usr/bin/env bash\nawk -F= '$3 > 0 {print $1 \" => \" $2}' /etc/os-release\nif [[ \"$lag\" > 0 ]] || (( count > 1 )); then echo '[WARN] lag > 0'; fi\n",
	}
	for i, sc := range safeScripts {
		safe, warns := validateReadOnlyProbeScript(sc)
		if !safe || len(warns) > 0 {
			t.Fatalf("safe script #%d flagged unexpectedly: %v", i, warns)
		}
	}

	badScripts := []struct {
		name   string
		script string
	}{
		{"empty", "   \n  "},
		{"rm", "df -h\nrm -rf /tmp/probe_cache\n"},
		{"sed-inplace", "sed -i 's/max_connections = 100/max_connections = 200/' /data/pg/postgresql.conf"},
		{"systemctl-restart", "systemctl restart postgresql"},
		{"patroni-switchover", "patronictl -c /etc/patroni.yml switchover --force"},
		{"etcd-member-remove", "etcdctl member remove 8e9e05c52164694d"},
		{"redis-config-set", "redis-cli config set maxmemory 4gb"},
		{"sql-alter", `psql -c "ALTER SYSTEM SET work_mem = '64MB';"`},
		{"file-redirect", "etcdctl endpoint health > /tmp/etcd_health.txt"},
		{"subshell-redirect", `bash -c "etcdctl endpoint health > /tmp/etcd_health.txt"`},
	}
	for _, tc := range badScripts {
		safe, warns := validateReadOnlyProbeScript(tc.script)
		if safe || len(warns) == 0 {
			t.Errorf("expected mutating script %q to fail read-only check, got safe=%v warns=%v", tc.name, safe, warns)
		}
	}
}

func TestGuidedChangeRehearsalEndToEnd(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")

	spec := `{"id":"etcd-rh","hosts":[{"name":"n1","ip":"10.0.1.11"},{"name":"n2","ip":"10.0.1.12"},{"name":"n3","ip":"10.0.1.13"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1","n2","n3"]}}]}`
	w := storeCreate(t, s, alice, csrf, spec, nil)
	s.wg.Wait()
	var job storeJob
	if err := json.Unmarshal(w.Body.Bytes(), &job); err != nil || w.Code != 202 {
		t.Fatalf("create cluster: %d %s", w.Code, w.Body.String())
	}
	if w = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done","note":"首次离线部署验收通过"}`), alice, csrf); w.Code != 200 {
		t.Fatalf("mark job done: %d %s", w.Code, w.Body.String())
	}

	scopeReply := `{
		"title": "etcd 集群配额参数滚动调优演练",
		"scope_summary": "低峰期按先从节点后 Leader 节点顺序滚动调整 quota-backend-bytes 至 8GB",
		"questions": [
			{"id":"q1","question":"可接受的变更维护窗口？","options":["凌晨低峰期滚动变更","周末停机窗口"]},
			{"id":"q2","question":"测试演练环境拓扑规模？","options":["同构 3 节点虚拟机","单节点功能验证"]}
		]
	}`
	probeReply := `{
		"probe_script": "#!/usr/bin/env bash\nset -uo pipefail\necho '=== ETCD ENDPOINT STATUS ==='\netcdctl endpoint status --cluster -w table 2>/dev/null\ngrep -v -iE 'password|token|secret' /etc/etcd/etcd.conf.yml 2>/dev/null || true",
		"probe_notes": ["在任意一台 etcd 节点以只读方式执行，不会修改任何配置或触发切主"]
	}`
	planReply := `{
		"drift": {
			"summary": "生产集群当前 Leader 已漂移至 n2 (10.0.1.12)，且人工调大过 heartbeat-interval。",
			"drifted": true,
			"hosts": [
				{"name":"n1","ip":"10.0.1.11","initial_role":"member (初始引导首节点)","actual_role":"Follower","version":"3.5.15","status":"healthy"},
				{"name":"n2","ip":"10.0.1.12","initial_role":"member","actual_role":"Leader","version":"3.5.15","status":"healthy"},
				{"name":"n3","ip":"10.0.1.13","initial_role":"member","actual_role":"Follower","version":"3.5.15","status":"healthy"}
			],
			"param_diffs": [
				{"key":"heartbeat-interval","initial":"100ms","actual":"250ms","risk":"变更重启时需保留现场 250ms 配置，避免覆盖回默认值引发频繁选举"}
			],
			"risks": ["禁止直接在当前 Leader n2 上首个重启，应先在 n1、n3 滚动验证"],
			"recommendations": ["最后变更 n2 前先执行 etcdctl move-leader 平滑移交 Leader"]
		},
		"steps": [
			{
				"id": "s1",
				"phase": "precheck",
				"order": 1,
				"title": "核查集群健康与当前 Leader 节点",
				"target_role": "任意节点 (n1 / 10.0.1.11)",
				"command": "etcdctl endpoint health --cluster && etcdctl endpoint status --cluster -w table",
				"expect": "3 个节点全部 healthy，确认当前 Leader ID",
				"optional": false
			},
			{
				"id": "s2",
				"phase": "execute",
				"order": 2,
				"title": "在 Follower 节点更新配额参数并重启服务",
				"target_role": "Follower 节点 (n1 10.0.1.11, n3 10.0.1.13)",
				"command": "sed -i 's/quota-backend-bytes:.*/quota-backend-bytes: 8589934592/' /etc/etcd/etcd.conf && systemctl restart etcd",
				"expect": "etcd 服务 active (running) 且重新追平 Raft 日志",
				"risk_note": "逐台执行，确认前一台 healthy 后再操作下一台",
				"rollback": "cp /etc/etcd/etcd.conf.yml.bak /etc/etcd/etcd.conf.yml && systemctl restart etcd",
				"optional": false
			},
			{
				"id": "s3",
				"phase": "verify",
				"order": 3,
				"title": "验证全集群配额生效与读写健康",
				"target_role": "全集群 (10.0.1.11, 10.0.1.12, 10.0.1.13)",
				"command": "etcdctl endpoint status --cluster -w table",
				"expect": "全部节点 healthy，无告警日志",
				"optional": false
			},
			{
				"id": "s4",
				"phase": "rollback",
				"order": 4,
				"title": "异常时回滚配置文件并按 Follower->Leader 顺序恢复",
				"target_role": "受影响节点",
				"command": "cp /etc/etcd/etcd.conf.yml.bak /etc/etcd/etcd.conf.yml && systemctl restart etcd",
				"expect": "集群恢复变更前配置且全员 healthy",
				"optional": true
			}
		]
	}`
	troubleReplaceReply := `{
		"diagnosis": "离线包默认配置文件路径为 /etc/etcd/etcd.conf.yml 而非 /etc/etcd/etcd.conf，且修改前需先保留原文件备份。",
		"action": "replace",
		"command": "cp -a /etc/etcd/etcd.conf.yml /etc/etcd/etcd.conf.yml.bak && sed -i 's/^quota-backend-bytes:.*/quota-backend-bytes: 8589934592/' /etc/etcd/etcd.conf.yml && systemctl restart etcd",
		"expect": "备份生成成功，etcd 重启后 active (running) 且 endpoint health 正常"
	}`

	srv, bodies := fakeModel(t, scopeReply, probeReply, planReply, troubleReplaceReply)
	enableAI(t, s, srv.URL, 1)

	// Step 1: Create rehearsal session -> scoping stage
	w = storeRequest(s, "POST", "/api/clusters/etcd-rh/rehearsals", strings.NewReader(`{"goal":"将生产 etcd 集群存储配额 quota-backend-bytes 在线滚动调大到 8GB"}`), alice, csrf)
	if w.Code != 201 {
		t.Fatalf("create rehearsal: %d %s", w.Code, w.Body.String())
	}
	var rh changeRehearsal
	_ = json.Unmarshal(w.Body.Bytes(), &rh)
	if rh.Stage != "scoping" || len(rh.ScopeQuestions) != 2 || rh.Title != "etcd 集群配额参数滚动调优演练" {
		t.Fatalf("unexpected scoping state: %+v", rh)
	}

	// Step 2: Submit scope answers -> generates validated read-only probe script (probing stage)
	scopePayload := `{"answers":[{"id":"q1","question":"可接受的变更维护窗口？","answer":"凌晨低峰期滚动变更"},{"id":"q2","question":"测试演练环境拓扑规模？","answer":"同构 3 节点虚拟机"}],"extra":"业务侧使用 clientv3 自动重连"}`
	w = storeRequest(s, "POST", "/api/clusters/etcd-rh/rehearsals/"+rh.ID+"/scope", strings.NewReader(scopePayload), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("submit scope: %d %s", w.Code, w.Body.String())
	}
	rh = changeRehearsal{}
	_ = json.Unmarshal(w.Body.Bytes(), &rh)
	if rh.Stage != "probing" || !rh.ProbeSafe || len(rh.ProbeWarnings) != 0 || !strings.Contains(rh.ProbeScript, "etcdctl endpoint status") {
		t.Fatalf("unexpected probing state: %+v", rh)
	}

	// Step 2b: Submit probe output containing a secret -> verify scrubbing + drift diagnosis + step list (rehearsing stage)
	probeInput := `{"probe_output":"10.0.1.11, follower\n10.0.1.12, leader\npassword=SuperSecretProdPwd999\nheartbeat-interval: 250","test_env_note":"测试环境 3 台 AlmaLinux 9 同版本虚拟机 (192.168.56.11~13)"}`
	w = storeRequest(s, "POST", "/api/clusters/etcd-rh/rehearsals/"+rh.ID+"/probe", strings.NewReader(probeInput), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("submit probe: %d %s", w.Code, w.Body.String())
	}
	rh = changeRehearsal{}
	_ = json.Unmarshal(w.Body.Bytes(), &rh)
	if rh.Stage != "rehearsing" || rh.Drift == nil || !rh.Drift.Drifted || len(rh.Steps) != 4 {
		t.Fatalf("unexpected rehearsing state: %+v", rh)
	}
	if strings.Contains(strings.Join(*bodies, "\n"), "SuperSecretProdPwd999") {
		t.Fatal("raw secret from probe_output leaked to LLM request body")
	}
	if strings.Contains(rh.ProbeOutput, "SuperSecretProdPwd999") {
		t.Fatal("raw secret from probe_output persisted un-scrubbed")
	}

	// Gate check: Finalizing before required steps pass must return 409.
	if w = storeRequest(s, "POST", "/api/clusters/etcd-rh/rehearsals/"+rh.ID+"/finalize", strings.NewReader(`{}`), alice, csrf); w.Code != 409 {
		t.Fatalf("expected 409 finalizing with pending steps, got %d %s", w.Code, w.Body.String())
	}

	// Step 3: Rehearse steps in test environment:
	// - Mark s1 passed
	w = storeRequest(s, "PATCH", "/api/clusters/etcd-rh/rehearsals/"+rh.ID+"/steps/s1", strings.NewReader(`{"status":"passed","elapsed":"4s","note":"测试集群 3 节点健康"}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("patch s1: %d %s", w.Code, w.Body.String())
	}
	// - s2 hits an error in test env -> AI troubleshoot -> apply proposal -> then mark s2 passed
	w = storeRequest(s, "POST", "/api/clusters/etcd-rh/rehearsals/"+rh.ID+"/steps/s2/troubleshoot", strings.NewReader(`{"error_output":"sed: can't read /etc/etcd/etcd.conf: No such file or directory"}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("troubleshoot s2: %d %s", w.Code, w.Body.String())
	}
	rh = changeRehearsal{}
	_ = json.Unmarshal(w.Body.Bytes(), &rh)
	if rh.Steps[1].Status != "failed" || rh.Steps[1].Proposal == nil || !strings.Contains(rh.Steps[1].Proposal.Command, "/etc/etcd/etcd.conf.yml") {
		t.Fatalf("expected proposal on s2, got %+v", rh.Steps[1])
	}
	w = storeRequest(s, "POST", "/api/clusters/etcd-rh/rehearsals/"+rh.ID+"/steps/s2/apply", nil, alice, csrf)
	if w.Code != 200 {
		t.Fatalf("apply proposal on s2: %d %s", w.Code, w.Body.String())
	}
	rh = changeRehearsal{}
	_ = json.Unmarshal(w.Body.Bytes(), &rh)
	if rh.Steps[1].Proposal != nil || len(rh.Steps[1].Revisions) != 1 || !strings.Contains(rh.Steps[1].Command, "/etc/etcd/etcd.conf.yml.bak") {
		t.Fatalf("proposal not applied cleanly: %+v", rh.Steps[1])
	}
	w = storeRequest(s, "PATCH", "/api/clusters/etcd-rh/rehearsals/"+rh.ID+"/steps/s2", strings.NewReader(`{"status":"passed","elapsed":"35s","note":"从节点平滑重启无报错，Raft 追平小于 1s"}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("patch s2 passed: %d %s", w.Code, w.Body.String())
	}
	// - Mark s3 passed
	w = storeRequest(s, "PATCH", "/api/clusters/etcd-rh/rehearsals/"+rh.ID+"/steps/s3", strings.NewReader(`{"status":"passed","elapsed":"5s"}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("patch s3 passed: %d %s", w.Code, w.Body.String())
	}

	// Step 4: Finalize Production Change SOP
	w = storeRequest(s, "POST", "/api/clusters/etcd-rh/rehearsals/"+rh.ID+"/finalize", strings.NewReader(`{}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("finalize rehearsal: %d %s", w.Code, w.Body.String())
	}
	rh = changeRehearsal{}
	_ = json.Unmarshal(w.Body.Bytes(), &rh)
	docID := "sop-" + rh.ID
	if rh.Stage != "finalized" || rh.DocID != docID {
		t.Fatalf("unexpected finalized rehearsal: %+v", rh)
	}

	// Verify SOP appears in cluster documents list and renders real production topology + rehearsed commands + elapsed/notes.
	w = storeRequest(s, "GET", "/api/clusters/etcd-rh/docs", nil, alice, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), docID) {
		t.Fatalf("expected %s in cluster docs list: %d %s", docID, w.Code, w.Body.String())
	}
	w = storeRequest(s, "GET", "/api/clusters/etcd-rh/docs/"+docID, nil, alice, "")
	if w.Code != 200 {
		t.Fatalf("get SOP doc: %d %s", w.Code, w.Body.String())
	}
	sopJSON := w.Body.String()
	for _, want := range []string{
		"生产变更实施方案",
		"10.0.1.12",
		"Leader",
		"heartbeat-interval",
		"/etc/etcd/etcd.conf.yml.bak",
		"35s",
		"从节点平滑重启无报错",
		"应急回退预案",
	} {
		if !strings.Contains(sopJSON, want) {
			t.Errorf("SOP document missing expected content %q", want)
		}
	}

	// Verify Word (.docx) export of the finalized SOP document produces well-formed OOXML containing the SOP content.
	w = storeRequest(s, "GET", "/api/clusters/etcd-rh/export?docs="+docID, nil, alice, "")
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Disposition"), ".docx") {
		t.Fatalf("export SOP docx: %d %s", w.Code, w.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatalf("invalid docx zip: %v", err)
	}
	var wordXML string
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		if strings.HasSuffix(f.Name, ".xml") || strings.HasSuffix(f.Name, ".rels") {
			dec := xml.NewDecoder(bytes.NewReader(b))
			for {
				if _, err := dec.Token(); err != nil {
					if err != io.EOF {
						t.Fatalf("%s malformed xml: %v", f.Name, err)
					}
					break
				}
			}
		}
		if f.Name == "word/document.xml" {
			wordXML = string(b)
		}
	}
	for _, want := range []string{"生产变更实施方案", "etcd 集群配额参数滚动调优演练", "10.0.1.12", "etcd.conf.yml.bak"} {
		if !strings.Contains(wordXML, want) {
			t.Errorf("exported word/document.xml missing %q", want)
		}
	}
}

func TestSavedDeploymentLegacyCompat(t *testing.T) {
	legacyYAML := []byte(`id: smart-redis-prod
platform: ubuntu-24.04
hosts:
  - name: node-1
    ip: 172.30.6.105
  - name: node-2
    ip: 172.30.6.124
  - name: node-3
    ip: 172.30.6.115
instances:
  - id: redis
    component: redis
    version: "7.2"
    placement:
      master: [node-1]
      replica: [node-2, node-3]
change: null
pins: {}
`)
	// Strict new-submission parser still rejects retired fields.
	if _, err := mwpack.ParseDeployment(legacyYAML); err == nil {
		t.Fatal("expected strict ParseDeployment to reject legacy change/pins fields")
	}
	// Historical on-disk reader strips retired fields cleanly and preserves hosts/platform/version.
	dep, err := mwpack.ParseSavedDeployment(legacyYAML)
	if err != nil {
		t.Fatalf("ParseSavedDeployment failed on legacy deployment.yml: %v", err)
	}
	if len(dep.Hosts) != 3 || dep.Platform != "ubuntu-24.04" {
		t.Fatalf("unexpected parsed deployment: hosts=%d platform=%q", len(dep.Hosts), dep.Platform)
	}

	// Verify cluster summary & spec endpoints expose all 3 hosts when on-disk deployment.yml has legacy keys.
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	w := storeCreate(t, s, alice, csrf, `{"id":"legacy-etcd","hosts":[{"name":"n1","ip":"10.0.1.11"},{"name":"n2","ip":"10.0.1.12"},{"name":"n3","ip":"10.0.1.13"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1","n2","n3"]}}]}`, nil)
	s.wg.Wait()
	var job storeJob
	if err := json.Unmarshal(w.Body.Bytes(), &job); err != nil || w.Code != 202 {
		t.Fatalf("create job: %d %s", w.Code, w.Body.String())
	}
	depPath := filepath.Join(s.jobDir(job.ID), "deployment.yml")
	orig, err := os.ReadFile(depPath)
	if err != nil {
		t.Fatalf("read deployment.yml: %v", err)
	}
	if err := os.WriteFile(depPath, append(orig, []byte("\nchange: null\npins: {}\n")...), 0o600); err != nil {
		t.Fatalf("write legacy deployment.yml: %v", err)
	}
	w = storeRequest(s, "GET", "/api/clusters", nil, alice, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"hosts":3`) {
		t.Fatalf("expected cluster hosts=3 for legacy deployment.yml, got %d %s", w.Code, w.Body.String())
	}
	w = storeRequest(s, "GET", "/api/jobs/"+job.ID, nil, alice, "")
	if w.Code != 200 || strings.Contains(w.Body.String(), "change:") || !strings.Contains(w.Body.String(), "10.0.1.13") {
		t.Fatalf("expected clean spec output without legacy keys, got %d %s", w.Code, w.Body.String())
	}
}

func TestExtractLiveJSONThinking(t *testing.T) {
	partial := `{"thinking": "1. 核对 3 节点主从拓扑\n2. 识别 \"maxmemory\" 参数\`
	th, ph := extractLiveJSONThinking(partial)
	if th != "1. 核对 3 节点主从拓扑\n2. 识别 \"maxmemory\" 参数" || ph != "" {
		t.Fatalf("unexpected partial thinking=%q phase=%q", th, ph)
	}
	full := `{"thinking": "1. 核对拓扑\n2. 生成脚本", "probe_script": "#!/usr/bin/env bash\nhostname"}`
	th, ph = extractLiveJSONThinking(full)
	if th != "1. 核对拓扑\n2. 生成脚本" || !strings.Contains(ph, "纯只读") {
		t.Fatalf("unexpected full thinking=%q phase=%q", th, ph)
	}
}

func TestRehearsalSSEStreamingAndImages(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")

	w := storeCreate(t, s, alice, csrf, `{"id":"pg-sse","hosts":[{"name":"n1","ip":"10.0.2.11"},{"name":"n2","ip":"10.0.2.12"}],"instances":[{"id":"pg","component":"etcd","placement":{"member":["n1","n2"]}}]}`, nil)
	s.wg.Wait()
	var job storeJob
	if err := json.Unmarshal(w.Body.Bytes(), &job); err != nil || w.Code != 202 {
		t.Fatalf("create job: %d %s", w.Code, w.Body.String())
	}
	w = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("mark outcome: %d %s", w.Code, w.Body.String())
	}

	tinyPNG := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	scopeReply := `{"thinking":"1. 读取 n1/n2 双节点拓扑；2. 确认平滑变更窗口","title":"双节点参数演练","scope_summary":"低峰期滚动变更","questions":[{"id":"q1","question":"窗口要求？","options":["低峰期"]}]}`
	probeReply := `{"thinking":"设计 100% 纯只读检查命令","probe_script":"#!/usr/bin/env bash\netcdctl endpoint status -w table 2>/dev/null\n","probe_notes":["任意节点执行"]}`
	planReply := `{"thinking":"结合终端截图识别到 n2 当前为 Leader","drift":{"summary":"n2 为当前 Leader","drifted":true,"hosts":[{"name":"n2","ip":"10.0.2.12","initial_role":"Follower","actual_role":"Leader","status":"healthy"}]},"steps":[{"id":"s1","phase":"execute","order":1,"title":"检查并更新配置","target_role":"Follower n1","command":"etcdctl endpoint health","expect":"healthy"}]}`
	troubleReply := `{"thinking":"根据报错截图识别证书参数缺失","diagnosis":"缺少端点证书参数","action":"replace","command":"etcdctl --cacert=/etc/etcd/ca.pem endpoint health","expect":"healthy"}`

	srv, bodies := fakeModel(t, scopeReply, probeReply, planReply, troubleReply)
	enableAI(t, s, srv.URL, 1)

	// 1. Stream create rehearsal with attached screenshot
	createBody := `{"goal":"核对集群健康并完成参数变更演练","images":["` + tinyPNG + `"]}`
	w = storeRequest(s, "POST", "/api/clusters/pg-sse/rehearsals?stream=1", strings.NewReader(createBody), alice, csrf)
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("stream create failed: %d %s", w.Code, w.Body.String())
	}
	rawSSE := w.Body.String()
	if !strings.Contains(rawSSE, `"t":"think"`) || !strings.Contains(rawSSE, `"t":"step"`) || !strings.Contains(rawSSE, `"t":"done"`) {
		t.Fatalf("missing expected SSE events in create stream: %s", rawSSE)
	}
	connRunningIdx := strings.Index(rawSSE, `"id":"connect-model","kind":"connect"`)
	thinkPendingIdx := strings.Index(rawSSE, `"id":"model-think","kind":"think"`)
	thinkChunkIdx := strings.Index(rawSSE, `"t":"think"`)
	if connRunningIdx < 0 || thinkPendingIdx < 0 || !strings.Contains(rawSSE, `"status":"running"`) || !strings.Contains(rawSSE, `"status":"pending"`) || connRunningIdx > thinkChunkIdx {
		t.Fatalf("expected 5-stage connect->think pipeline ordering before think chunks, got: %s", rawSSE)
	}

	listW := storeRequest(s, "GET", "/api/clusters/pg-sse/rehearsals", nil, alice, "")
	var list []changeRehearsal
	if err := json.Unmarshal(listW.Body.Bytes(), &list); err != nil || len(list) != 1 {
		t.Fatalf("list rehearsals: %v %s", err, listW.Body.String())
	}
	rh := list[0]
	if len(rh.GoalImages) != 1 || rh.Traces["create"].Thinking == "" {
		t.Fatalf("expected GoalImages and create trace persisted, got %+v", rh)
	}
	if len(rh.Traces["create"].Steps) != 5 || rh.Traces["create"].Steps[4].Status != "done" {
		t.Fatalf("expected 5 completed steps in create trace, got %+v", rh.Traces["create"].Steps)
	}

	// Serve stored image via GET
	imgW := storeRequest(s, "GET", "/api/clusters/pg-sse/rehearsals/"+rh.ID+"/img/"+rh.GoalImages[0], nil, alice, "")
	if imgW.Code != 200 || imgW.Header().Get("Content-Type") != "image/png" || imgW.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("serve rehearsal image failed: %d %v", imgW.Code, imgW.Header())
	}

	// 2. Stream scope -> probing
	w = storeRequest(s, "POST", "/api/clusters/pg-sse/rehearsals/"+rh.ID+"/scope?stream=1", strings.NewReader(`{"answers":[{"id":"q1","question":"窗口要求？","answer":"低峰期"}]}`), alice, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"readonly-ast-guard"`) {
		t.Fatalf("stream scope failed: %d %s", w.Code, w.Body.String())
	}

	// 3. Stream probe with screenshot-only (no text output) -> multimodal image_url sent to LLM
	w = storeRequest(s, "POST", "/api/clusters/pg-sse/rehearsals/"+rh.ID+"/probe?stream=1", strings.NewReader(`{"images":["`+tinyPNG+`"]}`), alice, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"t":"done"`) {
		t.Fatalf("stream probe with screenshot failed: %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(strings.Join(*bodies, "\n"), `"image_url"`) {
		t.Fatalf("expected multimodal image_url payload forwarded to model")
	}

	// 4. Stream troubleshoot with screenshot-only
	w = storeRequest(s, "POST", "/api/clusters/pg-sse/rehearsals/"+rh.ID+"/steps/s1/troubleshoot?stream=1", strings.NewReader(`{"images":["`+tinyPNG+`"]}`), alice, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"t":"done"`) {
		t.Fatalf("stream troubleshoot with screenshot failed: %d %s", w.Code, w.Body.String())
	}

	getW := storeRequest(s, "GET", "/api/clusters/pg-sse/rehearsals/"+rh.ID, nil, alice, "")
	var updated changeRehearsal
	_ = json.Unmarshal(getW.Body.Bytes(), &updated)
	if len(updated.ProbeImages) != 1 || len(updated.Steps) != 1 || len(updated.Steps[0].ErrorImages) != 1 || updated.Steps[0].TroubleTrace == nil {
		t.Fatalf("expected ProbeImages, ErrorImages and TroubleTrace persisted, got %+v", updated)
	}

	// 5. Vision=="no" model rejects screenshot submission cleanly with 409
	st := s.aiLoad()
	st.Providers[0].Models[0].Vision = "no"
	_ = s.aiSave(st)
	w = storeRequest(s, "POST", "/api/clusters/pg-sse/rehearsals/"+rh.ID+"/steps/s1/troubleshoot?stream=1", strings.NewReader(`{"images":["`+tinyPNG+`"]}`), alice, csrf)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "不支持识别截图") {
		t.Fatalf("expected 409 when model Vision=no, got %d %s", w.Code, w.Body.String())
	}

	// 6. Upstream 402 error emits failed connect-model step and strips raw empty JSON tail
	errSrv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(402)
		_, _ = rw.Write([]byte(`{"error":{"code":"server_error","message":""}}`))
	}))
	t.Cleanup(errSrv.Close)
	enableAI(t, s, errSrv.URL, 1)
	w = storeRequest(s, "POST", "/api/clusters/pg-sse/rehearsals?stream=1", strings.NewReader(`{"goal":"扩容只读节点"}`), alice, csrf)
	errStream := w.Body.String()
	if !strings.Contains(errStream, `"id":"connect-model"`) || !strings.Contains(errStream, `"status":"error"`) || !strings.Contains(errStream, `"t":"error"`) {
		t.Fatalf("expected SSE error step and error event on 402 failure, got: %s", errStream)
	}
	if strings.Contains(errStream, `{"error":{"code"`) {
		t.Fatalf("expected raw empty JSON wrapper stripped from SSE error stream, got: %s", errStream)
	}
}

func TestCleanUpstreamErrText(t *testing.T) {
	got := cleanUpstreamErrText(`402 Payment Required: {"error":{"code":"server_error","message":""}}`)
	if strings.Contains(got, "{") || !strings.Contains(got, "402 Payment Required") {
		t.Fatalf("unexpected cleaned error text: %q", got)
	}
}

func TestRehearsalTruncationUsageAndClaudeFastFallback(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	admin, _ := storeLogin(t, s, "admin")

	w := storeCreate(t, s, alice, csrf, `{"id":"redis-trunc","hosts":[{"name":"n1","ip":"10.0.6.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	var job storeJob
	_ = json.Unmarshal(w.Body.Bytes(), &job)
	_ = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)

	enc, _ := s.aiEncrypt("sk-magpie-test-key")
	st := s.aiLoad()
	st.Enabled = true
	st.Providers = []aiProvider{{
		ID:         "magpie-gw",
		Name:       "内网测试 (Magpie)",
		Preset:     "custom",
		API:        "responses",
		TimeoutSec: 5,
		URL:        "https://magpie.internal/v1",
		Private:    true,
		Enabled:    true,
		KeyEnc:     enc,
		Models: []aiModel{
			{ID: "zerotoken/claude-sonnet-5-5", Enabled: true, Tools: "yes", Vision: "yes"},
		},
	}}
	_ = s.aiSave(st)

	var respCount, chatCount int
	s.setAITransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/responses") {
			respCount++
			return mockHTTPResp(req, 200, "text/event-stream", nil, magpieEmptyResponsesSSE), nil
		}
		chatCount++
		if chatCount == 1 {
			ans := `{"thinking":"1. 核对拓扑","title":"升级演练","scope_summary":"平滑升级","questions":[{"id":"q1","question":"目标版本？","options":["版本已定，包待核验（补充目标版本号）"]}]}`
			raw, _ := json.Marshal(ans)
			sse := `data: {"id":"cmpl_1","choices":[{"delta":{"content":` + string(raw) + `},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n"
			return mockHTTPResp(req, 200, "text/event-stream", nil, sse), nil
		}
		// Second chat call returns truncated JSON without probe_script: must mark usage OK=false and ReasonCode=invalid_output!
		sseTrunc := `data: {"id":"cmpl_trunc","choices":[{"delta":{"content":"{\"thinking\":\"正在编排探针\",\"probe_s"},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n"
		return mockHTTPResp(req, 200, "text/event-stream", nil, sseTrunc), nil
	}))
	t.Cleanup(func() { s.setAITransport(nil) })

	// 1. Create with effort="high" on Claude: should try /responses ONCE (skipping redundant 2nd /responses retry) -> /chat/completions
	w = storeRequest(s, "POST", "/api/clusters/redis-trunc/rehearsals?stream=1", strings.NewReader(`{"goal":"平滑升级到目标小版本","effort":"high"}`), alice, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"t":"done"`) {
		t.Fatalf("expected create stream to succeed via fallback, got: %d %s", w.Code, w.Body.String())
	}
	if respCount != 1 || chatCount != 1 {
		t.Fatalf("expected exactly 1 /responses + 1 /chat/completions on first Claude call with effort=high, got resp=%d chat=%d", respCount, chatCount)
	}

	listW := storeRequest(s, "GET", "/api/clusters/redis-trunc/rehearsals", nil, alice, "")
	var list []changeRehearsal
	_ = json.Unmarshal(listW.Body.Bytes(), &list)
	rh := list[0]

	// 2. Scope submission on same Claude model: should remember fallback (respCount stays 1!) and record OK=false when JSON is truncated!
	w = storeRequest(s, "POST", "/api/clusters/redis-trunc/rehearsals/"+rh.ID+"/scope?stream=1", strings.NewReader(`{"answers":[{"id":"q1","question":"目标版本？","answer":"版本已定（目标版本：7.2.6）"}],"effort":"high"}`), alice, csrf)
	sseErr := w.Body.String()
	if respCount != 1 || chatCount != 2 {
		t.Fatalf("expected learned chat fallback to skip /responses on 2nd call (resp=1, chat=2), got resp=%d chat=%d", respCount, chatCount)
	}
	if !strings.Contains(sseErr, `"t":"error"`) || !strings.Contains(sseErr, `"reason_code":"invalid_output"`) {
		t.Fatalf("expected SSE error with invalid_output diag, got: %s", sseErr)
	}

	uW := storeRequest(s, "GET", "/api/settings/ai/usage", nil, admin, "")
	var uResp struct {
		Rows []aiUsage `json:"rows"`
	}
	_ = json.Unmarshal(uW.Body.Bytes(), &uResp)
	if len(uResp.Rows) < 2 || uResp.Rows[0].OK {
		t.Fatalf("expected latest truncated rehearsal call recorded as OK=false in usage log, got: %+v", uResp.Rows)
	}
}

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
	"time"

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

func TestRehearsalProbeBashGuardAndValidityGate(t *testing.T) {
	// 1. Verify bash self-reexec guard is injected cleanly and remains 100% read-only.
	rawScript := "#!/usr/bin/env bash\nset -uo pipefail\npatronictl list\n"
	guarded := ensureProbeBashGuard(rawScript)
	if !strings.Contains(guarded, `if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi`) {
		t.Fatalf("expected bash guard injected, got:\n%s", guarded)
	}
	if ensureProbeBashGuard(guarded) != guarded {
		t.Fatalf("expected ensureProbeBashGuard to be idempotent")
	}
	if ok, warns := validateReadOnlyProbeScript(guarded); !ok {
		t.Fatalf("expected guarded probe script to pass read-only validator, got warns=%v", warns)
	}

	// 2. Verify probe failure gate blocks advancing to rehearsing when AI returns probe_status="failed".
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	cw := storeCreate(t, s, alice, csrf, `{"id":"pg-gate-test","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create job: %d %s", cw.Code, cw.Body.String())
	}
	scopeReply := `{"title":"PG 日志演练","scope_summary":"测试探针门禁","questions":[{"id":"q1","label":"窗口","question":"维护窗口？","options":["周末"]}]}`
	probeReply := `{"probe_script":"#!/usr/bin/env bash\nset -uo pipefail\npatronictl list","probe_notes":["使用 bash 运行"]}`
	blockedReply := `{
		"thinking": "截图显示 sh 执行报 Illegal option -o pipefail，未获得任何数据库状态。",
		"probe_status": "failed",
		"probe_issue": {
			"summary": "Ubuntu 上使用 sh 执行导致脚本提前退出，未采集到现场数据",
			"cause": "/bin/sh 指向 dash，不支持 set -o pipefail",
			"fix_command": "bash /tmp/collect-pg-gate-test.sh",
			"fix_steps": ["使用 bash 而非 sh 重新运行采集脚本", "将完整输出粘贴回平台"],
			"missing_items": ["Patroni 成员角色", "当前 logging_collector 状态"],
			"fixed_script": "#!/usr/bin/env bash\nset -uo pipefail\necho fixed-probe\npatronictl list"
		}
	}`
	srv, _ := fakeModel(t, scopeReply, probeReply, blockedReply)
	enableAI(t, s, srv.URL, 1)

	w := storeRequest(s, "POST", "/api/clusters/pg-gate-test/rehearsals", strings.NewReader(`{"goal":"开启 logging_collector"}`), alice, csrf)
	if w.Code != 201 {
		t.Fatalf("create failed: %d %s", w.Code, w.Body.String())
	}
	var rh changeRehearsal
	_ = json.Unmarshal(w.Body.Bytes(), &rh)

	w = storeRequest(s, "POST", "/api/clusters/pg-gate-test/rehearsals/"+rh.ID+"/scope", strings.NewReader(`{"answers":[{"id":"q1","question":"维护窗口？","answer":"周末"}]}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("scope failed: %d %s", w.Code, w.Body.String())
	}
	rh = changeRehearsal{}
	_ = json.Unmarshal(w.Body.Bytes(), &rh)
	if !strings.Contains(rh.ProbeScript, "BASH_VERSION") {
		t.Fatalf("expected generated probe_script to include BASH_VERSION guard, got: %s", rh.ProbeScript)
	}

	// Submit error output -> must stay on "probing", set ProbeIssue, NOT advance to "rehearsing" or create Drift/Steps.
	w = storeRequest(s, "POST", "/api/clusters/pg-gate-test/rehearsals/"+rh.ID+"/probe", strings.NewReader(`{"probe_output":"sh: 2: set: Illegal option -o pipefail"}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("probe gate failed: %d %s", w.Code, w.Body.String())
	}
	rh = changeRehearsal{}
	_ = json.Unmarshal(w.Body.Bytes(), &rh)
	if rh.Stage != "probing" {
		t.Fatalf("expected stage to remain probing when probe failed, got %q", rh.Stage)
	}
	if rh.ProbeIssue == nil || rh.ProbeIssue.Status != "failed" || !rh.ProbeIssue.ScriptUpdated {
		t.Fatalf("expected ProbeIssue with script_updated=true, got %+v", rh.ProbeIssue)
	}
	if rh.Drift != nil || len(rh.Steps) != 0 {
		t.Fatalf("expected no drift/steps created when probe failed, got drift=%+v steps=%d", rh.Drift, len(rh.Steps))
	}
	if !strings.Contains(rh.ProbeScript, "echo fixed-probe") || !strings.Contains(rh.ProbeScript, "BASH_VERSION") {
		t.Fatalf("expected probe script auto-updated with bash guard, got: %s", rh.ProbeScript)
	}
}

func TestRehearsalStepAIVerifyPassAndFail(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	cw := storeCreate(t, s, alice, csrf, `{"id":"pg-verify-test","hosts":[{"name":"n1","ip":"10.0.2.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create job: %d %s", cw.Code, cw.Body.String())
	}

	scopeReply := `{"title":"PG 日志演练","scope_summary":"验证 AI 自动核验步骤","questions":[{"id":"q1","label":"窗口","question":"维护窗口？","options":["周末"]}]}`
	probeReply := `{"probe_script":"#!/usr/bin/env bash\nset -uo pipefail\necho ok","probe_notes":["使用 bash 运行"]}`
	planReply := `{
		"probe_status": "valid",
		"drift": {"summary":"基线一致","drifted":false,"hosts":[{"name":"n1","ip":"10.0.2.11","initial_role":"member","actual_role":"Leader","version":"3.5.15","status":"healthy"}]},
		"steps": [
			{"id":"s1","phase":"precheck","order":1,"title":"确认主备与复制状态","target_role":"n1","command":"patronictl list","expect":"两个从库 streaming，无报错","optional":false},
			{"id":"s2","phase":"execute","order":2,"title":"调整日志目录权限","target_role":"n1","command":"chown postgres:postgres /data/logs/postgresql","expect":"目录权限 0700 属主 postgres","optional":false}
		]
	}`
	verifyPassReply := `{"thinking":"截图和文本回显显示两从库 streaming 且 lag=0","verdict":"passed","summary":"两个从库均处于 streaming 状态且复制延迟为 0，满足预期判据。","elapsed":""}`
	verifyFailReply := `{"thinking":"提示目录不存在，需先创建目录","verdict":"failed","diagnosis":"/data/logs/postgresql 目录尚未创建，需先 mkdir -p 再设置属主与权限","action":"retry","command":"mkdir -p /data/logs/postgresql && chown postgres:postgres /data/logs/postgresql && chmod 0700 /data/logs/postgresql","expect":"目录存在且属主 postgres 权限 0700"}`

	srv, bodies := fakeModel(t, scopeReply, probeReply, planReply, verifyPassReply, verifyFailReply)
	enableAI(t, s, srv.URL, 1)

	w := storeRequest(s, "POST", "/api/clusters/pg-verify-test/rehearsals", strings.NewReader(`{"goal":"开启 logging_collector"}`), alice, csrf)
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var rh changeRehearsal
	_ = json.Unmarshal(w.Body.Bytes(), &rh)

	w = storeRequest(s, "POST", "/api/clusters/pg-verify-test/rehearsals/"+rh.ID+"/scope", strings.NewReader(`{"answers":[{"id":"q1","question":"维护窗口？","answer":"周末"}]}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("scope: %d %s", w.Code, w.Body.String())
	}
	w = storeRequest(s, "POST", "/api/clusters/pg-verify-test/rehearsals/"+rh.ID+"/probe", strings.NewReader(`{"probe_output":"node-1 Leader healthy"}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("probe: %d %s", w.Code, w.Body.String())
	}

	// 1. Verify s1 with output + secret + 1x1 PNG screenshot -> verdict=passed
	tinyPNG := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	passPayload := `{"output":"state=streaming lag=0\npassword=VerifyStepSecret999","images":["` + tinyPNG + `"]}`
	w = storeRequest(s, "POST", "/api/clusters/pg-verify-test/rehearsals/"+rh.ID+"/steps/s1/verify", strings.NewReader(passPayload), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("verify s1 pass: %d %s", w.Code, w.Body.String())
	}
	rh = changeRehearsal{}
	_ = json.Unmarshal(w.Body.Bytes(), &rh)
	if rh.Steps[0].Status != "passed" || !rh.Steps[0].VerifiedByAI || !strings.Contains(rh.Steps[0].Note, "streaming") || len(rh.Steps[0].EvidenceImages) != 1 || rh.Steps[0].Proposal != nil {
		t.Fatalf("unexpected s1 passed state: %+v", rh.Steps[0])
	}
	if strings.Contains(strings.Join(*bodies, "\n"), "VerifyStepSecret999") {
		t.Fatal("secret leaked into verify step LLM request")
	}

	// 2. Verify s2 with error output -> verdict=failed with retry proposal
	w = storeRequest(s, "POST", "/api/clusters/pg-verify-test/rehearsals/"+rh.ID+"/steps/s2/verify", strings.NewReader(`{"output":"chown: cannot access '/data/logs/postgresql': No such file or directory"}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("verify s2 fail: %d %s", w.Code, w.Body.String())
	}
	rh = changeRehearsal{}
	_ = json.Unmarshal(w.Body.Bytes(), &rh)
	if rh.Steps[1].Status != "failed" || rh.Steps[1].VerifiedByAI || rh.Steps[1].Proposal == nil || rh.Steps[1].Proposal.Action != "retry" || !strings.Contains(rh.Steps[1].Proposal.Diagnosis, "尚未创建") {
		t.Fatalf("unexpected s2 failed state: %+v", rh.Steps[1])
	}
}

func TestRehearsalSkillsAndConciseProbeRules(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	admin, acsrf := storeLogin(t, s, "admin")

	// Add a custom organization ELB/network skill + a personal skill for alice
	orgSkillBody := `{"custom":[{"name":"corp-elb-rule","title":"企业内网 ELB 规范","description":"云 ELB 回环与堡垒机验收入口规范","content":"所有云 ELB 入口只能在跳板机 10.99.0.10 探测，严禁在数据库节点回环访问 VIP。"}]}`
	if w := storeRequest(s, "PUT", "/api/settings/ai/skills", strings.NewReader(orgSkillBody), admin, acsrf); w.Code != 200 {
		t.Fatalf("save org custom skill: %d %s", w.Code, w.Body.String())
	}
	userSkillBody := `{"skills":[{"name":"alice-vdi-cap","title":"VDI 截屏规范","description":"受限堡垒机终端输出行数约束","content":"堡垒机无法复制，所有只读回显控制在 25 行内。"}]}`
	if w := storeRequest(s, "PUT", "/api/me/skills", strings.NewReader(userSkillBody), alice, csrf); w.Code != 200 {
		t.Fatalf("save personal skill: %d %s", w.Code, w.Body.String())
	}

	cw := storeCreate(t, s, alice, csrf, `{"id":"etcd-skill-test","hosts":[{"name":"n1","ip":"10.0.3.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create job: %d %s", cw.Code, cw.Body.String())
	}

	scopeReply := `{"title":"开启日志落盘与 ELB 入口核验","scope_summary":"精简采集","questions":[{"id":"q1","label":"窗口","question":"窗口？","options":["周末"]}]}`
	probeReply := `{"probe_script":"#!/usr/bin/env bash\nset -uo pipefail\necho '=== ROLE ==='\netcdctl endpoint status -w table 2>/dev/null","probe_notes":["单屏输出"]}`
	srv, bodies := fakeModel(t, scopeReply, probeReply)
	enableAI(t, s, srv.URL, 1)

	w := storeRequest(s, "POST", "/api/clusters/etcd-skill-test/rehearsals", strings.NewReader(`{"goal":"开启日志落盘并通过 ELB 入口验证切换"}`), alice, csrf)
	if w.Code != 201 {
		t.Fatalf("create rehearsal: %d %s", w.Code, w.Body.String())
	}
	var rh changeRehearsal
	_ = json.Unmarshal(w.Body.Bytes(), &rh)

	w = storeRequest(s, "POST", "/api/clusters/etcd-skill-test/rehearsals/"+rh.ID+"/scope", strings.NewReader(`{"answers":[{"id":"q1","question":"窗口？","answer":"周末"}]}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("scope rehearsal: %d %s", w.Code, w.Body.String())
	}
	rh = changeRehearsal{}
	_ = json.Unmarshal(w.Body.Bytes(), &rh)

	if len(*bodies) < 2 {
		t.Fatalf("expected 2 LLM requests, got %d", len(*bodies))
	}
	probeReqBody := (*bodies)[1]
	for _, want := range []string{
		"15～35 行",
		"回环",
		"引导式变更演练与生产 SOP",
		"负载均衡与 VIP",
		"日志、轮转与可观测性核对",
		"企业内网 ELB 规范",
		"所有云 ELB 入口只能在跳板机 10.99.0.10 探测",
		"VDI 截屏规范",
		"所有只读回显控制在 25 行内",
	} {
		if !strings.Contains(probeReqBody, want) {
			t.Errorf("probe LLM request missing expected skill/rule %q", want)
		}
	}
	if tr, ok := rh.Traces["scope"]; !ok || len(tr.Steps) == 0 || !strings.Contains(tr.Steps[0].Detail, "已加载技能") {
		t.Fatalf("expected scope trace step to surface loaded skills, got %+v", tr.Steps)
	}
}

func TestRehearsalLightAndAutoModes(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")

	cw := storeCreate(t, s, alice, csrf, `{"id":"pg-tier-test","hosts":[{"name":"n1","ip":"10.0.4.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create job: %d %s", cw.Code, cw.Body.String())
	}

	lightReply := `{"thinking":"仅补 pg_hba 单条规则，无需重启切主","title":"Patroni pg_hba 补本地复制规则","scope_summary":"仅 reload 生效，走简单推演","probe_script":"#!/usr/bin/env bash\nset -uo pipefail\necho '=== ROLE ==='\npatronictl list 2>/dev/null","probe_notes":["单屏输出约 15 行"]}`
	probePlanReply := `{"thinking":"已确认规则缺失","probe_status":"valid","drift":{"summary":"现场角色正常","drifted":false,"hosts":[{"name":"n1","ip":"10.0.4.11","initial_role":"member","actual_role":"Leader","status":"ok"}]},"steps":[{"id":"s1","phase":"precheck","title":"核对当前规则","target_role":"n1","command":"patronictl show-config","expect":"确认缺少 127.0.0.1"},{"id":"s2","phase":"execute","title":"补充规则并重载","target_role":"n1","command":"patronictl edit-config","expect":"reload 成功"},{"id":"s3","phase":"verify","title":"检查日志无报错","target_role":"n1","command":"journalctl -u patroni -n 20","expect":"无 no pg_hba.conf entry"},{"id":"s4","phase":"rollback","title":"回退配置","target_role":"n1","command":"patronictl edit-config","expect":"恢复原配置"}]}`
	autoLightReply := `{"thinking":"动态参数调整无需重启","resolved_mode":"light","title":"在线调整 statement_timeout","scope_summary":"在线动态参数微调","probe_script":"#!/usr/bin/env bash\nset -uo pipefail\necho '=== PARAM ==='\npsql -Atc 'SHOW statement_timeout;' 2>/dev/null","probe_notes":["单屏 10 行"]}`
	autoFullReply := `{"thinking":"涉及跨大版本升级与切主","resolved_mode":"full","title":"PostgreSQL 17 升级演练","scope_summary":"高风险滚动升级","questions":[{"id":"q1","label":"维护窗口","question":"可接受的闪断窗口？","options":["低峰窗口滚动切换"]}]}`

	srv, bodies := fakeModel(t, lightReply, probePlanReply, autoLightReply, autoFullReply)
	enableAI(t, s, srv.URL, 1)

	// 1. Explicit mode="light" skips scoping directly to probing
	w := storeRequest(s, "POST", "/api/clusters/pg-tier-test/rehearsals", strings.NewReader(`{"mode":"light","goal":"Patroni pg_hba 补充 127.0.0.1 复制规则"}`), alice, csrf)
	if w.Code != 201 {
		t.Fatalf("create light rehearsal: %d %s", w.Code, w.Body.String())
	}
	var rhLight changeRehearsal
	_ = json.Unmarshal(w.Body.Bytes(), &rhLight)
	if rhLight.Mode != "light" || rhLight.Stage != "probing" {
		t.Fatalf("expected mode=light stage=probing, got mode=%q stage=%q", rhLight.Mode, rhLight.Stage)
	}
	if !rhLight.ProbeSafe || !strings.Contains(rhLight.ProbeScript, "patronictl list") {
		t.Fatalf("expected validated light probe script, got safe=%v script=%q", rhLight.ProbeSafe, rhLight.ProbeScript)
	}

	// Submitting probe on a light rehearsal injects the light 3-5 step constraint
	w = storeRequest(s, "POST", "/api/clusters/pg-tier-test/rehearsals/"+rhLight.ID+"/probe", strings.NewReader(`{"probe_output":"=== ROLE ===\nn1 Leader running"}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("probe light rehearsal: %d %s", w.Code, w.Body.String())
	}
	if len(*bodies) < 2 || !strings.Contains((*bodies)[1], "简单推演（light）") {
		t.Fatalf("expected light mode cue in probe planning request")
	}

	// 2. mode="auto" -> AI resolves "light" -> directly in probing
	w = storeRequest(s, "POST", "/api/clusters/pg-tier-test/rehearsals", strings.NewReader(`{"mode":"auto","goal":"在线调整 statement_timeout 为 30s"}`), alice, csrf)
	if w.Code != 201 {
		t.Fatalf("create auto-light rehearsal: %d %s", w.Code, w.Body.String())
	}
	var rhAutoLight changeRehearsal
	_ = json.Unmarshal(w.Body.Bytes(), &rhAutoLight)
	if rhAutoLight.Mode != "light" || rhAutoLight.Stage != "probing" {
		t.Fatalf("expected auto->light to land in probing, got mode=%q stage=%q", rhAutoLight.Mode, rhAutoLight.Stage)
	}

	// 3. mode="auto" -> AI resolves "full" -> lands in scoping with questions
	w = storeRequest(s, "POST", "/api/clusters/pg-tier-test/rehearsals", strings.NewReader(`{"mode":"auto","goal":"升级 PostgreSQL 小版本并滚动切主"}`), alice, csrf)
	if w.Code != 201 {
		t.Fatalf("create auto-full rehearsal: %d %s", w.Code, w.Body.String())
	}
	var rhAutoFull changeRehearsal
	_ = json.Unmarshal(w.Body.Bytes(), &rhAutoFull)
	if rhAutoFull.Mode != "full" || rhAutoFull.Stage != "scoping" || len(rhAutoFull.ScopeQuestions) == 0 {
		t.Fatalf("expected auto->full to land in scoping with questions, got mode=%q stage=%q qs=%d", rhAutoFull.Mode, rhAutoFull.Stage, len(rhAutoFull.ScopeQuestions))
	}

	// 4. Static probe safety guard must not false-positive when patronictl list is piped to python3 printing "Pending restart"
	pipedSafe := "#!/usr/bin/env bash\nset -uo pipefail\npatronictl -c /etc/patroni/patroni.yml list -f json 2>/dev/null | python3 -c 'import sys,json; [print(r.get(\"Pending restart\")) for r in json.load(sys.stdin)]'\n"
	if ok, warns := validateReadOnlyProbeScript(pipedSafe); !ok {
		t.Fatalf("expected piped read-only patronictl list to pass safety guard, got warns=%v", warns)
	}
	realMutate := "#!/usr/bin/env bash\nset -uo pipefail\npatronictl -c /etc/patroni/patroni.yml restart pg-cluster\n"
	if ok, _ := validateReadOnlyProbeScript(realMutate); ok {
		t.Fatalf("expected real patronictl restart command to be flagged as unsafe")
	}
}

func TestRehearsalVerifyMultiRoundHistoryAndPragmaticPrompt(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	cw := storeCreate(t, s, alice, csrf, `{"id":"pg-vhist","hosts":[{"name":"node-1","ip":"10.0.8.11"},{"name":"node-2","ip":"10.0.8.12"},{"name":"node-3","ip":"10.0.8.13"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["node-1","node-2","node-3"]}}]}`, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create job: %d %s", cw.Code, cw.Body.String())
	}
	var job storeJob
	_ = json.Unmarshal(cw.Body.Bytes(), &job)
	_ = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)

	// Seed an active rehearsal with prior completed step #4 + current multi-node verify step #5 so we test BOTH cross-step context and split-round screenshot memory!
	rh := changeRehearsal{
		ID:        "a1b2c3d4e501",
		ClusterID: "pg-vhist",
		Title:     "PostgreSQL 日志配置变更演练",
		Goal:      "开启 logging_collector 并逐台验证三节点日志写入",
		Stage:     "rehearsing",
		Mode:      "full",
		CreatedAt: nowStamp(),
		UpdatedAt: nowStamp(),
		Drift:     &rehearsalDrift{Summary: "现场一主两从健康，原主库为 node-1"},
		Steps: []rehearsalStep{
			{
				ID:           "s4",
				Phase:        "execute",
				Order:        4,
				Title:        "计划内切主并重启原主库 node-1",
				TargetRole:   "在 node-1 (10.0.8.11) 上执行",
				Command:      "patronictl switchover && patronictl restart node-1",
				Expect:       "node-2 为 Leader，三节点无 Pending restart",
				Status:       "passed",
				VerifiedByAI: true,
				Note:         "已完成 node-1→node-2 切主并重启 node-1，三节点均无 Pending restart 且 Lag=0。",
			},
			{
				ID:         "s5",
				Phase:      "verify",
				Order:      5,
				Title:      "逐台验收参数生效与日志持续写入",
				TargetRole: "所有数据节点（node-1 / node-2 / node-3，逐台执行）",
				Command:    "sudo -u postgres psql -Atc 'SHOW logging_collector;' && ls -lt /data/logs/postgresql | head -3",
				Expect:     "node-1 / node-2 / node-3 参数均生效且当日日志文件持续增长",
				Status:     "pending",
			},
		},
	}
	if err := s.saveRehearsal(rh); err != nil {
		t.Fatalf("save seed rehearsal: %v", err)
	}

	tinyPNG := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	round1Fail := `{"thinking":"第 1 轮截图已明确证实 node-1 与 node-3 参数生效且当日日志持续增长，仅缺 node-2 验证结果","verdict":"failed","verified_facts":["node-1: logging_collector=on 等参数生效且当日日志持续增长","node-3: 参数生效且当日日志持续增长"],"missing_items":["node-2 参数生效与日志增长验证"],"diagnosis":"node-1 和 node-3 已验收通过，仅缺 node-2 验收证据","action":"retry","command":"ssh node-2 'ls -lt /data/logs/postgresql | head -3'"}`
	round2Pass := `{"thinking":"合并第 1 轮已证实的 node-1、node-3 与本轮 node-2 证据，三台节点全部达标","verdict":"passed","verified_facts":["node-2: logging_collector=on 且当日日志字节数持续增长"],"summary":"node-1、node-2、node-3 三台节点均已完成验收，参数生效且日志持续写入正常。","elapsed":""}`

	srv, bodies := fakeModel(t, round1Fail, round2Pass)
	enableAI(t, s, srv.URL, 1)

	// Round 1 (screenshot-only!): proves node-1 & node-3, asks only for node-2; also verify SSE emits authoritative 5-step "steps" frame.
	w1 := storeRequest(s, "POST", "/api/clusters/pg-vhist/rehearsals/"+rh.ID+"/steps/s5/verify?stream=1",
		strings.NewReader(`{"images":["`+tinyPNG+`"]}`), alice, csrf)
	if w1.Code != 200 {
		t.Fatalf("round 1 verify: %d %s", w1.Code, w1.Body.String())
	}
	sse1 := w1.Body.String()
	if !strings.Contains(sse1, `"t":"steps"`) || !strings.Contains(sse1, `"id":"inspect-step-evid"`) || !strings.Contains(sse1, `"id":"verify-verdict"`) {
		t.Fatalf("expected authoritative 5-step SSE snapshot on verify, got: %s", sse1)
	}

	// Verify Round 1 persisted verified_facts, missing_items, and thinking onto both VerifyHistory and Proposal
	cur1, ok := s.loadRehearsal("pg-vhist", rh.ID)
	if !ok || cur1.Steps[1].Status != "failed" || len(cur1.Steps[1].VerifyHistory) != 1 {
		t.Fatalf("expected 1 failed verify_history item after round 1, got status=%q hist=%+v", cur1.Steps[1].Status, cur1.Steps[1].VerifyHistory)
	}
	att1 := cur1.Steps[1].VerifyHistory[0]
	if att1.Round != 1 || att1.Verdict != "failed" || len(att1.VerifiedFacts) != 2 || len(att1.MissingItems) != 1 || !strings.Contains(att1.Thinking, "node-1 与 node-3") {
		t.Fatalf("unexpected round 1 history item: %+v", att1)
	}
	if cur1.Steps[1].Proposal == nil || len(cur1.Steps[1].Proposal.VerifiedFacts) != 2 || len(cur1.Steps[1].Proposal.MissingItems) != 1 {
		t.Fatalf("expected cumulative verified_facts & missing_items on active proposal, got %+v", cur1.Steps[1].Proposal)
	}

	// Round 2: user submits ONLY node-2 -> prompt must include Step #4 passed context + Round 1 cumulative verified_facts (node-1, node-3) + Round 1 thinking!
	w2 := storeRequest(s, "POST", "/api/clusters/pg-vhist/rehearsals/"+rh.ID+"/steps/s5/verify",
		strings.NewReader(`{"output":"node-2: logging_collector=on; postgresql-2026-11-23.log 97162 -> 99209 bytes"}`), alice, csrf)
	if w2.Code != 200 {
		t.Fatalf("round 2 verify: %d %s", w2.Code, w2.Body.String())
	}
	if len(*bodies) < 2 {
		t.Fatalf("expected 2 AI requests, got %d", len(*bodies))
	}
	req2 := (*bodies)[1]
	for _, must := range []string{
		"演练全局上下文：前序步骤实测进展",
		"已完成 node-1→node-2 切主并重启 node-1",
		"本步前序轮次已累计证实达标的事实",
		"node-1: logging_collector=on",
		"node-3: 参数生效且当日日志持续增长",
		"当时仅剩缺口=[node-2 参数生效与日志增长验证]",
		"第 1 轮截图已明确证实 node-1 与 node-3",
		"等价强证据推断",
		"实事求是采信【集群基线】IP 映射与成功的 ELB/VIP 入口验证",
	} {
		if !strings.Contains(req2, must) {
			t.Fatalf("expected round 2 prompt to contain %q, got:\n%s", must, req2)
		}
	}
	if !strings.Contains(rehearsalPlanSystem, "主从角色复位（切回原主库）") || !strings.Contains(rehearsalPlanSystem, "非当前主库的从库节点") {
		t.Fatalf("expected rehearsalPlanSystem to include switchback & realistic ELB rules")
	}
	for name, prompt := range map[string]string{
		"light": rehearsalLightCreateSystem,
		"auto":  rehearsalAutoCreateSystem,
		"full":  rehearsalProbeSystem,
	} {
		if !strings.Contains(prompt, "实测版本号") || !strings.Contains(prompt, "待采集") {
			t.Fatalf("expected %s probe prompt to mandate live version collection aligned with drift table", name)
		}
	}
	if !strings.Contains(rehearsalPlanSystem, "不要**在 status 字段中重复抱怨") {
		t.Fatalf("expected rehearsalPlanSystem to suppress redundant missing-version complaints in status")
	}

	// Final check: step passed AND full 2-round history (failed round 1 + passed round 2) is preserved!
	cur2, ok := s.loadRehearsal("pg-vhist", rh.ID)
	if !ok || cur2.Steps[1].Status != "passed" || !cur2.Steps[1].VerifiedByAI || cur2.Steps[1].Proposal != nil {
		t.Fatalf("expected step passed cleanly, got %+v", cur2.Steps[1])
	}
	if len(cur2.Steps[1].VerifyHistory) != 2 || cur2.Steps[1].VerifyHistory[0].Verdict != "failed" || cur2.Steps[1].VerifyHistory[1].Verdict != "passed" {
		t.Fatalf("expected both failed round 1 and passed round 2 preserved in verify_history, got: %+v", cur2.Steps[1].VerifyHistory)
	}
}

func TestRehearsalStepEditProposalInAIDock(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	cw := storeCreate(t, s, alice, csrf, `{"id":"pg-edit-step","hosts":[{"name":"node-1","ip":"10.0.9.11"},{"name":"node-2","ip":"10.0.9.12"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["node-1","node-2"]}}]}`, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create job: %d %s", cw.Code, cw.Body.String())
	}
	var job storeJob
	_ = json.Unmarshal(cw.Body.Bytes(), &job)
	_ = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)

	rh := changeRehearsal{
		ID:        "a1b2c3d4e502",
		ClusterID: "pg-edit-step",
		Title:     "切主与重启演练",
		Goal:      "计划内切主并重启原主库",
		Stage:     "rehearsing",
		Mode:      "full",
		CreatedAt: nowStamp(),
		UpdatedAt: nowStamp(),
		Steps: []rehearsalStep{
			{
				ID:         "s1",
				Phase:      "precheck",
				Order:      1,
				Title:      "检查拓扑",
				TargetRole: "在 node-1 (10.0.9.11) 上执行",
				Command:    "patronictl list",
				Expect:     "两节点健康",
				Status:     "passed",
			},
			{
				ID:         "s2",
				Phase:      "execute",
				Order:      2,
				Title:      "计划内切主并重启",
				TargetRole: "当前主库 node-1",
				Command:    "patronictl switchover pg-edit-step --leader node-1 --candidate node-2 --force && patronictl restart pg-edit-step node-1 --force",
				Expect:     "node-2 为 Leader，node-1 重启完成",
				Status:     "failed",
			},
		},
	}
	if err := s.saveRehearsal(rh); err != nil {
		t.Fatalf("save seed rehearsal: %v", err)
	}

	// 1. read_rehearsal tool returns steps and metadata
	s.mu.Lock()
	job = s.jobs[job.ID]
	s.mu.Unlock()
	proposed := []string{}
	tc := aiToolCtx{s: s, job: job, user: "alice", session: "step:rehearsal:a1b2c3d4e502:s2", proposed: &proposed}
	readOut := tc.run("read_rehearsal", `{"rehearsal_id":"a1b2c3d4e502"}`)
	if !strings.Contains(readOut, "计划内切主并重启") || !strings.Contains(readOut, "a1b2c3d4e502") {
		t.Fatalf("read_rehearsal unexpected output: %s", readOut)
	}

	// 2. propose_rehearsal_step_edit (replace) creates a persisted rehearsal_step proposal
	res1 := tc.run("propose_rehearsal_step_edit", `{"rehearsal_id":"a1b2c3d4e502","step_id":"s2","action":"replace","title":"仅执行计划内切主（node-1 -> node-2）","target_role":"在 node-1 (10.0.9.11) 上执行","command":"patronictl -c /etc/patroni/patroni.yml switchover pg-edit-step --leader node-1 --candidate node-2 --force","expect":"node-2 成为新 Leader","reason":"将切主与重启拆为两步以降低风险"}`)
	if !strings.Contains(res1, "演练步骤修订卡片") || len(proposed) != 1 {
		t.Fatalf("expected rehearsal_step proposal created, got res=%q proposed=%v", res1, proposed)
	}
	propID1 := proposed[0]

	// 3. Accept via API updates rehearsal on disk, adds revision, resets status to pending
	aw1 := storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/proposals/"+propID1+"/accept", nil, alice, csrf)
	if aw1.Code != 200 {
		t.Fatalf("accept replace proposal: %d %s", aw1.Code, aw1.Body.String())
	}
	after1, ok := s.loadRehearsal("pg-edit-step", "a1b2c3d4e502")
	if !ok || after1.Steps[1].Title != "仅执行计划内切主（node-1 -> node-2）" || after1.Steps[1].Status != "pending" || len(after1.Steps[1].Revisions) != 1 {
		t.Fatalf("unexpected step after replace accept: %+v", after1.Steps[1])
	}

	// 4. propose_rehearsal_step_edit (insert_after) inserts step #3 and renumbers orders cleanly
	res2 := tc.run("propose_rehearsal_step_edit", `{"rehearsal_id":"a1b2c3d4e502","step_id":"s2","action":"insert_after","title":"重启原主库 node-1","target_role":"在 node-2 (10.0.9.12) 上执行","command":"patronictl -c /etc/patroni/patroni.yml restart pg-edit-step node-1 --pending --force","expect":"node-1 重启完成且无 Pending restart","reason":"独立重启原主库便于逐项核验"}`)
	if len(proposed) != 2 {
		t.Fatalf("expected 2nd proposal created, got res=%q proposed=%v", res2, proposed)
	}
	aw2 := storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/proposals/"+proposed[1]+"/accept", nil, alice, csrf)
	if aw2.Code != 200 {
		t.Fatalf("accept insert_after proposal: %d %s", aw2.Code, aw2.Body.String())
	}
	after2, _ := s.loadRehearsal("pg-edit-step", "a1b2c3d4e502")
	if len(after2.Steps) != 3 || after2.Steps[2].Order != 3 || after2.Steps[2].Title != "重启原主库 node-1" {
		t.Fatalf("unexpected steps after insert_after: %+v", after2.Steps)
	}
}

func TestRehearsalQuickModeAndChangeReport(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	cw := storeCreate(t, s, alice, csrf, `{"id":"pg-quick-test","hosts":[{"name":"node-1","ip":"10.0.10.11"},{"name":"node-2","ip":"10.0.10.12"},{"name":"node-3","ip":"10.0.10.13"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["node-1","node-2","node-3"]}}]}`, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create job: %d %s", cw.Code, cw.Body.String())
	}
	var job storeJob
	_ = json.Unmarshal(cw.Body.Bytes(), &job)
	_ = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)

	// Mock model: 1) auto -> resolved_mode="quick" returning direct steps; 2) explicit mode="quick" returning direct steps
	autoQuickResp := `{"resolved_mode":"quick","thinking":"用户仅调整 Patroni DCS 热参数 synchronous_node_count=1，无需重启或切主且现场参数已知，直接走极速变更生成执行步骤。","title":"调整同步副本数为 1","scope_summary":"将 Patroni DCS synchronous_node_count 调整为 1，允许单备异常时不阻塞主库写入。","steps":[{"id":"s1","phase":"execute","order":1,"title":"修改 DCS 同步副本数参数","target_role":"任一数据节点（如 node-1 / 10.0.10.11）","command":"patronictl -c /etc/patroni/patroni.yml edit-config --force -s synchronous_node_count=1","expect":"Configuration changed 且 show-config 显示 synchronous_node_count: 1","caution":"热生效，无需重启 PostgreSQL","rollback":"patronictl -c /etc/patroni/patroni.yml edit-config --force -s synchronous_node_count=2"},{"id":"s2","phase":"verify","order":2,"title":"核验参数生效与同步流复制健康","target_role":"当前主库（node-1 / 10.0.10.11）","command":"patronictl -c /etc/patroni/patroni.yml list && patronictl -c /etc/patroni/patroni.yml show-config | grep -i synchronous","expect":"三节点健康 Lag=0，synchronous_node_count 为 1"},{"id":"r1","phase":"rollback","order":3,"title":"回退 synchronous_node_count 至原值","target_role":"任一数据节点（node-1 / 10.0.10.11）","command":"patronictl -c /etc/patroni/patroni.yml edit-config --force -s synchronous_node_count=2","expect":"参数恢复原值","optional":true}]}`
	srv, _ := fakeModel(t, autoQuickResp, autoQuickResp)
	enableAI(t, s, srv.URL, 1)

	// 1. Test mode="auto" -> resolved_mode="quick" skips scoping & probing directly into stage="rehearsing"
	w1 := storeRequest(s, "POST", "/api/clusters/pg-quick-test/rehearsals",
		strings.NewReader(`{"goal":"把 synchronous_node_count 改为 1，避免单备机维护时阻塞写入","mode":"auto"}`), alice, csrf)
	if w1.Code != 201 {
		t.Fatalf("auto quick create: %d %s", w1.Code, w1.Body.String())
	}
	var rh1 changeRehearsal
	if err := json.Unmarshal(w1.Body.Bytes(), &rh1); err != nil {
		t.Fatalf("decode rh1: %v", err)
	}
	if rh1.Mode != "quick" || rh1.Stage != "rehearsing" || len(rh1.Steps) != 3 {
		t.Fatalf("expected auto->quick directly in rehearsing with 3 steps, got mode=%q stage=%q steps=%d", rh1.Mode, rh1.Stage, len(rh1.Steps))
	}

	// 1b. Test explicit mode="quick" also skips scoping & probing directly into stage="rehearsing"
	w1b := storeRequest(s, "POST", "/api/clusters/pg-quick-test/rehearsals",
		strings.NewReader(`{"goal":"把 synchronous_node_count 改为 1","mode":"quick"}`), alice, csrf)
	if w1b.Code != 201 {
		t.Fatalf("explicit quick create: %d %s", w1b.Code, w1b.Body.String())
	}
	var rh1b changeRehearsal
	_ = json.Unmarshal(w1b.Body.Bytes(), &rh1b)
	if rh1b.Mode != "quick" || rh1b.Stage != "rehearsing" || len(rh1b.Steps) != 3 {
		t.Fatalf("expected explicit quick in rehearsing with 3 steps, got mode=%q stage=%q steps=%d", rh1b.Mode, rh1b.Stage, len(rh1b.Steps))
	}

	// 2. Mark forward steps passed and finalize -> archived as a Change Report ("变更报告") in Cluster Docs
	for _, st := range rh1.Steps {
		if st.Phase == "rollback" {
			continue
		}
		uw := storeRequest(s, "PATCH", "/api/clusters/pg-quick-test/rehearsals/"+rh1.ID+"/steps/"+st.ID,
			strings.NewReader(`{"status":"passed","note":"现场验证通过"}`), alice, csrf)
		if uw.Code != 200 {
			t.Fatalf("mark step %s passed: %d %s", st.ID, uw.Code, uw.Body.String())
		}
	}
	fw := storeRequest(s, "POST", "/api/clusters/pg-quick-test/rehearsals/"+rh1.ID+"/finalize",
		strings.NewReader(`{}`), alice, csrf)
	if fw.Code != 200 {
		t.Fatalf("finalize quick rehearsal: %d %s", fw.Code, fw.Body.String())
	}
	var finalized changeRehearsal
	_ = json.Unmarshal(fw.Body.Bytes(), &finalized)
	if finalized.Stage != "finalized" || finalized.DocID == "" {
		t.Fatalf("expected finalized with doc_id, got %+v", finalized)
	}
	dw := storeRequest(s, "GET", "/api/clusters/pg-quick-test/docs/"+finalized.DocID, nil, alice, "")
	if dw.Code != 200 {
		t.Fatalf("get quick change report doc: %d %s", dw.Code, dw.Body.String())
	}
	docBody := dw.Body.String()
	if !strings.Contains(docBody, "变更报告") || !strings.Contains(docBody, "极速变更") {
		t.Fatalf("expected Change Report title & quick mode cover row, got: %s", docBody)
	}

	// 3. Test propose_rehearsal tool normalizes and preserves mode="quick"
	s.mu.Lock()
	job = s.jobs[job.ID]
	s.mu.Unlock()
	proposed := []string{}
	tc := aiToolCtx{s: s, job: job, user: "alice", session: "review", proposed: &proposed}
	out := tc.run("propose_rehearsal", `{"cluster_id":"pg-quick-test","mode":"quick","kind":"tune","title":"调整同步副本数为 1","goal":"修改 synchronous_node_count=1","summary":"热改 DCS 参数并归档变更报告","reason":"涉及配置变更，需留存变更报告"}`)
	if !strings.Contains(out, "变更演练发起卡片 #") || len(proposed) != 1 {
		t.Fatalf("expected quick propose_rehearsal card, got out=%q proposed=%v", out, proposed)
	}
	props := s.loadProposals(job.ID)
	if len(props) != 1 || props[0].Rehearsal == nil || props[0].Rehearsal.Mode != "quick" {
		t.Fatalf("expected persisted rehearsal proposal with mode=quick, got %+v", props)
	}
}

func TestAIResolveArchivesStandaloneChangeReport(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	cw := storeCreate(t, s, alice, csrf, `{"id":"pg-chg-doc","hosts":[{"name":"node-1","ip":"10.0.11.11"},{"name":"node-2","ip":"10.0.11.12"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["node-1","node-2"]}}]}`, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create job: %d %s", cw.Code, cw.Body.String())
	}
	var job storeJob
	_ = json.Unmarshal(cw.Body.Bytes(), &job)
	_ = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)

	// Confirm a Change Report directly via /api/jobs/{id}/ai/resolve
	payload := `{"key":"review","report":{"title":"调整 Patroni synchronous_node_count 参数","symptom":"单备机重启期间主库写入等待超时","cause":"synchronous_node_count=2 要求两台从库同时在线","fix":"在 node-1 执行：\n\n` + "```bash\\npatronictl -c /etc/patroni/patroni.yml edit-config --force -s synchronous_node_count=1\\n```" + `\n\n执行后 show-config 验证已生效。","evidence":"Configuration changed\nsynchronous_node_count: 1","changed":false,"followups":["观察下次维护窗口备机重启期间业务写入延迟"]}}`
	rw := storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/resolve", strings.NewReader(payload), alice, csrf)
	if rw.Code != 200 {
		t.Fatalf("ai resolve: %d %s", rw.Code, rw.Body.String())
	}
	var rep aiReport
	if err := json.Unmarshal(rw.Body.Bytes(), &rep); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	if !strings.HasPrefix(rep.DocID, "chg-") {
		t.Fatalf("expected standalone chg-* doc_id on running cluster, got %+v", rep)
	}

	// Verify it appears in Cluster Docs list with kind="change" & manual=true
	lw := storeRequest(s, "GET", "/api/clusters/pg-chg-doc/docs", nil, alice, "")
	if lw.Code != 200 || !strings.Contains(lw.Body.String(), rep.DocID) || !strings.Contains(lw.Body.String(), "调整 Patroni synchronous_node_count 参数") {
		t.Fatalf("expected chg-* doc in cluster docs list, got %d %s", lw.Code, lw.Body.String())
	}

	// Verify full document content renders structured sections and code block
	dw := storeRequest(s, "GET", "/api/clusters/pg-chg-doc/docs/"+rep.DocID, nil, alice, "")
	if dw.Code != 200 {
		t.Fatalf("get chg doc: %d %s", dw.Code, dw.Body.String())
	}
	body := dw.Body.String()
	for _, must := range []string{"变更报告", "synchronous_node_count=1", "Configuration changed", "观察下次维护窗口"} {
		if !strings.Contains(body, must) {
			t.Fatalf("expected %q in chg doc body, got: %s", must, body)
		}
	}

	// Verify manual deletion cleans up the standalone Change Report
	delw := storeRequest(s, "DELETE", "/api/clusters/pg-chg-doc/docs/"+rep.DocID, nil, alice, csrf)
	if delw.Code != 200 {
		t.Fatalf("delete chg doc: %d %s", delw.Code, delw.Body.String())
	}
	dwAfter := storeRequest(s, "GET", "/api/clusters/pg-chg-doc/docs/"+rep.DocID, nil, alice, "")
	if dwAfter.Code != 404 {
		t.Fatalf("expected 404 after deleting chg doc, got %d", dwAfter.Code)
	}
}

func TestAuditRehearsalRestorations(t *testing.T) {
	// 1. Detects all 7 unrestored temporary changes across forward steps (ignores rollback phase)
	dirtySteps := []rehearsalStep{
		{ID: "s1", Phase: "execute", Title: "开启维护模式并摘流", Command: "patronictl -c /etc/patroni/patroni.yml pause && echo 'set server pg_backend/node-2 state maint' | socat stdio /run/haproxy/admin.sock"},
		{ID: "s2", Phase: "execute", Title: "临时放宽同步与开调试日志并停备机监控", Command: "patronictl edit-config --force -s synchronous_mode=false -p log_statement=all && systemctl stop keepalived.service"},
		{ID: "s3", Phase: "execute", Title: "计划内切主", Command: "patronictl -c /etc/patroni/patroni.yml switchover pg-prod --leader node-1 --candidate node-2 --force"},
		{ID: "s4", Phase: "verify", Title: "写测试表与测试 Key 验收", Command: "psql -c 'CREATE TABLE rehearsal_smoke_test(id int);' && redis-cli SET probe_test_key ok"},
		// Rollback phase containing resume/switchover MUST NOT silence forward restoration alerts!
		{ID: "r1", Phase: "rollback", Title: "回退", Command: "patronictl resume && patronictl switchover pg-prod --leader node-2 --candidate node-1 --force"},
	}
	alerts := auditRehearsalRestorations("PostgreSQL 日志落盘参数变更并滚动重启", "", dirtySteps, "zh-CN")
	gotKinds := map[string]int{}
	for _, a := range alerts {
		gotKinds[a.Kind]++
	}
	for _, want := range []string{"switchover", "maintenance_pause", "lb_drain", "sync_relaxed", "debug_log", "service_stopped", "temp_artifact"} {
		if gotKinds[want] == 0 {
			t.Fatalf("expected restoration alert kind %q, got %+v", want, alerts)
		}
	}
	if gotKinds["temp_artifact"] != 2 {
		t.Fatalf("expected 2 temp_artifact alerts (SQL table + Redis key), got %d (%+v)", gotKinds["temp_artifact"], alerts)
	}

	// 2. Clean plan with matching forward restoration & cleanup steps emits ZERO alerts!
	cleanSteps := []rehearsalStep{
		{ID: "s1", Phase: "execute", Title: "开启维护模式并摘流", Command: "patronictl pause && echo 'set server pg_backend/node-2 state maint' | socat stdio /run/haproxy/admin.sock"},
		{ID: "s2", Phase: "execute", Title: "临时调整同步与日志并停 keepalived", Command: "patronictl edit-config --force -s synchronous_mode=false -p log_statement=all && systemctl stop keepalived.service"},
		{ID: "s3", Phase: "execute", Title: "计划内切主重启原主", Command: "patronictl switchover pg-prod --leader node-1 --candidate node-2 --force"},
		{ID: "s4", Phase: "execute", Title: "切回原主库并恢复维护模式/同步/日志/服务/流量", Command: "patronictl switchover pg-prod --leader node-2 --candidate node-1 --force && patronictl resume && patronictl edit-config --force -s synchronous_mode=true -p log_statement=none && systemctl start keepalived.service && echo 'set server pg_backend/node-2 state ready' | socat stdio /run/haproxy/admin.sock"},
		{ID: "s5", Phase: "verify", Title: "写入验收并清理临时对象", Command: "psql -c 'CREATE TABLE rehearsal_smoke_test(id int); DROP TABLE IF EXISTS rehearsal_smoke_test;' && redis-cli SET probe_test_key ok && redis-cli DEL probe_test_key"},
	}
	if cleanAlerts := auditRehearsalRestorations("PostgreSQL 滚动升级", "", cleanSteps, "zh-CN"); len(cleanAlerts) != 0 {
		t.Fatalf("expected 0 alerts when all temporary states are restored, got %+v", cleanAlerts)
	}

	// 3. Respects explicit user intent (permanent switchover or intentional synchronous_mode change -> no false positive!)
	permSteps := []rehearsalStep{
		{ID: "s1", Phase: "execute", Title: "修改同步策略", Command: "patronictl edit-config --force -s synchronous_mode=false"},
		{ID: "s2", Phase: "execute", Title: "永久迁主到 node-2", Command: "patronictl switchover pg-prod --leader node-1 --candidate node-2 --force"},
	}
	if permAlerts := auditRehearsalRestorations("永久迁主到新机房 node-2 并关闭同步复制", "", permSteps, "zh-CN"); len(permAlerts) != 0 {
		t.Fatalf("expected 0 false positives when user explicitly requested permanent switchover & sync change, got %+v", permAlerts)
	}
}

func TestRehearsalApplyProductionReflectsInClusterDocsAndAI(t *testing.T) {
	s, _ := testStore(t)
	enableAI(t, s, "http://127.0.0.1:1", 1)
	alice, csrf := storeLogin(t, s, "alice")
	cw := storeCreate(t, s, alice, csrf, `{"id":"pg-apply-sync","hosts":[{"name":"node-1","ip":"10.0.12.11"},{"name":"node-2","ip":"10.0.12.12"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["node-1","node-2"]}}]}`, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create job: %d %s", cw.Code, cw.Body.String())
	}
	var job storeJob
	_ = json.Unmarshal(cw.Body.Bytes(), &job)
	_ = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)

	rh := changeRehearsal{
		ID:           "a1b2c3d4e599",
		ClusterID:    "pg-apply-sync",
		AppID:        "etcd",
		AppName:      "etcd",
		BaseJobID:    job.ID,
		Title:        "PostgreSQL 日志落盘参数调整",
		Goal:         "开启 logging_collector 并将日志目录改为 /data/logs/postgresql",
		ScopeSummary: "在线调整 DCS 日志参数并滚动生效",
		Owner:        "alice",
		Mode:         "full",
		Stage:        "rehearsing",
		Drift: &rehearsalDrift{
			Summary: "初始 logging_collector=off",
			ParamDiffs: []rehearsalDriftParam{
				{Key: "logging_collector", Initial: "off", Actual: "off"},
			},
		},
		Steps: []rehearsalStep{
			{
				ID:         "s1",
				Phase:      "execute",
				Order:      1,
				Title:      "修改 DCS 日志参数",
				TargetRole: "node-1",
				Command:    "patronictl -c /etc/patroni/patroni.yml edit-config --force -p logging_collector=on -p log_directory=/data/logs/postgresql",
				Expect:     "Configuration changed",
				Status:     "passed",
			},
		},
		CreatedAt: nowStamp(),
		UpdatedAt: nowStamp(),
	}
	if err := s.saveRehearsal(rh); err != nil {
		t.Fatalf("save seed rehearsal: %v", err)
	}

	// 1. Applying before finalize must be rejected (409)
	early := storeRequest(s, "POST", "/api/clusters/pg-apply-sync/rehearsals/"+rh.ID+"/apply", strings.NewReader(`{"applied":true}`), alice, csrf)
	if early.Code != 409 {
		t.Fatalf("expected 409 before finalize, got %d %s", early.Code, early.Body.String())
	}

	// 2. Finalize first, then mark applied to production (auto-extracting param deltas + operator note)
	fw := storeRequest(s, "POST", "/api/clusters/pg-apply-sync/rehearsals/"+rh.ID+"/finalize", strings.NewReader(`{}`), alice, csrf)
	if fw.Code != 200 {
		t.Fatalf("finalize: %d %s", fw.Code, fw.Body.String())
	}
	aw := storeRequest(s, "POST", "/api/clusters/pg-apply-sync/rehearsals/"+rh.ID+"/apply",
		strings.NewReader(`{"applied":true,"note":"CHG-20261124 低峰窗口已执行完成"}`), alice, csrf)
	if aw.Code != 200 {
		t.Fatalf("apply prod: %d %s", aw.Code, aw.Body.String())
	}
	var applied changeRehearsal
	if err := json.Unmarshal(aw.Body.Bytes(), &applied); err != nil {
		t.Fatalf("decode applied: %v", err)
	}
	if !applied.Applied || applied.AppliedBy != "alice" || len(applied.AppliedChanges) < 2 {
		t.Fatalf("expected applied=true with auto-extracted logging_collector & log_directory changes, got %+v", applied)
	}

	// 3. Reflects in ClusterView (/api/clusters?id=...)
	clw := storeRequest(s, "GET", "/api/clusters?id=pg-apply-sync", nil, alice, "")
	if clw.Code != 200 {
		t.Fatalf("get clusters: %d %s", clw.Code, clw.Body.String())
	}
	var views []clusterView
	_ = json.Unmarshal(clw.Body.Bytes(), &views)
	if len(views) != 1 || views[0].AppliedChangesCount != 1 || views[0].LastChangeTitle != "PostgreSQL 日志落盘参数调整" {
		t.Fatalf("expected clusterView to reflect 1 applied change, got %+v", views)
	}

	// 4. Reflects in main Delivery Report (/docs/delivery) AND Change SOP (/docs/sop-...)
	delDoc := storeRequest(s, "GET", "/api/clusters/pg-apply-sync/docs/delivery", nil, alice, "")
	if delDoc.Code != 200 {
		t.Fatalf("get delivery doc: %d %s", delDoc.Code, delDoc.Body.String())
	}
	for _, must := range []string{"已落地生效", "logging_collector", "/data/logs/postgresql"} {
		if !strings.Contains(delDoc.Body.String(), must) {
			t.Fatalf("expected delivery report to contain %q, got: %s", must, delDoc.Body.String())
		}
	}
	sopDoc := storeRequest(s, "GET", "/api/clusters/pg-apply-sync/docs/sop-"+rh.ID, nil, alice, "")
	if sopDoc.Code != 200 || !strings.Contains(sopDoc.Body.String(), "已实施落地") || !strings.Contains(sopDoc.Body.String(), "CHG-20261124") {
		t.Fatalf("expected SOP doc to contain production sign-off & note, got %d %s", sopDoc.Code, sopDoc.Body.String())
	}

	// 5. Reflects in AI baseline context (clusterBaselinePrompt) & deliveryLifecycleFacts
	f, ok := s.clusterFactsFor("alice", "pg-apply-sync")
	if !ok {
		t.Fatalf("facts not found")
	}
	basePrompt, _ := s.clusterBaselinePrompt(f)
	if !strings.Contains(basePrompt, "投产后已确认落地的生产变更") || !strings.Contains(basePrompt, "logging_collector: off -> on") {
		t.Fatalf("expected clusterBaselinePrompt to include applied change overlay, got:\n%s", basePrompt)
	}
	lcFacts := s.deliveryLifecycleFacts(job.ID)
	if !strings.Contains(lcFacts, "已落地生效") || !strings.Contains(lcFacts, "logging_collector: off -> on") {
		t.Fatalf("expected deliveryLifecycleFacts to include applied production changes, got:\n%s", lcFacts)
	}

	// 6. Reverting applied status clears clusterView count cleanly
	uw := storeRequest(s, "POST", "/api/clusters/pg-apply-sync/rehearsals/"+rh.ID+"/apply", strings.NewReader(`{"applied":false}`), alice, csrf)
	if uw.Code != 200 {
		t.Fatalf("unapply prod: %d %s", uw.Code, uw.Body.String())
	}
	clw2 := storeRequest(s, "GET", "/api/clusters?id=pg-apply-sync", nil, alice, "")
	var views2 []clusterView
	_ = json.Unmarshal(clw2.Body.Bytes(), &views2)
	if len(views2) != 1 || views2[0].AppliedChangesCount != 0 {
		t.Fatalf("expected clusterView applied_changes_count=0 after revert, got %+v", views2)
	}
}

func TestRehearsalVoidConflictDetectionAndEffectiveMerge(t *testing.T) {
	s, _ := testStore(t)
	enableAI(t, s, "http://127.0.0.1:1", 1)
	alice, csrf := storeLogin(t, s, "alice")
	cw := storeCreate(t, s, alice, csrf, `{"id":"pg-multi-guard","hosts":[{"name":"node-1","ip":"10.0.13.11"},{"name":"node-2","ip":"10.0.13.12"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["node-1","node-2"]}}]}`, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create job: %d %s", cw.Code, cw.Body.String())
	}
	var job storeJob
	_ = json.Unmarshal(cw.Body.Bytes(), &job)
	_ = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)

	seed := func(id, title, cmd, created string) changeRehearsal {
		rh := changeRehearsal{
			ID:        id,
			ClusterID: "pg-multi-guard",
			AppID:     "etcd",
			AppName:   "etcd",
			BaseJobID: job.ID,
			Title:     title,
			Goal:      title,
			Owner:     "alice",
			Mode:      "full",
			Stage:     "rehearsing",
			Steps: []rehearsalStep{{
				ID:         "s1",
				Phase:      "execute",
				Order:      1,
				Title:      title,
				TargetRole: "node-1",
				Command:    cmd,
				Expect:     "ok",
				Status:     "passed",
			}},
			CreatedAt: created,
			UpdatedAt: created,
		}
		if err := s.saveRehearsal(rh); err != nil {
			t.Fatalf("save %s: %v", id, err)
		}
		return rh
	}

	// Plan A & Plan B both drafted on the same initial baseline and both touch logging_collector
	seed("aa0000000001", "方案A：日志大小设为 500MB", "patronictl edit-config --force -p logging_collector=on -p log_rotation_size=500MB", "2026-11-23T08:00:00Z")
	seed("bb0000000002", "方案B：日志大小设为 1GB", "patronictl edit-config --force -p logging_collector=on -p log_rotation_size=1GB", "2026-11-23T08:05:00Z")
	seed("cc0000000003", "方案C：已放弃的旧 HBA 草案", "patronictl edit-config --force -p max_connections=500", "2026-11-23T07:50:00Z")

	// Finalize all 3 on initial baseline
	for _, id := range []string{"aa0000000001", "bb0000000002", "cc0000000003"} {
		fw := storeRequest(s, "POST", "/api/clusters/pg-multi-guard/rehearsals/"+id+"/finalize", strings.NewReader(`{}`), alice, csrf)
		if fw.Code != 200 {
			t.Fatalf("finalize %s: %d %s", id, fw.Code, fw.Body.String())
		}
	}

	// 1. Apply Plan A AND atomically supersede Plan C via supersede_ids
	awA := storeRequest(s, "POST", "/api/clusters/pg-multi-guard/rehearsals/aa0000000001/apply",
		strings.NewReader(`{"applied":true,"changes":[{"key":"logging_collector","before":"off","after":"on"},{"key":"log_rotation_size","before":"10MB","after":"500MB"}],"supersede_ids":["cc0000000003"]}`),
		alice, csrf)
	if awA.Code != 200 {
		t.Fatalf("apply A: %d %s", awA.Code, awA.Body.String())
	}

	// Verify Plan C is now voided & superseded by Plan A, and locked against /apply (409)
	gwC := storeRequest(s, "GET", "/api/clusters/pg-multi-guard/rehearsals/cc0000000003", nil, alice, "")
	var rhC changeRehearsal
	_ = json.Unmarshal(gwC.Body.Bytes(), &rhC)
	if !rhC.Voided || rhC.SupersededBy != "aa0000000001" || rhC.SupersededTitle != "方案A：日志大小设为 500MB" {
		t.Fatalf("expected C voided & superseded by A, got %+v", rhC)
	}
	lockedC := storeRequest(s, "POST", "/api/clusters/pg-multi-guard/rehearsals/cc0000000003/apply", strings.NewReader(`{"applied":true}`), alice, csrf)
	if lockedC.Code != 409 {
		t.Fatalf("expected 409 when applying voided plan C, got %d %s", lockedC.Code, lockedC.Body.String())
	}

	// 2. Opening Plan B must surface a "conflict" alert because Plan A landed after B's baseline and overlaps logging_collector + log_rotation_size!
	gwB := storeRequest(s, "GET", "/api/clusters/pg-multi-guard/rehearsals/bb0000000002", nil, alice, "")
	var rhB changeRehearsal
	_ = json.Unmarshal(gwB.Body.Bytes(), &rhB)
	foundConflict := false
	for _, al := range rhB.ConflictAlerts {
		if al.Severity == "conflict" && al.OtherID == "aa0000000001" && len(al.OverlappingKeys) >= 2 {
			foundConflict = true
		}
	}
	if !foundConflict {
		t.Fatalf("expected conflict alert on B referencing A with >=2 overlapping keys, got %+v", rhB.ConflictAlerts)
	}

	// 3. Voiding an already-applied plan (A) must be rejected (409); restoring C back to pending must succeed (200)
	badVoidA := storeRequest(s, "POST", "/api/clusters/pg-multi-guard/rehearsals/aa0000000001/void", strings.NewReader(`{"voided":true}`), alice, csrf)
	if badVoidA.Code != 409 {
		t.Fatalf("expected 409 when voiding already-applied A, got %d", badVoidA.Code)
	}
	restC := storeRequest(s, "POST", "/api/clusters/pg-multi-guard/rehearsals/cc0000000003/void", strings.NewReader(`{"voided":false}`), alice, csrf)
	if restC.Code != 200 {
		t.Fatalf("restore C: %d %s", restC.Code, restC.Body.String())
	}
	// Re-void C manually with explicit reason
	voidC := storeRequest(s, "POST", "/api/clusters/pg-multi-guard/rehearsals/cc0000000003/void", strings.NewReader(`{"voided":true,"reason":"窗口取消，暂不执行"}`), alice, csrf)
	if voidC.Code != 200 {
		t.Fatalf("manual void C: %d %s", voidC.Code, voidC.Body.String())
	}

	// 4. Now apply Plan B with updated log_rotation_size=1GB (later timestamp) and verify effective merge in AI baseline & Delivery Report
	time.Sleep(15 * time.Millisecond)
	awB := storeRequest(s, "POST", "/api/clusters/pg-multi-guard/rehearsals/bb0000000002/apply",
		strings.NewReader(`{"applied":true,"changes":[{"key":"log_rotation_size","before":"500MB","after":"1GB"}]}`),
		alice, csrf)
	if awB.Code != 200 {
		t.Fatalf("apply B: %d %s", awB.Code, awB.Body.String())
	}

	// Ensure effectiveAppliedChanges folds log_rotation_size: initial 10MB -> latest 1GB (UpdateCount=2)
	f, ok := s.clusterFactsFor("alice", "pg-multi-guard")
	if !ok {
		t.Fatalf("facts missing")
	}
	basePrompt, _ := s.clusterBaselinePrompt(f)
	if !strings.Contains(basePrompt, "log_rotation_size: 10MB -> 1GB") || !strings.Contains(basePrompt, "累计调整 2 次") {
		t.Fatalf("expected merged effective change in clusterBaselinePrompt, got:\n%s", basePrompt)
	}
	delDoc := storeRequest(s, "GET", "/api/clusters/pg-multi-guard/docs/delivery", nil, alice, "")
	if delDoc.Code != 200 {
		t.Fatalf("delivery doc: %d", delDoc.Code)
	}
	body := delDoc.Body.String()
	for _, must := range []string{"已作废", `"log_rotation_size","10MB","1GB"`, "累计调整 2 次"} {
		if !strings.Contains(body, must) {
			t.Fatalf("expected delivery report to contain %q, got:\n%s", must, body)
		}
	}
}

func TestRehearsalExtractQuotedPatroniParamsAndHBARuleAndNoFalseCollision(t *testing.T) {
	logPlan := changeRehearsal{
		ID:    "a32a2e5bacbe",
		Title: "PostgreSQL 日志落盘到 /data/logs/postgresql",
		Stage: "finalized",
		Drift: &rehearsalDrift{
			ParamDiffs: []rehearsalDriftParam{
				{Key: "logging_collector", Actual: "off（default）"},
				{Key: "log_filename", Actual: "postgresql-%Y-%m-%d_%H%M%S.log（default）"},
			},
		},
		Steps: []rehearsalStep{
			{ID: "s2", Phase: "execute", Status: "passed", Note: "三节点均已创建目录。", Command: "install -d /data/logs/postgresql"},
			{ID: "s3", Phase: "execute", Status: "passed", Note: "已写入日志参数。", Command: "patronictl -c /etc/patroni/patroni.yml edit-config pg --force -p logging_collector=on -p 'log_filename=postgresql-%Y-%m-%d.log' -p log_rotation_size=1048576"},
		},
	}
	hbaPlan := changeRehearsal{
		ID:    "c35b325abae5",
		Title: "Patroni 集群共享 pg_hba 补充 127.0.0.1 replicator 复制规则",
		Stage: "finalized",
		Drift: &rehearsalDrift{
			ParamDiffs: []rehearsalDriftParam{
				{Key: "patroni 动态配置 postgresql.pg_hba 中目标规则", Actual: "缺失（三节点 count=0）"},
			},
		},
		Steps: []rehearsalStep{
			{
				ID:      "s2",
				Phase:   "execute",
				Status:  "passed",
				Title:   "备份动态配置，生成含全部原规则的补丁并应用",
				Command: `patronictl -c /etc/patroni/patroni.yml show-config > /tmp/hba.yml; python3 -c 't="hostssl replication replicator 127.0.0.1/32 scram-sha-256"' ; patronictl -c /etc/patroni/patroni.yml edit-config --force --apply /tmp/hba-patch.yml`,
			},
		},
	}

	sum, logChanges := extractDefaultAppliedChanges(logPlan)
	if strings.Contains(sum, "。；") {
		t.Fatalf("expected clean summary without double punctuation, got %q", sum)
	}
	foundFilename := false
	for _, ch := range logChanges {
		if ch.Key == "log_filename" && ch.After == "postgresql-%Y-%m-%d.log" && strings.Contains(ch.Before, "H%M%S") {
			foundFilename = true
		}
	}
	if !foundFilename {
		t.Fatalf("expected quoted log_filename to be extracted cleanly, got %+v", logChanges)
	}

	_, hbaChanges := extractDefaultAppliedChanges(hbaPlan)
	if len(hbaChanges) != 1 || hbaChanges[0].Key != "pg_hba" || hbaChanges[0].After != "+ hostssl replication replicator 127.0.0.1/32 scram-sha-256" || !strings.Contains(hbaChanges[0].Before, "缺失") {
		t.Fatalf("expected exact HBA rule (not step title) and drift before value, got %+v", hbaChanges)
	}

	// Applying logPlan MUST NOT trigger a false "conflict" on hbaPlan (they touch distinct keys; only "stale" cluster update!)
	logPlan.Applied = true
	logPlan.AppliedAt = "2026-11-23T15:00:00Z"
	logPlan.AppliedChanges = logChanges
	hbaPlan.CreatedAt = "2026-11-23T14:30:00Z"
	alerts := computeRehearsalConflicts(hbaPlan, []changeRehearsal{logPlan, hbaPlan}, "zh-CN")
	for _, al := range alerts {
		if al.Severity == "conflict" {
			t.Fatalf("expected NO false conflict between logging_collector plan and pg_hba plan, got %+v", al)
		}
	}
}

func TestRehearsalIntentUnclearGateAndRefineGoal(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	cw := storeCreate(t, s, alice, csrf, `{"id":"pg-refine-test","hosts":[{"name":"node-1","ip":"10.0.15.11"},{"name":"node-2","ip":"10.0.15.12"},{"name":"node-3","ip":"10.0.15.13"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["node-1","node-2","node-3"]}}]}`, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create job: %d %s", cw.Code, cw.Body.String())
	}
	var job storeJob
	_ = json.Unmarshal(cw.Body.Bytes(), &job)
	_ = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)

	// 1x1 valid PNG data URLs with distinct pixel payloads so their sha256 filenames differ.
	img1 := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII="
	img2 := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

	// 1) Create with vague goal + screenshot: even if model sets resolved_mode="light" alongside intent_unclear=true,
	//    backend MUST enforce stage="scoping", mode="full", intent_unclear=true!
	respUnclear := `{"thinking":"用户只写看这个截图有点问题，需先核对识别到的 pg_hba 报错与处理意图。","intent_unclear":true,"resolved_mode":"light","title":"排查 node-3 replicator 拒绝连接","scope_summary":"从截图识别到 node-3 上 replicator 经 127.0.0.1 被 pg_hba 拒绝，请先确认处理意图。","probe_script":"#!/usr/bin/env bash\nhostname -s","questions":[{"id":"q1","label":"意图核对","question":"截图识别到 node-3 pg_hba 拒绝 replicator，确认本次目标？","options":["补齐 pg_hba 规则并 reload 修复","仅只读排查定位原因，不改配置","识别有偏，改按我的真实需求推进（补充真实诉求）"]}]}`
	// 2) Submit scope after confirming intent: should receive ScopeSummary + GoalImages and clear intent_unclear!
	respScopeProbe := `{"thinking":"已结合识别摘要与截图定制单屏只读探针。","probe_script":"#!/usr/bin/env bash\nif [ -z \"${BASH_VERSION:-}\" ]; then exec bash \"$0\" \"$@\"; fi\nset -uo pipefail\nhostname -s\n","probe_notes":["单屏输出"]}`
	// 3) Refine goal with explicit clear intent -> mode="auto" routes cleanly to light & resets stale probe output!
	respRefinedLight := `{"thinking":"用户修正诉求为明确调整 max_connections，且需先核实现场配置 -> resolved_mode=light。","intent_unclear":false,"resolved_mode":"light","title":"确认并调优 max_connections","scope_summary":"先核实现场 max_connections 与内存余量，再决定调整方案。","probe_script":"#!/usr/bin/env bash\nif [ -z \"${BASH_VERSION:-}\" ]; then exec bash \"$0\" \"$@\"; fi\nset -uo pipefail\nhostname -s\n","probe_notes":["单屏采集"]}`

	srv, seen := fakeModel(t, respUnclear, respScopeProbe, respRefinedLight)
	enableAI(t, s, srv.URL, 1)

	// Step 1: Create with vague prompt + img1
	createBody, _ := json.Marshal(map[string]any{
		"goal":   "看这个截图有点问题",
		"mode":   "auto",
		"images": []string{img1},
	})
	w1 := storeRequest(s, "POST", "/api/clusters/pg-refine-test/rehearsals", strings.NewReader(string(createBody)), alice, csrf)
	if w1.Code != 201 {
		t.Fatalf("create unclear rehearsal: %d %s", w1.Code, w1.Body.String())
	}
	var rh1 changeRehearsal
	if err := json.Unmarshal(w1.Body.Bytes(), &rh1); err != nil {
		t.Fatalf("decode rh1: %v", err)
	}
	if rh1.Stage != "scoping" || rh1.Mode != "full" || !rh1.IntentUnclear || len(rh1.ScopeQuestions) != 1 {
		t.Fatalf("expected intent_unclear hard gate to land in scoping/full, got stage=%s mode=%s unclear=%v qs=%d", rh1.Stage, rh1.Mode, rh1.IntentUnclear, len(rh1.ScopeQuestions))
	}
	if len(rh1.GoalImages) != 1 {
		t.Fatalf("expected 1 stored goal image, got %v", rh1.GoalImages)
	}
	origImgName := rh1.GoalImages[0]

	// Step 2: Submit scope -> verifies ScopeSummary & GoalImages forwarded to AI and IntentUnclear cleared!
	scopeBody := `{"answers":[{"id":"q1","question":"截图识别到 node-3 pg_hba 拒绝 replicator，确认本次目标？","answer":"补齐 pg_hba 规则并 reload 修复"}]}`
	w2 := storeRequest(s, "POST", "/api/clusters/pg-refine-test/rehearsals/"+rh1.ID+"/scope", strings.NewReader(scopeBody), alice, csrf)
	if w2.Code != 200 {
		t.Fatalf("submit scope: %d %s", w2.Code, w2.Body.String())
	}
	var rh2 changeRehearsal
	_ = json.Unmarshal(w2.Body.Bytes(), &rh2)
	if rh2.Stage != "probing" || rh2.IntentUnclear {
		t.Fatalf("expected probing with IntentUnclear=false after scope confirm, got stage=%s unclear=%v", rh2.Stage, rh2.IntentUnclear)
	}
	if len(*seen) < 2 || !strings.Contains((*seen)[1], "从截图识别到 node-3 上 replicator") || !strings.Contains((*seen)[1], "data:image/") {
		t.Fatalf("expected scope->probe AI request to carry ScopeSummary and GoalImages, got:\n%s", (*seen)[1])
	}

	// Seed a stale probe_output to ensure refine resets it cleanly.
	rehearsalMu.Lock()
	seed, _ := s.loadRehearsal("pg-refine-test", rh1.ID)
	seed.ProbeOutput = "stale probe output"
	_ = s.saveRehearsal(seed)
	rehearsalMu.Unlock()

	// Step 3: Refine goal (drop origImgName, attach img2, rewrite goal clearly)
	refineBody, _ := json.Marshal(map[string]any{
		"goal":        "实际上截图我传错了，我想核实现场 max_connections 参数并做在线评估",
		"mode":        "auto",
		"keep_images": []string{},
		"add_images":  []string{img2},
	})
	w3 := storeRequest(s, "POST", "/api/clusters/pg-refine-test/rehearsals/"+rh1.ID+"/refine", strings.NewReader(string(refineBody)), alice, csrf)
	if w3.Code != 200 {
		t.Fatalf("refine rehearsal: %d %s", w3.Code, w3.Body.String())
	}
	var rh3 changeRehearsal
	_ = json.Unmarshal(w3.Body.Bytes(), &rh3)
	if rh3.ID != rh1.ID || rh3.Mode != "light" || rh3.Stage != "probing" || rh3.IntentUnclear {
		t.Fatalf("unexpected refined rehearsal state: id=%s mode=%s stage=%s unclear=%v", rh3.ID, rh3.Mode, rh3.Stage, rh3.IntentUnclear)
	}
	if rh3.Title != "确认并调优 max_connections" || rh3.ProbeOutput != "" || len(rh3.ScopeQuestions) != 0 {
		t.Fatalf("expected title updated and stale downstream state reset, got title=%q probeOut=%q qs=%d", rh3.Title, rh3.ProbeOutput, len(rh3.ScopeQuestions))
	}
	if len(rh3.GoalImages) != 1 || rh3.GoalImages[0] == origImgName {
		t.Fatalf("expected goal_images replaced with new img2 (old=%s), got %v", origImgName, rh3.GoalImages)
	}
	if _, err := os.Stat(filepath.Join(s.rehearsalImgDir("pg-refine-test", rh1.ID), origImgName)); !os.IsNotExist(err) {
		t.Fatalf("expected dropped old goal image %s to be cleaned up from disk", origImgName)
	}

	// Step 4: Refining a finalized rehearsal MUST return 409 Conflict!
	rehearsalMu.Lock()
	fin, _ := s.loadRehearsal("pg-refine-test", rh1.ID)
	fin.Stage = "finalized"
	_ = s.saveRehearsal(fin)
	rehearsalMu.Unlock()
	w4 := storeRequest(s, "POST", "/api/clusters/pg-refine-test/rehearsals/"+rh1.ID+"/refine", strings.NewReader(string(refineBody)), alice, csrf)
	if w4.Code != 409 {
		t.Fatalf("expected 409 when refining finalized rehearsal, got %d %s", w4.Code, w4.Body.String())
	}
}

func TestRehearsalPatchStepPreservesSubCommandsAndRecoversFlattened(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	cw := storeCreate(t, s, alice, csrf, `{"id":"pg-subcmd-test","hosts":[{"name":"node-1","ip":"10.0.12.11"},{"name":"node-2","ip":"10.0.12.12"},{"name":"node-3","ip":"10.0.12.13"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["node-1","node-2","node-3"]}}]}`, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create job: %d %s", cw.Code, cw.Body.String())
	}
	var job storeJob
	_ = json.Unmarshal(cw.Body.Bytes(), &job)
	_ = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)
	enableAI(t, s, "http://127.0.0.1:1", 1)

	// 1. Seed a rehearsal whose step has 3 sub-command boxes (non-rolling verify step).
	rid := "a1b2c3d4e5f6"
	rh := changeRehearsal{
		ID:        rid,
		ClusterID: "pg-subcmd-test",
		Title:     "验收三节点参数与日志",
		Goal:      "验证微调不合并子命令",
		Stage:     "rehearsing",
		Owner:     "alice",
		CreatedAt: nowStamp(),
		UpdatedAt: nowStamp(),
		Steps: []rehearsalStep{
			{
				ID:         "step-7",
				Phase:      "verify",
				Order:      1,
				Title:      "验收三节点参数、当日日志与写入入口并清理探针",
				TargetRole: "按各子命令框标注的机器执行；参数与日志验收必须覆盖三节点",
				Commands: []rehearsalStepCommand{
					{
						Label:      "三节点逐台以 root 执行: 参数及持续日志写入",
						TargetRole: "node-1 / node-2 / node-3",
						Command:    "(\nsudo -u postgres psql -At -c 'SHOW logging_collector;'\nsleep 2 && sudo -u postgres tail -n 6 /data/logs/postgresql/pg.log\n) </dev/null",
						Gate:       "确认三节点日志参数生效",
					},
					{
						Label:      "查看当前日志文件路径与最终集群健康",
						TargetRole: "node-1",
						Command:    "(\nsudo -u postgres psql -Atc 'SELECT pg_current_logfile();'\npatronictl -c /etc/patroni/patroni.yml list\n) </dev/null",
						Gate:       "确认集群角色健康",
					},
					{
						Label:      "清理临时采集探针",
						TargetRole: "node-1 / node-2 / node-3",
						Command:    "rm -f /tmp/collect-pg-*.sh",
					},
				},
				Status: "pending",
			},
		},
	}
	rh.Steps[0].Command = joinStepCommandsFallback(rh.Steps[0].Commands)
	rehearsalMu.Lock()
	if err := s.saveRehearsal(rh); err != nil {
		rehearsalMu.Unlock()
		t.Fatalf("save seed rehearsal: %v", err)
	}
	rehearsalMu.Unlock()

	// 2. Structured PATCH with commands array updates one block and preserves all 3 boxes + metadata.
	structPayload := `{
		"status": "pending",
		"commands": [
			{"label":"三节点逐台以 root 执行: 参数及持续日志写入","target_role":"node-1 / node-2 / node-3","command":"sudo -u postgres psql -At -c 'SHOW logging_collector;'\nsleep 1 && sudo -u postgres tail -n 5 /data/logs/postgresql/pg.log","gate":"确认三节点日志参数生效"},
			{"label":"查看当前日志文件路径与最终集群健康","target_role":"node-1","command":"sudo -u postgres psql -Atc 'SELECT pg_current_logfile();'\npatronictl -c /etc/patroni/patroni.yml list","gate":"确认集群角色健康"},
			{"label":"清理临时采集探针","target_role":"node-1 / node-2 / node-3","command":"rm -f /tmp/collect-pg-subcmd-*.sh"}
		]
	}`
	w1 := storeRequest(s, "PATCH", "/api/clusters/pg-subcmd-test/rehearsals/"+rid+"/steps/step-7", strings.NewReader(structPayload), alice, csrf)
	if w1.Code != 200 {
		t.Fatalf("structured PATCH failed: %d %s", w1.Code, w1.Body.String())
	}
	var got1 changeRehearsal
	_ = json.Unmarshal(w1.Body.Bytes(), &got1)
	if len(got1.Steps) != 1 || len(got1.Steps[0].Commands) != 3 {
		t.Fatalf("expected 3 preserved sub-commands after structured PATCH, got %d", len(got1.Steps[0].Commands))
	}
	if got1.Steps[0].Commands[0].TargetRole != "node-1 / node-2 / node-3" || got1.Steps[0].Commands[2].Command != "rm -f /tmp/collect-pg-subcmd-*.sh" {
		t.Fatalf("unexpected sub-commands after structured PATCH: %+v", got1.Steps[0].Commands)
	}

	// 3. Plain-text PATCH (like legacy editor / AI proposal) on multi-block `# Label\n(...)` MUST preserve all 3 boxes & metadata!
	plainJoined := strings.Replace(got1.Steps[0].Command, "tail -n 5", "tail -n 8", 1)
	pb, _ := json.Marshal(map[string]any{"command": plainJoined, "status": "pending"})
	w2 := storeRequest(s, "PATCH", "/api/clusters/pg-subcmd-test/rehearsals/"+rid+"/steps/step-7", bytes.NewReader(pb), alice, csrf)
	if w2.Code != 200 {
		t.Fatalf("plain PATCH failed: %d %s", w2.Code, w2.Body.String())
	}
	var got2 changeRehearsal
	_ = json.Unmarshal(w2.Body.Bytes(), &got2)
	if len(got2.Steps[0].Commands) != 3 {
		t.Fatalf("plain PATCH flattened sub-commands! expected 3, got %d (%+v)", len(got2.Steps[0].Commands), got2.Steps[0].Commands)
	}
	if got2.Steps[0].Commands[0].TargetRole != "node-1 / node-2 / node-3" || got2.Steps[0].Commands[0].Gate != "确认三节点日志参数生效" {
		t.Fatalf("plain PATCH lost target_role/gate metadata: %+v", got2.Steps[0].Commands[0])
	}

	// 4. Auto-recovery of an already-flattened multi-subshell step (even with prev == nil)
	recovered := splitFlattenedSubCommands(plainJoined, got2.Steps[0].TargetRole, nil, "zh-CN")
	if len(recovered) != 3 {
		t.Fatalf("expected recovery of 3 blocks from flattened command, got %d", len(recovered))
	}

	// 5. Normal single-box script with inline comments MUST NOT be falsely split
	normalScript := "# 创建目录\nmkdir -p /data/logs/postgresql\n\n# 修改属主\nchown postgres:postgres /data/logs/postgresql"
	if bad := splitFlattenedSubCommands(normalScript, "node-1", nil, "zh-CN"); len(bad) != 0 {
		t.Fatalf("normal single-box script was falsely split into %d blocks: %+v", len(bad), bad)
	}
}

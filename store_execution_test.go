package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"middleware-deployer/mwpack"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func executionFixture(t *testing.T) (*storeServer, executionDB, executionNode, executionRun) {
	t.Helper()
	root := t.TempDir()
	s := &storeServer{cfg: storeConfig{DataDir: root}, jobs: map[string]storeJob{}}
	n := executionNode{ID: "node-fixture", Name: "fixture", TokenHash: digest([]byte(strings.Repeat("t", 64))), Clusters: []string{"fixture"}, IPs: []string{"127.0.0.1"}, ControllerIP: "127.0.0.1", LastSeen: executionNow()}
	run := executionRun{ID: "run-fixture", Job: "fixture-job", Node: n.ID, Cluster: "fixture", State: "running", Created: executionNow(), Steps: []executionStep{{ID: "attempt-fixture", Key: "deploy/verify/instance-fixture/check", Title: "fixture", Playbook: "playbooks/check.yml", Timeout: 30, State: "leased", Hosts: []string{"local"}}}}
	d := executionDB{Nodes: map[string]executionNode{n.ID: n}, Runs: map[string]executionRun{run.ID: run}}
	_ = os.MkdirAll(s.jobDir(run.Job), 0700)
	s.jobs[run.Job] = storeJob{ID: run.Job, ClusterID: run.Cluster, State: "succeeded"}
	return s, d, n, run
}
func stepEvent(run executionRun, seq int, kind, text string) executionEvent {
	return executionEvent{Run: run.ID, Attempt: run.Steps[0].ID, Seq: seq, Kind: kind, Text: text, At: executionNow()}
}
func TestExecutionDurableEventsAndNoReplay(t *testing.T) {
	s, d, n, run := executionFixture(t)
	first := stepEvent(run, 1, "started", "")
	if e := s.applyExecutionEvent(&d, n, first); e != nil {
		t.Fatal(e)
	}
	if e := s.applyExecutionEvent(&d, n, first); e != nil {
		t.Fatal("retry ack", e)
	}
	tampered := first
	tampered.Text = "changed"
	if e := s.applyExecutionEvent(&d, n, tampered); e == nil {
		t.Fatal("event overwritten")
	}
	if e := s.applyExecutionEvent(&d, n, stepEvent(run, 3, "log", "out of order")); e == nil {
		t.Fatal("gap accepted")
	}
	foreign := n
	foreign.ID = "other-node"
	if e := s.applyExecutionEvent(&d, foreign, stepEvent(run, 2, "log", "wrong node")); e == nil {
		t.Fatal("wrong node accepted")
	}
	if e := s.saveExecutions(d); e != nil {
		t.Fatal(e)
	}
	restarted := &storeServer{cfg: s.cfg}
	got, e := restarted.readExecutions()
	if e != nil || got.Runs[run.ID].Steps[0].State != "running" {
		t.Fatal("restart lost running state", e)
	}
	stale := got.Nodes[n.ID]
	stale.LastSeen = time.Now().Add(-time.Hour).Format(time.RFC3339Nano)
	got.Nodes[n.ID] = stale
	if !activeExecution(got.Runs[run.ID]) {
		t.Fatal("disconnection released resource locks")
	}
	_ = s.saveExecutions(got)
	if !s.executionLocked(run.Job) {
		t.Fatal("live run not locked")
	}
}
func TestExecutionDoesNotTrustExitCodeAlone(t *testing.T) {
	for _, tc := range []struct{ name, output, want string }{{"missing", "", "unknown"}, {"passed", "playbook playbooks/check.yml\nstarted 2026-11-11 10:00:00 +0000\nRECAP\n  local ok=2 changed=0 unreachable=0 failed=0 skipped=0\nfinished 2026-11-11 10:00:01 +0000\nSTEP_RESULT {\"schema\":\"mwstep-result/v1\",\"step\":\"playbooks/check.yml\",\"status\":\"passed\"}\n", "succeeded"}, {"skipped", "playbook playbooks/check.yml\nstarted 2026-11-11 10:00:00 +0000\nRECAP\n  local ok=2 changed=0 unreachable=0 failed=0 skipped=0\nfinished 2026-11-11 10:00:01 +0000\nSTEP_RESULT {\"schema\":\"mwstep-result/v1\",\"step\":\"playbooks/check.yml\",\"status\":\"skipped\"}\n", "skipped"}, {"other-playbook", "playbook wrong.yml\nSTEP_RESULT {\"schema\":\"mwstep-result/v1\",\"step\":\"wrong.yml\",\"status\":\"passed\"}\n", "unknown"}} {
		t.Run(tc.name, func(t *testing.T) {
			s, d, n, run := executionFixture(t)
			_ = s.applyExecutionEvent(&d, n, stepEvent(run, 1, "started", ""))
			ev := stepEvent(run, 2, "finished", tc.output)
			code := 0
			ev.ExitCode = &code
			if e := s.applyExecutionEvent(&d, n, ev); e != nil {
				t.Fatal(e)
			}
			if got := d.Runs[run.ID].Steps[0].State; got != tc.want {
				t.Fatalf("%s != %s", got, tc.want)
			}
		})
	}
}
func TestExecutionPauseStopsAtBoundary(t *testing.T) {
	s, d, n, run := executionFixture(t)
	run.Pause = true
	run.Steps = append(run.Steps, executionStep{ID: "next-attempt", State: "pending"})
	d.Runs[run.ID] = run
	_ = s.applyExecutionEvent(&d, n, stepEvent(run, 1, "started", ""))
	ev := stepEvent(run, 2, "finished", "playbook playbooks/check.yml\nstarted 2026-11-11 10:00:00 +0000\nRECAP\n  local ok=2 changed=0 unreachable=0 failed=0 skipped=0\nfinished 2026-11-11 10:00:01 +0000\nSTEP_RESULT {\"schema\":\"mwstep-result/v1\",\"step\":\"playbooks/check.yml\",\"status\":\"passed\"}\n")
	code := 0
	ev.ExitCode = &code
	if e := s.applyExecutionEvent(&d, n, ev); e != nil {
		t.Fatal(e)
	}
	if d.Runs[run.ID].State != "paused" || d.Runs[run.ID].Steps[1].State != "pending" {
		t.Fatal("next step was not paused")
	}
}
func TestExecutionRunnerActualLocalAnsible(t *testing.T) {
	if testing.Short() {
		t.Skip("local Ansible integration")
	}
	if _, e := os.Stat("/usr/local/bin/ansible-playbook"); e != nil {
		t.Skip("requires locally installed ansible-playbook")
	}
	s, d, _, run := executionFixture(t)
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "bin"), 0700)
	if e := os.Symlink("/usr/local/bin/ansible-playbook", filepath.Join(root, "bin", "ansible-playbook")); e != nil {
		t.Fatal(e)
	}
	callback, e := os.ReadFile("mwpack/platform/files/mw_log.py")
	if e != nil {
		t.Fatal(e)
	}
	counter := filepath.Join(root, "invocations")
	snap := executionSnapshot{Schema: "mwexecution/v1", Job: run.Job, Cluster: run.Cluster, Project: "fixture", ControllerIP: "127.0.0.1", Hosts: []mwpack.Host{{Name: "local", IP: "127.0.0.1"}}, Files: map[string][]byte{
		"ansible.cfg":                []byte("[defaults]\ncallback_plugins = callback_plugins\ncallbacks_enabled = mw_log\nretry_files_enabled = False\n"),
		"inventory/hosts.yml":        []byte("all:\n  hosts:\n    local:\n      ansible_connection: local\n      ansible_python_interpreter: /usr/bin/python3\n"),
		"callback_plugins/mw_log.py": callback,
		"playbooks/check.yml":        []byte("- hosts: all\n  gather_facts: false\n  vars:\n    _mw_step_playbook: playbooks/check.yml\n  tasks:\n    - name: Record execution count in isolated fixture\n      ansible.builtin.shell: echo once >> " + counter + "\n      register: result\n  post_tasks:\n    - name: Verify result\n      ansible.builtin.assert:\n        that: result.rc == 0\n"),
	}}
	b, _ := json.Marshal(snap)
	run.Snapshot = digest(b)
	d.Runs[run.ID] = run
	if e = s.saveExecutions(d); e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(http.HandlerFunc(s.handleExecutionAgent))
	defer server.Close()
	runner, e := newExecutionRunner(executionRunnerConfig{URL: server.URL, Token: strings.Repeat("t", 64), Root: root})
	if e != nil {
		t.Fatal(e)
	}
	work := executionWork{Run: run, Step: run.Steps[0], Snapshot: snap}
	if e = runner.execute(work); e != nil {
		t.Fatal(e)
	}
	if e = runner.execute(work); e != nil {
		t.Fatal(e)
	}
	if e = runner.recoverOutbox(); e != nil {
		t.Fatal(e)
	}
	actual, e := os.ReadFile(counter)
	if e != nil || strings.Count(string(actual), "once") != 1 {
		got, _ := s.readExecutions()
		st := got.Runs[run.ID].Steps[0]
		t.Fatal("command not executed once", string(actual), e, st, string(s.executionLog(run.ID, st)))
	}
	got, e := s.readExecutions()
	if e != nil {
		t.Fatal(e)
	}
	st := got.Runs[run.ID].Steps[0]
	if st.State != "succeeded" || len(st.Recap) != 1 {
		t.Fatalf("real callback result missing: %+v\n%s", st, s.executionLog(run.ID, st))
	}
	if rec := s.readProgress(run.Job).Steps[st.Key]; rec.Source != "automatic" || rec.Attempt != st.ID {
		t.Fatal("projection missing", rec)
	}
}
func TestExecutionScopeAndPaths(t *testing.T) {
	_, _, n, _ := executionFixture(t)
	snap := executionSnapshot{Cluster: "fixture", ControllerIP: "127.0.0.1", Hosts: []mwpack.Host{{IP: "127.0.0.1"}}}
	if !executionNodeAllows(n, snap) {
		t.Fatal("valid scope rejected")
	}
	snap.Hosts = append(snap.Hosts, mwpack.Host{IP: "10.0.0.2"})
	if executionNodeAllows(n, snap) {
		t.Fatal("unauthorized host")
	}
	for _, p := range []string{"../escape", "/etc/passwd", "a/../../x", "a/./x", "secrets/../file", "a\\b"} {
		if executionRelative(p) {
			t.Fatal("unsafe path", p)
		}
	}
}

func TestExecutionLogRecoveryKeepsCursorAndMasksBeforeChunking(t *testing.T) {
	_, _, _, run := executionFixture(t)
	root := t.TempDir()
	runner, e := newExecutionRunner(executionRunnerConfig{URL: "http://127.0.0.1:1", Token: strings.Repeat("t", 64), Root: root})
	if e != nil {
		t.Fatal(e)
	}
	project := filepath.Join(root, "projects", ".hub-"+run.ID)
	secrets := filepath.Join(root, "projects", "fixture", "secrets")
	os.MkdirAll(filepath.Join(project, "logs"), 0700)
	os.MkdirAll(secrets, 0700)
	secret := "isolated-secret-456789012345678901234567890"
	os.WriteFile(filepath.Join(secrets, "test-password"), []byte(secret), 0600)
	content := "playbook playbooks/check.yml\n" + strings.Repeat("x", 23950) + secret + "\n" + strings.Repeat("字", 12000) + "\n"
	log := filepath.Join(project, "logs", "check.log")
	os.WriteFile(log, []byte(content), 0600)
	j := executionJournal{Work: executionWork{Run: run, Step: run.Steps[0], Snapshot: executionSnapshot{Project: "fixture"}}, Phase: "running", Offsets: map[string]int{}}
	if e = runner.save(j); e != nil {
		t.Fatal(e)
	}
	if e = runner.collect(&j, project, true); e != nil {
		t.Fatal(e)
	}
	files, _ := runner.eventFiles(run.Steps[0].ID)
	if len(files) < 2 {
		t.Fatal("fixture must cross multiple event chunks")
	}
	var batch []queuedExecutionEvent
	for _, path := range files {
		b, _ := os.ReadFile(path)
		if strings.Contains(string(b), secret) {
			t.Fatal("credential crossed an event boundary unmasked")
		}
		var ev queuedExecutionEvent
		if e = json.Unmarshal(b, &ev); e != nil {
			t.Fatal(e)
		}
		batch = append(batch, ev)
	}
	// Simulate dying halfway through materializing an atomic log batch, before
	// its receipt offset was saved. Recovery must fill the missing event only.
	if e = atomicExecutionJSON(filepath.Join(runner.dir(run.Steps[0].ID), "logbatch-000001.json"), batch); e != nil {
		t.Fatal(e)
	}
	os.Remove(files[len(files)-1])
	j.Offsets = map[string]int{}
	if e = runner.recoverQueuedLogs(run.Steps[0].ID); e != nil {
		t.Fatal(e)
	}
	if e = runner.recoverLogOffsets(&j); e != nil {
		t.Fatal(e)
	}
	if e = runner.collect(&j, project, true); e != nil {
		t.Fatal(e)
	}
	after, _ := runner.eventFiles(run.Steps[0].ID)
	if len(after) != len(files) || j.Offsets[log] != len(content) {
		t.Fatal("log replay or lost cursor", len(after), j.Offsets)
	}
}

func TestExecutionRuntimeMismatchStopsBeforeLaunch(t *testing.T) {
	_, _, _, run := executionFixture(t)
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "bin"), 0700)
	os.WriteFile(filepath.Join(root, "bin", "ansible-playbook"), []byte("#!/bin/sh\nexit 99\n"), 0700)
	runner, e := newExecutionRunner(executionRunnerConfig{URL: "http://127.0.0.1:1", Token: strings.Repeat("t", 64), Root: root})
	if e != nil {
		t.Fatal(e)
	}
	snap := executionSnapshot{Schema: "mwexecution/v1", Project: "fixture", ControllerIP: "127.0.0.1", RuntimeFiles: map[string]string{"bin/ansible-playbook": digest([]byte("different runtime"))}}
	raw, _ := json.Marshal(snap)
	run.Snapshot = digest(raw)
	if _, e = runner.prepare(executionWork{Run: run, Step: run.Steps[0], Snapshot: snap}); e == nil || !strings.Contains(e.Error(), "运行环境与本次交付不一致") {
		t.Fatal("runtime mismatch not stopped", e)
	}
}

func TestExecutionMissingHostRecapIsNotSuccess(t *testing.T) {
	s, d, n, run := executionFixture(t)
	run.Steps[0].Hosts = append(run.Steps[0].Hosts, "missing-host")
	d.Runs[run.ID] = run
	if e := s.applyExecutionEvent(&d, n, stepEvent(run, 1, "started", "")); e != nil {
		t.Fatal(e)
	}
	ev := stepEvent(run, 2, "finished", "playbook playbooks/check.yml\nstarted 2026-11-11 10:00:00 +0000\nRECAP\n  local ok=2 changed=0 unreachable=0 failed=0 skipped=0\nfinished 2026-11-11 10:00:01 +0000\nSTEP_RESULT {\"schema\":\"mwstep-result/v1\",\"step\":\"playbooks/check.yml\",\"status\":\"passed\"}\n")
	code := 0
	ev.ExitCode = &code
	if e := s.applyExecutionEvent(&d, n, ev); e != nil {
		t.Fatal(e)
	}
	if d.Runs[run.ID].Steps[0].State == "succeeded" {
		t.Fatal("partial host evidence accepted")
	}
}
func TestExecutionAgentAuthentication(t *testing.T) {
	s, d, _, _ := executionFixture(t)
	_ = s.saveExecutions(d)
	r := httptest.NewRequest("POST", "http://test/api/execution-agent/poll", strings.NewReader("{}"))
	w := httptest.NewRecorder()
	s.handleExecutionAgent(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	r = httptest.NewRequest("POST", "http://test/api/execution-agent/poll", strings.NewReader("{}"))
	r.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 64))
	w = httptest.NewRecorder()
	s.handleExecutionAgent(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	if perm, ok := routePermFor("POST", "/api/jobs/j/executions"); !ok || perm != "delivery.execute" {
		t.Fatal("missing execution permission", perm)
	}
	if perm, ok := routePermFor("POST", "/api/settings/execution-nodes"); !ok || perm != "execution.manage" {
		t.Fatal("missing node permission", perm)
	}
}

// A killed local launcher cannot prove that a remote operation stopped.
// Retain the resource lock and never restart the attempt automatically.
func TestExecutionTimeoutRetainsUncertainAttempt(t *testing.T) {
	s, d, _, run := executionFixture(t)
	root := t.TempDir()
	if e := os.MkdirAll(filepath.Join(root, "bin"), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(root, "bin", "ansible-playbook"), []byte("#!/bin/sh\necho once >> invocations\nsleep 10\n"), 0700); e != nil {
		t.Fatal(e)
	}
	run.Steps[0].Timeout = 1
	snap := executionSnapshot{Schema: "mwexecution/v1", Job: run.Job, Cluster: run.Cluster, Project: "fixture", ControllerIP: "127.0.0.1", Hosts: []mwpack.Host{{Name: "local", IP: "127.0.0.1"}}, Files: map[string][]byte{"playbooks/check.yml": []byte("[]\n")}}
	b, _ := json.Marshal(snap)
	run.Snapshot = digest(b)
	d.Runs[run.ID] = run
	if e := s.saveExecutions(d); e != nil {
		t.Fatal(e)
	}
	srv := httptest.NewServer(http.HandlerFunc(s.handleExecutionAgent))
	defer srv.Close()
	runner, e := newExecutionRunner(executionRunnerConfig{URL: srv.URL, Token: strings.Repeat("t", 64), Root: root})
	if e != nil {
		t.Fatal(e)
	}
	work := executionWork{Run: run, Step: run.Steps[0], Snapshot: snap}
	if e = runner.execute(work); e != nil {
		t.Fatal(e)
	}
	got, e := s.readExecutions()
	if e != nil {
		t.Fatal(e)
	}
	if got.Runs[run.ID].State != "unknown" || !s.executionLocked(run.Job) {
		t.Fatal("timeout released uncertain remote execution", got.Runs[run.ID])
	}
	if e = runner.execute(work); e != nil {
		t.Fatal(e)
	}
	data, e := os.ReadFile(filepath.Join(root, "projects", ".hub-"+run.ID, "invocations"))
	if e != nil || string(data) != "once\n" {
		t.Fatal("timed out attempt restarted", string(data), e)
	}
}

func TestExecutionNodeBinaryFallbackServesValidLinuxAMD64ELF(t *testing.T) {
	if runtime.GOOS == "linux" && runtime.GOARCH == "amd64" {
		t.Skip("linux/amd64 serves /proc/self/exe directly")
	}
	s, _ := testStore(t)
	s.cfg.ArtifactsDir = t.TempDir()
	admin, _ := storeLogin(t, s, "admin")
	w := storeRequest(s, "GET", "/api/settings/execution-nodes/binary", nil, admin, "")
	if w.Code != 404 {
		t.Fatalf("expected 404 when linux binary missing, got %d: %s", w.Code, w.Body.String())
	}
	binPath := filepath.Join(s.cfg.ArtifactsDir, "middleware-store-linux-amd64")
	// Reject non-ELF files (e.g., PE/corrupt).
	if e := os.WriteFile(binPath, []byte("MZ-not-an-elf-binary-at-all"), 0755); e != nil {
		t.Fatal(e)
	}
	w = storeRequest(s, "GET", "/api/settings/execution-nodes/binary", nil, admin, "")
	if w.Code != 404 {
		t.Fatalf("non-ELF binary was accepted: %d", w.Code)
	}
	elfStub := make([]byte, 64)
	elfStub[0], elfStub[1], elfStub[2], elfStub[3] = 0x7f, 'E', 'L', 'F'
	elfStub[4], elfStub[5] = 2, 1       // 64-bit little endian
	elfStub[18], elfStub[19] = 0x3e, 0x00 // EM_X86_64
	if e := os.WriteFile(binPath, elfStub, 0755); e != nil {
		t.Fatal(e)
	}
	w = storeRequest(s, "GET", "/api/settings/execution-nodes/binary", nil, admin, "")
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), elfStub) {
		t.Fatalf("failed serving staged ELF binary: code=%d len=%d", w.Code, w.Body.Len())
	}
}

func TestPrepareManagedTrustDetailedIsolatesPerHostErrors(t *testing.T) {
	if runtime.GOOS == "windows" {
		// execution_trust_runner enforces 0700 / 0022 POSIX directory permissions via os.Lstat.
		t.Skip("POSIX mode permission bits checked on Linux")
	}
	s, d, n, _ := executionFixture(t)
	d.Runs = map[string]executionRun{}
	n.Protocol = 2
	n.Kind = "embedded"
	n.IPs = []string{"127.0.0.1", "10.0.1.12", "10.0.1.13"}
	n.Grants = map[string][]string{"fixture": {"127.0.0.1", "10.0.1.12", "10.0.1.13"}}
	d.Nodes[n.ID] = n
	a2 := targetAgent{ID: "agent-db-2", Node: n.ID, Job: "fixture-job", Cluster: "fixture", Host: "db-2", IP: "10.0.1.12", Desired: "active"}
	a3 := targetAgent{ID: "agent-db-3", Node: n.ID, Job: "fixture-job", Cluster: "fixture", Host: "db-3", IP: "10.0.1.13", Desired: "active"}
	d.Agents = map[string]targetAgent{a2.ID: a2, a3.ID: a3}
	p := executionPreparation{
		ID: "prepare-multi-agent", Job: "fixture-job", Node: n.ID, Created: executionNow(),
		State: "pending", NodeRevision: executionNodeRevision(n),
		Snapshot: executionSnapshot{
			Job: "fixture-job", Cluster: "fixture", ControllerIP: n.ControllerIP,
			Hosts: []mwpack.Host{{Name: "db-1", IP: n.ControllerIP}, {Name: "db-2", IP: "10.0.1.12"}, {Name: "db-3", IP: "10.0.1.13"}},
			AgentAccess: map[string]string{"db-2": a2.ID, "db-3": a3.ID},
		},
	}
	d.Preparations = map[string]executionPreparation{p.ID: p}
	if e := s.saveExecutions(d); e != nil {
		t.Fatal(e)
	}
	srv := httptest.NewServer(http.HandlerFunc(s.handleExecutionAgent))
	defer srv.Close()
	r, e := newExecutionRunner(executionRunnerConfig{URL: srv.URL, Token: strings.Repeat("t", 64), Root: t.TempDir()})
	if e != nil {
		t.Fatal(e)
	}
	_, hostErrs, err := r.prepareManagedTrustDetailed(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(hostErrs) != 2 || !strings.Contains(hostErrs["db-2"].Error(), "db-2 ") || !strings.Contains(hostErrs["db-3"].Error(), "db-3 ") {
		t.Fatalf("per-host trust errors leaked or merged: %+v", hostErrs)
	}
}

func TestCheckExecutionProbeWithHostsVerifiesResolution(t *testing.T) {
	hosts := []mwpack.Host{{Name: "pg-1", IP: "172.26.198.120"}, {Name: "pg-2", IP: "172.26.198.118"}}
	probe := executionProbe{
		UID: 0, Hostname: "pg-1", IPs: []string{"172.26.198.120"},
		OSID: "ubuntu", Version: "24.04", Arch: "x86_64", Python: []int{3, 12},
		Resolved: map[string][]string{"pg-1": {"172.26.198.120"}},
	}
	if e := checkExecutionProbeWithHosts(probe, hosts[0], "ubuntu-24.04-amd64", hosts); e == nil || !strings.Contains(e.Error(), "pg-2") {
		t.Fatalf("missing /etc/hosts entry was not rejected: %v", e)
	}
	probe.Resolved["pg-2"] = []string{"172.26.198.118"}
	if e := checkExecutionProbeWithHosts(probe, hosts[0], "ubuntu-24.04-amd64", hosts); e != nil {
		t.Fatalf("valid resolution rejected: %v", e)
	}
}

func TestLocalizeExecutionPrepTranslatesChecksAndMessages(t *testing.T) {
	p := executionPreparation{
		ID:    "prep1",
		State: "blocked",
		Checks: []executionCheck{
			{ID: "executor", Title: "执行机器与系统", State: "passed", Message: "检查通过"},
			{ID: "host:pg-2", Title: "连接、身份与运行权限", State: "blocked", Message: "pg-2 的 Agent 尚未确认公钥写入；请先连接 Agent，稍后重新检查"},
			{ID: "host:pg-3", Title: "连接、身份与运行权限", State: "blocked", Message: "连接或只读检查失败：Permission denied"},
		},
	}
	en := localizeExecutionPrep(langEnUS, p)
	if en.Checks[0].Title != "Execution Host & OS" || en.Checks[0].Message != "Checks passed" {
		t.Fatalf("executor check not localized: %+v", en.Checks[0])
	}
	if !strings.Contains(en.Checks[1].Message, "Agent on pg-2") {
		t.Fatalf("agent pending check not localized: %+v", en.Checks[1])
	}
	if en.Checks[2].Message != "Connection or read-only check failed: Permission denied" {
		t.Fatalf("connection failure check not localized: %+v", en.Checks[2])
	}
	zh := localizeExecutionPrep(langZhCN, p)
	if zh.Checks[0].Message != "检查通过" {
		t.Fatalf("zh-CN altered: %+v", zh.Checks[0])
	}
}

func TestProgressEnrichesExecutionPrepAndStepLogs(t *testing.T) {
	s, d, n, run := executionFixture(t)
	run.ExecutorName = n.Name
	d.Runs[run.ID] = run

	// Write a minimal output/plan.json with prepare steps so projectPreparationResult and enrichProgressWithExecutions discover them.
	outDir := filepath.Join(s.jobDir(run.Job), "output")
	if err := os.MkdirAll(outDir, 0700); err != nil {
		t.Fatal(err)
	}
	planJSON := `{"step_format":2,"delivery_mode":"automatic","prepare":[{"id":"verify-upload","title":"核对上传"},{"id":"unpack-n1","title":"解包 n1"},{"id":"bootstrap-runtime","title":"初始化运行环境"}]}`
	if err := os.WriteFile(filepath.Join(outDir, "plan.json"), []byte(planJSON), 0600); err != nil {
		t.Fatal(err)
	}

	prep := executionPreparation{
		ID:           "prep-1",
		Job:          run.Job,
		Node:         n.ID,
		ExecutorName: "exec-controller",
		State:        "ready",
		Created:      executionNow(),
		Finished:     executionNow(),
		Checks: []executionCheck{
			{ID: "executor", Title: "执行节点与操作系统", State: "passed", Message: "检查通过"},
			{ID: "target-n1", Title: "目标机 n1", State: "passed", Message: "检查通过"},
		},
	}
	d.Preparations = map[string]executionPreparation{prep.ID: prep}

	// Simulate successful execution step with recap + logs.
	if err := s.applyExecutionEvent(&d, n, stepEvent(run, 1, "started", "")); err != nil {
		t.Fatal(err)
	}
	ev := stepEvent(run, 2, "finished", "playbook playbooks/check.yml\nstarted 2026-11-11 10:00:00 +0000\nRECAP\n  local ok=2 changed=1 unreachable=0 failed=0 skipped=0\nfinished 2026-11-11 10:00:03 +0000\nSTEP_RESULT {\"schema\":\"mwstep-result/v1\",\"step\":\"playbooks/check.yml\",\"status\":\"passed\"}\n")
	code := 0
	ev.ExitCode = &code
	if err := s.applyExecutionEvent(&d, n, ev); err != nil {
		t.Fatal(err)
	}
	if err := s.saveExecutions(d); err != nil {
		t.Fatal(err)
	}

	s.projectPreparationResult(prep)
	s.projectExecutionResult(d.Runs[run.ID], run.Steps[0].ID)

	doc := s.readProgress(run.Job)
	doc = s.enrichProgressWithExecutions(run.Job, doc)

	for _, pk := range []string{"prepare/verify-upload", "prepare/unpack-n1", "prepare/bootstrap-runtime"} {
		st, ok := doc.Steps[pk]
		if !ok || st.State != "done" {
			t.Fatalf("prep step %s not projected as done: %+v", pk, st)
		}
		if st.Source != "automatic" || st.Executor != "exec-controller" || !strings.Contains(st.Log, "执行节点与操作系统") {
			t.Fatalf("prep step %s missing check metadata/log: %+v", pk, st)
		}
	}

	execRec, ok := doc.Steps["deploy/verify/instance-fixture/check"]
	if !ok {
		t.Fatalf("executed step missing from progress: %+v", doc.Steps)
	}
	if execRec.State != "done" || execRec.Source != "automatic" || execRec.Execution != run.ID || execRec.Attempt != run.Steps[0].ID {
		t.Fatalf("executed step missing execution linkage: %+v", execRec)
	}
	if execRec.AutoState != "succeeded" || execRec.LogSeq != 2 || execRec.ExitCode == nil || *execRec.ExitCode != 0 {
		t.Fatalf("executed step missing auto metadata: %+v", execRec)
	}
	if len(execRec.Recap) != 1 || execRec.Recap[0].Host != "local" || execRec.Recap[0].OK != 2 || execRec.Recap[0].Changed != 1 {
		t.Fatalf("executed step missing recap: %+v", execRec.Recap)
	}
	rawRecap, _ := json.Marshal(execRec.Recap[0])
	if !strings.Contains(string(rawRecap), `"host":"local"`) || !strings.Contains(string(rawRecap), `"ok":2`) || !strings.Contains(string(rawRecap), `"changed":1`) {
		t.Fatalf("logRecap JSON tags must serialize lowercase keys, got: %s", string(rawRecap))
	}

	en := localizeProgressDoc(langEnUS, doc)
	if en.Steps["prepare/verify-upload"].By != "Execution node" {
		t.Fatalf("en-US By not localized: %q", en.Steps["prepare/verify-upload"].By)
	}
	if en.Steps["prepare/verify-upload"].Note != "Verified by execution pre-flight checks" {
		t.Fatalf("en-US prep note not localized: %q", en.Steps["prepare/verify-upload"].Note)
	}
}

func TestEffectiveDeliveryModeReflectsAutomatedRuns(t *testing.T) {
	autoJobs := map[string]bool{"job-auto-run": true}
	if got := effectiveDeliveryMode("job-auto-run", "offline", autoJobs); got != "automatic" {
		t.Fatalf("expected automated run job to resolve as automatic, got %q", got)
	}
	if got := effectiveDeliveryMode("job-auto-run", "", autoJobs); got != "automatic" {
		t.Fatalf("expected empty mode with automated run to resolve as automatic, got %q", got)
	}
	if got := effectiveDeliveryMode("job-manual", "offline", autoJobs); got != "offline" {
		t.Fatalf("expected manual offline job without runs to stay offline, got %q", got)
	}
	if got := effectiveDeliveryMode("job-explicit-auto", "automatic", map[string]bool{}); got != "automatic" {
		t.Fatalf("expected explicit automatic job without runs yet to stay automatic, got %q", got)
	}
	if got := effectiveDeliveryMode("job-cfg", "configuration", autoJobs); got != "configuration" {
		t.Fatalf("expected configuration job to stay configuration, got %q", got)
	}
}

func TestExecutionMonitorRunsAndIncrementalLog(t *testing.T) {
	s, _ := testStore(t)
	aliceCookie, _ := storeLogin(t, s, "alice")
	bobCookie, _ := storeLogin(t, s, "bob")

	jobRecov := storeJob{ID: "aa00112233445566aa00112233445566", Owner: "alice", AppID: "pg-ha", AppName: "PostgreSQL HA", Version: "17", ClusterID: "cl-recov", State: "succeeded", Created: "2026-11-19T01:00:00Z", Updated: "2026-11-19T01:10:00Z"}
	jobLive := storeJob{ID: "bb00112233445566bb00112233445566", Owner: "alice", AppID: "redis", AppName: "Redis", Version: "7.2", ClusterID: "cl-live", State: "succeeded", Created: "2026-11-19T02:00:00Z", Updated: "2026-11-19T02:05:00Z"}
	s.mu.Lock()
	s.jobs[jobRecov.ID] = jobRecov
	s.jobs[jobLive.ID] = jobLive
	s.mu.Unlock()

	node := executionNode{
		ID: "node-mon-1", Name: "runner-1", Clusters: []string{"cl-recov", "cl-live"},
		ControllerIP: "10.0.0.1", LastSeen: executionNow(),
	}
	runFail := executionRun{
		ID: "runfail00001111", Job: jobRecov.ID, Cluster: "cl-recov", Node: node.ID, By: "alice",
		Created: "2026-11-19T01:01:00Z", Updated: "2026-11-19T01:02:00Z", State: "failed",
		Steps: []executionStep{
			{ID: "st-a1", Key: "deploy/a", Title: "Step A", State: "failed", Seq: 2},
			{ID: "st-b1", Key: "deploy/b", Title: "Step B", State: "pending"},
		},
	}
	runPass := executionRun{
		ID: "runpass00001111", Job: jobRecov.ID, Cluster: "cl-recov", Node: node.ID, By: "alice",
		Created: "2026-11-19T01:05:00Z", Updated: "2026-11-19T01:09:00Z", State: "completed",
		Steps: []executionStep{
			{ID: "st-a2", Key: "deploy/a", Title: "Step A", State: "succeeded", Seq: 1},
			{ID: "st-b2", Key: "deploy/b", Title: "Step B", State: "succeeded", Seq: 1},
		},
	}
	runLive := executionRun{
		ID: "runlive00002222", Job: jobLive.ID, Cluster: "cl-live", Node: node.ID, By: "alice",
		Created: "2026-11-19T02:01:00Z", Updated: "2026-11-19T02:02:00Z", State: "running",
		Steps: []executionStep{
			{ID: "st-r1", Key: "deploy/init", Title: "Init", State: "succeeded", Seq: 1},
			{ID: "st-r2", Key: "deploy/start", Title: "Start Redis", State: "running", Seq: 2},
		},
	}
	d := executionDB{
		Nodes: map[string]executionNode{node.ID: node},
		Runs:  map[string]executionRun{runFail.ID: runFail, runPass.ID: runPass, runLive.ID: runLive},
	}
	if err := s.saveExecutions(d); err != nil {
		t.Fatal(err)
	}
	// Seed incremental log events for st-r2 (including multibyte UTF-8 text).
	for _, ev := range []executionEvent{
		{Seq: 1, Kind: "log", At: executionNow(), Text: "PLAY [redis] ***\n步骤开始\n"},
		{Seq: 2, Kind: "log", At: executionNow(), Text: "TASK [start] ***\nok: [redis-1]\n"},
	} {
		p := s.executionPath("runs", runLive.ID, "st-r2", fmt.Sprintf("%06d.json", ev.Seq))
		if err := atomicExecutionJSON(p, ev); err != nil {
			t.Fatal(err)
		}
	}

	// 1. Alice sees both jobs, active job sorted first, recovered job marked "recovered".
	w := storeRequest(s, "GET", "/api/executions/runs", nil, aliceCookie, "")
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var res struct {
		Items         []executionMonitorItem `json:"items"`
		ActiveCount   int                    `json:"active_count"`
		OnlineRunners int                    `json:"online_runners"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.ActiveCount != 1 || res.OnlineRunners != 1 || len(res.Items) != 2 {
		t.Fatalf("unexpected summary: %+v", res)
	}
	if res.Items[0].Cluster != "cl-live" || !res.Items[0].Active || res.Items[0].RunningStepTitle != "Start Redis" || res.Items[0].DoneSteps != 1 || res.Items[0].TotalSteps != 2 {
		t.Fatalf("expected active job first, got: %+v", res.Items[0])
	}
	if res.Items[1].Cluster != "cl-recov" || res.Items[1].State != "recovered" || res.Items[1].FailedBatches != 1 || res.Items[1].RecoveredBatches != 1 || res.Items[1].DoneSteps != 2 {
		t.Fatalf("expected recovered job second, got: %+v", res.Items[1])
	}

	// 2. Bob cannot see Alice's execution runs.
	w = storeRequest(s, "GET", "/api/executions/runs", nil, bobCookie, "")
	if w.Code != 200 {
		t.Fatalf("expected 200 for bob, got %d", w.Code)
	}
	var bobRes struct {
		Items       []executionMonitorItem `json:"items"`
		ActiveCount int                    `json:"active_count"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &bobRes); err != nil {
		t.Fatal(err)
	}
	if len(bobRes.Items) != 0 || bobRes.ActiveCount != 0 {
		t.Fatalf("bob should not see alice runs: %+v", bobRes)
	}

	// 3. Incremental log streaming with ?offset= returns exact delta and headers.
	firstChunk := "PLAY [redis] ***\n步骤开始\n"
	secondChunk := "TASK [start] ***\nok: [redis-1]\n"
	w = storeRequest(s, "GET", "/api/jobs/"+jobLive.ID+"/executions/"+runLive.ID+"/logs/st-r2?offset="+strconv.Itoa(len(firstChunk)), nil, aliceCookie, "")
	if w.Code != 200 {
		t.Fatalf("expected 200 on offset log, got %d: %s", w.Code, w.Body.String())
	}
	if w.Body.String() != secondChunk {
		t.Fatalf("expected delta %q, got %q", secondChunk, w.Body.String())
	}
	if got := w.Header().Get("X-Log-Size"); got != strconv.Itoa(len(firstChunk)+len(secondChunk)) {
		t.Fatalf("unexpected X-Log-Size: %q", got)
	}
	if got := w.Header().Get("X-Step-State"); got != "running" {
		t.Fatalf("unexpected X-Step-State: %q", got)
	}
	// Offset at end returns empty body cleanly.
	w = storeRequest(s, "GET", "/api/jobs/"+jobLive.ID+"/executions/"+runLive.ID+"/logs/st-r2?offset="+strconv.Itoa(len(firstChunk)+len(secondChunk)), nil, aliceCookie, "")
	if w.Code != 200 || w.Body.Len() != 0 {
		t.Fatalf("expected empty 200 at EOF, got %d len=%d", w.Code, w.Body.Len())
	}
}

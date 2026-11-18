package main

import (
	"encoding/json"
	"middleware-deployer/mwpack"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

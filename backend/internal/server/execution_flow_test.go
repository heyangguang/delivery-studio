package server

import (
	"bytes"
	"encoding/json"
	"delivery-studio/mwpack"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecutionAuthorizationAndImmutableSelection(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	request := func(method, path string, body any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		return storeRequest(s, method, path, bytes.NewReader(raw), admin, csrf)
	}
	w := storeCreate(t, s, admin, csrf, `{"id":"execution-api","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	var j storeJob
	json.Unmarshal(w.Body.Bytes(), &j)
	j = s.jobs[j.ID]
	if j.State != "succeeded" {
		t.Fatal(j.State, j.Error)
	}
	path := "/api/jobs/" + j.ID + "/executions"
	w = request("POST", "/api/settings/execution-nodes", map[string]any{"name": "local fixture", "clusters": []string{j.ClusterID}, "controller_ip": "10.0.1.11", "ips": []string{"10.0.1.11"}})
	var registration struct {
		Node  executionNode
		Token string
	}
	json.Unmarshal(w.Body.Bytes(), &registration)
	if w.Code != 201 || registration.Node.TokenHash != "" || registration.Token == "" {
		t.Fatal(w.Code, w.Body.String())
	}
	agent := func(endpoint string, body any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest("POST", "http://localhost/api/execution-agent/"+endpoint, bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+registration.Token)
		w := httptest.NewRecorder()
		s.handleExecutionAgent(w, r)
		return w
	}
	if w = agent("poll", map[string]any{"heartbeat": true}); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	key, manual := "", ""
	for _, c := range s.executionChoices(j.ID) {
		if c.Available && key == "" {
			key = c.Key
		}
		if !c.Available {
			manual = c.Key
		}
	}
	if key == "" || manual == "" {
		t.Fatal("choices missing")
	}
	body := map[string]any{"node": registration.Node.ID, "keys": []string{key}, "revision": s.executionRevision(j.ID), "request": "request-api-test", "confirm": j.ClusterID, "prepared": true}
	body["revision"] = "stale"
	if w = request("POST", path, body); w.Code != 409 {
		t.Fatal("stale accepted", w.Code)
	}
	body["revision"] = s.executionRevision(j.ID)
	body["keys"] = []string{manual}
	if w = request("POST", path, body); w.Code != 409 {
		t.Fatal("manual step accepted", w.Code, w.Body.String())
	}
	body["keys"] = []string{key}
	s.mu.Lock()
	s.jobs["replacement-fixture"] = storeJob{ID: "replacement-fixture", Revises: j.ID, State: "queued"}
	s.mu.Unlock()
	if w = request("POST", path, body); w.Code != 409 || !strings.Contains(w.Body.String(), "替代修订") {
		t.Fatal("execution started while replacement was generating", w.Code, w.Body.String())
	}
	s.mu.Lock()
	delete(s.jobs, "replacement-fixture")
	s.mu.Unlock()
	w = request("POST", path, body)
	var run executionRun
	json.Unmarshal(w.Body.Bytes(), &run)
	if w.Code != 201 || len(run.Steps) != 1 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = request("POST", path, body); w.Code != 200 {
		t.Fatal("duplicate not deduplicated", w.Code, w.Body.String())
	}
	body["request"] = "request-conflict"
	if w = request("POST", path, body); w.Code != 409 {
		t.Fatal("conflict accepted", w.Code)
	}
	if w = request("PUT", "/api/jobs/"+j.ID+"/progress", map[string]string{"key": key, "state": "done"}); w.Code != 409 {
		t.Fatal("active plan mutation accepted", w.Code)
	}
	w = storeCreate(t, s, admin, csrf, `{"id":"execution-api","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]},"revises":"`+j.ID+`"`, nil)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "自动执行") {
		t.Fatal("active delivery replaced", w.Code, w.Body.String())
	}
	w = agent("poll", map[string]any{})
	var poll struct{ Work *executionWork }
	json.Unmarshal(w.Body.Bytes(), &poll)
	if w.Code != 200 || poll.Work == nil || poll.Work.Step.ID != run.Steps[0].ID {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request("PATCH", path+"/"+run.ID, map[string]string{"action": "pause"})
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	w = agent("poll", map[string]any{})
	json.Unmarshal(w.Body.Bytes(), &poll)
	if poll.Work == nil {
		t.Fatal("pause orphaned lease")
	}
	if w = request("PATCH", path+"/"+run.ID, map[string]string{"action": "close", "note": "test"}); w.Code != 409 {
		t.Fatal("unconfirmed lease released")
	}
	w = request("PATCH", "/api/settings/execution-nodes", map[string]any{"id": registration.Node.ID, "disabled": true})
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	w = agent("poll", map[string]any{})
	poll.Work = nil
	json.Unmarshal(w.Body.Bytes(), &poll)
	if poll.Work != nil {
		t.Fatal("disabled node received work")
	}
	ev := stepEvent(run, 1, "unknown", "")
	ev.Reason = "isolated test, command never started"
	if w = agent("event", ev); w.Code != 200 {
		t.Fatal("disabled node could not return evidence", w.Code, w.Body.String())
	}
	ev = stepEvent(run, 2, "stopped", "")
	ev.Reason = "verified no local or remote command was launched"
	if w = agent("event", ev); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if s.executionLocked(j.ID) {
		t.Fatal("reconciled run remained locked")
	}
	bob, bcsrf := storeLogin(t, s, "bob")
	if w = storeRequest(s, "POST", path, strings.NewReader("{}"), bob, bcsrf); w.Code != 403 {
		t.Fatal("execution permission bypassed", w.Code)
	}
	if perm, ok := routePermFor("GET", "/api/settings/execution-nodes/binary"); !ok || perm != "execution.manage" {
		t.Fatal(perm)
	}
	d, _ := s.readExecutions()
	old := d.Runs[run.ID]
	old.Revision = "obsolete"
	old.Steps[0].State = "succeeded"
	prog := s.readProgress(j.ID)
	delete(prog.Steps, key)
	s.writeProgress(j.ID, prog)
	s.projectExecutionResult(old, old.Steps[0].ID)
	if _, ok := s.readProgress(j.ID).Steps[key]; ok {
		t.Fatal("stale evidence reintroduced")
	}
}

func TestConfigurationDeliveryDoesNotNeedRuntimeOrExecute(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	c, _ := s.plat.cat().Get("redis")
	c.DeliveryModes = []string{"configuration"}
	c.Configuration = []mwpack.ConfigurationOutput{{Path: "redis.conf", Content: "bind ${host.ip}\nport ${params.redis_port}\n"}}
	bundle, _, sample, err := renderSample(s.plat.cat(), "redis", previewReq{})
	if err != nil || sample.DeliveryMode != "configuration" {
		t.Fatal("configuration preview failed", err)
	}
	if len(bundle.Project) == 0 {
		t.Fatal("preview has no configuration outputs")
	}
	for path := range bundle.Project {
		if strings.HasPrefix(path, "playbooks/") || strings.HasPrefix(path, "roles/") {
			t.Fatal("configuration preview generated executable files", path)
		}
	}
	// Package/runtime availability must not prevent a configuration-only author
	// from reaching the creation form. Its install coverage remains unchanged.
	s.plat.cfg.Runtimes = nil
	for _, entry := range s.plat.entries() {
		if entry.Name == "redis" && !entry.Available {
			t.Fatal("configuration component hidden by installation readiness", entry.Reason)
		}
	}
	spec := `{"id":"configuration-api","delivery_mode":"configuration","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"redis","component":"redis","placement":{"primary":["n1"]}}]}`
	w := storeRequest(s, "POST", "/api/resolve", strings.NewReader(spec), admin, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"missing":[]`) {
		t.Fatal(w.Code, w.Body.String())
	}
	w = storeCreate(t, s, admin, csrf, spec, nil)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	s.wg.Wait()
	var j storeJob
	json.Unmarshal(w.Body.Bytes(), &j)
	j = s.jobs[j.ID]
	if j.State != "succeeded" {
		t.Fatal(j.State, j.Error)
	}
	if _, e := os.Stat(filepath.Join(s.jobDir(j.ID), "output", "configuration.zip")); e != nil {
		t.Fatal(e)
	}
	if len(s.executionChoices(j.ID)) != 0 || len(s.runbookSteps(j.ID)) != 0 {
		t.Fatal("configuration was given executable steps")
	}
	if j.DeliveryMode != "configuration" || entryOf(j).DeliveryMode != "configuration" {
		t.Fatal("configuration delivery mode lost", j)
	}
	if _, code, _ := s.markOutcome(j.ID, "admin", outcomeDone, ""); code != 409 {
		t.Fatal("configuration reported as deployed", code)
	}
	srv, _ := fakeModel(t, "{}")
	enableAI(t, s, srv.URL, 0)
	if rw := storeRequest(s, "POST", "/api/clusters/"+j.ClusterID+"/rehearsals", strings.NewReader(`{"goal":"尝试在仅配置交付上发起变更演练"}`), admin, csrf); rw.Code != 409 || !strings.Contains(rw.Body.String(), "仅配置交付") {
		t.Fatalf("configuration allowed rehearsal: %d %s", rw.Code, rw.Body.String())
	}
	var b docBuilder
	s.executionSummary(&b, 1, j, s.readProgress(j.ID))
	raw, _ := json.Marshal(b.blocks)
	if !strings.Contains(string(raw), "没有自动运行") {
		t.Fatal(string(raw))
	}
}

func TestStoreRejectsWrongDeploymentSchema(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	spec := `{"schema":"mwpack/v1","id":"invalid-schema","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	w := storeCreate(t, s, admin, csrf, spec, nil)
	if w.Code == 202 {
		t.Fatal("unreadable deployment schema accepted")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.jobs) != 0 {
		t.Fatal("invalid submission reserved a delivery")
	}
}

func TestExecutionOutboxRecoversLostAcknowledgement(t *testing.T) {
	s, d, n, run := executionFixture(t)
	s.saveExecutions(d)
	lose := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/event") && lose {
			lose = false
			rec := httptest.NewRecorder()
			s.handleExecutionAgent(rec, r)
			if rec.Code != 200 {
				t.Errorf("event failed: %s", rec.Body.String())
			}
			w.WriteHeader(503)
			return
		}
		s.handleExecutionAgent(w, r)
	}))
	defer srv.Close()
	root := t.TempDir()
	runner, e := newExecutionRunner(executionRunnerConfig{URL: srv.URL, Token: strings.Repeat("t", 64), Root: root})
	if e != nil {
		t.Fatal(e)
	}
	journal := executionJournal{Work: executionWork{Run: run, Step: run.Steps[0]}, Phase: "starting"}
	runner.save(journal)
	if e = runner.emit(journal, "started", "", "local test runtime", nil); e != nil {
		t.Fatal(e)
	}
	if e = runner.flush(run.Steps[0].ID); e == nil {
		t.Fatal("lost ACK not simulated")
	}
	restarted, e := newExecutionRunner(runner.cfg)
	if e != nil {
		t.Fatal(e)
	}
	if e = restarted.recoverOutbox(); e != nil {
		t.Fatal(e)
	}
	got, _ := s.readExecutions()
	st := got.Runs[run.ID].Steps[0]
	if st.Seq != 2 || st.State != "unknown" {
		t.Fatal("duplicate or restarted", st)
	}
	if e = restarted.recoverOutbox(); e != nil {
		t.Fatal(e)
	}
	got, _ = s.readExecutions()
	if got.Runs[run.ID].Steps[0].Seq != 2 {
		t.Fatal("duplicate interruption")
	}
	if e = restarted.reconcile(st.ID, "local and remote processes verified stopped"); e != nil {
		t.Fatal(e)
	}
	got, _ = s.readExecutions()
	if got.Runs[run.ID].State != "failed" {
		t.Fatal("reconcile failed")
	}
	if publicExecutionNode(n).TokenHash != "" {
		t.Fatal("token digest exposed")
	}
}

package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"golang.org/x/crypto/ssh"
	"middleware-deployer/mwpack"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testTrustPublicKey(t *testing.T) string {
	t.Helper()
	pub, _, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	k, e := ssh.NewPublicKey(pub)
	if e != nil {
		t.Fatal(e)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k)))
}
func TestTargetTrustPreservesUserAccessAndRevokesOnlyOwnedKey(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ssh")
	_ = os.Mkdir(dir, 0700)
	existing := "# customer-managed entry\n" + testTrustPublicKey(t) + " admin@bastion\n"
	path := filepath.Join(dir, "authorized_keys")
	_ = os.WriteFile(path, []byte(existing), 0600)
	in := targetAgentInstruction{ID: "agent-test-one", Desired: "active", SourceIP: "10.0.0.5", PublicKey: testTrustPublicKey(t)}
	if e := applyTargetTrust(dir, in); e != nil {
		t.Fatal(e)
	}
	first, _ := os.ReadFile(path)
	if !bytes.Contains(first, []byte(existing)) || !bytes.Contains(first, []byte(`restrict,from="10.0.0.5"`)) {
		t.Fatal("lost user key or unscoped grant", string(first))
	}
	if e := applyTargetTrust(dir, in); e != nil {
		t.Fatal(e)
	}
	second, _ := os.ReadFile(path)
	if !bytes.Equal(first, second) {
		t.Fatal("not idempotent")
	}
	in.Desired = "revoked"
	if e := applyTargetTrust(dir, in); e != nil {
		t.Fatal(e)
	}
	got, _ := os.ReadFile(path)
	if string(got) != existing {
		t.Fatal("revocation changed customer access", string(got))
	}
	_ = os.Remove(path)
	target := filepath.Join(t.TempDir(), "untouched")
	_ = os.WriteFile(target, []byte(existing), 0600)
	_ = os.Symlink(target, path)
	in.Desired = "active"
	if e := applyTargetTrust(dir, in); e == nil {
		t.Fatal("authorized_keys symlink accepted")
	}
}
func TestTargetEnrollmentCannotMoveToAnotherMachine(t *testing.T) {
	s, d, n, run := executionFixture(t)
	token := strings.Repeat("e", 64)
	permanent := strings.Repeat("p", 64)
	n.Clusters = []string{"fixture"}
	n.IPs = append(n.IPs, "10.0.0.9")
	d.Nodes[n.ID] = n
	a := targetAgent{ID: "target-fixture", Cluster: "fixture", Job: run.Job, Node: n.ID, Host: "db-one", IP: "10.0.0.9", Desired: "active", Expires: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano), EnrollmentHash: digest([]byte(token))}
	d.Agents = map[string]targetAgent{a.ID: a}
	_ = s.saveExecutions(d)
	call := func(endpoint, auth string, body any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest("POST", "http://localhost/api/target-agent/"+endpoint, bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+auth)
		w := httptest.NewRecorder()
		s.handleTargetAgent(w, r)
		return w
	}
	body := map[string]any{"id": a.ID, "machine_id": strings.Repeat("a", 64), "hostname": "wrong", "ips": []string{a.IP}, "token": permanent}
	if w := call("enroll", token, body); w.Code != 409 {
		t.Fatal("wrong host accepted", w.Code, w.Body.String())
	}
	body["hostname"] = a.Host
	if w := call("enroll", token, body); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call("enroll", token, body); w.Code != 200 {
		t.Fatal("lost-ack retry rejected", w.Code)
	}
	body["machine_id"] = strings.Repeat("b", 64)
	if w := call("enroll", token, body); w.Code != 409 {
		t.Fatal("token reused on another machine", w.Code)
	}
	if w := call("poll", permanent, map[string]string{"machine_id": strings.Repeat("b", 64)}); w.Code != 403 {
		t.Fatal("wrong permanent identity accepted")
	}
	if w := call("poll", permanent, map[string]string{"machine_id": strings.Repeat("a", 64)}); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestExecutionPreparationRequiresEveryTargetAndExpires(t *testing.T) {
	s, d, n, _ := executionFixture(t)
	n.Kind = "embedded"
	n.Protocol = 2
	n.Grants = map[string][]string{"fixture": {"127.0.0.1"}}
	d.Nodes[n.ID] = n
	snap := executionSnapshot{Job: "fixture-job", Cluster: "fixture", ControllerIP: n.ControllerIP, Hosts: []mwpack.Host{{Name: "local", IP: n.ControllerIP}}}
	p := executionPreparation{ID: "prepare-fixture", Node: n.ID, Job: snap.Job, Snapshot: snap, State: "pending", Created: executionNow(), Revision: "revision", NodeRevision: executionNodeRevision(n)}
	d.Preparations = map[string]executionPreparation{p.ID: p}
	send := func(checks []executionCheck) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(map[string]any{"id": p.ID, "checks": checks})
		r := httptest.NewRequest("POST", "/prepared", bytes.NewReader(raw))
		w := httptest.NewRecorder()
		s.handleExecutionPrepared(w, r, &d, n)
		return w
	}
	checks := []executionCheck{{ID: "executor", State: "passed"}, {ID: "runtime", State: "passed"}, {ID: "materials", State: "passed"}}
	if w := send(checks); w.Code != 400 {
		t.Fatal("partial checklist accepted", w.Code)
	}
	checks = append(checks, executionCheck{ID: "host:local", State: "passed"})
	if w := send(checks); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	p = d.Preparations[p.ID]
	if e := validateExecutionPreparation(p, n, snap, "revision"); e != nil {
		t.Fatal(e)
	}
	changed := n
	changed.Version = "changed"
	if e := validateExecutionPreparation(p, changed, snap, "revision"); e == nil {
		t.Fatal("changed runner accepted stale check")
	}
	p.Finished = time.Now().Add(-11 * time.Minute).UTC().Format(time.RFC3339Nano)
	if e := validateExecutionPreparation(p, n, snap, "revision"); e == nil {
		t.Fatal("expired check accepted")
	}
}
func TestPreparationFailureIsNotUnknownRemoteExecution(t *testing.T) {
	s, d, n, run := executionFixture(t)
	ev := stepEvent(run, 1, "blocked", "")
	ev.Reason = "尚未启动命令：缺少运行环境"
	if e := s.applyExecutionEvent(&d, n, ev); e != nil {
		t.Fatal(e)
	}
	got := d.Runs[run.ID]
	if got.Steps[0].State != "blocked" || got.Steps[0].Started != "" || activeExecution(got) {
		t.Fatal("unstarted task requires remote reconciliation", got)
	}
}
func TestExecutionRuntimeSelectionDoesNotReplaceOtherVersions(t *testing.T) {
	base := t.TempDir()
	one := filepath.Join(base, "one")
	two := filepath.Join(base, "two")
	for root, content := range map[string]string{one: "old", two: "new"} {
		_ = os.MkdirAll(filepath.Join(root, "bin"), 0700)
		_ = os.WriteFile(filepath.Join(root, "bin/ansible-playbook"), []byte(content), 0700)
	}
	r := executionRunner{cfg: executionRunnerConfig{Root: one, Roots: []string{two}}}
	snap := executionSnapshot{RuntimeFiles: map[string]string{"bin/ansible-playbook": digest([]byte("new"))}}
	root, e := r.matchingRoot(snap)
	if e != nil || root != two {
		t.Fatal(root, e)
	}
	b, _ := os.ReadFile(filepath.Join(one, "bin/ansible-playbook"))
	if string(b) != "old" {
		t.Fatal("old runtime overwritten")
	}
}

func TestExecutionIndependentRootDoesNotReuseOtherClusterSecrets(t *testing.T) {
	base := t.TempDir()
	one, two := filepath.Join(base, "cluster-one"), filepath.Join(base, "cluster-two")
	for _, root := range []string{one, two} {
		_ = os.MkdirAll(filepath.Join(root, "bin"), 0700)
		_ = os.WriteFile(filepath.Join(root, "bin/ansible-playbook"), []byte("same-runtime"), 0700)
	}
	r := executionRunner{cfg: executionRunnerConfig{Root: one, Roots: []string{two}}}
	snap := executionSnapshot{RuntimeRoot: two, RuntimeFiles: map[string]string{"bin/ansible-playbook": digest([]byte("same-runtime"))}}
	root, e := r.matchingRoot(snap)
	if e != nil || root != two {
		t.Fatalf("selected another cluster's root: %s %v", root, e)
	}
	r.cfg.Roots = nil
	if _, e = r.matchingRoot(snap); e == nil {
		t.Fatal("unregistered root accepted")
	}
}

func TestTargetUninstalledAgentCanBeRevokedImmediately(t *testing.T) {
	s, _ := testStore(t)
	j := storeJob{ID: "target-cancel-test", ClusterID: "target-cancel"}
	a := targetAgent{ID: "not-installed", Job: j.ID, Node: "manager", Desired: "active", EnrollmentHash: "token-hash"}
	d := executionDB{Agents: map[string]targetAgent{a.ID: a}}
	request := httptest.NewRequest("PATCH", "/agents", strings.NewReader(`{"id":"not-installed","action":"revoke"}`))
	w := httptest.NewRecorder()
	s.handleTargetAgents(w, request, storeSession{User: "admin"}, j, []string{"agents"}, &d)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	a = d.Agents[a.ID]
	if a.Desired != "revoked" || a.Applied != "revoked" || a.EnrollmentHash != "" {
		t.Fatal("uninstalled agent stuck pending revocation", a)
	}
}

package server

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"delivery-studio/mwpack"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestExecutionNewNodeRequiresScopedPreparation(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	req := func(method, path string, body any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		return storeRequest(s, method, path, bytes.NewReader(raw), admin, csrf)
	}
	w := storeCreate(t, s, admin, csrf, `{"id":"prepared-api","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	var j storeJob
	_ = json.Unmarshal(w.Body.Bytes(), &j)
	j = s.jobs[j.ID]
	if j.State != "succeeded" {
		t.Fatal(j.Error)
	}
	path := "/api/jobs/" + j.ID + "/executions"
	w = req("POST", "/api/settings/execution-nodes", map[string]any{"name": "prepared node", "kind": "embedded", "controller_ip": "10.0.1.11", "clusters": []string{"forged"}, "ips": []string{"10.0.9.9"}})
	var reg struct {
		Node  executionNode
		Token string
	}
	_ = json.Unmarshal(w.Body.Bytes(), &reg)
	if w.Code != 201 || len(reg.Node.Clusters) != 0 || len(reg.Node.IPs) != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
	agent := func(endpoint string, body any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest("POST", "/api/execution-agent/"+endpoint, bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+reg.Token)
		w := httptest.NewRecorder()
		s.handleExecutionAgent(w, r)
		return w
	}
	if w = agent("poll", map[string]any{"protocol": 2, "version": "fixture", "heartbeat": true}); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	body := map[string]any{"node": reg.Node.ID, "revision": s.executionRevision(j.ID)}
	if w = req("POST", path+"/prepare", body); w.Code != 403 {
		t.Fatal("unscoped check accepted", w.Code)
	}
	if w = req("POST", path+"/authorize", body); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = req("POST", path+"/prepare", body); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var p executionPreparation
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	if len(p.Snapshot.Files) > 0 {
		t.Fatal("browser received project material")
	}
	if w = req("POST", path+"/prepare", body); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var duplicate executionPreparation
	_ = json.Unmarshal(w.Body.Bytes(), &duplicate)
	if duplicate.ID != p.ID || len(duplicate.Snapshot.Files) > 0 {
		t.Fatal("pending check replay leaked or duplicated")
	}
	w = agent("poll", map[string]any{"protocol": 2, "version": "fixture"})
	var response struct{ Preparation *executionPreparation }
	_ = json.Unmarshal(w.Body.Bytes(), &response)
	if response.Preparation == nil || len(response.Preparation.Snapshot.Files) == 0 {
		t.Fatal("runner did not receive pinned materials", w.Body.String())
	}
	key := ""
	for _, c := range s.executionChoices(j.ID) {
		if c.Available {
			key = c.Key
			break
		}
	}
	runBody := map[string]any{"node": reg.Node.ID, "revision": s.executionRevision(j.ID), "prepared": true, "confirm": j.ClusterID, "request": "prepared-request", "keys": []string{key}}
	if w = req("POST", path, runBody); w.Code != 409 {
		t.Fatal("checkbox bypassed mandatory checks", w.Code, w.Body.String())
	}
	checks := []executionCheck{}
	for _, id := range executionCheckIDs(response.Preparation.Snapshot) {
		checks = append(checks, executionCheck{ID: id, State: "passed", Title: id})
	}
	if w = agent("prepared", map[string]any{"id": p.ID, "checks": checks}); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	runBody["preparation"] = p.ID
	if w = req("POST", path, runBody); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var run executionRun
	_ = json.Unmarshal(w.Body.Bytes(), &run)
	if run.Preparation != p.ID || run.ExecutorIP != "10.0.1.11" || run.ExecutorKind != "embedded" {
		t.Fatal("missing frozen evidence", run)
	}
	if w = req("POST", path, runBody); w.Code != 200 {
		t.Fatal("duplicate execution not deduplicated")
	}
	d, _ := s.readExecutions()
	n := d.Nodes[reg.Node.ID]
	n.Name = "renamed-after-execution"
	d.Nodes[n.ID] = n
	if e := s.saveExecutions(d); e != nil {
		t.Fatal(e)
	}
	var report docBuilder
	s.executionSummary(&report, 1, j, s.readProgress(j.ID))
	evidence, _ := json.Marshal(report.blocks)
	for _, expected := range []string{"prepared node", "集群内执行机", "已有 SSH", "执行准备", "不计为数据库部署或业务验收通过"} {
		if !bytes.Contains(evidence, []byte(expected)) {
			t.Fatalf("report missing %s", expected)
		}
	}
	if bytes.Contains(evidence, []byte(n.Name)) {
		t.Fatal("history renamed with mutable executor")
	}
}

// Uses the real OpenSSH client against an isolated loopback SSH server. No
// system authorized_keys, sshd settings, or customer machines are modified.
func TestTargetManagedTrustSSHHandshakeAndRevocation(t *testing.T) {
	client, e := exec.LookPath("ssh")
	if e != nil {
		t.Skip("OpenSSH client missing")
	}
	s, d, n, _ := executionFixture(t)
	d.Runs = map[string]executionRun{}
	n.Protocol = 2
	n.Kind = "embedded"
	n.Grants = map[string][]string{"fixture": {"127.0.0.2"}}
	d.Nodes[n.ID] = n
	_, hostPrivate, _ := ed25519.GenerateKey(rand.Reader)
	hostSigner, _ := ssh.NewSignerFromKey(hostPrivate)
	a := targetAgent{ID: "agent-ssh-test", Node: n.ID, Job: "fixture-job", Cluster: "fixture", Host: "db", IP: "127.0.0.2", Desired: "active", HostKeys: []string{strings.TrimSpace(string(ssh.MarshalAuthorizedKey(hostSigner.PublicKey())))}}
	d.Agents = map[string]targetAgent{a.ID: a}
	p := executionPreparation{ID: "prepare-ssh-test", Job: a.Job, Node: n.ID, Created: executionNow(), State: "pending", NodeRevision: executionNodeRevision(n), Snapshot: executionSnapshot{Job: a.Job, Cluster: "fixture", ControllerIP: n.ControllerIP, Hosts: []mwpack.Host{{Name: a.Host, IP: a.IP}}, AgentAccess: map[string]string{a.Host: a.ID}}}
	d.Preparations = map[string]executionPreparation{p.ID: p}
	_ = s.saveExecutions(d)
	srv := httptest.NewServer(http.HandlerFunc(s.handleExecutionAgent))
	defer srv.Close()
	root := t.TempDir()
	r, e := newExecutionRunner(executionRunnerConfig{URL: srv.URL, Token: strings.Repeat("t", 64), Root: root})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = r.prepareManagedTrust(p); e == nil {
		t.Fatal("trust declared ready before target acknowledgment")
	}
	d, _ = s.readExecutions()
	a = d.Agents[a.ID]
	sshDir := filepath.Join(root, "target-ssh")
	if e = applyTargetTrust(sshDir, targetAgentInstruction{ID: a.ID, Desired: "active", SourceIP: n.ControllerIP, PublicKey: a.PublicKey}); e != nil {
		t.Fatal(e)
	}
	a.Applied = "active"
	d.Agents[a.ID] = a
	_ = s.saveExecutions(d)
	access, e := r.prepareManagedTrust(p)
	if e != nil {
		t.Fatal(e)
	}
	listen, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listen.Close()
	config := &ssh.ServerConfig{PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		raw, _ := os.ReadFile(filepath.Join(sshDir, "authorized_keys"))
		for len(bytes.TrimSpace(raw)) > 0 {
			pub, _, _, rest, err := ssh.ParseAuthorizedKey(raw)
			if err != nil {
				break
			}
			if bytes.Equal(pub.Marshal(), key.Marshal()) && meta.User() == "root" {
				return nil, nil
			}
			raw = rest
		}
		return nil, fmt.Errorf("untrusted key")
	}}
	config.AddHostKey(hostSigner)
	go func() {
		for {
			conn, err := listen.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				sc, chans, reqs, err := ssh.NewServerConn(conn, config)
				if err != nil {
					return
				}
				defer sc.Close()
				go ssh.DiscardRequests(reqs)
				for ch := range chans {
					c, requests, err := ch.Accept()
					if err != nil {
						continue
					}
					for req := range requests {
						if req.Type == "exec" {
							_ = req.Reply(true, nil)
							_, _ = c.Write([]byte("agent-access-ok"))
							_, _ = c.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{0}))
							_ = c.Close()
							break
						}
						_ = req.Reply(false, nil)
					}
				}
			}()
		}
	}()
	port := listen.Addr().(*net.TCPAddr).Port
	known := filepath.Join(root, "loopback-known-hosts")
	_ = os.WriteFile(known, []byte(fmt.Sprintf("[127.0.0.1]:%d %s", port, ssh.MarshalAuthorizedKey(hostSigner.PublicKey()))), 0600)
	connect := func() ([]byte, error) {
		cmd := exec.Command(client, "-F", "/dev/null", "-p", fmt.Sprint(port), "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oIdentitiesOnly=yes", "-oConnectTimeout=3", "-oUserKnownHostsFile="+known, "-i", access[a.Host].PrivateKey, "root@127.0.0.1", "true")
		return cmd.CombinedOutput()
	}
	if out, e := connect(); e != nil || string(out) != "agent-access-ok" {
		t.Fatal("SSH trust failed", e, string(out))
	}
	if e = applyTargetTrust(sshDir, targetAgentInstruction{ID: a.ID, Desired: "revoked"}); e != nil {
		t.Fatal(e)
	}
	if _, e = connect(); e == nil {
		t.Fatal("revoked key still authenticates")
	}
	if e = r.recoverOutbox(); e != nil {
		t.Fatal("trust state broke recovery", e)
	} // clock-bound enrollment is covered in execution_access_test.go
}

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestAIAssistant(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, csrf := storeLogin(t, s, "alice")
	bob, bcsrf := storeLogin(t, s, "bob")
	w := storeCreate(t, s, alice, csrf, singleNodeSpec, nil)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	s.wg.Wait()
	var job storeJob
	json.Unmarshal(w.Body.Bytes(), &job)

	var mu sync.Mutex
	var bodies []string
	var auth []string
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(b))
		auth = append(auth, r.Header.Get("Authorization"))
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		var req map[string]any
		json.Unmarshal(b, &req)
		if strings.HasPrefix(r.URL.Path, "/models") {
			w.Write([]byte(`{"data":[{"id":"m1"},{"id":"m2"}]}`))
			return
		}
		msgs := req["messages"].([]any)
		last := msgs[len(msgs)-1].(map[string]any)
		switch {
		case last["role"] == "tool":
			io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"集群是 \"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"单节点\"}}]}\n\ndata: {\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n")
		case req["tools"] != nil && strings.Contains(string(b), "整理成一份记录") == false && last["role"] == "user" && !strings.Contains(string(b), "直接回答"):
			io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"delivery_info\",\"arguments\":\"{}\"}}]}}]}\n\ndata: [DONE]\n\n")
		case strings.Contains(string(b), "整理成一份记录"):
			io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"symptom\\\":\\\"端口被占用\\\",\\\"cause\\\":\\\"旧进程\\\",\\\"fix\\\":\\\"kill\\\",\\\"changed_delivery\\\":false}\"}}]}\n\ndata: [DONE]\n\n")
		default:
			io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n")
		}
	}))
	defer good.Close()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, `{"error":{"message":"boom"}}`, 500) }))
	defer bad.Close()

	// only administrators manage it; nothing is available until it is set up
	if w = storeRequest(s, "GET", "/api/settings/ai", nil, alice, ""); w.Code != 403 {
		t.Fatal("a normal user read AI settings", w.Code)
	}
	chat := func(user *http.Cookie, token, id, body string) *httptest.ResponseRecorder {
		return storeRequest(s, "POST", "/api/jobs/"+id+"/ai/chat", strings.NewReader(body), user, token)
	}
	if w = chat(alice, csrf, job.ID, `{"key":"review","message":"评审"}`); w.Code != 409 {
		t.Fatal("chat worked with AI off", w.Code)
	}
	add := func(url, name string) string {
		w := storeRequest(s, "POST", "/api/settings/ai/providers", strings.NewReader(`{"name":"`+name+`","preset":"custom","url":"`+url+`","models":[{"id":"m1","enabled":true},{"id":"m2","enabled":true}],"enabled":true,"key":"sk-secretsecretsecret1234"}`), admin, acsrf)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "secretsecret") || !strings.Contains(w.Body.String(), `"key_last4":"1234"`) {
			t.Fatal("the key leaked or was not recorded", w.Body.String())
		}
		var v struct{ ID string }
		json.Unmarshal(w.Body.Bytes(), &v)
		return v.ID
	}
	badID, goodID := add(bad.URL, "坏的"), add(good.URL, "好的")
	if w = storeRequest(s, "POST", "/api/settings/ai/providers", strings.NewReader(`{"name":"x","preset":"anthropic","url":"https://x.example","models":[{"id":"m","enabled":true}]}`), admin, acsrf); w.Code != 400 {
		t.Fatal("a not-yet-supported vendor was accepted")
	}
	if w = storeRequest(s, "POST", "/api/settings/ai/providers/"+goodID+"/test?model=m1", nil, admin, acsrf); w.Code != 200 || !strings.Contains(w.Body.String(), `"test_ok":true`) {
		t.Fatal("test connection", w.Code, w.Body.String())
	}
	if w = storeRequest(s, "POST", "/api/settings/ai/models", strings.NewReader(`{"id":"`+goodID+`"}`), admin, acsrf); !strings.Contains(w.Body.String(), "m2") {
		t.Fatal("model list", w.Body.String())
	}
	save := `{"enabled":true,"features":{"troubleshoot":{"enabled":true,"primary":"` + badID + `","backup":"` + goodID + `"},"review":{"enabled":true,"primary":"` + goodID + `"}}}`
	if w = storeRequest(s, "PUT", "/api/settings/ai", strings.NewReader(save), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = storeRequest(s, "GET", "/api/ai/status", nil, alice, ""); !strings.Contains(w.Body.String(), `"troubleshoot":true`) {
		t.Fatal("status", w.Body.String())
	}

	// someone else's delivery is not reachable
	if w = chat(bob, bcsrf, job.ID, `{"key":"review","message":"x"}`); w.Code != 404 {
		t.Fatal("another user reached the delivery's assistant", w.Code)
	}
	mu.Lock()
	bodies = nil
	mu.Unlock()
	// troubleshooting: the first provider fails, the backup answers after reading the delivery with a tool
	w = chat(alice, csrf, job.ID, `{"key":"step:deploy/2","message":"报错 password=hunter2 且 Authorization: Bearer abcdefghijklmnop","step":{"title":"安装","command":"ansible-playbook site.yml"}}`)
	out := w.Body.String()
	if w.Code != 200 || !strings.Contains(out, `"t":"notice"`) || !strings.Contains(out, `"t":"tool","v":"delivery_info"`) || !strings.Contains(out, "单节点") || !strings.Contains(out, `"t":"done"`) {
		t.Fatal("stream", w.Code, out)
	}
	mu.Lock()
	joined := strings.Join(bodies, "\n")
	au := auth[0]
	mu.Unlock()
	if strings.Contains(joined, "hunter2") || strings.Contains(joined, "abcdefghijklmnop") {
		t.Fatal("a secret was sent to the model")
	}
	if au != "Bearer sk-secretsecretsecret1234" {
		t.Fatal("key not sent as bearer", au)
	}
	w = storeRequest(s, "GET", "/api/jobs/"+job.ID+"/ai/session?key=step:deploy/2", nil, alice, "")
	if !strings.Contains(w.Body.String(), "集群是 单节点") {
		t.Fatal("conversation was not kept", w.Body.String())
	}
	// solved: the write-up joins the execution record
	if w = storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/resolve", strings.NewReader(`{"key":"step:deploy/2"}`), alice, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = storeRequest(s, "GET", "/api/jobs/"+job.ID+"/progress", nil, alice, "")
	if !strings.Contains(w.Body.String(), "端口被占用") || !strings.Contains(w.Body.String(), `"reports"`) {
		t.Fatal("report is not in the execution record", w.Body.String())
	}
	// usage is logged; the failed attempt counts too
	w = storeRequest(s, "GET", "/api/settings/ai/usage", nil, admin, "")
	if !strings.Contains(w.Body.String(), `"failover":true`) || !strings.Contains(w.Body.String(), "boom") {
		t.Fatal("usage", w.Body.String())
	}
	// the monthly limit stops further use
	save = strings.Replace(save, `{"enabled":true,`, `{"enabled":true,"monthly_limit":1,`, 1)
	storeRequest(s, "PUT", "/api/settings/ai", strings.NewReader(save), admin, acsrf)
	if w = chat(alice, csrf, job.ID, `{"key":"review","message":"评审"}`); w.Code != 429 {
		t.Fatal("limit not enforced", w.Code)
	}
}

func TestAIScrubAndRedact(t *testing.T) {
	in := "db_password: s3cr3t\nurl postgres://u:pw123@10.0.0.5/db\n-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\nok line"
	out := aiScrub(in)
	for _, bad := range []string{"s3cr3t", "pw123", "AAAA"} {
		if strings.Contains(out, bad) {
			t.Fatal(bad, "survived:", out)
		}
	}
	if !strings.Contains(out, "ok line") {
		t.Fatal("scrubbing ate normal text")
	}
	r := newAIRedactor([]string{"node-01", "10.0.1.11"})
	o := r.out("node-01 10.0.1.11 and 10.0.9.9")
	if strings.Contains(o, "node-01") || strings.Contains(o, "10.0") || r.back(o) != "node-01 10.0.1.11 and 10.0.9.9" {
		t.Fatal(o, r.back(o))
	}
}

func TestAIRefusesImagesForTextOnlyModel(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	w := storeCreate(t, s, alice, csrf, singleNodeSpec, nil)
	s.wg.Wait()
	var job storeJob
	json.Unmarshal(w.Body.Bytes(), &job)
	enc, _ := s.aiEncrypt("k")
	st := s.aiLoad()
	st.Enabled = true
	st.Providers = []aiProvider{{ID: "p", Name: "文本模型", Preset: "custom", URL: "http://127.0.0.1:1/v1", Enabled: true, KeyEnc: enc, Models: []aiModel{{ID: "m", Enabled: true, Vision: "no", Tools: "yes"}}}}
	if err := s.aiSave(st); err != nil {
		t.Fatal(err)
	}
	if !s.aiStatus().NoVision["review"] {
		t.Fatal("status does not say the model cannot see images")
	}
	w = storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/chat", strings.NewReader(`{"key":"review","message":"看图","images":["data:image/png;base64,iVBORw0KGgo="]}`), alice, csrf)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "不支持看图") {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestAIProposalAcceptWritesHandbook(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	bob, bcsrf := storeLogin(t, s, "bob")
	w := storeCreate(t, s, alice, csrf, singleNodeSpec, nil)
	s.wg.Wait()
	var job storeJob
	json.Unmarshal(w.Body.Bytes(), &job)
	titles := s.stepTitles(job.ID)
	if len(titles["prepare"]) == 0 {
		t.Fatal("no steps", titles)
	}
	after := titles["prepare"][0]
	var plan struct{ Hosts []struct{ Name string } }
	json.Unmarshal(s.jobPlan(job.ID), &plan)
	host := plan.Hosts[0].Name
	good := map[string]any{"phase": "prepare", "after_title": after, "title": "清理残留的 etcd 进程", "desc": "端口被占用时先停掉旧进程", "command": "systemctl stop etcd", "effect": "change", "hosts": []any{host}, "expect": "2379 端口空闲", "rollback": "systemctl start etcd", "reason": "bind: address already in use"}
	with := func(k string, v any) map[string]any {
		m := map[string]any{}
		for a, b := range good {
			m[a] = b
		}
		m[k] = v
		return m
	}
	for name, bad := range map[string]map[string]any{
		"secret in command": with("command", "psql -c \"alter user x password='hunter2'\""),
		"no rollback":       with("rollback", ""),
		"foreign host":      with("hosts", []any{"nope"}),
		"forbidden":         with("command", "rm -rf /"),
	} {
		if _, err := s.validateProposal(job.ID, bad); err == nil {
			t.Fatal("accepted:", name)
		}
	}
	// what can be put right is put right, and said: a step that is not there means the end of the phase; a command that
	// writes is not read-only whatever it was called
	if p, err := s.validateProposal(job.ID, with("after_title", "不存在的步骤")); err != nil || p.AfterTitle != "" || len(p.Warnings) == 0 {
		t.Fatal("an unknown anchor was not turned into the end of the phase", p, err)
	}
	if p, err := s.validateProposal(job.ID, with("effect", "read-only")); err != nil || p.Step.Effect != "change" {
		t.Fatal("a writing command stayed read-only", p, err)
	}
	if _, err := s.validateProposal(job.ID, with("command", "rm -rf /data/etcd/old")); err == nil {
		t.Fatal("a deleting command was allowed to be called a change")
	}
	var made []string
	tc := aiToolCtx{s: s, job: job, session: "step:prepare-0", proposed: &made}
	if msg := tc.propose(good, false); len(made) != 1 || !strings.Contains(msg, "等待用户审核") {
		t.Fatal(msg)
	}
	id := made[0]
	// nothing changes until it is accepted, and only the delivery's owner may decide
	before, _ := os.ReadFile(filepath.Join(s.jobDir(job.ID), "output", "00-环境准备.md"))
	if strings.Contains(string(before), "清理残留") {
		t.Fatal("handbook changed before acceptance")
	}
	if w = storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/proposals/"+id+"/accept", nil, bob, bcsrf); w.Code != 404 {
		t.Fatal("another user decided", w.Code)
	}
	if w = storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/proposals/"+id+"/accept", nil, alice, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/proposals/"+id+"/accept", nil, alice, csrf); w.Code != 409 {
		t.Fatal("decided twice", w.Code)
	}
	after2, _ := os.ReadFile(filepath.Join(s.jobDir(job.ID), "output", "00-环境准备.md"))
	md := string(after2)
	at, next := strings.Index(md, "清理残留的 etcd 进程"), strings.Index(md, "## 2.")
	if at < 0 || !strings.Contains(md, "systemctl stop etcd") || !strings.Contains(md, "回退：systemctl start etcd") || (next >= 0 && at > next) {
		t.Fatal("amendment not at the right place in the handbook:\n", md[:min(len(md), 1500)])
	}
	sums, _ := os.ReadFile(filepath.Join(s.jobDir(job.ID), "output", "SHA256SUMS"))
	if !strings.Contains(string(sums), digest(after2)+"  00-环境准备.md") {
		t.Fatal("SHA256SUMS not updated")
	}
	w = storeRequest(s, "GET", "/api/jobs/"+job.ID+"/progress", nil, alice, "")
	if !strings.Contains(w.Body.String(), `"amendments":[{`) || !strings.Contains(w.Body.String(), "ai-accepted") {
		t.Fatal("record lacks the amendment", w.Body.String())
	}
	// withdrawing restores the original document
	if w = storeRequest(s, "DELETE", "/api/jobs/"+job.ID+"/ai/proposals/amendment/"+id, nil, alice, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	restored, _ := os.ReadFile(filepath.Join(s.jobDir(job.ID), "output", "00-环境准备.md"))
	if string(restored) != string(before) {
		t.Fatal("withdrawing did not restore the handbook")
	}
}

func TestAIChangeStepInPlace(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	w := storeCreate(t, s, alice, csrf, singleNodeSpec, nil)
	s.wg.Wait()
	var job storeJob
	json.Unmarshal(w.Body.Bytes(), &job)
	target := s.stepTitles(job.ID)["deploy"][1] // a phase: its command is the playbook run
	var plan struct{ Hosts []struct{ Name string } }
	json.Unmarshal(s.jobPlan(job.ID), &plan)
	docBefore, _ := os.ReadFile(filepath.Join(s.jobDir(job.ID), "output", "01-部署步骤.md"))
	var made []string
	tc := aiToolCtx{s: s, job: job, session: "step:x", proposed: &made}
	msg := tc.propose(map[string]any{"phase": "deploy", "target_title": "没有这一步", "command": "echo hi", "effect": "read-only", "hosts": []any{plan.Hosts[0].Name}, "reason": "r"}, true)
	if len(made) != 0 || !strings.Contains(msg, "没有通过平台校验") {
		t.Fatal("a change to an unknown step was accepted:", msg)
	}
	msg = tc.propose(map[string]any{"phase": "deploy", "target_title": target, "command": "../../bin/ansible-playbook -i inventory/hosts.yml playbooks/02-configure.yml -e etcd_quota=4GB", "effect": "change", "hosts": []any{plan.Hosts[0].Name}, "rollback": "改回原命令重跑", "reason": "把存储配额调到 4GB"}, true)
	if len(made) != 1 {
		t.Fatal(msg)
	}
	if w = storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/proposals/"+made[0]+"/accept", nil, alice, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	doc, _ := os.ReadFile(filepath.Join(s.jobDir(job.ID), "output", "01-部署步骤.md"))
	d := string(doc)
	if !strings.Contains(d, "etcd_quota=4GB") || !strings.Contains(d, "修改前的命令") || !strings.Contains(d, "把存储配额调到 4GB") {
		t.Fatal("the handbook does not show the change and what it replaced:\n", d[:min(len(d), 2500)])
	}
	if strings.Count(d, "\n## ") != strings.Count(string(docBefore), "\n## ") {
		t.Fatal("a change added or removed a step")
	}
	if w = storeRequest(s, "DELETE", "/api/jobs/"+job.ID+"/ai/proposals/amendment/"+made[0], nil, alice, csrf); w.Code != 200 {
		t.Fatal(w.Code)
	}
	back, _ := os.ReadFile(filepath.Join(s.jobDir(job.ID), "output", "01-部署步骤.md"))
	if string(back) != string(docBefore) {
		t.Fatal("withdrawing did not restore the handbook")
	}
}

func TestComponentAIProposalChecksThenDraft(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, csrf := storeLogin(t, s, "alice")
	if w := storeRequest(s, "POST", "/api/components/etcd/draft", strings.NewReader(`{"from":"builtin"}`), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	set, _, err := s.comps().readDraft("etcd")
	if err != nil {
		t.Fatal(err)
	}
	manifest := string(set["manifest/common/params.yaml"])
	changed := strings.Replace(manifest, "unit: ms, default: 100, min: 10", "unit: ms, default: 200, min: 10", 1)
	if changed == manifest {
		t.Fatal("edit did not apply")
	}
	bad := "name: [unclosed"
	mk := func(content string) string {
		b, _ := json.Marshal(map[string]any{"summary": "心跳改为 200ms", "files": []map[string]any{{"path": "manifest/common/params.yaml", "content": content}}})
		return string(b)
	}
	var made []string
	tc := compToolCtx{s: s, name: "etcd", proposed: &made}

	// guide and examples are readable by the model
	if out := tc.run("component_guide", `{}`); !strings.Contains(out, "4.1") {
		t.Fatal("no guide index:", out[:min(len(out), 200)])
	}
	if out := tc.run("example_component", `{"name":"etcd"}`); !strings.Contains(out, "component.yaml") {
		t.Fatal(out)
	}
	// a proposal that breaks the component is sent back, not stored
	if msg := tc.run("propose_files", mk(bad)); len(made) != 0 || !strings.Contains(msg, "没有") {
		t.Fatal("a broken proposal was stored:", msg)
	}
	// a secret in a file is refused
	sec, _ := json.Marshal(map[string]any{"summary": "x", "files": []map[string]any{{"path": "files/k.txt", "content": "-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY-----"}}})
	if msg := tc.run("propose_files", string(sec)); len(made) != 0 || !strings.Contains(msg, "私钥") {
		t.Fatal(msg)
	}
	if msg := tc.run("propose_files", mk(changed)); len(made) != 1 {
		t.Fatal("a sound proposal was refused:", msg)
	}
	id := made[0]
	// the draft is untouched until it is accepted, and only an administrator decides
	if cur, _, _ := s.comps().readDraft("etcd"); string(cur["manifest/common/params.yaml"]) != manifest {
		t.Fatal("draft changed before acceptance")
	}
	if w := storeRequest(s, "POST", "/api/components/etcd/ai/proposals/"+id+"/accept", nil, alice, csrf); w.Code != 403 {
		t.Fatal("an operator accepted", w.Code)
	}
	if w := storeRequest(s, "POST", "/api/components/etcd/ai/proposals/"+id+"/accept", nil, admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if cur, _, _ := s.comps().readDraft("etcd"); string(cur["manifest/common/params.yaml"]) != changed {
		t.Fatal("acceptance did not write the draft")
	}
	if w := storeRequest(s, "POST", "/api/components/etcd/ai/proposals/"+id+"/accept", nil, admin, acsrf); w.Code != 409 {
		t.Fatal("decided twice", w.Code)
	}
}

// fakeModel answers each chat request with the next scripted reply: text, or a tool call "tool:<name>:<json args>".
func fakeModel(t *testing.T, replies ...string) (*httptest.Server, *[]string) {
	var mu sync.Mutex
	var bodies []string
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(b))
		reply := replies[min(n, len(replies)-1)]
		n++
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		if strings.HasPrefix(reply, "tool:") {
			parts := strings.SplitN(reply, ":", 3)
			args, _ := json.Marshal(parts[2])
			io.WriteString(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"`+parts[1]+`","arguments":`+string(args)+`}}]}}]}`+"\n\n")
		} else {
			text, _ := json.Marshal(reply)
			io.WriteString(w, `data: {"choices":[{"delta":{"content":`+string(text)+`}}]}`+"\n\ndata: {\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20,\"prompt_tokens_details\":{\"cached_tokens\":60}}}\n\n")
		}
		io.WriteString(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies
}

func enableAI(t *testing.T, s *storeServer, url string, priceIn float64) {
	enc, _ := s.aiEncrypt("k")
	st := s.aiLoad()
	st.Enabled = true
	st.Providers = []aiProvider{{ID: "p", Name: "测试模型", Preset: "custom", URL: url, Enabled: true, KeyEnc: enc, Currency: "CNY", Models: []aiModel{{ID: "m", Enabled: true, Tools: "yes", Vision: "yes", PriceIn: priceIn, PriceOut: priceIn * 2}}}}
	if err := s.aiSave(st); err != nil {
		t.Fatal(err)
	}
}

func TestAIAssistantPageAndUsageDetail(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	bob, bcsrf := storeLogin(t, s, "bob")
	admin, acsrf := storeLogin(t, s, "admin")
	w := storeCreate(t, s, alice, csrf, singleNodeSpec, nil)
	s.wg.Wait()
	var job storeJob
	json.Unmarshal(w.Body.Bytes(), &job)
	srv, bodies := fakeModel(t, "tool:list_deliveries:{}", "你有 1 份交付。")
	enableAI(t, s, srv.URL, 2)
	id := "0123456789ab"
	w = storeRequest(s, "POST", "/api/ai/chats/"+id+"/chat", strings.NewReader(`{"message":"我有哪些交付？"}`), alice, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"t":"tool","v":"list_deliveries"`) || !strings.Contains(w.Body.String(), "1 份交付") {
		t.Fatal(w.Code, w.Body.String())
	}
	// the tool answered with alice's delivery, and only hers
	if !strings.Contains(strings.Join(*bodies, "\n"), job.ClusterID) {
		t.Fatal("the assistant was not shown the delivery")
	}
	w = storeRequest(s, "GET", "/api/ai/chats", nil, alice, "")
	if !strings.Contains(w.Body.String(), "我有哪些交付") {
		t.Fatal("the chat is not listed", w.Body.String())
	}
	if w = storeRequest(s, "GET", "/api/ai/chats/"+id, nil, bob, ""); w.Code != 404 {
		t.Fatal("someone else read the chat", w.Code)
	}
	if w = storeRequest(s, "GET", "/api/ai/chats", nil, bob, ""); strings.Contains(w.Body.String(), "我有哪些交付") {
		t.Fatal("someone else's chats are listed")
	}
	if w = storeRequest(s, "POST", "/api/ai/chats/abcdefabcdef/chat", strings.NewReader(`{"message":"x","ctx":{"kind":"job","id":"`+job.ID+`"}}`), bob, bcsrf); w.Code != 404 {
		t.Fatal("a chat was tied to another person's delivery", w.Code)
	}
	// usage: the call is recorded with tokens, cache and cost, and the statistics add up
	w = storeRequest(s, "GET", "/api/settings/ai/usage", nil, admin, "")
	var list struct {
		Rows  []aiUsage `json:"rows"`
		Total int       `json:"total"`
	}
	json.Unmarshal(w.Body.Bytes(), &list)
	// after the answer the assistant looks back once to keep what is worth remembering; that call is counted too
	var rows []aiUsage
	for _, r := range list.Rows {
		if r.Feature != "memory" {
			rows = append(rows, r)
		}
	}
	list.Rows, list.Total = rows, len(rows)
	if list.Total != 1 || list.Rows[0].In != 100 || list.Rows[0].Cached != 60 || list.Rows[0].Rounds != 2 || list.Rows[0].Cost <= 0 || list.Rows[0].IP == "" || list.Rows[0].Tools != 1 || list.Rows[0].Feature != "assistant" {
		t.Fatal("usage detail", w.Body.String())
	}
	w = storeRequest(s, "GET", "/api/settings/ai/usage/stats", nil, admin, "")
	if !strings.Contains(w.Body.String(), `"calls":`) || !strings.Contains(w.Body.String(), `"by_user"`) {
		t.Fatal("stats", w.Body.String())
	}
	if w = storeRequest(s, "GET", "/api/settings/ai/usage", nil, alice, ""); w.Code != 403 {
		t.Fatal("a normal user read the usage", w.Code)
	}
	if w = storeRequest(s, "GET", "/api/audit", nil, alice, ""); w.Code != 403 {
		t.Fatal("a normal user read the audit log", w.Code)
	}
	if w = storeRequest(s, "GET", "/api/audit", nil, admin, ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	_ = acsrf
}

func TestAIFormConversation(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	form := `{"deployment":{"id":"","platform":"ubuntu-24.04-amd64","hosts":[{"name":"node-01","ip":"","disk":"/dev/vdb"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["node-01"]}}]},"platforms":["ubuntu-24.04-amd64"]}`
	spec := `{"id":"etcd-prod","platform":"ubuntu-24.04-amd64","hosts":[{"name":"n1","ip":"10.0.1.11","disk":"/dev/vdb"},{"name":"n2","ip":"","disk":"/dev/vdb"},{"name":"n3","ip":"10.0.1.13","disk":"/dev/vdb"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1","n2","n3"]}}]}`
	srv, bodies := fakeModel(t,
		`tool:describe_component:{"name":"etcd"}`,
		`tool:fill_form:{"deployment":`+spec+`,"summary":"3 台机器组成 etcd 集群"}`,
		"已按你说的填好，第二台的 IP 还要你补上。")
	enableAI(t, s, srv.URL, 0)
	st := s.aiLoad()
	st.Features["form"] = aiFeature{Enabled: true}
	s.aiSave(st)

	id := "0123456789ab"
	w := storeRequest(s, "POST", "/api/ai/chats/"+id+"/chat", strings.NewReader(`{"message":"三台机器做 etcd，IP 是 10.0.1.11 和 10.0.1.13，第二台还没定 password=hunter2","ctx":{"kind":"form","id":"etcd"},"form":`+form+`}`), alice, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	out := w.Body.String()
	// the page is told what to write into the form, as it happens
	if !strings.Contains(out, `"t":"form"`) || !strings.Contains(out, `"summary":"3 台机器组成 etcd 集群"`) || !strings.Contains(out, `"blocking":1`) {
		t.Fatal("the form was not filled", out)
	}
	joined := strings.Join(*bodies, "\n")
	if strings.Contains(joined, "hunter2") {
		t.Fatal("a password reached the model")
	}
	// the know-how comes from the skill, the facts from the catalogue
	if !strings.Contains(joined, "新建交付填表") || !strings.Contains(joined, "member（成员）") {
		t.Fatal("the model was not given the skill or the component's roles")
	}
	if !strings.Contains(joined, "还需要用户补充") {
		t.Fatal("the missing address was not handed back to the model")
	}
	w = storeRequest(s, "GET", "/api/ai/chats/"+id, nil, alice, "")
	var c userChat
	json.Unmarshal(w.Body.Bytes(), &c)
	if c.Ctx.Kind != "form" || len(c.Messages) != 2 || c.Messages[1].Form == nil || len(c.Messages[1].Form.Deployment.Hosts) != 3 {
		t.Fatal("the answer does not record what it filled in", w.Body.String())
	}

	// a specification the platform refuses never reaches the form; the model is told what to fix
	bad := `{"id":"etcd-prod","platform":"ubuntu-24.04-amd64","hosts":[{"name":"n1","ip":"10.0.1.11","disk":"/dev/vdb"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["nope"]}}]}`
	srv2, bodies2 := fakeModel(t, `tool:fill_form:{"deployment":`+bad+`}`, "我再看看。")
	enableAI(t, s, srv2.URL, 0)
	st = s.aiLoad()
	st.Features["form"] = aiFeature{Enabled: true}
	s.aiSave(st)
	w = storeRequest(s, "POST", "/api/ai/chats/abcdefabcdef/chat", strings.NewReader(`{"message":"一台就行","ctx":{"kind":"form","id":"etcd"},"form":`+form+`}`), alice, csrf)
	if w.Code != 200 || strings.Contains(w.Body.String(), `"t":"form"`) {
		t.Fatal("a refused specification was written into the form", w.Body.String())
	}
	if !strings.Contains(strings.Join(*bodies2, "\n"), "平台校验没有通过") {
		t.Fatal("the model was not told why the specification was refused")
	}
	// away from the form page the assistant cannot fill anything
	w = storeRequest(s, "POST", "/api/ai/chats/abcdefabcdef/chat", strings.NewReader(`{"message":"再来一次"}`), alice, csrf)
	if strings.Contains(w.Body.String(), `"t":"form"`) {
		t.Fatal("a form was filled without a form", w.Body.String())
	}
	if w = storeRequest(s, "POST", "/api/ai/chats/aaaaaaaaaaaa/chat", strings.NewReader(`{"message":"x","ctx":{"kind":"form","id":"nope"}}`), alice, csrf); w.Code != 404 {
		t.Fatal("a form conversation was opened for an unknown component", w.Code)
	}
	st = s.aiLoad()
	st.Features["form"] = aiFeature{Enabled: false}
	s.aiSave(st)
	if w = storeRequest(s, "POST", "/api/ai/chats/bbbbbbbbbbbb/chat", strings.NewReader(`{"message":"x","ctx":{"kind":"form","id":"etcd"}}`), alice, csrf); w.Code != 409 {
		t.Fatal("form filling was used while switched off", w.Code)
	}
}

func TestAIProviderWithSeveralModels(t *testing.T) {
	s, _ := testStore(t)
	// settings written before providers had models are read as one model
	legacy := `{"enabled":true,"providers":[{"id":"old","name":"旧","preset":"custom","url":"http://x.example/v1","model":"m0","enabled":true,"private":true,"tools":"yes","vision":"no","price_in":3}],"features":{}}`
	if err := os.MkdirAll(s.settingsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(s.settingsDir(), "ai.json"), []byte(legacy), 0o600)
	st := s.aiLoad()
	if len(st.Providers[0].Models) != 1 || st.Providers[0].Models[0].ID != "m0" || st.Providers[0].Models[0].Vision != "no" || st.Providers[0].Models[0].PriceIn != 3 || st.Providers[0].Model != "" {
		t.Fatal("legacy provider not migrated:", st.Providers[0])
	}
	if ps := st.aiProvidersFor("review"); len(ps) != 1 || ps[0].Model != "m0" || ps[0].PriceIn != 3 {
		t.Fatal("a bare provider is not its first model", ps)
	}
	// a provider with two models: the assignment names the model, the call sees that model's own abilities
	st.Providers[0].Models = append(st.Providers[0].Models, aiModel{ID: "m1", Enabled: true, Vision: "yes", PriceIn: 9}, aiModel{ID: "m2", Enabled: false})
	st.Features["review"] = aiFeature{Enabled: true, Primary: aiRef("old", "m1"), Backup: aiRef("old", "m0")}
	st.Features["form"] = aiFeature{Enabled: true, Primary: aiRef("old", "m2")} // a model that is switched off is not used
	ps := st.aiProvidersFor("review")
	if len(ps) != 2 || ps[0].Model != "m1" || ps[0].Vision != "yes" || ps[0].PriceIn != 9 || ps[1].Model != "m0" || ps[1].Vision != "no" {
		t.Fatal("primary and backup models", ps)
	}
	if ps := st.aiProvidersFor("form"); len(ps) != 1 || ps[0].Model != "m0" {
		t.Fatal("a disabled model was used", ps)
	}
	// the vision test shows a red square and wants it named
	if !strings.HasPrefix(redSquare, "data:image/png;base64,") || len(redSquare) < 100 {
		t.Fatal("no test picture")
	}
}

func TestAIStepsAreKept(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	srv, _ := fakeModel(t, "tool:list_deliveries:{}", "完成")
	enableAI(t, s, srv.URL, 0)
	w := storeRequest(s, "POST", "/api/ai/chats/aaaaaaaaaaaa/chat", strings.NewReader(`{"message":"有哪些交付"}`), alice, csrf)
	out := w.Body.String()
	if !strings.Contains(out, `"t":"step"`) || !strings.Contains(out, `"t":"stepdone"`) || !strings.Contains(out, `"t":"reset"`) {
		t.Fatal(out)
	}
	w = storeRequest(s, "GET", "/api/ai/chats/aaaaaaaaaaaa", nil, alice, "")
	if !strings.Contains(w.Body.String(), `"steps":[{"kind":"tool"`) || !strings.Contains(w.Body.String(), `"ms":`) {
		t.Fatal("the steps were not saved", w.Body.String())
	}
}

func TestToolSchemasAreStrictServerSafe(t *testing.T) {
	for _, lists := range [][]aiToolDef{aiTools(), compTools(), assistantTools(), webTools()} {
		for _, d := range lists {
			b, _ := json.Marshal(cleanSchema(d.Parameters))
			if strings.Contains(string(b), `"required":null`) || strings.Contains(string(b), `"required":[]`) || !strings.Contains(string(b), `"properties":{`) {
				t.Fatal("tool", d.Name, "has a schema strict servers reject:", string(b))
			}
		}
	}
}

func TestModelPricesDefaultsAndOverrides(t *testing.T) {
	s, _ := testStore(t)
	for model, want := range map[string]float64{"codex/gpt-6.1-sol": 2, "zerotoken/claude-opus-4-5-20251101": 5, "zerotoken/claude-sonnet-5-5": 2, "gpt-5.4-mini": 0.75, "gpt-5.4": 2.5, "deepseek-v4-pro-0813": 9, "GLM-5.3-Flash": 0.8, "claude-haiku-5-5": 0.1} {
		e, _, ok := s.defaultPrice(model)
		if !ok || e.In != want {
			t.Fatal(model, "price", e.In, ok, "want", want)
		}
	}
	if _, _, ok := s.defaultPrice("some-private-model"); ok {
		t.Fatal("a price was invented for an unknown model")
	}
	// the cost of a call: 1000 in (400 from cache), 500 out at $2 / $0.10 / $10 per million
	p := aiProvider{Currency: "CNY"}
	u := aiUsage{In: 1000, Cached: 400, Out: 500}
	cost, cur := s.priceOf(p, aiModel{ID: "codex/gpt-6.1-sol"}, u)
	if cur != "USD" || cost < 0.006239 || cost > 0.006241 {
		t.Fatal("default price cost", cost, cur)
	}
	// a price typed on the model wins, in the provider's currency
	cost, cur = s.priceOf(p, aiModel{ID: "codex/gpt-6.1-sol", PriceIn: 10, PriceOut: 20}, u)
	if cur != "CNY" || cost < 0.01999 || cost > 0.02001 {
		t.Fatal("typed price cost", cost, cur)
	}
	// the administrator's table beats the shipped one
	admin, acsrf := storeLogin(t, s, "admin")
	body := `{"custom":[{"vendor":"自家","models":["gpt-6.1-sol"],"in":1,"cached":0.5,"out":3,"currency":"CNY"}],"display":"CNY","rate":7}`
	if w := storeRequest(s, "PUT", "/api/settings/ai/prices", strings.NewReader(body), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if e, src, _ := s.defaultPrice("codex/gpt-6.1-sol"); e.In != 1 || src != "custom" {
		t.Fatal("custom entry ignored", e, src)
	}
	if w := storeRequest(s, "PUT", "/api/settings/ai/prices", strings.NewReader(`{"custom":[{"vendor":"x","models":[],"in":1,"currency":"CNY"}]}`), admin, acsrf); w.Code != 400 {
		t.Fatal("an entry without a model was accepted")
	}
	ps := s.loadPriceSettings()
	if got := ps.convert(7, "USD"); got != 49 {
		t.Fatal("conversion", got)
	}
}

func TestAIChatPersistsFailureAndRetriesCleanly(t *testing.T) {
	failOnce := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failOnce {
			http.Error(w, `{"error":{"message":"upstream gateway unavailable"}}`, 502)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"已恢复正常\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()

	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, csrf := storeLogin(t, s, "alice")
	pw := storeRequest(s, "POST", "/api/settings/ai/providers", strings.NewReader(`{"name":"TestGW","preset":"custom","url":"`+srv.URL+`","models":[{"id":"gpt-test","enabled":true}],"enabled":true,"key":"sk-secretsecretsecret1234"}`), admin, acsrf)
	if pw.Code != 200 {
		t.Fatal(pw.Code, pw.Body.String())
	}
	var pv struct{ ID string }
	json.Unmarshal(pw.Body.Bytes(), &pv)
	if sw := storeRequest(s, "PUT", "/api/settings/ai", strings.NewReader(`{"enabled":true,"features":{"assistant":{"enabled":true,"primary":"`+pv.ID+`"}}}`), admin, acsrf); sw.Code != 200 {
		t.Fatal(sw.Code, sw.Body.String())
	}
	chatID := "aabbccddeeff"

	// 1. First call fails with HTTP 502: error + diagnostics must be persisted in chat JSON and returned in SSE.
	w := storeRequest(s, "POST", "/api/ai/chats/"+chatID+"/chat", strings.NewReader(`{"message":"你好"}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("expected 200 SSE stream, got %d: %s", w.Code, w.Body.String())
	}
	sseBody := w.Body.String()
	if !strings.Contains(sseBody, `"t":"error"`) || !strings.Contains(sseBody, `"saved":true`) || !strings.Contains(sseBody, `"diag":`) {
		t.Fatalf("SSE error event missing saved/diag metadata: %s", sseBody)
	}
	c, ok := s.loadChat("alice", chatID)
	if !ok || len(c.Messages) != 2 {
		t.Fatalf("expected 2 persisted messages (user + failed assistant), got %d: %+v", len(c.Messages), c.Messages)
	}
	if c.Messages[0].Role != "user" || c.Messages[0].Text != "你好" {
		t.Fatalf("unexpected user message: %+v", c.Messages[0])
	}
	if !isErrorOnlyMsg(c.Messages[1]) || c.Messages[1].ErrorDiag == nil || c.Messages[1].ErrorDiag.Provider != "TestGW" {
		t.Fatalf("failed assistant turn not persisted cleanly: %+v", c.Messages[1])
	}

	// 2. Retry succeeds: stale error turn is replaced and user message is NOT duplicated.
	failOnce = false
	w = storeRequest(s, "POST", "/api/ai/chats/"+chatID+"/chat", strings.NewReader(`{"message":"你好","retry":true}`), alice, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"t":"done"`) {
		t.Fatalf("retry did not succeed: %d %s", w.Code, w.Body.String())
	}
	c2, _ := s.loadChat("alice", chatID)
	if len(c2.Messages) != 2 {
		t.Fatalf("expected retry to keep exactly 2 messages (no duplicate user bubble, stale error removed), got %d: %+v", len(c2.Messages), c2.Messages)
	}
	if c2.Messages[0].Role != "user" || c2.Messages[1].Role != "assistant" || c2.Messages[1].Error != "" || c2.Messages[1].Text != "已恢复正常" {
		t.Fatalf("unexpected messages after retry: %+v", c2.Messages)
	}
}

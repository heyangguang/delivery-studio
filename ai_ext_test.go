package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeMCP is a streamable-HTTP MCP server with one read-only and one writing tool.
func fakeMCP(t *testing.T) (*httptest.Server, *[]string) {
	var mu sync.Mutex
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     any            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &req)
		mu.Lock()
		calls = append(calls, req.Method+" "+r.Header.Get("Mcp-Session-Id")+" "+r.Header.Get("Authorization"))
		mu.Unlock()
		if req.ID == nil {
			w.WriteHeader(202)
			return
		}
		var result any
		switch req.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "s-1")
			result = map[string]any{"protocolVersion": mcpProtocol, "serverInfo": map[string]any{"name": "监控", "version": "1.0"}, "capabilities": map[string]any{"tools": map[string]any{}}}
		case "tools/list":
			result = map[string]any{"tools": []any{
				map[string]any{"name": "query_metrics", "description": "查询监控指标", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"q": map[string]any{"type": "string"}}}, "annotations": map[string]any{"readOnlyHint": true}},
				map[string]any{"name": "restart_service", "description": "重启服务", "inputSchema": map[string]any{"type": "object"}},
			}}
		case "tools/call":
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "cpu=42% token=abcdefghijklmnopqrstuvwxyz password=hunter2"}}}
		}
		// answer as a server-sent event, as many servers do
		w.Header().Set("Content-Type", "text/event-stream")
		out, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
		io.WriteString(w, "event: message\ndata: "+string(out)+"\n\n")
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestSkillsAndMCP(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, _ := storeLogin(t, s, "alice")
	// skills ship with the platform and can be switched off or added to
	w := storeRequest(s, "GET", "/api/settings/ai/skills", nil, admin, "")
	if !strings.Contains(w.Body.String(), "ansible-debug") || !strings.Contains(w.Body.String(), "postgresql-patroni") {
		t.Fatal(w.Body.String()[:200])
	}
	if w = storeRequest(s, "GET", "/api/settings/ai/skills", nil, alice, ""); w.Code != 403 {
		t.Fatal("a normal user read the skill settings")
	}
	body := `{"disabled":["etcd-ops"],"custom":[{"name":"our-runbook","title":"本单位规范","description":"变更窗口与审批要求","content":"变更只在周二晚上做。"}]}`
	if w = storeRequest(s, "PUT", "/api/settings/ai/skills", strings.NewReader(body), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = storeRequest(s, "PUT", "/api/settings/ai/skills", strings.NewReader(`{"custom":[{"name":"x1","title":"x","description":"x","content":"password=hunter2"}]}`), admin, acsrf); w.Code != 400 {
		t.Fatal("a skill with a password was saved")
	}
	x := s.extFor("assistant")
	if !strings.Contains(x.prompt, "our-runbook") || strings.Contains(x.prompt, "etcd-ops") {
		t.Fatal("skill catalog", x.prompt)
	}
	run := x.wrap(func(n, a string) string { return "own " + n })
	if out := run("use_skill", `{"name":"our-runbook"}`); !strings.Contains(out, "周二晚上") {
		t.Fatal(out)
	}
	if out := run("use_skill", `{"name":"etcd-ops"}`); !strings.Contains(out, "停用") {
		t.Fatal("a disabled skill was read:", out)
	}
	if out := run("runbook", `{}`); out != "own runbook" {
		t.Fatal("own tools are not passed through")
	}
	if len(s.extFor("form").tools) != 0 {
		t.Fatal("form filling got extra tools")
	}

	// an MCP server: added, its tools listed, only the read-only one offered, calls scrubbed
	mcp, calls := fakeMCP(t)
	w = storeRequest(s, "POST", "/api/settings/ai/mcp", strings.NewReader(`{"name":"监控","url":"`+mcp.URL+`","enabled":true,"token":"tok-123"}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var created struct{ ID string }
	json.Unmarshal(w.Body.Bytes(), &created)
	if w = storeRequest(s, "POST", "/api/settings/ai/mcp/"+created.ID+"/refresh", nil, admin, acsrf); w.Code != 200 || !strings.Contains(w.Body.String(), "query_metrics") {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = storeRequest(s, "GET", "/api/settings/ai/mcp", nil, admin, ""); strings.Contains(w.Body.String(), "tok-123") {
		t.Fatal("the token leaked")
	}
	x = s.extFor("troubleshoot")
	names := map[string]bool{}
	for _, d := range x.tools {
		names[d.Name] = true
	}
	ro, wr := mcpToolName(created.ID, "query_metrics"), mcpToolName(created.ID, "restart_service")
	if !names[ro] || names[wr] {
		t.Fatal("tools offered", names)
	}
	out := x.wrap(nil)(ro, `{"q":"cpu"}`)
	if !strings.Contains(out, "cpu=42%") || strings.Contains(out, "hunter2") || strings.Contains(out, "abcdefghijklmnop") {
		t.Fatal("mcp result", out)
	}
	joined := strings.Join(*calls, "\n")
	if !strings.Contains(joined, "tools/call s-1 Bearer tok-123") || !strings.Contains(joined, "notifications/initialized") {
		t.Fatal("mcp session/token not used", joined)
	}
	if stepKind(ro) != "mcp" || stepKind("use_skill") != "skill" || stepKind("runbook") != "tool" {
		t.Fatal("step kinds")
	}
}

func TestThinkTagsAreSplitAcrossChunks(t *testing.T) {
	tg := &thinkTags{}
	var think, text strings.Builder
	for _, c := range []string{"<thi", "nk>先看", "看手册</th", "ink>\n结论是", "可以"} {
		text.WriteString(tg.feed(c, func(s string) { think.WriteString(s) }))
	}
	if think.String() != "先看看手册" || text.String() != "结论是可以" {
		t.Fatalf("think=%q text=%q", think.String(), text.String())
	}
	tg = &thinkTags{}
	if got := tg.feed("普通回答 <think> 不是开头", func(string) { t.Fatal("not a think block") }); got != "普通回答 <think> 不是开头" {
		t.Fatal(got)
	}
}

func TestUserPicksAllowedModel(t *testing.T) {
	s, _ := testStore(t)
	enc, _ := s.aiEncrypt("k")
	st := s.aiLoad()
	st.Enabled = true
	st.Providers = []aiProvider{{ID: "p", Name: "网关", Preset: "custom", URL: "http://x.example/v1", Enabled: true, KeyEnc: enc, Models: []aiModel{{ID: "a", Enabled: true}, {ID: "b", Enabled: true}, {ID: "c", Enabled: true}}}}
	st.Features["assistant"] = aiFeature{Enabled: true, Primary: "p|a"}
	st.UserModels = []string{"p|a", "p|b"}
	s.aiSave(st)
	st = s.aiLoad()
	if ps := st.aiProvidersForPick("assistant", "p|b"); ps[0].Model != "b" || ps[1].Model != "a" {
		t.Fatal("pick b", ps)
	}
	if ps := st.aiProvidersForPick("assistant", "p|c"); ps[0].Model != "a" {
		t.Fatal("a model not offered to people was used", ps)
	}
	m := s.aiModels()
	if len(m["models"].([]pickable)) != 2 || m["defaults"].(map[string]string)["assistant"] != "p|a" {
		t.Fatal(m)
	}
}

func TestAccountsCanBeManaged(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, _ := storeLogin(t, s, "alice")
	patch := func(name, body string) (int, string) {
		w := storeRequest(s, "PATCH", "/api/users/"+name, strings.NewReader(body), admin, acsrf)
		return w.Code, w.Body.String()
	}
	if c, _ := patch("admin", `{"disabled":true}`); c != 409 {
		t.Fatal("an administrator disabled themselves", c)
	}
	if c, _ := patch("admin", `{"role":"operator"}`); c != 409 {
		t.Fatal("the last administrator was demoted", c)
	}
	c, b := patch("alice", `{"reset_password":true}`)
	if c != 200 || !strings.Contains(b, `"password"`) {
		t.Fatal(c, b)
	}
	// her old session is gone
	if w := storeRequest(s, "GET", "/api/session", nil, alice, ""); w.Code != 401 {
		t.Fatal("a reset password kept the old session", w.Code)
	}
	if c, _ := patch("alice", `{"disabled":true}`); c != 200 {
		t.Fatal(c)
	}
	var pw struct{ Password string }
	json.Unmarshal([]byte(b), &pw)
	w := storeRequest(s, "POST", "/api/login", strings.NewReader(`{"Username":"alice","Password":"`+pw.Password+`"}`), nil, "")
	if w.Code != 403 {
		t.Fatal("a disabled account signed in", w.Code)
	}
	if c, _ := patch("alice", `{"disabled":false}`); c != 200 {
		t.Fatal(c)
	}
	if w = storeRequest(s, "POST", "/api/login", strings.NewReader(`{"Username":"alice","Password":"`+pw.Password+`"}`), nil, ""); w.Code != 200 {
		t.Fatal("the new password does not work", w.Code)
	}
	w = storeRequest(s, "GET", "/api/users/alice/activity", nil, admin, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "login-failed") {
		t.Fatal("activity", w.Body.String())
	}
	w = storeRequest(s, "GET", "/api/audit", nil, admin, "")
	if !strings.Contains(w.Body.String(), "user-password") || !strings.Contains(w.Body.String(), `"ip"`) {
		t.Fatal("audit lacks the change or the address", w.Body.String()[:400])
	}
}

func TestThinkLevelAndOfferedDepths(t *testing.T) {
	for in, want := range map[string]thinkLevel{`true`: "high", `false`: "", `"low"`: "low", `"xhigh"`: "xhigh", `"ultra"`: "ultra", `"extreme"`: ""} {
		var o aiOpts
		if err := json.Unmarshal([]byte(`{"think":`+in+`}`), &o); err != nil || o.Think != want {
			t.Fatalf("%s: %q %v", in, o.Think, err)
		}
	}
	// unset: every depth is offered; an administrator's list wins, and an empty one turns the choice off
	if got := (aiModel{ID: "any"}).effortOffer(); len(got) != len(allEfforts) {
		t.Fatal(got)
	}
	some := []string{"low", "high"}
	none := []string{}
	if got := (aiModel{Efforts: &some}).effortOffer(); len(got) != 2 || got[1] != "high" {
		t.Fatal(got)
	}
	if got := (aiModel{Efforts: &none}).effortOffer(); got == nil || len(got) != 0 {
		t.Fatal(got)
	}
	if got := (aiModel{Think: "none"}).effortOffer(); len(got) != 0 {
		t.Fatal("the old off switch is lost", got)
	}
}

func TestSkillOverridesScriptsAndSecurityIsolation(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, alcsrf := storeLogin(t, s, "alice")
	bob, _ := storeLogin(t, s, "bob")

	// 1. Admin can override a built-in skill (content + scripts) and later restore default
	overrideBody := `{"disabled":[],"custom":[],"overrides":[{"name":"etcd-ops","title":"etcd 集群运维（定制）","description":"本单位定制的 etcd 巡检与配额规范","content":"每周三凌晨窗口整理碎片。","scripts":[{"name":"check_quorum.py","description":"核算多数派","code":"import json, sys\nprint(json.dumps({'ok': True}))\n"}]}]}`
	w := storeRequest(s, "PUT", "/api/settings/ai/skills", strings.NewReader(overrideBody), admin, acsrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"customized":true`) || !strings.Contains(w.Body.String(), "每周三凌晨窗口") {
		t.Fatalf("override save failed: %d %s", w.Code, w.Body.String())
	}
	// Overriding a non-builtin skill name must fail
	badOverride := `{"overrides":[{"name":"not-a-builtin","title":"x","description":"x","content":"ok"}]}`
	if w = storeRequest(s, "PUT", "/api/settings/ai/skills", strings.NewReader(badOverride), admin, acsrf); w.Code != 400 {
		t.Fatalf("expected 400 for non-builtin override, got %d", w.Code)
	}
	// Resetting overrides restores built-in content and default scripts
	if w = storeRequest(s, "PUT", "/api/settings/ai/skills", strings.NewReader(`{"disabled":[],"custom":[],"overrides":[]}`), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	sk, ok := s.skillFor("alice", "etcd-ops")
	if !ok || sk.Customized || len(sk.Scripts) == 0 || sk.Scripts[0].Name != "calc_etcd_quorum.py" {
		t.Fatalf("builtin skill did not restore cleanly: %+v", sk)
	}

	// 2. Script filename & secret guards on personal skills
	for _, bad := range []string{
		`{"skills":[{"name":"my-ops","title":"测试","description":"说明","content":"ok","scripts":[{"name":"../escape.py","code":"print(1)"}]}]}`,
		`{"skills":[{"name":"my-ops","title":"测试","description":"说明","content":"ok","scripts":[{"name":"_internal.py","code":"print(1)"}]}]}`,
		`{"skills":[{"name":"my-ops","title":"测试","description":"说明","content":"ok","scripts":[{"name":"shell.sh","code":"echo 1"}]}]}`,
		`{"skills":[{"name":"my-ops","title":"测试","description":"说明","content":"ok","scripts":[{"name":"leak.py","code":"` + "pass" + "word=hunter2" + `\nprint(1)"}]}]}`,
	} {
		if w = storeRequest(s, "PUT", "/api/me/skills", strings.NewReader(bad), alice, alcsrf); w.Code != 400 {
			t.Fatalf("expected 400 for unsafe script payload %s, got %d", bad, w.Code)
		}
	}

	// 3. Alice saves a valid personal skill with a script
	goodPersonal := `{"skills":[{"name":"alice-net-calc","title":"网段掩码核算","description":"核算个人负责的网段容量","content":"先看子网位数。","scripts":[{"name":"calc_cidr.py","description":"计算子网可用主机数","code":"import json, sys\nprint('ok')\n"}]}]}`
	if w = storeRequest(s, "PUT", "/api/me/skills", strings.NewReader(goodPersonal), alice, alcsrf); w.Code != 200 {
		t.Fatalf("personal skill save failed: %d %s", w.Code, w.Body.String())
	}

	// Alice sees her script manifest via use_skill
	aliceExt := s.extFor("assistant", aiOpts{User: "alice"})
	if out := aliceExt.wrap(nil)("use_skill", `{"name":"alice-net-calc"}`); !strings.Contains(out, "calc_cidr.py") {
		t.Fatalf("alice use_skill missing script manifest: %s", out)
	}

	// 4. Personal isolation: Bob CANNOT read or execute Alice's personal skill
	bobExt := s.extFor("assistant", aiOpts{User: "bob"})
	if out := bobExt.wrap(nil)("use_skill", `{"name":"alice-net-calc"}`); !strings.Contains(out, "没有这个技能") {
		t.Fatalf("bob read alice personal skill: %s", out)
	}
	if out := bobExt.wrap(nil)("run_skill_script", `{"skill":"alice-net-calc","script":"calc_cidr.py"}`); !strings.Contains(out, "没有权限访问该技能") {
		t.Fatalf("bob executed alice personal skill script: %s", out)
	}
	_ = bob

	// 5. Platform isolation (zero confused-deputy escalation):
	// Alice stores a private CSV in her own space; Bob invokes a PLATFORM skill script referencing Alice's file name or ID -> MUST fail!
	fst := s.storageSettings()
	aliceNode, err := s.storeOne("alice", "", "alice-private.csv", strings.NewReader("ip,role\n10.0.0.1,primary\n"), fst, fst.quotaOf("alice"), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range []string{"alice-private.csv", aliceNode.ID} {
		out := bobExt.wrap(nil)("run_skill_script", `{"skill":"spreadsheet-analysis","script":"profile_csv_quality.py","files":["`+ref+`"]}`)
		if !strings.Contains(out, "用户的存储空间里没有这个文件") {
			t.Fatalf("platform skill script allowed cross-user file lookup (%s): %s", ref, out)
		}
	}

	// Anonymous user cannot invoke run_skill_script
	anonExt := s.extFor("assistant")
	if out := anonExt.wrap(nil)("run_skill_script", `{"skill":"etcd-ops","script":"calc_etcd_quorum.py"}`); !strings.Contains(out, "未识别当前登录用户") {
		t.Fatalf("anonymous execution not blocked: %s", out)
	}
}

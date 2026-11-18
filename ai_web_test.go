package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestWebFetchStaysOffTheInternalNetwork(t *testing.T) {
	s, _ := testStore(t)
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, `<html><head><title>etcd 空间配额</title><style>.x{}</style><script>alert(1)</script></head><body><nav>菜单</nav><h1>处理 NOSPACE</h1><p>先 compact，再 defrag。</p><p>最后 alarm disarm &amp; 检查。</p></body></html>`)
	}))
	defer page.Close()
	ctx := context.Background()
	if _, err := s.webFetch(ctx, aiWeb{Enabled: true}, page.URL); err == nil || !strings.Contains(err.Error(), "内网") {
		t.Fatal("an internal address was fetched:", err)
	}
	if _, err := s.webFetch(ctx, aiWeb{Enabled: true}, "file:///etc/passwd"); err == nil {
		t.Fatal("a file address was fetched")
	}
	out, err := s.webFetch(ctx, aiWeb{Enabled: true, AllowPrivate: true}, page.URL)
	if err != nil || !strings.Contains(out, "标题：etcd 空间配额") || !strings.Contains(out, "先 compact，再 defrag。") || !strings.Contains(out, "alarm disarm & 检查") || strings.Contains(out, "alert(1)") || strings.Contains(out, "菜单") {
		t.Fatal(err, out)
	}
}

func TestDuckDuckGoResultsAreRead(t *testing.T) {
	page := `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fetcd.io%2Fdocs%2Fop%2Dguide%2Fmaintenance%2F&amp;rut=x">etcd <b>Maintenance</b></a>
	<a class="result__snippet" href="x">Compact and <b>defragment</b> the keyspace.</a></div>
	<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">广告</a><a class="result__snippet" href="y">ad</a></div>`
	got := parseDDG(page)
	if len(got) != 1 || got[0].URL != "https://etcd.io/docs/op-guide/maintenance/" || got[0].Title != "etcd Maintenance" || !strings.Contains(got[0].Snippet, "defragment") {
		t.Fatal(got)
	}
}

func TestMessageOptionsChooseTools(t *testing.T) {
	s, _ := testStore(t)
	st := s.aiLoad()
	st.Web = aiWeb{Enabled: true, Provider: "duckduckgo"}
	s.aiSave(st)
	names := func(x *aiExt) map[string]bool {
		m := map[string]bool{}
		for _, d := range x.tools {
			m[d.Name] = true
		}
		return m
	}
	if n := names(s.extFor("assistant")); n["web_search"] {
		t.Fatal("the web was offered without being asked for")
	}
	if n := names(s.extFor("assistant", aiOpts{Web: true})); !n["web_search"] || !n["web_fetch"] {
		t.Fatal("the web was asked for but not offered")
	}
	none := []string{}
	if n := names(s.extFor("assistant", aiOpts{Skills: &none})); n["use_skill"] {
		t.Fatal("skills were offered after all were switched off")
	}
	one := []string{"etcd-ops"}
	x := s.extFor("assistant", aiOpts{Skills: &one})
	if !strings.Contains(x.prompt, "etcd-ops") || strings.Contains(x.prompt, "ansible-debug") {
		t.Fatal("skill choice ignored", x.prompt)
	}
	if stepKind("web_search") != "web" {
		t.Fatal("web step kind")
	}
	st.Web.Enabled = false
	s.aiSave(st)
	if n := names(s.extFor("assistant", aiOpts{Web: true})); n["web_search"] {
		t.Fatal("the web was offered while the administrator has it off")
	}
}

func TestDeepThinkingAsksForEffortAndFallsBack(t *testing.T) {
	s, _ := testStore(t)
	var mu sync.Mutex
	var seen []map[string]any
	strict := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		seen = append(seen, body)
		mu.Unlock()
		if _, ok := body["reasoning_effort"]; ok && strict {
			http.Error(w, `{"error":{"message":"unknown parameter reasoning_effort"}}`, 400)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, `data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}`+"\n\n"+`data: {"choices":[{"delta":{"content":"好"}}]}`+"\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()
	enc, _ := s.aiEncrypt("k")
	p := aiProvider{Name: "x", URL: srv.URL, KeyEnc: enc, Model: "m"}
	var thought strings.Builder
	ctx := withThinking(withEffort(context.Background(), "high"), func(t string) { thought.WriteString(t) })
	rep, err := s.aiChat(ctx, p, []aiMessage{{Role: "user", Content: "hi"}}, nil, nil)
	if err != nil || rep.Text != "好" || thought.String() != "想一想" {
		t.Fatal(err, rep.Text, thought.String())
	}
	if _, ok := seen[0]["reasoning_effort"]; !ok {
		t.Fatal("deep thinking was not asked for")
	}
	if _, ok := seen[len(seen)-1]["reasoning_effort"]; ok {
		t.Fatal("a server that rejects the parameter was asked again with it")
	}
}

func TestResponsesAPIShowsReasoningSummaryAndCallsTools(t *testing.T) {
	var bodies []string
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, r.URL.Path+" "+string(b))
		n++
		w.Header().Set("Content-Type", "text/event-stream")
		if n == 1 {
			io.WriteString(w, "event: response.output_item.done\ndata: "+`{"type":"response.output_item.done","item":{"type":"reasoning","id":"rs1","summary":[{"type":"summary_text","text":"**先看交付**\n\n需要列出交付。"}]}}`+"\n\n")
			io.WriteString(w, "event: response.output_item.added\ndata: "+`{"type":"response.output_item.added","item":{"type":"function_call","id":"fc1","call_id":"call_9","name":"list_deliveries"}}`+"\n\n")
			io.WriteString(w, "event: response.function_call_arguments.done\ndata: "+`{"type":"response.function_call_arguments.done","item_id":"fc1","arguments":"{}"}`+"\n\n")
			io.WriteString(w, "event: response.completed\ndata: "+`{"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":9,"input_tokens_details":{"cached_tokens":20},"output_tokens_details":{"reasoning_tokens":4}}}}`+"\n\n")
			return
		}
		io.WriteString(w, "event: response.output_text.delta\ndata: "+`{"type":"response.output_text.delta","delta":"你有 1 份交付。"}`+"\n\n")
		io.WriteString(w, "event: response.completed\ndata: "+`{"type":"response.completed","response":{"usage":{"input_tokens":80,"output_tokens":6}}}`+"\n\n")
	}))
	defer srv.Close()
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	storeCreate(t, s, alice, csrf, singleNodeSpec, nil)
	s.wg.Wait()
	enableAI(t, s, srv.URL, 1)
	st := s.aiLoad()
	st.Providers[0].API = "responses"
	st.Providers[0].Models[0].ID = "gpt-5"
	if err := s.aiSave(st); err != nil {
		t.Fatal(err)
	}
	w := storeRequest(s, "POST", "/api/ai/chats/0123456789ab/chat", strings.NewReader(`{"message":"我有哪些交付？","options":{"think":"medium"}}`), alice, csrf)
	out := w.Body.String()
	if w.Code != 200 || !strings.Contains(out, `"t":"think"`) || !strings.Contains(out, "先看交付") || !strings.Contains(out, "list_deliveries") || !strings.Contains(out, "你有 1 份交付") {
		t.Fatal(w.Code, out)
	}
	if !strings.HasPrefix(bodies[0], "/responses ") || !strings.Contains(bodies[0], `"effort":"medium"`) || !strings.Contains(bodies[0], `"summary":"detailed"`) || !strings.Contains(bodies[0], `"reasoning.encrypted_content"`) || !strings.Contains(bodies[0], `"store":false`) {
		t.Fatal(bodies[0])
	}
	// the tool's answer goes back as a function_call_output for the same call
	if !strings.Contains(bodies[1], `"type":"function_call_output"`) || !strings.Contains(bodies[1], `"call_id":"call_9"`) || !strings.Contains(bodies[1], `"type":"function_call"`) {
		t.Fatal(bodies[1])
	}
}

func TestAskUserEndsTheTurnWithQuestions(t *testing.T) {
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: "+`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ask_user","arguments":"{\"questions\":[{\"question\":\"哪种部署？\",\"options\":[{\"label\":\"单机\"},{\"label\":\"集群\"}]}]}"}}]}}]}`+"\n\n")
		io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	enableAI(t, s, srv.URL, 1)
	w := storeRequest(s, "POST", "/api/ai/chats/0123456789ab/chat", strings.NewReader(`{"message":"帮我部署"}`), alice, csrf)
	out := w.Body.String()
	if w.Code != 200 || !strings.Contains(out, `"t":"ask"`) || !strings.Contains(out, "哪种部署") || n != 1 {
		t.Fatal(w.Code, n, out)
	}
	if got := s.extFor("assistant", aiOpts{User: "alice"}).tools; !func() bool {
		for _, d := range got {
			if d.Name == "ask_user" {
				return true
			}
		}
		return false
	}() {
		t.Fatal("ask_user not offered")
	}
}

func TestTableToolGivesExactFigures(t *testing.T) {
	s, _ := testStore(t)
	var csvText strings.Builder
	csvText.WriteString("主机,角色,内存GB\n")
	for i := 0; i < 1000; i++ {
		role := "pg"
		if i%4 == 0 {
			role = "etcd"
		}
		fmt.Fprintf(&csvText, "node-%04d,%s,%d\n", i, role, 8+i%3*8)
	}
	st := s.storageSettings()
	n, err := s.storeOne("alice", "", "hosts.csv", strings.NewReader(csvText.String()), st, st.quotaOf("alice"), "")
	if err != nil {
		t.Fatal(err)
	}
	_ = n
	got := s.runTable("alice", "table_query", `{"file":"hosts.csv","group_by":["角色"],"aggs":[{"fn":"count","as":"台数"},{"fn":"sum","column":"内存GB","as":"内存合计"}],"order_by":{"column":"台数","desc":true}}`)
	// 250 etcd and 750 pg; memory 8/16/24 cycles over i%3
	if !strings.Contains(got, "| pg | 750 |") || !strings.Contains(got, "| etcd | 250 |") {
		t.Fatal(got)
	}
	got = s.runTable("alice", "table_query", `{"file":"hosts.csv","where":[{"column":"角色","op":"eq","value":"etcd"},{"column":"内存GB","op":"ge","value":"16"}],"aggs":[{"fn":"count"}]}`)
	if !strings.Contains(got, "符合条件的") || !strings.Contains(got, "| 1") {
		t.Fatal(got)
	}
	if got = s.runTable("alice", "table_query", `{"file":"hosts.csv","group_by":["没有这列"]}`); !strings.Contains(got, "这张表的列有：主机、角色、内存GB") {
		t.Fatal(got)
	}
	if got = s.runTable("alice", "table_describe", `{"file":"hosts"}`); !strings.Contains(got, "1000 行数据") || !strings.Contains(got, "数字") {
		t.Fatal(got)
	}
}

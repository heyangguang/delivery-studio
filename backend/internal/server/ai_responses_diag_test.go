package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func mockHTTPResp(req *http.Request, status int, contentType string, headers map[string]string, body string) *http.Response {
	h := make(http.Header)
	if contentType != "" {
		h.Set("Content-Type", contentType)
	}
	for k, v := range headers {
		h.Set(k, v)
	}
	statusText := http.StatusText(status)
	statusLine := ""
	if statusText != "" {
		statusLine = http.StatusText(status)
	}
	return &http.Response{
		StatusCode: status,
		Status:     strings.TrimSpace(strings.Join([]string{httpStatusNum(status), statusLine}, " ")),
		Header:     h,
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}

func httpStatusNum(code int) string {
	b, _ := json.Marshal(code)
	return string(b)
}

func TestAIResponsesReasoningSpecGating(t *testing.T) {
	openAIModels := []string{
		"gpt-5",
		"gpt-5.4-mini",
		"openai/o1-pro",
		"o3-mini",
		"openai/o4-mini",
		"codex/gpt-6.1-sol",
		"computer-use-preview",
	}
	for _, m := range openAIModels {
		r, inc := responsesReasoningSpec(m, "high")
		if r == nil || r["summary"] != "detailed" || r["effort"] != "high" {
			t.Fatalf("expected detailed reasoning spec for native OpenAI model %q, got %#v", m, r)
		}
		if len(inc) != 1 || inc[0] != "reasoning.encrypted_content" {
			t.Fatalf("expected encrypted_content include for %q, got %#v", m, inc)
		}
	}

	nonOpenAIModels := []string{
		"zerotoken/claude-sonnet-5-5",
		"anthropic/claude-opus-4-6",
		"gemini-2.5-pro",
		"deepseek-r1",
		"qwen-max",
		"GLM-5.3-Flash",
		"kimi-k2",
		"minimax-m1",
		"hunyuan-turbos",
		"doubao-seed-1.6",
		"ernie-4.5",
		"yi-lightning",
		"step-2-16k",
	}
	for _, m := range nonOpenAIModels {
		r0, inc0 := responsesReasoningSpec(m, "")
		if r0 != nil || inc0 != nil {
			t.Fatalf("expected nil reasoning & include for non-OpenAI model %q with empty effort, got r=%#v inc=%#v", m, r0, inc0)
		}
		r1, inc1 := responsesReasoningSpec(m, "high")
		if r1 == nil || r1["effort"] != "high" || r1["summary"] != nil {
			t.Fatalf("expected effort-only reasoning for non-OpenAI model %q with effort=high, got %#v", m, r1)
		}
		if inc1 != nil {
			t.Fatalf("must never send OpenAI reasoning.encrypted_content include for %q, got %#v", m, inc1)
		}
	}
}

const magpieEmptyResponsesSSE = ": keepalive\n: keepalive\n: keepalive\n: keepalive\n" +
	"event: response.created\n" +
	`data: {"type":"response.created","response":{"id":"msg_011Ch1FvWwEgjuu9voEvKKBk","object":"response","status":"in_progress","output":[]}}` + "\n\n" +
	"event: response.completed\n" +
	`data: {"type":"response.completed","response":{"id":"msg_011Ch1FvWwEgjuu9voEvKKBk","object":"response","status":"completed","output":[],"usage":{"input_tokens":3813,"output_tokens":0,"cache_creation_input_tokens":3809}}}` + "\n\n"

func TestAIResponsesMagpieEmptyOutputAutoFallbackSuccess(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")

	secretKey := "magpie-secret-key-99887766"
	var mu sync.Mutex
	type seenCall struct {
		path string
		body map[string]any
		auth string
	}
	var calls []seenCall

	s.setAITransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(req.Body)
		var parsed map[string]any
		_ = json.Unmarshal(raw, &parsed)
		mu.Lock()
		calls = append(calls, seenCall{path: req.URL.Path, body: parsed, auth: req.Header.Get("Authorization")})
		mu.Unlock()

		switch {
		case strings.HasSuffix(req.URL.Path, "/responses"):
			return mockHTTPResp(req, 200, "text/event-stream", nil, magpieEmptyResponsesSSE), nil
		case strings.HasSuffix(req.URL.Path, "/chat/completions"):
			if parsed["tools"] != nil {
				return mockHTTPResp(req, 200, "text/event-stream", map[string]string{"x-request-id": "req_tool_1"},
					`data: {"id":"chatcmpl_tool","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_time","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n"), nil
			}
			rawStr := string(raw)
			ans := `{"thinking":"已核对3节点拓扑","title":"Redis主从演练","scope_summary":"平滑演练","questions":[{"id":"q1","question":"维护窗口？","options":["凌晨"]}]}`
			if strings.Contains(rawStr, "什么颜色") {
				ans = "红色"
			} else if strings.Contains(rawStr, "回复 ok") {
				ans = "ok"
			}
			chunk, _ := json.Marshal(ans)
			sse := ": keepalive\n" +
				`data: {"id":"chatcmpl_ok_01","choices":[{"delta":{"content":` + string(chunk) + `},"finish_reason":"stop"}],"usage":{"prompt_tokens":3813,"completion_tokens":42,"cache_read_input_tokens":3809}}` +
				"\n\ndata: [DONE]\n\n"
			return mockHTTPResp(req, 200, "text/event-stream", nil, sse), nil
		default:
			return mockHTTPResp(req, 404, "application/json", nil, `{"error":{"message":"not found"}}`), nil
		}
	}))
	t.Cleanup(func() { s.setAITransport(nil) })

	// 1. Direct rehearsal-like call with system instructions + baseline prompt:
	enc, err := s.aiEncrypt(secretKey)
	if err != nil {
		t.Fatal(err)
	}
	prov := aiProvider{
		ID:      "magpie",
		Name:    "内网测试 (Magpie)",
		Preset:  "custom",
		API:     "responses",
		URL:     "https://gwuser:gwpass@magpie.corp.internal/v1?gateway_token=tok123",
		Enabled: true,
		Private: true,
		KeyEnc:  enc,
		Model:   "zerotoken/claude-sonnet-5-5",
	}

	var streamed strings.Builder
	rep, err := s.aiChat(context.Background(), prov, []aiMessage{
		{Role: "system", Content: rehearsalScopeSystem},
		{Role: "user", Content: "【集群初始交付基线】3813 tokens baseline..."},
	}, nil, func(delta string) { streamed.WriteString(delta) })
	if err != nil {
		t.Fatalf("expected auto-fallback to succeed, got error: %v", err)
	}
	if !strings.Contains(rep.Text, "Redis主从演练") || streamed.String() != rep.Text {
		t.Fatalf("unexpected fallback reply text=%q streamed=%q", rep.Text, streamed.String())
	}
	if rep.Diag == nil || rep.Diag.FallbackUsed != "responses -> chat/completions" {
		t.Fatalf("expected FallbackUsed='responses -> chat/completions', got %+v", rep.Diag)
	}
	if len(rep.Diag.Attempts) != 2 {
		t.Fatalf("expected 2 attempts (1 responses + 1 chat/completions), got %d: %+v", len(rep.Diag.Attempts), rep.Diag.Attempts)
	}
	att0 := rep.Diag.Attempts[0]
	if att0.API != "responses" || att0.HTTPStatus != 200 || att0.InTokens != 3813 || att0.CachedTokens != 3809 || att0.Keepalives != 4 || att0.ResponseID != "msg_011Ch1FvWwEgjuu9voEvKKBk" {
		t.Fatalf("unexpected first attempt diag: %+v", att0)
	}

	mu.Lock()
	if len(calls) != 2 {
		mu.Unlock()
		t.Fatalf("expected exactly 2 HTTP calls (no redundant reasoning retry for claude), got %d", len(calls))
	}
	firstReq := calls[0]
	mu.Unlock()
	if firstReq.auth != "Bearer "+secretKey {
		t.Fatalf("expected Authorization header set, got %q", firstReq.auth)
	}
	if _, hasReasoning := firstReq.body["reasoning"]; hasReasoning {
		t.Fatalf("zerotoken/claude-sonnet-5-5 with empty effort must not send reasoning: %#v", firstReq.body["reasoning"])
	}
	if _, hasInclude := firstReq.body["include"]; hasInclude {
		t.Fatalf("zerotoken/claude-sonnet-5-5 must never send OpenAI include encrypted_content: %#v", firstReq.body["include"])
	}
	if firstReq.body["instructions"] == nil || firstReq.body["instructions"] == "" {
		t.Fatalf("expected system message mapped to instructions on /responses")
	}

	// 2. Verify aiTestProvider sends system+user (instructions path) and records test_warn + test_diag on fallback!
	createProvBody := `{"name":"内网测试 (Magpie)","preset":"custom","api":"responses","private":true,"url":"https://magpie.corp.internal/v1","enabled":true,"key":"` + secretKey + `","models":[{"id":"zerotoken/claude-sonnet-5-5","enabled":true}]}`
	w := storeRequest(s, "POST", "/api/settings/ai/providers", strings.NewReader(createProvBody), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("create provider failed: %d %s", w.Code, w.Body.String())
	}
	var pv struct{ ID string }
	_ = json.Unmarshal(w.Body.Bytes(), &pv)

	mu.Lock()
	calls = nil
	mu.Unlock()

	w = storeRequest(s, "POST", "/api/settings/ai/providers/"+pv.ID+"/test?model=zerotoken/claude-sonnet-5-5", nil, admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("aiTestProvider failed: %d %s", w.Code, w.Body.String())
	}
	var tested aiModel
	if err := json.Unmarshal(w.Body.Bytes(), &tested); err != nil {
		t.Fatal(err)
	}
	if !tested.TestOK || tested.TestWarn == "" || tested.TestDiag == nil || tested.TestDiag.FallbackUsed != "responses -> chat/completions" {
		t.Fatalf("expected TestOK=true with TestWarn and TestDiag, got %+v", tested)
	}
	mu.Lock()
	probeFirst := calls[0]
	mu.Unlock()
	if probeFirst.body["instructions"] == nil || probeFirst.body["instructions"] == "" {
		t.Fatalf("expected aiTestProvider probe to exercise instructions field, got %#v", probeFirst.body)
	}
}

func TestAIResponsesMagpieFallback402FullWhiteBoxDiagAndKeySafety(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	admin, _ := storeLogin(t, s, "admin")

	w := storeCreate(t, s, alice, csrf, `{"id":"magpie-rh","hosts":[{"name":"n1","ip":"10.0.5.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	var job storeJob
	_ = json.Unmarshal(w.Body.Bytes(), &job)
	_ = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)

	apiKey := "sk-live-SuperSecretMagpieKey999999"
	s.setAITransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch {
		case strings.HasSuffix(req.URL.Path, "/responses"):
			return mockHTTPResp(req, 200, "text/event-stream", nil, magpieEmptyResponsesSSE), nil
		case strings.HasSuffix(req.URL.Path, "/chat/completions"):
			return mockHTTPResp(req, 402, "application/json", map[string]string{"x-request-id": "req_402_xyz"},
				`{"error":{"code":"server_error","message":""}}`), nil
		default:
			return mockHTTPResp(req, 404, "application/json", nil, `{}`), nil
		}
	}))
	t.Cleanup(func() { s.setAITransport(nil) })

	enc, _ := s.aiEncrypt(apiKey)
	st := s.aiLoad()
	st.Enabled = true
	st.Providers = []aiProvider{{
		ID:      "magpie",
		Name:    "内网测试 (Magpie)",
		Preset:  "custom",
		API:     "responses",
		URL:     "https://leakuser:leakpass@magpie.corp.internal/v1?secret=topsecretquery",
		Private: true,
		Enabled: true,
		KeyEnc:  enc,
		Models:  []aiModel{{ID: "zerotoken/claude-sonnet-5-5", Enabled: true, Tools: "yes", Vision: "yes"}},
	}}
	if err := s.aiSave(st); err != nil {
		t.Fatal(err)
	}

	// 1. Direct aiChat check on *aiCallError & Diag fields:
	p := st.aiProvidersFor("change_rehearsal")[0]
	_, callErr := s.aiChat(context.Background(), p, []aiMessage{
		{Role: "system", Content: "系统指令"},
		{Role: "user", Content: "变更演练基线"},
	}, nil, nil)
	if callErr == nil {
		t.Fatal("expected error when both /responses and /chat/completions fail")
	}
	var ce *aiCallError
	if !errors.As(callErr, &ce) || ce.Diag == nil {
		t.Fatalf("expected *aiCallError with non-nil Diag, got %T: %v", callErr, callErr)
	}
	diag := aiDiagFromErr(callErr)
	if len(diag.Attempts) != 2 {
		t.Fatalf("expected 2 attempts in Diag, got %d: %+v", len(diag.Attempts), diag.Attempts)
	}
	if diag.Attempts[0].InTokens != 3813 || diag.Attempts[0].CachedTokens != 3809 || diag.Attempts[0].ResponseID != "msg_011Ch1FvWwEgjuu9voEvKKBk" {
		t.Fatalf("attempt[0] mismatch: %+v", diag.Attempts[0])
	}
	if diag.Attempts[1].HTTPStatus != 402 || !strings.HasSuffix(diag.Attempts[1].Endpoint, "/chat/completions") {
		t.Fatalf("attempt[1] mismatch: %+v", diag.Attempts[1])
	}
	if diag.FallbackUsed != "responses -> chat/completions" || diag.HTTPStatus != 402 {
		t.Fatalf("unexpected top-level diag: %+v", diag)
	}

	// Security redline: zero plaintext API key, userinfo, or secret query parameter anywhere!
	diagBytes, _ := json.Marshal(diag)
	fullDump := string(diagBytes) + "\n" + callErr.Error()
	for _, secret := range []string{apiKey, "SuperSecretMagpieKey", "leakuser", "leakpass", "topsecretquery"} {
		if strings.Contains(fullDump, secret) {
			t.Fatalf("SECURITY LEAK: found secret %q inside diagnostic payload:\n%s", secret, fullDump)
		}
	}
	if !json.Valid([]byte(diag.RequestSummary)) {
		t.Fatalf("expected valid JSON in RequestSummary, got:\n%s", diag.RequestSummary)
	}
	if !strings.Contains(diag.ResponseRaw, "msg_011Ch1FvWwEgjuu9voEvKKBk") || !strings.Contains(diag.ResponseRaw, "server_error") {
		t.Fatalf("expected ResponseRaw to preserve both /responses SSE and /chat/completions 402 body, got:\n%s", diag.ResponseRaw)
	}

	// 2. Rehearsal SSE endpoint (?stream=1) must emit diag on both the failed step event and the error event:
	w = storeRequest(s, "POST", "/api/clusters/magpie-rh/rehearsals?stream=1", strings.NewReader(`{"goal":"在线滚动调整 etcd 存储配额到 8GB"}`), alice, csrf)
	sseOut := w.Body.String()
	if !strings.Contains(sseOut, `"t":"error"`) || !strings.Contains(sseOut, `"fallback_used":"responses -\u003e chat/completions"`) && !strings.Contains(sseOut, `"fallback_used":"responses -> chat/completions"`) {
		t.Fatalf("expected rehearsal SSE error to carry full diag, got:\n%s", sseOut)
	}
	for _, secret := range []string{apiKey, "leakpass", "topsecretquery"} {
		if strings.Contains(sseOut, secret) {
			t.Fatalf("secret %q leaked into rehearsal SSE stream", secret)
		}
	}

	// 3. Rehearsal non-streaming JSON endpoint must return {"error": ..., "diag": ...}:
	w = storeRequest(s, "POST", "/api/clusters/magpie-rh/rehearsals", strings.NewReader(`{"goal":"在线滚动调整 etcd 存储配额到 8GB"}`), alice, csrf)
	if w.Code != 502 {
		t.Fatalf("expected 502 on non-streaming rehearsal failure, got %d %s", w.Code, w.Body.String())
	}
	var errJSON struct {
		Error string      `json:"error"`
		Diag  *aiCallDiag `json:"diag"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &errJSON); err != nil || errJSON.Diag == nil || len(errJSON.Diag.Attempts) != 2 {
		t.Fatalf("expected non-streaming error JSON with 2 attempts in diag, got: %s", w.Body.String())
	}

	// 4. AI Usage log must record backfilled tokens, status, response_id and diag:
	w = storeRequest(s, "GET", "/api/settings/ai/usage", nil, admin, "")
	var uList struct {
		Rows []aiUsage `json:"rows"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &uList)
	if len(uList.Rows) == 0 {
		t.Fatalf("expected usage rows recorded, got empty")
	}
	latest := uList.Rows[0]
	if latest.In != 3813 || latest.Cached != 3809 || latest.HTTPStatus != 402 || latest.Diag == nil || len(latest.Diag.Attempts) != 2 {
		t.Fatalf("expected usage row backfilled from diag, got %+v", latest)
	}
}

func TestAIResponsesNonDeltaCompletedOutputAndNestedSSEError(t *testing.T) {
	s, _ := testStore(t)
	enc, _ := s.aiEncrypt("sk-test-nondelta-12345678")
	baseProv := aiProvider{
		ID:      "p1",
		Name:    "Responses 网关",
		Preset:  "openai",
		API:     "responses",
		URL:     "https://api.example.internal/v1",
		Private: true,
		Enabled: true,
		KeyEnc:  enc,
		Model:   "gpt-5",
	}

	t.Run("NonDeltaCompletedOutputAndToolCall", func(t *testing.T) {
		completedSSE := "event: response.created\n" +
			`data: {"type":"response.created","response":{"id":"resp_nd_01","status":"in_progress"}}` + "\n\n" +
			"event: response.completed\n" +
			`data: {"type":"response.completed","response":{"id":"resp_nd_01","status":"completed","output":[{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"先检查主从复制状态"}]},{"type":"message","id":"msg_1","content":[{"type":"output_text","text":"非流式兜底提取成功"}]},{"type":"function_call","id":"fc_1","call_id":"call_abc","name":"cluster_status","arguments":"{\"verbose\":true}"}],"usage":{"input_tokens":120,"output_tokens":35,"cache_read_input_tokens":80}}}` + "\n\n"

		s.setAITransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if !strings.HasSuffix(req.URL.Path, "/responses") {
				t.Fatalf("unexpected fallback call to %s", req.URL.Path)
			}
			return mockHTTPResp(req, 200, "text/event-stream", nil, completedSSE), nil
		}))
		defer s.setAITransport(nil)

		var streamedText, streamedThink strings.Builder
		ctx := withThinking(context.Background(), func(th string) { streamedThink.WriteString(th) })
		rep, err := s.aiChat(ctx, baseProv, []aiMessage{{Role: "user", Content: "检查集群"}}, nil, func(delta string) {
			streamedText.WriteString(delta)
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if rep.Text != "非流式兜底提取成功" || streamedText.String() != "非流式兜底提取成功" {
			t.Fatalf("expected non-delta output_text extracted & streamed, got text=%q stream=%q", rep.Text, streamedText.String())
		}
		if rep.Thinking != "先检查主从复制状态" || !strings.Contains(streamedThink.String(), "先检查主从复制状态") {
			t.Fatalf("expected reasoning summary extracted, got %q", rep.Thinking)
		}
		if len(rep.ToolCalls) != 1 || rep.ToolCalls[0].ID != "call_abc" || rep.ToolCalls[0].Function.Name != "cluster_status" {
			t.Fatalf("expected function_call extracted from response.completed.output, got %+v", rep.ToolCalls)
		}
		if rep.In != 120 || rep.Out != 35 || rep.Cached != 80 {
			t.Fatalf("unexpected usage: in=%d out=%d cached=%d", rep.In, rep.Out, rep.Cached)
		}
	})

	t.Run("TopLevelErrorWithNestedErrorObject", func(t *testing.T) {
		errSSE := `data: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"Input prompt exceeds maximum context window"}}` + "\n\n"
		callCount := 0
		s.setAITransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
			callCount++
			if strings.HasSuffix(req.URL.Path, "/chat/completions") {
				return mockHTTPResp(req, 404, "application/json", nil, `{"error":{"message":"not found"}}`), nil
			}
			return mockHTTPResp(req, 200, "text/event-stream", map[string]string{"x-request-id": "req_err_99"}, errSSE), nil
		}))
		defer s.setAITransport(nil)

		_, err := s.aiChat(context.Background(), baseProv, []aiMessage{{Role: "user", Content: "hi"}}, nil, nil)
		if err == nil {
			t.Fatal("expected error from type:error SSE event")
		}
		if callCount != 3 {
			t.Fatalf("expected 3 self-healing attempts (responses+reasoning -> clean responses -> chat fallback), got %d calls", callCount)
		}
		if !strings.Contains(err.Error(), "Input prompt exceeds maximum context window") || !strings.Contains(err.Error(), "context_length_exceeded") {
			t.Fatalf("expected nested error.message and error.code preserved in error text, got: %v", err)
		}
		diag := aiDiagFromErr(err)
		if diag == nil || diag.ReasonCode != "sse_error" || diag.ResponseID != "req_err_99" || len(diag.Attempts) != 3 {
			t.Fatalf("expected sse_error diag with x-request-id fallback and 3 attempts, got %+v", diag)
		}
	})

	t.Run("OpenAIReasoningEmptyOutputRetriesCleanResponsesBeforeChat", func(t *testing.T) {
		var reqBodies []map[string]any
		s.setAITransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
			b, _ := io.ReadAll(req.Body)
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			reqBodies = append(reqBodies, m)
			if len(reqBodies) == 1 {
				// First /responses with reasoning returns empty output:[]
				return mockHTTPResp(req, 200, "text/event-stream", nil, magpieEmptyResponsesSSE), nil
			}
			// Second /responses without reasoning succeeds!
			okSSE := `data: {"type":"response.output_text.delta","delta":"纯净重试成功"}` + "\n\n" +
				`data: {"type":"response.completed","response":{"id":"resp_clean_2","status":"completed","usage":{"input_tokens":50,"output_tokens":6}}}` + "\n\n"
			return mockHTTPResp(req, 200, "text/event-stream", nil, okSSE), nil
		}))
		defer s.setAITransport(nil)

		rep, err := s.aiChat(context.Background(), baseProv, []aiMessage{{Role: "user", Content: "测试"}}, nil, nil)
		if err != nil || rep.Text != "纯净重试成功" {
			t.Fatalf("expected clean /responses retry to succeed, got rep=%q err=%v", rep.Text, err)
		}
		if len(reqBodies) != 2 || reqBodies[0]["reasoning"] == nil || reqBodies[1]["reasoning"] != nil || reqBodies[1]["include"] != nil {
			t.Fatalf("expected #1 with reasoning and #2 without reasoning/include, got %#v", reqBodies)
		}
		if rep.Diag == nil || len(rep.Diag.Attempts) != 2 {
			t.Fatalf("expected 2 attempts recorded in Diag, got %+v", rep.Diag)
		}
	})

	t.Run("FriendlyTransportErrorPreservesDiag", func(t *testing.T) {
		s.setAITransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return nil, bytes.ErrTooLarge // wrap check below with timeout
		}))
		s.setAITransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return nil, context.DeadlineExceeded
		}))
		defer s.setAITransport(nil)

		_, err := s.aiChat(context.Background(), baseProv, []aiMessage{{Role: "user", Content: "timeout"}}, nil, nil)
		if err == nil || !strings.Contains(err.Error(), "响应超时") {
			t.Fatalf("expected friendly timeout message, got %v", err)
		}
		diag := aiDiagFromErr(err)
		if diag == nil || diag.ReasonCode != "timeout" || diag.Provider != baseProv.Name || diag.Model != baseProv.Model {
			t.Fatalf("expected aiFriendly to preserve Diag with ReasonCode='timeout', got %+v", diag)
		}
	})

	t.Run("ChatCompletionsMidStreamErrorAndJobChatDiagSSE", func(t *testing.T) {
		alice, csrf := storeLogin(t, s, "alice")
		w := storeCreate(t, s, alice, csrf, `{"id":"chat-diag-job","hosts":[{"name":"n1","ip":"10.0.9.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
		s.wg.Wait()
		var job storeJob
		_ = json.Unmarshal(w.Body.Bytes(), &job)

		s.setAITransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
			sse := `data: {"id":"chatcmpl_err_1","error":{"type":"upstream_error","code":"overloaded","message":"Downstream Claude channel overloaded"}}` + "\n\ndata: [DONE]\n\n"
			return mockHTTPResp(req, 200, "text/event-stream", nil, sse), nil
		}))
		defer s.setAITransport(nil)

		st := s.aiLoad()
		st.Enabled = true
		st.Providers = []aiProvider{{
			ID:      "chatp",
			Name:    "Chat 网关",
			Preset:  "custom",
			API:     "chat",
			URL:     "https://chat.corp.internal/v1",
			Private: true,
			Enabled: true,
			KeyEnc:  enc,
			Models:  []aiModel{{ID: "claude-sonnet-4-5", Enabled: true, Tools: "yes", Vision: "yes"}},
		}}
		_ = s.aiSave(st)

		w = storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/chat", strings.NewReader(`{"key":"review","message":"请评审交付"}`), alice, csrf)
		out := w.Body.String()
		if !strings.Contains(out, "Downstream Claude channel overloaded") || !strings.Contains(out, `"reason_code":"sse_error"`) || !strings.Contains(out, `"response_id":"chatcmpl_err_1"`) {
			t.Fatalf("expected /api/jobs/{id}/ai/chat error event to carry sse_error diag, got:\n%s", out)
		}
		if strings.Contains(out, "模型没有返回内容") {
			t.Fatalf("mid-stream ch.Error must not be swallowed as 模型没有返回内容:\n%s", out)
		}
	})
}

func TestAIDanglingRefsDefaultModelsAndRehearsalPick(t *testing.T) {
	// 1. GPT-6 / GPT-7 reasoning detection (e.g. kril/gpt-6.1-sol, auto/gpt-6.1-sol):
	for _, m := range []string{"kril/gpt-6.1-sol", "auto/gpt-6.1-sol", "gpt-6", "gpt-7-mini"} {
		r, inc := responsesReasoningSpec(m, "high")
		if r == nil || r["summary"] != "detailed" || r["effort"] != "high" || len(inc) != 1 || inc[0] != "reasoning.encrypted_content" {
			t.Fatalf("expected %s treated as native OpenAI reasoning model, got r=%#v inc=%#v", m, r, inc)
		}
	}

	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, csrf := storeLogin(t, s, "alice")

	// 2. Dangling model/provider reference pruning & self-healing (while keeping disabled models intact):
	w := storeRequest(s, "POST", "/api/settings/ai/providers", strings.NewReader(
		`{"name":"主网关","preset":"custom","private":true,"url":"https://gw1.internal/v1","enabled":true,"key":"sk-gw1-123456","models":[`+
			`{"id":"m-keep","name":"保留模型","enabled":true,"context":128000},`+
			`{"id":"m-disabled","name":"暂禁模型","enabled":false},`+
			`{"id":"m-delete","name":"待删模型","enabled":true}]}`,
	), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("create p1 failed: %d %s", w.Code, w.Body.String())
	}
	var p1 struct{ ID string }
	_ = json.Unmarshal(w.Body.Bytes(), &p1)

	w = storeRequest(s, "POST", "/api/settings/ai/providers", strings.NewReader(
		`{"name":"备网关","preset":"custom","private":true,"url":"https://gw2.internal/v1","enabled":true,"key":"sk-gw2-123456","models":[`+
			`{"id":"m-backup","name":"备用模型","enabled":true,"context":64000},`+
			`{"id":"m-admin-only","name":"管理员直选模型","enabled":true,"context":200000}]}`,
	), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("create p2 failed: %d %s", w.Code, w.Body.String())
	}
	var p2 struct{ ID string }
	_ = json.Unmarshal(w.Body.Bytes(), &p2)

	// Save settings with stale refs mixed in -> must self-heal (200 OK) instead of failing with 400!
	putSettings := `{"enabled":true,"features":{` +
		`"change_rehearsal":{"enabled":true,"primary":"` + p1.ID + `|m-delete","backup":"ghost-prov|ghost-model"},` +
		`"assistant":{"enabled":true,"primary":"` + p1.ID + `|m-disabled","backup":"` + p2.ID + `|m-backup"}` +
		`},"user_models":["` + p1.ID + `|m-keep","` + p1.ID + `|m-delete","` + p1.ID + `|m-disabled","ghost|missing","` + p1.ID + `|m-keep"]}`
	w = storeRequest(s, "PUT", "/api/settings/ai", strings.NewReader(putSettings), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("PUT /api/settings/ai with stale refs should auto-heal with 200, got %d %s", w.Code, w.Body.String())
	}
	st := s.aiLoad()
	if st.Features["change_rehearsal"].Backup != "" {
		t.Fatalf("expected ghost backup cleared, got %q", st.Features["change_rehearsal"].Backup)
	}
	if st.Features["assistant"].Primary != p1.ID+"|m-disabled" {
		t.Fatalf("disabled model ref must NOT be pruned, got %q", st.Features["assistant"].Primary)
	}
	if len(st.UserModels) != 3 {
		t.Fatalf("expected deduplicated valid user_models (3), got %v", st.UserModels)
	}

	// Remove m-delete from p1 via PUT /api/settings/ai/providers/:id -> must prune p1|m-delete from Features and UserModels, while keeping m-disabled!
	w = storeRequest(s, "PUT", "/api/settings/ai/providers/"+p1.ID, strings.NewReader(
		`{"name":"主网关","preset":"custom","private":true,"url":"https://gw1.internal/v1","enabled":true,"models":[`+
			`{"id":"m-keep","name":"保留模型","enabled":true,"context":128000},`+
			`{"id":"m-disabled","name":"暂禁模型","enabled":false}]}`,
	), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("update p1 failed: %d %s", w.Code, w.Body.String())
	}
	st = s.aiLoad()
	if st.Features["change_rehearsal"].Primary != "" {
		t.Fatalf("deleted model p1|m-delete should be pruned from change_rehearsal.primary, got %q", st.Features["change_rehearsal"].Primary)
	}
	if st.Features["assistant"].Primary != p1.ID+"|m-disabled" {
		t.Fatalf("disabled model p1|m-disabled must remain intact, got %q", st.Features["assistant"].Primary)
	}
	for _, r := range st.UserModels {
		if r == p1.ID+"|m-delete" {
			t.Fatalf("deleted model should be pruned from user_models, got %v", st.UserModels)
		}
	}

	// 3. Verify /api/ai/models exposes default_models alongside models & defaults:
	mView := s.aiModels()
	dm, ok := mView["default_models"].(map[string]pickable)
	if !ok {
		t.Fatalf("expected default_models map[string]pickable, got %T", mView["default_models"])
	}
	rhDefault, ok := dm["change_rehearsal"]
	if !ok || rhDefault.Ref != p1.ID+"|m-keep" || rhDefault.Name != "保留模型" || rhDefault.Context != 128000 || len(rhDefault.Effort) == 0 {
		t.Fatalf("unexpected default_models[change_rehearsal]: %+v", rhDefault)
	}

	// 4. Verify aiTestProvider switches follow-up tool & vision probes to /chat/completions after initial /responses fallback (502/422):
	w = storeRequest(s, "POST", "/api/settings/ai/providers", strings.NewReader(
		`{"name":"Responses502网关","preset":"custom","api":"responses","private":true,"url":"https://gw502.internal/v1","enabled":true,"key":"sk-502","models":[{"id":"kril/gpt-6.1-sol","enabled":true}]}`,
	), admin, acsrf)
	var p3 struct{ ID string }
	_ = json.Unmarshal(w.Body.Bytes(), &p3)

	var respHits, chatHits int
	var hitMu sync.Mutex
	s.setAITransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		b, _ := io.ReadAll(req.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		hitMu.Lock()
		defer hitMu.Unlock()
		if strings.HasSuffix(req.URL.Path, "/responses") {
			respHits++
			// Return 502 Bad Gateway on /responses (after optional reasoning retry if 422; 502 goes straight to Step 2 fallback!)
			return mockHTTPResp(req, 502, "application/json", nil, `{"error":{"message":"bad gateway"}}`), nil
		}
		chatHits++
		// Simulate 422 on stream_options first time to verify 422 retry in aiChatCompletions too!
		if body["stream_options"] != nil && chatHits == 1 {
			return mockHTTPResp(req, 422, "application/json", nil, `{"error":{"message":"stream_options unsupported"}}`), nil
		}
		if body["tools"] != nil {
			sse := `data: {"id":"c_tool","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_time","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}` + "\n\ndata: [DONE]\n\n"
			return mockHTTPResp(req, 200, "text/event-stream", nil, sse), nil
		}
		sse := `data: {"id":"c_ok","choices":[{"delta":{"content":"红色 ok"},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n"
		return mockHTTPResp(req, 200, "text/event-stream", nil, sse), nil
	}))
	defer s.setAITransport(nil)

	w = storeRequest(s, "POST", "/api/settings/ai/providers/"+p3.ID+"/test?model=kril/gpt-6.1-sol", nil, admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("test provider p3 failed: %d %s", w.Code, w.Body.String())
	}
	var testedM aiModel
	_ = json.Unmarshal(w.Body.Bytes(), &testedM)
	if !testedM.TestOK || testedM.Tools != "yes" || testedM.Vision != "yes" {
		t.Fatalf("expected TestOK=true, Tools=yes, Vision=yes, got %+v", testedM)
	}
	hitMu.Lock()
	gotRespHits := respHits
	hitMu.Unlock()
	if gotRespHits != 1 {
		t.Fatalf("expected follow-up tool & vision probes to skip broken /responses (respHits=1), got respHits=%d", gotRespHits)
	}

	// 5. Verify Change Rehearsal honors per-call model & effort (both user_models for alice and admin override for admin):
	st = s.aiLoad()
	st.UserModels = []string{p2.ID + "|m-backup"}
	_ = s.aiSave(st)

	w = storeCreate(t, s, alice, csrf, `{"id":"rh-pick-cluster","hosts":[{"name":"n1","ip":"10.0.8.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	var job storeJob
	_ = json.Unmarshal(w.Body.Bytes(), &job)
	_ = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)

	var seenModels []string
	var seenEfforts []any
	s.setAITransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		b, _ := io.ReadAll(req.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		hitMu.Lock()
		mName, _ := body["model"].(string)
		seenModels = append(seenModels, mName)
		seenEfforts = append(seenEfforts, body["reasoning_effort"])
		callIdx := len(seenModels)
		hitMu.Unlock()

		var content string
		switch callIdx {
		case 1:
			content = `{"thinking":"核对基线","title":"配额升级","scope_summary":"滚动变更","questions":[{"id":"q1","question":"窗口？","options":["低峰期","停机"]}]}`
		case 2:
			content = `{"thinking":"设计只读探针","probe_script":"#!/usr/bin/env bash\netcdctl endpoint status\n","probe_notes":["只读采集"]}`
		case 3:
			content = `{"thinking":"比对漂移","drift":{"summary":"一致","drifted":false,"hosts":[]},"steps":[{"id":"s1","phase":"precheck","order":1,"title":"检查成员","target_role":"n1","command":"etcdctl member list","expect":"正常"}]}`
		default:
			content = `{"thinking":"定位权限问题","diagnosis":"需要指定证书参数","action":"replace","command":"etcdctl --cacert=/etc/etcd/ca.pem member list","expect":"正常"}`
		}
		raw, _ := json.Marshal(content)
		sse := `data: {"id":"cmpl_rh","choices":[{"delta":{"content":` + string(raw) + `},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n"
		return mockHTTPResp(req, 200, "text/event-stream", nil, sse), nil
	}))

	// 5a. Alice picks user_models model p2|m-backup + effort="high" on createRehearsal:
	w = storeRequest(s, "POST", "/api/clusters/rh-pick-cluster/rehearsals", strings.NewReader(
		`{"goal":"在线调整 etcd 存储配额到 8GB","model":"`+p2.ID+`|m-backup","effort":"high"}`,
	), alice, csrf)
	if w.Code != 201 {
		t.Fatalf("alice createRehearsal failed: %d %s", w.Code, w.Body.String())
	}
	var rh changeRehearsal
	_ = json.Unmarshal(w.Body.Bytes(), &rh)

	// 5b. Admin picks non-user_models model p2|m-admin-only + effort="medium" on scope, probe, and troubleshoot:
	w = storeRequest(s, "POST", "/api/clusters/rh-pick-cluster/rehearsals/"+rh.ID+"/scope", strings.NewReader(
		`{"answers":[{"id":"q1","answer":"低峰期"}],"model":"`+p2.ID+`|m-admin-only","effort":"medium"}`,
	), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("admin submitRehearsalScope failed: %d %s", w.Code, w.Body.String())
	}
	w = storeRequest(s, "POST", "/api/clusters/rh-pick-cluster/rehearsals/"+rh.ID+"/probe", strings.NewReader(
		`{"probe_output":"10.0.8.11, 8e9e05c52164694d, 3.5.12","model":"`+p2.ID+`|m-admin-only","effort":"low"}`,
	), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("admin submitRehearsalProbe failed: %d %s", w.Code, w.Body.String())
	}
	w = storeRequest(s, "POST", "/api/clusters/rh-pick-cluster/rehearsals/"+rh.ID+"/steps/s1/troubleshoot", strings.NewReader(
		`{"error_output":"Error: context deadline exceeded","model":"`+p2.ID+`|m-admin-only","effort":"xhigh"}`,
	), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("admin troubleshootRehearsalStep failed: %d %s", w.Code, w.Body.String())
	}

	hitMu.Lock()
	defer hitMu.Unlock()
	wantModels := []string{"m-backup", "m-admin-only", "m-admin-only", "m-admin-only"}
	wantEfforts := []string{"high", "medium", "low", "xhigh"}
	if len(seenModels) != 4 {
		t.Fatalf("expected 4 rehearsal calls, got %d (%v)", len(seenModels), seenModels)
	}
	for i := range wantModels {
		if seenModels[i] != wantModels[i] || seenEfforts[i] != wantEfforts[i] {
			t.Fatalf("call #%d: got model=%q effort=%v, want model=%q effort=%q", i+1, seenModels[i], seenEfforts[i], wantModels[i], wantEfforts[i])
		}
	}

	// 5c. Deleting p2 via DELETE /api/settings/ai/providers/:id must also prune p2|m-backup from UserModels!
	w = storeRequest(s, "DELETE", "/api/settings/ai/providers/"+p2.ID, nil, admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("delete provider p2 failed: %d %s", w.Code, w.Body.String())
	}
	st = s.aiLoad()
	for _, r := range st.UserModels {
		if strings.HasPrefix(r, p2.ID+"|") {
			t.Fatalf("DELETE provider should prune its user_models refs, got %v", st.UserModels)
		}
	}
}

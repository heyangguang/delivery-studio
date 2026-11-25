package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// An OpenAI compatible chat client: POST {url}/chat/completions with streaming and tool calls. Azure differs only in
// the api-key header and the api-version query.

type aiAttemptDiag struct {
	Endpoint       string   `json:"endpoint"`
	API            string   `json:"api"`
	HTTPStatus     int      `json:"http_status,omitempty"`
	MS             int64    `json:"ms"`
	ResponseID     string   `json:"response_id,omitempty"`
	UpstreamStatus string   `json:"upstream_status,omitempty"`
	Reason         string   `json:"reason,omitempty"`
	InTokens       int      `json:"in_tokens,omitempty"`
	OutTokens      int      `json:"out_tokens,omitempty"`
	CachedTokens   int      `json:"cached_tokens,omitempty"`
	SSEEvents      []string `json:"sse_events,omitempty"`
	Keepalives     int      `json:"keepalives,omitempty"`
	RequestNote    string   `json:"request_note,omitempty"`
}

type aiCallDiag struct {
	Provider       string          `json:"provider,omitempty"`
	Model          string          `json:"model,omitempty"`
	API            string          `json:"api,omitempty"`
	Endpoint       string          `json:"endpoint,omitempty"`
	HTTPStatus     int             `json:"http_status,omitempty"`
	ReasonCode     string          `json:"reason_code,omitempty"` // "empty_output" | "http_error" | "sse_error" | "incomplete" | "network_error" | "timeout"
	ResponseID     string          `json:"response_id,omitempty"`
	UpstreamStatus string          `json:"upstream_status,omitempty"`
	MS             int64           `json:"ms,omitempty"`
	InTokens       int             `json:"in_tokens,omitempty"`
	OutTokens      int             `json:"out_tokens,omitempty"`
	CachedTokens   int             `json:"cached_tokens,omitempty"`
	SSEEvents      []string        `json:"sse_events,omitempty"`
	Keepalives     int             `json:"keepalives,omitempty"`
	RequestSummary string          `json:"request_summary,omitempty"`
	ResponseRaw    string          `json:"response_raw,omitempty"`
	FallbackUsed   string          `json:"fallback_used,omitempty"`
	Attempts       []aiAttemptDiag `json:"attempts,omitempty"`
}

type aiCallError struct {
	Msg  string
	Diag *aiCallDiag
	Err  error
}

func (e *aiCallError) Error() string { return e.Msg }
func (e *aiCallError) Unwrap() error { return e.Err }

func aiDiagFromErr(err error) *aiCallDiag {
	var ce *aiCallError
	if errors.As(err, &ce) && ce != nil {
		return ce.Diag
	}
	return nil
}

type aiMessage struct {
	Role       string       `json:"role"`
	Content    any          `json:"content,omitempty"` // string, or []map for text+image parts
	ToolCalls  []aiToolCall `json:"tool_calls,omitempty"`
	ToolCallID string       `json:"tool_call_id,omitempty"`
}

type aiToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type aiToolDef struct {
	Name, Description string
	Parameters        map[string]any
}

type aiReply struct {
	Text      string
	ToolCalls []aiToolCall
	In, Out   int
	// Cached is the part of In the vendor served from its prompt cache; Reasoning the part of Out spent thinking.
	Cached, Reasoning int
	// FirstMS is how long the first token took; Rounds how many model calls the answer needed.
	FirstMS int64
	Rounds  int
	// Thinking is what a reasoning model said before answering.
	Thinking string
	// Steps and TotalMS describe the whole answer, tools included (see aiToolLoop).
	Steps   []aiStep
	TotalMS int64
	// Ask is set when the assistant ended its turn with questions for the person.
	Ask *aiAsk
	// Files are what the assistant made for the person (see run_python).
	Files []fileRef
	// Diag carries white-box protocol diagnostics (populated on protocol fallback or error).
	Diag *aiCallDiag
}

var (
	aiTransportOverrides sync.Map // *storeServer -> http.RoundTripper
	aiDefaultTransport   http.RoundTripper
	aiChatFallbackModels sync.Map // "<serverPtr>|<providerID>|<url>|<model>" -> bool
)

func (s *storeServer) chatFallbackKey(p aiProvider) string {
	return fmt.Sprintf("%p|%s|%s|%s", s, p.ID, strings.TrimRight(strings.TrimSpace(p.URL), "/"), strings.TrimSpace(p.Model))
}

func (s *storeServer) rememberChatFallback(p aiProvider) {
	if s == nil || strings.TrimSpace(p.Model) == "" {
		return
	}
	aiChatFallbackModels.Store(s.chatFallbackKey(p), true)
}

func (s *storeServer) clearChatFallback(p aiProvider) {
	if s == nil || strings.TrimSpace(p.Model) == "" {
		return
	}
	aiChatFallbackModels.Delete(s.chatFallbackKey(p))
}

func (s *storeServer) prefersChatFallback(p aiProvider) bool {
	if p.TestDiag != nil && p.TestDiag.FallbackUsed != "" {
		rc := p.TestDiag.ReasonCode
		hs := p.TestDiag.HTTPStatus
		if rc == "empty_output" || hs == 404 || hs == 405 || hs == 501 || !isNativeOpenAIReasoningModel(p.Model) {
			return true
		}
	}
	if s == nil || strings.TrimSpace(p.Model) == "" {
		return false
	}
	_, ok := aiChatFallbackModels.Load(s.chatFallbackKey(p))
	return ok
}

type idleWatchdog struct {
	parent   context.Context
	timedOut atomic.Bool
	touch    func()
}

type idleWatchdogKey struct{}

// newStreamIdleContext cancels the request only when no bytes/events arrive for `idle`,
// rather than cutting off an actively streaming long answer at a fixed wall-clock mark.
func newStreamIdleContext(parent context.Context, idle time.Duration) (context.Context, func()) {
	if idle <= 0 {
		idle = 240 * time.Second
	}
	ctx, cancel := context.WithCancel(parent)
	w := &idleWatchdog{parent: parent}
	var mu sync.Mutex
	stopped := false
	timer := time.AfterFunc(idle, func() {
		mu.Lock()
		if stopped {
			mu.Unlock()
			return
		}
		w.timedOut.Store(true)
		mu.Unlock()
		cancel()
	})
	w.touch = func() {
		mu.Lock()
		if !stopped {
			timer.Reset(idle)
		}
		mu.Unlock()
	}
	stop := func() {
		mu.Lock()
		stopped = true
		timer.Stop()
		mu.Unlock()
		cancel()
	}
	ctx = context.WithValue(ctx, idleWatchdogKey{}, w)
	return ctx, stop
}

func touchStreamIdle(ctx context.Context) {
	if w, _ := ctx.Value(idleWatchdogKey{}).(*idleWatchdog); w != nil && w.touch != nil {
		w.touch()
	}
}

func normalizeStreamErr(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if w, _ := ctx.Value(idleWatchdogKey{}).(*idleWatchdog); w != nil && w.timedOut.Load() && w.parent.Err() == nil {
		return fmt.Errorf("%w: 模型流式通道长时间无响应", context.DeadlineExceeded)
	}
	return err
}

type streamBeatKey struct{}

func withStreamBeat(ctx context.Context, f func(string)) context.Context {
	return context.WithValue(ctx, streamBeatKey{}, f)
}

func notifyStreamBeat(ctx context.Context, kind string) {
	if f, _ := ctx.Value(streamBeatKey{}).(func(string)); f != nil && kind != "" {
		f(kind)
	}
}

type forceProbeResponsesKey struct{}

func withForceProbeResponses(ctx context.Context) context.Context {
	return context.WithValue(ctx, forceProbeResponsesKey{}, true)
}

func (s *storeServer) setAITransport(rt http.RoundTripper) {
	if s == nil {
		return
	}
	if rt == nil {
		aiTransportOverrides.Delete(s)
	} else {
		aiTransportOverrides.Store(s, rt)
	}
}

func (s *storeServer) aiHTTPClient() *http.Client {
	if s != nil {
		if v, ok := aiTransportOverrides.Load(s); ok && v != nil {
			return &http.Client{Transport: v.(http.RoundTripper)}
		}
	}
	if aiDefaultTransport != nil {
		return &http.Client{Transport: aiDefaultTransport}
	}
	return &http.Client{}
}

func providerTargetURL(p aiProvider, path string) string {
	raw := strings.TrimSpace(p.URL)
	if u, err := url.Parse(raw); err == nil && u.Scheme != "" && u.Host != "" {
		u.Path = strings.TrimRight(u.Path, "/") + path
		if p.Preset == "azure" {
			v := p.APIVersion
			if v == "" {
				v = "2024-10-21"
			}
			q := u.Query()
			q.Set("api-version", v)
			u.RawQuery = q.Encode()
		}
		return u.String()
	}
	target := strings.TrimRight(raw, "/") + path
	if p.Preset == "azure" {
		v := p.APIVersion
		if v == "" {
			v = "2024-10-21"
		}
		sep := "?"
		if strings.Contains(target, "?") {
			sep = "&"
		}
		target += sep + "api-version=" + v
	}
	return target
}

// sanitizeDiagEndpoint keeps only "METHOD scheme://host/path" (plus api-version if set), stripping userinfo and query secrets.
func sanitizeDiagEndpoint(method, rawURL string) string {
	method = strings.TrimSpace(method)
	u, err := url.Parse(strings.TrimSpace(rawURL))
	var clean string
	if err != nil || u.Scheme == "" || u.Host == "" {
		clean = aiScrub(rawURL)
		if idx := strings.Index(clean, "?"); idx >= 0 {
			clean = clean[:idx]
		}
	} else {
		u.User = nil
		u.Fragment = ""
		av := u.Query().Get("api-version")
		u.RawQuery = ""
		if av != "" {
			qv := url.Values{}
			qv.Set("api-version", av)
			u.RawQuery = qv.Encode()
		}
		clean = u.String()
	}
	if method == "" {
		return clean
	}
	return method + " " + clean
}

func (s *storeServer) scrubDiagText(p aiProvider, raw string) string {
	if raw == "" {
		return ""
	}
	if s != nil && p.KeyEnc != "" {
		if k, err := s.aiDecrypt(p.KeyEnc); err == nil && len(k) >= 4 {
			raw = strings.ReplaceAll(raw, k, aiMasked)
		}
	}
	return truncRunes(aiScrub(raw), 3200)
}

type diagMsgSummary struct {
	Role   string `json:"role"`
	Chars  int    `json:"chars"`
	Images int    `json:"images,omitempty"`
	Tools  int    `json:"tool_calls,omitempty"`
}

type diagReqSummary struct {
	API               string           `json:"api"`
	Model             string           `json:"model"`
	Stream            bool             `json:"stream"`
	Store             *bool            `json:"store,omitempty"`
	StreamOptions     any              `json:"stream_options,omitempty"`
	Reasoning         any              `json:"reasoning,omitempty"`
	ReasoningEffort   string           `json:"reasoning_effort,omitempty"`
	Include           any              `json:"include,omitempty"`
	MaxOutputTokens   int              `json:"max_output_tokens,omitempty"`
	MaxTokens         int              `json:"max_tokens,omitempty"`
	ToolsCount        int              `json:"tools_count"`
	InstructionsChars int              `json:"instructions_chars,omitempty"`
	Messages          []diagMsgSummary `json:"messages"`
}

func (s *storeServer) buildDiagRequestSummary(p aiProvider, api string, body map[string]any, msgs []aiMessage) string {
	sum := diagReqSummary{
		API:      api,
		Model:    p.Model,
		Messages: make([]diagMsgSummary, 0, len(msgs)),
	}
	if m, ok := body["model"].(string); ok && m != "" {
		sum.Model = m
	}
	if v, ok := body["stream"].(bool); ok {
		sum.Stream = v
	}
	if v, ok := body["store"].(bool); ok {
		b := v
		sum.Store = &b
	}
	if v, ok := body["stream_options"]; ok {
		sum.StreamOptions = v
	}
	if v, ok := body["reasoning"]; ok {
		sum.Reasoning = v
	}
	if v, ok := body["reasoning_effort"].(string); ok {
		sum.ReasoningEffort = v
	}
	if v, ok := body["include"]; ok {
		sum.Include = v
	}
	if v, ok := body["max_output_tokens"].(int); ok {
		sum.MaxOutputTokens = v
	}
	if v, ok := body["max_tokens"].(int); ok {
		sum.MaxTokens = v
	}
	if ts, ok := body["tools"].([]map[string]any); ok {
		sum.ToolsCount = len(ts)
	}
	if instr, ok := body["instructions"].(string); ok && instr != "" {
		sum.InstructionsChars = utf8.RuneCountInString(instr)
	}
	for _, m := range msgs {
		ms := diagMsgSummary{Role: m.Role, Tools: len(m.ToolCalls)}
		switch c := m.Content.(type) {
		case string:
			ms.Chars = utf8.RuneCountInString(c)
		case []map[string]any:
			for _, pt := range c {
				switch pt["type"] {
				case "text":
					if txt, ok := pt["text"].(string); ok {
						ms.Chars += utf8.RuneCountInString(txt)
					}
				case "image_url":
					ms.Images++
				}
			}
		}
		sum.Messages = append(sum.Messages, ms)
	}
	b, _ := json.MarshalIndent(sum, "", "  ")
	return s.scrubDiagText(p, string(b))
}

type sseRawCapture struct {
	head         []string
	headRunes    int
	tail         []string
	keepaliveCap int
	omitted      int
}

func (c *sseRawCapture) add(rawLine string) {
	trimmed := strings.TrimSpace(rawLine)
	if trimmed == "" {
		return
	}
	if strings.HasPrefix(trimmed, ":") {
		c.keepaliveCap++
		if c.keepaliveCap > 6 {
			c.omitted++
			return
		}
	}
	n := utf8.RuneCountInString(trimmed)
	if c.headRunes+n <= 1800 && c.omitted == 0 {
		c.head = append(c.head, trimmed)
		c.headRunes += n + 1
		return
	}
	c.omitted++
	if len(c.tail) >= 14 {
		c.tail = append(c.tail[1:], trimmed)
	} else {
		c.tail = append(c.tail, trimmed)
	}
}

func (c *sseRawCapture) text() string {
	if len(c.tail) == 0 && c.omitted == 0 {
		return strings.Join(c.head, "\n")
	}
	var parts []string
	if len(c.head) > 0 {
		parts = append(parts, strings.Join(c.head, "\n"))
	}
	if c.omitted > len(c.tail) {
		parts = append(parts, fmt.Sprintf("... (已省略 %d 条中间流式帧) ...", c.omitted-len(c.tail)))
	}
	if len(c.tail) > 0 {
		parts = append(parts, strings.Join(c.tail, "\n"))
	}
	return strings.Join(parts, "\n")
}

func appendSSEEventName(events []string, name string) []string {
	name = strings.TrimSpace(name)
	if name == "" {
		return events
	}
	if len(events) > 0 && events[len(events)-1] == name && strings.HasSuffix(name, ".delta") {
		return events
	}
	if len(events) >= 20 {
		if !strings.HasSuffix(name, ".delta") {
			events[len(events)-1] = name
		}
		return events
	}
	return append(events, name)
}

func extractHeaderReqID(h http.Header) string {
	if h == nil {
		return ""
	}
	return strings.TrimSpace(firstNonEmptyStr(
		h.Get("x-request-id"),
		h.Get("request-id"),
		h.Get("x-amzn-requestid"),
		h.Get("cf-ray"),
	))
}

func anyCodeStr(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(x)
	default:
		return strings.TrimSpace(fmt.Sprint(x))
	}
}

type sseErrPayload struct {
	Message string `json:"message"`
	Code    any    `json:"code"`
	Type    string `json:"type"`
}

func formatSSEErrorObj(topMsg string, topCode any, errObj *sseErrPayload) string {
	var msg, code, typ string
	if errObj != nil {
		msg = strings.TrimSpace(errObj.Message)
		code = anyCodeStr(errObj.Code)
		typ = strings.TrimSpace(errObj.Type)
	}
	if msg == "" {
		msg = strings.TrimSpace(topMsg)
	}
	if code == "" {
		code = anyCodeStr(topCode)
	}
	msg = cleanUpstreamErrText(msg)
	switch {
	case msg != "" && code != "" && !strings.Contains(msg, code):
		return fmt.Sprintf("%s (%s)", msg, code)
	case msg != "":
		return msg
	case code != "" && typ != "" && code != typ:
		return fmt.Sprintf("%s (%s)", code, typ)
	case code != "":
		return code
	case typ != "":
		return typ
	default:
		return "供应商返回了流式错误事件"
	}
}

func formatEmptyOutputErr(status int, endpoint string, inTok, outTok, cachedTok int, respID string) string {
	if status <= 0 {
		status = 200
	}
	var details []string
	if inTok > 0 || outTok > 0 || cachedTok > 0 {
		details = append(details, fmt.Sprintf("输入 %d / 输出 %d Token", inTok, outTok))
		if cachedTok > 0 {
			details = append(details, fmt.Sprintf("缓存 %d Token", cachedTok))
		}
	} else if endpoint != "" {
		details = append(details, "端点 "+endpoint)
	}
	if respID != "" {
		details = append(details, "响应 ID "+respID)
	}
	if len(details) == 0 {
		return fmt.Sprintf("模型网关返回 HTTP %d 但未输出任何内容", status)
	}
	return fmt.Sprintf("模型网关返回 HTTP %d 但未输出任何内容（%s）", status, strings.Join(details, "，"))
}

func providerAPIName(p aiProvider) string {
	if p.API == "responses" {
		return "responses"
	}
	return "chat"
}

func (s *storeServer) aiRequest(ctx context.Context, p aiProvider, method, path string, body any) (*http.Response, error) {
	key, err := s.aiDecrypt(p.KeyEnc)
	if err != nil {
		return nil, err
	}
	target := providerTargetURL(p, path)
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		if p.Preset == "azure" {
			req.Header.Set("api-key", key)
		} else {
			req.Header.Set("Authorization", "Bearer "+key)
		}
	}
	return s.aiHTTPClient().Do(req)
}

func aiTimeout(p aiProvider) time.Duration {
	if p.TimeoutSec > 0 {
		return time.Duration(p.TimeoutSec) * time.Second
	}
	return 240 * time.Second
}

func cleanUpstreamErrText(msg string) string {
	msg = strings.TrimSpace(msg)
	// Strip empty nested JSON error wrappers appended by proxy gateways, e.g. `: {"error":{"code":"server_error","message":""}}`
	if idx := strings.Index(msg, `: {"error":`); idx > 0 {
		tail := strings.TrimSpace(msg[idx+2:])
		var nested struct {
			Error struct {
				Code    any    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(tail), &nested) == nil && strings.TrimSpace(nested.Error.Message) == "" {
			msg = strings.TrimSpace(msg[:idx])
		}
	}
	return msg
}

func parseHTTPBodyErr(status int, b []byte) string {
	raw := strings.TrimSpace(string(b))
	msg := raw
	var e struct {
		Message string `json:"message"`
		Detail  string `json:"detail"`
		Error   struct {
			Code    any    `json:"code"`
			Message string `json:"message"`
			Type    string `json:"type"`
		} `json:"error"`
	}
	if json.Unmarshal(b, &e) == nil {
		codeStr := anyCodeStr(e.Error.Code)
		switch {
		case strings.TrimSpace(e.Error.Message) != "":
			msg = strings.TrimSpace(e.Error.Message)
		case codeStr != "":
			msg = codeStr
		case strings.TrimSpace(e.Message) != "":
			msg = strings.TrimSpace(e.Message)
		case strings.TrimSpace(e.Detail) != "":
			msg = strings.TrimSpace(e.Detail)
		}
	}
	msg = cleanUpstreamErrText(msg)
	if utf8.RuneCountInString(msg) > 300 {
		msg = truncRunes(msg, 300)
	}
	statusDesc := fmt.Sprintf("%d", status)
	if st := http.StatusText(status); st != "" {
		statusDesc = fmt.Sprintf("%d %s", status, st)
	}
	if msg == "" {
		return fmt.Sprintf("供应商返回 %s", statusDesc)
	}
	return fmt.Sprintf("供应商返回 %s：%s", statusDesc, msg)
}

func aiHTTPError(resp *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return errors.New(parseHTTPBodyErr(resp.StatusCode, b))
}

func (s *storeServer) aiHTTPErrorDiag(
	p aiProvider,
	api, endpoint, reqSummary, reqNote string,
	resp *http.Response,
	ms int64,
	prior []aiAttemptDiag,
) *aiCallError {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	errMsg := parseHTTPBodyErr(resp.StatusCode, b)
	respID := extractHeaderReqID(resp.Header)
	rawBody := s.scrubDiagText(p, strings.TrimSpace(string(b)))
	if rawBody == "" && resp.Status != "" {
		rawBody = resp.Status
	}
	att := aiAttemptDiag{
		Endpoint:    endpoint,
		API:         api,
		HTTPStatus:  resp.StatusCode,
		MS:          max(1, ms),
		ResponseID:  respID,
		Reason:      fmt.Sprintf("http_%d", resp.StatusCode),
		RequestNote: reqNote,
	}
	attempts := append(append([]aiAttemptDiag(nil), prior...), att)
	diag := &aiCallDiag{
		Provider:       p.Name,
		Model:          p.Model,
		API:            api,
		Endpoint:       endpoint,
		HTTPStatus:     resp.StatusCode,
		ReasonCode:     "http_error",
		ResponseID:     respID,
		MS:             max(1, ms),
		RequestSummary: reqSummary,
		ResponseRaw:    rawBody,
		Attempts:       attempts,
	}
	return &aiCallError{Msg: errMsg, Diag: diag}
}

func (s *storeServer) aiTransportErrorDiag(
	p aiProvider,
	api, endpoint, reqSummary, reqNote string,
	err error,
	ms int64,
	prior []aiAttemptDiag,
) error {
	if err == nil {
		return nil
	}
	rc := "network_error"
	em := err.Error()
	if strings.Contains(em, "i/o timeout") || strings.Contains(em, "context deadline exceeded") || strings.Contains(em, "Client.Timeout") {
		rc = "timeout"
	}
	att := aiAttemptDiag{
		Endpoint:    endpoint,
		API:         api,
		MS:          max(1, ms),
		Reason:      rc,
		RequestNote: reqNote,
	}
	attempts := append(append([]aiAttemptDiag(nil), prior...), att)
	diag := &aiCallDiag{
		Provider:       p.Name,
		Model:          p.Model,
		API:            api,
		Endpoint:       endpoint,
		ReasonCode:     rc,
		MS:             max(1, ms),
		RequestSummary: reqSummary,
		ResponseRaw:    s.scrubDiagText(p, em),
		Attempts:       attempts,
	}
	return &aiCallError{Msg: em, Diag: diag, Err: err}
}

// aiChat runs one model turn. onText receives streamed text as it arrives.
// aiChat sends one conversation turn to a provider. Network failures come back in words a person can act on.
func withEnPromptDirective(msgs []aiMessage) []aiMessage {
	const directive = "\n\n[Interface Language: English (en-US)]\nRespond strictly in natural, concise English (including headings, explanations, checklists, questions, step titles, descriptions, risk notes, and rollback plans). Keep CLI commands, hostnames, paths, YAML keys, and identifiers exact."
	out := make([]aiMessage, 0, len(msgs)+1)
	injected := false
	for _, m := range msgs {
		if m.Role == "system" && !injected {
			if s, ok := m.Content.(string); ok {
				m.Content = s + directive
				injected = true
			}
		}
		out = append(out, m)
	}
	if !injected {
		out = append([]aiMessage{{Role: "system", Content: strings.TrimSpace(directive)}}, out...)
	}
	return out
}

func (s *storeServer) aiChat(ctx context.Context, p aiProvider, msgs []aiMessage, tools []aiToolDef, onText func(string)) (aiReply, error) {
	lang := ctxLang(ctx)
	sendMsgs := msgs
	if isEnLang(lang) {
		sendMsgs = withEnPromptDirective(msgs)
	}
	r, err := s.aiChatOnce(ctx, p, sendMsgs, tools, onText)
	if err != nil {
		err = aiFriendlyLang(err, p, lang)
		if d := aiDiagFromErr(err); d != nil {
			r.Diag = d
		}
	}
	return r, err
}

func aiFriendly(err error, p aiProvider) error { return aiFriendlyLang(err, p, "") }

// aiFriendlyLang turns transport errors into a sentence that says what is wrong and where to look, without dropping Diag.
func aiFriendlyLang(err error, p aiProvider, lang string) error {
	if err == nil {
		return nil
	}
	origDiag := aiDiagFromErr(err)
	msg := cleanUpstreamErrText(err.Error())
	where := tr(lang, "「"+firstNonEmptyStr(p.Name, p.URL)+"」", fmt.Sprintf("%q", firstNonEmptyStr(p.Name, p.URL)))
	friendly := msg
	reasonCode := ""
	switch {
	case strings.Contains(msg, "connection refused"):
		friendly = tr(lang,
			fmt.Sprintf("连不上模型服务%s：对方没有在监听，可能服务没有启动或地址端口不对。请检查 设置 → AI 里的地址，或稍后再试", where),
			fmt.Sprintf("Cannot connect to model provider %s: connection refused (service may not be running or host/port is wrong). Check Settings -> AI.", where),
		)
		reasonCode = "network_error"
	case strings.Contains(msg, "no such host"):
		friendly = tr(lang,
			fmt.Sprintf("找不到模型服务%s的地址：域名解析失败。请检查 设置 → AI 里的地址", where),
			fmt.Sprintf("Cannot resolve hostname for model provider %s. Verify URL in Settings -> AI.", where),
		)
		reasonCode = "network_error"
	case strings.Contains(msg, "i/o timeout") || strings.Contains(msg, "context deadline exceeded") || strings.Contains(msg, "Client.Timeout"):
		friendly = tr(lang,
			fmt.Sprintf("模型服务%s响应超时。可能网络不通或服务太忙，请稍后再试", where),
			fmt.Sprintf("Model provider %s timed out. Check network connectivity or retry shortly.", where),
		)
		reasonCode = "timeout"
	case strings.Contains(msg, "no route to host") || strings.Contains(msg, "network is unreachable"):
		friendly = tr(lang,
			fmt.Sprintf("到模型服务%s的网络不通。请检查平台所在机器能否访问它", where),
			fmt.Sprintf("Network unreachable to model provider %s from platform host.", where),
		)
		reasonCode = "network_error"
	case strings.Contains(msg, "certificate"):
		friendly = tr(lang,
			fmt.Sprintf("模型服务%s的证书校验失败：%s", where, truncRunes(msg, 120)),
			fmt.Sprintf("TLS certificate verification failed for %s: %s", where, truncRunes(msg, 120)),
		)
		reasonCode = "network_error"
	}
	if origDiag != nil {
		cp := *origDiag
		if cp.Provider == "" {
			cp.Provider = p.Name
		}
		if cp.Model == "" {
			cp.Model = p.Model
		}
		if cp.API == "" {
			cp.API = providerAPIName(p)
		}
		if reasonCode != "" && (cp.ReasonCode == "" || cp.ReasonCode == "network_error" || cp.ReasonCode == "timeout") {
			cp.ReasonCode = reasonCode
		}
		return &aiCallError{Msg: friendly, Diag: &cp, Err: err}
	}
	if reasonCode != "" {
		d := &aiCallDiag{
			Provider:    p.Name,
			Model:       p.Model,
			API:         providerAPIName(p),
			ReasonCode:  reasonCode,
			ResponseRaw: truncRunes(aiScrub(err.Error()), 3200),
		}
		return &aiCallError{Msg: friendly, Diag: d, Err: err}
	}
	if friendly != err.Error() {
		return errors.New(friendly)
	}
	return err
}

func (s *storeServer) aiChatOnce(ctx context.Context, p aiProvider, msgs []aiMessage, tools []aiToolDef, onText func(string)) (aiReply, error) {
	forceProbe, _ := ctx.Value(forceProbeResponsesKey{}).(bool)
	ctx, stop := newStreamIdleContext(ctx, aiTimeout(p))
	defer stop()
	effort, _ := ctx.Value(effortKey{}).(string)
	if p.Efforts != nil && len(*p.Efforts) == 0 || p.Efforts == nil && p.Think == "none" {
		effort = ""
	}
	if p.API == "responses" && (forceProbe || !s.prefersChatFallback(p)) {
		return s.aiResponses(ctx, p, msgs, tools, onText, effort)
	}
	return s.aiChatCompletions(ctx, p, msgs, tools, onText, effort)
}

func (s *storeServer) aiChatCompletions(ctx context.Context, p aiProvider, msgs []aiMessage, tools []aiToolDef, onText func(string), effort string) (aiReply, error) {
	curEffort := effort
	build := func(usage bool) map[string]any {
		body := map[string]any{"model": p.Model, "messages": msgs, "stream": true}
		if usage {
			body["stream_options"] = map[string]any{"include_usage": true}
		}
		if curEffort != "" {
			body["reasoning_effort"] = curEffort
		}
		if p.MaxTokens > 0 {
			body["max_tokens"] = p.MaxTokens
		}
		if len(tools) > 0 {
			var ts []map[string]any
			for _, t := range tools {
				ts = append(ts, map[string]any{"type": "function", "function": map[string]any{"name": t.Name, "description": t.Description, "parameters": cleanSchema(t.Parameters)}})
			}
			body["tools"] = ts
		}
		return body
	}

	endpoint := sanitizeDiagEndpoint("POST", providerTargetURL(p, "/chat/completions"))
	var attempts []aiAttemptDiag
	began := time.Now()
	curBody := build(true)
	curNote := "chat/completions"
	reqSummary := s.buildDiagRequestSummary(p, "chat", curBody, msgs)

	attemptStart := time.Now()
	resp, err := s.aiRequest(ctx, p, "POST", "/chat/completions", curBody)
	if err != nil {
		return aiReply{}, s.aiTransportErrorDiag(p, "chat", endpoint, reqSummary, curNote, normalizeStreamErr(ctx, err), time.Since(attemptStart).Milliseconds(), attempts)
	}
	if resp.StatusCode == 400 || resp.StatusCode == 422 {
		// some servers reject stream_options or reasoning_effort with 400/422; ask again without them
		st1 := resp.StatusCode
		_, _ = io.ReadAll(io.LimitReader(resp.Body, 1024))
		resp.Body.Close()
		attempts = append(attempts, aiAttemptDiag{
			Endpoint:    endpoint,
			API:         "chat",
			HTTPStatus:  st1,
			MS:          max(1, time.Since(attemptStart).Milliseconds()),
			ResponseID:  extractHeaderReqID(resp.Header),
			Reason:      fmt.Sprintf("http_%d_retry_without_stream_options", st1),
			RequestNote: curNote,
		})
		curBody = build(false)
		curNote = "chat/completions (no stream_options)"
		reqSummary = s.buildDiagRequestSummary(p, "chat", curBody, msgs)
		attemptStart = time.Now()
		if resp, err = s.aiRequest(ctx, p, "POST", "/chat/completions", curBody); err != nil {
			return aiReply{}, s.aiTransportErrorDiag(p, "chat", endpoint, reqSummary, curNote, normalizeStreamErr(ctx, err), time.Since(attemptStart).Milliseconds(), attempts)
		}
		if (resp.StatusCode == 400 || resp.StatusCode == 422) && curEffort != "" {
			st2 := resp.StatusCode
			_, _ = io.ReadAll(io.LimitReader(resp.Body, 1024))
			resp.Body.Close()
			attempts = append(attempts, aiAttemptDiag{
				Endpoint:    endpoint,
				API:         "chat",
				HTTPStatus:  st2,
				MS:          max(1, time.Since(attemptStart).Milliseconds()),
				ResponseID:  extractHeaderReqID(resp.Header),
				Reason:      fmt.Sprintf("http_%d_retry_without_effort", st2),
				RequestNote: curNote,
			})
			curEffort = ""
			curBody = build(false)
			curNote = "chat/completions (plain)"
			reqSummary = s.buildDiagRequestSummary(p, "chat", curBody, msgs)
			attemptStart = time.Now()
			if resp, err = s.aiRequest(ctx, p, "POST", "/chat/completions", curBody); err != nil {
				return aiReply{}, s.aiTransportErrorDiag(p, "chat", endpoint, reqSummary, curNote, normalizeStreamErr(ctx, err), time.Since(attemptStart).Milliseconds(), attempts)
			}
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return aiReply{}, s.aiHTTPErrorDiag(p, "chat", endpoint, reqSummary, curNote, resp, time.Since(attemptStart).Milliseconds(), attempts)
	}
	touchStreamIdle(ctx)
	if onConn, _ := ctx.Value(connectKey{}).(func(int64)); onConn != nil {
		onConn(max(1, time.Since(began).Milliseconds()))
	}

	var out aiReply
	onThink, _ := ctx.Value(thinkKey{}).(func(string))
	tags := &thinkTags{}
	calls := map[int]*aiToolCall{}
	var rawCap sseRawCapture
	var sseEvents []string
	var nonSSELines []string
	sawDataLine := false
	keepalives := 0
	respID := extractHeaderReqID(resp.Header)
	finishReason := ""
	sseErrMsg := ""
	lastEventHdr := ""

	type chatChunk struct {
		ID      string         `json:"id"`
		Object  string         `json:"object"`
		Error   *sseErrPayload `json:"error"`
		Message string         `json:"message"`
		Code    any            `json:"code"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Delta        struct {
				Content string `json:"content"`
				// what reasoning models say while thinking, under the names the common servers use
				ReasoningContent string `json:"reasoning_content"`
				Reasoning        string `json:"reasoning"`
				Thinking         string `json:"thinking"`
				ToolCalls        []struct {
					Index    int    `json:"index"`
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
			Message *struct {
				Content          string       `json:"content"`
				ReasoningContent string       `json:"reasoning_content"`
				Reasoning        string       `json:"reasoning"`
				Thinking         string       `json:"thinking"`
				ToolCalls        []aiToolCall `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage *struct {
			In            int `json:"prompt_tokens"`
			Out           int `json:"completion_tokens"`
			CacheHit      int `json:"prompt_cache_hit_tokens"` // DeepSeek
			CacheRead     int `json:"cache_read_input_tokens"`
			CacheCreation int `json:"cache_creation_input_tokens"`
			PromptDetails struct {
				Cached int `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			OutDetails struct {
				Reasoning int `json:"reasoning_tokens"`
			} `json:"completion_tokens_details"`
		} `json:"usage"`
	}

	processChatChunk := func(ch chatChunk, evHint string) {
		if ch.ID != "" {
			respID = ch.ID
		}
		if ch.Error != nil {
			sseErrMsg = formatSSEErrorObj(ch.Message, ch.Code, ch.Error)
			sseEvents = appendSSEEventName(sseEvents, firstNonEmptyStr(evHint, "error"))
		} else if evHint != "" {
			sseEvents = appendSSEEventName(sseEvents, evHint)
		} else if ch.Object != "" {
			sseEvents = appendSSEEventName(sseEvents, ch.Object+".delta")
		}
		if ch.Usage != nil {
			u := ch.Usage
			out.In, out.Out, out.Reasoning = u.In, u.Out, u.OutDetails.Reasoning
			out.Cached = max(u.PromptDetails.Cached, u.CacheHit, u.CacheRead, u.CacheCreation)
		}
		for _, c := range ch.Choices {
			if c.FinishReason != "" {
				finishReason = c.FinishReason
				sseEvents = appendSSEEventName(sseEvents, "finish:"+c.FinishReason)
			}
			content := c.Delta.Content
			reason := c.Delta.ReasoningContent + c.Delta.Reasoning + c.Delta.Thinking
			if c.Message != nil && content == "" && out.Text == "" {
				content = c.Message.Content
				if reason == "" {
					reason = c.Message.ReasoningContent + c.Message.Reasoning + c.Message.Thinking
				}
				for idx, mtc := range c.Message.ToolCalls {
					cp := mtc
					if cp.Type == "" {
						cp.Type = "function"
					}
					calls[idx] = &cp
				}
			}
			if out.FirstMS == 0 && (content != "" || reason != "" || len(c.Delta.ToolCalls) > 0 || len(calls) > 0) {
				out.FirstMS = max(1, time.Since(began).Milliseconds())
			}
			if reason != "" {
				out.Thinking += reason
				if onThink != nil {
					onThink(reason)
				}
			}
			if content != "" {
				// a model that writes its thinking inline as <think>…</think> gets it split off the answer
				text := tags.feed(content, func(t string) {
					out.Thinking += t
					if onThink != nil {
						onThink(t)
					}
				})
				if text != "" {
					out.Text += text
					if onText != nil {
						onText(text)
					}
				}
			}
			for _, tc := range c.Delta.ToolCalls {
				x := calls[tc.Index]
				if x == nil {
					x = &aiToolCall{Type: "function"}
					calls[tc.Index] = x
				}
				if tc.ID != "" {
					x.ID = tc.ID
				}
				x.Function.Name += tc.Function.Name
				x.Function.Arguments += tc.Function.Arguments
			}
		}
	}

	sawDone := false
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		touchStreamIdle(ctx)
		rawLine := sc.Text()
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, ":") {
			keepalives++
			rawCap.add(rawLine)
			notifyStreamBeat(ctx, "keepalive")
			continue
		}
		if strings.HasPrefix(line, "event:") {
			lastEventHdr = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			rawCap.add(rawLine)
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			rawCap.add(rawLine)
			if len(nonSSELines) < 64 {
				nonSSELines = append(nonSSELines, line)
			}
			continue
		}
		sawDataLine = true
		rawCap.add(rawLine)
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		evHint := lastEventHdr
		lastEventHdr = ""
		if data == "[DONE]" {
			sawDone = true
			sseEvents = appendSSEEventName(sseEvents, "[DONE]")
			break
		}
		var ch chatChunk
		if json.Unmarshal([]byte(data), &ch) != nil {
			continue
		}
		notifyStreamBeat(ctx, "chunk")
		processChatChunk(ch, evHint)
	}
	if !sawDataLine && len(nonSSELines) > 0 {
		var ch chatChunk
		if json.Unmarshal([]byte(strings.Join(nonSSELines, "\n")), &ch) == nil {
			sawDone = true
			processChatChunk(ch, "json_body")
		}
	}

	attemptMS := max(1, time.Since(attemptStart).Milliseconds())
	totalMS := max(1, time.Since(began).Milliseconds())

	if scanErr := normalizeStreamErr(ctx, sc.Err()); scanErr != nil && !sawDone && finishReason == "" {
		return out, s.aiTransportErrorDiag(p, "chat", endpoint, reqSummary, curNote, scanErr, attemptMS, attempts)
	}
	for i := 0; i < len(calls); i++ {
		if c := calls[i]; c != nil {
			if c.ID == "" {
				c.ID = fmt.Sprintf("call_%d", i)
			}
			out.ToolCalls = append(out.ToolCalls, *c)
		}
	}
	out.Rounds = 1

	buildDiag := func(reasonCode, reasonNote string, includeRaw bool) *aiCallDiag {
		att := aiAttemptDiag{
			Endpoint:       endpoint,
			API:            "chat",
			HTTPStatus:     resp.StatusCode,
			MS:             attemptMS,
			ResponseID:     respID,
			UpstreamStatus: finishReason,
			Reason:         reasonNote,
			InTokens:       out.In,
			OutTokens:      out.Out,
			CachedTokens:   out.Cached,
			SSEEvents:      sseEvents,
			Keepalives:     keepalives,
			RequestNote:    curNote,
		}
		allAtts := append(append([]aiAttemptDiag(nil), attempts...), att)
		d := &aiCallDiag{
			Provider:       p.Name,
			Model:          p.Model,
			API:            "chat",
			Endpoint:       endpoint,
			HTTPStatus:     resp.StatusCode,
			ReasonCode:     reasonCode,
			ResponseID:     respID,
			UpstreamStatus: finishReason,
			MS:             totalMS,
			InTokens:       out.In,
			OutTokens:      out.Out,
			CachedTokens:   out.Cached,
			SSEEvents:      sseEvents,
			Keepalives:     keepalives,
			Attempts:       allAtts,
		}
		if includeRaw {
			d.RequestSummary = reqSummary
			d.ResponseRaw = s.scrubDiagText(p, rawCap.text())
		}
		return d
	}

	if out.Text == "" && len(out.ToolCalls) == 0 {
		if sseErrMsg != "" {
			d := buildDiag("sse_error", "sse_error", true)
			out.Diag = d
			return out, &aiCallError{Msg: "供应商返回流式错误：" + sseErrMsg, Diag: d}
		}
		rc := "empty_output"
		msg := formatEmptyOutputErr(resp.StatusCode, endpoint, out.In, out.Out, out.Cached, respID)
		if finishReason == "length" || finishReason == "content_filter" {
			rc = "incomplete"
			msg = fmt.Sprintf("模型回答未正常输出（finish_reason=%s，输入 %d / 输出 %d Token）", finishReason, out.In, out.Out)
		}
		d := buildDiag(rc, rc, true)
		out.Diag = d
		return out, &aiCallError{Msg: msg, Diag: d}
	}

	out.Diag = buildDiag("", "ok", false)
	return out, nil
}

// ---- test a model ----

// redSquare is the picture the vision test shows: a solid red square, so the answer is unambiguous.
var redSquare = func() string {
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	draw.Draw(img, img.Bounds(), &image.Uniform{color.RGBA{R: 220, G: 30, B: 30, A: 255}}, image.Point{}, draw.Src)
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}()

// aiTestProvider finds out whether one model of a provider answers, calls tools and reads pictures.
func (s *storeServer) aiTestProvider(w http.ResponseWriter, id, model string) {
	aiMu.Lock()
	st := s.aiLoad()
	aiMu.Unlock()
	var base aiProvider
	found := false
	for _, p := range st.Providers {
		if p.ID == id {
			base, found = p, true
		}
	}
	if !found {
		s.fail(w, 404, "供应商不存在")
		return
	}
	m, ok := base.model(model)
	if !ok {
		s.fail(w, 404, "这个供应商里没有这个模型")
		return
	}
	p := base.withModel(m)
	start := time.Now()
	ctx := context.Background()
	m.TestErr, m.TestWarn, m.TestDiag, m.Tools, m.Vision = "", "", nil, "", ""
	probeMsgs := []aiMessage{
		{Role: "system", Content: "你是连通性检测探针，只需简短回复 ok。"},
		{Role: "user", Content: "回复 ok"},
	}
	rep, err := s.aiChat(withForceProbeResponses(ctx), p, probeMsgs, nil, nil)
	m.TestMS = time.Since(start).Milliseconds()
	m.Tested = time.Now().UTC().Format(time.RFC3339)
	m.TestOK = err == nil
	if err != nil {
		m.TestErr = err.Error()
		m.TestDiag = aiDiagFromErr(err)
	} else {
		probeP := p
		if rep.Diag != nil && rep.Diag.FallbackUsed != "" {
			m.TestWarn = "Responses 接口异常或返回空内容，已自动回退至 Chat Completions；建议将该供应商接口方式改为 Chat Completions"
			m.TestDiag = rep.Diag
			probeP.API = "chat"
		} else {
			if p.API == "responses" {
				s.clearChatFallback(p)
			}
			m.TestDiag = nil
		}
		// does it call tools?
		def := aiToolDef{Name: "get_time", Description: "返回当前时间", Parameters: map[string]any{"type": "object", "properties": map[string]any{}}}
		r, e := s.aiChat(ctx, probeP, []aiMessage{{Role: "user", Content: "请调用 get_time 工具"}}, []aiToolDef{def}, nil)
		m.Tools = "no"
		if e == nil && len(r.ToolCalls) > 0 {
			m.Tools = "yes"
		}
		// does it read pictures? it is shown a red square and has to say so
		r, e = s.aiChat(ctx, probeP, []aiMessage{{Role: "user", Content: []map[string]any{{"type": "text", "text": "这张图是什么颜色？只回答一个词。"}, {"type": "image_url", "image_url": map[string]string{"url": redSquare}}}}}, nil, nil)
		m.Vision = "no"
		if e == nil && regexp.MustCompile(`(?i)红|red|crimson|scarlet`).MatchString(r.Text) {
			m.Vision = "yes"
		}
	}
	aiMu.Lock()
	st = s.aiLoad()
	for i := range st.Providers {
		if st.Providers[i].ID != id {
			continue
		}
		for k := range st.Providers[i].Models {
			if st.Providers[i].Models[k].ID == model {
				st.Providers[i].Models[k] = m
			}
		}
	}
	_ = s.aiSave(st)
	aiMu.Unlock()
	s.writeJSON(w, 200, m)
}

// ---- model list ----

// aiListModels asks a provider's /models. It takes either a saved provider id or an address and key typed on the form.
func (s *storeServer) aiListModels(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID, URL, Key, Preset, APIVersion string
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<13)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	p := aiProvider{URL: strings.TrimRight(strings.TrimSpace(in.URL), "/"), Preset: in.Preset, APIVersion: in.APIVersion}
	if in.ID != "" {
		for _, x := range s.aiLoad().Providers {
			if x.ID == in.ID {
				p = x
				if in.URL != "" {
					p.URL = strings.TrimRight(strings.TrimSpace(in.URL), "/")
				}
			}
		}
	}
	if k := strings.TrimSpace(in.Key); k != "" {
		enc, err := s.aiEncrypt(k)
		if err != nil {
			s.fail(w, 500, "密钥无法处理")
			return
		}
		p.KeyEnc = enc
	}
	if err := validProviderURL(p.URL); err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	resp, err := s.aiRequest(ctx, p, "GET", "/models", nil)
	if err != nil {
		s.fail(w, 502, "连接失败："+err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		s.fail(w, 502, aiHTTPError(resp).Error())
		return
	}
	var out struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
			Context     int    `json:"context_length"`
			Modalities  struct {
				Input []string `json:"input"`
			} `json:"modalities"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out) != nil {
		s.fail(w, 502, "供应商没有给出模型列表，请手填模型名")
		return
	}
	models := []aiModel{}
	for _, m := range out.Data {
		x := aiModel{ID: m.ID, Context: m.Context}
		if m.DisplayName != "" && m.DisplayName != m.ID {
			x.Name = m.DisplayName
		}
		for _, mod := range m.Modalities.Input {
			if mod == "image" {
				x.Declared = "yes"
			}
		}
		models = append(models, x)
	}
	s.writeJSON(w, 200, map[string]any{"models": models})
}

// cleanSchema makes a tool's parameter schema acceptable to strict servers: an empty "required" list is left out
// (some reject null or an empty array there) and "properties" is always an object.
func cleanSchema(in map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		out[k] = v
	}
	if r, ok := out["required"]; ok {
		switch x := r.(type) {
		case nil:
			delete(out, "required")
		case []string:
			if len(x) == 0 {
				delete(out, "required")
			}
		case []any:
			if len(x) == 0 {
				delete(out, "required")
			}
		}
	}
	if _, ok := out["properties"]; !ok {
		out["properties"] = map[string]any{}
	}
	return out
}

type thinkKey struct{}

// withThinking asks aiChat to hand over a reasoning model's thinking as it streams.
func withThinking(ctx context.Context, f func(string)) context.Context {
	return context.WithValue(ctx, thinkKey{}, f)
}

type connectKey struct{}

// withConnect notifies callers as soon as the model gateway accepts the HTTP stream (2xx headers received).
func withConnect(ctx context.Context, f func(int64)) context.Context {
	return context.WithValue(ctx, connectKey{}, f)
}

// thinkTags splits "<think>…</think>" written into the answer stream, even when a tag is cut across chunks.
type thinkTags struct {
	in      bool
	started bool
	buf     string
}

func (t *thinkTags) feed(chunk string, think func(string)) string {
	t.buf += chunk
	var out strings.Builder
	for t.buf != "" {
		if !t.in {
			// only a reply that begins with <think> is treated this way
			if !t.started {
				trimmed := strings.TrimLeft(t.buf, " \n")
				if strings.HasPrefix(trimmed, "<think>") {
					t.in, t.started = true, true
					t.buf = strings.TrimPrefix(trimmed, "<think>")
					continue
				}
				if len(trimmed) < len("<think>") && strings.HasPrefix("<think>", trimmed) {
					return out.String() // wait for more
				}
				t.started = true
			}
			out.WriteString(t.buf)
			t.buf = ""
			break
		}
		i := strings.Index(t.buf, "</think>")
		if i < 0 {
			// keep a possible partial closing tag
			keep := 0
			for k := 1; k < len("</think>") && k <= len(t.buf); k++ {
				if strings.HasSuffix(t.buf, "</think>"[:k]) {
					keep = k
				}
			}
			think(t.buf[:len(t.buf)-keep])
			t.buf = t.buf[len(t.buf)-keep:]
			break
		}
		think(t.buf[:i])
		t.buf = strings.TrimLeft(t.buf[i+len("</think>"):], " \n")
		t.in = false
	}
	return out.String()
}

type effortKey struct{}

// withEffort asks a reasoning model to think harder ("high") or keeps its default ("").
func withEffort(ctx context.Context, effort string) context.Context {
	return context.WithValue(ctx, effortKey{}, effort)
}

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// The Responses API (what Codex and current OpenAI models speak). Unlike Chat Completions it can return a summary of
// the model's reasoning, which is shown as the thinking of the answer. A conversation is rebuilt from our messages on
// every call (nothing is stored on the other side), and tool calls are the same function calls as everywhere else.

var reOpenAIOSeries = regexp.MustCompile(`(?i)(^|[/:_-])(o1|o3|o4)($|[-_0-9.])`)

func isNativeOpenAIReasoningModel(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return false
	}
	for _, non := range []string{
		"claude", "anthropic", "gemini", "deepseek", "qwen", "glm",
		"kimi", "moonshot", "minimax", "hunyuan", "doubao", "ernie", "yi", "step",
	} {
		if strings.Contains(m, non) {
			return false
		}
	}
	for _, oa := range []string{"gpt-5", "gpt5", "gpt-6", "gpt6", "gpt-7", "gpt7", "codex", "computer-use"} {
		if strings.Contains(m, oa) {
			return true
		}
	}
	return reOpenAIOSeries.MatchString(m)
}

// responsesReasoningSpec gates OpenAI-only reasoning fields so third-party gateways (Magpie, OneAPI, etc.) routing to
// Claude/Gemini/DeepSeek/Qwen do not silently return HTTP 200 with output:[].
func responsesReasoningSpec(model, effort string) (reasoning map[string]any, include []string) {
	effort = strings.TrimSpace(effort)
	if isNativeOpenAIReasoningModel(model) {
		r := map[string]any{"summary": "detailed"}
		if effort != "" {
			r["effort"] = effort
		}
		return r, []string{"reasoning.encrypted_content"}
	}
	if effort != "" {
		return map[string]any{"effort": effort}, nil
	}
	return nil, nil
}

func responsesInput(msgs []aiMessage) (instructions string, input []map[string]any) {
	var sys []string
	for _, m := range msgs {
		switch m.Role {
		case "system":
			if s, ok := m.Content.(string); ok {
				sys = append(sys, s)
			}
		case "user":
			var parts []map[string]any
			switch c := m.Content.(type) {
			case string:
				parts = []map[string]any{{"type": "input_text", "text": c}}
			case []map[string]any:
				for _, x := range c {
					switch x["type"] {
					case "text":
						parts = append(parts, map[string]any{"type": "input_text", "text": x["text"]})
					case "image_url":
						url := ""
						switch v := x["image_url"].(type) {
						case map[string]string:
							url = v["url"]
						case map[string]any:
							url, _ = v["url"].(string)
						}
						parts = append(parts, map[string]any{"type": "input_image", "image_url": url})
					}
				}
			}
			input = append(input, map[string]any{"role": "user", "content": parts})
		case "assistant":
			if s, ok := m.Content.(string); ok && strings.TrimSpace(s) != "" {
				input = append(input, map[string]any{"role": "assistant", "content": []map[string]any{{"type": "output_text", "text": s}}})
			}
			for _, tc := range m.ToolCalls {
				input = append(input, map[string]any{"type": "function_call", "call_id": tc.ID, "name": tc.Function.Name, "arguments": tc.Function.Arguments})
			}
		case "tool":
			out, _ := m.Content.(string)
			input = append(input, map[string]any{"type": "function_call_output", "call_id": m.ToolCallID, "output": out})
		}
	}
	return strings.Join(sys, "\n\n"), input
}

type respContentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type respOutputItem struct {
	Type      string            `json:"type"`
	ID        string            `json:"id"`
	CallID    string            `json:"call_id"`
	Name      string            `json:"name"`
	Arguments string            `json:"arguments"`
	Content   []respContentPart `json:"content"`
	Summary   []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"summary"`
}

type respUsagePayload struct {
	In                       int `json:"input_tokens"`
	Out                      int `json:"output_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	Details                  struct {
		Cached int `json:"cached_tokens"`
	} `json:"input_tokens_details"`
	OutDetails struct {
		Reasoning int `json:"reasoning_tokens"`
	} `json:"output_tokens_details"`
}

func (s *storeServer) aiResponsesAttempt(
	ctx context.Context,
	p aiProvider,
	msgs []aiMessage,
	instr string,
	input []map[string]any,
	tools []aiToolDef,
	onText func(string),
	reasoningCfg map[string]any,
	includeCfg []string,
	reqNote string,
	priorAttempts []aiAttemptDiag,
) (out aiReply, status int, failureCode string, err error) {
	body := map[string]any{"model": p.Model, "input": input, "stream": true, "store": false}
	if instr != "" {
		body["instructions"] = instr
	}
	if len(reasoningCfg) > 0 {
		body["reasoning"] = reasoningCfg
	}
	if len(includeCfg) > 0 {
		body["include"] = includeCfg
	}
	if p.MaxTokens > 0 {
		body["max_output_tokens"] = p.MaxTokens
	}
	if len(tools) > 0 {
		var ts []map[string]any
		for _, t := range tools {
			ts = append(ts, map[string]any{"type": "function", "name": t.Name, "description": t.Description, "parameters": cleanSchema(t.Parameters)})
		}
		body["tools"] = ts
	}

	endpoint := sanitizeDiagEndpoint("POST", providerTargetURL(p, "/responses"))
	reqSummary := s.buildDiagRequestSummary(p, "responses", body, msgs)
	began := time.Now()
	resp, reqErr := s.aiRequest(ctx, p, "POST", "/responses", body)
	if reqErr != nil {
		tErr := s.aiTransportErrorDiag(p, "responses", endpoint, reqSummary, reqNote, normalizeStreamErr(ctx, reqErr), time.Since(began).Milliseconds(), priorAttempts)
		out.Diag = aiDiagFromErr(tErr)
		return out, 0, out.Diag.ReasonCode, tErr
	}
	defer resp.Body.Close()
	status = resp.StatusCode
	if resp.StatusCode/100 != 2 {
		hErr := s.aiHTTPErrorDiag(p, "responses", endpoint, reqSummary, reqNote, resp, time.Since(began).Milliseconds(), priorAttempts)
		out.Diag = hErr.Diag
		return out, status, "http_error", hErr
	}
	touchStreamIdle(ctx)
	if onConn, _ := ctx.Value(connectKey{}).(func(int64)); onConn != nil {
		onConn(max(1, time.Since(began).Milliseconds()))
	}

	onThink, _ := ctx.Value(thinkKey{}).(func(string))
	tags := &thinkTags{}
	think := func(t string) {
		if t == "" {
			return
		}
		if out.FirstMS == 0 {
			out.FirstMS = max(1, time.Since(began).Milliseconds())
		}
		out.Thinking += t
		if onThink != nil {
			onThink(t)
		}
	}
	type call struct {
		id, name, args string
	}
	calls := map[string]*call{} // by item id
	var order []string
	upsertCall := func(itemKey, callID, name, args string, overrideArgs bool) {
		if itemKey == "" {
			itemKey = firstNonEmptyStr(callID, fmt.Sprintf("fc_%d", len(order)))
		}
		c := calls[itemKey]
		if c == nil {
			c = &call{}
			calls[itemKey] = c
			order = append(order, itemKey)
		}
		if callID != "" {
			c.id = callID
		}
		if name != "" {
			c.name = name
		}
		if overrideArgs && args != "" {
			c.args = args
		}
	}

	streamedThink := map[string]bool{}
	hadTextDelta := false
	var rawCap sseRawCapture
	var sseEvents []string
	var nonSSELines []string
	sawDataLine := false
	keepalives := 0
	lastEventHdr := ""
	respID := extractHeaderReqID(resp.Header)
	upstreamStatus := ""
	var failure string

	applyUsage := func(u *respUsagePayload) {
		if u == nil {
			return
		}
		out.In = u.In
		out.Out = u.Out
		out.Reasoning = u.OutDetails.Reasoning
		out.Cached = max(u.Details.Cached, u.CacheReadInputTokens, u.CacheCreationInputTokens)
	}

	extractItemsFallback := func(items []respOutputItem) {
		if len(items) == 0 {
			return
		}
		needText := !hadTextDelta && out.Text == ""
		needThink := strings.TrimSpace(out.Thinking) == ""
		for _, it := range items {
			switch it.Type {
			case "message", "":
				if needText && len(it.Content) > 0 {
					for _, pt := range it.Content {
						if (pt.Type == "output_text" || pt.Type == "text" || pt.Type == "") && pt.Text != "" {
							if out.FirstMS == 0 {
								out.FirstMS = max(1, time.Since(began).Milliseconds())
							}
							out.Text += pt.Text
							if onText != nil {
								onText(pt.Text)
							}
						}
					}
				}
			case "function_call":
				upsertCall(it.ID, firstNonEmptyStr(it.CallID, it.ID), it.Name, it.Arguments, true)
				if out.FirstMS == 0 {
					out.FirstMS = max(1, time.Since(began).Milliseconds())
				}
			case "reasoning":
				if needThink && (it.ID == "" || !streamedThink[it.ID]) {
					var parts []string
					for _, s := range it.Summary {
						if t := strings.TrimSpace(s.Text); t != "" {
							parts = append(parts, t)
						}
					}
					if len(parts) == 0 {
						for _, pt := range it.Content {
							if t := strings.TrimSpace(pt.Text); t != "" {
								parts = append(parts, t)
							}
						}
					}
					if len(parts) > 0 {
						if it.ID != "" {
							streamedThink[it.ID] = true
						}
						think(strings.Join(parts, "\n\n"))
					}
				}
			}
		}
	}

	type respEvent struct {
		Type    string           `json:"type"`
		ID      string           `json:"id"`
		Object  string           `json:"object"`
		Status  string           `json:"status"`
		Delta   string           `json:"delta"`
		ItemID  string           `json:"item_id"`
		Args    string           `json:"arguments"`
		Code    any              `json:"code"`
		Message string           `json:"message"`
		Error   *sseErrPayload   `json:"error"`
		Item    respOutputItem   `json:"item"`
		Output  []respOutputItem `json:"output"`
		Usage   *respUsagePayload `json:"usage"`
		Response struct {
			ID         string           `json:"id"`
			Status     string           `json:"status"`
			Error      *sseErrPayload   `json:"error"`
			Incomplete *struct {
				Reason string `json:"reason"`
			} `json:"incomplete_details"`
			Output []respOutputItem  `json:"output"`
			Usage  *respUsagePayload `json:"usage"`
		} `json:"response"`
	}

	sawCompleted := false
	processEvent := func(ev respEvent, evHint string) {
		evType := firstNonEmptyStr(ev.Type, evHint)
		if evType == "" && ev.Object == "response" {
			evType = "response.completed"
		}
		if evType != "" {
			sseEvents = appendSSEEventName(sseEvents, evType)
			notifyStreamBeat(ctx, evType)
		}
		if ev.Response.ID != "" {
			respID = ev.Response.ID
		} else if ev.ID != "" && (strings.HasPrefix(evType, "response.") || ev.Object == "response") {
			respID = ev.ID
		}
		if ev.Response.Status != "" {
			upstreamStatus = ev.Response.Status
		} else if ev.Status != "" && (strings.HasPrefix(evType, "response.") || ev.Object == "response") {
			upstreamStatus = ev.Status
		}
		if ev.Response.Usage != nil {
			applyUsage(ev.Response.Usage)
		} else if ev.Usage != nil {
			applyUsage(ev.Usage)
		}

		// Top-level error object can appear either with type=="error" or without type on proxy gateways.
		if evType == "error" || (ev.Error != nil && evType != "response.failed") {
			failure = formatSSEErrorObj(ev.Message, ev.Code, ev.Error)
			failureCode = "sse_error"
			return
		}

		switch evType {
		case "response.output_text.delta":
			if ev.Delta != "" {
				hadTextDelta = true
				if out.FirstMS == 0 {
					out.FirstMS = max(1, time.Since(began).Milliseconds())
				}
				text := tags.feed(ev.Delta, func(t string) {
					think(t)
				})
				if text != "" {
					out.Text += text
					if onText != nil {
						onText(text)
					}
				}
			}
		case "response.reasoning_summary_text.delta",
			"response.reasoning_text.delta",
			"response.reasoning.delta",
			"response.thinking.delta",
			"thinking_delta":
			if ev.ItemID != "" {
				streamedThink[ev.ItemID] = true
			}
			think(ev.Delta)
		case "response.reasoning_summary_part.added":
			if streamedThink[ev.ItemID] {
				think("\n\n")
			}
		case "response.output_item.added":
			if ev.Item.Type == "function_call" {
				upsertCall(ev.Item.ID, firstNonEmptyStr(ev.Item.CallID, ev.Item.ID), ev.Item.Name, ev.Item.Arguments, false)
			}
		case "response.function_call_arguments.delta":
			if c := calls[ev.ItemID]; c != nil {
				c.args += ev.Delta
			}
		case "response.function_call_arguments.done":
			if c := calls[ev.ItemID]; c != nil {
				c.args = ev.Args
			}
		case "response.output_item.done":
			switch ev.Item.Type {
			case "reasoning":
				if !streamedThink[ev.Item.ID] {
					var parts []string
					for _, x := range ev.Item.Summary {
						if t := strings.TrimSpace(x.Text); t != "" {
							parts = append(parts, t)
						}
					}
					if len(parts) == 0 {
						for _, pt := range ev.Item.Content {
							if t := strings.TrimSpace(pt.Text); t != "" {
								parts = append(parts, t)
							}
						}
					}
					if len(parts) > 0 {
						streamedThink[ev.Item.ID] = true
						think(strings.Join(parts, "\n\n"))
					}
				}
				think("\n\n")
			case "function_call":
				upsertCall(ev.Item.ID, firstNonEmptyStr(ev.Item.CallID, ev.Item.ID), ev.Item.Name, ev.Item.Arguments, true)
				if out.FirstMS == 0 {
					out.FirstMS = max(1, time.Since(began).Milliseconds())
				}
			case "message":
				if !hadTextDelta && len(ev.Item.Content) > 0 {
					for _, pt := range ev.Item.Content {
						if (pt.Type == "output_text" || pt.Type == "text" || pt.Type == "") && pt.Text != "" {
							if out.FirstMS == 0 {
								out.FirstMS = max(1, time.Since(began).Milliseconds())
							}
							out.Text += pt.Text
							if onText != nil {
								onText(pt.Text)
							}
						}
					}
				}
			}
		case "response.completed", "response.incomplete":
			if evType == "response.completed" {
				sawCompleted = true
			}
			items := ev.Response.Output
			if len(items) == 0 {
				items = ev.Output
			}
			extractItemsFallback(items)
			if evType == "response.incomplete" {
				reason := "incomplete"
				if ev.Response.Incomplete != nil && ev.Response.Incomplete.Reason != "" {
					reason = ev.Response.Incomplete.Reason
				}
				failure = "回答被截断了：" + reason
				failureCode = "incomplete"
			}
		case "response.failed":
			failure = "模型没有完成回答"
			if ev.Response.Error != nil {
				failure = formatSSEErrorObj("", nil, ev.Response.Error)
			}
			failureCode = "sse_error"
		}
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 8<<20)
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
			if len(nonSSELines) < 128 {
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
			sawCompleted = true
			sseEvents = appendSSEEventName(sseEvents, "[DONE]")
			break
		}
		var ev respEvent
		if json.Unmarshal([]byte(data), &ev) != nil {
			continue
		}
		processEvent(ev, evHint)
	}
	if !sawDataLine && len(nonSSELines) > 0 {
		var ev respEvent
		if json.Unmarshal([]byte(strings.Join(nonSSELines, "\n")), &ev) == nil {
			sawCompleted = true
			processEvent(ev, "")
		}
	}

	out.Thinking = strings.TrimSpace(out.Thinking)
	attemptMS := max(1, time.Since(began).Milliseconds())

	if scanErr := normalizeStreamErr(ctx, sc.Err()); scanErr != nil && !sawCompleted {
		tErr := s.aiTransportErrorDiag(p, "responses", endpoint, reqSummary, reqNote, scanErr, attemptMS, priorAttempts)
		out.Diag = aiDiagFromErr(tErr)
		return out, status, out.Diag.ReasonCode, tErr
	}

	for i, id := range order {
		c := calls[id]
		if c == nil || c.name == "" {
			continue
		}
		tc := aiToolCall{ID: c.id, Type: "function"}
		if tc.ID == "" {
			tc.ID = fmt.Sprintf("call_%d", i)
		}
		tc.Function.Name, tc.Function.Arguments = c.name, c.args
		out.ToolCalls = append(out.ToolCalls, tc)
	}
	out.Rounds = 1

	buildDiag := func(rc, reasonNote string, includeRaw bool) *aiCallDiag {
		att := aiAttemptDiag{
			Endpoint:       endpoint,
			API:            "responses",
			HTTPStatus:     status,
			MS:             attemptMS,
			ResponseID:     respID,
			UpstreamStatus: upstreamStatus,
			Reason:         reasonNote,
			InTokens:       out.In,
			OutTokens:      out.Out,
			CachedTokens:   out.Cached,
			SSEEvents:      sseEvents,
			Keepalives:     keepalives,
			RequestNote:    reqNote,
		}
		allAtts := append(append([]aiAttemptDiag(nil), priorAttempts...), att)
		d := &aiCallDiag{
			Provider:       p.Name,
			Model:          p.Model,
			API:            "responses",
			Endpoint:       endpoint,
			HTTPStatus:     status,
			ReasonCode:     rc,
			ResponseID:     respID,
			UpstreamStatus: upstreamStatus,
			MS:             attemptMS,
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

	if failure != "" && ((out.Text == "" && len(out.ToolCalls) == 0) || failureCode == "incomplete") {
		rc := firstNonEmptyStr(failureCode, "sse_error")
		d := buildDiag(rc, rc, true)
		out.Diag = d
		return out, status, rc, &aiCallError{Msg: failure, Diag: d}
	}
	if out.Text == "" && len(out.ToolCalls) == 0 {
		d := buildDiag("empty_output", "empty_output", true)
		out.Diag = d
		msg := formatEmptyOutputErr(status, endpoint, out.In, out.Out, out.Cached, respID)
		return out, status, "empty_output", &aiCallError{Msg: msg, Diag: d}
	}

	out.Diag = buildDiag("", "ok", false)
	return out, status, "", nil
}

func combineFallbackReqSummary(respSum, chatSum string) string {
	respSum, chatSum = strings.TrimSpace(respSum), strings.TrimSpace(chatSum)
	if respSum != "" && chatSum != "" && json.Valid([]byte(respSum)) && json.Valid([]byte(chatSum)) {
		type combined struct {
			Responses       json.RawMessage `json:"attempt_responses"`
			ChatCompletions json.RawMessage `json:"attempt_chat_completions"`
		}
		if b, err := json.MarshalIndent(combined{
			Responses:       json.RawMessage(respSum),
			ChatCompletions: json.RawMessage(chatSum),
		}, "", "  "); err == nil {
			return string(b)
		}
	}
	return firstNonEmptyStr(chatSum, respSum)
}

func combineFallbackRaw(respEndpoint, respRaw, chatEndpoint, chatRaw string) string {
	respRaw, chatRaw = strings.TrimSpace(respRaw), strings.TrimSpace(chatRaw)
	switch {
	case respRaw != "" && chatRaw != "":
		return fmt.Sprintf("=== #1 %s ===\n%s\n\n=== #2 %s ===\n%s", respEndpoint, respRaw, chatEndpoint, chatRaw)
	case chatRaw != "":
		return chatRaw
	default:
		return respRaw
	}
}

func (s *storeServer) aiResponses(ctx context.Context, p aiProvider, msgs []aiMessage, tools []aiToolDef, onText func(string), effort string) (aiReply, error) {
	overallStart := time.Now()
	instr, input := responsesInput(msgs)
	reasoningCfg, includeCfg := responsesReasoningSpec(p.Model, effort)
	hasReasoning := len(reasoningCfg) > 0 || len(includeCfg) > 0

	note1 := "responses"
	if hasReasoning {
		note1 = "responses (with reasoning)"
	}
	out, status, fcode, err := s.aiResponsesAttempt(ctx, p, msgs, instr, input, tools, onText, reasoningCfg, includeCfg, note1, nil)
	if err == nil {
		return out, nil
	}

	// Step 1 self-heal: if reasoning/include was sent and gateway returned 400/422 OR (on native OpenAI models) 2xx empty/sse_error output, retry pure /responses.
	// Non-OpenAI models (e.g. Claude/Gemini behind Magpie) that return 200 empty_output on /responses skip straight to /chat/completions to avoid burning a second slow round-trip.
	if hasReasoning && ctx.Err() == nil && (status == 400 || status == 422 ||
		(isNativeOpenAIReasoningModel(p.Model) && status/100 == 2 && out.Text == "" && len(out.ToolCalls) == 0 && (fcode == "empty_output" || fcode == "sse_error"))) {
		var prior []aiAttemptDiag
		if out.Diag != nil {
			prior = out.Diag.Attempts
		}
		out, status, fcode, err = s.aiResponsesAttempt(ctx, p, msgs, instr, input, tools, onText, nil, nil, "responses (retry without reasoning)", prior)
		if err == nil {
			if out.Diag != nil {
				out.Diag.MS = max(1, time.Since(overallStart).Milliseconds())
			}
			return out, nil
		}
	}

	// Step 2 self-heal: if pure /responses still fails with incompatible/upstream 4xx/5xx (excluding 401/402/403/429)
	// OR 2xx empty_output/sse_error with 0 output, auto-fallback to /chat/completions.
	shouldFallbackChat := ctx.Err() == nil && (status == 400 || status == 404 || status == 405 || status == 422 ||
		status == 500 || status == 501 || status == 502 || status == 503 ||
		(status/100 == 2 && out.Text == "" && len(out.ToolCalls) == 0 && (fcode == "empty_output" || fcode == "sse_error")))
	if !shouldFallbackChat {
		if out.Diag != nil {
			out.Diag.MS = max(1, time.Since(overallStart).Milliseconds())
		}
		return out, err
	}

	respErrMsg := err.Error()
	respDiag := out.Diag
	var respAttempts []aiAttemptDiag
	if respDiag != nil {
		respAttempts = append(respAttempts, respDiag.Attempts...)
	}

	chatOut, chatErr := s.aiChatCompletions(ctx, p, msgs, tools, onText, effort)
	totalMS := max(1, time.Since(overallStart).Milliseconds())

	if chatErr == nil {
		if fcode == "empty_output" || status == 404 || status == 405 || status == 501 || !isNativeOpenAIReasoningModel(p.Model) {
			s.rememberChatFallback(p)
		}
		if chatOut.Diag == nil {
			chatOut.Diag = &aiCallDiag{Provider: p.Name, Model: p.Model, API: "chat"}
		}
		chatOut.Diag.FallbackUsed = "responses -> chat/completions"
		chatOut.Diag.MS = totalMS
		chatOut.Diag.Attempts = append(respAttempts, chatOut.Diag.Attempts...)
		if respDiag != nil {
			if chatOut.Diag.RequestSummary == "" {
				chatOut.Diag.RequestSummary = respDiag.RequestSummary
			}
			if chatOut.Diag.ResponseRaw == "" {
				chatOut.Diag.ResponseRaw = respDiag.ResponseRaw
			}
		}
		return chatOut, nil
	}

	// Both /responses and fallback /chat/completions failed: merge full white-box attempts and raw diagnostics.
	chatDiag := aiDiagFromErr(chatErr)
	merged := &aiCallDiag{
		Provider:     p.Name,
		Model:        p.Model,
		API:          "responses",
		FallbackUsed: "responses -> chat/completions",
		MS:           totalMS,
		Attempts:     append([]aiAttemptDiag(nil), respAttempts...),
	}
	if chatDiag != nil {
		merged.Attempts = append(merged.Attempts, chatDiag.Attempts...)
		merged.Endpoint = chatDiag.Endpoint
		merged.HTTPStatus = chatDiag.HTTPStatus
		merged.ReasonCode = chatDiag.ReasonCode
		merged.ResponseID = firstNonEmptyStr(chatDiag.ResponseID, func() string {
			if respDiag != nil {
				return respDiag.ResponseID
			}
			return ""
		}())
		merged.UpstreamStatus = firstNonEmptyStr(chatDiag.UpstreamStatus, func() string {
			if respDiag != nil {
				return respDiag.UpstreamStatus
			}
			return ""
		}())
		merged.InTokens = chatDiag.InTokens
		merged.OutTokens = chatDiag.OutTokens
		merged.CachedTokens = chatDiag.CachedTokens
		merged.SSEEvents = chatDiag.SSEEvents
		merged.Keepalives = chatDiag.Keepalives
	}
	if respDiag != nil {
		if merged.Endpoint == "" {
			merged.Endpoint = respDiag.Endpoint
		}
		if merged.HTTPStatus == 0 {
			merged.HTTPStatus = respDiag.HTTPStatus
		}
		if merged.ReasonCode == "" {
			merged.ReasonCode = respDiag.ReasonCode
		}
		if merged.InTokens == 0 {
			merged.InTokens = respDiag.InTokens
		}
		if merged.OutTokens == 0 {
			merged.OutTokens = respDiag.OutTokens
		}
		if merged.CachedTokens == 0 {
			merged.CachedTokens = respDiag.CachedTokens
		}
		if len(merged.SSEEvents) == 0 {
			merged.SSEEvents = respDiag.SSEEvents
		}
		merged.Keepalives += respDiag.Keepalives
		var chatSum, chatRaw, chatEP string
		if chatDiag != nil {
			chatSum, chatRaw, chatEP = chatDiag.RequestSummary, chatDiag.ResponseRaw, chatDiag.Endpoint
		}
		merged.RequestSummary = s.scrubDiagText(p, combineFallbackReqSummary(respDiag.RequestSummary, chatSum))
		merged.ResponseRaw = s.scrubDiagText(p, combineFallbackRaw(respDiag.Endpoint, respDiag.ResponseRaw, chatEP, chatRaw))
	} else if chatDiag != nil {
		merged.RequestSummary = chatDiag.RequestSummary
		merged.ResponseRaw = chatDiag.ResponseRaw
	}

	mergedMsg := chatErr.Error()
	if respDiag != nil && respDiag.ReasonCode == "empty_output" {
		if chatDiag != nil && chatDiag.ReasonCode == "empty_output" {
			merged.ReasonCode = "empty_output"
			mergedMsg = formatEmptyOutputErr(respDiag.HTTPStatus, respDiag.Endpoint, merged.InTokens, merged.OutTokens, merged.CachedTokens, merged.ResponseID) + "（自动回退 Chat Completions 亦未返回内容）"
		} else if respDiag.InTokens > 0 {
			mergedMsg = fmt.Sprintf("Responses 接口返回空内容（输入 %d / 输出 %d Token），自动回退 Chat Completions 后失败：%s", respDiag.InTokens, respDiag.OutTokens, chatErr.Error())
		} else {
			mergedMsg = fmt.Sprintf("Responses 接口未返回内容，自动回退 Chat Completions 后失败：%s", chatErr.Error())
		}
	} else if respDiag != nil && respDiag.ReasonCode == "sse_error" {
		if chatDiag != nil && (chatDiag.HTTPStatus == 404 || chatDiag.HTTPStatus == 405 || chatDiag.HTTPStatus == 501) {
			merged.ReasonCode = "sse_error"
		}
		mergedMsg = fmt.Sprintf("Responses 接口报错（%s），自动回退 Chat Completions 后失败：%s", respErrMsg, chatErr.Error())
	}
	chatOut.Diag = merged
	return chatOut, &aiCallError{Msg: mergedMsg, Diag: merged, Err: chatErr}
}

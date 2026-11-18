package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// The audit record of a request, in the usual shape: who (account, address, browser), when, which resource, what
// action, what was asked (with secrets masked), and how it ended. Every request that changes something is recorded,
// and so are reads that take data away (downloads and exports). Handlers name the action with auditReq; the record
// itself is written once, when the request is over.

type auditResource struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
}

type auditRec struct {
	mu          sync.Mutex
	start       time.Time
	user        string
	sessionID   string
	durationSec int64
	action      string
	target      string
	resource    *auditResource
	body        *bytes.Buffer
	done        bool
}

type auditKey struct{}

// auditSensitiveGET are the reads that are recorded: what leaves the platform, and who looked at the audit itself.
var auditSensitiveGET = regexp.MustCompile(`^/api/(jobs/[^/]+/(archive|files/.+)|library/(export|index/export)|components/[^/]+/pack|audit(/sessions)?(/export)?|users/[^/]+/activity)$`)

func auditWanted(r *http.Request) bool {
	if r.URL.Path == "/api/session/heartbeat" {
		return false
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		return true
	}
	return auditSensitiveGET.MatchString(r.URL.Path)
}

// statusWriter remembers the status, and the start of an error answer so its message can be kept.
type statusWriter struct {
	http.ResponseWriter
	status int
	errBuf bytes.Buffer
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	if w.status >= 400 && w.errBuf.Len() < 2048 {
		w.errBuf.Write(b[:min(len(b), 2048-w.errBuf.Len())])
	}
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// capBuffer keeps the first bytes of what goes through it.
type capBuffer struct {
	buf *bytes.Buffer
	max int
}

func (c capBuffer) Write(p []byte) (int, error) {
	if room := c.max - c.buf.Len(); room > 0 {
		c.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// auditStart prepares the record of a request; the returned function writes it when the request is over.
func (s *storeServer) auditStart(w http.ResponseWriter, r *http.Request, user string) (http.ResponseWriter, *http.Request, func()) {
	if !auditWanted(r) {
		return w, r, func() {}
	}
	sess, _ := sessionFromContext(r)
	rec := &auditRec{start: time.Now(), user: user, sessionID: sess.ID}
	if r.Body != nil && !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
		rec.body = &bytes.Buffer{}
		r.Body = struct {
			io.Reader
			io.Closer
		}{io.TeeReader(r.Body, capBuffer{rec.body, 64 << 10}), r.Body}
	}
	sw := &statusWriter{ResponseWriter: w}
	r = r.WithContext(context.WithValue(r.Context(), auditKey{}, rec))
	return sw, r, func() {
		rec.mu.Lock()
		rec.done = true
		rec.mu.Unlock()
		s.writeAudit(s.auditOf(r, rec, sw.status, sw.errBuf.Bytes()))
	}
}

func auditSetDuration(r *http.Request, dur int64) {
	if rec, ok := r.Context().Value(auditKey{}).(*auditRec); ok {
		rec.mu.Lock()
		rec.durationSec = dur
		rec.mu.Unlock()
	}
}

// auditOf builds the record of a finished request.
func (s *storeServer) auditOf(r *http.Request, rec *auditRec, status int, errBody []byte) auditEvent {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if status == 0 {
		status = 200
	}
	e := auditEvent{
		Time: rec.start.UTC().Format(time.RFC3339Nano), User: rec.user, IP: clientIP(r), Agent: truncRunes(r.UserAgent(), 200),
		Action: rec.action, Job: rec.target, Method: r.Method, Path: r.URL.Path, Status: status, MS: time.Since(rec.start).Milliseconds(),
		Resource: rec.resource, SessionID: rec.sessionID, DurationSec: rec.durationSec,
	}
	if e.Action == "" {
		e.Action = "http"
	}
	if e.Resource == nil {
		e.Resource = s.resourceOf(r.URL.Path)
	}
	// a request that made something (POST /api/jobs) names it in the action's target
	if e.Resource.ID == "" && rec.target != "" {
		e.Resource.ID = strings.Fields(rec.target)[0]
		if e.Resource.Type == "交付" {
			s.mu.Lock()
			e.Resource.Name = s.jobs[e.Resource.ID].ClusterID
			s.mu.Unlock()
		} else if e.Resource.Type == "用户" {
			e.Resource.Name = e.Resource.ID
		}
	}
	switch {
	case status < 400:
		e.Result = "ok"
	case status == 401 || status == 403:
		e.Result = "denied"
	case status < 500:
		e.Result = "failed"
	default:
		e.Result = "error"
	}
	if status >= 400 {
		var x struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(errBody, &x) == nil && x.Error != "" {
			e.Error = truncRunes(x.Error, 300)
		}
	}
	e.Request = auditRequestText(r, rec.body)
	return e
}

// auditRequestText is what was asked: the query, and the body with secrets masked and long values shortened.
func auditRequestText(r *http.Request, body *bytes.Buffer) string {
	var parts []string
	if q := r.URL.Query(); len(q) > 0 {
		m := map[string]any{}
		for k, v := range q {
			m[k] = strings.Join(v, ",")
		}
		b, _ := json.Marshal(auditMask(m, ""))
		parts = append(parts, "参数 "+string(b))
	}
	if r.MultipartForm != nil {
		m := map[string]any{}
		for k, v := range r.MultipartForm.Value {
			var x any
			if json.Unmarshal([]byte(strings.Join(v, "")), &x) == nil {
				m[k] = auditMask(x, k)
			} else {
				m[k] = auditMask(strings.Join(v, ","), k)
			}
		}
		for k, fs := range r.MultipartForm.File {
			var names []string
			for _, f := range fs {
				names = append(names, fmt.Sprintf("%s（%d 字节，内容不记录）", f.Filename, f.Size))
			}
			m[k] = strings.Join(names, "、")
		}
		b, _ := json.Marshal(m)
		parts = append(parts, string(b))
	} else if body != nil && body.Len() > 0 {
		var x any
		if json.Unmarshal(body.Bytes(), &x) == nil {
			b, _ := json.Marshal(auditMask(x, ""))
			parts = append(parts, string(b))
		} else if utf8.Valid(body.Bytes()) {
			parts = append(parts, truncRunes(aiScrub(body.String()), 500))
		} else {
			parts = append(parts, fmt.Sprintf("（%d 字节的二进制内容，不记录）", body.Len()))
		}
	}
	return truncRunes(strings.Join(parts, "\n"), 4000)
}

// secret field names; their values are never kept.
var auditSecret = regexp.MustCompile(`(?i)(pass(word|wd)?|secret|token|api_?key|key_enc|private|cert|credential|authorization|^current$|^next$)`)

func auditMask(v any, key string) any {
	if key != "" && auditSecret.MatchString(key) {
		if s, ok := v.(string); ok && s == "" {
			return ""
		}
		return "******"
	}
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			out[k] = auditMask(x[k], k)
		}
		return out
	case []any:
		if len(x) > 0 {
			if s, ok := x[0].(string); ok && strings.HasPrefix(s, "data:") {
				return fmt.Sprintf("（%d 张图片，内容不记录）", len(x))
			}
		}
		out := make([]any, 0, min(len(x), 20))
		for i, y := range x {
			if i >= 20 {
				out = append(out, fmt.Sprintf("…另 %d 项", len(x)-20))
				break
			}
			out = append(out, auditMask(y, key))
		}
		return out
	case string:
		if strings.HasPrefix(x, "data:") {
			return "（文件内容，不记录）"
		}
		x = aiScrub(x)
		if n := utf8.RuneCountInString(x); n > 300 {
			return string([]rune(x)[:300]) + fmt.Sprintf("…（共 %d 字）", n)
		}
		return x
	}
	return v
}

// resourcePatterns say what a path is about.
var resourcePatterns = []struct {
	re   *regexp.Regexp
	kind string
}{
	{regexp.MustCompile(`^/api/jobs/([^/]+)`), "交付"},
	{regexp.MustCompile(`^/api/jobs$`), "交付"},
	{regexp.MustCompile(`^/api/users/([^/]+)`), "用户"},
	{regexp.MustCompile(`^/api/users$`), "用户"},
	{regexp.MustCompile(`^/api/iam/roles/?([^/]*)`), "角色"},
	{regexp.MustCompile(`^/api/iam/teams/?([^/]*)`), "团队"},
	{regexp.MustCompile(`^/api/iam/deleted/([^/]+)`), "已删除的用户"},
	{regexp.MustCompile(`^/api/components/([^/]+)`), "组件"},
	{regexp.MustCompile(`^/api/library/python`), "运行环境"},
	{regexp.MustCompile(`^/api/library`), "软件库"},
	{regexp.MustCompile(`^/api/clusters/([^/]+)/rehearsals`), "变更演练"},
	{regexp.MustCompile(`^/api/clusters/([^/]+)`), "集群"},
	{regexp.MustCompile(`^/api/settings/ai/mcp/?([^/]*)`), "MCP 服务"},
	{regexp.MustCompile(`^/api/settings/ai/usage`), "AI 用量"},
	{regexp.MustCompile(`^/api/settings/ai`), "AI 设置"},
	{regexp.MustCompile(`^/api/settings/execution-nodes/?([^/]*)`), "执行节点"},
	{regexp.MustCompile(`^/api/settings/sandbox`), "沙箱设置"},
	{regexp.MustCompile(`^/api/settings/storage`), "存储设置"},
	{regexp.MustCompile(`^/api/settings/report`), "交付文档设置"},
	{regexp.MustCompile(`^/api/settings`), "通知设置"},
	{regexp.MustCompile(`^/api/ai/chats/?([^/]*)`), "AI 对话"},
	{regexp.MustCompile(`^/api/ai`), "AI"},
	{regexp.MustCompile(`^/api/kb/submissions/([^/]+)`), "知识库提交"},
	{regexp.MustCompile(`^/api/kb/?([^/]*)`), "团队知识库"},
	{regexp.MustCompile(`^/api/me/kb/?([^/]*)`), "我的知识库"},
	{regexp.MustCompile(`^/api/me/sessions/?([^/]*)`), "我的会话"},
	{regexp.MustCompile(`^/api/me`), "我的账户"},
	{regexp.MustCompile(`^/api/audit/sessions/?([^/]*)`), "会话审计"},
	{regexp.MustCompile(`^/api/audit`), "操作审计"},
	{regexp.MustCompile(`^/api/(resolve|spec)`), "部署规格"},
	{regexp.MustCompile(`^/api/(login|logout|session)`), "登录"},
}

func (s *storeServer) resourceOf(path string) *auditResource {
	for _, p := range resourcePatterns {
		m := p.re.FindStringSubmatch(path)
		if m == nil {
			continue
		}
		res := &auditResource{Type: p.kind}
		if len(m) > 1 {
			res.ID = m[1]
		}
		switch p.kind {
		case "交付":
			s.mu.Lock()
			if j, ok := s.jobs[res.ID]; ok {
				res.Name = j.ClusterID
			}
			s.mu.Unlock()
		case "用户", "组件", "已删除的用户":
			res.Name = res.ID
		case "角色", "团队":
			iamMu.Lock()
			st := s.iamLoad()
			iamMu.Unlock()
			if r, ok := st.role(res.ID); ok {
				res.Name = r.Name
			}
			for _, t := range st.Teams {
				if t.ID == res.ID {
					res.Name = t.Name
				}
			}
		}
		return res
	}
	return &auditResource{Type: "其他"}
}

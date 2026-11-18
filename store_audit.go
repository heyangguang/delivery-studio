package main

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The platform audit log: who did what, and when. Written by s.audit from the places that change something.

type auditEvent struct {
	Time   string `json:"time"`
	Action string `json:"action"`
	User   string `json:"user"`
	Job    string `json:"job"` // the object the action named (a delivery id, a user, a title)
	IP     string `json:"ip,omitempty"`
	// What the request was: the browser it came from, method and path, the resource, what was sent (secrets
	// masked), and how it ended. Records written before these existed only have the fields above.
	Agent       string         `json:"agent,omitempty"`
	Method      string         `json:"method,omitempty"`
	Path        string         `json:"path,omitempty"`
	Resource    *auditResource `json:"resource,omitempty"`
	Request     string         `json:"request,omitempty"`
	Status      int            `json:"status,omitempty"`
	Result      string         `json:"result,omitempty"` // ok | denied | failed | error
	Error       string         `json:"error,omitempty"`
	MS          int64          `json:"ms,omitempty"`
	SessionID   string         `json:"session_id,omitempty"`
	DurationSec int64          `json:"duration_sec,omitempty"`
}

func (r *storeRepository) auditBetween(from, to time.Time) ([]auditEvent, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	rows, err := r.db.QueryContext(ctx, "SELECT document FROM middleware_store_audit WHERE occurred_at >= $1 AND occurred_at < $2 ORDER BY occurred_at DESC, id DESC LIMIT 50000", from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []auditEvent
	for rows.Next() {
		var b []byte
		var e auditEvent
		if rows.Scan(&b) == nil && json.Unmarshal(b, &e) == nil {
			out = append(out, e)
		}
	}
	return out, rows.Err()
}

func (s *storeServer) auditEvents(from, to time.Time) []auditEvent {
	if s.repo != nil {
		out, _ := s.repo.auditBetween(from, to)
		return out
	}
	f, err := os.Open(filepath.Join(s.cfg.DataDir, "audit.jsonl"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []auditEvent
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var e auditEvent
		if json.Unmarshal(sc.Bytes(), &e) != nil {
			continue
		}
		if t, err := time.Parse(time.RFC3339, e.Time); err == nil && !t.Before(from) && t.Before(to) {
			out = append(out, e)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Time > out[j].Time })
	return out
}

// auditQuery is the records between two times that match the filters, newest first, and what the filters can offer.
func (s *storeServer) auditQuery(q map[string][]string) (rows []auditEvent, users []string, actions map[string]int, kinds map[string]int) {
	get := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	to := time.Now().UTC().Add(time.Minute)
	from := to.AddDate(0, 0, -7)
	if t, err := time.Parse(time.RFC3339, get("from")); err == nil {
		from = t.UTC()
	}
	if t, err := time.Parse(time.RFC3339, get("to")); err == nil {
		to = t.UTC()
	}
	all := s.auditEvents(from, to)
	user, action, kind, result, text := get("user"), get("action"), get("resource"), get("result"), strings.ToLower(strings.TrimSpace(get("q")))
	seen := map[string]bool{}
	actions, kinds = map[string]int{}, map[string]int{}
	rows = make([]auditEvent, 0, len(all))
	for _, e := range all {
		if e.Result == "" {
			e.Result = "ok"
		}
		k := ""
		if e.Resource != nil {
			k = e.Resource.Type
		}
		seen[e.User] = true
		actions[e.Action]++
		if k != "" {
			kinds[k]++
		}
		if (user != "" && e.User != user) || (action != "" && e.Action != action) || (kind != "" && k != kind) || (result != "" && e.Result != result) {
			continue
		}
		if text != "" {
			hay := e.User + " " + e.Action + " " + e.Job + " " + e.IP + " " + e.SessionID + " " + e.Path + " " + e.Request + " " + e.Error
			if e.Resource != nil {
				hay += " " + e.Resource.ID + " " + e.Resource.Name
			}
			if !strings.Contains(strings.ToLower(hay), text) {
				continue
			}
		}
		rows = append(rows, e)
	}
	return rows, sortedKeys(seen), actions, kinds
}

func (s *storeServer) handleAudit(w http.ResponseWriter, r *http.Request, session storeSession) {
	if !s.need(w, session.User, "audit.view") {
		return
	}
	q := r.URL.Query()
	rows, users, actions, kinds := s.auditQuery(q)
	if strings.HasSuffix(r.URL.Path, "/export") {
		s.auditReq(r, "audit-export", session.User, fmt.Sprint(len(rows)))
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="audit-`+time.Now().Format("20060102-150405")+`.csv"`)
		cw := csv.NewWriter(w)
		_, _ = w.Write([]byte("\xEF\xBB\xBF")) // so spreadsheet programs read it as UTF-8
		_ = cw.Write([]string{"时间", "用户", "来源 IP", "浏览器", "动作", "资源类型", "资源编号", "资源名称", "方法", "路径", "请求内容", "结果", "状态码", "错误", "耗时（毫秒）", "会话编号", "会话时长（秒）"})
		for _, e := range rows {
			res := auditResource{}
			if e.Resource != nil {
				res = *e.Resource
			}
			_ = cw.Write([]string{e.Time, e.User, e.IP, e.Agent, e.Action, res.Type, res.ID, res.Name, e.Method, e.Path, e.Request, e.Result, strconv.Itoa(e.Status), e.Error, strconv.FormatInt(e.MS, 10), e.SessionID, strconv.FormatInt(e.DurationSec, 10)})
		}
		cw.Flush()
		return
	}
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	if size <= 0 || size > 200 {
		size = 50
	}
	if page < 1 {
		page = 1
	}
	start := min((page-1)*size, len(rows))
	s.writeJSON(w, 200, map[string]any{"rows": rows[start:min(start+size, len(rows))], "total": len(rows), "page": page, "size": size, "users": users, "actions": actions, "resources": kinds})
}

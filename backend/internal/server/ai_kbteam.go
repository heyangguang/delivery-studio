package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// The team knowledge base: what the organisation knows, for everyone's conversations with the assistant. Anyone with
// kb.submit proposes a document (often a troubleshooting story the assistant has already written up); someone with
// kb.manage approves it into the base, for everyone or for one team. Documents of a team are only seen by its members.

type teamDoc struct {
	kbDoc
	Team   string `json:"team,omitempty"`   // "" for everyone, else a team id
	By     string `json:"by"`               // who submitted it
	Source string `json:"source,omitempty"` // where it came from: "delivery <id> <step>" or empty
	Editor string `json:"editor,omitempty"` // who approved or last changed it
}

type kbSubmission struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Text       string `json:"text"`
	Team       string `json:"team,omitempty"`
	Source     string `json:"source,omitempty"`
	By         string `json:"by"`
	At         string `json:"at"`
	Status     string `json:"status"` // pending | approved | rejected
	Reviewer   string `json:"reviewer,omitempty"`
	ReviewedAt string `json:"reviewed_at,omitempty"`
	Note       string `json:"note,omitempty"`
	Doc        string `json:"doc,omitempty"` // the document it became
}

var teamKBMu sync.Mutex

func (s *storeServer) teamKBDir(kind string) string { return s.aiFile(filepath.Join("kb-team", kind)) }

func (s *storeServer) teamDocs() []teamDoc {
	files, _ := filepath.Glob(filepath.Join(s.teamKBDir("docs"), "*.json"))
	out := []teamDoc{}
	for _, f := range files {
		var d teamDoc
		if b, err := os.ReadFile(f); err == nil && json.Unmarshal(b, &d) == nil && d.ID != "" {
			out = append(out, d)
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Updated > out[b].Updated })
	return out
}

// teamDocsFor are the documents a person may read: those for everyone and those of their teams.
func (s *storeServer) teamDocsFor(user string) []teamDoc {
	a := s.accessOf(user)
	if !a.can("kb.view") {
		return nil
	}
	mine := map[string]bool{}
	for _, t := range a.Teams {
		mine[t] = true
	}
	out := []teamDoc{}
	for _, d := range s.teamDocs() {
		if d.Team == "" || mine[d.Team] || a.can("kb.manage") {
			out = append(out, d)
		}
	}
	return out
}

func (s *storeServer) teamDoc(id string) (teamDoc, bool) {
	var d teamDoc
	if !kbIDRE.MatchString(id) {
		return d, false
	}
	b, err := os.ReadFile(filepath.Join(s.teamKBDir("docs"), id+".json"))
	return d, err == nil && json.Unmarshal(b, &d) == nil
}

func (s *storeServer) saveTeamDoc(d teamDoc) (teamDoc, error) {
	d.Title, d.Text = strings.TrimSpace(d.Title), strings.TrimRight(d.Text, " \n")
	if d.Title == "" || utf8.RuneCountInString(d.Title) > 120 {
		return d, fmt.Errorf("请填写标题（120 字以内）")
	}
	if strings.TrimSpace(d.Text) == "" || len(d.Text) > kbMaxBytes || !utf8.ValidString(d.Text) {
		return d, fmt.Errorf("内容要是 1 MiB 以内的文本")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if d.ID == "" {
		d.ID, d.Created = randomStoreToken(6), now
	}
	d.Size, d.Updated = len(d.Text), now
	return d, writeJSONFile(filepath.Join(s.teamKBDir("docs"), d.ID+".json"), d)
}

func (s *storeServer) submissions() []kbSubmission {
	files, _ := filepath.Glob(filepath.Join(s.teamKBDir("submissions"), "*.json"))
	out := []kbSubmission{}
	for _, f := range files {
		var x kbSubmission
		if b, err := os.ReadFile(f); err == nil && json.Unmarshal(b, &x) == nil && x.ID != "" {
			out = append(out, x)
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].At > out[b].At })
	return out
}

func (s *storeServer) validTeam(id string) bool {
	if id == "" {
		return true
	}
	iamMu.Lock()
	st := s.iamLoad()
	iamMu.Unlock()
	for _, t := range st.Teams {
		if t.ID == id {
			return true
		}
	}
	return false
}

func (s *storeServer) handleTeamKB(w http.ResponseWriter, r *http.Request, session storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/kb"), "/")
	parts := strings.Split(rest, "/")
	me := session.User
	a := s.accessOf(me)
	teamKBMu.Lock()
	defer teamKBMu.Unlock()
	switch {
	case rest == "" && r.Method == "GET":
		docs := s.teamDocsFor(me)
		for i := range docs {
			docs[i].Text = ""
		}
		pending, mineSub := 0, []kbSubmission{}
		for _, x := range s.submissions() {
			if x.Status == "pending" {
				pending++
			}
			if x.By == me {
				x.Text = ""
				mineSub = append(mineSub, x)
			}
		}
		out := map[string]any{"docs": docs, "mine": mineSub, "can_submit": a.can("kb.submit"), "can_manage": a.can("kb.manage")}
		if a.can("kb.manage") {
			out["pending"] = pending
		}
		s.writeJSON(w, 200, out)

	case rest == "search" && r.Method == "GET":
		out := []map[string]any{}
		for _, h := range s.teamSearch(me, r.URL.Query().Get("q"), 10) {
			out = append(out, map[string]any{"id": h.Doc.ID, "title": h.Doc.Title, "part": h.Part + 1, "text": h.Text})
		}
		s.writeJSON(w, 200, map[string]any{"hits": out})

	case rest == "submissions" && r.Method == "GET":
		out := []kbSubmission{}
		for _, x := range s.submissions() {
			if a.can("kb.manage") || x.By == me {
				out = append(out, x)
			}
		}
		s.writeJSON(w, 200, map[string]any{"submissions": out})

	case rest == "submissions" && r.Method == "POST":
		var in kbSubmission
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, kbMaxBytes+8192)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		in.Title, in.Text = strings.TrimSpace(in.Title), strings.TrimSpace(in.Text)
		if in.Title == "" || utf8.RuneCountInString(in.Title) > 120 || in.Text == "" || len(in.Text) > kbMaxBytes || !utf8.ValidString(in.Text) {
			s.fail(w, 400, "请填写标题和内容（1 MiB 以内的文本）")
			return
		}
		if !s.validTeam(in.Team) || (in.Team != "" && !contains(a.Teams, in.Team) && !a.can("kb.manage")) {
			s.fail(w, 400, "只能提交到自己所在的团队，或全平台")
			return
		}
		if len(in.Source) > 200 {
			in.Source = in.Source[:200]
		}
		pending := 0
		for _, x := range s.submissions() {
			if x.By == me && x.Status == "pending" {
				pending++
			}
		}
		if pending >= 50 {
			s.fail(w, 409, "你已经有 50 份等待审核，请等审核后再提交")
			return
		}
		in.ID, in.By, in.At, in.Status = randomStoreToken(6), me, time.Now().UTC().Format(time.RFC3339), "pending"
		in.Reviewer, in.ReviewedAt, in.Note, in.Doc = "", "", "", ""
		if err := writeJSONFile(filepath.Join(s.teamKBDir("submissions"), in.ID+".json"), in); err != nil {
			s.fail(w, 500, "提交失败，请稍后重试")
			return
		}
		s.auditReq(r, "kb-submit", me, in.Title)
		s.writeJSON(w, 201, in)

	case parts[0] == "submissions" && len(parts) == 3 && (parts[2] == "approve" || parts[2] == "reject") && r.Method == "POST":
		var in struct {
			Title string `json:"title"`
			Text  string `json:"text"`
			Team  string `json:"team"`
			Note  string `json:"note"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, kbMaxBytes+8192)).Decode(&in)
		path := filepath.Join(s.teamKBDir("submissions"), parts[1]+".json")
		var x kbSubmission
		if !kbIDRE.MatchString(parts[1]) {
			s.fail(w, 404, "没有这份提交")
			return
		}
		if b, err := os.ReadFile(path); err != nil || json.Unmarshal(b, &x) != nil {
			s.fail(w, 404, "没有这份提交")
			return
		}
		if x.Status != "pending" {
			s.fail(w, 409, "这份提交已经审核过了")
			return
		}
		x.Reviewer, x.ReviewedAt, x.Note = me, time.Now().UTC().Format(time.RFC3339), strings.TrimSpace(in.Note)
		if utf8.RuneCountInString(x.Note) > 500 {
			s.fail(w, 400, "说明不能超过 500 字")
			return
		}
		if parts[2] == "reject" {
			x.Status = "rejected"
		} else {
			if in.Title != "" {
				x.Title = in.Title
			}
			if in.Text != "" {
				x.Text = in.Text
			}
			if !s.validTeam(in.Team) {
				s.fail(w, 400, "没有这个团队")
				return
			}
			d, err := s.saveTeamDoc(teamDoc{kbDoc: kbDoc{Title: x.Title, Text: x.Text}, Team: in.Team, By: x.By, Source: x.Source, Editor: me})
			if err != nil {
				s.fail(w, 400, err.Error())
				return
			}
			x.Status, x.Doc, x.Team = "approved", d.ID, in.Team
		}
		if err := writeJSONFile(path, x); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "kb-"+parts[2], me, x.Title)
		s.writeJSON(w, 200, x)

	case rest == "" && r.Method == "POST", parts[0] != "submissions" && len(parts) == 1 && r.Method == "PUT":
		var in teamDoc
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, kbMaxBytes+8192)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		if !s.validTeam(in.Team) {
			s.fail(w, 400, "没有这个团队")
			return
		}
		d := teamDoc{kbDoc: kbDoc{Title: in.Title, Text: in.Text}, Team: in.Team, By: me, Editor: me}
		if r.Method == "PUT" {
			old, ok := s.teamDoc(parts[0])
			if !ok {
				s.fail(w, 404, "没有这份资料")
				return
			}
			d.ID, d.Created, d.By, d.Source = old.ID, old.Created, old.By, old.Source
		}
		d, err := s.saveTeamDoc(d)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		s.auditReq(r, "kb-edit", me, d.Title)
		d.Text = ""
		s.writeJSON(w, 200, d)

	case len(parts) == 1 && r.Method == "GET":
		d, ok := s.teamDoc(parts[0])
		if !ok || !s.teamDocVisible(me, d) {
			s.fail(w, 404, "没有这份资料")
			return
		}
		s.writeJSON(w, 200, d)
	case len(parts) == 1 && r.Method == "DELETE":
		d, ok := s.teamDoc(parts[0])
		if !ok {
			s.fail(w, 404, "没有这份资料")
			return
		}
		_ = os.Remove(filepath.Join(s.teamKBDir("docs"), d.ID+".json"))
		s.auditReq(r, "kb-delete", me, d.Title)
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) teamDocVisible(user string, d teamDoc) bool {
	for _, x := range s.teamDocsFor(user) {
		if x.ID == d.ID {
			return true
		}
	}
	return false
}

// teamSearch ranks the pieces of the team documents a person may read.
func (s *storeServer) teamSearch(user, query string, limit int) []kbHit {
	var docs []kbSrc
	for _, d := range s.teamDocsFor(user) {
		if full, ok := s.teamDoc(d.ID); ok {
			docs = append(docs, kbSrc{full.kbDoc, true})
		}
	}
	return kbRank(docs, query, limit)
}

package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// What a person manages for themselves (/api/me): their password, and the skills, outside services and knowledge base
// their own conversations use. Everything here belongs to the signed-in account and nobody else sees it.

func (s *storeServer) userFile(user, name string) string {
	return s.aiFile(filepath.Join("users", user, name))
}

func (s *storeServer) userSkills(user string) []aiSkill {
	var out []aiSkill
	if !userNameOK(user) {
		return out
	}
	if s.repo != nil {
		if b, ok, err := s.repo.getKV("user_ai_skills", user); err == nil && ok {
			_ = json.Unmarshal(b, &out)
			return out
		}
	}
	if b, err := os.ReadFile(s.userFile(user, "skills.json")); err == nil {
		_ = json.Unmarshal(b, &out)
		if s.repo != nil {
			_ = s.repo.putKV("user_ai_skills", user, "", b)
		}
	}
	return out
}

func (s *storeServer) saveUserSkills(user string, skills []aiSkill) error {
	if s.repo != nil {
		b, err := json.Marshal(skills)
		if err != nil {
			return err
		}
		return s.repo.putKV("user_ai_skills", user, "", b)
	}
	return writeJSONFile(s.userFile(user, "skills.json"), skills)
}

func (s *storeServer) loadUserMCP(user string) []mcpServer {
	out := []mcpServer{}
	if !userNameOK(user) {
		return out
	}
	if s.repo != nil {
		if b, ok, err := s.repo.getKV("user_ai_mcp", user); err == nil && ok {
			_ = json.Unmarshal(b, &out)
			return out
		}
	}
	if b, err := os.ReadFile(s.userFile(user, "mcp.json")); err == nil {
		_ = json.Unmarshal(b, &out)
		if s.repo != nil {
			_ = s.repo.putKV("user_ai_mcp", user, "", b)
		}
	}
	return out
}

func (s *storeServer) saveUserMCP(user string, all []mcpServer) error {
	if s.repo != nil {
		b, err := json.Marshal(all)
		if err != nil {
			return err
		}
		return s.repo.putKV("user_ai_mcp", user, "", b)
	}
	return writeJSONFile(s.userFile(user, "mcp.json"), all)
}

// kbTextExt are the files a knowledge base takes: text a person can read.
var kbTextExt = map[string]bool{".md": true, ".markdown": true, ".txt": true, ".log": true, ".yaml": true, ".yml": true, ".json": true, ".conf": true, ".cfg": true, ".ini": true, ".toml": true, ".sh": true, ".sql": true, ".csv": true, ".xml": true, ".j2": true, ".properties": true}

func (s *storeServer) handleMe(w http.ResponseWriter, r *http.Request, session storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/me"), "/")
	parts := strings.Split(rest, "/")
	me := session.User
	s.mu.Lock()
	u, ok := s.users[me]
	s.mu.Unlock()
	if !ok || !userNameOK(me) {
		s.fail(w, 404, "账户不存在")
		return
	}
	switch {
	case rest == "" && r.Method == "GET":
		st := s.aiLoad()
		a := s.accessOf(me)
		held := []perm{}
		for _, p := range perms {
			if a.can(p.ID) {
				held = append(held, p)
			}
		}
		view := s.sessionView(session)
		s.writeJSON(w, 200, map[string]any{
			"access":   map[string]any{"perms": held, "scope": a.Scope, "roles": view["role_names"], "teams": view["team_names"], "clusters": nonNilStringMap(a.Clusters)},
			"username": me, "role": u.Role,
			"skills": len(s.userSkills(me)), "mcp": len(s.loadUserMCP(me)), "kb": len(s.kbList(me)),
			"user_mcp": st.UserMCP(), "ai": st.Enabled,
			"session_id": session.ID,
			"issued_at":  session.CreatedAt.UTC().Format(time.RFC3339),
			"expires_at": session.Expires.UTC().Format(time.RFC3339),
		})
	case parts[0] == "sessions":
		s.handleMeSessions(w, r, session, parts[1:])
	case rest == "activity" && r.Method == "GET":
		s.userActivity(w, u)
	case rest == "password" && r.Method == "POST":
		var in struct {
			Current string `json:"current"`
			Next    string `json:"next"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		if !constantStoreEqual(storePasswordHash(in.Current, u.Salt, u.Iterations), u.PasswordHash) {
			s.auditReq(r, "me-password-failed", me, "")
			s.fail(w, 403, "当前密码不对")
			return
		}
		if utf8.RuneCountInString(in.Next) < 12 || len(in.Next) > 256 {
			s.fail(w, 400, "新密码至少 12 个字符")
			return
		}
		if in.Next == in.Current {
			s.fail(w, 400, "新密码不能和当前密码一样")
			return
		}
		s.mu.Lock()
		next := s.users[me]
		next.Salt, next.Iterations = randomStoreToken(16), storeHashIterations
		next.PasswordHash = storePasswordHash(in.Next, next.Salt, next.Iterations)
		old := s.users[me]
		s.users[me] = next
		var err error
		if s.repo != nil {
			err = s.repo.updateUser(next)
		} else {
			err = saveStoreUsers(s.cfg.DataDir, s.users)
		}
		if err != nil {
			s.users[me] = old
			s.mu.Unlock()
			s.fail(w, 500, "密码保存失败，请稍后重试")
			return
		}
		// other sign-ins of this account end; this one stays
		closed := s.revokeUserSessionsLocked(me, session.ID, "password-changed", "本人修改密码后注销其他会话")
		s.mu.Unlock()
		if len(closed) > 0 {
			s.finalizeClosedSessions(me, closed)
		}
		s.auditReq(r, "me-password", me, "")
		s.writeJSON(w, 200, map[string]bool{"ok": true})

	case rest == "skills" && r.Method == "GET":
		s.writeJSON(w, 200, map[string]any{"skills": nzSkills(s.userSkills(me)), "platform": localizedSkills(wLang(w), s.skillsFor("", true))})
	case rest == "skills" && r.Method == "PUT":
		var in struct {
			Skills []aiSkill `json:"skills"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&in) != nil || len(in.Skills) > 50 {
			s.fail(w, 400, "提交的内容有问题（最多 50 个技能）")
			return
		}
		taken := map[string]bool{}
		for _, sk := range s.skills(false) {
			taken[sk.Name] = true
		}
		if msg := checkSkills(in.Skills, taken); msg != "" {
			s.fail(w, 400, msg)
			return
		}
		if err := s.saveUserSkills(me, in.Skills); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "me-skills", me, "")
		s.writeJSON(w, 200, map[string]any{"skills": nzSkills(s.userSkills(me))})

	case parts[0] == "mcp":
		if !s.aiLoad().UserMCP() && r.Method != "GET" && r.Method != "DELETE" {
			s.fail(w, 403, "管理员关闭了个人接入外部服务")
			return
		}
		s.mcpAPI(w, r, session, parts, func() []mcpServer { return s.loadUserMCP(me) }, func(all []mcpServer) error { return s.saveUserMCP(me, all) }, true)

	case parts[0] == "ai-prefs":
		s.handlePrefs(w, r, me, parts[1:])

	case parts[0] == "files":
		s.handleMeFiles(w, r, me, parts[1:])

	case rest == "kb" && r.Method == "GET":
		s.writeJSON(w, 200, map[string]any{"docs": s.kbList(me)})
	case rest == "kb" && r.Method == "POST":
		s.kbUpload(w, r, me)
	case rest == "kb/search" && r.Method == "GET":
		hits := s.kbSearch(me, r.URL.Query().Get("q"), 10)
		out := []map[string]any{}
		for _, h := range hits {
			out = append(out, map[string]any{"id": h.Doc.ID, "title": h.Doc.Title, "part": h.Part + 1, "text": h.Text})
		}
		s.writeJSON(w, 200, map[string]any{"hits": out})
	case parts[0] == "kb" && len(parts) == 2 && r.Method == "GET":
		d, ok := s.kbGet(me, parts[1])
		if !ok {
			s.fail(w, 404, "没有这份资料")
			return
		}
		s.writeJSON(w, 200, d)
	case parts[0] == "kb" && len(parts) == 2 && r.Method == "PUT":
		var in kbDoc
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, kbMaxBytes+4096)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		in.ID = parts[1]
		d, err := s.kbSave(me, in)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		s.auditReq(r, "me-kb", me, d.Title)
		d.Text = ""
		s.writeJSON(w, 200, d)
	case parts[0] == "kb" && len(parts) == 2 && r.Method == "DELETE":
		d, _ := s.kbGet(me, parts[1])
		if !s.kbDelete(me, parts[1]) {
			s.fail(w, 404, "没有这份资料")
			return
		}
		s.auditReq(r, "me-kb-delete", me, d.Title)
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func nzSkills(x []aiSkill) []aiSkill {
	if x == nil {
		return []aiSkill{}
	}
	return x
}

// kbUpload keeps a pasted document; files go through the storage space (/api/me/files).
func (s *storeServer) kbUpload(w http.ResponseWriter, r *http.Request, me string) {
	var in kbDoc
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, kbMaxBytes+4096)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	in.ID = ""
	d, err := s.kbSave(me, in)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	s.auditReq(r, "me-kb", me, d.Title)
	d.Text = ""
	s.writeJSON(w, 201, map[string]any{"added": []kbDoc{d}, "failed": []string{}})
}

package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Removing an account. Its deliveries and every audit record stay: they can be handed to someone else now or later,
// or stay under the old name for those who see everything. What was only its own goes with it: its password, its
// sign-ins, its conversations with the assistant, its skills, outside services and knowledge base.

func (s *storeServer) deleteUser(w http.ResponseWriter, r *http.Request, session storeSession, name string) {
	var in struct {
		MoveTo string `json:"move_to"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&in)
	if name == session.User {
		s.fail(w, 409, "不能删除自己")
		return
	}
	s.mu.Lock()
	u, ok := s.users[name]
	_, toOK := s.users[in.MoveTo]
	s.mu.Unlock()
	if !ok {
		s.fail(w, 404, "账户不存在")
		return
	}
	if in.MoveTo != "" && (!toOK || in.MoveTo == name) {
		s.fail(w, 400, "要接手交付的账户不存在")
		return
	}
	actor := s.accessOf(session.User)
	iamMu.Lock()
	defer iamMu.Unlock()
	st := s.iamLoad()
	g := st.grantOf(name, u.Role)
	for _, id := range g.Roles {
		if rl, ok := st.role(id); ok {
			if p, ok := within(actor, rl.Perms, rl.Scope); !ok {
				s.fail(w, 403, escalation(p))
				return
			}
		}
	}
	// the platform keeps someone who can manage people and roles
	next := st
	next.Grants = map[string]grant{}
	for k, v := range st.Grants {
		if k != name {
			next.Grants[k] = v
		}
	}
	s.mu.Lock()
	delete(s.users, name)
	keep := s.keepersLocked(next)
	s.users[name] = u
	s.mu.Unlock()
	if keep == 0 {
		s.fail(w, 409, "这是唯一能管理用户和角色的人，不能删除")
		return
	}
	// hand the deliveries over first, so nothing is left without an owner who can still sign in when asked
	moved := 0
	if in.MoveTo != "" {
		s.mu.Lock()
		for id, j := range s.jobs {
			if j.Owner == name {
				j.Owner = in.MoveTo
				if err := s.persistJob(j); err != nil {
					s.mu.Unlock()
					s.fail(w, 500, "交付转交失败，账户没有删除")
					return
				}
				s.jobs[id] = j
				moved++
			}
		}
		s.mu.Unlock()
	}
	s.mu.Lock()
	delete(s.users, name)
	var err error
	if s.repo != nil {
		err = s.repo.deleteUser(name)
	} else {
		err = saveStoreUsers(s.cfg.DataDir, s.users)
	}
	if err != nil {
		s.users[name] = u
		s.mu.Unlock()
		s.fail(w, 500, "账户删除失败")
		return
	}
	closed := s.revokeUserSessionsLocked(name, "", "deleted", "账户已被管理员 "+session.User+" 删除")
	s.mu.Unlock()
	if len(closed) > 0 {
		s.finalizeClosedSessions(session.User, closed)
	}
	next.Deleted = append(next.Deleted, deletedUser{Username: name, At: time.Now().UTC().Format(time.RFC3339), By: session.User, Moved: in.MoveTo, MovedN: moved, Roles: g.Roles})
	_ = s.iamSave(next)
	// what was only theirs
	_ = os.RemoveAll(s.aiFile(filepath.Join("users", name)))
	_ = os.RemoveAll(s.chatDir(name))
	target := name
	if in.MoveTo != "" {
		target += " → " + in.MoveTo
	}
	s.auditReq(r, "user-delete", session.User, target)
	s.writeJSON(w, 200, map[string]any{"ok": true, "moved": moved})
}

// moveDeleted hands the deliveries still under a removed account's name to someone.
func (s *storeServer) moveDeleted(w http.ResponseWriter, r *http.Request, session storeSession, name string) {
	var in struct {
		MoveTo string `json:"move_to"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	iamMu.Lock()
	defer iamMu.Unlock()
	st := s.iamLoad()
	idx := -1
	for i, d := range st.Deleted {
		if d.Username == name {
			idx = i
		}
	}
	s.mu.Lock()
	_, ok := s.users[in.MoveTo]
	if idx < 0 || !ok {
		s.mu.Unlock()
		s.fail(w, 404, "没有这个已删除的账户，或接手的账户不存在")
		return
	}
	moved := 0
	for id, j := range s.jobs {
		if j.Owner == name {
			j.Owner = in.MoveTo
			if err := s.persistJob(j); err != nil {
				s.mu.Unlock()
				s.fail(w, 500, "交付转交失败")
				return
			}
			s.jobs[id] = j
			moved++
		}
	}
	s.mu.Unlock()
	st.Deleted[idx].Moved, st.Deleted[idx].MovedN = in.MoveTo, st.Deleted[idx].MovedN+moved
	_ = s.iamSave(st)
	s.auditReq(r, "user-deliveries-move", session.User, name+" → "+in.MoveTo)
	s.writeJSON(w, 200, map[string]any{"ok": true, "moved": moved})
}

// keepersLocked is keepers for a caller that holds s.mu.
func (s *storeServer) keepersLocked(st iamState) int {
	n := 0
	for _, u := range s.users {
		a := st.accessFrom(u)
		if a.can("iam.user") && a.can("iam.role") {
			n++
		}
	}
	return n
}

// nameTaken says whether a name is in use or belonged to a removed account.
func (s *storeServer) nameRetired(name string) bool {
	iamMu.Lock()
	defer iamMu.Unlock()
	for _, d := range s.iamLoad().Deleted {
		if d.Username == name {
			return true
		}
	}
	return false
}

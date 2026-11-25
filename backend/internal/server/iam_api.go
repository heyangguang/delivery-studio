package server

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"
)

// The IAM API: the permission catalogue, roles, teams, and what each person holds. Nobody can hand out more than they
// have, and the platform always keeps someone who can manage people and roles.

// keepers counts the enabled people who could still manage people and roles under st.
func (s *storeServer) keepers(st iamState) int {
	s.mu.Lock()
	users := make([]storeUser, 0, len(s.users))
	for _, u := range s.users {
		users = append(users, u)
	}
	s.mu.Unlock()
	n := 0
	for _, u := range users {
		a := st.accessFrom(u)
		if a.can("iam.user") && a.can("iam.role") {
			n++
		}
	}
	return n
}

// within says whether everything in perms (and the scope) is something the actor holds themselves.
func within(actor access, ps []string, scope string) (string, bool) {
	for _, p := range ps {
		if !actor.can(p) {
			return p, false
		}
	}
	if scope != "" && scopeRank[scope] > scopeRank[actor.Scope] {
		return "scope", false
	}
	return "", true
}

func escalation(p string) string {
	if p == "scope" {
		return "不能给出比自己更大的数据范围"
	}
	return "你自己没有「" + permIndex[p].Title + "」权限，不能把它授给别人"
}

func cleanPerms(in []string) ([]string, bool) {
	seen := map[string]bool{}
	hasAIUse := false
	for _, p := range in {
		if _, ok := permIndex[p]; !ok {
			return nil, false
		}
		if p == "ai.use" {
			hasAIUse = true
		}
	}
	out := []string{}
	for _, p := range in {
		if isAIFeaturePerm(p) && !hasAIUse {
			continue
		}
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	sort.Slice(out, func(a, b int) bool { return permOrder(out[a]) < permOrder(out[b]) })
	return out, true
}

func permOrder(id string) int {
	for i, p := range perms {
		if p.ID == id {
			return i
		}
	}
	return len(perms)
}

func (s *storeServer) handleIAM(w http.ResponseWriter, r *http.Request, session storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/iam"), "/")
	parts := strings.Split(rest, "/")
	actor := s.accessOf(session.User)
	iamMu.Lock()
	defer iamMu.Unlock()
	st := s.iamLoad()
	save := func(next iamState, action, target string) {
		if s.keepers(next) == 0 {
			s.fail(w, 409, "这样改之后就没有人能管理用户和角色了，已拒绝")
			return
		}
		if err := s.iamSave(next); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, action, session.User, target)
		s.writeJSON(w, 200, s.iamView(next))
	}
	switch {
	case rest == "" && r.Method == "GET":
		s.writeJSON(w, 200, s.iamView(st))

	case parts[0] == "roles" && (len(parts) == 1 && r.Method == "POST" || len(parts) == 2 && r.Method == "PUT"):
		var in role
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		in.Name, in.Desc = strings.TrimSpace(in.Name), strings.TrimSpace(in.Desc)
		ps, ok := cleanPerms(in.Perms)
		if !ok || in.Name == "" || utf8.RuneCountInString(in.Name) > 30 || utf8.RuneCountInString(in.Desc) > 200 || scopeRank[in.Scope] == 0 && in.Scope != "own" {
			s.fail(w, 400, "请填写角色名（30 字内），选择有效的权限和数据范围")
			return
		}
		if p, ok := within(actor, ps, in.Scope); !ok {
			s.fail(w, 403, escalation(p))
			return
		}
		for _, x := range st.allRoles() {
			if x.Name == in.Name && (len(parts) == 1 || x.ID != parts[1]) {
				s.fail(w, 409, "已经有叫「"+in.Name+"」的角色")
				return
			}
		}
		in.Perms, in.Builtin = ps, false
		for _, p := range ps {
			if isAIFeaturePerm(p) {
				in.GranularAI = true
				break
			}
		}
		if len(parts) == 1 {
			if len(st.Roles) >= 50 {
				s.fail(w, 409, "最多 50 个自定义角色")
				return
			}
			in.ID = "r" + randomStoreToken(4)
			st.Roles = append(st.Roles, in)
			save(st, "iam-role-add", in.Name)
			return
		}
		found := false
		for i := range st.Roles {
			if st.Roles[i].ID == parts[1] {
				// what the role had and the actor lacks cannot be taken away by them either
				if p, ok := within(actor, st.Roles[i].Perms, st.Roles[i].Scope); !ok {
					s.fail(w, 403, escalation(p))
					return
				}
				in.ID = parts[1]
				st.Roles[i], found = in, true
			}
		}
		if !found {
			s.fail(w, 404, "没有这个角色，或它是内置角色（内置角色不能修改，可以复制一份再改）")
			return
		}
		save(st, "iam-role-edit", in.Name)
	case parts[0] == "roles" && len(parts) == 2 && r.Method == "DELETE":
		keep := st.Roles[:0]
		name := ""
		for _, x := range st.Roles {
			if x.ID == parts[1] {
				name = x.Name
				if p, ok := within(actor, x.Perms, x.Scope); !ok {
					s.fail(w, 403, escalation(p))
					return
				}
				continue
			}
			keep = append(keep, x)
		}
		if name == "" {
			s.fail(w, 404, "没有这个角色，或它是内置角色")
			return
		}
		st.Roles = keep
		for u, g := range st.Grants {
			g.Roles = without(g.Roles, parts[1])
			st.Grants[u] = g
		}
		save(st, "iam-role-delete", name)

	case parts[0] == "teams" && (len(parts) == 1 && r.Method == "POST" || len(parts) == 2 && r.Method == "PUT"):
		var in struct {
			team
			Members *[]string `json:"members"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		t := in.team
		t.Name, t.Desc = strings.TrimSpace(t.Name), strings.TrimSpace(t.Desc)
		if t.Name == "" || utf8.RuneCountInString(t.Name) > 30 || utf8.RuneCountInString(t.Desc) > 200 {
			s.fail(w, 400, "请填写团队名（30 字内）")
			return
		}
		for _, x := range st.Teams {
			if x.Name == t.Name && (len(parts) == 1 || x.ID != parts[1]) {
				s.fail(w, 409, "已经有叫「"+t.Name+"」的团队")
				return
			}
		}
		if len(parts) == 1 {
			if len(st.Teams) >= 100 {
				s.fail(w, 409, "最多 100 个团队")
				return
			}
			t.ID = "t" + randomStoreToken(4)
			st.Teams = append(st.Teams, t)
		} else {
			found := false
			for i := range st.Teams {
				if st.Teams[i].ID == parts[1] {
					t.ID = parts[1]
					st.Teams[i], found = t, true
				}
			}
			if !found {
				s.fail(w, 404, "没有这个团队")
				return
			}
		}
		if in.Members != nil {
			want := map[string]bool{}
			s.mu.Lock()
			for _, m := range *in.Members {
				if _, ok := s.users[m]; !ok {
					s.mu.Unlock()
					s.fail(w, 400, "没有这个用户："+m)
					return
				}
				want[m] = true
			}
			legacy := map[string]string{}
			for n, u := range s.users {
				legacy[n] = u.Role
			}
			s.mu.Unlock()
			for n, lr := range legacy {
				g := st.grantOf(n, lr)
				has := contains(g.Teams, t.ID)
				if want[n] && !has {
					g.Teams = append(g.Teams, t.ID)
				} else if !want[n] && has {
					g.Teams = without(g.Teams, t.ID)
				} else {
					continue
				}
				st.Grants[n] = g
			}
		}
		save(st, map[bool]string{true: "iam-team-add", false: "iam-team-edit"}[len(parts) == 1], t.Name)
	case parts[0] == "deleted" && len(parts) == 3 && parts[2] == "move" && r.Method == "POST":
		iamMu.Unlock()
		s.moveDeleted(w, r, session, parts[1])
		iamMu.Lock()
	case parts[0] == "teams" && len(parts) == 2 && r.Method == "DELETE":
		keep := st.Teams[:0]
		name := ""
		for _, x := range st.Teams {
			if x.ID == parts[1] {
				name = x.Name
				continue
			}
			keep = append(keep, x)
		}
		if name == "" {
			s.fail(w, 404, "没有这个团队")
			return
		}
		st.Teams = keep
		for u, g := range st.Grants {
			g.Teams = without(g.Teams, parts[1])
			st.Grants[u] = g
		}
		save(st, "iam-team-delete", name)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func without(list []string, x string) []string {
	out := []string{}
	for _, v := range list {
		if v != x {
			out = append(out, v)
		}
	}
	return out
}

// iamView is the catalogue, the roles with how many hold each, the teams with their members, and every grant.
func (s *storeServer) iamView(st iamState) map[string]any {
	s.mu.Lock()
	users := map[string]storeUser{}
	for n, u := range s.users {
		users[n] = u
	}
	s.mu.Unlock()
	grants := map[string]grant{}
	holders := map[string]int{}
	members := map[string][]string{}
	for n, u := range users {
		g := st.grantOf(n, u.Role)
		if g.Teams == nil {
			g.Teams = []string{}
		}
		grants[n] = g
		for _, r := range g.Roles {
			if !u.Disabled {
				holders[r]++
			}
		}
		for _, t := range g.Teams {
			members[t] = append(members[t], n)
		}
	}
	type roleView struct {
		role
		Holders int `json:"holders"`
	}
	roles := []roleView{}
	for _, r := range st.allRoles() {
		r.Perms = expandRolePerms(r)
		roles = append(roles, roleView{r, holders[r.ID]})
	}
	type teamView struct {
		team
		Members []string `json:"members"`
	}
	teams := []teamView{}
	for _, t := range st.Teams {
		m := members[t.ID]
		if m == nil {
			m = []string{}
		}
		sort.Strings(m)
		teams = append(teams, teamView{t, m})
	}
	deleted := st.Deleted
	if deleted == nil {
		deleted = []deletedUser{}
	}
	s.mu.Lock()
	for i := range deleted {
		n := 0
		for _, j := range s.jobs {
			if j.Owner == deleted[i].Username {
				n++
			}
		}
		deleted[i].Jobs = n
	}
	s.mu.Unlock()
	return map[string]any{"perms": perms, "roles": roles, "teams": teams, "grants": grants, "deleted": deleted}
}

// setGrant changes what one person holds, within what the actor may hand out.
func (s *storeServer) setGrant(actor access, user, legacyRole string, roles, teams []string) (string, int) {
	iamMu.Lock()
	defer iamMu.Unlock()
	st := s.iamLoad()
	old := st.grantOf(user, legacyRole)
	if len(roles) == 0 {
		return "至少给一个角色", 400
	}
	clean := []string{}
	for _, id := range roles {
		r, ok := st.role(id)
		if !ok {
			return "没有这个角色：" + id, 400
		}
		if !contains(clean, id) {
			clean = append(clean, id)
		}
		if !contains(old.Roles, id) {
			if p, ok := within(actor, r.Perms, r.Scope); !ok {
				return escalation(p), 403
			}
		}
	}
	// taking a role away is giving up what it grants, so the same limit applies
	for _, id := range old.Roles {
		if !contains(clean, id) {
			if r, ok := st.role(id); ok {
				if p, ok := within(actor, r.Perms, r.Scope); !ok {
					return escalation(p), 403
				}
			}
		}
	}
	ts := []string{}
	for _, id := range teams {
		ok := false
		for _, t := range st.Teams {
			ok = ok || t.ID == id
		}
		if !ok {
			return "没有这个团队：" + id, 400
		}
		if !contains(ts, id) {
			ts = append(ts, id)
		}
	}
	st.Grants[user] = grant{Roles: clean, Teams: ts}
	if s.keepers(st) == 0 {
		return "这样改之后就没有人能管理用户和角色了，已拒绝", 409
	}
	if err := s.iamSave(st); err != nil {
		return "保存失败", 500
	}
	return "", 200
}

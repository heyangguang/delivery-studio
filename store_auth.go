package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const storeHashIterations = 210000

var labelRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`)

func constantStoreEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
func randomStoreToken(bytes int) string {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// PBKDF2-HMAC-SHA256, one 32-byte output block. Accounts persist salts and
// iteration counts; neither plaintext passwords nor session tokens are saved.
func storePasswordHash(password, salt string, iterations int) string {
	mac := hmac.New(sha256.New, []byte(password))
	mac.Write([]byte(salt))
	mac.Write([]byte{0, 0, 0, 1})
	u := mac.Sum(nil)
	result := append([]byte(nil), u...)
	for i := 1; i < iterations; i++ {
		mac.Reset()
		mac.Write(u)
		u = mac.Sum(nil)
		for j := range result {
			result[j] ^= u[j]
		}
	}
	return hex.EncodeToString(result)
}
func newStoreUser(name, role, password string) (storeUser, error) {
	if !labelRE.MatchString(name) || (role != "admin" && role != "operator") {
		return storeUser{}, errors.New("用户名须小写字母开头，角色为admin或operator")
	}
	if (len(password) < 12 || len(password) > 256) && !(name == "admin" && role == "admin" && password == "admin") {
		return storeUser{}, errors.New("密码长度须为12..256字节")
	}
	u := storeUser{Username: name, Role: role, Salt: randomStoreToken(16), Iterations: storeHashIterations}
	u.PasswordHash = storePasswordHash(password, u.Salt, u.Iterations)
	return u, nil
}
func readStoreUsers(dir string) (map[string]storeUser, error) {
	result := map[string]storeUser{}
	b, err := os.ReadFile(filepath.Join(dir, "users.json"))
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	var users []storeUser
	if err = json.Unmarshal(b, &users); err != nil {
		return nil, err
	}
	for _, u := range users {
		if !labelRE.MatchString(u.Username) || (u.Role != "admin" && u.Role != "operator") || u.Iterations < 100000 || u.Iterations > 1000000 || len(u.PasswordHash) != 64 || len(u.Salt) != 32 {
			return nil, errors.New("用户文件无效")
		}
		if _, ok := result[u.Username]; ok {
			return nil, errors.New("用户文件包含重复用户名")
		}
		result[u.Username] = u
	}
	return result, nil
}
func saveStoreUsers(dir string, users map[string]storeUser) error {
	names := []string{}
	for name := range users {
		names = append(names, name)
	}
	sort.Strings(names)
	values := []storeUser{}
	for _, name := range names {
		values = append(values, users[name])
	}
	return writeJSON(filepath.Join(dir, "users.json"), values)
}
func addStoreUser(dir, name, role, password string) error {
	users, err := readStoreUsers(dir)
	if err != nil {
		return err
	}
	if _, ok := users[name]; ok {
		return errors.New("用户名已存在；不覆盖账户")
	}
	u, err := newStoreUser(name, role, password)
	if err != nil {
		return err
	}
	users[name] = u
	if err = saveStoreUsers(dir, users); err != nil {
		return err
	}
	fmt.Println("账户已创建：", name, "角色：", role, "。服务运行中请使用管理员UI添加其他用户；CLI变更需重启服务加载。")
	return nil
}
func (s *storeServer) reloadUsers() error {
	var users map[string]storeUser
	var err error
	if s.repo != nil {
		users, err = s.repo.users()
	} else {
		users, err = readStoreUsers(s.cfg.DataDir)
	}
	if err != nil {
		return err
	}
	if len(users) == 0 {
		return errors.New("尚无登录账户，先执行store user-add创建管理员")
	}
	s.users = users
	return nil
}

// Sessions outlive a restart of the platform: upgrading it must not sign everyone out. Only session metadata (never the
// signing key or raw JWT token) is kept in a file only the platform can read. The caller holds s.mu.
func (s *storeServer) saveSessions() { s.saveSessionsLocked() }

func (s *storeServer) saveSessionsLocked() {
	if s.cfg.DataDir == "" {
		return
	}
	now := time.Now().UTC()
	keep := map[string]storeSession{}
	for k, v := range s.sessions {
		if now.Before(v.Expires) {
			keep[k] = v
		}
	}
	_ = writeJSON(filepath.Join(s.cfg.DataDir, "sessions.json"), keep)
}

// loadSessions brings back the sessions saved before a restart that have not expired, and records any that already expired.
func (s *storeServer) loadSessions() {
	var saved map[string]storeSession
	if s.repo != nil {
		var err error
		saved, err = s.repo.sessionsActive()
		if err != nil {
			return
		}
	} else {
		b, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "sessions.json"))
		if err != nil {
			return
		}
		if json.Unmarshal(b, &saved) != nil {
			return
		}
	}
	now := time.Now().UTC()
	var expired []storeSession
	s.mu.Lock()
	for k, v := range saved {
		if len(k) == 0 || len(k) > 64 || v.User == "" {
			continue
		}
		if v.ID == "" {
			v.ID = k
		}
		v = normalizeSession(v)
		if !now.Before(v.Expires) {
			expired = append(expired, closeSessionObject(v, "expired", v.Expires, "服务重启检查到期失效"))
			continue
		}
		s.sessions[k] = v
	}
	if len(expired) > 0 && s.repo == nil {
		s.saveSessionsLocked()
	}
	s.mu.Unlock()
	if len(expired) > 0 {
		s.finalizeClosedSessions("", expired)
	}
}

func (s *storeServer) session(r *http.Request) (storeSession, bool) {
	sess, _, ok := s.authenticateRequest(r)
	return sess, ok
}
func (s *storeServer) login(w http.ResponseWriter, r *http.Request) {
	host := clientIP(r)
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
		TTLHours int    `json:"ttl_hours,omitempty"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		s.fail(w, 400, "请输入用户名和密码")
		return
	}
	ttl, ttlErr := allowedSessionTTL(input.TTLHours)
	if ttlErr != nil {
		s.fail(w, 400, ttlErr.Error())
		return
	}
	key := host + "/" + input.Username
	s.mu.Lock()
	attempt := s.attempts[key]
	if time.Since(attempt.Since) > time.Minute {
		attempt = storeAttempt{Since: time.Now()}
	}
	if attempt.Count >= 10 {
		s.mu.Unlock()
		s.auditLoginEvent(r, "login-failed", input.Username, "", 0, "denied", "登录尝试过多，触发速率限制（429）")
		s.fail(w, 429, "登录尝试过多，请稍后重试")
		return
	}
	attempt.Count++
	s.attempts[key] = attempt
	if len(s.attempts) > 4096 {
		for k, value := range s.attempts {
			if time.Since(value.Since) > time.Minute {
				delete(s.attempts, k)
			}
		}
	}
	s.mu.Unlock()
	s.mu.Lock()
	user, ok := s.users[input.Username]
	s.mu.Unlock()
	if !ok {
		user = storeUser{Salt: "invalid-account-placeholder-salt", Iterations: storeHashIterations}
	}
	got := storePasswordHash(input.Password, user.Salt, user.Iterations)
	if !ok || !constantStoreEqual(got, user.PasswordHash) {
		reason := "密码错误"
		if !ok {
			reason = "账户不存在"
		}
		s.auditLoginEvent(r, "login-failed", input.Username, "", 0, "failed", reason)
		s.fail(w, 401, "用户名或密码错误")
		return
	}
	if user.Disabled {
		s.auditLoginEvent(r, "login-failed", input.Username, "", 0, "denied", "账户已停用")
		s.fail(w, 403, "这个账户已停用，请联系管理员")
		return
	}
	s.reapExpiredSessions()
	now := time.Now().UTC()
	exp := now.Add(ttl)
	sid := randomStoreToken(16)
	jti := randomStoreToken(16)
	token, err := s.signJWT(jwtClaims{
		Issuer:    jwtIssuer,
		Subject:   user.Username,
		Role:      user.Role,
		SessionID: sid,
		JWTID:     jti,
		IssuedAt:  now.Unix(),
		ExpiresAt: exp.Unix(),
	})
	if err != nil {
		s.fail(w, 500, "签发访问令牌失败")
		return
	}
	session := storeSession{
		ID:           sid,
		User:         user.Username,
		Role:         user.Role,
		CSRF:         randomStoreToken(32),
		CreatedAt:    now,
		LastActiveAt: now,
		Expires:      exp,
		IP:           host,
		Agent:        truncRunes(r.UserAgent(), 200),
		AuthType:     "jwt",
		Requests:     1,
	}
	s.mu.Lock()
	delete(s.attempts, key)
	s.sessions[sid] = session
	if s.repo == nil {
		s.saveSessionsLocked()
	}
	s.mu.Unlock()
	s.persistActiveSessionPG(session)

	secureCookie := len(s.cfg.PublicURL) > 5 && s.cfg.PublicURL[:5] == "https"
	if s.cfg.devMultiHost() {
		secureCookie = r.TLS != nil
	}
	maxAge := int(ttl.Seconds())
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: token, Path: "/", HttpOnly: true, Secure: secureCookie, SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
	s.auditLoginEvent(r, "login", user.Username, sid, 0, "ok", fmt.Sprintf("JWT Bearer 登录 · 有效期 %d 小时", int(ttl.Hours())))
	out := s.sessionView(session)
	out["access_token"] = token
	out["token_type"] = "Bearer"
	out["expires_in"] = int64(maxAge)
	s.writeJSON(w, 200, out)
}
func (s *storeServer) logout(w http.ResponseWriter, r *http.Request, session storeSession) {
	now := time.Now().UTC()
	s.mu.Lock()
	closed, ok := s.closeSessionLocked(session.ID, "logout", now, "用户主动退出登录")
	if ok && s.repo == nil {
		s.saveSessionsLocked()
	}
	s.mu.Unlock()
	if ok {
		s.writeSessionHistory(closed)
		dur := sessionDurationSeconds(closed, now)
		auditSetDuration(r, dur)
		s.auditReq(r, "logout", session.User, fmt.Sprintf("%s（在线 %d 秒）", session.ID, dur))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: "", Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	s.writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *storeServer) handleUsers(w http.ResponseWriter, r *http.Request, session storeSession) {
	if r.Method == "GET" {
		// Admins see how much each account uses the platform, never the deliveries themselves.
		type usage struct {
			Total, Active int
			Last          string
		}
		s.mu.Lock()
		stats := map[string]*usage{}
		for _, j := range s.jobs {
			u := stats[j.Owner]
			if u == nil {
				u = &usage{}
				stats[j.Owner] = u
			}
			u.Total++
			if j.State == "queued" || j.State == "running" {
				u.Active++
			}
			if j.Created > u.Last {
				u.Last = j.Created
			}
		}
		rawUsers := make([]storeUser, 0, len(s.users))
		for _, u := range s.users {
			rawUsers = append(rawUsers, u)
		}
		s.mu.Unlock()
		iamMu.Lock()
		st := s.iamLoad()
		iamMu.Unlock()
		users := []map[string]any{}
		for _, u := range rawUsers {
			g := st.grantOf(u.Username, u.Role)
			entry := map[string]any{"username": u.Username, "role": u.Role, "roles": g.Roles, "teams": nz(g.Teams), "deliveries": 0, "active": 0, "disabled": u.Disabled}
			if st := stats[u.Username]; st != nil {
				entry["deliveries"], entry["active"], entry["last_delivery"] = st.Total, st.Active, st.Last
			}
			users = append(users, entry)
		}
		s.writeJSON(w, 200, users)
		return
	}
	if r.Method != "POST" {
		s.fail(w, 405, "方法不支持")
		return
	}
	var input struct {
		Username, Role, Password string
		Roles                    []string `json:"roles"`
		Teams                    []string `json:"teams"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		s.fail(w, 400, "用户名或密码填得不对，请检查后再提交")
		return
	}
	if len(input.Roles) == 0 {
		input.Roles = []string{map[bool]string{true: "sysadmin", false: "engineer"}[input.Role == "admin"]}
	}
	input.Role = map[bool]string{true: "admin", false: "operator"}[contains(input.Roles, "sysadmin")]
	actor := s.accessOf(session.User)
	iamMu.Lock()
	st := s.iamLoad()
	iamMu.Unlock()
	for _, id := range input.Roles {
		rl, ok := st.role(id)
		if !ok {
			s.fail(w, 400, "没有这个角色："+id)
			return
		}
		if p, ok := within(actor, rl.Perms, rl.Scope); !ok {
			s.fail(w, 403, escalation(p))
			return
		}
	}
	if s.nameRetired(input.Username) {
		s.fail(w, 409, "这个用户名属于一个已删除的账户，请换一个")
		return
	}
	u, err := newStoreUser(input.Username, input.Role, input.Password)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	s.mu.Lock()
	if _, ok := s.users[u.Username]; ok {
		s.mu.Unlock()
		s.fail(w, 409, "用户名已存在")
		return
	}
	s.users[u.Username] = u
	if s.repo != nil {
		err = s.repo.addUser(u)
	} else {
		err = saveStoreUsers(s.cfg.DataDir, s.users)
	}
	if err != nil {
		delete(s.users, u.Username)
		s.mu.Unlock()
		s.fail(w, 500, "账户保存失败，请稍后重试")
		return
	}
	s.mu.Unlock()
	if msg, code := s.setGrant(actor, u.Username, u.Role, input.Roles, input.Teams); code != 200 {
		s.fail(w, code, "账户已创建，但角色没有保存："+msg)
		return
	}
	s.auditReq(r, "user-add", session.User, u.Username)
	s.writeJSON(w, 201, map[string]string{"username": u.Username, "role": u.Role})
}

// handleUser changes one account: its role, its password (a new one is generated and shown once), or whether it may
// sign in. An administrator cannot lock everyone out: the last enabled administrator stays one.
func (s *storeServer) handleUser(w http.ResponseWriter, r *http.Request, session storeSession, name string, rest []string) {
	s.mu.Lock()
	u, ok := s.users[name]
	s.mu.Unlock()
	if !ok {
		s.fail(w, 404, "账户不存在")
		return
	}
	if len(rest) == 1 && rest[0] == "activity" && r.Method == "GET" {
		s.userActivity(w, u)
		return
	}
	if len(rest) == 1 && rest[0] == "quota" && r.Method == "PUT" {
		s.setUserQuota(w, r, session, name)
		return
	}
	if len(rest) == 0 && r.Method == "DELETE" {
		s.deleteUser(w, r, session, name)
		return
	}
	if len(rest) == 1 && rest[0] == "grant" && r.Method == "PUT" {
		var in struct {
			Roles []string `json:"roles"`
			Teams []string `json:"teams"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		if msg, code := s.setGrant(s.accessOf(session.User), name, u.Role, in.Roles, in.Teams); code != 200 {
			s.fail(w, code, msg)
			return
		}
		s.auditReq(r, "user-grant", session.User, name+" "+strings.Join(in.Roles, ","))
		s.writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	if len(rest) != 0 || r.Method != "PATCH" {
		s.fail(w, 405, "方法不支持")
		return
	}
	var in struct {
		Role          *string `json:"role"`
		Disabled      *bool   `json:"disabled"`
		ResetPassword bool    `json:"reset_password"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	var closed []storeSession
	defer func() {
		if len(closed) > 0 {
			s.finalizeClosedSessions(session.User, closed)
		}
	}()
	s.mu.Lock()
	defer s.mu.Unlock()
	u = s.users[name]
	next := u
	action := ""
	if in.Role != nil {
		if *in.Role != "admin" && *in.Role != "operator" {
			s.fail(w, 400, "角色只能是管理员或交付使用者")
			return
		}
		s.mu.Unlock()
		msg, code := s.setGrant(s.accessOf(session.User), name, u.Role, []string{map[bool]string{true: "sysadmin", false: "engineer"}[*in.Role == "admin"]}, s.accessOf(name).Teams)
		s.mu.Lock()
		if code != 200 {
			s.fail(w, code, msg)
			return
		}
		next.Role, action = *in.Role, "user-role"
	}
	if in.Disabled != nil {
		if *in.Disabled && name == session.User {
			s.fail(w, 409, "不能停用自己")
			return
		}
		next.Disabled, action = *in.Disabled, map[bool]string{true: "user-disable", false: "user-enable"}[*in.Disabled]
	}
	// the platform keeps at least one person who can sign in and manage people and roles
	if next.Disabled && !u.Disabled {
		s.mu.Unlock()
		iamMu.Lock()
		st := s.iamLoad()
		iamMu.Unlock()
		s.mu.Lock()
		u = s.users[name]
		a := st.accessFrom(u)
		if a.can("iam.user") && a.can("iam.role") {
			n := 0
			for _, x := range s.users {
				if x.Username != name {
					if b := st.accessFrom(x); b.can("iam.user") && b.can("iam.role") {
						n++
					}
				}
			}
			if n == 0 {
				s.fail(w, 409, "这是唯一能管理用户和角色的人，不能停用")
				return
			}
		}
	}
	password := ""
	if in.ResetPassword {
		password = randomStoreToken(9) + "Aa1"
		next.Salt = randomStoreToken(16)
		next.Iterations = storeHashIterations
		next.PasswordHash = storePasswordHash(password, next.Salt, next.Iterations)
		action = "user-password"
	}
	if action == "" {
		s.fail(w, 400, "没有要改的内容")
		return
	}
	var err error
	s.users[name] = next
	if s.repo != nil {
		err = s.repo.updateUser(next)
	} else {
		err = saveStoreUsers(s.cfg.DataDir, s.users)
	}
	if err != nil {
		s.users[name] = u
		s.fail(w, 500, "账户保存失败，请稍后重试")
		return
	}
	// a changed password, role or a disabled account ends that person's sessions
	reason := "revoked"
	detail := "管理员修改账户权限或重置密码"
	if in.Disabled != nil && *in.Disabled {
		reason = "disabled"
		detail = "管理员停用账户"
	}
	except := ""
	if name == session.User {
		except = session.ID
	}
	closed = s.revokeUserSessionsLocked(name, except, reason, detail)
	go s.auditReq(r, action, session.User, name)
	out := map[string]any{"username": name, "role": next.Role, "disabled": next.Disabled}
	if password != "" {
		out["password"] = password
	}
	s.writeJSON(w, 200, out)
}

// userActivity is what an account did recently, and how much it used the assistant this month.
func (s *storeServer) userActivity(w http.ResponseWriter, u storeUser) {
	to := time.Now().UTC().Add(time.Minute)
	events := []auditEvent{}
	for _, e := range s.auditEvents(to.AddDate(0, 0, -30), to) {
		if e.User == u.Username {
			events = append(events, e)
			if len(events) >= 40 {
				break
			}
		}
	}
	now := time.Now().UTC()
	var ai usageAgg
	ps := s.loadPriceSettings()
	for _, x := range s.usageBetween(time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC), to) {
		if x.User == u.Username {
			x.Cost = ps.convert(x.Cost, x.Currency)
			ai.add(x)
		}
	}
	s.mu.Lock()
	jobs := []map[string]any{}
	for _, j := range s.jobs {
		if j.Owner == u.Username {
			jobs = append(jobs, map[string]any{"id": j.ID, "cluster_id": j.ClusterID, "app_name": j.AppName, "version": j.Version, "state": j.State, "outcome": j.Outcome, "created": j.Created, "seq": j.Seq})
		}
	}
	s.mu.Unlock()
	sort.Slice(jobs, func(a, b int) bool { return jobs[a]["created"].(string) > jobs[b]["created"].(string) })
	if len(jobs) > 12 {
		jobs = jobs[:12]
	}
	sst := s.storageSettings()
	s.writeJSON(w, 200, map[string]any{"events": events, "ai": ai, "currency": ps.Display, "jobs": jobs, "storage": map[string]any{"used": s.userUsage(u.Username), "quota": sst.quotaOf(u.Username), "custom": hasKey(sst.Overrides, u.Username)}})
}

func hasKey(m map[string]float64, k string) bool { _, ok := m[k]; return ok }

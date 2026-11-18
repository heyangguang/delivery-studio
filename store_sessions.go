package main

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	sessionCookieName = "middleware_session"
	jwtIssuer         = "middleware-hub"
)

type sessionCtxKey struct{}

type jwtHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}

type jwtClaims struct {
	Issuer    string `json:"iss"`
	Subject   string `json:"sub"`
	Role      string `json:"role"`
	SessionID string `json:"sid"`
	JWTID     string `json:"jti"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

func (s *storeServer) signingKey() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.authKey) == 32 {
		key := make([]byte, 32)
		copy(key, s.authKey)
		return key, nil
	}
	if err := s.loadOrCreateAuthKeyLocked(); err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	copy(key, s.authKey)
	return key, nil
}

func (s *storeServer) loadOrCreateAuthKeyLocked() error {
	if s.cfg.DataDir != "" {
		p := filepath.Join(s.cfg.DataDir, "auth_signing.key")
		if b, err := os.ReadFile(p); err == nil && len(b) == 32 {
			s.authKey = b
			return nil
		}
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	if s.cfg.DataDir != "" {
		if err := os.MkdirAll(s.cfg.DataDir, 0o700); err != nil {
			return err
		}
		p := filepath.Join(s.cfg.DataDir, "auth_signing.key")
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, key, 0o600); err != nil {
			return err
		}
		if err := os.Rename(tmp, p); err != nil {
			_ = os.Remove(tmp)
			return err
		}
	}
	s.authKey = key
	return nil
}

func (s *storeServer) signJWT(c jwtClaims) (string, error) {
	key, err := s.signingKey()
	if err != nil {
		return "", err
	}
	hb, err := json.Marshal(jwtHeader{Alg: "HS256", Typ: "JWT"})
	if err != nil {
		return "", err
	}
	pb, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(pb)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signingInput))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return signingInput + "." + sig, nil
}

func (s *storeServer) verifyJWT(token string) (jwtClaims, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return jwtClaims{}, false
	}
	key, err := s.signingKey()
	if err != nil {
		return jwtClaims{}, false
	}
	signingInput := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signingInput))
	expectedSig := mac.Sum(nil)
	gotSig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(expectedSig, gotSig) {
		return jwtClaims{}, false
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return jwtClaims{}, false
	}
	var hdr jwtHeader
	if json.Unmarshal(hb, &hdr) != nil || hdr.Alg != "HS256" || (hdr.Typ != "" && !strings.EqualFold(hdr.Typ, "JWT")) {
		return jwtClaims{}, false
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return jwtClaims{}, false
	}
	var claims jwtClaims
	if json.Unmarshal(pb, &claims) != nil {
		return jwtClaims{}, false
	}
	if claims.Issuer != jwtIssuer || claims.Subject == "" || claims.SessionID == "" || claims.ExpiresAt <= 0 {
		return jwtClaims{}, false
	}
	return claims, true
}

func bearerTokenFromHeader(r *http.Request) (string, bool) {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if auth == "" {
		return "", false
	}
	if len(auth) < 7 || !strings.EqualFold(auth[:7], "Bearer ") {
		return "", true
	}
	return strings.TrimSpace(auth[7:]), true
}

func normalizeSession(sess storeSession) storeSession {
	if sess.CreatedAt.IsZero() {
		if !sess.Expires.IsZero() {
			sess.CreatedAt = sess.Expires.Add(-8 * time.Hour)
		} else {
			sess.CreatedAt = time.Now().UTC()
		}
	}
	if sess.LastActiveAt.IsZero() {
		sess.LastActiveAt = sess.CreatedAt
	}
	if sess.AuthType == "" {
		sess.AuthType = "jwt"
	}
	if sess.ActiveMs == 0 && sess.ActiveSeconds > 0 {
		sess.ActiveMs = sess.ActiveSeconds * 1000
	}
	return sess
}

func sessionDurationSeconds(sess storeSession, now time.Time) int64 {
	sess = normalizeSession(sess)
	end := sess.EndedAt
	if end.IsZero() {
		end = now
		if !sess.Expires.IsZero() && end.After(sess.Expires) {
			end = sess.Expires
		}
	}
	d := end.Sub(sess.CreatedAt)
	if d < 0 {
		return 0
	}
	return int64(d.Seconds())
}

func touchSessionLocked(sess storeSession, now time.Time) storeSession {
	sess = normalizeSession(sess)
	dt := now.Sub(sess.LastActiveAt)
	if dt > 0 {
		if dt <= 5*time.Minute {
			sess.ActiveMs += dt.Milliseconds()
		} else {
			// Resuming after an idle break credits up to 60s of active engagement rather than the whole idle gap.
			sess.ActiveMs += 60_000
		}
		sess.ActiveSeconds = sess.ActiveMs / 1000
		sess.LastActiveAt = now
	}
	sess.Requests++
	return sess
}

func closeSessionObject(sess storeSession, reason string, endedAt time.Time, detail string) storeSession {
	sess = normalizeSession(sess)
	if endedAt.IsZero() {
		endedAt = time.Now().UTC()
	}
	if !sess.Expires.IsZero() && endedAt.After(sess.Expires) {
		endedAt = sess.Expires
	}
	if endedAt.Before(sess.CreatedAt) {
		endedAt = sess.CreatedAt
	}
	if reason == "logout" || reason == "revoked" {
		dt := endedAt.Sub(sess.LastActiveAt)
		if dt > 0 {
			if dt <= 5*time.Minute {
				sess.ActiveMs += dt.Milliseconds()
			} else {
				sess.ActiveMs += 60_000
			}
			sess.ActiveSeconds = sess.ActiveMs / 1000
			sess.LastActiveAt = endedAt
		}
	}
	sess.EndedAt = endedAt.UTC()
	sess.EndReason = reason
	sess.EndDetail = detail
	return sess
}

func (s *storeServer) closeSessionLocked(sid, reason string, endedAt time.Time, detail string) (storeSession, bool) {
	sess, ok := s.sessions[sid]
	if !ok {
		return storeSession{}, false
	}
	delete(s.sessions, sid)
	return closeSessionObject(sess, reason, endedAt, detail), true
}

func (s *storeServer) revokeUserSessionsLocked(targetUser, exceptSID, reason, detail string) []storeSession {
	now := time.Now().UTC()
	var closed []storeSession
	for k, v := range s.sessions {
		if v.User == targetUser && (exceptSID == "" || k != exceptSID) {
			delete(s.sessions, k)
			closed = append(closed, closeSessionObject(v, reason, now, detail))
		}
	}
	if len(closed) > 0 {
		s.saveSessionsLocked()
	}
	return closed
}

func (s *storeServer) finalizeClosedSessions(actor string, closed []storeSession) {
	if len(closed) == 0 {
		return
	}
	now := time.Now().UTC()
	for _, cs := range closed {
		s.writeSessionHistory(cs)
		dur := sessionDurationSeconds(cs, now)
		if cs.EndReason == "expired" {
			s.writeAudit(auditEvent{
				Time:        cs.EndedAt.UTC().Format(time.RFC3339Nano),
				Action:      "session-expired",
				User:        cs.User,
				Job:         cs.ID,
				IP:          cs.IP,
				Agent:       cs.Agent,
				Result:      "ok",
				SessionID:   cs.ID,
				DurationSec: dur,
				Resource:    &auditResource{Type: "会话审计", ID: cs.ID, Name: cs.User},
				Request:     fmt.Sprintf("会话自然到期失效 · 在线 %d 秒 · 请求 %d 次", dur, cs.Requests),
			})
		} else {
			who := actor
			if who == "" {
				who = cs.User
			}
			targetDesc := cs.User
			if cs.EndDetail != "" {
				targetDesc += " (" + cs.EndDetail + ")"
			}
			s.writeAudit(auditEvent{
				Time:        now.Format(time.RFC3339Nano),
				Action:      "session-revoke",
				User:        who,
				Job:         cs.User,
				IP:          cs.IP,
				Agent:       cs.Agent,
				Result:      "ok",
				SessionID:   cs.ID,
				DurationSec: dur,
				Resource:    &auditResource{Type: "会话审计", ID: cs.ID, Name: targetDesc},
				Request:     fmt.Sprintf("终止用户 %s 会话 · %s · 在线 %d 秒", cs.User, cs.EndDetail, dur),
			})
		}
	}
}

func (s *storeServer) reapExpiredSessions() {
	now := time.Now().UTC()
	s.mu.Lock()
	var expired []storeSession
	for k, v := range s.sessions {
		if !now.Before(v.Expires) {
			delete(s.sessions, k)
			expired = append(expired, closeSessionObject(v, "expired", v.Expires, "到期自动失效"))
		}
	}
	if len(expired) > 0 {
		s.saveSessionsLocked()
	}
	s.mu.Unlock()
	if len(expired) > 0 {
		s.finalizeClosedSessions("", expired)
	}
}

func (s *storeServer) writeSessionHistory(sess storeSession) {
	if s.repo != nil {
		if err := s.repo.saveSession(sess, "closed"); err != nil {
			fmt.Fprintln(os.Stderr, "会话历史写入失败:", err)
		}
		return
	}
	if s.cfg.DataDir == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := os.OpenFile(filepath.Join(s.cfg.DataDir, "session_history.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_ = json.NewEncoder(f).Encode(sess)
}

func (s *storeServer) readSessionHistory(from, to time.Time) []storeSession {
	if s.repo != nil {
		out, _ := s.repo.sessionsClosed(from, to)
		return out
	}
	if s.cfg.DataDir == "" {
		return nil
	}
	s.mu.Lock()
	f, err := os.Open(filepath.Join(s.cfg.DataDir, "session_history.jsonl"))
	if err != nil {
		s.mu.Unlock()
		return nil
	}
	defer f.Close()
	var out []storeSession
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 32<<10), 1<<20)
	for sc.Scan() {
		var sess storeSession
		if json.Unmarshal(sc.Bytes(), &sess) != nil {
			continue
		}
		sess = normalizeSession(sess)
		ref := sess.EndedAt
		if ref.IsZero() {
			ref = sess.CreatedAt
		}
		// Include closed sessions that overlap the queried window.
		if !ref.Before(from) && sess.CreatedAt.Before(to) {
			out = append(out, sess)
		}
	}
	s.mu.Unlock()
	return out
}

func (s *storeServer) flushSessions() {
	s.mu.Lock()
	if s.repo == nil {
		s.saveSessionsLocked()
		s.mu.Unlock()
		return
	}
	active := make([]storeSession, 0, len(s.sessions))
	now := time.Now().UTC()
	for _, v := range s.sessions {
		if now.Before(v.Expires) {
			active = append(active, v)
		}
	}
	s.mu.Unlock()
	for _, v := range active {
		_ = s.repo.saveSession(v, "active")
	}
}

var pgTouchSem = make(chan struct{}, 2)

func (s *storeServer) persistActiveSessionPG(sess storeSession) {
	if s.repo != nil {
		_ = s.repo.saveSession(sess, "active")
	}
}

func (s *storeServer) persistActiveSessionPGAsync(sess storeSession) {
	if s.repo == nil {
		return
	}
	select {
	case pgTouchSem <- struct{}{}:
		go func() {
			defer func() { <-pgTouchSem }()
			_ = s.repo.saveSessionTimeout(sess, "active", 2*time.Second)
		}()
	default:
	}
}

func (s *storeServer) authenticateRequest(r *http.Request) (storeSession, bool, bool) {
	if token, hasBearer := bearerTokenFromHeader(r); hasBearer {
		if token == "" {
			return storeSession{}, true, false
		}
		claims, ok := s.verifyJWT(token)
		if !ok {
			return storeSession{}, true, false
		}
		return s.lookupAndTouchSession(claims.SessionID, claims)
	}
	c, err := r.Cookie(sessionCookieName)
	if err != nil || c.Value == "" {
		return storeSession{}, false, false
	}
	claims, ok := s.verifyJWT(c.Value)
	if !ok {
		return storeSession{}, false, false
	}
	sess, _, valid := s.lookupAndTouchSession(claims.SessionID, claims)
	return sess, false, valid
}

func (s *storeServer) lookupAndTouchSession(sid string, claims jwtClaims) (storeSession, bool, bool) {
	now := time.Now().UTC()
	s.mu.Lock()
	sess, ok := s.sessions[sid]
	if !ok {
		s.mu.Unlock()
		return storeSession{}, true, false
	}
	if sess.User != claims.Subject || !now.Before(sess.Expires) || now.Unix() >= claims.ExpiresAt {
		closed, _ := s.closeSessionLocked(sid, "expired", sess.Expires, "到期自动失效")
		s.saveSessionsLocked()
		s.mu.Unlock()
		if closed.ID != "" {
			s.finalizeClosedSessions("", []storeSession{closed})
		}
		return storeSession{}, true, false
	}
	if u, exists := s.users[sess.User]; !exists || u.Disabled {
		reason := map[bool]string{true: "disabled", false: "deleted"}[exists]
		detail := map[bool]string{true: "账户已停用", false: "账户不存在"}[exists]
		closed, _ := s.closeSessionLocked(sid, reason, now, detail)
		s.saveSessionsLocked()
		s.mu.Unlock()
		if closed.ID != "" {
			s.finalizeClosedSessions("", []storeSession{closed})
		}
		return storeSession{}, true, false
	}
	sess = touchSessionLocked(sess, now)
	s.sessions[sid] = sess
	shouldSave := now.Sub(s.lastSessionSave) >= 15*time.Second
	if shouldSave {
		s.lastSessionSave = now
		if s.repo == nil {
			s.saveSessionsLocked()
		}
	}
	s.mu.Unlock()
	if shouldSave && s.repo != nil {
		s.persistActiveSessionPGAsync(sess)
	}
	return sess, true, true
}

func withSessionContext(r *http.Request, sess storeSession) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), sessionCtxKey{}, sess))
}

func sessionFromContext(r *http.Request) (storeSession, bool) {
	sess, ok := r.Context().Value(sessionCtxKey{}).(storeSession)
	return sess, ok && sess.ID != ""
}

func (s *storeServer) auditLoginEvent(r *http.Request, action, user, sid string, dur int64, result, detail string) {
	e := auditEvent{
		Time:        time.Now().UTC().Format(time.RFC3339Nano),
		Action:      action,
		User:        user,
		Job:         sid,
		IP:          clientIP(r),
		Agent:       truncRunes(r.UserAgent(), 200),
		Method:      r.Method,
		Path:        r.URL.Path,
		SessionID:   sid,
		DurationSec: dur,
		Result:      result,
		Resource:    &auditResource{Type: "登录", ID: sid, Name: user},
		Request:     detail,
	}
	if result != "ok" {
		e.Error = detail
	}
	s.writeAudit(e)
}

func (s *storeServer) handleSessionHeartbeat(w http.ResponseWriter, r *http.Request, session storeSession) {
	if r.Method != "POST" {
		s.fail(w, 405, "方法不支持")
		return
	}
	now := time.Now().UTC()
	s.writeJSON(w, 200, map[string]any{
		"ok":               true,
		"session_id":       session.ID,
		"duration_seconds": sessionDurationSeconds(session, now),
		"active_seconds":   session.ActiveSeconds,
		"requests":         session.Requests,
		"expires_at":       session.Expires.UTC().Format(time.RFC3339),
		"expires_in":       max(int64(time.Until(session.Expires).Seconds()), 0),
	})
}

type auditSessionRow struct {
	ID              string `json:"id"`
	User            string `json:"user"`
	Role            string `json:"role"`
	IP              string `json:"ip,omitempty"`
	Agent           string `json:"agent,omitempty"`
	AuthType        string `json:"auth_type"`
	Status          string `json:"status"` // active | closed
	EndReason       string `json:"end_reason"`
	EndDetail       string `json:"end_detail,omitempty"`
	CreatedAt       string `json:"created_at"`
	LastActiveAt    string `json:"last_active_at"`
	ExpiresAt       string `json:"expires_at"`
	EndedAt         string `json:"ended_at,omitempty"`
	DurationSeconds int64  `json:"duration_seconds"`
	ActiveSeconds   int64  `json:"active_seconds"`
	Requests        int64  `json:"requests"`
	Current         bool   `json:"current,omitempty"`
}

type auditSessionUserSummary struct {
	User                 string `json:"user"`
	Role                 string `json:"role"`
	Online               bool   `json:"online"`
	ActiveSessions       int    `json:"active_sessions"`
	TotalSessions        int    `json:"total_sessions"`
	TotalDurationSeconds int64  `json:"total_duration_seconds"`
	TotalActiveSeconds   int64  `json:"total_active_seconds"`
	LoginCount           int    `json:"login_count"`
	FailedLoginCount     int    `json:"failed_login_count"`
	LastLoginAt          string `json:"last_login_at,omitempty"`
	LastActiveAt         string `json:"last_active_at,omitempty"`
	LastIP               string `json:"last_ip,omitempty"`
}

func toAuditSessionRow(sess storeSession, active bool, currentSID string, now time.Time) auditSessionRow {
	sess = normalizeSession(sess)
	status := "closed"
	reason := sess.EndReason
	endedAt := ""
	if active {
		status = "active"
		reason = "active"
	} else {
		if reason == "" {
			reason = "closed"
		}
		if !sess.EndedAt.IsZero() {
			endedAt = sess.EndedAt.UTC().Format(time.RFC3339)
		}
	}
	dur := sessionDurationSeconds(sess, now)
	act := sess.ActiveSeconds
	if act > dur {
		act = dur
	}
	if dur > 0 && act == 0 && sess.Requests > 0 {
		act = min(dur, sess.Requests)
	}
	return auditSessionRow{
		ID:              sess.ID,
		User:            sess.User,
		Role:            sess.Role,
		IP:              sess.IP,
		Agent:           sess.Agent,
		AuthType:        sess.AuthType,
		Status:          status,
		EndReason:       reason,
		EndDetail:       sess.EndDetail,
		CreatedAt:       sess.CreatedAt.UTC().Format(time.RFC3339),
		LastActiveAt:    sess.LastActiveAt.UTC().Format(time.RFC3339),
		ExpiresAt:       sess.Expires.UTC().Format(time.RFC3339),
		EndedAt:         endedAt,
		DurationSeconds: dur,
		ActiveSeconds:   act,
		Requests:        sess.Requests,
		Current:         active && sess.ID == currentSID,
	}
}

func (s *storeServer) handleAuditSessions(w http.ResponseWriter, r *http.Request, session storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/audit/sessions"), "/")
	if r.Method == "DELETE" && rest != "" && !strings.Contains(rest, "/") {
		if !s.need(w, session.User, "iam.user") {
			return
		}
		s.revokeSessionByID(w, r, session, rest, false)
		return
	}
	if r.Method != "GET" {
		s.fail(w, 405, "方法不支持")
		return
	}
	if !s.need(w, session.User, "audit.view") {
		return
	}
	s.reapExpiredSessions()
	q := r.URL.Query()
	to := time.Now().UTC().Add(time.Minute)
	from := to.AddDate(0, 0, -7)
	if t, err := time.Parse(time.RFC3339, q.Get("from")); err == nil {
		from = t.UTC()
	}
	if t, err := time.Parse(time.RFC3339, q.Get("to")); err == nil {
		to = t.UTC()
	}
	now := time.Now().UTC()

	s.mu.Lock()
	activeList := make([]storeSession, 0, len(s.sessions))
	for _, v := range s.sessions {
		if now.Before(v.Expires) {
			activeList = append(activeList, v)
		}
	}
	userRoles := make(map[string]string, len(s.users))
	for name, u := range s.users {
		userRoles[name] = u.Role
	}
	s.mu.Unlock()

	closedList := s.readSessionHistory(from, to)
	allRows := make([]auditSessionRow, 0, len(activeList)+len(closedList))
	seenID := map[string]bool{}
	for _, v := range activeList {
		row := toAuditSessionRow(v, true, session.ID, now)
		seenID[v.ID] = true
		if !v.CreatedAt.After(to) {
			allRows = append(allRows, row)
		}
	}
	for _, v := range closedList {
		if seenID[v.ID] {
			continue
		}
		seenID[v.ID] = true
		allRows = append(allRows, toAuditSessionRow(v, false, session.ID, now))
	}
	sort.Slice(allRows, func(i, j int) bool {
		if allRows[i].Status != allRows[j].Status {
			return allRows[i].Status == "active"
		}
		return allRows[i].CreatedAt > allRows[j].CreatedAt
	})

	failedByUser := map[string]int{}
	events := s.auditEvents(from, to)
	var failedLogins int
	for _, e := range events {
		if e.Action == "login-failed" {
			failedLogins++
			if e.User != "" {
				failedByUser[e.User]++
			}
		}
	}

	userFilter := q.Get("user")
	statusFilter := q.Get("status")
	textFilter := strings.ToLower(strings.TrimSpace(q.Get("q")))

	summaryMap := map[string]*auditSessionUserSummary{}
	usersSet := map[string]bool{}
	var filtered []auditSessionRow
	onlineUsersSet := map[string]bool{}
	var totalDur, maxDur int64
	activeCount := 0

	ensureUser := func(name, role string) *auditSessionUserSummary {
		if name == "" {
			return nil
		}
		u := summaryMap[name]
		if u == nil {
			if role == "" {
				role = userRoles[name]
			}
			u = &auditSessionUserSummary{User: name, Role: role}
			summaryMap[name] = u
		}
		return u
	}

	for _, row := range allRows {
		usersSet[row.User] = true
		us := ensureUser(row.User, row.Role)
		us.TotalSessions++
		us.LoginCount++
		us.TotalDurationSeconds += row.DurationSeconds
		us.TotalActiveSeconds += row.ActiveSeconds
		if row.Status == "active" {
			us.Online = true
			us.ActiveSessions++
			onlineUsersSet[row.User] = true
			activeCount++
		}
		if us.LastLoginAt == "" || row.CreatedAt > us.LastLoginAt {
			us.LastLoginAt = row.CreatedAt
			us.LastIP = row.IP
		}
		if us.LastActiveAt == "" || row.LastActiveAt > us.LastActiveAt {
			us.LastActiveAt = row.LastActiveAt
		}
		totalDur += row.DurationSeconds
		if row.DurationSeconds > maxDur {
			maxDur = row.DurationSeconds
		}

		if userFilter != "" && row.User != userFilter {
			continue
		}
		if statusFilter != "" {
			if statusFilter == "active" && row.Status != "active" {
				continue
			} else if statusFilter == "closed" && row.Status != "closed" {
				continue
			} else if statusFilter != "active" && statusFilter != "closed" && row.EndReason != statusFilter {
				continue
			}
		}
		if textFilter != "" {
			hay := strings.ToLower(row.ID + " " + row.User + " " + row.IP + " " + row.Agent + " " + row.EndReason + " " + row.EndDetail)
			if !strings.Contains(hay, textFilter) {
				continue
			}
		}
		filtered = append(filtered, row)
	}
	for uName, cnt := range failedByUser {
		usersSet[uName] = true
		us := ensureUser(uName, "")
		if us != nil {
			us.FailedLoginCount = cnt
		}
	}

	byUser := make([]auditSessionUserSummary, 0, len(summaryMap))
	for _, v := range summaryMap {
		if userFilter != "" && v.User != userFilter {
			continue
		}
		byUser = append(byUser, *v)
	}
	sort.Slice(byUser, func(i, j int) bool {
		if byUser[i].Online != byUser[j].Online {
			return byUser[i].Online
		}
		if byUser[i].TotalDurationSeconds != byUser[j].TotalDurationSeconds {
			return byUser[i].TotalDurationSeconds > byUser[j].TotalDurationSeconds
		}
		return byUser[i].User < byUser[j].User
	})

	if rest == "export" {
		lang := wLang(w)
		s.auditReq(r, "audit-sessions-export", session.User, fmt.Sprint(len(filtered)))
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="audit-sessions-`+time.Now().Format("20060102-150405")+`.csv"`)
		cw := csv.NewWriter(w)
		_, _ = w.Write([]byte("\xEF\xBB\xBF"))
		hdr := []string{"会话编号", "用户", "角色", "状态", "结束原因", "登录时间", "最后活跃时间", "到期/结束时间", "总在线时长（秒）", "活跃操作时长（秒）", "请求数", "来源 IP", "浏览器", "认证方式"}
		if isEnLang(lang) {
			hdr = []string{"Session ID", "User", "Role", "Status", "End Reason", "Login Time", "Last Active", "Expires / Ended", "Total Online (s)", "Active Duration (s)", "Requests", "Source IP", "User Agent", "Auth Method"}
		}
		_ = cw.Write(hdr)
		for _, row := range filtered {
			endTime := row.EndedAt
			if endTime == "" {
				endTime = row.ExpiresAt
			}
			_ = cw.Write([]string{
				row.ID, row.User, row.Role, row.Status, row.EndReason,
				row.CreatedAt, row.LastActiveAt, endTime,
				strconv.FormatInt(row.DurationSeconds, 10), strconv.FormatInt(row.ActiveSeconds, 10),
				strconv.FormatInt(row.Requests, 10), row.IP, row.Agent, row.AuthType,
			})
		}
		cw.Flush()
		return
	}

	avgDur := int64(0)
	if len(allRows) > 0 {
		avgDur = totalDur / int64(len(allRows))
	}
	if filtered == nil {
		filtered = []auditSessionRow{}
	}
	page, _ := strconv.Atoi(q.Get("page"))
	size, _ := strconv.Atoi(q.Get("size"))
	if size <= 0 || size > 200 {
		size = 50
	}
	if page < 1 {
		page = 1
	}
	start := min((page-1)*size, len(filtered))
	s.writeJSON(w, 200, map[string]any{
		"rows":    filtered[start:min(start+size, len(filtered))],
		"total":   len(filtered),
		"page":    page,
		"size":    size,
		"users":   sortedKeys(usersSet),
		"by_user": byUser,
		"summary": map[string]any{
			"online_users":         len(onlineUsersSet),
			"active_sessions":      activeCount,
			"total_sessions":       len(allRows),
			"avg_duration_seconds": avgDur,
			"max_duration_seconds": maxDur,
			"failed_logins":        failedLogins,
		},
	})
}

func (s *storeServer) revokeSessionByID(w http.ResponseWriter, r *http.Request, actor storeSession, sid string, selfOnly bool) {
	if sid == "" {
		s.fail(w, 400, "会话编号无效")
		return
	}
	if sid == actor.ID {
		s.fail(w, 409, "当前正在使用的会话请通过「退出登录」结束")
		return
	}
	now := time.Now().UTC()
	detail := "管理员 " + actor.User + " 强制下线"
	if selfOnly {
		detail = "用户自行撤销会话"
	}
	s.mu.Lock()
	target, ok := s.sessions[sid]
	if !ok {
		s.mu.Unlock()
		s.fail(w, 404, "会话不存在或已结束")
		return
	}
	if selfOnly && target.User != actor.User {
		s.mu.Unlock()
		s.fail(w, 403, "不能撤销其他人的会话")
		return
	}
	closed, _ := s.closeSessionLocked(sid, "revoked", now, detail)
	s.saveSessionsLocked()
	s.mu.Unlock()

	s.writeSessionHistory(closed)
	dur := sessionDurationSeconds(closed, now)
	s.auditReq(r, "session-revoke", actor.User, fmt.Sprintf("%s %s（%d秒）", closed.User, closed.ID, dur))
	s.writeJSON(w, 200, map[string]any{
		"ok":               true,
		"session_id":       closed.ID,
		"user":             closed.User,
		"duration_seconds": dur,
	})
}

func (s *storeServer) handleMeSessions(w http.ResponseWriter, r *http.Request, session storeSession, rest []string) {
	if r.Method == "DELETE" && len(rest) == 1 {
		s.revokeSessionByID(w, r, session, rest[0], true)
		return
	}
	if r.Method != "GET" || len(rest) != 0 {
		s.fail(w, 405, "方法不支持")
		return
	}
	s.reapExpiredSessions()
	now := time.Now().UTC()
	s.mu.Lock()
	var active []auditSessionRow
	for _, v := range s.sessions {
		if v.User == session.User && now.Before(v.Expires) {
			active = append(active, toAuditSessionRow(v, true, session.ID, now))
		}
	}
	s.mu.Unlock()
	sort.Slice(active, func(i, j int) bool {
		if active[i].Current != active[j].Current {
			return active[i].Current
		}
		return active[i].LastActiveAt > active[j].LastActiveAt
	})

	var history []auditSessionRow
	for _, v := range s.readSessionHistory(now.AddDate(0, 0, -30), now.Add(time.Minute)) {
		if v.User == session.User {
			history = append(history, toAuditSessionRow(v, false, session.ID, now))
		}
	}
	sort.Slice(history, func(i, j int) bool { return history[i].CreatedAt > history[j].CreatedAt })
	if len(history) > 20 {
		history = history[:20]
	}
	if active == nil {
		active = []auditSessionRow{}
	}
	if history == nil {
		history = []auditSessionRow{}
	}
	s.writeJSON(w, 200, map[string]any{
		"current_session_id": session.ID,
		"active":             active,
		"history":            history,
	})
}

func allowedSessionTTL(hours int) (time.Duration, error) {
	switch hours {
	case 0, 8:
		return 8 * time.Hour, nil
	case 24:
		return 24 * time.Hour, nil
	case 168:
		return 168 * time.Hour, nil
	default:
		return 0, errors.New("会话有效期仅支持 8 小时、24 小时或 7 天")
	}
}

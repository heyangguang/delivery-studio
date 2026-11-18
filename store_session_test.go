package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Upgrading or restarting the platform must not sign everyone out; signing out still ends the session for good.
func TestSessionsSurviveARestart(t *testing.T) {
	s, c := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	again, err := newStoreServer(c)
	if err != nil {
		t.Fatal(err)
	}
	if w := storeRequest(again, "GET", "/api/session", nil, alice, ""); w.Code != 200 {
		t.Fatal("the session was lost in the restart", w.Code, w.Body.String())
	}
	if w := storeRequest(again, "POST", "/api/logout", nil, alice, csrf); w.Code != 200 {
		t.Fatal("logout", w.Code)
	}
	third, err := newStoreServer(c)
	if err != nil {
		t.Fatal(err)
	}
	if w := storeRequest(third, "GET", "/api/session", nil, alice, ""); w.Code == 200 {
		t.Fatal("a session that was signed out came back after a restart")
	}
}

func storeBearerRequest(s *storeServer, method, path string, body io.Reader, bearer string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8090"+path, body)
	r.Header.Set("Origin", s.cfg.PublicURL)
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestJWTBearerAuthAndCSRFBoundaries(t *testing.T) {
	s, c := testStore(t)

	// Invalid TTL rejected
	w := storeRequest(s, "POST", "/api/login", strings.NewReader(`{"username":"alice","password":"test-password-123456","ttl_hours":999}`), nil, "")
	if w.Code != 400 {
		t.Fatalf("expected 400 for invalid ttl_hours, got %d: %s", w.Code, w.Body.String())
	}

	// Failed unknown-user login is safely audited without exposing password
	w = storeRequest(s, "POST", "/api/login", strings.NewReader(`{"username":"ghost","password":"secret-probe-password"}`), nil, "")
	if w.Code != 401 {
		t.Fatalf("expected 401 for unknown user, got %d", w.Code)
	}

	// Valid login returns JWT access_token + Bearer + session_id
	w = storeRequest(s, "POST", "/api/login", strings.NewReader(`{"username":"alice","password":"test-password-123456","ttl_hours":24}`), nil, "")
	if w.Code != 200 {
		t.Fatalf("login failed: %d %s", w.Code, w.Body.String())
	}
	var loginResp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &loginResp); err != nil {
		t.Fatal(err)
	}
	tok, _ := loginResp["access_token"].(string)
	if strings.Count(tok, ".") != 2 {
		t.Fatalf("expected 3-segment JWT access_token, got %q", tok)
	}
	if loginResp["token_type"] != "Bearer" {
		t.Fatalf("expected token_type Bearer, got %v", loginResp["token_type"])
	}
	sid, _ := loginResp["session_id"].(string)
	if sid == "" {
		t.Fatal("expected non-empty session_id")
	}

	// Bearer token authenticates writes cleanly without X-CSRF-Token
	if rw := storeBearerRequest(s, "POST", "/api/session/heartbeat", strings.NewReader(`{"active":true}`), tok); rw.Code != 200 {
		t.Fatalf("bearer heartbeat failed: %d %s", rw.Code, rw.Body.String())
	}

	// Invalid Bearer must NOT fall back to a valid cookie attached on the same request
	var cookie *http.Cookie
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			cookie = ck
		}
	}
	if cookie == nil || cookie.Value != tok {
		t.Fatalf("expected %s cookie carrying JWT", sessionCookieName)
	}
	r := httptest.NewRequest("GET", "http://127.0.0.1:8090/api/session", nil)
	r.AddCookie(cookie)
	r.Header.Set("Authorization", "Bearer invalid.jwt.signature")
	rw := httptest.NewRecorder()
	s.ServeHTTP(rw, r)
	if rw.Code != 401 {
		t.Fatalf("expected 401 when Authorization Bearer is invalid even with cookie, got %d", rw.Code)
	}

	// Restart preserves signing key and active session so same Bearer token stays valid
	restarted, err := newStoreServer(c)
	if err != nil {
		t.Fatal(err)
	}
	if rw := storeBearerRequest(restarted, "GET", "/api/session", nil, tok); rw.Code != 200 {
		t.Fatalf("bearer token rejected after restart: %d %s", rw.Code, rw.Body.String())
	}

	// Secret hygiene: neither audit.jsonl nor sessions.json may contain plaintext passwords or JWTs
	auditBytes, _ := os.ReadFile(filepath.Join(c.DataDir, "audit.jsonl"))
	if strings.Contains(string(auditBytes), "secret-probe-password") || strings.Contains(string(auditBytes), "test-password-123456") || strings.Contains(string(auditBytes), tok) {
		t.Fatal("audit.jsonl leaked plaintext password or raw JWT")
	}
	if !strings.Contains(string(auditBytes), `"action":"login-failed"`) {
		t.Fatal("expected failed unknown-user login audit entry")
	}
	sessBytes, _ := os.ReadFile(filepath.Join(c.DataDir, "sessions.json"))
	if strings.Contains(string(sessBytes), tok) {
		t.Fatal("sessions.json stored raw JWT token")
	}
}

func TestSessionDurationExpiryAndRevocationAudit(t *testing.T) {
	s, c := testStore(t)

	// Admin logs in
	adminCookie, adminCSRF := storeLogin(t, s, "admin")

	// Alice logs in twice (Bearer s1 + Bearer s2)
	loginUser := func(user string) (string, string, *http.Cookie) {
		w := storeRequest(s, "POST", "/api/login", bytes.NewBufferString(`{"username":"`+user+`","password":"test-password-123456"}`), nil, "")
		if w.Code != 200 {
			t.Fatalf("login %s failed: %d", user, w.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		var ck *http.Cookie
		for _, c := range w.Result().Cookies() {
			if c.Name == sessionCookieName {
				ck = c
			}
		}
		return body["access_token"].(string), body["session_id"].(string), ck
	}
	aliceTok1, aliceSID1, _ := loginUser("alice")
	aliceTok2, aliceSID2, _ := loginUser("alice")
	bobTok, bobSID, _ := loginUser("bob")

	// Backdate bob's CreatedAt / LastActiveAt so session duration is guaranteed > 0 and heartbeat increments active_seconds
	s.mu.Lock()
	bobSess := s.sessions[bobSID]
	bobSess.CreatedAt = bobSess.CreatedAt.Add(-3 * time.Minute)
	bobSess.LastActiveAt = bobSess.CreatedAt
	s.sessions[bobSID] = bobSess
	s.mu.Unlock()

	if rw := storeBearerRequest(s, "POST", "/api/session/heartbeat", strings.NewReader(`{"active":true}`), bobTok); rw.Code != 200 {
		t.Fatalf("bob heartbeat: %d", rw.Code)
	} else {
		var hb map[string]any
		_ = json.Unmarshal(rw.Body.Bytes(), &hb)
		if int(hb["duration_seconds"].(float64)) < 170 {
			t.Fatalf("expected bob duration >= 170s, got %v", hb["duration_seconds"])
		}
		if int(hb["active_seconds"].(float64)) < 170 {
			t.Fatalf("expected bob active_seconds >= 170s, got %v", hb["active_seconds"])
		}
	}

	// Admin queries GET /api/audit/sessions and CSV export
	if rw := storeRequest(s, "GET", "/api/audit/sessions", nil, adminCookie, ""); rw.Code != 200 {
		t.Fatalf("audit sessions query failed: %d %s", rw.Code, rw.Body.String())
	} else {
		var res map[string]any
		_ = json.Unmarshal(rw.Body.Bytes(), &res)
		sum := res["summary"].(map[string]any)
		if int(sum["active_sessions"].(float64)) < 4 {
			t.Fatalf("expected >=4 active sessions, got %v", sum["active_sessions"])
		}
		if int(sum["online_users"].(float64)) < 3 {
			t.Fatalf("expected >=3 online users, got %v", sum["online_users"])
		}
	}
	if rw := storeRequest(s, "GET", "/api/audit/sessions/export", nil, adminCookie, ""); rw.Code != 200 || !strings.Contains(rw.Body.String(), "总在线时长（秒）") {
		t.Fatalf("audit sessions export failed: %d %s", rw.Code, rw.Body.String())
	}

	// Admin force-kicks bob offline
	if rw := storeRequest(s, "DELETE", "/api/audit/sessions/"+bobSID, nil, adminCookie, adminCSRF); rw.Code != 200 {
		t.Fatalf("kick bob failed: %d %s", rw.Code, rw.Body.String())
	}
	if rw := storeBearerRequest(s, "GET", "/api/session", nil, bobTok); rw.Code != 401 {
		t.Fatalf("kicked bob token should return 401, got %d", rw.Code)
	}

	// Alice lists her sessions and changes password -> s2 ends with password-changed, s1 stays active
	if rw := storeBearerRequest(s, "GET", "/api/me/sessions", nil, aliceTok1); rw.Code != 200 || !strings.Contains(rw.Body.String(), aliceSID2) {
		t.Fatalf("GET /api/me/sessions failed: %d %s", rw.Code, rw.Body.String())
	}
	if rw := storeBearerRequest(s, "POST", "/api/me/password", strings.NewReader(`{"current":"test-password-123456","next":"new-strong-password-789"}`), aliceTok1); rw.Code != 200 {
		t.Fatalf("alice password change failed: %d %s", rw.Code, rw.Body.String())
	}
	if rw := storeBearerRequest(s, "GET", "/api/session", nil, aliceTok1); rw.Code != 200 {
		t.Fatalf("current session should remain valid after password change, got %d", rw.Code)
	}
	if rw := storeBearerRequest(s, "GET", "/api/session", nil, aliceTok2); rw.Code != 401 {
		t.Fatalf("other alice session should be invalidated after password change, got %d", rw.Code)
	}
	if aliceSID1 == aliceSID2 {
		t.Fatal("distinct logins should get distinct session IDs")
	}

	// Simulate expired session -> next request reaps and writes session-expired audit log + closed history
	s.mu.Lock()
	a1 := s.sessions[aliceSID1]
	a1.CreatedAt = time.Now().UTC().Add(-2 * time.Hour)
	a1.Expires = time.Now().UTC().Add(-time.Minute)
	s.sessions[aliceSID1] = a1
	s.mu.Unlock()

	if rw := storeBearerRequest(s, "GET", "/api/session", nil, aliceTok1); rw.Code != 401 {
		t.Fatalf("expired session must return 401, got %d", rw.Code)
	}

	histBytes, _ := os.ReadFile(filepath.Join(c.DataDir, "session_history.jsonl"))
	hist := string(histBytes)
	for _, want := range []string{`"end_reason":"revoked"`, `"end_reason":"password-changed"`, `"end_reason":"expired"`} {
		if !strings.Contains(hist, want) {
			t.Fatalf("session_history.jsonl missing %s:\n%s", want, hist)
		}
	}
	auditBytes, _ := os.ReadFile(filepath.Join(c.DataDir, "audit.jsonl"))
	auditStr := string(auditBytes)
	for _, want := range []string{`"action":"session-revoke"`, `"action":"session-expired"`} {
		if !strings.Contains(auditStr, want) {
			t.Fatalf("audit.jsonl missing %s:\n%s", want, auditStr)
		}
	}
}

func TestConcurrentUsersAndIAMNeverDeadlock(t *testing.T) {
	s, _ := testStore(t)
	w := storeRequest(s, "POST", "/api/login", strings.NewReader(`{"username":"admin","password":"test-password-123456"}`), nil, "")
	if w.Code != 200 {
		t.Fatalf("admin login failed: %d", w.Code)
	}
	var res map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	tok := res["access_token"].(string)

	done := make(chan struct{})
	go func() {
		var wg sync.WaitGroup
		for i := 0; i < 6; i++ {
			wg.Add(1)
			go func(worker int) {
				defer wg.Done()
				for n := 0; n < 15; n++ {
					switch (worker + n) % 3 {
					case 0:
						if rw := storeBearerRequest(s, "GET", "/api/users", nil, tok); rw.Code != 200 {
							t.Errorf("GET /api/users: %d", rw.Code)
							return
						}
					case 1:
						if rw := storeBearerRequest(s, "GET", "/api/iam", nil, tok); rw.Code != 200 {
							t.Errorf("GET /api/iam: %d", rw.Code)
							return
						}
					default:
						if rw := storeBearerRequest(s, "PATCH", "/api/users/alice", strings.NewReader(`{"role":"operator"}`), tok); rw.Code != 200 {
							t.Errorf("PATCH /api/users/alice: %d %s", rw.Code, rw.Body.String())
							return
						}
					}
				}
			}(i)
		}
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("concurrent /api/users and /api/iam requests deadlocked")
	}
}

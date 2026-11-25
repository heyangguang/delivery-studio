//go:build !windows

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestGatewayGatePreservesInflightAndCancelsQueued(t *testing.T) {
	var g gatewayGate
	if !g.enter(context.Background()) {
		t.Fatal("enter")
	}
	if g.freeze() {
		t.Fatal("interrupted active request")
	}
	g.leave()
	if !g.freeze() {
		t.Fatal("freeze")
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan bool, 1)
	go func() { result <- g.enter(ctx) }()
	cancel()
	if <-result {
		t.Fatal("canceled request admitted")
	}
	go func() { result <- g.enter(context.Background()) }()
	select {
	case <-result:
		t.Fatal("request passed during swap")
	case <-time.After(20 * time.Millisecond):
	}
	g.thaw()
	if !<-result {
		t.Fatal("queued request lost")
	}
	g.leave()
}

func TestGatewayWorkerIdleIncludesDetachedHandlers(t *testing.T) {
	s, _ := testStore(t)
	h := gatewayWorkerHandler(s)
	s.wg.Add(1)
	r := httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest("GET", "http://localhost/__gateway/idle", nil))
	if r.Code != 409 {
		t.Fatal(r.Code)
	}
	s.wg.Done()
	r = httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest("GET", "http://localhost/__gateway/idle", nil))
	if r.Code != 204 {
		t.Fatal(r.Code)
	}
}

// Run against the real release executable, including process shutdown/startup and streaming HTTP.
func TestGatewayUpdateKeepsAIAndRollsBack(t *testing.T) {
	binary := os.Getenv("MW_GATEWAY_TEST_BINARY")
	if binary == "" {
		t.Skip("set MW_GATEWAY_TEST_BINARY to a built release")
	}
	s, cfg := testStore(t)
	release := make(chan struct{})
	began := make(chan struct{})
	var once sync.Once
	var free sync.Once
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"回答开始\"}}]}\n\n")
		w.(http.Flusher).Flush()
		once.Do(func() { close(began) })
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"，回答完整结束\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer model.Close()
	defer free.Do(func() { close(release) })
	enableAI(t, s, model.URL, 0)
	st := s.aiLoad()
	st.Features["assistant"] = aiFeature{Enabled: true}
	s.aiSave(st)
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	cfg.Listen = l.Addr().String()
	l.Close()
	cfg.PublicURL = "http://" + cfg.Listen
	config := filepath.Join(t.TempDir(), "config.json")
	b, _ := json.Marshal(cfg)
	os.WriteFile(config, b, 0600)
	install := filepath.Join(t.TempDir(), "hub")
	b, e = os.ReadFile(binary)
	if e != nil {
		t.Fatal(e)
	}
	os.WriteFile(install, b, 0700)
	logfile := filepath.Join(t.TempDir(), "gateway.log")
	log, _ := os.Create(logfile)
	defer log.Close()
	cmd := exec.Command(install, "store", "supervise", "--config", config)
	cmd.Stdout = log
	cmd.Stderr = log
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() {
		cmd.Process.Signal(syscall.SIGTERM)
		done := make(chan struct{})
		go func() { cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			cmd.Process.Kill()
		}
	}()
	wait := func(f func() bool) {
		t.Helper()
		deadline := time.Now().Add(25 * time.Second)
		for !f() {
			if time.Now().After(deadline) {
				b, _ := os.ReadFile(logfile)
				t.Fatal("timeout", string(b))
			}
			time.Sleep(30 * time.Millisecond)
		}
	}
	logHas := func(text string) bool { b, _ := os.ReadFile(logfile); return strings.Contains(string(b), text) }
	client := &http.Client{Timeout: 30 * time.Second}
	wait(func() bool {
		r, e := client.Get(cfg.PublicURL + "/api/version")
		if e != nil {
			return false
		}
		r.Body.Close()
		return r.StatusCode == 200
	})
	req, _ := http.NewRequest("POST", cfg.PublicURL+"/api/login", strings.NewReader("{\"username\":\"admin\",\"password\":\"test-password-123456\"}"))
	req.Header.Set("Origin", cfg.PublicURL)
	r, e := client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	var login map[string]string
	json.NewDecoder(r.Body).Decode(&login)
	r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	cookie := r.Cookies()[0]
	req, _ = http.NewRequest("POST", cfg.PublicURL+"/api/ai/chats/abcdef123456/chat", strings.NewReader("{\"message\":\"更新时请继续回答\"}"))
	req.Header.Set("Origin", cfg.PublicURL)
	req.Header.Set("X-CSRF-Token", login["csrf"])
	req.AddCookie(cookie)
	response := make(chan string, 1)
	go func() {
		r, e := client.Do(req)
		if e != nil {
			response <- e.Error()
			return
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		response <- string(b)
	}()
	select {
	case <-began:
	case <-time.After(15 * time.Second):
		t.Fatal("AI never started")
	}
	cmd.Process.Signal(syscall.SIGUSR2)
	wait(func() bool { return logHas("更新已排队") })
	time.Sleep(200 * time.Millisecond)
	if logHas("平滑更新完成") {
		t.Fatal("updated while AI was answering")
	}
	// Other requests are still served while the answer finishes.
	r, e = client.Get(cfg.PublicURL + "/api/version")
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	free.Do(func() { close(release) })
	answer := <-response
	if !strings.Contains(answer, "回答完整结束") {
		t.Fatal("stream truncated", answer)
	}
	wait(func() bool { return logHas("平滑更新完成") })
	req, _ = http.NewRequest("GET", cfg.PublicURL+"/api/ai/chats/abcdef123456", nil)
	req.AddCookie(cookie)
	r, e = client.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	saved, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != 200 || !strings.Contains(string(saved), "回答完整结束") {
		t.Fatal("session or history lost", r.StatusCode, string(saved))
	}
	// A valid version command but broken server must roll back, keeping the same browser session.
	os.WriteFile(install+".next", []byte("#!/bin/sh\nif [ \"$1\" = version ]; then echo broken; exit 0; fi\nexit 1\n"), 0700)
	os.Rename(install+".next", install)
	cmd.Process.Signal(syscall.SIGUSR2)
	wait(func() bool { return logHas("新版本启动失败，恢复原版本") })
	wait(func() bool {
		r, e := client.Do(req)
		if e != nil {
			return false
		}
		defer r.Body.Close()
		return r.StatusCode == 200
	})
	// A previously loaded frontend can still fetch an older lazy chunk after a release.
	os.WriteFile(filepath.Join(cfg.DataDir, ".web-assets", "old-hash.js"), []byte("/* old page */"), 0600)
	r, e = client.Get(cfg.PublicURL + "/assets/old-hash.js")
	if e != nil {
		t.Fatal(e)
	}
	asset, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != 200 || string(asset) != "/* old page */" {
		t.Fatal("old chunk lost")
	}
}

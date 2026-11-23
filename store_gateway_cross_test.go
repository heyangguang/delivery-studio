package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGatewayWorkerTokenAndShutdownCrossPlatform(t *testing.T) {
	s, _ := testStore(t)
	var shutdownCalled atomic.Bool
	h := gatewayWorkerHandlerWithControl(s, func() {
		shutdownCalled.Store(true)
	}, "secret-tok-123")

	// Reject requests without valid gateway token.
	r := httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest(http.MethodGet, "http://localhost/__gateway/idle", nil))
	if r.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without token, got %d", r.Code)
	}

	// Accept valid token for idle check.
	req := httptest.NewRequest(http.MethodGet, "http://localhost/__gateway/idle", nil)
	req.Header.Set("X-MW-Gateway-Token", "secret-tok-123")
	r = httptest.NewRecorder()
	h.ServeHTTP(r, req)
	if r.Code != http.StatusNoContent {
		t.Fatalf("expected 204 when idle with valid token, got %d", r.Code)
	}

	// Busy work blocks idle check.
	s.wg.Add(1)
	busyReq := httptest.NewRequest(http.MethodGet, "http://localhost/__gateway/idle", nil)
	busyReq.Header.Set("X-MW-Gateway-Token", "secret-tok-123")
	r = httptest.NewRecorder()
	h.ServeHTTP(r, busyReq)
	if r.Code != http.StatusConflict {
		t.Fatalf("expected 409 when busy, got %d", r.Code)
	}
	s.wg.Done()

	// Authenticated shutdown invokes callback cleanly.
	sreq := httptest.NewRequest(http.MethodPost, "http://localhost/__gateway/shutdown", nil)
	sreq.Header.Set("X-MW-Gateway-Token", "secret-tok-123")
	r = httptest.NewRecorder()
	h.ServeHTTP(r, sreq)
	if r.Code != http.StatusAccepted {
		t.Fatalf("expected 202 for shutdown, got %d", r.Code)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !shutdownCalled.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !shutdownCalled.Load() {
		t.Fatal("expected shutdownFn to be invoked")
	}
}

func TestGatewaySnapshotPreservesExtensionAndLoopbackAddr(t *testing.T) {
	dir := t.TempDir()
	srcName := "hub-test"
	if runtime.GOOS == "windows" {
		srcName += ".exe"
	}
	src := filepath.Join(dir, srcName)
	if err := os.WriteFile(src, []byte("fake-binary"), 0700); err != nil {
		t.Fatal(err)
	}
	snap, err := snapshotGatewayBinary(src, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer removeFileBestEffort(snap)
	if runtime.GOOS == "windows" && !strings.HasSuffix(strings.ToLower(snap), ".exe") {
		t.Fatalf("expected windows snapshot to preserve .exe suffix, got %s", snap)
	}

	addrFile := filepath.Join(dir, "worker.addr")
	ln, err := openLoopbackWorkerListener(addrFile)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	raw, err := os.ReadFile(addrFile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(raw)) != ln.Addr().String() {
		t.Fatalf("expected addr %q, got %q", ln.Addr().String(), string(raw))
	}
}

func TestGatewayGatePreservesInflightCrossPlatform(t *testing.T) {
	var g gatewayGate
	if !g.enter(context.Background()) {
		t.Fatal("enter")
	}
	if g.freeze() {
		t.Fatal("must not freeze while request active")
	}
	g.leave()
	if !g.freeze() {
		t.Fatal("freeze should succeed once idle")
	}
	done := make(chan bool, 1)
	go func() { done <- g.enter(context.Background()) }()
	select {
	case <-done:
		t.Fatal("queued request should wait while frozen")
	case <-time.After(25 * time.Millisecond):
	}
	g.thaw()
	if !<-done {
		t.Fatal("queued request should proceed after thaw")
	}
	g.leave()
}

func TestAPIVersionIncludesBuildID(t *testing.T) {
	s, cfg := testStore(t)
	req := httptest.NewRequest(http.MethodGet, cfg.PublicURL+"/api/version", nil)
	r := httptest.NewRecorder()
	s.ServeHTTP(r, req)
	if r.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d %s", r.Code, r.Body.String())
	}
	var payload struct {
		Version string `json:"version"`
		BuildID string `json:"build_id"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Version != version {
		t.Fatalf("expected version %q, got %q", version, payload.Version)
	}
	if payload.BuildID == "" {
		t.Fatal("expected non-empty build_id in /api/version")
	}
}

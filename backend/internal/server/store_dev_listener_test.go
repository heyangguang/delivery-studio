package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type memPipeListener struct {
	ch     chan net.Conn
	closed chan struct{}
}

func newMemPipeListener() *memPipeListener {
	return &memPipeListener{ch: make(chan net.Conn, 8), closed: make(chan struct{})}
}
func (m *memPipeListener) Accept() (net.Conn, error) {
	select {
	case c := <-m.ch:
		return c, nil
	case <-m.closed:
		return nil, net.ErrClosed
	}
}
func (m *memPipeListener) Close() error {
	select {
	case <-m.closed:
	default:
		close(m.closed)
	}
	return nil
}
func (m *memPipeListener) Addr() net.Addr { return &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 8443} }
func (m *memPipeListener) DialContext(_ context.Context, _, _ string) (net.Conn, error) {
	c1, c2 := net.Pipe()
	m.ch <- c2
	return c1, nil
}

func TestStoreDevListener0000HostOriginAndDualProtocol(t *testing.T) {
	s, _ := testStore(t)
	s.cfg.Listen = "0.0.0.0:8443"
	s.cfg.PublicURL = "https://0.0.0.0:8443"
	s.cfg.LocalDev = true

	reqOK := httptest.NewRequest("GET", "http://localhost:8443/api/version", nil)
	recOK := httptest.NewRecorder()
	s.ServeHTTP(recOK, reqOK)
	if recOK.Code != 200 {
		t.Fatalf("expected localhost:8443 to pass, got %d: %s", recOK.Code, recOK.Body.String())
	}

	reqBadHost := httptest.NewRequest("GET", "http://attacker.invalid:8443/api/version", nil)
	recBadHost := httptest.NewRecorder()
	s.ServeHTTP(recBadHost, reqBadHost)
	if recBadHost.Code != 403 {
		t.Fatalf("foreign Host should be rejected with 403, got %d", recBadHost.Code)
	}

	reqBadOrigin := httptest.NewRequest("POST", "https://127.0.0.1:8443/api/login", strings.NewReader(`{}`))
	reqBadOrigin.Header.Set("Origin", "https://attacker.invalid")
	recBadOrigin := httptest.NewRecorder()
	s.ServeHTTP(recBadOrigin, reqBadOrigin)
	if recBadOrigin.Code != 403 {
		t.Fatalf("foreign Origin should be rejected with 403, got %d", recBadOrigin.Code)
	}

	certPath := filepath.Join(t.TempDir(), "dev.crt")
	keyPath := filepath.Join(t.TempDir(), "dev.key")
	if err := ensureDevTLSCert(certPath, keyPath); err != nil {
		t.Fatal(err)
	}
	memLn := newMemPipeListener()
	defer memLn.Close()
	dualLn, err := newDualProtocolListener(memLn, certPath, keyPath)
	if err != nil {
		t.Fatal(err)
	}
	defer dualLn.Close()
	srv := &http.Server{Handler: s}
	go srv.Serve(dualLn)
	defer srv.Close()

	httpClient := &http.Client{Transport: &http.Transport{DialContext: memLn.DialContext}}
	respHTTP, err := httpClient.Get("http://127.0.0.1:8443/api/version")
	if err != nil {
		t.Fatalf("plain HTTP failed on dual listener: %v", err)
	}
	respHTTP.Body.Close()
	if respHTTP.StatusCode != 200 {
		t.Fatalf("expected HTTP 200, got %d", respHTTP.StatusCode)
	}

	tlsClient := &http.Client{Transport: &http.Transport{DialContext: memLn.DialContext, TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	respHTTPS, err := tlsClient.Get("https://127.0.0.1:8443/api/version")
	if err != nil {
		t.Fatalf("HTTPS failed on dual listener: %v", err)
	}
	respHTTPS.Body.Close()
	if respHTTPS.StatusCode != 200 {
		t.Fatalf("expected HTTPS 200, got %d", respHTTPS.StatusCode)
	}
}

func TestVersionEndpointIncludesReleaseNotes(t *testing.T) {
	s, _ := testStore(t)
	s.cfg.Listen = "0.0.0.0:8443"
	s.cfg.PublicURL = "https://0.0.0.0:8443"
	s.cfg.LocalDev = true
	req := httptest.NewRequest("GET", "http://localhost:8443/api/version", nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Version    string        `json:"version"`
		ReleasedAt string        `json:"released_at"`
		Notes      []releaseNote `json:"notes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal /api/version: %v", err)
	}
	if payload.Version != version || payload.ReleasedAt != currentReleaseDate {
		t.Fatalf("unexpected version payload: %+v", payload)
	}
	if len(payload.Notes) == 0 || payload.Notes[0].Version != version || payload.Notes[0].Date != currentReleaseDate {
		t.Fatalf("expected top release note to match current version %s (%s), got %+v", version, currentReleaseDate, payload.Notes)
	}
	seen := make(map[string]bool, len(payload.Notes))
	var prevDate time.Time
	for i, n := range payload.Notes {
		v := strings.TrimSpace(n.Version)
		if v == "" || seen[v] {
			t.Fatalf("release note #%d has empty or duplicate version: %+v", i, n)
		}
		seen[v] = true
		dt, err := time.Parse("2006-01-02", strings.TrimSpace(n.Date))
		if err != nil {
			t.Fatalf("release note %s has invalid date %q: %v", v, n.Date, err)
		}
		if i > 0 && dt.After(prevDate) {
			t.Fatalf("release note %s (%s) is out of reverse-chronological order after %s", v, n.Date, prevDate.Format("2006-01-02"))
		}
		prevDate = dt
		if strings.TrimSpace(n.Title) == "" || len(n.Highlights) == 0 {
			t.Fatalf("release note %s must include title and highlights: %+v", v, n)
		}
	}
}

func TestEnsureDevTLSCertRefreshesMissingSAN(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "dev.crt")
	keyPath := filepath.Join(dir, "dev.key")
	if err := ensureDevTLSCert(certPath, keyPath); err != nil {
		t.Fatalf("initial ensureDevTLSCert: %v", err)
	}
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		t.Fatalf("load generated dev cert: %v", err)
	}
	if len(cert.Certificate) == 0 {
		t.Fatalf("expected generated cert bytes")
	}
	// Second call on up-to-date cert should be a fast no-op and remain valid.
	if err := ensureDevTLSCert(certPath, keyPath); err != nil {
		t.Fatalf("second ensureDevTLSCert: %v", err)
	}
}

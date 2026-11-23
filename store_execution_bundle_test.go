package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecutionNodeBootstrapAndBundle(t *testing.T) {
	root := t.TempDir()
	certPath := filepath.Join(root, "dev-tls.crt")
	keyPath := filepath.Join(root, "dev-tls.key")
	if err := ensureDevTLSCert(certPath, keyPath); err != nil {
		t.Fatal(err)
	}
	// Fake valid Linux x86_64 ELF header so openExecutionNodeBinary succeeds on any OS.
	fakeBin := make([]byte, 64)
	fakeBin[0], fakeBin[1], fakeBin[2], fakeBin[3] = 0x7f, 'E', 'L', 'F'
	fakeBin[4], fakeBin[5] = 2, 1
	fakeBin[18], fakeBin[19] = 0x3e, 0x00
	artDir := filepath.Join(root, "artifacts")
	if err := os.MkdirAll(artDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(artDir, "middleware-store-linux-amd64"), fakeBin, 0755); err != nil {
		t.Fatal(err)
	}

	s := &storeServer{
		cfg: storeConfig{
			DataDir:      root,
			ArtifactsDir: artDir,
			Listen:       "0.0.0.0:8443",
			TLSCert:      certPath,
			TLSKey:       keyPath,
		},
		jobs: map[string]storeJob{},
	}
	tok := strings.Repeat("a", 64)
	n := executionNode{
		ID:           "node-pass4",
		Name:         "pass-4",
		Kind:         "independent",
		ControllerIP: "192.168.31.153",
		TokenHash:    digest([]byte(tok)),
	}
	if err := s.saveExecutions(executionDB{
		Nodes: map[string]executionNode{n.ID: n},
		Runs:  map[string]executionRun{},
	}); err != nil {
		t.Fatal(err)
	}
	sess := storeSession{User: "admin", Role: "admin"}

	// 1. bootstrap-info detects loopback request and self-signed CA.
	req := httptest.NewRequest("GET", "https://127.0.0.1:8443/api/settings/execution-nodes/bootstrap-info", nil)
	req.Host = "127.0.0.1:8443"
	rec := httptest.NewRecorder()
	s.handleExecutionNodes(rec, req, sess)
	if rec.Code != 200 {
		t.Fatalf("bootstrap-info status %d: %s", rec.Code, rec.Body.String())
	}
	var info executionBootstrapInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if !info.IsLoopback || !info.TLSEnabled || !info.TLSSelfSigned || !info.CAAvailable || !info.BinaryAvailable {
		t.Fatalf("unexpected bootstrap info: %+v", info)
	}

	// 2. ca.pem returns PEM cert.
	req = httptest.NewRequest("GET", "https://127.0.0.1:8443/api/settings/execution-nodes/ca.pem", nil)
	rec = httptest.NewRecorder()
	s.handleExecutionNodes(rec, req, sess)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "BEGIN CERTIFICATE") {
		t.Fatalf("ca.pem unexpected: %d %q", rec.Code, rec.Body.String())
	}

	// 3. bundle rejects wrong token.
	badBody, _ := json.Marshal(map[string]any{
		"node_id": n.ID,
		"token":   strings.Repeat("b", 64),
		"url":     "https://192.168.31.103:8443",
	})
	req = httptest.NewRequest("POST", "https://127.0.0.1:8443/api/settings/execution-nodes/bundle", bytes.NewReader(badBody))
	rec = httptest.NewRecorder()
	s.handleExecutionNodes(rec, req, sess)
	if rec.Code != 403 {
		t.Fatalf("expected 403 for wrong token, got %d", rec.Code)
	}

	// 4. bundle produces valid tar.gz with binary, json, ca.pem, install.sh, uninstall.sh.
	goodBody, _ := json.Marshal(map[string]any{
		"node_id": n.ID,
		"token":   tok,
		"url":     "https://192.168.31.103:8443",
	})
	req = httptest.NewRequest("POST", "https://127.0.0.1:8443/api/settings/execution-nodes/bundle", bytes.NewReader(goodBody))
	rec = httptest.NewRecorder()
	s.handleExecutionNodes(rec, req, sess)
	if rec.Code != http.StatusOK {
		t.Fatalf("bundle status %d: %s", rec.Code, rec.Body.String())
	}
	gz, err := gzip.NewReader(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	files := map[string][]byte{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		files[hdr.Name] = b
	}
	prefix := "mw-runner-pass-4/"
	for _, want := range []string{
		prefix + "middleware-store-linux-amd64",
		prefix + "execution-node.json",
		prefix + "platform-ca.pem",
		prefix + "install.sh",
		prefix + "uninstall.sh",
	} {
		if _, ok := files[want]; !ok {
			t.Fatalf("missing %s in bundle; got keys %v", want, files)
		}
	}
	var cfg executionRunnerConfig
	if err := json.Unmarshal(files[prefix+"execution-node.json"], &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.URL != "https://192.168.31.103:8443" || cfg.Token != tok || cfg.CAFile != "/etc/middleware-execution/platform-ca.pem" {
		t.Fatalf("unexpected bundle config: %+v", cfg)
	}
	installSh := string(files[prefix+"install.sh"])
	if !strings.Contains(installSh, "systemctl enable --now middleware-execution") || !strings.Contains(installSh, "--check") {
		t.Fatalf("install.sh missing systemd or --check: %s", installSh)
	}
}

func TestPortalAISessionEndpoints(t *testing.T) {
	root := t.TempDir()
	s := &storeServer{
		cfg:  storeConfig{DataDir: root},
		jobs: map[string]storeJob{},
	}
	sess := storeSession{User: "alice", Role: "admin"}

	req := httptest.NewRequest("GET", "/api/ai/portal/sessions", nil)
	rec := httptest.NewRecorder()
	s.handlePortalAI(rec, req, sess)
	if rec.Code != 200 {
		t.Fatalf("portal sessions status %d: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest("GET", "/api/ai/portal/session?key=portal:exec-nodes", nil)
	rec = httptest.NewRecorder()
	s.handlePortalAI(rec, req, sess)
	if rec.Code != 200 {
		t.Fatalf("portal session status %d: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest("GET", "/api/ai/portal/proposals", nil)
	rec = httptest.NewRecorder()
	s.handlePortalAI(rec, req, sess)
	if rec.Code != 200 {
		t.Fatalf("portal proposals status %d: %s", rec.Code, rec.Body.String())
	}
}

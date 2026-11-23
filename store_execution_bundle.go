package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

type executionBootstrapInfo struct {
	Origin          string   `json:"origin"`
	IsLoopback      bool     `json:"is_loopback"`
	SuggestedURLs   []string `json:"suggested_urls"`
	TLSEnabled      bool     `json:"tls_enabled"`
	TLSSelfSigned   bool     `json:"tls_self_signed"`
	CAAvailable     bool     `json:"ca_available"`
	BinaryAvailable bool     `json:"binary_available"`
	Version         string   `json:"version"`
}

func isLoopbackHost(host string) bool {
	h := strings.TrimSpace(host)
	if strings.Contains(h, ":") && !strings.HasPrefix(h, "[") {
		if parsed, _, err := net.SplitHostPort(h); err == nil {
			h = parsed
		}
	} else if strings.HasPrefix(h, "[") {
		if parsed, _, err := net.SplitHostPort(h); err == nil {
			h = parsed
		} else {
			h = strings.Trim(h, "[]")
		}
	}
	h = strings.ToLower(h)
	if h == "" || h == "localhost" {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback() || ip.IsUnspecified()
	}
	return false
}

func (s *storeServer) readPlatformCACert() ([]byte, bool) {
	if strings.TrimSpace(s.cfg.TLSCert) == "" {
		return nil, false
	}
	b, err := os.ReadFile(s.cfg.TLSCert)
	if err != nil || len(b) == 0 {
		return nil, false
	}
	selfSigned := false
	if block, _ := pem.Decode(b); block != nil {
		if cert, err := x509.ParseCertificate(block.Bytes); err == nil {
			if cert.Issuer.String() == cert.Subject.String() {
				selfSigned = true
			}
		}
	}
	return b, selfSigned
}

func (s *storeServer) executionBootstrapInfo(r *http.Request) executionBootstrapInfo {
	scheme := "http"
	if r.TLS != nil || s.cfg.TLSCert != "" || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	reqHost := strings.TrimSpace(r.Host)
	if reqHost == "" {
		reqHost = s.cfg.Listen
	}
	_, port, splitErr := net.SplitHostPort(reqHost)
	if splitErr != nil {
		if _, lp, lerr := net.SplitHostPort(s.cfg.Listen); lerr == nil && lp != "" {
			port = lp
		}
	}
	origin := scheme + "://" + reqHost
	loopback := isLoopbackHost(reqHost)

	seen := map[string]bool{}
	var urls []string
	addURL := func(u string) {
		u = strings.TrimRight(strings.TrimSpace(u), "/")
		if u == "" || seen[u] {
			return
		}
		seen[u] = true
		urls = append(urls, u)
	}
	if !loopback && reqHost != "" {
		addURL(origin)
	}

	// Collect non-loopback IPv4 addresses on this host, preferring RFC1918 LAN addresses.
	type scoredIP struct {
		ip    string
		score int
	}
	var cands []scoredIP
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok || ipNet.IP == nil {
				continue
			}
			v4 := ipNet.IP.To4()
			if v4 == nil || v4.IsLoopback() || v4.IsLinkLocalUnicast() || v4.IsUnspecified() {
				continue
			}
			sc := 10
			switch {
			case v4[0] == 192 && v4[1] == 168:
				sc = 1
			case v4[0] == 10:
				sc = 2
			case v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31:
				sc = 3
			}
			cands = append(cands, scoredIP{ip: v4.String(), score: sc})
		}
	}
	sort.Slice(cands, func(i, j int) bool {
		if cands[i].score != cands[j].score {
			return cands[i].score < cands[j].score
		}
		return cands[i].ip < cands[j].ip
	})
	for _, c := range cands {
		hostPort := c.ip
		if port != "" && !((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) {
			hostPort = net.JoinHostPort(c.ip, port)
		}
		addURL(scheme + "://" + hostPort)
	}
	if len(urls) == 0 && reqHost != "" {
		addURL(origin)
	}

	caBytes, selfSigned := s.readPlatformCACert()
	binOK := false
	if f, _, err := s.openExecutionNodeBinary(); err == nil {
		binOK = true
		f.Close()
	}
	return executionBootstrapInfo{
		Origin:          origin,
		IsLoopback:      loopback,
		SuggestedURLs:   urls,
		TLSEnabled:      scheme == "https",
		TLSSelfSigned:   selfSigned,
		CAAvailable:     len(caBytes) > 0,
		BinaryAvailable: binOK,
		Version:         version,
	}
}

var reRunnerSlug = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func runnerBundleSlug(name, ip string) string {
	base := strings.TrimSpace(name)
	slug := strings.Trim(reRunnerSlug.ReplaceAllString(strings.ToLower(base), "-"), "-.")
	if slug == "" {
		slug = strings.ReplaceAll(ip, ".", "-")
	}
	if slug == "" {
		slug = "node"
	}
	if len(slug) > 36 {
		slug = strings.TrimRight(slug[:36], "-.")
	}
	return slug
}

func renderRunnerInstallScript(nodeName, hubURL string, hasCA bool) string {
	caInstall := ""
	if hasCA {
		caInstall = `install -m 0644 "$SCRIPT_DIR/platform-ca.pem" /etc/middleware-execution/platform-ca.pem
echo "[OK] Installed platform CA certificate -> /etc/middleware-execution/platform-ca.pem"
`
	}
	return fmt.Sprintf(`#!/usr/bin/env bash
set -euo pipefail

# Middleware Hub Execution Node Installer
# Node: %s
# Hub:  %s

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[ERROR] Please run this installer as root (e.g. sudo bash install.sh)." >&2
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" && "$ARCH" != "amd64" ]]; then
  echo "[ERROR] Unsupported architecture: $ARCH (Linux x86_64 required)." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "[ERROR] systemd (systemctl) is required to run middleware-execution in the background." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[1/4] Stopping any existing middleware-execution service..."
systemctl stop middleware-execution 2>/dev/null || true

echo "[2/4] Installing runner binary and configuration..."
install -m 0755 "$SCRIPT_DIR/middleware-store-linux-amd64" /usr/local/bin/middleware-store
install -d -m 0700 /etc/middleware-execution /var/lib/middleware-execution
install -m 0600 "$SCRIPT_DIR/execution-node.json" /etc/middleware-execution/execution-node.json
%s
echo "[3/4] Installing and starting systemd background service..."
cat <<'EOF' > /etc/systemd/system/middleware-execution.service
[Unit]
Description=Middleware Hub Execution Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
UMask=0077
ExecStart=/usr/local/bin/middleware-store execution-node --config /etc/middleware-execution/execution-node.json
Restart=on-failure
RestartSec=10
KillMode=process
TimeoutStopSec=25h

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now middleware-execution

echo "[4/4] Verifying platform connectivity..."
if /usr/local/bin/middleware-store execution-node --config /etc/middleware-execution/execution-node.json --check; then
  echo ""
  echo "============================================================"
  echo "[OK] Middleware Hub execution node is installed and online."
  echo "     Service: middleware-execution (systemd background)"
  echo "     Status:  systemctl status middleware-execution"
  echo "     Logs:    journalctl -u middleware-execution -f"
  echo "============================================================"
else
  echo ""
  echo "[WARN] Service was installed, but the live connectivity check failed." >&2
  echo "       Inspect details with: journalctl -u middleware-execution -n 40 --no-pager" >&2
  exit 1
fi
`, nodeName, hubURL, caInstall)
}

func renderRunnerUninstallScript() string {
	return `#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[ERROR] Please run this script as root." >&2
  exit 1
fi

echo "Stopping and removing middleware-execution service..."
systemctl disable --now middleware-execution 2>/dev/null || true
rm -f /etc/systemd/system/middleware-execution.service
systemctl daemon-reload 2>/dev/null || true
rm -rf /etc/middleware-execution
rm -f /usr/local/bin/middleware-store
echo "[OK] Execution node uninstalled. Historical state in /var/lib/middleware-execution was kept."
`
}

func writeTarBytes(tw *tar.Writer, name string, mode int64, data []byte, mod time.Time) error {
	hdr := &tar.Header{
		Name:    name,
		Mode:    mode,
		Size:    int64(len(data)),
		ModTime: mod,
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	_, err := tw.Write(data)
	return err
}

func (s *storeServer) handleExecutionNodeBootstrap(w http.ResponseWriter, r *http.Request, session storeSession) bool {
	switch {
	case r.URL.Path == "/api/settings/execution-nodes/bootstrap-info" && r.Method == "GET":
		s.writeJSON(w, 200, s.executionBootstrapInfo(r))
		return true

	case r.URL.Path == "/api/settings/execution-nodes/ca.pem" && r.Method == "GET":
		caBytes, _ := s.readPlatformCACert()
		if len(caBytes) == 0 {
			s.failBi(w, 404,
				"当前平台未配置本地 TLS 证书文件，若由上游网关提供公信 HTTPS 证书则无需单独下载 CA",
				"No local TLS certificate is configured on this Hub; publicly trusted HTTPS certificates do not require a custom CA file")
			return true
		}
		w.Header().Set("Content-Type", "application/x-pem-file")
		w.Header().Set("Content-Disposition", "attachment; filename=platform-ca.pem")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(caBytes)
		return true

	case r.URL.Path == "/api/settings/execution-nodes/bundle" && r.Method == "POST":
		var req struct {
			NodeID    string `json:"node_id"`
			Token     string `json:"token"`
			URL       string `json:"url"`
			IncludeCA *bool  `json:"include_ca"`
		}
		if decodeBody(w, r, 16384, &req) != nil || strings.TrimSpace(req.NodeID) == "" || len(req.Token) < 40 {
			s.failBi(w, 400, "缺少节点标识或连接令牌", "Missing node ID or connection token")
			return true
		}
		hubURL := strings.TrimRight(strings.TrimSpace(req.URL), "/")
		u, uerr := url.Parse(hubURL)
		if uerr != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			s.failBi(w, 400, "平台访问地址格式无效，请填写如 https://192.168.1.10:8443", "Invalid Hub URL; expected format like https://192.168.1.10:8443")
			return true
		}
		ip := net.ParseIP(u.Hostname())
		if u.Scheme != "https" && !(u.Scheme == "http" && ip != nil && ip.IsLoopback()) {
			s.failBi(w, 400, "执行节点必须使用 HTTPS 连接平台", "Execution nodes must connect over HTTPS")
			return true
		}

		executionMu.Lock()
		d, err := s.readExecutions()
		executionMu.Unlock()
		if err != nil {
			s.fail(w, 500, err.Error())
			return true
		}
		node, ok := d.Nodes[req.NodeID]
		if !ok || !constantStoreEqual(digest([]byte(req.Token)), node.TokenHash) {
			s.failBi(w, 403, "节点凭证校验失败，请刷新或重新登记节点", "Node credential verification failed")
			return true
		}

		binFile, binInfo, err := s.openExecutionNodeBinary()
		if err != nil {
			if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
				s.failBi(w, 404,
					"当前服务端非 Linux amd64 环境，且未找到 middleware-store-linux-amd64 执行器文件（请将其放入 artifacts 目录或可执行文件同级目录）",
					"Hub is not running on Linux amd64 and middleware-store-linux-amd64 binary was not found")
			} else {
				s.fail(w, 500, "执行器文件不可读")
			}
			return true
		}
		defer binFile.Close()

		caBytes, _ := s.readPlatformCACert()
		includeCA := len(caBytes) > 0
		if req.IncludeCA != nil {
			includeCA = *req.IncludeCA && len(caBytes) > 0
		}

		cfgObj := executionRunnerConfig{
			URL:   hubURL,
			Token: req.Token,
			Root:  "/root/middleware-automation",
			State: "/var/lib/middleware-execution",
		}
		if includeCA {
			cfgObj.CAFile = "/etc/middleware-execution/platform-ca.pem"
		}
		cfgBytes, _ := json.MarshalIndent(cfgObj, "", "  ")
		cfgBytes = append(cfgBytes, '\n')

		slug := runnerBundleSlug(node.Name, node.ControllerIP)
		dirName := "mw-runner-" + slug
		fileName := dirName + ".tar.gz"
		nowTime := time.Now().UTC()

		s.auditReq(r, "execution-node-bundle", session.User, node.ID+" "+hubURL)
		w.Header().Set("Content-Type", "application/gzip")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", fileName))
		w.Header().Set("Cache-Control", "no-store")

		gz := gzip.NewWriter(w)
		tw := tar.NewWriter(gz)

		// 1. Runner binary
		binHdr := &tar.Header{
			Name:    dirName + "/middleware-store-linux-amd64",
			Mode:    0755,
			Size:    binInfo.Size(),
			ModTime: binInfo.ModTime(),
		}
		if err := tw.WriteHeader(binHdr); err != nil {
			return true
		}
		if _, err := io.Copy(tw, binFile); err != nil {
			return true
		}
		// 2. Config JSON
		if err := writeTarBytes(tw, dirName+"/execution-node.json", 0600, cfgBytes, nowTime); err != nil {
			return true
		}
		// 3. Platform CA certificate (when applicable)
		if includeCA {
			if err := writeTarBytes(tw, dirName+"/platform-ca.pem", 0644, caBytes, nowTime); err != nil {
				return true
			}
		}
		// 4. One-command background systemd installer & uninstaller
		installSh := []byte(renderRunnerInstallScript(node.Name, hubURL, includeCA))
		if err := writeTarBytes(tw, dirName+"/install.sh", 0755, installSh, nowTime); err != nil {
			return true
		}
		uninstallSh := []byte(renderRunnerUninstallScript())
		if err := writeTarBytes(tw, dirName+"/uninstall.sh", 0755, uninstallSh, nowTime); err != nil {
			return true
		}

		_ = tw.Close()
		_ = gz.Close()
		return true
	}
	return false
}

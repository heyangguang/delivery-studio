package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

func (c storeConfig) devMultiHost() bool {
	if c.LocalDev {
		return true
	}
	u, err := url.Parse(c.PublicURL)
	return err == nil && u.Hostname() == "0.0.0.0"
}

func (s *storeServer) allowedHost(reqHost string) bool {
	u, err := url.Parse(s.cfg.PublicURL)
	if err != nil || u.Host == "" {
		return false
	}
	if reqHost == u.Host {
		return true
	}
	if !s.cfg.devMultiHost() {
		return false
	}
	rh, rp, err1 := splitHostOptionalPort(reqHost)
	_, cp, err2 := splitHostOptionalPort(u.Host)
	if err1 != nil || err2 != nil || rp != cp {
		return false
	}
	return isLocalDevHostname(rh)
}

func (s *storeServer) allowedOrigin(origin, reqHost string) bool {
	if origin == s.cfg.PublicURL {
		return true
	}
	if !s.cfg.devMultiHost() {
		return false
	}
	ou, err := url.Parse(origin)
	if err != nil || (ou.Scheme != "http" && ou.Scheme != "https") || ou.User != nil || ou.Path != "" || ou.RawQuery != "" || ou.Fragment != "" {
		return false
	}
	return ou.Host == reqHost && s.allowedHost(ou.Host)
}

func splitHostOptionalPort(hostPort string) (string, string, error) {
	if h, p, err := net.SplitHostPort(hostPort); err == nil {
		return h, p, nil
	}
	if strings.HasPrefix(hostPort, "[") && strings.HasSuffix(hostPort, "]") {
		return strings.TrimSuffix(strings.TrimPrefix(hostPort, "["), "]"), "", nil
	}
	if strings.Contains(hostPort, ":") {
		return "", "", errors.New("invalid host:port")
	}
	return hostPort, "", nil
}

func isLocalDevHostname(host string) bool {
	if strings.EqualFold(host, "localhost") || host == "0.0.0.0" {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsUnspecified() {
		return true
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, a := range addrs {
		var ifIP net.IP
		switch v := a.(type) {
		case *net.IPNet:
			ifIP = v.IP
		case *net.IPAddr:
			ifIP = v.IP
		}
		if ifIP != nil && ifIP.Equal(ip) {
			return true
		}
	}
	return false
}

type peekedConn struct {
	net.Conn
	buf []byte
}

func (c *peekedConn) Read(p []byte) (int, error) {
	if len(c.buf) > 0 {
		n := copy(p, c.buf)
		c.buf = c.buf[n:]
		return n, nil
	}
	return c.Conn.Read(p)
}

type dualProtocolListener struct {
	net.Listener
	tlsCfg *tls.Config
	conns  chan net.Conn
	errs   chan error
	closed chan struct{}
	once   sync.Once
}

// newDualProtocolListener accepts both TLS (HTTPS) and plain HTTP connections on the same port
// without head-of-line blocking, used in local development when listening on 0.0.0.0.
func newDualProtocolListener(ln net.Listener, certFile, keyFile string) (net.Listener, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	d := &dualProtocolListener{
		Listener: ln,
		tlsCfg: &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
			NextProtos:   []string{"http/1.1"},
		},
		conns:  make(chan net.Conn, 64),
		errs:   make(chan error, 1),
		closed: make(chan struct{}),
	}
	go d.pump()
	return d, nil
}

func (d *dualProtocolListener) pump() {
	for {
		raw, err := d.Listener.Accept()
		if err != nil {
			select {
			case d.errs <- err:
			default:
			}
			return
		}
		go func(c net.Conn) {
			_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
			var first [1]byte
			n, rerr := c.Read(first[:])
			_ = c.SetReadDeadline(time.Time{})
			if n == 0 && rerr != nil {
				_ = c.Close()
				return
			}
			pc := &peekedConn{Conn: c, buf: append([]byte(nil), first[:n]...)}
			var out net.Conn = pc
			if n == 1 && first[0] == 0x16 {
				out = tls.Server(pc, d.tlsCfg)
			}
			select {
			case d.conns <- out:
			case <-d.closed:
				_ = out.Close()
			}
		}(raw)
	}
}

func (d *dualProtocolListener) Accept() (net.Conn, error) {
	select {
	case c := <-d.conns:
		return c, nil
	case err := <-d.errs:
		return nil, err
	case <-d.closed:
		return nil, net.ErrClosed
	}
}

func (d *dualProtocolListener) Close() error {
	var err error
	d.once.Do(func() {
		close(d.closed)
		err = d.Listener.Close()
	})
	return err
}

// ensureDevTLSCert creates a local self-signed TLS certificate covering localhost, loopback,
// and all current host network interfaces if certPath/keyPath do not yet exist, or refreshes
// an existing auto-generated dev cert ("middleware-hub-dev") when host IPv4 addresses change.
func ensureDevTLSCert(certPath, keyPath string) error {
	ips := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1"), net.ParseIP("0.0.0.0")}
	seen := map[string]bool{"127.0.0.1": true, "::1": true, "0.0.0.0": true}
	var activeIPv4 []string
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok && ipnet.IP != nil {
				s := ipnet.IP.String()
				if !seen[s] {
					seen[s] = true
					ips = append(ips, ipnet.IP)
				}
				if v4 := ipnet.IP.To4(); v4 != nil && !v4.IsLoopback() && !v4.IsLinkLocalUnicast() {
					activeIPv4 = append(activeIPv4, v4.String())
				}
			}
		}
	}
	if fileExistsRegular(certPath) && fileExistsRegular(keyPath) {
		needRefresh := false
		if raw, err := os.ReadFile(certPath); err == nil {
			if blk, _ := pem.Decode(raw); blk != nil {
				if parsed, perr := x509.ParseCertificate(blk.Bytes); perr == nil && parsed.Subject.CommonName == "middleware-hub-dev" {
					if time.Until(parsed.NotAfter) < 30*24*time.Hour {
						needRefresh = true
					} else {
						certIPs := map[string]bool{}
						for _, ip := range parsed.IPAddresses {
							certIPs[ip.String()] = true
						}
						for _, ipStr := range activeIPv4 {
							if !certIPs[ipStr] {
								needRefresh = true
								break
							}
						}
					}
				}
			}
		}
		if !needRefresh {
			return nil
		}
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	tmpl := x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "middleware-hub-dev"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(3650 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(certPath), 0o700); err != nil {
		return err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		return err
	}
	return os.WriteFile(keyPath, keyPEM, 0o600)
}

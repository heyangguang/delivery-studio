package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// The public listener stays alive across worker updates. Only one worker ever
// owns application state. Update waits for requests and background work to finish;
// arrivals during the short process swap wait here, without replaying POSTs.
type gatewayGate struct {
	mu     sync.Mutex
	active int
	resume chan struct{}
}

func (g *gatewayGate) enter(ctx context.Context) bool {
	for {
		g.mu.Lock()
		if g.resume == nil {
			g.active++
			g.mu.Unlock()
			return true
		}
		ready := g.resume
		g.mu.Unlock()
		select {
		case <-ready:
		case <-ctx.Done():
			return false
		}
	}
}
func (g *gatewayGate) leave() { g.mu.Lock(); g.active--; g.mu.Unlock() }
func (g *gatewayGate) freeze() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active != 0 || g.resume != nil {
		return false
	}
	g.resume = make(chan struct{})
	return true
}
func (g *gatewayGate) thaw() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.resume != nil {
		close(g.resume)
		g.resume = nil
	}
}

type trackedWork struct {
	sync.WaitGroup
	count atomic.Int64
}

func (w *trackedWork) Add(n int) { w.count.Add(int64(n)); w.WaitGroup.Add(n) }
func (w *trackedWork) Done()     { w.count.Add(-1); w.WaitGroup.Done() }

func retainWebAssets(dir string) error {
	return fs.WalkDir(storeAssets, "store_assets/assets", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		b, err := storeAssets.ReadFile(path)
		if err != nil {
			return err
		}
		target := filepath.Join(dir, ".web-assets", strings.TrimPrefix(path, "store_assets/assets/"))
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		// Asset names are content hashes; never replace an older open page's bytes.
		f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if os.IsExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		_, err = f.Write(b)
		closeErr := f.Close()
		if err != nil {
			os.Remove(target)
			return err
		}
		return closeErr
	})
}

func gatewayWorkerHandler(s *storeServer) http.Handler {
	var active atomic.Int64
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only exposed on the inherited private Unix socket (directory mode 0700).
		if r.URL.Path == "/__gateway/idle" {
			if active.Load() != 0 || s.wg.count.Load() != 0 {
				w.WriteHeader(http.StatusConflict)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		active.Add(1)
		defer active.Add(-1)
		if addr := r.Header.Get("X-MW-Gateway-Peer"); addr != "" {
			r.RemoteAddr = addr
		}
		r.Header.Del("X-MW-Gateway-Peer")
		s.ServeHTTP(w, r)
	})
}

type gatewayWorker struct {
	cmd            *exec.Cmd
	done           chan error
	transport      *http.Transport
	socket, binary string
	proxy          *httputil.ReverseProxy
	host           string
}

func startGatewayWorker(ctx context.Context, cfg storeConfig, config, binary, dir string) (*gatewayWorker, error) {
	sock := filepath.Join(dir, fmt.Sprintf("worker-%d.sock", time.Now().UnixNano()))
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		return nil, err
	}
	ln.SetUnlinkOnClose(false)
	file, err := ln.File()
	ln.Close()
	if err != nil {
		return nil, err
	}
	defer file.Close()
	cmd := exec.Command(binary, "store", "serve", "--config", config)
	cmd.Env = append(os.Environ(), "MW_GATEWAY_WORKER=1")
	cmd.ExtraFiles = []*os.File{file}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		os.Remove(sock)
		return nil, err
	}
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}
	u, _ := url.Parse(cfg.PublicURL)
	worker := &gatewayWorker{cmd: cmd, done: make(chan error, 1), transport: tr, socket: sock, binary: binary, host: u.Host}
	go func() { worker.done <- cmd.Wait(); close(worker.done) }()
	worker.proxy = &httputil.ReverseProxy{Rewrite: func(p *httputil.ProxyRequest) {
		p.Out.URL.Scheme = "http"
		p.Out.URL.Host = "worker"
		p.Out.Host = p.In.Host
		p.Out.Header.Set("X-MW-Gateway-Peer", p.In.RemoteAddr)
	}, Transport: tr, FlushInterval: -1}
	deadline := time.NewTimer(45 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		if worker.check("/api/version") == http.StatusOK {
			return worker, nil
		}
		select {
		case e := <-worker.done:
			tr.CloseIdleConnections()
			os.Remove(sock)
			return nil, fmt.Errorf("worker failed to start: %v", e)
		case <-deadline.C:
			cmd.Process.Kill()
			<-worker.done
			tr.CloseIdleConnections()
			os.Remove(sock)
			return nil, errors.New("worker readiness timeout")
		case <-ctx.Done():
			cmd.Process.Kill()
			<-worker.done
			tr.CloseIdleConnections()
			os.Remove(sock)
			return nil, ctx.Err()
		case <-tick.C:
		}
	}
}
func (w *gatewayWorker) check(path string) int {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://worker"+path, nil)
	req.Host = w.host
	r, e := w.transport.RoundTrip(req)
	if e != nil {
		return 0
	}
	io.Copy(io.Discard, r.Body)
	r.Body.Close()
	return r.StatusCode
}
func (w *gatewayWorker) stop() error {
	_ = w.cmd.Process.Signal(syscall.SIGTERM)
	err := <-w.done
	w.transport.CloseIdleConnections()
	os.Remove(w.socket)
	return err
}
func snapshotGatewayBinary(source, dir string) (string, error) {
	in, e := os.Open(source)
	if e != nil {
		return "", e
	}
	defer in.Close()
	out, e := os.CreateTemp(dir, "release-")
	if e != nil {
		return "", e
	}
	path := out.Name()
	_, e = io.Copy(out, in)
	if e == nil {
		e = out.Chmod(0700)
	}
	ce := out.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		os.Remove(path)
		return "", e
	}
	return path, nil
}
func serveGateway(cfg storeConfig, config string) error {
	exe, e := os.Executable()
	if e != nil {
		return e
	}
	if e := os.MkdirAll(cfg.DataDir, 0700); e != nil {
		return e
	}
	dir, e := os.MkdirTemp("", "mw-gateway-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(dir)
	binary, e := snapshotGatewayBinary(exe, dir)
	if e != nil {
		return e
	}
	worker, e := startGatewayWorker(context.Background(), cfg, config, binary, dir)
	if e != nil {
		return e
	}
	defer func() { worker.stop() }()
	var gate gatewayGate
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/__gateway/") {
			http.NotFound(w, r)
			return
		}
		if !gate.enter(r.Context()) {
			return
		}
		defer gate.leave()
		worker.proxy.ServeHTTP(w, r)
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	ln, e := net.Listen("tcp", cfg.Listen)
	if e != nil {
		return e
	}
	stopped := make(chan error, 1)
	go func() {
		if cfg.TLSCert != "" {
			stopped <- server.ServeTLS(ln, cfg.TLSCert, cfg.TLSKey)
		} else {
			stopped <- server.Serve(ln)
		}
	}()
	sig := make(chan os.Signal, 4)
	signal.Notify(sig, gatewayNotifySignals()...)
	defer signal.Stop(sig)
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	pending := ""
	updateID := time.Now().UnixNano()
	status := func(state, detail string) {
		_ = writeJSONFile(filepath.Join(cfg.DataDir, "gateway-status.json"), map[string]any{"id": updateID, "pid": os.Getpid(), "state": state, "detail": detail})
	}
	status("ready", "")
	fmt.Println("平滑更新入口已启动；更新二进制后向入口进程发送 SIGUSR2。入口 PID:", os.Getpid())
	for {
		select {
		case e := <-stopped:
			return e
		case v := <-sig:
			if !isGatewayReloadSignal(v) {
				// No timeout that would silently cut an answer. Operator may force-stop separately.
				return server.Shutdown(context.Background())
			}
			if pending != "" {
				continue
			}
			updateID = time.Now().UnixNano()
			status("waiting", "")
			pending, e = snapshotGatewayBinary(exe, dir)
			if e != nil {
				status("failed", e.Error())
				fmt.Println("更新未开始：", e)
				continue
			}
			// Reject an invalid executable before touching the running worker.
			probe, done := context.WithTimeout(context.Background(), 10*time.Second)
			e = exec.CommandContext(probe, pending, "version").Run()
			done()
			if e != nil {
				os.Remove(pending)
				pending = ""
				status("failed", e.Error())
				fmt.Println("更新包无法启动，保留当前服务：", e)
				continue
			}
			fmt.Println("更新已排队，现有回答和任务完成后切换。")
		case <-tick.C:
			if pending == "" || !gate.freeze() {
				continue
			}
			if worker.check("/__gateway/idle") != http.StatusNoContent {
				gate.thaw()
				continue
			}
			status("switching", "")
			old := worker.binary
			_ = worker.stop()
			next, err := startGatewayWorker(context.Background(), cfg, config, pending, dir)
			rolledBack := err != nil
			if err != nil {
				fmt.Println("新版本启动失败，恢复原版本：", err)
				next, err = startGatewayWorker(context.Background(), cfg, config, old, dir)
				os.Remove(pending)
			} else {
				os.Remove(old)
			}
			pending = ""
			if err != nil {
				status("failed", err.Error())
				gate.thaw()
				return err
			}
			worker = next
			gate.thaw()
			if rolledBack {
				status("rolled-back", "新版本未就绪，已恢复原版本")
			} else {
				status("ready", "")
			}
			fmt.Println("平滑更新完成，浏览器连接保持。")
		}
	}
}

package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
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
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
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

func openLoopbackWorkerListener(addrFile string) (net.Listener, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	tmp := addrFile + ".tmp"
	if err := os.WriteFile(tmp, []byte(ln.Addr().String()), 0600); err != nil {
		_ = ln.Close()
		return nil, err
	}
	if err := os.Rename(tmp, addrFile); err != nil {
		_ = os.Remove(tmp)
		_ = ln.Close()
		return nil, err
	}
	return ln, nil
}

func gatewayWorkerHandler(s *storeServer) http.Handler {
	return gatewayWorkerHandlerWithControl(s, nil, "")
}

func gatewayWorkerHandlerWithControl(s *storeServer, shutdownFn func(), token string) http.Handler {
	var active atomic.Int64
	tokenBytes := []byte(token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(tokenBytes) > 0 {
			got := []byte(r.Header.Get("X-MW-Gateway-Token"))
			if len(got) != len(tokenBytes) || subtle.ConstantTimeCompare(got, tokenBytes) != 1 {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		r.Header.Del("X-MW-Gateway-Token")
		// Internal gateway control endpoints (never exposed directly by the gateway).
		if r.URL.Path == "/__gateway/idle" {
			if active.Load() != 0 || s.wg.count.Load() != 0 {
				w.WriteHeader(http.StatusConflict)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.URL.Path == "/__gateway/shutdown" && r.Method == http.MethodPost {
			w.WriteHeader(http.StatusAccepted)
			if fl, ok := w.(http.Flusher); ok {
				fl.Flush()
			}
			if shutdownFn != nil {
				go shutdownFn()
			}
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
	cmd       *exec.Cmd
	done      chan error
	exited    chan struct{}
	exitErr   error
	transport *http.Transport
	cleanup   func()
	binary    string
	token     string
	host      string
	version   string
	buildID   string
	proxy     *httputil.ReverseProxy
}

func randomGatewayToken(nBytes int) string {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func startGatewayWorker(ctx context.Context, cfg storeConfig, config, binary, dir string) (*gatewayWorker, error) {
	token := randomGatewayToken(24)
	cmd := exec.Command(binary, "store", "serve", "--config", config)
	cmd.Env = append(os.Environ(),
		"MW_GATEWAY_WORKER=1",
		"MW_GATEWAY_TOKEN="+token,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	dial, waitAddr, cleanup, closeAfterStart, err := prepareGatewayWorkerIPC(cmd, dir)
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		closeAfterStart()
		cleanup()
		return nil, err
	}
	closeAfterStart()
	tr := &http.Transport{
		DialContext:         dial,
		DisableKeepAlives:   false,
		MaxIdleConns:        64,
		MaxIdleConnsPerHost: 64,
		IdleConnTimeout:     60 * time.Second,
	}
	u, _ := url.Parse(cfg.PublicURL)
	worker := &gatewayWorker{
		cmd:       cmd,
		done:      make(chan error, 1),
		exited:    make(chan struct{}),
		transport: tr,
		cleanup:   cleanup,
		binary:    binary,
		token:     token,
		host:      u.Host,
	}
	go func() {
		err := cmd.Wait()
		worker.exitErr = err
		worker.done <- err
		close(worker.done)
		close(worker.exited)
	}()
	worker.proxy = &httputil.ReverseProxy{
		Rewrite: func(p *httputil.ProxyRequest) {
			p.Out.URL.Scheme = "http"
			p.Out.URL.Host = "worker"
			p.Out.Host = p.In.Host
			p.Out.Header.Set("X-MW-Gateway-Peer", p.In.RemoteAddr)
			p.Out.Header.Set("X-MW-Gateway-Token", token)
		},
		Transport:     tr,
		FlushInterval: -1,
	}
	waitCtx, cancelWait := context.WithTimeout(ctx, 45*time.Second)
	defer cancelWait()
	if err := waitAddr(waitCtx, worker.done); err != nil {
		_ = cmd.Process.Kill()
		<-worker.exited
		tr.CloseIdleConnections()
		cleanup()
		return nil, err
	}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		if ver, bid, ok := worker.probeVersion(); ok {
			worker.version = ver
			worker.buildID = bid
			return worker, nil
		}
		select {
		case <-worker.exited:
			tr.CloseIdleConnections()
			cleanup()
			return nil, fmt.Errorf("worker failed to start: %v", worker.exitErr)
		case <-waitCtx.Done():
			_ = cmd.Process.Kill()
			<-worker.exited
			tr.CloseIdleConnections()
			cleanup()
			if errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
				return nil, errors.New("worker readiness timeout")
			}
			return nil, waitCtx.Err()
		case <-tick.C:
		}
	}
}

func (w *gatewayWorker) probeVersion() (string, string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://worker/api/version", nil)
	req.Host = w.host
	if w.token != "" {
		req.Header.Set("X-MW-Gateway-Token", w.token)
	}
	r, e := w.transport.RoundTrip(req)
	if e != nil {
		return "", "", false
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, r.Body)
		return "", "", false
	}
	var payload struct {
		Version string `json:"version"`
		BuildID string `json:"build_id"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload)
	return payload.Version, payload.BuildID, true
}

func (w *gatewayWorker) check(path string) int {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://worker"+path, nil)
	req.Host = w.host
	if w.token != "" {
		req.Header.Set("X-MW-Gateway-Token", w.token)
	}
	r, e := w.transport.RoundTrip(req)
	if e != nil {
		return 0
	}
	_, _ = io.Copy(io.Discard, r.Body)
	_ = r.Body.Close()
	return r.StatusCode
}

func (w *gatewayWorker) requestShutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://worker/__gateway/shutdown", nil)
	req.Host = w.host
	if w.token != "" {
		req.Header.Set("X-MW-Gateway-Token", w.token)
	}
	if r, e := w.transport.RoundTrip(req); e == nil {
		_, _ = io.Copy(io.Discard, r.Body)
		_ = r.Body.Close()
	}
}

func (w *gatewayWorker) stop() error {
	if w == nil {
		return nil
	}
	w.requestShutdown()
	signalGatewayWorkerGraceful(w.cmd)
	select {
	case <-w.exited:
	case <-time.After(30 * time.Second):
		killProcessGroup(w.cmd)
		<-w.exited
	}
	w.transport.CloseIdleConnections()
	if w.cleanup != nil {
		w.cleanup()
	}
	return w.exitErr
}

func snapshotGatewayBinary(source, dir string) (string, error) {
	in, e := os.Open(source)
	if e != nil {
		return "", e
	}
	defer in.Close()
	ext := filepath.Ext(source)
	if ext == "" && runtime.GOOS == "windows" {
		ext = ".exe"
	}
	out, e := os.CreateTemp(dir, "release-*"+ext)
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
		_ = os.Remove(path)
		return "", e
	}
	return path, nil
}

func removeFileBestEffort(path string) {
	if path == "" {
		return
	}
	for i := 0; i < 12; i++ {
		if err := os.Remove(path); err == nil || os.IsNotExist(err) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

type gatewayReloadRequest struct {
	ID     string `json:"id"`
	Binary string `json:"binary,omitempty"`
}

type gatewayStatus struct {
	ID        any    `json:"id"`
	PID       int    `json:"pid"`
	State     string `json:"state"`
	Detail    string `json:"detail"`
	Version   string `json:"version,omitempty"`
	BuildID   string `json:"build_id,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

func gatewayStatusPath(dataDir string) string {
	return filepath.Join(dataDir, "gateway-status.json")
}

func gatewayReloadPath(dataDir string) string {
	return filepath.Join(dataDir, "gateway-reload.json")
}

func probeBinaryVersion(ctx context.Context, binary string) (string, string, error) {
	out, err := exec.CommandContext(ctx, binary, "version", "--json").Output()
	if err == nil {
		var p struct {
			Version string `json:"version"`
			BuildID string `json:"build_id"`
		}
		if json.Unmarshal(out, &p) == nil && strings.TrimSpace(p.Version) != "" {
			return strings.TrimSpace(p.Version), strings.TrimSpace(p.BuildID), nil
		}
	}
	out, err = exec.CommandContext(ctx, binary, "version").Output()
	if err != nil {
		return "", "", err
	}
	ver := strings.TrimSpace(string(out))
	if ver == "" {
		return "", "", errors.New("empty version output")
	}
	return ver, "", nil
}

func serveGateway(cfg storeConfig, config string) error {
	exe, e := os.Executable()
	if e != nil {
		return e
	}
	if e := os.MkdirAll(cfg.DataDir, 0700); e != nil {
		return e
	}
	// Clear any stale reload trigger left by a previously killed gateway.
	_ = os.Remove(gatewayReloadPath(cfg.DataDir))

	dir, e := os.MkdirTemp("", "mw-gateway-")
	if e != nil {
		return e
	}
	defer func() {
		time.Sleep(50 * time.Millisecond)
		_ = os.RemoveAll(dir)
	}()
	binary, e := snapshotGatewayBinary(exe, dir)
	if e != nil {
		return e
	}
	worker, e := startGatewayWorker(context.Background(), cfg, config, binary, dir)
	if e != nil {
		return e
	}
	var curWorker atomic.Pointer[gatewayWorker]
	curWorker.Store(worker)
	defer func() {
		if w := curWorker.Load(); w != nil {
			_ = w.stop()
		}
	}()

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
		active := curWorker.Load()
		if active == nil {
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			return
		}
		active.proxy.ServeHTTP(w, r)
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	ln, e := net.Listen("tcp", cfg.Listen)
	if e != nil {
		return e
	}
	stopped := make(chan error, 1)
	go func() {
		if cfg.TLSCert != "" && cfg.devMultiHost() {
			dual, derr := newDualProtocolListener(ln, cfg.TLSCert, cfg.TLSKey)
			if derr != nil {
				_ = ln.Close()
				stopped <- derr
				return
			}
			stopped <- server.Serve(dual)
		} else if cfg.TLSCert != "" {
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
	var updateID any = time.Now().UnixNano()
	writeStatus := func(state, detail string) {
		w := curWorker.Load()
		ver, bid := version, currentBuildID()
		if w != nil && w.version != "" {
			ver = w.version
			bid = w.buildID
		}
		_ = writeJSONFile(gatewayStatusPath(cfg.DataDir), gatewayStatus{
			ID:        updateID,
			PID:       os.Getpid(),
			State:     state,
			Detail:    detail,
			Version:   ver,
			BuildID:   bid,
			UpdatedAt: time.Now().Format(time.RFC3339),
		})
	}
	writeStatus("ready", "")
	fmt.Printf("平滑热更新网关已启动（PID: %d，当前版本: v%s · #%s）。\n", os.Getpid(), worker.version, worker.buildID)
	fmt.Println("后续更新无需停止服务：Linux 可发送 SIGUSR2，Windows/Linux 均可执行 `middleware-store store reload --config <配置> --binary <新程序>`。")

	queueReload := func(sourceBin string, reqID any) {
		if pending != "" {
			return
		}
		if reqID != nil && reqID != "" {
			updateID = reqID
		} else {
			updateID = time.Now().UnixNano()
		}
		if strings.TrimSpace(sourceBin) == "" {
			sourceBin = exe
		}
		writeStatus("waiting", "")
		snap, err := snapshotGatewayBinary(sourceBin, dir)
		if err != nil {
			writeStatus("failed", err.Error())
			fmt.Println("更新未开始：", err)
			return
		}
		// Reject an invalid executable before touching the running worker.
		probeCtx, done := context.WithTimeout(context.Background(), 10*time.Second)
		ver, bid, err := probeBinaryVersion(probeCtx, snap)
		done()
		if err != nil {
			removeFileBestEffort(snap)
			writeStatus("failed", err.Error())
			fmt.Println("更新包无法启动，保留当前服务：", err)
			return
		}
		pending = snap
		if bid != "" {
			fmt.Printf("更新已排队（目标 v%s · #%s），现有回答和任务完成后无缝切换。\n", ver, bid)
		} else {
			fmt.Printf("更新已排队（目标 v%s），现有回答和任务完成后无缝切换。\n", ver)
		}
	}

	reloadPath := gatewayReloadPath(cfg.DataDir)
	for {
		activeWorker := curWorker.Load()
		var workerExited <-chan struct{}
		if activeWorker != nil && pending == "" {
			workerExited = activeWorker.exited
		}
		select {
		case e := <-stopped:
			return e
		case <-workerExited:
			// Unexpected worker exit outside a planned swap: self-heal immediately.
			if pending != "" {
				continue
			}
			fmt.Printf("检测到工作进程异常退出（%v），正在自动拉起恢复…\n", activeWorker.exitErr)
			if activeWorker.cleanup != nil {
				activeWorker.cleanup()
			}
			recovered, err := startGatewayWorker(context.Background(), cfg, config, activeWorker.binary, dir)
			if err != nil {
				writeStatus("failed", "工作进程异常退出且自动恢复失败: "+err.Error())
				return err
			}
			curWorker.Store(recovered)
			writeStatus("ready", "工作进程已自动恢复")
			fmt.Println("工作进程自动恢复完成。")
		case v := <-sig:
			if !isGatewayReloadSignal(v) {
				// No timeout that would silently cut an answer. Operator may force-stop separately.
				return server.Shutdown(context.Background())
			}
			queueReload(exe, nil)
		case <-tick.C:
			if pending == "" {
				if raw, err := os.ReadFile(reloadPath); err == nil {
					_ = os.Remove(reloadPath)
					var req gatewayReloadRequest
					if json.Unmarshal(raw, &req) == nil {
						queueReload(req.Binary, req.ID)
					} else {
						queueReload(exe, nil)
					}
				}
				continue
			}
			if !gate.freeze() {
				continue
			}
			w := curWorker.Load()
			if w != nil && w.check("/__gateway/idle") != http.StatusNoContent {
				gate.thaw()
				continue
			}
			writeStatus("switching", "")
			oldBin := ""
			if w != nil {
				oldBin = w.binary
				_ = w.stop()
			}
			next, err := startGatewayWorker(context.Background(), cfg, config, pending, dir)
			rolledBack := err != nil
			if err != nil {
				fmt.Println("新版本启动失败，恢复原版本：", err)
				removeFileBestEffort(pending)
				next, err = startGatewayWorker(context.Background(), cfg, config, oldBin, dir)
			} else {
				removeFileBestEffort(oldBin)
			}
			pending = ""
			if err != nil {
				writeStatus("failed", err.Error())
				gate.thaw()
				return err
			}
			curWorker.Store(next)
			gate.thaw()
			if rolledBack {
				writeStatus("rolled-back", "新版本未就绪，已恢复原版本")
				fmt.Printf("已回滚至原版本（v%s · #%s），浏览器连接保持。\n", next.version, next.buildID)
			} else {
				writeStatus("ready", "")
				if next.buildID != "" {
					fmt.Printf("平滑更新完成（v%s · #%s），浏览器连接保持。\n", next.version, next.buildID)
				} else {
					fmt.Printf("平滑更新完成（v%s），浏览器连接保持。\n", next.version)
				}
			}
		}
	}
}

func loadStoreDataDir(configFile string) (string, error) {
	b, err := os.ReadFile(configFile)
	if err != nil {
		return "", err
	}
	var raw struct {
		DataDir string `json:"data_dir"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return "", err
	}
	if strings.TrimSpace(raw.DataDir) == "" {
		return "", errors.New("配置文件缺少 data_dir")
	}
	dir := raw.DataDir
	if !filepath.IsAbs(dir) {
		base, err := filepath.Abs(filepath.Dir(configFile))
		if err != nil {
			return "", err
		}
		dir = filepath.Join(base, dir)
	}
	return dir, nil
}

func reloadGateway(configFile, binaryPath string, timeout time.Duration) error {
	dataDir, err := loadStoreDataDir(configFile)
	if err != nil {
		return err
	}
	statusPath := gatewayStatusPath(dataDir)
	raw, err := os.ReadFile(statusPath)
	if err != nil {
		return fmt.Errorf("未检测到运行中的热更新网关状态文件（%s）：请先以 `store supervise` 启动服务", statusPath)
	}
	var st gatewayStatus
	if err := json.Unmarshal(raw, &st); err != nil || st.PID <= 0 {
		return errors.New("网关状态文件损坏，请确认服务以 `store supervise` 模式运行")
	}
	if !isProcessAlive(st.PID) {
		return fmt.Errorf("热更新网关进程（PID %d）未运行，请先启动 `store supervise`", st.PID)
	}
	if strings.TrimSpace(binaryPath) == "" {
		binaryPath, err = os.Executable()
		if err != nil {
			return err
		}
	}
	absBin, err := filepath.Abs(binaryPath)
	if err != nil {
		return err
	}
	info, err := os.Stat(absBin)
	if err != nil || info.IsDir() {
		return fmt.Errorf("目标新版本程序不可用：%s", absBin)
	}
	probeCtx, cancelProbe := context.WithTimeout(context.Background(), 15*time.Second)
	targetVer, targetBuild, err := probeBinaryVersion(probeCtx, absBin)
	cancelProbe()
	if err != nil {
		return fmt.Errorf("新版本程序预检失败（不会触碰运行中的服务）：%w", err)
	}
	reqID := fmt.Sprintf("rel-%d-%s", time.Now().UnixNano(), randomGatewayToken(4))
	if err := writeJSONFile(gatewayReloadPath(dataDir), gatewayReloadRequest{
		ID:     reqID,
		Binary: absBin,
	}); err != nil {
		return err
	}
	fmt.Printf("已提交零中断热更新请求（网关 PID %d → 目标 v%s · #%s）…\n", st.PID, targetVer, targetBuild)
	if timeout <= 0 {
		timeout = 180 * time.Second
	}
	deadline := time.Now().Add(timeout)
	lastState := ""
	for {
		if !isProcessAlive(st.PID) {
			return fmt.Errorf("等待切换期间热更新网关进程（PID %d）已退出", st.PID)
		}
		if b, rerr := os.ReadFile(statusPath); rerr == nil {
			var cur gatewayStatus
			if json.Unmarshal(b, &cur) == nil && fmt.Sprint(cur.ID) == reqID {
				if cur.State != lastState {
					switch cur.State {
					case "waiting":
						fmt.Println("状态：已排队，等待现有请求与 AI 对话自然结束…")
					case "switching":
						fmt.Println("状态：正在无缝切换工作进程（监听端口保持不中断）…")
					}
					lastState = cur.State
				}
				switch cur.State {
				case "ready":
					fmt.Printf("热更新完成：当前已切换至 v%s · #%s（端口全程未中断）。\n", cur.Version, cur.BuildID)
					return nil
				case "failed", "rolled-back":
					return fmt.Errorf("热更新未生效（状态 %s）：%s", cur.State, cur.Detail)
				}
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("等待热更新完成超时（%s）；若仍有长耗时任务在执行，网关会在任务结束后自动完成切换", timeout)
		}
		time.Sleep(150 * time.Millisecond)
	}
}

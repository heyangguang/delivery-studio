package server

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type executionRunnerConfig struct {
	Roots  []string `json:"roots,omitempty"`
	URL    string   `json:"url"`
	Token  string   `json:"token"`
	Root   string   `json:"root"`
	State  string   `json:"state"`
	CAFile string   `json:"ca_file"`
}
type executionJournal struct {
	Root    string         `json:"root,omitempty"`
	Work    executionWork  `json:"work"`
	Phase   string         `json:"phase"`
	PID     int            `json:"pid"`
	Offsets map[string]int `json:"offsets"`
}
type executionRunner struct {
	cfg  executionRunnerConfig
	http *http.Client
	stop atomic.Bool
}

// Keep only a bounded local diagnostic tail. Callback logs are the evidence.
type executionOutput struct {
	file *os.File
	mu   sync.Mutex
	size int
}

func (o *executionOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	n := len(p)
	const limit = 1 << 20
	if o.size+len(p) > limit {
		if e := o.file.Truncate(0); e != nil {
			return 0, e
		}
		if _, e := o.file.Seek(0, 0); e != nil {
			return 0, e
		}
		o.size = 0
	}
	if len(p) > limit {
		p = p[len(p)-limit:]
	}
	written, e := o.file.Write(p)
	o.size += written
	if e != nil {
		return 0, e
	}
	return n, nil
}

func logAgent(level, format string, args ...any) {
	line := fmt.Sprintf("%s %s %s\n", time.Now().Format(time.RFC3339), level, fmt.Sprintf(format, args...))
	if level == "WARN" || level == "ERROR" {
		_, _ = os.Stderr.WriteString(line)
		return
	}
	_, _ = os.Stdout.WriteString(line)
}

func executionNodeCommand(args []string) error {
	f := flag.NewFlagSet("execution-node", flag.ContinueOnError)
	config := f.String("config", "execution-node.json", "path to execution node config file (mode 0600)")
	check := f.Bool("check", false, "verify config, TLS trust, and platform connectivity then exit")
	reconcile := f.String("ack-stopped", "", "acknowledge a manually verified stopped attempt ID after interruption")
	note := f.String("note", "", "verification note explaining how on-site tasks were confirmed stopped")
	if e := f.Parse(args); e != nil {
		return e
	}
	info, e := os.Stat(*config)
	if e != nil {
		return e
	}
	if info.Mode().Perm()&0077 != 0 {
		return errors.New("config file contains credentials and must have mode 0600 (run: chmod 600 " + *config + ")")
	}
	b, e := os.ReadFile(*config)
	if e != nil {
		return e
	}
	var cfg executionRunnerConfig
	if e = json.Unmarshal(b, &cfg); e != nil {
		return fmt.Errorf("invalid config JSON: %w", e)
	}
	runner, e := newExecutionRunner(cfg)
	if e != nil {
		return e
	}
	if *check {
		start := time.Now()
		if e = runner.call("poll", map[string]any{"version": version, "protocol": 3, "heartbeat": true, "probe": collectAgentHostProbe(3)}, nil); e != nil {
			return fmt.Errorf("platform connectivity check failed (%s): %w", runner.cfg.URL, e)
		}
		logAgent("INFO", "connectivity check passed version=%s url=%s latency=%dms", version, runner.cfg.URL, time.Since(start).Milliseconds())
		return nil
	}
	lock, e := os.OpenFile(filepath.Join(runner.cfg.State, "runner.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer lock.Close()
	if e = lockFileExclusive(lock, true); e != nil {
		return errors.New("another execution-node instance is already running for state dir " + runner.cfg.State)
	}
	defer unlockFileExclusive(lock)
	if *reconcile != "" {
		return runner.reconcile(*reconcile, *note)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		sig := <-signals
		logAgent("INFO", "received signal=%s, draining active task before exit", sig)
		runner.stop.Store(true)
	}()
	logAgent("INFO", "execution-node started version=%s url=%s root=%s", version, runner.cfg.URL, runner.cfg.Root)
	connected := false
	everConnected := false
	lastErr := ""
	lastErrAt := time.Time{}
	logPollErr := func(prefix string, err error) {
		msg := err.Error()
		if msg != lastErr || time.Since(lastErrAt) >= 30*time.Second {
			logAgent("WARN", "%s: %s (retrying)", prefix, msg)
			lastErr = msg
			lastErrAt = time.Now()
		}
		connected = false
	}
	var cachedProbe *agentHostProbe
	var probeAt time.Time
	for !runner.stop.Load() {
		if e = runner.recoverOutbox(); e != nil {
			logPollErr("outbox recovery pending", e)
			time.Sleep(5 * time.Second)
			continue
		}
		if cachedProbe == nil || time.Since(probeAt) >= 15*time.Second {
			cachedProbe = collectAgentHostProbe(3)
			probeAt = time.Now()
		}
		var resp struct {
			Work          *executionWork         `json:"work"`
			Preparation   *executionPreparation  `json:"preparation"`
			RehearsalTask *rehearsalExecDispatch `json:"rehearsal_task"`
			CancelTasks   []string               `json:"cancel_tasks"`
		}
		pollStart := time.Now()
		e = runner.call("poll", map[string]any{"version": version, "protocol": 3, "probe": cachedProbe}, &resp)
		if e != nil {
			logPollErr("platform poll failed", e)
		} else {
			if !connected {
				latency := time.Since(pollStart).Milliseconds()
				if everConnected {
					logAgent("INFO", "reconnected to platform url=%s latency=%dms", runner.cfg.URL, latency)
				} else {
					logAgent("INFO", "connected to platform url=%s latency=%dms, polling for authorized tasks", runner.cfg.URL, latency)
				}
				connected = true
				everConnected = true
				lastErr = ""
			}
			if resp.Preparation != nil {
				logAgent("INFO", "running pre-check id=%s cluster=%s", resp.Preparation.ID, resp.Preparation.Snapshot.Cluster)
				e = runner.checkPreparation(*resp.Preparation)
				if e != nil {
					logAgent("WARN", "pre-check result queued for retry id=%s err=%v", resp.Preparation.ID, e)
				} else {
					logAgent("INFO", "pre-check completed id=%s cluster=%s", resp.Preparation.ID, resp.Preparation.Snapshot.Cluster)
				}
			} else if resp.Work != nil {
				logAgent("INFO", "executing run=%s step=%s", resp.Work.Run.ID, resp.Work.Step.Key)
				e = runner.execute(*resp.Work)
				if e != nil {
					logAgent("WARN", "step execution halted run=%s step=%s err=%v", resp.Work.Run.ID, resp.Work.Step.Key, e)
				} else {
					logAgent("INFO", "step completed run=%s step=%s", resp.Work.Run.ID, resp.Work.Step.Key)
				}
			} else if resp.RehearsalTask != nil {
				logAgent("INFO", "executing rehearsal task=%s kind=%s targets=%d", resp.RehearsalTask.TaskID, resp.RehearsalTask.Kind, len(resp.RehearsalTask.Targets))
				e = runner.executeRehearsalTask(*resp.RehearsalTask)
				if e != nil {
					logAgent("WARN", "rehearsal task ended task=%s err=%v", resp.RehearsalTask.TaskID, e)
				} else {
					logAgent("INFO", "rehearsal task completed task=%s", resp.RehearsalTask.TaskID)
				}
			}
		}
		if runner.stop.Load() {
			break
		}
		time.Sleep(3 * time.Second)
	}
	logAgent("INFO", "execution-node stopped cleanly")
	return nil
}
func newExecutionRunner(cfg executionRunnerConfig) (*executionRunner, error) {
	u, e := url.Parse(cfg.URL)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return nil, errors.New("invalid platform url in config")
	}
	host := net.ParseIP(u.Hostname())
	if u.Scheme != "https" && !(u.Scheme == "http" && host != nil && host.IsLoopback()) {
		return nil, errors.New("platform url must use https (http is only allowed for loopback testing)")
	}
	if len(cfg.Token) < 40 || !filepath.IsAbs(cfg.Root) {
		return nil, errors.New("config requires a valid token and an absolute root path")
	}
	cfg.Root = filepath.Clean(cfg.Root)
	if cfg.State == "" {
		cfg.State = filepath.Join(cfg.Root, ".execution-node")
	}
	if !filepath.IsAbs(cfg.State) {
		return nil, errors.New("state must be an absolute path")
	}
	if e = os.MkdirAll(cfg.State, 0700); e != nil {
		return nil, e
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.CAFile != "" {
		roots, e := x509.SystemCertPool()
		if e != nil {
			roots = x509.NewCertPool()
		}
		b, e := os.ReadFile(cfg.CAFile)
		if e != nil {
			return nil, fmt.Errorf("failed to read ca_file %s: %w (download platform-ca.pem from the Hub or remove ca_file if using a publicly trusted cert)", cfg.CAFile, e)
		}
		if !roots.AppendCertsFromPEM(b) {
			return nil, fmt.Errorf("invalid PEM certificate in ca_file %s", cfg.CAFile)
		}
		tr.TLSClientConfig.RootCAs = roots
	}
	return &executionRunner{cfg: cfg, http: &http.Client{Transport: tr, Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("execution-node API does not allow HTTP redirects") }}}, nil
}
func (r *executionRunner) call(endpoint string, in, out any) error {
	b, e := json.Marshal(in)
	if e != nil {
		return e
	}
	req, e := http.NewRequest("POST", strings.TrimRight(r.cfg.URL, "/")+"/api/execution-agent/"+endpoint, bytes.NewReader(b))
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+r.cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	res, e := r.http.Do(req)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		var msg struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&msg)
		return fmt.Errorf("HTTP %d: %s", res.StatusCode, msg.Error)
	}
	if out == nil {
		_, e = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		return e
	}
	return json.NewDecoder(io.LimitReader(res.Body, 64<<20)).Decode(out)
}
func (r *executionRunner) dir(id string) string { return filepath.Join(r.cfg.State, id) }
func (r *executionRunner) save(j executionJournal) error {
	return atomicExecutionJSON(filepath.Join(r.dir(j.Work.Step.ID), "receipt.json"), j)
}
func (r *executionRunner) load(id string) (executionJournal, error) {
	var j executionJournal
	b, e := os.ReadFile(filepath.Join(r.dir(id), "receipt.json"))
	if e != nil {
		return j, e
	}
	e = json.Unmarshal(b, &j)
	return j, e
}
func (r *executionRunner) eventFiles(id string) ([]string, error) {
	paths, e := filepath.Glob(filepath.Join(r.dir(id), "event-*.json"))
	sort.Strings(paths)
	return paths, e
}
func (r *executionRunner) emit(j executionJournal, kind, text, reason string, code *int) error {
	return r.emitCursor(j, kind, text, reason, code, "", 0)
}

// Log content and its consumed byte offset share one durable record. A crash
// before receipt.json is saved must not cause already queued lines to repeat.
type queuedExecutionEvent struct {
	executionEvent
	LogPath string `json:"local_log_path,omitempty"`
	LogEnd  int    `json:"local_log_end,omitempty"`
}

func (r *executionRunner) emitCursor(j executionJournal, kind, text, reason string, code *int, logPath string, logEnd int) error {
	files, e := r.eventFiles(j.Work.Step.ID)
	if e != nil {
		return e
	}
	seq := len(files) + 1
	if seq > 4096 {
		return errors.New("单步日志事件超过上限，请保留本地日志并核实结果")
	}
	ev := executionEvent{Run: j.Work.Run.ID, Attempt: j.Work.Step.ID, Seq: seq, At: executionNow(), Kind: kind, Text: text, Reason: reason, ExitCode: code}
	return atomicExecutionJSON(filepath.Join(r.dir(j.Work.Step.ID), fmt.Sprintf("event-%06d.json", seq)), queuedExecutionEvent{ev, logPath, logEnd})
}
func (r *executionRunner) recoverLogOffsets(j *executionJournal) error {
	if j.Offsets == nil {
		j.Offsets = map[string]int{}
	}
	paths, e := r.eventFiles(j.Work.Step.ID)
	if e != nil {
		return e
	}
	for _, path := range paths {
		b, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		var ev queuedExecutionEvent
		if e = json.Unmarshal(b, &ev); e != nil {
			return e
		}
		if ev.LogPath != "" && ev.LogEnd > j.Offsets[ev.LogPath] {
			j.Offsets[ev.LogPath] = ev.LogEnd
		}
	}
	return nil
}
func (r *executionRunner) flush(id string) error {
	if e := r.recoverQueuedLogs(id); e != nil {
		return e
	}
	files, e := r.eventFiles(id)
	if e != nil {
		return e
	}
	var ack int
	b, _ := os.ReadFile(filepath.Join(r.dir(id), "ack.json"))
	_ = json.Unmarshal(b, &ack)
	for _, p := range files {
		var ev executionEvent
		b, e = os.ReadFile(p)
		if e != nil {
			return e
		}
		if e = json.Unmarshal(b, &ev); e != nil {
			return e
		}
		if ev.Seq <= ack {
			continue
		}
		var reply struct {
			Ack   int    `json:"ack"`
			State string `json:"state"`
		}
		if e = r.call("event", ev, &reply); e != nil {
			return e
		}
		if reply.Ack != ev.Seq {
			return errors.New("回传确认序号不匹配")
		}
		if e = atomicExecutionJSON(filepath.Join(r.dir(id), "ack.json"), reply.Ack); e != nil {
			return e
		}
		ack = reply.Ack
		if reply.State == "unknown" {
			if j, e := r.load(id); e == nil {
				j.Phase = "unknown"
				if e = r.save(j); e != nil {
					return e
				}
			}
		}
	}
	return nil
}
func (r *executionRunner) recoverOutbox() error {
	ents, e := os.ReadDir(r.cfg.State)
	if e != nil {
		return e
	}
	for _, ent := range ents {
		if !ent.IsDir() {
			continue
		}
		if ent.Name() == "access" || ent.Name() == "preparations" {
			continue
		}
		j, e := r.load(ent.Name())
		if e != nil {
			return e
		}
		if e = r.flush(j.Work.Step.ID); e != nil {
			return e
		}
		j, e = r.load(ent.Name())
		if e != nil {
			return e
		}
		events, _ := r.eventFiles(j.Work.Step.ID)
		if len(events) > 0 {
			raw, _ := os.ReadFile(events[len(events)-1])
			var last executionEvent
			_ = json.Unmarshal(raw, &last)
			if (last.Kind == "finished" && j.Phase != "unknown") || last.Kind == "stopped" || last.Kind == "blocked" {
				j.Phase = "finished"
				if e = r.save(j); e != nil {
					return e
				}
			}
			if last.Kind == "unknown" {
				j.Phase = "unknown"
				if e = r.save(j); e != nil {
					return e
				}
			}
		}
		if j.Phase == "starting" || j.Phase == "running" {
			if e = r.recoverLogOffsets(&j); e != nil {
				return e
			}
			root := r.cfg.Root
			if j.Root != "" {
				root = j.Root
			}
			project := filepath.Join(root, "projects", ".hub-"+j.Work.Run.ID)
			if e = r.collect(&j, project, false); e != nil {
				return e
			}
			// A crash after remote writes is ambiguous. Never restart the command.
			if e = r.emit(j, "unknown", "", "执行节点上次异常退出，不能确认现场状态；请核实后使用 --ack-stopped", nil); e != nil {
				return e
			}
			j.Phase = "unknown"
			if e = r.save(j); e != nil {
				return e
			}
			if e = r.flush(j.Work.Step.ID); e != nil {
				return e
			}
		}
	}
	return nil
}
func localExecutionIP(ip string) bool {
	addrs, e := net.InterfaceAddrs()
	if e != nil {
		return false
	}
	for _, a := range addrs {
		v, _, _ := net.ParseCIDR(a.String())
		if v != nil && v.Equal(net.ParseIP(ip)) {
			return true
		}
	}
	return false
}
func (r *executionRunner) prepare(w executionWork) (string, error) {
	b, _ := json.Marshal(w.Snapshot)
	if digest(b) != w.Run.Snapshot {
		return "", errors.New("执行快照摘要不匹配")
	}
	if !executionID.MatchString(w.Run.ID) || !executionID.MatchString(w.Step.ID) || !safeName(w.Snapshot.Project) || !executionRelative(w.Step.Playbook) {
		return "", errors.New("执行路径无效")
	}
	if !localExecutionIP(w.Snapshot.ControllerIP) {
		return "", errors.New("执行节点必须运行在这份交付的控制机器上，不能把远程机器误作本机")
	}
	if w.Snapshot.RuntimeRoot != "" && filepath.Clean(w.Snapshot.RuntimeRoot) != filepath.Clean(r.cfg.Root) {
		return "", errors.New("执行目录与这份交付不一致，请先登记本集群的运行目录")
	}
	rootInfo, e := os.Lstat(r.cfg.Root)
	if e != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("运行包根目录无效或为符号链接")
	}
	binary := filepath.Join(r.cfg.Root, "bin", "ansible-playbook")
	info, e := os.Stat(binary)
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return "", errors.New("请先在控制节点按交付手册完成离线运行环境安装，缺少 bin/ansible-playbook")
	}
	for path, expected := range w.Snapshot.RuntimeFiles {
		if !executionRelative(path) {
			return "", errors.New("运行环境标识路径无效")
		}
		data, e := os.ReadFile(filepath.Join(r.cfg.Root, filepath.FromSlash(path)))
		if e != nil || digest(data) != expected {
			return "", fmt.Errorf("运行环境与本次交付不一致：%s；请先准备对应版本", path)
		}
	}
	project := filepath.Join(r.cfg.Root, "projects", ".hub-"+w.Run.ID)
	if e = os.MkdirAll(project, 0700); e != nil {
		return "", e
	}
	for p, content := range w.Snapshot.Files {
		if !executionRelative(p) || p == "secrets" || p == "logs" || strings.HasPrefix(p, "secrets/") || strings.HasPrefix(p, "logs/") {
			return "", errors.New("快照包含不允许的路径")
		}
		dest := filepath.Join(project, filepath.FromSlash(p))
		for parent := filepath.Dir(dest); parent != r.cfg.Root; parent = filepath.Dir(parent) {
			if st, e := os.Lstat(parent); e == nil && st.Mode()&os.ModeSymlink != 0 {
				return "", errors.New("执行目录不能包含符号链接")
			}
		}
		if st, e := os.Lstat(dest); e == nil {
			if !st.Mode().IsRegular() {
				return "", errors.New("快照文件类型不匹配")
			}
			old, e := os.ReadFile(dest)
			if e != nil || !bytes.Equal(old, content) {
				return "", errors.New("本地执行快照被修改，已停止：" + p)
			}
			continue
		} else if !os.IsNotExist(e) {
			return "", e
		}
		if e = os.MkdirAll(filepath.Dir(dest), 0700); e != nil {
			return "", e
		}
		if e = os.WriteFile(dest, content, 0600); e != nil {
			return "", e
		}
	}
	// Reuse runtime secrets from the original prepared project; never upload them.
	secrets := filepath.Join(r.cfg.Root, "projects", w.Snapshot.Project, "secrets")
	if e = os.MkdirAll(secrets, 0700); e != nil {
		return "", e
	}
	link := filepath.Join(project, "secrets")
	if got, e := os.Readlink(link); e == nil {
		if got != secrets {
			return "", errors.New("密码目录关联错误")
		}
	} else if os.IsNotExist(e) {
		if e = os.Symlink(secrets, link); e != nil {
			return "", e
		}
	} else {
		return "", errors.New("密码目录不是预期的关联")
	}
	if w.Step.ExtraVars == nil {
		w.Step.ExtraVars = map[string]any{}
	}
	if e = r.writeManagedTrust(w.Snapshot, project); e != nil {
		return "", e
	}
	if e = atomicExecutionJSON(filepath.Join(project, ".execution-vars.json"), w.Step.ExtraVars); e != nil {
		return "", e
	}
	return project, nil
}
func (r *executionRunner) execute(w executionWork) error {
	if root, e := r.matchingRoot(w.Snapshot); e == nil && root != r.cfg.Root {
		cfg := r.cfg
		cfg.Root = root
		cfg.Roots = nil
		other := &executionRunner{cfg: cfg, http: r.http}
		return other.execute(w)
	}
	id := w.Step.ID
	if !executionID.MatchString(id) {
		return errors.New("步骤尝试标识不合规")
	}
	j, e := r.load(id)
	if e == nil {
		if j.Work.Run.Snapshot != w.Run.Snapshot {
			return errors.New("相同尝试的快照发生变化")
		}
		if j.Phase != "received" {
			if w.Step.State == "unknown" {
				j.Phase = "unknown"
				if e = r.save(j); e != nil {
					return e
				}
			}
			return r.flush(id)
		}
	} else if os.IsNotExist(e) {
		if w.Step.State != "leased" {
			return errors.New("平台已有开始记录但本地没有收据，请人工核实；不会重复执行")
		}
		j = executionJournal{Root: r.cfg.Root, Work: w, Phase: "received", Offsets: map[string]int{}}
		if e = r.save(j); e != nil {
			return e
		}
	} else {
		return e
	}
	project, e := r.prepare(w)
	if e != nil {
		if e2 := r.emit(j, "blocked", "", "尚未启动命令："+e.Error(), nil); e2 != nil {
			return e2
		}
		j.Phase = "finished"
		if e2 := r.save(j); e2 != nil {
			return e2
		}
		_ = r.flush(id)
		return e
	}
	if w.Step.Timeout < 1 || w.Step.Timeout > 86400 {
		return errors.New("步骤超时设置无效")
	}
	j.Phase = "starting"
	if e = r.save(j); e != nil {
		return e
	}
	binary := filepath.Join(r.cfg.Root, "bin", "ansible-playbook")
	runtimeBytes, e := os.ReadFile(binary)
	if e != nil {
		return e
	}
	if e = r.emit(j, "started", "", "运行器 "+version+"；bin/ansible-playbook sha256="+digest(runtimeBytes), nil); e != nil {
		return e
	}
	if e = r.flush(id); e != nil {
		return e
	} // No acknowledgement, no process launch.
	cmd := exec.Command(binary, "-i", "inventory/hosts.yml", w.Step.Playbook, "-e", "@.execution-vars.json")
	cmd.Dir = project
	cmd.Env = []string{"PATH=" + filepath.Join(r.cfg.Root, "bin") + ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "LANG=C.UTF-8", "ANSIBLE_CONFIG=" + filepath.Join(project, "ansible.cfg"), "ANSIBLE_NOCOLOR=1", "ANSIBLE_HOST_KEY_CHECKING=True", "ANSIBLE_SSH_USETTY=False"}
	setProcessGroup(cmd)
	// Only callback output (honours no_log) is uploaded, never raw stdout.
	diagnostic, err := os.OpenFile(filepath.Join(r.dir(id), "runner-output.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer diagnostic.Close()
	output := &executionOutput{file: diagnostic}
	cmd.Stdout = output
	cmd.Stderr = output
	if e = cmd.Start(); e != nil {
		code := -1
		_ = r.emit(j, "finished", "", "无法启动运行器", &code)
		j.Phase = "finished"
		_ = r.save(j)
		_ = r.flush(id)
		return e
	}
	j.Phase = "running"
	j.PID = cmd.Process.Pid
	if e = r.save(j); e != nil {
		killProcessGroup(cmd)
		_ = cmd.Wait()
		return e
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	deadline := time.NewTimer(time.Duration(w.Step.Timeout) * time.Second)
	defer deadline.Stop()
	heartbeatDone := make(chan struct{})
	defer close(heartbeatDone)
	go func() {
		tick := time.NewTicker(8 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-heartbeatDone:
				return
			case <-tick.C:
				_ = r.call("poll", map[string]any{"version": version, "protocol": 3, "heartbeat": true}, nil)
			}
		}
	}()
	timedOut := false
	for {
		select {
		case <-ticker.C:
			if e = r.collect(&j, project, false); e != nil {
				killProcessGroup(cmd)
				<-done
				return e
			}
			_ = r.flush(id)
		case <-deadline.C:
			timedOut = true
			killProcessGroup(cmd)
			<-done
			goto finished
		case <-done:
			goto finished
		}
	}
finished:
	if e = r.collect(&j, project, true); e != nil {
		return e
	}
	if timedOut {
		e = r.emit(j, "unknown", "", "超过执行时限；本机运行器已停止，远程任务是否结束仍需核实", nil)
		j.Phase = "unknown"
	} else {
		code := cmd.ProcessState.ExitCode()
		if code != 0 {
			raw, _ := os.ReadFile(filepath.Join(r.dir(id), "runner-output.log"))
			if len(raw) > 16000 {
				raw = raw[len(raw)-16000:]
			}
			if len(raw) > 0 {
				if e = r.emit(j, "log", "运行器诊断：\n"+r.mask(string(raw), w.Snapshot.Project), "", nil); e != nil {
					return e
				}
			}
		}
		e = r.emit(j, "finished", "", "", &code)
		j.Phase = "finished"
	}
	if e != nil {
		return e
	}
	if e = r.save(j); e != nil {
		return e
	}
	return r.flush(id)
}
func (r *executionRunner) collect(j *executionJournal, project string, final bool) error {
	paths, _ := filepath.Glob(filepath.Join(project, "logs", "*.log"))
	sort.Strings(paths)
	for _, p := range paths {
		b, e := os.ReadFile(p)
		if e != nil {
			return e
		}
		if len(b) > maxRunLogFile {
			return errors.New("日志超过单步 20 MiB 上限，执行已停止，请核实现场")
		}
		log := parseRunLog(filepath.Base(p), b)
		if log.Playbook != j.Work.Step.Playbook {
			continue
		}
		offset := j.Offsets[p]
		if offset > len(b) {
			return errors.New("执行日志被截断")
		}
		end := len(b)
		if !final {
			last := bytes.LastIndexByte(b, '\n')
			if last < offset {
				continue
			}
			end = last + 1
		}
		if end <= offset {
			continue
		}
		// Mask before splitting so a credential straddling a chunk boundary stays hidden.
		masker := r
		if j.Root != "" && j.Root != r.cfg.Root {
			cfg := r.cfg
			cfg.Root = j.Root
			masker = &executionRunner{cfg: cfg, http: r.http}
		}
		if e = r.queueLog(*j, masker.mask(string(b[offset:end]), j.Work.Snapshot.Project), p, end); e != nil {
			return e
		}
		j.Offsets[p] = end
		if e = r.save(*j); e != nil {
			return e
		}
	}
	return nil
}

func (r *executionRunner) queueLog(j executionJournal, text, path string, end int) error {
	files, e := r.eventFiles(j.Work.Step.ID)
	if e != nil {
		return e
	}
	seq := len(files) + 1
	var batch []queuedExecutionEvent
	for len(text) > 0 {
		n := len(text)
		if n > 24000 {
			n = 24000
			for (text[n] & 0xc0) == 0x80 {
				n--
			}
		}
		if seq > 4096 {
			return errors.New("单步日志事件超过上限，请保留本地日志并核实结果")
		}
		ev := executionEvent{Run: j.Work.Run.ID, Attempt: j.Work.Step.ID, Seq: seq, At: executionNow(), Kind: "log", Text: text[:n]}
		batch = append(batch, queuedExecutionEvent{executionEvent: ev})
		seq++
		text = text[n:]
	}
	if len(batch) == 0 {
		return nil
	}
	batch[len(batch)-1].LogPath, batch[len(batch)-1].LogEnd = path, end
	if e = atomicExecutionJSON(filepath.Join(r.dir(j.Work.Step.ID), fmt.Sprintf("logbatch-%06d.json", batch[0].Seq)), batch); e != nil {
		return e
	}
	return r.recoverQueuedLogs(j.Work.Step.ID)
}
func (r *executionRunner) recoverQueuedLogs(id string) error {
	paths, e := filepath.Glob(filepath.Join(r.dir(id), "logbatch-*.json"))
	if e != nil {
		return e
	}
	sort.Strings(paths)
	for _, path := range paths {
		b, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		var batch []queuedExecutionEvent
		if e = json.Unmarshal(b, &batch); e != nil {
			return e
		}
		for _, ev := range batch {
			file := filepath.Join(r.dir(id), fmt.Sprintf("event-%06d.json", ev.Seq))
			if old, e := os.ReadFile(file); e == nil {
				var prior queuedExecutionEvent
				if json.Unmarshal(old, &prior) != nil {
					return errors.New("本地日志事件不可读")
				}
				a, _ := json.Marshal(prior)
				b, _ := json.Marshal(ev)
				if !bytes.Equal(a, b) {
					return errors.New("本地日志事件冲突")
				}
			} else if !os.IsNotExist(e) {
				return e
			} else if e = atomicExecutionJSON(file, ev); e != nil {
				return e
			}
		}
		if e = os.Remove(path); e != nil {
			return e
		}
	}
	return nil
}
func (r *executionRunner) mask(text, project string) string {
	root := filepath.Join(r.cfg.Root, "projects", project, "secrets")
	_ = filepath.WalkDir(root, func(path string, ent os.DirEntry, e error) error {
		if e != nil || ent.IsDir() || ent.Type()&os.ModeSymlink != 0 {
			return nil
		}
		b, e := os.ReadFile(path)
		if e == nil && len(b) >= 4 && len(b) < 65536 {
			v := strings.TrimSpace(string(b))
			if len(v) >= 4 {
				text = strings.ReplaceAll(text, v, "[已隐藏凭据]")
			}
		}
		return nil
	})
	return aiScrub(strings.ReplaceAll(text, r.cfg.Token, "[已隐藏令牌]"))
}
func (r *executionRunner) reconcile(id, note string) error {
	if !executionID.MatchString(id) || strings.TrimSpace(note) == "" {
		return errors.New("请指定尝试 ID，并用 --note 说明本机和远程任务已停止的核实过程")
	}
	j, e := r.load(id)
	if e != nil {
		return e
	}
	if j.Phase != "unknown" {
		return errors.New("只能核实未知状态；先启动执行节点补传中断状态")
	}
	if isProcessAlive(j.PID) {
		return errors.New("记录的本机进程仍存在，不能确认停止")
	}
	if e = r.recoverQueuedLogs(id); e != nil {
		return e
	}
	if e = r.recoverLogOffsets(&j); e != nil {
		return e
	}
	root := r.cfg.Root
	if j.Root != "" {
		root = j.Root
	}
	if e = r.collect(&j, filepath.Join(root, "projects", ".hub-"+j.Work.Run.ID), true); e != nil {
		return e
	}
	if e = r.flush(id); e != nil {
		return e
	}
	if e = r.emit(j, "stopped", "", note, nil); e != nil {
		return e
	}
	if e = r.flush(id); e != nil {
		return e
	}
	j.Phase = "finished"
	return r.save(j)
}

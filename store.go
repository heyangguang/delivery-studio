package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"middleware-deployer/mwpack"
)

//go:embed store_assets/*
var storeAssets embed.FS

type storeConfig struct {
	Listen    string `json:"listen"`
	PublicURL string `json:"public_url"`
	DataDir   string `json:"data_dir"`
	// ComponentsDir holds extra or overriding component packs (<name>/component.yaml); built-in ones are embedded.
	ComponentsDir string `json:"components_dir,omitempty"`
	// ArtifactsDir holds the offline files components declare (package repositories, runtimes).
	ArtifactsDir string `json:"artifacts_dir,omitempty"`
	// RuntimeArchive is the offline Ansible runtime shipped to controllers running Ubuntu 24.04, with a .sha256 beside
	// it; Runtimes adds runtimes for other operating systems (by platform id).
	RuntimeArchive string            `json:"runtime_archive,omitempty"`
	Runtimes       map[string]string `json:"runtimes,omitempty"`
	// LibraryDir holds the package library; SourcesFile the administrator's package source list.
	LibraryDir  string `json:"library_dir,omitempty"`
	SourcesFile string `json:"sources_file,omitempty"`
	// Docker is the container client used to fetch packages ("docker" by default; fetching is optional).
	Docker string `json:"docker,omitempty"`
	// AnsibleBin is the directory holding ansible-playbook on this server; the component workbench uses it for syntax
	// checks and template previews (optional).
	AnsibleBin     string `json:"ansible_bin,omitempty"`
	TLSCert        string `json:"tls_cert,omitempty"`
	TLSKey         string `json:"tls_key,omitempty"`
	LocalDev       bool   `json:"local_dev,omitempty"`
	MaxParallel    int    `json:"max_parallel"`
	DatabaseURLEnv string `json:"database_url_env"`
	DatabaseURL    string `json:"-"`
}
type storeUser struct {
	Username     string `json:"username"`
	Role         string `json:"role"`
	Salt         string `json:"salt"`
	PasswordHash string `json:"password_hash"`
	Iterations   int    `json:"iterations"`
	// Disabled accounts cannot sign in; their deliveries stay.
	Disabled bool `json:"disabled,omitempty"`
}
type storeSession struct {
	ID            string    `json:"id"`
	User          string    `json:"user"`
	Role          string    `json:"role"`
	CSRF          string    `json:"csrf"`
	CreatedAt     time.Time `json:"created_at"`
	LastActiveAt  time.Time `json:"last_active_at"`
	Expires       time.Time `json:"expires"`
	IP            string    `json:"ip,omitempty"`
	Agent         string    `json:"agent,omitempty"`
	AuthType      string    `json:"auth_type,omitempty"`
	Requests      int64     `json:"requests,omitempty"`
	ActiveSeconds int64     `json:"active_seconds,omitempty"`
	ActiveMs      int64     `json:"active_ms,omitempty"`
	EndedAt       time.Time `json:"ended_at,omitempty"`
	EndReason     string    `json:"end_reason,omitempty"`
	EndDetail     string    `json:"end_detail,omitempty"`
}
type storeAttempt struct {
	Count int
	Since time.Time
}
type storeJob struct {
	DeliveryMode string                `json:"delivery_mode,omitempty"`
	Purpose      string                `json:"purpose,omitempty"`
	VerifyTarget *verifyTarget         `json:"verify_target,omitempty"`
	Scheme       *mwpack.SchemeSummary `json:"scheme,omitempty"`
	ID           string                `json:"id"`
	Owner        string                `json:"owner"`
	AppID        string                `json:"app_id"`
	AppName      string                `json:"app_name"`
	Version      string                `json:"version"`
	ClusterID string `json:"cluster_id"`
	// Revises is the first deployment this one replaces: it was changed before it was carried out. When this one is
	// generated the replaced one is voided (RevisedBy says by which); both keep Seq 0.
	Revises string `json:"revises,omitempty"`
	// Syncs are the times the delivery took a component fix without being made again (see store_sync.go).
	Syncs     []jobSync `json:"syncs,omitempty"`
	RevisedBy string    `json:"revised_by,omitempty"`
	State     string    `json:"state"`
	Stage     string    `json:"stage"`
	Error     string    `json:"error,omitempty"`
	Seq       int       `json:"seq,omitempty"`
	// Outcome is what the engineer reports after working through the runbook: "", "done", "deviated", "failed" or
	// "void"; OutcomeNote explains a deviation, a failure or a void, and MarkedBy is who reported it.
	Outcome     string `json:"outcome,omitempty"`
	OutcomeNote string `json:"outcome_note,omitempty"`
	Marked      string `json:"marked,omitempty"`
	MarkedBy    string `json:"marked_by,omitempty"`
	// RunDone, RunFailed and RunTotal summarise the execution record (see store_progress.go) for the delivery list.
	RunDone   int      `json:"run_done,omitempty"`
	RunFailed int      `json:"run_failed,omitempty"`
	RunTotal  int      `json:"run_total,omitempty"`
	Created   string   `json:"created"`
	Updated   string   `json:"updated"`
	Logs      []string `json:"logs"`
}
type cachedJobPlan struct {
	modTime int64
	size    int64
	raw     json.RawMessage
}

type cachedJobSpec struct {
	modTime int64
	size    int64
	dep     *mwpack.Deployment
}

type cachedExecDB struct {
	valid   bool
	modTime int64
	size    int64
	db      executionDB
}

type storeServer struct {
	repo            *storeRepository
	cfg             storeConfig
	mu              sync.Mutex
	prefMu          sync.Mutex
	auditMu         sync.Mutex
	jobPersistMu    sync.Mutex
	cacheMu         sync.RWMutex
	planCache       map[string]cachedJobPlan
	specCache       map[string]cachedJobSpec
	execCache       cachedExecDB
	users           map[string]storeUser
	sessions        map[string]storeSession
	attempts        map[string]storeAttempt
	authKey         []byte
	lastSessionSave time.Time
	plat            *platform
	library         *libraryState
	jobs            map[string]storeJob
	sem             chan struct{}
	wg              trackedWork
}

func (s *storeServer) evictJobCaches(id string) {
	if id == "" {
		return
	}
	s.cacheMu.Lock()
	delete(s.planCache, id)
	delete(s.specCache, id)
	s.cacheMu.Unlock()
}

func storeCommand(args []string) error {
	if len(args) == 0 {
		return errors.New("store serve|supervise|reload --config 配置.json | store user-add --data 数据目录 --username 用户名 --role admin|operator --password-stdin")
	}
	f := flag.NewFlagSet("store "+args[0], flag.ContinueOnError)
	config := f.String("config", "store-config.json", "服务配置")
	data := f.String("data", "", "用户数据目录，仅user-add使用")
	username := f.String("username", "", "登录用户名")
	role := f.String("role", "operator", "admin或operator")
	stdin := f.Bool("password-stdin", false, "从标准输入读取初始密码，不显示")
	binary := f.String("binary", "", "待热切换的新版本二进制路径，仅reload使用")
	timeout := f.Duration("timeout", 180*time.Second, "等待热切换完成的超时时间，仅reload使用")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("未识别的参数")
	}
	if args[0] == "reload" {
		return reloadGateway(*config, *binary, *timeout)
	}
	if args[0] == "user-add" {
		if !*stdin {
			return errors.New("必须提供--password-stdin")
		}
		password, err := io.ReadAll(io.LimitReader(os.Stdin, 1025))
		if err != nil {
			return err
		}
		if *data == "" {
			cfg, err := loadStoreConfig(*config)
			if err != nil {
				return err
			}
			if cfg.DatabaseURL == "" {
				return errors.New("共享账户需要平台数据库；本机预览使用--data")
			}
			repo, err := openStoreRepository(cfg.DatabaseURL)
			if err != nil {
				return err
			}
			defer repo.db.Close()
			u, err := newStoreUser(*username, *role, strings.TrimRight(string(password), "\r\n"))
			if err != nil {
				return err
			}
			if err = repo.addUser(u); err != nil {
				return errors.New("账户创建失败，用户名可能已经存在")
			}
			fmt.Println("账户已创建：", u.Username)
			return nil
		}
		return addStoreUser(*data, *username, *role, strings.TrimRight(string(password), "\r\n"))
	}
	if args[0] != "serve" && args[0] != "supervise" {
		return errors.New("未知store命令")
	}
	cfg, err := loadStoreConfig(*config)
	if err != nil {
		return err
	}
	if args[0] == "supervise" {
		return serveGateway(cfg, *config)
	}
	if err := retainWebAssets(cfg.DataDir); err != nil {
		return err
	}
	s, err := newStoreServer(cfg)
	if err != nil {
		return err
	}
	if s.repo != nil {
		defer s.repo.db.Close()
	}
	var listener net.Listener
	workerMode := os.Getenv("MW_GATEWAY_WORKER") == "1"
	if workerMode {
		listener, err = openGatewayWorkerListener()
	} else {
		listener, err = net.Listen("tcp", cfg.Listen)
	}
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	var handler http.Handler = s
	if workerMode {
		handler = gatewayWorkerHandlerWithControl(s, cancel, os.Getenv("MW_GATEWAY_TOKEN"))
	}
	httpServer := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	drained := make(chan struct{})
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.reapExpiredSessions()
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		defer close(drained)
		<-ctx.Done()
		// an AI answer in progress is given time to finish (and be kept) before the process goes away
		httpServer.Shutdown(context.Background())
	}()
	fmt.Println("应用交付服务已启动：", cfg.PublicURL)
	fmt.Println("支持配置交付、离线部署和授权节点执行；发布组件不会自动操作现场机器。")
	if cfg.TLSCert != "" && !workerMode && cfg.devMultiHost() {
		dual, derr := newDualProtocolListener(listener, cfg.TLSCert, cfg.TLSKey)
		if derr != nil {
			listener.Close()
			return derr
		}
		err = httpServer.Serve(dual)
	} else if cfg.TLSCert != "" && !workerMode {
		err = httpServer.ServeTLS(listener, cfg.TLSCert, cfg.TLSKey)
	} else {
		err = httpServer.Serve(listener)
	}
	if errors.Is(err, http.ErrServerClosed) {
		<-drained
	} else {
		cancel()
		<-drained
	}
	s.wg.Wait()
	s.flushSessions()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func loadStoreConfig(filename string) (storeConfig, error) {
	var c storeConfig
	b, err := os.ReadFile(filename)
	if err != nil {
		return c, err
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	if err = d.Decode(&c); err != nil {
		return c, err
	}
	u, err := url.Parse(c.PublicURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return c, errors.New("public_url须为不带路径的http(s)站点地址")
	}
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return c, errors.New("listen须为IP:端口")
	}
	devMode := c.devMultiHost()
	loopback := net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()
	if !devMode && u.Scheme != "https" && !(u.Scheme == "http" && loopback && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")) {
		return c, errors.New("共享服务必须使用HTTPS；HTTP仅允许本机预览")
	}
	if devMode && u.Scheme != "http" && u.Scheme != "https" {
		return c, errors.New("public_url须为http或https地址")
	}
	if (c.TLSCert == "") != (c.TLSKey == "") {
		return c, errors.New("TLS证书和私钥须同时提供")
	}
	if !devMode && c.TLSCert == "" && !loopback {
		return c, errors.New("未提供TLS时只能监听回环IP，由HTTPS反向代理接入")
	}
	base, err := filepath.Abs(filepath.Dir(filename))
	if err != nil {
		return c, err
	}
	for _, p := range []*string{&c.DataDir, &c.ComponentsDir, &c.ArtifactsDir, &c.RuntimeArchive, &c.LibraryDir, &c.SourcesFile, &c.TLSCert, &c.TLSKey} {
		if *p != "" && !filepath.IsAbs(*p) {
			*p = filepath.Join(base, *p)
		}
	}
	if c.DataDir == "" {
		return c, errors.New("data_dir必填")
	}
	if devMode && c.TLSCert == "" && c.TLSKey == "" {
		c.TLSCert = filepath.Join(c.DataDir, "dev-tls.crt")
		c.TLSKey = filepath.Join(c.DataDir, "dev-tls.key")
	}
	if devMode && c.TLSCert != "" && c.TLSKey != "" {
		_ = ensureDevTLSCert(c.TLSCert, c.TLSKey)
	}
	if c.ComponentsDir == "" {
		c.ComponentsDir = filepath.Join(c.DataDir, "components")
	}
	if c.ArtifactsDir == "" {
		c.ArtifactsDir = filepath.Join(c.DataDir, "artifacts")
	}
	if c.RuntimeArchive == "" {
		c.RuntimeArchive = filepath.Join(c.DataDir, "artifacts", "ansible-runtime.tar.gz")
		if c.ArtifactsDir != "" {
			c.RuntimeArchive = filepath.Join(c.ArtifactsDir, "ansible-runtime.tar.gz")
		}
	}
	if c.LibraryDir == "" {
		c.LibraryDir = filepath.Join(c.DataDir, "library")
	}
	if c.SourcesFile == "" {
		c.SourcesFile = filepath.Join(c.DataDir, "sources.yaml")
	}
	if c.DatabaseURLEnv == "" {
		c.DatabaseURLEnv = "MIDDLEWARE_STORE_DATABASE_URL"
	}
	c.DatabaseURL = os.Getenv(c.DatabaseURLEnv)
	if c.DatabaseURL == "" {
		return c, errors.New("平台服务必须配置PostgreSQL连接环境变量（已禁用无数据库本地文件预览模式）")
	}
	if c.MaxParallel == 0 {
		c.MaxParallel = 2
	}
	if c.MaxParallel < 1 || c.MaxParallel > 4 {
		return c, errors.New("max_parallel仅支持1..4")
	}
	return c, nil
}

func newStoreServer(c storeConfig) (*storeServer, error) {
	if err := os.MkdirAll(filepath.Join(c.DataDir, "jobs"), 0700); err != nil {
		return nil, err
	}
	if c.ComponentsDir == "" {
		c.ComponentsDir = filepath.Join(c.DataDir, "components")
	}
	if c.LibraryDir == "" {
		c.LibraryDir = filepath.Join(c.DataDir, "library")
	}
	if c.SourcesFile == "" {
		c.SourcesFile = filepath.Join(c.DataDir, "sources.yaml")
	}
	if err := os.MkdirAll(c.ComponentsDir, 0700); err != nil {
		return nil, err
	}
	s := &storeServer{cfg: c, users: map[string]storeUser{}, sessions: map[string]storeSession{}, attempts: map[string]storeAttempt{}, jobs: map[string]storeJob{}, sem: make(chan struct{}, c.MaxParallel)}
	if c.DatabaseURL != "" {
		var err error
		s.repo, err = openStoreRepository(c.DatabaseURL)
		if err != nil {
			return nil, err
		}
	}
	s.mu.Lock()
	if err := s.loadOrCreateAuthKeyLocked(); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	s.mu.Unlock()
	if err := s.reloadUsers(); err != nil {
		return nil, err
	}
	s.loadSessions()
	defer func() { go s.reevaluateSyncs() }()
	runtimes := map[string]string{mwpack.DefaultPlatform: c.RuntimeArchive}
	// a runtime for another system is picked up from the artifacts directory by name: ansible-runtime-<system>.tar.gz
	for _, d := range mwpack.Platforms {
		if d.ID == mwpack.DefaultPlatform {
			continue
		}
		if p := filepath.Join(c.ArtifactsDir, "ansible-runtime-"+d.ID+".tar.gz"); fileExistsRegular(p) {
			runtimes[d.ID] = p
		}
	}
	for id, p := range c.Runtimes {
		runtimes[id] = p
	}
	plat, err := loadPlatform(platformConfig{ComponentsDir: c.ComponentsDir, ArtifactsDir: c.ArtifactsDir, LibraryDir: c.LibraryDir, SourcesFile: c.SourcesFile, Runtimes: runtimes, Docker: c.Docker})
	if err != nil {
		return nil, err
	}
	s.plat = plat
	plat.py.Python = pythonFor(c.AnsibleBin, c.DataDir)
	if s.repo != nil {
		for _, e := range plat.entries() {
			if err = s.repo.catalog(e.Name, e); err != nil {
				return nil, err
			}
		}
	}
	if s.repo != nil {
		jobs, err := s.repo.jobs()
		if err != nil {
			return nil, err
		}
		s.jobs = jobs
		for id, j := range s.jobs {
			if !storeJobID.MatchString(id) {
				return nil, errors.New("任务ID无效")
			}
			if j.State == "queued" || j.State == "running" {
				j.State = "failed"
				j.Error = "服务重启中断了生成，请新建任务"
				if err = s.persistJob(j); err != nil {
					return nil, err
				}
				s.jobs[id] = j
			}
		}
		s.consolidateLegacyChangeDeliveries()
		s.migrateComponentLifecycle()
		return s, nil
	}
	jobs, _ := filepath.Glob(filepath.Join(c.DataDir, "jobs", "*", "job.json"))
	for _, filename := range jobs {
		var j storeJob
		b, err := os.ReadFile(filename)
		if err != nil {
			return nil, err
		}
		if err = json.Unmarshal(b, &j); err != nil {
			return nil, err
		}
		if !storeJobID.MatchString(j.ID) || filepath.Base(filepath.Dir(filename)) != j.ID {
			return nil, errors.New("交付任务身份无效")
		}
		if j.State == "running" || j.State == "queued" {
			j.State = "failed"
			j.Error = "服务重启中断了材料生成，请新建交付任务"
			writeJSON(filename, j)
		}
		s.jobs[j.ID] = j
	}
	s.consolidateLegacyChangeDeliveries()
	s.migrateComponentLifecycle()
	return s, nil
}

var storeJobID = regexp.MustCompile(`^[a-f0-9]{32}$`)

func (s *storeServer) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func (s *storeServer) fail(w http.ResponseWriter, status int, message string) {
	s.writeJSON(w, status, map[string]string{"error": localizeGoMessage(wLang(w), message)})
}

// audit records something the platform did on its own or outside a request (a delivery finishing, a reminder).
func (s *storeServer) audit(action, user, id string) {
	s.writeAudit(auditEvent{Time: time.Now().UTC().Format(time.RFC3339Nano), Action: action, User: user, Job: id, Result: "ok"})
}

// auditReq names what a request did. Inside a recorded request it labels that request's record (written once when the
// request ends, with its resource, content and result); otherwise it writes a record of its own.
func (s *storeServer) auditReq(r *http.Request, action, user, id string) {
	if rec, ok := r.Context().Value(auditKey{}).(*auditRec); ok {
		rec.mu.Lock()
		if !rec.done && rec.action == "" {
			rec.action, rec.target = action, id
			if rec.user == "" {
				rec.user = user
			}
			rec.mu.Unlock()
			return
		}
		rec.mu.Unlock()
	}
	res := s.resourceOf(r.URL.Path)
	s.writeAudit(auditEvent{Time: time.Now().UTC().Format(time.RFC3339Nano), Action: action, User: user, Job: id, IP: clientIP(r), Agent: truncRunes(r.UserAgent(), 200), Method: r.Method, Path: r.URL.Path, Resource: res, Result: map[bool]string{true: "failed", false: "ok"}[strings.HasSuffix(action, "-failed")]})
}

func (s *storeServer) writeAudit(event auditEvent) {
	if s.repo != nil {
		if err := s.repo.audit(event); err != nil {
			fmt.Fprintln(os.Stderr, "平台审计写入失败")
		}
		return
	}
	s.auditMu.Lock()
	defer s.auditMu.Unlock()
	f, err := os.OpenFile(filepath.Join(s.cfg.DataDir, "audit.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	json.NewEncoder(f).Encode(event)
}

func (s *storeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	lang := reqLang(r)
	r = withLangContext(r, lang)
	w = &langResponseWriter{ResponseWriter: w, lang: lang}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
	if !s.allowedHost(r.Host) {
		s.fail(w, 403, "站点地址不匹配")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/target-agent/") {
		s.handleTargetAgent(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/execution-agent/") {
		s.handleExecutionAgent(w, r)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && !s.allowedOrigin(r.Header.Get("Origin"), r.Host) {
		s.fail(w, 403, "请求不是从平台页面发出的，已拒绝")
		return
	}
	// the page asks which version is running, to say "updated, refresh" instead of breaking; no login needed
	if r.URL.Path == "/api/version" && r.Method == "GET" {
		w.Header().Set("Cache-Control", "no-store")
		s.writeJSON(w, 200, map[string]any{
			"version":     version,
			"build_id":    currentBuildID(),
			"released_at": currentReleaseDate,
			"notes":       releaseNotesFor(lang),
		})
		return
	}
	if r.URL.Path == "/api/login" && r.Method == "POST" {
		s.login(w, r)
		return
	}
	if r.URL.Path == "/" || strings.HasPrefix(r.URL.Path, "/assets/") {
		if r.Method != "GET" {
			s.fail(w, 405, "方法不支持")
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		kind := "application/octet-stream"
		if name == "" {
			name = "index.html"
			kind = "text/html; charset=utf-8"
		}
		if strings.HasSuffix(name, ".js") {
			kind = "text/javascript; charset=utf-8"
		}
		if strings.HasSuffix(name, ".css") {
			kind = "text/css; charset=utf-8"
		}
		if strings.Contains(name, "..") || strings.Contains(name, "\\") {
			s.fail(w, 404, "页面不存在")
			return
		}
		b, err := storeAssets.ReadFile("store_assets/" + name)
		if err != nil && strings.HasPrefix(name, "assets/") {
			b, err = os.ReadFile(filepath.Join(s.cfg.DataDir, ".web-assets", strings.TrimPrefix(name, "assets/")))
		}
		if err != nil {
			s.fail(w, 404, "页面不存在")
			return
		}
		w.Header().Set("Content-Type", kind)
		if name == "index.html" {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		} else if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		w.Write(b)
		return
	}
	session, authByBearer, ok := s.authenticateRequest(r)
	if !ok {
		s.fail(w, 401, "请先登录")
		return
	}
	r = withSessionContext(r, session)
	w, r, done := s.auditStart(w, r, session.User)
	defer done()
	if r.Method != "GET" && r.Method != "HEAD" && !authByBearer && !constantStoreEqual(r.Header.Get("X-CSRF-Token"), session.CSRF) {
		s.fail(w, 403, "请求校验失败，请刷新页面")
		return
	}
	if !s.allowedRoute(w, r, session.User) {
		return
	}
	switch {
	case r.URL.Path == "/api/session" && r.Method == "GET":
		s.writeJSON(w, 200, s.sessionView(session))
	case r.URL.Path == "/api/session/heartbeat":
		s.handleSessionHeartbeat(w, r, session)
	case r.URL.Path == "/api/logout" && r.Method == "POST":
		s.logout(w, r, session)
	case r.URL.Path == "/api/catalog" && r.Method == "GET":
		s.writeJSON(w, 200, localizeCatalogEntries(wLang(w), s.plat.entriesWith(r.URL.Query().Get("fronts") == "1")))
	case r.URL.Path == "/api/components" || strings.HasPrefix(r.URL.Path, "/api/components/"):
		s.handleComponents(w, r, session)
	case r.URL.Path == "/api/library/python" || strings.HasPrefix(r.URL.Path, "/api/library/python/"):
		s.handlePython(w, r, session)
	case r.URL.Path == "/api/library" || strings.HasPrefix(r.URL.Path, "/api/library/"):
		s.handleLibrary(w, r, session)
	case r.URL.Path == "/api/security" || strings.HasPrefix(r.URL.Path, "/api/security/"):
		s.handleSecurity(w, r, session)
	case r.URL.Path == "/api/audit/sessions" || strings.HasPrefix(r.URL.Path, "/api/audit/sessions/"):
		s.handleAuditSessions(w, r, session)
	case (r.URL.Path == "/api/audit" || r.URL.Path == "/api/audit/export") && r.Method == "GET":
		s.handleAudit(w, r, session)
	case r.URL.Path == "/api/ai/chats" || strings.HasPrefix(r.URL.Path, "/api/ai/chats/"):
		s.handleAIChats(w, r, session)
	case r.URL.Path == "/api/ai/portal" || strings.HasPrefix(r.URL.Path, "/api/ai/portal/"):
		s.handlePortalAI(w, r, session)
	case r.URL.Path == "/api/ai/sandbox/approve" && r.Method == "POST":
		s.handleSandboxApprove(w, r, session)
	case r.URL.Path == "/api/ai/options" && r.Method == "GET":
		s.writeJSON(w, 200, s.aiOptions(session.User))
	case r.URL.Path == "/api/ai/models" && r.Method == "GET":
		s.writeJSON(w, 200, s.aiModels())
	case r.URL.Path == "/api/ai/status" && r.Method == "GET":
		s.writeJSON(w, 200, s.aiStatusFor(session.User))
	case r.URL.Path == "/api/ai/toggle" && r.Method == "POST":
		s.handleAIToggle(w, r, session)
	case r.URL.Path == "/api/settings/execution-nodes" || strings.HasPrefix(r.URL.Path, "/api/settings/execution-nodes/"):
		s.handleExecutionNodes(w, r, session)
	case r.URL.Path == "/api/executions/runs" && r.Method == "GET":
		s.handleExecutionRunsList(w, r, session)
	case r.URL.Path == "/api/settings/sandbox" || r.URL.Path == "/api/settings/sandbox/check":
		s.handleSandboxSettings(w, r, session)
	case r.URL.Path == "/api/settings/storage":
		s.handleStorageSettings(w, r, session)
	case r.URL.Path == "/api/settings/ai" || strings.HasPrefix(r.URL.Path, "/api/settings/ai/"):
		s.handleAISettings(w, r, session)
	case r.URL.Path == "/api/settings/report" || strings.HasPrefix(r.URL.Path, "/api/settings/report/"):
		s.handleReportSettings(w, r, session)
	case r.URL.Path == "/api/settings" || strings.HasPrefix(r.URL.Path, "/api/settings/"):
		s.handleSettings(w, r, session)
	case r.URL.Path == "/api/clusters" && r.Method == "GET":
		s.clusters(w, r, session)
	case r.URL.Path == "/api/clusters/import" || strings.HasPrefix(r.URL.Path, "/api/clusters/import/"):
		s.handleClusterImport(w, r, session)
	case strings.HasPrefix(r.URL.Path, "/api/clusters/"):
		s.handleCluster(w, r, session)
	case strings.HasPrefix(r.URL.Path, "/api/rehearsals/"):
		s.handleGlobalRehearsals(w, r, session)
	case r.URL.Path == "/api/resolve" && r.Method == "POST":
		s.resolve(w, r, session)
	case r.URL.Path == "/api/spec/import" && r.Method == "POST":
		s.specImport(w, r)
	case r.URL.Path == "/api/spec/export" && r.Method == "POST":
		s.specExport(w, r)
	case r.URL.Path == "/api/me" || strings.HasPrefix(r.URL.Path, "/api/me/"):
		s.handleMe(w, r, session)
	case strings.HasPrefix(r.URL.Path, "/api/users/"):
		parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/users/"), "/"), "/")
		s.handleUser(w, r, session, parts[0], parts[1:])
	case r.URL.Path == "/api/users":
		s.handleUsers(w, r, session)
	case r.URL.Path == "/api/kb" || strings.HasPrefix(r.URL.Path, "/api/kb/"):
		s.handleTeamKB(w, r, session)
	case r.URL.Path == "/api/iam" || strings.HasPrefix(r.URL.Path, "/api/iam/"):
		s.handleIAM(w, r, session)
	case r.URL.Path == "/api/jobs" && r.Method == "GET":
		s.listJobs(w, session)
	case r.URL.Path == "/api/certificates/check" && r.Method == "POST":
		s.checkCertificates(w, r, session)
	case r.URL.Path == "/api/jobs" && r.Method == "POST":
		s.createJob(w, r, session)
	case strings.HasPrefix(r.URL.Path, "/api/jobs/"):
		s.handleJob(w, r, session)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func fileExistsRegular(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

func writeJSONFile(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

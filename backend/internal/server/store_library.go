package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"delivery-studio/mwpack"
	"delivery-studio/pkglib"
)

// fetchTask is a background job that downloads packages into the library.
type fetchTask struct {
	ID       string                  `json:"id"`
	Kind     string                  `json:"kind,omitempty"` // "" (download packages) or "index"
	Platform string                  `json:"platform"`
	Packages []mwpack.PackageRequest `json:"packages"`
	State    string                  `json:"state"` // running | done | failed
	Error    string                  `json:"error,omitempty"`
	Logs     []string                `json:"logs"`
	Steps    []pkglib.StepEvent      `json:"steps"` // structured progress, in the order the steps were announced
	Started  string                  `json:"started"`
	By       string                  `json:"by,omitempty"`
	Finished string                  `json:"finished,omitempty"`
}

type libraryState struct {
	mu    sync.Mutex
	tasks []*fetchTask // newest last
	busy  bool         // a fetch or import is changing the library
	path  string       // where finished tasks are kept, so the history survives a restart
}

// save keeps the finished tasks. The caller holds the lock.
func (st *libraryState) save() {
	if st.path == "" {
		return
	}
	var done []*fetchTask
	for _, t := range st.tasks {
		if t.State != "running" {
			done = append(done, t)
		}
	}
	_ = writeJSON(st.path, done)
}

// step records a progress step, merging it into the step with the same id. The caller holds the lock.
func (t *fetchTask) step(ev pkglib.StepEvent) {
	for i := range t.Steps {
		if t.Steps[i].ID != ev.ID {
			continue
		}
		cur := &t.Steps[i]
		cur.State = ev.State
		if ev.Detail != "" || ev.State == "pending" || ev.State == "done" || ev.State == "skipped" {
			cur.Detail = ev.Detail
		}
		if ev.Label != "" {
			cur.Label = ev.Label
		}
		if ev.Size != 0 {
			cur.Size = ev.Size
		}
		return
	}
	t.Steps = append(t.Steps, ev)
}

// reporter turns what a long operation reports into the task's log lines and steps.
func (st *libraryState) reporter(t *fetchTask) *pkglib.Reporter {
	return &pkglib.Reporter{
		Log: func(m string) {
			st.mu.Lock()
			if t.Logs = append(t.Logs, m); len(t.Logs) > 400 {
				t.Logs = t.Logs[len(t.Logs)-400:]
			}
			st.mu.Unlock()
		},
		Step: func(ev pkglib.StepEvent) {
			st.mu.Lock()
			t.step(ev)
			st.mu.Unlock()
		},
	}
}

func (s *storeServer) lib() *libraryState {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.library == nil {
		s.library = &libraryState{path: filepath.Join(s.cfg.DataDir, "library-tasks.json")}
		if b, err := os.ReadFile(s.library.path); err == nil {
			_ = json.Unmarshal(b, &s.library.tasks)
		}
	}
	return s.library
}

func (st *libraryState) task(id string) *fetchTask {
	for _, t := range st.tasks {
		if t.ID == id {
			return t
		}
	}
	return nil
}

func (s *storeServer) handleLibrary(w http.ResponseWriter, r *http.Request, session storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/library"), "/")
	admin := s.can(session.User, "library.manage")
	need := func() bool {
		if !admin {
			s.fail(w, 403, "只有管理员可以修改软件库")
		}
		return admin
	}
	switch {
	case rest == "" && r.Method == "GET":
		s.libraryOverview(w)
	case rest == "tasks" && r.Method == "GET":
		s.libraryTasks(w)
	case rest == "closures" && r.Method == "GET":
		s.libraryClosures(w, r)
	case rest == "versions" && r.Method == "GET":
		s.libraryVersions(w, r)
	case rest == "search" && r.Method == "GET":
		s.librarySearch(w, r)
	case rest == "plan" && r.Method == "GET":
		s.libraryPlan(w, r)
	case rest == "index/export" && r.Method == "GET":
		if need() {
			s.libraryIndexExport(w, r)
		}
	case rest == "index/import" && r.Method == "POST":
		if need() {
			s.libraryIndexImport(w, r, session)
		}
	case rest == "index/update" && r.Method == "POST":
		if need() {
			s.libraryIndexUpdate(w, r, session)
		}
	case rest == "fetch" && r.Method == "POST":
		if need() {
			s.libraryFetch(w, r, session)
		}
	case strings.HasPrefix(rest, "tasks/") && r.Method == "GET":
		s.libraryTask(w, strings.TrimPrefix(rest, "tasks/"))
	case rest == "delete" && r.Method == "POST":
		if need() {
			s.libraryDelete(w, r, session)
		}
	case rest == "export" && r.Method == "GET":
		if need() {
			s.libraryExport(w, r)
		}
	case rest == "import" && r.Method == "POST":
		if need() {
			s.libraryImport(w, r, session)
		}
	case rest == "sources" && r.Method == "GET":
		s.librarySources(w)
	case rest == "sources" && r.Method == "PUT":
		if need() {
			s.librarySourcesSave(w, r, session)
		}
	default:
		s.fail(w, 404, "接口不存在")
	}
}

type platformView struct {
	mwpack.PlatformDef
	Deployable bool              `json:"deployable"`
	Stats      pkglib.Stats      `json:"stats"`
	Sources    int               `json:"sources"`
	Index      pkglib.IndexState `json:"index"`
	Runtime    *RuntimeInfo      `json:"runtime,omitempty"`
	// Direct is true when packages can be searched and downloaded from the source indexes, without a container.
	Direct bool `json:"direct"`
}

func (s *storeServer) libraryOverview(w http.ResponseWriter) {
	lang := wLang(w)
	var pl []platformView
	for _, p := range mwpack.Platforms {
		p.Title = mwpack.LocalizePlatformTitle(lang, p.Title)
		var info *RuntimeInfo
		if r, ok := s.plat.py.Default(p.ID); ok {
			info = &RuntimeInfo{File: tr(lang, "软件库 · ", "Library · ") + r.ID, Ansible: r.Ansible, Python: r.Python, Controller: p.Title, Packages: []RuntimePackage{}}
			for _, w := range r.Wheels {
				info.Packages = append(info.Packages, RuntimePackage{w.Name, w.Version})
				info.Size += w.Size
			}
		} else if rt := s.plat.runtimeFor(p.ID); rt != "" {
			info = readRuntimeInfo(rt)
		}
		pl = append(pl, platformView{PlatformDef: p, Deployable: s.plat.runtimeReady(p.ID), Stats: s.plat.lib.Stats(p.ID), Sources: len(s.plat.sources.Load().ForPlatform(p.ID)), Index: s.plat.idx.State(p.ID), Runtime: info, Direct: true})
	}
	st := s.lib()
	st.mu.Lock()
	var last *fetchTask
	if n := len(st.tasks); n > 0 {
		cp := *st.tasks[n-1]
		last = &cp
	}
	busy := st.busy
	st.mu.Unlock()
	s.writeJSON(w, 200, map[string]any{"platforms": pl, "busy": busy, "last_task": last, "default_platform": mwpack.DefaultPlatform})
}

func (s *storeServer) libraryClosures(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("platform")
	if _, ok := mwpack.PlatformByID(id); !ok {
		s.fail(w, 400, "不认识这个操作系统")
		return
	}
	// Which components use each package, so the page can say why something is there.
	used := map[string][]string{}
	for _, c := range s.plat.cat().Names() {
		comp, _ := s.plat.cat().Get(c)
		for _, v := range comp.Versions {
			rs, err := comp.Resolve(v.ID)
			if err != nil {
				continue
			}
			for _, pk := range rs.Packages {
				if len(pk.Platforms) > 0 && !contains(pk.Platforms, id) {
					continue
				}
				key := mwpack.PackageRequest{Name: pk.Name, Version: pk.Version}.Key()
				label := comp.Title + " " + v.ID
				if !contains(used[key], label) {
					used[key] = append(used[key], label)
				}
			}
		}
	}
	type row struct {
		pkglib.Closure
		UsedBy []string `json:"used_by"`
		Intact bool     `json:"intact"`
	}
	rows := []row{}
	for _, c := range s.plat.lib.List(id) {
		rows = append(rows, row{c, used[c.Request.Key()], s.plat.lib.Has(id, c.Request)})
	}
	// Packages that components need but the library lacks.
	var missing []mwpack.PackageRequest
	for _, m := range s.plat.cat().AllPackages(id) {
		if !s.plat.lib.Has(id, m) {
			missing = append(missing, m)
		}
	}
	if missing == nil {
		missing = []mwpack.PackageRequest{}
	}
	s.writeJSON(w, 200, map[string]any{"closures": rows, "missing": missing})
}

func (s *storeServer) libraryVersions(w http.ResponseWriter, r *http.Request) {
	def, ok := mwpack.PlatformByID(r.URL.Query().Get("platform"))
	name := r.URL.Query().Get("package")
	if !ok || name == "" {
		s.fail(w, 400, "需要 platform 和 package")
		return
	}
	if s.plat.idx.Ready(def.ID) {
		list, err := s.plat.idx.Versions(def, name)
		if err != nil {
			s.fail(w, 404, err.Error())
			return
		}
		type detail struct {
			Version string `json:"version"`
			Source  string `json:"source"`
			Suite   string `json:"suite"`
			Size    int64  `json:"size"`
			Have    bool   `json:"have"`
		}
		vs, details := []string{}, []detail{}
		for _, p := range list {
			vs = append(vs, p.Version)
			details = append(details, detail{p.Version, p.Source, p.Suite, p.Size, s.plat.lib.Has(def.ID, mwpack.PackageRequest{Name: name, Version: p.Version})})
		}
		s.writeJSON(w, 200, map[string]any{"versions": vs, "details": details, "from": "index"})
		return
	}
	s.fail(w, 409, "还没有这个系统的软件源索引：先点“更新”（需要联网一次），或从能联网的平台导出后在这里“导入”")
}

func (s *storeServer) libraryFetch(w http.ResponseWriter, r *http.Request, session storeSession) {
	var body struct {
		Platform string                  `json:"platform"`
		Packages []mwpack.PackageRequest `json:"packages"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	def, ok := mwpack.PlatformByID(body.Platform)
	if !ok || len(body.Packages) == 0 || len(body.Packages) > 40 {
		s.fail(w, 400, "需要操作系统和 1–40 个软件包")
		return
	}
	for _, p := range body.Packages {
		if err := pkglib.ValidRequest(p); err != nil {
			s.fail(w, 400, err.Error())
			return
		}
	}
	// packages are found and downloaded through the signed source index; no container is involved
	if !s.plat.idx.Ready(def.ID) {
		s.fail(w, 409, "还没有这个系统的软件源索引：先点“更新”（需要联网一次），或从能联网的平台导出后在这里“导入”")
		return
	}
	var todo []mwpack.PackageRequest
	for _, p := range body.Packages {
		if !s.plat.lib.Has(def.ID, p) {
			todo = append(todo, p)
		}
	}
	if len(todo) == 0 {
		s.fail(w, 409, "这些软件包库里已经有了")
		return
	}
	st := s.lib()
	st.mu.Lock()
	if st.busy {
		st.mu.Unlock()
		s.fail(w, 409, "软件库正在被另一个操作使用，请稍后")
		return
	}
	st.busy = true
	t := &fetchTask{ID: randomStoreToken(8), Platform: def.ID, Packages: todo, State: "running", Started: nowStamp(), By: session.User, Logs: []string{}, Steps: []pkglib.StepEvent{}}
	if st.tasks = append(st.tasks, t); len(st.tasks) > 60 {
		st.tasks = st.tasks[1:]
	}
	st.mu.Unlock()
	s.auditReq(r, "library-fetch", session.User, def.ID+" "+fmt.Sprint(len(todo)))
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Minute)
		defer cancel()
		err := s.plat.idx.FetchDirect(ctx, s.plat.lib, def, s.plat.sources.Load(), todo, st.reporter(t))
		st.mu.Lock()
		defer st.mu.Unlock()
		t.Finished = nowStamp()
		if err != nil {
			t.State, t.Error = "failed", err.Error()
		} else {
			t.State = "done"
		}
		st.busy = false
		st.save()
	}()
	s.writeJSON(w, 202, t)
}

// libraryTasks is the history of what the library has been told to do, newest first, without the raw logs.
func (s *storeServer) libraryTasks(w http.ResponseWriter) {
	st := s.lib()
	st.mu.Lock()
	out := make([]fetchTask, 0, len(st.tasks))
	for i := len(st.tasks) - 1; i >= 0; i-- {
		cp := *st.tasks[i]
		cp.Logs = nil
		out = append(out, cp)
	}
	st.mu.Unlock()
	s.writeJSON(w, 200, out)
}

func (s *storeServer) libraryTask(w http.ResponseWriter, id string) {
	st := s.lib()
	st.mu.Lock()
	defer st.mu.Unlock()
	t := st.task(id)
	if t == nil {
		s.fail(w, 404, "任务不存在")
		return
	}
	s.writeJSON(w, 200, t)
}

func (s *storeServer) libraryDelete(w http.ResponseWriter, r *http.Request, session storeSession) {
	var body struct {
		Platform string `json:"platform"`
		Name     string `json:"name"`
		Version  string `json:"version"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&body); err != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	req := mwpack.PackageRequest{Name: body.Name, Version: body.Version}
	if err := pkglib.ValidRequest(req); err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	st := s.lib()
	st.mu.Lock()
	busy := st.busy
	st.mu.Unlock()
	if busy {
		s.fail(w, 409, "软件库正在被另一个操作使用，请稍后")
		return
	}
	if err := s.plat.lib.Delete(body.Platform, req); err != nil {
		s.fail(w, 404, "软件库里没有这个软件包")
		return
	}
	s.auditReq(r, "library-delete", session.User, body.Platform+" "+req.Key())
	s.writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *storeServer) libraryExport(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("platform")
	if _, ok := mwpack.PlatformByID(id); !ok {
		s.fail(w, 400, "不认识这个操作系统")
		return
	}
	var reqs []mwpack.PackageRequest
	for _, v := range r.URL.Query()["pkg"] {
		name, ver, ok := strings.Cut(v, "=")
		req := mwpack.PackageRequest{Name: name, Version: ver}
		if !ok || pkglib.ValidRequest(req) != nil {
			s.fail(w, 400, "软件包要写成「名称=版本」的形式")
			return
		}
		reqs = append(reqs, req)
	}
	if len(reqs) == 0 {
		for _, c := range s.plat.lib.List(id) {
			reqs = append(reqs, c.Request)
		}
	}
	if len(reqs) == 0 {
		s.fail(w, 404, "软件库里还没有软件包")
		return
	}
	// Check everything exists before the response starts, so a failure is an error and not a truncated download.
	for _, q := range reqs {
		if !s.plat.lib.Has(id, q) {
			s.fail(w, 404, "软件库里没有 "+q.Key())
			return
		}
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", "attachment; filename=library-"+id+".tar.gz")
	if err := s.plat.lib.Export(w, id, reqs); err != nil {
		fmt.Fprintln(os.Stderr, "软件库导出失败：", err)
	}
}

func (s *storeServer) libraryImport(w http.ResponseWriter, r *http.Request, session storeSession) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<30)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		s.fail(w, 400, "上传失败：文件读不出来，或者太大了")
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, _, err := r.FormFile("pack")
	if err != nil {
		s.fail(w, 400, "请选择软件库包")
		return
	}
	defer f.Close()
	st := s.lib()
	st.mu.Lock()
	if st.busy {
		st.mu.Unlock()
		s.fail(w, 409, "软件库正在被另一个操作使用，请稍后")
		return
	}
	st.busy = true
	st.mu.Unlock()
	defer func() { st.mu.Lock(); st.busy = false; st.mu.Unlock() }()
	res, err := s.plat.lib.Import(io.Reader(f))
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	s.auditReq(r, "library-import", session.User, fmt.Sprintf("%d", res.Closures))
	s.writeJSON(w, 200, res)
}

func (s *storeServer) librarySources(w http.ResponseWriter) {
	src := s.plat.sources.Load()
	custom := ""
	if b, err := os.ReadFile(s.plat.cfg.SourcesFile); err == nil {
		custom = string(b)
	}
	list := append([]pkglib.Source(nil), src.List...)
	sort.SliceStable(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	s.writeJSON(w, 200, map[string]any{"effective": list, "custom": custom, "builtin": pkglib.BuiltinYAML()})
}

func (s *storeServer) librarySourcesSave(w http.ResponseWriter, r *http.Request, session storeSession) {
	var body struct {
		YAML string `json:"yaml"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<18)).Decode(&body); err != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	if _, err := pkglib.ParseSources([]byte(body.YAML)); err != nil {
		s.fail(w, 422, err.Error())
		return
	}
	if err := s.plat.sources.Load().Save([]byte(body.YAML)); err != nil {
		s.fail(w, 500, err.Error())
		return
	}
	if err := s.plat.reloadSources(); err != nil {
		s.fail(w, 500, err.Error())
		return
	}
	s.auditReq(r, "library-sources", session.User, "")
	s.librarySources(w)
}

func contains(l []string, x string) bool {
	for _, v := range l {
		if v == x {
			return true
		}
	}
	return false
}

// ---- search and preview from the cached source indexes ----

func (s *storeServer) librarySearch(w http.ResponseWriter, r *http.Request) {
	def, ok := mwpack.PlatformByID(r.URL.Query().Get("platform"))
	if !ok {
		s.fail(w, 400, "不认识这个操作系统")
		return
	}
	if !s.plat.idx.Ready(def.ID) {
		s.fail(w, 409, "还没有这个系统的软件源索引：先点“更新索引”（需要联网一次）")
		return
	}
	hits, err := s.plat.idx.Search(def, r.URL.Query().Get("q"), 40)
	if err != nil {
		s.fail(w, 500, err.Error())
		return
	}
	s.writeJSON(w, 200, map[string]any{"hits": hits})
}

// libraryPlan answers "what would adding this version bring along": the dependency closure, which of it the library
// already holds, and how much is left to download.
func (s *storeServer) libraryPlan(w http.ResponseWriter, r *http.Request) {
	def, ok := mwpack.PlatformByID(r.URL.Query().Get("platform"))
	req := mwpack.PackageRequest{Name: r.URL.Query().Get("package"), Version: r.URL.Query().Get("version")}
	if !ok || pkglib.ValidRequest(req) != nil {
		s.fail(w, 400, "需要 platform、package 和 version")
		return
	}
	plan, err := s.plat.idx.Resolve(def, req)
	if err != nil {
		s.fail(w, 404, err.Error())
		return
	}
	type row struct {
		pkglib.PlanPkg
		Have bool `json:"have"`
	}
	rows := make([]row, 0, len(plan.Packages))
	var need int64
	for _, p := range plan.Packages {
		have := s.plat.lib.HasFile(def.ID, p.File, p.Size)
		if !have {
			need += p.Size
		}
		rows = append(rows, row{p, have})
	}
	s.writeJSON(w, 200, map[string]any{"request": plan.Request, "packages": rows, "bytes": plan.Bytes, "download_bytes": need, "unresolved": plan.Unresolved, "notes": plan.Notes, "stored": s.plat.lib.Has(def.ID, req)})
}

func (s *storeServer) libraryIndexUpdate(w http.ResponseWriter, r *http.Request, session storeSession) {
	var body struct {
		Platform string `json:"platform"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&body); err != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	def, ok := mwpack.PlatformByID(body.Platform)
	if !ok {
		s.fail(w, 400, "这个系统暂不支持软件源索引")
		return
	}
	st := s.lib()
	st.mu.Lock()
	if st.busy {
		st.mu.Unlock()
		s.fail(w, 409, "软件库正在被另一个操作使用，请稍后")
		return
	}
	st.busy = true
	t := &fetchTask{ID: randomStoreToken(8), Kind: "index", Platform: def.ID, Packages: []mwpack.PackageRequest{}, State: "running", Started: nowStamp(), By: session.User, Logs: []string{}, Steps: []pkglib.StepEvent{}}
	if st.tasks = append(st.tasks, t); len(st.tasks) > 60 {
		st.tasks = st.tasks[1:]
	}
	st.mu.Unlock()
	s.auditReq(r, "library-index-update", session.User, def.ID)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		err := s.plat.idx.Update(ctx, def, s.plat.sources.Load(), st.reporter(t))
		st.mu.Lock()
		defer st.mu.Unlock()
		t.Finished = nowStamp()
		if err != nil {
			t.State, t.Error = "failed", err.Error()
		} else {
			t.State = "done"
		}
		st.busy = false
		st.save()
	}()
	s.writeJSON(w, 202, t)
}

// libraryIndexExport sends the cached index of a platform as a pack for an offline platform to import.
func (s *storeServer) libraryIndexExport(w http.ResponseWriter, r *http.Request) {
	def, ok := mwpack.PlatformByID(r.URL.Query().Get("platform"))
	if !ok {
		s.fail(w, 400, "不认识这个操作系统，或者它还没有软件源索引")
		return
	}
	var buf bytes.Buffer
	if err := s.plat.idx.Export(&buf, def.ID); err != nil {
		s.fail(w, 409, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="source-index-`+def.ID+`-`+time.Now().UTC().Format("20060102")+`.tar.gz"`)
	w.Write(buf.Bytes())
}

// libraryIndexImport installs an index pack made on another platform. The pack is verified again here.
func (s *storeServer) libraryIndexImport(w http.ResponseWriter, r *http.Request, session storeSession) {
	r.Body = http.MaxBytesReader(w, r.Body, 2<<30)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		s.fail(w, 400, "上传失败：文件读不出来，或者太大了")
		return
	}
	defer r.MultipartForm.RemoveAll()
	def, ok := mwpack.PlatformByID(r.FormValue("platform"))
	if !ok {
		s.fail(w, 400, "不认识这个操作系统，或者它还没有软件源索引")
		return
	}
	f, _, err := r.FormFile("pack")
	if err != nil {
		s.fail(w, 400, "请选择索引包")
		return
	}
	defer f.Close()
	st := s.lib()
	st.mu.Lock()
	if st.busy {
		st.mu.Unlock()
		s.fail(w, 409, "软件库正在被另一个操作使用，请稍后")
		return
	}
	st.busy = true
	st.mu.Unlock()
	defer func() { st.mu.Lock(); st.busy = false; st.mu.Unlock() }()
	state, err := s.plat.idx.Import(io.Reader(f), def, s.plat.sources.Load())
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	s.auditReq(r, "library-index-import", session.User, def.ID)
	s.writeJSON(w, 200, state)
}

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"delivery-studio/mwpack"
	"delivery-studio/pkglib"
)

// The Ansible runtimes in the package library: what each carries, which one each operating system's deliveries use,
// and how a new one is made from chosen wheel versions.

type pyRuntimeView struct {
	pkglib.PyRuntime
	Default []string `json:"default"` // platforms delivering with it
	Size    int64    `json:"size"`
}

var pyNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$`)
var pyVerRE = regexp.MustCompile(`^[0-9][0-9A-Za-z.+!-]{0,40}$`)

func (s *storeServer) handlePython(w http.ResponseWriter, r *http.Request, session storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/library/python"), "/")
	admin := s.can(session.User, "library.runtime")
	need := func() bool {
		if !admin {
			s.fail(w, 403, "只有管理员可以管理运行环境")
		}
		return admin
	}
	switch {
	case rest == "" && r.Method == "GET":
		lang := wLang(w)
		wheels, runtimes, defaults := s.plat.py.State()
		views := []pyRuntimeView{}
		for _, rt := range runtimes {
			v := pyRuntimeView{PyRuntime: rt, Default: []string{}}
			v.Note = localizeGoMessage(lang, v.Note)
			for pl, id := range defaults {
				if id == rt.ID {
					v.Default = append(v.Default, pl)
				}
			}
			sort.Strings(v.Default)
			for _, wh := range rt.Wheels {
				v.Size += wh.Size
			}
			views = append(views, v)
		}
		sort.SliceStable(views, func(i, j int) bool {
			if (len(views[i].Default) > 0) != (len(views[j].Default) > 0) {
				return len(views[i].Default) > 0
			}
			return views[i].Created > views[j].Created
		})
		var pls []map[string]string
		for _, def := range mwpack.Platforms {
			pls = append(pls, map[string]string{"id": def.ID, "title": mwpack.LocalizePlatformTitle(lang, def.Title)})
		}
		s.writeJSON(w, 200, map[string]any{"runtimes": views, "wheels": len(wheels), "defaults": defaults, "platforms": pls, "python": pkglib.PyPython})
	case rest == "versions" && r.Method == "GET":
		name := r.URL.Query().Get("name")
		if !pyNameRE.MatchString(name) {
			s.fail(w, 400, "软件包名称不对")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		vs, err := s.plat.py.Versions(ctx, name)
		if err != nil {
			s.fail(w, 502, err.Error())
			return
		}
		s.writeJSON(w, 200, vs)
	case rest == "build" && r.Method == "POST":
		if !need() {
			return
		}
		var body struct {
			Ansible    string            `json:"ansible"`
			Pins       map[string]string `json:"pins"`
			Offline    bool              `json:"offline"`
			Note       string            `json:"note"`
			SetDefault []string          `json:"set_default"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&body); err != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		reqs, note, err := s.pyRequirements(body.Ansible, body.Pins)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		if strings.TrimSpace(body.Note) != "" {
			note = strings.TrimSpace(body.Note)
		}
		for _, pl := range body.SetDefault {
			if _, ok := mwpack.PlatformByID(pl); !ok {
				s.fail(w, 400, "不认识这个操作系统")
				return
			}
		}
		user, offline, setDefault := session.User, body.Offline, body.SetDefault
		t, err := s.startDataTask("python", user, func(ctx context.Context, rep *pkglib.Reporter) error {
			rt, err := s.plat.py.Build(ctx, reqs, offline, note, user, rep)
			if err != nil {
				return err
			}
			for _, pl := range setDefault {
				if err := s.plat.py.SetDefault(pl, rt.ID); err != nil {
					return err
				}
			}
			return nil
		}, nil)
		if err != nil {
			s.fail(w, 409, err.Error())
			return
		}
		s.audit("python-runtime-build", user, strings.Join(reqs, " "))
		s.writeJSON(w, 202, t)
	case rest == "default" && r.Method == "PUT":
		if !need() {
			return
		}
		var body struct{ Platform, Runtime string }
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&body); err != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		if _, ok := mwpack.PlatformByID(body.Platform); !ok {
			s.fail(w, 400, "不认识这个操作系统")
			return
		}
		if err := s.plat.py.SetDefault(body.Platform, body.Runtime); err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		s.auditReq(r, "python-runtime-default", session.User, body.Platform+" "+body.Runtime)
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case strings.HasPrefix(rest, "runtimes/") && r.Method == "DELETE":
		if !need() {
			return
		}
		if err := s.plat.py.DeleteRuntime(strings.TrimPrefix(rest, "runtimes/")); err != nil {
			s.fail(w, 409, err.Error())
			return
		}
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case rest == "export" && r.Method == "GET":
		if !need() {
			return
		}
		var ids []string
		if q := r.URL.Query().Get("ids"); q != "" {
			ids = strings.Split(q, ",")
		}
		var buf bytes.Buffer
		if err := s.plat.py.Export(&buf, ids); err != nil {
			s.fail(w, 409, err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/gzip")
		w.Header().Set("Content-Disposition", `attachment; filename="ansible-runtimes-`+time.Now().UTC().Format("20060102")+`.tar.gz"`)
		w.Write(buf.Bytes())
	case rest == "wheels" && r.Method == "POST":
		if !need() {
			return
		}
		s.handlePyWheels(w, r)
	case rest == "import" && r.Method == "POST":
		if !need() {
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<30)
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			s.fail(w, 400, "上传失败：文件读不出来，或者太大了")
			return
		}
		defer r.MultipartForm.RemoveAll()
		f, _, err := r.FormFile("pack")
		if err != nil {
			s.fail(w, 400, "请选择导出的运行环境包")
			return
		}
		defer f.Close()
		got, err := s.plat.py.Import(f)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		s.auditReq(r, "python-runtime-import", session.User, "")
		s.writeJSON(w, 200, got)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) pyRequirements(ansible string, pins map[string]string) ([]string, string, error) {
	if !pyVerRE.MatchString(ansible) {
		return nil, "", errors.New("请选择 ansible-core 版本")
	}
	want := map[string]string{"ansible-core": ansible}
	for n, v := range pins {
		if !pyNameRE.MatchString(n) || !pyVerRE.MatchString(v) {
			return nil, "", errors.New("固定的版本无效：" + n + "==" + v)
		}
		want[pkglib.NormPy(n)] = v
	}
	var reqs []string
	for n, v := range want {
		reqs = append(reqs, n+"=="+v)
	}
	sort.Strings(reqs)
	return reqs, "ansible-core " + ansible, nil
}

func (s *storeServer) startDataTask(platform, user string, run func(context.Context, *pkglib.Reporter) error, done func(error)) (*fetchTask, error) {
	def := mwpack.PlatformDef{ID: platform}
	st := s.lib()
	st.mu.Lock()
	if st.busy {
		st.mu.Unlock()
		return nil, errors.New("软件库正在被另一个操作使用，请稍后")
	}
	st.busy = true
	kind := "python"
	if platform != "python" {
		kind = platform
	}
	t := &fetchTask{ID: randomStoreToken(8), Kind: kind, Platform: def.ID, Packages: []mwpack.PackageRequest{}, State: "running", Started: nowStamp(), Logs: []string{}, Steps: []pkglib.StepEvent{}}
	if st.tasks = append(st.tasks, t); len(st.tasks) > 60 {
		st.tasks = st.tasks[1:]
	}
	st.mu.Unlock()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
		defer cancel()
		err := run(ctx, st.reporter(t))
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
		if done != nil {
			go done(err)
		}
	}()
	return t, nil
}

// handlePyWheels takes wheel files uploaded by an administrator into the library.
func (s *storeServer) handlePyWheels(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 600<<20)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		s.fail(w, 400, "上传失败：文件读不出来，或者超过了 600 MB")
		return
	}
	defer r.MultipartForm.RemoveAll()
	files := map[string][]byte{}
	for _, fh := range r.MultipartForm.File["wheel"] {
		f, err := fh.Open()
		if err != nil {
			s.fail(w, 400, "文件无法读取")
			return
		}
		b, err := io.ReadAll(io.LimitReader(f, 200<<20))
		f.Close()
		if err != nil {
			s.fail(w, 400, "文件无法读取")
			return
		}
		files[fh.Filename] = b
	}
	if len(files) == 0 || len(files) > 200 {
		s.fail(w, 400, "请选择 1～200 个 .whl 文件")
		return
	}
	got, err := s.plat.py.AddWheels(files)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	s.writeJSON(w, 200, map[string]any{"added": got})
}

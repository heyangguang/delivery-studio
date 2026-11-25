package pkglib

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The Ansible runtime a delivery carries is not a prebuilt file any more. The platform keeps Python wheels in the
// package library, downloaded from PyPI by version (with their dependencies), and a runtime is just a list of exact
// wheels. A delivery's runtime is assembled from that list when it is generated, so fixing a vulnerable package means
// choosing a newer wheel, never rebuilding an archive.

// PyPython is the controller Python the runtimes are built for: Ansible 2.20 needs 3.12, on x86_64 Linux.
const PyPython = "3.12"

type Wheel struct {
	File    string `json:"file"`
	Name    string `json:"name"` // normalized: lower case, "-" between words
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
	Size    int64  `json:"size"`
	Fetched string `json:"fetched"`
	Via     string `json:"via"` // pypi | imported | runtime-archive
}

type PyRuntime struct {
	ID       string  `json:"id"`
	Ansible  string  `json:"ansible"`
	Python   string  `json:"python"`
	Wheels   []Wheel `json:"wheels"`
	Note     string  `json:"note,omitempty"`
	Created  string  `json:"created"`
	CreateBy string  `json:"created_by,omitempty"`
}

type pyState struct {
	Wheels   []Wheel           `json:"wheels"`
	Runtimes []PyRuntime       `json:"runtimes"`
	Defaults map[string]string `json:"defaults"` // platform id -> runtime id
}

type PyStore struct {
	Dir string
	// Python runs pip to download and resolve wheels; it needs network only for PyPI.
	Python string
	HTTP   *http.Client
	mu     sync.Mutex
}

func NewPyStore(libraryDir string) *PyStore {
	return &PyStore{Dir: filepath.Join(libraryDir, "python"), Python: "python3", HTTP: &http.Client{Timeout: 30 * time.Second}}
}

func NormPy(n string) string {
	return strings.ReplaceAll(strings.ReplaceAll(strings.ToLower(n), "_", "-"), ".", "-")
}

func (s *PyStore) wheelDir() string { return filepath.Join(s.Dir, "wheels") }

func (s *PyStore) load() pyState {
	var st pyState
	if b, err := os.ReadFile(filepath.Join(s.Dir, "state.json")); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	if st.Defaults == nil {
		st.Defaults = map[string]string{}
	}
	if st.Wheels == nil {
		st.Wheels = []Wheel{}
	}
	if st.Runtimes == nil {
		st.Runtimes = []PyRuntime{}
	}
	return st
}

func (s *PyStore) save(st pyState) error {
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	tmp := filepath.Join(s.Dir, ".state.json.tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.Dir, "state.json"))
}

// State returns the wheels, runtimes and defaults.
func (s *PyStore) State() (wheels []Wheel, runtimes []PyRuntime, defaults map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.load()
	return st.Wheels, st.Runtimes, st.Defaults
}

// Default is the runtime deliveries for a platform are assembled from, if one is chosen.
func (s *PyStore) Default(platform string) (*PyRuntime, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.load()
	id := st.Defaults[platform]
	for i := range st.Runtimes {
		if st.Runtimes[i].ID == id {
			r := st.Runtimes[i]
			return &r, true
		}
	}
	return nil, false
}

func (s *PyStore) Runtime(id string) (*PyRuntime, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.load().Runtimes {
		if r.ID == id {
			r := r
			return &r, true
		}
	}
	return nil, false
}

func (s *PyStore) SetDefault(platform, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.load()
	found := false
	for _, r := range st.Runtimes {
		found = found || r.ID == id
	}
	if !found {
		return errors.New("运行环境不存在")
	}
	st.Defaults[platform] = id
	return s.save(st)
}

func (s *PyStore) DeleteRuntime(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.load()
	for _, d := range st.Defaults {
		if d == id {
			return errors.New("这个运行环境正在作为默认使用，先把默认换成别的")
		}
	}
	keep := st.Runtimes[:0]
	for _, r := range st.Runtimes {
		if r.ID != id {
			keep = append(keep, r)
		}
	}
	st.Runtimes = keep
	return s.save(st)
}

// WheelData reads one stored wheel and checks it is still what was recorded.
func (s *PyStore) WheelData(w Wheel) ([]byte, error) {
	b, err := os.ReadFile(filepath.Join(s.wheelDir(), filepath.Base(w.File)))
	if err != nil {
		return nil, fmt.Errorf("软件库里缺少 %s", w.File)
	}
	if hexSum(b) != w.SHA256 {
		return nil, fmt.Errorf("%s 的内容与记录不符", w.File)
	}
	return b, nil
}

func hexSum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// wheelMeta reads name and version from a wheel's METADATA.
func wheelMeta(data []byte) (name, version string, err error) {
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", "", err
	}
	for _, f := range z.File {
		if strings.HasSuffix(f.Name, ".dist-info/METADATA") && strings.Count(f.Name, "/") == 1 {
			rc, err := f.Open()
			if err != nil {
				return "", "", err
			}
			msg, err := mail.ReadMessage(bufio.NewReader(io.LimitReader(rc, 1<<20)))
			rc.Close()
			if err != nil {
				return "", "", err
			}
			return NormPy(msg.Header.Get("Name")), msg.Header.Get("Version"), nil
		}
	}
	return "", "", errors.New("不是有效的 wheel")
}

// addWheel stores a wheel file and records it; an identical file already stored is kept.
func (s *PyStore) addWheel(st *pyState, file string, data []byte, via string) (Wheel, error) {
	name, version, err := wheelMeta(data)
	if err != nil {
		return Wheel{}, fmt.Errorf("%s：%v", file, err)
	}
	file = filepath.Base(file)
	w := Wheel{File: file, Name: name, Version: version, SHA256: hexSum(data), Size: int64(len(data)), Fetched: time.Now().UTC().Format(time.RFC3339), Via: via}
	for _, x := range st.Wheels {
		if x.File == file {
			if x.SHA256 != w.SHA256 {
				return Wheel{}, fmt.Errorf("%s 与软件库里同名文件内容不同", file)
			}
			return x, nil
		}
	}
	if err := os.MkdirAll(s.wheelDir(), 0o755); err != nil {
		return Wheel{}, err
	}
	if err := os.WriteFile(filepath.Join(s.wheelDir(), file), data, 0o644); err != nil {
		return Wheel{}, err
	}
	st.Wheels = append(st.Wheels, w)
	return w, nil
}

func newRuntime(ws []Wheel, note, by string) (PyRuntime, error) {
	sort.Slice(ws, func(i, j int) bool { return ws[i].Name < ws[j].Name })
	r := PyRuntime{Python: PyPython, Wheels: ws, Note: note, Created: time.Now().UTC().Format(time.RFC3339), CreateBy: by}
	hasPip := false
	for _, w := range ws {
		if w.Name == "ansible-core" {
			r.Ansible = w.Version
		}
		hasPip = hasPip || w.Name == "pip"
	}
	if r.Ansible == "" || !hasPip {
		return r, errors.New("运行环境必须包含 ansible-core 和 pip")
	}
	h := sha256.New()
	for _, w := range ws {
		h.Write([]byte(w.SHA256))
	}
	r.ID = hex.EncodeToString(h.Sum(nil))[:12]
	return r, nil
}

func (s *PyStore) addRuntime(st *pyState, r PyRuntime) PyRuntime {
	for _, x := range st.Runtimes {
		if x.ID == r.ID {
			return x
		}
	}
	st.Runtimes = append(st.Runtimes, r)
	return r
}

// ImportArchive turns an old prebuilt runtime archive into stored wheels and a runtime, once, so platforms that only
// had the archive keep working. It returns the runtime's id.
func (s *PyStore) ImportArchive(archive string) (string, error) {
	f, err := os.Open(archive)
	if err != nil {
		return "", err
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.load()
	tr := tar.NewReader(zr)
	var ws []Wheel
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		if !strings.Contains(h.Name, "/bootstrap/wheels/") || !strings.HasSuffix(h.Name, ".whl") {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(tr, 200<<20))
		if err != nil {
			return "", err
		}
		w, err := s.addWheel(&st, h.Name, data, "runtime-archive")
		if err != nil {
			return "", err
		}
		ws = append(ws, w)
	}
	r, err := newRuntime(ws, "从原运行环境文件导入", "")
	if err != nil {
		return "", err
	}
	r = s.addRuntime(&st, r)
	return r.ID, s.save(st)
}

var pipSaved = regexp.MustCompile(`(?i)(Saved|File was already downloaded) (\S+\.whl)`)

// Build resolves requirements (for example ansible-core==2.20.10 plus pins such as pip==26.2.0) to exact wheels for
// the controller Python with pip, stores them, and records the result as a runtime. With offline set, only wheels
// already in the library are used.
func (s *PyStore) Build(ctx context.Context, reqs []string, offline bool, note, by string, rep *Reporter) (PyRuntime, error) {
	rep.Emit(StepEvent{ID: "resolve", Label: "解析依赖并下载 wheel", State: "running", Detail: strings.Join(reqs, " ")})
	tmp, err := os.MkdirTemp("", "mw-wheels-")
	if err != nil {
		return PyRuntime{}, err
	}
	defer os.RemoveAll(tmp)
	_ = os.MkdirAll(s.wheelDir(), 0o755)
	args := []string{"-m", "pip", "download", "--disable-pip-version-check", "--only-binary=:all:", "--python-version", PyPython, "--implementation", "cp", "--abi", "cp312", "--abi", "abi3", "--abi", "none",
		"--platform", "manylinux_2_28_x86_64", "--platform", "manylinux_2_17_x86_64", "--platform", "manylinux2014_x86_64", "--platform", "any",
		"--find-links", s.wheelDir(), "-d", tmp}
	if offline {
		args = append(args, "--no-index")
	}
	has := map[string]bool{}
	for _, r := range reqs {
		has[NormPy(strings.FieldsFunc(r, func(c rune) bool { return strings.ContainsRune("=<>!~ ", c) })[0])] = true
	}
	if !has["pip"] {
		reqs = append(reqs, "pip")
	}
	args = append(args, reqs...)
	cmd := exec.CommandContext(ctx, s.Python, args...)
	out, err := cmd.CombinedOutput()
	rep.Logf("%s", out)
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if i := strings.LastIndex(msg, "ERROR:"); i >= 0 {
			msg = msg[i:]
		}
		rep.Emit(StepEvent{ID: "resolve", Label: "解析依赖并下载 wheel", State: "failed", Detail: msg})
		return PyRuntime{}, fmt.Errorf("pip 无法得到这些版本：%s", msg)
	}
	files, _ := filepath.Glob(filepath.Join(tmp, "*.whl"))
	rep.Emit(StepEvent{ID: "resolve", Label: "解析依赖并下载 wheel", State: "done", Detail: fmt.Sprintf("%d 个 wheel", len(files))})
	rep.Emit(StepEvent{ID: "save", Label: "存入软件库", State: "running"})
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.load()
	var ws []Wheel
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			return PyRuntime{}, err
		}
		via := "pypi"
		if offline {
			via = "library"
		}
		w, err := s.addWheel(&st, f, data, via)
		if err != nil {
			return PyRuntime{}, err
		}
		ws = append(ws, w)
	}
	r, err := newRuntime(ws, note, by)
	if err != nil {
		rep.Emit(StepEvent{ID: "save", Label: "存入软件库", State: "failed", Detail: err.Error()})
		return r, err
	}
	r = s.addRuntime(&st, r)
	if err := s.save(st); err != nil {
		return r, err
	}
	rep.Emit(StepEvent{ID: "save", Label: "存入软件库", State: "done", Detail: "运行环境 " + r.ID})
	return r, nil
}

// Versions lists the versions of a package on PyPI that have wheels, newest first.
func (s *PyStore) Versions(ctx context.Context, name string) ([]string, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://pypi.org/pypi/"+NormPy(name)+"/json", nil)
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法访问 PyPI：%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("PyPI 返回 %d", resp.StatusCode)
	}
	var doc struct {
		Releases map[string][]struct {
			PackageType string `json:"packagetype"`
			Yanked      bool   `json:"yanked"`
		} `json:"releases"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&doc); err != nil {
		return nil, err
	}
	var out []string
	for v, files := range doc.Releases {
		ok := false
		for _, f := range files {
			ok = ok || (f.PackageType == "bdist_wheel" && !f.Yanked)
		}
		if ok && !isPre(v) {
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool { return ComparePy(out[i], out[j]) > 0 })
	if len(out) > 40 {
		out = out[:40]
	}
	return out, nil
}

type pyPack struct {
	Schema   string      `json:"schema"`
	Runtimes []PyRuntime `json:"runtimes"`
}

// Export writes the chosen runtimes and their wheels as one tar.gz for carrying to an offline platform.
func (s *PyStore) Export(w io.Writer, ids []string) error {
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	_, runtimes, _ := s.State()
	var picked []PyRuntime
	for _, r := range runtimes {
		if want[r.ID] || len(ids) == 0 {
			picked = append(picked, r)
		}
	}
	if len(picked) == 0 {
		return errors.New("没有可导出的运行环境")
	}
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	put := func(name string, data []byte) error {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data)), ModTime: time.Now()}); err != nil {
			return err
		}
		_, err := tw.Write(data)
		return err
	}
	pack, _ := json.MarshalIndent(pyPack{Schema: "mwpy/v1", Runtimes: picked}, "", "  ")
	if err := put("pack.json", pack); err != nil {
		return err
	}
	done := map[string]bool{}
	for _, r := range picked {
		for _, wh := range r.Wheels {
			if done[wh.File] {
				continue
			}
			done[wh.File] = true
			data, err := s.WheelData(wh)
			if err != nil {
				return err
			}
			if err := put("wheels/"+wh.File, data); err != nil {
				return err
			}
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

// Import accepts an export: every wheel is checked against the hash its runtime records.
func (s *PyStore) Import(r io.Reader) ([]PyRuntime, error) {
	zr, err := gzip.NewReader(r)
	if err != nil {
		return nil, errors.New("不是平台导出的运行环境包")
	}
	tr := tar.NewReader(zr)
	var pack pyPack
	files := map[string][]byte{}
	var total int64
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(tr, 200<<20))
		if err != nil {
			return nil, err
		}
		total += int64(len(data))
		if total > 2<<30 {
			return nil, errors.New("导入包太大")
		}
		if h.Name == "pack.json" {
			if json.Unmarshal(data, &pack) != nil {
				return nil, errors.New("pack.json 无效")
			}
		} else if strings.HasPrefix(h.Name, "wheels/") {
			files[filepath.Base(h.Name)] = data
		}
	}
	if pack.Schema != "mwpy/v1" || len(pack.Runtimes) == 0 {
		return nil, errors.New("不是平台导出的运行环境包")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.load()
	var out []PyRuntime
	for _, rt := range pack.Runtimes {
		var ws []Wheel
		for _, wh := range rt.Wheels {
			data, ok := files[wh.File]
			if !ok {
				return nil, fmt.Errorf("导入包缺少 %s", wh.File)
			}
			if hexSum(data) != wh.SHA256 {
				return nil, fmt.Errorf("%s 的内容与清单不符，可能被改过", wh.File)
			}
			w, err := s.addWheel(&st, wh.File, data, "imported")
			if err != nil {
				return nil, err
			}
			ws = append(ws, w)
		}
		nr, err := newRuntime(ws, rt.Note, rt.CreateBy)
		if err != nil {
			return nil, err
		}
		nr.Created = rt.Created
		out = append(out, s.addRuntime(&st, nr))
	}
	return out, s.save(st)
}

// Lock is the requirements file the bootstrap installs from: exact versions, each pinned to its hash.
func (r PyRuntime) Lock() string {
	var b strings.Builder
	for _, w := range r.Wheels {
		fmt.Fprintf(&b, "%s==%s --hash=sha256:%s\n", w.Name, w.Version, w.SHA256)
	}
	return b.String()
}

// AddWheels stores wheel files somebody downloaded elsewhere (the offline way to bring a fixed package in) and returns
// what was added. A file that is not a wheel, or whose name collides with a different file, stops the whole call.
func (s *PyStore) AddWheels(files map[string][]byte) ([]Wheel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.load()
	var out []Wheel
	names := make([]string, 0, len(files))
	for f := range files {
		names = append(names, f)
	}
	sort.Strings(names)
	for _, f := range names {
		if !strings.HasSuffix(f, ".whl") || strings.ContainsAny(f, "/\\") {
			return nil, fmt.Errorf("%s 不是 .whl 文件", f)
		}
		w, err := s.addWheel(&st, f, files[f], "upload")
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, s.save(st)
}

func isPre(v string) bool {
	return regexp.MustCompile(`(?i)(a|b|rc|c|dev|alpha|beta|pre)\d*$`).MatchString(v)
}

var pyPart = regexp.MustCompile(`\d+|[a-z]+`)

// ComparePy orders Python versions: numeric release segments, then pre-releases (a, b, rc) before the release and
// post-releases after it.
func ComparePy(a, b string) int {
	pa, pb := pyKey(a), pyKey(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y float64
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

func pyKey(v string) []float64 {
	var out []float64
	for _, t := range pyPart.FindAllString(strings.ToLower(v), -1) {
		if n, err := strconv.Atoi(t); err == nil {
			out = append(out, float64(n))
			continue
		}
		switch t {
		case "a", "alpha":
			out = append(out, -3)
		case "b", "beta":
			out = append(out, -2)
		case "rc", "c", "pre", "preview":
			out = append(out, -1)
		case "post", "rev", "r":
			out = append(out, 0.5)
		case "dev":
			out = append(out, -4)
		}
	}
	return out
}

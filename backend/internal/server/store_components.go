package server

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"gopkg.in/yaml.v3"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"delivery-studio/mwpack"
)

const (
	maxPackBytes = 8 << 20
	maxPackFiles = 400
)

// componentSource reports where a component comes from: "builtin", "custom", or "override" (a custom pack that
// replaces a built-in component of the same name).
func (s *storeServer) componentSource(name string) string {
	custom := s.comps().hasLive(name)
	_, builtin := builtinNames()[name]
	switch {
	case custom && builtin:
		return "override"
	case custom:
		return "custom"
	}
	return "builtin"
}

func builtinNames() map[string]struct{} {
	out := map[string]struct{}{}
	if entries, err := fs.ReadDir(builtinFS(), "."); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				if _, err := fs.Stat(builtinFS(), path.Join(e.Name(), "component.yaml")); err == nil {
					out[e.Name()] = struct{}{}
				}
			}
		}
	}
	return out
}

func (s *storeServer) handleComponents(w http.ResponseWriter, r *http.Request, session storeSession) {
	if r.URL.Path == "/api/components/platform-shared/parameters" && r.Method == "GET" {
		c, e := s.plat.cat().HostContract()
		if e != nil {
			s.fail(w, 422, e.Error())
		} else {
			s.writeJSON(w, 200, mwpack.LocalizeHostContract(wLang(w), c))
		}
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/components"), "/")
	parts := []string{}
	if rest != "" {
		parts = strings.Split(rest, "/")
	}
	if len(parts) == 1 && parts[0] == sharedPlatformName && r.Method == "DELETE" {
		s.fail(w, 400, "平台公共流程不能删除，请在工作台恢复内置修订")
		return
	}
	if s.workbench(w, r, session, parts) {
		return
	}
	switch {
	case len(parts) == 0 && r.Method == "GET":
		s.listComponents(w)
	case len(parts) == 1 && parts[0] == "validate" && r.Method == "POST":
		s.validateManifest(w, r)
	case len(parts) == 1 && parts[0] == "import" && r.Method == "POST":
		if !s.need(w, session.User, "component.import") {
			return
		}
		s.importComponent(w, r, session)
	case len(parts) == 1 && r.Method == "GET":
		s.componentSchema(w, r, parts[0])
	case len(parts) == 1 && r.Method == "DELETE":
		if !s.need(w, session.User, "component.publish") {
			return
		}
		s.deleteComponent(w, r, session, parts[0])
	case len(parts) == 2 && parts[1] == "manifest" && r.Method == "GET":
		s.componentManifest(w, parts[0])
	case len(parts) == 2 && parts[1] == "verifications" && r.Method == "GET":
		s.getCompVerifications(w, r, session, parts[0])
	case len(parts) == 3 && parts[1] == "verifications" && r.Method == "DELETE":
		s.deleteCompVerification(w, r, session, parts[0], parts[2])
	case len(parts) == 2 && parts[1] == "pack" && r.Method == "GET":
		s.componentPack(w, parts[0])
	default:
		s.fail(w, 404, "接口不存在")
	}
}

type componentListing struct {
	catalogEntry
	Source   string `json:"source"`
	HasDraft bool   `json:"has_draft,omitempty"`
	Rev      int    `json:"rev,omitempty"`
	Broken   bool   `json:"broken,omitempty"`
	Problem  string `json:"problem,omitempty"`
}

// listComponents shows every component, including those that cannot be generated yet and customer-operated ones.
func (s *storeServer) listComponents(w http.ResponseWriter) {
	lang := wLang(w)
	cs := s.comps()
	brokenByName := map[string]string{}
	for _, b := range s.plat.brokenList() {
		brokenByName[b.Name] = b.Error
	}
	inCatalog := map[string]bool{}
	out := []componentListing{}
	for _, e := range s.plat.entriesWith(true) {
		inCatalog[e.Name] = true
		item := componentListing{
			catalogEntry: localizeCatalogEntry(lang, e),
			Source:       s.componentSource(e.Name),
			HasDraft:     cs.hasDraft(e.Name),
			Rev:          cs.liveRev(e.Name),
		}
		if prob, bad := brokenByName[e.Name]; bad {
			item.Broken = true
			item.Problem = prob
		}
		out = append(out, item)
	}
	// A component that exists only as a draft (never published) is listed too, so the work is not lost from view.
	known := map[string]bool{}
	for _, c := range out {
		known[c.Name] = true
	}
	for _, b := range s.plat.brokenList() {
		known[b.Name] = true
	}
	for _, dname := range cs.draftNames() {
		if dname == sharedPlatformName || known[dname] || !cs.hasDraft(dname) {
			continue
		}
		e := catalogEntry{Info: mwpack.Info{Name: dname, Title: dname, Category: tr(lang, "草稿", "Draft"), Summary: tr(lang, "尚未发布的新组件", "Unpublished new component"), Versions: []mwpack.VerInfo{}, Roles: []mwpack.RoleSpec{}}, Versions: []versionEntry{}, Materials: []catalogMaterial{}, Reason: tr(lang, "尚未发布", "Not published yet")}
		out = append(out, componentListing{catalogEntry: e, Source: "draft", HasDraft: true})
	}
	// Custom components that cannot be loaded stay visible so the administrator can fix or delete them.
	// Built-in components with a broken override are already in `out` (falling back to built-in) and must not be duplicated.
	for _, b := range s.plat.brokenList() {
		if inCatalog[b.Name] {
			continue
		}
		e := catalogEntry{Info: mwpack.Info{Name: b.Name, Title: b.Name, Category: tr(lang, "无法载入", "Load Error"), Summary: tr(lang, "这个自定义组件无法载入，已被跳过：", "This custom component failed to load and was skipped: ") + b.Error, Versions: []mwpack.VerInfo{}, Roles: []mwpack.RoleSpec{}}, Versions: []versionEntry{}, Materials: []catalogMaterial{}, Reason: b.Error}
		out = append(out, componentListing{catalogEntry: e, Source: "custom", Broken: true, Problem: b.Error})
	}
	s.writeJSON(w, 200, out)
}

func (s *storeServer) componentManifest(w http.ResponseWriter, name string) {
	c, ok := s.plat.cat().Get(name)
	if !ok {
		// A custom component that failed to load can still be read, so it can be fixed.
		if nameRE.MatchString(name) {
			if b, err := os.ReadFile(filepath.Join(s.plat.componentsDir, name, "component.yaml")); err == nil {
				s.writeJSON(w, 200, map[string]any{"yaml": string(b), "source": "custom"})
				return
			}
		}
		s.fail(w, 404, "组件不存在")
		return
	}
	fsys, dir := c.FS()
	// Readers consume a complete manifest; editing/export retain the original files.
	doc, _, err := mwpack.ExpandManifest(func(file string) ([]byte, error) { return fs.ReadFile(fsys, path.Join(dir, file)) })
	if err != nil {
		s.fail(w, 422, "清单引用无法展开："+err.Error())
		return
	}
	var value any
	if err = doc.Decode(&value); err != nil {
		s.fail(w, 422, "清单无法解析："+err.Error())
		return
	}
	value = mwpack.LocalizeYAMLValue(wLang(w), value)
	b, err := yaml.Marshal(value)
	if err != nil {
		s.fail(w, 500, "清单不可读")
		return
	}
	s.writeJSON(w, 200, map[string]any{"yaml": string(b), "source": s.componentSource(name)})
}

// componentPack streams a component as a tar.gz: component.yaml, roles/, templates/, files/.
func (s *storeServer) componentPack(w http.ResponseWriter, name string) {
	c, ok := s.plat.cat().Get(name)
	if !ok {
		s.fail(w, 404, "组件不存在")
		return
	}
	fsys, dir := c.FS()
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s.tar.gz", name))
	gz := gzip.NewWriter(w)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()
	_ = fs.WalkDir(fsys, dir, func(fp string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(fsys, fp)
		if err != nil {
			return err
		}
		mode := int64(0o644)
		if strings.HasSuffix(fp, ".sh") || strings.HasSuffix(fp, ".py") {
			mode = 0o755
		}
		if err := tw.WriteHeader(&tar.Header{Name: fp, Mode: mode, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
			return err
		}
		_, err = tw.Write(data)
		return err
	})
}

type manifestResult struct {
	OK       bool             `json:"ok"`
	Error    string           `json:"error,omitempty"`
	Problems []mwpack.Problem `json:"problems"`
	Name     string           `json:"name,omitempty"`
	Versions []mwpack.VerInfo `json:"versions,omitempty"`
}

func manifestProblems(cat *mwpack.Catalog, data []byte) (*mwpack.Component, manifestResult) {
	res := manifestResult{Problems: []mwpack.Problem{}}
	c, err := mwpack.ParseComponent(data)
	if err != nil {
		res.Problems = append(res.Problems, mwpack.Problem{Severity: "error", Message: err.Error()})
		return nil, res
	}
	res.Name = c.Name
	res.Problems = append(res.Problems, mwpack.ValidateComponent(c, cat)...)
	res.OK = true
	for _, p := range res.Problems {
		if p.Severity == "error" {
			res.OK = false
		}
	}
	for _, v := range c.Versions {
		res.Versions = append(res.Versions, mwpack.VerInfo{ID: v.ID, Status: v.Status})
	}
	return c, res
}

func (s *storeServer) validateManifest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		YAML string `json:"yaml"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	_, res := manifestProblems(s.plat.cat(), []byte(body.YAML))
	s.writeJSON(w, 200, res)
}

// ---- import ----

var errPack = errors.New("这不是有效的组件包，请检查文件")

func packErr(f string, a ...any) error { return fmt.Errorf("%w：%s", errPack, fmt.Sprintf(f, a...)) }

// extractPack reads a tar.gz or zip into memory, keeping only safe regular files. Paths are relative to the single
// top-level directory (the component name) when the pack has one, or the archive root when it holds component.yaml.
func extractPack(data []byte, filename string) (map[string][]byte, error) {
	files := map[string][]byte{}
	var total int64
	add := func(name string, size int64, open func() (io.Reader, error), isDir, isReg bool) error {
		if isDir {
			return nil
		}
		if !isReg {
			return packErr("%s 不是普通文件（不接受链接或设备）", name)
		}
		clean := path.Clean(strings.ReplaceAll(name, "\\", "/"))
		if clean == "." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") || strings.Contains(clean, "\x00") {
			return packErr("路径 %q 不安全", name)
		}
		if len(files) >= maxPackFiles {
			return packErr("文件超过 %d 个", maxPackFiles)
		}
		total += size
		if size < 0 || size > 2<<20 || total > maxPackBytes {
			return packErr("文件过大")
		}
		rd, err := open()
		if err != nil {
			return err
		}
		b, err := io.ReadAll(io.LimitReader(rd, size+1))
		if err != nil || int64(len(b)) != size {
			return packErr("%s 读取不完整", name)
		}
		if _, dup := files[clean]; dup {
			return packErr("路径重复：%s", clean)
		}
		files[clean] = b
		return nil
	}
	switch {
	case strings.HasSuffix(filename, ".zip"):
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, packErr("不是有效的 zip")
		}
		for _, f := range zr.File {
			f := f
			err := add(f.Name, int64(f.UncompressedSize64), func() (io.Reader, error) { return f.Open() }, f.FileInfo().IsDir(), f.FileInfo().Mode().IsRegular())
			if err != nil {
				return nil, err
			}
		}
	case strings.HasSuffix(filename, ".tar.gz") || strings.HasSuffix(filename, ".tgz"):
		gz, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, packErr("不是有效的 tar.gz")
		}
		tr := tar.NewReader(gz)
		for {
			h, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, packErr("tar 读取失败")
			}
			if err := add(h.Name, h.Size, func() (io.Reader, error) { return tr, nil }, h.Typeflag == tar.TypeDir, h.Typeflag == tar.TypeReg); err != nil {
				return nil, err
			}
		}
	default:
		return nil, packErr("只支持 .tar.gz 或 .zip")
	}
	// A single wrapping directory is stripped.
	if _, ok := files["component.yaml"]; !ok {
		top := ""
		for name := range files {
			first := strings.SplitN(name, "/", 2)[0]
			if top == "" {
				top = first
			} else if top != first {
				return nil, packErr("组件包应只有一个顶层目录（组件名），其中含 component.yaml")
			}
		}
		stripped := map[string][]byte{}
		for name, b := range files {
			stripped[strings.TrimPrefix(name, top+"/")] = b
		}
		files = stripped
	}
	if _, ok := files["component.yaml"]; !ok {
		return nil, packErr("缺少 component.yaml")
	}
	return files, nil
}

var allowedPackDirs = map[string]bool{"manifest": true, "roles": true, "templates": true, "files": true}

func (s *storeServer) importComponent(w http.ResponseWriter, r *http.Request, session storeSession) {
	r.Body = http.MaxBytesReader(w, r.Body, maxPackBytes+(1<<20))
	var files map[string][]byte
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var body struct {
			YAML string `json:"yaml"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		files = map[string][]byte{"component.yaml": []byte(body.YAML)}
	} else {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			s.fail(w, 400, "上传失败：文件读不出来，或者超过了 8 MiB")
			return
		}
		defer r.MultipartForm.RemoveAll()
		f, h, err := r.FormFile("pack")
		if err != nil {
			s.fail(w, 400, "请选择组件包")
			return
		}
		defer f.Close()
		data, err := io.ReadAll(io.LimitReader(f, maxPackBytes+1))
		if err != nil || len(data) > maxPackBytes {
			s.fail(w, 400, "组件包超过 8MiB")
			return
		}
		files, err = extractPack(data, strings.ToLower(h.Filename))
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
	}
	for name := range files {
		top := strings.SplitN(name, "/", 2)[0]
		if name != "component.yaml" && !allowedPackDirs[top] {
			s.fail(w, 400, packErr("不允许的文件 %s（只可含 component.yaml、manifest/、roles/、templates/、files/）", name).Error())
			return
		}
	}
	expanded, _, expansionErr := mwpack.ExpandManifest(fileSet(files).manifestRead)
	if expansionErr != nil {
		s.fail(w, 422, expansionErr.Error())
		return
	}
	manifestBytes, _ := yaml.Marshal(expanded)
	c, res := manifestProblems(s.plat.cat(), manifestBytes)
	if c == nil || !res.OK {
		res.Error = firstProblem(res)
		s.writeJSON(w, 422, res)
		return
	}
	if c.Name == sharedPlatformName {
		s.fail(w, 400, "平台公共流程请通过工作台检查和发布")
		return
	}
	// Validate in place: the pack goes into a staging directory beside the real one and is loaded together with
	// everything else, so cross-component rules (default_impl) and role-file checks see the real picture.
	root := s.plat.componentsDir
	scratch := filepath.Dir(root)
	stage, err := os.MkdirTemp(scratch, ".component-stage-")
	if err != nil {
		s.fail(w, 500, "无法准备组件目录")
		return
	}
	defer os.RemoveAll(stage)
	for name, b := range files {
		dest := filepath.Join(stage, c.Name, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			s.fail(w, 500, "无法写入组件")
			return
		}
		mode := os.FileMode(0o600)
		if strings.HasSuffix(name, ".sh") || strings.HasSuffix(name, ".py") {
			mode = 0o700
		}
		if err := os.WriteFile(dest, b, mode); err != nil {
			s.fail(w, 500, "无法写入组件")
			return
		}
	}
	// Load builtin + existing packs (minus the one being replaced) + the staged one.
	trial, err := loadWithStaged(s.plat, c.Name, stage)
	if err == nil {
		if _, ok := trial.Get(c.Name); !ok {
			err = fmt.Errorf("组件 %s 无法与现有组件一起载入", c.Name)
		}
	}
	if err != nil {
		res.OK = false
		res.Problems = append(res.Problems, mwpack.Problem{Severity: "error", Message: err.Error()})
		res.Error = firstProblem(res)
		s.writeJSON(w, 422, res)
		return
	}
	_ = trial
	target := filepath.Join(root, c.Name)
	compMu.Lock()
	defer compMu.Unlock()
	prevSet, _, _ := s.comps().liveSet(c.Name)
	backup := ""
	if _, err := os.Stat(target); err == nil {
		backup = filepath.Join(scratch, ".component-trash-"+name2(c.Name)+"-"+randomStoreToken(4))
		if err := os.Rename(target, backup); err != nil {
			s.fail(w, 500, "无法替换现有组件")
			return
		}
	}
	if err := os.Rename(filepath.Join(stage, c.Name), target); err != nil {
		if backup != "" {
			os.Rename(backup, target)
		}
		s.fail(w, 500, "无法安装组件")
		return
	}
	if err := s.plat.reload(); err != nil {
		os.RemoveAll(target)
		if backup != "" {
			os.Rename(backup, target)
		}
		_ = s.plat.reload()
		s.fail(w, 500, "组件载入失败，已回退："+err.Error())
		return
	}
	if backup != "" {
		os.RemoveAll(backup)
	}
	if rev, err := s.comps().recordPublish(c.Name, prevSet, fileSet(files), session.User, "导入"); err == nil {
		s.auditReq(r, "component-import", session.User, fmt.Sprintf("%s#%d", c.Name, rev))
	} else {
		s.auditReq(r, "component-import", session.User, c.Name)
	}
	res.OK = true
	s.writeJSON(w, 200, res)
}

// loadWithStaged proves the catalog still loads with the staged component in place of any current custom one.
func loadWithStaged(p *platform, name, stage string) (*mwpack.Catalog, error) {
	mix, err := os.MkdirTemp(filepath.Dir(p.componentsDir), ".trial-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(mix)
	entries, _ := os.ReadDir(p.componentsDir)
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || e.Name() == name {
			continue
		}
		if err := copyTree(filepath.Join(p.componentsDir, e.Name()), filepath.Join(mix, e.Name())); err != nil {
			return nil, err
		}
	}
	if err := copyTree(filepath.Join(stage, name), filepath.Join(mix, name)); err != nil {
		return nil, err
	}
	cat, broken, err := p.load(mix)
	if err != nil {
		return nil, err
	}
	for _, b := range broken {
		if b.Name == name {
			return nil, errors.New(b.Error)
		}
	}
	return cat, nil
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o600)
	})
}

func (s *storeServer) deleteComponent(w http.ResponseWriter, r *http.Request, session storeSession, name string) {
	if !nameRE.MatchString(name) {
		s.fail(w, 404, "组件不存在")
		return
	}
	src := s.componentSource(name)
	if src == "builtin" {
		s.fail(w, 409, "内置组件不能删除")
		return
	}
	compMu.Lock()
	defer compMu.Unlock()
	cs := s.comps()
	// Restoring a built-in keeps its revision history (so the override can be looked at); deleting a custom component
	// removes everything about it, including any draft.
	var rmErr error
	if src == "override" {
		rmErr = os.RemoveAll(cs.live(name))
		if rmErr == nil {
			rmErr = cs.discardDraft(name)
		}
	} else {
		rmErr = cs.removeAll(name)
	}
	if rmErr != nil {
		s.fail(w, 500, "删除失败，请稍后重试")
		return
	}
	if err := s.plat.reload(); err != nil {
		s.fail(w, 500, "组件目录重新载入失败："+err.Error())
		return
	}
	s.auditReq(r, "component-delete", session.User, name)
	s.writeJSON(w, 200, map[string]bool{"ok": true})
}

func name2(s string) string { return s }

func firstProblem(r manifestResult) string {
	n := 0
	first := ""
	for _, p := range r.Problems {
		if p.Severity == "error" {
			if first == "" {
				first = p.Message
			}
			n++
		}
	}
	if n > 1 {
		return fmt.Sprintf("%s（共 %d 处错误）", first, n)
	}
	return first
}

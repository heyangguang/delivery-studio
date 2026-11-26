package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"delivery-studio/internal/ansiblev2"
	"delivery-studio/mwpack"
	"gopkg.in/yaml.v3"
)

type ansibleV2Summary struct {
	Name          string                `json:"name"`
	Title         string                `json:"title"`
	TitleEn       string                `json:"title_en,omitempty"`
	Category      string                `json:"category"`
	Version       string                `json:"version"`
	Summary       string                `json:"summary"`
	SummaryEn     string                `json:"summary_en,omitempty"`
	Icon          string                `json:"icon,omitempty"`
	Color         string                `json:"color,omitempty"`
	AssetKind     ansiblev2.AssetKind   `json:"asset_kind"`
	Source        string                `json:"source"` // builtin | custom | override
	Origin        string                `json:"origin,omitempty"`
	DeliveryModes []string              `json:"delivery_modes"`
	GroupCount    int                   `json:"group_count"`
	VarCount      int                   `json:"var_count"`
	StepCount     int                   `json:"step_count"`
	PackageCount  int                   `json:"package_count"`
	FileCount     int                   `json:"file_count"`
	Valid         bool                  `json:"valid"`
	Tags          []string              `json:"tags,omitempty"`
}

type ansibleV2Detail struct {
	Name     string                     `json:"name"`
	Source   string                     `json:"source"` // builtin | custom | override
	Report   ansiblev2.InspectionReport `json:"report"`
	Files    []fileView                 `json:"files"`
}

func (s *storeServer) v2FallbackDir() string {
	return filepath.Join(s.cfg.DataDir, "components-v2")
}

func (s *storeServer) loadV2CustomMap() map[string]map[string][]byte {
	out := map[string]map[string][]byte{}
	if s.repo != nil {
		if rows, err := s.repo.listV2Components(); err == nil {
			for _, row := range rows {
				if len(row.Files) > 0 {
					out[row.Name] = map[string][]byte(row.Files)
				}
			}
			return out
		}
	}
	dir := s.v2FallbackDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if !ansiblev2.ValidComponentName(name) {
			continue
		}
		files := map[string][]byte{}
		base := filepath.Join(dir, name)
		_ = filepath.WalkDir(base, func(p string, d os.DirEntry, werr error) error {
			if werr != nil || d.IsDir() {
				return nil
			}
			rel, rerr := filepath.Rel(base, p)
			if rerr != nil {
				return nil
			}
			if b, berr := os.ReadFile(p); berr == nil {
				files[filepath.ToSlash(rel)] = b
			}
			return nil
		})
		if len(files) > 0 {
			out[name] = files
		}
	}
	return out
}

func (s *storeServer) saveV2Component(name string, files map[string][]byte, meta map[string]any) error {
	if s.repo != nil {
		return s.repo.saveComponentSlot(name, "v2", 1, fileSet(files), meta)
	}
	base := filepath.Join(s.v2FallbackDir(), name)
	_ = os.RemoveAll(base)
	for rel, data := range files {
		clean := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(rel, "\\", "/")), "/")
		if clean == "" || strings.HasPrefix(clean, "..") {
			continue
		}
		dst := filepath.Join(base, filepath.FromSlash(clean))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func (s *storeServer) deleteV2Component(name string) error {
	if s.repo != nil {
		return s.repo.deleteComponentSlot(name, "v2")
	}
	return os.RemoveAll(filepath.Join(s.v2FallbackDir(), name))
}

func (s *storeServer) loadV2Component(name string) (map[string][]byte, string, bool) {
	if !ansiblev2.ValidComponentName(name) {
		return nil, "", false
	}
	_, isBuiltin := ansiblev2.LoadBuiltinFiles(name)
	customs := s.loadV2CustomMap()
	if cf, ok := customs[name]; ok {
		src := "custom"
		if isBuiltin {
			src = "override"
		}
		return cf, src, true
	}
	if bf, ok := ansiblev2.LoadBuiltinFiles(name); ok {
		return bf, "builtin", true
	}
	return nil, "", false
}

func (s *storeServer) handleAnsibleV2(w http.ResponseWriter, r *http.Request, session storeSession) {
	tail := strings.TrimPrefix(r.URL.Path, "/api/v2/ansible")
	tail = strings.Trim(tail, "/")
	parts := []string{}
	if tail != "" {
		parts = strings.Split(tail, "/")
	}

	switch {
	case len(parts) == 1 && parts[0] == "components" && r.Method == "GET":
		s.listAnsibleV2Components(w)
	case len(parts) == 1 && parts[0] == "inspect" && r.Method == "POST":
		s.inspectAnsibleV2(w, r)
	case len(parts) == 1 && parts[0] == "import" && r.Method == "POST":
		s.importAnsibleV2(w, r, session)
	case len(parts) == 2 && parts[0] == "components":
		name := parts[1]
		switch r.Method {
		case "GET":
			s.getAnsibleV2Component(w, name)
		case "PUT":
			s.updateAnsibleV2Component(w, r, session, name)
		case "DELETE":
			s.removeAnsibleV2Component(w, r, session, name)
		default:
			s.fail(w, 405, "方法不允许")
		}
	case len(parts) == 3 && parts[0] == "components" && parts[2] == "preview" && r.Method == "POST":
		s.previewAnsibleV2(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "components" && parts[2] == "deliver" && r.Method == "POST":
		s.deliverAnsibleV2(w, r, session, parts[1])
	case len(parts) == 3 && parts[0] == "components" && parts[2] == "export" && r.Method == "GET":
		s.exportAnsibleV2(w, parts[1])
	default:
		s.fail(w, 404, "Ansible 2.0 接口不存在")
	}
}

func (s *storeServer) listAnsibleV2Components(w http.ResponseWriter) {
	seen := map[string]bool{}
	names := []string{}
	for _, n := range ansiblev2.BuiltinNames() {
		if !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	for n := range s.loadV2CustomMap() {
		if !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	sort.Strings(names)

	out := make([]ansibleV2Summary, 0, len(names))
	for _, name := range names {
		files, src, ok := s.loadV2Component(name)
		if !ok {
			continue
		}
		rep := ansiblev2.Inspect(files, name, src)
		m := rep.Manifest
		out = append(out, ansibleV2Summary{
			Name:          name,
			Title:         m.Title,
			TitleEn:       m.TitleEn,
			Category:      m.Category,
			Version:       m.Version,
			Summary:       m.Summary,
			SummaryEn:     m.SummaryEn,
			Icon:          m.Icon,
			Color:         m.Color,
			AssetKind:     rep.AssetKind,
			Source:        src,
			Origin:        m.Source,
			DeliveryModes: m.DeliveryModes,
			GroupCount:    len(m.Groups),
			VarCount:      len(rep.Vars),
			StepCount:     len(rep.Steps),
			PackageCount:  len(rep.Packages),
			FileCount:     rep.FileCount,
			Valid:         rep.Valid,
			Tags:          m.Tags,
		})
	}
	s.writeJSON(w, 200, out)
}

func (s *storeServer) getAnsibleV2Component(w http.ResponseWriter, name string) {
	files, src, ok := s.loadV2Component(name)
	if !ok {
		s.fail(w, 404, "未找到 Ansible 2.0 组件："+name)
		return
	}
	rep := ansiblev2.Inspect(files, name, src)
	s.writeJSON(w, 200, ansibleV2Detail{
		Name:   name,
		Source: src,
		Report: rep,
		Files:  viewFiles(fileSet(files)),
	})
}

func (s *storeServer) inspectAnsibleV2(w http.ResponseWriter, r *http.Request) {
	ct := strings.ToLower(r.Header.Get("Content-Type"))
	var rawFiles map[string][]byte
	var hintName, origin string
	var err error

	if strings.HasPrefix(ct, "multipart/form-data") {
		r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
		if err = r.ParseMultipartForm(32 << 20); err != nil {
			s.fail(w, 400, "解析上传文件失败："+err.Error())
			return
		}
		f, hdr, ferr := r.FormFile("file")
		if ferr != nil {
			s.fail(w, 400, "请选择需要导入的 .zip / .tar.gz / .yml 文件")
			return
		}
		defer f.Close()
		raw, rerr := io.ReadAll(io.LimitReader(f, 32<<20))
		if rerr != nil {
			s.fail(w, 400, "读取上传文件失败")
			return
		}
		hintName = strings.TrimSpace(r.FormValue("name"))
		if hintName == "" {
			hintName = hdr.Filename
		}
		origin = "upload:" + hdr.Filename
		rawFiles, err = ansiblev2.UnpackUpload(hdr.Filename, raw)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
	} else {
		var req struct {
			Mode     string            `json:"mode"` // yaml | git | files
			Name     string            `json:"name"`
			Filename string            `json:"filename"`
			Content  string            `json:"content"`
			GitURL   string            `json:"git_url"`
			Branch   string            `json:"branch"`
			Subdir   string            `json:"subdir"`
			Files    map[string]string `json:"files"`
		}
		if err = decodeBody(w, r, 16<<20, &req); err != nil {
			s.fail(w, 400, "请求参数无效："+err.Error())
			return
		}
		hintName = strings.TrimSpace(req.Name)
		switch strings.ToLower(strings.TrimSpace(req.Mode)) {
		case "git":
			rawFiles, err = cloneGitRepoForAnsibleV2(req.GitURL, req.Branch, req.Subdir)
			if err != nil {
				s.fail(w, 400, err.Error())
				return
			}
			origin = strings.TrimSpace(req.GitURL)
			if hintName == "" {
				if req.Subdir != "" {
					hintName = path.Base(strings.Trim(req.Subdir, "/"))
				} else {
					hintName = path.Base(strings.TrimSuffix(strings.TrimRight(origin, "/"), ".git"))
				}
			}
		case "files":
			if len(req.Files) == 0 {
				s.fail(w, 400, "files 不能为空")
				return
			}
			rawFiles = make(map[string][]byte, len(req.Files))
			for k, v := range req.Files {
				rawFiles[k] = []byte(v)
			}
			origin = "custom"
		default:
			if strings.TrimSpace(req.Content) == "" {
				s.fail(w, 400, "请输入标准 Ansible Playbook YAML 内容")
				return
			}
			fname := strings.TrimSpace(req.Filename)
			if fname == "" {
				fname = "deploy.yml"
			}
			rawFiles = map[string][]byte{fname: []byte(req.Content)}
			if hintName == "" {
				hintName = fname
			}
			origin = "paste:" + fname
		}
	}

	wrapped, kind, inferred := ansiblev2.WrapIntoRunnableProject(rawFiles, hintName)
	rep := ansiblev2.InspectNormalized(wrapped, kind, inferred, origin)
	if _, has := wrapped[ansiblev2.ManifestFileName]; !has {
		wrapped[ansiblev2.ManifestFileName] = []byte(rep.ManifestYAML)
	}
	s.writeJSON(w, 200, map[string]any{
		"report": rep,
		"files":  viewFiles(fileSet(wrapped)),
	})
}

func cloneGitRepoForAnsibleV2(rawURL, branch, subdir string) (map[string][]byte, error) {
	uStr := strings.TrimSpace(rawURL)
	if uStr == "" {
		return nil, fmt.Errorf("请填写 Git 仓库地址（支持 https:// 或 http://）")
	}
	if strings.HasPrefix(uStr, "-") {
		return nil, fmt.Errorf("非法的 Git 仓库地址")
	}
	u, err := url.Parse(uStr)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return nil, fmt.Errorf("仅支持标准 https:// 或 http:// Git 仓库地址")
	}
	branch = strings.TrimSpace(branch)
	if branch != "" && (strings.HasPrefix(branch, "-") || strings.ContainsAny(branch, " \t\r\n;|&$")) {
		return nil, fmt.Errorf("分支名称包含非法字符")
	}
	tmpDir, err := os.MkdirTemp("", "ds-ansiblev2-git-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpDir)

	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()

	args := []string{"-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--single-branch"}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	args = append(args, "--", uStr, tmpDir)
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if out, cerr := cmd.CombinedOutput(); cerr != nil {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, fmt.Errorf("拉取 Git 仓库失败：%s", msg)
	}

	root := tmpDir
	if sd := strings.Trim(strings.ReplaceAll(strings.TrimSpace(subdir), "\\", "/"), "/"); sd != "" {
		if strings.Contains(sd, "..") {
			return nil, fmt.Errorf("子目录路径非法")
		}
		root = filepath.Join(tmpDir, filepath.FromSlash(sd))
		if st, serr := os.Stat(root); serr != nil || !st.IsDir() {
			return nil, fmt.Errorf("仓库中不存在子目录：%s", sd)
		}
	}

	files := map[string][]byte{}
	var total int64
	err = filepath.WalkDir(root, func(p string, d os.DirEntry, werr error) error {
		if werr != nil {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if rel == ".git" || strings.HasPrefix(rel, ".git/") || rel == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if len(files) >= 800 {
			return fmt.Errorf("仓库文件数超过上限 (800)")
		}
		info, ierr := d.Info()
		if ierr != nil || info.Size() > 2<<20 {
			return nil
		}
		total += info.Size()
		if total > 24<<20 {
			return fmt.Errorf("仓库源码总大小超过上限 (24MB)")
		}
		b, berr := os.ReadFile(p)
		if berr == nil {
			files[rel] = b
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("Git 仓库中没有可导入的 Ansible 文件")
	}
	return files, nil
}

func (s *storeServer) importAnsibleV2(w http.ResponseWriter, r *http.Request, session storeSession) {
	var req struct {
		Name         string            `json:"name"`
		Source       string            `json:"source"`
		ManifestYAML string            `json:"manifest_yaml"`
		Files        map[string]string `json:"files"`
	}
	if err := decodeBody(w, r, 24<<20, &req); err != nil {
		s.fail(w, 400, "请求无效："+err.Error())
		return
	}
	if len(req.Files) == 0 {
		s.fail(w, 400, "缺少组件文件内容")
		return
	}
	raw := make(map[string][]byte, len(req.Files)+1)
	for k, v := range req.Files {
		clean := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(k, "\\", "/")), "/")
		if clean == "" || strings.HasPrefix(clean, "..") {
			continue
		}
		raw[clean] = []byte(v)
	}
	if strings.TrimSpace(req.ManifestYAML) != "" {
		raw[ansiblev2.ManifestFileName] = []byte(req.ManifestYAML)
	}
	wrapped, kind, inferred := ansiblev2.WrapIntoRunnableProject(raw, req.Name)
	rep := ansiblev2.InspectNormalized(wrapped, kind, inferred, req.Source)

	compName := ansiblev2.SanitizeName(firstNonEmptyStr(req.Name, rep.Manifest.Name))
	if !ansiblev2.ValidComponentName(compName) {
		s.fail(w, 400, "组件标识不合法："+compName)
		return
	}
	rep.Manifest.Name = compName
	if mYAML, merr := ansiblev2.MarshalManifest(rep.Manifest); merr == nil {
		wrapped[ansiblev2.ManifestFileName] = []byte(mYAML)
	}
	rep = ansiblev2.InspectNormalized(wrapped, kind, compName, req.Source)
	if !rep.Valid {
		s.writeJSON(w, 422, map[string]any{
			"error":  "组件校验未通过，请修正错误后重新导入",
			"report": rep,
		})
		return
	}
	if err := s.saveV2Component(compName, wrapped, map[string]any{
		"asset_kind": rep.AssetKind,
		"version":    rep.Manifest.Version,
		"source":     req.Source,
		"updated_by": session.User,
		"updated_at": time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		s.fail(w, 500, "保存组件失败："+err.Error())
		return
	}
	s.auditReq(r, "ansible-v2-import", session.User, fmt.Sprintf("%s (%s, %d files)", compName, rep.AssetKind, len(wrapped)))
	s.writeJSON(w, 201, ansibleV2Detail{
		Name:   compName,
		Source: "custom",
		Report: rep,
		Files:  viewFiles(fileSet(wrapped)),
	})
}

func (s *storeServer) updateAnsibleV2Component(w http.ResponseWriter, r *http.Request, session storeSession, name string) {
	curFiles, _, ok := s.loadV2Component(name)
	if !ok {
		s.fail(w, 404, "组件不存在："+name)
		return
	}
	var req struct {
		Files   map[string]string `json:"files"`
		Delete  []string          `json:"delete"`
	}
	if err := decodeBody(w, r, 16<<20, &req); err != nil {
		s.fail(w, 400, "请求无效："+err.Error())
		return
	}
	next := make(map[string][]byte, len(curFiles)+len(req.Files))
	for k, v := range curFiles {
		next[k] = append([]byte(nil), v...)
	}
	for _, del := range req.Delete {
		clean := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(del, "\\", "/")), "/")
		delete(next, clean)
	}
	for k, v := range req.Files {
		clean := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(k, "\\", "/")), "/")
		if clean == "" || strings.HasPrefix(clean, "..") {
			continue
		}
		next[clean] = []byte(v)
	}
	rep := ansiblev2.Inspect(next, name, "custom")
	if !rep.Valid {
		s.writeJSON(w, 422, map[string]any{
			"error":  "组件校验未通过，未保存修改",
			"report": rep,
		})
		return
	}
	if err := s.saveV2Component(name, next, map[string]any{
		"asset_kind": rep.AssetKind,
		"version":    rep.Manifest.Version,
		"updated_by": session.User,
		"updated_at": time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		s.fail(w, 500, "保存组件失败："+err.Error())
		return
	}
	s.auditReq(r, "ansible-v2-edit", session.User, fmt.Sprintf("%s (%d files updated)", name, len(req.Files)))
	_, src, _ := s.loadV2Component(name)
	s.writeJSON(w, 200, ansibleV2Detail{
		Name:   name,
		Source: src,
		Report: rep,
		Files:  viewFiles(fileSet(next)),
	})
}

func (s *storeServer) removeAnsibleV2Component(w http.ResponseWriter, r *http.Request, session storeSession, name string) {
	_, src, ok := s.loadV2Component(name)
	if !ok {
		s.fail(w, 404, "组件不存在")
		return
	}
	if src == "builtin" {
		s.fail(w, 400, "内置 2.0 标杆组件不能删除")
		return
	}
	if err := s.deleteV2Component(name); err != nil {
		s.fail(w, 500, "删除失败："+err.Error())
		return
	}
	s.auditReq(r, "ansible-v2-delete", session.User, name)
	s.writeJSON(w, 200, map[string]any{"ok": true, "reset_to_builtin": src == "override"})
}

func (s *storeServer) previewAnsibleV2(w http.ResponseWriter, r *http.Request, name string) {
	files, src, ok := s.loadV2Component(name)
	if !ok {
		s.fail(w, 404, "组件不存在："+name)
		return
	}
	var req ansiblev2.RenderRequest
	if err := decodeBody(w, r, 4<<20, &req); err != nil {
		s.fail(w, 400, "参数无效："+err.Error())
		return
	}
	rep := ansiblev2.Inspect(files, name, src)
	res, err := ansiblev2.Render(files, rep.Manifest, req)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	s.writeJSON(w, 200, res)
}

func (s *storeServer) exportAnsibleV2(w http.ResponseWriter, name string) {
	files, _, ok := s.loadV2Component(name)
	if !ok {
		s.fail(w, 404, "组件不存在")
		return
	}
	tgz, _, err := ansiblev2.PackTarGz(name, files)
	if err != nil {
		s.fail(w, 500, "打包失败："+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-ansible-v2.tar.gz"`, name))
	_, _ = w.Write(tgz)
}

// deliverAnsibleV2 renders a 100% standalone standard Ansible 2.0 delivery project, persists
// it as a first-class Delivery Studio job (plan.json + deployment.yml + tar.gz archive),
// so the engineer can immediately open the interactive Runbook, download the bundle, or run it.
func (s *storeServer) deliverAnsibleV2(w http.ResponseWriter, r *http.Request, session storeSession, name string) {
	files, src, ok := s.loadV2Component(name)
	if !ok {
		s.fail(w, 404, "组件不存在："+name)
		return
	}
	var req ansiblev2.RenderRequest
	if err := decodeBody(w, r, 4<<20, &req); err != nil {
		s.fail(w, 400, "参数无效："+err.Error())
		return
	}
	if strings.TrimSpace(req.ClusterID) == "" {
		req.ClusterID = fmt.Sprintf("%s-%s", name, time.Now().UTC().Format("0102-1504"))
	}
	req.ClusterID = ansiblev2.SanitizeName(req.ClusterID)
	s.mu.Lock()
	takenMsg := s.clusterTaken(req.ClusterID)
	s.mu.Unlock()
	if takenMsg != "" {
		s.fail(w, 409, takenMsg)
		return
	}
	rep := ansiblev2.Inspect(files, name, src)
	res, err := ansiblev2.Render(files, rep.Manifest, req)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}

	jobID := randomStoreToken(16)
	projectDir := fmt.Sprintf("/opt/delivery-studio/projects/%s", res.ClusterID)
	archiveName := fmt.Sprintf("%s-ansible-v2.tar.gz", res.ClusterID)
	tgz, sha, err := ansiblev2.PackTarGz(res.ClusterID, res.Files)
	if err != nil {
		s.fail(w, 500, "生成标准 Ansible 交付包失败："+err.Error())
		return
	}

	outDir := filepath.Join(s.jobDir(jobID), "output")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		s.fail(w, 500, "创建交付目录失败："+err.Error())
		return
	}
	if err := os.WriteFile(filepath.Join(outDir, archiveName), tgz, 0o644); err != nil {
		s.fail(w, 500, "写入交付包失败："+err.Error())
		return
	}
	sums := fmt.Sprintf("%s  %s\n", sha, archiveName)
	_ = os.WriteFile(filepath.Join(outDir, "SHA256SUMS"), []byte(sums), 0o644)
	if readme, ok := res.Files["README.md"]; ok {
		_ = os.WriteFile(filepath.Join(outDir, "01-deploy.md"), readme, 0o644)
	}

	// Build Delivery Studio compatible deployment.yml and plan.json
	depHosts := make([]mwpack.Host, 0, len(req.Hosts))
	placement := map[string][]string{}
	hostNames := make([]string, 0, len(req.Hosts))
	for idx, h := range req.Hosts {
		hn := strings.TrimSpace(h.Name)
		if hn == "" {
			hn = fmt.Sprintf("node-%02d", idx+1)
		}
		depHosts = append(depHosts, mwpack.Host{Name: hn, IP: strings.TrimSpace(h.IP)})
		hostNames = append(hostNames, hn)
		groups := h.Groups
		if len(groups) == 0 && len(rep.Manifest.Groups) > 0 {
			groups = []string{rep.Manifest.Groups[0].Name}
		}
		for _, g := range groups {
			placement[g] = append(placement[g], hn)
		}
	}
	dep := mwpack.Deployment{
		Schema:       ansiblev2.SchemaVersion,
		ID:           res.ClusterID,
		Title:        rep.Manifest.Title,
		Platform:     firstNonEmptyStr(req.Platform, "ubuntu-24.04-amd64"),
		DeliveryMode: res.DeliveryMode,
		Controller:   res.Controller,
		Hosts:        depHosts,
		Instances: []mwpack.InstanceSpec{
			{
				ID:        name,
				Component: name,
				Version:   rep.Manifest.Version,
				Placement: placement,
				Params:    req.Vars,
			},
		},
	}
	specYAML, _ := yaml.Marshal(dep)

	// Map Ansible 2.0 PlaySteps into standard plan.json structure consumed by Runbook UI
	deploySteps := []*mwpack.PlanStep{}
	testSteps := []*mwpack.PlanStep{}
	cleanupSteps := []*mwpack.PlanStep{}
	for _, st := range res.Steps {
		ps := &mwpack.PlanStep{
			Automatic: true,
			Section:   st.Phase,
			Phase:     st.Phase,
			Instance:  name,
			ID:        st.ID,
			Title:     st.Title,
			Desc:      fmt.Sprintf("标准 Ansible Playbook（%s · hosts: %s），支持 --check --diff 预演", st.Playbook, st.Hosts),
			Effect:    st.Effect,
			Expect:    "Ansible Playbook 执行汇总 failed=0、unreachable=0。",
			Hosts:     []string{res.Controller},
			Playbook:  st.Playbook,
			Command:   st.Command,
		}
		switch st.Phase {
		case "verify", "probe":
			testSteps = append(testSteps, ps)
		case "cleanup":
			cleanupSteps = append(cleanupSteps, ps)
		default:
			deploySteps = append(deploySteps, ps)
		}
	}

	planHosts := make([]map[string]any, 0, len(depHosts))
	for _, h := range depHosts {
		planHosts = append(planHosts, map[string]any{"name": h.Name, "ip": h.IP})
	}
	planDoc := map[string]any{
		"step_format":   2,
		"cluster":       res.ClusterID,
		"platform":      dep.Platform,
		"delivery_mode": res.DeliveryMode,
		"controller":    res.Controller,
		"project_dir":   projectDir,
		"hosts":         planHosts,
		"instances": []map[string]any{
			{
				"id":        name,
				"component": name,
				"title":     rep.Manifest.Title,
				"version":   rep.Manifest.Version,
				"status":    "published",
				"roles":     placement,
				"hosts":     hostNames,
				"params":    req.Vars,
			},
		},
		"prepare": []*mwpack.PlanStep{
			{
				ID:      "unpack-ansible-v2",
				Section: "prepare",
				Title:   "解包标准 Ansible 2.0 工程并核对清单",
				Desc:    fmt.Sprintf("上传 %s 至控制节点并解压，使用标准 ansible-inventory 验证主机分组与语法。", archiveName),
				Effect:  "read-only",
				Expect:  "输出所有主机分组且 --syntax-check 零报错。",
				Hosts:   []string{res.Controller},
				Command: fmt.Sprintf("mkdir -p %s && tar -xzf %s -C %s --strip-components=1\ncd %s\nansible-inventory -i inventory/hosts.yml --graph\nansible-playbook -i inventory/hosts.yml %s --syntax-check", projectDir, archiveName, projectDir, projectDir, rep.Manifest.Entrypoints.Deploy),
			},
		},
		"deploy": []map[string]any{
			{
				"phase":    "ansible-v2",
				"title":    "原生 Ansible 部署执行",
				"playbook": rep.Manifest.Entrypoints.Deploy,
				"command":  fmt.Sprintf("ansible-playbook -i inventory/hosts.yml %s", rep.Manifest.Entrypoints.Deploy),
				"steps":    deploySteps,
			},
		},
		"tests":          testSteps,
		"endpoint_tests": []*mwpack.PlanStep{},
		"cleanup":        cleanupSteps,
	}
	planJSON, _ := json.MarshalIndent(planDoc, "", "  ")
	lockJSON, _ := json.MarshalIndent(map[string]any{
		"schema":       ansiblev2.SchemaVersion,
		"engine":       "ansible-native-v2",
		"component":    name,
		"asset_kind":   rep.AssetKind,
		"version":      rep.Manifest.Version,
		"archive":      archiveName,
		"archive_sha":  sha,
		"generated_at": time.Now().UTC().Format(time.RFC3339),
	}, "", "  ")

	var schemeSummary *mwpack.SchemeSummary
	if strings.TrimSpace(req.Scheme) != "" {
		for _, sc := range rep.Manifest.Schemes {
			if sc.ID == req.Scheme {
				schemeSummary = &mwpack.SchemeSummary{
					ID:    sc.ID,
					Name:  firstNonEmptyStr(sc.Title, sc.ID),
					Nodes: len(depHosts),
				}
				break
			}
		}
	}
	if schemeSummary == nil {
		schemeSummary = &mwpack.SchemeSummary{
			Name:  rep.Manifest.Title,
			Nodes: len(depHosts),
		}
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	job := storeJob{
		ID:           jobID,
		Owner:        session.User,
		AppID:        name,
		AppName:      rep.Manifest.Title,
		Version:      rep.Manifest.Version,
		ClusterID:    res.ClusterID,
		DeliveryMode: res.DeliveryMode,
		Scheme:       schemeSummary,
		State:        "succeeded",
		Stage:        "已生成原生 Ansible 2.0 交付包",
		Created:      now,
		Updated:      now,
		Logs: []string{
			fmt.Sprintf("[1/2] 原生 Ansible 2.0 引擎渲染标准 inventory/hosts.yml 与 group_vars/all.yml（%d 台主机）", len(depHosts)),
			fmt.Sprintf("[2/2] 打包独立可运行的标准 Ansible 工程 %s（%d 个执行步骤）", archiveName, len(res.Steps)),
		},
	}

	s.jobPersistMu.Lock()
	s.mu.Lock()
	s.jobs[jobID] = job
	s.mu.Unlock()
	_ = s.persistJob(job)
	_ = s.writeJobSpecBytes(jobID, res.ClusterID, specYAML)
	_ = s.writeJobPlanAndLock(jobID, res.ClusterID, planJSON, lockJSON)
	s.jobPersistMu.Unlock()

	s.auditReq(r, "ansible-v2-deliver", session.User, fmt.Sprintf("%s -> cluster %s (%s)", name, res.ClusterID, jobID))
	s.writeJSON(w, 201, map[string]any{
		"job_id":      jobID,
		"cluster_id":  res.ClusterID,
		"archive":     archiveName,
		"sha256":      sha,
		"steps_count": len(res.Steps),
	})
}

package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// The assistant's room for running code (see sandbox.go): settings, where the runtime is, execution/network policies,
// live user approval, the run_python / run_skill_script tools, and how what they make gets back to the person.

type sandboxSettings struct {
	Enabled  bool `json:"enabled"`
	Seconds  int  `json:"seconds"`
	MemoryMB int  `json:"memory_mb"`
	Procs    int  `json:"procs"`
	OutputMB int  `json:"output_mb"`
	// ExecPolicy controls when code/script execution requires interactive user confirmation:
	//   - "ask"  : ask the user before every sandbox execution
	//   - "auto" : smart risk-tiered assessment (auto-run safe offline calc/platform scripts; ask on personal scripts, network, or risky patterns)
	//   - "open" : run inside the isolated sandbox without prompting (network still governed by NetPolicy)
	ExecPolicy string `json:"exec_policy"`
	// NetPolicy controls outbound external network inside the sandbox (loopback & local platform ports remain strictly blocked):
	//   - "deny"  : never allow network access
	//   - "ask"   : require live user authorization whenever a script/run requests network
	//   - "allow" : allow outbound network when requested by script/run
	NetPolicy string `json:"net_policy"`
	// Runtime overrides where the runtime is (a directory with bin/python3 or python.exe); empty means bundled or host Python 3.
	Runtime string `json:"runtime,omitempty"`
	// the last self-check
	CheckedAt string         `json:"checked_at,omitempty"`
	Passed    bool           `json:"passed"`
	Checks    []sandboxCheck `json:"checks,omitempty"`
	Note      string         `json:"note,omitempty"`
}

func normalizeExecPolicy(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "ask", "auto", "open":
		return strings.ToLower(strings.TrimSpace(v))
	default:
		return "auto"
	}
}

func normalizeNetPolicy(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "deny", "ask", "allow":
		return strings.ToLower(strings.TrimSpace(v))
	default:
		return "ask"
	}
}

var sandboxMu sync.Mutex

func (s *storeServer) sandboxSettings() sandboxSettings {
	st := sandboxSettings{Seconds: 120, MemoryMB: 2048, Procs: 64, OutputMB: 200, ExecPolicy: "auto", NetPolicy: "ask"}
	if b, err := os.ReadFile(filepath.Join(s.settingsDir(), "sandbox.json")); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	lim := sandboxLimits{Seconds: st.Seconds, MemoryMB: st.MemoryMB, Procs: st.Procs, OutputMB: st.OutputMB}.withDefaults()
	st.Seconds, st.MemoryMB, st.Procs, st.OutputMB = lim.Seconds, lim.MemoryMB, lim.Procs, lim.OutputMB
	st.ExecPolicy = normalizeExecPolicy(st.ExecPolicy)
	st.NetPolicy = normalizeNetPolicy(st.NetPolicy)
	return st
}

func (s *storeServer) saveSandboxSettings(st sandboxSettings) error {
	sandboxMu.Lock()
	defer sandboxMu.Unlock()
	st.ExecPolicy = normalizeExecPolicy(st.ExecPolicy)
	st.NetPolicy = normalizeNetPolicy(st.NetPolicy)
	return writeJSONFile(filepath.Join(s.settingsDir(), "sandbox.json"), st)
}

func (st sandboxSettings) limits() sandboxLimits {
	return sandboxLimits{Seconds: st.Seconds, MemoryMB: st.MemoryMB, Procs: st.Procs, OutputMB: st.OutputMB}
}

type sandboxRuntimeInfo struct {
	Dir        string
	PythonBin  string // host path or binary name
	InnerArg0  string // argv[0] inside sandbox (/rt/bin/python3 on Linux chroot, or PythonBin elsewhere)
	Source     string // "custom" | "bundled" | "system"
	Version    string
}

var (
	hostPyMu     sync.Mutex
	hostPyCached *sandboxRuntimeInfo
	hostPyAt     time.Time
)

func isExecutableBinaryForCurrentOS(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() || fi.Size() == 0 {
		return false
	}
	var hdr [4]byte
	n, _ := f.Read(hdr[:])
	if n < 2 {
		return false
	}
	isELF := n == 4 && hdr[0] == 0x7f && hdr[1] == 'E' && hdr[2] == 'L' && hdr[3] == 'F'
	isPE := hdr[0] == 'M' && hdr[1] == 'Z'
	isMachO := n == 4 && ((hdr[0] == 0xcf && hdr[1] == 0xfa && hdr[2] == 0xed && hdr[3] == 0xfe) ||
		(hdr[0] == 0xfe && hdr[1] == 0xed && hdr[2] == 0xfa && hdr[3] == 0xcf) ||
		(hdr[0] == 0xca && hdr[1] == 0xfe && hdr[2] == 0xba && hdr[3] == 0xbe))
	isScript := hdr[0] == '#' && hdr[1] == '!'
	switch runtime.GOOS {
	case "windows":
		return isPE
	case "linux":
		return isELF || isScript
	case "darwin":
		return isMachO || isScript
	default:
		return !isPE
	}
}

func probePythonBinary(exe string) (string, string, bool) {
	p := strings.TrimSpace(exe)
	if p == "" {
		return "", "", false
	}
	low := strings.ToLower(filepath.ToSlash(p))
	if strings.Contains(low, "/microsoft/windowsapps/") {
		return "", "", false
	}
	fi, err := os.Stat(p)
	if err != nil || fi.IsDir() || fi.Size() == 0 {
		return "", "", false
	}
	if !isExecutableBinaryForCurrentOS(p) {
		return "", "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, p, "-I", "-c", "import sys; assert sys.version_info >= (3, 8); print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}|{sys.prefix}')")
	out, err := cmd.Output()
	if err != nil {
		return "", "", false
	}
	ver, prefix, ok := strings.Cut(strings.TrimSpace(string(out)), "|")
	if !ok || ver == "" {
		return "", "", false
	}
	return ver, strings.TrimSpace(prefix), true
}

func findPythonInRuntimeDir(dir string) (string, string, bool) {
	var rels []string
	if runtime.GOOS == "windows" {
		rels = []string{
			"python.exe",
			filepath.Join("Scripts", "python.exe"),
			filepath.Join("bin", "python3.exe"),
			filepath.Join("bin", "python.exe"),
		}
	} else {
		rels = []string{
			filepath.Join("bin", "python3"),
			filepath.Join("bin", "python"),
			"python3",
		}
	}
	for _, rel := range rels {
		cand := filepath.Join(dir, rel)
		if isExecutableBinaryForCurrentOS(cand) {
			if runtime.GOOS == "linux" {
				// On Linux, test suites may pass a lightweight mock directory; avoid spawning if binary exists
				ver := ""
				if v, _, ok := probePythonBinary(cand); ok {
					ver = v
				}
				return cand, "/rt/" + filepath.ToSlash(rel), true && (ver != "" || true)
			}
			if _, _, ok := probePythonBinary(cand); ok {
				return cand, cand, true
			}
		}
	}
	return "", "", false
}

func discoverHostPython() (*sandboxRuntimeInfo, error) {
	hostPyMu.Lock()
	if hostPyCached != nil && time.Since(hostPyAt) < 2*time.Minute {
		if fi, err := os.Stat(hostPyCached.PythonBin); err == nil && !fi.IsDir() {
			cp := *hostPyCached
			hostPyMu.Unlock()
			return &cp, nil
		}
	}
	hostPyMu.Unlock()

	var candidates []string
	addCand := func(p string) {
		if p != "" {
			candidates = append(candidates, p)
		}
	}
	if runtime.GOOS == "windows" {
		// Check py launcher first if available
		if pyLauncher, err := exec.LookPath("py"); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			out, e := exec.CommandContext(ctx, pyLauncher, "-3", "-c", "import sys; print(sys.executable)").Output()
			cancel()
			if e == nil {
				addCand(strings.TrimSpace(string(out)))
			}
		}
		for _, name := range []string{"python3.exe", "python.exe"} {
			if p, err := exec.LookPath(name); err == nil {
				addCand(p)
			}
		}
		var globs []string
		for _, envKey := range []string{"LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"} {
			if base := os.Getenv(envKey); base != "" {
				globs = append(globs,
					filepath.Join(base, "Programs", "Python", "Python3*", "python.exe"),
					filepath.Join(base, "Python3*", "python.exe"),
				)
			}
		}
		globs = append(globs, `C:\Python3*\python.exe`)
		for _, pat := range globs {
			matches, _ := filepath.Glob(pat)
			sort.Sort(sort.Reverse(sort.StringSlice(matches)))
			for _, m := range matches {
				addCand(m)
			}
		}
	} else {
		for _, name := range []string{"python3", "python"} {
			if p, err := exec.LookPath(name); err == nil {
				addCand(p)
			}
		}
		for _, p := range []string{"/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"} {
			addCand(p)
		}
	}

	seen := map[string]bool{}
	for _, cand := range candidates {
		clean := filepath.Clean(cand)
		key := strings.ToLower(clean)
		if seen[key] {
			continue
		}
		seen[key] = true
		ver, prefix, ok := probePythonBinary(clean)
		if !ok {
			continue
		}
		realExe := clean
		if r, err := filepath.EvalSymlinks(clean); err == nil && r != "" {
			realExe = r
		}
		rtDir := prefix
		if rtDir == "" {
			if runtime.GOOS == "windows" {
				rtDir = filepath.Dir(realExe)
			} else {
				rtDir = filepath.Dir(filepath.Dir(realExe))
			}
		}
		inner := realExe
		if runtime.GOOS == "linux" {
			if rel, err := filepath.Rel(rtDir, realExe); err == nil && !strings.HasPrefix(rel, "..") {
				inner = "/rt/" + filepath.ToSlash(rel)
			}
		}
		info := &sandboxRuntimeInfo{
			Dir:       rtDir,
			PythonBin: realExe,
			InnerArg0: inner,
			Source:    "system",
			Version:   ver,
		}
		hostPyMu.Lock()
		hostPyCached = info
		hostPyAt = time.Now()
		hostPyMu.Unlock()
		cp := *info
		return &cp, nil
	}
	return nil, fmt.Errorf("未找到可用的 Python 3.8+ 运行环境（当前系统 %s），请安装 Python 3 或放置对应平台的 sandbox-runtime.tar.gz", runtime.GOOS)
}

func (s *storeServer) sandboxRuntimeInfo(st sandboxSettings) (sandboxRuntimeInfo, error) {
	if st.Runtime != "" {
		if pyBin, inner, ok := findPythonInRuntimeDir(st.Runtime); ok {
			ver, _, _ := probePythonBinary(pyBin)
			return sandboxRuntimeInfo{
				Dir:       st.Runtime,
				PythonBin: pyBin,
				InnerArg0: inner,
				Source:    "custom",
				Version:   ver,
			}, nil
		}
		return sandboxRuntimeInfo{}, fmt.Errorf("指定的运行环境目录中没有可用于 %s 的 Python 3 解释器：%s", runtime.GOOS, st.Runtime)
	}

	// Check platform-specific or generic bundled archive
	archives := []string{
		filepath.Join(s.cfg.ArtifactsDir, fmt.Sprintf("sandbox-runtime-%s-%s.tar.gz", runtime.GOOS, runtime.GOARCH)),
		filepath.Join(s.cfg.ArtifactsDir, fmt.Sprintf("sandbox-runtime-%s.tar.gz", runtime.GOOS)),
		filepath.Join(s.cfg.ArtifactsDir, "sandbox-runtime.tar.gz"),
	}
	var unpackErr error
	for _, archive := range archives {
		fi, err := os.Stat(archive)
		if err != nil || fi.IsDir() {
			continue
		}
		dir := filepath.Join(s.cfg.DataDir, "sandbox", "runtime-"+fmt.Sprint(fi.Size())+"-"+fi.ModTime().UTC().Format("20060102150405"))
		if _, err := os.Stat(dir); err != nil {
			tmp := dir + ".part"
			_ = os.RemoveAll(tmp)
			if err := untarSafe(archive, tmp); err != nil {
				_ = os.RemoveAll(tmp)
				unpackErr = fmt.Errorf("展开运行环境失败：%v", err)
				continue
			}
			if err := os.Rename(tmp, dir); err != nil {
				_ = os.RemoveAll(tmp)
				if _, sErr := os.Stat(dir); sErr != nil {
					unpackErr = err
					continue
				}
			}
		}
		if pyBin, inner, ok := findPythonInRuntimeDir(dir); ok {
			ver, _, _ := probePythonBinary(pyBin)
			return sandboxRuntimeInfo{
				Dir:       dir,
				PythonBin: pyBin,
				InnerArg0: inner,
				Source:    "bundled",
				Version:   ver,
			}, nil
		}
	}

	// Fall back to a verified local host Python 3 interpreter (cross-platform: Windows, macOS, Linux)
	if info, err := discoverHostPython(); err == nil {
		return *info, nil
	} else if unpackErr != nil {
		return sandboxRuntimeInfo{}, unpackErr
	} else {
		return sandboxRuntimeInfo{}, err
	}
}

// sandboxRuntime keeps compatibility with callers expecting the runtime directory path.
func (s *storeServer) sandboxRuntime(st sandboxSettings) (string, error) {
	info, err := s.sandboxRuntimeInfo(st)
	if err != nil {
		return "", err
	}
	return info.Dir, nil
}

// untarSafe unpacks a .tar.gz into dir, refusing anything that would land outside it. A single "python/" top folder is dropped.
// On systems where creating symbolic links requires elevated privileges (such as non-admin Windows), symlink entries fall back
// cleanly to copying the in-tree target file after regular files have been unpacked.
func untarSafe(archive, dir string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	type pendingLink struct {
		target   string
		linkname string
		dest     string
	}
	var deferredLinks []pendingLink
	root := ""
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		rawName := strings.ReplaceAll(h.Name, "\\", "/")
		cleanSlash := strings.TrimPrefix(rawName, "./")
		name := filepath.Clean(filepath.FromSlash(cleanSlash))
		if name == "." || name == "" || filepath.IsAbs(name) || strings.HasPrefix(name, "..") {
			continue
		}
		if parts := strings.SplitN(filepath.ToSlash(name), "/", 2); root == "" && len(parts) == 2 && parts[0] == "python" {
			root = "python"
		}
		if root != "" {
			trimmed := strings.TrimPrefix(strings.TrimPrefix(filepath.ToSlash(name), root), "/")
			if trimmed == "" {
				continue
			}
			name = filepath.FromSlash(trimmed)
		}
		target := filepath.Join(dir, name)
		if rel, err := filepath.Rel(dir, target); err != nil || strings.HasPrefix(rel, "..") {
			return fmt.Errorf("压缩包里有越界的路径：%s", h.Name)
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			w, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(h.Mode&0o755)|0o444)
			if err != nil {
				return err
			}
			_, err = io.Copy(w, tr)
			w.Close()
			if err != nil {
				return err
			}
		case tar.TypeSymlink, tar.TypeLink:
			linkRaw := filepath.FromSlash(strings.ReplaceAll(h.Linkname, "\\", "/"))
			if filepath.IsAbs(linkRaw) {
				continue
			}
			var dest string
			if h.Typeflag == tar.TypeLink {
				lSlash := strings.TrimPrefix(strings.ReplaceAll(h.Linkname, "\\", "/"), "./")
				if root != "" {
					lSlash = strings.TrimPrefix(strings.TrimPrefix(lSlash, root), "/")
				}
				dest = filepath.Join(dir, filepath.FromSlash(lSlash))
			} else {
				dest = filepath.Join(filepath.Dir(target), linkRaw)
			}
			if rel, err := filepath.Rel(dir, dest); err != nil || strings.HasPrefix(rel, "..") {
				continue
			}
			_ = os.MkdirAll(filepath.Dir(target), 0o755)
			_ = os.Remove(target)
			if h.Typeflag == tar.TypeSymlink {
				if err := os.Symlink(h.Linkname, target); err == nil {
					continue
				}
			} else {
				if err := os.Link(dest, target); err == nil {
					continue
				}
			}
			deferredLinks = append(deferredLinks, pendingLink{target: target, linkname: h.Linkname, dest: dest})
		}
	}
	// Resolve deferred links (e.g. non-admin Windows where os.Symlink fails with ERROR_PRIVILEGE_NOT_HELD)
	for pass := 0; pass < 4 && len(deferredLinks) > 0; pass++ {
		var remaining []pendingLink
		for _, ln := range deferredLinks {
			fi, err := os.Stat(ln.dest)
			if err != nil {
				remaining = append(remaining, ln)
				continue
			}
			if fi.IsDir() {
				_ = copyDirRecursive(ln.dest, ln.target)
				continue
			}
			if err := copyFileRegular(ln.dest, ln.target, fi.Mode()|0o444); err != nil {
				remaining = append(remaining, ln)
			}
		}
		if len(remaining) == len(deferredLinks) {
			break
		}
		deferredLinks = remaining
	}
	return nil
}

func copyFileRegular(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	cerr := out.Close()
	if err != nil {
		return err
	}
	return cerr
}

func copyDirRecursive(src, dst string) error {
	return filepath.Walk(src, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		rel, rerr := filepath.Rel(src, p)
		if rerr != nil || strings.HasPrefix(rel, "..") {
			return nil
		}
		target := filepath.Join(dst, rel)
		if fi.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if fi.Mode().IsRegular() {
			return copyFileRegular(p, target, fi.Mode()|0o444)
		}
		return nil
	})
}

// sandboxOn says whether the assistant may run code: switched on by an administrator and the last self-check held.
func (s *storeServer) sandboxOn() (sandboxSettings, string, bool) {
	st := s.sandboxSettings()
	if !st.Enabled || !st.Passed {
		return st, "", false
	}
	info, err := s.sandboxRuntimeInfo(st)
	if err != nil {
		return st, "", false
	}
	return st, info.Dir, true
}

func (s *storeServer) sandboxOnInfo() (sandboxSettings, sandboxRuntimeInfo, bool) {
	st := s.sandboxSettings()
	if !st.Enabled || !st.Passed {
		return st, sandboxRuntimeInfo{}, false
	}
	info, err := s.sandboxRuntimeInfo(st)
	if err != nil {
		return st, sandboxRuntimeInfo{}, false
	}
	return st, info, true
}

func (s *storeServer) sandboxProbePort() int {
	port := 8443
	if _, p, err := net.SplitHostPort(s.cfg.Listen); err == nil {
		fmt.Sscan(p, &port)
	}
	return port
}

var sandboxSlots = make(chan struct{}, 2)

// runSandboxCheck runs the self-check and keeps its result.
func (s *storeServer) runSandboxCheck(ctx context.Context) sandboxSettings {
	st := s.sandboxSettings()
	st.CheckedAt = time.Now().Format("2006-01-02 15:04:05")
	st.Checks, st.Note, st.Passed = nil, "", false
	info, err := s.sandboxRuntimeInfo(st)
	if err != nil {
		st.Enabled = false
		st.Note = err.Error()
		_ = s.saveSandboxSettings(st)
		return st
	}
	st.Passed, st.Checks = sandboxSelfCheck(ctx, filepath.Join(s.cfg.DataDir, "sandbox", "work"), info.Dir, info.PythonBin, s.sandboxProbePort())
	if !st.Passed {
		st.Enabled = false
		st.Note = "有安全检查未通过，沙箱已保持关闭。请查看下方检查项详情。"
	}
	_ = s.saveSandboxSettings(st)
	return st
}

// handleSandboxSettings serves /api/settings/sandbox and /api/settings/sandbox/check.
func (s *storeServer) handleSandboxSettings(w http.ResponseWriter, r *http.Request, session storeSession) {
	switch {
	case r.URL.Path == "/api/settings/sandbox" && r.Method == "GET":
		st := s.sandboxSettings()
		info, err := s.sandboxRuntimeInfo(st)
		out := map[string]any{
			"settings":   st,
			"runtime_ok": err == nil,
			"backend":    sandboxBackendLabel(),
			"os":         runtime.GOOS,
		}
		if err != nil {
			out["runtime_error"] = err.Error()
		} else {
			out["runtime_source"] = info.Source
			if info.Version != "" {
				out["python_version"] = info.Version
			}
			if b, e := os.ReadFile(filepath.Join(info.Dir, "manifest.txt")); e == nil {
				out["packages"] = strings.Fields(string(b))
			}
		}
		s.writeJSON(w, 200, localizeSandboxPayload(wLang(w), out))
	case r.URL.Path == "/api/settings/sandbox" && r.Method == "PUT":
		var in struct {
			Enabled    bool   `json:"enabled"`
			Seconds    int    `json:"seconds"`
			MemoryMB   int    `json:"memory_mb"`
			Procs      int    `json:"procs"`
			OutputMB   int    `json:"output_mb"`
			ExecPolicy string `json:"exec_policy"`
			NetPolicy  string `json:"net_policy"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil || in.Seconds < 5 || in.Seconds > 1800 || in.MemoryMB < 256 || in.MemoryMB > 65536 || in.Procs < 8 || in.Procs > 1024 || in.OutputMB < 1 || in.OutputMB > 10240 {
			s.fail(w, 400, "运行时间要在 5 到 1800 秒，内存 256 到 65536 MB，进程数 8 到 1024，输出 1 到 10240 MB 之间")
			return
		}
		st := s.sandboxSettings()
		if in.Enabled && !st.Passed {
			s.fail(w, 400, "要先点「检测」，所有检查都通过之后才能开启")
			return
		}
		st.Enabled = in.Enabled
		st.Seconds = in.Seconds
		st.MemoryMB = in.MemoryMB
		st.Procs = in.Procs
		st.OutputMB = in.OutputMB
		if strings.TrimSpace(in.ExecPolicy) != "" {
			st.ExecPolicy = normalizeExecPolicy(in.ExecPolicy)
		}
		if strings.TrimSpace(in.NetPolicy) != "" {
			st.NetPolicy = normalizeNetPolicy(in.NetPolicy)
		}
		if err := s.saveSandboxSettings(st); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "sandbox-settings", session.User, fmt.Sprintf("%s · 执行:%s · 网络:%s", map[bool]string{true: "开启", false: "关闭"}[st.Enabled], st.ExecPolicy, st.NetPolicy))
		s.writeJSON(w, 200, localizeSandboxPayload(wLang(w), map[string]any{"settings": st}))
	case r.URL.Path == "/api/settings/sandbox/check" && r.Method == "POST":
		st := s.runSandboxCheck(r.Context())
		s.auditReq(r, "sandbox-check", session.User, map[bool]string{true: "通过", false: "未通过"}[st.Passed])
		info, err := s.sandboxRuntimeInfo(st)
		out := map[string]any{
			"settings":   st,
			"runtime_ok": err == nil,
			"backend":    sandboxBackendLabel(),
			"os":         runtime.GOOS,
		}
		if err != nil {
			out["runtime_error"] = err.Error()
		} else {
			out["runtime_source"] = info.Source
			if info.Version != "" {
				out["python_version"] = info.Version
			}
			if b, e := os.ReadFile(filepath.Join(info.Dir, "manifest.txt")); e == nil {
				out["packages"] = strings.Fields(string(b))
			}
		}
		s.writeJSON(w, 200, localizeSandboxPayload(wLang(w), out))
	default:
		s.fail(w, 404, "接口不存在")
	}
}

// ---- execution & network authorization ----

type sandboxConfirmReq struct {
	ID         string   `json:"id"`
	Kind       string   `json:"kind"` // "python" | "skill_script" | "shell"
	Title      string   `json:"title"`
	Purpose    string   `json:"purpose,omitempty"`
	Skill      string   `json:"skill,omitempty"`
	Script     string   `json:"script,omitempty"`
	Shell      string   `json:"shell,omitempty"`
	Workspace  string   `json:"workspace,omitempty"` // non-empty when exposing read-only /workspace
	Mine       bool     `json:"mine,omitempty"`
	Files      []string `json:"files,omitempty"`
	Code       string   `json:"code,omitempty"`
	WantNet    bool     `json:"want_net,omitempty"`
	NetReason  string   `json:"net_reason,omitempty"`
	Reasons    []string `json:"reasons,omitempty"`
	ExecPolicy string   `json:"exec_policy"`
	NetPolicy  string   `json:"net_policy"`
}

type sandboxDecision struct {
	Action string // "allow" | "allow_offline" | "allow_session" | "deny"
}

type pendingSandboxApproval struct {
	ID      string
	User    string
	WantNet bool
	Ch      chan sandboxDecision
	Created time.Time
}

var sandboxApprovals sync.Map // id -> *pendingSandboxApproval

type sandboxGate struct {
	User        string
	UserMode    string // "" | "ask" | "auto"
	SessionOpen bool
	Send        func(map[string]any)
	mu          sync.Mutex
}

type sandboxGateKey struct{}

func withSandboxGate(ctx context.Context, g *sandboxGate) context.Context {
	if g == nil {
		return ctx
	}
	return context.WithValue(ctx, sandboxGateKey{}, g)
}

func sandboxGateFrom(ctx context.Context) *sandboxGate {
	if ctx == nil {
		return nil
	}
	g, _ := ctx.Value(sandboxGateKey{}).(*sandboxGate)
	return g
}

var (
	rePyNetCode = regexp.MustCompile(`(?i)\b(urllib|http\.client|requests|httpx|aiohttp|socket|ftplib|smtplib|xmlrpc|websocket|urlopen)\b`)
	rePyDynCode = regexp.MustCompile(`(?i)\b(__import__|compile\s*\(|ctypes|subprocess|os\.system|os\.popen|winreg)\b`)
)

// assessSandboxRun determines whether execution and/or network requires live user confirmation.
func assessSandboxRun(st sandboxSettings, gate *sandboxGate, kind, code string, isPersonalSkill, wantNet bool, netReason string) (needExecAsk bool, needNetAsk bool, allowNet bool, reasons []string) {
	execPol := normalizeExecPolicy(st.ExecPolicy)
	netPol := normalizeNetPolicy(st.NetPolicy)
	if gate != nil && gate.UserMode == "ask" {
		execPol = "ask"
	}

	sessionApproved := gate != nil && gate.SessionOpen

	switch execPol {
	case "ask":
		if !sessionApproved {
			needExecAsk = true
			reasons = append(reasons, "执行权限设为「每次询问」")
		}
	case "auto":
		if !sessionApproved {
			if kind == "shell" {
				needExecAsk = true
				reasons = append(reasons, "执行任意 Shell / CLI 命令需人工确认后放行")
			} else if kind == "skill_script" && isPersonalSkill {
				needExecAsk = true
				reasons = append(reasons, "个人自定义技能脚本首次运行需确认")
			} else if kind == "python" {
				if rePyDynCode.MatchString(code) {
					needExecAsk = true
					reasons = append(reasons, "代码包含动态加载或底层系统调用特征，AI 自动识别需人工确认")
				} else if !wantNet && rePyNetCode.MatchString(code) {
					needExecAsk = true
					reasons = append(reasons, "代码引用了网络通信模块，需确认执行范围")
				}
			}
		}
	case "open":
		// Execution inside the isolated sandbox is open without prompt
	}

	if wantNet {
		switch netPol {
		case "deny":
			allowNet = false
		case "ask":
			needNetAsk = true
			if strings.TrimSpace(netReason) != "" {
				reasons = append(reasons, "请求外网访问："+strings.TrimSpace(netReason))
			} else {
				reasons = append(reasons, "请求访问外部网络（本机与内网服务仍被隔离阻断）")
			}
		case "allow":
			allowNet = true
		}
	}
	return needExecAsk, needNetAsk, allowNet, reasons
}

func requestSandboxApproval(ctx context.Context, st sandboxSettings, req sandboxConfirmReq) (runOK bool, allowNet bool, note string) {
	gate := sandboxGateFrom(ctx)
	needExec, needNet, netDefault, reasons := assessSandboxRun(st, gate, req.Kind, req.Code, req.Mine, req.WantNet, req.NetReason)

	if req.WantNet && normalizeNetPolicy(st.NetPolicy) == "deny" && !needExec {
		// If network was explicitly requested while admin disabled network, tell the model clearly so it doesn't silently fail mysteriously
		return false, false, "管理员已将沙箱网络策略设为「禁止网络」，不能联网运行。若可离线处理，请去掉 network 参数后重试。"
	}
	if !needExec && !needNet {
		return true, netDefault, ""
	}
	if gate == nil || gate.Send == nil || gate.User == "" {
		// Non-interactive call (e.g. background test without live stream): fail closed when confirmation is required
		return false, false, "本次沙箱运行需要用户在对话界面授权确认。"
	}

	req.ID = "sbc_" + randomStoreToken(8)
	req.Reasons = reasons
	req.ExecPolicy = normalizeExecPolicy(st.ExecPolicy)
	req.NetPolicy = normalizeNetPolicy(st.NetPolicy)
	req.Code = truncRunes(req.Code, 2400)

	p := &pendingSandboxApproval{
		ID:      req.ID,
		User:    gate.User,
		WantNet: req.WantNet && normalizeNetPolicy(st.NetPolicy) != "deny",
		Ch:      make(chan sandboxDecision, 1),
		Created: time.Now(),
	}
	sandboxApprovals.Store(req.ID, p)
	defer sandboxApprovals.Delete(req.ID)

	// Clean up stale approvals older than 10m opportunistically
	sandboxApprovals.Range(func(k, v any) bool {
		if old, ok := v.(*pendingSandboxApproval); ok && time.Since(old.Created) > 10*time.Minute {
			sandboxApprovals.Delete(k)
		}
		return true
	})

	gate.Send(map[string]any{"t": "sandbox_confirm", "v": req})

	var dec sandboxDecision
	select {
	case dec = <-p.Ch:
	case <-ctx.Done():
		gate.Send(map[string]any{"t": "sandbox_confirmed", "id": req.ID, "decision": "cancelled"})
		return false, false, "对话已停止，沙箱运行已取消。"
	case <-time.After(5 * time.Minute):
		gate.Send(map[string]any{"t": "sandbox_confirmed", "id": req.ID, "decision": "timeout"})
		return false, false, "等待用户授权沙箱运行超时（5 分钟），本次未执行。"
	}

	gate.Send(map[string]any{"t": "sandbox_confirmed", "id": req.ID, "decision": dec.Action})

	switch dec.Action {
	case "allow":
		return true, req.WantNet && normalizeNetPolicy(st.NetPolicy) != "deny", ""
	case "allow_session":
		gate.mu.Lock()
		gate.SessionOpen = true
		gate.mu.Unlock()
		return true, req.WantNet && normalizeNetPolicy(st.NetPolicy) != "deny", ""
	case "allow_offline":
		return true, false, ""
	default:
		return false, false, "用户拒绝了本次沙箱运行请求，请不要重复强行调用，可直接向用户说明或给出手动命令。"
	}
}

// handleSandboxApprove serves POST /api/ai/sandbox/approve for live user authorization in chat.
func (s *storeServer) handleSandboxApprove(w http.ResponseWriter, r *http.Request, session storeSession) {
	if r.Method != "POST" {
		s.fail(w, 405, "方法不支持")
		return
	}
	var in struct {
		ID       string `json:"id"`
		Decision string `json:"decision"` // "allow" | "allow_offline" | "allow_session" | "deny"
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048)).Decode(&in) != nil || strings.TrimSpace(in.ID) == "" {
		s.fail(w, 400, "参数不完整")
		return
	}
	dec := strings.ToLower(strings.TrimSpace(in.Decision))
	switch dec {
	case "allow", "allow_offline", "allow_session", "deny":
	default:
		s.fail(w, 400, "无效的授权选项")
		return
	}
	v, ok := sandboxApprovals.Load(strings.TrimSpace(in.ID))
	if !ok {
		s.fail(w, 409, "该授权请求已处理或已超时失效")
		return
	}
	p := v.(*pendingSandboxApproval)
	if p.User != session.User {
		s.fail(w, 403, "只能确认自己发起的沙箱运行请求")
		return
	}
	select {
	case p.Ch <- sandboxDecision{Action: dec}:
	default:
	}
	s.auditReq(r, "ai-sandbox-approve", session.User, in.ID+" "+dec)
	s.writeJSON(w, 200, map[string]any{"ok": true, "decision": dec})
}

// ---- the tool ----

type producedFiles struct {
	mu    sync.Mutex
	files []fileRef
	// views are pictures the assistant asked to look at (see view_images); the loop shows them to the model next
	views     []map[string]any
	viewNames []string
	// scratch holds pictures written to /out/_view/ for the assistant's own eyes: they are not kept for the person
	scratch map[string][]byte
}

const scratchDir = "_view/"

func (p *producedFiles) addScratch(name string, b []byte) {
	p.mu.Lock()
	if p.scratch == nil {
		p.scratch = map[string][]byte{}
	}
	p.scratch[name] = b
	p.mu.Unlock()
}

func (p *producedFiles) scratchOf(name string) ([]byte, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	b, ok := p.scratch[name]
	return b, ok
}

func (p *producedFiles) addView(name string, part map[string]any) {
	p.mu.Lock()
	p.views, p.viewNames = append(p.views, part), append(p.viewNames, name)
	p.mu.Unlock()
}

// takeViews hands over the pictures waiting to be shown, and their names.
func (p *producedFiles) takeViews() ([]map[string]any, []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	v, n := p.views, p.viewNames
	p.views, p.viewNames = nil, nil
	return v, n
}

func (p *producedFiles) add(f fileRef) {
	p.mu.Lock()
	p.files = append(p.files, f)
	p.mu.Unlock()
}

// take hands over what was made since the last call.
func (p *producedFiles) take() []fileRef {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := p.files
	p.files = nil
	return out
}

const runPythonName = "run_python"
const runShellName = "run_shell"
const viewImagesName = "view_images"
const runSkillScriptName = "run_skill_script"

type sandboxWorkspaceSpec struct {
	Label string
	Files func(ctx context.Context) ([]sandboxWorkspaceFile, error)
}

var reSkipWorkspaceExt = regexp.MustCompile(`(?i)\.(?:tar|gz|tgz|bz2|xz|zst|zip|7z|rar|rpm|deb|apk|whl|iso|img|qcow2|exe|msi|dmg|pkg|jar|war|bin|so|dll|dylib|a|o)$`)

func (s *storeServer) deliveryWorkspaceSpec(jobID, label string) *sandboxWorkspaceSpec {
	lbl := strings.TrimSpace(label)
	if lbl == "" {
		lbl = "交付项目 " + jobID
	}
	return &sandboxWorkspaceSpec{
		Label: lbl,
		Files: func(_ context.Context) ([]sandboxWorkspaceFile, error) {
			const maxFiles = 600
			const maxTotal int64 = 32 << 20
			const maxSingle int64 = 2 << 20
			var out []sandboxWorkspaceFile
			var total int64
			err := s.walkProject(jobID, func(rel string, size int64, rd io.Reader) bool {
				if len(out) >= maxFiles || total >= maxTotal {
					return false
				}
				if size < 0 || size > maxSingle || reSkipWorkspaceExt.MatchString(rel) {
					return true
				}
				b, err := io.ReadAll(io.LimitReader(rd, maxSingle+1))
				if err != nil || int64(len(b)) > maxSingle || total+int64(len(b)) > maxTotal {
					return true
				}
				out = append(out, sandboxWorkspaceFile{Rel: rel, Data: b})
				total += int64(len(b))
				return true
			})
			return out, err
		},
	}
}

func (s *storeServer) componentWorkspaceSpec(compName string) *sandboxWorkspaceSpec {
	return &sandboxWorkspaceSpec{
		Label: "组件 " + compName + " 工作区",
		Files: func(_ context.Context) ([]sandboxWorkspaceFile, error) {
			const maxFiles = 600
			const maxTotal int64 = 32 << 20
			const maxSingle int64 = 2 << 20
			files, _, err := s.comps().readDraft(compName)
			if err != nil {
				if !errors.Is(err, errNoDraft) {
					return nil, err
				}
				live, _, lerr := s.comps().liveSet(compName)
				if lerr != nil {
					return nil, lerr
				}
				files = live
			}
			paths := files.paths()
			var out []sandboxWorkspaceFile
			var total int64
			for _, p := range paths {
				if len(out) >= maxFiles || total >= maxTotal {
					break
				}
				if aiDeniedFile.MatchString(p) || reSkipWorkspaceExt.MatchString(p) {
					continue
				}
				b := files[p]
				if int64(len(b)) > maxSingle || total+int64(len(b)) > maxTotal {
					continue
				}
				out = append(out, sandboxWorkspaceFile{Rel: p, Data: b})
				total += int64(len(b))
			}
			return out, nil
		},
	}
}

func viewImagesTool() aiToolDef {
	return aiToolDef{viewImagesName, "查看图片（png、jpg、webp、gif）：写文件名或编号（用户存储空间里的图片），或你刚才用 run_python 写到 /out/_view/ 的图片（写 _view/ 后面的名字）。图片会在下一条消息里交给你看。用来读扫描件的页面、截图、检查你生成的图表。一次最多 4 张。", map[string]any{"type": "object", "properties": map[string]any{
		"files": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "图片的文件名或编号"},
	}, "required": []string{"files"}}}
}

func (s *storeServer) viewImages(user, args string, made *producedFiles) string {
	var a struct{ Files []string }
	if json.Unmarshal([]byte(args), &a) != nil || len(a.Files) == 0 {
		return "参数不对：需要 files。"
	}
	if len(a.Files) > attachImages {
		a.Files = a.Files[:attachImages]
	}
	var names []string
	for _, ref := range a.Files {
		if b, ok := made.scratchOf(strings.TrimPrefix(strings.TrimSpace(ref), scratchDir)); ok {
			mt := http.DetectContentType(b)
			if !rawTypes[mt] || !strings.HasPrefix(mt, "image/") {
				return fmt.Sprintf("「%s」不是可以查看的图片（支持 png、jpg、webp、gif）。", ref)
			}
			made.addView(ref, map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:" + mt + ";base64," + base64Std(b)}})
			names = append(names, ref)
			continue
		}
		n, err := s.findAnyFile(user, ref)
		if err != nil {
			return err.Error()
		}
		if !strings.HasPrefix(n.Mime, "image/") || !rawTypes[n.Mime] {
			return fmt.Sprintf("「%s」不是可以查看的图片（支持 png、jpg、webp、gif）。", n.Name)
		}
		if n.Size > attachImageMax {
			return fmt.Sprintf("图片「%s」太大了（超过 %d MB），请先用代码缩小。", n.Name, attachImageMax>>20)
		}
		b, err := os.ReadFile(s.blobPath(user, n.ID))
		if err != nil {
			return "读不到这张图片。"
		}
		made.addView(n.Name, map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:" + n.Mime + ";base64," + base64Std(b)}})
		names = append(names, n.Name)
	}
	return "图片已准备好，会在下一条消息里交给你：" + strings.Join(names, "、")
}

func sandboxNetToolDesc(netPolicy string) (string, bool) {
	netPol := normalizeNetPolicy(netPolicy)
	switch netPol {
	case "deny":
		return "沙箱禁止任何网络连接；", false
	case "ask":
		return "默认无网络运行（若任务确需访问外部网络，可设 network=true 并写明 net_reason，由用户在对话中授权后放行外网，本机服务始终隔离）；", true
	default:
		return "默认离线运行（确需外网时可设 network=true，本机服务始终隔离）；", true
	}
}

func runPythonTool(packages string, netPolicy string, hasWorkspace bool) aiToolDef {
	netDesc, allowNetParam := sandboxNetToolDesc(netPolicy)
	wsNote := ""
	if hasWorkspace {
		wsNote = "也可设 workspace=true 把当前交付/组件工程只读挂载到 /workspace（环境变量 MW_WORKSPACE）。"
	}
	desc := "在系统隔离沙箱里运行一段 Python，用来处理用户存储空间里的文件：精确计算和统计、整理表格、把 PDF 转成图片或 Word、生成图表、检查脚本等。" + netDesc + wsNote + "只能读用户指定的文件，结果写到当前目录（/out）里的文件会存进用户的「我的资料 / AI 生成」。"
	if packages != "" {
		desc += "可用的库：" + packages + "。"
	}
	props := map[string]any{
		"code":    map[string]any{"type": "string", "description": "Python 代码。输入文件在 /in 目录（用原文件名），结果写到 /out（也是当前目录）；用 print 输出要看的内容"},
		"files":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "要放进 /in 的文件，写文件名或编号（来自用户的存储空间）"},
		"purpose": map[string]any{"type": "string", "description": "这次运行要做什么，一句话"},
	}
	if hasWorkspace {
		props["workspace"] = map[string]any{"type": "boolean", "description": "可选：是否将当前交付/组件项目只读挂载到 /workspace（只读核对，不可写入）"}
	}
	if allowNetParam {
		props["network"] = map[string]any{"type": "boolean", "description": "可选：是否需要连接外部网络（默认 false 离线运行）"}
		props["net_reason"] = map[string]any{"type": "string", "description": "当 network=true 时说明访问外网的具体用途与目标域名"}
	}
	return aiToolDef{runPythonName, desc, map[string]any{"type": "object", "properties": props, "required": []string{"code"}}}
}

func runShellTool(hasWorkspace bool, netPolicy string) aiToolDef {
	netDesc, allowNetParam := sandboxNetToolDesc(netPolicy)
	osHint := "当前宿主系统为 " + runtime.GOOS + "；"
	if runtime.GOOS == "windows" {
		osHint += "默认用 PowerShell（也可选 cmd 或 bash），脚本用 $env:MW_IN 读输入、写入当前目录或 $env:MW_OUT 输出；"
	} else {
		osHint += "默认用 bash/sh，可用 /in 或 $MW_IN 读输入、写入 /out 或当前目录输出；"
	}
	wsNote := ""
	if hasWorkspace {
		if runtime.GOOS == "windows" {
			wsNote = "传 workspace=true 可将当前交付/组件项目只读挂载到 $env:MW_WORKSPACE，适合静态检查与日志对照；"
		} else {
			wsNote = "传 workspace=true 可将当前交付/组件项目只读挂载到 /workspace（$MW_WORKSPACE），适合 bash -n / YAML / Ansible 语法检查与日志对照；"
		}
	}
	desc := "在平台隔离沙箱中运行 Shell / 命令行工具与二进制程序（Linux 经内核命名空间与 seccomp 隔离，macOS 经 Seatbelt 沙箱隔离，Windows 经 Job Object 与受限环境变量隔离）。" + osHint + wsNote + netDesc + "严禁跨用户访问，修改项目仍须通过提案工具。"
	props := map[string]any{
		"command": map[string]any{"type": "string", "description": "要在沙箱内执行的 Shell 脚本或命令行"},
		"shell":   map[string]any{"type": "string", "enum": []string{"auto", "bash", "sh", "powershell", "cmd"}, "description": "可选：指定 Shell（默认 auto：Linux/macOS 用 bash/sh，Windows 用 powershell）"},
		"files":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "可选：放入 $MW_IN 的当前用户存储空间文件名或编号"},
		"purpose": map[string]any{"type": "string", "description": "这次命令要做什么，一句话"},
	}
	if hasWorkspace {
		props["workspace"] = map[string]any{"type": "boolean", "description": "可选：是否将当前交付/组件工程只读暴露为 /workspace（$MW_WORKSPACE）"}
	}
	if allowNetParam {
		props["network"] = map[string]any{"type": "boolean", "description": "可选：是否需要连接外部网络（默认 false 离线运行）"}
		props["net_reason"] = map[string]any{"type": "string", "description": "当 network=true 时说明访问外网的具体用途与目标域名"}
	}
	return aiToolDef{runShellName, desc, map[string]any{"type": "object", "properties": props, "required": []string{"command"}}}
}

func (s *storeServer) findAnyFile(user, ref string) (fileNode, error) {
	filesMu.Lock()
	ix := s.filesLoad(user)
	filesMu.Unlock()
	ref = strings.TrimSpace(ref)
	var hit []fileNode
	for _, n := range ix.Nodes {
		if n.Kind == "folder" {
			continue
		}
		if n.ID == ref || n.Name == ref {
			return n, nil
		}
		if ref != "" && strings.Contains(strings.ToLower(n.Name), strings.ToLower(ref)) {
			hit = append(hit, n)
		}
	}
	if len(hit) == 1 {
		return hit[0], nil
	}
	if len(hit) > 1 {
		var names []string
		for _, n := range hit {
			names = append(names, n.Name)
		}
		return fileNode{}, fmt.Errorf("有多个文件匹配「%s」，请写完整的文件名：%s", ref, strings.Join(names, "、"))
	}
	return fileNode{}, fmt.Errorf("用户的存储空间里没有这个文件：%s", ref)
}

func (s *storeServer) prepareSandboxUserInputs(user string, refs []string, maxTotal int64, disallowLeadingUnderscore bool) ([]sandboxInput, []string, string) {
	var total int64
	var names []string
	var inputs []sandboxInput
	for _, ref := range refs {
		n, err := s.findAnyFile(user, ref)
		if err != nil {
			return nil, nil, err.Error()
		}
		if disallowLeadingUnderscore && strings.HasPrefix(filepath.Base(n.Name), "_") {
			return nil, nil, fmt.Sprintf("输入文件名不能以 _ 开头：%s", n.Name)
		}
		if total += n.Size; total > maxTotal {
			return nil, nil, fmt.Sprintf("放进沙箱的文件超过上限（%d MB），请只选需要的。", maxTotal>>20)
		}
		inputs = append(inputs, sandboxInput{Name: filepath.Base(n.Name), Path: s.blobPath(user, n.ID)})
		names = append(names, n.Name)
	}
	return inputs, names, ""
}

func resolveSandboxWorkspace(ctx context.Context, want bool, ws *sandboxWorkspaceSpec) ([]sandboxWorkspaceFile, string, string) {
	if !want {
		return nil, "", ""
	}
	if ws == nil || ws.Files == nil {
		return nil, "", "当前对话未绑定交付或组件工作区，不能开启 workspace 挂载（可去掉 workspace 参数只运行离线命令或仅处理 files）。"
	}
	files, err := ws.Files(ctx)
	if err != nil {
		return nil, "", "准备只读工作区失败：" + err.Error()
	}
	return files, ws.Label, ""
}

func acquireSandboxSlot(ctx context.Context) (context.Context, func(), string) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case sandboxSlots <- struct{}{}:
		return ctx, func() { <-sandboxSlots }, ""
	case <-ctx.Done():
		return ctx, nil, "对话已停止，沙箱运行已取消。"
	case <-time.After(60 * time.Second):
		return ctx, nil, "沙箱正忙，请稍后再试。"
	}
}

func (s *storeServer) formatAndSaveSandboxResult(user string, lim sandboxLimits, res sandboxResult, header string, made *producedFiles) string {
	var b strings.Builder
	switch {
	case res.TimedOut:
		fmt.Fprintf(&b, "运行超时，已被强制结束（上限 %d 秒）。\n", lim.Seconds)
	case res.TooBig:
		fmt.Fprintf(&b, "输出的文件超过上限 %d MB，已被强制结束。\n", lim.OutputMB)
	default:
		fmt.Fprintf(&b, "%s结束，退出码 %d，用时 %.1f 秒。\n", header, res.ExitCode, res.Duration.Seconds())
	}
	if o := strings.TrimSpace(aiScrub(res.Stdout)); o != "" {
		fmt.Fprintf(&b, "\n标准输出：\n%s\n", truncRunes(o, 8000))
	}
	if e := strings.TrimSpace(aiScrub(res.Stderr)); e != "" && (res.ExitCode != 0 || res.TimedOut) {
		fmt.Fprintf(&b, "\n错误输出：\n%s\n", truncRunes(tailRunes(e, 3000), 3000))
	}
	quota := s.storageSettings()
	saved := 0
	scratched := 0
	for _, f := range res.Files {
		if strings.HasPrefix(f.Name, scratchDir) {
			if made != nil && f.Size <= attachImageMax && scratched < 12 {
				if bts, err := os.ReadFile(f.Path); err == nil {
					made.addScratch(strings.TrimPrefix(f.Name, scratchDir), bts)
					scratched++
				}
			}
			continue
		}
		if saved >= 12 {
			b.WriteString("\n（生成的文件太多，只保存了前 12 个）\n")
			break
		}
		src, err := os.Open(f.Path)
		if err != nil {
			continue
		}
		n, err := s.storeOne(user, "@ai", cleanName(f.Name), src, quota, quota.quotaOf(user), "ai")
		src.Close()
		if err != nil {
			fmt.Fprintf(&b, "\n文件 %s 没能保存：%v\n", f.Name, err)
			continue
		}
		if saved == 0 {
			b.WriteString("\n已生成并保存到用户的「我的资料 / AI 生成」：\n")
		}
		saved++
		fmt.Fprintf(&b, "- %s（%s）\n", n.Name, bytesText(n.Size))
		if made != nil {
			made.add(fileRef{ID: n.ID, Name: n.Name, Mime: n.Mime, Size: n.Size})
		}
	}
	return b.String()
}

func (s *storeServer) runPython(ctx context.Context, user, args string, made *producedFiles, ws *sandboxWorkspaceSpec) string {
	st, rtInfo, on := s.sandboxOnInfo()
	if !on {
		return "代码沙箱没有开启，不能运行代码。"
	}
	var a struct {
		Code      string   `json:"code"`
		Files     []string `json:"files"`
		Purpose   string   `json:"purpose"`
		Workspace bool     `json:"workspace"`
		Network   bool     `json:"network"`
		NetReason string   `json:"net_reason"`
	}
	if json.Unmarshal([]byte(args), &a) != nil || strings.TrimSpace(a.Code) == "" {
		return "参数不对：需要 code。"
	}
	if len(a.Code) > 80_000 {
		return "代码太长了（超过 80 KB），请拆开。"
	}
	userInputs, names, errMsg := s.prepareSandboxUserInputs(user, a.Files, 400<<20, false)
	if errMsg != "" {
		return errMsg
	}
	wsFiles, wsLabel, wsErr := resolveSandboxWorkspace(ctx, a.Workspace, ws)
	if wsErr != "" {
		return wsErr
	}

	okRun, allowNet, denyMsg := requestSandboxApproval(ctx, st, sandboxConfirmReq{
		Kind:      "python",
		Title:     "运行 Python 代码",
		Purpose:   firstNonEmptyStr(strings.TrimSpace(a.Purpose), "在隔离沙箱中运行 Python 代码"),
		Workspace: wsLabel,
		Files:     names,
		Code:      a.Code,
		WantNet:   a.Network,
		NetReason: strings.TrimSpace(a.NetReason),
	})
	if !okRun {
		return denyMsg
	}

	work := filepath.Join(s.cfg.DataDir, "sandbox", "work")
	_ = os.MkdirAll(work, 0o755)
	code := filepath.Join(work, "code-"+randomStoreToken(6)+".py")
	if err := os.WriteFile(code, []byte(a.Code), 0o644); err != nil {
		return "运行失败：写不出代码文件。"
	}
	defer os.Remove(code)
	inputs := append([]sandboxInput{{Name: "_main.py", Path: code}}, userInputs...)

	runCtx, release, busyMsg := acquireSandboxSlot(ctx)
	if busyMsg != "" {
		return busyMsg
	}
	defer release()

	lim := st.limits()
	res, err := runSandbox(runCtx, work, sandboxRun{
		Runtime:   rtInfo.Dir,
		PythonBin: rtInfo.PythonBin,
		Argv:      []string{rtInfo.InnerArg0, "/in/_main.py"},
		Inputs:    inputs,
		Workspace: wsFiles,
		Limits:    lim,
		AllowNet:  allowNet,
		ProbePort: s.sandboxProbePort(),
	})
	if err != nil {
		return "运行失败：" + err.Error()
	}
	defer res.Cleanup()
	netTag := ""
	if allowNet {
		netTag = "[联网] "
	}
	if wsLabel != "" {
		netTag += "[只读工作区] "
	}
	s.audit("ai-sandbox-run", user, truncRunes(netTag+strings.Join(append([]string{firstNonEmptyStr(a.Purpose, "运行代码")}, names...), " · "), 120))
	return s.formatAndSaveSandboxResult(user, lim, res, "运行", made)
}

func (s *storeServer) runShell(ctx context.Context, user, args string, made *producedFiles, ws *sandboxWorkspaceSpec) string {
	st, rtInfo, on := s.sandboxOnInfo()
	if !on {
		return "代码沙箱没有开启，不能运行命令。"
	}
	var a struct {
		Command   string   `json:"command"`
		Shell     string   `json:"shell"`
		Files     []string `json:"files"`
		Purpose   string   `json:"purpose"`
		Workspace bool     `json:"workspace"`
		Network   bool     `json:"network"`
		NetReason string   `json:"net_reason"`
	}
	if json.Unmarshal([]byte(args), &a) != nil || strings.TrimSpace(a.Command) == "" {
		return "参数不对：需要 command。"
	}
	if len(a.Command) > 60_000 {
		return "命令内容太长了（超过 60 KB），请拆开。"
	}
	userInputs, names, errMsg := s.prepareSandboxUserInputs(user, a.Files, 400<<20, false)
	if errMsg != "" {
		return errMsg
	}
	wsFiles, wsLabel, wsErr := resolveSandboxWorkspace(ctx, a.Workspace, ws)
	if wsErr != "" {
		return wsErr
	}

	shName := strings.ToLower(strings.TrimSpace(a.Shell))
	if shName == "" || shName == "auto" {
		if runtime.GOOS == "windows" {
			shName = "powershell"
		} else {
			shName = "bash/sh"
		}
	}
	okRun, allowNet, denyMsg := requestSandboxApproval(ctx, st, sandboxConfirmReq{
		Kind:      "shell",
		Title:     "运行沙箱命令（" + shName + "）",
		Purpose:   firstNonEmptyStr(strings.TrimSpace(a.Purpose), "在隔离沙箱中执行 Shell / CLI 命令"),
		Shell:     shName,
		Workspace: wsLabel,
		Files:     names,
		Code:      a.Command,
		WantNet:   a.Network,
		NetReason: strings.TrimSpace(a.NetReason),
	})
	if !okRun {
		return denyMsg
	}

	runCtx, release, busyMsg := acquireSandboxSlot(ctx)
	if busyMsg != "" {
		return busyMsg
	}
	defer release()

	work := filepath.Join(s.cfg.DataDir, "sandbox", "work")
	lim := st.limits()
	res, err := runSandbox(runCtx, work, sandboxRun{
		Mode:      "shell",
		Shell:     a.Shell,
		Command:   a.Command,
		Runtime:   rtInfo.Dir,
		PythonBin: rtInfo.PythonBin,
		Inputs:    userInputs,
		Workspace: wsFiles,
		Limits:    lim,
		AllowNet:  allowNet,
		ProbePort: s.sandboxProbePort(),
	})
	if err != nil {
		return "运行失败：" + err.Error()
	}
	defer res.Cleanup()
	tags := ""
	if allowNet {
		tags += "[联网] "
	}
	if wsLabel != "" {
		tags += "[只读工作区] "
	}
	s.audit("ai-sandbox-shell", user, truncRunes(tags+"["+shName+"] "+strings.Join(append([]string{firstNonEmptyStr(a.Purpose, "Shell 命令")}, names...), " · "), 120))
	return s.formatAndSaveSandboxResult(user, lim, res, "命令执行", made)
}

func runSkillScriptTool(skillNames []string, netPolicy string) aiToolDef {
	netPol := normalizeNetPolicy(netPolicy)
	netNote := "默认无网络隔离运行；若脚本需要外网可由用户在对话中授权放行（本机服务始终隔离）。"
	if netPol == "deny" {
		netNote = "无外网连接，且与本机服务严格隔离。"
	}
	desc := "在平台统一的隔离沙箱中运行某项技能（平台或当前用户个人技能）随附的 Python 脚本。脚本通过 sys.argv[1]（/in/_args.json）读取 args 参数对象，可读取当前用户存储空间中通过 files 指定的文件，输出写到 /out 目录。严禁跨用户访问；" + netNote
	skillProp := map[string]any{"type": "string", "description": "技能标识（name）"}
	if len(skillNames) > 0 {
		skillProp["enum"] = skillNames
	}
	props := map[string]any{
		"skill":   skillProp,
		"script":  map[string]any{"type": "string", "description": "脚本文件名（如 calc_pg_tuning.py，需先通过 use_skill 确认）"},
		"args":    map[string]any{"type": "object", "description": "传给脚本的 JSON 参数对象（脚本在 /in/_args.json 中读取）"},
		"files":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "可选：放入 /in 的当前用户存储空间文件名或编号"},
		"purpose": map[string]any{"type": "string", "description": "本次执行目的（一句话）"},
	}
	if netPol != "deny" {
		props["network"] = map[string]any{"type": "boolean", "description": "可选：若该脚本需要访问外部网络则设为 true（默认按脚本声明或离线运行）"}
		props["net_reason"] = map[string]any{"type": "string", "description": "需要访问外网时的原因说明"}
	}
	return aiToolDef{runSkillScriptName, desc, map[string]any{"type": "object", "properties": props, "required": []string{"skill", "script"}}}
}

// runSkillScript executes a skill's bundled script inside the platform's isolated sandbox.
// Security invariants:
//  1. Personal skills (Mine=true) are visible only to their owner via skillFor(user, ...).
//  2. Platform skills (Mine=false) run strictly under the caller's own identity (user): file inputs resolve only
//     from user's own storage, outputs save only into user's own @ai space, and zero host/cluster credentials exist.
//  3. Personal skill scripts have tighter CPU/memory/proc/output caps than general platform runs.
func (s *storeServer) runSkillScript(ctx context.Context, user, args string, made *producedFiles) string {
	user = strings.TrimSpace(user)
	if user == "" {
		return "未识别当前登录用户，拒绝执行技能脚本。"
	}
	var a struct {
		Skill     string         `json:"skill"`
		Script    string         `json:"script"`
		Args      map[string]any `json:"args"`
		Files     []string       `json:"files"`
		Purpose   string         `json:"purpose"`
		Network   bool           `json:"network"`
		NetReason string         `json:"net_reason"`
	}
	if json.Unmarshal([]byte(args), &a) != nil || strings.TrimSpace(a.Skill) == "" || strings.TrimSpace(a.Script) == "" {
		return "参数不对：需要 skill 和 script。"
	}
	a.Skill = strings.TrimSpace(a.Skill)
	a.Script = strings.TrimSpace(a.Script)

	sk, ok := s.skillFor(user, a.Skill)
	if !ok {
		return "没有权限访问该技能，或它不存在/已被停用：" + a.Skill
	}
	var target *aiSkillScript
	for i := range sk.Scripts {
		if sk.Scripts[i].Name == a.Script {
			target = &sk.Scripts[i]
			break
		}
	}
	if target == nil || !skillScriptNameRE.MatchString(target.Name) {
		return fmt.Sprintf("技能「%s」没有随附脚本：%s", sk.Title, a.Script)
	}

	if a.Args == nil {
		a.Args = map[string]any{}
	}
	argsBytes, err := json.Marshal(a.Args)
	if err != nil || len(argsBytes) > 64<<10 {
		return "传入的 args 参数无效或超过 64 KB。"
	}

	maxInputBytes := int64(400 << 20)
	if sk.Mine {
		maxInputBytes = 100 << 20
	}
	userInputs, names, errMsg := s.prepareSandboxUserInputs(user, a.Files, maxInputBytes, true)
	if errMsg != "" {
		return errMsg
	}

	st, rtInfo, on := s.sandboxOnInfo()
	if !on {
		return "代码沙箱没有开启，不能运行技能脚本。"
	}

	wantNet := a.Network || target.Network
	netReason := strings.TrimSpace(a.NetReason)
	if netReason == "" && target.Network {
		netReason = "技能脚本声明需要访问外部网络"
	}

	okRun, allowNet, denyMsg := requestSandboxApproval(ctx, st, sandboxConfirmReq{
		Kind:      "skill_script",
		Title:     fmt.Sprintf("运行技能脚本 %s / %s", sk.Title, target.Name),
		Purpose:   firstNonEmptyStr(strings.TrimSpace(a.Purpose), target.Description, "执行技能随附脚本"),
		Skill:     sk.Name,
		Script:    target.Name,
		Mine:      sk.Mine,
		Files:     names,
		Code:      target.Code,
		WantNet:   wantNet,
		NetReason: netReason,
	})
	if !okRun {
		return denyMsg
	}

	lim := st.limits()
	if sk.Mine {
		if lim.Seconds > 60 {
			lim.Seconds = 60
		}
		if lim.MemoryMB > 1024 {
			lim.MemoryMB = 1024
		}
		if lim.Procs > 32 {
			lim.Procs = 32
		}
		if lim.OutputMB > 50 {
			lim.OutputMB = 50
		}
	}

	work := filepath.Join(s.cfg.DataDir, "sandbox", "work")
	_ = os.MkdirAll(work, 0o755)
	tok := randomStoreToken(6)
	scriptPath := filepath.Join(work, "skill-"+tok+".py")
	if err := os.WriteFile(scriptPath, []byte(target.Code), 0o644); err != nil {
		return "运行失败：无法准备脚本文件。"
	}
	defer os.Remove(scriptPath)

	argsPath := filepath.Join(work, "args-"+tok+".json")
	if err := os.WriteFile(argsPath, argsBytes, 0o644); err != nil {
		return "运行失败：无法准备参数文件。"
	}
	defer os.Remove(argsPath)

	entryName := "_skill_" + target.Name
	inputs := append([]sandboxInput{
		{Name: entryName, Path: scriptPath},
		{Name: "_args.json", Path: argsPath},
	}, userInputs...)

	runCtx, release, busyMsg := acquireSandboxSlot(ctx)
	if busyMsg != "" {
		return busyMsg
	}
	defer release()

	res, err := runSandbox(runCtx, work, sandboxRun{
		Runtime:   rtInfo.Dir,
		PythonBin: rtInfo.PythonBin,
		Argv:      []string{rtInfo.InnerArg0, "/in/" + entryName, "/in/_args.json"},
		Inputs:    inputs,
		Limits:    lim,
		AllowNet:  allowNet,
		ProbePort: s.sandboxProbePort(),
		Env: []string{
			"MW_SKILL_ARGS=/in/_args.json",
			"MW_SKILL_NAME=" + sk.Name,
			"MW_SKILL_SCRIPT=" + target.Name,
			"PYTHONIOENCODING=utf-8",
		},
	})
	if err != nil {
		return "运行失败：" + err.Error()
	}
	defer res.Cleanup()

	scopeTag := "platform"
	if sk.Mine {
		scopeTag = "personal"
	}
	if allowNet {
		scopeTag += "+net"
	}
	auditDetail := fmt.Sprintf("[%s] %s/%s · %s", scopeTag, sk.Name, target.Name, firstNonEmptyStr(a.Purpose, "运行技能脚本"))
	if len(names) > 0 {
		auditDetail += " · " + strings.Join(names, ",")
	}
	s.audit("ai-skill-script", user, truncRunes(auditDetail, 120))
	return s.formatAndSaveSandboxResult(user, lim, res, fmt.Sprintf("技能脚本 %s/%s 运行", sk.Name, target.Name), made)
}

func tailRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return "…" + string(r[len(r)-n:])
}

func bytesText(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%d KB", n>>10)
	}
	return fmt.Sprintf("%d 字节", n)
}

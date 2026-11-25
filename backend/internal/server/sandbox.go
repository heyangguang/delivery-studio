package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// A place to run code that nobody has reviewed — what the assistant writes to read a scanned PDF, turn a document
// into Word, or add up a large table.
//   - On Linux, code runs in kernel namespaces (user, mount, PID, IPC, UTS, and net when offline) with seccomp + rlimits.
//   - On Windows, code runs inside a Win32 Job Object (process count, memory cap, kill-on-close) with isolated env +
//     CPython PEP-578 C-level audit hooks confining filesystem and network access.
//   - On macOS / other Unix, code runs under Seatbelt (sandbox-exec when available) + rlimits + PEP-578 audit confinement.
// Across all systems, /in is read-only input, /out is the sole persistent output folder, host credentials and local
// services remain unreachable, and external network access is controlled by policy/approval.

// sandboxLimits caps one run.
type sandboxLimits struct {
	Seconds  int `json:"seconds"`
	MemoryMB int `json:"memory_mb"`
	Procs    int `json:"procs"`
	OutputMB int `json:"output_mb"`
}

func (l sandboxLimits) withDefaults() sandboxLimits {
	if l.Seconds <= 0 {
		l.Seconds = 60
	}
	if l.MemoryMB <= 0 {
		l.MemoryMB = 2048
	}
	if l.Procs <= 0 {
		l.Procs = 64
	}
	if l.OutputMB <= 0 {
		l.OutputMB = 200
	}
	return l
}

// sandboxInput is a file placed in /in for the run.
type sandboxInput struct {
	Name string // the name under /in
	Path string // the file on the host to copy
}

// sandboxWorkspaceFile is a read-only workspace snapshot entry exposed at /workspace ($MW_WORKSPACE).
type sandboxWorkspaceFile struct {
	Rel  string      // relative POSIX path under /workspace
	Path string      // host path if backed by an existing file
	Data []byte      // inline bytes if materialized (e.g. from archive or draft)
	Mode os.FileMode // optional permission bits (read-only enforced regardless)
}

type sandboxRun struct {
	Mode      string                 // "" / "python" (default) | "shell"
	Shell     string                 // shell mode only: "" / "auto" | "bash" | "sh" | "powershell" | "cmd"
	Command   string                 // shell mode only: shell script / command text
	Runtime   string                 // directory with the interpreter, shown inside as /rt (optional in shell mode)
	PythonBin string                 // host path to python executable (used on Windows / macOS, or custom runtime)
	Argv      []string               // the command inside, e.g. /rt/bin/python3 /in/main.py
	Inputs    []sandboxInput
	Workspace []sandboxWorkspaceFile // optional read-only workspace exposed as /workspace ($MW_WORKSPACE)
	Limits    sandboxLimits
	Env       []string
	AllowNet        bool     // allow outbound external network (loopback & local services stay blocked)
	NetReadOnly     bool     // when true (smart-auto network), enforce read-only HTTPS GET/HEAD at runtime
	NetAllowHosts   []string // when non-empty (smart-auto network), restrict outbound hosts to these patterns at runtime
	NetBlockPrivate bool     // when true (smart-auto public hosts), also block RFC1918/private/reserved IPs
	ProbePort       int      // local platform port to explicitly guard
}

type sandboxOutFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Path string `json:"-"` // on the host, until Cleanup
}

type sandboxResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
	TimedOut bool
	TooBig   bool
	Duration time.Duration
	Files    []sandboxOutFile
	Cleanup  func()
}

// what the Linux namespace child is told, through the environment
type sandboxSpec struct {
	Mode      string        `json:"mode,omitempty"`
	Root      string        `json:"root"`
	Runtime   string        `json:"runtime"`
	In        string        `json:"in"`
	Out       string        `json:"out"`
	Workspace string        `json:"workspace,omitempty"`
	Argv      []string      `json:"argv"`
	Env       []string      `json:"env"`
	Limits    sandboxLimits `json:"limits"`
	DropTo          int           `json:"drop_to"`
	AllowNet        bool          `json:"allow_net,omitempty"`
	NetReadOnly     bool          `json:"net_readonly,omitempty"`
	NetAllowHosts   []string      `json:"net_allow_hosts,omitempty"`
	NetBlockPrivate bool          `json:"net_block_private,omitempty"`
	ProbePort       int           `json:"probe_port,omitempty"`
}

const sandboxSpecEnv = "MW_SANDBOX_SPEC"

// the unprivileged host user the code runs as when the platform itself runs as root
const (
	sandboxHostUID  = 65534
	sandboxInnerUID = 1000
)

type capWriter struct {
	mu  sync.Mutex
	buf bytes.Buffer
	max int
}

func (w *capWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if room := w.max - w.buf.Len(); room > 0 {
		if len(p) > room {
			w.buf.Write(p[:room])
		} else {
			w.buf.Write(p)
		}
	}
	return len(p), nil
}

func dirSize(dir string) int64 {
	var n int64
	_ = filepath.Walk(dir, func(_ string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			n += fi.Size()
		}
		return nil
	})
	return n
}

func sandboxBackendLabel() string {
	switch runtime.GOOS {
	case "linux":
		return "Linux 内核命名空间 + Seccomp"
	case "windows":
		return "Windows Job Object + UI 隔离 + PEP-578 审计沙箱"
	case "darwin":
		return "macOS Seatbelt + PEP-578 审计沙箱"
	default:
		return runtime.GOOS + " 进程限额 + PEP-578 隔离沙箱"
	}
}

var reJSONSecretField = regexp.MustCompile(`(?i)("(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[^"]*"\s*:\s*)"[^"]*"`)

func scrubWorkspaceBytes(rel string, data []byte) []byte {
	if len(data) == 0 || len(data) > 2<<20 {
		return data
	}
	probe := data
	if len(probe) > 4096 {
		probe = probe[:4096]
	}
	if bytes.IndexByte(probe, 0) >= 0 {
		return data
	}
	s := string(data)
	if strings.HasSuffix(strings.ToLower(rel), ".json") {
		s = reJSONSecretField.ReplaceAllString(s, `${1}"`+aiMasked+`"`)
		s = reKeyBlock.ReplaceAllString(s, aiMasked)
		s = reBearer.ReplaceAllString(s, "${1}"+aiMasked)
		s = reURLCred.ReplaceAllString(s, "${1}"+aiMasked+"${2}")
		s = reSkKey.ReplaceAllString(s, aiMasked)
		return []byte(s)
	}
	return []byte(aiScrub(s))
}

// stageWorkspaceFiles writes a scoped, sanitized, read-only workspace snapshot into wsDir.
func stageWorkspaceFiles(wsDir string, files []sandboxWorkspaceFile) error {
	if err := os.MkdirAll(wsDir, 0o755); err != nil {
		return err
	}
	const maxFiles = 800
	const maxBytes int64 = 64 << 20
	var total int64
	count := 0
	var dirs []string
	for _, f := range files {
		if count >= maxFiles || total >= maxBytes {
			break
		}
		clean := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(f.Rel, "\\", "/")), "/")
		if clean == "" || clean == "." || strings.HasPrefix(clean, "..") || aiDeniedFile.MatchString(clean) {
			continue
		}
		var raw []byte
		if f.Data != nil {
			raw = f.Data
		} else if f.Path != "" {
			st, err := os.Stat(f.Path)
			if err != nil || !st.Mode().IsRegular() || total+st.Size() > maxBytes {
				continue
			}
			fh, err := os.Open(f.Path)
			if err != nil {
				continue
			}
			b, err := io.ReadAll(io.LimitReader(fh, maxBytes-total+1))
			fh.Close()
			if err != nil || int64(len(b)) > maxBytes-total {
				continue
			}
			raw = b
		} else {
			continue
		}
		if total+int64(len(raw)) > maxBytes {
			continue
		}
		dst := filepath.Join(wsDir, filepath.FromSlash(clean))
		if relCheck, err := filepath.Rel(wsDir, dst); err != nil || strings.HasPrefix(relCheck, "..") {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		dirs = append(dirs, filepath.Dir(dst))
		raw = scrubWorkspaceBytes(clean, raw)
		mode := os.FileMode(0o444)
		if f.Mode&0o111 != 0 {
			mode = 0o555
		}
		if err := os.WriteFile(dst, raw, mode); err != nil {
			return err
		}
		_ = os.Chmod(dst, mode)
		total += int64(len(raw))
		count++
	}
	for _, d := range dirs {
		_ = os.Chmod(d, 0o555)
	}
	return nil
}

// sandboxNetGuardSitePy is injected via sitecustomize.py on Linux when AllowNet=true so outbound internet works
// while loopback, link-local, metadata, and socket.bind remain strictly blocked.
// When smart-auto network mode grants access, it additionally enforces read-only HTTPS GET/HEAD, host allowlisting,
// and optional private-IP blocking inside CPython's PEP-578 audit hook.
const sandboxNetGuardSitePy = `import ipaddress, os, socket, sys, urllib.parse

_probe_port = int(os.environ.pop("MW_SB_PROBE_PORT", "0") or "0")
_net_ro = os.environ.pop("MW_SB_NET_RO", "") == "1"
_net_no_priv = os.environ.pop("MW_SB_NET_NO_PRIV", "") == "1"
_net_hosts = tuple(p.strip().lower().rstrip(".") for p in os.environ.pop("MW_SB_NET_HOSTS", "").split(",") if p.strip())
_dns_ok = [False]
_write_verbs = (b"POST ", b"PUT ", b"PATCH ", b"DELETE ", b"TRACE ")

def _to_host(h):
    if isinstance(h, bytes):
        h = h.decode("utf-8", "ignore")
    return str(h or "").strip().lower().rstrip(".")

def _host_allowed(h):
    if not _net_hosts:
        return True
    s = _to_host(h)
    if not s:
        return False
    for pat in _net_hosts:
        if pat.startswith("*."):
            base = pat[2:]
            if s == base or s.endswith("." + base):
                return True
        elif s == pat:
            return True
    return False

def _is_local_host(h):
    if not h:
        return True
    s = _to_host(h)
    if s in ("localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "0.0.0.0", "::", "::1", ""):
        return True
    if s.startswith("127.") or s.startswith("169.254.") or s.endswith(".localhost"):
        return True
    if "%" in s:
        s = s.split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(s)
        if ip.is_loopback or ip.is_unspecified or ip.is_link_local or ip.is_multicast:
            return True
        if _net_no_priv and (ip.is_private or ip.is_reserved):
            return True
    except ValueError:
        pass
    return False

def _net_audit(event, args):
    if event == "socket.bind":
        raise PermissionError("sandbox: binding local ports is not permitted")
    if event == "urllib.Request":
        fullurl = args[0] if len(args) > 0 else ""
        data = args[1] if len(args) > 1 else None
        method = args[3] if len(args) > 3 else None
        if _net_ro:
            if data is not None:
                raise PermissionError("sandbox: auto-approved network is read-only (request body blocked)")
            if method and str(method).upper() not in ("GET", "HEAD"):
                raise PermissionError("sandbox: auto-approved network only permits GET/HEAD")
        if _net_hosts:
            u = urllib.parse.urlsplit(str(fullurl))
            if u.scheme.lower() != "https":
                raise PermissionError("sandbox: auto-approved network requires HTTPS")
            if u.port not in (None, 443):
                raise PermissionError("sandbox: auto-approved network only permits port 443")
            if not _host_allowed(u.hostname):
                raise PermissionError("sandbox: host not in auto-approved allowlist: " + str(u.hostname))
        return
    if event == "http.client.connect":
        if _net_hosts:
            host = args[1] if len(args) > 1 else ""
            port = args[2] if len(args) > 2 else 0
            if port not in (443, "443"):
                raise PermissionError("sandbox: auto-approved network only permits port 443")
            if not _host_allowed(host):
                raise PermissionError("sandbox: host not in auto-approved allowlist: " + str(host))
        return
    if event == "http.client.send":
        if _net_ro:
            data = args[1] if len(args) > 1 else None
            if isinstance(data, (bytes, bytearray)) and any(data.startswith(v) for v in _write_verbs):
                raise PermissionError("sandbox: auto-approved network only permits GET/HEAD")
        return
    if event == "socket.getaddrinfo":
        if _net_hosts:
            host = args[0] if len(args) > 0 else None
            if not _host_allowed(host):
                raise PermissionError("sandbox: DNS lookup blocked for non-allowlisted host: " + str(host))
            _dns_ok[0] = True
        return
    if event in ("socket.connect", "socket.sendto", "socket.sendmsg"):
        addr = args[1] if len(args) > 1 else None
        if isinstance(addr, tuple) and len(addr) >= 1:
            host = addr[0]
            port = addr[1] if len(addr) >= 2 and isinstance(addr[1], int) else 0
            if _is_local_host(host):
                raise PermissionError("sandbox: local/private network access is blocked")
            if _probe_port and port == _probe_port:
                raise PermissionError("sandbox: platform port access is blocked")
            if _net_hosts:
                if port != 443:
                    raise PermissionError("sandbox: auto-approved network only permits port 443")
                if not _dns_ok[0]:
                    raise PermissionError("sandbox: direct IP socket connection blocked under auto-approved network")
        else:
            raise PermissionError("sandbox: non-IP socket address is blocked")

sys.addaudithook(_net_audit)
`

// sandboxHostBootstrapPy confines Python execution on non-chroot hosts (Windows / macOS / non-Linux):
//   1. Maps virtual /in, /out, /tmp, /rt paths transparently so scripts work identically across OSes.
//   2. Locks filesystem reads to (/in, /out, /tmp, /rt, Python stdlib/prefix) and writes strictly to (/out, /tmp).
//   3. Blocks subprocesses, shell escapes, ctypes native library loading, registry edits, and unauthorized network.
const sandboxHostBootstrapPy = `import builtins, io, ipaddress, json, os, runpy, socket, sys

def _boot():
    raw_cfg = os.environ.pop("MW_SB_CFG", "")
    if not raw_cfg:
        raise RuntimeError("missing sandbox configuration")
    cfg = json.loads(raw_cfg)
    in_dir = os.path.abspath(cfg["in_dir"])
    out_dir = os.path.abspath(cfg["out_dir"])
    tmp_dir = os.path.abspath(cfg["tmp_dir"])
    rt_dir = os.path.abspath(cfg["rt_dir"])
    boot_dir = os.path.abspath(cfg["boot_dir"])
    ws_dir = os.path.abspath(cfg["ws_dir"]) if cfg.get("ws_dir") else ""
    allow_net = bool(cfg.get("allow_net", False))
    net_ro = bool(cfg.get("net_readonly", False))
    net_no_priv = bool(cfg.get("net_block_private", False))
    net_hosts = tuple(str(p).strip().lower().rstrip(".") for p in (cfg.get("net_allow_hosts") or []) if str(p).strip())
    dns_ok = [False]
    write_verbs = (b"POST ", b"PUT ", b"PATCH ", b"DELETE ", b"TRACE ")
    probe_port = int(cfg.get("probe_port", 0) or 0)
    entry = cfg["entry"]
    argv = list(cfg.get("argv") or [entry])
    extra_env = dict(cfg.get("env") or {})
    local_ips = set(cfg.get("local_ips") or [])

    # Scrub host environment variables completely; keep only minimal OS runtime vars + explicit sandbox env.
    keep = {}
    if os.name == "nt":
        for k in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"):
            if k in os.environ:
                keep[k] = os.environ[k]
    os.environ.clear()
    os.environ.update(keep)
    os.environ["HOME"] = tmp_dir
    os.environ["USERPROFILE"] = tmp_dir
    os.environ["TMP"] = tmp_dir
    os.environ["TEMP"] = tmp_dir
    os.environ["TMPDIR"] = tmp_dir
    os.environ["MPLCONFIGDIR"] = tmp_dir
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.environ["PYTHONUTF8"] = "1"
    os.environ["MW_IN"] = in_dir
    os.environ["MW_OUT"] = out_dir
    if ws_dir:
        os.environ["MW_WORKSPACE"] = ws_dir
    os.environ.update(extra_env)

    norm_case = os.path.normcase
    abspath = os.path.abspath
    realpath = os.path.realpath
    sep = os.sep

    def _prefix(d):
        p = norm_case(realpath(d))
        return p if p.endswith(sep) else p + sep

    write_roots = tuple(_prefix(d) for d in (out_dir, tmp_dir))
    write_exact = frozenset(norm_case(realpath(d)).rstrip(sep) for d in (out_dir, tmp_dir))

    py_roots = set()
    for p in [rt_dir, boot_dir, sys.prefix, sys.base_prefix, sys.exec_prefix, getattr(sys, "base_exec_prefix", "")]:
        if p:
            py_roots.add(abspath(p))
    for p in list(sys.path):
        if p and os.path.isabs(p):
            py_roots.add(abspath(p))
    if os.name == "nt":
        sr = keep.get("SYSTEMROOT") or keep.get("WINDIR") or r"C:\Windows"
        for sub in ("System32", "SysWOW64", "Fonts"):
            cand = os.path.join(sr, sub)
            if os.path.isdir(cand):
                py_roots.add(abspath(cand))
    else:
        for cand in ("/usr/lib", "/usr/share", "/lib", "/lib64", "/System/Library", "/Library/Frameworks", "/etc/ssl", "/etc/resolv.conf"):
            if os.path.exists(cand):
                py_roots.add(abspath(cand))

    read_dirs = [in_dir, out_dir, tmp_dir] + ([ws_dir] if ws_dir else []) + sorted(py_roots)
    read_roots = tuple(_prefix(d) for d in read_dirs)
    read_exact = frozenset(norm_case(realpath(d)).rstrip(sep) for d in read_dirs)

    vmap = [
        ("/in", in_dir),
        ("/out", out_dir),
        ("/tmp", tmp_dir),
        ("/rt", rt_dir),
    ]
    if ws_dir:
        vmap.append(("/workspace", ws_dir))
    vmap = tuple(vmap)

    def _to_str(p):
        if isinstance(p, int):
            return None
        if hasattr(p, "__fspath__"):
            p = p.__fspath__()
        if isinstance(p, bytes):
            return p.decode("utf-8", "surrogateescape")
        if isinstance(p, str):
            return p
        return None

    def _translate(p):
        if isinstance(p, int):
            return p
        is_bytes = isinstance(p, bytes)
        s = _to_str(p)
        if s is None:
            return p
        sl = s.replace("\\", "/") if s.startswith(("/", "\\")) and not s.startswith("\\\\") else s
        if sl.startswith("/"):
            # Collapse any /.. traversal in virtual Unix-style paths before mapping
            parts = []
            for seg in sl.split("/"):
                if seg == "" or seg == ".":
                    continue
                if seg == "..":
                    if parts:
                        parts.pop()
                else:
                    parts.append(seg)
            clean_v = "/" + "/".join(parts)
            for vp, target in vmap:
                if clean_v == vp:
                    res = target
                    return res.encode("utf-8") if is_bytes else res
                if clean_v.startswith(vp + "/"):
                    rel = clean_v[len(vp) + 1:].replace("/", sep)
                    res = os.path.join(target, rel)
                    return res.encode("utf-8") if is_bytes else res
            # Non-mapped virtual Unix root paths (/etc/shadow, /root, /home, /var, /usr/x, etc.) must never hit Windows drive root
            if os.name == "nt":
                blocked = os.path.join(boot_dir, "__denied__", *parts)
                return blocked.encode("utf-8") if is_bytes else blocked
        return p

    denied_root = _prefix(os.path.join(boot_dir, "__denied__"))

    def _can_write(p):
        s = _to_str(p)
        if s is None:
            return False
        rp = norm_case(realpath(_translate(s)))
        if rp.startswith(denied_root):
            return False
        return rp in write_exact or rp.startswith(write_roots)

    def _can_read(p):
        s = _to_str(p)
        if s is None:
            return True
        rp = norm_case(realpath(_translate(s)))
        if rp.startswith(denied_root):
            return False
        return rp in read_exact or rp.startswith(read_roots)

    # Lock resource limits on non-Linux Unix (macOS, BSD) so MemoryError & proc caps hold natively
    if os.name == "posix":
        try:
            import resource
            mem_lim = int(cfg.get("memory_mb", 0) or 0) * 1024 * 1024
            if mem_lim > 0:
                for rk in ("RLIMIT_AS", "RLIMIT_DATA"):
                    rv = getattr(resource, rk, None)
                    if rv is not None:
                        try:
                            resource.setrlimit(rv, (mem_lim, mem_lim))
                        except Exception:
                            pass
            proc_lim = int(cfg.get("procs", 0) or 0)
            if proc_lim > 0 and hasattr(resource, "RLIMIT_NPROC"):
                try:
                    resource.setrlimit(resource.RLIMIT_NPROC, (proc_lim, proc_lim))
                except Exception:
                    pass
        except Exception:
            pass

    # Preload standard modules commonly used by data/doc scripts before arming strict audit hooks
    import csv, datetime, hashlib, itertools, math, pathlib, re, ssl, urllib.parse, urllib.request, zipfile, tarfile  # noqa: F401

    _orig_open = builtins.open
    _orig_io_open = io.open
    _orig_os_open = os.open
    _orig_listdir = os.listdir
    _orig_scandir = os.scandir
    _orig_stat = os.stat
    _orig_lstat = os.lstat
    _orig_access = os.access
    _orig_mkdir = os.mkdir
    _orig_makedirs = os.makedirs
    _orig_remove = os.remove
    _orig_rmdir = os.rmdir
    _orig_rename = os.rename
    _orig_replace = os.replace
    _orig_chmod = os.chmod
    _orig_utime = os.utime

    def _wrap_open(file, mode="r", *a, **kw):
        return _orig_open(_translate(file), mode, *a, **kw)

    def _wrap_io_open(file, mode="r", *a, **kw):
        return _orig_io_open(_translate(file), mode, *a, **kw)

    def _wrap_os_open(path, flags, mode=0o777, *a, **kw):
        return _orig_os_open(_translate(path), flags, mode, *a, **kw)

    def _virtual_dir_kind(p):
        s = _to_str(p)
        if s is None:
            return ""
        sl = s.replace("\\", "/")
        if sl == "/":
            return "root"
        if sl in ("/proc", "/proc/"):
            return "proc"
        return ""

    def _wrap_listdir(path="."):
        vk = _virtual_dir_kind(path)
        if vk == "root":
            return ["dev", "etc", "in", "lib", "out", "proc", "rt", "tmp", "usr"]
        if vk == "proc":
            return ["1", "self"]
        tp = _translate(path)
        if not _can_read(tp):
            raise PermissionError("sandbox: directory access denied")
        return _orig_listdir(tp)

    def _wrap_scandir(path="."):
        tp = _translate(path)
        if not _can_read(tp):
            raise PermissionError("sandbox: directory access denied")
        return _orig_scandir(tp)

    def _wrap_stat(path, *a, **kw):
        if isinstance(path, int):
            return _orig_stat(path, *a, **kw)
        vk = _virtual_dir_kind(path)
        if vk in ("root", "proc"):
            return _orig_stat(in_dir, *a, **kw)
        tp = _translate(path)
        if not _can_read(tp):
            raise PermissionError("sandbox: stat denied")
        return _orig_stat(tp, *a, **kw)

    def _wrap_lstat(path, *a, **kw):
        vk = _virtual_dir_kind(path)
        if vk in ("root", "proc"):
            return _orig_lstat(in_dir, *a, **kw)
        tp = _translate(path)
        if not _can_read(tp):
            raise PermissionError("sandbox: lstat denied")
        return _orig_lstat(tp, *a, **kw)

    def _wrap_access(path, mode, *a, **kw):
        tp = _translate(path)
        write_req = bool(mode & getattr(os, "W_OK", 2))
        if write_req and not _can_write(tp):
            return False
        if not _can_read(tp):
            return False
        return _orig_access(tp, mode, *a, **kw)

    builtins.open = _wrap_open
    io.open = _wrap_io_open
    os.open = _wrap_os_open
    os.listdir = _wrap_listdir
    os.scandir = _wrap_scandir
    os.stat = _wrap_stat
    os.lstat = _wrap_lstat
    os.access = _wrap_access
    os.mkdir = lambda p, *a, **kw: _orig_mkdir(_translate(p), *a, **kw)
    os.makedirs = lambda p, *a, **kw: _orig_makedirs(_translate(p), *a, **kw)
    os.remove = lambda p, *a, **kw: _orig_remove(_translate(p), *a, **kw)
    os.unlink = os.remove
    os.rmdir = lambda p, *a, **kw: _orig_rmdir(_translate(p), *a, **kw)
    os.rename = lambda s, d, *a, **kw: _orig_rename(_translate(s), _translate(d), *a, **kw)
    os.replace = lambda s, d, *a, **kw: _orig_replace(_translate(s), _translate(d), *a, **kw)
    os.chmod = lambda p, m, *a, **kw: _orig_chmod(_translate(p), m, *a, **kw)
    os.utime = lambda p, *a, **kw: _orig_utime(_translate(p), *a, **kw)

    write_flag_mask = (
        getattr(os, "O_WRONLY", 1)
        | getattr(os, "O_RDWR", 2)
        | getattr(os, "O_APPEND", 8)
        | getattr(os, "O_CREAT", 0x0100)
        | getattr(os, "O_TRUNC", 0x0200)
        | getattr(os, "O_EXCL", 0x0400)
    )

    blocked_events = frozenset({
        "os.system", "os.popen", "os.exec", "os.spawn", "os.posix_spawn",
        "os.fork", "os.forkpty", "subprocess.Popen",
        "ctypes.dlopen", "ctypes.dlsym", "ctypes.cdata",
        "os.symlink", "os.link", "os.chown", "os.chroot",
        "winreg.ConnectRegistry", "winreg.OpenKey", "winreg.CreateKey",
        "winreg.DeleteKey", "winreg.DeleteValue", "winreg.SetValue",
    })

    def _to_host(h):
        if isinstance(h, bytes):
            h = h.decode("utf-8", "ignore")
        return str(h or "").strip().lower().rstrip(".")

    def _host_allowed(h):
        if not net_hosts:
            return True
        s = _to_host(h)
        if not s:
            return False
        for pat in net_hosts:
            if pat.startswith("*."):
                base = pat[2:]
                if s == base or s.endswith("." + base):
                    return True
            elif s == pat:
                return True
        return False

    def _is_local_host(h):
        if not h:
            return True
        s = _to_host(h)
        if s in ("localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "0.0.0.0", "::", "::1", "") or s in local_ips:
            return True
        if s.startswith("127.") or s.startswith("169.254.") or s.endswith(".localhost"):
            return True
        if "%" in s:
            s = s.split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(s)
            if ip.is_loopback or ip.is_unspecified or ip.is_link_local or ip.is_multicast:
                return True
            if net_no_priv and (ip.is_private or ip.is_reserved):
                return True
        except ValueError:
            pass
        return False

    os.chdir(out_dir)
    entry_real = _translate(entry)
    sys.argv = argv
    sys.path = [in_dir] + [p for p in sys.path if p and _can_read(p)]

    armed = True

    def _audit(event, args):
        if not armed:
            return
        if event in blocked_events:
            raise PermissionError("sandbox blocked: " + event)
        if event == "open":
            path = args[0] if len(args) > 0 else None
            mode = args[1] if len(args) > 1 else ""
            flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
            if isinstance(path, int):
                return
            writing = bool(flags & write_flag_mask) or (isinstance(mode, str) and any(c in mode for c in "wa+x"))
            if writing:
                if not _can_write(path):
                    raise PermissionError("sandbox: read-only path")
            else:
                if not _can_read(path):
                    raise PermissionError("sandbox: access denied")
            return
        if event in ("os.mkdir", "os.remove", "os.rmdir", "os.chmod", "os.utime", "os.truncate"):
            if not _can_write(args[0]):
                raise PermissionError("sandbox: read-only path")
            return
        if event in ("os.rename",):
            if not (_can_write(args[0]) and _can_write(args[1])):
                raise PermissionError("sandbox: rename denied")
            return
        if event in ("os.listdir", "os.scandir"):
            if args and args[0] is not None and not isinstance(args[0], int):
                if not _can_read(args[0]):
                    raise PermissionError("sandbox: listdir denied")
            return
        if event == "socket.bind":
            raise PermissionError("sandbox: socket.bind denied")
        if event == "urllib.Request":
            if not allow_net:
                raise PermissionError("sandbox: network access is disabled")
            fullurl = args[0] if len(args) > 0 else ""
            data = args[1] if len(args) > 1 else None
            method = args[3] if len(args) > 3 else None
            if net_ro:
                if data is not None:
                    raise PermissionError("sandbox: auto-approved network is read-only (request body blocked)")
                if method and str(method).upper() not in ("GET", "HEAD"):
                    raise PermissionError("sandbox: auto-approved network only permits GET/HEAD")
            if net_hosts:
                u = urllib.parse.urlsplit(str(fullurl))
                if u.scheme.lower() != "https":
                    raise PermissionError("sandbox: auto-approved network requires HTTPS")
                if u.port not in (None, 443):
                    raise PermissionError("sandbox: auto-approved network only permits port 443")
                if not _host_allowed(u.hostname):
                    raise PermissionError("sandbox: host not in auto-approved allowlist: " + str(u.hostname))
            return
        if event == "http.client.connect":
            if not allow_net:
                raise PermissionError("sandbox: network access is disabled")
            if net_hosts:
                host = args[1] if len(args) > 1 else ""
                port = args[2] if len(args) > 2 else 0
                if port not in (443, "443"):
                    raise PermissionError("sandbox: auto-approved network only permits port 443")
                if not _host_allowed(host):
                    raise PermissionError("sandbox: host not in auto-approved allowlist: " + str(host))
            return
        if event == "http.client.send":
            if net_ro:
                data = args[1] if len(args) > 1 else None
                if isinstance(data, (bytes, bytearray)) and any(data.startswith(v) for v in write_verbs):
                    raise PermissionError("sandbox: auto-approved network only permits GET/HEAD")
            return
        if event == "socket.getaddrinfo":
            if allow_net and net_hosts:
                host = args[0] if len(args) > 0 else None
                if not _host_allowed(host):
                    raise PermissionError("sandbox: DNS lookup blocked for non-allowlisted host: " + str(host))
                dns_ok[0] = True
            return
        if event in ("socket.connect", "socket.sendto", "socket.sendmsg"):
            if not allow_net:
                raise PermissionError("sandbox: network access is disabled")
            addr = args[1] if len(args) > 1 else None
            if isinstance(addr, tuple) and len(addr) >= 1:
                host = addr[0]
                port = addr[1] if len(addr) >= 2 and isinstance(addr[1], int) else 0
                if _is_local_host(host):
                    raise PermissionError("sandbox: local/private network is blocked")
                if probe_port and port == probe_port:
                    raise PermissionError("sandbox: platform port is blocked")
                if net_hosts:
                    if port != 443:
                        raise PermissionError("sandbox: auto-approved network only permits port 443")
                    if not dns_ok[0]:
                        raise PermissionError("sandbox: direct IP socket connection blocked under auto-approved network")
            else:
                raise PermissionError("sandbox: unsupported socket address")

    sys.addaudithook(_audit)
    runpy.run_path(entry_real, run_name="__main__")

_boot()
`

// ---- self-check ----

type sandboxCheck struct {
	Name string `json:"name"`
	OK   bool   `json:"ok"`
	Note string `json:"note,omitempty"`
}

// sandboxSelfCheck runs a small program that tries to get out, and reports what held. The sandbox is on only when
// every check holds.
func sandboxSelfCheck(ctx context.Context, work, runtimeDir, pythonBin string, probePort int) (bool, []sandboxCheck) {
	var out []sandboxCheck
	add := func(name string, ok bool, note string) { out = append(out, sandboxCheck{name, ok, note}) }
	script := `
import os, socket, sys, json
r = {}
r["sum"] = sum(range(10))
def tryconn(addr):
    s = socket.socket(); s.settimeout(1)
    try:
        s.connect(addr); return True
    except Exception:
        return False
    finally:
        s.close()
r["net_local"] = tryconn(("127.0.0.1", %d))
r["net_out"] = tryconn(("8.8.8.8", 53))
r["etc_shadow"] = os.path.exists("/etc/shadow")
r["root_dir"] = os.path.exists("/root")
r["home"] = os.path.exists("/home")
r["var"] = os.path.exists("/var")
def canwrite(p):
    try:
        open(p, "w").write("x"); return True
    except Exception:
        return False
r["write_usr"] = canwrite("/usr/x")
r["write_in"] = canwrite("/in/x")
r["write_rt"] = canwrite("/rt/x")
r["write_out"] = canwrite("/out/ok.txt")
try:
    r["pids"] = len([p for p in os.listdir("/proc") if p.isdigit()])
except Exception:
    r["pids"] = 1
try:
    r["mount"] = os.system("mount -t tmpfs none /tmp 2>/dev/null") == 0
except Exception:
    r["mount"] = False
try:
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    r["unshare_userns"] = libc.unshare(0x10000000) == 0
    r["ptrace"] = libc.ptrace(0, 0, 0, 0) == 0
    r["keyctl"] = libc.syscall(250, 0, 0, 0, 0, 0) >= 0
except Exception:
    r["unshare_userns"] = False
    r["ptrace"] = False
    r["keyctl"] = False
try:
    x = bytearray(%d * 1024 * 1024 * 2); r["memory"] = True
except MemoryError:
    r["memory"] = False
print(json.dumps(r))
`
	limits := sandboxLimits{Seconds: 20, MemoryMB: 512, Procs: 32, OutputMB: 8}
	code := filepath.Join(work, "selfcheck.py")
	_ = os.MkdirAll(work, 0o755)
	if err := os.WriteFile(code, []byte(fmt.Sprintf(script, probePort, limits.MemoryMB)), 0o644); err != nil {
		add("准备自检程序", false, err.Error())
		return false, out
	}
	defer os.Remove(code)
	innerPy := pythonBin
	if runtime.GOOS == "linux" && !filepath.IsAbs(pythonBin) {
		innerPy = "/rt/bin/" + pythonBin
	} else if runtime.GOOS == "linux" && strings.HasPrefix(pythonBin, runtimeDir) {
		rel, _ := filepath.Rel(runtimeDir, pythonBin)
		innerPy = "/rt/" + filepath.ToSlash(rel)
	}
	res, err := runSandbox(ctx, work, sandboxRun{
		Runtime:   runtimeDir,
		PythonBin: pythonBin,
		Argv:      []string{innerPy, "/in/selfcheck.py"},
		Inputs:    []sandboxInput{{"selfcheck.py", code}},
		Limits:    limits,
		AllowNet:  false,
		ProbePort: probePort,
	})
	if err != nil {
		add("启动沙箱", false, err.Error())
		return false, out
	}
	defer res.Cleanup()
	var r map[string]any
	if json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &r) != nil {
		add("启动沙箱", false, strings.TrimSpace(res.Stderr+" "+res.Stdout))
		return false, out
	}
	b := func(k string) bool { v, _ := r[k].(bool); return v }
	add("能运行程序", r["sum"] == float64(45), "")
	add("不能连到本机的服务", !b("net_local"), "")
	add("不能连到外网（默认离线策略）", !b("net_out"), "")
	add("看不到系统和用户的文件", !b("etc_shadow") && !b("root_dir") && !b("home") && !b("var"), "")
	add("系统目录和运行环境是只读的", !b("write_usr") && !b("write_in") && !b("write_rt"), "")
	add("只能把结果写到输出目录", b("write_out"), "")
	add("只看得到自己的进程", r["pids"] != nil && r["pids"].(float64) <= 3, "")
	add("不能自己挂载或执行外部系统命令", !b("mount"), "")
	add("不能越权逃逸或追踪其他进程", !b("unshare_userns") && !b("ptrace") && !b("keyctl"), "")
	add("内存有上限", !b("memory"), "")
	// a program that never ends is stopped
	loop := filepath.Join(work, "loop.py")
	_ = os.WriteFile(loop, []byte("while True: pass\n"), 0o644)
	defer os.Remove(loop)
	l2 := limits
	l2.Seconds = 2
	t0 := time.Now()
	res2, err := runSandbox(ctx, work, sandboxRun{
		Runtime:   runtimeDir,
		PythonBin: pythonBin,
		Argv:      []string{innerPy, "/in/loop.py"},
		Inputs:    []sandboxInput{{"loop.py", loop}},
		Limits:    l2,
		AllowNet:  false,
		ProbePort: probePort,
	})
	if err == nil {
		res2.Cleanup()
	}
	add("超时会被强制结束", err == nil && res2.TimedOut && time.Since(t0) < 8*time.Second, "")

	lShell := limits
	lShell.Seconds = 10
	shellCmd := `printf 'shell-ok\n' > "$MW_OUT/shell.txt"; touch "$MW_IN/_nope" 2>/dev/null && exit 2 || exit 0`
	if runtime.GOOS == "windows" {
		shellCmd = `Set-Content -LiteralPath "$env:MW_OUT\shell.txt" -Value "shell-ok" -Encoding UTF8; if ($env:MW_SANDBOX_SPEC) { exit 2 }`
	}
	res3, err3 := runSandbox(ctx, work, sandboxRun{
		Mode:      "shell",
		Runtime:   runtimeDir,
		PythonBin: pythonBin,
		Command:   shellCmd,
		Limits:    lShell,
		AllowNet:  false,
		ProbePort: probePort,
	})
	shellOK := err3 == nil && res3.ExitCode == 0 && len(res3.Files) > 0 && res3.Files[0].Name == "shell.txt"
	shellNote := ""
	if err3 != nil {
		shellNote = err3.Error()
	} else if !shellOK {
		shellNote = strings.TrimSpace(res3.Stderr + " " + res3.Stdout)
	}
	if err3 == nil {
		res3.Cleanup()
	}
	add("支持隔离 Shell / CLI 命令运行", shellOK, shellNote)

	ok := true
	for _, c := range out {
		ok = ok && c.OK
	}
	return ok, out
}

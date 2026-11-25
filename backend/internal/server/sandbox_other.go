//go:build !linux && !windows

package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
)

func hostLocalIPs() []string {
	var ips []string
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok && ipnet.IP != nil {
			ips = append(ips, strings.ToLower(ipnet.IP.String()))
		}
	}
	return ips
}

func resolveUnixPython(r sandboxRun) (string, string, error) {
	if r.PythonBin != "" {
		if filepath.IsAbs(r.PythonBin) {
			if fi, err := os.Stat(r.PythonBin); err == nil && !fi.IsDir() {
				rt := r.Runtime
				if rt == "" {
					rt = filepath.Dir(filepath.Dir(r.PythonBin))
				}
				return rt, r.PythonBin, nil
			}
		} else if r.Runtime != "" {
			cand := filepath.Join(r.Runtime, "bin", r.PythonBin)
			if fi, err := os.Stat(cand); err == nil && !fi.IsDir() {
				return r.Runtime, cand, nil
			}
		}
	}
	if r.Runtime != "" {
		for _, rel := range []string{filepath.Join("bin", "python3"), filepath.Join("bin", "python"), "python3"} {
			cand := filepath.Join(r.Runtime, rel)
			if fi, err := os.Stat(cand); err == nil && !fi.IsDir() {
				return r.Runtime, cand, nil
			}
		}
	}
	if p, err := exec.LookPath("python3"); err == nil {
		real, _ := filepath.EvalSymlinks(p)
		if real == "" {
			real = p
		}
		return filepath.Dir(filepath.Dir(real)), real, nil
	}
	return "", "", errors.New("未找到可用的 Python 3 解释器")
}

func seatbeltQuote(p string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(p) + `"`
}

func resolveUnixShell(pref string) (string, error) {
	p := strings.ToLower(strings.TrimSpace(pref))
	switch p {
	case "sh":
		if path, err := exec.LookPath("sh"); err == nil {
			return path, nil
		}
		return "/bin/sh", nil
	case "bash":
		if path, err := exec.LookPath("bash"); err == nil {
			return path, nil
		}
	}
	for _, c := range []string{"bash", "sh"} {
		if path, err := exec.LookPath(c); err == nil {
			return path, nil
		}
	}
	if _, err := os.Stat("/bin/sh"); err == nil {
		return "/bin/sh", nil
	}
	return "", errors.New("未找到可用的 Shell 解释器（bash / sh）")
}

func buildDarwinSeatbeltProfile(inDir, outDir, tmpDir, rtDir, bootDir, wsDir, pyExe string, shellMode, allowNet bool) string {
	var b strings.Builder
	b.WriteString("(version 1)\n")
	b.WriteString("(deny default)\n")
	if shellMode {
		for _, ed := range []string{"/bin", "/usr/bin", "/usr/sbin", "/sbin", "/usr/local", "/opt/homebrew", "/System", "/Library", outDir, tmpDir} {
			b.WriteString("(allow process-exec (subpath " + seatbeltQuote(ed) + "))\n")
		}
		if rtDir != "" {
			b.WriteString("(allow process-exec (subpath " + seatbeltQuote(rtDir) + "))\n")
		}
	} else {
		b.WriteString("(allow process-exec (literal " + seatbeltQuote(pyExe) + "))\n")
	}
	b.WriteString("(allow process-fork)\n")
	b.WriteString("(allow signal (target self))\n")
	b.WriteString("(allow sysctl-read)\n")
	b.WriteString("(allow mach-lookup)\n")
	b.WriteString("(allow file-read-metadata)\n")
	readDirs := []string{
		inDir, outDir, tmpDir, rtDir, bootDir, wsDir,
		"/usr/lib", "/usr/share", "/System/Library", "/Library/Frameworks",
		"/private/etc/ssl", "/private/etc/resolv.conf", "/dev/urandom", "/dev/random", "/dev/null",
	}
	if pyExe != "" {
		readDirs = append(readDirs, filepath.Dir(pyExe))
	}
	if shellMode {
		readDirs = append(readDirs, "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local", "/opt/homebrew", "/private/var/select")
	}
	for _, d := range readDirs {
		if d == "" {
			continue
		}
		if real, err := filepath.EvalSymlinks(d); err == nil && real != "" {
			b.WriteString("(allow file-read* (subpath " + seatbeltQuote(real) + "))\n")
		}
		b.WriteString("(allow file-read* (subpath " + seatbeltQuote(d) + "))\n")
	}
	for _, w := range []string{outDir, tmpDir} {
		if real, err := filepath.EvalSymlinks(w); err == nil && real != "" {
			b.WriteString("(allow file-write* (subpath " + seatbeltQuote(real) + "))\n")
		}
		b.WriteString("(allow file-write* (subpath " + seatbeltQuote(w) + "))\n")
	}
	b.WriteString("(allow file-write* (literal \"/dev/null\"))\n")
	if allowNet {
		b.WriteString("(allow network-outbound (remote ip))\n")
		b.WriteString("(deny network-outbound (remote ip \"localhost:*\"))\n")
	}
	return b.String()
}

// runSandbox runs one command on macOS / non-Linux Unix using Seatbelt (when available) + process group + PEP-578 confinement.
func runSandbox(ctx context.Context, work string, r sandboxRun) (sandboxResult, error) {
	lim := r.Limits.withDefaults()
	res := sandboxResult{Cleanup: func() {}}
	shellMode := r.Mode == "shell"
	var rtDir, pyExe, shBin string
	var err error
	if shellMode {
		if strings.TrimSpace(r.Command) == "" && len(r.Argv) == 0 {
			return res, errors.New("沙箱没有指定要运行的命令或程序")
		}
		rtDir, pyExe, _ = resolveUnixPython(r)
		if pyExe != "" {
			if real, e := filepath.EvalSymlinks(pyExe); e == nil && real != "" {
				pyExe = real
			}
		}
		if len(r.Argv) == 0 {
			if shBin, err = resolveUnixShell(r.Shell); err != nil {
				return res, err
			}
		}
	} else {
		if len(r.Argv) < 2 {
			return res, errors.New("沙箱没有指定要运行的脚本")
		}
		rtDir, pyExe, err = resolveUnixPython(r)
		if err != nil {
			return res, err
		}
		if real, e := filepath.EvalSymlinks(pyExe); e == nil && real != "" {
			pyExe = real
		}
	}
	if err := os.MkdirAll(work, 0o755); err != nil {
		return res, err
	}
	dir, err := os.MkdirTemp(work, "run-")
	if err != nil {
		return res, err
	}
	res.Cleanup = func() {
		_ = filepath.Walk(dir, func(p string, fi os.FileInfo, e error) error {
			if e == nil {
				_ = os.Chmod(p, 0o700)
			}
			return nil
		})
		_ = os.RemoveAll(dir)
	}
	fail := func(e error) (sandboxResult, error) {
		res.Cleanup()
		return res, e
	}

	inDir := filepath.Join(dir, "in")
	outDir := filepath.Join(dir, "out")
	tmpDir := filepath.Join(dir, "tmp")
	bootDir := filepath.Join(dir, "boot")
	for _, d := range []string{inDir, outDir, tmpDir, bootDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fail(err)
		}
	}
	for _, f := range r.Inputs {
		name := filepath.Base(f.Name)
		src, err := os.Open(f.Path)
		if err != nil {
			return fail(fmt.Errorf("读不到输入文件 %s", name))
		}
		dstPath := filepath.Join(inDir, name)
		dst, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			src.Close()
			return fail(err)
		}
		_, err = io.Copy(dst, src)
		src.Close()
		dst.Close()
		if err != nil {
			return fail(err)
		}
		_ = os.Chmod(dstPath, 0o444)
	}

	wsDir := ""
	if len(r.Workspace) > 0 {
		wsDir = filepath.Join(dir, "workspace")
		if err := stageWorkspaceFiles(wsDir, r.Workspace); err != nil {
			return fail(err)
		}
	}

	cctx, cancel := context.WithTimeout(ctx, time.Duration(lim.Seconds)*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	var cmdEnv []string
	if shellMode {
		argv := r.Argv
		if len(argv) == 0 {
			cmdScript := filepath.Join(inDir, "_cmd.sh")
			if err := os.WriteFile(cmdScript, []byte(r.Command+"\n"), 0o555); err != nil {
				return fail(err)
			}
			_ = os.Chmod(cmdScript, 0o555)
			argv = []string{shBin, cmdScript}
		}
		pathParts := []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"}
		if pyExe != "" {
			pathParts = append([]string{filepath.Dir(pyExe)}, pathParts...)
		}
		cmdEnv = []string{
			"PATH=" + strings.Join(pathParts, ":"),
			"HOME=" + tmpDir,
			"TMPDIR=" + tmpDir,
			"TEMP=" + tmpDir,
			"TMP=" + tmpDir,
			"LANG=C.UTF-8",
			"LC_ALL=C.UTF-8",
			"PYTHONIOENCODING=utf-8",
			"MW_IN=" + inDir,
			"MW_OUT=" + outDir,
			"MW_SANDBOX_MODE=shell",
		}
		if wsDir != "" {
			cmdEnv = append(cmdEnv, "MW_WORKSPACE="+wsDir)
		}
		cmdEnv = append(cmdEnv, r.Env...)
		if runtime.GOOS == "darwin" {
			if _, serr := os.Stat("/usr/bin/sandbox-exec"); serr == nil {
				prof := buildDarwinSeatbeltProfile(inDir, outDir, tmpDir, rtDir, bootDir, wsDir, pyExe, true, r.AllowNet)
				cmd = exec.CommandContext(cctx, "/usr/bin/sandbox-exec", append([]string{"-p", prof}, argv...)...)
			}
		}
		if cmd == nil {
			cmd = exec.CommandContext(cctx, argv[0], argv[1:]...)
		}
	} else {
		bootScript := filepath.Join(bootDir, "_sandbox_boot.py")
		if err := os.WriteFile(bootScript, []byte(sandboxHostBootstrapPy), 0o444); err != nil {
			return fail(err)
		}

		extraEnv := map[string]string{}
		for _, kv := range r.Env {
			if k, v, ok := strings.Cut(kv, "="); ok {
				extraEnv[k] = v
			}
		}
		cfgBytes, _ := json.Marshal(map[string]any{
			"in_dir":     inDir,
			"out_dir":    outDir,
			"tmp_dir":    tmpDir,
			"rt_dir":     rtDir,
			"boot_dir":   bootDir,
			"ws_dir":     wsDir,
			"allow_net":         r.AllowNet,
			"net_readonly":      r.NetReadOnly,
			"net_allow_hosts":   r.NetAllowHosts,
			"net_block_private": r.NetBlockPrivate,
			"probe_port":        r.ProbePort,
			"memory_mb":  lim.MemoryMB,
			"procs":      lim.Procs,
			"entry":      r.Argv[1],
			"argv":       r.Argv[1:],
			"env":        extraEnv,
			"local_ips":  hostLocalIPs(),
		})
		if runtime.GOOS == "darwin" {
			if _, serr := os.Stat("/usr/bin/sandbox-exec"); serr == nil {
				prof := buildDarwinSeatbeltProfile(inDir, outDir, tmpDir, rtDir, bootDir, wsDir, pyExe, false, r.AllowNet)
				cmd = exec.CommandContext(cctx, "/usr/bin/sandbox-exec", "-p", prof, pyExe, "-I", "-B", bootScript)
			}
		}
		if cmd == nil {
			cmd = exec.CommandContext(cctx, pyExe, "-I", "-B", bootScript)
		}
		cmdEnv = []string{
			"HOME=" + tmpDir,
			"TMPDIR=" + tmpDir,
			"TEMP=" + tmpDir,
			"TMP=" + tmpDir,
			"LANG=C.UTF-8",
			"LC_ALL=C.UTF-8",
			"MW_SB_CFG=" + string(cfgBytes),
		}
	}
	cmd.Dir = outDir
	cmd.Env = cmdEnv
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, stderr := &capWriter{max: 256 << 10}, &capWriter{max: 64 << 10}
	cmd.Stdout, cmd.Stderr = stdout, stderr

	began := time.Now()
	if err := cmd.Start(); err != nil {
		return fail(fmt.Errorf("沙箱启动失败：%v", err))
	}
	pgid := cmd.Process.Pid
	killGroup := func() {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		_ = cmd.Process.Kill()
	}

	done := make(chan struct{})
	var tooBig bool
	go func() {
		t := time.NewTicker(250 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-cctx.Done():
				killGroup()
				return
			case <-t.C:
				if dirSize(outDir) > int64(lim.OutputMB)<<20 {
					tooBig = true
					killGroup()
					return
				}
			}
		}
	}()

	werr := cmd.Wait()
	close(done)
	killGroup()

	res.Duration = time.Since(began)
	res.Stdout, res.Stderr = stdout.buf.String(), stderr.buf.String()
	res.TooBig = tooBig
	if cctx.Err() == context.DeadlineExceeded {
		res.TimedOut = true
	}
	var ee *exec.ExitError
	switch {
	case werr == nil:
	case errors.As(werr, &ee):
		res.ExitCode = ee.ExitCode()
		if ee.ExitCode() < 0 {
			res.ExitCode = 137
		}
	default:
		res.ExitCode = 1
	}

	_ = filepath.Walk(outDir, func(p string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			rel, _ := filepath.Rel(outDir, p)
			res.Files = append(res.Files, sandboxOutFile{Name: filepath.ToSlash(rel), Size: fi.Size(), Path: p})
		}
		return nil
	})
	sort.Slice(res.Files, func(i, j int) bool { return res.Files[i].Name < res.Files[j].Name })
	return res, nil
}

func sandboxCommand(args []string) error {
	_ = args
	return errors.New("sandbox-child 仅用于 Linux 命名空间子进程")
}

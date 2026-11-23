//go:build windows

package main

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
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	procCreateJobObjectW     = modkernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObj = modkernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJob   = modkernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject   = modkernel32.NewProc("TerminateJobObject")
)

const (
	jobObjectBasicUIRestrictions    = 4
	jobObjectExtendedLimitInformation = 9

	jobUILimitHandles          = 0x00000001
	jobUILimitReadClipboard    = 0x00000002
	jobUILimitWriteClipboard   = 0x00000004
	jobUILimitSystemParameters = 0x00000008
	jobUILimitDisplaySettings  = 0x00000010
	jobUILimitGlobalAtoms      = 0x00000020
	jobUILimitDesktop          = 0x00000040
	jobUILimitExitWindows      = 0x00000080

	jobLimitActiveProcess           = 0x00000008
	jobLimitProcessMemory           = 0x00000100
	jobLimitJobMemory               = 0x00000200
	jobLimitDieOnUnhandledException = 0x00000400
	jobLimitKillOnJobClose          = 0x00002000

	createNoWindow = 0x08000000
)

type jobBasicUIRestrictions struct {
	UIRestrictionsClass uint32
}

type jobBasicLimitInfo struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type jobIOCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobExtendedLimitInfo struct {
	BasicLimitInformation jobBasicLimitInfo
	IoInfo                jobIOCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

func createSandboxJob(lim sandboxLimits) (syscall.Handle, error) {
	r1, _, e1 := procCreateJobObjectW.Call(0, 0)
	if r1 == 0 {
		return 0, fmt.Errorf("创建 Windows Job 隔离对象失败：%v", e1)
	}
	job := syscall.Handle(r1)
	memBytes := uintptr(lim.MemoryMB) << 20
	info := jobExtendedLimitInfo{
		BasicLimitInformation: jobBasicLimitInfo{
			LimitFlags:         jobLimitKillOnJobClose | jobLimitActiveProcess | jobLimitProcessMemory | jobLimitJobMemory | jobLimitDieOnUnhandledException,
			ActiveProcessLimit: uint32(lim.Procs),
		},
		ProcessMemoryLimit: memBytes,
		JobMemoryLimit:     memBytes,
	}
	ok, _, e2 := procSetInformationJobObj.Call(
		uintptr(job),
		uintptr(jobObjectExtendedLimitInformation),
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if ok == 0 {
		_ = syscall.CloseHandle(job)
		return 0, fmt.Errorf("设置 Windows Job 限额失败：%v", e2)
	}
	ui := jobBasicUIRestrictions{
		UIRestrictionsClass: jobUILimitHandles | jobUILimitReadClipboard | jobUILimitWriteClipboard | jobUILimitSystemParameters | jobUILimitDisplaySettings | jobUILimitGlobalAtoms | jobUILimitDesktop | jobUILimitExitWindows,
	}
	_, _, _ = procSetInformationJobObj.Call(
		uintptr(job),
		uintptr(jobObjectBasicUIRestrictions),
		uintptr(unsafe.Pointer(&ui)),
		unsafe.Sizeof(ui),
	)
	return job, nil
}

func assignToJob(job syscall.Handle, pid int) error {
	const processSetQuota = 0x0100
	const processTerminate = 0x0001
	h, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(pid))
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(h)
	ok, _, e := procAssignProcessToJob.Call(uintptr(job), uintptr(h))
	if ok == 0 {
		return e
	}
	return nil
}

func terminateJob(job syscall.Handle) {
	if job != 0 {
		_, _, _ = procTerminateJobObject.Call(uintptr(job), 137)
		_ = syscall.CloseHandle(job)
	}
}

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

func resolveWindowsPython(r sandboxRun) (string, string, error) {
	if r.PythonBin != "" {
		if fi, err := os.Stat(r.PythonBin); err == nil && !fi.IsDir() {
			rt := r.Runtime
			if rt == "" {
				rt = filepath.Dir(r.PythonBin)
			}
			return rt, r.PythonBin, nil
		}
	}
	if r.Runtime != "" {
		for _, rel := range []string{"python.exe", filepath.Join("Scripts", "python.exe"), filepath.Join("bin", "python3.exe"), filepath.Join("bin", "python.exe")} {
			cand := filepath.Join(r.Runtime, rel)
			if fi, err := os.Stat(cand); err == nil && !fi.IsDir() {
				return r.Runtime, cand, nil
			}
		}
	}
	return "", "", errors.New("未找到可用的 Windows Python 3 解释器")
}

func resolveWindowsShell(pref, sysRoot string) (kind string, exe string, err error) {
	p := strings.ToLower(strings.TrimSpace(pref))
	switch p {
	case "cmd":
		for _, c := range []string{filepath.Join(sysRoot, "System32", "cmd.exe"), os.Getenv("COMSPEC"), "cmd.exe"} {
			if c == "" {
				continue
			}
			if found, e := exec.LookPath(c); e == nil {
				return "cmd", found, nil
			}
		}
		return "", "", errors.New("未找到 cmd.exe")
	case "bash":
		for _, c := range []string{`C:\Program Files\Git\bin\bash.exe`, `C:\Program Files\Git\usr\bin\bash.exe`} {
			if fi, e := os.Stat(c); e == nil && !fi.IsDir() {
				return "bash", c, nil
			}
		}
		if found, e := exec.LookPath("bash.exe"); e == nil && !strings.EqualFold(filepath.Dir(found), filepath.Join(sysRoot, "System32")) {
			return "bash", found, nil
		}
		return "", "", errors.New("未在 Windows 宿主机检测到可用的 Git Bash（可用 powershell 或 cmd）")
	case "pwsh":
		if found, e := exec.LookPath("pwsh.exe"); e == nil {
			return "powershell", found, nil
		}
		fallthrough
	default:
		for _, c := range []string{
			filepath.Join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			"powershell.exe",
			"pwsh.exe",
		} {
			if found, e := exec.LookPath(c); e == nil {
				return "powershell", found, nil
			}
		}
		return "", "", errors.New("未找到可用的 Windows PowerShell / cmd 解释器")
	}
}

// runSandbox runs one command on Windows inside a Win32 Job Object + UI restrictions (+ Python PEP-578 audit confinement in Python mode).
func runSandbox(ctx context.Context, work string, r sandboxRun) (sandboxResult, error) {
	lim := r.Limits.withDefaults()
	res := sandboxResult{Cleanup: func() {}}
	shellMode := r.Mode == "shell"
	sysRoot := os.Getenv("SYSTEMROOT")
	if sysRoot == "" {
		sysRoot = `C:\Windows`
	}
	var rtDir, pyExe, shKind, shExe string
	var err error
	if shellMode {
		if strings.TrimSpace(r.Command) == "" && len(r.Argv) == 0 {
			return res, errors.New("沙箱没有指定要运行的命令或程序")
		}
		rtDir, pyExe, _ = resolveWindowsPython(r)
		if len(r.Argv) == 0 {
			if shKind, shExe, err = resolveWindowsShell(r.Shell, sysRoot); err != nil {
				return res, err
			}
		}
	} else {
		if len(r.Argv) < 2 {
			return res, errors.New("沙箱没有指定要运行的脚本")
		}
		rtDir, pyExe, err = resolveWindowsPython(r)
		if err != nil {
			return res, err
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
				_ = os.Chmod(p, 0o666)
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

	job, err := createSandboxJob(lim)
	if err != nil {
		return fail(err)
	}
	defer func() {
		if job != 0 {
			terminateJob(job)
			job = 0
		}
	}()

	cctx, cancel := context.WithTimeout(ctx, time.Duration(lim.Seconds)*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	if shellMode {
		if len(r.Argv) > 0 {
			cmd = exec.CommandContext(cctx, r.Argv[0], r.Argv[1:]...)
		} else {
			switch shKind {
			case "cmd":
				cmdPath := filepath.Join(inDir, "_cmd.cmd")
				body := "@echo off\r\nchcp 65001 >nul\r\n" + strings.ReplaceAll(strings.ReplaceAll(r.Command, "\r\n", "\n"), "\n", "\r\n") + "\r\n"
				if err := os.WriteFile(cmdPath, []byte(body), 0o444); err != nil {
					return fail(err)
				}
				cmd = exec.CommandContext(cctx, shExe, "/d", "/c", cmdPath)
			case "bash":
				cmdPath := filepath.Join(inDir, "_cmd.sh")
				if err := os.WriteFile(cmdPath, []byte(r.Command+"\n"), 0o444); err != nil {
					return fail(err)
				}
				cmd = exec.CommandContext(cctx, shExe, cmdPath)
			default:
				cmdPath := filepath.Join(inDir, "_cmd.ps1")
				pre := "\xef\xbb\xbf[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$env:PYTHONIOENCODING = 'utf-8'\n"
				if err := os.WriteFile(cmdPath, []byte(pre+r.Command+"\n"), 0o444); err != nil {
					return fail(err)
				}
				cmd = exec.CommandContext(cctx, shExe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", cmdPath)
			}
		}
		pathParts := []string{
			filepath.Join(sysRoot, "System32"),
			sysRoot,
			filepath.Join(sysRoot, "System32", "Wbem"),
			filepath.Join(sysRoot, "System32", "WindowsPowerShell", "v1.0"),
		}
		if rtDir != "" {
			pathParts = append(pathParts, rtDir, filepath.Join(rtDir, "Scripts"))
		} else if pyExe != "" {
			pathParts = append(pathParts, filepath.Dir(pyExe))
		}
		comspec := os.Getenv("COMSPEC")
		if comspec == "" {
			comspec = filepath.Join(sysRoot, "System32", "cmd.exe")
		}
		pathext := os.Getenv("PATHEXT")
		if pathext == "" {
			pathext = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"
		}
		cmd.Env = []string{
			"SYSTEMROOT=" + sysRoot,
			"WINDIR=" + sysRoot,
			"COMSPEC=" + comspec,
			"PATHEXT=" + pathext,
			"PATH=" + strings.Join(pathParts, ";"),
			"TEMP=" + tmpDir,
			"TMP=" + tmpDir,
			"HOME=" + tmpDir,
			"USERPROFILE=" + tmpDir,
			"PYTHONIOENCODING=utf-8",
			"PYTHONUTF8=1",
			"MW_IN=" + inDir,
			"MW_OUT=" + outDir,
			"MW_SANDBOX_MODE=shell",
		}
		if wsDir != "" {
			cmd.Env = append(cmd.Env, "MW_WORKSPACE="+wsDir)
		}
		cmd.Env = append(cmd.Env, r.Env...)
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
		cmd = exec.CommandContext(cctx, pyExe, "-I", "-B", bootScript)
		cmd.Env = []string{
			"SYSTEMROOT=" + sysRoot,
			"WINDIR=" + sysRoot,
			"TEMP=" + tmpDir,
			"TMP=" + tmpDir,
			"HOME=" + tmpDir,
			"USERPROFILE=" + tmpDir,
			"MW_SB_CFG=" + string(cfgBytes),
		}
	}
	cmd.Dir = outDir
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: createNoWindow,
		HideWindow:    true,
	}
	stdout, stderr := &capWriter{max: 256 << 10}, &capWriter{max: 64 << 10}
	cmd.Stdout, cmd.Stderr = stdout, stderr

	began := time.Now()
	if err := cmd.Start(); err != nil {
		return fail(fmt.Errorf("沙箱启动失败：%v", err))
	}
	if err := assignToJob(job, cmd.Process.Pid); err != nil {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		return fail(fmt.Errorf("绑定沙箱进程限额失败：%v", err))
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
				terminateJob(job)
				job = 0
				return
			case <-t.C:
				if dirSize(outDir) > int64(lim.OutputMB)<<20 {
					tooBig = true
					terminateJob(job)
					job = 0
					return
				}
			}
		}
	}()

	werr := cmd.Wait()
	close(done)
	if job != 0 {
		terminateJob(job)
		job = 0
	}

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

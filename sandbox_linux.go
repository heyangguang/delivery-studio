//go:build linux

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// runSandbox runs one command in the sandbox and returns what it printed and the files it wrote to /out.
func runSandbox(ctx context.Context, work string, r sandboxRun) (sandboxResult, error) {
	lim := r.Limits.withDefaults()
	res := sandboxResult{Cleanup: func() {}}
	if r.Mode == "shell" {
		if strings.TrimSpace(r.Command) == "" && len(r.Argv) == 0 {
			return res, errors.New("沙箱没有指定要运行的命令或程序")
		}
	} else if len(r.Argv) == 0 || r.Runtime == "" {
		return res, errors.New("沙箱没有指定要运行的程序")
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
			if e == nil && fi.IsDir() {
				_ = os.Chmod(p, 0o755)
			}
			return nil
		})
		_ = os.RemoveAll(dir)
	}
	fail := func(e error) (sandboxResult, error) {
		res.Cleanup()
		return res, e
	}
	in, out, root := filepath.Join(dir, "in"), filepath.Join(dir, "out"), filepath.Join(dir, "root")
	for _, d := range []string{dir, in, out, root} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fail(err)
		}
		_ = os.Chmod(d, 0o755)
	}
	if os.Getuid() == 0 {
		_ = os.Chown(out, sandboxHostUID, sandboxHostUID)
	}
	if err := os.Chmod(out, 0o777); err != nil {
		return fail(err)
	}
	for _, f := range r.Inputs {
		name := filepath.Base(f.Name)
		src, err := os.Open(f.Path)
		if err != nil {
			return fail(fmt.Errorf("读不到输入文件 %s", name))
		}
		dst, err := os.OpenFile(filepath.Join(in, name), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			src.Close()
			return fail(err)
		}
		_, err = io.Copy(dst, src)
		src.Close()
		dst.Close()
		_ = os.Chmod(filepath.Join(in, name), 0o644) // whatever the service umask is
		if err != nil {
			return fail(err)
		}
	}
	wsDir := ""
	if len(r.Workspace) > 0 {
		wsDir = filepath.Join(dir, "workspace")
		if err := stageWorkspaceFiles(wsDir, r.Workspace); err != nil {
			return fail(err)
		}
	}
	argv := r.Argv
	if r.Mode == "shell" && len(argv) == 0 {
		cmdPath := filepath.Join(in, "_cmd.sh")
		if err := os.WriteFile(cmdPath, []byte(r.Command+"\n"), 0o755); err != nil {
			return fail(err)
		}
		_ = os.Chmod(cmdPath, 0o755)
		shBin := "/bin/bash"
		if strings.EqualFold(strings.TrimSpace(r.Shell), "sh") {
			shBin = "/bin/sh"
		} else if _, err := os.Stat(shBin); err != nil {
			shBin = "/bin/sh"
		}
		argv = []string{shBin, "/in/_cmd.sh"}
	}
	drop := 0 // the user the program runs as inside, once the room is built
	if os.Getuid() == 0 {
		drop = sandboxInnerUID
	}
	if r.AllowNet {
		guardDir := filepath.Join(in, "_netguard")
		if err := os.MkdirAll(guardDir, 0o755); err != nil {
			return fail(err)
		}
		if err := os.WriteFile(filepath.Join(guardDir, "sitecustomize.py"), []byte(sandboxNetGuardSitePy), 0o644); err != nil {
			return fail(err)
		}
	}
	spec, _ := json.Marshal(sandboxSpec{Mode: r.Mode, Root: root, Runtime: r.Runtime, In: in, Out: out, Workspace: wsDir, Argv: argv, Env: r.Env, Limits: lim, DropTo: drop, AllowNet: r.AllowNet, NetReadOnly: r.NetReadOnly, NetAllowHosts: r.NetAllowHosts, NetBlockPrivate: r.NetBlockPrivate, ProbePort: r.ProbePort})
	self, err := os.Executable()
	if err != nil {
		return fail(err)
	}
	cctx, cancel := context.WithTimeout(ctx, time.Duration(lim.Seconds)*time.Second)
	defer cancel()
	// started through an open file, so the program need not sit in a folder the sandbox user may walk into
	exe, err := os.Open(self)
	if err != nil {
		return fail(err)
	}
	defer exe.Close()
	cmd := exec.CommandContext(cctx, "/proc/self/fd/3", "sandbox-child")
	cmd.ExtraFiles = []*os.File{exe}
	cmd.Env = []string{sandboxSpecEnv + "=" + string(spec)}
	cmd.Dir = "/"
	stdout, stderr := &capWriter{max: 256 << 10}, &capWriter{max: 64 << 10}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	// Run by a normal user, the program is that user inside (so it may use the files handed over). Run by root, the
	// room is built as root of the namespace, and the program then becomes the unprivileged user 1000 inside, which is
	// the host user 65534 outside.
	idmap := []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}}
	gidmap := []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}}
	if os.Getuid() == 0 {
		idmap = append(idmap, syscall.SysProcIDMap{ContainerID: sandboxInnerUID, HostID: sandboxHostUID, Size: 1})
		gidmap = append(gidmap, syscall.SysProcIDMap{ContainerID: sandboxInnerUID, HostID: sandboxHostUID, Size: 1})
	}
	cloneFlags := uintptr(syscall.CLONE_NEWUSER | syscall.CLONE_NEWNS | syscall.CLONE_NEWPID | syscall.CLONE_NEWIPC | syscall.CLONE_NEWUTS)
	if !r.AllowNet {
		cloneFlags |= syscall.CLONE_NEWNET
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags:                 cloneFlags,
		UidMappings:                idmap,
		GidMappings:                gidmap,
		GidMappingsEnableSetgroups: false,
		Pdeathsig:                  syscall.SIGKILL,
	}
	began := time.Now()
	if err := cmd.Start(); err != nil {
		return fail(fmt.Errorf("沙箱启动失败：%v", err))
	}
	// the files it writes are counted; one that grows past the limit ends the run
	done := make(chan struct{})
	var tooBig bool
	go func() {
		t := time.NewTicker(300 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if dirSize(out) > int64(lim.OutputMB)<<20 {
					tooBig = true
					_ = cmd.Process.Kill()
					return
				}
			}
		}
	}()
	werr := cmd.Wait()
	close(done)
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
	_ = filepath.Walk(out, func(p string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			rel, _ := filepath.Rel(out, p)
			res.Files = append(res.Files, sandboxOutFile{Name: rel, Size: fi.Size(), Path: p})
		}
		return nil
	})
	sort.Slice(res.Files, func(i, j int) bool { return res.Files[i].Name < res.Files[j].Name })
	return res, nil
}

// ---- inside the new namespaces ----

func sandboxChild() error {
	// the limits below belong to one thread, and that thread becomes the program
	runtime.LockOSThread()
	var sp sandboxSpec
	if err := json.Unmarshal([]byte(os.Getenv(sandboxSpecEnv)), &sp); err != nil {
		return fmt.Errorf("沙箱参数不对")
	}
	os.Unsetenv(sandboxSpecEnv)
	if err := sandboxRoom(sp); err != nil {
		return err
	}
	lim := sp.Limits.withDefaults()
	setLimit := func(res int, v uint64) { _ = syscall.Setrlimit(res, &syscall.Rlimit{Cur: v, Max: v}) }
	const (
		rlimitNproc = 6
		rlimitAS    = 9
	)
	setLimit(rlimitAS, uint64(lim.MemoryMB)<<20)
	setLimit(rlimitNproc, uint64(lim.Procs))
	setLimit(syscall.RLIMIT_FSIZE, uint64(lim.OutputMB)<<20)
	setLimit(syscall.RLIMIT_CORE, 0)
	setLimit(syscall.RLIMIT_NOFILE, 512)
	setLimit(syscall.RLIMIT_CPU, uint64(lim.Seconds)+5)
	if err := sandboxLockDown(sp.DropTo); err != nil {
		return err
	}
	pathEnv := "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	if sp.Runtime != "" {
		pathEnv = "/rt/bin:" + pathEnv
	}
	baseEnv := []string{"PATH=" + pathEnv, "HOME=/tmp", "TMPDIR=/tmp", "LANG=C.UTF-8", "PYTHONDONTWRITEBYTECODE=1", "MPLCONFIGDIR=/tmp", "MW_IN=/in", "MW_OUT=/out"}
	if sp.Runtime != "" {
		baseEnv = append(baseEnv, "LD_LIBRARY_PATH=/rt/lib")
	}
	if sp.Workspace != "" {
		baseEnv = append(baseEnv, "MW_WORKSPACE=/workspace")
	}
	if sp.Mode != "" {
		baseEnv = append(baseEnv, "MW_SANDBOX_MODE="+sp.Mode)
	}
	if sp.AllowNet {
		baseEnv = append(baseEnv, "PYTHONPATH=/in/_netguard", fmt.Sprintf("MW_SB_PROBE_PORT=%d", sp.ProbePort))
		if sp.NetReadOnly {
			baseEnv = append(baseEnv, "MW_SB_NET_RO=1")
		}
		if sp.NetBlockPrivate {
			baseEnv = append(baseEnv, "MW_SB_NET_NO_PRIV=1")
		}
		if len(sp.NetAllowHosts) > 0 {
			baseEnv = append(baseEnv, "MW_SB_NET_HOSTS="+strings.Join(sp.NetAllowHosts, ","))
		}
	}
	env := append(baseEnv, sp.Env...)
	if f, err := os.Open("/dev/null"); err == nil {
		_ = syscall.Dup2(int(f.Fd()), 0)
	}
	if err := syscall.Chdir("/out"); err != nil {
		return err
	}
	return syscall.Exec(sp.Argv[0], sp.Argv, env)
}

var sandboxLockedFlags = uintptr(syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC | syscall.MS_NOATIME | syscall.MS_RELATIME)

// bind mounts src onto dst, read-only unless rw.
func sandboxBind(src, dst string, rw bool) error {
	fi, err := os.Stat(src)
	if err != nil {
		return err
	}
	if fi.IsDir() {
		err = os.MkdirAll(dst, 0o755)
	} else {
		if err = os.MkdirAll(filepath.Dir(dst), 0o755); err == nil {
			var f *os.File
			if f, err = os.OpenFile(dst, os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
				f.Close()
			}
		}
	}
	if err != nil {
		return err
	}
	if err := syscall.Mount(src, dst, "", syscall.MS_BIND, ""); err != nil {
		return fmt.Errorf("挂载 %s：%v", src, err)
	}
	// a remount keeps the flags the host mount already has, or the kernel refuses it
	var st syscall.Statfs_t
	flags := uintptr(syscall.MS_BIND | syscall.MS_REMOUNT | syscall.MS_NOSUID | syscall.MS_NODEV)
	if syscall.Statfs(dst, &st) == nil {
		flags |= uintptr(st.Flags) & sandboxLockedFlags
	}
	if !rw {
		flags |= syscall.MS_RDONLY
	}
	if err := syscall.Mount("", dst, "", flags, ""); err != nil {
		return fmt.Errorf("限制 %s：%v", dst, err)
	}
	return nil
}

func sandboxRoom(sp sandboxSpec) error {
	if err := syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		st, _ := os.ReadFile("/proc/self/status")
		caps := ""
		for _, l := range strings.Split(string(st), "\n") {
			if strings.HasPrefix(l, "Cap") || strings.HasPrefix(l, "Uid") || strings.HasPrefix(l, "NoNewPrivs") || strings.HasPrefix(l, "Seccomp") {
				caps += l + "; "
			}
		}
		return fmt.Errorf("沙箱挂载空间：%v（%s）", err, caps)
	}
	root := sp.Root
	if err := syscall.Mount("tmpfs", root, "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "size=8m,mode=755"); err != nil {
		return fmt.Errorf("沙箱根目录：%v", err)
	}
	// system libraries only: no /etc, /home, /root, /var or anything of the platform
	for _, p := range []string{"/usr", "/lib", "/lib64", "/bin", "/sbin"} {
		fi, err := os.Lstat(p)
		if err != nil {
			continue
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			t, _ := os.Readlink(p)
			_ = os.Symlink(t, filepath.Join(root, p))
			continue
		}
		if err := sandboxBind(p, filepath.Join(root, p), false); err != nil {
			return err
		}
	}
	if sp.Runtime != "" {
		if err := sandboxBind(sp.Runtime, filepath.Join(root, "rt"), false); err != nil {
			return err
		}
	}
	if sp.Workspace != "" {
		if err := sandboxBind(sp.Workspace, filepath.Join(root, "workspace"), false); err != nil {
			return err
		}
	}
	if err := sandboxBind(sp.In, filepath.Join(root, "in"), false); err != nil {
		return err
	}
	if err := sandboxBind(sp.Out, filepath.Join(root, "out"), true); err != nil {
		return err
	}
	for _, d := range []string{"tmp", "proc", "dev", "etc"} {
		_ = os.MkdirAll(filepath.Join(root, d), 0o755)
	}
	if err := syscall.Mount("tmpfs", filepath.Join(root, "tmp"), "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV, "size=256m,mode=1777"); err != nil {
		return fmt.Errorf("临时目录：%v", err)
	}
	if err := syscall.Mount("proc", filepath.Join(root, "proc"), "proc", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, ""); err != nil {
		return fmt.Errorf("proc：%v", err)
	}
	for _, n := range []string{"null", "zero", "urandom", "random", "full"} {
		if err := sandboxBind("/dev/"+n, filepath.Join(root, "dev", n), true); err != nil {
			return err
		}
	}
	// the few lines of /etc the programs expect, written here rather than taken from the host
	_ = os.WriteFile(filepath.Join(root, "etc", "passwd"), []byte("sandbox:x:0:0:sandbox:/tmp:/bin/false\n"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "etc", "hosts"), []byte("127.0.0.1 localhost\n"), 0o644)
	if sp.AllowNet {
		if rc, err := os.ReadFile("/etc/resolv.conf"); err == nil {
			_ = os.WriteFile(filepath.Join(root, "etc", "resolv.conf"), rc, 0o644)
		}
		for _, certDir := range []string{"/etc/ssl", "/etc/pki"} {
			if fi, err := os.Stat(certDir); err == nil && fi.IsDir() {
				_ = sandboxBind(certDir, filepath.Join(root, strings.TrimPrefix(certDir, "/")), false)
			}
		}
	}
	// switch to it and let go of the old tree
	if err := syscall.Mount(root, root, "", syscall.MS_BIND|syscall.MS_REC, ""); err != nil {
		return err
	}
	old := filepath.Join(root, ".old")
	if err := os.MkdirAll(old, 0o700); err != nil {
		return err
	}
	if err := syscall.PivotRoot(root, old); err != nil {
		return fmt.Errorf("切换根目录：%v", err)
	}
	if err := syscall.Chdir("/"); err != nil {
		return err
	}
	if err := syscall.Unmount("/.old", syscall.MNT_DETACH); err != nil {
		return fmt.Errorf("卸载旧目录：%v", err)
	}
	return os.Remove("/.old")
}

// sandboxLockDown takes away every capability, for good, before the program starts.
func sandboxLockDown(dropTo int) error {
	const (
		prSetNoNewPrivs = 38
		prCapbsetDrop   = 24
		prCapAmbient    = 47
	)
	if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0); e != 0 {
		return fmt.Errorf("no_new_privs：%v", e)
	}
	for c := 0; c < 64; c++ {
		if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, prCapbsetDrop, uintptr(c), 0); e == syscall.EINVAL {
			break
		}
	}
	if dropTo > 0 {
		if err := syscall.Setgid(dropTo); err != nil {
			return fmt.Errorf("改用普通用户：%v", err)
		}
		if err := syscall.Setuid(dropTo); err != nil {
			return fmt.Errorf("改用普通用户：%v", err)
		}
	}
	_, _, _ = syscall.RawSyscall6(syscall.SYS_PRCTL, prCapAmbient, 4 /* clear all */, 0, 0, 0, 0)
	if err := sandboxSeccomp(); err != nil {
		return err
	}
	type hdr struct {
		Version uint32
		Pid     int32
	}
	type data struct{ Effective, Permitted, Inheritable uint32 }
	h := hdr{Version: 0x20080522}
	var d [2]data
	if _, _, e := syscall.RawSyscall(syscall.SYS_CAPSET, uintptr(unsafe.Pointer(&h)), uintptr(unsafe.Pointer(&d[0])), 0); e != 0 {
		return fmt.Errorf("去掉权限：%v", e)
	}
	return nil
}

func sandboxCommand(args []string) error {
	_ = args
	if err := sandboxChild(); err != nil {
		fmt.Fprintln(os.Stderr, "沙箱：", err)
		os.Exit(125)
	}
	return nil
}

// ---- system call filter ----

type sockFilter struct {
	Code uint16
	Jt   uint8
	Jf   uint8
	K    uint32
}

type sockFprog struct {
	Len    uint16
	_      [6]byte
	Filter *sockFilter
}

// the system calls that have no use for a program reading files and writing a few, and that widen what the kernel
// exposes: new namespaces, mounts, tracing other processes, loading code into the kernel, keys, perf and bpf
var sandboxDenied = []uint32{
	101, // ptrace
	155, // pivot_root
	161, // chroot
	165, // mount
	166, // umount2
	167, // swapon
	168, // swapoff
	169, // reboot
	175, // init_module
	176, // delete_module
	246, // kexec_load
	248, // add_key
	249, // request_key
	250, // keyctl
	272, // unshare
	298, // perf_event_open
	304, // open_by_handle_at
	308, // setns
	310, // process_vm_readv
	311, // process_vm_writev
	313, // finit_module
	320, // kexec_file_load
	321, // bpf
	323, // userfaultfd
	428, // open_tree
	429, // move_mount
	430, // fsopen
	431, // fsconfig
	432, // fsmount
	434, // pidfd_open
}

const (
	bpfLdAbs  = 0x20
	bpfAluAnd = 0x54
	bpfJeq    = 0x15
	bpfRet    = 0x06

	seccompRetAllow = 0x7fff0000
	seccompRetErrno = 0x00050000
	cloneNewMask    = 0x10000000 | 0x00020000 | 0x40000000 | 0x20000000 | 0x08000000 | 0x04000000 | 0x02000000
)

func sandboxSeccomp() error {
	if runtime.GOARCH != "amd64" {
		return nil // the numbers below are those of amd64; the namespaces and the lack of capabilities still hold
	}
	var p []sockFilter
	add := func(code uint16, jt, jf uint8, k uint32) { p = append(p, sockFilter{code, jt, jf, k}) }
	add(bpfLdAbs, 0, 0, 4)               // architecture
	add(bpfJeq, 1, 0, 0xC000003E)        // x86-64, or refuse (this also shuts the 32-bit entry)
	add(bpfRet, 0, 0, seccompRetErrno|1) //
	add(bpfLdAbs, 0, 0, 0)               // system call number
	for _, nr := range sandboxDenied {
		add(bpfJeq, 0, 1, nr)
		add(bpfRet, 0, 0, seccompRetErrno|1) // EPERM
	}
	add(bpfJeq, 0, 1, 435)                // clone3: ENOSYS, so the library falls back to clone, which can be checked
	add(bpfRet, 0, 0, seccompRetErrno|38) //
	add(bpfJeq, 0, 4, 56)                 // clone: not with a new namespace
	add(bpfLdAbs, 0, 0, 16)               //
	add(bpfAluAnd, 0, 0, cloneNewMask)    //
	add(bpfJeq, 1, 0, 0)                  //
	add(bpfRet, 0, 0, seccompRetErrno|1)  //
	add(bpfRet, 0, 0, seccompRetAllow)
	prog := sockFprog{Len: uint16(len(p)), Filter: &p[0]}
	const prSetSeccomp, seccompModeFilter = 22, 2
	if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, prSetSeccomp, seccompModeFilter, uintptr(unsafe.Pointer(&prog))); e != 0 {
		return fmt.Errorf("系统调用过滤：%v", e)
	}
	return nil
}

//go:build !windows

package server

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func lockFileExclusive(f *os.File, nonBlocking bool) error {
	flags := syscall.LOCK_EX
	if nonBlocking {
		flags |= syscall.LOCK_NB
	}
	return syscall.Flock(int(f.Fd()), flags)
}

func unlockFileExclusive(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}

func openFileNoFollow(path string, flag int, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(path, flag|syscall.O_NOFOLLOW, perm)
}

func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcessGroup(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}

func isProcessAlive(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) != syscall.ESRCH
}

func gatewayNotifySignals() []os.Signal {
	return []os.Signal{syscall.SIGUSR2, syscall.SIGTERM, os.Interrupt}
}

func isGatewayReloadSignal(sig os.Signal) bool {
	return sig == syscall.SIGUSR2
}

func openGatewayWorkerListener() (net.Listener, error) {
	if addrFile := strings.TrimSpace(os.Getenv("MW_GATEWAY_ADDR_FILE")); addrFile != "" {
		return openLoopbackWorkerListener(addrFile)
	}
	f := os.NewFile(3, "gateway-listener")
	ln, err := net.FileListener(f)
	_ = f.Close()
	return ln, err
}

func prepareGatewayWorkerIPC(cmd *exec.Cmd, dir string) (
	dial func(ctx context.Context, network, addr string) (net.Conn, error),
	waitAddr func(ctx context.Context, done <-chan error) error,
	cleanup func(),
	closeAfterStart func(),
	err error,
) {
	sock := filepath.Join(dir, fmt.Sprintf("worker-%d.sock", time.Now().UnixNano()))
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		return nil, nil, nil, nil, err
	}
	ln.SetUnlinkOnClose(false)
	file, err := ln.File()
	_ = ln.Close()
	if err != nil {
		_ = os.Remove(sock)
		return nil, nil, nil, nil, err
	}
	cmd.ExtraFiles = []*os.File{file}
	dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}
	waitAddr = func(context.Context, <-chan error) error { return nil }
	cleanup = func() { _ = os.Remove(sock) }
	closeAfterStart = func() { _ = file.Close() }
	return dial, waitAddr, cleanup, closeAfterStart, nil
}

func signalGatewayWorkerGraceful(cmd *exec.Cmd) {
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}
}

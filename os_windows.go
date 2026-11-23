//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var (
	modkernel32      = syscall.NewLazyDLL("kernel32.dll")
	procLockFileEx   = modkernel32.NewProc("LockFileEx")
	procUnlockFileEx = modkernel32.NewProc("UnlockFileEx")
)

const (
	lockfileFailImmediately = 0x00000001
	lockfileExclusiveLock   = 0x00000002
	processQueryLimitedInfo = 0x1000
	stillActive             = 259
)

func lockFileExclusive(f *os.File, nonBlocking bool) error {
	flags := uintptr(lockfileExclusiveLock)
	if nonBlocking {
		flags |= lockfileFailImmediately
	}
	var ol syscall.Overlapped
	r1, _, err := procLockFileEx.Call(f.Fd(), flags, 0, 1, 0, uintptr(unsafe.Pointer(&ol)))
	if r1 == 0 {
		return err
	}
	return nil
}

func unlockFileExclusive(f *os.File) error {
	var ol syscall.Overlapped
	r1, _, err := procUnlockFileEx.Call(f.Fd(), 0, 1, 0, uintptr(unsafe.Pointer(&ol)))
	if r1 == 0 {
		return err
	}
	return nil
}

func openFileNoFollow(path string, flag int, perm os.FileMode) (*os.File, error) {
	if st, err := os.Lstat(path); err == nil && st.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("拒绝打开符号链接文件")
	}
	return os.OpenFile(path, flag, perm)
}

func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}

func killProcessGroup(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	_ = cmd.Process.Kill()
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := syscall.OpenProcess(processQueryLimitedInfo, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}

func gatewayNotifySignals() []os.Signal {
	return []os.Signal{syscall.SIGTERM, os.Interrupt}
}

func isGatewayReloadSignal(_ os.Signal) bool {
	return false
}

func openGatewayWorkerListener() (net.Listener, error) {
	addrFile := strings.TrimSpace(os.Getenv("MW_GATEWAY_ADDR_FILE"))
	if addrFile == "" {
		return nil, errors.New("missing MW_GATEWAY_ADDR_FILE for Windows gateway worker")
	}
	return openLoopbackWorkerListener(addrFile)
}

func prepareGatewayWorkerIPC(cmd *exec.Cmd, dir string) (
	dial func(ctx context.Context, network, addr string) (net.Conn, error),
	waitAddr func(ctx context.Context, done <-chan error) error,
	cleanup func(),
	closeAfterStart func(),
	err error,
) {
	addrFile := filepath.Join(dir, fmt.Sprintf("worker-%d.addr", time.Now().UnixNano()))
	cmd.Env = append(cmd.Env, "MW_GATEWAY_ADDR_FILE="+addrFile)
	var targetAddr atomic.Value
	dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
		v, _ := targetAddr.Load().(string)
		if v == "" {
			return nil, errors.New("worker loopback address not ready")
		}
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", v)
	}
	waitAddr = func(ctx context.Context, done <-chan error) error {
		tick := time.NewTicker(40 * time.Millisecond)
		defer tick.Stop()
		for {
			if raw, rerr := os.ReadFile(addrFile); rerr == nil {
				if addr := strings.TrimSpace(string(raw)); addr != "" {
					targetAddr.Store(addr)
					return nil
				}
			}
			select {
			case e := <-done:
				return fmt.Errorf("worker exited before binding loopback port: %v", e)
			case <-ctx.Done():
				return ctx.Err()
			case <-tick.C:
			}
		}
	}
	cleanup = func() { _ = os.Remove(addrFile) }
	closeAfterStart = func() {}
	return dial, waitAddr, cleanup, closeAfterStart, nil
}

func signalGatewayWorkerGraceful(_ *exec.Cmd) {
	// Windows workers receive graceful shutdown via authenticated POST /__gateway/shutdown.
}

//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
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

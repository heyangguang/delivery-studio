package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Runner-side implementation for both:
//   - Execution Node (Protocol v3): runs rehearsal probes & steps across cluster targets via local bash, Ansible, or SSH
//   - Direct Target Agent (Protocol v2): runs rehearsal probes & steps directly on the local host with zero SSH/password needed

type chunkFlushWriter struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	last    time.Time
	onFlush func(string)
}

func (w *chunkFlushWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf.Write(p)
	if w.buf.Len() >= 3072 || time.Since(w.last) >= 600*time.Millisecond {
		w.flushLocked()
	}
	return len(p), nil
}

func (w *chunkFlushWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.flushLocked()
}

func (w *chunkFlushWriter) flushLocked() {
	if w.buf.Len() == 0 {
		return
	}
	s := w.buf.String()
	w.buf.Reset()
	w.last = time.Now()
	if w.onFlush != nil {
		w.onFlush(s)
	}
}

func verifyRehearsalDispatchSecurity(d rehearsalExecDispatch) error {
	if strings.TrimSpace(d.Script) == "" {
		return errors.New("下发脚本为空")
	}
	if d.ScriptSHA256 != "" && digest([]byte(d.Script)) != d.ScriptSHA256 {
		return errors.New("下发脚本摘要校验失败，已拒绝执行")
	}
	// Dual-side read-only iron law: runner independently enforces static read-only validation on read-only tasks.
	if d.ReadOnly {
		ok, warns := validateReadOnlyProbeScript(d.Script)
		if !ok || len(warns) > 0 {
			return errors.New("执行端只读门禁拦截：" + strings.Join(warns, "；"))
		}
	}
	return nil
}

func runLocalBashScript(ctx context.Context, script string, onChunk func(string)) (int, error) {
	shellBin := "bash"
	if _, err := exec.LookPath("bash"); err != nil {
		shellBin = "sh"
	}
	cmd := exec.Command(shellBin, "-s")
	cmd.Stdin = strings.NewReader(script + "\n")
	cmd.Env = append(os.Environ(), "LC_ALL=C", "TERM=dumb", "DEBIAN_FRONTEND=noninteractive")
	setProcessGroup(cmd)

	w := &chunkFlushWriter{last: time.Now(), onFlush: onChunk}
	cmd.Stdout = w
	cmd.Stderr = w

	if err := cmd.Start(); err != nil {
		return -1, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	ticker := time.NewTicker(700 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			w.Flush()
		case <-ctx.Done():
			killProcessGroup(cmd)
			<-done
			w.Flush()
			return -1, ctx.Err()
		case err := <-done:
			w.Flush()
			if err != nil {
				if cmd.ProcessState != nil {
					return cmd.ProcessState.ExitCode(), nil
				}
				return -1, err
			}
			return 0, nil
		}
	}
}

func (r *executionRunner) findManagedSSHForCluster(cluster, ip string) (privKey, knownHosts string) {
	if !safeName(cluster) {
		return "", ""
	}
	dir := filepath.Join(r.cfg.State, "access", cluster)
	keyPath := filepath.Join(dir, "id_ed25519")
	info, err := os.Lstat(keyPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return "", ""
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "*.known_hosts"))
	sort.Strings(matches)
	for i := len(matches) - 1; i >= 0; i-- {
		b, err := os.ReadFile(matches[i])
		if err == nil && strings.Contains(string(b), ip+" ") {
			return keyPath, matches[i]
		}
	}
	return "", ""
}

func (r *executionRunner) findAnsibleBinary() string {
	cands := []string{filepath.Join(r.cfg.Root, "bin", "ansible")}
	for _, root := range r.cfg.Roots {
		if root != "" {
			cands = append(cands, filepath.Join(root, "bin", "ansible"))
		}
	}
	for _, p := range cands {
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0111 != 0 {
			return p
		}
	}
	if p, err := exec.LookPath("ansible"); err == nil {
		return p
	}
	return ""
}

func (r *executionRunner) runTargetViaNode(ctx context.Context, d rehearsalExecDispatch, tg rehearsalExecTarget, onChunk func(string)) (int, error) {
	// 1. If target IP is on the local execution node itself, run directly without SSH hop.
	if localExecutionIP(tg.IP) {
		return runLocalBashScript(ctx, d.Script, onChunk)
	}

	sshUser := strings.TrimSpace(d.SSHUser)
	if sshUser == "" {
		sshUser = "root"
	}
	sshPort := d.SSHPort
	if sshPort <= 0 || sshPort > 65535 {
		sshPort = 22
	}
	privKey, knownHosts := r.findManagedSSHForCluster(d.ClusterID, tg.IP)

	// 2. Ansible ad-hoc mode (explicitly selected, or "auto" when ansible exists and ssh is unavailable)
	ansibleBin := r.findAnsibleBinary()
	useAnsible := d.ExecMethod == "ansible"
	if useAnsible && ansibleBin == "" {
		return -1, errors.New("控制机未找到 ansible 命令，请安装 Ansible 或将接入方式切换为 SSH / 自动优选")
	}
	if useAnsible {
		tmpFile, err := os.CreateTemp(r.cfg.State, "rh-script-*.sh")
		if err != nil {
			return -1, err
		}
		tmpPath := tmpFile.Name()
		defer os.Remove(tmpPath)
		if err := tmpFile.Chmod(0700); err != nil {
			_ = tmpFile.Close()
			return -1, err
		}
		if _, err := io.WriteString(tmpFile, d.Script+"\n"); err != nil {
			_ = tmpFile.Close()
			return -1, err
		}
		_ = tmpFile.Close()

		sshArgs := "-o BatchMode=yes -o ConnectTimeout=12"
		if privKey != "" && knownHosts != "" {
			sshArgs += fmt.Sprintf(" -i %s -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=%s", privKey, knownHosts)
		} else {
			sshArgs += " -o StrictHostKeyChecking=accept-new"
		}
		args := []string{
			"all",
			"-i", tg.IP + ",",
			"-u", sshUser,
			"-e", "ansible_port=" + strconv.Itoa(sshPort),
			"-m", "script",
			"-a", tmpPath,
			"--ssh-common-args=" + sshArgs,
		}
		cmd := exec.Command(ansibleBin, args...)
		cmd.Env = append(os.Environ(), "ANSIBLE_NOCOLOR=1", "ANSIBLE_STDOUT_CALLBACK=default", "LC_ALL=C")
		setProcessGroup(cmd)
		w := &chunkFlushWriter{last: time.Now(), onFlush: onChunk}
		cmd.Stdout = w
		cmd.Stderr = w
		if err := cmd.Start(); err != nil {
			return -1, err
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		ticker := time.NewTicker(700 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				w.Flush()
			case <-ctx.Done():
				killProcessGroup(cmd)
				<-done
				w.Flush()
				return -1, ctx.Err()
			case err := <-done:
				w.Flush()
				if err != nil {
					if cmd.ProcessState != nil {
						return cmd.ProcessState.ExitCode(), nil
					}
					return -1, err
				}
				return 0, nil
			}
		}
	}

	// 3. Direct non-interactive SSH mode (pipes exact script over stdin to `bash -s`, zero quoting hazards)
	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		return -1, errors.New("控制机未找到 ssh 客户端命令")
	}
	args := []string{
		"-T",
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=12",
		"-o", "ServerAliveInterval=10",
		"-o", "ServerAliveCountMax=3",
		"-p", strconv.Itoa(sshPort),
	}
	if privKey != "" && knownHosts != "" {
		args = append(args,
			"-i", privKey,
			"-o", "IdentitiesOnly=yes",
			"-o", "StrictHostKeyChecking=yes",
			"-o", "UserKnownHostsFile="+knownHosts,
		)
	} else {
		args = append(args, "-o", "StrictHostKeyChecking=accept-new")
	}
	args = append(args, sshUser+"@"+tg.IP, "bash -s")

	cmd := exec.Command(sshBin, args...)
	cmd.Stdin = strings.NewReader(d.Script + "\n")
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	setProcessGroup(cmd)
	w := &chunkFlushWriter{last: time.Now(), onFlush: onChunk}
	cmd.Stdout = w
	cmd.Stderr = w
	if err := cmd.Start(); err != nil {
		return -1, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	ticker := time.NewTicker(700 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			w.Flush()
		case <-ctx.Done():
			killProcessGroup(cmd)
			<-done
			w.Flush()
			return -1, ctx.Err()
		case err := <-done:
			w.Flush()
			if err != nil {
				if cmd.ProcessState != nil {
					return cmd.ProcessState.ExitCode(), nil
				}
				return -1, err
			}
			return 0, nil
		}
	}
}

func (r *executionRunner) executeRehearsalTask(d rehearsalExecDispatch) error {
	sendEv := func(ev rehearsalExecEvent) {
		ev.At = executionNow()
		for attempt := 0; attempt < 4; attempt++ {
			if err := r.call("rehearsal-event", ev, nil); err == nil {
				return
			}
			time.Sleep(time.Duration(attempt+1) * time.Second)
		}
	}

	if err := verifyRehearsalDispatchSecurity(d); err != nil {
		for idx, tg := range d.Targets {
			sendEv(rehearsalExecEvent{
				TaskID:      d.TaskID,
				TargetIndex: idx,
				Host:        tg.Host,
				IP:          tg.IP,
				Seq:         1,
				Kind:        "blocked",
				Reason:      err.Error(),
			})
		}
		return err
	}

	timeout := time.Duration(d.TimeoutSec) * time.Second
	if timeout < 10*time.Second {
		timeout = 180 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// Heartbeat loop checks for user-triggered cancel signal on the Hub
	hbDone := make(chan struct{})
	defer close(hbDone)
	var cancelledByUser sync.Once
	userCancelled := false
	go func() {
		tick := time.NewTicker(3 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-hbDone:
				return
			case <-tick.C:
				var hbResp struct {
					CancelTasks []string `json:"cancel_tasks"`
				}
				if err := r.call("poll", map[string]any{"version": version, "protocol": 3, "heartbeat": true}, &hbResp); err == nil {
					if contains(hbResp.CancelTasks, d.TaskID) {
						cancelledByUser.Do(func() {
							userCancelled = true
							cancel()
						})
						return
					}
				}
			}
		}
	}()

	for idx, tg := range d.Targets {
		seq := 0
		nextSeq := func() int {
			seq++
			return seq
		}
		if ctx.Err() != nil {
			sendEv(rehearsalExecEvent{
				TaskID:      d.TaskID,
				TargetIndex: idx,
				Host:        tg.Host,
				IP:          tg.IP,
				Seq:         nextSeq(),
				Kind:        "stopped",
				Reason:      "任务已中止",
			})
			continue
		}
		sendEv(rehearsalExecEvent{
			TaskID:      d.TaskID,
			TargetIndex: idx,
			Host:        tg.Host,
			IP:          tg.IP,
			Seq:         nextSeq(),
			Kind:        "started",
		})

		var evMu sync.Mutex
		onChunk := func(chunk string) {
			evMu.Lock()
			s := nextSeq()
			evMu.Unlock()
			sendEv(rehearsalExecEvent{
				TaskID:      d.TaskID,
				TargetIndex: idx,
				Host:        tg.Host,
				IP:          tg.IP,
				Seq:         s,
				Kind:        "log",
				Text:        redactRehearsalExecOutput(chunk),
			})
		}

		code, err := r.runTargetViaNode(ctx, d, tg, onChunk)
		evMu.Lock()
		finSeq := nextSeq()
		evMu.Unlock()
		if err != nil {
			if userCancelled {
				sendEv(rehearsalExecEvent{
					TaskID:      d.TaskID,
					TargetIndex: idx,
					Host:        tg.Host,
					IP:          tg.IP,
					Seq:         finSeq,
					Kind:        "stopped",
					Reason:      "任务已被用户中止",
				})
				continue
			}
			if errors.Is(err, context.DeadlineExceeded) {
				kind := "unknown"
				if d.ReadOnly {
					kind = "failed"
				}
				sendEv(rehearsalExecEvent{
					TaskID:      d.TaskID,
					TargetIndex: idx,
					Host:        tg.Host,
					IP:          tg.IP,
					Seq:         finSeq,
					Kind:        kind,
					Reason:      fmt.Sprintf("超过执行时限（%ds），进程已中止", d.TimeoutSec),
				})
				continue
			}
			sendEv(rehearsalExecEvent{
				TaskID:      d.TaskID,
				TargetIndex: idx,
				Host:        tg.Host,
				IP:          tg.IP,
				Seq:         finSeq,
				Kind:        "failed",
				ExitCode:    &code,
				Reason:      err.Error(),
			})
			continue
		}
		sendEv(rehearsalExecEvent{
			TaskID:      d.TaskID,
			TargetIndex: idx,
			Host:        tg.Host,
			IP:          tg.IP,
			Seq:         finSeq,
			Kind:        "finished",
			ExitCode:    &code,
		})
	}
	return nil
}

// executeTargetAgentTask runs a directly dispatched rehearsal task locally on the target host (zero SSH/password needed).
func executeTargetAgentTask(
	call func(path, token string, in, out any) error,
	token string,
	machineID string,
	d rehearsalExecDispatch,
) error {
	hostName, ip := "", ""
	if len(d.Targets) > 0 {
		hostName = d.Targets[0].Host
		ip = d.Targets[0].IP
	}
	sendEv := func(ev rehearsalExecEvent) {
		ev.At = executionNow()
		payload := map[string]any{
			"machine_id": machineID,
			"event":      ev,
		}
		for attempt := 0; attempt < 4; attempt++ {
			if err := call("event", token, payload, nil); err == nil {
				return
			}
			time.Sleep(time.Duration(attempt+1) * time.Second)
		}
	}

	if err := verifyRehearsalDispatchSecurity(d); err != nil {
		sendEv(rehearsalExecEvent{
			TaskID:      d.TaskID,
			TargetIndex: d.TargetIndex,
			Host:        hostName,
			IP:          ip,
			Seq:         1,
			Kind:        "blocked",
			Reason:      err.Error(),
		})
		return err
	}

	timeout := time.Duration(d.TimeoutSec) * time.Second
	if timeout < 10*time.Second {
		timeout = 180 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	hbDone := make(chan struct{})
	defer close(hbDone)
	var cancelOnce sync.Once
	userCancelled := false
	go func() {
		tick := time.NewTicker(3 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-hbDone:
				return
			case <-tick.C:
				var hbResp targetAgentInstruction
				if err := call("poll", token, map[string]any{
					"machine_id":   machineID,
					"version":      version,
					"heartbeat":    true,
					"capabilities": []string{"ssh_trust", "rehearsal_exec"},
				}, &hbResp); err == nil && hbResp.CancelTask == d.TaskID {
					cancelOnce.Do(func() {
						userCancelled = true
						cancel()
					})
					return
				}
			}
		}
	}()

	seq := 0
	var evMu sync.Mutex
	nextSeq := func() int {
		evMu.Lock()
		defer evMu.Unlock()
		seq++
		return seq
	}

	sendEv(rehearsalExecEvent{
		TaskID:      d.TaskID,
		TargetIndex: d.TargetIndex,
		Host:        hostName,
		IP:          ip,
		Seq:         nextSeq(),
		Kind:        "started",
	})

	code, err := runLocalBashScript(ctx, d.Script, func(chunk string) {
		sendEv(rehearsalExecEvent{
			TaskID:      d.TaskID,
			TargetIndex: d.TargetIndex,
			Host:        hostName,
			IP:          ip,
			Seq:         nextSeq(),
			Kind:        "log",
			Text:        redactRehearsalExecOutput(chunk),
		})
	})

	if err != nil {
		if userCancelled {
			sendEv(rehearsalExecEvent{
				TaskID:      d.TaskID,
				TargetIndex: d.TargetIndex,
				Host:        hostName,
				IP:          ip,
				Seq:         nextSeq(),
				Kind:        "stopped",
				Reason:      "任务已被用户中止",
			})
			return nil
		}
		if errors.Is(err, context.DeadlineExceeded) {
			kind := "unknown"
			if d.ReadOnly {
				kind = "failed"
			}
			sendEv(rehearsalExecEvent{
				TaskID:      d.TaskID,
				TargetIndex: d.TargetIndex,
				Host:        hostName,
				IP:          ip,
				Seq:         nextSeq(),
				Kind:        kind,
				Reason:      fmt.Sprintf("超过执行时限（%ds），进程已中止", d.TimeoutSec),
			})
			return nil
		}
		sendEv(rehearsalExecEvent{
			TaskID:      d.TaskID,
			TargetIndex: d.TargetIndex,
			Host:        hostName,
			IP:          ip,
			Seq:         nextSeq(),
			Kind:        "failed",
			ExitCode:    &code,
			Reason:      err.Error(),
		})
		return err
	}

	sendEv(rehearsalExecEvent{
		TaskID:      d.TaskID,
		TargetIndex: d.TargetIndex,
		Host:        hostName,
		IP:          ip,
		Seq:         nextSeq(),
		Kind:        "finished",
		ExitCode:    &code,
	})
	return nil
}

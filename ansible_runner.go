package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// The workbench checks what it generates with Ansible itself: a syntax check of every playbook, and rendering a
// template with the real variables. That needs ansible-core on the platform server, which is optional: without it
// everything else still works and the workbench says what it could not check.

type ansibleEnv struct {
	Bin     string `json:"-"` // directory holding ansible-playbook; empty means the PATH
	Version string `json:"version,omitempty"`
	Ready   bool   `json:"ready"`
	Reason  string `json:"reason,omitempty"`
	Where   string `json:"where,omitempty"`
}

var versionRE = regexp.MustCompile(`\[core ([0-9][0-9.]*)\]`)

var (
	ansibleMu    sync.Mutex
	ansibleCache ansibleEnv
	ansibleAt    time.Time
)

// detectAnsible looks for ansible-core in, in order: the configured directory, MW_ANSIBLE_BIN, <data>/ansible/bin and
// the PATH. The answer is cached for a minute so a page refreshing its status costs nothing.
func detectAnsible(configured, dataDir string) ansibleEnv {
	ansibleMu.Lock()
	defer ansibleMu.Unlock()
	if time.Since(ansibleAt) < time.Minute && ansibleCache.Where != "" {
		return ansibleCache
	}
	cands := []string{}
	for _, c := range []string{configured, os.Getenv("MW_ANSIBLE_BIN"), filepath.Join(dataDir, "ansible", "bin"), ""} {
		cands = append(cands, c)
	}
	var last error
	for _, dir := range cands {
		name := "ansible-playbook"
		if dir != "" {
			name = filepath.Join(dir, name)
		}
		if _, err := exec.LookPath(name); err != nil {
			last = err
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		out, err := exec.CommandContext(ctx, name, "--version").CombinedOutput()
		cancel()
		if err != nil {
			last = fmt.Errorf("%s --version：%v", name, err)
			continue
		}
		m := versionRE.FindSubmatch(out)
		if m == nil {
			last = errors.New("无法识别 ansible-playbook 的版本")
			continue
		}
		env := ansibleEnv{Bin: dir, Version: string(m[1]), Ready: true, Where: name}
		ansibleCache, ansibleAt = env, time.Now()
		return env
	}
	reason := "这台服务器上没有 ansible-core，所以无法做 Ansible 语法检查和模板渲染预览（其他检查照常进行）。"
	if last != nil && !errors.Is(last, exec.ErrNotFound) {
		reason += "最近的错误：" + last.Error()
	}
	env := ansibleEnv{Reason: reason, Where: "none"}
	ansibleCache, ansibleAt = env, time.Now()
	return env
}

// run executes an Ansible command in dir with a minimal environment: nothing of the service's own (database address,
// secrets) is passed on, and everything Ansible writes stays inside dir.
func (a ansibleEnv) run(ctx context.Context, dir string, timeout time.Duration, name string, args ...string) (string, error) {
	if !a.Ready {
		return "", errors.New(a.Reason)
	}
	bin := name
	if a.Bin != "" {
		bin = filepath.Join(a.Bin, name)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	path := "/usr/local/bin:/usr/bin:/bin"
	if a.Bin != "" {
		path = a.Bin + ":" + path
	}
	cmd.Env = []string{
		"PATH=" + path,
		"HOME=" + dir,
		"LANG=C.UTF-8",
		"ANSIBLE_CONFIG=" + filepath.Join(dir, "ansible.cfg"),
		"ANSIBLE_NOCOLOR=1",
		"ANSIBLE_HOME=" + filepath.Join(dir, ".ansible"),
		"ANSIBLE_LOCAL_TEMP=" + filepath.Join(dir, ".ansible", "tmp"),
		"ANSIBLE_FORCE_COLOR=0",
		"ANSIBLE_DEPRECATION_WARNINGS=false",
		"ANSIBLE_LOOKUP_PLUGINS=" + filepath.Join(dir, ".no-lookups"),
	}
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return out.String(), fmt.Errorf("超过 %s 仍未完成，已停止", timeout)
	}
	return strings.TrimSpace(out.String()), err
}

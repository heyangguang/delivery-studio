package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type targetAgentConfig struct {
	URL        string `json:"url"`
	ID         string `json:"id"`
	Enrollment string `json:"enrollment_token,omitempty"`
	Token      string `json:"token,omitempty"`
	CAFile     string `json:"ca_file,omitempty"`
	State      string `json:"state"`
	Enrolled   bool   `json:"enrolled"`
}
type targetAgentInstruction struct {
	ID        string `json:"id"`
	Desired   string `json:"desired"`
	PublicKey string `json:"public_key"`
	SourceIP  string `json:"source_ip"`
}

func targetAgentCommand(args []string) error {
	f := flag.NewFlagSet("target-agent", flag.ContinueOnError)
	config := f.String("config", "target-agent.json", "目标 Agent 配置（0600）")
	if e := f.Parse(args); e != nil {
		return e
	}
	if os.Geteuid() != 0 {
		return errors.New("目标 Agent 需由具有安装权限的管理员以 root 启动")
	}
	info, e := os.Lstat(*config)
	if e != nil {
		return e
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return errors.New("接入配置须为普通文件，权限 0600")
	}
	b, e := os.ReadFile(*config)
	if e != nil {
		return e
	}
	var cfg targetAgentConfig
	if json.Unmarshal(b, &cfg) != nil || !executionID.MatchString(cfg.ID) || !filepath.IsAbs(cfg.State) {
		return errors.New("目标 Agent 配置无效")
	}
	if cfg.Token == "" {
		cfg.Token = randomStoreToken(32)
		if e = atomicExecutionJSON(*config, cfg); e != nil {
			return e
		}
	}
	runner, e := newExecutionRunner(executionRunnerConfig{URL: cfg.URL, Token: cfg.Token, Root: cfg.State, State: cfg.State, CAFile: cfg.CAFile})
	if e != nil {
		return e
	}
	lock, e := os.OpenFile(filepath.Join(cfg.State, "target-agent.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer lock.Close()
	if e = lockFileExclusive(lock, true); e != nil {
		return errors.New("同一 Agent 已在运行")
	}
	machine, e := os.ReadFile("/etc/machine-id")
	if e != nil || strings.TrimSpace(string(machine)) == "" {
		return errors.New("无法读取本机 machine-id，不能核对接入身份")
	}
	identity := digest(bytes.TrimSpace(machine))
	call := func(path, token string, in, out any) error {
		raw, _ := json.Marshal(in)
		req, e := http.NewRequest("POST", strings.TrimRight(cfg.URL, "/")+"/api/target-agent/"+path, bytes.NewReader(raw))
		if e != nil {
			return e
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		res, e := runner.http.Do(req)
		if e != nil {
			return e
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return fmt.Errorf("目标 Agent 接口返回 %d，请在交付页面核对配置、身份及有效期", res.StatusCode)
		}
		if out != nil {
			return json.NewDecoder(res.Body).Decode(out)
		}
		return nil
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	applied, pub, message := "", "", ""
	logAgent("INFO", "target-agent started id=%s url=%s", cfg.ID, cfg.URL)
	connected := false
	lastErr := ""
	lastErrAt := time.Time{}
	for ctx.Err() == nil {
		if !cfg.Enrolled {
			name, _ := os.Hostname()
			ips := []string{}
			addrs, _ := net.InterfaceAddrs()
			for _, a := range addrs {
				ip, _, e := net.ParseCIDR(a.String())
				if e == nil {
					ips = append(ips, ip.String())
				}
			}
			e = call("enroll", cfg.Enrollment, map[string]any{"id": cfg.ID, "machine_id": identity, "hostname": name, "ips": ips, "token": cfg.Token}, nil)
			if e == nil {
				next := cfg
				next.Enrolled = true
				next.Enrollment = ""
				e = atomicExecutionJSON(*config, next)
				if e == nil {
					cfg = next
					logAgent("INFO", "target-agent enrolled id=%s hostname=%s", cfg.ID, name)
				}
			}
		} else {
			var instruction targetAgentInstruction
			e = call("poll", cfg.Token, map[string]any{"machine_id": identity, "version": version, "applied": applied, "public_key": pub, "host_keys": targetHostKeys(), "message": message}, &instruction)
			if e == nil {
				if !connected {
					logAgent("INFO", "connected to platform id=%s, polling for SSH trust instructions", cfg.ID)
					connected = true
					lastErr = ""
				}
				if instruction.ID != cfg.ID {
					return errors.New("target instruction ID mismatch")
				}
				if instruction.Desired == "revoked" || instruction.PublicKey != "" {
					prevApplied, prevPub := applied, pub
					e = applyTargetTrust("/root/.ssh", instruction)
					if e == nil {
						applied = instruction.Desired
						pub = instruction.PublicKey
						message = ""
						if applied != prevApplied || pub != prevPub {
							logAgent("INFO", "SSH trust synchronized id=%s state=%s", cfg.ID, applied)
						}
					} else {
						applied = ""
						message = truncRunes(e.Error(), 1500)
					}
				}
			}
		}
		if e != nil {
			connected = false
			if e.Error() != lastErr || time.Since(lastErrAt) >= 30*time.Second {
				logAgent("WARN", "target-agent sync error: %v", e)
				lastErr = e.Error()
				lastErrAt = time.Now()
			}
		}
		select {
		case <-ctx.Done():
			logAgent("INFO", "target-agent stopped cleanly id=%s", cfg.ID)
			return nil
		case <-time.After(5 * time.Second):
		}
	}
	return nil
}
func targetHostKeys() []string {
	paths, _ := filepath.Glob("/etc/ssh/ssh_host_*_key.pub")
	out := []string{}
	for _, p := range paths {
		b, e := os.ReadFile(p)
		if e == nil {
			out = append(out, strings.TrimSpace(string(b)))
		}
	}
	return out
}

// Managed lines are identifiable and scoped by agent ID. Preserve every other
// authorized_keys entry and fail closed on links, unsafe permissions or races.
func applyTargetTrust(dir string, in targetAgentInstruction) error {
	if !executionID.MatchString(in.ID) || (in.Desired != "active" && in.Desired != "revoked") {
		return errors.New("信任指令无效")
	}
	if info, e := os.Lstat(dir); e == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 {
			return errors.New(".ssh 目录类型或权限不安全，请现场检查")
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	lock, e := openFileNoFollow(filepath.Join(dir, ".middleware-trust.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer lock.Close()
	if e = lockFileExclusive(lock, false); e != nil {
		return e
	}
	defer unlockFileExclusive(lock)
	path := filepath.Join(dir, "authorized_keys")
	if info, e := os.Lstat(path); e == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 {
			return errors.New("authorized_keys 类型或权限不安全，请现场检查")
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	old, e := os.ReadFile(path)
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if len(old) > 4<<20 {
		return errors.New("authorized_keys 过大，请现场检查")
	}
	marker := " middleware-hub:" + in.ID
	kept := []string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(old), "\n"), "\n") {
		if strings.HasSuffix(line, marker) {
			continue
		}
		kept = append(kept, line)
	}
	if in.Desired == "active" {
		pub, e := normalizedPublicKey(in.PublicKey)
		if e != nil {
			return e
		}
		ip := net.ParseIP(in.SourceIP)
		if ip == nil {
			return errors.New("执行机来源地址无效")
		}
		kept = append(kept, fmt.Sprintf("restrict,from=%q %s%s", ip.String(), pub, marker))
	}
	next := []byte(strings.Join(kept, "\n"))
	if len(next) > 0 {
		next = append(next, '\n')
	}
	if bytes.Equal(old, next) {
		return nil
	}
	tmp, e := os.CreateTemp(dir, ".middleware-keys-")
	if e != nil {
		return e
	}
	defer os.Remove(tmp.Name())
	if e = tmp.Chmod(0600); e == nil {
		_, e = tmp.Write(next)
	}
	if e == nil {
		e = tmp.Sync()
	}
	ce := tmp.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	current, e := os.ReadFile(path)
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if !bytes.Equal(current, old) {
		return errors.New("authorized_keys 被其他进程修改，本次未覆盖，请重试")
	}
	if e = os.Rename(tmp.Name(), path); e != nil {
		return e
	}
	d, e := os.Open(dir)
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}

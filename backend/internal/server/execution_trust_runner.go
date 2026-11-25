package server

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"gopkg.in/yaml.v3"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type managedExecutionAccess struct {
	Agent      string `json:"agent"`
	PrivateKey string `json:"private_key"`
	KnownHosts string `json:"known_hosts"`
}

func executionAccessID(s executionSnapshot) string {
	b, _ := json.Marshal([]any{s.Job, s.AgentAccess, s.AgentIdentity})
	return digest(b)
}

func (r *executionRunner) prepareManagedTrust(p executionPreparation) (map[string]managedExecutionAccess, error) {
	access, hostErrs, err := r.prepareManagedTrustDetailed(p)
	if err != nil {
		return nil, err
	}
	if len(hostErrs) > 0 {
		names := make([]string, 0, len(hostErrs))
		for name := range hostErrs {
			names = append(names, name)
		}
		sort.Strings(names)
		return nil, hostErrs[names[0]]
	}
	return access, nil
}

func (r *executionRunner) prepareManagedTrustDetailed(p executionPreparation) (map[string]managedExecutionAccess, map[string]error, error) {
	out := map[string]managedExecutionAccess{}
	hostErrs := map[string]error{}
	if len(p.Snapshot.AgentAccess) == 0 {
		return out, hostErrs, nil
	}
	if !safeName(p.Snapshot.Cluster) {
		return nil, nil, errors.New("集群标识无效")
	}
	dir := filepath.Join(r.cfg.State, "access", p.Snapshot.Cluster)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, nil, e
	}
	for p := dir; p != filepath.Dir(r.cfg.State); p = filepath.Dir(p) {
		info, e := os.Lstat(p)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 {
			return nil, nil, errors.New("信任状态目录必须为安全的普通目录")
		}
	}
	key := filepath.Join(dir, "id_ed25519")
	if info, e := os.Lstat(key); e == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0) {
		return nil, nil, errors.New("托管私钥类型或权限不正确")
	}
	b, e := os.ReadFile(key)
	if os.IsNotExist(e) {
		_, priv, e := ed25519.GenerateKey(rand.Reader)
		if e != nil {
			return nil, nil, e
		}
		block, e := ssh.MarshalPrivateKey(priv, "middleware-execution")
		if e != nil {
			return nil, nil, e
		}
		b = pem.EncodeToMemory(block)
		f, e := os.OpenFile(key, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return nil, nil, e
		}
		_, e = f.Write(b)
		if e == nil {
			e = f.Sync()
		}
		ce := f.Close()
		if e == nil {
			e = ce
		}
		if e != nil {
			return nil, nil, e
		}
	} else if e != nil {
		return nil, nil, e
	}
	info, e := os.Lstat(key)
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, nil, errors.New("托管私钥类型或权限不正确")
	}
	signer, e := ssh.ParsePrivateKey(b)
	if e != nil {
		return nil, nil, errors.New("托管私钥无法读取")
	}
	pub := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	var resp struct {
		Agents []targetAgent `json:"agents"`
	}
	if e = r.call("trust-key", map[string]string{"preparation": p.ID, "public_key": pub}, &resp); e != nil {
		return nil, nil, e
	}
	names := make([]string, 0, len(p.Snapshot.AgentAccess))
	for name := range p.Snapshot.AgentAccess {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		id := p.Snapshot.AgentAccess[name]
		var a targetAgent
		wantIP := ""
		for _, h := range p.Snapshot.Hosts {
			if h.Name == name {
				wantIP = h.IP
			}
		}
		for _, v := range resp.Agents {
			if v.ID == id && v.Host == name && v.IP == wantIP {
				a = v
			}
		}
		if a.Applied != "active" || a.PublicKey != pub || len(a.HostKeys) == 0 {
			hostErrs[name] = fmt.Errorf("%s 的 Agent 尚未确认公钥写入；请先连接 Agent，稍后重新检查", name)
			continue
		}
		if !executionID.MatchString(id) {
			hostErrs[name] = errors.New("目标 Agent 标识无效")
			continue
		}
		known := filepath.Join(dir, executionAccessID(p.Snapshot)+"-"+id+".known_hosts")
		var lines strings.Builder
		invalidKey := false
		for _, k := range a.HostKeys {
			parsed, _, opts, rest, e := ssh.ParseAuthorizedKey([]byte(k))
			if e != nil || len(opts) > 0 || len(strings.TrimSpace(string(rest))) > 0 {
				hostErrs[name] = errors.New("目标 SSH 主机公钥无效")
				invalidKey = true
				break
			}
			fmt.Fprintf(&lines, "%s %s", a.IP, ssh.MarshalAuthorizedKey(parsed))
		}
		if invalidKey {
			continue
		}
		if e = writeExecutionAccessFile(known, []byte(lines.String())); e != nil {
			hostErrs[name] = e
			continue
		}
		out[name] = managedExecutionAccess{Agent: id, PrivateKey: key, KnownHosts: known}
	}
	if len(hostErrs) == 0 {
		if e = atomicExecutionJSON(filepath.Join(dir, executionAccessID(p.Snapshot)+".json"), out); e != nil {
			return nil, nil, e
		}
	}
	return out, hostErrs, nil
}
func (r *executionRunner) writeManagedTrust(snap executionSnapshot, project string) error {
	if len(snap.AgentAccess) == 0 {
		return nil
	}
	if !safeName(snap.Cluster) {
		return errors.New("集群标识无效")
	}
	dir := filepath.Join(r.cfg.State, "access", snap.Cluster)
	b, e := os.ReadFile(filepath.Join(dir, executionAccessID(snap)+".json"))
	if e != nil {
		return errors.New("尚未完成目标 Agent 信任检查")
	}
	var access map[string]managedExecutionAccess
	if json.Unmarshal(b, &access) != nil {
		return errors.New("本地信任记录不可读")
	}
	for host, id := range snap.AgentAccess {
		a, ok := access[host]
		if !ok || a.Agent != id || !safeName(host) || !executionID.MatchString(id) || a.PrivateKey != filepath.Join(dir, "id_ed25519") || a.KnownHosts != filepath.Join(dir, executionAccessID(snap)+"-"+id+".known_hosts") {
			return errors.New("目标 Agent 绑定变化，请重新准备检查")
		}
		known, e := os.ReadFile(a.KnownHosts)
		if e != nil {
			return e
		}
		path := filepath.Join(project, ".managed-access", host)
		if e = os.MkdirAll(path, 0700); e != nil {
			return e
		}
		dest := filepath.Join(path, "known_hosts")
		if e = writeExecutionAccessFile(dest, known); e != nil {
			return e
		}
		// Connection settings apply to this target only; other targets retain their existing SSH configuration.
		vars := map[string]any{"ansible_ssh_private_key_file": a.PrivateKey, "ansible_ssh_common_args": "-oIdentitiesOnly=yes -oUserKnownHostsFile='" + strings.ReplaceAll(dest, "'", `'"'"'`) + "'"}
		data, e := yaml.Marshal(vars)
		if e != nil {
			return e
		}
		rel := "inventory/host_vars/" + host + ".yml"
		if _, exists := snap.Files[rel]; exists {
			return errors.New("交付已有同名主机连接配置，不能覆盖")
		}
		target := filepath.Join(project, filepath.FromSlash(rel))
		if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			return e
		}
		if e = writeExecutionAccessFile(target, data); e != nil {
			return e
		}
	}
	return nil
}

func writeExecutionAccessFile(path string, b []byte) error {
	for p := filepath.Dir(path); ; {
		next := filepath.Dir(p)
		if next == p {
			break
		}
		st, e := os.Lstat(p)
		if e != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return errors.New("信任文件目录不能含符号链接")
		}
		p = next
	}
	f, e := openFileNoFollow(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	if e = f.Chmod(0600); e != nil {
		return e
	}
	if _, e = f.Write(b); e != nil {
		return e
	}
	return f.Sync()
}

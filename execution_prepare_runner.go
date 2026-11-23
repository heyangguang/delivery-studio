package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"gopkg.in/yaml.v3"
	"io"
	"middleware-deployer/mwpack"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func (r *executionRunner) matchingRoot(snap executionSnapshot) (string, error) {
	for _, root := range append([]string{r.cfg.Root}, r.cfg.Roots...) {
		if !filepath.IsAbs(root) || (snap.RuntimeRoot != "" && filepath.Clean(root) != filepath.Clean(snap.RuntimeRoot)) {
			continue
		}
		info, e := os.Lstat(root)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		ok := true
		for path, want := range snap.RuntimeFiles {
			if !executionRelative(path) {
				return "", errors.New("运行环境标识路径无效")
			}
			b, e := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
			if e != nil || digest(b) != want {
				ok = false
				break
			}
		}
		info, e = os.Stat(filepath.Join(root, "bin/ansible-playbook"))
		if ok && e == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			return root, nil
		}
	}
	return "", fmt.Errorf("未找到与本交付匹配的运行环境；按手册准备交付包，并在执行器配置 root 或 roots 中登记目录 %s", snap.RuntimeRoot)
}

const executionProbePython = `import json,os,platform,socket,subprocess,sys
release={}
with open('/etc/os-release') as f:
    for line in f:
        k,sep,v=line.strip().partition('=')
        if sep: release[k]=v.strip(chr(34)).strip(chr(39))
resolved={}
for name in sys.argv[1:]:
    res=subprocess.run(['getent','ahostsv4',name],capture_output=True,text=True)
    resolved[name]=sorted(set(line.split()[0] for line in res.stdout.splitlines() if line.strip())) if res.returncode==0 else []
data_dirs=[]
if os.path.isdir('/data'):
    try:
        for ent in sorted(os.listdir('/data')):
            if ent in ('lost+found', '.Trash', '.snapshots'): continue
            full=os.path.join('/data',ent)
            if os.path.isdir(full):
                try:
                    if os.listdir(full): data_dirs.append('/data/'+ent)
                except Exception: data_dirs.append('/data/'+ent)
            elif os.path.isfile(full) and os.path.getsize(full)>0:
                data_dirs.append('/data/'+ent)
            if len(data_dirs)>=8: break
    except Exception: pass
active_services=[]
try:
    sr=subprocess.run(['systemctl','list-units','--type=service','--state=running','--no-legend','--no-pager'],capture_output=True,text=True,timeout=4)
    if sr.returncode==0:
        pats=('postgresql','patroni','redis','etcd','nginx','haproxy','keepalived')
        for line in sr.stdout.splitlines():
            parts=line.split()
            if not parts: continue
            u=parts[0].lower()
            if any(p in u for p in pats):
                active_services.append(parts[0])
                if len(active_services)>=8: break
except Exception: pass
print(json.dumps(dict(uid=os.geteuid(),hostname=socket.gethostname(),ips=subprocess.check_output(['hostname','-I'],text=True).split(),os_id=release.get('ID'),version=release.get('VERSION_ID'),arch=platform.machine(),python=list(sys.version_info[:2]),resolved=resolved,data_dirs=data_dirs,active_services=active_services)))`

type executionProbe struct {
	UID            int                 `json:"uid"`
	Hostname       string              `json:"hostname"`
	IPs            []string            `json:"ips"`
	OSID           string              `json:"os_id"`
	Version        string              `json:"version"`
	Arch           string              `json:"arch"`
	Python         []int               `json:"python"`
	Resolved       map[string][]string `json:"resolved"`
	DataDirs       []string            `json:"data_dirs,omitempty"`
	ActiveServices []string            `json:"active_services,omitempty"`
}

func checkExecutionProbe(p executionProbe, h mwpack.Host, platformID string) error {
	return checkExecutionProbeWithHosts(p, h, platformID, nil)
}

func checkExecutionProbeWithHosts(p executionProbe, h mwpack.Host, platformID string, allHosts []mwpack.Host) error {
	if p.UID != 0 {
		return errors.New("需要执行器和目标 root 身份；当前未获得所需权限")
	}
	if p.Hostname != h.Name {
		return fmt.Errorf("现场主机名为 %s，交付记录为 %s；请先核对机器身份并按环境准备手册设置", p.Hostname, h.Name)
	}
	if !contains(p.IPs, h.IP) {
		return fmt.Errorf("预期地址 %s 不在本机地址中，请核对连接目标", h.IP)
	}
	if len(p.Python) != 2 || p.Python[0] != 3 || p.Python[1] < 9 {
		return errors.New("目标需要 Python 3.9 或以上，请先准备运行依赖")
	}
	if def, ok := mwpack.PlatformByID(platformID); ok {
		arch := "x86_64"
		if def.Arch == "arm64" {
			arch = "aarch64"
		}
		if !contains(def.OSIDs, p.OSID) || !(p.Version == def.Version || strings.HasPrefix(p.Version, def.Version+".")) || p.Arch != arch {
			return fmt.Errorf("现场为 %s %s / %s，交付材料适用于 %s", p.OSID, p.Version, p.Arch, platformID)
		}
	}
	for _, peer := range allHosts {
		ips := p.Resolved[peer.Name]
		if len(ips) != 1 || ips[0] != peer.IP {
			return fmt.Errorf("名称解析未就绪：%s 解析为 %v，交付要求 %s；请先完成环境准备（设置主机名与 hosts）", peer.Name, ips, peer.IP)
		}
	}
	return nil
}
func (r *executionRunner) probe(h mwpack.Host, local bool, platformID string) error {
	return r.probeWithHosts(h, local, platformID, nil, nil)
}
func (r *executionRunner) probeWithAccess(h mwpack.Host, local bool, platformID string, sshArgs []string) error {
	return r.probeWithHosts(h, local, platformID, sshArgs, nil)
}
func (r *executionRunner) probeWithHosts(h mwpack.Host, local bool, platformID string, sshArgs []string, allHosts []mwpack.Host) error {
	_, e := r.probeDetailed(h, local, platformID, sshArgs, allHosts)
	return e
}
func (r *executionRunner) probeDetailed(h mwpack.Host, local bool, platformID string, sshArgs []string, allHosts []mwpack.Host) (executionProbe, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	names := make([]string, 0, len(allHosts))
	for _, peer := range allHosts {
		if peer.Name != "" {
			names = append(names, peer.Name)
		}
	}
	var cmd *exec.Cmd
	if local {
		argv := append([]string{"-c", executionProbePython}, names...)
		cmd = exec.CommandContext(ctx, "python3", argv...)
	} else {
		script := "python3 -c '" + strings.ReplaceAll(executionProbePython, "'", `'"'"'`) + "'"
		for _, name := range names {
			script += " " + name
		}
		args := []string{"-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=8", "-oConnectionAttempts=1", "-oNumberOfPasswordPrompts=0"}
		args = append(args, sshArgs...)
		args = append(args, "root@"+h.IP, script)
		cmd = exec.CommandContext(ctx, "ssh", args...)
	}
	// The probe is fixed, read-only code. Never run a component's commands here.
	b, e := cmd.CombinedOutput()
	if e != nil {
		if ctx.Err() != nil {
			return executionProbe{}, errors.New("连接检查超时；请检查网络、SSH 服务和授权")
		}
		return executionProbe{}, fmt.Errorf("连接或只读检查失败：%s", truncRunes(strings.TrimSpace(string(b)), 900))
	}
	var p executionProbe
	if json.Unmarshal(b, &p) != nil {
		return executionProbe{}, errors.New("只读检查没有返回有效的机器信息，请检查远端登录脚本和 Python")
	}
	return p, checkExecutionProbeWithHosts(p, h, platformID, allHosts)
}
func fileSHA256(path string) (string, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	defer f.Close()
	h := sha256.New()
	if _, e = io.Copy(h, f); e != nil {
		return "", e
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func checkExecutionMaterials(snap executionSnapshot, root string) error {
	var vars map[string]any
	if e := yaml.Unmarshal(snap.Files["inventory/group_vars/all.yml"], &vars); e != nil {
		return errors.New("交付材料声明不可读")
	}
	upload, _ := vars["mw_upload_dir"].(string)
	var verify func(any) error
	verify = func(v any) error {
		switch x := v.(type) {
		case map[string]any:
			file, _ := x["file"].(string)
			sum, _ := x["sha256"].(string)
			if file != "" && sum != "" {
				if !filepath.IsAbs(upload) || filepath.Base(file) != file {
					return errors.New("材料上传路径不合规")
				}
				path := filepath.Join(upload, file)
				info, e := os.Lstat(path)
				if e != nil || !info.Mode().IsRegular() {
					return fmt.Errorf("缺少材料 %s，请按交付手册上传", path)
				}
				actual, e := fileSHA256(path)
				if e != nil || actual != sum {
					return fmt.Errorf("材料校验失败：%s，请按本交付的校验清单重新传入", file)
				}
			}
			for _, child := range x {
				if e := verify(child); e != nil {
					return e
				}
			}
		case []any:
			for _, child := range x {
				if e := verify(child); e != nil {
					return e
				}
			}
		}
		return nil
	}
	if e := verify(vars["mw_repos"]); e != nil {
		return e
	}
	if e := verify(vars["mw_instances"]); e != nil {
		return e
	}
	// Existing clusters must carry their old secrets before any automatic step.
	if _, change := vars["mw_change"]; change {
		list, _ := vars["mw_secret_list"].([]any)
		for _, v := range list {
			m, _ := v.(map[string]any)
			instance, _ := m["instance"].(string)
			name, _ := m["name"].(string)
			if !safeName(instance) || !executionRelative(name) {
				return errors.New("密码引用不合规")
			}
			b, e := os.ReadFile(filepath.Join(root, "projects", snap.Project, "secrets", instance, name))
			if e != nil || len(b) == 0 {
				return errors.New("尚未沿用集群已有密码，请先完成环境准备中的密码复制；不会重新生成密码")
			}
		}
	}
	return nil
}
func (r *executionRunner) checkPreparation(p executionPreparation) error {
	if !executionID.MatchString(p.ID) || p.Node == "" {
		return errors.New("检查标识不合规")
	}
	// Persist a result before sending; a lost acknowledgement resends the same evidence.
	resultPath := filepath.Join(r.cfg.State, "preparations", p.ID+".json")
	var result struct {
		ID     string           `json:"id"`
		Checks []executionCheck `json:"checks"`
	}
	if b, e := os.ReadFile(resultPath); e == nil {
		if json.Unmarshal(b, &result) != nil {
			return errors.New("本地检查记录不可读")
		}
		return r.call("prepared", result, nil)
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		tick := time.NewTicker(8 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case <-tick.C:
				_ = r.call("poll", map[string]any{"version": version, "protocol": 2, "heartbeat": true}, nil)
			}
		}
	}()
	add := func(id, title, host string, e error) {
		c := executionCheck{ID: id, Title: title, Host: host, State: "passed", Message: "检查通过"}
		if e != nil {
			c.State = "blocked"
			c.Message = truncRunes(e.Error(), 1800)
		}
		result.Checks = append(result.Checks, c)
	}
	result.ID = p.ID
	access, trustHostErrs, trustErr := r.prepareManagedTrustDetailed(p)
	h := mwpack.Host{IP: p.Snapshot.ControllerIP}
	for _, target := range p.Snapshot.Hosts {
		if target.IP == h.IP {
			h.Name = target.Name
		}
	}
	if e := p.Snapshot.ExecutionHost; e != nil {
		h.Name = e.Name
	}
	var identity error
	if !localExecutionIP(h.IP) {
		identity = errors.New("执行器运行的机器与交付指定的执行机器不一致")
	} else {
		identity = r.probeWithHosts(h, true, p.Snapshot.Platform, nil, nil)
	}
	add("executor", "执行机器与系统", h.Name, identity)
	root, runtimeErr := r.matchingRoot(p.Snapshot)
	if runtimeErr == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		cmd := exec.CommandContext(ctx, filepath.Join(root, "bin/ansible-playbook"), "--version")
		cmd.Dir = root
		b, e := cmd.CombinedOutput()
		cancel()
		if e != nil {
			runtimeErr = fmt.Errorf("运行环境尚未安装完成：%s", truncRunes(string(b), 700))
		}
	}
	add("runtime", "交付运行环境与版本", h.Name, runtimeErr)
	if root == "" {
		root = r.cfg.Root
	}
	add("materials", "软件材料与已有凭据", h.Name, checkExecutionMaterials(p.Snapshot, root))
	for _, target := range p.Snapshot.Hosts {
		var e error
		var warns []string
		if p.Snapshot.AgentAccess[target.Name] != "" && trustErr != nil {
			e = trustErr
		} else if he := trustHostErrs[target.Name]; p.Snapshot.AgentAccess[target.Name] != "" && he != nil {
			e = he
		} else {
			args := []string{}
			if a, ok := access[target.Name]; ok {
				args = []string{"-i", a.PrivateKey, "-oIdentitiesOnly=yes", "-oUserKnownHostsFile=" + a.KnownHosts}
			}
			pr, pe := r.probeDetailed(target, target.IP == p.Snapshot.ControllerIP, p.Snapshot.Platform, args, p.Snapshot.Hosts)
			e = pe
			if pe == nil {
				if len(pr.DataDirs) > 0 {
					warns = append(warns, fmt.Sprintf("目标主机 %s (%s) 检测到已有数据目录：%s", target.Name, target.IP, strings.Join(pr.DataDirs, ", ")))
				}
				if len(pr.ActiveServices) > 0 {
					warns = append(warns, fmt.Sprintf("目标主机 %s (%s) 检测到运行中的中间件服务：%s", target.Name, target.IP, strings.Join(pr.ActiveServices, ", ")))
				}
			}
		}
		c := executionCheck{ID: "host:" + target.Name, Title: "连接、身份与运行权限", Host: target.Name, State: "passed", Message: "检查通过", Warnings: warns}
		if e != nil {
			c.State = "blocked"
			c.Message = truncRunes(e.Error(), 1800)
		}
		result.Checks = append(result.Checks, c)
	}
	if e := atomicExecutionJSON(resultPath, result); e != nil {
		return e
	}
	return r.call("prepared", result, nil)
}

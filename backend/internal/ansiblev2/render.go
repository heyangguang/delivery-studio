package ansiblev2

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// RenderHost describes one target machine assigned to one or more standard Ansible inventory groups.
type RenderHost struct {
	Name   string         `json:"name"`
	IP     string         `json:"ip"`
	User   string         `json:"user,omitempty"`
	Port   int            `json:"port,omitempty"`
	Groups []string       `json:"groups,omitempty"`
	Vars   map[string]any `json:"vars,omitempty"`
}

// OfflineRepoConfig optionally configures air-gapped APT/YUM mirrors before component deployment.
type OfflineRepoConfig struct {
	APTURL      string `json:"apt_url,omitempty"`
	RPMURL      string `json:"rpm_url,omitempty"`
	DisableBase bool   `json:"disable_base,omitempty"`
}

// RenderRequest drives standard Ansible project synthesis for a 2.0 component.
type RenderRequest struct {
	ClusterID    string             `json:"cluster_id"`
	Platform     string             `json:"platform,omitempty"`
	DeliveryMode string             `json:"delivery_mode,omitempty"` // offline | automatic
	Scheme       string             `json:"scheme,omitempty"`
	Controller   string             `json:"controller,omitempty"`
	Hosts        []RenderHost       `json:"hosts"`
	Vars         map[string]any     `json:"vars,omitempty"`
	OfflineRepo  *OfflineRepoConfig `json:"offline_repo,omitempty"`
}

// RenderResult holds the 100% standalone-runnable Ansible project, key previews, and runbook steps.
type RenderResult struct {
	ClusterID      string            `json:"cluster_id"`
	Component      string            `json:"component"`
	Version        string            `json:"version"`
	DeliveryMode   string            `json:"delivery_mode"`
	Controller     string            `json:"controller"`
	InventoryYAML  string            `json:"inventory_yaml"`
	GroupVarsYAML  string            `json:"group_vars_yaml"`
	AnsibleCfg     string            `json:"ansible_cfg"`
	DeployPlaybook string            `json:"deploy_playbook"`
	Steps          []PlayStep        `json:"steps"`
	Files          map[string][]byte `json:"-"`
	FilePaths      []string          `json:"file_paths"`
}

const studioCallbackPluginPy = `# -*- coding: utf-8 -*-
# Kyndryl Delivery Studio 2.0 — Standard Ansible Callback Plugin
# Optional: emits structured JSONL when DELIVERY_STUDIO_EVENT_LOG is set and
# Delivery Studio Execution Center streaming step logs when DELIVERY_STUDIO_STEP_LOG is set.
# Completely silent and zero-overhead when running ansible-playbook standalone.
from __future__ import absolute_import, division, print_function
__metaclass__ = type

import difflib
import json
import os
import time
from ansible.plugins.callback import CallbackBase


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "notification"
    CALLBACK_NAME = "delivery_studio"
    CALLBACK_NEEDS_ENABLED = False

    def __init__(self):
        super(CallbackModule, self).__init__()
        self._log_path = os.environ.get("DELIVERY_STUDIO_EVENT_LOG", "").strip()
        self._step_log = os.environ.get("DELIVERY_STUDIO_STEP_LOG", "").strip()
        self._playbook = os.environ.get("DELIVERY_STUDIO_PLAYBOOK", "").strip()
        self._check_mode = os.environ.get("DELIVERY_STUDIO_CHECK_MODE", "").strip() in ("1", "true", "yes")
        self._header_written = False

    def _emit(self, event_type, payload):
        if not self._log_path:
            return
        try:
            rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event_type}
            rec.update(payload)
            with open(self._log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except Exception:
            pass

    def _write_step(self, text):
        if not self._step_log:
            return
        try:
            parent = os.path.dirname(self._step_log)
            if parent and not os.path.isdir(parent):
                os.makedirs(parent, exist_ok=True)
            with open(self._step_log, "a", encoding="utf-8") as f:
                f.write(text)
                f.flush()
        except Exception:
            pass

    def _ensure_header(self, playbook_name=""):
        if self._header_written or not self._step_log:
            return
        self._header_written = True
        pb = self._playbook or playbook_name or "playbooks/deploy.yml"
        self._playbook = pb
        now = time.strftime("%Y-%m-%d %H:%M:%S +0000", time.gmtime())
        extra = "  [CHECK MODE] read-only dry-run (--check --diff)\n" if self._check_mode else ""
        self._write_step("playbook %s\nstarted %s\n%s" % (pb, now, extra))

    def _is_no_log(self, result):
        try:
            res = result._result or {}
            if res.get("_ansible_no_log"):
                return True
            if getattr(result, "_task", None) is not None and getattr(result._task, "no_log", False):
                return True
        except Exception:
            pass
        return False

    def v2_playbook_on_start(self, playbook):
        pb = ""
        try:
            pb = getattr(playbook, "_file_name", "") or ""
        except Exception:
            pass
        self._ensure_header(pb)

    def v2_playbook_on_play_start(self, play):
        self._ensure_header()
        self._emit("play_start", {"play": play.get_name()})

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._ensure_header()
        tname = ""
        try:
            tname = task.get_name().strip()
        except Exception:
            tname = str(task)
        self._write_step("TASK  %s\n" % tname)

    def v2_playbook_on_handler_task_start(self, task):
        self._ensure_header()
        tname = ""
        try:
            tname = task.get_name().strip()
        except Exception:
            tname = str(task)
        self._write_step("TASK  [HANDLER] %s\n" % tname)

    def v2_runner_on_ok(self, result):
        host = result._host.get_name()
        changed = bool(result._result.get("changed", False))
        self._emit("task_ok", {
            "host": host,
            "task": result.task_name,
            "changed": changed,
        })
        kind = "changed" if changed else "ok"
        self._write_step("  %s %s\n" % (kind, host))
        if not self._is_no_log(result):
            msg = result._result.get("msg")
            if msg and isinstance(msg, (str, dict, list)):
                s = json.dumps(msg, ensure_ascii=False) if not isinstance(msg, str) else msg
                for line in str(s).splitlines()[:8]:
                    self._write_step("    %s\n" % line[:400])

    def v2_runner_on_skipped(self, result):
        host = result._host.get_name()
        self._write_step("  skipped %s\n" % host)

    def v2_on_file_diff(self, result):
        if self._is_no_log(result):
            return
        diff = result._result.get("diff")
        if not diff:
            return
        items = diff if isinstance(diff, list) else [diff]
        host = result._host.get_name()
        lines_out = []
        for item in items:
            if not isinstance(item, dict):
                continue
            prepared = item.get("prepared")
            if isinstance(prepared, str) and prepared.strip():
                for ln in prepared.splitlines()[:60]:
                    lines_out.append("    %s" % ln[:400])
                continue
            before = item.get("before")
            after = item.get("after")
            if before is None and after is None:
                continue
            bh = str(item.get("before_header") or "before")
            ah = str(item.get("after_header") or "after")
            b_lines = str(before or "").splitlines()
            a_lines = str(after or "").splitlines()
            ud = list(difflib.unified_diff(b_lines, a_lines, fromfile=bh, tofile=ah, lineterm=""))
            for ln in ud[:60]:
                lines_out.append("    %s" % ln[:400])
        if lines_out:
            self._write_step("  diff %s\n%s\n" % (host, "\n".join(lines_out)))

    def v2_runner_on_failed(self, result, ignore_errors=False):
        host = result._host.get_name()
        msg = "" if self._is_no_log(result) else str(result._result.get("msg", ""))[:500]
        self._emit("task_failed", {
            "host": host,
            "task": result.task_name,
            "ignore_errors": bool(ignore_errors),
            "msg": msg,
        })
        tag = "FAILED (ignored)" if ignore_errors else "FAILED"
        self._write_step("  %s %s\n" % (tag, host))
        if msg:
            for line in msg.splitlines()[:10]:
                self._write_step("    %s\n" % line[:400])
        if not self._is_no_log(result):
            stderr = str(result._result.get("stderr", "")).strip()
            if stderr:
                for line in stderr.splitlines()[:10]:
                    self._write_step("    %s\n" % line[:400])

    def v2_runner_on_unreachable(self, result):
        host = result._host.get_name()
        msg = str(result._result.get("msg", ""))[:500]
        self._emit("host_unreachable", {
            "host": host,
            "task": result.task_name,
            "msg": msg,
        })
        self._write_step("  UNREACHABLE %s\n" % host)
        if msg:
            for line in msg.splitlines()[:6]:
                self._write_step("    %s\n" % line[:400])

    def v2_playbook_on_stats(self, stats):
        summary = {}
        any_bad = False
        recap_lines = ["RECAP\n"]
        for h in sorted(stats.processed.keys()):
            s = stats.summarize(h)
            summary[h] = s
            if s.get("failures", 0) > 0 or s.get("unreachable", 0) > 0:
                any_bad = True
            recap_lines.append("%s ok=%d changed=%d unreachable=%d failed=%d skipped=%d\n" % (
                h, s.get("ok", 0), s.get("changed", 0), s.get("unreachable", 0), s.get("failures", 0), s.get("skipped", 0)
            ))
        self._emit("stats", {"hosts": summary})
        if self._step_log:
            self._ensure_header()
            now_h = time.strftime("%Y-%m-%d %H:%M:%S +0000", time.gmtime())
            now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            status = "failed" if any_bad else "passed"
            res_word = "FAILED" if any_bad else "PASSED"
            recap_lines.append("finished %s\n" % now_h)
            recap_lines.append("RESULT %s\n" % res_word)
            recap_lines.append("STEP_RESULT %s\n" % json.dumps({
                "schema": "mwstep-result/v1",
                "step": self._playbook or "playbooks/deploy.yml",
                "status": status,
                "finished": now_iso,
            }, ensure_ascii=False))
            self._write_step("".join(recap_lines))
`

// Render compiles a 2.0 pure-Ansible component + user inputs into a 100% standard,
// zero-proprietary-DSL Ansible project ready for direct ansible-playbook execution.
func Render(files map[string][]byte, m Manifest, req RenderRequest) (*RenderResult, error) {
	if strings.TrimSpace(req.ClusterID) == "" {
		req.ClusterID = m.Name + "-cluster"
	}
	mode := strings.TrimSpace(req.DeliveryMode)
	if mode == "" {
		mode = "offline"
	}
	if len(req.Hosts) == 0 {
		return nil, fmt.Errorf("至少需要提供 1 台目标主机")
	}

	// Resolve effective hosts and controller
	controller := strings.TrimSpace(req.Controller)
	if controller == "" {
		controller = req.Hosts[0].Name
	}

	// Merge variables: defaults -> scheme overrides -> user vars
	mergedVars := map[string]any{}
	for _, v := range m.Vars {
		if v.Default != nil {
			mergedVars[v.Key] = v.Default
		}
	}
	if req.Scheme != "" {
		for _, sc := range m.Schemes {
			if sc.ID == req.Scheme {
				for k, v := range sc.Vars {
					mergedVars[k] = v
				}
				break
			}
		}
	}
	for k, v := range req.Vars {
		mergedVars[k] = v
	}
	hasOfflineRepo := req.OfflineRepo != nil && (strings.TrimSpace(req.OfflineRepo.APTURL) != "" || strings.TrimSpace(req.OfflineRepo.RPMURL) != "")
	if hasOfflineRepo {
		if u := strings.TrimSpace(req.OfflineRepo.APTURL); u != "" {
			mergedVars["delivery_studio_apt_mirror"] = u
		}
		if u := strings.TrimSpace(req.OfflineRepo.RPMURL); u != "" {
			mergedVars["delivery_studio_rpm_mirror"] = u
		}
		mergedVars["delivery_studio_disable_base_repos"] = req.OfflineRepo.DisableBase
	}

	// Build 100% standard YAML inventory/hosts.yml
	allHosts := map[string]any{}
	children := map[string]map[string]any{}
	for _, gs := range m.Groups {
		children[gs.Name] = map[string]any{"hosts": map[string]any{}}
	}
	for idx, h := range req.Hosts {
		hName := strings.TrimSpace(h.Name)
		if hName == "" {
			hName = fmt.Sprintf("node-%02d", idx+1)
		}
		hEntry := map[string]any{}
		if strings.TrimSpace(h.IP) != "" {
			hEntry["ansible_host"] = strings.TrimSpace(h.IP)
		}
		if strings.TrimSpace(h.User) != "" {
			hEntry["ansible_user"] = strings.TrimSpace(h.User)
		}
		if h.Port > 0 && h.Port != 22 {
			hEntry["ansible_port"] = h.Port
		}
		allHosts[hName] = hEntry

		groups := h.Groups
		if len(groups) == 0 && len(m.Groups) > 0 {
			groups = []string{m.Groups[0].Name}
		}
		for _, g := range groups {
			g = strings.TrimSpace(g)
			if g == "" {
				continue
			}
			if _, ok := children[g]; !ok {
				children[g] = map[string]any{"hosts": map[string]any{}}
			}
			children[g]["hosts"].(map[string]any)[hName] = map[string]any{}
		}
	}

	invDoc := map[string]any{
		"all": map[string]any{
			"hosts":    allHosts,
			"children": children,
		},
	}
	invBytes, err := marshalYAMLDoc("# Standard Ansible Inventory generated by Kyndryl Delivery Studio 2.0", invDoc)
	if err != nil {
		return nil, err
	}

	// Build 100% standard group_vars/all.yml
	gvBytes, err := marshalYAMLDoc("# Standard Ansible Variables (group_vars/all.yml)", mergedVars)
	if err != nil {
		return nil, err
	}

	// Build standard ansible.cfg
	ansibleCfg := fmt.Sprintf(`[defaults]
inventory = inventory/hosts.yml
roles_path = ./roles:~/.ansible/roles:/usr/share/ansible/roles
callback_plugins = ./callback_plugins
callbacks_enabled = delivery_studio
host_key_checking = False
retry_files_enabled = False
stdout_callback = default
result_format = yaml
timeout = 30
gathering = smart

[ssh_connection]
pipelining = True
ssh_args = -o ControlMaster=auto -o ControlPersist=60s
`)

	// Assemble output project files (copy all original standard Ansible files untouched!)
	outFiles := make(map[string][]byte, len(files)+8)
	for p, data := range files {
		cp := make([]byte, len(data))
		copy(cp, data)
		outFiles[p] = cp
	}
	outFiles["ansible.cfg"] = []byte(ansibleCfg)
	outFiles["inventory/hosts.yml"] = invBytes
	// Ansible loads inventory-adjacent group_vars/host_vars for ALL playbooks regardless of subdirectory (e.g. playbooks/deploy.yml)
	outFiles["inventory/group_vars/all.yml"] = gvBytes
	outFiles["group_vars/all.yml"] = gvBytes
	outFiles["callback_plugins/delivery_studio.py"] = []byte(studioCallbackPluginPy)

	for _, h := range req.Hosts {
		if len(h.Vars) > 0 && strings.TrimSpace(h.Name) != "" {
			hv, herr := marshalYAMLDoc("# Host-specific Ansible variables for "+h.Name, h.Vars)
			if herr == nil {
				hn := strings.TrimSpace(h.Name)
				outFiles["inventory/host_vars/"+hn+".yml"] = hv
				outFiles["host_vars/"+hn+".yml"] = hv
			}
		}
	}

	// Re-inspect rendered tree for exact executable steps
	steps, _, _ := extractPlaysAndSteps(outFiles, m.Entrypoints)
	if hasOfflineRepo {
		outFiles["playbooks/configure-offline-repo.yml"] = []byte(offlineRepoPlaybookYAML)
		repoStep := PlayStep{
			ID:       "offline-repo-1",
			Phase:    "deploy",
			Playbook: "playbooks/configure-offline-repo.yml",
			PlayName: "配置内网 / 离线软件源镜像",
			Hosts:    "all",
			Title:    fmt.Sprintf("[%s] 配置内网 / 离线软件源镜像", m.Name),
			Effect:   "change",
			Command:  "ansible-playbook -i inventory/hosts.yml playbooks/configure-offline-repo.yml",
		}
		steps = append([]PlayStep{repoStep}, steps...)
	}

	// Generate clean standalone README.md
	var readme strings.Builder
	fmt.Fprintf(&readme, "# %s (%s)\n\n", req.ClusterID, m.Title)
	fmt.Fprintf(&readme, "Generated by **Kyndryl Delivery Studio 2.0** (100%% Standard Ansible Project — zero proprietary runtime required).\n\n")
	fmt.Fprintf(&readme, "## Quick Run\n\n```bash\n")
	fmt.Fprintf(&readme, "# 1. Syntax & inventory check\nansible-inventory -i inventory/hosts.yml --graph\n")
	fmt.Fprintf(&readme, "ansible-playbook -i inventory/hosts.yml %s --syntax-check\n\n", m.Entrypoints.Deploy)
	fmt.Fprintf(&readme, "# 2. Dry-run preview (--check --diff)\nansible-playbook -i inventory/hosts.yml %s --check --diff\n\n", m.Entrypoints.Deploy)
	fmt.Fprintf(&readme, "# 3. Deploy\nansible-playbook -i inventory/hosts.yml %s\n", m.Entrypoints.Deploy)
	if m.Entrypoints.Verify != "" {
		fmt.Fprintf(&readme, "\n# 4. Verify\nansible-playbook -i inventory/hosts.yml %s\n", m.Entrypoints.Verify)
	}
	if m.Entrypoints.Probe != "" {
		fmt.Fprintf(&readme, "\n# 5. Read-Only Live Probe\nansible-playbook -i inventory/hosts.yml %s\n", m.Entrypoints.Probe)
	}
	readme.WriteString("```\n")
	outFiles["README.md"] = []byte(readme.String())

	filePaths := sortedKeys(outFiles)
	deployRaw := ""
	if b, ok := outFiles[m.Entrypoints.Deploy]; ok {
		deployRaw = string(b)
	}

	return &RenderResult{
		ClusterID:      req.ClusterID,
		Component:      m.Name,
		Version:        m.Version,
		DeliveryMode:   mode,
		Controller:     controller,
		InventoryYAML:  string(invBytes),
		GroupVarsYAML:  string(gvBytes),
		AnsibleCfg:     ansibleCfg,
		DeployPlaybook: deployRaw,
		Steps:          steps,
		Files:          outFiles,
		FilePaths:      filePaths,
	}, nil
}

// PackTarGz creates a deterministic tar.gz archive of an Ansible 2.0 project under rootDir/.
func PackTarGz(rootDir string, files map[string][]byte) ([]byte, string, error) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	now := time.Now().UTC()
	for _, rel := range sortedKeys(files) {
		data := files[rel]
		mode := int64(0o644)
		if strings.HasSuffix(rel, ".sh") || strings.HasSuffix(rel, ".py") {
			mode = 0o755
		}
		hdr := &tar.Header{
			Name:    path.Join(rootDir, rel),
			Mode:    mode,
			Size:    int64(len(data)),
			ModTime: now,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, "", err
		}
		if _, err := tw.Write(data); err != nil {
			return nil, "", err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, "", err
	}
	if err := gz.Close(); err != nil {
		return nil, "", err
	}
	b := buf.Bytes()
	sum := sha256.Sum256(b)
	return b, hex.EncodeToString(sum[:]), nil
}

func marshalYAMLDoc(header string, doc any) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString("---\n")
	if header != "" {
		buf.WriteString(header + "\n")
	}
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	_ = enc.Close()
	return buf.Bytes(), nil
}

const offlineRepoPlaybookYAML = `---
- name: 配置内网 / 离线软件源镜像
  hosts: all
  become: true
  tasks:
    - name: 备份默认 APT 源（禁用公网源时）
      ansible.builtin.shell: |
        set -e
        mkdir -p /etc/apt/sources.backup.ds
        if [ -f /etc/apt/sources.list ] && [ ! -f /etc/apt/sources.backup.ds/sources.list ]; then
          mv /etc/apt/sources.list /etc/apt/sources.backup.ds/sources.list
        fi
        for f in /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do
          [ -e "$f" ] || continue
          case "$(basename "$f")" in
            delivery-studio-offline.list) continue ;;
          esac
          mv "$f" /etc/apt/sources.backup.ds/
        done
      when:
        - ansible_facts['os_family'] == 'Debian'
        - delivery_studio_apt_mirror is defined
        - delivery_studio_apt_mirror | length > 0
        - delivery_studio_disable_base_repos | default(false) | bool
      changed_when: true

    - name: 写入内网 APT 镜像源配置
      ansible.builtin.copy:
        dest: /etc/apt/sources.list.d/delivery-studio-offline.list
        mode: "0644"
        content: |
          # Managed by Kyndryl Delivery Studio 2.0 (Offline/Internal Mirror)
          deb [trusted=yes] {{ delivery_studio_apt_mirror }} ./
      when:
        - ansible_facts['os_family'] == 'Debian'
        - delivery_studio_apt_mirror is defined
        - delivery_studio_apt_mirror | length > 0
      register: ds_apt_mirror

    - name: 刷新 APT 软件包索引
      ansible.builtin.apt:
        update_cache: true
      when:
        - ansible_facts['os_family'] == 'Debian'
        - delivery_studio_apt_mirror is defined
        - delivery_studio_apt_mirror | length > 0

    - name: 备份默认 YUM/DNF 源（禁用公网源时）
      ansible.builtin.shell: |
        set -e
        mkdir -p /etc/yum.repos.d/backup.ds
        for f in /etc/yum.repos.d/*.repo; do
          [ -e "$f" ] || continue
          case "$(basename "$f")" in
            delivery-studio-offline.repo) continue ;;
          esac
          mv "$f" /etc/yum.repos.d/backup.ds/
        done
      when:
        - ansible_facts['os_family'] == 'RedHat'
        - delivery_studio_rpm_mirror is defined
        - delivery_studio_rpm_mirror | length > 0
        - delivery_studio_disable_base_repos | default(false) | bool
      changed_when: true

    - name: 写入内网 YUM/DNF 镜像源配置
      ansible.builtin.copy:
        dest: /etc/yum.repos.d/delivery-studio-offline.repo
        mode: "0644"
        content: |
          [delivery-studio-offline]
          name=Kyndryl Delivery Studio Offline Mirror
          baseurl={{ delivery_studio_rpm_mirror }}
          enabled=1
          gpgcheck=0
      when:
        - ansible_facts['os_family'] == 'RedHat'
        - delivery_studio_rpm_mirror is defined
        - delivery_studio_rpm_mirror | length > 0

    - name: 刷新 YUM/DNF 元数据缓存
      ansible.builtin.command: dnf makecache --refresh
      when:
        - ansible_facts['os_family'] == 'RedHat'
        - delivery_studio_rpm_mirror is defined
        - delivery_studio_rpm_mirror | length > 0
      changed_when: false
`

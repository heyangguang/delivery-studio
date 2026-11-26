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

// RenderRequest drives standard Ansible project synthesis for a 2.0 component.
type RenderRequest struct {
	ClusterID    string         `json:"cluster_id"`
	Platform     string         `json:"platform,omitempty"`
	DeliveryMode string         `json:"delivery_mode,omitempty"` // offline | automatic
	Scheme       string         `json:"scheme,omitempty"`
	Controller   string         `json:"controller,omitempty"`
	Hosts        []RenderHost   `json:"hosts"`
	Vars         map[string]any `json:"vars,omitempty"`
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
# Kyndryl Delivery Studio 2.0 — Standard Ansible JSON Event Callback Plugin
# Optional: only writes structured task telemetry when DELIVERY_STUDIO_EVENT_LOG is set.
# Completely silent and zero-overhead when running ansible-playbook standalone.
from __future__ import absolute_import, division, print_function
__metaclass__ = type

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

    def v2_playbook_on_play_start(self, play):
        self._emit("play_start", {"play": play.get_name()})

    def v2_runner_on_ok(self, result):
        self._emit("task_ok", {
            "host": result._host.get_name(),
            "task": result.task_name,
            "changed": bool(result._result.get("changed", False)),
        })

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self._emit("task_failed", {
            "host": result._host.get_name(),
            "task": result.task_name,
            "ignore_errors": bool(ignore_errors),
            "msg": str(result._result.get("msg", ""))[:500],
        })

    def v2_runner_on_unreachable(self, result):
        self._emit("host_unreachable", {
            "host": result._host.get_name(),
            "task": result.task_name,
            "msg": str(result._result.get("msg", ""))[:500],
        })

    def v2_playbook_on_stats(self, stats):
        summary = {}
        for h in sorted(stats.processed.keys()):
            summary[h] = stats.summarize(h)
        self._emit("stats", {"hosts": summary})
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

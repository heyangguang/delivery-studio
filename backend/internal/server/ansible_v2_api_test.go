package server

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestAnsibleV2APIInspectImportPreviewDeliverAndRBAC(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")

	// 1. List built-in 2.0 pure-Ansible benchmark components
	w := storeRequest(s, "GET", "/api/v2/ansible/components", nil, admin, "")
	if w.Code != 200 {
		t.Fatalf("list v2 components failed: %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"redis-native"`) || !strings.Contains(w.Body.String(), `"nginx-native"`) {
		t.Fatalf("expected builtin redis-native and nginx-native, got %s", w.Body.String())
	}

	// 2. Auditor must be denied writing/importing v2 components
	if rw := storeRequest(s, "PUT", "/api/users/bob/grant", strings.NewReader(`{"roles":["auditor"]}`), admin, csrf); rw.Code != 200 {
		t.Fatalf("grant auditor failed: %d", rw.Code)
	}
	bob, bcsrf := storeLogin(t, s, "bob")
	if rw := storeRequest(s, "POST", "/api/v2/ansible/import", strings.NewReader(`{}`), bob, bcsrf); rw.Code != 403 {
		t.Fatalf("expected auditor 403 on v2 import, got %d", rw.Code)
	}

	// 3. Inspect a single pasted Playbook YAML
	inspectBody, _ := json.Marshal(map[string]any{
		"mode":     "yaml",
		"name":     "demo-exporter",
		"filename": "node-exporter.yml",
		"content": `---
- name: Deploy Node Exporter
  hosts: exporters
  become: true
  tasks:
    - name: Install node exporter
      ansible.builtin.package:
        name: prometheus-node-exporter
        state: present
`,
	})
	w = storeRequest(s, "POST", "/api/v2/ansible/inspect", bytes.NewReader(inspectBody), admin, csrf)
	if w.Code != 200 {
		t.Fatalf("inspect failed: %d %s", w.Code, w.Body.String())
	}
	var inspResp struct {
		Report struct {
			AssetKind    string `json:"asset_kind"`
			ManifestYAML string `json:"manifest_yaml"`
			Valid        bool   `json:"valid"`
		} `json:"report"`
		Files []fileView `json:"files"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &inspResp); err != nil || !inspResp.Report.Valid || inspResp.Report.AssetKind != "single_playbook" {
		t.Fatalf("unexpected inspect response: err=%v body=%s", err, w.Body.String())
	}

	// 4. Import inspected component
	fileMap := map[string]string{}
	for _, f := range inspResp.Files {
		fileMap[f.Path] = f.Text
	}
	importBody, _ := json.Marshal(map[string]any{
		"name":          "demo-exporter",
		"source":        "paste:node-exporter.yml",
		"manifest_yaml": inspResp.Report.ManifestYAML,
		"files":         fileMap,
	})
	w = storeRequest(s, "POST", "/api/v2/ansible/import", bytes.NewReader(importBody), admin, csrf)
	if w.Code != 201 {
		t.Fatalf("import failed: %d %s", w.Code, w.Body.String())
	}

	// 5. Preview standard Ansible inventory & group_vars rendering
	previewBody := `{"cluster_id":"prod-exp","hosts":[{"name":"exp-01","ip":"10.10.0.11","groups":["exporters"]}],"vars":{"exporter_port":9100}}`
	w = storeRequest(s, "POST", "/api/v2/ansible/components/demo-exporter/preview", strings.NewReader(previewBody), admin, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "ansible_host: 10.10.0.11") || !strings.Contains(w.Body.String(), "exporter_port: 9100") {
		t.Fatalf("preview failed: %d %s", w.Code, w.Body.String())
	}

	// 6. Generate real Delivery Studio delivery job from 2.0 component
	w = storeRequest(s, "POST", "/api/v2/ansible/components/demo-exporter/deliver", strings.NewReader(previewBody), admin, csrf)
	if w.Code != 201 {
		t.Fatalf("deliver failed: %d %s", w.Code, w.Body.String())
	}
	var delivResp struct {
		JobID     string `json:"job_id"`
		ClusterID string `json:"cluster_id"`
		Archive   string `json:"archive"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &delivResp)
	if delivResp.JobID == "" || delivResp.ClusterID != "prod-exp" {
		t.Fatalf("unexpected deliver resp: %s", w.Body.String())
	}

	// Confirm job and plan.json are readable via standard /api/jobs/{id}
	w = storeRequest(s, "GET", "/api/jobs/"+delivResp.JobID, nil, admin, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "prod-exp-ansible-v2.tar.gz") {
		t.Fatalf("created v2 job not readable via /api/jobs: %d %s", w.Code, w.Body.String())
	}

	// 7. Delete custom imported component cleanly
	w = storeRequest(s, "DELETE", "/api/v2/ansible/components/demo-exporter", nil, admin, csrf)
	if w.Code != 200 {
		t.Fatalf("delete custom v2 component failed: %d %s", w.Code, w.Body.String())
	}

	// 8. Verify Automated 2.0 Execution Snapshot + Choices + Native AI Toolset
	autoDeliverBody := `{
		"cluster_id": "nginx-v2-auto",
		"delivery_mode": "automatic",
		"scheme": "single",
		"execution_host": {"name": "ctrl-01", "ip": "10.10.0.10"},
		"hosts": [{"name": "web-01", "ip": "10.10.0.11", "groups": ["nginx"]}],
		"vars": {"nginx_listen_port": 8088}
	}`
	w = storeRequest(s, "POST", "/api/v2/ansible/components/nginx-native/deliver", strings.NewReader(autoDeliverBody), admin, csrf)
	if w.Code != 201 {
		t.Fatalf("auto deliver failed: %d %s", w.Code, w.Body.String())
	}
	var autoResp struct {
		JobID string `json:"job_id"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &autoResp)
	s.mu.Lock()
	autoJob := s.jobs[autoResp.JobID]
	s.mu.Unlock()
	snap, err := s.executionSnapshotFor(autoJob)
	if err != nil {
		t.Fatalf("executionSnapshotFor studio/v2 failed: %v", err)
	}
	if snap.Schema != "studio/v2" || snap.ControllerIP != "10.10.0.10" || len(snap.Files["inventory/hosts.yml"]) == 0 || len(snap.Files["inventory/group_vars/all.yml"]) == 0 {
		t.Fatalf("unexpected v2 snapshot: schema=%s ctrl=%s files=%d", snap.Schema, snap.ControllerIP, len(snap.Files))
	}
	choices := s.executionChoices(autoJob.ID)
	availCount := 0
	for _, c := range choices {
		if c.Available {
			availCount++
		}
	}
	if availCount < 2 {
		t.Fatalf("expected automated v2 steps to be available in Execution Center, got %+v", choices)
	}
	for _, c := range choices {
		if c.Available && (len(c.Hosts) != 1 || c.Hosts[0] != "web-01") {
			t.Fatalf("expected automated step target hosts to resolve to [web-01], not controller; got %+v", c)
		}
	}

	// 9. Verify Native Ansible 2.0 AI Tools (list, inspect, validate, save + auditor RBAC denial)
	listOut := s.runAnsibleV2AITool("admin", "list_ansible_v2_components", `{}`)
	if !strings.Contains(listOut, `"postgresql-native"`) || !strings.Contains(listOut, `"etcd-native"`) {
		t.Fatalf("expected all 6 builtins in AI list tool, got %s", listOut)
	}
	inspOut := s.runAnsibleV2AITool("admin", "inspect_ansible_v2_component", `{"name":"nginx-native","file":"playbooks/deploy.yml"}`)
	if !strings.Contains(inspOut, "role: nginx") {
		t.Fatalf("unexpected AI inspect file output: %s", inspOut)
	}
	aiSaveArgs := `{"name":"ai-caddy","files":{"playbooks/deploy.yml":"---\n- name: Deploy Caddy\n  hosts: web\n  become: true\n  tasks:\n    - name: Install caddy\n      ansible.builtin.package:\n        name: caddy\n        state: present\n"}}`
	if denied := s.runAnsibleV2AITool("bob", "save_ansible_v2_component", aiSaveArgs); !strings.Contains(denied, "权限") {
		t.Fatalf("expected auditor permission denial on AI save tool, got: %s", denied)
	}
	savedOut := s.runAnsibleV2AITool("admin", "save_ansible_v2_component", aiSaveArgs)
	if !strings.Contains(savedOut, `"saved": true`) {
		t.Fatalf("expected admin AI save tool to succeed, got: %s", savedOut)
	}
}

package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnsibleV2ClassicWizardBridgeAndDynamicForm(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")

	// 1. /api/v2/ansible/catalog exposes all 8 built-in 2.0 components in AppInfo format
	w := storeRequest(s, "GET", "/api/v2/ansible/catalog", nil, admin, "")
	if w.Code != 200 {
		t.Fatalf("GET /api/v2/ansible/catalog status=%d body=%s", w.Code, w.Body.String())
	}
	var catEntries []struct {
		ID        string `json:"id"`
		Available bool   `json:"available"`
		Plans     []struct {
			ID string `json:"id"`
		} `json:"plans"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &catEntries); err != nil {
		t.Fatalf("decode v2 catalog: %v", err)
	}
	byID := map[string]bool{}
	for _, e := range catEntries {
		byID[e.ID] = e.Available
	}
	for _, want := range []string{"patroni-native", "postgresql-native", "redis-native", "etcd-native", "nginx-native", "haproxy-native", "keepalived-native", "external-lb-native"} {
		if !byID[want] {
			t.Fatalf("expected %s available in /api/v2/ansible/catalog, got %+v", want, byID)
		}
	}

	// 2. /api/components/patroni-native dynamically generates Wizard Schema with AST when conditions
	w = storeRequest(s, "GET", "/api/components/patroni-native", nil, admin, "")
	if w.Code != 200 {
		t.Fatalf("GET /api/components/patroni-native status=%d body=%s", w.Code, w.Body.String())
	}
	var sc struct {
		Component string `json:"component"`
		Params    []struct {
			Key  string `json:"key"`
			Type string `json:"type"`
			When string `json:"when"`
		} `json:"params"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &sc); err != nil {
		t.Fatalf("decode patroni-native schema: %v", err)
	}
	paramWhen := map[string]string{}
	for _, p := range sc.Params {
		paramWhen[p.Key] = p.When
	}
	if paramWhen["patroni_external_etcd_hosts"] != "group.etcd == 0" {
		t.Fatalf("expected group.etcd == 0 for patroni_external_etcd_hosts, got %q", paramWhen["patroni_external_etcd_hosts"])
	}
	if paramWhen["patroni_synchronous_commit"] != "params.patroni_synchronous_mode" {
		t.Fatalf("expected params.patroni_synchronous_mode for patroni_synchronous_commit, got %q", paramWhen["patroni_synchronous_commit"])
	}

	// 3. POST /api/resolve evaluates visibility dynamically based on placement & params
	resolveBody := `{
		"schema": "mwdeploy/v1",
		"id": "patroni-wiz-test",
		"platform": "ubuntu-24.04-amd64",
		"delivery_mode": "offline",
		"hosts": [
			{"name": "node-01", "ip": "10.20.0.11"},
			{"name": "node-02", "ip": "10.20.0.12"}
		],
		"instances": [{
			"id": "patroni",
			"component": "patroni-native",
			"version": "3.2",
			"placement": {"patroni": ["node-01", "node-02"], "etcd": []},
			"params": {"patroni_synchronous_mode": true, "patroni_external_etcd_hosts": "10.20.0.50:2379"}
		}]
	}`
	w = storeRequest(s, "POST", "/api/resolve", strings.NewReader(resolveBody), admin, csrf)
	if w.Code != 200 {
		t.Fatalf("POST /api/resolve status=%d body=%s", w.Code, w.Body.String())
	}
	var resPayload struct {
		Plan struct {
			OK        bool `json:"ok"`
			Instances []struct {
				Visible map[string]bool `json:"visible"`
			} `json:"instances"`
		} `json:"plan"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resPayload); err != nil {
		t.Fatalf("decode resolve: %v", err)
	}
	if !resPayload.Plan.OK || len(resPayload.Plan.Instances) != 1 {
		t.Fatalf("expected OK plan for patroni-native resolve, got %s", w.Body.String())
	}
	vis := resPayload.Plan.Instances[0].Visible
	if !vis["patroni_external_etcd_hosts"] || !vis["patroni_synchronous_commit"] {
		t.Fatalf("expected conditional vars visible, got %+v", vis)
	}

	// 4. POST /api/jobs creates a real offline Ansible 2.0 delivery via classic Wizard endpoint
	var mpBuf bytes.Buffer
	mw := multipart.NewWriter(&mpBuf)
	_ = mw.WriteField("request", `{"deployment":`+resolveBody+`}`)
	_ = mw.Close()
	mpReq := httptest.NewRequest("POST", s.cfg.PublicURL+"/api/jobs", &mpBuf)
	mpReq.Header.Set("Content-Type", mw.FormDataContentType())
	mpReq.Header.Set("Origin", s.cfg.PublicURL)
	mpReq.Header.Set("X-CSRF-Token", csrf)
	mpReq.AddCookie(admin)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, mpReq)
	if w.Code != 201 {
		t.Fatalf("POST /api/jobs for patroni-native status=%d body=%s", w.Code, w.Body.String())
	}
	var createdJob storeJob
	if err := json.Unmarshal(w.Body.Bytes(), &createdJob); err != nil {
		t.Fatalf("decode created job: %v", err)
	}
	if createdJob.AppID != "patroni-native" || createdJob.ClusterID != "patroni-wiz-test" || createdJob.DeliveryMode != "offline" {
		t.Fatalf("unexpected created 2.0 job: %+v", createdJob)
	}

	// 5. Importing a custom Ansible playbook with brand-new vars immediately exposes them in /api/components/<name>
	importReq := `{
		"name": "custom-dyn-app",
		"source": "paste:deploy.yml",
		"files": {
			"playbooks/deploy.yml": "---\n- name: Deploy Dynamic App\n  hosts: workers\n  vars:\n    dyn_custom_port: 9191\n    dyn_enable_tls: false\n    dyn_tls_cert_path: /etc/ssl/dyn.crt\n  tasks:\n    - name: Write cert\n      ansible.builtin.copy:\n        content: ok\n        dest: \"{{ dyn_tls_cert_path }}\"\n      when: dyn_enable_tls | bool\n"
		}
	}`
	w = storeRequest(s, "POST", "/api/v2/ansible/import", strings.NewReader(importReq), admin, csrf)
	if w.Code != 201 {
		t.Fatalf("POST /api/v2/ansible/import status=%d body=%s", w.Code, w.Body.String())
	}
	w = storeRequest(s, "GET", "/api/components/custom-dyn-app", nil, admin, "")
	if w.Code != 200 {
		t.Fatalf("GET /api/components/custom-dyn-app status=%d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"key":"dyn_custom_port"`) || !strings.Contains(w.Body.String(), `"when":"params.dyn_enable_tls"`) {
		t.Fatalf("expected dynamically inferred vars in /api/components/custom-dyn-app, got %s", w.Body.String())
	}

	// 6. GET /api/clusters/import/presets includes 2.0 native components for adoption
	w = storeRequest(s, "GET", "/api/clusters/import/presets", nil, admin, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"id":"patroni-native"`) || !strings.Contains(w.Body.String(), `"id":"redis-native"`) {
		t.Fatalf("expected 2.0 components in import presets, status=%d", w.Code)
	}

	// 7. Deterministic probe parser for postgresql-native skips Ubuntu /etc/os-release VERSION="24.04" and extracts PostgreSQL 16
	parseBody := `{"component":"postgresql-native","source_kind":"probe","use_ai":false,"text":"=== MW_IMPORT_OS ===\nPRETTY_NAME=\"Ubuntu 24.04.5 LTS\"\nVERSION=\"24.04.5 LTS (Noble Numbat)\"\nVERSION_ID=\"24.04\"\n=== MW_IMPORT_MIDDLEWARE ===\npsql (PostgreSQL) 16.11 (Ubuntu 16.11-0ubuntu0.24.04.1)\n"}`
	w = storeRequest(s, "POST", "/api/clusters/import/parse", strings.NewReader(parseBody), admin, csrf)
	if w.Code != 200 {
		t.Fatalf("POST /api/clusters/import/parse status=%d body=%s", w.Code, w.Body.String())
	}
	var parseResp struct {
		Draft importParseDraft `json:"draft"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &parseResp); err != nil {
		t.Fatalf("decode parse resp: %v", err)
	}
	if parseResp.Draft.Version != "16" || parseResp.Draft.ExactVersion != "16.11" {
		t.Fatalf("expected postgresql-native version 16 (16.11), got version=%q exact=%q", parseResp.Draft.Version, parseResp.Draft.ExactVersion)
	}
}

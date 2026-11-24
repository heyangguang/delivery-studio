package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"middleware-deployer/mwpack"
)

func TestClusterImportPresetsAndReadOnlyProbe(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")

	// 1. Presets endpoint returns both catalog components and 30+ non-catalog presets
	w := storeRequest(s, "GET", "/api/clusters/import/presets", nil, alice, "")
	if w.Code != 200 {
		t.Fatalf("GET presets failed: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		Catalog   []importPresetItem `json:"catalog"`
		Presets   []importPresetItem `json:"presets"`
		Platforms []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"platforms"`
		Icons []string `json:"icons"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Catalog) < 5 || len(resp.Presets) < 25 {
		t.Fatalf("expected >=5 catalog and >=25 presets, got catalog=%d presets=%d", len(resp.Catalog), len(resp.Presets))
	}
	if len(resp.Platforms) == 0 || len(resp.Icons) < 20 {
		t.Fatalf("expected platforms & icons populated, got %d / %d", len(resp.Platforms), len(resp.Icons))
	}

	// 2. Every single built-in preset's generated read-only probe script must pass static read-only validation!
	for _, pr := range mwpack.ImportPresets {
		body, _ := json.Marshal(importProbeScriptReq{
			Component:    pr.ID,
			DisplayName:  pr.Name,
			DeployMethod: "systemd",
		})
		pw := storeRequest(s, "POST", "/api/clusters/import/probe-script", bytes.NewReader(body), alice, csrf)
		if pw.Code != 200 {
			t.Fatalf("probe-script for %s failed: %d %s", pr.ID, pw.Code, pw.Body.String())
		}
		var ps struct {
			Script   string   `json:"script"`
			Filename string   `json:"filename"`
			Safe     bool     `json:"safe"`
			Warnings []string `json:"warnings"`
		}
		if err := json.Unmarshal(pw.Body.Bytes(), &ps); err != nil {
			t.Fatal(err)
		}
		if !ps.Safe || len(ps.Warnings) > 0 {
			t.Errorf("probe-script for %s failed static read-only validation: safe=%v warns=%v", pr.ID, ps.Safe, ps.Warnings)
		}
		if !strings.Contains(ps.Script, "=== MW_IMPORT_BEGIN ===") {
			t.Errorf("probe-script for %s missing structured markers", pr.ID)
		}
	}
}

func TestClusterImportDeterministicParseAndEndToEndLifecycle(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")

	// 1. Parse multi-node read-only probe output deterministically (AI disabled by default in testStore)
	probeOut := `=== MW_IMPORT_BEGIN ===
PROBE_COMPONENT=mysql
=== MW_IMPORT_HOST ===
HOSTNAME=mysql-n1
IPS=10.50.1.11 127.0.0.1
=== MW_IMPORT_OS ===
PRETTY_NAME="Ubuntu 24.04.1 LTS"
=== MW_IMPORT_HOSTS_FILE ===
10.50.1.11 mysql-n1 primary
10.50.1.12 mysql-n2 replica
=== MW_IMPORT_MIDDLEWARE ===
--- [MYSQL] ---
mysqld  Ver 8.0.36-0ubuntu0.24.04.1 for Linux on x86_64
# file: /etc/mysql/mysql.conf.d/mysqld.cnf
mysql.service loaded active running MySQL Community Server
=== MW_IMPORT_PACKAGES ===
mysql-server-8.0	8.0.36-0ubuntu0.24.04.1
mysql-client-8.0	8.0.36-0ubuntu0.24.04.1
=== MW_IMPORT_END ===`

	parseBody, _ := json.Marshal(importParseReq{
		Component:  "mysql",
		SourceKind: "probe",
		Text:       probeOut,
	})
	pw := storeRequest(s, "POST", "/api/clusters/import/parse", bytes.NewReader(parseBody), alice, csrf)
	if pw.Code != 200 {
		t.Fatalf("parse failed: %d %s", pw.Code, pw.Body.String())
	}
	var parsed struct {
		Draft  importParseDraft `json:"draft"`
		Parser string           `json:"parser"`
	}
	if err := json.Unmarshal(pw.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Parser != "deterministic" {
		t.Fatalf("expected deterministic parser, got %q", parsed.Parser)
	}
	if len(parsed.Draft.Hosts) != 2 || parsed.Draft.Platform != "ubuntu-24.04-amd64" || parsed.Draft.ExactVersion != "8.0.36-0ubuntu0.24.04.1" {
		t.Fatalf("unexpected deterministic parse result: %+v", parsed.Draft)
	}
	if len(parsed.Draft.Packages) != 2 {
		t.Fatalf("expected 2 parsed packages, got %+v", parsed.Draft.Packages)
	}

	// 2. Import non-catalog cluster (MySQL 8.0)
	importReq := importClusterReq{
		ID:           "mysql-erp-prod",
		Component:    "mysql",
		DisplayName:  "MySQL",
		Version:      "8.0",
		ExactVersion: "8.0.36-0ubuntu0.24.04.1",
		Platform:     "ubuntu-24.04-amd64",
		OSDetail:     "Ubuntu 24.04.1 LTS",
		SourceKind:   "probe",
		DeployMethod: "systemd",
		ArchSummary:  "一主一从高可用",
		Hosts:        parsed.Draft.Hosts,
		Endpoints:    []mwpack.ImportedEndpoint{{Name: "writer", Address: "10.50.1.100:3306", Role: "readwrite"}},
		ServiceUnits: []string{"mysql.service"},
		ConfigPaths:  []string{"/etc/mysql/mysql.conf.d/mysqld.cnf"},
		DataDirs:     []string{"/data/mysql"},
		LogDirs:      []string{"/var/log/mysql"},
		Params:       map[string]any{"port": 3306, "innodb_buffer_pool_size": "16G"},
		Packages:     parsed.Draft.Packages,
		Notes:        "ERP 核心库，每晚 02:00 物理备份",
	}
	ib, _ := json.Marshal(importReq)
	iw := storeRequest(s, "POST", "/api/clusters/import", bytes.NewReader(ib), alice, csrf)
	if iw.Code != 201 {
		t.Fatalf("import mysql failed: %d %s", iw.Code, iw.Body.String())
	}
	var created struct {
		ClusterID string `json:"cluster_id"`
		JobID     string `json:"job_id"`
	}
	json.Unmarshal(iw.Body.Bytes(), &created)

	// Duplicate ID must be rejected with 409
	dup := storeRequest(s, "POST", "/api/clusters/import", bytes.NewReader(ib), alice, csrf)
	if dup.Code != 409 {
		t.Fatalf("expected 409 on duplicate cluster ID, got %d", dup.Code)
	}

	// 3. Verify GET /api/clusters?id=mysql-erp-prod
	cw := storeRequest(s, "GET", "/api/clusters?id=mysql-erp-prod", nil, alice, "")
	if cw.Code != 200 {
		t.Fatalf("GET clusters failed: %d %s", cw.Code, cw.Body.String())
	}
	var views []clusterView
	json.Unmarshal(cw.Body.Bytes(), &views)
	if len(views) != 1 || views[0].DeliveryMode != "imported" || views[0].Icon != "mysql" || views[0].Hosts != 2 || views[0].Imported == nil {
		t.Fatalf("unexpected imported clusterView: %+v", views)
	}

	// 4. Verify GET /api/jobs/{id} returns plan with valid instances + flows for InstanceGraph
	planW := storeRequest(s, "GET", "/api/jobs/"+created.JobID, nil, alice, "")
	if planW.Code != 200 || !strings.Contains(planW.Body.String(), `"mysql"`) || !strings.Contains(planW.Body.String(), `"Binlog 复制"`) {
		t.Fatalf("unexpected imported job detail: %d %s", planW.Code, planW.Body.String())
	}

	// 5. Verify baseline GET + PUT online update
	bg := storeRequest(s, "GET", "/api/clusters/mysql-erp-prod/baseline", nil, alice, "")
	if bg.Code != 200 || !strings.Contains(bg.Body.String(), "innodb_buffer_pool_size") {
		t.Fatalf("GET baseline failed: %d %s", bg.Code, bg.Body.String())
	}
	importReq.ExactVersion = "8.0.40"
	importReq.Hosts = append(importReq.Hosts, importHostInput{Name: "mysql-n3", IP: "10.50.1.13", Role: "replica"})
	ub, _ := json.Marshal(importReq)
	bu := storeRequest(s, "PUT", "/api/clusters/mysql-erp-prod/baseline", bytes.NewReader(ub), alice, csrf)
	if bu.Code != 200 {
		t.Fatalf("PUT baseline failed: %d %s", bu.Code, bu.Body.String())
	}
	cw2 := storeRequest(s, "GET", "/api/clusters?id=mysql-erp-prod", nil, alice, "")
	var views2 []clusterView
	json.Unmarshal(cw2.Body.Bytes(), &views2)
	if len(views2) != 1 || views2[0].Hosts != 3 || views2[0].Imported.ExactVersion != "8.0.40" {
		t.Fatalf("baseline update did not reflect in clusterView: %+v", views2)
	}

	// 6. Verify imported baseline archive doc & Word (.docx) export
	docW := storeRequest(s, "GET", "/api/clusters/mysql-erp-prod/docs/delivery", nil, alice, "")
	if docW.Code != 200 || !strings.Contains(docW.Body.String(), "存量集群纳管基线档案") || !strings.Contains(docW.Body.String(), "mysql-server-8.0") {
		t.Fatalf("imported baseline doc unexpected: %d %s", docW.Code, docW.Body.String())
	}
	expW := storeRequest(s, "GET", "/api/clusters/mysql-erp-prod/export?docs=delivery", nil, alice, "")
	if expW.Code != 200 {
		t.Fatalf("export imported docx failed: %d %s", expW.Code, expW.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(expW.Body.Bytes()), int64(expW.Body.Len()))
	if err != nil {
		t.Fatalf("exported docx is not valid zip: %v", err)
	}
	var docXML string
	for _, f := range zr.File {
		if f.Name == "word/document.xml" {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			docXML = string(b)
		}
	}
	if !strings.Contains(docXML, "存量集群纳管基线档案") || !strings.Contains(docXML, "mysql-n3") {
		t.Fatalf("exported docx missing expected baseline content")
	}

	// 7. Verify Security Audit + SBOM inclusion for imported cluster
	secW := storeRequest(s, "GET", "/api/clusters/mysql-erp-prod/security", nil, alice, "")
	if secW.Code != 200 || !strings.Contains(secW.Body.String(), "imported-sbom-coverage") {
		t.Fatalf("imported security audit failed: %d %s", secW.Code, secW.Body.String())
	}
	inv := s.extractSBOM()
	foundPkg := false
	for _, it := range inv.Items {
		if it.Package == "mysql-server-8.0" && it.Version == "8.0.36-0ubuntu0.24.04.1" {
			foundPkg = true
			break
		}
	}
	if !foundPkg {
		t.Fatalf("expected imported cluster package mysql-server-8.0 in SBOM inventory")
	}

	// 8. Verify imported catalog component (PostgreSQL) also works seamlessly
	pgReq := importClusterReq{
		ID:           "pg-legacy-crm",
		Component:    "postgresql",
		Version:      "16",
		ExactVersion: "16.4",
		Platform:     "ubuntu-22.04-amd64",
		DeployMethod: "systemd",
		Hosts: []importHostInput{
			{Name: "crm-pg-1", IP: "10.60.1.11", Role: "primary"},
			{Name: "crm-pg-2", IP: "10.60.1.12", Role: "replica"},
		},
	}
	pb, _ := json.Marshal(pgReq)
	pgW := storeRequest(s, "POST", "/api/clusters/import", bytes.NewReader(pb), alice, csrf)
	if pgW.Code != 201 {
		t.Fatalf("import catalog postgresql failed: %d %s", pgW.Code, pgW.Body.String())
	}
	// MarkOutcome must be blocked on imported clusters
	var pgRes struct {
		JobID string `json:"job_id"`
	}
	json.Unmarshal(pgW.Body.Bytes(), &pgRes)
	om := storeRequest(s, "PATCH", "/api/jobs/"+pgRes.JobID, strings.NewReader(`{"outcome":"failed"}`), alice, csrf)
	if om.Code != 409 {
		t.Fatalf("expected 409 when changing outcome on imported cluster, got %d %s", om.Code, om.Body.String())
	}

	// 9. Verify job detail JSON serializes non-null scheme contract slices (prevents Config tab null.length crash)
	jobW := storeRequest(s, "GET", "/api/jobs/"+pgRes.JobID, nil, alice, "")
	if jobW.Code != 200 {
		t.Fatalf("GET imported job detail failed: %d %s", jobW.Code, jobW.Body.String())
	}
	if strings.Contains(jobW.Body.String(), `"limitations":null`) || strings.Contains(jobW.Body.String(), `"acceptance":null`) {
		t.Fatalf("imported job detail contains null contract slices: %s", jobW.Body.String())
	}
	if got := normalizeImportEndpointRole("primary"); got != "readwrite" {
		t.Fatalf("expected primary -> readwrite, got %q", got)
	}
	if got := normalizeImportEndpointRole("replica"); got != "readonly" {
		t.Fatalf("expected replica -> readonly, got %q", got)
	}
}

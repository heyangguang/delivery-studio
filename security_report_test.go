package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSecurityReportTemplatesCRUDAndRBAC(t *testing.T) {
	s, _ := testStore(t)
	aliceCookie, aliceCSRF := storeLogin(t, s, "alice")

	// Verify IAM route table enforces security.view for GET and security.manage for write ops.
	if p, ok := routePermFor("GET", "/api/security/report-templates"); !ok || p != "security.view" {
		t.Fatalf("expected security.view for GET /api/security/report-templates, got %q (%v)", p, ok)
	}
	for _, tc := range [][2]string{
		{"POST", "/api/security/report-templates"},
		{"PUT", "/api/security/report-templates/builtin-compliance"},
		{"DELETE", "/api/security/report-templates/tpl-custom"},
		{"POST", "/api/security/report-templates/builtin-executive/default"},
		{"POST", "/api/security/report-templates/builtin-compliance/reset"},
	} {
		if p, ok := routePermFor(tc[0], tc[1]); !ok || p != "security.manage" {
			t.Fatalf("expected security.manage for %s %s, got %q (%v)", tc[0], tc[1], p, ok)
		}
	}

	// Verify HTTP RBAC denies non-security.manage user creating a template.
	reqDeny := httptest.NewRequest("POST", "/api/security/report-templates", strings.NewReader(`{"name":"denied"}`))
	reqDeny.AddCookie(aliceCookie)
	reqDeny.Header.Set("X-CSRF-Token", aliceCSRF)
	wDeny := httptest.NewRecorder()
	s.ServeHTTP(wDeny, reqDeny)
	if wDeny.Code != 403 {
		t.Fatalf("expected 403 for alice creating report template, got %d %s", wDeny.Code, wDeny.Body.String())
	}

	adminSess := storeSession{User: "admin"}

	// 1. GET built-in templates -> 4 built-ins, builtin-compliance default.
	rec := httptest.NewRecorder()
	s.handleSecurity(rec, httptest.NewRequest("GET", "/api/security/report-templates", nil), adminSess)
	if rec.Code != 200 {
		t.Fatalf("GET report-templates failed: %d %s", rec.Code, rec.Body.String())
	}
	var listResp struct {
		Templates []secReportTemplate `json:"templates"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("decode templates: %v", err)
	}
	if len(listResp.Templates) != 4 {
		t.Fatalf("expected 4 builtin templates, got %d", len(listResp.Templates))
	}
	if !listResp.Templates[0].IsDefault || listResp.Templates[0].ID != "builtin-compliance" {
		t.Fatalf("expected builtin-compliance as default, got %+v", listResp.Templates[0])
	}

	// 2. POST create custom template.
	createBody := `{
		"name": "等保月度审计模板",
		"description": "仅输出严重和高危中间件漏洞",
		"default_format": "xlsx",
		"theme": "indigo",
		"org_name": "金融科技安全部",
		"title": "{scope}月度合规审计",
		"scope": "primary",
		"min_severity": "HIGH",
		"include_waived": false,
		"include_ignored": false,
		"sections": {
			"executive_summary": true,
			"affected_clusters": true,
			"package_groups": true,
			"cve_details": false,
			"baseline_checks": true,
			"tls_certs": true,
			"remediation_plan": true,
			"signoff": false
		}
	}`
	rec = httptest.NewRecorder()
	s.handleSecurity(rec, httptest.NewRequest("POST", "/api/security/report-templates", strings.NewReader(createBody)), adminSess)
	if rec.Code != 200 {
		t.Fatalf("POST report-templates failed: %d %s", rec.Code, rec.Body.String())
	}
	var createResp struct {
		Template  secReportTemplate   `json:"template"`
		Templates []secReportTemplate `json:"templates"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &createResp); err != nil {
		t.Fatalf("decode create resp: %v", err)
	}
	customID := createResp.Template.ID
	if !strings.HasPrefix(customID, "tpl-") || createResp.Template.Builtin {
		t.Fatalf("unexpected created template: %+v", createResp.Template)
	}
	if len(createResp.Templates) != 5 {
		t.Fatalf("expected 5 templates after create, got %d", len(createResp.Templates))
	}

	// 3. POST set default -> custom template becomes sole default.
	rec = httptest.NewRecorder()
	s.handleSecurity(rec, httptest.NewRequest("POST", "/api/security/report-templates/"+customID+"/default", nil), adminSess)
	if rec.Code != 200 {
		t.Fatalf("POST default failed: %d %s", rec.Code, rec.Body.String())
	}
	resolved := s.resolveSecReportTemplate("")
	if resolved.ID != customID {
		t.Fatalf("expected default template %s, got %s", customID, resolved.ID)
	}

	// 4. Built-in templates cannot be deleted.
	rec = httptest.NewRecorder()
	s.handleSecurity(rec, httptest.NewRequest("DELETE", "/api/security/report-templates/builtin-executive", nil), adminSess)
	if rec.Code != 400 {
		t.Fatalf("expected 400 deleting builtin template, got %d %s", rec.Code, rec.Body.String())
	}

	// 5. Edit built-in template, then reset back to factory default.
	rec = httptest.NewRecorder()
	s.handleSecurity(rec, httptest.NewRequest("PUT", "/api/security/report-templates/builtin-executive", strings.NewReader(`{"name":"自定义高管摘要","default_format":"html","theme":"slate","scope":"primary","min_severity":"CRITICAL","sections":{"executive_summary":true}}`)), adminSess)
	if rec.Code != 200 {
		t.Fatalf("PUT builtin template failed: %d %s", rec.Code, rec.Body.String())
	}
	if got := s.resolveSecReportTemplate("builtin-executive"); got.Name != "自定义高管摘要" || got.DefaultFormat != "html" {
		t.Fatalf("expected edited builtin template, got %+v", got)
	}
	rec = httptest.NewRecorder()
	s.handleSecurity(rec, httptest.NewRequest("POST", "/api/security/report-templates/builtin-executive/reset", nil), adminSess)
	if rec.Code != 200 {
		t.Fatalf("POST reset failed: %d %s", rec.Code, rec.Body.String())
	}
	if got := s.resolveSecReportTemplate("builtin-executive"); got.Name != "管理层安全摘要" || got.DefaultFormat != "docx" {
		t.Fatalf("expected reset builtin template, got %+v", got)
	}

	// 6. DELETE custom template -> restores a valid default.
	rec = httptest.NewRecorder()
	s.handleSecurity(rec, httptest.NewRequest("DELETE", "/api/security/report-templates/"+customID, nil), adminSess)
	if rec.Code != 200 {
		t.Fatalf("DELETE custom template failed: %d %s", rec.Code, rec.Body.String())
	}
	if def := s.resolveSecReportTemplate(""); def.ID == customID || !def.IsDefault {
		t.Fatalf("expected fallback default template after delete, got %+v", def)
	}
}

func TestSecurityReportMultiFormatExportDocxXlsxHTML(t *testing.T) {
	s, _ := testStore(t)
	adminSess := storeSession{User: "admin"}

	// Seed a deterministic scan report with middleware + OS findings + clusters.
	seeded := &secScanReport{
		ScannedAt:                  "2026-11-23T10:00:00Z",
		DBUpdatedAt:                "2026-11-23T09:00:00Z",
		DBAdvisoryCount:            42,
		SBOMPackageCount:           18,
		ClosureCount:               2,
		RuntimeCount:               1,
		ClusterCount:               1,
		AffectedClusters:           1,
		MiddlewareAffectedClusters: 1,
		OSAffectedClusters:         1,
		ActiveCounts:               secSeverityCounts{Critical: 1, High: 1, Medium: 1, Total: 3},
		TotalCounts:                secSeverityCounts{Critical: 1, High: 1, Medium: 1, Total: 3},
		MiddlewareCounts:           secSeverityCounts{Critical: 1, High: 1, Total: 2},
		OSCounts:                   secSeverityCounts{Medium: 1, Total: 1},
		Findings: []secFinding{
			{
				Key:              "CVE-2026-1001|nginx|ubuntu:24.04",
				ID:               "UBU-2026-1001",
				CVE:              "CVE-2026-1001",
				Severity:         "CRITICAL",
				CVSSScore:        9.8,
				Summary:          "Remote memory corruption in HTTP/3 parser",
				URL:              "https://osv.dev/vulnerability/CVE-2026-1001",
				Ecosystem:        "Ubuntu:24.04:LTS",
				EcoKey:           "ubuntu:24.04",
				PlatformTitle:    "Ubuntu 24.04",
				AssetType:        "os_package",
				PkgRole:          "primary",
				Package:          "nginx",
				InstalledVersion: "1.24.0-1",
				FixedIn:          []string{"1.24.0-2"},
				RepoFixVersion:   "1.24.0-2",
				TriageStatus:     "open",
				Clusters:         []secClusterImpact{{ClusterID: "prod-nginx-01", AppName: "Nginx", Version: "1.24", Platform: "Ubuntu 24.04", Owner: "admin", Hosts: []string{"web-1 (10.0.0.1)"}}},
			},
			{
				Key:              "CVE-2026-2002|postgresql-17|ubuntu:24.04",
				ID:               "UBU-2026-2002",
				CVE:              "CVE-2026-2002",
				Severity:         "HIGH",
				CVSSScore:        7.5,
				Summary:          "Privilege escalation in logical replication",
				Ecosystem:        "Ubuntu:24.04:LTS",
				EcoKey:           "ubuntu:24.04",
				PlatformTitle:    "Ubuntu 24.04",
				AssetType:        "os_package",
				PkgRole:          "primary",
				Package:          "postgresql-17",
				InstalledVersion: "17.2-1",
				FixedIn:          []string{"17.3-1"},
				TriageStatus:     "open",
				Clusters:         []secClusterImpact{{ClusterID: "prod-pg-01", AppName: "PostgreSQL", Version: "17", Platform: "Ubuntu 24.04", Owner: "admin", Hosts: []string{"pg-1 (10.0.0.2)"}}},
			},
			{
				Key:              "CVE-2026-3003|openssl|ubuntu:24.04",
				ID:               "UBU-2026-3003",
				CVE:              "CVE-2026-3003",
				Severity:         "MEDIUM",
				CVSSScore:        5.3,
				Summary:          "Minor ASN.1 timing side-channel",
				Ecosystem:        "Ubuntu:24.04:LTS",
				EcoKey:           "ubuntu:24.04",
				PlatformTitle:    "Ubuntu 24.04",
				AssetType:        "os_package",
				PkgRole:          "dependency",
				Package:          "openssl",
				InstalledVersion: "3.0.13-1",
				TriageStatus:     "open",
			},
		},
		Clusters: []secClusterSummary{
			{
				ClusterID:        "prod-nginx-01",
				AppName:          "Nginx",
				Version:          "1.24",
				Platform:         "Ubuntu 24.04",
				Owner:            "admin",
				Hosts:            []string{"web-1 (10.0.0.1)"},
				Active:           secSeverityCounts{Critical: 1, Total: 1},
				MiddlewareActive: secSeverityCounts{Critical: 1, Total: 1},
				TopCVEs:          []string{"CVE-2026-1001"},
			},
			{
				ClusterID: "healthy-redis-01",
				AppName:   "Redis",
				Version:   "7.2",
				Platform:  "Ubuntu 24.04",
				Owner:     "admin",
				Hosts:     []string{"redis-1 (10.0.0.9)"},
				Active:    secSeverityCounts{},
			},
		},
	}
	seeded.PackageGroups = buildPackageGroups(seeded.Findings)
	secDBMu.Lock()
	if err := s.saveLatestScan(seeded); err != nil {
		secDBMu.Unlock()
		t.Fatalf("saveLatestScan: %v", err)
	}
	secDBMu.Unlock()

	// 1. Export Word (.docx) using builtin-compliance template.
	rec := httptest.NewRecorder()
	s.handleSecurity(rec, httptest.NewRequest("GET", "/api/security/export?format=docx&template=builtin-compliance", nil), adminSess)
	if rec.Code != 200 {
		t.Fatalf("export docx failed: %d %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "wordprocessingml.document") {
		t.Fatalf("unexpected docx Content-Type: %s", ct)
	}
	docXML := readZipEntryText(t, rec.Body.Bytes(), "word/document.xml")
	for _, want := range []string{"合规审计完整报告", "CVE-2026-1001", "prod-nginx-01", "报告声明与审批签字"} {
		if !strings.Contains(docXML, want) {
			t.Fatalf("docx word/document.xml missing %q", want)
		}
	}

	// 2. Export Word (.docx) using builtin-executive (min_severity=HIGH, CVEDetails=false) -> CVE detail chapter & MEDIUM openssl omitted!
	recExec := httptest.NewRecorder()
	s.handleSecurity(recExec, httptest.NewRequest("GET", "/api/security/export?format=docx&template=builtin-executive", nil), adminSess)
	if recExec.Code != 200 {
		t.Fatalf("export executive docx failed: %d", recExec.Code)
	}
	execXML := readZipEntryText(t, recExec.Body.Bytes(), "word/document.xml")
	if strings.Contains(execXML, "CVE 漏洞明细清单") {
		t.Fatalf("executive template should omit CVE detail chapter")
	}
	if strings.Contains(execXML, "CVE-2026-3003") {
		t.Fatalf("executive template (min_severity=HIGH) should omit MEDIUM CVE-2026-3003")
	}

	// 3. Export Excel (.xlsx) using builtin-remediation -> valid OOXML zip + well-formed XML + expected sheets.
	recXlsx := httptest.NewRecorder()
	s.handleSecurity(recXlsx, httptest.NewRequest("GET", "/api/security/export?format=xlsx&template=builtin-remediation", nil), adminSess)
	if recXlsx.Code != 200 {
		t.Fatalf("export xlsx failed: %d %s", recXlsx.Code, recXlsx.Body.String())
	}
	if ct := recXlsx.Header().Get("Content-Type"); !strings.Contains(ct, "spreadsheetml.sheet") {
		t.Fatalf("unexpected xlsx Content-Type: %s", ct)
	}
	assertValidZipXMLParts(t, recXlsx.Body.Bytes())
	wbXML := readZipEntryText(t, recXlsx.Body.Bytes(), "xl/workbook.xml")
	for _, sheet := range []string{"总览摘要", "受影响集群", "修复包清单", "CVE 漏洞明细", "优先修复计划"} {
		if !strings.Contains(wbXML, sheet) {
			t.Fatalf("xlsx workbook.xml missing sheet %q: %s", sheet, wbXML)
		}
	}
	ssXML := readZipEntryText(t, recXlsx.Body.Bytes(), "xl/sharedStrings.xml")
	for _, want := range []string{"CVE-2026-1001", "nginx", "1.24.0-2", "prod-nginx-01"} {
		if !strings.Contains(ssXML, want) {
			t.Fatalf("xlsx sharedStrings missing %q", want)
		}
	}

	// 4. Export standalone offline HTML (.html) with inline=1 preview.
	recHTML := httptest.NewRecorder()
	s.handleSecurity(recHTML, httptest.NewRequest("GET", "/api/security/export?format=html&template=builtin-html-brief&inline=1", nil), adminSess)
	if recHTML.Code != 200 {
		t.Fatalf("export html failed: %d %s", recHTML.Code, recHTML.Body.String())
	}
	if !strings.Contains(recHTML.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("unexpected html Content-Type: %s", recHTML.Header().Get("Content-Type"))
	}
	if !strings.HasPrefix(recHTML.Header().Get("Content-Disposition"), "inline;") {
		t.Fatalf("expected inline Content-Disposition, got %s", recHTML.Header().Get("Content-Disposition"))
	}
	if csp := recHTML.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "sandbox") || !strings.Contains(csp, "script-src 'unsafe-inline'") {
		t.Fatalf("expected sandboxed CSP allowing self-contained script in html export, got %q", csp)
	}
	bodyHTML := recHTML.Body.String()
	for _, want := range []string{"<!DOCTYPE html>", "交互式安全简报", "CVE-2026-1001", "prod-nginx-01", "window.print()"} {
		if !strings.Contains(bodyHTML, want) {
			t.Fatalf("html report missing %q", want)
		}
	}
	if strings.Contains(bodyHTML, "healthy-redis-01") {
		t.Fatalf("healthy 0-CVE cluster should not appear in Affected Clusters table")
	}
	// Guarantee zero external CDN script/stylesheet dependencies for air-gapped environments.
	if strings.Contains(bodyHTML, "cdn.") || strings.Contains(bodyHTML, "googleapis.com") || strings.Contains(bodyHTML, "<script src=") {
		t.Fatalf("html report must be 100%% self-contained offline with no external script/CDN links")
	}

	// 5. Verify cluster audit baseline & TLS certs render across docx, xlsx, and html.
	ca := &clusterSecurityReport{
		ClusterID:      "prod-pg-01",
		AppName:        "PostgreSQL",
		Version:        "17",
		Platform:       "Ubuntu 24.04",
		Hosts:          []string{"pg-1 (10.0.0.2)"},
		Score:          78,
		Grade:          "B",
		BaselinePassed: 3,
		BaselineTotal:  4,
		CertExpiring:   1,
		Findings:       seeded.Findings[:2],
		BaselineChecks: []secBaselineCheck{
			{ID: "tls", Category: "encryption", Title: "客户端 TLS 加密", Severity: "HIGH", Status: "fail", Detail: "当前未开启传输加密", Recommendation: "启用 TLS 1.2+"},
		},
		Certs: []secCertCheck{
			{Instance: "pg-1", Role: "server", Subject: "CN=pg.internal", Issuer: "CN=CorpCA", KeyAlgo: "RSA", KeyBits: 2048, NotBefore: "2026-01-01", NotAfter: "2026-12-01", DaysLeft: 8, Status: "critical"},
		},
	}
	ds := buildSecExportDataset(seeded, ca, s.resolveSecReportTemplate("builtin-compliance"), "admin", "", nil, nil)

	cDocx, err := renderSecurityDocx(ds)
	if err != nil {
		t.Fatalf("cluster renderSecurityDocx: %v", err)
	}
	if xmlStr := readZipEntryText(t, cDocx, "word/document.xml"); !strings.Contains(xmlStr, "客户端 TLS 加密") || !strings.Contains(xmlStr, "CN=pg.internal") {
		t.Fatalf("cluster docx missing baseline or cert details")
	}

	cXlsx, err := renderSecurityXlsx(ds)
	if err != nil {
		t.Fatalf("cluster renderSecurityXlsx: %v", err)
	}
	assertValidZipXMLParts(t, cXlsx)
	if wb := readZipEntryText(t, cXlsx, "xl/workbook.xml"); !strings.Contains(wb, "配置安全基线") || !strings.Contains(wb, "TLS 证书巡检") {
		t.Fatalf("cluster xlsx missing baseline/cert sheets: %s", wb)
	}

	cHTML := string(renderSecurityHTML(ds))
	if !strings.Contains(cHTML, "客户端 TLS 加密") || !strings.Contains(cHTML, "CN=pg.internal") || !strings.Contains(cHTML, "78") {
		t.Fatalf("cluster html missing score/baseline/cert details")
	}
}

func readZipEntryText(t *testing.T, raw []byte, name string) string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("invalid zip archive: %v", err)
	}
	for _, f := range zr.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				t.Fatalf("open zip entry %s: %v", name, err)
			}
			defer rc.Close()
			b, err := io.ReadAll(rc)
			if err != nil {
				t.Fatalf("read zip entry %s: %v", name, err)
			}
			return string(b)
		}
	}
	t.Fatalf("zip entry %q not found", name)
	return ""
}

func assertValidZipXMLParts(t *testing.T, raw []byte) {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("invalid zip archive: %v", err)
	}
	for _, f := range zr.File {
		if !strings.HasSuffix(f.Name, ".xml") && !strings.HasSuffix(f.Name, ".rels") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatalf("read %s: %v", f.Name, err)
		}
		dec := xml.NewDecoder(bytes.NewReader(b))
		for {
			_, derr := dec.Token()
			if derr == io.EOF {
				break
			}
			if derr != nil {
				t.Fatalf("invalid XML in %s: %v\n%s", f.Name, derr, string(b))
			}
		}
	}
}

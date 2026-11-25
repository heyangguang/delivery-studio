package server

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"delivery-studio/mwpack"
	"delivery-studio/pkglib"
)

func TestSecurityCenterDualModeScanTriageGateAndExport(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, csrf := storeLogin(t, s, "alice")
	bob, _ := storeLogin(t, s, "bob")

	// 1. Seed a real pkglib closure for nginx on Ubuntu 24.04 with two packages:
	//    - nginx 1.26.1-1~noble (vulnerable to CVE-2026-9001 < 1.26.2-1~noble)
	//    - openssl 3.0.13-0ubuntu3.4 (already fixed for CVE-2026-9002 fixed in 3.0.13-0ubuntu3.2 -> MUST NOT false-positive!)
	if err := s.plat.lib.Put(pkglib.Closure{
		Request:  mwpack.PackageRequest{Name: "nginx", Version: "1.26.*"},
		Platform: "ubuntu-24.04-amd64",
		Packages: []pkglib.PkgRef{
			{Name: "nginx", Version: "1.26.1-1~noble"},
			{Name: "openssl", Version: "3.0.13-0ubuntu3.4"},
		},
		Via: "test",
	}, nil, nil); err != nil {
		// Also seed with exact declared nginx version in catalog so component attribution matches.
		t.Logf("seed closure err: %v", err)
	}
	// Resolve actual nginx version + package request from catalog and seed closure for it!
	comp, ok := s.plat.cat().Get("nginx")
	if !ok || len(comp.Versions) == 0 {
		t.Fatal("expected builtin nginx component")
	}
	ver := comp.Versions[0].ID
	res, err := comp.Resolve(ver)
	if err != nil {
		t.Fatal(err)
	}
	var nginxReq mwpack.PackageRequest
	for _, pk := range res.Packages {
		if len(pk.Platforms) == 0 || contains(pk.Platforms, "ubuntu-24.04-amd64") {
			nginxReq = mwpack.PackageRequest{Name: pk.Name, Version: pk.Version}
			break
		}
	}
	if nginxReq.Name == "" {
		t.Fatal("expected nginx package request for ubuntu-24.04-amd64")
	}
	if err := s.plat.lib.Put(pkglib.Closure{
		Request:  nginxReq,
		Platform: "ubuntu-24.04-amd64",
		Packages: []pkglib.PkgRef{
			{Name: nginxReq.Name, Version: "1.26.1-1~noble"},
			{Name: "openssl", Version: "3.0.13-0ubuntu3.4"},
		},
		Via: "test",
	}, nil, nil); err != nil {
		t.Fatal(err)
	}

	// Create a real succeeded cluster delivery owned by alice so blast-radius & IAM scoping can be verified.
	s.mu.Lock()
	s.jobs["job-prod-nginx"] = storeJob{
		ID:        "job-prod-nginx",
		ClusterID: "prod-web-01",
		AppID:     "nginx",
		AppName:   "Nginx",
		Version:   ver,
		Owner:     "alice",
		State:     "succeeded",
		Created:   now(),
	}
	s.mu.Unlock()
	_ = os.MkdirAll(s.jobDir("job-prod-nginx"), 0o700)
	_ = os.WriteFile(filepath.Join(s.jobDir("job-prod-nginx"), "deployment.yml"), []byte(`id: prod-web-01
platform: ubuntu-24.04-amd64
hosts:
  - name: web-01
    ip: 10.10.1.11
instances:
  - id: nginx
    component: nginx
    version: "`+ver+`"
`), 0o600)

	// 2. Test Online Sync against local mock OSV.dev server!
	oldOSV := osvAPIBase
	mockOSV := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/querybatch":
			var body struct {
				Queries []struct {
					Package struct {
						Name      string `json:"name"`
						Ecosystem string `json:"ecosystem"`
					} `json:"package"`
				} `json:"queries"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			results := make([]map[string]any, len(body.Queries))
			for i, q := range body.Queries {
				switch q.Package.Name {
				case nginxReq.Name:
					results[i] = map[string]any{"vulns": []map[string]string{{"id": "USN-9001-1"}}}
				case "openssl":
					results[i] = map[string]any{"vulns": []map[string]string{{"id": "USN-9002-1"}}}
				default:
					results[i] = map[string]any{"vulns": []any{}}
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"results": results})
		case "/v1/vulns/USN-9001-1":
			_, _ = w.Write([]byte(`{
				"id":"USN-9001-1",
				"aliases":["CVE-2026-9001"],
				"summary":"Critical HTTP/3 heap overflow in nginx",
				"published":"2026-11-01T00:00:00Z",
				"severity":[{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}],
				"affected":[{
					"package":{"name":"` + nginxReq.Name + `","ecosystem":"Ubuntu:24.04:LTS"},
					"ranges":[{"type":"ECOSYSTEM","events":[{"introduced":"0"},{"fixed":"1.26.2-1~noble"}]}]
				}]
			}`))
		case "/v1/vulns/USN-9002-1":
			_, _ = w.Write([]byte(`{
				"id":"USN-9002-1",
				"aliases":["CVE-2026-9002"],
				"summary":"Fixed OpenSSL issue already backported in 3.0.13-0ubuntu3.2",
				"severity":[{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"}],
				"affected":[{
					"package":{"name":"openssl","ecosystem":"Ubuntu:24.04:LTS"},
					"ranges":[{"type":"ECOSYSTEM","events":[{"introduced":"0"},{"fixed":"3.0.13-0ubuntu3.2"}]}]
				}]
			}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer func() {
		osvAPIBase = oldOSV
		mockOSV.Close()
	}()
	osvAPIBase = mockOSV.URL

	// Engineer (alice) cannot trigger DB sync (needs security.scan -> 403).
	if w := storeRequest(s, "POST", "/api/security/db/sync", nil, alice, csrf); w.Code != 403 {
		t.Fatalf("expected 403 for engineer DB sync, got %d", w.Code)
	}

	// Admin runs online OSV sync -> auto-triggers deterministic offline scan.
	w := storeRequest(s, "POST", "/api/security/db/sync", nil, admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("online sync failed: %d %s", w.Code, w.Body.String())
	}
	var syncResp struct {
		Meta   secDBMeta      `json:"meta"`
		Report *secScanReport `json:"report"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &syncResp); err != nil {
		t.Fatal(err)
	}
	if syncResp.Meta.AdvisoryCount < 2 {
		t.Fatalf("expected >=2 advisories synced, got %d", syncResp.Meta.AdvisoryCount)
	}
	if syncResp.Report == nil || syncResp.Report.ActiveCounts.Critical != 1 {
		t.Fatalf("expected exactly 1 Critical finding (openssl backport must NOT false-positive!), got %+v", syncResp.Report)
	}
	f0 := syncResp.Report.Findings[0]
	if f0.CVE != "CVE-2026-9001" || f0.CVSSScore < 9.0 {
		t.Fatalf("unexpected finding: %+v", f0)
	}
	if len(f0.Clusters) != 1 || f0.Clusters[0].ClusterID != "prod-web-01" {
		t.Fatalf("expected blast radius to include prod-web-01, got %+v", f0.Clusters)
	}

	// IAM visibility scope check: bob (scope=own) must NOT see alice's prod-web-01 in cluster impacts!
	wBob := storeRequest(s, "GET", "/api/security/overview", nil, bob, "")
	if wBob.Code != 200 {
		t.Fatalf("bob overview: %d", wBob.Code)
	}
	if strings.Contains(wBob.Body.String(), "prod-web-01") {
		t.Fatalf("IAM scope leak: bob saw alice's cluster in security overview")
	}

	// 3. Policy gate: enable block_publish_critical -> publishing nginx must be blocked with 409!
	if w := storeRequest(s, "PUT", "/api/security/policy", strings.NewReader(`{"block_publish_critical":true,"warn_publish_high":true}`), admin, acsrf); w.Code != 200 {
		t.Fatalf("save policy: %d %s", w.Code, w.Body.String())
	}
	if w := storeRequest(s, "POST", "/api/components/nginx/versions/"+ver+"/status", strings.NewReader(`{"status":"published","platform":"ubuntu-24.04-amd64","test_mode":"manual"}`), admin, acsrf); w.Code != 409 {
		t.Fatalf("expected 409 publish blocked by critical CVE gate, got %d %s", w.Code, w.Body.String())
	}

	// 4. VEX Triage: mark CVE-2026-9001 as mitigated -> active Critical drops to 0 AND publish gate unblocks!
	if w := storeRequest(s, "POST", "/api/security/triage", strings.NewReader(`{
		"vuln_id":"CVE-2026-9001",
		"package":"`+nginxReq.Name+`",
		"ecosystem":"Ubuntu:24.04:LTS",
		"status":"mitigated",
		"justification":"vulnerable_code_not_in_execute_path",
		"note":"HTTP/3 模块未启用，不受此漏洞影响"
	}`), admin, acsrf); w.Code != 200 {
		t.Fatalf("triage failed: %d %s", w.Code, w.Body.String())
	} else {
		var trResp struct {
			Report *secScanReport `json:"report"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &trResp)
		if trResp.Report.ActiveCounts.Critical != 0 || trResp.Report.WaivedCount != 1 {
			t.Fatalf("expected 0 active critical and 1 waived after triage, got active=%+v waived=%d", trResp.Report.ActiveCounts, trResp.Report.WaivedCount)
		}
	}
	if w := storeRequest(s, "POST", "/api/components/nginx/versions/"+ver+"/status", strings.NewReader(`{"status":"published","platform":"ubuntu-24.04-amd64","test_mode":"manual"}`), admin, acsrf); w.Code != 200 {
		t.Fatalf("expected publish to succeed after VEX mitigation, got %d %s", w.Code, w.Body.String())
	}

	// 5. Offline Bundle Export -> Tamper detection -> Air-gapped Import into a second store!
	wExp := storeRequest(s, "GET", "/api/security/db/export", nil, admin, "")
	if wExp.Code != 200 || len(wExp.Body.Bytes()) == 0 {
		t.Fatalf("export offline bundle failed: %d", wExp.Code)
	}
	bundleBytes := wExp.Body.Bytes()

	sAirgap, _ := testStore(t)
	agAdmin, agCSRF := storeLogin(t, sAirgap, "admin")
	if w := storeRequest(sAirgap, "POST", "/api/security/db/import", bytes.NewReader(bundleBytes), agAdmin, agCSRF); w.Code != 200 {
		t.Fatalf("airgap bundle import failed: %d %s", w.Code, w.Body.String())
	}

	// Tamper advisories.json inside bundle while keeping old SHA256SUMS -> MUST reject with 400!
	tampered := tamperTarGz(t, bundleBytes, "advisories.json", []byte(`[{"id":"FAKE","package":"x","ecosystem":"PyPI"}]`))
	if w := storeRequest(sAirgap, "POST", "/api/security/db/import", bytes.NewReader(tampered), agAdmin, agCSRF); w.Code != 400 {
		t.Fatalf("expected 400 on tampered SHA256SUMS bundle, got %d %s", w.Code, w.Body.String())
	}

	// 6. Export CSV, CycloneDX 1.5 SBOM+VEX, and Markdown reports!
	for _, tc := range []struct {
		fmt  string
		want string
	}{
		{"csv", "CVE-2026-9001"},
		{"cyclonedx", `"bomFormat": "CycloneDX"`},
		{"markdown", "# Kyndryl Delivery Studio 安全漏洞评估报告"},
	} {
		w := storeRequest(s, "GET", "/api/security/export?format="+tc.fmt, nil, admin, "")
		if w.Code != 200 || !strings.Contains(w.Body.String(), tc.want) {
			t.Fatalf("export %s failed: %d %s", tc.fmt, w.Code, w.Body.String()[:min(200, len(w.Body.String()))])
		}
	}
}

func tamperTarGz(t *testing.T, orig []byte, targetName string, replacement []byte) []byte {
	t.Helper()
	gzr, err := gzip.NewReader(bytes.NewReader(orig))
	if err != nil {
		t.Fatal(err)
	}
	defer gzr.Close()
	tr := tar.NewReader(gzr)
	var out bytes.Buffer
	gzw := gzip.NewWriter(&out)
	tw := tar.NewWriter(gzw)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(tr)
		if hdr.Name == targetName {
			data = replacement
			hdr.Size = int64(len(data))
		}
		_ = tw.WriteHeader(hdr)
		_, _ = tw.Write(data)
	}
	_ = tw.Close()
	_ = gzw.Close()
	return out.Bytes()
}

func TestCVSS3AndPEP440Comparators(t *testing.T) {
	if sc := parseCVSS3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"); sc != 9.8 {
		t.Fatalf("expected CVSS 9.8, got %.1f", sc)
	}
	if sc := parseCVSS3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"); sc != 7.5 {
		t.Fatalf("expected CVSS 7.5, got %.1f", sc)
	}
	if comparePEP440("2.20.1", "2.20.2") >= 0 {
		t.Fatal("expected 2.20.1 < 2.20.2")
	}
	if comparePEP440("44.0.0rc1", "44.0.0") >= 0 {
		t.Fatal("expected 44.0.0rc1 < 44.0.0")
	}
	if comparePEP440("44.0.0.post1", "44.0.0") <= 0 {
		t.Fatal("expected 44.0.0.post1 > 44.0.0")
	}
	if got := primaryCVE("UBUNTU-CVE-2024-41184", nil); got != "CVE-2024-41184" {
		t.Fatalf("expected canonical CVE-2024-41184, got %s", got)
	}
	if got := primaryCVE("DEBIAN-CVE-2025-12345", nil); got != "CVE-2025-12345" {
		t.Fatalf("expected canonical CVE-2025-12345, got %s", got)
	}
}

func TestSecurityCenterV2GroupingClusterAuditRehearsalSyncAndAIGate(t *testing.T) {
	s, _ := testStore(t)
	admin, adminCSRF := storeLogin(t, s, "admin")
	alice, aliceCSRF := storeLogin(t, s, "alice")

	// Seed a closure with primary package (nginx) + dependency package (openssl).
	pl := mwpack.DefaultPlatform
	cl := pkglib.Closure{
		Request:  mwpack.PackageRequest{Name: "nginx", Version: "1.24"},
		Platform: pl,
		Packages: []pkglib.PkgRef{
			{Name: "nginx", Version: "1.24.0-2ubuntu7.18"},
			{Name: "openssl", Version: "3.0.13-0ubuntu3.16"},
		},
		Fetched: now(),
		Via:     "test",
	}
	clPath := filepath.Join(s.plat.lib.Dir, pl, "closures", "nginx@1.24.json")
	if err := writeJSONFile(clPath, cl); err != nil {
		t.Fatal(err)
	}

	// Seed a delivered production cluster with insecure baseline params (tls: false, client_cidr: 0.0.0.0/0, single node).
	jobID := "secv2-job1"
	s.mu.Lock()
	s.jobs[jobID] = storeJob{
		ID: jobID, ClusterID: "secv2-cluster", AppID: "postgresql", AppName: "PostgreSQL", Version: "17",
		Owner: "admin", State: "succeeded", Created: now(), Updated: now(),
	}
	s.mu.Unlock()
	specYAML := "schema: mwdeploy/v1\nid: secv2-cluster\nplatform: " + pl + "\nhosts:\n  - {name: db1, ip: 10.0.0.10}\ninstances:\n  - id: pg\n    component: postgresql\n    version: \"17\"\n    placement:\n      db: [db1]\n    params:\n      tls: false\n      tde: false\n      client_cidr: 0.0.0.0/0\n"
	if err := os.MkdirAll(filepath.Join(s.jobDir(jobID), "output"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.jobDir(jobID), "deployment.yml"), []byte(specYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.jobDir(jobID), "output", "deployment.yml"), []byte(specYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	// Attach nginx component to cluster plan so CVE hits this cluster too.
	planJSON := `{"platforms":["` + pl + `"],"instances":[{"component":"nginx","version":"1.24"},{"component":"postgresql","version":"17"}]}`
	if err := os.WriteFile(filepath.Join(s.jobDir(jobID), "output", "plan.json"), []byte(planJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	// 1. Import 2 Ubuntu-prefixed CVEs on nginx (fixed in .19 and .20) + 1 on openssl.
	osvJSON := `[
		{
			"id": "UBUNTU-CVE-2026-10001",
			"summary": "nginx flaw 1",
			"severity": [{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"}],
			"affected": [{"package":{"name":"nginx","ecosystem":"Ubuntu:24.04:LTS"},"ranges":[{"type":"ECOSYSTEM","events":[{"introduced":"0"},{"fixed":"1.24.0-2ubuntu7.19"}]}]}]
		},
		{
			"id": "UBUNTU-CVE-2026-10002",
			"summary": "nginx flaw 2",
			"severity": [{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}],
			"affected": [{"package":{"name":"nginx","ecosystem":"Ubuntu:24.04:LTS"},"ranges":[{"type":"ECOSYSTEM","events":[{"introduced":"0"},{"fixed":"1.24.0-2ubuntu7.20"}]}]}]
		},
		{
			"id": "UBUNTU-CVE-2026-20001",
			"summary": "openssl base lib flaw",
			"severity": [{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"}],
			"affected": [{"package":{"name":"openssl","ecosystem":"Ubuntu:24.04:LTS"},"ranges":[{"type":"ECOSYSTEM","events":[{"introduced":"0"},{"fixed":"3.0.13-0ubuntu3.20"}]}]}]
		}
	]`
	wImp := storeRequest(s, "POST", "/api/security/db/import", strings.NewReader(osvJSON), admin, adminCSRF)
	if wImp.Code != 200 {
		t.Fatalf("import failed: %d %s", wImp.Code, wImp.Body.String())
	}
	var impResp struct {
		Report secScanReport `json:"report"`
	}
	_ = json.Unmarshal(wImp.Body.Bytes(), &impResp)

	// Verify UBUNTU-CVE-* normalized to CVE-* and 2 nginx CVEs collapsed into 1 PackageGroup recommending .20!
	foundNginxGroup := false
	for _, g := range impResp.Report.PackageGroups {
		if g.Package == "nginx" {
			foundNginxGroup = true
			if g.PkgRole != "primary" {
				t.Fatalf("expected nginx pkg_role=primary, got %s", g.PkgRole)
			}
			if g.ActiveCount != 2 {
				t.Fatalf("expected 2 active CVEs in nginx group, got %d", g.ActiveCount)
			}
			if g.RecommendedFix != "1.24.0-2ubuntu7.20" {
				t.Fatalf("expected highest recommended_fix=1.24.0-2ubuntu7.20, got %s", g.RecommendedFix)
			}
			for _, cve := range g.CVEs {
				if strings.HasPrefix(cve, "UBUNTU-") {
					t.Fatalf("expected canonical CVE ID without UBUNTU- prefix, got %s", cve)
				}
			}
		}
		if g.Package == "openssl" && g.PkgRole != "dependency" {
			t.Fatalf("expected openssl pkg_role=dependency, got %s", g.PkgRole)
		}
	}
	if !foundNginxGroup {
		t.Fatalf("expected nginx package group in %+v", impResp.Report.PackageGroups)
	}

	// 2. Cluster Security Audit endpoint (GET /api/clusters/secv2-cluster/security)
	wClSec := storeRequest(s, "GET", "/api/clusters/secv2-cluster/security", nil, admin, "")
	if wClSec.Code != 200 {
		t.Fatalf("cluster security failed: %d %s", wClSec.Code, wClSec.Body.String())
	}
	var clRep clusterSecurityReport
	_ = json.Unmarshal(wClSec.Body.Bytes(), &clRep)
	if clRep.Score >= 100 || clRep.BaselineTotal < 3 {
		t.Fatalf("expected security score deductions and baseline checks, got score=%d base=%d", clRep.Score, clRep.BaselineTotal)
	}
	seenTLSFail, seenCIDRFail := false, false
	for _, ck := range clRep.BaselineChecks {
		if ck.ID == "tls_enabled" && ck.Status == "fail" {
			seenTLSFail = true
		}
		if ck.ID == "client_cidr_open" && ck.Status == "fail" {
			seenCIDRFail = true
		}
	}
	if !seenTLSFail || !seenCIDRFail {
		t.Fatalf("expected tls_enabled & client_cidr_open baseline failures, got %+v", clRep.BaselineChecks)
	}

	// Waive client_cidr_open -> score should increase & status becomes waived!
	prevScore := clRep.Score
	wWaive := storeRequest(s, "POST", "/api/clusters/secv2-cluster/security/baseline-waive",
		strings.NewReader(`{"check_id":"client_cidr_open","waived":true,"note":"前置硬件防火墙已收敛来源IP"}`), admin, adminCSRF)
	if wWaive.Code != 200 {
		t.Fatalf("baseline waive failed: %d %s", wWaive.Code, wWaive.Body.String())
	}
	var clRepAfter clusterSecurityReport
	_ = json.Unmarshal(wWaive.Body.Bytes(), &clRepAfter)
	if clRepAfter.Score <= prevScore {
		t.Fatalf("expected score to rise after baseline waiver: %d -> %d", prevScore, clRepAfter.Score)
	}

	// Cluster-scoped Markdown export includes cluster audit & baseline table!
	wClMD := storeRequest(s, "GET", "/api/security/export?format=markdown&cluster=secv2-cluster", nil, admin, "")
	if wClMD.Code != 200 || !strings.Contains(wClMD.Body.String(), "集群安全评估报告：secv2-cluster") || !strings.Contains(wClMD.Body.String(), "配置安全基线审计") {
		t.Fatalf("cluster markdown export failed: %d %s", wClMD.Code, wClMD.Body.String())
	}

	// 3. Rehearsal SecurityContext + VEX writeback (POST /api/clusters/secv2-cluster/rehearsals/:rid/sync-vex)
	rh := changeRehearsal{
		ID: "a1b2c3d4e5f6", ClusterID: "secv2-cluster", AppID: "postgresql", AppName: "PostgreSQL",
		BaseJobID: jobID, Title: "安全修复：升级 nginx", Goal: "升级 nginx", Owner: "admin",
		Stage: "finalized", DocID: "sop-a1b2c3d4e5f6",
		SecurityContext: &rehearsalSecurityContext{
			Kind: "cve_patch", CVEs: []string{"CVE-2026-10001", "CVE-2026-10002"},
			Package: "nginx", Ecosystem: "Ubuntu:24.04:LTS",
			CurrentVersion: "1.24.0-2ubuntu7.18", TargetVersion: "1.24.0-2ubuntu7.20",
		},
		CreatedAt: nowStamp(), UpdatedAt: nowStamp(),
	}
	if err := s.saveRehearsal(rh); err != nil {
		t.Fatal(err)
	}
	wSync := storeRequest(s, "POST", "/api/clusters/secv2-cluster/rehearsals/a1b2c3d4e5f6/sync-vex",
		strings.NewReader(`{"status":"mitigated","note":"演练通过并固化 SOP"}`), admin, adminCSRF)
	if wSync.Code != 200 {
		t.Fatalf("rehearsal sync-vex failed: %d %s", wSync.Code, wSync.Body.String())
	}
	// Verify overview now shows those 2 nginx CVEs waived and linked to sop-a1b2c3d4e5f6!
	wOv := storeRequest(s, "GET", "/api/security/overview", nil, admin, "")
	var ov struct {
		Report secScanReport `json:"report"`
	}
	_ = json.Unmarshal(wOv.Body.Bytes(), &ov)
	linkedSeen := 0
	for _, f := range ov.Report.Findings {
		if f.Package == "nginx" && f.Waived && f.LinkedSOPDocID == "sop-a1b2c3d4e5f6" {
			linkedSeen++
		}
	}
	if linkedSeen != 2 {
		t.Fatalf("expected 2 nginx findings waived and linked to SOP, got %d", linkedSeen)
	}

	// 4. Batch VEX Triage on remaining openssl CVE
	wBatch := storeRequest(s, "POST", "/api/security/triage/batch",
		strings.NewReader(`{"items":[{"vuln_id":"CVE-2026-20001","package":"openssl","ecosystem":"Ubuntu:24.04:LTS"}],"status":"planned","note":"纳入下月OS基线补丁窗口"}`), admin, adminCSRF)
	if wBatch.Code != 200 {
		t.Fatalf("batch triage failed: %d %s", wBatch.Code, wBatch.Body.String())
	}

	// 5. Supply-Chain Integrity & Scan History
	wSup := storeRequest(s, "GET", "/api/security/supply-chain?verify=1", nil, admin, "")
	if wSup.Code != 200 || !strings.Contains(wSup.Body.String(), `"deep_verified":true`) {
		t.Fatalf("supply-chain check failed: %d %s", wSup.Code, wSup.Body.String())
	}
	wHist := storeRequest(s, "GET", "/api/security/history", nil, admin, "")
	if wHist.Code != 200 || !strings.Contains(wHist.Body.String(), `"scanned_at"`) {
		t.Fatalf("history check failed: %d %s", wHist.Code, wHist.Body.String())
	}

	// 6. Strict 3-layer gate on 12th AI feature ("security" / "ai.feat.security"):
	// 6a. Master switch OFF -> 409
	wAI1 := storeRequest(s, "POST", "/api/security/ai-analyze",
		strings.NewReader(`{"cve":"CVE-2026-10001","package":"nginx"}`), admin, adminCSRF)
	if wAI1.Code != 409 {
		t.Fatalf("expected 409 when AI master switch OFF, got %d %s", wAI1.Code, wAI1.Body.String())
	}
	// Enable AI master switch with a dummy provider, then disable module "security" -> 409
	aiSt := s.aiLoad()
	aiSt.Enabled = true
	aiSt.Features["security"] = aiFeature{Enabled: false}
	_ = s.aiSave(aiSt)
	wAI2 := storeRequest(s, "POST", "/api/security/ai-analyze",
		strings.NewReader(`{"cve":"CVE-2026-10001","package":"nginx"}`), admin, adminCSRF)
	if wAI2.Code != 409 {
		t.Fatalf("expected 409 when security AI module OFF, got %d %s", wAI2.Code, wAI2.Body.String())
	}
	// Enable module "security", strip ai.feat.security from alice's custom role -> 403!
	aiSt.Features["security"] = aiFeature{Enabled: true}
	_ = s.aiSave(aiSt)
	iamMu.Lock()
	ist := s.iamLoad()
	ist.Roles = append(ist.Roles, role{
		ID: "no-sec-ai", Name: "NoSecAI", Scope: "all", GranularAI: true,
		Perms: []string{"security.view", "ai.use", "ai.feat.assistant"},
	})
	ist.Grants["alice"] = grant{Roles: []string{"no-sec-ai"}}
	_ = s.iamSave(ist)
	iamMu.Unlock()
	wAI3 := storeRequest(s, "POST", "/api/security/ai-analyze",
		strings.NewReader(`{"cve":"CVE-2026-10001","package":"nginx"}`), alice, aliceCSRF)
	if wAI3.Code != 403 {
		t.Fatalf("expected 403 when user lacks ai.feat.security, got %d %s", wAI3.Code, wAI3.Body.String())
	}
	// Same strict gate on /api/security/ai-polish (requires security.manage + security AI feature).
	wPolAlice := storeRequest(s, "POST", "/api/security/ai-polish",
		strings.NewReader(`{"cve":"CVE-2026-10001","status":"mitigated","draft_note":"内网不对外"}`), alice, aliceCSRF)
	if wPolAlice.Code != 403 {
		t.Fatalf("expected 403 on ai-polish for user without security.manage/ai.feat.security, got %d %s", wPolAlice.Code, wPolAlice.Body.String())
	}
	aiSt.Features["security"] = aiFeature{Enabled: false}
	_ = s.aiSave(aiSt)
	wPolOff := storeRequest(s, "POST", "/api/security/ai-polish",
		strings.NewReader(`{"cve":"CVE-2026-10001","status":"mitigated","draft_note":"内网不对外"}`), admin, adminCSRF)
	if wPolOff.Code != 409 {
		t.Fatalf("expected 409 on ai-polish when security AI module OFF, got %d %s", wPolOff.Code, wPolOff.Body.String())
	}
}

func TestSecurityMiddlewareVsOSSeparationAndPolicyGate(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")

	// 1. Verify deterministic middleware vs OS vs runtime classification on real-world package names.
	mwSet := buildMiddlewarePrimarySet(s.plat.cat())
	cases := []struct {
		assetType string
		pkg       string
		closures  []string
		want      string
	}{
		{"os_package", "nginx", []string{"nginx=1.24.0-2ubuntu7.18"}, "primary"},
		{"os_package", "nginx-core", []string{"nginx=1.26.3-9.el9"}, "primary"},
		{"os_package", "nginx-filesystem", []string{"nginx=1.26.3-9.el9"}, "primary"},
		{"os_package", "nginx-mod-stream", []string{"nginx-mod-stream=1.26.3-9.el9"}, "primary"},
		{"os_package", "keepalived", []string{"keepalived=1:2.2.8-1build2"}, "primary"},
		{"os_package", "haproxy", []string{"haproxy=2.8.30"}, "primary"},
		{"os_package", "percona-postgresql-17", []string{"percona-postgresql-17=2:17.11"}, "primary"},
		{"os_package", "percona-patroni", []string{"percona-patroni=1:4.1.5"}, "primary"},
		{"os_package", "redis-server", []string{"redis-server=6:7.2.16"}, "primary"},
		{"os_package", "python3.12", []string{"percona-patroni=1:4.1.5"}, "dependency"},
		{"os_package", "openssl", []string{"percona-patroni=1:4.1.5"}, "dependency"},
		{"os_package", "openssl-libs", []string{"haproxy=2.8.14"}, "dependency"},
		{"os_package", "systemd", []string{"logrotate=3.21.0"}, "dependency"},
		{"os_package", "logrotate", []string{"logrotate=3.21.0"}, "dependency"},
		{"os_package", "libxml2", []string{"percona-patroni=1:4.1.5"}, "dependency"},
		{"os_package", "perl-URI", []string{"keepalived=2.2.8"}, "dependency"},
		{"os_package", "ca-certificates", []string{"percona-patroni=1:4.1.5"}, "dependency"},
		{"python_runtime", "cryptography", nil, "runtime"},
		{"python_runtime", "pip", nil, "runtime"},
	}
	for _, tc := range cases {
		if got := classifySecPkgRole(tc.assetType, tc.pkg, tc.closures, mwSet); got != tc.want {
			t.Fatalf("classifySecPkgRole(%s, %s) = %s, want %s", tc.assetType, tc.pkg, got, tc.want)
		}
	}

	// 2. Seed one closure with nginx (middleware) + openssl (OS base) and one cluster using nginx 1.24.
	pl := "ubuntu-24.04-amd64"
	cl := pkglib.Closure{
		Request:  mwpack.PackageRequest{Name: "nginx", Version: "1.24.0-2ubuntu7.18"},
		Platform: pl,
		Packages: []pkglib.PkgRef{
			{Name: "nginx", Version: "1.24.0-2ubuntu7.18"},
			{Name: "nginx-core", Version: "1.24.0-2ubuntu7.18"},
			{Name: "openssl", Version: "3.0.13-0ubuntu3.16"},
		},
		Fetched: now(),
		Via:     "test",
	}
	if err := writeJSONFile(filepath.Join(s.plat.lib.Dir, pl, "closures", "nginx@1.24.0-2ubuntu7.18.json"), cl); err != nil {
		t.Fatal(err)
	}
	jobID := "job-mw-os-sep"
	s.mu.Lock()
	s.jobs[jobID] = storeJob{
		ID: jobID, ClusterID: "sep-cluster", AppID: "nginx", AppName: "Nginx",
		Version: "1.24", Owner: "admin", State: "succeeded", Created: now(), Updated: now(),
	}
	s.mu.Unlock()
	specYAML := "schema: mwdeploy/v1\nid: sep-cluster\nplatform: " + pl + "\nhosts:\n  - {name: n1, ip: 10.0.9.10}\ninstances:\n  - id: ngx\n    component: nginx\n    version: \"1.24\"\n    placement:\n      balancer: [n1]\n"
	_ = os.MkdirAll(filepath.Join(s.jobDir(jobID), "output"), 0o700)
	_ = os.WriteFile(filepath.Join(s.jobDir(jobID), "deployment.yml"), []byte(specYAML), 0o600)
	_ = os.WriteFile(filepath.Join(s.jobDir(jobID), "output", "deployment.yml"), []byte(specYAML), 0o600)
	_ = os.WriteFile(filepath.Join(s.jobDir(jobID), "output", "plan.json"), []byte(`{"platforms":["`+pl+`"],"instances":[{"component":"nginx","version":"1.24"}]}`), 0o600)

	// Import 1 High CVE on nginx-core (middleware) and 1 Critical CVE on openssl (OS base).
	osvJSON := `[
		{
			"id": "UBUNTU-CVE-2026-30001",
			"summary": "nginx-core high flaw",
			"severity": [{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"}],
			"affected": [{"package":{"name":"nginx-core","ecosystem":"Ubuntu:24.04:LTS"},"ranges":[{"type":"ECOSYSTEM","events":[{"introduced":"0"},{"fixed":"1.24.0-2ubuntu7.19"}]}]}]
		},
		{
			"id": "UBUNTU-CVE-2026-40001",
			"summary": "openssl critical OS flaw",
			"severity": [{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}],
			"affected": [{"package":{"name":"openssl","ecosystem":"Ubuntu:24.04:LTS"},"ranges":[{"type":"ECOSYSTEM","events":[{"introduced":"0"},{"fixed":"3.0.13-0ubuntu3.20"}]}]}]
		}
	]`
	wImp := storeRequest(s, "POST", "/api/security/db/import", strings.NewReader(osvJSON), admin, csrf)
	if wImp.Code != 200 {
		t.Fatalf("import failed %d: %s", wImp.Code, wImp.Body.String())
	}
	var resp struct {
		Report secScanReport `json:"report"`
	}
	_ = json.Unmarshal(wImp.Body.Bytes(), &resp)
	if resp.Report.MiddlewareCounts.Total != 1 || resp.Report.MiddlewareCounts.High != 1 {
		t.Fatalf("expected MiddlewareCounts total=1 high=1, got %+v", resp.Report.MiddlewareCounts)
	}
	if resp.Report.OSCounts.Total != 1 || resp.Report.OSCounts.Critical != 1 {
		t.Fatalf("expected OSCounts total=1 critical=1, got %+v", resp.Report.OSCounts)
	}
	if resp.Report.MiddlewareAffectedClusters != 1 || resp.Report.OSAffectedClusters != 1 {
		t.Fatalf("expected affected clusters mw=1 os=1, got mw=%d os=%d", resp.Report.MiddlewareAffectedClusters, resp.Report.OSAffectedClusters)
	}

	// 3. Policy Gate: block_publish_critical=true + gate_middleware_only=false -> blocks on openssl Critical;
	// flipping gate_middleware_only=true -> ignores openssl OS Critical and allows publish + stops deducting OS points in cluster score!
	polAll := `{"block_publish_critical":true,"warn_publish_high":true,"warn_delivery_critical":true,"notify_on_scan":false,"gate_middleware_only":false}`
	if w := storeRequest(s, "PUT", "/api/security/policy", strings.NewReader(polAll), admin, csrf); w.Code != 200 {
		t.Fatalf("save policy failed %d", w.Code)
	}
	if issues := s.publishSecurityGateIssues("nginx", "1.24", []string{pl}); len(issues) != 1 {
		t.Fatalf("expected publish gate blocked by openssl critical when gate_middleware_only=false, got %v", issues)
	}
	wClAll := storeRequest(s, "GET", "/api/clusters/sep-cluster/security", nil, admin, "")
	var clAll clusterSecurityReport
	_ = json.Unmarshal(wClAll.Body.Bytes(), &clAll)

	polMW := `{"block_publish_critical":true,"warn_publish_high":true,"warn_delivery_critical":true,"notify_on_scan":false,"gate_middleware_only":true}`
	if w := storeRequest(s, "PUT", "/api/security/policy", strings.NewReader(polMW), admin, csrf); w.Code != 200 {
		t.Fatalf("save mw-only policy failed %d", w.Code)
	}
	if issues := s.publishSecurityGateIssues("nginx", "1.24", []string{pl}); len(issues) != 0 {
		t.Fatalf("expected publish gate unblocked when gate_middleware_only=true (only OS critical), got %v", issues)
	}
	wClMW := storeRequest(s, "GET", "/api/clusters/sep-cluster/security", nil, admin, "")
	var clMW clusterSecurityReport
	_ = json.Unmarshal(wClMW.Body.Bytes(), &clMW)
	if !clMW.GateMiddlewareOnly || clMW.Score <= clAll.Score {
		t.Fatalf("expected higher cluster score with gate_middleware_only=true (%d vs %d)", clMW.Score, clAll.Score)
	}

	// 4. Scoped CSV export (?scope=primary) contains ONLY nginx-core (中间件本体), NOT openssl!
	wCSV := storeRequest(s, "GET", "/api/security/export?format=csv&scope=primary", nil, admin, "")
	if wCSV.Code != 200 {
		t.Fatalf("csv export failed %d", wCSV.Code)
	}
	csvBody := wCSV.Body.String()
	if !strings.Contains(csvBody, "分层来源") || !strings.Contains(csvBody, "中间件本体") || !strings.Contains(csvBody, "nginx-core") || strings.Contains(csvBody, "openssl") {
		t.Fatalf("unexpected middleware-scoped CSV output: %s", csvBody)
	}
}


func TestSecurityAIConversationalProposalsAndRBAC(t *testing.T) {
	s, _ := testStore(t)
	admin, adminCSRF := storeLogin(t, s, "admin")
	alice, aliceCSRF := storeLogin(t, s, "alice")

	// 1. Session key & feature mapping for cluster/global security AI conversations.
	if !reSessionKey.MatchString("sec") || !reSessionKey.MatchString("sec:CVE-2026-121876_systemd") {
		t.Fatalf("reSessionKey should accept sec and sec:* keys")
	}
	if featureOfKey("sec:CVE-2026-121876_systemd") != "security" || featureOfKey("sec") != "security" {
		t.Fatalf("featureOfKey should map sec* keys to security")
	}

	// 2. Global Security AI sessions/proposals GET work and chat enforces Security AI gate.
	wSess := storeRequest(s, "GET", "/api/security/ai/sessions", nil, admin, "")
	if wSess.Code != 200 {
		t.Fatalf("GET /api/security/ai/sessions expected 200, got %d %s", wSess.Code, wSess.Body.String())
	}
	wOne := storeRequest(s, "GET", "/api/security/ai/session?key=sec:CVE-2026-99999", nil, admin, "")
	if wOne.Code != 200 {
		t.Fatalf("GET /api/security/ai/session expected 200, got %d %s", wOne.Code, wOne.Body.String())
	}
	// Master AI off -> chat returns 409
	wChatOff := storeRequest(s, "POST", "/api/security/ai/chat",
		strings.NewReader(`{"key":"sec:CVE-2026-99999","message":"研判此漏洞"}`), admin, adminCSRF)
	if wChatOff.Code != 409 {
		t.Fatalf("expected 409 when AI disabled on /api/security/ai/chat, got %d %s", wChatOff.Code, wChatOff.Body.String())
	}

	// 3. Propose VEX triage card -> verify RBAC (alice without security.manage gets 403; admin gets 200 & writes triage.json).
	var made []string
	msg := s.createVexProposal(s.secAIProposalsPath(), "sec:CVE-2026-99999", "cluster-a", map[string]any{
		"cve":           "CVE-2026-99999",
		"package":       "nginx",
		"ecosystem":     "Ubuntu:24.04:LTS",
		"status":        "mitigated",
		"justification": "inline_mitigations_already_exist",
		"note":          "集群部署于内部隔离网段，不暴露公网，前置防火墙已限制来源访问。",
		"reason":        "内网隔离已降低利用面",
	}, &made)
	if len(made) != 1 || !strings.Contains(msg, "已生成") {
		t.Fatalf("createVexProposal failed: %s (made=%v)", msg, made)
	}
	vexPropID := made[0]

	// Ensure alice has security.view + ai.use but NOT security.manage -> accept must return 403!
	iamMu.Lock()
	ist := s.iamLoad()
	ist.Roles = append(ist.Roles, role{
		ID:         "sec-viewer-ai",
		Name:       "安全只读",
		Scope:      "all",
		GranularAI: true,
		Perms:      []string{"security.view", "ai.use", "ai.feat.security"},
	})
	ist.Grants["alice"] = grant{Roles: []string{"sec-viewer-ai"}}
	_ = s.iamSave(ist)
	iamMu.Unlock()

	wDeny := storeRequest(s, "POST", "/api/security/ai/proposals/"+vexPropID+"/accept", nil, alice, aliceCSRF)
	if wDeny.Code != 403 {
		t.Fatalf("expected 403 for user without security.manage accepting VEX proposal, got %d %s", wDeny.Code, wDeny.Body.String())
	}

	wAccept := storeRequest(s, "POST", "/api/security/ai/proposals/"+vexPropID+"/accept", nil, admin, adminCSRF)
	if wAccept.Code != 200 {
		t.Fatalf("admin accept VEX proposal failed: %d %s", wAccept.Code, wAccept.Body.String())
	}
	secDBMu.Lock()
	triageMap := s.loadSecTriage()
	secDBMu.Unlock()
	rec, ok := triageMap["CVE-2026-99999|nginx|ubuntu:24.04"]
	if !ok || rec.Status != "mitigated" || rec.Justification != "inline_mitigations_already_exist" || rec.UpdatedBy != "admin" {
		t.Fatalf("expected persisted VEX record after proposal accept, got %+v (map=%v)", rec, triageMap)
	}

	// 4. Propose baseline waiver card -> accept writes baseline_waivers.json.
	var madeBase []string
	s.createBaselineWaiveProposal(s.secAIProposalsPath(), "sec:base_tls", "cluster-a", map[string]any{
		"check_id": "tls_disabled",
		"title":    "内网明文通信",
		"note":     "该集群位于独立内网 VPC，由上层网关终结 TLS。",
		"reason":   "满足内网隔离要求",
	}, &madeBase)
	if len(madeBase) != 1 {
		t.Fatalf("createBaselineWaiveProposal failed")
	}
	wBaseAcc := storeRequest(s, "POST", "/api/security/ai/proposals/"+madeBase[0]+"/accept", nil, admin, adminCSRF)
	if wBaseAcc.Code != 200 {
		t.Fatalf("accept baseline proposal failed: %d %s", wBaseAcc.Code, wBaseAcc.Body.String())
	}
	secDBMu.Lock()
	waivers := s.loadSecBaselineWaivers()
	secDBMu.Unlock()
	if wv, ok := waivers["cluster-a|tls_disabled"]; !ok || wv.By != "admin" {
		t.Fatalf("expected persisted baseline waiver after proposal accept, got %+v", waivers)
	}

	// 5. Propose rehearsal card -> reject marks status=rejected.
	var madeReh []string
	s.createRehearsalProposal(s.secAIProposalsPath(), "sec:CVE-2026-99999", "admin", "cluster-a", "", map[string]any{
		"title":    "滚动升级 Nginx",
		"packages": []any{"nginx"},
		"cves":     []any{"CVE-2026-99999"},
		"summary":  "滚动升级至修复版本并演练健康检查",
		"reason":   "源已有修复版本",
	}, &madeReh, true)
	if len(madeReh) != 1 {
		t.Fatalf("createRehearsalProposal failed")
	}
	wRehRej := storeRequest(s, "POST", "/api/security/ai/proposals/"+madeReh[0]+"/reject", nil, admin, adminCSRF)
	if wRehRej.Code != 200 {
		t.Fatalf("reject rehearsal proposal failed: %d %s", wRehRej.Code, wRehRej.Body.String())
	}
	var rejProp aiProposal
	_ = json.Unmarshal(wRehRej.Body.Bytes(), &rejProp)
	if rejProp.Status != "rejected" {
		t.Fatalf("expected rejected status, got %+v", rejProp)
	}
}


func TestSecurityConfigurableCVESourcesSyncAndTest(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")

	// 1. Default builtin sources exist and cannot be deleted.
	wList := storeRequest(s, "GET", "/api/security/sources", nil, admin, "")
	if wList.Code != 200 || !strings.Contains(wList.Body.String(), "builtin-osv") || !strings.Contains(wList.Body.String(), "builtin-cisa-kev") {
		t.Fatalf("expected builtin sources in GET /api/security/sources, got %d %s", wList.Code, wList.Body.String())
	}
	wDelBuiltin := storeRequest(s, "DELETE", "/api/security/sources/builtin-osv", nil, admin, csrf)
	if wDelBuiltin.Code != 409 {
		t.Fatalf("expected 409 when deleting builtin source, got %d %s", wDelBuiltin.Code, wDelBuiltin.Body.String())
	}

	// 2. Spin up local HTTP mock servers for a custom JSON advisory feed (requiring auth header) + a CISA KEV feed.
	feedSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Feed-Key") != "secret-feed-token" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{
			"id": "CORP-CVE-2026-88001",
			"aliases": ["CVE-2026-88001"],
			"summary": "Custom internal nginx advisory",
			"severity": [{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}],
			"affected": [{"package":{"name":"nginx","ecosystem":"Ubuntu:24.04:LTS"},"ranges":[{"type":"ECOSYSTEM","events":[{"introduced":"0"},{"fixed":"1.24.0-2ubuntu7.99"}]}]}]
		}]`))
	}))
	defer feedSrv.Close()

	kevSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"vulnerabilities":[{"cveID":"CVE-2026-88001","dateAdded":"2026-11-20","requiredAction":"立即升级至修复版本"}]}`))
	}))
	defer kevSrv.Close()

	// 3. Create custom JSON feed source & verify token is NOT echoed back raw.
	addBody := fmt.Sprintf(`{"name":"企业内部 CVE 订阅源","kind":"json_feed","url":%q,"auth_header":"X-Feed-Key","auth_token":"secret-feed-token","note":"内网镜像"}`, feedSrv.URL)
	wAdd := storeRequest(s, "POST", "/api/security/sources", strings.NewReader(addBody), admin, csrf)
	if wAdd.Code != 200 {
		t.Fatalf("POST /api/security/sources failed: %d %s", wAdd.Code, wAdd.Body.String())
	}
	if strings.Contains(wAdd.Body.String(), "secret-feed-token") {
		t.Fatalf("auth_token must NEVER be leaked in API response: %s", wAdd.Body.String())
	}
	var addResp struct {
		Source secFeedSource `json:"source"`
	}
	_ = json.Unmarshal(wAdd.Body.Bytes(), &addResp)
	if addResp.Source.ID == "" || !addResp.Source.HasAuthToken {
		t.Fatalf("expected source id & has_auth_token=true, got %+v", addResp.Source)
	}

	// 4. Test connectivity against custom JSON feed source.
	wTest := storeRequest(s, "POST", "/api/security/sources/"+addResp.Source.ID+"/test", nil, admin, csrf)
	if wTest.Code != 200 {
		t.Fatalf("test source failed: %d %s", wTest.Code, wTest.Body.String())
	}
	var testRes secSourceTestResult
	_ = json.Unmarshal(wTest.Body.Bytes(), &testRes)
	if !testRes.OK || testRes.SampleCount != 1 {
		t.Fatalf("expected ok=true sample_count=1, got %+v", testRes)
	}

	// 5. Sync ONLY the custom JSON feed source -> persists advisory & updates last_sync_count.
	wSync := storeRequest(s, "POST", "/api/security/db/sync", strings.NewReader(fmt.Sprintf(`{"source_id":%q}`, addResp.Source.ID)), admin, csrf)
	if wSync.Code != 200 {
		t.Fatalf("single-source sync failed: %d %s", wSync.Code, wSync.Body.String())
	}
	secDBMu.Lock()
	advs := s.loadSecAdvisories()
	secDBMu.Unlock()
	if len(advs) == 0 || advs[0].CVE != "CVE-2026-88001" {
		t.Fatalf("expected synced custom advisory CVE-2026-88001, got %+v", advs)
	}

	// 6. Update builtin CISA KEV source to mock server + enable, then sync it -> enriches advisory summary!
	wUpdKev := storeRequest(s, "PUT", "/api/security/sources/builtin-cisa-kev",
		strings.NewReader(fmt.Sprintf(`{"url":%q,"enabled":true}`, kevSrv.URL)), admin, csrf)
	if wUpdKev.Code != 200 {
		t.Fatalf("update builtin-cisa-kev failed: %d %s", wUpdKev.Code, wUpdKev.Body.String())
	}
	wSyncKev := storeRequest(s, "POST", "/api/security/db/sync", strings.NewReader(`{"source_id":"builtin-cisa-kev"}`), admin, csrf)
	if wSyncKev.Code != 200 {
		t.Fatalf("sync builtin-cisa-kev failed: %d %s", wSyncKev.Code, wSyncKev.Body.String())
	}
	secDBMu.Lock()
	advsAfter := s.loadSecAdvisories()
	secDBMu.Unlock()
	if len(advsAfter) == 0 || !strings.Contains(advsAfter[0].Summary, "CISA KEV") {
		t.Fatalf("expected CISA KEV enrichment on CVE-2026-88001, got %+v", advsAfter)
	}

	// 7. Delete custom source cleanly.
	wDel := storeRequest(s, "DELETE", "/api/security/sources/"+addResp.Source.ID, nil, admin, csrf)
	if wDel.Code != 200 || strings.Contains(wDel.Body.String(), addResp.Source.ID) {
		t.Fatalf("delete custom source failed: %d %s", wDel.Code, wDel.Body.String())
	}
}

func makeTestSelfSignedCertPEM(t *testing.T, cn string, validDays int) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(42),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().UTC().Add(-24 * time.Hour),
		NotAfter:     time.Now().UTC().Add(time.Duration(validDays) * 24 * time.Hour),
		DNSNames:     []string{cn},
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func writeTestTarGz(t *testing.T, path string, files map[string][]byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gw := gzip.NewWriter(f)
	tw := tar.NewWriter(gw)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{
			Name:     name,
			Mode:     0o600,
			Size:     int64(len(body)),
			Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSecurityRevisedClusterCertsAndBaselineEffectiveParams(t *testing.T) {
	s, _ := testStore(t)
	admin, _ := storeLogin(t, s, "admin")

	clusterID := "pg-offline-prod"
	job1ID := "job-pg-rev1"
	job2ID := "job-pg-rev2"

	s.mu.Lock()
	s.jobs[job1ID] = storeJob{
		ID: job1ID, ClusterID: clusterID, Seq: 1, Owner: "admin",
		AppID: "postgresql", AppName: "PostgreSQL", Version: "17",
		State: "succeeded", Outcome: outcomeDone, DeliveryMode: "offline",
		Created: "2026-10-28T01:00:00Z", Updated: "2026-10-28T01:00:00Z",
	}
	s.jobs[job2ID] = storeJob{
		ID: job2ID, ClusterID: clusterID, Seq: 2, Owner: "admin",
		AppID: "postgresql", AppName: "PostgreSQL", Version: "17",
		State: "succeeded", Outcome: outcomeDone, DeliveryMode: "offline",
		Created: "2026-10-28T02:00:00Z", Updated: "2026-10-28T02:00:00Z",
	}
	s.mu.Unlock()

	// deployment.yml intentionally omits tls & tde (relying on component defaults solved into plan.json).
	depYAML := `schema: mwdeploy/v1
id: pg-offline-prod
controller: node-1
platform: ubuntu-24.04-amd64
hosts:
  - name: node-1
    ip: 10.10.0.1
  - name: node-2
    ip: 10.10.0.2
instances:
  - id: pg
    component: postgresql
    version: "17"
    placement:
      primary: [node-1]
      replica: [node-2]
    params:
      client_cidr: 10.10.0.0/24
`
	planJSON := `{"cluster":"pg-offline-prod","project":"pg-offline-prod.02","instances":[{"id":"pg","component":"postgresql","external":false,"params":{"client_cidr":"10.10.0.0/24","tls":true,"tde":true}}]}`

	for _, jid := range []string{job1ID, job2ID} {
		if err := os.MkdirAll(filepath.Join(s.jobDir(jid), "output"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(s.jobDir(jid), "deployment.yml"), []byte(depYAML), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(s.jobDir(jid), "output", "plan.json"), []byte(planJSON), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// Put X.509 certificates under a VERSIONED revision project path (<cluster>.01) ONLY in job1ID!
	// job2ID omits certs so we test BOTH versioned ".01" project matching AND fallback to prior delivery!
	srvCert := makeTestSelfSignedCertPEM(t, "pg-offline.internal", 365)
	caCert := makeTestSelfSignedCertPEM(t, "corp-root-ca", 730)
	writeTestTarGz(t, filepath.Join(s.jobDir(job1ID), "output", "node01-pg-offline-prod.01-10.10.0.1.tar.gz"), map[string][]byte{
		"middleware-automation/projects/pg-offline-prod.01/files/pg/tls/server.crt": srvCert,
		"middleware-automation/projects/pg-offline-prod.01/files/pg/tls/ca.crt":     caCert,
		"middleware-automation/projects/pg-offline-prod.01/files/pg/tls/server.key": []byte("PRIVATE"),
	})

	// 1. Direct sourceCertificates on job1ID MUST match ".01" versioned project dir.
	mats := s.sourceCertificates(job1ID)
	if len(mats["pg/tls/server.crt"]) == 0 || len(mats["pg/tls/ca.crt"]) == 0 {
		t.Fatalf("sourceCertificates failed on .01 revision tarball: keys=%v", mats)
	}

	// 2. GET /api/clusters/pg-offline-prod/security MUST detect certs (via fallback to job1ID)
	//    AND mark tls_enabled=pass, pg_tde=pass, tls_cert_expiry=pass, tls_cert_strength=pass!
	w := storeRequest(s, "GET", "/api/clusters/"+clusterID+"/security", nil, admin, "")
	if w.Code != 200 {
		t.Fatalf("GET cluster security failed: %d %s", w.Code, w.Body.String())
	}
	var rep clusterSecurityReport
	if err := json.Unmarshal(w.Body.Bytes(), &rep); err != nil {
		t.Fatal(err)
	}
	if len(rep.Certs) != 2 {
		t.Fatalf("expected 2 parsed certificates (server + ca), got %d: %+v", len(rep.Certs), rep.Certs)
	}
	statusByID := map[string]string{}
	for _, ck := range rep.BaselineChecks {
		statusByID[ck.ID] = ck.Status
	}
	for _, id := range []string{"tls_enabled", "pg_tde", "tls_cert_expiry", "tls_cert_strength"} {
		if statusByID[id] != "pass" {
			t.Fatalf("expected baseline %s=pass, got %q (all=%+v)", id, statusByID[id], statusByID)
		}
	}
}

func TestSecurityGlobalPerspectiveHideOSAndPackageIgnores(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	alice, aliceCSRF := storeLogin(t, s, "alice")

	// Seed closure with middleware (nginx) + two OS base libs (openssl, systemd).
	pl := "ubuntu-24.04-amd64"
	cl := pkglib.Closure{
		Request:  mwpack.PackageRequest{Name: "nginx", Version: "1.24.0-2ubuntu7.18"},
		Platform: pl,
		Packages: []pkglib.PkgRef{
			{Name: "nginx", Version: "1.24.0-2ubuntu7.18"},
			{Name: "openssl", Version: "3.0.13-0ubuntu3.16"},
			{Name: "systemd", Version: "255.4-1ubuntu8.18"},
		},
		Fetched: now(),
		Via:     "test",
	}
	if err := writeJSONFile(filepath.Join(s.plat.lib.Dir, pl, "closures", "nginx@1.24.0-2ubuntu7.18.json"), cl); err != nil {
		t.Fatal(err)
	}
	jobID := "job-ign-test"
	s.mu.Lock()
	s.jobs[jobID] = storeJob{
		ID: jobID, ClusterID: "prod-ign-nginx", Owner: "admin",
		AppID: "nginx", AppName: "Nginx", Version: "1.24",
		State: "succeeded", Outcome: outcomeDone, DeliveryMode: "offline",
		Created: "2026-11-01T00:00:00Z", Updated: "2026-11-01T00:00:00Z",
	}
	s.mu.Unlock()
	if err := os.MkdirAll(filepath.Join(s.jobDir(jobID), "output"), 0o755); err != nil {
		t.Fatal(err)
	}
	specYAML := `schema: mwdeploy/v1
id: prod-ign-nginx
controller: n1
platform: ubuntu-24.04-amd64
hosts:
  - name: n1
    ip: 10.0.0.11
  - name: n2
    ip: 10.0.0.12
instances:
  - id: lb
    component: nginx
    version: "1.24"
    placement:
      balancer: [n1, n2]
`
	_ = os.WriteFile(filepath.Join(s.jobDir(jobID), "deployment.yml"), []byte(specYAML), 0o600)
	_ = os.WriteFile(filepath.Join(s.jobDir(jobID), "output", "deployment.yml"), []byte(specYAML), 0o600)
	_ = os.WriteFile(filepath.Join(s.jobDir(jobID), "output", "plan.json"), []byte(`{"platforms":["`+pl+`"],"instances":[{"id":"lb","component":"nginx","version":"1.24"}]}`), 0o600)

	osvJSON := `[
		{"id":"UBUNTU-CVE-2026-71001","aliases":["CVE-2026-71001"],"summary":"Nginx High","severity":[{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"}],"affected":[{"package":{"ecosystem":"Ubuntu:24.04:LTS","name":"nginx"},"ranges":[{"type":"ECOSYSTEM","events":[{"introduced":"0"},{"fixed":"1.24.0-2ubuntu7.20"}]}]}]},
		{"id":"UBUNTU-CVE-2026-71002","aliases":["CVE-2026-71002"],"summary":"OpenSSL Critical","severity":[{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}],"affected":[{"package":{"ecosystem":"Ubuntu:24.04:LTS","name":"openssl"},"ranges":[{"type":"ECOSYSTEM","events":[{"introduced":"0"},{"fixed":"3.0.13-0ubuntu3.20"}]}]}]},
		{"id":"UBUNTU-CVE-2026-71003","aliases":["CVE-2026-71003"],"summary":"Systemd High","severity":[{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"}],"affected":[{"package":{"ecosystem":"Ubuntu:24.04:LTS","name":"systemd"},"ranges":[{"type":"ECOSYSTEM","events":[{"introduced":"0"},{"fixed":"255.4-1ubuntu8.20"}]}]}]}
	]`
	if w := storeRequest(s, "POST", "/api/security/db/import", strings.NewReader(osvJSON), admin, csrf); w.Code != 200 {
		t.Fatalf("import failed: %d %s", w.Code, w.Body.String())
	}

	// Enable Critical publish block to verify ignored packages & hidden OS layers do NOT block publish.
	if w := storeRequest(s, "PUT", "/api/security/policy", strings.NewReader(`{"block_publish_critical":true,"warn_publish_high":true}`), admin, csrf); w.Code != 200 {
		t.Fatalf("policy update failed: %d %s", w.Code, w.Body.String())
	}

	// Baseline: all 3 CVEs active, cluster score deducts for both MW and OS, publish gate blocked by openssl Critical.
	getClusterSec := func() clusterSecurityReport {
		w := storeRequest(s, "GET", "/api/clusters/prod-ign-nginx/security", nil, admin, "")
		if w.Code != 200 {
			t.Fatalf("cluster sec failed: %d %s", w.Code, w.Body.String())
		}
		var r clusterSecurityReport
		_ = json.Unmarshal(w.Body.Bytes(), &r)
		return r
	}
	baseSec := getClusterSec()
	if baseSec.ActiveCounts.Total != 3 || baseSec.OSCounts.Critical != 1 {
		t.Fatalf("expected 3 active (1 OS critical), got active=%+v os=%+v", baseSec.ActiveCounts, baseSec.OSCounts)
	}
	if issues := s.publishSecurityGateIssues("nginx", "1.24", []string{"ubuntu-24.04-amd64"}); len(issues) == 0 {
		t.Fatalf("expected openssl Critical to block publish initially")
	}

	// 1. RBAC: alice (no security.manage) MUST get 403 on POST /api/security/ignores.
	if w := storeRequest(s, "POST", "/api/security/ignores", strings.NewReader(`{"package":"openssl","all_ecosystems":true}`), alice, aliceCSRF); w.Code != 403 {
		t.Fatalf("expected 403 for alice on POST /api/security/ignores, got %d", w.Code)
	}

	// 2. Globally ignore openssl -> excluded from active counts, cluster score deductions & publish gate!
	wIgn := storeRequest(s, "POST", "/api/security/ignores", strings.NewReader(`{"package":"openssl","all_ecosystems":true,"pkg_role":"dependency","note":"OS team maintains openssl"}`), admin, csrf)
	if wIgn.Code != 200 {
		t.Fatalf("POST /api/security/ignores failed: %d %s", wIgn.Code, wIgn.Body.String())
	}
	var ignResp struct {
		Rule   secIgnoreRule `json:"rule"`
		Policy secPolicy     `json:"policy"`
		Report secScanReport `json:"report"`
	}
	_ = json.Unmarshal(wIgn.Body.Bytes(), &ignResp)
	if ignResp.Report.ActiveCounts.Total != 2 || ignResp.Report.SuppressedPkgCount != 1 {
		t.Fatalf("expected 2 active & 1 suppressed_pkg after ignoring openssl, got active=%+v supp=%d", ignResp.Report.ActiveCounts, ignResp.Report.SuppressedPkgCount)
	}
	afterIgnSec := getClusterSec()
	if afterIgnSec.Score <= baseSec.Score || afterIgnSec.SuppressedCount != 1 {
		t.Fatalf("expected cluster score to increase after ignoring critical openssl (%d -> %d, supp=%d)", baseSec.Score, afterIgnSec.Score, afterIgnSec.SuppressedCount)
	}
	if issues := s.publishSecurityGateIssues("nginx", "1.24", []string{"ubuntu-24.04-amd64"}); len(issues) != 0 {
		t.Fatalf("expected globally ignored openssl NOT to block publish, got %v", issues)
	}

	// Export CSV omits globally ignored openssl by default, includes it when include_ignored=1.
	wCSV := storeRequest(s, "GET", "/api/security/export?format=csv", nil, admin, "")
	if strings.Contains(wCSV.Body.String(), "CVE-2026-71002") {
		t.Fatalf("expected default CSV export to omit globally ignored openssl CVE")
	}
	wCSVAll := storeRequest(s, "GET", "/api/security/export?format=csv&include_ignored=1", nil, admin, "")
	if !strings.Contains(wCSVAll.Body.String(), "CVE-2026-71002") {
		t.Fatalf("expected CSV export with include_ignored=1 to include ignored CVE")
	}

	// 3. Enable global hide_os_cves (omitting ignored_packages in payload -> MUST preserve ignored_packages!).
	wPol := storeRequest(s, "PUT", "/api/security/policy", strings.NewReader(`{"block_publish_critical":true,"warn_publish_high":true,"hide_os_cves":true}`), admin, csrf)
	if wPol.Code != 200 {
		t.Fatalf("PUT policy hide_os_cves failed: %d %s", wPol.Code, wPol.Body.String())
	}
	var savedPol secPolicy
	_ = json.Unmarshal(wPol.Body.Bytes(), &savedPol)
	if !savedPol.HideOSCVEs || len(savedPol.IgnoredPackages) != 1 {
		t.Fatalf("expected hide_os_cves=true and preserved 1 ignored package, got %+v", savedPol)
	}
	afterHideOSSec := getClusterSec()
	if afterHideOSSec.ActiveCounts.Total != 1 || afterHideOSSec.OSCounts.Total != 0 || afterHideOSSec.SuppressedCount != 2 || !afterHideOSSec.HideOSCVEs {
		t.Fatalf("expected only nginx active and 2 OS CVEs suppressed, got active=%+v os=%+v supp=%d", afterHideOSSec.ActiveCounts, afterHideOSSec.OSCounts, afterHideOSSec.SuppressedCount)
	}
	if afterHideOSSec.Score <= afterIgnSec.Score {
		t.Fatalf("expected cluster score to increase further when systemd OS High CVE is hidden (%d -> %d)", afterIgnSec.Score, afterHideOSSec.Score)
	}

	// 4. Disable hide_os_cves and DELETE openssl ignore rule -> restores all 3 active CVEs & original score!
	if w := storeRequest(s, "PUT", "/api/security/policy", strings.NewReader(`{"block_publish_critical":true,"warn_publish_high":true,"hide_os_cves":false}`), admin, csrf); w.Code != 200 {
		t.Fatalf("disable hide_os_cves failed: %d", w.Code)
	}
	if w := storeRequest(s, "DELETE", "/api/security/ignores/"+url.PathEscape(ignResp.Rule.ID), nil, admin, csrf); w.Code != 200 {
		t.Fatalf("DELETE ignore rule failed: %d %s", w.Code, w.Body.String())
	}
	restoredSec := getClusterSec()
	if restoredSec.ActiveCounts.Total != 3 || restoredSec.SuppressedCount != 0 || restoredSec.Score != baseSec.Score {
		t.Fatalf("expected full restoration to 3 active & score %d, got active=%d supp=%d score=%d", baseSec.Score, restoredSec.ActiveCounts.Total, restoredSec.SuppressedCount, restoredSec.Score)
	}
}

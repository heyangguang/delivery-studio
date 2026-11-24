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

func TestClusterImportMultiComponentPatroniEtcdStack(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")

	// Realistic Percona PostgreSQL 17 + Patroni + etcd + pgBackRest probe output matching production scenario
	probeOut := `=== MW_IMPORT_BEGIN ===
PROBE_COMPONENT=postgresql
=== MW_IMPORT_HOST ===
HOSTNAME=ecs-unified-toolchain-private-prod-edc-gitlab-pg-ha-001
IPS=172.30.2.67 127.0.0.1
=== MW_IMPORT_OS ===
PRETTY_NAME="Ubuntu 24.04.5 LTS"
=== MW_IMPORT_STORAGE ===
Filesystem     Type  Size  Used Avail Use% Mounted on
/dev/vda2      ext4   96G   18G   74G  20% /
/dev/vdb1      ext4  196G   25G  162G  13% /data
=== MW_IMPORT_PORTS ===
LISTEN 0 128 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=2101,fd=6))
LISTEN 0 128 0.0.0.0:8008 0.0.0.0:* users:(("patroni",pid=1980,fd=9))
LISTEN 0 128 172.30.2.67:2379 0.0.0.0:* users:(("etcd",pid=1620,fd=7))
LISTEN 0 128 172.30.2.67:2380 0.0.0.0:* users:(("etcd",pid=1620,fd=5))
LISTEN 0 128 0.0.0.0:9100 0.0.0.0:* users:(("node_exporter",pid=1400,fd=3))
=== MW_IMPORT_MIDDLEWARE ===
--- [POSTGRESQL / PATRONI / ETCD] ---
psql (PostgreSQL) 17.11.1
# file: /etc/patroni/patroni.yml
scope: pg-gitlab-private-prod
data_dir: /data/pg
log_directory: /data/logs/postgresql
patronictl version 4.0.4
+ Cluster: pg-gitlab-private-prod (7698776689296485808) +----+-----------+----+-----------+
| Member     | Host        | Role           | State     | TL | Lag in MB |
+------------+-------------+----------------+-----------+----+-----------+
| db-node-01 | 172.30.2.67 | Leader         | running   |  9 |           |
| db-node-02 | 172.30.2.82 | Quorum Standby | streaming |  9 |         0 |
| db-node-03 | 172.30.2.91 | Quorum Standby | streaming |  9 |         0 |
+------------+-------------+----------------+-----------+----+-----------+
etcd Version: 3.5.14
# file: /etc/etcd/etcd.conf.yaml
data-dir: /data/etcd
initial-cluster: db-node-01=http://172.30.2.67:2380,db-node-02=http://172.30.2.82:2380,db-node-03=http://172.30.2.91:2380
pgBackRest 2.59.1
patroni.service loaded active running Patroni PostgreSQL HA
etcd.service loaded active running etcd key-value store
=== MW_IMPORT_PACKAGES ===
percona-postgresql-17	17.11-1.noble
patroni	4.0.4-1.noble
etcd-server	3.5.14-1
pgbackrest	2.59.1-1.noble
=== MW_IMPORT_END ===`

	parseBody, _ := json.Marshal(importParseReq{
		Component:  "postgresql",
		SourceKind: "probe",
		Text:       probeOut,
	})
	pw := storeRequest(s, "POST", "/api/clusters/import/parse", bytes.NewReader(parseBody), alice, csrf)
	if pw.Code != 200 {
		t.Fatalf("parse failed: %d %s", pw.Code, pw.Body.String())
	}
	var parsed struct {
		Draft importParseDraft `json:"draft"`
	}
	if err := json.Unmarshal(pw.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Draft.Hosts) != 3 {
		t.Fatalf("expected 3 hosts from patronictl table, got %+v", parsed.Draft.Hosts)
	}
	if parsed.Draft.Hosts[0].Name != "db-node-01" || parsed.Draft.Hosts[0].Role != "primary" || parsed.Draft.Hosts[0].Disk != "/dev/vdb" {
		t.Fatalf("unexpected primary host: %+v", parsed.Draft.Hosts[0])
	}
	if parsed.Draft.Hosts[1].Role != "replica" || parsed.Draft.Hosts[2].Role != "replica" {
		t.Fatalf("expected replica roles for standby nodes, got %+v", parsed.Draft.Hosts)
	}
	compSet := map[string]mwpack.ImportedCompanion{}
	for _, cm := range parsed.Draft.Companions {
		compSet[cm.Component] = cm
	}
	for _, want := range []string{"patroni", "etcd", "pgbackrest"} {
		if _, ok := compSet[want]; !ok {
			t.Fatalf("expected companion %q to be detected, got %+v", want, parsed.Draft.Companions)
		}
	}
	if compSet["patroni"].Version != "4.0.4" || compSet["etcd"].Version != "3.5.14" || compSet["pgbackrest"].Version != "2.59.1" {
		t.Fatalf("unexpected companion versions: patroni=%+v etcd=%+v pgbackrest=%+v", compSet["patroni"], compSet["etcd"], compSet["pgbackrest"])
	}

	// Import cluster with the parsed multi-component companions
	importReq := importClusterReq{
		ID:           "pg-patroni-stack-test",
		Component:    "postgresql",
		DisplayName:  "PostgreSQL",
		Version:      parsed.Draft.Version,
		ExactVersion: parsed.Draft.ExactVersion,
		Platform:     parsed.Draft.Platform,
		OSDetail:     parsed.Draft.OSDetail,
		SourceKind:   "probe",
		DeployMethod: "systemd",
		ArchSummary:  parsed.Draft.ArchSummary,
		Hosts:        parsed.Draft.Hosts,
		Endpoints:    []mwpack.ImportedEndpoint{{Name: "readwrite", Address: "gitlab.pg.internal:5432", Role: "readwrite"}},
		Companions:   parsed.Draft.Companions,
		ServiceUnits: parsed.Draft.ServiceUnits,
		ConfigPaths:  parsed.Draft.ConfigPaths,
		DataDirs:     parsed.Draft.DataDirs,
		LogDirs:      parsed.Draft.LogDirs,
		Params:       parsed.Draft.Params,
		Packages:     parsed.Draft.Packages,
	}
	ib, _ := json.Marshal(importReq)
	iw := storeRequest(s, "POST", "/api/clusters/import", bytes.NewReader(ib), alice, csrf)
	if iw.Code != 201 {
		t.Fatalf("import failed: %d %s", iw.Code, iw.Body.String())
	}
	var created struct {
		JobID string `json:"job_id"`
	}
	json.Unmarshal(iw.Body.Bytes(), &created)

	// Verify solved plan contains PostgreSQL + Patroni (with ManagedContext & Uses->etcd) + etcd (with Raft flow & 2379/2380 ports)
	jw := storeRequest(s, "GET", "/api/jobs/"+created.JobID, nil, alice, "")
	if jw.Code != 200 {
		t.Fatalf("GET job failed: %d %s", jw.Code, jw.Body.String())
	}
	bodyStr := jw.Body.String()
	for _, want := range []string{`"component":"postgresql"`, `"component":"patroni"`, `"component":"etcd"`, `"managed_context":"pg"`, `"title":"读写入口"`, `2379`, `2380`, `8008`} {
		if !strings.Contains(bodyStr, want) {
			t.Fatalf("solved plan missing %s; body=%s", want, bodyStr)
		}
	}
	// Verify raw "readwrite" did not leak as endpoint title
	if strings.Contains(bodyStr, `"title":"readwrite"`) {
		t.Fatalf("endpoint title leaked raw 'readwrite': %s", bodyStr)
	}

	// Verify legacy single-instance cluster with patroni/etcd service_units gets suggested_companions from GET /baseline
	legacyReq := importClusterReq{
		ID:           "pg-legacy-hints",
		Component:    "postgresql",
		Version:      "17",
		Hosts:        []importHostInput{{Name: "n1", IP: "10.90.1.1", Role: "primary"}, {Name: "n2", IP: "10.90.1.2", Role: "replica"}},
		ServiceUnits: []string{"patroni.service", "etcd.service"},
		ConfigPaths:  []string{"/etc/etcd/etcd.conf.yaml"},
		DataDirs:     []string{"/data/etcd", "/data"},
		Packages:     []mwpack.ImportedPkg{{Name: "pgbackrest", Version: "2.59.1"}},
	}
	lb, _ := json.Marshal(legacyReq)
	lw := storeRequest(s, "POST", "/api/clusters/import", bytes.NewReader(lb), alice, csrf)
	if lw.Code != 201 {
		t.Fatalf("import legacy cluster failed: %d %s", lw.Code, lw.Body.String())
	}
	bg := storeRequest(s, "GET", "/api/clusters/pg-legacy-hints/baseline", nil, alice, "")
	if bg.Code != 200 {
		t.Fatalf("GET legacy baseline failed: %d %s", bg.Code, bg.Body.String())
	}
	var baseResp importClusterReq
	if err := json.Unmarshal(bg.Body.Bytes(), &baseResp); err != nil {
		t.Fatal(err)
	}
	sugSet := map[string]bool{}
	for _, sc := range baseResp.SuggestedCompanions {
		sugSet[sc.Component] = true
	}
	if !sugSet["patroni"] || !sugSet["etcd"] || !sugSet["pgbackrest"] {
		t.Fatalf("expected suggested_companions patroni+etcd+pgbackrest for legacy cluster, got %+v", baseResp.SuggestedCompanions)
	}

	// Regression: negated notes ("未采集到 VIP / HAProxy") must NOT trigger false-positive HAProxy companion
	negated := inferCompanionsFromSignals(companionSignals{
		PrimaryComp:  "postgresql",
		Hosts:        parsed.Draft.Hosts,
		ServiceUnits: []string{"patroni.service", "etcd.service"},
		ArchSummary:  "3节点 Patroni + etcd 高可用集群",
		Notes:        "• 未采集到 VIP / HAProxy / Keepalived 等统一入口，待人工核对",
	})
	for _, cm := range negated {
		if cm.Component == "haproxy" || cm.Component == "keepalived" {
			t.Fatalf("negated note triggered false-positive companion: %+v", cm)
		}
	}
}

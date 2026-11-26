package server

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"delivery-studio/mwpack"
)

func TestLiveInspectScriptPassesReadOnlyGate(t *testing.T) {
	apps := []string{"postgresql", "redis", "etcd", "nginx", "haproxy", "keepalived"}
	for _, appID := range apps {
		f := clusterFacts{
			ID:      "test-" + appID,
			Current: storeJob{ID: "00000000000000000000000000000001", AppID: appID, Version: "1.0"},
		}
		dep := &mwpack.Deployment{
			ID:           f.ID,
			DeliveryMode: "imported",
			Imported: &mwpack.ImportedMeta{
				ServiceUnits: []string{appID + ".service"},
				ConfigPaths:  []string{"/etc/" + appID + "/" + appID + ".conf"},
				DataDirs:     []string{"/var/lib/" + appID},
			},
			Instances: []mwpack.InstanceSpec{
				{ID: "main", Component: appID, Params: map[string]any{"port": 5432}},
			},
		}
		script := buildLiveInspectScript(f, dep, clusterBaselineOverrides{})
		ok, warns := validateReadOnlyProbeScriptLang(script, "zh-CN")
		if !ok || len(warns) > 0 {
			t.Fatalf("app=%s live inspect script failed static read-only gate: ok=%v warns=%v\nscript:\n%s", appID, ok, warns, script)
		}
	}
}

func TestNonDestructiveLiveMergePreservesOnboardedData(t *testing.T) {
	s, _ := testStore(t)
	adminCookie, csrf := storeLogin(t, s, "admin")

	// 1. Onboard a brownfield PostgreSQL cluster with 3 hosts, external VIP/ELB endpoint, custom notes, companion, and custom param.
	impBody := `{
		"id": "pg-non-destructive",
		"component": "postgresql",
		"display_name": "PostgreSQL",
		"version": "17",
		"platform": "ubuntu2404",
		"deploy_method": "systemd",
		"hosts": [
			{"name": "pg-node-1", "ip": "10.20.1.11", "role": "primary"},
			{"name": "pg-node-2", "ip": "10.20.1.12", "role": "replica"},
			{"name": "pg-node-3", "ip": "10.20.1.13", "role": "replica"}
		],
		"endpoints": [
			{"name": "rw-vip", "title": "云厂商负载均衡 VIP", "protocol": "tcp", "address": "pg-vip.corp.internal", "port": 5432}
		],
		"companions": [
			{"component": "pgbackrest", "display_name": "pgBackRest", "kind": "backup", "version": "2.53"}
		],
		"params": {
			"max_connections": "200",
			"archive_command": "/opt/corp/archive_wal.sh %p"
		},
		"notes": "生产核心账务库，仅允许周三 02:00-04:00 窗口变更"
	}`
	iw := storeRequest(s, "POST", "/api/clusters/import", strings.NewReader(impBody), adminCookie, csrf)
	if iw.Code != 200 && iw.Code != 201 {
		t.Fatalf("import cluster failed: code=%d body=%s", iw.Code, iw.Body.String())
	}

	// 2. Simulate partial host live telemetry on ONLY pg-node-1 (10.20.1.11):
	//    - Updates max_connections -> 500, adds shared_buffers=8GB, ssl=on
	//    - Reports Patroni companion + real Debian packages
	//    - Must NOT delete pg-node-2, pg-node-3, rw-vip endpoint, notes, pgbackrest companion, or archive_command!
	probeText := strings.Join([]string{
		"@@MW_HOST_BEGIN@@",
		"HOSTNAME=pg-node-1",
		"IPS=10.20.1.11",
		"OS_PRETTY=Ubuntu 24.04.1 LTS",
		"KERNEL=6.8.0-45-generic",
		"@@MW_HOST_END@@",
		"@@MW_SERVICES_BEGIN@@",
		"SVC|patroni.service|active|running",
		"SVC|postgresql@17-main.service|active|running",
		"PORT|0.0.0.0:5432",
		"@@MW_SERVICES_END@@",
		"@@MW_PATHS_BEGIN@@",
		"CFG|/etc/patroni/patroni.yml",
		"DATA|/var/lib/postgresql",
		"@@MW_PATHS_END@@",
		"@@MW_RUNTIME_BEGIN@@",
		"VER|postgresql|psql (PostgreSQL) 17.2",
		"ROLE|replica",
		"PARAM|max_connections=500",
		"PARAM|shared_buffers=8GB",
		"PARAM|ssl=on",
		"CIDR|10.20.0.0/16",
		"@@MW_RUNTIME_END@@",
		"@@MW_PKGS_BEGIN@@",
		"DEB|postgresql-17|17.2-1.pgdg24.04+1",
		"DEB|openssl|3.0.13-0ubuntu3.4",
		"@@MW_PKGS_END@@",
	}, "\n")

	body, _ := json.Marshal(map[string]any{
		"host":         "pg-node-1",
		"ip":           "10.20.1.11",
		"probe_output": probeText,
	})
	pw := storeRequest(s, "POST", "/api/clusters/pg-non-destructive/live-state/parse-probe", bytes.NewReader(body), adminCookie, csrf)
	if pw.Code != 200 {
		t.Fatalf("parse-probe failed: code=%d body=%s", pw.Code, pw.Body.String())
	}

	// 3. Verify imported baseline preserved EVERY pre-existing asset while enriching measured fields
	bw := storeRequest(s, "GET", "/api/clusters/pg-non-destructive/baseline", nil, adminCookie, "")
	if bw.Code != 200 {
		t.Fatalf("get baseline failed: code=%d body=%s", bw.Code, bw.Body.String())
	}
	var base importClusterReq
	if err := json.Unmarshal(bw.Body.Bytes(), &base); err != nil {
		t.Fatalf("decode baseline: %v", err)
	}
	if len(base.Hosts) != 3 {
		t.Fatalf("expected all 3 hosts preserved, got %d", len(base.Hosts))
	}
	if len(base.Endpoints) != 1 || base.Endpoints[0].Address != "pg-vip.corp.internal" {
		t.Fatalf("expected external VIP endpoint preserved, got %+v", base.Endpoints)
	}
	if !strings.Contains(base.Notes, "周三 02:00-04:00") {
		t.Fatalf("expected custom notes preserved, got %q", base.Notes)
	}
	if base.Params["archive_command"] != "/opt/corp/archive_wal.sh %p" {
		t.Fatalf("expected unprobed archive_command preserved, got %v", base.Params["archive_command"])
	}
	if base.Params["max_connections"] != "500" {
		t.Fatalf("expected probed max_connections updated to 500, got %v", base.Params["max_connections"])
	}
	if base.ExactVersion != "17.2" {
		t.Fatalf("expected ExactVersion=17.2, got %q", base.ExactVersion)
	}
	hasPgBackRest, hasPatroni := false, false
	for _, cp := range base.Companions {
		if cp.Component == "pgbackrest" {
			hasPgBackRest = true
		}
		if cp.Component == "patroni" {
			hasPatroni = true
		}
	}
	if !hasPgBackRest || !hasPatroni {
		t.Fatalf("expected both existing pgbackrest and newly detected patroni companions, got %+v", base.Companions)
	}

	// 4. Verify SBOM indexes the real live packages specifically for pg-non-destructive
	inv := s.extractSBOM()
	foundLiveOpenSSL := false
	for _, it := range inv.Items {
		if it.Package == "openssl" && it.Version == "3.0.13-0ubuntu3.4" && contains(it.Components, "live:pg-non-destructive") {
			foundLiveOpenSSL = true
			break
		}
	}
	if !foundLiveOpenSSL {
		t.Fatalf("expected extractSBOM to index live host package openssl under live:pg-non-destructive")
	}
}

func TestOfflineRehearsalSyncsSecurityBaselineAndPolicy(t *testing.T) {
	s, _ := testStore(t)
	adminCookie, csrf := storeLogin(t, s, "admin")

	impBody := `{
		"id": "pg-sec-closed-loop",
		"component": "postgresql",
		"display_name": "PostgreSQL",
		"version": "17",
		"platform": "ubuntu2404",
		"hosts": [
			{"name": "db1", "ip": "10.30.1.11", "role": "primary"},
			{"name": "db2", "ip": "10.30.1.12", "role": "replica"}
		],
		"params": {
			"tls": "false",
			"max_connections": "100"
		}
	}`
	if iw := storeRequest(s, "POST", "/api/clusters/import", strings.NewReader(impBody), adminCookie, csrf); iw.Code != 200 && iw.Code != 201 {
		t.Fatalf("import failed: %d %s", iw.Code, iw.Body.String())
	}

	// Record an applied production rehearsal turning on TLS in pure offline mode (no Agent)
	rh := changeRehearsal{
		ID:        "aa11bb22cc33",
		ClusterID: "pg-sec-closed-loop",
		Title:     "开启 PostgreSQL TLS 传输加密",
		Stage:     "finalized",
		Applied:   true,
		AppliedBy: "admin",
		AppliedAt: nowStamp(),
		AppliedChanges: []rehearsalAppliedChange{
			{Key: "tls", Before: "false", After: "true"},
		},
		CreatedAt: nowStamp(),
		UpdatedAt: nowStamp(),
	}
	if err := s.saveRehearsal(rh); err != nil {
		t.Fatalf("saveRehearsal: %v", err)
	}
	s.syncAppliedRehearsalsToClusterState("pg-sec-closed-loop", "admin")

	// Security audit must now reflect Applied Baseline (tls_enabled == pass) without any Agent!
	sw := storeRequest(s, "GET", "/api/clusters/pg-sec-closed-loop/security", nil, adminCookie, "")
	if sw.Code != 200 {
		t.Fatalf("security failed: %d %s", sw.Code, sw.Body.String())
	}
	var secRep clusterSecurityReport
	_ = json.Unmarshal(sw.Body.Bytes(), &secRep)
	if secRep.DataSource != clusterSourceAppliedBaseline {
		t.Fatalf("expected DataSource=%s, got %s", clusterSourceAppliedBaseline, secRep.DataSource)
	}
	tlsPassed := false
	for _, ck := range secRep.BaselineChecks {
		if ck.ID == "tls_enabled" && ck.Status == "pass" {
			tlsPassed = true
		}
	}
	if !tlsPassed {
		t.Fatalf("expected tls_enabled baseline check to pass after offline applied rehearsal, checks=%+v", secRep.BaselineChecks)
	}

	// Update auto-inspect policy via API
	polW := storeRequest(s, "PUT", "/api/clusters/pg-sec-closed-loop/live-state/policy",
		strings.NewReader(`{"auto_inspect_enabled":true,"auto_inspect_interval_sec":900,"inspect_on_bind":true}`), adminCookie, csrf)
	if polW.Code != 200 {
		t.Fatalf("policy update failed: %d %s", polW.Code, polW.Body.String())
	}
	rec := s.loadClusterStateRecord("pg-sec-closed-loop")
	if !rec.ProbePolicy.AutoInspectEnabled || rec.ProbePolicy.AutoInspectIntervalSec != 900 {
		t.Fatalf("unexpected saved probe policy: %+v", rec.ProbePolicy)
	}
}

func TestConfigurableAgentHeartbeatPolicyAndPoll(t *testing.T) {
	s, _ := testStore(t)
	adminCookie, csrf := storeLogin(t, s, "admin")

	// 1. Update global default heartbeat interval to 15s
	gw := storeRequest(s, "PATCH", "/api/executions/unified-agents",
		strings.NewReader(`{"default_heartbeat_sec":15}`), adminCookie, csrf)
	if gw.Code != 200 {
		t.Fatalf("global heartbeat update failed: %d %s", gw.Code, gw.Body.String())
	}

	// 2. Enroll a new Agent (inherits 15s default)
	cw := storeRequest(s, "POST", "/api/executions/unified-agents",
		strings.NewReader(`{"name":"hb-runner-1","ip":"10.40.1.10"}`), adminCookie, csrf)
	if cw.Code != 201 {
		t.Fatalf("enroll agent failed: %d %s", cw.Code, cw.Body.String())
	}
	var enrolled struct {
		Agent unifiedAgentView `json:"agent"`
		Token string           `json:"token"`
	}
	_ = json.Unmarshal(cw.Body.Bytes(), &enrolled)
	if enrolled.Agent.EffectiveHeartbeatSec != 15 {
		t.Fatalf("expected EffectiveHeartbeatSec=15 from global policy, got %d", enrolled.Agent.EffectiveHeartbeatSec)
	}

	// 3. Override this specific Agent's heartbeat interval to 30s
	pw := storeRequest(s, "PATCH", "/api/executions/unified-agents",
		strings.NewReader(`{"id":"`+enrolled.Agent.ID+`","heartbeat_interval_sec":30}`), adminCookie, csrf)
	if pw.Code != 200 {
		t.Fatalf("per-agent heartbeat update failed: %d %s", pw.Code, pw.Body.String())
	}

	// 4. Verify runner /api/execution-agent/poll receives heartbeat_interval_sec=30 and online timeout scales > 90s
	if agentOnlineTimeout(30, nil) < 90*time.Second {
		t.Fatalf("expected online timeout for 30s heartbeat >= 90s, got %v", agentOnlineTimeout(30, nil))
	}
	pollReq := httptest.NewRequest("POST", "http://127.0.0.1:8090/api/execution-agent/poll",
		strings.NewReader(`{"version":"test","protocol":3,"heartbeat":true}`))
	pollReq.Header.Set("Authorization", "Bearer "+enrolled.Token)
	pollReq.Header.Set("Content-Type", "application/json")
	pollW := httptest.NewRecorder()
	s.ServeHTTP(pollW, pollReq)
	if pollW.Code != 200 {
		t.Fatalf("runner poll failed: %d %s", pollW.Code, pollW.Body.String())
	}
	var pollResp struct {
		HeartbeatIntervalSec int `json:"heartbeat_interval_sec"`
	}
	_ = json.Unmarshal(pollW.Body.Bytes(), &pollResp)
	if pollResp.HeartbeatIntervalSec != 30 {
		t.Fatalf("expected poll heartbeat_interval_sec=30, got %d", pollResp.HeartbeatIntervalSec)
	}
}

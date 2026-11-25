package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"delivery-studio/mwpack"
)

func hasBaseline(items []formBaseline, id string) bool {
	for _, it := range items {
		if it.ID == id {
			return true
		}
	}
	return false
}

func TestEvaluateFormBaselinesPostgreSQL(t *testing.T) {
	s, _ := testStore(t)
	cat := s.plat.cat()

	// Scenario 1: PG 17 native replication — peer disks empty, TLS off, default lock_waits=false,
	// idle_in_transaction_session_timeout=0, no app_user, no LB entry.
	dep := &mwpack.Deployment{
		Schema:   mwpack.DeploymentSchema,
		ID:       "pg-native-base",
		Platform: "ubuntu-24.04-amd64",
		Hosts: []mwpack.Host{
			{Name: "node-01", IP: "172.30.2.44", Disk: "/dev/vdb"},
			{Name: "node-02", IP: "172.30.2.50", Disk: ""},
			{Name: "node-03", IP: "172.30.2.61", Disk: ""},
		},
		Instances: []mwpack.InstanceSpec{{
			ID:        "pg",
			Component: "postgresql",
			Placement: map[string][]string{
				"primary": {"node-01"},
				"replica": {"node-02", "node-03"},
			},
			Params: map[string]any{
				"deployment_mode": "replication",
				"replication":     "async",
				"client_cidr":     "172.30.2.0/24",
				"tls":             false,
				"tde":             false,
			},
		}},
	}
	plan := mwpack.Solve(cat, dep)
	if errs := plan.Errors(); len(errs) > 0 {
		t.Fatalf("unexpected solve errors: %+v", errs)
	}
	items := evaluateFormBaselines(plan, dep)

	for _, want := range []string{
		"host-disk-missing",
		"pg-log-lock-waits",
		"pg-idle-tx-timeout",
		"pg-tls-disabled",
		"pg-app-user-empty",
		"pg-backup-policy",
		"ha-no-access-entry",
	} {
		if !hasBaseline(items, want) {
			t.Errorf("expected baseline %q, got %+v", want, items)
		}
	}
	// TDE is NOT visible in native replication mode — must NEVER be falsely suggested!
	if hasBaseline(items, "pg-tde-disabled") {
		t.Errorf("pg-tde-disabled should not appear for replication mode: %+v", items)
	}
	// Action-level items (missing peer disks) must sort first.
	if len(items) == 0 || items[0].ID != "host-disk-missing" || items[0].Severity != "action" {
		t.Errorf("expected host-disk-missing first with severity=action, got %+v", items)
	}
	if !strings.Contains(items[0].ActionPrompt, "/dev/vdb") || !strings.Contains(items[0].ActionPrompt, "node-02") {
		t.Errorf("expected ActionPrompt to propose /dev/vdb for peer nodes, got %q", items[0].ActionPrompt)
	}

	// Scenario 2: Once all baselines are applied (unified disks, lock_waits, idle_tx, TLS on,
	// app_user, tuned backup, external-lb entry), baseline findings drop to zero!
	depClean := &mwpack.Deployment{
		Schema:   mwpack.DeploymentSchema,
		ID:       "pg-clean",
		Platform: "ubuntu-24.04-amd64",
		Hosts: []mwpack.Host{
			{Name: "node-01", IP: "172.30.2.44", Disk: "/dev/vdb"},
			{Name: "node-02", IP: "172.30.2.50", Disk: "/dev/vdb"},
			{Name: "node-03", IP: "172.30.2.61", Disk: "/dev/vdb"},
		},
		Instances: []mwpack.InstanceSpec{
			{
				ID:        "pg",
				Component: "postgresql",
				Placement: map[string][]string{
					"primary": {"node-01"},
					"replica": {"node-02", "node-03"},
				},
				Params: map[string]any{
					"deployment_mode":                     "replication",
					"replication":                         "async",
					"client_cidr":                         "172.30.2.0/24",
					"tls":                                 true,
					"tde":                                 false,
					"log_lock_waits":                      true,
					"log_min_duration_statement":          500,
					"idle_in_transaction_session_timeout": 300000,
					"app_user":                            "app_admin",
					"backup_retention_full":               3,
					"retention_diff":                      3,
					"archive_timeout":                     300,
				},
			},
			{
				ID:        "lb",
				Component: "external-lb",
				Params: map[string]any{
					"mode":    "ip",
					"address": "172.30.2.120",
				},
				Binds: []mwpack.BindSpec{{Endpoint: "pg.writer", Listen: 5432}},
			},
		},
	}
	planClean := mwpack.Solve(cat, depClean)
	cleanItems := evaluateFormBaselines(planClean, depClean)
	if len(cleanItems) != 0 {
		t.Errorf("expected 0 baseline issues for hardened PG spec, got %+v", cleanItems)
	}
}

func TestEvaluateFormBaselinesRedisAndEtcd(t *testing.T) {
	s, _ := testStore(t)
	cat := s.plat.cat()

	// Redis defaults: persistence=none, disable_swap=false, client_timeout=0, loglevel=debug
	redisDep := &mwpack.Deployment{
		Schema:   mwpack.DeploymentSchema,
		ID:       "redis-base",
		Platform: "ubuntu-24.04-amd64",
		Hosts: []mwpack.Host{
			{Name: "r1", IP: "10.0.1.11", Disk: "/dev/vdb"},
			{Name: "r2", IP: "10.0.1.12", Disk: "/dev/vdb"},
			{Name: "r3", IP: "10.0.1.13", Disk: "/dev/vdb"},
		},
		Instances: []mwpack.InstanceSpec{{
			ID:        "redis",
			Component: "redis",
			Placement: map[string][]string{
				"primary": {"r1"},
				"replica": {"r2", "r3"},
			},
			Params: map[string]any{
				"loglevel": "debug",
			},
		}},
	}
	rItems := evaluateFormBaselines(mwpack.Solve(cat, redisDep), redisDep)
	for _, want := range []string{"redis-persistence-none", "redis-logging", "redis-swap-enabled", "redis-client-timeout"} {
		if !hasBaseline(rItems, want) {
			t.Errorf("expected Redis baseline %q, got %+v", want, rItems)
		}
	}

	// etcd single-node + debug log
	etcdDep := &mwpack.Deployment{
		Schema:   mwpack.DeploymentSchema,
		ID:       "etcd-base",
		Platform: "ubuntu-24.04-amd64",
		Hosts: []mwpack.Host{
			{Name: "e1", IP: "10.0.2.11", Disk: "/dev/vdb"},
		},
		Instances: []mwpack.InstanceSpec{{
			ID:        "etcd",
			Component: "etcd",
			Placement: map[string][]string{"member": {"e1"}},
			Params:    map[string]any{"log_level": "debug"},
		}},
	}
	eItems := evaluateFormBaselines(mwpack.Solve(cat, etcdDep), etcdDep)
	if !hasBaseline(eItems, "etcd-single-node") || !hasBaseline(eItems, "etcd-log-debug") {
		t.Errorf("expected etcd single-node & debug log baselines, got %+v", eItems)
	}
}

func TestFillFormAttachesBaselinesAndMergesAINotes(t *testing.T) {
	s, _ := testStore(t)
	orig := &mwpack.Deployment{
		Schema:   mwpack.DeploymentSchema,
		Platform: "ubuntu-24.04-amd64",
		Hosts:    []mwpack.Host{{Name: "node-01", IP: "", Disk: "/dev/vdb"}},
		Instances: []mwpack.InstanceSpec{{
			ID:        "pg",
			Component: "postgresql",
			Placement: map[string][]string{"primary": {"node-01"}},
		}},
	}
	dep := &mwpack.Deployment{
		Schema:   mwpack.DeploymentSchema,
		ID:       "pg-card-test",
		Platform: "ubuntu-24.04-amd64",
		Hosts: []mwpack.Host{
			{Name: "node-01", IP: "172.30.2.44", Disk: "/dev/vdb"},
			{Name: "node-02", IP: "172.30.2.50", Disk: ""},
		},
		Instances: []mwpack.InstanceSpec{{
			ID:        "pg",
			Component: "postgresql",
			Placement: map[string][]string{
				"primary": {"node-01"},
				"replica": {"node-02"},
			},
			Params: map[string]any{
				"deployment_mode": "replication",
				"replication":     "async",
				"client_cidr":     "172.30.2.0/24",
				"tls":             false,
				"tde":             false,
			},
		}},
	}
	rawArgs, _ := json.Marshal(map[string]any{
		"deployment": dep,
		"summary":    "原生主从一主一从",
		"baseline_notes": []map[string]any{{
			"category":    "resource",
			"severity":    "warn",
			"title":       "共享缓冲区尚未按 64G 内存调优",
			"detail":      "当前沿用默认 2GB，按 64GB 宿主机 25% 建议设为 16GB。",
			"current":     "2GB",
			"recommended": "16GB",
			"section":     "params",
		}},
	})
	rec := httptest.NewRecorder()
	fc := &formCtx{
		s:        s,
		app:      "postgresql",
		state:    &formState{Deployment: orig},
		ev:       sse{w: rec, f: rec},
		messages: []aiMsg{{Role: "user", Text: "使用原生主从方案"}},
	}
	out := fc.run("fill_form", string(rawArgs))
	if fc.filled == nil || !fc.filled.BaselineChecked {
		t.Fatalf("expected filled with BaselineChecked=true, got %+v; out=%s", fc.filled, out)
	}
	if !hasBaseline(fc.filled.Baselines, "host-disk-missing") || !hasBaseline(fc.filled.Baselines, "pg-log-lock-waits") || !hasBaseline(fc.filled.Baselines, "ai-baseline-1") {
		t.Fatalf("missing expected baselines (including merged AI warn note): %+v", fc.filled.Baselines)
	}
	if !strings.Contains(out, "生产基线自动巡检") {
		t.Fatalf("expected tool response to summarize baselines for AI, got: %s", out)
	}
	if !strings.Contains(rec.Body.String(), `"baselines"`) || !strings.Contains(rec.Body.String(), `"baseline_checked":true`) {
		t.Fatalf("expected SSE form event to carry baselines payload, got: %s", rec.Body.String())
	}
}

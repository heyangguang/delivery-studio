package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"middleware-deployer/mwpack"
)

func TestConsolidateLegacyChangeDeliveries(t *testing.T) {
	s, _ := testStore(t)

	writeFile := func(path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", path, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	seedJob := func(j storeJob, specYML, planJSON string) {
		t.Helper()
		dir := s.jobDir(j.ID)
		writeFile(filepath.Join(dir, "deployment.yml"), specYML)
		writeFile(filepath.Join(dir, "output", "部署规格.yml"), specYML)
		writeFile(filepath.Join(dir, "output", "plan.json"), planJSON)
		s.mu.Lock()
		s.jobs[j.ID] = j
		s.mu.Unlock()
		if err := s.persistJob(j); err != nil {
			t.Fatalf("persist job %s: %v", j.ID, err)
		}
	}

	// ---- Scenario 1: Finished legacy addons change (pg-blackduck style) ----
	bdBaseID := "28db30c3a4f2edd7c84efed00f97b32b"
	bdLegID := "48b2afd570b43670b63edca2c4b98cea"
	seedJob(storeJob{
		ID: bdBaseID, ClusterID: "pg-blackduck", AppID: "postgresql", AppName: "PostgreSQL",
		Version: "17", Owner: "admin", State: "succeeded", Outcome: outcomeDone, Seq: 0,
		Created: "2026-10-27T19:32:00Z", Marked: "2026-10-28T14:44:34Z", MarkedBy: "admin",
	}, `schema: mwdeploy/v1
id: pg-blackduck
controller: node-1
platform: ubuntu-24.04-amd64
hosts:
  - name: node-1
    ip: 172.30.4.26
    disk: /dev/vdb
    initialize: true
instances:
  - id: pg
    component: postgresql
    version: "17"
    placement:
      primary: [node-1]
    params:
      client_cidr: 172.30.4.0/24
    addons: []
change: null
pins: {}
`, `{"cluster":"pg-blackduck","project":"pg-blackduck","hosts":[{"name":"node-1","ip":"172.30.4.26"}],"instances":[{"id":"pg-dcs","component":"etcd","auto":true,"version":"3.5"},{"id":"pg","component":"postgresql","version":"17","params":{"client_cidr":"172.30.4.0/24","test_sslmode":"verify-full"}}],"prepare":[{"id":"p1"}]}`)

	seedJob(storeJob{
		ID: bdLegID, ClusterID: "pg-blackduck", AppID: "postgresql", AppName: "PostgreSQL",
		Version: "17", Owner: "admin", State: "succeeded", Outcome: outcomeDone, Seq: 1,
		Created: "2026-10-28T13:59:00Z", Marked: "2026-10-28T14:44:39Z", MarkedBy: "admin",
	}, `schema: mwdeploy/v1
id: pg-blackduck
controller: node-1
platform: ubuntu-24.04-amd64
hosts:
  - name: node-1
    ip: 172.30.4.26
    disk: /dev/vdb
    initialize: false
instances:
  - id: pg
    component: postgresql
    version: "17"
    placement:
      primary: [node-1]
    params:
      client_cidr: 172.30.4.0/24
    addons:
      - id: pgcrypto
      - id: hstore
      - id: pg_trgm
  - id: pg-dcs
    component: etcd
    version: "3.5"
    placement:
      member: [node-1]
change:
  from: pg-blackduck
  intent: config
  seq: 1
pins: {}
`, `{"cluster":"pg-blackduck","project":"pg-blackduck.01","change":true,"hosts":[{"name":"node-1","ip":"172.30.4.26"}],"instances":[{"id":"pg","component":"postgresql","version":"17","params":{"client_cidr":"172.30.4.0/24"}}],"prepare":[{"id":"change-only"}]}`)

	// ---- Scenario 2: Finished legacy ELB port change + AI chats (pg-sonarqube style) ----
	sqBaseID := "4370a8ee66009f872ffd56a730f9d2bf"
	sqLegID := "fdb019d3369c2f1e1aa7529a52119a7d"
	seedJob(storeJob{
		ID: sqBaseID, ClusterID: "pg-sonarqube", AppID: "postgresql", AppName: "PostgreSQL",
		Version: "17", Owner: "admin", State: "succeeded", Outcome: outcomeDone, Seq: 0,
		Created: "2026-10-27T18:03:00Z", Marked: "2026-10-28T14:44:49Z", MarkedBy: "admin",
	}, `schema: mwdeploy/v1
id: pg-sonarqube
controller: node-1
platform: ubuntu-24.04-amd64
hosts:
  - name: node-1
    ip: 172.30.4.24
    initialize: true
instances:
  - id: pg
    component: postgresql
    version: "17"
    placement:
      primary: [node-1]
    params:
      client_cidr: 172.30.4.0/24
  - id: elb
    component: external-lb
    version: "1"
    params:
      address: sq.example.com
    binds:
      - endpoint: pg.writer
        listen: 5432
change: null
`, `{"cluster":"pg-sonarqube","project":"pg-sonarqube","hosts":[{"name":"node-1","ip":"172.30.4.24"}],"instances":[{"id":"pg","component":"postgresql","version":"17","fronts":{"writer":{"balancer":"elb","listen":5432,"address":"sq.example.com"}}}],"prepare":[{"id":"orig-prep"}]}`)

	seedJob(storeJob{
		ID: sqLegID, ClusterID: "pg-sonarqube", AppID: "postgresql", AppName: "PostgreSQL",
		Version: "17", Owner: "admin", State: "succeeded", Outcome: outcomeDone, Seq: 1,
		Created: "2026-10-28T14:01:00Z", Marked: "2026-10-28T14:44:51Z", MarkedBy: "admin",
	}, `schema: mwdeploy/v1
id: pg-sonarqube
controller: node-1
platform: ubuntu-24.04-amd64
hosts:
  - name: node-1
    ip: 172.30.4.24
    initialize: false
instances:
  - id: pg
    component: postgresql
    version: "17"
    placement:
      primary: [node-1]
    params:
      client_cidr: 172.30.4.0/24
  - id: elb
    component: external-lb
    version: "1"
    params:
      address: sq.example.com
    binds:
      - endpoint: pg.writer
        listen: 5434
change:
  from: pg-sonarqube
  intent: config
  seq: 1
`, `{"cluster":"pg-sonarqube","project":"pg-sonarqube.01","change":true,"hosts":[{"name":"node-1","ip":"172.30.4.24"}],"instances":[{"id":"pg","component":"postgresql","version":"17","fronts":{"writer":{"balancer":"elb","listen":5434,"address":"sq.example.com"}}}]}`)

	// Seed colliding "review" AI chat sessions on both sqBase and sqLeg, plus an image on sqLeg.
	baseReviewID := sessionID("review")
	writeFile(filepath.Join(s.aiDir(sqBaseID), "sessions", baseReviewID+".json"), `{"id":"`+baseReviewID+`","key":"review","kind":"review","title":"原始对话","messages":[{"role":"user","text":"base msg","at":"2026-10-27T19:00:00Z"}]}`)
	writeFile(filepath.Join(s.aiDir(sqLegID), "sessions", baseReviewID+".json"), `{"id":"`+baseReviewID+`","key":"review","kind":"review","title":"旧变更对话","messages":[{"role":"user","text":"legacy secret question","at":"2026-10-28T16:19:12Z"}]}`)
	writeFile(filepath.Join(s.aiDir(sqLegID), "img", "abc123.png"), "png-bytes")

	// ---- Scenario 3: Voided legacy change (pg-bitbucket style — must NOT merge wrong port) ----
	bbBaseID := "3ef12f3dc0c6201ab813906de83063c4"
	bbLegID := "63229da7c99e42a749e75a2d519b2d8f"
	seedJob(storeJob{
		ID: bbBaseID, ClusterID: "pg-bitbucket", AppID: "postgresql", AppName: "PostgreSQL",
		Version: "17", Owner: "admin", State: "succeeded", Outcome: outcomeDone, Seq: 0,
		Created: "2026-10-27T18:42:00Z", Marked: "2026-10-28T13:36:55Z", MarkedBy: "admin",
	}, `schema: mwdeploy/v1
id: pg-bitbucket
controller: node-1
platform: ubuntu-24.04-amd64
hosts:
  - name: node-1
    ip: 172.30.4.27
    initialize: true
instances:
  - id: pg
    component: postgresql
    version: "17"
    placement:
      primary: [node-1]
    params:
      client_cidr: 172.30.4.0/24
change: null
`, `{"cluster":"pg-bitbucket","project":"pg-bitbucket","instances":[{"id":"pg","component":"postgresql","params":{"pg_port":5432}}]}`)

	seedJob(storeJob{
		ID: bbLegID, ClusterID: "pg-bitbucket", AppID: "postgresql", AppName: "PostgreSQL",
		Version: "17", Owner: "admin", State: "succeeded", Outcome: outcomeVoid, OutcomeNote: "改错了呀", Seq: 1,
		Created: "2026-10-28T07:40:00Z", Marked: "2026-10-28T10:25:23Z", MarkedBy: "admin",
	}, `schema: mwdeploy/v1
id: pg-bitbucket
controller: node-1
platform: ubuntu-24.04-amd64
hosts:
  - name: node-1
    ip: 172.30.4.27
    initialize: false
instances:
  - id: pg
    component: postgresql
    version: "17"
    placement:
      primary: [node-1]
    params:
      client_cidr: 172.30.4.0/24
      pg_port: 5435
change:
  from: pg-bitbucket
  intent: config
  seq: 1
`, `{"cluster":"pg-bitbucket","project":"pg-bitbucket.01","change":true,"instances":[{"id":"pg","component":"postgresql","params":{"pg_port":5435}}]}`)

	// Execute consolidation migration
	s.consolidateLegacyChangeDeliveries()

	// Verify legacy jobs are deleted from memory and disk
	for _, gone := range []string{bdLegID, sqLegID, bbLegID} {
		s.mu.Lock()
		_, stillInMem := s.jobs[gone]
		s.mu.Unlock()
		if stillInMem {
			t.Fatalf("legacy job %s still in s.jobs after consolidation", gone)
		}
		if _, err := os.Stat(s.jobDir(gone)); !os.IsNotExist(err) {
			t.Fatalf("legacy job dir %s still exists after consolidation", gone)
		}
	}

	// Verify Scenario 1 (pg-blackduck): addons merged, initialize:true preserved, auto pg-dcs not duplicated, sync param preserved
	bdBytes, err := os.ReadFile(filepath.Join(s.jobDir(bdBaseID), "deployment.yml"))
	if err != nil {
		t.Fatalf("read merged bd spec: %v", err)
	}
	bdDep, err := mwpack.ParseDeployment(bdBytes)
	if err != nil {
		t.Fatalf("parse merged bd spec: %v", err)
	}
	if !bdDep.Hosts[0].Initialize {
		t.Fatalf("expected initial host initialize=true preserved")
	}
	if len(bdDep.Instances) != 1 || len(bdDep.Instances[0].Addons) != 3 {
		t.Fatalf("expected 1 instance with 3 addons (no auto pg-dcs clutter), got %+v", bdDep.Instances)
	}
	bdPlanRaw, _ := os.ReadFile(filepath.Join(s.jobDir(bdBaseID), "output", "plan.json"))
	if !strings.Contains(string(bdPlanRaw), `"test_sslmode": "verify-full"`) || !strings.Contains(string(bdPlanRaw), `"id": "p1"`) {
		t.Fatalf("expected base plan.json sync params and prepare runbook preserved, got:\n%s", string(bdPlanRaw))
	}

	// Verify Scenario 2 (pg-sonarqube): ELB listen 5434 merged in deployment.yml & plan.json, AI chat & image migrated safely
	sqBytes, _ := os.ReadFile(filepath.Join(s.jobDir(sqBaseID), "deployment.yml"))
	sqDep, err := mwpack.ParseDeployment(sqBytes)
	if err != nil {
		t.Fatalf("parse merged sq spec: %v", err)
	}
	if len(sqDep.Instances) != 2 || len(sqDep.Instances[1].Binds) != 1 || sqDep.Instances[1].Binds[0].Listen != 5434 {
		t.Fatalf("expected elb listen=5434 merged into deployment.yml, got %+v", sqDep.Instances)
	}
	sqPlanRaw, _ := os.ReadFile(filepath.Join(s.jobDir(sqBaseID), "output", "plan.json"))
	var sqPlan map[string]any
	if err := json.Unmarshal(sqPlanRaw, &sqPlan); err != nil {
		t.Fatalf("unmarshal merged sq plan: %v", err)
	}
	if !strings.Contains(string(sqPlanRaw), `"listen": 5434`) || !strings.Contains(string(sqPlanRaw), `"id": "orig-prep"`) {
		t.Fatalf("expected plan.json listen=5434 and original prepare preserved:\n%s", string(sqPlanRaw))
	}
	sessFiles, _ := filepath.Glob(filepath.Join(s.aiDir(sqBaseID), "sessions", "*.json"))
	if len(sessFiles) != 2 {
		t.Fatalf("expected both base and migrated legacy AI sessions preserved (2 files), got %d", len(sessFiles))
	}
	if !fileExistsRegular(filepath.Join(s.aiDir(sqBaseID), "img", "abc123.png")) {
		t.Fatalf("expected legacy AI image migrated to base job")
	}

	// Verify Scenario 3 (pg-bitbucket): voided change pruned WITHOUT merging pg_port=5435
	bbBytes, _ := os.ReadFile(filepath.Join(s.jobDir(bbBaseID), "deployment.yml"))
	bbDep, err := mwpack.ParseSavedDeployment(bbBytes)
	if err != nil {
		t.Fatalf("parse bb spec: %v", err)
	}
	if _, hasWrongPort := bbDep.Instances[0].Params["pg_port"]; hasWrongPort {
		t.Fatalf("voided legacy change must NOT merge pg_port into base spec: %+v", bbDep.Instances[0].Params)
	}

	// Verify idempotency: running a second time changes nothing
	s.consolidateLegacyChangeDeliveries()
	s.mu.Lock()
	remaining := len(s.jobs)
	s.mu.Unlock()
	if remaining != 3 {
		t.Fatalf("expected 3 consolidated base jobs remaining, got %d", remaining)
	}
}

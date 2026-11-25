package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRehearsalRolloutPropagateGateStrictPrecheckAndBoard(t *testing.T) {
	s, cfg := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	srv, _ := fakeModel(t)
	enableAI(t, s, srv.URL, 1)

	// Create 3 PostgreSQL clusters (origin + exact match target + standalone mismatch target) and 1 Redis cluster.
	createCluster := func(id, ip1, ip2, ip3 string, standalone bool) string {
		var body string
		if standalone {
			body = `{"id":"` + id + `","hosts":[{"name":"` + id + `-1","ip":"` + ip1 + `","disk":"/dev/vdb"}],"instances":[{"id":"pg","component":"postgresql","version":"17","placement":{"primary":["` + id + `-1"]},"params":{"client_cidr":"10.0.0.0/8","tls":false}}]}`
		} else {
			body = `{"id":"` + id + `","hosts":[{"name":"` + id + `-1","ip":"` + ip1 + `","disk":"/dev/vdb"},{"name":"` + id + `-2","ip":"` + ip2 + `","disk":"/dev/vdb"},{"name":"` + id + `-3","ip":"` + ip3 + `","disk":"/dev/vdb"}],"instances":[{"id":"pg","component":"postgresql","version":"17","placement":{"primary":["` + id + `-1"],"replica":["` + id + `-2","` + id + `-3"]},"params":{"client_cidr":"10.0.0.0/8","tls":false}},{"id":"etcd","component":"etcd","placement":{"member":["` + id + `-1","` + id + `-2","` + id + `-3"]}}]}`
		}
		cw := storeCreate(t, s, alice, csrf, body, nil)
		s.wg.Wait()
		if cw.Code != 202 {
			t.Fatalf("create %s: %d %s", id, cw.Code, cw.Body.String())
		}
		var job storeJob
		if err := json.Unmarshal(cw.Body.Bytes(), &job); err != nil {
			t.Fatal(err)
		}
		// Mark initial deployment done so clusters are live & deployed.
		s.mu.Lock()
		j := s.jobs[job.ID]
		j.State = "succeeded"
		j.Outcome = outcomeDone
		j.Marked = time.Now().UTC().Format(time.RFC3339)
		s.jobs[job.ID] = j
		s.mu.Unlock()
		return job.ID
	}

	origJob := createCluster("pg-pilot", "10.10.1.11", "10.10.1.12", "10.10.1.13", false)
	createCluster("pg-target-ha", "10.20.2.21", "10.20.2.22", "10.20.2.23", false)
	createCluster("pg-target-single", "10.30.3.31", "", "", true)

	// Also create a Redis cluster that must NOT appear as a PostgreSQL propagate target.
	rcw := storeCreate(t, s, alice, csrf, `{"id":"redis-other","hosts":[{"name":"r-1","ip":"10.40.4.41","disk":"/dev/vdb"}],"instances":[{"id":"redis","component":"redis","version":"7.2","placement":{"primary":["r-1"]}}]}`, nil)
	s.wg.Wait()
	if rcw.Code != 202 {
		t.Fatalf("create redis: %d %s", rcw.Code, rcw.Body.String())
	}

	now := time.Now().UTC().Format(time.RFC3339)
	rh := changeRehearsal{
		ID:           "aabbcc112233",
		ClusterID:    "pg-pilot",
		AppID:        "postgresql",
		AppName:      "PostgreSQL",
		BaseJobID:    origJob,
		Title:        "开启 PostgreSQL 日志落盘到 /data/logs/postgresql",
		Goal:         "在 pg-pilot（10.10.1.11）上开启 logging_collector=on 并落盘到 /data/logs/postgresql",
		Owner:        "alice",
		Mode:         "full",
		Stage:        "finalized",
		ScopeSummary: "先从后主滚动重启，允许短暂闪断",
		ProbeScript:  "#!/usr/bin/env bash\necho 'cluster=pg-pilot primary=pg-pilot-1 ip=10.10.1.11'\ndf -h /data\n",
		ProbeNotes:   []string{"在 pg-pilot-1 (10.10.1.11) 上执行"},
		ProbeSafe:    true,
		Steps: []rehearsalStep{
			{
				ID:         "s1",
				Phase:      "precheck",
				Order:      1,
				Title:      "检查拓扑",
				TargetRole: "pg-pilot-1 (10.10.1.11)",
				Command:    "patronictl -c /etc/patroni/patroni.yml list",
				Expect:     "pg-pilot-1 为 Leader",
				Status:     "passed",
				Note:       "pg-pilot-1 实测通过",
				VerifiedByAI: true,
			},
			{
				ID:         "s2",
				Phase:      "execute",
				Order:      2,
				Title:      "写入日志参数并重启",
				TargetRole: "pg-pilot-1 (10.10.1.11)",
				Command:    "patronictl -c /etc/patroni/patroni.yml edit-config -p logging_collector=on -p log_directory=/data/logs/postgresql --force",
				Expect:     "参数写入 DCS",
				Status:     "passed",
				VerifiedByAI: true,
			},
		},
		Applied: false,
		AppliedChanges: []rehearsalAppliedChange{
			{Key: "logging_collector", Before: "off", After: "on"},
			{Key: "log_directory", Before: "log", After: "/data/logs/postgresql"},
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.saveRehearsal(rh); err != nil {
		t.Fatal(err)
	}

	reqJSON := func(method, url, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, cfg.PublicURL+url, strings.NewReader(body))
		r.Header.Set("Origin", cfg.PublicURL)
		r.Header.Set("X-CSRF-Token", csrf)
		r.AddCookie(alice)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}

	// 1. Must BLOCK propagation & templates before "确认生产已实施完成" (Applied == false).
	w := reqJSON("GET", "/api/clusters/pg-pilot/rehearsals/"+rh.ID+"/propagate-targets", "")
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409 for unapplied propagate-targets, got %d %s", w.Code, w.Body.String())
	}
	w = reqJSON("POST", "/api/clusters/pg-pilot/rehearsals/"+rh.ID+"/propagate", `{"target_clusters":["pg-target-ha"],"mode":"probe"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409 for unapplied propagate POST, got %d %s", w.Code, w.Body.String())
	}
	w = reqJSON("GET", "/api/rehearsals/templates?app_id=postgresql&target_cluster=pg-target-ha", "")
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("expected empty templates before production apply, got %d %s", w.Code, w.Body.String())
	}

	// 2. Mark origin production-applied.
	rh.Applied = true
	rh.AppliedAt = now
	rh.AppliedBy = "alice"
	rh.AppliedSummary = "pg-pilot 生产已开启日志落盘"
	if err := s.saveRehearsal(rh); err != nil {
		t.Fatal(err)
	}

	// 3. List propagate targets: must see pg-target-ha (exact, allow_skip_probe=true) and pg-target-single (compatible, allow_skip_probe=false), NOT redis-other.
	w = reqJSON("GET", "/api/clusters/pg-pilot/rehearsals/"+rh.ID+"/propagate-targets", "")
	if w.Code != 200 {
		t.Fatalf("propagate-targets failed: %d %s", w.Code, w.Body.String())
	}
	var tResp struct {
		DefaultMode string                `json:"default_mode"`
		Targets     []propagateTargetItem `json:"targets"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &tResp); err != nil {
		t.Fatal(err)
	}
	if tResp.DefaultMode != "probe" {
		t.Fatalf("expected full mode default_mode=probe, got %q", tResp.DefaultMode)
	}
	if len(tResp.Targets) != 2 {
		t.Fatalf("expected 2 PostgreSQL targets (excluding origin & redis), got %+v", tResp.Targets)
	}
	byCID := map[string]propagateTargetItem{}
	for _, it := range tResp.Targets {
		byCID[it.ClusterID] = it
	}
	if byCID["pg-target-ha"].MatchTier != "exact" || !byCID["pg-target-ha"].AllowSkipProbe {
		t.Fatalf("expected pg-target-ha exact + allow_skip_probe, got %+v", byCID["pg-target-ha"])
	}
	if byCID["pg-target-single"].MatchTier != "compatible" || byCID["pg-target-single"].AllowSkipProbe {
		t.Fatalf("expected pg-target-single compatible + block skip_probe, got %+v", byCID["pg-target-single"])
	}

	// 4. Propagate in "steps" mode to BOTH targets:
	//    - pg-target-ha gets "steps" with strict Step 1 precheck & clean IP/hostname remapping!
	//    - pg-target-single gets safely downgraded to "probe" because architecture differs!
	w = reqJSON("POST", "/api/clusters/pg-pilot/rehearsals/"+rh.ID+"/propagate", `{"target_clusters":["pg-target-ha","pg-target-single"],"mode":"steps"}`)
	if w.Code != 200 {
		t.Fatalf("propagate failed: %d %s", w.Code, w.Body.String())
	}
	var pResp struct {
		RolloutID string `json:"rollout_id"`
		Created   []struct {
			ClusterID        string `json:"cluster_id"`
			RehearsalID      string `json:"rehearsal_id"`
			Stage            string `json:"stage"`
			ImportMode       string `json:"import_mode"`
			StrictPrecheck   bool   `json:"strict_precheck"`
			DowngradedReason string `json:"downgraded_reason"`
		} `json:"created"`
		Board *rolloutBoardResponse `json:"board"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &pResp); err != nil {
		t.Fatal(err)
	}
	if pResp.RolloutID == "" || len(pResp.Created) != 2 {
		t.Fatalf("expected 2 created entries with rollout_id, got %+v", pResp)
	}
	var haID, singleID string
	for _, c := range pResp.Created {
		switch c.ClusterID {
		case "pg-target-ha":
			haID = c.RehearsalID
			if c.Stage != "rehearsing" || c.ImportMode != "steps" || !c.StrictPrecheck {
				t.Fatalf("expected pg-target-ha in steps mode with strict precheck, got %+v", c)
			}
		case "pg-target-single":
			singleID = c.RehearsalID
			if c.Stage != "probing" || c.ImportMode != "probe" || c.DowngradedReason == "" {
				t.Fatalf("expected pg-target-single safely downgraded to probe, got %+v", c)
			}
		}
	}

	// Verify zero origin IP/name leakage, reset step states, and enhanced strict precheck on pg-target-ha.
	haRh, ok := s.loadRehearsal("pg-target-ha", haID)
	if !ok {
		t.Fatal("missing propagated pg-target-ha rehearsal")
	}
	if strings.Contains(haRh.Goal, "10.10.1.11") || strings.Contains(haRh.ProbeScript, "10.10.1.11") {
		t.Fatalf("origin IP leaked into target rehearsal: goal=%q probe=%q", haRh.Goal, haRh.ProbeScript)
	}
	if !strings.Contains(haRh.ProbeScript, "10.20.2.21") || !strings.Contains(haRh.Goal, "pg-target-ha") {
		t.Fatalf("expected target IP & cluster remapped, got goal=%q probe=%q", haRh.Goal, haRh.ProbeScript)
	}
	if len(haRh.Steps) < 2 {
		t.Fatalf("expected strict precheck + remapped execute step, got %+v", haRh.Steps)
	}
	st1 := haRh.Steps[0]
	if st1.Phase != "precheck" || !strings.Contains(st1.Title, "严格前置预检") || !strings.Contains(st1.Command, "server_version") || !strings.Contains(st1.Command, "logging_collector") || !strings.Contains(st1.RiskNote, "强制阻断门禁") {
		t.Fatalf("expected enhanced strict Step 1 precheck, got %+v", st1)
	}
	for _, st := range haRh.Steps {
		if st.Status != "pending" || st.VerifiedByAI || st.Note != "" {
			t.Fatalf("expected all target steps reset to pending, got %+v", st)
		}
	}
	// Verify blueprint prompt builds cleanly for probe-mode target.
	singleRh, ok := s.loadRehearsal("pg-target-single", singleID)
	if !ok {
		t.Fatal("missing pg-target-single")
	}
	if bp := s.rehearsalSourceBlueprintPrompt(singleRh); !strings.Contains(bp, "样板集群已生产落地蓝图") || !strings.Contains(bp, "logging_collector=on") {
		t.Fatalf("expected pilot blueprint prompt, got %q", bp)
	}

	// 5. Re-propagating to pg-target-ha must skip idempotently (no duplicate).
	w = reqJSON("POST", "/api/clusters/pg-pilot/rehearsals/"+rh.ID+"/propagate", `{"target_clusters":["pg-target-ha"],"mode":"probe"}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"skipped"`) || !strings.Contains(w.Body.String(), haID) {
		t.Fatalf("expected idempotent skip on re-propagate, got %d %s", w.Code, w.Body.String())
	}

	// 6. Rollout Board API aggregates all 3 clusters cleanly.
	w = reqJSON("GET", "/api/rehearsals/rollout/"+pResp.RolloutID, "")
	if w.Code != 200 {
		t.Fatalf("rollout board failed: %d %s", w.Code, w.Body.String())
	}
	var board rolloutBoardResponse
	if err := json.Unmarshal(w.Body.Bytes(), &board); err != nil {
		t.Fatal(err)
	}
	if board.Total != 3 || board.Applied != 1 || board.InProgress != 2 || board.NextPending == nil || len(board.Members) != 3 {
		t.Fatalf("unexpected rollout board summary: %+v", board)
	}

	// 7. Templates API shows the applied pilot cleanly for target clusters.
	w = reqJSON("GET", "/api/rehearsals/templates?app_id=postgresql&target_cluster=pg-target-ha", "")
	if w.Code != 200 {
		t.Fatalf("templates failed: %d %s", w.Code, w.Body.String())
	}
	var tpls []rehearsalTemplateItem
	if err := json.Unmarshal(w.Body.Bytes(), &tpls); err != nil {
		t.Fatal(err)
	}
	if len(tpls) != 1 || !tpls[0].AlreadyImported || tpls[0].RolloutTotal != 3 || tpls[0].RolloutApplied != 1 {
		t.Fatalf("unexpected templates response: %+v", tpls)
	}

	// 8. Strict Precheck Hard Gate enforcement on fast-track target (pg-target-ha).
	if !strings.Contains(haRh.Steps[0].Command, "pending_restart") || !strings.Contains(haRh.Steps[0].Command, "pg_stat_activity") {
		t.Fatalf("expected enhanced pending_restart & long_tx checks in strict precheck, got %q", haRh.Steps[0].Command)
	}
	// Cannot skip Step 1 strict precheck.
	w = reqJSON("PATCH", "/api/clusters/pg-target-ha/rehearsals/"+haID+"/steps/s1", `{"status":"skipped"}`)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "严格前置预检") {
		t.Fatalf("expected 409 strict precheck gate when skipping s1, got %d %s", w.Code, w.Body.String())
	}
	// Cannot mark Step 2 passed before Step 1 passes.
	w = reqJSON("PATCH", "/api/clusters/pg-target-ha/rehearsals/"+haID+"/steps/s2", `{"status":"passed"}`)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "严格前置预检") {
		t.Fatalf("expected 409 strict precheck gate when passing s2 before s1 passes, got %d %s", w.Code, w.Body.String())
	}
	// Passing Step 1 unlocks Step 2.
	w = reqJSON("PATCH", "/api/clusters/pg-target-ha/rehearsals/"+haID+"/steps/s1", `{"status":"passed"}`)
	if w.Code != 200 {
		t.Fatalf("expected 200 when passing s1, got %d %s", w.Code, w.Body.String())
	}
	w = reqJSON("PATCH", "/api/clusters/pg-target-ha/rehearsals/"+haID+"/steps/s2", `{"status":"passed"}`)
	if w.Code != 200 {
		t.Fatalf("expected 200 when passing s2 after s1 passed, got %d %s", w.Code, w.Body.String())
	}
}

func TestRehearsalSplitSequentialRollingCommands(t *testing.T) {
	// 1. Exact user scenario: restarting node-2 then node-3 in one command string must auto-split into 2 safe boxes.
	combined := strings.Join([]string{
		"patronictl -c /etc/patroni/patroni.yml restart pg-bitbucket-public-prod-pg node-2 --force",
		"patronictl -c /etc/patroni/patroni.yml list",
		"patronictl -c /etc/patroni/patroni.yml restart pg-bitbucket-public-prod-pg node-3 --force",
		"patronictl -c /etc/patroni/patroni.yml list",
	}, "\n")
	subs := splitSequentialRollingCommands(combined, "zh-CN")
	if len(subs) != 2 {
		t.Fatalf("expected 2 split boxes for node-2 & node-3 restarts, got %d: %+v", len(subs), subs)
	}
	if !strings.Contains(subs[0].Label, "node-2") || !strings.Contains(subs[0].Command, "node-2") || strings.Contains(subs[0].Command, "node-3") {
		t.Fatalf("unexpected box 1: %+v", subs[0])
	}
	if !strings.Contains(subs[0].Gate, "node-2") {
		t.Fatalf("expected pause-and-verify gate mentioning node-2, got %q", subs[0].Gate)
	}
	if !strings.Contains(subs[1].Label, "node-3") || !strings.Contains(subs[1].Command, "node-3") || strings.Contains(subs[1].Command, "node-2") {
		t.Fatalf("unexpected box 2: %+v", subs[1])
	}

	// 2. Harmless multi-line directory setup or daemon-reload + single restart must NOT be split.
	if got := splitSequentialRollingCommands("mkdir -p /data/logs/postgresql\nchown postgres:postgres /data/logs/postgresql\nchmod 0750 /data/logs/postgresql", "zh-CN"); len(got) != 0 {
		t.Fatalf("expected harmless setup not to split, got %+v", got)
	}
	if got := splitSequentialRollingCommands("systemctl daemon-reload\nsystemctl restart patroni\nsystemctl is-active patroni", "zh-CN"); len(got) != 0 {
		t.Fatalf("expected daemon-reload + single restart not to split, got %+v", got)
	}

	// 3. Explicit AI-supplied commands[] without top-level command synthesizes fallback command cleanly.
	steps := normalizeRehearsalStepsLang([]rehearsalStep{
		{
			ID:         "s4",
			Phase:      "execute",
			Title:      "滚动重启两台从库",
			TargetRole: "任一数据节点",
			Commands: []rehearsalStepCommand{
				{Label: "重启 node-2", Command: "patronictl restart pg node-2 --force\npatronictl list", Gate: "确认 node-2 streaming 且 Lag=0"},
				{Label: "重启 node-3", Command: "patronictl restart pg node-3 --force\npatronictl list"},
			},
			Expect: "两台从库均回到 streaming",
		},
	}, "zh-CN")
	if len(steps) != 1 || len(steps[0].Commands) != 2 || !strings.Contains(steps[0].Command, "node-2") || !strings.Contains(steps[0].Command, "node-3") {
		t.Fatalf("expected normalized multi-command step with fallback command, got %+v", steps)
	}
}

func TestRehearsalTemplatesContentDedupAndCategory(t *testing.T) {
	s, cfg := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	srv, _ := fakeModel(t)
	enableAI(t, s, srv.URL, 1)

	createPG := func(id, ipBase string) string {
		body := `{"id":"` + id + `","hosts":[{"name":"` + id + `-1","ip":"` + ipBase + `.11","disk":"/dev/vdb"},{"name":"` + id + `-2","ip":"` + ipBase + `.12","disk":"/dev/vdb"},{"name":"` + id + `-3","ip":"` + ipBase + `.13","disk":"/dev/vdb"}],"instances":[{"id":"pg","component":"postgresql","version":"17","placement":{"primary":["` + id + `-1"],"replica":["` + id + `-2","` + id + `-3"]},"params":{"client_cidr":"10.0.0.0/8","tls":false}},{"id":"etcd","component":"etcd","placement":{"member":["` + id + `-1","` + id + `-2","` + id + `-3"]}}]}`
		cw := storeCreate(t, s, alice, csrf, body, nil)
		s.wg.Wait()
		if cw.Code != 202 {
			t.Fatalf("create %s: %d %s", id, cw.Code, cw.Body.String())
		}
		var job storeJob
		if err := json.Unmarshal(cw.Body.Bytes(), &job); err != nil {
			t.Fatal(err)
		}
		s.mu.Lock()
		j := s.jobs[job.ID]
		j.State = "succeeded"
		j.Outcome = outcomeDone
		j.Marked = time.Now().UTC().Format(time.RFC3339)
		s.jobs[job.ID] = j
		s.mu.Unlock()
		return job.ID
	}

	jBlackduck := createPG("pg-blackduck", "10.50.1")
	jBitbucket := createPG("pg-bitbucket", "10.50.2")
	jSonar := createPG("pg-sonar", "10.50.3")
	createPG("pg-fresh", "10.50.4")

	t1 := time.Now().UTC().Add(-2 * time.Hour).Format(time.RFC3339)
	t2 := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	t3 := time.Now().UTC().Add(-30 * time.Minute).Format(time.RFC3339)

	logChanges := []rehearsalAppliedChange{
		{Key: "logging_collector", Before: "off", After: "on"},
		{Key: "log_directory", Before: "log", After: "/data/logs/postgresql"},
		{Key: "log_rotation_size", Before: "0", After: "1048576"},
	}
	hbaChanges := []rehearsalAppliedChange{
		{Key: "pg_hba", Before: "", After: "+ hostssl replication replicator 127.0.0.1/32 scram-sha-256"},
	}

	// Independent + rollout logging changes across 3 clusters with different titles and whitespace/case variations.
	mustSave := func(rh changeRehearsal) {
		if err := s.saveRehearsal(rh); err != nil {
			t.Fatal(err)
		}
	}
	mustSave(changeRehearsal{
		ID: "aa1100000001", ClusterID: "pg-blackduck", AppID: "postgresql", AppName: "PostgreSQL", BaseJobID: jBlackduck,
		Title: "PostgreSQL 日志落盘到 /data/logs/postgresql（按天轮转，单文件上限 1GB）",
		Owner: "alice", Mode: "full", Stage: "finalized", Applied: true, AppliedAt: t1, AppliedBy: "alice",
		Source: &rehearsalSourceRef{RolloutID: "ro-aa1100000001", IsOrigin: true, OriginClusterID: "pg-blackduck", OriginRehearsalID: "aa1100000001"},
		AppliedChanges: logChanges, CreatedAt: t1, UpdatedAt: t1,
	})
	mustSave(changeRehearsal{
		ID: "aa1100000002", ClusterID: "pg-sonar", AppID: "postgresql", AppName: "PostgreSQL", BaseJobID: jSonar,
		Title: "PostgreSQL 日志落盘到 /data/logs/postgresql（按天轮转，单文件上限 1GB）",
		Owner: "alice", Mode: "full", Stage: "finalized", Applied: true, AppliedAt: t2, AppliedBy: "alice",
		Source: &rehearsalSourceRef{RolloutID: "ro-aa1100000001", IsOrigin: false, OriginClusterID: "pg-blackduck", OriginRehearsalID: "aa1100000001"},
		AppliedChanges: logChanges, CreatedAt: t2, UpdatedAt: t2,
	})
	mustSave(changeRehearsal{
		ID: "aa1100000003", ClusterID: "pg-bitbucket", AppID: "postgresql", AppName: "PostgreSQL", BaseJobID: jBitbucket,
		Title: "PostgreSQL 日志落盘到 /data/logs/postgresql 并按天/1GB 轮转",
		Owner: "alice", Mode: "full", Stage: "finalized", Applied: true, AppliedAt: t3, AppliedBy: "alice",
		AppliedChanges: []rehearsalAppliedChange{
			{Key: "logging_collector", After: "ON"},
			{Key: "log_directory", After: "'/data/logs/postgresql'"},
			{Key: "log_rotation_size", After: "1048576"},
		},
		CreatedAt: t3, UpdatedAt: t3,
	})

	// Two independent pg_hba changes with different titles -> must merge into 1 "security" template.
	mustSave(changeRehearsal{
		ID: "bb2200000001", ClusterID: "pg-blackduck", AppID: "postgresql", AppName: "PostgreSQL", BaseJobID: jBlackduck,
		Title: "Patroni 集群共享 pg_hba 补充 127.0.0.1 replicator 复制规则",
		Owner: "alice", Mode: "light", Stage: "finalized", Applied: true, AppliedAt: t1, AppliedBy: "alice",
		AppliedChanges: hbaChanges, CreatedAt: t1, UpdatedAt: t1,
	})
	mustSave(changeRehearsal{
		ID: "bb2200000002", ClusterID: "pg-bitbucket", AppID: "postgresql", AppName: "PostgreSQL", BaseJobID: jBitbucket,
		Title: "Patroni 本机复制连接被 pg_hba 拒绝核查",
		Owner: "alice", Mode: "light", Stage: "finalized", Applied: true, AppliedAt: t3, AppliedBy: "alice",
		AppliedChanges: hbaChanges, CreatedAt: t3, UpdatedAt: t3,
	})

	// Two non-param operational changes with no shared rollout -> must NOT falsely merge.
	mustSave(changeRehearsal{
		ID: "cc3300000001", ClusterID: "pg-blackduck", AppID: "postgresql", AppName: "PostgreSQL", BaseJobID: jBlackduck,
		Title: "PostgreSQL 17.2 到 17.4 小版本滚动升级",
		Owner: "alice", Mode: "full", Stage: "finalized", Applied: true, AppliedAt: t1, AppliedBy: "alice",
		CreatedAt: t1, UpdatedAt: t1,
	})
	mustSave(changeRehearsal{
		ID: "cc3300000002", ClusterID: "pg-bitbucket", AppID: "postgresql", AppName: "PostgreSQL", BaseJobID: jBitbucket,
		Title: "Patroni 主从演练切主复位",
		Owner: "alice", Mode: "full", Stage: "finalized", Applied: true, AppliedAt: t2, AppliedBy: "alice",
		CreatedAt: t2, UpdatedAt: t2,
	})

	getTemplates := func(target string) []rehearsalTemplateItem {
		r := httptest.NewRequest("GET", cfg.PublicURL+"/api/rehearsals/templates?app_id=postgresql&target_cluster="+target, nil)
		r.Header.Set("Origin", cfg.PublicURL)
		r.Header.Set("X-CSRF-Token", csrf)
		r.AddCookie(alice)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("templates(%s): %d %s", target, w.Code, w.Body.String())
		}
		var out []rehearsalTemplateItem
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	// 1. Fresh target cluster sees 4 deduplicated templates instead of 7 raw runs:
	//    1 logging (3 clusters merged), 1 security (2 clusters merged), 1 upgrade, 1 ha.
	freshTpls := getTemplates("pg-fresh")
	if len(freshTpls) != 4 {
		t.Fatalf("expected 4 deduplicated templates for pg-fresh, got %d: %+v", len(freshTpls), freshTpls)
	}
	byCat := map[string]rehearsalTemplateItem{}
	for _, it := range freshTpls {
		byCat[it.Category] = it
	}
	logTpl, ok := byCat["logging"]
	if !ok || logTpl.MergedCount != 3 || len(logTpl.VerifiedClusters) != 3 || len(logTpl.Variants) != 3 || logTpl.ContentSignature == "" {
		t.Fatalf("expected consolidated logging template across 3 clusters, got %+v", logTpl)
	}
	if logTpl.OriginClusterID != "pg-blackduck" || logTpl.RolloutID != "ro-aa1100000001" {
		t.Fatalf("expected rollout origin pg-blackduck picked as primary pilot, got %+v", logTpl)
	}
	secTpl, ok := byCat["security"]
	if !ok || secTpl.MergedCount != 2 || len(secTpl.VerifiedClusters) != 2 || len(secTpl.Variants) != 2 {
		t.Fatalf("expected consolidated security template across 2 clusters, got %+v", secTpl)
	}
	if _, ok := byCat["upgrade"]; !ok {
		t.Fatalf("expected upgrade category template kept separate, got %+v", freshTpls)
	}
	if _, ok := byCat["ha"]; !ok {
		t.Fatalf("expected ha category template kept separate, got %+v", freshTpls)
	}

	// 2. Target cluster pg-bitbucket already applied logging & pg_hba independently ->
	//    must flag AlreadyEffective=true and point ExistingRehearsalID to its own applied rehearsal!
	bitTpls := getTemplates("pg-bitbucket")
	var bitLog, bitSec *rehearsalTemplateItem
	for i := range bitTpls {
		switch bitTpls[i].Category {
		case "logging":
			bitLog = &bitTpls[i]
		case "security":
			bitSec = &bitTpls[i]
		}
	}
	if bitLog == nil || !bitLog.AlreadyEffective || bitLog.ExistingRehearsalID != "aa1100000003" {
		t.Fatalf("expected pg-bitbucket logging template flagged AlreadyEffective -> aa1100000003, got %+v", bitLog)
	}
	if bitSec == nil || !bitSec.AlreadyEffective || bitSec.ExistingRehearsalID != "bb2200000002" {
		t.Fatalf("expected pg-bitbucket security template flagged AlreadyEffective -> bb2200000002, got %+v", bitSec)
	}
}

func TestEnsurePasteSafeShellCommand(t *testing.T) {
	// 1. Exact user Screenshot #3 scenario: sudo psql + sleep 60 + patronictl list must wrap in (...) </dev/null.
	raw := strings.Join([]string{
		`sudo -u postgres psql -X -p 5432 -Atc "select 1"`,
		`sleep 60; journalctl -u patroni --since '60 seconds ago' --no-pager -o cat | grep -c 'no pg_hba.conf'`,
		`patronictl -c /etc/patroni/patroni.yml list`,
	}, "\n")
	got := ensurePasteSafeShellCommand(raw)
	if !strings.HasPrefix(got, "(\n") || !strings.HasSuffix(got, "\n) </dev/null") {
		t.Fatalf("expected multi-command block wrapped in (...) </dev/null, got:\n%s", got)
	}
	// Idempotent on second call.
	if got2 := ensurePasteSafeShellCommand(got); got2 != got {
		t.Fatalf("expected idempotent wrapping, got:\n%s", got2)
	}

	// 2. Upgrades (...) without </dev/null to (...) </dev/null.
	upgraded := ensurePasteSafeShellCommand("(\necho a\necho b\n)")
	if upgraded != "(\necho a\necho b\n) </dev/null" {
		t.Fatalf("expected </dev/null added, got: %q", upgraded)
	}

	// 3. Single-line commands and #!/ shebang scripts stay untouched.
	single := `patronictl -c /etc/patroni/patroni.yml list`
	if ensurePasteSafeShellCommand(single) != single {
		t.Fatalf("expected single-line command unchanged")
	}
	shebang := "#!/usr/bin/env bash\nset -uo pipefail\necho hi"
	if ensurePasteSafeShellCommand(shebang) != shebang {
		t.Fatalf("expected shebang script unchanged")
	}

	// 4. Single heredoc command stays untouched, while heredoc + follow-up command wraps.
	singleHeredoc := "cat <<'EOF' > /tmp/test.conf\na=1\nb=2\nEOF"
	if ensurePasteSafeShellCommand(singleHeredoc) != singleHeredoc {
		t.Fatalf("expected single heredoc command unchanged, got:\n%s", ensurePasteSafeShellCommand(singleHeredoc))
	}
	heredocPlus := singleHeredoc + "\nsystemctl reload nginx"
	if out := ensurePasteSafeShellCommand(heredocPlus); !strings.HasPrefix(out, "(\n") || !strings.HasSuffix(out, "\n) </dev/null") {
		t.Fatalf("expected heredoc + follow-up command wrapped, got:\n%s", out)
	}

	// 5. Already-wrapped sequential rolling restarts still split into 2 paste-safe sub-boxes.
	wrappedRolling := "(\npatronictl -c /etc/patroni/patroni.yml restart pg node-2 --force\npatronictl -c /etc/patroni/patroni.yml list\npatronictl -c /etc/patroni/patroni.yml restart pg node-3 --force\npatronictl -c /etc/patroni/patroni.yml list\n) </dev/null"
	steps := normalizeRehearsalStepsLang([]rehearsalStep{{
		ID:      "s4",
		Phase:   "execute",
		Title:   "滚动重启从库",
		Command: wrappedRolling,
	}}, "zh-CN")
	if len(steps) != 1 || len(steps[0].Commands) != 2 {
		t.Fatalf("expected wrapped rolling restart split into 2 sub-boxes, got %+v", steps)
	}
	for i, sub := range steps[0].Commands {
		if !strings.HasPrefix(sub.Command, "(\n") || !strings.HasSuffix(sub.Command, "\n) </dev/null") {
			t.Fatalf("expected sub-box %d wrapped in (...) </dev/null, got:\n%s", i, sub.Command)
		}
	}
}

func TestRolloutCoreArchEquivalenceImportedVsDeployedAndVersionParsing(t *testing.T) {
	// 1. Verify majorVersionOf handles vendor/distro prefixes cleanly.
	for in, want := range map[string]string{
		"17":                                      "17",
		"17.11":                                   "17",
		"v17.11.1":                                "17",
		"PostgreSQL 17.11":                        "17",
		"Percona Server for PostgreSQL 17.11.1":   "17",
		"7.2.5":                                   "7",
		"16.4":                                    "16",
		"":                                        "",
	} {
		if got := majorVersionOf(in); got != want {
			t.Fatalf("majorVersionOf(%q) = %q, want %q", in, got, want)
		}
	}

	s, _ := testStore(t)
	srv, _ := fakeModel(t)
	enableAI(t, s, srv.URL, 1)
	admin, csrf := storeLogin(t, s, "admin")

	// 2. Create a platform-deployed 3-node PostgreSQL 17 + Patroni + etcd cluster as pilot.
	depBody := `{"id":"pg-deployed-pilot","hosts":[{"name":"p1","ip":"10.50.1.11","disk":"/dev/vdb"},{"name":"p2","ip":"10.50.1.12","disk":"/dev/vdb"},{"name":"p3","ip":"10.50.1.13","disk":"/dev/vdb"}],"instances":[{"id":"pg","component":"postgresql","version":"17","placement":{"primary":["p1"],"replica":["p2","p3"]},"params":{"client_cidr":"10.0.0.0/8","tls":false}},{"id":"etcd","component":"etcd","placement":{"member":["p1","p2","p3"]}}]}`
	cw := storeCreate(t, s, admin, csrf, depBody, nil)
	s.wg.Wait()
	if cw.Code != 202 {
		t.Fatalf("create deployed pilot: %d %s", cw.Code, cw.Body.String())
	}
	var pilotJob storeJob
	_ = json.Unmarshal(cw.Body.Bytes(), &pilotJob)
	s.mu.Lock()
	j := s.jobs[pilotJob.ID]
	j.State = "succeeded"
	j.Outcome = outcomeDone
	j.Marked = time.Now().UTC().Format(time.RFC3339)
	s.jobs[pilotJob.ID] = j
	s.mu.Unlock()

	// 3. Import 3 clusters:
	//    - pg-imp-same: 3-node PG 17 + Patroni + etcd + pgBackRest + node-exporter (same core arch, Percona exact_version)
	//    - pg-imp-v16:  3-node PG 16 + Patroni + etcd (major version mismatch)
	//    - pg-imp-single: 1-node PG 17 standalone (architecture mismatch)
	imports := []string{
		`{"id":"pg-imp-same","component":"postgresql","version":"Percona Server for PostgreSQL 17.11.1","exact_version":"Percona Server for PostgreSQL 17.11.1","arch_summary":"3 节点 PostgreSQL 一主两从，由 Patroni 管理、3 成员 etcd 提供 DCS，配套 pgBackRest 归档及 node_exporter 主机监控","hosts":[{"name":"n1","ip":"10.50.2.11","role":"primary"},{"name":"n2","ip":"10.50.2.12","role":"replica"},{"name":"n3","ip":"10.50.2.13","role":"replica"}],"companions":[{"component":"patroni","kind":"ha_manager","version":"4.1.5"},{"component":"etcd","kind":"dcs","version":"3.5.33"},{"component":"pgbackrest","kind":"backup","version":"2.59.1"},{"component":"node-exporter","kind":"os_component","version":"1.13.0"}]}`,
		`{"id":"pg-imp-v16","component":"postgresql","version":"16.4","hosts":[{"name":"v1","ip":"10.50.3.11","role":"primary"},{"name":"v2","ip":"10.50.3.12","role":"replica"},{"name":"v3","ip":"10.50.3.13","role":"replica"}],"companions":[{"component":"patroni","kind":"ha_manager","version":"4.0.0"},{"component":"etcd","kind":"dcs","version":"3.5.12"}]}`,
		`{"id":"pg-imp-single","component":"postgresql","version":"17.11","hosts":[{"name":"s1","ip":"10.50.4.11","role":"primary"}]}`,
	}
	for _, ib := range imports {
		iw := storeRequest(s, "POST", "/api/clusters/import", strings.NewReader(ib), admin, csrf)
		if iw.Code != 200 && iw.Code != 201 {
			t.Fatalf("import failed: %d %s", iw.Code, iw.Body.String())
		}
	}

	now := time.Now().UTC().Format(time.RFC3339)
	rh := changeRehearsal{
		ID:        "ccdd11223344",
		ClusterID: "pg-deployed-pilot",
		AppID:     "postgresql",
		AppName:   "PostgreSQL",
		BaseJobID: pilotJob.ID,
		Title:     "Patroni 集群共享 pg_hba 补充 127.0.0.1 replicator 复制规则",
		Goal:      "补充 pg_hba 规则",
		Owner:     "admin",
		Mode:      "light",
		Stage:     "finalized",
		Applied:   true,
		AppliedAt: now,
		AppliedChanges: []rehearsalAppliedChange{
			{Key: "pg_hba", After: "+ hostssl replication replicator 127.0.0.1/32 scram-sha-256"},
		},
		Steps: []rehearsalStep{
			{ID: "s1", Phase: "execute", Order: 1, Title: "写入 pg_hba", Command: "patronictl edit-config", Status: "passed"},
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.saveRehearsal(rh); err != nil {
		t.Fatal(err)
	}

	// Verify templates API (pull direction) from pg-imp-same sees pg-deployed-pilot as EXACT + AllowSkipProbe=true!
	wSame := storeRequest(s, "GET", "/api/rehearsals/templates?target_cluster=pg-imp-same", nil, admin, "")
	if wSame.Code != 200 {
		t.Fatalf("templates pg-imp-same: %d %s", wSame.Code, wSame.Body.String())
	}
	var sameItems []rehearsalTemplateItem
	if err := json.Unmarshal(wSame.Body.Bytes(), &sameItems); err != nil {
		t.Fatalf("decode sameItems: %v body=%s", err, wSame.Body.String())
	}
	if len(sameItems) != 1 {
		t.Fatalf("expected 1 template for pg-imp-same, got %d body=%s", len(sameItems), wSame.Body.String())
	}
	if sameItems[0].MatchTier != "exact" || !sameItems[0].AllowSkipProbe {
		t.Fatalf("expected imported PG 17 Patroni + pgBackRest cluster to match deployed PG 17 Patroni as exact & AllowSkipProbe=true, got tier=%q allow=%v reason=%q",
			sameItems[0].MatchTier, sameItems[0].AllowSkipProbe, sameItems[0].SkipProbeBlockReason)
	}

	// Verify propagate targets API (push direction) from pg-deployed-pilot also marks pg-imp-same as exact & AllowSkipProbe=true!
	wTargets := storeRequest(s, "GET", "/api/clusters/pg-deployed-pilot/rehearsals/ccdd11223344/propagate-targets", nil, admin, "")
	if wTargets.Code != 200 {
		t.Fatalf("propagate targets: %d %s", wTargets.Code, wTargets.Body.String())
	}
	var tgtResp struct {
		Targets []propagateTargetItem `json:"targets"`
	}
	if err := json.Unmarshal(wTargets.Body.Bytes(), &tgtResp); err != nil {
		t.Fatalf("decode targets: %v", err)
	}
	byID := map[string]propagateTargetItem{}
	for _, it := range tgtResp.Targets {
		byID[it.ClusterID] = it
	}
	if it := byID["pg-imp-same"]; it.MatchTier != "exact" || !it.AllowSkipProbe {
		t.Fatalf("expected push-direction pg-imp-same exact & AllowSkipProbe=true, got %+v", it)
	}
	if it := byID["pg-imp-v16"]; it.MatchTier != "compatible" || it.AllowSkipProbe || !strings.Contains(it.SkipProbeBlockReason, "主版本") {
		t.Fatalf("expected push-direction pg-imp-v16 blocked by major version, got %+v", it)
	}
	if it := byID["pg-imp-single"]; it.MatchTier != "compatible" || it.AllowSkipProbe || !strings.Contains(it.SkipProbeBlockReason, "核心架构") || !strings.Contains(it.SkipProbeBlockReason, "单节点") {
		t.Fatalf("expected push-direction pg-imp-single blocked by core arch with readable label, got %+v", it)
	}

	// Verify pg-imp-v16 templates API is blocked with explicit major version diff reason.
	wV16 := storeRequest(s, "GET", "/api/rehearsals/templates?target_cluster=pg-imp-v16", nil, admin, "")
	var v16Items []rehearsalTemplateItem
	_ = json.Unmarshal(wV16.Body.Bytes(), &v16Items)
	if len(v16Items) != 1 || v16Items[0].MatchTier != "compatible" || v16Items[0].AllowSkipProbe {
		t.Fatalf("expected pg-imp-v16 compatible & AllowSkipProbe=false, got: %+v", v16Items)
	}
	if !strings.Contains(v16Items[0].SkipProbeBlockReason, "主版本") {
		t.Fatalf("expected explicit major version block reason, got %q", v16Items[0].SkipProbeBlockReason)
	}

	// Verify pg-imp-single templates API is blocked with explicit architecture diff reason.
	wSingle := storeRequest(s, "GET", "/api/rehearsals/templates?target_cluster=pg-imp-single", nil, admin, "")
	var singleItems []rehearsalTemplateItem
	_ = json.Unmarshal(wSingle.Body.Bytes(), &singleItems)
	if len(singleItems) != 1 || singleItems[0].MatchTier != "compatible" || singleItems[0].AllowSkipProbe {
		t.Fatalf("expected pg-imp-single compatible & AllowSkipProbe=false, got: %+v", singleItems)
	}
	if !strings.Contains(singleItems[0].SkipProbeBlockReason, "核心架构") {
		t.Fatalf("expected explicit core architecture block reason, got %q", singleItems[0].SkipProbeBlockReason)
	}
}

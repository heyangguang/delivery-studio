package main

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

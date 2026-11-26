package server

import (
	"bytes"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeliveryStepHotfixEditRevertPromoteAndDownloadPreserved(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	spec := `{"id":"etcd-hotfix","hosts":[{"name":"n1","ip":"10.0.2.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	w := storeCreate(t, s, admin, csrf, spec, nil)
	s.wg.Wait()
	var j storeJob
	_ = json.Unmarshal(w.Body.Bytes(), &j)
	s.mu.Lock()
	j = s.jobs[j.ID]
	s.mu.Unlock()
	if j.State != "succeeded" {
		t.Fatalf("delivery failed: %s %s", j.State, j.Error)
	}

	// Regression check: existing output download route /api/jobs/:id/files/:filename must remain intact.
	if dl := storeRequest(s, "GET", "/api/jobs/"+j.ID+"/files/SHA256SUMS", nil, admin, ""); dl.Code != 200 {
		t.Fatalf("expected SHA256SUMS download 200, got %d: %s", dl.Code, dl.Body.String())
	}

	var healthStep string
	for _, st := range flatSteps(s.runbookSteps(j.ID)) {
		if strings.HasSuffix(st.Key, "/health") {
			healthStep = st.Key
			break
		}
	}
	if healthStep == "" {
		t.Fatalf("health step not found")
	}

	// List editable delivery scripts sorted by step relevance.
	w = storeRequest(s, "GET", "/api/jobs/"+j.ID+"/scripts?step="+url.QueryEscape(healthStep), nil, admin, "")
	if w.Code != 200 {
		t.Fatalf("list scripts failed %d: %s", w.Code, w.Body.String())
	}
	var listResp struct {
		Files []deliveryFileItem `json:"files"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listResp); err != nil {
		t.Fatal(err)
	}
	if len(listResp.Files) == 0 || !listResp.Files[0].Related {
		t.Fatalf("expected step-related files sorted first, got: %+v", listResp.Files[:min(3, len(listResp.Files))])
	}

	targetPath := "roles/etcd/tasks/test_health.yml"
	cw := storeRequest(s, "GET", "/api/jobs/"+j.ID+"/scripts/content?path="+url.QueryEscape(targetPath), nil, admin, "")
	if cw.Code != 200 {
		t.Fatalf("get content failed %d: %s", cw.Code, cw.Body.String())
	}
	var contentResp struct {
		Path     string `json:"path"`
		Content  string `json:"content"`
		Original string `json:"original"`
		Patched  bool   `json:"patched"`
	}
	_ = json.Unmarshal(cw.Body.Bytes(), &contentResp)
	if contentResp.Content == "" || contentResp.Patched {
		t.Fatalf("unexpected initial content state: %+v", contentResp)
	}

	// Reject missing reason, invalid YAML, and dangerous commands.
	badCases := []struct {
		name    string
		content string
		reason  string
	}{
		{"empty-reason", contentResp.Content + "\n# note\n", ""},
		{"bad-yaml", ":\n  - [\ninvalid", "bad yaml"},
		{"forbidden-cmd", contentResp.Content + "\n- name: bad\n  ansible.builtin.shell: rm -rf /\n", "forbidden"},
	}
	for _, bc := range badCases {
		body, _ := json.Marshal(map[string]string{"path": targetPath, "content": bc.content, "reason": bc.reason})
		rw := storeRequest(s, "PUT", "/api/jobs/"+j.ID+"/scripts/content", bytes.NewReader(body), admin, csrf)
		if rw.Code != 400 {
			t.Fatalf("case %s: expected 400, got %d: %s", bc.name, rw.Code, rw.Body.String())
		}
	}

	// Save valid human hotfix.
	patchedContent := contentResp.Content + "\n- name: 单步现场热修检查\n  ansible.builtin.command: /bin/true\n  changed_when: false\n"
	putBody, _ := json.Marshal(map[string]string{
		"path":    targetPath,
		"content": patchedContent,
		"reason":  "临时跳过本环境特定探针",
	})
	pw := storeRequest(s, "PUT", "/api/jobs/"+j.ID+"/scripts/content", bytes.NewReader(putBody), admin, csrf)
	if pw.Code != 200 {
		t.Fatalf("save hotfix failed %d: %s", pw.Code, pw.Body.String())
	}
	var saveResp struct {
		Patch     deliveryPatch `json:"patch"`
		Sync      jobSync       `json:"sync"`
		VerifyCmd string        `json:"verify_cmd"`
		UpdateURL string        `json:"update_url"`
	}
	_ = json.Unmarshal(pw.Body.Bytes(), &saveResp)
	if saveResp.Sync.Update == "" || saveResp.VerifyCmd == "" || saveResp.UpdateURL == "" {
		t.Fatalf("missing update archive metadata: %s", pw.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.jobDir(j.ID), "output", saveResp.Sync.Update)); err != nil {
		t.Fatalf("update archive not written: %v", err)
	}
	if dl := storeRequest(s, "GET", saveResp.UpdateURL, nil, admin, ""); dl.Code != 200 {
		t.Fatalf("update archive download failed %d: %s", dl.Code, dl.Body.String())
	}

	// Verify GET /scripts and /scripts/content expose exact added/deleted line counts for patched files.
	wPatchedList := storeRequest(s, "GET", "/api/jobs/"+j.ID+"/scripts?step="+url.QueryEscape(healthStep), nil, admin, "")
	if wPatchedList.Code != 200 {
		t.Fatalf("list patched scripts failed %d: %s", wPatchedList.Code, wPatchedList.Body.String())
	}
	var patchedListResp struct {
		Files []deliveryFileItem `json:"files"`
	}
	_ = json.Unmarshal(wPatchedList.Body.Bytes(), &patchedListResp)
	if len(patchedListResp.Files) == 0 || !patchedListResp.Files[0].Patched || patchedListResp.Files[0].Path != targetPath {
		t.Fatalf("expected patched file sorted first, got: %+v", patchedListResp.Files[:min(3, len(patchedListResp.Files))])
	}
	if patchedListResp.Files[0].Added != 4 || patchedListResp.Files[0].Deleted != 0 {
		t.Fatalf("expected added=4 deleted=0 for patched file, got added=%d deleted=%d", patchedListResp.Files[0].Added, patchedListResp.Files[0].Deleted)
	}
	cwPatched := storeRequest(s, "GET", "/api/jobs/"+j.ID+"/scripts/content?path="+url.QueryEscape(targetPath), nil, admin, "")
	var patchedContentResp struct {
		Patched bool `json:"patched"`
		Added   int  `json:"added"`
		Deleted int  `json:"deleted"`
	}
	_ = json.Unmarshal(cwPatched.Body.Bytes(), &patchedContentResp)
	if !patchedContentResp.Patched || patchedContentResp.Added != 4 || patchedContentResp.Deleted != 0 {
		t.Fatalf("expected content response patched=true added=4 deleted=0, got: %+v", patchedContentResp)
	}

	// Promote hotfix into component workspace draft.
	promBody, _ := json.Marshal(map[string]string{"path": targetPath})
	prw := storeRequest(s, "POST", "/api/jobs/"+j.ID+"/patches/promote-draft", bytes.NewReader(promBody), admin, csrf)
	if prw.Code != 200 {
		t.Fatalf("promote draft failed %d: %s", prw.Code, prw.Body.String())
	}
	draftFiles, _, err := s.comps().readDraft("etcd")
	if err != nil || !strings.Contains(string(draftFiles[targetPath]), "单步现场热修检查") {
		t.Fatalf("component draft did not receive promoted hotfix: err=%v", err)
	}

	// Revert hotfix back to original.
	revW := storeRequest(s, "DELETE", "/api/jobs/"+j.ID+"/patches?path="+url.QueryEscape(targetPath), nil, admin, csrf)
	if revW.Code != 200 {
		t.Fatalf("revert hotfix failed %d: %s", revW.Code, revW.Body.String())
	}
	cur, ok := s.projectFile(j.ID, targetPath)
	if !ok || string(cur) != contentResp.Original {
		t.Fatalf("expected reverted file to match original")
	}
}

func TestExecutionEnvHashReuseAutoPushAndSafetyConfirmationGate(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	spec := `{"id":"etcd-auto-safe","delivery_mode":"automatic","hosts":[{"name":"n1","ip":"10.0.3.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	w := storeCreate(t, s, admin, csrf, spec, nil)
	s.wg.Wait()
	var j storeJob
	_ = json.Unmarshal(w.Body.Bytes(), &j)
	s.mu.Lock()
	j = s.jobs[j.ID]
	s.mu.Unlock()
	if j.State != "succeeded" {
		t.Fatalf("delivery failed: %s %s", j.State, j.Error)
	}

	// Register an online Protocol-2 execution node authorized for this cluster.
	node := executionNode{
		ID:           "node-auto-1",
		Name:         "auto-runner",
		Kind:         "embedded",
		Protocol:     2,
		Grants:       map[string][]string{j.ClusterID: {"10.0.3.11"}},
		TokenHash:    digest([]byte(strings.Repeat("x", 64))),
		Clusters:     []string{j.ClusterID},
		IPs:          []string{"10.0.3.11"},
		ControllerIP: "10.0.3.11",
		LastSeen:     executionNow(),
	}
	snapBefore, err := s.executionSnapshotFor(j)
	if err != nil {
		t.Fatal(err)
	}
	db, err := s.readExecutions()
	if err != nil {
		t.Fatal(err)
	}
	db.Nodes[node.ID] = node
	bindExecutionAccess(&snapBefore, db, node.ID)
	liveWarning := "目标机 n1 检测到已有非空数据目录: /data/etcd; 运行中服务: etcd"
	prep := executionPreparation{
		ID:           "prep-reuse-1",
		Job:          j.ID,
		Node:         node.ID,
		By:           "admin",
		Revision:     s.executionRevision(j.ID),
		NodeRevision: executionNodeRevision(node),
		EnvHash:      executionEnvDigest(snapBefore),
		Created:      executionNow(),
		Finished:     executionNow(),
		State:        "ready",
		Checks: []executionCheck{
			{ID: "host:n1", Host: "n1", Title: "SSH 与运行环境", State: "passed", Message: "已连通", Warnings: []string{liveWarning}},
		},
		Snapshot: snapBefore,
	}
	db.Preparations[prep.ID] = prep
	if err := s.saveExecutions(db); err != nil {
		t.Fatal(err)
	}

	// Pick a mutating available step (e.g. deploy step) and hotfix a role file (changes revision, preserves EnvHash!).
	var deployStep executionChoice
	for _, c := range s.executionChoices(j.ID) {
		if c.Available && c.Effect != "read-only" {
			deployStep = c
			break
		}
	}
	if deployStep.Key == "" {
		t.Fatalf("no available mutating execution step found")
	}

	targetPath := "roles/etcd/tasks/test_health.yml"
	origBytes, ok := s.projectFile(j.ID, targetPath)
	if !ok {
		t.Fatalf("missing %s", targetPath)
	}
	patchedYAML := string(origBytes) + "\n# HOTFIX_AUTO_PUSH_MARKER\n"
	putBody, _ := json.Marshal(map[string]string{
		"path":    targetPath,
		"content": patchedYAML,
		"reason":  "修复第 10 步超时配置",
	})
	if pw := storeRequest(s, "PUT", "/api/jobs/"+j.ID+"/scripts/content", bytes.NewReader(putBody), admin, csrf); pw.Code != 200 {
		t.Fatalf("hotfix failed %d: %s", pw.Code, pw.Body.String())
	}

	// GET /executions must report env_match=true, ready state, data_warnings, and patches despite revision change!
	gw := storeRequest(s, "GET", "/api/jobs/"+j.ID+"/executions", nil, admin, "")
	if gw.Code != 200 {
		t.Fatalf("GET executions failed %d: %s", gw.Code, gw.Body.String())
	}
	var execState struct {
		Revision     string                 `json:"revision"`
		DataWarnings []string               `json:"data_warnings"`
		Patches      []deliveryPatch        `json:"patches"`
		Preparations []executionPreparation `json:"preparations"`
	}
	_ = json.Unmarshal(gw.Body.Bytes(), &execState)
	if execState.Revision == prep.Revision {
		t.Fatalf("expected revision to advance after hotfix")
	}
	if len(execState.Preparations) != 1 || execState.Preparations[0].State != "ready" || !execState.Preparations[0].EnvMatch {
		t.Fatalf("expected preparation to stay ready & env_match=true after script hotfix, got: %+v", execState.Preparations)
	}
	if len(execState.DataWarnings) == 0 || execState.DataWarnings[0] != liveWarning {
		t.Fatalf("expected live data_warnings, got: %+v", execState.DataWarnings)
	}
	if len(execState.Patches) != 1 {
		t.Fatalf("expected 1 active patch, got: %+v", execState.Patches)
	}

	// Launching WITHOUT confirm_safety must be blocked with HTTP 409 + need_safety_confirm=true!
	launchPayload := map[string]any{
		"node":        node.ID,
		"keys":        []string{deployStep.Key},
		"confirm":     j.ClusterID,
		"preparation": prep.ID,
		"revision":    execState.Revision,
		"request":     "req-safety-1",
	}
	b1, _ := json.Marshal(launchPayload)
	lw1 := storeRequest(s, "POST", "/api/jobs/"+j.ID+"/executions", bytes.NewReader(b1), admin, csrf)
	if lw1.Code != 409 {
		t.Fatalf("expected 409 safety gate, got %d: %s", lw1.Code, lw1.Body.String())
	}
	var gateResp struct {
		NeedSafetyConfirm bool     `json:"need_safety_confirm"`
		SafetyWarnings    []string `json:"safety_warnings"`
	}
	_ = json.Unmarshal(lw1.Body.Bytes(), &gateResp)
	if !gateResp.NeedSafetyConfirm || len(gateResp.SafetyWarnings) == 0 {
		t.Fatalf("unexpected 409 response: %s", lw1.Body.String())
	}

	// Launching WITH confirm_safety=true reuses prep seamlessly and auto-embeds the hotfixed script into the run snapshot!
	launchPayload["confirm_safety"] = true
	launchPayload["request"] = "req-safety-2"
	b2, _ := json.Marshal(launchPayload)
	lw2 := storeRequest(s, "POST", "/api/jobs/"+j.ID+"/executions", bytes.NewReader(b2), admin, csrf)
	if lw2.Code != 201 {
		t.Fatalf("expected 201 with confirm_safety=true and reused prep, got %d: %s", lw2.Code, lw2.Body.String())
	}
	var createdRun executionRun
	_ = json.Unmarshal(lw2.Body.Bytes(), &createdRun)
	if !createdRun.SafetyConfirmed || len(createdRun.PatchedFiles) != 1 || createdRun.PatchedFiles[0] != targetPath {
		t.Fatalf("unexpected created run metadata: %+v", createdRun)
	}
	// Verify snapshot persisted for the runner actually carries the hotfix bytes!
	snapAfter, err := s.executionSnapshotFor(j)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(snapAfter.Files[targetPath]), "HOTFIX_AUTO_PUSH_MARKER") {
		t.Fatalf("execution snapshot did not auto-include patched file")
	}

	// Close the run and verify re-running an already-completed destructive/disruptive step triggers 409 even with zero live host warnings!
	db2, _ := s.readExecutions()
	rDone := db2.Runs[createdRun.ID]
	rDone.State = "completed"
	db2.Runs[createdRun.ID] = rDone
	pClean := db2.Preparations[prep.ID]
	pClean.Checks[0].Warnings = nil
	db2.Preparations[prep.ID] = pClean
	_ = s.saveExecutions(db2)

	var riskyStep executionChoice
	for _, c := range s.executionChoices(j.ID) {
		if c.Available && (c.Effect == "disruptive" || c.Effect == "destructive") {
			riskyStep = c
			break
		}
	}
	if riskyStep.Key != "" {
		progBody, _ := json.Marshal(map[string]any{"key": riskyStep.Key, "title": riskyStep.Title, "state": "done"})
		if pw := storeRequest(s, "PUT", "/api/jobs/"+j.ID+"/progress", bytes.NewReader(progBody), admin, csrf); pw.Code != 200 {
			t.Fatalf("mark step done failed %d: %s", pw.Code, pw.Body.String())
		}
		retryPayload, _ := json.Marshal(map[string]any{
			"node":        node.ID,
			"keys":        []string{riskyStep.Key},
			"confirm":     j.ClusterID,
			"preparation": prep.ID,
			"revision":    execState.Revision,
			"request":     "req-safety-rerun-1",
		})
		lw3 := storeRequest(s, "POST", "/api/jobs/"+j.ID+"/executions", bytes.NewReader(retryPayload), admin, csrf)
		if lw3.Code != 409 || !strings.Contains(lw3.Body.String(), `"need_safety_confirm":true`) {
			t.Fatalf("expected 409 secondary confirm when re-running completed risky step %s, got %d: %s", riskyStep.Key, lw3.Code, lw3.Body.String())
		}
	}
}

func TestVerificationDeliveryHotSyncsComponentDraftWithoutPublish(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")

	// 1. Formal delivery
	wFormal := storeCreate(t, s, admin, csrf, `{"id":"etcd-formal","hosts":[{"name":"n1","ip":"10.0.4.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	// 2. Temporary verification delivery (cluster id prefixed with verify- / purpose = verification)
	wVerify := storeCreate(t, s, admin, csrf, `{"id":"verify-etcd-1","hosts":[{"name":"n1","ip":"10.0.4.12"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()

	var jFormal, jVerify storeJob
	_ = json.Unmarshal(wFormal.Body.Bytes(), &jFormal)
	_ = json.Unmarshal(wVerify.Body.Bytes(), &jVerify)
	s.mu.Lock()
	jFormal = s.jobs[jFormal.ID]
	jVerify = s.jobs[jVerify.ID]
	s.mu.Unlock()
	if jFormal.State != "succeeded" || jVerify.State != "succeeded" {
		t.Fatalf("deliveries failed: formal=%s verify=%s", jFormal.State, jVerify.State)
	}

	// Edit component workspace draft WITHOUT publishing!
	if w := storeRequest(s, "POST", "/api/components/etcd/draft", strings.NewReader(`{"from":"builtin"}`), admin, csrf); w.Code != 200 {
		t.Fatalf("create draft failed: %d %s", w.Code, w.Body.String())
	}
	set, _, _ := s.comps().readDraft("etcd")
	task := "roles/etcd/tasks/test_health.yml"
	fixed := string(set[task]) + "\n- name: 未发布草稿热同步检查\n  ansible.builtin.command: /bin/true\n  changed_when: false\n"
	body, _ := json.Marshal(map[string]any{"files": map[string]string{task: fixed}})
	if w := storeRequest(s, "PUT", "/api/components/etcd/draft", bytes.NewReader(body), admin, csrf); w.Code != 200 {
		t.Fatalf("update draft failed: %d %s", w.Code, w.Body.String())
	}

	// Formal delivery must NOT see unpublished drafts.
	wF := storeRequest(s, "GET", "/api/jobs/"+jFormal.ID+"/sync", nil, admin, "")
	if !strings.Contains(wF.Body.String(), `"available":false`) {
		t.Fatalf("formal delivery should ignore unpublished draft, got: %s", wF.Body.String())
	}

	// Verification delivery MUST see the unpublished draft and hot-sync it directly!
	wV := storeRequest(s, "GET", "/api/jobs/"+jVerify.ID+"/sync", nil, admin, "")
	var pvWrap struct {
		Preview syncPreview `json:"preview"`
	}
	_ = json.Unmarshal(wV.Body.Bytes(), &pvWrap)
	if !pvWrap.Preview.Available || len(pvWrap.Preview.UsingDrafts) != 1 || pvWrap.Preview.UsingDrafts[0] != "etcd" {
		t.Fatalf("expected verification delivery to preview draft hot-sync, got: %s", wV.Body.String())
	}

	// Apply draft hot-sync and verify delivery project files & execution snapshot receive the draft change!
	wApply := storeRequest(s, "POST", "/api/jobs/"+jVerify.ID+"/sync", nil, admin, csrf)
	if wApply.Code != 200 {
		t.Fatalf("apply draft hot-sync failed %d: %s", wApply.Code, wApply.Body.String())
	}
	files, _ := s.projectFiles(jVerify.ID)
	if !strings.Contains(string(files[task]), "未发布草稿热同步检查") {
		t.Fatalf("verification delivery did not receive draft hot-sync content")
	}
}

func TestDeliveryStepHotfixEngineerPermissionScope(t *testing.T) {
	s, _ := testStore(t)
	alice, aliceCSRF := storeLogin(t, s, "alice")
	bob, bobCSRF := storeLogin(t, s, "bob")

	w := storeCreate(t, s, alice, aliceCSRF, `{"id":"alice-etcd","hosts":[{"name":"n1","ip":"10.0.5.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	var j storeJob
	_ = json.Unmarshal(w.Body.Bytes(), &j)
	s.mu.Lock()
	j = s.jobs[j.ID]
	s.mu.Unlock()
	if j.State != "succeeded" {
		t.Fatalf("alice delivery failed: %s %s", j.State, j.Error)
	}

	targetPath := "roles/etcd/tasks/test_health.yml"
	origBytes, _ := s.projectFile(j.ID, targetPath)
	putBody, _ := json.Marshal(map[string]string{
		"path":    targetPath,
		"content": string(origBytes) + "\n# alice hotfix\n",
		"reason":  "交付工程师现场微调",
	})
	// Alice (delivery.run) CAN hotfix her own delivery's script!
	if pw := storeRequest(s, "PUT", "/api/jobs/"+j.ID+"/scripts/content", bytes.NewReader(putBody), alice, aliceCSRF); pw.Code != 200 {
		t.Fatalf("expected engineer alice to hotfix own delivery (200), got %d: %s", pw.Code, pw.Body.String())
	}
	// Alice does NOT hold component.edit, so promote-draft must return 403.
	promBody, _ := json.Marshal(map[string]string{"path": targetPath})
	if prw := storeRequest(s, "POST", "/api/jobs/"+j.ID+"/patches/promote-draft", bytes.NewReader(promBody), alice, aliceCSRF); prw.Code != 403 {
		t.Fatalf("expected 403 promote-draft for engineer without component.edit, got %d: %s", prw.Code, prw.Body.String())
	}
	// Bob (scope=own) cannot see or modify Alice's delivery (404).
	if bw := storeRequest(s, "PUT", "/api/jobs/"+j.ID+"/scripts/content", bytes.NewReader(putBody), bob, bobCSRF); bw.Code != 404 {
		t.Fatalf("expected 404 when bob tries to hotfix alice's delivery, got %d: %s", bw.Code, bw.Body.String())
	}
}


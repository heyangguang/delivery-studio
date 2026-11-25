package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDeliveryLifecycleFactsAndTools(t *testing.T) {
	s, _ := testStore(t)

	runningJob := storeJob{
		ID:           "job-pg-prod-01",
		Owner:        "alice",
		AppID:        "postgresql",
		AppName:      "PostgreSQL",
		Version:      "17",
		ClusterID:    "pg-jfrog-xray-public-prod",
		DeliveryMode: "offline",
		State:        "succeeded",
		Outcome:      outcomeDone,
		Marked:       "2026-10-28T02:03:00Z",
		MarkedBy:     "alice",
		RunDone:      12,
		RunTotal:     12,
		Created:      "2026-10-27T10:00:00Z",
	}
	pendingJob := storeJob{
		ID:           "job-redis-new-01",
		Owner:        "alice",
		AppID:        "redis",
		AppName:      "Redis",
		Version:      "7.2",
		ClusterID:    "redis-staging-new",
		DeliveryMode: "automatic",
		State:        "succeeded",
		Outcome:      "",
		Created:      "2026-11-20T08:00:00Z",
	}
	s.mu.Lock()
	s.jobs[runningJob.ID] = runningJob
	s.jobs[pendingJob.ID] = pendingJob
	s.mu.Unlock()

	// Seed one existing rehearsal on the running cluster
	if err := s.saveRehearsal(changeRehearsal{
		ID:        "a1b2c3d4e5f6",
		ClusterID: runningJob.ClusterID,
		Title:     "PostgreSQL 参数调优演练",
		Stage:     "probing",
		UpdatedAt: "2026-11-22T09:00:00Z",
	}); err != nil {
		t.Fatalf("seed rehearsal: %v", err)
	}

	// 1. Running cluster lifecycle info & facts
	info, ok := s.deliveryLifecycleInfo(runningJob.ID)
	if !ok || !info.ClusterRunning || info.LifecycleCode != "running" {
		t.Fatalf("expected running cluster lifecycle, got ok=%v info=%+v", ok, info)
	}
	if len(info.Rehearsals) != 1 || info.Rehearsals[0].Title != "PostgreSQL 参数调优演练" {
		t.Fatalf("expected seeded rehearsal in lifecycle info, got %+v", info.Rehearsals)
	}
	facts := s.deliveryLifecycleFacts(runningJob.ID)
	for _, want := range []string{
		"pg-jfrog-xray-public-prod",
		"运行中（已投产）",
		"绝不要再向用户反问",
		"纯只读查询",
		"极速变更",
		"mode=\"quick\"",
		"简单推演",
		"全量推演",
		"变更报告",
		"propose_rehearsal",
		"PostgreSQL 参数调优演练",
	} {
		if !strings.Contains(facts, want) {
			t.Fatalf("running lifecycle facts missing %q:\n%s", want, facts)
		}
	}

	// 2. Pending cluster lifecycle info & facts
	pInfo, ok := s.deliveryLifecycleInfo(pendingJob.ID)
	if !ok || pInfo.ClusterRunning || pInfo.LifecycleCode != "pending" {
		t.Fatalf("expected pending cluster lifecycle, got ok=%v info=%+v", ok, pInfo)
	}
	pFacts := s.deliveryLifecycleFacts(pendingJob.ID)
	if !strings.Contains(pFacts, "待执行（尚未部署 / 未投产）") || !strings.Contains(pFacts, "不要向用户反问是否已投产") {
		t.Fatalf("unexpected pending lifecycle facts:\n%s", pFacts)
	}

	// 3. delivery_info JSON includes cluster_running + lifecycle + rehearsals
	var none []string
	tc := aiToolCtx{s: s, job: runningJob, user: "alice", session: "review", proposed: &none}
	diRaw := tc.run("delivery_info", "{}")
	var di map[string]any
	if err := json.Unmarshal([]byte(diRaw), &di); err != nil {
		t.Fatalf("unmarshal delivery_info: %v\nraw=%s", err, diRaw)
	}
	if running, _ := di["cluster_running"].(bool); !running {
		t.Fatalf("delivery_info cluster_running = %v, want true", di["cluster_running"])
	}
	if status, _ := di["lifecycle_status"].(string); status != "running" {
		t.Fatalf("delivery_info lifecycle_status = %q, want running", status)
	}

	// 4. list_deliveries clearly distinguishes running vs pending clusters
	ac := assistCtx{s: s, user: "alice"}
	listed := ac.run("list_deliveries", "{}")
	if !strings.Contains(listed, "pg-jfrog-xray-public-prod") || !strings.Contains(listed, "已部署完成·运行中（已投产）") {
		t.Fatalf("list_deliveries missing running state:\n%s", listed)
	}
	if !strings.Contains(listed, "redis-staging-new") || !strings.Contains(listed, "待执行（未部署）") {
		t.Fatalf("list_deliveries missing pending state:\n%s", listed)
	}

	// 5. clusterHistoryText clearly reports running state & rehearsals
	hist := s.clusterHistoryText(runningJob.ClusterID)
	if !strings.Contains(hist, "已部署完成 / 运行中（已投产）") || !strings.Contains(hist, "已有变更演练") {
		t.Fatalf("clusterHistoryText missing expected info:\n%s", hist)
	}
}

func TestProposeRehearsalInGeneralAndDeliveryChats(t *testing.T) {
	s, _ := testStore(t)
	runningJob := storeJob{
		ID:           "job-pg-prod-02",
		Owner:        "alice",
		AppID:        "postgresql",
		AppName:      "PostgreSQL",
		Version:      "17",
		ClusterID:    "pg-jfrog-xray-public-prod",
		DeliveryMode: "offline",
		State:        "succeeded",
		Outcome:      outcomeDone,
		Created:      "2026-10-27T10:00:00Z",
	}
	s.mu.Lock()
	s.jobs[runningJob.ID] = runningJob
	s.mu.Unlock()

	// 1. assistantTools exposes propose_rehearsal while keeping mutating proposals out
	hasRehearsal := false
	for _, td := range assistantTools() {
		if td.Name == "propose_rehearsal" {
			hasRehearsal = true
		}
		if td.Name == "propose_step" || td.Name == "propose_change" || td.Name == "propose_file_change" {
			t.Fatalf("assistantTools should not expose mutating tool %q", td.Name)
		}
	}
	if !hasRehearsal {
		t.Fatalf("assistantTools missing propose_rehearsal")
	}

	// 1b. Light mode rehearsal card emits mode="light"
	var lightRehearsed []aiRehearsalSpec
	acLight := assistCtx{
		s:          s,
		user:       "alice",
		ctx:        chatCtx{Kind: "job", ID: runningJob.ID, Name: runningJob.ClusterID},
		ev:         sse{w: httptest.NewRecorder()},
		rehearsals: &lightRehearsed,
	}
	lightArgs := `{"mode":"light","kind":"tune","title":"Patroni pg_hba 补本地复制规则","summary":"仅 reload 生效，先用极简探针核实规则","goal":"核实 DCS pg_hba 后补充 127.0.0.1 复制规则并验证报错消失","reason":"局部配置修改且无需重启切主，走简单推演即可"}`
	if lOut := acLight.run("propose_rehearsal", lightArgs); !strings.Contains(lOut, "已生成变更演练发起卡片") {
		t.Fatalf("unexpected light propose_rehearsal output: %s", lOut)
	}
	if len(lightRehearsed) != 1 || lightRehearsed[0].Mode != "light" {
		t.Fatalf("expected mode=light rehearsal spec, got %+v", lightRehearsed)
	}

	// 2. General AI chat (assistCtx) emits SSE rehearsal event, enriches cluster metadata, and deduplicates
	rec := httptest.NewRecorder()
	var rehearsed []aiRehearsalSpec
	ac := assistCtx{
		s:          s,
		user:       "alice",
		ctx:        chatCtx{Kind: "job", ID: runningJob.ID, Name: runningJob.ClusterID},
		ev:         sse{w: rec},
		rehearsals: &rehearsed,
	}
	args := `{"kind":"tune","title":"PostgreSQL 异机 WAL 归档变更演练","summary":"调整 pgBackRest 归档策略将 WAL 同步至异机仓库。","goal":"对集群 pg-jfrog-xray-public-prod 调整 pgBackRest 配置，实现全量+增量 WAL 归档至独立备份机，先做只读探针核对当前 stanza 与 TDE 归档命令，再在测试环境完成备份与 PITR 恢复演练。","reason":"集群已投产运行且开启 TDE，变更归档配置必须先经演练验证。"}`
	out := ac.run("propose_rehearsal", args)
	if !strings.Contains(out, "已生成变更演练发起卡片") || !strings.Contains(out, runningJob.ClusterID) {
		t.Fatalf("unexpected assistCtx propose_rehearsal output: %s", out)
	}
	if len(rehearsed) != 1 {
		t.Fatalf("expected 1 rehearsal card recorded, got %d", len(rehearsed))
	}
	spec := rehearsed[0]
	if spec.ClusterID != runningJob.ClusterID || spec.Kind != "tune" || !spec.Running || spec.AppLabel != "PostgreSQL 17" {
		t.Fatalf("unexpected enriched rehearsal spec: %+v", spec)
	}
	if !strings.Contains(rec.Body.String(), `"t":"rehearsal"`) || !strings.Contains(rec.Body.String(), "异机 WAL 归档变更演练") {
		t.Fatalf("expected SSE rehearsal event, got body:\n%s", rec.Body.String())
	}
	// Duplicate call in the same turn should deduplicate
	dupOut := ac.run("propose_rehearsal", args)
	if !strings.Contains(dupOut, "已在当前回复中生成") || len(rehearsed) != 1 {
		t.Fatalf("expected deduplication, got len=%d out=%s", len(rehearsed), dupOut)
	}

	// 3. Delivery review chat (aiToolCtx) creates persisted proposal card for propose_rehearsal
	var proposed []string
	tc := aiToolCtx{s: s, job: runningJob, user: "alice", session: "review", proposed: &proposed}
	dOut := tc.run("propose_rehearsal", args)
	if !strings.Contains(dOut, "变更演练发起卡片 #") || len(proposed) != 1 {
		t.Fatalf("expected delivery rehearsal proposal, got proposed=%v out=%s", proposed, dOut)
	}
	allProps := s.loadProposals(runningJob.ID)
	if len(allProps) != 1 || allProps[0].Kind != "rehearsal" || allProps[0].Rehearsal == nil {
		t.Fatalf("expected 1 persisted rehearsal proposal, got %+v", allProps)
	}
	if !allProps[0].Rehearsal.Running || allProps[0].Rehearsal.Kind != "tune" || allProps[0].Rehearsal.Goal == "" {
		t.Fatalf("persisted rehearsal proposal missing enriched fields: %+v", allProps[0].Rehearsal)
	}

	// 4. filterCardOutputTools preserves rehearsal/proposal tools after research round budget is reached
	kept := filterCardOutputTools(assistantTools())
	foundReh := false
	for _, td := range kept {
		if td.Name == "propose_rehearsal" {
			foundReh = true
		}
		if td.Name == "read_file" || td.Name == "search_files" || td.Name == "delivery_info" {
			t.Fatalf("filterCardOutputTools should strip lookup tool %q", td.Name)
		}
	}
	if !foundReh {
		t.Fatalf("filterCardOutputTools must preserve propose_rehearsal, got %+v", kept)
	}
}

func TestProposeKnowledgeAndComponentCards(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	admin, acsrf := storeLogin(t, s, "admin")

	job := storeJob{
		ID:        "abcdef0123456789abcdef0123456789",
		Owner:     "alice",
		AppID:     "postgresql",
		AppName:   "PostgreSQL",
		Version:   "17",
		ClusterID: "pg-kb-demo",
		State:     "succeeded",
		Outcome:   outcomeDone,
	}
	s.mu.Lock()
	s.jobs[job.ID] = job
	s.mu.Unlock()

	// 1. All 3 AI chat engines expose propose_knowledge + suggest_component_change and filterCardOutputTools preserves both.
	for _, set := range []struct {
		name  string
		tools []aiToolDef
	}{
		{"delivery", aiTools()},
		{"assistant", assistantTools()},
		{"portal", aiPortalTools()},
	} {
		var hasKB, hasComp bool
		for _, td := range filterCardOutputTools(set.tools) {
			if td.Name == "propose_knowledge" {
				hasKB = true
			}
			if td.Name == "suggest_component_change" {
				hasComp = true
			}
		}
		if !hasKB || !hasComp {
			t.Fatalf("%s card tools missing propose_knowledge(%v) or suggest_component_change(%v)", set.name, hasKB, hasComp)
		}
	}

	// 2. General AI Assistant emits inline SSE knowledge + component_suggest cards cleanly.
	rec := httptest.NewRecorder()
	var kbs []aiKnowledgeSpec
	var comps []aiComponentSpec
	ac := assistCtx{
		s:          s,
		user:       "alice",
		ctx:        chatCtx{Kind: "job", ID: job.ID, Name: job.ClusterID},
		ev:         sse{w: rec},
		knowledges: &kbs,
		components: &comps,
	}
	kbOut := ac.run("propose_knowledge", `{"title":"Patroni PG 17 开启日志落盘指南","summary":"通过 patronictl edit-config 统一落盘日志","content":"## 步骤\n先建目录再 edit-config\npassword=SuperSecretKB999","scope":"team"}`)
	if !strings.Contains(kbOut, "写入知识库总结卡片") || len(kbs) != 1 {
		t.Fatalf("unexpected assistant propose_knowledge result: len=%d out=%s", len(kbs), kbOut)
	}
	if strings.Contains(kbs[0].Content, "SuperSecretKB999") {
		t.Fatalf("secret not scrubbed in knowledge card: %+v", kbs[0])
	}
	compOut := ac.run("suggest_component_change", `{"component":"postgresql","title":"补充 logging_collector 与 log_directory 参数入口","detail":"在 roles/postgresql/defaults/main.yml 与模板中支持日志落盘与轮转配置","why":"交付规格缺失日志落盘参数"}`)
	if !strings.Contains(compOut, "已生成组件改进建议卡片") || len(comps) != 1 || comps[0].Component != "postgresql" {
		t.Fatalf("unexpected assistant suggest_component_change result: len=%d out=%s", len(comps), compOut)
	}
	if !strings.Contains(rec.Body.String(), `"t":"knowledge"`) || !strings.Contains(rec.Body.String(), `"t":"component_suggest"`) {
		t.Fatalf("expected SSE knowledge & component_suggest events, got:\n%s", rec.Body.String())
	}

	// 3. Delivery chat creates persisted knowledge proposal; accepting saves to personal KB (alice) or publishes directly to team KB (admin).
	var proposed []string
	tc := aiToolCtx{s: s, job: job, user: "alice", session: "review:abc", proposed: &proposed}
	dOut := tc.run("propose_knowledge", `{"title":"PG 日志落盘操作手册","summary":"Patroni 集群日志落盘步骤","content":"## 原则\n使用 patronictl edit-config。","scope":"personal"}`)
	if !strings.Contains(dOut, "写入知识库总结卡片 #") || len(proposed) != 1 {
		t.Fatalf("delivery propose_knowledge failed: proposed=%v out=%s", proposed, dOut)
	}
	pid1 := proposed[0]
	w := storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/proposals/"+pid1+"/accept", strings.NewReader(`{"scope":"personal","title":"PG 日志落盘操作手册（微调版）"}`), alice, csrf)
	if w.Code != 200 {
		t.Fatalf("accept personal KB proposal: %d %s", w.Code, w.Body.String())
	}
	var accepted1 aiProposal
	_ = json.Unmarshal(w.Body.Bytes(), &accepted1)
	if accepted1.Status != "accepted" || accepted1.Knowledge == nil || accepted1.Knowledge.KBID == "" || accepted1.Knowledge.Title != "PG 日志落盘操作手册（微调版）" {
		t.Fatalf("unexpected personal KB accept result: %+v", accepted1)
	}
	if searchW := storeRequest(s, "GET", "/api/me/kb/search?q=patronictl", nil, alice, ""); !strings.Contains(searchW.Body.String(), "微调版") {
		t.Fatalf("saved personal KB doc not searchable: %s", searchW.Body.String())
	}

	// Second proposal accepted directly into Team KB by admin (kb.manage)
	dOut2 := tc.run("propose_knowledge", `{"title":"团队 PG 日志落盘规范","summary":"全员复用的 Patroni 日志规范","content":"## 规范\n目录权限 0750。","scope":"team"}`)
	if !strings.Contains(dOut2, "写入知识库总结卡片 #") || len(proposed) != 2 {
		t.Fatalf("delivery propose_knowledge #2 failed: proposed=%v out=%s", proposed, dOut2)
	}
	pid2 := proposed[1]
	w2 := storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/proposals/"+pid2+"/accept", strings.NewReader(`{"scope":"team"}`), admin, acsrf)
	if w2.Code != 200 {
		t.Fatalf("accept team KB proposal: %d %s", w2.Code, w2.Body.String())
	}
	var accepted2 aiProposal
	_ = json.Unmarshal(w2.Body.Bytes(), &accepted2)
	if accepted2.Status != "accepted" || accepted2.Knowledge == nil || accepted2.Knowledge.TeamDocID == "" {
		t.Fatalf("unexpected team KB accept result: %+v", accepted2)
	}
	if teamW := storeRequest(s, "GET", "/api/kb", nil, admin, ""); !strings.Contains(teamW.Body.String(), "团队 PG 日志落盘规范") {
		t.Fatalf("published team KB doc missing from /api/kb: %s", teamW.Body.String())
	}
}

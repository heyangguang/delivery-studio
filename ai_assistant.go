package main

import (
	"encoding/json"
	"fmt"
	"middleware-deployer/mwpack"
	"middleware-deployer/pkglib"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// The assistant page: conversations that belong to a person, not to a delivery. They can be tied to a delivery or a
// component, and then the assistant reads that one first; otherwise it can look up the person's deliveries and the
// components by itself. It only reads. Anything it finds that should change is changed in the delivery's own window,
// where proposals are reviewed.

type chatCtx struct {
	Kind string `json:"kind"` // "" | job | comp
	ID   string `json:"id"`
	Name string `json:"name"`
}

type userChat struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Ctx      chatCtx `json:"ctx"`
	Messages []aiMsg `json:"messages"`
	Created  string  `json:"created"`
	Updated  string  `json:"updated"`
	// Archived conversations are out of the list but kept, and can be brought back.
	Archived bool `json:"archived,omitempty"`
}

var reChatID = regexp.MustCompile(`^[0-9a-f]{12}$`)

func (s *storeServer) chatDir(user string) string {
	return filepath.Join(s.cfg.DataDir, "ai-chats", sessionID(user))
}

func (s *storeServer) loadChat(user, id string) (userChat, bool) {
	c := userChat{ID: id, Messages: []aiMsg{}}
	b, err := os.ReadFile(filepath.Join(s.chatDir(user), id+".json"))
	if err != nil {
		return c, false
	}
	_ = json.Unmarshal(b, &c)
	if c.Messages == nil {
		c.Messages = []aiMsg{}
	}
	return c, true
}

func (s *storeServer) saveChat(user string, c userChat) error {
	c.Updated = time.Now().UTC().Format(time.RFC3339)
	return writeJSONFile(filepath.Join(s.chatDir(user), c.ID+".json"), c)
}

// ownJob finds one of the person's deliveries by id or by cluster name.
func (s *storeServer) ownJob(user, ref string) (storeJob, bool) {
	vis := s.visibleJobs(user)
	s.mu.Lock()
	defer s.mu.Unlock()
	if j, ok := s.jobs[ref]; ok && vis(j.Owner) {
		return j, true
	}
	var best storeJob
	found := false
	for _, j := range s.jobs {
		if vis(j.Owner) && j.State == "succeeded" && (j.ClusterID == ref || strings.HasPrefix(j.ID, ref) && len(ref) >= 6) && (!found || j.Created > best.Created) {
			best, found = j, true
		}
	}
	return best, found
}

func assistantTools() []aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	obj := func(props map[string]any, req ...string) map[string]any {
		return map[string]any{"type": "object", "properties": props, "required": req}
	}
	dlv := str("交付的集群标识或编号；已关联交付时可省略")
	tools := []aiToolDef{
		{"list_deliveries", "列出你的交付：集群、应用、版本、部署/投产状态、生成状态、创建时间、执行进度。", obj(map[string]any{})},
		{"library_runtimes", "查看平台软件库中的 Ansible 运行环境构建清单、各操作系统当前默认构建、依赖 wheel 版本、历史构建与默认构建的差异，以及是否可安全删除。评估历史运行环境构建或依赖升级时先调它，不要让用户截图。", obj(map[string]any{
			"runtime_id": str("可选：只聚焦核对某一个运行环境构建 ID（及其对照的默认构建）"),
		})},
		aiProposeRehearsalTool(),
		aiProposeKnowledgeTool(),
		aiSuggestTool(),
	}
	for _, t := range aiTools() {
		if strings.HasPrefix(t.Name, "propose") || t.Name == "suggest_component_change" {
			continue
		}
		props := map[string]any{"delivery": dlv}
		for k, v := range t.Parameters["properties"].(map[string]any) {
			props[k] = v
		}
		req, _ := t.Parameters["required"].([]string)
		tools = append(tools, aiToolDef{t.Name, t.Description, obj(props, req...)})
	}
	for _, t := range compTools() {
		switch t.Name {
		case "component_guide", "list_components", "example_component":
			tools = append(tools, t)
		}
	}
	return tools
}

type assistCtx struct {
	s          *storeServer
	user       string
	ctx        chatCtx
	ev         sse
	rehearsals *[]aiRehearsalSpec
	knowledges *[]aiKnowledgeSpec
	components *[]aiComponentSpec
}

func (c assistCtx) run(name, args string) string {
	var a map[string]any
	_ = json.Unmarshal([]byte(args), &a)
	switch name {
	case "component_guide", "list_components", "example_component":
		return compToolCtx{s: c.s}.run(name, args)
	case "library_runtimes":
		rtID, _ := a["runtime_id"].(string)
		return c.s.libraryRuntimesSummary(strings.TrimSpace(rtID))
	case "propose_rehearsal":
		str := func(k string) string { v, _ := a[k].(string); return strings.TrimSpace(v) }
		ref := firstNonEmptyStr(str("cluster_id"), str("delivery"))
		if ref == "" && c.ctx.Kind == "job" {
			ref = c.ctx.ID
		}
		if ref == "" {
			return "请指明目标集群（cluster_id），可以先调用 list_deliveries 查看。"
		}
		j, ok := c.s.ownJob(c.user, ref)
		if !ok {
			return "没有找到该集群或当前账户无权查看：" + ref
		}
		spec, errMsg := c.s.buildRehearsalSpec(c.user, j.ClusterID, j.ID, a, false)
		if errMsg != "" {
			return "演练卡片未通过校验：" + errMsg
		}
		if c.rehearsals != nil {
			for _, ex := range *c.rehearsals {
				if ex.ClusterID == spec.ClusterID && ex.Title == spec.Title {
					return "该变更演练卡片已在当前回复中生成（集群：" + spec.ClusterID + "，标题：「" + spec.Title + "」）。"
				}
			}
			*c.rehearsals = append(*c.rehearsals, *spec)
		}
		if c.ev.w != nil {
			c.ev.send(map[string]any{"t": "rehearsal", "v": *spec})
		}
		return "已生成变更演练发起卡片（目标集群：" + spec.ClusterID + "，标题：「" + spec.Title + "」）。用户点击卡片即可直接带入本次演练目标前往该集群的「变更演练」工作台。"
	case "propose_knowledge":
		src := ""
		if c.ctx.Name != "" {
			src = c.ctx.Name
		}
		spec, errMsg := buildKnowledgeSpec(src, a)
		if errMsg != "" {
			return "知识库卡片未通过校验：" + errMsg
		}
		if c.knowledges != nil {
			for _, ex := range *c.knowledges {
				if ex.Title == spec.Title {
					return "知识库总结卡片已在当前回复中生成（标题：「" + spec.Title + "」）。"
				}
			}
			*c.knowledges = append(*c.knowledges, *spec)
		}
		if c.ev.w != nil {
			c.ev.send(map[string]any{"t": "knowledge", "v": *spec})
		}
		return "已生成写入知识库总结卡片（标题：「" + spec.Title + "」）。用户可在下方卡片直接预览/微调并一键存入「我的知识库」或发布到「团队知识库」。"
	case "suggest_component_change":
		spec, errMsg := c.s.buildComponentSpec(a)
		if errMsg != "" {
			return "组件改进建议未通过校验：" + errMsg
		}
		if c.components != nil {
			for _, ex := range *c.components {
				if ex.Component == spec.Component && ex.Title == spec.Title {
					return "该组件改进建议卡片已在当前回复中生成（组件：" + spec.Component + "，标题：「" + spec.Title + "」）。"
				}
			}
			*c.components = append(*c.components, *spec)
		}
		if c.ev.w != nil {
			c.ev.send(map[string]any{"t": "component_suggest", "v": *spec})
		}
		return "已生成组件改进建议卡片（组件：" + spec.Component + "，标题：「" + spec.Title + "」）。用户点击卡片即可新标签页打开组件工作台由 AI 起草改动。"
	case "list_deliveries":
		vis := c.s.visibleJobs(c.user)
		c.s.mu.Lock()
		var rows []storeJob
		byCluster := map[string][]storeJob{}
		for _, j := range c.s.jobs {
			if vis(j.Owner) {
				rows = append(rows, j)
				if j.ClusterID != "" {
					byCluster[j.ClusterID] = append(byCluster[j.ClusterID], j)
				}
			}
		}
		c.s.mu.Unlock()
		runningCluster := map[string]bool{}
		for cid, js := range byCluster {
			sortJobs(js)
			if _, ok := clusterHead(js); ok {
				runningCluster[cid] = true
			}
		}
		sort.Slice(rows, func(i, k int) bool { return rows[i].Created > rows[k].Created })
		var b strings.Builder
		for i, j := range rows {
			if i >= 40 {
				b.WriteString("…（只列最近 40 份）\n")
				break
			}
			deployState := "待执行（未部署）"
			switch {
			case j.DeliveryMode == "configuration":
				deployState = "仅生成配置"
			case j.Outcome == outcomeDone:
				deployState = "已部署完成·运行中（已投产）"
			case j.Outcome == outcomeDeviated:
				deployState = "已部署完成（有偏差）·运行中（已投产）"
			case j.Outcome == outcomeFailed:
				deployState = "部署失败"
			case j.Outcome == outcomeVoid:
				deployState = "已作废"
			case runningCluster[j.ClusterID]:
				deployState = "集群运行中（本交付待执行）"
			case j.RunDone > 0 || j.RunFailed > 0:
				deployState = "执行中/待确认结果"
			}
			fmt.Fprintf(&b, "- %s · %s %s · 部署状态：%s · 生成：%s · 创建 %s · 编号 %s · 执行记录 完成%d 失败%d / %d\n", j.ClusterID, j.AppName, j.Version, deployState, j.State, j.Created, j.ID, j.RunDone, j.RunFailed, j.RunTotal)
		}
		if b.Len() == 0 {
			return "还没有交付。"
		}
		return b.String()
	}
	ref, _ := a["delivery"].(string)
	if ref == "" {
		if c.ctx.Kind == "job" {
			ref = c.ctx.ID
		} else {
			return "请指明是哪份交付（delivery 参数：集群标识或编号），可以先调用 list_deliveries。"
		}
	}
	j, ok := c.s.ownJob(c.user, ref)
	if !ok || j.State != "succeeded" {
		return "没有找到这份交付，或它还没有生成成功：" + ref
	}
	delete(a, "delivery")
	b, _ := json.Marshal(a)
	var none []string
	return aiToolCtx{s: c.s, job: j, user: c.user, session: "assistant", proposed: &none}.run(name, string(b))
}

const assistSystem = `你是 Kyndryl Delivery Studio（离线与自动化中间件交付平台）里的 AI 助手，回答用户关于交付、组件、部署、排障和变更演练的问题。
- 先用工具查看实际内容再回答：用户的交付、部署/投产状态、执行手册、项目文件、组件和设计指南都能读到。不要凭记忆编造平台里的数据。
- **严禁向用户反问平台已知的状态**：对话已关联交付或已通过 list_deliveries / delivery_info / cluster_history 查到集群状态时，**绝对不要问“这个集群已经投产了吗 / 已经部署完成了吗”**——直接以平台真实记录的部署/运行状态为依据。
- 核对某份交付里的具体配置、日志、参数或模板是否存在时，优先用 delivery_info + search_files（原生全文搜索）+ read_file（支持 from_line）精准定位，不必仅为查文本启动沙箱命令；沙箱留给精确计算、脚本校验、日志解析或生成导出文件。
- 诊断交付执行失败、或识别到组件本身存在缺陷/缺失通用前置检查/缺少有普遍价值的配置参数入口（例如组件未提供 logging_collector、log_directory 等常用运维开关）时，关联交付先调用 component_sync_status 核对当前已发布组件和草稿是否已经修复或支持：若最新组件已修复，直接引导「同步组件更新」；若仅草稿已改则提醒先发布再同步；若尚未支持/修复，**必须主动调用 suggest_component_change 生成「组件改进建议」卡片**，让用户一键跳转组件工作台让 AI 起草改动。
- **写入知识库总结卡片（propose_knowledge）**：当用户要求将本次排障、方案或操作经验整理/生成/写入知识库，或一次有复用价值的现场排障/变更讨论已经得出明确结论时，**必须主动调用 propose_knowledge 输出「写入知识库总结卡片」**（填好清晰标题、一句话摘要与结构化 Markdown 正文，未确认的根因如实写明「待确认」，不含口令密钥），让用户在卡片里一键存入「我的知识库」或发布到「团队知识库」；绝不要声称「没有写入知识库的工具」。
- 评估软件库中的 Ansible 运行环境历史构建、依赖差异或可否清理时，先调用 library_runtimes 读取平台真实默认构建与依赖对照，再调用 check_package_security（配合 web_search / web_fetch）核实 CVE 与最新版本；无需让用户手贴默认构建截图，也无需默认启动 Python 沙箱写爬虫。
- 你不能直接修改交付文件或目标服务器。对于**已部署完成、运行中（已投产）的集群**，严守「零未留痕变更」分级铁律：
  · **纯只读排查（零修改，不进演练）**：仅查状态、看日志、查主从/连接/复制延迟或核对配置现状（不修改任何配置、文件或服务）→ 直接给 1～3 条只读命令，**不要调用 propose_rehearsal**。
  · **极速变更（propose_rehearsal + mode="quick"）**：只要涉及**任何配置/参数/规则/文件修改**，哪怕非常简单、仅 reload 无需重启且现状已在对话或截图中明确（如在线修改 log_filename / log_rotation_size、补单条明确规则），**也必须在正文讲清方案后主动调用 propose_rehearsal 并设 mode="quick"**（跳过问答与探针，直出 2～3 步执行清单并一键归档《变更报告》），绝不只丢命令导致集群变更无记录！
  · **简单推演（propose_rehearsal + mode="light"）**：要改配置/补规则/在线动态调参且无需重启和切主，但现场状态拿不准需先用只读探针核实后再执行与出《变更报告》→ 主动调用 propose_rehearsal 并设 mode="light"；若属组件模板/默认参数遗漏，一并出 suggest_component_change 卡片。
  · **全量推演（propose_rehearsal + mode="full"）**：需滚动重启服务、主备切换、版本/CVE 升级、扩缩容、备份/WAL/归档改造、证书轮换等高风险变更 → 在回答讲清方案、冲突与风险后，**主动调用 propose_rehearsal 并设 mode="full"** 输出全量推演卡片（填好清晰可执行的 goal 诉求），不要只用文字口头引导。如果需要修改未投产交付的手册或步骤，则告知用户在交付页点「AI 辅助」生成提案确认后生效。
- 密码、密钥、证书不会提供给你，也不要索取。
- 回答用中文，先给结论再给依据；命令用代码块；有风险的操作要明确提醒。思考过程的摘要也尽量用中文写。不要用 LaTeX 公式，数学用普通文字和符号表示。
- 用户没有关联交付时，先 list_deliveries 弄清是哪一份及其部署状态再往下查。`

func (s *storeServer) handleAIChats(w http.ResponseWriter, r *http.Request, user storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/ai/chats"), "/")
	parts := strings.Split(rest, "/")
	switch {
	case rest == "" && r.Method == "GET":
		s.writeJSON(w, 200, map[string]any{
			"chats":         s.listChats(user.User),
			"linked":        s.linkedSessions(user.User),
			"comp_sessions": s.compSessions(user.User),
		})
	case len(parts) == 1 && reChatID.MatchString(parts[0]) && r.Method == "GET":
		c, ok := s.loadChat(user.User, parts[0])
		if !ok {
			s.fail(w, 404, "对话不存在")
			return
		}
		s.writeJSON(w, 200, c)
	case len(parts) == 1 && reChatID.MatchString(parts[0]) && r.Method == "DELETE":
		_ = os.Remove(filepath.Join(s.chatDir(user.User), parts[0]+".json"))
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case len(parts) == 1 && reChatID.MatchString(parts[0]) && r.Method == "PATCH":
		var in struct {
			Title    *string `json:"Title"`
			Archived *bool   `json:"archived"`
		}
		c, ok := s.loadChat(user.User, parts[0])
		if !ok || json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&in) != nil || (in.Title == nil && in.Archived == nil) || (in.Title != nil && strings.TrimSpace(*in.Title) == "") {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		if in.Title != nil {
			c.Title = truncRunes(strings.TrimSpace(*in.Title), 60)
		}
		if in.Archived != nil {
			c.Archived = *in.Archived
			s.auditReq(r, map[bool]string{true: "ai-chat-archive", false: "ai-chat-unarchive"}[c.Archived], user.User, c.Title)
		}
		_ = s.saveChat(user.User, c)
		s.writeJSON(w, 200, c)
	case len(parts) == 2 && reChatID.MatchString(parts[0]) && parts[1] == "chat" && r.Method == "POST":
		s.assistantChat(w, r, user, parts[0])
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) listChats(user string) []userChat {
	out := []userChat{}
	files, _ := filepath.Glob(filepath.Join(s.chatDir(user), "*.json"))
	for _, f := range files {
		var c userChat
		if b, err := os.ReadFile(f); err == nil && json.Unmarshal(b, &c) == nil {
			c.Messages = nil
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	return out
}

type linkedSession struct {
	Job     string `json:"job"`
	Cluster string `json:"cluster"`
	Key     string `json:"key"`
	Title   string `json:"title"`
	Kind    string `json:"kind"`
	Updated string `json:"updated"`
	// Plan names the delivery inside its cluster: 首次部署, 扩容方案 #3.
	Plan string `json:"plan"`
}

// linkedSessions are the conversations held in the person's own deliveries, so the page is one place to find them all.
func (s *storeServer) linkedSessions(user string) []linkedSession {
	s.mu.Lock()
	var jobs []storeJob
	for _, j := range s.jobs {
		if j.Owner == user {
			jobs = append(jobs, j)
		}
	}
	s.mu.Unlock()
	out := []linkedSession{}
	for _, j := range jobs {
		files, _ := filepath.Glob(filepath.Join(s.aiDir(j.ID), "sessions", "*.json"))
		for _, f := range files {
			var ss aiSession
			if b, err := os.ReadFile(f); err == nil && json.Unmarshal(b, &ss) == nil && len(ss.Messages) > 0 {
				out = append(out, linkedSession{Job: j.ID, Cluster: j.ClusterID, Key: ss.Key, Title: ss.Title, Kind: ss.Kind, Updated: ss.Updated, Plan: jobTitle(j)})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	if len(out) > 60 {
		out = out[:60]
	}
	return out
}

type compSession struct {
	Comp      string `json:"comp"`
	CompTitle string `json:"comp_title"`
	HistoryID string `json:"history_id,omitempty"`
	Title     string `json:"title"`
	Label     string `json:"label,omitempty"`
	Rev       int    `json:"rev,omitempty"`
	Messages  int    `json:"messages"`
	Accepted  int    `json:"accepted,omitempty"`
	Updated   string `json:"updated"`
	Active    bool   `json:"active"`
	HasDraft  bool   `json:"has_draft,omitempty"`
}

// compSessions collects both active and archived Component Workbench AI conversations
// so every component-authoring discussion remains browsable in the unified AI Assistant page.
func (s *storeServer) compSessions(user string) []compSession {
	out := []compSession{}
	if !s.can(user, "component.edit") || s.cfg.DataDir == "" {
		return out
	}
	root := filepath.Join(s.cfg.DataDir, "ai-comp")
	entries, err := os.ReadDir(root)
	if err != nil {
		return out
	}
	cat := s.plat.cat()
	cs := s.comps()
	titleOf := func(name string) string {
		if name == sharedPlatformName {
			return "平台公共流程"
		}
		if comp, ok := cat.Get(name); ok && strings.TrimSpace(comp.Title) != "" {
			return comp.Title
		}
		return name
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		cTitle := titleOf(name)
		hasDraft := s.plat.componentsDir != "" && cs.hasDraft(name)
		// 1) Current active workbench session
		sessionPath := filepath.Join(root, name, "session.json")
		if b, rerr := os.ReadFile(sessionPath); rerr == nil {
			var ss aiSession
			if json.Unmarshal(b, &ss) == nil && len(ss.Messages) > 0 {
				title := ""
				updated := ""
				for _, m := range ss.Messages {
					if title == "" && m.Role == "user" && strings.TrimSpace(m.Text) != "" {
						title = truncRunes(strings.Join(strings.Fields(m.Text), " "), 60)
					}
					if m.At != "" {
						updated = m.At
					}
				}
				if title == "" {
					title = "组件工作台对话"
				}
				if updated == "" {
					if fi, serr := os.Stat(sessionPath); serr == nil {
						updated = fi.ModTime().UTC().Format(time.RFC3339)
					}
				}
				accepted := 0
				for _, p := range s.loadCompProposals(name) {
					if p.Status == "accepted" {
						accepted++
					}
				}
				out = append(out, compSession{
					Comp:      name,
					CompTitle: cTitle,
					Title:     title,
					Messages:  len(ss.Messages),
					Accepted:  accepted,
					Updated:   updated,
					Active:    true,
					HasDraft:  hasDraft,
				})
			}
		}
		// 2) Archived historical workbench sessions (published / discarded / cleared)
		for _, h := range s.listCompHistory(name) {
			if h.Messages == 0 {
				continue
			}
			title := strings.TrimSpace(h.Title)
			if title == "" {
				title = "组件工作台历史对话"
			}
			out = append(out, compSession{
				Comp:      name,
				CompTitle: cTitle,
				HistoryID: h.ID,
				Title:     title,
				Label:     h.Label,
				Rev:       h.Rev,
				Messages:  h.Messages,
				Accepted:  h.Accepted,
				Updated:   h.At,
				Active:    false,
				HasDraft:  hasDraft,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	if len(out) > 80 {
		out = out[:80]
	}
	return out
}

func (s *storeServer) assistantChat(w http.ResponseWriter, r *http.Request, user storeSession, id string) {
	var in struct {
		Message     string   `json:"message"`
		Ctx         chatCtx  `json:"ctx"`
		Model       string   `json:"model"`
		Options     aiOpts   `json:"options"`
		Attachments []string `json:"attachments"`
		// Note is what the page knows and the model should too (what is already in the form); it is not shown as the person's words.
		Note string `json:"note"`
		// Form is the new-delivery form as it is now, sent by that page with every message of a form conversation.
		Form  *formState `json:"form"`
		Retry bool       `json:"retry"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<19)).Decode(&in) != nil || (strings.TrimSpace(in.Message) == "" && len(in.Attachments) == 0) || len([]rune(in.Message)) > 20000 || len(in.Attachments) > 8 {
		s.fail(w, 400, "请输入内容，或者附上文件（一次最多 8 个）")
		return
	}
	attached, aerr := s.attachments(user.User, in.Attachments)
	if aerr != "" {
		s.fail(w, 400, aerr)
		return
	}
	c, existed := s.loadChat(user.User, id)
	kind := c.Ctx.Kind
	if !existed {
		kind = in.Ctx.Kind
	}
	// a form conversation is the form-filling feature, with its own switch and models
	feature := "assistant"
	if kind == "form" {
		feature = "form"
	}
	if code, msg := s.checkAIFeature(user.User, feature); code != 0 {
		s.fail(w, code, msg)
		return
	}
	st := s.aiLoad()
	providers := st.aiProvidersForPick(feature, in.Model)
	if len(providers) == 0 {
		s.fail(w, 409, "没有可用的模型供应商，请管理员在平台设置 → AI 中配置")
		return
	}
	if st.MonthlyLimit > 0 && s.aiCallsThisMonth(user.User) >= st.MonthlyLimit {
		s.fail(w, 429, "本月 AI 使用次数已达上限")
		return
	}
	if !existed {
		c.Created = time.Now().UTC().Format(time.RFC3339)
		switch in.Ctx.Kind {
		case "form":
			comp, ok := s.plat.cat().Get(in.Ctx.ID)
			if !ok {
				s.fail(w, 404, "要部署的组件不存在")
				return
			}
			c.Ctx = chatCtx{Kind: "form", ID: in.Ctx.ID, Name: comp.Title}
		case "job":
			j, ok := s.ownJob(user.User, in.Ctx.ID)
			if !ok {
				s.fail(w, 404, "关联的交付不存在")
				return
			}
			c.Ctx = chatCtx{Kind: "job", ID: j.ID, Name: j.ClusterID}
		case "comp":
			if _, ok := s.plat.cat().Get(in.Ctx.ID); !ok {
				s.fail(w, 404, "关联的组件不存在")
				return
			}
			c.Ctx = chatCtx{Kind: "comp", ID: in.Ctx.ID, Name: in.Ctx.ID}
		}
		c.Title = truncRunes(strings.TrimSpace(strings.SplitN(in.Message, "\n", 2)[0]), 40)
		if c.Title == "" && len(attached) > 0 {
			c.Title = truncRunes(attached[0].Name, 40)
		}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	refs := make([]fileRef, len(attached))
	for i, a := range attached {
		refs[i] = fileRef{ID: a.ID, Name: a.Name, Mime: a.Mime, Size: a.Size}
	}
	c.Messages = appendOrReuseUserTurn(c.Messages, in.Retry, aiMsg{Role: "user", Text: strings.TrimSpace(in.Message), Files: refs, At: now, By: user.User})
	// the question is kept before the answer starts: if it breaks off, the conversation still shows what was asked
	_ = s.saveChat(user.User, c)
	s.auditReq(r, "ai-chat", user.User, firstNonEmptyStr(c.Ctx.Name, "AI 助手"))
	fl, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ev := sse{w, fl}

	if c.Ctx.Kind == "form" && needsPGArchitectureAsk(c.Ctx.ID, in.Message, c.Messages) {
		ask := pgArchitectureAsk()
		c.Messages = append(c.Messages, aiMsg{Role: "assistant", Ask: ask, At: now})
		if err := s.saveChat(user.User, c); err != nil {
			ev.send(map[string]any{"t": "error", "v": "架构确认无法保存"})
			return
		}
		ev.send(map[string]any{"t": "ask", "v": ask})
		ev.send(map[string]any{"t": "done", "title": c.Title})
		return
	}
	system := assistSystem
	if c.Ctx.Kind == "form" {
		system = s.formPrompt(user.User, c.Ctx.ID)
	}
	switch c.Ctx.Kind {
	case "job":
		system += "\n本次对话关联的交付：" + c.Ctx.Name + "（编号 " + c.Ctx.ID + "）。用户说“这份交付”就是它。" + s.deliveryLifecycleFacts(c.Ctx.ID) + s.controllerFacts(c.Ctx.ID) + s.deliverySkillHint(c.Ctx.ID)
	case "comp":
		system += "\n本次对话关联的组件：" + c.Ctx.Name + "。用户说“这个组件”就是它，先用 example_component 读它的文件。"
	}
	noteTail := ""
	if n := strings.TrimSpace(in.Note); n != "" {
		noteTail = "\n" + aiScrub(truncRunes(n, 1200))
	}
	hist := c.Messages
	if len(hist) > 30 {
		hist = hist[len(hist)-30:]
	}
	in.Options.User = user.User
	in.Options.Made = &producedFiles{}
	if c.Ctx.Kind == "job" && c.Ctx.ID != "" {
		s.mu.Lock()
		j, ok := s.jobs[c.Ctx.ID]
		s.mu.Unlock()
		if ok && s.jobVisible(user.User, j) {
			in.Options.Workspace = s.deliveryWorkspaceSpec(j.ID, "交付项目 "+firstNonEmptyStr(c.Ctx.Name, j.AppName))
		}
	} else if c.Ctx.Kind == "comp" && c.Ctx.Name != "" {
		in.Options.Workspace = s.componentWorkspaceSpec(c.Ctx.Name)
	}
	ext := s.extFor(feature, in.Options)
	msgs := []aiMessage{{Role: "system", Content: system + ext.prompt}}
	for i, m := range hist {
		if isErrorOnlyMsg(m) {
			continue
		}
		if i == len(hist)-1 && len(attached) > 0 {
			continue // the new message is built below, with what was attached
		}
		text := aiScrub(m.Text + m.askText() + m.rehearsalText())
		if i == len(hist)-1 && m.Role == "user" && noteTail != "" {
			text += noteTail
		}
		if len(m.Files) > 0 {
			names := make([]string, len(m.Files))
			for k, f := range m.Files {
				names[k] = f.Name + "（编号 " + f.ID + "）"
			}
			text += "\n（当时附带的文件：" + strings.Join(names, "、") + "）"
		}
		msgs = append(msgs, aiMessage{Role: m.Role, Content: text})
	}
	if len(attached) > 0 {
		for _, pr := range providers[:1] {
			content, note := s.attachedContent(user.User, strings.TrimSpace(in.Message)+noteTail, attached, pr.Vision != "no")
			msgs = append(msgs, aiMessage{Role: "user", Content: content})
			if note != "" {
				ev.send(map[string]any{"t": "notice", "v": note})
			}
		}
	}
	var rehearsed []aiRehearsalSpec
	var knowledges []aiKnowledgeSpec
	var components []aiComponentSpec
	tc := assistCtx{s: s, user: user.User, ctx: c.Ctx, ev: ev, rehearsals: &rehearsed, knowledges: &knowledges, components: &components}
	tools, run := append(assistantTools(), ext.tools...), ext.wrap(tc.run)
	var fc *formCtx
	if c.Ctx.Kind == "form" {
		fc = &formCtx{s: s, user: user.User, files: attached, hist: histFiles(c.Messages), app: c.Ctx.ID, state: in.Form, ev: ev, messages: c.Messages}
		tools, run = append(append(formTools(), certTools()...), askTool()), fc.run
	}
	var none []string
	var final aiReply
	var used []string
	var lastErr error
	var tried aiProvider
	var failedAttempts []aiAttemptDiag
	for i, p := range providers {
		rehearsed = nil
		knowledges = nil
		components = nil
		tried = p
		start := time.Now()
		turnCtx := ext.bindCtx(effortCtx(r.Context(), in.Options), ev)
		reply, tl, err := s.aiToolLoop(turnCtx, p, msgs, tools, nil, ev, run, &none)
		u := usageFrom(p, reply)
		u.User, u.IP, u.Feature, u.Job, u.Target, u.Session, u.Tools = user.User, clientIP(r), feature, c.Ctx.ID, firstNonEmptyStr(c.Ctx.Name, tr(reqLang(r), "AI 助手", "AI Assistant")), id, len(tl)
		u.MS, u.OK, u.Failover = time.Since(start).Milliseconds(), err == nil, i > 0
		if err != nil {
			u.Error = truncRunes(err.Error(), 200)
			if d := aiDiagFromErr(err); d != nil {
				u.applyDiag(d)
				failedAttempts = append(failedAttempts, d.Attempts...)
			}
		}
		s.aiRecordUsage(u)
		if err == nil {
			final, used, lastErr = reply, tl, nil
			break
		}
		lastErr = err
		if r.Context().Err() != nil {
			return
		}
		if i+1 < len(providers) {
			ev.send(map[string]any{"t": "notice", "v": tr(reqLang(r), "「"+p.Name+" · "+p.Model+"」失败，改用备用模型", "\""+p.Name+" · "+p.Model+"\" failed; switching to backup model")})
		}
	}
	if lastErr != nil {
		errText := localizeGoMessage(reqLang(r), lastErr.Error())
		errDiag := buildChatErrorDiag(lastErr, failedAttempts, tried)
		c.Messages = append(c.Messages, aiMsg{Role: "assistant", Error: errText, ErrorDiag: errDiag, At: time.Now().UTC().Format(time.RFC3339)})
		c.Archived = false
		saved := s.saveChat(user.User, c) == nil
		errPayload := map[string]any{"t": "error", "v": errText, "saved": saved, "title": c.Title}
		if errDiag != nil {
			errPayload["diag"] = errDiag
		}
		ev.send(errPayload)
		return
	}
	answer := aiMsg{Role: "assistant", Text: final.Text, Tools: used, Steps: final.Steps, MS: final.TotalMS, Ask: final.Ask, Files: final.Files, Rehearsals: rehearsed, Knowledges: knowledges, Components: components, At: time.Now().UTC().Format(time.RFC3339)}
	if fc != nil {
		answer.Form = fc.filled
		if fc.filled != nil && fc.filled.TargetComponent != "" {
			c.Ctx = chatCtx{Kind: "form", ID: fc.filled.TargetComponent, Name: fc.filled.TargetComponent}
			if comp, ok := s.plat.cat().Get(fc.filled.TargetComponent); ok {
				c.Ctx.Name = comp.Title
			}
		}
	}
	c.Messages = append(c.Messages, answer)
	c.Archived = false // carrying on a conversation brings it back
	s.learnLater(user.User, in.Message, final.Text)
	if err := s.saveChat(user.User, c); err != nil {
		ev.send(map[string]any{"t": "error", "v": tr(reqLang(r), "对话无法保存", "Failed to save conversation")})
		return
	}
	ev.send(map[string]any{"t": "done", "model": tried.Model, "in": final.In, "out": final.Out, "title": c.Title})
}

func firstNonEmptyStr(a ...string) string {
	for _, x := range a {
		if x != "" {
			return x
		}
	}
	return ""
}

// libraryRuntimesSummary returns a crisp read-only view of Ansible runtime builds, platform defaults,
// wheel diffs vs the primary default build, and deletion safety rules.
func (s *storeServer) libraryRuntimesSummary(wantID string) string {
	if s.plat == nil || s.plat.py == nil {
		return "软件库运行环境未初始化。"
	}
	_, runtimes, defaults := s.plat.py.State()
	if len(runtimes) == 0 {
		return "软件库中目前还没有 Ansible 运行环境构建。"
	}

	defPlatsByRT := map[string][]string{}
	friendlyDefaults := map[string]string{}
	for pl, id := range defaults {
		label := pl
		if def, ok := mwpack.PlatformByID(pl); ok {
			label = def.Title + " (" + pl + ")"
		}
		defPlatsByRT[id] = append(defPlatsByRT[id], label)
		friendlyDefaults[label] = id
	}
	for id := range defPlatsByRT {
		sort.Strings(defPlatsByRT[id])
	}

	// Sort: default builds first, then newest first.
	sorted := append([]pkglib.PyRuntime(nil), runtimes...)
	sort.SliceStable(sorted, func(i, j int) bool {
		di, dj := len(defPlatsByRT[sorted[i].ID]) > 0, len(defPlatsByRT[sorted[j].ID]) > 0
		if di != dj {
			return di
		}
		return sorted[i].Created > sorted[j].Created
	})

	// Pick baseline default build per Ansible version (fallback to overall primary default build).
	primaryByAnsible := map[string]pkglib.PyRuntime{}
	var overallPrimary *pkglib.PyRuntime
	for i := range sorted {
		rt := sorted[i]
		if len(defPlatsByRT[rt.ID]) > 0 {
			if overallPrimary == nil {
				cp := rt
				overallPrimary = &cp
			}
			if _, ok := primaryByAnsible[rt.Ansible]; !ok {
				primaryByAnsible[rt.Ansible] = rt
			}
		}
	}
	if overallPrimary == nil {
		cp := sorted[0]
		overallPrimary = &cp
	}

	wheelMap := func(rt pkglib.PyRuntime) map[string]string {
		m := make(map[string]string, len(rt.Wheels))
		for _, w := range rt.Wheels {
			m[w.Name] = w.Version
		}
		return m
	}

	type wheelItem struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		Via     string `json:"via,omitempty"`
	}
	type wheelDiff struct {
		Name           string `json:"name"`
		ThisVersion    string `json:"this_version"`
		DefaultVersion string `json:"default_version"`
	}
	type rtSummary struct {
		ID               string      `json:"id"`
		Ansible          string      `json:"ansible"`
		Python           string      `json:"python"`
		Note             string      `json:"note,omitempty"`
		Created          string      `json:"created"`
		CreatedBy        string      `json:"created_by,omitempty"`
		DefaultPlatforms []string    `json:"default_platforms"`
		CanDelete        bool        `json:"can_delete"`
		WheelCount       int         `json:"wheel_count"`
		SizeBytes        int64       `json:"size_bytes"`
		BaselineID       string      `json:"baseline_default_id,omitempty"`
		DiffVsDefault    []wheelDiff `json:"diff_vs_default,omitempty"`
		Wheels           []wheelItem `json:"wheels,omitempty"`
	}

	// If wantID is specified, include that build and its baseline default build; otherwise include all (capped at 12).
	keepIDs := map[string]bool{}
	if wantID != "" {
		for _, rt := range sorted {
			if rt.ID == wantID || strings.HasPrefix(rt.ID, wantID) {
				keepIDs[rt.ID] = true
				if base, ok := primaryByAnsible[rt.Ansible]; ok {
					keepIDs[base.ID] = true
				} else if overallPrimary != nil {
					keepIDs[overallPrimary.ID] = true
				}
			}
		}
		if len(keepIDs) == 0 {
			return "没有找到编号为 " + wantID + " 的运行环境构建。"
		}
	}

	var rows []rtSummary
	defaultCount := 0
	for _, rt := range sorted {
		if len(defPlatsByRT[rt.ID]) > 0 {
			defaultCount++
		}
		if len(keepIDs) > 0 && !keepIDs[rt.ID] {
			continue
		}
		if len(keepIDs) == 0 && len(rows) >= 12 {
			break
		}
		var totalSize int64
		ws := make([]wheelItem, 0, len(rt.Wheels))
		for _, w := range rt.Wheels {
			totalSize += w.Size
			ws = append(ws, wheelItem{Name: w.Name, Version: w.Version, Via: w.Via})
		}
		defPlats := defPlatsByRT[rt.ID]
		if defPlats == nil {
			defPlats = []string{}
		}
		item := rtSummary{
			ID:               rt.ID,
			Ansible:          rt.Ansible,
			Python:           firstNonEmptyStr(rt.Python, pkglib.PyPython),
			Note:             rt.Note,
			Created:          rt.Created,
			CreatedBy:        rt.CreateBy,
			DefaultPlatforms: defPlats,
			CanDelete:        len(defPlats) == 0,
			WheelCount:       len(rt.Wheels),
			SizeBytes:        totalSize,
			Wheels:           ws,
		}
		base, hasBase := primaryByAnsible[rt.Ansible]
		if !hasBase && overallPrimary != nil {
			base = *overallPrimary
			hasBase = true
		}
		if hasBase && base.ID != rt.ID {
			item.BaselineID = base.ID
			bm := wheelMap(base)
			seen := map[string]bool{}
			for _, w := range rt.Wheels {
				seen[w.Name] = true
				if bm[w.Name] != w.Version {
					item.DiffVsDefault = append(item.DiffVsDefault, wheelDiff{
						Name:           w.Name,
						ThisVersion:    w.Version,
						DefaultVersion: firstNonEmptyStr(bm[w.Name], "无"),
					})
				}
			}
			for _, w := range base.Wheels {
				if !seen[w.Name] {
					item.DiffVsDefault = append(item.DiffVsDefault, wheelDiff{
						Name:           w.Name,
						ThisVersion:    "无",
						DefaultVersion: w.Version,
					})
				}
			}
		}
		rows = append(rows, item)
	}

	head := fmt.Sprintf("软件库共 %d 个 Ansible 运行环境构建（%d 个为操作系统默认构建）", len(runtimes), defaultCount)
	if wantID != "" {
		head = fmt.Sprintf("已核对运行环境构建 %s 及其默认构建对照（共 %d 条记录）", wantID, len(rows))
	}
	payload := map[string]any{
		"target_python":   pkglib.PyPython,
		"defaults":        friendlyDefaults,
		"runtimes":        rows,
		"deletion_policy": "已生成的离线交付包自带运行环境快照，不依赖软件库里的历史运行环境条目；只要构建未作为任何操作系统的默认构建（can_delete=true），即可在软件库中安全删除，仅在需要回退切换默认构建时才有保留价值。",
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	return aiScrub(head + "\n" + string(b))
}

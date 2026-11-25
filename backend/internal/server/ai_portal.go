package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var rePortalSessionKey = regexp.MustCompile(`^portal(:[a-zA-Z0-9._:-]{1,80})?$`)

const aiSystemPortal = `你是 Kyndryl Delivery Studio 全站智能运维助手，随时在任意页面协助工程师完成平台配置、执行节点接入、交付规划与故障排障。

核心工作原则：
1. **先读真实状态，再给精确方案**：
   - 遇到执行节点接入、TLS/CA 证书报错、127.0.0.1 连不上、节点离线、systemd 服务等问题时，先调用 platform_connectivity_info 和 list_execution_nodes 核对平台真实地址、证书状态与节点状态。
   - 涉及平台功能与自动化规则时，先调用 read_skill（如 automatic-execution、postgresql-patroni、deployment-form）核对当前已实现能力与边界，绝不编造未开放的功能（如无 SSH 本机执行、现场中继等）。
   - 严禁向用户索取或输出任何密码、私钥或连接令牌明文。
2. **讲人话、给可执行命令、结构清晰**：
   - 直接先给结论，再用 1-3 条精炼步骤说明怎么操作；遇到终端报错先指出根因，再给可直接复制执行的 Linux 命令。
   - 清楚区分「执行节点执行器（仅装在 1 台主控机，通过 systemd 后台运行）」与「目标机接入（在交付的现场执行里二选一：已有 SSH 或 目标 Agent 自动建免密）」，消除概念混淆。
3. **沉淀知识库与组件改进卡片**：
   - 当用户要求把排障结论或操作方案整理/生成/写入知识库，或刚解决了一个值得复用的运维问题时，调用 propose_knowledge 输出「写入知识库总结卡片」（绝不要声称没有写入知识库的工具）；
   - 当明确识别到某个平台组件存在通用缺陷或缺少常用配置参数/检查时，调用 suggest_component_change 输出「组件改进建议」卡片。
4. **默认中文简洁回答**（若用户使用英文提问则以英文回复）。`

func (s *storeServer) portalAIDir(user string) string {
	return filepath.Join(s.cfg.DataDir, "ai-portal", sessionID(user))
}

func portalRunKey(user, key string) string {
	return "__portal__/" + sessionID(user) + "/" + sessionID(key)
}

func (s *storeServer) portalAIRunning(user, key string) (bool, string) {
	v, ok := aiRuns.Load(portalRunKey(user, key))
	if !ok {
		return false, ""
	}
	return true, v.(aiRun).started.UTC().Format(time.RFC3339Nano)
}

func (s *storeServer) portalAILoadSession(user, key string) aiSession {
	ss := aiSession{ID: sessionID(key), Key: key, Kind: "portal", Messages: []aiMsg{}}
	if b, err := os.ReadFile(filepath.Join(s.portalAIDir(user), "sessions", ss.ID+".json")); err == nil {
		_ = json.Unmarshal(b, &ss)
	}
	ss.Kind = "portal"
	if ss.Messages == nil {
		ss.Messages = []aiMsg{}
	}
	return ss
}

func (s *storeServer) portalAISaveSession(user string, ss aiSession) error {
	ss.Updated = time.Now().UTC().Format(time.RFC3339)
	return writeJSONFile(filepath.Join(s.portalAIDir(user), "sessions", ss.ID+".json"), ss)
}

func aiPortalTools() []aiToolDef {
	return []aiToolDef{
		{
			Name:        "list_execution_nodes",
			Description: "查看当前平台已登记的执行节点（主控机）列表、在线状态、IP、安装位置、版本和已授权集群数量（不含敏感令牌）。",
			Parameters:  map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			Name:        "platform_connectivity_info",
			Description: "查看当前平台版本、TLS/自签名证书状态、CA 证书是否可下载、Linux x64 执行器二进制是否就绪以及平台可供远端机器访问的推荐地址列表。",
			Parameters:  map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			Name:        "list_clusters_overview",
			Description: "查看当前用户可见的集群与最近交付概览（集群标识、组件、版本、状态）。",
			Parameters:  map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			Name:        "list_components",
			Description: "列出平台当前内置与自定义中间件组件的名称与版本。",
			Parameters:  map[string]any{"type": "object", "properties": map[string]any{}},
		},
		aiProposeKnowledgeTool(),
		aiSuggestTool(),
	}
}

func (s *storeServer) runPortalListExecutionNodes(user string) string {
	if !s.can(user, "execution.manage") && !s.can(user, "delivery.view") {
		return "当前账号没有查看执行节点的权限。"
	}
	executionMu.Lock()
	d, err := s.readExecutions()
	executionMu.Unlock()
	if err != nil {
		return "读取执行节点信息失败：" + err.Error()
	}
	type nodeSummary struct {
		Name         string   `json:"name"`
		Kind         string   `json:"kind"`
		ControllerIP string   `json:"controller_ip"`
		Online       bool     `json:"online"`
		Disabled     bool     `json:"disabled"`
		LastSeen     string   `json:"last_seen,omitempty"`
		Version      string   `json:"version,omitempty"`
		Clusters     []string `json:"clusters"`
	}
	var out []nodeSummary
	for _, n := range d.Nodes {
		pub := publicExecutionNode(n)
		out = append(out, nodeSummary{
			Name:         pub.Name,
			Kind:         pub.Kind,
			ControllerIP: pub.ControllerIP,
			Online:       executionOnline(n),
			Disabled:     pub.Disabled,
			LastSeen:     pub.LastSeen,
			Version:      pub.Version,
			Clusters:     pub.Clusters,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	b, _ := json.MarshalIndent(out, "", "  ")
	return string(b)
}

func (s *storeServer) runPortalClustersOverview(user string) string {
	s.mu.Lock()
	var rows []map[string]any
	for _, j := range s.jobs {
		if j.Owner != user && !s.can(user, "delivery.view_all") {
			continue
		}
		rows = append(rows, map[string]any{
			"cluster":   j.ClusterID,
			"job_id":    j.ID,
			"app":       j.AppName,
			"state":     j.State,
			"mode":      j.DeliveryMode,
			"created":   j.Created,
		})
	}
	s.mu.Unlock()
	sort.Slice(rows, func(i, j int) bool {
		a, _ := rows[i]["created"].(string)
		b, _ := rows[j]["created"].(string)
		return a > b
	})
	if len(rows) > 25 {
		rows = rows[:25]
	}
	b, _ := json.MarshalIndent(rows, "", "  ")
	return string(b)
}

func portalPageContext(step map[string]any) string {
	if len(step) == 0 {
		return ""
	}
	var lines []string
	add := func(label, key string) {
		if v, ok := step[key].(string); ok && strings.TrimSpace(v) != "" {
			lines = append(lines, fmt.Sprintf("- %s：%s", label, truncRunes(strings.TrimSpace(v), 1200)))
		}
	}
	add("所在页面", "page")
	add("问题主题", "topic")
	add("标题", "title")
	add("页面背景", "summary")
	add("报错或详情", "error")
	add("相关命令", "command")
	if len(lines) == 0 {
		return stepContext(step)
	}
	return "当前页面上下文：\n" + strings.Join(lines, "\n")
}

func (s *storeServer) handlePortalAI(w http.ResponseWriter, r *http.Request, session storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/ai/portal"), "/")
	parts := []string{}
	if rest != "" {
		parts = strings.Split(rest, "/")
	}
	switch {
	case len(parts) == 1 && parts[0] == "sessions" && r.Method == "GET":
		out := []aiSession{}
		files, _ := filepath.Glob(filepath.Join(s.portalAIDir(session.User), "sessions", "*.json"))
		for _, f := range files {
			var ss aiSession
			if b, err := os.ReadFile(f); err == nil && json.Unmarshal(b, &ss) == nil {
				ss.Messages = nil
				ss.Running, ss.RunningSince = s.portalAIRunning(session.User, ss.Key)
				out = append(out, ss)
			}
		}
		sort.Slice(out, func(i, k int) bool { return out[i].Updated > out[k].Updated })
		s.writeJSON(w, 200, map[string]any{"sessions": out, "status": s.aiStatusFor(session.User)})

	case len(parts) == 1 && parts[0] == "session" && (r.Method == "GET" || r.Method == "DELETE"):
		key := r.URL.Query().Get("key")
		if !rePortalSessionKey.MatchString(key) {
			s.fail(w, 400, "这段对话不存在，或已过期")
			return
		}
		if r.Method == "DELETE" {
			_ = os.Remove(filepath.Join(s.portalAIDir(session.User), "sessions", sessionID(key)+".json"))
			s.writeJSON(w, 200, map[string]bool{"ok": true})
			return
		}
		ss := s.portalAILoadSession(session.User, key)
		ss.Running, ss.RunningSince = s.portalAIRunning(session.User, key)
		s.writeJSON(w, 200, ss)

	case len(parts) == 1 && parts[0] == "stop" && r.Method == "POST":
		var in struct {
			Key string `json:"key"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&in) != nil || !rePortalSessionKey.MatchString(in.Key) {
			s.fail(w, 400, "这段对话不存在，或已过期")
			return
		}
		if c, ok := aiRuns.Load(portalRunKey(session.User, in.Key)); ok {
			c.(aiRun).cancel()
		}
		s.writeJSON(w, 200, map[string]bool{"ok": true})

	case len(parts) == 2 && parts[0] == "img" && r.Method == "GET":
		name := filepath.Base(parts[1])
		b, err := os.ReadFile(filepath.Join(s.portalAIDir(session.User), "img", name))
		if err != nil {
			s.fail(w, 404, "图片不存在")
			return
		}
		w.Header().Set("Content-Type", http.DetectContentType(b))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(b)

	case len(parts) == 1 && parts[0] == "proposals" && r.Method == "GET":
		s.writeJSON(w, 200, map[string]any{"proposals": []aiProposal{}})

	case len(parts) == 1 && parts[0] == "chat" && r.Method == "POST":
		s.handlePortalAIChat(w, r, session)

	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) handlePortalAIChat(w http.ResponseWriter, r *http.Request, user storeSession) {
	if code, msg := s.checkAIFeature(user.User, "assistant"); code != 0 {
		s.fail(w, code, msg)
		return
	}
	var in struct {
		Key     string         `json:"key"`
		Message string         `json:"message"`
		Images  []string       `json:"images"`
		Step    map[string]any `json:"step"`
		Model   string         `json:"model"`
		Options aiOpts         `json:"options"`
		Retry   bool           `json:"retry"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 20<<20)).Decode(&in); err != nil {
		s.fail(w, 400, "提交的内容有问题，或者图片太大了")
		return
	}
	in.Message = strings.TrimSpace(in.Message)
	if !rePortalSessionKey.MatchString(in.Key) || (in.Message == "" && len(in.Images) == 0) || len([]rune(in.Message)) > 20000 || len(in.Images) > 3 {
		s.fail(w, 400, "请输入内容（最多 3 张图片）")
		return
	}
	st := s.aiLoad()
	providers := st.aiProvidersForPick("assistant", in.Model)
	if len(providers) == 0 {
		s.fail(w, 409, "「AI 助手」未配置可用模型，请管理员在平台设置 → AI 中配置模型")
		return
	}
	if st.MonthlyLimit > 0 && s.aiCallsThisMonth(user.User) >= st.MonthlyLimit {
		s.fail(w, 429, "本月 AI 使用次数已达上限")
		return
	}
	if len(in.Images) > 0 && providers[0].Vision == "no" {
		s.fail(w, 409, "当前模型不支持看图，请改贴文字描述，或切换支持看图的模型")
		return
	}
	var imgNames []string
	for _, d := range in.Images {
		name, err := s.aiStoreImageIn(s.portalAIDir(user.User), d)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		imgNames = append(imgNames, name)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 15*time.Minute)
	defer cancel()
	runKey := portalRunKey(user.User, in.Key)
	if _, busy := aiRuns.LoadOrStore(runKey, aiRun{cancel, time.Now()}); busy {
		s.fail(w, 409, "这段对话还在回答上一个问题，请等它结束，或先停止")
		return
	}
	defer aiRuns.Delete(runKey)

	ss := s.portalAILoadSession(user.User, in.Key)
	if len(in.Step) > 0 {
		ss.Step = in.Step
	}
	if ss.Title == "" {
		if t, _ := in.Step["title"].(string); strings.TrimSpace(t) != "" {
			ss.Title = truncRunes(strings.TrimSpace(t), 60)
		} else if in.Message != "" {
			ss.Title = truncRunes(strings.Join(strings.Fields(in.Message), " "), 36)
		} else {
			ss.Title = "平台助手对话"
		}
	}
	nowStr := time.Now().UTC().Format(time.RFC3339)
	ss.Messages = appendOrReuseUserTurn(ss.Messages, in.Retry, aiMsg{Role: "user", Text: in.Message, Images: imgNames, At: nowStr, By: user.User})
	if err := s.portalAISaveSession(user.User, ss); err != nil {
		s.fail(w, 500, "对话无法保存")
		return
	}
	s.auditReq(r, "portal-ai-chat", user.User, ss.Key)

	bootInfo := s.executionBootstrapInfo(r)
	bootBytes, _ := json.MarshalIndent(bootInfo, "", "  ")
	bootJSON := string(bootBytes)

	fl, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ev := sse{w, fl}

	var red *aiRedactor
	if st.RedactHosts {
		red = newAIRedactor(nil)
	}
	var final aiReply
	var used, proposed []string
	var knowledges []aiKnowledgeSpec
	var components []aiComponentSpec
	var lastErr error
	var tried aiProvider
	var failedAttempts []aiAttemptDiag

	for i, p := range providers {
		tried = p
		start := time.Now()
		var made []string
		var turnKnowledges []aiKnowledgeSpec
		var turnComponents []aiComponentSpec
		in.Options.User = user.User
		in.Options.Made = &producedFiles{}

		ext := s.extFor("assistant", in.Options)
		turnCtx := ext.bindCtx(effortCtx(ctx, in.Options), ev)
		tools := append(aiPortalTools(), ext.tools...)
		sys := aiSystemPortal + ext.prompt
		if c := portalPageContext(ss.Step); c != "" {
			sys += "\n\n" + c
		}
		prep := func(t string) string { return red.out(aiScrub(t)) }
		if p.Tools == "no" {
			tools = nil
			sys += "\n\n当前平台连接信息：\n" + bootJSON
		}
		msgs := []aiMessage{{Role: "system", Content: prep(sys)}}
		for idxM, m := range ss.Messages {
			if isErrorOnlyMsg(m) {
				continue
			}
			if m.Role == "assistant" {
				msgs = append(msgs, aiMessage{Role: "assistant", Content: prep(m.Text + m.askText() + m.rehearsalText())})
				continue
			}
			text := prep(m.Text)
			if len(m.Images) > 0 && p.Vision != "no" && idxM >= len(ss.Messages)-3 {
				parts := []map[string]any{{"type": "text", "text": text}}
				for _, n := range m.Images {
					if b, err := os.ReadFile(filepath.Join(s.portalAIDir(user.User), "img", filepath.Base(n))); err == nil {
						parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:" + http.DetectContentType(b) + ";base64," + base64.StdEncoding.EncodeToString(b)}})
					}
				}
				msgs = append(msgs, aiMessage{Role: "user", Content: parts})
			} else {
				msgs = append(msgs, aiMessage{Role: "user", Content: text})
			}
		}

		runTool := func(name, args string) string {
			var a map[string]any
			_ = json.Unmarshal([]byte(args), &a)
			switch name {
			case "list_execution_nodes":
				return s.runPortalListExecutionNodes(user.User)
			case "platform_connectivity_info":
				return bootJSON
			case "list_clusters_overview":
				return s.runPortalClustersOverview(user.User)
			case "list_components":
				return compToolCtx{s: s}.run("list_components", args)
			case "propose_knowledge":
				src, _ := ss.Step["page"].(string)
				spec, errMsg := buildKnowledgeSpec(firstNonEmptyStr(src, "平台助手"), a)
				if errMsg != "" {
					return "知识库卡片未通过校验：" + errMsg
				}
				for _, ex := range turnKnowledges {
					if ex.Title == spec.Title {
						return "知识库总结卡片已在当前回复中生成（标题：「" + spec.Title + "」）。"
					}
				}
				turnKnowledges = append(turnKnowledges, *spec)
				ev.send(map[string]any{"t": "knowledge", "v": *spec})
				return "已生成写入知识库总结卡片（标题：「" + spec.Title + "」）。用户可在下方卡片直接预览/微调并一键存入「我的知识库」或发布到「团队知识库」。"
			case "suggest_component_change":
				spec, errMsg := s.buildComponentSpec(a)
				if errMsg != "" {
					return "组件改进建议未通过校验：" + errMsg
				}
				for _, ex := range turnComponents {
					if ex.Component == spec.Component && ex.Title == spec.Title {
						return "该组件改进建议卡片已在当前回复中生成（组件：" + spec.Component + "，标题：「" + spec.Title + "」）。"
					}
				}
				turnComponents = append(turnComponents, *spec)
				ev.send(map[string]any{"t": "component_suggest", "v": *spec})
				return "已生成组件改进建议卡片（组件：" + spec.Component + "，标题：「" + spec.Title + "」）。用户点击卡片即可新标签页打开组件工作台由 AI 起草改动。"
			default:
				return "未知工具：" + name
			}
		}

		reply, tUsed, err := s.aiToolLoop(turnCtx, p, msgs, tools, red, ev, ext.wrap(runTool), &made)
		u := usageFrom(p, reply)
		u.User, u.IP, u.Feature, u.Target, u.Session, u.Tools = user.User, clientIP(r), "assistant", ss.Key, ss.ID, len(tUsed)
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
			final, used, proposed, knowledges, components, lastErr = reply, tUsed, made, turnKnowledges, turnComponents, nil
			break
		}
		lastErr = err
		if ctx.Err() != nil {
			return
		}
		if i+1 < len(providers) {
			ev.send(map[string]any{"t": "notice", "v": "「" + p.Name + " · " + p.Model + "」失败，改用备用模型"})
		}
	}
	if lastErr != nil {
		errText := localizeGoMessage(reqLang(r), lastErr.Error())
		errDiag := buildChatErrorDiag(lastErr, failedAttempts, tried)
		ss.Messages = append(ss.Messages, aiMsg{Role: "assistant", Error: errText, ErrorDiag: errDiag, At: time.Now().UTC().Format(time.RFC3339)})
		saved := s.portalAISaveSession(user.User, ss) == nil
		errPayload := map[string]any{"t": "error", "v": errText, "saved": saved}
		if errDiag != nil {
			errPayload["diag"] = errDiag
		}
		ev.send(errPayload)
		return
	}
	ss.Messages = append(ss.Messages, aiMsg{Role: "assistant", Text: final.Text, Tools: used, Steps: final.Steps, MS: final.TotalMS, Proposals: proposed, Knowledges: knowledges, Components: components, Ask: final.Ask, Files: final.Files, At: time.Now().UTC().Format(time.RFC3339)})
	if err := s.portalAISaveSession(user.User, ss); err != nil {
		ev.send(map[string]any{"t": "error", "v": "对话无法保存"})
		return
	}
	ev.send(map[string]any{"t": "done", "model": tried.Model, "in": final.In, "out": final.Out})
}

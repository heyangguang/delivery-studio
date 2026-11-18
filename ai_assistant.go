package main

import (
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
		{"list_deliveries", "列出你的交付：集群、应用、版本、状态、创建时间、执行进度。", obj(map[string]any{})},
	}
	for _, t := range aiTools() {
		if strings.HasPrefix(t.Name, "propose") {
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
	s    *storeServer
	user string
	ctx  chatCtx
}

func (c assistCtx) run(name, args string) string {
	var a map[string]any
	_ = json.Unmarshal([]byte(args), &a)
	switch name {
	case "component_guide", "list_components", "example_component":
		return compToolCtx{s: c.s}.run(name, args)
	case "list_deliveries":
		vis := c.s.visibleJobs(c.user)
		c.s.mu.Lock()
		var rows []storeJob
		for _, j := range c.s.jobs {
			if vis(j.Owner) {
				rows = append(rows, j)
			}
		}
		c.s.mu.Unlock()
		sort.Slice(rows, func(i, k int) bool { return rows[i].Created > rows[k].Created })
		var b strings.Builder
		for i, j := range rows {
			if i >= 40 {
				b.WriteString("…（只列最近 40 份）\n")
				break
			}
			fmt.Fprintf(&b, "- %s · %s %s · 状态 %s · 创建 %s · 编号 %s · 执行记录 完成%d 失败%d / %d\n", j.ClusterID, j.AppName, j.Version, j.State, j.Created, j.ID, j.RunDone, j.RunFailed, j.RunTotal)
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
	return aiToolCtx{s: c.s, job: j, session: "assistant", proposed: &none}.run(name, string(b))
}

const assistSystem = `你是 Middleware Hub（离线中间件交付平台）里的 AI 助手，回答用户关于交付、组件、部署、排障和变更演练的问题。
- 先用工具查看实际内容再回答：用户的交付、执行手册、项目文件、组件和设计指南都能读到。不要凭记忆编造平台里的数据。
- 你只能读取，不能修改。需要改交付的手册或命令时，告诉用户：在 AI 页左侧「交付里的对话」里打开那份交付的对话（或在交付页点「AI 辅助」），把想改的内容告诉 AI，它会生成提案，由用户确认后才生效。如果要对已运行集群做升级、扩缩容或调参，引导用户进入该集群的「变更演练」工作台。
- 密码、密钥、证书不会提供给你，也不要索取。
- 回答用中文，先给结论再给依据；命令用代码块；有风险的操作要明确提醒。思考过程的摘要也尽量用中文写。不要用 LaTeX 公式，数学用普通文字和符号表示。
- 用户没有关联交付时，先 list_deliveries 弄清是哪一份再往下查。`

func (s *storeServer) handleAIChats(w http.ResponseWriter, r *http.Request, user storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/ai/chats"), "/")
	parts := strings.Split(rest, "/")
	switch {
	case rest == "" && r.Method == "GET":
		s.writeJSON(w, 200, map[string]any{"chats": s.listChats(user.User), "linked": s.linkedSessions(user.User)})
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
		Form *formState `json:"form"`
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
	st := s.aiLoad()
	if !st.Enabled || !st.Features[feature].Enabled {
		if feature == "form" {
			s.fail(w, 409, "智能填表未开启，请管理员在平台设置 → AI 中开启")
		} else {
			s.fail(w, 409, "AI 助手未开启，请管理员在平台设置 → AI 中开启")
		}
		return
	}
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
	c.Messages = append(c.Messages, aiMsg{Role: "user", Text: strings.TrimSpace(in.Message), Files: refs, At: now, By: user.User})
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
		system += "\n本次对话关联的交付：" + c.Ctx.Name + "（编号 " + c.Ctx.ID + "）。用户说“这份交付”就是它。" + s.controllerFacts(c.Ctx.ID)
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
		if i == len(hist)-1 && len(attached) > 0 {
			continue // the new message is built below, with what was attached
		}
		text := aiScrub(m.Text + m.askText())
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
	tc := assistCtx{s: s, user: user.User, ctx: c.Ctx}
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
	for i, p := range providers {
		tried = p
		start := time.Now()
		turnCtx := ext.bindCtx(effortCtx(r.Context(), in.Options), ev)
		reply, tl, err := s.aiToolLoop(turnCtx, p, msgs, tools, nil, ev, run, &none)
		u := usageFrom(p, reply)
		u.User, u.IP, u.Feature, u.Job, u.Target, u.Session, u.Tools = user.User, clientIP(r), feature, c.Ctx.ID, firstNonEmptyStr(c.Ctx.Name, tr(reqLang(r), "AI 助手", "AI Assistant")), id, len(tl)
		u.MS, u.OK, u.Failover = time.Since(start).Milliseconds(), err == nil, i > 0
		if err != nil {
			u.Error = truncRunes(err.Error(), 200)
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
		ev.send(map[string]any{"t": "error", "v": localizeGoMessage(reqLang(r), lastErr.Error())})
		return
	}
	answer := aiMsg{Role: "assistant", Text: final.Text, Tools: used, Steps: final.Steps, MS: final.TotalMS, Ask: final.Ask, Files: final.Files, At: time.Now().UTC().Format(time.RFC3339)}
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

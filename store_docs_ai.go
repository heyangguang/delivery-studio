package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// The assistant writes drafts of a document's sections and checks a document against its facts. It only ever sees
// what the platform assembled (no passwords: aiScrub), may not invent facts, and marks what it cannot know. A draft
// is stored as unconfirmed until a person confirms or edits it.

const docSystem = `你是一名资深中间件架构师，正在为客户撰写正式的交付文档。
规则：
- 只依据给出的事实写，不编造版本、数字、时间、人名或没有发生的事；事实里没有、但这一节需要的信息，写成【待补充：需要什么】。
- 用简体中文，书面、准确、简洁，面向客户的技术负责人和运维人员。
- 直接输出这一节的正文：不要标题、不要复述题目、不要寒暄；可以分段，列举时每行以 "- " 开头；不要用表格和代码块，不要用 Markdown 标题。
- 失败、偏差、未执行的步骤、未修复的漏洞必须如实写出，不能美化成全部成功。`

// docFacts renders the facts of a document (everything but its sections) and the sections already written, as text
// for the model.
func docFacts(d *clusterDoc, skip string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "文档：%s（%s）\n", d.Title, d.Subtitle)
	for _, c := range d.Cover {
		fmt.Fprintf(&b, "%s：%s\n", c[0], c[1])
	}
	for _, x := range d.Blocks {
		switch x.Kind {
		case "h":
			fmt.Fprintf(&b, "\n%s %s\n", strings.Repeat("#", x.Level), x.Text)
		case "p", "note":
			b.WriteString(x.Text + "\n")
		case "code":
			b.WriteString("命令：" + strings.ReplaceAll(x.Text, "\n", "；") + "\n")
		case "list":
			for _, it := range x.Items {
				b.WriteString("- " + it + "\n")
			}
		case "table":
			b.WriteString(strings.Join(x.Head, " | ") + "\n")
			for _, r := range x.Rows {
				b.WriteString(strings.Join(r, " | ") + "\n")
			}
		case "section":
			fmt.Fprintf(&b, "\n%s %s\n", strings.Repeat("#", x.Level), x.Title)
			switch {
			case x.Key == skip:
				b.WriteString("（正在起草这一节）\n")
			case strings.TrimSpace(x.Text) != "":
				b.WriteString(x.Text + "\n")
			default:
				b.WriteString("（未填写）\n")
			}
		}
	}
	out := b.String()
	if r := []rune(out); len(r) > 30000 {
		out = string(r[:30000]) + "\n……（事实太长，后面省略）"
	}
	return aiScrub(out)
}

// docAI calls the documents feature's models in order until one answers.
func (s *storeServer) docAI(r *http.Request, user, target, session string, msgs []aiMessage) (string, string, int, error) {
	st := s.aiLoad()
	if !st.Enabled || !st.Features["docs"].Enabled {
		return "", "", 409, fmt.Errorf("文档起草未开启，请管理员在平台设置 → AI 中开启")
	}
	providers := st.aiProvidersForPick("docs", "")
	if len(providers) == 0 {
		return "", "", 409, fmt.Errorf("没有可用的模型供应商")
	}
	if st.MonthlyLimit > 0 && s.aiCallsThisMonth(user) >= st.MonthlyLimit {
		return "", "", 429, fmt.Errorf("本月 AI 使用次数已达上限")
	}
	var err error
	for i, p := range providers {
		start := time.Now()
		ctx, cancel := context.WithTimeout(r.Context(), 180*time.Second)
		var reply aiReply
		reply, err = s.aiChat(ctx, p, msgs, nil, nil)
		cancel()
		u := usageFrom(p, reply)
		u.User, u.IP, u.Feature, u.Target, u.Session = user, clientIP(r), "docs", target, session
		u.MS, u.OK, u.Failover = time.Since(start).Milliseconds(), err == nil, i > 0
		if err != nil {
			u.Error = truncRunes(err.Error(), 200)
		}
		s.aiRecordUsage(u)
		if err == nil {
			return strings.TrimSpace(reply.Text), p.Model, 200, nil
		}
	}
	return "", "", 502, err
}

func (s *storeServer) draftSection(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, d *clusterDoc, key string) {
	sec := docSectionOf(d, key)
	if sec == nil || !sec.AI {
		s.fail(w, 404, "这一节不能由 AI 起草")
		return
	}
	var in struct {
		Ask     string   `json:"ask"`     // what the person wants in it, optional
		Answers []planQA `json:"answers"` // answers to the assistant's questions
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in)
	saved := s.docLoad(f.ID, d.ID)
	for _, a := range in.Answers {
		if strings.TrimSpace(a.Answer) != "" && len(saved.Answers) < 60 {
			saved.Answers = append(saved.Answers, planQA{truncRunes(a.Question, 300), truncRunes(a.Answer, 1000)})
		}
	}
	if len(in.Answers) > 0 {
		_ = s.docSave(f.ID, d.ID, saved)
	}
	prompt := "下面是平台整理的事实和文档里已经写好的部分：\n\n" + docFacts(d, key)
	if len(saved.Answers) > 0 {
		prompt += "\n\n现场人员补充的信息（问答）：\n"
		for _, a := range saved.Answers {
			prompt += "- 问：" + a.Question + "\n  答：" + aiScrub(a.Answer) + "\n"
		}
	}
	prompt += "\n\n请起草「" + sec.Title + "」这一节。这一节要写的是：" + sec.Hint
	if d.Kind == "assess" {
		prompt += "\n\n这是一份" + d.Title + "。给出依据和计算过程，结论要落到具体的做法（建议通过变更演练实施的调整方向、关键参数）。如果缺少只有现场才知道、又直接影响结论的信息（例如业务每秒请求数、数据量与增长速度、机器的 CPU 内存磁盘、可接受的停机时间），不要编造：只输出 JSON {\"questions\":[{\"question\":\"问题\",\"options\":[\"选项\"]}]}，最多 3 个问题，每个 2-4 个选项。上面已经回答过的不要再问；不重要的信息写成假设，不要为它提问。"
	}
	if d.Kind == "rca" {
		prompt += "\n\n这是一份根因分析。如果写好这一节缺少只有现场人员才知道的关键信息（例如失败前有没有人手动改过机器、业务从什么时候开始受影响、做过哪些处理），不要编造，也不要先写一版：只输出 JSON {\"questions\":[{\"question\":\"问题\",\"options\":[\"选项\"]}]}，最多 3 个问题，每个 2-4 个选项。上面已经回答过的不要再问。信息够用时直接写正文。"
	}
	if strings.TrimSpace(sec.Text) != "" {
		prompt += "\n\n这一节现在的内容（在它的基础上改进，保留其中人写的、事实里没有的信息）：\n" + aiScrub(sec.Text)
	}
	if a := strings.TrimSpace(in.Ask); a != "" {
		prompt += "\n\n使用者的要求：" + aiScrub(truncRunes(a, 1000))
	}
	text, model, code, err := s.docAI(r, session.User, f.ID, d.ID+"/"+key, []aiMessage{{Role: "system", Content: docSystem}, {Role: "user", Content: prompt}})
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}
	if (d.Kind == "rca" || d.Kind == "assess") && strings.Contains(text, `"questions"`) {
		var q struct {
			Questions []struct {
				Question string   `json:"question"`
				Options  []string `json:"options"`
			} `json:"questions"`
		}
		if raw := extractJSON(text); raw != "" && json.Unmarshal([]byte(raw), &q) == nil && len(q.Questions) > 0 {
			if len(q.Questions) > 3 {
				q.Questions = q.Questions[:3]
			}
			s.writeJSON(w, 200, map[string]any{"questions": q.Questions})
			return
		}
	}
	text = strings.TrimSpace(strings.TrimPrefix(text, sec.Title))
	if text == "" {
		s.fail(w, 502, "模型没有给出内容，请稍后再试")
		return
	}
	saved = s.docLoad(f.ID, d.ID)
	saved.Sections[key] = docSection{Text: text, Source: "ai", By: session.User + "（AI：" + model + "）", At: time.Now().UTC().Format(time.RFC3339Nano), Basis: f.Current.ID}
	if err := s.docSave(f.ID, d.ID, saved); err != nil {
		s.fail(w, 500, "保存失败，请稍后重试")
		return
	}
	s.auditReq(r, "doc-draft", session.User, f.ID+" "+d.ID+" "+key)
	nd, _ := s.buildDoc(f, d.ID)
	s.writeJSON(w, 200, nd)
}

const docCheckSystem = `你是交付文档的审核人。对照文档里平台整理的事实（表格、执行记录、变更记录），检查人写的各节（标有标题、正文不是表格的部分）有没有问题：
- 与事实矛盾（机器数、版本、结果、时间、谁做的）；
- 回避或美化了失败、偏差、未执行的步骤、未修复的漏洞；
- 该写而没写的重要内容；
- 还留着【待补充】的地方。
只输出 JSON：{"findings":[{"section":"节的标题","level":"error|warn","problem":"问题","suggest":"建议怎么改"}]}。没有问题时 findings 为空数组。不要输出别的。`

func (s *storeServer) checkDoc(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, d *clusterDoc) {
	text, _, code, err := s.docAI(r, session.User, f.ID, d.ID+"/check", []aiMessage{{Role: "system", Content: docCheckSystem}, {Role: "user", Content: docFacts(d, "")}})
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}
	var out struct {
		Findings []struct {
			Section string `json:"section"`
			Level   string `json:"level"`
			Problem string `json:"problem"`
			Suggest string `json:"suggest"`
		} `json:"findings"`
	}
	if raw := extractJSON(text); raw == "" || json.Unmarshal([]byte(raw), &out) != nil {
		s.fail(w, 502, "模型没有给出可用的检查结果，请稍后再试")
		return
	}
	if out.Findings == nil {
		out.Findings = out.Findings[:0]
	}
	s.auditReq(r, "doc-check", session.User, f.ID+" "+d.ID)
	s.writeJSON(w, 200, out)
}

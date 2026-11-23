package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// The assistant writes drafts of a document's sections and audits a document against platform delivery
// facts and cluster security posture. It only ever sees what the platform assembled (no passwords: aiScrub),
// may not invent facts, and marks what it cannot know. A draft is stored as unconfirmed until a person
// confirms or edits it.

const docSystem = `你是一名资深中间件架构师，正在为客户撰写正式的交付文档。
规则：
- 只依据给出的事实写，不编造版本、数字、时间、人名或没有发生的事；事实里没有、但这一节需要的信息，写成【待补充：需要什么】。
- 用简体中文，书面、准确、简洁，面向客户的技术负责人和运维人员。
- 直接输出这一节的正文：不要标题、不要复述题目、不要寒暄；可以分段，列举时每行以 "- " 开头；不要用表格和代码块，不要用 Markdown 标题。
- 失败、偏差、未执行的步骤、未修复的漏洞或安全基线未通过项必须如实写出，不能美化成全部成功。`

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
			fmt.Fprintf(&b, "\n%s %s（key=%s）\n", strings.Repeat("#", x.Level), x.Title, x.Key)
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
	if r := []rune(out); len(r) > 28000 {
		out = string(r[:28000]) + "\n……（事实太长，后面省略）"
	}
	return aiScrub(out)
}

// clusterSecurityFactsSummary produces a concise, deterministic security context snippet for delivery docs.
func (s *storeServer) clusterSecurityFactsSummary(user string, f clusterFacts) string {
	rep := s.auditClusterSecurity(user, f)
	var b strings.Builder
	fmt.Fprintf(&b, "\n## 平台安全态势实时审计（集群 %s）\n", f.ID)
	fmt.Fprintf(&b, "- 综合安全评分：%d 分（%s 级）\n", rep.Score, rep.Grade)
	if rep.HasScan {
		fmt.Fprintf(&b, "- 活跃未豁免 CVE：共 %d 条（中间件本体 %d 条：严重 %d / 高危 %d / 中危 %d；OS 底层包 %d 条：严重 %d / 高危 %d）",
			rep.ActiveCounts.Total,
			rep.MiddlewareCounts.Total, rep.MiddlewareCounts.Critical, rep.MiddlewareCounts.High, rep.MiddlewareCounts.Medium,
			rep.OSCounts.Total, rep.OSCounts.Critical, rep.OSCounts.High)
		if rep.HideOSCVEs {
			b.WriteString("；注：平台全局视角已屏蔽 OS 底层包")
		}
		b.WriteString("\n")
		shown := 0
		for _, pg := range rep.PackageGroups {
			if pg.ActiveCount <= 0 || pg.GloballyIgnored {
				continue
			}
			fix := firstNonEmptyStr(pg.RepoFixVersion, pg.RecommendedFix)
			if fix != "" {
				fmt.Fprintf(&b, "  - 漏洞包 %s（%s，%s）：%d 条活跃 CVE（最高 %s），建议升级 %s -> %s\n", pg.Package, pg.PkgRole, pg.InstalledVersion, pg.ActiveCount, pg.MaxSeverity, pg.InstalledVersion, fix)
			} else {
				fmt.Fprintf(&b, "  - 漏洞包 %s（%s，%s）：%d 条活跃 CVE（最高 %s，暂无上游修复版）\n", pg.Package, pg.PkgRole, pg.InstalledVersion, pg.ActiveCount, pg.MaxSeverity)
			}
			shown++
			if shown >= 5 {
				break
			}
		}
	} else {
		b.WriteString("- CVE 漏洞扫描：尚未执行离线扫描\n")
	}
	if rep.BaselineTotal > 0 {
		fmt.Fprintf(&b, "- 配置安全基线：通过 %d/%d 项\n", rep.BaselinePassed, rep.BaselineTotal)
		for _, ck := range rep.BaselineChecks {
			if ck.Status == "fail" || ck.Status == "warn" {
				fmt.Fprintf(&b, "  - [%s/%s] %s：%s\n", ck.Status, ck.Severity, ck.Title, ck.Detail)
			}
		}
	}
	if len(rep.Certs) > 0 {
		fmt.Fprintf(&b, "- TLS 证书巡检：已解析 %d 份内嵌证书", len(rep.Certs))
		if rep.CertExpiring > 0 {
			fmt.Fprintf(&b, "（其中 %d 份已过期或即将到期）", rep.CertExpiring)
		} else {
			b.WriteString("（均在有效期内）")
		}
		b.WriteString("\n")
	}
	return aiScrub(b.String())
}

// docAI calls the documents feature's models in order until one answers.
func (s *storeServer) docAI(r *http.Request, user, target, session string, msgs []aiMessage) (string, string, int, error) {
	if code, msg := s.checkAIFeature(user, "docs"); code != 0 {
		return "", "", code, fmt.Errorf("%s", msg)
	}
	st := s.aiLoad()
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
	prompt := "下面是平台整理的事实和文档里已经写好的部分：\n\n" + docFacts(d, key) + s.clusterSecurityFactsSummary(session.User, f)
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

const docDraftAllSystem = `你是一名资深中间件架构师，正在一次性为客户补全正式交付文档中尚未填写的章节。
规则：
- 只依据给出的交付事实、执行记录和平台安全态势审计撰写，严禁编造版本、数字、时间、人名或未发生的事件；事实里没有、但必须由客户/现场补充的信息写成【待补充：需要什么】。
- 用简体中文，专业、准确、简洁，面向客户技术负责人和运维人员；列举项每行以 "- " 开头，不要使用 Markdown 标题、代码块或表格。
- 失败、偏差、未执行步骤、未修复的高危/严重安全漏洞及配置基线未通过项必须如实客观记录，禁止美化成全部成功。
- 只输出严格 JSON：{"sections":{"章节key":"该节正文内容"}}，不要输出 Markdown 围栏或多余说明。`

// draftAllSections drafts all currently empty (and optionally stale) AI-draftable sections in one fast LLM round-trip.
func (s *storeServer) draftAllSections(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, d *clusterDoc) {
	var in struct {
		IncludeStale bool   `json:"include_stale"`
		Ask          string `json:"ask"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in)
	}
	var targets []docBlock
	for _, b := range d.Blocks {
		if b.Kind != "section" || !b.AI || b.Key == "" {
			continue
		}
		empty := strings.TrimSpace(b.Text) == ""
		if empty || (in.IncludeStale && b.Stale != "") {
			targets = append(targets, b)
		}
	}
	if len(targets) == 0 {
		s.writeJSON(w, 200, map[string]any{"drafted": 0, "doc": d})
		return
	}

	var p strings.Builder
	p.WriteString("下面是平台整理的文档事实与实时安全态势：\n\n")
	p.WriteString(docFacts(d, ""))
	p.WriteString(s.clusterSecurityFactsSummary(session.User, f))
	p.WriteString("\n\n请一次性起草以下章节的正文内容（按 key 输出 JSON {\"sections\":{...}}）：\n")
	for _, t := range targets {
		fmt.Fprintf(&p, "- key=%q | 标题：%s | 撰写要点：%s\n", t.Key, t.Title, t.Hint)
	}
	if a := strings.TrimSpace(in.Ask); a != "" {
		p.WriteString("\n使用者补充要求：" + aiScrub(truncRunes(a, 800)) + "\n")
	}

	text, model, code, err := s.docAI(r, session.User, f.ID, d.ID+"/draft-all", []aiMessage{
		{Role: "system", Content: docDraftAllSystem},
		{Role: "user", Content: p.String()},
	})
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}
	var parsed struct {
		Sections map[string]string `json:"sections"`
	}
	if raw := extractJSON(text); raw == "" || json.Unmarshal([]byte(raw), &parsed) != nil || len(parsed.Sections) == 0 {
		s.fail(w, 502, "模型未能返回结构化章节草稿，请重试或单节起草")
		return
	}
	saved := s.docLoad(f.ID, d.ID)
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	drafted := 0
	for _, t := range targets {
		body := strings.TrimSpace(parsed.Sections[t.Key])
		body = strings.TrimSpace(strings.TrimPrefix(body, t.Title))
		if body == "" {
			continue
		}
		saved.Sections[t.Key] = docSection{
			Text:      body,
			Source:    "ai",
			Confirmed: false,
			By:        session.User + "（AI：" + model + "）",
			At:        stamp,
			Basis:     f.Current.ID,
		}
		drafted++
	}
	if drafted == 0 {
		s.fail(w, 502, "模型未生成有效章节正文，请稍后再试")
		return
	}
	if err := s.docSave(f.ID, d.ID, saved); err != nil {
		s.fail(w, 500, "保存起草结果失败")
		return
	}
	s.auditReq(r, "doc-draft", session.User, fmt.Sprintf("%s %s draft-all(%d)", f.ID, d.ID, drafted))
	nd, _ := s.buildDoc(f, d.ID)
	s.writeJSON(w, 200, map[string]any{"drafted": drafted, "doc": nd})
}

type docCheckFinding struct {
	ID           string `json:"id"`
	SectionKey   string `json:"section_key,omitempty"`
	Section      string `json:"section"`
	Category     string `json:"category"` // completeness | consistency | honesty | security | clarity
	Level        string `json:"level"`    // error | warn | tip
	Problem      string `json:"problem"`
	Evidence     string `json:"evidence,omitempty"`
	Suggest      string `json:"suggest"`
	ProposedText string `json:"proposed_text,omitempty"`
	ActionKind   string `json:"action_kind,omitempty"` // apply_text | draft_section | confirm_draft | jump
}

type docCheckMetrics struct {
	TotalSections int `json:"total_sections"`
	Completed     int `json:"completed"`
	Empty         int `json:"empty"`
	Drafts        int `json:"drafts"`
	Stale         int `json:"stale"`
	Errors        int `json:"errors"`
	Warns         int `json:"warns"`
	Tips          int `json:"tips"`
}

type docCheckResult struct {
	Score     int               `json:"score"`
	Verdict   string            `json:"verdict"` // ready | needs_fill | needs_fix
	Summary   string            `json:"summary"`
	CheckedAt string            `json:"checked_at"`
	Model     string            `json:"model,omitempty"`
	Metrics   docCheckMetrics   `json:"metrics"`
	Findings  []docCheckFinding `json:"findings"`
}

const docCheckSystem = `你是资深企业级中间件交付审阅官，正在对照平台采集的真实拓扑规格、执行记录与实时安全态势，对交付文档进行深度质量与合规审阅。
审阅维度：
1. completeness（完整性）：检查必填章节是否为空、是否残留【待补充】、关键交付结论是否缺位；
2. consistency（事实一致性）：核对人工/草稿文字中的节点数、IP、版本、高可用模式、执行步数、变更结果是否与平台事实矛盾；
3. honesty（客观坦诚）：检查是否回避或美化了失败步骤、执行偏差、未执行项或单点风险；
4. security（安全与合规）：对照实时安全态势（活跃 CVE、TLS 证书有效期、配置安全基线未通过项），检查「风险与遗留问题」「验收结论」是否如实披露并给出后续治理建议；
5. clarity（可读与交付规范）：检查表述是否专业、精炼、面向客户技术负责人与运维团队。

极其重要（让审阅结果真正可用）：
- 对于每一个可编辑章节（给出 key 的章节），如果该节为空、过时、与事实不符、或遗漏了关键安全/执行信息，你**必须**在 proposed_text 中直接给出一份**可直接一键采纳写入该节的完整专业正文**（简体中文、只基于给出事实、不编造数据、不含标题与寒暄、列表用 "- " 开头，未知业务信息写【待补充：说明】）。
- 每条 finding 尽量给出 evidence 字段，精确引用文档或安全态势里的具体数字/主机/版本/基线项/CVE 编号作为核查依据。
- 只输出严格 JSON，不要任何多余文本：
{"summary":"1-2句总结当前文档是否达到对外交付标准及核心改进点","findings":[{"section_key":"可编辑章节的key(若非可编辑章节留空)","section":"章节标题","category":"completeness|consistency|honesty|security|clarity","level":"error|warn|tip","problem":"具体问题","evidence":"引用的具体事实依据","suggest":"具体改进方向","proposed_text":"针对该可编辑章节可直接采纳的完整正文（若无需重写则留空）"}]}`

func (s *storeServer) checkDoc(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, d *clusterDoc) {
	// 1. Collect editable section metadata and deterministic structural pre-checks.
	secByKey := map[string]docBlock{}
	secByTitle := map[string]docBlock{}
	var secOrder []docBlock
	metrics := docCheckMetrics{}
	var detFindings []docCheckFinding

	for _, b := range d.Blocks {
		if b.Kind != "section" || b.Key == "" {
			continue
		}
		secByKey[b.Key] = b
		secByTitle[strings.TrimSpace(b.Title)] = b
		secOrder = append(secOrder, b)
		metrics.TotalSections++

		trimmed := strings.TrimSpace(b.Text)
		if trimmed == "" {
			metrics.Empty++
			ak := "jump"
			if b.AI {
				ak = "draft_section"
			}
			detFindings = append(detFindings, docCheckFinding{
				ID:         "det-empty-" + b.Key,
				SectionKey: b.Key,
				Section:    b.Title,
				Category:   "completeness",
				Level:      "error",
				Problem:    fmt.Sprintf("章节「%s」尚未填写，直接导出交付报告会导致核心交付内容缺失。", b.Title),
				Evidence:   "当前章节正文为空",
				Suggest:    firstNonEmptyStr(b.Hint, "请结合本集群实际交付结果补充此章节内容，或使用 AI 一键起草。"),
				ActionKind: ak,
			})
			continue
		}
		if b.Source == "ai" && !b.Confirmed {
			metrics.Drafts++
			detFindings = append(detFindings, docCheckFinding{
				ID:         "det-draft-" + b.Key,
				SectionKey: b.Key,
				Section:    b.Title,
				Category:   "completeness",
				Level:      "warn",
				Problem:    fmt.Sprintf("章节「%s」为 AI 生成草稿，尚未经过人工核对确认。", b.Title),
				Evidence:   fmt.Sprintf("来源：%s（待确认）", firstNonEmptyStr(b.By, "AI")),
				Suggest:    "请核对正文中的版本、节点与结论准确无误后点击「确认」，再正式对外导出。",
				ActionKind: "confirm_draft",
			})
		} else {
			metrics.Completed++
		}
		if b.Stale != "" {
			metrics.Stale++
			ak := "jump"
			if b.AI {
				ak = "draft_section"
			}
			detFindings = append(detFindings, docCheckFinding{
				ID:         "det-stale-" + b.Key,
				SectionKey: b.Key,
				Section:    b.Title,
				Category:   "consistency",
				Level:      "warn",
				Problem:    fmt.Sprintf("集群在本节编写后又完成了「%s」，当前内容可能已与最新状态不一致。", b.Stale),
				Evidence:   "文档章节基线落后于集群最新交付记录",
				Suggest:    "建议结合最新变更记录更新此节，或点击「按现在的集群重新起草」。",
				ActionKind: ak,
			})
		}
		if strings.Contains(trimmed, "【待补充") {
			detFindings = append(detFindings, docCheckFinding{
				ID:         "det-todo-" + b.Key,
				SectionKey: b.Key,
				Section:    b.Title,
				Category:   "completeness",
				Level:      "error",
				Problem:    fmt.Sprintf("章节「%s」中仍残留【待补充】占位符，交付前需补全实际信息。", b.Title),
				Evidence:   "正文中检测到未替换的【待补充】标记",
				Suggest:    "请跳转至该节编辑并替换为真实的现场/业务信息。",
				ActionKind: "jump",
			})
		}
	}

	// 2. Build rich grounded prompt (doc facts + live cluster security posture + editable section schema).
	secFacts := s.clusterSecurityFactsSummary(session.User, f)
	var prompt strings.Builder
	prompt.WriteString(docFacts(d, ""))
	prompt.WriteString(secFacts)
	if len(secOrder) > 0 {
		prompt.WriteString("\n\n可编辑章节清单（请务必准确填写 section_key，并对空缺/待改进章节在 proposed_text 中提供可直接采纳写入的完整正文）：\n")
		for _, b := range secOrder {
			st := "已确认"
			if strings.TrimSpace(b.Text) == "" {
				st = "未填写"
			} else if b.Source == "ai" && !b.Confirmed {
				st = "AI草稿待确认"
			}
			if b.Stale != "" {
				st += "（已过时）"
			}
			fmt.Fprintf(&prompt, "- key=%q | 标题=%s | 状态=%s | 允许AI改写=%v | 撰写要点=%s\n", b.Key, b.Title, st, b.AI, b.Hint)
		}
	}

	text, model, code, err := s.docAI(r, session.User, f.ID, d.ID+"/check", []aiMessage{
		{Role: "system", Content: docCheckSystem},
		{Role: "user", Content: prompt.String()},
	})
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}

	var parsed struct {
		Summary  string            `json:"summary"`
		Findings []docCheckFinding `json:"findings"`
	}
	parsedOK := false
	if raw := extractJSON(text); raw != "" && json.Unmarshal([]byte(raw), &parsed) == nil {
		parsedOK = true
	}

	resolveSec := func(key, title string) (docBlock, bool) {
		k := strings.TrimSpace(key)
		if b, ok := secByKey[k]; ok {
			return b, true
		}
		t := strings.TrimSpace(title)
		if b, ok := secByTitle[t]; ok {
			return b, true
		}
		for _, b := range secOrder {
			if t != "" && (strings.Contains(b.Title, t) || strings.Contains(t, b.Title)) {
				return b, true
			}
		}
		return docBlock{}, false
	}

	// 3. Merge deterministic findings & LLM findings cleanly (no duplicates for empty sections; attach proposed_text!).
	merged := make([]docCheckFinding, 0, len(detFindings)+len(parsed.Findings))
	llmCoveredEmpty := map[string]bool{}
	idx := 0

	if parsedOK {
		for _, f0 := range parsed.Findings {
			f0.Problem = strings.TrimSpace(f0.Problem)
			f0.Suggest = strings.TrimSpace(f0.Suggest)
			f0.Evidence = strings.TrimSpace(f0.Evidence)
			f0.ProposedText = strings.TrimSpace(f0.ProposedText)
			if f0.Problem == "" {
				continue
			}
			switch strings.ToLower(strings.TrimSpace(f0.Level)) {
			case "error", "high", "critical":
				f0.Level = "error"
			case "tip", "info", "low":
				f0.Level = "tip"
			default:
				f0.Level = "warn"
			}
			switch strings.ToLower(strings.TrimSpace(f0.Category)) {
			case "completeness", "consistency", "honesty", "security", "clarity":
				f0.Category = strings.ToLower(strings.TrimSpace(f0.Category))
			default:
				f0.Category = "clarity"
			}
			if sb, ok := resolveSec(f0.SectionKey, f0.Section); ok {
				f0.SectionKey = sb.Key
				f0.Section = sb.Title
				f0.ProposedText = strings.TrimSpace(strings.TrimPrefix(f0.ProposedText, sb.Title))
				if strings.TrimSpace(sb.Text) == "" {
					llmCoveredEmpty[sb.Key] = true
				}
				if f0.ProposedText != "" && sb.AI {
					f0.ActionKind = "apply_text"
				} else if strings.TrimSpace(sb.Text) == "" && sb.AI {
					f0.ActionKind = "draft_section"
				} else if sb.Source == "ai" && !sb.Confirmed {
					f0.ActionKind = "confirm_draft"
				} else {
					f0.ActionKind = "jump"
				}
			} else {
				f0.SectionKey = ""
				f0.ProposedText = ""
				f0.ActionKind = "jump"
			}
			idx++
			f0.ID = fmt.Sprintf("ai-%d", idx)
			merged = append(merged, f0)
		}
	}

	// Prepend any deterministic findings not already covered by an LLM finding on that empty section.
	var prefix []docCheckFinding
	for _, df := range detFindings {
		if strings.HasPrefix(df.ID, "det-empty-") && llmCoveredEmpty[df.SectionKey] {
			continue
		}
		prefix = append(prefix, df)
	}
	merged = append(prefix, merged...)

	// Sort: error -> warn -> tip.
	rankLevel := func(l string) int {
		switch l {
		case "error":
			return 0
		case "warn":
			return 1
		default:
			return 2
		}
	}
	for i := 1; i < len(merged); i++ {
		for j := i; j > 0 && rankLevel(merged[j].Level) < rankLevel(merged[j-1].Level); j-- {
			merged[j], merged[j-1] = merged[j-1], merged[j]
		}
	}

	score := 100
	for _, fd := range merged {
		switch fd.Level {
		case "error":
			metrics.Errors++
			score -= 18
		case "warn":
			metrics.Warns++
			score -= 8
		default:
			metrics.Tips++
			score -= 2
		}
	}
	if score < 0 {
		score = 0
	}

	verdict := "ready"
	if metrics.Empty > 0 {
		verdict = "needs_fill"
	} else if metrics.Errors > 0 || score < 75 {
		verdict = "needs_fix"
	}

	summary := strings.TrimSpace(parsed.Summary)
	if summary == "" {
		switch verdict {
		case "ready":
			summary = "已完成全文事实核对、完整度与安全合规审阅，未发现阻断交付的严重问题，可正式导出 Word。"
		case "needs_fill":
			summary = fmt.Sprintf("当前文档仍有 %d 个待填写章节，建议直接采纳下方 AI 生成的章节建议或一键补全后再核对导出。", metrics.Empty)
		default:
			summary = fmt.Sprintf("发现 %d 项严重问题与 %d 项待完善建议，请对照事实依据修订后再正式交付。", metrics.Errors, metrics.Warns)
		}
	}

	res := docCheckResult{
		Score:     score,
		Verdict:   verdict,
		Summary:   summary,
		CheckedAt: time.Now().UTC().Format(time.RFC3339),
		Model:     model,
		Metrics:   metrics,
		Findings:  merged,
	}
	s.auditReq(r, "doc-check", session.User, fmt.Sprintf("%s %s score=%d findings=%d", f.ID, d.ID, res.Score, len(res.Findings)))
	s.writeJSON(w, 200, res)
}

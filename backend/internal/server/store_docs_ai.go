package server

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

const docSystem = `你是一名资深企业级中间件交付架构师，正在为客户撰写正式可签收的交付报告正文。

核心撰写规范（严格遵守）：
1. 写结论与结果，不写过程与讨论：
   - 交付报告面向客户技术负责人、架构师及一线运维团队，须直接陈述架构现状、验证结论与客观交接要点；
   - 严禁出现工具视角或自我解释式开头（如“本节依据……探针采集结果整理”“当前资料未记录”“档案中没有……”“需要补录基线”）；
   - 严禁把平台内部编号或工具机制带入正文（如 sop-xxxxxxxx、job-xxx、pkg:xxx、mwctl、探针仅在某节点执行等）；引用历史变更时直接写出变更主题或内容。
2. 零占位符红线（没有就不要写）：
   - 严禁在正式报告正文中输出任何【待补充：……】、[待填写]、TBD、占位符或空白模板提示！
   - 若事实或现场口径中未提供业务系统名称、归属部门、运维制度、SLA 等外部信息，直接省略该维度，绝对不要硬写一条“业务定位：【待补充……】”来破坏正式报告质感。
3. 严禁把正常业务需求或交付收尾误写成“风险点”（极其重要）：
   - 验收收尾阶段执行测试表清理、测试产物清理、测试备份历史重置/清除（如 clean-tests、clean-artifacts、reset-backups / 「放弃全部备份历史」）属于正式投产前清场的标准正常动作，**绝非高危/中危风险或故障**（如需提醒，仅在交接建议中温和注明“投产前按策略执行首次生产全量备份”即可）。
   - 严禁吹毛求疵编造伪风险：不得挑刺步骤确认与记录的分钟级时间差（所谓“验收记录一致性”），不得将合理的常规参数（如 sync_strict=false 保障可用性、max_connections、log_lock_waits=off、app_user 留空待应用接入等）或未纳入本交付包的外围体系（独立监控平台、客户侧前置 ELB/VIP、异地备份介质、同机控制节点）擅自定级为「高危/中危风险短板」。
   - 凡是「已确认的现场口径」中明确为客户按需选择/既有配套的事项（如客户明确不启用 TLS 或 TDE、前端已有独立 ELB/F5/VIP、已有外部监控与备份体系、按可用性优先关闭严格同步等），必须视为**正常交付范围与架构现状**，可在概述/架构中如实中性陈述，**严禁列入「风险与遗留问题」**。
   - 仅将真正未闭环的实质风险（如存在失败未恢复步骤、活跃未修复的严重/高危 CVE、证书即将过期、或现场明确勾选“确属待整改风险”的事项）列入风险；若无实质阻断风险，第 6 节应简明扼要地写明“本次交付验收项全部通过，当前无阻断投产的未闭环风险”（可附 1~2 条中性投产交接提醒），切忌为凑篇幅强行罗列“高/中/低风险”。
4. 事实客观红线（不可违背）：
   - 仅依据给出的真实数据撰写，严禁编造版本号、主机、IP、参数值、时间、人名或未发生的验收结果；
   - 确实存在的失败未恢复步骤或未修复的高危/严重漏洞必须如实呈现，禁止隐瞒。
5. 版式与语言风格：
   - 简体中文，书面、凝练、专业、克制，像资深交付顾问亲手定稿的正式交付文档；
   - 直接输出本节正文：不要重复章节标题，不要寒暄或解释说明；
   - 建议采用“1~2 句总述结论 + 精炼要点（每条以 "- **维度标题**：..." 开头）”的结构；不要使用 Markdown 标题（#）、代码块或表格。`

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
			b.WriteString("（本次安全审计聚焦中间件软件栈；操作系统底层系统包补丁纳入主机 OS 运维通道单独评估）")
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
		fmt.Fprintf(&b, "- 配置安全基线：通过 %d/%d 项（注：未开启项如 TLS/TDE 可能是客户按需不启用，须严格以已确认现场口径为准，不得机械定级为高危故障）\n", rep.BaselinePassed, rep.BaselineTotal)
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

// detectDeliveryClarifications deterministically inspects cluster topology and parameters
// to surface ambiguous customer-decision items (e.g., disabled TLS/TDE, external LB/monitoring,
// optional business workload name) as an interactive confirmation card before AI drafting.
func (s *storeServer) detectDeliveryClarifications(f clusterFacts, saved docSaved, lang string) []docClarifyItem {
	dep := s.readSpec(f.Current.ID)
	app := strings.ToLower(strings.TrimSpace(f.Current.AppID))
	ansByQ := map[string]string{}
	for _, a := range saved.Answers {
		q := strings.TrimSpace(a.Question)
		if q != "" {
			ansByQ[q] = strings.TrimSpace(a.Answer)
		}
	}
	lookupAns := func(q string) string {
		if v, ok := ansByQ[strings.TrimSpace(q)]; ok {
			return v
		}
		return ""
	}

	params := map[string]any{}
	hostCount := 0
	hasFront := false
	hasMonitoring := false
	if f.Plan != nil {
		hostCount = len(f.Plan.Hosts)
		for _, inst := range f.Plan.Instances {
			if !inst.External && (app == "" || strings.EqualFold(inst.Component, app)) {
				for k, v := range inst.Params {
					params[strings.ToLower(k)] = v
				}
			}
			if len(inst.Fronts) > 0 || inst.External {
				hasFront = true
			}
			if strings.Contains(strings.ToLower(inst.Component), "exporter") || strings.Contains(strings.ToLower(inst.Component), "prometheus") {
				hasMonitoring = true
			}
		}
	}
	if dep != nil {
		if hostCount == 0 {
			hostCount = len(dep.Hosts)
		}
		for _, inst := range dep.Instances {
			if app == "" || strings.EqualFold(inst.Component, app) {
				for k, v := range inst.Params {
					lk := strings.ToLower(k)
					if _, exists := params[lk]; !exists {
						params[lk] = v
					}
				}
			}
		}
		if dep.Imported != nil {
			if len(dep.Imported.Endpoints) > 0 {
				hasFront = true
			}
			for _, cm := range dep.Imported.Companions {
				if cm.Kind == "monitoring" || cm.Kind == "exporter" || strings.Contains(strings.ToLower(cm.Component), "exporter") {
					hasMonitoring = true
				}
				if cm.Kind == "proxy" || cm.Kind == "vip" {
					hasFront = true
				}
			}
		}
	}

	isExplicitFalse := func(keys ...string) bool {
		for _, k := range keys {
			if v, ok := params[k]; ok {
				switch x := v.(type) {
				case bool:
					if !x {
						return true
					}
				case string:
					lx := strings.ToLower(strings.TrimSpace(x))
					if lx == "false" || lx == "off" || lx == "0" || lx == "no" {
						return true
					}
				}
			}
		}
		return false
	}

	var items []docClarifyItem
	add := func(it docClarifyItem) {
		it.Answer = lookupAns(it.Question)
		items = append(items, it)
	}

	// 1. Optional business context (leave blank -> omitted cleanly, never emits 【待补充】).
	bizQ := tr(lang, "本集群承载的业务系统或服务对象（选填；留空则报告直接省略，不写占位符）", "Business system or workload served by this cluster (optional; leave blank to omit cleanly)")
	add(docClarifyItem{
		ID:          "biz_context",
		Topic:       tr(lang, "业务归属（选填）", "Workload (Optional)"),
		Question:    bizQ,
		Optional:    true,
		Placeholder: tr(lang, "例如：研发工具链 Artifactory 生产数据库（可留空）", "e.g., DevOps Artifactory production DB (optional)"),
	})

	// 2. TLS disabled
	if isExplicitFalse("tls", "ssl") {
		opt1 := tr(lang, "客户按需不启用（内网隔离 / 前置终止），属正常交付配置，不列为风险", "Disabled by customer requirement (isolated VPC / upstream TLS); normal config, not a risk")
		opt2 := tr(lang, "仅作为后续可选加固建议，不列为阻断风险", "Optional future hardening suggestion only, not a blocker risk")
		opt3 := tr(lang, "确属待整改安全风险，需写入风险清单", "Confirmed open security risk; include in Risks section")
		add(docClarifyItem{
			ID:       "tls_disabled",
			Topic:    tr(lang, "传输加密 (TLS)", "Transport TLS"),
			Question: tr(lang, "当前未启用 TLS 传输加密，请确认交付口径：", "TLS transport encryption is disabled — how should the report treat this?"),
			Options:  []string{opt1, opt2, opt3},
			Default:  opt1,
		})
	}

	// 3. TDE disabled
	if isExplicitFalse("tde") {
		opt1 := tr(lang, "客户无需开启 / 底层存储已加密，属正常交付配置，不列为风险", "Not required / storage-layer encryption used; normal config, not a risk")
		opt2 := tr(lang, "后续按合规要求再评估，不列为风险", "Evaluate later if compliance requires; not a risk")
		opt3 := tr(lang, "确属待整改安全风险，需写入风险清单", "Confirmed open security risk; include in Risks section")
		add(docClarifyItem{
			ID:       "tde_disabled",
			Topic:    tr(lang, "静态加密 (TDE)", "At-Rest TDE"),
			Question: tr(lang, "当前未启用 TDE 透明数据加密，请确认交付口径：", "TDE at-rest encryption is disabled — how should the report treat this?"),
			Options:  []string{opt1, opt2, opt3},
			Default:  opt1,
		})
	}

	// 4. Multi-node cluster without in-package LB / frontend endpoint
	if hostCount > 1 && !hasFront {
		opt1 := tr(lang, "前端由客户侧独立 ELB / F5 / VIP 承载，属正常交付边界，不列为风险", "Handled by external customer ELB/F5/VIP; normal boundary, not a risk")
		opt2 := tr(lang, "应用采用多节点连接串直连，无需独立负载均衡，不列为风险", "Applications connect via multi-host connection string; normal design, not a risk")
		opt3 := tr(lang, "前端入口尚未配置，需记为投产前待办", "Frontend ingress pending; note as pre-go-live action item")
		add(docClarifyItem{
			ID:       "no_lb_front",
			Topic:    tr(lang, "前端访问入口", "Access Endpoint"),
			Question: tr(lang, "交付包未含独立负载均衡，业务实际接入方式为：", "No dedicated load balancer is inside this package — how will traffic connect?"),
			Options:  []string{opt1, opt2, opt3},
			Default:  opt1,
		})
	}

	// 5. PostgreSQL non-strict sync
	if (app == "postgresql" || app == "postgres") && hostCount > 1 && isExplicitFalse("sync_strict") {
		opt1 := tr(lang, "按可用性优先设计（从库异常时不阻塞主库写入），属正常配置，不列为风险", "Designed for write availability when a standby fails; normal config, not a risk")
		opt2 := tr(lang, "需在交接中温和提示降级异步时的 RPO 边界", "Add a brief handover note on RPO behavior during standby outage")
		add(docClarifyItem{
			ID:       "sync_non_strict",
			Topic:    tr(lang, "同步复制策略", "Sync Policy"),
			Question: tr(lang, "当前关闭严格同步（sync_strict=false），请确认设计意图：", "Strict synchronous commit (sync_strict=false) is off — confirm intent:"),
			Options:  []string{opt1, opt2},
			Default:  opt1,
		})
	}

	// 6. Single-node deployment
	if hostCount == 1 {
		opt1 := tr(lang, "按需单节点部署（测试/非核心环境），接受单点架构", "Intentional standalone deployment (non-critical/test); single-node accepted")
		opt2 := tr(lang, "生产暂行单节点，需在风险章节提示单点隐患", "Production standalone; flag SPOF risk in Risks section")
		add(docClarifyItem{
			ID:       "single_node",
			Topic:    tr(lang, "单节点定位", "Single-Node Scope"),
			Question: tr(lang, "当前为单节点部署，请确认交付口径：", "Cluster is deployed as a single node — confirm scope:"),
			Options:  []string{opt1, opt2},
			Default:  opt1,
		})
	}

	// 7. External monitoring / backup storage scope
	if !hasMonitoring {
		opt1 := tr(lang, "监控告警与异地备份由客户现有运维体系统一纳管，属正常交付边界，不列为风险", "Monitoring and off-host backup are managed by customer ops platform; normal scope, not a risk")
		opt2 := tr(lang, "需在投产交接提醒中注明接入监控及配置异地备份介质", "Include a concise handover reminder to hook up monitoring & off-host backup")
		add(docClarifyItem{
			ID:       "external_ops",
			Topic:    tr(lang, "监控与备份边界", "Monitoring & Backup"),
			Question: tr(lang, "监控告警与外部备份介质不在本次交付包内，现场口径为：", "Monitoring and off-host backup are outside this package — confirm boundary:"),
			Options:  []string{opt1, opt2},
			Default:  opt1,
		})
	}

	return items
}

func upsertDocAnswers(existing, incoming []planQA) []planQA {
	out := append([]planQA(nil), existing...)
	for _, a := range incoming {
		q := truncRunes(strings.TrimSpace(a.Question), 300)
		ans := truncRunes(strings.TrimSpace(a.Answer), 1000)
		if q == "" {
			continue
		}
		replaced := false
		for i := range out {
			if strings.TrimSpace(out[i].Question) == q {
				out[i].Answer = ans
				replaced = true
				break
			}
		}
		if !replaced && ans != "" && len(out) < 60 {
			out = append(out, planQA{Question: q, Answer: ans})
		}
	}
	// Remove entries whose answer was explicitly cleared.
	cleaned := out[:0]
	for _, a := range out {
		if strings.TrimSpace(a.Answer) != "" {
			cleaned = append(cleaned, a)
		}
	}
	return cleaned
}

func formatDocClarificationContext(saved docSaved) string {
	if len(saved.Answers) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\n【客户与交付工程师已确认的现场口径（最高优先级，必须严格遵守；凡确认为「正常交付配置/正常交付边界/不列为风险」的事项，严禁写入「风险与遗留问题」！）】：\n")
	for _, a := range saved.Answers {
		if strings.TrimSpace(a.Answer) == "" {
			continue
		}
		b.WriteString("- 事项：" + a.Question + "\n  已确认口径：" + aiScrub(a.Answer) + "\n")
	}
	return b.String()
}

func (s *storeServer) draftSection(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, d *clusterDoc, key string) {
	sec := docSectionOf(d, key)
	if sec == nil || !sec.AI {
		s.fail(w, 404, "这一节不能由 AI 起草")
		return
	}
	var in struct {
		Ask     string   `json:"ask"`     // what the person wants in it, optional
		Answers []planQA `json:"answers"` // answers to the assistant's questions / delivery clarifications
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in)
	saved := s.docLoad(f.ID, d.ID)
	if len(in.Answers) > 0 {
		saved.Answers = upsertDocAnswers(saved.Answers, in.Answers)
		_ = s.docSave(f.ID, d.ID, saved)
	}
	prompt := "下面是平台整理的事实和文档里已经写好的部分：\n\n" + docFacts(d, key) + s.clusterSecurityFactsSummary(session.User, f) + formatDocClarificationContext(saved)
	prompt += "\n\n请起草「" + sec.Title + "」这一节的正文。本节目标：" + sec.Hint + "\n注意：直接输出面向客户签收的正式报告结论，严禁输出任何【待补充】/TBD 占位符（未知信息直接省略），严禁把验收阶段清理测试备份/测试数据或客户按需选定的配置误判为风险，不要写过程性套话或暴露内部编号。"
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

const docDraftAllSystem = `你是一名资深企业级中间件交付架构师，正在一次性为客户补全正式交付报告中尚未填写的章节。

核心撰写规范（严格遵守）：
1. 写结论与结果，不写过程与讨论：面向客户技术负责人与运维团队直接输出定稿级正文，严禁出现“本节依据……整理”“探针采集显示”“档案中没有记录”“需要补录基线”等内部工具视角或对话式表述，严禁泄露内部编号（如 sop-xxxxxxxx、pkg:xxx）。
2. 零占位符红线（没有就不要写）：严禁输出任何【待补充：……】、[待填写]、TBD 占位符！未提供的业务系统名称、归属部门或外部运维制度直接省略，切勿硬写空壳条目。
3. 严禁将正常交付行为或客户按需选择误写成“风险点”：
   - 验收收尾阶段清理测试表、测试产物或「放弃全部备份历史/清理测试备份」是标准投产前清场动作，绝非风险；
   - 严禁挑刺步骤执行/确认的分钟级时间差；
   - 凡「已确认的现场口径」中明确为客户按需选择或既有配套的事项（如不启用 TLS/TDE、前端已有独立 ELB/F5/VIP、已有外部监控与备份体系、按可用性优先关闭严格同步等），必须视为正常交付范围，严禁写入「风险与遗留问题」；
   - 若无真实未闭环风险，第 6 节应简明给出“无阻断投产的未闭环风险”的干净交接结论，切忌凑数罗列伪风险。
4. 严守事实红线：仅基于给出的拓扑、规格、执行记录、现场口径与安全态势撰写，不编造版本、数字、时间、人名或未发生事件；确实存在的失败未恢复项或未修复严重/高危漏洞须如实披露。
5. 版式规范：简体中文、书面凝练，优先采用“总述结论 + 分条要点（每行以 "- **主题**：..." 开头）”结构，不使用 Markdown 标题、代码块或表格；不要重复章节标题。
6. 只输出严格 JSON：{"sections":{"章节key":"该节正文内容"}}，不要输出 Markdown 围栏或多余说明。`

// draftAllSections drafts all currently empty (and optionally stale) AI-draftable sections in one fast LLM round-trip.
func (s *storeServer) draftAllSections(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, d *clusterDoc) {
	var in struct {
		IncludeStale bool     `json:"include_stale"`
		ForceAll     bool     `json:"force_all"`
		SaveOnly     bool     `json:"save_only"`
		Ask          string   `json:"ask"`
		Answers      []planQA `json:"answers"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in)
	}
	saved := s.docLoad(f.ID, d.ID)
	if len(in.Answers) > 0 {
		saved.Answers = upsertDocAnswers(saved.Answers, in.Answers)
		if err := s.docSave(f.ID, d.ID, saved); err != nil {
			s.fail(w, 500, "保存交付口径失败")
			return
		}
	}
	if in.SaveOnly {
		nd, _ := s.buildDoc(f, d.ID)
		s.writeJSON(w, 200, map[string]any{"drafted": 0, "doc": nd})
		return
	}
	var targets []docBlock
	for _, b := range d.Blocks {
		if b.Kind != "section" || !b.AI || b.Key == "" {
			continue
		}
		empty := strings.TrimSpace(b.Text) == ""
		if in.ForceAll || empty || (in.IncludeStale && b.Stale != "") {
			targets = append(targets, b)
		}
	}
	if len(targets) == 0 {
		nd, _ := s.buildDoc(f, d.ID)
		s.writeJSON(w, 200, map[string]any{"drafted": 0, "doc": nd})
		return
	}

	var p strings.Builder
	p.WriteString("下面是平台整理的文档事实与实时安全态势：\n\n")
	p.WriteString(docFacts(d, ""))
	p.WriteString(s.clusterSecurityFactsSummary(session.User, f))
	p.WriteString(formatDocClarificationContext(saved))
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
	saved = s.docLoad(f.ID, d.ID)
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

const docCheckSystem = `你是资深企业级中间件交付审阅官，正在对照真实拓扑规格、执行记录与实时安全态势，对交付报告进行深度质量与合规审阅。
审阅维度：
1. completeness（完整性）：检查必填章节是否为空、是否残留【待补充】占位符、关键交付结论是否缺位；
2. consistency（事实一致性）：核对正文中的节点数、IP、版本、高可用模式、执行步数、变更结果是否与平台事实矛盾；
3. honesty（客观坦诚）：检查是否回避或美化了失败步骤、执行偏差、未执行项或单点风险；
4. security（安全与合规）：对照实时安全态势（活跃 CVE、TLS 证书有效期）与已确认的现场口径，检查「风险与遗留问题」「验收结论」是否如实披露真实漏洞与未闭环事项；注意不得强求将客户已明确按需不启用的项（如按需不启用 TLS/TDE、外部 ELB/监控）或正常验收清理（清理测试备份/数据）误判为风险；
5. clarity（正式公文规范）：重点排查 AI 对话口吻、过程性套话、内部系统编号泄露、任何残留的【待补充】占位符，以及把正常验收清理/客户正常业务需求误写成“高/中危风险”的问题，确保全文具备面向客户签收的正式交付报告质感。

极其重要（让审阅结果真正可用）：
- 对于每一个可编辑章节（给出 key 的章节），如果该节为空、过时、与事实不符、含【待补充】占位符、误把正常配置/测试清理写成风险或口语化，你**必须**在 proposed_text 中直接给出一份**可直接一键采纳写入该节的定稿级正式正文**（简体中文、结论导向、只基于给出事实与已确认现场口径、不编造数据、不含标题与寒暄、不使用内部编号、零【待补充】占位符、列表用 "- **维度**：..." 开头）。
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

	// 2. Build rich grounded prompt (doc facts + live cluster security posture + confirmed customer clarifications + editable section schema).
	savedDoc := s.docLoad(f.ID, d.ID)
	secFacts := s.clusterSecurityFactsSummary(session.User, f)
	var prompt strings.Builder
	prompt.WriteString(docFacts(d, ""))
	prompt.WriteString(secFacts)
	prompt.WriteString(formatDocClarificationContext(savedDoc))
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

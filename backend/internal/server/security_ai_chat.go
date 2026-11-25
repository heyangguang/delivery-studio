package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Conversational Security AI Assistant & Actionable Security Proposal Cards
// Shared between:
//   1. Cluster Delivery AIDock (`sec:*` sessions on /api/jobs/{id}/ai/*)
//   2. Global Security Center AIDock (/api/security/ai/*)

const aiSystemSecurityCluster = `你是 Kyndryl Delivery Studio 的企业级中间件安全与 CVE 研判专家，直接与现场运维/安全工程师在集群上下文中实时对话。

核心工作方式：
1. **先查真实事实，再下结论**：
   - 先调用 cluster_security_info 查看当前集群的真实漏洞清单（已区分中间件本体 primary / OS 底层包 dependency）、配置基线检查结果和证书状态。
   - 需要确认某漏洞在当前集群是否真的可利用（例如某个模块、TLS、HTTP/3、端口、认证方式是否开启），主动调用 delivery_info、search_files、read_file 核对集群的真实配置与剧本，绝不凭空臆测。
   - 若涉及控制机或现场确认项且平台上查不到（例如该集群是否暴露公网、是否有上游 WAF/防火墙隔离），可用 ask_user 向工程师提出 1～2 个简短选择题确认，不要盲猜。
2. **回答精炼、结构清晰（中文）**：
   - 研判 CVE 时简明给出：① 漏洞原理与触发条件 ② 结合本集群真实配置的可利用性结论（高/中/低/不受影响）③ 短期无升级缓解措施或可在节点执行的只读核实命令 ④ 升级修复建议。
   - 回答与推理摘要均使用中文；密码、密钥、证书已脱敏为［已隐去］，切勿索取。
3. **主动生成可一键采纳的操作卡片（写完文字分析后再出卡片）**：
   - 当评估结论明确指向某项 VEX 处置（计划修复 planned / 已缓解 mitigated / 不受影响 not_affected / 风险豁免 accepted），或工程师在对话中要求处置/豁免/修改理由时，调用 **propose_vex_triage** 生成「VEX 漏洞处置提案卡片」——工程师可在卡片上直接点「采纳并写入 VEX」，或点「不采纳」告诉你调整方向。
   - 当配置基线未通过但结合现场隔离条件适合豁免、或工程师要求豁免基线时，调用 **propose_baseline_waive** 生成「配置基线豁免提案卡片」。
   - 当中间件本体存在可升级修复版本（fixed_in 非空）且建议通过无中断演练升级修复时，调用 **suggest_security_rehearsal** 生成「发起安全修复演练卡片」。
   - 若工程师要求把某条只读核实或缓解命令写入交付执行手册，可调用 propose_step。
4. **严格遵守 VEX 合规规范**：
   - VEX 卡片的 note 必须简洁专业、客观准确（60～200 字以内），只写已核实或工程师确认的事实，绝不编造 IP、日期或未验证的测试结果。
   - 平台仅支持 4 种处置动作状态：planned（计划修复）、mitigated（已缓解）、not_affected（不受影响）、accepted（风险豁免）。
   - 文字先写清分析结论，再调用提案工具出卡片；用户未采纳前提案不会生效。`

const aiSystemSecurityGlobal = `你是 Kyndryl Delivery Studio 安全与漏洞中心的全局安全 AI 助手，协助安全与运维工程师分析全平台（已交付集群、离线软件库、Ansible 运行环境）的 CVE 漏洞与合规风险。

核心工作方式：
1. **以平台扫描事实为准**：
   - 使用 security_scan_summary 查看全平台最新扫描概览（已区分中间件本体 / OS 底层包 / 控制机运行环境）。
   - 使用 security_search_findings 按 CVE、软件包、集群、层级（primary/dependency/runtime）或严重等级检索具体漏洞。
   - 需要深入了解某个受影响集群的配置基线、证书或软件栈时，调用 cluster_security_info。
   - 需要确认现场网络边界（如是否公网暴露、维护窗口时间）才能定性 VEX 时，可用 ask_user 简短提问。
2. **回答精炼、中文优先**：
   - 研判 CVE 时简明给出：① 漏洞原理与触发条件 ② 结合受影响资产（中间件本体 vs OS 底层包）的实际风险与优先级 ③ 短期缓解或只读核实建议 ④ 升级修复与演练建议。
3. **主动生成可一键采纳的操作卡片（先讲清分析再出卡片）**：
   - 给出明确 VEX 处置建议或响应用户要求时，调用 **propose_vex_triage** 生成「VEX 漏洞处置提案卡片」（可针对单个或多个 CVE，按包生效或全局 CVE 生效），用户一键即可采纳写入并实时刷新安全中心。
   - 涉及某集群的配置基线豁免时，调用 **propose_baseline_waive**。
   - 涉及某集群中间件本体的可修复漏洞需要安排变更演练时，调用 **suggest_security_rehearsal**。
4. **严守事实与合规**：
   - 绝不编造未核实的事实、IP 或测试结果；note 控制在 60～200 字以内可直接审计留痕。`

// ---- Shared Security Proposal Appliers ----

func (s *storeServer) applyVexProposal(r *http.Request, user string, v *aiVexSpec) error {
	if v == nil {
		return fmt.Errorf("VEX 提案缺少处置参数")
	}
	status := strings.ToLower(strings.TrimSpace(v.Status))
	validStatus := map[string]bool{"open": true, "planned": true, "mitigated": true, "not_affected": true, "accepted": true}
	if !validStatus[status] {
		return fmt.Errorf("无效的 VEX 处置状态：%s", v.Status)
	}
	expiresAt := strings.TrimSpace(v.ExpiresAt)
	if expiresAt != "" {
		if _, err := time.Parse("2006-01-02", expiresAt); err != nil {
			return fmt.Errorf("豁免到期日期格式应为 YYYY-MM-DD")
		}
	}
	note := truncRunes(strings.TrimSpace(v.Note), 500)
	just := strings.TrimSpace(v.Justification)
	if (status == "accepted" || status == "not_affected" || status == "mitigated") && note == "" && just == "" {
		return fmt.Errorf("标记已缓解、不受影响或风险豁免时必须包含处置依据")
	}

	var cves []string
	seen := map[string]bool{}
	addCVE := func(x string) {
		x = strings.ToUpper(strings.TrimSpace(x))
		if x != "" && !seen[x] {
			seen[x] = true
			cves = append(cves, x)
		}
	}
	for _, c := range v.CVEs {
		addCVE(c)
	}
	addCVE(v.CVE)
	if len(cves) == 0 {
		return fmt.Errorf("VEX 提案缺少漏洞编号")
	}

	pkg := strings.TrimSpace(v.Package)
	eco := strings.TrimSpace(v.Ecosystem)
	stamp := now()

	secDBMu.Lock()
	rawRep := s.loadLatestScan()
	triageMap := s.loadSecTriage()

	// Build a lookup from latest scan in case ecosystem or package needs resolution.
	findMeta := map[string]secFinding{}
	if rawRep != nil {
		for _, f := range rawRep.Findings {
			if f.CVE != "" {
				k1 := strings.ToUpper(f.CVE) + "|" + strings.ToLower(f.Package)
				if _, ok := findMeta[k1]; !ok {
					findMeta[k1] = f
				}
				if _, ok := findMeta[strings.ToUpper(f.CVE)]; !ok {
					findMeta[strings.ToUpper(f.CVE)] = f
				}
			}
		}
	}

	var keys []string
	for _, vid := range cves {
		curPkg, curEco := pkg, eco
		if !v.Global && (curPkg == "" || curEco == "") {
			if curPkg != "" {
				if f, ok := findMeta[vid+"|"+strings.ToLower(curPkg)]; ok {
					curEco = firstNonEmptyStr(curEco, f.Ecosystem)
				}
			}
			if curPkg == "" || curEco == "" {
				if f, ok := findMeta[vid]; ok {
					curPkg = firstNonEmptyStr(curPkg, f.Package)
					curEco = firstNonEmptyStr(curEco, f.Ecosystem)
				}
			}
		}
		key := vid
		if !v.Global && curPkg != "" && curEco != "" {
			key = vid + "|" + strings.ToLower(curPkg) + "|" + normalizeEcoKey(curEco)
		}
		prev := triageMap[key]
		hist := append([]secTriageEvent{{
			Status:    status,
			Note:      note,
			ExpiresAt: expiresAt,
			By:        user,
			At:        stamp,
		}}, prev.History...)
		if len(hist) > 20 {
			hist = hist[:20]
		}
		triageMap[key] = secTriageRecord{
			Key:             key,
			VulnID:          vid,
			Package:         curPkg,
			Ecosystem:       curEco,
			Status:          status,
			Justification:   just,
			Note:            note,
			ExpiresAt:       expiresAt,
			LinkedClusterID: strings.TrimSpace(v.ClusterID),
			UpdatedBy:       user,
			UpdatedAt:       stamp,
			History:         hist,
		}
		keys = append(keys, key)
	}
	err := s.saveSecTriage(triageMap)
	secDBMu.Unlock()
	if err != nil {
		return fmt.Errorf("保存 VEX 处置记录失败")
	}
	s.auditReq(r, "security-triage-ai", user, fmt.Sprintf("%s -> %s", strings.Join(keys, ","), status))
	return nil
}

func (s *storeServer) applyBaselineWaiveProposal(r *http.Request, user string, b *aiBaselineSpec) error {
	if b == nil {
		return fmt.Errorf("基线豁免提案缺少参数")
	}
	cid := strings.TrimSpace(b.ClusterID)
	chk := strings.TrimSpace(b.CheckID)
	note := truncRunes(strings.TrimSpace(b.Note), 300)
	if cid == "" || chk == "" || note == "" {
		return fmt.Errorf("基线豁免提案缺少集群、检查项 ID 或豁免原因")
	}
	secDBMu.Lock()
	waivers := s.loadSecBaselineWaivers()
	waivers[cid+"|"+chk] = secBaselineWaiver{
		ClusterID: cid,
		CheckID:   chk,
		Note:      note,
		By:        user,
		At:        now(),
	}
	err := s.saveSecBaselineWaivers(waivers)
	secDBMu.Unlock()
	if err != nil {
		return fmt.Errorf("保存配置基线豁免失败")
	}
	s.auditReq(r, "security-baseline-waive-ai", user, fmt.Sprintf("%s %s waived=true", cid, chk))
	return nil
}

// ---- Shared Security AI Tool Definitions ----

func aiClusterSecurityInfoTool() aiToolDef {
	return aiToolDef{
		Name:        "cluster_security_info",
		Description: "读取指定集群的完整安全态势审计报告：安全评分、中间件本体与 OS 底层包漏洞清单（含 CVE、包名、版本、修复版本、当前 VEX 状态、摘要）、配置安全基线检查项及证书有效期。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"cluster_id": map[string]any{"type": "string", "description": "集群 ID；在集群安全助手中可省略，默认当前集群"},
				"cve":        map[string]any{"type": "string", "description": "可选：只查看指定 CVE 编号或关键词"},
				"package":    map[string]any{"type": "string", "description": "可选：只查看指定软件包名"},
			},
		},
	}
}

func aiSecurityScanSummaryTool() aiToolDef {
	return aiToolDef{
		Name:        "security_scan_summary",
		Description: "查看全平台安全与漏洞中心的最新扫描总览：中间件本体 / OS 底层包 / 控制机运行环境的活跃风险统计、受影响集群与可升级修复包汇总。",
		Parameters:  map[string]any{"type": "object", "properties": map[string]any{}},
	}
}

func aiSecuritySearchFindingsTool() aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return aiToolDef{
		Name:        "security_search_findings",
		Description: "按条件检索全平台安全中心的漏洞记录（最多返回 30 条），包含漏洞摘要、版本对照、受影响集群和当前 VEX 状态。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"cve":        str("可选：CVE/漏洞编号关键词"),
				"package":    str("可选：软件包名关键词"),
				"cluster_id": str("可选：集群 ID"),
				"pkg_role":   map[string]any{"type": "string", "enum": []string{"primary", "dependency", "runtime"}, "description": "可选：primary（中间件本体）/ dependency（OS 底层包）/ runtime（控制机运行环境）"},
				"severity":   map[string]any{"type": "string", "enum": []string{"CRITICAL", "HIGH", "MEDIUM", "LOW"}, "description": "可选：严重等级"},
				"status":     map[string]any{"type": "string", "enum": []string{"active", "waived", "all"}, "description": "可选：active（活跃未处置，默认）/ waived（已缓解或豁免）/ all"},
			},
		},
	}
}

func aiProposeVexTool() aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return aiToolDef{
		Name:        "propose_vex_triage",
		Description: "生成一张可一键采纳的「VEX 漏洞处置提案卡片」（不会自动生效，需用户点击采纳后写入安全中心）。适用于给出单条或同包多条 CVE 的合规处置建议（计划修复 / 已缓解 / 不受影响 / 风险豁免）。先在回答里讲清分析依据，再调用本工具出卡片。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"cve":           str("单个 CVE/漏洞编号（如 CVE-2026-97205 或 UBUNTU-CVE-2026-97205）"),
				"cves":          map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "批量处置同一软件包的多条 CVE 时传入编号数组"},
				"package":       str("受影响的软件包名（如 nginx、openssl、systemd）"),
				"ecosystem":     str("软件包生态（如 Ubuntu:24.04:LTS、PyPI），可按扫描结果填写"),
				"cluster_id":    str("关联的集群 ID（在集群助手中可留空，自动使用当前集群）"),
				"global":        map[string]any{"type": "boolean", "description": "是否按全局 CVE 生效（true 表示覆盖全平台同名 CVE；false 默认仅按当前软件包+生态生效）"},
				"status":        map[string]any{"type": "string", "enum": []string{"planned", "mitigated", "not_affected", "accepted"}, "description": "处置状态：planned（计划修复）/ mitigated（已缓解）/ not_affected（不受影响）/ accepted（风险豁免）"},
				"justification": map[string]any{"type": "string", "enum": []string{"", "vulnerable_code_not_in_execute_path", "inline_mitigations_already_exist", "component_not_present"}, "description": "仅在 mitigated 或 not_affected 时填写 CycloneDX 标准判定依据，其他状态留空"},
				"expires_at":    str("仅在 accepted（风险豁免）时可选填写复审到期日，格式 YYYY-MM-DD"),
				"note":          str("可直接用于安全审计留痕的规范中文处置依据（60～200 字，忠于核实过的事实，切勿虚构）"),
				"reason":        str("给操作员看的一句话推荐理由（为什么建议采纳此处置）"),
			},
			"required": []string{"status", "note", "reason"},
		},
	}
}

func aiProposeBaselineWaiveTool() aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return aiToolDef{
		Name:        "propose_baseline_waive",
		Description: "生成一张可一键采纳的「配置安全基线豁免提案卡片」（需用户点击采纳后写入集群基线豁免记录）。仅在核实集群隔离条件或业务合理性、且不适合/暂不需要立即改配置时使用。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"cluster_id": str("目标集群 ID（在集群助手中可留空，自动使用当前集群）"),
				"check_id":   str("基线检查项 ID（来自 cluster_security_info 的 baseline_checks[].id）"),
				"title":      str("基线检查项名称（中文标题）"),
				"note":       str("可直接审计留痕的规范中文豁免理由（50～200 字）"),
				"reason":     str("给操作员看的一句话建议说明"),
			},
			"required": []string{"check_id", "note", "reason"},
		},
	}
}

func aiSuggestRehearsalTool() aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return aiToolDef{
		Name:        "suggest_security_rehearsal",
		Description: "当集群存在可通过软件包升级或配置加固解决的中高危安全风险时，生成一张「发起安全修复演练建议卡片」，用户点击后可直接跳转到对应集群的变更演练页发起无中断升级/加固演练。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"cluster_id": str("目标集群 ID（在集群助手中可留空，自动使用当前集群）"),
				"title":      str("演练标题，如「滚动升级 Nginx 修复高危 CVE」"),
				"packages":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "涉及升级的软件包列表"},
				"cves":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "计划通过本次演练消除的 CVE 编号"},
				"summary":    str("演练目标与关键验证要点（2～3 句话）"),
				"reason":     str("为什么建议采用变更演练修复"),
			},
			"required": []string{"title", "summary", "reason"},
		},
	}
}

// ---- Shared Security Tool Runners ----

func (s *storeServer) runClusterSecurityInfo(user, clusterID string, a map[string]any) string {
	str := func(k string) string { v, _ := a[k].(string); return strings.TrimSpace(v) }
	cid := firstNonEmptyStr(str("cluster_id"), clusterID)
	if cid == "" {
		return "请提供 cluster_id 参数。"
	}
	f, ok := s.clusterFactsFor(user, cid)
	if !ok {
		return "没有找到集群 " + cid + "，或当前账户无权查看。"
	}
	rep := s.auditClusterSecurity(user, f)
	cveQ := strings.ToLower(str("cve"))
	pkgQ := strings.ToLower(str("package"))

	type slimFinding struct {
		CVE              string   `json:"cve"`
		Package          string   `json:"package"`
		Ecosystem        string   `json:"ecosystem"`
		InstalledVersion string   `json:"installed_version"`
		FixedIn          []string `json:"fixed_in,omitempty"`
		PkgRole          string   `json:"pkg_role"`
		Severity         string   `json:"severity"`
		Score            float64  `json:"score,omitempty"`
		TriageStatus     string   `json:"triage_status"`
		TriageNote       string   `json:"triage_note,omitempty"`
		Waived           bool     `json:"waived,omitempty"`
		RepoFixVersion   string   `json:"repo_fix_version,omitempty"`
		Summary          string   `json:"summary,omitempty"`
	}
	var findings []slimFinding
	for _, fd := range rep.Findings {
		if cveQ != "" && !strings.Contains(strings.ToLower(fd.CVE), cveQ) && !strings.Contains(strings.ToLower(fd.ID), cveQ) {
			continue
		}
		if pkgQ != "" && !strings.Contains(strings.ToLower(fd.Package), pkgQ) {
			continue
		}
		if len(findings) >= 40 {
			break
		}
		findings = append(findings, slimFinding{
			CVE:              firstNonEmptyStr(fd.CVE, fd.ID),
			Package:          fd.Package,
			Ecosystem:        fd.Ecosystem,
			InstalledVersion: fd.InstalledVersion,
			FixedIn:          fd.FixedIn,
			PkgRole:          fd.PkgRole,
			Severity:         fd.Severity,
			Score:            fd.CVSSScore,
			TriageStatus:     fd.TriageStatus,
			TriageNote:       truncRunes(fd.TriageNote, 120),
			Waived:           fd.Waived,
			RepoFixVersion:   fd.RepoFixVersion,
			Summary:          truncRunes(fd.Summary, 240),
		})
	}
	payload := map[string]any{
		"cluster_id":          rep.ClusterID,
		"app":                 rep.AppName,
		"version":             rep.Version,
		"platform":            rep.Platform,
		"delivery_mode":       rep.DeliveryMode,
		"score":               rep.Score,
		"grade":               rep.Grade,
		"active_counts":       rep.ActiveCounts,
		"middleware_counts":   rep.MiddlewareCounts,
		"os_counts":           rep.OSCounts,
		"primary_active":      rep.PrimaryActive,
		"dependency_active":   rep.DependencyActive,
		"repo_fix_ready":      rep.RepoFixReadyCount,
		"total_findings":      len(rep.Findings),
		"matched_findings":    findings,
		"baseline_checks":     rep.BaselineChecks,
		"certs":               rep.Certs,
		"gate_middleware_only": rep.GateMiddlewareOnly,
	}
	b, _ := json.Marshal(payload)
	return string(b)
}

func (s *storeServer) runSecurityScanSummary(user string) string {
	secDBMu.Lock()
	meta := s.loadSecMeta()
	pol := s.loadSecPolicy()
	rawRep := s.loadLatestScan()
	secDBMu.Unlock()
	if rawRep == nil {
		return "当前尚未执行过安全扫描，请先在安全中心点击「立即扫描」。"
	}
	rep := s.scopedScanReport(rawRep, user)
	type topCluster struct {
		ClusterID string `json:"cluster_id"`
		App       string `json:"app"`
		Active    int    `json:"active"`
		Primary   int    `json:"primary"`
	}
	clMap := map[string]*topCluster{}
	for _, f := range rep.Findings {
		if f.Waived {
			continue
		}
		for _, cl := range f.Clusters {
			c, ok := clMap[cl.ClusterID]
			if !ok {
				c = &topCluster{ClusterID: cl.ClusterID, App: cl.AppName}
				clMap[cl.ClusterID] = c
			}
			c.Active++
			if f.PkgRole == "primary" {
				c.Primary++
			}
		}
	}
	clusters := make([]topCluster, 0, len(clMap))
	for _, c := range clMap {
		clusters = append(clusters, *c)
	}
	sort.Slice(clusters, func(i, j int) bool {
		if clusters[i].Primary != clusters[j].Primary {
			return clusters[i].Primary > clusters[j].Primary
		}
		return clusters[i].Active > clusters[j].Active
	})
	if len(clusters) > 15 {
		clusters = clusters[:15]
	}
	payload := map[string]any{
		"scanned_at":                   rep.ScannedAt,
		"advisory_count":               meta.AdvisoryCount,
		"gate_middleware_only":         pol.GateMiddlewareOnly,
		"active_counts":                rep.ActiveCounts,
		"middleware_counts":            rep.MiddlewareCounts,
		"os_counts":                    rep.OSCounts,
		"runtime_counts":               rep.RuntimeCounts,
		"affected_clusters":            rep.AffectedClusters,
		"middleware_affected_clusters": rep.MiddlewareAffectedClusters,
		"os_affected_clusters":         rep.OSAffectedClusters,
		"top_clusters":                 clusters,
	}
	b, _ := json.Marshal(payload)
	return string(b)
}

func (s *storeServer) runSecuritySearchFindings(user string, a map[string]any) string {
	str := func(k string) string { v, _ := a[k].(string); return strings.TrimSpace(v) }
	secDBMu.Lock()
	rawRep := s.loadLatestScan()
	secDBMu.Unlock()
	if rawRep == nil {
		return "当前尚未执行过安全扫描。"
	}
	rep := s.scopedScanReport(rawRep, user)
	cveQ := strings.ToLower(str("cve"))
	pkgQ := strings.ToLower(str("package"))
	cidQ := strings.ToLower(str("cluster_id"))
	roleQ := strings.ToLower(str("pkg_role"))
	sevQ := strings.ToUpper(str("severity"))
	stQ := strings.ToLower(firstNonEmptyStr(str("status"), "active"))

	type hit struct {
		CVE              string   `json:"cve"`
		Package          string   `json:"package"`
		Ecosystem        string   `json:"ecosystem"`
		InstalledVersion string   `json:"installed_version"`
		FixedIn          []string `json:"fixed_in,omitempty"`
		PkgRole          string   `json:"pkg_role"`
		Severity         string   `json:"severity"`
		Score            float64  `json:"score,omitempty"`
		TriageStatus     string   `json:"triage_status"`
		Waived           bool     `json:"waived,omitempty"`
		RepoFixVersion   string   `json:"repo_fix_version,omitempty"`
		Clusters         []string `json:"clusters,omitempty"`
		Summary          string   `json:"summary,omitempty"`
	}
	var out []hit
	total := 0
	for _, f := range rep.Findings {
		if stQ == "active" && f.Waived {
			continue
		}
		if stQ == "waived" && !f.Waived {
			continue
		}
		if cveQ != "" && !strings.Contains(strings.ToLower(f.CVE), cveQ) && !strings.Contains(strings.ToLower(f.ID), cveQ) {
			continue
		}
		if pkgQ != "" && !strings.Contains(strings.ToLower(f.Package), pkgQ) {
			continue
		}
		if roleQ != "" && strings.ToLower(f.PkgRole) != roleQ {
			continue
		}
		if sevQ != "" && strings.ToUpper(f.Severity) != sevQ {
			continue
		}
		if cidQ != "" {
			match := false
			for _, cl := range f.Clusters {
				if strings.ToLower(cl.ClusterID) == cidQ {
					match = true
					break
				}
			}
			if !match {
				continue
			}
		}
		total++
		if len(out) >= 30 {
			continue
		}
		var cls []string
		for _, cl := range f.Clusters {
			cls = append(cls, cl.ClusterID)
		}
		out = append(out, hit{
			CVE:              firstNonEmptyStr(f.CVE, f.ID),
			Package:          f.Package,
			Ecosystem:        f.Ecosystem,
			InstalledVersion: f.InstalledVersion,
			FixedIn:          f.FixedIn,
			PkgRole:          f.PkgRole,
			Severity:         f.Severity,
			Score:            f.CVSSScore,
			TriageStatus:     f.TriageStatus,
			Waived:           f.Waived,
			RepoFixVersion:   f.RepoFixVersion,
			Clusters:         cls,
			Summary:          truncRunes(f.Summary, 220),
		})
	}
	b, _ := json.Marshal(map[string]any{"total": total, "shown": len(out), "findings": out})
	return string(b)
}

func (s *storeServer) createVexProposal(propPath, session, defaultCluster string, a map[string]any, proposed *[]string) string {
	str := func(k string) string { v, _ := a[k].(string); return strings.TrimSpace(v) }
	status := strings.ToLower(str("status"))
	validStatus := map[string]bool{"planned": true, "mitigated": true, "not_affected": true, "accepted": true}
	if !validStatus[status] {
		return "提案没有通过校验：status 必须是 planned、mitigated、not_affected 或 accepted。"
	}
	note := truncRunes(str("note"), 500)
	reason := truncRunes(str("reason"), 300)
	if note == "" || reason == "" {
		return "提案没有通过校验：note（合规处置说明）和 reason（推荐理由）均为必填。"
	}
	expiresAt := str("expires_at")
	if expiresAt != "" {
		if _, err := time.Parse("2006-01-02", expiresAt); err != nil {
			return "提案没有通过校验：expires_at 日期格式必须为 YYYY-MM-DD。"
		}
	}
	just := str("justification")
	if just != "" && just != "vulnerable_code_not_in_execute_path" && just != "inline_mitigations_already_exist" && just != "component_not_present" {
		just = ""
	}
	if status != "mitigated" && status != "not_affected" {
		just = ""
	}

	var cves []string
	seen := map[string]bool{}
	addCVE := func(x string) {
		x = strings.ToUpper(strings.TrimSpace(x))
		if x != "" && !seen[x] {
			seen[x] = true
			cves = append(cves, x)
		}
	}
	if arr, ok := a["cves"].([]any); ok {
		for _, item := range arr {
			if sv, ok := item.(string); ok {
				addCVE(sv)
			}
		}
	}
	addCVE(str("cve"))
	if len(cves) == 0 {
		return "提案没有通过校验：请至少提供一个漏洞编号（cve 或 cves）。"
	}

	pkg := str("package")
	eco := str("ecosystem")
	global, _ := a["global"].(bool)
	cid := firstNonEmptyStr(str("cluster_id"), defaultCluster)
	if global {
		cid = ""
	}
	// Resolve missing package/ecosystem from latest scan so the card is complete.
	if !global && (pkg == "" || eco == "") {
		secDBMu.Lock()
		rawRep := s.loadLatestScan()
		secDBMu.Unlock()
		if rawRep != nil {
			for _, f := range rawRep.Findings {
				if strings.EqualFold(f.CVE, cves[0]) || strings.EqualFold(f.ID, cves[0]) {
					if pkg == "" || strings.EqualFold(f.Package, pkg) {
						pkg = firstNonEmptyStr(pkg, f.Package)
						eco = firstNonEmptyStr(eco, f.Ecosystem)
						break
					}
				}
			}
		}
	}

	spec := &aiVexSpec{
		CVE:           cves[0],
		CVEs:          cves,
		Package:       pkg,
		Ecosystem:     eco,
		ClusterID:     cid,
		Global:        global,
		Status:        status,
		Justification: just,
		ExpiresAt:     expiresAt,
		Note:          note,
	}
	title := cves[0]
	if len(cves) > 1 {
		title = fmt.Sprintf("%s 等 %d 项漏洞", cves[0], len(cves))
	}
	p := aiProposal{
		ID:      randomStoreToken(6),
		Kind:    "vex",
		Session: session,
		Status:  "pending",
		Step:    aiStepSpec{Title: "VEX 处置：" + title},
		Reason:  reason,
		Vex:     spec,
		At:      time.Now().UTC().Format(time.RFC3339),
	}

	aiMu.Lock()
	defer aiMu.Unlock()
	all := loadProposalsAt(propPath)
	for _, x := range all {
		if x.Session == session && x.Kind == "vex" && x.Status == "pending" && x.Vex != nil &&
			x.Vex.CVE == spec.CVE && x.Vex.Status == spec.Status && x.Vex.Note == spec.Note && len(x.Vex.CVEs) == len(spec.CVEs) {
			return "相同的 VEX 处置提案卡片已经生成（#" + x.ID + "），等待用户在卡片上采纳或调整。"
		}
	}
	all = append(all, p)
	if err := writeJSONFile(propPath, all); err != nil {
		return "VEX 提案无法保存"
	}
	*proposed = append(*proposed, p.ID)
	return "VEX 处置提案卡片 #" + p.ID + " 已生成并展示给用户（尚未生效）。请简短提示用户可在下方卡片直接点「采纳并写入 VEX」，或在表单微调、或拒绝后告诉你调整要求。"
}

func (s *storeServer) createBaselineWaiveProposal(propPath, session, defaultCluster string, a map[string]any, proposed *[]string) string {
	str := func(k string) string { v, _ := a[k].(string); return strings.TrimSpace(v) }
	cid := firstNonEmptyStr(str("cluster_id"), defaultCluster)
	chk := str("check_id")
	title := firstNonEmptyStr(str("title"), chk)
	note := truncRunes(str("note"), 300)
	reason := truncRunes(str("reason"), 300)
	if cid == "" || chk == "" || note == "" || reason == "" {
		return "提案没有通过校验：cluster_id、check_id、note 和 reason 均为必填。"
	}
	spec := &aiBaselineSpec{
		ClusterID: cid,
		CheckID:   chk,
		Title:     title,
		Note:      note,
	}
	p := aiProposal{
		ID:       randomStoreToken(6),
		Kind:     "baseline_waive",
		Session:  session,
		Status:   "pending",
		Step:     aiStepSpec{Title: "基线豁免：" + title},
		Reason:   reason,
		Baseline: spec,
		At:       time.Now().UTC().Format(time.RFC3339),
	}
	aiMu.Lock()
	defer aiMu.Unlock()
	all := loadProposalsAt(propPath)
	for _, x := range all {
		if x.Session == session && x.Kind == "baseline_waive" && x.Status == "pending" && x.Baseline != nil &&
			x.Baseline.ClusterID == cid && x.Baseline.CheckID == chk && x.Baseline.Note == note {
			return "相同的配置基线豁免提案已存在（#" + x.ID + "），等待用户决定。"
		}
	}
	all = append(all, p)
	if err := writeJSONFile(propPath, all); err != nil {
		return "基线豁免提案无法保存"
	}
	*proposed = append(*proposed, p.ID)
	return "配置基线豁免提案卡片 #" + p.ID + " 已生成，等待用户点击采纳后写入。"
}

func (s *storeServer) createRehearsalProposal(propPath, session, user, defaultCluster, defaultJobID string, a map[string]any, proposed *[]string, forceSecurity bool) string {
	spec, errMsg := s.buildRehearsalSpec(user, defaultCluster, defaultJobID, a, forceSecurity)
	if errMsg != "" {
		return "提案没有通过校验：" + errMsg
	}
	p := aiProposal{
		ID:        randomStoreToken(6),
		Kind:      "rehearsal",
		Session:   session,
		Status:    "pending",
		Step:      aiStepSpec{Title: spec.Title},
		Reason:    firstNonEmptyStr(spec.Reason, spec.Summary),
		Rehearsal: spec,
		At:        time.Now().UTC().Format(time.RFC3339),
	}
	aiMu.Lock()
	defer aiMu.Unlock()
	all := loadProposalsAt(propPath)
	for _, x := range all {
		if x.Session == session && x.Kind == "rehearsal" && x.Status == "pending" && x.Rehearsal != nil &&
			x.Rehearsal.ClusterID == spec.ClusterID && x.Rehearsal.Title == spec.Title {
			return "该变更演练卡片已存在（#" + x.ID + "）。"
		}
	}
	all = append(all, p)
	if err := writeJSONFile(propPath, all); err != nil {
		return "演练建议卡片无法保存"
	}
	*proposed = append(*proposed, p.ID)
	return "变更演练发起卡片 #" + p.ID + " 已生成（目标集群：" + spec.ClusterID + "），用户点击卡片按钮即可直接带入演练目标前往该集群的「变更演练」工作台。"
}

func loadProposalsAt(path string) []aiProposal {
	out := []aiProposal{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

// ---- Global Security Center AI Assistant Endpoints (/api/security/ai/*) ----

func (s *storeServer) secAIDir() string {
	return filepath.Join(s.secDir(), "ai")
}

func (s *storeServer) secAIProposalsPath() string {
	return filepath.Join(s.secAIDir(), "proposals.json")
}

func secRunKey(key string) string { return "__security__/" + sessionID(key) }

func (s *storeServer) secAIRunning(key string) (bool, string) {
	v, ok := aiRuns.Load(secRunKey(key))
	if !ok {
		return false, ""
	}
	return true, v.(aiRun).started.UTC().Format(time.RFC3339Nano)
}

func (s *storeServer) secAILoadSession(key string) aiSession {
	ss := aiSession{ID: sessionID(key), Key: key, Kind: "security", Messages: []aiMsg{}}
	if b, err := os.ReadFile(filepath.Join(s.secAIDir(), "sessions", ss.ID+".json")); err == nil {
		_ = json.Unmarshal(b, &ss)
	}
	ss.Kind = "security"
	if ss.Messages == nil {
		ss.Messages = []aiMsg{}
	}
	return ss
}

func (s *storeServer) secAISaveSession(ss aiSession) error {
	ss.Updated = time.Now().UTC().Format(time.RFC3339)
	return writeJSONFile(filepath.Join(s.secAIDir(), "sessions", ss.ID+".json"), ss)
}

func (s *storeServer) handleSecurityAI(w http.ResponseWriter, r *http.Request, session storeSession, parts []string) {
	if !s.need(w, session.User, "security.view") {
		return
	}
	switch {
	case len(parts) == 1 && parts[0] == "sessions" && r.Method == "GET":
		out := []aiSession{}
		files, _ := filepath.Glob(filepath.Join(s.secAIDir(), "sessions", "*.json"))
		for _, f := range files {
			var ss aiSession
			if b, err := os.ReadFile(f); err == nil && json.Unmarshal(b, &ss) == nil {
				ss.Messages = nil
				ss.Running, ss.RunningSince = s.secAIRunning(ss.Key)
				out = append(out, ss)
			}
		}
		sort.Slice(out, func(i, k int) bool { return out[i].Updated > out[k].Updated })
		s.writeJSON(w, 200, map[string]any{"sessions": out, "status": s.aiStatus()})

	case len(parts) == 1 && parts[0] == "session" && (r.Method == "GET" || r.Method == "DELETE"):
		key := r.URL.Query().Get("key")
		if !reSessionKey.MatchString(key) || !strings.HasPrefix(key, "sec") {
			s.fail(w, 400, "这段对话不存在，或已过期")
			return
		}
		if r.Method == "DELETE" {
			_ = os.Remove(filepath.Join(s.secAIDir(), "sessions", sessionID(key)+".json"))
			s.writeJSON(w, 200, map[string]bool{"ok": true})
			return
		}
		ss := s.secAILoadSession(key)
		ss.Running, ss.RunningSince = s.secAIRunning(key)
		s.writeJSON(w, 200, ss)

	case len(parts) == 1 && parts[0] == "stop" && r.Method == "POST":
		var in struct {
			Key string `json:"key"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&in) != nil || !reSessionKey.MatchString(in.Key) {
			s.fail(w, 400, "这段对话不存在，或已过期")
			return
		}
		if c, ok := aiRuns.Load(secRunKey(in.Key)); ok {
			c.(aiRun).cancel()
		}
		s.writeJSON(w, 200, map[string]bool{"ok": true})

	case len(parts) == 2 && parts[0] == "img" && r.Method == "GET":
		name := filepath.Base(parts[1])
		b, err := os.ReadFile(filepath.Join(s.secAIDir(), "img", name))
		if err != nil {
			s.fail(w, 404, "图片不存在")
			return
		}
		w.Header().Set("Content-Type", http.DetectContentType(b))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(b)

	case len(parts) >= 1 && parts[0] == "proposals":
		s.handleSecurityAIProposals(w, r, session, parts[1:])

	case len(parts) == 1 && parts[0] == "chat" && r.Method == "POST":
		s.handleSecurityAIChat(w, r, session)

	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) handleSecurityAIProposals(w http.ResponseWriter, r *http.Request, user storeSession, parts []string) {
	propPath := s.secAIProposalsPath()
	switch {
	case len(parts) == 0 && r.Method == "GET":
		s.writeJSON(w, 200, map[string]any{"proposals": loadProposalsAt(propPath)})
	case len(parts) == 2 && r.Method == "POST" && (parts[1] == "accept" || parts[1] == "reject"):
		aiMu.Lock()
		all := loadProposalsAt(propPath)
		idx := -1
		for i := range all {
			if all[i].ID == parts[0] {
				idx = i
				break
			}
		}
		if idx < 0 || all[idx].Status != "pending" {
			aiMu.Unlock()
			s.fail(w, 409, "提案不存在，或已经处理过")
			return
		}
		p := all[idx]
		if parts[1] == "accept" && (p.Kind == "vex" || p.Kind == "baseline_waive") {
			if !s.accessOf(user.User).can("security.manage") {
				aiMu.Unlock()
				s.need(w, user.User, "security.manage")
				return
			}
		}
		nowStr := time.Now().UTC().Format(time.RFC3339)
		if parts[1] == "accept" {
			switch p.Kind {
			case "vex":
				if err := s.applyVexProposal(r, user.User, p.Vex); err != nil {
					aiMu.Unlock()
					s.fail(w, 409, err.Error())
					return
				}
			case "baseline_waive":
				if err := s.applyBaselineWaiveProposal(r, user.User, p.Baseline); err != nil {
					aiMu.Unlock()
					s.fail(w, 409, err.Error())
					return
				}
			case "rehearsal":
				// marks accepted; UI navigates to cluster rehearsal
			default:
				aiMu.Unlock()
				s.fail(w, 409, "不支持的安全提案类型")
				return
			}
			p.Status = "accepted"
		} else {
			p.Status = "rejected"
		}
		p.DecidedBy, p.DecidedAt = user.User, nowStr
		all[idx] = p
		err := writeJSONFile(propPath, all)
		aiMu.Unlock()
		if err != nil {
			s.fail(w, 500, "无法保存")
			return
		}
		s.auditReq(r, "security-ai-proposal-"+parts[1], user.User, p.ID)
		s.writeJSON(w, 200, p)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) handleSecurityAIChat(w http.ResponseWriter, r *http.Request, user storeSession) {
	if code, msg := s.checkAIFeature(user.User, "security"); code != 0 {
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
	if !reSessionKey.MatchString(in.Key) || !strings.HasPrefix(in.Key, "sec") || (in.Message == "" && len(in.Images) == 0) || len([]rune(in.Message)) > 20000 || len(in.Images) > 3 {
		s.fail(w, 400, "请输入内容（最多 3 张图片）")
		return
	}
	st := s.aiLoad()
	providers := s.aiProvidersForUser(st, user.User, "security", in.Model)
	if len(providers) == 0 {
		s.fail(w, 409, "「安全 AI」未配置可用模型，请管理员在平台设置 → AI 中配置模型")
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
		name, err := s.aiStoreImageIn(s.secAIDir(), d)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		imgNames = append(imgNames, name)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 15*time.Minute)
	defer cancel()
	if _, busy := aiRuns.LoadOrStore(secRunKey(in.Key), aiRun{cancel, time.Now()}); busy {
		s.fail(w, 409, "这段对话还在回答上一个问题，请等它结束，或先停止")
		return
	}
	defer aiRuns.Delete(secRunKey(in.Key))

	ss := s.secAILoadSession(in.Key)
	if len(in.Step) > 0 {
		ss.Step = in.Step
	}
	if ss.Title == "" {
		if t, _ := in.Step["title"].(string); t != "" {
			ss.Title = truncRunes(t, 80)
		} else if cve, _ := in.Step["cve"].(string); cve != "" {
			ss.Title = "安全研判：" + truncRunes(cve, 60)
		} else if in.Message != "" {
			ss.Title = truncRunes(strings.Join(strings.Fields(in.Message), " "), 36)
		} else {
			ss.Title = "安全对话"
		}
	}
	nowStr := time.Now().UTC().Format(time.RFC3339)
	ss.Messages = appendOrReuseUserTurn(ss.Messages, in.Retry, aiMsg{Role: "user", Text: in.Message, Images: imgNames, At: nowStr, By: user.User})
	if err := s.secAISaveSession(ss); err != nil {
		s.fail(w, 500, "对话无法保存")
		return
	}
	s.auditReq(r, "security-ai-chat", user.User, ss.Key)

	fl, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ev := sse{w, fl}

	var red *aiRedactor
	if st.RedactHosts {
		red = newAIRedactor(nil)
	}
	system := aiSystemSecurityGlobal
	var final aiReply
	var used, proposed []string
	var lastErr error
	var tried aiProvider
	var failedAttempts []aiAttemptDiag

	for i, p := range providers {
		tried = p
		start := time.Now()
		var made []string
		in.Options.User = user.User
		in.Options.Made = &producedFiles{}

		ext := s.extFor("security", in.Options)
		turnCtx := ext.bindCtx(effortCtx(ctx, in.Options), ev)
		tools := []aiToolDef{
			aiSecurityScanSummaryTool(),
			aiSecuritySearchFindingsTool(),
			aiClusterSecurityInfoTool(),
			aiProposeVexTool(),
			aiProposeBaselineWaiveTool(),
			aiSuggestRehearsalTool(),
		}
		tools = append(tools, ext.tools...)
		sys := system + ext.prompt
		if c := stepContext(ss.Step); c != "" {
			sys += "\n\n" + c
		}
		prep := func(t string) string { return red.out(aiScrub(t)) }
		if p.Tools == "no" {
			tools = nil
			sys += "\n\n当前安全中心扫描概览：\n" + s.runSecurityScanSummary(user.User)
		}
		msgs := []aiMessage{{Role: "system", Content: prep(sys)}}
		for idxM, m := range ss.Messages {
			if isErrorOnlyMsg(m) {
				continue
			}
			if m.Role == "assistant" {
				msgs = append(msgs, aiMessage{Role: "assistant", Content: prep(m.Text + m.askText())})
				continue
			}
			text := prep(m.Text)
			if len(m.Images) > 0 && p.Vision != "no" && idxM >= len(ss.Messages)-3 {
				parts := []map[string]any{{"type": "text", "text": text}}
				for _, n := range m.Images {
					if b, err := os.ReadFile(filepath.Join(s.secAIDir(), "img", filepath.Base(n))); err == nil {
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
			case "security_scan_summary":
				return s.runSecurityScanSummary(user.User)
			case "security_search_findings":
				return s.runSecuritySearchFindings(user.User, a)
			case "cluster_security_info":
				return s.runClusterSecurityInfo(user.User, "", a)
			case "propose_vex_triage":
				return s.createVexProposal(s.secAIProposalsPath(), ss.Key, "", a, &made)
			case "propose_baseline_waive":
				return s.createBaselineWaiveProposal(s.secAIProposalsPath(), ss.Key, "", a, &made)
			case "propose_rehearsal":
				return s.createRehearsalProposal(s.secAIProposalsPath(), ss.Key, user.User, "", "", a, &made, false)
			case "suggest_security_rehearsal":
				return s.createRehearsalProposal(s.secAIProposalsPath(), ss.Key, user.User, "", "", a, &made, true)
			default:
				return "未知工具：" + name
			}
		}

		reply, tUsed, err := s.aiToolLoop(turnCtx, p, msgs, tools, red, ev, ext.wrap(runTool), &made)
		u := usageFrom(p, reply)
		u.User, u.IP, u.Feature, u.Target, u.Session, u.Tools = user.User, clientIP(r), "security", ss.Key, ss.ID, len(tUsed)
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
			final, used, proposed, lastErr = reply, tUsed, made, nil
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
		saved := s.secAISaveSession(ss) == nil
		errPayload := map[string]any{"t": "error", "v": errText, "saved": saved}
		if errDiag != nil {
			errPayload["diag"] = errDiag
		}
		ev.send(errPayload)
		return
	}
	ss.Messages = append(ss.Messages, aiMsg{Role: "assistant", Text: final.Text, Tools: used, Steps: final.Steps, MS: final.TotalMS, Proposals: proposed, Ask: final.Ask, Files: final.Files, At: time.Now().UTC().Format(time.RFC3339)})
	if err := s.secAISaveSession(ss); err != nil {
		ev.send(map[string]any{"t": "error", "v": "对话无法保存"})
		return
	}
	ev.send(map[string]any{"t": "done", "model": tried.Model, "in": final.In, "out": final.Out})
}

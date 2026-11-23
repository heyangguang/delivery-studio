package main

import (
	"fmt"
	"html"
	"sort"
	"strings"
	"time"
)

// Unified Security Report Exporter — builds a single normalized dataset from scan/cluster audit + template
// and renders corporate Word (.docx), multi-sheet Excel (.xlsx), or standalone offline HTML (.html).

type secRemediationItem struct {
	Priority string // P0 | P1 | P2
	Category string // 软件升级（源已有修复版） | 上游修复等待 | 配置安全加固 | TLS 证书续签
	Target   string
	Detail   string
	Action   string
	Status   string
}

type secExportDataset struct {
	Template       secReportTemplate
	Theme          docxTheme
	GeneratedAt    string
	GeneratedDate  string
	GeneratedBy    string
	ScopeName      string // "全平台" or cluster ID
	ScopeFilter    string // effective scope: active | all | primary | dependency | runtime
	IsCluster      bool
	ClusterAudit   *clusterSecurityReport
	Report         secScanReport
	Findings       []secFinding
	PackageGroups  []secPackageGroup
	Clusters       []secClusterSummary
	Remediations   []secRemediationItem
	ActiveCounts   secSeverityCounts
	TotalCounts    secSeverityCounts
	MWCounts       secSeverityCounts
	OSCounts       secSeverityCounts
	RuntimeCounts  secSeverityCounts
	WaivedCount    int
	IgnoredCount   int
	Title          string
	Subtitle       string
	OrgName        string
	Confidential   string
	HeaderText     string
	FooterText     string
	ConclusionNote string
}

func secSeverityRank(sev string) int {
	switch strings.ToUpper(strings.TrimSpace(sev)) {
	case "CRITICAL":
		return 4
	case "HIGH":
		return 3
	case "MEDIUM":
		return 2
	case "LOW":
		return 1
	default:
		return 0
	}
}

func secSeverityZH(sev string) string {
	switch strings.ToUpper(strings.TrimSpace(sev)) {
	case "CRITICAL":
		return "严重 (Critical)"
	case "HIGH":
		return "高危 (High)"
	case "MEDIUM":
		return "中危 (Medium)"
	case "LOW":
		return "低危 (Low)"
	default:
		return "未知"
	}
}

func secPkgRoleZH(role string) string {
	switch role {
	case "primary":
		return "中间件本体"
	case "runtime":
		return "运行环境"
	default:
		return "OS 底层包"
	}
}

func secTriageZH(status string) string {
	switch status {
	case "planned":
		return "已排期修复"
	case "mitigated":
		return "已缓解"
	case "not_affected":
		return "不适用"
	case "accepted":
		return "风险豁免"
	case "expired":
		return "豁免已过期"
	default:
		return "待处置"
	}
}

func secBaselineStatusZH(st string) string {
	switch st {
	case "pass":
		return "通过"
	case "fail":
		return "不合规"
	case "warn":
		return "建议加固"
	case "waived":
		return "已豁免"
	default:
		return st
	}
}

func secCertStatusZH(st string) string {
	switch st {
	case "ok":
		return "正常"
	case "expiring":
		return "即将到期"
	case "critical":
		return "临期告急"
	case "expired":
		return "已过期"
	default:
		return st
	}
}

func expandSecTemplateVars(raw string, ds *secExportDataset) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	clusterLabel := "全平台"
	if ds.IsCluster && ds.ClusterAudit != nil {
		clusterLabel = ds.ClusterAudit.ClusterID
	}
	return strings.NewReplacer(
		"{org}", ds.OrgName,
		"{cluster}", clusterLabel,
		"{scope}", ds.ScopeName,
		"{date}", ds.GeneratedDate,
		"{template}", ds.Template.Name,
	).Replace(raw)
}

func buildSecExportDataset(
	repPtr *secScanReport,
	clusterAudit *clusterSecurityReport,
	tpl secReportTemplate,
	user string,
	scopeOverride string,
	includeIgnoredOverride *bool,
	includeWaivedOverride *bool,
) secExportDataset {
	var rep secScanReport
	if repPtr != nil {
		rep = *repPtr
	}
	tpl = normalizeSecReportTemplate(tpl)
	effScope := tpl.Scope
	if scopeOverride != "" {
		switch strings.ToLower(strings.TrimSpace(scopeOverride)) {
		case "middleware", "primary":
			effScope = "primary"
		case "os", "dependency":
			effScope = "dependency"
		case "runtime":
			effScope = "runtime"
		case "all":
			effScope = "all"
		case "active":
			effScope = "active"
		}
	}
	incIgnored := tpl.IncludeIgnored || effScope == "all"
	if includeIgnoredOverride != nil {
		incIgnored = *includeIgnoredOverride
	}
	incWaived := tpl.IncludeWaived
	if includeWaivedOverride != nil {
		incWaived = *includeWaivedOverride
	}
	minRank := secSeverityRank(tpl.MinSeverity)

	srcFindings := rep.Findings
	if clusterAudit != nil {
		srcFindings = clusterAudit.Findings
	}

	filtered := make([]secFinding, 0, len(srcFindings))
	var act, tot, mw, osC, rt secSeverityCounts
	waivedN, ignoredN := 0, 0
	for _, f := range srcFindings {
		if f.GloballyIgnored {
			ignoredN++
			if !incIgnored {
				continue
			}
		}
		if f.Waived && !f.GloballyIgnored {
			waivedN++
			if !incWaived {
				continue
			}
		}
		if effScope == "primary" || effScope == "dependency" || effScope == "runtime" {
			if f.PkgRole != effScope {
				continue
			}
		}
		if minRank > 0 && secSeverityRank(f.Severity) < minRank {
			continue
		}
		filtered = append(filtered, f)
		addSeverityCount(&tot, f.Severity)
		if !f.Waived && !f.GloballyIgnored {
			addSeverityCount(&act, f.Severity)
			switch f.PkgRole {
			case "primary":
				addSeverityCount(&mw, f.Severity)
			case "runtime":
				addSeverityCount(&rt, f.Severity)
			default:
				addSeverityCount(&osC, f.Severity)
			}
		}
	}

	groups := buildPackageGroups(filtered)

	// Recompute affected cluster list for global reports matching filtered findings.
	var clusters []secClusterSummary
	if clusterAudit == nil {
		for _, cs := range rep.Clusters {
			switch effScope {
			case "primary":
				if cs.MiddlewareActive.Total == 0 {
					continue
				}
			case "dependency":
				if cs.OSActive.Total == 0 {
					continue
				}
			default:
				if cs.Active.Total == 0 {
					continue
				}
			}
			clusters = append(clusters, cs)
		}
	}

	nowStr := time.Now().Format("2006-01-02 15:04:05")
	dateStr := time.Now().Format("2006-01-02")
	scopeName := "全平台"
	if clusterAudit != nil {
		scopeName = fmt.Sprintf("集群 %s", clusterAudit.ClusterID)
	}

	ds := secExportDataset{
		Template:      tpl,
		Theme:         themeOf(tpl.Theme),
		GeneratedAt:   nowStr,
		GeneratedDate: dateStr,
		GeneratedBy:   firstNonEmptyStr(user, "system"),
		ScopeName:     scopeName,
		ScopeFilter:   effScope,
		IsCluster:     clusterAudit != nil,
		ClusterAudit:  clusterAudit,
		Report:        rep,
		Findings:      filtered,
		PackageGroups: groups,
		Clusters:      clusters,
		ActiveCounts:  act,
		TotalCounts:   tot,
		MWCounts:      mw,
		OSCounts:      osC,
		RuntimeCounts: rt,
		WaivedCount:   waivedN,
		IgnoredCount:  ignoredN,
		OrgName:       firstNonEmptyStr(tpl.OrgName, "Middleware Hub 安全运营中心"),
		Confidential:  firstNonEmptyStr(tpl.Confidential, "内部受控 / Internal"),
	}
	ds.Title = expandSecTemplateVars(firstNonEmptyStr(tpl.Title, "{scope}安全态势评估报告"), &ds)
	ds.Subtitle = expandSecTemplateVars(firstNonEmptyStr(tpl.Subtitle, "SBOM 漏洞评估与合规审计报告"), &ds)
	ds.HeaderText = expandSecTemplateVars(firstNonEmptyStr(tpl.HeaderText, "{org} · {scope}安全评估报告"), &ds)
	ds.FooterText = expandSecTemplateVars(firstNonEmptyStr(tpl.FooterText, "Middleware Hub 安全中心 · {date}"), &ds)
	ds.ConclusionNote = expandSecTemplateVars(tpl.ConclusionNote, &ds)
	ds.Remediations = buildSecRemediationPlan(&ds)
	return ds
}

func buildSecRemediationPlan(ds *secExportDataset) []secRemediationItem {
	var items []secRemediationItem
	for _, g := range ds.PackageGroups {
		if g.ActiveCount == 0 || g.GloballyIgnored {
			continue
		}
		prio := "P2"
		switch strings.ToUpper(g.MaxSeverity) {
		case "CRITICAL":
			prio = "P0"
		case "HIGH":
			prio = "P1"
		}
		clsNames := make([]string, 0, len(g.Clusters))
		for _, c := range g.Clusters {
			clsNames = append(clsNames, c.ClusterID)
		}
		target := fmt.Sprintf("%s %s (%s)", g.Package, g.InstalledVersion, firstNonEmptyStr(g.PlatformTitle, g.Ecosystem))
		if len(clsNames) > 0 {
			target += " · 影响 " + strings.Join(clsNames, ", ")
		}
		if g.RepoFixVersion != "" {
			items = append(items, secRemediationItem{
				Priority: prio,
				Category: "软件升级（源已有修复版）",
				Target:   target,
				Detail:   fmt.Sprintf("命中 %d 条活跃漏洞（最高 %s），代表 CVE：%s", g.ActiveCount, g.MaxSeverity, strings.Join(firstNStrings(g.CVEs, 3), ", ")),
				Action:   fmt.Sprintf("软件库已同步修复版本 %s，建议发起变更演练并在沙箱验证后滚动升级。", g.RepoFixVersion),
				Status:   "可立即演练升级",
			})
		} else if g.RecommendedFix != "" {
			items = append(items, secRemediationItem{
				Priority: prio,
				Category: "上游修复包同步",
				Target:   target,
				Detail:   fmt.Sprintf("命中 %d 条活跃漏洞（最高 %s），代表 CVE：%s", g.ActiveCount, g.MaxSeverity, strings.Join(firstNStrings(g.CVEs, 3), ", ")),
				Action:   fmt.Sprintf("上游已发布修复版本 %s，请先在软件库同步新版本离线包后再安排升级演练。", g.RecommendedFix),
				Status:   "需先同步离线包",
			})
		} else {
			items = append(items, secRemediationItem{
				Priority: prio,
				Category: "配置加固 / 风险评估",
				Target:   target,
				Detail:   fmt.Sprintf("命中 %d 条活跃漏洞（最高 %s），上游暂无修复版本。", g.ActiveCount, g.MaxSeverity),
				Action:   "建议通过只读探针核实受影响模块是否启用，实施配置隔离加固或在安全中心完成 VEX 评估记录。",
				Status:   "待评估 / 配置规避",
			})
		}
	}

	if ds.ClusterAudit != nil {
		for _, ck := range ds.ClusterAudit.BaselineChecks {
			if ck.Status != "fail" && ck.Status != "warn" {
				continue
			}
			prio := "P2"
			if strings.ToUpper(ck.Severity) == "CRITICAL" {
				prio = "P0"
			} else if strings.ToUpper(ck.Severity) == "HIGH" || ck.Status == "fail" {
				prio = "P1"
			}
			items = append(items, secRemediationItem{
				Priority: prio,
				Category: "配置安全基线加固",
				Target:   fmt.Sprintf("%s (%s)", ck.Title, firstNonEmptyStr(ck.Target, ds.ClusterAudit.ClusterID)),
				Detail:   ck.Detail,
				Action:   firstNonEmptyStr(ck.Recommendation, "按基线要求调整集群配置并通过变更演练验证。"),
				Status:   secBaselineStatusZH(ck.Status),
			})
		}
		for _, c := range ds.ClusterAudit.Certs {
			if c.Status == "ok" {
				continue
			}
			prio := "P1"
			if c.Status == "expired" || c.Status == "critical" {
				prio = "P0"
			}
			items = append(items, secRemediationItem{
				Priority: prio,
				Category: "TLS 证书轮换",
				Target:   fmt.Sprintf("%s / %s (%s)", c.Instance, c.Role, c.Subject),
				Detail:   fmt.Sprintf("证书到期日 %s（剩余 %d 天），当前状态：%s", c.NotAfter, c.DaysLeft, secCertStatusZH(c.Status)),
				Action:   "请尽快准备新签发证书并通过变更演练完成热轮换，避免业务连接中断。",
				Status:   secCertStatusZH(c.Status),
			})
		}
	}

	prioRank := map[string]int{"P0": 0, "P1": 1, "P2": 2}
	sort.SliceStable(items, func(i, j int) bool {
		return prioRank[items[i].Priority] < prioRank[items[j].Priority]
	})
	return items
}

func firstNStrings(xs []string, n int) []string {
	if len(xs) <= n {
		return xs
	}
	return xs[:n]
}

func formatSecDisplayTime(raw, fallback string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return fallback
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if tm, err := time.Parse(layout, s); err == nil {
			return tm.Local().Format("2006-01-02 15:04:05")
		}
	}
	return s
}

func formatSeveritySummaryZH(c secSeverityCounts) string {
	base := fmt.Sprintf("严重 %d / 高危 %d / 中危 %d / 低危 %d", c.Critical, c.High, c.Medium, c.Low)
	if c.Unknown > 0 {
		base += fmt.Sprintf(" / 未知 %d", c.Unknown)
	}
	return base
}

// =========================================================================
// 1. Word (.docx) Renderer — reuses corporate docxWriter / docxFileDual
// =========================================================================

func renderSecurityDocx(ds secExportDataset) ([]byte, error) {
	th := ds.Theme
	sec := ds.Template.Sections

	body := newDocxWriter(th, "rIdSB")

	// Chapter: Executive Summary
	if sec.ExecutiveSummary {
		body.heading(1, "安全态势综合概览")
		if ds.IsCluster && ds.ClusterAudit != nil {
			ca := ds.ClusterAudit
			body.tableWithWidths(
				[]string{"评估维度", "当前结果", "说明"},
				[][]string{
					{"目标集群", ca.ClusterID, fmt.Sprintf("%s %s（%s · %d 节点）", ca.AppName, ca.Version, ca.Platform, len(ca.Hosts))},
					{"安全综合评分", fmt.Sprintf("**%d 分（%s 级）**", ca.Score, ca.Grade), fmt.Sprintf("配置基线通过 %d / %d 项；临期/过期证书 %d 张", ca.BaselinePassed, ca.BaselineTotal, ca.CertExpiring)},
					{"未豁免活跃漏洞", fmt.Sprintf("共 %d 条", ds.ActiveCounts.Total), fmt.Sprintf("严重 %d · 高危 %d · 中危 %d · 低危 %d", ds.ActiveCounts.Critical, ds.ActiveCounts.High, ds.ActiveCounts.Medium, ds.ActiveCounts.Low)},
					{"风险来源分层", fmt.Sprintf("中间件 %d / OS %d", ds.MWCounts.Total, ds.OSCounts.Total), fmt.Sprintf("中间件（严 %d / 高 %d） · OS 底层包（严 %d / 高 %d）", ds.MWCounts.Critical, ds.MWCounts.High, ds.OSCounts.Critical, ds.OSCounts.High)},
					{"统计口径与模板", ds.Template.Name, fmt.Sprintf("最低等级：%s · 包含豁免：%v · 扫描时间：%s", ds.Template.MinSeverity, ds.Template.IncludeWaived, firstNonEmptyStr(ca.ScannedAt, ds.GeneratedAt))},
				},
				[]int{2100, 2300, docxBodyWidth - 4400},
				0,
				true,
			)
			if len(ca.Deductions) > 0 {
				body.heading(2, "评分扣分明细")
				drows := make([][]string, 0, len(ca.Deductions))
				for _, d := range ca.Deductions {
					drows = append(drows, []string{d.Reason, fmt.Sprintf("-%d 分", d.Points)})
				}
				body.tableWithWidths([]string{"扣分项", "扣分"}, drows, []int{docxBodyWidth - 1500, 1500}, -1, true)
			}
		} else {
			body.tableWithWidths(
				[]string{"评估指标", "统计值", "明细说明"},
				[][]string{
					{"漏洞库规模", fmt.Sprintf("%d 条公告", ds.Report.DBAdvisoryCount), fmt.Sprintf("最近同步：%s · 最近扫描：%s", firstNonEmptyStr(ds.Report.DBUpdatedAt, "—"), firstNonEmptyStr(ds.Report.ScannedAt, ds.GeneratedAt))},
					{"盘点资产 (SBOM)", fmt.Sprintf("%d 个软件包", ds.Report.SBOMPackageCount), fmt.Sprintf("离线闭包 %d · 运行环境 %d · 纳管集群 %d", ds.Report.ClosureCount, ds.Report.RuntimeCount, ds.Report.ClusterCount)},
					{"未豁免活跃风险", fmt.Sprintf("共 %d 条", ds.ActiveCounts.Total), fmt.Sprintf("严重 %d · 高危 %d · 中危 %d · 低危 %d（已豁免/缓解 %d 条）", ds.ActiveCounts.Critical, ds.ActiveCounts.High, ds.ActiveCounts.Medium, ds.ActiveCounts.Low, ds.WaivedCount)},
					{"风险来源分层", fmt.Sprintf("中间件 %d / OS %d", ds.MWCounts.Total, ds.OSCounts.Total), fmt.Sprintf("中间件本体（严 %d / 高 %d） · OS 底层包（严 %d / 高 %d） · 运行环境 %d", ds.MWCounts.Critical, ds.MWCounts.High, ds.OSCounts.Critical, ds.OSCounts.High, ds.RuntimeCounts.Total)},
					{"受影响生产集群", fmt.Sprintf("%d 个集群", len(ds.Clusters)), fmt.Sprintf("中间件本体受影响 %d 个 · OS 底层包受影响 %d 个", ds.Report.MiddlewareAffectedClusters, ds.Report.OSAffectedClusters)},
				},
				[]int{2100, 2100, docxBodyWidth - 4200},
				0,
				true,
			)
		}

		if ds.ActiveCounts.Critical > 0 {
			body.note(fmt.Sprintf("风险提示：当前报告范围内存在 %d 条未处置严重（Critical）漏洞及 %d 条高危（High）漏洞，请优先核查修复包清单并安排变更演练。", ds.ActiveCounts.Critical, ds.ActiveCounts.High))
		} else if ds.ActiveCounts.High > 0 {
			body.note(fmt.Sprintf("态势说明：当前无未处置严重漏洞，存在 %d 条高危（High）漏洞，建议按运维排期逐步推进升级加固。", ds.ActiveCounts.High))
		} else {
			body.note("态势良好：当前筛选范围内未检出未处置的严重或高危安全漏洞。")
		}
	}

	// Chapter: Affected Clusters
	if sec.AffectedClusters {
		if ds.IsCluster && ds.ClusterAudit != nil {
			body.heading(1, "集群资产与节点信息")
			ca := ds.ClusterAudit
			body.tableWithWidths(
				[]string{"属性", "配置详情"},
				[][]string{
					{"集群标识", ca.ClusterID},
					{"中间件组件", fmt.Sprintf("%s %s", ca.AppName, ca.Version)},
					{"目标操作系统", ca.Platform},
					{"交付模式", firstNonEmptyStr(ca.DeliveryMode, "standard")},
					{"纳管主机节点", strings.Join(ca.Hosts, "；")},
				},
				[]int{2200, docxBodyWidth - 2200},
				0,
				true,
			)
		} else {
			body.heading(1, "受影响生产集群一览")
			if len(ds.Clusters) == 0 {
				body.note("当前筛选条件下暂无存在活跃风险的生产集群。")
			} else {
				rows := make([][]string, 0, len(ds.Clusters))
				for _, cs := range ds.Clusters {
					rows = append(rows, []string{
						cs.ClusterID,
						fmt.Sprintf("%s %s", cs.AppName, cs.Version),
						cs.Platform,
						fmt.Sprintf("%d", len(cs.Hosts)),
						fmt.Sprintf("%d / %d / %d", cs.MiddlewareActive.Critical, cs.MiddlewareActive.High, cs.MiddlewareActive.Total),
						fmt.Sprintf("%d / %d / %d", cs.OSActive.Critical, cs.OSActive.High, cs.OSActive.Total),
						firstNonEmptyStr(cs.Owner, "—"),
					})
				}
				body.table(
					[]string{"集群标识", "应用版本", "操作系统", "节点", "中间件(严/高/总)", "OS包(严/高/总)", "负责人"},
					rows,
				)
			}
		}
	}

	// Chapter: Package Groups
	if sec.PackageGroups {
		body.heading(1, "按修复包聚合的升级清单")
		if len(ds.PackageGroups) == 0 {
			body.note("当前筛选条件下无待处理软件包。")
		} else {
			rows := make([][]string, 0, len(ds.PackageGroups))
			for _, g := range ds.PackageGroups {
				fix := firstNonEmptyStr(g.RepoFixVersion, g.RecommendedFix, "待上游发布")
				if g.RepoFixVersion != "" {
					fix = g.RepoFixVersion + " (源就绪)"
				}
				cls := make([]string, 0, len(g.Clusters))
				for _, c := range g.Clusters {
					cls = append(cls, c.ClusterID)
				}
				rows = append(rows, []string{
					g.Package,
					secPkgRoleZH(g.PkgRole),
					g.InstalledVersion,
					fix,
					g.MaxSeverity,
					fmt.Sprintf("%d / %d", g.ActiveCount, g.TotalCount),
					firstNonEmptyStr(strings.Join(cls, ", "), "软件库闭包"),
				})
			}
			body.table(
				[]string{"软件包", "分层", "当前版本", "目标修复版本", "最高等级", "活跃/总CVE", "影响范围"},
				rows,
			)
		}
	}

	// Chapter: CVE Details
	if sec.CVEDetails {
		body.heading(1, "CVE 漏洞明细清单")
		if len(ds.Findings) == 0 {
			body.note("当前筛选条件下无匹配的 CVE 漏洞记录。")
		} else {
			rows := make([][]string, 0, len(ds.Findings))
			for _, f := range ds.Findings {
				sev := f.Severity
				if f.CVSSScore > 0 {
					sev = fmt.Sprintf("%s (%.1f)", f.Severity, f.CVSSScore)
				}
				fix := strings.Join(f.FixedIn, ", ")
				if f.RepoFixVersion != "" {
					fix = f.RepoFixVersion + " [源就绪]"
				} else if fix == "" {
					fix = "待官方修复"
				}
				cls := make([]string, 0, len(f.Clusters))
				for _, c := range f.Clusters {
					cls = append(cls, c.ClusterID)
				}
				desc := firstNonEmptyStr(f.TriageNote, f.Summary)
				if len(cls) > 0 {
					if desc != "" {
						desc = fmt.Sprintf("[%s] %s", strings.Join(cls, ","), truncRunes(desc, 90))
					} else {
						desc = strings.Join(cls, ", ")
					}
				} else {
					desc = truncRunes(desc, 100)
				}
				rows = append(rows, []string{
					firstNonEmptyStr(f.CVE, f.ID),
					secPkgRoleZH(f.PkgRole),
					sev,
					fmt.Sprintf("%s\n%s", f.Package, f.InstalledVersion),
					fix,
					secTriageZH(f.TriageStatus),
					firstNonEmptyStr(desc, "—"),
				})
			}
			body.table(
				[]string{"CVE 编号", "分层", "等级/CVSS", "软件包与版本", "修复版本", "处置状态", "影响集群与说明"},
				rows,
			)
		}
	}

	// Chapter: Baseline Checks (cluster reports)
	if sec.BaselineChecks && ds.ClusterAudit != nil {
		body.heading(1, "配置安全基线审计")
		if len(ds.ClusterAudit.BaselineChecks) == 0 {
			body.note("当前集群未配置额外基线检查项。")
		} else {
			rows := make([][]string, 0, len(ds.ClusterAudit.BaselineChecks))
			for _, ck := range ds.ClusterAudit.BaselineChecks {
				rows = append(rows, []string{
					ck.Title,
					ck.Severity,
					secBaselineStatusZH(ck.Status),
					ck.Detail,
					firstNonEmptyStr(ck.Recommendation, "—"),
				})
			}
			body.table([]string{"检查项", "风险等级", "状态", "现状说明", "加固建议"}, rows)
		}
	}

	// Chapter: TLS Certificates (cluster reports)
	if sec.TLSCerts && ds.ClusterAudit != nil {
		body.heading(1, "TLS 证书有效期巡检")
		if len(ds.ClusterAudit.Certs) == 0 {
			body.note("当前集群未检出托管 TLS 证书资产。")
		} else {
			rows := make([][]string, 0, len(ds.ClusterAudit.Certs))
			for _, c := range ds.ClusterAudit.Certs {
				rows = append(rows, []string{
					c.Instance,
					c.Role,
					c.Subject,
					fmt.Sprintf("%s %d", c.KeyAlgo, c.KeyBits),
					c.NotAfter,
					fmt.Sprintf("%d 天", c.DaysLeft),
					secCertStatusZH(c.Status),
				})
			}
			body.table([]string{"实例", "角色", "主题 CN", "密钥算法", "到期日期", "剩余天数", "状态"}, rows)
		}
	}

	// Chapter: Remediation Plan
	if sec.RemediationPlan {
		body.heading(1, "优先修复建议与演练指引")
		if len(ds.Remediations) == 0 {
			body.note("当前无必须立即执行的紧急修复事项，建议保持定期漏洞库同步与周期巡检。")
		} else {
			rows := make([][]string, 0, len(ds.Remediations))
			for _, it := range ds.Remediations {
				rows = append(rows, []string{it.Priority, it.Category, it.Target, it.Action, it.Status})
			}
			body.table([]string{"优先级", "整改类别", "目标对象", "建议措施", "状态"}, rows)
		}
	}

	// Chapter: Sign-Off
	if sec.SignOff {
		body.heading(1, "报告声明与审批签字")
		if ds.ConclusionNote != "" {
			body.note(ds.ConclusionNote)
		}
		body.tableWithWidths(
			[]string{"审批角色", "姓名 / 签字", "审批意见", "日期"},
			[][]string{
				{"报告编制（安全工程师）", ds.GeneratedBy, "已核验扫描范围与口径", ds.GeneratedDate},
				{"技术复核（运维负责人）", "", "", ""},
				{"最终审批（安全负责人）", "", "", ""},
			},
			[]int{2300, 2000, 3226, 1500},
			0,
			true,
		)
	}

	// Build Front Matter (Cover + TOC synced with real chapter headings)
	front := newDocxWriter(th, "rIdSF")
	facts := [][2]string{
		{"评估范围", ds.ScopeName},
		{"使用模板", ds.Template.Name},
		{"生成时间", ds.GeneratedAt},
		{"活跃风险汇总", fmt.Sprintf("严重 %d · 高危 %d · 中危 %d · 低危 %d（共 %d 条）", ds.ActiveCounts.Critical, ds.ActiveCounts.High, ds.ActiveCounts.Medium, ds.ActiveCounts.Low, ds.ActiveCounts.Total)},
	}
	if ds.IsCluster && ds.ClusterAudit != nil {
		facts = append(facts, [2]string{"集群安全评分", fmt.Sprintf("%d 分（%s 级） · 配置基线 %d/%d", ds.ClusterAudit.Score, ds.ClusterAudit.Grade, ds.ClusterAudit.BaselinePassed, ds.ClusterAudit.BaselineTotal)})
	} else {
		facts = append(facts, [2]string{"受影响生产集群", fmt.Sprintf("%d 个（全平台纳管 %d 个）", len(ds.Clusters), ds.Report.ClusterCount)})
	}
	facts = append(facts, [2]string{"编制人", ds.GeneratedBy})

	front.cover(docxCover{
		Org:          ds.OrgName,
		Project:      "Middleware Hub 安全中心",
		Slogan:       fmt.Sprintf("报告模板：%s", ds.Template.Name),
		Title:        ds.Title,
		Subtitle:     ds.Subtitle,
		DocVersion:   "v1.0",
		Date:         ds.GeneratedDate,
		Confidential: ds.Confidential,
		Note:         ds.ConclusionNote,
		Cluster:      ds.ScopeName,
		Facts:        facts,
	})
	front.toc(body.headings)

	return docxFileDual(front, body, docxBuildMeta{
		Title:        ds.Title,
		Header:       ds.HeaderText,
		Footer:       ds.FooterText,
		FrontOrg:     ds.OrgName,
		Author:       ds.GeneratedBy,
		Theme:        th,
		HasFrontSect: true,
	})
}

// =========================================================================
// 2. Excel (.xlsx) Renderer — Pure-Go multi-sheet styled workbook
// =========================================================================

func xlsxSeverityStyle(sev string) int {
	switch strings.ToUpper(strings.TrimSpace(sev)) {
	case "CRITICAL", "FAIL", "EXPIRED":
		return xlsxStyleCritical
	case "HIGH", "WARN":
		return xlsxStyleHigh
	case "MEDIUM", "EXPIRING":
		return xlsxStyleMedium
	case "LOW", "PASS", "OK":
		return xlsxStyleLow
	default:
		return xlsxStyleMuted
	}
}

func renderSecurityXlsx(ds secExportDataset) ([]byte, error) {
	wb := newXlsxWorkbook(ds.Title, ds.GeneratedBy, ds.Theme)
	sec := ds.Template.Sections

	// Sheet 1: Executive Summary
	if sec.ExecutiveSummary {
		rows := [][]xlsxCell{
			{xlsxStr(ds.Title, xlsxStyleBanner)},
			{xlsxStr(fmt.Sprintf("%s  |  %s  |  生成时间：%s  |  模板：%s", ds.OrgName, ds.Confidential, ds.GeneratedAt, ds.Template.Name), xlsxStyleSubhead)},
			{},
			{xlsxStr("评估维度", xlsxStyleHeader), xlsxStr("数值 / 结论", xlsxStyleHeader), xlsxStr("补充说明", xlsxStyleHeader)},
			{xlsxStr("评估范围", xlsxStyleSubhead), xlsxStr(ds.ScopeName, xlsxStyleBody), xlsxStr(fmt.Sprintf("最低等级：%s · 包含豁免：%v · 包含全局屏蔽：%v", ds.Template.MinSeverity, ds.Template.IncludeWaived, ds.Template.IncludeIgnored), xlsxStyleBody)},
			{xlsxStr("活跃漏洞总数", xlsxStyleSubhead), xlsxInt(ds.ActiveCounts.Total, xlsxStyleNum), xlsxStr(fmt.Sprintf("严重 %d / 高危 %d / 中危 %d / 低危 %d", ds.ActiveCounts.Critical, ds.ActiveCounts.High, ds.ActiveCounts.Medium, ds.ActiveCounts.Low), xlsxStyleBody)},
			{xlsxStr("严重 (Critical)", xlsxStyleSubhead), xlsxInt(ds.ActiveCounts.Critical, xlsxStyleCritical), xlsxStr("需最高优先级处理（P0）", xlsxStyleBody)},
			{xlsxStr("高危 (High)", xlsxStyleSubhead), xlsxInt(ds.ActiveCounts.High, xlsxStyleHigh), xlsxStr("建议纳入近期维护窗口升级（P1）", xlsxStyleBody)},
			{xlsxStr("中危 (Medium)", xlsxStyleSubhead), xlsxInt(ds.ActiveCounts.Medium, xlsxStyleMedium), xlsxStr("结合常规版本迭代修复", xlsxStyleBody)},
			{xlsxStr("低危 (Low)", xlsxStyleSubhead), xlsxInt(ds.ActiveCounts.Low, xlsxStyleLow), xlsxStr("持续关注上游安全公告", xlsxStyleBody)},
			{xlsxStr("中间件本体活跃漏洞", xlsxStyleSubhead), xlsxInt(ds.MWCounts.Total, xlsxStyleNum), xlsxStr(fmt.Sprintf("严 %d / 高 %d / 中 %d / 低 %d", ds.MWCounts.Critical, ds.MWCounts.High, ds.MWCounts.Medium, ds.MWCounts.Low), xlsxStyleBody)},
			{xlsxStr("OS 底层包活跃漏洞", xlsxStyleSubhead), xlsxInt(ds.OSCounts.Total, xlsxStyleNum), xlsxStr(fmt.Sprintf("严 %d / 高 %d / 中 %d / 低 %d", ds.OSCounts.Critical, ds.OSCounts.High, ds.OSCounts.Medium, ds.OSCounts.Low), xlsxStyleBody)},
			{xlsxStr("已豁免 / 已缓解", xlsxStyleSubhead), xlsxInt(ds.WaivedCount, xlsxStyleNum), xlsxStr(fmt.Sprintf("全局屏蔽项 %d 条", ds.IgnoredCount), xlsxStyleBody)},
		}
		if ds.IsCluster && ds.ClusterAudit != nil {
			ca := ds.ClusterAudit
			rows = append(rows,
				[]xlsxCell{xlsxStr("集群安全综合评分", xlsxStyleSubhead), xlsxStr(fmt.Sprintf("%d 分（%s 级）", ca.Score, ca.Grade), xlsxStyleBody), xlsxStr(fmt.Sprintf("应用：%s %s (%s)", ca.AppName, ca.Version, ca.Platform), xlsxStyleBody)},
				[]xlsxCell{xlsxStr("配置基线通过率", xlsxStyleSubhead), xlsxStr(fmt.Sprintf("%d / %d", ca.BaselinePassed, ca.BaselineTotal), xlsxStyleBody), xlsxStr(fmt.Sprintf("临期/过期 TLS 证书：%d 张", ca.CertExpiring), xlsxStyleBody)},
			)
		} else {
			rows = append(rows,
				[]xlsxCell{xlsxStr("漏洞库公告数", xlsxStyleSubhead), xlsxInt(ds.Report.DBAdvisoryCount, xlsxStyleNum), xlsxStr("最近同步：" + firstNonEmptyStr(ds.Report.DBUpdatedAt, "—"), xlsxStyleBody)},
				[]xlsxCell{xlsxStr("盘点资产包 (SBOM)", xlsxStyleSubhead), xlsxInt(ds.Report.SBOMPackageCount, xlsxStyleNum), xlsxStr(fmt.Sprintf("离线闭包 %d / 运行环境 %d / 纳管集群 %d", ds.Report.ClosureCount, ds.Report.RuntimeCount, ds.Report.ClusterCount), xlsxStyleBody)},
				[]xlsxCell{xlsxStr("受影响生产集群", xlsxStyleSubhead), xlsxInt(len(ds.Clusters), xlsxStyleNum), xlsxStr(fmt.Sprintf("中间件受影响 %d / OS 受影响 %d", ds.Report.MiddlewareAffectedClusters, ds.Report.OSAffectedClusters), xlsxStyleBody)},
			)
		}
		if ds.ConclusionNote != "" {
			rows = append(rows,
				[]xlsxCell{},
				[]xlsxCell{xlsxStr("报告说明", xlsxStyleSubhead), xlsxStr(ds.ConclusionNote, xlsxStyleBody), xlsxStr("编制人：" + ds.GeneratedBy, xlsxStyleMuted)},
			)
		}
		wb.addSheet(xlsxSheet{
			Name:      "总览摘要",
			Rows:      rows,
			Merges:    []string{"A1:C1", "A2:C2"},
			MinWidths: []int{24, 22, 54},
		})
	}

	// Sheet: Affected Clusters (global)
	if sec.AffectedClusters && !ds.IsCluster {
		rows := [][]xlsxCell{{
			xlsxStr("集群标识", xlsxStyleHeader),
			xlsxStr("应用组件", xlsxStyleHeader),
			xlsxStr("版本", xlsxStyleHeader),
			xlsxStr("操作系统", xlsxStyleHeader),
			xlsxStr("节点数", xlsxStyleHeader),
			xlsxStr("中间件严重", xlsxStyleHeader),
			xlsxStr("中间件高危", xlsxStyleHeader),
			xlsxStr("中间件总计", xlsxStyleHeader),
			xlsxStr("OS 严重", xlsxStyleHeader),
			xlsxStr("OS 高危", xlsxStyleHeader),
			xlsxStr("OS 总计", xlsxStyleHeader),
			xlsxStr("负责人", xlsxStyleHeader),
			xlsxStr("代表 CVE", xlsxStyleHeader),
		}}
		for idx, cs := range ds.Clusters {
			st := xlsxStyleBody
			nst := xlsxStyleNum
			if idx%2 == 1 {
				st = xlsxStyleZebra
				nst = xlsxStyleNumZebra
			}
			critStyle := nst
			if cs.MiddlewareActive.Critical > 0 {
				critStyle = xlsxStyleCritical
			}
			highStyle := nst
			if cs.MiddlewareActive.High > 0 {
				highStyle = xlsxStyleHigh
			}
			rows = append(rows, []xlsxCell{
				xlsxStr(cs.ClusterID, st),
				xlsxStr(cs.AppName, st),
				xlsxStr(cs.Version, st),
				xlsxStr(cs.Platform, st),
				xlsxInt(len(cs.Hosts), nst),
				xlsxInt(cs.MiddlewareActive.Critical, critStyle),
				xlsxInt(cs.MiddlewareActive.High, highStyle),
				xlsxInt(cs.MiddlewareActive.Total, nst),
				xlsxInt(cs.OSActive.Critical, nst),
				xlsxInt(cs.OSActive.High, nst),
				xlsxInt(cs.OSActive.Total, nst),
				xlsxStr(firstNonEmptyStr(cs.Owner, "—"), st),
				xlsxStr(strings.Join(firstNStrings(cs.TopCVEs, 5), ", "), st),
			})
		}
		wb.addSheet(xlsxSheet{
			Name:       "受影响集群",
			Rows:       rows,
			FreezeRow:  1,
			AutoFilter: fmt.Sprintf("A1:M%d", len(rows)),
		})
	}

	// Sheet: Package Upgrade Groups
	if sec.PackageGroups {
		rows := [][]xlsxCell{{
			xlsxStr("最高等级", xlsxStyleHeader),
			xlsxStr("CVSS", xlsxStyleHeader),
			xlsxStr("软件包", xlsxStyleHeader),
			xlsxStr("分层来源", xlsxStyleHeader),
			xlsxStr("系统 / 生态", xlsxStyleHeader),
			xlsxStr("当前版本", xlsxStyleHeader),
			xlsxStr("建议修复版本", xlsxStyleHeader),
			xlsxStr("软件源已有修复版", xlsxStyleHeader),
			xlsxStr("活跃 CVE 数", xlsxStyleHeader),
			xlsxStr("总 CVE 数", xlsxStyleHeader),
			xlsxStr("受影响集群", xlsxStyleHeader),
			xlsxStr("CVE 列表", xlsxStyleHeader),
		}}
		for idx, g := range ds.PackageGroups {
			st := xlsxStyleBody
			nst := xlsxStyleNum
			if idx%2 == 1 {
				st = xlsxStyleZebra
				nst = xlsxStyleNumZebra
			}
			cls := make([]string, 0, len(g.Clusters))
			for _, c := range g.Clusters {
				cls = append(cls, c.ClusterID)
			}
			cvssCell := xlsxStr("—", st)
			if g.MaxCVSS > 0 {
				cvssCell = xlsxFloat(g.MaxCVSS, nst)
			}
			rows = append(rows, []xlsxCell{
				xlsxStr(g.MaxSeverity, xlsxSeverityStyle(g.MaxSeverity)),
				cvssCell,
				xlsxStr(g.Package, st),
				xlsxStr(secPkgRoleZH(g.PkgRole), st),
				xlsxStr(firstNonEmptyStr(g.PlatformTitle, g.Ecosystem), st),
				xlsxStr(g.InstalledVersion, st),
				xlsxStr(firstNonEmptyStr(g.RecommendedFix, "待上游发布"), st),
				xlsxStr(firstNonEmptyStr(g.RepoFixVersion, "—"), st),
				xlsxInt(g.ActiveCount, nst),
				xlsxInt(g.TotalCount, nst),
				xlsxStr(strings.Join(cls, ", "), st),
				xlsxStr(strings.Join(g.CVEs, ", "), st),
			})
		}
		wb.addSheet(xlsxSheet{
			Name:       "修复包清单",
			Rows:       rows,
			FreezeRow:  1,
			AutoFilter: fmt.Sprintf("A1:L%d", len(rows)),
		})
	}

	// Sheet: CVE Details
	if sec.CVEDetails {
		rows := [][]xlsxCell{{
			xlsxStr("CVE 编号", xlsxStyleHeader),
			xlsxStr("OSV ID", xlsxStyleHeader),
			xlsxStr("严重等级", xlsxStyleHeader),
			xlsxStr("CVSS", xlsxStyleHeader),
			xlsxStr("分层来源", xlsxStyleHeader),
			xlsxStr("生态", xlsxStyleHeader),
			xlsxStr("软件包", xlsxStyleHeader),
			xlsxStr("当前版本", xlsxStyleHeader),
			xlsxStr("官方修复版本", xlsxStyleHeader),
			xlsxStr("软件源就绪版本", xlsxStyleHeader),
			xlsxStr("处置状态", xlsxStyleHeader),
			xlsxStr("受影响集群", xlsxStyleHeader),
			xlsxStr("说明 / 评估备注", xlsxStyleHeader),
			xlsxStr("官方公告链接", xlsxStyleHeader),
		}}
		for idx, f := range ds.Findings {
			st := xlsxStyleBody
			nst := xlsxStyleNum
			if idx%2 == 1 {
				st = xlsxStyleZebra
				nst = xlsxStyleNumZebra
			}
			cls := make([]string, 0, len(f.Clusters))
			for _, cl := range f.Clusters {
				cls = append(cls, cl.ClusterID)
			}
			cvssCell := xlsxStr("—", st)
			if f.CVSSScore > 0 {
				cvssCell = xlsxFloat(f.CVSSScore, nst)
			}
			triageSt := st
			if f.Waived || f.GloballyIgnored {
				triageSt = xlsxStyleMuted
			}
			rows = append(rows, []xlsxCell{
				xlsxStr(firstNonEmptyStr(f.CVE, f.ID), st),
				xlsxStr(f.ID, st),
				xlsxStr(f.Severity, xlsxSeverityStyle(f.Severity)),
				cvssCell,
				xlsxStr(secPkgRoleZH(f.PkgRole), st),
				xlsxStr(f.Ecosystem, st),
				xlsxStr(f.Package, st),
				xlsxStr(f.InstalledVersion, st),
				xlsxStr(firstNonEmptyStr(strings.Join(f.FixedIn, "; "), "待官方修复"), st),
				xlsxStr(firstNonEmptyStr(f.RepoFixVersion, "—"), st),
				xlsxStr(secTriageZH(f.TriageStatus), triageSt),
				xlsxStr(strings.Join(cls, ", "), st),
				xlsxStr(firstNonEmptyStr(f.TriageNote, f.Summary), st),
				xlsxStr(f.URL, st),
			})
		}
		wb.addSheet(xlsxSheet{
			Name:       "CVE 漏洞明细",
			Rows:       rows,
			FreezeRow:  1,
			AutoFilter: fmt.Sprintf("A1:N%d", len(rows)),
		})
	}

	// Sheet: Baseline Checks (cluster reports)
	if sec.BaselineChecks && ds.ClusterAudit != nil {
		rows := [][]xlsxCell{{
			xlsxStr("检查项", xlsxStyleHeader),
			xlsxStr("分类", xlsxStyleHeader),
			xlsxStr("风险等级", xlsxStyleHeader),
			xlsxStr("审计状态", xlsxStyleHeader),
			xlsxStr("目标对象", xlsxStyleHeader),
			xlsxStr("检查详情", xlsxStyleHeader),
			xlsxStr("加固建议", xlsxStyleHeader),
		}}
		for idx, ck := range ds.ClusterAudit.BaselineChecks {
			st := xlsxStyleBody
			if idx%2 == 1 {
				st = xlsxStyleZebra
			}
			rows = append(rows, []xlsxCell{
				xlsxStr(ck.Title, st),
				xlsxStr(ck.Category, st),
				xlsxStr(ck.Severity, xlsxSeverityStyle(ck.Severity)),
				xlsxStr(secBaselineStatusZH(ck.Status), xlsxSeverityStyle(ck.Status)),
				xlsxStr(firstNonEmptyStr(ck.Target, "—"), st),
				xlsxStr(ck.Detail, st),
				xlsxStr(firstNonEmptyStr(ck.Recommendation, "—"), st),
			})
		}
		wb.addSheet(xlsxSheet{
			Name:       "配置安全基线",
			Rows:       rows,
			FreezeRow:  1,
			AutoFilter: fmt.Sprintf("A1:G%d", len(rows)),
		})
	}

	// Sheet: TLS Certificates (cluster reports)
	if sec.TLSCerts && ds.ClusterAudit != nil {
		rows := [][]xlsxCell{{
			xlsxStr("实例", xlsxStyleHeader),
			xlsxStr("角色", xlsxStyleHeader),
			xlsxStr("主题 CN", xlsxStyleHeader),
			xlsxStr("签发者", xlsxStyleHeader),
			xlsxStr("密钥算法", xlsxStyleHeader),
			xlsxStr("生效日期", xlsxStyleHeader),
			xlsxStr("到期日期", xlsxStyleHeader),
			xlsxStr("剩余天数", xlsxStyleHeader),
			xlsxStr("状态", xlsxStyleHeader),
		}}
		for idx, c := range ds.ClusterAudit.Certs {
			st := xlsxStyleBody
			nst := xlsxStyleNum
			if idx%2 == 1 {
				st = xlsxStyleZebra
				nst = xlsxStyleNumZebra
			}
			rows = append(rows, []xlsxCell{
				xlsxStr(c.Instance, st),
				xlsxStr(c.Role, st),
				xlsxStr(c.Subject, st),
				xlsxStr(c.Issuer, st),
				xlsxStr(fmt.Sprintf("%s %d", c.KeyAlgo, c.KeyBits), st),
				xlsxStr(c.NotBefore, st),
				xlsxStr(c.NotAfter, st),
				xlsxInt(c.DaysLeft, nst),
				xlsxStr(secCertStatusZH(c.Status), xlsxSeverityStyle(c.Status)),
			})
		}
		wb.addSheet(xlsxSheet{
			Name:       "TLS 证书巡检",
			Rows:       rows,
			FreezeRow:  1,
			AutoFilter: fmt.Sprintf("A1:I%d", len(rows)),
		})
	}

	// Sheet: Remediation Plan
	if sec.RemediationPlan {
		rows := [][]xlsxCell{{
			xlsxStr("优先级", xlsxStyleHeader),
			xlsxStr("整改类别", xlsxStyleHeader),
			xlsxStr("目标对象", xlsxStyleHeader),
			xlsxStr("问题描述", xlsxStyleHeader),
			xlsxStr("建议整改措施", xlsxStyleHeader),
			xlsxStr("状态", xlsxStyleHeader),
		}}
		for idx, it := range ds.Remediations {
			st := xlsxStyleBody
			if idx%2 == 1 {
				st = xlsxStyleZebra
			}
			pStyle := xlsxStyleMedium
			if it.Priority == "P0" {
				pStyle = xlsxStyleCritical
			} else if it.Priority == "P1" {
				pStyle = xlsxStyleHigh
			}
			rows = append(rows, []xlsxCell{
				xlsxStr(it.Priority, pStyle),
				xlsxStr(it.Category, st),
				xlsxStr(it.Target, st),
				xlsxStr(it.Detail, st),
				xlsxStr(it.Action, st),
				xlsxStr(it.Status, st),
			})
		}
		wb.addSheet(xlsxSheet{
			Name:       "优先修复计划",
			Rows:       rows,
			FreezeRow:  1,
			AutoFilter: fmt.Sprintf("A1:F%d", len(rows)),
		})
	}

	return wb.build()
}

// =========================================================================
// 3. Standalone Offline HTML (.html) Renderer — Zero External Dependencies
// =========================================================================

func hesc(s string) string {
	return html.EscapeString(s)
}

func htmlStatusPill(code, label string) string {
	u := strings.ToUpper(strings.TrimSpace(code))
	cls := "sev-unknown"
	switch u {
	case "CRITICAL", "FAIL", "EXPIRED":
		cls = "sev-critical"
	case "HIGH", "WARN":
		cls = "sev-high"
	case "MEDIUM", "EXPIRING":
		cls = "sev-medium"
	case "LOW", "PASS", "OK":
		cls = "sev-low"
	}
	return fmt.Sprintf(`<span class="pill %s">%s</span>`, cls, hesc(label))
}

func htmlSevPill(sev string) string {
	return htmlStatusPill(sev, sev)
}

func renderSecurityHTML(ds secExportDataset) []byte {
	th := ds.Theme
	sec := ds.Template.Sections
	var b strings.Builder

	totalSev := ds.ActiveCounts.Critical + ds.ActiveCounts.High + ds.ActiveCounts.Medium + ds.ActiveCounts.Low
	pct := func(n int) float64 {
		if totalSev <= 0 || n <= 0 {
			return 0
		}
		return float64(n) * 100.0 / float64(totalSev)
	}

	fmt.Fprintf(&b, `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>%s</title>
<style>
:root {
  --primary: #%s;
  --dark: #%s;
  --ink: #%s;
  --tint: #%s;
  --border: #e2e8f0;
  --muted: #64748b;
  --bg: #f8fafc;
  --card: #ffffff;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--bg);
  color: var(--ink);
  line-height: 1.55;
  font-size: 13.5px;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 24px 20px 56px; }
.hero {
  background: linear-gradient(135deg, var(--primary) 0%%, var(--dark) 100%%);
  color: #fff;
  border-radius: 16px;
  padding: 28px 32px;
  margin-bottom: 20px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.10);
}
.hero-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.hero-org { font-size: 13px; font-weight: 600; opacity: 0.92; letter-spacing: 0.03em; }
.hero-badges { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.hero-badge {
  background: rgba(255,255,255,0.16);
  border: 1px solid rgba(255,255,255,0.28);
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
}
.print-btn {
  background: #fff;
  color: var(--primary);
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.print-btn:hover { opacity: 0.92; }
.hero h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.28; }
.hero-sub { margin: 0 0 18px; opacity: 0.88; font-size: 14px; }
.hero-meta {
  display: flex; flex-wrap: wrap; gap: 16px;
  padding-top: 14px;
  border-top: 1px solid rgba(255,255,255,0.20);
  font-size: 12.5px;
  opacity: 0.92;
}
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px 24px;
  margin-bottom: 18px;
  box-shadow: 0 1px 3px rgba(15,23,42,0.03);
}
.card-h {
  display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 2px solid var(--tint);
}
.card-h h2 { margin: 0; font-size: 16.5px; color: var(--primary); }
.card-h small { color: var(--muted); font-size: 12.5px; }
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
.kpi {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
}
.kpi .k { font-size: 12px; color: var(--muted); }
.kpi .v { font-size: 24px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
.kpi .s { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
.kpi.k-crit .v { color: #b91c1c; }
.kpi.k-high .v { color: #c2410c; }
.kpi.k-med .v { color: #a16207; }
.kpi.k-low .v { color: #15803d; }
.sev-bar {
  display: flex; height: 10px; border-radius: 999px; overflow: hidden;
  background: #e2e8f0; margin-bottom: 14px;
}
.sev-bar > span { height: 100%%; }
.bar-crit { background: #dc2626; }
.bar-high { background: #ea580c; }
.bar-med  { background: #eab308; }
.bar-low  { background: #16a34a; }
.callout {
  background: var(--tint);
  border-left: 4px solid var(--primary);
  padding: 12px 15px;
  border-radius: 0 8px 8px 0;
  font-size: 13px;
  color: #334155;
}
.callout.warn {
  background: #fef2f2;
  border-left-color: #b91c1c;
  color: #7f1d1d;
}
.filter-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.filter-bar input {
  padding: 6px 11px; border: 1px solid #cbd5e1; border-radius: 8px;
  font-size: 13px; min-width: 240px; outline: none;
}
.filter-bar input:focus { border-color: var(--primary); }
.fbtn {
  padding: 4px 10px; border-radius: 999px; border: 1px solid #cbd5e1;
  background: #fff; color: #334155; font-size: 12px; cursor: pointer;
}
.fbtn.on { background: var(--primary); color: #fff; border-color: var(--primary); }
.tbl-wrap { overflow-x: auto; }
table { width: 100%%; border-collapse: collapse; font-size: 12.8px; }
th, td { padding: 9px 10px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
th {
  background: var(--tint);
  color: var(--ink);
  font-weight: 600;
  white-space: nowrap;
}
tbody tr:hover { background: #f8fafc; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, Menlo, monospace; font-size: 12px; }
.pill {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600; white-space: nowrap;
}
.sev-critical { background: #fee2e2; color: #991b1b; }
.sev-high { background: #ffedd5; color: #9a3412; }
.sev-medium { background: #fef9c3; color: #854d0e; }
.sev-low { background: #dcfce7; color: #166534; }
.sev-unknown { background: #f1f5f9; color: #475569; }
.tag {
  display: inline-block; padding: 1px 7px; border-radius: 6px;
  background: #f1f5f9; color: #334155; font-size: 11.5px; white-space: nowrap;
}
.tag-ok { background: #dcfce7; color: #166534; }
.sign-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 14px; }
.sign-box { border: 1px dashed #cbd5e1; border-radius: 10px; padding: 14px; min-height: 88px; }
.sign-box b { display: block; margin-bottom: 8px; color: var(--primary); }
.sign-box div { font-size: 12px; color: var(--muted); margin-top: 6px; }
.foot { text-align: center; color: var(--muted); font-size: 12px; margin-top: 24px; }
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }
@media print {
  body { background: #fff; font-size: 11.5px; }
  .wrap { max-width: 100%%; padding: 0; }
  .print-btn, .filter-bar { display: none !important; }
  .card { box-shadow: none; break-inside: avoid-page; }
  .hero { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .pill, th, .sev-bar > span { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <div class="hero-top">
      <div class="hero-org">%s</div>
      <div class="hero-badges">
        <span class="hero-badge">%s</span>
        <span class="hero-badge">模板：%s</span>
        <button class="print-btn" onclick="window.print()">打印 / 导出 PDF</button>
      </div>
    </div>
    <h1>%s</h1>
    <p class="hero-sub">%s</p>
    <div class="hero-meta">
      <span><b>评估范围：</b>%s</span>
      <span><b>生成时间：</b>%s</span>
      <span><b>编制人：</b>%s</span>
      <span><b>最低等级：</b>%s</span>
    </div>
  </header>
`,
		hesc(ds.Title),
		th.Primary, th.Dark, th.Ink, th.HeaderFill,
		hesc(ds.OrgName),
		hesc(ds.Confidential),
		hesc(ds.Template.Name),
		hesc(ds.Title),
		hesc(ds.Subtitle),
		hesc(ds.ScopeName),
		hesc(ds.GeneratedAt),
		hesc(ds.GeneratedBy),
		hesc(ds.Template.MinSeverity),
	)

	// Section: Executive Summary
	if sec.ExecutiveSummary {
		b.WriteString(`<section class="card"><div class="card-h"><h2>安全态势综合概览</h2>`)
		fmt.Fprintf(&b, `<small>扫描时间：%s</small></div>`, hesc(formatSecDisplayTime(ds.Report.ScannedAt, ds.GeneratedAt)))
		b.WriteString(`<div class="kpi-grid">`)
		if ds.IsCluster && ds.ClusterAudit != nil {
			ca := ds.ClusterAudit
			fmt.Fprintf(&b, `<div class="kpi"><div class="k">安全综合评分</div><div class="v">%d <span style="font-size:15px">(%s)</span></div><div class="s">配置基线 %d/%d · 临期证书 %d</div></div>`,
				ca.Score, hesc(ca.Grade), ca.BaselinePassed, ca.BaselineTotal, ca.CertExpiring)
		} else {
			fmt.Fprintf(&b, `<div class="kpi"><div class="k">受影响生产集群</div><div class="v">%d</div><div class="s">纳管总集群 %d · SBOM %d 包</div></div>`,
				len(ds.Clusters), ds.Report.ClusterCount, ds.Report.SBOMPackageCount)
		}
		fmt.Fprintf(&b, `<div class="kpi k-crit"><div class="k">严重 (Critical)</div><div class="v">%d</div><div class="s">P0 紧急处理</div></div>`, ds.ActiveCounts.Critical)
		fmt.Fprintf(&b, `<div class="kpi k-high"><div class="k">高危 (High)</div><div class="v">%d</div><div class="s">P1 优先修复</div></div>`, ds.ActiveCounts.High)
		fmt.Fprintf(&b, `<div class="kpi k-med"><div class="k">中危 (Medium)</div><div class="v">%d</div><div class="s">计划迭代修复</div></div>`, ds.ActiveCounts.Medium)
		fmt.Fprintf(&b, `<div class="kpi k-low"><div class="k">低危 (Low)</div><div class="v">%d</div><div class="s">已豁免/缓解 %d 条</div></div>`, ds.ActiveCounts.Low, ds.WaivedCount)
		fmt.Fprintf(&b, `<div class="kpi"><div class="k">风险来源分层</div><div class="v" style="font-size:18px">中间件 %d · OS %d</div><div class="s">运行环境 %d · 全局屏蔽 %d</div></div>`,
			ds.MWCounts.Total, ds.OSCounts.Total, ds.RuntimeCounts.Total, ds.IgnoredCount)
		b.WriteString(`</div>`)

		if totalSev > 0 {
			fmt.Fprintf(&b, `<div class="sev-bar" title="风险等级分布"><span class="bar-crit" style="width:%.2f%%"></span><span class="bar-high" style="width:%.2f%%"></span><span class="bar-med" style="width:%.2f%%"></span><span class="bar-low" style="width:%.2f%%"></span></div>`,
				pct(ds.ActiveCounts.Critical), pct(ds.ActiveCounts.High), pct(ds.ActiveCounts.Medium), pct(ds.ActiveCounts.Low))
		}
		if ds.ActiveCounts.Critical > 0 {
			fmt.Fprintf(&b, `<div class="callout warn"><b>高优先级警示：</b>检出 %d 条未处置严重（Critical）漏洞与 %d 条高危（High）漏洞，建议优先核查下方修复包清单并发起变更演练。</div>`, ds.ActiveCounts.Critical, ds.ActiveCounts.High)
		} else {
			fmt.Fprintf(&b, `<div class="callout"><b>态势摘要：</b>当前报告筛选范围内共有 %d 条未豁免活跃漏洞（%s），涉及 %d 个修复包。</div>`,
				ds.ActiveCounts.Total, formatSeveritySummaryZH(ds.ActiveCounts), len(ds.PackageGroups))
		}
		b.WriteString(`</section>`)
	}

	// Section: Affected Clusters
	if sec.AffectedClusters {
		if ds.IsCluster && ds.ClusterAudit != nil {
			ca := ds.ClusterAudit
			b.WriteString(`<section class="card"><div class="card-h"><h2>目标集群资产信息</h2></div><div class="tbl-wrap"><table><tbody>`)
			fmt.Fprintf(&b, `<tr><th style="width:180px">集群标识</th><td class="mono">%s</td><th style="width:180px">中间件版本</th><td>%s %s</td></tr>`, hesc(ca.ClusterID), hesc(ca.AppName), hesc(ca.Version))
			fmt.Fprintf(&b, `<tr><th>操作系统</th><td>%s</td><th>交付模式</th><td>%s</td></tr>`, hesc(ca.Platform), hesc(firstNonEmptyStr(ca.DeliveryMode, "standard")))
			fmt.Fprintf(&b, `<tr><th>主机节点 (%d 台)</th><td colspan="3" class="mono">%s</td></tr>`, len(ca.Hosts), hesc(strings.Join(ca.Hosts, " · ")))
			b.WriteString(`</tbody></table></div></section>`)
		} else {
			fmt.Fprintf(&b, `<section class="card"><div class="card-h"><h2>受影响生产集群一览</h2><small>共 %d 个集群</small></div>`, len(ds.Clusters))
			if len(ds.Clusters) == 0 {
				b.WriteString(`<div class="callout">当前筛选条件下暂无存在活跃漏洞的生产集群。</div>`)
			} else {
				b.WriteString(`<div class="tbl-wrap"><table><thead><tr><th>集群</th><th>应用版本</th><th>操作系统</th><th>节点数</th><th>中间件 (严/高/总)</th><th>OS 底层包 (严/高/总)</th><th>负责人</th></tr></thead><tbody>`)
				for _, cs := range ds.Clusters {
					fmt.Fprintf(&b, `<tr><td class="mono"><b>%s</b></td><td>%s %s</td><td>%s</td><td>%d</td><td>%d / %d / %d</td><td>%d / %d / %d</td><td>%s</td></tr>`,
						hesc(cs.ClusterID), hesc(cs.AppName), hesc(cs.Version), hesc(cs.Platform), len(cs.Hosts),
						cs.MiddlewareActive.Critical, cs.MiddlewareActive.High, cs.MiddlewareActive.Total,
						cs.OSActive.Critical, cs.OSActive.High, cs.OSActive.Total,
						hesc(firstNonEmptyStr(cs.Owner, "—")))
				}
				b.WriteString(`</tbody></table></div>`)
			}
			b.WriteString(`</section>`)
		}
	}

	// Section: Package Groups
	if sec.PackageGroups {
		fmt.Fprintf(&b, `<section class="card"><div class="card-h"><h2>按修复包聚合的升级清单</h2><small>共 %d 个软件包</small></div>`, len(ds.PackageGroups))
		if len(ds.PackageGroups) == 0 {
			b.WriteString(`<div class="callout">当前筛选条件下无待处理软件包。</div>`)
		} else {
			b.WriteString(`<div class="tbl-wrap"><table><thead><tr><th>最高等级</th><th>软件包</th><th>分层</th><th>当前版本</th><th>修复版本</th><th>活跃/总CVE</th><th>影响集群</th></tr></thead><tbody>`)
			for _, g := range ds.PackageGroups {
				fixHTML := `<span class="tag">待上游发布</span>`
				if g.RepoFixVersion != "" {
					fixHTML = fmt.Sprintf(`<span class="mono">%s</span> <span class="tag tag-ok">源就绪</span>`, hesc(g.RepoFixVersion))
				} else if g.RecommendedFix != "" {
					fixHTML = fmt.Sprintf(`<span class="mono">%s</span>`, hesc(g.RecommendedFix))
				}
				cls := make([]string, 0, len(g.Clusters))
				for _, c := range g.Clusters {
					cls = append(cls, c.ClusterID)
				}
				fmt.Fprintf(&b, `<tr><td>%s</td><td><b class="mono">%s</b><div style="font-size:11.5px;color:#64748b">%s</div></td><td><span class="tag">%s</span></td><td class="mono">%s</td><td>%s</td><td><b>%d</b> / %d</td><td class="mono">%s</td></tr>`,
					htmlSevPill(g.MaxSeverity),
					hesc(g.Package),
					hesc(firstNonEmptyStr(g.PlatformTitle, g.Ecosystem)),
					hesc(secPkgRoleZH(g.PkgRole)),
					hesc(g.InstalledVersion),
					fixHTML,
					g.ActiveCount, g.TotalCount,
					hesc(firstNonEmptyStr(strings.Join(cls, ", "), "软件库闭包")),
				)
			}
			b.WriteString(`</tbody></table></div>`)
		}
		b.WriteString(`</section>`)
	}

	// Section: CVE Details (with interactive client-side search & severity filter!)
	if sec.CVEDetails {
		fmt.Fprintf(&b, `<section class="card"><div class="card-h"><h2>CVE 漏洞明细表</h2><small id="cve-count">共 %d 条记录</small></div>`, len(ds.Findings))
		if len(ds.Findings) == 0 {
			b.WriteString(`<div class="callout">当前筛选条件下无匹配的 CVE 漏洞记录。</div>`)
		} else {
			b.WriteString(`<div class="filter-bar">
  <input id="cve-q" type="search" placeholder="搜索 CVE 编号、软件包、集群或说明..." />
  <button class="fbtn on" data-sev="ALL" type="button">全部等级</button>
  <button class="fbtn" data-sev="CRITICAL" type="button">严重</button>
  <button class="fbtn" data-sev="HIGH" type="button">高危</button>
  <button class="fbtn" data-sev="MEDIUM" type="button">中危</button>
  <button class="fbtn" data-sev="LOW" type="button">低危</button>
</div>`)
			b.WriteString(`<div class="tbl-wrap"><table id="cve-table"><thead><tr><th>CVE</th><th>等级</th><th>CVSS</th><th>分层</th><th>软件包 &amp; 当前版本</th><th>修复版本</th><th>状态</th><th>影响集群与说明</th></tr></thead><tbody>`)
			for _, f := range ds.Findings {
				cveLabel := firstNonEmptyStr(f.CVE, f.ID)
				cveCell := fmt.Sprintf(`<b class="mono">%s</b>`, hesc(cveLabel))
				if strings.HasPrefix(f.URL, "https://") || strings.HasPrefix(f.URL, "http://") {
					cveCell = fmt.Sprintf(`<a class="mono" href="%s" target="_blank" rel="noopener noreferrer"><b>%s</b></a>`, hesc(f.URL), hesc(cveLabel))
				}
				score := "—"
				if f.CVSSScore > 0 {
					score = fmt.Sprintf("%.1f", f.CVSSScore)
				}
				fix := firstNonEmptyStr(strings.Join(f.FixedIn, ", "), "待官方修复")
				if f.RepoFixVersion != "" {
					fix = f.RepoFixVersion + " (源就绪)"
				}
				cls := make([]string, 0, len(f.Clusters))
				for _, c := range f.Clusters {
					cls = append(cls, c.ClusterID)
				}
				note := firstNonEmptyStr(f.TriageNote, f.Summary)
				metaText := ""
				if len(cls) > 0 {
					metaText = `<div class="mono" style="margin-bottom:2px">` + hesc(strings.Join(cls, ", ")) + `</div>`
				}
				if note != "" {
					metaText += `<div style="color:#475569;font-size:12px">` + hesc(truncRunes(note, 140)) + `</div>`
				}
				if metaText == "" {
					metaText = "—"
				}
				fmt.Fprintf(&b, `<tr data-sev="%s"><td>%s</td><td>%s</td><td class="mono">%s</td><td><span class="tag">%s</span></td><td><b class="mono">%s</b><div class="mono" style="color:#64748b">%s</div></td><td class="mono">%s</td><td><span class="tag">%s</span></td><td>%s</td></tr>`,
					hesc(strings.ToUpper(f.Severity)),
					cveCell,
					htmlSevPill(f.Severity),
					hesc(score),
					hesc(secPkgRoleZH(f.PkgRole)),
					hesc(f.Package),
					hesc(f.InstalledVersion),
					hesc(fix),
					hesc(secTriageZH(f.TriageStatus)),
					metaText,
				)
			}
			b.WriteString(`</tbody></table></div>`)
		}
		b.WriteString(`</section>`)
	}

	// Section: Baseline Checks
	if sec.BaselineChecks && ds.ClusterAudit != nil {
		fmt.Fprintf(&b, `<section class="card"><div class="card-h"><h2>配置安全基线审计</h2><small>通过 %d / %d 项</small></div>`, ds.ClusterAudit.BaselinePassed, ds.ClusterAudit.BaselineTotal)
		if len(ds.ClusterAudit.BaselineChecks) == 0 {
			b.WriteString(`<div class="callout">暂无配置基线检查项。</div>`)
		} else {
			b.WriteString(`<div class="tbl-wrap"><table><thead><tr><th>检查项</th><th>等级</th><th>状态</th><th>检查详情</th><th>加固建议</th></tr></thead><tbody>`)
			for _, ck := range ds.ClusterAudit.BaselineChecks {
				fmt.Fprintf(&b, `<tr><td><b>%s</b></td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>`,
					hesc(ck.Title), htmlSevPill(ck.Severity), htmlStatusPill(ck.Status, secBaselineStatusZH(ck.Status)),
					hesc(ck.Detail), hesc(firstNonEmptyStr(ck.Recommendation, "—")))
			}
			b.WriteString(`</tbody></table></div>`)
		}
		b.WriteString(`</section>`)
	}

	// Section: TLS Certs
	if sec.TLSCerts && ds.ClusterAudit != nil {
		fmt.Fprintf(&b, `<section class="card"><div class="card-h"><h2>TLS 证书有效期巡检</h2><small>共 %d 张证书</small></div>`, len(ds.ClusterAudit.Certs))
		if len(ds.ClusterAudit.Certs) == 0 {
			b.WriteString(`<div class="callout">当前集群未检出托管 TLS 证书。</div>`)
		} else {
			b.WriteString(`<div class="tbl-wrap"><table><thead><tr><th>实例</th><th>角色</th><th>主题 CN</th><th>密钥</th><th>到期日期</th><th>剩余天数</th><th>状态</th></tr></thead><tbody>`)
			for _, c := range ds.ClusterAudit.Certs {
				fmt.Fprintf(&b, `<tr><td class="mono">%s</td><td>%s</td><td class="mono">%s</td><td class="mono">%s %d</td><td class="mono">%s</td><td><b>%d</b> 天</td><td>%s</td></tr>`,
					hesc(c.Instance), hesc(c.Role), hesc(c.Subject), hesc(c.KeyAlgo), c.KeyBits,
					hesc(c.NotAfter), c.DaysLeft, htmlStatusPill(c.Status, secCertStatusZH(c.Status)))
			}
			b.WriteString(`</tbody></table></div>`)
		}
		b.WriteString(`</section>`)
	}

	// Section: Remediation Plan
	if sec.RemediationPlan {
		fmt.Fprintf(&b, `<section class="card"><div class="card-h"><h2>优先修复建议与演练指引</h2><small>共 %d 项行动</small></div>`, len(ds.Remediations))
		if len(ds.Remediations) == 0 {
			b.WriteString(`<div class="callout">当前暂无必须立即执行的紧急修复事项。</div>`)
		} else {
			b.WriteString(`<div class="tbl-wrap"><table><thead><tr><th>优先级</th><th>类别</th><th>目标对象</th><th>建议整改措施</th><th>状态</th></tr></thead><tbody>`)
			for _, it := range ds.Remediations {
				pSev := "MEDIUM"
				if it.Priority == "P0" {
					pSev = "CRITICAL"
				} else if it.Priority == "P1" {
					pSev = "HIGH"
				}
				fmt.Fprintf(&b, `<tr><td><span class="pill sev-%s">%s</span></td><td>%s</td><td class="mono">%s</td><td>%s</td><td><span class="tag">%s</span></td></tr>`,
					strings.ToLower(pSev), hesc(it.Priority), hesc(it.Category), hesc(it.Target), hesc(it.Action), hesc(it.Status))
			}
			b.WriteString(`</tbody></table></div>`)
		}
		b.WriteString(`</section>`)
	}

	// Section: Sign-off
	if sec.SignOff {
		b.WriteString(`<section class="card"><div class="card-h"><h2>报告声明与审批签字</h2></div>`)
		if ds.ConclusionNote != "" {
			fmt.Fprintf(&b, `<div class="callout">%s</div>`, hesc(ds.ConclusionNote))
		}
		fmt.Fprintf(&b, `<div class="sign-grid">
  <div class="sign-box"><b>报告编制（安全工程师）</b><div>签字：%s</div><div>日期：%s</div></div>
  <div class="sign-box"><b>技术复核（运维负责人）</b><div>签字：________________</div><div>日期：____-__-__</div></div>
  <div class="sign-box"><b>最终审批（安全负责人）</b><div>签字：________________</div><div>日期：____-__-__</div></div>
</div></section>`, hesc(ds.GeneratedBy), hesc(ds.GeneratedDate))
	}

	fmt.Fprintf(&b, `<footer class="foot">%s</footer>
</div>
<script>
(function(){
  var qEl = document.getElementById('cve-q');
  var tbl = document.getElementById('cve-table');
  var cnt = document.getElementById('cve-count');
  if (!tbl) return;
  var activeSev = 'ALL';
  var btns = document.querySelectorAll('.fbtn[data-sev]');
  function apply(){
    var q = (qEl ? qEl.value : '').trim().toLowerCase();
    var rows = tbl.querySelectorAll('tbody tr');
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var sev = r.getAttribute('data-sev') || '';
      var okSev = activeSev === 'ALL' || sev === activeSev;
      var okQ = !q || r.textContent.toLowerCase().indexOf(q) >= 0;
      var vis = okSev && okQ;
      r.style.display = vis ? '' : 'none';
      if (vis) shown++;
    }
    if (cnt) cnt.textContent = '显示 ' + shown + ' / ' + rows.length + ' 条记录';
  }
  if (qEl) qEl.addEventListener('input', apply);
  for (var j = 0; j < btns.length; j++) {
    btns[j].addEventListener('click', function(){
      activeSev = this.getAttribute('data-sev') || 'ALL';
      for (var k = 0; k < btns.length; k++) btns[k].classList.toggle('on', btns[k] === this);
      apply();
    });
  }
})();
</script>
</body>
</html>`, hesc(ds.FooterText))

	return []byte(b.String())
}

// sanitizeExportFilenameSlug produces a clean ASCII filename suffix for downloaded reports.
func sanitizeExportFilenameSlug(raw string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(raw)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	s := strings.Trim(b.String(), "-_")
	if len(s) > 40 {
		s = s[:40]
	}
	return s
}

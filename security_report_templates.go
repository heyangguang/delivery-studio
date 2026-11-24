package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Configurable Security Report Templates (/api/security/report-templates*)
// Shared across Word (.docx), Excel (.xlsx), HTML (.html), and Markdown/CSV exports.

type secReportSections struct {
	ExecutiveSummary bool `json:"executive_summary"`
	AffectedClusters bool `json:"affected_clusters"`
	PackageGroups    bool `json:"package_groups"`
	CVEDetails       bool `json:"cve_details"`
	BaselineChecks   bool `json:"baseline_checks"`
	TLSCerts         bool `json:"tls_certs"`
	RemediationPlan  bool `json:"remediation_plan"`
	SignOff          bool `json:"signoff"`
}

type secReportTemplate struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Description    string            `json:"description,omitempty"`
	Builtin        bool              `json:"builtin,omitempty"`
	IsDefault      bool              `json:"is_default,omitempty"`
	DefaultFormat  string            `json:"default_format"` // docx | xlsx | html | markdown | csv
	Theme          string            `json:"theme"`          // teal | navy | indigo | slate
	OrgName        string            `json:"org_name,omitempty"`
	Title          string            `json:"title,omitempty"`
	Subtitle       string            `json:"subtitle,omitempty"`
	Confidential   string            `json:"confidential,omitempty"`
	HeaderText     string            `json:"header_text,omitempty"`
	FooterText     string            `json:"footer_text,omitempty"`
	ConclusionNote string            `json:"conclusion_note,omitempty"`
	Scope          string            `json:"scope"`        // active | all | primary | dependency
	MinSeverity    string            `json:"min_severity"` // ALL | LOW | MEDIUM | HIGH | CRITICAL
	IncludeWaived  bool              `json:"include_waived"`
	IncludeIgnored bool              `json:"include_ignored"`
	Sections       secReportSections `json:"sections"`
	UpdatedAt      string            `json:"updated_at,omitempty"`
	UpdatedBy      string            `json:"updated_by,omitempty"`
}

func defaultSecReportTemplates() []secReportTemplate {
	return []secReportTemplate{
		{
			ID:             "builtin-compliance",
			Name:           "合规审计完整报告",
			Description:    "面向等保合规与正式安全归档的完整版式，覆盖态势总览、受影响集群、修复包聚合、CVE 明细、配置基线、TLS 证书与审批签字栏。",
			Builtin:        true,
			IsDefault:      true,
			DefaultFormat:  "docx",
			Theme:          "teal",
			OrgName:        "Kyndryl Delivery Studio 安全运营中心",
			Title:          "{scope}安全态势与漏洞合规评估报告",
			Subtitle:       "SBOM 漏洞基线核查 · 生产集群影响评估 · 修复整改指引",
			Confidential:   "内部受控 / Internal",
			HeaderText:     "{org} · {scope}安全评估报告",
			FooterText:     "由 Kyndryl Delivery Studio 自动生成 · {date}",
			ConclusionNote: "本报告基于当前平台离线软件库 SBOM、生产集群配置快照与本地安全漏洞库生成，供内部安全审计、变更评审与漏洞修复排期使用。",
			Scope:          "active",
			MinSeverity:    "ALL",
			IncludeWaived:  true,
			IncludeIgnored: false,
			Sections: secReportSections{
				ExecutiveSummary: true,
				AffectedClusters: true,
				PackageGroups:    true,
				CVEDetails:       true,
				BaselineChecks:   true,
				TLSCerts:         true,
				RemediationPlan:  true,
				SignOff:          true,
			},
		},
		{
			ID:             "builtin-executive",
			Name:           "管理层安全摘要",
			Description:    "面向管理层与评审会的精简汇报模板，聚焦高危及以上未豁免风险、受影响生产集群及优先修复计划，自动省略冗长明细表。",
			Builtin:        true,
			IsDefault:      false,
			DefaultFormat:  "docx",
			Theme:          "navy",
			OrgName:        "Kyndryl Delivery Studio 安全运营中心",
			Title:          "{scope}安全风险管理摘要",
			Subtitle:       "高危及以上未处置风险态势与整改优先级汇报",
			Confidential:   "管理层汇报 / Confidential",
			HeaderText:     "{org} · 安全风险摘要",
			FooterText:     "机密内部资料 · {date}",
			ConclusionNote: "建议优先处理软件源已有修复版本的严重及高危中间件漏洞，并在变更演练沙箱验证后安排维护窗口升级。",
			Scope:          "active",
			MinSeverity:    "HIGH",
			IncludeWaived:  false,
			IncludeIgnored: false,
			Sections: secReportSections{
				ExecutiveSummary: true,
				AffectedClusters: true,
				PackageGroups:    true,
				CVEDetails:       false,
				BaselineChecks:   true,
				TLSCerts:         true,
				RemediationPlan:  true,
				SignOff:          true,
			},
		},
		{
			ID:             "builtin-remediation",
			Name:           "运维修复工单清单",
			Description:    "面向运维整改排期的多工作表 Excel 台账，分 Sheet 汇总受影响集群、修复包清单、CVE 明细与配置基线，自带表头冻结与筛选。",
			Builtin:        true,
			IsDefault:      false,
			DefaultFormat:  "xlsx",
			Theme:          "indigo",
			OrgName:        "Kyndryl Delivery Studio 基础设施运维部",
			Title:          "{scope}安全漏洞整改工单台账",
			Subtitle:       "按修复包与生产集群整理的待修复任务清单",
			Confidential:   "内部运维工单",
			HeaderText:     "{org} · 漏洞修复工单",
			FooterText:     "Kyndryl Delivery Studio Security · {date}",
			ConclusionNote: "请按优先级（P0 严重 / P1 高危）逐项认领修复包，优先在测试环境完成变更演练后再执行生产滚动升级。",
			Scope:          "active",
			MinSeverity:    "ALL",
			IncludeWaived:  false,
			IncludeIgnored: false,
			Sections: secReportSections{
				ExecutiveSummary: true,
				AffectedClusters: true,
				PackageGroups:    true,
				CVEDetails:       true,
				BaselineChecks:   true,
				TLSCerts:         true,
				RemediationPlan:  true,
				SignOff:          false,
			},
		},
		{
			ID:             "builtin-html-brief",
			Name:           "交互式安全简报 (HTML)",
			Description:    "零外部依赖的单文件离线 HTML 网页报告，内嵌风险分布条、CVE 实时检索过滤与打印/PDF 排版，适合浏览器直览或邮件附件发送。",
			Builtin:        true,
			IsDefault:      false,
			DefaultFormat:  "html",
			Theme:          "slate",
			OrgName:        "Kyndryl Delivery Studio 安全运营中心",
			Title:          "{scope}交互式安全态势简报",
			Subtitle:       "离线单文件可检索安全报告 · 支持直接打印归档 PDF",
			Confidential:   "内部受控 / Internal",
			HeaderText:     "{org} · 安全态势简报",
			FooterText:     "Kyndryl Delivery Studio 离线安全报告 · {date}",
			ConclusionNote: "本页面为单文件自包含 HTML 报告，不依赖任何外部网络资源，可直接离线打开、按关键词/等级实时检索或打印导出为 PDF。",
			Scope:          "active",
			MinSeverity:    "ALL",
			IncludeWaived:  true,
			IncludeIgnored: false,
			Sections: secReportSections{
				ExecutiveSummary: true,
				AffectedClusters: true,
				PackageGroups:    true,
				CVEDetails:       true,
				BaselineChecks:   true,
				TLSCerts:         true,
				RemediationPlan:  true,
				SignOff:          true,
			},
		},
	}
}

func isBuiltinSecReportTemplateID(id string) bool {
	for _, d := range defaultSecReportTemplates() {
		if d.ID == id {
			return true
		}
	}
	return false
}

func builtinSecReportTemplateByID(id string) (secReportTemplate, bool) {
	for _, d := range defaultSecReportTemplates() {
		if d.ID == id {
			return d, true
		}
	}
	return secReportTemplate{}, false
}

func normalizeSecReportFormat(f string) string {
	switch strings.ToLower(strings.TrimSpace(f)) {
	case "docx", "word":
		return "docx"
	case "xlsx", "excel":
		return "xlsx"
	case "html", "htm":
		return "html"
	case "markdown", "md":
		return "markdown"
	case "csv":
		return "csv"
	default:
		return "docx"
	}
}

func normalizeSecReportTheme(th string) string {
	t := strings.ToLower(strings.TrimSpace(th))
	if _, ok := docxThemes[t]; ok {
		return t
	}
	return "teal"
}

func normalizeSecReportScope(sc string) string {
	switch strings.ToLower(strings.TrimSpace(sc)) {
	case "all":
		return "all"
	case "primary", "middleware":
		return "primary"
	case "dependency", "os":
		return "dependency"
	default:
		return "active"
	}
}

func normalizeSecReportMinSeverity(sev string) string {
	switch strings.ToUpper(strings.TrimSpace(sev)) {
	case "CRITICAL", "HIGH", "MEDIUM", "LOW":
		return strings.ToUpper(strings.TrimSpace(sev))
	default:
		return "ALL"
	}
}

func normalizeSecReportTemplate(t secReportTemplate) secReportTemplate {
	t.Name = truncRunes(strings.TrimSpace(t.Name), 80)
	t.Description = truncRunes(strings.TrimSpace(t.Description), 300)
	t.DefaultFormat = normalizeSecReportFormat(t.DefaultFormat)
	t.Theme = normalizeSecReportTheme(t.Theme)
	t.OrgName = truncRunes(strings.TrimSpace(t.OrgName), 100)
	t.Title = truncRunes(strings.TrimSpace(t.Title), 140)
	t.Subtitle = truncRunes(strings.TrimSpace(t.Subtitle), 180)
	t.Confidential = truncRunes(strings.TrimSpace(t.Confidential), 60)
	t.HeaderText = truncRunes(strings.TrimSpace(t.HeaderText), 140)
	t.FooterText = truncRunes(strings.TrimSpace(t.FooterText), 140)
	t.ConclusionNote = truncRunes(strings.TrimSpace(t.ConclusionNote), 600)
	t.Scope = normalizeSecReportScope(t.Scope)
	t.MinSeverity = normalizeSecReportMinSeverity(t.MinSeverity)
	// Ensure at least one section is enabled so exported reports are never completely blank.
	s := t.Sections
	if !s.ExecutiveSummary && !s.AffectedClusters && !s.PackageGroups && !s.CVEDetails &&
		!s.BaselineChecks && !s.TLSCerts && !s.RemediationPlan && !s.SignOff {
		t.Sections.ExecutiveSummary = true
	}
	return t
}

func ensureSingleDefaultTemplate(list []secReportTemplate) []secReportTemplate {
	defIdx := -1
	for i := range list {
		if list[i].IsDefault {
			if defIdx < 0 {
				defIdx = i
			} else {
				list[i].IsDefault = false
			}
		}
	}
	if defIdx < 0 && len(list) > 0 {
		list[0].IsDefault = true
	}
	return list
}

func (s *storeServer) loadSecReportTemplates() []secReportTemplate {
	defaults := defaultSecReportTemplates()
	if s.cfg.DataDir == "" {
		return defaults
	}
	b, err := os.ReadFile(filepath.Join(s.secDir(), "report-templates.json"))
	if err != nil {
		return defaults
	}
	var saved []secReportTemplate
	if json.Unmarshal(b, &saved) != nil || len(saved) == 0 {
		return defaults
	}
	byID := map[string]bool{}
	for i := range saved {
		saved[i] = normalizeSecReportTemplate(saved[i])
		if isBuiltinSecReportTemplateID(saved[i].ID) {
			saved[i].Builtin = true
		}
		byID[saved[i].ID] = true
	}
	for _, d := range defaults {
		if !byID[d.ID] {
			d.IsDefault = false
			saved = append(saved, d)
		}
	}
	return ensureSingleDefaultTemplate(saved)
}

func (s *storeServer) saveSecReportTemplates(list []secReportTemplate) error {
	if s.cfg.DataDir == "" {
		return nil
	}
	list = ensureSingleDefaultTemplate(list)
	return writeJSONFile(filepath.Join(s.secDir(), "report-templates.json"), list)
}

func (s *storeServer) resolveSecReportTemplate(id string) secReportTemplate {
	secDBMu.Lock()
	list := s.loadSecReportTemplates()
	secDBMu.Unlock()
	id = strings.TrimSpace(id)
	if id != "" {
		for _, t := range list {
			if t.ID == id {
				return t
			}
		}
	}
	for _, t := range list {
		if t.IsDefault {
			return t
		}
	}
	if len(list) > 0 {
		return list[0]
	}
	return defaultSecReportTemplates()[0]
}

// ---- HTTP Handlers: /api/security/report-templates* ----

func (s *storeServer) handleSecurityReportTemplates(w http.ResponseWriter, r *http.Request, session storeSession, parts []string) {
	switch {
	case len(parts) == 0 && r.Method == "GET":
		secDBMu.Lock()
		list := s.loadSecReportTemplates()
		secDBMu.Unlock()
		s.writeJSON(w, 200, map[string]any{"templates": list})

	case len(parts) == 0 && r.Method == "POST":
		var in secReportTemplate
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&in) != nil {
			s.fail(w, 400, "请求格式错误")
			return
		}
		in = normalizeSecReportTemplate(in)
		if in.Name == "" {
			s.fail(w, 400, "请填写模板名称")
			return
		}
		in.ID = "tpl-" + randomStoreToken(6)
		in.Builtin = false
		in.UpdatedAt = now()
		in.UpdatedBy = session.User

		secDBMu.Lock()
		list := s.loadSecReportTemplates()
		if in.IsDefault {
			for i := range list {
				list[i].IsDefault = false
			}
		}
		list = append(list, in)
		list = ensureSingleDefaultTemplate(list)
		saveErr := s.saveSecReportTemplates(list)
		secDBMu.Unlock()
		if saveErr != nil {
			s.fail(w, 500, "保存安全报告模板失败")
			return
		}
		s.auditReq(r, "security-report-template-add", session.User, fmt.Sprintf("%s (%s/%s)", in.Name, in.DefaultFormat, in.Theme))
		s.writeJSON(w, 200, map[string]any{"template": in, "templates": list})

	case len(parts) == 1 && r.Method == "PUT":
		id := strings.TrimSpace(parts[0])
		var in secReportTemplate
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&in) != nil {
			s.fail(w, 400, "请求格式错误")
			return
		}
		in = normalizeSecReportTemplate(in)
		if in.Name == "" {
			s.fail(w, 400, "请填写模板名称")
			return
		}

		secDBMu.Lock()
		list := s.loadSecReportTemplates()
		idx := -1
		for i := range list {
			if list[i].ID == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			secDBMu.Unlock()
			s.fail(w, 404, "报告模板不存在")
			return
		}
		in.ID = list[idx].ID
		in.Builtin = list[idx].Builtin
		in.UpdatedAt = now()
		in.UpdatedBy = session.User
		if in.IsDefault {
			for i := range list {
				list[i].IsDefault = false
			}
		}
		list[idx] = in
		list = ensureSingleDefaultTemplate(list)
		saveErr := s.saveSecReportTemplates(list)
		secDBMu.Unlock()
		if saveErr != nil {
			s.fail(w, 500, "更新安全报告模板失败")
			return
		}
		s.auditReq(r, "security-report-template-update", session.User, fmt.Sprintf("%s (%s)", in.Name, in.ID))
		s.writeJSON(w, 200, map[string]any{"template": list[idx], "templates": list})

	case len(parts) == 1 && r.Method == "DELETE":
		id := strings.TrimSpace(parts[0])
		secDBMu.Lock()
		list := s.loadSecReportTemplates()
		idx := -1
		for i := range list {
			if list[i].ID == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			secDBMu.Unlock()
			s.fail(w, 404, "报告模板不存在")
			return
		}
		if list[idx].Builtin {
			secDBMu.Unlock()
			s.fail(w, 400, "内置模板不可删除，可直接编辑或重置为默认配置")
			return
		}
		name := list[idx].Name
		wasDef := list[idx].IsDefault
		list = append(list[:idx], list[idx+1:]...)
		if wasDef && len(list) > 0 {
			list[0].IsDefault = true
		}
		list = ensureSingleDefaultTemplate(list)
		saveErr := s.saveSecReportTemplates(list)
		secDBMu.Unlock()
		if saveErr != nil {
			s.fail(w, 500, "删除安全报告模板失败")
			return
		}
		s.auditReq(r, "security-report-template-delete", session.User, fmt.Sprintf("%s (%s)", name, id))
		s.writeJSON(w, 200, map[string]any{"templates": list})

	case len(parts) == 2 && parts[1] == "default" && r.Method == "POST":
		id := strings.TrimSpace(parts[0])
		secDBMu.Lock()
		list := s.loadSecReportTemplates()
		found := -1
		for i := range list {
			if list[i].ID == id {
				found = i
			}
		}
		if found < 0 {
			secDBMu.Unlock()
			s.fail(w, 404, "报告模板不存在")
			return
		}
		for i := range list {
			list[i].IsDefault = (i == found)
		}
		saveErr := s.saveSecReportTemplates(list)
		secDBMu.Unlock()
		if saveErr != nil {
			s.fail(w, 500, "设置默认模板失败")
			return
		}
		s.auditReq(r, "security-report-template-default", session.User, fmt.Sprintf("%s (%s)", list[found].Name, id))
		s.writeJSON(w, 200, map[string]any{"templates": list})

	case len(parts) == 2 && parts[1] == "reset" && r.Method == "POST":
		id := strings.TrimSpace(parts[0])
		defTpl, ok := builtinSecReportTemplateByID(id)
		if !ok {
			s.fail(w, 400, "仅支持重置内置报告模板")
			return
		}
		secDBMu.Lock()
		list := s.loadSecReportTemplates()
		idx := -1
		for i := range list {
			if list[i].ID == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			secDBMu.Unlock()
			s.fail(w, 404, "报告模板不存在")
			return
		}
		defTpl.IsDefault = list[idx].IsDefault
		defTpl.UpdatedAt = now()
		defTpl.UpdatedBy = session.User
		list[idx] = defTpl
		list = ensureSingleDefaultTemplate(list)
		saveErr := s.saveSecReportTemplates(list)
		secDBMu.Unlock()
		if saveErr != nil {
			s.fail(w, 500, "重置报告模板失败")
			return
		}
		s.auditReq(r, "security-report-template-reset", session.User, fmt.Sprintf("%s (%s)", defTpl.Name, id))
		s.writeJSON(w, 200, map[string]any{"template": list[idx], "templates": list})

	default:
		s.fail(w, 404, "接口不存在")
	}
}

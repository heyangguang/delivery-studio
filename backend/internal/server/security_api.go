package server

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// HTTP API handlers for the Enterprise Security & CVE Vulnerability Center (/api/security/*).

func (s *storeServer) handleSecurity(w http.ResponseWriter, r *http.Request, session storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/security"), "/")
	switch {
	case (rest == "" || rest == "overview") && r.Method == "GET":
		s.handleSecurityOverview(w, session)
	case rest == "summary" && r.Method == "GET":
		s.handleSecuritySummary(w, session)
	case rest == "scan" && r.Method == "POST":
		s.handleSecurityScan(w, r, session)
	case rest == "db/sync" && r.Method == "POST":
		s.handleSecurityDBSync(w, r, session)
	case rest == "db/export" && r.Method == "GET":
		s.handleSecurityDBExport(w, r, session)
	case rest == "db/import" && r.Method == "POST":
		s.handleSecurityDBImport(w, r, session)
	case rest == "triage" && r.Method == "POST":
		s.handleSecurityTriage(w, r, session)
	case rest == "triage/batch" && r.Method == "POST":
		s.handleSecurityTriageBatch(w, r, session)
	case rest == "policy" && r.Method == "PUT":
		s.handleSecurityPolicy(w, r, session)
	case rest == "export" && r.Method == "GET":
		s.handleSecurityExport(w, r, session)
	case rest == "supply-chain" && r.Method == "GET":
		s.handleSecuritySupplyChain(w, r, session)
	case rest == "history" && r.Method == "GET":
		s.handleSecurityHistory(w, session)
	case rest == "ai-analyze" && r.Method == "POST":
		s.handleSecurityAIAnalyze(w, r, session)
	case rest == "ai-polish" && r.Method == "POST":
		s.handleSecurityAIPolish(w, r, session)
	case rest == "ai" || strings.HasPrefix(rest, "ai/"):
		sub := strings.TrimPrefix(rest, "ai")
		sub = strings.Trim(sub, "/")
		var parts []string
		if sub != "" {
			parts = strings.Split(sub, "/")
		}
		s.handleSecurityAI(w, r, session, parts)
	case rest == "sources" || strings.HasPrefix(rest, "sources/"):
		sub := strings.TrimPrefix(rest, "sources")
		sub = strings.Trim(sub, "/")
		var parts []string
		if sub != "" {
			parts = strings.Split(sub, "/")
		}
		s.handleSecuritySources(w, r, session, parts)
	case rest == "ignores" || strings.HasPrefix(rest, "ignores/"):
		sub := strings.TrimPrefix(rest, "ignores")
		sub = strings.Trim(sub, "/")
		var parts []string
		if sub != "" {
			parts = strings.Split(sub, "/")
		}
		s.handleSecurityIgnores(w, r, session, parts)
	case rest == "report-templates" || strings.HasPrefix(rest, "report-templates/"):
		sub := strings.TrimPrefix(rest, "report-templates")
		sub = strings.Trim(sub, "/")
		var parts []string
		if sub != "" {
			parts = strings.Split(sub, "/")
		}
		s.handleSecurityReportTemplates(w, r, session, parts)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) handleSecurityOverview(w http.ResponseWriter, session storeSession) {
	secDBMu.Lock()
	meta := s.loadSecMeta()
	policy := s.loadSecPolicy()
	rawRep := s.loadLatestScan()
	sources := s.loadSecSources()
	reportTemplates := s.loadSecReportTemplates()
	secDBMu.Unlock()

	secSyncMu.Lock()
	syncSt := secSyncSt
	secSyncMu.Unlock()

	rep := s.scopedScanReport(rawRep, session.User)
	s.writeJSON(w, 200, map[string]any{
		"meta":             meta,
		"policy":           policy,
		"sync":             syncSt,
		"report":           rep,
		"sources":          sanitizeSecSourcesForAPI(sources),
		"report_templates": reportTemplates,
	})
}

// handleSecuritySummary returns lightweight active risk badges for component/library/cluster pages.
func (s *storeServer) handleSecuritySummary(w http.ResponseWriter, session storeSession) {
	secDBMu.Lock()
	meta := s.loadSecMeta()
	policy := s.loadSecPolicy()
	rawRep := s.loadLatestScan()
	secDBMu.Unlock()

	if rawRep == nil {
		s.writeJSON(w, 200, map[string]any{
			"has_scan":        false,
			"advisory_count":  meta.AdvisoryCount,
			"policy":          policy,
			"component_risks": map[string]secCompRiskBadge{},
			"active_counts":   secSeverityCounts{},
		})
		return
	}
	rep := s.scopedScanReport(rawRep, session.User)
	s.writeJSON(w, 200, map[string]any{
		"has_scan":                     true,
		"scanned_at":                   rep.ScannedAt,
		"advisory_count":               meta.AdvisoryCount,
		"policy":                       policy,
		"active_counts":                rep.ActiveCounts,
		"middleware_counts":            rep.MiddlewareCounts,
		"os_counts":                    rep.OSCounts,
		"runtime_counts":               rep.RuntimeCounts,
		"suppressed_count":             rep.SuppressedCount,
		"suppressed_os_count":          rep.SuppressedOSCount,
		"suppressed_runtime_count":     rep.SuppressedRuntimeCount,
		"suppressed_pkg_count":         rep.SuppressedPkgCount,
		"affected_clusters":            rep.AffectedClusters,
		"middleware_affected_clusters": rep.MiddlewareAffectedClusters,
		"os_affected_clusters":         rep.OSAffectedClusters,
		"component_risks":              rep.ComponentRisks,
	})
}

func (s *storeServer) handleSecurityScan(w http.ResponseWriter, r *http.Request, session storeSession) {
	rep := s.runSecurityScan(session.User, true)
	s.auditReq(r, "security-scan", session.User, fmt.Sprintf("active=%d critical=%d high=%d", rep.ActiveCounts.Total, rep.ActiveCounts.Critical, rep.ActiveCounts.High))
	secDBMu.Lock()
	meta := s.loadSecMeta()
	policy := s.loadSecPolicy()
	secDBMu.Unlock()
	s.writeJSON(w, 200, map[string]any{
		"meta":   meta,
		"policy": policy,
		"report": s.scopedScanReport(rep, session.User),
	})
}

func (s *storeServer) handleSecurityDBSync(w http.ResponseWriter, r *http.Request, session storeSession) {
	var in struct {
		SourceID string `json:"source_id"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in)
	}
	meta, err := s.syncSecurityDBFromSources(r.Context(), session.User, strings.TrimSpace(in.SourceID))
	if err != nil {
		s.fail(w, 502, err.Error())
		return
	}
	rep := s.runSecurityScan(session.User, true)
	s.auditReq(r, "security-db-sync", session.User, fmt.Sprintf("source=%s advisories=%d active=%d", firstNonEmptyStr(in.SourceID, "all"), meta.AdvisoryCount, rep.ActiveCounts.Total))
	secDBMu.Lock()
	policy := s.loadSecPolicy()
	sources := s.loadSecSources()
	secDBMu.Unlock()
	s.writeJSON(w, 200, map[string]any{
		"meta":    meta,
		"policy":  policy,
		"sources": sanitizeSecSourcesForAPI(sources),
		"report":  s.scopedScanReport(rep, session.User),
	})
}

func (s *storeServer) handleSecurityDBExport(w http.ResponseWriter, r *http.Request, session storeSession) {
	var buf bytes.Buffer
	if err := s.exportSecurityDBBundle(&buf); err != nil {
		s.fail(w, 500, "导出离线漏洞库失败："+err.Error())
		return
	}
	fname := "mh-cve-db-" + time.Now().UTC().Format("20060102") + ".tar.gz"
	s.auditReq(r, "security-db-export", session.User, fname)
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+fname+`"`)
	_, _ = w.Write(buf.Bytes())
}

func (s *storeServer) handleSecurityDBImport(w http.ResponseWriter, r *http.Request, session storeSession) {
	replace := r.URL.Query().Get("replace") == "1"
	var raw []byte
	var err error
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			s.fail(w, 400, "无法读取上传的文件（上限 64MB）")
			return
		}
		if r.FormValue("replace") == "1" || r.FormValue("replace") == "true" {
			replace = true
		}
		f, _, ferr := r.FormFile("file")
		if ferr != nil {
			s.fail(w, 400, "请选择要导入的离线漏洞库包（.tar.gz 或 .json）")
			return
		}
		defer f.Close()
		raw, err = io.ReadAll(io.LimitReader(f, 64<<20))
	} else {
		raw, err = io.ReadAll(io.LimitReader(r.Body, 64<<20))
	}
	if err != nil {
		s.fail(w, 400, "读取上传文件失败")
		return
	}
	meta, importedN, err := s.importSecurityDBBundle(raw, replace, session.User)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	rep := s.runSecurityScan(session.User, true)
	s.auditReq(r, "security-db-import", session.User, fmt.Sprintf("imported=%d total=%d", importedN, meta.AdvisoryCount))
	secDBMu.Lock()
	policy := s.loadSecPolicy()
	secDBMu.Unlock()
	s.writeJSON(w, 200, map[string]any{
		"imported": importedN,
		"meta":     meta,
		"policy":   policy,
		"report":   s.scopedScanReport(rep, session.User),
	})
}

func (s *storeServer) handleSecurityTriage(w http.ResponseWriter, r *http.Request, session storeSession) {
	var in struct {
		VulnID            string `json:"vuln_id"`
		Package           string `json:"package"`
		Ecosystem         string `json:"ecosystem"`
		Global            bool   `json:"global"`
		Status            string `json:"status"`        // open | planned | mitigated | not_affected | accepted
		Justification     string `json:"justification"` // optional VEX justification
		Note              string `json:"note"`
		ExpiresAt         string `json:"expires_at"` // optional YYYY-MM-DD
		LinkedClusterID   string `json:"linked_cluster_id"`
		LinkedRehearsalID string `json:"linked_rehearsal_id"`
		LinkedSOPDocID    string `json:"linked_sop_doc_id"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in) != nil {
		s.fail(w, 400, "请求内容格式错误")
		return
	}
	in.VulnID = strings.ToUpper(strings.TrimSpace(in.VulnID))
	in.Package = strings.TrimSpace(in.Package)
	in.Ecosystem = strings.TrimSpace(in.Ecosystem)
	in.Status = strings.ToLower(strings.TrimSpace(in.Status))
	in.Justification = strings.TrimSpace(in.Justification)
	in.Note = truncRunes(strings.TrimSpace(in.Note), 500)
	in.ExpiresAt = strings.TrimSpace(in.ExpiresAt)

	validStatus := map[string]bool{"open": true, "planned": true, "mitigated": true, "not_affected": true, "accepted": true}
	if in.VulnID == "" || !validStatus[in.Status] {
		s.fail(w, 400, "请提供有效的漏洞编号与处置状态")
		return
	}
	if in.ExpiresAt != "" {
		if _, err := time.Parse("2006-01-02", in.ExpiresAt); err != nil {
			s.fail(w, 400, "豁免到期日期格式应为 YYYY-MM-DD")
			return
		}
	}
	if (in.Status == "accepted" || in.Status == "not_affected" || in.Status == "mitigated") && in.Note == "" && in.Justification == "" {
		s.fail(w, 400, "标记缓解、不适用或风险豁免时请填写评估依据或说明")
		return
	}

	key := in.VulnID
	if !in.Global && in.Package != "" && in.Ecosystem != "" {
		key = in.VulnID + "|" + strings.ToLower(in.Package) + "|" + normalizeEcoKey(in.Ecosystem)
	}
	stamp := now()

	secDBMu.Lock()
	triageMap := s.loadSecTriage()
	prev := triageMap[key]
	hist := append([]secTriageEvent(nil), prev.History...)
	hist = append([]secTriageEvent{{
		Status:    in.Status,
		Note:      in.Note,
		ExpiresAt: in.ExpiresAt,
		By:        session.User,
		At:        stamp,
	}}, hist...)
	if len(hist) > 20 {
		hist = hist[:20]
	}
	rec := secTriageRecord{
		Key:               key,
		VulnID:            in.VulnID,
		Package:           in.Package,
		Ecosystem:         in.Ecosystem,
		Status:            in.Status,
		Justification:     in.Justification,
		Note:              in.Note,
		ExpiresAt:         in.ExpiresAt,
		LinkedClusterID:   strings.TrimSpace(in.LinkedClusterID),
		LinkedRehearsalID: strings.TrimSpace(in.LinkedRehearsalID),
		LinkedSOPDocID:    strings.TrimSpace(in.LinkedSOPDocID),
		UpdatedBy:         session.User,
		UpdatedAt:         stamp,
		History:           hist,
	}
	triageMap[key] = rec
	if err := s.saveSecTriage(triageMap); err != nil {
		secDBMu.Unlock()
		s.fail(w, 500, "保存处置记录失败")
		return
	}
	rawRep := s.loadLatestScan()
	secDBMu.Unlock()

	s.auditReq(r, "security-triage", session.User, fmt.Sprintf("%s -> %s", key, in.Status))
	s.writeJSON(w, 200, map[string]any{
		"record": rec,
		"report": s.scopedScanReport(rawRep, session.User),
	})
}

func (s *storeServer) handleSecurityTriageBatch(w http.ResponseWriter, r *http.Request, session storeSession) {
	var in struct {
		Items []struct {
			VulnID    string `json:"vuln_id"`
			Package   string `json:"package"`
			Ecosystem string `json:"ecosystem"`
		} `json:"items"`
		Global            bool   `json:"global"`
		Status            string `json:"status"`
		Justification     string `json:"justification"`
		Note              string `json:"note"`
		ExpiresAt         string `json:"expires_at"`
		LinkedClusterID   string `json:"linked_cluster_id"`
		LinkedRehearsalID string `json:"linked_rehearsal_id"`
		LinkedSOPDocID    string `json:"linked_sop_doc_id"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<18)).Decode(&in) != nil {
		s.fail(w, 400, "请求内容格式错误")
		return
	}
	in.Status = strings.ToLower(strings.TrimSpace(in.Status))
	in.Justification = strings.TrimSpace(in.Justification)
	in.Note = truncRunes(strings.TrimSpace(in.Note), 500)
	in.ExpiresAt = strings.TrimSpace(in.ExpiresAt)
	validStatus := map[string]bool{"open": true, "planned": true, "mitigated": true, "not_affected": true, "accepted": true}
	if len(in.Items) == 0 || len(in.Items) > 500 || !validStatus[in.Status] {
		s.fail(w, 400, "请选择要批量处置的漏洞并提供有效状态（单次上限 500 条）")
		return
	}
	if in.ExpiresAt != "" {
		if _, err := time.Parse("2006-01-02", in.ExpiresAt); err != nil {
			s.fail(w, 400, "豁免到期日期格式应为 YYYY-MM-DD")
			return
		}
	}
	if (in.Status == "accepted" || in.Status == "not_affected" || in.Status == "mitigated") && in.Note == "" && in.Justification == "" {
		s.fail(w, 400, "标记缓解、不适用或风险豁免时请填写评估依据或说明")
		return
	}
	stamp := now()
	updated := 0
	secDBMu.Lock()
	triageMap := s.loadSecTriage()
	for _, it := range in.Items {
		vid := strings.ToUpper(strings.TrimSpace(it.VulnID))
		if vid == "" {
			continue
		}
		pkg := strings.TrimSpace(it.Package)
		eco := strings.TrimSpace(it.Ecosystem)
		key := vid
		if !in.Global && pkg != "" && eco != "" {
			key = vid + "|" + strings.ToLower(pkg) + "|" + normalizeEcoKey(eco)
		}
		prev := triageMap[key]
		hist := append([]secTriageEvent{{
			Status:    in.Status,
			Note:      in.Note,
			ExpiresAt: in.ExpiresAt,
			By:        session.User,
			At:        stamp,
		}}, prev.History...)
		if len(hist) > 20 {
			hist = hist[:20]
		}
		triageMap[key] = secTriageRecord{
			Key:               key,
			VulnID:            vid,
			Package:           pkg,
			Ecosystem:         eco,
			Status:            in.Status,
			Justification:     in.Justification,
			Note:              in.Note,
			ExpiresAt:         in.ExpiresAt,
			LinkedClusterID:   firstNonEmptyStr(strings.TrimSpace(in.LinkedClusterID), prev.LinkedClusterID),
			LinkedRehearsalID: firstNonEmptyStr(strings.TrimSpace(in.LinkedRehearsalID), prev.LinkedRehearsalID),
			LinkedSOPDocID:    firstNonEmptyStr(strings.TrimSpace(in.LinkedSOPDocID), prev.LinkedSOPDocID),
			UpdatedBy:         session.User,
			UpdatedAt:         stamp,
			History:           hist,
		}
		updated++
	}
	err := s.saveSecTriage(triageMap)
	rawRep := s.loadLatestScan()
	secDBMu.Unlock()
	if err != nil {
		s.fail(w, 500, "批量保存处置记录失败")
		return
	}
	s.auditReq(r, "security-triage-batch", session.User, fmt.Sprintf("count=%d status=%s", updated, in.Status))
	s.writeJSON(w, 200, map[string]any{
		"updated": updated,
		"report":  s.scopedScanReport(rawRep, session.User),
	})
}

func (s *storeServer) handleSecuritySupplyChain(w http.ResponseWriter, r *http.Request, session storeSession) {
	verify := r.URL.Query().Get("verify") == "1" || r.URL.Query().Get("verify") == "true"
	rep := s.checkSupplyChainIntegrity(verify)
	if verify {
		s.auditReq(r, "security-supply-verify", session.User, fmt.Sprintf("healthy=%v issues=%d", rep.OverallHealthy, rep.TotalIssues))
	}
	s.writeJSON(w, 200, rep)
}

func (s *storeServer) handleSecurityHistory(w http.ResponseWriter, session storeSession) {
	secDBMu.Lock()
	hist := s.loadSecHistory()
	secDBMu.Unlock()
	// Strip bulky active_keys from API response.
	out := make([]secScanHistoryEntry, len(hist))
	for i, h := range hist {
		h.ActiveKeys = nil
		out[i] = h
	}
	s.writeJSON(w, 200, out)
}

func (s *storeServer) handleSecurityPolicy(w http.ResponseWriter, r *http.Request, session storeSession) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<16))
	if err != nil {
		s.fail(w, 400, "请求内容有问题")
		return
	}
	var rawMap map[string]json.RawMessage
	if json.Unmarshal(raw, &rawMap) != nil {
		s.fail(w, 400, "请求内容有问题")
		return
	}
	var in secPolicy
	if json.Unmarshal(raw, &in) != nil {
		s.fail(w, 400, "请求内容有问题")
		return
	}
	secDBMu.Lock()
	cur := s.loadSecPolicy()
	if _, hasIgnored := rawMap["ignored_packages"]; !hasIgnored {
		in.IgnoredPackages = cur.IgnoredPackages
	}
	if in.IgnoredPackages == nil {
		in.IgnoredPackages = []secIgnoreRule{}
	}
	saveErr := s.saveSecPolicy(in)
	secDBMu.Unlock()
	if saveErr != nil {
		s.fail(w, 500, "保存安全门禁策略失败")
		return
	}
	s.auditReq(r, "security-policy", session.User, fmt.Sprintf("block_publish=%v hide_os=%v hide_rt=%v mw_only=%v notify=%v", in.BlockPublishCritical, in.HideOSCVEs, in.HideRuntimeCVEs, in.GateMiddlewareOnly, in.NotifyOnScan))
	s.writeJSON(w, 200, in)
}

func (s *storeServer) handleSecurityIgnores(w http.ResponseWriter, r *http.Request, session storeSession, parts []string) {
	switch {
	case len(parts) == 0 && r.Method == "GET":
		secDBMu.Lock()
		pol := s.loadSecPolicy()
		secDBMu.Unlock()
		s.writeJSON(w, 200, pol.IgnoredPackages)

	case len(parts) == 0 && r.Method == "POST":
		var in struct {
			Package       string `json:"package"`
			EcoKey        string `json:"eco_key"`
			Ecosystem     string `json:"ecosystem"`
			AllEcosystems bool   `json:"all_ecosystems"`
			PkgRole       string `json:"pkg_role"`
			Note          string `json:"note"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in) != nil {
			s.fail(w, 400, "请求内容格式错误")
			return
		}
		pkg := strings.TrimSpace(in.Package)
		if pkg == "" || len(pkg) > 128 {
			s.fail(w, 400, "请提供有效的软件包名称")
			return
		}
		ecoKey := strings.TrimSpace(in.EcoKey)
		ecoDisp := strings.TrimSpace(in.Ecosystem)
		if in.AllEcosystems || ecoKey == "" || ecoKey == "*" {
			ecoKey = "*"
			ecoDisp = ""
		} else {
			ecoKey = normalizeEcoKey(ecoKey)
		}
		rule := secIgnoreRule{
			ID:        normalizeSecIgnoreRuleID(pkg, ecoKey),
			Kind:      "package",
			Package:   pkg,
			EcoKey:    ecoKey,
			Ecosystem: ecoDisp,
			PkgRole:   strings.TrimSpace(in.PkgRole),
			Note:      truncRunes(strings.TrimSpace(in.Note), 240),
			By:        session.User,
			At:        now(),
		}
		secDBMu.Lock()
		pol := s.loadSecPolicy()
		replaced := false
		for i := range pol.IgnoredPackages {
			if pol.IgnoredPackages[i].ID == rule.ID {
				pol.IgnoredPackages[i] = rule
				replaced = true
				break
			}
		}
		if !replaced {
			pol.IgnoredPackages = append([]secIgnoreRule{rule}, pol.IgnoredPackages...)
		}
		saveErr := s.saveSecPolicy(pol)
		rawRep := s.loadLatestScan()
		secDBMu.Unlock()
		if saveErr != nil {
			s.fail(w, 500, "保存全局忽略规则失败")
			return
		}
		s.auditReq(r, "security-ignore-add", session.User, fmt.Sprintf("%s (%s)", rule.ID, rule.Note))
		s.writeJSON(w, 200, map[string]any{
			"rule":   rule,
			"policy": pol,
			"report": s.scopedScanReport(rawRep, session.User),
		})

	case len(parts) >= 1 && r.Method == "DELETE":
		rawID := strings.Join(parts, "/")
		if dec, err := url.PathUnescape(rawID); err == nil {
			rawID = dec
		}
		rawID = strings.TrimSpace(rawID)
		if rawID == "" {
			s.fail(w, 400, "缺少忽略规则 ID")
			return
		}
		secDBMu.Lock()
		pol := s.loadSecPolicy()
		next := make([]secIgnoreRule, 0, len(pol.IgnoredPackages))
		removed := false
		for _, r0 := range pol.IgnoredPackages {
			if r0.ID == rawID {
				removed = true
				continue
			}
			next = append(next, r0)
		}
		if !removed {
			secDBMu.Unlock()
			s.fail(w, 404, "未找到对应的全局忽略规则")
			return
		}
		pol.IgnoredPackages = next
		saveErr := s.saveSecPolicy(pol)
		rawRep := s.loadLatestScan()
		secDBMu.Unlock()
		if saveErr != nil {
			s.fail(w, 500, "移除全局忽略规则失败")
			return
		}
		s.auditReq(r, "security-ignore-delete", session.User, rawID)
		s.writeJSON(w, 200, map[string]any{
			"policy": pol,
			"report": s.scopedScanReport(rawRep, session.User),
		})

	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) handleSecurityExport(w http.ResponseWriter, r *http.Request, session storeSession) {
	tplID := strings.TrimSpace(r.URL.Query().Get("template"))
	tpl := s.resolveSecReportTemplate(tplID)

	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "" {
		if tplID != "" {
			format = tpl.DefaultFormat
		} else {
			format = "csv"
		}
	}
	switch format {
	case "word":
		format = "docx"
	case "excel":
		format = "xlsx"
	case "htm":
		format = "html"
	}

	secDBMu.Lock()
	rawRep := s.loadLatestScan()
	secDBMu.Unlock()
	if rawRep == nil {
		rawRep = s.runSecurityScan(session.User, false)
	}
	rep := s.scopedScanReport(rawRep, session.User)
	clusterFilter := strings.TrimSpace(r.URL.Query().Get("cluster"))
	scopeFilter := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("scope")))
	switch scopeFilter {
	case "middleware":
		scopeFilter = "primary"
	case "os":
		scopeFilter = "dependency"
	}
	var clusterAudit *clusterSecurityReport
	if clusterFilter != "" {
		if cf, ok := s.clusterFactsFor(session.User, clusterFilter); ok {
			ca := s.auditClusterSecurity(session.User, cf)
			clusterAudit = &ca
		}
	}

	var incIgnoredOverride *bool
	if raw := strings.TrimSpace(r.URL.Query().Get("include_ignored")); raw != "" {
		v := raw == "1" || strings.EqualFold(raw, "true")
		incIgnoredOverride = &v
	}
	var incWaivedOverride *bool
	if raw := strings.TrimSpace(r.URL.Query().Get("include_waived")); raw != "" {
		v := raw == "1" || strings.EqualFold(raw, "true")
		incWaivedOverride = &v
	}

	stamp := time.Now().UTC().Format("20060102")
	slug := "global"
	if clusterAudit != nil {
		if clean := sanitizeExportFilenameSlug(clusterAudit.ClusterID); clean != "" {
			slug = clean
		}
	}

	// Resolve human-readable report author (honoring cluster doc meta > report settings > non-generic username).
	secAuthor := session.User
	if clusterAudit != nil {
		m := s.effectiveDocMeta(clusterAudit.ClusterID, "delivery", "")
		secAuthor = resolveReportSigner(session.User, m, "author", "")
	} else {
		rs := s.reportSettings()
		secAuthor = resolveReportSigner(session.User, docMeta{Author: rs.Author}, "author", "")
	}

	// Rich template-driven exports: Word (.docx), Excel (.xlsx), standalone HTML (.html).
	if format == "docx" || format == "xlsx" || format == "html" {
		ds := buildSecExportDataset(rep, clusterAudit, tpl, secAuthor, scopeFilter, incIgnoredOverride, incWaivedOverride)
		switch format {
		case "docx":
			data, err := renderSecurityDocx(ds)
			if err != nil {
				s.fail(w, 500, "生成 Word 安全报告失败："+err.Error())
				return
			}
			fname := fmt.Sprintf("mh-security-%s-%s.docx", slug, stamp)
			w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
			w.Header().Set("Content-Disposition", `attachment; filename="`+fname+`"`)
			_, _ = w.Write(data)
			return
		case "xlsx":
			data, err := renderSecurityXlsx(ds)
			if err != nil {
				s.fail(w, 500, "生成 Excel 安全报告失败："+err.Error())
				return
			}
			fname := fmt.Sprintf("mh-security-%s-%s.xlsx", slug, stamp)
			w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
			w.Header().Set("Content-Disposition", `attachment; filename="`+fname+`"`)
			_, _ = w.Write(data)
			return
		case "html":
			data := renderSecurityHTML(ds)
			fname := fmt.Sprintf("mh-security-%s-%s.html", slug, stamp)
			disp := "attachment"
			if r.URL.Query().Get("inline") == "1" || strings.EqualFold(r.URL.Query().Get("inline"), "true") {
				disp = "inline"
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Disposition", disp+`; filename="`+fname+`"`)
			// Isolate inline HTML preview into an opaque sandbox origin while allowing its self-contained filter script & print button.
			w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-modals allow-popups")
			_, _ = w.Write(data)
			return
		}
	}

	// Legacy / machine-readable formats (csv, cyclonedx, markdown) — preserve full backwards compatibility
	// while also honoring template filtering when ?template= is explicitly supplied.
	pkgRoleZH := secPkgRoleZH
	if clusterAudit != nil {
		rep.Findings = clusterAudit.Findings
		rep.ActiveCounts = clusterAudit.ActiveCounts
		rep.TotalCounts = clusterAudit.TotalCounts
		rep.MiddlewareCounts = clusterAudit.MiddlewareCounts
		rep.OSCounts = clusterAudit.OSCounts
		rep.Clusters = nil
	}
	if tplID != "" {
		ds := buildSecExportDataset(rep, clusterAudit, tpl, secAuthor, scopeFilter, incIgnoredOverride, incWaivedOverride)
		rep.Findings = ds.Findings
		rep.ActiveCounts = ds.ActiveCounts
		rep.TotalCounts = ds.TotalCounts
		rep.MiddlewareCounts = ds.MWCounts
		rep.OSCounts = ds.OSCounts
		rep.Clusters = ds.Clusters
	} else {
		includeIgnored := r.URL.Query().Get("include_ignored") == "1" || r.URL.Query().Get("include_ignored") == "true"
		if !includeIgnored {
			visible := make([]secFinding, 0, len(rep.Findings))
			for _, f := range rep.Findings {
				if f.GloballyIgnored {
					continue
				}
				visible = append(visible, f)
			}
			rep.Findings = visible
		}
		if scopeFilter == "primary" || scopeFilter == "dependency" || scopeFilter == "runtime" {
			filtered := make([]secFinding, 0, len(rep.Findings))
			var act, tot secSeverityCounts
			for _, f := range rep.Findings {
				if f.PkgRole != scopeFilter {
					continue
				}
				filtered = append(filtered, f)
				addSeverityCount(&tot, f.Severity)
				if !f.Waived && !f.GloballyIgnored {
					addSeverityCount(&act, f.Severity)
				}
			}
			rep.Findings = filtered
			rep.ActiveCounts = act
			rep.TotalCounts = tot
		}
	}

	switch format {
	case "csv":
		var buf bytes.Buffer
		// UTF-8 BOM for clean Excel opening on Windows
		buf.Write([]byte{0xEF, 0xBB, 0xBF})
		cw := csv.NewWriter(&buf)
		_ = cw.Write([]string{
			"CVE", "OSV ID", "分层来源", "严重等级", "CVSS", "生态", "软件包", "当前版本",
			"修复版本", "软件源已有修复版", "处置状态", "受影响组件", "受影响生产集群",
			"说明/备注", "官方链接",
		})
		for _, f := range rep.Findings {
			var comps, cls []string
			for _, c := range f.Components {
				comps = append(comps, fmt.Sprintf("%s %s (%s)", c.Title, c.Version, c.Platform))
			}
			for _, cl := range f.Clusters {
				cls = append(cls, fmt.Sprintf("%s [%d台]", cl.ClusterID, len(cl.Hosts)))
			}
			scoreStr := ""
			if f.CVSSScore > 0 {
				scoreStr = fmt.Sprintf("%.1f", f.CVSSScore)
			}
			_ = cw.Write([]string{
				f.CVE, f.ID, pkgRoleZH(f.PkgRole), f.Severity, scoreStr, f.Ecosystem, f.Package, f.InstalledVersion,
				strings.Join(f.FixedIn, "; "), f.RepoFixVersion, f.TriageStatus,
				strings.Join(comps, "; "), strings.Join(cls, "; "),
				firstNonEmptyStr(f.TriageNote, f.Summary), f.URL,
			})
		}
		cw.Flush()
		fname := "mh-cve-report-" + stamp + ".csv"
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="`+fname+`"`)
		_, _ = w.Write(buf.Bytes())

	case "cyclonedx", "sbom":
		inv := s.extractSBOM()
		components := make([]map[string]any, 0, len(inv.Items))
		for _, it := range inv.Items {
			c := map[string]any{
				"type":    "library",
				"bom-ref": it.PURL,
				"name":    it.Package,
				"version": it.Version,
				"purl":    it.PURL,
				"properties": []map[string]string{
					{"name": "mh:ecosystem", "value": it.Ecosystem},
					{"name": "mh:asset_type", "value": it.AssetType},
				},
			}
			if it.SHA256 != "" {
				c["hashes"] = []map[string]string{{"alg": "SHA-256", "content": it.SHA256}}
			}
			components = append(components, c)
		}
		vulns := make([]map[string]any, 0, len(rep.Findings))
		for _, f := range rep.Findings {
			ratings := []map[string]any{
				{"severity": strings.ToLower(f.Severity), "score": f.CVSSScore, "vector": f.CVSSVector, "method": "CVSSv31"},
			}
			vexState := map[string]string{
				"open":         "in_triage",
				"planned":      "exploitable",
				"mitigated":    "resolved_with_pedigree",
				"not_affected": "not_affected",
				"accepted":     "exploitable",
				"expired":      "in_triage",
			}[f.TriageStatus]
			v := map[string]any{
				"id":          f.CVE,
				"source":      map[string]string{"name": "OSV", "url": f.URL},
				"ratings":     ratings,
				"description": f.Summary,
				"affects": []map[string]any{
					{"ref": makePURL(f.EcoKey, f.Package, f.InstalledVersion)},
				},
				"analysis": map[string]any{
					"state":  vexState,
					"detail": f.TriageNote,
				},
			}
			vulns = append(vulns, v)
		}
		bom := map[string]any{
			"bomFormat":   "CycloneDX",
			"specVersion": "1.5",
			"version":     1,
			"metadata": map[string]any{
				"timestamp": now(),
				"tools":     []map[string]string{{"vendor": "Kyndryl Delivery Studio", "name": "Security Center"}},
			},
			"components":      components,
			"vulnerabilities": vulns,
		}
		fname := "mh-sbom-vex-" + stamp + ".cdx.json"
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="`+fname+`"`)
		b, _ := json.MarshalIndent(bom, "", "  ")
		_, _ = w.Write(b)

	case "markdown", "md":
		var sb strings.Builder
		if clusterAudit != nil {
			fmt.Fprintf(&sb, "# 集群安全评估报告：%s\n\n", clusterAudit.ClusterID)
			fmt.Fprintf(&sb, "- **应用与版本**：%s %s（%s）\n", clusterAudit.AppName, clusterAudit.Version, clusterAudit.Platform)
			fmt.Fprintf(&sb, "- **安全综合评分**：**%d 分（%s 级）**\n", clusterAudit.Score, clusterAudit.Grade)
			fmt.Fprintf(&sb, "- **扫描时间**：%s\n", firstNonEmptyStr(clusterAudit.ScannedAt, now()))
			fmt.Fprintf(&sb, "- **活跃漏洞**：严重 **%d** / 高危 **%d** / 中危 **%d** / 低危 **%d**（主包 %d / OS 库 %d）\n",
				clusterAudit.ActiveCounts.Critical, clusterAudit.ActiveCounts.High, clusterAudit.ActiveCounts.Medium, clusterAudit.ActiveCounts.Low,
				clusterAudit.PrimaryActive, clusterAudit.DependencyActive)
			fmt.Fprintf(&sb, "- **配置安全基线**：通过 **%d / %d** 项\n\n", clusterAudit.BaselinePassed, clusterAudit.BaselineTotal)
			if len(clusterAudit.BaselineChecks) > 0 {
				sb.WriteString("## 配置安全基线审计\n\n")
				sb.WriteString("| 检查项 | 风险等级 | 状态 | 说明 |\n|---|---|---|---|\n")
				for _, ck := range clusterAudit.BaselineChecks {
					fmt.Fprintf(&sb, "| %s | %s | %s | %s |\n", ck.Title, ck.Severity, ck.Status, ck.Detail)
				}
				sb.WriteString("\n")
			}
			if len(clusterAudit.Certs) > 0 {
				sb.WriteString("## TLS 证书有效期巡检\n\n")
				sb.WriteString("| 实例 | 角色 | 主题 CN | 密钥 | 到期日 | 剩余天数 | 状态 |\n|---|---|---|---|---|---:|---|\n")
				for _, c := range clusterAudit.Certs {
					fmt.Fprintf(&sb, "| %s | %s | %s | %s %d | %s | %d | %s |\n",
						c.Instance, c.Role, c.Subject, c.KeyAlgo, c.KeyBits, c.NotAfter, c.DaysLeft, c.Status)
				}
				sb.WriteString("\n")
			}
		} else {
			fmt.Fprintf(&sb, "# Kyndryl Delivery Studio 安全漏洞评估报告\n\n")
			fmt.Fprintf(&sb, "- **扫描时间**：%s\n", rep.ScannedAt)
			fmt.Fprintf(&sb, "- **漏洞库公告数**：%d 条（更新时间：%s）\n", rep.DBAdvisoryCount, firstNonEmptyStr(rep.DBUpdatedAt, "—"))
			fmt.Fprintf(&sb, "- **盘点资产包 (SBOM)**：%d 个（软件库闭包 %d / 运行环境 %d / 生产集群 %d）\n",
				rep.SBOMPackageCount, rep.ClosureCount, rep.RuntimeCount, rep.ClusterCount)
			fmt.Fprintf(&sb, "- **未豁免活跃风险**：严重 **%d** / 高危 **%d** / 中危 **%d** / 低危 **%d**（已缓解或豁免 %d 条）\n",
				rep.ActiveCounts.Critical, rep.ActiveCounts.High, rep.ActiveCounts.Medium, rep.ActiveCounts.Low, rep.WaivedCount)
			fmt.Fprintf(&sb, "- **风险来源分层**：中间件本体 **%d** 条（严 %d / 高 %d） · OS 底层包 **%d** 条（严 %d / 高 %d） · 运行环境 **%d** 条\n",
				rep.MiddlewareCounts.Total, rep.MiddlewareCounts.Critical, rep.MiddlewareCounts.High,
				rep.OSCounts.Total, rep.OSCounts.Critical, rep.OSCounts.High, rep.RuntimeCounts.Total)
			fmt.Fprintf(&sb, "- **受影响生产集群**：共 **%d** 个（其中中间件本体受影响 **%d** 个，OS 底层包受影响 **%d** 个）\n\n",
				rep.AffectedClusters, rep.MiddlewareAffectedClusters, rep.OSAffectedClusters)
		}

		if len(rep.Clusters) > 0 {
			sb.WriteString("## 受影响生产集群一览\n\n")
			sb.WriteString("| 集群 | 应用/版本 | 系统 | 主机数 | 中间件(严/高/总) | OS 底层包(严/高/总) | 负责人 |\n")
			sb.WriteString("|---|---|---|---:|---:|---:|---|\n")
			for _, cs := range rep.Clusters {
				if cs.Active.Total == 0 {
					continue
				}
				fmt.Fprintf(&sb, "| %s | %s %s | %s | %d | %d / %d / %d | %d / %d / %d | %s |\n",
					cs.ClusterID, cs.AppName, cs.Version, cs.Platform, len(cs.Hosts),
					cs.MiddlewareActive.Critical, cs.MiddlewareActive.High, cs.MiddlewareActive.Total,
					cs.OSActive.Critical, cs.OSActive.High, cs.OSActive.Total, cs.Owner)
			}
			sb.WriteString("\n")
		}

		sb.WriteString("## 漏洞明细清单\n\n")
		sb.WriteString("| CVE | 分层来源 | 等级 | CVSS | 软件包 | 当前版本 | 修复版本 | 处置状态 | 受影响集群 |\n")
		sb.WriteString("|---|---|---|---:|---|---|---|---|---|\n")
		for _, f := range rep.Findings {
			var cls []string
			for _, cl := range f.Clusters {
				cls = append(cls, cl.ClusterID)
			}
			score := "—"
			if f.CVSSScore > 0 {
				score = fmt.Sprintf("%.1f", f.CVSSScore)
			}
			fix := strings.Join(f.FixedIn, ", ")
			if fix == "" {
				fix = "待官方修复"
			}
			fmt.Fprintf(&sb, "| %s | %s | %s | %s | %s | `%s` | `%s` | %s | %s |\n",
				f.CVE, pkgRoleZH(f.PkgRole), f.Severity, score, f.Package, f.InstalledVersion, fix, f.TriageStatus, strings.Join(cls, ", "))
		}
		fname := "mh-cve-report-" + stamp + ".md"
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="`+fname+`"`)
		_, _ = w.Write([]byte(sb.String()))

	default:
		s.fail(w, 400, "不支持的导出格式（支持 docx、xlsx、html、markdown、csv、cyclonedx）")
	}
}

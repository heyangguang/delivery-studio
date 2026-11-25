package server

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"delivery-studio/mwpack"
)

// Cluster Security Posture Audit (CVE + Config Baseline + X.509 Cert Watch),
// Software Library Supply-Chain Integrity Check, and On-Demand AI CVE Analysis.

type secBaselineCheck struct {
	ID            string `json:"id"`
	Category      string `json:"category"` // encryption | network | architecture | certificate
	Title         string `json:"title"`
	Severity      string `json:"severity"` // CRITICAL | HIGH | MEDIUM | LOW | INFO
	Status        string `json:"status"`   // pass | fail | warn | waived
	Detail        string `json:"detail"`
	Recommendation string `json:"recommendation,omitempty"`
	Target        string `json:"target,omitempty"` // instance or param path
	RehearsalKind string `json:"rehearsal_kind,omitempty"` // config_hardening | cert_rotation
	RehearsalGoal string `json:"rehearsal_goal,omitempty"`
	Waived        bool   `json:"waived,omitempty"`
	WaiveNote     string `json:"waive_note,omitempty"`
	WaiveBy       string `json:"waive_by,omitempty"`
	WaiveAt       string `json:"waive_at,omitempty"`
}

type secCertCheck struct {
	Instance     string   `json:"instance"`
	Bundle       string   `json:"bundle"`
	Role         string   `json:"role"` // server | ca
	Subject      string   `json:"subject"`
	Issuer       string   `json:"issuer"`
	SANs         []string `json:"sans,omitempty"`
	NotBefore    string   `json:"not_before"`
	NotAfter     string   `json:"not_after"`
	DaysLeft     int      `json:"days_left"`
	KeyAlgo      string   `json:"key_algo"`
	KeyBits      int      `json:"key_bits"`
	SigAlgo      string   `json:"sig_algo"`
	IsSelfSigned bool     `json:"is_self_signed,omitempty"`
	Status       string   `json:"status"` // ok | expiring | critical | expired
}

type secScoreDeduction struct {
	Reason string `json:"reason"`
	Points int    `json:"points"`
}

type secLinkedRehearsal struct {
	ID              string                    `json:"id"`
	Title           string                    `json:"title"`
	Stage           string                    `json:"stage"`
	Owner           string                    `json:"owner"`
	DocID           string                    `json:"doc_id,omitempty"`
	UpdatedAt       string                    `json:"updated_at"`
	SecurityContext *rehearsalSecurityContext `json:"security_context,omitempty"`
}

type clusterSecurityReport struct {
	ClusterID         string               `json:"cluster_id"`
	AppID             string               `json:"app_id"`
	AppName           string               `json:"app_name"`
	Version           string               `json:"version"`
	Platform          string               `json:"platform"`
	DeliveryMode      string               `json:"delivery_mode"`
	Hosts             []string             `json:"hosts"`
	ScannedAt         string               `json:"scanned_at,omitempty"`
	HasScan           bool                 `json:"has_scan"`
	Score             int                  `json:"score"`
	Grade             string               `json:"grade"` // A | B | C | D
	Deductions        []secScoreDeduction  `json:"deductions"`
	ActiveCounts        secSeverityCounts    `json:"active_counts"`
	TotalCounts         secSeverityCounts    `json:"total_counts"`
	MiddlewareCounts    secSeverityCounts    `json:"middleware_counts"`
	OSCounts            secSeverityCounts    `json:"os_counts"`
	GateMiddlewareOnly  bool                 `json:"gate_middleware_only,omitempty"`
	HideOSCVEs          bool                 `json:"hide_os_cves,omitempty"`
	HideRuntimeCVEs     bool                 `json:"hide_runtime_cves,omitempty"`
	IgnoredPackageCount int                  `json:"ignored_package_count,omitempty"`
	SuppressedCount     int                  `json:"suppressed_count,omitempty"`
	SuppressedOSCount   int                  `json:"suppressed_os_count,omitempty"`
	SuppressedPkgCount  int                  `json:"suppressed_pkg_count,omitempty"`
	PrimaryActive       int                  `json:"primary_active"`
	DependencyActive    int                  `json:"dependency_active"`
	RepoFixReadyCount   int                  `json:"repo_fix_ready_count"`
	Findings          []secFinding         `json:"findings"`
	PackageGroups     []secPackageGroup    `json:"package_groups"`
	BaselineChecks    []secBaselineCheck   `json:"baseline_checks"`
	BaselinePassed    int                  `json:"baseline_passed"`
	BaselineTotal     int                  `json:"baseline_total"`
	Certs             []secCertCheck       `json:"certs"`
	CertExpiring      int                  `json:"cert_expiring"`
	Rehearsals        []secLinkedRehearsal `json:"rehearsals"`
}

func (s *storeServer) handleClusterSecurity(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, parts []string) {
	switch {
	case len(parts) == 0 && r.Method == "GET":
		rep := s.auditClusterSecurity(session.User, f)
		s.writeJSON(w, 200, rep)
	case len(parts) == 1 && parts[0] == "baseline-waive" && r.Method == "POST":
		var in struct {
			CheckID string `json:"check_id"`
			Waived  bool   `json:"waived"`
			Note    string `json:"note"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
			s.fail(w, 400, "请求格式错误")
			return
		}
		in.CheckID = strings.TrimSpace(in.CheckID)
		in.Note = truncRunes(strings.TrimSpace(in.Note), 300)
		if in.CheckID == "" {
			s.fail(w, 400, "缺少基线检查项 ID")
			return
		}
		if in.Waived && in.Note == "" {
			s.fail(w, 400, "豁免配置基线项时请填写说明原因")
			return
		}
		secDBMu.Lock()
		waivers := s.loadSecBaselineWaivers()
		key := f.ID + "|" + in.CheckID
		if in.Waived {
			waivers[key] = secBaselineWaiver{
				ClusterID: f.ID,
				CheckID:   in.CheckID,
				Note:      in.Note,
				By:        session.User,
				At:        now(),
			}
		} else {
			delete(waivers, key)
		}
		err := s.saveSecBaselineWaivers(waivers)
		secDBMu.Unlock()
		if err != nil {
			s.fail(w, 500, "保存基线豁免记录失败")
			return
		}
		s.auditReq(r, "security-baseline-waive", session.User, fmt.Sprintf("%s %s waived=%v", f.ID, in.CheckID, in.Waived))
		s.writeJSON(w, 200, s.auditClusterSecurity(session.User, f))
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) auditClusterSecurity(user string, f clusterFacts) clusterSecurityReport {
	dep := s.readSpec(f.Current.ID)
	pl := mwpack.DefaultPlatform
	if dep != nil && dep.Platform != "" {
		pl = dep.Platform
	} else if f.Plan != nil && len(f.Plan.Platforms) > 0 {
		pl = f.Plan.Platforms[0]
	}
	var hosts []string
	if dep != nil {
		for _, h := range dep.Hosts {
			if h.IP != "" {
				hosts = append(hosts, fmt.Sprintf("%s (%s)", h.Name, h.IP))
			} else if h.Name != "" {
				hosts = append(hosts, h.Name)
			}
		}
	}
	rawMode := f.Current.DeliveryMode
	if dep != nil && dep.DeliveryMode != "" {
		rawMode = dep.DeliveryMode
	}
	autoJobs := s.autoExecutedJobs()
	effMode := effectiveDeliveryMode(f.Current.ID, rawMode, autoJobs)

	rep := clusterSecurityReport{
		ClusterID:      f.ID,
		AppID:          f.Current.AppID,
		AppName:        firstNonEmptyStr(f.Current.AppName, f.Current.AppID),
		Version:        f.Current.Version,
		Platform:       pl,
		DeliveryMode:   effMode,
		Hosts:          nz(hosts),
		Deductions:     []secScoreDeduction{},
		Findings:       []secFinding{},
		PackageGroups:  []secPackageGroup{},
		BaselineChecks: []secBaselineCheck{},
		Certs:          []secCertCheck{},
		Rehearsals:     []secLinkedRehearsal{},
	}

	// 1. Scoped CVE findings for this cluster.
	secDBMu.Lock()
	rawScan := s.loadLatestScan()
	waivers := s.loadSecBaselineWaivers()
	policy := s.loadSecPolicy()
	secDBMu.Unlock()
	rep.GateMiddlewareOnly = policy.GateMiddlewareOnly
	rep.HideOSCVEs = policy.HideOSCVEs
	rep.HideRuntimeCVEs = policy.HideRuntimeCVEs
	rep.IgnoredPackageCount = len(policy.IgnoredPackages)

	if rawScan != nil {
		rep.HasScan = true
		rep.ScannedAt = rawScan.ScannedAt
		scoped := s.scopedScanReport(rawScan, user)
		for _, fd := range scoped.Findings {
			hit := false
			for _, cl := range fd.Clusters {
				if cl.ClusterID == f.ID {
					hit = true
					break
				}
			}
			if !hit {
				continue
			}
			rep.Findings = append(rep.Findings, fd)
			addSeverityCount(&rep.TotalCounts, fd.Severity)
			if fd.GloballyIgnored {
				rep.SuppressedCount++
				if fd.IgnoreRuleID == "layer:os" {
					rep.SuppressedOSCount++
				} else {
					rep.SuppressedPkgCount++
				}
				continue
			}
			if fd.Waived {
				continue
			}
			addSeverityCount(&rep.ActiveCounts, fd.Severity)
			if fd.PkgRole == "primary" {
				rep.PrimaryActive++
				addSeverityCount(&rep.MiddlewareCounts, fd.Severity)
			} else {
				rep.DependencyActive++
				addSeverityCount(&rep.OSCounts, fd.Severity)
			}
		}
		rep.PackageGroups = buildPackageGroups(rep.Findings)
		for _, pg := range rep.PackageGroups {
			if pg.ActiveCount > 0 && pg.RepoFixVersion != "" {
				rep.RepoFixReadyCount++
			}
		}
	}

	// 2. TLS certificate inspection from delivery materials (supports versioned change projects like .01 and historical plan fallback).
	certs := s.inspectClusterCertificates(f)
	rep.Certs = certs
	var expiredCerts, critCerts, expiringCerts, weakCerts []string
	for _, c := range certs {
		if c.Role == "server" {
			switch c.Status {
			case "expired":
				expiredCerts = append(expiredCerts, fmt.Sprintf("%s (%s)", c.Instance, c.Subject))
				rep.CertExpiring++
			case "critical":
				critCerts = append(critCerts, fmt.Sprintf("%s 剩余 %d 天", c.Instance, c.DaysLeft))
				rep.CertExpiring++
			case "expiring":
				expiringCerts = append(expiringCerts, fmt.Sprintf("%s 剩余 %d 天", c.Instance, c.DaysLeft))
				rep.CertExpiring++
			}
		}
		if (c.KeyAlgo == "RSA" && c.KeyBits > 0 && c.KeyBits < 2048) ||
			strings.Contains(strings.ToUpper(c.SigAlgo), "SHA1") ||
			strings.Contains(strings.ToUpper(c.SigAlgo), "MD5") {
			weakCerts = append(weakCerts, fmt.Sprintf("%s (%s %d-bit / %s)", c.Instance, c.KeyAlgo, c.KeyBits, c.SigAlgo))
		}
	}

	// 3. Deterministic Config Security Baseline Audit on deployment.yml & solved plan.
	checks := s.evaluateConfigBaseline(f, dep, certs, expiredCerts, critCerts, expiringCerts, weakCerts)
	for i := range checks {
		if wv, ok := waivers[f.ID+"|"+checks[i].ID]; ok && checks[i].Status != "pass" {
			checks[i].Waived = true
			checks[i].Status = "waived"
			checks[i].WaiveNote = wv.Note
			checks[i].WaiveBy = wv.By
			checks[i].WaiveAt = wv.At
		}
		rep.BaselineTotal++
		if checks[i].Status == "pass" || checks[i].Status == "waived" {
			rep.BaselinePassed++
		}
	}
	rep.BaselineChecks = checks

	// 4. Linked security rehearsals on this cluster.
	for _, rh := range s.listRehearsals(f.ID) {
		if rh.SecurityContext != nil || strings.Contains(rh.Title, "CVE") || strings.Contains(rh.Title, "安全") || strings.Contains(rh.Title, "加固") || strings.Contains(rh.Title, "证书") {
			rep.Rehearsals = append(rep.Rehearsals, secLinkedRehearsal{
				ID:              rh.ID,
				Title:           rh.Title,
				Stage:           rh.Stage,
				Owner:           rh.Owner,
				DocID:           rh.DocID,
				UpdatedAt:       rh.UpdatedAt,
				SecurityContext: rh.SecurityContext,
			})
		}
	}

	// 5. Transparent deterministic security score (0-100) + grade (A/B/C/D), distinguishing Middleware vs OS CVEs.
	score := 100
	deduct := func(reason string, pts int) {
		if pts <= 0 {
			return
		}
		score -= pts
		rep.Deductions = append(rep.Deductions, secScoreDeduction{Reason: reason, Points: pts})
	}
	if rep.MiddlewareCounts.Critical > 0 {
		pts := min(rep.MiddlewareCounts.Critical*15, 45)
		deduct(fmt.Sprintf("%d 个中间件本体严重 (Critical) CVE", rep.MiddlewareCounts.Critical), pts)
	}
	if rep.MiddlewareCounts.High > 0 {
		pts := min(rep.MiddlewareCounts.High*5, 25)
		deduct(fmt.Sprintf("%d 个中间件本体高危 (High) CVE", rep.MiddlewareCounts.High), pts)
	}
	if rep.MiddlewareCounts.Medium > 0 {
		pts := min(rep.MiddlewareCounts.Medium, 10)
		deduct(fmt.Sprintf("%d 个中间件本体中危 (Medium) CVE", rep.MiddlewareCounts.Medium), pts)
	}
	if !policy.GateMiddlewareOnly && !policy.HideOSCVEs {
		if rep.OSCounts.Critical > 0 {
			pts := min(rep.OSCounts.Critical*10, 25)
			deduct(fmt.Sprintf("%d 个 OS 底层包严重 (Critical) CVE", rep.OSCounts.Critical), pts)
		}
		if rep.OSCounts.High > 0 {
			pts := min(rep.OSCounts.High*3, 15)
			deduct(fmt.Sprintf("%d 个 OS 底层包高危 (High) CVE", rep.OSCounts.High), pts)
		}
		if rep.OSCounts.Medium > 0 {
			pts := min(rep.OSCounts.Medium, 5)
			deduct(fmt.Sprintf("%d 个 OS 底层包中危 (Medium) CVE", rep.OSCounts.Medium), pts)
		}
	}
	baseHighPts, baseMedPts := 0, 0
	for _, ck := range rep.BaselineChecks {
		if ck.Status == "pass" || ck.Status == "waived" {
			continue
		}
		switch ck.Severity {
		case "CRITICAL", "HIGH":
			p := 10
			if baseHighPts+p > 20 {
				p = max(0, 20-baseHighPts)
			}
			baseHighPts += p
			deduct("配置基线未通过："+ck.Title, p)
		case "MEDIUM":
			p := 4
			if baseMedPts+p > 8 {
				p = max(0, 8-baseMedPts)
			}
			baseMedPts += p
			deduct("配置基线待加固："+ck.Title, p)
		}
	}
	if score < 0 {
		score = 0
	}
	rep.Score = score
	switch {
	case score >= 90:
		rep.Grade = "A"
	case score >= 75:
		rep.Grade = "B"
	case score >= 60:
		rep.Grade = "C"
	default:
		rep.Grade = "D"
	}
	return rep
}

func parseX509CertsLenient(b []byte) []*x509.Certificate {
	var out []*x509.Certificate
	rest := b
	for len(bytes.TrimSpace(rest)) > 0 {
		block, next := pem.Decode(rest)
		if block == nil {
			break
		}
		rest = next
		if block.Type != "CERTIFICATE" {
			continue
		}
		if c, err := x509.ParseCertificate(block.Bytes); err == nil {
			out = append(out, c)
		}
	}
	return out
}

func isCertFileName(fname string) bool {
	lf := strings.ToLower(strings.TrimSpace(fname))
	if lf == "" || strings.HasSuffix(lf, ".key") || strings.Contains(lf, "privkey") || strings.HasSuffix(lf, "-key.pem") || strings.HasSuffix(lf, "_key.pem") {
		return false
	}
	return strings.HasSuffix(lf, ".crt") || strings.HasSuffix(lf, ".pem") || strings.HasSuffix(lf, ".cer")
}

// collectClusterCertFiles scans a delivery job's node*.tar.gz & update-*.tar.gz bundles for embedded X.509 certificate
// files under middleware-automation/projects/<project>/files/, handling both bare cluster IDs and versioned change
// project folders (e.g. "<clusterID>.01").
func (s *storeServer) collectClusterCertFiles(jobID, clusterID string) map[string][]byte {
	out := map[string][]byte{}
	if jobID == "" {
		return out
	}
	if clusterID == "" {
		s.mu.Lock()
		clusterID = s.jobs[jobID].ClusterID
		s.mu.Unlock()
		if clusterID == "" {
			if dep := s.readSpec(jobID); dep != nil {
				clusterID = dep.ID
			}
		}
	}
	readTar := func(path string) {
		f, err := os.Open(path)
		if err != nil {
			return
		}
		defer f.Close()
		zr, err := gzip.NewReader(f)
		if err != nil {
			return
		}
		defer zr.Close()
		tr := tar.NewReader(zr)
		for {
			h, err := tr.Next()
			if err != nil {
				break
			}
			if (h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA) || h.Size <= 0 || h.Size > 2<<20 {
				continue
			}
			rest, ok := extractProjectFileRel(h.Name, clusterID)
			if !ok {
				continue
			}
			parts := strings.Split(rest, "/")
			if len(parts) < 2 || !isCertFileName(parts[len(parts)-1]) {
				continue
			}
			if b, err := io.ReadAll(io.LimitReader(tr, 2<<20)); err == nil && len(b) > 0 {
				out[rest] = b
			}
		}
	}
	nodeFiles, _ := filepath.Glob(filepath.Join(s.jobDir(jobID), "output", "node*.tar.gz"))
	sort.Strings(nodeFiles)
	for _, path := range nodeFiles {
		readTar(path)
		if len(out) > 0 {
			break
		}
	}
	updateFiles, _ := filepath.Glob(filepath.Join(s.jobDir(jobID), "output", "update-*.tar.gz"))
	sort.Strings(updateFiles)
	for _, path := range updateFiles {
		readTar(path)
	}
	return out
}

func (s *storeServer) inspectClusterCertificates(f clusterFacts) []secCertCheck {
	mats := s.collectClusterCertFiles(f.Current.ID, f.ID)
	if len(mats) == 0 && len(f.Jobs) > 0 {
		// Fall back to the most recent prior succeeded delivery if the latest revision job omitted files/.
		for i := len(f.Jobs) - 1; i >= 0; i-- {
			j := f.Jobs[i]
			if j.ID == f.Current.ID || j.Outcome == outcomeVoid {
				continue
			}
			mats = s.collectClusterCertFiles(j.ID, f.ID)
			if len(mats) > 0 {
				break
			}
		}
	}
	if len(mats) == 0 {
		return []secCertCheck{}
	}
	nowTime := time.Now().UTC()
	out := []secCertCheck{}
	keys := make([]string, 0, len(mats))
	for k := range mats {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		parts := strings.Split(k, "/")
		if len(parts) < 2 {
			continue
		}
		inst := parts[0]
		bundle := "tls"
		fname := parts[len(parts)-1]
		if len(parts) >= 3 {
			bundle = parts[1]
		}
		lf := strings.ToLower(fname)
		role := "server"
		if strings.HasPrefix(lf, "ca.") || strings.HasPrefix(lf, "ca-") || strings.HasPrefix(lf, "ca_") || strings.HasPrefix(lf, "root") || strings.Contains(lf, "chain") {
			role = "ca"
		}
		parsed := parseX509CertsLenient(mats[k])
		if len(parsed) == 0 {
			continue
		}
		c := parsed[0]
		daysLeft := int(time.Until(c.NotAfter).Hours() / 24)
		status := "ok"
		switch {
		case nowTime.After(c.NotAfter):
			status = "expired"
		case daysLeft <= 7:
			status = "critical"
		case daysLeft <= 30:
			status = "expiring"
		}
		algo, bits := certKeyInfo(c)
		sans := append([]string(nil), c.DNSNames...)
		for _, ip := range c.IPAddresses {
			sans = append(sans, ip.String())
		}
		subj := firstNonEmptyStr(c.Subject.CommonName, c.Subject.String())
		iss := firstNonEmptyStr(c.Issuer.CommonName, c.Issuer.String())
		out = append(out, secCertCheck{
			Instance:     inst,
			Bundle:       bundle,
			Role:         role,
			Subject:      subj,
			Issuer:       iss,
			SANs:         sans,
			NotBefore:    c.NotBefore.UTC().Format("2006-01-02"),
			NotAfter:     c.NotAfter.UTC().Format("2006-01-02"),
			DaysLeft:     daysLeft,
			KeyAlgo:      algo,
			KeyBits:      bits,
			SigAlgo:      c.SignatureAlgorithm.String(),
			IsSelfSigned: subj != "" && subj == iss,
			Status:       status,
		})
	}
	return out
}

func certKeyInfo(c *x509.Certificate) (string, int) {
	switch pub := c.PublicKey.(type) {
	case *rsa.PublicKey:
		return "RSA", pub.N.BitLen()
	case *ecdsa.PublicKey:
		if pub.Curve != nil {
			return "ECDSA", pub.Curve.Params().BitSize
		}
		return "ECDSA", 0
	case ed25519.PublicKey:
		return "Ed25519", 256
	default:
		return c.PublicKeyAlgorithm.String(), 0
	}
}

func (s *storeServer) evaluateConfigBaseline(
	f clusterFacts,
	dep *mwpack.Deployment,
	certs []secCertCheck,
	expiredCerts, critCerts, expiringCerts, weakCerts []string,
) []secBaselineCheck {
	checks := []secBaselineCheck{}

	// Tailored governance checks for brownfield imported clusters (avoiding false positives on undeclared install-time fields).
	if dep != nil && dep.DeliveryMode == "imported" {
		meta := dep.Imported
		hasPkg := meta != nil && len(meta.Packages) > 0
		hasExact := meta != nil && strings.TrimSpace(meta.ExactVersion) != "" && meta.ExactVersion != "unknown"
		if hasPkg || hasExact {
			detail := fmt.Sprintf("已采集 %d 个软件包", len(meta.Packages))
			if !hasPkg {
				detail = fmt.Sprintf("已登记精确版本 %s（建议后续补充只读探针采集完整 OS 软件包清单）", meta.ExactVersion)
			}
			checks = append(checks, secBaselineCheck{
				ID:       "imported-sbom-coverage",
				Category: "software",
				Title:    "存量纳管版本与软件包资产覆盖",
				Severity: "LOW",
				Status:   "pass",
				Detail:   detail,
			})
		} else {
			checks = append(checks, secBaselineCheck{
				ID:             "imported-sbom-coverage",
				Category:       "architecture",
				Title:          "存量纳管版本与软件包资产覆盖",
				Severity:       "MEDIUM",
				Status:         "warn",
				Detail:         "尚未采集精确版本号与软件包清单，当前无法做完整 CVE 匹配",
				Recommendation: "在集群「概览」或「配置」点击「重新只读采集」，运行只读探针并粘贴回显即可自动补齐软件包清单。",
			})
		}
		if len(dep.Hosts) >= 2 {
			checks = append(checks, secBaselineCheck{
				ID:       "imported-ha-nodes",
				Category: "architecture",
				Title:    "高可用多节点冗余",
				Severity: "LOW",
				Status:   "pass",
				Detail:   fmt.Sprintf("已登记 %d 台集群主机节点", len(dep.Hosts)),
			})
		} else {
			checks = append(checks, secBaselineCheck{
				ID:             "imported-ha-nodes",
				Category:       "architecture",
				Title:          "高可用多节点冗余",
				Severity:       "MEDIUM",
				Status:         "warn",
				Detail:         "当前仅登记 1 台节点，存在单点故障风险",
				Recommendation: "如生产环境为单机实例，建议评估高可用改造并通过「变更演练」规划演练方案。",
			})
		}
		hasPaths := meta != nil && (len(meta.ConfigPaths) > 0 || len(meta.DataDirs) > 0 || len(meta.ServiceUnits) > 0)
		if hasPaths {
			checks = append(checks, secBaselineCheck{
				ID:       "imported-runtime-paths",
				Category: "architecture",
				Title:    "运行路径与服务单元基线完整性",
				Severity: "LOW",
				Status:   "pass",
				Detail:   "已登记服务单元或配置/数据目录，变更演练可直接生成精确现场命令",
			})
		} else {
			checks = append(checks, secBaselineCheck{
				ID:             "imported-runtime-paths",
				Category:       "architecture",
				Title:          "运行路径与服务单元基线完整性",
				Severity:       "LOW",
				Status:         "warn",
				Detail:         "尚未登记配置路径、数据目录或 systemd 服务单元",
				Recommendation: "在「配置」页补充实际路径信息，可显著提升变更演练脚本与 SOP 精准度。",
			})
		}
		return checks
	}

	// Inspect instances from solved plan (effective defaults merged), plan.json fallback, or deployment.yml + schema defaults.
	var tlsSupported, tlsDisabled []string
	var tdeSupported, tdeDisabled []string
	var openCIDRs []string

	certsByInst := map[string]bool{}
	for _, c := range certs {
		if c.Role == "server" && c.Instance != "" {
			certsByInst[c.Instance] = true
		}
	}

	cat := s.plat.cat()
	inspectParams := func(instID, compName string, params map[string]any) {
		hasTLSSchema, hasTDESchema := false, false
		tlsDefault, tdeDefault := false, false
		if comp, ok := cat.Get(compName); ok {
			if sc, err := comp.Describe(""); err == nil {
				for _, p := range sc.Params {
					if p.Key == "tls" {
						hasTLSSchema = true
						if b, ok := p.Default.(bool); ok {
							tlsDefault = b
						}
					}
					if p.Key == "tde" {
						hasTDESchema = true
						if b, ok := p.Default.(bool); ok {
							tdeDefault = b
						}
					}
				}
			}
		}
		if v, exists := params["tls"]; exists || hasTLSSchema || certsByInst[instID] {
			tlsSupported = append(tlsSupported, instID)
			enabled := tlsDefault
			if exists {
				if b, ok := v.(bool); ok {
					enabled = b
				} else {
					enabled = strings.EqualFold(strings.TrimSpace(fmt.Sprintf("%v", v)), "true")
				}
			}
			if certsByInst[instID] {
				enabled = true
			}
			if !enabled {
				tlsDisabled = append(tlsDisabled, instID)
			}
		}
		if v, exists := params["tde"]; exists || hasTDESchema {
			tdeSupported = append(tdeSupported, instID)
			enabled := tdeDefault
			if exists {
				if b, ok := v.(bool); ok {
					enabled = b
				} else {
					enabled = strings.EqualFold(strings.TrimSpace(fmt.Sprintf("%v", v)), "true")
				}
			}
			if !enabled {
				tdeDisabled = append(tdeDisabled, instID)
			}
		}
		for k, v := range params {
			lk := strings.ToLower(k)
			if !strings.Contains(lk, "cidr") && !strings.Contains(lk, "allow") {
				continue
			}
			sv := strings.TrimSpace(fmt.Sprintf("%v", v))
			if sv == "" || sv == "<nil>" || sv == "[]" {
				continue
			}
			for _, tok := range strings.FieldsFunc(sv, func(r rune) bool { return r == ',' || r == ' ' || r == ';' || r == '[' || r == ']' }) {
				if tok == "0.0.0.0/0" || tok == "::/0" || strings.HasSuffix(tok, "/0") || strings.HasSuffix(tok, "/8") {
					openCIDRs = append(openCIDRs, fmt.Sprintf("%s.%s=%s", instID, k, tok))
				}
			}
		}
	}

	// Prefer f.Plan.Instances (contains solved effective params including component defaults like tls=true, tde=true).
	inspected := false
	if f.Plan != nil && len(f.Plan.Instances) > 0 {
		for _, inst := range f.Plan.Instances {
			if !inst.External {
				inspectParams(inst.ID, inst.Component, inst.Params)
				inspected = true
			}
		}
	}
	if !inspected && f.Current.ID != "" {
		// Fallback to persisted output/plan.json for historical deliveries whose schema may have evolved.
		if raw, err := os.ReadFile(filepath.Join(s.jobDir(f.Current.ID), "output", "plan.json")); err == nil {
			var pj struct {
				Instances []struct {
					ID        string         `json:"id"`
					Component string         `json:"component"`
					External  bool           `json:"external"`
					Params    map[string]any `json:"params"`
				} `json:"instances"`
			}
			if json.Unmarshal(raw, &pj) == nil && len(pj.Instances) > 0 {
				for _, inst := range pj.Instances {
					if !inst.External {
						inspectParams(inst.ID, inst.Component, inst.Params)
						inspected = true
					}
				}
			}
		}
	}
	if !inspected && dep != nil {
		for _, inst := range dep.Instances {
			inspectParams(inst.ID, inst.Component, inst.Params)
		}
	}

	// Rule 1: TLS Encryption
	if len(tlsSupported) > 0 {
		if len(tlsDisabled) > 0 {
			checks = append(checks, secBaselineCheck{
				ID:             "tls_enabled",
				Category:       "encryption",
				Title:          "传输层 TLS 加密",
				Severity:       "HIGH",
				Status:         "fail",
				Target:         strings.Join(tlsDisabled, ", "),
				Detail:         fmt.Sprintf("实例 %s 未启用 TLS 传输加密，内网明文流量存在窃听与中间人篡改风险。", strings.Join(tlsDisabled, "、")),
				Recommendation: "建议签发内网 CA 证书并通过变更演练平滑开启 TLS 及 verify-ca/verify-full 校验。",
				RehearsalKind:  "config_hardening",
				RehearsalGoal:  fmt.Sprintf("为集群 %s 的实例（%s）平滑开启 TLS 传输加密并完成客户端加密连接校验（保留回退方案）。", f.ID, strings.Join(tlsDisabled, "、")),
			})
		} else {
			checks = append(checks, secBaselineCheck{
				ID:       "tls_enabled",
				Category: "encryption",
				Title:    "传输层 TLS 加密",
				Severity: "HIGH",
				Status:   "pass",
				Target:   strings.Join(tlsSupported, ", "),
				Detail:   fmt.Sprintf("所有支持加密的实例（%s）均已开启 TLS 传输加密。", strings.Join(tlsSupported, "、")),
			})
		}
	}

	// Rule 2: Network Access CIDR Scope
	if len(openCIDRs) > 0 {
		checks = append(checks, secBaselineCheck{
			ID:             "client_cidr_open",
			Category:       "network",
			Title:          "客户端访问网段最小化（CIDR 白名单）",
			Severity:       "HIGH",
			Status:         "fail",
			Target:         strings.Join(openCIDRs, ", "),
			Detail:         fmt.Sprintf("检测到过宽的放行网段：%s，违背最小权限网络隔离原则。", strings.Join(openCIDRs, "、")),
			Recommendation: "将访问控制白名单收紧至具体业务应用子网 CIDR，并演练验证业务连通性后生效。",
			RehearsalKind:  "config_hardening",
			RehearsalGoal:  fmt.Sprintf("收紧集群 %s 过宽的访问控制白名单（当前：%s）至指定业务网段，先通过只读探针采集现网实际来源 IP 再演练配置变更。", f.ID, strings.Join(openCIDRs, "、")),
		})
	} else {
		checks = append(checks, secBaselineCheck{
			ID:       "client_cidr_open",
			Category: "network",
			Title:    "客户端访问网段最小化（CIDR 白名单）",
			Severity: "HIGH",
			Status:   "pass",
			Detail:   "未发现 0.0.0.0/0 或过宽的 /8 全网段放行规则。",
		})
	}

	// Rule 3: PostgreSQL TDE
	if len(tdeSupported) > 0 {
		if len(tdeDisabled) > 0 {
			checks = append(checks, secBaselineCheck{
				ID:             "pg_tde",
				Category:       "encryption",
				Title:          "数据库透明静态加密（TDE）",
				Severity:       "MEDIUM",
				Status:         "warn",
				Target:         strings.Join(tdeDisabled, ", "),
				Detail:         fmt.Sprintf("实例 %s 未开启 TDE 静态数据落盘加密（若底层存储/虚拟化层已启用全盘加密，可记录合规豁免）。", strings.Join(tdeDisabled, "、")),
				Recommendation: "如合规要求数据库层静态加密，可规划 TDE 迁移；若已有磁盘级加密保护，请点击豁免并注明原因。",
			})
		} else {
			checks = append(checks, secBaselineCheck{
				ID:       "pg_tde",
				Category: "encryption",
				Title:    "数据库透明静态加密（TDE）",
				Severity: "MEDIUM",
				Status:   "pass",
				Target:   strings.Join(tdeSupported, ", "),
				Detail:   "已启用数据库静态加密（TDE）。",
			})
		}
	}

	// Rule 4: High Availability / SPOF
	hostCount := 0
	if dep != nil {
		hostCount = len(dep.Hosts)
	} else if f.Plan != nil {
		hostCount = len(f.Plan.Hosts)
	}
	schemeName := ""
	if f.Current.Scheme != nil {
		schemeName = f.Current.Scheme.Name
	}
	isSingle := hostCount <= 1 || strings.Contains(strings.ToLower(schemeName), "单机")
	if isSingle {
		checks = append(checks, secBaselineCheck{
			ID:             "ha_spof",
			Category:       "architecture",
			Title:          "生产高可用与无单点故障（SPOF）",
			Severity:       "MEDIUM",
			Status:         "warn",
			Target:         fmt.Sprintf("%d 台节点", hostCount),
			Detail:         fmt.Sprintf("当前集群为单点部署架构（%d 台主机，方案：%s），单机故障或打安全补丁重启将直接造成业务中断。", hostCount, firstNonEmptyStr(schemeName, "单机")),
			Recommendation: "核心生产业务建议升级为主备/集群高可用架构，以支持零中断滚动打补丁与故障切换。",
			RehearsalKind:  "config_hardening",
			RehearsalGoal:  fmt.Sprintf("评估并演练为集群 %s（当前单节点 %s %s）补充高可用备节点或制定安全维护窗口应急预案。", f.ID, f.Current.AppName, f.Current.Version),
		})
	} else {
		checks = append(checks, secBaselineCheck{
			ID:       "ha_spof",
			Category: "architecture",
			Title:    "生产高可用与无单点故障（SPOF）",
			Severity: "MEDIUM",
			Status:   "pass",
			Target:   fmt.Sprintf("%d 台节点", hostCount),
			Detail:   fmt.Sprintf("集群采用多节点拓扑（%d 台主机），具备滚动打补丁与容灾切换基础。", hostCount),
		})
	}

	// Rule 5: Execution Control Plane Isolation
	if dep != nil && dep.ExecutionHost == nil {
		checks = append(checks, secBaselineCheck{
			ID:             "controller_colocated",
			Category:       "architecture",
			Title:          "运维控制面与业务节点隔离",
			Severity:       "LOW",
			Status:         "warn",
			Target:         firstNonEmptyStr(dep.Controller, "首台业务节点"),
			Detail:         "Ansible 执行控制面复用在业务数据节点上，存在运维凭据/离线仓与业务主机混部暴露面。",
			Recommendation: "后续变更或新建交付建议使用独立的执行节点（Execution Host）实现运维平面隔离。",
		})
	} else {
		checks = append(checks, secBaselineCheck{
			ID:       "controller_colocated",
			Category: "architecture",
			Title:    "运维控制面与业务节点隔离",
			Severity: "LOW",
			Status:   "pass",
			Detail:   "已配置独立执行控制节点，运维控制面与业务数据面物理隔离。",
		})
	}

	// Rule 6 & 7: TLS Certificate Expiry & Strength (when certs exist)
	if len(certs) > 0 {
		if len(expiredCerts) > 0 || len(critCerts) > 0 || len(expiringCerts) > 0 {
			sev := "MEDIUM"
			detailParts := []string{}
			if len(expiredCerts) > 0 {
				sev = "CRITICAL"
				detailParts = append(detailParts, "已过期："+strings.Join(expiredCerts, "、"))
			}
			if len(critCerts) > 0 {
				if sev != "CRITICAL" {
					sev = "HIGH"
				}
				detailParts = append(detailParts, "7天内到期："+strings.Join(critCerts, "、"))
			}
			if len(expiringCerts) > 0 {
				detailParts = append(detailParts, "30天内到期："+strings.Join(expiringCerts, "、"))
			}
			checks = append(checks, secBaselineCheck{
				ID:             "tls_cert_expiry",
				Category:       "certificate",
				Title:          "TLS 证书有效期巡检",
				Severity:       sev,
				Status:         "fail",
				Detail:         strings.Join(detailParts, "；") + "。",
				Recommendation: "立即签发新证书并通过 AI 变更演练执行无中断滚动换证与热加载验证。",
				RehearsalKind:  "cert_rotation",
				RehearsalGoal:  fmt.Sprintf("为集群 %s 即将到期/已过期的 TLS 服务器证书（%s）执行无中断滚动轮换与热重载验证。", f.ID, strings.Join(detailParts, "；")),
			})
		} else {
			checks = append(checks, secBaselineCheck{
				ID:       "tls_cert_expiry",
				Category: "certificate",
				Title:    "TLS 证书有效期巡检",
				Severity: "HIGH",
				Status:   "pass",
				Detail:   fmt.Sprintf("已核验 %d 份内嵌证书，均在有效期内且剩余有效期超过 30 天。", len(certs)),
			})
		}

		if len(weakCerts) > 0 {
			checks = append(checks, secBaselineCheck{
				ID:             "tls_cert_strength",
				Category:       "certificate",
				Title:          "TLS 证书密钥强度与签名算法",
				Severity:       "HIGH",
				Status:         "fail",
				Target:         strings.Join(weakCerts, ", "),
				Detail:         fmt.Sprintf("发现弱加密算法或弱密钥证书：%s（需 RSA ≥ 2048 bit 或 ECDSA P-256 及 SHA-256 以上签名）。", strings.Join(weakCerts, "、")),
				Recommendation: "重新签发 RSA 2048+/ECDSA P-256 + SHA-256 证书并滚动替换。",
				RehearsalKind:  "cert_rotation",
				RehearsalGoal:  fmt.Sprintf("替换集群 %s 中的弱加密 TLS 证书（%s）为 RSA 2048+/ECDSA P-256 + SHA-256 强证书并演练热重载。", f.ID, strings.Join(weakCerts, "、")),
			})
		} else {
			checks = append(checks, secBaselineCheck{
				ID:       "tls_cert_strength",
				Category: "certificate",
				Title:    "TLS 证书密钥强度与签名算法",
				Severity: "HIGH",
				Status:   "pass",
				Detail:   "所有内嵌证书均符合强加密算法与密钥长度基线（RSA ≥ 2048 / ECDSA / Ed25519 + SHA-256+）。",
			})
		}
	}

	return checks
}

// ---- Supply-Chain Integrity Self-Check ----

type secSupplyPlatform struct {
	Platform          string   `json:"platform"`
	Title             string   `json:"title"`
	SourcesTotal      int      `json:"sources_total"`
	SourcesSigned     int      `json:"sources_signed"`
	UnsignedSourceIDs []string `json:"unsigned_source_ids,omitempty"`
	IndexUpdated      string   `json:"index_updated,omitempty"`
	IndexPackages     int      `json:"index_packages"`
	SignedReleases    int      `json:"signed_releases"`
	ClosuresTotal     int      `json:"closures_total"`
	FilesTotal        int      `json:"files_total"`
	FilesMissing      int      `json:"files_missing"`
	FilesHashMismatch int      `json:"files_hash_mismatch"`
	MissingSamples    []string `json:"missing_samples,omitempty"`
	Healthy           bool     `json:"healthy"`
}

type secSupplyChainReport struct {
	CheckedAt         string              `json:"checked_at"`
	DeepVerified      bool                `json:"deep_verified"`
	OverallHealthy    bool                `json:"overall_healthy"`
	Platforms         []secSupplyPlatform `json:"platforms"`
	RuntimeCount      int                 `json:"runtime_count"`
	WheelCount        int                 `json:"wheel_count"`
	WheelSHA256Count  int                 `json:"wheel_sha256_count"`
	DefaultPlatforms  int                 `json:"default_platforms"`
	TotalIssues       int                 `json:"total_issues"`
}

func (s *storeServer) checkSupplyChainIntegrity(verifySHA bool) secSupplyChainReport {
	rep := secSupplyChainReport{
		CheckedAt:      now(),
		DeepVerified:   verifySHA,
		OverallHealthy: true,
		Platforms:      []secSupplyPlatform{},
	}
	if s.plat == nil {
		return rep
	}
	for _, def := range mwpack.Platforms {
		sp := secSupplyPlatform{
			Platform: def.ID,
			Title:    def.Title,
			Healthy:  true,
		}
		if loaded := s.plat.sources.Load(); loaded != nil {
			srcs := loaded.ForPlatform(def.ID)
			for _, src := range srcs {
				if src.Disabled {
					continue
				}
				sp.SourcesTotal++
				if strings.TrimSpace(src.KeyFile) != "" {
					sp.SourcesSigned++
				} else {
					sp.UnsignedSourceIDs = append(sp.UnsignedSourceIDs, src.ID)
				}
			}
		}
		if s.plat.idx != nil {
			st := s.plat.idx.State(def.ID)
			sp.IndexUpdated = firstNonEmptyStr(st.Updated, st.Imported)
			sp.IndexPackages = st.Packages
			sp.SignedReleases = len(st.Releases)
		}
		if s.plat.lib != nil {
			closures := s.plat.lib.List(def.ID)
			sp.ClosuresTotal = len(closures)
			seenFile := map[string]bool{}
			for _, cl := range closures {
				for _, f := range cl.Files {
					if f.File == "" || seenFile[f.File] {
						continue
					}
					seenFile[f.File] = true
					sp.FilesTotal++
					fp := filepath.Join(s.plat.lib.Dir, def.ID, "pool", f.File)
					info, err := os.Stat(fp)
					if err != nil {
						sp.FilesMissing++
						if len(sp.MissingSamples) < 6 {
							sp.MissingSamples = append(sp.MissingSamples, f.File)
						}
						continue
					}
					if f.Size > 0 && info.Size() != f.Size {
						sp.FilesHashMismatch++
						if len(sp.MissingSamples) < 6 {
							sp.MissingSamples = append(sp.MissingSamples, f.File+" (size mismatch)")
						}
						continue
					}
					if verifySHA && f.SHA256 != "" {
						if got, err := secFileSHA256(fp); err != nil || !strings.EqualFold(got, f.SHA256) {
							sp.FilesHashMismatch++
							if len(sp.MissingSamples) < 6 {
								sp.MissingSamples = append(sp.MissingSamples, f.File+" (sha256 mismatch)")
							}
						}
					}
				}
			}
		}
		if sp.FilesMissing > 0 || sp.FilesHashMismatch > 0 || len(sp.UnsignedSourceIDs) > 0 {
			sp.Healthy = false
			rep.OverallHealthy = false
			rep.TotalIssues += sp.FilesMissing + sp.FilesHashMismatch + len(sp.UnsignedSourceIDs)
		}
		rep.Platforms = append(rep.Platforms, sp)
	}
	if s.plat.py != nil {
		wheels, runtimes, defaults := s.plat.py.State()
		rep.RuntimeCount = len(runtimes)
		rep.WheelCount = len(wheels)
		rep.DefaultPlatforms = len(defaults)
		for _, wh := range wheels {
			if wh.SHA256 != "" {
				rep.WheelSHA256Count++
			}
		}
	}
	return rep
}

func secFileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ---- On-Demand AI CVE Analysis (Strict 3-Layer AI Gate: Master && Module "security" && IAM ai.feat.security) ----

const securityAIAnalyzeSystem = `你是企业级离线中间件与 Linux 基础设施安全专家。用户选中了一条 CVE 漏洞记录，希望结合本平台中间件架构快速做出中文研判与处置决策。
严格只输出一个 JSON 对象，不要附加 Markdown 代码块：
{
  "summary_zh": "2～3句通俗中文解释该漏洞的成因、触发方式和潜在危害",
  "exploitability": "high | medium | low | unlikely",
  "exploitability_reason": "结合该软件包在中间件集群中的实际用途（例如是否直接暴露公网、是否依赖特定可选模块如 HTTP/3 或 ipsets、是否为内网访问），评估真实可利用性",
  "mitigation_steps": ["短期不升级时的配置规避或网络隔离措施1", "措施2"],
  "upgrade_guidance": "版本升级与滚动窗口建议（若有明确修复版本请说明升级注意事项）",
  "probe_hint": "建议在生产主机通过只读命令核实的 1～2 项关键事实（例如检查模块是否启用或真实版本号）",
  "suggested_vex_status": "planned | mitigated | not_affected | accepted",
  "suggested_vex_note": "一段简明专业、可直接用于 VEX 审计留痕的中文评估依据草稿"
}`

func (s *storeServer) handleSecurityAIAnalyze(w http.ResponseWriter, r *http.Request, session storeSession) {
	if !s.need(w, session.User, "security.view") {
		return
	}
	if code, msg := s.checkAIFeature(session.User, "security"); code != 0 {
		s.fail(w, code, msg)
		return
	}
	var in struct {
		FindingKey       string   `json:"finding_key"`
		CVE              string   `json:"cve"`
		Package          string   `json:"package"`
		Ecosystem        string   `json:"ecosystem"`
		InstalledVersion string   `json:"installed_version"`
		FixedIn          []string `json:"fixed_in"`
		ClusterID        string   `json:"cluster_id"`
		Model            string   `json:"model"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in) != nil {
		s.fail(w, 400, "请求参数格式错误")
		return
	}
	in.CVE = strings.TrimSpace(in.CVE)
	in.Package = strings.TrimSpace(in.Package)
	if in.CVE == "" && in.FindingKey == "" {
		s.fail(w, 400, "请指定要研判的漏洞")
		return
	}

	// Enrich from latest scan report if available.
	var matched *secFinding
	secDBMu.Lock()
	rawRep := s.loadLatestScan()
	secDBMu.Unlock()
	if rawRep != nil {
		scoped := s.scopedScanReport(rawRep, session.User)
		for i := range scoped.Findings {
			fd := &scoped.Findings[i]
			if (in.FindingKey != "" && fd.Key == in.FindingKey) ||
				(in.CVE != "" && strings.EqualFold(fd.CVE, in.CVE) && (in.Package == "" || strings.EqualFold(fd.Package, in.Package))) {
				matched = fd
				break
			}
		}
	}

	st := s.aiLoad()
	providers := st.aiProvidersForPick("security", in.Model)
	if len(providers) == 0 {
		s.fail(w, 409, "「安全 AI」未配置可用模型，请管理员在平台设置 → AI 中配置模型")
		return
	}
	if st.MonthlyLimit > 0 && s.aiCallsThisMonth(session.User) >= st.MonthlyLimit {
		s.fail(w, 429, "本月 AI 使用次数已达上限")
		return
	}

	var prompt strings.Builder
	cveID := firstNonEmptyStr(in.CVE, func() string {
		if matched != nil {
			return matched.CVE
		}
		return in.FindingKey
	}())
	fmt.Fprintf(&prompt, "【漏洞基本信息】\n- 编号：%s\n", cveID)
	if matched != nil {
		fmt.Fprintf(&prompt, "- 原始公告 ID：%s\n- 严重等级：%s（CVSS %.1f %s）\n- 生态与系统：%s（%s）\n- 软件包：%s（角色：%s）\n- 当前安装版本：%s\n",
			matched.ID, matched.Severity, matched.CVSSScore, matched.CVSSVector,
			matched.Ecosystem, matched.PlatformTitle, matched.Package, matched.PkgRole, matched.InstalledVersion)
		if len(matched.FixedIn) > 0 {
			fmt.Fprintf(&prompt, "- 官方修复版本：%s\n", strings.Join(matched.FixedIn, ", "))
		} else {
			fmt.Fprintf(&prompt, "- 官方修复版本：暂无明确上游修复版本\n")
		}
		if matched.RepoFixVersion != "" {
			fmt.Fprintf(&prompt, "- 平台本地软件源已有修复版：%s\n", matched.RepoFixVersion)
		}
		if matched.Summary != "" {
			fmt.Fprintf(&prompt, "- 公告摘要：%s\n", truncRunes(matched.Summary, 600))
		}
		if matched.Details != "" {
			fmt.Fprintf(&prompt, "- 公告详情：%s\n", truncRunes(matched.Details, 1200))
		}
		if len(matched.Components) > 0 {
			var cs []string
			for _, c := range matched.Components {
				cs = append(cs, fmt.Sprintf("%s %s (%s)", c.Title, c.Version, c.Platform))
			}
			fmt.Fprintf(&prompt, "- 影响的平台组件：%s\n", strings.Join(cs, "、"))
		}
		if len(matched.Clusters) > 0 {
			var cls []string
			for _, cl := range matched.Clusters {
				cls = append(cls, fmt.Sprintf("%s（%s %s，%d台节点）", cl.ClusterID, cl.AppName, cl.Version, len(cl.Hosts)))
			}
			fmt.Fprintf(&prompt, "- 影响的生产集群（%d 个）：%s\n", len(matched.Clusters), strings.Join(cls, "；"))
		}
	} else {
		fmt.Fprintf(&prompt, "- 生态：%s\n- 软件包：%s\n- 当前版本：%s\n- 修复版本：%s\n",
			in.Ecosystem, in.Package, in.InstalledVersion, strings.Join(in.FixedIn, ", "))
	}

	if in.ClusterID != "" {
		if f, ok := s.clusterFactsFor(session.User, in.ClusterID); ok {
			baseline, _ := s.clusterBaselinePrompt(f)
			fmt.Fprintf(&prompt, "\n【重点关注集群配置基线（已脱敏）】\n%s\n", truncRunes(aiScrub(baseline), 2000))
		}
	}

	msgs := []aiMessage{
		{Role: "system", Content: securityAIAnalyzeSystem},
		{Role: "user", Content: prompt.String()},
	}
	var lastErr error
	for i, p := range providers {
		start := time.Now()
		ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
		reply, err := s.aiChat(ctx, p, msgs, nil, nil)
		cancel()
		ms := time.Since(start).Milliseconds()
		u := usageFrom(p, reply)
		u.User, u.IP, u.Feature, u.Target, u.Session = session.User, clientIP(r), "security", cveID, firstNonEmptyStr(in.ClusterID, "security-center")
		u.MS, u.OK, u.Failover = ms, err == nil, i > 0
		if err != nil {
			u.Error = truncRunes(err.Error(), 200)
			s.aiRecordUsage(u)
			lastErr = err
			continue
		}
		s.aiRecordUsage(u)

		var parsed struct {
			SummaryZH            string   `json:"summary_zh"`
			Exploitability       string   `json:"exploitability"`
			ExploitabilityReason string   `json:"exploitability_reason"`
			MitigationSteps      []string `json:"mitigation_steps"`
			UpgradeGuidance      string   `json:"upgrade_guidance"`
			ProbeHint            string   `json:"probe_hint"`
			SuggestedVEXStatus   string   `json:"suggested_vex_status"`
			SuggestedVEXNote     string   `json:"suggested_vex_note"`
		}
		raw := extractJSON(reply.Text)
		if raw == "" || json.Unmarshal([]byte(raw), &parsed) != nil || parsed.SummaryZH == "" {
			parsed.SummaryZH = strings.TrimSpace(reply.Text)
			parsed.Exploitability = "medium"
		}
		if parsed.MitigationSteps == nil {
			parsed.MitigationSteps = []string{}
		}
		s.auditReq(r, "security-ai-analyze", session.User, cveID)
		s.writeJSON(w, 200, map[string]any{
			"cve":                   cveID,
			"summary_zh":            parsed.SummaryZH,
			"exploitability":        parsed.Exploitability,
			"exploitability_reason": parsed.ExploitabilityReason,
			"mitigation_steps":      parsed.MitigationSteps,
			"upgrade_guidance":      parsed.UpgradeGuidance,
			"probe_hint":            parsed.ProbeHint,
			"suggested_vex_status":  parsed.SuggestedVEXStatus,
			"suggested_vex_note":    parsed.SuggestedVEXNote,
			"model":                 p.Model,
			"ms":                    ms,
		})
		return
	}
	s.fail(w, 502, "AI 安全研判调用失败："+lastErr.Error())
}

const securityAIPolishSystem = `你是企业级中间件安全合规与 VEX (Vulnerability Exploitability eXchange) 审计文案专家。
你的任务是将运维/安全工程师随手写的简短口语化说明（或在用户未填写时基于给定漏洞与状态起草初稿）润色优化为清晰、规范、可直接用于安全审计留痕的中文处置依据。
核心规则：
1. 严格忠于用户草稿中提到的事实，绝对不要编造用户未提及的测试结果、IP、防火墙厂商型号或具体日期；若某项信息缺失且必要，可保持客观简洁，无需虚构。
2. 文风专业、精炼、客观，控制在 1～3 句话（60～200 字以内），直接可写入 VEX 审计报告，不要使用“尊敬的”、“您好”等客套语或 Markdown 标题。
3. 严格只输出一个 JSON 对象，不要附加 Markdown 代码块：
{
  "polished_note": "优化后的规范中文处置依据/豁免说明",
  "suggested_justification": "仅在状态为 mitigated 或 not_affected 且明确对应时填 vulnerable_code_not_in_execute_path | inline_mitigations_already_exist | component_not_present，否则留空字符串",
  "status_hint": "若用户草稿语义与当前所选 VEX 状态明显不一致时，给出简短中文提醒（仅引用平台 5 种中文状态名称：待评估 / 计划修复 / 已缓解 / 不受影响 / 风险豁免，不要输出 affected、under_investigation 等外部英文术语），一致或合理时留空字符串"
}`

func (s *storeServer) handleSecurityAIPolish(w http.ResponseWriter, r *http.Request, session storeSession) {
	if !s.need(w, session.User, "security.manage") {
		return
	}
	if code, msg := s.checkAIFeature(session.User, "security"); code != 0 {
		s.fail(w, code, msg)
		return
	}
	var in struct {
		Kind             string   `json:"kind"` // vex (default) | baseline
		CVE              string   `json:"cve"`
		CVEs             []string `json:"cves"`
		Package          string   `json:"package"`
		Ecosystem        string   `json:"ecosystem"`
		InstalledVersion string   `json:"installed_version"`
		FixedIn          []string `json:"fixed_in"`
		PkgRole          string   `json:"pkg_role"`
		Summary          string   `json:"summary"`
		ClusterID        string   `json:"cluster_id"`
		Status           string   `json:"status"`
		Justification    string   `json:"justification"`
		DraftNote        string   `json:"draft_note"`
		BaselineTitle    string   `json:"baseline_title"`
		BaselineDetail   string   `json:"baseline_detail"`
		Model            string   `json:"model"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in) != nil {
		s.fail(w, 400, "请求参数格式错误")
		return
	}
	in.Kind = strings.ToLower(strings.TrimSpace(in.Kind))
	if in.Kind == "" {
		in.Kind = "vex"
	}
	in.DraftNote = truncRunes(strings.TrimSpace(in.DraftNote), 600)
	in.Status = strings.ToLower(strings.TrimSpace(in.Status))

	st := s.aiLoad()
	providers := st.aiProvidersForPick("security", in.Model)
	if len(providers) == 0 {
		s.fail(w, 409, "「安全 AI」未配置可用模型，请管理员在平台设置 → AI 中配置模型")
		return
	}
	if st.MonthlyLimit > 0 && s.aiCallsThisMonth(session.User) >= st.MonthlyLimit {
		s.fail(w, 429, "本月 AI 使用次数已达上限")
		return
	}

	var prompt strings.Builder
	target := firstNonEmptyStr(in.CVE, in.BaselineTitle, "vex-batch")
	if in.Kind == "baseline" {
		fmt.Fprintf(&prompt, "【任务类型】配置安全基线豁免说明润色\n")
		fmt.Fprintf(&prompt, "- 集群：%s\n- 基线检查项：%s\n", firstNonEmptyStr(in.ClusterID, "—"), in.BaselineTitle)
		if in.BaselineDetail != "" {
			fmt.Fprintf(&prompt, "- 检测详情：%s\n", truncRunes(in.BaselineDetail, 400))
		}
	} else {
		fmt.Fprintf(&prompt, "【任务类型】VEX 漏洞处置依据润色\n")
		if in.CVE != "" {
			fmt.Fprintf(&prompt, "- 漏洞编号：%s\n", in.CVE)
		} else if len(in.CVEs) > 0 {
			fmt.Fprintf(&prompt, "- 批量漏洞（共 %d 条）：%s\n", len(in.CVEs), strings.Join(in.CVEs[:min(len(in.CVEs), 8)], ", "))
		}
		if in.Package != "" {
			roleDesc := "OS 底层依赖包"
			if in.PkgRole == "primary" {
				roleDesc = "中间件本体"
			} else if in.PkgRole == "runtime" {
				roleDesc = "控制机运行环境"
			}
			fmt.Fprintf(&prompt, "- 软件包：%s（%s，当前版本 %s，生态 %s）\n", in.Package, roleDesc, in.InstalledVersion, in.Ecosystem)
		}
		if len(in.FixedIn) > 0 {
			fmt.Fprintf(&prompt, "- 修复版本：%s\n", strings.Join(in.FixedIn[:min(len(in.FixedIn), 3)], ", "))
		}
		if in.Summary != "" {
			fmt.Fprintf(&prompt, "- 漏洞摘要：%s\n", truncRunes(in.Summary, 400))
		}
		if in.ClusterID != "" {
			fmt.Fprintf(&prompt, "- 所在集群：%s\n", in.ClusterID)
		}
		statusLabel := map[string]string{
			"open":         "待评估",
			"planned":      "计划修复",
			"mitigated":    "已缓解",
			"not_affected": "不受影响",
			"accepted":     "风险豁免",
		}[in.Status]
		if statusLabel == "" {
			statusLabel = "已缓解"
		}
		fmt.Fprintf(&prompt, "- 操作员所选 VEX 状态：%s（%s）\n", statusLabel, firstNonEmptyStr(in.Status, "mitigated"))
		if in.Justification != "" {
			fmt.Fprintf(&prompt, "- 已选 VEX 标准依据：%s\n", in.Justification)
		}
	}
	if in.DraftNote != "" {
		fmt.Fprintf(&prompt, "\n【操作员简写草稿（请严格基于此内容润色优化，不要虚构未提及的事实）】\n%s\n", aiScrub(in.DraftNote))
	} else {
		fmt.Fprintf(&prompt, "\n【操作员尚未填写草稿】请结合上述漏洞与所选状态，起草一段简洁专业、符合该 VEX 状态语义的审计说明模板（需要现场确认的具体细节可用「（待核实补充）」标注，切勿编造虚假事实）。\n")
	}

	msgs := []aiMessage{
		{Role: "system", Content: securityAIPolishSystem},
		{Role: "user", Content: prompt.String()},
	}
	var lastErr error
	for i, p := range providers {
		start := time.Now()
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		reply, err := s.aiChat(ctx, p, msgs, nil, nil)
		cancel()
		ms := time.Since(start).Milliseconds()
		u := usageFrom(p, reply)
		u.User, u.IP, u.Feature, u.Target, u.Session = session.User, clientIP(r), "security", target, firstNonEmptyStr(in.ClusterID, "security-vex")
		u.MS, u.OK, u.Failover = ms, err == nil, i > 0
		if err != nil {
			u.Error = truncRunes(err.Error(), 200)
			s.aiRecordUsage(u)
			lastErr = err
			continue
		}
		s.aiRecordUsage(u)

		var parsed struct {
			PolishedNote           string `json:"polished_note"`
			SuggestedJustification string `json:"suggested_justification"`
			StatusHint             string `json:"status_hint"`
		}
		raw := extractJSON(reply.Text)
		if raw == "" || json.Unmarshal([]byte(raw), &parsed) != nil || strings.TrimSpace(parsed.PolishedNote) == "" {
			parsed.PolishedNote = strings.TrimSpace(reply.Text)
		}
		validJust := map[string]bool{
			"vulnerable_code_not_in_execute_path": true,
			"inline_mitigations_already_exist":    true,
			"component_not_present":               true,
		}
		if !validJust[parsed.SuggestedJustification] {
			parsed.SuggestedJustification = ""
		}
		s.auditReq(r, "security-ai-polish", session.User, target)
		s.writeJSON(w, 200, map[string]any{
			"polished_note":           truncRunes(strings.TrimSpace(parsed.PolishedNote), 500),
			"suggested_justification": parsed.SuggestedJustification,
			"status_hint":             truncRunes(strings.TrimSpace(parsed.StatusHint), 180),
			"model":                   p.Model,
			"ms":                      ms,
		})
		return
	}
	msg := "AI 优化说明调用失败"
	if lastErr != nil {
		msg += "：" + lastErr.Error()
	}
	s.fail(w, 502, msg)
}

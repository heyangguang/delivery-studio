package server

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"delivery-studio/mwpack"
	"delivery-studio/pkglib"
)

// Enterprise Security & CVE Vulnerability Center — local advisory DB, online OSV sync, and air-gapped offline bundle export/import.

var (
	secDBMu        sync.Mutex
	secSyncMu      sync.Mutex
	secSyncSt      = secSyncStatus{}
	reCanonicalCVE = regexp.MustCompile(`(?i)CVE-\d{4}-\d{4,}`)
)

type secSyncStatus struct {
	Running    bool   `json:"running"`
	Mode       string `json:"mode,omitempty"` // online | offline-import
	StartedAt  string `json:"started_at,omitempty"`
	FinishedAt string `json:"finished_at,omitempty"`
	Progress   string `json:"progress,omitempty"`
	Error      string `json:"error,omitempty"`
}

type secAdvRange struct {
	Type         string `json:"type,omitempty"` // ECOSYSTEM | SEMVER
	Introduced   string `json:"introduced,omitempty"`
	Fixed        string `json:"fixed,omitempty"`
	LastAffected string `json:"last_affected,omitempty"`
}

// secDBAdvisory is one normalized vulnerability advisory stored in the local offline-capable DB.
type secDBAdvisory struct {
	ID         string        `json:"id"`                    // OSV / USN / GHSA / CVE ID
	CVE        string        `json:"cve,omitempty"`         // Primary CVE-YYYY-NNNNN when available
	Aliases    []string      `json:"aliases,omitempty"`     // Related IDs
	Ecosystem  string        `json:"ecosystem"`             // e.g. Ubuntu:24.04:LTS, Rocky Linux:9, PyPI
	Package    string        `json:"package"`               // Package name in ecosystem
	Summary    string        `json:"summary,omitempty"`
	Details    string        `json:"details,omitempty"`
	Severity   string        `json:"severity"`              // CRITICAL | HIGH | MEDIUM | LOW | UNKNOWN
	CVSSScore  float64       `json:"cvss_score,omitempty"`  // 0.0 - 10.0
	CVSSVector string        `json:"cvss_vector,omitempty"` // CVSS:3.1/...
	Ranges     []secAdvRange `json:"ranges,omitempty"`
	Versions   []string      `json:"versions,omitempty"`    // Exact affected versions if specified
	FixedIn    []string      `json:"fixed_in,omitempty"`    // Sorted list of fixed versions
	Published  string        `json:"published,omitempty"`
	Modified   string        `json:"modified,omitempty"`
	URL        string        `json:"url,omitempty"`
	Source     string        `json:"source,omitempty"`      // OSV | offline-bundle | custom
}

type secDBMeta struct {
	UpdatedAt     string   `json:"updated_at,omitempty"`
	UpdatedBy     string   `json:"updated_by,omitempty"`
	SourceMode    string   `json:"source_mode,omitempty"` // online | offline-import
	Ecosystems    []string `json:"ecosystems"`
	AdvisoryCount int      `json:"advisory_count"`
	PackageCount  int      `json:"package_count"`
	BundleSHA256  string   `json:"bundle_sha256,omitempty"`
	LastError     string   `json:"last_error,omitempty"`
}

type secTriageEvent struct {
	Status    string `json:"status"`
	Note      string `json:"note,omitempty"`
	ExpiresAt string `json:"expires_at,omitempty"`
	By        string `json:"by"`
	At        string `json:"at"`
}

// secTriageRecord stores VEX vulnerability assessment / waiver state for a CVE (global or per-package/cluster scope).
type secTriageRecord struct {
	Key               string           `json:"key"`                       // canonical key: cve_or_id | package | ecosystem (or cve_or_id for global)
	VulnID            string           `json:"vuln_id"`                   // CVE or advisory ID
	Package           string           `json:"package,omitempty"`         // optional narrow scope
	Ecosystem         string           `json:"ecosystem,omitempty"`
	Status            string           `json:"status"`                    // open | planned | mitigated | not_affected | accepted
	Justification     string           `json:"justification,omitempty"`   // VEX justification code/reason
	Note              string           `json:"note,omitempty"`
	ExpiresAt         string           `json:"expires_at,omitempty"`      // YYYY-MM-DD optional expiry for accepted risk
	LinkedClusterID   string           `json:"linked_cluster_id,omitempty"`
	LinkedRehearsalID string           `json:"linked_rehearsal_id,omitempty"`
	LinkedSOPDocID    string           `json:"linked_sop_doc_id,omitempty"`
	UpdatedBy         string           `json:"updated_by"`
	UpdatedAt         string           `json:"updated_at"`
	History           []secTriageEvent `json:"history,omitempty"`
}

type secScanDiff struct {
	PrevScannedAt     string   `json:"prev_scanned_at,omitempty"`
	AddedCount        int      `json:"added_count"`
	ResolvedCount     int      `json:"resolved_count"`
	AddedCriticalHigh []string `json:"added_critical_high,omitempty"`
	ResolvedSample    []string `json:"resolved_sample,omitempty"`
}

type secScanHistoryEntry struct {
	ScannedAt        string            `json:"scanned_at"`
	ScannedBy        string            `json:"scanned_by,omitempty"`
	DBAdvisoryCount  int               `json:"db_advisory_count"`
	SBOMPackageCount int               `json:"sbom_package_count"`
	AffectedClusters int               `json:"affected_clusters"`
	ActiveCounts     secSeverityCounts `json:"active_counts"`
	WaivedCount      int               `json:"waived_count"`
	AddedCount       int               `json:"added_count"`
	ResolvedCount    int               `json:"resolved_count"`
	ActiveKeys       []string          `json:"active_keys,omitempty"`
}

type secBaselineWaiver struct {
	ClusterID string `json:"cluster_id"`
	CheckID   string `json:"check_id"`
	Note      string `json:"note,omitempty"`
	By        string `json:"by"`
	At        string `json:"at"`
}

// secIgnoreRule globally suppresses CVEs for a package (optionally scoped to one ecosystem),
// hiding them from default views and excluding them from counts, cluster scores, and publish gates.
type secIgnoreRule struct {
	ID        string `json:"id"`                  // deterministic key e.g. "pkg|openssl|ubuntu:24.04" or "pkg|openssl|*"
	Kind      string `json:"kind"`                // "package"
	Package   string `json:"package"`             // package name
	EcoKey    string `json:"eco_key,omitempty"`   // empty or "*" = all ecosystems, else e.g. "ubuntu:24.04"
	Ecosystem string `json:"ecosystem,omitempty"` // display label e.g. "Ubuntu:24.04:LTS"
	PkgRole   string `json:"pkg_role,omitempty"`  // primary | dependency | runtime (informational)
	Note      string `json:"note,omitempty"`
	By        string `json:"by,omitempty"`
	At        string `json:"at,omitempty"`
}

// secPolicy holds platform-wide security governance, global perspective, ignore rules & policy gate settings.
type secPolicy struct {
	BlockPublishCritical bool            `json:"block_publish_critical"`     // Block component publish if unwaived Critical CVE exists
	WarnPublishHigh      bool            `json:"warn_publish_high"`          // Surface warning badge/notice for High/Critical
	WarnDeliveryCritical bool            `json:"warn_delivery_critical"`     // Warn during formal delivery creation
	NotifyOnScan         bool            `json:"notify_on_scan"`             // Notify enabled channels when scan finds unwaived Critical/High on production clusters
	GateMiddlewareOnly   bool            `json:"gate_middleware_only"`       // Only count middleware primary packages (ignore OS base libs) for publish gates, cluster scoring & scan alerts
	HideOSCVEs           bool            `json:"hide_os_cves"`               // Global perspective: hide OS base library CVEs globally & exclude from counts, scoring & gates
	HideRuntimeCVEs      bool            `json:"hide_runtime_cves"`          // Global perspective: hide controller Ansible/Python runtime CVEs globally & exclude from counts & scoring
	IgnoredPackages      []secIgnoreRule `json:"ignored_packages,omitempty"` // Globally ignored packages (hidden & excluded from counts, scoring & gates)
}

func defaultSecPolicy() secPolicy {
	return secPolicy{
		BlockPublishCritical: false,
		WarnPublishHigh:      true,
		WarnDeliveryCritical: true,
		NotifyOnScan:         false,
		GateMiddlewareOnly:   false,
		HideOSCVEs:           false,
		HideRuntimeCVEs:      false,
		IgnoredPackages:      []secIgnoreRule{},
	}
}

func normalizeSecIgnoreRuleID(pkg, ecoKey string) string {
	ek := strings.TrimSpace(ecoKey)
	if ek == "" || ek == "*" {
		ek = "*"
	} else {
		ek = normalizeEcoKey(ek)
	}
	pk := strings.ToLower(strings.TrimSpace(pkg))
	if ek != "*" {
		pk = normPkgForEco(ek, pk)
	}
	return "pkg|" + pk + "|" + ek
}

func matchGlobalIgnore(f *secFinding, policy secPolicy) (bool, string, string) {
	if f == nil {
		return false, "", ""
	}
	if policy.HideOSCVEs && f.PkgRole == "dependency" {
		return true, "layer:os", "全局视角已屏蔽 OS 底层包（不计入打分与门禁）"
	}
	if policy.HideRuntimeCVEs && f.PkgRole == "runtime" {
		return true, "layer:runtime", "全局视角已屏蔽运行环境依赖（不计入打分与门禁）"
	}
	pkgNorm := normPkgForEco(f.EcoKey, f.Package)
	for _, rule := range policy.IgnoredPackages {
		rp := strings.TrimSpace(rule.Package)
		if rp == "" {
			continue
		}
		re := strings.TrimSpace(rule.EcoKey)
		if re != "" && re != "*" && !strings.EqualFold(re, f.EcoKey) {
			continue
		}
		if strings.EqualFold(rp, f.Package) || normPkgForEco(f.EcoKey, rp) == pkgNorm {
			reason := "已全局忽略软件包 " + rp
			if strings.TrimSpace(rule.Note) != "" {
				reason = "全局忽略：" + strings.TrimSpace(rule.Note)
			}
			rid := rule.ID
			if rid == "" {
				rid = normalizeSecIgnoreRuleID(rp, re)
			}
			return true, rid, reason
		}
	}
	return false, "", ""
}

func applyGlobalIgnoreToFinding(f *secFinding, policy secPolicy) {
	if ignored, rid, reason := matchGlobalIgnore(f, policy); ignored {
		f.GloballyIgnored = true
		f.IgnoreRuleID = rid
		f.IgnoreReason = reason
	} else {
		f.GloballyIgnored = false
		f.IgnoreRuleID = ""
		f.IgnoreReason = ""
	}
}

func (s *storeServer) secDir() string {
	return filepath.Join(s.cfg.DataDir, "security")
}

func (s *storeServer) loadSecAdvisories() []secDBAdvisory {
	if s.cfg.DataDir == "" {
		return []secDBAdvisory{}
	}
	b, err := os.ReadFile(filepath.Join(s.secDir(), "advisories.json"))
	if err != nil {
		return []secDBAdvisory{}
	}
	var out []secDBAdvisory
	if json.Unmarshal(b, &out) != nil || out == nil {
		return []secDBAdvisory{}
	}
	return out
}

func (s *storeServer) saveSecAdvisories(list []secDBAdvisory) error {
	if list == nil {
		list = []secDBAdvisory{}
	}
	return writeJSONFile(filepath.Join(s.secDir(), "advisories.json"), list)
}

func (s *storeServer) loadSecMeta() secDBMeta {
	m := secDBMeta{Ecosystems: []string{}}
	if s.cfg.DataDir == "" {
		return m
	}
	if b, err := os.ReadFile(filepath.Join(s.secDir(), "meta.json")); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	if m.Ecosystems == nil {
		m.Ecosystems = []string{}
	}
	return m
}

func (s *storeServer) saveSecMeta(m secDBMeta) error {
	if m.Ecosystems == nil {
		m.Ecosystems = []string{}
	}
	return writeJSONFile(filepath.Join(s.secDir(), "meta.json"), m)
}

func (s *storeServer) loadSecTriage() map[string]secTriageRecord {
	out := map[string]secTriageRecord{}
	if s.cfg.DataDir == "" {
		return out
	}
	b, err := os.ReadFile(filepath.Join(s.secDir(), "triage.json"))
	if err != nil {
		return out
	}
	var list []secTriageRecord
	if json.Unmarshal(b, &list) == nil {
		for _, r := range list {
			if r.Key != "" {
				out[r.Key] = r
			}
		}
	}
	return out
}

func (s *storeServer) saveSecTriage(m map[string]secTriageRecord) error {
	list := make([]secTriageRecord, 0, len(m))
	for _, r := range m {
		list = append(list, r)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].UpdatedAt > list[j].UpdatedAt })
	return writeJSONFile(filepath.Join(s.secDir(), "triage.json"), list)
}

func (s *storeServer) loadSecPolicy() secPolicy {
	p := defaultSecPolicy()
	if s.cfg.DataDir == "" {
		return p
	}
	if b, err := os.ReadFile(filepath.Join(s.secDir(), "policy.json")); err == nil {
		_ = json.Unmarshal(b, &p)
	}
	if p.IgnoredPackages == nil {
		p.IgnoredPackages = []secIgnoreRule{}
	}
	return p
}

func (s *storeServer) saveSecPolicy(p secPolicy) error {
	if p.IgnoredPackages == nil {
		p.IgnoredPackages = []secIgnoreRule{}
	}
	return writeJSONFile(filepath.Join(s.secDir(), "policy.json"), p)
}

func (s *storeServer) loadLatestScan() *secScanReport {
	if s.cfg.DataDir == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(s.secDir(), "scans", "latest.json"))
	if err != nil {
		return nil
	}
	var r secScanReport
	if json.Unmarshal(b, &r) != nil {
		return nil
	}
	return &r
}

func (s *storeServer) saveLatestScan(r *secScanReport) error {
	if r == nil || s.cfg.DataDir == "" {
		return nil
	}
	return writeJSONFile(filepath.Join(s.secDir(), "scans", "latest.json"), r)
}

func (s *storeServer) loadSecHistory() []secScanHistoryEntry {
	if s.cfg.DataDir == "" {
		return []secScanHistoryEntry{}
	}
	b, err := os.ReadFile(filepath.Join(s.secDir(), "scans", "history.json"))
	if err != nil {
		return []secScanHistoryEntry{}
	}
	var out []secScanHistoryEntry
	if json.Unmarshal(b, &out) != nil || out == nil {
		return []secScanHistoryEntry{}
	}
	return out
}

func (s *storeServer) saveSecHistory(list []secScanHistoryEntry) error {
	if s.cfg.DataDir == "" {
		return nil
	}
	if len(list) > 30 {
		list = list[:30]
	}
	return writeJSONFile(filepath.Join(s.secDir(), "scans", "history.json"), list)
}

func (s *storeServer) loadSecBaselineWaivers() map[string]secBaselineWaiver {
	out := map[string]secBaselineWaiver{}
	if s.cfg.DataDir == "" {
		return out
	}
	b, err := os.ReadFile(filepath.Join(s.secDir(), "baseline_waivers.json"))
	if err != nil {
		return out
	}
	var list []secBaselineWaiver
	if json.Unmarshal(b, &list) == nil {
		for _, w := range list {
			if w.ClusterID != "" && w.CheckID != "" {
				out[w.ClusterID+"|"+w.CheckID] = w
			}
		}
	}
	return out
}

func (s *storeServer) saveSecBaselineWaivers(m map[string]secBaselineWaiver) error {
	if s.cfg.DataDir == "" {
		return nil
	}
	list := make([]secBaselineWaiver, 0, len(m))
	for _, w := range m {
		list = append(list, w)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].ClusterID != list[j].ClusterID {
			return list[i].ClusterID < list[j].ClusterID
		}
		return list[i].CheckID < list[j].CheckID
	})
	return writeJSONFile(filepath.Join(s.secDir(), "baseline_waivers.json"), list)
}

// ---- Ecosystem & CVSS v3.x normalization ----

func platformToOSVEcosystems(platformID string) []string {
	def, ok := mwpack.PlatformByID(platformID)
	if !ok {
		switch {
		case strings.HasPrefix(platformID, "ubuntu-24.04"):
			return []string{"Ubuntu:24.04:LTS"}
		case strings.HasPrefix(platformID, "ubuntu-22.04"):
			return []string{"Ubuntu:22.04:LTS"}
		case strings.HasPrefix(platformID, "el9"):
			return []string{"Rocky Linux:9", "Red Hat:enterprise_linux:9"}
		case strings.HasPrefix(platformID, "el8"):
			return []string{"Rocky Linux:8", "Red Hat:enterprise_linux:8"}
		default:
			return nil
		}
	}
	for _, osid := range def.OSIDs {
		switch strings.ToLower(osid) {
		case "ubuntu":
			ver := strings.TrimSpace(def.Version)
			if ver == "24.04" || ver == "22.04" || ver == "20.04" {
				return []string{"Ubuntu:" + ver + ":LTS"}
			}
			if ver != "" {
				return []string{"Ubuntu:" + ver}
			}
			return []string{"Ubuntu"}
		case "debian":
			if def.Version != "" {
				return []string{"Debian:" + def.Version}
			}
			return []string{"Debian"}
		case "rocky", "almalinux", "rhel", "centos", "ol":
			maj := strings.SplitN(strings.TrimSpace(def.Version), ".", 2)[0]
			if maj != "" {
				return []string{"Rocky Linux:" + maj, "Red Hat:enterprise_linux:" + maj}
			}
			return []string{"Rocky Linux", "Red Hat"}
		}
	}
	return nil
}

func normalizeEcoKey(eco string) string {
	s := strings.ToLower(strings.TrimSpace(eco))
	switch {
	case s == "pypi" || s == "python":
		return "pypi"
	case strings.HasPrefix(s, "ubuntu:24.04"):
		return "ubuntu:24.04"
	case strings.HasPrefix(s, "ubuntu:22.04"):
		return "ubuntu:22.04"
	case strings.HasPrefix(s, "ubuntu:"):
		parts := strings.Split(s, ":")
		if len(parts) >= 2 {
			return "ubuntu:" + parts[1]
		}
		return "ubuntu"
	case strings.HasPrefix(s, "debian:"):
		parts := strings.Split(s, ":")
		if len(parts) >= 2 {
			return "debian:" + parts[1]
		}
		return "debian"
	case strings.Contains(s, "rocky") || strings.Contains(s, "red hat") || strings.Contains(s, "almalinux") || strings.Contains(s, "rhel") || strings.HasPrefix(s, "el"):
		for _, maj := range []string{"10", "9", "8", "7"} {
			if strings.Contains(s, maj) {
				return "el:" + maj
			}
		}
		return "el"
	case s == "go":
		return "go"
	}
	return s
}

func normPkgForEco(ecoKey, pkg string) string {
	pkg = strings.TrimSpace(pkg)
	if ecoKey == "pypi" {
		return pkglib.NormPy(pkg)
	}
	return strings.ToLower(pkg)
}

// parseCVSS3Score calculates the CVSS v3.0 / v3.1 Base Score (0.0-10.0) from a vector string such as
// "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H". Returns 0 if not a valid v3 vector.
func parseCVSS3Score(vec string) float64 {
	vec = strings.TrimSpace(vec)
	if !strings.HasPrefix(vec, "CVSS:3.") {
		return 0
	}
	parts := strings.Split(vec, "/")
	m := map[string]string{}
	for _, p := range parts[1:] {
		k, v, ok := strings.Cut(p, ":")
		if ok {
			m[k] = v
		}
	}
	avMap := map[string]float64{"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.20}
	acMap := map[string]float64{"L": 0.77, "H": 0.44}
	uiMap := map[string]float64{"N": 0.85, "R": 0.62}
	ciaMap := map[string]float64{"H": 0.56, "L": 0.22, "N": 0.0}

	av, ok1 := avMap[m["AV"]]
	ac, ok2 := acMap[m["AC"]]
	ui, ok3 := uiMap[m["UI"]]
	c, ok4 := ciaMap[m["C"]]
	i, ok5 := ciaMap[m["I"]]
	a, ok6 := ciaMap[m["A"]]
	scope := m["S"]
	if !ok1 || !ok2 || !ok3 || !ok4 || !ok5 || !ok6 || (scope != "U" && scope != "C") {
		return 0
	}
	var pr float64
	switch m["PR"] {
	case "N":
		pr = 0.85
	case "L":
		if scope == "C" {
			pr = 0.68
		} else {
			pr = 0.62
		}
	case "H":
		if scope == "C" {
			pr = 0.50
		} else {
			pr = 0.27
		}
	default:
		return 0
	}
	iss := 1 - ((1 - c) * (1 - i) * (1 - a))
	var impact float64
	if scope == "U" {
		impact = 6.42 * iss
	} else {
		impact = 7.52*(iss-0.029) - 3.25*math.Pow(iss-0.02, 15)
	}
	if impact <= 0 {
		return 0
	}
	exploitability := 8.22 * av * ac * pr * ui
	var raw float64
	if scope == "U" {
		raw = math.Min(impact+exploitability, 10)
	} else {
		raw = math.Min(1.08*(impact+exploitability), 10)
	}
	// CVSS v3.1 Roundup to 1 decimal place
	return math.Ceil(raw*10-1e-9) / 10
}

func severityFromScore(score float64) string {
	switch {
	case score >= 9.0:
		return "CRITICAL"
	case score >= 7.0:
		return "HIGH"
	case score >= 4.0:
		return "MEDIUM"
	case score > 0:
		return "LOW"
	default:
		return "UNKNOWN"
	}
}

func normalizeSeverity(raw string, score float64) string {
	u := strings.ToUpper(strings.TrimSpace(raw))
	switch {
	case strings.Contains(u, "CRITICAL"):
		return "CRITICAL"
	case strings.Contains(u, "HIGH") || strings.Contains(u, "IMPORTANT"):
		return "HIGH"
	case strings.Contains(u, "MODERATE") || strings.Contains(u, "MEDIUM"):
		return "MEDIUM"
	case strings.Contains(u, "LOW") || strings.Contains(u, "NEGLIGIBLE"):
		return "LOW"
	}
	if score > 0 {
		return severityFromScore(score)
	}
	return "UNKNOWN"
}

func severityRank(sev string) int {
	switch strings.ToUpper(sev) {
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

func primaryCVE(id string, aliases []string) string {
	u := strings.ToUpper(strings.TrimSpace(id))
	if strings.HasPrefix(u, "CVE-") {
		return u
	}
	for _, a := range aliases {
		au := strings.ToUpper(strings.TrimSpace(a))
		if strings.HasPrefix(au, "CVE-") {
			return au
		}
	}
	// Normalize vendor-prefixed CVE IDs such as UBUNTU-CVE-2024-41184 or DEBIAN-CVE-2024-12345.
	if m := reCanonicalCVE.FindString(u); m != "" {
		return strings.ToUpper(m)
	}
	for _, a := range aliases {
		if m := reCanonicalCVE.FindString(a); m != "" {
			return strings.ToUpper(m)
		}
	}
	return strings.TrimSpace(id)
}

// osvFullDoc extends osvVulnDoc with exact affected versions and last_affected ranges.
type osvFullDoc struct {
	ID               string   `json:"id"`
	Aliases          []string `json:"aliases"`
	Summary          string   `json:"summary"`
	Details          string   `json:"details"`
	Published        string   `json:"published"`
	Modified         string   `json:"modified"`
	Severity         []struct {
		Type  string `json:"type"`
		Score string `json:"score"`
	} `json:"severity"`
	DatabaseSpecific struct {
		Severity string `json:"severity"`
	} `json:"database_specific"`
	Affected []struct {
		Package struct {
			Name      string `json:"name"`
			Ecosystem string `json:"ecosystem"`
		} `json:"package"`
		Ranges []struct {
			Type   string `json:"type"`
			Events []struct {
				Introduced   string `json:"introduced,omitempty"`
				Fixed        string `json:"fixed,omitempty"`
				LastAffected string `json:"last_affected,omitempty"`
			} `json:"events"`
		} `json:"ranges"`
		Versions []string `json:"versions"`
	} `json:"affected"`
	References []struct {
		Type string `json:"type"`
		URL  string `json:"url"`
	} `json:"references"`
}

func advisoriesFromOSVDoc(doc osvFullDoc, source string) []secDBAdvisory {
	if doc.ID == "" {
		return nil
	}
	var score float64
	var vec string
	for _, sv := range doc.Severity {
		if strings.HasPrefix(sv.Score, "CVSS:3.") {
			if sc := parseCVSS3Score(sv.Score); sc > score {
				score = sc
				vec = sv.Score
			}
		}
	}
	sev := normalizeSeverity(doc.DatabaseSpecific.Severity, score)
	if sev == "UNKNOWN" && score > 0 {
		sev = severityFromScore(score)
	}
	cve := primaryCVE(doc.ID, doc.Aliases)
	summary := strings.TrimSpace(doc.Summary)
	if summary == "" && doc.Details != "" {
		first := strings.TrimSpace(strings.SplitN(doc.Details, "\n", 2)[0])
		summary = truncRunes(first, 200)
	}
	refURL := "https://osv.dev/vulnerability/" + doc.ID
	for _, ref := range doc.References {
		if ref.Type == "ADVISORY" && strings.HasPrefix(ref.URL, "http") {
			refURL = ref.URL
			break
		}
	}

	var out []secDBAdvisory
	seenPkg := map[string]int{}
	for _, af := range doc.Affected {
		pkg := strings.TrimSpace(af.Package.Name)
		eco := strings.TrimSpace(af.Package.Ecosystem)
		if pkg == "" || eco == "" {
			continue
		}
		var ranges []secAdvRange
		var fixedIn []string
		fixedSeen := map[string]bool{}
		for _, rg := range af.Ranges {
			if strings.EqualFold(strings.TrimSpace(rg.Type), "GIT") {
				// OSV GIT ranges use raw commit SHAs rather than package versions; comparing them
				// against PyPI/DEB/RPM version strings produces false positives and raw SHA fixes.
				continue
			}
			var cur secAdvRange
			cur.Type = rg.Type
			hasOpen := false
			for _, ev := range rg.Events {
				if ev.Introduced != "" {
					if hasOpen {
						ranges = append(ranges, cur)
					}
					cur = secAdvRange{Type: rg.Type, Introduced: ev.Introduced}
					hasOpen = true
				}
				if ev.Fixed != "" {
					if !hasOpen {
						cur = secAdvRange{Type: rg.Type, Introduced: "0"}
					}
					cur.Fixed = ev.Fixed
					ranges = append(ranges, cur)
					hasOpen = false
					if !fixedSeen[ev.Fixed] && !isGitCommitHash(ev.Fixed) {
						fixedSeen[ev.Fixed] = true
						fixedIn = append(fixedIn, ev.Fixed)
					}
				}
				if ev.LastAffected != "" {
					if !hasOpen {
						cur = secAdvRange{Type: rg.Type, Introduced: "0"}
					}
					cur.LastAffected = ev.LastAffected
					ranges = append(ranges, cur)
					hasOpen = false
				}
			}
			if hasOpen {
				ranges = append(ranges, cur)
			}
		}
		key := doc.ID + "|" + strings.ToLower(eco) + "|" + strings.ToLower(pkg)
		if idx, exists := seenPkg[key]; exists {
			out[idx].Ranges = append(out[idx].Ranges, ranges...)
			out[idx].Versions = append(out[idx].Versions, af.Versions...)
			for _, fx := range fixedIn {
				if !contains(out[idx].FixedIn, fx) {
					out[idx].FixedIn = append(out[idx].FixedIn, fx)
				}
			}
			continue
		}
		seenPkg[key] = len(out)
		out = append(out, secDBAdvisory{
			ID:         doc.ID,
			CVE:        cve,
			Aliases:    doc.Aliases,
			Ecosystem:  eco,
			Package:    pkg,
			Summary:    summary,
			Details:    truncRunes(strings.TrimSpace(doc.Details), 1200),
			Severity:   sev,
			CVSSScore:  score,
			CVSSVector: vec,
			Ranges:     ranges,
			Versions:   af.Versions,
			FixedIn:    fixedIn,
			Published:  doc.Published,
			Modified:   doc.Modified,
			URL:        refURL,
			Source:     source,
		})
	}
	return out
}

func mergeSecAdvisories(existing, incoming []secDBAdvisory) []secDBAdvisory {
	byKey := map[string]secDBAdvisory{}
	keyOf := func(a secDBAdvisory) string {
		return strings.ToUpper(a.ID) + "|" + normalizeEcoKey(a.Ecosystem) + "|" + normPkgForEco(normalizeEcoKey(a.Ecosystem), a.Package)
	}
	for _, a := range existing {
		byKey[keyOf(a)] = a
	}
	for _, a := range incoming {
		if a.ID == "" || a.Package == "" {
			continue
		}
		if a.CVE == "" {
			a.CVE = primaryCVE(a.ID, a.Aliases)
		}
		if a.CVSSScore == 0 && a.CVSSVector != "" {
			a.CVSSScore = parseCVSS3Score(a.CVSSVector)
		}
		a.Severity = normalizeSeverity(a.Severity, a.CVSSScore)
		byKey[keyOf(a)] = a
	}
	out := make([]secDBAdvisory, 0, len(byKey))
	for _, a := range byKey {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool {
		if ri, rj := severityRank(out[i].Severity), severityRank(out[j].Severity); ri != rj {
			return ri > rj
		}
		if out[i].CVE != out[j].CVE {
			return out[i].CVE > out[j].CVE
		}
		return out[i].Package < out[j].Package
	})
	return out
}

func summarizeSecDBMeta(list []secDBAdvisory, mode, user, sha string) secDBMeta {
	ecoSet := map[string]bool{}
	pkgSet := map[string]bool{}
	for _, a := range list {
		if a.Ecosystem != "" {
			ecoSet[a.Ecosystem] = true
		}
		pkgSet[normalizeEcoKey(a.Ecosystem)+"|"+strings.ToLower(a.Package)] = true
	}
	ecos := make([]string, 0, len(ecoSet))
	for e := range ecoSet {
		ecos = append(ecos, e)
	}
	sort.Strings(ecos)
	return secDBMeta{
		UpdatedAt:     now(),
		UpdatedBy:     user,
		SourceMode:    mode,
		Ecosystems:    ecos,
		AdvisoryCount: len(list),
		PackageCount:  len(pkgSet),
		BundleSHA256:  sha,
	}
}

// syncSecurityDBOnline syncs all enabled CVE vulnerability feed sources (defaulting to OSV.dev + any configured
// custom mirrors/feeds) and stores normalized advisories locally so all future scans run instantaneously offline.
func (s *storeServer) syncSecurityDBOnline(ctx context.Context, user string) (secDBMeta, error) {
	return s.syncSecurityDBFromSources(ctx, user, "")
}

type secBundleManifest struct {
	Format        string   `json:"format"`
	ExportedAt    string   `json:"exported_at"`
	SourceMode    string   `json:"source_mode"`
	Ecosystems    []string `json:"ecosystems"`
	AdvisoryCount int      `json:"advisory_count"`
	PackageCount  int      `json:"package_count"`
}

// exportSecurityDBBundle writes an integrity-checked offline .tar.gz vulnerability bundle (manifest.json + advisories.json + SHA256SUMS).
func (s *storeServer) exportSecurityDBBundle(w io.Writer) error {
	secDBMu.Lock()
	advs := s.loadSecAdvisories()
	meta := s.loadSecMeta()
	secDBMu.Unlock()

	advBytes, err := json.MarshalIndent(advs, "", "  ")
	if err != nil {
		return err
	}
	man := secBundleManifest{
		Format:        "mh-sec-db/v1",
		ExportedAt:    now(),
		SourceMode:    meta.SourceMode,
		Ecosystems:    meta.Ecosystems,
		AdvisoryCount: len(advs),
		PackageCount:  meta.PackageCount,
	}
	manBytes, err := json.MarshalIndent(man, "", "  ")
	if err != nil {
		return err
	}
	sumHex := func(b []byte) string {
		h := sha256.Sum256(b)
		return hex.EncodeToString(h[:])
	}
	sums := fmt.Sprintf("%s  manifest.json\n%s  advisories.json\n", sumHex(manBytes), sumHex(advBytes))

	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	writeFile := func(name string, data []byte) error {
		hdr := &tar.Header{
			Name:    name,
			Mode:    0o644,
			Size:    int64(len(data)),
			ModTime: time.Now().UTC(),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		_, err := tw.Write(data)
		return err
	}
	if err := writeFile("manifest.json", manBytes); err != nil {
		return err
	}
	if err := writeFile("advisories.json", advBytes); err != nil {
		return err
	}
	if err := writeFile("SHA256SUMS", []byte(sums)); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

// importSecurityDBBundle imports an offline vulnerability DB from either:
//   - an exported .tar.gz bundle (verifying SHA256SUMS strictly when present), OR
//   - a raw .json file containing []secDBAdvisory, []osvFullDoc, or a single osvFullDoc.
func (s *storeServer) importSecurityDBBundle(raw []byte, replace bool, user string) (secDBMeta, int, error) {
	if len(raw) == 0 {
		return s.loadSecMeta(), 0, errors.New("上传的漏洞库文件为空")
	}
	h := sha256.Sum256(raw)
	bundleSHA := hex.EncodeToString(h[:])

	var incoming []secDBAdvisory
	// Detect gzip magic bytes (0x1f 0x8b) for .tar.gz bundles.
	if len(raw) >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
		gz, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return s.loadSecMeta(), 0, fmt.Errorf("无法解压离线漏洞库包：%w", err)
		}
		defer gz.Close()
		tr := tar.NewReader(gz)
		files := map[string][]byte{}
		for {
			hdr, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return s.loadSecMeta(), 0, fmt.Errorf("离线漏洞库包损坏：%w", err)
			}
			if hdr.Typeflag != tar.TypeReg {
				continue
			}
			name := filepath.Base(hdr.Name)
			data, err := io.ReadAll(io.LimitReader(tr, 64<<20))
			if err != nil {
				return s.loadSecMeta(), 0, err
			}
			files[name] = data
		}
		if sumsRaw, ok := files["SHA256SUMS"]; ok {
			for _, line := range strings.Split(string(sumsRaw), "\n") {
				line = strings.TrimSpace(line)
				if line == "" {
					continue
				}
				fields := strings.Fields(line)
				if len(fields) < 2 {
					continue
				}
				want, fname := strings.ToLower(fields[0]), filepath.Base(fields[1])
				data, exists := files[fname]
				if !exists {
					return s.loadSecMeta(), 0, fmt.Errorf("离线漏洞库校验失败：缺少文件 %s", fname)
				}
				gotH := sha256.Sum256(data)
				if hex.EncodeToString(gotH[:]) != want {
					return s.loadSecMeta(), 0, fmt.Errorf("离线漏洞库 SHA256 校验失败（%s 已被篡改或损坏）", fname)
				}
			}
		}
		if advRaw, ok := files["advisories.json"]; ok {
			var parsed []secDBAdvisory
			if err := json.Unmarshal(advRaw, &parsed); err != nil {
				return s.loadSecMeta(), 0, fmt.Errorf("解析 advisories.json 失败：%w", err)
			}
			incoming = append(incoming, parsed...)
		} else {
			// Support OSV archive tar.gz containing individual *.json OSV advisory docs.
			for name, data := range files {
				if !strings.HasSuffix(strings.ToLower(name), ".json") || name == "manifest.json" {
					continue
				}
				incoming = append(incoming, parseFlexibleAdvisoryJSON(data)...)
			}
		}
	} else {
		incoming = parseFlexibleAdvisoryJSON(raw)
	}

	if len(incoming) == 0 {
		return s.loadSecMeta(), 0, errors.New("未在文件中识别到有效的 CVE/OSV 安全公告记录")
	}

	secDBMu.Lock()
	var base []secDBAdvisory
	if !replace {
		base = s.loadSecAdvisories()
	}
	merged := mergeSecAdvisories(base, incoming)
	if err := s.saveSecAdvisories(merged); err != nil {
		secDBMu.Unlock()
		return s.loadSecMeta(), 0, err
	}
	meta := summarizeSecDBMeta(merged, "offline-import", user, bundleSHA)
	_ = s.saveSecMeta(meta)
	secDBMu.Unlock()
	return meta, len(incoming), nil
}

func parseFlexibleAdvisoryJSON(raw []byte) []secDBAdvisory {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	// Try native []secDBAdvisory first (must have Package + Ecosystem).
	var native []secDBAdvisory
	if json.Unmarshal(trimmed, &native) == nil && len(native) > 0 && native[0].Package != "" && native[0].Ecosystem != "" {
		for i := range native {
			if native[i].Source == "" {
				native[i].Source = "offline-bundle"
			}
		}
		return native
	}
	// Try []osvFullDoc (standard OSV JSON array).
	var osvList []osvFullDoc
	if json.Unmarshal(trimmed, &osvList) == nil && len(osvList) > 0 && osvList[0].ID != "" {
		var out []secDBAdvisory
		for _, doc := range osvList {
			out = append(out, advisoriesFromOSVDoc(doc, "offline-bundle")...)
		}
		return out
	}
	// Try single osvFullDoc.
	var one osvFullDoc
	if json.Unmarshal(trimmed, &one) == nil && one.ID != "" && len(one.Affected) > 0 {
		return advisoriesFromOSVDoc(one, "offline-bundle")
	}
	// Try wrapper object {"advisories": [...]}.
	var wrap struct {
		Advisories []secDBAdvisory `json:"advisories"`
	}
	if json.Unmarshal(trimmed, &wrap) == nil && len(wrap.Advisories) > 0 {
		return wrap.Advisories
	}
	return nil
}

package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"middleware-deployer/mwpack"
	"middleware-deployer/pkglib"
)

// Deterministic SBOM extraction, native Deb/RPM/PEP440 vulnerability matching, blast-radius correlation, and VEX triage overlay.

type secSBOMItem struct {
	AssetType     string   `json:"asset_type"`               // os_package | python_runtime | component_declared
	PkgRole       string   `json:"pkg_role,omitempty"`       // primary | dependency | runtime
	Platform      string   `json:"platform,omitempty"`       // e.g. ubuntu-24.04-amd64, el9-amd64, python
	PlatformTitle string   `json:"platform_title,omitempty"` // e.g. Ubuntu 24.04
	Ecosystem     string   `json:"ecosystem"`                // Canonical display ecosystem e.g. Ubuntu:24.04:LTS, Rocky Linux:9, PyPI
	OSVEcosystems []string `json:"-"`                        // Candidate OSV ecosystem names for online query
	EcoKey        string   `json:"-"`                        // Normalized matching key: ubuntu:24.04, el:9, pypi
	Package       string   `json:"package"`
	Version       string   `json:"version"`
	SHA256        string   `json:"sha256,omitempty"`
	PURL          string   `json:"purl,omitempty"`
	Closures      []string `json:"closures,omitempty"`   // e.g. postgresql-17@17.2
	Runtimes      []string `json:"runtimes,omitempty"`   // e.g. rt-abc123 (default)
	Components    []string `json:"components,omitempty"` // e.g. postgresql@17@ubuntu-24.04-amd64
}

type secSBOMInventory struct {
	Items         []secSBOMItem
	Clusters      []secClusterSpec
	TotalClosures int
	TotalRuntimes int
}

type secClusterSpec struct {
	ClusterID    string
	AppID        string
	AppName      string
	Version      string
	Platform     string
	Owner        string
	DeliveryMode string
	Hosts        []string // "name (ip)"
	CompVerKeys  []string // "comp@ver@platform"
}

type secClusterImpact struct {
	ClusterID    string   `json:"cluster_id"`
	AppID        string   `json:"app_id,omitempty"`
	AppName      string   `json:"app_name"`
	Version      string   `json:"version,omitempty"`
	Platform     string   `json:"platform"`
	Owner        string   `json:"owner"`
	DeliveryMode string   `json:"delivery_mode,omitempty"`
	Hosts        []string `json:"hosts"`
}

type secCompImpact struct {
	Component string `json:"component"`
	Title     string `json:"title"`
	Version   string `json:"version"`
	Platform  string `json:"platform"`
}

type secFinding struct {
	Key              string             `json:"key"` // vuln_id|pkg|ecoKey
	ID               string             `json:"id"`
	CVE              string             `json:"cve"`
	Aliases          []string           `json:"aliases,omitempty"`
	Severity         string             `json:"severity"`
	CVSSScore        float64            `json:"cvss_score,omitempty"`
	CVSSVector       string             `json:"cvss_vector,omitempty"`
	Summary          string             `json:"summary,omitempty"`
	Details          string             `json:"details,omitempty"`
	URL              string             `json:"url,omitempty"`
	Published        string             `json:"published,omitempty"`
	Ecosystem        string             `json:"ecosystem"`
	EcoKey           string             `json:"eco_key"`
	Platform         string             `json:"platform,omitempty"`
	PlatformTitle    string             `json:"platform_title,omitempty"`
	AssetType        string             `json:"asset_type"` // os_package | python_runtime | component_declared
	PkgRole          string             `json:"pkg_role,omitempty"` // primary | dependency | runtime
	Package          string             `json:"package"`
	InstalledVersion string             `json:"installed_version"`
	FixedIn          []string           `json:"fixed_in,omitempty"`
	RepoFixVersion   string             `json:"repo_fix_version,omitempty"` // Fixed version already available in pkglib repo index
	Closures         []string           `json:"closures,omitempty"`
	Runtimes         []string           `json:"runtimes,omitempty"`
	Components       []secCompImpact    `json:"components,omitempty"`
	Clusters         []secClusterImpact `json:"clusters,omitempty"`
	// VEX Triage overlay
	TriageStatus      string           `json:"triage_status"` // open | planned | mitigated | not_affected | accepted | expired
	TriageNote        string           `json:"triage_note,omitempty"`
	TriageJust        string           `json:"triage_justification,omitempty"`
	TriageExpires     string           `json:"triage_expires,omitempty"`
	TriageBy          string           `json:"triage_by,omitempty"`
	TriageAt          string           `json:"triage_at,omitempty"`
	TriageHistory     []secTriageEvent `json:"triage_history,omitempty"`
	LinkedClusterID   string           `json:"linked_cluster_id,omitempty"`
	LinkedRehearsalID string           `json:"linked_rehearsal_id,omitempty"`
	LinkedSOPDocID    string           `json:"linked_sop_doc_id,omitempty"`
	Waived            bool             `json:"waived,omitempty"`           // true when mitigated, not_affected, or unexpired accepted
	GloballyIgnored   bool             `json:"globally_ignored,omitempty"` // true when hidden by global perspective or package ignore rule
	IgnoreRuleID      string           `json:"ignore_rule_id,omitempty"`   // "layer:os" | "layer:runtime" | "pkg|name|eco"
	IgnoreReason      string           `json:"ignore_reason,omitempty"`
}

// secPackageGroup aggregates multiple CVEs affecting the same package + installed version into one actionable upgrade target.
type secPackageGroup struct {
	GroupKey         string             `json:"group_key"` // ecoKey|pkg|installed_version|platform
	Package          string             `json:"package"`
	Ecosystem        string             `json:"ecosystem"`
	EcoKey           string             `json:"eco_key"`
	Platform         string             `json:"platform,omitempty"`
	PlatformTitle    string             `json:"platform_title,omitempty"`
	AssetType        string             `json:"asset_type"`
	PkgRole          string             `json:"pkg_role"`
	InstalledVersion string             `json:"installed_version"`
	RecommendedFix   string             `json:"recommended_fix,omitempty"`
	RepoFixVersion   string             `json:"repo_fix_version,omitempty"`
	FixableCount     int                `json:"fixable_count"`
	ActiveCount      int                `json:"active_count"`
	TotalCount       int                `json:"total_count"`
	WaivedCount      int                `json:"waived_count"`
	IgnoredCount     int                `json:"ignored_count,omitempty"`
	GloballyIgnored  bool               `json:"globally_ignored,omitempty"`
	IgnoreRuleID     string             `json:"ignore_rule_id,omitempty"`
	IgnoreReason     string             `json:"ignore_reason,omitempty"`
	MaxSeverity      string             `json:"max_severity"`
	MaxCVSS          float64            `json:"max_cvss,omitempty"`
	ActiveCounts     secSeverityCounts  `json:"active_counts"`
	Components       []secCompImpact    `json:"components,omitempty"`
	Clusters         []secClusterImpact `json:"clusters,omitempty"`
	FindingKeys      []string           `json:"finding_keys"`
	CVEs             []string           `json:"cves"`
}

type secSeverityCounts struct {
	Critical int `json:"critical"`
	High     int `json:"high"`
	Medium   int `json:"medium"`
	Low      int `json:"low"`
	Unknown  int `json:"unknown"`
	Total    int `json:"total"`
}

type secCompRiskBadge struct {
	Component          string `json:"component"`
	Version            string `json:"version"`
	Platform           string `json:"platform"`
	Critical           int    `json:"critical"`
	High               int    `json:"high"`
	Medium             int    `json:"medium"`
	Low                int    `json:"low"`
	Total              int    `json:"total"`
	MiddlewareCritical int    `json:"middleware_critical"`
	MiddlewareHigh     int    `json:"middleware_high"`
	MiddlewareTotal    int    `json:"middleware_total"`
	OSCritical         int    `json:"os_critical"`
	OSHigh             int    `json:"os_high"`
	OSTotal            int    `json:"os_total"`
}

type secClusterSummary struct {
	ClusterID         string            `json:"cluster_id"`
	AppID             string            `json:"app_id,omitempty"`
	AppName           string            `json:"app_name"`
	Version           string            `json:"version,omitempty"`
	Platform          string            `json:"platform"`
	Owner             string            `json:"owner"`
	DeliveryMode      string            `json:"delivery_mode,omitempty"`
	Hosts             []string          `json:"hosts"`
	Active            secSeverityCounts `json:"active"`
	Total             secSeverityCounts `json:"total"`
	MiddlewareActive  secSeverityCounts `json:"middleware_active"`
	OSActive          secSeverityCounts `json:"os_active"`
	TopCVEs           []string          `json:"top_cves,omitempty"`
	MiddlewareTopCVEs []string          `json:"middleware_top_cves,omitempty"`
	OSTopCVEs         []string          `json:"os_top_cves,omitempty"`
}

type secRuntimeSummary struct {
	ID         string            `json:"id"`
	Ansible    string            `json:"ansible"`
	Python     string            `json:"python"`
	Defaults   []string          `json:"defaults,omitempty"`
	WheelCount int               `json:"wheel_count"`
	Active     secSeverityCounts `json:"active"`
}

type secScanReport struct {
	ScannedAt                  string                      `json:"scanned_at"`
	ScannedBy                  string                      `json:"scanned_by,omitempty"`
	DurationMS                 int64                       `json:"duration_ms"`
	DBUpdatedAt                string                      `json:"db_updated_at,omitempty"`
	DBAdvisoryCount            int                         `json:"db_advisory_count"`
	SBOMPackageCount           int                         `json:"sbom_package_count"`
	ClosureCount               int                         `json:"closure_count"`
	RuntimeCount               int                         `json:"runtime_count"`
	ClusterCount               int                         `json:"cluster_count"`
	AffectedClusters           int                         `json:"affected_clusters"`
	MiddlewareAffectedClusters int                         `json:"middleware_affected_clusters"`
	OSAffectedClusters         int                         `json:"os_affected_clusters"`
	ActiveCounts               secSeverityCounts           `json:"active_counts"`
	TotalCounts                secSeverityCounts           `json:"total_counts"`
	MiddlewareCounts           secSeverityCounts           `json:"middleware_counts"`
	OSCounts                   secSeverityCounts           `json:"os_counts"`
	RuntimeCounts              secSeverityCounts           `json:"runtime_counts"`
	RawOSCounts                secSeverityCounts           `json:"raw_os_counts,omitempty"`
	RawRuntimeCounts           secSeverityCounts           `json:"raw_runtime_counts,omitempty"`
	WaivedCount                int                         `json:"waived_count"`
	SuppressedCount            int                         `json:"suppressed_count,omitempty"`
	SuppressedOSCount          int                         `json:"suppressed_os_count,omitempty"`
	SuppressedRuntimeCount     int                         `json:"suppressed_runtime_count,omitempty"`
	SuppressedPkgCount         int                         `json:"suppressed_pkg_count,omitempty"`
	Diff                       *secScanDiff                `json:"diff,omitempty"`
	Findings                   []secFinding                `json:"findings"`
	PackageGroups              []secPackageGroup           `json:"package_groups"`
	Clusters                   []secClusterSummary         `json:"clusters"`
	Runtimes                   []secRuntimeSummary         `json:"runtimes"`
	ComponentRisks             map[string]secCompRiskBadge `json:"component_risks"` // key: comp@ver@platform
}

// isOSBaseUtilityPkg returns true for OS-level base libraries & system utilities (such as openssl, python3, systemd,
// logrotate, perl, ca-certificates, glibc, libxml2) that should always be classified as OS base packages ("dependency")
// rather than middleware primary packages ("primary"), even if a component manifest lists a helper tool like logrotate.
func isOSBaseUtilityPkg(pkgName string) bool {
	lp := strings.ToLower(strings.TrimSpace(pkgName))
	if lp == "" {
		return false
	}
	exact := map[string]bool{
		"logrotate": true, "cron": true, "cronie": true, "anacron": true,
		"systemd": true, "openssl": true, "openssl-libs": true, "ca-certificates": true,
		"python": true, "python3": true, "perl": true, "bash": true, "sudo": true,
		"curl": true, "wget": true, "tar": true, "gzip": true, "bzip2": true, "xz": true,
		"zlib": true, "glibc": true, "libc6": true, "libxml2": true, "libxslt": true,
		"socat": true, "jq": true, "lsof": true, "procps": true, "net-tools": true,
		"iproute2": true, "iputils": true, "rsyslog": true, "tzdata": true, "sqlite3": true,
		"readline": true, "ncurses": true, "expat": true, "gdbm": true, "libffi": true,
		"util-linux": true, "coreutils": true, "findutils": true, "sed": true, "gawk": true,
		"grep": true, "diffutils": true, "shadow": true, "pam": true, "gnupg": true,
		"gpgv": true, "apt": true, "dpkg": true, "rpm": true, "dnf": true, "yum": true,
		"openssh": true, "krb5": true, "selinux": true, "audit": true, "less": true,
		"vim": true, "nc": true, "netcat": true, "bind-utils": true, "dnsutils": true,
	}
	if exact[lp] {
		return true
	}
	prefixes := []string{
		"python3.", "python3-", "libpython",
		"perl-", "libperl",
		"openssl-", "libssl", "libcrypto",
		"systemd-", "libsystemd",
		"glibc-", "libc6-", "libc-",
		"libxml2-", "libcurl", "libkrb5", "krb5-",
		"openssh-", "libpam", "libselinux", "libgcrypt", "libgnutls", "gnutls",
		"libsqlite", "sqlite-", "libncurses", "ncurses-", "libreadline",
		"libz", "zlib-", "libexpat", "libffi", "libcap", "libseccomp", "libacl",
		"libattr", "libblkid", "libmount", "libuuid", "libpcre", "pcre",
		"linux-", "kernel-", "kmod-", "udev", "libudev", "dbus", "libdbus",
	}
	for _, pre := range prefixes {
		if strings.HasPrefix(lp, pre) {
			return true
		}
	}
	return false
}

// buildMiddlewarePrimarySet collects canonical middleware component names and directly declared middleware package names
// (explicitly excluding OS base utilities like logrotate) so middleware companion packages such as nginx-core,
// nginx-filesystem, percona-postgresql-*, redis-tools, etc. are reliably distinguished from OS base libraries.
func buildMiddlewarePrimarySet(cat *mwpack.Catalog) map[string]bool {
	set := map[string]bool{}
	if cat == nil {
		return set
	}
	for _, cname := range cat.Names() {
		lc := strings.ToLower(strings.TrimSpace(cname))
		if lc != "" && !isOSBaseUtilityPkg(lc) {
			set[lc] = true
		}
		comp, ok := cat.Get(cname)
		if !ok {
			continue
		}
		for _, v := range comp.Versions {
			res, err := comp.Resolve(v.ID)
			if err != nil {
				continue
			}
			for _, pk := range res.Packages {
				lp := strings.ToLower(strings.TrimSpace(pk.Name))
				if lp != "" && !isOSBaseUtilityPkg(lp) {
					set[lp] = true
				}
			}
		}
	}
	return set
}

// classifySecPkgRole deterministically classifies any scanned package into:
//   - "runtime":    Ansible/Python controller wheels (asset_type == python_runtime)
//   - "primary":    Middleware itself & its direct companion packages (nginx, nginx-core, keepalived, haproxy, postgresql, patroni, redis, etcd...)
//   - "dependency": OS base packages & system libraries pulled in via OS closures (python3.12, openssl, systemd, libxml2, perl, ca-certificates, logrotate...)
func classifySecPkgRole(assetType, pkgName string, closureReqNames []string, mwPrimary map[string]bool) string {
	if assetType == "python_runtime" {
		return "runtime"
	}
	lp := strings.ToLower(strings.TrimSpace(pkgName))
	if lp == "" || isOSBaseUtilityPkg(lp) {
		return "dependency"
	}
	if assetType == "component_declared" {
		return "primary"
	}
	if mwPrimary[lp] {
		return "primary"
	}
	// Check companion sub-packages of known middleware packages (e.g. nginx -> nginx-core / nginx-filesystem / libnginx-*,
	// postgresql -> percona-postgresql-17 / postgresql-common, redis -> redis-tools, etcd -> etcd-client).
	for mw := range mwPrimary {
		if len(mw) < 3 {
			continue
		}
		if strings.HasPrefix(lp, mw+"-") || strings.HasPrefix(lp, "lib"+mw+"-") || strings.HasPrefix(lp, "percona-"+mw) {
			return "primary"
		}
	}
	for _, req := range closureReqNames {
		lr := strings.ToLower(strings.TrimSpace(req))
		if idx := strings.IndexByte(lr, '='); idx > 0 {
			lr = lr[:idx]
		}
		if lr == "" || isOSBaseUtilityPkg(lr) {
			continue
		}
		if lp == lr || strings.HasPrefix(lp, lr+"-") || (len(lp) >= 3 && strings.HasPrefix(lr, lp+"-")) {
			return "primary"
		}
	}
	return "dependency"
}

func makePURL(ecoKey, pkg, ver string) string {
	switch {
	case ecoKey == "pypi":
		return fmt.Sprintf("pkg:pypi/%s@%s", pkglib.NormPy(pkg), ver)
	case strings.HasPrefix(ecoKey, "ubuntu:"):
		return fmt.Sprintf("pkg:deb/ubuntu/%s@%s?distro=%s", pkg, ver, strings.ReplaceAll(ecoKey, ":", "-"))
	case strings.HasPrefix(ecoKey, "debian:"):
		return fmt.Sprintf("pkg:deb/debian/%s@%s?distro=%s", pkg, ver, strings.ReplaceAll(ecoKey, ":", "-"))
	case strings.HasPrefix(ecoKey, "el:"):
		return fmt.Sprintf("pkg:rpm/rocky/%s@%s?distro=%s", pkg, ver, strings.ReplaceAll(ecoKey, ":", "-"))
	default:
		return fmt.Sprintf("pkg:generic/%s@%s", pkg, ver)
	}
}

// extractSBOM collects every OS package closure, Python runtime wheel, declared component package, and live delivered cluster.
func (s *storeServer) extractSBOM() secSBOMInventory {
	inv := secSBOMInventory{}
	itemIdx := map[string]int{}
	addItem := func(it secSBOMItem) *secSBOMItem {
		k := it.EcoKey + "|" + normPkgForEco(it.EcoKey, it.Package) + "|" + it.Version + "|" + it.Platform
		if idx, ok := itemIdx[k]; ok {
			dst := &inv.Items[idx]
			for _, c := range it.Closures {
				if !contains(dst.Closures, c) {
					dst.Closures = append(dst.Closures, c)
				}
			}
			for _, r := range it.Runtimes {
				if !contains(dst.Runtimes, r) {
					dst.Runtimes = append(dst.Runtimes, r)
				}
			}
			for _, cp := range it.Components {
				if !contains(dst.Components, cp) {
					dst.Components = append(dst.Components, cp)
				}
			}
			if dst.SHA256 == "" && it.SHA256 != "" {
				dst.SHA256 = it.SHA256
			}
			// Promote dependency -> primary if any component directly requires this package.
			if it.PkgRole == "primary" && dst.PkgRole != "primary" {
				dst.PkgRole = "primary"
			}
			return dst
		}
		if it.PURL == "" {
			it.PURL = makePURL(it.EcoKey, it.Package, it.Version)
		}
		itemIdx[k] = len(inv.Items)
		inv.Items = append(inv.Items, it)
		return &inv.Items[len(inv.Items)-1]
	}

	// Build closure lookup per platform: platform|reqKey -> Closure
	closureByPlReq := map[string]pkglib.Closure{}
	// Map component version -> required closure keys + track primary middleware package names.
	cat := s.plat.cat()
	compTitle := map[string]string{}
	compReqMap := map[string][]string{} // platform|reqKey -> []"comp@ver@platform"
	primaryPkgNames := buildMiddlewarePrimarySet(cat)
	for _, cname := range cat.Names() {
		comp, ok := cat.Get(cname)
		if !ok {
			continue
		}
		compTitle[cname] = comp.Title
		for _, v := range comp.Versions {
			res, err := comp.Resolve(v.ID)
			if err != nil {
				continue
			}
			for _, pl := range res.Platforms {
				cvKey := cname + "@" + v.ID + "@" + pl
				for _, pk := range res.Packages {
					if len(pk.Platforms) > 0 && !contains(pk.Platforms, pl) {
						continue
					}
					rk := pl + "|" + (mwpack.PackageRequest{Name: pk.Name, Version: pk.Version}).Key()
					if !contains(compReqMap[rk], cvKey) {
						compReqMap[rk] = append(compReqMap[rk], cvKey)
					}
				}
			}
		}
	}

	// 1. OS package closures in pkglib
	if s.plat != nil && s.plat.lib != nil {
		for _, def := range mwpack.Platforms {
			ecos := platformToOSVEcosystems(def.ID)
			ecoDisp := def.Title
			if len(ecos) > 0 {
				ecoDisp = ecos[0]
			}
			ecoKey := normalizeEcoKey(ecoDisp)
			closures := s.plat.lib.List(def.ID)
			inv.TotalClosures += len(closures)
			for _, cl := range closures {
				rk := def.ID + "|" + cl.Request.Key()
				closureByPlReq[rk] = cl
				clLabel := cl.Request.Key()
				comps := compReqMap[rk]
				fileSHA := map[string]string{}
				for _, f := range cl.Files {
					fileSHA[f.File] = f.SHA256
				}
				for _, p := range cl.Packages {
					if p.Name == "" || p.Version == "" {
						continue
					}
					role := classifySecPkgRole("os_package", p.Name, []string{cl.Request.Name}, primaryPkgNames)
					addItem(secSBOMItem{
						AssetType:     "os_package",
						PkgRole:       role,
						Platform:      def.ID,
						PlatformTitle: def.Title,
						Ecosystem:     ecoDisp,
						OSVEcosystems: ecos,
						EcoKey:        ecoKey,
						Package:       p.Name,
						Version:       p.Version,
						Closures:      []string{clLabel},
						Components:    append([]string(nil), comps...),
					})
				}
			}
		}
	}

	// 2. Declared component packages not yet present in pkglib closures (still valuable to track!)
	for _, cname := range cat.Names() {
		comp, ok := cat.Get(cname)
		if !ok {
			continue
		}
		for _, v := range comp.Versions {
			res, err := comp.Resolve(v.ID)
			if err != nil {
				continue
			}
			for _, pl := range res.Platforms {
				def, hasDef := mwpack.PlatformByID(pl)
				plTitle := pl
				if hasDef {
					plTitle = def.Title
				}
				ecos := platformToOSVEcosystems(pl)
				ecoDisp := plTitle
				if len(ecos) > 0 {
					ecoDisp = ecos[0]
				}
				ecoKey := normalizeEcoKey(ecoDisp)
				cvKey := cname + "@" + v.ID + "@" + pl
				for _, pk := range res.Packages {
					if len(pk.Platforms) > 0 && !contains(pk.Platforms, pl) {
						continue
					}
					if pk.Name == "" || pk.Version == "" || strings.Contains(pk.Version, "*") {
						continue
					}
					rk := pl + "|" + (mwpack.PackageRequest{Name: pk.Name, Version: pk.Version}).Key()
					if _, inLib := closureByPlReq[rk]; inLib {
						continue
					}
					addItem(secSBOMItem{
						AssetType:     "component_declared",
						PkgRole:       classifySecPkgRole("component_declared", pk.Name, nil, primaryPkgNames),
						Platform:      pl,
						PlatformTitle: plTitle,
						Ecosystem:     ecoDisp,
						OSVEcosystems: ecos,
						EcoKey:        ecoKey,
						Package:       pk.Name,
						Version:       pk.Version,
						Components:    []string{cvKey},
					})
				}
			}
		}
	}

	// 3. Python / Ansible Runtimes in PyStore
	if s.plat != nil && s.plat.py != nil {
		wheels, runtimes, defaults := s.plat.py.State()
		inv.TotalRuntimes = len(runtimes)
		defaultRT := map[string][]string{}
		for pl, rtID := range defaults {
			defaultRT[rtID] = append(defaultRT[rtID], pl)
		}
		seenWheelInRT := map[string]bool{}
		for _, rt := range runtimes {
			rtLabel := rt.ID
			if len(rtLabel) > 10 {
				rtLabel = rtLabel[:10]
			}
			if len(defaultRT[rt.ID]) > 0 {
				rtLabel += " (默认)"
			}
			for _, wh := range rt.Wheels {
				if wh.Name == "" || wh.Version == "" {
					continue
				}
				seenWheelInRT[pkglib.NormPy(wh.Name)+"|"+wh.Version] = true
				addItem(secSBOMItem{
					AssetType:     "python_runtime",
					PkgRole:       "runtime",
					Platform:      "python",
					PlatformTitle: "Ansible / Python 运行环境",
					Ecosystem:     "PyPI",
					OSVEcosystems: []string{"PyPI"},
					EcoKey:        "pypi",
					Package:       wh.Name,
					Version:       wh.Version,
					SHA256:        wh.SHA256,
					Runtimes:      []string{rtLabel},
				})
			}
		}
		// Include standalone wheels in pool that aren't in a built runtime yet.
		for _, wh := range wheels {
			if wh.Name == "" || wh.Version == "" {
				continue
			}
			if seenWheelInRT[pkglib.NormPy(wh.Name)+"|"+wh.Version] {
				continue
			}
			addItem(secSBOMItem{
				AssetType:     "python_runtime",
				PkgRole:       "runtime",
				Platform:      "python",
				PlatformTitle: "Ansible / Python 软件库池",
				Ecosystem:     "PyPI",
				OSVEcosystems: []string{"PyPI"},
				EcoKey:        "pypi",
				Package:       wh.Name,
				Version:       wh.Version,
				SHA256:        wh.SHA256,
				Runtimes:      []string{"pool"},
			})
		}
	}

	// 4. Delivered production clusters (excluding temporary verification deliveries)
	s.mu.Lock()
	byCluster := map[string][]storeJob{}
	for _, j := range s.jobs {
		if isTempVerificationJob(j) || j.State != "succeeded" {
			continue
		}
		byCluster[j.ClusterID] = append(byCluster[j.ClusterID], j)
	}
	s.mu.Unlock()

	autoJobs := s.autoExecutedJobs()
	for cid, jobs := range byCluster {
		sortJobs(jobs)
		cur, ok := clusterCurrent(jobs)
		if !ok {
			cur = jobs[len(jobs)-1]
		}
		dep := s.readSpec(cur.ID)
		var planObj struct {
			Platforms []string `json:"platforms"`
			Instances []struct {
				Component string `json:"component"`
				Version   string `json:"version"`
				External  bool   `json:"external"`
			} `json:"instances"`
		}
		if rawPlan := s.jobPlan(cur.ID); len(rawPlan) > 0 {
			_ = json.Unmarshal(rawPlan, &planObj)
		}
		pl := mwpack.DefaultPlatform
		if dep != nil && dep.Platform != "" {
			pl = dep.Platform
		} else if len(planObj.Platforms) > 0 {
			pl = planObj.Platforms[0]
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
		var cvKeys []string
		if len(planObj.Instances) > 0 {
			for _, inst := range planObj.Instances {
				if inst.Component == "" || inst.External {
					continue
				}
				ver := inst.Version
				if ver == "" {
					if c, ok := cat.Get(inst.Component); ok && len(c.Versions) > 0 {
						ver = c.Versions[0].ID
					}
				}
				if ver != "" {
					k := inst.Component + "@" + ver + "@" + pl
					if !contains(cvKeys, k) {
						cvKeys = append(cvKeys, k)
					}
				}
			}
		} else if dep != nil {
			for _, inst := range dep.Instances {
				if inst.Component == "" {
					continue
				}
				ver := inst.Version
				if ver == "" {
					if c, ok := cat.Get(inst.Component); ok && len(c.Versions) > 0 {
						ver = c.Versions[0].ID
					}
				}
				if ver != "" {
					k := inst.Component + "@" + ver + "@" + pl
					if !contains(cvKeys, k) {
						cvKeys = append(cvKeys, k)
					}
				}
			}
		}
		if len(cvKeys) == 0 && cur.AppID != "" && cur.Version != "" {
			cvKeys = append(cvKeys, cur.AppID+"@"+cur.Version+"@"+pl)
		}
		rawMode := cur.DeliveryMode
		if dep != nil && dep.DeliveryMode != "" {
			rawMode = dep.DeliveryMode
		}
		inv.Clusters = append(inv.Clusters, secClusterSpec{
			ClusterID:    cid,
			AppID:        cur.AppID,
			AppName:      firstNonEmptyStr(cur.AppName, compTitle[cur.AppID], cur.AppID),
			Version:      cur.Version,
			Platform:     pl,
			Owner:        cur.Owner,
			DeliveryMode: effectiveDeliveryMode(cur.ID, rawMode, autoJobs),
			Hosts:        hosts,
			CompVerKeys:  cvKeys,
		})
	}
	sort.Slice(inv.Clusters, func(i, j int) bool { return inv.Clusters[i].ClusterID < inv.Clusters[j].ClusterID })
	return inv
}

// ---- Native Version Comparison & Advisory Range Matching ----

func compareVersionForEco(ecoKey, a, b string) int {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	if a == b {
		return 0
	}
	switch {
	case strings.HasPrefix(ecoKey, "ubuntu") || strings.HasPrefix(ecoKey, "debian"):
		return pkglib.CompareDeb(a, b)
	case strings.HasPrefix(ecoKey, "el"):
		return pkglib.CompareRPM(a, b)
	case ecoKey == "pypi":
		return comparePEP440(a, b)
	default:
		return pkglib.CompareDeb(a, b)
	}
}

// comparePEP440 compares Python PEP 440 version strings (e.g. "2.20.1", "44.0.0rc1", "25.3").
func comparePEP440(a, b string) int {
	type pep struct {
		epoch int
		nums  []int
		pre   int // -3=dev, -2=a, -1=b, 0=rc, 1=final, 2=post
		preN  int
	}
	parse := func(raw string) pep {
		raw = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(raw, "v")))
		p := pep{pre: 1}
		if i := strings.IndexByte(raw, '!'); i >= 0 {
			p.epoch, _ = strconv.Atoi(raw[:i])
			raw = raw[i+1:]
		}
		if i := strings.IndexByte(raw, '+'); i >= 0 {
			raw = raw[:i]
		}
		// Split release numbers from pre/post/dev suffix
		idx := 0
		for idx < len(raw) && ((raw[idx] >= '0' && raw[idx] <= '9') || raw[idx] == '.') {
			idx++
		}
		rel := strings.TrimRight(raw[:idx], ".")
		tail := raw[idx:]
		for _, seg := range strings.Split(rel, ".") {
			if seg == "" {
				continue
			}
			n, _ := strconv.Atoi(seg)
			p.nums = append(p.nums, n)
		}
		tail = strings.TrimLeft(tail, "._-")
		if tail != "" {
			switch {
			case strings.HasPrefix(tail, "dev"):
				p.pre = -3
				p.preN = parseLeadingInt(strings.TrimPrefix(tail, "dev"))
			case strings.HasPrefix(tail, "alpha"):
				p.pre = -2
				p.preN = parseLeadingInt(strings.TrimPrefix(tail, "alpha"))
			case strings.HasPrefix(tail, "a"):
				p.pre = -2
				p.preN = parseLeadingInt(strings.TrimPrefix(tail, "a"))
			case strings.HasPrefix(tail, "beta"):
				p.pre = -1
				p.preN = parseLeadingInt(strings.TrimPrefix(tail, "beta"))
			case strings.HasPrefix(tail, "b"):
				p.pre = -1
				p.preN = parseLeadingInt(strings.TrimPrefix(tail, "b"))
			case strings.HasPrefix(tail, "rc"):
				p.pre = 0
				p.preN = parseLeadingInt(strings.TrimPrefix(tail, "rc"))
			case strings.HasPrefix(tail, "post"):
				p.pre = 2
				p.preN = parseLeadingInt(strings.TrimPrefix(tail, "post"))
			}
		}
		return p
	}
	pa, pb := parse(a), parse(b)
	if pa.epoch != pb.epoch {
		if pa.epoch < pb.epoch {
			return -1
		}
		return 1
	}
	maxL := len(pa.nums)
	if len(pb.nums) > maxL {
		maxL = len(pb.nums)
	}
	for i := 0; i < maxL; i++ {
		na, nb := 0, 0
		if i < len(pa.nums) {
			na = pa.nums[i]
		}
		if i < len(pb.nums) {
			nb = pb.nums[i]
		}
		if na != nb {
			if na < nb {
				return -1
			}
			return 1
		}
	}
	if pa.pre != pb.pre {
		if pa.pre < pb.pre {
			return -1
		}
		return 1
	}
	if pa.preN != pb.preN {
		if pa.preN < pb.preN {
			return -1
		}
		return 1
	}
	return 0
}

func parseLeadingInt(s string) int {
	s = strings.TrimLeft(s, "._-")
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 {
		return 0
	}
	n, _ := strconv.Atoi(s[:i])
	return n
}

// versionAffectedByAdvisory evaluates whether installed version v falls inside the advisory's affected versions or ranges.
func versionAffectedByAdvisory(ecoKey, v string, adv secDBAdvisory) bool {
	if v == "" {
		return false
	}
	for _, ev := range adv.Versions {
		if ev == v || compareVersionForEco(ecoKey, v, ev) == 0 {
			return true
		}
	}
	for _, rg := range adv.Ranges {
		if rg.Introduced != "" && rg.Introduced != "0" {
			if compareVersionForEco(ecoKey, v, rg.Introduced) < 0 {
				continue
			}
		}
		if rg.Fixed != "" {
			if compareVersionForEco(ecoKey, v, rg.Fixed) < 0 {
				return true
			}
			continue
		}
		if rg.LastAffected != "" {
			if compareVersionForEco(ecoKey, v, rg.LastAffected) <= 0 {
				return true
			}
			continue
		}
		// Open-ended introduced range with no fix yet.
		if rg.Introduced != "" {
			return true
		}
	}
	return false
}

func addSeverityCount(c *secSeverityCounts, sev string) {
	c.Total++
	switch strings.ToUpper(sev) {
	case "CRITICAL":
		c.Critical++
	case "HIGH":
		c.High++
	case "MEDIUM":
		c.Medium++
	case "LOW":
		c.Low++
	default:
		c.Unknown++
	}
}

func applyTriageToFinding(f *secFinding, triageMap map[string]secTriageRecord, today string) {
	// Prefer narrow scope (cve|pkg|ecoKey) before global scope (cve).
	narrowKey := strings.ToUpper(f.CVE) + "|" + strings.ToLower(f.Package) + "|" + f.EcoKey
	globalKey := strings.ToUpper(f.CVE)
	rec, ok := triageMap[narrowKey]
	if !ok {
		rec, ok = triageMap[globalKey]
	}
	if !ok && f.ID != f.CVE {
		rec, ok = triageMap[strings.ToUpper(f.ID)+"|"+strings.ToLower(f.Package)+"|"+f.EcoKey]
		if !ok {
			rec, ok = triageMap[strings.ToUpper(f.ID)]
		}
	}
	if !ok {
		f.TriageStatus = "open"
		f.Waived = false
		return
	}
	f.TriageStatus = rec.Status
	f.TriageNote = rec.Note
	f.TriageJust = rec.Justification
	f.TriageExpires = rec.ExpiresAt
	f.TriageBy = rec.UpdatedBy
	f.TriageAt = rec.UpdatedAt
	f.TriageHistory = rec.History
	f.LinkedClusterID = rec.LinkedClusterID
	f.LinkedRehearsalID = rec.LinkedRehearsalID
	f.LinkedSOPDocID = rec.LinkedSOPDocID

	switch rec.Status {
	case "mitigated", "not_affected":
		f.Waived = true
	case "accepted":
		if rec.ExpiresAt != "" && rec.ExpiresAt < today {
			f.TriageStatus = "expired"
			f.Waived = false
		} else {
			f.Waived = true
		}
	default:
		f.Waived = false
	}
}

// runSecurityScan runs a full deterministic offline vulnerability scan across the entire platform and persists latest.json.
func (s *storeServer) runSecurityScan(by string, sendAlerts bool) *secScanReport {
	t0 := time.Now()
	inv := s.extractSBOM()

	secDBMu.Lock()
	advs := s.loadSecAdvisories()
	meta := s.loadSecMeta()
	triageMap := s.loadSecTriage()
	policy := s.loadSecPolicy()
	secDBMu.Unlock()

	// Index advisories by ecoKey|normPkg for O(1) deterministic matching.
	advByKey := map[string][]secDBAdvisory{}
	for _, a := range advs {
		ek := normalizeEcoKey(a.Ecosystem)
		pk := normPkgForEco(ek, a.Package)
		advByKey[ek+"|"+pk] = append(advByKey[ek+"|"+pk], a)
	}

	// Build compVerKey -> []secClusterSpec and compTitle map.
	clustersByCV := map[string][]secClusterSpec{}
	for _, cl := range inv.Clusters {
		for _, cvk := range cl.CompVerKeys {
			clustersByCV[cvk] = append(clustersByCV[cvk], cl)
		}
	}
	cat := s.plat.cat()
	compTitles := map[string]string{}
	for _, n := range cat.Names() {
		if c, ok := cat.Get(n); ok {
			compTitles[n] = c.Title
		}
	}

	// Optional repo index lookup cache: platform|pkg -> latest version in local pkglib index.
	repoLatestCache := map[string]string{}
	repoLatestFor := func(platform, pkgName string) string {
		if s.plat == nil || s.plat.idx == nil || platform == "" || platform == "python" {
			return ""
		}
		ck := platform + "|" + pkgName
		if v, ok := repoLatestCache[ck]; ok {
			return v
		}
		def, ok := mwpack.PlatformByID(platform)
		if !ok {
			repoLatestCache[ck] = ""
			return ""
		}
		vers, err := s.plat.idx.Versions(def, pkgName)
		if err != nil || len(vers) == 0 {
			repoLatestCache[ck] = ""
			return ""
		}
		repoLatestCache[ck] = vers[0].Version
		return vers[0].Version
	}

	// Match every SBOM item against local advisories and aggregate by (CVE, Package, EcoKey, InstalledVersion).
	findingIdx := map[string]int{}
	var findings []secFinding
	today := time.Now().UTC().Format("2006-01-02")

	for _, item := range inv.Items {
		lookupKey := item.EcoKey + "|" + normPkgForEco(item.EcoKey, item.Package)
		candidates := advByKey[lookupKey]
		if len(candidates) == 0 {
			continue
		}
		for _, adv := range candidates {
			if !versionAffectedByAdvisory(item.EcoKey, item.Version, adv) {
				continue
			}
			cve := primaryCVE(firstNonEmptyStr(adv.CVE, adv.ID), adv.Aliases)
			if cve == "" {
				cve = adv.ID
			}
			fk := strings.ToUpper(cve) + "|" + normPkgForEco(item.EcoKey, item.Package) + "|" + item.EcoKey + "|" + item.Version
			idx, exists := findingIdx[fk]
			if !exists {
				// Check if local OS repo index already offers a version >= min fixed version.
				repoFix := ""
				if len(adv.FixedIn) > 0 && item.Platform != "" && item.Platform != "python" {
					if latest := repoLatestFor(item.Platform, item.Package); latest != "" {
						for _, fx := range adv.FixedIn {
							if compareVersionForEco(item.EcoKey, latest, fx) >= 0 {
								repoFix = latest
								break
							}
						}
					}
				}
				role := item.PkgRole
				if role == "" {
					if item.AssetType == "python_runtime" {
						role = "runtime"
					} else if item.AssetType == "component_declared" {
						role = "primary"
					} else {
						role = "dependency"
					}
				}
				f := secFinding{
					Key:              strings.ToUpper(cve) + "|" + strings.ToLower(item.Package) + "|" + item.EcoKey,
					ID:               adv.ID,
					CVE:              cve,
					Aliases:          adv.Aliases,
					Severity:         normalizeSeverity(adv.Severity, adv.CVSSScore),
					CVSSScore:        adv.CVSSScore,
					CVSSVector:       adv.CVSSVector,
					Summary:          adv.Summary,
					Details:          adv.Details,
					URL:              adv.URL,
					Published:        adv.Published,
					Ecosystem:        item.Ecosystem,
					EcoKey:           item.EcoKey,
					Platform:         item.Platform,
					PlatformTitle:    item.PlatformTitle,
					AssetType:        item.AssetType,
					PkgRole:          role,
					Package:          item.Package,
					InstalledVersion: item.Version,
					FixedIn:          append([]string(nil), adv.FixedIn...),
					RepoFixVersion:   repoFix,
				}
				idx = len(findings)
				findingIdx[fk] = idx
				findings = append(findings, f)
			} else if item.PkgRole == "primary" {
				findings[idx].PkgRole = "primary"
			}
			dst := &findings[idx]
			for _, cl := range item.Closures {
				if !contains(dst.Closures, cl) {
					dst.Closures = append(dst.Closures, cl)
				}
			}
			for _, rt := range item.Runtimes {
				if !contains(dst.Runtimes, rt) {
					dst.Runtimes = append(dst.Runtimes, rt)
				}
			}
			for _, cvk := range item.Components {
				parts := strings.Split(cvk, "@")
				if len(parts) == 3 {
					already := false
					for _, ex := range dst.Components {
						if ex.Component == parts[0] && ex.Version == parts[1] && ex.Platform == parts[2] {
							already = true
							break
						}
					}
					if !already {
						dst.Components = append(dst.Components, secCompImpact{
							Component: parts[0],
							Title:     firstNonEmptyStr(compTitles[parts[0]], parts[0]),
							Version:   parts[1],
							Platform:  parts[2],
						})
					}
				}
				for _, cl := range clustersByCV[cvk] {
					already := false
					for _, ex := range dst.Clusters {
						if ex.ClusterID == cl.ClusterID {
							already = true
							break
						}
					}
					if !already {
						dst.Clusters = append(dst.Clusters, secClusterImpact{
							ClusterID:    cl.ClusterID,
							AppID:        cl.AppID,
							AppName:      cl.AppName,
							Version:      cl.Version,
							Platform:     cl.Platform,
							Owner:        cl.Owner,
							DeliveryMode: cl.DeliveryMode,
							Hosts:        append([]string(nil), cl.Hosts...),
						})
					}
				}
			}
		}
	}

	// Apply VEX triage & global perspective/ignore policy and aggregate KPIs, component badges, cluster summaries, runtime summaries.
	var activeCounts, totalCounts, middlewareCounts, osCounts, runtimeCounts, rawOSCounts, rawRuntimeCounts secSeverityCounts
	waivedCount := 0
	suppressedCount, suppressedOS, suppressedRuntime, suppressedPkg := 0, 0, 0, 0
	compRisks := map[string]secCompRiskBadge{}
	clusterMap := map[string]*secClusterSummary{}
	for _, cl := range inv.Clusters {
		clusterMap[cl.ClusterID] = &secClusterSummary{
			ClusterID:    cl.ClusterID,
			AppID:        cl.AppID,
			AppName:      cl.AppName,
			Version:      cl.Version,
			Platform:     cl.Platform,
			Owner:        cl.Owner,
			DeliveryMode: cl.DeliveryMode,
			Hosts:        append([]string(nil), cl.Hosts...),
		}
	}
	rtMap := map[string]*secRuntimeSummary{}
	if s.plat != nil && s.plat.py != nil {
		_, runtimes, defaults := s.plat.py.State()
		defByRT := map[string][]string{}
		for pl, id := range defaults {
			defByRT[id] = append(defByRT[id], pl)
		}
		for _, rt := range runtimes {
			lbl := rt.ID
			if len(lbl) > 10 {
				lbl = lbl[:10]
			}
			if len(defByRT[rt.ID]) > 0 {
				lbl += " (默认)"
			}
			rtMap[lbl] = &secRuntimeSummary{
				ID:         rt.ID,
				Ansible:    rt.Ansible,
				Python:     rt.Python,
				Defaults:   defByRT[rt.ID],
				WheelCount: len(rt.Wheels),
			}
		}
	}

	for i := range findings {
		f := &findings[i]
		applyTriageToFinding(f, triageMap, today)
		applyGlobalIgnoreToFinding(f, policy)
		addSeverityCount(&totalCounts, f.Severity)
		if !f.Waived {
			if f.PkgRole == "dependency" {
				addSeverityCount(&rawOSCounts, f.Severity)
			} else if f.PkgRole == "runtime" {
				addSeverityCount(&rawRuntimeCounts, f.Severity)
			}
		}
		effectiveActive := !f.Waived && !f.GloballyIgnored
		if f.GloballyIgnored {
			suppressedCount++
			switch f.IgnoreRuleID {
			case "layer:os":
				suppressedOS++
			case "layer:runtime":
				suppressedRuntime++
			default:
				suppressedPkg++
			}
		} else if f.Waived {
			waivedCount++
		} else {
			addSeverityCount(&activeCounts, f.Severity)
			switch f.PkgRole {
			case "primary":
				addSeverityCount(&middlewareCounts, f.Severity)
			case "runtime":
				addSeverityCount(&runtimeCounts, f.Severity)
			default:
				addSeverityCount(&osCounts, f.Severity)
			}
		}
		for _, c := range f.Components {
			cvk := c.Component + "@" + c.Version + "@" + c.Platform
			b := compRisks[cvk]
			b.Component, b.Version, b.Platform = c.Component, c.Version, c.Platform
			if effectiveActive {
				b.Total++
				if f.PkgRole == "primary" {
					b.MiddlewareTotal++
				} else if f.PkgRole != "runtime" {
					b.OSTotal++
				}
				switch f.Severity {
				case "CRITICAL":
					b.Critical++
					if f.PkgRole == "primary" {
						b.MiddlewareCritical++
					} else if f.PkgRole != "runtime" {
						b.OSCritical++
					}
				case "HIGH":
					b.High++
					if f.PkgRole == "primary" {
						b.MiddlewareHigh++
					} else if f.PkgRole != "runtime" {
						b.OSHigh++
					}
				case "MEDIUM":
					b.Medium++
				case "LOW":
					b.Low++
				}
			}
			compRisks[cvk] = b
		}
		for _, cl := range f.Clusters {
			cs := clusterMap[cl.ClusterID]
			if cs == nil {
				continue
			}
			addSeverityCount(&cs.Total, f.Severity)
			if effectiveActive {
				addSeverityCount(&cs.Active, f.Severity)
				if f.PkgRole == "primary" {
					addSeverityCount(&cs.MiddlewareActive, f.Severity)
					if (f.Severity == "CRITICAL" || f.Severity == "HIGH") && !contains(cs.MiddlewareTopCVEs, f.CVE) && len(cs.MiddlewareTopCVEs) < 5 {
						cs.MiddlewareTopCVEs = append(cs.MiddlewareTopCVEs, f.CVE)
					}
				} else if f.PkgRole != "runtime" {
					addSeverityCount(&cs.OSActive, f.Severity)
					if (f.Severity == "CRITICAL" || f.Severity == "HIGH") && !contains(cs.OSTopCVEs, f.CVE) && len(cs.OSTopCVEs) < 5 {
						cs.OSTopCVEs = append(cs.OSTopCVEs, f.CVE)
					}
				}
				if (f.Severity == "CRITICAL" || f.Severity == "HIGH") && !contains(cs.TopCVEs, f.CVE) && len(cs.TopCVEs) < 5 {
					cs.TopCVEs = append(cs.TopCVEs, f.CVE)
				}
			}
		}
		for _, rtLbl := range f.Runtimes {
			if rs := rtMap[rtLbl]; rs != nil && effectiveActive {
				addSeverityCount(&rs.Active, f.Severity)
			}
		}
	}

	// Sort findings: active first → cluster blast radius → severity rank → middleware primary first → CVSS score → CVE ID.
	sort.Slice(findings, func(i, j int) bool {
		ai := !findings[i].Waived && !findings[i].GloballyIgnored
		aj := !findings[j].Waived && !findings[j].GloballyIgnored
		if ai != aj {
			return ai
		}
		if findings[i].GloballyIgnored != findings[j].GloballyIgnored {
			return !findings[i].GloballyIgnored
		}
		ci, cj := len(findings[i].Clusters), len(findings[j].Clusters)
		if (ci > 0) != (cj > 0) {
			return ci > 0
		}
		if ri, rj := severityRank(findings[i].Severity), severityRank(findings[j].Severity); ri != rj {
			return ri > rj
		}
		if pi, pj := findings[i].PkgRole == "primary", findings[j].PkgRole == "primary"; pi != pj {
			return pi
		}
		if findings[i].CVSSScore != findings[j].CVSSScore {
			return findings[i].CVSSScore > findings[j].CVSSScore
		}
		if ci != cj {
			return ci > cj
		}
		return findings[i].CVE > findings[j].CVE
	})

	clusterSummaries := make([]secClusterSummary, 0, len(clusterMap))
	affectedClusters := 0
	mwAffectedClusters := 0
	osAffectedClusters := 0
	for _, cs := range clusterMap {
		if cs.Active.Total > 0 {
			affectedClusters++
		}
		if cs.MiddlewareActive.Total > 0 {
			mwAffectedClusters++
		}
		if cs.OSActive.Total > 0 {
			osAffectedClusters++
		}
		clusterSummaries = append(clusterSummaries, *cs)
	}
	sort.Slice(clusterSummaries, func(i, j int) bool {
		if clusterSummaries[i].MiddlewareActive.Critical != clusterSummaries[j].MiddlewareActive.Critical {
			return clusterSummaries[i].MiddlewareActive.Critical > clusterSummaries[j].MiddlewareActive.Critical
		}
		if clusterSummaries[i].MiddlewareActive.High != clusterSummaries[j].MiddlewareActive.High {
			return clusterSummaries[i].MiddlewareActive.High > clusterSummaries[j].MiddlewareActive.High
		}
		if clusterSummaries[i].Active.Critical != clusterSummaries[j].Active.Critical {
			return clusterSummaries[i].Active.Critical > clusterSummaries[j].Active.Critical
		}
		if clusterSummaries[i].Active.High != clusterSummaries[j].Active.High {
			return clusterSummaries[i].Active.High > clusterSummaries[j].Active.High
		}
		if clusterSummaries[i].Active.Total != clusterSummaries[j].Active.Total {
			return clusterSummaries[i].Active.Total > clusterSummaries[j].Active.Total
		}
		return clusterSummaries[i].ClusterID < clusterSummaries[j].ClusterID
	})

	runtimeSummaries := make([]secRuntimeSummary, 0, len(rtMap))
	for _, rs := range rtMap {
		runtimeSummaries = append(runtimeSummaries, *rs)
	}
	sort.Slice(runtimeSummaries, func(i, j int) bool {
		return runtimeSummaries[i].Active.Total > runtimeSummaries[j].Active.Total
	})

	if findings == nil {
		findings = []secFinding{}
	}
	pkgGroups := buildPackageGroups(findings)

	// Build active key set and compute diff vs previous scan snapshot.
	curKeys := make([]string, 0, activeCounts.Total)
	curKeySet := map[string]secFinding{}
	for _, f := range findings {
		if !f.Waived && !f.GloballyIgnored {
			ak := f.Key + "|" + f.InstalledVersion
			if _, ok := curKeySet[ak]; !ok {
				curKeys = append(curKeys, ak)
				curKeySet[ak] = f
			}
		}
	}
	sort.Strings(curKeys)

	var diff *secScanDiff
	secDBMu.Lock()
	hist := s.loadSecHistory()
	if len(hist) > 0 {
		prev := hist[0]
		prevSet := map[string]bool{}
		for _, k := range prev.ActiveKeys {
			prevSet[k] = true
		}
		d := &secScanDiff{PrevScannedAt: prev.ScannedAt}
		for _, k := range curKeys {
			if !prevSet[k] {
				d.AddedCount++
				if f := curKeySet[k]; (f.Severity == "CRITICAL" || f.Severity == "HIGH") && len(d.AddedCriticalHigh) < 12 {
					d.AddedCriticalHigh = append(d.AddedCriticalHigh, fmt.Sprintf("%s (%s)", f.CVE, f.Package))
				}
			}
		}
		for _, k := range prev.ActiveKeys {
			if _, ok := curKeySet[k]; !ok {
				d.ResolvedCount++
				if len(d.ResolvedSample) < 12 {
					parts := strings.Split(k, "|")
					if len(parts) >= 2 {
						d.ResolvedSample = append(d.ResolvedSample, fmt.Sprintf("%s (%s)", parts[0], parts[1]))
					}
				}
			}
		}
		diff = d
	}
	scannedAt := now()
	rep := &secScanReport{
		ScannedAt:                  scannedAt,
		ScannedBy:                  by,
		DurationMS:                 time.Since(t0).Milliseconds(),
		DBUpdatedAt:                meta.UpdatedAt,
		DBAdvisoryCount:            len(advs),
		SBOMPackageCount:           len(inv.Items),
		ClosureCount:               inv.TotalClosures,
		RuntimeCount:               inv.TotalRuntimes,
		ClusterCount:               len(inv.Clusters),
		AffectedClusters:           affectedClusters,
		MiddlewareAffectedClusters: mwAffectedClusters,
		OSAffectedClusters:         osAffectedClusters,
		ActiveCounts:               activeCounts,
		TotalCounts:                totalCounts,
		MiddlewareCounts:           middlewareCounts,
		OSCounts:                   osCounts,
		RuntimeCounts:              runtimeCounts,
		RawOSCounts:                rawOSCounts,
		RawRuntimeCounts:           rawRuntimeCounts,
		WaivedCount:                waivedCount,
		SuppressedCount:            suppressedCount,
		SuppressedOSCount:          suppressedOS,
		SuppressedRuntimeCount:     suppressedRuntime,
		SuppressedPkgCount:         suppressedPkg,
		Diff:                       diff,
		Findings:                   findings,
		PackageGroups:              pkgGroups,
		Clusters:                   clusterSummaries,
		Runtimes:                   runtimeSummaries,
		ComponentRisks:             compRisks,
	}
	_ = s.saveLatestScan(rep)
	addedN, resolvedN := 0, 0
	if diff != nil {
		addedN, resolvedN = diff.AddedCount, diff.ResolvedCount
	}
	entry := secScanHistoryEntry{
		ScannedAt:        scannedAt,
		ScannedBy:        by,
		DBAdvisoryCount:  len(advs),
		SBOMPackageCount: len(inv.Items),
		AffectedClusters: affectedClusters,
		ActiveCounts:     activeCounts,
		WaivedCount:      waivedCount,
		AddedCount:       addedN,
		ResolvedCount:    resolvedN,
		ActiveKeys:       curKeys,
	}
	_ = s.saveSecHistory(append([]secScanHistoryEntry{entry}, hist...))
	secDBMu.Unlock()

	// Optional alert notification when unwaived Critical/High CVEs impact production clusters.
	alertCounts := activeCounts
	alertAffected := affectedClusters
	if policy.GateMiddlewareOnly || policy.HideOSCVEs {
		alertCounts = middlewareCounts
		alertAffected = mwAffectedClusters
	}
	shouldAlert := sendAlerts && policy.NotifyOnScan && alertAffected > 0 && (alertCounts.Critical > 0 || alertCounts.High > 0)
	if shouldAlert && diff != nil && len(diff.AddedCriticalHigh) == 0 && diff.AddedCount == 0 {
		// Suppress duplicate alert storm when an identical scan has zero newly added vulnerabilities.
		shouldAlert = false
	}
	if shouldAlert {
		var chIDs []string
		for _, ch := range s.channels() {
			if ch.Enabled {
				chIDs = append(chIDs, ch.ID)
			}
		}
		if len(chIDs) > 0 {
			var lines []string
			if diff != nil && len(diff.AddedCriticalHigh) > 0 {
				lines = append(lines, "本次新增严重/高危漏洞："+strings.Join(diff.AddedCriticalHigh, "、"))
			}
			for _, cs := range clusterSummaries {
				cnt := cs.Active
				cves := cs.TopCVEs
				if policy.GateMiddlewareOnly {
					cnt = cs.MiddlewareActive
					cves = cs.MiddlewareTopCVEs
				}
				if cnt.Critical > 0 || cnt.High > 0 {
					lines = append(lines, fmt.Sprintf("- 集群 %s（%s %s）：严重 %d / 高危 %d（%s）",
						cs.ClusterID, cs.AppName, cs.Version, cnt.Critical, cnt.High, strings.Join(cves, ", ")))
					if len(lines) >= 9 {
						break
					}
				}
			}
			scopeHint := ""
			if policy.GateMiddlewareOnly {
				scopeHint = "（仅中间件本体口径）"
			}
			s.notify(chIDs, notifyMessage{
				Event: "security-scan",
				Title: fmt.Sprintf("安全中心告警%s：发现 %d 个严重 / %d 个高危 CVE 影响 %d 个生产集群", scopeHint, alertCounts.Critical, alertCounts.High, alertAffected),
				Lines: lines,
			})
		}
	}
	return rep
}

// buildPackageGroups aggregates CVEs affecting the same (ecosystem, package, installed_version, platform) into actionable upgrade groups.
func buildPackageGroups(findings []secFinding) []secPackageGroup {
	if len(findings) == 0 {
		return []secPackageGroup{}
	}
	idxMap := map[string]int{}
	groups := make([]secPackageGroup, 0)
	for _, f := range findings {
		gk := f.EcoKey + "|" + normPkgForEco(f.EcoKey, f.Package) + "|" + f.InstalledVersion + "|" + f.Platform
		idx, ok := idxMap[gk]
		if !ok {
			role := f.PkgRole
			if role == "" {
				if f.AssetType == "python_runtime" {
					role = "runtime"
				} else if f.AssetType == "component_declared" {
					role = "primary"
				} else {
					role = "dependency"
				}
			}
			groups = append(groups, secPackageGroup{
				GroupKey:         gk,
				Package:          f.Package,
				Ecosystem:        f.Ecosystem,
				EcoKey:           f.EcoKey,
				Platform:         f.Platform,
				PlatformTitle:    f.PlatformTitle,
				AssetType:        f.AssetType,
				PkgRole:          role,
				InstalledVersion: f.InstalledVersion,
				MaxSeverity:      "UNKNOWN",
			})
			idx = len(groups) - 1
			idxMap[gk] = idx
		}
		g := &groups[idx]
		if f.PkgRole == "primary" {
			g.PkgRole = "primary"
		}
		g.TotalCount++
		if !contains(g.FindingKeys, f.Key) {
			g.FindingKeys = append(g.FindingKeys, f.Key)
		}
		if !contains(g.CVEs, f.CVE) {
			g.CVEs = append(g.CVEs, f.CVE)
		}
		if f.GloballyIgnored {
			g.IgnoredCount++
			if g.IgnoreRuleID == "" {
				g.IgnoreRuleID = f.IgnoreRuleID
			}
			if g.IgnoreReason == "" {
				g.IgnoreReason = f.IgnoreReason
			}
			if f.Waived {
				g.WaivedCount++
			}
		} else if f.Waived {
			g.WaivedCount++
		} else {
			g.ActiveCount++
			addSeverityCount(&g.ActiveCounts, f.Severity)
			if severityRank(f.Severity) > severityRank(g.MaxSeverity) {
				g.MaxSeverity = f.Severity
			}
			if f.CVSSScore > g.MaxCVSS {
				g.MaxCVSS = f.CVSSScore
			}
			if len(f.FixedIn) > 0 {
				g.FixableCount++
				// Pick the minimum fix for this CVE, then take the max across CVEs in the group so 1 upgrade fixes all.
				minFix := f.FixedIn[0]
				for _, fx := range f.FixedIn[1:] {
					if compareVersionForEco(f.EcoKey, fx, minFix) < 0 {
						minFix = fx
					}
				}
				if g.RecommendedFix == "" || compareVersionForEco(f.EcoKey, minFix, g.RecommendedFix) > 0 {
					g.RecommendedFix = minFix
				}
			}
			if f.RepoFixVersion != "" {
				if g.RepoFixVersion == "" || compareVersionForEco(f.EcoKey, f.RepoFixVersion, g.RepoFixVersion) > 0 {
					g.RepoFixVersion = f.RepoFixVersion
				}
			}
		}
		for _, c := range f.Components {
			exists := false
			for _, ex := range g.Components {
				if ex.Component == c.Component && ex.Version == c.Version && ex.Platform == c.Platform {
					exists = true
					break
				}
			}
			if !exists {
				g.Components = append(g.Components, c)
			}
		}
		for _, cl := range f.Clusters {
			exists := false
			for _, ex := range g.Clusters {
				if ex.ClusterID == cl.ClusterID {
					exists = true
					break
				}
			}
			if !exists {
				g.Clusters = append(g.Clusters, cl)
			}
		}
	}
	// Mark fully-ignored groups and pick max severity across all findings when active count is 0.
	for i := range groups {
		if groups[i].TotalCount > 0 && groups[i].IgnoredCount > 0 && groups[i].ActiveCount == 0 && (groups[i].IgnoredCount+groups[i].WaivedCount) >= groups[i].TotalCount {
			groups[i].GloballyIgnored = true
		}
		if groups[i].MaxSeverity == "UNKNOWN" && groups[i].TotalCount > 0 {
			for _, f := range findings {
				gk := f.EcoKey + "|" + normPkgForEco(f.EcoKey, f.Package) + "|" + f.InstalledVersion + "|" + f.Platform
				if gk == groups[i].GroupKey {
					if severityRank(f.Severity) > severityRank(groups[i].MaxSeverity) {
						groups[i].MaxSeverity = f.Severity
					}
					if f.CVSSScore > groups[i].MaxCVSS {
						groups[i].MaxCVSS = f.CVSSScore
					}
				}
			}
		}
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].GloballyIgnored != groups[j].GloballyIgnored {
			return !groups[i].GloballyIgnored
		}
		ai, aj := groups[i].ActiveCount > 0, groups[j].ActiveCount > 0
		if ai != aj {
			return ai
		}
		ci, cj := len(groups[i].Clusters), len(groups[j].Clusters)
		if (ci > 0) != (cj > 0) {
			return ci > 0
		}
		if ri, rj := severityRank(groups[i].MaxSeverity), severityRank(groups[j].MaxSeverity); ri != rj {
			return ri > rj
		}
		if pi, pj := groups[i].PkgRole == "primary", groups[j].PkgRole == "primary"; pi != pj {
			return pi
		}
		if groups[i].MaxCVSS != groups[j].MaxCVSS {
			return groups[i].MaxCVSS > groups[j].MaxCVSS
		}
		if groups[i].ActiveCount != groups[j].ActiveCount {
			return groups[i].ActiveCount > groups[j].ActiveCount
		}
		return groups[i].Package < groups[j].Package
	})
	return groups
}

// reapplyTriageAndScope refreshes VEX triage states & global ignore/perspective policy on a cached scan report
// and filters cluster impacts to the caller's IAM visibility scope.
func (s *storeServer) scopedScanReport(rep *secScanReport, user string) *secScanReport {
	if rep == nil {
		return nil
	}
	vis := s.visibleJobs(user)
	secDBMu.Lock()
	triageMap := s.loadSecTriage()
	policy := s.loadSecPolicy()
	secDBMu.Unlock()

	today := time.Now().UTC().Format("2006-01-02")
	out := *rep
	out.Findings = make([]secFinding, len(rep.Findings))
	out.ActiveCounts = secSeverityCounts{}
	out.TotalCounts = secSeverityCounts{}
	out.MiddlewareCounts = secSeverityCounts{}
	out.OSCounts = secSeverityCounts{}
	out.RuntimeCounts = secSeverityCounts{}
	out.RawOSCounts = secSeverityCounts{}
	out.RawRuntimeCounts = secSeverityCounts{}
	out.WaivedCount = 0
	out.SuppressedCount = 0
	out.SuppressedOSCount = 0
	out.SuppressedRuntimeCount = 0
	out.SuppressedPkgCount = 0
	out.ComponentRisks = map[string]secCompRiskBadge{}

	clusterMap := map[string]*secClusterSummary{}
	for _, cs := range rep.Clusters {
		if !vis(cs.Owner) {
			continue
		}
		cp := cs
		cp.Active = secSeverityCounts{}
		cp.Total = secSeverityCounts{}
		cp.MiddlewareActive = secSeverityCounts{}
		cp.OSActive = secSeverityCounts{}
		cp.TopCVEs = nil
		cp.MiddlewareTopCVEs = nil
		cp.OSTopCVEs = nil
		clusterMap[cs.ClusterID] = &cp
	}

	// Build primary middleware package set from catalog so even cached scan reports classify middleware vs OS accurately.
	var primarySet map[string]bool
	if s.plat != nil {
		primarySet = buildMiddlewarePrimarySet(s.plat.cat())
	} else {
		primarySet = map[string]bool{}
	}

	for i, orig := range rep.Findings {
		f := orig
		// Dynamically normalize UBUNTU-CVE-* / DEBIAN-CVE-* IDs even on pre-v2 cached reports.
		if norm := primaryCVE(f.CVE, f.Aliases); norm != "" && norm != f.CVE {
			f.CVE = norm
			f.Key = strings.ToUpper(norm) + "|" + strings.ToLower(f.Package) + "|" + f.EcoKey
		}
		// Always compute deterministic role (middleware primary vs OS dependency vs Python runtime).
		f.PkgRole = classifySecPkgRole(f.AssetType, f.Package, f.Closures, primarySet)
		var visCls []secClusterImpact
		for _, cl := range orig.Clusters {
			if vis(cl.Owner) {
				visCls = append(visCls, cl)
			}
		}
		f.Clusters = visCls
		applyTriageToFinding(&f, triageMap, today)
		applyGlobalIgnoreToFinding(&f, policy)
		addSeverityCount(&out.TotalCounts, f.Severity)
		if !f.Waived {
			if f.PkgRole == "dependency" {
				addSeverityCount(&out.RawOSCounts, f.Severity)
			} else if f.PkgRole == "runtime" {
				addSeverityCount(&out.RawRuntimeCounts, f.Severity)
			}
		}
		effectiveActive := !f.Waived && !f.GloballyIgnored
		if f.GloballyIgnored {
			out.SuppressedCount++
			switch f.IgnoreRuleID {
			case "layer:os":
				out.SuppressedOSCount++
			case "layer:runtime":
				out.SuppressedRuntimeCount++
			default:
				out.SuppressedPkgCount++
			}
		} else if f.Waived {
			out.WaivedCount++
		} else {
			addSeverityCount(&out.ActiveCounts, f.Severity)
			switch f.PkgRole {
			case "primary":
				addSeverityCount(&out.MiddlewareCounts, f.Severity)
			case "runtime":
				addSeverityCount(&out.RuntimeCounts, f.Severity)
			default:
				addSeverityCount(&out.OSCounts, f.Severity)
			}
		}
		for _, c := range f.Components {
			cvk := c.Component + "@" + c.Version + "@" + c.Platform
			b := out.ComponentRisks[cvk]
			b.Component, b.Version, b.Platform = c.Component, c.Version, c.Platform
			if effectiveActive {
				b.Total++
				if f.PkgRole == "primary" {
					b.MiddlewareTotal++
				} else if f.PkgRole != "runtime" {
					b.OSTotal++
				}
				switch f.Severity {
				case "CRITICAL":
					b.Critical++
					if f.PkgRole == "primary" {
						b.MiddlewareCritical++
					} else if f.PkgRole != "runtime" {
						b.OSCritical++
					}
				case "HIGH":
					b.High++
					if f.PkgRole == "primary" {
						b.MiddlewareHigh++
					} else if f.PkgRole != "runtime" {
						b.OSHigh++
					}
				case "MEDIUM":
					b.Medium++
				case "LOW":
					b.Low++
				}
			}
			out.ComponentRisks[cvk] = b
		}
		for _, cl := range f.Clusters {
			if cs := clusterMap[cl.ClusterID]; cs != nil {
				addSeverityCount(&cs.Total, f.Severity)
				if effectiveActive {
					addSeverityCount(&cs.Active, f.Severity)
					if f.PkgRole == "primary" {
						addSeverityCount(&cs.MiddlewareActive, f.Severity)
						if (f.Severity == "CRITICAL" || f.Severity == "HIGH") && !contains(cs.MiddlewareTopCVEs, f.CVE) && len(cs.MiddlewareTopCVEs) < 5 {
							cs.MiddlewareTopCVEs = append(cs.MiddlewareTopCVEs, f.CVE)
						}
					} else if f.PkgRole != "runtime" {
						addSeverityCount(&cs.OSActive, f.Severity)
						if (f.Severity == "CRITICAL" || f.Severity == "HIGH") && !contains(cs.OSTopCVEs, f.CVE) && len(cs.OSTopCVEs) < 5 {
							cs.OSTopCVEs = append(cs.OSTopCVEs, f.CVE)
						}
					}
					if (f.Severity == "CRITICAL" || f.Severity == "HIGH") && !contains(cs.TopCVEs, f.CVE) && len(cs.TopCVEs) < 5 {
						cs.TopCVEs = append(cs.TopCVEs, f.CVE)
					}
				}
			}
		}
		out.Findings[i] = f
	}
	out.PackageGroups = buildPackageGroups(out.Findings)

	out.Clusters = make([]secClusterSummary, 0, len(clusterMap))
	out.AffectedClusters = 0
	out.MiddlewareAffectedClusters = 0
	out.OSAffectedClusters = 0
	for _, cs := range clusterMap {
		if cs.Active.Total > 0 {
			out.AffectedClusters++
		}
		if cs.MiddlewareActive.Total > 0 {
			out.MiddlewareAffectedClusters++
		}
		if cs.OSActive.Total > 0 {
			out.OSAffectedClusters++
		}
		out.Clusters = append(out.Clusters, *cs)
	}
	out.ClusterCount = len(out.Clusters)
	sort.Slice(out.Clusters, func(i, j int) bool {
		if out.Clusters[i].MiddlewareActive.Critical != out.Clusters[j].MiddlewareActive.Critical {
			return out.Clusters[i].MiddlewareActive.Critical > out.Clusters[j].MiddlewareActive.Critical
		}
		if out.Clusters[i].MiddlewareActive.High != out.Clusters[j].MiddlewareActive.High {
			return out.Clusters[i].MiddlewareActive.High > out.Clusters[j].MiddlewareActive.High
		}
		if out.Clusters[i].Active.Critical != out.Clusters[j].Active.Critical {
			return out.Clusters[i].Active.Critical > out.Clusters[j].Active.Critical
		}
		if out.Clusters[i].Active.High != out.Clusters[j].Active.High {
			return out.Clusters[i].Active.High > out.Clusters[j].Active.High
		}
		return out.Clusters[i].ClusterID < out.Clusters[j].ClusterID
	})
	return &out
}

// publishSecurityGateIssues enforces the optional policy gate when publishing component versions.
func (s *storeServer) publishSecurityGateIssues(comp, ver string, platforms []string) []string {
	secDBMu.Lock()
	pol := s.loadSecPolicy()
	rep := s.loadLatestScan()
	triageMap := s.loadSecTriage()
	secDBMu.Unlock()
	if !pol.BlockPublishCritical || rep == nil {
		return nil
	}
	var primarySet map[string]bool
	if s.plat != nil {
		primarySet = buildMiddlewarePrimarySet(s.plat.cat())
	} else {
		primarySet = map[string]bool{}
	}
	today := time.Now().UTC().Format("2006-01-02")
	wantPl := map[string]bool{}
	for _, p := range platforms {
		wantPl[p] = true
	}
	var cves []string
	for _, orig := range rep.Findings {
		f := orig
		f.PkgRole = classifySecPkgRole(f.AssetType, f.Package, f.Closures, primarySet)
		if (pol.GateMiddlewareOnly || pol.HideOSCVEs) && f.PkgRole == "dependency" {
			continue
		}
		if (pol.GateMiddlewareOnly || pol.HideRuntimeCVEs) && f.PkgRole == "runtime" {
			continue
		}
		applyTriageToFinding(&f, triageMap, today)
		applyGlobalIgnoreToFinding(&f, pol)
		if f.Waived || f.GloballyIgnored || f.Severity != "CRITICAL" {
			continue
		}
		for _, ci := range f.Components {
			if ci.Component == comp && ci.Version == ver && wantPl[ci.Platform] {
				label := fmt.Sprintf("%s（%s %s）", f.CVE, f.Package, f.InstalledVersion)
				if !contains(cves, label) {
					cves = append(cves, label)
				}
			}
		}
	}
	return cves
}

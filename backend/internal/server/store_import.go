package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"delivery-studio/mwpack"
)

// ---- Brownfield Middleware Cluster Onboarding (Import / Adoption) ----
//
// Endpoints:
//   GET  /api/clusters/import/presets       - Catalog components + 36+ built-in presets + platforms + icons
//   POST /api/clusters/import/probe-script  - Generate 100% statically validated read-only Bash probe script
//   POST /api/clusters/import/parse         - Parse probe output / CMDB / config / screenshots (AI + deterministic fallback)
//   POST /api/clusters/import               - Onboard cluster (DeliveryMode="imported", State="succeeded", Outcome="done")
//   GET  /api/clusters/{id}/baseline        - Read current baseline & ImportedMeta for editing
//   PUT  /api/clusters/{id}/baseline        - Update imported cluster baseline (re-writes spec, plan.json, storeJob)

type importPresetItem struct {
	ID              string                    `json:"id"`
	Name            string                    `json:"name"`
	NameEn          string                    `json:"name_en,omitempty"`
	Category        string                    `json:"category"`
	CategoryTitle   string                    `json:"category_title"`
	CategoryTitleEn string                    `json:"category_title_en,omitempty"`
	Icon            string                    `json:"icon"`
	Color           string                    `json:"color"`
	Summary         string                    `json:"summary"`
	SummaryEn       string                    `json:"summary_en,omitempty"`
	InCatalog       bool                      `json:"in_catalog"`
	DefaultPort     int                       `json:"default_port,omitempty"`
	Versions        []string                  `json:"versions,omitempty"`
	Roles           []mwpack.ImportRolePreset `json:"roles"`
	ServiceHints    []string                  `json:"service_hints,omitempty"`
	ConfigHints     []string                  `json:"config_hints,omitempty"`
	DataHints       []string                  `json:"data_hints,omitempty"`
	LogHints        []string                  `json:"log_hints,omitempty"`
}

type importHostInput struct {
	Name string `json:"name"`
	IP   string `json:"ip"`
	Role string `json:"role,omitempty"`
	Disk string `json:"disk,omitempty"`
}

type baselineGap struct {
	ID          string `json:"id"`
	Severity    string `json:"severity"` // high | medium | low
	Category    string `json:"category"`
	Title       string `json:"title"`
	Detail      string `json:"detail"`
	ProbeAction string `json:"probe_action"`
	Selected    bool   `json:"selected"`
	Source      string `json:"source,omitempty"` // rule | ai
}

type baselineHealth struct {
	Score   int           `json:"score"`
	Passed  int           `json:"passed"`
	Total   int           `json:"total"`
	Summary string        `json:"summary"`
	Gaps    []baselineGap `json:"gaps"`
}

type importClusterReq struct {
	ID                  string                     `json:"id"`
	Title               string                     `json:"title,omitempty"`
	Component           string                     `json:"component"`
	DisplayName         string                     `json:"display_name,omitempty"`
	Category            string                     `json:"category,omitempty"`
	Icon                string                     `json:"icon,omitempty"`
	Color               string                     `json:"color,omitempty"`
	Version             string                     `json:"version"`
	ExactVersion        string                     `json:"exact_version,omitempty"`
	Platform            string                     `json:"platform,omitempty"`
	OSDetail            string                     `json:"os_detail,omitempty"`
	SourceKind          string                     `json:"source_kind,omitempty"` // manual | probe | ai_doc
	DeployMethod        string                     `json:"deploy_method,omitempty"`
	ArchSummary         string                     `json:"arch_summary,omitempty"`
	Hosts               []importHostInput          `json:"hosts"`
	Endpoints           []mwpack.ImportedEndpoint  `json:"endpoints,omitempty"`
	Companions          []mwpack.ImportedCompanion `json:"companions,omitempty"`
	SuggestedCompanions []mwpack.ImportedCompanion `json:"suggested_companions,omitempty"`
	ServiceUnits        []string                   `json:"service_units,omitempty"`
	ConfigPaths         []string                   `json:"config_paths,omitempty"`
	DataDirs            []string                   `json:"data_dirs,omitempty"`
	LogDirs             []string                   `json:"log_dirs,omitempty"`
	Params              map[string]any             `json:"params,omitempty"`
	Packages            []mwpack.ImportedPkg       `json:"packages,omitempty"`
	Notes               string                     `json:"notes,omitempty"`
	LastProbedAt        string                     `json:"last_probed_at,omitempty"`
	Health              *baselineHealth            `json:"health,omitempty"`
}

type importProbeScriptReq struct {
	ClusterID    string        `json:"cluster_id,omitempty"`
	Component    string        `json:"component"`
	DisplayName  string        `json:"display_name,omitempty"`
	DeployMethod string        `json:"deploy_method,omitempty"`
	ServiceUnits []string      `json:"service_units,omitempty"`
	ConfigPaths  []string      `json:"config_paths,omitempty"`
	MissingGaps  []string      `json:"missing_gaps,omitempty"`
	CustomGaps   []baselineGap `json:"custom_gaps,omitempty"`
	Mode         string        `json:"mode,omitempty"` // gap | full
	UseAI        bool          `json:"use_ai,omitempty"`
	Focus        string        `json:"focus,omitempty"`
	Model        string        `json:"model,omitempty"`
	Think        string        `json:"think,omitempty"`
}

type importParseReq struct {
	ClusterID   string   `json:"cluster_id,omitempty"`
	Component   string   `json:"component,omitempty"`
	DisplayName string   `json:"display_name,omitempty"`
	SourceKind  string   `json:"source_kind,omitempty"` // probe | ai_doc
	Text        string   `json:"text,omitempty"`
	Images      []string `json:"images,omitempty"`
	UseAI       *bool    `json:"use_ai,omitempty"`
	Model       string   `json:"model,omitempty"`
	Think       string   `json:"think,omitempty"`
}

type importParseDraft struct {
	SuggestedID  string                     `json:"suggested_id,omitempty"`
	Component    string                     `json:"component,omitempty"`
	DisplayName  string                     `json:"display_name,omitempty"`
	Version      string                     `json:"version,omitempty"`
	ExactVersion string                     `json:"exact_version,omitempty"`
	Platform     string                     `json:"platform,omitempty"`
	OSDetail     string                     `json:"os_detail,omitempty"`
	DeployMethod string                     `json:"deploy_method,omitempty"`
	ArchSummary  string                     `json:"arch_summary,omitempty"`
	Hosts        []importHostInput          `json:"hosts"`
	Endpoints    []mwpack.ImportedEndpoint  `json:"endpoints"`
	Companions   []mwpack.ImportedCompanion `json:"companions"`
	ServiceUnits []string                   `json:"service_units"`
	ConfigPaths  []string                   `json:"config_paths"`
	DataDirs     []string                   `json:"data_dirs"`
	LogDirs      []string                   `json:"log_dirs"`
	Params       map[string]any             `json:"params"`
	Packages     []mwpack.ImportedPkg       `json:"packages"`
	Notes        string                     `json:"notes,omitempty"`
}

// handleClusterImport dispatches /api/clusters/import... routes.
func (s *storeServer) handleClusterImport(w http.ResponseWriter, r *http.Request, session storeSession) {
	sub := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/clusters/import"), "/")
	switch {
	case sub == "" && r.Method == "POST":
		s.importCluster(w, r, session)
	case sub == "presets" && r.Method == "GET":
		s.importPresetsHandler(w, r, session)
	case sub == "probe-script" && r.Method == "POST":
		s.importProbeScriptHandler(w, r, session)
	case sub == "diagnose-gaps" && r.Method == "POST":
		s.importDiagnoseGapsHandler(w, r, session)
	case sub == "parse" && r.Method == "POST":
		s.importParseHandler(w, r, session)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) importPresetsHandler(w http.ResponseWriter, r *http.Request, session storeSession) {
	lang := wLang(w)
	cat := s.plat.cat()
	inCat := map[string]bool{}
	var catalogItems []importPresetItem

	if cat != nil {
		for _, name := range cat.Names() {
			c, ok := cat.Get(name)
			if !ok || c.Kind == "external" || c.Name == "external-lb" {
				continue
			}
			inCat[c.Name] = true
			item := importPresetItem{
				ID:        c.Name,
				Name:      firstNonEmptyStr(c.Title, c.Name),
				NameEn:    mwpack.TranslateCatalogText("en-US", firstNonEmptyStr(c.Title, c.Name)),
				Category:  firstNonEmptyStr(c.Category, "middleware"),
				Icon:      firstNonEmptyStr(c.Icon, "server"),
				Color:     firstNonEmptyStr(c.Color, "blue"),
				Summary:   c.Summary,
				SummaryEn: mwpack.TranslateCatalogText("en-US", c.Summary),
				InCatalog: true,
			}
			for _, v := range c.Versions {
				if v.ID != "" {
					item.Versions = append(item.Versions, v.ID)
				}
			}
			if len(c.Versions) > 0 {
				if res, err := c.Resolve(c.Versions[0].ID); err == nil {
					for _, rl := range res.Roles {
						item.Roles = append(item.Roles, mwpack.ImportRolePreset{
							ID:      rl.Name,
							Title:   firstNonEmptyStr(rl.Title, rl.Name),
							TitleEn: mwpack.TranslateCatalogText("en-US", firstNonEmptyStr(rl.Title, rl.Name)),
						})
					}
				}
			}
			if pr, okP := mwpack.LookupImportPreset(c.Name); okP {
				item.Category = pr.Category
				item.CategoryTitle = pr.CategoryTitle
				item.CategoryTitleEn = pr.CategoryTitleEn
				item.DefaultPort = pr.DefaultPort
				item.ServiceHints = pr.ServiceHints
				item.ConfigHints = pr.ConfigHints
				item.DataHints = pr.DataHints
				item.LogHints = pr.LogHints
				if len(item.Roles) == 0 {
					item.Roles = pr.Roles
				}
			} else {
				item.CategoryTitle = tr(lang, "平台组件", "Catalog Component")
				item.CategoryTitleEn = "Catalog Component"
				if len(item.Roles) == 0 {
					item.Roles = []mwpack.ImportRolePreset{{ID: "node", Title: "节点", TitleEn: "Node"}}
				}
			}
			catalogItems = append(catalogItems, item)
		}
	}

	var presetItems []importPresetItem
	for _, pr := range mwpack.ImportPresets {
		if inCat[pr.ID] {
			continue
		}
		presetItems = append(presetItems, importPresetItem{
			ID:              pr.ID,
			Name:            pr.Name,
			NameEn:          pr.NameEn,
			Category:        pr.Category,
			CategoryTitle:   pr.CategoryTitle,
			CategoryTitleEn: pr.CategoryTitleEn,
			Icon:            pr.Icon,
			Color:           pr.Color,
			Summary:         pr.Summary,
			SummaryEn:       pr.SummaryEn,
			InCatalog:       false,
			DefaultPort:     pr.DefaultPort,
			Roles:           pr.Roles,
			ServiceHints:    pr.ServiceHints,
			ConfigHints:     pr.ConfigHints,
			DataHints:       pr.DataHints,
			LogHints:        pr.LogHints,
		})
	}

	type platItem struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	var plats []platItem
	for _, pl := range mwpack.Platforms {
		plats = append(plats, platItem{ID: pl.ID, Title: pl.Title})
	}

	s.writeJSON(w, 200, map[string]any{
		"catalog":    catalogItems,
		"presets":    presetItems,
		"companions": mwpack.CompanionCatalog,
		"platforms":  plats,
		"icons":      mwpack.ComponentIcons,
		"ai_enabled": s.aiStatusFor(session.User).Enabled,
	})
}

func buildImportProbeScript(req importProbeScriptReq, lang string) (string, string) {
	compID := mwpack.NormalizeImportComponentID(firstNonEmptyStr(req.Component, req.DisplayName))
	preset, hasPreset := mwpack.LookupImportPreset(compID)
	displayName := firstNonEmptyStr(strings.TrimSpace(req.DisplayName), preset.Name, compID)
	pkgMatch := preset.PkgMatch
	if pkgMatch == "" {
		pkgMatch = regexp.QuoteMeta(compID)
	}
	fullPkgMatch := pkgMatch + "|patroni|etcd|haproxy|keepalived|pgbackrest|pgbouncer|sentinel|zookeeper|proxysql|clickhouse-keeper|exporter"
	var sb strings.Builder
	sb.WriteString("#!/usr/bin/env bash\n")
	sb.WriteString("# ============================================================================\n")
	sb.WriteString(fmt.Sprintf("# Kyndryl Delivery Studio - Read-Only Cluster Inventory Probe (%s)\n", displayName))
	sb.WriteString("# 100% READ-ONLY: zero writes, zero restarts, zero config mutations, secrets redacted.\n")
	sb.WriteString("# Collects primary middleware + co-located HA/DCS/LB/Backup companions + OS + packages.\n")
	sb.WriteString("# Run on each target node (or primary node) and paste output back to the Import page.\n")
	sb.WriteString("# ============================================================================\n")
	sb.WriteString("set -u\nexport LC_ALL=C\n\n")

	sb.WriteString("echo '=== MW_IMPORT_BEGIN ==='\n")
	sb.WriteString(fmt.Sprintf("echo 'PROBE_COMPONENT=%s'\n", compID))
	sb.WriteString("echo 'PROBE_TIME='\"$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)\"\n\n")

	sb.WriteString("echo '=== MW_IMPORT_HOST ==='\n")
	sb.WriteString("echo \"HOSTNAME=$(hostname -s 2>/dev/null || hostname)\"\n")
	sb.WriteString("echo \"FQDN=$(hostname -f 2>/dev/null || hostname)\"\n")
	sb.WriteString("echo \"IPS=$(hostname -I 2>/dev/null | xargs)\"\n")
	sb.WriteString("echo \"KERNEL=$(uname -sr)\"\n")
	sb.WriteString("echo \"ARCH=$(uname -m)\"\n")
	sb.WriteString("echo \"CPU_CORES=$(nproc 2>/dev/null || echo unknown)\"\n")
	sb.WriteString("free -h 2>/dev/null | awk 'NR==1 || NR==2 {print \"MEM=\"$0}' || true\n\n")

	sb.WriteString("echo '=== MW_IMPORT_OS ==='\n")
	sb.WriteString("[ -r /etc/os-release ] && grep -E '^(ID|VERSION_ID|PRETTY_NAME)=' /etc/os-release || uname -a\n\n")

	sb.WriteString("echo '=== MW_IMPORT_STORAGE ==='\n")
	sb.WriteString("df -hT -x tmpfs -x devtmpfs -x overlay 2>/dev/null | head -n 20 || true\n")
	sb.WriteString("command -v lsblk >/dev/null 2>&1 && lsblk -dn -o NAME,SIZE,TYPE,MOUNTPOINT 2>/dev/null | head -n 15 || true\n\n")

	sb.WriteString("echo '=== MW_IMPORT_PORTS ==='\n")
	sb.WriteString("if command -v ss >/dev/null 2>&1; then\n")
	sb.WriteString("  ss -tlnp 2>/dev/null | head -n 40\n")
	sb.WriteString("elif command -v netstat >/dev/null 2>&1; then\n")
	sb.WriteString("  netstat -tlnp 2>/dev/null | head -n 40\n")
	sb.WriteString("fi\n\n")

	sb.WriteString("echo '=== MW_IMPORT_HOSTS_FILE ==='\n")
	sb.WriteString("[ -r /etc/hosts ] && grep -vE '^\\s*(#|$|127\\.|::1|fe00|ff0)' /etc/hosts | head -n 30 || true\n\n")

	sb.WriteString("echo '=== MW_IMPORT_MIDDLEWARE ==='\n")
	if req.DeployMethod == "docker" || req.DeployMethod == "k8s" {
		sb.WriteString("command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}\\t{{.Image}}\\t{{.Ports}}\\t{{.Status}}' 2>/dev/null | head -n 30 || true\n")
		sb.WriteString("command -v crictl >/dev/null 2>&1 && crictl ps 2>/dev/null | head -n 30 || true\n")
	}
	if hasPreset && strings.TrimSpace(preset.ProbeSnippet) != "" {
		sb.WriteString(strings.TrimSpace(preset.ProbeSnippet) + "\n")
	} else {
		sb.WriteString(fmt.Sprintf("systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE '%s' || true\n", pkgMatch))
		sb.WriteString(fmt.Sprintf("ps -ef 2>/dev/null | grep -iE '%s' | grep -v grep | head -n 20 || true\n", pkgMatch))
	}

	sb.WriteString("\necho '=== MW_IMPORT_COMPANIONS ==='\n")
	sb.WriteString("systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'patroni|etcd|consul|zookeeper|haproxy|keepalived|nginx|openresty|pgbouncer|sentinel|proxysql|maxscale|obproxy|clickhouse-keeper|[a-z0-9_-]*exporter' || true\n")
	sb.WriteString("ps -ef 2>/dev/null | grep -iE 'patroni|etcd|consul|QuorumPeerMain|haproxy|keepalived|pgbouncer|redis-sentinel|proxysql|clickhouse-keeper|[a-z0-9_-]*exporter' | grep -v grep | head -n 25 || true\n")
	sb.WriteString("for exp in node_exporter process_exporter postgres_exporter mysqld_exporter redis_exporter haproxy_exporter nginx_exporter kafka_exporter blackbox_exporter; do command -v \"$exp\" >/dev/null 2>&1 && \"$exp\" --version 2>&1 | head -n 2; done || true\n")

	// Custom service units or config paths hints provided by user
	for _, u := range req.ServiceUnits {
		u = strings.TrimSpace(u)
		if u == "" || !reSafeShellToken.MatchString(u) {
			continue
		}
		sb.WriteString(fmt.Sprintf("systemctl show '%s' -p ActiveState -p SubState -p ExecStart -p FragmentPath --no-pager 2>/dev/null || true\n", u))
	}
	for _, cf := range req.ConfigPaths {
		cf = strings.TrimSpace(cf)
		if cf == "" || !reSafePathToken.MatchString(cf) {
			continue
		}
		sb.WriteString(fmt.Sprintf("[ -r '%s' ] && { echo '# file: %s'; grep -vE '^\\s*(#|;|\\s*$|.*pass|.*secret|.*token|.*key)' '%s' | head -n 40; } || true\n", cf, cf, cf))
	}

	sb.WriteString("\necho '=== MW_IMPORT_PACKAGES ==='\n")
	sb.WriteString("if command -v dpkg-query >/dev/null 2>&1; then\n")
	sb.WriteString(fmt.Sprintf("  dpkg-query -W -f='${Package}\\t${Version}\\n' 2>/dev/null | grep -iE '%s' | sort -u | head -n 80 || true\n", fullPkgMatch))
	sb.WriteString("elif command -v rpm >/dev/null 2>&1; then\n")
	sb.WriteString(fmt.Sprintf("  rpm -qa --qf '%%{NAME}\\t%%{VERSION}-%%{RELEASE}\\n' 2>/dev/null | grep -iE '%s' | sort -u | head -n 80 || true\n", fullPkgMatch))
	sb.WriteString("fi\n")
	sb.WriteString("echo '=== MW_IMPORT_END ==='\n")

	filename := fmt.Sprintf("mw-import-probe-%s.sh", compID)
	return sb.String(), filename
}

var (
	reSafeShellToken        = regexp.MustCompile(`^[a-zA-Z0-9._:@-]+$`)
	reSafePathToken         = regexp.MustCompile(`^/[a-zA-Z0-9._/@*+-]+$`)
	reExporterToken         = regexp.MustCompile(`(?i)\b([a-z][a-z0-9_-]*[_-]exporter)\b`)
	reExporterVersionBanner = regexp.MustCompile(`(?i)\b([a-z][a-z0-9_-]*[_-]exporter)\b[,\s]+(?:version\s+|v)(\d+\.\d+(?:\.\d+)*)`)
	rePGDataFlag            = regexp.MustCompile(`postgres[^\n]*\s-D\s+(/[a-zA-Z0-9._/@+-]+)`)
)

func analyzeImportedBaselineHealth(compID, displayName string, req importClusterReq, lang string) baselineHealth {
	cid := mwpack.NormalizeImportComponentID(firstNonEmptyStr(compID, req.Component, displayName))
	dname := firstNonEmptyStr(strings.TrimSpace(displayName), req.DisplayName, cid)
	notesLower := strings.ToLower(req.Notes)
	hasCompanion := func(target string) bool {
		t := mwpack.NormalizeCompanionID(target)
		for _, cm := range req.Companions {
			if mwpack.NormalizeCompanionID(cm.Component) == t {
				return true
			}
		}
		return false
	}
	hasParamKey := func(subs ...string) bool {
		for k := range req.Params {
			kl := strings.ToLower(k)
			for _, sub := range subs {
				if strings.Contains(kl, sub) {
					return true
				}
			}
		}
		return false
	}
	hasPathMatching := func(paths []string, subs ...string) bool {
		for _, p := range paths {
			pl := strings.ToLower(p)
			for _, sub := range subs {
				if strings.Contains(pl, sub) {
					return true
				}
			}
		}
		return false
	}

	var gaps []baselineGap
	total := 0
	passed := 0
	check := func(ok bool, gap baselineGap) {
		total++
		if ok {
			passed++
			return
		}
		gaps = append(gaps, gap)
	}

	// 1. Core config / data / log path baseline
	pathsOK := len(req.ConfigPaths) > 0 && len(req.DataDirs) > 0 && len(req.LogDirs) > 0
	pathMissingParts := []string{}
	if cid == "postgresql" {
		hasPGCfg := hasPathMatching(req.ConfigPaths, "patroni", "postgresql", "postgres")
		hasPGData := hasPathMatching(req.DataDirs, "pg", "postgres", "postgresql")
		hasPGLog := hasPathMatching(req.LogDirs, "pg", "postgres", "postgresql")
		pathsOK = hasPGCfg && hasPGData && hasPGLog
		if !hasPGCfg {
			pathMissingParts = append(pathMissingParts, tr(lang, "Patroni/PG 配置文件路径", "Patroni/PG config path"))
		}
		if !hasPGData {
			pathMissingParts = append(pathMissingParts, tr(lang, "PostgreSQL 数据目录", "PostgreSQL data dir"))
		}
		if !hasPGLog {
			pathMissingParts = append(pathMissingParts, tr(lang, "PostgreSQL 日志目录", "PostgreSQL log dir"))
		}
	} else {
		if len(req.ConfigPaths) == 0 {
			pathMissingParts = append(pathMissingParts, tr(lang, "配置文件路径", "config path"))
		}
		if len(req.DataDirs) == 0 {
			pathMissingParts = append(pathMissingParts, tr(lang, "数据目录", "data directory"))
		}
		if len(req.LogDirs) == 0 {
			pathMissingParts = append(pathMissingParts, tr(lang, "日志目录", "log directory"))
		}
	}
	check(pathsOK, baselineGap{
		ID:       "paths",
		Severity: "high",
		Category: tr(lang, "路径基线", "Paths"),
		Title:    tr(lang, fmt.Sprintf("缺少 %s", strings.Join(pathMissingParts, "、")), fmt.Sprintf("Missing %s", strings.Join(pathMissingParts, ", "))),
		Detail:   tr(lang, "后续变更演练、日志巡检与故障恢复预案均依赖准确的运行目录与主配置路径。", "Change rehearsal, log inspection, and recovery runbooks require exact config/data/log paths."),
		ProbeAction: tr(lang,
			fmt.Sprintf("只读定位 %s 主配置文件、真实数据目录与日志落盘路径", dname),
			fmt.Sprintf("Read-only lookup of %s config file, active data dir, and log dir", dname),
		),
		Selected: true,
	})

	// 2. Key runtime parameters baseline
	paramsOK := len(req.Params) >= 3
	paramHint := tr(lang, "关键运行参数与连接/内存配置", "core runtime tuning parameters")
	switch cid {
	case "postgresql":
		paramHint = "max_connections / shared_buffers / wal_level / archive_mode / synchronous_commit"
	case "mysql", "mariadb":
		paramHint = "innodb_buffer_pool_size / max_connections / binlog_format / gtid_mode"
	case "redis", "valkey":
		paramHint = "maxmemory / maxmemory-policy / appendonly / save / timeout"
	case "etcd":
		paramHint = "quota-backend-bytes / auto-compaction-retention / snapshot-count"
	}
	check(paramsOK, baselineGap{
		ID:       "params",
		Severity: "high",
		Category: tr(lang, "核心参数", "Parameters"),
		Title:    tr(lang, fmt.Sprintf("核心运行参数不足（当前仅 %d 项）", len(req.Params)), fmt.Sprintf("Core runtime parameters incomplete (%d recorded)", len(req.Params))),
		Detail:   tr(lang, fmt.Sprintf("对照标准生产基线，建议采集 %s 等关键参数用于调优与漂移比对。", paramHint), fmt.Sprintf("Standard baseline expects key parameters such as %s for tuning and drift comparison.", paramHint)),
		ProbeAction: tr(lang,
			fmt.Sprintf("只读采集 %s 核心生效运行参数（脱敏过滤口令）", dname),
			fmt.Sprintf("Read-only query of active %s parameters (secrets redacted)", dname),
		),
		Selected: true,
	})

	// 3. Backup & recovery baseline (for stateful / DB workloads)
	isStateful := cid == "postgresql" || cid == "mysql" || cid == "mariadb" || cid == "redis" || cid == "valkey" || cid == "etcd" || cid == "mongodb" || cid == "clickhouse" || cid == "oceanbase" || cid == "kingbase" || cid == "dm"
	if isStateful {
		hasBackupEvidence := hasParamKey("backup", "stanza", "archive_command", "repo", "rdb", "aof") ||
			(strings.Contains(notesLower, "stanza") && !strings.Contains(notesLower, "未发现") && !strings.Contains(notesLower, "无 stanza") && !strings.Contains(notesLower, "未配置")) ||
			(strings.Contains(notesLower, "全量备份") && !strings.Contains(notesLower, "无备份"))
		backupDetail := tr(lang, "尚未核实集群备份仓库、定时调度及最近一次成功备份记录。", "Backup repository, schedule, and latest verified backup status are not yet confirmed.")
		backupAction := tr(lang, "只读核查备份工具配置、定时任务及归档/快照状态", "Read-only check of backup config, cron schedules, and archive/snapshot status")
		if cid == "postgresql" && hasCompanion("pgbackrest") {
			backupDetail = tr(lang, "已检测到 pgBackRest，但尚未核验 Stanza、备份仓库位置、归档模式与最近备份记录。", "pgBackRest is installed, but stanza, repo path, archive_mode, and latest backup remain unverified.")
			backupAction = tr(lang, "只读执行 pgbackrest info、检查 /etc/pgbackrest* 配置与定时备份任务", "Read-only pgbackrest info, /etc/pgbackrest* check, and backup cron inspection")
		}
		check(hasBackupEvidence, baselineGap{
			ID:          "backup",
			Severity:    "high",
			Category:    tr(lang, "备份容灾", "Backup & DR"),
			Title:       tr(lang, "备份仓库与恢复闭环状态待核验", "Backup Repository & Recovery Status Unverified"),
			Detail:      backupDetail,
			ProbeAction: backupAction,
			Selected:    true,
		})
	}

	// 4. Multi-node peer host verification
	if len(req.Hosts) > 1 {
		singleNodeOnly := strings.Contains(notesLower, "仅在") && (strings.Contains(notesLower, "执行") || strings.Contains(notesLower, "采集"))
		missingDisk := 0
		for _, h := range req.Hosts {
			if strings.TrimSpace(h.Disk) == "" {
				missingDisk++
			}
		}
		peersOK := !singleNodeOnly && missingDisk == 0
		check(peersOK, baselineGap{
			ID:       "peers",
			Severity: "medium",
			Category: tr(lang, "全节点覆盖", "Peer Coverage"),
			Title:    tr(lang, fmt.Sprintf("多节点集群（%d 台）部分从库/成员节点待核验", len(req.Hosts)), fmt.Sprintf("Peer nodes in %d-host cluster pending local verification", len(req.Hosts))),
			Detail:   tr(lang, "当前部分节点信息来自成员表推断或缺少独立数据盘/本地服务状态核验，建议在备节点补跑轻量只读探针。", "Some peer nodes were inferred from cluster membership or lack local disk/service verification."),
			ProbeAction: tr(lang,
				"只读核验备节点 systemd 服务状态、磁盘挂载与主从/DCS 成员健康",
				"Read-only verification of peer systemd services, disk mounts, and member health",
			),
			Selected: true,
		})
	}

	// 5. Access endpoint & HA failover routing verification
	hasProxyOrVIP := hasCompanion("haproxy") || hasCompanion("keepalived") || hasCompanion("nginx") || hasCompanion("pgbouncer") || hasCompanion("proxysql") || hasCompanion("maxscale") || hasCompanion("obproxy")
	unverifiedVIP := strings.Contains(notesLower, "未见其监听") || strings.Contains(notesLower, "疑为 vip") || strings.Contains(notesLower, "待确认 vip")
	epOK := len(req.Endpoints) > 0 && !unverifiedVIP && (len(req.Hosts) <= 1 || hasProxyOrVIP)
	check(epOK, baselineGap{
		ID:       "endpoint",
		Severity: "medium",
		Category: tr(lang, "访问入口", "Endpoints & HA"),
		Title:    tr(lang, "统一访问入口 / VIP 承载与切换机制待核实", "Access Endpoint / VIP Routing & Failover Unverified"),
		Detail:   tr(lang, "核清业务读写入口实际挂载在 VIP、LB 还是直连节点，确保主备切换演练期间流量切换可控。", "Verify whether the read/write endpoint terminates on a VIP, load balancer, or direct host for safe failover."),
		ProbeAction: tr(lang,
			"只读核查网卡 VIP 绑定（ip -br addr）、端口监听与代理/Keepalived 配置",
			"Read-only inspection of VIP bindings (ip -br addr), listening sockets, and proxy/Keepalived config",
		),
		Selected: unverifiedVIP || len(req.Endpoints) == 0,
	})

	// 6. TLS encryption & access control security baseline
	secOK := hasParamKey("ssl", "tls", "hba", "requirepass", "cert") ||
		(strings.Contains(notesLower, "tls") && !strings.Contains(notesLower, "未启用") && !strings.Contains(notesLower, "http 协议"))
	check(secOK, baselineGap{
		ID:       "security",
		Severity: "medium",
		Category: tr(lang, "安全合规", "Security & TLS"),
		Title:    tr(lang, "TLS 传输加密、证书有效期与访问控制策略待核验", "TLS Encryption, Cert Expiry & Access Policy Unverified"),
		Detail:   tr(lang, "采集 TLS 开关、证书到期时间及白名单策略（如 pg_hba / etcd 协议），完善集群安全审计基线。", "Collect TLS status, certificate expiry dates, and access rules (secrets redacted) for security audit."),
		ProbeAction: tr(lang,
			"只读检查 TLS/SSL 开关、证书到期时间与脱敏后的访问控制规则",
			"Read-only check of TLS/SSL flags, cert expiry dates, and redacted access rules",
		),
		Selected: false,
	})

	// 7. Exact version, OS detail & CVE package inventory
	pkgsOK := strings.TrimSpace(req.ExactVersion) != "" && strings.TrimSpace(req.OSDetail) != "" && len(req.Packages) >= 2
	check(pkgsOK, baselineGap{
		ID:       "packages",
		Severity: "high",
		Category: tr(lang, "版本与 CVE", "Versions & CVE"),
		Title:    tr(lang, "精确版本、OS 详情或软件包清单不完整", "Exact Version, OS Detail, or Package Inventory Incomplete"),
		Detail:   tr(lang, "精确版本号与 dpkg/rpm 软件清单直接决定离线 CVE 漏洞扫描与升级路径准确性。", "Exact versions and dpkg/rpm inventories drive offline CVE scanning and upgrade planning."),
		ProbeAction: tr(lang,
			"只读采集 OS 发行版、内核、组件精确版本及 dpkg/rpm 软件包清单",
			"Read-only collection of OS release, kernel, exact versions, and dpkg/rpm packages",
		),
		Selected: true,
	})

	// 8. Monitoring exporter versions (low severity enhancement)
	missingExpVer := false
	for _, cm := range req.Companions {
		if (cm.Kind == "os_component" || cm.Kind == "monitoring" || strings.Contains(strings.ToLower(cm.Component), "exporter")) && strings.TrimSpace(cm.Version) == "" {
			missingExpVer = true
			break
		}
	}
	if missingExpVer {
		check(false, baselineGap{
			ID:       "monitoring",
			Severity: "low",
			Category: tr(lang, "监控组件", "Monitoring"),
			Title:    tr(lang, "已发现 Exporter 监控采集组件缺少精确版本信息", "Detected Exporter Component Missing Exact Version"),
			Detail:   tr(lang, "补采 node_exporter / 中间件 exporter 版本与监听端口，完善组件栈档案与 CVE 纳管。", "Collect exporter binary version and listening port to complete stack inventory."),
			ProbeAction: tr(lang,
				"只读执行 *_exporter --version 并核对监听端口",
				"Read-only *_exporter --version and listening port verification",
			),
			Selected: false,
		})
	} else {
		total++
		passed++
	}

	// Tag deterministic baseline rules cleanly and sort high -> medium -> low
	for i := range gaps {
		if gaps[i].Source == "" {
			gaps[i].Source = "rule"
		}
	}
	sevRank := map[string]int{"high": 0, "medium": 1, "low": 2}
	sort.SliceStable(gaps, func(i, j int) bool {
		return sevRank[gaps[i].Severity] < sevRank[gaps[j].Severity]
	})

	score := 100
	if total > 0 {
		score = passed * 100 / total
	}
	summary := tr(lang,
		fmt.Sprintf("对照标准生产交付基线已达标 %d/%d 项，可直接使用；如有变动可随时发起增量核验。", passed, total),
		fmt.Sprintf("Baseline meets %d/%d standard production checks; ready for rehearsal and reporting.", passed, total),
	)
	if len(gaps) > 0 {
		summary = tr(lang,
			fmt.Sprintf("对照标准生产基线已齐备 %d/%d 项，识别出 %d 项待补采缺口；勾选后可让 AI 一键生成专项 100%% 只读探针补齐。", passed, total, len(gaps)),
			fmt.Sprintf("Baseline covers %d/%d standard checks with %d gap(s); select items to generate a targeted 100%% read-only AI probe.", passed, total, len(gaps)),
		)
	}
	return baselineHealth{
		Score:   score,
		Passed:  passed,
		Total:   total,
		Summary: summary,
		Gaps:    gaps,
	}
}

// buildGapReadOnlyProbeScript constructs a lean, deterministic, 100% read-only Bash probe strictly targeting
// the selected baseline gaps so customers only run minimal safe checks instead of bloated full scripts.
func buildGapReadOnlyProbeScript(req importProbeScriptReq, existing *importClusterReq, selectedGaps []baselineGap, lang string) (string, string, []string, string) {
	compID := mwpack.NormalizeImportComponentID(firstNonEmptyStr(req.Component, req.DisplayName))
	preset, _ := mwpack.LookupImportPreset(compID)
	displayName := firstNonEmptyStr(strings.TrimSpace(req.DisplayName), preset.Name, compID)

	want := map[string]bool{}
	var covered []string
	for _, g := range selectedGaps {
		want[g.ID] = true
		covered = append(covered, g.Category)
	}
	for _, rawID := range req.MissingGaps {
		id := strings.ToLower(strings.TrimSpace(rawID))
		if id != "" {
			want[id] = true
		}
	}
	if len(want) == 0 {
		want["paths"] = true
		want["params"] = true
	}

	var sb strings.Builder
	sb.WriteString("#!/usr/bin/env bash\n")
	sb.WriteString("# ============================================================================\n")
	sb.WriteString(fmt.Sprintf("# Kyndryl Delivery Studio - Targeted Gap Read-Only Probe (%s)\n", displayName))
	sb.WriteString("# 100% READ-ONLY IRON LAW: zero writes, zero restarts, zero mutations, secrets redacted.\n")
	if len(covered) > 0 {
		sb.WriteString(fmt.Sprintf("# Target Gaps: %s\n", strings.Join(covered, ", ")))
	}
	sb.WriteString("# ============================================================================\n")
	sb.WriteString("set -u\nexport LC_ALL=C\n\n")
	sb.WriteString("echo '=== MW_IMPORT_BEGIN ==='\n")
	sb.WriteString(fmt.Sprintf("echo 'PROBE_COMPONENT=%s'\n", compID))
	sb.WriteString("echo 'PROBE_MODE=gap_enrichment'\n")
	sb.WriteString("echo 'PROBE_TIME='\"$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)\"\n\n")

	sb.WriteString("echo '=== MW_IMPORT_HOST ==='\n")
	sb.WriteString("echo \"HOSTNAME=$(hostname -s 2>/dev/null || hostname)\"\n")
	sb.WriteString("echo \"IPS=$(hostname -I 2>/dev/null | xargs)\"\n")

	if want["peers"] {
		sb.WriteString("echo \"KERNEL=$(uname -sr)\"\n")
		sb.WriteString("df -hT -x tmpfs -x devtmpfs -x overlay 2>/dev/null | head -n 15 || true\n")
		sb.WriteString("command -v lsblk >/dev/null 2>&1 && lsblk -dn -o NAME,SIZE,TYPE,MOUNTPOINT 2>/dev/null | head -n 12 || true\n")
	}

	if want["endpoint"] || want["monitoring"] {
		sb.WriteString("\necho '=== MW_IMPORT_PORTS ==='\n")
		sb.WriteString("command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | head -n 35 || true\n")
		if want["endpoint"] {
			sb.WriteString("command -v ip >/dev/null 2>&1 && ip -br addr 2>/dev/null | head -n 15 || true\n")
			sb.WriteString("for f in /etc/keepalived/keepalived.conf /etc/haproxy/haproxy.cfg; do [ -r \"$f\" ] && { echo \"# file: $f\"; grep -viE '^\\s*(#|\\s*$|.*pass|.*secret|.*auth_pass)' \"$f\" | head -n 35; }; done || true\n")
		}
	}

	sb.WriteString("\necho '=== MW_IMPORT_MIDDLEWARE ==='\n")
	switch compID {
	case "postgresql":
		if want["paths"] {
			sb.WriteString("# Locate PostgreSQL data dir, config file, log dir & Patroni YAML (read-only)\n")
			sb.WriteString("ps -ef 2>/dev/null | grep -iE 'postgres|patroni' | grep -v grep | head -n 12 || true\n")
			sb.WriteString("systemctl cat patroni patroni.service postgresql postgresql.service 2>/dev/null | grep -iE 'ExecStart|Environment|PGDATA' | head -n 15 || true\n")
			sb.WriteString("for f in /etc/patroni/patroni.yml /etc/patroni/patroni.yaml /etc/patroni.yml /etc/patroni.yaml; do [ -r \"$f\" ] && { echo \"# file: $f\"; grep -viE '^\\s*(#|\\s*$|.*pass|.*secret|.*token|.*key)' \"$f\" | head -n 45; }; done || true\n")
		}
		if want["params"] {
			sb.WriteString("# Core PostgreSQL runtime parameters (read-only SQL / config)\n")
			sb.WriteString("if command -v psql >/dev/null 2>&1; then\n")
			sb.WriteString("  sudo -n -u postgres psql -Atc \"SELECT name||'='||setting||COALESCE(' '||unit,'') FROM pg_settings WHERE name IN ('data_directory','config_file','hba_file','log_directory','max_connections','shared_buffers','effective_cache_size','work_mem','wal_level','archive_mode','archive_command','synchronous_commit','synchronous_standby_names','ssl') ORDER BY name;\" 2>/dev/null || true\n")
			sb.WriteString("fi\n")
		}
		if want["backup"] {
			sb.WriteString("# Backup & WAL archive status (read-only)\n")
			sb.WriteString("command -v pgbackrest >/dev/null 2>&1 && { pgbackrest version 2>/dev/null; sudo -n -u postgres pgbackrest info 2>/dev/null || pgbackrest info 2>/dev/null; } || true\n")
			sb.WriteString("for f in /etc/pgbackrest/pgbackrest.conf /etc/pgbackrest.conf; do [ -r \"$f\" ] && { echo \"# file: $f\"; grep -viE '^\\s*(#|\\s*$|.*pass|.*secret|.*key|.*token)' \"$f\" | head -n 30; }; done || true\n")
			sb.WriteString("ls -1 /etc/cron.d /var/spool/cron/crontabs 2>/dev/null | head -n 15 || true\n")
		}
		if want["peers"] {
			sb.WriteString("command -v patronictl >/dev/null 2>&1 && patronictl list 2>/dev/null || true\n")
			sb.WriteString("systemctl is-active patroni etcd postgresql 2>/dev/null || true\n")
			sb.WriteString("command -v etcdctl >/dev/null 2>&1 && etcdctl endpoint health 2>/dev/null || true\n")
		}
		if want["security"] {
			sb.WriteString("# TLS certificate expiry & sanitized pg_hba rules (read-only)\n")
			sb.WriteString("for c in /etc/patroni/*.crt /etc/etcd/*.crt /etc/ssl/certs/*postgres*.crt; do [ -r \"$c\" ] && { echo \"# cert: $c\"; openssl x509 -in \"$c\" -noout -subject -dates 2>/dev/null; }; done || true\n")
			sb.WriteString("for h in /etc/postgresql/*/*/pg_hba.conf /data/*/pg_hba.conf /var/lib/postgresql/*/*/pg_hba.conf; do [ -r \"$h\" ] && { echo \"# file: $h\"; grep -vE '^\\s*(#|$)' \"$h\" | head -n 25; }; done || true\n")
		}
	case "mysql", "mariadb":
		if want["paths"] || want["params"] {
			sb.WriteString("ps -ef 2>/dev/null | grep -iE 'mysqld|mariadbd' | grep -v grep | head -n 8 || true\n")
			sb.WriteString("for f in /etc/my.cnf /etc/mysql/my.cnf /etc/mysql/mysql.conf.d/mysqld.cnf; do [ -r \"$f\" ] && { echo \"# file: $f\"; grep -viE '^\\s*(#|;|\\s*$|.*pass|.*secret|.*key)' \"$f\" | head -n 45; }; done || true\n")
		}
		if want["backup"] {
			sb.WriteString("command -v xtrabackup >/dev/null 2>&1 && xtrabackup --version 2>&1 | head -n 2 || true\n")
			sb.WriteString("ls -1 /etc/cron.d 2>/dev/null | head -n 15 || true\n")
		}
		if want["security"] {
			sb.WriteString("for c in /etc/mysql/*.pem /var/lib/mysql/server-cert.pem; do [ -r \"$c\" ] && { echo \"# cert: $c\"; openssl x509 -in \"$c\" -noout -subject -dates 2>/dev/null; }; done || true\n")
		}
	case "redis", "valkey":
		if want["paths"] || want["params"] {
			sb.WriteString("ps -ef 2>/dev/null | grep -iE 'redis|valkey' | grep -v grep | head -n 10 || true\n")
			sb.WriteString("for f in /etc/redis/redis.conf /etc/redis.conf /etc/redis/sentinel.conf; do [ -r \"$f\" ] && { echo \"# file: $f\"; grep -viE '^\\s*(#|\\s*$|.*pass|.*auth|.*secret)' \"$f\" | head -n 45; }; done || true\n")
		}
	default:
		if strings.TrimSpace(preset.ProbeSnippet) != "" {
			sb.WriteString(strings.TrimSpace(preset.ProbeSnippet) + "\n")
		} else {
			sb.WriteString(fmt.Sprintf("systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE '%s' || true\n", regexp.QuoteMeta(compID)))
			sb.WriteString(fmt.Sprintf("ps -ef 2>/dev/null | grep -iE '%s' | grep -v grep | head -n 15 || true\n", regexp.QuoteMeta(compID)))
		}
	}

	if want["monitoring"] || want["peers"] {
		sb.WriteString("\necho '=== MW_IMPORT_COMPANIONS ==='\n")
		sb.WriteString("systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'patroni|etcd|haproxy|keepalived|pgbouncer|sentinel|[a-z0-9_-]*exporter' || true\n")
		if want["monitoring"] {
			sb.WriteString("for exp in node_exporter process_exporter postgres_exporter mysqld_exporter redis_exporter haproxy_exporter; do command -v \"$exp\" >/dev/null 2>&1 && \"$exp\" --version 2>&1 | head -n 2; done || true\n")
		}
	}

	if want["packages"] {
		pkgMatch := firstNonEmptyStr(preset.PkgMatch, regexp.QuoteMeta(compID))
		fullPkgMatch := pkgMatch + "|patroni|etcd|haproxy|keepalived|pgbackrest|pgbouncer|sentinel|exporter"
		sb.WriteString("\necho '=== MW_IMPORT_OS ==='\n")
		sb.WriteString("[ -r /etc/os-release ] && grep -E '^(ID|VERSION_ID|PRETTY_NAME)=' /etc/os-release || uname -a\n")
		sb.WriteString("\necho '=== MW_IMPORT_PACKAGES ==='\n")
		sb.WriteString("if command -v dpkg-query >/dev/null 2>&1; then\n")
		sb.WriteString(fmt.Sprintf("  dpkg-query -W -f='${Package}\\t${Version}\\n' 2>/dev/null | grep -iE '%s' | sort -u | head -n 80 || true\n", fullPkgMatch))
		sb.WriteString("elif command -v rpm >/dev/null 2>&1; then\n")
		sb.WriteString(fmt.Sprintf("  rpm -qa --qf '%%{NAME}\\t%%{VERSION}-%%{RELEASE}\\n' 2>/dev/null | grep -iE '%s' | sort -u | head -n 80 || true\n", fullPkgMatch))
		sb.WriteString("fi\n")
	}

	sb.WriteString("echo '=== MW_IMPORT_END ==='\n")
	filename := fmt.Sprintf("mw-gap-probe-%s.sh", compID)
	runHint := tr(lang, "建议在主节点执行（预计耗时 2~3 秒），复制回显粘贴至下方即可自动增量合并基线", "Run on primary node (~2-3s) and paste output below for incremental baseline merge")
	if want["peers"] && existing != nil && len(existing.Hosts) > 1 {
		runHint = tr(lang, "建议在主节点及待核验备节点分别执行，可直接拼接多台节点回显一并粘贴", "Run on primary and unverified peer nodes; paste combined outputs below")
	}
	return sb.String(), filename, covered, runHint
}

func (s *storeServer) loadImportedBaselineReq(user, clusterID, lang string) (*importClusterReq, bool) {
	f, ok := s.clusterFactsFor(user, clusterID)
	if !ok {
		return nil, false
	}
	dep := s.readSpec(f.Current.ID)
	if dep == nil || dep.DeliveryMode != "imported" {
		return nil, false
	}
	meta := dep.Imported
	if meta == nil {
		meta = &mwpack.ImportedMeta{}
	}
	var hosts []importHostInput
	roleByHost := map[string]string{}
	compID := f.Current.AppID
	ver := f.Current.Version
	var params map[string]any
	if len(dep.Instances) > 0 {
		inst := dep.Instances[0]
		compID = inst.Component
		ver = inst.Version
		params = inst.Params
		for rk, hs := range inst.Placement {
			for _, hn := range hs {
				roleByHost[hn] = rk
			}
		}
	}
	for _, h := range dep.Hosts {
		hosts = append(hosts, importHostInput{
			Name: h.Name,
			IP:   h.IP,
			Role: firstNonEmptyStr(roleByHost[h.Name], "node"),
			Disk: h.Disk,
		})
	}
	normEps := make([]mwpack.ImportedEndpoint, len(meta.Endpoints))
	for i, ep := range meta.Endpoints {
		ep.Role = normalizeImportEndpointRole(ep.Role)
		normEps[i] = ep
	}
	companions := make([]mwpack.ImportedCompanion, len(meta.Companions))
	copy(companions, meta.Companions)
	req := &importClusterReq{
		ID:           dep.ID,
		Title:        dep.Title,
		Component:    compID,
		DisplayName:  firstNonEmptyStr(meta.DisplayName, f.Current.AppName),
		Category:     meta.Category,
		Icon:         meta.Icon,
		Color:        meta.Color,
		Version:      ver,
		ExactVersion: meta.ExactVersion,
		Platform:     dep.Platform,
		OSDetail:     meta.OSDetail,
		SourceKind:   meta.SourceKind,
		DeployMethod: meta.DeployMethod,
		ArchSummary:  meta.ArchSummary,
		Hosts:        hosts,
		Endpoints:    normEps,
		Companions:   companions,
		ServiceUnits: meta.ServiceUnits,
		ConfigPaths:  meta.ConfigPaths,
		DataDirs:     meta.DataDirs,
		LogDirs:      meta.LogDirs,
		Params:       params,
		Packages:     meta.Packages,
		Notes:        meta.Notes,
		LastProbedAt: meta.LastProbedAt,
	}
	h := analyzeImportedBaselineHealth(compID, req.DisplayName, *req, lang)
	req.Health = &h
	return req, true
}

func (s *storeServer) importProbeScriptHandler(w http.ResponseWriter, r *http.Request, session storeSession) {
	var req importProbeScriptReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		s.fail(w, 400, "请求参数无法解析")
		return
	}
	lang := wLang(w)

	var existing *importClusterReq
	var selectedGaps []baselineGap
	if strings.TrimSpace(req.ClusterID) != "" {
		if ex, ok := s.loadImportedBaselineReq(session.User, strings.TrimSpace(req.ClusterID), lang); ok {
			existing = ex
			if req.Component == "" {
				req.Component = ex.Component
			}
			if req.DisplayName == "" {
				req.DisplayName = ex.DisplayName
			}
			if req.DeployMethod == "" {
				req.DeployMethod = ex.DeployMethod
			}
			if len(req.ServiceUnits) == 0 {
				req.ServiceUnits = ex.ServiceUnits
			}
			if len(req.ConfigPaths) == 0 {
				req.ConfigPaths = ex.ConfigPaths
			}
			if ex.Health != nil {
				wantID := map[string]bool{}
				for _, g := range req.MissingGaps {
					wantID[strings.ToLower(strings.TrimSpace(g))] = true
				}
				for _, g := range ex.Health.Gaps {
					if len(wantID) == 0 {
						if g.Selected {
							selectedGaps = append(selectedGaps, g)
						}
					} else if wantID[g.ID] || wantID[strings.ToLower(g.Title)] {
						selectedGaps = append(selectedGaps, g)
					}
				}
			}
		}
	}

	for _, cg := range req.CustomGaps {
		if strings.TrimSpace(cg.Title) == "" {
			continue
		}
		dup := false
		for _, sg := range selectedGaps {
			if sg.ID == cg.ID || strings.EqualFold(strings.TrimSpace(sg.Title), strings.TrimSpace(cg.Title)) {
				dup = true
				break
			}
		}
		if !dup {
			selectedGaps = append(selectedGaps, cg)
		}
	}

	effMode := strings.ToLower(strings.TrimSpace(req.Mode))
	if effMode == "" {
		if len(req.MissingGaps) > 0 || len(req.CustomGaps) > 0 || (existing != nil && len(selectedGaps) > 0) {
			effMode = "gap"
		} else {
			effMode = "full"
		}
	}

	var baseScript, filename, runHint string
	var covered []string
	if effMode == "gap" && (len(selectedGaps) > 0 || len(req.MissingGaps) > 0 || len(req.CustomGaps) > 0) {
		baseScript, filename, covered, runHint = buildGapReadOnlyProbeScript(req, existing, selectedGaps, lang)
	} else {
		effMode = "full"
		baseScript, filename = buildImportProbeScript(req, lang)
		runHint = tr(lang, "在目标集群节点执行后复制完整回显，粘贴至下方即可识别全部组件与路径", "Run on target node(s) and paste output below to extract full topology & paths")
	}

	script := baseScript
	source := "template"
	aiNote := ""
	usedModel := ""
	var trace *rehearsalTrace
	ev := startRehearsalSSE(w, r)

	if req.UseAI {
		if !s.aiStatusFor(session.User).Enabled {
			aiNote = tr(lang, "未开启 AI 助手，已自动使用 100% 静态只读标准探针", "AI is disabled; using 100% static read-only probe")
		} else {
			st := s.aiLoad()
			providers := s.aiProvidersForUser(st, session.User, "assistant", req.Model)
			if len(providers) == 0 {
				providers = s.aiProvidersForUser(st, session.User, "change_rehearsal", req.Model)
			}
			if len(providers) > 0 && (st.MonthlyLimit <= 0 || s.aiCallsThisMonth(session.User) < st.MonthlyLimit) {
				aiScript, aiTrace, status, aiErr := s.aiBuildImportProbeScript(r, providers, session.User, req, existing, selectedGaps, effMode, baseScript, lang, ev)
				if aiErr == nil && strings.TrimSpace(aiScript) != "" {
					guardStart := time.Now()
					aiSafe, aiWarns := validateReadOnlyProbeScriptLang(aiScript, lang)
					guardMS := max(1, time.Since(guardStart).Milliseconds())
					if aiSafe && len(aiWarns) == 0 {
						script = aiScript
						source = "ai"
						usedModel = aiTrace.Model
						finalizeTraceSynth(&aiTrace, ev, "readonly-ast-guard", tr(lang, fmt.Sprintf("静态安全门禁通过（%d 行 · 100%% 纯只读零写操作）", strings.Count(aiScript, "\n")), fmt.Sprintf("Static read-only gate passed (%d lines · zero mutations)", strings.Count(aiScript, "\n"))), true, guardMS)
						trace = &aiTrace
					} else {
						aiNote = tr(lang, "AI 生成脚本未通过 100% 静态只读安全门禁，已自动回退已校验的安全只读探针", "AI-generated script failed static read-only gate; fell back to verified read-only probe")
						finalizeTraceSynth(&aiTrace, ev, "readonly-ast-guard", aiNote, false, guardMS)
						trace = &aiTrace
					}
				} else if aiErr != nil {
					if ev != nil {
						failRehearsalResp(s, w, ev, status, aiErr.Error(), aiTrace.Diag)
						return
					}
					aiNote = tr(lang, "AI 定制探针暂不可用，已回退已校验的安全只读探针："+aiErr.Error(), "AI probe customization unavailable; fell back to verified read-only probe: "+aiErr.Error())
				}
			} else {
				aiNote = tr(lang, "暂无可用 AI 模型或已达月额度，已使用已校验的安全只读探针", "No AI model available or quota reached; using verified read-only probe")
			}
		}
	}

	safe, warns := validateReadOnlyProbeScriptLang(script, lang)
	payload := map[string]any{
		"script":       script,
		"filename":     filename,
		"safe":         safe,
		"warnings":     nz(warns),
		"source":       source,
		"mode":         effMode,
		"covered_gaps": nz(covered),
		"run_hint":     runHint,
		"model":        usedModel,
		"ai_note":      aiNote,
	}
	if trace != nil {
		payload["trace"] = trace
	}
	finishImportStreamResp(w, ev, payload)
}

func finishImportStreamResp(w http.ResponseWriter, ev *sse, payload map[string]any) {
	if ev != nil {
		ev.send(map[string]any{"t": "done", "result": payload})
		return
	}
	sWriteJSON(w, 200, payload)
}

func parseImportDraftStreamMetaLang(raw, lang string) (thinking string, phase string) {
	thinking, _ = extractLiveJSONThinking(raw)
	switch {
	case strings.Contains(raw, `"notes"`):
		phase = tr(lang, "正在收敛现场线索与待人工核对清单…", "Summarizing live evidence & review checklist...")
	case strings.Contains(raw, `"packages"`):
		phase = tr(lang, "正在整理已识别软件包与版本信息…", "Cataloging detected packages & versions...")
	case strings.Contains(raw, `"params"`):
		phase = tr(lang, "正在提取关键中间件运行参数与路径…", "Extracting key middleware runtime params & paths...")
	case strings.Contains(raw, `"companions"`):
		phase = tr(lang, "正在识别 Patroni / etcd / 代理等伴生架构组件栈…", "Detecting companion HA stack (Patroni / etcd / proxy / exporters)...")
	case strings.Contains(raw, `"endpoints"`):
		phase = tr(lang, "正在整理集群读写与管理访问入口…", "Mapping cluster read-write & admin endpoints...")
	case strings.Contains(raw, `"hosts"`):
		phase = tr(lang, "正在提取主机节点、角色与数据盘拓扑…", "Extracting hosts, roles & data disk layout...")
	}
	return thinking, phase
}

func parseImportProbeStreamMetaLang(raw, lang string) (thinking string, phase string) {
	thinking, _ = extractLiveJSONThinking(raw)
	switch {
	case strings.Contains(raw, "=== MW_IMPORT_END ==="):
		phase = tr(lang, "探针脚本正文编写完成，即将执行静态只读安全扫描…", "Probe script drafted; preparing static read-only security scan...")
	case strings.Contains(raw, "=== MW_IMPORT_COMPANIONS ===") || strings.Contains(raw, "=== MW_IMPORT_PORTS ==="):
		phase = tr(lang, "正在编写伴生组件栈与监听端口只读探测段…", "Writing companion stack & listening port probes...")
	case strings.Contains(raw, "=== MW_IMPORT_MIDDLEWARE ==="):
		phase = tr(lang, "正在编写主中间件配置与版本只读探测段…", "Writing primary middleware version & config probes...")
	case strings.Contains(raw, "=== MW_IMPORT_BEGIN ===") || strings.Contains(raw, "#!/usr/bin/env bash"):
		phase = tr(lang, "正在编写 100% 纯只读现场采集 Bash 脚本…", "Writing 100% read-only Bash discovery probe script...")
	}
	return thinking, phase
}

func parseImportGapStreamMetaLang(raw, lang string) (thinking string, phase string) {
	thinking, _ = extractLiveJSONThinking(raw)
	switch {
	case strings.Contains(raw, `"gaps"`):
		phase = tr(lang, "正在收敛固定规则之外的高价值补采项与只读探测动作…", "Compiling high-value blind spots & read-only probe actions...")
	case strings.Contains(raw, `"summary"`):
		phase = tr(lang, "正在总结当前集群基线完整度与风险评估…", "Summarizing baseline completeness & operational risks...")
	}
	return thinking, phase
}

func extractProbeScriptOutput(raw string) (string, error) {
	out := strings.TrimSpace(raw)
	if strings.HasPrefix(out, "```") {
		if nl := strings.IndexByte(out, '\n'); nl > 0 {
			out = out[nl+1:]
		}
		out = strings.TrimSuffix(strings.TrimSpace(out), "```")
		out = strings.TrimSpace(out)
	}
	if !strings.HasPrefix(out, "#!") || !strings.Contains(out, "=== MW_IMPORT_BEGIN ===") {
		return "", fmt.Errorf("AI 返回脚本缺少标准探针结构")
	}
	return out + "\n", nil
}

func (s *storeServer) aiBuildImportProbeScript(
	r *http.Request,
	providers []aiProvider,
	user string,
	req importProbeScriptReq,
	existing *importClusterReq,
	selectedGaps []baselineGap,
	mode, baseScript, lang string,
	ev *sse,
) (string, rehearsalTrace, int, error) {
	prepStart := time.Now()
	compID := mwpack.NormalizeImportComponentID(firstNonEmptyStr(req.Component, req.DisplayName))
	displayName := firstNonEmptyStr(strings.TrimSpace(req.DisplayName), compID)
	sys := `你是一位企业级中间件与 Linux 基础设施运维专家，负责编写一份极简、克制、100% 静态只读的 Bash 采集探针脚本。

最高铁律（违反任何一条脚本都会被安全门禁直接拦截）：
1. 【100% 绝对只读与零副作用】严禁任何写入、修改、创建/删除文件、输出重定向写入文件（只允许 2>/dev/null 或 >/dev/null）、服务启停/重载（systemctl start/stop/restart/reload）、交互式切用户（严禁 su -，仅允许 sudo -n -u ... 执行只读查询）、修改参数或写 SQL（严禁 INSERT/UPDATE/DELETE/ALTER/DROP）。
2. 【凭据与密钥强制脱敏】读取任何配置文件或环境变量时，必须用 grep -viE 过滤 pass/secret/token/key/auth/pwd 行，严禁输出口令或私钥明文。
3. 【精准补采、严禁冗余】若是缺口补采模式，只针对缺失项精准探测（脚本控制在 30~70 行、单机 2~3 秒执行完毕），不要重复大段采集已知信息，也不要堆砌全量 sysctl 或大文件 cat。
4. 【保留标准分段标记】必须以 #!/usr/bin/env bash 开头，并包含 === MW_IMPORT_BEGIN ===、=== MW_IMPORT_HOST ===、=== MW_IMPORT_MIDDLEWARE === 及 === MW_IMPORT_END ===（按需保留 PORTS / COMPANIONS / PACKAGES 段）。
5. 只输出纯 Bash 脚本正文，不要输出 Markdown 代码围栏或任何额外解释文字。`

	var prompt strings.Builder
	fmt.Fprintf(&prompt, "目标主中间件：%s (%s)\n部署形态：%s\n采集模式：%s\n", displayName, compID, firstNonEmptyStr(req.DeployMethod, "systemd"), mode)
	if existing != nil {
		var hNames []string
		for _, h := range existing.Hosts {
			hNames = append(hNames, fmt.Sprintf("%s(%s/%s)", h.Name, h.IP, h.Role))
		}
		var compNames []string
		for _, cm := range existing.Companions {
			compNames = append(compNames, firstNonEmptyStr(cm.DisplayName, cm.Component)+" "+cm.Version)
		}
		fmt.Fprintf(&prompt, "\n当前集群已有基线摘要（无需重复冗余采集）：\n- 集群：%s | 精确版本：%s | OS：%s\n- 节点：%s\n- 伴生组件：%s\n- 已知服务：%s\n- 已知配置路径：%s\n- 已知数据目录：%s\n- 已知日志目录：%s\n",
			existing.ID, firstNonEmptyStr(existing.ExactVersion, existing.Version), firstNonEmptyStr(existing.OSDetail, existing.Platform),
			strings.Join(hNames, ", "),
			strings.Join(compNames, ", "),
			strings.Join(existing.ServiceUnits, ", "),
			strings.Join(existing.ConfigPaths, ", "),
			strings.Join(existing.DataDirs, ", "),
			strings.Join(existing.LogDirs, ", "),
		)
	} else {
		if len(req.ServiceUnits) > 0 {
			fmt.Fprintf(&prompt, "已知服务单元线索：%s\n", strings.Join(req.ServiceUnits, ", "))
		}
		if len(req.ConfigPaths) > 0 {
			fmt.Fprintf(&prompt, "已知配置文件线索：%s\n", strings.Join(req.ConfigPaths, ", "))
		}
	}
	if len(selectedGaps) > 0 {
		prompt.WriteString("\n本次对照标准基线需重点补采的缺口项（请逐一用精炼 100% 只读命令覆盖）：\n")
		for _, g := range selectedGaps {
			fmt.Fprintf(&prompt, "- [%s] %s：%s（建议动作：%s）\n", g.Category, g.Title, g.Detail, g.ProbeAction)
		}
	}
	if strings.TrimSpace(req.Focus) != "" {
		fmt.Fprintf(&prompt, "\n工程师额外补充的关注重点：%s\n", truncRunes(strings.TrimSpace(req.Focus), 600))
	}
	prompt.WriteString("\n参考安全基线骨架（请在此基础上按上述缺口精准优化，保持极简与 100% 只读）：\n")
	prompt.WriteString(baseScript)

	prepMS := max(1, time.Since(prepStart).Milliseconds())
	scopeDetail := tr(lang,
		fmt.Sprintf("已装载 %s (%s) 基线上下文%s", displayName, firstNonEmptyStr(req.DeployMethod, "systemd"), func() string {
			if len(selectedGaps) > 0 {
				return fmt.Sprintf(" · 聚焦 %d 项待补采缺口", len(selectedGaps))
			}
			return ""
		}()),
		fmt.Sprintf("Loaded %s (%s) context%s", displayName, firstNonEmptyStr(req.DeployMethod, "systemd"), func() string {
			if len(selectedGaps) > 0 {
				return fmt.Sprintf(" · targeting %d baseline gap(s)", len(selectedGaps))
			}
			return ""
		}()),
	)
	spec := rehearsalPipelineSpec{
		Feature: "import_probe_gen",
		PreSteps: []rehearsalTraceStep{
			{
				ID:     "inspect-baseline",
				Kind:   "inspect",
				Title:  tr(lang, "读取集群基线与采集目标", "Inspect Baseline & Probe Targets"),
				Detail: scopeDetail,
				MS:     prepMS,
				OK:     true,
				Status: "done",
			},
			{
				ID:     "inject-ro-policy",
				Kind:   "guard",
				Title:  tr(lang, "注入 100% 纯只读安全红线规则", "Inject 100% Read-Only Safety Guardrails"),
				Detail: tr(lang, "已锁定零写操作、零服务重启、零文件重定向与凭据脱敏约束", "Locked zero-write, zero-restart, zero-redirect & credential redaction rules"),
				MS:     1,
				OK:     true,
				Status: "done",
			},
		},
		ThinkTitle:     tr(lang, "设计精炼只读现场采集策略", "Design Lean Read-Only Probe Strategy"),
		ThinkWait:      tr(lang, "正在结合组件形态与补采重点编排 100% 只读探测策略…", "Designing targeted 100% read-only probe strategy..."),
		ThinkDone:      tr(lang, "已完成精炼只读采集策略规划", "Completed lean read-only probe strategy"),
		SynthID:        "readonly-ast-guard",
		SynthKind:      "guard",
		SynthTitle:     tr(lang, "生成探针脚本与静态安全门禁校验", "Generate Probe & Static Read-Only Gate"),
		SynthWait:      tr(lang, "等待脚本编写完成后执行静态只读安全扫描", "Waiting for script output before static read-only verification"),
		PhaseExtractor: parseImportProbeStreamMetaLang,
		Validate: func(txt string) error {
			_, err := extractProbeScriptOutput(txt)
			return err
		},
	}

	txt, trace, status, err := s.rehearsalRunAI(
		r,
		providers,
		user,
		firstNonEmptyStr(req.ClusterID, compID),
		"import-probe",
		"probe",
		nil,
		sys,
		prompt.String(),
		nil,
		spec,
		thinkLevel(strings.TrimSpace(req.Think)),
		ev,
	)
	if err != nil {
		return "", trace, status, err
	}
	out, err := extractProbeScriptOutput(txt)
	if err != nil {
		return "", trace, 502, err
	}
	return out, trace, 200, nil
}

// importDiagnoseGapsHandler combines deterministic standard-baseline checks with deep AI discovery
// so subtle, cluster-specific missing operational facts (not covered by static rules) are surfaced
// and paired with strictly 100% read-only verification actions.
func (s *storeServer) importDiagnoseGapsHandler(w http.ResponseWriter, r *http.Request, session storeSession) {
	var req struct {
		ClusterID string `json:"cluster_id"`
		Focus     string `json:"focus,omitempty"`
		Model     string `json:"model,omitempty"`
		Think     string `json:"think,omitempty"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 256<<10)).Decode(&req); err != nil || strings.TrimSpace(req.ClusterID) == "" {
		s.fail(w, 400, "缺少有效的集群标识")
		return
	}
	lang := wLang(w)
	cid := strings.TrimSpace(req.ClusterID)
	existing, ok := s.loadImportedBaselineReq(session.User, cid, lang)
	if !ok || existing == nil || existing.Health == nil {
		s.fail(w, 404, "未找到该存量纳管集群基线")
		return
	}
	ev := startRehearsalSSE(w, r)
	baseHealth := *existing.Health
	if !s.aiStatusFor(session.User).Enabled {
		finishImportStreamResp(w, ev, map[string]any{
			"health":  baseHealth,
			"ai_used": false,
			"ai_note": tr(lang, "AI 助手未开启，当前展示标准规则基线检查结果", "AI is disabled; showing deterministic baseline checks"),
		})
		return
	}
	st := s.aiLoad()
	providers := s.aiProvidersForUser(st, session.User, "assistant", req.Model)
	if len(providers) == 0 {
		providers = s.aiProvidersForUser(st, session.User, "change_rehearsal", req.Model)
	}
	if len(providers) == 0 || (st.MonthlyLimit > 0 && s.aiCallsThisMonth(session.User) >= st.MonthlyLimit) {
		finishImportStreamResp(w, ev, map[string]any{
			"health":  baseHealth,
			"ai_used": false,
			"ai_note": tr(lang, "暂无可用 AI 模型或已达月额度，当前保留规则基线检查结果", "No AI model available or quota reached; keeping rule-based checks"),
		})
		return
	}

	prepStart := time.Now()
	sys := `你是一位拥有 15 年生产交付与应急排障经验的企业级中间件架构师。
你的任务是审阅该存量纳管集群当前的真实基线档案、已落地变更记录与安全态势，找出「固定规则尚未覆盖、但对后续生产变更演练、高可用切换、故障排障与交付验收至关重要的遗漏信息」。

严格规则：
1. 【只补充固定规则没覆盖的深度缺口】下方会列出固定规则已经检出的缺口，禁止重复输出相同内容；请聚焦该集群架构独有的高价值盲区（例如：Patroni DCS TTL/loop_wait/复制槽与 WAL 保留策略、备库 clonefrom 标签或同步模式细节、连接池/连接数水位、日志轮转与保留清理策略、数据盘/WAL 挂载独立性与 inode 水位、etcd 压缩与存储配额、内核 HugePages/swappiness/ulimit 等）。
2. 【100% 只读核验铁律】每条建议的 probe_action 必须是 100% 静态只读、零副作用、可安全在生产执行的只读检查动作（严禁建议修改参数、重启服务、写入文件或测试破坏性切换）。
3. 数量克制精准：最多输出 2~4 条真正有含金量的缺口，不要凑数。
4. 只输出严格 JSON，不要 Markdown 围栏或多余文字；请将 "thinking" 放在第一个字段用于流式展示研判思路：
{"thinking":"2~3条简洁研判要点（以 1. / 2. / 3. 开头，简述当前基线已覆盖事实、该架构特有运维盲区及补采价值）","summary":"1句面向工程师的整体基线评估结论（中文，简练直接）","gaps":[{"category":"4字以内分类如 复制机制/容量水位/日志治理/高可用参数","severity":"high|medium|low","title":"简明缺口标题（22字以内）","detail":"1句说明为什么后续变更演练或排障需要这项信息","probe_action":"1句具体的只读探测核验动作（100% 只读）"}]}`

	var prompt strings.Builder
	fmt.Fprintf(&prompt, "集群：%s（%s %s，精确版本：%s，OS：%s，部署形态：%s）\n",
		existing.ID, existing.DisplayName, existing.Version, firstNonEmptyStr(existing.ExactVersion, existing.Version),
		firstNonEmptyStr(existing.OSDetail, existing.Platform), firstNonEmptyStr(existing.DeployMethod, "systemd"))
	if existing.ArchSummary != "" {
		fmt.Fprintf(&prompt, "架构摘要：%s\n", existing.ArchSummary)
	}
	if len(existing.Hosts) > 0 {
		var hs []string
		for _, h := range existing.Hosts {
			hs = append(hs, fmt.Sprintf("%s(%s/%s/disk=%s)", h.Name, h.IP, h.Role, firstNonEmptyStr(h.Disk, "未知")))
		}
		fmt.Fprintf(&prompt, "节点清单：%s\n", strings.Join(hs, "; "))
	}
	if len(existing.Endpoints) > 0 {
		var eps []string
		for _, ep := range existing.Endpoints {
			eps = append(eps, fmt.Sprintf("%s:%s(%s)", ep.Name, ep.Address, ep.Role))
		}
		fmt.Fprintf(&prompt, "访问入口：%s\n", strings.Join(eps, "; "))
	}
	if len(existing.Companions) > 0 {
		var cms []string
		for _, cm := range existing.Companions {
			cms = append(cms, fmt.Sprintf("%s %s(%s)", firstNonEmptyStr(cm.DisplayName, cm.Component), cm.Version, cm.Kind))
		}
		fmt.Fprintf(&prompt, "伴生组件栈：%s\n", strings.Join(cms, "; "))
	}
	fmt.Fprintf(&prompt, "配置路径：%s\n数据目录：%s\n日志目录：%s\n",
		firstNonEmptyStr(strings.Join(existing.ConfigPaths, ", "), "无"),
		firstNonEmptyStr(strings.Join(existing.DataDirs, ", "), "无"),
		firstNonEmptyStr(strings.Join(existing.LogDirs, ", "), "无"))
	if len(existing.Params) > 0 {
		pb, _ := json.Marshal(existing.Params)
		fmt.Fprintf(&prompt, "已采集运行参数：%s\n", truncRunes(aiScrub(string(pb)), 1200))
	}
	if strings.TrimSpace(existing.Notes) != "" {
		fmt.Fprintf(&prompt, "当前已记录现场线索：\n%s\n", truncRunes(aiScrub(existing.Notes), 2000))
	}
	if hist := strings.TrimSpace(s.clusterHistoryText(cid)); hist != "" {
		fmt.Fprintf(&prompt, "\n近期变更与台账上下文：\n%s\n", truncRunes(aiScrub(hist), 2500))
	}
	if f, fok := s.clusterFactsFor(session.User, cid); fok {
		prompt.WriteString(s.clusterSecurityFactsSummary(session.User, f))
	}
	if len(baseHealth.Gaps) > 0 {
		prompt.WriteString("\n固定规则已经检出的缺口（请勿重复，仅补充更有针对性的遗漏项）：\n")
		for _, g := range baseHealth.Gaps {
			fmt.Fprintf(&prompt, "- [%s] %s\n", g.Category, g.Title)
		}
	}
	if strings.TrimSpace(req.Focus) != "" {
		fmt.Fprintf(&prompt, "\n工程师特别关注方向：%s\n", truncRunes(strings.TrimSpace(req.Focus), 500))
	}

	prepMS := max(1, time.Since(prepStart).Milliseconds())
	var parsed struct {
		Summary string        `json:"summary"`
		Gaps    []baselineGap `json:"gaps"`
	}
	spec := rehearsalPipelineSpec{
		Feature: "import_gap_diagnose",
		PreSteps: []rehearsalTraceStep{
			{
				ID:     "scan-baseline",
				Kind:   "inspect",
				Title:  tr(lang, "通读集群基线、架构栈与变更台账", "Read Baseline, Stack & History"),
				Detail: tr(lang, fmt.Sprintf("已加载 %d 台节点 · %d 个伴生组件 · %d 项规则初检缺口", len(existing.Hosts), len(existing.Companions), len(baseHealth.Gaps)), fmt.Sprintf("Loaded %d host(s) · %d companion(s) · %d rule gap(s)", len(existing.Hosts), len(existing.Companions), len(baseHealth.Gaps))),
				MS:     prepMS,
				OK:     true,
				Status: "done",
			},
			{
				ID:     "redact-context",
				Kind:   "guard",
				Title:  tr(lang, "敏感凭据自动脱敏与只读核验锁定", "Scrub Credentials & Lock Read-Only"),
				Detail: tr(lang, "已清除配置与台账中的凭据片段，仅允许输出 100% 只读核验项", "Scrubbed secrets from baseline context; enforcing 100% read-only checks"),
				MS:     1,
				OK:     true,
				Status: "done",
			},
		},
		ThinkTitle:     tr(lang, "研判固定规则之外的架构盲区", "Identify Architecture-Specific Blind Spots"),
		ThinkWait:      tr(lang, "正在对照生产高可用、备份与演练标准定位专属遗漏项…", "Comparing baseline against HA, backup & rehearsal standards..."),
		ThinkDone:      tr(lang, "已完成基线盲区深度研判", "Completed baseline blind-spot analysis"),
		SynthID:        "synth-gaps",
		SynthKind:      "synthesize",
		SynthTitle:     tr(lang, "收敛只读补采清单与优先级", "Compile Read-Only Gap Checklist"),
		SynthWait:      tr(lang, "等待盲区研判完成后生成只读补采建议", "Waiting for analysis before compiling read-only gaps"),
		PhaseExtractor: parseImportGapStreamMetaLang,
		Validate: func(txt string) error {
			raw := extractJSON(txt)
			if raw == "" {
				return fmt.Errorf("AI 未返回有效 JSON")
			}
			var tmp struct {
				Summary string        `json:"summary"`
				Gaps    []baselineGap `json:"gaps"`
			}
			if err := json.Unmarshal([]byte(raw), &tmp); err != nil {
				return fmt.Errorf("AI 返回格式解析失败: %v", err)
			}
			return nil
		},
	}

	txt, trace, status, err := s.rehearsalRunAI(
		r,
		providers,
		session.User,
		cid,
		"import-gap-diagnose",
		"diagnose",
		nil,
		sys,
		prompt.String(),
		nil,
		spec,
		thinkLevel(strings.TrimSpace(req.Think)),
		ev,
	)
	if err != nil {
		if ev != nil {
			failRehearsalResp(s, w, ev, status, err.Error(), trace.Diag)
			return
		}
		s.writeJSON(w, 200, map[string]any{
			"health":  baseHealth,
			"ai_used": false,
			"ai_note": tr(lang, "AI 深度诊断暂不可用，已保留规则初检结果："+err.Error(), "AI gap discovery unavailable: "+err.Error()),
		})
		return
	}

	raw := extractJSON(txt)
	if raw == "" || json.Unmarshal([]byte(raw), &parsed) != nil {
		if ev != nil {
			failRehearsalResp(s, w, ev, 502, tr(lang, "AI 返回格式异常，未能解析深度诊断结果", "AI output could not be parsed"), trace.Diag)
			return
		}
		s.writeJSON(w, 200, map[string]any{
			"health":  baseHealth,
			"ai_used": false,
			"ai_note": tr(lang, "AI 返回格式异常，已保留规则初检结果", "AI output could not be parsed; keeping rule-based results"),
		})
		return
	}

	seenTitles := map[string]bool{}
	for _, g := range baseHealth.Gaps {
		seenTitles[strings.ToLower(strings.TrimSpace(g.Title))] = true
	}
	added := 0
	for i, ag := range parsed.Gaps {
		if added >= 4 {
			break
		}
		ag.Title = truncRunes(strings.TrimSpace(ag.Title), 60)
		ag.Detail = truncRunes(strings.TrimSpace(ag.Detail), 200)
		ag.ProbeAction = truncRunes(strings.TrimSpace(ag.ProbeAction), 240)
		ag.Category = truncRunes(firstNonEmptyStr(strings.TrimSpace(ag.Category), tr(lang, "AI 洞察", "AI Insight")), 24)
		if ag.Title == "" || seenTitles[strings.ToLower(ag.Title)] {
			continue
		}
		seenTitles[strings.ToLower(ag.Title)] = true
		switch strings.ToLower(strings.TrimSpace(ag.Severity)) {
		case "high", "critical":
			ag.Severity = "high"
		case "low":
			ag.Severity = "low"
		default:
			ag.Severity = "medium"
		}
		ag.ID = fmt.Sprintf("ai-%d-%s", i+1, randomStoreToken(3))
		ag.Source = "ai"
		ag.Selected = ag.Severity != "low"
		baseHealth.Gaps = append(baseHealth.Gaps, ag)
		added++
	}
	if strings.TrimSpace(parsed.Summary) != "" {
		baseHealth.Summary = truncRunes(strings.TrimSpace(parsed.Summary), 220)
	}
	finalizeTraceSynth(&trace, ev, "synth-gaps", tr(lang, fmt.Sprintf("已完成基线深度诊断，新增 %d 项架构专属只读补采项", added), fmt.Sprintf("Completed deep diagnosis; discovered %d new read-only gap(s)", added)), true, 0)
	s.auditReq(r, "cluster-baseline-ai-gaps", session.User, fmt.Sprintf("%s added=%d model=%s", cid, added, trace.Model))
	finishImportStreamResp(w, ev, map[string]any{
		"health":   baseHealth,
		"ai_used":  true,
		"ai_added": added,
		"model":    trace.Model,
		"trace":    trace,
	})
}

func (s *storeServer) importParseHandler(w http.ResponseWriter, r *http.Request, session storeSession) {
	var req importParseReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 128<<20)).Decode(&req); err != nil {
		s.fail(w, 400, "请求内容无法解析或超出大小限制")
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" && len(req.Images) == 0 {
		s.fail(w, 400, "请先粘贴采集脚本输出、CMDB/配置文本，或上传架构/终端截图")
		return
	}
	for _, img := range req.Images {
		if !reDataImage.MatchString(img) || len(img) > 6<<20 {
			s.fail(w, 400, "截图格式需为 png、jpg、gif 或 webp，且单张不超过 4 MiB")
			return
		}
	}

	lang := wLang(w)
	ev := startRehearsalSSE(w, r)
	detStart := time.Now()
	preset, _ := mwpack.LookupImportPreset(req.Component)
	det := parseImportedDeterministic(text, req.Component, req.DisplayName, preset)
	detMS := max(1, time.Since(detStart).Milliseconds())

	wantAI := true
	if req.UseAI != nil {
		wantAI = *req.UseAI
	}

	aiUsed := false
	parserMode := "deterministic"
	var warns []string
	draft := det
	var trace *rehearsalTrace

	if wantAI && s.aiStatusFor(session.User).Enabled {
		st := s.aiLoad()
		providers := s.aiProvidersForUser(st, session.User, "assistant", req.Model)
		if len(providers) == 0 {
			providers = s.aiProvidersForUser(st, session.User, "change_rehearsal", req.Model)
		}
		if len(providers) > 0 && (st.MonthlyLimit <= 0 || s.aiCallsThisMonth(session.User) < st.MonthlyLimit) {
			if len(req.Images) > 0 && providers[0].Vision == "no" {
				if strings.TrimSpace(req.Model) != "" {
					msg := tr(lang,
						fmt.Sprintf("所选模型（%s）不支持识别截图，请切换支持视觉的模型或改贴文本回显", providers[0].Model),
						fmt.Sprintf("Selected model (%s) does not support images; pick a vision-capable model or paste text", providers[0].Model),
					)
					failRehearsalResp(s, w, ev, 409, msg, nil)
					return
				}
				var visionFirst, others []aiProvider
				for _, cand := range providers {
					if cand.Vision != "no" {
						visionFirst = append(visionFirst, cand)
					} else {
						others = append(others, cand)
					}
				}
				if len(visionFirst) > 0 {
					providers = append(visionFirst, others...)
				}
			}
			aiDraft, aiTrace, status, aiErr := s.aiExtractImportDraft(r, providers, session.User, req, det, detMS, preset, lang, ev)
			if aiErr == nil && aiDraft != nil {
				draft = mergeImportDrafts(*aiDraft, det)
				aiUsed = true
				parserMode = "ai"
				synthSummary := tr(lang,
					fmt.Sprintf("已提取 %d 台主机 · %d 个伴生组件 · %d 个访问入口", len(draft.Hosts), len(draft.Companions), len(draft.Endpoints)),
					fmt.Sprintf("Extracted %d host(s) · %d companion(s) · %d endpoint(s)", len(draft.Hosts), len(draft.Companions), len(draft.Endpoints)),
				)
				finalizeTraceSynth(&aiTrace, ev, "synth-baseline", synthSummary, true, 0)
				trace = &aiTrace
			} else if aiErr != nil {
				if ev != nil {
					failRehearsalResp(s, w, ev, status, aiErr.Error(), aiTrace.Diag)
					return
				}
				warns = append(warns, tr(lang, "AI 解析暂时不可用，已自动回退为内置规则解析："+aiErr.Error(), "AI extraction unavailable; fell back to deterministic parser: "+aiErr.Error()))
			}
		}
	} else if len(req.Images) > 0 && text == "" {
		warns = append(warns, tr(lang, "当前未开启 AI 助手，无法直接识别纯截图；请粘贴文本或在设置中启用 AI。", "AI is disabled and cannot parse image-only inputs; paste text or enable AI in Settings."))
	}

	for i := range draft.Endpoints {
		draft.Endpoints[i].Role = normalizeImportEndpointRole(draft.Endpoints[i].Role)
	}
	// Compute missing fields checklist for the UI
	var missing []string
	if len(draft.Hosts) == 0 {
		missing = append(missing, tr(lang, "主机节点清单（hostname / IP）", "Host list (hostname / IP)"))
	}
	if strings.TrimSpace(draft.Version) == "" && strings.TrimSpace(draft.ExactVersion) == "" {
		missing = append(missing, tr(lang, "中间件版本号", "Middleware version"))
	}
	if strings.TrimSpace(draft.Platform) == "" {
		missing = append(missing, tr(lang, "操作系统平台", "Operating system platform"))
	}

	payload := map[string]any{
		"draft":          draft,
		"parser":         parserMode,
		"ai_used":        aiUsed,
		"warnings":       nz(warns),
		"missing_fields": nz(missing),
	}
	if trace != nil {
		payload["trace"] = trace
	}
	finishImportStreamResp(w, ev, payload)
}

func (s *storeServer) aiExtractImportDraft(
	r *http.Request,
	providers []aiProvider,
	user string,
	req importParseReq,
	det importParseDraft,
	detMS int64,
	preset mwpack.ImportPreset,
	lang string,
	ev *sse,
) (*importParseDraft, rehearsalTrace, int, error) {
	scrubStart := time.Now()
	var roleHint []string
	for _, rl := range preset.Roles {
		roleHint = append(roleHint, rl.ID+"("+rl.Title+")")
	}
	sys := `你是一位企业级中间件架构师，负责把运维工程师粘贴的只读采集脚本输出、CMDB 表格、配置文件或截图整理为严格的 JSON 纳管基线草稿。
严格要求：
1. 只输出一个合法 JSON 对象，不要包含 Markdown 代码块围栏或额外解释文字；请将 "thinking" 作为第一个字段用于实时展示你的分析路径。
2. 所有信息必须严格来自输入文本或截图，严禁凭空编造 IP、主机名或版本号；未在输入中出现的可留空。
3. 严禁在 params 或 notes 中输出任何密码、私钥或密钥明文（如有请脱敏为 <redacted>）。
4. 【核心要求：识别多组件 / 伴生高可用架构】如果现场存在伴生/支撑组件（如 Patroni、etcd、HAProxy、Keepalived、Nginx、PgBouncer、pgBackRest、Redis Sentinel、ZooKeeper、Consul、ClickHouse Keeper、ProxySQL、MaxScale、OBProxy、node_exporter、postgres_exporter 等各类 exporter），必须全部结构化填入 companions 数组，不得只写入 notes！
   - 例如 PostgreSQL + Patroni + etcd + pgBackRest：主 component="postgresql"，companions 必须分别列出 patroni(kind="ha_manager", ports:[8008], placement:{primary:[...],replica:[...]})、etcd(kind="dcs", role="member", hosts:[...], ports:[2379,2380])、pgbackrest(kind="backup", version:"...")。
   - companion 的 kind 仅取：ha_manager | dcs | proxy | vip | pooler | backup | monitoring | os_component | companion；其中宿主机/操作系统层采集器或代理（如 node_exporter、process_exporter、cadvisor）必须使用 kind="os_component"，中间件专属采集器（如 postgres_exporter、mysqld_exporter、redis_exporter 等）使用 kind="monitoring"。
5. hosts[].disk 从存储输出（df -hT / lsblk）中提取数据盘设备（如 /dev/vdb），不要填系统根盘 /dev/vda。
6. params 仅保留有运维价值的中间件配置参数（如 port、max_connections、shared_buffers、replication、synchronous_mode、cluster_name 等），不要把宿主机硬件信息（arch、cpu_cores、kernel、mem）塞进 params。
7. platform 如能识别，优先映射到以下标准 ID 之一：ubuntu-24.04-amd64, ubuntu-22.04-amd64, el9-amd64, el8-amd64, debian-12-amd64, kylin-v10-amd64, openeuler-22.03-amd64；无法映射可留空并在 os_detail 填写原始发行版名称。
8. deploy_method 取值为 systemd / docker / binary / k8s / other 之一。
9. endpoints[].role 仅取 readwrite | readonly | admin 之一；endpoints[].name 优先使用清晰入口类型标识，如 vip / eip / f5 / elb / slb / lvs / haproxy / nginx / pooler / dns / writer / reader / admin / metrics（或保留现场实际入口名称）。
10. notes 用简洁的分条要点（每行以 "• " 开头，3~6 条）列出高价值现场线索或待人工核对项（如发行版类型、单节点采集范围、待确认 VIP、未采集到的目录等），避免长段堆砌。
11. JSON 结构：
{
  "thinking": "1. 主机与发行版核对：... 2. 伴生高可用架构识别：... 3. 目录、端口与运行参数收敛：...",
  "suggested_id": "小写字母数字连字符集群标识，如 pg-gitlab-private-prod",
  "component": "主中间件标识，如 postgresql / mysql / redis / kafka",
  "display_name": "展示名称，如 PostgreSQL / MySQL",
  "version": "主版本，如 17 / 8.0",
  "exact_version": "精确版本，如 17.11.1 / 8.0.36",
  "platform": "平台 ID",
  "os_detail": "原始操作系统描述，如 Ubuntu 24.04.5 LTS",
  "deploy_method": "systemd|docker|binary|k8s|other",
  "arch_summary": "一句话架构总结，如 3节点 Patroni + etcd 高可用集群（一主两从 Quorum 同步）",
  "hosts": [{"name":"db-node-01","ip":"10.0.1.11","role":"primary","disk":"/dev/vdb"}],
  "endpoints": [{"name":"writer","address":"10.0.1.100:5432","role":"readwrite"}],
  "companions": [
    {"component":"patroni","display_name":"Patroni","version":"4.0.4","kind":"ha_manager","placement":{"primary":["db-node-01"],"replica":["db-node-02","db-node-03"]},"ports":[8008],"service_units":["patroni.service"],"config_paths":["/etc/patroni/patroni.yml"],"evidence":"patronictl list · patroni.service"},
    {"component":"etcd","display_name":"etcd","version":"3.5.14","kind":"dcs","role":"member","hosts":["db-node-01","db-node-02","db-node-03"],"ports":[2379,2380],"service_units":["etcd.service"],"config_paths":["/etc/etcd/etcd.conf.yaml"],"data_dirs":["/data/etcd"],"evidence":"etcd.service · initial-cluster"}
  ],
  "service_units": ["patroni.service", "etcd.service"],
  "config_paths": ["/etc/patroni/patroni.yml", "/etc/etcd/etcd.conf.yaml"],
  "data_dirs": ["/data/pg", "/data/etcd"],
  "log_dirs": ["/var/log/postgresql"],
  "params": {"port": 5432, "replication": "quorum"},
  "packages": [{"name":"percona-postgresql-17","version":"17.11","role":"primary"}],
  "notes": "• 发行版为 Percona Distribution for PostgreSQL 17.11.1\n• 探针仅在主节点执行，备节点信息来自 patronictl 成员表"
}`
	var prompt strings.Builder
	if req.Component != "" || req.DisplayName != "" {
		fmt.Fprintf(&prompt, "用户已预选中间件：%s (%s)\n", firstNonEmptyStr(req.DisplayName, req.Component), req.Component)
	}
	if len(roleHint) > 0 {
		fmt.Fprintf(&prompt, "推荐角色名：%s\n", strings.Join(roleHint, ", "))
	}
	if req.SourceKind != "" {
		fmt.Fprintf(&prompt, "输入来源类型：%s\n", req.SourceKind)
	}
	scrubbedText := truncRunes(aiScrub(req.Text), 14000)
	if strings.TrimSpace(req.Text) != "" {
		prompt.WriteString("\n--- 原始粘贴文本 ---\n")
		prompt.WriteString(scrubbedText)
		prompt.WriteString("\n")
	} else {
		prompt.WriteString("\n请结合附图提取集群主机、角色、版本、入口地址与关键参数。\n")
	}
	scrubMS := max(1, time.Since(scrubStart).Milliseconds())

	detSummary := tr(lang,
		fmt.Sprintf("规则预扫描 %d 字%s · 初检 %d 台主机 / %d 个伴生线索",
			utf8.RuneCountInString(req.Text),
			func() string {
				if len(req.Images) > 0 {
					return fmt.Sprintf(" + %d 张截图", len(req.Images))
				}
				return ""
			}(),
			len(det.Hosts),
			len(det.Companions),
		),
		fmt.Sprintf("Pre-scanned %d chars%s · %d host(s) / %d companion clue(s)",
			utf8.RuneCountInString(req.Text),
			func() string {
				if len(req.Images) > 0 {
					return fmt.Sprintf(" + %d image(s)", len(req.Images))
				}
				return ""
			}(),
			len(det.Hosts),
			len(det.Companions),
		),
	)

	spec := rehearsalPipelineSpec{
		Feature: "import_parse",
		PreSteps: []rehearsalTraceStep{
			{
				ID:     "det-scan",
				Kind:   "inspect",
				Title:  tr(lang, "扫描现场回显与架构线索", "Scan Live Evidence & Clues"),
				Detail: detSummary,
				MS:     detMS,
				OK:     true,
				Status: "done",
			},
			{
				ID:     "redact-secrets",
				Kind:   "guard",
				Title:  tr(lang, "敏感凭据自动脱敏与规范化", "Scrub Credentials & Normalize Input"),
				Detail: tr(lang, "已剥离口令、私钥与敏感连接串，仅投递架构元数据", "Credentials, keys & tokens scrubbed locally; topology metadata only"),
				MS:     scrubMS,
				OK:     true,
				Status: "done",
			},
		},
		ThinkTitle:     tr(lang, "识别主机角色与多组件架构栈", "Analyze Hosts & Companion Stack"),
		ThinkWait:      tr(lang, "正在逐段核对主机、版本、磁盘与伴生高可用组件…", "Evaluating hosts, versions, disks & companion HA stack..."),
		ThinkDone:      tr(lang, "已完成现场回显与多组件架构推演", "Completed live evidence & companion stack analysis"),
		SynthID:        "synth-baseline",
		SynthKind:      "synthesize",
		SynthTitle:     tr(lang, "合成结构化纳管基线草稿", "Synthesize Structured Baseline Draft"),
		SynthWait:      tr(lang, "等待架构推演完成后组装基线拓扑草稿", "Waiting for analysis before assembling baseline draft"),
		PhaseExtractor: parseImportDraftStreamMetaLang,
		Validate: func(txt string) error {
			raw := extractJSONObject(txt)
			if raw == "" {
				return fmt.Errorf("AI 未返回有效 JSON")
			}
			var tmp importParseDraft
			if err := json.Unmarshal([]byte(raw), &tmp); err != nil {
				return fmt.Errorf("AI 返回 JSON 解析失败: %v", err)
			}
			return nil
		},
	}

	txt, trace, status, err := s.rehearsalRunAI(
		r,
		providers,
		user,
		firstNonEmptyStr(req.ClusterID, req.Component, "import"),
		"import-parse",
		"parse",
		nil,
		sys,
		prompt.String(),
		req.Images,
		spec,
		thinkLevel(strings.TrimSpace(req.Think)),
		ev,
	)
	if err != nil {
		return nil, trace, status, err
	}
	raw := extractJSONObject(txt)
	if raw == "" {
		return nil, trace, 502, fmt.Errorf("AI 未返回有效 JSON")
	}
	var out importParseDraft
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, trace, 502, fmt.Errorf("AI 返回 JSON 解析失败: %v", err)
	}
	return &out, trace, 200, nil
}

func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.Index(s, "```"); idx >= 0 {
		if end := strings.LastIndex(s, "```"); end > idx {
			inner := s[idx+3 : end]
			if nl := strings.IndexByte(inner, '\n'); nl >= 0 {
				inner = inner[nl+1:]
			}
			s = strings.TrimSpace(inner)
		}
	}
	start := strings.IndexByte(s, '{')
	end := strings.LastIndexByte(s, '}')
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return ""
}

var (
	reIPv4          = regexp.MustCompile(`\b((?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168|\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3})\b`)
	reVersionSemver = regexp.MustCompile(`\b(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9._]+)?)\b`)
	reHostLine      = regexp.MustCompile(`(?i)^\s*([a-z][a-z0-9._-]{1,62})[\s,;|\t]+(\d{1,3}(?:\.\d{1,3}){3})(?:[\s,;|\t]+([a-z0-9_-]+))?`)
	reIPFirstLine   = regexp.MustCompile(`(?i)^\s*(\d{1,3}(?:\.\d{1,3}){3})[\s,;|\t]+([a-z][a-z0-9._-]{1,62})(?:[\s,;|\t]+([a-z0-9_-]+))?`)
	reListenPort    = regexp.MustCompile(`(?:0\.0\.0\.0|\*|\[::\]|\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b`)
	reDiskPart      = regexp.MustCompile(`^(/dev/(?:[hsv]d|xvd)[a-z]+)\d+$`)
	reNvmePart      = regexp.MustCompile(`^(/dev/nvme\d+n\d+)p\d+$`)
)

func stripDiskPartition(dev string) string {
	dev = strings.TrimSpace(dev)
	if m := reNvmePart.FindStringSubmatch(dev); len(m) >= 2 {
		return m[1]
	}
	if m := reDiskPart.FindStringSubmatch(dev); len(m) >= 2 {
		return m[1]
	}
	return dev
}

func isRootSystemDisk(dev string) bool {
	base := stripDiskPartition(dev)
	return base == "/dev/vda" || base == "/dev/sda" || base == "/dev/xvda" || base == "/dev/nvme0n1"
}

func parseImportedDeterministic(text, component, displayName string, preset mwpack.ImportPreset) importParseDraft {
	draft := importParseDraft{
		Component:    strings.TrimSpace(component),
		DisplayName:  firstNonEmptyStr(strings.TrimSpace(displayName), preset.Name),
		Hosts:        []importHostInput{},
		Endpoints:    []mwpack.ImportedEndpoint{},
		Companions:   []mwpack.ImportedCompanion{},
		ServiceUnits: []string{},
		ConfigPaths:  []string{},
		DataDirs:     []string{},
		LogDirs:      []string{},
		Params:       map[string]any{},
		Packages:     []mwpack.ImportedPkg{},
	}
	if strings.TrimSpace(text) == "" {
		return draft
	}

	seenHost := map[string]int{} // lower(name) -> index in draft.Hosts
	seenIP := map[string]int{}   // ip -> index in draft.Hosts
	seenUnit := map[string]bool{}
	seenCfg := map[string]bool{}
	seenData := map[string]bool{}
	seenLog := map[string]bool{}
	seenPkg := map[string]bool{}
	listeningPorts := map[int]string{} // port -> process line
	compVersions := map[string]string{}
	compEvidence := map[string][]string{}
	addCompEv := func(compID, ev string) {
		compID = mwpack.NormalizeCompanionID(compID)
		if compID == "" || ev == "" {
			return
		}
		for _, cur := range compEvidence[compID] {
			if cur == ev {
				return
			}
		}
		compEvidence[compID] = append(compEvidence[compID], ev)
	}
	addDataDir := func(p string) {
		p = strings.TrimSpace(p)
		if p != "" && strings.HasPrefix(p, "/") && !seenData[p] {
			seenData[p] = true
			draft.DataDirs = append(draft.DataDirs, p)
		}
	}
	addLogDir := func(p string) {
		p = strings.TrimSpace(p)
		if p != "" && strings.HasPrefix(p, "/") && !seenLog[p] {
			seenLog[p] = true
			draft.LogDirs = append(draft.LogDirs, p)
		}
	}
	addCfgPath := func(p string) {
		p = strings.TrimSpace(p)
		if p != "" && strings.HasPrefix(p, "/") && !seenCfg[p] {
			seenCfg[p] = true
			draft.ConfigPaths = append(draft.ConfigPaths, p)
		}
	}

	addOrUpdateHost := func(name, ip, role string, preferName bool) {
		name = strings.TrimSpace(name)
		ip = strings.TrimSpace(ip)
		if ip != "" && (strings.HasPrefix(ip, "127.") || ip == "0.0.0.0" || net.ParseIP(ip) == nil) {
			return
		}
		if name == "" && ip == "" {
			return
		}
		if name == "" {
			name = "node-" + fmt.Sprint(len(draft.Hosts)+1)
		}
		key := strings.ToLower(name)
		if idx, ok := seenHost[key]; ok {
			if draft.Hosts[idx].IP == "" && ip != "" {
				draft.Hosts[idx].IP = ip
				seenIP[ip] = idx
			}
			if role != "" {
				draft.Hosts[idx].Role = role
			}
			return
		}
		if ip != "" {
			if idx, ok := seenIP[ip]; ok {
				if preferName && len(name) > 0 && (len(draft.Hosts[idx].Name) > 28 || strings.HasPrefix(draft.Hosts[idx].Name, "ecs-")) {
					delete(seenHost, strings.ToLower(draft.Hosts[idx].Name))
					draft.Hosts[idx].Name = name
					seenHost[key] = idx
				}
				if role != "" {
					draft.Hosts[idx].Role = role
				}
				return
			}
		}
		if role == "" && len(preset.Roles) > 0 {
			if len(draft.Hosts) == 0 {
				role = preset.Roles[0].ID
			} else if len(preset.Roles) > 1 {
				role = preset.Roles[1].ID
			} else {
				role = preset.Roles[0].ID
			}
		}
		idx := len(draft.Hosts)
		draft.Hosts = append(draft.Hosts, importHostInput{Name: name, IP: ip, Role: role})
		seenHost[key] = idx
		if ip != "" {
			seenIP[ip] = idx
		}
	}

	section := ""
	curHost := ""
	curConfigFile := ""
	detectedDataDisk := ""
	patroniCols := map[string]int{} // col name -> idx
	hasPatroniTable := false
	patroniPlacement := map[string][]string{}
	etcdHosts := []string{}
	seenEtcdHost := map[string]bool{}

	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for _, raw := range lines {
		ln := strings.TrimSpace(raw)
		if ln == "" {
			continue
		}
		if strings.HasPrefix(ln, "=== MW_IMPORT_") && strings.HasSuffix(ln, "===") {
			section = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(ln, "=== MW_IMPORT_"), "==="))
			curConfigFile = ""
			continue
		}
		if strings.HasPrefix(ln, "PROBE_COMPONENT=") && draft.Component == "" {
			draft.Component = strings.TrimSpace(strings.TrimPrefix(ln, "PROBE_COMPONENT="))
			continue
		}
		if strings.HasPrefix(ln, "HOSTNAME=") {
			curHost = strings.TrimSpace(strings.TrimPrefix(ln, "HOSTNAME="))
			continue
		}
		if strings.HasPrefix(ln, "IPS=") {
			ips := strings.Fields(strings.TrimSpace(strings.TrimPrefix(ln, "IPS=")))
			chosen := ""
			for _, cand := range ips {
				if net.ParseIP(cand) != nil && !strings.HasPrefix(cand, "127.") && !strings.Contains(cand, ":") {
					chosen = cand
					break
				}
			}
			if curHost != "" || chosen != "" {
				addOrUpdateHost(curHost, chosen, "", false)
				curHost = ""
			}
			continue
		}
		if strings.HasPrefix(ln, "PRETTY_NAME=") {
			osName := strings.Trim(strings.TrimPrefix(ln, "PRETTY_NAME="), `"'`)
			draft.OSDetail = osName
			if draft.Platform == "" {
				draft.Platform = inferPlatformFromOS(osName)
			}
			continue
		}
		if strings.HasPrefix(ln, "# file: ") {
			cf := strings.TrimSpace(strings.TrimPrefix(ln, "# file: "))
			curConfigFile = cf
			addCfgPath(cf)
			continue
		}

		// Storage parsing (df -hT)
		if section == "STORAGE" && strings.HasPrefix(ln, "/dev/") {
			flds := strings.Fields(ln)
			if len(flds) >= 7 {
				dev := flds[0]
				mnt := flds[len(flds)-1]
				if !isRootSystemDisk(dev) && mnt != "/" && !strings.HasPrefix(mnt, "/boot") && !strings.HasPrefix(mnt, "/snap") {
					if detectedDataDisk == "" {
						detectedDataDisk = stripDiskPartition(dev)
					}
					if strings.HasPrefix(mnt, "/data") || strings.Contains(mnt, "pg") || strings.Contains(mnt, "mysql") || strings.Contains(mnt, "redis") || strings.Contains(mnt, "etcd") {
						addDataDir(mnt)
					}
				}
			}
			continue
		}

		// Listening ports parsing (ss -tlnp / netstat -tlnp)
		if section == "PORTS" {
			if m := reListenPort.FindStringSubmatch(ln); len(m) == 2 {
				if pn, err := strconv.Atoi(m[1]); err == nil && pn > 0 {
					listeningPorts[pn] = ln
				}
			}
			continue
		}

		// Direct PG query outputs & key config lines
		if strings.HasPrefix(ln, "PG_DATA_DIR=") {
			addDataDir(strings.TrimPrefix(ln, "PG_DATA_DIR="))
			continue
		}
		if strings.HasPrefix(ln, "PG_CONFIG_FILE=") {
			addCfgPath(strings.TrimPrefix(ln, "PG_CONFIG_FILE="))
			continue
		}
		if strings.HasPrefix(ln, "PG_LOG_DIR=") {
			addLogDir(strings.TrimPrefix(ln, "PG_LOG_DIR="))
			continue
		}
		if strings.HasPrefix(ln, "PG_MAX_CONN=") {
			if v := strings.TrimSpace(strings.TrimPrefix(ln, "PG_MAX_CONN=")); v != "" {
				draft.Params["max_connections"] = v
			}
			continue
		}
		if strings.HasPrefix(ln, "PG_SHARED_BUFFERS=") {
			if v := strings.TrimSpace(strings.TrimPrefix(ln, "PG_SHARED_BUFFERS=")); v != "" {
				draft.Params["shared_buffers"] = v
			}
			continue
		}
		if strings.HasPrefix(ln, "PG_WAL_LEVEL=") {
			if v := strings.TrimSpace(strings.TrimPrefix(ln, "PG_WAL_LEVEL=")); v != "" {
				draft.Params["wal_level"] = v
			}
			continue
		}
		if strings.HasPrefix(ln, "PG_SSL=") {
			if v := strings.TrimSpace(strings.TrimPrefix(ln, "PG_SSL=")); v != "" {
				draft.Params["ssl"] = v
			}
			continue
		}
		// Extract PG data dir from running `postgres -D /path/to/data` process lines even without psql privileges
		if strings.Contains(ln, "postgres") && strings.Contains(ln, " -D ") {
			if m := rePGDataFlag.FindStringSubmatch(ln); len(m) == 2 {
				addDataDir(m[1])
			}
		}
		// Extract key=value settings from postgresql.conf / postgresql.base.conf
		if curConfigFile != "" && strings.Contains(ln, "=") && !strings.HasPrefix(ln, "#") {
			eq := strings.IndexByte(ln, '=')
			if eq > 0 {
				k := strings.ToLower(strings.TrimSpace(ln[:eq]))
				v := strings.TrimSpace(ln[eq+1:])
				if hash := strings.IndexByte(v, '#'); hash >= 0 {
					v = strings.TrimSpace(v[:hash])
				}
				v = strings.Trim(v, `"'`)
				switch k {
				case "log_directory":
					if strings.HasPrefix(v, "/") {
						addLogDir(v)
					}
				case "max_connections", "shared_buffers", "wal_level", "ssl", "port":
					if v != "" && draft.Params[k] == nil {
						draft.Params[k] = v
					}
				}
			}
		}
		// Config YAML/INI key extraction (e.g., patroni.yml data_dir / log_directory, etcd.conf.yaml data-dir / initial-cluster)
		if curConfigFile != "" && strings.Contains(ln, ":") {
			lowLn := strings.ToLower(ln)
			if strings.HasPrefix(lowLn, "data_dir:") || strings.HasPrefix(lowLn, "data-dir:") {
				v := strings.Trim(strings.TrimSpace(ln[strings.IndexByte(ln, ':')+1:]), `"'`)
				addDataDir(v)
			} else if strings.HasPrefix(lowLn, "log_directory:") {
				v := strings.Trim(strings.TrimSpace(ln[strings.IndexByte(ln, ':')+1:]), `"'`)
				addLogDir(v)
			} else if strings.HasPrefix(lowLn, "initial-cluster:") {
				addCompEv("etcd", "initial-cluster")
				v := strings.Trim(strings.TrimSpace(ln[strings.IndexByte(ln, ':')+1:]), `"'`)
				for _, seg := range strings.Split(v, ",") {
					if eq := strings.IndexByte(seg, '='); eq > 0 {
						hn := strings.TrimSpace(seg[:eq])
						if hn != "" && !seenEtcdHost[hn] {
							seenEtcdHost[hn] = true
							etcdHosts = append(etcdHosts, hn)
						}
					}
				}
			}
		}

		// Parse patronictl list tables
		if strings.HasPrefix(ln, "|") && strings.HasSuffix(ln, "|") {
			rawCells := strings.Split(strings.Trim(ln, "|"), "|")
			cells := make([]string, len(rawCells))
			for i, c := range rawCells {
				cells[i] = strings.TrimSpace(c)
			}
			// Header row detection
			isHeader := false
			for _, c := range cells {
				if strings.EqualFold(c, "Member") {
					isHeader = true
					break
				}
			}
			if isHeader {
				patroniCols = map[string]int{}
				for i, c := range cells {
					patroniCols[strings.ToLower(c)] = i
				}
				continue
			}
			if len(patroniCols) > 0 {
				mIdx, hasM := patroniCols["member"]
				hIdx, hasH := patroniCols["host"]
				rIdx, hasR := patroniCols["role"]
				if hasM && hasH && mIdx < len(cells) && hIdx < len(cells) {
					member := cells[mIdx]
					hostVal := cells[hIdx]
					if colon := strings.IndexByte(hostVal, ':'); colon > 0 {
						hostVal = hostVal[:colon]
					}
					roleRaw := ""
					if hasR && rIdx < len(cells) {
						roleRaw = strings.ToLower(cells[rIdx])
					}
					mappedRole := "replica"
					if strings.Contains(roleRaw, "leader") || strings.Contains(roleRaw, "primary") || strings.Contains(roleRaw, "master") {
						mappedRole = "primary"
					}
					if strings.Contains(roleRaw, "quorum") || strings.Contains(roleRaw, "sync") {
						draft.Params["replication"] = "quorum"
					}
					if cIdx, hasC := patroniCols["cluster"]; hasC && cIdx < len(cells) {
						cl := strings.ToLower(strings.TrimSpace(cells[cIdx]))
						if cl != "" && draft.SuggestedID == "" && docClusterID.MatchString(cl) {
							draft.SuggestedID = cl
						}
					}
					if member != "" && net.ParseIP(hostVal) != nil {
						hasPatroniTable = true
						addCompEv("patroni", "patronictl list")
						addOrUpdateHost(member, hostVal, mappedRole, true)
						patroniPlacement[mappedRole] = append(patroniPlacement[mappedRole], member)
					}
				}
			}
			continue
		}

		if section == "PACKAGES" {
			fields := strings.Split(ln, "\t")
			if len(fields) < 2 {
				fields = strings.Fields(ln)
			}
			if len(fields) >= 2 && !strings.HasPrefix(fields[0], "#") {
				pkgName, pkgVer := strings.TrimSpace(fields[0]), strings.TrimSpace(fields[1])
				k := pkgName + "|" + pkgVer
				if pkgName != "" && pkgVer != "" && !seenPkg[k] {
					seenPkg[k] = true
					role := "dependency"
					if strings.Contains(strings.ToLower(pkgName), strings.ToLower(firstNonEmptyStr(draft.Component, "mw"))) {
						role = "primary"
					}
					draft.Packages = append(draft.Packages, mwpack.ImportedPkg{Name: pkgName, Version: pkgVer, Role: role})
				}
			}
			continue
		}

		// Extract companion version banners
		low := strings.ToLower(ln)
		isExporterBanner := false
		if strings.HasPrefix(low, "etcd version:") {
			if m := reVersionSemver.FindStringSubmatch(ln); len(m) == 2 {
				compVersions["etcd"] = m[1]
				addCompEv("etcd", "etcd --version")
			}
		} else if strings.HasPrefix(low, "patronictl version") {
			if m := reVersionSemver.FindStringSubmatch(ln); len(m) == 2 {
				compVersions["patroni"] = m[1]
				addCompEv("patroni", "patronictl version")
			}
		} else if strings.HasPrefix(low, "pgbackrest ") {
			if m := reVersionSemver.FindStringSubmatch(ln); len(m) == 2 {
				compVersions["pgbackrest"] = m[1]
				addCompEv("pgbackrest", "pgbackrest version")
			}
		} else if strings.HasPrefix(low, "pgbouncer ") {
			if m := reVersionSemver.FindStringSubmatch(ln); len(m) == 2 {
				compVersions["pgbouncer"] = m[1]
				addCompEv("pgbouncer", "pgbouncer --version")
			}
		} else if m := reExporterVersionBanner.FindStringSubmatch(ln); len(m) == 3 {
			cid := mwpack.NormalizeCompanionID(m[1])
			if cid != "" {
				compVersions[cid] = m[2]
				addCompEv(cid, m[1]+" --version")
				isExporterBanner = true
			}
		}

		// Extract systemd service unit names
		if strings.Contains(ln, ".service") {
			for _, tok := range strings.Fields(ln) {
				if strings.HasSuffix(tok, ".service") && reSafeShellToken.MatchString(tok) && !seenUnit[tok] {
					seenUnit[tok] = true
					draft.ServiceUnits = append(draft.ServiceUnits, tok)
					if draft.DeployMethod == "" {
						draft.DeployMethod = "systemd"
					}
				}
			}
		}
		// Detect docker deployment
		if strings.Contains(low, "docker") && strings.Contains(ln, "Up ") && draft.DeployMethod == "" {
			draft.DeployMethod = "docker"
		}
		// Extract version from typical middleware --version banners (skip companion-only banners if primary != companion)
		if draft.ExactVersion == "" {
			isCompanionBanner := isExporterBanner || strings.HasPrefix(low, "etcd version:") || strings.HasPrefix(low, "patronictl version") || strings.HasPrefix(low, "pgbackrest ")
			if !isCompanionBanner || strings.EqualFold(draft.Component, "etcd") || strings.EqualFold(draft.Component, "patroni") {
				if strings.Contains(low, "version") || strings.Contains(low, "ver ") || strings.Contains(low, "(postgresql)") || strings.Contains(low, "redis server v=") || strings.Contains(low, "nginx/") || strings.Contains(low, "haproxy") || strings.Contains(low, "mysqld") || strings.Contains(low, "mongod") || strings.Contains(low, "clickhouse") {
					if m := reVersionSemver.FindStringSubmatch(ln); len(m) == 2 {
						draft.ExactVersion = m[1]
						draft.Version = majorMinorVersion(m[1], draft.Component)
					}
				}
			}
		}
		// Extract hosts from /etc/hosts or pasted CMDB lines (hostname ip [role] or ip hostname [role])
		if section == "HOSTS_FILE" || section == "" {
			if m := reIPFirstLine.FindStringSubmatch(ln); len(m) >= 3 {
				if !strings.Contains(m[2], ".") {
					addOrUpdateHost(m[2], m[1], strings.ToLower(m[3]), false)
				}
			} else if m := reHostLine.FindStringSubmatch(ln); len(m) >= 3 {
				if !strings.Contains(m[1], ".") {
					addOrUpdateHost(m[1], m[2], strings.ToLower(m[3]), false)
				}
			}
		}
	}

	// Fill detected data disk onto hosts lacking one
	if detectedDataDisk != "" {
		for i := range draft.Hosts {
			if draft.Hosts[i].Disk == "" {
				draft.Hosts[i].Disk = detectedDataDisk
			}
		}
	}

	if draft.DeployMethod == "" {
		draft.DeployMethod = "systemd"
	}
	if draft.Platform == "" && draft.OSDetail != "" {
		draft.Platform = inferPlatformFromOS(draft.OSDetail)
	}
	if draft.Version == "" && draft.ExactVersion != "" {
		draft.Version = majorMinorVersion(draft.ExactVersion, draft.Component)
	}

	// Infer structured companions (Patroni, etcd, HAProxy, Keepalived, PgBouncer, pgBackRest, Sentinel, ZooKeeper, etc.)
	inferred := inferCompanionsFromSignals(companionSignals{
		PrimaryComp:      draft.Component,
		Hosts:            draft.Hosts,
		ServiceUnits:     draft.ServiceUnits,
		ConfigPaths:      draft.ConfigPaths,
		DataDirs:         draft.DataDirs,
		Packages:         draft.Packages,
		ListeningPorts:   listeningPorts,
		VersionsByComp:   compVersions,
		EvidenceByComp:   compEvidence,
		PatroniPlacement: patroniPlacement,
		EtcdHosts:        etcdHosts,
	})
	draft.Companions = inferred

	if len(draft.ConfigPaths) == 0 && len(preset.ConfigHints) > 0 {
		draft.ConfigPaths = append([]string(nil), preset.ConfigHints[0])
	}
	if len(draft.DataDirs) == 0 && len(preset.DataHints) > 0 {
		draft.DataDirs = append([]string(nil), preset.DataHints[0])
	}
	if len(draft.LogDirs) == 0 && len(preset.LogHints) > 0 {
		draft.LogDirs = append([]string(nil), preset.LogHints[0])
	}
	if len(draft.Hosts) > 0 && draft.ArchSummary == "" {
		draft.ArchSummary = synthesizeImportArchSummary(draft.Component, draft.DisplayName, draft.Hosts, draft.Companions, hasPatroniTable)
	}
	return draft
}

type companionSignals struct {
	PrimaryComp      string
	Hosts            []importHostInput
	ServiceUnits     []string
	ConfigPaths      []string
	DataDirs         []string
	Packages         []mwpack.ImportedPkg
	ArchSummary      string
	Notes            string
	ListeningPorts   map[int]string
	VersionsByComp   map[string]string
	EvidenceByComp   map[string][]string
	PatroniPlacement map[string][]string
	EtcdHosts        []string
}

func inferCompanionsFromSignals(sig companionSignals) []mwpack.ImportedCompanion {
	primary := mwpack.NormalizeImportComponentID(sig.PrimaryComp)
	allHosts := make([]string, 0, len(sig.Hosts))
	primaryPlacement := map[string][]string{}
	for _, h := range sig.Hosts {
		hn := strings.TrimSpace(h.Name)
		if hn == "" {
			continue
		}
		allHosts = append(allHosts, hn)
		rk := strings.TrimSpace(h.Role)
		if rk == "" {
			rk = "node"
		}
		primaryPlacement[rk] = append(primaryPlacement[rk], hn)
	}

	type acc struct {
		ev    []string
		ver   string
		units []string
		cfgs  []string
		datas []string
		ports []int
	}
	hits := map[string]*acc{}
	touch := func(cid string) *acc {
		cid = mwpack.NormalizeCompanionID(cid)
		if cid == "" || cid == primary {
			return nil
		}
		a := hits[cid]
		if a == nil {
			a = &acc{}
			hits[cid] = a
		}
		return a
	}
	addStrUniq := func(sl *[]string, v string) {
		v = strings.TrimSpace(v)
		if v == "" {
			return
		}
		for _, cur := range *sl {
			if cur == v {
				return
			}
		}
		*sl = append(*sl, v)
	}
	addIntUniq := func(sl *[]int, v int) {
		if v <= 0 {
			return
		}
		for _, cur := range *sl {
			if cur == v {
				return
			}
		}
		*sl = append(*sl, v)
	}

	// Explicit evidence & versions from parser
	for cid, evs := range sig.EvidenceByComp {
		if a := touch(cid); a != nil {
			for _, e := range evs {
				addStrUniq(&a.ev, e)
			}
		}
	}
	for cid, ver := range sig.VersionsByComp {
		if ver == "" {
			continue
		}
		if a := touch(cid); a != nil && a.ver == "" {
			a.ver = ver
		}
	}

	// Service units
	unitMatchers := []struct {
		cid string
		sub string
	}{
		{"patroni", "patroni"},
		{"etcd", "etcd"},
		{"haproxy", "haproxy"},
		{"keepalived", "keepalived"},
		{"nginx", "nginx"},
		{"nginx", "openresty"},
		{"pgbouncer", "pgbouncer"},
		{"redis-sentinel", "sentinel"},
		{"zookeeper", "zookeeper"},
		{"consul", "consul"},
		{"clickhouse-keeper", "clickhouse-keeper"},
		{"proxysql", "proxysql"},
		{"maxscale", "maxscale"},
		{"obproxy", "obproxy"},
		{"node-exporter", "node_exporter"},
		{"node-exporter", "node-exporter"},
	}
	for _, u := range sig.ServiceUnits {
		low := strings.ToLower(strings.TrimSpace(u))
		for _, m := range unitMatchers {
			if strings.Contains(low, m.sub) {
				if a := touch(m.cid); a != nil {
					addStrUniq(&a.units, u)
					addStrUniq(&a.ev, u)
				}
			}
		}
		for _, em := range reExporterToken.FindAllString(low, -1) {
			if a := touch(em); a != nil {
				addStrUniq(&a.units, u)
				addStrUniq(&a.ev, u)
			}
		}
	}

	// Config paths
	for _, cf := range sig.ConfigPaths {
		low := strings.ToLower(strings.TrimSpace(cf))
		for _, m := range unitMatchers {
			if strings.Contains(low, m.sub) {
				if a := touch(m.cid); a != nil {
					addStrUniq(&a.cfgs, cf)
					addStrUniq(&a.ev, filepath.Base(cf))
				}
			}
		}
		if strings.Contains(low, "pgbackrest") {
			if a := touch("pgbackrest"); a != nil {
				addStrUniq(&a.cfgs, cf)
				addStrUniq(&a.ev, filepath.Base(cf))
			}
		}
		for _, em := range reExporterToken.FindAllString(low, -1) {
			if a := touch(em); a != nil {
				addStrUniq(&a.cfgs, cf)
				addStrUniq(&a.ev, filepath.Base(cf))
			}
		}
	}

	// Data dirs
	for _, dd := range sig.DataDirs {
		low := strings.ToLower(strings.TrimSpace(dd))
		if strings.Contains(low, "etcd") {
			if a := touch("etcd"); a != nil {
				addStrUniq(&a.datas, dd)
				addStrUniq(&a.ev, dd)
			}
		}
		if strings.Contains(low, "zookeeper") {
			if a := touch("zookeeper"); a != nil {
				addStrUniq(&a.datas, dd)
				addStrUniq(&a.ev, dd)
			}
		}
		if strings.Contains(low, "pgbackrest") {
			if a := touch("pgbackrest"); a != nil {
				addStrUniq(&a.datas, dd)
				addStrUniq(&a.ev, dd)
			}
		}
	}

	// Packages
	pkgMatchers := []struct {
		cid string
		sub string
	}{
		{"patroni", "patroni"},
		{"etcd", "etcd"},
		{"haproxy", "haproxy"},
		{"keepalived", "keepalived"},
		{"pgbouncer", "pgbouncer"},
		{"pgbackrest", "pgbackrest"},
		{"redis-sentinel", "redis-sentinel"},
		{"zookeeper", "zookeeper"},
		{"consul", "consul"},
		{"clickhouse-keeper", "clickhouse-keeper"},
		{"proxysql", "proxysql"},
		{"maxscale", "maxscale"},
		{"obproxy", "obproxy"},
	}
	for _, pk := range sig.Packages {
		low := strings.ToLower(strings.TrimSpace(pk.Name))
		for _, m := range pkgMatchers {
			if strings.Contains(low, m.sub) {
				if a := touch(m.cid); a != nil {
					if a.ver == "" && pk.Version != "" {
						if mv := reVersionSemver.FindStringSubmatch(pk.Version); len(mv) == 2 {
							a.ver = mv[1]
						} else {
							a.ver = pk.Version
						}
					}
					addStrUniq(&a.ev, "pkg:"+pk.Name)
				}
			}
		}
		for _, em := range reExporterToken.FindAllString(low, -1) {
			// Strip leading "prometheus-" package prefix (e.g. "prometheus-node-exporter" -> "node-exporter")
			cid := strings.TrimPrefix(mwpack.NormalizeCompanionID(em), "prometheus-")
			if a := touch(cid); a != nil {
				if a.ver == "" && pk.Version != "" {
					if mv := reVersionSemver.FindStringSubmatch(pk.Version); len(mv) == 2 {
						a.ver = mv[1]
					} else {
						a.ver = pk.Version
					}
				}
				addStrUniq(&a.ev, "pkg:"+pk.Name)
			}
		}
	}

	// Listening ports
	portMap := map[int]string{
		8008:  "patroni",
		2379:  "etcd",
		2380:  "etcd",
		6432:  "pgbouncer",
		26379: "redis-sentinel",
		2181:  "zookeeper",
		9181:  "clickhouse-keeper",
		6033:  "proxysql",
		9100:  "node-exporter",
		9187:  "postgres-exporter",
		9104:  "mysqld-exporter",
		9121:  "redis-exporter",
		9101:  "haproxy-exporter",
		9113:  "nginx-exporter",
		9256:  "process-exporter",
		9308:  "kafka-exporter",
		9115:  "blackbox-exporter",
	}
	for pn, rawLine := range sig.ListeningPorts {
		low := strings.ToLower(rawLine)
		matchedExporter := false
		for _, em := range reExporterToken.FindAllString(low, -1) {
			cid := strings.TrimPrefix(mwpack.NormalizeCompanionID(em), "prometheus-")
			if a := touch(cid); a != nil {
				addIntUniq(&a.ports, pn)
				addStrUniq(&a.ev, fmt.Sprintf(":%d", pn))
				matchedExporter = true
			}
		}
		if matchedExporter {
			continue
		}
		if cid, ok := portMap[pn]; ok {
			// Only infer from ambiguous ports like 8008 or exporter ports if process name or already-hit companion corroborates
			if pn == 8008 && !strings.Contains(low, "patroni") && hits["patroni"] == nil && primary != "postgresql" {
				continue
			}
			if mwpack.IsExporterCompanion(cid) && !strings.Contains(low, "exporter") {
				continue
			}
			if a := touch(cid); a != nil {
				addIntUniq(&a.ports, pn)
				addStrUniq(&a.ev, fmt.Sprintf(":%d", pn))
			}
		}
	}

	// Text signals from ArchSummary (positive architecture declaration) and non-negated Notes lines
	// Filter out negated clauses in BOTH ArchSummary and Notes so statements like
	// "未发现 Sentinel 或从节点配置" or "未采集到 VIP / HAProxy" never hallucinate phantom companions.
	reNegated := regexp.MustCompile(`(?i)(未采集|未发现|未安装|未见|未配置|未部署|未启用|未检测|没有|不含|非高可用|非\s*[a-z]|无\s*[\p{Han}a-z]|not\s+found|not\s+installed|not\s+configured|without\s+|no\s+)`)
	filterPositiveClauses := func(raw string) string {
		var pos []string
		for _, rawLn := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
			for _, seg := range strings.FieldsFunc(rawLn, func(r rune) bool {
				return r == '。' || r == '；' || r == ';' || r == '，' || r == ',' || r == '（' || r == '）' || r == '(' || r == ')'
			}) {
				s := strings.TrimSpace(seg)
				if s == "" || reNegated.MatchString(s) {
					continue
				}
				pos = append(pos, strings.ToLower(s))
			}
		}
		return strings.Join(pos, "\n")
	}
	archPositive := filterPositiveClauses(sig.ArchSummary)
	notesPositive := filterPositiveClauses(sig.Notes)

	if strings.TrimSpace(archPositive) != "" || strings.TrimSpace(notesPositive) != "" {
		textMatchers := []struct {
			cid          string
			token        string
			allowInNotes bool
		}{
			{"patroni", "patroni", true},
			{"etcd", "etcd", true},
			{"pgbackrest", "pgbackrest", true},
			{"pgbouncer", "pgbouncer", false},
			{"haproxy", "haproxy", false},
			{"keepalived", "keepalived", false},
			{"redis-sentinel", "sentinel", false},
			{"zookeeper", "zookeeper", true},
			{"clickhouse-keeper", "clickhouse-keeper", true},
			{"proxysql", "proxysql", false},
			{"node-exporter", "node_exporter", true},
		}
		for _, m := range textMatchers {
			inArch := strings.Contains(archPositive, m.token)
			inNotes := m.allowInNotes && strings.Contains(notesPositive, m.token)
			if inArch || inNotes {
				// Avoid false positive on generic "sentinel" unless primary is redis/valkey
				if m.cid == "redis-sentinel" && primary != "redis" && primary != "valkey" {
					continue
				}
				if a := touch(m.cid); a != nil {
					if inArch {
						addStrUniq(&a.ev, "架构摘要")
					} else {
						addStrUniq(&a.ev, "基线备注")
					}
				}
			}
		}
		// Generically recognize any *_exporter / *-exporter mentioned in positive ArchSummary or Notes
		for _, em := range reExporterToken.FindAllString(archPositive, -1) {
			cid := strings.TrimPrefix(mwpack.NormalizeCompanionID(em), "prometheus-")
			if a := touch(cid); a != nil {
				addStrUniq(&a.ev, "架构摘要")
			}
		}
		for _, em := range reExporterToken.FindAllString(notesPositive, -1) {
			cid := strings.TrimPrefix(mwpack.NormalizeCompanionID(em), "prometheus-")
			if a := touch(cid); a != nil {
				addStrUniq(&a.ev, "基线备注")
			}
		}
	}

	if len(hits) == 0 {
		return []mwpack.ImportedCompanion{}
	}

	// Deterministic canonical ordering matching CompanionCatalog
	orderIdx := map[string]int{}
	for i, cd := range mwpack.CompanionCatalog {
		orderIdx[cd.ID] = i
	}
	ids := make([]string, 0, len(hits))
	for cid := range hits {
		ids = append(ids, cid)
	}
	sort.Slice(ids, func(i, j int) bool {
		oi, oki := orderIdx[ids[i]]
		oj, okj := orderIdx[ids[j]]
		if oki && okj {
			return oi < oj
		}
		if oki != okj {
			return oki
		}
		return ids[i] < ids[j]
	})

	out := make([]mwpack.ImportedCompanion, 0, len(ids))
	for _, cid := range ids {
		a := hits[cid]
		def, hasDef := mwpack.LookupCompanionDef(cid)
		cm := mwpack.ImportedCompanion{
			Component:    cid,
			DisplayName:  cid,
			Version:      a.ver,
			Kind:         "companion",
			Role:         "node",
			ServiceUnits: a.units,
			ConfigPaths:  a.cfgs,
			DataDirs:     a.datas,
			Ports:        a.ports,
			Evidence:     strings.Join(a.ev, " · "),
			Inferred:     true,
		}
		if hasDef {
			cm.DisplayName = def.Name
			cm.Kind = def.Kind
			cm.Role = def.DefaultRole
			if len(cm.Ports) == 0 {
				for _, dp := range def.DefaultPorts {
					cm.Ports = append(cm.Ports, dp.Port)
				}
			}
		} else if mwpack.IsExporterCompanion(cid) {
			cm.DisplayName = mwpack.ExporterDisplayName(cid)
			cm.Role = "exporter"
			if mwpack.IsOSCompanion(cid) {
				cm.Kind = "os_component"
			} else {
				cm.Kind = "monitoring"
			}
		} else if mwpack.IsOSCompanion(cid) {
			cm.Kind = "os_component"
		}
		if cid == "patroni" {
			if len(sig.PatroniPlacement) > 0 {
				cm.Placement = sig.PatroniPlacement
			} else if len(primaryPlacement) > 0 {
				cm.Placement = primaryPlacement
			}
			cm.Hosts = append([]string(nil), allHosts...)
		} else if cid == "etcd" && len(sig.EtcdHosts) > 0 {
			cm.Hosts = append([]string(nil), sig.EtcdHosts...)
		} else if len(allHosts) > 0 {
			cm.Hosts = append([]string(nil), allHosts...)
		}
		out = append(out, cm)
	}
	return out
}

func synthesizeImportArchSummary(compID, displayName string, hosts []importHostInput, companions []mwpack.ImportedCompanion, hasPatroni bool) string {
	n := len(hosts)
	if n == 0 {
		return ""
	}
	var compNames []string
	for _, cm := range companions {
		if cm.Kind == "monitoring" || cm.Kind == "os_component" || cm.Kind == "backup" {
			continue
		}
		compNames = append(compNames, firstNonEmptyStr(cm.DisplayName, cm.Component))
	}
	if len(compNames) > 0 {
		primCnt, repCnt := 0, 0
		for _, h := range hosts {
			r := strings.ToLower(h.Role)
			if r == "primary" || r == "master" {
				primCnt++
			} else if r == "replica" || r == "standby" || r == "secondary" {
				repCnt++
			}
		}
		roleNote := ""
		if primCnt > 0 && repCnt > 0 {
			roleNote = fmt.Sprintf("（%d 主 %d 从）", primCnt, repCnt)
		}
		return fmt.Sprintf("%d 节点 %s 高可用集群%s", n, strings.Join(compNames, " + "), roleNote)
	}
	if n == 1 {
		return "存量单节点实例"
	}
	return fmt.Sprintf("存量 %d 节点集群", n)
}

func mergeCompanionLists(primaryComp string, lists ...[]mwpack.ImportedCompanion) []mwpack.ImportedCompanion {
	primary := mwpack.NormalizeImportComponentID(primaryComp)
	byID := map[string]mwpack.ImportedCompanion{}
	var order []string
	appendUniqStr := func(base, extra []string) []string {
		seen := map[string]bool{}
		out := make([]string, 0, len(base)+len(extra))
		for _, s := range base {
			s = strings.TrimSpace(s)
			if s != "" && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
		for _, s := range extra {
			s = strings.TrimSpace(s)
			if s != "" && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
		return out
	}
	appendUniqInt := func(base, extra []int) []int {
		seen := map[int]bool{}
		out := make([]int, 0, len(base)+len(extra))
		for _, p := range base {
			if p > 0 && !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
		for _, p := range extra {
			if p > 0 && !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
		return out
	}

	for _, list := range lists {
		for _, raw := range list {
			cid := mwpack.NormalizeCompanionID(firstNonEmptyStr(raw.Component, raw.DisplayName))
			if cid == "" || cid == primary {
				continue
			}
			def, hasDef := mwpack.LookupCompanionDef(cid)
			cm := raw
			cm.Component = cid
			if cm.DisplayName == "" {
				if hasDef {
					cm.DisplayName = def.Name
				} else if mwpack.IsExporterCompanion(cid) {
					cm.DisplayName = mwpack.ExporterDisplayName(cid)
				} else {
					cm.DisplayName = cid
				}
			}
			if mwpack.IsOSCompanion(cid) && (cm.Kind == "" || cm.Kind == "monitoring" || cm.Kind == "companion") {
				cm.Kind = "os_component"
			} else if cm.Kind == "" {
				if hasDef {
					cm.Kind = def.Kind
				} else if mwpack.IsExporterCompanion(cid) {
					cm.Kind = "monitoring"
				} else {
					cm.Kind = "companion"
				}
			}
			if cm.Role == "" && hasDef {
				cm.Role = def.DefaultRole
			}
			if len(cm.Ports) == 0 && hasDef {
				for _, dp := range def.DefaultPorts {
					cm.Ports = append(cm.Ports, dp.Port)
				}
			}
			if cur, exists := byID[cid]; exists {
				if cur.Version == "" {
					cur.Version = cm.Version
				}
				if len(cur.Hosts) == 0 {
					cur.Hosts = cm.Hosts
				}
				if len(cur.Placement) == 0 {
					cur.Placement = cm.Placement
				}
				cur.Ports = appendUniqInt(cur.Ports, cm.Ports)
				cur.ServiceUnits = appendUniqStr(cur.ServiceUnits, cm.ServiceUnits)
				cur.ConfigPaths = appendUniqStr(cur.ConfigPaths, cm.ConfigPaths)
				cur.DataDirs = appendUniqStr(cur.DataDirs, cm.DataDirs)
				if cur.Evidence == "" {
					cur.Evidence = cm.Evidence
				}
				cur.Inferred = cur.Inferred && cm.Inferred
				byID[cid] = cur
			} else {
				byID[cid] = cm
				order = append(order, cid)
			}
		}
	}

	out := make([]mwpack.ImportedCompanion, 0, len(order))
	for _, cid := range order {
		out = append(out, byID[cid])
	}
	return out
}

func mergeImportDrafts(aiD, det importParseDraft) importParseDraft {
	out := aiD
	if out.Component == "" {
		out.Component = det.Component
	}
	if out.DisplayName == "" {
		out.DisplayName = det.DisplayName
	}
	if out.ExactVersion == "" {
		out.ExactVersion = det.ExactVersion
	}
	if out.Version == "" {
		out.Version = firstNonEmptyStr(det.Version, majorMinorVersion(out.ExactVersion, out.Component))
	}
	if out.Platform == "" {
		out.Platform = det.Platform
	}
	if out.OSDetail == "" {
		out.OSDetail = det.OSDetail
	}
	if out.DeployMethod == "" {
		out.DeployMethod = det.DeployMethod
	}
	if out.ArchSummary == "" {
		out.ArchSummary = det.ArchSummary
	}
	if len(out.Hosts) == 0 {
		out.Hosts = det.Hosts
	} else if len(det.Hosts) > 0 {
		// Backfill missing host disks from deterministic df -hT detection
		detDiskByIP := map[string]string{}
		fallbackDisk := ""
		for _, dh := range det.Hosts {
			if dh.Disk != "" {
				if dh.IP != "" {
					detDiskByIP[dh.IP] = dh.Disk
				}
				if fallbackDisk == "" {
					fallbackDisk = dh.Disk
				}
			}
		}
		for i := range out.Hosts {
			if out.Hosts[i].Disk == "" {
				if d := detDiskByIP[out.Hosts[i].IP]; d != "" {
					out.Hosts[i].Disk = d
				} else if fallbackDisk != "" {
					out.Hosts[i].Disk = fallbackDisk
				}
			}
		}
	}
	if len(out.ServiceUnits) == 0 {
		out.ServiceUnits = det.ServiceUnits
	}
	if len(out.ConfigPaths) == 0 {
		out.ConfigPaths = det.ConfigPaths
	}
	if len(out.DataDirs) == 0 {
		out.DataDirs = det.DataDirs
	}
	if len(out.LogDirs) == 0 {
		out.LogDirs = det.LogDirs
	}
	// Preserve deterministic packages if AI returned none or fewer
	if len(out.Packages) < len(det.Packages) {
		seen := map[string]bool{}
		for _, pk := range out.Packages {
			seen[pk.Name+"|"+pk.Version] = true
		}
		for _, pk := range det.Packages {
			if !seen[pk.Name+"|"+pk.Version] {
				out.Packages = append(out.Packages, pk)
			}
		}
	}
	if out.Hosts == nil {
		out.Hosts = []importHostInput{}
	}
	if out.Endpoints == nil {
		out.Endpoints = []mwpack.ImportedEndpoint{}
	} else {
		for i := range out.Endpoints {
			out.Endpoints[i].Role = normalizeImportEndpointRole(out.Endpoints[i].Role)
		}
	}
	if out.ServiceUnits == nil {
		out.ServiceUnits = []string{}
	}
	if out.ConfigPaths == nil {
		out.ConfigPaths = []string{}
	}
	if out.DataDirs == nil {
		out.DataDirs = []string{}
	}
	if out.LogDirs == nil {
		out.LogDirs = []string{}
	}
	if out.Params == nil {
		out.Params = map[string]any{}
	} else {
		// Remove noisy OS hardware attributes if AI placed them into middleware params
		for _, noise := range []string{"arch", "cpu_cores", "kernel", "mem", "hostname", "fqdn"} {
			delete(out.Params, noise)
		}
	}
	if out.Packages == nil {
		out.Packages = []mwpack.ImportedPkg{}
	}
	// Merge companions from AI + deterministic parser + final safety-net inference on merged metadata
	safetyCompanions := inferCompanionsFromSignals(companionSignals{
		PrimaryComp:  out.Component,
		Hosts:        out.Hosts,
		ServiceUnits: out.ServiceUnits,
		ConfigPaths:  out.ConfigPaths,
		DataDirs:     out.DataDirs,
		Packages:     out.Packages,
		ArchSummary:  out.ArchSummary,
		Notes:        out.Notes,
	})
	out.Companions = mergeCompanionLists(out.Component, out.Companions, det.Companions, safetyCompanions)
	return out
}

func normalizeImportEndpointRole(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "readonly", "ro", "read", "reader", "replica", "standby", "slave", "secondary", "follower":
		return "readonly"
	case "admin", "console", "mgmt", "management", "ui", "dashboard", "metrics", "monitor", "web":
		return "admin"
	case "readwrite", "rw", "write", "writer", "primary", "master", "leader", "client", "service", "":
		return "readwrite"
	default:
		return "readwrite"
	}
}

func inferPlatformFromOS(osStr string) string {
	low := strings.ToLower(osStr)
	switch {
	case strings.Contains(low, "ubuntu") && strings.Contains(low, "24.04"):
		return "ubuntu-24.04-amd64"
	case strings.Contains(low, "ubuntu") && strings.Contains(low, "22.04"):
		return "ubuntu-22.04-amd64"
	case (strings.Contains(low, "rocky") || strings.Contains(low, "red hat") || strings.Contains(low, "rhel") || strings.Contains(low, "alma") || strings.Contains(low, "centos")) && strings.Contains(low, "9"):
		return "el9-amd64"
	case (strings.Contains(low, "rocky") || strings.Contains(low, "red hat") || strings.Contains(low, "rhel") || strings.Contains(low, "alma") || strings.Contains(low, "centos")) && strings.Contains(low, "8"):
		return "el8-amd64"
	case strings.Contains(low, "debian") && strings.Contains(low, "12"):
		return "debian-12-amd64"
	case strings.Contains(low, "kylin"):
		return "kylin-v10-amd64"
	case strings.Contains(low, "openeuler"):
		return "openeuler-22.03-amd64"
	}
	return ""
}

func majorMinorVersion(exact, comp string) string {
	exact = strings.TrimSpace(exact)
	if exact == "" {
		return ""
	}
	parts := strings.Split(exact, ".")
	c := strings.ToLower(comp)
	if c == "postgresql" || c == "patroni" {
		return parts[0]
	}
	if len(parts) >= 2 {
		return parts[0] + "." + parts[1]
	}
	return parts[0]
}

func buildImportedDeployment(cat *mwpack.Catalog, req importClusterReq, user, now string) (*mwpack.Deployment, string, string, string, error) {
	cid := strings.TrimSpace(req.ID)
	if !docClusterID.MatchString(cid) {
		return nil, "", "", "", fmt.Errorf("集群标识只允许小写字母开头，由小写字母、数字和连字符组成（最多 41 位）")
	}
	compID := mwpack.NormalizeImportComponentID(firstNonEmptyStr(req.Component, req.DisplayName))
	preset, hasPreset := mwpack.LookupImportPreset(compID)

	inCatalog := false
	catTitle := ""
	catIcon := ""
	catColor := ""
	catCategory := ""
	if cat != nil {
		if c, ok := cat.Get(compID); ok && c.Kind != "external" {
			inCatalog = true
			catTitle = c.Title
			catIcon = c.Icon
			catColor = c.Color
			catCategory = c.Category
		}
	}

	displayName := firstNonEmptyStr(strings.TrimSpace(req.DisplayName), catTitle, preset.Name, compID)
	icon := firstNonEmptyStr(strings.TrimSpace(req.Icon), catIcon, preset.Icon, "server")
	color := firstNonEmptyStr(strings.TrimSpace(req.Color), catColor, preset.Color, "slate")
	category := firstNonEmptyStr(strings.TrimSpace(req.Category), catCategory, preset.Category, "middleware")
	ver := firstNonEmptyStr(strings.TrimSpace(req.Version), majorMinorVersion(req.ExactVersion, compID), "unknown")
	exactVer := strings.TrimSpace(req.ExactVersion)
	if exactVer == "" && ver != "unknown" {
		exactVer = ver
	}

	if len(req.Hosts) == 0 {
		return nil, "", "", "", fmt.Errorf("请至少填写 1 台集群主机节点")
	}
	var hosts []mwpack.Host
	placement := map[string][]string{}
	seenH := map[string]bool{}
	defaultRole := "node"
	if hasPreset && len(preset.Roles) > 0 {
		defaultRole = preset.Roles[0].ID
	}
	for i, h := range req.Hosts {
		hn := strings.TrimSpace(h.Name)
		hip := strings.TrimSpace(h.IP)
		if hn == "" && hip == "" {
			continue
		}
		if hn == "" {
			hn = fmt.Sprintf("node-%d", i+1)
		}
		if seenH[hn] {
			return nil, "", "", "", fmt.Errorf("主机名 %q 重复，请保证每个节点名称唯一", hn)
		}
		seenH[hn] = true
		hosts = append(hosts, mwpack.Host{Name: hn, IP: hip, Disk: strings.TrimSpace(h.Disk)})
		role := strings.TrimSpace(h.Role)
		if role == "" {
			role = defaultRole
		}
		placement[role] = append(placement[role], hn)
	}
	if len(hosts) == 0 {
		return nil, "", "", "", fmt.Errorf("请至少填写 1 台有效的主机节点")
	}

	sourceKind := strings.TrimSpace(req.SourceKind)
	if sourceKind != "manual" && sourceKind != "probe" && sourceKind != "ai_doc" {
		sourceKind = "manual"
	}
	deployMethod := strings.TrimSpace(req.DeployMethod)
	if deployMethod == "" {
		deployMethod = "systemd"
	}

	cleanSlice := func(in []string) []string {
		var out []string
		seen := map[string]bool{}
		for _, v := range in {
			t := strings.TrimSpace(v)
			if t != "" && !seen[t] {
				seen[t] = true
				out = append(out, t)
			}
		}
		return out
	}

	var endpoints []mwpack.ImportedEndpoint
	for _, ep := range req.Endpoints {
		addr := strings.TrimSpace(ep.Address)
		if addr == "" {
			continue
		}
		endpoints = append(endpoints, mwpack.ImportedEndpoint{
			Name:    strings.TrimSpace(ep.Name),
			Address: addr,
			Role:    normalizeImportEndpointRole(ep.Role),
		})
	}

	var pkgs []mwpack.ImportedPkg
	seenPk := map[string]bool{}
	for _, pk := range req.Packages {
		pn := strings.TrimSpace(pk.Name)
		pv := strings.TrimSpace(pk.Version)
		if pn == "" || pv == "" || seenPk[pn+"|"+pv] {
			continue
		}
		seenPk[pn+"|"+pv] = true
		role := strings.TrimSpace(pk.Role)
		if role == "" {
			role = "dependency"
		}
		pkgs = append(pkgs, mwpack.ImportedPkg{Name: pn, Version: pv, Role: role})
	}

	// Normalize companions & materialize topology companions as first-class InstanceSpecs.
	normCompanions := mergeCompanionLists(compID, req.Companions)
	allHostNames := make([]string, 0, len(hosts))
	validHostSet := map[string]bool{}
	for _, h := range hosts {
		allHostNames = append(allHostNames, h.Name)
		validHostSet[h.Name] = true
	}

	meta := &mwpack.ImportedMeta{
		SourceKind:        sourceKind,
		ManagedCatalog:    inCatalog,
		DisplayName:       displayName,
		Category:          category,
		Icon:              icon,
		Color:             color,
		DeployMethod:      deployMethod,
		ArchSummary:       strings.TrimSpace(req.ArchSummary),
		ExactVersion:      exactVer,
		OSDetail:          strings.TrimSpace(req.OSDetail),
		ServiceUnits:      cleanSlice(req.ServiceUnits),
		ConfigPaths:       cleanSlice(req.ConfigPaths),
		DataDirs:          cleanSlice(req.DataDirs),
		LogDirs:           cleanSlice(req.LogDirs),
		Endpoints:         endpoints,
		Companions:        normCompanions,
		Packages:          pkgs,
		Notes:             strings.TrimSpace(req.Notes),
		LastProbedAt:      strings.TrimSpace(req.LastProbedAt),
		BaselineUpdatedAt: now,
		BaselineUpdatedBy: user,
	}
	if sourceKind == "probe" && meta.LastProbedAt == "" {
		meta.LastProbedAt = now
	}

	instID := compID
	if cat != nil {
		if c, ok := cat.Get(compID); ok && c.Short != "" {
			instID = c.Short
		}
	}

	primParams := map[string]any{}
	for k, v := range req.Params {
		primParams[k] = v
	}
	// Populate canonical param aliases from discovered baseline paths/ports so KT operations commands
	// render real discovered directories & ports instead of raw template placeholders.
	if len(meta.DataDirs) > 0 {
		if _, ok := primParams["data_dir"]; !ok {
			primParams["data_dir"] = meta.DataDirs[0]
		}
	}
	if len(meta.LogDirs) > 0 {
		if _, ok := primParams["log_dir"]; !ok {
			primParams["log_dir"] = meta.LogDirs[0]
		}
	}
	primaryPort := 0
	if pVal, ok := primParams["port"]; ok {
		_, _ = fmt.Sscanf(fmt.Sprint(pVal), "%d", &primaryPort)
	}
	if primaryPort == 0 && len(meta.Endpoints) > 0 && meta.Endpoints[0].Address != "" {
		if _, pStr, err := net.SplitHostPort(strings.TrimSpace(meta.Endpoints[0].Address)); err == nil {
			_, _ = fmt.Sscanf(pStr, "%d", &primaryPort)
		}
	}
	if primaryPort > 0 {
		switch compID {
		case "redis":
			if _, ok := primParams["redis_port"]; !ok {
				primParams["redis_port"] = primaryPort
			}
		case "postgresql":
			if _, ok := primParams["pg_port"]; !ok {
				primParams["pg_port"] = primaryPort
			}
		case "etcd":
			if _, ok := primParams["client_port"]; !ok {
				primParams["client_port"] = primaryPort
			}
		}
	}

	instances := []mwpack.InstanceSpec{{
		ID:        instID,
		Component: compID,
		Version:   ver,
		Placement: placement,
		Params:    primParams,
	}}
	usedInstIDs := map[string]bool{instID: true}
	compInstID := map[string]string{compID: instID}

	for _, cm := range normCompanions {
		def, hasDef := mwpack.LookupCompanionDef(cm.Component)
		isTopo := true
		if cm.Kind == "backup" || cm.Kind == "monitoring" || cm.Kind == "os_component" || mwpack.IsExporterCompanion(cm.Component) || mwpack.IsOSCompanion(cm.Component) {
			isTopo = false
		} else if hasDef && !def.Topology {
			isTopo = false
		}
		if !isTopo {
			continue
		}

		cInstID := cm.Component
		if cat != nil {
			if c, ok := cat.Get(cm.Component); ok && c.Short != "" {
				cInstID = c.Short
			}
		}
		if usedInstIDs[cInstID] {
			cInstID = cm.Component
		}
		if usedInstIDs[cInstID] {
			cInstID = cm.Component + "-comp"
		}
		usedInstIDs[cInstID] = true
		compInstID[cm.Component] = cInstID

		cPlace := map[string][]string{}
		if len(cm.Placement) > 0 {
			for rk, hs := range cm.Placement {
				var keep []string
				for _, hn := range hs {
					if validHostSet[hn] {
						keep = append(keep, hn)
					}
				}
				if len(keep) > 0 {
					cPlace[rk] = keep
				}
			}
		}
		if len(cPlace) == 0 {
			if hasDef && def.InheritRoles && len(placement) > 0 {
				for rk, hs := range placement {
					cPlace[rk] = append([]string(nil), hs...)
				}
			} else {
				var targetHosts []string
				for _, hn := range cm.Hosts {
					if validHostSet[hn] {
						targetHosts = append(targetHosts, hn)
					}
				}
				if len(targetHosts) == 0 {
					targetHosts = append([]string(nil), allHostNames...)
				}
				rk := strings.TrimSpace(cm.Role)
				if rk == "" && hasDef {
					rk = def.DefaultRole
				}
				if rk == "" {
					rk = "node"
				}
				cPlace[rk] = targetHosts
			}
		}

		cParams := map[string]any{}
		if len(cm.ServiceUnits) > 0 {
			cParams["service_units"] = strings.Join(cm.ServiceUnits, ", ")
		}
		if len(cm.ConfigPaths) > 0 {
			cParams["config_paths"] = strings.Join(cm.ConfigPaths, ", ")
		}
		if len(cm.DataDirs) > 0 {
			cParams["data_dirs"] = strings.Join(cm.DataDirs, ", ")
		}
		instances = append(instances, mwpack.InstanceSpec{
			ID:        cInstID,
			Component: cm.Component,
			Version:   strings.TrimSpace(cm.Version),
			Placement: cPlace,
			Params:    cParams,
		})
	}

	// Wire cross-instance Uses (e.g. Patroni -> etcd DCS + PostgreSQL database; LB -> backend)
	dcsID := firstNonEmptyStr(compInstID["etcd"], compInstID["consul"], compInstID["zookeeper"])
	lbID := firstNonEmptyStr(compInstID["haproxy"], compInstID["nginx"], compInstID["pgbouncer"], compInstID["proxysql"])
	for i := range instances {
		sp := &instances[i]
		switch sp.Component {
		case "patroni":
			if sp.Uses == nil {
				sp.Uses = map[string]string{}
			}
			if compID == "postgresql" {
				sp.Uses["postgresql-database"] = instID
			}
			if dcsID != "" {
				sp.Uses["dcs"] = dcsID
			}
		case "postgresql":
			if dcsID != "" && compInstID["patroni"] == "" {
				if sp.Uses == nil {
					sp.Uses = map[string]string{}
				}
				sp.Uses["dcs"] = dcsID
			}
		case "haproxy", "nginx", "pgbouncer", "proxysql", "maxscale", "obproxy":
			if i > 0 {
				if sp.Uses == nil {
					sp.Uses = map[string]string{}
				}
				sp.Uses["backend"] = instID
			}
		case "keepalived":
			if i > 0 {
				if sp.Uses == nil {
					sp.Uses = map[string]string{}
				}
				sp.Uses["service"] = firstNonEmptyStr(lbID, instID)
			}
		}
	}

	dep := &mwpack.Deployment{
		Schema:       mwpack.DeploymentSchema,
		DeliveryMode: "imported",
		ID:           cid,
		Title:        strings.TrimSpace(req.Title),
		Controller:   hosts[0].Name,
		Platform:     strings.TrimSpace(req.Platform),
		Hosts:        hosts,
		Instances:    instances,
		Imported:     meta,
	}
	return dep, compID, displayName, ver, nil
}

func writeImportedPlanFiles(dir string, dep *mwpack.Deployment, plan *mwpack.Plan) error {
	outDir := filepath.Join(dir, "output")
	if err := os.MkdirAll(outDir, 0o700); err != nil {
		return err
	}
	specBytes, err := dep.YAML()
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "deployment.yml"), specBytes, 0o600); err != nil {
		return err
	}
	pv := plan.View()
	planDoc := map[string]any{
		"delivery_mode":  "imported",
		"step_format":    2,
		"cluster":        dep.ID,
		"project":        dep.ID,
		"controller":     plan.Controller,
		"platforms":      plan.Platforms,
		"hosts":          dep.Hosts,
		"instances":      pv.Instances,
		"imported":       dep.Imported,
		"prepare":        []any{},
		"deploy":         []any{},
		"tests":          []any{},
		"endpoint_tests": []any{},
		"cleanup":        []any{},
	}
	planBytes, err := json.MarshalIndent(planDoc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(outDir, "plan.json"), planBytes, 0o600)
}

func (s *storeServer) invalidateJobCaches(jobID string) {
	s.cacheMu.Lock()
	delete(s.specCache, jobID)
	delete(s.planCache, jobID)
	s.cacheMu.Unlock()
}

func (s *storeServer) importCluster(w http.ResponseWriter, r *http.Request, session storeSession) {
	if !s.need(w, session.User, "delivery.create") {
		return
	}
	var req importClusterReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
		s.fail(w, 400, "提交的纳管配置格式有误")
		return
	}
	now := nowStamp()
	dep, compID, displayName, ver, err := buildImportedDeployment(s.plat.cat(), req, session.User, now)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}

	s.jobPersistMu.Lock()
	defer s.jobPersistMu.Unlock()

	s.mu.Lock()
	if msg := s.clusterTaken(dep.ID); msg != "" {
		s.mu.Unlock()
		s.fail(w, 409, msg)
		return
	}
	jobID := randomStoreToken(16)
	plan := mwpack.SolveImported(s.plat.cat(), dep)
	j := storeJob{
		DeliveryMode: "imported",
		Scheme:       mwpack.ImportedSchemeSummary(dep),
		ID:           jobID,
		Owner:        session.User,
		AppID:        compID,
		AppName:      displayName,
		Version:      ver,
		ClusterID:    dep.ID,
		Seq:          0,
		State:        "succeeded",
		Stage:        "已纳管运行中",
		Outcome:      outcomeDone,
		Marked:       now,
		MarkedBy:     session.User,
		Created:      now,
		Updated:      now,
		Logs:         []string{fmt.Sprintf("[%s] 存量集群纳管建档完成（组件：%s %s，节点：%d 台）", now, displayName, ver, len(dep.Hosts))},
	}
	s.jobs[jobID] = j
	s.mu.Unlock()

	dir := s.jobDir(jobID)
	if err := writeImportedPlanFiles(dir, dep, plan); err != nil {
		s.removeFailedReservation(jobID)
		_ = os.RemoveAll(dir)
		s.fail(w, 500, "保存纳管基线文件失败："+err.Error())
		return
	}
	if err := s.persistJob(j); err != nil {
		s.removeFailedReservation(jobID)
		_ = os.RemoveAll(dir)
		s.fail(w, 500, "保存集群档案失败："+err.Error())
		return
	}

	s.auditReq(r, "cluster-import", session.User, fmt.Sprintf("%s (%s %s, %d hosts, source=%s)", dep.ID, compID, ver, len(dep.Hosts), dep.Imported.SourceKind))
	s.writeJSON(w, 201, map[string]any{
		"cluster_id": dep.ID,
		"job_id":     jobID,
		"component":  compID,
		"app_name":   displayName,
		"version":    ver,
		"imported":   dep.Imported,
	})
}

func (s *storeServer) handleClusterBaseline(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts) {
	dep := s.readSpec(f.Current.ID)
	if dep == nil || (dep.DeliveryMode != "imported" && f.Current.DeliveryMode != "imported") {
		s.fail(w, 400, "仅存量纳管集群支持在线编辑纳管基线档案")
		return
	}
	switch r.Method {
	case "GET":
		hosts := make([]importHostInput, 0, len(dep.Hosts))
		roleByHost := map[string]string{}
		if len(dep.Instances) > 0 {
			for rk, hs := range dep.Instances[0].Placement {
				for _, hn := range hs {
					if _, ok := roleByHost[hn]; !ok {
						roleByHost[hn] = rk
					}
				}
			}
		}
		for _, h := range dep.Hosts {
			hosts = append(hosts, importHostInput{Name: h.Name, IP: h.IP, Role: roleByHost[h.Name], Disk: h.Disk})
		}
		var params map[string]any
		compID := f.Current.AppID
		ver := f.Current.Version
		if len(dep.Instances) > 0 {
			params = dep.Instances[0].Params
			if dep.Instances[0].Component != "" {
				compID = dep.Instances[0].Component
			}
			if dep.Instances[0].Version != "" {
				ver = dep.Instances[0].Version
			}
		}
		if params == nil {
			params = map[string]any{}
		}
		meta := dep.Imported
		if meta == nil {
			meta = &mwpack.ImportedMeta{}
		}
		normEps := make([]mwpack.ImportedEndpoint, 0, len(meta.Endpoints))
		for _, ep := range meta.Endpoints {
			ep.Role = normalizeImportEndpointRole(ep.Role)
			normEps = append(normEps, ep)
		}
		companions := append([]mwpack.ImportedCompanion(nil), meta.Companions...)
		for i := range companions {
			if mwpack.IsOSCompanion(companions[i].Component) && (companions[i].Kind == "" || companions[i].Kind == "monitoring" || companions[i].Kind == "companion") {
				companions[i].Kind = "os_component"
			}
		}
		if len(companions) == 0 && len(dep.Instances) > 1 {
			for _, sp := range dep.Instances[1:] {
				def, hasDef := mwpack.LookupCompanionDef(sp.Component)
				cm := mwpack.ImportedCompanion{
					Component:   sp.Component,
					DisplayName: sp.Component,
					Version:     sp.Version,
					Placement:   sp.Placement,
				}
				if hasDef {
					cm.DisplayName = def.Name
					cm.Kind = def.Kind
					cm.Role = def.DefaultRole
					for _, dp := range def.DefaultPorts {
						cm.Ports = append(cm.Ports, dp.Port)
					}
				}
				companions = append(companions, cm)
			}
		}
		existingComp := map[string]bool{}
		for _, cm := range companions {
			existingComp[mwpack.NormalizeCompanionID(cm.Component)] = true
		}
		inferredAll := inferCompanionsFromSignals(companionSignals{
			PrimaryComp:  compID,
			Hosts:        hosts,
			ServiceUnits: meta.ServiceUnits,
			ConfigPaths:  meta.ConfigPaths,
			DataDirs:     meta.DataDirs,
			Packages:     meta.Packages,
			ArchSummary:  meta.ArchSummary,
			Notes:        meta.Notes,
		})
		var suggestedCompanions []mwpack.ImportedCompanion
		for _, cand := range inferredAll {
			if !existingComp[mwpack.NormalizeCompanionID(cand.Component)] {
				suggestedCompanions = append(suggestedCompanions, cand)
			}
		}
		outReq := importClusterReq{
			ID:                  dep.ID,
			Title:               dep.Title,
			Component:           compID,
			DisplayName:         firstNonEmptyStr(meta.DisplayName, f.Current.AppName),
			Category:            meta.Category,
			Icon:                meta.Icon,
			Color:               meta.Color,
			Version:             ver,
			ExactVersion:        meta.ExactVersion,
			Platform:            dep.Platform,
			OSDetail:            meta.OSDetail,
			SourceKind:          meta.SourceKind,
			DeployMethod:        meta.DeployMethod,
			ArchSummary:         meta.ArchSummary,
			Hosts:               hosts,
			Endpoints:           normEps,
			Companions:          companions,
			SuggestedCompanions: suggestedCompanions,
			ServiceUnits:        meta.ServiceUnits,
			ConfigPaths:         meta.ConfigPaths,
			DataDirs:            meta.DataDirs,
			LogDirs:             meta.LogDirs,
			Params:              params,
			Packages:            meta.Packages,
			Notes:               meta.Notes,
			LastProbedAt:        meta.LastProbedAt,
		}
		h := analyzeImportedBaselineHealth(compID, outReq.DisplayName, outReq, wLang(w))
		outReq.Health = &h
		s.writeJSON(w, 200, outReq)

	case "PUT":
		if !s.need(w, session.User, "delivery.create") {
			return
		}
		var req importClusterReq
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
			s.fail(w, 400, "基线配置格式有误")
			return
		}
		req.ID = f.ID
		if req.Component == "" {
			req.Component = f.Current.AppID
		}
		if dep.Imported != nil {
			if req.SourceKind == "" {
				req.SourceKind = dep.Imported.SourceKind
			}
			if req.LastProbedAt == "" {
				req.LastProbedAt = dep.Imported.LastProbedAt
			}
		}
		now := nowStamp()
		newDep, compID, displayName, ver, err := buildImportedDeployment(s.plat.cat(), req, session.User, now)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		plan := mwpack.SolveImported(s.plat.cat(), newDep)

		s.jobPersistMu.Lock()
		defer s.jobPersistMu.Unlock()
		if err := writeImportedPlanFiles(s.jobDir(f.Current.ID), newDep, plan); err != nil {
			s.fail(w, 500, "更新基线文件失败："+err.Error())
			return
		}
		s.invalidateJobCaches(f.Current.ID)

		s.mu.Lock()
		j := s.jobs[f.Current.ID]
		j.AppID = compID
		j.AppName = displayName
		j.Version = ver
		j.Scheme = mwpack.ImportedSchemeSummary(newDep)
		j.Updated = now
		j.Logs = append(j.Logs, fmt.Sprintf("[%s] %s 更新了存量纳管基线档案（版本：%s，节点：%d 台）", now, session.User, ver, len(newDep.Hosts)))
		s.mu.Unlock()
		if err := s.persistJob(j); err != nil {
			s.fail(w, 500, "保存更新后的集群信息失败")
			return
		}
		s.mu.Lock()
		s.jobs[j.ID] = j
		s.mu.Unlock()

		s.auditReq(r, "cluster-baseline-update", session.User, fmt.Sprintf("%s (%s %s, %d hosts)", f.ID, compID, ver, len(newDep.Hosts)))
		s.writeJSON(w, 200, map[string]any{
			"cluster_id": f.ID,
			"job_id":     j.ID,
			"version":    ver,
			"app_name":   displayName,
			"imported":   newDep.Imported,
		})

	default:
		s.fail(w, 405, "方法不允许")
	}
}

var (
	reRehDataDir    = regexp.MustCompile(`(?im)\bdata_directory\s*[|=:]\s*['"]?(/[a-zA-Z0-9._/@+-]+)['"]?`)
	reRehConfigFile = regexp.MustCompile(`(?im)\bconfig_file\s*[|=:]\s*['"]?(/[a-zA-Z0-9._/@+-]+)['"]?`)
	reRehLogDir     = regexp.MustCompile(`(?im)\blog_directory\s*[|=:]\s*['"]?(/[a-zA-Z0-9._/@+-]+)['"]?`)
	reRehKnownCfg   = regexp.MustCompile(`(?i)(/etc/(?:patroni/[^\s'";]+?\.ya?ml|pgbackrest/pgbackrest\.conf|pgbackrest\.conf|etcd/etcd\.conf(?:\.ya?ml)?|haproxy/haproxy\.cfg|keepalived/keepalived\.conf|pgbouncer/pgbouncer\.ini|redis/sentinel\.conf))`)
)

// enrichImportedBaselineFromEvidence incrementally merges newly observed facts from a change rehearsal's
// read-only probe output or confirmed production changes back into an imported cluster's baseline archive.
// It is strictly additive and non-destructive: existing user-curated fields are never wiped.
func (s *storeServer) enrichImportedBaselineFromEvidence(
	f clusterFacts,
	user, probeOut, manualState string,
	appliedChanges []rehearsalAppliedChange,
	sourceTitle, lang string,
) []string {
	if f.Current.ID == "" || f.Current.DeliveryMode != "imported" {
		return nil
	}
	dep := s.readSpec(f.Current.ID)
	if dep == nil || dep.DeliveryMode != "imported" {
		return nil
	}
	if dep.Imported == nil {
		dep.Imported = &mwpack.ImportedMeta{}
	}
	meta := dep.Imported

	compID := f.Current.AppID
	displayName := firstNonEmptyStr(meta.DisplayName, f.Current.AppName, compID)
	if len(dep.Instances) > 0 && dep.Instances[0].Component != "" {
		compID = dep.Instances[0].Component
	}
	preset, _ := mwpack.LookupImportPreset(compID)

	combined := strings.TrimSpace(probeOut)
	if m := strings.TrimSpace(manualState); m != "" {
		if combined != "" {
			combined += "\n" + m
		} else {
			combined = m
		}
	}

	var parsed importParseDraft
	if combined != "" {
		parsed = parseImportedDeterministic(combined, compID, displayName, preset)
		// Also extract paths from ad-hoc rehearsal probe outputs that omit === MW_IMPORT_* === markers
		for _, m := range reRehDataDir.FindAllStringSubmatch(combined, -1) {
			if len(m) == 2 {
				parsed.DataDirs = append(parsed.DataDirs, m[1])
			}
		}
		for _, m := range reRehConfigFile.FindAllStringSubmatch(combined, -1) {
			if len(m) == 2 {
				parsed.ConfigPaths = append(parsed.ConfigPaths, m[1])
			}
		}
		for _, m := range reRehLogDir.FindAllStringSubmatch(combined, -1) {
			if len(m) == 2 {
				parsed.LogDirs = append(parsed.LogDirs, m[1])
			}
		}
		for _, m := range reRehKnownCfg.FindAllStringSubmatch(combined, -1) {
			if len(m) == 2 {
				parsed.ConfigPaths = append(parsed.ConfigPaths, m[1])
			}
		}
	}

	var summary []string
	changed := false

	mergeStrSlice := func(dst *[]string, extra []string, zhLabel, enLabel string) {
		seen := map[string]bool{}
		for _, v := range *dst {
			t := strings.TrimSpace(v)
			if t != "" {
				seen[t] = true
			}
		}
		added := 0
		for _, v := range extra {
			t := strings.TrimSpace(v)
			if t != "" && !seen[t] {
				seen[t] = true
				*dst = append(*dst, t)
				added++
			}
		}
		if added > 0 {
			changed = true
			summary = append(summary, tr(lang, fmt.Sprintf("%s +%d", zhLabel, added), fmt.Sprintf("%s +%d", enLabel, added)))
		}
	}

	if parsed.ExactVersion != "" && (meta.ExactVersion == "" || (len(parsed.ExactVersion) > len(meta.ExactVersion) && strings.HasPrefix(parsed.ExactVersion, meta.ExactVersion))) {
		meta.ExactVersion = parsed.ExactVersion
		changed = true
		summary = append(summary, tr(lang, "精确版本 "+parsed.ExactVersion, "Exact version "+parsed.ExactVersion))
	}
	if parsed.OSDetail != "" && meta.OSDetail == "" {
		meta.OSDetail = parsed.OSDetail
		changed = true
		summary = append(summary, tr(lang, "操作系统详情", "OS detail"))
	}
	if parsed.Platform != "" && dep.Platform == "" {
		dep.Platform = parsed.Platform
		changed = true
	}

	mergeStrSlice(&meta.ServiceUnits, parsed.ServiceUnits, "服务单元", "Services")
	mergeStrSlice(&meta.ConfigPaths, parsed.ConfigPaths, "配置路径", "Config paths")
	mergeStrSlice(&meta.DataDirs, parsed.DataDirs, "数据目录", "Data dirs")
	mergeStrSlice(&meta.LogDirs, parsed.LogDirs, "日志目录", "Log dirs")

	// Fill missing data disk on hosts from newly observed storage output
	if len(parsed.Hosts) > 0 {
		diskByIP := map[string]string{}
		fallbackDisk := ""
		for _, ph := range parsed.Hosts {
			if ph.Disk != "" {
				if ph.IP != "" {
					diskByIP[ph.IP] = ph.Disk
				}
				if fallbackDisk == "" {
					fallbackDisk = ph.Disk
				}
			}
		}
		diskFilled := 0
		for i := range dep.Hosts {
			if strings.TrimSpace(dep.Hosts[i].Disk) == "" {
				if d := firstNonEmptyStr(diskByIP[dep.Hosts[i].IP], fallbackDisk); d != "" {
					dep.Hosts[i].Disk = d
					diskFilled++
				}
			}
		}
		if diskFilled > 0 {
			changed = true
			summary = append(summary, tr(lang, fmt.Sprintf("数据盘信息 +%d", diskFilled), fmt.Sprintf("Host disks +%d", diskFilled)))
		}
	}

	// Merge newly observed packages (avoiding duplicates; updating version if package upgraded)
	if len(parsed.Packages) > 0 {
		idxByName := map[string]int{}
		for i, pk := range meta.Packages {
			idxByName[strings.ToLower(pk.Name)] = i
		}
		pkgUpdates := 0
		for _, npk := range parsed.Packages {
			pn := strings.TrimSpace(npk.Name)
			pv := strings.TrimSpace(npk.Version)
			if pn == "" || pv == "" {
				continue
			}
			key := strings.ToLower(pn)
			if idx, ok := idxByName[key]; ok {
				if meta.Packages[idx].Version != pv {
					meta.Packages[idx].Version = pv
					pkgUpdates++
				}
			} else {
				idxByName[key] = len(meta.Packages)
				meta.Packages = append(meta.Packages, npk)
				pkgUpdates++
			}
		}
		if pkgUpdates > 0 {
			changed = true
			summary = append(summary, tr(lang, fmt.Sprintf("软件包清单 +%d", pkgUpdates), fmt.Sprintf("Packages +%d", pkgUpdates)))
		}
	}

	// Merge newly discovered companions or newly resolved companion versions (e.g. node_exporter version)
	if len(parsed.Companions) > 0 {
		prevByID := map[string]mwpack.ImportedCompanion{}
		for _, cm := range meta.Companions {
			prevByID[mwpack.NormalizeCompanionID(cm.Component)] = cm
		}
		mergedComps := mergeCompanionLists(compID, meta.Companions, parsed.Companions)
		compUpdated := 0
		for _, cm := range mergedComps {
			cid := mwpack.NormalizeCompanionID(cm.Component)
			prev, existed := prevByID[cid]
			if !existed || (prev.Version == "" && cm.Version != "") || len(cm.ConfigPaths) > len(prev.ConfigPaths) || len(cm.ServiceUnits) > len(prev.ServiceUnits) {
				compUpdated++
			}
		}
		if compUpdated > 0 {
			meta.Companions = mergedComps
			changed = true
			summary = append(summary, tr(lang, fmt.Sprintf("组件栈/版本 +%d", compUpdated), fmt.Sprintf("Stack/versions +%d", compUpdated)))
		}
	}

	// Merge newly observed params (fill missing only) & confirmed production applied changes (authoritative)
	if len(dep.Instances) > 0 {
		if dep.Instances[0].Params == nil {
			dep.Instances[0].Params = map[string]any{}
		}
		paramAdded := 0
		for k, v := range parsed.Params {
			if _, exists := dep.Instances[0].Params[k]; !exists {
				dep.Instances[0].Params[k] = v
				paramAdded++
			}
		}
		if paramAdded > 0 {
			changed = true
			summary = append(summary, tr(lang, fmt.Sprintf("运行参数 +%d", paramAdded), fmt.Sprintf("Params +%d", paramAdded)))
		}
		appliedUpdated := 0
		for _, ch := range appliedChanges {
			k := strings.TrimSpace(ch.Key)
			after := strings.TrimSpace(ch.After)
			if k == "" || after == "" {
				continue
			}
			curVal := fmt.Sprint(dep.Instances[0].Params[k])
			if curVal != after {
				dep.Instances[0].Params[k] = after
				appliedUpdated++
			}
		}
		if appliedUpdated > 0 {
			changed = true
			summary = append(summary, tr(lang, fmt.Sprintf("已落地变更参数 +%d", appliedUpdated), fmt.Sprintf("Applied params +%d", appliedUpdated)))
		}
	}

	if !changed {
		return nil
	}

	now := nowStamp()
	if strings.TrimSpace(probeOut) != "" {
		meta.LastProbedAt = now
	}
	meta.BaselineUpdatedAt = now
	meta.BaselineUpdatedBy = firstNonEmptyStr(user, "system")

	// Rebuild solved deployment & plan cleanly using the existing baseline structure
	hostsIn := make([]importHostInput, 0, len(dep.Hosts))
	roleByHost := map[string]string{}
	if len(dep.Instances) > 0 {
		for rk, hs := range dep.Instances[0].Placement {
			for _, hn := range hs {
				if _, ok := roleByHost[hn]; !ok {
					roleByHost[hn] = rk
				}
			}
		}
	}
	for _, h := range dep.Hosts {
		hostsIn = append(hostsIn, importHostInput{Name: h.Name, IP: h.IP, Role: roleByHost[h.Name], Disk: h.Disk})
	}
	var params map[string]any
	ver := f.Current.Version
	if len(dep.Instances) > 0 {
		params = dep.Instances[0].Params
		if dep.Instances[0].Version != "" {
			ver = dep.Instances[0].Version
		}
	}
	req := importClusterReq{
		ID:           dep.ID,
		Title:        dep.Title,
		Component:    compID,
		DisplayName:  displayName,
		Category:     meta.Category,
		Icon:         meta.Icon,
		Color:        meta.Color,
		Version:      ver,
		ExactVersion: meta.ExactVersion,
		Platform:     dep.Platform,
		OSDetail:     meta.OSDetail,
		SourceKind:   meta.SourceKind,
		DeployMethod: meta.DeployMethod,
		ArchSummary:  meta.ArchSummary,
		Hosts:        hostsIn,
		Endpoints:    meta.Endpoints,
		Companions:   meta.Companions,
		ServiceUnits: meta.ServiceUnits,
		ConfigPaths:  meta.ConfigPaths,
		DataDirs:     meta.DataDirs,
		LogDirs:      meta.LogDirs,
		Params:       params,
		Packages:     meta.Packages,
		Notes:        meta.Notes,
		LastProbedAt: meta.LastProbedAt,
	}
	newDep, _, _, newVer, err := buildImportedDeployment(s.plat.cat(), req, meta.BaselineUpdatedBy, now)
	if err != nil {
		return nil
	}
	plan := mwpack.SolveImported(s.plat.cat(), newDep)

	s.jobPersistMu.Lock()
	defer s.jobPersistMu.Unlock()
	if err := writeImportedPlanFiles(s.jobDir(f.Current.ID), newDep, plan); err != nil {
		return nil
	}
	s.invalidateJobCaches(f.Current.ID)

	s.mu.Lock()
	j := s.jobs[f.Current.ID]
	j.Version = newVer
	j.Scheme = mwpack.ImportedSchemeSummary(newDep)
	j.Updated = now
	j.Logs = append(j.Logs, fmt.Sprintf("[%s] 由变更演练「%s」自动反哺基线档案（%s）", now, firstNonEmptyStr(sourceTitle, "演练"), strings.Join(summary, "、")))
	s.mu.Unlock()
	if err := s.persistJob(j); err == nil {
		s.mu.Lock()
		s.jobs[j.ID] = j
		s.mu.Unlock()
	}
	return summary
}

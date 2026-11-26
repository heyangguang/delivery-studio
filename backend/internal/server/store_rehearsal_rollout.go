package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"delivery-studio/mwpack"
)

// rehearsalSourceRef records multi-cluster rollout provenance linking a pilot (origin)
// production-applied rehearsal with all target cluster rehearsals spawned from it.
type rehearsalSourceRef struct {
	RolloutID         string `json:"rollout_id"`
	IsOrigin          bool   `json:"is_origin,omitempty"`
	OriginClusterID   string `json:"origin_cluster_id"`
	OriginRehearsalID string `json:"origin_rehearsal_id"`
	OriginTitle       string `json:"origin_title,omitempty"`
	ImportMode        string `json:"import_mode,omitempty"` // "probe" | "steps"
	ImportedAt        string `json:"imported_at,omitempty"`
	ImportedBy        string `json:"imported_by,omitempty"`
	StepsRemapped     bool   `json:"steps_remapped,omitempty"`
	StrictPrecheck    bool   `json:"strict_precheck,omitempty"`
}

type propagateOriginSummary struct {
	ClusterID   string   `json:"cluster_id"`
	RehearsalID string   `json:"rehearsal_id"`
	Title       string   `json:"title"`
	AppID       string   `json:"app_id"`
	AppName     string   `json:"app_name"`
	Version     string   `json:"version"`
	Mode        string   `json:"mode"`
	SchemeID    string   `json:"scheme_id,omitempty"`
	SchemeName  string   `json:"scheme_name,omitempty"`
	Hosts       int      `json:"hosts"`
	AppliedAt   string   `json:"applied_at,omitempty"`
	AppliedBy   string   `json:"applied_by,omitempty"`
	RolloutID   string   `json:"rollout_id,omitempty"`
	ChangedKeys []string `json:"changed_keys,omitempty"`
}

type propagateTargetItem struct {
	ClusterID            string   `json:"cluster_id"`
	AppID                string   `json:"app_id"`
	AppName              string   `json:"app_name"`
	Version              string   `json:"version"`
	Hosts                int      `json:"hosts"`
	SchemeID             string   `json:"scheme_id,omitempty"`
	SchemeName           string   `json:"scheme_name,omitempty"`
	Deployed             bool     `json:"deployed"`
	MatchTier            string   `json:"match_tier"` // "exact" | "compatible"
	MatchReason          string   `json:"match_reason"`
	AllowSkipProbe       bool     `json:"allow_skip_probe"`
	SkipProbeBlockReason string   `json:"skip_probe_block_reason,omitempty"`
	AlreadyImported      bool     `json:"already_imported"`
	AlreadyEffective     bool     `json:"already_effective"`
	ConflictKeys         []string `json:"conflict_keys,omitempty"`
	ConflictSummary      string   `json:"conflict_summary,omitempty"`
	ExistingRehearsalID  string   `json:"existing_rehearsal_id,omitempty"`
	ExistingStage        string   `json:"existing_stage,omitempty"`
	ExistingApplied      bool     `json:"existing_applied,omitempty"`
	ExistingVoided       bool     `json:"existing_voided,omitempty"`
}

type rehearsalTemplateVariant struct {
	ClusterID            string `json:"cluster_id"`
	RehearsalID          string `json:"rehearsal_id"`
	RolloutID            string `json:"rollout_id,omitempty"`
	Title                string `json:"title"`
	Version              string `json:"version,omitempty"`
	SchemeName           string `json:"scheme_name,omitempty"`
	Hosts                int    `json:"hosts,omitempty"`
	AppliedAt            string `json:"applied_at,omitempty"`
	AppliedBy            string `json:"applied_by,omitempty"`
	MatchTier            string `json:"match_tier,omitempty"`
	AllowSkipProbe       bool   `json:"allow_skip_probe"`
	SkipProbeBlockReason string `json:"skip_probe_block_reason,omitempty"`
	IsOrigin             bool   `json:"is_origin,omitempty"`
	StepsCount           int    `json:"steps_count"`
}

type rehearsalTemplateItem struct {
	OriginClusterID      string                     `json:"origin_cluster_id"`
	OriginRehearsalID    string                     `json:"origin_rehearsal_id"`
	RolloutID            string                     `json:"rollout_id,omitempty"`
	Title                string                     `json:"title"`
	Goal                 string                     `json:"goal"`
	Mode                 string                     `json:"mode"`
	Category             string                     `json:"category,omitempty"`
	CategoryLabel        string                     `json:"category_label,omitempty"`
	ContentSignature     string                     `json:"content_signature,omitempty"`
	AppID                string                     `json:"app_id"`
	AppName              string                     `json:"app_name"`
	Version              string                     `json:"version"`
	SchemeID             string                     `json:"scheme_id,omitempty"`
	SchemeName           string                     `json:"scheme_name,omitempty"`
	Hosts                int                        `json:"hosts"`
	AppliedAt            string                     `json:"applied_at,omitempty"`
	AppliedBy            string                     `json:"applied_by,omitempty"`
	AppliedSummary       string                     `json:"applied_summary,omitempty"`
	AppliedChanges       []rehearsalAppliedChange   `json:"applied_changes,omitempty"`
	StepsCount           int                        `json:"steps_count"`
	RolloutTotal         int                        `json:"rollout_total,omitempty"`
	RolloutApplied       int                        `json:"rollout_applied,omitempty"`
	VerifiedClusters     []string                   `json:"verified_clusters,omitempty"`
	MergedCount          int                        `json:"merged_count,omitempty"`
	Variants             []rehearsalTemplateVariant `json:"variants,omitempty"`
	MatchTier            string                     `json:"match_tier,omitempty"`
	MatchReason          string                     `json:"match_reason,omitempty"`
	AllowSkipProbe       bool                       `json:"allow_skip_probe"`
	SkipProbeBlockReason string                     `json:"skip_probe_block_reason,omitempty"`
	AlreadyImported      bool                       `json:"already_imported"`
	AlreadyEffective     bool                       `json:"already_effective"`
	ConflictKeys         []string                   `json:"conflict_keys,omitempty"`
	ConflictSummary      string                     `json:"conflict_summary,omitempty"`
	ExistingRehearsalID  string                     `json:"existing_rehearsal_id,omitempty"`
}

type rolloutBoardMember struct {
	ClusterID       string `json:"cluster_id"`
	RehearsalID     string `json:"rehearsal_id"`
	IsOrigin        bool   `json:"is_origin"`
	AppName         string `json:"app_name"`
	Version         string `json:"version"`
	SchemeName      string `json:"scheme_name,omitempty"`
	Hosts           int    `json:"hosts"`
	MatchTier       string `json:"match_tier"` // "origin" | "exact" | "compatible"
	ImportMode      string `json:"import_mode,omitempty"`
	StrictPrecheck  bool   `json:"strict_precheck,omitempty"`
	Stage           string `json:"stage"`
	StatusKey       string `json:"status_key"` // applied | finalized_pending | rehearsing | probing | scoping | voided
	StepsDone       int    `json:"steps_done"`
	StepsTotal      int    `json:"steps_total"`
	Applied         bool   `json:"applied"`
	AppliedAt       string `json:"applied_at,omitempty"`
	AppliedBy       string `json:"applied_by,omitempty"`
	Voided          bool   `json:"voided"`
	VoidReason      string `json:"void_reason,omitempty"`
	DocID           string `json:"doc_id,omitempty"`
	ConflictCount   int    `json:"conflict_count"`
	ConflictSummary string `json:"conflict_summary,omitempty"`
	UpdatedAt       string `json:"updated_at"`
}

type rolloutBoardResponse struct {
	RolloutID         string               `json:"rollout_id"`
	OriginClusterID   string               `json:"origin_cluster_id"`
	OriginRehearsalID string               `json:"origin_rehearsal_id"`
	Title             string               `json:"title"`
	AppID             string               `json:"app_id"`
	AppName           string               `json:"app_name"`
	Total             int                  `json:"total"`
	Applied           int                  `json:"applied"`
	InProgress        int                  `json:"in_progress"`
	PendingProbe      int                  `json:"pending_probe"`
	FinalizedPending  int                  `json:"finalized_pending"`
	Attention         int                  `json:"attention"`
	Voided            int                  `json:"voided"`
	AvailableMore     int                  `json:"available_more"`
	NextPending       *rolloutBoardMember  `json:"next_pending,omitempty"`
	Members           []rolloutBoardMember `json:"members"`
}

var reRolloutID = regexp.MustCompile(`^ro-[a-f0-9]{8,24}$`)

var reMajorVerNum = regexp.MustCompile(`(?:^|[^0-9])(\d{1,3})(?:\.\d+|\b)`)

func majorVersionOf(v string) string {
	s := strings.TrimSpace(v)
	if s == "" {
		return ""
	}
	if m := reMajorVerNum.FindStringSubmatch(s); len(m) == 2 {
		return m[1]
	}
	s = strings.TrimPrefix(strings.ToLower(s), "v")
	for i, ch := range s {
		if ch == '.' || ch == '-' || ch == ' ' {
			return s[:i]
		}
	}
	return s
}

// canonicalCoreArch normalizes a cluster's core architecture identity across platform-deployed
// and imported clusters (ignoring peripheral observability/backup companions such as
// node_exporter, postgres_exporter, or pgBackRest) so two clusters with the same core middleware
// and HA orchestration (e.g. PostgreSQL + Patroni + etcd) are recognized as architecturally identical.
func canonicalCoreArch(f clusterFacts, dep *mwpack.Deployment, sc *mwpack.SchemeSummary, hostCount int) string {
	app := strings.ToLower(strings.TrimSpace(f.Current.AppID))
	if app == "" && dep != nil && len(dep.Instances) > 0 {
		app = strings.ToLower(strings.TrimSpace(dep.Instances[0].Component))
	}
	rawID := ""
	var textSignals []string
	if sc != nil {
		rawID = strings.ToLower(strings.TrimSpace(sc.ID))
		if rawID == "imported" {
			rawID = ""
		}
		if sc.Name != "" {
			textSignals = append(textSignals, strings.ToLower(sc.Name))
		}
		if sc.Contract != nil && sc.Contract.Mechanism != "" {
			textSignals = append(textSignals, strings.ToLower(sc.Contract.Mechanism))
		}
	}

	compSet := map[string]bool{}
	roleSet := map[string]bool{}
	hasPatroniPort := false
	if f.Plan != nil {
		for _, inst := range f.Plan.Instances {
			if inst.External {
				continue
			}
			c := strings.ToLower(strings.TrimSpace(inst.Component))
			if c != "" {
				compSet[c] = true
			}
			for rName, hs := range inst.Roles {
				if len(hs) > 0 {
					roleSet[strings.ToLower(strings.TrimSpace(rName))] = true
				}
			}
			for _, pt := range inst.Ports {
				if strings.Contains(strings.ToLower(pt.Name), "patroni") {
					hasPatroniPort = true
				}
			}
		}
	}
	if dep != nil {
		for _, inst := range dep.Instances {
			c := strings.ToLower(strings.TrimSpace(inst.Component))
			if c != "" {
				compSet[c] = true
			}
			for rName, hs := range inst.Placement {
				if len(hs) > 0 {
					roleSet[strings.ToLower(strings.TrimSpace(rName))] = true
				}
			}
		}
		if dep.Imported != nil {
			if dep.Imported.ArchSummary != "" {
				textSignals = append(textSignals, strings.ToLower(dep.Imported.ArchSummary))
			}
			for _, su := range dep.Imported.ServiceUnits {
				textSignals = append(textSignals, strings.ToLower(su))
			}
			for _, cm := range dep.Imported.Companions {
				// Peripheral monitoring, backup & OS exporter companions do not alter core HA architecture equivalence.
				if cm.Kind == "monitoring" || cm.Kind == "backup" || cm.Kind == "os_component" || cm.Kind == "exporter" {
					continue
				}
				if c := strings.ToLower(strings.TrimSpace(cm.Component)); c != "" {
					compSet[c] = true
				}
				if cm.DisplayName != "" {
					textSignals = append(textSignals, strings.ToLower(cm.DisplayName))
				}
			}
		}
	}
	joinedSignals := strings.Join(textSignals, " ")
	hasSignal := func(tok string) bool {
		if compSet[tok] {
			return true
		}
		return strings.Contains(joinedSignals, tok)
	}

	switch app {
	case "postgresql", "postgres":
		hasPatroni := rawID == "patroni" || hasPatroniPort || hasSignal("patroni") || (hostCount > 1 && hasSignal("etcd"))
		switch {
		case hostCount <= 1 || rawID == "single" || rawID == "basic":
			return "pg-single"
		case hasPatroni:
			return "pg-patroni"
		case hasSignal("repmgr"):
			return "pg-repmgr"
		case hasSignal("pgpool"):
			return "pg-pgpool"
		default:
			return "pg-replication"
		}
	case "redis":
		hasCluster := rawID == "cluster" || roleSet["cluster"] || strings.Contains(joinedSignals, "redis cluster") || strings.Contains(joinedSignals, "redis-cluster")
		hasSentinel := rawID == "standard" || rawID == "sentinel" || roleSet["sentinel"] || hasSignal("sentinel")
		switch {
		case hasCluster:
			return "redis-cluster"
		case hasSentinel:
			return "redis-sentinel"
		case hostCount <= 1 || rawID == "single" || rawID == "basic":
			return "redis-single"
		default:
			return "redis-replication"
		}
	case "etcd":
		if hostCount <= 1 || rawID == "single" || rawID == "basic" {
			return "etcd-single"
		}
		return "etcd-ha"
	case "nginx", "haproxy", "keepalived":
		if hostCount <= 1 || rawID == "single" || rawID == "basic" {
			return app + "-single"
		}
		return app + "-ha"
	default:
		if rawID != "" {
			if app != "" {
				return app + ":" + rawID
			}
			return rawID
		}
		if hostCount <= 1 {
			return app + "-single"
		}
		return app + "-ha"
	}
}

func canonicalArchDisplayName(schemeID, schemeName, lang string) string {
	sn := strings.TrimSpace(schemeName)
	generic := sn == "" || sn == "存量纳管" || strings.EqualFold(sn, "Imported") || sn == "历史部署架构"
	if !generic {
		return sn
	}
	switch schemeID {
	case "pg-patroni":
		return tr(lang, "PostgreSQL + Patroni 高可用", "PostgreSQL + Patroni HA")
	case "pg-single":
		return tr(lang, "PostgreSQL 单节点", "PostgreSQL Standalone")
	case "pg-repmgr":
		return tr(lang, "PostgreSQL + repmgr 高可用", "PostgreSQL + repmgr HA")
	case "pg-pgpool":
		return tr(lang, "PostgreSQL + Pgpool 高可用", "PostgreSQL + Pgpool HA")
	case "pg-replication":
		return tr(lang, "PostgreSQL 主从复制", "PostgreSQL Replication")
	case "redis-cluster":
		return tr(lang, "Redis Cluster 集群", "Redis Cluster")
	case "redis-sentinel":
		return tr(lang, "Redis 哨兵高可用", "Redis Sentinel HA")
	case "redis-single":
		return tr(lang, "Redis 单节点", "Redis Standalone")
	case "redis-replication":
		return tr(lang, "Redis 主从复制", "Redis Replication")
	case "etcd-ha":
		return tr(lang, "etcd 高可用集群", "etcd HA Cluster")
	case "etcd-single":
		return tr(lang, "etcd 单节点", "etcd Standalone")
	default:
		return firstNonEmptyStr(sn, schemeID, tr(lang, "未标注", "unspecified"))
	}
}

func (s *storeServer) clusterSchemeMeta(f clusterFacts, lang string) (schemeID, schemeName, version string, hostCount int, deployed bool) {
	dep := s.readSpec(f.Current.ID)
	sc := s.deliveryScheme(f.Current.ID, f.Current.AppID, f.Current.Scheme)
	if sc != nil {
		sc = mwpack.LocalizeSchemeSummary(lang, sc)
		schemeName = strings.TrimSpace(sc.Name)
	}
	version = s.deliveryAppVersion(f.Current.ID, f.Current.AppID, f.Current.Version)
	if version == "" && dep != nil && dep.Imported != nil {
		version = strings.TrimSpace(dep.Imported.ExactVersion)
	}
	if f.Plan != nil {
		hostCount = len(f.Plan.Hosts)
	} else if dep != nil {
		hostCount = len(dep.Hosts)
	}
	schemeID = canonicalCoreArch(f, dep, sc, hostCount)
	schemeName = canonicalArchDisplayName(schemeID, schemeName, lang)
	_, deployed = clusterHead(f.Jobs)
	return
}

func (s *storeServer) visibleClusterIDs(user string) []string {
	vis := s.visibleJobs(user)
	s.mu.Lock()
	seen := map[string]bool{}
	for _, j := range s.jobs {
		if j.ClusterID == "" || !j.live() || !vis(j.Owner) {
			continue
		}
		seen[j.ClusterID] = true
	}
	s.mu.Unlock()
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func rehearsalAppliedOrExtractedChanges(r changeRehearsal) []rehearsalAppliedChange {
	if len(r.AppliedChanges) > 0 {
		return r.AppliedChanges
	}
	_, chs := extractDefaultAppliedChanges(r)
	return chs
}

func rehearsalTouchedKeys(r changeRehearsal) []string {
	changes := rehearsalAppliedOrExtractedChanges(r)
	seen := map[string]bool{}
	var out []string
	for _, ch := range changes {
		k := strings.TrimSpace(ch.Key)
		if k == "" {
			continue
		}
		lk := strings.ToLower(k)
		if seen[lk] {
			continue
		}
		seen[lk] = true
		out = append(out, k)
	}
	return out
}

// normalizeChangeValue canonicalizes parameter/config values for content equivalence checks
// across independent clusters (trimming quotes/whitespace, lowercasing, and scrubbing cluster IDs).
func normalizeChangeValue(val, clusterID string) string {
	s := strings.TrimSpace(val)
	if s == "" {
		return ""
	}
	if len(s) >= 2 && ((s[0] == '\'' && s[len(s)-1] == '\'') || (s[0] == '"' && s[len(s)-1] == '"')) {
		s = strings.TrimSpace(s[1 : len(s)-1])
	}
	s = strings.ToLower(s)
	if cid := strings.ToLower(strings.TrimSpace(clusterID)); cid != "" {
		s = strings.ReplaceAll(s, cid, "<cluster>")
	}
	return strings.Join(strings.Fields(s), " ")
}

// rehearsalContentSignature produces a deterministic content fingerprint from normalized
// effective key=value deltas so identical production changes executed independently across
// different clusters (even with differently phrased AI titles) consolidate into one template.
func rehearsalContentSignature(r changeRehearsal, changes []rehearsalAppliedChange) string {
	if len(changes) == 0 {
		return ""
	}
	kv := map[string]string{}
	for _, ch := range changes {
		k := strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(ch.Key)), " "))
		if k == "" {
			continue
		}
		v := normalizeChangeValue(ch.After, r.ClusterID)
		if v == "" {
			continue
		}
		kv[k] = v
	}
	if len(kv) == 0 {
		return ""
	}
	keys := make([]string, 0, len(kv))
	for k := range kv {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(strings.ToLower(strings.TrimSpace(r.AppID)))
	b.WriteByte('\n')
	for _, k := range keys {
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(kv[k])
		b.WriteByte('\n')
	}
	sum := sha256.Sum256([]byte(b.String()))
	return "sig-" + hex.EncodeToString(sum[:8])
}

func rehearsalCategoryLabel(cat, lang string) string {
	switch cat {
	case "logging":
		return tr(lang, "日志与审计", "Logging & Audit")
	case "security":
		return tr(lang, "安全与认证", "Security & Auth")
	case "backup":
		return tr(lang, "备份与恢复", "Backup & Recovery")
	case "upgrade":
		return tr(lang, "升级与扩容", "Upgrade & Scaling")
	case "ha":
		return tr(lang, "高可用与切换", "HA & Failover")
	case "params":
		return tr(lang, "参数调优", "Parameter Tuning")
	default:
		return tr(lang, "日常运维", "Operations")
	}
}

func containsAnySubstr(hay string, needles ...string) bool {
	for _, n := range needles {
		if n != "" && strings.Contains(hay, n) {
			return true
		}
	}
	return false
}

// classifyRehearsalCategory assigns a consistent semantic category from modified keys first,
// then title/goal/summary keywords so users can filter templates cleanly across all middleware.
func classifyRehearsalCategory(r changeRehearsal, changes []rehearsalAppliedChange) string {
	if r.SecurityContext != nil {
		return "security"
	}
	var keyBuf strings.Builder
	for _, ch := range changes {
		keyBuf.WriteString(strings.ToLower(strings.TrimSpace(ch.Key)))
		keyBuf.WriteByte(' ')
		keyBuf.WriteString(strings.ToLower(strings.TrimSpace(ch.After)))
		keyBuf.WriteByte(' ')
	}
	keysHay := keyBuf.String()
	textHay := strings.ToLower(strings.Join([]string{r.Title, r.Goal, r.AppliedSummary}, " "))

	// 1. Check exact modified keys/values first (highest precision).
	if keysHay != "" {
		if containsAnySubstr(keysHay, "pg_hba", "hba", "ssl", "tls", "cert", "password", "requirepass", "acl", "scram", "md5", "auth", "cipher") {
			return "security"
		}
		if containsAnySubstr(keysHay, "logging_collector", "log_directory", "log_filename", "log_rotation", "log_min_", "log_statement", "slowlog", "audit", "syslog", "access_log", "error_log") {
			return "logging"
		}
		if containsAnySubstr(keysHay, "pgbackrest", "repo1", "archive_mode", "archive_command", "restore_command", "backup", "appendonly", "save ", "rdb", "aof") {
			return "backup"
		}
	}

	// 2. Fall back to title/goal/summary intent classification.
	if containsAnySubstr(textHay, "pg_hba", "cve", "漏洞", "tls", "ssl", "证书", "密码", "认证", "鉴权", "白名单", "防火墙", "权限", "安全修复", "security", "auth", "firewall") {
		return "security"
	}
	if containsAnySubstr(textHay, "日志", "轮转", "落盘", "慢查询日志", "审计", "log_directory", "logging", "slowlog", "audit") {
		return "logging"
	}
	if containsAnySubstr(textHay, "备份", "归档", "恢复", "快照", "pgbackrest", "wal", "backup", "restore", "archive", "snapshot", "repo1") {
		return "backup"
	}
	if containsAnySubstr(textHay, "升级", "扩容", "缩容", "迁移", "扩盘", "版本", "upgrade", "scale", "expand", "migrate", "patch") {
		return "upgrade"
	}
	if containsAnySubstr(textHay, "切主", "主从", "故障切换", "哨兵", "高可用", "脑裂", "quorum", "switchover", "failover", "sentinel", "keepalived", "vip", "haproxy", "patroni") {
		return "ha"
	}
	if len(changes) > 0 {
		return "params"
	}
	return "ops"
}

func (s *storeServer) evaluatePropagateTarget(
	originFacts clusterFacts,
	origin changeRehearsal,
	targetFacts clusterFacts,
	lang string,
) propagateTargetItem {
	oSchemeID, oSchemeName, oVer, oHosts, _ := s.clusterSchemeMeta(originFacts, lang)
	tSchemeID, tSchemeName, tVer, tHosts, tDeployed := s.clusterSchemeMeta(targetFacts, lang)

	sameShape := (oHosts <= 1) == (tHosts <= 1)
	sameScheme := sameShape && ((oSchemeID == "" && tSchemeID == "") || (oSchemeID != "" && oSchemeID == tSchemeID))
	sameMajor := majorVersionOf(oVer) == "" || majorVersionOf(tVer) == "" || majorVersionOf(oVer) == majorVersionOf(tVer)
	tier := "exact"
	var reasonParts []string
	if sameScheme && sameMajor {
		if tHosts > 0 {
			reasonParts = append(reasonParts, tr(lang, fmt.Sprintf("同架构同主版本 · %d 节点", tHosts), fmt.Sprintf("Same architecture & major version · %d node(s)", tHosts)))
		} else {
			reasonParts = append(reasonParts, tr(lang, "同架构同主版本", "Same architecture & major version"))
		}
	} else {
		tier = "compatible"
		if !sameScheme {
			reasonParts = append(reasonParts, tr(lang, fmt.Sprintf("架构不同（%s）", firstNonEmptyStr(tSchemeName, tSchemeID, "未标注")), fmt.Sprintf("Different architecture (%s)", firstNonEmptyStr(tSchemeName, tSchemeID, "unspecified"))))
		}
		if !sameMajor {
			reasonParts = append(reasonParts, tr(lang, fmt.Sprintf("主版本不同（%s vs %s）", tVer, oVer), fmt.Sprintf("Major version differs (%s vs %s)", tVer, oVer)))
		}
	}
	if !tDeployed {
		reasonParts = append(reasonParts, tr(lang, "首次部署尚未确认完成", "Initial deployment not confirmed yet"))
	}

	item := propagateTargetItem{
		ClusterID:   targetFacts.ID,
		AppID:       targetFacts.Current.AppID,
		AppName:     targetFacts.Current.AppName,
		Version:     tVer,
		Hosts:       tHosts,
		SchemeID:    tSchemeID,
		SchemeName:  tSchemeName,
		Deployed:    tDeployed,
		MatchTier:   tier,
		MatchReason: strings.Join(reasonParts, " · "),
	}

	rolloutID := ""
	if origin.Source != nil && origin.Source.RolloutID != "" {
		rolloutID = origin.Source.RolloutID
	} else {
		rolloutID = "ro-" + origin.ID
	}

	targetRehearsals := s.listRehearsals(targetFacts.ID)
	for _, trItem := range targetRehearsals {
		if trItem.Voided {
			continue
		}
		if trItem.Source != nil && (trItem.Source.RolloutID == rolloutID ||
			(trItem.Source.OriginClusterID == origin.ClusterID && trItem.Source.OriginRehearsalID == origin.ID)) {
			item.AlreadyImported = true
			item.ExistingRehearsalID = trItem.ID
			item.ExistingStage = trItem.Stage
			item.ExistingApplied = trItem.Applied
			item.ExistingVoided = trItem.Voided
			break
		}
	}

	// Check parameter conflicts & whether target cluster already has identical effective config.
	originChanges := rehearsalAppliedOrExtractedChanges(origin)
	originKeyMap := map[string]string{}
	for _, ch := range originChanges {
		if k := strings.TrimSpace(ch.Key); k != "" {
			originKeyMap[strings.ToLower(k)] = normalizeChangeValue(ch.After, origin.ClusterID)
		}
	}
	if len(originKeyMap) > 0 {
		// Compare against already effective applied changes on target cluster.
		targetApplied := s.listAppliedRehearsals(targetFacts.ID)
		targetEff := effectiveAppliedChanges(targetApplied)
		effMap := map[string]effectiveClusterChange{}
		for _, ef := range targetEff {
			effMap[strings.ToLower(strings.TrimSpace(ef.Key))] = ef
		}
		allMatched := len(originKeyMap) > 0
		conflictSet := map[string]string{}
		matchedSourceID := ""
		matchedSourceAt := ""
		for lk, wantAfter := range originKeyMap {
			if ef, has := effMap[lk]; has {
				if normalizeChangeValue(ef.After, targetFacts.ID) != wantAfter {
					allMatched = false
					conflictSet[lk] = ef.Key
				} else if ef.SourceID != "" && (matchedSourceID == "" || ef.AppliedAt > matchedSourceAt) {
					matchedSourceID = ef.SourceID
					matchedSourceAt = ef.AppliedAt
				}
			} else {
				allMatched = false
			}
		}
		if allMatched && !item.AlreadyImported {
			item.AlreadyEffective = true
			if item.ExistingRehearsalID == "" && matchedSourceID != "" {
				item.ExistingRehearsalID = matchedSourceID
				item.ExistingStage = "finalized"
				item.ExistingApplied = true
			}
		}
		// Also check pending finalized rehearsals on target cluster for overlapping keys.
		for _, pending := range targetRehearsals {
			if pending.Voided || pending.Applied || pending.Stage != "finalized" {
				continue
			}
			for _, pk := range rehearsalTouchedKeys(pending) {
				lk := strings.ToLower(pk)
				if _, hit := originKeyMap[lk]; hit {
					conflictSet[lk] = pk
				}
			}
		}
		if len(conflictSet) > 0 {
			for _, k := range conflictSet {
				item.ConflictKeys = append(item.ConflictKeys, k)
			}
			sort.Strings(item.ConflictKeys)
			item.ConflictSummary = tr(lang,
				fmt.Sprintf("目标集群存在同参数历史或待实施变更：%s", strings.Join(item.ConflictKeys, "、")),
				fmt.Sprintf("Target cluster has overlapping applied/pending parameter changes: %s", strings.Join(item.ConflictKeys, ", ")))
		}
	}

	// Safety guard for skipping standalone read-only probe ("steps" fast-track mode).
	switch {
	case !tDeployed:
		item.AllowSkipProbe = false
		item.SkipProbeBlockReason = tr(lang, "目标集群尚未确认首次部署完成，须先跑只读探针核实现场", "Initial deployment not confirmed; read-only probe required")
	case tier != "exact":
		item.AllowSkipProbe = false
		switch {
		case !sameScheme && !sameMajor:
			item.SkipProbeBlockReason = tr(lang,
				fmt.Sprintf("核心架构与主版本均与样板不同（%s / %s vs %s / %s），须先跑只读探针核实现场", firstNonEmptyStr(tSchemeName, tSchemeID), firstNonEmptyStr(tVer, "未知"), firstNonEmptyStr(oSchemeName, oSchemeID), firstNonEmptyStr(oVer, "未知")),
				fmt.Sprintf("Architecture & major version differ (%s / %s vs %s / %s); read-only probe required", firstNonEmptyStr(tSchemeName, tSchemeID), firstNonEmptyStr(tVer, "unknown"), firstNonEmptyStr(oSchemeName, oSchemeID), firstNonEmptyStr(oVer, "unknown")))
		case !sameScheme:
			item.SkipProbeBlockReason = tr(lang,
				fmt.Sprintf("核心架构与样板集群不同（当前：%s，样板：%s），须先跑只读探针核实现场", firstNonEmptyStr(tSchemeName, tSchemeID), firstNonEmptyStr(oSchemeName, oSchemeID)),
				fmt.Sprintf("Core architecture differs (target: %s vs pilot: %s); read-only probe required", firstNonEmptyStr(tSchemeName, tSchemeID), firstNonEmptyStr(oSchemeName, oSchemeID)))
		default:
			item.SkipProbeBlockReason = tr(lang,
				fmt.Sprintf("主版本与样板集群不同（当前：%s，样板：%s），须先跑只读探针核实现场", firstNonEmptyStr(tVer, "未知"), firstNonEmptyStr(oVer, "未知")),
				fmt.Sprintf("Major version differs (target: %s vs pilot: %s); read-only probe required", firstNonEmptyStr(tVer, "unknown"), firstNonEmptyStr(oVer, "unknown")))
		}
	case len(item.ConflictKeys) > 0:
		item.AllowSkipProbe = false
		item.SkipProbeBlockReason = tr(lang, "目标集群存在同参数冲突变更，须先跑只读探针核实当前生效值", "Overlapping parameter changes detected; read-only probe required")
	case item.AlreadyEffective:
		item.AllowSkipProbe = false
		item.SkipProbeBlockReason = tr(lang, "目标集群似乎已生效相同配置，建议先跑只读探针确认现状", "Identical parameters appear already effective; verify via probe first")
	default:
		item.AllowSkipProbe = true
	}
	return item
}

type clusterEndpointInfo struct {
	Component string
	Name      string
	Role      string // "readwrite" | "readonly" | "admin" | ""
	Host      string
	Port      int
	ResolveIP string
}

type endpointRemapRule struct {
	OldHost       string
	OldPort       int
	OldResolveIP  string
	NewHost       string
	NewPort       int
	NewResolveIP  string
	MissingTarget bool
}

type remapToken struct {
	From     string
	To       string
	Boundary string // "" | "ip" | "word"
}

type clusterRemapper struct {
	originID              string
	targetID              string
	allOrigIPs            map[string]bool // all origin host IPs (for recognizing IP-set regexes/braces)
	origOnlyIPs           []string        // origin host IPs NOT present on target cluster (for leak audit)
	targetIPSet           map[string]bool
	origAddrs             []string // origin-only endpoint/VIP domains (for leak audit)
	tokens                []remapToken
	endpointRules         []endpointRemapRule
	targetIPToName        map[string]string
	targetIPs             []string
	targetSlug            string
	originLocalPGPort     int
	targetLocalPGPort     int
	missingTargetEndpoint bool
	missingEndpointHosts  []string
	lang                  string
}

type ipSetMatcher struct {
	sep      string
	re3      *regexp.Regexp
	re2      *regexp.Regexp
	re1      *regexp.Regexp
	reFullP  *regexp.Regexp
	reFullNP *regexp.Regexp
}

var (
	reAwkSubnetIPGroup  = regexp.MustCompile(`(\d{1,3}\\\.\d{1,3}\\\.\d{1,3}\\\.\(\d{1,3}(?:\|\d{1,3})+\))`)
	reAwkFullIPGroup    = regexp.MustCompile(`(\(\d{1,3}\\\.\d{1,3}\\\.\d{1,3}\\\.\d{1,3}(?:\|\d{1,3}\\\.\d{1,3}\\\.\d{1,3}\\\.\d{1,3})+\))`)
	compiledIPSetMatchers = func() []ipSetMatcher {
		seps := []string{`\\.`, `\.`, `.`}
		out := make([]ipSetMatcher, 0, len(seps))
		for _, sep := range seps {
			q := regexp.QuoteMeta(sep)
			ipPat := `\d{1,3}` + q + `\d{1,3}` + q + `\d{1,3}` + q + `\d{1,3}`
			out = append(out, ipSetMatcher{
				sep:      sep,
				re3:      regexp.MustCompile(`(\d{1,3})` + q + `(\d{1,3})` + q + `(\d{1,3})` + q + `\((?:\?:)?(\d{1,3}(?:\|\d{1,3})+)\)`),
				re2:      regexp.MustCompile(`(\d{1,3})` + q + `(\d{1,3})` + q + `\((?:\?:)?(\d{1,3}` + q + `\d{1,3}(?:\|\d{1,3}` + q + `\d{1,3})+)\)`),
				re1:      regexp.MustCompile(`(\d{1,3})` + q + `\((?:\?:)?(\d{1,3}` + q + `\d{1,3}` + q + `\d{1,3}(?:\|\d{1,3}` + q + `\d{1,3}` + q + `\d{1,3})+)\)`),
				reFullP:  regexp.MustCompile(`\((?:\?:)?(` + ipPat + `(?:\|` + ipPat + `)+)\)`),
				reFullNP: regexp.MustCompile(`(` + ipPat + `(?:\|` + ipPat + `)+)`),
			})
		}
		return out
	}()
	reIPBrace3          = regexp.MustCompile(`(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\{(\d{1,3}(?:,\d{1,3})+)\}`)
	reIPBraceFull       = regexp.MustCompile(`\{(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:,\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})+)\}`)
	reLogVerifySlug     = regexp.MustCompile(`(^|[^a-z0-9_])([a-z][a-z0-9]{1,31})(_log_verify)`)
	reOrphanNodeIPPair  = regexp.MustCompile(`\b(00[1-9])\s*/\s*(\d{1,3}(?:\.\d{1,3}){3})\b`)
	rePortFlagSpace     = regexp.MustCompile(`(-p[ \t]+)(\d{2,5})\b`)
	rePortEquals        = regexp.MustCompile(`\b(port=)(\d{2,5})\b`)
	reLongPortOpt       = regexp.MustCompile(`(--port(?:=|[ \t]+))(\d{2,5})\b`)
	rePortProseCN       = regexp.MustCompile(`(端口[：:\s]*)(\d{2,5})\b`)
	reStrictExpectStrip = regexp.MustCompile(`(?s)^1\)\s*(?:节点名/IP 与本集群基线|Hostname/IP matches target cluster baseline).*?(?:补充核对：|Additional check:\s*)`)
)

func splitEndpointHostPort(raw string) (string, int) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", 0
	}
	if strings.Contains(s, "://") {
		if idx := strings.Index(s, "://"); idx >= 0 {
			s = s[idx+3:]
		}
		if slash := strings.IndexByte(s, '/'); slash >= 0 {
			s = s[:slash]
		}
	}
	if h, pStr, err := net.SplitHostPort(s); err == nil {
		p, _ := strconv.Atoi(strings.TrimSpace(pStr))
		return strings.TrimSpace(h), p
	}
	return s, 0
}

func normalizeEndpointRole(name, role string) string {
	r := strings.ToLower(strings.TrimSpace(role))
	switch r {
	case "readwrite", "rw", "writer", "primary", "master":
		return "readwrite"
	case "readonly", "ro", "reader", "replica", "standby":
		return "readonly"
	case "admin", "manage", "management":
		return "admin"
	}
	n := strings.ToLower(strings.TrimSpace(name))
	switch {
	case strings.Contains(n, "read") && !strings.Contains(n, "write"):
		return "readonly"
	case strings.Contains(n, "ro") && n != "patroni":
		return "readonly"
	case n == "writer" || n == "eip" || n == "vip" || n == "elb" || n == "lb" || n == "primary" || strings.Contains(n, "write") || strings.Contains(n, "rw"):
		return "readwrite"
	}
	return "readwrite"
}

func extractClusterEndpoints(f clusterFacts, dep *mwpack.Deployment) []clusterEndpointInfo {
	var out []clusterEndpointInfo
	seen := map[string]bool{}
	add := func(ep clusterEndpointInfo) {
		ep.Host = strings.TrimSpace(ep.Host)
		if ep.Host == "" {
			return
		}
		key := strings.ToLower(ep.Host) + ":" + strconv.Itoa(ep.Port)
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, ep)
	}
	if f.Plan != nil {
		for _, inst := range f.Plan.Instances {
			if len(inst.Fronts) == 0 {
				continue
			}
			names := make([]string, 0, len(inst.Fronts))
			for k := range inst.Fronts {
				names = append(names, k)
			}
			sort.Strings(names)
			for _, epName := range names {
				fr := inst.Fronts[epName]
				h, p := splitEndpointHostPort(fr.Address)
				if fr.Listen > 0 {
					p = fr.Listen
				}
				add(clusterEndpointInfo{
					Component: strings.ToLower(strings.TrimSpace(inst.Component)),
					Name:      strings.ToLower(strings.TrimSpace(epName)),
					Role:      normalizeEndpointRole(epName, ""),
					Host:      h,
					Port:      p,
					ResolveIP: strings.TrimSpace(fr.ResolveIP),
				})
			}
		}
	}
	if dep != nil && dep.Imported != nil {
		app := strings.ToLower(strings.TrimSpace(f.Current.AppID))
		for _, ie := range dep.Imported.Endpoints {
			h, p := splitEndpointHostPort(ie.Address)
			add(clusterEndpointInfo{
				Component: app,
				Name:      strings.ToLower(strings.TrimSpace(ie.Name)),
				Role:      normalizeEndpointRole(ie.Name, ie.Role),
				Host:      h,
				Port:      p,
			})
		}
	}
	return out
}

func hostRoleRank(hostName string, f clusterFacts, dep *mwpack.Deployment) int {
	app := strings.ToLower(strings.TrimSpace(f.Current.AppID))
	best := 2
	checkRoles := func(roles map[string][]string) {
		for rName, hs := range roles {
			rn := strings.ToLower(strings.TrimSpace(rName))
			rank := 2
			switch rn {
			case "primary", "leader", "master", "writer":
				rank = 0
			case "replica", "standby", "slave", "quorum", "quorum standby", "sync_standby":
				rank = 1
			}
			for _, h := range hs {
				if strings.EqualFold(strings.TrimSpace(h), hostName) && rank < best {
					best = rank
				}
			}
		}
	}
	if f.Plan != nil {
		for _, inst := range f.Plan.Instances {
			if inst.External {
				continue
			}
			if app != "" && !strings.EqualFold(inst.Component, app) && inst.Component != "patroni" {
				continue
			}
			checkRoles(inst.Roles)
		}
	}
	if dep != nil {
		for _, inst := range dep.Instances {
			if app != "" && !strings.EqualFold(inst.Component, app) && inst.Component != "patroni" {
				continue
			}
			checkRoles(inst.Placement)
		}
		if dep.Imported != nil {
			for _, cm := range dep.Imported.Companions {
				if strings.EqualFold(cm.Component, "patroni") {
					checkRoles(cm.Placement)
				}
			}
		}
	}
	return best
}

func alignedClusterHosts(f clusterFacts, dep *mwpack.Deployment) []mwpack.Host {
	var raw []mwpack.Host
	if f.Plan != nil && len(f.Plan.Hosts) > 0 {
		raw = append(raw, f.Plan.Hosts...)
	} else if dep != nil {
		for _, h := range dep.Hosts {
			raw = append(raw, mwpack.Host{Name: h.Name, IP: h.IP})
		}
	}
	type rankedHost struct {
		h    mwpack.Host
		rank int
		idx  int
	}
	items := make([]rankedHost, len(raw))
	for i, h := range raw {
		items[i] = rankedHost{h: h, rank: hostRoleRank(h.Name, f, dep), idx: i}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].rank != items[j].rank {
			return items[i].rank < items[j].rank
		}
		return items[i].idx < items[j].idx
	})
	out := make([]mwpack.Host, len(items))
	for i, it := range items {
		out[i] = it.h
	}
	return out
}

func clusterPatroniConfigPath(f clusterFacts, dep *mwpack.Deployment) string {
	if dep != nil && dep.Imported != nil {
		for _, cm := range dep.Imported.Companions {
			if strings.EqualFold(cm.Component, "patroni") {
				for _, p := range cm.ConfigPaths {
					if strings.HasSuffix(p, ".yml") || strings.HasSuffix(p, ".yaml") {
						return strings.TrimSpace(p)
					}
				}
			}
		}
		for _, p := range dep.Imported.ConfigPaths {
			lp := strings.ToLower(p)
			if strings.Contains(lp, "patroni") && (strings.HasSuffix(lp, ".yml") || strings.HasSuffix(lp, ".yaml")) {
				return strings.TrimSpace(p)
			}
		}
	}
	if dep != nil {
		for _, inst := range dep.Instances {
			if strings.EqualFold(inst.Component, "patroni") {
				if v, ok := inst.Params["config_paths"].(string); ok {
					for _, part := range strings.Split(v, ",") {
						p := strings.TrimSpace(part)
						if strings.HasSuffix(p, ".yml") || strings.HasSuffix(p, ".yaml") {
							return p
						}
					}
				}
			}
		}
	}
	return "/etc/patroni/patroni.yml"
}

func clusterLocalPGPort(f clusterFacts, dep *mwpack.Deployment) int {
	parsePort := func(v any) int {
		switch x := v.(type) {
		case int:
			if x > 0 && x <= 65535 {
				return x
			}
		case float64:
			if int(x) > 0 && int(x) <= 65535 {
				return int(x)
			}
		case string:
			if n, err := strconv.Atoi(strings.TrimSpace(x)); err == nil && n > 0 && n <= 65535 {
				return n
			}
		}
		return 0
	}
	if dep != nil {
		for _, inst := range dep.Instances {
			if strings.EqualFold(inst.Component, "postgresql") {
				if p := parsePort(inst.Params["pg_port"]); p > 0 {
					return p
				}
				if p := parsePort(inst.Params["port"]); p > 0 {
					return p
				}
			}
		}
	}
	if f.Plan != nil {
		for _, inst := range f.Plan.Instances {
			if strings.EqualFold(inst.Component, "postgresql") {
				for _, pt := range inst.Ports {
					ln := strings.ToLower(pt.Name)
					if (ln == "postgresql" || ln == "postgres" || ln == "pg") && pt.Port > 0 {
						return pt.Port
					}
				}
			}
		}
	}
	return 5432
}

func clusterPGDataDir(dep *mwpack.Deployment) string {
	if dep == nil {
		return ""
	}
	for _, inst := range dep.Instances {
		if strings.EqualFold(inst.Component, "postgresql") {
			if v, ok := inst.Params["data_dir"].(string); ok && strings.HasPrefix(strings.TrimSpace(v), "/") {
				return strings.TrimSpace(v)
			}
		}
	}
	if dep.Imported != nil {
		for _, d := range dep.Imported.DataDirs {
			ld := strings.ToLower(strings.TrimSpace(d))
			if strings.HasPrefix(ld, "/") && (strings.Contains(ld, "pg") || strings.Contains(ld, "postgres")) && !strings.Contains(ld, "backup") && !strings.Contains(ld, "pgbackrest") {
				return strings.TrimSpace(d)
			}
		}
	}
	return ""
}

func extractClusterSlug(clusterID string) string {
	generic := map[string]bool{
		"pg": true, "postgres": true, "postgresql": true, "redis": true, "etcd": true,
		"nginx": true, "haproxy": true, "keepalived": true, "mysql": true, "mongo": true,
		"prod": true, "production": true, "dev": true, "test": true, "qa": true, "uat": true, "stg": true, "staging": true,
		"private": true, "public": true, "internal": true, "external": true,
		"ha": true, "cluster": true, "db": true, "node": true, "svc": true, "app": true,
	}
	parts := strings.FieldsFunc(strings.ToLower(strings.TrimSpace(clusterID)), func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= '0' && r <= '9')
	})
	for _, p := range parts {
		if len(p) >= 2 && !generic[p] {
			return p
		}
	}
	return ""
}

func normalizeIPv4(raw string) ([4]string, string, bool) {
	ip := net.ParseIP(strings.TrimSpace(raw))
	if ip == nil {
		return [4]string{}, "", false
	}
	v4 := ip.To4()
	if v4 == nil {
		return [4]string{}, "", false
	}
	oct := [4]string{
		strconv.Itoa(int(v4[0])),
		strconv.Itoa(int(v4[1])),
		strconv.Itoa(int(v4[2])),
		strconv.Itoa(int(v4[3])),
	}
	return oct, fmt.Sprintf("%d.%d.%d.%d", v4[0], v4[1], v4[2], v4[3]), true
}

func formatTargetIPSetRegex(targetIPs []string, dotSep string) string {
	if len(targetIPs) == 0 {
		return ""
	}
	parsed := make([][4]string, 0, len(targetIPs))
	for _, raw := range targetIPs {
		if oct, _, ok := normalizeIPv4(raw); ok {
			parsed = append(parsed, oct)
		}
	}
	if len(parsed) == 0 {
		return ""
	}
	if len(parsed) == 1 {
		o := parsed[0]
		return o[0] + dotSep + o[1] + dotSep + o[2] + dotSep + o[3]
	}
	same3 := true
	same2 := true
	for i := 1; i < len(parsed); i++ {
		if parsed[i][0] != parsed[0][0] || parsed[i][1] != parsed[0][1] {
			same2 = false
			same3 = false
			break
		}
		if parsed[i][2] != parsed[0][2] {
			same3 = false
		}
	}
	if same3 {
		last := make([]string, len(parsed))
		for i, o := range parsed {
			last[i] = o[3]
		}
		return parsed[0][0] + dotSep + parsed[0][1] + dotSep + parsed[0][2] + dotSep + "(" + strings.Join(last, "|") + ")"
	}
	if same2 {
		tail := make([]string, len(parsed))
		for i, o := range parsed {
			tail[i] = o[2] + dotSep + o[3]
		}
		return parsed[0][0] + dotSep + parsed[0][1] + dotSep + "(" + strings.Join(tail, "|") + ")"
	}
	full := make([]string, len(parsed))
	for i, o := range parsed {
		full[i] = o[0] + dotSep + o[1] + dotSep + o[2] + dotSep + o[3]
	}
	return "(" + strings.Join(full, "|") + ")"
}

func formatTargetIPSetBrace(targetIPs []string) string {
	if len(targetIPs) == 0 {
		return ""
	}
	parsed := make([][4]string, 0, len(targetIPs))
	for _, raw := range targetIPs {
		if oct, _, ok := normalizeIPv4(raw); ok {
			parsed = append(parsed, oct)
		}
	}
	if len(parsed) == 0 {
		return ""
	}
	if len(parsed) == 1 {
		o := parsed[0]
		return o[0] + "." + o[1] + "." + o[2] + "." + o[3]
	}
	same3 := true
	for i := 1; i < len(parsed); i++ {
		if parsed[i][0] != parsed[0][0] || parsed[i][1] != parsed[0][1] || parsed[i][2] != parsed[0][2] {
			same3 = false
			break
		}
	}
	if same3 {
		last := make([]string, len(parsed))
		for i, o := range parsed {
			last[i] = o[3]
		}
		return parsed[0][0] + "." + parsed[0][1] + "." + parsed[0][2] + ".{" + strings.Join(last, ",") + "}"
	}
	return "{" + strings.Join(targetIPs, ",") + "}"
}

func escapeIPv4ForRegex(ip string) string {
	return strings.ReplaceAll(strings.TrimSpace(ip), ".", `\.`)
}

func buildTargetIPv4Regex(ips []string) string {
	return formatTargetIPSetRegex(ips, `\.`)
}

func extractClusterClientCIDRs(f clusterFacts) []string {
	if f.Plan == nil {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for _, inst := range f.Plan.Instances {
		if inst.Params == nil {
			continue
		}
		if cidr := strings.TrimSpace(fmt.Sprint(inst.Params["client_cidr"])); cidr != "" && cidr != "<nil>" && strings.Contains(cidr, "/") && !seen[cidr] {
			seen[cidr] = true
			out = append(out, cidr)
		}
	}
	return out
}

func (s *storeServer) newClusterRemapper(originFacts, targetFacts clusterFacts, lang string) *clusterRemapper {
	return buildClusterRemapperWithDeps(
		originFacts,
		targetFacts,
		s.readSpec(originFacts.Current.ID),
		s.readSpec(targetFacts.Current.ID),
		lang,
	)
}

func buildClusterRemapperWithDeps(originFacts, targetFacts clusterFacts, oDep, tDep *mwpack.Deployment, lang string) *clusterRemapper {
	r := &clusterRemapper{
		originID:          strings.TrimSpace(originFacts.ID),
		targetID:          strings.TrimSpace(targetFacts.ID),
		allOrigIPs:        map[string]bool{},
		targetIPSet:       map[string]bool{},
		targetIPToName:    map[string]string{},
		targetSlug:        extractClusterSlug(targetFacts.ID),
		originLocalPGPort: clusterLocalPGPort(originFacts, oDep),
		targetLocalPGPort: clusterLocalPGPort(targetFacts, tDep),
		lang:              lang,
	}
	seen := map[string]bool{}
	add := func(from, to, boundary string) {
		from = strings.TrimSpace(from)
		to = strings.TrimSpace(to)
		if from == "" || to == "" || from == to || seen[from] {
			return
		}
		seen[from] = true
		r.tokens = append(r.tokens, remapToken{From: from, To: to, Boundary: boundary})
	}
	addIPVariants := func(fromIP, toIP string) {
		fromIP = strings.TrimSpace(fromIP)
		toIP = strings.TrimSpace(toIP)
		if fromIP == "" || toIP == "" || fromIP == toIP {
			return
		}
		add(fromIP, toIP, "ip")
		if _, _, ok := normalizeIPv4(fromIP); ok {
			escTo := toIP
			dblTo := toIP
			if _, _, okTo := normalizeIPv4(toIP); okTo {
				escTo = strings.ReplaceAll(toIP, ".", `\.`)
				dblTo = strings.ReplaceAll(toIP, ".", `\\.`)
			}
			add(strings.ReplaceAll(fromIP, ".", `\.`), escTo, "ip")
			add(strings.ReplaceAll(fromIP, ".", `\\.`), dblTo, "ip")
		}
	}

	add(originFacts.ID, targetFacts.ID, "word")

	// 1. Role-aligned host & IP mapping (primary->primary, replica->replica).
	oHosts := alignedClusterHosts(originFacts, oDep)
	tHosts := alignedClusterHosts(targetFacts, tDep)
	for _, th := range tHosts {
		if _, canon, ok := normalizeIPv4(th.IP); ok {
			if !r.targetIPSet[canon] {
				r.targetIPSet[canon] = true
				r.targetIPs = append(r.targetIPs, canon)
			}
			if th.Name != "" {
				r.targetIPToName[canon] = th.Name
			}
		} else if th.IP != "" {
			r.targetIPs = append(r.targetIPs, th.IP)
			if th.Name != "" {
				r.targetIPToName[th.IP] = th.Name
			}
		}
	}
	for _, oh := range oHosts {
		if _, canon, ok := normalizeIPv4(oh.IP); ok {
			if !r.allOrigIPs[canon] {
				r.allOrigIPs[canon] = true
				if !r.targetIPSet[canon] {
					r.origOnlyIPs = append(r.origOnlyIPs, canon)
				}
			}
		}
	}
	for i, oh := range oHosts {
		if i < len(tHosts) {
			if oh.IP != "" && tHosts[i].IP != "" {
				addIPVariants(oh.IP, tHosts[i].IP)
			}
			if oh.Name != "" && tHosts[i].Name != "" {
				add(oh.Name, tHosts[i].Name, "word")
			}
		} else {
			if oh.IP != "" {
				addIPVariants(oh.IP, "<目标节点IP>")
			}
			if oh.Name != "" {
				add(oh.Name, "<目标节点名>", "word")
			}
		}
	}

	// 2. Endpoint / VIP / ELB host + port + resolveIP matching (exact name -> role -> primary fallback).
	oEps := extractClusterEndpoints(originFacts, oDep)
	tEps := extractClusterEndpoints(targetFacts, tDep)
	tAddrSet := map[string]bool{}
	for _, te := range tEps {
		if te.Host != "" {
			tAddrSet[te.Host] = true
		}
	}
	for _, oe := range oEps {
		if oe.Host != "" && !tAddrSet[oe.Host] {
			r.origAddrs = append(r.origAddrs, oe.Host)
		}
	}
	usedTarget := map[int]bool{}
	matchEndpoint := func(oe clusterEndpointInfo) (clusterEndpointInfo, bool) {
		// Pass 1: exact (component, name)
		for i, te := range tEps {
			if !usedTarget[i] && te.Component == oe.Component && te.Name != "" && te.Name == oe.Name {
				usedTarget[i] = true
				return te, true
			}
		}
		// Pass 2: matching role (e.g. "writer" <-> "eip", both readwrite)
		for i, te := range tEps {
			if !usedTarget[i] && te.Role != "" && te.Role == oe.Role {
				usedTarget[i] = true
				return te, true
			}
		}
		// Pass 3: first unused target endpoint
		for i, te := range tEps {
			if !usedTarget[i] {
				usedTarget[i] = true
				return te, true
			}
		}
		// Pass 4: reuse primary target endpoint if origin had multiple aliases for same role
		if len(tEps) > 0 {
			return tEps[0], true
		}
		return clusterEndpointInfo{}, false
	}

	placeholderHost := tr(lang, "<待补齐目标集群访问入口>", "<TARGET_CLUSTER_ENDPOINT>")
	for _, oe := range oEps {
		if te, ok := matchEndpoint(oe); ok {
			if oe.Port > 0 && te.Port > 0 {
				add(fmt.Sprintf("%s:%d", oe.Host, oe.Port), fmt.Sprintf("%s:%d", te.Host, te.Port), "")
			}
			add(oe.Host, te.Host, "")
			if strings.Contains(oe.Host, ".") {
				add(strings.ReplaceAll(oe.Host, ".", `\.`), strings.ReplaceAll(te.Host, ".", `\.`), "")
			}
			if oe.ResolveIP != "" && te.ResolveIP != "" && oe.ResolveIP != te.ResolveIP {
				addIPVariants(oe.ResolveIP, te.ResolveIP)
			}
			r.endpointRules = append(r.endpointRules, endpointRemapRule{
				OldHost:      oe.Host,
				OldPort:      oe.Port,
				OldResolveIP: oe.ResolveIP,
				NewHost:      te.Host,
				NewPort:      te.Port,
				NewResolveIP: te.ResolveIP,
			})
		} else {
			// Target has NO registered endpoint: scrub origin's production VIP so it never leaks!
			r.missingTargetEndpoint = true
			r.missingEndpointHosts = append(r.missingEndpointHosts, oe.Host)
			placeholderPort := tr(lang, "<入口端口>", "<ENDPOINT_PORT>")
			if oe.Port > 0 {
				add(fmt.Sprintf("%s:%d", oe.Host, oe.Port), placeholderHost+":"+placeholderPort, "")
			}
			add(oe.Host, placeholderHost, "")
			if strings.Contains(oe.Host, ".") {
				add(strings.ReplaceAll(oe.Host, ".", `\.`), placeholderHost, "")
			}
			r.endpointRules = append(r.endpointRules, endpointRemapRule{
				OldHost:       oe.Host,
				OldPort:       oe.Port,
				OldResolveIP:  oe.ResolveIP,
				NewHost:       placeholderHost,
				MissingTarget: true,
			})
		}
	}

	// Explicit client_cidr remapping when both clusters define a single distinct CIDR.
	oCIDRs := extractClusterClientCIDRs(originFacts)
	tCIDRs := extractClusterClientCIDRs(targetFacts)
	if len(oCIDRs) == 1 && len(tCIDRs) == 1 {
		add(oCIDRs[0], tCIDRs[0], "")
	}

	// 3. Config path & data dir remapping when origin and target differ.
	oCfg := clusterPatroniConfigPath(originFacts, oDep)
	tCfg := clusterPatroniConfigPath(targetFacts, tDep)
	if oCfg != "" && tCfg != "" && oCfg != tCfg {
		add(oCfg, tCfg, "")
	}
	oData := clusterPGDataDir(oDep)
	tData := clusterPGDataDir(tDep)
	if oData != "" && tData != "" && oData != tData {
		add(oData, tData, "")
	}

	sort.SliceStable(r.tokens, func(i, j int) bool {
		return len(r.tokens[i].From) > len(r.tokens[j].From)
	})
	return r
}

func isIPBoundaryChar(b byte) bool {
	return (b >= '0' && b <= '9') || b == '.'
}

func isWordBoundaryChar(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '_' || b == '-'
}

// applySinglePassTokens performs longest-first simultaneous non-overlapping replacement
// with boundary checks so swapped hostnames/IPs never suffer transitive corruption and
// shorter prefixes (e.g. 172.30.2.10) never corrupt longer ones (e.g. 172.30.2.106).
func applySinglePassTokens(text string, tokens []remapToken) string {
	if text == "" || len(tokens) == 0 {
		return text
	}
	var b strings.Builder
	b.Grow(len(text))
	n := len(text)
	i := 0
	for i < n {
		matched := false
		for _, tk := range tokens {
			m := len(tk.From)
			if m == 0 || i+m > n || text[i:i+m] != tk.From {
				continue
			}
			switch tk.Boundary {
			case "ip":
				if (i > 0 && isIPBoundaryChar(text[i-1])) || (i+m < n && isIPBoundaryChar(text[i+m])) {
					continue
				}
			case "word":
				if (i > 0 && isWordBoundaryChar(text[i-1])) || (i+m < n && isWordBoundaryChar(text[i+m])) {
					continue
				}
			}
			b.WriteString(tk.To)
			i += m
			matched = true
			break
		}
		if !matched {
			b.WriteByte(text[i])
			i++
		}
	}
	return b.String()
}

func rewriteEndpointPortsInLine(line string, rule endpointRemapRule, lang string) string {
	if rule.OldPort <= 0 {
		return line
	}
	oldPortStr := strconv.Itoa(rule.OldPort)
	targetPortStr := ""
	if rule.MissingTarget {
		targetPortStr = tr(lang, "<入口端口>", "<ENDPOINT_PORT>")
	} else if rule.NewPort > 0 && rule.NewPort != rule.OldPort {
		targetPortStr = strconv.Itoa(rule.NewPort)
	} else {
		return line
	}

	out := line
	// Direct host:port match (handles host already remapped to NewHost).
	if rule.NewHost != "" {
		out = strings.ReplaceAll(out, rule.NewHost+":"+oldPortStr, rule.NewHost+":"+targetPortStr)
	}
	// Line-scoped contextual match when line references the remapped endpoint host, resolveIP, or ingress keywords.
	low := strings.ToLower(out)
	lineHasEndpoint := (rule.NewHost != "" && strings.Contains(low, strings.ToLower(rule.NewHost))) ||
		(rule.NewResolveIP != "" && strings.Contains(low, strings.ToLower(rule.NewResolveIP))) ||
		strings.Contains(low, "入口") || strings.Contains(low, "vip") || strings.Contains(low, "elb") || strings.Contains(low, "endpoint")
	if !lineHasEndpoint {
		return out
	}

	out = rePortEquals.ReplaceAllStringFunc(out, func(m string) string {
		if strings.HasSuffix(m, "="+oldPortStr) {
			return "port=" + targetPortStr
		}
		return m
	})
	out = rePortFlagSpace.ReplaceAllStringFunc(out, func(m string) string {
		sub := rePortFlagSpace.FindStringSubmatch(m)
		if len(sub) == 3 && sub[2] == oldPortStr {
			return sub[1] + targetPortStr
		}
		return m
	})
	out = reLongPortOpt.ReplaceAllStringFunc(out, func(m string) string {
		sub := reLongPortOpt.FindStringSubmatch(m)
		if len(sub) == 3 && sub[2] == oldPortStr {
			return sub[1] + targetPortStr
		}
		return m
	})
	out = rePortProseCN.ReplaceAllStringFunc(out, func(m string) string {
		sub := rePortProseCN.FindStringSubmatch(m)
		if len(sub) == 3 && sub[2] == oldPortStr {
			return sub[1] + targetPortStr
		}
		return m
	})
	return out
}

func (r *clusterRemapper) isOriginIPSet(candidates []string) bool {
	if len(candidates) == 0 || len(r.allOrigIPs) == 0 {
		return false
	}
	differsFromTarget := false
	seen := map[string]bool{}
	for _, raw := range candidates {
		_, canon, ok := normalizeIPv4(raw)
		if !ok || !r.allOrigIPs[canon] {
			return false
		}
		seen[canon] = true
		if !r.targetIPSet[canon] {
			differsFromTarget = true
		}
	}
	if len(seen) != len(r.targetIPSet) {
		differsFromTarget = true
	}
	return differsFromTarget
}

func (r *clusterRemapper) remapIPSetPatterns(text string) (string, [][2]string) {
	if text == "" || len(r.allOrigIPs) == 0 || len(r.targetIPs) == 0 {
		return text, nil
	}
	var placeholders [][2]string
	makePlaceholder := func(replacement string) string {
		tok := fmt.Sprintf("\x00MWIPSET%d\x00", len(placeholders))
		placeholders = append(placeholders, [2]string{tok, replacement})
		return tok
	}
	apply := func(in string, re *regexp.Regexp, checkRight bool, expand func(m []int) ([]string, string)) string {
		matches := re.FindAllStringSubmatchIndex(in, -1)
		if len(matches) == 0 {
			return in
		}
		var b strings.Builder
		b.Grow(len(in))
		last := 0
		changed := false
		for _, m := range matches {
			start, end := m[0], m[1]
			if (start > 0 && isIPBoundaryChar(in[start-1])) || (checkRight && end < len(in) && isIPBoundaryChar(in[end])) {
				continue
			}
			cands, repl := expand(m)
			if repl == "" || !r.isOriginIPSet(cands) {
				continue
			}
			b.WriteString(in[last:start])
			b.WriteString(makePlaceholder(repl))
			last = end
			changed = true
		}
		if !changed {
			return in
		}
		b.WriteString(in[last:])
		return b.String()
	}

	out := text
	for _, mx := range compiledIPSetMatchers {
		sep := mx.sep
		// 1) 3-octet factored regex: 172\.30\.2\.(67|82|91)
		out = apply(out, mx.re3, false, func(m []int) ([]string, string) {
			a, b, c := out[m[2]:m[3]], out[m[4]:m[5]], out[m[6]:m[7]]
			alts := strings.Split(out[m[8]:m[9]], "|")
			cands := make([]string, len(alts))
			for i, alt := range alts {
				cands[i] = a + "." + b + "." + c + "." + alt
			}
			return cands, formatTargetIPSetRegex(r.targetIPs, sep)
		})
		// 2) 2-octet factored regex: 172\.30\.(2\.67|2\.82|2\.91)
		out = apply(out, mx.re2, false, func(m []int) ([]string, string) {
			a, b := out[m[2]:m[3]], out[m[4]:m[5]]
			alts := strings.Split(out[m[6]:m[7]], "|")
			cands := make([]string, len(alts))
			for i, alt := range alts {
				cands[i] = a + "." + b + "." + strings.ReplaceAll(alt, sep, ".")
			}
			return cands, formatTargetIPSetRegex(r.targetIPs, sep)
		})
		// 3) 1-octet factored regex: 172\.(30\.2\.67|30\.2\.82)
		out = apply(out, mx.re1, false, func(m []int) ([]string, string) {
			a := out[m[2]:m[3]]
			alts := strings.Split(out[m[4]:m[5]], "|")
			cands := make([]string, len(alts))
			for i, alt := range alts {
				cands[i] = a + "." + strings.ReplaceAll(alt, sep, ".")
			}
			return cands, formatTargetIPSetRegex(r.targetIPs, sep)
		})
		// 4) Parenthesized full-IP alternation: (172\.30\.2\.67|172\.30\.2\.82|172\.30\.2\.91)
		out = apply(out, mx.reFullP, false, func(m []int) ([]string, string) {
			alts := strings.Split(out[m[2]:m[3]], "|")
			cands := make([]string, len(alts))
			for i, alt := range alts {
				cands[i] = strings.ReplaceAll(alt, sep, ".")
			}
			return cands, formatTargetIPSetRegex(r.targetIPs, sep)
		})
		// 5) Unparenthesized full-IP alternation / bash case: 172.30.2.67|172.30.2.82
		out = apply(out, mx.reFullNP, true, func(m []int) ([]string, string) {
			alts := strings.Split(out[m[2]:m[3]], "|")
			cands := make([]string, len(alts))
			for i, alt := range alts {
				cands[i] = strings.ReplaceAll(alt, sep, ".")
			}
			if sep == "." {
				return cands, strings.Join(r.targetIPs, "|")
			}
			return cands, formatTargetIPSetRegex(r.targetIPs, sep)
		})
	}

	// 6) Shell brace expansions: 172.30.2.{67,82,91} and {172.30.2.67,172.30.2.82,172.30.2.91}
	out = apply(out, reIPBrace3, false, func(m []int) ([]string, string) {
		a, b, c := out[m[2]:m[3]], out[m[4]:m[5]], out[m[6]:m[7]]
		alts := strings.Split(out[m[8]:m[9]], ",")
		cands := make([]string, len(alts))
		for i, alt := range alts {
			cands[i] = a + "." + b + "." + c + "." + alt
		}
		return cands, formatTargetIPSetBrace(r.targetIPs)
	})
	out = apply(out, reIPBraceFull, false, func(m []int) ([]string, string) {
		alts := strings.Split(out[m[2]:m[3]], ",")
		return alts, formatTargetIPSetBrace(r.targetIPs)
	})
	return out, placeholders
}

func (r *clusterRemapper) RemapText(text string) string {
	if text == "" {
		return ""
	}
	out, placeholders := r.remapIPSetPatterns(text)
	out = applySinglePassTokens(out, r.tokens)
	for _, ph := range placeholders {
		out = strings.ReplaceAll(out, ph[0], ph[1])
	}

	// Contextual port rewriting (line-by-line so external VIP ports and local PG ports never cross-contaminate).
	if len(r.endpointRules) > 0 || (r.originLocalPGPort > 0 && r.targetLocalPGPort > 0 && r.originLocalPGPort != r.targetLocalPGPort) {
		lines := strings.Split(out, "\n")
		for idx, ln := range lines {
			for _, rule := range r.endpointRules {
				ln = rewriteEndpointPortsInLine(ln, rule, r.lang)
			}
			// Local PG port rewrite only on local psql/socket lines that do NOT target an external endpoint.
			if r.originLocalPGPort > 0 && r.targetLocalPGPort > 0 && r.originLocalPGPort != r.targetLocalPGPort {
				low := strings.ToLower(ln)
				hasExt := false
				for _, rule := range r.endpointRules {
					if rule.NewHost != "" && strings.Contains(low, strings.ToLower(rule.NewHost)) {
						hasExt = true
						break
					}
				}
				if !hasExt && (strings.Contains(low, "psql") || strings.Contains(low, "/var/run/postgresql")) {
					oldLP := strconv.Itoa(r.originLocalPGPort)
					newLP := strconv.Itoa(r.targetLocalPGPort)
					ln = rePortFlagSpace.ReplaceAllStringFunc(ln, func(m string) string {
						sub := rePortFlagSpace.FindStringSubmatch(m)
						if len(sub) == 3 && sub[2] == oldLP {
							return sub[1] + newLP
						}
						return m
					})
				}
			}
			lines[idx] = ln
		}
		out = strings.Join(lines, "\n")
	}

	// Normalize stale ancestor cluster service slugs in verification tags (e.g. jfrog_log_verify_first -> onedevops_log_verify_first).
	if r.targetSlug != "" {
		out = reLogVerifySlug.ReplaceAllStringFunc(out, func(m string) string {
			sub := reLogVerifySlug.FindStringSubmatch(m)
			if len(sub) == 4 && sub[2] != r.targetSlug {
				return sub[1] + r.targetSlug + sub[3]
			}
			return m
		})
	}

	// Normalize orphan 3-digit ancestor node suffixes paired with a known target IP (e.g. "003 / 172.30.2.99" -> "db-node-03 / 172.30.2.99").
	if len(r.targetIPToName) > 0 {
		out = reOrphanNodeIPPair.ReplaceAllStringFunc(out, func(m string) string {
			sub := reOrphanNodeIPPair.FindStringSubmatch(m)
			if len(sub) == 3 {
				if realName, ok := r.targetIPToName[sub[2]]; ok && realName != "" && !strings.HasSuffix(realName, sub[1]) {
					return realName + " / " + sub[2]
				}
			}
			return m
		})
	}

	return out
}

func (r *clusterRemapper) RemapProbeScript(script string) string {
	out := r.RemapText(script)
	targetIPRegex := buildTargetIPv4Regex(r.targetIPs)
	if targetIPRegex != "" {
		replaceNonLoopback := func(m string) string {
			if strings.HasPrefix(m, `127\.`) || strings.HasPrefix(m, `(127\.`) || strings.HasPrefix(m, `0\.0\.0\.`) {
				return m
			}
			return targetIPRegex
		}
		out = reAwkSubnetIPGroup.ReplaceAllStringFunc(out, replaceNonLoopback)
		out = reAwkFullIPGroup.ReplaceAllStringFunc(out, replaceNonLoopback)
	}
	return out
}

// detectResidualOriginRefs checks whether any origin-only IP (literal, escaped, or factored),
// origin cluster ID, or origin-only endpoint domain survived remapping.
func (r *clusterRemapper) detectResidualOriginRefs(text string) []string {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	var leaks []string
	seen := map[string]bool{}
	add := func(s string) {
		if s != "" && !seen[s] {
			seen[s] = true
			leaks = append(leaks, s)
		}
	}
	for _, ip := range r.origOnlyIPs {
		for _, form := range []string{ip, strings.ReplaceAll(ip, ".", `\.`), strings.ReplaceAll(ip, ".", `\\.`)} {
			re := regexp.MustCompile(regexp.QuoteMeta(form))
			for _, loc := range re.FindAllStringIndex(text, -1) {
				if (loc[0] == 0 || !isIPBoundaryChar(text[loc[0]-1])) && (loc[1] == len(text) || !isIPBoundaryChar(text[loc[1]])) {
					add(ip)
					break
				}
			}
		}
	}
	for _, mx := range compiledIPSetMatchers {
		sep := mx.sep
		for _, m := range mx.re3.FindAllStringSubmatchIndex(text, -1) {
			a, b, c := text[m[2]:m[3]], text[m[4]:m[5]], text[m[6]:m[7]]
			for _, alt := range strings.Split(text[m[8]:m[9]], "|") {
				cand := a + "." + b + "." + c + "." + alt
				if r.allOrigIPs[cand] && !r.targetIPSet[cand] {
					add(text[m[0]:m[1]])
					break
				}
			}
		}
		for _, m := range mx.re2.FindAllStringSubmatchIndex(text, -1) {
			a, b := text[m[2]:m[3]], text[m[4]:m[5]]
			for _, alt := range strings.Split(text[m[6]:m[7]], "|") {
				cand := a + "." + b + "." + strings.ReplaceAll(alt, sep, ".")
				if r.allOrigIPs[cand] && !r.targetIPSet[cand] {
					add(text[m[0]:m[1]])
					break
				}
			}
		}
	}
	if r.originID != "" && r.originID != r.targetID {
		re := regexp.MustCompile(regexp.QuoteMeta(r.originID))
		for _, loc := range re.FindAllStringIndex(text, -1) {
			if (loc[0] == 0 || !isWordBoundaryChar(text[loc[0]-1])) && (loc[1] == len(text) || !isWordBoundaryChar(text[loc[1]])) {
				add(r.originID)
				break
			}
		}
	}
	for _, addr := range r.origAddrs {
		re := regexp.MustCompile(regexp.QuoteMeta(addr))
		for _, loc := range re.FindAllStringIndex(text, -1) {
			leftOK := loc[0] == 0 || (!isWordBoundaryChar(text[loc[0]-1]) && text[loc[0]-1] != '.')
			rightOK := loc[1] == len(text) || (!isWordBoundaryChar(text[loc[1]]) && text[loc[1]] != '.')
			if leftOK && rightOK {
				add(addr)
				break
			}
		}
	}
	return leaks
}

func (r *clusterRemapper) containsMissingEndpointPlaceholder(s string) bool {
	if !r.missingTargetEndpoint {
		return false
	}
	return strings.Contains(s, "<待补齐目标集群访问入口>") || strings.Contains(s, "<TARGET_CLUSTER_ENDPOINT>")
}

// buildClusterRemapPairs preserves compatibility for helpers/tests needing explicit text pairs.
func buildClusterRemapPairs(originFacts, targetFacts clusterFacts) [][2]string {
	r := (&storeServer{}).newClusterRemapper(originFacts, targetFacts, "zh-CN")
	out := make([][2]string, 0, len(r.tokens))
	for _, tk := range r.tokens {
		out = append(out, [2]string{tk.From, tk.To})
	}
	return out
}

func remapTextWithPairs(text string, pairs [][2]string) string {
	tokens := make([]remapToken, 0, len(pairs))
	for _, p := range pairs {
		tokens = append(tokens, remapToken{From: p[0], To: p[1]})
	}
	sort.SliceStable(tokens, func(i, j int) bool {
		return len(tokens[i].From) > len(tokens[j].From)
	})
	return applySinglePassTokens(text, tokens)
}

func isAutoPropagatedProbeNote(note string) bool {
	t := strings.TrimSpace(note)
	return strings.HasPrefix(t, "本变更引用自已落地样板集群") ||
		strings.HasPrefix(t, "Imported from production-applied pilot")
}

func unwrapStrictPrecheckExpect(expect string) string {
	cur := strings.TrimSpace(expect)
	for cur != "" {
		next := strings.TrimSpace(reStrictExpectStrip.ReplaceAllString(cur, ""))
		if next == cur {
			break
		}
		cur = next
	}
	return cur
}

func targetHostSummaryLine(f clusterFacts) string {
	if f.Plan == nil || len(f.Plan.Hosts) == 0 {
		return f.ID
	}
	parts := make([]string, 0, len(f.Plan.Hosts))
	for _, h := range f.Plan.Hosts {
		if h.IP != "" {
			parts = append(parts, fmt.Sprintf("%s (%s)", h.Name, h.IP))
		} else {
			parts = append(parts, h.Name)
		}
	}
	return strings.Join(parts, " / ")
}

func (s *storeServer) buildFallbackProbeScript(targetFacts clusterFacts, origin changeRehearsal) string {
	dep := s.readSpec(targetFacts.Current.ID)
	app := strings.ToLower(strings.TrimSpace(targetFacts.Current.AppID))
	sc := s.deliveryScheme(targetFacts.Current.ID, targetFacts.Current.AppID, targetFacts.Current.Scheme)
	hostCount := 0
	if targetFacts.Plan != nil {
		hostCount = len(targetFacts.Plan.Hosts)
	} else if dep != nil {
		hostCount = len(dep.Hosts)
	}
	coreArch := canonicalCoreArch(targetFacts, dep, sc, hostCount)
	keys := rehearsalTouchedKeys(origin)
	var b strings.Builder
	b.WriteString("#!/usr/bin/env bash\n")
	b.WriteString("if [ -z \"${BASH_VERSION:-}\" ]; then exec bash \"$0\" \"$@\"; fi\n")
	b.WriteString("set -uo pipefail\nexport LC_ALL=C\n")
	b.WriteString("printf '=== node=%s ip=%s ===\\n' \"$(hostname -s)\" \"$(hostname -I 2>/dev/null | awk '{print $1}')\"\n")
	switch app {
	case "postgresql":
		pgPort := clusterLocalPGPort(targetFacts, dep)
		patroniCfg := clusterPatroniConfigPath(targetFacts, dep)
		b.WriteString("printf '[version & topology]\\n'\n")
		fmt.Fprintf(&b, "sudo -n -u postgres psql -X -w -h /var/run/postgresql -p %d -d postgres -Atc \"SELECT 'pg_version='||current_setting('server_version')||' role='||CASE WHEN pg_is_in_recovery() THEN 'replica' ELSE 'primary' END;\" 2>/dev/null || printf 'ERROR: psql unavailable\\n'\n", pgPort)
		if coreArch == "pg-patroni" {
			b.WriteString("patroni --version 2>/dev/null || true\n")
			fmt.Fprintf(&b, "timeout 15s sudo -n -u postgres patronictl -c %s list 2>/dev/null || printf 'WARN: patronictl list unavailable\\n'\n", patroniCfg)
		}
		if len(keys) > 0 {
			var pgKeys []string
			var pgPyKeys []string
			for _, k := range keys {
				lk := strings.ToLower(k)
				if lk == "pg_hba" {
					b.WriteString("printf '[pg_hba_file_rules errors]\\n'\n")
					fmt.Fprintf(&b, "sudo -n -u postgres psql -X -w -h /var/run/postgresql -p %d -d postgres -Atc \"SELECT count(*) FILTER (WHERE error IS NOT NULL) AS parse_errors, count(*) AS total_rules FROM pg_hba_file_rules;\" 2>/dev/null || true\n", pgPort)
				} else if regexp.MustCompile(`^[a-z0-9_]+$`).MatchString(lk) {
					pgKeys = append(pgKeys, "'"+lk+"'")
					pgPyKeys = append(pgPyKeys, `"`+lk+`"`)
				}
			}
			if len(pgKeys) > 0 {
				fmt.Fprintf(&b, "printf '[target parameters]\\n'\n")
				fmt.Fprintf(&b, "sudo -n -u postgres psql -X -w -h /var/run/postgresql -p %d -d postgres -Atc \"SELECT name||'='||setting||' source='||source||' pending_restart='||pending_restart FROM pg_settings WHERE name IN (%s) ORDER BY name;\" 2>/dev/null || true\n", pgPort, strings.Join(pgKeys, ","))
				if coreArch == "pg-patroni" {
					fmt.Fprintf(&b, "printf '[DCS postgresql.parameters]\\n'\n")
					fmt.Fprintf(&b, "sudo -n -u postgres patronictl -c %s show-config 2>/dev/null | python3 -c 'import sys,yaml; d=yaml.safe_load(sys.stdin) or {}; p=(d.get(\"postgresql\") or {}).get(\"parameters\") or {}; [print(k+\"=\"+str(p.get(k,\"<unset>\"))) for k in (%s,)]' 2>/dev/null || true\n", patroniCfg, strings.Join(pgPyKeys, ","))
				}
			}
		}
	case "redis":
		b.WriteString("redis-server -v 2>/dev/null || true\n")
		b.WriteString("systemctl is-active redis-server redis 2>/dev/null || true\n")
	case "etcd":
		b.WriteString("etcd --version 2>/dev/null | head -n 2 || true\n")
		b.WriteString("systemctl is-active etcd 2>/dev/null || true\n")
	case "nginx":
		b.WriteString("nginx -v 2>&1 || true\n")
		b.WriteString("systemctl is-active nginx 2>/dev/null || true\n")
	case "haproxy":
		b.WriteString("haproxy -v 2>/dev/null | head -n 1 || true\n")
		b.WriteString("systemctl is-active haproxy 2>/dev/null || true\n")
	default:
		b.WriteString("systemctl --type=service --state=running 2>/dev/null | head -n 15 || true\n")
	}
	b.WriteString("df -h /data 2>/dev/null || df -h / 2>/dev/null | tail -n 2\n")
	return b.String()
}

// buildStrictPropagatedPrecheck synthesizes a strict, blocking Step 1 precheck whenever
// a target cluster skips the standalone probe step ("steps" fast-track mode).
func (s *storeServer) buildStrictPropagatedPrecheck(
	originFacts, targetFacts clusterFacts,
	origin changeRehearsal,
	remapper *clusterRemapper,
	origPrecheck *rehearsalStep,
	lang string,
) rehearsalStep {
	dep := s.readSpec(targetFacts.Current.ID)
	app := strings.ToLower(strings.TrimSpace(targetFacts.Current.AppID))
	sc := s.deliveryScheme(targetFacts.Current.ID, targetFacts.Current.AppID, targetFacts.Current.Scheme)
	hostCount := 0
	if targetFacts.Plan != nil {
		hostCount = len(targetFacts.Plan.Hosts)
	} else if dep != nil {
		hostCount = len(dep.Hosts)
	}
	coreArch := canonicalCoreArch(targetFacts, dep, sc, hostCount)
	changes := rehearsalAppliedOrExtractedChanges(origin)
	var cmdLines []string
	cmdLines = append(cmdLines, `printf 'node=%s ip=%s\n' "$(hostname -s)" "$(hostname -I 2>/dev/null | awk '{print $1}')"`)

	var extraDirs []string
	var pgSettings []string
	var pgPySettings []string
	hasHBA := false
	for _, ch := range changes {
		k := strings.TrimSpace(ch.Key)
		lk := strings.ToLower(k)
		v := strings.TrimSpace(ch.After)
		if lk == "pg_hba" {
			hasHBA = true
		} else if app == "postgresql" && regexp.MustCompile(`^[a-z0-9_]+$`).MatchString(lk) {
			pgSettings = append(pgSettings, "'"+lk+"'")
			pgPySettings = append(pgPySettings, `"`+lk+`"`)
		}
		if strings.HasPrefix(v, "/") && !strings.ContainsAny(v, " \t\n;'\"") {
			extraDirs = append(extraDirs, v)
		}
	}

	switch app {
	case "postgresql":
		pgPort := clusterLocalPGPort(targetFacts, dep)
		patroniCfg := clusterPatroniConfigPath(targetFacts, dep)
		if coreArch == "pg-patroni" {
			cmdLines = append(cmdLines,
				`systemctl is-active patroni etcd 2>/dev/null || true`,
				`patroni --version`,
			)
		} else {
			cmdLines = append(cmdLines, `systemctl is-active postgresql 2>/dev/null || true`)
		}
		cmdLines = append(cmdLines,
			fmt.Sprintf(`sudo -n -u postgres psql -X -w -h /var/run/postgresql -p %d -d postgres -Atc "SELECT 'pg='||current_setting('server_version')||' role='||CASE WHEN pg_is_in_recovery() THEN 'replica' ELSE 'primary' END||' pending_restart='||(SELECT count(*) FROM pg_settings WHERE pending_restart)||' long_tx='||(SELECT count(*) FROM pg_stat_activity WHERE state<>'idle' AND now()-xact_start>interval '30 seconds');"`, pgPort),
		)
		if coreArch == "pg-patroni" {
			cmdLines = append(cmdLines, fmt.Sprintf(`sudo -n -u postgres patronictl -c %s list`, patroniCfg))
		}
		if len(pgSettings) > 0 {
			cmdLines = append(cmdLines,
				fmt.Sprintf(`sudo -n -u postgres psql -X -w -h /var/run/postgresql -p %d -d postgres -Atc "SELECT name||'='||setting||' source='||source||' pending_restart='||pending_restart FROM pg_settings WHERE name IN (%s) ORDER BY name;"`, pgPort, strings.Join(pgSettings, ",")),
			)
			if coreArch == "pg-patroni" {
				cmdLines = append(cmdLines,
					fmt.Sprintf(`sudo -n -u postgres patronictl -c %s show-config | python3 -c 'import sys,yaml; d=yaml.safe_load(sys.stdin) or {}; p=(d.get("postgresql") or {}).get("parameters") or {}; [print("dcs:"+k+"="+str(p.get(k,"<unset>"))) for k in (%s,)]'`, patroniCfg, strings.Join(pgPySettings, ",")),
				)
			}
		}
		if hasHBA {
			if coreArch == "pg-patroni" {
				cmdLines = append(cmdLines, fmt.Sprintf(`sudo -n -u postgres patronictl -c %s show-config | grep -nE '^[[:space:]]+- (host|local)'`, patroniCfg))
			}
			cmdLines = append(cmdLines,
				fmt.Sprintf(`sudo -n -u postgres psql -X -w -h /var/run/postgresql -p %d -d postgres -Atc "SELECT count(*) FILTER (WHERE error IS NOT NULL) AS parse_errors, count(*) AS total_rules FROM pg_hba_file_rules;"`, pgPort),
			)
		}
	case "redis":
		cmdLines = append(cmdLines, `redis-server -v; systemctl is-active redis-server redis 2>/dev/null || true`)
	case "etcd":
		cmdLines = append(cmdLines, `etcd --version | head -n 2; systemctl is-active etcd`)
	case "nginx":
		cmdLines = append(cmdLines, `nginx -v 2>&1; nginx -t; systemctl is-active nginx`)
	case "haproxy":
		cmdLines = append(cmdLines, `haproxy -v | head -n 1; systemctl is-active haproxy`)
	default:
		if origPrecheck != nil && strings.TrimSpace(origPrecheck.Command) != "" {
			cmdLines = append(cmdLines, remapper.RemapText(strings.TrimSpace(origPrecheck.Command)))
		}
	}
	if len(extraDirs) > 0 {
		dir := extraDirs[0]
		parent := filepath.ToSlash(filepath.Dir(dir))
		if parent == "" || parent == "." {
			parent = "/data"
		}
		cmdLines = append(cmdLines, fmt.Sprintf(`df -h %s 2>/dev/null || df -h /data 2>/dev/null; ls -ld %s %s 2>/dev/null || true`, parent, parent, dir))
	} else if app == "postgresql" {
		cmdLines = append(cmdLines, `df -h /data 2>/dev/null || df -h /`)
	}

	targetSummary := targetHostSummaryLine(targetFacts)
	var expectParts []string
	expectParts = append(expectParts, tr(lang,
		fmt.Sprintf("1) 节点名/IP 与本集群基线（%s）一致，软件实测小版本与样板一致；", targetSummary),
		fmt.Sprintf("1) Hostname/IP matches target cluster baseline (%s) and live software version aligns with pilot;", targetSummary)))
	if app == "postgresql" && coreArch == "pg-patroni" {
		expectParts = append(expectParts, tr(lang,
			"2) 集群拓扑全健康（Leader running、所有从库 streaming、Lag=0、无 Pending restart 标记）；",
			"2) Topology healthy (Leader running, replicas streaming, Lag=0, zero Pending restart flags);"))
	} else {
		expectParts = append(expectParts, tr(lang,
			"2) 服务状态 active 且主从/集群健康无告警；",
			"2) Service active with healthy cluster topology;"))
	}
	if len(changes) > 0 {
		keys := rehearsalTouchedKeys(origin)
		expectParts = append(expectParts, tr(lang,
			fmt.Sprintf("3) 目标配置项（%s）当前运行值与共享 DCS 基线已核清且无意外冲突，磁盘余量充足。", strings.Join(keys, "、")),
			fmt.Sprintf("3) Target parameter values (%s) and shared DCS baseline verified with no unexpected conflicts and sufficient disk headroom.", strings.Join(keys, ", "))))
	} else {
		expectParts = append(expectParts, tr(lang,
			"3) 目标路径/权限与磁盘空间满足变更前提。",
			"3) Target paths, permissions, and disk headroom satisfy prerequisites."))
	}
	if origPrecheck != nil {
		if unwrapped := unwrapStrictPrecheckExpect(remapper.RemapText(origPrecheck.Expect)); unwrapped != "" {
			expectParts = append(expectParts, tr(lang, "补充核对：", "Additional check: ")+unwrapped)
		}
	}

	return rehearsalStep{
		ID:         "s1",
		Phase:      "precheck",
		Order:      1,
		Title:      tr(lang, "【严格前置预检】核实角色、版本、目标参数现值与健康红线", "[Strict Precheck] Verify Roles, Version, Live Parameters & Health Gate"),
		TargetRole: tr(lang, fmt.Sprintf("所有数据节点（%s，逐台执行并核验）", targetSummary), fmt.Sprintf("All cluster nodes (%s, run and verify on each)", targetSummary)),
		Command:    ensurePasteSafeShellCommand(strings.Join(cmdLines, "\n")),
		Expect:     strings.Join(expectParts, " "),
		RiskNote: tr(lang,
			fmt.Sprintf("本演练引用自样板集群 %s（跳过了独立探针），此步为强制阻断门禁：若发现主从已漂移、版本不一致、存在 Pending restart、目标参数已有冲突或磁盘告警，严禁继续执行第 2 步！", originFacts.ID),
			fmt.Sprintf("Propagated from pilot cluster %s with standalone probe skipped — this step is a HARD GATE: stop immediately if roles drifted, versions differ, Pending restart exists, or parameters conflict.", originFacts.ID)),
		Status: "pending",
	}
}

func (s *storeServer) buildPropagatedRehearsal(
	originFacts, targetFacts clusterFacts,
	origin changeRehearsal,
	reqMode string,
	eval propagateTargetItem,
	operator, rolloutID, lang string,
) (changeRehearsal, string) {
	actualMode := reqMode
	downgradedReason := ""
	if actualMode != "steps" {
		actualMode = "probe"
	} else if !eval.AllowSkipProbe {
		actualMode = "probe"
		downgradedReason = eval.SkipProbeBlockReason
	}

	remapper := s.newClusterRemapper(originFacts, targetFacts, lang)
	now := time.Now().UTC().Format(time.RFC3339)
	rid := randomStoreToken(6)

	// Inherit aligned scope questions & answers cleanly (with cluster references remapped).
	var scopeQs []rehearsalScopeQuestion
	for _, q := range origin.ScopeQuestions {
		opts := make([]string, len(q.Options))
		for i, o := range q.Options {
			opts[i] = remapper.RemapText(o)
		}
		scopeQs = append(scopeQs, rehearsalScopeQuestion{
			ID:       q.ID,
			Label:    q.Label,
			Question: remapper.RemapText(q.Question),
			Options:  opts,
			Answer:   remapper.RemapText(q.Answer),
		})
	}
	var secCopy *rehearsalSecurityContext
	if origin.SecurityContext != nil {
		cp := *origin.SecurityContext
		cp.VEXSynced = false
		cp.VEXStatus = ""
		cp.VEXSyncedAt = ""
		secCopy = &cp
	}

	// Remap probe script (including awk/bash subnet IPv4 regex groups), or synthesize fallback.
	probeScript := ""
	if strings.TrimSpace(origin.ProbeScript) != "" {
		probeScript = remapper.RemapProbeScript(origin.ProbeScript)
	} else {
		probeScript = s.buildFallbackProbeScript(targetFacts, origin)
	}
	probeScript = ensureProbeBashGuard(probeScript)
	probeSafe, probeWarns := validateReadOnlyProbeScriptLang(probeScript, lang)
	if leaks := remapper.detectResidualOriginRefs(probeScript); len(leaks) > 0 {
		warn := tr(lang,
			fmt.Sprintf("检测到探针脚本仍残留样板集群标识/地址（%s），请核对目标集群基线 IP 后再执行", strings.Join(leaks, "、")),
			fmt.Sprintf("Probe script still references pilot cluster identifiers/IPs (%s); verify target cluster baseline before running", strings.Join(leaks, ", ")))
		probeWarns = append(probeWarns, warn)
		probeSafe = false
	}

	var probeNotes []string
	probeNotes = append(probeNotes, tr(lang,
		fmt.Sprintf("本变更引用自已落地样板集群 %s（%s），已自动继承边界约束并映射至当前集群 %s 的基线地址；请在本集群节点执行探针核实现场后继续。", originFacts.ID, origin.Title, targetFacts.ID),
		fmt.Sprintf("Imported from production-applied pilot %s (%s) with boundaries inherited and baseline addresses remapped for %s; run the read-only probe on this cluster before proceeding.", originFacts.ID, origin.Title, targetFacts.ID)))
	for _, n := range origin.ProbeNotes {
		if isAutoPropagatedProbeNote(n) {
			continue
		}
		if t := strings.TrimSpace(remapper.RemapText(n)); t != "" {
			probeNotes = append(probeNotes, t)
		}
	}

	rhMode := origin.Mode
	if rhMode == "" {
		rhMode = "full"
	}
	stage := "probing"
	var steps []rehearsalStep
	strictPrecheck := false
	stepsRemapped := false

	if actualMode == "steps" {
		stage = "rehearsing"
		strictPrecheck = true
		stepsRemapped = true

		var origPre *rehearsalStep
		var restSteps []rehearsalStep
		for i := range origin.Steps {
			st := origin.Steps[i]
			if i == 0 && st.Phase == "precheck" {
				cp := st
				origPre = &cp
				continue
			}
			restSteps = append(restSteps, st)
		}

		steps = append(steps, s.buildStrictPropagatedPrecheck(originFacts, targetFacts, origin, remapper, origPre, lang))
		missingEPNotice := tr(lang,
			"【注意】当前目标集群基线尚未登记访问入口（VIP/ELB），已自动脱敏屏蔽样板集群入口以防误连；执行此步前请先在基线中补齐入口或手动替换为本集群实际入口与端口。",
			"[Note] Target cluster baseline has no registered access endpoint (VIP/ELB); pilot endpoint was scrubbed to prevent cross-cluster connection. Fill in target endpoint & port before running.")
		for _, st := range restSteps {
			ord := len(steps) + 1
			remappedCmd := remapper.RemapText(st.Command)
			var remappedSubs []rehearsalStepCommand
			for _, sub := range st.Commands {
				remappedSubs = append(remappedSubs, rehearsalStepCommand{
					Label:      remapper.RemapText(sub.Label),
					TargetRole: remapper.RemapText(sub.TargetRole),
					Command:    remapper.RemapText(sub.Command),
					Gate:       remapper.RemapText(sub.Gate),
				})
			}
			if len(remappedSubs) <= 1 {
				remappedSubs = splitSequentialRollingCommands(remappedCmd, lang)
			}
			if len(remappedSubs) > 1 {
				for si := range remappedSubs {
					remappedSubs[si].Command = ensurePasteSafeShellCommand(remappedSubs[si].Command)
				}
				remappedCmd = joinStepCommandsFallback(remappedSubs)
			} else {
				remappedCmd = ensurePasteSafeShellCommand(remappedCmd)
			}
			riskNote := remapper.RemapText(st.RiskNote)
			if remapper.containsMissingEndpointPlaceholder(remappedCmd) && !strings.Contains(riskNote, missingEPNotice) {
				if riskNote != "" {
					riskNote = missingEPNotice + " " + riskNote
				} else {
					riskNote = missingEPNotice
				}
			}
			steps = append(steps, rehearsalStep{
				ID:         fmt.Sprintf("s%d", ord),
				Phase:      st.Phase,
				Order:      ord,
				Title:      remapper.RemapText(st.Title),
				TargetRole: remapper.RemapText(st.TargetRole),
				Command:    remappedCmd,
				Commands:   remappedSubs,
				Expect:     remapper.RemapText(st.Expect),
				RiskNote:   riskNote,
				Rollback:   remapper.RemapText(st.Rollback),
				Optional:   st.Optional,
				Status:     "pending",
			})
		}
	}

	// Snapshot target cluster's current applied IDs for accurate conflict tracking.
	var baseAppliedIDs []string
	for _, ap := range s.listAppliedRehearsals(targetFacts.ID) {
		baseAppliedIDs = append(baseAppliedIDs, ap.ID)
	}

	rh := changeRehearsal{
		ID:              rid,
		ClusterID:       targetFacts.ID,
		AppID:           targetFacts.Current.AppID,
		AppName:         targetFacts.Current.AppName,
		BaseJobID:       targetFacts.Current.ID,
		Title:           origin.Title,
		Goal:            remapper.RemapText(origin.Goal),
		ExtraScope:      remapper.RemapText(origin.ExtraScope),
		Owner:           operator,
		Mode:            rhMode,
		Stage:           stage,
		SecurityContext: secCopy,
		ScopeQuestions:  scopeQs,
		ScopeSummary:    remapper.RemapText(origin.ScopeSummary),
		ProbeScript:     probeScript,
		ProbeNotes:      probeNotes,
		ProbeSafe:       probeSafe,
		ProbeWarnings:   probeWarns,
		Steps:           steps,
		BaseAppliedIDs:  baseAppliedIDs,
		Source: &rehearsalSourceRef{
			RolloutID:         rolloutID,
			IsOrigin:          false,
			OriginClusterID:   origin.ClusterID,
			OriginRehearsalID: origin.ID,
			OriginTitle:       origin.Title,
			ImportMode:        actualMode,
			ImportedAt:        now,
			ImportedBy:        operator,
			StepsRemapped:     stepsRemapped,
			StrictPrecheck:    strictPrecheck,
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
	return rh, downgradedReason
}

// rehearsalSourceBlueprintPrompt injects the pilot cluster's battle-tested steps & lessons
// when a propagated rehearsal runs probe analysis on a target cluster.
func (s *storeServer) rehearsalSourceBlueprintPrompt(rh changeRehearsal) string {
	if rh.Source == nil || rh.Source.IsOrigin || rh.Source.OriginClusterID == "" || rh.Source.OriginRehearsalID == "" {
		return ""
	}
	orig, ok := s.loadRehearsal(rh.Source.OriginClusterID, rh.Source.OriginRehearsalID)
	if !ok || len(orig.Steps) == 0 {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\n【样板集群已生产落地蓝图（强参考；来自集群 %s 的已验证方案《%s》）】\n", orig.ClusterID, orig.Title)
	b.WriteString("请高度沿用以下已在样板集群生产验证通过的步骤顺序、核心命令写法、参数目标与回退策略，但**必须 100% 替换为当前目标集群真实探针核实到的节点名、IP、主从角色、配置路径与漂移差异**，严禁残留样板集群的任何 IP 或主机名：\n")
	for _, st := range orig.Steps {
		fmt.Fprintf(&b, "- 第 %d 步 [%s] %s\n", st.Order, st.Phase, st.Title)
		if st.Command != "" {
			fmt.Fprintf(&b, "  样板命令：%s\n", truncRunes(strings.ReplaceAll(strings.TrimSpace(st.Command), "\n", " ; "), 320))
		}
		if st.Expect != "" {
			fmt.Fprintf(&b, "  验收判据：%s\n", truncRunes(st.Expect, 200))
		}
		if st.Note != "" {
			fmt.Fprintf(&b, "  样板实测经验：%s\n", truncRunes(st.Note, 200))
		}
	}
	return b.String()
}

// ---- HTTP Handlers ----

func (s *storeServer) handlePropagateTargets(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string) {
	lang := reqLang(r)
	rehearsalMu.Lock()
	origin, ok := s.loadRehearsal(f.ID, rid)
	rehearsalMu.Unlock()
	if !ok {
		s.fail(w, 404, "演练会话不存在")
		return
	}
	if origin.Stage != "finalized" || !origin.Applied || origin.Voided {
		s.fail(w, 409, tr(lang, "仅已确认「生产已实施完成」的变更演练才可推广到其他集群", "Only production-applied rehearsals can be propagated to other clusters"))
		return
	}
	oSchemeID, oSchemeName, oVer, oHosts, _ := s.clusterSchemeMeta(f, lang)
	rolloutID := ""
	if origin.Source != nil {
		rolloutID = origin.Source.RolloutID
	}
	defaultMode := "probe"
	if origin.Mode == "quick" {
		defaultMode = "steps"
	}

	var targets []propagateTargetItem
	for _, cid := range s.visibleClusterIDs(session.User) {
		if cid == f.ID {
			continue
		}
		tf, ok := s.clusterFactsFor(session.User, cid)
		if !ok || tf.Current.DeliveryMode == "configuration" {
			continue
		}
		if !strings.EqualFold(tf.Current.AppID, origin.AppID) {
			continue
		}
		targets = append(targets, s.evaluatePropagateTarget(f, origin, tf, lang))
	}
	sort.Slice(targets, func(i, j int) bool {
		rank := func(t propagateTargetItem) int {
			if t.AlreadyImported {
				return 3
			}
			if t.AlreadyEffective {
				return 2
			}
			if t.MatchTier == "exact" && t.Deployed && len(t.ConflictKeys) == 0 {
				return 0
			}
			return 1
		}
		ri, rj := rank(targets[i]), rank(targets[j])
		if ri != rj {
			return ri < rj
		}
		return targets[i].ClusterID < targets[j].ClusterID
	})
	if targets == nil {
		targets = []propagateTargetItem{}
	}

	s.writeJSON(w, 200, map[string]any{
		"origin": propagateOriginSummary{
			ClusterID:   f.ID,
			RehearsalID: origin.ID,
			Title:       origin.Title,
			AppID:       origin.AppID,
			AppName:     origin.AppName,
			Version:     oVer,
			Mode:        firstNonEmptyStr(origin.Mode, "full"),
			SchemeID:    oSchemeID,
			SchemeName:  oSchemeName,
			Hosts:       oHosts,
			AppliedAt:   firstNonEmptyStr(origin.AppliedAt, origin.UpdatedAt),
			AppliedBy:   firstNonEmptyStr(origin.AppliedBy, origin.Owner),
			RolloutID:   rolloutID,
			ChangedKeys: rehearsalTouchedKeys(origin),
		},
		"default_mode": defaultMode,
		"targets":      targets,
	})
}

func (s *storeServer) handlePropagateRehearsal(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string) {
	lang := reqLang(r)
	var in struct {
		TargetClusters []string `json:"target_clusters"`
		Mode           string   `json:"mode"` // "probe" | "steps"
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in) != nil {
		s.fail(w, 400, "提交的参数格式不对")
		return
	}
	reqMode := strings.ToLower(strings.TrimSpace(in.Mode))
	if reqMode == "" {
		reqMode = "probe"
	}
	if reqMode != "probe" && reqMode != "steps" {
		s.fail(w, 400, "不支持的引入模式，仅支持 probe 或 steps")
		return
	}
	if len(in.TargetClusters) == 0 {
		s.fail(w, 400, "请至少选择一个目标集群")
		return
	}

	rehearsalMu.Lock()
	origin, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		s.fail(w, 404, "演练会话不存在")
		return
	}
	if origin.Stage != "finalized" || !origin.Applied || origin.Voided {
		rehearsalMu.Unlock()
		s.fail(w, 409, tr(lang, "仅已确认「生产已实施完成」的变更演练才可推广到其他集群", "Only production-applied rehearsals can be propagated to other clusters"))
		return
	}
	rolloutID := ""
	if origin.Source != nil && origin.Source.RolloutID != "" {
		rolloutID = origin.Source.RolloutID
	} else {
		rolloutID = "ro-" + origin.ID
		origin.Source = &rehearsalSourceRef{
			RolloutID:         rolloutID,
			IsOrigin:          true,
			OriginClusterID:   origin.ClusterID,
			OriginRehearsalID: origin.ID,
			OriginTitle:       origin.Title,
		}
		if err := s.saveRehearsal(origin); err != nil {
			rehearsalMu.Unlock()
			s.fail(w, 500, "保存样板批次标识失败")
			return
		}
	}
	rehearsalMu.Unlock()

	type createdEntry struct {
		ClusterID        string `json:"cluster_id"`
		RehearsalID      string `json:"rehearsal_id"`
		Stage            string `json:"stage"`
		ImportMode       string `json:"import_mode"`
		StrictPrecheck   bool   `json:"strict_precheck"`
		DowngradedReason string `json:"downgraded_reason,omitempty"`
	}
	type skippedEntry struct {
		ClusterID           string `json:"cluster_id"`
		Reason              string `json:"reason"`
		ExistingRehearsalID string `json:"existing_rehearsal_id,omitempty"`
	}
	var created []createdEntry
	var skipped []skippedEntry
	seenReq := map[string]bool{}

	for _, rawCID := range in.TargetClusters {
		cid := strings.TrimSpace(rawCID)
		if cid == "" || cid == f.ID || seenReq[cid] {
			continue
		}
		seenReq[cid] = true
		tf, ok := s.clusterFactsFor(session.User, cid)
		if !ok {
			skipped = append(skipped, skippedEntry{ClusterID: cid, Reason: tr(lang, "集群不存在或无权限", "Cluster not found or unauthorized")})
			continue
		}
		if tf.Current.DeliveryMode == "configuration" {
			skipped = append(skipped, skippedEntry{ClusterID: cid, Reason: tr(lang, "仅配置交付不支持变更演练", "Config-only delivery does not support rehearsals")})
			continue
		}
		if !strings.EqualFold(tf.Current.AppID, origin.AppID) {
			skipped = append(skipped, skippedEntry{ClusterID: cid, Reason: tr(lang, "主组件不同，无法跨组件推广", "Primary component mismatch")})
			continue
		}

		rehearsalMu.Lock()
		eval := s.evaluatePropagateTarget(f, origin, tf, lang)
		if eval.AlreadyImported {
			rehearsalMu.Unlock()
			skipped = append(skipped, skippedEntry{
				ClusterID:           cid,
				Reason:              tr(lang, "该集群已引入过本变更", "Already imported into this cluster"),
				ExistingRehearsalID: eval.ExistingRehearsalID,
			})
			continue
		}
		derived, downgraded := s.buildPropagatedRehearsal(f, tf, origin, reqMode, eval, session.User, rolloutID, lang)
		err := s.saveRehearsal(derived)
		rehearsalMu.Unlock()
		if err != nil {
			skipped = append(skipped, skippedEntry{ClusterID: cid, Reason: tr(lang, "写入目标集群演练失败", "Failed to save target rehearsal")})
			continue
		}
		created = append(created, createdEntry{
			ClusterID:        cid,
			RehearsalID:      derived.ID,
			Stage:            derived.Stage,
			ImportMode:       derived.Source.ImportMode,
			StrictPrecheck:   derived.Source.StrictPrecheck,
			DowngradedReason: downgraded,
		})
	}

	if created == nil {
		created = []createdEntry{}
	}
	if skipped == nil {
		skipped = []skippedEntry{}
	}
	s.auditReq(r, "rehearsal-propagate", session.User, fmt.Sprintf("%s/%s -> %d cluster(s) (%s)", f.ID, rid, len(created), rolloutID))
	board := s.buildRolloutBoard(session.User, rolloutID, lang)
	s.writeJSON(w, 200, map[string]any{
		"rollout_id": rolloutID,
		"created":    created,
		"skipped":    skipped,
		"board":      board,
	})
}

func (s *storeServer) handleGlobalRehearsals(w http.ResponseWriter, r *http.Request, session storeSession) {
	if !s.can(session.User, "delivery.view") {
		s.fail(w, 403, "权限不足")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/rehearsals")
	path = strings.Trim(path, "/")
	parts := []string{}
	if path != "" {
		parts = strings.Split(path, "/")
	}
	switch {
	case len(parts) == 1 && parts[0] == "templates" && r.Method == "GET":
		s.handleRehearsalTemplates(w, r, session)
	case len(parts) == 2 && parts[0] == "rollout" && r.Method == "GET" && reRolloutID.MatchString(parts[1]):
		board := s.buildRolloutBoard(session.User, parts[1], reqLang(r))
		if board == nil {
			s.fail(w, 404, "未找到对应的推广批次")
			return
		}
		s.writeJSON(w, 200, board)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) handleRehearsalTemplates(w http.ResponseWriter, r *http.Request, session storeSession) {
	lang := reqLang(r)
	appFilter := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("app_id")))
	targetClusterID := strings.TrimSpace(r.URL.Query().Get("target_cluster"))
	var targetFacts clusterFacts
	hasTarget := false
	if targetClusterID != "" {
		if tf, ok := s.clusterFactsFor(session.User, targetClusterID); ok {
			targetFacts = tf
			hasTarget = true
			if appFilter == "" {
				appFilter = strings.ToLower(strings.TrimSpace(tf.Current.AppID))
			}
		}
	}

	// Precompute rollout group totals so each template shows e.g. "3/10 套已落地".
	rolloutStats := map[string][2]int{} // [total_non_voided, applied]
	allClusters := s.visibleClusterIDs(session.User)
	clusterRehearsals := map[string][]changeRehearsal{}
	for _, cid := range allClusters {
		rhs := s.listRehearsals(cid)
		clusterRehearsals[cid] = rhs
		for _, rh := range rhs {
			if rh.Voided || rh.Source == nil || rh.Source.RolloutID == "" {
				continue
			}
			st := rolloutStats[rh.Source.RolloutID]
			st[0]++
			if rh.Stage == "finalized" && rh.Applied {
				st[1]++
			}
			rolloutStats[rh.Source.RolloutID] = st
		}
	}

	type tplCand struct {
		item     rehearsalTemplateItem
		isOrigin bool
	}
	var cands []tplCand
	for _, cid := range allClusters {
		if cid == targetClusterID {
			continue
		}
		of, ok := s.clusterFactsFor(session.User, cid)
		if !ok || of.Current.DeliveryMode == "configuration" {
			continue
		}
		if appFilter != "" && !strings.EqualFold(of.Current.AppID, appFilter) {
			continue
		}
		oSchemeID, oSchemeName, oVer, oHosts, _ := s.clusterSchemeMeta(of, lang)
		for _, rh := range clusterRehearsals[cid] {
			// Strict gate: ONLY production-applied, non-voided rehearsals can be imported as templates!
			if rh.Stage != "finalized" || !rh.Applied || rh.Voided {
				continue
			}
			changes := rehearsalAppliedOrExtractedChanges(rh)
			cat := classifyRehearsalCategory(rh, changes)
			sig := rehearsalContentSignature(rh, changes)
			item := rehearsalTemplateItem{
				OriginClusterID:   cid,
				OriginRehearsalID: rh.ID,
				Title:             rh.Title,
				Goal:              truncRunes(rh.Goal, 240),
				Mode:              firstNonEmptyStr(rh.Mode, "full"),
				Category:          cat,
				CategoryLabel:     rehearsalCategoryLabel(cat, lang),
				ContentSignature:  sig,
				AppID:             rh.AppID,
				AppName:           rh.AppName,
				Version:           oVer,
				SchemeID:          oSchemeID,
				SchemeName:        oSchemeName,
				Hosts:             oHosts,
				AppliedAt:         firstNonEmptyStr(rh.AppliedAt, rh.UpdatedAt),
				AppliedBy:         firstNonEmptyStr(rh.AppliedBy, rh.Owner),
				AppliedSummary:    truncRunes(rh.AppliedSummary, 220),
				AppliedChanges:    changes,
				StepsCount:        len(rh.Steps),
			}
			isOrigin := false
			if rh.Source != nil && rh.Source.RolloutID != "" {
				item.RolloutID = rh.Source.RolloutID
				isOrigin = rh.Source.IsOrigin
				if st, has := rolloutStats[rh.Source.RolloutID]; has {
					item.RolloutTotal = st[0]
					item.RolloutApplied = st[1]
				}
			}
			if hasTarget {
				eval := s.evaluatePropagateTarget(of, rh, targetFacts, lang)
				item.MatchTier = eval.MatchTier
				item.MatchReason = eval.MatchReason
				item.AllowSkipProbe = eval.AllowSkipProbe
				item.SkipProbeBlockReason = eval.SkipProbeBlockReason
				item.AlreadyImported = eval.AlreadyImported
				item.AlreadyEffective = eval.AlreadyEffective
				item.ConflictKeys = eval.ConflictKeys
				item.ConflictSummary = eval.ConflictSummary
				item.ExistingRehearsalID = eval.ExistingRehearsalID
			}
			cands = append(cands, tplCand{item: item, isOrigin: isOrigin})
		}
	}

	// Consolidate equivalent templates via Union-Find across BOTH explicit RolloutID lineage
	// and deterministic ContentSignature (identical normalized parameter deltas across independent runs).
	parent := make([]int, len(cands))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(x int) int {
		for parent[x] != x {
			parent[x] = parent[parent[x]]
			x = parent[x]
		}
		return x
	}
	union := func(a, b int) {
		ra, rb := find(a), find(b)
		if ra != rb {
			parent[rb] = ra
		}
	}
	byRollout := map[string]int{}
	bySig := map[string]int{}
	for i, c := range cands {
		if rid := c.item.RolloutID; rid != "" {
			if prev, has := byRollout[rid]; has {
				union(prev, i)
			} else {
				byRollout[rid] = i
			}
		}
		if sig := c.item.ContentSignature; sig != "" {
			if prev, has := bySig[sig]; has {
				union(prev, i)
			} else {
				bySig[sig] = i
			}
		}
	}

	groups := map[int][]tplCand{}
	var groupOrder []int
	for i, c := range cands {
		root := find(i)
		if _, has := groups[root]; !has {
			groupOrder = append(groupOrder, root)
		}
		groups[root] = append(groups[root], c)
	}

	var out []rehearsalTemplateItem
	for _, root := range groupOrder {
		members := groups[root]
		sort.Slice(members, func(i, j int) bool {
			a, b := members[i], members[j]
			if a.item.AlreadyImported != b.item.AlreadyImported {
				return a.item.AlreadyImported
			}
			aExact := a.item.MatchTier == "exact"
			bExact := b.item.MatchTier == "exact"
			if aExact != bExact {
				return aExact
			}
			if a.isOrigin != b.isOrigin {
				return a.isOrigin
			}
			aHasRo := a.item.RolloutID != ""
			bHasRo := b.item.RolloutID != ""
			if aHasRo != bHasRo {
				return aHasRo
			}
			if a.item.AppliedAt != b.item.AppliedAt {
				return a.item.AppliedAt > b.item.AppliedAt
			}
			return a.item.OriginClusterID < b.item.OriginClusterID
		})
		primary := members[0].item
		seenClusters := map[string]bool{}
		var verifiedClusters []string
		variants := make([]rehearsalTemplateVariant, 0, len(members))
		for _, m := range members {
			it := m.item
			if !seenClusters[it.OriginClusterID] {
				seenClusters[it.OriginClusterID] = true
				verifiedClusters = append(verifiedClusters, it.OriginClusterID)
			}
			if it.AlreadyEffective && !primary.AlreadyImported && !primary.AlreadyEffective {
				primary.AlreadyEffective = true
				if primary.ExistingRehearsalID == "" && it.ExistingRehearsalID != "" {
					primary.ExistingRehearsalID = it.ExistingRehearsalID
				}
			}
			variants = append(variants, rehearsalTemplateVariant{
				ClusterID:            it.OriginClusterID,
				RehearsalID:          it.OriginRehearsalID,
				RolloutID:            it.RolloutID,
				Title:                it.Title,
				Version:              it.Version,
				SchemeName:           it.SchemeName,
				Hosts:                it.Hosts,
				AppliedAt:            it.AppliedAt,
				AppliedBy:            it.AppliedBy,
				MatchTier:            it.MatchTier,
				AllowSkipProbe:       it.AllowSkipProbe,
				SkipProbeBlockReason: it.SkipProbeBlockReason,
				IsOrigin:             m.isOrigin,
				StepsCount:           it.StepsCount,
			})
		}
		primary.VerifiedClusters = verifiedClusters
		primary.MergedCount = len(variants)
		primary.Variants = variants
		out = append(out, primary)
	}

	sort.Slice(out, func(i, j int) bool {
		// Unimported & not-yet-effective exact matches first, then compatible, then already effective, then already imported; newest first within each tier.
		rank := func(it rehearsalTemplateItem) int {
			if it.AlreadyImported {
				return 3
			}
			if it.AlreadyEffective {
				return 2
			}
			if it.MatchTier == "compatible" {
				return 1
			}
			return 0
		}
		ri, rj := rank(out[i]), rank(out[j])
		if ri != rj {
			return ri < rj
		}
		return out[i].AppliedAt > out[j].AppliedAt
	})
	if out == nil {
		out = []rehearsalTemplateItem{}
	}
	s.writeJSON(w, 200, out)
}

func (s *storeServer) buildRolloutBoard(user, rolloutID, lang string) *rolloutBoardResponse {
	if !reRolloutID.MatchString(rolloutID) {
		return nil
	}
	allClusters := s.visibleClusterIDs(user)
	var originFacts clusterFacts
	var originRh *changeRehearsal
	type found struct {
		facts clusterFacts
		rh    changeRehearsal
	}
	var hits []found

	// Scan all visible clusters (and rehearsal directories for safety).
	scanned := map[string]bool{}
	for _, cid := range allClusters {
		scanned[cid] = true
		rhs := s.listRehearsalsLang(cid, lang)
		var tf clusterFacts
		loaded := false
		for _, rh := range rhs {
			if rh.Source == nil || rh.Source.RolloutID != rolloutID {
				continue
			}
			if !loaded {
				tf, _ = s.clusterFactsFor(user, cid)
				loaded = true
			}
			hits = append(hits, found{facts: tf, rh: rh})
			if rh.Source.IsOrigin {
				cp := rh
				originRh = &cp
				originFacts = tf
			}
		}
	}
	// Also scan rehearsals root dir in case an origin cluster directory exists outside current cache.
	if entries, err := os.ReadDir(filepath.Join(s.cfg.DataDir, "rehearsals")); err == nil {
		for _, e := range entries {
			if !e.IsDir() || scanned[e.Name()] {
				continue
			}
			tf, ok := s.clusterFactsFor(user, e.Name())
			if !ok {
				continue
			}
			for _, rh := range s.listRehearsalsLang(e.Name(), lang) {
				if rh.Source == nil || rh.Source.RolloutID != rolloutID {
					continue
				}
				hits = append(hits, found{facts: tf, rh: rh})
				if rh.Source.IsOrigin {
					cp := rh
					originRh = &cp
					originFacts = tf
				}
			}
		}
	}
	if len(hits) == 0 {
		return nil
	}
	if originRh == nil {
		cp := hits[0].rh
		originRh = &cp
		originFacts = hits[0].facts
	}

	oSchemeID, _, oVer, _, _ := s.clusterSchemeMeta(originFacts, lang)
	board := &rolloutBoardResponse{
		RolloutID:         rolloutID,
		OriginClusterID:   originRh.ClusterID,
		OriginRehearsalID: originRh.ID,
		Title:             originRh.Title,
		AppID:             originRh.AppID,
		AppName:           originRh.AppName,
	}

	memberClusters := map[string]bool{}
	for _, h := range hits {
		rh := h.rh
		memberClusters[rh.ClusterID] = true
		tSchemeID, tSchemeName, tVer, tHosts, _ := s.clusterSchemeMeta(h.facts, lang)
		tier := "compatible"
		if rh.Source != nil && rh.Source.IsOrigin {
			tier = "origin"
		} else {
			sameScheme := (oSchemeID == "" && tSchemeID == "") || (oSchemeID != "" && oSchemeID == tSchemeID)
			sameMajor := majorVersionOf(oVer) == "" || majorVersionOf(tVer) == "" || majorVersionOf(oVer) == majorVersionOf(tVer)
			if sameScheme && sameMajor {
				tier = "exact"
			}
		}
		reqTotal, reqDone := 0, 0
		for _, st := range rh.Steps {
			if st.Optional || st.Phase == "rollback" {
				continue
			}
			reqTotal++
			if st.Status == "passed" || st.Status == "skipped" {
				reqDone++
			}
		}
		statusKey := rh.Stage
		if rh.Voided {
			statusKey = "voided"
		} else if rh.Stage == "finalized" && rh.Applied {
			statusKey = "applied"
		} else if rh.Stage == "finalized" {
			statusKey = "finalized_pending"
		}

		conflictCount := 0
		conflictSummary := ""
		if !rh.Voided && !rh.Applied {
			for _, al := range rh.ConflictAlerts {
				if al.Severity == "conflict" || al.Severity == "stale" {
					conflictCount++
					if conflictSummary == "" {
						conflictSummary = al.Summary
					}
				}
			}
		}

		m := rolloutBoardMember{
			ClusterID:       rh.ClusterID,
			RehearsalID:     rh.ID,
			IsOrigin:        rh.Source != nil && rh.Source.IsOrigin,
			AppName:         rh.AppName,
			Version:         tVer,
			SchemeName:      tSchemeName,
			Hosts:           tHosts,
			MatchTier:       tier,
			ImportMode:      rh.Source.ImportMode,
			StrictPrecheck:  rh.Source.StrictPrecheck,
			Stage:           rh.Stage,
			StatusKey:       statusKey,
			StepsDone:       reqDone,
			StepsTotal:      reqTotal,
			Applied:         rh.Applied,
			AppliedAt:       rh.AppliedAt,
			AppliedBy:       firstNonEmptyStr(rh.AppliedBy, rh.Owner),
			Voided:          rh.Voided,
			VoidReason:      rh.VoidReason,
			DocID:           rh.DocID,
			ConflictCount:   conflictCount,
			ConflictSummary: conflictSummary,
			UpdatedAt:       rh.UpdatedAt,
		}
		board.Members = append(board.Members, m)

		if m.Voided {
			board.Voided++
		} else {
			board.Total++
			switch statusKey {
			case "applied":
				board.Applied++
			case "finalized_pending":
				board.FinalizedPending++
				board.InProgress++
			case "probing", "scoping":
				board.PendingProbe++
				board.InProgress++
			default:
				board.InProgress++
			}
			if conflictCount > 0 {
				board.Attention++
			}
		}
	}

	// Count how many more compatible same-app clusters haven't joined this rollout yet.
	for _, cid := range allClusters {
		if memberClusters[cid] {
			continue
		}
		tf, ok := s.clusterFactsFor(user, cid)
		if !ok || tf.Current.DeliveryMode == "configuration" {
			continue
		}
		if strings.EqualFold(tf.Current.AppID, originRh.AppID) {
			board.AvailableMore++
		}
	}

	statusOrder := map[string]int{
		"finalized_pending": 1,
		"rehearsing":        2,
		"probing":           3,
		"scoping":           4,
		"applied":           5,
		"voided":            6,
	}
	sort.Slice(board.Members, func(i, j int) bool {
		a, b := board.Members[i], board.Members[j]
		if a.IsOrigin != b.IsOrigin {
			return a.IsOrigin
		}
		if (a.ConflictCount > 0) != (b.ConflictCount > 0) {
			return a.ConflictCount > 0
		}
		oa, ob := statusOrder[a.StatusKey], statusOrder[b.StatusKey]
		if oa != ob {
			return oa < ob
		}
		return a.ClusterID < b.ClusterID
	})
	for i := range board.Members {
		m := board.Members[i]
		if !m.Voided && !m.Applied {
			cp := m
			board.NextPending = &cp
			break
		}
	}
	return board
}

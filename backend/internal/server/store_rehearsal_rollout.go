package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
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

func majorVersionOf(v string) string {
	s := strings.TrimSpace(strings.TrimPrefix(strings.ToLower(v), "v"))
	if s == "" {
		return ""
	}
	for i, ch := range s {
		if ch == '.' || ch == '-' || ch == ' ' {
			return s[:i]
		}
	}
	return s
}

func (s *storeServer) clusterSchemeMeta(f clusterFacts, lang string) (schemeID, schemeName, version string, hostCount int, deployed bool) {
	sc := s.deliveryScheme(f.Current.ID, f.Current.AppID, f.Current.Scheme)
	if sc != nil {
		sc = mwpack.LocalizeSchemeSummary(lang, sc)
		schemeID = strings.ToLower(strings.TrimSpace(sc.ID))
		schemeName = strings.TrimSpace(sc.Name)
	}
	version = s.deliveryAppVersion(f.Current.ID, f.Current.AppID, f.Current.Version)
	if f.Plan != nil {
		hostCount = len(f.Plan.Hosts)
		if schemeID == "" {
			hasPatroni := false
			hasSentinel := false
			var comps []string
			seenComp := map[string]bool{}
			for _, inst := range f.Plan.Instances {
				if inst.External {
					continue
				}
				if inst.Component == "patroni" {
					hasPatroni = true
				}
				if inst.Component == "redis" && len(inst.Roles["sentinel"]) > 0 {
					hasSentinel = true
				}
				if !seenComp[inst.Component] {
					seenComp[inst.Component] = true
					comps = append(comps, inst.Component)
				}
			}
			sort.Strings(comps)
			switch {
			case hasPatroni:
				schemeID = "patroni"
			case hasSentinel:
				schemeID = "sentinel"
			case hostCount <= 1:
				schemeID = "standalone:" + strings.Join(comps, "+")
			default:
				schemeID = "cluster:" + strings.Join(comps, "+")
			}
		}
	} else if d := s.readSpec(f.Current.ID); d != nil {
		hostCount = len(d.Hosts)
	}
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
	oSchemeID, _, oVer, oHosts, _ := s.clusterSchemeMeta(originFacts, lang)
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
		item.SkipProbeBlockReason = tr(lang, "架构或主版本与样板集群不同，须先跑只读探针核实现场", "Architecture or major version differs; read-only probe required")
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

// buildClusterRemapPairs builds deterministic text replacement pairs (longest-first)
// to scrub origin cluster IDs, IPs, hostnames, and VIPs before applying to a target cluster.
func buildClusterRemapPairs(originFacts, targetFacts clusterFacts) [][2]string {
	var pairs [][2]string
	seen := map[string]bool{}
	add := func(from, to string) {
		from = strings.TrimSpace(from)
		to = strings.TrimSpace(to)
		if from == "" || to == "" || from == to || seen[from] {
			return
		}
		seen[from] = true
		pairs = append(pairs, [2]string{from, to})
	}
	add(originFacts.ID, targetFacts.ID)

	if originFacts.Plan != nil && targetFacts.Plan != nil {
		// Role-aligned host mapping when possible, falling back to positional mapping.
		oHosts := originFacts.Plan.Hosts
		tHosts := targetFacts.Plan.Hosts
		for i, oh := range oHosts {
			if i < len(tHosts) {
				add(oh.IP, tHosts[i].IP)
				add(oh.Name, tHosts[i].Name)
			} else if oh.IP != "" {
				add(oh.IP, "<目标节点IP>")
			}
		}
		// Remap frontend/ELB VIP addresses if different.
		oFronts := map[string]string{}
		for _, inst := range originFacts.Plan.Instances {
			for epName, fr := range inst.Fronts {
				if fr.Address != "" {
					oFronts[inst.Component+":"+epName] = fr.Address
				}
			}
		}
		for _, inst := range targetFacts.Plan.Instances {
			for epName, fr := range inst.Fronts {
				if fr.Address != "" {
					if oldAddr, ok := oFronts[inst.Component+":"+epName]; ok {
						add(oldAddr, fr.Address)
					}
				}
			}
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		return len(pairs[i][0]) > len(pairs[j][0])
	})
	return pairs
}

func remapTextWithPairs(text string, pairs [][2]string) string {
	out := text
	for _, p := range pairs {
		out = strings.ReplaceAll(out, p[0], p[1])
	}
	return out
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

func buildFallbackProbeScript(targetFacts clusterFacts, origin changeRehearsal) string {
	app := strings.ToLower(strings.TrimSpace(targetFacts.Current.AppID))
	keys := rehearsalTouchedKeys(origin)
	var b strings.Builder
	b.WriteString("#!/usr/bin/env bash\n")
	b.WriteString("if [ -z \"${BASH_VERSION:-}\" ]; then exec bash \"$0\" \"$@\"; fi\n")
	b.WriteString("set -uo pipefail\nexport LC_ALL=C\n")
	b.WriteString("printf '=== node=%s ip=%s ===\\n' \"$(hostname -s)\" \"$(hostname -I 2>/dev/null | awk '{print $1}')\"\n")
	switch app {
	case "postgresql":
		b.WriteString("printf '[version & topology]\\n'\n")
		b.WriteString("sudo -n -u postgres psql -X -w -h /var/run/postgresql -p 5432 -d postgres -Atc \"SELECT 'pg_version='||current_setting('server_version')||' role='||CASE WHEN pg_is_in_recovery() THEN 'replica' ELSE 'primary' END;\" 2>/dev/null || printf 'ERROR: psql unavailable\\n'\n")
		b.WriteString("patroni --version 2>/dev/null || true\n")
		b.WriteString("timeout 15s patronictl -c /etc/patroni/patroni.yml list 2>/dev/null || printf 'WARN: patronictl list unavailable\\n'\n")
		if len(keys) > 0 {
			var pgKeys []string
			for _, k := range keys {
				lk := strings.ToLower(k)
				if lk == "pg_hba" {
					b.WriteString("printf '[pg_hba_file_rules errors]\\n'\n")
					b.WriteString("sudo -n -u postgres psql -X -w -h /var/run/postgresql -p 5432 -d postgres -Atc \"SELECT count(*) FILTER (WHERE error IS NOT NULL) AS parse_errors, count(*) AS total_rules FROM pg_hba_file_rules;\" 2>/dev/null || true\n")
				} else if regexp.MustCompile(`^[a-z0-9_]+$`).MatchString(lk) {
					pgKeys = append(pgKeys, "'"+lk+"'")
				}
			}
			if len(pgKeys) > 0 {
				fmt.Fprintf(&b, "printf '[target parameters]\\n'\n")
				fmt.Fprintf(&b, "sudo -n -u postgres psql -X -w -h /var/run/postgresql -p 5432 -d postgres -Atc \"SELECT name||'='||setting||' source='||source||' pending_restart='||pending_restart FROM pg_settings WHERE name IN (%s) ORDER BY name;\" 2>/dev/null || true\n", strings.Join(pgKeys, ","))
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
func buildStrictPropagatedPrecheck(
	originFacts, targetFacts clusterFacts,
	origin changeRehearsal,
	pairs [][2]string,
	origPrecheck *rehearsalStep,
	lang string,
) rehearsalStep {
	app := strings.ToLower(strings.TrimSpace(targetFacts.Current.AppID))
	changes := rehearsalAppliedOrExtractedChanges(origin)
	var cmdLines []string
	cmdLines = append(cmdLines, `printf 'node=%s ip=%s\n' "$(hostname -s)" "$(hostname -I 2>/dev/null | awk '{print $1}')"`)

	var extraDirs []string
	var pgSettings []string
	hasHBA := false
	for _, ch := range changes {
		k := strings.TrimSpace(ch.Key)
		lk := strings.ToLower(k)
		v := strings.TrimSpace(ch.After)
		if lk == "pg_hba" {
			hasHBA = true
		} else if app == "postgresql" && regexp.MustCompile(`^[a-z0-9_]+$`).MatchString(lk) {
			pgSettings = append(pgSettings, "'"+lk+"'")
		}
		if strings.HasPrefix(v, "/") && !strings.ContainsAny(v, " \t\n;'\"") {
			extraDirs = append(extraDirs, v)
		}
	}

	switch app {
	case "postgresql":
		cmdLines = append(cmdLines,
			`systemctl is-active patroni etcd 2>/dev/null || true`,
			`patroni --version`,
			`sudo -n -u postgres psql -X -w -h /var/run/postgresql -p 5432 -d postgres -Atc "SELECT 'pg='||current_setting('server_version')||' role='||CASE WHEN pg_is_in_recovery() THEN 'replica' ELSE 'primary' END||' pending_restart='||(SELECT count(*) FROM pg_settings WHERE pending_restart)||' long_tx='||(SELECT count(*) FROM pg_stat_activity WHERE state<>'idle' AND now()-xact_start>interval '30 seconds');"`,
			`patronictl -c /etc/patroni/patroni.yml list`,
		)
		if len(pgSettings) > 0 {
			cmdLines = append(cmdLines,
				fmt.Sprintf(`sudo -n -u postgres psql -X -w -h /var/run/postgresql -p 5432 -d postgres -Atc "SELECT name||'='||setting||' source='||source||' pending_restart='||pending_restart FROM pg_settings WHERE name IN (%s) ORDER BY name;"`, strings.Join(pgSettings, ",")),
			)
		}
		if hasHBA {
			cmdLines = append(cmdLines,
				`patronictl -c /etc/patroni/patroni.yml show-config | grep -nE '^[[:space:]]+- (host|local)'`,
				`sudo -n -u postgres psql -X -w -h /var/run/postgresql -p 5432 -d postgres -Atc "SELECT count(*) FILTER (WHERE error IS NOT NULL) AS parse_errors, count(*) AS total_rules FROM pg_hba_file_rules;"`,
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
			cmdLines = append(cmdLines, remapTextWithPairs(strings.TrimSpace(origPrecheck.Command), pairs))
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
	if app == "postgresql" {
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
			fmt.Sprintf("3) 目标配置项（%s）当前现值无意外冲突且未存在未决变更，磁盘余量充足。", strings.Join(keys, "、")),
			fmt.Sprintf("3) Target parameter values (%s) have no unexpected conflicts and disk space is sufficient.", strings.Join(keys, ", "))))
	} else {
		expectParts = append(expectParts, tr(lang,
			"3) 目标路径/权限与磁盘空间满足变更前提。",
			"3) Target paths, permissions, and disk headroom satisfy prerequisites."))
	}
	if origPrecheck != nil && strings.TrimSpace(origPrecheck.Expect) != "" {
		expectParts = append(expectParts, tr(lang, "补充核对：", "Additional check: ")+remapTextWithPairs(strings.TrimSpace(origPrecheck.Expect), pairs))
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

	pairs := buildClusterRemapPairs(originFacts, targetFacts)
	now := time.Now().UTC().Format(time.RFC3339)
	rid := randomStoreToken(6)

	// Inherit aligned scope questions & answers cleanly.
	var scopeQs []rehearsalScopeQuestion
	for _, q := range origin.ScopeQuestions {
		scopeQs = append(scopeQs, rehearsalScopeQuestion{
			ID:       q.ID,
			Label:    q.Label,
			Question: q.Question,
			Options:  append([]string(nil), q.Options...),
			Answer:   q.Answer,
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

	// Remap probe script (or synthesize fallback if pilot was quick mode without probe script).
	probeScript := ""
	if strings.TrimSpace(origin.ProbeScript) != "" {
		probeScript = remapTextWithPairs(origin.ProbeScript, pairs)
	} else {
		probeScript = buildFallbackProbeScript(targetFacts, origin)
	}
	probeScript = ensureProbeBashGuard(probeScript)
	probeSafe, probeWarns := validateReadOnlyProbeScriptLang(probeScript, lang)

	var probeNotes []string
	probeNotes = append(probeNotes, tr(lang,
		fmt.Sprintf("本变更引用自已落地样板集群 %s（%s），已自动继承边界约束并映射至当前集群 %s 的基线地址；请在本集群节点执行探针核实现场后继续。", originFacts.ID, origin.Title, targetFacts.ID),
		fmt.Sprintf("Imported from production-applied pilot %s (%s) with boundaries inherited and baseline addresses remapped for %s; run the read-only probe on this cluster before proceeding.", originFacts.ID, origin.Title, targetFacts.ID)))
	for _, n := range origin.ProbeNotes {
		if t := strings.TrimSpace(remapTextWithPairs(n, pairs)); t != "" {
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

		steps = append(steps, buildStrictPropagatedPrecheck(originFacts, targetFacts, origin, pairs, origPre, lang))
		for _, st := range restSteps {
			ord := len(steps) + 1
			remappedCmd := remapTextWithPairs(st.Command, pairs)
			var remappedSubs []rehearsalStepCommand
			for _, sub := range st.Commands {
				remappedSubs = append(remappedSubs, rehearsalStepCommand{
					Label:      remapTextWithPairs(sub.Label, pairs),
					TargetRole: remapTextWithPairs(sub.TargetRole, pairs),
					Command:    remapTextWithPairs(sub.Command, pairs),
					Gate:       remapTextWithPairs(sub.Gate, pairs),
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
			steps = append(steps, rehearsalStep{
				ID:         fmt.Sprintf("s%d", ord),
				Phase:      st.Phase,
				Order:      ord,
				Title:      remapTextWithPairs(st.Title, pairs),
				TargetRole: remapTextWithPairs(st.TargetRole, pairs),
				Command:    remappedCmd,
				Commands:   remappedSubs,
				Expect:     remapTextWithPairs(st.Expect, pairs),
				RiskNote:   remapTextWithPairs(st.RiskNote, pairs),
				Rollback:   remapTextWithPairs(st.Rollback, pairs),
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
		Goal:            remapTextWithPairs(origin.Goal, pairs),
		ExtraScope:      remapTextWithPairs(origin.ExtraScope, pairs),
		Owner:           operator,
		Mode:            rhMode,
		Stage:           stage,
		SecurityContext: secCopy,
		ScopeQuestions:  scopeQs,
		ScopeSummary:    remapTextWithPairs(origin.ScopeSummary, pairs),
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

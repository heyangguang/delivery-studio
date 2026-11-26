package server

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"delivery-studio/mwpack"
)

// Three-Layer Authoritative Cluster State Engine:
//   Layer 1 (Base Spec):          Day-0 deployment.yml + plan.json, or Imported Cluster baseline.
//   Layer 2 (Applied Overrides):  Production-confirmed Change Rehearsals & Baseline Calibrations (works in pure offline mode too).
//   Layer 3 (Live Snapshot):      100% Read-Only Machine Telemetry via bound Agent or pasted read-only probe.
//
// Core Invariant (Non-Destructive Incremental Merge):
//   Binding an Agent or running live inspection NEVER deletes or wipes previously onboarded / configured hosts,
//   external VIP/ELB/DNS endpoints, notes, companions, or unprobed parameters. Measured keys update in-place
//   and compute structured Config Drift against the expected baseline.

const (
	clusterSourceStaticSpec      = "static_spec"
	clusterSourceAppliedBaseline = "applied_baseline"
	clusterSourceManualProbe     = "manual_probe"
	clusterSourceLiveAgent       = "live_agent"
)

type clusterProbePolicy struct {
	AutoInspectEnabled     bool `json:"auto_inspect_enabled"`
	AutoInspectIntervalSec int  `json:"auto_inspect_interval_sec"` // default 1800 (30m), min 300 (5m), max 86400 (24h)
	InspectOnBind          bool `json:"inspect_on_bind"`
}

func defaultClusterProbePolicy() clusterProbePolicy {
	return clusterProbePolicy{
		AutoInspectEnabled:     false,
		AutoInspectIntervalSec: 1800,
		InspectOnBind:          true,
	}
}

func normalizeClusterProbePolicy(in clusterProbePolicy) clusterProbePolicy {
	if in.AutoInspectIntervalSec <= 0 {
		in.AutoInspectIntervalSec = 1800
	} else if in.AutoInspectIntervalSec < 60 {
		in.AutoInspectIntervalSec = 60
	} else if in.AutoInspectIntervalSec > 86400*7 {
		in.AutoInspectIntervalSec = 86400 * 7
	}
	return in
}

type clusterOverrideEntry struct {
	Key         string `json:"key"`
	Before      string `json:"before,omitempty"`
	After       string `json:"after"`
	SourceID    string `json:"source_id,omitempty"`
	SourceTitle string `json:"source_title,omitempty"`
	By          string `json:"by,omitempty"`
	At          string `json:"at,omitempty"`
}

type clusterBaselineOverrides struct {
	Params       map[string]string      `json:"params,omitempty"`
	Entries      []clusterOverrideEntry `json:"entries,omitempty"`
	ServiceUnits []string               `json:"service_units,omitempty"`
	ConfigPaths  []string               `json:"config_paths,omitempty"`
	DataDirs     []string               `json:"data_dirs,omitempty"`
	LogDirs      []string               `json:"log_dirs,omitempty"`
	UpdatedAt    string                 `json:"updated_at,omitempty"`
	UpdatedBy    string                 `json:"updated_by,omitempty"`
}

type clusterServiceLive struct {
	Unit        string `json:"unit"`
	ActiveState string `json:"active_state"` // active | inactive | failed | activating
	SubState    string `json:"sub_state,omitempty"`
	Healthy     bool   `json:"healthy"`
}

type clusterHostLive struct {
	Host             string               `json:"host"`
	IP               string               `json:"ip"`
	ProbedAt         string               `json:"probed_at"`
	Online           bool                 `json:"online"`
	OSDetail         string               `json:"os_detail,omitempty"`
	Kernel           string               `json:"kernel,omitempty"`
	Role             string               `json:"role,omitempty"` // primary | replica | leader | follower | active | backup | node
	ReplicationState string               `json:"replication_state,omitempty"`
	Services         []clusterServiceLive `json:"services,omitempty"`
	ListeningPorts   []int                `json:"listening_ports,omitempty"`
	VIPs             []string             `json:"vips,omitempty"`
	ExactVersion     string               `json:"exact_version,omitempty"`
	Params           map[string]string    `json:"params,omitempty"`
	ClientCIDRs      []string             `json:"client_cidrs,omitempty"`
	Certs            []secCertCheck       `json:"certs,omitempty"`
	Packages         []mwpack.ImportedPkg `json:"packages,omitempty"`
	Companions       []mwpack.ImportedCompanion `json:"companions,omitempty"`
	ServiceUnits     []string             `json:"service_units,omitempty"`
	ConfigPaths      []string             `json:"config_paths,omitempty"`
	DataDirs         []string             `json:"data_dirs,omitempty"`
	LogDirs          []string             `json:"log_dirs,omitempty"`
}

type clusterLiveSnapshot struct {
	Source       string                     `json:"source"` // live_agent | manual_probe
	TaskID       string                     `json:"task_id,omitempty"`
	AgentID      string                     `json:"agent_id,omitempty"`
	AgentName    string                     `json:"agent_name,omitempty"`
	CollectedAt  string                     `json:"collected_at"`
	CollectedBy  string                     `json:"collected_by,omitempty"`
	ProbedHosts  int                        `json:"probed_hosts"`
	TotalHosts   int                        `json:"total_hosts"`
	ExactVersion string                     `json:"exact_version,omitempty"`
	Hosts        map[string]clusterHostLive `json:"hosts"`
	MergedParams map[string]string          `json:"merged_params,omitempty"`
	ClientCIDRs  []string                   `json:"client_cidrs,omitempty"`
	Certs        []secCertCheck             `json:"certs,omitempty"`
	Packages     []mwpack.ImportedPkg       `json:"packages,omitempty"`
	Companions   []mwpack.ImportedCompanion `json:"companions,omitempty"`
	ServiceUnits []string                   `json:"service_units,omitempty"`
	ConfigPaths  []string                   `json:"config_paths,omitempty"`
	DataDirs     []string                   `json:"data_dirs,omitempty"`
	LogDirs      []string                   `json:"log_dirs,omitempty"`
}

type clusterParamDrift struct {
	Key          string `json:"key"`
	Instance     string `json:"instance,omitempty"`
	Expected     string `json:"expected"`
	Actual       string `json:"actual"`
	ExpectedFrom string `json:"expected_from"` // deployment.yml | applied_rehearsal | imported_baseline
	MeasuredAt   string `json:"measured_at,omitempty"`
}

type clusterRoleDrift struct {
	Host         string `json:"host"`
	IP           string `json:"ip,omitempty"`
	ExpectedRole string `json:"expected_role"`
	ActualRole   string `json:"actual_role"`
}

type clusterDriftReport struct {
	HasDrift        bool                `json:"has_drift"`
	ParamDrifts     []clusterParamDrift `json:"param_drifts"`
	RoleDrifts      []clusterRoleDrift  `json:"role_drifts"`
	StoppedServices []string            `json:"stopped_services,omitempty"`
	ComputedAt      string              `json:"computed_at"`
}

type clusterStateRecord struct {
	ClusterID    string                   `json:"cluster_id"`
	Overrides    clusterBaselineOverrides `json:"overrides"`
	Live         *clusterLiveSnapshot     `json:"live,omitempty"`
	Drift        *clusterDriftReport      `json:"drift,omitempty"`
	ProbePolicy  clusterProbePolicy       `json:"probe_policy"`
	DataSource   string                   `json:"data_source"`
	LastProbedAt string                   `json:"last_probed_at,omitempty"`
}

type clusterLiveSummary struct {
	DataSource          string             `json:"data_source"`
	DataSourceLabel     string             `json:"data_source_label"`
	HasBoundAgent       bool               `json:"has_bound_agent"`
	HasOnlineAgent      bool               `json:"has_online_agent"`
	LastProbedAt        string             `json:"last_probed_at,omitempty"`
	ProbedHosts         int                `json:"probed_hosts,omitempty"`
	TotalHosts          int                `json:"total_hosts,omitempty"`
	AgentName           string             `json:"agent_name,omitempty"`
	ActiveInspectTaskID string             `json:"active_inspect_task_id,omitempty"`
	DriftCount          int                `json:"drift_count,omitempty"`
	RoleDriftCount      int                `json:"role_drift_count,omitempty"`
	StoppedServiceCount int                `json:"stopped_service_count,omitempty"`
	ProbePolicy         clusterProbePolicy `json:"probe_policy"`
}

type clusterEffectiveView struct {
	ClusterID       string                   `json:"cluster_id"`
	Summary         clusterLiveSummary       `json:"summary"`
	Overrides       clusterBaselineOverrides `json:"overrides"`
	Live            *clusterLiveSnapshot     `json:"live,omitempty"`
	Drift           *clusterDriftReport      `json:"drift,omitempty"`
	EffectiveParams map[string]any           `json:"effective_params"`
	ParamSources    map[string]string        `json:"param_sources"` // key -> static_spec | applied_baseline | live_agent | manual_probe
	EffectiveRoles  map[string]string        `json:"effective_roles"`
	HostLiveness    map[string]bool          `json:"host_liveness,omitempty"`
}

func clusterDataSourceLabel(lang, src string) string {
	switch src {
	case clusterSourceLiveAgent:
		return tr(lang, "Agent 主机实测", "Live Agent Telemetry")
	case clusterSourceManualProbe:
		return tr(lang, "只读探针快照", "Read-Only Probe Snapshot")
	case clusterSourceAppliedBaseline:
		return tr(lang, "交付快照 + 已落地变更", "Spec + Applied Changes")
	default:
		return tr(lang, "静态交付快照", "Static Delivery Spec")
	}
}

func normClusterParamKey(k string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(k), "-", "_"))
}

func stringifyParamVal(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	default:
		return strings.TrimSpace(fmt.Sprintf("%v", v))
	}
}

func equivParamValues(a, b string) bool {
	sa := strings.ToLower(strings.Trim(strings.TrimSpace(a), `"'`))
	sb := strings.ToLower(strings.Trim(strings.TrimSpace(b), `"'`))
	if sa == sb {
		return true
	}
	truthy := map[string]bool{"on": true, "true": true, "yes": true, "1": true, "enabled": true}
	falsy := map[string]bool{"off": true, "false": true, "no": true, "0": true, "disabled": true}
	if truthy[sa] && truthy[sb] {
		return true
	}
	if falsy[sa] && falsy[sb] {
		return true
	}
	// Compare memory units like 128MB vs 131072kB or 1GB vs 1024MB
	if ba, okA := parseByteUnits(sa); okA {
		if bb, okB := parseByteUnits(sb); okB && ba == bb {
			return true
		}
	}
	return false
}

func parseByteUnits(s string) (int64, bool) {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" {
		return 0, false
	}
	mult := int64(1)
	numPart := s
	for _, suf := range []struct {
		u string
		m int64
	}{
		{"tb", 1 << 40}, {"t", 1 << 40},
		{"gb", 1 << 30}, {"g", 1 << 30},
		{"mb", 1 << 20}, {"m", 1 << 20},
		{"kb", 1 << 10}, {"k", 1 << 10},
		{"b", 1},
	} {
		if strings.HasSuffix(s, suf.u) {
			mult = suf.m
			numPart = strings.TrimSpace(strings.TrimSuffix(s, suf.u))
			break
		}
	}
	var n int64
	if _, err := fmt.Sscanf(numPart, "%d", &n); err != nil {
		var rest string
		if c, _ := fmt.Sscanf(numPart, "%d%s", &n, &rest); c != 1 {
			return 0, false
		}
	}
	if mult == 1 && numPart == s {
		return n, true
	}
	return n * mult, true
}

func (s *storeServer) loadClusterStateRecord(clusterID string) clusterStateRecord {
	rec := clusterStateRecord{
		ClusterID:   clusterID,
		ProbePolicy: defaultClusterProbePolicy(),
		DataSource:  clusterSourceStaticSpec,
	}
	if strings.TrimSpace(clusterID) == "" {
		return rec
	}
	if s.repo != nil {
		ov, ls, dr, pp, ds, lp, ok, err := s.repo.getClusterStateRow(clusterID)
		if err == nil && ok {
			_ = json.Unmarshal(ov, &rec.Overrides)
			if len(ls) > 0 {
				var snap clusterLiveSnapshot
				if json.Unmarshal(ls, &snap) == nil && snap.CollectedAt != "" {
					rec.Live = &snap
				}
			}
			if len(dr) > 0 {
				var rep clusterDriftReport
				if json.Unmarshal(dr, &rep) == nil {
					rec.Drift = &rep
				}
			}
			if len(pp) > 0 {
				_ = json.Unmarshal(pp, &rec.ProbePolicy)
			}
			rec.ProbePolicy = normalizeClusterProbePolicy(rec.ProbePolicy)
			if ds != "" {
				rec.DataSource = ds
			}
			rec.LastProbedAt = lp
			return rec
		}
		return rec
	}
	s.clusterStateMu.Lock()
	defer s.clusterStateMu.Unlock()
	if s.memClusterState != nil {
		if hit, ok := s.memClusterState[clusterID]; ok {
			hit.ProbePolicy = normalizeClusterProbePolicy(hit.ProbePolicy)
			return hit
		}
	}
	return rec
}

func (s *storeServer) saveClusterStateRecord(rec clusterStateRecord) error {
	if strings.TrimSpace(rec.ClusterID) == "" {
		return nil
	}
	rec.ProbePolicy = normalizeClusterProbePolicy(rec.ProbePolicy)
	if rec.Live != nil && rec.Live.CollectedAt != "" {
		if rec.Live.Source == clusterSourceManualProbe {
			rec.DataSource = clusterSourceManualProbe
		} else {
			rec.DataSource = clusterSourceLiveAgent
		}
		rec.LastProbedAt = rec.Live.CollectedAt
	} else if len(rec.Overrides.Params) > 0 || len(rec.Overrides.Entries) > 0 {
		rec.DataSource = clusterSourceAppliedBaseline
	} else {
		rec.DataSource = clusterSourceStaticSpec
	}

	if s.repo != nil {
		ov, _ := json.Marshal(rec.Overrides)
		var ls, dr []byte
		if rec.Live != nil {
			ls, _ = json.Marshal(rec.Live)
		}
		if rec.Drift != nil {
			dr, _ = json.Marshal(rec.Drift)
		}
		pp, _ := json.Marshal(rec.ProbePolicy)
		return s.repo.saveClusterStateRow(rec.ClusterID, ov, ls, dr, pp, rec.DataSource, rec.LastProbedAt)
	}
	s.clusterStateMu.Lock()
	defer s.clusterStateMu.Unlock()
	if s.memClusterState == nil {
		s.memClusterState = map[string]clusterStateRecord{}
	}
	s.memClusterState[rec.ClusterID] = rec
	return nil
}

// syncAppliedRehearsalsToClusterState folds all production-applied rehearsals of a cluster into
// Layer-2 baseline_overrides so both platform-delivered and imported clusters reflect confirmed changes
// in Config, Overview, and Security Baseline Audit even in pure air-gapped environments without Agents.
func (s *storeServer) syncAppliedRehearsalsToClusterState(clusterID, by string) {
	if strings.TrimSpace(clusterID) == "" {
		return
	}
	applied := s.listAppliedRehearsals(clusterID)
	rec := s.loadClusterStateRecord(clusterID)
	params := map[string]string{}
	entries := []clusterOverrideEntry{}
	seenOrder := []string{}
	byNorm := map[string]clusterOverrideEntry{}
	for _, rh := range applied {
		chs := rh.AppliedChanges
		if len(chs) == 0 {
			_, chs = extractDefaultAppliedChanges(rh)
		}
		for _, ch := range chs {
			k := strings.TrimSpace(ch.Key)
			after := strings.TrimSpace(ch.After)
			if k == "" || after == "" {
				continue
			}
			nk := normClusterParamKey(k)
			if _, exists := byNorm[nk]; !exists {
				seenOrder = append(seenOrder, nk)
			}
			params[nk] = after
			byNorm[nk] = clusterOverrideEntry{
				Key:         k,
				Before:      ch.Before,
				After:       after,
				SourceID:    rh.ID,
				SourceTitle: rh.Title,
				By:          firstNonEmptyStr(rh.AppliedBy, rh.Owner, by),
				At:          firstNonEmptyStr(rh.AppliedAt, rh.UpdatedAt),
			}
		}
	}
	for _, nk := range seenOrder {
		entries = append(entries, byNorm[nk])
	}
	// Preserve manual baseline calibrations & accepted live drift entries unless superseded by a rehearsal
	for _, prev := range rec.Overrides.Entries {
		if prev.SourceID != "manual_calibration" && prev.SourceID != "drift_accept" {
			continue
		}
		nk := normClusterParamKey(prev.Key)
		if nk == "" || params[nk] != "" {
			continue
		}
		params[nk] = prev.After
		entries = append(entries, prev)
	}
	rec.Overrides.Params = params
	rec.Overrides.Entries = entries
	rec.Overrides.UpdatedAt = nowStamp()
	rec.Overrides.UpdatedBy = by
	if f, ok := s.clusterFactsAny(clusterID); ok && rec.Live != nil {
		d := s.computeClusterDrift(f, rec.Overrides, *rec.Live)
		rec.Drift = &d
	}
	_ = s.saveClusterStateRecord(rec)
}

func upsertOverrideEntry(list []clusterOverrideEntry, entry clusterOverrideEntry) []clusterOverrideEntry {
	nk := normClusterParamKey(entry.Key)
	out := make([]clusterOverrideEntry, 0, len(list)+1)
	replaced := false
	for _, item := range list {
		if normClusterParamKey(item.Key) == nk {
			out = append(out, entry)
			replaced = true
		} else {
			out = append(out, item)
		}
	}
	if !replaced {
		out = append(out, entry)
	}
	return out
}

func (s *storeServer) clusterFactsAny(clusterID string) (clusterFacts, bool) {
	s.mu.Lock()
	all := s.clusterOf(clusterID)
	s.mu.Unlock()
	f := clusterFacts{ID: clusterID}
	for _, j := range all {
		if j.State == "succeeded" {
			f.Jobs = append(f.Jobs, j)
		}
	}
	if len(f.Jobs) == 0 {
		return f, false
	}
	cur, ok := clusterCurrent(all)
	if !ok {
		cur = f.Jobs[len(f.Jobs)-1]
	}
	f.Current = cur
	f.Plan = s.solvedJob(cur.ID)
	return f, true
}

func (s *storeServer) clusterAgentAvailability(clusterID string) (bound bool, online bool, preferredName string) {
	executionMu.Lock()
	d, err := s.readExecutions()
	executionMu.Unlock()
	if err != nil {
		return false, false, ""
	}
	for _, n := range d.Nodes {
		if n.Disabled {
			continue
		}
		if nodeClusterMode(n, clusterID) != "" {
			bound = true
			if executionOnline(n) {
				online = true
				if preferredName == "" {
					preferredName = n.Name
				}
			} else if preferredName == "" {
				preferredName = n.Name
			}
		}
	}
	for _, a := range d.Agents {
		if a.Mode != "direct" || a.Desired != "active" || a.Disabled {
			continue
		}
		if targetAgentAllowsCluster(a, clusterID) {
			bound = true
			if targetAgentOnline(a) {
				online = true
				if preferredName == "" {
					preferredName = a.Host
				}
			} else if preferredName == "" {
				preferredName = a.Host
			}
		}
	}
	return bound, online, preferredName
}

func (s *storeServer) activeLiveInspectTaskID(clusterID string) string {
	for _, t := range s.listRehearsalExecTasks(clusterID, "", 15) {
		if t.Kind == "live_inspect" && rehearsalTaskActive(t.State) {
			return t.ID
		}
	}
	return ""
}

// mergeLiveSnapshotNonDestructive merges newly collected per-host telemetry into any prior live snapshot
// without deleting unprobed hosts, unprobed parameter keys, previously detected companions, or packages on other hosts.
func mergeLiveSnapshotNonDestructive(prev *clusterLiveSnapshot, incoming clusterLiveSnapshot, totalClusterHosts int) clusterLiveSnapshot {
	out := incoming
	if out.Hosts == nil {
		out.Hosts = map[string]clusterHostLive{}
	}
	if out.MergedParams == nil {
		out.MergedParams = map[string]string{}
	}

	if prev != nil {
		// 1. Preserve previous hosts that were not part of this partial probe run
		for hk, hv := range prev.Hosts {
			if _, updated := out.Hosts[hk]; !updated {
				out.Hosts[hk] = hv
			}
		}
		// 2. Preserve previously measured params for keys not returned in this run
		for pk, pv := range prev.MergedParams {
			if _, updated := out.MergedParams[pk]; !updated {
				out.MergedParams[pk] = pv
			}
		}
		if out.ExactVersion == "" {
			out.ExactVersion = prev.ExactVersion
		}
		out.ServiceUnits = mergeUniqueStrings(prev.ServiceUnits, out.ServiceUnits)
		out.ConfigPaths = mergeUniqueStrings(prev.ConfigPaths, out.ConfigPaths)
		out.DataDirs = mergeUniqueStrings(prev.DataDirs, out.DataDirs)
		out.LogDirs = mergeUniqueStrings(prev.LogDirs, out.LogDirs)
		out.Companions = mergeCompanionsNonDestructive(prev.Companions, out.Companions)
		if len(out.Packages) == 0 && len(prev.Packages) > 0 {
			out.Packages = append([]mwpack.ImportedPkg(nil), prev.Packages...)
		} else if len(prev.Packages) > 0 && len(out.Packages) > 0 {
			out.Packages = mergePackagesNonDestructive(prev.Packages, out.Packages)
		}
		if len(out.Certs) == 0 && len(prev.Certs) > 0 {
			out.Certs = append([]secCertCheck(nil), prev.Certs...)
		}
	}

	// Fold host-level params, CIDRs, certs, packages, paths & companions across all known live hosts
	cidrSeen := map[string]bool{}
	var cidrs []string
	for _, c := range out.ClientCIDRs {
		if c != "" && !cidrSeen[c] {
			cidrSeen[c] = true
			cidrs = append(cidrs, c)
		}
	}
	var allCerts []secCertCheck
	certSeen := map[string]bool{}
	for _, ct := range out.Certs {
		ck := ct.Instance + "|" + ct.Bundle + "|" + ct.Subject + "|" + ct.NotAfter
		if !certSeen[ck] {
			certSeen[ck] = true
			allCerts = append(allCerts, ct)
		}
	}

	probedCount := 0
	for _, hl := range out.Hosts {
		if hl.Online {
			probedCount++
		}
		if out.ExactVersion == "" && hl.ExactVersion != "" {
			out.ExactVersion = hl.ExactVersion
		}
		// Prefer primary/leader host's param value when merging cluster-wide params, otherwise fill in
		isPrimary := hl.Role == "primary" || hl.Role == "leader" || hl.Role == "master" || hl.Role == "active"
		for k, v := range hl.Params {
			nk := normClusterParamKey(k)
			if nk == "" || v == "" {
				continue
			}
			if isPrimary || out.MergedParams[nk] == "" {
				out.MergedParams[nk] = v
			}
		}
		for _, c := range hl.ClientCIDRs {
			if c != "" && !cidrSeen[c] {
				cidrSeen[c] = true
				cidrs = append(cidrs, c)
			}
		}
		for _, ct := range hl.Certs {
			ck := ct.Instance + "|" + ct.Bundle + "|" + ct.Subject + "|" + ct.NotAfter
			if !certSeen[ck] {
				certSeen[ck] = true
				allCerts = append(allCerts, ct)
			}
		}
		out.ServiceUnits = mergeUniqueStrings(out.ServiceUnits, hl.ServiceUnits)
		out.ConfigPaths = mergeUniqueStrings(out.ConfigPaths, hl.ConfigPaths)
		out.DataDirs = mergeUniqueStrings(out.DataDirs, hl.DataDirs)
		out.LogDirs = mergeUniqueStrings(out.LogDirs, hl.LogDirs)
		out.Companions = mergeCompanionsNonDestructive(out.Companions, hl.Companions)
		out.Packages = mergePackagesNonDestructive(out.Packages, hl.Packages)
	}
	out.ClientCIDRs = cidrs
	out.Certs = allCerts
	if probedCount > out.ProbedHosts {
		out.ProbedHosts = probedCount
	}
	if totalClusterHosts > 0 {
		out.TotalHosts = totalClusterHosts
	}
	return out
}

func mergeUniqueStrings(base, extra []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, list := range [][]string{base, extra} {
		for _, raw := range list {
			s := strings.TrimSpace(raw)
			if s == "" {
				continue
			}
			lk := strings.ToLower(s)
			if seen[lk] {
				continue
			}
			seen[lk] = true
			out = append(out, s)
		}
	}
	return out
}

func mergeCompanionsNonDestructive(base, incoming []mwpack.ImportedCompanion) []mwpack.ImportedCompanion {
	if len(incoming) == 0 {
		return base
	}
	out := make([]mwpack.ImportedCompanion, len(base))
	copy(out, base)
	idxByComp := map[string]int{}
	for i, c := range out {
		k := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(c.Component), "_", "-"))
		if k != "" {
			idxByComp[k] = i
		}
	}
	for _, inc := range incoming {
		k := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(inc.Component), "_", "-"))
		if k == "" {
			continue
		}
		if idx, exists := idxByComp[k]; exists {
			cur := out[idx]
			if inc.Version != "" {
				cur.Version = inc.Version
			}
			if inc.DisplayName != "" && cur.DisplayName == "" {
				cur.DisplayName = inc.DisplayName
			}
			if inc.Kind != "" && cur.Kind == "" {
				cur.Kind = inc.Kind
			}
			cur.ServiceUnits = mergeUniqueStrings(cur.ServiceUnits, inc.ServiceUnits)
			cur.ConfigPaths = mergeUniqueStrings(cur.ConfigPaths, inc.ConfigPaths)
			if len(inc.Ports) > 0 {
				pseen := map[int]bool{}
				for _, p := range cur.Ports {
					pseen[p] = true
				}
				for _, p := range inc.Ports {
					if p > 0 && !pseen[p] {
						pseen[p] = true
						cur.Ports = append(cur.Ports, p)
					}
				}
			}
			out[idx] = cur
		} else {
			idxByComp[k] = len(out)
			out = append(out, inc)
		}
	}
	return out
}

func mergePackagesNonDestructive(base, incoming []mwpack.ImportedPkg) []mwpack.ImportedPkg {
	if len(incoming) == 0 {
		return base
	}
	out := make([]mwpack.ImportedPkg, len(base))
	copy(out, base)
	idxByName := map[string]int{}
	for i, p := range out {
		ln := strings.ToLower(strings.TrimSpace(p.Name))
		if ln != "" {
			idxByName[ln] = i
		}
	}
	for _, inc := range incoming {
		ln := strings.ToLower(strings.TrimSpace(inc.Name))
		if ln == "" || strings.TrimSpace(inc.Version) == "" {
			continue
		}
		if idx, exists := idxByName[ln]; exists {
			out[idx].Version = inc.Version
			if inc.Role != "" {
				out[idx].Role = inc.Role
			}
		} else {
			idxByName[ln] = len(out)
			out = append(out, inc)
		}
	}
	return out
}

// computeClusterDrift compares Layer-3 Live Machine Snapshot against Layer-1/2 Expected Baseline.
func (s *storeServer) computeClusterDrift(f clusterFacts, overrides clusterBaselineOverrides, live clusterLiveSnapshot) clusterDriftReport {
	rep := clusterDriftReport{
		ParamDrifts: []clusterParamDrift{},
		RoleDrifts:  []clusterRoleDrift{},
		ComputedAt:  nowStamp(),
	}
	dep := s.readSpec(f.Current.ID)
	expectedOrigin := "deployment.yml"
	if dep != nil && dep.DeliveryMode == "imported" {
		expectedOrigin = "imported_baseline"
	}

	// 1. Collect expected baseline params across non-external instances
	type expectedParam struct {
		rawKey   string
		instID   string
		val      string
		origin   string
	}
	expected := map[string]expectedParam{}
	if f.Plan != nil {
		for _, inst := range f.Plan.Instances {
			if inst.External {
				continue
			}
			for k, v := range inst.Params {
				nk := normClusterParamKey(k)
				sv := stringifyParamVal(v)
				if nk != "" && sv != "" {
					expected[nk] = expectedParam{rawKey: k, instID: inst.ID, val: sv, origin: expectedOrigin}
				}
			}
		}
	}
	if len(expected) == 0 && dep != nil {
		for _, inst := range dep.Instances {
			for k, v := range inst.Params {
				nk := normClusterParamKey(k)
				sv := stringifyParamVal(v)
				if nk != "" && sv != "" {
					expected[nk] = expectedParam{rawKey: k, instID: inst.ID, val: sv, origin: expectedOrigin}
				}
			}
		}
	}
	for nk, ov := range overrides.Params {
		if ov == "" {
			continue
		}
		cur := expected[nk]
		if cur.rawKey == "" {
			cur.rawKey = nk
		}
		cur.val = ov
		cur.origin = "applied_rehearsal"
		expected[nk] = cur
	}

	for nk, actual := range live.MergedParams {
		exp, exists := expected[nk]
		if !exists || exp.val == "" || actual == "" {
			continue
		}
		if !equivParamValues(exp.val, actual) {
			rep.ParamDrifts = append(rep.ParamDrifts, clusterParamDrift{
				Key:          exp.rawKey,
				Instance:     exp.instID,
				Expected:     exp.val,
				Actual:       actual,
				ExpectedFrom: exp.origin,
				MeasuredAt:   live.CollectedAt,
			})
		}
	}
	sort.Slice(rep.ParamDrifts, func(i, j int) bool { return rep.ParamDrifts[i].Key < rep.ParamDrifts[j].Key })

	// 2. Role drift & stopped services check
	expectedRoleByHost := map[string]string{}
	ipByHost := map[string]string{}
	if dep != nil {
		for _, h := range dep.Hosts {
			ipByHost[h.Name] = h.IP
		}
		for _, inst := range dep.Instances {
			if inst.Component != f.Current.AppID && len(dep.Instances) > 1 {
				continue
			}
			for roleKey, hs := range inst.Placement {
				for _, hn := range hs {
					expectedRoleByHost[hn] = roleKey
				}
			}
		}
	}
	canonRole := func(r string) string {
		switch strings.ToLower(strings.TrimSpace(r)) {
		case "primary", "leader", "master", "active":
			return "primary"
		case "replica", "follower", "slave", "standby", "sync_standby", "backup":
			return "replica"
		default:
			return strings.ToLower(strings.TrimSpace(r))
		}
	}
	stoppedSeen := map[string]bool{}
	for _, hl := range live.Hosts {
		for _, sv := range hl.Services {
			if !sv.Healthy && (sv.ActiveState == "failed" || sv.ActiveState == "inactive") {
				lbl := fmt.Sprintf("%s (%s): %s=%s", firstNonEmptyStr(hl.Host, hl.IP), hl.IP, sv.Unit, sv.ActiveState)
				if !stoppedSeen[lbl] {
					stoppedSeen[lbl] = true
					rep.StoppedServices = append(rep.StoppedServices, lbl)
				}
			}
		}
		if hl.Role == "" {
			continue
		}
		expRole := expectedRoleByHost[hl.Host]
		if expRole == "" {
			for hn, hip := range ipByHost {
				if hip != "" && hip == hl.IP {
					expRole = expectedRoleByHost[hn]
					break
				}
			}
		}
		if expRole != "" && canonRole(expRole) != "" && canonRole(hl.Role) != "" && canonRole(expRole) != canonRole(hl.Role) {
			if canonRole(expRole) == "primary" || canonRole(expRole) == "replica" {
				rep.RoleDrifts = append(rep.RoleDrifts, clusterRoleDrift{
					Host:         hl.Host,
					IP:           hl.IP,
					ExpectedRole: expRole,
					ActualRole:   hl.Role,
				})
			}
		}
	}
	sort.Slice(rep.RoleDrifts, func(i, j int) bool { return rep.RoleDrifts[i].Host < rep.RoleDrifts[j].Host })
	sort.Strings(rep.StoppedServices)
	rep.HasDrift = len(rep.ParamDrifts) > 0 || len(rep.RoleDrifts) > 0 || len(rep.StoppedServices) > 0
	return rep
}

// syncLiveIntoImportedBaseline non-destructively enriches an Imported Cluster's baseline with newly
// measured values from live inspection WITHOUT deleting user-entered endpoints, notes, hosts, or unprobed keys.
func (s *storeServer) syncLiveIntoImportedBaseline(f clusterFacts, snap clusterLiveSnapshot, by string) {
	if f.Current.ID == "" {
		return
	}
	dep := s.readSpec(f.Current.ID)
	if dep == nil || dep.DeliveryMode != "imported" {
		return
	}
	s.jobPersistMu.Lock()
	defer s.jobPersistMu.Unlock()

	dep = s.readSpec(f.Current.ID)
	if dep == nil || dep.DeliveryMode != "imported" {
		return
	}
	if dep.Imported == nil {
		dep.Imported = &mwpack.ImportedMeta{}
	}
	meta := dep.Imported
	now := nowStamp()

	if snap.ExactVersion != "" {
		meta.ExactVersion = snap.ExactVersion
	}
	for _, hl := range snap.Hosts {
		if hl.OSDetail != "" {
			meta.OSDetail = hl.OSDetail
			break
		}
	}
	meta.ServiceUnits = mergeUniqueStrings(meta.ServiceUnits, snap.ServiceUnits)
	meta.ConfigPaths = mergeUniqueStrings(meta.ConfigPaths, snap.ConfigPaths)
	meta.DataDirs = mergeUniqueStrings(meta.DataDirs, snap.DataDirs)
	meta.LogDirs = mergeUniqueStrings(meta.LogDirs, snap.LogDirs)
	meta.Companions = mergeCompanionsNonDestructive(meta.Companions, snap.Companions)
	meta.Packages = mergePackagesNonDestructive(meta.Packages, snap.Packages)
	meta.LastProbedAt = snap.CollectedAt
	meta.BaselineUpdatedAt = now
	meta.BaselineUpdatedBy = firstNonEmptyStr(by, "agent")

	// Non-destructively update primary instance params & host roles (preserving unprobed hosts & keys)
	if len(dep.Instances) > 0 {
		if dep.Instances[0].Params == nil {
			dep.Instances[0].Params = map[string]any{}
		}
		existingNorm := map[string]string{}
		for k := range dep.Instances[0].Params {
			existingNorm[normClusterParamKey(k)] = k
		}
		for nk, val := range snap.MergedParams {
			if nk == "" || val == "" {
				continue
			}
			if origKey, has := existingNorm[nk]; has {
				dep.Instances[0].Params[origKey] = val
			} else {
				dep.Instances[0].Params[nk] = val
			}
		}
		// Update host role placement only for hosts that reported a concrete primary/replica role
		curRoleByHost := map[string]string{}
		for rk, hs := range dep.Instances[0].Placement {
			for _, hn := range hs {
				curRoleByHost[hn] = rk
			}
		}
		roleUpdated := false
		for _, h := range dep.Hosts {
			hl, ok := snap.Hosts[h.IP]
			if !ok {
				hl, ok = snap.Hosts[h.Name]
			}
			if ok && (hl.Role == "primary" || hl.Role == "replica") {
				if curRoleByHost[h.Name] != hl.Role {
					curRoleByHost[h.Name] = hl.Role
					roleUpdated = true
				}
			}
		}
		if roleUpdated {
			newPlacement := map[string][]string{}
			for _, h := range dep.Hosts {
				rk := firstNonEmptyStr(curRoleByHost[h.Name], "node")
				newPlacement[rk] = append(newPlacement[rk], h.Name)
			}
			dep.Instances[0].Placement = newPlacement
		}
	}

	plan := mwpack.SolveImported(s.plat.cat(), dep)
	if err := s.saveImportedPlanFiles(f.Current.ID, dep, plan); err != nil {
		return
	}
	s.invalidateJobCaches(f.Current.ID)
	s.mu.Lock()
	if j, exists := s.jobs[f.Current.ID]; exists {
		j.Scheme = mwpack.ImportedSchemeSummary(dep)
		j.Updated = now
		s.jobs[j.ID] = j
		s.mu.Unlock()
		_ = s.persistJob(j)
	} else {
		s.mu.Unlock()
	}
}

func (s *storeServer) buildClusterLiveSummary(clusterID, lang string, totalHosts int) clusterLiveSummary {
	rec := s.loadClusterStateRecord(clusterID)
	if rec.DataSource == clusterSourceStaticSpec {
		if applied := s.listAppliedRehearsals(clusterID); len(applied) > 0 {
			rec.DataSource = clusterSourceAppliedBaseline
		}
	}
	bound, online, agentName := s.clusterAgentAvailability(clusterID)
	sum := clusterLiveSummary{
		DataSource:          rec.DataSource,
		DataSourceLabel:     clusterDataSourceLabel(lang, rec.DataSource),
		HasBoundAgent:       bound,
		HasOnlineAgent:      online,
		LastProbedAt:        rec.LastProbedAt,
		TotalHosts:          totalHosts,
		AgentName:           agentName,
		ActiveInspectTaskID: s.activeLiveInspectTaskID(clusterID),
		ProbePolicy:         rec.ProbePolicy,
	}
	if rec.Live != nil {
		sum.ProbedHosts = rec.Live.ProbedHosts
		if rec.Live.TotalHosts > 0 && sum.TotalHosts == 0 {
			sum.TotalHosts = rec.Live.TotalHosts
		}
		if rec.Live.AgentName != "" {
			sum.AgentName = rec.Live.AgentName
		}
	}
	if rec.Drift != nil {
		sum.DriftCount = len(rec.Drift.ParamDrifts)
		sum.RoleDriftCount = len(rec.Drift.RoleDrifts)
		sum.StoppedServiceCount = len(rec.Drift.StoppedServices)
	}
	return sum
}

func (s *storeServer) buildClusterEffectiveView(f clusterFacts, lang string) clusterEffectiveView {
	rec := s.loadClusterStateRecord(f.ID)
	// Ensure Layer-2 overrides stay synchronized with applied rehearsals
	if len(rec.Overrides.Params) == 0 {
		if applied := s.listAppliedRehearsals(f.ID); len(applied) > 0 {
			s.syncAppliedRehearsalsToClusterState(f.ID, "")
			rec = s.loadClusterStateRecord(f.ID)
		}
	}
	dep := s.readSpec(f.Current.ID)
	totalHosts := 0
	if dep != nil {
		totalHosts = len(dep.Hosts)
	} else if f.Plan != nil {
		totalHosts = len(f.Plan.Hosts)
	}
	effParams := map[string]any{}
	paramSources := map[string]string{}
	effRoles := map[string]string{}
	hostLiveness := map[string]bool{}

	if f.Plan != nil {
		for _, inst := range f.Plan.Instances {
			if inst.External {
				continue
			}
			for k, v := range inst.Params {
				effParams[k] = v
				paramSources[normClusterParamKey(k)] = clusterSourceStaticSpec
			}
		}
	} else if dep != nil {
		for _, inst := range dep.Instances {
			for k, v := range inst.Params {
				effParams[k] = v
				paramSources[normClusterParamKey(k)] = clusterSourceStaticSpec
			}
		}
	}
	if dep != nil {
		for _, inst := range dep.Instances {
			if inst.Component != f.Current.AppID && len(dep.Instances) > 1 {
				continue
			}
			for rk, hs := range inst.Placement {
				for _, hn := range hs {
					effRoles[hn] = rk
				}
			}
		}
	}

	keyLookup := map[string]string{}
	for k := range effParams {
		keyLookup[normClusterParamKey(k)] = k
	}
	for nk, ov := range rec.Overrides.Params {
		targetKey := firstNonEmptyStr(keyLookup[nk], nk)
		keyLookup[nk] = targetKey
		effParams[targetKey] = ov
		paramSources[nk] = clusterSourceAppliedBaseline
	}
	if rec.Live != nil {
		src := rec.Live.Source
		if src == "" {
			src = clusterSourceLiveAgent
		}
		for nk, lv := range rec.Live.MergedParams {
			targetKey := firstNonEmptyStr(keyLookup[nk], nk)
			keyLookup[nk] = targetKey
			effParams[targetKey] = lv
			paramSources[nk] = src
		}
		if dep != nil {
			for _, h := range dep.Hosts {
				hl, ok := rec.Live.Hosts[h.IP]
				if !ok {
					hl, ok = rec.Live.Hosts[h.Name]
				}
				if ok {
					hostLiveness[h.Name] = hl.Online
					if hl.Role != "" {
						effRoles[h.Name] = hl.Role
					}
				}
			}
		}
		d := s.computeClusterDrift(f, rec.Overrides, *rec.Live)
		rec.Drift = &d
	}

	return clusterEffectiveView{
		ClusterID:       f.ID,
		Summary:         s.buildClusterLiveSummary(f.ID, lang, totalHosts),
		Overrides:       rec.Overrides,
		Live:            rec.Live,
		Drift:           rec.Drift,
		EffectiveParams: effParams,
		ParamSources:    paramSources,
		EffectiveRoles:  effRoles,
		HostLiveness:    hostLiveness,
	}
}

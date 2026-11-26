package server

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"runtime"
	"sort"
	"strings"
	"time"
)

// Unified Agent model:
// Consolidates management/jumpbox Execution Nodes and local Direct Target Agents into a single
// user-facing "Agent" abstraction with two simple controls:
//   1. Global enable / disable (`disabled: bool`)
//   2. Per-cluster authorization (`cluster_modes: map[clusterID]("readonly" | "readwrite")`)
// When an Agent runs on a target host itself (`localExecutionIP`), tasks execute locally without SSH;
// when an Agent runs on a jumpbox/management host, tasks execute over SSH or Ansible.

type unifiedAgentView struct {
	ID                string                 `json:"id"`
	Backing           string                 `json:"backing"` // "node" | "direct"
	Name              string                 `json:"name"`
	IP                string                 `json:"ip"`
	Online            bool                   `json:"online"`
	Disabled          bool                   `json:"disabled"`
	Revoked           bool                   `json:"revoked,omitempty"`
	LastSeen          string                 `json:"last_seen,omitempty"`
	Version           string                 `json:"version,omitempty"`
	Protocol          int                    `json:"protocol,omitempty"`
	SupportsExec      bool                   `json:"supports_exec"`
	ClusterModes      map[string]string      `json:"cluster_modes"`
	Clusters          []string               `json:"clusters"`
	SuggestedClusters     []string               `json:"suggested_clusters,omitempty"`
	HeartbeatIntervalSec  int                    `json:"heartbeat_interval_sec,omitempty"`
	EffectiveHeartbeatSec int                    `json:"effective_heartbeat_sec"`
	Probe                 *agentHostProbe        `json:"probe,omitempty"`
	Heartbeats            []agentHeartbeatSample `json:"heartbeats,omitempty"`
	ServiceName           string                 `json:"service_name,omitempty"`
}

func normalizeAgentClusterMode(raw string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "readonly", "ro", "view":
		return "readonly", true
	case "readwrite", "rw", "operate", "bound", "true", "1":
		return "readwrite", true
	default:
		return "", false
	}
}

func cleanAgentClusterModes(in map[string]string) (map[string]string, bool) {
	if len(in) == 0 {
		return nil, true
	}
	out := make(map[string]string, len(in))
	for rawCID, rawMode := range in {
		cid := strings.TrimSpace(rawCID)
		if cid == "" || len(cid) > 120 || !docClusterID.MatchString(cid) {
			return nil, false
		}
		trimmed := strings.TrimSpace(rawMode)
		if trimmed == "" || strings.EqualFold(trimmed, "disabled") || strings.EqualFold(trimmed, "none") || strings.EqualFold(trimmed, "false") {
			continue
		}
		m, ok := normalizeAgentClusterMode(trimmed)
		if !ok {
			return nil, false
		}
		out[cid] = m
	}
	if len(out) == 0 {
		return nil, true
	}
	return out, true
}

func sortedMapKeys(m map[string]string) []string {
	if len(m) == 0 {
		return []string{}
	}
	out := make([]string, 0, len(m))
	for k := range m {
		if strings.TrimSpace(k) != "" {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func effectiveNodeClusterModes(n executionNode) map[string]string {
	out := map[string]string{}
	for cid, raw := range n.ClusterModes {
		if m, ok := normalizeAgentClusterMode(raw); ok && strings.TrimSpace(cid) != "" {
			out[strings.TrimSpace(cid)] = m
		}
	}
	for _, cid := range n.Clusters {
		cid = strings.TrimSpace(cid)
		if cid != "" && out[cid] == "" {
			out[cid] = "readwrite"
		}
	}
	for cid := range n.Grants {
		cid = strings.TrimSpace(cid)
		if cid != "" && out[cid] == "" {
			out[cid] = "readwrite"
		}
	}
	return out
}

func nodeClusterMode(n executionNode, clusterID string) string {
	cid := strings.TrimSpace(clusterID)
	if cid == "" {
		return ""
	}
	return effectiveNodeClusterModes(n)[cid]
}

func applyNodeClusterModes(n *executionNode, modes map[string]string) {
	if len(modes) == 0 {
		n.ClusterModes = nil
		n.Clusters = []string{}
		n.Grants = nil
		return
	}
	cp := make(map[string]string, len(modes))
	hasRW := false
	for k, v := range modes {
		if m, ok := normalizeAgentClusterMode(v); ok && strings.TrimSpace(k) != "" {
			cp[strings.TrimSpace(k)] = m
			if m == "readwrite" {
				hasRW = true
			}
		}
	}
	if len(cp) == 0 {
		n.ClusterModes = nil
		n.Clusters = []string{}
		n.Grants = nil
		return
	}
	n.ClusterModes = cp
	n.Clusters = sortedMapKeys(cp)
	if len(n.Grants) > 0 {
		for cid := range n.Grants {
			if cp[strings.TrimSpace(cid)] == "" {
				delete(n.Grants, cid)
			}
		}
		if len(n.Grants) == 0 {
			n.Grants = nil
		}
	}
	t := true
	n.AllowProbe = &t
	if hasRW {
		t1, t2 := true, true
		n.AllowRehearsal = &t1
		n.AllowDelivery = &t2
	}
}

func effectiveTargetAgentClusterModes(a targetAgent) map[string]string {
	out := map[string]string{}
	for cid, raw := range a.ClusterModes {
		if m, ok := normalizeAgentClusterMode(raw); ok && strings.TrimSpace(cid) != "" {
			out[strings.TrimSpace(cid)] = m
		}
	}
	for _, cid := range targetAgentClusters(a) {
		cid = strings.TrimSpace(cid)
		if cid != "" && out[cid] == "" {
			out[cid] = "readwrite"
		}
	}
	return out
}

func targetAgentClusterMode(a targetAgent, clusterID string) string {
	cid := strings.TrimSpace(clusterID)
	if cid == "" {
		return ""
	}
	return effectiveTargetAgentClusterModes(a)[cid]
}

func applyTargetAgentClusterModes(a *targetAgent, modes map[string]string) {
	a.Cluster = ""
	if len(modes) == 0 {
		a.ClusterModes = nil
		a.Clusters = nil
		return
	}
	cp := make(map[string]string, len(modes))
	hasRW := false
	for k, v := range modes {
		if m, ok := normalizeAgentClusterMode(v); ok && strings.TrimSpace(k) != "" {
			cp[strings.TrimSpace(k)] = m
			if m == "readwrite" {
				hasRW = true
			}
		}
	}
	a.ClusterModes = cp
	a.Clusters = sortedMapKeys(cp)
	a.AllowMutating = hasRW
}

func filterVisibleAgentModes(
	modes map[string]string,
	canManageGlobal bool,
	owners map[string]string,
	access func(owner, clusterID string) string,
) map[string]string {
	out := map[string]string{}
	for cid, m := range modes {
		if _, exists := owners[cid]; !exists && !canManageGlobal {
			continue
		}
		if canManageGlobal || access(owners[cid], cid) != "" {
			out[cid] = m
		}
	}
	return out
}

func buildUnifiedAgentFromNode(
	n executionNode,
	canManageGlobal bool,
	owners map[string]string,
	access func(owner, clusterID string) string,
	ipClusters map[string][]string,
) unifiedAgentView {
	modes := filterVisibleAgentModes(effectiveNodeClusterModes(n), canManageGlobal, owners, access)
	supportsExec := n.Protocol == 0 || n.Protocol >= 3
	return unifiedAgentView{
		ID:                n.ID,
		Backing:           "node",
		Name:              n.Name,
		IP:                n.ControllerIP,
		Online:            executionOnline(n),
		Disabled:          n.Disabled,
		LastSeen:          n.LastSeen,
		Version:           n.Version,
		Protocol:          n.Protocol,
		SupportsExec:      supportsExec,
		ClusterModes:          modes,
		Clusters:              sortedMapKeys(modes),
		SuggestedClusters:     suggestedClustersForIP(n.ControllerIP, ipClusters),
		HeartbeatIntervalSec:  n.HeartbeatIntervalSec,
		EffectiveHeartbeatSec: effectiveAgentHeartbeatSec(n.HeartbeatIntervalSec, 5),
		Probe:                 n.Probe,
		Heartbeats:            n.Heartbeats,
		ServiceName:           "middleware-execution",
	}
}

func buildUnifiedAgentFromDirect(
	a targetAgent,
	canManageGlobal bool,
	owners map[string]string,
	access func(owner, clusterID string) string,
	ipClusters map[string][]string,
) unifiedAgentView {
	modes := filterVisibleAgentModes(effectiveTargetAgentClusterModes(a), canManageGlobal, owners, access)
	revoked := a.Desired == "revoked"
	return unifiedAgentView{
		ID:                    a.ID,
		Backing:               "direct",
		Name:                  a.Host,
		IP:                    a.IP,
		Online:                targetAgentOnline(a),
		Disabled:              a.Disabled || revoked,
		Revoked:               revoked,
		LastSeen:              a.LastSeen,
		Version:               a.Version,
		Protocol:              3,
		SupportsExec:          !revoked,
		ClusterModes:          modes,
		Clusters:              sortedMapKeys(modes),
		SuggestedClusters:     suggestedClustersForIP(a.IP, ipClusters),
		HeartbeatIntervalSec:  a.HeartbeatIntervalSec,
		EffectiveHeartbeatSec: effectiveAgentHeartbeatSec(a.HeartbeatIntervalSec, 5),
		Probe:                 a.Probe,
		Heartbeats:            a.Heartbeats,
		ServiceName:           "middleware-target-agent-" + a.ID,
	}
}

func applyHeartbeatPolicyToViews(views []unifiedAgentView, defaultSec int) []unifiedAgentView {
	for i := range views {
		views[i].EffectiveHeartbeatSec = effectiveAgentHeartbeatSec(views[i].HeartbeatIntervalSec, defaultSec)
	}
	return views
}

func (s *storeServer) maybeAutoInspectNewlyBoundClusters(oldModes, newModes map[string]string, agentID, user, lang string) {
	for cid, mode := range newModes {
		if mode == "" || oldModes[cid] != "" {
			continue
		}
		rec := s.loadClusterStateRecord(cid)
		if !rec.ProbePolicy.InspectOnBind {
			continue
		}
		if s.hasActiveMutatingClusterWork(cid) {
			continue
		}
		_, _, _ = s.triggerClusterLiveInspect(cid, triggerLiveInspectOptions{
			AgentID: agentID,
			User:    user,
			Reason:  "bind_auto",
			Lang:    lang,
		})
	}
}

func listUnifiedAgentsFromDB(
	d executionDB,
	canManageGlobal bool,
	owners map[string]string,
	access func(owner, clusterID string) string,
	ipClusters map[string][]string,
) []unifiedAgentView {
	out := make([]unifiedAgentView, 0, len(d.Nodes)+len(d.Agents))
	for _, n := range d.Nodes {
		out = append(out, buildUnifiedAgentFromNode(n, canManageGlobal, owners, access, ipClusters))
	}
	for _, a := range d.Agents {
		if a.Mode != "direct" || a.Desired == "revoked" {
			continue
		}
		out = append(out, buildUnifiedAgentFromDirect(a, canManageGlobal, owners, access, ipClusters))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Disabled != out[j].Disabled {
			return !out[i].Disabled
		}
		if out[i].Online != out[j].Online {
			return out[i].Online
		}
		ni := strings.ToLower(out[i].Name)
		nj := strings.ToLower(out[j].Name)
		if ni != nj {
			return ni < nj
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func validateAgentClusterModeDiff(
	lang string,
	owners map[string]string,
	actorCanOp func(string) bool,
	oldModes, newModes map[string]string,
) (map[string]string, int, string) {
	cleaned, ok := cleanAgentClusterModes(newModes)
	if !ok {
		return nil, 400, tr(lang, "集群标识或 Agent 权限级别无效（仅支持 readonly 或 readwrite）", "Invalid cluster ID or Agent mode (expected readonly or readwrite)")
	}
	for cid, mode := range cleaned {
		if _, exists := owners[cid]; !exists {
			return nil, 404, tr(lang, "指定的集群不存在："+cid, "Cluster not found: "+cid)
		}
		if oldModes[cid] != mode && !actorCanOp(cid) {
			return nil, 403, tr(lang, "无权调整集群「"+cid+"」的 Agent 权限", "No operate permission on cluster: "+cid)
		}
	}
	for cid := range oldModes {
		if _, exists := cleaned[cid]; !exists && !actorCanOp(cid) {
			return nil, 403, tr(lang, "无权移除集群「"+cid+"」已关联的 Agent", "No operate permission to unbind Agent from cluster: "+cid)
		}
	}
	return cleaned, 200, ""
}

type agentClusterCatalogItem struct {
	ID        string   `json:"id"`
	AppName   string   `json:"app_name"`
	Version   string   `json:"version,omitempty"`
	Platform  string   `json:"platform,omitempty"`
	Owner     string   `json:"owner,omitempty"`
	HostIPs   []string `json:"host_ips,omitempty"`
	HostNames []string `json:"host_names,omitempty"`
	CanOp     bool     `json:"can_op"`
}

// clusterHostMeta extracts OS platform, unique host IPs, and hostnames for a cluster without holding locks.
func (s *storeServer) clusterHostMeta(cid, jobID string) (string, []string, []string) {
	platform := ""
	seenIP := map[string]bool{}
	seenName := map[string]bool{}
	var ips []string
	var names []string
	addHost := func(rawName, rawIP string) {
		name := strings.TrimSpace(rawName)
		if p := net.ParseIP(strings.TrimSpace(rawIP)); p != nil {
			ip := p.String()
			if !seenIP[ip] {
				seenIP[ip] = true
				ips = append(ips, ip)
			}
		}
		if name != "" && !seenName[name] {
			seenName[name] = true
			names = append(names, name)
		}
	}
	if jobID != "" {
		if dep := s.readSpec(jobID); dep != nil {
			platform = strings.TrimSpace(dep.Platform)
			for _, h := range dep.Hosts {
				addHost(h.Name, h.IP)
			}
		}
	}
	cfg := s.loadClusterAutomationConfig(cid)
	for _, ch := range cfg.CustomHosts {
		addHost(ch.Name, ch.IP)
	}
	return platform, ips, names
}

func (s *storeServer) buildAgentClusterCatalog(
	user string,
	canManageGlobal bool,
	actorCanOp func(string) bool,
) []agentClusterCatalogItem {
	vis := s.visibleJobs(user)
	byCluster := map[string][]storeJob{}
	s.mu.Lock()
	for _, j := range s.jobs {
		if j.State != "succeeded" {
			continue
		}
		cid := j.ClusterID
		if cid == "" {
			cid = j.ID
		}
		if !canManageGlobal && !vis(j.Owner, cid) {
			continue
		}
		byCluster[cid] = append(byCluster[cid], j)
	}
	s.mu.Unlock()

	out := make([]agentClusterCatalogItem, 0, len(byCluster))
	for cid, jobs := range byCluster {
		sortJobs(jobs)
		first := jobs[0]
		for _, j := range jobs {
			if j.Seq == 0 && j.live() {
				first = j
				break
			}
		}
		specJob := first
		ver := first.Version
		if cur, ok := clusterCurrent(jobs); ok {
			specJob = cur
			if cur.AppID == first.AppID && cur.Version != "" {
				ver = cur.Version
			}
		}
		ver = s.deliveryAppVersion(specJob.ID, first.AppID, ver)
		plat, ips, names := s.clusterHostMeta(cid, specJob.ID)
		out = append(out, agentClusterCatalogItem{
			ID:        cid,
			AppName:   first.AppName,
			Version:   ver,
			Platform:  plat,
			Owner:     first.Owner,
			HostIPs:   ips,
			HostNames: names,
			CanOp:     actorCanOp(cid),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ID < out[j].ID
	})
	return out
}

func (s *storeServer) handleUnifiedAgents(w http.ResponseWriter, r *http.Request, session storeSession) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/executions/unified-agents"), "/")
	if rest == "bundle" && r.Method == "POST" {
		s.handleUnifiedAgentBundle(w, r, session)
		return
	}
	if rest != "" {
		s.fail(w, 404, "接口不存在")
		return
	}

	lang := reqLang(r)
	actor := s.accessOf(session.User)
	canManageGlobal := actor.can("execution.manage")
	if !canManageGlobal && !actor.can("delivery.view") {
		s.failBi(w, 403, "需要集群查看或执行节点管理权限", "Permission required to view Execution Agents")
		return
	}
	access := s.clusterAccess(session.User)
	owners := s.clusterOwners()
	actorCanOp := func(cid string) bool {
		return canManageGlobal || access(owners[cid], cid) == "operate"
	}
	var ipClusters map[string][]string
	var catalog []agentClusterCatalogItem
	if r.Method == "GET" || r.Method == "POST" || r.Method == "PATCH" {
		ipClusters = s.clusterIPIndex(session.User)
	}
	if r.Method == "GET" {
		catalog = s.buildAgentClusterCatalog(session.User, canManageGlobal, actorCanOp)
	}

	executionMu.Lock()
	execLocked := true
	unlockExec := func() {
		if execLocked {
			execLocked = false
			executionMu.Unlock()
		}
	}
	defer unlockExec()
	d, err := s.readExecutions()
	if err != nil {
		s.fail(w, 500, err.Error())
		return
	}
	if d.Nodes == nil {
		d.Nodes = map[string]executionNode{}
	}
	if d.Agents == nil {
		d.Agents = map[string]targetAgent{}
	}

	switch r.Method {
	case "GET":
		hbPol := s.loadHeartbeatPolicy()
		list := applyHeartbeatPolicyToViews(listUnifiedAgentsFromDB(d, canManageGlobal, owners, access, ipClusters), hbPol.DefaultIntervalSec)
		manageable := make([]string, 0, len(owners))
		for cid := range owners {
			if actorCanOp(cid) {
				manageable = append(manageable, cid)
			}
		}
		sort.Strings(manageable)
		s.writeJSON(w, 200, map[string]any{
			"agents":              list,
			"manageable_clusters": manageable,
			"cluster_catalog":     catalog,
			"bootstrap":           s.executionBootstrapInfo(r),
			"heartbeat_policy":    hbPol,
		})

	case "POST":
		if !actor.can("execution.manage") {
			s.failBi(w, 403, "接入新 Agent 需要「管理执行节点」权限", "Enrolling a new Agent requires execution.manage permission")
			return
		}
		var req struct {
			Name                 string            `json:"name"`
			IP                   string            `json:"ip"`
			ClusterModes         map[string]string `json:"cluster_modes"`
			Clusters             []string          `json:"clusters"`
			DefaultMode          string            `json:"default_mode"`
			HeartbeatIntervalSec int               `json:"heartbeat_interval_sec"`
		}
		if decodeBody(w, r, 16384, &req) != nil {
			s.fail(w, 400, "请求参数无效")
			return
		}
		name := strings.TrimSpace(req.Name)
		parsedIP := net.ParseIP(strings.TrimSpace(req.IP))
		if name == "" || len([]rune(name)) > 80 || parsedIP == nil {
			s.failBi(w, 400, "请填写有效的 Agent 名称和机器 IP 地址", "Please provide a valid Agent name and host IP address")
			return
		}
		ipStr := parsedIP.String()
		rawModes := map[string]string{}
		for k, v := range req.ClusterModes {
			rawModes[k] = v
		}
		defMode := "readwrite"
		if m, ok := normalizeAgentClusterMode(req.DefaultMode); ok {
			defMode = m
		}
		for _, cid := range req.Clusters {
			cid = strings.TrimSpace(cid)
			if cid != "" && rawModes[cid] == "" {
				rawModes[cid] = defMode
			}
		}
		cleanedModes, code, errMsg := validateAgentClusterModeDiff(lang, owners, actorCanOp, nil, rawModes)
		if errMsg != "" {
			s.fail(w, code, errMsg)
			return
		}

		tDeliver, tProbe, tRehearse := true, true, true
		token := randomStoreToken(32)
		n := executionNode{
			ID:                   randomStoreToken(12),
			Kind:                 "independent",
			Name:                 name,
			ControllerIP:         ipStr,
			TokenHash:            digest([]byte(token)),
			Disabled:             false,
			AllowDelivery:        &tDeliver,
			AllowProbe:           &tProbe,
			AllowRehearsal:       &tRehearse,
			HeartbeatIntervalSec: normalizeHeartbeatIntervalSec(req.HeartbeatIntervalSec, true),
		}
		applyNodeClusterModes(&n, cleanedModes)
		d.Nodes[n.ID] = n
		if err := s.saveExecutions(d); err != nil {
			s.fail(w, 500, "保存 Agent 失败")
			return
		}
		hbPol := s.loadHeartbeatPolicy()
		uv := buildUnifiedAgentFromNode(n, true, owners, access, ipClusters)
		uv.EffectiveHeartbeatSec = effectiveAgentHeartbeatSec(n.HeartbeatIntervalSec, hbPol.DefaultIntervalSec)
		s.auditReq(r, "unified-agent-create", session.User, fmt.Sprintf("%s %s (%s) clusters=%v", n.ID, n.Name, n.ControllerIP, n.Clusters))
		s.writeJSON(w, 201, map[string]any{
			"agent":     uv,
			"token":     token,
			"bootstrap": s.executionBootstrapInfo(r),
		})

	case "PATCH":
		canEditAny := canManageGlobal || actor.can("delivery.create") || actor.can("delivery.execute")
		if !canEditAny {
			s.failBi(w, 403, "仅只读查看权限无法调整 Agent 配置或集群绑定", "Read-only permission cannot modify Agent settings or cluster bindings")
			return
		}
		var req struct {
			ID                   string             `json:"id"`
			Name                 *string            `json:"name"`
			Disabled             *bool              `json:"disabled"`
			HeartbeatIntervalSec *int               `json:"heartbeat_interval_sec"`
			DefaultHeartbeatSec  *int               `json:"default_heartbeat_sec"`
			ClusterModes         *map[string]string `json:"cluster_modes"`
			BindClusters         []string           `json:"bind_clusters"`
			UnbindClusters       []string           `json:"unbind_clusters"`
			SetCluster           *struct {
				ClusterID string `json:"cluster_id"`
				Mode      string `json:"mode"` // "" | "readonly" | "readwrite"
			} `json:"set_cluster"`
		}
		if decodeBody(w, r, 16384, &req) != nil {
			s.fail(w, 400, "请求参数无效")
			return
		}
		id := strings.TrimSpace(req.ID)
		if req.DefaultHeartbeatSec != nil {
			if !canManageGlobal {
				s.failBi(w, 403, "修改全局默认心跳周期需要管理权限", "Updating global heartbeat interval requires management permission")
				return
			}
			pol := agentHeartbeatPolicy{
				DefaultIntervalSec: normalizeHeartbeatIntervalSec(*req.DefaultHeartbeatSec, false),
				UpdatedAt:          nowStamp(),
				UpdatedBy:          session.User,
			}
			if err := s.saveHeartbeatPolicy(pol); err != nil {
				s.fail(w, 500, "保存全局心跳策略失败")
				return
			}
			if id == "" {
				s.auditReq(r, "agent-heartbeat-policy", session.User, fmt.Sprintf("default_interval_sec=%ds", pol.DefaultIntervalSec))
				s.writeJSON(w, 200, map[string]any{"heartbeat_policy": pol})
				return
			}
		}
		if id == "" {
			s.fail(w, 400, "请求参数无效")
			return
		}
		if (req.Disabled != nil || req.Name != nil || req.HeartbeatIntervalSec != nil) && !canManageGlobal {
			s.failBi(w, 403, "启用/禁用、重命名或调整 Agent 心跳周期需要管理权限", "Enabling/disabling, renaming, or changing heartbeat interval requires management permission")
			return
		}

		for _, raw := range req.BindClusters {
			cid := strings.TrimSpace(raw)
			if cid == "" {
				continue
			}
			if _, exists := owners[cid]; !exists {
				s.fail(w, 404, tr(lang, "指定的集群不存在："+cid, "Cluster not found: "+cid))
				return
			}
			if !actorCanOp(cid) {
				s.fail(w, 403, tr(lang, "无权将集群「"+cid+"」关联到此 Agent", "No operate permission on cluster: "+cid))
				return
			}
		}
		for _, raw := range req.UnbindClusters {
			cid := strings.TrimSpace(raw)
			if cid == "" {
				continue
			}
			if _, exists := owners[cid]; !exists {
				s.fail(w, 404, tr(lang, "指定的集群不存在："+cid, "Cluster not found: "+cid))
				return
			}
			if !actorCanOp(cid) {
				s.fail(w, 403, tr(lang, "无权解除集群「"+cid+"」的 Agent 关联", "No operate permission to unbind cluster: "+cid))
				return
			}
		}

		computeTargetModes := func(oldModes map[string]string) (map[string]string, bool) {
			if req.ClusterModes != nil {
				if canManageGlobal {
					return *req.ClusterModes, true
				}
				merged := cloneStringMap(oldModes)
				if merged == nil {
					merged = map[string]string{}
				}
				for cid := range oldModes {
					if access(owners[cid], cid) == "operate" {
						delete(merged, cid)
					}
				}
				for cid, m := range *req.ClusterModes {
					merged[cid] = m
				}
				return merged, true
			}
			if len(req.BindClusters) > 0 || len(req.UnbindClusters) > 0 {
				merged := cloneStringMap(oldModes)
				if merged == nil {
					merged = map[string]string{}
				}
				for _, raw := range req.BindClusters {
					cid := strings.TrimSpace(raw)
					if cid != "" {
						merged[cid] = "readwrite"
					}
				}
				for _, raw := range req.UnbindClusters {
					cid := strings.TrimSpace(raw)
					if cid != "" {
						delete(merged, cid)
					}
				}
				return merged, true
			}
			if req.SetCluster != nil {
				cid := strings.TrimSpace(req.SetCluster.ClusterID)
				merged := cloneStringMap(oldModes)
				if merged == nil {
					merged = map[string]string{}
				}
				if strings.TrimSpace(req.SetCluster.Mode) == "" || strings.EqualFold(strings.TrimSpace(req.SetCluster.Mode), "disabled") || strings.EqualFold(strings.TrimSpace(req.SetCluster.Mode), "none") {
					delete(merged, cid)
				} else {
					merged[cid] = req.SetCluster.Mode
				}
				return merged, true
			}
			return nil, false
		}

		if n, ok := d.Nodes[id]; ok {
			if req.Name != nil {
				nm := strings.TrimSpace(*req.Name)
				if nm == "" || len([]rune(nm)) > 80 {
					s.fail(w, 400, "Agent 名称长度须在 1～80 字符之间")
					return
				}
				n.Name = nm
			}
			if req.Disabled != nil {
				n.Disabled = *req.Disabled
			}
			if req.HeartbeatIntervalSec != nil {
				n.HeartbeatIntervalSec = normalizeHeartbeatIntervalSec(*req.HeartbeatIntervalSec, true)
			}
			oldModes := effectiveNodeClusterModes(n)
			var newCleaned map[string]string
			if targetModes, hasModeChange := computeTargetModes(oldModes); hasModeChange {
				cleaned, code, errMsg := validateAgentClusterModeDiff(lang, owners, actorCanOp, oldModes, targetModes)
				if errMsg != "" {
					s.fail(w, code, errMsg)
					return
				}
				applyNodeClusterModes(&n, cleaned)
				newCleaned = cleaned
			}
			d.Nodes[id] = n
			if err := s.saveExecutions(d); err != nil {
				s.fail(w, 500, "保存 Agent 失败")
				return
			}
			hbPol := s.loadHeartbeatPolicy()
			uv := buildUnifiedAgentFromNode(n, canManageGlobal, owners, access, ipClusters)
			uv.EffectiveHeartbeatSec = effectiveAgentHeartbeatSec(n.HeartbeatIntervalSec, hbPol.DefaultIntervalSec)
			oldCopy := cloneStringMap(oldModes)
			newCopy := cloneStringMap(newCleaned)
			unlockExec()
			if len(newCopy) > 0 && uv.Online && !uv.Disabled {
				s.maybeAutoInspectNewlyBoundClusters(oldCopy, newCopy, n.ID, session.User, lang)
			}
			s.auditReq(r, "unified-agent-update", session.User, fmt.Sprintf("%s %s disabled=%v hb=%ds clusters=%v", n.ID, n.Name, n.Disabled, n.HeartbeatIntervalSec, n.ClusterModes))
			s.writeJSON(w, 200, uv)
			return
		}

		if a, ok := d.Agents[id]; ok && a.Mode == "direct" && a.Desired != "revoked" {
			if req.Name != nil {
				nm := strings.TrimSpace(*req.Name)
				if nm == "" || len([]rune(nm)) > 80 {
					s.fail(w, 400, "Agent 名称长度须在 1～80 字符之间")
					return
				}
				a.Host = nm
			}
			if req.Disabled != nil {
				a.Disabled = *req.Disabled
			}
			if req.HeartbeatIntervalSec != nil {
				a.HeartbeatIntervalSec = normalizeHeartbeatIntervalSec(*req.HeartbeatIntervalSec, true)
			}
			oldModes := effectiveTargetAgentClusterModes(a)
			var newCleaned map[string]string
			if targetModes, hasModeChange := computeTargetModes(oldModes); hasModeChange {
				cleaned, code, errMsg := validateAgentClusterModeDiff(lang, owners, actorCanOp, oldModes, targetModes)
				if errMsg != "" {
					s.fail(w, code, errMsg)
					return
				}
				applyTargetAgentClusterModes(&a, cleaned)
				newCleaned = cleaned
			}
			d.Agents[id] = a
			if err := s.saveExecutions(d); err != nil {
				s.fail(w, 500, "保存 Agent 失败")
				return
			}
			hbPol := s.loadHeartbeatPolicy()
			uv := buildUnifiedAgentFromDirect(a, canManageGlobal, owners, access, ipClusters)
			uv.EffectiveHeartbeatSec = effectiveAgentHeartbeatSec(a.HeartbeatIntervalSec, hbPol.DefaultIntervalSec)
			oldCopy := cloneStringMap(oldModes)
			newCopy := cloneStringMap(newCleaned)
			unlockExec()
			if len(newCopy) > 0 && uv.Online && !uv.Disabled {
				s.maybeAutoInspectNewlyBoundClusters(oldCopy, newCopy, a.ID, session.User, lang)
			}
			s.auditReq(r, "unified-agent-update", session.User, fmt.Sprintf("%s %s disabled=%v hb=%ds clusters=%v", a.ID, a.Host, a.Disabled, a.HeartbeatIntervalSec, a.ClusterModes))
			s.writeJSON(w, 200, uv)
			return
		}

		s.fail(w, 404, "指定的 Agent 不存在")

	case "DELETE":
		if !actor.can("execution.manage") {
			s.failBi(w, 403, "删除 Agent 需要「管理执行节点」权限", "Deleting an Agent requires execution.manage permission")
			return
		}
		var req struct {
			ID string `json:"id"`
		}
		if decodeBody(w, r, 4096, &req) != nil || strings.TrimSpace(req.ID) == "" {
			s.fail(w, 400, "请求参数无效")
			return
		}
		id := strings.TrimSpace(req.ID)
		if n, ok := d.Nodes[id]; ok {
			for _, run := range d.Runs {
				if run.Node == n.ID && activeExecution(run) {
					s.failBi(w, 409, "该 Agent 仍有正在执行的任务（集群 "+run.Cluster+"），请等待结束或中止后再删除", "Agent still has an active execution run")
					return
				}
			}
			delete(d.Nodes, id)
			if err := s.saveExecutions(d); err != nil {
				s.fail(w, 500, "删除 Agent 失败")
				return
			}
			s.auditReq(r, "unified-agent-delete", session.User, id+" "+n.Name)
			s.writeJSON(w, 200, map[string]any{"deleted": id})
			return
		}
		if a, ok := d.Agents[id]; ok && a.Mode == "direct" {
			delete(d.Agents, id)
			if err := s.saveExecutions(d); err != nil {
				s.fail(w, 500, "删除 Agent 失败")
				return
			}
			s.auditReq(r, "unified-agent-delete", session.User, id+" "+a.Host)
			s.writeJSON(w, 200, map[string]any{"deleted": id})
			return
		}
		s.fail(w, 404, "指定的 Agent 不存在")

	default:
		s.fail(w, 405, "方法不支持")
	}
}

func (s *storeServer) handleUnifiedAgentBundle(w http.ResponseWriter, r *http.Request, session storeSession) {
	if !s.can(session.User, "execution.manage") {
		s.fail(w, 403, "下载 Agent 安装包需要管理权限")
		return
	}
	var req struct {
		AgentID   string `json:"agent_id"`
		Token     string `json:"token"`
		URL       string `json:"url"`
		IncludeCA *bool  `json:"include_ca"`
	}
	if decodeBody(w, r, 16384, &req) != nil || strings.TrimSpace(req.AgentID) == "" || len(req.Token) < 40 {
		s.failBi(w, 400, "缺少 Agent 标识或连接令牌", "Missing Agent ID or connection token")
		return
	}
	hubURL := strings.TrimRight(strings.TrimSpace(req.URL), "/")
	u, uerr := url.Parse(hubURL)
	if uerr != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		s.failBi(w, 400, "平台访问地址格式无效，请填写如 https://192.168.1.10:8443", "Invalid Hub URL")
		return
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "https" && !(u.Scheme == "http" && ip != nil && ip.IsLoopback()) {
		s.failBi(w, 400, "Agent 必须使用 HTTPS 连接平台", "Agents must connect over HTTPS")
		return
	}

	executionMu.Lock()
	d, err := s.readExecutions()
	executionMu.Unlock()
	if err != nil {
		s.fail(w, 500, err.Error())
		return
	}
	node, ok := d.Nodes[req.AgentID]
	if !ok || !constantStoreEqual(digest([]byte(req.Token)), node.TokenHash) {
		s.failBi(w, 403, "Agent 凭证校验失败，请重新接入生成安装命令", "Agent credential verification failed")
		return
	}

	binFile, binInfo, err := s.openExecutionNodeBinary()
	if err != nil {
		if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
			s.failBi(w, 404,
				"当前服务端非 Linux amd64 环境，且未找到 middleware-store-linux-amd64 二进制文件",
				"middleware-store-linux-amd64 binary not found")
		} else {
			s.fail(w, 500, "Agent 二进制文件不可读")
		}
		return
	}
	defer binFile.Close()

	caBytes, _ := s.readPlatformCACert()
	includeCA := len(caBytes) > 0
	if req.IncludeCA != nil {
		includeCA = *req.IncludeCA && len(caBytes) > 0
	}

	cfgObj := executionRunnerConfig{
		URL:   hubURL,
		Token: req.Token,
		Root:  "/root/middleware-automation",
		State: "/var/lib/middleware-execution",
	}
	if includeCA {
		cfgObj.CAFile = "/etc/middleware-execution/platform-ca.pem"
	}
	cfgBytes, _ := json.MarshalIndent(cfgObj, "", "  ")
	cfgBytes = append(cfgBytes, '\n')

	slug := runnerBundleSlug(node.Name, node.ControllerIP)
	dirName := "ds-agent-" + slug
	fileName := dirName + ".tar.gz"
	nowTime := time.Now().UTC()

	s.auditReq(r, "unified-agent-bundle", session.User, node.ID+" "+hubURL)
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", fileName))
	w.Header().Set("Cache-Control", "no-store")

	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	binHdr := &tar.Header{
		Name:    dirName + "/middleware-store-linux-amd64",
		Mode:    0755,
		Size:    binInfo.Size(),
		ModTime: binInfo.ModTime(),
	}
	if err := tw.WriteHeader(binHdr); err != nil {
		return
	}
	if _, err := io.Copy(tw, binFile); err != nil {
		return
	}
	if err := writeTarBytes(tw, dirName+"/execution-node.json", 0600, cfgBytes, nowTime); err != nil {
		return
	}
	if includeCA {
		if err := writeTarBytes(tw, dirName+"/platform-ca.pem", 0644, caBytes, nowTime); err != nil {
			return
		}
	}
	installSh := []byte(renderRunnerInstallScript(node.Name, hubURL, includeCA))
	if err := writeTarBytes(tw, dirName+"/install.sh", 0755, installSh, nowTime); err != nil {
		return
	}
	uninstallSh := []byte(renderRunnerUninstallScript())
	if err := writeTarBytes(tw, dirName+"/uninstall.sh", 0755, uninstallSh, nowTime); err != nil {
		return
	}
	_ = tw.Close()
	_ = gz.Close()
}

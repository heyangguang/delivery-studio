package server

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Rehearsal & Baseline Automation Engine:
// Supports two first-class execution transports for both platform-delivered and imported clusters:
//   1. "node"  — Controller machine (execution-node) accessing targets via Ansible / SSH (existing SSH or managed Target Agent keys);
//   2. "agent" — Direct Target Agent installed on each target host (zero SSH passwords, zero control host needed).
// All read-only probes pass dual-side static validation (Hub + Runner); mutating tasks enforce exclusive cluster/IP locks.

var rehearsalExecMu sync.Mutex

type clusterAutomationHost struct {
	Name string `json:"name"`
	IP   string `json:"ip"`
	Role string `json:"role,omitempty"`
}

type clusterAutomationConfig struct {
	ClusterID         string                  `json:"cluster_id"`
	Enabled           bool                    `json:"enabled"`
	Transport         string                  `json:"transport"`                  // node | agent
	NodeID            string                  `json:"node_id,omitempty"`          // executionNode.ID when transport == "node"
	NodeExecMethod    string                  `json:"node_exec_method,omitempty"` // auto | ansible | ssh
	SSHUser           string                  `json:"ssh_user,omitempty"`         // default "root"
	SSHPort           int                     `json:"ssh_port,omitempty"`         // default 22
	EnvKind           string                  `json:"env_kind"`                   // prod | test
	DefaultPacing     string                  `json:"default_pacing,omitempty"`   // step_confirm | ai_gated_auto
	PauseBeforeMutate bool                    `json:"pause_before_mutate"`
	AllowProdMutate   bool                    `json:"allow_prod_mutate"`
	TestClusterID     string                  `json:"test_cluster_id,omitempty"`
	CustomHosts       []clusterAutomationHost `json:"custom_hosts,omitempty"`
	LastCheckState    string                  `json:"last_check_state,omitempty"` // succeeded | failed | blocked | stopped
	LastCheckAt       string                  `json:"last_check_at,omitempty"`
	LastCheckSig      string                  `json:"last_check_sig,omitempty"`
	UpdatedAt         string                  `json:"updated_at,omitempty"`
	UpdatedBy         string                  `json:"updated_by,omitempty"`
}

func automationChannelSig(transport, nodeID, method, sshUser string, sshPort int) string {
	t := strings.TrimSpace(transport)
	if t != "agent" {
		t = "node"
	}
	if t == "agent" {
		return "agent"
	}
	m := strings.TrimSpace(method)
	if m != "ansible" && m != "ssh" {
		m = "auto"
	}
	u := strings.TrimSpace(sshUser)
	if u == "" {
		u = "root"
	}
	p := sshPort
	if p <= 0 || p > 65535 {
		p = 22
	}
	return fmt.Sprintf("node|%s|%s|%s|%d", strings.TrimSpace(nodeID), m, u, p)
}

type rehearsalExecTarget struct {
	Host    string `json:"host"`
	IP      string `json:"ip"`
	Role    string `json:"role,omitempty"`
	AgentID string `json:"agent_id,omitempty"`
}

type rehearsalExecTargetResult struct {
	Host       string  `json:"host"`
	IP         string  `json:"ip"`
	Role       string  `json:"role,omitempty"`
	AgentID    string  `json:"agent_id,omitempty"`
	State      string  `json:"state"` // queued | leased | running | succeeded | failed | stopped | unknown | blocked
	ExitCode   *int    `json:"exit_code,omitempty"`
	StartedAt  string  `json:"started_at,omitempty"`
	FinishedAt string  `json:"finished_at,omitempty"`
	ElapsedSec float64 `json:"elapsed_sec,omitempty"`
	Output     string  `json:"output,omitempty"`
	Error      string  `json:"error,omitempty"`
	Seq        int     `json:"seq,omitempty"`
}

type rehearsalExecTask struct {
	ID             string                      `json:"id"`
	ClusterID      string                      `json:"cluster_id"`
	RehearsalID    string                      `json:"rehearsal_id,omitempty"`
	StepID         string                      `json:"step_id,omitempty"`
	StepOrder      int                         `json:"step_order,omitempty"`
	StepTitle      string                      `json:"step_title,omitempty"`
	SubIndex       int                         `json:"sub_index"` // -1 for full step, >=0 for sub-command
	Kind           string                      `json:"kind"`      // connectivity_check | baseline_probe | rehearsal_probe | rehearsal_step | rehearsal_rollback
	ReadOnly       bool                        `json:"read_only"`
	Transport      string                      `json:"transport"` // node | agent
	NodeID         string                      `json:"node_id,omitempty"`
	NodeName       string                      `json:"node_name,omitempty"`
	NodeExecMethod string                      `json:"node_exec_method,omitempty"` // auto | ansible | ssh
	SSHUser        string                      `json:"ssh_user,omitempty"`
	SSHPort        int                         `json:"ssh_port,omitempty"`
	EnvKind        string                      `json:"env_kind"` // prod | test
	Script         string                      `json:"script"`
	ScriptSHA256   string                      `json:"script_sha256"`
	TimeoutSec     int                         `json:"timeout_sec"`
	Targets        []rehearsalExecTarget       `json:"targets"`
	Results        []rehearsalExecTargetResult `json:"results"`
	State          string                      `json:"state"` // queued | running | succeeded | failed | stopped | unknown | blocked
	Cancel         bool                        `json:"cancel,omitempty"`
	CombinedOutput string                      `json:"combined_output,omitempty"`
	Error          string                      `json:"error,omitempty"`
	By             string                      `json:"by"`
	CreatedAt      string                      `json:"created_at"`
	UpdatedAt      string                      `json:"updated_at"`
	FinishedAt     string                      `json:"finished_at,omitempty"`
	Resources      []string                    `json:"resources,omitempty"`
}

type rehearsalExecDispatch struct {
	TaskID       string                `json:"task_id"`
	ClusterID    string                `json:"cluster_id"`
	TargetIndex  int                   `json:"target_index"` // -1 for multi-target node dispatch, >=0 for single-host direct agent
	Kind         string                `json:"kind"`
	ReadOnly     bool                  `json:"read_only"`
	Transport    string                `json:"transport"` // node | agent
	ExecMethod   string                `json:"exec_method,omitempty"`
	SSHUser      string                `json:"ssh_user,omitempty"`
	SSHPort      int                   `json:"ssh_port,omitempty"`
	Targets      []rehearsalExecTarget `json:"targets"`
	Script       string                `json:"script"`
	ScriptSHA256 string                `json:"script_sha256"`
	TimeoutSec   int                   `json:"timeout_sec"`
}

type rehearsalExecEvent struct {
	TaskID      string `json:"task_id"`
	TargetIndex int    `json:"target_index"`
	Host        string `json:"host,omitempty"`
	IP          string `json:"ip,omitempty"`
	Seq         int    `json:"seq"`
	Kind        string `json:"kind"` // started | log | finished | stopped | unknown | blocked
	At          string `json:"at,omitempty"`
	Text        string `json:"text,omitempty"`
	ExitCode    *int   `json:"exit_code,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

type automationNodeView struct {
	executionNode
	Online         bool `json:"online"`
	AllowDelivery  bool `json:"allow_delivery"`
	AllowProbe     bool `json:"allow_probe"`
	AllowRehearsal bool `json:"allow_rehearsal"`
	SupportsV3     bool `json:"supports_v3"`
}

type automationAgentView struct {
	targetAgent
	Online bool `json:"online"`
}

var (
	reExecSecretKV     = regexp.MustCompile(`(?i)(\b(?:PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH|ETCDCTL_PASSWORD|PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_KEY|TOKEN|AUTH_TOKEN)\s*[=:]\s*)([^\s'"` + "`" + `;&|]+)`)
	reExecSecretFlag   = regexp.MustCompile(`(?i)(--(?:password|passwd|token|secret|auth-pass|pass)\s*[=\s]\s*)([^\s'"` + "`" + `;&|]+)`)
	reExecBearerHeader = regexp.MustCompile(`(?i)(Authorization:\s*Bearer\s+)([^\s]+)`)
	reExecPEMBlock     = regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----`)
)

func redactRehearsalExecOutput(s string) string {
	if s == "" {
		return ""
	}
	s = reExecPEMBlock.ReplaceAllString(s, "[REDACTED PRIVATE KEY]")
	s = reExecBearerHeader.ReplaceAllString(s, "${1}[REDACTED]")
	s = reExecSecretKV.ReplaceAllString(s, "${1}[REDACTED]")
	s = reExecSecretFlag.ReplaceAllString(s, "${1}[REDACTED]")
	return s
}

func nodeAllowsDelivery(n executionNode) bool {
	if n.AllowDelivery == nil {
		return true
	}
	return *n.AllowDelivery
}

func nodeAllowsProbe(n executionNode) bool {
	if n.AllowProbe == nil {
		return true
	}
	return *n.AllowProbe
}

func nodeAllowsRehearsal(n executionNode) bool {
	if n.AllowRehearsal == nil {
		return false
	}
	return *n.AllowRehearsal
}

func targetAgentOnline(a targetAgent) bool {
	if a.Desired != "active" || a.LastSeen == "" {
		return false
	}
	t, err := time.Parse(time.RFC3339Nano, a.LastSeen)
	return err == nil && time.Since(t) < 35*time.Second
}

func rehearsalTaskActive(state string) bool {
	return state == "queued" || state == "leased" || state == "running"
}

func rehearsalTargetTerminal(state string) bool {
	return state == "succeeded" || state == "failed" || state == "stopped" || state == "unknown" || state == "blocked"
}

func (s *storeServer) clusterAutomationPath(cluster string) string {
	return filepath.Join(s.cfg.DataDir, "automation", cluster+".json")
}

func (s *storeServer) rehearsalExecDir(cluster string) string {
	return s.executionPath("rehearsal_tasks", cluster)
}

func (s *storeServer) rehearsalExecPath(cluster, taskID string) string {
	return filepath.Join(s.rehearsalExecDir(cluster), taskID+".json")
}

func defaultClusterAutomationConfig(cluster string) clusterAutomationConfig {
	envKind := "prod"
	low := strings.ToLower(cluster)
	if strings.Contains(low, "test") || strings.Contains(low, "dev") || strings.Contains(low, "uat") || strings.Contains(low, "sit") || strings.Contains(low, "stg") || strings.Contains(low, "staging") || strings.Contains(low, "lab") {
		envKind = "test"
	}
	return clusterAutomationConfig{
		ClusterID:         cluster,
		Enabled:           false,
		Transport:         "node",
		NodeExecMethod:    "auto",
		SSHUser:           "root",
		SSHPort:           22,
		EnvKind:           envKind,
		DefaultPacing:     "step_confirm",
		PauseBeforeMutate: envKind == "prod",
		AllowProdMutate:   false,
	}
}

func (s *storeServer) loadClusterAutomationConfig(cluster string) clusterAutomationConfig {
	cfg := defaultClusterAutomationConfig(cluster)
	b, err := os.ReadFile(s.clusterAutomationPath(cluster))
	if err != nil {
		return cfg
	}
	var saved clusterAutomationConfig
	if json.Unmarshal(b, &saved) != nil {
		return cfg
	}
	saved.ClusterID = cluster
	if saved.Transport != "node" && saved.Transport != "agent" {
		saved.Transport = "node"
	}
	if saved.NodeExecMethod != "auto" && saved.NodeExecMethod != "ansible" && saved.NodeExecMethod != "ssh" {
		saved.NodeExecMethod = "auto"
	}
	if strings.TrimSpace(saved.SSHUser) == "" {
		saved.SSHUser = "root"
	}
	if saved.SSHPort <= 0 || saved.SSHPort > 65535 {
		saved.SSHPort = 22
	}
	if saved.EnvKind != "prod" && saved.EnvKind != "test" {
		saved.EnvKind = cfg.EnvKind
	}
	if saved.DefaultPacing != "step_confirm" && saved.DefaultPacing != "ai_gated_auto" {
		saved.DefaultPacing = "step_confirm"
	}
	return saved
}

func (s *storeServer) saveClusterAutomationConfig(cfg clusterAutomationConfig) error {
	return atomicExecutionJSON(s.clusterAutomationPath(cfg.ClusterID), cfg)
}

func (s *storeServer) saveRehearsalExecTask(t rehearsalExecTask) error {
	return atomicExecutionJSON(s.rehearsalExecPath(t.ClusterID, t.ID), t)
}

func (s *storeServer) loadRehearsalExecTask(cluster, taskID string) (rehearsalExecTask, bool) {
	if !docClusterID.MatchString(cluster) || !executionID.MatchString(taskID) {
		return rehearsalExecTask{}, false
	}
	b, err := os.ReadFile(s.rehearsalExecPath(cluster, taskID))
	if err != nil {
		return rehearsalExecTask{}, false
	}
	var t rehearsalExecTask
	if json.Unmarshal(b, &t) != nil || t.ID == "" {
		return rehearsalExecTask{}, false
	}
	return t, true
}

func (s *storeServer) listRehearsalExecTasks(cluster, rehearsalID string, limit int) []rehearsalExecTask {
	out := []rehearsalExecTask{}
	entries, err := os.ReadDir(s.rehearsalExecDir(cluster))
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".json")
		t, ok := s.loadRehearsalExecTask(cluster, id)
		if !ok {
			continue
		}
		if rehearsalID != "" && t.RehearsalID != rehearsalID {
			continue
		}
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *storeServer) listAllActiveRehearsalExecTasks() []rehearsalExecTask {
	out := []rehearsalExecTask{}
	root := s.executionPath("rehearsal_tasks")
	cdirs, err := os.ReadDir(root)
	if err != nil {
		return out
	}
	for _, cd := range cdirs {
		if !cd.IsDir() || !docClusterID.MatchString(cd.Name()) {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(root, cd.Name()))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			id := strings.TrimSuffix(e.Name(), ".json")
			t, ok := s.loadRehearsalExecTask(cd.Name(), id)
			if ok && rehearsalTaskActive(t.State) {
				out = append(out, t)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out
}

func (s *storeServer) findRehearsalExecTaskByID(taskID string) (rehearsalExecTask, bool) {
	if !executionID.MatchString(taskID) {
		return rehearsalExecTask{}, false
	}
	root := s.executionPath("rehearsal_tasks")
	cdirs, err := os.ReadDir(root)
	if err != nil {
		return rehearsalExecTask{}, false
	}
	for _, cd := range cdirs {
		if !cd.IsDir() {
			continue
		}
		if t, ok := s.loadRehearsalExecTask(cd.Name(), taskID); ok {
			return t, true
		}
	}
	return rehearsalExecTask{}, false
}

func (s *storeServer) clusterAutomationHostsFor(f clusterFacts, cfg clusterAutomationConfig) []clusterAutomationHost {
	seen := map[string]bool{}
	out := []clusterAutomationHost{}
	add := func(name, ip, role string) {
		ip = strings.TrimSpace(ip)
		name = strings.TrimSpace(name)
		if ip == "" && name == "" {
			return
		}
		key := strings.ToLower(ip)
		if key == "" {
			key = strings.ToLower(name)
		}
		if seen[key] {
			return
		}
		seen[key] = true
		if name == "" {
			name = ip
		}
		out = append(out, clusterAutomationHost{Name: name, IP: ip, Role: strings.TrimSpace(role)})
	}
	if f.Plan != nil {
		for _, h := range f.Plan.Hosts {
			role := ""
			for _, inst := range f.Plan.Instances {
				for rName, rHosts := range inst.Roles {
					for _, rh := range rHosts {
						if rh == h.Name {
							role = rName
							break
						}
					}
					if role != "" {
						break
					}
				}
				if role != "" {
					break
				}
			}
			add(h.Name, h.IP, role)
		}
	} else if spec := s.readSpec(f.Current.ID); spec != nil {
		for _, h := range spec.Hosts {
			add(h.Name, h.IP, "")
		}
	}
	for _, ch := range cfg.CustomHosts {
		add(ch.Name, ch.IP, ch.Role)
	}
	return out
}

func (s *storeServer) buildClusterAutomationSummary(r *http.Request, f clusterFacts) map[string]any {
	cfg := s.loadClusterAutomationConfig(f.ID)
	hosts := s.clusterAutomationHostsFor(f, cfg)

	executionMu.Lock()
	d, _ := s.readExecutions()
	executionMu.Unlock()

	nodes := make([]automationNodeView, 0, len(d.Nodes))
	for _, n := range d.Nodes {
		pub := publicExecutionNode(n)
		nodes = append(nodes, automationNodeView{
			executionNode:  pub,
			Online:         executionOnline(n),
			AllowDelivery:  nodeAllowsDelivery(n),
			AllowProbe:     nodeAllowsProbe(n),
			AllowRehearsal: nodeAllowsRehearsal(n),
			SupportsV3:     n.Protocol >= 3,
		})
	}
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Online != nodes[j].Online {
			return nodes[i].Online
		}
		return nodes[i].Name < nodes[j].Name
	})

	agents := []automationAgentView{}
	for _, a := range d.Agents {
		if a.Cluster != f.ID {
			continue
		}
		pub := localizeTargetAgent(wLangFromReq(r), publicTargetAgent(a))
		agents = append(agents, automationAgentView{
			targetAgent: pub,
			Online:      targetAgentOnline(a),
		})
	}
	sort.Slice(agents, func(i, j int) bool { return agents[i].Created > agents[j].Created })

	rehearsalExecMu.Lock()
	recent := s.listRehearsalExecTasks(f.ID, "", 12)
	rehearsalExecMu.Unlock()

	// Compute live readiness summary for quick topbar status pill
	ready := false
	readyReason := ""
	onlineAgents := 0
	for _, a := range agents {
		if a.Online && a.Desired == "active" {
			onlineAgents++
		}
	}
	if cfg.Enabled {
		if cfg.Transport == "agent" {
			if onlineAgents > 0 {
				ready = true
			} else {
				readyReason = tr(f.Lang, "暂无在线目标机 Agent，请先部署并启动 Agent", "No online Target Agent found; enroll and start an agent first")
			}
		} else {
			var picked *automationNodeView
			for i := range nodes {
				if nodes[i].ID == cfg.NodeID {
					picked = &nodes[i]
					break
				}
			}
			if picked == nil {
				readyReason = tr(f.Lang, "未绑定执行节点，请先选择 1 台在线控制机", "No execution node selected")
			} else if !picked.Online {
				readyReason = tr(f.Lang, "绑定的执行节点当前离线", "Selected execution node is offline")
			} else {
				ready = true
			}
		}
	}

	sig := automationChannelSig(cfg.Transport, cfg.NodeID, cfg.NodeExecMethod, cfg.SSHUser, cfg.SSHPort)
	checkMatches := cfg.LastCheckSig != "" && cfg.LastCheckSig == sig
	lastCheckState := ""
	lastCheckAt := ""
	if checkMatches {
		lastCheckState = cfg.LastCheckState
		lastCheckAt = cfg.LastCheckAt
	}
	verified := cfg.Enabled && ready && checkMatches && cfg.LastCheckState == "succeeded"

	return map[string]any{
		"config":           cfg,
		"hosts":            hosts,
		"nodes":            nodes,
		"agents":           agents,
		"online_agents":    onlineAgents,
		"ready":            ready,
		"ready_reason":     readyReason,
		"verified":         verified,
		"last_check_state": lastCheckState,
		"last_check_at":    lastCheckAt,
		"bootstrap":        s.executionBootstrapInfo(r),
		"recent_tasks":     recent,
	}
}

func wLangFromReq(r *http.Request) string {
	if r == nil {
		return ""
	}
	return reqLang(r)
}

func (s *storeServer) handleClusterAutomation(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, parts []string) {
	switch {
	case len(parts) == 0 && r.Method == "GET":
		s.writeJSON(w, 200, s.buildClusterAutomationSummary(r, f))
		return

	case len(parts) == 0 && r.Method == "PUT":
		var req clusterAutomationConfig
		if decodeBody(w, r, 65536, &req) != nil {
			s.fail(w, 400, "自动化配置格式无效")
			return
		}
		if req.Transport != "node" && req.Transport != "agent" {
			s.fail(w, 400, "接入方式仅支持控制机直连（node）或目标机 Agent 直连（agent）")
			return
		}
		if req.NodeExecMethod == "" {
			req.NodeExecMethod = "auto"
		}
		if req.NodeExecMethod != "auto" && req.NodeExecMethod != "ansible" && req.NodeExecMethod != "ssh" {
			s.fail(w, 400, "控制机执行方式仅支持 auto、ansible 或 ssh")
			return
		}
		if req.EnvKind != "prod" && req.EnvKind != "test" {
			s.fail(w, 400, "环境类型仅支持生产环境（prod）或测试/演练环境（test）")
			return
		}
		if req.DefaultPacing == "" {
			req.DefaultPacing = "step_confirm"
		}
		if req.DefaultPacing != "step_confirm" && req.DefaultPacing != "ai_gated_auto" {
			s.fail(w, 400, "执行节奏仅支持 step_confirm 或 ai_gated_auto")
			return
		}
		req.SSHUser = strings.TrimSpace(req.SSHUser)
		if req.SSHUser == "" {
			req.SSHUser = "root"
		}
		if len(req.SSHUser) > 48 || strings.ContainsAny(req.SSHUser, " \t\r\n;|&$`'\"\\") {
			s.fail(w, 400, "SSH 用户名格式无效")
			return
		}
		if req.SSHPort <= 0 {
			req.SSHPort = 22
		}
		if req.SSHPort > 65535 {
			s.fail(w, 400, "SSH 端口须在 1～65535 之间")
			return
		}
		if req.Transport == "node" && req.Enabled && req.NodeID != "" {
			executionMu.Lock()
			d, _ := s.readExecutions()
			_, exists := d.Nodes[req.NodeID]
			executionMu.Unlock()
			if !exists {
				s.fail(w, 404, "指定的执行节点不存在")
				return
			}
		}
		cleanedHosts := make([]clusterAutomationHost, 0, len(req.CustomHosts))
		for _, ch := range req.CustomHosts {
			ip := strings.TrimSpace(ch.IP)
			if ip == "" || net.ParseIP(ip) == nil {
				continue
			}
			name := strings.TrimSpace(ch.Name)
			if name == "" {
				name = ip
			}
			cleanedHosts = append(cleanedHosts, clusterAutomationHost{
				Name: truncRunes(name, 80),
				IP:   net.ParseIP(ip).String(),
				Role: truncRunes(strings.TrimSpace(ch.Role), 40),
			})
		}
		prev := s.loadClusterAutomationConfig(f.ID)
		nextSig := automationChannelSig(req.Transport, req.NodeID, req.NodeExecMethod, req.SSHUser, req.SSHPort)
		if prev.LastCheckSig != "" && prev.LastCheckSig == nextSig {
			req.LastCheckState = prev.LastCheckState
			req.LastCheckAt = prev.LastCheckAt
			req.LastCheckSig = prev.LastCheckSig
		} else {
			req.LastCheckState = ""
			req.LastCheckAt = ""
			req.LastCheckSig = ""
		}
		req.ClusterID = f.ID
		req.CustomHosts = cleanedHosts
		req.UpdatedAt = executionNow()
		req.UpdatedBy = session.User
		if err := s.saveClusterAutomationConfig(req); err != nil {
			s.fail(w, 500, "保存自动化配置失败")
			return
		}
		s.auditReq(r, "cluster-automation-update", session.User, fmt.Sprintf("%s enabled=%v transport=%s env=%s", f.ID, req.Enabled, req.Transport, req.EnvKind))
		s.writeJSON(w, 200, s.buildClusterAutomationSummary(r, f))
		return

	case len(parts) == 1 && parts[0] == "agents":
		s.handleClusterDirectAgents(w, r, session, f)
		return

	case len(parts) == 3 && parts[0] == "agents" && parts[2] == "bundle" && r.Method == "POST":
		s.handleClusterTargetAgentBundle(w, r, session, f, parts[1])
		return

	case len(parts) == 1 && parts[0] == "check" && r.Method == "POST":
		s.handleClusterAutomationCheck(w, r, session, f)
		return

	case len(parts) == 1 && parts[0] == "probe" && r.Method == "POST":
		s.handleClusterAutomationProbe(w, r, session, f)
		return

	case len(parts) == 1 && parts[0] == "tasks" && r.Method == "GET":
		rehearsalExecMu.Lock()
		tasks := s.listRehearsalExecTasks(f.ID, "", 30)
		rehearsalExecMu.Unlock()
		s.writeJSON(w, 200, tasks)
		return

	case len(parts) == 2 && parts[0] == "tasks" && r.Method == "GET":
		rehearsalExecMu.Lock()
		t, ok := s.loadRehearsalExecTask(f.ID, parts[1])
		rehearsalExecMu.Unlock()
		if !ok {
			s.fail(w, 404, "自动化执行任务不存在")
			return
		}
		s.writeJSON(w, 200, t)
		return

	case len(parts) == 3 && parts[0] == "tasks" && parts[2] == "cancel" && r.Method == "POST":
		s.handleCancelRehearsalExecTask(w, r, session, f, parts[1])
		return

	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) handleClusterDirectAgents(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts) {
	executionMu.Lock()
	defer executionMu.Unlock()
	d, err := s.readExecutions()
	if err != nil {
		s.fail(w, 500, err.Error())
		return
	}
	if d.Agents == nil {
		d.Agents = map[string]targetAgent{}
	}
	if r.Method == "GET" {
		out := []automationAgentView{}
		for _, a := range d.Agents {
			if a.Cluster == f.ID {
				out = append(out, automationAgentView{
					targetAgent: localizeTargetAgent(wLang(w), publicTargetAgent(a)),
					Online:      targetAgentOnline(a),
				})
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Created > out[j].Created })
		s.writeJSON(w, 200, out)
		return
	}
	if r.Method == "POST" {
		var req struct {
			Host          string `json:"host"`
			IP            string `json:"ip"`
			AllowMutating *bool  `json:"allow_mutating"`
		}
		if decodeBody(w, r, 8192, &req) != nil {
			s.fail(w, 400, "请求参数无效")
			return
		}
		cfg := s.loadClusterAutomationConfig(f.ID)
		hosts := s.clusterAutomationHostsFor(f, cfg)
		targetHost := strings.TrimSpace(req.Host)
		targetIP := strings.TrimSpace(req.IP)
		for _, h := range hosts {
			if (targetHost != "" && strings.EqualFold(h.Name, targetHost)) || (targetIP != "" && h.IP == targetIP) {
				if targetHost == "" {
					targetHost = h.Name
				}
				if targetIP == "" {
					targetIP = h.IP
				}
				break
			}
		}
		parsedIP := net.ParseIP(targetIP)
		if targetHost == "" || parsedIP == nil {
			s.fail(w, 400, "请选择集群中的有效目标主机和 IP")
			return
		}
		targetIP = parsedIP.String()

		// Cleanly supersede stale un-enrolled expired direct agents for the same IP; prevent duplicate active direct agents.
		for id, a := range d.Agents {
			if a.Cluster == f.ID && a.Mode == "direct" && a.IP == targetIP && a.Desired == "active" {
				exp, _ := time.Parse(time.RFC3339Nano, a.Expires)
				if a.TokenHash != "" || time.Now().Before(exp) {
					s.fail(w, 409, "该目标机已存在有效直连 Agent 配置，请使用已有配置或先撤销旧配置")
					return
				}
				delete(d.Agents, id)
			}
		}
		allowMut := true
		if req.AllowMutating != nil {
			allowMut = *req.AllowMutating
		}
		token := randomStoreToken(32)
		a := targetAgent{
			ID:             randomStoreToken(12),
			Job:            f.Current.ID,
			Cluster:        f.ID,
			Mode:           "direct",
			Host:           targetHost,
			IP:             targetIP,
			AllowMutating:  allowMut,
			Created:        executionNow(),
			Expires:        time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339Nano),
			EnrollmentHash: digest([]byte(token)),
			Desired:        "active",
		}
		d.Agents[a.ID] = a
		if err := s.saveExecutions(d); err != nil {
			s.fail(w, 500, "保存直连 Agent 配置失败")
			return
		}
		s.auditReq(r, "cluster-agent-enroll", session.User, fmt.Sprintf("%s %s %s (%s)", f.ID, a.ID, a.Host, a.IP))
		s.writeJSON(w, 201, map[string]any{
			"agent":            publicTargetAgent(a),
			"enrollment_token": token,
			"bootstrap":        s.executionBootstrapInfo(r),
		})
		return
	}
	if r.Method == "PATCH" {
		var req struct {
			ID            string `json:"id"`
			Action        string `json:"action"` // revoke | update
			AllowMutating *bool  `json:"allow_mutating"`
		}
		if decodeBody(w, r, 4096, &req) != nil || req.ID == "" {
			s.fail(w, 400, "请求参数无效")
			return
		}
		a, ok := d.Agents[req.ID]
		if !ok || a.Cluster != f.ID {
			s.fail(w, 404, "目标 Agent 不存在")
			return
		}
		if req.Action == "revoke" {
			a.Desired = "revoked"
			a.EnrollmentHash = ""
			if a.TokenHash == "" {
				a.Applied = "revoked"
				a.Message = "直连 Agent 接入已取消（尚未注册）"
			} else {
				a.Message = "已撤销该目标机直连 Agent 授权"
			}
			d.Agents[a.ID] = a
			if err := s.saveExecutions(d); err != nil {
				s.fail(w, 500, "保存失败")
				return
			}
			s.auditReq(r, "target-agent-revoke", session.User, a.ID+" "+f.ID)
			s.writeJSON(w, 200, automationAgentView{targetAgent: publicTargetAgent(a), Online: false})
			return
		}
		if req.AllowMutating != nil {
			a.AllowMutating = *req.AllowMutating
			d.Agents[a.ID] = a
			if err := s.saveExecutions(d); err != nil {
				s.fail(w, 500, "保存失败")
				return
			}
			s.auditReq(r, "cluster-agent-update", session.User, fmt.Sprintf("%s %s allow_mutating=%v", f.ID, a.ID, a.AllowMutating))
			s.writeJSON(w, 200, automationAgentView{targetAgent: publicTargetAgent(a), Online: targetAgentOnline(a)})
			return
		}
		s.fail(w, 400, "未指定有效操作")
		return
	}
	s.fail(w, 405, "方法不支持")
}

func renderDirectAgentInstallScript(agentID, hostName, hubURL string, hasCA bool) string {
	caInstall := ""
	if hasCA {
		caInstall = fmt.Sprintf(`install -m 0644 "$SCRIPT_DIR/platform-ca.pem" /etc/middleware-execution/platform-ca.pem
echo "[OK] Installed platform CA certificate -> /etc/middleware-execution/platform-ca.pem"
`)
	}
	svc := "middleware-target-agent-" + agentID
	cfgPath := fmt.Sprintf("/etc/middleware-execution/target-agent-%s.json", agentID)
	return fmt.Sprintf(`#!/usr/bin/env bash
set -euo pipefail

# Kyndryl Delivery Studio Direct Target Agent Installer
# Target Host: %s
# Agent ID:    %s
# Hub URL:     %s

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[ERROR] Please run this installer as root (e.g. sudo bash install.sh)." >&2
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" && "$ARCH" != "amd64" ]]; then
  echo "[ERROR] Unsupported architecture: $ARCH (Linux x86_64 required)." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "[ERROR] systemd (systemctl) is required to run target-agent in the background." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[1/4] Stopping any previous %s service..."
systemctl stop %s 2>/dev/null || true

echo "[2/4] Installing target-agent binary and 0600 configuration..."
install -m 0755 "$SCRIPT_DIR/middleware-store-linux-amd64" /usr/local/bin/middleware-store
install -d -m 0700 /etc/middleware-execution /var/lib/middleware-target/%s
install -m 0600 "$SCRIPT_DIR/target-agent.json" %s
%s
echo "[3/4] Installing and starting systemd background service..."
cat <<'EOF' > /etc/systemd/system/%s.service
[Unit]
Description=Kyndryl Delivery Studio Target Agent (%s)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
UMask=0077
ExecStart=/usr/local/bin/middleware-store target-agent --config %s
Restart=on-failure
RestartSec=10
KillMode=process

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now %s

echo "[4/4] Checking target-agent status..."
sleep 2
if systemctl is-active --quiet %s; then
  echo ""
  echo "============================================================"
  echo "[OK] Direct Target Agent is installed and running."
  echo "     Service: %s"
  echo "     Logs:    journalctl -u %s -f"
  echo "============================================================"
else
  echo "[WARN] Service started with warnings. Inspect logs:" >&2
  journalctl -u %s -n 30 --no-pager >&2 || true
  exit 1
fi
`, hostName, agentID, hubURL, svc, svc, agentID, cfgPath, caInstall, svc, hostName, cfgPath, svc, svc, svc, svc, svc)
}

func (s *storeServer) handleClusterTargetAgentBundle(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, agentID string) {
	var req struct {
		Token     string `json:"token"`
		URL       string `json:"url"`
		IncludeCA *bool  `json:"include_ca"`
	}
	if decodeBody(w, r, 16384, &req) != nil || len(req.Token) < 40 {
		s.failBi(w, 400, "缺少一次性接入令牌", "Missing enrollment token")
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
		s.failBi(w, 400, "目标机 Agent 必须使用 HTTPS 连接平台", "Target agents must connect over HTTPS")
		return
	}
	executionMu.Lock()
	d, err := s.readExecutions()
	executionMu.Unlock()
	if err != nil {
		s.fail(w, 500, err.Error())
		return
	}
	a, ok := d.Agents[agentID]
	if !ok || a.Cluster != f.ID || a.Desired != "active" || !constantStoreEqual(digest([]byte(req.Token)), a.EnrollmentHash) {
		s.failBi(w, 403, "接入令牌校验失败或已过期，请重新生成目标机 Agent", "Enrollment token verification failed or expired")
		return
	}
	binFile, binInfo, err := s.openExecutionNodeBinary()
	if err != nil {
		if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
			s.failBi(w, 404,
				"当前服务端非 Linux amd64 环境，且未找到 middleware-store-linux-amd64 文件（请将其放入 artifacts 目录或可执行文件同级目录）",
				"middleware-store-linux-amd64 binary not found")
		} else {
			s.fail(w, 500, "执行器文件不可读")
		}
		return
	}
	defer binFile.Close()

	caBytes, _ := s.readPlatformCACert()
	includeCA := len(caBytes) > 0
	if req.IncludeCA != nil {
		includeCA = *req.IncludeCA && len(caBytes) > 0
	}
	cfgObj := targetAgentConfig{
		URL:        hubURL,
		ID:         a.ID,
		Enrollment: req.Token,
		State:      "/var/lib/middleware-target/" + a.ID,
	}
	if includeCA {
		cfgObj.CAFile = "/etc/middleware-execution/platform-ca.pem"
	}
	cfgBytes, _ := json.MarshalIndent(cfgObj, "", "  ")
	cfgBytes = append(cfgBytes, '\n')

	slug := runnerBundleSlug(a.Host, a.IP)
	dirName := "mw-target-agent-" + slug
	fileName := dirName + ".tar.gz"
	nowTime := time.Now().UTC()

	s.auditReq(r, "cluster-agent-bundle", session.User, fmt.Sprintf("%s %s %s", f.ID, a.ID, hubURL))
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
	if err := writeTarBytes(tw, dirName+"/target-agent.json", 0600, cfgBytes, nowTime); err != nil {
		return
	}
	if includeCA {
		if err := writeTarBytes(tw, dirName+"/platform-ca.pem", 0644, caBytes, nowTime); err != nil {
			return
		}
	}
	installSh := []byte(renderDirectAgentInstallScript(a.ID, a.Host, hubURL, includeCA))
	if err := writeTarBytes(tw, dirName+"/install.sh", 0755, installSh, nowTime); err != nil {
		return
	}
	_ = tw.Close()
	_ = gz.Close()
}

type enqueueRehearsalTaskSpec struct {
	ClusterID      string
	RehearsalID    string
	StepID         string
	StepOrder      int
	StepTitle      string
	SubIndex       int
	Kind           string // connectivity_check | baseline_probe | rehearsal_probe | rehearsal_step | rehearsal_rollback
	ReadOnly       bool
	Script         string
	TimeoutSec     int
	Targets        []rehearsalExecTarget
	ConfirmCluster string
	Transport      string // optional override: node | agent
	NodeID         string // optional override
	NodeExecMethod string // optional override: auto | ansible | ssh
	SSHUser        string // optional override
	SSHPort        int    // optional override
	User           string
	Lang           string
}

func (s *storeServer) enqueueRehearsalExecTask(spec enqueueRehearsalTaskSpec) (rehearsalExecTask, int, string) {
	cfg := s.loadClusterAutomationConfig(spec.ClusterID)
	transport := strings.TrimSpace(spec.Transport)
	if transport == "" {
		transport = cfg.Transport
	}
	if transport != "node" && transport != "agent" {
		transport = "node"
	}
	nodeExecMethod := strings.TrimSpace(spec.NodeExecMethod)
	if nodeExecMethod == "" {
		nodeExecMethod = cfg.NodeExecMethod
	}
	if nodeExecMethod != "auto" && nodeExecMethod != "ansible" && nodeExecMethod != "ssh" {
		return rehearsalExecTask{}, 400, tr(spec.Lang, "控制机执行方式仅支持 auto、ansible 或 ssh", "Controller execution method must be auto, ansible, or ssh")
	}
	sshUser := strings.TrimSpace(spec.SSHUser)
	if sshUser == "" {
		sshUser = cfg.SSHUser
	}
	if len(sshUser) > 48 || strings.ContainsAny(sshUser, " \t\r\n;|&$`'\"\\") {
		return rehearsalExecTask{}, 400, tr(spec.Lang, "SSH 用户名格式无效", "Invalid SSH username")
	}
	sshPort := spec.SSHPort
	if sshPort == 0 {
		sshPort = cfg.SSHPort
	}
	if sshPort < 1 || sshPort > 65535 {
		return rehearsalExecTask{}, 400, tr(spec.Lang, "SSH 端口须在 1～65535 之间", "SSH port must be between 1 and 65535")
	}
	if !cfg.Enabled && spec.Kind != "connectivity_check" {
		return rehearsalExecTask{}, 409, tr(spec.Lang, "当前集群尚未开启自动化执行，请先在自动化配置中启用", "Cluster automation is disabled; enable it in Automation Settings first")
	}

	script := strings.TrimSpace(spec.Script)
	if script == "" {
		return rehearsalExecTask{}, 400, tr(spec.Lang, "待执行脚本或命令为空", "Script or command is empty")
	}
	if len(script) > 256*1024 {
		return rehearsalExecTask{}, 400, tr(spec.Lang, "脚本内容超过 256KB 上限", "Script exceeds 256KB limit")
	}
	if spec.ReadOnly {
		script = ensureProbeBashGuard(script)
		ok, warns := validateReadOnlyProbeScriptLang(script, spec.Lang)
		if !ok || len(warns) > 0 {
			return rehearsalExecTask{}, 403, tr(spec.Lang,
				"静态只读门禁已拦截：该只读采集任务包含写操作或风险指令（"+strings.Join(warns, "；")+"）",
				"Static read-only safety gate blocked script: "+strings.Join(warns, "; "))
		}
	}

	if len(spec.Targets) == 0 {
		return rehearsalExecTask{}, 400, tr(spec.Lang, "请至少选择 1 台执行目标主机", "Select at least one target host")
	}

	// Production mutation safety gate
	if !spec.ReadOnly && cfg.EnvKind == "prod" {
		if !cfg.AllowProdMutate {
			return rehearsalExecTask{}, 403, tr(spec.Lang,
				"当前集群标记为「生产环境」且未勾选「允许生产执行变更步骤」；当前仅放行 100% 只读采集",
				"Production cluster does not allow mutating execution; enable Allow Production Mutations or run read-only probes only")
		}
		if strings.TrimSpace(spec.ConfirmCluster) != spec.ClusterID {
			return rehearsalExecTask{}, 400, tr(spec.Lang,
				"生产环境执行写操作步骤须先核对并确认集群标识："+spec.ClusterID,
				"Production mutation requires confirming cluster ID: "+spec.ClusterID)
		}
	}

	executionMu.Lock()
	execDB, err := s.readExecutions()
	executionMu.Unlock()
	if err != nil {
		return rehearsalExecTask{}, 500, err.Error()
	}

	nodeID := strings.TrimSpace(spec.NodeID)
	if nodeID == "" {
		nodeID = cfg.NodeID
	}
	nodeName := ""

	targets := make([]rehearsalExecTarget, 0, len(spec.Targets))
	for _, tg := range spec.Targets {
		ip := strings.TrimSpace(tg.IP)
		if ip == "" || net.ParseIP(ip) == nil {
			return rehearsalExecTask{}, 400, tr(spec.Lang, "目标主机 IP 无效："+tg.Host, "Invalid target host IP: "+tg.Host)
		}
		tg.IP = net.ParseIP(ip).String()
		if strings.TrimSpace(tg.Host) == "" {
			tg.Host = tg.IP
		}
		targets = append(targets, tg)
	}

	if transport == "node" {
		if nodeID == "" {
			return rehearsalExecTask{}, 409, tr(spec.Lang, "未选择执行节点（控制机），请先在自动化设置中绑定在线执行节点", "No execution node selected; bind an online node in Automation Settings")
		}
		n, ok := execDB.Nodes[nodeID]
		if !ok {
			return rehearsalExecTask{}, 404, tr(spec.Lang, "绑定的执行节点不存在", "Execution node not found")
		}
		if !executionOnline(n) {
			return rehearsalExecTask{}, 409, tr(spec.Lang, "执行节点「"+n.Name+"」当前离线或已停用", "Execution node '"+n.Name+"' is offline or disabled")
		}
		if spec.ReadOnly && !nodeAllowsProbe(n) {
			return rehearsalExecTask{}, 403, tr(spec.Lang, "执行节点「"+n.Name+"」未授权「只读探针采集」，请在设置→执行节点开启", "Node '"+n.Name+"' is not authorized for read-only probes")
		}
		if !spec.ReadOnly && !nodeAllowsRehearsal(n) {
			return rehearsalExecTask{}, 403, tr(spec.Lang, "执行节点「"+n.Name+"」未授权「变更演练步骤执行」，请在设置→执行节点开启", "Node '"+n.Name+"' is not authorized for rehearsal step execution")
		}
		if n.Protocol < 3 {
			return rehearsalExecTask{}, 409, tr(spec.Lang,
				"执行节点「"+n.Name+"」当前协议版本为 v"+fmt.Sprintf("%d", n.Protocol)+"，请更新节点二进制至最新版本以支持演练自动化（Protocol v3）",
				"Execution node '"+n.Name+"' uses protocol v"+fmt.Sprintf("%d", n.Protocol)+"; upgrade the runner binary to Protocol v3")
		}
		nodeName = n.Name
	} else {
		// Direct Target Agent mode: every target host must resolve to an online active targetAgent for this cluster
		for i := range targets {
			var matched *targetAgent
			for _, a := range execDB.Agents {
				if a.Cluster != spec.ClusterID || a.Desired != "active" {
					continue
				}
				if targets[i].AgentID != "" && a.ID == targets[i].AgentID {
					cp := a
					matched = &cp
					break
				}
				if a.IP == targets[i].IP && (a.Mode == "direct" || matched == nil) {
					cp := a
					matched = &cp
				}
			}
			if matched == nil {
				return rehearsalExecTask{}, 409, tr(spec.Lang,
					fmt.Sprintf("目标主机 %s (%s) 尚未部署直连 Agent，请先在自动化设置中为该主机生成并启动 Agent", targets[i].Host, targets[i].IP),
					fmt.Sprintf("Target host %s (%s) has no enrolled Target Agent", targets[i].Host, targets[i].IP))
			}
			if !targetAgentOnline(*matched) {
				return rehearsalExecTask{}, 409, tr(spec.Lang,
					fmt.Sprintf("目标主机 %s (%s) 的 Agent 当前离线，请检查服务状态", targets[i].Host, targets[i].IP),
					fmt.Sprintf("Target Agent on %s (%s) is offline", targets[i].Host, targets[i].IP))
			}
			if !spec.ReadOnly && !matched.AllowMutating {
				return rehearsalExecTask{}, 403, tr(spec.Lang,
					fmt.Sprintf("目标主机 %s (%s) 的 Agent 当前仅允许只读采集，未开启「允许变更步骤执行」", targets[i].Host, targets[i].IP),
					fmt.Sprintf("Target Agent on %s (%s) is restricted to read-only probes", targets[i].Host, targets[i].IP))
			}
			targets[i].AgentID = matched.ID
		}
	}

	// Build exclusive resource locks for mutating tasks
	resources := []string{}
	if !spec.ReadOnly {
		resources = append(resources, "cluster:"+spec.ClusterID)
		for _, tg := range targets {
			resources = append(resources, "ip:"+tg.IP)
		}
	}

	rehearsalExecMu.Lock()
	defer rehearsalExecMu.Unlock()

	if !spec.ReadOnly {
		// Check collision against active first-time Ansible delivery runs
		for _, run := range execDB.Runs {
			if !activeExecution(run) {
				continue
			}
			for _, res := range resources {
				if contains(run.Resources, res) {
					return rehearsalExecTask{}, 409, tr(spec.Lang,
						"同一集群或主机正在执行首次交付批次（"+run.ID+"），已拒绝并发写入",
						"Cluster or host is locked by active delivery run "+run.ID)
				}
			}
		}
		// Check collision against active mutating rehearsal tasks
		for _, act := range s.listAllActiveRehearsalExecTasks() {
			if act.ReadOnly {
				continue
			}
			for _, res := range resources {
				if contains(act.Resources, res) {
					return rehearsalExecTask{}, 409, tr(spec.Lang,
						"同一集群或主机已有正在执行的变更任务（"+act.ID+"），请等待结束或先中止",
						"Cluster or host is locked by active rehearsal task "+act.ID)
				}
			}
		}
	}

	timeoutSec := spec.TimeoutSec
	if timeoutSec < 10 {
		timeoutSec = 180
		if spec.ReadOnly {
			timeoutSec = 120
		}
	}
	if timeoutSec > 3600 {
		timeoutSec = 3600
	}

	results := make([]rehearsalExecTargetResult, len(targets))
	for i, tg := range targets {
		results[i] = rehearsalExecTargetResult{
			Host:    tg.Host,
			IP:      tg.IP,
			Role:    tg.Role,
			AgentID: tg.AgentID,
			State:   "queued",
		}
	}
	now := executionNow()
	task := rehearsalExecTask{
		ID:             "rhx-" + randomStoreToken(10),
		ClusterID:      spec.ClusterID,
		RehearsalID:    spec.RehearsalID,
		StepID:         spec.StepID,
		StepOrder:      spec.StepOrder,
		StepTitle:      spec.StepTitle,
		SubIndex:       spec.SubIndex,
		Kind:           spec.Kind,
		ReadOnly:       spec.ReadOnly,
		Transport:      transport,
		NodeID:         nodeID,
		NodeName:       nodeName,
		NodeExecMethod: nodeExecMethod,
		SSHUser:        sshUser,
		SSHPort:        sshPort,
		EnvKind:        cfg.EnvKind,
		Script:         script,
		ScriptSHA256:   digest([]byte(script)),
		TimeoutSec:     timeoutSec,
		Targets:        targets,
		Results:        results,
		State:          "queued",
		By:             spec.User,
		CreatedAt:      now,
		UpdatedAt:      now,
		Resources:      resources,
	}
	if err := s.saveRehearsalExecTask(task); err != nil {
		return rehearsalExecTask{}, 500, "保存自动化执行任务失败"
	}
	return task, 201, ""
}

func (s *storeServer) handleClusterAutomationCheck(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts) {
	var req struct {
		Targets        []rehearsalExecTarget `json:"targets"`
		Transport      string                `json:"transport"`
		NodeID         string                `json:"node_id"`
		NodeExecMethod string                `json:"node_exec_method"`
		SSHUser        string                `json:"ssh_user"`
		SSHPort        int                   `json:"ssh_port"`
	}
	_ = decodeBody(w, r, 16384, &req)
	cfg := s.loadClusterAutomationConfig(f.ID)
	targets := req.Targets
	if len(targets) == 0 {
		for _, h := range s.clusterAutomationHostsFor(f, cfg) {
			targets = append(targets, rehearsalExecTarget{Host: h.Name, IP: h.IP, Role: h.Role})
		}
	}
	script := `#!/usr/bin/env bash
set -u
export LC_ALL=C
echo "=== CONNECTIVITY_OK ==="
echo "HOSTNAME=$(hostname -f 2>/dev/null || hostname)"
echo "USER=$(id -un) UID=$(id -u)"
echo "OS=$(uname -srm)"
echo "IPS=$(hostname -I 2>/dev/null || true)"
`
	task, code, msg := s.enqueueRehearsalExecTask(enqueueRehearsalTaskSpec{
		ClusterID:      f.ID,
		SubIndex:       -1,
		Kind:           "connectivity_check",
		ReadOnly:       true,
		Script:         script,
		TimeoutSec:     45,
		Targets:        targets,
		Transport:      req.Transport,
		NodeID:         req.NodeID,
		NodeExecMethod: req.NodeExecMethod,
		SSHUser:        req.SSHUser,
		SSHPort:        req.SSHPort,
		User:           session.User,
		Lang:           f.Lang,
	})
	if msg != "" {
		s.fail(w, code, msg)
		return
	}
	s.auditReq(r, "cluster-automation-check", session.User, fmt.Sprintf("%s %s transport=%s targets=%d", f.ID, task.ID, task.Transport, len(task.Targets)))
	s.writeJSON(w, 201, task)
}

func (s *storeServer) handleClusterAutomationProbe(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts) {
	var req struct {
		Script  string                `json:"script"`
		Targets []rehearsalExecTarget `json:"targets"`
	}
	if decodeBody(w, r, 300*1024, &req) != nil {
		s.fail(w, 400, "请求无效")
		return
	}
	cfg := s.loadClusterAutomationConfig(f.ID)
	targets := req.Targets
	if len(targets) == 0 {
		for _, h := range s.clusterAutomationHostsFor(f, cfg) {
			targets = append(targets, rehearsalExecTarget{Host: h.Name, IP: h.IP, Role: h.Role})
		}
	}
	task, code, msg := s.enqueueRehearsalExecTask(enqueueRehearsalTaskSpec{
		ClusterID:  f.ID,
		SubIndex:   -1,
		Kind:       "baseline_probe",
		ReadOnly:   true,
		Script:     req.Script,
		TimeoutSec: 150,
		Targets:    targets,
		User:       session.User,
		Lang:       f.Lang,
	})
	if msg != "" {
		s.fail(w, code, msg)
		return
	}
	s.auditReq(r, "cluster-automation-probe", session.User, fmt.Sprintf("%s %s transport=%s targets=%d", f.ID, task.ID, task.Transport, len(task.Targets)))
	s.writeJSON(w, 201, task)
}

func (s *storeServer) handleCancelRehearsalExecTask(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, taskID string) {
	rehearsalExecMu.Lock()
	defer rehearsalExecMu.Unlock()
	t, ok := s.loadRehearsalExecTask(f.ID, taskID)
	if !ok {
		s.fail(w, 404, "执行任务不存在")
		return
	}
	if !rehearsalTaskActive(t.State) {
		s.writeJSON(w, 200, t)
		return
	}
	t.Cancel = true
	t.UpdatedAt = executionNow()
	allQueued := true
	for i := range t.Results {
		if t.Results[i].State == "queued" {
			t.Results[i].State = "stopped"
			t.Results[i].FinishedAt = t.UpdatedAt
			t.Results[i].Error = tr(f.Lang, "已由用户取消（尚未启动）", "Cancelled by user before start")
		} else if !rehearsalTargetTerminal(t.Results[i].State) {
			allQueued = false
		}
	}
	if allQueued {
		t.State = "stopped"
		t.FinishedAt = t.UpdatedAt
	}
	if err := s.saveRehearsalExecTask(t); err != nil {
		s.fail(w, 500, "保存取消状态失败")
		return
	}
	s.auditReq(r, "rehearsal-exec-cancel", session.User, fmt.Sprintf("%s %s", f.ID, t.ID))
	s.writeJSON(w, 200, t)
}

func (s *storeServer) handleRehearsalExec(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string, parts []string) {
	rh, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		s.fail(w, 404, "演练会话不存在")
		return
	}
	switch {
	case len(parts) == 1 && parts[0] == "tasks" && r.Method == "GET":
		rehearsalExecMu.Lock()
		tasks := s.listRehearsalExecTasks(f.ID, rid, 50)
		rehearsalExecMu.Unlock()
		s.writeJSON(w, 200, tasks)
		return

	case len(parts) == 1 && parts[0] == "probe" && r.Method == "POST":
		var req struct {
			Targets []rehearsalExecTarget `json:"targets"`
		}
		_ = decodeBody(w, r, 16384, &req)
		if strings.TrimSpace(rh.ProbeScript) == "" {
			s.fail(w, 400, "当前演练尚未生成只读探针脚本")
			return
		}
		cfg := s.loadClusterAutomationConfig(f.ID)
		targets := req.Targets
		if len(targets) == 0 {
			for _, h := range s.clusterAutomationHostsFor(f, cfg) {
				targets = append(targets, rehearsalExecTarget{Host: h.Name, IP: h.IP, Role: h.Role})
			}
		}
		task, code, msg := s.enqueueRehearsalExecTask(enqueueRehearsalTaskSpec{
			ClusterID:   f.ID,
			RehearsalID: rid,
			SubIndex:    -1,
			Kind:        "rehearsal_probe",
			ReadOnly:    true,
			Script:      rh.ProbeScript,
			TimeoutSec:  180,
			Targets:     targets,
			User:        session.User,
			Lang:        f.Lang,
		})
		if msg != "" {
			s.fail(w, code, msg)
			return
		}
		s.auditReq(r, "rehearsal-exec-probe", session.User, fmt.Sprintf("%s %s task=%s transport=%s targets=%d", f.ID, rid, task.ID, task.Transport, len(task.Targets)))
		s.writeJSON(w, 201, task)
		return

	case len(parts) == 1 && parts[0] == "step" && r.Method == "POST":
		var req struct {
			StepID          string                `json:"step_id"`
			SubIndex        *int                  `json:"sub_index"`
			Kind            string                `json:"kind"` // step | rollback
			Targets         []rehearsalExecTarget `json:"targets"`
			ConfirmCluster  string                `json:"confirm_cluster"`
			TimeoutSec      int                   `json:"timeout_sec"`
			CommandOverride string                `json:"command_override"`
		}
		if decodeBody(w, r, 65536, &req) != nil || strings.TrimSpace(req.StepID) == "" {
			s.fail(w, 400, "请指定要执行的演练步骤")
			return
		}
		var step *rehearsalStep
		for i := range rh.Steps {
			if rh.Steps[i].ID == req.StepID {
				step = &rh.Steps[i]
				break
			}
		}
		if step == nil {
			s.fail(w, 404, "演练步骤不存在")
			return
		}
		isRollback := strings.EqualFold(strings.TrimSpace(req.Kind), "rollback")
		subIdx := -1
		if req.SubIndex != nil {
			subIdx = *req.SubIndex
		}
		cmd := strings.TrimSpace(req.CommandOverride)
		if cmd == "" {
			if isRollback {
				cmd = strings.TrimSpace(step.Rollback)
			} else if subIdx >= 0 && subIdx < len(step.Commands) {
				cmd = strings.TrimSpace(step.Commands[subIdx].Command)
			} else if len(step.Commands) > 0 {
				var partsCmd []string
				for i, sc := range step.Commands {
					if strings.TrimSpace(sc.Command) == "" {
						continue
					}
					label := strings.TrimSpace(sc.Label)
					if label == "" {
						label = fmt.Sprintf("Sub-step %d", i+1)
					}
					partsCmd = append(partsCmd, fmt.Sprintf("echo '=== [%d/%d] %s ==='\n%s", i+1, len(step.Commands), strings.ReplaceAll(label, "'", ""), strings.TrimSpace(sc.Command)))
				}
				cmd = strings.Join(partsCmd, "\n")
			} else {
				cmd = strings.TrimSpace(step.Command)
			}
		}
		if cmd == "" {
			s.fail(w, 400, tr(f.Lang, "该步骤没有可执行的命令内容", "Step has no executable command"))
			return
		}
		// Treat purely static-verified precheck/verify commands as read-only if they pass the strict read-only gate!
		readOnly := false
		if !isRollback && (step.Phase == "precheck" || step.Phase == "verify") {
			if okRO, warnsRO := validateReadOnlyProbeScript(cmd); okRO && len(warnsRO) == 0 {
				readOnly = true
			}
		}
		taskKind := "rehearsal_step"
		if isRollback {
			taskKind = "rehearsal_rollback"
		}
		timeoutSec := req.TimeoutSec
		if timeoutSec <= 0 {
			timeoutSec = 300
		}
		task, code, msg := s.enqueueRehearsalExecTask(enqueueRehearsalTaskSpec{
			ClusterID:      f.ID,
			RehearsalID:    rid,
			StepID:         step.ID,
			StepOrder:      step.Order,
			StepTitle:      step.Title,
			SubIndex:       subIdx,
			Kind:           taskKind,
			ReadOnly:       readOnly,
			Script:         cmd,
			TimeoutSec:     timeoutSec,
			Targets:        req.Targets,
			ConfirmCluster: req.ConfirmCluster,
			User:           session.User,
			Lang:           f.Lang,
		})
		if msg != "" {
			s.fail(w, code, msg)
			return
		}
		auditAction := "rehearsal-exec-step"
		if isRollback {
			auditAction = "rehearsal-exec-rollback"
		}
		s.auditReq(r, auditAction, session.User, fmt.Sprintf("%s %s step=%s task=%s ro=%v targets=%d", f.ID, rid, step.ID, task.ID, readOnly, len(task.Targets)))
		s.writeJSON(w, 201, task)
		return

	default:
		s.fail(w, 404, "接口不存在")
	}
}

// ---- Runner Poll & Streaming Event Integration ----

func (s *storeServer) pollRehearsalTaskForNode(n executionNode, heartbeat bool) (*rehearsalExecDispatch, []string) {
	rehearsalExecMu.Lock()
	defer rehearsalExecMu.Unlock()
	active := s.listAllActiveRehearsalExecTasks()
	var cancels []string
	var dispatch *rehearsalExecDispatch
	for _, t := range active {
		if t.Transport != "node" || t.NodeID != n.ID {
			continue
		}
		if t.Cancel {
			cancels = append(cancels, t.ID)
			continue
		}
		if heartbeat || dispatch != nil || n.Disabled || n.Protocol < 3 {
			continue
		}
		if t.State == "queued" {
			if t.ReadOnly && !nodeAllowsProbe(n) {
				continue
			}
			if !t.ReadOnly && !nodeAllowsRehearsal(n) {
				continue
			}
			now := executionNow()
			t.State = "running"
			t.UpdatedAt = now
			for i := range t.Results {
				if t.Results[i].State == "queued" {
					t.Results[i].State = "leased"
				}
			}
			if s.saveRehearsalExecTask(t) == nil {
				dispatch = &rehearsalExecDispatch{
					TaskID:       t.ID,
					ClusterID:    t.ClusterID,
					TargetIndex:  -1,
					Kind:         t.Kind,
					ReadOnly:     t.ReadOnly,
					Transport:    "node",
					ExecMethod:   t.NodeExecMethod,
					SSHUser:      t.SSHUser,
					SSHPort:      t.SSHPort,
					Targets:      t.Targets,
					Script:       t.Script,
					ScriptSHA256: t.ScriptSHA256,
					TimeoutSec:   t.TimeoutSec,
				}
			}
		}
	}
	return dispatch, cancels
}

func (s *storeServer) pollRehearsalTaskForAgent(a targetAgent, heartbeat bool) (*rehearsalExecDispatch, string) {
	rehearsalExecMu.Lock()
	defer rehearsalExecMu.Unlock()
	active := s.listAllActiveRehearsalExecTasks()
	cancelID := ""
	var dispatch *rehearsalExecDispatch
	for _, t := range active {
		if t.Transport != "agent" || t.ClusterID != a.Cluster {
			continue
		}
		for idx, tg := range t.Targets {
			if tg.AgentID != a.ID && tg.IP != a.IP {
				continue
			}
			if idx >= len(t.Results) {
				continue
			}
			res := t.Results[idx]
			if t.Cancel && !rehearsalTargetTerminal(res.State) {
				cancelID = t.ID
				continue
			}
			if heartbeat || dispatch != nil || a.Desired != "active" {
				continue
			}
			if res.State == "queued" {
				if !t.ReadOnly && !a.AllowMutating {
					continue
				}
				now := executionNow()
				t.Results[idx].State = "leased"
				if t.State == "queued" {
					t.State = "running"
				}
				t.UpdatedAt = now
				if s.saveRehearsalExecTask(t) == nil {
					dispatch = &rehearsalExecDispatch{
						TaskID:       t.ID,
						ClusterID:    t.ClusterID,
						TargetIndex:  idx,
						Kind:         t.Kind,
						ReadOnly:     t.ReadOnly,
						Transport:    "agent",
						Targets:      []rehearsalExecTarget{tg},
						Script:       t.Script,
						ScriptSHA256: t.ScriptSHA256,
						TimeoutSec:   t.TimeoutSec,
					}
				}
			}
		}
	}
	return dispatch, cancelID
}

func rebuildCombinedTaskOutput(t *rehearsalExecTask) {
	var b strings.Builder
	multi := len(t.Results) > 1
	for i, res := range t.Results {
		out := strings.TrimSpace(res.Output)
		errTxt := strings.TrimSpace(res.Error)
		if out == "" && errTxt == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		if multi {
			roleTag := ""
			if res.Role != "" {
				roleTag = " · " + res.Role
			}
			fmt.Fprintf(&b, "=== [HOST %d/%d: %s (%s%s)] ===\n", i+1, len(t.Results), res.Host, res.IP, roleTag)
		}
		if out != "" {
			b.WriteString(out)
		}
		if errTxt != "" {
			if out != "" {
				b.WriteString("\n")
			}
			b.WriteString("[ERROR] " + errTxt)
		}
	}
	t.CombinedOutput = b.String()
}

func (s *storeServer) applyRehearsalExecEvent(actorKind, actorID string, ev rehearsalExecEvent) (rehearsalExecTask, error) {
	rehearsalExecMu.Lock()
	defer rehearsalExecMu.Unlock()
	t, ok := s.findRehearsalExecTaskByID(ev.TaskID)
	if !ok {
		return rehearsalExecTask{}, errors.New("自动化执行任务不存在")
	}
	if actorKind == "node" && (t.Transport != "node" || t.NodeID != actorID) {
		return rehearsalExecTask{}, errors.New("该执行节点无权回传此任务结果")
	}
	if ev.TargetIndex < 0 || ev.TargetIndex >= len(t.Results) {
		return rehearsalExecTask{}, errors.New("目标节点序号无效")
	}
	if actorKind == "agent" {
		if t.Transport != "agent" || (t.Targets[ev.TargetIndex].AgentID != "" && t.Targets[ev.TargetIndex].AgentID != actorID) {
			return rehearsalExecTask{}, errors.New("该目标 Agent 无权回传此任务结果")
		}
	}
	res := &t.Results[ev.TargetIndex]
	if ev.Seq > 0 && ev.Seq <= res.Seq {
		return t, nil // idempotent retry ack
	}
	if ev.Seq > 0 {
		res.Seq = ev.Seq
	}
	now := executionNow()
	if ev.At != "" {
		now = ev.At
	}
	switch ev.Kind {
	case "started":
		res.State = "running"
		if res.StartedAt == "" {
			res.StartedAt = now
		}
		if t.State == "queued" {
			t.State = "running"
		}
	case "log":
		if ev.Text != "" {
			clean := redactRehearsalExecOutput(ev.Text)
			const maxTargetOut = 2 * 1024 * 1024 // 2 MiB per target cap
			if len(res.Output)+len(clean) <= maxTargetOut {
				res.Output += clean
			} else if len(res.Output) < maxTargetOut {
				res.Output += clean[:maxTargetOut-len(res.Output)] + "\n... [output truncated at 2 MiB]\n"
			}
		}
	case "finished", "failed":
		if ev.Text != "" {
			res.Output += redactRehearsalExecOutput(ev.Text)
		}
		res.ExitCode = ev.ExitCode
		res.FinishedAt = now
		if res.StartedAt != "" {
			if st, e1 := time.Parse(time.RFC3339Nano, res.StartedAt); e1 == nil {
				if ft, e2 := time.Parse(time.RFC3339Nano, now); e2 == nil && ft.After(st) {
					res.ElapsedSec = float64(ft.Sub(st).Milliseconds()) / 1000.0
				}
			}
		}
		if ev.ExitCode != nil && *ev.ExitCode == 0 {
			res.State = "succeeded"
		} else {
			res.State = "failed"
			if ev.Reason != "" {
				res.Error = redactRehearsalExecOutput(ev.Reason)
			} else if ev.ExitCode != nil {
				res.Error = fmt.Sprintf("exit code %d", *ev.ExitCode)
			}
		}
	case "stopped":
		res.State = "stopped"
		res.FinishedAt = now
		if ev.Reason != "" {
			res.Error = redactRehearsalExecOutput(ev.Reason)
		}
	case "blocked":
		res.State = "blocked"
		res.FinishedAt = now
		res.Error = redactRehearsalExecOutput(ev.Reason)
	case "unknown":
		res.State = "unknown"
		res.FinishedAt = now
		res.Error = redactRehearsalExecOutput(ev.Reason)
	default:
		return rehearsalExecTask{}, errors.New("未知的事件类型：" + ev.Kind)
	}

	rebuildCombinedTaskOutput(&t)
	t.UpdatedAt = executionNow()

	// Recompute overall task state once all targets reach terminal states
	allDone := true
	anyFailed := false
	anyStopped := false
	anyUnknown := false
	anyBlocked := false
	for _, rItem := range t.Results {
		if !rehearsalTargetTerminal(rItem.State) {
			allDone = false
			break
		}
		switch rItem.State {
		case "failed":
			anyFailed = true
		case "stopped":
			anyStopped = true
		case "unknown":
			anyUnknown = true
		case "blocked":
			anyBlocked = true
		}
	}
	if allDone {
		t.FinishedAt = t.UpdatedAt
		switch {
		case anyBlocked:
			t.State = "blocked"
		case anyUnknown:
			t.State = "unknown"
		case anyFailed:
			t.State = "failed"
		case anyStopped:
			t.State = "stopped"
		default:
			t.State = "succeeded"
		}
	}
	if err := s.saveRehearsalExecTask(t); err != nil {
		return rehearsalExecTask{}, err
	}
	if allDone && t.Kind == "connectivity_check" {
		cfg := s.loadClusterAutomationConfig(t.ClusterID)
		cfg.LastCheckState = t.State
		cfg.LastCheckAt = t.FinishedAt
		cfg.LastCheckSig = automationChannelSig(t.Transport, t.NodeID, t.NodeExecMethod, t.SSHUser, t.SSHPort)
		_ = s.saveClusterAutomationConfig(cfg)
	}
	return t, nil
}

package server

import (
	"errors"
	"golang.org/x/crypto/ssh"
	"math"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

type agentHostProbe struct {
	Hostname    string  `json:"hostname,omitempty"`
	OS          string  `json:"os,omitempty"`
	Kernel      string  `json:"kernel,omitempty"`
	Arch        string  `json:"arch,omitempty"`
	CPUCores    int     `json:"cpu_cores,omitempty"`
	Load1       float64 `json:"load1,omitempty"`
	Load5       float64 `json:"load5,omitempty"`
	MemTotalMB  uint64  `json:"mem_total_mb,omitempty"`
	MemUsedPct  float64 `json:"mem_used_pct,omitempty"`
	DiskTotalGB float64 `json:"disk_total_gb,omitempty"`
	DiskUsedPct float64 `json:"disk_used_pct,omitempty"`
	UptimeSec   uint64  `json:"uptime_sec,omitempty"`
	IntervalSec int     `json:"interval_sec,omitempty"`
}

func roundProbeMetric(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return 0
	}
	return math.Round(v*10) / 10
}

// collectAgentHostProbe gathers lightweight real-time host telemetry purely via
// Go runtime, /proc, and Statfs with zero subprocess execution.
func collectAgentHostProbe(intervalSec int) *agentHostProbe {
	p := &agentHostProbe{
		Arch:        runtime.GOARCH,
		CPUCores:    runtime.NumCPU(),
		IntervalSec: intervalSec,
	}
	if hn, err := os.Hostname(); err == nil {
		p.Hostname = truncRunes(strings.TrimSpace(hn), 80)
	}
	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				val := strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"'`)
				p.OS = truncRunes(strings.TrimSpace(val), 80)
				break
			}
		}
	}
	if p.OS == "" {
		p.OS = runtime.GOOS + "/" + runtime.GOARCH
	}
	if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		p.Kernel = truncRunes(strings.TrimSpace(string(b)), 64)
	}
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(b))
		if len(fields) >= 2 {
			if v1, e1 := strconv.ParseFloat(fields[0], 64); e1 == nil {
				p.Load1 = math.Round(v1*100) / 100
			}
			if v5, e5 := strconv.ParseFloat(fields[1], 64); e5 == nil {
				p.Load5 = math.Round(v5*100) / 100
			}
		}
	}
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		var totalKB, availKB, freeKB, bufKB, cacheKB uint64
		var hasAvail bool
		for _, line := range strings.Split(string(b), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			val, err := strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				continue
			}
			switch fields[0] {
			case "MemTotal:":
				totalKB = val
			case "MemAvailable:":
				availKB = val
				hasAvail = true
			case "MemFree:":
				freeKB = val
			case "Buffers:":
				bufKB = val
			case "Cached:":
				cacheKB = val
			}
		}
		if totalKB > 0 {
			p.MemTotalMB = totalKB / 1024
			if !hasAvail {
				availKB = freeKB + bufKB + cacheKB
			}
			if availKB < totalKB {
				p.MemUsedPct = roundProbeMetric((float64(totalKB-availKB) / float64(totalKB)) * 100)
			}
		}
	}
	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(b))
		if len(fields) >= 1 {
			if up, err := strconv.ParseFloat(fields[0], 64); err == nil && up > 0 {
				p.UptimeSec = uint64(up)
			}
		}
	}
	if totGB, usedPct := diskStatFS("/"); totGB > 0 {
		p.DiskTotalGB = roundProbeMetric(totGB)
		p.DiskUsedPct = roundProbeMetric(usedPct)
	}
	return p
}

func sanitizeAgentHostProbe(in *agentHostProbe) *agentHostProbe {
	if in == nil {
		return nil
	}
	out := &agentHostProbe{
		Hostname:    truncRunes(strings.TrimSpace(in.Hostname), 80),
		OS:          truncRunes(strings.TrimSpace(in.OS), 80),
		Kernel:      truncRunes(strings.TrimSpace(in.Kernel), 64),
		Arch:        truncRunes(strings.TrimSpace(in.Arch), 24),
		CPUCores:    in.CPUCores,
		Load1:       math.Round(math.Max(0, math.Min(in.Load1, 9999))*100) / 100,
		Load5:       math.Round(math.Max(0, math.Min(in.Load5, 9999))*100) / 100,
		MemTotalMB:  in.MemTotalMB,
		MemUsedPct:  roundProbeMetric(math.Min(in.MemUsedPct, 100)),
		DiskTotalGB: roundProbeMetric(math.Min(in.DiskTotalGB, 1_000_000)),
		DiskUsedPct: roundProbeMetric(math.Min(in.DiskUsedPct, 100)),
		UptimeSec:   in.UptimeSec,
		IntervalSec: in.IntervalSec,
	}
	if out.CPUCores < 0 || out.CPUCores > 4096 {
		out.CPUCores = 0
	}
	if out.IntervalSec < 0 || out.IntervalSec > 3600 {
		out.IntervalSec = 0
	}
	return out
}

type agentHeartbeatSample struct {
	At      string   `json:"at"`
	Load1   *float64 `json:"load1,omitempty"`
	MemPct  *float64 `json:"mem_pct,omitempty"`
	DiskPct *float64 `json:"disk_pct,omitempty"`
}

func appendAgentHeartbeat(prev []agentHeartbeatSample, at string, probe *agentHostProbe) []agentHeartbeatSample {
	if strings.TrimSpace(at) == "" {
		return prev
	}
	sample := agentHeartbeatSample{At: at}
	if probe != nil {
		if probe.CPUCores > 0 || probe.Load1 > 0 {
			v := probe.Load1
			sample.Load1 = &v
		}
		if probe.MemTotalMB > 0 || probe.MemUsedPct > 0 {
			v := probe.MemUsedPct
			sample.MemPct = &v
		}
		if probe.DiskTotalGB > 0 || probe.DiskUsedPct > 0 {
			v := probe.DiskUsedPct
			sample.DiskPct = &v
		}
	}
	minuteKey := func(ts string) string {
		if len(ts) >= 16 {
			return ts[:16]
		}
		return ts
	}
	mk := minuteKey(at)
	out := append([]agentHeartbeatSample(nil), prev...)
	if n := len(out); n > 0 && minuteKey(out[n-1].At) == mk {
		out[n-1] = sample
	} else {
		out = append(out, sample)
	}
	const maxSamples = 90
	if len(out) > maxSamples {
		out = out[len(out)-maxSamples:]
	}
	return out
}

// A target identity is deliberately scoped to explicitly authorized cluster(s) or a delivery/executor.
// No silent machine matching by IP alone, shared enrollment token, or arbitrary commands.
type targetAgent struct {
	ID             string                 `json:"id"`
	Job            string                 `json:"job,omitempty"`
	Cluster        string                 `json:"cluster,omitempty"`
	Clusters       []string               `json:"clusters,omitempty"`
	ClusterModes   map[string]string      `json:"cluster_modes,omitempty"`
	Node           string                 `json:"node,omitempty"`
	Mode           string                 `json:"mode,omitempty"` // "" / "ssh_trust" | "direct" (direct execution without SSH/control host)
	Disabled       bool                   `json:"disabled,omitempty"`
	AllowMutating  bool                   `json:"allow_mutating,omitempty"`
	Capabilities   []string               `json:"capabilities,omitempty"`
	Host           string                 `json:"host"`
	IP             string                 `json:"ip"`
	Created        string                 `json:"created"`
	Expires        string                 `json:"expires"`
	EnrollmentHash string                 `json:"enrollment_hash,omitempty"`
	TokenHash      string                 `json:"token_hash,omitempty"`
	MachineID      string                 `json:"machine_id,omitempty"`
	LastSeen       string                 `json:"last_seen,omitempty"`
	Version        string                 `json:"version,omitempty"`
	Desired        string                 `json:"desired"`
	Applied        string                 `json:"applied,omitempty"`
	PublicKey      string                 `json:"public_key,omitempty"`
	HostKeys       []string               `json:"host_keys,omitempty"`
	Message        string                 `json:"message,omitempty"`
	Probe          *agentHostProbe        `json:"probe,omitempty"`
	Heartbeats     []agentHeartbeatSample `json:"heartbeats,omitempty"`
}

func targetAgentClusters(a targetAgent) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(cid string) {
		cid = strings.TrimSpace(cid)
		if cid == "" || seen[cid] {
			return
		}
		seen[cid] = true
		out = append(out, cid)
	}
	for _, cid := range a.Clusters {
		add(cid)
	}
	for cid := range a.ClusterModes {
		add(cid)
	}
	if a.Cluster != "" {
		add(a.Cluster)
	}
	if len(out) == 0 {
		return nil
	}
	sort.Strings(out)
	return out
}

func targetAgentAllowsCluster(a targetAgent, clusterID string) bool {
	cid := strings.TrimSpace(clusterID)
	if cid == "" {
		return false
	}
	return contains(targetAgentClusters(a), cid)
}

func publicTargetAgent(a targetAgent) targetAgent {
	a.EnrollmentHash = ""
	a.TokenHash = ""
	a.MachineID = ""
	return a
}
func normalizedPublicKey(raw string) (string, error) {
	pub, _, options, rest, e := ssh.ParseAuthorizedKey([]byte(raw))
	if e != nil || len(options) > 0 || len(strings.TrimSpace(string(rest))) > 0 {
		return "", errors.New("SSH 公钥格式无效或包含未允许的选项")
	}
	if pub.Type() != ssh.KeyAlgoED25519 {
		return "", errors.New("托管 SSH 信任使用 Ed25519 公钥")
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub))), nil
}
func (s *storeServer) handleTargetAgents(w http.ResponseWriter, r *http.Request, session storeSession, j storeJob, parts []string, d *executionDB) bool {
	if len(parts) != 1 || parts[0] != "agents" {
		return false
	}
	if r.Method == "GET" {
		lang := wLang(w)
		out := []targetAgent{}
		for _, a := range d.Agents {
			if a.Job == j.ID {
				out = append(out, localizeTargetAgent(lang, publicTargetAgent(a)))
			}
		}
		sort.Slice(out, func(i, k int) bool { return out[i].Created > out[k].Created })
		s.writeJSON(w, 200, out)
		return true
	}
	if !s.can(session.User, "execution.manage") {
		s.fail(w, 403, "接入与撤销机器信任需要执行节点管理权限")
		return true
	}
	if d.Agents == nil {
		d.Agents = map[string]targetAgent{}
	}
	var req struct {
		Node   string `json:"node"`
		Host   string `json:"host"`
		ID     string `json:"id"`
		Action string `json:"action"`
	}
	if decodeBody(w, r, 4096, &req) != nil {
		s.fail(w, 400, "请求无效")
		return true
	}
	if r.Method == "PATCH" {
		a, ok := d.Agents[req.ID]
		if !ok || a.Job != j.ID {
			s.fail(w, 404, "目标 Agent 不存在")
			return true
		}
		if req.Action != "revoke" {
			s.fail(w, 400, "只支持撤销本次托管信任")
			return true
		}
		if a.Desired == "revoked" {
			s.writeJSON(w, 200, publicTargetAgent(a))
			return true
		}
		for _, run := range d.Runs {
			if run.Node == a.Node && run.Cluster == a.Cluster && activeExecution(run) {
				s.fail(w, 409, "该集群仍有执行批次，请先暂停并处理现场任务")
				return true
			}
		}
		a.Desired = "revoked"
		a.Applied = ""
		a.EnrollmentHash = ""
		a.Message = "等待目标 Agent 移除托管公钥；现存会话需现场核实"
		if a.TokenHash == "" {
			a.Applied = "revoked"
			a.Message = "接入配置已取消，目标尚未注册，未写入托管公钥"
		}
		d.Agents[a.ID] = a
		invalidateExecutionPreparations(d, a.Node, a.Job)
		if s.saveExecutions(*d) != nil {
			s.fail(w, 500, "保存失败")
			return true
		}
		s.auditReq(r, "target-agent-revoke", session.User, a.ID)
		s.writeJSON(w, 200, localizeTargetAgent(wLang(w), publicTargetAgent(a)))
		return true
	}
	if r.Method != "POST" {
		s.fail(w, 405, "方法不支持")
		return true
	}
	n, ok := d.Nodes[req.Node]
	snap := s.executionContext(j)
	if !ok || !executionNodeAllows(n, snap) {
		s.fail(w, 403, "请先授权执行节点操作本交付目标")
		return true
	}
	targetIP := ""
	for _, h := range snap.Hosts {
		if h.Name == req.Host {
			targetIP = h.IP
		}
	}
	if targetIP == "" || targetIP == snap.ControllerIP {
		s.fail(w, 400, "请选择本交付中的远程目标机器；执行机本身不需要配置 SSH 免密")
		return true
	}
	for _, a := range d.Agents {
		if a.Job == j.ID && a.Host == req.Host && (a.Desired != "revoked" || (a.TokenHash != "" && a.Applied != "revoked")) {
			expires, _ := time.Parse(time.RFC3339Nano, a.Expires)
			if a.TokenHash != "" || time.Now().Before(expires) {
				s.fail(w, 409, "该机器已有接入配置；请使用已下载的配置，或先撤销旧接入")
				return true
			}
		}
	}
	token := randomStoreToken(32)
	a := targetAgent{ID: randomStoreToken(12), Job: j.ID, Cluster: j.ClusterID, Node: n.ID, Host: req.Host, IP: targetIP, Created: executionNow(), Expires: time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339Nano), EnrollmentHash: digest([]byte(token)), Desired: "active", PublicKey: n.PublicKeys[j.ClusterID]}
	d.Agents[a.ID] = a
	invalidateExecutionPreparations(d, n.ID, j.ID)
	if s.saveExecutions(*d) != nil {
		s.fail(w, 500, "保存接入配置失败")
		return true
	}
	s.auditReq(r, "target-agent-enroll", session.User, a.ID+" "+j.ID+" "+a.Host)
	s.writeJSON(w, 201, map[string]any{"agent": publicTargetAgent(a), "enrollment_token": token})
	return true
}
func invalidateExecutionPreparations(d *executionDB, node, job string) {
	for id, p := range d.Preparations {
		if p.Node == node && p.Job == job {
			p.Invalidated = "目标接入或授权已改变，请重新检查"
			d.Preparations[id] = p
		}
	}
}
func (s *storeServer) handleExecutionTrustKey(w http.ResponseWriter, r *http.Request, d *executionDB, n executionNode) {
	var req struct {
		Preparation string `json:"preparation"`
		PublicKey   string `json:"public_key"`
	}
	if decodeBody(w, r, 8192, &req) != nil {
		s.fail(w, 400, "请求无效")
		return
	}
	p, ok := d.Preparations[req.Preparation]
	created, _ := time.Parse(time.RFC3339Nano, p.Created)
	if !ok || p.Node != n.ID || p.State != "pending" || p.Invalidated != "" || time.Since(created) > 10*time.Minute || p.NodeRevision != executionNodeRevision(n) || !executionNodeAllows(n, p.Snapshot) {
		s.fail(w, 403, "没有获准检查这份交付")
		return
	}
	pub, e := normalizedPublicKey(req.PublicKey)
	if e != nil {
		s.fail(w, 400, e.Error())
		return
	}
	if n.PublicKeys == nil {
		n.PublicKeys = map[string]string{}
	}
	if old := n.PublicKeys[p.Snapshot.Cluster]; old != "" && old != pub {
		s.fail(w, 409, "执行机密钥与已有托管信任不一致；请先撤销旧授权，不能覆盖现存身份")
		return
	}
	n.PublicKeys[p.Snapshot.Cluster] = pub
	d.Nodes[n.ID] = n
	agents := []targetAgent{}
	for id, a := range d.Agents {
		if a.Node == n.ID && a.Job == p.Job && a.Desired == "active" && p.Snapshot.AgentAccess[a.Host] == id {
			a.PublicKey = pub
			d.Agents[id] = a
			agents = append(agents, publicTargetAgent(a))
		}
	}
	if s.saveExecutions(*d) != nil {
		s.fail(w, 500, "保存公钥失败")
		return
	}
	s.writeJSON(w, 200, map[string]any{"agents": agents})
}
func (s *storeServer) handleTargetAgent(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		s.fail(w, 405, "方法不支持")
		return
	}
	auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if len(auth) < 40 {
		s.fail(w, 401, "目标 Agent 认证失败")
		return
	}
	executionMu.Lock()
	defer executionMu.Unlock()
	d, e := s.readExecutions()
	if e != nil {
		s.fail(w, 500, e.Error())
		return
	}
	if r.URL.Path == "/api/target-agent/enroll" {
		var req struct {
			ID        string   `json:"id"`
			MachineID string   `json:"machine_id"`
			Hostname  string   `json:"hostname"`
			IPs       []string `json:"ips"`
			Token     string   `json:"token"`
		}
		if decodeBody(w, r, 8192, &req) != nil || len(req.MachineID) != 64 || len(req.Token) < 40 {
			s.fail(w, 400, "接入身份无效")
			return
		}
		a, ok := d.Agents[req.ID]
		n := d.Nodes[a.Node]
		expires, _ := time.Parse(time.RFC3339Nano, a.Expires)
		if !ok || a.Desired != "active" || !time.Now().Before(expires) || !constantStoreEqual(a.EnrollmentHash, digest([]byte(auth))) {
			s.fail(w, 401, "接入配置已失效，请重新获取")
			return
		}
		if a.Mode != "direct" {
			if n.Disabled || !targetAgentInScope(a, n) {
				s.fail(w, 403, "执行机或目标授权已失效，请重新登记")
				return
			}
			if req.Hostname != a.Host || !contains(req.IPs, a.IP) {
				s.fail(w, 409, "机器名称或地址与接入配置不符；请核对目标机器，不能将配置用于其他机器")
				return
			}
		} else {
			if !contains(req.IPs, a.IP) {
				s.fail(w, 409, "目标机器 IP 地址与直连 Agent 配置不符，请确认是否在目标机上启动")
				return
			}
		}
		if a.MachineID != "" && (a.MachineID != req.MachineID || a.TokenHash != digest([]byte(req.Token))) {
			s.fail(w, 409, "该接入配置已绑定其他 Agent 身份")
			return
		}
		a.MachineID = req.MachineID
		a.TokenHash = digest([]byte(req.Token))
		a.LastSeen = executionNow()
		if a.Mode == "direct" {
			a.Applied = "active"
		}
		d.Agents[a.ID] = a
		if s.saveExecutions(d) != nil {
			s.fail(w, 500, "登记未保存，请重试")
			return
		}
		s.writeJSON(w, 200, map[string]bool{"ack": true})
		return
	}
	var a targetAgent
	for _, v := range d.Agents {
		if v.TokenHash != "" && constantStoreEqual(v.TokenHash, digest([]byte(auth))) {
			a = v
			break
		}
	}
	if a.ID == "" {
		s.fail(w, 401, "目标 Agent 认证失败")
		return
	}
	if r.URL.Path == "/api/target-agent/event" {
		var req struct {
			MachineID string             `json:"machine_id"`
			Event     rehearsalExecEvent `json:"event"`
		}
		if decodeBody(w, r, 65536, &req) != nil || req.MachineID != a.MachineID || !executionID.MatchString(req.Event.TaskID) {
			s.fail(w, 403, "目标 Agent 事件身份校验失败")
			return
		}
		a.LastSeen = executionNow()
		d.Agents[a.ID] = a
		_ = s.saveExecutions(d)
		task, err := s.applyRehearsalExecEvent("agent", a.ID, req.Event)
		if err != nil {
			s.fail(w, 409, err.Error())
			return
		}
		s.writeJSON(w, 200, map[string]any{"ack": req.Event.Seq, "state": task.State, "cancel": task.Cancel})
		return
	}
	var req struct {
		MachineID    string          `json:"machine_id"`
		Version      string          `json:"version"`
		Applied      string          `json:"applied"`
		PublicKey    string          `json:"public_key"`
		HostKeys     []string        `json:"host_keys"`
		Message      string          `json:"message"`
		Heartbeat    bool            `json:"heartbeat"`
		Capabilities []string        `json:"capabilities"`
		Probe        *agentHostProbe `json:"probe"`
	}
	if decodeBody(w, r, 32768, &req) != nil || req.MachineID != a.MachineID {
		s.fail(w, 403, "目标 Agent 身份不符")
		return
	}
	if r.URL.Path != "/api/target-agent/poll" {
		s.fail(w, 404, "接口不存在")
		return
	}
	if len(req.HostKeys) > 8 || len(req.Message) > 2000 {
		s.fail(w, 400, "回传内容过大")
		return
	}
	for _, k := range req.HostKeys {
		if _, _, opts, rest, e := ssh.ParseAuthorizedKey([]byte(k)); e != nil || len(opts) > 0 || len(strings.TrimSpace(string(rest))) > 0 {
			s.fail(w, 400, "SSH 主机公钥无效")
			return
		}
	}
	a.LastSeen = executionNow()
	if p := sanitizeAgentHostProbe(req.Probe); p != nil {
		a.Probe = p
	}
	a.Heartbeats = appendAgentHeartbeat(a.Heartbeats, a.LastSeen, a.Probe)
	n := d.Nodes[a.Node]
	if a.Mode != "direct" {
		if a.Desired == "active" && !targetAgentInScope(a, n) {
			a.Desired = "revoked"
			a.Applied = ""
			invalidateExecutionPreparations(&d, a.Node, a.Job)
		}
	}
	a.Version = truncRunes(req.Version, 80)
	if len(req.Capabilities) > 0 && len(req.Capabilities) <= 8 {
		a.Capabilities = req.Capabilities
	}
	if !req.Heartbeat {
		a.Message = req.Message
		if a.Mode == "direct" {
			if a.Desired == "active" {
				a.Applied = "active"
			} else {
				a.Applied = "revoked"
			}
			if len(req.HostKeys) > 0 {
				a.HostKeys = req.HostKeys
			}
		} else if (req.Applied == "active" && a.Desired == "active" && req.PublicKey == a.PublicKey && a.PublicKey != "") || (req.Applied == "revoked" && a.Desired == "revoked") {
			a.Applied = req.Applied
			a.HostKeys = req.HostKeys
		} else {
			a.Applied = ""
		}
	}
	d.Agents[a.ID] = a
	if s.saveExecutions(d) != nil {
		s.fail(w, 500, "回传未保存")
		return
	}
	if a.Mode != "direct" && n.Disabled && a.Desired == "active" {
		s.writeJSON(w, 200, map[string]any{"id": a.ID, "desired": "paused"})
		return
	}
	task, cancelTask := s.pollRehearsalTaskForAgent(a, req.Heartbeat)
	resp := map[string]any{
		"id":         a.ID,
		"mode":       a.Mode,
		"desired":    a.Desired,
		"public_key": a.PublicKey,
		"source_ip":  n.ControllerIP,
	}
	if task != nil {
		resp["task"] = task
	}
	if cancelTask != "" {
		resp["cancel_task"] = cancelTask
	}
	s.writeJSON(w, 200, resp)
}

func targetAgentInScope(a targetAgent, n executionNode) bool {
	if a.Mode == "direct" {
		return !a.Disabled && a.Desired == "active"
	}
	if n.ID == "" || !contains(n.Clusters, a.Cluster) || a.IP == n.ControllerIP {
		return false
	}
	ips := n.IPs
	if n.Kind != "" {
		ips = n.Grants[a.Cluster]
	}
	return contains(ips, a.IP)
}

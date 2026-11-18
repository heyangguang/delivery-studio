package main

import (
	"errors"
	"golang.org/x/crypto/ssh"
	"net/http"
	"sort"
	"strings"
	"time"
)

// A target identity is deliberately scoped to a delivery and an executor. No
// machine matching by IP alone, shared enrollment token, or arbitrary commands.
type targetAgent struct {
	ID             string   `json:"id"`
	Job            string   `json:"job"`
	Cluster        string   `json:"cluster"`
	Node           string   `json:"node"`
	Host           string   `json:"host"`
	IP             string   `json:"ip"`
	Created        string   `json:"created"`
	Expires        string   `json:"expires"`
	EnrollmentHash string   `json:"enrollment_hash,omitempty"`
	TokenHash      string   `json:"token_hash,omitempty"`
	MachineID      string   `json:"machine_id,omitempty"`
	LastSeen       string   `json:"last_seen,omitempty"`
	Version        string   `json:"version,omitempty"`
	Desired        string   `json:"desired"`
	Applied        string   `json:"applied,omitempty"`
	PublicKey      string   `json:"public_key,omitempty"`
	HostKeys       []string `json:"host_keys,omitempty"`
	Message        string   `json:"message,omitempty"`
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
		out := []targetAgent{}
		for _, a := range d.Agents {
			if a.Job == j.ID {
				out = append(out, publicTargetAgent(a))
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
		s.writeJSON(w, 200, publicTargetAgent(a))
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
		if n.Disabled || !targetAgentInScope(a, n) {
			s.fail(w, 403, "执行机或目标授权已失效，请重新登记")
			return
		}
		if req.Hostname != a.Host || !contains(req.IPs, a.IP) {
			s.fail(w, 409, "机器名称或地址与接入配置不符；请核对目标机器，不能将配置用于其他机器")
			return
		}
		if a.MachineID != "" && (a.MachineID != req.MachineID || a.TokenHash != digest([]byte(req.Token))) {
			s.fail(w, 409, "该接入配置已绑定其他 Agent 身份")
			return
		}
		a.MachineID = req.MachineID
		a.TokenHash = digest([]byte(req.Token))
		a.LastSeen = executionNow()
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
	var req struct {
		MachineID string   `json:"machine_id"`
		Version   string   `json:"version"`
		Applied   string   `json:"applied"`
		PublicKey string   `json:"public_key"`
		HostKeys  []string `json:"host_keys"`
		Message   string   `json:"message"`
	}
	if decodeBody(w, r, 16384, &req) != nil || req.MachineID != a.MachineID {
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
	n := d.Nodes[a.Node]
	if a.Desired == "active" && !targetAgentInScope(a, n) {
		a.Desired = "revoked"
		a.Applied = ""
		invalidateExecutionPreparations(&d, a.Node, a.Job)
	}
	a.Version = truncRunes(req.Version, 80)
	a.Message = req.Message
	if (req.Applied == "active" && a.Desired == "active" && req.PublicKey == a.PublicKey && a.PublicKey != "") || (req.Applied == "revoked" && a.Desired == "revoked") {
		a.Applied = req.Applied
		a.HostKeys = req.HostKeys
	} else {
		a.Applied = ""
	}
	d.Agents[a.ID] = a
	if s.saveExecutions(d) != nil {
		s.fail(w, 500, "回传未保存")
		return
	}
	if n.Disabled && a.Desired == "active" {
		s.writeJSON(w, 200, map[string]any{"id": a.ID, "desired": "paused"})
		return
	}
	s.writeJSON(w, 200, map[string]any{"id": a.ID, "desired": a.Desired, "public_key": a.PublicKey, "source_ip": n.ControllerIP})
}

func targetAgentInScope(a targetAgent, n executionNode) bool {
	if n.ID == "" || !contains(n.Clusters, a.Cluster) || a.IP == n.ControllerIP {
		return false
	}
	ips := n.IPs
	if n.Kind != "" {
		ips = n.Grants[a.Cluster]
	}
	return contains(ips, a.IP)
}

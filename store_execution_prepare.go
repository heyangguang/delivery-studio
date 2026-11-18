package main

import (
	"encoding/json"
	"errors"
	"middleware-deployer/mwpack"
	"net/http"
	"os"
	"sort"
	"time"
)

type executionCheck struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Host    string `json:"host,omitempty"`
	State   string `json:"state"`
	Message string `json:"message"`
}
type executionPreparation struct {
	SnapshotHash string            `json:"snapshot_hash,omitempty"`
	Invalidated  string            `json:"invalidated,omitempty"`
	ID           string            `json:"id"`
	Job          string            `json:"job"`
	Node         string            `json:"node"`
	By           string            `json:"by"`
	Revision     string            `json:"revision"`
	NodeRevision string            `json:"node_revision"`
	Created      string            `json:"created"`
	Finished     string            `json:"finished,omitempty"`
	State        string            `json:"state"`
	Checks       []executionCheck  `json:"checks"`
	Snapshot     executionSnapshot `json:"snapshot,omitempty"`
}
type executionNodeOption struct {
	executionNode
	Authorized bool   `json:"authorized"`
	Compatible bool   `json:"compatible"`
	Reason     string `json:"reason,omitempty"`
}

func executionKind(s executionSnapshot) string {
	if s.ExecutionHost != nil {
		return "independent"
	}
	return "embedded"
}
func executionNodeRevision(n executionNode) string {
	b, _ := json.Marshal([]any{n.ID, n.Kind, n.ControllerIP, n.Grants, n.IPs, n.Clusters, n.Version, n.Protocol, n.TokenHash, n.Disabled})
	return digest(b)
}
func (s *storeServer) executionContext(j storeJob) executionSnapshot {
	c := executionSnapshot{Job: j.ID, Cluster: j.ClusterID}
	var p struct {
		Controller  string
		RuntimeRoot string `json:"runtime_root"`
	}
	_ = json.Unmarshal(s.jobPlan(j.ID), &p)
	c.RuntimeRoot = p.RuntimeRoot
	if d := s.readSpec(j.ID); d != nil {
		c.Hosts = append([]mwpack.Host{}, d.Hosts...)
		c.Platform = d.Platform
		c.ExecutionHost = d.ExecutionHost
		for _, h := range c.Hosts {
			if h.Name == p.Controller {
				c.ControllerIP = h.IP
			}
		}
		if d.ExecutionHost != nil {
			c.ControllerIP = d.ExecutionHost.IP
		}
	}
	return c
}
func executionNodeOptionFor(n executionNode, c executionSnapshot) executionNodeOption {
	o := executionNodeOption{executionNode: publicExecutionNode(n), Authorized: executionNodeAllows(n, c), Compatible: true}
	if n.Disabled {
		o.Compatible = false
		o.Reason = "执行节点已暂停接单"
	} else if n.ControllerIP != c.ControllerIP {
		o.Compatible = false
		o.Reason = "执行机器与本交付记录不一致"
	} else if (c.ExecutionHost != nil && n.Kind != "independent") || (c.ExecutionHost == nil && n.Kind == "independent") {
		o.Compatible = false
		o.Reason = "执行机安装位置与本交付不一致"
	} else if n.Kind != "" && n.Protocol < 2 && n.LastSeen != "" {
		o.Compatible = false
		o.Reason = "请更新执行器，以支持准备检查"
	} else if !o.Authorized {
		o.Reason = "需要管理员授权本交付的目标机器"
	}
	return o
}
func validateExecutionPreparation(p executionPreparation, n executionNode, snap executionSnapshot, rev string) error {
	if n.Protocol < 2 {
		return errors.New("请先连接支持准备检查的新版执行器")
	}
	if p.ID == "" || p.Node != n.ID || p.Job != snap.Job || p.State != "ready" || p.Invalidated != "" {
		return errors.New("请先完成执行准备检查")
	}
	if p.Revision != rev || p.NodeRevision != executionNodeRevision(n) {
		return errors.New("交付或执行节点已变化，请重新检查")
	}
	t, e := time.Parse(time.RFC3339Nano, p.Finished)
	if e != nil || time.Since(t) > 10*time.Minute {
		return errors.New("准备检查已超过 10 分钟，请重新检查")
	}
	b, _ := json.Marshal(snap)
	want := p.SnapshotHash
	if want == "" {
		a, _ := json.Marshal(p.Snapshot)
		want = digest(a)
	}
	if want != digest(b) {
		return errors.New("执行材料已变化，请重新检查")
	}
	return nil
}
func (s *storeServer) handleExecutionPreparation(w http.ResponseWriter, r *http.Request, session storeSession, j storeJob, parts []string, d *executionDB) bool {
	if len(parts) != 1 || (parts[0] != "prepare" && parts[0] != "authorize") {
		return false
	}
	if r.Method != "POST" {
		s.fail(w, 405, "方法不支持")
		return true
	}
	var req struct {
		Node     string `json:"node"`
		Revision string `json:"revision"`
	}
	if decodeBody(w, r, 4096, &req) != nil {
		s.fail(w, 400, "请求无效")
		return true
	}
	n, ok := d.Nodes[req.Node]
	if !ok {
		s.fail(w, 404, "执行节点不存在")
		return true
	}
	if j.State != "succeeded" || j.Outcome == "void" || j.RevisedBy != "" || req.Revision != s.executionRevision(j.ID) {
		s.fail(w, 409, "交付已变化或不可执行，请刷新后重试")
		return true
	}
	context := s.executionContext(j)
	option := executionNodeOptionFor(n, context)
	if !option.Compatible {
		s.fail(w, 409, option.Reason)
		return true
	}
	if d.Preparations == nil {
		d.Preparations = map[string]executionPreparation{}
	}
	if parts[0] == "authorize" {
		if !s.can(session.User, "execution.manage") {
			s.fail(w, 403, "需要执行节点管理权限才能扩大授权")
			return true
		}
		if n.Kind == "" {
			s.fail(w, 409, "请使用新版节点接入，旧节点授权保持不变")
			return true
		}
		if e := context.ExecutionHost; e != nil {
			for _, other := range d.Nodes {
				if other.ControllerIP == n.ControllerIP {
					for cluster, port := range other.Repositories {
						if cluster != j.ClusterID && port == e.RepositoryPort {
							s.fail(w, 409, "这个执行机的软件源端口已用于集群 "+cluster+"，请在新交付中选择另一端口")
							return true
						}
					}
				}
			}
			if n.Repositories == nil {
				n.Repositories = map[string]int{}
			}
			n.Repositories[j.ClusterID] = e.RepositoryPort
		}
		for _, run := range d.Runs {
			if run.Node == n.ID && run.Cluster == j.ClusterID && activeExecution(run) {
				s.fail(w, 409, "请先处理该集群在此节点上的在途批次")
				return true
			}
		}
		if n.Grants == nil {
			n.Grants = map[string][]string{}
		}
		n.Grants[j.ClusterID] = []string{}
		for _, h := range context.Hosts {
			n.Grants[j.ClusterID] = append(n.Grants[j.ClusterID], h.IP)
		}
		n.Clusters = []string{}
		n.IPs = []string{}
		for cluster, ips := range n.Grants {
			n.Clusters = append(n.Clusters, cluster)
			for _, ip := range ips {
				if !contains(n.IPs, ip) {
					n.IPs = append(n.IPs, ip)
				}
			}
		}
		sort.Strings(n.Clusters)
		sort.Strings(n.IPs)
		d.Nodes[n.ID] = n
		if e := s.saveExecutions(*d); e != nil {
			s.fail(w, 500, "保存授权失败")
			return true
		}
		s.auditReq(r, "execution-node-authorize", session.User, n.ID+" "+j.ID)
		s.writeJSON(w, 200, localizeExecutionOption(wLang(w), executionNodeOptionFor(n, context)))
		return true
	}
	if !executionNodeAllows(n, context) {
		s.fail(w, 403, "执行节点尚未获准操作本交付的全部目标机器")
		return true
	}
	if !executionOnline(n) || n.Protocol < 2 {
		s.fail(w, 409, "请先连接新版执行器")
		return true
	}
	for id, p := range d.Preparations {
		if p.Job == j.ID && p.Node == n.ID && p.State == "pending" && p.Invalidated == "" && p.Revision == req.Revision && p.NodeRevision == executionNodeRevision(n) {
			created, _ := time.Parse(time.RFC3339Nano, p.Created)
			if time.Since(created) < 10*time.Minute {
				p.Snapshot = executionSnapshot{}
				s.writeJSON(w, 200, p)
				return true
			}
			p.State = "expired"
			d.Preparations[id] = p
		}
	}
	snap, e := s.executionSnapshotFor(j)
	if e != nil {
		s.fail(w, 409, e.Error())
		return true
	}
	bindExecutionAccess(&snap, *d, n.ID)
	if raw, _ := json.Marshal(snap); len(raw) > 48<<20 {
		s.fail(w, 409, "执行快照超过 48 MiB，请拆分交付")
		return true
	}
	p := executionPreparation{ID: randomStoreToken(12), Job: j.ID, Node: n.ID, By: session.User, Created: executionNow(), Revision: req.Revision, NodeRevision: executionNodeRevision(n), State: "pending", Checks: []executionCheck{}, Snapshot: snap}
	raw, _ := json.Marshal(snap)
	p.SnapshotHash = digest(raw)
	if e = atomicExecutionJSON(s.executionPath("preparations", p.ID+".json"), snap); e != nil {
		s.fail(w, 500, "保存检查材料失败")
		return true
	}
	// Heartbeats rewrite the small state document, never the project/certificate files.
	p.Snapshot.Files = nil
	d.Preparations[p.ID] = p
	if e = s.saveExecutions(*d); e != nil {
		s.fail(w, 500, "保存检查请求失败")
		return true
	}
	s.auditReq(r, "execution-prepare", session.User, j.ID+" "+p.ID)
	p.Snapshot = executionSnapshot{}
	s.writeJSON(w, 201, p)
	return true
}

func (s *storeServer) preparationSnapshot(p executionPreparation) (executionSnapshot, error) {
	if p.SnapshotHash == "" {
		return p.Snapshot, nil
	}
	var snap executionSnapshot
	b, e := os.ReadFile(s.executionPath("preparations", p.ID+".json"))
	if e != nil || digest(b) != p.SnapshotHash || json.Unmarshal(b, &snap) != nil {
		return snap, errors.New("准备检查材料损坏，请重新检查")
	}
	return snap, nil
}
func pendingExecutionPreparation(d executionDB, n executionNode) *executionPreparation {
	// Do not delay evidence reconciliation for already-started work.
	for _, run := range d.Runs {
		if run.Node == n.ID {
			for _, st := range run.Steps {
				if st.State == "leased" || st.State == "running" || st.State == "unknown" {
					return nil
				}
			}
		}
	}
	var found *executionPreparation
	for _, p := range d.Preparations {
		if p.Node != n.ID || p.State != "pending" || p.Invalidated != "" || p.NodeRevision != executionNodeRevision(n) || !executionNodeAllows(n, p.Snapshot) {
			continue
		}
		t, _ := time.Parse(time.RFC3339Nano, p.Created)
		if time.Since(t) > 10*time.Minute {
			continue
		}
		if found == nil || p.Created < found.Created {
			p := p
			found = &p
		}
	}
	return found
}
func executionCheckIDs(snap executionSnapshot) []string {
	ids := []string{"executor", "runtime", "materials"}
	for _, h := range snap.Hosts {
		ids = append(ids, "host:"+h.Name)
	}
	return ids
}
func (s *storeServer) handleExecutionPrepared(w http.ResponseWriter, r *http.Request, d *executionDB, n executionNode) {
	var req struct {
		ID     string           `json:"id"`
		Checks []executionCheck `json:"checks"`
	}
	if decodeBody(w, r, 65536, &req) != nil || len(req.Checks) > 203 {
		s.fail(w, 400, "检查结果无效")
		return
	}
	p, ok := d.Preparations[req.ID]
	if !ok || p.Node != n.ID {
		s.fail(w, 404, "检查请求不存在")
		return
	}
	if p.State != "pending" {
		a, _ := json.Marshal(req.Checks)
		b, _ := json.Marshal(p.Checks)
		if string(a) != string(b) {
			s.fail(w, 409, "不能覆盖已有检查结果")
			return
		}
		s.writeJSON(w, 200, map[string]bool{"ack": true})
		return
	}
	created, _ := time.Parse(time.RFC3339Nano, p.Created)
	if p.Invalidated != "" || p.NodeRevision != executionNodeRevision(n) || !executionNodeAllows(n, p.Snapshot) || time.Since(created) > 10*time.Minute {
		s.fail(w, 409, "节点授权或版本已变化，请重新检查")
		return
	}
	expected := executionCheckIDs(p.Snapshot)
	seen := map[string]bool{}
	ready := true
	for _, c := range req.Checks {
		if !contains(expected, c.ID) || seen[c.ID] || len(c.Message) > 2000 || len(c.Title) > 100 || (c.State != "passed" && c.State != "blocked") {
			s.fail(w, 400, "检查条目、状态或长度不符合契约")
			return
		}
		seen[c.ID] = true
		ready = ready && c.State == "passed"
	}
	if len(seen) != len(expected) {
		s.fail(w, 400, "缺少执行机、运行环境、材料或目标机器的检查结果")
		return
	}
	p.Checks = req.Checks
	p.Finished = executionNow()
	p.State = "blocked"
	if ready {
		p.State = "ready"
	}
	d.Preparations[p.ID] = p
	if e := s.saveExecutions(*d); e != nil {
		s.fail(w, 500, "检查结果尚未保存，请重传")
		return
	}
	s.writeJSON(w, 200, map[string]bool{"ack": true})
}

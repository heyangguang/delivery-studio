package main

// Execution is a durable pull protocol, not a web-worker goroutine. The runner
// owns the process. A lease is never re-assigned, even after heartbeat loss.
import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"middleware-deployer/mwpack"
)

var executionID = regexp.MustCompile(`^[a-zA-Z0-9_-]{8,80}$`)

var executionMu sync.Mutex // short transactions over the execution store
var executionJobLocks sync.Map

// Expensive generation/sync of one delivery must not hold up other nodes' heartbeats.
func (s *storeServer) lockExecutionJob(job string) func() {
	key := filepath.Join(s.cfg.DataDir, job)
	lock, _ := executionJobLocks.LoadOrStore(key, &sync.Mutex{})
	m := lock.(*sync.Mutex)
	m.Lock()
	return m.Unlock
}

type executionNode struct {
	Repositories map[string]int      `json:"repositories,omitempty"`
	PublicKeys   map[string]string   `json:"public_keys,omitempty"`
	Kind         string              `json:"kind,omitempty"`
	Protocol     int                 `json:"protocol,omitempty"`
	Grants       map[string][]string `json:"grants,omitempty"`
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	Clusters     []string            `json:"clusters"`
	IPs          []string            `json:"ips"`
	ControllerIP string              `json:"controller_ip"`
	TokenHash    string              `json:"token_hash,omitempty"`
	LastSeen     string              `json:"last_seen,omitempty"`
	Version      string              `json:"version,omitempty"`
	Disabled     bool                `json:"disabled"`
}
type executionStep struct {
	ID        string         `json:"id"`
	Key       string         `json:"key"`
	Title     string         `json:"title"`
	Effect    string         `json:"effect"`
	Hosts     []string       `json:"hosts"`
	Playbook  string         `json:"playbook"`
	Timeout   int            `json:"timeout"`
	ExtraVars map[string]any `json:"extra_vars"`
	State     string         `json:"state"`
	Seq       int            `json:"seq"`
	Started   string         `json:"started,omitempty"`
	Finished  string         `json:"finished,omitempty"`
	Message   string         `json:"message,omitempty"`
	ExitCode  *int           `json:"exit_code,omitempty"`
	Recap     []logRecap     `json:"recap,omitempty"`
	Runtime   string         `json:"runtime,omitempty"`
	Returned  string         `json:"returned,omitempty"`
}
type executionRun struct {
	ExecutorName string          `json:"executor_name,omitempty"`
	AccessMode   string          `json:"access_mode,omitempty"`
	Preparation  string          `json:"preparation,omitempty"`
	ExecutorKind string          `json:"executor_kind,omitempty"`
	ExecutorIP   string          `json:"executor_ip,omitempty"`
	ID           string          `json:"id"`
	Request      string          `json:"request"`
	Job          string          `json:"job"`
	Cluster      string          `json:"cluster"`
	Node         string          `json:"node"`
	By           string          `json:"by"`
	Created      string          `json:"created"`
	Updated      string          `json:"updated"`
	State        string          `json:"state"`
	Pause        bool            `json:"pause"`
	Snapshot     string          `json:"snapshot"`
	Revision     string          `json:"revision"`
	Resources    []string        `json:"resources"`
	Steps        []executionStep `json:"steps"`
	Note         string          `json:"note,omitempty"`
}
type executionDB struct {
	Agents       map[string]targetAgent          `json:"agents,omitempty"`
	Preparations map[string]executionPreparation `json:"preparations,omitempty"`
	Nodes        map[string]executionNode        `json:"nodes"`
	Runs         map[string]executionRun         `json:"runs"`
}
type executionSnapshot struct {
	RuntimeRoot   string                `json:"runtime_root,omitempty"`
	AgentIdentity map[string]string     `json:"agent_identity,omitempty"`
	AgentAccess   map[string]string     `json:"agent_access,omitempty"`
	Platform      string                `json:"platform,omitempty"`
	ExecutionHost *mwpack.ExecutionHost `json:"execution_host,omitempty"`
	Schema        string                `json:"schema"`
	Job           string                `json:"job"`
	Cluster       string                `json:"cluster"`
	ControllerIP  string                `json:"controller_ip"`
	Project       string                `json:"project"`
	Hosts         []mwpack.Host         `json:"hosts"`
	Files         map[string][]byte     `json:"files"`
	RuntimeFiles  map[string]string     `json:"runtime_files,omitempty"`
}
type executionWork struct {
	Run      executionRun      `json:"run"`
	Step     executionStep     `json:"step"`
	Snapshot executionSnapshot `json:"snapshot"`
}
type executionEvent struct {
	Run      string `json:"run"`
	Attempt  string `json:"attempt"`
	Seq      int    `json:"seq"`
	Kind     string `json:"kind"` // started, log, finished, unknown, stopped
	At       string `json:"at"`
	Text     string `json:"text,omitempty"` // callback output; never raw command stdout
	ExitCode *int   `json:"exit_code,omitempty"`
	Reason   string `json:"reason,omitempty"`
}
type executionChoice struct {
	Key       string   `json:"key"`
	Title     string   `json:"title"`
	Phase     string   `json:"phase"`
	Effect    string   `json:"effect"`
	Hosts     []string `json:"hosts"`
	Available bool     `json:"available"`
	Reason    string   `json:"reason,omitempty"`
	State     string   `json:"state,omitempty"`
}

func executionNow() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func atomicExecutionJSON(p string, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(p), ".write-")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(tmp, p); e != nil {
		return e
	}
	// Windows cannot fsync a directory handle (NTFS journals the rename itself), so the
	// directory flush is only performed where the platform supports it.
	if runtime.GOOS == "windows" {
		return nil
	}
	d, e := os.Open(filepath.Dir(p))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func (s *storeServer) executionPath(parts ...string) string {
	return filepath.Join(append([]string{s.cfg.DataDir, "execution"}, parts...)...)
}
func (s *storeServer) readExecutions() (executionDB, error) {
	d := executionDB{Nodes: map[string]executionNode{}, Runs: map[string]executionRun{}, Preparations: map[string]executionPreparation{}}
	b, e := os.ReadFile(s.executionPath("state.json"))
	if os.IsNotExist(e) {
		return d, nil
	}
	if e != nil {
		return d, e
	}
	e = json.Unmarshal(b, &d)
	if d.Nodes == nil || d.Runs == nil {
		return d, errors.New("执行状态损坏，已停止接收任务")
	}
	return d, e
}
func (s *storeServer) saveExecutions(d executionDB) error {
	return atomicExecutionJSON(s.executionPath("state.json"), d)
}
func activeExecution(r executionRun) bool {
	return r.State != "completed" && r.State != "failed" && r.State != "closed"
}
func (s *storeServer) executionLocked(job string) bool {
	d, e := s.readExecutions()
	if e != nil {
		return true
	}
	for _, r := range d.Runs {
		if r.Job == job && activeExecution(r) {
			return true
		}
	}
	return false
}
func executionOnline(n executionNode) bool {
	t, e := time.Parse(time.RFC3339Nano, n.LastSeen)
	return e == nil && !n.Disabled && time.Since(t) < 35*time.Second
}
func publicExecutionNode(n executionNode) executionNode { n.TokenHash = ""; return n }
func (s *storeServer) executionRevision(job string) string {
	b, _ := json.Marshal(s.loadAmendments(job))
	return digest(append(s.jobPlan(job), b...))
}
func (s *storeServer) executionChoices(job string) []executionChoice {
	return s.executionChoicesLang(job, "")
}
func (s *storeServer) executionChoicesLang(job, lang string) []executionChoice {
	var out []executionChoice
	prog := s.readProgress(job)
	for _, tab := range s.runbookStepsLang(job, lang) {
		for _, st := range tab.Steps {
			c := executionChoice{Key: st.Key, Title: st.Title, Phase: tab.Label, Effect: st.Effect, Hosts: st.Hosts, State: prog.Steps[st.Key].State}
			switch {
			case st.Manual || st.Playbook == "" || st.Amended != "":
				c.Reason = "需要人工操作或确认"
			case len(st.Parts) != 1:
				c.Reason = "旧版阶段手册；请先生成独立步骤的交付"
			case !st.Parts[0].Automatic:
				c.Reason = "这个版本尚未发布自动执行能力"
			case st.Parts[0].Timeout < 1:
				c.Reason = "步骤没有设置执行超时"
			default:
				c.Available = true
			}
			out = append(out, c)
		}
	}
	return out
}
func (s *storeServer) executionSnapshotFor(j storeJob) (executionSnapshot, error) {
	var p struct {
		RuntimeRoot string `json:"runtime_root"`
		Project     string `json:"project"`
		Controller  string `json:"controller"`
		Platform    string `json:"platform"`
	}
	if json.Unmarshal(s.jobPlan(j.ID), &p) != nil || !safeName(p.Project) {
		return executionSnapshot{}, errors.New("缺少有效的项目快照")
	}
	d := s.readSpec(j.ID)
	if d == nil {
		return executionSnapshot{}, errors.New("交付规格不可读")
	}
	snap := executionSnapshot{Schema: "mwexecution/v1", Job: j.ID, Cluster: j.ClusterID, Project: p.Project, Hosts: d.Hosts, Platform: d.Platform}
	if p.Platform != "" {
		snap.Platform = p.Platform
	}
	for _, h := range snap.Hosts {
		if h.Name == p.Controller {
			snap.ControllerIP = h.IP
		}
	}
	if d.ExecutionHost != nil {
		snap.ExecutionHost = d.ExecutionHost
		snap.RuntimeRoot = p.RuntimeRoot
		snap.ControllerIP = d.ExecutionHost.IP
	}
	var e error
	snap.Files, e = s.projectFiles(j.ID)
	if e != nil {
		return snap, e
	}
	for path := range snap.Files {
		if !executionRelative(path) || strings.HasPrefix(path, "secrets/") || strings.HasPrefix(path, "logs/") {
			delete(snap.Files, path)
		}
	}
	if len(snap.Files["inventory/hosts.yml"]) == 0 || len(snap.Files["ansible.cfg"]) == 0 || snap.ControllerIP == "" {
		return snap, errors.New("交付包缺少 inventory、运行配置或控制节点")
	}
	snap.RuntimeFiles, e = s.executionRuntimeFiles(j.ID)
	if e != nil {
		return snap, e
	}
	return snap, nil
}

// Bind access only after selecting the authorized executor. An Agent belonging
// to another executor must never change this snapshot or receive its key.
func bindExecutionAccess(snap *executionSnapshot, d executionDB, node string) {
	snap.AgentAccess = nil
	snap.AgentIdentity = nil
	for _, h := range snap.Hosts {
		for _, a := range d.Agents {
			if a.Job == snap.Job && a.Node == node && a.Host == h.Name && a.IP == h.IP && a.Desired == "active" {
				if snap.AgentAccess == nil {
					snap.AgentAccess = map[string]string{}
					snap.AgentIdentity = map[string]string{}
				}
				snap.AgentAccess[h.Name] = a.ID
				raw, _ := json.Marshal([]any{a.MachineID, a.PublicKey, a.HostKeys, a.Applied})
				snap.AgentIdentity[h.Name] = digest(raw)
			}
		}
	}
}
func (s *storeServer) executionRuntimeFiles(job string) (map[string]string, error) {
	f, e := os.Open(s.deliveryTar(job))
	if e != nil {
		return nil, e
	}
	defer f.Close()
	gz, e := gzip.NewReader(f)
	if e != nil {
		return nil, e
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	out := map[string]string{}
	allowed := map[string]bool{"runtime.json": true, "bootstrap/requirements.lock": true, "bootstrap/run-ansible.py": true, "bin/ansible-playbook": true}
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, e
		}
		path := strings.TrimPrefix(h.Name, "middleware-automation/")
		if !allowed[path] || h.Typeflag != tar.TypeReg {
			continue
		}
		if h.Size > 1<<20 {
			return nil, errors.New("运行环境标识文件过大")
		}
		data, e := io.ReadAll(tr)
		if e != nil {
			return nil, e
		}
		out[path] = digest(data)
	}
	if out["bin/ansible-playbook"] == "" {
		return nil, errors.New("交付包缺少运行器标识")
	}
	return out, nil
}
func executionRelative(p string) bool {
	return p != "" && !filepath.IsAbs(p) && filepath.ToSlash(filepath.Clean(p)) == p && p != "." && p != ".." && !strings.HasPrefix(p, "../") && !strings.ContainsAny(p, "\\\x00")
}
func executionNodeAllows(n executionNode, snap executionSnapshot) bool {
	if n.Disabled || !contains(n.Clusters, snap.Cluster) || n.ControllerIP != snap.ControllerIP {
		return false
	}
	if snap.ExecutionHost != nil && n.Kind != "independent" {
		return false
	}
	if snap.ExecutionHost == nil && n.Kind == "independent" {
		return false
	}
	ips := n.IPs
	if n.Kind != "" {
		ips = n.Grants[snap.Cluster]
	}
	for _, h := range snap.Hosts {
		if !contains(ips, h.IP) {
			return false
		}
	}
	return true
}

func (s *storeServer) handleExecutionNodes(w http.ResponseWriter, r *http.Request, session storeSession) {
	if r.URL.Path == "/api/settings/execution-nodes/binary" && r.Method == "GET" {
		f, e := os.Open("/proc/self/exe")
		if e != nil {
			s.fail(w, 500, "执行器文件不可读")
			return
		}
		defer f.Close()
		info, e := f.Stat()
		if e != nil {
			s.fail(w, 500, "执行器文件不可读")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=middleware-store-linux-amd64")
		http.ServeContent(w, r, "middleware-store", info.ModTime(), f)
		return
	}
	executionMu.Lock()
	defer executionMu.Unlock()
	d, e := s.readExecutions()
	if e != nil {
		s.fail(w, 500, e.Error())
		return
	}
	switch r.Method {
	case "GET":
		nodes := []executionNode{}
		for _, n := range d.Nodes {
			nodes = append(nodes, publicExecutionNode(n))
		}
		sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })
		s.writeJSON(w, 200, nodes)
	case "POST":
		var n executionNode
		if decodeBody(w, r, 16384, &n) != nil || strings.TrimSpace(n.Name) == "" || len(n.Name) > 100 || len(n.IPs) > 200 || net.ParseIP(n.ControllerIP) == nil || (n.Kind != "" && n.Kind != "embedded" && n.Kind != "independent") {
			s.fail(w, 400, "请填写节点名称、安装位置和有效的执行机器 IP")
			return
		}
		n.ControllerIP = net.ParseIP(n.ControllerIP).String()
		n.Protocol = 0 // Only a live runner can advertise protocol support.
		n.Grants = nil
		n.PublicKeys = nil
		n.Repositories = nil
		if n.Kind != "" {
			n.Clusters = []string{}
			n.IPs = []string{}
		} else if len(n.Clusters) == 0 || len(n.IPs) == 0 {
			s.fail(w, 400, "旧版接入须填写授权集群及机器，或选择新的执行节点类型")
			return
		}
		for _, c := range n.Clusters {
			if !safeName(c) {
				s.fail(w, 400, "集群名称无效")
				return
			}
		}
		for i, ip := range n.IPs {
			v := net.ParseIP(ip)
			if v == nil {
				s.fail(w, 400, "机器 IP 无效")
				return
			}
			n.IPs[i] = v.String()
		}
		if n.Kind == "" && !contains(n.IPs, n.ControllerIP) {
			s.fail(w, 400, "控制节点必须属于授权机器")
			return
		}
		token := randomStoreToken(32)
		n.ID = randomStoreToken(12)
		n.TokenHash = digest([]byte(token))
		n.LastSeen = ""
		n.Version = ""
		n.Disabled = false
		d.Nodes[n.ID] = n
		if e = s.saveExecutions(d); e != nil {
			s.fail(w, 500, "保存执行节点失败")
			return
		}
		s.auditReq(r, "execution-node-create", session.User, n.ID)
		s.writeJSON(w, 201, map[string]any{"node": publicExecutionNode(n), "token": token})
	case "PATCH":
		var req struct {
			ID       string `json:"id"`
			Disabled bool   `json:"disabled"`
		}
		if decodeBody(w, r, 4096, &req) != nil {
			s.fail(w, 400, "请求无效")
			return
		}
		n, ok := d.Nodes[req.ID]
		if !ok {
			s.fail(w, 404, "执行节点不存在")
			return
		}
		// Disabling stops new leases. The same credential can still return already-authorized evidence.
		n.Disabled = req.Disabled
		d.Nodes[n.ID] = n
		if s.saveExecutions(d) != nil {
			s.fail(w, 500, "保存失败")
			return
		}
		s.auditReq(r, "execution-node-disable", session.User, n.ID)
		s.writeJSON(w, 200, publicExecutionNode(n))
	case "DELETE":
		var req struct {
			ID string `json:"id"`
		}
		if decodeBody(w, r, 4096, &req) != nil || req.ID == "" {
			s.fail(w, 400, "请求无效")
			return
		}
		n, ok := d.Nodes[req.ID]
		if !ok {
			s.fail(w, 404, "执行节点不存在")
			return
		}
		for _, run := range d.Runs {
			if run.Node == n.ID && activeExecution(run) {
				s.fail(w, 409, "该节点仍有未结束的执行（集群 "+run.Cluster+"），请先结束或关闭后再删除")
				return
			}
		}
		// Removing the node discards its credential: the executor on that machine can no longer connect.
		// Finished runs keep their own executor name/IP, so delivery reports and history stay intact.
		delete(d.Nodes, n.ID)
		if s.saveExecutions(d) != nil {
			s.fail(w, 500, "删除失败")
			return
		}
		s.auditReq(r, "execution-node-delete", session.User, n.ID+" "+n.Name)
		w.WriteHeader(204)
	default:
		s.fail(w, 405, "方法不支持")
	}
}

// Delivery mutations and execution creation share a per-delivery lock.
func (s *storeServer) handleExecutions(w http.ResponseWriter, r *http.Request, session storeSession, j storeJob, parts []string) {
	executionMu.Lock()
	locked := true
	defer func() {
		if locked {
			executionMu.Unlock()
		}
	}()
	d, e := s.readExecutions()
	if e != nil {
		s.fail(w, 500, e.Error())
		return
	}
	if s.handleExecutionPreparation(w, r, session, j, parts, &d) {
		return
	}
	if s.handleTargetAgents(w, r, session, j, parts, &d) {
		return
	}
	if len(parts) == 0 && r.Method == "GET" {
		runs := []executionRun{}
		nodesSnapshot := make([]executionNode, 0, len(d.Nodes))
		for _, n := range d.Nodes {
			nodesSnapshot = append(nodesSnapshot, n)
		}
		prepsSnapshot := make([]executionPreparation, 0, len(d.Preparations))
		for _, p := range d.Preparations {
			if p.Job == j.ID {
				prepsSnapshot = append(prepsSnapshot, p)
			}
		}
		for _, x := range d.Runs {
			if x.Job == j.ID {
				for _, st := range x.Steps {
					s.projectExecutionResult(x, st.ID)
				}
				runs = append(runs, x)
			}
		}
		executionMu.Unlock()
		locked = false
		sort.Slice(runs, func(a, b int) bool { return runs[a].Created > runs[b].Created })
		nodes := []executionNodeOption{}
		context := s.executionContext(j)
		for _, n := range nodesSnapshot {
			if contains(n.Clusters, j.ClusterID) || s.can(session.User, "execution.manage") {
				nodes = append(nodes, executionNodeOptionFor(n, context))
			}
		}
		sort.Slice(nodes, func(a, b int) bool { return nodes[a].Name < nodes[b].Name })
		nodeByID := make(map[string]executionNode, len(nodesSnapshot))
		for _, n := range nodesSnapshot {
			nodeByID[n.ID] = n
		}
		preps := []executionPreparation{}
		for _, p := range prepsSnapshot {
			created, _ := time.Parse(time.RFC3339Nano, p.Created)
			finished, _ := time.Parse(time.RFC3339Nano, p.Finished)
			currentAccess := context
			bindExecutionAccess(&currentAccess, d, p.Node)
			before, _ := json.Marshal([]any{p.Snapshot.AgentAccess, p.Snapshot.AgentIdentity})
			after, _ := json.Marshal([]any{currentAccess.AgentAccess, currentAccess.AgentIdentity})
			if p.State == "ready" && string(before) != string(after) {
				p.State = "expired"
			}
			if p.NodeRevision != executionNodeRevision(nodeByID[p.Node]) || p.Invalidated != "" || (p.State == "ready" && time.Since(finished) > 10*time.Minute) || (p.State == "pending" && time.Since(created) > 10*time.Minute) {
				p.State = "expired"
			}
			p.Snapshot = executionSnapshot{}
			preps = append(preps, p)
		}
		sort.Slice(preps, func(a, b int) bool { return preps[a].Created > preps[b].Created })
		lang := wLang(w)
		for i := range runs {
			runs[i] = localizeExecutionRun(lang, runs[i])
		}
		for i := range nodes {
			nodes[i] = localizeExecutionOption(lang, nodes[i])
		}
		for i := range preps {
			preps[i] = localizeExecutionPrep(lang, preps[i])
		}
		steps := localizeExecutionChoices(lang, s.executionChoicesLang(j.ID, lang))
		s.writeJSON(w, 200, map[string]any{"runs": runs, "nodes": nodes, "steps": steps, "revision": s.executionRevision(j.ID), "targets": context.Hosts, "executor": map[string]any{"ip": context.ControllerIP, "kind": executionKind(context), "host": context.ExecutionHost, "runtime_root": context.RuntimeRoot}, "preparations": preps})
		return
	}
	if len(parts) == 3 && parts[1] == "logs" && r.Method == "GET" {
		run, ok := d.Runs[parts[0]]
		if !ok || run.Job != j.ID {
			s.fail(w, 404, "执行批次不存在")
			return
		}
		for _, st := range run.Steps {
			if st.ID == parts[2] {
				w.Header().Set("Content-Type", "text/plain; charset=utf-8")
				w.Header().Set("Content-Disposition", "attachment; filename=execution-"+st.ID+".log")
				data := s.executionLog(run.ID, st)
				if r.URL.Query().Get("tail") == "1" && len(data) > 16000 {
					data = data[len(data)-16000:]
					for len(data) > 0 && data[0]&0xc0 == 0x80 {
						data = data[1:]
					}
				}
				_, _ = w.Write(data)
				return
			}
		}
		s.fail(w, 404, "执行步骤不存在")
		return
	}
	if len(parts) == 0 && r.Method == "POST" {
		var req struct {
			Preparation string   `json:"preparation"`
			Node        string   `json:"node"`
			Keys        []string `json:"keys"`
			Revision    string   `json:"revision"`
			Request     string   `json:"request"`
			Confirm     string   `json:"confirm"`
			Prepared    bool     `json:"prepared"`
		}
		if decodeBody(w, r, 65536, &req) != nil || len(req.Keys) == 0 || len(req.Keys) > 200 || !executionID.MatchString(req.Request) {
			s.fail(w, 400, "请选择步骤并提供请求标识")
			return
		}
		// Duplicate submissions return the original immutable batch.
		for _, run := range d.Runs {
			if run.Job == j.ID && run.By == session.User && run.Request == req.Request {
				old := []string{}
				for _, st := range run.Steps {
					old = append(old, st.Key)
				}
				next := append([]string{}, req.Keys...)
				sort.Strings(old)
				sort.Strings(next)
				if run.Node != req.Node || run.Revision != req.Revision || strings.Join(old, "\n") != strings.Join(next, "\n") {
					s.fail(w, 409, "同一请求标识不能更换执行范围，请重新打开确认窗口")
					return
				}
				s.writeJSON(w, 200, run)
				return
			}
		}
		if j.State != "succeeded" || j.Outcome == "void" || j.RevisedBy != "" {
			s.fail(w, 409, "这份交付不可执行")
			return
		}
		if req.Revision != s.executionRevision(j.ID) {
			s.fail(w, 409, "执行计划已变化，请重新查看并选择步骤")
			return
		}
		if (!req.Prepared && req.Preparation == "") || req.Confirm != j.ClusterID {
			s.fail(w, 400, "请确认已完成环境准备，并输入本次集群名称")
			return
		}
		s.mu.Lock()
		replacement := false
		for _, next := range s.jobs {
			if next.Revises == j.ID && (next.State == "running" || next.State == "queued" || next.State == "succeeded") && next.Outcome != outcomeVoid {
				replacement = true
				break
			}
		}
		s.mu.Unlock()
		if replacement {
			s.fail(w, 409, "这份交付正在生成或已有替代修订，请执行新的交付")
			return
		}
		n, ok := d.Nodes[req.Node]
		if !ok || !executionOnline(n) {
			s.fail(w, 409, "执行节点未连接或已停用")
			return
		}
		snap, e := s.executionSnapshotFor(j)
		if e != nil {
			s.fail(w, 409, e.Error())
			return
		}
		bindExecutionAccess(&snap, d, n.ID)
		if !executionNodeAllows(n, snap) {
			s.fail(w, 403, "执行节点的集群、控制节点或机器授权范围不匹配")
			return
		}
		if n.Kind != "" {
			if e := validateExecutionPreparation(d.Preparations[req.Preparation], n, snap, req.Revision); e != nil {
				s.fail(w, 409, e.Error())
				return
			}
		}
		resources := []string{"cluster:" + j.ClusterID}
		for _, h := range snap.Hosts {
			resources = append(resources, "ip:"+h.IP)
		}
		for _, run := range d.Runs {
			if !activeExecution(run) {
				continue
			}
			for _, res := range resources {
				if contains(run.Resources, res) {
					s.fail(w, 409, "同一集群或机器已有执行任务，请先处理该批次："+run.ID)
					return
				}
			}
		}
		selected := map[string]bool{}
		for _, key := range req.Keys {
			if selected[key] {
				s.fail(w, 400, "步骤重复")
				return
			}
			selected[key] = true
		}
		choices := map[string]executionChoice{}
		for _, c := range s.executionChoices(j.ID) {
			choices[c.Key] = c
		}
		run := executionRun{Preparation: req.Preparation, ExecutorKind: executionKind(snap), ExecutorIP: snap.ControllerIP, ID: randomStoreToken(12), Request: req.Request, Job: j.ID, Cluster: j.ClusterID, Node: n.ID, By: session.User, Created: executionNow(), Updated: executionNow(), State: "queued", Resources: resources, Revision: req.Revision}
		run.ExecutorName = n.Name
		run.AccessMode = "existing-ssh"
		if len(snap.AgentAccess) > 0 {
			run.AccessMode = "agent-trust"
		}
		// Original runbook order is enforced, never trust the submitted ordering.
		for _, tab := range s.runbookSteps(j.ID) {
			for _, st := range tab.Steps {
				if !selected[st.Key] {
					continue
				}
				delete(selected, st.Key)
				c := choices[st.Key]
				if !c.Available {
					s.fail(w, 409, st.Title+"："+c.Reason)
					return
				}
				p := st.Parts[0]
				if len(snap.Files[p.Playbook]) == 0 {
					s.fail(w, 409, "步骤文件缺失："+st.Title)
					return
				}
				vars := map[string]any{}
				if p.Confirm || st.Effect != "read-only" {
					vars["confirm_cluster"] = j.ClusterID
				}
				for _, k := range p.ConfirmVars {
					if !nameRE.MatchString(strings.ReplaceAll(k, "_", "-")) {
						s.fail(w, 409, "确认参数无效")
						return
					}
					vars[k] = true
				}
				run.Steps = append(run.Steps, executionStep{ID: randomStoreToken(12), Key: st.Key, Title: st.Title, Effect: st.Effect, Hosts: st.Hosts, Playbook: p.Playbook, Timeout: p.Timeout, ExtraVars: vars, State: "pending"})
			}
		}
		if len(selected) > 0 {
			s.fail(w, 400, "包含不属于本次交付的步骤")
			return
		}
		b, _ := json.Marshal(snap)
		if len(b) > 48<<20 {
			s.fail(w, 409, "执行快照超过 48 MiB，请拆分交付或按离线手册执行")
			return
		}
		run.Snapshot = digest(b)
		if e = atomicExecutionJSON(s.executionPath("runs", run.ID, "snapshot.json"), snap); e != nil {
			s.fail(w, 500, "执行快照保存失败")
			return
		}
		d.Runs[run.ID] = run
		if e = s.saveExecutions(d); e != nil {
			s.fail(w, 500, "执行任务保存失败")
			return
		}
		s.auditReq(r, "execution-create", session.User, j.ID+" "+run.ID)
		s.writeJSON(w, 201, run)
		return
	}
	if len(parts) == 1 && r.Method == "PATCH" {
		run, ok := d.Runs[parts[0]]
		if !ok || run.Job != j.ID {
			s.fail(w, 404, "执行批次不存在")
			return
		}
		var req struct {
			Action string `json:"action"`
			Note   string `json:"note"`
		}
		if decodeBody(w, r, 4096, &req) != nil {
			s.fail(w, 400, "请求无效")
			return
		}
		switch req.Action {
		case "pause":
			if !activeExecution(run) {
				s.fail(w, 409, "批次已经结束")
				return
			}
			run.Pause = true
			if run.State == "queued" {
				run.State = "paused"
			}
		case "resume":
			if run.State != "paused" {
				s.fail(w, 409, "只能继续已暂停的批次；失败或未知结果需要先核实")
				return
			}
			run.Pause = false
			run.State = "queued"
		case "close":
			for _, st := range run.Steps {
				if st.State == "leased" || st.State == "running" || st.State == "unknown" {
					s.fail(w, 409, "执行节点尚未确认停止，不能解除占用或转交他人")
					return
				}
			}
			if strings.TrimSpace(req.Note) == "" {
				s.fail(w, 400, "请填写结束批次的原因")
				return
			}
			run.State = "closed"
			run.Note = req.Note
		default:
			s.fail(w, 400, "不支持的操作")
			return
		}
		run.Updated = executionNow()
		d.Runs[run.ID] = run
		if s.saveExecutions(d) != nil {
			s.fail(w, 500, "保存失败")
			return
		}
		s.auditReq(r, "execution-"+req.Action, session.User, run.ID)
		s.writeJSON(w, 200, run)
		return
	}
	s.fail(w, 405, "方法不支持")
}

func (s *storeServer) executionLog(run string, st executionStep) []byte {
	var out []byte
	for i := 1; i <= st.Seq; i++ {
		b, e := os.ReadFile(s.executionPath("runs", run, st.ID, fmt.Sprintf("%06d.json", i)))
		if e != nil {
			continue
		}
		var ev executionEvent
		if json.Unmarshal(b, &ev) == nil {
			out = append(out, []byte(ev.Text)...)
		}
	}
	return out
}
func (s *storeServer) applyExecutionEvent(d *executionDB, n executionNode, ev executionEvent) error {
	run, ok := d.Runs[ev.Run]
	if !ok || run.Node != n.ID {
		return errors.New("批次不属于当前执行节点")
	}
	idx := -1
	for i := range run.Steps {
		if run.Steps[i].ID == ev.Attempt {
			idx = i
			break
		}
	}
	if idx < 0 {
		return errors.New("步骤尝试不存在")
	}
	st := &run.Steps[idx]
	if ev.Seq < 1 || ev.Seq > 4096 || len(ev.Text) > 32768 || len(ev.Reason) > 2000 {
		return errors.New("回传事件过大或序号无效")
	}
	if _, e := time.Parse(time.RFC3339Nano, ev.At); e != nil {
		return errors.New("执行节点时间格式无效")
	}
	if ev.Kind != "log" && ev.Kind != "finished" && ev.Text != "" {
		return errors.New("该事件不能附带日志")
	}
	path := s.executionPath("runs", run.ID, st.ID, fmt.Sprintf("%06d.json", ev.Seq))
	if ev.Seq <= st.Seq {
		old, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		var prev executionEvent
		_ = json.Unmarshal(old, &prev)
		a, _ := json.Marshal(prev)
		b, _ := json.Marshal(ev)
		if string(a) != string(b) {
			return errors.New("同一序号不能覆盖原有执行信息")
		}
		return nil
	}
	if ev.Seq != st.Seq+1 {
		return fmt.Errorf("请从序号 %d 补传", st.Seq+1)
	}
	switch ev.Kind {
	case "blocked":
		if st.State != "leased" || ev.Reason == "" {
			return errors.New("只有尚未启动的步骤可以报告准备受阻")
		}
		st.State, st.Message, st.Finished, run.State = "blocked", ev.Reason, ev.At, "failed"
	case "started":
		if st.State != "leased" {
			return errors.New("步骤没有授权启动")
		}
		st.State = "running"
		st.Started = ev.At
		st.Message = ev.Reason
		st.Runtime = ev.Reason
	case "log":
		if st.State != "running" && st.State != "unknown" {
			return errors.New("步骤未在执行")
		}
	case "unknown":
		if st.State != "running" && st.State != "leased" {
			return errors.New("当前状态不能改为待核实")
		}
		st.State = "unknown"
		st.Message = ev.Reason
		run.State = "unknown"
	case "stopped":
		if st.State != "unknown" || strings.TrimSpace(ev.Reason) == "" {
			return errors.New("只能核实异常中断的步骤，且必须说明现场核实结果")
		}
		st.State = "interrupted"
		st.Message = ev.Reason
		st.Finished = ev.At
		run.State = "failed"
	case "finished":
		if st.State != "running" && st.State != "unknown" {
			return errors.New("步骤未在执行")
		}
		if ev.ExitCode == nil {
			return errors.New("缺少进程退出码")
		}
		data := append(s.executionLog(run.ID, *st), []byte(ev.Text)...)
		parsed := parseRunLog("execution.log", data)
		st.ExitCode = ev.ExitCode
		st.Recap = parsed.Recap
		st.Finished = ev.At
		switch {
		case *ev.ExitCode != 0:
			st.State = "failed"
			st.Message = "执行进程返回失败，请查看日志"
			run.State = "failed"
		case parsed.Playbook != st.Playbook || !strings.Contains(string(data), "STEP_RESULT ") || parsed.Result == "" || parsed.Started == "" || parsed.Finished == "" || len(parsed.Recap) == 0:
			st.State = "unknown"
			st.Message = "进程结束，但缺少完整的结构化结果，需要核实"
			run.State = "unknown"
		case parsed.Result == "PASSED":
			st.State = "succeeded"
			st.Message = "任务与组件声明的完成检查通过"
			for _, h := range parsed.Recap {
				if h.Failed != 0 || h.Unreachable != 0 {
					st.State, st.Message, run.State = "failed", "机器汇总仍有失败或无法连接，不能确认通过", "failed"
				}
			}
			for _, host := range st.Hosts {
				found := false
				for _, h := range parsed.Recap {
					if h.Host == host {
						found = true
					}
				}
				if !found {
					st.State, st.Message, run.State = "unknown", "缺少目标机器的执行汇总："+host, "unknown"
					break
				}
			}
		case parsed.Result == "SKIPPED":
			st.State = "skipped"
			st.Message = "运行条件不满足，没有执行目标任务"
		default:
			st.State = "failed"
			st.Message = "任务或完成检查未通过"
			run.State = "failed"
		}
	default:
		return errors.New("未知回传事件")
	}
	if ev.At == "" {
		return errors.New("缺少执行节点时间")
	}
	// Persist immutable evidence first, then state. Replaying after a crash is safe.
	if old, e := os.ReadFile(path); e == nil {
		var prev executionEvent
		_ = json.Unmarshal(old, &prev)
		a, _ := json.Marshal(prev)
		b, _ := json.Marshal(ev)
		if string(a) != string(b) {
			return errors.New("执行证据已存在且内容不同")
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	if e := atomicExecutionJSON(path, ev); e != nil {
		return e
	}
	st.Seq = ev.Seq
	st.Returned = executionNow()
	run.Updated = executionNow()
	if st.State == "succeeded" || st.State == "skipped" {
		all := true
		for _, x := range run.Steps {
			if x.State != "succeeded" && x.State != "skipped" {
				all = false
			}
		}
		if all {
			run.State = "completed"
		} else if run.Pause {
			run.State = "paused"
		} else {
			run.State = "queued"
		}
	}
	d.Runs[run.ID] = run
	return nil
}

// Only this narrow endpoint accepts bearer credentials. Browser session, CSRF,
// permission and visibility checks remain mandatory on every management route.
func (s *storeServer) handleExecutionAgent(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		s.fail(w, 405, "方法不支持")
		return
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") || len(auth) < 40 {
		s.fail(w, 401, "执行节点认证失败")
		return
	}
	executionMu.Lock()
	defer executionMu.Unlock()
	d, e := s.readExecutions()
	if e != nil {
		s.fail(w, 500, e.Error())
		return
	}
	var n executionNode
	for _, x := range d.Nodes {
		if constantStoreEqual(x.TokenHash, digest([]byte(strings.TrimPrefix(auth, "Bearer ")))) {
			n = x
			break
		}
	}
	if n.ID == "" {
		s.fail(w, 401, "执行节点认证失败")
		return
	}
	switch r.URL.Path {
	case "/api/execution-agent/trust-key":
		s.handleExecutionTrustKey(w, r, &d, n)
	case "/api/execution-agent/prepared":
		s.handleExecutionPrepared(w, r, &d, n)
	case "/api/execution-agent/event":
		var ev executionEvent
		if decodeBody(w, r, 48000, &ev) != nil {
			s.fail(w, 400, "回传格式不正确")
			return
		}
		if e = s.applyExecutionEvent(&d, n, ev); e != nil {
			s.fail(w, 409, e.Error())
			return
		}
		if e = s.saveExecutions(d); e != nil {
			s.fail(w, 500, "执行结果尚未保存，请补传")
			return
		}
		s.projectExecutionResult(d.Runs[ev.Run], ev.Attempt)
		state := ""
		for _, st := range d.Runs[ev.Run].Steps {
			if st.ID == ev.Attempt {
				state = st.State
			}
		}
		s.writeJSON(w, 200, map[string]any{"ack": ev.Seq, "state": state})
	case "/api/execution-agent/poll":
		var req struct {
			Protocol  int    `json:"protocol"`
			Version   string `json:"version"`
			Heartbeat bool   `json:"heartbeat"`
		}
		if decodeBody(w, r, 4096, &req) != nil {
			s.fail(w, 400, "请求无效")
			return
		}
		n.LastSeen = executionNow()
		n.Version = truncRunes(req.Version, 80)
		n.Protocol = req.Protocol
		d.Nodes[n.ID] = n
		if !n.Disabled && !req.Heartbeat && n.Protocol >= 2 {
			if p := pendingExecutionPreparation(d, n); p != nil {
				p.Snapshot, e = s.preparationSnapshot(*p)
				if e != nil {
					s.fail(w, 409, e.Error())
					return
				}
				if e = s.saveExecutions(d); e != nil {
					s.fail(w, 500, "执行状态保存失败")
					return
				}
				s.writeJSON(w, 200, map[string]any{"preparation": p})
				return
			}
		}
		var work *executionWork
		if !n.Disabled && !req.Heartbeat {
			ids := []string{}
			for id, run := range d.Runs {
				if run.Node == n.ID && activeExecution(run) {
					ids = append(ids, id)
				}
			}
			sort.Slice(ids, func(a, b int) bool {
				if d.Runs[ids[a]].Created == d.Runs[ids[b]].Created {
					return ids[a] < ids[b]
				}
				return d.Runs[ids[a]].Created < d.Runs[ids[b]].Created
			})
			for _, id := range ids {
				run := d.Runs[id]
				if run.State == "paused" {
					continue
				}
				index := -1
				for i, st := range run.Steps {
					if st.State == "running" || st.State == "leased" || st.State == "unknown" {
						index = i
						break
					}
					if st.State == "pending" {
						if run.Pause {
							break
						}
						index = i
						break
					}
				}
				if index < 0 {
					continue
				}
				var snap executionSnapshot
				b, e := os.ReadFile(s.executionPath("runs", run.ID, "snapshot.json"))
				if e != nil || json.Unmarshal(b, &snap) != nil || digest(b) != run.Snapshot {
					s.fail(w, 500, "执行快照校验失败")
					return
				}
				if !executionNodeAllows(n, snap) {
					continue
				}
				if run.Steps[index].State == "pending" {
					run.Steps[index].State = "leased"
					run.State = "running"
					run.Updated = executionNow()
					d.Runs[id] = run
				}
				work = &executionWork{Run: run, Step: run.Steps[index], Snapshot: snap}
				break
			}
		}
		if e = s.saveExecutions(d); e != nil {
			s.fail(w, 500, "执行状态保存失败")
			return
		}
		s.writeJSON(w, 200, map[string]any{"work": work})
	default:
		s.fail(w, 404, "接口不存在")
	}
}

// progress.json is a compatibility projection. Immutable attempts remain the source
// of evidence and are not removed by a manual correction or a new execution batch.
func (s *storeServer) projectExecutionResult(run executionRun, attempt string) {
	// A refresh must never resurrect results invalidated by a newer plan.
	if run.Revision != "" && run.Revision != s.executionRevision(run.Job) {
		return
	}
	for _, st := range run.Steps {
		if st.ID != attempt {
			continue
		}
		state := map[string]string{"succeeded": "done", "failed": "failed", "skipped": "skipped", "interrupted": "failed"}[st.State]
		if state == "" {
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		doc := s.readProgress(run.Job)
		prev := doc.Steps[st.Key]
		if prev.At > firstNonEmptyStr(st.Returned, st.Finished) {
			return
		}
		if prev.Attempt == st.ID && prev.State == state {
			return
		}
		doc.Steps[st.Key] = stepRecord{State: state, By: "执行节点", At: firstNonEmptyStr(st.Returned, st.Finished), Note: st.Message, Source: "automatic", Execution: run.ID, Attempt: st.ID}
		doc.Events = append(doc.Events, progressEvent{At: st.Finished, By: "执行节点", Key: st.Key, Title: st.Title, State: state})
		if len(doc.Events) > maxEvents {
			doc.Events = doc.Events[len(doc.Events)-maxEvents:]
		}
		if s.writeProgress(run.Job, doc) != nil {
			return
		}
		j := s.jobs[run.Job]
		j.RunDone, j.RunFailed = countSteps(doc)
		j.RunTotal = len(flatSteps(s.runbookSteps(run.Job)))
		j.Updated = executionNow()
		if s.persistJob(j) == nil {
			s.jobs[run.Job] = j
		}
		return
	}
}

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"middleware-deployer/mwpack"
	"net"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// What the assistant may see. It has read-only tools scoped to one delivery, and everything it reads or says passes
// through aiScrub first: passwords, tokens and private keys never leave the platform, whatever the file they sit in.

var (
	reKeyBlock = regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|ENCRYPTED)[A-Z ]*-----.*?(?:-----END [A-Z ]*-----|$)`)
	reSecretKV = regexp.MustCompile(`(?i)((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;"'}]+)`)
	reBearer   = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}`)
	reURLCred  = regexp.MustCompile(`(://[^/\s:@]+:)[^/\s@]+(@)`)
	reAnyIP    = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`)
	reSkKey    = regexp.MustCompile(`\b(?:sk|ghp|glpat|AKIA)[-_A-Za-z0-9]{16,}\b`)
)

const aiMasked = "［已隐去］"

func aiScrub(s string) string {
	s = reKeyBlock.ReplaceAllString(s, aiMasked)
	s = reBearer.ReplaceAllString(s, "${1}"+aiMasked)
	s = reSecretKV.ReplaceAllString(s, "${1}"+aiMasked)
	s = reURLCred.ReplaceAllString(s, "${1}"+aiMasked+"${2}")
	s = reSkKey.ReplaceAllString(s, aiMasked)
	return s
}

// aiRedactor swaps IP addresses and the delivery's host names for placeholders, and swaps them back in answers.
type aiRedactor struct {
	fwd   map[string]string
	order []string
}

func newAIRedactor(hostNames []string) *aiRedactor {
	r := &aiRedactor{fwd: map[string]string{}}
	for i, h := range hostNames {
		if h != "" {
			r.fwd[h] = fmt.Sprintf("HOST_%d", i+1)
		}
	}
	return r
}

func (r *aiRedactor) out(s string) string {
	if r == nil {
		return s
	}
	names := make([]string, 0, len(r.fwd))
	for k := range r.fwd {
		names = append(names, k)
	}
	sort.Slice(names, func(i, j int) bool { return len(names[i]) > len(names[j]) })
	for _, k := range names {
		s = strings.ReplaceAll(s, k, r.fwd[k])
	}
	return reAnyIP.ReplaceAllStringFunc(s, func(ip string) string {
		if net.ParseIP(ip) == nil {
			return ip
		}
		if _, ok := r.fwd[ip]; !ok {
			r.fwd[ip] = fmt.Sprintf("IP_%d", len(r.fwd)+1)
		}
		return r.fwd[ip]
	})
}

func (r *aiRedactor) back(s string) string {
	if r == nil {
		return s
	}
	for k, v := range r.fwd {
		s = strings.ReplaceAll(s, v, k)
	}
	return s
}

// ---- files of a delivery ----

var aiDeniedFile = regexp.MustCompile(`(?i)(^|/)(secrets?|vault|\.ssh|private|keys?)(/|$)|\.(key|pem|crt|cer|p12|pfx|jks|keystore)$|(^|/)(id_rsa|id_ed25519|\.vault_pass|vault[-_]pass)|password|passwd|credential`)

const (
	aiMaxFile   = 24 << 10
	aiMaxResult = 20 << 10
)

// deliveryTar finds the controller node's package: it holds the whole project the runbook refers to.
func (s *storeServer) deliveryTar(id string) string {
	files, _ := filepath.Glob(filepath.Join(s.jobDir(id), "output", "*.tar.gz"))
	sort.Strings(files)
	// the controller's package carries the project; a plan has no package for most other machines
	var p struct {
		ExecutionHost *mwpack.ExecutionHost `json:"execution_host"`
		Controller    string                `json:"controller"`
		Hosts         []struct {
			Name string `json:"name"`
			IP   string `json:"ip"`
		} `json:"hosts"`
	}
	if b, err := os.ReadFile(filepath.Join(s.jobDir(id), "output", "plan.json")); err == nil && json.Unmarshal(b, &p) == nil {
		if e := p.ExecutionHost; e != nil {
			for _, f := range files {
				if strings.HasSuffix(filepath.Base(f), "-"+e.IP+".tar.gz") {
					return f
				}
			}
			return "" // Never substitute a business-host archive for the executor.
		}
		for _, h := range p.Hosts {
			if h.Name != p.Controller {
				continue
			}
			for _, f := range files {
				if strings.HasSuffix(filepath.Base(f), "-"+h.IP+".tar.gz") {
					return f
				}
			}
		}
	}
	for _, f := range files {
		if !strings.HasPrefix(filepath.Base(f), "packages-") {
			return f
		}
	}
	return ""
}

func (s *storeServer) projectPrefix(id string) string {
	var p struct {
		Dir string `json:"project_dir"`
	}
	if b, err := os.ReadFile(filepath.Join(s.jobDir(id), "output", "plan.json")); err == nil {
		_ = json.Unmarshal(b, &p)
	}
	name := path.Base(p.Dir)
	if name == "" || name == "." || name == "/" {
		return ""
	}
	return "middleware-automation/projects/" + name + "/"
}

func (s *storeServer) walkProject(id string, fn func(rel string, size int64, rd io.Reader) bool) error {
	f := s.deliveryTar(id)
	prefix := s.projectPrefix(id)
	if f == "" || prefix == "" {
		return fmt.Errorf("交付包不存在")
	}
	fh, err := os.Open(f)
	if err != nil {
		return err
	}
	defer fh.Close()
	gz, err := gzip.NewReader(fh)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	over := s.patchedFiles(id)
	seen := map[string]bool{}
	defer func() {}()
	for {
		h, err := tr.Next()
		if err != nil {
			for rel, b := range over {
				if !seen[rel] && !aiDeniedFile.MatchString(rel) {
					if !fn(rel, int64(len(b)), bytes.NewReader(b)) {
						break
					}
				}
			}
			return nil
		}
		if h.Typeflag != tar.TypeReg || !strings.HasPrefix(h.Name, prefix) {
			continue
		}
		rel := strings.TrimPrefix(h.Name, prefix)
		if aiDeniedFile.MatchString(rel) {
			continue
		}
		// a file the delivery was patched on site is read as it is now
		if b, ok := over[rel]; ok {
			seen[rel] = true
			if !fn(rel, int64(len(b)), bytes.NewReader(b)) {
				return nil
			}
			continue
		}
		if !fn(rel, h.Size, tr) {
			return nil
		}
	}
}

// ---- tools ----

type aiToolCtx struct {
	s        *storeServer
	job      storeJob
	session  string
	proposed *[]string
}

func aiTools() []aiToolDef {
	obj := func(props map[string]any, req ...string) map[string]any {
		return map[string]any{"type": "object", "properties": props, "required": req}
	}
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return []aiToolDef{
		aiProposeTool(),
		aiSuggestTool(),
		aiFileTool(),
		aiChangeTool(),
		{"delivery_info", "这份交付的概况：集群、主机、组件实例、角色分配、参数和提示。", obj(map[string]any{})},
		{"runbook", "这份交付的执行手册：准备、部署、测试、清理各阶段的步骤标题、命令、主机和预期。可只取一个阶段。", obj(map[string]any{"phase": str("prepare | deploy | tests | endpoint（入口测试） | cleanup，缺省为全部")})},
		{"execution_history", "当前交付的自动执行批次、尝试、机器、快照版本和状态。未知状态不是失败，也不能自动重跑。", obj(map[string]any{})},
		{"execution_log", "读取当前交付某次自动执行尝试的日志末尾（已脱敏）。", obj(map[string]any{"run": str("执行批次 ID"), "attempt": str("步骤尝试 ID")}, "run", "attempt")},
		{"execution_record", "现场已经记录的执行情况：每一步的状态、备注和贴回的输出。", obj(map[string]any{})},
		{"cluster_history", "这份交付所在集群的全部经历：首次部署和历次交付（类型、时间、结果、偏差或失败说明、改了什么），以及哪一份是集群的当前状态、是否有未完成的交付。回答“这个集群做过什么、现在是什么样”时先看它。", obj(map[string]any{})},
		{"list_files", "列出这份交付自动化项目里的文件（Playbook、角色任务、模板等）。不含密钥、证书和凭据。", obj(map[string]any{"prefix": str("只列这个目录前缀下的文件，可省略")})},
		{"read_file", "读取项目里的一个文件，一次最多 24 KiB；更长的文件用 offset（字节）接着读。", obj(map[string]any{"path": str("list_files 给出的相对路径"), "offset": map[string]any{"type": "integer", "description": "从第几个字节开始，缺省 0"}}, "path")},
	}
}

func (c aiToolCtx) run(name string, args string) string {
	var a map[string]any
	_ = json.Unmarshal([]byte(args), &a)
	str := func(k string) string { v, _ := a[k].(string); return v }
	id := c.job.ID
	var out string
	switch name {
	case "cluster_history":
		out = c.s.clusterHistoryText(c.job.ClusterID)
	case "delivery_info":
		plan := c.s.jobPlan(id)
		var p map[string]json.RawMessage
		_ = json.Unmarshal(plan, &p)
		slim := map[string]json.RawMessage{}
		for _, k := range []string{"cluster", "controller", "execution_host", "project_dir", "hosts", "instances", "warnings"} {
			if v, ok := p[k]; ok {
				slim[k] = v
			}
		}
		b, _ := json.Marshal(map[string]any{"app": c.job.AppName, "version": c.job.Version, "plan": slim})
		out = string(b)
	case "runbook":
		var p map[string]json.RawMessage
		_ = json.Unmarshal(c.s.jobPlan(id), &p)
		phases := []string{"prepare", "deploy", "tests", "endpoint", "cleanup"}
		if ph := str("phase"); ph != "" {
			phases = []string{ph}
		}
		res := map[string]json.RawMessage{}
		if am := c.s.loadAmendments(id); len(am) > 0 {
			b, _ := json.Marshal(am)
			res["amendments"] = b
		}
		if v, ok := p["endpoint_tests"]; ok {
			p["endpoint"] = v
		}
		for _, k := range phases {
			if v, ok := p[k]; ok {
				res[k] = v
			}
		}
		b, _ := json.Marshal(res)
		out = string(b)
	case "propose_step":
		out = c.propose(a, false)
	case "propose_change":
		out = c.propose(a, true)
	case "propose_file_change":
		out = c.proposeFile(a)
	case "suggest_component_change":
		out = c.suggest(a)
	case "execution_history":
		db, e := c.s.readExecutions()
		if e != nil {
			out = "自动执行状态不可读取"
			break
		}
		runs := []executionRun{}
		for _, run := range db.Runs {
			if run.Job == id {
				runs = append(runs, run)
			}
		}
		sort.Slice(runs, func(i, j int) bool { return runs[i].Created > runs[j].Created })
		b, _ := json.Marshal(runs)
		out = string(b)
	case "execution_log":
		out = "执行日志不存在或不属于当前交付"
		db, e := c.s.readExecutions()
		if e != nil {
			break
		}
		run, ok := db.Runs[str("run")]
		if !ok || run.Job != id {
			break
		}
		for _, st := range run.Steps {
			if st.ID == str("attempt") {
				raw := c.s.executionLog(run.ID, st)
				if len(raw) > aiMaxFile {
					raw = raw[len(raw)-aiMaxFile:]
				}
				out = string(raw)
				break
			}
		}
	case "execution_record":
		b, _ := json.Marshal(c.s.readProgress(id).Steps)
		out = string(b)
	case "list_files":
		pre := strings.TrimPrefix(str("prefix"), "/")
		var names []string
		_ = c.s.walkProject(id, func(rel string, size int64, _ io.Reader) bool {
			if strings.HasPrefix(rel, pre) {
				names = append(names, fmt.Sprintf("%s (%d)", rel, size))
			}
			return len(names) < 400
		})
		out = strings.Join(names, "\n")
		if out == "" {
			out = "没有匹配的文件"
		}
	case "read_file":
		want := path.Clean(str("path"))
		out = "文件不存在，或不允许读取（密钥、证书和凭据类文件不会提供）"
		_ = c.s.walkProject(id, func(rel string, size int64, rd io.Reader) bool {
			if rel != want {
				return true
			}
			off := int64(0)
			if f, ok := a["offset"].(float64); ok && f > 0 {
				off = int64(f)
			}
			_, _ = io.CopyN(io.Discard, rd, off)
			b, _ := io.ReadAll(io.LimitReader(rd, aiMaxFile))
			out = string(b)
			if size > off+aiMaxFile {
				out += fmt.Sprintf("\n…（文件共 %d 字节，已读到 %d，用 offset=%d 接着读）", size, off+int64(len(b)), off+int64(len(b)))
			}
			return false
		})
	default:
		out = "没有这个工具"
	}
	out = aiScrub(out)
	if len(out) > aiMaxResult {
		out = out[:aiMaxResult] + "\n…（结果过长，已截断）"
	}
	return out
}

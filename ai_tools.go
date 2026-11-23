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
	user     string
	session  string
	proposed *[]string
}

func aiToolsFor(feature string) []aiToolDef {
	base := aiTools()
	if feature == "security" {
		base = append(base, aiProposeVexTool(), aiProposeBaselineWaiveTool(), aiSuggestRehearsalTool())
	}
	return base
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
		aiProposeRehearsalTool(),
		aiReadRehearsalTool(),
		aiProposeRehearsalStepEditTool(),
		aiProposeKnowledgeTool(),
		aiClusterSecurityInfoTool(),
		{"delivery_info", "这份交付的概况：集群标识、是否已投产运行中（cluster_running / lifecycle_label）、已有变更演练、交付模式（offline/automatic/configuration）、操作系统、主机、组件实例、角色分配、架构方案、参数、执行进度和提示。", obj(map[string]any{})},
		{"runbook", "这份交付的执行手册：准备、部署、测试、清理各阶段的步骤标题、命令、主机和预期。可只取一个阶段。", obj(map[string]any{"phase": str("prepare | deploy | tests | endpoint（入口测试） | cleanup，缺省为全部")})},
		{"execution_history", "当前交付的自动执行批次、尝试、机器、快照版本和状态。未知状态不是失败，也不能自动重跑。", obj(map[string]any{})},
		{"execution_log", "读取当前交付某次自动执行尝试的日志末尾（已脱敏）。", obj(map[string]any{"run": str("执行批次 ID"), "attempt": str("步骤尝试 ID")}, "run", "attempt")},
		{"execution_record", "现场已经记录的执行情况：每一步的状态、备注和贴回的输出。", obj(map[string]any{})},
		{"cluster_history", "这份交付所在集群的全部经历：首次部署和历次交付（类型、时间、结果、偏差或失败说明、改了什么），以及哪一份是集群的当前状态、是否有未完成的交付。回答“这个集群做过什么、现在是什么样”时先看它。", obj(map[string]any{})},
		{"component_sync_status", "核对本次交付快照与当前平台最新已发布组件、组件草稿的差异及可同步状态。判断故障疑似由组件剧本、模板或测试断言引起时，必须先调用此工具确认当前组件是否已经修复：若已发布组件已修复可直接引导点击「同步组件更新」，无需再去组件工作台修改。", obj(map[string]any{
			"file": str("可选：交付项目中的相对文件路径（如 roles/redis/tasks/test_failover.yml），重点核对该文件在当前已发布组件和草稿中是否已有更新并返回逐行差异"),
		})},
		{"search_files", "在当前交付自动化项目文件（Playbook、角色任务、模板、变量、脚本）中快速全文搜索关键词或正则，毫秒级返回「文件路径:行号: 匹配行」。查日志、轮转、端口、备份、参数、任务定义是否存在时首选此工具，不要用 run_shell 当 grep。", obj(map[string]any{
			"query":        str("要搜索的关键词或正则表达式（如 logging_collector|logrotate|journald 或 maxmemory），默认不区分大小写"),
			"prefix":       str("可选：只在某个目录前缀下搜索（如 roles/postgresql 或 inventory/）"),
			"regex":        map[string]any{"type": "boolean", "description": "可选：是否按正则匹配（默认 false；包含 | 或正则语法时设为 true）"},
			"include_plan": map[string]any{"type": "boolean", "description": "可选：是否包含体积较大的 plan.json（默认 false，聚焦 playbook/任务/模板/变量）"},
		}, "query")},
		{"list_files", "列出这份交付自动化项目里的文件（Playbook、角色任务、模板等）。不含密钥、证书和凭据。", obj(map[string]any{"prefix": str("只列这个目录前缀下的文件，可省略")})},
		{"read_file", "读取项目里的一个文件，支持按行区间（from_line / max_lines）或字节 offset 读取，一次最多 24 KiB。配合 search_files 精准读取命中片段更快。", obj(map[string]any{
			"path":      str("list_files 或 search_files 给出的相对路径"),
			"from_line": map[string]any{"type": "integer", "description": "可选：从第几行开始读（1 起算），用于精读大文件片段"},
			"max_lines": map[string]any{"type": "integer", "description": "可选：最多读取多少行（默认 160，最大 400），传 from_line 时生效"},
			"offset":    map[string]any{"type": "integer", "description": "可选：从第几个字节开始读，缺省 0（与 from_line 二选一）"},
		}, "path")},
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
	case "component_sync_status":
		out = c.componentSyncStatus(str("file"))
	case "delivery_info":
		plan := c.s.jobPlan(id)
		var p map[string]json.RawMessage
		_ = json.Unmarshal(plan, &p)
		slim := map[string]json.RawMessage{}
		for _, k := range []string{"delivery_mode", "platform", "cluster", "controller", "execution_host", "project_dir", "hosts", "instances", "warnings"} {
			if v, ok := p[k]; ok {
				slim[k] = v
			}
		}
		meta := map[string]any{
			"cluster_id":    c.job.ClusterID,
			"job_id":        c.job.ID,
			"app":           c.job.AppName,
			"version":       c.job.Version,
			"delivery_mode": firstNonEmptyStr(c.job.DeliveryMode, "offline"),
			"purpose":       c.job.Purpose,
			"outcome":       c.job.Outcome,
			"outcome_note":  c.job.OutcomeNote,
			"marked_at":     c.job.Marked,
			"marked_by":     c.job.MarkedBy,
			"run_done":      c.job.RunDone,
			"run_failed":    c.job.RunFailed,
			"run_total":     c.job.RunTotal,
			"plan":          slim,
		}
		if lc, ok := c.s.deliveryLifecycleInfo(id); ok {
			meta["cluster_running"] = lc.ClusterRunning
			meta["lifecycle_status"] = lc.LifecycleCode
			meta["lifecycle_label"] = lc.LifecycleLabel
			if lc.HeadJobID != "" {
				meta["head_job_id"] = lc.HeadJobID
			}
			if len(lc.Rehearsals) > 0 {
				meta["rehearsals"] = lc.Rehearsals
			}
		}
		if c.job.Scheme != nil {
			meta["scheme"] = c.job.Scheme
		}
		if c.job.VerifyTarget != nil {
			meta["verify_target"] = c.job.VerifyTarget
		}
		b, _ := json.Marshal(meta)
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
	case "cluster_security_info":
		out = c.s.runClusterSecurityInfo(c.user, c.job.ClusterID, a)
	case "propose_vex_triage":
		out = c.s.createVexProposal(c.s.proposalsPath(id), c.session, c.job.ClusterID, a, c.proposed)
	case "propose_baseline_waive":
		out = c.s.createBaselineWaiveProposal(c.s.proposalsPath(id), c.session, c.job.ClusterID, a, c.proposed)
	case "propose_rehearsal":
		out = c.s.createRehearsalProposal(c.s.proposalsPath(id), c.session, c.user, c.job.ClusterID, c.job.ID, a, c.proposed, false)
	case "read_rehearsal":
		out = c.s.runReadRehearsal(c.job.ClusterID, str("rehearsal_id"))
	case "propose_rehearsal_step_edit":
		out = c.s.createRehearsalStepEditProposal(c.s.proposalsPath(id), c.session, c.job.ClusterID, a, c.proposed)
	case "suggest_security_rehearsal":
		out = c.s.createRehearsalProposal(c.s.proposalsPath(id), c.session, c.user, c.job.ClusterID, c.job.ID, a, c.proposed, true)
	case "propose_knowledge":
		src := strings.TrimSpace("集群 " + firstNonEmptyStr(c.job.ClusterID, c.job.ID))
		out = c.s.createKnowledgeProposal(c.s.proposalsPath(id), c.session, src, a, c.proposed)
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
	case "search_files":
		q := strings.TrimSpace(str("query"))
		if q == "" {
			out = "请提供要搜索的关键词 query。"
			break
		}
		pre := strings.TrimPrefix(str("prefix"), "/")
		useRegex, _ := a["regex"].(bool)
		includePlan, _ := a["include_plan"].(bool)
		var re *regexp.Regexp
		if useRegex {
			var err error
			re, err = regexp.Compile("(?i)" + q)
			if err != nil {
				out = "正则表达式无效：" + err.Error()
				break
			}
		}
		lowQ := strings.ToLower(q)
		const maxHits = 80
		const maxScanFile = 512 << 10
		var hits []string
		matchedFiles := map[string]bool{}
		scannedFiles := 0
		totalHits := 0
		_ = c.s.walkProject(id, func(rel string, size int64, rd io.Reader) bool {
			if pre != "" && !strings.HasPrefix(rel, pre) {
				return true
			}
			if !includePlan && rel == "plan.json" {
				return true
			}
			if size <= 0 || size > maxScanFile || reSkipWorkspaceExt.MatchString(rel) {
				return true
			}
			b, err := io.ReadAll(io.LimitReader(rd, maxScanFile))
			if err != nil || bytes.IndexByte(b, 0) >= 0 {
				return true
			}
			scannedFiles++
			lines := strings.Split(string(b), "\n")
			for i, raw := range lines {
				line := strings.TrimRight(raw, "\r")
				matched := false
				if re != nil {
					matched = re.MatchString(line)
				} else {
					matched = strings.Contains(strings.ToLower(line), lowQ)
				}
				if !matched {
					continue
				}
				totalHits++
				matchedFiles[rel] = true
				if len(hits) < maxHits {
					trimmed := strings.TrimSpace(line)
					if len([]rune(trimmed)) > 240 {
						trimmed = truncRunes(trimmed, 240)
					}
					hits = append(hits, fmt.Sprintf("%s:%d: %s", rel, i+1, trimmed))
				}
			}
			return true
		})
		if totalHits == 0 {
			scope := "交付项目文件"
			if pre != "" {
				scope = pre + " 下文件"
			}
			planHint := "（已跳过 plan.json）"
			if includePlan {
				planHint = ""
			}
			out = fmt.Sprintf("未命中（扫描 %d 个文本文件%s）：在%s中未找到匹配「%s」的内容。", scannedFiles, planHint, scope, q)
		} else {
			head := fmt.Sprintf("命中 %d 处（涉及 %d 个文件，共扫描 %d 个文件）", totalHits, len(matchedFiles), scannedFiles)
			if totalHits > len(hits) {
				head += fmt.Sprintf("，仅显示前 %d 条", len(hits))
			}
			out = head + "：\n" + strings.Join(hits, "\n")
		}
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
		fromLine := 0
		if f, ok := a["from_line"].(float64); ok && f >= 1 {
			fromLine = int(f)
		}
		maxLines := 0
		if f, ok := a["max_lines"].(float64); ok && f >= 1 {
			maxLines = int(f)
			if maxLines > 400 {
				maxLines = 400
			}
		}
		_ = c.s.walkProject(id, func(rel string, size int64, rd io.Reader) bool {
			if rel != want {
				return true
			}
			if fromLine > 0 || maxLines > 0 {
				if fromLine < 1 {
					fromLine = 1
				}
				if maxLines <= 0 {
					maxLines = 160
				}
				b, _ := io.ReadAll(io.LimitReader(rd, 512<<10))
				allLines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
				total := len(allLines)
				if fromLine > total {
					out = fmt.Sprintf("文件 %s 共 %d 行，请求的起始行 %d 超出范围。", rel, total, fromLine)
					return false
				}
				end := fromLine - 1 + maxLines
				if end > total {
					end = total
				}
				body := strings.Join(allLines[fromLine-1:end], "\n")
				if len(body) > aiMaxFile {
					body = body[:aiMaxFile]
				}
				out = fmt.Sprintf("--- %s（第 %d–%d 行 / 共 %d 行）---\n%s", rel, fromLine, end, total, body)
				if end < total {
					out += fmt.Sprintf("\n…（还有 %d 行，可用 from_line=%d 继续读）", total-end, end+1)
				}
				return false
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

func (s *storeServer) deliveryComponents(jobID string) []string {
	var p struct {
		Instances []struct {
			Component string `json:"component"`
		} `json:"instances"`
	}
	_ = json.Unmarshal(s.jobPlan(jobID), &p)
	seen := map[string]bool{}
	var out []string
	for _, inst := range p.Instances {
		name := strings.TrimSpace(inst.Component)
		if name != "" && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

// componentSyncStatus compares this delivery's snapshot against the platform's current published components and any
// unpublished workbench drafts, so troubleshooting never asks engineers to re-fix bugs that are already fixed.
func (c aiToolCtx) componentSyncStatus(wantFile string) string {
	wantFile = strings.TrimSpace(wantFile)
	if wantFile != "" {
		wantFile = strings.TrimPrefix(path.Clean(wantFile), "/")
		if wantFile == "." {
			wantFile = ""
		}
		if wantFile != "" && aiDeniedFile.MatchString(wantFile) {
			return "该文件属于密钥/凭据类，不可查看差异。"
		}
	}

	j := c.job
	c.s.mu.Lock()
	if cur, ok := c.s.jobs[c.job.ID]; ok {
		j = cur
	}
	c.s.mu.Unlock()

	pv, bundle, old := c.s.previewSync(j)

	filterPaths := func(in []string) []string {
		out := []string{}
		for _, p := range in {
			if !aiDeniedFile.MatchString(p) {
				out = append(out, p)
			}
		}
		return out
	}
	changedFiles := filterPaths(pv.Files)
	removedFiles := filterPaths(pv.Removed)

	var nonLockChanged []string
	for _, f := range changedFiles {
		if f != "deployment.lock.json" {
			nonLockChanged = append(nonLockChanged, f)
		}
	}

	// Inspect live published revision & unpublished draft state for components used in this delivery.
	compNames := c.s.deliveryComponents(j.ID)
	cs := c.s.comps()
	hasCompDir := c.s.plat.componentsDir != ""

	// Also include platform-shared if it has an active draft, an override, or wantFile points to shared files.
	includeShared := strings.HasPrefix(wantFile, "roles/mw_") || strings.HasPrefix(wantFile, "files/")
	if !includeShared && hasCompDir {
		if cs.hasDraft(sharedPlatformName) || cs.liveRev(sharedPlatformName) > 0 {
			includeShared = true
		}
	}
	if includeShared {
		compNames = append(compNames, sharedPlatformName)
	}

	type compState struct {
		Name              string            `json:"name"`
		Source            string            `json:"source"`
		PublishedRev      int               `json:"published_rev"`
		LatestRevision    *revMeta          `json:"latest_revision,omitempty"`
		DraftExists       bool              `json:"draft_exists"`
		DraftBy           string            `json:"draft_by,omitempty"`
		DraftUpdated      string            `json:"draft_updated,omitempty"`
		DraftAddedFiles   []string          `json:"draft_added_files,omitempty"`
		DraftChangedFiles []string          `json:"draft_changed_files,omitempty"`
		DraftRemovedFiles []string          `json:"draft_removed_files,omitempty"`
		DraftDiffs        map[string]string `json:"draft_diffs,omitempty"`
	}

	var compStates []compState
	liveByComp := map[string]fileSet{}
	draftByComp := map[string]fileSet{}
	draftCount := 0
	draftDiffBudget := 3600

	for _, name := range compNames {
		st := compState{Name: name, Source: "unknown"}
		liveSet, src, err := cs.liveSet(name)
		if err == nil {
			st.Source = src
			liveByComp[name] = liveSet
		}
		if hasCompDir {
			if revs := cs.revisions(name); len(revs) > 0 {
				last := revs[len(revs)-1]
				st.PublishedRev = last.Rev
				st.LatestRevision = &last
			}
			if cs.hasDraft(name) {
				if dset, meta, derr := cs.readDraft(name); derr == nil {
					st.DraftExists = true
					st.DraftBy = meta.User
					st.DraftUpdated = meta.Updated
					draftCount++
					draftByComp[name] = dset
					if liveSet != nil {
						added, removed, changed := diffSets(liveSet, dset)
						st.DraftAddedFiles = filterPaths(added)
						st.DraftRemovedFiles = filterPaths(removed)
						st.DraftChangedFiles = filterPaths(changed)
						if wantFile == "" && draftDiffBudget > 0 {
							for _, f := range append(append([]string{}, st.DraftChangedFiles...), st.DraftAddedFiles...) {
								if draftDiffBudget <= 0 || !isText(dset[f]) {
									continue
								}
								d := lineDiff(string(liveSet[f]), string(dset[f]), 80)
								if d == "" {
									continue
								}
								if len(d) > draftDiffBudget {
									d = truncRunes(d, draftDiffBudget/2) + "\n…（差异已截断）"
								}
								if st.DraftDiffs == nil {
									st.DraftDiffs = map[string]string{}
								}
								st.DraftDiffs[f] = d
								draftDiffBudget -= len(d)
							}
						}
					}
				}
			}
		}
		compStates = append(compStates, st)
	}

	// Collect diffs for either the targeted file or all changed non-lock files.
	diffs := map[string]string{}
	var fileCheck map[string]any
	if wantFile != "" {
		fc := map[string]any{"file": wantFile}
		inRemoved := false
		for _, rf := range removedFiles {
			if rf == wantFile {
				inRemoved = true
				break
			}
		}
		switch {
		case pv.Diffs != nil && pv.Diffs[wantFile] != "":
			fc["status"] = "updated_in_published"
			fc["note"] = "该文件在当前最新已发布组件中已有更新（与本次交付快照不同），下方为快照→最新已发布版本的逐行差异。"
			fc["diff"] = pv.Diffs[wantFile]
		case inRemoved:
			fc["status"] = "removed_in_published"
			fc["note"] = "该文件在当前最新已发布组件中已被移除。"
		case bundle != nil:
			if nowF, ok := bundle.Project[wantFile]; ok {
				if oldData, had := old[wantFile]; had && bytes.Equal(oldData, nowF.Data) {
					fc["status"] = "same_as_published"
					fc["note"] = "当前已发布组件中的该文件与本次交付快照完全一致，尚未做过修改。"
				} else {
					fc["status"] = "updated_in_published"
					fc["note"] = "该文件在当前最新已发布组件中已有更新。"
					fc["diff"] = lineDiff(string(oldData), string(nowF.Data), 200)
				}
			} else {
				fc["status"] = "not_found_in_rendered_project"
				fc["note"] = "当前渲染后的交付项目中不包含该路径，请核对相对路径（如 roles/<组件>/tasks/...）。"
			}
		default:
			// previewSync was blocked (e.g., finished delivery or package lock changed): still compare against live component catalog.
			if old == nil {
				old, _ = c.s.projectFiles(j.ID)
			}
			matchedComp := ""
			var liveBytes []byte
			for _, name := range compNames {
				if b, ok := liveByComp[name][wantFile]; ok {
					matchedComp = name
					liveBytes = b
					break
				}
			}
			if matchedComp != "" {
				fc["component"] = matchedComp
				if oldData, had := old[wantFile]; had && bytes.Equal(oldData, liveBytes) {
					fc["status"] = "same_as_published"
					fc["note"] = "当前已发布组件中的该文件与本次交付快照完全一致，尚未做过修改。"
				} else {
					fc["status"] = "updated_in_published_sync_blocked"
					fc["note"] = "当前已发布组件中该文件已有更新，但本次交付因 sync_blocked 无法直接一键同步。"
					if isText(liveBytes) {
						fc["diff"] = lineDiff(string(oldData), string(liveBytes), 200)
					}
				}
			} else {
				fc["status"] = "not_checked_sync_blocked"
				fc["note"] = "交付同步预览被阻塞，且未在当前已发布组件目录中找到该路径。"
			}
		}
		// Check whether any unpublished draft modifies wantFile compared to published.
		for _, name := range compNames {
			dset, ok := draftByComp[name]
			if !ok {
				continue
			}
			lset := liveByComp[name]
			db, inDraft := dset[wantFile]
			lb, inLive := lset[wantFile]
			if inDraft != inLive || !bytes.Equal(db, lb) {
				fc["draft_component"] = name
				if inDraft && isText(db) {
					fc["draft_diff"] = lineDiff(string(lb), string(db), 160)
				} else if !inDraft {
					fc["draft_diff"] = "（草稿中已删除该文件）"
				}
				break
			}
		}
		fileCheck = fc
	} else {
		diffBudget := 9000
		for _, f := range nonLockChanged {
			if diffBudget <= 0 {
				break
			}
			d := pv.Diffs[f]
			if d == "" {
				continue
			}
			if len(d) > diffBudget {
				d = truncRunes(d, diffBudget/2) + "\n…（差异过长已截断，可传 file 参数单独查看该文件完整差异）"
			}
			diffs[f] = d
			diffBudget -= len(d)
		}
	}

	// Build a crisp 1-line summary for both the UI step accordion and the model.
	fileCount := len(nonLockChanged) + len(removedFiles)
	if fileCount == 0 {
		fileCount = len(changedFiles)
	}
	var summary string
	switch {
	case pv.Available:
		summary = fmt.Sprintf("存在可同步的已发布组件更新（%d 个项目文件变更，影响 %d 个步骤", fileCount, len(pv.Steps))
		if draftCount > 0 {
			summary += fmt.Sprintf("；另有 %d 个组件含未发布草稿", draftCount)
		}
		summary += "）"
	case pv.Blocked != "":
		summary = "无法直接同步组件更新：" + pv.Blocked
		if draftCount > 0 {
			summary += fmt.Sprintf("（另有 %d 个组件含未发布草稿）", draftCount)
		}
	default:
		summary = "当前交付快照与最新已发布组件完全一致（无待同步更新）"
		if draftCount > 0 {
			summary += fmt.Sprintf("，但有 %d 个组件存在未发布草稿", draftCount)
		}
	}
	if fileCheck != nil {
		if st, _ := fileCheck["status"].(string); st != "" {
			switch st {
			case "updated_in_published":
				summary += "；所查文件 " + wantFile + " 在最新已发布组件中已更新"
			case "updated_in_published_sync_blocked":
				summary += "；所查文件 " + wantFile + " 在最新已发布组件中已更新（同步受阻）"
			case "same_as_published":
				summary += "；所查文件 " + wantFile + " 与当前已发布组件一致"
			}
		}
		if dc, _ := fileCheck["draft_component"].(string); dc != "" {
			summary += "（组件 " + dc + " 草稿中有未发布改动）"
		}
	}

	payload := map[string]any{
		"sync_available": pv.Available,
		"sync_count":     len(j.Syncs),
		"changed_files":  changedFiles,
		"affected_steps": pv.Steps,
		"components":     compStates,
	}
	if pv.Blocked != "" {
		payload["sync_blocked"] = pv.Blocked
	}
	if len(removedFiles) > 0 {
		payload["removed_files"] = removedFiles
	}
	if len(pv.Why) > 0 {
		payload["why"] = pv.Why
	}
	if fileCheck != nil {
		payload["file_check"] = fileCheck
	}
	if len(diffs) > 0 {
		payload["diffs"] = diffs
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	return summary + "\n" + string(b)
}

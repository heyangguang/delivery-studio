package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"middleware-deployer/mwpack"
)

// Guided AI Change Rehearsal Workbench (变更演练工作台):
// Rather than pre-baking brittle post-deployment playbooks that assume zero drift on production, this workbench uses
// AI (only when the global AI master switch is ON) to:
//   1. Align scope & maintenance window boundaries against the cluster's initial delivery baseline (scoping);
//   2. Generate a statically verified 100% read-only inspection script to detect live topology/config drift (probing);
//   3. Walk the engineer step-by-step through rehearsing & troubleshooting commands in a test environment (rehearsing);
//   4. Finalize a verified Production Change SOP document mapped to real production hosts & exportable to Word (finalized).

var (
	reRehearsalID  = regexp.MustCompile(`^[0-9a-f]{12}$`)
	reRehearsalImg = regexp.MustCompile(`^[0-9a-f]{20}\.(png|jpg|gif|webp)$`)
	reStepID       = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,40}$`)
	rehearsalMu    sync.Mutex
)

type rehearsalTraceStep struct {
	ID     string      `json:"id"`
	Kind   string      `json:"kind"` // inspect | guard | connect | think | synthesize
	Title  string      `json:"title"`
	Detail string      `json:"detail,omitempty"`
	MS     int64       `json:"ms,omitempty"`
	OK     bool        `json:"ok"`
	Status string      `json:"status,omitempty"` // pending | running | done | warn | error
	Diag   *aiCallDiag `json:"diag,omitempty"`
}

type rehearsalPipelineSpec struct {
	PreSteps   []rehearsalTraceStep
	ThinkTitle string
	ThinkWait  string
	SynthID    string
	SynthKind  string
	SynthTitle string
	SynthWait  string
	Validate   func(string) error
}

type rehearsalTrace struct {
	Stage     string               `json:"stage"` // create | scope | probe | troubleshoot
	Model     string               `json:"model,omitempty"`
	Provider  string               `json:"provider,omitempty"`
	Thinking  string               `json:"thinking,omitempty"`
	Reasoning int                  `json:"reasoning,omitempty"`
	Steps     []rehearsalTraceStep `json:"steps,omitempty"`
	InTokens  int                  `json:"in_tokens,omitempty"`
	OutTokens int                  `json:"out_tokens,omitempty"`
	MS        int64                `json:"ms,omitempty"`
	At        string               `json:"at,omitempty"`
	Diag      *aiCallDiag          `json:"diag,omitempty"`
}

type rehearsalScopeQuestion struct {
	ID       string   `json:"id"`
	Label    string   `json:"label,omitempty"`
	Question string   `json:"question"`
	Options  []string `json:"options,omitempty"`
	Answer   string   `json:"answer,omitempty"`
}

type rehearsalDriftHost struct {
	Name        string `json:"name"`
	IP          string `json:"ip"`
	InitialRole string `json:"initial_role"`
	ActualRole  string `json:"actual_role"`
	Version     string `json:"version,omitempty"`
	Status      string `json:"status"`
}

type rehearsalDriftParam struct {
	Key     string `json:"key"`
	Initial string `json:"initial"`
	Actual  string `json:"actual"`
	Risk    string `json:"risk,omitempty"`
}

type rehearsalDrift struct {
	Summary         string                `json:"summary"`
	Drifted         bool                  `json:"drifted"`
	Hosts           []rehearsalDriftHost  `json:"hosts"`
	ParamDiffs      []rehearsalDriftParam `json:"param_diffs,omitempty"`
	Risks           []string              `json:"risks,omitempty"`
	Recommendations []string              `json:"recommendations,omitempty"`
}

type rehearsalStepProposal struct {
	Diagnosis  string `json:"diagnosis"`
	Action     string `json:"action"` // replace | insert_before
	Title      string `json:"title,omitempty"`
	TargetRole string `json:"target_role,omitempty"`
	Command    string `json:"command"`
	Expect     string `json:"expect,omitempty"`
	Rollback   string `json:"rollback,omitempty"`
	RiskNote   string `json:"risk_note,omitempty"`
}

type rehearsalStepRevision struct {
	At           string `json:"at"`
	By           string `json:"by,omitempty"`
	ErrorSnippet string `json:"error_snippet,omitempty"`
	Diagnosis    string `json:"diagnosis"`
	OldCommand   string `json:"old_command,omitempty"`
	NewCommand   string `json:"new_command"`
}

type rehearsalStep struct {
	ID           string                  `json:"id"`
	Phase        string                  `json:"phase"` // precheck | execute | verify | rollback
	Order        int                     `json:"order"`
	Title        string                  `json:"title"`
	TargetRole   string                  `json:"target_role"`
	Command      string                  `json:"command"`
	Expect       string                  `json:"expect"`
	RiskNote     string                  `json:"risk_note,omitempty"`
	Rollback     string                  `json:"rollback,omitempty"`
	Optional     bool                    `json:"optional,omitempty"`
	Status       string                  `json:"status"` // pending | passed | failed | skipped
	Elapsed      string                  `json:"elapsed,omitempty"`
	Note         string                  `json:"note,omitempty"`
	LastError    string                  `json:"last_error,omitempty"`
	ErrorImages  []string                `json:"error_images,omitempty"`
	TroubleTrace *rehearsalTrace         `json:"trouble_trace,omitempty"`
	Proposal     *rehearsalStepProposal  `json:"proposal,omitempty"`
	Revisions    []rehearsalStepRevision `json:"revisions,omitempty"`
}

type changeRehearsal struct {
	ID             string                    `json:"id"`
	ClusterID      string                    `json:"cluster_id"`
	AppID          string                    `json:"app_id"`
	AppName        string                    `json:"app_name"`
	BaseJobID      string                    `json:"base_job_id"`
	Title          string                    `json:"title"`
	Goal           string                    `json:"goal"`
	GoalImages     []string                  `json:"goal_images,omitempty"`
	ExtraScope     string                    `json:"extra_scope,omitempty"`
	Owner          string                    `json:"owner"`
	Stage          string                    `json:"stage"` // scoping | probing | rehearsing | finalized
	ScopeQuestions []rehearsalScopeQuestion  `json:"scope_questions,omitempty"`
	ScopeSummary   string                    `json:"scope_summary,omitempty"`
	ProbeScript    string                    `json:"probe_script,omitempty"`
	ProbeNotes     []string                  `json:"probe_notes,omitempty"`
	ProbeSafe      bool                      `json:"probe_safe"`
	ProbeWarnings  []string                  `json:"probe_warnings,omitempty"`
	ProbeOutput    string                    `json:"probe_output,omitempty"`
	ProbeImages    []string                  `json:"probe_images,omitempty"`
	ManualState    string                    `json:"manual_state,omitempty"`
	Drift          *rehearsalDrift           `json:"drift,omitempty"`
	TestEnvNote    string                    `json:"test_env_note,omitempty"`
	Steps          []rehearsalStep           `json:"steps,omitempty"`
	Traces         map[string]rehearsalTrace `json:"traces,omitempty"`
	DocID          string                    `json:"doc_id,omitempty"`
	CreatedAt      string                    `json:"created_at"`
	UpdatedAt      string                    `json:"updated_at"`
}

func (s *storeServer) rehearsalDir(cluster string) string {
	return filepath.Join(s.cfg.DataDir, "rehearsals", cluster)
}

func (s *storeServer) rehearsalPath(cluster, rid string) string {
	return filepath.Join(s.rehearsalDir(cluster), rid+".json")
}

func (s *storeServer) rehearsalImgDir(cluster, rid string) string {
	return filepath.Join(s.rehearsalDir(cluster), rid+"_img")
}

func (s *storeServer) storeRehearsalImages(cluster, rid string, images []string) ([]string, error) {
	if len(images) == 0 {
		return nil, nil
	}
	if len(images) > 6 {
		return nil, fmt.Errorf("单次最多上传 6 张图片")
	}
	dir := s.rehearsalImgDir(cluster, rid)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("无法创建图片存储目录")
	}
	var names []string
	for _, data := range images {
		m := reDataImage.FindStringSubmatch(data)
		if m == nil || len(data) > 6<<20 {
			return nil, fmt.Errorf("图片格式需为 png、jpg、gif 或 webp，且单张不超过 4 MiB")
		}
		raw, err := base64.StdEncoding.DecodeString(data[len(m[0]):])
		if err != nil || len(raw) == 0 {
			return nil, fmt.Errorf("图片内容无法解码")
		}
		h := sha256.Sum256(raw)
		ext := m[1]
		if ext == "jpeg" {
			ext = "jpg"
		}
		name := hex.EncodeToString(h[:10]) + "." + ext
		if err := os.WriteFile(filepath.Join(dir, name), raw, 0o600); err != nil {
			return nil, fmt.Errorf("保存图片失败")
		}
		names = append(names, name)
	}
	return names, nil
}

func (s *storeServer) rehearsalImageData(cluster, rid, name string) string {
	if !reRehearsalImg.MatchString(name) {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(s.rehearsalImgDir(cluster, rid), filepath.Base(name)))
	if err != nil {
		return ""
	}
	return "data:" + http.DetectContentType(b) + ";base64," + base64.StdEncoding.EncodeToString(b)
}

func (s *storeServer) loadRehearsal(cluster, rid string) (changeRehearsal, bool) {
	var rh changeRehearsal
	if !docClusterID.MatchString(cluster) || !reRehearsalID.MatchString(rid) {
		return rh, false
	}
	b, err := os.ReadFile(s.rehearsalPath(cluster, rid))
	if err != nil || json.Unmarshal(b, &rh) != nil || rh.ID == "" {
		return changeRehearsal{}, false
	}
	return rh, true
}

func (s *storeServer) saveRehearsal(rh changeRehearsal) error {
	rh.UpdatedAt = nowStamp()
	return writeJSONFile(s.rehearsalPath(rh.ClusterID, rh.ID), rh)
}

func (s *storeServer) listRehearsals(cluster string) []changeRehearsal {
	out := []changeRehearsal{}
	if !docClusterID.MatchString(cluster) {
		return out
	}
	entries, err := os.ReadDir(s.rehearsalDir(cluster))
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		rid := strings.TrimSuffix(e.Name(), ".json")
		if rh, ok := s.loadRehearsal(cluster, rid); ok {
			out = append(out, rh)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

func (s *storeServer) listFinalizedRehearsals(cluster string) []changeRehearsal {
	all := s.listRehearsals(cluster)
	var out []changeRehearsal
	for _, rh := range all {
		if rh.Stage == "finalized" {
			out = append(out, rh)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out
}

func (s *storeServer) finalizedRehearsalDocIDs(cluster string) []string {
	var ids []string
	for _, rh := range s.listFinalizedRehearsals(cluster) {
		ids = append(ids, "sop-"+rh.ID)
	}
	return ids
}

// ---- static read-only probe script validator ----

var (
	reSafeDevNullRedir = regexp.MustCompile(`(?:\d*>&\d+|\d*>\s*/dev/(?:null|stdout|stderr)|&>\s*/dev/(?:null|stdout|stderr))`)
	reSubshellEval     = regexp.MustCompile(`(?i)\b(?:(?:ba|z|da|k)?sh\s+-[a-zA-Z]*c|eval)\b`)
	reQuotedSpan       = regexp.MustCompile(`'[^']*'|"(?:\\.|[^"\\])*"`)
	reBashTestOrArith  = regexp.MustCompile(`\[\[[^\n]*?\]\]|\(\([^\n]*?\)\)`)
	reFileRedir        = regexp.MustCompile(`(^|[^0-9>&=-])>{1,2}\s*[^&\s=]`)

	probeMutatingRules = []struct {
		re  *regexp.Regexp
		why string
	}{
		{regexp.MustCompile(`(?i)\b(rm|mv|dd|mkfs(\.\w+)?|wipefs|fdisk|parted|shred|truncate)\b`), "包含文件或磁盘修改/删除命令"},
		{regexp.MustCompile(`(?i)\b(cp|chmod|chown|mkdir|rmdir|touch|install|tee)\b`), "包含目录、文件写入或权限变更命令"},
		{regexp.MustCompile(`(?i)\bsed\s+-[a-zA-Z]*i`), "包含 sed -i 原地修改文件操作"},
		{regexp.MustCompile(`(?i)\bsystemctl\s+(start|stop|restart|reload|try-restart|reload-or-restart|enable|disable|mask|unmask|kill)\b`), "包含 systemctl 服务状态变更操作"},
		{regexp.MustCompile(`(?i)\bservice\s+\S+\s+(start|stop|restart|reload|force-reload)\b`), "包含 service 服务启停操作"},
		{regexp.MustCompile(`(?i)\b(kill|pkill|killall|reboot|shutdown|halt|poweroff|init\s+[06])\b`), "包含进程终止或机器重启/关机指令"},
		{regexp.MustCompile(`(?i)\bsysctl\s+-w\b`), "包含 sysctl -w 内核参数修改操作"},
		{regexp.MustCompile(`(?i)\b(apt|apt-get|yum|dnf|zypper)\s+(install|upgrade|dist-upgrade|update|remove|purge|erase|autoremove|reinstall)\b`), "包含系统软件包安装/升级/卸载操作"},
		{regexp.MustCompile(`(?i)\b(rpm\s+-[a-zA-Z]*[iUe]|dpkg\s+-[a-zA-Z]*[irP]|pip\d?\s+(install|uninstall))\b`), "包含底层包安装或卸载操作"},
		{regexp.MustCompile(`(?i)\bansible-playbook\b`), "采集脚本不允许调用 ansible-playbook"},
		{regexp.MustCompile(`(?i)\bpatronictl\b[^\n]*\b(switchover|failover|restart|reload|reinit|edit-config|remove|pause|resume)\b`), "包含 patronictl 集群控制/切换动作"},
		{regexp.MustCompile(`(?i)\betcdctl\b[^\n]*\b(put|del|compaction|defrag|snapshot\s+restore|member\s+(add|remove|update|promote))\b`), "包含 etcdctl 数据写入或成员变更动作"},
		{regexp.MustCompile(`(?i)\bredis-cli\b[^\n]*\b(config\s+set|config\s+rewrite|flushall|flushdb|slaveof|replicaof|cluster\s+(failover|reset|addslots|delslots|meet|forget)|shutdown|bgrewriteaof)\b`), "包含 redis-cli 状态或配置修改动作"},
		{regexp.MustCompile(`(?i)\bpg_ctl\b[^\n]*\b(start|stop|restart|reload|promote|kill)\b`), "包含 pg_ctl 数据库启停或升主动作"},
		{regexp.MustCompile(`(?i)\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|DATABASE|ROLE|USER|INDEX|SCHEMA|EXTENSION)|ALTER\s+(SYSTEM|TABLE|DATABASE|ROLE|USER|SCHEMA)|TRUNCATE\s+|CREATE\s+(TABLE|DATABASE|ROLE|USER|INDEX|EXTENSION)|GRANT\s+|REVOKE\s+|pg_promote|pg_reload_conf|pg_terminate_backend)\b`), "包含数据库写操作或变更控制语句"},
	}
)

// validateReadOnlyProbeScript statically checks that a generated inspection script contains zero mutating shell/SQL commands.
func validateReadOnlyProbeScript(script string) (bool, []string) {
	trimmed := strings.TrimSpace(script)
	if trimmed == "" {
		return false, []string{"采集脚本内容为空"}
	}
	var nonComment []string
	for _, line := range strings.Split(trimmed, "\n") {
		l := strings.TrimSpace(line)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		nonComment = append(nonComment, l)
	}
	body := strings.Join(nonComment, "\n")
	seen := map[string]bool{}
	var warnings []string
	addWarn := func(msg string) {
		if !seen[msg] {
			seen[msg] = true
			warnings = append(warnings, msg)
		}
	}
	for _, rule := range probeMutatingRules {
		if rule.re.MatchString(body) {
			addWarn(rule.why)
		}
	}
	for _, line := range nonComment {
		cleaned := line
		if !reSubshellEval.MatchString(cleaned) {
			cleaned = reQuotedSpan.ReplaceAllString(cleaned, `""`)
		}
		cleaned = reBashTestOrArith.ReplaceAllString(cleaned, "")
		cleaned = reSafeDevNullRedir.ReplaceAllString(cleaned, "")
		if reFileRedir.MatchString(cleaned) {
			addWarn("包含向文件写入的重定向操作（仅允许重定向到 /dev/null 或标准流）")
			break
		}
	}
	return len(warnings) == 0, warnings
}

// ---- cluster baseline context for rehearsal prompts ----

func (s *storeServer) clusterBaselinePrompt(f clusterFacts) (string, *aiRedactor) {
	var b strings.Builder
	var hostNames []string
	fmt.Fprintf(&b, "集群标识：%s\n应用组件：%s %s\n初始交付任务：%s（状态：%s）\n", f.ID, f.Current.AppName, f.Current.Version, f.Current.ID, jobOutcomeName(f.Current))
	if f.Current.OutcomeNote != "" {
		fmt.Fprintf(&b, "首次部署现场登记说明：%s\n", aiScrub(f.Current.OutcomeNote))
	}
	if f.Plan != nil {
		fmt.Fprintf(&b, "操作系统平台：%s\n控制节点：%s\n", f.Plan.Platform.ID, f.Plan.Controller)
		b.WriteString("初始交付机器清单：\n")
		for _, h := range f.Plan.Hosts {
			hostNames = append(hostNames, h.Name)
			fmt.Fprintf(&b, "  - %s: %s\n", h.Name, h.IP)
		}
		b.WriteString("初始交付实例与角色拓扑：\n")
		for _, inst := range f.Plan.Instances {
			if inst.External {
				continue
			}
			var roles []string
			for _, r := range inst.R.Roles {
				if hs := inst.Roles[r.Name]; len(hs) > 0 {
					roles = append(roles, fmt.Sprintf("%s=[%s]", firstNonEmptyStr(r.Title, r.Name), strings.Join(hs, ",")))
				}
			}
			fmt.Fprintf(&b, "  - 实例 %s（%s %s）：%s\n", inst.ID, inst.Title, inst.Version, strings.Join(roles, "；"))
			if len(inst.Spec.Params) > 0 {
				keys := make([]string, 0, len(inst.Spec.Params))
				for k := range inst.Spec.Params {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				var kvs []string
				for _, k := range keys {
					kvs = append(kvs, fmt.Sprintf("%s=%s", k, show(inst.Spec.Params[k])))
				}
				fmt.Fprintf(&b, "    定制参数：%s\n", aiScrub(strings.Join(kvs, ", ")))
			}
			for _, ep := range inst.Endpoints {
				if fr, ok := inst.Fronts[ep.Name]; ok {
					fmt.Fprintf(&b, "    对外入口 %s：%s:%d（经 %s）\n", ep.Name, fr.Address, fr.Listen, fr.Balancer)
				}
			}
			if ops := inst.InstanceOperations(f.ID); ops != nil {
				if len(ops.Checks) > 0 {
					b.WriteString("    组件内置只读巡检参考命令：\n")
					for i, ck := range ops.Checks {
						if i >= 6 {
							break
						}
						fmt.Fprintf(&b, "      * %s: %s\n", ck.Title, strings.ReplaceAll(strings.TrimSpace(ck.Cmd), "\n", " ; "))
					}
				}
				if len(ops.Tasks) > 0 {
					b.WriteString("    组件内置标准运维动作参考：\n")
					for i, tk := range ops.Tasks {
						if i >= 6 {
							break
						}
						fmt.Fprintf(&b, "      * %s: %s\n", tk.Title, strings.ReplaceAll(strings.TrimSpace(tk.Cmd), "\n", " ; "))
					}
				}
			}
		}
	}
	if pk := s.lockPackages(f.Current.ID); len(pk) > 0 {
		names := make([]string, 0, len(pk))
		for n := range pk {
			names = append(names, n)
		}
		sort.Strings(names)
		var items []string
		for i, n := range names {
			if i >= 20 {
				break
			}
			items = append(items, n+"="+strings.Join(pk[n], "/"))
		}
		fmt.Fprintf(&b, "初始离线锁定核心包：%s\n", strings.Join(items, ", "))
	}
	var red *aiRedactor
	if s.aiLoad().RedactHosts {
		red = newAIRedactor(hostNames)
	}
	return aiScrub(b.String()), red
}

func wantsRehearsalStream(r *http.Request) bool {
	return r.URL.Query().Get("stream") == "1" || strings.Contains(r.Header.Get("Accept"), "text/event-stream")
}

func startRehearsalSSE(w http.ResponseWriter, r *http.Request) *sse {
	if !wantsRehearsalStream(r) {
		return nil
	}
	fl, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ev := sse{w: w, f: fl}
	return &ev
}

var reJSONThinkingStart = regexp.MustCompile(`"thinking"\s*:\s*"`)

// extractLiveJSONThinking incrementally unescapes the leading "thinking" string field from a streaming JSON payload
// and detects the active downstream section key so even non-reasoning models stream live thought & progress transparently.
func extractLiveJSONThinking(raw string) (thinking string, phase string) {
	loc := reJSONThinkingStart.FindStringIndex(raw)
	if loc != nil {
		s := raw[loc[1]:]
		var out strings.Builder
		for i := 0; i < len(s); {
			c := s[i]
			if c == '"' {
				break
			}
			if c == '\\' {
				if i+1 >= len(s) {
					break
				}
				switch s[i+1] {
				case '"', '\\', '/':
					out.WriteByte(s[i+1])
					i += 2
				case 'n':
					out.WriteByte('\n')
					i += 2
				case 'r':
					out.WriteByte('\r')
					i += 2
				case 't':
					out.WriteByte('\t')
					i += 2
				case 'u':
					if i+6 > len(s) {
						i = len(s)
						break
					}
					if v, err := strconv.ParseUint(s[i+2:i+6], 16, 32); err == nil {
						out.WriteRune(rune(v))
					}
					i += 6
				default:
					out.WriteByte(s[i+1])
					i += 2
				}
				continue
			}
			if !utf8.FullRuneInString(s[i:]) {
				break
			}
			r, w := utf8.DecodeRuneInString(s[i:])
			out.WriteRune(r)
			i += w
		}
		thinking = out.String()
	}
	switch {
	case strings.Contains(raw, `"steps"`):
		phase = "正在编排测试环境分步演练序列（预检 / 执行 / 验收 / 回退）…"
	case strings.Contains(raw, `"drift"`):
		phase = "正在逐台对比初始交付基线与生产现场真实状态…"
	case strings.Contains(raw, `"probe_script"`):
		phase = "正在编写 100% 纯只读现场采集探针脚本…"
	case strings.Contains(raw, `"questions"`):
		phase = "正在提炼维护窗口与高可用边界澄清问题…"
	case strings.Contains(raw, `"command"`):
		phase = "正在生成可直接采纳的修订命令提案…"
	case strings.Contains(raw, `"diagnosis"`):
		phase = "正在分析测试环境报错根因…"
	}
	return thinking, phase
}

func (s *storeServer) rehearsalCheckAI(user string, needVision bool, pick string) ([]aiProvider, int, error) {
	st := s.aiLoad()
	if !st.Enabled {
		return nil, 409, fmt.Errorf("平台 AI 总开关当前已关闭，请管理员开启 AI 后再使用变更演练")
	}
	if !st.Features["change_rehearsal"].Enabled {
		return nil, 409, fmt.Errorf("「变更演练」功能当前未开启，请管理员在平台设置 → AI 中启用")
	}
	pick = strings.TrimSpace(pick)
	providers := st.aiProvidersForPick("change_rehearsal", pick)
	if pick != "" && s.can(user, "ai.settings") {
		pid, mid, _ := strings.Cut(pick, "|")
		for _, p := range st.Providers {
			if p.ID != pid || !p.Enabled || (p.KeyEnc == "" && !p.Private) || (st.PrivateOnly && !p.Private) {
				continue
			}
			var chosen aiModel
			found := false
			if mid != "" {
				if m, ok := p.model(mid); ok && m.Enabled {
					chosen, found = m, true
				}
			} else {
				for _, m := range p.Models {
					if m.Enabled {
						chosen, found = m, true
						break
					}
				}
			}
			if found {
				picked := []aiProvider{p.withModel(chosen)}
				for _, b := range providers {
					if b.ID != p.ID || b.Model != chosen.ID {
						picked = append(picked, b)
					}
				}
				providers = picked
				break
			}
		}
	}
	if len(providers) == 0 {
		return nil, 409, fmt.Errorf("没有可用的模型供应商，请管理员在平台设置 → AI 中配置模型")
	}
	if st.MonthlyLimit > 0 && s.aiCallsThisMonth(user) >= st.MonthlyLimit {
		return nil, 429, fmt.Errorf("本月 AI 使用次数已达上限")
	}
	if needVision && providers[0].Vision == "no" {
		return nil, 409, fmt.Errorf("当前变更演练模型不支持识别截图，请粘贴文字回显，或切换支持视觉的模型")
	}
	return providers, 200, nil
}

func fmtTraceMS(ms int64) string {
	if ms < 1000 {
		return fmt.Sprintf("%dms", max(1, ms))
	}
	return fmt.Sprintf("%.1fs", float64(ms)/1000.0)
}

func finalizeTraceSynth(trace *rehearsalTrace, ev *sse, id, detail string, ok bool, ms int64) {
	stStatus := "done"
	if !ok {
		stStatus = "warn"
	}
	for i := range trace.Steps {
		if trace.Steps[i].ID == id {
			trace.Steps[i].Detail = detail
			trace.Steps[i].OK = ok
			trace.Steps[i].Status = stStatus
			if ms > 0 {
				trace.Steps[i].MS = ms
			} else if trace.Steps[i].MS == 0 {
				trace.Steps[i].MS = 1
			}
			if ev != nil {
				ev.send(map[string]any{"t": "step", "step": trace.Steps[i]})
			}
			return
		}
	}
	fallback := rehearsalTraceStep{
		ID:     id,
		Kind:   "synthesize",
		Title:  "完成结构化方案编排",
		Detail: detail,
		MS:     max(1, ms),
		OK:     ok,
		Status: stStatus,
	}
	trace.Steps = append(trace.Steps, fallback)
	if ev != nil {
		ev.send(map[string]any{"t": "step", "step": fallback})
	}
}

func (s *storeServer) rehearsalRunAI(
	r *http.Request,
	providers []aiProvider,
	user, target, session, stageKey string,
	red *aiRedactor,
	sys, prompt string,
	imageDataURLs []string,
	spec rehearsalPipelineSpec,
	effort thinkLevel,
	ev *sse,
) (string, rehearsalTrace, int, error) {
	prepStart := time.Now()
	sendSys, sendPrompt := aiScrub(sys), aiScrub(prompt)
	if red != nil {
		sendSys = red.out(sendSys)
		sendPrompt = red.out(sendPrompt)
	}
	var userContent any = sendPrompt
	if len(imageDataURLs) > 0 {
		parts := []map[string]any{{"type": "text", "text": sendPrompt}}
		for _, url := range imageDataURLs {
			if url != "" {
				parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": url}})
			}
		}
		if len(parts) > 1 {
			userContent = parts
		}
	}
	msgs := []aiMessage{{Role: "system", Content: sendSys}, {Role: "user", Content: userContent}}

	preSteps := make([]rehearsalTraceStep, len(spec.PreSteps))
	prepMS := max(1, time.Since(prepStart).Milliseconds())
	for i, st := range spec.PreSteps {
		if st.Status == "" {
			st.Status = "done"
		}
		if st.MS == 0 {
			st.MS = prepMS
		}
		preSteps[i] = st
	}

	firstProv := ""
	firstModel := ""
	if len(providers) > 0 {
		firstProv = firstNonEmptyStr(providers[0].Name, "模型网关")
		firstModel = providers[0].Model
	}
	connectStep := rehearsalTraceStep{
		ID:     "connect-model",
		Kind:   "connect",
		Title:  "连接模型网关与投递上下文",
		Detail: fmt.Sprintf("正在连接 %s · %s 并投递脱敏上下文…", firstProv, firstModel),
		OK:     true,
		Status: "running",
	}
	thinkStep := rehearsalTraceStep{
		ID:     "model-think",
		Kind:   "think",
		Title:  firstNonEmptyStr(spec.ThinkTitle, "推演集群拓扑与变更风险"),
		Detail: "等待模型通道返回首包后展开推演",
		OK:     true,
		Status: "pending",
	}
	synthStep := rehearsalTraceStep{
		ID:     firstNonEmptyStr(spec.SynthID, "synth-output"),
		Kind:   firstNonEmptyStr(spec.SynthKind, "synthesize"),
		Title:  firstNonEmptyStr(spec.SynthTitle, "生成结构化演练结果"),
		Detail: firstNonEmptyStr(spec.SynthWait, "等待风险推演完成后编排输出"),
		OK:     true,
		Status: "pending",
	}

	trace := rehearsalTrace{
		Stage: stageKey,
		Steps: append(append([]rehearsalTraceStep(nil), preSteps...), connectStep, thinkStep, synthStep),
		At:    nowStamp(),
	}
	if ev != nil {
		for _, st := range trace.Steps {
			ev.send(map[string]any{"t": "step", "step": st})
		}
	}

	var err error
	var failedAttempts []aiAttemptDiag
	overallStart := time.Now()
	for i, p := range providers {
		if len(imageDataURLs) > 0 && p.Vision == "no" {
			msgs[1] = aiMessage{Role: "user", Content: sendPrompt + fmt.Sprintf("\n（附带 %d 张现场截图，备用模型不支持视觉识别）", len(imageDataURLs))}
		}
		provLabel := firstNonEmptyStr(p.Name, "模型网关")
		connectStep.Status = "running"
		connectStep.OK = true
		connectStep.Diag = nil
		if i > 0 {
			connectStep.Detail = fmt.Sprintf("正在切换备用节点 %s · %s 重试连接…", provLabel, p.Model)
		} else {
			connectStep.Detail = fmt.Sprintf("正在连接 %s · %s 并投递脱敏上下文…", provLabel, p.Model)
		}
		if ev != nil {
			ev.send(map[string]any{"t": "meta", "model": p.Model, "provider": p.Name, "failover": i > 0})
			ev.send(map[string]any{"t": "step", "step": connectStep})
			ev.send(map[string]any{"t": "phase", "v": connectStep.Detail})
		}

		start := time.Now()
		ctx, cancel := context.WithTimeout(r.Context(), 420*time.Second)
		if effort != "" {
			ctx = withEffort(ctx, string(effort))
		}
		var nativeThinking strings.Builder
		var rawStream strings.Builder
		sentJSONThinkLen := 0
		lastPhase := ""
		lastProgressAt := time.Time{}
		lastBeatAt := time.Time{}
		beatCount := 0
		var connHandsMS int64
		gotFirstToken := false
		var firstTokenAt time.Time
		var synthStartedAt time.Time

		markFirstToken := func() {
			if gotFirstToken {
				return
			}
			gotFirstToken = true
			firstTokenAt = time.Now()
			ttft := max(1, firstTokenAt.Sub(start).Milliseconds())
			connectStep.Status = "done"
			connectStep.OK = true
			connectStep.MS = ttft
			connectStep.Detail = fmt.Sprintf("%s · %s 首包响应 %s", provLabel, p.Model, fmtTraceMS(ttft))

			thinkStep.Status = "running"
			thinkStep.Detail = firstNonEmptyStr(spec.ThinkWait, "正在结合集群拓扑与运行参数展开风险推演…")
			if ev != nil {
				ev.send(map[string]any{"t": "step", "step": connectStep})
				ev.send(map[string]any{"t": "step", "step": thinkStep})
				ev.send(map[string]any{"t": "phase", "v": thinkStep.Detail})
			}
		}

		ctx = withConnect(ctx, func(connMS int64) {
			connHandsMS = connMS
			if gotFirstToken || ev == nil {
				return
			}
			connectStep.Detail = fmt.Sprintf("网关已握手（%s），正在等待 %s 首包生成…", fmtTraceMS(connMS), p.Model)
			ev.send(map[string]any{"t": "step", "step": connectStep})
			ev.send(map[string]any{"t": "phase", "v": connectStep.Detail})
		})

		ctx = withStreamBeat(ctx, func(kind string) {
			if gotFirstToken || ev == nil {
				return
			}
			beatCount++
			if !lastBeatAt.IsZero() && time.Since(lastBeatAt) < 1500*time.Millisecond {
				return
			}
			lastBeatAt = time.Now()
			waitMS := max(1, time.Since(start).Milliseconds())
			if connHandsMS > 0 {
				connectStep.Detail = fmt.Sprintf("网关流式通道活跃（握手 %s · 已收 %d 帧，%s），%s 正在深度思考推演…", fmtTraceMS(connHandsMS), beatCount, fmtTraceMS(waitMS), p.Model)
			} else {
				connectStep.Detail = fmt.Sprintf("网关流式通道活跃（已收 %d 帧，%s），%s 正在深度思考推演…", beatCount, fmtTraceMS(waitMS), p.Model)
			}
			ev.send(map[string]any{"t": "step", "step": connectStep})
			ev.send(map[string]any{"t": "phase", "v": connectStep.Detail})
		})

		ctx = withThinking(ctx, func(delta string) {
			clean := delta
			if red != nil {
				clean = red.back(clean)
			}
			if clean == "" {
				return
			}
			markFirstToken()
			nativeThinking.WriteString(clean)
			if ev != nil {
				ev.send(map[string]any{"t": "think", "v": clean})
			}
		})
		onText := func(delta string) {
			if delta != "" {
				markFirstToken()
			}
			rawStream.WriteString(delta)
			if ev == nil {
				return
			}
			curRaw := rawStream.String()
			if red != nil {
				curRaw = red.back(curRaw)
			}
			jt, ph := extractLiveJSONThinking(curRaw)
			if nativeThinking.Len() == 0 && len(jt) > sentJSONThinkLen {
				chunk := jt[sentJSONThinkLen:]
				sentJSONThinkLen = len(jt)
				ev.send(map[string]any{"t": "think", "v": chunk})
			}
			if ph != "" && ph != lastPhase {
				lastPhase = ph
				if thinkStep.Status != "done" {
					thinkStep.Status = "done"
					thinkStep.OK = true
					thinkStep.MS = max(1, time.Since(firstTokenAt).Milliseconds())
					thinkStep.Detail = "已完成集群拓扑与高可用风险推演"
					ev.send(map[string]any{"t": "step", "step": thinkStep})
				}
				if synthStartedAt.IsZero() {
					synthStartedAt = time.Now()
				}
				synthStep.Status = "running"
				synthStep.Detail = ph
				ev.send(map[string]any{"t": "step", "step": synthStep})
				ev.send(map[string]any{"t": "phase", "v": ph})
			} else if time.Since(lastProgressAt) >= 180*time.Millisecond {
				lastProgressAt = time.Now()
				ev.send(map[string]any{"t": "progress", "chars": utf8.RuneCountInString(curRaw)})
			}
		}

		reply, chatErr := s.aiChat(ctx, p, msgs, nil, onText)
		cancel()
		err = chatErr
		txt := strings.TrimSpace(reply.Text)
		if err == nil && red != nil {
			txt = red.back(txt)
		}
		if err == nil && spec.Validate != nil {
			if vErr := spec.Validate(txt); vErr != nil {
				var dCopy aiCallDiag
				if reply.Diag != nil {
					dCopy = *reply.Diag
				} else {
					dCopy = aiCallDiag{
						Provider:   p.Name,
						Model:      p.Model,
						API:        providerAPIName(p),
						HTTPStatus: 200,
						MS:         max(1, time.Since(start).Milliseconds()),
						InTokens:   reply.In,
						OutTokens:  reply.Out,
					}
				}
				if dCopy.ReasonCode == "" {
					dCopy.ReasonCode = "invalid_output"
				}
				if dCopy.ResponseRaw == "" && txt != "" {
					dCopy.ResponseRaw = s.scrubDiagText(p, txt)
				}
				reply.Diag = &dCopy
				if !gotFirstToken {
					markFirstToken()
				}
				if thinkStep.Status != "done" {
					thinkStep.Status = "done"
					thinkStep.OK = true
					thinkStep.MS = max(1, time.Since(firstTokenAt).Milliseconds())
					thinkStep.Detail = "已完成集群拓扑与高可用风险推演"
				}
				err = &aiCallError{Msg: vErr.Error(), Diag: &dCopy, Err: vErr}
			}
		}

		u := usageFrom(p, reply)
		u.User, u.IP, u.Feature, u.Target, u.Session = user, clientIP(r), "change_rehearsal", target, session
		u.MS, u.OK, u.Failover = time.Since(start).Milliseconds(), err == nil, i > 0
		if err != nil {
			u.Error = truncRunes(err.Error(), 200)
			if d := aiDiagFromErr(err); d != nil {
				u.applyDiag(d)
				if len(d.Attempts) > 0 {
					for _, att := range d.Attempts {
						if len(providers) > 1 && att.RequestNote != "" && !strings.Contains(att.RequestNote, provLabel) {
							att.RequestNote = provLabel + " · " + p.Model + " / " + att.RequestNote
						}
						failedAttempts = append(failedAttempts, att)
					}
				} else {
					failedAttempts = append(failedAttempts, aiAttemptDiag{
						Endpoint:     d.Endpoint,
						API:          d.API,
						HTTPStatus:   d.HTTPStatus,
						MS:           max(1, d.MS),
						ResponseID:   d.ResponseID,
						Reason:       d.ReasonCode,
						InTokens:     d.InTokens,
						OutTokens:    d.OutTokens,
						CachedTokens: d.CachedTokens,
						SSEEvents:    d.SSEEvents,
						Keepalives:   d.Keepalives,
						RequestNote:  provLabel + " · " + p.Model,
					})
				}
			}
		}
		s.aiRecordUsage(u)

		if err == nil {
			if !gotFirstToken {
				markFirstToken()
			}
			if thinkStep.Status != "done" {
				thinkStep.Status = "done"
				thinkStep.OK = true
				thinkStep.MS = max(1, time.Since(firstTokenAt).Milliseconds())
				thinkStep.Detail = "已完成集群拓扑与高可用风险推演"
				if ev != nil {
					ev.send(map[string]any{"t": "step", "step": thinkStep})
				}
			}
			if !synthStartedAt.IsZero() {
				synthStep.MS = max(1, time.Since(synthStartedAt).Milliseconds())
			}
			if synthStep.Status == "pending" {
				synthStep.Status = "running"
				if ev != nil {
					ev.send(map[string]any{"t": "step", "step": synthStep})
				}
			}
			finalThink := strings.TrimSpace(nativeThinking.String())
			if finalThink == "" {
				jt, _ := extractLiveJSONThinking(txt)
				finalThink = strings.TrimSpace(jt)
			}
			trace.Model = p.Model
			trace.Provider = p.Name
			trace.Thinking = truncRunes(finalThink, 12000)
			trace.Reasoning = reply.Reasoning
			trace.InTokens = reply.In
			trace.OutTokens = reply.Out
			trace.MS = max(1, time.Since(overallStart).Milliseconds())
			if reply.Diag != nil && (reply.Diag.FallbackUsed != "" || len(failedAttempts) > 0) {
				cp := *reply.Diag
				if len(failedAttempts) > 0 {
					cp.Attempts = append(append([]aiAttemptDiag(nil), failedAttempts...), cp.Attempts...)
				}
				trace.Diag = &cp
			}
			trace.Steps = append(append([]rehearsalTraceStep(nil), preSteps...), connectStep, thinkStep, synthStep)
			return txt, trace, 200, nil
		}
		if r.Context().Err() != nil {
			return "", trace, 499, err
		}
		if i+1 < len(providers) {
			if ev != nil {
				ev.send(map[string]any{"t": "phase", "v": "主模型响应异常，正在自动切换备用模型重试…"})
			}
			continue
		}

		var finalDiag *aiCallDiag
		if d := aiDiagFromErr(err); d != nil {
			cp := *d
			if len(failedAttempts) > len(cp.Attempts) {
				cp.Attempts = failedAttempts
			}
			cp.MS = max(cp.MS, time.Since(overallStart).Milliseconds())
			finalDiag = &cp
			err = &aiCallError{Msg: err.Error(), Diag: finalDiag, Err: err}
		}
		trace.Diag = finalDiag

		failMS := max(1, time.Since(start).Milliseconds())
		failSummary := truncRunes(cleanUpstreamErrText(err.Error()), 160)
		if !gotFirstToken {
			connectStep.Status = "error"
			connectStep.OK = false
			connectStep.MS = failMS
			connectStep.Detail = failSummary
			connectStep.Diag = finalDiag
			if ev != nil {
				ev.send(map[string]any{"t": "step", "step": connectStep})
			}
		} else if thinkStep.Status != "done" {
			thinkStep.Status = "error"
			thinkStep.OK = false
			thinkStep.MS = max(1, time.Since(firstTokenAt).Milliseconds())
			thinkStep.Detail = failSummary
			thinkStep.Diag = finalDiag
			if ev != nil {
				ev.send(map[string]any{"t": "step", "step": thinkStep})
			}
		} else {
			synthStep.Status = "error"
			synthStep.OK = false
			synthStep.MS = failMS
			synthStep.Detail = failSummary
			synthStep.Diag = finalDiag
			if ev != nil {
				ev.send(map[string]any{"t": "step", "step": synthStep})
			}
		}
		trace.Steps = append(append([]rehearsalTraceStep(nil), preSteps...), connectStep, thinkStep, synthStep)
	}
	return "", trace, 502, err
}

func finishRehearsalResp(w http.ResponseWriter, ev *sse, status int, rh changeRehearsal) {
	if ev != nil {
		ev.send(map[string]any{"t": "done", "rehearsal": rh})
		return
	}
	sWriteJSON(w, status, rh)
}

func failRehearsalResp(s *storeServer, w http.ResponseWriter, ev *sse, code int, msg string, diags ...*aiCallDiag) {
	var diag *aiCallDiag
	for _, d := range diags {
		if d != nil {
			diag = d
			break
		}
	}
	if ev != nil {
		payload := map[string]any{"t": "error", "v": msg, "code": code}
		if diag != nil {
			payload["diag"] = diag
		}
		ev.send(payload)
		return
	}
	if diag != nil {
		sWriteJSON(w, code, map[string]any{"error": msg, "diag": diag})
		return
	}
	s.fail(w, code, msg)
}

func sWriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ---- HTTP router under /api/clusters/{id}/rehearsals ----

func (s *storeServer) handleRehearsals(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, parts []string) {
	// Listing and viewing existing sessions only require delivery.view, but when AI master switch is OFF we block
	// mutating rehearsal operations completely to honor the strict Scheme 1 / Scheme 2 boundary.
	if len(parts) == 0 && r.Method == "GET" {
		if !s.aiStatus().Enabled {
			s.writeJSON(w, 200, []changeRehearsal{})
			return
		}
		s.writeJSON(w, 200, s.listRehearsals(f.ID))
		return
	}
	if !s.aiStatus().Enabled {
		s.fail(w, 409, "平台 AI 功能当前未开启，无法使用变更演练工作台")
		return
	}
	if len(parts) == 3 && parts[1] == "img" && r.Method == "GET" {
		rid, name := parts[0], parts[2]
		if !reRehearsalID.MatchString(rid) || !reRehearsalImg.MatchString(name) {
			s.fail(w, 404, "图片不存在")
			return
		}
		b, err := os.ReadFile(filepath.Join(s.rehearsalImgDir(f.ID, rid), name))
		if err != nil {
			s.fail(w, 404, "图片不存在")
			return
		}
		w.Header().Set("Content-Type", http.DetectContentType(b))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "private, max-age=86400")
		_, _ = w.Write(b)
		return
	}
	if f.Current.DeliveryMode == "configuration" {
		s.fail(w, 409, "仅配置交付不代表现场已安装集群，不支持变更演练")
		return
	}
	if len(parts) == 0 && r.Method == "POST" {
		s.createRehearsal(w, r, session, f)
		return
	}
	if len(parts) < 1 || !reRehearsalID.MatchString(parts[0]) {
		s.fail(w, 404, "演练会话不存在")
		return
	}
	rid := parts[0]
	switch {
	case len(parts) == 1 && r.Method == "GET":
		rh, ok := s.loadRehearsal(f.ID, rid)
		if !ok {
			s.fail(w, 404, "演练会话不存在")
			return
		}
		s.writeJSON(w, 200, rh)
	case len(parts) == 1 && r.Method == "DELETE":
		rehearsalMu.Lock()
		_, ok := s.loadRehearsal(f.ID, rid)
		if ok {
			_ = os.Remove(s.rehearsalPath(f.ID, rid))
			_ = os.RemoveAll(s.rehearsalImgDir(f.ID, rid))
		}
		rehearsalMu.Unlock()
		if !ok {
			s.fail(w, 404, "演练会话不存在")
			return
		}
		s.auditReq(r, "rehearsal-delete", session.User, f.ID+" "+rid)
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case len(parts) == 2 && parts[1] == "scope" && r.Method == "POST":
		s.submitRehearsalScope(w, r, session, f, rid)
	case len(parts) == 2 && parts[1] == "probe" && r.Method == "POST":
		s.submitRehearsalProbe(w, r, session, f, rid)
	case len(parts) == 3 && parts[1] == "steps" && r.Method == "PATCH":
		s.patchRehearsalStep(w, r, session, f, rid, parts[2])
	case len(parts) == 4 && parts[1] == "steps" && parts[3] == "troubleshoot" && r.Method == "POST":
		s.troubleshootRehearsalStep(w, r, session, f, rid, parts[2])
	case len(parts) == 4 && parts[1] == "steps" && parts[3] == "apply" && r.Method == "POST":
		s.applyRehearsalProposal(w, r, session, f, rid, parts[2])
	case len(parts) == 2 && parts[1] == "finalize" && r.Method == "POST":
		s.finalizeRehearsal(w, r, session, f, rid)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

const rehearsalScopeSystem = `你是资深离线中间件变更架构师。用户打算对一个已经部署运行的生产中间件集群做变更。
因为生产集群可能已经发生过主从切换、参数手动调整或周边环境变化，你第一步只需做「诉求与边界对齐」：
- 阅读平台提供的初始交付拓扑、关键参数与用户的变更诉求（若附带架构/工单截图请一并识别）；
- 先在 JSON 第一个字段 thinking 中用清晰的要点写出你的分析推演过程（核对了哪些初始拓扑角色、定制参数风险点、高可用切换机制，以及为什么需要确认这些前提）；
- 给出 1 句话的变更边界摘要（scope_summary），并提出 2 到 4 个最关键的边界确认项（聚焦维护窗口与闪断口径、目标离线包/节点就绪度、应用连接重试机制、备份与演练条件）；
- 每项必须精炼克制，禁止把三四个子问题塞进一个长句：
  * label：4～6 字维度短标签（如「版本与离线包」「拓扑与复制」「窗口与重连」「备份与演练」）；
  * question：一句直达核心的简短确认问句（不超过 32 字）；
  * options：3～4 个结构化单选卡片文案，统一采用「核心结论，简要补充说明」两段式（卡片正文控制在 26 字以内）；若某选项代表具体目标已确定但用户诉求中尚未写明具体值（如版本已定/目标明确、待调参数目标值已定、新增节点已就绪、排期窗口已定），请在该选项末尾附加「（补充目标版本号）」「（补充参数与目标值）」「（补充节点IP）」等简短括号标记以便前端自动展开输入框，而「版本待定/状态不明/按默认/通用策略」类选项严禁附加。
严格只输出一个 JSON 对象，不要附加 Markdown 代码块：
{"thinking":"1. 集群基线分析...；2. 变更核心风险点...；3. 需对齐的窗口与环境前提...","title":"不超过28字的演练标题","scope_summary":"一句话概括本次变更核心边界","questions":[{"id":"q1","label":"窗口与闪断","question":"可接受的业务闪断窗口与应用重连条件？","options":["秒级闪断滚动切换，应用具备自动重连","低峰计划窗口内执行，允许数秒中断","必须零中断在线操作，暂不允许切主"]},{"id":"q2","label":"版本与就绪","question":"目标小版本及离线包、节点准备到哪一步？","options":["全部就绪，目标明确且包与节点已核验（补充目标版本号）","版本已定，离线包或节点待核验（补充目标版本号）","版本待定，需先确认兼容目标","状态不明，先核实现网与离线资源"]}]}`

func (s *storeServer) createRehearsal(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts) {
	var in struct {
		Title  string     `json:"title"`
		Goal   string     `json:"goal"`
		Images []string   `json:"images"`
		Model  string     `json:"model"`
		Effort thinkLevel `json:"effort"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 28<<20)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容格式不对或图片超过大小限制")
		return
	}
	goal := strings.TrimSpace(in.Goal)
	title := strings.TrimSpace(in.Title)
	if len([]rune(goal)) < 4 || len([]rune(goal)) > 4000 {
		s.fail(w, 400, "请填写清楚变更诉求（4～4000 字）")
		return
	}
	providers, code, err := s.rehearsalCheckAI(session.User, len(in.Images) > 0, in.Model)
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}
	rid := randomStoreToken(6)
	imgNames, err := s.storeRehearsalImages(f.ID, rid, in.Images)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}

	ev := startRehearsalSSE(w, r)
	inspectStart := time.Now()
	baseline, red := s.clusterBaselinePrompt(f)
	hostCount := 0
	if f.Plan != nil {
		hostCount = len(f.Plan.Hosts)
	}
	guardDetail := "自动剥离敏感口令与私钥字段，仅向模型提供架构拓扑与运行参数基线"
	if len(imgNames) > 0 {
		guardDetail += fmt.Sprintf("（附带 %d 张参考截图）", len(imgNames))
	}
	pipeSpec := rehearsalPipelineSpec{
		PreSteps: []rehearsalTraceStep{
			{
				ID:     "read-baseline",
				Kind:   "inspect",
				Title:  "读取集群初始交付基线",
				Detail: fmt.Sprintf("%s %s · %d 台节点 · 基线交付 %s", f.Current.AppName, f.Current.Version, hostCount, truncRunes(f.Current.ID, 8)),
				MS:     max(1, time.Since(inspectStart).Milliseconds()),
				OK:     true,
				Status: "done",
			},
			{
				ID:     "scrub-context",
				Kind:   "guard",
				Title:  "敏感凭据脱敏与边界检查",
				Detail: guardDetail,
				MS:     1,
				OK:     true,
				Status: "done",
			},
		},
		ThinkTitle: "研判变更诉求与集群高可用边界",
		ThinkWait:  "正在结合集群拓扑与运行参数展开风险推演…",
		SynthID:    "build-scope",
		SynthKind:  "synthesize",
		SynthTitle: "生成变更边界澄清清单",
		SynthWait:  "等待风险推演完成后提炼维护窗口与前提问题",
	}

	prompt := "【集群初始交付基线】\n" + baseline + "\n\n【用户本次变更诉求】\n" + goal
	text, trace, code, err := s.rehearsalRunAI(r, providers, session.User, f.ID, rid+"/create", "create", red, rehearsalScopeSystem, prompt, in.Images, pipeSpec, in.Effort, ev)
	if err != nil {
		if len(imgNames) > 0 {
			_ = os.RemoveAll(s.rehearsalImgDir(f.ID, rid))
		}
		failRehearsalResp(s, w, ev, code, err.Error(), aiDiagFromErr(err), trace.Diag)
		return
	}
	parseStart := time.Now()
	var parsed struct {
		Thinking     string                   `json:"thinking"`
		Title        string                   `json:"title"`
		ScopeSummary string                   `json:"scope_summary"`
		Questions    []rehearsalScopeQuestion `json:"questions"`
	}
	if raw := extractJSON(text); raw != "" {
		_ = json.Unmarshal([]byte(raw), &parsed)
	}
	if title == "" {
		title = truncRunes(strings.TrimSpace(parsed.Title), 60)
	}
	if title == "" {
		title = truncRunes(f.Current.AppName+" 变更演练", 60)
	}
	qs := normalizeScopeQuestions(parsed.Questions)
	summary := truncRunes(strings.TrimSpace(parsed.ScopeSummary), 300)
	if trace.Thinking == "" {
		trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), fmt.Sprintf("已核对集群 %s（%s %s）初始拓扑与参数基线，提炼出 %d 个变更窗口与高可用约束澄清项。", f.ID, f.Current.AppName, f.Current.Version, len(qs)))
	}
	finalizeTraceSynth(
		&trace,
		ev,
		"build-scope",
		fmt.Sprintf("已提炼 %d 个现场前提问题，确认后自动生成纯只读探针", len(qs)),
		true,
		max(1, time.Since(parseStart).Milliseconds()),
	)

	now := nowStamp()
	rh := changeRehearsal{
		ID:             rid,
		ClusterID:      f.ID,
		AppID:          f.Current.AppID,
		AppName:        f.Current.AppName,
		BaseJobID:      f.Current.ID,
		Title:          title,
		Goal:           goal,
		GoalImages:     imgNames,
		Owner:          session.User,
		Stage:          "scoping",
		ScopeQuestions: qs,
		ScopeSummary:   summary,
		ProbeSafe:      true,
		Traces:         map[string]rehearsalTrace{"create": trace},
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	rehearsalMu.Lock()
	err = s.saveRehearsal(rh)
	rehearsalMu.Unlock()
	if err != nil {
		failRehearsalResp(s, w, ev, 500, "保存演练会话失败")
		return
	}
	s.auditReq(r, "rehearsal-create", session.User, f.ID+" "+rid)
	finishRehearsalResp(w, ev, 201, rh)
}

func normalizeScopeQuestions(in []rehearsalScopeQuestion) []rehearsalScopeQuestion {
	var out []rehearsalScopeQuestion
	for i, q := range in {
		if i >= 4 {
			break
		}
		qt := strings.TrimSpace(q.Question)
		if qt == "" {
			continue
		}
		id := strings.TrimSpace(q.ID)
		if id == "" {
			id = fmt.Sprintf("q%d", len(out)+1)
		}
		var opts []string
		for j, o := range q.Options {
			if j >= 4 {
				break
			}
			if ot := strings.TrimSpace(o); ot != "" {
				opts = append(opts, truncRunes(ot, 80))
			}
		}
		out = append(out, rehearsalScopeQuestion{
			ID:       id,
			Label:    truncRunes(strings.TrimSpace(q.Label), 16),
			Question: truncRunes(qt, 200),
			Options:  opts,
			Answer:   strings.TrimSpace(q.Answer),
		})
	}
	if len(out) == 0 {
		out = []rehearsalScopeQuestion{
			{ID: "q1", Label: "窗口与闪断", Question: "本次生产变更可接受的维护窗口与业务闪断要求？", Options: []string{"低峰期滚动变更，控制在秒级闪断", "计划停机窗口执行，允许短暂中断", "必须零停机在线操作，不触发切主"}},
			{ID: "q2", Label: "离线包就绪", Question: "离线变更所需的软件包或新增节点是否已在内网就绪？", Options: []string{"已在内网就绪，可直接校验兼容性", "尚未完备，需在方案中列出所需清单"}},
		}
	}
	return out
}

const rehearsalProbeSystem = `你是资深中间件运维与变更专家。请根据「集群初始交付基线」和「已确认的变更边界」，生成一份在生产节点执行的 **100% 纯只读** Bash 现场状态采集脚本（probe_script）。
硬性安全红线：
1. 脚本只能包含只读查看命令（如进程/版本查询、组件只读状态查询、主从角色与复制延迟查询、关键运行参数读取、监听端口、磁盘空间 df -h、内存 free -m 等）；
2. 严禁包含任何写入、删除、重启、切换、改配置、装包或写临时文件操作（禁止 rm/mv/cp/mkdir/chmod/chown/sed -i/tee、禁止 systemctl stop|restart|reload、禁止 patronictl switchover|failover|restart|edit-config、禁止 etcdctl put|del|member add|remove、禁止 SQL INSERT|UPDATE|DELETE|ALTER|DROP、禁止重定向写文件；仅允许 2>/dev/null 或 >/dev/null）；
3. 脚本不要输出任何密码、私钥或凭据内容（读取配置文件时过滤掉 password/secret/requirepass/masterauth 行）；
4. 输出结构清晰（带分段 echo 标记），方便工程师直接复制回显或截图反馈。
请先在 JSON 第一个字段 thinking 中写出你将重点核查哪些生产状态指标（如主从漂移、哨兵/DCS 仲裁、持久化与内存余量、离线包版本等）以及如何确保 100% 只读无副作用。
严格只输出一个 JSON 对象：
{"thinking":"1. 采集重点设计...；2. 纯只读与凭据过滤策略...","probe_script":"#!/usr/bin/env bash\nset -uo pipefail\n...","probe_notes":["执行提示1","执行提示2"]}`

func (s *storeServer) submitRehearsalScope(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string) {
	var in struct {
		Answers []struct {
			ID       string `json:"id"`
			Question string `json:"question"`
			Answer   string `json:"answer"`
		} `json:"answers"`
		Extra  string     `json:"extra"`
		Model  string     `json:"model"`
		Effort thinkLevel `json:"effort"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容格式不对")
		return
	}
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	rehearsalMu.Unlock()
	if !ok {
		s.fail(w, 404, "演练会话不存在")
		return
	}
	providers, code, err := s.rehearsalCheckAI(session.User, false, in.Model)
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}

	ansMap := map[string]string{}
	for _, a := range in.Answers {
		ansMap[a.ID] = truncRunes(strings.TrimSpace(a.Answer), 500)
	}
	answeredCount := 0
	for i := range rh.ScopeQuestions {
		if v, exists := ansMap[rh.ScopeQuestions[i].ID]; exists {
			rh.ScopeQuestions[i].Answer = v
		}
		if strings.TrimSpace(rh.ScopeQuestions[i].Answer) != "" {
			answeredCount++
		}
	}
	rh.ExtraScope = truncRunes(strings.TrimSpace(in.Extra), 2000)

	ev := startRehearsalSSE(w, r)
	inspectStart := time.Now()
	baseline, red := s.clusterBaselinePrompt(f)
	var qa strings.Builder
	for _, q := range rh.ScopeQuestions {
		fmt.Fprintf(&qa, "- 问：%s\n  答：%s\n", q.Question, firstNonEmptyStr(q.Answer, "（未填写，按常规生产保守策略处理）"))
	}
	if rh.ExtraScope != "" {
		fmt.Fprintf(&qa, "- 补充约束：%s\n", rh.ExtraScope)
	}
	pipeSpec := rehearsalPipelineSpec{
		PreSteps: []rehearsalTraceStep{
			{
				ID:     "align-scope",
				Kind:   "inspect",
				Title:  "锁定变更边界与窗口约束",
				Detail: fmt.Sprintf("已对齐 %d/%d 项前提条件，结合组件巡检字典编排探针", answeredCount, len(rh.ScopeQuestions)),
				MS:     max(1, time.Since(inspectStart).Milliseconds()),
				OK:     true,
				Status: "done",
			},
			{
				ID:     "inject-ro-policy",
				Kind:   "guard",
				Title:  "注入纯只读安全红线规则",
				Detail: "锁定零修改、零服务控制、零文件重定向及凭据过滤约束",
				MS:     1,
				OK:     true,
				Status: "done",
			},
		},
		ThinkTitle: "设计生产现场纯只读采集策略",
		ThinkWait:  "正在结合组件架构设计现场角色、版本与关键参数采集指标…",
		SynthID:    "readonly-ast-guard",
		SynthKind:  "guard",
		SynthTitle: "生成探针与静态安全红线扫描",
		SynthWait:  "等待脚本编写完成后执行 15 类高危写操作静态扫描",
		Validate: func(outText string) error {
			var chk struct {
				ProbeScript string `json:"probe_script"`
			}
			if raw := extractJSON(outText); raw != "" {
				_ = json.Unmarshal([]byte(raw), &chk)
			}
			if strings.TrimSpace(chk.ProbeScript) == "" {
				return fmt.Errorf("模型未能生成有效的只读采集脚本（响应可能被截断或未输出完整 JSON），请重试")
			}
			return nil
		},
	}

	prompt := fmt.Sprintf("【集群初始交付基线】\n%s\n\n【变更目标】\n%s\n\n【已对齐的边界条件】\n%s", baseline, rh.Goal, qa.String())
	text, trace, code, err := s.rehearsalRunAI(r, providers, session.User, f.ID, rid+"/scope", "scope", red, rehearsalProbeSystem, prompt, nil, pipeSpec, in.Effort, ev)
	if err != nil {
		failRehearsalResp(s, w, ev, code, err.Error(), aiDiagFromErr(err), trace.Diag)
		return
	}
	scanStart := time.Now()
	var parsed struct {
		Thinking    string   `json:"thinking"`
		ProbeScript string   `json:"probe_script"`
		ProbeNotes  []string `json:"probe_notes"`
	}
	if raw := extractJSON(text); raw != "" {
		_ = json.Unmarshal([]byte(raw), &parsed)
	}
	script := strings.TrimSpace(parsed.ProbeScript)
	if script == "" {
		failRehearsalResp(s, w, ev, 502, "模型未能生成有效的只读采集脚本，请重试", trace.Diag)
		return
	}
	safe, warns := validateReadOnlyProbeScript(script)
	if trace.Thinking == "" {
		trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), fmt.Sprintf("已结合已确认的 %d 项边界约束定制 %s 现场只读状态采集脚本，覆盖角色、版本、关键参数与系统资源检查。", answeredCount, f.Current.AppName))
	}
	guardDetail := "已通过 15 类高危写命令、服务控制与文件写入重定向静态扫描（100% 纯只读）"
	if !safe {
		guardDetail = fmt.Sprintf("静态扫描发现 %d 项疑似写操作告警，请人工审阅脚本", len(warns))
	}
	finalizeTraceSynth(
		&trace,
		ev,
		"readonly-ast-guard",
		guardDetail,
		safe,
		max(1, time.Since(scanStart).Milliseconds()),
	)

	rehearsalMu.Lock()
	cur, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		failRehearsalResp(s, w, ev, 404, "演练会话不存在")
		return
	}
	cur.ScopeQuestions = rh.ScopeQuestions
	cur.ExtraScope = rh.ExtraScope
	cur.ProbeScript = script
	cur.ProbeNotes = cleanStringList(parsed.ProbeNotes, 6, 200)
	cur.ProbeSafe = safe
	cur.ProbeWarnings = warns
	if cur.Traces == nil {
		cur.Traces = map[string]rehearsalTrace{}
	}
	cur.Traces["scope"] = trace
	if cur.Stage == "scoping" {
		cur.Stage = "probing"
	}
	err = s.saveRehearsal(cur)
	rehearsalMu.Unlock()
	if err != nil {
		failRehearsalResp(s, w, ev, 500, "保存演练进度失败")
		return
	}
	s.auditReq(r, "rehearsal-scope", session.User, f.ID+" "+rid)
	finishRehearsalResp(w, ev, 200, cur)
}

const rehearsalPlanSystem = `你是资深中间件变更实施专家。现在你同时拥有「平台首次交付基线」与「生产现场最新采集状态/说明/终端截图」。
请完成两件事：
1. 漂移诊断（drift）：仔细读取文字回显与附带的终端/监控截图，对比初始交付规格与现场真实状态，明确每台节点的初始角色 vs 当前真实角色（特别是主从是否已切换）、当前版本、被人工修改过的关键参数以及潜在变更风险；
2. 生成测试环境分步演练清单（steps）：围绕「先在测试环境完整演练跑通，再定稿生产 SOP」的原则，按以下 4 个阶段生成具体、可执行、幂等且可验证的步骤：
   - precheck（变更前预检：核对当前主从角色、复制同步状态、活跃连接、配置与备份前置条件）
   - execute（核心变更执行：严格遵循高可用滚动顺序，如先备节点后主节点、计划内平滑切主等）
   - verify（变更后验收：服务状态、版本号、数据复制恢复、VIP/负载均衡入口连通性验证）
   - rollback（回退预案：一旦演练或生产执行受阻时的明确回退步骤与命令）

请先在 JSON 第一个字段 thinking 中用清晰的要点写出你的漂移比对发现、滚动顺序编排逻辑与风险防护设计。
严格只输出一个 JSON 对象，格式如下：
{
  "thinking": "1. 现场拓扑与参数比对结论...；2. 高可用滚动演练顺序设计...；3. 关键风险与回退保障...",
  "drift": {
    "summary": "漂移诊断结论摘要",
    "drifted": true,
    "hosts": [{"name":"节点名","ip":"节点IP","initial_role":"初始角色","actual_role":"现场当前角色","version":"当前版本","status":"运行状态"}],
    "param_diffs": [{"key":"参数名","initial":"初始值","actual":"现场值","risk":"影响说明"}],
    "risks": ["风险点1"],
    "recommendations": ["建议1"]
  },
  "steps": [
    {
      "id": "s1",
      "phase": "precheck|execute|verify|rollback",
      "order": 1,
      "title": "步骤标题",
      "target_role": "执行目标（如：当前从库 node-01 / 10.0.1.11）",
      "command": "具体执行的 shell/SQL 命令",
      "expect": "明确的预期输出与成功判据",
      "risk_note": "风险与注意事项",
      "rollback": "本步异常时的即时回退命令（无则留空）",
      "optional": false
    }
  ]
}`

func (s *storeServer) submitRehearsalProbe(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string) {
	var in struct {
		ProbeOutput string     `json:"probe_output"`
		ManualState string     `json:"manual_state"`
		TestEnvNote string     `json:"test_env_note"`
		Images      []string   `json:"images"`
		Model       string     `json:"model"`
		Effort      thinkLevel `json:"effort"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 30<<20)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容格式不对或超过大小限制")
		return
	}
	probeOut := aiScrub(truncRunes(strings.TrimSpace(in.ProbeOutput), 24000))
	manual := aiScrub(truncRunes(strings.TrimSpace(in.ManualState), 8000))
	testEnv := truncRunes(strings.TrimSpace(in.TestEnvNote), 1000)
	if probeOut == "" && manual == "" && len(in.Images) == 0 {
		s.fail(w, 400, "请粘贴现场采集回显、上传/粘贴终端截图，或手动填写生产集群当前状态说明")
		return
	}
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	rehearsalMu.Unlock()
	if !ok {
		s.fail(w, 404, "演练会话不存在")
		return
	}
	providers, code, err := s.rehearsalCheckAI(session.User, len(in.Images) > 0, in.Model)
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}
	imgNames, err := s.storeRehearsalImages(f.ID, rid, in.Images)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}

	ev := startRehearsalSSE(w, r)
	baseline, red := s.clusterBaselinePrompt(f)
	var prompt strings.Builder
	fmt.Fprintf(&prompt, "【集群初始交付基线】\n%s\n\n【变更目标】\n%s\n", baseline, rh.Goal)
	for _, q := range rh.ScopeQuestions {
		if q.Answer != "" {
			fmt.Fprintf(&prompt, "- %s：%s\n", q.Question, q.Answer)
		}
	}
	if rh.ExtraScope != "" {
		fmt.Fprintf(&prompt, "- 补充约束：%s\n", rh.ExtraScope)
	}
	if probeOut != "" {
		fmt.Fprintf(&prompt, "\n【生产现场只读探针回显（已脱敏）】\n%s\n", probeOut)
	}
	if manual != "" {
		fmt.Fprintf(&prompt, "\n【工程师手动声明的现场现状】\n%s\n", manual)
	}
	if len(imgNames) > 0 {
		fmt.Fprintf(&prompt, "\n【附带现场终端/状态截图】共 %d 张，请结合截图中的角色、版本、参数与健康状态完成漂移比对。\n", len(imgNames))
	}
	if testEnv != "" {
		fmt.Fprintf(&prompt, "\n【测试演练环境说明】\n%s\n", aiScrub(testEnv))
	}

	var evidenceParts []string
	if probeOut != "" {
		evidenceParts = append(evidenceParts, fmt.Sprintf("回显文本 %d 行", strings.Count(probeOut, "\n")+1))
	}
	if len(imgNames) > 0 {
		evidenceParts = append(evidenceParts, fmt.Sprintf("现场截图 %d 张", len(imgNames)))
	}
	if manual != "" {
		evidenceParts = append(evidenceParts, "人工现状说明")
	}
	pipeSpec := rehearsalPipelineSpec{
		PreSteps: []rehearsalTraceStep{
			{
				ID:     "parse-probe",
				Kind:   "inspect",
				Title:  "解析现场采集证据与交付基线",
				Detail: strings.Join(evidenceParts, " · "),
				MS:     1,
				OK:     true,
				Status: "done",
			},
			{
				ID:     "scrub-probe",
				Kind:   "guard",
				Title:  "现场回显敏感凭据二次脱敏",
				Detail: "自动擦除回显中的口令、密钥与连接串，对齐初始交付规格",
				MS:     1,
				OK:     true,
				Status: "done",
			},
		},
		ThinkTitle: "逐节点比对拓扑角色与参数漂移",
		ThinkWait:  "正在逐台比对初始交付基线与生产现场真实状态…",
		SynthID:    "build-rehearsal-plan",
		SynthKind:  "synthesize",
		SynthTitle: "完成漂移诊断与分步演练编排",
		SynthWait:  "等待漂移研判完成后编排测试环境预检/执行/验收/回退步骤",
		Validate: func(outText string) error {
			var chk struct {
				Steps []rehearsalStep `json:"steps"`
			}
			if raw := extractJSON(outText); raw != "" {
				_ = json.Unmarshal([]byte(raw), &chk)
			}
			if len(normalizeRehearsalSteps(chk.Steps)) == 0 {
				return fmt.Errorf("模型未能生成有效的测试演练步骤（响应可能被截断或未输出完整 JSON），请重试")
			}
			return nil
		},
	}

	text, trace, code, err := s.rehearsalRunAI(r, providers, session.User, f.ID, rid+"/probe", "probe", red, rehearsalPlanSystem, prompt.String(), in.Images, pipeSpec, in.Effort, ev)
	if err != nil {
		failRehearsalResp(s, w, ev, code, err.Error(), aiDiagFromErr(err), trace.Diag)
		return
	}
	parseStart := time.Now()
	var parsed struct {
		Thinking string          `json:"thinking"`
		Drift    *rehearsalDrift `json:"drift"`
		Steps    []rehearsalStep `json:"steps"`
	}
	if raw := extractJSON(text); raw != "" {
		_ = json.Unmarshal([]byte(raw), &parsed)
	}
	steps := normalizeRehearsalSteps(parsed.Steps)
	if len(steps) == 0 {
		failRehearsalResp(s, w, ev, 502, "模型未能生成有效的测试演练步骤，请检查回显或截图内容后重试", trace.Diag)
		return
	}
	drift := parsed.Drift
	if drift == nil {
		drift = &rehearsalDrift{Summary: "已依据录入的现场信息生成测试环境演练步骤", Hosts: []rehearsalDriftHost{}}
	}
	if drift.Hosts == nil {
		drift.Hosts = []rehearsalDriftHost{}
	}
	if trace.Thinking == "" {
		trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), drift.Summary)
	}
	finalizeTraceSynth(
		&trace,
		ev,
		"build-rehearsal-plan",
		fmt.Sprintf("%s · 生成 %d 个可验证演练步骤", map[bool]string{true: "识别到现场漂移", false: "拓扑与基线一致"}[drift.Drifted], len(steps)),
		true,
		max(1, time.Since(parseStart).Milliseconds()),
	)

	rehearsalMu.Lock()
	cur, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		failRehearsalResp(s, w, ev, 404, "演练会话不存在")
		return
	}
	cur.ProbeOutput = probeOut
	if len(imgNames) > 0 {
		cur.ProbeImages = imgNames
	}
	cur.ManualState = manual
	cur.TestEnvNote = testEnv
	cur.Drift = drift
	cur.Steps = steps
	if cur.Traces == nil {
		cur.Traces = map[string]rehearsalTrace{}
	}
	cur.Traces["probe"] = trace
	cur.Stage = "rehearsing"
	err = s.saveRehearsal(cur)
	rehearsalMu.Unlock()
	if err != nil {
		failRehearsalResp(s, w, ev, 500, "保存演练步骤失败")
		return
	}
	s.auditReq(r, "rehearsal-probe", session.User, f.ID+" "+rid)
	finishRehearsalResp(w, ev, 200, cur)
}

func normalizeRehearsalSteps(in []rehearsalStep) []rehearsalStep {
	validPhase := map[string]bool{"precheck": true, "execute": true, "verify": true, "rollback": true}
	var out []rehearsalStep
	seenID := map[string]bool{}
	for i, st := range in {
		if i >= 40 {
			break
		}
		cmd := strings.TrimSpace(st.Command)
		title := strings.TrimSpace(st.Title)
		if cmd == "" || title == "" {
			continue
		}
		ph := strings.TrimSpace(st.Phase)
		if !validPhase[ph] {
			ph = "execute"
		}
		id := strings.TrimSpace(st.ID)
		if !reStepID.MatchString(id) || seenID[id] {
			id = fmt.Sprintf("step-%d", len(out)+1)
		}
		seenID[id] = true
		role := strings.TrimSpace(st.TargetRole)
		if role == "" {
			role = "目标节点"
		}
		expect := strings.TrimSpace(st.Expect)
		if expect == "" {
			expect = "命令退出码为 0，输出符合预期"
		}
		out = append(out, rehearsalStep{
			ID:         id,
			Phase:      ph,
			Order:      len(out) + 1,
			Title:      truncRunes(title, 120),
			TargetRole: truncRunes(role, 80),
			Command:    cmd,
			Expect:     truncRunes(expect, 300),
			RiskNote:   truncRunes(strings.TrimSpace(st.RiskNote), 300),
			Rollback:   strings.TrimSpace(st.Rollback),
			Optional:   st.Optional,
			Status:     "pending",
		})
	}
	return out
}

func (s *storeServer) patchRehearsalStep(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid, sid string) {
	var in struct {
		Status  *string `json:"status"`
		Elapsed *string `json:"elapsed"`
		Note    *string `json:"note"`
		Command *string `json:"command"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容格式不对")
		return
	}
	if in.Status != nil {
		switch *in.Status {
		case "pending", "passed", "failed", "skipped":
		default:
			s.fail(w, 400, "无效的步骤状态")
			return
		}
	}
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		s.fail(w, 404, "演练会话不存在")
		return
	}
	idx := -1
	for i := range rh.Steps {
		if rh.Steps[i].ID == sid {
			idx = i
			break
		}
	}
	if idx < 0 {
		rehearsalMu.Unlock()
		s.fail(w, 404, "演练步骤不存在")
		return
	}
	st := &rh.Steps[idx]
	if in.Command != nil {
		nextCmd := strings.TrimSpace(*in.Command)
		if nextCmd == "" {
			rehearsalMu.Unlock()
			s.fail(w, 400, "步骤命令不能为空")
			return
		}
		if nextCmd != st.Command {
			st.Revisions = append(st.Revisions, rehearsalStepRevision{
				At:         nowStamp(),
				By:         session.User,
				Diagnosis:  "工程师在测试环境手动调整命令",
				OldCommand: st.Command,
				NewCommand: nextCmd,
			})
			st.Command = nextCmd
			st.Proposal = nil
		}
	}
	if in.Elapsed != nil {
		st.Elapsed = truncRunes(strings.TrimSpace(*in.Elapsed), 40)
	}
	if in.Note != nil {
		st.Note = truncRunes(strings.TrimSpace(*in.Note), 500)
	}
	if in.Status != nil {
		st.Status = *in.Status
		if *in.Status == "passed" {
			st.Proposal = nil
		}
	}
	err := s.saveRehearsal(rh)
	rehearsalMu.Unlock()
	if err != nil {
		s.fail(w, 500, "保存步骤状态失败")
		return
	}
	s.auditReq(r, "rehearsal-step", session.User, f.ID+" "+rid+" "+sid)
	s.writeJSON(w, 200, rh)
}

const rehearsalTroubleSystem = `你是资深中间件变更排障专家。工程师正在测试环境按演练步骤验证变更方案，某一步执行报错（包含报错文本或终端截图）。
请先在 JSON 第一个字段 thinking 中简明写出你的报错信号提取、环境/权限/状态根因推理过程，然后给出可直接采纳的修正提案：
- 若当前步骤本身的命令参数、路径、权限或语法需要调整，action 设为 "replace"，给出修正后的完整命令；
- 若报错是因为缺少一个前置准备步骤（例如需要先创建目录、暂停守护、释放锁或检查依赖），action 设为 "insert_before"，给出需要插入在此步骤之前的前置步骤标题、目标角色、命令与判据。
严格只输出一个 JSON 对象：
{"thinking":"1. 报错信号识别...；2. 根因定位...；3. 修订方案推演...","diagnosis":"简明准确的报错根因诊断","action":"replace|insert_before","title":"前置步骤标题（insert_before时必填）","target_role":"执行角色","command":"修正后或新增前置的完整命令","expect":"成功判据","rollback":"回退命令（可选）","risk_note":"注意事项（可选）"}`

func (s *storeServer) troubleshootRehearsalStep(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid, sid string) {
	var in struct {
		ErrorOutput string     `json:"error_output"`
		Images      []string   `json:"images"`
		Model       string     `json:"model"`
		Effort      thinkLevel `json:"effort"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 28<<20)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容格式不对或图片超过大小限制")
		return
	}
	errOut := aiScrub(truncRunes(strings.TrimSpace(in.ErrorOutput), 8000))
	if errOut == "" && len(in.Images) == 0 {
		s.fail(w, 400, "请粘贴测试环境执行报错信息或上传/粘贴报错截图")
		return
	}
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	rehearsalMu.Unlock()
	if !ok {
		s.fail(w, 404, "演练会话不存在")
		return
	}
	var target *rehearsalStep
	for i := range rh.Steps {
		if rh.Steps[i].ID == sid {
			cp := rh.Steps[i]
			target = &cp
			break
		}
	}
	if target == nil {
		s.fail(w, 404, "演练步骤不存在")
		return
	}
	providers, code, err := s.rehearsalCheckAI(session.User, len(in.Images) > 0, in.Model)
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}
	imgNames, err := s.storeRehearsalImages(f.ID, rid, in.Images)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}

	ev := startRehearsalSSE(w, r)
	baseline, red := s.clusterBaselinePrompt(f)
	errDesc := errOut
	if errDesc == "" && len(imgNames) > 0 {
		errDesc = fmt.Sprintf("（详见附带的 %d 张报错终端截图）", len(imgNames))
	} else if len(imgNames) > 0 {
		errDesc += fmt.Sprintf("\n（同时附带 %d 张现场报错终端截图，请结合截图识别完整报错上下文）", len(imgNames))
	}
	prompt := fmt.Sprintf("【集群基线】\n%s\n\n【演练目标】\n%s\n\n【当前受阻步骤】\n阶段：%s\n标题：%s\n执行对象：%s\n原命令：\n%s\n预期判据：%s\n\n【测试环境实际报错输出（已脱敏）】\n%s",
		baseline, rh.Goal, target.Phase, target.Title, target.TargetRole, target.Command, target.Expect, errDesc)

	pipeSpec := rehearsalPipelineSpec{
		PreSteps: []rehearsalTraceStep{
			{
				ID:     "inspect-step-err",
				Kind:   "inspect",
				Title:  "定位受阻步骤与报错证据",
				Detail: fmt.Sprintf("步骤 #%d「%s」· 执行对象：%s", target.Order, target.Title, target.TargetRole),
				MS:     1,
				OK:     true,
				Status: "done",
			},
			{
				ID:     "scrub-err-context",
				Kind:   "guard",
				Title:  "报错回显脱敏与上下文封装",
				Detail: "剥离报错输出中的敏感凭据，锁定演练步骤预期判据",
				MS:     1,
				OK:     true,
				Status: "done",
			},
		},
		ThinkTitle: "诊断报错信号与环境根因推理",
		ThinkWait:  "正在提取终端报错信号并定位配置、权限或环境根因…",
		SynthID:    "propose-fix",
		SynthKind:  "synthesize",
		SynthTitle: "生成命令修订提案",
		SynthWait:  "等待根因明确后生成就地替换或前置步骤命令",
		Validate: func(outText string) error {
			var chk struct {
				rehearsalStepProposal
			}
			if raw := extractJSON(outText); raw != "" {
				_ = json.Unmarshal([]byte(raw), &chk)
			}
			if strings.TrimSpace(chk.Command) == "" || strings.TrimSpace(chk.Diagnosis) == "" {
				return fmt.Errorf("模型未能给出有效的修正命令提案（响应可能被截断或格式不完整），请重试")
			}
			return nil
		},
	}

	text, trace, code, err := s.rehearsalRunAI(r, providers, session.User, f.ID, rid+"/troubleshoot/"+sid, "troubleshoot", red, rehearsalTroubleSystem, prompt, in.Images, pipeSpec, in.Effort, ev)
	if err != nil {
		failRehearsalResp(s, w, ev, code, err.Error(), aiDiagFromErr(err), trace.Diag)
		return
	}
	parseStart := time.Now()
	var parsed struct {
		rehearsalStepProposal
		Thinking string `json:"thinking"`
	}
	if raw := extractJSON(text); raw != "" {
		_ = json.Unmarshal([]byte(raw), &parsed)
	}
	prop := parsed.rehearsalStepProposal
	prop.Command = strings.TrimSpace(prop.Command)
	prop.Diagnosis = truncRunes(strings.TrimSpace(prop.Diagnosis), 600)
	if prop.Command == "" || prop.Diagnosis == "" {
		failRehearsalResp(s, w, ev, 502, "模型未能给出有效的修正命令提案，请补充更完整的报错信息或截图重试", trace.Diag)
		return
	}
	if prop.Action != "insert_before" {
		prop.Action = "replace"
	}
	if trace.Thinking == "" {
		trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), prop.Diagnosis)
	}
	finalizeTraceSynth(
		&trace,
		ev,
		"propose-fix",
		map[string]string{"replace": "就地修正本步命令", "insert_before": "在此步骤前插入前置准备步骤"}[prop.Action],
		true,
		max(1, time.Since(parseStart).Milliseconds()),
	)

	rehearsalMu.Lock()
	cur, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		failRehearsalResp(s, w, ev, 404, "演练会话不存在")
		return
	}
	savedErr := errOut
	if savedErr == "" && len(imgNames) > 0 {
		savedErr = fmt.Sprintf("（已上传 %d 张报错截图）", len(imgNames))
	}
	for i := range cur.Steps {
		if cur.Steps[i].ID == sid {
			cur.Steps[i].Status = "failed"
			cur.Steps[i].LastError = savedErr
			if len(imgNames) > 0 {
				cur.Steps[i].ErrorImages = imgNames
			}
			trCopy := trace
			cur.Steps[i].TroubleTrace = &trCopy
			p := prop
			cur.Steps[i].Proposal = &p
			break
		}
	}
	err = s.saveRehearsal(cur)
	rehearsalMu.Unlock()
	if err != nil {
		failRehearsalResp(s, w, ev, 500, "保存排障提案失败")
		return
	}
	s.auditReq(r, "rehearsal-troubleshoot", session.User, f.ID+" "+rid+" "+sid)
	finishRehearsalResp(w, ev, 200, cur)
}

func (s *storeServer) applyRehearsalProposal(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid, sid string) {
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		s.fail(w, 404, "演练会话不存在")
		return
	}
	idx := -1
	for i := range rh.Steps {
		if rh.Steps[i].ID == sid {
			idx = i
			break
		}
	}
	if idx < 0 || rh.Steps[idx].Proposal == nil {
		rehearsalMu.Unlock()
		s.fail(w, 409, "当前步骤没有待采纳的排障提案")
		return
	}
	st := rh.Steps[idx]
	prop := *st.Proposal
	now := nowStamp()
	if prop.Action == "insert_before" {
		newID := fmt.Sprintf("pre-%s-%d", st.ID, len(st.Revisions)+1)
		inserted := rehearsalStep{
			ID:         newID,
			Phase:      st.Phase,
			Title:      firstNonEmptyStr(truncRunes(strings.TrimSpace(prop.Title), 120), "前置准备："+st.Title),
			TargetRole: firstNonEmptyStr(strings.TrimSpace(prop.TargetRole), st.TargetRole),
			Command:    prop.Command,
			Expect:     firstNonEmptyStr(strings.TrimSpace(prop.Expect), "命令执行成功，无报错"),
			RiskNote:   strings.TrimSpace(prop.RiskNote),
			Rollback:   strings.TrimSpace(prop.Rollback),
			Status:     "pending",
		}
		rh.Steps[idx].Revisions = append(rh.Steps[idx].Revisions, rehearsalStepRevision{
			At:           now,
			By:           session.User,
			ErrorSnippet: truncRunes(st.LastError, 300),
			Diagnosis:    "插入前置步骤「" + inserted.Title + "」：" + prop.Diagnosis,
			OldCommand:   st.Command,
			NewCommand:   prop.Command,
		})
		rh.Steps[idx].Status = "pending"
		rh.Steps[idx].Proposal = nil
		next := make([]rehearsalStep, 0, len(rh.Steps)+1)
		next = append(next, rh.Steps[:idx]...)
		next = append(next, inserted)
		next = append(next, rh.Steps[idx:]...)
		for i := range next {
			next[i].Order = i + 1
		}
		rh.Steps = next
	} else {
		rh.Steps[idx].Revisions = append(rh.Steps[idx].Revisions, rehearsalStepRevision{
			At:           now,
			By:           session.User,
			ErrorSnippet: truncRunes(st.LastError, 300),
			Diagnosis:    prop.Diagnosis,
			OldCommand:   st.Command,
			NewCommand:   prop.Command,
		})
		rh.Steps[idx].Command = prop.Command
		if strings.TrimSpace(prop.Expect) != "" {
			rh.Steps[idx].Expect = truncRunes(strings.TrimSpace(prop.Expect), 300)
		}
		if strings.TrimSpace(prop.Rollback) != "" {
			rh.Steps[idx].Rollback = strings.TrimSpace(prop.Rollback)
		}
		if strings.TrimSpace(prop.RiskNote) != "" {
			rh.Steps[idx].RiskNote = truncRunes(strings.TrimSpace(prop.RiskNote), 300)
		}
		rh.Steps[idx].Status = "pending"
		rh.Steps[idx].Proposal = nil
	}
	err := s.saveRehearsal(rh)
	rehearsalMu.Unlock()
	if err != nil {
		s.fail(w, 500, "采纳修正提案失败")
		return
	}
	s.auditReq(r, "rehearsal-apply", session.User, f.ID+" "+rid+" "+sid)
	s.writeJSON(w, 200, rh)
}

func (s *storeServer) finalizeRehearsal(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string) {
	var in struct {
		TestEnvNote string `json:"test_env_note"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in)

	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		s.fail(w, 404, "演练会话不存在")
		return
	}
	reqCount, pendingCount := 0, 0
	for _, st := range rh.Steps {
		if st.Optional || st.Phase == "rollback" {
			continue
		}
		reqCount++
		if st.Status != "passed" && st.Status != "skipped" {
			pendingCount++
		}
	}
	if reqCount == 0 || pendingCount > 0 {
		rehearsalMu.Unlock()
		s.fail(w, 409, fmt.Sprintf("还有 %d 个必测演练步骤未验证通过，请先在测试环境完成演练后再定稿生产 SOP", pendingCount))
		return
	}
	if note := strings.TrimSpace(in.TestEnvNote); note != "" {
		rh.TestEnvNote = truncRunes(note, 1000)
	}
	docID := "sop-" + rh.ID
	rh.DocID = docID
	rh.Stage = "finalized"
	err := s.saveRehearsal(rh)
	rehearsalMu.Unlock()
	if err != nil {
		s.fail(w, 500, "定稿生产变更实施方案失败")
		return
	}

	// Pre-populate editable overview & signoff sections on first finalize so the generated SOP is immediately complete
	// for Word export while remaining editable in the cluster's Documents center.
	saved := s.docLoad(f.ID, docID)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, exists := saved.Sections["overview"]; !exists {
		overview := rh.Goal
		if rh.ScopeSummary != "" {
			overview += "\n边界说明：" + rh.ScopeSummary
		}
		saved.Sections["overview"] = docSection{Text: overview, Source: "user", Confirmed: true, By: session.User, At: now, Basis: f.Current.ID}
	}
	if _, exists := saved.Sections["signoff"]; !exists {
		signoff := fmt.Sprintf("本方案已由 %s 在测试环境完成全部必测步骤演练并核验通过。生产执行窗口内如遇单步超出预期耗时 2 倍或核心业务指标异常，立即按第 5 节应急回退预案执行回退。", session.User)
		saved.Sections["signoff"] = docSection{Text: signoff, Source: "user", Confirmed: true, By: session.User, At: now, Basis: f.Current.ID}
	}
	_ = s.docSave(f.ID, docID, saved)

	s.auditReq(r, "rehearsal-finalize", session.User, f.ID+" "+docID)
	s.writeJSON(w, 200, rh)
}

// buildRehearsalSOP renders a finalized rehearsal session into a formal clusterDoc ("change" kind) for preview,
// section editing, and .docx Word export.
func (s *storeServer) buildRehearsalSOP(f clusterFacts, rid string) (*clusterDoc, bool) {
	rh, ok := s.loadRehearsal(f.ID, rid)
	if !ok || rh.Stage != "finalized" {
		return nil, false
	}
	d := &clusterDoc{
		ID:       "sop-" + rh.ID,
		Kind:     "change",
		Title:    "生产变更实施方案",
		Subtitle: rh.Title,
		Cluster:  f.ID,
		Job:      rh.BaseJobID,
		Cover: f.cover(
			[2]string{"变更主题", rh.Title},
			[2]string{"演练负责人", rh.Owner},
			[2]string{"定稿时间", stamp(rh.UpdatedAt)},
		),
	}
	b := &docBuilder{}
	b.section(1, "overview", "1 变更目标与维护窗口", "本次变更的业务背景、目标、计划维护窗口起止时间及审批单号。", true)

	b.h(1, "2 生产现状核对与漂移诊断")
	var scopeItems []string
	for _, q := range rh.ScopeQuestions {
		if strings.TrimSpace(q.Answer) != "" {
			scopeItems = append(scopeItems, q.Question+"："+q.Answer)
		}
	}
	if rh.ExtraScope != "" {
		scopeItems = append(scopeItems, "补充说明："+rh.ExtraScope)
	}
	if len(scopeItems) > 0 {
		b.h(2, "2.1 已确认的变更边界")
		b.list(scopeItems)
	}
	if rh.Drift != nil {
		b.h(2, "2.2 生产现场拓扑与漂移核查")
		b.note(rh.Drift.Summary)
		if len(rh.Drift.Hosts) > 0 {
			var rows [][]string
			for _, h := range rh.Drift.Hosts {
				rows = append(rows, []string{h.Name, h.IP, firstNonEmptyStr(h.InitialRole, "—"), firstNonEmptyStr(h.ActualRole, "—"), firstNonEmptyStr(h.Version, f.Current.Version), firstNonEmptyStr(h.Status, "正常")})
			}
			b.table([]string{"节点", "生产 IP", "初始交付角色", "现场当前角色", "版本", "运行状态"}, rows)
		} else {
			topology(b, f.Plan)
		}
		if len(rh.Drift.ParamDiffs) > 0 {
			var rows [][]string
			for _, p := range rh.Drift.ParamDiffs {
				rows = append(rows, []string{p.Key, p.Initial, p.Actual, p.Risk})
			}
			b.h(3, "现场参数差异")
			b.table([]string{"参数", "初始交付值", "现场当前值", "影响与风险说明"}, rows)
		}
		if len(rh.Drift.Risks) > 0 {
			b.h(3, "识别到的变更风险点")
			b.list(rh.Drift.Risks)
		}
	} else {
		topology(b, f.Plan)
	}

	b.h(1, "3 测试环境演练验证记录")
	passed, skipped, revTotal := 0, 0, 0
	for _, st := range rh.Steps {
		revTotal += len(st.Revisions)
		if st.Phase == "rollback" {
			continue
		}
		switch st.Status {
		case "passed":
			passed++
		case "skipped":
			skipped++
		}
	}
	summary := fmt.Sprintf("测试环境共实测通过 %d 个步骤", passed)
	if skipped > 0 {
		summary += fmt.Sprintf("，跳过 %d 个可选/不适用步骤", skipped)
	}
	if revTotal > 0 {
		summary += fmt.Sprintf("，演练过程中累计排障与打磨修正命令 %d 次", revTotal)
	}
	summary += "。"
	if rh.TestEnvNote != "" {
		summary += " 测试环境说明：" + rh.TestEnvNote
	}
	b.p(summary)

	b.h(1, "4 生产变更分步实施步骤（SOP）")
	writePhase := func(subTitle, phase string) {
		var list []rehearsalStep
		for _, st := range rh.Steps {
			if st.Phase == phase && st.Status != "skipped" {
				list = append(list, st)
			}
		}
		if len(list) == 0 {
			return
		}
		b.h(2, subTitle)
		for i, st := range list {
			b.h(3, fmt.Sprintf("%d) %s（执行对象：%s）", i+1, st.Title, st.TargetRole))
			var meta []string
			if st.Elapsed != "" {
				meta = append(meta, "演练实测耗时："+st.Elapsed)
			}
			if st.Note != "" {
				meta = append(meta, "演练实测备注："+st.Note)
			}
			if st.RiskNote != "" {
				meta = append(meta, "注意事项："+st.RiskNote)
			}
			if len(meta) > 0 {
				b.p(strings.Join(meta, " ｜ "))
			}
			b.code(st.Command)
			b.p("成功判据：" + st.Expect)
			if st.Rollback != "" {
				b.note("本步即时回退：" + st.Rollback)
			}
		}
	}
	writePhase("4.1 变更前预检", "precheck")
	writePhase("4.2 核心变更执行", "execute")
	writePhase("4.3 变更后验收", "verify")

	b.h(1, "5 应急回退预案")
	var rollbacks []rehearsalStep
	for _, st := range rh.Steps {
		if st.Phase == "rollback" {
			rollbacks = append(rollbacks, st)
		}
	}
	if len(rollbacks) > 0 {
		for i, st := range rollbacks {
			b.h(2, fmt.Sprintf("5.%d %s（执行对象：%s）", i+1, st.Title, st.TargetRole))
			if st.RiskNote != "" {
				b.p("触发条件与说明：" + st.RiskNote)
			}
			b.code(st.Command)
			b.p("回退确认判据：" + st.Expect)
		}
	} else {
		var inlineRB []string
		for _, st := range rh.Steps {
			if st.Rollback != "" {
				inlineRB = append(inlineRB, st.Title+"："+st.Rollback)
			}
		}
		if len(inlineRB) > 0 {
			b.list(inlineRB)
		} else {
			b.p("按各执行步骤下方标注的单步回退方式逆序恢复服务与配置。")
		}
	}

	b.section(1, "signoff", "6 回退红线与审批签字", "回退触发红线、窗口负责人、执行人与复核人签字确认。", true)
	d.Blocks = b.blocks
	return d, true
}

func cleanStringList(in []string, maxItems, maxRunes int) []string {
	var out []string
	for _, s := range in {
		if len(out) >= maxItems {
			break
		}
		if t := strings.TrimSpace(s); t != "" {
			out = append(out, truncRunes(t, maxRunes))
		}
	}
	return out
}

var _ = mwpack.DeploymentSchema

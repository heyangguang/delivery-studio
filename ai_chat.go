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
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// The assistant's conversations on a delivery: "review" and "review:<id>" (about the whole delivery, as many as people start) and "step:<key>" (one per runbook step).
// A conversation is kept with the delivery, and when the problem is solved its write-up joins the execution record.

type aiMsg struct {
	Role   string   `json:"role"` // user | assistant
	Text   string   `json:"text"`
	Images []string `json:"images,omitempty"` // file names under ai/img
	// Files are what was attached from the person's storage space (see store_files.go).
	Files []fileRef `json:"files,omitempty"`
	Tools []string  `json:"tools,omitempty"`
	// Steps are what the assistant did to get to this answer, and MS how long it took.
	Steps []aiStep `json:"steps,omitempty"`
	MS    int64    `json:"ms,omitempty"`
	// Proposals are the ids of proposals this answer made (see ai_proposals.go).
	Proposals []string `json:"proposals,omitempty"`
	// Rehearsals, Knowledges, and Components are inline interactive cards emitted in general/portal AI chats.
	Rehearsals []aiRehearsalSpec `json:"rehearsals,omitempty"`
	Knowledges []aiKnowledgeSpec `json:"knowledges,omitempty"`
	Components []aiComponentSpec `json:"components,omitempty"`
	// Ask is a question the assistant put to the person instead of guessing (see askTool).
	Ask *aiAsk `json:"ask,omitempty"`
	// Form is what the answer wrote into the new-delivery form (see ai_form.go).
	Form *formFill `json:"form,omitempty"`
	// Error and ErrorDiag persist failed assistant turns so reopening a conversation never loses failure context.
	Error     string      `json:"error,omitempty"`
	ErrorDiag *aiCallDiag `json:"error_diag,omitempty"`
	At        string      `json:"at"`
	By        string      `json:"by,omitempty"`
}

func isErrorOnlyMsg(m aiMsg) bool {
	return m.Role == "assistant" && m.Error != "" && strings.TrimSpace(m.Text) == ""
}

func appendOrReuseUserTurn(msgs []aiMsg, retry bool, userMsg aiMsg) []aiMsg {
	if retry {
		for len(msgs) > 0 && isErrorOnlyMsg(msgs[len(msgs)-1]) {
			msgs = msgs[:len(msgs)-1]
		}
		if last := len(msgs) - 1; last >= 0 && msgs[last].Role == "user" && strings.TrimSpace(msgs[last].Text) == strings.TrimSpace(userMsg.Text) {
			return msgs
		}
	}
	return append(msgs, userMsg)
}

func buildChatErrorDiag(lastErr error, failedAttempts []aiAttemptDiag, tried aiProvider) *aiCallDiag {
	if d := aiDiagFromErr(lastErr); d != nil {
		cp := *d
		if len(failedAttempts) > len(cp.Attempts) {
			cp.Attempts = failedAttempts
		}
		if cp.Provider == "" {
			cp.Provider = tried.Name
		}
		if cp.Model == "" {
			cp.Model = tried.Model
		}
		if cp.API == "" {
			cp.API = tried.API
		}
		return &cp
	}
	if tried.Name == "" && tried.Model == "" && len(failedAttempts) == 0 {
		return nil
	}
	return &aiCallDiag{
		Provider: tried.Name,
		Model:    tried.Model,
		API:      tried.API,
		Attempts: failedAttempts,
	}
}

type askOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type askQuestion struct {
	Question string      `json:"question"`
	Options  []askOption `json:"options,omitempty"`
	Multi    bool        `json:"multi,omitempty"`
}

// aiAsk is a short set of questions shown as a card; the person's answers come back as their next message.
type aiAsk struct {
	Questions []askQuestion `json:"questions"`
}

const askToolName = "ask_user"

// askText is the questions as plain text, so the next turn knows what was asked.
func (m aiMsg) askText() string {
	if m.Ask == nil {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n（我向用户提了这些问题：")
	for i, q := range m.Ask.Questions {
		fmt.Fprintf(&b, "%d. %s", i+1, q.Question)
		if len(q.Options) > 0 {
			var o []string
			for _, x := range q.Options {
				o = append(o, x.Label)
			}
			b.WriteString("［" + strings.Join(o, " / ") + "］")
		}
	}
	b.WriteString("）")
	return b.String()
}

// rehearsalText summarizes inline interactive cards so follow-up turns know what was already offered.
func (m aiMsg) rehearsalText() string {
	var b strings.Builder
	if len(m.Rehearsals) > 0 {
		b.WriteString("\n（我已生成以下变更演练发起卡片：")
		for i, r := range m.Rehearsals {
			if i > 0 {
				b.WriteString("；")
			}
			fmt.Fprintf(&b, "集群 %s · 「%s」", r.ClusterID, r.Title)
		}
		b.WriteString("）")
	}
	if len(m.Knowledges) > 0 {
		b.WriteString("\n（我已生成以下写入知识库总结卡片：")
		for i, k := range m.Knowledges {
			if i > 0 {
				b.WriteString("；")
			}
			fmt.Fprintf(&b, "「%s」", k.Title)
		}
		b.WriteString("）")
	}
	if len(m.Components) > 0 {
		b.WriteString("\n（我已生成以下组件改进建议卡片：")
		for i, c := range m.Components {
			if i > 0 {
				b.WriteString("；")
			}
			fmt.Fprintf(&b, "组件 %s · 「%s」", c.Component, c.Title)
		}
		b.WriteString("）")
	}
	return b.String()
}

func askTool() aiToolDef {
	return aiToolDef{askToolName, "信息不足、无法可靠回答时，向用户提问，而不是猜。提问后本轮立即结束，等用户回答。每次最多 3 个问题，每个问题给 2-4 个选项（用户也可以自己输入）。能从平台、知识库、附件里查到的信息，先自己查，不要问。", map[string]any{"type": "object", "properties": map[string]any{
		"questions": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
			"question": map[string]any{"type": "string", "description": "问题，一句话"},
			"options": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"label":       map[string]any{"type": "string", "description": "选项，简短"},
				"description": map[string]any{"type": "string", "description": "这个选项意味着什么（可选）"},
			}, "required": []string{"label"}}},
			"multi": map[string]any{"type": "boolean", "description": "可以多选"},
		}, "required": []string{"question"}}},
	}, "required": []string{"questions"}}}
}

// parseAsk reads the arguments of an ask_user call; nil when there is nothing to ask.
func parseAsk(args string) *aiAsk {
	var a aiAsk
	if json.Unmarshal([]byte(args), &a) != nil {
		return nil
	}
	var qs []askQuestion
	for _, q := range a.Questions {
		q.Question = strings.TrimSpace(q.Question)
		if q.Question == "" {
			continue
		}
		if len(q.Options) > 4 {
			q.Options = q.Options[:4]
		}
		qs = append(qs, q)
		if len(qs) == 3 {
			break
		}
	}
	if len(qs) == 0 {
		return nil
	}
	return &aiAsk{Questions: qs}
}

type fileRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Mime string `json:"mime,omitempty"`
	Size int64  `json:"size,omitempty"`
}

type aiReport struct {
	Session   string   `json:"session"`
	Kind      string   `json:"kind"` // troubleshoot | review
	Key       string   `json:"key"`
	Title     string   `json:"title"`
	Symptom   string   `json:"symptom"`
	Evidence  string   `json:"evidence,omitempty"`
	Cause     string   `json:"cause"`
	Fix       string   `json:"fix"`
	Changed   bool     `json:"changed"` // whether the delivery itself had to change
	Followups []string `json:"followups,omitempty"`
	Model     string   `json:"model,omitempty"`
	At        string   `json:"at"`
	By        string   `json:"by"`
	// KBID and KBTitle point at the copy kept in the writer's own knowledge base (private; publishing to the team is a
	// separate, reviewed step). DocID points at the standalone Change Report archived into Cluster Docs when saved on a deployed cluster.
	KBID    string `json:"kb_id,omitempty"`
	KBTitle string `json:"kb_title,omitempty"`
	DocID   string `json:"doc_id,omitempty"`
}

type aiSession struct {
	ID       string         `json:"id"`
	Key      string         `json:"key"`
	Kind     string         `json:"kind"`
	Title    string         `json:"title"`
	Step     map[string]any `json:"step,omitempty"`
	Messages []aiMsg        `json:"messages"`
	Updated  string         `json:"updated"`
	// Running is set when the answer is being written on the server now (it keeps running when the page looks elsewhere).
	Running bool `json:"running,omitempty"`
	// RunningSince is when that answer was started, so the time shown for it keeps counting from there.
	RunningSince string `json:"running_since,omitempty"`
}

// aiRuns are the answers being written: an answer belongs to the conversation, not to the page that asked for it,
// so leaving the page or switching to another conversation does not lose it. Only "stop" cancels one.
var aiRuns sync.Map // job + "/" + session id → aiRun

type aiRun struct {
	cancel  context.CancelFunc
	started time.Time
}

func aiRunKey(job, key string) string { return job + "/" + sessionID(key) }

func (s *storeServer) aiRunning(job, key string) (bool, string) {
	v, ok := aiRuns.Load(aiRunKey(job, key))
	if !ok {
		return false, ""
	}
	return true, v.(aiRun).started.UTC().Format(time.RFC3339Nano)
}

var reSessionKey = regexp.MustCompile(`^(review(:[a-z0-9]{4,24})?|step:[^\x00\n]{1,120}|sec(:[^\x00\n]{1,120})?)$`)

func sessionID(key string) string { h := sha256.Sum256([]byte(key)); return hex.EncodeToString(h[:8]) }

func (s *storeServer) aiDir(job string) string { return filepath.Join(s.jobDir(job), "ai") }

func (s *storeServer) aiLoadSession(job, key string) aiSession {
	ss := aiSession{ID: sessionID(key), Key: key, Messages: []aiMsg{}}
	if b, err := os.ReadFile(filepath.Join(s.aiDir(job), "sessions", ss.ID+".json")); err == nil {
		_ = json.Unmarshal(b, &ss)
	}
	switch {
	case key == "sec" || strings.HasPrefix(key, "sec:"):
		ss.Kind = "security"
	case strings.HasPrefix(key, "step:"):
		ss.Kind = "troubleshoot"
	default:
		ss.Kind = "review"
	}
	if ss.Messages == nil {
		ss.Messages = []aiMsg{}
	}
	return ss
}

func (s *storeServer) aiSaveSession(job string, ss aiSession) error {
	ss.Updated = time.Now().UTC().Format(time.RFC3339)
	return writeJSONFile(filepath.Join(s.aiDir(job), "sessions", ss.ID+".json"), ss)
}

func (s *storeServer) handleJobAI(w http.ResponseWriter, r *http.Request, session storeSession, j storeJob, parts []string) {
	id := j.ID
	switch {
	case len(parts) == 1 && parts[0] == "sessions" && r.Method == "GET":
		out := []aiSession{}
		files, _ := filepath.Glob(filepath.Join(s.aiDir(id), "sessions", "*.json"))
		for _, f := range files {
			var ss aiSession
			if b, err := os.ReadFile(f); err == nil && json.Unmarshal(b, &ss) == nil {
				ss.Messages = nil
				ss.Running, ss.RunningSince = s.aiRunning(id, ss.Key)
				out = append(out, ss)
			}
		}
		sort.Slice(out, func(i, k int) bool { return out[i].Updated > out[k].Updated })
		s.writeJSON(w, 200, map[string]any{"sessions": out, "status": s.aiStatus()})
	case len(parts) == 1 && parts[0] == "session" && (r.Method == "GET" || r.Method == "DELETE"):
		key := r.URL.Query().Get("key")
		if !reSessionKey.MatchString(key) {
			s.fail(w, 400, "这段对话不存在，或已过期")
			return
		}
		if r.Method == "DELETE" {
			_ = os.Remove(filepath.Join(s.aiDir(id), "sessions", sessionID(key)+".json"))
			s.writeJSON(w, 200, map[string]bool{"ok": true})
			return
		}
		ss := s.aiLoadSession(id, key)
		ss.Running, ss.RunningSince = s.aiRunning(id, key)
		s.writeJSON(w, 200, ss)
	case len(parts) == 1 && parts[0] == "stop" && r.Method == "POST":
		var in struct {
			Key string `json:"key"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&in) != nil || !reSessionKey.MatchString(in.Key) {
			s.fail(w, 400, "这段对话不存在，或已过期")
			return
		}
		if c, ok := aiRuns.Load(aiRunKey(id, in.Key)); ok {
			c.(aiRun).cancel()
		}
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case len(parts) == 2 && parts[0] == "img" && r.Method == "GET":
		name := filepath.Base(parts[1])
		b, err := os.ReadFile(filepath.Join(s.aiDir(id), "img", name))
		if err != nil {
			s.fail(w, 404, "图片不存在")
			return
		}
		w.Header().Set("Content-Type", http.DetectContentType(b))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(b)
	case len(parts) >= 1 && parts[0] == "proposals":
		s.handleProposals(w, r, session, j, parts[1:])
	case len(parts) == 1 && parts[0] == "chat" && r.Method == "POST":
		s.aiChatHandler(w, r, session, j)
	case len(parts) == 1 && parts[0] == "resolve" && r.Method == "POST":
		s.aiResolveHandler(w, r, session, j)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

const aiSystemBase = `你是 Middleware Hub 的交付助手，协助现场工程师把一份离线或自动化中间件交付顺利评审、执行与排障。
规则：
- 先用工具查看交付的实际内容再下结论，不要凭猜测：
  · 先用 delivery_info 了解交付模式（离线/自动/仅配置）、系统、方案与实例参数。
  · 要核对某项配置、日志、轮转、备份、TLS、端口或任务是否存在，优先用 search_files 在交付项目里一次性全文检索（毫秒级定位文件与行号），再对命中的关键文件用 read_file（可带 from_line/max_lines）精读确认；不要用 run_shell 沙箱代替 grep 搜文本。
  · 沙箱（run_python / run_shell）用于真正需要执行计算、脚本语法校验、大日志解析或生成导出文件的场景；沙箱操作的是隔离只读快照，不连远程主机。
- 你只能读取，不能修改任何东西。需要改动时，说清楚改什么、为什么、怎么验证，由工程师决定并操作。
- 密码、密钥、证书不会提供给你，也不要索取；看到［已隐去］是平台有意隐去的内容。
- 回答用中文，简洁，先给结论再给依据；命令用代码块；有风险的操作要明确提醒并给出回退办法。
- 思考和推理摘要也用中文，和回答保持一致。
- 如果判断是交付本身有问题（参数、步骤、模板有误），要明确说出来，并指出是哪一处。
- 提案卡片（propose_step、propose_change）是“解决方案”，不是“排查动作”：
  · 还在排查、还没有找到根因时，不要提案。让用户临时执行的排查命令、查看输出、追问现场情况，都写在回答里就好。
  · 现场修复须有根因证据、明确改法和验证办法。新需求不要求故障证据：用户目标明确且已核对当前配置，即可提案；不要把新增需求当成故障。
  · 同一现场动作不要重复提案；现场修复与组件长期改进可以各有一张卡片，分别说明作用范围。不要排查一步提一张。拿不准就先问用户或让他执行一条只读命令确认。
  · 提案写进手册后，要在回答里告诉用户去哪里执行：哪个阶段、哪一步的标题。
- 固定处理流程：新需求用变更提案，现场故障用当前交付修复提案；**只要识别到组件本身存在缺陷、缺少通用前置检查，或组件缺少有普遍价值的配置参数/运维入口（例如 PostgreSQL 组件缺少 logging_collector / log_directory / 日志轮转参数导致配置无法固化到交付规格）**，在用 component_sync_status 确认当前已发布组件和草稿尚未支持/修复后，**必须主动调用 suggest_component_change 输出「组件改进建议」卡片**，与当前交付或演练分别审核，不要求现场等待组件发布。客户专属偏好不应成为所有部署的默认值。reason 首句标明“新需求：”或“现场修复：”。
- **写入知识库总结卡片（propose_knowledge）**：当用户要求将本次排障、变更操作或经验「生成知识库 / 整理写入知识库 / 沉淀为文档」，或一次有复用价值的现场排障与变更已经解决、值得团队沉淀时，**必须主动调用 propose_knowledge 工具输出一张「写入知识库总结卡片」**（填好清晰标题、一句话摘要和结构化 Markdown 正文；未确认的根因如实写明「待确认」，严禁编造或包含口令密钥），让用户在卡片里预览/微调后一键存入「我的知识库」或发布到「团队知识库」。绝不要回答「我没有写入知识库的工具」。
- 修改配置时核对持久性：如果临时命令与交付规格不一致、以后重跑会覆盖，优先通过可用参数/规格变更保存目标值；没有相应工具就明确尚未固化，不能只让用户以后重复运行临时命令。采纳提案不等于已执行，组件建议不等于已发布，必须分别报告。
- 判断根因要抓主要矛盾：一次排查里会出现很多无关的噪音（SSH 指纹确认、命令入口不存在、被误判的进程占用……）。把它们和最终真正阻断的问题区分开，结论和总结只写真正的根因和解决办法，不要把中途的小问题当成原因。先对照事实（磁盘布局、挂载、配置里的参数、报错文字）再下结论。
- 要在手册里增加一步（补一条命令、一项检查）时，调用 propose_step；要改已有某一步的命令或参数时，调用 propose_change（不要为此建议重新生成交付）。命令必须能直接照抄执行，effect 如实标注，会修改系统的要写回退办法，after_title 用 runbook 里的原标题。平台校验没通过时按提示改好再提交。提案之外，仍然要在回答里讲清原因。
- 平台不会把格式化、分区、删除数据这类高危操作写进手册，也不会替用户做决定：遇到这类操作，不要反复提案，也不要说“被拒绝所以做不了”。直接在回答里给出完整步骤、风险、前置检查和回退办法，明确交给用户在现场自己评估、自己决定要不要执行。
- 问题出在自动化本身（某个 Playbook、角色任务、测试脚本或断言的逻辑、跑在了不该跑的机器上）而不是手册命令时，**必须先调用 component_sync_status（传入相关文件路径）核对当前平台已发布组件和草稿的状态**：
  · 若当前最新已发布组件已经修复了这个问题且本次交付可同步（sync_available=true），直接在回答里明确告知用户「当前组件已修复，无需再去组件工作台修改代码」，说明最新组件具体修复了什么，并引导用户在交付页或执行监控台点击「同步组件更新」（同时提醒重跑前需要核对的现场残留状态，如旧主是否拉起）；不要再给过时的组件修改方案，也不要重复提交 suggest_component_change 或 propose_file_change。
  · 若仅未发布草稿中已有修复，告知用户先去组件工作台检查并发布草稿，再回来同步本次交付。
  · 只有核实当前已发布组件和草稿均尚未修复时，才用 propose_file_change 修改这份交付项目里的文件（先 list_files / read_file 看清原文，用 edits 局部替换；采纳后平台生成更新包和覆盖命令，无需重新生成交付），并同时用 suggest_component_change 建议修组件。
- 手册里的命令能解决的用 propose_step / propose_change；自动化文件有问题且组件尚未修复时用 propose_file_change。不要让用户自己去控制节点手改文件。
- 严禁向用户反问平台已经记录的状态：当前集群是否已部署完成/已投产、执行进度与已有演练记录均已提供或可通过 delivery_info / cluster_history 查到，直接以平台真实状态为准，不要反问“这个集群已经投产了吗？”。
- 对已部署完成并处于运行中（已投产）的集群讨论后续操作时，**严守「零未留痕变更」分级铁律**：
  · **纯只读排查（零修改，不进演练）**：仅查状态、看日志、查主从/连接/复制延迟或核对配置现状（不修改任何配置、文件或服务）→ 直接给 1～3 条只读命令，**不要调用 propose_rehearsal**。
  · **极速变更（propose_rehearsal + mode="quick"）**：只要涉及**任何配置/参数/规则/文件修改**，哪怕非常简单、仅 reload 无需重启且现状已在对话或截图中明确（例如在线修改 log_filename / log_rotation_size、补单条明确规则），**也必须在正文讲清方案后主动调用 propose_rehearsal 并设 mode="quick"**（跳过问答与探针，2 步直出执行清单并一键归档《变更报告》），绝不只丢几行命令就结束导致无人知晓改过什么！
  · **简单推演（propose_rehearsal + mode="light"）**：要改配置/补规则/动态调参且无需重启和切主，但现场状态还拿不准需先跑一屏只读探针核实后再执行并归档《变更报告》→ 主动调用 propose_rehearsal 并设 mode="light"；若属组件模板/默认配置缺失，核对 component_sync_status 后一并出 suggest_component_change 卡片。
  · **全量推演（propose_rehearsal + mode="full"）**：涉及滚动重启服务、主备切换、版本/CVE 升级、扩缩容、备份/WAL 架构改造、证书轮换等高风险变更 → 在正文讲清方案、冲突与风险后，主动调用 propose_rehearsal 并设 mode="full"（走完整四步并定稿生产 SOP），不要只口头引导。
- **变更演练步骤对话修订（read_rehearsal + propose_rehearsal_step_edit）**：如果工程师正在讨论某个变更演练里的步骤（例如觉得命令太复杂、执行机器不清、需要拆分成两步、调整参数/目标节点或删除冗余步骤），先用 read_rehearsal 核对当前演练完整步骤，再在讲清改法后调用 propose_rehearsal_step_edit 输出交互式「修改演练步骤」卡片让用户一键采纳并同步更新演练页；**切勿**用修改初始交付手册的 propose_step / propose_change 去改演练步骤。
- **堡垒机 / WebSSH 多行命令防吞行规范**：凡给用户复制到 Linux 终端执行的命令块包含 **2 条及以上命令**（尤其含 sudo、psql、patronictl、sleep、systemctl 等耗时或读 stdin 的命令），请整块包在 ( ... ) </dev/null 子 Shell 中（不要裸写多行，也不要用 bash <<'EOF'），防止 Ubuntu sudo use_pty 或慢命令吞掉粘贴缓冲区里的后续行导致后半段未执行；单条命令无需包裹。
- 回答先写完，再出卡片；不要在文字还没讲清之前就提案。`

const aiSystemTrouble = aiSystemBase + `
现在的场景：工程师正在执行手册的某一步时遇到了问题，会贴回报错文字或截图。请结合该步骤、前面步骤的记录和项目文件，找出原因，给出可以立刻执行的下一步；对话会持续到问题解决。`

const aiSystemReview = aiSystemBase + `
现在的场景：评审这份交付。请检查：组件组合与角色分配是否合理（含奇偶、单点、资源冲突）、参数是否有风险、执行手册的顺序和验证是否完备、有无遗漏的前置条件，并回答工程师的追问。按严重程度列出问题，指出具体位置，没有问题的项不用罗列。
如果用户问的是整个集群（做过哪些变更、现在是什么样、有什么遗留问题、下一步该做什么），先用 cluster_history 查看集群的全部经历再回答；若集群已投产运行且涉及后续操作：纯只读诊断直接给命令；只要涉及任何配置/参数修改，哪怕极简热重载也必须调用 propose_rehearsal（现状明确且极简用 mode="quick" 直出步骤与变更报告，现状拿不准用 mode="light" 先探针再执行，高风险重启/切主/升级用 mode="full" 全量推演）。`

func (s *storeServer) planHostNames(id string) []string {
	var p struct {
		ExecutionHost *struct{ Name, IP string }  `json:"execution_host"`
		Hosts         []struct{ Name, IP string } `json:"hosts"`
	}
	_ = json.Unmarshal(s.jobPlan(id), &p)
	var out []string
	if p.ExecutionHost != nil {
		out = append(out, p.ExecutionHost.Name, p.ExecutionHost.IP)
	}
	for _, h := range p.Hosts {
		out = append(out, h.Name, h.IP)
	}
	return out
}

func stepContext(step map[string]any) string {
	if len(step) == 0 {
		return ""
	}
	b, _ := json.MarshalIndent(step, "", "  ")
	if k, _ := step["kind"].(string); strings.HasPrefix(k, "security_") {
		return "工程师当前重点关注的安全研判对象：\n" + string(b)
	}
	if k, _ := step["kind"].(string); k == "rehearsal_step" {
		return "工程师当前正在讨论或需要调整以下【变更演练步骤】（如需修改此步骤命令/执行机器/判据，或在其前后增删演练步骤，请先用 read_rehearsal 核对完整演练上下文，再调用 propose_rehearsal_step_edit 输出一键更新卡片，切勿调用修改初始交付手册的 propose_step / propose_change）：\n" + string(b)
	}
	return "工程师正在处理的步骤：\n" + string(b)
}

type sse struct {
	w http.ResponseWriter
	f http.Flusher
}

func (e sse) send(v map[string]any) {
	b, _ := json.Marshal(v)
	fmt.Fprintf(e.w, "data: %s\n\n", b)
	if e.f != nil {
		e.f.Flush()
	}
}

func (s *storeServer) aiChatHandler(w http.ResponseWriter, r *http.Request, user storeSession, j storeJob) {
	var in struct {
		Key     string         `json:"key"`
		Message string         `json:"message"`
		Images  []string       `json:"images"`
		Step    map[string]any `json:"step"`
		Model   string         `json:"model"`
		Options aiOpts         `json:"options"`
		Retry   bool           `json:"retry"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 20<<20)).Decode(&in); err != nil {
		s.fail(w, 400, "提交的内容有问题，或者图片太大了")
		return
	}
	in.Message = strings.TrimSpace(in.Message)
	if !reSessionKey.MatchString(in.Key) || (in.Message == "" && len(in.Images) == 0) || len([]rune(in.Message)) > 20000 || len(in.Images) > 3 {
		s.fail(w, 400, "请输入内容（最多 3 张图片）")
		return
	}
	feature := featureOfKey(in.Key)
	if code, msg := s.checkAIFeature(user.User, feature); code != 0 {
		s.fail(w, code, msg)
		return
	}
	st := s.aiLoad()
	providers := st.aiProvidersForPick(feature, in.Model)
	if len(providers) == 0 {
		s.fail(w, 409, "没有可用的模型供应商，请管理员在平台设置 → AI 中配置")
		return
	}
	if st.MonthlyLimit > 0 && s.aiCallsThisMonth(user.User) >= st.MonthlyLimit {
		s.fail(w, 429, "本月 AI 使用次数已达上限")
		return
	}
	if len(in.Images) > 0 && providers[0].Vision == "no" {
		s.fail(w, 409, "当前模型不支持看图，请改贴报错文字，或让管理员换一个支持看图的模型")
		return
	}
	// images are stored with the delivery so the conversation can be read later
	var imgNames []string
	for _, d := range in.Images {
		name, err := s.aiStoreImage(j.ID, d)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		imgNames = append(imgNames, name)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 20*time.Minute)
	defer cancel()
	if _, busy := aiRuns.LoadOrStore(aiRunKey(j.ID, in.Key), aiRun{cancel, time.Now()}); busy {
		s.fail(w, 409, "这段对话还在回答上一个问题，请等它结束，或先停止")
		return
	}
	defer aiRuns.Delete(aiRunKey(j.ID, in.Key))
	ss := s.aiLoadSession(j.ID, in.Key)
	if len(in.Step) > 0 {
		ss.Step = in.Step
	}
	if ss.Title == "" {
		ss.Title = "对话"
		// a conversation of its own is named by what it began with
		if (strings.HasPrefix(in.Key, "review:") || strings.HasPrefix(in.Key, "sec:")) && in.Message != "" {
			ss.Title = truncRunes(strings.Join(strings.Fields(in.Message), " "), 36)
		}
		if t, _ := in.Step["title"].(string); t != "" {
			ss.Title = truncRunes(t, 80)
		} else if cve, _ := in.Step["cve"].(string); cve != "" {
			ss.Title = "安全研判：" + truncRunes(cve, 60)
		}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	ss.Messages = appendOrReuseUserTurn(ss.Messages, in.Retry, aiMsg{Role: "user", Text: in.Message, Images: imgNames, At: now, By: user.User})
	// the question is kept at once: whatever happens to the page, it is not lost
	if err := s.aiSaveSession(j.ID, ss); err != nil {
		s.fail(w, 500, "对话无法保存")
		return
	}
	s.auditReq(r, "ai-chat", user.User, j.ID+" "+map[string]string{"review": "交付评审", "troubleshoot": "现场排障", "security": "安全研判"}[feature])

	fl, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ev := sse{w, fl}

	var red *aiRedactor
	if st.RedactHosts {
		red = newAIRedactor(s.planHostNames(j.ID))
	}
	system := aiSystemReview
	primarySkill := "delivery-review"
	switch feature {
	case "troubleshoot":
		system = aiSystemTrouble
		primarySkill = "step-troubleshooting"
	case "security":
		system = aiSystemSecurityCluster
		primarySkill = ""
	}
	if primarySkill != "" {
		system += s.skillBlock(user.User, primarySkill, "proposal-writing")
	}
	system += s.deliveryLifecycleFacts(j.ID) + s.controllerFacts(j.ID) + s.deliverySkillHint(j.ID)
	var final aiReply
	var used, proposed []string
	var lastErr error
	var tried aiProvider
	var failedAttempts []aiAttemptDiag
	for i, p := range providers {
		tried = p
		start := time.Now()
		var made []string
		in.Options.User = user.User
		in.Options.Made = &producedFiles{}
		reply, tools, err := s.aiRunTurn(effortCtx(ctx, in.Options), p, ss, system, imgNames, j, red, ev, &made, in.Options)
		u := usageFrom(p, reply)
		u.User, u.IP, u.Feature, u.Job, u.Target, u.Session, u.Tools = user.User, clientIP(r), feature, j.ID, j.ClusterID, ss.ID, len(tools)
		u.MS, u.OK, u.Failover = time.Since(start).Milliseconds(), err == nil, i > 0
		if err != nil {
			u.Error = truncRunes(err.Error(), 200)
			if d := aiDiagFromErr(err); d != nil {
				u.applyDiag(d)
				failedAttempts = append(failedAttempts, d.Attempts...)
			}
		}
		s.aiRecordUsage(u)
		if err == nil {
			final, used, proposed, lastErr = reply, tools, made, nil
			break
		}
		lastErr = err
		if ctx.Err() != nil {
			return // stopped
		}
		if i+1 < len(providers) {
			ev.send(map[string]any{"t": "notice", "v": "「" + p.Name + " · " + p.Model + "」失败，改用备用模型"})
		}
	}
	if lastErr != nil {
		errText := localizeGoMessage(reqLang(r), lastErr.Error())
		errDiag := buildChatErrorDiag(lastErr, failedAttempts, tried)
		ss.Messages = append(ss.Messages, aiMsg{Role: "assistant", Error: errText, ErrorDiag: errDiag, At: time.Now().UTC().Format(time.RFC3339)})
		saved := s.aiSaveSession(j.ID, ss) == nil
		errPayload := map[string]any{"t": "error", "v": errText, "saved": saved}
		if errDiag != nil {
			errPayload["diag"] = errDiag
		}
		ev.send(errPayload)
		return
	}
	ss.Messages = append(ss.Messages, aiMsg{Role: "assistant", Text: final.Text, Tools: used, Steps: final.Steps, MS: final.TotalMS, Proposals: proposed, Ask: final.Ask, Files: final.Files, At: time.Now().UTC().Format(time.RFC3339)})
	if err := s.aiSaveSession(j.ID, ss); err != nil {
		ev.send(map[string]any{"t": "error", "v": "对话无法保存"})
		return
	}
	s.learnLater(user.User, in.Message, final.Text)
	ev.send(map[string]any{"t": "done", "model": tried.Model, "in": final.In, "out": final.Out})
}

// aiRunTurn answers the latest user message, letting the model call tools for up to eight rounds.
func (s *storeServer) aiRunTurn(ctx context.Context, p aiProvider, ss aiSession, system string, newImages []string, j storeJob, red *aiRedactor, ev sse, proposed *[]string, opts aiOpts) (aiReply, []string, error) {
	tc := aiToolCtx{s: s, job: j, user: opts.User, session: ss.Key, proposed: proposed}
	if opts.Workspace == nil {
		opts.Workspace = s.deliveryWorkspaceSpec(j.ID, "交付项目 "+firstNonEmptyStr(j.AppName, j.ID))
	}
	feat := featureOfKey(ss.Key)
	ext := s.extFor(feat, opts)
	ctx = ext.bindCtx(ctx, ev)
	tools := append(aiToolsFor(feat), ext.tools...)
	system += ext.prompt
	prep := func(t string) string { return red.out(aiScrub(t)) }
	var msgs []aiMessage
	sys := system
	if p.Tools == "no" {
		// the model cannot call tools: hand it the delivery up front instead
		tools = nil
		sys += "\n\n以下是这份交付的内容（你无法调用工具，只能依据它）：\n" + tc.run("delivery_info", "{}") + "\n执行手册：\n" + tc.run("runbook", "{}") + "\n执行记录：\n" + tc.run("execution_record", "{}")
		if feat == "security" {
			sys += "\n集群安全审计：\n" + tc.run("cluster_security_info", "{}")
		}
	}
	if c := stepContext(ss.Step); c != "" {
		sys += "\n\n" + c
	}
	msgs = append(msgs, aiMessage{Role: "system", Content: prep(sys)})
	for i, m := range ss.Messages {
		if isErrorOnlyMsg(m) {
			continue
		}
		if m.Role == "assistant" {
			msgs = append(msgs, aiMessage{Role: "assistant", Content: prep(m.Text + m.askText() + m.rehearsalText())})
			continue
		}
		text := prep(m.Text)
		// only the last few images are re-sent; earlier ones were already described in the answers
		if len(m.Images) > 0 && p.Vision != "no" && i >= len(ss.Messages)-3 {
			parts := []map[string]any{{"type": "text", "text": text}}
			for _, n := range m.Images {
				if d := s.aiImageData(j.ID, n); d != "" {
					parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": d}})
				}
			}
			msgs = append(msgs, aiMessage{Role: "user", Content: parts})
		} else {
			if len(m.Images) > 0 {
				text += "\n（附带 " + fmt.Sprint(len(m.Images)) + " 张截图，当前模型无法查看）"
			}
			msgs = append(msgs, aiMessage{Role: "user", Content: text})
		}
	}
	return s.aiToolLoop(ctx, p, msgs, tools, red, ev, ext.wrap(tc.run), proposed)
}

func isCardOutputTool(name string) bool {
	return strings.HasPrefix(name, "propose") || strings.HasPrefix(name, "suggest_") || name == askToolName
}

func filterCardOutputTools(tools []aiToolDef) []aiToolDef {
	var out []aiToolDef
	for _, t := range tools {
		if isCardOutputTool(t.Name) {
			out = append(out, t)
		}
	}
	return out
}

// aiToolLoop lets the model call tools across research rounds and reserves final rounds for action/proposal cards.
// Proposals the tools make are announced to the browser as they appear.
func (s *storeServer) aiToolLoop(ctx context.Context, p aiProvider, msgs []aiMessage, tools []aiToolDef, red *aiRedactor, ev sse, run func(name, args string) string, proposed *[]string) (aiReply, []string, error) {
	var total aiReply
	var used []string
	began := time.Now()
	ev.send(map[string]any{"t": "reset", "model": p.Model, "provider": p.Name}) // a backup model starts the answer again
	// a reasoning model's thinking streams as it comes; each round's thinking becomes a step of its own
	var thinking strings.Builder
	thinkStart := time.Time{}
	ctx = withThinking(ctx, func(t string) {
		if thinking.Len() == 0 {
			thinkStart = time.Now()
		}
		thinking.WriteString(t)
		ev.send(map[string]any{"t": "think", "v": red.back(t)})
	})
	thought := false
	flushThinking := func() {
		thought = false
		if t := strings.TrimSpace(red.back(thinking.String())); t != "" {
			thought = true
			total.Steps = append(total.Steps, aiStep{Kind: "think", Text: truncRunes(t, 20000), MS: time.Since(thinkStart).Milliseconds()})
			ev.send(map[string]any{"t": "thinkdone", "ms": time.Since(thinkStart).Milliseconds()})
		}
		thinking.Reset()
	}
	const maxResearchRounds = 12
	const maxTotalRounds = 14
	for round := 0; ; round++ {
		if round == maxResearchRounds && len(tools) > 0 {
			cardTools := filterCardOutputTools(tools)
			if len(cardTools) > 0 {
				tools = cardTools
				msgs = append(msgs, aiMessage{Role: "user", Content: "信息核查已足够，请停止继续读文件，直接根据已掌握内容作答；如需输出提案或变更演练卡片（如 propose_rehearsal），现在即可调用对应卡片工具后完成回答。"})
			} else {
				tools = nil
				msgs = append(msgs, aiMessage{Role: "user", Content: "请根据已经看到的内容直接回答。"})
			}
		} else if round >= maxTotalRounds {
			tools = nil // hard cap; make it answer
			msgs = append(msgs, aiMessage{Role: "user", Content: "请根据已经看到的内容直接回答。"})
		}
		stream := func(t string) {
			if red == nil {
				ev.send(map[string]any{"t": "text", "v": t})
			}
		}
		reply, err := s.aiChat(ctx, p, msgs, tools, stream)
		total.In += reply.In
		total.Out += reply.Out
		total.Cached += reply.Cached
		total.Reasoning += reply.Reasoning
		total.Rounds++
		if total.FirstMS == 0 {
			total.FirstMS = reply.FirstMS
		}
		if reply.Diag != nil {
			total.Diag = reply.Diag
		} else if d := aiDiagFromErr(err); d != nil {
			total.Diag = d
		}
		total.TotalMS = time.Since(began).Milliseconds()
		flushThinking()
		if reply.Reasoning > 0 && !thought {
			// some models think but keep what they thought to themselves; say that it happened and how long it took
			total.Steps = append(total.Steps, aiStep{Kind: "think", Summary: tr(ctxLang(ctx), fmt.Sprintf("用了 %d 个思考 token，这个模型不公开思考内容", reply.Reasoning), fmt.Sprintf("Used %d reasoning tokens (hidden by model)", reply.Reasoning)), MS: reply.FirstMS})
			ev.send(map[string]any{"t": "thought-hidden", "n": reply.Reasoning, "ms": reply.FirstMS})
		}
		if err != nil {
			return total, used, err
		}
		if len(reply.ToolCalls) == 0 {
			total.Text = red.back(reply.Text)
			if red != nil {
				ev.send(map[string]any{"t": "text", "v": total.Text})
			}
			return total, used, nil
		}
		// what the model said before it looked is part of the work, not of the answer
		if t := strings.TrimSpace(red.back(reply.Text)); t != "" {
			total.Steps = append(total.Steps, aiStep{Kind: "thought", Text: t})
			ev.send(map[string]any{"t": "thought", "v": t})
		}
		msgs = append(msgs, aiMessage{Role: "assistant", Content: reply.Text, ToolCalls: reply.ToolCalls})
		for _, call := range reply.ToolCalls {
			name := call.Function.Name
			if name == askToolName {
				if ask := parseAsk(call.Function.Arguments); ask != nil {
					// the turn ends here: the questions are the answer, and the reply comes as the next message
					total.Ask = ask
					used = append(used, name)
					total.Text = strings.TrimSpace(red.back(reply.Text))
					ev.send(map[string]any{"t": "ask", "v": ask})
					return total, used, nil
				}
				msgs = append(msgs, aiMessage{Role: "tool", ToolCallID: call.ID, Content: tr(ctxLang(ctx), "没有有效的问题。", "No valid questions.")})
				continue
			}
			used = append(used, name)
			args := red.back(call.Function.Arguments)
			kind := stepKind(name)
			ev.send(map[string]any{"t": "tool", "v": name})
			ev.send(map[string]any{"t": "step", "id": call.ID, "kind": kind, "name": name, "args": truncRunes(args, stepArgsMax(name))})
			before := len(*proposed)
			t0 := time.Now()
			out := run(name, args)
			st := aiStep{Kind: kind, ID: call.ID, Name: name, Args: truncRunes(args, stepArgsMax(name)), Summary: stepSummary(name, out), MS: time.Since(t0).Milliseconds(), OK: stepOK(out), Preview: stepPreview(red.back(out))}
			total.Steps = append(total.Steps, st)
			ev.send(map[string]any{"t": "stepdone", "id": st.ID, "summary": st.Summary, "ms": st.MS, "ok": st.OK, "preview": st.Preview})
			msgs = append(msgs, aiMessage{Role: "tool", ToolCallID: call.ID, Content: red.out(out)})
			if pf, ok := ctx.Value(madeKey{}).(*producedFiles); ok {
				if fs := pf.take(); len(fs) > 0 {
					total.Files = append(total.Files, fs...)
					ev.send(map[string]any{"t": "files", "v": fs})
				}
			}
			for _, id := range (*proposed)[before:] {
				ev.send(map[string]any{"t": "proposal", "v": id})
			}
		}
		// pictures the assistant asked to see come after all the tool results of this round, as a message of the person
		if pf, ok := ctx.Value(madeKey{}).(*producedFiles); ok {
			if parts, names := pf.takeViews(); len(parts) > 0 {
				note := "（你要看的图片：" + strings.Join(names, "、") + "）"
				if p.Vision == "no" {
					msgs = append(msgs, aiMessage{Role: "user", Content: note + " 当前模型不能看图，没有交给你；请告诉用户换一个能看图的模型。"})
				} else {
					msgs = append(msgs, aiMessage{Role: "user", Content: append([]map[string]any{{"type": "text", "text": note}}, parts...)})
				}
			}
		}
	}
}

// aiStep is one thing the assistant did while working on an answer: something it said, or a tool it used.
type aiStep struct {
	Kind    string `json:"kind"`              // think | thought | tool | skill | mcp
	Preview string `json:"preview,omitempty"` // the start of what the tool returned
	Text    string `json:"text,omitempty"`
	ID      string `json:"id,omitempty"`
	Name    string `json:"name,omitempty"`
	Args    string `json:"args,omitempty"`
	Summary string `json:"summary,omitempty"`
	MS      int64  `json:"ms,omitempty"`
	OK      bool   `json:"ok,omitempty"`
}

// stepPreview is the start of what a tool returned, for someone who wants to see what the assistant saw.
func stepPreview(out string) string {
	const max = 1500
	if len(out) <= max {
		return out
	}
	cut := out[:max]
	for !utf8.ValidString(cut) && len(cut) > 0 {
		cut = cut[:len(cut)-1]
	}
	return cut + "\n…"
}

func stepOK(out string) bool {
	for _, bad := range []string{"外部工具", "外部服务连接失败", "没有这个技能", "提案没有通过", "文件不存在", "没有找到", "没有这个", "文件集不合规", "检查通过，但试生成失败", "还没有草稿", "请指明", "用户拒绝了本次沙箱运行请求", "等待用户授权沙箱运行超时", "管理员已将沙箱网络策略设为", "代码沙箱没有开启", "运行失败：", "安全公告查询失败", "联网搜索没有开启"} {
		if strings.HasPrefix(out, bad) {
			return false
		}
	}
	return true
}

// stepSummary says in a few words what a tool brought back.
func stepSummary(name, out string) string {
	first := strings.TrimSpace(strings.SplitN(out, "\n", 2)[0])
	if strings.HasPrefix(name, "propose") || name == "suggest_component_change" || name == "suggest_security_rehearsal" || name == "search_files" || name == "draft_search" || name == "workspace_search" || name == "component_sync_status" || name == checkPkgSecName || name == "library_runtimes" || !stepOK(out) {
		return truncRunes(first, 110)
	}
	lines := strings.Count(out, "\n") + 1
	kb := float64(len(out)) / 1024
	if kb >= 1 {
		return fmt.Sprintf("%d 行 · %.1f KiB", lines, kb)
	}
	return fmt.Sprintf("%d 行 · %d 字节", lines, len(out))
}

var reDataImage = regexp.MustCompile(`^data:image/(png|jpeg|gif|webp);base64,`)

func (s *storeServer) aiStoreImage(job, data string) (string, error) {
	return s.aiStoreImageIn(s.aiDir(job), data)
}

// aiStoreImageIn keeps a picture under dir/img.
func (s *storeServer) aiStoreImageIn(base, data string) (string, error) {
	m := reDataImage.FindStringSubmatch(data)
	if m == nil || len(data) > 6<<20 {
		return "", fmt.Errorf("图片需要是 png、jpg、gif 或 webp，且不超过 4 MiB")
	}
	raw, err := base64.StdEncoding.DecodeString(data[len(m[0]):])
	if err != nil {
		return "", fmt.Errorf("图片无法读取")
	}
	h := sha256.Sum256(raw)
	name := hex.EncodeToString(h[:10]) + "." + map[string]string{"jpeg": "jpg"}[m[1]]
	if strings.HasSuffix(name, ".") {
		name += m[1]
	}
	dir := filepath.Join(base, "img")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return name, os.WriteFile(filepath.Join(dir, name), raw, 0o600)
}

func (s *storeServer) aiImageData(job, name string) string {
	b, err := os.ReadFile(filepath.Join(s.aiDir(job), "img", filepath.Base(name)))
	if err != nil {
		return ""
	}
	return "data:" + http.DetectContentType(b) + ";base64," + base64.StdEncoding.EncodeToString(b)
}

// aiResolveHandler asks the model to write up the conversation and attaches it to the execution record.
func (s *storeServer) aiResolveHandler(w http.ResponseWriter, r *http.Request, user storeSession, j storeJob) {
	var in struct {
		Key string `json:"key"`
		// Draft only writes the record up for the person to read; nothing is saved until it comes back as Report.
		Draft bool `json:"draft"`
		// Report is the record as the person confirmed it (they may have edited it).
		Report *struct {
			Title     string   `json:"title"`
			Symptom   string   `json:"symptom"`
			Evidence  string   `json:"evidence"`
			Cause     string   `json:"cause"`
			Fix       string   `json:"fix"`
			Changed   bool     `json:"changed"`
			Followups []string `json:"followups"`
			Model     string   `json:"model"`
		} `json:"report"`
		// MarkStep also marks the runbook step this conversation is about as done after a problem was solved.
		MarkStep bool `json:"mark_step"`
		// ToKB also keeps the write-up in the person's own knowledge base.
		ToKB bool `json:"to_kb"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10)).Decode(&in) != nil || !reSessionKey.MatchString(in.Key) {
		s.fail(w, 400, "这段对话不存在，或已过期")
		return
	}
	ss := s.aiLoadSession(j.ID, in.Key)
	if in.Report != nil {
		s.saveWriteUp(w, r, user, j, ss, in.Report.Title, in.Report.Symptom, in.Report.Evidence, in.Report.Cause, in.Report.Fix, in.Report.Changed, in.Report.Followups, in.Report.Model, in.MarkStep, in.ToKB)
		return
	}
	if len(ss.Messages) < 2 {
		s.fail(w, 409, "还没有对话内容")
		return
	}
	feature := featureOfKey(ss.Key)
	if code, msg := s.checkAIFeature(user.User, feature); code != 0 {
		s.fail(w, code, msg)
		return
	}
	st := s.aiLoad()
	providers := st.aiProvidersFor(feature)
	if len(providers) == 0 {
		s.fail(w, 409, "AI 功能未开启")
		return
	}
	var red *aiRedactor
	if st.RedactHosts {
		red = newAIRedactor(s.planHostNames(j.ID))
	}
	var sb strings.Builder
	for _, m := range ss.Messages {
		who := "工程师"
		if m.Role == "assistant" {
			who = "助手"
		}
		sb.WriteString(who + "：" + truncRunes(m.Text, 3000) + "\n\n")
	}
	convo := sb.String()
	// a long conversation is written up from its end: that is where the problem was solved
	if r := []rune(convo); len(r) > 24000 {
		convo = "……（前面的对话已省略）\n" + string(r[len(r)-24000:])
	}
	ask := "请把下面这段排障/变更/评审对话整理成一份结构化变更与处置报告，只输出一个 JSON 对象（不要代码块、不要解释）。先填 findings：把对话里出现过的每一个“问题或猜测”列成 {what: 一句话, verdict: root（最终真正阻断或本次要变更的核心主题，只能有一个）| side（真实存在但不是主线，如顺手修好的小问题）| ruled_out（已排除或误判）}。然后填 title（10~28字的简明中文变更/处置报告标题，例如「调整 Patroni 同步副本数参数」或「修复 pg_hba 本机复制规则」），后面的字段只写 verdict 为 root 的那一个：symptom（变更背景或用户一开始遇到的现象，一两句，不要写被排除的猜测）、evidence（关键证据，如命令输出或报错片段，可为空）、cause（原因或变更依据，一两句，不要罗列无关问题）、fix（针对该主题的最终执行命令与处理经过；side 的问题最多在 followups 里一笔带过，ruled_out 的一律不写）、changed_delivery（布尔：初始交付基线本身是否存在偏差需要修改）、followups（字符串数组：还需要跟进的事项，可为空）。内容必须来自对话，不要编造。对话里常有与主线无关的小插曲（SSH 指纹确认、命令入口不存在、被误判的进程占用等）：把这些插曲当作噪音略去或只在证据里一笔带过；fix 写最终有效的命令与步骤。字符串里的换行写成 \\n，双引号要转义。\n\n" + red.out(aiScrub(convo))
	var parsed struct {
		Title, Symptom, Evidence, Cause, Fix string
		Changed                              bool
		Followups                            []string
	}
	var model, lastText string
	var err error
	good := false
	// the model sometimes answers in prose or cuts the JSON short: ask again, and try the next model
	for attempt := 0; attempt < 2 && !good; attempt++ {
		for _, p := range providers {
			var rep aiReply
			rep, err = s.aiChat(r.Context(), p, []aiMessage{{Role: "system", Content: "你负责把运维与交付对话整理成结构化变更报告。只输出 JSON。"}, {Role: "user", Content: ask}}, nil, nil)
			ru := usageFrom(p, rep)
			ru.User, ru.IP, ru.Feature, ru.Job, ru.Target, ru.Session, ru.OK = user.User, clientIP(r), feature, j.ID, j.ClusterID, ss.ID, err == nil
			if err != nil {
				ru.Error = truncRunes(err.Error(), 200)
				if d := aiDiagFromErr(err); d != nil {
					ru.applyDiag(d)
				}
			}
			text := red.back(rep.Text)
			if err == nil {
				if v, ok := readWriteUp(text); ok {
					parsed.Title, parsed.Symptom, parsed.Evidence, parsed.Cause, parsed.Fix, parsed.Changed, parsed.Followups = v.Title, v.Symptom, v.Evidence, v.Cause, v.Fix, v.Changed, v.Followups
					good, model = true, p.Model
				} else {
					lastText = text
					ru.OK, ru.Error = false, "写记录：模型的回复读不出来："+truncRunes(strings.Join(strings.Fields(text), " "), 160)
				}
			}
			s.aiRecordUsage(ru)
			if good {
				break
			}
		}
		if r.Context().Err() != nil {
			return
		}
	}
	if !good {
		// say what really happened: the model could not be reached, or what it answered could not be read
		msg := ""
		switch {
		case err != nil:
			msg = "写记录失败：" + err.Error()
		case strings.TrimSpace(lastText) == "":
			msg = "写记录失败：模型没有返回任何内容。请检查设置 → AI 里这个模型是否可用（也可能是输出被限制得太短）"
		default:
			msg = "写记录失败：模型返回了内容，但不是约定的 JSON。它回复的开头是：" + truncRunes(strings.Join(strings.Fields(lastText), " "), 120)
		}
		s.fail(w, 502, msg)
		return
	}
	draftTitle := truncRunes(firstNonEmptyStr(strings.TrimSpace(parsed.Title), ss.Title, "现场变更报告"), 80)
	if in.Draft {
		s.writeJSON(w, 200, aiReport{Session: ss.ID, Kind: ss.Kind, Key: ss.Key, Title: draftTitle, Symptom: parsed.Symptom, Evidence: parsed.Evidence, Cause: parsed.Cause, Fix: parsed.Fix, Changed: parsed.Changed, Followups: parsed.Followups, Model: model, At: time.Now().UTC().Format(time.RFC3339), By: user.User})
		return
	}
	s.saveWriteUp(w, r, user, j, ss, draftTitle, parsed.Symptom, parsed.Evidence, parsed.Cause, parsed.Fix, parsed.Changed, parsed.Followups, model, in.MarkStep, in.ToKB)
}

// saveWriteUp puts the record into the execution record, archives a standalone Change Report in Cluster Docs when the
// cluster is already deployed/running, and when asked marks the step the conversation was about as done.
func (s *storeServer) saveWriteUp(w http.ResponseWriter, r *http.Request, user storeSession, j storeJob, ss aiSession, customTitle, symptom, evidence, cause, fix string, changed bool, followups []string, model string, markStep bool, toKB bool) {
	for _, t := range []string{symptom, evidence, cause, fix} {
		if len([]rune(t)) > 20000 {
			s.fail(w, 400, "每一项最多 20000 字")
			return
		}
	}
	if strings.TrimSpace(cause) == "" && strings.TrimSpace(fix) == "" {
		s.fail(w, 400, "原因和处理办法至少要写一项")
		return
	}
	if len(followups) > 30 {
		followups = followups[:30]
	}
	finalTitle := truncRunes(firstNonEmptyStr(strings.TrimSpace(customTitle), ss.Title, "现场变更报告"), 80)
	rep := aiReport{Session: ss.ID, Kind: ss.Kind, Key: ss.Key, Title: finalTitle, Symptom: strings.TrimSpace(symptom), Evidence: strings.TrimSpace(evidence), Cause: strings.TrimSpace(cause), Fix: strings.TrimSpace(fix), Changed: changed, Followups: followups, Model: model, At: time.Now().UTC().Format(time.RFC3339), By: user.User}
	if toKB {
		if d, err := s.kbSave(user.User, kbDoc{Title: finalTitle, Text: reportMarkdown(rep, "交付 "+j.ClusterID+" · "+finalTitle)}); err == nil {
			rep.KBID, rep.KBTitle = d.ID, d.Title
		}
	}
	// Archive as a standalone exportable Change Report document under Cluster Docs whenever the cluster is deployed/running.
	if j.ClusterID != "" {
		if lc, ok := s.deliveryLifecycleInfo(j.ID); ok && lc.ClusterRunning {
			rep.DocID = s.upsertChangeNoteDoc(j.ClusterID, rep)
		} else if j.Outcome == outcomeDone || j.Outcome == outcomeDeviated {
			rep.DocID = s.upsertChangeNoteDoc(j.ClusterID, rep)
		}
	}
	s.mu.Lock()
	doc := s.readProgress(j.ID)
	kept := doc.Reports[:0]
	for _, x := range doc.Reports {
		if x.Session != rep.Session {
			kept = append(kept, x)
		}
	}
	doc.Reports = append(kept, rep)
	if stepKey, ok := strings.CutPrefix(ss.Key, "step:"); ok && markStep {
		old := doc.Steps[stepKey]
		if old.State != "skipped" {
			old.State, old.By, old.At = "resolved", user.User, rep.At
			if old.Note == "" {
				old.Note = truncRunes("执行中遇到问题，已解决："+firstNonEmptyStr(rep.Symptom, rep.Cause), 500)
			}
			doc.Steps[stepKey] = old
			doc.Events = append(doc.Events, progressEvent{At: rep.At, By: user.User, Key: stepKey, Title: truncRunes(ss.Title, 120), State: "resolved"})
			if len(doc.Events) > maxEvents {
				doc.Events = doc.Events[len(doc.Events)-maxEvents:]
			}
		}
	}
	err := s.writeProgress(j.ID, doc)
	if err == nil {
		cur := s.jobs[j.ID]
		cur.RunDone, cur.RunFailed = countSteps(doc)
		if s.persistJob(cur) == nil {
			s.jobs[j.ID] = cur
		}
	}
	s.mu.Unlock()
	if err != nil {
		s.fail(w, 500, "记录无法保存")
		return
	}
	s.auditReq(r, "ai-resolve", user.User, j.ID+" "+ss.Key)
	s.writeJSON(w, 200, rep)
}

// reportMarkdown is a write-up as a knowledge-base document.
func reportMarkdown(r aiReport, where string) string {
	parts := []string{"## 现象\n\n" + r.Symptom}
	if r.Evidence != "" {
		parts = append(parts, "## 证据\n\n```\n"+r.Evidence+"\n```")
	}
	parts = append(parts, "## 原因\n\n"+r.Cause, "## 处理\n\n"+r.Fix)
	if len(r.Followups) > 0 {
		var l []string
		for _, f := range r.Followups {
			l = append(l, "- "+f)
		}
		parts = append(parts, "## 待跟进\n\n"+strings.Join(l, "\n"))
	}
	if where != "" {
		parts = append(parts, "> 来自 "+where)
	}
	return strings.Join(parts, "\n\n")
}

func featureOfKey(key string) string {
	if key == "sec" || strings.HasPrefix(key, "sec:") {
		return "security"
	}
	if strings.HasPrefix(key, "step:") {
		return "troubleshoot"
	}
	return "review"
}

type madeKey struct{}

func effortCtx(ctx context.Context, o aiOpts) context.Context {
	if o.Made != nil {
		ctx = context.WithValue(ctx, madeKey{}, o.Made)
	}
	if o.Think != "" {
		return withEffort(ctx, string(o.Think))
	}
	return ctx
}

// stepArgsMax is how much of a tool call's arguments is kept for showing; the code of a sandbox run is shown whole.
func stepArgsMax(name string) int {
	if name == runPythonName || name == runShellName {
		return 12000
	}
	if name == runSkillScriptName {
		return 4000
	}
	return 400
}

type writeUp struct {
	Title, Symptom, Evidence, Cause, Fix string
	Changed                              bool
	Followups                            []string
}

// readWriteUp reads the record a model wrote, whatever the types it used: a number or a list where text was
// asked for, "false" for false, field names in capitals. It needs a cause or a fix, nothing else.
func readWriteUp(text string) (writeUp, bool) {
	js := extractJSON(text)
	if js == "" {
		return writeUp{}, false
	}
	var raw map[string]any
	if json.Unmarshal([]byte(js), &raw) != nil {
		return writeUp{}, false
	}
	m := map[string]any{}
	for k, v := range raw {
		m[strings.ToLower(k)] = v
	}
	str := func(keys ...string) string {
		for _, k := range keys {
			switch v := m[k].(type) {
			case string:
				if strings.TrimSpace(v) != "" {
					return strings.TrimSpace(v)
				}
			case []any:
				var parts []string
				for _, x := range v {
					parts = append(parts, strings.TrimSpace(fmt.Sprint(x)))
				}
				if t := strings.Join(parts, "\n"); strings.TrimSpace(t) != "" {
					return t
				}
			case nil:
			default:
				return fmt.Sprint(v)
			}
		}
		return ""
	}
	w := writeUp{Title: str("title", "标题"), Symptom: str("symptom", "现象"), Evidence: str("evidence", "证据"), Cause: str("cause", "原因", "root_cause"), Fix: str("fix", "处理", "solution", "resolution")}
	switch v := m["changed_delivery"].(type) {
	case bool:
		w.Changed = v
	case string:
		w.Changed = strings.EqualFold(strings.TrimSpace(v), "true") || v == "是"
	}
	switch v := m["followups"].(type) {
	case []any:
		for _, x := range v {
			if t := strings.TrimSpace(fmt.Sprint(x)); t != "" {
				w.Followups = append(w.Followups, t)
			}
		}
	case string:
		if strings.TrimSpace(v) != "" {
			w.Followups = []string{strings.TrimSpace(v)}
		}
	}
	return w, w.Cause != "" || w.Fix != ""
}

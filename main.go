package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"middleware-deployer/mwpack"
	"middleware-deployer/pkglib"
)

const (
	version            = "1.0.271-dev"
	currentReleaseDate = "2026-11-24"
)

// buildID can be injected at compile time via `-ldflags "-X main.buildID=..."`.
// When unset, currentBuildID hashes the running executable once at startup so
// every freshly compiled binary gets a deterministic fingerprint for hot-reload.
var (
	buildID          = ""
	resolvedBuildID  string
	buildIDResolveMu sync.Once
)

func currentBuildID() string {
	buildIDResolveMu.Do(func() {
		if s := strings.TrimSpace(buildID); s != "" {
			resolvedBuildID = s
			return
		}
		h := sha256.New()
		if exe, err := os.Executable(); err == nil {
			if f, err := os.Open(exe); err == nil {
				_, _ = io.Copy(h, f)
				_ = f.Close()
				resolvedBuildID = hex.EncodeToString(h.Sum(nil))[:12]
				return
			}
		}
		if idx, err := storeAssets.ReadFile("store_assets/index.html"); err == nil {
			h.Write(idx)
		}
		h.Write([]byte(version + "|" + currentReleaseDate))
		resolvedBuildID = hex.EncodeToString(h.Sum(nil))[:12]
	})
	return resolvedBuildID
}

type releaseNote struct {
	Version      string   `json:"version"`
	Date         string   `json:"date"`
	Title        string   `json:"title"`
	TitleEn      string   `json:"-"`
	Highlights   []string `json:"highlights"`
	HighlightsEn []string `json:"-"`
}

var platformReleaseNotes = []releaseNote{
	{
		Version: "1.0.271-dev",
		Date:    "2026-11-24",
		Title:   "修复演练吸顶进度栏边缘割裂与「展开已完成」胶囊居中",
		TitleEn: "Fix sticky rehearsal gate bar edge alignment and expand-done pill centering",
		Highlights: []string{
			"修复「展开已完成 / 收起已完成」胶囊按钮因 all: unset + padding: 1px 缺少固定高度与 line-height 导致的文字上下不居中问题，统一固定 22px 高度并与「必测步骤」标题精准基线居中对齐",
			"修复吸顶进度筛选栏（.rh-gate）因内缩 8px 未铺满工作列边缘，导致滚动时下方卡片右边框/阴影在高分屏下透出竖向分割线及底边与顶栏不齐的问题：同步负边距满幅遮罩（兼容记录栏/交付基线抽屉展开收起过渡）并提升层级，彻底消除割裂感",
		},
		HighlightsEn: []string{
			"Fixed vertical text centering inside the Expand/Fold done pill button (.rh-done-toggle-btn) with explicit 22px height, line-height: 1, and aligned title row",
			"Eliminated the right-edge vertical seam and subpixel border bleed on the sticky rehearsal progress bar (.rh-gate) by matching parent column full-bleed margins across collapsed/ledger/aside layouts",
		},
	},
	{
		Version: "1.0.270-dev",
		Date:    "2026-11-24",
		Title:   "全面精修演练 AI 推演六幕微动画与图标文字间距",
		TitleEn: "Refined all 6 rehearsal AI stage micro-animations, spacing, and vector craft",
		Highlights: []string{
			"将 AI 推演六幕小动画（ACT 01 基线扫描 / ACT 02 安全脱敏 / ACT 03 网关握手 / ACT 04 沙盘推演 / ACT 05 方案签章 / 通道熔断保护）整体升级为 360×96 宽幅矢量画布，统一使用矢量圆形对勾徽标与左对齐留白并采用 dominantBaseline 精准垂直居中，彻底解决「握手已连通」等对勾与文字紧贴重叠问题",
			"优化 ACT 04 沙盘推演布局与动态联动：顶部「握手已连通」胶囊与下方探针轨迹完全分层零碰撞，新增探针聚光锥与「从库 01 → 从库 02 → 主库守卫」同步节点高亮动效",
			"全面消除 SVG 内 Unicode 符号混排，升级 ACT 01 渐变激光扫描、ACT 02 分层穿盾脱敏、ACT 03 双向加密握手对接与 ACT 05 居中校验签章波纹，完美适配明暗双主题与中英文",
		},
		HighlightsEn: []string{
			"Upgraded all 6 rehearsal AI stage micro-animations (ACT 01-05 + Circuit Breaker) to a spacious 360x96 vector canvas with crisp vector checkmark badges, generous icon-to-text gaps, and dominantBaseline centering, fixing tight/overlapping checkmark labels",
			"Eliminated probe-vs-pill overlap in ACT 04 Reasoning and added a spotlight cone with synchronized node highlighting across Rep 01 -> Rep 02 -> Primary",
			"Replaced inconsistent Unicode ticks with vector icons across all scenes and upgraded scan gradients, layered shield pass-through, dual-link handshake, and centered verification seal ripples for both light and dark themes",
		},
	},
	{
		Version: "1.0.269-dev",
		Date:    "2026-11-24",
		Title:   "多行执行命令防堡垒机/WebSSH 吞行封装与 AI 生成规范",
		TitleEn: "Paste-safe subshell wrapping for multi-line bastion/WebSSH commands and AI prompts",
		Highlights: []string{
			"新增确定性多行命令防吞行封装 ensurePasteSafeShellCommand：凡单框含 2 条及以上命令自动封装为 ( ... ) </dev/null 子 Shell，迫使交互式 bash 先完整解析整块再按序执行并关闭标准输入，根治 JumpServer/WebSSH 及 Ubuntu sudo use_pty 下慢命令（psql/patronictl/sleep）吞掉后续行与输出交错问题",
			"全面更新演练生成、快速演练、核验修订、排障修复、对话助手与 change-rehearsal 技能提示词，明确要求 AI 输出多行防吞行子 Shell 格式、禁止裸贴多行及 heredoc 走 stdin（bash <<'EOF'），并拆短严格预检长行",
			"前端演练命令框、AI 对话 Shell 代码块与归档 SOP 命令复制同步接入 toPasteSafeShell（历史已保存演练开箱即生效），命令框标题栏展示「整块防吞行」胶囊说明",
		},
		HighlightsEn: []string{
			"Added deterministic paste-safe subshell wrapping ( ... ) </dev/null for multi-command blocks across backend step normalization, strict prechecks, proposals, and rollout remapping, eliminating swallowed lines and interleaved output under JumpServer/WebSSH and Ubuntu sudo use_pty",
			"Updated all rehearsal, verification, troubleshooting, AI chat prompts, and change-rehearsal skill rules to generate concise paste-safe subshell blocks and forbid bare multi-line or bash <<'EOF' heredoc stdin theft",
			"Wired frontend copy-time paste-safe wrapping and a Paste-safe badge into rehearsal command blocks, AI chat shell blocks, and SOP docs so even existing saved rehearsals copy cleanly on first paste",
		},
	},
	{
		Version: "1.0.268-dev",
		Date:    "2026-11-24",
		Title:   "已落地变更模板按内容自动去重归并与多维分类筛选",
		TitleEn: "Content-aware template deduplication and multi-dimensional filtering for rehearsal reuse",
		Highlights: []string{
			"新增归一化生效参数内容指纹与并查集归并：跨集群独立实施、标题表述不同但实际生效参数完全一致的变更自动合并为单张权威模板，展示「已在 N 套集群落地」与「已合并 N 份同内容变更」可展开明细并支持按需切换具体样板",
			"新增语义自动分类（日志与审计 / 安全与认证 / 备份与恢复 / 参数调优 / 高可用与切换 / 升级与扩容 / 日常运维）及多维筛选工具栏：支持按分类、样板集群、推演档位、仅可引入/仅同架构/可极速直达、参数键值搜索及排序快速定位",
			"卡片内直接展示生效参数 key=value 预览胶囊并识别「本集群已生效 · 查看」，同时在批量推广弹窗补齐快速筛选与独立生效直达链接",
		},
		HighlightsEn: []string{
			"Added normalized effective-diff content fingerprinting and union-find consolidation so equivalent production changes across independent clusters merge into one authoritative template with expandable variant history and pilot switching",
			"Added automatic semantic categories (Logging, Security, Backup, Params, HA, Upgrade, Ops) and rich multi-dimensional filters by category, pilot cluster, mode, availability/exact-match/fast-track toggles, parameter search, and sorting",
			"Added inline effective parameter diff preview chips and Already Effective deep-links on template cards and batch propagation target rows",
		},
	},
	{
		Version: "1.0.267-dev",
		Date:    "2026-11-24",
		Title:   "修复能力库工作区底部 52px 高度偏移与贴底铺满",
		TitleEn: "Fix Studio workspace full-viewport height alignment below topbar",
		Highlights: []string{
			"修正「能力库」（Studio）内嵌双栏工作区在桌面端继承 .md-split 负边距导致的底部 52px 留白与左侧列表截断，使左侧栏、列表栏与详情区完全贴底铺满并保留顶栏毛玻璃滚动穿透效果",
		},
		HighlightsEn: []string{
			"Fixed a 52px bottom gap and list clipping inside the Studio workspace caused by nested .md-split negative top margin on desktop, restoring edge-to-edge full-viewport height and frosted topbar scroll-through",
		},
	},
	{
		Version: "1.0.266-dev",
		Date:    "2026-11-24",
		Title:   "合并「能力库」统一工作区并修复顶栏拥挤与中英切换残留",
		TitleEn: "Unified Studio workspace, responsive topbar fit, and live CN/EN switching",
		Highlights: []string{
			"将「知识库 / 技能 / MCP」合并为顶栏单一入口「能力库」（Studio），配备左侧 74px 精简活动栏与色标高亮，保留 #/kb、#/skills、#/mcp 深链并自动记忆上次停留子页",
			"优化顶栏布局与中英文自适应：收拢多余分组分隔线、窄屏下搜索栏自动折叠为紧凑胶囊，并在语言切换后自动复位横向滚动与边界测算，解决英文截断及中→英→中切换后右侧错位",
			"修复中英文实时切换数据残留：/api/me/skills 与设置接口统一按当前语言本地化内置技能，前端语言切换先清缓存与按语言隔离请求池，技能/沙箱/通知等视图随语言即时刷新",
		},
		HighlightsEn: []string{
			"Merged Knowledge, Skills, and MCP into a single topbar entry 'Studio' with a 74px slim activity rail, color-coded active tiles, and full #/kb, #/skills, #/mcp deep-link compatibility",
			"Fixed topbar overflow and CN/EN toggle layout glitches by removing extra dividers, compacting the search pill under 1380px, and resetting nav scroll & bounds on language changes",
			"Fixed stale language data after CN -> EN -> CN toggles across /api/me/skills, settings responses, language-keyed fetch cache, and reactive [lang] reloads in Skills/Sandbox/Notification views",
		},
	},
	{
		Version: "1.0.265-dev",
		Date:    "2026-11-24",
		Title:   "只读采集探针脚本文件名新增生成时间戳，避免下载与 /tmp 覆盖混淆",
		TitleEn: "Add Generation Timestamp to Read-Only Probe Script Filename",
		Highlights: []string{
			"只读探针脚本文件名统一附带生成时间戳（格式 collect-<集群ID>-<演练短ID>-YYYYMMDD-HHmmss.sh）：页面展示、现场运行命令（bash /tmp/...）与下载的 .sh 文件名完全一致。",
			"时间戳绑定探针实际生成/自动修订时间（重算诉求或按报错修订脚本后自动更新时间戳，避免反复下载重名覆盖，同一版脚本复制命令与下载文件名始终对齐）。",
		},
		HighlightsEn: []string{
			"Timestamped probe filenames: read-only probe scripts now use collect-<cluster>-<shortId>-YYYYMMDD-HHmmss.sh consistently across the UI pill, bash /tmp/... run command, and downloaded .sh file.",
			"Deterministic per probe revision: derived from the probe's generation/auto-fix timestamp so re-downloads stay aligned with the copyable command while revised probes never overwrite older files.",
		},
	},
	{
		Version: "1.0.264-dev",
		Date:    "2026-11-24",
		Title:   "变更演练新增模糊诉求前置核对门禁与就地「修正诉求 / 重新研判」",
		TitleEn: "Rehearsal Intent-Clarity Gate & Inline Refine Goal",
		Highlights: []string{
			"模糊诉求 / 截图反推前置核对门禁：在「自动判断」模式下，当用户仅填写简略描述或主要依赖截图（如「看这个截图有点问题」）而未明确变更目标与处理方式时，强制先停留在「诉求核对与边界对齐」（intent_unclear=true），先展示 AI 识别到的现象与拟处理方向并生成意图核对题，严禁跳过确认直接生成探针或执行步骤。",
			"全流程支持「修正诉求 / 重新研判」：未定稿的演练在顶部操作栏、收敛边界条与原始诉求面板均提供就地「修正诉求」入口，支持一键带入 AI 识别摘要改写、增删诉求参考截图、调整推演档位（自动/极速/简单/全量）并流式重新研判刷新方案（新增 POST /api/clusters/{id}/rehearsals/{rid}/refine 接口，异常中断不破坏原会话）。",
			"诉求摘要与截图全程透传下游：修复边界对齐→生成探针及探针→生成步骤阶段未携带 AI 识别摘要（ScopeSummary）与诉求参考截图的问题，确保截图发起的演练全链路上下文不断档。",
		},
		HighlightsEn: []string{
			"Intent-clarity gate before probing/planning: in Auto mode, vague or screenshot-only inputs now pause at Scope Alignment (intent_unclear=true) so AI explicitly states what it recognized and confirms intent before generating probes or steps.",
			"Inline Refine Goal & Re-analyze: any non-finalized rehearsal can now be corrected in place (header, scope bar, or original goal panel)—rewrite the goal, load AI's summary as a draft, add/remove screenshots, switch workflow depth, and stream a fresh triage via POST /api/clusters/{id}/rehearsals/{rid}/refine.",
			"End-to-end context propagation: Stage 2 probe generation and Stage 3 step planning now preserve recognized scope_summary and goal reference screenshots seamlessly.",
		},
	},
	{
		Version: "1.0.263-dev",
		Date:    "2026-11-24",
		Title:   "悬浮 AI 助手打开即开启全新对话，告别残留历史与旧步骤上下文",
		TitleEn: "Floating AI Assistant Starts a Fresh Chat on Open",
		Highlights: []string{
			"打开 AI 助手默认开启全新对话：点击右下角「AI 助手」按钮或按 ⌘J / Ctrl+J 从关闭状态唤起时，自动开启对应页面/集群的全新空白对话，不再残留上次关闭的「演练步骤 #1」或历史会话。",
			"保留最小化恢复与后台回复衔接：点击「—」最小化后的恢复、AI 正在回答中（busy）重新点开，以及点击步骤卡片「问 AI 修改」或安全研判按钮的定向入口均保持原上下文无缝衔接。",
			"历史会话随时一键切换与标题自动同步：所有历史对话与步骤排障记录继续保留在顶部会话切换下拉中随时查阅；新对话发送首条提问后标题自动同步为对话主题，关闭弹窗时自动收起会话菜单。",
		},
		HighlightsEn: []string{
			"Fresh chat on open: clicking the bottom-right AI Assistant launcher or pressing ⌘J / Ctrl+J from closed now starts a clean new conversation scoped to the current page/cluster instead of reopening a stale step thread or old chat.",
			"Preserves active & targeted flows: restoring a minimized bar, reopening while AI is actively streaming, and clicking contextual triggers (Ask AI on a step, security analysis, etc.) keep their exact target context.",
			"Seamless history & header polish: all past chats remain one click away in the conversation switcher, new chats automatically adopt their generated topic title once sent, and the session dropdown closes cleanly when the dock hides.",
		},
	},
	{
		Version: "1.0.262-dev",
		Date:    "2026-11-24",
		Title:   "演练步骤撕票收起后自动平滑定位到下一步",
		TitleEn: "Auto-Focus Next Step After Rehearsal Step Tear-Collapse Animation",
		Highlights: []string{
			"演练步骤完成撕票动画自动精准定位下一步：当某步完成并由展开态收起为紧凑存根时，禁用浏览器默认滚动锚定偏移并在收起布局落地后自动将视口平滑定位到紧随其后的下一步（如完成第 4 步后精准停在第 5 步顶部、保留第 4 步已完成存根在上方可见，不再因上方高度骤减被甩到第 6 步），并附带柔和的序号光环高亮提示；全部必测步骤完成后自动定位至顶部定稿门禁栏。",
		},
		HighlightsEn: []string{
			"Post-Tear Auto-Focus to Next Rehearsal Step: disables competing browser scroll anchoring on the step timeline and smoothly aligns the next pending step cleanly below the sticky progress bar with a gentle arrival ring once a completed step finishes tearing into its compact stub (or scrolls to the finalize gate when all required steps pass).",
		},
	},
	{
		Version: "1.0.261-dev",
		Date:    "2026-11-24",
		Title:   "修复演练流式推演卡在阶段 1/5 及全阶段丝滑切换体验",
		TitleEn: "Fix Live Rehearsal Progress Stuck at Stage 1/5 & Smooth Stage Transitions",
		Highlights: []string{
			"修复 AI 实时推演进度卡在「阶段 1/5」直到分析结束才一次性跳完的根因：RehearsalAIProcess 的阶段推进定时器与计时器原先依赖完整 live 对象引用，高频 SSE 思考/进度流每次到达都会清除未触发的定时器；现改为仅依赖稳定标量与目标阶段索引，并支持满足驻留时长后立即步进，实时流畅展示 1/5 → 2/5 → 连接模型 → 深度推演 → 生成结构化方案全过程。",
			"全面理顺演练各阶段切换与视口定位：发起新建推演时自动折叠输入区为单行已提交诉求条，边界对齐→只读探针、探针诊断修复、只读探针→测试演练、测试演练→定稿 SOP 全链路均立即切入目标阶段并自动滚至阶段条顶部（修复此前在 .md-detail 滚容器内调用 window.scrollBy 无效及定稿阶段停留在旧视图的问题）。",
		},
		HighlightsEn: []string{
			"Fixed live AI progress getting starved at Stage 1/5 until completion: RehearsalAIProcess's choreography timer and clock previously depended on the mutable live object reference, causing frequent SSE chunks to cancel pending step-advance timers. Now depends strictly on stable scalar primitives and targetIdx with immediate advancement once minHold elapses.",
			"Smoothed every rehearsal stage transition & scroll alignment: launcher collapses to a compact submitted-goal strip while creating, Stage 2 diagnosis and Stage 3 -> 4 SOP finalization switch cleanly into dedicated progress panels, and auto-reveal scrolls .rh-stages / .rh-ai-proc inside .md-detail cleanly via scrollIntoView.",
		},
	},
	{
		Version: "1.0.260-dev",
		Date:    "2026-11-24",
		Title:   "跨集群变更推广看板、滚动命令分框防误粘与演练工作台打磨",
		TitleEn: "Cross-Cluster Change Rollout Board, Atomic Rolling Command Boxes & Rehearsal UX Polish",
		Highlights: []string{
			"双向跨集群变更推广与看板：仅已确认生产落地的变更可 1→N 批量推广或按需引入；full/light 默认走只读探针并注入样板蓝图，quick 或同架构无冲突支持快车道直达步骤清单并强制执行严格首步预检门禁，配套右侧推广看板实时追踪进度与冲突。",
			"滚动命令分框与防误粘贴保护：AI 提示词、后端规范化、跨集群映射与 Word SOP 导出全面支持多段独立命令框，自动拆分同框内多台节点的连续重启/切主命令并插入段间暂停核验门禁；同时将「微调 / 问 AI 修改」上移至步骤标题栏，命令框最右侧固定专留「复制」。",
			"演练与文档界面精简打磨：合并只读探针阶段输入框（直接支持回显、截图或手动打字，移除多余切换条），移除文档页冗余的绿色生产落地卡片，修复文档顶栏「上一份 / 下一份」间距与全站组合按钮/输入框拼接圆角。",
			"内置技能跨平台加载修复：统一处理内置技能文档 CRLF 换行，修复 Windows 检出编译环境下内置运维技能无法解析的问题。",
		},
		HighlightsEn: []string{
			"Two-way Cross-Cluster Rollout & Board: propagate or import production-applied changes across clusters with automatic architecture/conflict matching, pilot blueprint injection on probe mode, strict blocking Step 1 precheck gate on fast-track mode, and a live Rollout Board drawer.",
			"Atomic Multi-Node Rolling Command Boxes: prompt rules, deterministic auto-splitting, propagation remapping, and Word SOP export split sequential multi-node restarts/switchovers into isolated copyable boxes with pause-and-verify gates; Edit/Ask-AI moved to step headers so Copy stays pinned far-right.",
			"Rehearsal & Docs UI Cleanup: unified Stage 2 probe textarea (output, screenshots, or manual notes without a mode toggle), removed redundant production-apply card from SOP docs, fixed doc prev/next switcher spacing and global Button.Group/Input.Group joined seams.",
			"Cross-Platform Built-In Skills Fix: normalized CRLF frontmatter parsing so embedded AI operational skills load reliably on Windows checkouts.",
		},
	},
	{
		Version: "1.0.259-dev",
		Date:    "2026-11-24",
		Title:   "安全合规中心、演练生产闭环与原位配置归并、跨平台零中断热更新",
		TitleEn: "Security Compliance Center, Rehearsal Production Closure & Inline Config Merge, Cross-Platform Hot Reload",
		Highlights: []string{
			"安全中心与 CVE 漏洞治理：新增离线安全源同步、组件与集群 CVE 扫描、VEX 处置台账、Word/Excel 合规报告导出及 AI 安全审计助手。",
			"变更演练生产闭环与配置原位归并：支持已定稿演练确认生产落地、作废与替代防误点保护、冲突校验、回退默认跳过，以及「配置」页原位旧值划线对比与变更历史抽屉、「概览」页紧凑台账；同步统一只读探针首行节点与实测版本采集契约。",
			"跨平台零中断热重启与自动化发版：升级 store supervise 网关与内置 store reload 命令全面支持 Windows 与 Linux 零断连热切、编译指纹 build_id 精准识别与前端无感热更新提示，并配套一键热更新与发版脚本。",
			"执行监控、组件工作台与体验打磨：新增全局执行监控、单步热修与交付包导出、放行 Patroni 等伴随组件自定义数据库参数校验，修复弹窗顶栏跳动与演练下拉吸顶漂移。",
		},
		HighlightsEn: []string{
			"Security Center & CVE Governance: Added offline advisory sync, component and cluster CVE scanning, VEX triage ledger, Word/Excel compliance exports, and AI security assistant.",
			"Rehearsal Production Closure & Inline Config Diff: Added production apply/void/supersede guardrails, conflict detection, rollback auto-skip, inline strikethrough parameter diffs and history drawer in Cluster Config, compact overview ledger, and unified live host/version probe headers.",
			"Cross-Platform Zero-Downtime Hot Reload & Release Tooling: Upgraded store supervise and added store reload for Windows and Linux with build_id fingerprinting, zero-drop reloads, frontend hot-reload notice, and dev-reload/release scripts.",
			"Execution Monitor, Component Workbench & UI Polish: Added execution monitoring, step hotfix, delivery bundles, relaxed companion custom database parameter validation, and fixed sticky topbar jump and dropdown scroll anchoring.",
		},
	},
	{
		Version: "1.0.258-dev",
		Date:    "2026-11-18",
		Title:   "全栈中英双语国际化体系与实时无感语言切换",
		TitleEn: "Full-Stack Chinese/English Bilingual Experience & Live Language Switching",
		Highlights: []string{
			"前端控制台全量双语改造：覆盖登录页、交付、应用、组件工作台、软件库、AI 助手、知识库、技能、MCP、变更演练、IAM、审计与平台设置等 84 个模块及组件库本地化；首次访问自动识别浏览器语言（zh-CN / en-US），支持在登录页右上角、顶栏与 Cmd+K 命令面板实时无刷新切换。",
			"组件目录、部署编排与 Word 文档双语化：8 大内置中间件目录元数据、系列契约、预设、参数、交付计划及全部 Word (.docx) 交付手册、变更 SOP、交接、故障复盘与标准模板随 X-Lang / lang 请求头自动切换中英文，并新增自动化防遗漏校验。",
			"后端 API、审计导出与 AI 上下文联动：全量服务接口报错、成分校验与同步影响分析、执行与准备检查、通知模板、安全沙箱、审计/会话 CSV 导出以及 AI 对话与变更演练系统提示词均支持实时按用户界面语言输出对应语言。",
		},
		HighlightsEn: []string{
			"Complete Frontend Bilingual Coverage: Localized all 84 UI modules and Arco Design components across Login, Deliveries, Apps, Component Workbench, Software Library, AI Assistant, Knowledge Base, Skills, MCP, Change Rehearsal, IAM, Audit Trail, and Platform Settings, with automatic browser language detection and reload-free live switching from Login, Topbar, and Cmd+K Palette.",
			"Bilingual Catalog, Orchestration & Word (.docx) Exports: Built-in middleware catalog metadata, series contracts, presets, parameters, execution plans, and all Word (.docx) reports (delivery handbooks, change SOPs, KT, RCA, incident reports, and starter templates) dynamically adapt to the active language via X-Lang / lang.",
			"Full Backend API & AI Language Alignment: Localized HTTP error responses, component validation and sync impact analysis, execution readiness checks, notification templates, sandbox diagnostics, audit/session CSV exports, and AI / Change Rehearsal response languages with automated zero-leakage tests.",
		},
	},
	{
		Version: "1.0.257-dev",
		Date:    "2026-11-18",
		Title:   "企业级控制台视觉重构、全站通透顶栏与演练工具条一体化",
		TitleEn: "Enterprise Console Visual Overhaul, Unified Frosted Topbar & Rehearsal Toolbar Harmonization",
		Highlights: []string{
			"升级企业级色彩与交互质感：收敛主品牌靛蓝（#4338ca）与中性灰底色层级，精简全局顶部导航与二级页签，去除冗余卡片重阴影、侧边装饰折痕与角标刺点，全面提升信息密度与专业观感。",
			"统一全站磨砂顶栏与左侧导航对齐：将全局顶部栏的半透明滚动穿透质感扩展至所有一级视图与详情页，对齐 10 个核心页面的 304px 左侧栏几何规范与细滑滚动条；预热 AI 会话与配置请求并精简切换动画，消除首次打开 AI 助手时的卡顿感。",
			"重构「变更演练」上下文工具条与修正吸顶定位：去掉生硬灰底长条，改为与画布融为一体的磨砂通透工具条，统一 7px 圆角与 30px 控件高度，进入专注演练自动回顶，并修复详情页容器内吸顶元素的双倍偏移。",
		},
		HighlightsEn: []string{
			"Refined enterprise color and interaction craft: deepened the primary indigo accent (#4338ca) and neutral slate surfaces, streamlined global top navigation and secondary tabs, and removed heavy card shadows, side notch creases, and corner dots.",
			"Unified frosted topbar translucency and 304px sidebar geometry: extended translucent scroll-under glass across all primary views and detail panes, aligned left sidebar widths and slim scrollbars across 10 core routes, and pre-warmed AI endpoints to eliminate first-click transition jank.",
			"Harmonized the Change Rehearsal context toolbar and sticky offsets: replaced the opaque bar with a canvas-integrated frosted toolbar with unified 7px radii and 30px controls, auto-scrolled to top on focus entry, and removed duplicate 52px sticky insets inside detail containers.",
		},
	},
	{
		Version: "1.0.256-dev",
		Date:    "2026-11-15",
		Title:   "精简登录体验与升级现代 PaaS 操作审计、设备会话管理视图",
		TitleEn: "Streamlined Sign-In Experience, Modern PaaS Audit Trail & Device Session Management",
		Highlights: []string{
			"优化登录界面：移除冗余的会话时长选项，改为由平台默认 8 小时安全策略自动托管；采用无缝桌面分栏画布、自定义矢量拓扑插画与轻量化弹簧过渡动效，全面适配浅色与深色模式及减弱动画偏好。",
			"重塑「IAM → 操作审计」信息架构：去除密集卡片墙，改为连续数据条与左成员概览 + 右会话流水的主从分栏结构，支持「登录与在线」和「操作记录」之间的双向会话追踪与一键返回，完善骨架屏、空筛选复位、错误重试与离线提示。",
			"升级「我的账户 → 登录与安全」设备管理列表：采用通透的对象行列表展示所有已登录设备与活跃时长，支持单设备确认退出及一键退出全部其他设备。",
		},
		HighlightsEn: []string{
			"Streamlined login experience: removed redundant session TTL selectors in favor of platform-managed 8-hour defaults, introduced a seamless split desktop canvas with vector topology illustrations and light spring transitions supporting light/dark themes and reduced motion.",
			"Redesigned IAM Audit Trail architecture: replaced dense card walls with continuous data strips and a member-overview / session-stream master-detail layout supporting bidirectional tracing between active sessions and action logs, skeletons, filter reset, retries, and offline indicators.",
			"Upgraded Account -> Sign-in & Security device list: clean object rows showing signed-in devices and active durations with per-device revocation and one-click sign-out for all other sessions.",
		},
	},
	{
		Version: "1.0.255-dev",
		Date:    "2026-11-15",
		Title:   "全新登录页、标准 Bearer JWT 认证与完整会话时长审计",
		TitleEn: "Redesigned Login, Standard Bearer JWT Authentication & Session Duration Auditing",
		Highlights: []string{
			"重构平台登录页：升级深色交互式节点拓扑展示面板与卡片式令牌认证表单，修复暗色侧栏版本标签对比度问题，并支持登录时选择会话令牌有效期（8 小时 / 24 小时 / 7 天）。",
			"认证机制升级为标准 HS256 Bearer JWT 令牌 + 有状态可撤销会话库：支持 Authorization: Bearer 鉴权（严格优先级，拒绝无效令牌回退 Cookie）、重启密钥与会话保留，并继续兼容同源浏览器导出下载所需的 HttpOnly Cookie 与 CSRF 保护。",
			"新增全周期在线与登录时长审计（IAM → 操作与会话审计）：实时追踪在线用户、单会话总在线时长与活跃操作时长、历史会话归档、失败登录统计与 CSV 导出；支持管理员在审计面板按会话 ID 追溯操作轨迹并强制下线任意设备，同时在「我的账户 → 登录与安全」展示个人多端活跃令牌与一键注销。",
			"排查修复剩余跨页与技能/组件运维指南中的旧版「方案」遗留措辞（统一指向「交付」与「变更演练」），补全操作审计动作中文映射（修订、同步、自动执行、变更演练、沙箱、会话注销/过期等）及细粒度设置审计资源分类。",
		},
		HighlightsEn: []string{
			"Redesigned login page with interactive node topology showcase, card token sign-in, contrast fixes, and configurable session lifetimes.",
			"Upgraded auth to standard HS256 Bearer JWT tokens backed by a stateful revocable session store with strict Bearer priority, restart key/session persistence, and same-origin HttpOnly cookie + CSRF compatibility for browser downloads.",
			"Added full-lifecycle online & session duration auditing in IAM Audit with real-time presence, active duration tracking, archived history, failed sign-in stats, CSV export, per-session action drill-down, and remote device revocation.",
			"Aligned remaining cross-page copy with the Delivery & Change Rehearsal model and expanded audit action and resource labels.",
		},
	},
	{
		Version: "1.0.254-dev",
		Date:    "2026-11-15",
		Title:   "统一「首次部署 + 变更演练」平台模型文案并新增同步拦截直达入口",
		TitleEn: "Unified First-Deployment + Change Rehearsal Terminology & Direct Sync Gate Shortcuts",
		Highlights: []string{
			"更新交付详情页同步校验提示：已完成或软件包存在差异的交付不再提示「请生成方案」或「升级、补丁方案」，改为明确引导前往集群「变更演练」实施运行期调整。",
			"同步提示卡片新增「前往变更演练」快捷操作按钮：当已完成交付触发同步拦截且当前集群支持变更演练时，可直接从拦截横幅一键跳转至对应集群的变更演练标签页。",
			"全面清理前后端与 AI 助手/文档生成提示词中遗留的「方案」旧工作流表述（包括执行结果确认、集群配置档案、根因/评估文档模板、权限说明与软件库引导文案），统一与当前「交付 + 变更演练」流程保持一致（部署架构选择与变更演练 SOP 文案不受影响）。",
		},
		HighlightsEn: []string{
			"Updated delivery sync validation guidance so completed or diverged deliveries clearly direct engineers to Cluster Change Rehearsal for runtime changes.",
			"Added a direct 'Go to Change Rehearsal' shortcut on sync-blocked banners when the cluster supports Change Rehearsal.",
			"Standardized cross-stack copy, AI prompts, and document templates around the Delivery + Change Rehearsal workflow.",
		},
	},
	{
		Version: "1.0.253-dev",
		Date:    "2026-11-15",
		Title:   "软件库详情页与同步任务终端视图视觉重构",
		TitleEn: "Software Library Detail Redesign & Console Log Viewer for Sync Tasks",
		Highlights: []string{
			"重构软件库系统详情页：新增顶部能力概览指标卡（软件源索引、已入库闭包、Ansible 运行环境、离线交付状态，支持一键跳转分区），恢复并统一各功能卡片的圆角与立体层级，并为已索引软件源增加分源与发行代号概览芯片。",
			"重绘同步与下载任务面板（TaskCard）：升级为语义状态顶栏与统计标签（已更新 / 沿用本地 / 用时），明细区域支持按结果筛选与分组折叠，每条步骤拆解为套组/组件徽标、版本量与大小标签及分段迷你进度条，消除“7/9”与纯文本列表的晦涩观感。",
			"同步输出日志升级为深色控制台终端视图：提供带行号槽与语义着色（READ / GET / SKIP / DONE / ERROR 高亮路径与文件大小）、自动换行切换及一键复制纯净文本功能，大幅提升日志可读性。",
		},
		HighlightsEn: []string{
			"Redesigned OS detail pages in Software Library with top capability KPIs (Source Index, Stored Closures, Ansible Runtime, Offline Delivery Readiness), section jump links, and distro/codename source chips.",
			"Redesigned TaskCard sync panels with semantic status headers, result filter pills, collapsible groups, component/size metadata, and segmented mini progress bars.",
			"Upgraded sync task output logs into a dark console viewer with line-number gutters, semantic highlighting (READ/GET/SKIP/DONE/ERROR), wrap toggle, and clean copy.",
		},
	},
	{
		Version: "1.0.252-dev",
		Date:    "2026-11-15",
		Title:   "修复版本公告搜索框及复合输入容器的双层聚焦紫框问题",
		TitleEn: "Fixed Double Focus Rings in Release Notes Search & Composite Input Containers",
		Highlights: []string{
			"清除 .rn-search 内部输入框触发全局 :focus-visible 时叠加的多余紫色内框，并优化外框悬停与聚焦反馈为单一克制的微光边框。",
			"同步补齐 .wb-find-box 与 .tp2-code 复合输入容器内部 input/textarea 的 :focus/:focus-visible 阴影抑制，避免复合控件出现双层聚焦框。",
		},
		HighlightsEn: []string{
			"Suppressed inner :focus-visible rings inside .rn-search so hover and focus feedback renders cleanly on the outer border.",
			"Aligned inner focus suppression across .wb-find-box and .tp2-code composite inputs.",
		},
	},
	{
		Version: "1.0.251-dev",
		Date:    "2026-11-15",
		Title:   "全新 Middleware Hub 品牌标志视觉升级",
		TitleEn: "New Middleware Hub BrandMark & Favicon Identity",
		Highlights: []string{
			"重绘平台主 Logo（BrandMark）及浏览器标签页图标（Favicon）：采用立体双折翼几何「M」架构符号搭配青白流光核心节点与深靛高光微质感圆角底标，全面替换顶栏、登录页与版本弹窗中的旧版拓扑树图标。",
		},
		HighlightsEn: []string{
			"Introduced the sculpted double-wing geometric 'M' BrandMark and browser favicon with cyan-core diamond node across the topbar, login screen, and release notes modal.",
		},
	},
	{
		Version: "1.0.250-dev",
		Date:    "2026-11-15",
		Title:   "企业标准 Word 交付手册排版引擎、配色主题与可编辑模板支持",
		TitleEn: "Enterprise Word (.docx) Delivery Handbook Engine, Color Themes & Custom Templates",
		Highlights: []string{
			"重构平台内置 Word（.docx）排版引擎：拆分为独立的前置罗马页码分节（I, II, ... 含封面横幅与角标页码、点状引导线目录、★文档属性与★文档变更过程版本控制页）与正文连续阿拉伯页码分节（第 N 页居中页脚与标准页眉）。",
			"全面规范正文章节与元素版式：统一「第1章 / 1.1 / 1.1.1」层级编号并清理双重序号，升级全宽固定比例表格（自动重复表头与防断行）、灰色底纹代码块（区分可执行命令、斜体蓝灰注释与红色警示注释）、左侧强调线提示框及✓成功判据缩进样式。",
			"报告模板设置页新增 4 套企业配色主题（深青标准、经典藏蓝、科技靛紫、石墨深灰）、封面项目标语与版本号/作者/审核人字段、自定义封面横幅上传及一键下载预置占位符的可编辑标准模板（.docx）；同步升级自定义模板引擎（安全替换嵌套文本框、支持中文内置样式名映射与已有目录去重）并在导出弹窗支持按需开关前置公文页。",
		},
		HighlightsEn: []string{
			"Rebuilt the Word (.docx) typesetting engine with separate Roman-numeral front-matter sections (cover banner, dotted TOC, document properties, revision history) and continuous Arabic-numeral body sections.",
			"Standardized chapter hierarchy, fixed-width repeating-header tables, shaded code blocks distinguishing executable commands from notes/warnings, accent callouts, and acceptance criteria blocks.",
			"Added 4 corporate color themes, customizable cover metadata/banners, downloadable placeholder templates (.docx), and nested-textbox-safe custom template rendering.",
		},
	},
	{
		Version: "1.0.249-dev",
		Date:    "2026-11-15",
		Title:   "部署架构卡片排版修复与配置页重复展示清理",
		TitleEn: "Fixed Scheme Summary Card Layout & Deduplicated Config Architecture Cards",
		Highlights: []string{
			"修复部署架构摘要卡片（.scheme-summary）与通用提示样式冲突导致的左侧紫线压字、底色错位及网格宽度未铺满问题。",
			"集群「配置」页当查看方案与集群当前部署架构一致时自动省略重复架构卡片，仅在切换到不同架构的历史方案或草稿时展示差异卡片。",
		},
		HighlightsEn: []string{
			"Resolved CSS conflicts on .scheme-summary cards causing overlapping left borders, misaligned backgrounds, and clipped grid widths.",
			"Automatically hid redundant scheme summary cards in Cluster Config when viewing the active deployment architecture.",
		},
	},
	{
		Version: "1.0.248-dev",
		Date:    "2026-11-15",
		Title:   "版本公告时间轴、文档导读视觉统一与体验细节优化",
		TitleEn: "Release Timeline Modal, Unified Overview Callouts & UX Polish",
		Highlights: []string{
			"版本与更新公告弹窗升级为时间轴视图：左侧展示发布日期轨道与版本节点状态，支持历史版本折叠、一键全部展开及多版本筛选。",
			"统一 AI 技能与知识库详情页排版：「导读」卡片改为与正文章节一致的标题栏与卡片结构，消除仅有重复一级标题时的空白导读框，并对齐卡片上下边距、加粗高亮与目录跳转反馈。",
			"修复 AI 技能随附沙箱脚本面板折叠箭头点击无响应及长文档渲染卡顿问题，并优化顶部版本入口与状态标签布局。",
		},
		HighlightsEn: []string{
			"Upgraded Release Notes modal to an interactive timeline with date tracks, expand/collapse controls, and keyword filtering.",
			"Aligned AI Skill and Knowledge Base detail cards and overview callouts, eliminating empty overview placeholders.",
			"Fixed sandbox script collapse toggles and smooth scrolling on long skill documents.",
		},
	},
	{
		Version: "1.0.247-dev",
		Date:    "2026-11-15",
		Title:   "隔离 Shell 沙箱、分级授权、执行手册位置记忆与界面打磨",
		TitleEn: "Isolated Shell Sandbox, Tiered Approvals, Runbook Position Memory & UI Polish",
		Highlights: []string{
			"AI 代码沙箱新增跨平台隔离 Shell / CLI 执行能力（run_shell），支持在交付或组件排错时按需将脱敏工程只读挂载到 /workspace（$MW_WORKSPACE）。",
			"代码沙箱支持执行权限分级（ask 每次确认 / auto 智能风险分级 / open 隔离内免询问）与外网访问策略分级（deny / ask / allow），支持对话内实时授权，并兼容 Windows 无管理员权限解压运行环境。",
			"执行手册新增阶段位置记忆与智能续接：记录每个交付最后停留或正在进行的阶段，切换页面或重新进入后直接回到上次位置，不再退回第一步。",
			"同步更新 9 项内置 AI 技能（补充内置脚本 run_skill_script 引导、扫描版 PDF 识图、沙箱解析与只读工作区规范）。",
			"平台顶栏、用户菜单及登录页新增当前版本号展示与更新公告弹窗。",
		},
		HighlightsEn: []string{
			"Added cross-platform isolated Shell/CLI execution (run_shell) with optional read-only sanitized /workspace mounts.",
			"Added tiered execution approval modes (ask/auto/open) and egress policies (deny/ask/allow) with in-chat interactive authorization.",
			"Added per-delivery stage position memory in the Execution Runbook for seamless resumption.",
			"Updated 9 built-in AI skills and introduced topbar/login version badges and the release notes viewer.",
		},
	},
	{
		Version: "1.0.244-dev",
		Date:    "2026-11-11",
		Title:   "自动执行节点、目标 Agent 接入与执行证据链",
		TitleEn: "Execution Nodes, Ephemeral Target Agents & Execution Evidence Trail",
		Highlights: []string{
			"支持接入独立管理机或集群内执行机；独立管理机采用按集群隔离的目录与软件源端口，不占用业务节点数或数据盘。",
			"支持已有 root SSH 及通过堡垒机逐机安装短期目标 Agent，私钥仅保留在执行机，Agent 仅写入所需专用公钥并支持撤销回执。",
			"新增执行前准备检查、固定快照运行、断线本地保存后补传以及交付报告逐次尝试与机器结果证据。",
		},
		HighlightsEn: []string{
			"Added dedicated controller and in-cluster execution nodes with per-cluster isolated storage and package repo ports.",
			"Added ephemeral target agent onboarding via SSH or bastion hosts, keeping private keys on execution nodes with revocable access.",
			"Added pre-execution readiness checks, snapshot runs, offline reconnect buffering, and per-host attempt evidence in reports.",
		},
	},
	{
		Version: "1.0.213-dev",
		Date:    "2026-11-03",
		Title:   "步骤归属标准化、草稿兼容性与变更预览同步",
		TitleEn: "Standardized Step Ownership, Draft Compatibility & Impact Preview Sync",
		Highlights: []string{
			"细化组件私有动作与公共运行库归属校验，工作台支持跨文件联动检查与现有草稿兼容迁移。",
			"支持预览组件变更影响范围后再同步至当前交付并生成更新包，既有交付与未同步现场不受影响。",
		},
		HighlightsEn: []string{
			"Refined component-private action vs. platform-shared runtime validation with cross-file checks in Workbench.",
			"Added component change impact previews before syncing changes into existing deliveries and generating update bundles.",
		},
	},
}

func usage() {
	fmt.Fprint(os.Stderr, `Middleware Hub — 中间件交付平台

  middleware-hub store serve --config 配置.json          启动共享服务
  middleware-hub store supervise --config 配置.json      以零中断热重启网关模式启动服务（Windows / Linux 通用）
  middleware-hub store reload --config 配置.json [--binary 新程序]
                                                         零中断热切换到新版程序（活跃任务完成后无缝切换，失败自动回滚）
  middleware-hub execution-node --config 节点配置.json   启动控制节点执行器，领取已授权步骤
  middleware-hub store user-add --data 目录 --username 名 --role admin|operator --password-stdin
  middleware-hub catalog check [--components 目录]       校验组件清单（含内置组件）
  middleware-hub render --spec 规格.yml --out 目录 --library 软件库目录 --runtime Ansible运行环境.tar.gz [--components 目录] [--cert-dir 目录]
                                                         不启动服务，直接按规格生成完整交付
  middleware-hub library list|sources|index-update|index-export|index-import|search|versions|fetch|fetch-all|verify|export|import --library 软件库目录 [--platform 系统]
                                                         准备软件库（需要 Docker 和网络）、在机器之间搬运
  middleware-hub version
`)
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		if len(os.Args) > 1 && (os.Args[1] == "execution-node" || os.Args[1] == "target-agent") {
			logAgent("ERROR", "%v", err)
		} else {
			fmt.Fprintln(os.Stderr, "停止：", err)
		}
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		usage()
		return nil
	}
	switch args[0] {
	case "target-agent":
		return targetAgentCommand(args[1:])
	case "execution-node":
		return executionNodeCommand(args[1:])
	case "store":
		return storeCommand(args[1:])
	case "catalog":
		return catalogCommand(args[1:])
	case "render":
		return renderCommand(args[1:])
	case "library":
		return libraryCommand(args[1:])
	case "sandbox-child":
		return sandboxCommand(args[1:])
	case "version":
		if len(args) > 1 {
			switch args[1] {
			case "--json":
				enc := json.NewEncoder(os.Stdout)
				return enc.Encode(map[string]string{
					"version":     version,
					"build_id":    currentBuildID(),
					"released_at": currentReleaseDate,
				})
			case "--build-id":
				fmt.Println(currentBuildID())
				return nil
			}
		}
		fmt.Println(version)
		return nil
	}
	usage()
	return fmt.Errorf("未知命令 %q", args[0])
}

func catalogCommand(args []string) error {
	f := flag.NewFlagSet("catalog", flag.ContinueOnError)
	dir := f.String("components", "", "额外或覆盖的组件目录")
	if len(args) == 0 || args[0] != "check" {
		return fmt.Errorf("用法：catalog check [--components 目录]")
	}
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	plat, err := loadPlatform(platformConfig{ComponentsDir: *dir})
	if err != nil {
		return err
	}
	for _, e := range plat.cat().Infos() {
		var vs []string
		for _, v := range e.Versions {
			vs = append(vs, v.ID+"（"+statusText(v.Status)+"）")
		}
		fmt.Printf("%-14s %-24s %s\n", e.Name, e.Title, strings.Join(vs, "、"))
	}
	fmt.Println("组件清单校验通过。")
	return nil
}

func statusText(s string) string {
	switch s {
	case "published":
		return "已发布"
	case "verifying":
		return "待验证"
	}
	return "草稿"
}

// renderCommand turns a deployment spec into a delivery without the web service: for implementers who prepare
// specs offline, and for checking a spec before it is submitted.
func renderCommand(args []string) error {
	f := flag.NewFlagSet("render", flag.ContinueOnError)
	spec := f.String("spec", "", "部署规格 YAML/JSON")
	out := f.String("out", "", "交付输出目录（须不存在）")
	library := f.String("library", "", "软件库目录")
	artifacts := f.String("artifacts", "", "其他离线文件目录（可选）")
	runtime := f.String("runtime", "", "离线 Ansible 运行环境 tar.gz（旁边须有 .sha256），用于 Ubuntu 24.04")
	components := f.String("components", "", "额外或覆盖的组件目录")
	certs := f.String("cert-dir", "", "TLS 材料目录：<实例>/<输入名>/{server.crt,server.key,ca.crt}")
	if err := f.Parse(args); err != nil {
		return err
	}
	if *spec == "" || *out == "" {
		return fmt.Errorf("render 需要 --spec、--out；部署材料还需要 --library、--runtime")
	}
	plat, err := loadPlatform(platformConfig{ComponentsDir: *components, ArtifactsDir: *artifacts, LibraryDir: *library, Runtimes: map[string]string{mwpack.DefaultPlatform: *runtime}})
	if err != nil {
		return err
	}
	data, err := os.ReadFile(*spec)
	if err != nil {
		return err
	}
	dep, err := mwpack.ParseDeployment(data)
	if err != nil {
		return err
	}
	if dep.DeliveryMode != "configuration" && (*library == "" || *runtime == "") {
		return fmt.Errorf("生成部署材料需要 --library、--runtime")
	}
	plan := mwpack.Solve(plat.cat(), dep)
	if err := mwpack.ValidateDeliveryMode(plan); err != nil {
		return err
	}
	if len(plan.Errors()) == 0 && dep.DeliveryMode != "configuration" {
		plan.Issues = append(plan.Issues, plat.readiness(plan)...)
	}
	for _, i := range plan.Issues {
		fmt.Fprintf(os.Stderr, "%s %s %s\n", map[string]string{"error": "错误", "warning": "提示"}[i.Severity], i.Path, i.Message)
	}
	if err := plan.Err(); err != nil {
		return fmt.Errorf("规格有错误，未生成")
	}
	if dep.DeliveryMode == "configuration" {
		if _, e := os.Lstat(*out); !os.IsNotExist(e) {
			return fmt.Errorf("交付输出目录须不存在")
		}
		return generateConfiguration(plan, *out)
	}
	materials := map[string][]byte{}
	if *certs != "" {
		for _, in := range plan.Inputs {
			for _, name := range []string{"server.crt", "server.key", "ca.crt"} {
				b, err := os.ReadFile(filepath.Join(*certs, in.Instance, in.Name, name))
				if err != nil {
					return fmt.Errorf("缺少 %s：%v", in.Label, err)
				}
				materials[in.Instance+"/"+in.Name+"/"+name] = b
			}
		}
	}
	opt := mwpack.RenderOptions{Artifacts: plat.artifactsFor(plan), Materials: materials}
	var repo *pkglib.RepoArchive
	if plan.NeedsPackages() {
		if repo, err = plat.lib.Assemble(plan.Platform, plan.Requests()); err != nil {
			return err
		}
		opt.PackageRepo = &mwpack.PackageRepo{File: repo.File, SHA256: repo.SHA256, Size: repo.Size}
	}
	bundle, err := mwpack.Render(plan, opt)
	if err != nil {
		return err
	}
	return packageDelivery(bundle, plat, repo, *out, func(m string) { fmt.Println(m) })
}

type listFlag []string

func (l *listFlag) String() string     { return strings.Join(*l, ",") }
func (l *listFlag) Set(v string) error { *l = append(*l, v); return nil }

func parseRequests(list []string) ([]mwpack.PackageRequest, error) {
	var out []mwpack.PackageRequest
	for _, v := range list {
		name, ver, ok := strings.Cut(v, "=")
		if !ok || name == "" || ver == "" {
			return nil, fmt.Errorf("软件包 %q 须写成 名称=版本", v)
		}
		out = append(out, mwpack.PackageRequest{Name: name, Version: ver})
	}
	return out, nil
}

// libraryCommand prepares and moves the package library: the one place that needs containers and a network.
func libraryCommand(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("用法：library list|sources|index-update|index-export|index-import|search|versions|fetch|fetch-all|verify|export|import")
	}
	f := flag.NewFlagSet("library "+args[0], flag.ContinueOnError)
	dir := f.String("library", "", "软件库目录")
	srcFile := f.String("sources", "", "管理员的软件源文件（可选）")
	platformID := f.String("platform", mwpack.DefaultPlatform, "操作系统 id")
	pkg := f.String("package", "", "软件包名（versions 用）")
	components := f.String("components", "", "额外或覆盖的组件目录")
	out := f.String("out", "", "导出文件")
	var pkgs listFlag
	f.Var(&pkgs, "pkg", "名称=版本，可重复")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if *dir == "" {
		return fmt.Errorf("需要 --library")
	}
	plat, err := loadPlatform(platformConfig{ComponentsDir: *components, LibraryDir: *dir, SourcesFile: *srcFile})
	if err != nil {
		return err
	}
	def, ok := mwpack.PlatformByID(*platformID)
	if !ok && args[0] != "import" && args[0] != "sources" && args[0] != "list" {
		return fmt.Errorf("未知的操作系统 %q", *platformID)
	}
	plat.fetcher.Log = func(m string) { fmt.Println(m) }
	ctx := context.Background()
	switch args[0] {
	case "list":
		for _, p := range mwpack.Platforms {
			st := plat.lib.Stats(p.ID)
			fmt.Printf("%s：%d 个软件包版本，%d 个文件，%.1f MB\n", p.ID, st.Closures, st.Files, float64(st.Bytes)/1048576)
			for _, c := range plat.lib.List(p.ID) {
				fmt.Printf("  %-34s %-34s %2d 个文件  %s\n", c.Request.Name, c.Request.Version, len(c.Files), c.Via)
			}
		}
	case "sources":
		for _, s := range plat.sources.Load().List {
			fmt.Printf("%-22s %-5s %s %s\n", s.ID, s.Kind, strings.Join(s.Platforms, ","), firstNonEmpty(s.URL, s.BaseURL))
		}
	case "index-export":
		if *out == "" {
			return fmt.Errorf("index-export 需要 --out")
		}
		w, err := os.OpenFile(*out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		defer w.Close()
		return plat.idx.Export(w, def.ID)
	case "index-import":
		if f.NArg() != 1 {
			return fmt.Errorf("index-import 需要一个索引包文件")
		}
		r, err := os.Open(f.Arg(0))
		if err != nil {
			return err
		}
		defer r.Close()
		st, err := plat.idx.Import(r, def, plat.sources.Load())
		if err != nil {
			return err
		}
		fmt.Printf("索引已导入：%d 个软件包版本\n", st.Packages)
	case "index-update":
		return plat.idx.Update(ctx, def, plat.sources.Load(), pkglib.LogReporter(plat.fetcher.Log))
	case "search":
		if f.NArg() != 1 {
			return fmt.Errorf("search 需要一个关键词")
		}
		hits, err := plat.idx.Search(def, f.Arg(0), 30)
		if err != nil {
			return err
		}
		for _, h := range hits {
			fmt.Printf("%-40s %-32s %2d 个版本  %s\n", h.Name, h.Latest, h.Versions, h.Desc)
		}
	case "versions":
		if plat.idx.Ready(def.ID) {
			list, err := plat.idx.Versions(def, *pkg)
			if err != nil {
				return err
			}
			for _, p := range list {
				fmt.Println(p.Version)
			}
			return nil
		}
		return fmt.Errorf("还没有 %s 的软件源索引：先运行 library index-update，或用 library index-import 导入", def.ID)
	case "fetch", "fetch-all":
		var reqs []mwpack.PackageRequest
		if args[0] == "fetch-all" {
			reqs = plat.cat().AllPackages(def.ID)
		} else if reqs, err = parseRequests(pkgs); err != nil {
			return err
		}
		var todo []mwpack.PackageRequest
		for _, r := range reqs {
			if !plat.lib.Has(def.ID, r) {
				todo = append(todo, r)
			}
		}
		fmt.Printf("需要 %d 个，库里已有 %d 个，要获取 %d 个\n", len(reqs), len(reqs)-len(todo), len(todo))
		if len(todo) == 0 {
			return nil
		}
		if !plat.idx.Ready(def.ID) {
			return fmt.Errorf("还没有 %s 的软件源索引：先运行 library index-update，或用 library index-import 导入", def.ID)
		}
		return plat.idx.FetchDirect(ctx, plat.lib, def, plat.sources.Load(), todo, pkglib.LogReporter(plat.fetcher.Log))
	case "verify":
		reqs, err := parseRequests(pkgs)
		if err != nil {
			return err
		}
		repo, err := plat.lib.Assemble(def, reqs)
		if err != nil {
			return err
		}
		return plat.fetcher.VerifyInstall(ctx, def, repo.Path, reqs)
	case "export":
		reqs, err := parseRequests(pkgs)
		if err != nil || *out == "" {
			return fmt.Errorf("export 需要 --pkg 和 --out")
		}
		w, err := os.OpenFile(*out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		defer w.Close()
		return plat.lib.Export(w, def.ID, reqs)
	case "import":
		if f.NArg() != 1 {
			return fmt.Errorf("import 需要一个软件库包文件")
		}
		r, err := os.Open(f.Arg(0))
		if err != nil {
			return err
		}
		defer r.Close()
		res, err := plat.lib.Import(r)
		if err != nil {
			return err
		}
		fmt.Printf("已导入 %d 个软件包版本，新增 %d 个文件\n", res.Closures, res.Files)
	default:
		return fmt.Errorf("未知的子命令 %q", args[0])
	}
	return nil
}

func firstNonEmpty(a ...string) string {
	for _, x := range a {
		if x != "" {
			return x
		}
	}
	return ""
}

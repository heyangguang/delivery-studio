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
	version            = "1.0.319-dev"
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
		Version: "1.0.319-dev",
		Date:    "2026-11-24",
		Title:   "架构方案语义拓扑图示与蓝图卡片全面重构",
		TitleEn: "Semantic PlanGlyph Topology Diagrams & Blueprint Card Redesign",
		Highlights: []string{
			"全新设计语义化架构方案拓扑微缩图（PlanGlyph）：修复 etcd、HAProxy、Nginx、keepalived 等非 primary/replica 角色多节点方案全部误退化为单节点图标的问题，按架构模式精确区分单机、VIP 双机热备、3 成员 Raft 三角共识、5 成员 Raft 五边形共识、原生主从流复制、Sentinel 哨兵仲裁与 Patroni+etcd 高可用拓扑。",
			"重构应用目录「从架构方案起步」、应用详情页「方案」卡片与新建交付向导 Step 1 方案选卡：统一引入点阵蓝图视窗、按语义分色的徽标体系（推荐暖红 / 高可用与自动切换青绿 / 人工切换琥珀 / 单节点中性灰），桌面端 3 方案卡片单行等高对齐，消除旧版第二行孤卡与说明文字截断。",
			"同步优化应用详情页顶部 Hero 架构预览，优先展示推荐/自动切换高可用方案（如 PostgreSQL Patroni 主从方案），并全面适配浅色与暗黑模式对比度。",
		},
		HighlightsEn: []string{
			"Redesigned PlanGlyph semantic topology diagrams: fixed multi-node plans using non-primary/replica roles (etcd, HAProxy, Nginx, keepalived) falling back to a single-node glyph, introducing distinct precision illustrations for standalone, VIP active-standby, 3-node Raft triangle, 5-node Raft pentagon, native primary-replica streaming, Redis Sentinel, and Patroni DCS HA.",
			"Upgraded blueprint plan cards consistently across the App Catalog, App Detail Plans tab, and Delivery Wizard Step 1 with blueprint dot-grid stages, semantic color-coded pills, and balanced 3-column single-row alignment on desktop without orphan cards or truncated specs.",
			"Updated App Detail hero TopoArt to prioritize recommended/automatic-failover plans (such as PostgreSQL Patroni HA) with crisp Light & Dark Mode rendering.",
		},
	},
	{
		Version: "1.0.318-dev",
		Date:    "2026-11-24",
		Title:   "变更演练生产落地闭环卡操作区与版式重构",
		TitleEn: "Rehearsal Production Closure Card Toolbar & Editorial Layout Redesign",
		Highlights: []string{
			"重构变更演练「生产已实施落地并同步至集群」闭环卡片布局：由原先四枚按钮扁平横排并挤压左侧摘要改为顶部标题栏右对齐操作组 + 下方全宽摘要两段式版式，左侧多行落地摘要不再被压缩至半栏。",
			"建立清晰的操作信息层级：高频推广操作保留在主操作栏（Kyndryl 暖红主按钮「推广到其他集群」+ 次按钮「推广看板」），低频记录维护（「编辑落地记录」）与危险操作（「撤销落地」，带二次确认弹窗）收纳进右侧「⋯」下拉菜单。",
			"统一浅色与暗黑模式视觉质感：暗黑模式下采用柔和半透明成功徽标与高可读摘要排版，确保「⋯」菜单展开无遮挡、无提示气泡冲突。",
		},
		HighlightsEn: []string{
			"Redesigned the Rehearsal Production Closure card from a cramped 4-button horizontal row into a clean two-zone editorial layout: top header bar (status title + synced pills + right-aligned action toolbar) above a full-width summary paragraph.",
			"Clarified action hierarchy: high-frequency rollout actions stay visible (Kyndryl Warm Red primary Propagate + secondary Rollout Board), while lower-frequency record maintenance (Edit Record) and destructive actions (Revert Sign-Off with confirmation modal) move cleanly into a compact overflow menu.",
			"Polished Light and Dark Mode contrast with restful translucent status badges, crisp active trigger states, and unobstructed dropdown alignment.",
		},
	},
	{
		Version: "1.0.317-dev",
		Date:    "2026-11-24",
		Title:   "修复拓扑流动卡顿、AI 联网默认关闭/去重标头，强化 Kyndryl 暖红主色与暗黑模式视觉舒适度",
		TitleEn: "Smooth Topology Flows, AI Web Opt-In & Sidebar Polish, Kyndryl Warm Red Identity & Dark Mode Overhaul",
		Highlights: []string{
			"彻底消除拓扑连线流动突然加速与卡帧：修正 etcd Raft 虚线周期（3 6 改为整除 24 的 2 6）及工作台连线周期，移除动画粒子高开销 drop-shadow 改为纯矢量柔光晕，并按连线物理长度等速计算粒子时长",
			"AI 助手默认关闭「联网」且不再因单次预设提示持久写死开启；移除 AI 页侧栏与顶栏上下叠放的重复 K Logo 改为简洁星标，优化侧栏会话列表滚动条、分组分割线与交付标签",
			"回归清晰的 Kyndryl 暖红品牌识别：重绘应用目录「单机/原生主从/Patroni」迷你拓扑为暖红主节点 + Bridge Teal 备节点，主操作按钮、勾选/单选与深度思考标签采用协调的 Kyndryl 暖红视觉体系",
			"全面重构暗黑模式色彩与集群安全态势页：抬升纯黑背景为柔和炭黑层级、消除刺眼纯白主按钮与发闷深红/荧光蓝绿硬编码色值，并修复集群安全页右侧工具栏裁切",
		},
		HighlightsEn: []string{
			"Eliminated topology flow stutter & speed bursts by aligning mesh/wire dasharray periods to divide the 24-unit cycle evenly, replacing CPU-heavy drop-shadow filters with pure-vector particle halos, and normalizing particle travel speed to wire length",
			"Made AI Web Search strictly opt-in (OFF by default per session without sticky localStorage mutation), removed the duplicate stacked K logo in the AI sidebar header, and polished sidebar scrollbars, date-group dividers, and context badges",
			"Restored unmistakable Kyndryl Warm Red brand identity across primary CTAs, checkboxes/radios, active think pills, and color-coded PlanGlyph scheme thumbnails (Warm Red primary + Bridge Teal replicas)",
			"Overhauled Dark Mode with restful elevated charcoal layers, calibrated soft-luminous semantic inks across Cluster Security, Security Center & VEX triage (removing hardcoded light-mode hex values), and fixed right-edge clipping in Cluster Security",
		},
	},
	{
		Version: "1.0.316-dev",
		Date:    "2026-11-24",
		Title:   "消除全站下拉菜单展开抖动并精校执行节点三步卡片水平对齐",
		TitleEn: "Eliminate Dropdown Open Jitter & Align Execution-Node Step Strip",
		Highlights: []string{
			"根治外观/语言/用户/选择框等全站下拉与浮层点开时的发抖问题：移除触发按钮按压缩放导致的坐标漂移，并用纯平滑位移淡入替换 Arco 默认的 scaleY 挤压与 1.3 回弹过冲动效",
			"同步统一顶部菜单选中态对勾与图标为 Bridge Teal 配色，并保留菜单展开时的触发按钮高亮反馈",
			"精校「设置 → 执行节点」三步流程条的水平基准线：将 1/2/3 序号徽章与标题中心 0px 对齐、精简第三步文案避免尾部单字换行导致卡片不等高，并使连接箭头精准居中且在窄屏下提前平滑堆叠",
		},
		HighlightsEn: []string{
			"Eliminated dropdown/popover open jitter platform-wide by removing trigger button active scale() rect drift and replacing Arco's scaleY(0.9) squash and 1.3 overshoot bounce with clean damped translate+fade transitions",
			"Aligned active menu checkmarks to Bridge Teal and added crisp open-state highlights for topbar dropdown triggers",
			"Aligned the Execution Nodes 3-step strip horizontally to 0.00px delta across step badges, titles, equal-height single-line cards, and centered connector arrows, with cleaner responsive stacking",
		},
	},
	{
		Version: "1.0.315-dev",
		Date:    "2026-11-24",
		Title:   "统一重构 32 个中间件官方矢量品牌 Logo",
		TitleEn: "Unified Official Vector Brand Logos for All 32 Middleware",
		Highlights: []string{
			"将全部 32 个中间件组件图标重构为正版官方矢量 Logo（PostgreSQL Slonik、Redis、Nginx、HAProxy、etcd、MySQL、MariaDB、MongoDB、Kafka、RabbitMQ、Elasticsearch、ZooKeeper、MinIO、Prometheus、Grafana、Kubernetes、Docker、ClickHouse、Nacos、Consul、RocketMQ、Envoy、Traefik、Valkey、TiDB、OpenSearch、Memcached、Harbor、Zabbix 等），彻底替换旧版手绘简笔图标",
			"建立统一的 40×40 视觉网格与光学尺寸归一化体系，去除杂乱外框与微小文字，同时为 Patroni、Keepalived、外部负载均衡 (ELB) 配套同等几何精度的现代扁平徽章，全站风格高度统一",
			"内置亮/暗色自适应配色与独立作用域 SVG defs ID，确保深色模式瓷砖下 Kafka/MySQL/MariaDB/PostgreSQL/OpenSearch 等深色笔触清晰通透且多实例列表零渲染冲突",
		},
		HighlightsEn: []string{
			"Replaced all 32 hand-drawn middleware icons with authentic official vector brand marks (PostgreSQL Slonik, Redis, Nginx, HAProxy, etcd, MySQL, MariaDB, MongoDB, Kafka, RabbitMQ, Elasticsearch, ZooKeeper, MinIO, Prometheus, Grafana, Kubernetes, Docker, ClickHouse, Nacos, Consul, RocketMQ, Envoy, Traefik, Valkey, TiDB, OpenSearch, Memcached, Harbor, Zabbix, etc.)",
			"Normalized every icon to a unified 40×40 Swiss squircle optical grid with clean floating symbol marks (no wordmarks or clashing inner boxes) and matched precision emblems for Patroni, Keepalived, and External ELB",
			"Added automatic Dark Mode ink/contrast adaptation and per-instance useId()-scoped SVG defs to prevent gradient/clipPath ID collisions across repeated rows",
		},
	},
	{
		Version: "1.0.314-dev",
		Date:    "2026-11-24",
		Title:   "全站半屏/窄窗响应式全面升级：Priority+ 顶栏智能收纳与多页防溢出重构",
		TitleEn: "Comprehensive Split-Screen Responsive Upgrade: Priority+ Topbar & Zero-Overflow Views",
		Highlights: []string{
			"顶栏主导航升级为 Priority+ 容器自适应排版（NavTabs）：窄窗下只显示完整导航项，溢出项自动收纳进「更多 ▾」下拉菜单，且选中溢出项时直接在按钮上高亮并跟随红线指示，彻底告别字被腰斩与入口消失",
			"窄屏下自动将语言胶囊精简为地球图标、右下角悬浮 AI 入口自动微缩为 40×40 正圆（悬停可展开），并为列表/详情/安全/IAM 等页面补足底部滚动留白，避免遮挡末行操作",
			"修复新建交付 AI 页头「创建交付」被错排到返回箭头左侧并竖折的问题，以及手动向导机器卡片窄屏下开关无标签与删除键孤立占行的问题",
			"重构交付详情页头（更多按钮回位标题行）、访问入口长域名自动换行、集群安全风险表窄屏卡片化（修复演练/筛选漏洞/集群安全页全部可见）及 AI 用量 KPI 三列均衡网格",
		},
		HighlightsEn: []string{
			"Upgraded main topbar navigation to Priority+ overflow (NavTabs): only complete tabs render inline while overflow folds cleanly into a More dropdown showing active selection and sliding indicator—zero sliced labels at any width",
			"Collapsed language pill to a globe icon below 820px, auto-minimized the floating AI launcher to a 40×40 orb below 900px, and added bottom scroll clearance across list, detail, security, and IAM views",
			"Fixed the New Delivery AI header grid order where the title wrapped vertically left of the back arrow, and refined manual Step 2 host rows with an inline Init label and top-right delete alignment",
			"Aligned Delivery detail header actions inline on row 1, enabled clean wrapping for long access endpoint FQDNs, transformed the Security cluster risk table into full-width zero-overflow cards below 960px, and balanced AI Cost KPI grids",
		},
	},
	{
		Version: "1.0.313-dev",
		Date:    "2026-11-24",
		Title:   "修复新建向导窄屏步骤选中框上下裁切并统一 Bridge Teal 选中态",
		TitleEn: "Fix Wizard Narrow Step Pill Border Clipping & Bridge Teal Active State",
		Highlights: []string{
			"修复新建交付向导窄屏横向步骤栏（.wz-nav）因 overflow-x: auto 叠加零上下留白导致外框 box-shadow 上下边被裁成括号状（( )）的问题",
			"改用实体边框 border 与封闭胶囊样式（34px 圆角胶囊 + Bridge Teal 轻盈边线与柔和底色），并居中对齐状态徽标，明暗双主题与桌面侧栏视觉统一",
			"同步将向导 AI 工作区步骤标签（.fw-tab.on）及执行位置选择卡片（集群内机器 / 独立管理机）升级为统一的 Bridge Teal 选中态",
		},
		HighlightsEn: []string{
			"Fixed top/bottom clipping on the active step pill in the narrow horizontal wizard stepper (.wz-nav) where outer 1px box-shadow was sliced into parentheses by overflow-x: auto",
			"Upgraded narrow and desktop wizard step tabs to closed real-border capsules with Bridge Teal active borders, soft tint, and centered status marks across Light & Dark modes",
			"Aligned AI workspace step tabs (.fw-tab.on) and execution host selector cards (.ex-location-options) to the unified Bridge Teal selection styling",
		},
	},
	{
		Version: "1.0.312-dev",
		Date:    "2026-11-24",
		Title:   "全站 AI 输入栏单行排版、窄栏防裁切与浮标零遮挡打磨",
		TitleEn: "Platform-Wide Single-Row AI Composers, Unclipped Filter Strips & Clear FAB",
		Highlights: []string{
			"修复 AI 助手抽屉输入框底部工具栏折成错落两行的问题，新增紧凑型思考深度胶囊（compact）与弹性模型选择器，窄窗下所有控件齐平单行且完整显示模型名称",
			"全站巡检并统一加固 AI 主页、新建交付向导与变更演练（新建/边界对齐/只读探针/步骤核验）输入栏的容器宽度感知与单行弹性布局，窄屏与 1280px 笔记本均不再折行或溢出",
			"优化变更演练页右下角 AI 悬浮入口为 40×40 正圆微缩态并增加工作台底部留白，彻底消除对「智能研判并发起」主按钮的遮挡",
			"修复执行监控左侧栏组件筛选条横向裁切 etcd 等筛选胶囊的问题，同时修正工具菜单红点与思考标签配色细节",
		},
		HighlightsEn: []string{
			"Fixed staggered two-row wrapping in the AI Assistant Drawer composer with a new compact ThinkLevel pill and responsive ModelPicker so all controls align cleanly on one row without truncating model names",
			"Unified container-aware single-row flexbox layout across AI Page, New Delivery Wizard, and all four Change Rehearsal composer footers for clean rendering down to 1060px–1280px viewports",
			"Refined the collapsed AI launcher FAB into a symmetric 40×40 orb on Change Rehearsal tabs with extra bottom clearance so primary CTAs are never overlapped",
			"Replaced clipped horizontal scrolling in Execution Monitor's left component filter strip with clean wrapping so all middleware chips stay visible, and polished tool-menu indicator accents",
		},
	},
	{
		Version: "1.0.311-dev",
		Date:    "2026-11-24",
		Title:   "执行监控丝滑零闪烁切换与弹簧滑块",
		TitleEn: "Execution Monitor Zero-Flash Cluster Switching & Spring Rail Indicator",
		Highlights: []string{
			"彻底消除「执行监控」切换集群时的白屏加载闪烁：移除 MonitorWorkspace 的强制卸载重建（key={activeJobId}）与 setData(null) 空白态，接入与「交付」一致的内存缓存与悬停/聚焦/首屏预取机制，点击切换 0ms 瞬时响应",
			"左侧集群列表接入与「交付」完全一致的弹簧滑块（.row-indicator，含 2.5px Kyndryl 暖红边条）与上下方向键快捷切换，选中卡片在列表行间丝滑滑移",
			"重构右侧监控区过渡动画：顶栏、步骤栏与深色终端外框常驻不动避免黑白闪屏，仅内部内容轻柔上浮淡入（mon-soft-in）；未命中缓存的冷切换仅在顶边显示 2px 架构青微光进度条并保持当前画面完整",
			"同步将左侧组件快捷筛选选中态（mon-app-chip.on）与顶边进度条升级为 Kyndryl 架构青，明暗双主题均通过实测验证",
		},
		HighlightsEn: []string{
			"Eliminated full-pane white spinner flashes when switching clusters in Execution Monitor by keeping MonitorWorkspace persistently mounted, caching execution telemetry with hover/focus/initial prefetch, and swapping state atomically",
			"Added the same spring-gliding left-rail selection indicator (.row-indicator with 2.5px Kyndryl Warm Red edge bar) and ArrowUp/ArrowDown keyboard navigation as Deliveries",
			"Kept the header, pipeline, and obsidian terminal chassis mounted while smoothly transitioning inner content (mon-soft-in) and displaying a subtle 2px Bridge Teal top shimmer on cold switches",
			"Aligned the active component filter chip and top progress bar with the Kyndryl Bridge Teal palette across Light and Dark modes",
		},
	},
	{
		Version: "1.0.310-dev",
		Date:    "2026-11-24",
		Title:   "Kyndryl 品牌双主调与克制语义配色升级",
		TitleEn: "Kyndryl Bridge Duotone & Semantic Accent Palette Polish",
		Highlights: []string{
			"在保留瑞士徕卡白瓷/曜石克制底色的基础上，引入源自 kyndryl bridge 品牌基因的「架构青（--teal）」与「钴蓝（--cobalt）」语义令牌，与 Kyndryl 暖红（--kyndryl）形成高辨识度品牌双主调，彻底告别单调黑灰",
			"全面升级拓扑图（InstanceGraph）连线、角色与图例配色：异步 WAL/流复制线与流动光点采用架构青、同步复制采用翡翠绿、入口/负载均衡转发采用钴蓝、Raft/etcd 共识采用琥珀橙；主库与控制节点采用暖红点缀、从库采用架构青，一眼分清拓扑层次",
			"重构「用量与成本」可视化与设置导航配色：移除纯黑柱状图与侧栏纯黑图标块，改用架构青按天费用柱、四组和谐分色排行条（青/钴/暖红/翠）、带微色标与失败率/缓存命中高亮的 KPI 栏、以及暖红轻质激活图标与二级页签",
			"将新建交付选中卡片（交付方式/架构方案）、右侧预览产物标签（控制/业务/软件）、下拉选中态与文字链接升级为架构青/暖红克制点缀，明暗双主题均通过实测验证",
		},
		HighlightsEn: []string{
			"Introduced Kyndryl Bridge Architectural Teal (--teal) and Cobalt (--cobalt) semantic tokens alongside Kyndryl Warm Red (--kyndryl) on the Porcelain/Obsidian chassis to replace overly monochrome black-and-grey accents",
			"Restored clear semantic color coding across Topology diagrams and legends: Bridge Teal for async WAL/replication flows, Emerald for quorum sync, Cobalt for LB/ingress traffic, Amber for Raft/etcd mesh, Warm Red for Primary & Control badges, and Bridge Teal for Replicas",
			"Upgraded AI Usage & Cost charts, KPI strip, and Settings navigation: replaced stark black bars and solid black active nav squares with Bridge Teal cost bars, a 4-tone ranking palette, highlighted failure-rate & cache-hit KPIs, and refined Warm Red active nav/tab icons",
			"Polished selected Wizard delivery-mode & scheme cards, preview artifact role chips (Control/Node/Package), dropdown selections, and inline links across both Light and Dark themes",
		},
	},
	{
		Version: "1.0.309-dev",
		Date:    "2026-11-24",
		Title:   "新建交付 AI 生产基线巡检与交互提醒卡片",
		TitleEn: "AI Delivery Form Production Baseline Inspection & Interactive Reminder Card",
		Highlights: []string{
			"新增基于真实组件 Schema 与主机契约的生产基线巡检引擎（ai_form_baseline.go），在 AI 每次填表后自动检查存储磁盘一致性、日志与锁等待/慢查询、安全加密（TLS/TDE/网段/空闲事务超时/业务账户）、备份与持久化（pgBackRest/Redis AOF）、统一访问入口及内核基线，并支持合并 AI 结合对话上下文识别的额外基线建议",
			"新增瑞士徕卡风格交互式「生产基线检查」卡片（BaselineCard），按需补齐/建议关注/可选加固分级呈现当前值与推荐基线对比，支持定位表单步骤、单项一键应用、多选勾选「让 AI 补齐已选」（带 Gemini 流光边效）及「暂不调整」折叠；历史轮次自动收起，全部达标后显示「常见生产基线已就绪」",
			"升级填表系统提示词与内置技能（deployment-form.md）引导 AI 主动把关生产基线并输出精炼总结，同时优化历史问答卡片已选项高亮与对话区左轴对齐（34px）",
		},
		HighlightsEn: []string{
			"Added a schema-driven production baseline inspection engine (ai_form_baseline.go) that automatically audits host disk consistency, logging/slow-query/lock-wait baselines, security (TLS/TDE/CIDR/idle-tx timeout/app user), backup & persistence, unified access entries, and OS kernel baselines on every AI form fill, merging contextual AI notes",
			"Built the Swiss Leica interactive Production Baseline Check card (BaselineCard) with severity badges, current-to-recommended inline diffs, form-step locate links, single-click and multi-select batch AI remediation (with Gemini flowing hover rim), dismiss/collapse states, auto-collapsed history pills, and a Baselines Ready badge",
			"Upgraded AI form-fill system prompt and deployment-form skill for proactive baseline checks, highlighted selected answers in completed AskCards, and aligned form-fill cards flush to the 34px AI message axis",
		},
	},
	{
		Version: "1.0.308-dev",
		Date:    "2026-11-24",
		Title:   "升级 AI 变更确认条与组件工作台提示条为等宽丝滑 Gemini 流光边框",
		TitleEn: "Silky Symmetric Gemini Edge Light for AI Confirmation Bars & Workbench Marks",
		Highlights: []string{
			"彻底修复 AI 变更确认条（.fc-card「AI 改了 N 处」）因 1px mask-composite 导致的 Windows 缩放上边加粗、上下亮度不均与线性平移生硬问题：改用 1.5px 对称 border-box + 不透明内衬 + 双彗星自动环绕流光与柔和外晕，四边像素完全均等丝滑",
			"顺手精致化确认条内部元素：「看改了什么」升级为轻量圆角胶囊按钮，「校验通过」升级为清透翡翠绿状态胶囊",
			"同步清理全站最后残留的线性流光边框与旧紫晕圆点：组件工作台 AI 确认条（.wb-aicard）、表单写入外框（.fc-glow）统一接入自动环绕流光，工作台改动标记（[data-wb-ai]）与步骤实况点（.fw-live）全面统一为 2.5px 徕卡红竖标与纯净红点",
		},
		HighlightsEn: []string{
			"Fixed uneven top/bottom border thickness and stiff horizontal animation on AI confirmation bars (.fc-card) by upgrading to symmetric 1.5px dual-comet auto-flowing Gemini prism borders with opaque interiors",
			"Refined .fc-card interior controls with crisp rounded pills for View Changes and Validation Passed",
			"Upgraded remaining legacy borders and purple dots in Component Workbench (.wb-aicard, [data-wb-ai]), form glow (.fc-glow), and live stage pulse (.fw-live) to the unified Leica red & Gemini prism system",
		},
	},
	{
		Version: "1.0.307-dev",
		Date:    "2026-11-24",
		Title:   "重构部署向导机器存储卡片与全流程表单间距层级",
		TitleEn: "Redesigned Delivery Wizard Host Storage Cards & Unified Form Spacing",
		Highlights: []string{
			"彻底修复部署向导「主机与执行通道」机器卡片因 wizard.css 与 platform.css 冲突导致的 0px 粘连双边框与 4px 贴边挤压问题：改为 12px 独立圆角白瓷卡片与 14px 16px 充裕内边距，表头与输入框 0px 精准列对齐",
			"将每台机器默认展开的冗长存储参数升级为单行可折叠摘要条（展示存储方式、路径与自定义标记，仅存储报错或点击「调整参数」时展开），展开后采用三列均衡内凹面板（minmax(185px, 1fr)）消除单行落单",
			"全面排查并统一部署向导全部步骤的相似列表区块：角色与拓扑放置（.place-row）、平台自动加入（.auto）、关键参数（.param）与入口附加项（.addon）均升级为统一间距的独立白瓷卡片，并优化校验报错态为克制的左侧红竖线提示",
		},
		HighlightsEn: []string{
			"Fixed the CSS collision on Wizard host rows that caused zero-gap glued borders and cramped 4px padding — upgraded to cleanly separated 12px-gap rounded porcelain host cards with exact column header alignment",
			"Converted verbose per-host storage parameters into a sleek collapsible one-line summary strip (expanding into a balanced 3-column recessed drawer on click or storage validation error)",
			"Unified spacing, padding, and calm error-bar accents across all sibling Wizard sections (Roles & Placement, Auto-Added Components, Key Parameters, and Access Addons)",
		},
	},
	{
		Version: "1.0.306-dev",
		Date:    "2026-11-24",
		Title:   "重构 AI 自动填表进度卡与表单字段变更指示条",
		TitleEn: "Redesigned AI Live Form-Fill Progress Card & Field Change Indicators",
		Highlights: []string{
			"重构「AI 正在填写表单」实时进度卡（.fw-run）：外框升级为 Gemini 自动流光棱镜边框与不透明白瓷/曜石内衬，头部改为 Kyndryl AIEmblem + 等宽计数胶囊 + 轻质「跳过动画」按钮，阶段胶囊采用徕卡红脉动点高亮当前阶段",
			"重排实时写入字段列表（.fw-run-items）：放入浅灰内凹遥测底板，步骤列拓宽至 108px 并禁止断字，彻底消除「集群与架构方 / 案」单字折行；当前写入行以纯白浮层 + 2.5px 徕卡红左竖标与等宽值清晰突出",
			"将表单中 AI 改动字段左侧歪斜的渐变紫晕圆点（[data-ai-on]::before）升级为贯穿字段高度的 2.5px 徕卡暖红垂直指示条，并在任意字号与行高下始终严格对齐，同时统一 .fc-dot / .fc-navdot 与写入扫光动画配色",
		},
		HighlightsEn: []string{
			"Redesigned the AI live form-fill card (.fw-run) with the Gemini auto-flowing prism rim, Kyndryl AIEmblem header, monospace progress counter chip, crisp skip button, and Leica-red active stage pill",
			"Upgraded the live field telemetry feed (.fw-run-items) with a recessed surface, 108px non-wrapping section column (eliminating orphan character wraps), monospace values, and elevated active-row Leica-red left tick",
			"Replaced the misaligned gradient dot + purple halo on AI-modified form fields ([data-ai-on]) with a crisp 2.5px Leica warm-red vertical edge bar that aligns cleanly at any row height",
		},
	},
	{
		Version: "1.0.305-dev",
		Date:    "2026-11-24",
		Title:   "优化 AI 提问选择卡片图标徽章与交互细节",
		TitleEn: "Refined AI Question Card Badge & Controls",
		Highlights: []string{
			"将 AI 提问卡片（AskCard）左侧粗糙的泥色渐变问号方块替换为精雕徕卡暖红微光星标徽章（单题）与等宽步骤序号微标（多题），彻底告别生硬问号底块",
			"同步统一提问卡片自定义回答发送按钮（.ad-ask-go）与 AI 填表浮标（.fc-cursor-dot / .fc-cursor-tag）为白瓷曜石与徕卡暖红体系，并修复深色模式下已选勾选图标对比度",
		},
		HighlightsEn: []string{
			"Replaced the legacy gradient question-mark square on AI AskCard headers with a refined Leica warm-red Spark badge (single question) and monospace step badge (multi-question)",
			"Aligned the AskCard custom-reply send button and AI form-fill cursor tags with the Swiss Leica obsidian/red palette and fixed Dark Mode checkmark contrast",
		},
	},
	{
		Version: "1.0.304-dev",
		Date:    "2026-11-24",
		Title:   "升级全局 AI 按钮与输入框为 Gemini 风格悬停自动流光边框",
		TitleEn: "Gemini-Style Auto-Flowing Hover Edge Light for All AI Controls",
		Highlights: []string{
			"移除旧版鼠标坐标追踪（pointermove）流光，全面升级为纯 CSS @property --ai-angle 驱动的双彗星自动环绕棱镜流光（暖红 → 琥珀金 → 宝石蓝 → 冰青，并保留干净呼吸间隙），视觉质感对标 Google Gemini",
			"覆盖全局所有 AI 触点按钮（顶栏 AI 状态胶囊、右下角 AI 助手悬浮球、.ai-pill、AI 帮我填、执行监控问 AI、组件工作台与安全中心 AI 按钮）：静息态保持瑞士白瓷/曜石极简克制，鼠标悬停或聚焦即自动点亮 1.5px 边缘流光与相锁外晕",
			"统一 AI 对话框与演练输入卡片（.ap-compose / .ad-compose / .rh-compose）采用双层严密遮罩结构（::before 不透明内衬 + 流动边框，::after 紧贴外晕），彻底杜绝任何内底色渗漏，明暗双主题均晶莹利落",
		},
		HighlightsEn: []string{
			"Replaced pointer-chasing edge spots with pure CSS @property --ai-angle dual-comet auto-flowing Gemini prism edge light (Kyndryl warm red → solar gold → sapphire blue → cyan with clean breathing gaps)",
			"Enabled hover/focus-triggered 1.5px automatic flowing rim + phase-locked tight outer halo across all AI buttons (topbar AI pill, floating AI launcher, .ai-pill, Fill with AI, Ask AI, Workbench & VEX AI buttons) while keeping rest states clean and restrained",
			"Unified all AI composer cards (.ap-compose, .ad-compose, .rh-compose) with opaque padding-box occlusion so interiors remain 100% pure white/obsidian with zero glow bleed in Light and Dark modes",
		},
	},
	{
		Version: "1.0.303-dev",
		Date:    "2026-11-24",
		Title:   "重绘 Kyndryl AI 专属曜石 K-Spark 标识并统一无边框徽标体系",
		TitleEn: "Redesigned Kyndryl AI Obsidian K-Spark Emblem & Frameless Mounts",
		Highlights: []string{
			"重绘 AIEmblem 为 Kyndryl AI 专属工业风标识：哑光曜石机身 + 精密几何瓷白 K 字标 + 徕卡暖红四芒星与微光孔径环，与顶栏 BrandMark 形成完整品牌姊妹体系，彻底替代旧版泥棕青渐变与笨重白框",
			"替换「新建交付」AI 填表输入框左侧歪斜的浅灰方块（.fc-orb），改为端正稳重的无边框 AIEmblem，移除 -12deg 倾斜与旋转动画，忙碌态改为克制的徕卡红呼吸光晕",
			"精简并纯化全局内联 Spark 双星图标为纯正 Kyndryl 暖红渐变，统一 AI 主页、悬浮抽屉、新建交付向导、组件工作台与登录页所有 AI 触点视觉语言",
		},
		HighlightsEn: []string{
			"Redesigned AIEmblem as a bespoke Kyndryl AI mark featuring a machined obsidian chassis, crisp geometric white K monogram, and Leica-red 4-point optical spark — paired with frameless hero mounts across all AI surfaces",
			"Replaced the tilted grey .fc-orb sticker in the New Delivery AI form-fill composer with an upright, frameless AIEmblem and subtle Leica-red breathing pulse when active",
			"Refined the inline Spark glyph to a crisp Kyndryl warm-red twin-spark across the topbar, floating dock, wizard, workbench, and login showcase",
		},
	},
	{
		Version: "1.0.302-dev",
		Date:    "2026-11-24",
		Title:   "重构平台热更新与断网提示浮层响应式 UI",
		TitleEn: "Redesigned Responsive Hot-Reload & Connectivity Floating Dock",
		Highlights: []string{
			"重构 UpdatePill 为瑞士徕卡双区块悬浮浮层（.upd-toast）：左侧徕卡红状态点 + 标题/等宽版本徽章 + 次级说明，右侧垂直细线分隔并锁定「更新公告 / 刷新 / 关闭」操作组，彻底消除孤立圆点与「稍后」单独折行问题",
			"修复 .net-pill 因 left: 50% 无 fit-content 在宽屏下被 50vw 挤压的 CSS 缺陷，改为左右锚定自适应居中并消除半像素模糊",
			"支持全断点平滑适配：桌面端紧凑单行贴底悬浮，820px 以下自动抬升避让右下角 AI 浮球，640px 以下切换为顶栏右置关闭 + 底栏操作区的规范双行卡片，并自动感知断网提示避让与明暗双主题磨砂质感",
		},
		HighlightsEn: []string{
			"Redesigned UpdatePill into a two-zone Swiss Leica floating dock (.upd-toast) with Leica red beacon, monospace version chip, subtitle, vertical divider, and atomic action group — eliminating lone dot and orphan button wrapping",
			"Fixed the 50vw shrink-wrap bug on fixed .net-pill containers using full-width inset auto-centering",
			"Added responsive breakpoints across desktop, tablet (820px AI FAB clearance), and narrow/mobile (640px clean two-row card), plus automatic stacking above ConnectivityPill and full Light/Dark frosted glass styling",
		},
	},
	{
		Version: "1.0.301-dev",
		Date:    "2026-11-24",
		Title:   "内置 32 套常见中间件全彩矢量 SVG 品牌图标库",
		TitleEn: "32 Enterprise Middleware Full-Color Vector SVG Brand Icons",
		Highlights: []string{
			"内置 32 套全彩矢量 SVG 中间件品牌图标（PostgreSQL、Patroni、Redis、Nginx、HAProxy、Keepalived、etcd、ELB、MySQL、MariaDB、MongoDB、Kafka、RabbitMQ、Elasticsearch、ZooKeeper、MinIO、Prometheus、Grafana、Kubernetes、Docker、ClickHouse、Nacos、Consul、RocketMQ、Envoy、Traefik、Valkey、TiDB、OpenSearch、Memcached、Harbor、Zabbix），采用白瓷/曜石精细底座卡片，彻底替代通用渐变色块图标",
			"同步后端 mwpack.ComponentIcons 与全部 8 个内置组件清单，并为已有历史组件与交付记录按组件标识自动升级匹配品牌 SVG，无需修改存量配置",
			"组件工作台新建与样式编辑器图标面板置顶「常见中间件」全彩 SVG 网格，同时优化深色模式下的对比度与选中态表现",
		},
		HighlightsEn: []string{
			"Introduced 32 full-color vector SVG brand logos for enterprise middleware rendered on sculpted porcelain/obsidian tiles across Deliveries, Monitor, Apps, and Components",
			"Synchronized mwpack.ComponentIcons and all 8 built-in catalog manifests, with automatic brand SVG upgrades for legacy deployments and manifests",
			"Prioritized the 32-icon Common Middleware grid at the top of Component Workbench style pickers with tuned Light/Dark contrast",
		},
	},
	{
		Version: "1.0.300-dev",
		Date:    "2026-11-24",
		Title:   "重构平台设置「通知模板」为双栏高定编辑器与悬浮实时预览工作台",
		TitleEn: "Redesign Notification Templates into a unified two-column Swiss Leica studio layout",
		Highlights: []string{
			"移除通知模板页挤压的四栏布局、248px 空旷二级侧栏与通高灰墙，重构为与全站设置页左轴对齐的 .sx-page 瑞士徕卡双栏工作台，顶部清晰呈现标题与保存/恢复默认操作",
			"引入带 2.5px 徕卡红竖线的横向消息类型选择条，将 Markdown 格式工具栏与字数状态条一体嵌入正文编辑器框体，变量插入升级为紧凑行内胶囊，并将实时预览与「发送真实示例验证」收束在首屏可见的悬浮白瓷卡片内",
		},
		HighlightsEn: []string{
			"Replaced the cramped 4-column Notification Templates layout (empty 248px mini-sidebar + full-height grey right wall) with a unified .sx-page two-column Swiss Leica studio aligned cleanly with Settings tabs",
			"Added a horizontal event selector strip with a 2.5px Leica red active edge tick, unified Markdown toolbar + textarea + footer inside one bordered editor frame, compacted variable insert chips, and kept the Live Preview + Send Sample card cleanly visible above the fold",
		},
	},
	{
		Version: "1.0.299-dev",
		Date:    "2026-11-24",
		Title:   "重构执行监控侧栏列表与遥测细节为瑞士徕卡高定统一风格",
		TitleEn: "Redesign Execution Monitor rail and telemetry highlights to match Swiss Leica system",
		Highlights: []string{
			"重构执行监控左侧集群列表为与交付页 1:1 统一的日期分组、紧凑双行卡片与 2.5px 徕卡红选中竖线；移除每行下方冗长粗进度条，改以右对齐等宽步骤数徽章（仅运行中展示 2px 底部细轨），完整呈现集群名不再截断",
			"组件快捷筛选升级为单行可滚动 5px 圆角矩形条；移除已完成任务顶部的刺眼绿色横条，并将暗黑终端选中事件与阶段标题升级为通透钛灰底 + 徕卡红细竖线",
		},
		HighlightsEn: []string{
			"Redesigned Execution Monitor left rail to match Deliveries 1:1 with date grouping, compact two-line cards, 2.5px Leica Warm Red active edge ticks, and right-aligned tabular step badges so cluster names display without truncation",
			"Upgraded component filters into a crisp single-row 5px rounded-rect strip, removed static green top progress bars on completed runs, and refined dark terminal selected-event highlights to frosted titanium with a Leica red accent bar",
		},
	},
	{
		Version: "1.0.298-dev",
		Date:    "2026-11-24",
		Title:   "修复搜索框右侧快捷键 / 遮挡占位文案的问题",
		TitleEn: "Fix search input shortcut kbd suffix overlapping placeholder text",
		Highlights: []string{
			"在全局 Arco Input 样式中为输入框补齐 flex: 1 1 0%; min-width: 0 与后缀 8px 间距，并启用占位文案省略号截断，彻底避免右侧快捷键 / 与文字重叠遮挡",
			"精简交付侧栏搜索占位文案为「搜索集群、应用或方式」，在 1440px 与 1100px 窄侧栏下均完整展示且与 / 保持清晰间距",
		},
		HighlightsEn: []string{
			"Added flex: 1 1 0% / min-width: 0, 8px suffix separation, and placeholder ellipsis globally on Arco inputs so trailing <kbd>/</kbd> shortcuts never overlap input or placeholder text",
			"Tightened Delivery rail search placeholder so it fits cleanly with an 8px gap before / across both standard (304px) and narrow (284px) sidebars",
		},
	},
	{
		Version: "1.0.297-dev",
		Date:    "2026-11-24",
		Title:   "登录页标题与展示卡 Kyndryl 品牌字标升级为官方暖红高亮",
		TitleEn: "Style Kyndryl wordmark in official Warm Red on login title and showcase eyebrow",
		Highlights: []string{
			"将登录页主标题「登录 Kyndryl Delivery Studio」及右侧 AI 展示卡眉标中的 Kyndryl 统一升级为官方暖红（#FF462D / 深色 #FF553E）加粗高亮，并微调标题字号确保单行平衡呈现",
		},
		HighlightsEn: []string{
			"Highlighted Kyndryl in official Kyndryl Warm Red (#FF462D light / #FF553E dark) with balanced bold weight in the login page H1 title and AI showcase eyebrow",
		},
	},
	{
		Version: "1.0.296-dev",
		Date:    "2026-11-24",
		Title:   "升级 Kyndryl Delivery Studio 品牌与瑞士徕卡高定视觉细节",
		TitleEn: "Upgrade to Kyndryl Delivery Studio with Swiss Leica luxury palette and layout fixes",
		Highlights: []string{
			"全站正式定名为 Kyndryl Delivery Studio，重铸零偏黄白瓷铂金浅色画布与阳极氧化钛黑深色主题，将交互主色收束为哑光曜石黑，仅在 Logo、顶栏与页签指示线、侧栏选中细竖条及未读红点保留徕卡暖红（#FF462D）点睛",
			"精准对齐顶栏 [K] kyndryl | Delivery Studio 与导航项光学基线（误差 <0.4px），修复 AI 输入框发送按钮溢出，并统一暗黑模式反色图标对比度（--on-brand）与曜石思考胶囊",
		},
		HighlightsEn: []string{
			"Renamed platform to Kyndryl Delivery Studio with Swiss Leica pure porcelain light and anodized titanium dark palettes, separating matte obsidian interactive tokens (--brand/--on-brand) from surgical Kyndryl Warm Red (--kyndryl) accents",
			"Aligned topbar [K] kyndryl | Delivery Studio optically with navigation tabs (<0.4px), fixed AI composer send-button overflow across widths, removed legacy rainbow/purple composer highlights, and unified dark-mode contrast on inverted badges",
		},
	},
	{
		Version: "1.0.295-dev",
		Date:    "2026-11-24",
		Title:   "全新升级 Kyndryl Delivery Hub 品牌、官方 Warm Red 视觉体系与几何 K 标志",
		TitleEn: "Rebrand to Kyndryl Delivery Hub with Warm Red / Charcoal / Warm Stone visual system",
		Highlights: []string{
			"平台全站正式升级为 Kyndryl Delivery Hub（Kyndryl 交付中心），全面更新顶栏官方字标锁组（kyndryl | Delivery Hub）、几何 K 暖红徽标、浏览器 Favicon、登录页、AI 助手人设与安全/交付文档导出模板",
			"全面重构明暗双模式视觉体系为 Kyndryl Shidoka 风格：Warm Stone 暖石画布、Warm Charcoal 权威主按钮、Kyndryl Warm Red (#FF462D) 品牌高亮与 Deep Spruce 深云杉青自动化遥测色，彻底清理全站残留靛紫色",
		},
		HighlightsEn: []string{
			"Rebranded platform to Kyndryl Delivery Hub across topbar lockup (kyndryl | Delivery Hub), geometric Warm Red K mark, favicon, login experience, AI assistant personas, and exported compliance/delivery reports",
			"Rebuilt light and dark design tokens in Kyndryl Shidoka style (Warm Stone surfaces, Warm Charcoal primary CTAs, Kyndryl Warm Red #FF462D brand accents, Deep Spruce telemetry) and eliminated legacy indigo/purple overrides",
		},
	},
	{
		Version: "1.0.294-dev",
		Date:    "2026-11-24",
		Title:   "统一标题栏状态标签为圆角矩形并精准修正中文垂直居中",
		TitleEn: "Unify header status tags to 5px rounded rectangles with optical vertical centering",
		Highlights: []string{
			"统一集群详情标题栏中状态徽章、部署方式标签、已落地变更标签、验证通道标签及架构节点标签为一致的 22px 高度与 5px 圆角矩形，消除长方形与胶囊圆角混搭及高低错位",
			"为中英文标签文字引入光学垂直居中裁剪（text-box-trim）并收紧标题行高与间距，彻底修正 Windows 字体下标签文字偏上的视觉偏移，同时统一安全中心与报告模板卡片标签圆角",
		},
		HighlightsEn: []string{
			"Unified cluster header badges, applied-change chips, verification tags, architecture node badges, and security/report badges to a consistent 22px height and 5px rounded-rectangle geometry",
			"Added optical vertical centering (text-box-trim) and tight heading line-height so status dots, icons, and CJK/Latin labels sit centered to 0px tolerance across Windows and macOS",
		},
	},
	{
		Version: "1.0.293-dev",
		Date:    "2026-11-24",
		Title:   "修复执行监控窄屏布局截断并改为滑出式集群抽屉",
		TitleEn: "Fix Execution Monitor narrow-screen clipping with slide-over cluster drawer",
		Highlights: []string{
			"执行监控在 900px 及以下窄屏/半屏视口自动收起左侧集群栏，点击展开按钮以全高滑出抽屉展示，点击遮罩/选定集群/按 Esc 自动关闭，彻底消除顶部截断",
			"解除窄屏主工作区溢出截断并优化步骤目录折叠、终端日志栏换行与全宽路径展示，同步隐藏窄屏重复悬浮 AI 按钮避免遮挡步骤项",
		},
		HighlightsEn: []string{
			"Execution Monitor auto-collapses the cluster rail on viewports <= 900px into a full-height slide-over drawer with backdrop, close button, and auto-dismiss on selection or Escape",
			"Fixed narrow-screen workspace clipping, vertical step pipeline collapse, console header wrapping, and removed the redundant floating AI launcher button on narrow viewports",
		},
	},
	{
		Version: "1.0.292-dev",
		Date:    "2026-11-24",
		Title:   "全站 7 处表格与网格列表表头列对齐根治修复",
		TitleEn: "Fix Column Header Alignment Across 7 Tables & Grid Lists",
		Highlights: []string{
			"根治「设置 → 模型价格」我的价格与官方价格表头整体右偏约 30px 问题：将网格末列由 auto 改为显式定宽（64px / 36px）并补齐右对齐「操作」表头",
			"同步排查并根治全站其余 6 处同源对齐问题：IAM「操作审计 → 登录与在线」会话表末列 auto 偏移、设置「用量明细」费用表头左对齐与数值右对齐错位、软件库「库里的软件包」入库列过窄折行与对齐、设置「存储空间」操作列对齐、安全中心「按 CVE 明细」操作按钮右齐平、应用列表与向导主机列表网格轨道对齐",
		},
		HighlightsEn: []string{
			"Fixed Model Pricing header-vs-row horizontal offset by replacing auto trailing grid tracks with fixed widths (64px / 36px) and adding a right-aligned Action header",
			"Fixed 6 additional table/grid alignment issues across IAM Login Sessions, AI Usage Cost column, Software Library Package list, Storage quota table, Security CVE Detail actions, Apps list view, and Wizard host rows",
		},
	},
	{
		Version: "1.0.291-dev",
		Date:    "2026-11-24",
		Title:   "移除页面转场动画及其外观菜单开关",
		TitleEn: "Remove Page View Transitions & Appearance Menu Toggle",
		Highlights: []string{
			"移除右上角外观下拉菜单中的「页面转场动画」开关项，菜单仅保留浅色 / 深色 / 跟随系统三项",
			"移除路由层 document.startViewTransition 页面切换动画与对应 CSS 规则，全站页面切换即点即开、彻底消除残影",
		},
		HighlightsEn: []string{
			"Removed the Page Transitions toggle from the topbar Appearance menu, keeping Light / Dark / System only",
			"Removed router-level View Transition snapshots and CSS keyframes so page navigation switches immediately without ghosting",
		},
	},
	{
		Version: "1.0.290-dev",
		Date:    "2026-11-24",
		Title:   "能力库移除多余双侧栏并统一为标准 304px 左右分栏",
		TitleEn: "Unified Capabilities Workspace into Single 304px Left Rail",
		Highlights: []string{
			"移除能力库（知识库/技能/MCP）最左侧多余的 74px 竖向图标窄栏，彻底消除双侧栏割裂感，左侧边栏严格对齐全站 304px 基准线并为主画布释放 +74px 宽度",
			"将「知识库 / 技能 / MCP」整合为侧栏顶部紧凑的横向图标下划线标签页，三模块切换时标题、标签、搜索框与范围切换条坐标完全固定无跳动",
		},
		HighlightsEn: []string{
			"Removed the extra 74px vertical icon rail from Capabilities (KB/Skills/MCP) so the workspace aligns pixel-for-pixel with the platform's unified 304px left-rail layout and gives +74px more canvas width",
			"Integrated KB, Skills, and MCP as a crisp inline icon-underline tab bar inside the rail header with zero vertical shift when switching tabs",
		},
	},
	{
		Version: "1.0.289-dev",
		Date:    "2026-11-24",
		Title:   "补齐组件标签栏优先级与新建交付搜索栏细节优化",
		TitleEn: "Finalize Components Tab Specificity, New Picker Search, and Rollout Chip Width",
		Highlights: []string{
			"提高 .utabs.cv-utabs 选择器优先级覆盖 polish.css 间距，确保组件详情页第 9 项「清单源码」及行数角标完整展示无截断",
			"精简新建交付搜索框占位文案并放宽推广条样板集群芯片最大宽度（245px），消除尾部省略号截断",
		},
		HighlightsEn: []string{
			"Raised .utabs.cv-utabs selector specificity so the 9th Manifest Source tab and line count badge fit completely unclipped",
			"Shortened New Delivery search placeholder and widened rollout strip cluster chip max-width to 245px to avoid premature ellipsis",
		},
	},
	{
		Version: "1.0.288-dev",
		Date:    "2026-11-24",
		Title:   "全站 30 页 UI 全面巡检与排版重构（报告模板/漏洞源/组件/演练/IAM/个人中心）",
		TitleEn: "Full-Site UI Polish Across 30 Views (Report Templates, CVE Sources, Components, Rehearsal, IAM, Me)",
		Highlights: []string{
			"重构安全报告模板卡片（安全中心与设置页同步生效）：底栏改为单行零折行对齐布局（左 Word/Excel/预览 按钮组，右 设为默认|编辑/复制/重置），去重安全中心重复标题，全面替换硬编码浅色色值为主题变量",
			"重构漏洞源与门禁页：数据源管理头部三按钮右上单行齐平不再掉行；操作列改为右对齐消除内置源空洞；本地漏洞库已覆盖生态折叠为 6 个紧凑标签+展开切换，彻底拉平左右双卡高度",
			"优化漏洞清单与安全概览长 RPM 版本号对照：超长版本自动双行规范排列并将修复标签独立成行，彻底消除孤立箭头与文字混排",
			"一并修复全站巡检发现的 7 处细节问题：组件页右侧「清单源码」标签截断、演练页顶栏下拉框过窄与推广条重复集群名、个人中心 Token 数字截断（改为 18.01M + 悬停精确值）、IAM「调整额度」贴字无间距、新建交付搜索框 placeholder 裁切、知识库与技能/MCP 侧栏控件顺序不一致、页面底部留白避免右下角 AI 助手遮挡",
		},
		HighlightsEn: []string{
			"Refactored Security Report Template cards for single-row aligned footers, theme-token colors, and deduplicated section headers",
			"Fixed CVE Feed Sources header button wrapping, flush-right Actions alignment, and collapsible ecosystem chips to balance the dual cache/offline cards",
			"Prevented orphaned arrows and inline badge collisions on long RHEL/RPM version diffs in Vulnerabilities and Security Overview",
			"Fixed 7 additional site-wide visual issues discovered during the 30-screen audit across Components, Rehearsal, Me, IAM, New Delivery Picker, Knowledge Base, and bottom canvas clearance",
		},
	},
	{
		Version: "1.0.287-dev",
		Date:    "2026-11-24",
		Title:   "集群风险操作列 1280px 窄屏列宽防裁切优化",
		TitleEn: "Cluster Risk Action Column Width Safeguard at 1280px",
		Highlights: []string{
			"将集群风险表操作列比例调整至 28%（总表 min-width 860px）并微调操作项内边距，确保 1280px 笔记本宽度下「修复演练」胶囊左边框完整呈现无任何裁切",
		},
		HighlightsEn: []string{
			"Adjusted Cluster Risk action column share to 28% (table min-width 860px) and tightened inner gaps so the Rehearse pill renders completely unclipped at 1280px",
		},
	},
	{
		Version: "1.0.286-dev",
		Date:    "2026-11-24",
		Title:   "安全中心集群风险操作栏对齐与层级重构",
		TitleEn: "Cluster Risk Action Column Alignment & Hierarchy",
		Highlights: []string{
			"重构集群风险表操作列为右对齐统一锚点布局：所有行「集群安全页」严格沿表头「操作」右边线齐平，彻底消除无漏洞行右侧 60px 空洞与满屏紫框堆叠",
			"有漏洞集群在左侧展示浅色品牌胶囊「修复演练」与带竖线分隔的「筛选漏洞」，无漏洞集群隐藏无结果的「筛选漏洞」死链，仅保留清爽的中性「集群安全页」入口",
		},
		HighlightsEn: []string{
			"Refactored Cluster Risk action column to a flush-right anchored layout so Security aligns razor-straight under the Actions header across every row with zero trailing blank gap or purple-box clutter",
			"Show soft-tinted Rehearse pill and divider-separated CVEs link only on clusters with active vulnerabilities, hiding the dead-end CVEs link on clean rows",
		},
	},
	{
		Version: "1.0.285-dev",
		Date:    "2026-11-24",
		Title:   "软件库左下角状态卡与侧栏源按钮统一",
		TitleEn: "Library Rail Status Card & Unified Rail Source Button",
		Highlights: []string{
			"软件库侧栏底部新增固定「本地软件库」状态卡（与安全中心本地漏洞库对齐）：汇总展示总软件包数、总占用空间、就绪系统数、最近索引时间，并提供「更新索引」与「导入离线包」快捷入口",
			"将安全中心侧栏顶部「漏洞源」按钮由旧版自定义 26px 按钮统一替换为 Arco 原生 small 按钮 + 设置图标，并对齐标题字号与顶距，与软件库「软件源」保持像素级一致",
		},
		HighlightsEn: []string{
			"Added a pinned Local Library status card at the bottom of the Software Library rail matching Security Center's Local Advisory DB card, showing total packages, disk footprint, ready OS count, latest index time, plus quick Sync Index and Import buttons",
			"Unified Security Center's rail Sources button to the exact same native Arco small Button with settings icon and aligned 20px rail heading as Software Library",
		},
	},
	{
		Version: "1.0.284-dev",
		Date:    "2026-11-24",
		Title:   "修复平台设置切换离开 AI 页后顶部标签栏残留重复及通知模板页头换行",
		TitleEn: "Fix orphaned Settings group tab bar from duplicate React key and stabilize Notification Templates header",
		Highlights: []string{
			"修复平台设置中同级兄弟节点（.st-group-bar 与 .st-pane）在 AI 设置页同时使用 key='ai' 冲突导致 React 卸载漏删旧标签栏、切往通知模板/报告模板等任意页后顶部永久残留两行标签栏的严重 Bug",
			"为 .st-group-bar 补齐通栏底边并在通知模板页与左侧栏对齐；同步优化通知模板三栏比例（248px / 1fr / 300–360px）与操作按钮为紧凑单行排列，避免「恢复默认」「保存」折成两行",
		},
		HighlightsEn: []string{
			"Fixed duplicate sibling React key collision ('ai' on both .st-group-bar and .st-pane in SettingsPage) that leaked the AI subtab bar permanently above every subsequent settings view",
			"Added full-bleed bottom border and aligned gutter on .st-group-bar, rebalanced Notification Templates 3-column widths (248px / 1fr / 300-360px), and kept Reset Default / Save buttons cleanly on a single row",
		},
	},
	{
		Version: "1.0.283-dev",
		Date:    "2026-11-24",
		Title:   "修复集群配置页切换组件子标签时强制回顶跳动",
		TitleEn: "Preserve scroll position when switching inner Config sub-section tabs",
		Highlights: []string{
			"从集群详情滚动重置依赖中移除配置子分区（resolvedSection），在配置页切换 PostgreSQL / Patroni / etcd / 外部负载均衡等子标签时不再强制 scrollTo(0)，彻底消除多参数页切少参数页时的整体跳动",
		},
		HighlightsEn: []string{
			"Removed resolvedSection from Cluster detail's scroll-to-top effect so switching inner Config tabs (PostgreSQL, Patroni, etcd, External LB, etc.) preserves exact scroll position with zero vertical jump",
		},
	},
	{
		Version: "1.0.282-dev",
		Date:    "2026-11-24",
		Title:   "消除集群配置页切换多/少参数分组或标签时的页面跳动",
		TitleEn: "Eliminate horizontal and vertical layout jump when switching config tabs or parameter group filters",
		Highlights: []string{
			"为集群配置详情区（.cx-detail）与参数卡片堆叠区（.cx-spec-stack）设置视口级稳定最小高度并关闭浏览器 scroll-anchoring 干扰，从多参数页/全部分组切到少参数分组（如 1 项参数）时滚动位置零回弹、按钮纹丝不动",
			"将交付右侧滚动容器（.md-detail）改为 overflow-y: scroll 预留透明滚动条槽位，规避 Windows Chromium 下自定义 ::-webkit-scrollbar 导致 scrollbar-gutter 失效引发的横向 6px 抖动",
		},
		HighlightsEn: []string{
			"Added viewport-scaled min-height and overflow-anchor: none on Config detail and spec card stack so switching from long parameter lists to 1-item groups never clamps scrollTop or jumps controls under the pointer",
			"Set overflow-y: scroll on .md-detail (with transparent track) to work around Windows Chromium ignoring scrollbar-gutter with custom ::-webkit-scrollbar, eliminating 6px horizontal layout shifts",
		},
	},
	{
		Version: "1.0.281-dev",
		Date:    "2026-11-24",
		Title:   "对齐集群概览已落地变更台账与节点角色表列宽框架",
		TitleEn: "Align cluster overview applied changes ledger and hosts table grid",
		Highlights: []string{
			"为集群概览「生产已落地变更」与「节点与角色」统一圆角边框容器（border-radius: 9px、14px 对称内边距）并补齐分区通栏分割线，消除上下双边框与区块边界模糊",
			"将变更台账行改为 5 列固定网格（标题 / 等宽参数胶囊 / 操作人与时间 / 带分隔线的变更报告与演练入口 / 展开箭头），并为节点角色表设定均衡 4 列占比（18% / 21% / 22% / 39%）与浅底表头，上下纵线严丝合缝",
		},
		HighlightsEn: []string{
			"Unified Applied Production Changes ledger and Hosts & Roles table inside matching 9px bordered cards with 14px inner gutters and a clean full-bleed section divider",
			"Converted applied-change rows to a 5-track CSS grid with fixed-width param pills and separated action links, and gave Hosts & Roles deterministic column proportions (18%/21%/22%/39%) with a subtle tinted header",
		},
	},
	{
		Version: "1.0.280-dev",
		Date:    "2026-11-24",
		Title:   "修复变更模板卡片中部点击盲区与合并样板整行可选",
		TitleEn: "Fix swallowed click dead-zone inside import template cards and make variant rows clickable",
		Highlights: []string{
			"移除引入变更模板卡片参数预览容器（.ro-tpl-params）误加的 stopPropagation，改为仅在「+N 项参数 / 收起」按钮本身阻止冒泡，消除点击卡片中段空白或参数区域无法选中卡片的盲区",
			"同步修复「推广至其他集群」目标卡片右侧非按钮徽标吞掉勾选点击的问题，并支持点击合并样板记录整行直接切换样板",
		},
		HighlightsEn: []string{
			"Removed overly broad stopPropagation on the parameter preview container (.ro-tpl-params) inside Import Change cards so clicking anywhere on the card selects it, while keeping stopPropagation strictly on the +N more / Less toggle buttons",
			"Fixed swallowed clicks on non-button badges in the Propagate target picker and made merged pilot variant rows clickable across the full row",
		},
	},
	{
		Version: "1.0.279-dev",
		Date:    "2026-11-24",
		Title:   "对齐同效样板切换按钮并重构跨集群推广进度条",
		TitleEn: "Align merged pilot variant controls and redesign full-width rollout progress strip",
		Highlights: []string{
			"统一变更引入弹窗中归并样板行的「✓ 当前样板」与「选为样板」为等宽（min-width 84px）、等高（26px）描边胶囊并严格右对齐，消除文字与按钮参差错位",
			"重构跨集群推广状态条（RolloutProgressStrip）：展示参与集群状态胶囊（支持一键切换集群），并将固定 72px 短进度条改为自适应铺展进度轨与百分比读数，消除长横条中间大片空洞与紫色过重观感",
		},
		HighlightsEn: []string{
			"Unified merged pilot variant rows in the Import Change modal so Active Pilot and Use as Pilot share identical 84px min-width, 26px height, and flush-right alignment",
			"Redesigned the full-width RolloutProgressStrip with inline clickable participating cluster chips, a flexible stretching progress track with percentage readout, and calmer neutral/emerald styling",
		},
	},
	{
		Version: "1.0.278-dev",
		Date:    "2026-11-24",
		Title:   "优化跨集群推广看板居中弹窗与表格操作列排版",
		TitleEn: "Convert multi-cluster rollout board to centered modal with aligned action controls",
		Highlights: []string{
			"将「跨集群变更推广看板」从紧贴视口顶部、受 48px 固定页头挤压的右侧抽屉重构为宽屏居中弹窗（最高 940px），与「推广至其他集群」「从已有变更引入」等变更弹窗视觉体系完全统一，同时全局放宽 Arco Drawer 页头高度避免多行标题贴顶",
			"重构推广看板表格列宽配比（操作列扩至 15%）与单元格留白，将「当前页」与「查看 / 去处理」统一为等高 28px 描边胶囊并严格右对齐，消除锯齿错位与拥挤感",
		},
		HighlightsEn: []string{
			"Refactored the Multi-Cluster Change Rollout board from a top-cramped 780px side drawer into a balanced 940px centered modal matching sibling rehearsal dialogs, and fixed Arco Drawer header height globally so multi-line titles never jam against the top edge",
			"Rebalanced the 5-column rollout table with generous padding and unified the Action column into crisp 28px right-aligned controls for Current / View / Work states",
		},
	},
	{
		Version: "1.0.277-dev",
		Date:    "2026-11-24",
		Title:   "统一执行监控页头按钮高度与描边按钮视觉体量",
		TitleEn: "Unify execution monitor header button sizing and outline button elevation",
		Highlights: []string{
			"修复执行监控页头右侧「AI 助手」按钮混用默认大尺寸（34px）导致与相邻「刷新」「交付手册」（28px）高低错落的问题，统一所有页头操作按钮与实时流状态徽标为一致的 30px 高度、7px 圆角与 12.5px 字号",
			"统一 Arco outline 描边按钮的表面底色、浅品牌描边与轻微阴影体量，消除「刷新」与「交付手册」并排时的对比度与视觉大小落差",
		},
		HighlightsEn: []string{
			"Fixed mismatched default (34px) sizing on the Execution Monitor header AI Assistant button versus adjacent small (28px) controls; unified all header action controls and live-streaming badge to an exact 30px height, 7px radius, and 12.5px label scale",
			"Harmonized Arco outline buttons with secondary and AI pill elevation, surface fill, and soft brand border so adjacent buttons align cleanly in visual weight",
		},
	},
	{
		Version: "1.0.276-dev",
		Date:    "2026-11-24",
		Title:   "修正安全中心桌面端顶部重复漏洞库状态胶囊",
		TitleEn: "Hide redundant desktop DB status pill in Security Center header",
		Highlights: []string{
			"桌面端左侧导航栏底部已常驻本地漏洞库状态卡，隐藏右侧标题旁仅用于窄屏的重复状态胶囊，使头部更清爽",
		},
		HighlightsEn: []string{
			"Fixed CSS specificity so the mobile-only DB status pill stays hidden on desktop where the left rail DB card is visible",
		},
	},
	{
		Version: "1.0.275-dev",
		Date:    "2026-11-24",
		Title:   "将「安全中心」升级为与软件库、交付、设置统一的左右分栏架构",
		TitleEn: "Unify Security Center into platform left-rail and right-canvas layout",
		Highlights: []string{
			"将「安全中心」由原先全屏上下分栏改为平台统一的左侧固定导航栏（--rail-w）+ 右侧全宽白底主画布架构，与交付、软件库、设置视觉无缝对齐",
			"左侧导航栏分组收纳「态势与排查（安全概览 / 漏洞清单 / 集群风险）」与「合规与策略（报告模板 / 漏洞源与门禁）」并附实时计数，底部常驻本地漏洞库状态卡片与在线同步/导入离线库快捷入口",
			"右侧主画布按当前分区呈现精简头部与「立即扫描 / 导出报告」核心操作，窄屏（<=900px）自动折叠为顶部横排标签条保持响应式可用",
		},
		HighlightsEn: []string{
			"Migrated Security Center from full-width stacked tabs to the platform's unified sticky left-rail (--rail-w) + right white canvas layout matching Library, Deliveries, and Settings",
			"Organized navigation into Posture & Triage and Governance & Policy groups with live count pills and a pinned Local Advisory DB status card with Sync/Import controls",
			"Streamlined right-pane header to contextual title plus Scan Now and Export Report actions, with responsive horizontal tab fallback under 900px",
		},
	},
	{
		Version: "1.0.274-dev",
		Date:    "2026-11-24",
		Title:   "微调集群配置页导航条与搜索栏间距避免 7 标签时裁切",
		TitleEn: "Tighten cluster config nav and search spacing so all 7 tabs fit unclipped",
		Highlights: []string{
			"收紧配置页子导航按钮间距与右侧搜索框宽度，使包含 Patroni 与外部负载均衡的 7 个分类标签在 1440px 视口下完整单行展示不裁切",
		},
		HighlightsEn: []string{
			"Adjusted config nav item spacing and search bar width so all 7 tabs including Patroni and External LB render unclipped at 1440px",
		},
	},
	{
		Version: "1.0.273-dev",
		Date:    "2026-11-24",
		Title:   "重构集群「配置」页视觉结构并统一新旧 PostgreSQL 集群的 Patroni 配置视图",
		TitleEn: "Redesign Cluster Configuration UI with structured spec cards and unified Patroni view",
		Highlights: []string{
			"为旧版一体化交付的 PostgreSQL+Patroni 集群自动提取独立 Patroni 视图（标注「内置随 PG 部署」），同时在新版拆分交付中按职责分离 PostgreSQL 与 Patroni 参数，彻底消除 62 项全量重复展示并统一导航排序",
			"将原两列参差瀑布布局升级为单列带框规格卡片表，左对齐参数值并提供充裕宽度展示长规则与行内 Diff，新增顶部分组快捷筛选胶囊与组件概览头部",
			"消除满屏重复的「生成时补全」视觉噪音（仅高亮生产变更 / 已指定 / 未启用，默认项悬停轻显）并为 pg_hba、logging_* 等运行期变更参数补全中文标签避免名称重复，同步升级机器与角色及访问入口卡片布局",
		},
		HighlightsEn: []string{
			"Unified Patroni configuration tabs across legacy bundled and split PostgreSQL deliveries, cleanly partitioning Patroni HA params from PostgreSQL DB params to eliminate 62-item duplication and normalize tab ordering",
			"Replaced ragged 2-column parameter lists with full-width bordered specification cards, left-aligned values with generous room for inline diffs, quick group filter pills, and structured component hero cards",
			"Removed repetitive Defaulted label clutter, added bilingual labels for runtime params (pg_hba, logging_*), and upgraded Hosts & Roles and Access Endpoints into clean bordered cards",
		},
	},
	{
		Version: "1.0.272-dev",
		Date:    "2026-11-24",
		Title:   "优化「确认生产已实施完成」等演练弹窗首次打开流畅度",
		TitleEn: "Eliminate first-open jank on Production Completion and rehearsal modals",
		Highlights: []string{
			"移除全屏模态遮罩层耗时的 backdrop-filter 高斯模糊，改用干净半透明压暗并精简为 160ms GPU 合成入场动画，消除 VDI 与低硬件加速环境首次打开掉帧",
			"将生产落地确认与作废弹窗拆分为独立的懒挂载记忆组件，并以轻量原生输入框与固定高度文本域替代 20 余个 Arco 封装输入及 autoSize 同步重排",
			"关闭弹窗首帧 FocusLock 扫描、autoFocus 与点击坐标 transform-origin 测量，并将同集群重叠配置计算延迟至弹窗打开后单次执行",
		},
		HighlightsEn: []string{
			"Removed full-viewport backdrop-filter blur from modal/drawer masks and replaced Arco's 400ms scale(0.5) overshoot with a 160ms GPU-composited entrance",
			"Isolated Production Apply and Void modals into lazy-mounted memoized components with lightweight native inputs and fixed-row textareas, eliminating 20+ Arco wrapper mounts and autoSize forced reflows",
			"Disabled frame-1 FocusLock DOM walks, autoFocus, and getBoundingClientRect transform-origin reads while caching peer overlap calculations per open",
		},
	},
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
	fmt.Fprint(os.Stderr, `Kyndryl Delivery Studio — 企业级基础设施与中间件交付平台

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

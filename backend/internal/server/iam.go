package server

import (
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Who may do what. Every operation that changes something, and every page that is not for everyone, has a permission
// (perm). A role is a set of permissions plus how far its delivery permissions reach (scope: own, team or all). A
// person holds one or more roles and belongs to teams. The routes in routePerms say which permission each API needs,
// so a button and the request behind it are checked the same way.

type perm struct {
	ID     string `json:"id"`
	Module string `json:"module"`
	Title  string `json:"title"`
	Desc   string `json:"desc"`
}

// perms is the catalogue, in the order the role editor shows it.
var perms = []perm{
	{"delivery.view", "交付", "查看交付和集群", "交付列表、详情、手册和执行记录；能看到谁的由角色的数据范围决定"},
	{"delivery.create", "交付", "新建交付", "填写规格并生成首次部署或配置交付材料"},
	{"delivery.download", "交付", "下载交付材料", "下载完整交付包和单个文件"},
	{"delivery.run", "交付", "执行与记录", "记录每一步的执行结果、标记部署结果、采纳 AI 提出的手册修改"},
	{"delivery.delete", "交付", "删除交付", "删除交付和它的材料"},
	{"report.edit", "交付", "编辑文档", "填写和确认交付报告、运维交接、生产变更实施方案、根因分析里的文字，让 AI 起草与检查"},
	{"report.export", "交付", "导出文档", "把集群的文档导出为 Word，分开或合并"},

	{"component.edit", "组件", "编辑组件", "在组件工作台新建、修改草稿、复制组件、使用组件 AI"},
	{"component.publish", "组件", "发布组件", "发布草稿、恢复历史版本、恢复内置、删除组件"},
	{"component.import", "组件", "导入组件", "导入组件包"},

	{"library.manage", "软件库", "管理软件库", "下载、导入、删除软件包，更新、导入、导出软件源索引"},
	{"library.runtime", "软件库", "管理运行环境", "构建、导入、设为默认 Ansible 运行环境，上传 Python 包"},

	{"security.view", "安全", "查看安全中心", "浏览全平台 CVE 漏洞概览、受影响组件/软件库/集群清单及导出报告与 SBOM"},
	{"security.scan", "安全", "漏洞扫描与库同步", "触发离线/全量漏洞扫描、在线同步 OSV 漏洞库、导入导出离线漏洞库包"},
	{"security.manage", "安全", "漏洞处置与安全门禁", "标记 VEX 漏洞处置与风险豁免状态、配置组件发布与交付安全门禁策略"},

	{"ai.use", "AI", "使用 AI（总入口）", "开启后方可使用下方勾选的各项 AI 子功能"},
	{"ai.feat.assistant", "AI", "AI 助手", "顶栏 AI 助手对话页与通用问答"},
	{"ai.feat.kb", "AI", "知识库与检索增强", "顶栏知识库入口及 AI 对话知识检索（RAG）"},
	{"ai.feat.skills", "AI", "AI 技能", "顶栏技能页及对话中调用平台/个人技能"},
	{"ai.feat.mcp", "AI", "MCP 服务", "顶栏 MCP 页及对话中调用外部 MCP 工具"},
	{"ai.feat.component", "AI", "组件 AI", "组件工作台对话、AI 修订说明与组件评审"},
	{"ai.feat.form", "AI", "智能填表", "新建交付时使用 AI 对话自动填写部署规格"},
	{"ai.feat.review", "AI", "交付评审", "在交付详情页让 AI 评审部署方案与风险"},
	{"ai.feat.troubleshoot", "AI", "现场排障", "在执行手册与执行监控中贴回报错或截图让 AI 排障"},
	{"ai.feat.change_rehearsal", "AI", "变更演练", "在已交付集群发起只读探针与测试环境变更演练生成 SOP"},
	{"ai.feat.docs", "AI", "文档起草", "在集群文档中让 AI 起草并核对交付/交接/RCA 说明文字"},
	{"ai.feat.library", "AI", "软件库 AI", "在软件库运行环境页发起 AI 依赖差异与升级评估"},
	{"ai.feat.security", "AI", "安全 AI", "在安全中心和集群安全页按需使用 AI 进行 CVE 研判、影响评估与缓解建议"},
	{"ai.settings", "AI", "AI 设置", "AI 一键总开关、功能模块总控、模型供应商、联网搜索、平台技能和 MCP 服务"},
	{"ai.usage", "AI", "查看 AI 用量", "所有人的 AI 调用明细、用量与成本"},

	{"kb.view", "知识库", "使用团队知识库", "浏览团队知识库，AI 回答时也会查它"},
	{"kb.submit", "知识库", "提交到团队知识库", "把资料或排障经过提交给团队知识库，审核后入库"},
	{"kb.manage", "知识库", "管理团队知识库", "审核提交、直接编辑和删除团队资料"},

	{"iam.user", "IAM", "管理用户", "添加用户、重置密码、停用、分配角色和团队"},
	{"iam.role", "IAM", "管理角色", "新建和修改角色的权限与数据范围"},
	{"iam.team", "IAM", "管理团队", "新建团队、调整成员"},
	{"audit.view", "IAM", "查看操作审计", "平台上所有人的操作记录"},

	{"execution.manage", "设置", "管理执行节点", "注册执行节点、限定可操作集群与机器、停用节点"},
	{"delivery.execute", "交付", "启动自动执行", "确认机器与步骤后授权执行、暂停和结束批次"},
	{"settings.notify", "设置", "通知设置", "通知渠道、规则和模板"},
	{"settings.report", "设置", "报告模板", "导出 Word 时的单位名称、密级、页眉页脚和封面说明"},
	{"settings.storage", "设置", "存储空间设置", "每个人的默认存储额度、单个文件大小上限"},
	{"settings.sandbox", "设置", "代码沙箱设置", "开启或关闭 AI 的代码沙箱、运行时间和内存上限、运行自检"},
}

var permIndex = func() map[string]perm {
	m := map[string]perm{}
	for _, p := range perms {
		m[p.ID] = p
	}
	return m
}()

// scopes, narrowest first.
var scopeRank = map[string]int{"own": 0, "team": 1, "all": 2}

// aiFeaturePerms lists all granular per-module AI usage permissions controlled under ai.use.
var aiFeaturePerms = []string{
	"ai.feat.assistant",
	"ai.feat.kb",
	"ai.feat.skills",
	"ai.feat.mcp",
	"ai.feat.component",
	"ai.feat.form",
	"ai.feat.review",
	"ai.feat.troubleshoot",
	"ai.feat.change_rehearsal",
	"ai.feat.docs",
	"ai.feat.library",
	"ai.feat.security",
}

func aiFeaturePermID(feature string) string {
	id := "ai.feat." + feature
	if _, ok := permIndex[id]; ok {
		return id
	}
	return ""
}

func isAIFeaturePerm(p string) bool { return strings.HasPrefix(p, "ai.feat.") }

// expandRolePerms computes the effective permission list of a role:
//   - If "ai.use" is absent, any stray ai.feat.* entries are ignored (parent gate).
//   - If "ai.use" is present on a legacy role saved before granular AI perms existed
//     (!r.GranularAI and zero ai.feat.* stored), all ai.feat.* permissions are auto-granted for backwards compatibility.
func expandRolePerms(r role) []string {
	hasAIUse := false
	hasAnyFeat := false
	for _, p := range r.Perms {
		if p == "ai.use" {
			hasAIUse = true
		} else if isAIFeaturePerm(p) {
			hasAnyFeat = true
		}
	}
	out := make([]string, 0, len(r.Perms)+len(aiFeaturePerms))
	seen := map[string]bool{}
	for _, p := range r.Perms {
		if isAIFeaturePerm(p) && !hasAIUse {
			continue
		}
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	if hasAIUse && !r.GranularAI && !hasAnyFeat {
		for _, fp := range aiFeaturePerms {
			if !seen[fp] {
				seen[fp] = true
				out = append(out, fp)
			}
		}
	}
	return out
}

type role struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Desc       string   `json:"desc,omitempty"`
	Perms      []string `json:"perms"`
	Scope      string   `json:"scope"`
	Builtin    bool     `json:"builtin,omitempty"`
	GranularAI bool     `json:"granular_ai,omitempty"`
}

func allPerms() []string {
	out := make([]string, len(perms))
	for i, p := range perms {
		out[i] = p.ID
	}
	return out
}

// builtinRoles cannot be changed; they can be copied into roles of one's own.
var builtinRoles = []role{
	{ID: "sysadmin", Name: "系统管理员", Desc: "管理整个平台：用户、角色、设置、组件和软件库，能看到所有交付", Perms: allPerms(), Scope: "all", Builtin: true, GranularAI: true},
	{ID: "engineer", Name: "交付工程师", Desc: "做交付：生成、下载、执行自己的交付，并在开启 AI 时使用变更演练和排障助手", Perms: []string{"delivery.view", "delivery.create", "delivery.download", "delivery.run", "delivery.delete", "report.edit", "report.export", "security.view", "ai.use", "ai.feat.assistant", "ai.feat.kb", "ai.feat.skills", "ai.feat.mcp", "ai.feat.form", "ai.feat.review", "ai.feat.troubleshoot", "ai.feat.change_rehearsal", "ai.feat.docs", "ai.feat.library", "ai.feat.security", "kb.view", "kb.submit"}, Scope: "own", Builtin: true, GranularAI: true},
	{ID: "maintainer", Name: "组件维护者", Desc: "维护组件和软件库：编辑、发布组件，准备软件包和运行环境", Perms: []string{"component.edit", "component.publish", "component.import", "library.manage", "library.runtime", "security.view", "security.scan", "ai.use", "ai.feat.assistant", "ai.feat.kb", "ai.feat.skills", "ai.feat.mcp", "ai.feat.component", "ai.feat.library", "ai.feat.security", "kb.view", "kb.submit"}, Scope: "own", Builtin: true, GranularAI: true},
	{ID: "auditor", Name: "只读审计员", Desc: "只看不改：所有交付、操作审计和 AI 用量", Perms: []string{"delivery.view", "report.export", "security.view", "audit.view", "ai.usage", "kb.view"}, Scope: "all", Builtin: true, GranularAI: true},
}

type team struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Desc string `json:"desc,omitempty"`
}

type grant struct {
	Roles []string `json:"roles"`
	Teams []string `json:"teams"`
}

// iamState is what is stored: roles of the organisation's own, teams, and who holds what.
type iamState struct {
	Roles  []role           `json:"roles"`
	Teams  []team           `json:"teams"`
	Grants map[string]grant `json:"grants"`
	// Deleted are the accounts that were removed. Their names are not given out again, so nobody inherits what is
	// still recorded under them.
	Deleted []deletedUser `json:"deleted,omitempty"`
}

type deletedUser struct {
	Username string   `json:"username"`
	At       string   `json:"at"`
	By       string   `json:"by"`
	Jobs     int      `json:"jobs"`              // deliveries still under the name
	Moved    string   `json:"moved,omitempty"`   // who the deliveries were handed to
	MovedN   int      `json:"moved_n,omitempty"` // how many
	Roles    []string `json:"roles,omitempty"`   // what the account held
}

// iamMu guards changes; iamCache keeps what was read, per data directory, because every request asks.
var (
	iamMu    sync.Mutex
	iamCache = map[string]iamState{}
)

func (s *storeServer) iamFile() string { return s.aiFile("iam.json") }

// iamLoad returns a copy the caller may change; call it with iamMu held.
func (s *storeServer) iamLoad() iamState {
	f := s.iamFile()
	st, ok := iamCache[f]
	if !ok {
		st = iamState{Roles: []role{}, Teams: []team{}, Grants: map[string]grant{}}
		if b, err := os.ReadFile(f); err == nil {
			_ = json.Unmarshal(b, &st)
		}
		if st.Grants == nil {
			st.Grants = map[string]grant{}
		}
		iamCache[f] = st
	}
	out := iamState{Roles: append([]role{}, st.Roles...), Teams: append([]team{}, st.Teams...), Grants: map[string]grant{}, Deleted: append([]deletedUser{}, st.Deleted...)}
	for k, v := range st.Grants {
		out.Grants[k] = v
	}
	return out
}

// iamSave writes the state and replaces what is cached; call it with iamMu held.
func (s *storeServer) iamSave(st iamState) error {
	if err := writeJSONFile(s.iamFile(), st); err != nil {
		return err
	}
	iamCache[s.iamFile()] = st
	return nil
}

func (st iamState) role(id string) (role, bool) {
	for _, r := range builtinRoles {
		if r.ID == id {
			return r, true
		}
	}
	for _, r := range st.Roles {
		if r.ID == id {
			return r, true
		}
	}
	return role{}, false
}

func (st iamState) allRoles() []role { return append(append([]role{}, builtinRoles...), st.Roles...) }

// grantOf is what a person holds. Someone never given roles keeps what the old two roles meant.
func (st iamState) grantOf(user, legacyRole string) grant {
	if g, ok := st.Grants[user]; ok {
		return g
	}
	if legacyRole == "admin" {
		return grant{Roles: []string{"sysadmin"}, Teams: []string{}}
	}
	return grant{Roles: []string{"engineer"}, Teams: []string{}}
}

// access is what one person may do right now.
type access struct {
	Perms map[string]bool
	Scope string
	Teams []string
	Roles []string
}

func (a access) can(p string) bool { return a.Perms[p] }

// accessOf works out a person's permissions from their roles; it is read on every request, so a change applies at once.
func (s *storeServer) accessOf(user string) access {
	s.mu.Lock()
	u, ok := s.users[user]
	s.mu.Unlock()
	if !ok {
		return access{Perms: map[string]bool{}, Scope: "own", Teams: []string{}, Roles: []string{}}
	}
	iamMu.Lock()
	st := s.iamLoad()
	iamMu.Unlock()
	return st.accessFrom(u)
}

func (st iamState) accessFrom(u storeUser) access {
	a := access{Perms: map[string]bool{}, Scope: "own", Teams: []string{}, Roles: []string{}}
	if u.Disabled {
		return a
	}
	g := st.grantOf(u.Username, u.Role)
	for _, id := range g.Roles {
		r, ok := st.role(id)
		if !ok {
			continue
		}
		a.Roles = append(a.Roles, id)
		for _, p := range expandRolePerms(r) {
			a.Perms[p] = true
		}
		if scopeRank[r.Scope] > scopeRank[a.Scope] {
			a.Scope = r.Scope
		}
	}
	a.Teams = append(a.Teams, g.Teams...)
	return a
}

func (s *storeServer) can(user, p string) bool { return s.accessOf(user).can(p) }

// userCanAIFeaturePerm checks the IAM permission layer for a specific AI module:
// the user must hold both "ai.use" and "ai.feat.<feature>" (if defined).
func (s *storeServer) userCanAIFeaturePerm(user, feature string) bool {
	if user == "" {
		return true
	}
	a := s.accessOf(user)
	if !a.can("ai.use") {
		return false
	}
	if fp := aiFeaturePermID(feature); fp != "" {
		return a.can(fp)
	}
	return true
}

// need answers 403 when the person lacks the permission.
func (s *storeServer) need(w http.ResponseWriter, user, p string) bool {
	if s.can(user, p) {
		return true
	}
	s.fail(w, 403, "没有「"+permIndex[p].Title+"」权限")
	return false
}

// jobVisible says whether a delivery is within what someone may see: theirs, their team's, or all, as their roles say.
// Like visibleJobs it takes s.mu itself, so it must not be called while holding it.
func (s *storeServer) jobVisible(user string, j storeJob) bool {
	return s.visibleJobs(user)(j.Owner)
}

// visibleJobs returns a filter by owner for lists. Everything it needs is worked out here, so the filter itself takes no
// locks and may be used while holding s.mu.
func (s *storeServer) visibleJobs(user string) func(owner string) bool {
	a := s.accessOf(user)
	if !a.can("delivery.view") {
		return func(string) bool { return false }
	}
	if a.Scope == "all" {
		return func(string) bool { return true }
	}
	ok := map[string]bool{user: true}
	if a.Scope == "team" && len(a.Teams) > 0 {
		mine := map[string]bool{}
		for _, t := range a.Teams {
			mine[t] = true
		}
		s.mu.Lock()
		users := make([]storeUser, 0, len(s.users))
		for _, u := range s.users {
			users = append(users, u)
		}
		s.mu.Unlock()
		iamMu.Lock()
		st := s.iamLoad()
		iamMu.Unlock()
		for _, u := range users {
			for _, t := range st.grantOf(u.Username, u.Role).Teams {
				if mine[t] {
					ok[u.Username] = true
				}
			}
		}
	}
	return func(owner string) bool { return ok[owner] }
}

// ---- which permission each request needs ----

type routePerm struct {
	methods string // "GET", "W" (anything but GET), "*" for all
	path    *regexp.Regexp
	perm    string // "" means any signed-in person; "a|b" means either
}

func rp(methods, path, p string) routePerm {
	return routePerm{methods, regexp.MustCompile("^" + path + "$"), p}
}

// routePerms are checked in order; the first that fits decides. A request that changes something and fits none is
// refused, so a new API cannot be left open by forgetting it here.
var routePerms = []routePerm{
	rp("*", `/api/settings/execution-nodes(/.*)?`, "execution.manage"),
	rp("W", `/api/jobs/[^/]+/executions(/.*)?`, "delivery.execute"),
	rp("*", `/api/(session(/heartbeat)?|logout)`, ""),
	rp("*", `/api/me(/.*)?`, ""),
	rp("GET", `/api/(catalog|ai/options|ai/models|ai/status)`, ""),
	rp("POST", `/api/ai/toggle`, "ai.settings"),

	rp("GET", `/api/executions/runs`, "delivery.view"),
	rp("GET", `/api/executions/agents`, "execution.manage|delivery.view"),
	rp("W", `/api/executions/agents`, "execution.manage"),
	rp("GET", `/api/jobs`, "delivery.view"),
	rp("W", `/api/jobs`, "delivery.create"),
	rp("W", `/api/certificates/check`, "delivery.create"),
	rp("GET", `/api/jobs/[^/]+/(archive|files/.*)`, "delivery.download"),
	rp("PATCH", `/api/jobs/[^/]+`, "delivery.run"),
	rp("DELETE", `/api/jobs/[^/]+`, "delivery.delete"),
	rp("W", `/api/jobs/[^/]+/progress(/img|/logs)?`, "delivery.run"),
	rp("W", `/api/jobs/[^/]+/sync`, "delivery.create"),
	rp("W", `/api/jobs/[^/]+/sync/keep`, "delivery.run"),
	rp("W", `/api/jobs/[^/]+/sync/confirm`, "delivery.run"),
	rp("GET", `/api/jobs/[^/]+/(scripts|patches)(/.*)?`, "delivery.view"),
	rp("W", `/api/jobs/[^/]+/(scripts|patches)(/.*)?`, "delivery.run"),
	rp("W", `/api/jobs/[^/]+/ai/proposals/.*`, "delivery.run|security.manage"),
	rp("W", `/api/jobs/[^/]+/ai/resolve`, "delivery.run"),
	rp("*", `/api/jobs/[^/]+/ai(/.*)?`, "ai.use"),
	rp("GET", `/api/jobs/.*`, "delivery.view"),
	rp("GET", `/api/clusters`, "delivery.view"),
	rp("GET", `/api/clusters/import/presets`, "delivery.view"),
	rp("W", `/api/clusters/import(/.*)?`, "delivery.create"),
	rp("GET", `/api/clusters/[^/]+/baseline`, "delivery.view"),
	rp("W", `/api/clusters/[^/]+/baseline`, "delivery.create"),
	rp("GET", `/api/clusters/[^/]+/export`, "report.export"),
	rp("GET", `/api/clusters/[^/]+/docs(/.*)?`, "delivery.view"),
	rp("W", `/api/clusters/[^/]+/docs(/.*)?`, "report.edit"),
	rp("GET", `/api/clusters/[^/]+/automation(/.*)?`, "delivery.view"),
	rp("W", `/api/clusters/[^/]+/automation/agents(/.*)?`, "execution.manage|delivery.execute"),
	rp("W", `/api/clusters/[^/]+/automation(/.*)?`, "delivery.execute|execution.manage"),
	rp("GET", `/api/clusters/[^/]+/rehearsals(/.*)?`, "delivery.view"),
	rp("W", `/api/clusters/[^/]+/rehearsals/[^/]+/exec(/.*)?`, "delivery.execute"),
	rp("W", `/api/clusters/[^/]+/rehearsals/[^/]+/sync-vex`, "security.manage"),
	rp("W", `/api/clusters/[^/]+/rehearsals(/.*)?`, "ai.use"),
	rp("GET", `/api/clusters/[^/]+/security(/.*)?`, "delivery.view"),
	rp("W", `/api/clusters/[^/]+/security(/.*)?`, "security.manage"),
	rp("GET", `/api/settings/report/summary`, "report.export"),
	rp("*", `/api/settings/report(/.*)?`, "settings.report"),
	rp("W", `/api/(resolve|spec/import|spec/export)`, "delivery.create"),

	rp("W", `/api/components/import`, "component.import"),
	rp("W", `/api/components/validate`, "component.import|component.edit"),
	rp("W", `/api/components/[^/]+/draft/publish`, "component.publish"),
	rp("W", `/api/components/[^/]+/revisions/[^/]+/restore`, "component.publish"),
	rp("W", `/api/components/[^/]+/versions/[^/]+/status`, "component.publish"),
	rp("DELETE", `/api/components/[^/]+/verifications/[^/]+`, "component.publish"),
	rp("DELETE", `/api/components/[^/]+`, "component.publish"),
	rp("*", `/api/components/[^/]+/(workspace|draft|revisions|ai|fork)(/.*)?`, "component.edit"),
	rp("W", `/api/components(/.*)?`, "component.edit"),
	rp("GET", `/api/components(/.*)?`, ""),

	rp("GET", `/api/library/python(/.*)?`, ""),
	rp("W", `/api/library/python(/.*)?`, "library.runtime"),
	rp("GET", `/api/library/(index/export|export)`, "library.manage"),
	rp("GET", `/api/library(/.*)?`, ""),
	rp("W", `/api/library(/.*)?`, "library.manage"),

	rp("GET", `/api/security/db/export`, "security.scan"),
	rp("*", `/api/security/ai(/.*)?`, "ai.use"),
	rp("GET", `/api/security(/.*)?`, "security.view"),
	rp("POST", `/api/security/ai-(analyze|polish)`, "ai.use"),
	rp("POST", `/api/security/sources/[^/]+/test`, "security.scan"),
	rp("W", `/api/security/(scan|db(/.*)?)`, "security.scan"),
	rp("W", `/api/security/(triage|policy|sources|ignores|report-templates)(/.*)?`, "security.manage"),

	rp("*", `/api/ai/chats(/.*)?`, "ai.use"),
	rp("*", `/api/ai/portal(/.*)?`, "ai.use"),
	rp("POST", `/api/ai/sandbox/approve`, "ai.use|component.edit"),
	rp("GET", `/api/settings/ai/usage(/.*)?`, "ai.usage"),
	rp("*", `/api/settings/storage`, "settings.storage"),
	rp("*", `/api/settings/sandbox`, "settings.sandbox"),
	rp("*", `/api/settings/sandbox/check`, "settings.sandbox"),
	rp("*", `/api/settings/ai(/.*)?`, "ai.settings"),
	rp("GET", `/api/settings/channels`, "settings.notify"),
	rp("*", `/api/settings(/.*)?`, "settings.notify"),

	rp("GET", `/api/audit(/sessions)?(/export)?`, "audit.view"),
	rp("DELETE", `/api/audit/sessions/[^/]+`, "iam.user"),
	rp("GET", `/api/iam(/.*)?`, "iam.user|iam.role|iam.team"),
	rp("W", `/api/iam/roles(/.*)?`, "iam.role"),
	rp("W", `/api/iam/teams(/.*)?`, "iam.team"),
	rp("W", `/api/iam/deleted/.*`, "iam.user"),
	rp("*", `/api/users(/.*)?`, "iam.user"),

	rp("GET", `/api/kb(/.*)?`, "kb.view"),
	rp("W", `/api/kb/submissions`, "kb.submit"),
	rp("W", `/api/kb(/.*)?`, "kb.manage"),
}

// routePerm finds the permission a request needs; ok is false when a changing request fits no rule.
func routePermFor(method, path string) (string, bool) {
	for _, x := range routePerms {
		switch x.methods {
		case "*":
		case "W":
			if method == "GET" || method == "HEAD" {
				continue
			}
		default:
			if method != x.methods && !(x.methods == "GET" && method == "HEAD") {
				continue
			}
		}
		if x.path.MatchString(path) {
			return x.perm, true
		}
	}
	return "", method == "GET" || method == "HEAD"
}

// allowed checks a request against routePerms and answers 403 when it is not allowed.
func (s *storeServer) allowedRoute(w http.ResponseWriter, r *http.Request, user string) bool {
	p, ok := routePermFor(r.Method, r.URL.Path)
	if !ok {
		s.fail(w, 403, "这个操作没有登记权限，已拒绝")
		return false
	}
	if p == "" {
		return true
	}
	a := s.accessOf(user)
	for _, x := range strings.Split(p, "|") {
		if a.can(x) {
			return true
		}
	}
	names := []string{}
	for _, x := range strings.Split(p, "|") {
		names = append(names, "「"+permIndex[x].Title+"」")
	}
	s.fail(w, 403, "没有"+strings.Join(names, "或")+"权限")
	return false
}

// sessionView is what the browser needs to show only what a person may use.
func (s *storeServer) sessionView(session storeSession) map[string]any {
	a := s.accessOf(session.User)
	ps := []string{}
	for p := range a.Perms {
		ps = append(ps, p)
	}
	sort.Strings(ps)
	role := "operator"
	if a.can("iam.user") {
		role = "admin"
	}
	iamMu.Lock()
	st := s.iamLoad()
	iamMu.Unlock()
	names := []string{}
	for _, id := range a.Roles {
		if r, ok := st.role(id); ok {
			names = append(names, r.Name)
		}
	}
	teams := []string{}
	for _, id := range a.Teams {
		for _, t := range st.Teams {
			if t.ID == id {
				teams = append(teams, t.Name)
			}
		}
	}
	authType := session.AuthType
	if authType == "" {
		authType = "jwt"
	}
	sess := normalizeSession(session)
	return map[string]any{
		"username":       sess.User,
		"role":           role,
		"csrf":           sess.CSRF,
		"perms":          ps,
		"scope":          a.Scope,
		"roles":          a.Roles,
		"role_names":     names,
		"teams":          a.Teams,
		"team_names":     teams,
		"session_id":     sess.ID,
		"auth_type":      authType,
		"issued_at":      sess.CreatedAt.UTC().Format(time.RFC3339),
		"last_active_at": sess.LastActiveAt.UTC().Format(time.RFC3339),
		"expires_at":     sess.Expires.UTC().Format(time.RFC3339),
		"ttl_seconds":    max(int64(time.Until(sess.Expires).Seconds()), 0),
	}
}

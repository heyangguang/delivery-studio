package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"middleware-deployer/mwpack"
)

const (
	langZhCN = "zh-CN"
	langEnUS = "en-US"
)

func isEnLang(lang string) bool {
	return lang == langEnUS || strings.HasPrefix(strings.ToLower(strings.TrimSpace(lang)), "en")
}

type langCtxKey struct{}

// normLang normalizes a browser or API language tag into either "en-US" or "zh-CN".
func normLang(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	if s == "" {
		return ""
	}
	if strings.HasPrefix(s, "en") {
		return langEnUS
	}
	if strings.HasPrefix(s, "zh") {
		return langZhCN
	}
	return ""
}

// reqLang determines the request language from explicit ?lang=, X-Lang header, or Accept-Language,
// defaulting to "zh-CN" so headless automation and existing tests preserve legacy defaults.
func reqLang(r *http.Request) string {
	if r == nil {
		return langZhCN
	}
	if l := normLang(r.URL.Query().Get("lang")); l != "" {
		return l
	}
	if l := normLang(r.Header.Get("X-Lang")); l != "" {
		return l
	}
	if al := strings.TrimSpace(r.Header.Get("Accept-Language")); al != "" {
		for _, part := range strings.Split(al, ",") {
			tag := strings.SplitN(strings.TrimSpace(part), ";", 2)[0]
			if l := normLang(tag); l != "" {
				return l
			}
		}
	}
	return langZhCN
}

func withLangContext(r *http.Request, lang string) *http.Request {
	if r == nil {
		return nil
	}
	return r.WithContext(ctxWithLang(r.Context(), lang))
}

func ctxWithLang(ctx context.Context, lang string) context.Context {
	if normLang(lang) == "" {
		lang = langZhCN
	}
	return context.WithValue(ctx, langCtxKey{}, lang)
}

func ctxLang(ctx context.Context) string {
	if ctx == nil {
		return langZhCN
	}
	if l, ok := ctx.Value(langCtxKey{}).(string); ok && l != "" {
		return l
	}
	return langZhCN
}

type langResponseWriter struct {
	http.ResponseWriter
	lang string
}

func (w *langResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *langResponseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// wLang extracts the resolved request language from any wrapped ResponseWriter.
func wLang(w http.ResponseWriter) string {
	for w != nil {
		if lr, ok := w.(*langResponseWriter); ok && lr.lang != "" {
			return lr.lang
		}
		if u, ok := w.(interface{ Unwrap() http.ResponseWriter }); ok {
			w = u.Unwrap()
		} else {
			break
		}
	}
	return langZhCN
}

func isEn(lang string) bool {
	return lang == langEnUS
}

func tr(lang, zh, en string) string {
	if lang == langEnUS && en != "" {
		return en
	}
	return zh
}

func rTr(r *http.Request, zh, en string) string {
	return tr(reqLang(r), zh, en)
}

func (s *storeServer) failBi(w http.ResponseWriter, status int, zh, en string) {
	s.writeJSON(w, status, map[string]string{"error": tr(wLang(w), zh, en)})
}

func releaseNotesFor(lang string) []releaseNote {
	out := make([]releaseNote, len(platformReleaseNotes))
	for i, n := range platformReleaseNotes {
		copyNote := n
		if lang == langEnUS {
			if n.TitleEn != "" {
				copyNote.Title = n.TitleEn
			}
			if len(n.HighlightsEn) > 0 {
				copyNote.Highlights = n.HighlightsEn
			}
		}
		out[i] = copyNote
	}
	return out
}

//go:embed go_messages_en.json
var goMessagesEnJSON []byte

var goExactMessages = func() map[string]string {
	m := map[string]string{}
	_ = json.Unmarshal(goMessagesEnJSON, &m)
	return m
}()

var goPrefixTranslations = []struct{ zh, en string }{
	{"生成标准模板失败：", "Failed to generate starter template: "},
	{"生成 Word 失败：", "Failed to generate Word document: "},
	{"AI 暂时没有回应：", "AI did not respond: "},
	{"保存失败，已恢复原状：", "Save failed; original state restored: "},
	{"发布失败，已恢复原状：", "Publish failed; original state restored: "},
	{"已修改，但记录修订失败：", "Updated, but failed to record revision: "},
	{"已发布，但记录修订失败：", "Published, but failed to record revision: "},
	{"已有同名但无法载入的组件，请先修复或删除它：", "An unloadable component with this name exists; fix or delete it first: "},
	{"已有同名组件：", "Component already exists: "},
	{"已有同名草稿：", "Draft already exists: "},
	{"无法创建草稿：", "Failed to create draft: "},
	{"无法准备公共流程草稿：", "Failed to prepare shared workflow draft: "},
	{"无法准备目标草稿：", "Failed to prepare target draft: "},
	{"目标文件已存在：", "Target file already exists: "},
	{"要删除的文件不存在：", "File to delete not found: "},
	{"要局部修改的文件不存在：", "File to patch not found: "},
	{"要改名的文件不存在：", "File to rename not found: "},
	{"清单引用无法展开：", "Failed to expand manifest references: "},
	{"清单无法解析：", "Failed to parse manifest: "},
	{"组件目录重新载入失败：", "Failed to reload component directory: "},
	{"组件载入失败，已回退：", "Component failed to load and was rolled back: "},
	{"这个自定义组件无法载入，已被跳过：", "Custom component failed to load and was skipped: "},
	{"离线材料未就绪：", "Offline artifact not ready: "},
	{"这份交付需要的离线软件包还没准备好：", "Required offline artifact is not ready for this delivery: "},
	{"部署规格有问题：", "Invalid deployment spec: "},
	{"同步失败：", "Sync failed: "},
	{"连接失败：", "Connection failed: "},
	{"提案已不再适用：", "Proposal is no longer applicable: "},
	{"提案没有通过平台校验，没有保存：", "Proposal failed validation and was not saved: "},
	{"没有这个角色：", "Role not found: "},
	{"没有这个团队：", "Team not found: "},
	{"没有这个用户：", "User not found: "},
	{"没有这份资料：", "Knowledge entry not found: "},
	{"没有这个工具：", "Tool not found: "},
	{"账户已创建，但角色没有保存：", "Account created, but role assignment failed: "},
	{"同一集群或机器已有执行任务，请先处理该批次：", "An execution batch is already active on this cluster or host; resolve it first: "},
	{"步骤文件缺失：", "Step file missing: "},
	{"软件库里没有 ", "Library does not contain "},
	{"Docker 不可用：", "Docker is unavailable: "},
	{"草稿无法载入，先修正检查中的错误：", "Draft cannot be loaded; fix validation errors first: "},
	{"试生成失败：", "Preview generation failed: "},
	{"试生成的 playbook 语法检查失败，没有保存：", "Generated playbook failed syntax check and was not saved: "},
	{"检查通过，但试生成失败，没有保存：", "Checks passed, but preview generation failed and was not saved: "},
	{"改完的 YAML 解析不了：", "Edited YAML cannot be parsed: "},
	{"文件集不合规：", "Invalid file set: "},
	{"外部服务连接失败：", "External MCP connection failed: "},
	{"外部工具调用失败：", "External tool call failed: "},
	{"外部工具报错：", "External tool error: "},
	{"供应商返回流式错误：", "Provider stream error: "},
	{"写记录失败：", "Failed to record note: "},
	{"写记录：模型的回复读不出来：", "Failed to parse model response for note: "},
	{"准备只读工作区失败：", "Failed to prepare read-only workspace: "},
	{"固定版本无效：", "Invalid pinned version: "},
	{"固定的版本无效：", "Invalid pinned version: "},
	{"本地执行快照被修改，已停止：", "Local execution snapshot modified; halted: "},
	{"缺少目标机器的执行汇总：", "Missing execution summary for target host: "},
	{"搜索失败：", "Web search failed: "},
	{"网页打开失败：", "Failed to fetch webpage: "},
	{"运行失败：", "Execution failed: "},
	{"缺少材料 ", "Missing artifact "},
	{"材料校验失败：", "Artifact checksum failed: "},
	{"下载失败：", "Download failed: "},
	{"索引包读取失败：", "Failed to read index bundle: "},
	{"索引包含不允许的内容：", "Index bundle contains disallowed entry: "},
	{"索引包里有重复的文件 ", "Duplicate entry inside index bundle: "},
	{"软件库包读取失败：", "Failed to read library bundle: "},
	{"软件库包含不允许的内容：", "Library bundle contains disallowed entry: "},
	{"p7b 里的证书读不出来：", "Failed to parse certificate in P7B: "},
	{"有一个证书读不出来：", "Unable to parse a certificate in chain: "},
	{"未找到可用的 Python 3.8+ 运行环境（当前系统 ", "No usable Python 3.8+ runtime found for "},
	{"指定的运行环境目录中没有可用于 ", "Specified sandbox runtime directory lacks Python 3 interpreter for "},
	{"展开运行环境失败：", "Failed to unpack sandbox runtime: "},
	{"压缩包里有越界的路径：", "Archive contains out-of-bounds path: "},
	{"请求外网访问：", "Requests external network access: "},
}

type goRule struct {
	re *regexp.Regexp
	fn func(lang string, m []string) string
}

var goRules []goRule

func init() {
	goRules = []goRule{
		{regexp.MustCompile(`^草稿已被别处保存过（(.+?)），请刷新后再改$`), func(_ string, m []string) string {
			return fmt.Sprintf("Draft was saved elsewhere by %s; refresh before editing", m[1])
		}},
		{regexp.MustCompile(`^已经有叫「(.+?)」的角色$`), func(_ string, m []string) string {
			return fmt.Sprintf("A role named %q already exists", m[1])
		}},
		{regexp.MustCompile(`^已经有叫「(.+?)」的团队$`), func(_ string, m []string) string {
			return fmt.Sprintf("A team named %q already exists", m[1])
		}},
		{regexp.MustCompile(`^没有「(.+?)」权限$`), func(lang string, m []string) string {
			return fmt.Sprintf("Missing permission: %s", localizeGoPermTitle(m[1]))
		}},
		{regexp.MustCompile(`^没有(.+?)权限$`), func(_ string, m []string) string {
			return fmt.Sprintf("Missing required permission (%s)", m[1])
		}},
		{regexp.MustCompile(`^该节点仍有未结束的执行（集群 (.+?)），请先结束或关闭后再删除$`), func(_ string, m []string) string {
			return fmt.Sprintf("Node still has an active execution for cluster %s; finish or close it before deleting", m[1])
		}},
		{regexp.MustCompile(`^这个执行机的软件源端口已用于集群 (.+?)，请在新交付中选择另一端口$`), func(_ string, m []string) string {
			return fmt.Sprintf("Repository port on this execution host is already used by cluster %s; pick another port", m[1])
		}},
		{regexp.MustCompile(`^还有 (\d+) 个必测演练步骤未验证通过，请先在测试环境完成演练后再定稿生产 SOP$`), func(_ string, m []string) string {
			return fmt.Sprintf("%s required rehearsal step(s) are not verified yet; verify them in staging before finalizing the SOP", m[1])
		}},
		{regexp.MustCompile(`^还有 (\d+) 处错误，不能发布$`), func(_ string, m []string) string {
			return fmt.Sprintf("Cannot publish while %s validation error(s) remain", m[1])
		}},
		{regexp.MustCompile(`^版本号无效或与当前组件不符`), func(_ string, _ []string) string {
			return "Invalid version format or version does not match component"
		}},
		{regexp.MustCompile(`^不允许的文件 (.+?)（只可含 .+）$`), func(_ string, m []string) string {
			return fmt.Sprintf("Disallowed archive path %s (allowed: component.yaml, manifest/, roles/, templates/, files/)", m[1])
		}},
		{regexp.MustCompile(`^软件库没有 (.+?)（(.+?)）：请先在“软件库”页获取或导入$`), func(_ string, m []string) string {
			return fmt.Sprintf("Library missing %s (%s); fetch or import it on the Library page first", m[1], m[2])
		}},
		{regexp.MustCompile(`^没有适用于 (.+?) 的软件源(.*)$`), func(_ string, m []string) string {
			return fmt.Sprintf("No software sources configured for %s; add a source under Library -> Sources", m[1])
		}},
		{regexp.MustCompile(`^软件源 (.+?) 的类型 (.+?) 与系统 (.+?) 不符$`), func(_ string, m []string) string {
			return fmt.Sprintf("Source %s type (%s) does not match OS %s", m[1], m[2], m[3])
		}},
		{regexp.MustCompile(`^按现在的组件，这份规格已经不能通过校验：(.+)$`), func(lang string, m []string) string {
			return "Spec no longer passes validation against current component: " + localizeGoMessage(lang, m[1])
		}},
		{regexp.MustCompile(`^请上传「(.+?)」的服务器证书和对应的私钥$`), func(_ string, m []string) string {
			return fmt.Sprintf("Upload both server certificate and private key for %q", m[1])
		}},
		{regexp.MustCompile(`^YAML 语法错误：(.+)$`), func(_ string, m []string) string {
			return "YAML syntax error: " + m[1]
		}},
		{regexp.MustCompile(`^组件名是 "([^"]+)"，但这个草稿属于 "([^"]+)"（组件名不能在草稿里改，请用「复制为新组件」）$`), func(_ string, m []string) string {
			return fmt.Sprintf("Component name %q does not match draft %q (use Clone / Fork to rename)", m[1], m[2])
		}},
		{regexp.MustCompile(`^角色 (\S+) 没有被任何步骤使用（步骤的 run\.role 没有指向它）$`), func(_ string, m []string) string {
			return fmt.Sprintf("Role %s is unused by any step (no step has run.role targeting it)", m[1])
		}},
		{regexp.MustCompile(`^任务用到模板 (.+?)，但 roles/([^/]+)/templates/ 与 templates/ 下都没有它$`), func(_ string, m []string) string {
			return fmt.Sprintf("Task references template %s, which was not found in roles/%s/templates/ or templates/", m[1], m[2])
		}},
		{regexp.MustCompile(`^软件库里还没有 ([^=]+)=([^（]+)（([^）]+)）：到「软件库」下载之后，这个版本才能生成交付$`), func(_ string, m []string) string {
			return fmt.Sprintf("Package %s=%s (%s) is not in Library yet; fetch it in Library before generating a delivery", m[1], m[2], m[3])
		}},
		{regexp.MustCompile(`^软件包 (\S+) 的版本还是模板里的占位符：.+$`), func(_ string, m []string) string {
			return fmt.Sprintf("Package %s still uses a template placeholder version; pick an actual version from Library", m[1])
		}},
		{regexp.MustCompile(`^容器内执行失败：(.+)$`), func(_ string, m []string) string {
			return "Container execution failed: " + m[1]
		}},
		{regexp.MustCompile(`^组件 (\S+) 无法与现有组件一起载入$`), func(_ string, m []string) string {
			return fmt.Sprintf("Component %s cannot be loaded alongside existing components", m[1])
		}},
		{regexp.MustCompile(`^与其他组件一起载入时失败：(.+)$`), func(lang string, m []string) string {
			return "Failed to load together with existing components: " + localizeGoMessage(lang, m[1])
		}},
		{regexp.MustCompile(`^模板里 (.+?) 有 (\d+) 个，(.+?) 有 (\d+) 个，没有成对$`), func(_ string, m []string) string {
			return fmt.Sprintf("Unmatched delimiters in template: %s (%s) vs %s (%s)", m[1], m[2], m[3], m[4])
		}},
		{regexp.MustCompile(`^多出的 \{%\s*(.+?)\s*%\}(.+)$`), func(_ string, m []string) string {
			return fmt.Sprintf("Unexpected {%% %s %%} without preceding if or for", m[1])
		}},
		{regexp.MustCompile(`^上一个未结束的是第 (\d+) 行的 (.+)$`), func(_ string, m []string) string {
			return fmt.Sprintf("previous unclosed %s on line %s", m[2], m[1])
		}},
		{regexp.MustCompile(`^\{%\s*(.+?)\s*%\} 对不上：(.+)$`), func(lang string, m []string) string {
			return fmt.Sprintf("Mismatched {%% %s %%}: %s", m[1], localizeGoMessage(lang, m[2]))
		}},
		{regexp.MustCompile(`^第 (\d+) 行的 \{%\s*(.+?)\s*%\} 没有结束$`), func(_ string, m []string) string {
			return fmt.Sprintf("Unclosed {%% %s %%} opened on line %s", m[2], m[1])
		}},
		{regexp.MustCompile(`^步骤「(.+?)」要运行 ([^，]+)，但组件里没有这个文件.*$`), func(_ string, m []string) string {
			return fmt.Sprintf("Step %q references %s, which does not exist; create it under Files or update run", m[1], m[2])
		}},
		{regexp.MustCompile(`^渲染失败：\n?([\s\S]+)$`), func(_ string, m []string) string {
			return "Template render failed:\n" + m[1]
		}},
		{regexp.MustCompile(`^静态检查通过$`), func(_ string, _ []string) string {
			return "Static checks passed"
		}},
		{regexp.MustCompile(`^([^：]+)：静态检查通过$`), func(_ string, m []string) string {
			return m[1] + ": static checks passed"
		}},
		{regexp.MustCompile(`^([^：]+)：未完成验证（已发布版本也存在相同试生成问题）：(.+)$`), func(lang string, m []string) string {
			return fmt.Sprintf("%s: unverified (published version has the same preview error): %s", m[1], localizeGoMessage(lang, m[2]))
		}},
		{regexp.MustCompile(`^([^：]+)：联合试生成通过（(\d+) 个项目文件）$`), func(_ string, m []string) string {
			return fmt.Sprintf("%s: cross-component preview passed (%s project files)", m[1], m[2])
		}},
		{regexp.MustCompile(`^任务「(.+?)」有改动，并且对这一步可能执行$`), func(_ string, m []string) string {
			return fmt.Sprintf("Task %q changed and may execute during this step", m[1])
		}},
		{regexp.MustCompile(`^它自己的 Playbook (.+?) 有改动$`), func(_ string, m []string) string {
			return fmt.Sprintf("Its own playbook %s changed", m[1])
		}},
		{regexp.MustCompile(`^(.+?) 是新增或删除的依赖文件$`), func(_ string, m []string) string {
			return fmt.Sprintf("%s was added or removed as a dependency", m[1])
		}},
		{regexp.MustCompile(`^(.+?) 对项目里每一次 Ansible 执行都生效，无法证明与这一步无关$`), func(_ string, m []string) string {
			return fmt.Sprintf("%s applies to every Ansible run in the project and cannot be proven unrelated", m[1])
		}},
		{regexp.MustCompile(`^(.+?) 是这一步用到的脚本，分析不出这一步让它执行哪个动作，无法证明改动与它无关$`), func(_ string, m []string) string {
			return fmt.Sprintf("%s is invoked by this step, but target action could not be statically resolved", m[1])
		}},
		{regexp.MustCompile(`^(.+?) 是这一步用到的脚本，无法逐函数分析（(.+?)），无法证明改动与它无关$`), func(lang string, m []string) string {
			return fmt.Sprintf("%s is invoked by this step and could not be analyzed per function (%s)", m[1], localizeGoMessage(lang, m[2]))
		}},
		{regexp.MustCompile(`^(.+?) 是这一步用到的文件（模板、脚本或变量），无法证明改动与这一步无关$`), func(_ string, m []string) string {
			return fmt.Sprintf("%s is used by this step (template, script, or variables) and cannot be proven unrelated", m[1])
		}},
		{regexp.MustCompile(`^动作 (.+?) 对应的处理函数换了$`), func(_ string, m []string) string {
			return fmt.Sprintf("Handler function for action %q changed", m[1])
		}},
		{regexp.MustCompile(`^动作 (.+?) 会执行的函数 (.+?) 有改动（第 (\d+) 行）$`), func(_ string, m []string) string {
			return fmt.Sprintf("Function %s invoked by action %q changed (line %s)", m[2], m[1], m[3])
		}},
		{regexp.MustCompile(`^动作 (.+?) 会执行的函数 (.+?) 有改动（已删除）$`), func(_ string, m []string) string {
			return fmt.Sprintf("Function %s invoked by action %q was removed", m[2], m[1])
		}},
		{regexp.MustCompile(`^变量 (.+?) 有改动$`), func(_ string, m []string) string {
			return "Variables changed: " + localizeSyncVarParts(m[1])
		}},
		{regexp.MustCompile(`^(?:修复漏洞|安全修复)[：:]\s*(.+)$`), func(lang string, m []string) string {
			return "Security fix: " + localizeGoMessage(lang, m[1])
		}},
		{regexp.MustCompile(`^(?:修复漏洞|安全修复)$`), func(_ string, _ []string) string {
			return "Security fix"
		}},
		{regexp.MustCompile(`^升级[：:]\s*(.+)$`), func(lang string, m []string) string {
			return "Upgrade: " + localizeGoMessage(lang, m[1])
		}},
		{regexp.MustCompile(`^固定版本[：:]\s*(.+)$`), func(lang string, m []string) string {
			return "Pinned versions: " + localizeGoMessage(lang, m[1])
		}},
		{regexp.MustCompile(`^([^：]+)：(.+)$`), func(lang string, m []string) string {
			rest := localizeGoMessage(lang, m[2])
			if rest != m[2] {
				return m[1] + ": " + rest
			}
			return m[0]
		}},
	}
}

func localizeSyncVarParts(raw string) string {
	parts := strings.Split(raw, "；")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		switch {
		case strings.HasPrefix(p, "等 ") && strings.HasSuffix(p, " 项"):
			n := strings.TrimSuffix(strings.TrimPrefix(p, "等 "), " 项")
			p = fmt.Sprintf("and %s more", n)
		case strings.HasSuffix(p, " 中读取机器字段）"):
			p = strings.Replace(p, "（在 ", " (reads host field in ", 1)
			p = strings.TrimSuffix(p, " 中读取机器字段）") + ")"
		case strings.HasSuffix(p, " 中读取机器集合）"):
			p = strings.Replace(p, "（在 ", " (reads host group in ", 1)
			p = strings.TrimSuffix(p, " 中读取机器集合）") + ")"
		case strings.Contains(p, " 不指明实例地读取 mw_instances）"):
			p = strings.Replace(p, "（", " (reads unqualified mw_instances in ", 1)
			p = strings.TrimSuffix(p, " 不指明实例地读取 mw_instances）") + ")"
		case strings.HasSuffix(p, " 中直接读取实例）"):
			p = strings.Replace(p, "（在 ", " (reads instance directly in ", 1)
			p = strings.TrimSuffix(p, " 中直接读取实例）") + ")"
		case strings.HasSuffix(p, " 中用到）"):
			p = strings.Replace(p, "（在 ", " (used in ", 1)
			p = strings.TrimSuffix(p, " 中用到）") + ")"
		}
		out = append(out, p)
	}
	return strings.Join(out, "; ")
}

func localizeGoPermTitle(zh string) string {
	if mapped, ok := map[string]string{
		"新建并生成交付":   "Create & Build Deliveries",
		"查看全部交付":    "View All Deliveries",
		"执行与标记交付":   "Execute & Mark Deliveries",
		"修订与同步交付":   "Revise & Sync Deliveries",
		"删除交付":      "Delete Deliveries",
		"交付文档与导出":   "Delivery Docs & Export",
		"使用变更演练":    "Use Change Rehearsal",
		"编辑组件与草稿":   "Edit Components & Drafts",
		"发布与管理组件":   "Publish & Manage Components",
		"导入组件包":     "Import Component Bundles",
		"管理软件库与源":   "Manage Library & Sources",
		"使用 AI 助手":  "Use AI Assistant",
		"AI 设置":     "AI Settings",
		"通知设置":      "Notification Settings",
		"执行节点管理":    "Manage Execution Nodes",
		"安全与沙箱设置":   "Security & Sandbox Settings",
		"存储配额设置":    "Storage & Quota Settings",
		"报告模板设置":    "Report Template Settings",
		"查看审计日志":    "View Audit Logs",
		"管理账户、角色和团队": "Manage Users, Roles & Teams",
	}[zh]; ok {
		return mapped
	}
	return zh
}

func localizeGoMessage(lang, msg string) string {
	if !isEnLang(lang) || msg == "" {
		return msg
	}
	if mapped, ok := goExactMessages[msg]; ok && mapped != "" {
		return mapped
	}
	for _, p := range goPrefixTranslations {
		if strings.HasPrefix(msg, p.zh) {
			rest := strings.TrimPrefix(msg, p.zh)
			if rest == "" {
				return strings.TrimSuffix(p.en, ": ")
			}
			return p.en + localizeGoMessage(lang, rest)
		}
	}
	for _, r := range goRules {
		if m := r.re.FindStringSubmatch(msg); m != nil {
			return r.fn(lang, m)
		}
	}
	return mwpack.TranslateCatalogText(lang, msg)
}

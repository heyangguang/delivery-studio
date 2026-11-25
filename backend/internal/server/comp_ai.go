package server

import (
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// The assistant in the component workbench. It reads the draft, the design guide and the other components, proposes
// changes to the draft's files, and the platform checks every proposal (static checks, trial generation, ansible
// syntax) before the person sees it. Accepting a proposal writes it into the draft only; publishing stays a separate,
// manual step.


type compPropFile struct {
	Path    string `json:"path"`
	Op      string `json:"op"` // add | change | delete
	Content string `json:"content,omitempty"`
	Diff    string `json:"diff,omitempty"`
}

type compProposal struct {
	BaseDigest string         `json:"base_digest,omitempty"`
	ID         string         `json:"id"`
	Summary    string         `json:"summary"`
	Files      []compPropFile `json:"files"`
	Warnings   []string       `json:"warnings,omitempty"` // findings that remain after the change; none of them is new
	Trial      string         `json:"trial,omitempty"`    // what trial generation showed
	Status     string         `json:"status"`
	At         string         `json:"at"`
	DecidedBy  string         `json:"decided_by,omitempty"`
}

func (s *storeServer) compAIDir(name string) string {
	return filepath.Join(s.cfg.DataDir, "ai-comp", name)
}

// compHistory is a finished stretch of the assistant's work on a component: its conversation, its proposals and the
// pictures. A draft is one piece of work, so the next one starts with a clean conversation; the old one is kept here,
// with how it ended, because if a change turns out wrong the way back to why it was made is in that conversation.
type compHistory struct {
	ID       string `json:"id"`
	At       string `json:"at"`
	Label    string `json:"label"` // how it ended: published as revision N, draft discarded, cleared by hand
	Rev      int    `json:"rev,omitempty"`
	Title    string `json:"title"`
	Messages int    `json:"messages"`
	Accepted int    `json:"accepted"`
}

func (s *storeServer) compHistoryDir(name string) string {
	return filepath.Join(s.compAIDir(name), "history")
}

// archiveCompAI files the current conversation of a component away and starts clean. A conversation with nothing in it is
// simply dropped. The change awaiting confirmation does not outlive its draft.
func (s *storeServer) archiveCompAI(name, label string, rev int) {
	dir := s.compAIDir(name)
	_ = os.Remove(filepath.Join(dir, "review.json"))
	ss := aiSession{}
	if b, err := os.ReadFile(filepath.Join(dir, "session.json")); err == nil {
		_ = json.Unmarshal(b, &ss)
	}
	if len(ss.Messages) == 0 {
		_ = os.Remove(filepath.Join(dir, "session.json"))
		_ = os.Remove(filepath.Join(dir, "proposals.json"))
		_ = os.RemoveAll(filepath.Join(dir, "img"))
		return
	}
	id := time.Now().UTC().Format("20060102-150405")
	to := filepath.Join(s.compHistoryDir(name), id)
	if os.MkdirAll(to, 0o700) != nil {
		return
	}
	for _, f := range []string{"session.json", "proposals.json", "img"} {
		_ = os.Rename(filepath.Join(dir, f), filepath.Join(to, f))
	}
	title := ""
	for _, m := range ss.Messages {
		if m.Role == "user" && strings.TrimSpace(m.Text) != "" {
			title = truncRunes(strings.Join(strings.Fields(m.Text), " "), 60)
			break
		}
	}
	accepted := 0
	if b, err := os.ReadFile(filepath.Join(to, "proposals.json")); err == nil {
		var ps []compProposal
		if json.Unmarshal(b, &ps) == nil {
			for _, p := range ps {
				if p.Status == "accepted" {
					accepted++
				}
			}
		}
	}
	_ = writeJSONFile(filepath.Join(to, "meta.json"), compHistory{ID: id, At: now(), Label: label, Rev: rev, Title: title, Messages: len(ss.Messages), Accepted: accepted})
}

func (s *storeServer) listCompHistory(name string) []compHistory {
	out := []compHistory{}
	entries, _ := os.ReadDir(s.compHistoryDir(name))
	for i := len(entries) - 1; i >= 0; i-- {
		var h compHistory
		if b, err := os.ReadFile(filepath.Join(s.compHistoryDir(name), entries[i].Name(), "meta.json")); err == nil && json.Unmarshal(b, &h) == nil {
			out = append(out, h)
		}
	}
	return out
}

// compReview is the assistant's accepted changes still waiting for the person's confirmation: each file as it was
// before the first accepted proposal touched it (nil: the file did not exist).
type compReview struct {
	Before    map[string]*string `json:"before"`
	Proposals []string           `json:"proposals,omitempty"`
	At        string             `json:"at,omitempty"`
}

func (s *storeServer) loadCompReview(name string) compReview {
	var rv compReview
	if b, err := os.ReadFile(filepath.Join(s.compAIDir(name), "review.json")); err == nil {
		_ = json.Unmarshal(b, &rv)
	}
	return rv
}

func (s *storeServer) loadCompProposals(name string) []compProposal {
	out := []compProposal{}
	if b, err := os.ReadFile(filepath.Join(s.compAIDir(name), "proposals.json")); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

func (s *storeServer) saveCompProposals(name string, all []compProposal) error {
	return writeJSONFile(filepath.Join(s.compAIDir(name), "proposals.json"), all)
}

// ---- the guide, by section ----

var reHeading = regexp.MustCompile(`^(#{2,3}) (\d+(?:\.\d+)*)\.? ?(.*)$`)

func guideSections() (index []string, body map[string]string) {
	body = map[string]string{}
	var cur string
	for _, l := range strings.Split(componentGuide, "\n") {
		if m := reHeading.FindStringSubmatch(l); m != nil {
			cur = m[2]
			index = append(index, cur+" "+m[3])
			body[cur] = l + "\n"
			continue
		}
		if cur != "" {
			body[cur] += l + "\n"
		}
	}
	return
}

// ---- tools ----

type compToolCtx struct {
	s        *storeServer
	name     string
	proposed *[]string
}

func compTools() []aiToolDef {
	obj := func(props map[string]any, req ...string) map[string]any {
		return map[string]any{"type": "object", "properties": props, "required": req}
	}
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	defs := []aiToolDef{
		{"component_guide", "平台的组件设计说明。不带参数返回章节目录；带章节号（如 4.2、16.11）返回该章节及其子章节的正文。写组件前先读相关章节：清单结构 4.1、参数 4.2、生命周期 4.4、测试 4.5、变更步骤 16.11、步骤独立性 17、输入与结果契约 17.1。", obj(map[string]any{"section": str("章节号，如 4.1；省略则列目录")})},
		{"list_components", "列出平台上已有的组件，可以拿来参考。", obj(map[string]any{})},
		{"example_component", "读取另一个组件的文件作为示例：不带 path 列出文件，带 path 读取内容（一次约 24 KiB，长文件用 from_line 继续）。", obj(map[string]any{"name": str("组件名，如 etcd、postgresql"), "path": str("文件路径，省略则列出"), "from_line": map[string]any{"type": "integer", "description": "长文件从第几行继续读"}}, "name")},
		{"draft_files", "列出当前草稿的全部文件。", obj(map[string]any{})},
		{"draft_read", "读取草稿里的一个文件。文件较长时一次只返回前一部分，并告诉你下一段从第几行开始；用 from_line 继续往后读，直到读完再下结论。", obj(map[string]any{"path": str("文件路径"), "from_line": map[string]any{"type": "integer", "description": "从第几行开始读（默认 1）"}}, "path")},
		{"draft_search", "在草稿的所有文件里查找文字（不区分大小写），返回文件、行号和那一行。找某个字段、参数或任务在哪里，用它比通读文件快。", obj(map[string]any{"text": str("要查找的文字")}, "text")},
		{"run_check", "对当前草稿运行平台检查（清单结构、参数、任务文件、模板、包引用等），返回问题列表。", obj(map[string]any{})},
		{"propose_files", "提议修改草稿：给出要新增、修改（整文件替换）或删除的文件。平台会在副本上先做检查、试生成和语法检查，有新的错误就退回，让你修好再提交；通过后交给用户确认，用户采纳才写入草稿。每次提案要自成一体，能通过检查。", obj(map[string]any{
			"summary": str("这次改动做什么，一两句"),
			"files": map[string]any{"type": "array", "items": obj(map[string]any{
				"path":    str("文件路径：component.yaml，或 manifest/、roles/、templates/、files/ 下的文件"),
				"content": str("完整的新内容（新增文件，或要整个重写时用）"),
				"edits":   map[string]any{"type": "array", "description": "对已有文件做局部修改，优先用它：每项是 {old, new}，old 必须是文件里恰好出现一次的原文（带上足够的上下文），new 是替换后的内容。改长文件（如 component.yaml）不要整文件替换。", "items": obj(map[string]any{"old": str("文件里恰好出现一次的原文"), "new": str("替换成的内容")}, "old", "new")},
				"delete":  map[string]any{"type": "boolean", "description": "为 true 表示删除这个文件"},
			}, "path")},
		}, "summary", "files")},
	}
	defs = append(defs, aiToolDef{"platform_files", "读取平台公共角色、参数契约和实际传参示例。不带path列文件；view可选live或draft；path=generated/inventory/group_vars/all.yml读取当前组件试生成的实际参数，默认以redis为示例。", obj(map[string]any{"path": str("文件路径"), "view": str("live（默认）或draft"), "from_line": map[string]any{"type": "integer"}})})
	proposal := defs[len(defs)-2]
	proposal.Name = "propose_platform_files"
	proposal.Description = "为平台公共流程提出修改：与propose_files相同的summary/files参数。修改先进入公共流程提案，不改当前组件，不直接发布。返回工作台链接，必须提供给用户审核采纳。新增机器参数在manifest/host-parameters.yaml声明，使用hosts[].params传值。"
	defs = append(defs, proposal)

	defs = append(defs,
		aiToolDef{"workspace_search", "跨公共流程及所有组件搜索文本，返回组件/文件/行号。view=live或draft，draft仅已有草稿；offset分页，每页50条。", obj(map[string]any{"text": str("搜索文本，例如 /data 或 params.storage_mode"), "view": str("live或draft"), "offset": map[string]any{"type": "integer"}}, "text", "view")},
		aiToolDef{"component_files", "读取指定组件或platform-shared的live或draft文件。省略path列出文件；不自动回退版本。", obj(map[string]any{"name": str("目标组件"), "view": str("live或draft"), "path": str("文件路径"), "from_line": map[string]any{"type": "integer"}}, "name", "view")},
		aiToolDef{"check_workspace", "联合检查明确选择的草稿与其他已发布组件，执行静态校验和各方案试生成。未采纳提案不在草稿中。不会发布或部署。", obj(map[string]any{"names": map[string]any{"type": "array", "items": str("草稿组件名")}}, "names")},
	)
	cross := proposal
	cross.Name = "propose_component_files"
	cross.Description = "向指定关联组件提交修改提案（含platform-shared）；同propose_files，额外必填name。保留已有草稿，采纳和发布仍由用户决定。必须提供返回的审核链接。"
	props := map[string]any{}
	for k, v := range proposal.Parameters["properties"].(map[string]any) {
		props[k] = v
	}
	props["name"] = str("目标组件名")
	cross.Parameters = obj(props, "name", "summary", "files")
	defs = append(defs, cross)
	return defs

}

// readRange returns a file from a line on, as much as fits, and says where to continue.
func readRange(text string, a map[string]any) string {
	lines := strings.Split(text, "\n")
	from := 1
	if f, ok := a["from_line"].(float64); ok && f >= 1 {
		from = int(f)
	}
	if from > len(lines) {
		return fmt.Sprintf("文件只有 %d 行。", len(lines))
	}
	var sb strings.Builder
	n := from
	for ; n <= len(lines) && sb.Len()+len(lines[n-1]) < aiMaxResult-600; n++ {
		sb.WriteString(lines[n-1])
		sb.WriteString("\n")
	}
	out := sb.String()
	if n <= len(lines) {
		out += fmt.Sprintf("\n…（文件共 %d 行，这里是第 %d～%d 行；继续读请设 from_line=%d）", len(lines), from, n-1, n)
	}
	return out
}

func problemsText(c *compCheck, only func(compProblem) bool) string {
	var b strings.Builder
	n := 0
	for _, p := range c.Problems {
		if only != nil && !only(p) {
			continue
		}
		if n++; n > 25 {
			b.WriteString("…（其余省略）\n")
			break
		}
		loc := p.File
		if p.Line > 0 {
			loc += fmt.Sprintf(":%d", p.Line)
		}
		if loc == "" {
			loc = p.Path
		}
		fmt.Fprintf(&b, "- [%s] %s %s\n", map[string]string{"error": "错误", "warning": "提示"}[p.Severity], loc, p.Message)
	}
	return b.String()
}

func problemKey(p compProblem) string {
	return p.Severity + "|" + p.File + "|" + p.Path + "|" + p.Message
}

func (c compToolCtx) run(tool, args string) string {
	var a map[string]any
	_ = json.Unmarshal([]byte(args), &a)
	str := func(k string) string { v, _ := a[k].(string); return strings.TrimSpace(v) }
	s, name := c.s, c.name
	set, _, err := s.comps().readDraft(name)
	if err != nil && tool != "component_guide" && tool != "list_components" && tool != "example_component" && tool != "platform_files" && tool != "component_files" && tool != "workspace_search" && tool != "check_workspace" && tool != "propose_component_files" {
		return "还没有草稿，请先在工作台里创建草稿。"
	}
	var out string
	switch tool {
	case "component_files":
		files, e := c.targetFiles(str("name"), str("view"))
		if e != nil {
			return e.Error()
		}
		if str("path") == "" {
			return strings.Join(files.paths(), "\n")
		}
		b, ok := files[str("path")]
		if !ok || !isText(b) {
			return "文件不存在或不是文本"
		}
		return readRange(string(b), a)
	case "workspace_search":
		if str("view") != "live" && str("view") != "draft" {
			return "view 必须为 live 或 draft"
		}
		offset, _ := a["offset"].(float64)
		return c.searchWorkspace(str("text"), str("view"), int(offset))
	case "propose_component_files":
		return c.proposeTarget(str("name"), a)
	case "check_workspace":
		raw, _ := a["names"].([]any)
		names := []string{}
		for _, v := range raw {
			n, _ := v.(string)
			names = append(names, n)
		}
		result, _ := json.Marshal(s.crossCheck(names))
		return string(result)
	case "platform_files":
		shared, _, e := s.comps().liveSet(sharedPlatformName)
		if str("view") == "draft" {
			shared, _, e = s.comps().readDraft(sharedPlatformName)
		}
		if e != nil {
			return "公共流程草稿不存在；可读取live版本。"
		}
		path := str("path")
		if strings.HasPrefix(path, "generated/") {
			app := name
			if _, ok := s.plat.cat().Get(app); !ok {
				app = "redis"
			}
			b, _, _, e := renderSample(sharedCatalog(s.plat, shared), app, previewReq{})
			if e != nil {
				return "试生成失败：" + e.Error()
			}
			if f, ok := b.Project[strings.TrimPrefix(path, "generated/")]; ok {
				return readRange(string(f.Data), a)
			}
			return "没有此生成文件；可读取generated/inventory/group_vars/all.yml和generated/inventory/hosts.yml。"
		}
		if path == "" {
			return "平台公共流程（" + str("view") + "，空值为live）：\n" + strings.Join(shared.paths(), "\n") + "\n实际传参：generated/inventory/group_vars/all.yml\n手动入口：#/components/platform-shared/edit/files"
		}
		if b, ok := shared[path]; ok {
			return readRange(string(b), a)
		}
		return "没有此公共流程文件。"
	case "propose_platform_files":
		compMu.Lock()
		cs := s.comps()
		shared, _, e := cs.readDraft(sharedPlatformName)
		if e != nil {
			shared, _, e = cs.liveSet(sharedPlatformName)
			if e == nil {
				e = cs.writeDraft(sharedPlatformName, shared, draftMeta{Source: "live", BaseRev: cs.liveRev(sharedPlatformName), Created: now(), Updated: now(), User: "AI提案"})
			}
		}
		compMu.Unlock()
		if e != nil {
			return "无法准备公共流程草稿：" + e.Error()
		}
		ids := []string{}
		target := compToolCtx{s: s, name: sharedPlatformName, proposed: &ids}
		result := target.propose(shared, a)
		if len(ids) > 0 {
			aiMu.Lock()
			sessionPath := filepath.Join(s.compAIDir(sharedPlatformName), "session.json")
			session := aiSession{Messages: []aiMsg{}}
			if b, e := os.ReadFile(sessionPath); e == nil {
				_ = json.Unmarshal(b, &session)
			}
			session.Messages = append(session.Messages, aiMsg{Role: "assistant", Text: "来自组件「" + name + "」的公共流程修改提案。采纳只更新公共流程草稿，发布仍需单独确认。", Proposals: ids, At: now()})
			e = writeJSONFile(sessionPath, session)
			aiMu.Unlock()
			if e != nil {
				return "提案已保存，但展示记录写入失败，请重试：" + e.Error()
			}
			result += "\n请向用户提供：[审核平台公共流程提案](#/components/platform-shared/edit/files)。该提案独立于当前组件，未采纳、未发布。"
		}
		return result
	case "component_guide":
		index, body := guideSections()
		sec := strings.TrimSuffix(str("section"), ".")
		if sec == "" {
			out = "章节目录：\n" + strings.Join(index, "\n")
			break
		}
		var b strings.Builder
		for _, h := range index {
			num := strings.SplitN(h, " ", 2)[0]
			if num == sec || strings.HasPrefix(num, sec+".") {
				b.WriteString(body[num])
			}
		}
		out = b.String()
		if out == "" {
			out = "没有这个章节，先不带参数调用查看目录。"
		}
	case "list_components":
		var lines []string
		for _, e := range s.plat.entriesWith(true) {
			lines = append(lines, fmt.Sprintf("%s — %s（%s）", e.Name, e.Title, e.Kind))
		}
		out = strings.Join(lines, "\n")
	case "example_component":
		ex, _, e := s.comps().liveSet(str("name"))
		if e != nil {
			out = "没有这个组件。"
			break
		}
		if p := str("path"); p != "" {
			b, ok := ex[p]
			if !ok || !isText(b) {
				out = "文件不存在或不是文本。"
				break
			}
			out = readRange(string(b), a)
			break
		}
		out = strings.Join(ex.paths(), "\n")
	case "draft_files":
		var lines []string
		for _, p := range set.paths() {
			lines = append(lines, fmt.Sprintf("%s (%d)", p, len(set[p])))
		}
		out = strings.Join(lines, "\n")
	case "draft_read":
		b, ok := set[str("path")]
		if !ok || !isText(b) {
			out = "文件不存在或不是文本。"
			break
		}
		out = readRange(string(b), a)
	case "draft_search":
		q := strings.ToLower(str("text"))
		if q == "" {
			out = "要查找的文字不能为空。"
			break
		}
		var hits []string
		for _, p := range set.paths() {
			if !isText(set[p]) {
				continue
			}
			for i, l := range strings.Split(string(set[p]), "\n") {
				if strings.Contains(strings.ToLower(l), q) {
					if hits = append(hits, fmt.Sprintf("%s:%d: %s", p, i+1, truncRunes(strings.TrimSpace(l), 160))); len(hits) >= 60 {
						break
					}
				}
			}
		}
		out = strings.Join(hits, "\n")
		if out == "" {
			out = "没有找到。"
		}
	case "run_check":
		out = problemsText(checkComponent(s.plat, name, set), nil)
		if out == "" {
			out = "检查通过，没有问题。"
		}
	case "propose_files":
		out = c.propose(set, a)
	default:
		out = "没有这个工具"
	}
	if len(out) > aiMaxResult {
		out = out[:aiMaxResult] + "\n…（结果过长，已截断）"
	}
	return out
}

func (c compToolCtx) propose(draft fileSet, a map[string]any) string {
	summary, _ := a["summary"].(string)
	raw, _ := a["files"].([]any)
	if strings.TrimSpace(summary) == "" || len(raw) == 0 || len(raw) > 40 {
		return "summary 必填，files 需要 1～40 个文件。"
	}
	cand := draft.clone()
	var files []compPropFile
	deleted := map[string]bool{}
	manifestIdx := -1
	for _, x := range raw {
		m, _ := x.(map[string]any)
		path, _ := m["path"].(string)
		path = strings.TrimSpace(path)
		del, _ := m["delete"].(bool)
		content, hasContent := m["content"].(string)
		if edits, _ := m["edits"].([]any); len(edits) > 0 && !del {
			old, ok := draft[path]
			if !ok {
				return "要局部修改的文件不存在：" + path + "（新增文件请用 content）。"
			}
			cur := string(old)
			for i, e := range edits {
				em, _ := e.(map[string]any)
				o, _ := em["old"].(string)
				n, _ := em["new"].(string)
				if o == "" {
					return fmt.Sprintf("%s 的第 %d 处修改缺少 old。", path, i+1)
				}
				if k := strings.Count(cur, o); k != 1 {
					return fmt.Sprintf("%s 的第 %d 处修改：old 在文件里出现了 %d 次，必须恰好一次。请带上更多上下文，或先用 draft_read / draft_search 确认原文。", path, i+1, k)
				}
				cur = strings.Replace(cur, o, n, 1)
			}
			content, hasContent = cur, true
		}
		if del {
			if path == "component.yaml" {
				return "component.yaml 不能删除。"
			}
			if _, ok := cand[path]; !ok {
				return "要删除的文件不存在：" + path
			}
			delete(cand, path)
			deleted[path] = true
			files = append(files, compPropFile{Path: path, Op: "delete", Diff: lineDiff(string(draft[path]), "", 200)})
			continue
		}
		if !hasContent {
			return "文件 " + path + " 缺少 content（要删除请设 delete: true）。"
		}
		if err := validFilePath(path); err != nil {
			return err.Error()
		}
		if reKeyBlock.MatchString(content) || reSkKey.MatchString(content) {
			return "文件 " + path + " 里含有私钥或令牌，不能写进组件。密码应由平台的 secrets 机制在部署时生成。"
		}
		op := "add"
		if _, ok := draft[path]; ok {
			op = "change"
		}
		cand[path] = []byte(content)
		if path == "component.yaml" {
			manifestIdx = len(files)
		}
		files = append(files, compPropFile{Path: path, Op: op, Content: content, Diff: lineDiff(string(draft[path]), content, 200)})
	}
	if syncSharedFiles(cand, nil, deleted) {
		after := string(cand["component.yaml"])
		entry := compPropFile{Path: "component.yaml", Op: "change", Content: after, Diff: lineDiff(string(draft["component.yaml"]), after, 200)}
		if manifestIdx >= 0 {
			files[manifestIdx] = entry
		} else {
			files = append(files, entry)
		}
	}
	if err := cand.check(); err != nil {
		return "文件集不合规：" + err.Error()
	}
	before := checkComponent(c.s.plat, c.name, draft)
	known := map[string]bool{}
	for _, p := range before.Problems {
		known[problemKey(p)] = true
	}
	after := checkComponent(c.s.plat, c.name, cand)
	isNew := func(p compProblem) bool { return p.Severity == "error" && !known[problemKey(p)] }
	if txt := problemsText(after, isNew); txt != "" {
		return "提案没有通过平台检查，没有保存。这次改动带来了新的错误：\n" + txt + "请修正后重新调用 propose_files（要给出完整的新内容）。"
	}
	var trial []string
	if after.Errors == 0 {
		resp := previewComponent(c.s.plat, c.s.ansible(), c.name, cand, nil, previewReq{})
		switch {
		case resp.Error != "":
			return "检查通过，但试生成失败，没有保存：" + resp.Error + "\n请修正后重新提交。"
		default:
			for _, sx := range resp.Syntax {
				if !sx.OK {
					return "试生成的 playbook 语法检查失败，没有保存：" + sx.Playbook + "\n" + trimOutput(sx.Output) + "\n请修正后重新提交。"
				}
			}
			trial = append(trial, fmt.Sprintf("试生成成功，生成 %d 个文件", len(resp.Files)))
			if len(resp.Syntax) > 0 {
				trial = append(trial, fmt.Sprintf("%d 个 playbook 语法检查通过", len(resp.Syntax)))
			}
		}
	}
	p := compProposal{BaseDigest: compDraftDigest(draft), ID: randomStoreToken(6), Summary: strings.TrimSpace(summary), Files: files, Status: "pending", At: time.Now().UTC().Format(time.RFC3339), Trial: strings.Join(trial, "；")}
	for _, pr := range after.Problems {
		p.Warnings = append(p.Warnings, strings.TrimSpace(problemsText(&compCheck{Problems: []compProblem{pr}}, nil)))
	}
	if len(p.Warnings) > 8 {
		p.Warnings = p.Warnings[:8]
	}
	aiMu.Lock()
	defer aiMu.Unlock()
	all := c.s.loadCompProposals(c.name)
	all = append(all, p)
	if err := c.s.saveCompProposals(c.name, all); err != nil {
		return "提案无法保存"
	}
	*c.proposed = append(*c.proposed, p.ID)
	return "提案 #" + p.ID + " 已通过平台检查并提交，等待用户确认，尚未写入草稿。" + func() string {
		if len(p.Warnings) > 0 {
			return fmt.Sprintf("检查后仍有 %d 条提示或原有问题，请在回答里说明。", len(p.Warnings))
		}
		return ""
	}() + "请用一两句话向用户说明改了什么，并告诉他可以在卡片上采纳或拒绝。"
}

// ---- API ----

const compSystem = `你是 Kyndryl Delivery Studio 组件工作台里的助手，帮管理员起草、修改、评审组件。
平台本身不认识任何具体中间件，一切都写在组件里：component.yaml（清单：版本、参数、角色、端点、生命周期、测试、变更步骤）使用 {$file: manifest/...yaml} 引用独立方案、参数和动作清单；加上 roles/、templates/、files/ 下的 Ansible 任务和模板。
工作方式：
- 跨组件任务使用 workspace_search 查全引用、component_files 读指定版本、propose_component_files 向关联工作台提案；采纳后用 check_workspace 联合检查明确列出的草稿。提供所有审核链接，不能声称当前页面限制了修改目标。检查通过不是现场验收；不同组件仍分别审核发布，必须使用兼容默认值并说明发布顺序。
- 先看再写：用 component_guide 读相关章节，用 list_components / example_component 看现成组件怎么写，用 draft_files / draft_read 看当前草稿，用 run_check 看现有问题。不要凭记忆编字段名。
- 读文件要读全：draft_read 对长文件会分段返回，按提示用 from_line 继续读完再下结论；找某个字段在哪里用 draft_search。不要因为只读到了前半段就放弃，更不要凭没读到的部分猜。
- 清单可能通过 $file 引用 manifest/ 下的公共定义和独立方案。先沿引用读取所属文件，仅修改该片段；不要将片段重新内联进入口。新增片段与入口引用须在同一提案中提交。
- 改已有的文件（尤其是 component.yaml 这种长文件）用 propose_files 里的 edits 做局部替换，不要整文件重写；新增文件才用 content。
- 要改草稿时调用 propose_files，一次给出自成一体的改动（新增、局部修改、删除）。平台会检查并试生成；有新错误会退回，按提示修好再提交。通过后用户确认才写入草稿，发布仍由用户在工作台手动完成。
- 任务文件要幂等，能重复执行；会改系统的步骤要有对应的检查；不要在文件里写死口令或密钥，密码交给平台的 secrets 机制。
- 每个步骤使用稳定 ID 和独立业务文件，修改 A 不应改变无关的 B/C。平台校验文件归属：多个步骤共用的任务、脚本、模板必须在组件顶层 shared_files 用精确路径声明。优先拆分业务实现；只把公共工具声明共享，不用共享声明掩盖大脚本耦合。规则见指南 17、17.1。步骤输入用 inputs 的 {type,value} 契约，通过 mw_step_inputs 读取；用 preconditions/postconditions 检查执行条件和结果。同步验证必须确认私有变更只命中对应步骤，共享变更只命中使用者；没有验证不能声称验证通过。
- 涉及公共预检、数据盘、软件源、软件安装或密钥流程时，先用 platform_files 读角色、files/platform-contract.md 和 generated/inventory/group_vars/all.yml；不要声称只能看到当前组件。公共流程用 propose_platform_files 提案，向用户提供返回的审核链接；组件修改仍用 propose_files。新增公共机器参数可在 manifest/host-parameters.yaml 定义，使用参数与规则契约；前端、校验和传参自动消费。先读取该文件和 files/platform-contract.md，参数与使用它的公共角色在同一提案中提交；组件任务另外提案。不要新增未声明的Host顶层字段。
- 只能使用平台已提供的通用任务和变量（读指南确认），不要发明不存在的模块或变量。
- 评审或解释类的问题，直接用文字回答，不必提案；指出风险时说明具体在哪个文件哪一处。
- 用户问某条检查提示（警告）怎么办：如果判断它只是静态检查的局限、对这个组件没有实际影响，就明说“可以忽略”，并告诉他在「检查结果」或文件页下方那条提示后点「忽略」，以后就不再提醒；不要为了消除提示去改写原本正确的写法。真有问题才提案。
- 回答用中文，简洁。思考和推理摘要也用中文。提案之后用一两句话说明改了什么、有什么需要用户留意的。`

func (s *storeServer) handleCompAI(w http.ResponseWriter, r *http.Request, user storeSession, name string, parts []string) {
	switch {
	case len(parts) == 1 && parts[0] == "session" && r.Method == "GET":
		ss := aiSession{Messages: []aiMsg{}}
		if b, err := os.ReadFile(filepath.Join(s.compAIDir(name), "session.json")); err == nil {
			_ = json.Unmarshal(b, &ss)
		}
		s.writeJSON(w, 200, map[string]any{
			"messages":  ss.Messages,
			"proposals": s.loadCompProposals(name),
			"has_draft": s.plat.componentsDir != "" && s.comps().hasDraft(name),
		})
	case len(parts) == 1 && parts[0] == "session" && r.Method == "DELETE":
		s.archiveCompAI(name, "手动清空", 0)
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case len(parts) == 1 && parts[0] == "history" && r.Method == "GET":
		s.writeJSON(w, 200, map[string]any{"history": s.listCompHistory(name)})
	case len(parts) >= 2 && parts[0] == "history" && regexp.MustCompile(`^[0-9]{8}-[0-9]{6}$`).MatchString(parts[1]) && r.Method == "GET":
		dir := filepath.Join(s.compHistoryDir(name), parts[1])
		if len(parts) == 4 && parts[2] == "img" {
			b, err := os.ReadFile(filepath.Join(dir, "img", filepath.Base(parts[3])))
			if err != nil {
				s.fail(w, 404, "图片不存在")
				return
			}
			w.Header().Set("Content-Type", http.DetectContentType(b))
			w.Header().Set("X-Content-Type-Options", "nosniff")
			_, _ = w.Write(b)
			return
		}
		ss := aiSession{Messages: []aiMsg{}}
		if b, err := os.ReadFile(filepath.Join(dir, "session.json")); err == nil {
			_ = json.Unmarshal(b, &ss)
		}
		props := []compProposal{}
		if b, err := os.ReadFile(filepath.Join(dir, "proposals.json")); err == nil {
			_ = json.Unmarshal(b, &props)
		}
		var h compHistory
		if b, err := os.ReadFile(filepath.Join(dir, "meta.json")); err == nil {
			_ = json.Unmarshal(b, &h)
		}
		s.writeJSON(w, 200, map[string]any{"meta": h, "messages": ss.Messages, "proposals": props})
	case len(parts) == 1 && parts[0] == "chat" && r.Method == "POST":
		s.compChat(w, r, user, name)
	case len(parts) == 2 && parts[0] == "img" && r.Method == "GET":
		b, err := os.ReadFile(filepath.Join(s.compAIDir(name), "img", filepath.Base(parts[1])))
		if err != nil {
			s.fail(w, 404, "图片不存在")
			return
		}
		w.Header().Set("Content-Type", http.DetectContentType(b))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(b)
	case len(parts) == 1 && parts[0] == "review" && r.Method == "GET":
		s.writeJSON(w, 200, s.loadCompReview(name))
	case len(parts) == 1 && parts[0] == "review" && r.Method == "DELETE":
		_ = os.Remove(filepath.Join(s.compAIDir(name), "review.json"))
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case len(parts) == 3 && parts[0] == "proposals" && r.Method == "POST" && (parts[2] == "accept" || parts[2] == "reject"):
		s.compDecide(w, r, user, name, parts[1], parts[2] == "accept")
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) compChat(w http.ResponseWriter, r *http.Request, user storeSession, name string) {
	var in struct {
		Message string `json:"message"`
		Model   string `json:"model"`
		Options aiOpts `json:"options"`
		// Images are pictures (data URLs) pasted or dropped into the conversation: a screenshot of an error, of a
		// manual, of the page the component is about.
		Images []string `json:"images"`
		// Retry asks again the question that was saved but not answered (the answer broke off): it is not added twice.
		Retry bool `json:"retry"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 20<<20)).Decode(&in) != nil || (strings.TrimSpace(in.Message) == "" && len(in.Images) == 0) || len([]rune(in.Message)) > 20000 || len(in.Images) > 3 {
		s.fail(w, 400, "请输入内容，或附上图片（一次最多 3 张）")
		return
	}
	if !s.comps().hasDraft(name) {
		s.fail(w, 409, "这个组件还没有草稿，先在工作台里开始编辑")
		return
	}
	if code, msg := s.checkAIFeature(user.User, "component"); code != 0 {
		s.fail(w, code, msg)
		return
	}
	st := s.aiLoad()
	providers := s.aiProvidersForUser(st, user.User, "component", in.Model)
	if len(providers) == 0 {
		s.fail(w, 409, "没有可用的模型供应商，请在平台设置 → AI 中配置")
		return
	}
	if st.MonthlyLimit > 0 && s.aiCallsThisMonth(user.User) >= st.MonthlyLimit {
		s.fail(w, 429, "本月 AI 使用次数已达上限")
		return
	}
	if providers[0].Tools == "no" {
		s.fail(w, 409, "当前模型不支持工具调用，无法在组件工作台使用 AI，请管理员换一个支持工具调用的模型")
		return
	}
	if len(in.Images) > 0 && providers[0].Vision == "no" {
		s.fail(w, 409, "当前模型不支持看图，请改贴文字，或让管理员换一个支持看图的模型")
		return
	}
	var imgNames []string
	for _, d := range in.Images {
		n, err := s.aiStoreImageIn(s.compAIDir(name), d)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		imgNames = append(imgNames, n)
	}
	path := filepath.Join(s.compAIDir(name), "session.json")
	ss := aiSession{Messages: []aiMsg{}}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &ss)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	ask := strings.TrimSpace(in.Message)
	ss.Messages = appendOrReuseUserTurn(ss.Messages, in.Retry, aiMsg{Role: "user", Text: ask, Images: imgNames, At: now, By: user.User})
	// the question is kept before anything else happens: if the answer breaks off (a restart, the network), the
	// conversation still shows what was asked, and it can be asked again
	if err := writeJSONFile(path, ss); err != nil {
		s.fail(w, 500, "对话无法保存")
		return
	}
	s.auditReq(r, "ai-chat", user.User, "组件 "+name)
	fl, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ev := sse{w, fl}

	in.Options.User = user.User
	in.Options.Made = &producedFiles{}
	in.Options.Workspace = s.componentWorkspaceSpec(name)
	ext := s.extFor("component", in.Options)
	hist := ss.Messages
	if len(hist) > 24 {
		hist = hist[len(hist)-24:]
	}
	build := func(p aiProvider) []aiMessage {
		msgs := []aiMessage{{Role: "system", Content: compSystem + "\n当前组件：" + name + s.skillBlock(user.User, "component-authoring") + ext.prompt}}
		for i, m := range hist {
			if isErrorOnlyMsg(m) {
				continue
			}
			text := aiScrub(m.Text + m.askText())
			// only the last few pictures are re-sent; earlier ones were already described in the answers
			if len(m.Images) > 0 && p.Vision != "no" && i >= len(hist)-3 {
				parts := []map[string]any{{"type": "text", "text": text}}
				for _, n := range m.Images {
					if b, err := os.ReadFile(filepath.Join(s.compAIDir(name), "img", filepath.Base(n))); err == nil {
						parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:" + http.DetectContentType(b) + ";base64," + base64.StdEncoding.EncodeToString(b)}})
					}
				}
				msgs = append(msgs, aiMessage{Role: m.Role, Content: parts})
				continue
			}
			if len(m.Images) > 0 {
				text += "\n（附带 " + fmt.Sprint(len(m.Images)) + " 张截图）"
			}
			msgs = append(msgs, aiMessage{Role: m.Role, Content: text})
		}
		return msgs
	}
	var final aiReply
	var used, made []string
	var lastErr error
	var tried aiProvider
	var failedAttempts []aiAttemptDiag
	for i, p := range providers {
		tried = p
		start := time.Now()
		var got []string
		tc := compToolCtx{s: s, name: name, proposed: &got}
		tools := append(compTools(), ext.tools...)
		turnCtx := ext.bindCtx(effortCtx(r.Context(), in.Options), ev)
		reply, tl, err := s.aiToolLoop(turnCtx, p, build(p), tools, nil, ev, ext.wrap(tc.run), &got)
		u := usageFrom(p, reply)
		u.User, u.IP, u.Feature, u.Job, u.Target, u.Session, u.Tools = user.User, clientIP(r), "component", name, name, "comp", len(tl)
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
			final, used, made, lastErr = reply, tl, got, nil
			break
		}
		lastErr = err
		if r.Context().Err() != nil {
			return
		}
		if i+1 < len(providers) {
			ev.send(map[string]any{"t": "notice", "v": tr(reqLang(r), "「"+p.Name+" · "+p.Model+"」失败，改用备用模型", "\""+p.Name+" · "+p.Model+"\" failed; switching to backup model")})
		}
	}
	if lastErr != nil {
		errText := localizeGoMessage(reqLang(r), lastErr.Error())
		errDiag := buildChatErrorDiag(lastErr, failedAttempts, tried)
		ss.Messages = append(ss.Messages, aiMsg{Role: "assistant", Error: errText, ErrorDiag: errDiag, At: time.Now().UTC().Format(time.RFC3339)})
		saved := writeJSONFile(path, ss) == nil
		errPayload := map[string]any{"t": "error", "v": errText, "saved": saved}
		if errDiag != nil {
			errPayload["diag"] = errDiag
		}
		ev.send(errPayload)
		return
	}
	ss.Messages = append(ss.Messages, aiMsg{Role: "assistant", Text: final.Text, Tools: used, Steps: final.Steps, MS: final.TotalMS, Proposals: made, Ask: final.Ask, Files: final.Files, At: time.Now().UTC().Format(time.RFC3339)})
	if err := writeJSONFile(path, ss); err != nil {
		ev.send(map[string]any{"t": "error", "v": tr(reqLang(r), "对话无法保存", "Failed to save conversation")})
		return
	}
	s.learnLater(user.User, in.Message, final.Text)
	ev.send(map[string]any{"t": "done", "model": tried.Model, "in": final.In, "out": final.Out})
}

func (s *storeServer) compDecide(w http.ResponseWriter, r *http.Request, user storeSession, name, id string, accept bool) {
	compMu.Lock()
	defer compMu.Unlock()
	aiMu.Lock()
	defer aiMu.Unlock()
	all := s.loadCompProposals(name)
	idx := -1
	for i := range all {
		if all[i].ID == id {
			idx = i
		}
	}
	if idx < 0 || all[idx].Status != "pending" {
		s.fail(w, 409, "提案不存在，或已经处理过")
		return
	}
	p := all[idx]
	if accept {
		set, meta, err := s.comps().readDraft(name)
		if err != nil {
			s.fail(w, 409, "草稿已经不存在")
			return
		}
		if p.BaseDigest != "" && p.BaseDigest != compDraftDigest(set) {
			s.fail(w, 409, "草稿已在提案生成后变化，请让 AI 基于最新草稿重新提出修改")
			return
		}
		// what the files were before, so the person can review the change (and undo it) even after a restart
		rv := s.loadCompReview(name)
		if rv.Before == nil {
			rv.Before = map[string]*string{}
		}
		for _, f := range p.Files {
			if _, seen := rv.Before[f.Path]; seen {
				continue
			}
			if b, ok := set[f.Path]; ok {
				t := string(b)
				rv.Before[f.Path] = &t
			} else {
				rv.Before[f.Path] = nil
			}
		}
		rv.Proposals = append(rv.Proposals, p.ID)
		rv.At = now()
		for _, f := range p.Files {
			if f.Op == "delete" {
				delete(set, f.Path)
				continue
			}
			if err := validFilePath(f.Path); err != nil {
				s.fail(w, 400, err.Error())
				return
			}
			set[f.Path] = []byte(f.Content)
		}
		meta.Updated, meta.User = now(), user.User
		if err := s.comps().writeDraft(name, set, meta); err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		if err := writeJSONFile(filepath.Join(s.compAIDir(name), "review.json"), rv); err != nil {
			s.fail(w, 500, "无法保存")
			return
		}
		p.Status = "accepted"
	} else {
		p.Status = "rejected"
	}
	p.DecidedBy = user.User
	all[idx] = p
	if err := s.saveCompProposals(name, all); err != nil {
		s.fail(w, 500, "无法保存")
		return
	}
	s.auditReq(r, "ai-component-proposal", user.User, name+" "+id+" "+p.Status)
	s.writeJSON(w, 200, p)
}

func compDraftDigest(set fileSet) string {
	b, _ := json.Marshal(set)
	return fmt.Sprintf("%x", sha256.Sum256(b))
}

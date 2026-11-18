package main

import (
	"encoding/json"
	"fmt"
	"middleware-deployer/mwpack"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Proposals: the assistant never changes a delivery. When troubleshooting or review finds that the delivery lacks a
// step, it proposes one; the platform validates it, and only when the person working on the delivery accepts does it
// become an amendment: it shows in the runbook and is written into the delivery's handbook files at the right place,
// so the documents stay complete.

type aiStepSpec struct {
	Title    string   `json:"title"`
	Desc     string   `json:"desc,omitempty"`
	Command  string   `json:"command"`
	Effect   string   `json:"effect"`
	Hosts    []string `json:"hosts"`
	Expect   string   `json:"expect,omitempty"`
	Rollback string   `json:"rollback,omitempty"`
}

type aiProposal struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"`    // add | replace: a new step, or a new command for an existing one
	Session    string     `json:"session"` // conversation key
	Status     string     `json:"status"`  // pending | accepted | rejected
	Phase      string     `json:"phase"`
	AfterTitle string     `json:"after_title,omitempty"`
	Step       aiStepSpec `json:"step"`
	Reason     string     `json:"reason"`
	Verify     string     `json:"verify,omitempty"`
	Warnings   []string   `json:"warnings,omitempty"`
	// File is the change to one file of the delivery's project when Kind is "file" (ai_patch.go).
	File      *aiFilePatch `json:"file,omitempty"`
	At        string       `json:"at"`
	DecidedBy string       `json:"decided_by,omitempty"`
	DecidedAt string       `json:"decided_at,omitempty"`
}

// aiAmendment is an accepted proposal: a step added to the delivery's runbook.
type aiAmendment struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"`
	Phase      string     `json:"phase"`
	AfterTitle string     `json:"after_title,omitempty"`
	Step       aiStepSpec `json:"step"`
	Reason     string     `json:"reason"`
	By         string     `json:"by"`
	At         string     `json:"at"`
}

var aiPhases = map[string]string{"prepare": "00-", "deploy": "01-", "tests": "02-", "endpoint": "03-", "cleanup": "04-"}

// controllerFacts is how commands are run on this delivery's controller, so every command the assistant writes works
// as typed: where the project is, which Ansible binaries, which inventory, where uploads go.
func (s *storeServer) controllerFacts(job string) string {
	var p struct {
		ExecutionHost *mwpack.ExecutionHost `json:"execution_host"`
		Dir           string                `json:"project_dir"`
		Upload        string                `json:"upload_dir"`
		Controller    string                `json:"controller"`
		Cluster       string                `json:"cluster"`
	}
	if json.Unmarshal(s.jobPlan(job), &p) != nil || p.Dir == "" {
		return ""
	}
	bin := strings.TrimSuffix(p.Dir, "/") + "/../../bin"
	if i := strings.LastIndex(strings.TrimSuffix(p.Dir, "/"), "/projects/"); i > 0 {
		bin = p.Dir[:i] + "/bin"
	}
	location := ""
	if p.ExecutionHost != nil {
		location = "- 这是独立管理机（" + p.ExecutionHost.IP + "），不承载数据库角色。psql、redis-cli、数据库配置和服务检查必须在对应业务机器执行，不能假设控制节点就是主库。跨主机命令仍通过本交付清单和 playbook 执行。\n"
	}
	return "\n\n# 这份交付在控制节点上怎么执行命令（写给工程师的命令必须照这个写，能直接复制执行）\n" +
		"- 控制节点：" + p.Controller + "，用 root 执行。\n" +
		location +
		"- 项目目录：" + p.Dir + "。手册里的 playbook 命令都是在这个目录下执行的。\n" +
		"- 交付只提供两个离线命令入口：" + bin + "/ansible-playbook 和 " + bin + "/ansible-inventory。没有 " + bin + "/ansible，不得生成该路径或裸 ansible 命令，也不得假设系统 PATH 已安装 Ansible。\n" +
		"- 清单：inventory/hosts.yml（相对项目目录）。主机名用清单里的名字。\n" +
		"- 上传目录：" + p.Upload + "。\n" +
		"- 执行已有 playbook 的完整形式：cd " + p.Dir + " && " + bin + "/ansible-playbook -i inventory/hosts.yml <已核实存在的playbook路径>。不要原样输出占位符。查看清单：cd " + p.Dir + " && " + bin + "/ansible-inventory -i inventory/hosts.yml --graph。\n" +
		"- ansible-playbook 不支持 ad-hoc 的 -m/-a 参数，不能把 ansible -m 的命令仅替换名字。单机只读排查应写明目标机器并直接执行 shell 命令；跨机器检查用已核实的 playbook，若需临时 playbook 必须给出完整文件内容和保存位置，不能臆造已有文件。\n"

}

func (s *storeServer) projectDirOf(job string) string {
	var p struct {
		Dir string `json:"project_dir"`
	}
	_ = json.Unmarshal(s.jobPlan(job), &p)
	return p.Dir
}

func (s *storeServer) proposalsPath(job string) string {
	return filepath.Join(s.aiDir(job), "proposals.json")
}
func (s *storeServer) amendmentsPath(job string) string {
	return filepath.Join(s.jobDir(job), "amendments.json")
}

func (s *storeServer) loadProposals(job string) []aiProposal {
	out := []aiProposal{}
	if b, err := os.ReadFile(s.proposalsPath(job)); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

func (s *storeServer) loadAmendments(job string) []aiAmendment {
	out := []aiAmendment{}
	if b, err := os.ReadFile(s.amendmentsPath(job)); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

// stepTitles lists the titles a proposal can be placed after, per phase, as the runbook shows them.
func (s *storeServer) stepTitles(job string) map[string][]string {
	var p struct {
		Prepare  []struct{ Instance, Title string } `json:"prepare"`
		Deploy   []struct{ Title string }           `json:"deploy"`
		Tests    []struct{ Instance, Title string } `json:"tests"`
		Endpoint []struct{ Instance, Title string } `json:"endpoint_tests"`
		Cleanup  []struct{ Instance, Title string } `json:"cleanup"`
		Change   bool                               `json:"change"`
	}
	_ = json.Unmarshal(s.jobPlan(job), &p)
	pre := func(i, t string) string {
		if i != "" {
			return "[" + i + "] " + t
		}
		return t
	}
	out := map[string][]string{"deploy": {"离线安装 Ansible 并核对清单"}}
	for _, x := range p.Prepare {
		out["prepare"] = append(out["prepare"], pre(x.Instance, x.Title))
	}
	for _, x := range p.Deploy {
		out["deploy"] = append(out["deploy"], "阶段："+x.Title)
	}
	for _, x := range p.Tests {
		out["tests"] = append(out["tests"], pre(x.Instance, x.Title))
	}
	for _, x := range p.Endpoint {
		out["endpoint"] = append(out["endpoint"], pre(x.Instance, x.Title))
	}
	for _, x := range p.Cleanup {
		out["cleanup"] = append(out["cleanup"], pre(x.Instance, x.Title))
	}
	return out
}

var (
	reForbidden = regexp.MustCompile(`(?i)\brm\s+(-[a-z]*[rf][a-z]*\s+)+/\s*($|[;&|])|\bmkfs(\.\w+)?\b|\bdd\b[^\n]*\bof=/dev/|:\(\)\s*\{|>\s*/dev/(sd|vd|nvme)|\bwipefs\b|\bshutdown\b|\breboot\b|\bhalt\b|\bcurl\b[^\n|]*\|\s*(ba)?sh`)
	reWrites    = regexp.MustCompile(`(?i)\b(rm|mv|cp|tee|sed\s+-i|systemctl\s+(start|stop|restart|enable|disable|mask)|service\s+\S+\s+(start|stop|restart)|apt(-get)?\s+(install|remove|purge)|dpkg\s+-[ir]|yum|dnf|rpm\s+-[iUe]|pip\d?\s+install|kill|pkill|chmod|chown|mkdir|touch|truncate|useradd|userdel|sysctl\s+-w|mount|umount|iptables|firewall-cmd|ansible-playbook|patronictl\s+(restart|switchover|failover|reinit|edit-config)|psql[^\n]*\b(drop|alter|create|insert|update|delete)\b)\b|[^>]>[^>&=]|>>`)
	reDestroys  = regexp.MustCompile(`(?i)\brm\s+-[a-z]*r[a-z]*\b|\b(drop\s+(database|table|schema)|truncate|pg_dropcluster|patronictl\s+reinit|wipefs|userdel)\b`)
)

// errDangerous marks a command the platform never writes into a runbook; the person decides such things by hand.
var errDangerous = fmt.Errorf("命令含有平台不允许放进交付的高危操作")

// validateProposal checks what the model proposed against the delivery. The errors are written for the model: it reads
// them and corrects the proposal.
func (s *storeServer) validateProposal(job string, a map[string]any) (aiProposal, error) {
	str := func(k string) string { v, _ := a[k].(string); return strings.TrimSpace(v) }
	p := aiProposal{ID: randomStoreToken(6), Kind: "add", Status: "pending", Phase: str("phase"), AfterTitle: str("after_title"), Reason: str("reason"), Verify: str("verify"), At: time.Now().UTC().Format(time.RFC3339)}
	p.Step = aiStepSpec{Title: str("title"), Desc: str("desc"), Command: strings.Trim(str("command"), "\n"), Effect: str("effect"), Expect: str("expect"), Rollback: str("rollback")}
	if str("kind") == "replace" {
		p.Kind, p.AfterTitle, p.Step.Title = "replace", str("target_title"), str("target_title")
	}
	if _, ok := aiPhases[p.Phase]; !ok {
		return p, fmt.Errorf("phase 只能是 prepare、deploy、tests、endpoint、cleanup（endpoint 是入口测试）")
	}
	titles := s.stepTitles(job)
	if p.AfterTitle != "" {
		found := false
		for _, t := range titles[p.Phase] {
			found = found || t == p.AfterTitle
		}
		if !found {
			// close enough is enough: the step whose title contains, or is contained in, what was written; for a new
			// step otherwise the end of the phase. A step to change must name an existing one.
			for _, t := range titles[p.Phase] {
				if !found && (strings.Contains(t, p.AfterTitle) || strings.Contains(p.AfterTitle, t)) {
					p.AfterTitle, found = t, true
				}
			}
			if !found && p.Kind != "replace" {
				p.Warnings = append(p.Warnings, "没有找到标题为「"+p.AfterTitle+"」的步骤，放在阶段末尾")
				p.AfterTitle, found = "", true
			}
		}
		if !found {
			return p, fmt.Errorf("阶段 %s 里没有标题为「%s」的步骤。要修改的步骤必须是手册里已有的，可选的有：%s", p.Phase, p.AfterTitle, strings.Join(titles[p.Phase], "；"))
		}
	}
	if n := len([]rune(p.Step.Title)); n == 0 || n > 80 {
		return p, fmt.Errorf("title 需要 1～80 字")
	}
	if p.Step.Command == "" || len(p.Step.Command) > 4000 {
		return p, fmt.Errorf("command 不能为空，且不超过 4000 字符")
	}
	if p.Reason == "" || len([]rune(p.Reason)) > 600 || len([]rune(p.Step.Desc)) > 600 || len([]rune(p.Step.Expect)) > 300 || len([]rune(p.Step.Rollback)) > 600 {
		return p, fmt.Errorf("reason 必填；desc、reason、rollback 不超过 600 字，expect 不超过 300 字")
	}
	switch p.Step.Effect {
	case "read-only", "change", "disruptive", "destructive":
	default:
		return p, fmt.Errorf("effect 只能是 read-only、change、disruptive、destructive")
	}
	if aiScrub(p.Step.Command) != p.Step.Command || aiScrub(p.Step.Desc) != p.Step.Desc {
		return p, fmt.Errorf("命令或说明里含有口令、令牌或密钥，不能写进交付文档；改成读取控制节点 secrets/ 里的文件或环境变量")
	}
	if reForbidden.MatchString(p.Step.Command) {
		return p, errDangerous
	}
	if p.Step.Effect == "read-only" && reWrites.MatchString(p.Step.Command) {
		// the command decides, not the label
		p.Step.Effect = "change"
		p.Warnings = append(p.Warnings, "命令会修改系统，已按「会修改系统」标注")
	}
	if reDestroys.MatchString(p.Step.Command) && p.Step.Effect != "destructive" {
		return p, fmt.Errorf("命令会删除数据，effect 必须是 destructive")
	}
	if p.Step.Effect != "read-only" && p.Step.Rollback == "" {
		return p, fmt.Errorf("会修改系统的步骤必须写 rollback（回退办法）；确实无法回退就写明「无法回退」及原因")
	}
	var plan struct {
		Hosts []struct{ Name string } `json:"hosts"`
	}
	_ = json.Unmarshal(s.jobPlan(job), &plan)
	known := map[string]bool{}
	var names []string
	for _, h := range plan.Hosts {
		known[h.Name] = true
		names = append(names, h.Name)
	}
	hs, _ := a["hosts"].([]any)
	for _, h := range hs {
		name, _ := h.(string)
		if !known[name] {
			return p, fmt.Errorf("主机 %q 不在这份交付里，可选：%s", name, strings.Join(names, "、"))
		}
		p.Step.Hosts = append(p.Step.Hosts, name)
	}
	if len(p.Step.Hosts) == 0 {
		return p, fmt.Errorf("hosts 至少一台，可选：%s", strings.Join(names, "、"))
	}
	switch p.Step.Effect {
	case "disruptive":
		p.Warnings = append(p.Warnings, "会短暂中断服务")
	case "destructive":
		p.Warnings = append(p.Warnings, "会删除数据，不可撤销")
	}
	if p.Step.Effect != "read-only" && p.Step.Rollback != "" && strings.Contains(p.Step.Rollback, "无法回退") {
		p.Warnings = append(p.Warnings, "无法回退")
	}
	return p, nil
}

// suggest is the suggest_component_change tool: a problem was solved that the component should have caught. It becomes
// a card; accepting it takes the person to the component workbench, where the component's assistant drafts the change
// and the person reviews and saves it.
func (c aiToolCtx) suggest(args map[string]any) string {
	str := func(k string) string { v, _ := args[k].(string); return strings.TrimSpace(v) }
	name, title, detail := str("component"), str("title"), str("detail")
	if _, ok := c.s.plat.cat().Get(name); !ok {
		return "没有叫 " + name + " 的组件。用 list_components 或交付里的组件名。"
	}
	if title == "" || detail == "" || len([]rune(title)) > 80 || len([]rune(detail)) > 800 {
		return "title（80 字内）和 detail（800 字内）都要写：说明要加什么检查或步骤、为什么、放在哪个阶段。"
	}
	p := aiProposal{ID: randomStoreToken(6), Kind: "component", Status: "pending", Session: c.session, Phase: "deploy", AfterTitle: name, Step: aiStepSpec{Title: title, Desc: detail}, Reason: str("why"), At: time.Now().UTC().Format(time.RFC3339)}
	aiMu.Lock()
	defer aiMu.Unlock()
	all := c.s.loadProposals(c.job.ID)
	for _, x := range all {
		if x.Session == p.Session && x.Kind == "component" && x.Status == "pending" && x.AfterTitle == name && x.Step.Title == title {
			return "这条建议已经提交过。"
		}
	}
	all = append(all, p)
	if err := writeJSONFile(c.s.proposalsPath(c.job.ID), all); err != nil {
		return "建议无法保存"
	}
	*c.proposed = append(*c.proposed, p.ID)
	return "建议 #" + p.ID + " 已提交，用户可以在卡片上选择去组件工作台处理。请在回答里用一两句话说明为什么组件该加这个检查。"
}

func aiSuggestTool() aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return aiToolDef{"suggest_component_change", "问题已经解决之后，如果根因是“组件本该检查/处理而没有”，用它建议改进组件（例如部署前核对数据盘是整盘还是分区）。只在根因明确、改进有普遍价值时使用；排查中不要用。用户同意后会去组件工作台，由组件助手起草，他审查后保存。", map[string]any{"type": "object", "properties": map[string]any{
		"component": str("组件名，如 postgresql"),
		"title":     str("一句话：要加什么检查或步骤"),
		"detail":    str("具体加什么、放在哪个阶段、通过标准、为什么；这次遇到的问题是什么"),
		"why":       str("这次问题的根因（一句话）"),
	}, "required": []string{"component", "title", "detail"}}}
}

// aiPropose is the propose_step tool: it records a proposal and tells the model it awaits the user's decision.
func (c aiToolCtx) propose(args map[string]any, replace bool) string {
	if replace {
		args["kind"] = "replace"
	}
	p, err := c.s.validateProposal(c.job.ID, args)
	if err == nil && p.Kind == "replace" && p.AfterTitle == "" {
		err = fmt.Errorf("要修改哪一步？target_title 必填，用 runbook 里该步骤的标题")
	}
	if err == errDangerous {
		return "这条命令含有格式化、分区、删除数据、重启关机等高危操作，平台不会把它写进手册，也不会替用户决定。请不要再提交提案：在回答里把完整步骤、风险、执行前要核对的条件和回退办法写清楚，明确告诉用户这需要他在现场评估后自己决定、自己执行。"
	}
	if err != nil {
		return "提案没有通过平台校验，没有保存：" + err.Error() + "。请修正后重新调用 propose_step。"
	}
	p.Session = c.session
	aiMu.Lock()
	defer aiMu.Unlock()
	all := c.s.loadProposals(c.job.ID)
	// the same step proposed twice in a conversation is one proposal
	for _, x := range all {
		if x.Session == p.Session && x.Status == "pending" && x.Phase == p.Phase && x.Step.Title == p.Step.Title && x.Step.Command == p.Step.Command {
			return "这条提案已经提交过（#" + x.ID + "），等待用户决定。"
		}
	}
	all = append(all, p)
	if err := writeJSONFile(c.s.proposalsPath(c.job.ID), all); err != nil {
		return "提案无法保存"
	}
	*c.proposed = append(*c.proposed, p.ID)
	return "提案 #" + p.ID + " 已提交，等待用户审核，尚未生效。请在回答里用一两句话说明它解决什么问题，并告诉用户可以在下方卡片上采纳或拒绝。\n再判断一次：这个问题换一套环境、换一份交付还会不会遇到（例如没有内部 DNS、数据盘布局不同、端口被占用、缺少前置检查）？会的话，它就是组件本该处理的通用问题，同时调用 suggest_component_change，建议把这一步固化进组件（说清加在哪个组件、哪个阶段、做什么检查或配置）。只是这次现场独有的情况就不要建议。"
}

func aiProposeTool() aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return aiToolDef{"propose_step", "提议在这份交付的执行手册里增加一步（不会直接生效，要用户审核采纳后才写进手册和交付文档）。只在确实需要新增命令或检查时使用；每个独立动作一条提案。", map[string]any{
		"type": "object",
		"properties": map[string]any{
			"phase":       map[string]any{"type": "string", "enum": []string{"prepare", "deploy", "tests", "endpoint", "cleanup"}, "description": "放在哪个阶段：环境准备、部署、功能测试、入口测试（endpoint）、清理"},
			"after_title": str("放在哪一步之后，用 runbook 里该步骤的标题，完全一致；留空放在阶段末尾"),
			"title":       str("步骤标题，80 字内"),
			"desc":        str("这一步做什么"),
			"command":     str("在控制节点 root 终端执行的命令；不得含口令、密钥"),
			"effect":      map[string]any{"type": "string", "enum": []string{"read-only", "change", "disruptive", "destructive"}, "description": "只读 / 修改 / 会中断服务 / 不可撤销；必须如实"},
			"hosts":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "作用的主机名，必须是这份交付里的主机"},
			"expect":      str("通过标准：怎样算这一步成功"),
			"rollback":    str("回退办法；只读步骤可省略"),
			"reason":      str("首句标明新需求或现场修复；说明目标或根因证据、作用范围，以及配置是否会被后续重跑覆盖"),
			"verify":      str("加了之后怎样确认问题解决"),
		},
		"required": []string{"phase", "title", "command", "effect", "hosts", "reason"},
	}}
}

func aiChangeTool() aiToolDef {
	t := aiProposeTool()
	props := map[string]any{}
	for k, v := range t.Parameters["properties"].(map[string]any) {
		props[k] = v
	}
	delete(props, "after_title")
	delete(props, "title")
	props["target_title"] = map[string]any{"type": "string", "description": "要修改的现有步骤，用 runbook 里的标题，完全一致"}
	props["command"] = map[string]any{"type": "string", "description": "替换后的完整命令（在控制节点 root 终端执行；不含 cd 项目目录的前缀）。参数调整可用 -e 传额外变量，或写出完整的新命令"}
	return aiToolDef{"propose_change", "提议修改手册里某个现有步骤的命令（例如调整参数、换一种做法）。仍然只是提案，用户采纳后才在这份交付里生效；手册和交付文档会换成新命令，并记录原命令和缘由。不需要重新生成交付。", map[string]any{"type": "object", "properties": props, "required": []string{"phase", "target_title", "command", "effect", "hosts", "reason"}}}
}

// ---- amendments into the handbook files ----

func effectLabel(e string) string {
	return map[string]string{"read-only": "只读", "change": "修改", "disruptive": "会中断服务", "destructive": "不可撤销"}[e]
}

func amendmentBlock(a aiAmendment) string {
	var b strings.Builder
	fmt.Fprintf(&b, "**＋ %s**　`%s` · 作用于 %s　（AI 补充，%s 于 %s 采纳）\n\n", a.Step.Title, effectLabel(a.Step.Effect), strings.Join(a.Step.Hosts, "、"), a.By, a.At[:10])
	if a.Step.Desc != "" {
		b.WriteString(a.Step.Desc + "\n\n")
	}
	if a.Step.Expect != "" {
		b.WriteString("通过标准：" + a.Step.Expect + "\n\n")
	}
	b.WriteString("```bash\n" + a.Step.Command + "\n```\n\n")
	if a.Step.Rollback != "" {
		b.WriteString("回退：" + a.Step.Rollback + "\n\n")
	}
	b.WriteString("缘由：" + a.Reason + "\n\n")
	return b.String()
}

var reStepHead = regexp.MustCompile(`^\*\*(\d+\.|＋)`)

// blockOf finds the lines of the step titled title: from its heading to the next heading of the same or higher level.
func blockOf(lines []string, title string) (int, int) {
	for i, l := range lines {
		if !(strings.HasPrefix(l, "## ") || strings.HasPrefix(l, "**")) || !strings.Contains(l, title) {
			continue
		}
		sub := strings.HasPrefix(l, "**")
		end := len(lines)
		for k := i + 1; k < len(lines); k++ {
			if strings.HasPrefix(lines[k], "## ") || (sub && reStepHead.MatchString(lines[k])) {
				end = k
				break
			}
		}
		return i, end
	}
	return -1, -1
}

// replaceCommand swaps the command of an existing step in the handbook and notes what it was and why it changed.
func replaceCommand(md string, a aiAmendment, cd string) string {
	lines := strings.Split(md, "\n")
	from, to := blockOf(lines, a.AfterTitle)
	if from < 0 {
		return md
	}
	// the fence that runs the playbook, else the first one
	open, closeAt := -1, -1
	for i := from; i < to; i++ {
		if !strings.HasPrefix(lines[i], "```") {
			continue
		}
		k := i + 1
		for k < to && !strings.HasPrefix(lines[k], "```") {
			k++
		}
		if k >= to {
			break
		}
		if open < 0 || strings.Contains(strings.Join(lines[i+1:k], "\n"), "ansible-playbook") && !strings.Contains(strings.Join(lines[open+1:closeAt], "\n"), "ansible-playbook") {
			open, closeAt = i, k
		}
		i = k
	}
	if open < 0 {
		return md
	}
	old := strings.Join(lines[open+1:closeAt], "\n")
	cmd := a.Step.Command
	if cd != "" {
		cmd = "cd " + cd + "\n" + cmd
	}
	note := []string{"", fmt.Sprintf("**已修改**（AI，%s 于 %s 采纳）：%s", a.By, a.At[:10], a.Reason), "", "修改前的命令：", "", "```bash", old, "```"}
	if a.Step.Rollback != "" {
		note = append(note, "", "回退："+a.Step.Rollback)
	}
	out := append([]string{}, lines[:open+1]...)
	out = append(out, strings.Split(cmd, "\n")...)
	out = append(out, "```")
	out = append(out, note...)
	out = append(out, lines[closeAt+1:]...)
	return strings.Join(out, "\n")
}

// insertAmendment puts the block after the step it follows, or at the end of the document.
func insertAmendment(md string, a aiAmendment) string {
	block := amendmentBlock(a)
	lines := strings.Split(md, "\n")
	at := len(lines)
	if a.AfterTitle != "" {
		for i, l := range lines {
			if !(strings.HasPrefix(l, "## ") || strings.HasPrefix(l, "**")) || !strings.Contains(l, a.AfterTitle) {
				continue
			}
			sub := strings.HasPrefix(l, "**")
			at = len(lines)
			for k := i + 1; k < len(lines); k++ {
				if strings.HasPrefix(lines[k], "## ") || (sub && regexp.MustCompile(`^\*\*(\d+\.|＋)`).MatchString(lines[k])) {
					at = k
					break
				}
			}
			break
		}
	}
	head := strings.TrimRight(strings.Join(lines[:at], "\n"), "\n") + "\n\n" + block
	if at < len(lines) {
		return head + strings.Join(lines[at:], "\n")
	}
	return strings.TrimRight(head, "\n") + "\n"
}

// applyAmendmentDocs rewrites the handbook files from their originals plus every accepted amendment, so the result
// does not depend on the order things were accepted or withdrawn, and keeps SHA256SUMS in step.
func (s *storeServer) applyAmendmentDocs(job string) error {
	ams := s.loadAmendments(job)
	out := filepath.Join(s.jobDir(job), "output")
	sums, _ := os.ReadFile(filepath.Join(out, "SHA256SUMS"))
	lines := strings.Split(string(sums), "\n")
	for phase, prefix := range aiPhases {
		files, _ := filepath.Glob(filepath.Join(out, prefix+"*.md"))
		for _, f := range files {
			name := filepath.Base(f)
			orig := filepath.Join(s.aiDir(job), "orig", name)
			if _, err := os.Stat(orig); err != nil {
				b, err := os.ReadFile(f)
				if err != nil {
					return err
				}
				if err := os.MkdirAll(filepath.Dir(orig), 0o700); err != nil {
					return err
				}
				if err := os.WriteFile(orig, b, 0o600); err != nil {
					return err
				}
			}
			b, err := os.ReadFile(orig)
			if err != nil {
				return err
			}
			md := string(b)
			for _, a := range ams { // changes first: they do not move anything
				if a.Phase == phase && a.Kind == "replace" {
					md = replaceCommand(md, a, s.projectDirOf(job))
				}
			}
			for _, a := range ams {
				if a.Phase == phase && a.Kind != "replace" {
					md = insertAmendment(md, a)
				}
			}
			if err := os.WriteFile(f, []byte(md), 0o600); err != nil {
				return err
			}
			for i, l := range lines {
				if strings.HasSuffix(l, "  "+name) {
					lines[i] = digest([]byte(md)) + "  " + name
				}
			}
		}
	}
	if len(sums) > 0 {
		return os.WriteFile(filepath.Join(out, "SHA256SUMS"), []byte(strings.Join(lines, "\n")), 0o600)
	}
	return nil
}

// ---- API ----

func (s *storeServer) handleProposals(w http.ResponseWriter, r *http.Request, user storeSession, j storeJob, parts []string) {
	id := j.ID
	switch {
	case len(parts) == 0 && r.Method == "GET":
		s.writeJSON(w, 200, map[string]any{"proposals": s.loadProposals(id), "amendments": s.loadAmendments(id)})
	case len(parts) == 2 && r.Method == "POST" && (parts[1] == "accept" || parts[1] == "reject"):
		aiMu.Lock()
		all := s.loadProposals(id)
		idx := -1
		for i := range all {
			if all[i].ID == parts[0] {
				idx = i
			}
		}
		if idx < 0 || all[idx].Status != "pending" {
			aiMu.Unlock()
			s.fail(w, 409, "提案不存在，或已经处理过")
			return
		}
		p := all[idx]
		now := time.Now().UTC().Format(time.RFC3339)
		if parts[1] == "accept" && p.Kind == "file" {
			if _, err := s.acceptFilePatch(j, p, user.User); err != nil {
				aiMu.Unlock()
				s.fail(w, 409, err.Error())
				return
			}
			p.Status = "accepted"
		} else if parts[1] == "accept" && p.Kind == "component" {
			// a suggestion to improve the component writes nothing here: "accepting" it is the person taking it to the
			// component workbench
			p.Status = "accepted"
		} else if parts[1] == "accept" {
			// checked again: the delivery may have changed since it was proposed
			if v, err := s.validateProposal(id, map[string]any{"phase": p.Phase, "after_title": p.AfterTitle, "kind": p.Kind, "target_title": p.AfterTitle, "title": p.Step.Title, "desc": p.Step.Desc, "command": p.Step.Command, "effect": p.Step.Effect, "hosts": toAny(p.Step.Hosts), "expect": p.Step.Expect, "rollback": p.Step.Rollback, "reason": p.Reason}); err != nil {
				aiMu.Unlock()
				s.fail(w, 409, "提案已不再适用："+err.Error())
				return
			} else {
				_ = v
			}
			ams := append(s.loadAmendments(id), aiAmendment{ID: p.ID, Kind: p.Kind, Phase: p.Phase, AfterTitle: p.AfterTitle, Step: p.Step, Reason: p.Reason, By: user.User, At: now})
			if err := writeJSONFile(s.amendmentsPath(id), ams); err != nil {
				aiMu.Unlock()
				s.fail(w, 500, "无法保存")
				return
			}
			if err := s.applyAmendmentDocs(id); err != nil {
				aiMu.Unlock()
				s.fail(w, 500, "交付文档无法更新")
				return
			}
			p.Status = "accepted"
		} else {
			p.Status = "rejected"
		}
		p.DecidedBy, p.DecidedAt = user.User, now
		all[idx] = p
		err := writeJSONFile(s.proposalsPath(id), all)
		aiMu.Unlock()
		if err != nil {
			s.fail(w, 500, "无法保存")
			return
		}
		state := "ai-accepted"
		if p.Status == "rejected" {
			state = "ai-rejected"
		}
		s.mu.Lock()
		doc := s.readProgress(id)
		doc.Events = append(doc.Events, progressEvent{At: now, By: user.User, Key: "ai-" + p.ID, Title: truncRunes(p.Step.Title, 120), State: state})
		if len(doc.Events) > maxEvents {
			doc.Events = doc.Events[len(doc.Events)-maxEvents:]
		}
		_ = s.writeProgress(id, doc)
		s.mu.Unlock()
		s.auditReq(r, "ai-proposal-"+parts[1], user.User, id+" "+p.ID)
		s.writeJSON(w, 200, p)
	case len(parts) == 2 && parts[0] == "amendment" && r.Method == "DELETE":
		aiMu.Lock()
		defer aiMu.Unlock()
		ams := s.loadAmendments(id)
		keep := ams[:0]
		for _, a := range ams {
			if a.ID != parts[1] {
				keep = append(keep, a)
			}
		}
		if len(keep) == len(ams) {
			s.fail(w, 404, "没有这条补充")
			return
		}
		if err := writeJSONFile(s.amendmentsPath(id), keep); err != nil {
			s.fail(w, 500, "无法保存")
			return
		}
		if err := s.applyAmendmentDocs(id); err != nil {
			s.fail(w, 500, "交付文档无法更新")
			return
		}
		all := s.loadProposals(id)
		for i := range all {
			if all[i].ID == parts[1] {
				all[i].Status = "withdrawn"
			}
		}
		_ = writeJSONFile(s.proposalsPath(id), all)
		s.auditReq(r, "ai-amendment-withdraw", user.User, id+" "+parts[1])
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func toAny(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

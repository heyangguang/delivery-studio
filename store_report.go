package main

import (
	"encoding/json"
	"fmt"
	"path"
	"strings"

	"middleware-deployer/mwpack"
)

// The execution report is written the way the customer's own manuals are: for each step what is run and where, the
// pass criterion, and what the person on site recorded as the result — their text as text, their pictures as pictures.
//
// A step is described in two ways, and a report may carry either or both:
//
//   - automation: the playbook and the command that runs it, and the tasks it holds;
//   - commands: the same tasks said as the commands typed on each machine.
//
// and its result is optional too. The blocks carry which of these they belong to (docBlock.Variant), so the screen
// and the Word export can show what the reader asked for.

const (
	variantAuto       = "auto"
	variantCmd        = "cmd"
	variantResult     = "result"
	variantResultAuto = "result_auto"
	variantResultCmd  = "result_cmd"
)

type planStepDoc struct {
	Automatic      bool            `json:"automatic"`
	Timeout        int             `json:"timeout"`
	Confirm        bool            `json:"confirm"`
	ConfirmVars    []string        `json:"confirm_vars"`
	Postconditions []string        `json:"postconditions"`
	Instance       string          `json:"instance"`
	ID             string          `json:"id"`
	Title          string          `json:"title"`
	Desc           string          `json:"desc"`
	Effect         string          `json:"effect"`
	Expect         string          `json:"expect"`
	Hosts          []string        `json:"hosts"`
	Playbook       string          `json:"playbook"`
	Command        string          `json:"command"`
	Skipped        string          `json:"skipped"`
	Actions        []mwpack.Action `json:"actions"`
}

type planDocJSON struct {
	DeliveryMode string        `json:"delivery_mode"`
	StepFormat   int           `json:"step_format"`
	Controller   string        `json:"controller"`
	ProjectDir   string        `json:"project_dir"`
	Prepare      []planStepDoc `json:"prepare"`
	Deploy       []struct {
		Phase    string        `json:"phase"`
		Title    string        `json:"title"`
		Playbook string        `json:"playbook"`
		Command  string        `json:"command"`
		Steps    []planStepDoc `json:"steps"`
	} `json:"deploy"`
	Tests    []planStepDoc `json:"tests"`
	Endpoint []planStepDoc `json:"endpoint_tests"`
	Cleanup  []planStepDoc `json:"cleanup"`
}

// reportStep is one step of the runbook, with the key its record is stored under.
type reportStep struct {
	Key, Title, Purpose, Effect, Expect string
	Hosts                               []string
	Playbook                            string
	Command                             string // what is typed in the controller's terminal
	Manual                              bool   // the step is typed by hand, there is no playbook behind it
	Parts                               []planStepDoc
	Amended                             string
}

type reportTab struct {
	Label string
	Steps []reportStep
}

func inList(l []string, x string) bool {
	for _, y := range l {
		if y == x {
			return true
		}
	}
	return false
}

// runbookSteps lists the steps of a delivery the way the runbook page shows them, with the keys the records use.
func (s *storeServer) runbookSteps(jobID string) []reportTab {
	return s.runbookStepsLang(jobID, "")
}

func (s *storeServer) runbookStepsLang(jobID, lang string) []reportTab {
	return s.runbookStepsOfLang(s.jobPlan(jobID), jobID, lang)
}

// runbookStepsOf lists the steps of a structured handbook (plan.json), with the accepted AI amendments of jobID when
// one is given.
func (s *storeServer) runbookStepsOf(raw []byte, jobID string) []reportTab {
	return s.runbookStepsOfLang(raw, jobID, "")
}

func (s *storeServer) runbookStepsOfLang(raw []byte, jobID, lang string) []reportTab {
	if isEnLang(lang) {
		raw = mwpack.LocalizePlanJSON(lang, raw)
	}
	var p planDocJSON
	if json.Unmarshal(raw, &p) != nil {
		return nil
	}
	if p.DeliveryMode == "configuration" {
		return nil
	}
	cd := p.ProjectDir
	withCd := func(c string) string {
		if cd != "" {
			return "cd " + cd + "\n" + c
		}
		return c
	}
	var tabs []reportTab
	var prep reportTab
	prep.Label = tr(lang, "环境准备", "Prepare")
	for i, st := range p.Prepare {
		key := fmt.Sprintf("prepare/prepare-%d", i)
		if p.StepFormat >= 2 && st.ID != "" {
			key = "prepare/" + st.ID
		}
		prep.Steps = append(prep.Steps, reportStep{Key: key, Title: st.Title, Purpose: st.Desc, Effect: st.Effect, Expect: st.Expect, Hosts: st.Hosts, Command: st.Command, Manual: true})
	}
	tabs = append(tabs, prep)
	label := tr(lang, "部署", "Deploy")
	dep := reportTab{Label: label}
	if p.DeliveryMode != "automatic" {
		rootDir := path.Dir(path.Dir(strings.ReplaceAll(cd, "\\", "/")))
		dep.Steps = append(dep.Steps, reportStep{
			Key: "deploy/deploy-bootstrap", Title: tr(lang, "离线安装 Ansible 并核对清单", "Install Ansible Offline & Verify Inventory"), Purpose: tr(lang, "引导脚本只使用随包的离线材料，不访问外网。", "Bootstrap script uses only bundled offline artifacts with zero external network access."), Effect: "change",
			Expect: tr(lang, "清单应列出全部机器和各实例的分组。", "Inventory must list all hosts and instance groups."), Hosts: []string{p.Controller}, Manual: true,
			Command: "cd " + rootDir + "\nbash bootstrap/bootstrap-ansible.sh\n" + withCd("../../bin/ansible-inventory -i inventory/hosts.yml --graph"),
		})
	}
	for _, ph := range p.Deploy {
		if p.StepFormat >= 2 {
			for _, st := range ph.Steps {
				owner := "platform"
				if st.Instance != "" {
					owner = "instance-" + st.Instance
				}
				title := st.Title
				if st.Instance != "" {
					title = "[" + st.Instance + "] " + title
				}
				dep.Steps = append(dep.Steps, reportStep{
					Key:   "deploy/" + ph.Phase + "/" + owner + "/" + st.ID,
					Title: title, Purpose: st.Desc, Effect: st.Effect, Expect: st.Expect,
					Hosts: st.Hosts, Playbook: st.Playbook, Command: withCd(st.Command), Parts: []planStepDoc{st},
				})
			}
			continue
		}
		var titles []string
		for _, st := range ph.Steps {
			titles = append(titles, strings.TrimSpace(map[bool]string{true: "[" + st.Instance + "] ", false: ""}[st.Instance != ""]+st.Title))
		}
		dep.Steps = append(dep.Steps, reportStep{
			Key: "deploy/deploy-" + ph.Phase, Title: tr(lang, "阶段："+ph.Title, "Phase: "+ph.Title), Purpose: strings.Join(titles, tr(lang, "；", "; ")), Hosts: []string{p.Controller},
			Playbook: ph.Playbook, Command: withCd(ph.Command), Parts: ph.Steps,
			Expect: tr(lang, "Ansible 输出末尾 failed=0、unreachable=0。", "Ansible summary ends with failed=0 and unreachable=0."),
		})
	}
	tabs = append(tabs, dep)
	list := func(id, label string, steps []planStepDoc) {
		t := reportTab{Label: label}
		i := 0
		for _, st := range steps {
			if st.Skipped != "" {
				continue
			}
			title := st.Title
			if st.Instance != "" {
				title = "[" + st.Instance + "] " + title
			}
			key := fmt.Sprintf("%s/%s-%d-%s-%s", id, id, i, st.Instance, st.ID)
			if p.StepFormat >= 2 {
				key = id + "/" + st.Instance + "/" + st.ID
			}
			t.Steps = append(t.Steps, reportStep{Key: key, Title: title, Purpose: st.Desc, Effect: st.Effect, Expect: st.Expect, Hosts: st.Hosts, Playbook: st.Playbook, Command: withCd(st.Command), Parts: []planStepDoc{st}})
			i++
		}
		if len(t.Steps) > 0 {
			tabs = append(tabs, t)
		}
	}
	list("tests", tr(lang, "功能测试", "Functional Tests"), p.Tests)
	list("endpoint", tr(lang, "入口测试", "Endpoint Tests"), p.Endpoint)
	list("cleanup", tr(lang, "清理", "Cleanup"), p.Cleanup)
	// steps accepted from the assistant during the run
	var ams []aiAmendment
	if jobID != "" {
		ams = s.loadAmendments(jobID)
	}
	for _, a := range ams {
		for ti := range tabs {
			id := map[string]string{"prepare": prep.Label, "deploy": label, "tests": tr(lang, "功能测试", "Functional Tests"), "endpoint": tr(lang, "入口测试", "Endpoint Tests"), "cleanup": tr(lang, "清理", "Cleanup")}[a.Phase]
			if id == "" || tabs[ti].Label != id {
				continue
			}
			at := -1
			for i, st := range tabs[ti].Steps {
				if a.AfterTitle != "" && st.Title == a.AfterTitle {
					at = i
				}
			}
			if a.Kind == "replace" {
				if at >= 0 {
					tabs[ti].Steps[at].Command = withCd(a.Step.Command)
					tabs[ti].Steps[at].Manual = true
					tabs[ti].Steps[at].Parts = nil
					tabs[ti].Steps[at].Amended = tr(lang, "命令已按现场情况修改：", "Command amended for on-site conditions: ") + a.Reason
				}
				continue
			}
			st := reportStep{Key: tabs[ti].keyPrefix(a.Phase) + "/ai-" + a.ID, Title: a.Step.Title, Purpose: a.Step.Desc, Effect: a.Step.Effect, Expect: a.Step.Expect, Hosts: a.Step.Hosts, Command: withCd(a.Step.Command), Manual: true, Amended: tr(lang, "现场新增：", "Added on-site: ") + a.Reason}
			for at >= 0 && at+1 < len(tabs[ti].Steps) && strings.HasPrefix(tabs[ti].Steps[at+1].Key[strings.Index(tabs[ti].Steps[at+1].Key, "/")+1:], "ai-") {
				at++
			}
			pos := len(tabs[ti].Steps)
			if at >= 0 {
				pos = at + 1
			}
			tabs[ti].Steps = append(tabs[ti].Steps[:pos], append([]reportStep{st}, tabs[ti].Steps[pos:]...)...)
			break
		}
	}
	return tabs
}

func (t reportTab) keyPrefix(phase string) string { return phase }

var effectWords = map[string]string{"read-only": "只读", "change": "修改", "disruptive": "会中断服务", "destructive": "不可撤销"}

func effectWord(lang, eff string) string {
	if isEnLang(lang) {
		return map[string]string{"read-only": "Read-only", "change": "Modifies system", "disruptive": "Service-disruptive", "destructive": "Destructive"}[eff]
	}
	return effectWords[eff]
}

func hostLineLang(hosts []string, lang string) string {
	if len(hosts) == 0 {
		return tr(lang, "控制节点", "Controller")
	}
	return strings.Join(hosts, " / ")
}

func hostLine(hosts []string) string { return hostLineLang(hosts, "") }

// header is the first line of a code block, in the manuals' style: where it runs, as whom, and what it is for.
func headerLang(hosts []string, what, lang string) string {
	return "# " + hostLineLang(hosts, lang) + " root  " + strings.ReplaceAll(strings.TrimSpace(what), "\n", " ")
}

func header(hosts []string, what string) string { return headerLang(hosts, what, "") }

func (b *docBuilder) variant(v string, blk docBlock) {
	blk.Variant = v
	b.blocks = append(b.blocks, blk)
}

// stepReport writes every step of the delivery's runbook with its result. Steps nobody recorded show as not done.
func (s *storeServer) stepReport(b *docBuilder, level int, j storeJob, langOpt ...string) bool {
	lang := ""
	if len(langOpt) > 0 {
		lang = langOpt[0]
	}
	start := len(b.blocks)
	defer func() {
		for i := start; i < len(b.blocks); i++ {
			b.blocks[i].Detail = true
		}
	}()
	tabs := s.runbookStepsLang(j.ID, lang)
	if len(tabs) == 0 {
		return false
	}
	_, prog := s.execRecord(j.ID)
	logs := s.runLogs(j.ID)
	hostIPs := s.jobHostIPs(j.ID)
	execSteps := s.latestExecutionSteps(j.ID)
	cmdCtx := s.buildReportCmdCtx(j, hostIPs, lang)
	b.variant(variantCmd, docBlock{Kind: "note", Text: tr(lang,
		"命令里的部署参数（目录、端口、地址等）已按本次规格代入，多台机器的步骤以第一台为例，其余机器把主机名和地址换成自己的；写成 <…> 的是执行时才产生的值（上一条命令的输出等，见下面的执行结果），密码不写进报告，见控制节点 secrets/ 目录。以 # 开头的行说明这一步在做什么，不是要输入的命令。",
		"Deployment parameters (directories, ports, addresses) in these commands are pre-filled from the spec. Multi-host steps show the first host as an example; substitute each peer's hostname/IP as needed. Placeholders like <...> represent runtime values, and secrets remain omitted (refer to controller secrets/). Lines starting with # are descriptive comments, not commands.",
	)})
	hl := func(n int) int {
		if n > 4 {
			return 4
		}
		return n
	}
	for ti, t := range tabs {
		if len(t.Steps) == 0 {
			continue
		}
		b.h(hl(level+1), fmt.Sprintf("%d  %s", ti+1, t.Label))
		for si, st := range t.Steps {
			b.h(hl(level+2), fmt.Sprintf("%d.%d  %s", ti+1, si+1, st.Title))
			b.variant("", docBlock{Kind: "p", Text: tr(lang, "位置：", "Target: ") + hostLineWithIPLang(st.Hosts, hostIPs, lang) + tr(lang, "　　影响：", "    Impact: ") + firstNonEmptyStr(effectWord(lang, st.Effect), "—")})
			if st.Purpose != "" && st.Manual || len(st.Parts) == 1 && st.Purpose != "" {
				b.variant("", docBlock{Kind: "p", Text: st.Purpose})
			}
			if st.Amended != "" {
				b.variant("", docBlock{Kind: "note", Text: st.Amended})
			}
			// automation: the YAML that is run
			switch {
			case st.Manual:
				expandedCmd := cmdCtx.expandManualStepToCmd(st)
				if expandedCmd != strings.TrimSpace(st.Command) {
					b.variant(variantAuto, docBlock{Kind: "code", Style: "shell", Text: headerWithIPLang(st.Hosts, hostIPs, st.Title, lang) + "\n" + st.Command})
					b.variant(variantCmd, docBlock{Kind: "code", Style: "shell", Text: headerWithIPLang(st.Hosts, hostIPs, st.Title, lang) + "\n" + expandedCmd})
				} else {
					b.variant("", docBlock{Kind: "code", Style: "shell", Text: headerWithIPLang(st.Hosts, hostIPs, st.Title, lang) + "\n" + expandedCmd})
				}
			default:
				b.variant(variantAuto, docBlock{Kind: "code", Style: "shell", Text: headerWithIPLang([]string{tr(lang, "控制节点", "Controller")}, hostIPs, tr(lang, "执行 ", "Run ")+st.Playbook, lang) + "\n" + st.Command})
				if len(st.Parts) > 1 {
					var items []string
					for _, p := range st.Parts {
						items = append(items, strings.TrimSpace(map[bool]string{true: "[" + p.Instance + "] ", false: ""}[p.Instance != ""]+p.Title)+tr(lang, "（"+hostLineWithIPLang(p.Hosts, hostIPs, lang)+"）", " ("+hostLineWithIPLang(p.Hosts, hostIPs, lang)+")"))
					}
					b.variant(variantAuto, docBlock{Kind: "p", Text: tr(lang, "这份 Playbook 依次完成：", "This playbook executes in order:")})
					b.variant(variantAuto, docBlock{Kind: "list", Items: items})
				}
				// the same tasks as commands, machine by machine
				any := false
				for _, p := range st.Parts {
					lines := cmdCtx.renderPartExecutableLines(p)
					if len(lines) == 0 {
						continue
					}
					any = true
					who := strings.TrimSpace(map[bool]string{true: "[" + p.Instance + "] ", false: ""}[p.Instance != ""] + p.Title)
					b.variant(variantCmd, docBlock{Kind: "code", Style: "shell", Text: headerWithIPLang(p.Hosts, hostIPs, who+exampleNoteLang(p.Hosts, lang), lang) + "\n" + strings.Join(lines, "\n")})
				}
				if !any {
					b.variant(variantCmd, docBlock{Kind: "p", Text: tr(lang, "这一步由 Playbook 完成，没有可单列的手工命令：", "This step runs via Playbook with no standalone manual command: ") + st.Command})
				}
			}
			if st.Expect != "" {
				b.variant("", docBlock{Kind: "p", Text: tr(lang, "✓ 判据：", "✓ Criteria: ") + st.Expect})
			}
			// what was run before a sync replaced this step: kept, struck through, so the report tells all of it
			for _, old := range prog.Superseded[st.Key] {
				var items []string
				rec := old.Record
				if rec.State != "" || rec.Note != "" {
					items = append(items, strings.TrimSpace(fmt.Sprintf("%s%s  %s  %s  %s", tr(lang, "执行结果：", "Result: "), firstNonEmptyStr(stepStateLabel(lang, rec.State), tr(lang, "没有标记结果", "Not marked")), rec.By, stamp(rec.At), rec.Note)))
				}
				if rec.Log != "" {
					items = append(items, tr(lang, "输出：", "Output: ")+truncRunes(rec.Log, 600))
				}
				oldVariant := ""
				if st.Playbook != "" || strings.Contains(old.Command, "ansible-playbook") || isInternalWrapperCmd(old.Command) {
					oldVariant = variantAuto
				}
				b.variant(oldVariant, docBlock{Kind: "old", Title: tr(lang,
					fmt.Sprintf("旧版本（第 %d 次按最新组件同步前，%s），已被本步骤的新版本取代：%s", old.Sync, stamp(old.At), old.Title),
					fmt.Sprintf("Superseded revision (before sync #%d on %s), replaced by current step: %s", old.Sync, stamp(old.At), old.Title),
				), Text: old.Command, Items: items})
			}
			s.resultBlocksLang(b, j.ID, st, hostIPs, prog, lang)
			stRuns := stepRuns(logs, st.Playbook)
			runBlocksLang(b, stRuns, lang)
			if execInfo, hasExec := execSteps[st.Key]; hasExec {
				raw := s.executionLog(execInfo.RunID, execInfo.Step)
				if len(raw) > 0 {
					rl := parseRunLog(execInfo.Step.ID+".log", raw)
					meta := terminalMeta{
						Started:  execInfo.Step.Started,
						Finished: execInfo.Step.Finished,
						State:    execInfo.Step.State,
						ExitCode: execInfo.Step.ExitCode,
						Hosts:    execInfo.Step.Hosts,
						Message:  execInfo.Step.Message,
					}
					var term string
					if rl.Playbook != "" || len(rl.Tasks) > 0 || len(rl.Recap) > 0 {
						term = buildTerminalTranscript(st, rl, hostIPs, meta, lang)
					} else {
						term = formatManualTerminalLog(st, hostIPs, string(raw), lang)
					}
					if strings.TrimSpace(term) != "" {
						b.variant(variantResultCmd, docBlock{Kind: "code", Style: "terminal", Text: term})
					}
				}
			} else if len(stRuns) > 0 {
				last := stRuns[len(stRuns)-1]
				term := buildTerminalTranscript(st, last, hostIPs, terminalMeta{Started: last.Started, Finished: last.Finished, Hosts: st.Hosts}, lang)
				if strings.TrimSpace(term) != "" {
					b.variant(variantResultCmd, docBlock{Kind: "code", Style: "terminal", Text: term})
				}
			}
		}
	}
	// records whose step is no longer in the runbook (an older delivery, a step the assistant replaced) still count
	known := map[string]bool{}
	for _, t := range tabs {
		for _, st := range t.Steps {
			known[st.Key] = true
		}
	}
	var extra []execStep
	steps, _ := s.execRecord(j.ID)
	for _, st := range steps {
		if !known[st.Key] {
			extra = append(extra, st)
		}
	}
	if len(extra) > 0 {
		b.h(hl(level+1), tr(lang, "其他记录", "Other Records"))
		for i, st := range extra {
			b.h(hl(level+2), fmt.Sprintf("%d  %s", i+1, st.Title))
			s.resultBlocksLang(b, j.ID, reportStep{Key: st.Key, Title: st.Title}, hostIPs, prog, lang)
		}
	}
	return true
}

func (s *storeServer) resultBlocksLang(b *docBuilder, job string, st reportStep, hostIPs map[string]string, prog progressDoc, lang string) {
	key := st.Key
	rec, ok := prog.Steps[key]
	if !ok {
		b.variant(variantResult, docBlock{Kind: "note", Text: tr(lang, "执行结果：尚未记录", "Execution result: not yet recorded")})
		return
	}
	label := firstNonEmptyStr(stepStateLabel(lang, rec.State), tr(lang, "没有标记结果", "Not marked"))
	b.variant(variantResult, docBlock{Kind: "p", Text: fmt.Sprintf("**%s**  %s  %s  %s", tr(lang, "执行结果", "Execution Result"), label, rec.By, stamp(rec.At))})
	if note := strings.TrimSpace(rec.Note); note != "" && !(rec.Source == "automatic" && note == "任务与组件声明的完成检查通过") {
		b.variant(variantResult, docBlock{Kind: "p", Text: note})
	}
	// what came from a log is written out in full by runBlocks
	if strings.TrimSpace(rec.Log) != "" && rec.By != runLogBy {
		log := strings.TrimRight(rec.Log, "\n")
		if r := []rune(log); len(r) > 12000 {
			log = tr(lang, "……（只保留末尾 12000 字，完整输出在平台的执行记录里）\n", "... (truncated to last 12,000 chars; full output in platform execution logs)\n") + string(r[len(r)-12000:])
		}
		if st.Manual {
			log = formatManualTerminalLog(st, hostIPs, log, lang)
		}
		b.variant(variantResult, docBlock{Kind: "code", Style: "terminal", Text: log})
	}
	if len(rec.Images) > 0 {
		b.variant(variantResult, docBlock{Kind: "image", Items: rec.Images, Job: job})
	}
	// a problem met on this step and how it was solved belongs right here
	for _, rp := range prog.Reports {
		if rp.Key == "step:"+key {
			writeUpBlocksLang(b, variantResult, rp, lang)
		}
	}
}

// writeUpBlocks writes a problem and its solution: what happened, why, what was done (commands as code), what is left.
func writeUpBlocks(b *docBuilder, variant string, rp aiReport) { writeUpBlocksLang(b, variant, rp, "") }

func writeUpBlocksLang(b *docBuilder, variant string, rp aiReport, lang string) {
	b.variant(variant, docBlock{Kind: "p", Text: "**" + tr(lang, "遇到的问题", "Issue Encountered") + "**  " + firstNonEmptyStr(rp.Title, rp.Symptom) + "  " + stamp(rp.At) + "  " + rp.By})
	item := func(label, text string) {
		text = strings.TrimSpace(text)
		if text == "" {
			return
		}
		b.variant(variant, docBlock{Kind: "p", Text: "**" + label + "**"})
		fenced(b, variant, text)
	}
	item(tr(lang, "现象", "Symptom"), rp.Symptom)
	item(tr(lang, "证据", "Evidence"), rp.Evidence)
	item(tr(lang, "原因", "Cause"), rp.Cause)
	item(tr(lang, "处理", "Resolution"), rp.Fix)
	if rp.Changed {
		b.variant(variant, docBlock{Kind: "note", Text: tr(lang, "这个问题说明交付本身需要修改，请回到平台调整规格或手册后重新生成。", "This issue indicates the delivery itself requires changes; adjust the spec or runbook and regenerate.")})
	}
	if len(rp.Followups) > 0 {
		b.variant(variant, docBlock{Kind: "p", Text: "**" + tr(lang, "还要跟进", "Follow-Up Items") + "**"})
		b.variant(variant, docBlock{Kind: "list", Items: rp.Followups})
	}
}

// fenced writes text in which ``` fences mark commands: the fenced parts as code, the rest as paragraphs.
func fenced(b *docBuilder, variant, text string) {
	parts := strings.Split(text, "```")
	for i, part := range parts {
		part = strings.Trim(part, "\n")
		if strings.TrimSpace(part) == "" {
			continue
		}
		if i%2 == 1 {
			// the first line of a fence names the language
			if nl := strings.Index(part, "\n"); nl >= 0 && !strings.ContainsAny(part[:nl], " \t=") && len(part[:nl]) < 12 {
				part = part[nl+1:]
			}
			b.variant(variant, docBlock{Kind: "code", Text: strings.TrimRight(part, "\n")})
		} else {
			b.variant(variant, docBlock{Kind: "p", Text: strings.TrimSpace(part)})
		}
	}
}

// exportOptions say which parts of a report a reader asked for.
type exportOptions struct {
	Auto, Cmd, Result bool
	LogAuto, LogCmd   bool
	Detail            bool
}

func parseExportOptions(q map[string][]string) exportOptions {
	o := exportOptions{Result: true, Detail: true}
	get := func(k string) (string, bool) {
		if v, ok := q[k]; ok && len(v) > 0 {
			return v[0], true
		}
		return "", false
	}
	if v, ok := get("results"); ok {
		o.Result = v != "0"
	}
	if detail, ok := get("detail"); ok {
		o.Detail = detail == "1"
	} else if _, old := get("steps"); old {
		o.Detail = true
	}
	steps, ok := get("steps")
	if !ok {
		steps = "cmd"
	}
	for _, p := range strings.Split(steps, ",") {
		switch p {
		case variantAuto:
			o.Auto = true
		case variantCmd:
			o.Cmd = true
		}
	}
	if ls, hasLS := get("log_style"); hasLS && strings.TrimSpace(ls) != "" {
		for _, p := range strings.Split(ls, ",") {
			switch strings.TrimSpace(p) {
			case "auto", "ansible":
				o.LogAuto = true
			case "cmd", "terminal":
				o.LogCmd = true
			case "both":
				o.LogAuto, o.LogCmd = true, true
			}
		}
		if !o.LogAuto && !o.LogCmd {
			o.LogAuto = true
		}
	} else {
		// Backward compatibility: legacy calls without log_style always keep automated audit evidence,
		// and also include terminal transcripts when command-manual steps are requested.
		o.LogAuto = true
		o.LogCmd = o.Cmd
	}
	return o
}

func (o exportOptions) keeps(v string) bool {
	switch v {
	case variantAuto:
		return o.Auto
	case variantCmd:
		return o.Cmd
	case variantResult:
		return o.Result
	case variantResultAuto:
		return o.Result && o.LogAuto
	case variantResultCmd:
		return o.Result && o.LogCmd
	}
	return true
}

// filtered is the document with only the parts asked for.
func (o exportOptions) filtered(d *clusterDoc) *clusterDoc {
	c := *d
	c.Blocks = nil
	for _, blk := range d.Blocks {
		if (!blk.Detail || o.Detail) && o.keeps(blk.Variant) {
			c.Blocks = append(c.Blocks, blk)
		}
	}
	return &c
}

// exampleNote says which machine the values of a step on several machines are taken from.
func exampleNoteLang(hosts []string, lang string) string {
	if len(hosts) > 1 {
		return tr(lang, "（以 "+hosts[0]+" 为例）", " (example: "+hosts[0]+")")
	}
	return ""
}

const maxRunOutLines = 400

// runBlocks writes what the uploaded logs say a step did: the result of the run, the recap per machine and what
// each task did on each machine.
func runBlocksLang(b *docBuilder, runs []runLog, lang string) {
	if len(runs) == 0 {
		return
	}
	resText := func(res string) string {
		if isEnLang(lang) {
			return firstNonEmptyStr(map[string]string{"PASSED": "Passed", "FAILED": "Failed"}[res], "Incomplete")
		}
		return firstNonEmptyStr(map[string]string{"PASSED": "通过", "FAILED": "失败"}[res], "没有结束")
	}
	last := runs[len(runs)-1]
	res := resText(last.Result)
	b.variant(variantResultAuto, docBlock{Kind: "p", Text: tr(lang,
		fmt.Sprintf("**自动化执行**　%s　%s　结果：%s", last.File, last.Started, res),
		fmt.Sprintf("**Automated Run**  %s  %s  Result: %s", last.File, last.Started, res),
	)})
	if len(runs) > 1 {
		var items []string
		for _, r := range runs[:len(runs)-1] {
			items = append(items, fmt.Sprintf("%s  %s  %s", r.File, r.Started, resText(r.Result)))
		}
		b.variant(variantResultAuto, docBlock{Kind: "p", Text: tr(lang, "这一步此前还运行过：", "Previous runs for this step:")})
		b.variant(variantResultAuto, docBlock{Kind: "list", Items: items})
	}
	if len(last.Recap) > 0 {
		var rows [][]string
		for _, c := range last.Recap {
			rows = append(rows, []string{c.Host, fmt.Sprint(c.OK), fmt.Sprint(c.Changed), fmt.Sprint(c.Unreachable), fmt.Sprint(c.Failed), fmt.Sprint(c.Skipped)})
		}
		b.variant(variantResultAuto, docBlock{Kind: "table", Head: []string{tr(lang, "机器", "Host"), "ok", "changed", "unreachable", "failed", "skipped"}, Rows: rows})
	}
	var lines []string
	cut := false
	for _, t := range last.Tasks {
		var quiet []string
		var loud []logOutcome
		for _, o := range t.Outcomes {
			if len(o.Lines) == 0 || o.Kind == "skipped" {
				quiet = append(quiet, o.Host+"["+o.Kind+"]")
			} else {
				loud = append(loud, o)
			}
		}
		if len(lines) >= maxRunOutLines {
			cut = true
			break
		}
		lines = append(lines, "# "+t.Name)
		if len(quiet) > 0 {
			lines = append(lines, "  "+strings.Join(quiet, " "))
		}
		for _, o := range loud {
			lines = append(lines, "  "+o.Kind+" "+o.Host)
			for i, l := range o.Lines {
				if i >= 14 {
					lines = append(lines, tr(lang, fmt.Sprintf("    ……（还有 %d 行，完整内容在日志文件里）", len(o.Lines)-i), fmt.Sprintf("    ... (%d more line(s); see full log file)", len(o.Lines)-i)))
					break
				}
				lines = append(lines, "    "+l)
			}
		}
	}
	if cut {
		lines = append(lines, tr(lang, "……（后面的任务没有列出，完整内容在日志文件里）", "... (remaining tasks omitted; see full log file)"))
	}
	if len(lines) > 0 {
		b.variant(variantResultAuto, docBlock{Kind: "code", Style: "ansible", Text: strings.Join(lines, "\n")})
	}
}

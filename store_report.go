package main

import (
	"encoding/json"
	"fmt"
	"path/filepath"
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
	variantAuto   = "auto"
	variantCmd    = "cmd"
	variantResult = "result"
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
	return s.runbookStepsOf(s.jobPlan(jobID), jobID)
}

// runbookStepsOf lists the steps of a structured handbook (plan.json), with the accepted AI amendments of jobID when
// one is given.
func (s *storeServer) runbookStepsOf(raw []byte, jobID string) []reportTab {
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
	prep.Label = "环境准备"
	for i, st := range p.Prepare {
		key := fmt.Sprintf("prepare/prepare-%d", i)
		if p.StepFormat >= 2 && st.ID != "" {
			key = "prepare/" + st.ID
		}
		prep.Steps = append(prep.Steps, reportStep{Key: key, Title: st.Title, Purpose: st.Desc, Effect: st.Effect, Expect: st.Expect, Hosts: st.Hosts, Command: st.Command, Manual: true})
	}
	tabs = append(tabs, prep)
	label := "部署"
	dep := reportTab{Label: label}
	dep.Steps = append(dep.Steps, reportStep{
		Key: "deploy/deploy-bootstrap", Title: "离线安装 Ansible 并核对清单", Purpose: "引导脚本只使用随包的离线材料，不访问外网。", Effect: "change",
		Expect: "清单应列出全部机器和各实例的分组。", Hosts: []string{p.Controller}, Manual: true,
		Command: "cd " + filepath.Dir(filepath.Dir(cd)) + "\nbash bootstrap/bootstrap-ansible.sh\n" + withCd("../../bin/ansible-inventory -i inventory/hosts.yml --graph"),
	})
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
			Key: "deploy/deploy-" + ph.Phase, Title: "阶段：" + ph.Title, Purpose: strings.Join(titles, "；"), Hosts: []string{p.Controller},
			Playbook: ph.Playbook, Command: withCd(ph.Command), Parts: ph.Steps,
			Expect: "Ansible 输出末尾 failed=0、unreachable=0。",
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
	list("tests", "功能测试", p.Tests)
	list("endpoint", "入口测试", p.Endpoint)
	list("cleanup", "清理", p.Cleanup)
	// steps accepted from the assistant during the run
	var ams []aiAmendment
	if jobID != "" {
		ams = s.loadAmendments(jobID)
	}
	for _, a := range ams {
		for ti := range tabs {
			id := map[string]string{"prepare": "环境准备", "deploy": label, "tests": "功能测试", "endpoint": "入口测试", "cleanup": "清理"}[a.Phase]
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
					tabs[ti].Steps[at].Amended = "命令已按现场情况修改：" + a.Reason
				}
				continue
			}
			st := reportStep{Key: tabs[ti].keyPrefix(a.Phase) + "/ai-" + a.ID, Title: a.Step.Title, Purpose: a.Step.Desc, Effect: a.Step.Effect, Expect: a.Step.Expect, Hosts: a.Step.Hosts, Command: withCd(a.Step.Command), Manual: true, Amended: "现场新增：" + a.Reason}
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

func hostLine(hosts []string) string {
	if len(hosts) == 0 {
		return "控制节点"
	}
	return strings.Join(hosts, " / ")
}

// header is the first line of a code block, in the manuals' style: where it runs, as whom, and what it is for.
func header(hosts []string, what string) string {
	return "# " + hostLine(hosts) + " root  " + strings.ReplaceAll(strings.TrimSpace(what), "\n", " ")
}

func (b *docBuilder) variant(v string, blk docBlock) {
	blk.Variant = v
	b.blocks = append(b.blocks, blk)
}

// stepReport writes every step of the delivery's runbook with its result. Steps nobody recorded show as not done.
func (s *storeServer) stepReport(b *docBuilder, level int, j storeJob) bool {
	start := len(b.blocks)
	defer func() {
		for i := start; i < len(b.blocks); i++ {
			b.blocks[i].Detail = true
		}
	}()
	tabs := s.runbookSteps(j.ID)
	if len(tabs) == 0 {
		return false
	}
	_, prog := s.execRecord(j.ID)
	logs := s.runLogs(j.ID)
	b.variant(variantCmd, docBlock{Kind: "note", Text: "命令里的部署参数（目录、端口、地址等）已按本次规格代入，多台机器的步骤以第一台为例，其余机器把主机名和地址换成自己的；写成 <…> 的是执行时才产生的值（上一条命令的输出等，见下面的执行结果），密码不写进报告，见控制节点 secrets/ 目录。以 # 开头的行说明这一步在做什么，不是要输入的命令。"})
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
		b.h(hl(level+1), fmt.Sprintf("%d　%s", ti+1, t.Label))
		for si, st := range t.Steps {
			b.h(hl(level+2), fmt.Sprintf("%d.%d　%s", ti+1, si+1, st.Title))
			b.variant("", docBlock{Kind: "p", Text: "位置：" + hostLine(st.Hosts) + "　　影响：" + firstNonEmptyStr(effectWords[st.Effect], "—")})
			if st.Purpose != "" && st.Manual || len(st.Parts) == 1 && st.Purpose != "" {
				b.variant("", docBlock{Kind: "p", Text: st.Purpose})
			}
			if st.Amended != "" {
				b.variant("", docBlock{Kind: "note", Text: st.Amended})
			}
			// automation: the YAML that is run
			switch {
			case st.Manual:
				b.variant("", docBlock{Kind: "code", Text: header(st.Hosts, st.Title) + "\n" + st.Command})
			default:
				b.variant(variantAuto, docBlock{Kind: "code", Text: header([]string{"控制节点"}, "执行 "+st.Playbook) + "\n" + st.Command})
				if len(st.Parts) > 1 {
					var items []string
					for _, p := range st.Parts {
						items = append(items, strings.TrimSpace(map[bool]string{true: "[" + p.Instance + "] ", false: ""}[p.Instance != ""]+p.Title)+"（"+hostLine(p.Hosts)+"）")
					}
					b.variant(variantAuto, docBlock{Kind: "p", Text: "这份 Playbook 依次完成："})
					b.variant(variantAuto, docBlock{Kind: "list", Items: items})
				}
				// the same tasks as commands, machine by machine
				any := false
				for _, p := range st.Parts {
					var lines []string
					for _, a := range p.Actions {
						cond := ""
						if a.When != "" && len([]rune(a.When)) <= 100 {
							cond = "（仅当 " + a.When + "）"
						}
						if strings.TrimSpace(a.Cmd) == "" {
							if a.Check && strings.TrimSpace(a.Name) != "" {
								lines = append(lines, "# 核对："+strings.ReplaceAll(a.Name, "\n", " ")+cond)
							}
							continue
						}
						lines = append(lines, "# "+strings.ReplaceAll(a.Name, "\n", " ")+cond+"\n"+a.Cmd)
					}
					if len(lines) == 0 {
						continue
					}
					any = true
					who := strings.TrimSpace(map[bool]string{true: "[" + p.Instance + "] ", false: ""}[p.Instance != ""] + p.Title)
					b.variant(variantCmd, docBlock{Kind: "code", Text: header(p.Hosts, who+exampleNote(p.Hosts)) + "\n" + strings.Join(lines, "\n")})
				}
				if !any {
					b.variant(variantCmd, docBlock{Kind: "p", Text: "这一步由 Playbook 完成，没有可单列的手工命令：" + st.Command})
				}
			}
			if st.Expect != "" {
				b.variant("", docBlock{Kind: "p", Text: "✓ 判据：" + st.Expect})
			}
			// what was run before a sync replaced this step: kept, struck through, so the report tells all of it
			for _, old := range prog.Superseded[st.Key] {
				var items []string
				rec := old.Record
				if rec.State != "" || rec.Note != "" {
					items = append(items, strings.TrimSpace(fmt.Sprintf("执行结果：%s　%s　%s　%s", firstNonEmptyStr(stepStates[rec.State], "没有标记结果"), rec.By, stamp(rec.At), rec.Note)))
				}
				if rec.Log != "" {
					items = append(items, "输出："+truncRunes(rec.Log, 600))
				}
				b.variant("", docBlock{Kind: "old", Title: fmt.Sprintf("旧版本（第 %d 次按最新组件同步前，%s），已被本步骤的新版本取代：%s", old.Sync, stamp(old.At), old.Title), Text: old.Command, Items: items})
			}
			s.resultBlocks(b, j.ID, st.Key, prog)
			runBlocks(b, stepRuns(logs, st.Playbook))
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
		b.h(hl(level+1), "其他记录")
		for i, st := range extra {
			b.h(hl(level+2), fmt.Sprintf("%d　%s", i+1, st.Title))
			s.resultBlocks(b, j.ID, st.Key, prog)
		}
	}
	return true
}

func (s *storeServer) resultBlocks(b *docBuilder, job, key string, prog progressDoc) {
	rec, ok := prog.Steps[key]
	if !ok {
		b.variant(variantResult, docBlock{Kind: "note", Text: "执行结果：尚未记录"})
		return
	}
	label := firstNonEmptyStr(stepStates[rec.State], "没有标记结果")
	b.variant(variantResult, docBlock{Kind: "p", Text: fmt.Sprintf("**执行结果**　%s　%s　%s", label, rec.By, stamp(rec.At))})
	if rec.Note != "" {
		b.variant(variantResult, docBlock{Kind: "p", Text: rec.Note})
	}
	// what came from a log is written out in full by runBlocks
	if strings.TrimSpace(rec.Log) != "" && rec.By != runLogBy {
		log := strings.TrimRight(rec.Log, "\n")
		if r := []rune(log); len(r) > 12000 {
			log = "……（只保留末尾 12000 字，完整输出在平台的执行记录里）\n" + string(r[len(r)-12000:])
		}
		b.variant(variantResult, docBlock{Kind: "code", Text: log})
	}
	if len(rec.Images) > 0 {
		b.variant(variantResult, docBlock{Kind: "image", Items: rec.Images, Job: job})
	}
	// a problem met on this step and how it was solved belongs right here
	for _, rp := range prog.Reports {
		if rp.Key == "step:"+key {
			writeUpBlocks(b, variantResult, rp)
		}
	}
}

// writeUpBlocks writes a problem and its solution: what happened, why, what was done (commands as code), what is left.
func writeUpBlocks(b *docBuilder, variant string, rp aiReport) {
	b.variant(variant, docBlock{Kind: "p", Text: "**遇到的问题**　" + firstNonEmptyStr(rp.Title, rp.Symptom) + "　" + stamp(rp.At) + "　" + rp.By})
	item := func(label, text string) {
		text = strings.TrimSpace(text)
		if text == "" {
			return
		}
		b.variant(variant, docBlock{Kind: "p", Text: "**" + label + "**"})
		fenced(b, variant, text)
	}
	item("现象", rp.Symptom)
	item("证据", rp.Evidence)
	item("原因", rp.Cause)
	item("处理", rp.Fix)
	if rp.Changed {
		b.variant(variant, docBlock{Kind: "note", Text: "这个问题说明交付本身需要修改，请回到平台调整规格或手册后重新生成。"})
	}
	if len(rp.Followups) > 0 {
		b.variant(variant, docBlock{Kind: "p", Text: "**还要跟进**"})
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
func exampleNote(hosts []string) string {
	if len(hosts) > 1 {
		return "（以 " + hosts[0] + " 为例）"
	}
	return ""
}

const maxRunOutLines = 400

// runBlocks writes what the uploaded logs say a step did: the result of the run, the recap per machine and what
// each task did on each machine.
func runBlocks(b *docBuilder, runs []runLog) {
	if len(runs) == 0 {
		return
	}
	last := runs[len(runs)-1]
	res := map[string]string{"PASSED": "通过", "FAILED": "失败"}[last.Result]
	if res == "" {
		res = "没有结束"
	}
	b.variant(variantResult, docBlock{Kind: "p", Text: fmt.Sprintf("**自动化执行**　%s　%s　结果：%s", last.File, last.Started, res)})
	if len(runs) > 1 {
		var items []string
		for _, r := range runs[:len(runs)-1] {
			items = append(items, fmt.Sprintf("%s　%s　%s", r.File, r.Started, firstNonEmptyStr(map[string]string{"PASSED": "通过", "FAILED": "失败"}[r.Result], "没有结束")))
		}
		b.variant(variantResult, docBlock{Kind: "p", Text: "这一步此前还运行过："})
		b.variant(variantResult, docBlock{Kind: "list", Items: items})
	}
	if len(last.Recap) > 0 {
		var rows [][]string
		for _, c := range last.Recap {
			rows = append(rows, []string{c.Host, fmt.Sprint(c.OK), fmt.Sprint(c.Changed), fmt.Sprint(c.Unreachable), fmt.Sprint(c.Failed), fmt.Sprint(c.Skipped)})
		}
		b.variant(variantResult, docBlock{Kind: "table", Head: []string{"机器", "ok", "changed", "unreachable", "failed", "skipped"}, Rows: rows})
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
					lines = append(lines, fmt.Sprintf("    ……（还有 %d 行，完整内容在日志文件里）", len(o.Lines)-i))
					break
				}
				lines = append(lines, "    "+l)
			}
		}
	}
	if cut {
		lines = append(lines, "……（后面的任务没有列出，完整内容在日志文件里）")
	}
	if len(lines) > 0 {
		b.variant(variantResult, docBlock{Kind: "code", Text: strings.Join(lines, "\n")})
	}
}

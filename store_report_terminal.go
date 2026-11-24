package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"middleware-deployer/mwpack"
)

const (
	maxTerminalLines     = 180
	maxTerminalTaskLines = 48
)

type terminalMeta struct {
	Started  string
	Finished string
	State    string
	ExitCode *int
	Hosts    []string
	Message  string
}

func (s *storeServer) jobHostIPs(jobID string) map[string]string {
	out := map[string]string{}
	if p := s.solvedJob(jobID); p != nil {
		for _, h := range p.Hosts {
			if h.Name != "" && h.IP != "" {
				out[h.Name] = h.IP
			}
		}
		if p.Dep.ExecutionHost != nil && p.Dep.ExecutionHost.Name != "" && p.Dep.ExecutionHost.IP != "" {
			out[p.Dep.ExecutionHost.Name] = p.Dep.ExecutionHost.IP
		}
	}
	return out
}

func formatHostWithIP(host string, hostIPs map[string]string) string {
	h := strings.TrimSpace(host)
	if h == "" {
		return ""
	}
	if ip := strings.TrimSpace(hostIPs[h]); ip != "" && !strings.Contains(h, ip) {
		return fmt.Sprintf("%s (%s)", h, ip)
	}
	return h
}

func hostLineWithIPLang(hosts []string, hostIPs map[string]string, lang string) string {
	if len(hosts) == 0 {
		return tr(lang, "控制节点", "Controller")
	}
	parts := make([]string, 0, len(hosts))
	for _, h := range hosts {
		parts = append(parts, formatHostWithIP(h, hostIPs))
	}
	return strings.Join(parts, " / ")
}

func headerWithIPLang(hosts []string, hostIPs map[string]string, what, lang string) string {
	return "# " + hostLineWithIPLang(hosts, hostIPs, lang) + " root  " + strings.ReplaceAll(strings.TrimSpace(what), "\n", " ")
}

// latestExecutionSteps returns the latest automated execution step (and its run ID) per step key for a job.
func (s *storeServer) latestExecutionSteps(jobID string) map[string]struct {
	RunID string
	Step  executionStep
} {
	out := map[string]struct {
		RunID string
		Step  executionStep
	}{}
	d, err := s.readExecutions()
	if err != nil {
		return out
	}
	revision := s.executionRevision(jobID)
	type runPair struct {
		created string
		run     executionRun
	}
	var runs []runPair
	for _, r := range d.Runs {
		if r.Job != jobID {
			continue
		}
		runs = append(runs, runPair{created: r.Created, run: r})
	}
	// Stable chronological order so newer attempts overwrite older ones; current-revision runs take precedence in pass 2.
	for i := 0; i < len(runs); i++ {
		for k := i + 1; k < len(runs); k++ {
			if runs[k].created < runs[i].created {
				runs[i], runs[k] = runs[k], runs[i]
			}
		}
	}
	collect := func(onlyCurrent bool) {
		for _, rp := range runs {
			if onlyCurrent && revision != "" && rp.run.Revision != "" && rp.run.Revision != revision {
				continue
			}
			for _, st := range rp.run.Steps {
				if st.Seq == 0 && st.Finished == "" && st.State == "pending" {
					continue
				}
				out[st.Key] = struct {
					RunID string
					Step  executionStep
				}{RunID: rp.run.ID, Step: st}
			}
		}
	}
	collect(false)
	collect(true)
	return out
}

func stripRolePrefix(taskName string) string {
	t := strings.TrimSpace(taskName)
	if idx := strings.Index(t, " : "); idx > 0 {
		return strings.TrimSpace(t[idx+3:])
	}
	return t
}

func isBoilerplateTask(cleanName string) bool {
	if strings.HasPrefix(cleanName, "必须带 -e confirm_cluster=") {
		return true
	}
	switch cleanName {
	case "核对步骤输入与前置条件",
		"核对步骤完成条件",
		"测试日志位置（在实际执行节点查看）",
		"测试输出（成功或失败均显示）",
		"测试目录",
		"分发公共测试运行库",
		"分发测试程序",
		"分发测试配置（含账户密码）",
		"软件包规格",
		"安装软件包":
		return true
	}
	return false
}

func isMaskedTask(cleanName string) bool {
	return cleanName == "［已隐去］" || cleanName == "[已隐去]" || strings.Contains(cleanName, "［已隐去］")
}

func isFailedOutcome(kind string) bool {
	return strings.HasPrefix(kind, "FAILED") || kind == "UNREACHABLE"
}

type parsedOutcome struct {
	Stdout []string
	Stderr []string
	Msgs   []string
	Items  []string
	Hidden bool
	RC     string
}

// parseTerminalOutcome extracts clean stdout, stderr, meaningful msg, and item statuses from mw_log.py outcome lines,
// discarding Ansible internal telemetry (delta, start, end, ansible_job_id, finished).
func parseTerminalOutcome(lines []string) parsedOutcome {
	var po parsedOutcome
	mode := "" // "" | "stdout" | "stderr" | "msg"
	for _, raw := range lines {
		trim := strings.TrimSpace(raw)
		if trim == "" {
			if mode == "stdout" {
				po.Stdout = append(po.Stdout, "")
			} else if mode == "stderr" {
				po.Stderr = append(po.Stderr, "")
			}
			continue
		}
		// Indented continuation of a multi-line stdout/stderr/msg block.
		if strings.HasPrefix(raw, "  ") && mode != "" {
			cont := strings.TrimPrefix(raw, "  ")
			switch mode {
			case "stdout":
				po.Stdout = append(po.Stdout, cont)
			case "stderr":
				po.Stderr = append(po.Stderr, cont)
			case "msg":
				po.Msgs = append(po.Msgs, cont)
			}
			continue
		}
		mode = ""
		switch {
		case trim == "(output hidden: no_log)":
			po.Hidden = true
		case strings.HasPrefix(trim, "delta:"),
			strings.HasPrefix(trim, "start:"),
			strings.HasPrefix(trim, "end:"),
			strings.HasPrefix(trim, "ansible_job_id:"),
			strings.HasPrefix(trim, "finished:"):
			continue
		case trim == "stdout:":
			mode = "stdout"
		case strings.HasPrefix(trim, "stdout: "):
			v := strings.TrimPrefix(trim, "stdout: ")
			if strings.TrimSpace(v) != "" {
				po.Stdout = append(po.Stdout, v)
			}
		case trim == "stderr:":
			mode = "stderr"
		case strings.HasPrefix(trim, "stderr: "):
			v := strings.TrimPrefix(trim, "stderr: ")
			if strings.TrimSpace(v) != "" {
				po.Stderr = append(po.Stderr, v)
			}
		case strings.HasPrefix(trim, "rc: "):
			po.RC = strings.TrimSpace(strings.TrimPrefix(trim, "rc: "))
		case trim == "msg:":
			mode = "msg"
		case strings.HasPrefix(trim, "msg: "):
			v := strings.TrimSpace(strings.TrimPrefix(trim, "msg: "))
			for _, m := range unpackMsgLines(v) {
				if isBoilerplateMsg(m) {
					continue
				}
				po.Msgs = append(po.Msgs, m)
			}
		case strings.HasPrefix(trim, "item "):
			po.Items = append(po.Items, trim)
		default:
			if !isBoilerplateMsg(trim) {
				po.Msgs = append(po.Msgs, trim)
			}
		}
	}
	// Trim trailing empty stdout/stderr lines.
	for len(po.Stdout) > 0 && strings.TrimSpace(po.Stdout[len(po.Stdout)-1]) == "" {
		po.Stdout = po.Stdout[:len(po.Stdout)-1]
	}
	for len(po.Stderr) > 0 && strings.TrimSpace(po.Stderr[len(po.Stderr)-1]) == "" {
		po.Stderr = po.Stderr[:len(po.Stderr)-1]
	}
	return po
}

func isBoilerplateMsg(m string) bool {
	t := strings.TrimSpace(m)
	return t == "" || t == "All assertions passed" || t == "All paths examined"
}

// unpackMsgLines flattens JSON arrays emitted by Ansible debug msg fields into readable plain lines.
func unpackMsgLines(v string) []string {
	t := strings.TrimSpace(v)
	if !strings.HasPrefix(t, "[") || !strings.HasSuffix(t, "]") {
		return []string{t}
	}
	var arr []any
	if json.Unmarshal([]byte(t), &arr) != nil {
		return []string{t}
	}
	var out []string
	var walk func(x any)
	walk = func(x any) {
		switch tv := x.(type) {
		case string:
			if strings.TrimSpace(tv) != "" {
				out = append(out, tv)
			}
		case []any:
			for _, sub := range tv {
				walk(sub)
			}
		}
	}
	for _, x := range arr {
		walk(x)
	}
	if len(out) == 0 {
		return []string{t}
	}
	return out
}

// matchActionForTask finds the distilled Linux shell Action corresponding to an Ansible logTask name.
func matchActionForTask(actions []mwpack.Action, used []bool, rawTaskName string) (mwpack.Action, bool) {
	clean := stripRolePrefix(rawTaskName)
	if clean == "" {
		return mwpack.Action{}, false
	}
	// 1. Prefer unused exact match so repeated tasks match in execution order.
	for i, a := range actions {
		if !used[i] && strings.TrimSpace(a.Name) == clean {
			used[i] = true
			return a, true
		}
	}
	// 2. Fallback to any exact match.
	for _, a := range actions {
		if strings.TrimSpace(a.Name) == clean {
			return a, true
		}
	}
	// 3. Prefix/contains match for tasks whose name carries runtime interpolation.
	for i, a := range actions {
		an := strings.TrimSpace(a.Name)
		if an == "" {
			continue
		}
		if !used[i] && (strings.HasPrefix(clean, an) || strings.HasPrefix(an, clean)) {
			used[i] = true
			return a, true
		}
	}
	return mwpack.Action{}, false
}

func isRunnableShellCmd(cmd string) bool {
	t := strings.TrimSpace(cmd)
	if t == "" {
		return false
	}
	for _, ln := range strings.Split(t, "\n") {
		s := strings.TrimSpace(ln)
		if s != "" && !strings.HasPrefix(s, "#") {
			return true
		}
	}
	return false
}

func formatPromptedCommand(host, cmd string) []string {
	prompt := fmt.Sprintf("[root@%s ~]# ", firstNonEmptyStr(host, "localhost"))
	raw := strings.TrimSpace(strings.ReplaceAll(cmd, "\r\n", "\n"))
	lines := strings.Split(raw, "\n")
	if len(lines) == 1 {
		return []string{prompt + strings.TrimSpace(lines[0])}
	}
	// Keep heredoc or line-continued commands grouped under a single prompt.
	if strings.Contains(raw, "<<") || strings.Contains(raw, "\\\n") || len(lines) > 4 {
		out := []string{prompt + strings.TrimSpace(lines[0])}
		out = append(out, lines[1:]...)
		return out
	}
	var out []string
	for _, ln := range lines {
		s := strings.TrimSpace(ln)
		if s == "" {
			continue
		}
		if strings.HasPrefix(s, "#") {
			out = append(out, s)
		} else {
			out = append(out, prompt+s)
		}
	}
	return out
}

func appendTrimmedLines(dst *[]string, src []string, limit int, lang string) {
	if len(src) <= limit {
		*dst = append(*dst, src...)
		return
	}
	head := limit * 2 / 3
	tail := limit - head
	*dst = append(*dst, src[:head]...)
	*dst = append(*dst, tr(lang,
		fmt.Sprintf("... (中间省略 %d 行，共 %d 行输出)", len(src)-head-tail, len(src)),
		fmt.Sprintf("... (%d lines omitted out of %d total)", len(src)-head-tail, len(src)),
	))
	*dst = append(*dst, src[len(src)-tail:]...)
}

// buildTerminalTranscript converts a parsed mw_log runLog and its runbook step actions into a clean,
// 100%-factual Linux terminal execution log ([root@host ~]# cmd + real stdout/stderr).
func buildTerminalTranscript(st reportStep, rl runLog, hostIPs map[string]string, meta terminalMeta, lang string) string {
	var allActions []mwpack.Action
	for _, p := range st.Parts {
		allActions = append(allActions, p.Actions...)
	}
	used := make([]bool, len(allActions))

	// Build concise terminal session header from real execution metadata.
	var hdrParts []string
	if ts := firstNonEmptyStr(rl.Started, stamp(meta.Started)); ts != "" {
		hdrParts = append(hdrParts, ts)
	}
	hostList := meta.Hosts
	if len(hostList) == 0 {
		for _, r := range rl.Recap {
			if r.Host != "" {
				hostList = append(hostList, r.Host)
			}
		}
	}
	if len(hostList) == 0 {
		hostList = st.Hosts
	}
	if len(hostList) > 0 {
		formatted := make([]string, 0, len(hostList))
		for _, h := range hostList {
			formatted = append(formatted, formatHostWithIP(h, hostIPs))
		}
		hdrParts = append(hdrParts, tr(lang, "节点：", "Hosts: ")+strings.Join(formatted, ", "))
	}
	statusTxt := rl.Result
	if statusTxt == "" {
		switch meta.State {
		case "succeeded":
			statusTxt = "PASSED"
		case "failed", "interrupted":
			statusTxt = "FAILED"
		case "skipped":
			statusTxt = "SKIPPED"
		}
	}
	if statusTxt != "" {
		if meta.ExitCode != nil {
			hdrParts = append(hdrParts, fmt.Sprintf("%s (exit %d)", statusTxt, *meta.ExitCode))
		} else {
			hdrParts = append(hdrParts, statusTxt)
		}
	}

	var lines []string
	if len(hdrParts) > 0 {
		lines = append(lines, "# "+strings.Join(hdrParts, "  ·  "))
	}

	bodyStart := len(lines)
	maskedCount := 0
	maskedHosts := map[string]bool{}
	flushMasked := func() {
		if maskedCount == 0 {
			return
		}
		var hs []string
		for h := range maskedHosts {
			hs = append(hs, h)
		}
		lines = append(lines, "", tr(lang,
			fmt.Sprintf("# [%s] 执行 %d 项密钥/脱敏任务（敏感内容已自动隐藏）  [OK]", strings.Join(hs, ", "), maskedCount),
			fmt.Sprintf("# [%s] Executed %d redacted secret task(s) (output hidden)  [OK]", strings.Join(hs, ", "), maskedCount),
		))
		maskedCount = 0
		maskedHosts = map[string]bool{}
	}

	truncated := false
	for _, t := range rl.Tasks {
		if len(lines) >= maxTerminalLines {
			truncated = true
			break
		}
		cleanName := stripRolePrefix(t.Name)
		anyFail := false
		var active []logOutcome
		for _, o := range t.Outcomes {
			if isFailedOutcome(o.Kind) {
				anyFail = true
			}
			if o.Kind != "skipped" {
				active = append(active, o)
			}
		}
		if len(active) == 0 {
			continue
		}
		if !anyFail && isBoilerplateTask(cleanName) {
			continue
		}
		if !anyFail && isMaskedTask(cleanName) {
			maskedCount++
			for _, o := range active {
				if o.Host != "" {
					maskedHosts[o.Host] = true
				}
			}
			continue
		}
		flushMasked()

		act, matched := matchActionForTask(allActions, used, t.Name)
		hasCmd := matched && isRunnableShellCmd(act.Cmd) && !isInternalWrapperCmd(act.Cmd)

		// Parse outcomes per host so we can group silent identical outcomes cleanly.
		type hostOut struct {
			o  logOutcome
			po parsedOutcome
		}
		var outs []hostOut
		allSilent := true
		for _, o := range active {
			po := parseTerminalOutcome(o.Lines)
			if len(po.Stdout) > 0 || len(po.Stderr) > 0 || len(po.Msgs) > 0 || isFailedOutcome(o.Kind) {
				allSilent = false
			}
			outs = append(outs, hostOut{o: o, po: po})
		}

		// Case 1: Real shell command matched from plan actions.
		if hasCmd {
			for _, ho := range outs {
				if len(lines) >= maxTerminalLines {
					truncated = true
					break
				}
				lines = append(lines, "")
				lines = append(lines, formatPromptedCommand(ho.o.Host, act.Cmd)...)
				if len(ho.po.Stdout) > 0 {
					appendTrimmedLines(&lines, ho.po.Stdout, maxTerminalTaskLines, lang)
				}
				if len(ho.po.Stderr) > 0 {
					for _, e := range ho.po.Stderr {
						lines = append(lines, "stderr: "+e)
					}
				}
				if len(ho.po.Msgs) > 0 && (len(ho.po.Stdout) == 0 || isFailedOutcome(ho.o.Kind)) {
					for _, m := range ho.po.Msgs {
						lines = append(lines, m)
					}
				}
				if ho.po.Hidden && len(ho.po.Stdout) == 0 {
					lines = append(lines, tr(lang, "[敏感输出已脱敏隐藏]", "[sensitive output redacted]"))
				}
				if isFailedOutcome(ho.o.Kind) {
					rcNote := ""
					if ho.po.RC != "" {
						rcNote = " (rc=" + ho.po.RC + ")"
					}
					lines = append(lines, fmt.Sprintf("[%s]%s", ho.o.Kind, rcNote))
				}
			}
			continue
		}

		// Case 2: Assertion / check task (or non-shell module) with meaningful output or failure.
		if !allSilent {
			for _, ho := range outs {
				if len(lines) >= maxTerminalLines {
					truncated = true
					break
				}
				if len(ho.po.Stdout) == 0 && len(ho.po.Stderr) == 0 && len(ho.po.Msgs) == 0 && !isFailedOutcome(ho.o.Kind) {
					continue
				}
				lines = append(lines, "")
				if isFailedOutcome(ho.o.Kind) {
					lines = append(lines, fmt.Sprintf("# ✗ [%s] %s  [%s]", ho.o.Host, cleanName, ho.o.Kind))
				} else if act.Check {
					lines = append(lines, fmt.Sprintf("# ✓ [%s] %s：%s", ho.o.Host, tr(lang, "校验通过", "Verified"), cleanName))
				} else {
					lines = append(lines, fmt.Sprintf("# [%s] %s", ho.o.Host, cleanName))
				}
				if len(ho.po.Stdout) > 0 {
					appendTrimmedLines(&lines, ho.po.Stdout, maxTerminalTaskLines, lang)
				}
				if len(ho.po.Msgs) > 0 {
					appendTrimmedLines(&lines, ho.po.Msgs, maxTerminalTaskLines, lang)
				}
				if len(ho.po.Stderr) > 0 {
					for _, e := range ho.po.Stderr {
						lines = append(lines, "stderr: "+e)
					}
				}
				if isFailedOutcome(ho.o.Kind) && ho.po.RC != "" {
					lines = append(lines, fmt.Sprintf("[exit code: %s]", ho.po.RC))
				}
			}
			continue
		}

		// Case 3: Silent successful non-shell module (e.g., template render, file permissions, service start).
		var changedHosts []string
		for _, ho := range outs {
			if ho.o.Kind == "changed" {
				changedHosts = append(changedHosts, ho.o.Host)
			}
		}
		if len(changedHosts) > 0 {
			lines = append(lines, "", fmt.Sprintf("# [%s] %s  [OK · changed]", strings.Join(changedHosts, ", "), cleanName))
		}
	}
	flushMasked()

	if truncated {
		lines = append(lines, "", tr(lang,
			"# ... 输出较长已按摘要截断，完整原始日志请切换「Ansible 日志」查看",
			"# ... output truncated for readability; switch to Ansible Log for full raw transcript",
		))
	}

	// Fallback if log only contained a summary/recap or free-form lines.
	if len(lines) == bodyStart {
		if len(rl.Recap) > 0 {
			var parts []string
			for _, c := range rl.Recap {
				parts = append(parts, fmt.Sprintf("%s: ok=%d changed=%d failed=%d", c.Host, c.OK, c.Changed, c.Failed))
			}
			lines = append(lines, "", "# ✓ "+tr(lang, "执行完成：", "Completed: ")+strings.Join(parts, " ; "))
		} else if strings.TrimSpace(meta.Message) != "" {
			lines = append(lines, "", "# "+strings.TrimSpace(meta.Message))
		}
	}

	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func looksLikeTerminalLog(log string) bool {
	t := strings.TrimSpace(log)
	return strings.HasPrefix(t, "[root@") || strings.HasPrefix(t, "root@") || strings.HasPrefix(t, "$ ")
}

// formatManualTerminalLog wraps a manual on-site command log into a clean Linux terminal session block
// using the step's real host and command when the log itself does not already carry a shell prompt.
func formatManualTerminalLog(st reportStep, hostIPs map[string]string, rawLog string, lang string) string {
	body := strings.TrimRight(strings.ReplaceAll(rawLog, "\r\n", "\n"), "\n")
	if strings.TrimSpace(body) == "" {
		return ""
	}
	if looksLikeTerminalLog(body) {
		return body
	}
	host := "localhost"
	if len(st.Hosts) > 0 && strings.TrimSpace(st.Hosts[0]) != "" {
		host = strings.TrimSpace(st.Hosts[0])
	}
	var cmdLines []string
	if !isInternalWrapperCmd(st.Command) {
		for _, ln := range strings.Split(strings.ReplaceAll(st.Command, "\r\n", "\n"), "\n") {
			s := strings.TrimSpace(ln)
			if s == "" || strings.HasPrefix(s, "#") {
				continue
			}
			cmdLines = append(cmdLines, s)
		}
	}
	var head []string
	if ip := strings.TrimSpace(hostIPs[host]); ip != "" {
		head = append(head, fmt.Sprintf("# %s (%s) root  %s", host, ip, st.Title))
	}
	switch {
	case len(cmdLines) == 1:
		head = append(head, fmt.Sprintf("[root@%s ~]# %s", host, cmdLines[0]))
	case len(cmdLines) == 2 && !strings.Contains(cmdLines[0], "if ") && !strings.Contains(cmdLines[1], "fi"):
		head = append(head, fmt.Sprintf("[root@%s ~]# %s && %s", host, cmdLines[0], cmdLines[1]))
	default:
		head = append(head, fmt.Sprintf("[root@%s ~]# # %s", host, st.Title))
	}
	return strings.Join(head, "\n") + "\n" + body
}

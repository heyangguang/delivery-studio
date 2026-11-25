package server

import (
	"fmt"
	"sort"
	"strings"
)

var executionStateNames = map[string]string{"queued": "等待执行", "pending": "未执行", "leased": "已授权，等待启动", "running": "正在执行", "paused": "已暂停", "unknown": "现场状态待核实", "succeeded": "完成检查通过", "completed": "所选步骤结束", "failed": "失败", "skipped": "未执行：条件不满足", "closed": "结束批次", "interrupted": "已确认中断"}

func init() { executionStateNames["blocked"] = "准备受阻，命令未启动" }

func executionStateLabel(lang, state string) string {
	if isEnLang(lang) {
		return map[string]string{
			"queued":      "Queued",
			"pending":     "Pending",
			"leased":      "Authorized, Starting",
			"running":     "Running",
			"paused":      "Paused",
			"unknown":     "Status Unverified",
			"succeeded":   "Passed Verification",
			"completed":   "Batch Completed",
			"failed":      "Failed",
			"skipped":     "Skipped: Condition Unmet",
			"closed":      "Batch Closed",
			"interrupted": "Interrupted",
			"blocked":     "Preflight Blocked (Not Started)",
		}[state]
	}
	return executionStateNames[state]
}

func (s *storeServer) executionSummary(b *docBuilder, level int, j storeJob, prog progressDoc, langOpt ...string) {
	lang := ""
	if len(langOpt) > 0 {
		lang = langOpt[0]
	}
	tabs := s.runbookStepsLang(j.ID, lang)
	if len(tabs) == 0 {
		b.note(tr(lang, "本次为配置或资料交付，没有自动运行安装或验证任务。", "Configuration/artifact delivery only; no automated install or verification tasks ran."))
		return
	}
	b.h(level+1, tr(lang, "执行结果摘要", "Execution Summary"))
	d, e := s.readExecutions()
	if e != nil {
		b.note(tr(lang, "自动执行证据暂时不可读，不能据此确认执行成功。", "Automated execution evidence is currently unreadable and cannot verify completion."))
	}
	runs := []executionRun{}
	for _, r := range d.Runs {
		if r.Job == j.ID {
			runs = append(runs, r)
		}
	}
	sort.Slice(runs, func(i, k int) bool { return runs[i].Created < runs[k].Created })
	latest := map[string]executionStep{}
	revision := s.executionRevision(j.ID)
	for _, r := range runs {
		if r.Revision != "" && r.Revision != revision {
			continue
		}
		for _, st := range r.Steps {
			latest[st.Key] = st
		}
	}
	rows := [][]string{}
	pending, failed, verified, manual, imported, skipped := 0, 0, 0, 0, 0, 0
	for _, tab := range tabs {
		for _, st := range tab.Steps {
			rec := prog.Steps[st.Key]
			status := firstNonEmptyStr(stepStateLabel(lang, rec.State), tr(lang, "未记录结果", "Not recorded"))
			source := tr(lang, "人工填写", "Manual entry")
			at := rec.At
			if rec.Source == "automatic" {
				source = tr(lang, "执行节点回传", "Execution node")
			}
			if rec.Source == "imported" || rec.By == runLogBy {
				source = tr(lang, "上传的执行日志", "Uploaded execution log")
			}
			auto, has := latest[st.Key]
			// An active/uncertain attempt takes precedence over an earlier manual success.
			if has && (firstNonEmptyStr(auto.Returned, auto.Finished) > rec.At || auto.Finished == "" || rec.Attempt == auto.ID) {
				status = executionStateLabel(lang, auto.State)
				source = tr(lang, "执行节点回传", "Execution node")
				at = firstNonEmptyStr(auto.Finished, auto.Started)
				switch auto.State {
				case "succeeded":
					verified++
				case "failed", "interrupted":
					failed++
				case "skipped":
					skipped++
				default:
					pending++
				}
			} else {
				switch rec.State {
				case "done", "resolved":
					if rec.Source == "automatic" {
						verified++
					} else if rec.Source == "imported" || rec.By == runLogBy {
						imported++
					} else {
						manual++
					}
				case "failed":
					failed++
				case "skipped":
					skipped++
				default:
					pending++
					source = "—"
				}
			}
			rows = append(rows, []string{tab.Label + " · " + st.Title, status, source, stamp(at)})
		}
	}
	totalSteps := verified + imported + manual + failed + skipped + pending
	var summaryParts []string
	if verified > 0 {
		summaryParts = append(summaryParts, tr(lang, fmt.Sprintf("执行节点验证通过 %d 步", verified), fmt.Sprintf("passed via execution node: %d", verified)))
	}
	if imported > 0 {
		summaryParts = append(summaryParts, tr(lang, fmt.Sprintf("上传日志验证通过 %d 步", imported), fmt.Sprintf("passed via uploaded logs: %d", imported)))
	}
	if manual > 0 {
		summaryParts = append(summaryParts, tr(lang, fmt.Sprintf("人工确认通过 %d 步", manual), fmt.Sprintf("manually confirmed: %d", manual)))
	}
	if skipped > 0 {
		summaryParts = append(summaryParts, tr(lang, fmt.Sprintf("已跳过 %d 步", skipped), fmt.Sprintf("skipped: %d", skipped)))
	}
	if failed > 0 {
		summaryParts = append(summaryParts, tr(lang, fmt.Sprintf("失败 %d 步", failed), fmt.Sprintf("failed: %d", failed)))
	}
	if pending > 0 {
		summaryParts = append(summaryParts, tr(lang, fmt.Sprintf("待完成或待核实 %d 步", pending), fmt.Sprintf("pending or unverified: %d", pending)))
	}
	if totalSteps > 0 && len(summaryParts) > 0 {
		b.p(tr(lang,
			fmt.Sprintf("共 %d 步：%s。", totalSteps, strings.Join(summaryParts, "；")),
			fmt.Sprintf("Total %d step(s): %s.", totalSteps, strings.Join(summaryParts, "; ")),
		))
	}
	if failed > 0 || pending > 0 {
		b.note(tr(lang, "仍有失败、未完成或待核实事项，当前记录不能作为全部验收通过的证明。", "Failures, pending items, or unverified steps remain; this record does not certify full acceptance."))
	}
	b.table([]string{tr(lang, "步骤", "Step"), tr(lang, "当前结果", "Status"), tr(lang, "依据", "Source"), tr(lang, "时间", "Timestamp")}, rows)
	follow := []string{}
	for _, r := range prog.Reports {
		if resolved, _ := isReportResolvedByStep(r, prog); resolved {
			continue
		}
		for _, f := range r.Followups {
			follow = append(follow, r.Title+tr(lang, "：", ": ")+f)
		}
	}
	if len(follow) > 0 {
		b.h(level+1, tr(lang, "需要跟进的事项", "Follow-Up Items"))
		b.list(follow)
	}
	if len(runs) > 0 {
		evStart := len(b.blocks)
		wroteHead := false
		for _, r := range runs {
			for _, st := range r.Steps {
				if st.Seq == 0 && st.Finished == "" && st.State == "pending" {
					continue
				}
				if !wroteHead {
					b.h(level+1, tr(lang, "Ansible 执行日志明细", "Ansible Execution Log Details"))
					wroteHead = true
				}
				b.h(level+2, tr(lang, "执行证据："+st.Title, "Execution Evidence: "+st.Title))
				var metaParts []string
				if len(st.Hosts) > 0 {
					metaParts = append(metaParts, tr(lang, "机器：", "Hosts: ")+strings.Join(st.Hosts, tr(lang, "、", ", ")))
				}
				metaParts = append(metaParts, tr(lang, "结果：", "Result: ")+executionStateLabel(lang, st.State))
				stAt, finAt := stamp(st.Started), stamp(st.Finished)
				if stAt != "" && finAt != "" && stAt != finAt {
					metaParts = append(metaParts, tr(lang, "时间：", "Time: ")+stAt+" ~ "+finAt)
				} else if t := firstNonEmptyStr(finAt, stAt); t != "" {
					metaParts = append(metaParts, tr(lang, "时间：", "Time: ")+t)
				}
				if st.ExitCode != nil {
					metaParts = append(metaParts, tr(lang, fmt.Sprintf("进程退出码：%d", *st.ExitCode), fmt.Sprintf("Exit code: %d", *st.ExitCode)))
				}
				b.p(strings.Join(metaParts, tr(lang, "　　", "    ")))
				if msg := strings.TrimSpace(st.Message); msg != "" && msg != "任务与组件声明的完成检查通过" {
					b.p(msg)
				}
				recap := [][]string{}
				for _, h := range st.Recap {
					recap = append(recap, []string{h.Host, fmt.Sprint(h.OK), fmt.Sprint(h.Changed), fmt.Sprint(h.Failed), fmt.Sprint(h.Unreachable), fmt.Sprint(h.Skipped)})
				}
				b.table([]string{tr(lang, "机器", "Host"), tr(lang, "成功任务", "OK"), tr(lang, "变更任务", "Changed"), tr(lang, "失败", "Failed"), tr(lang, "无法连接", "Unreachable"), tr(lang, "跳过", "Skipped")}, recap)
				log := []rune(string(s.executionLog(r.ID, st)))
				if len(log) > 12000 {
					log = log[len(log)-12000:]
					b.note(tr(lang, "以下保留最近 12000 字符，完整日志可在平台执行记录中查看。", "Showing last 12,000 characters; full logs remain available in the platform execution records."))
				}
				if len(log) > 0 {
					b.blocks = append(b.blocks, docBlock{Kind: "code", Style: "ansible", Text: string(log)})
				}
			}
		}
		for i := evStart; i < len(b.blocks); i++ {
			b.blocks[i].Detail = true
			b.blocks[i].Variant = variantResultAuto
		}
	}
}

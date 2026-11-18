package main

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
	b.p(tr(lang,
		fmt.Sprintf("执行节点验证通过 %d 步；上传日志显示通过 %d 步；人工确认 %d 步；失败 %d 步；未执行/已跳过 %d 步；待完成或待核实 %d 步。", verified, imported, manual, failed, skipped, pending),
		fmt.Sprintf("Passed via execution node: %d; via uploaded logs: %d; manually confirmed: %d; failed: %d; skipped: %d; pending or unverified: %d.", verified, imported, manual, failed, skipped, pending),
	))
	if failed > 0 || pending > 0 {
		b.note(tr(lang, "仍有失败、未完成或待核实事项，当前记录不能作为全部验收通过的证明。", "Failures, pending items, or unverified steps remain; this record does not certify full acceptance."))
	}
	b.table([]string{tr(lang, "步骤", "Step"), tr(lang, "当前结果", "Status"), tr(lang, "依据", "Source"), tr(lang, "时间", "Timestamp")}, rows)
	follow := []string{}
	for _, r := range prog.Reports {
		for _, f := range r.Followups {
			follow = append(follow, r.Title+tr(lang, "：", ": ")+f)
		}
	}
	if len(follow) > 0 {
		b.h(level+1, tr(lang, "需要跟进的事项", "Follow-Up Items"))
		b.list(follow)
	}
	if len(runs) > 0 {
		b.h(level+1, tr(lang, "自动执行批次", "Automated Execution Batches"))
		runRows := [][]string{}
		for _, r := range runs {
			node := d.Nodes[r.Node]
			location := map[string]string{"independent": tr(lang, "独立管理机", "Standalone runner"), "embedded": tr(lang, "集群内执行机", "In-cluster runner")}[r.ExecutorKind]
			access := map[string]string{"existing-ssh": tr(lang, "已有 SSH", "Existing SSH"), "agent-trust": tr(lang, "Agent 配置信任后通过 SSH 执行", "Agent-trusted SSH")}[r.AccessMode]
			runRows = append(runRows, []string{r.ID, executionStateLabel(lang, r.State), r.By, firstNonEmptyStr(r.ExecutorName, firstNonEmptyStr(node.Name, r.Node)) + " " + r.ExecutorIP + " " + location + " " + access, stamp(r.Created), r.Snapshot})
		}
		b.table([]string{tr(lang, "批次", "Batch"), tr(lang, "结果", "Result"), tr(lang, "发起人", "Initiator"), tr(lang, "执行节点", "Execution Node"), tr(lang, "发起时间", "Started"), tr(lang, "固定快照 SHA256", "Snapshot SHA256")}, runRows)
		for _, r := range runs {
			if p, ok := d.Preparations[r.Preparation]; ok {
				b.h(level+2, tr(lang, "执行准备："+r.ID, "Execution Preparation: "+r.ID))
				b.p(tr(lang, "检查时间："+stamp(p.Finished)+"；检查编号："+p.ID+"。以下为本批次启动前的检查记录，不计为数据库部署或业务验收通过。", "Checked at "+stamp(p.Finished)+"; check ID "+p.ID+". Pre-launch readiness checks below do not certify deployment or service acceptance."))
				checks := [][]string{}
				for _, c := range p.Checks {
					checks = append(checks, []string{c.Host, c.Title, map[string]string{"passed": tr(lang, "通过", "Passed"), "blocked": tr(lang, "待处理", "Blocked")}[c.State], c.Message})
				}
				b.table([]string{tr(lang, "机器", "Host"), tr(lang, "检查项目", "Check"), tr(lang, "检查结果", "Result"), tr(lang, "说明", "Details")}, checks)
			}
			for _, st := range r.Steps {
				start := len(b.blocks)
				b.h(level+2, tr(lang, "执行证据："+st.Title, "Execution Evidence: "+st.Title))
				b.p(tr(lang,
					"批次 "+r.ID+"；尝试 "+st.ID+"；机器 "+strings.Join(st.Hosts, "、")+"；结果 "+executionStateLabel(lang, st.State)+"；开始 "+stamp(st.Started)+"；结束 "+stamp(st.Finished),
					"Batch "+r.ID+"; attempt "+st.ID+"; hosts "+strings.Join(st.Hosts, ", ")+"; result "+executionStateLabel(lang, st.State)+"; started "+stamp(st.Started)+"; finished "+stamp(st.Finished),
				))
				b.p(st.Message)
				if st.ExitCode != nil {
					b.p(tr(lang, fmt.Sprintf("进程退出码：%d", *st.ExitCode), fmt.Sprintf("Process exit code: %d", *st.ExitCode)))
				}
				if st.Runtime != "" {
					b.p(st.Runtime)
				}
				if st.Returned != "" {
					b.p(tr(lang, "平台收到结果："+stamp(st.Returned), "Result reported at "+stamp(st.Returned)))
				}
				recap := [][]string{}
				for _, h := range st.Recap {
					recap = append(recap, []string{h.Host, fmt.Sprint(h.OK), fmt.Sprint(h.Changed), fmt.Sprint(h.Failed), fmt.Sprint(h.Unreachable), fmt.Sprint(h.Skipped)})
				}
				b.table([]string{tr(lang, "机器", "Host"), tr(lang, "成功任务", "OK"), tr(lang, "变更任务", "Changed"), tr(lang, "失败", "Failed"), tr(lang, "无法连接", "Unreachable"), tr(lang, "跳过", "Skipped")}, recap)
				log := []rune(string(s.executionLog(r.ID, st)))
				if len(log) > 12000 {
					log = log[len(log)-12000:]
					b.note(tr(lang, "以下保留最近 12000 字符。完整脱敏日志可在这份交付的执行批次下载。", "Showing last 12,000 characters; full redacted logs are downloadable under this delivery's execution batches."))
				}
				if len(log) > 0 {
					b.code(string(log))
				}
				b.p(tr(lang, "完整日志：", "Full log: ") + strings.TrimRight(s.cfg.PublicURL, "/") + "/api/jobs/" + j.ID + "/executions/" + r.ID + "/logs/" + st.ID)
				for i := start; i < len(b.blocks); i++ {
					b.blocks[i].Detail = true
					b.blocks[i].Variant = variantResult
				}
			}
		}
	}
}

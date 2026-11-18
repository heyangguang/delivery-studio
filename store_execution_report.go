package main

import (
	"fmt"
	"sort"
	"strings"
)

var executionStateNames = map[string]string{"queued": "等待执行", "pending": "未执行", "leased": "已授权，等待启动", "running": "正在执行", "paused": "已暂停", "unknown": "现场状态待核实", "succeeded": "完成检查通过", "completed": "所选步骤结束", "failed": "失败", "skipped": "未执行：条件不满足", "closed": "结束批次", "interrupted": "已确认中断"}

func init() { executionStateNames["blocked"] = "准备受阻，命令未启动" }

func (s *storeServer) executionSummary(b *docBuilder, level int, j storeJob, prog progressDoc) {
	tabs := s.runbookSteps(j.ID)
	if len(tabs) == 0 {
		b.note("本次为配置或资料交付，没有自动运行安装或验证任务。")
		return
	}
	b.h(level+1, "执行结果摘要")
	d, e := s.readExecutions()
	if e != nil {
		b.note("自动执行证据暂时不可读，不能据此确认执行成功。")
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
			status := firstNonEmptyStr(stepStates[rec.State], "未记录结果")
			source := "人工填写"
			at := rec.At
			if rec.Source == "automatic" {
				source = "执行节点回传"
			}
			if rec.Source == "imported" || rec.By == runLogBy {
				source = "上传的执行日志"
			}
			auto, has := latest[st.Key]
			// An active/uncertain attempt takes precedence over an earlier manual success.
			if has && (firstNonEmptyStr(auto.Returned, auto.Finished) > rec.At || auto.Finished == "" || rec.Attempt == auto.ID) {
				status = executionStateNames[auto.State]
				source = "执行节点回传"
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
	b.p(fmt.Sprintf("执行节点验证通过 %d 步；上传日志显示通过 %d 步；人工确认 %d 步；失败 %d 步；未执行/已跳过 %d 步；待完成或待核实 %d 步。", verified, imported, manual, failed, skipped, pending))
	if failed > 0 || pending > 0 {
		b.note("仍有失败、未完成或待核实事项，当前记录不能作为全部验收通过的证明。")
	}
	b.table([]string{"步骤", "当前结果", "依据", "时间"}, rows)
	follow := []string{}
	for _, r := range prog.Reports {
		for _, f := range r.Followups {
			follow = append(follow, r.Title+"："+f)
		}
	}
	if len(follow) > 0 {
		b.h(level+1, "需要跟进的事项")
		b.list(follow)
	}
	if len(runs) > 0 {
		b.h(level+1, "自动执行批次")
		runRows := [][]string{}
		for _, r := range runs {
			node := d.Nodes[r.Node]
			location := map[string]string{"independent": "独立管理机", "embedded": "集群内执行机"}[r.ExecutorKind]
			access := map[string]string{"existing-ssh": "已有 SSH", "agent-trust": "Agent 配置信任后通过 SSH 执行"}[r.AccessMode]
			runRows = append(runRows, []string{r.ID, executionStateNames[r.State], r.By, firstNonEmptyStr(r.ExecutorName, firstNonEmptyStr(node.Name, r.Node)) + " " + r.ExecutorIP + " " + location + " " + access, stamp(r.Created), r.Snapshot})
		}
		b.table([]string{"批次", "结果", "发起人", "执行节点", "发起时间", "固定快照 SHA256"}, runRows)
		for _, r := range runs {
			if p, ok := d.Preparations[r.Preparation]; ok {
				b.h(level+2, "执行准备："+r.ID)
				b.p("检查时间：" + stamp(p.Finished) + "；检查编号：" + p.ID + "。以下为本批次启动前的检查记录，不计为数据库部署或业务验收通过。")
				checks := [][]string{}
				for _, c := range p.Checks {
					checks = append(checks, []string{c.Host, c.Title, map[string]string{"passed": "通过", "blocked": "待处理"}[c.State], c.Message})
				}
				b.table([]string{"机器", "检查项目", "检查结果", "说明"}, checks)
			}
			for _, st := range r.Steps {
				start := len(b.blocks)
				b.h(level+2, "执行证据："+st.Title)
				b.p("批次 " + r.ID + "；尝试 " + st.ID + "；机器 " + strings.Join(st.Hosts, "、") + "；结果 " + executionStateNames[st.State] + "；开始 " + stamp(st.Started) + "；结束 " + stamp(st.Finished))
				b.p(st.Message)
				if st.ExitCode != nil {
					b.p(fmt.Sprintf("进程退出码：%d", *st.ExitCode))
				}
				if st.Runtime != "" {
					b.p(st.Runtime)
				}
				if st.Returned != "" {
					b.p("平台收到结果：" + stamp(st.Returned))
				}
				recap := [][]string{}
				for _, h := range st.Recap {
					recap = append(recap, []string{h.Host, fmt.Sprint(h.OK), fmt.Sprint(h.Changed), fmt.Sprint(h.Failed), fmt.Sprint(h.Unreachable), fmt.Sprint(h.Skipped)})
				}
				b.table([]string{"机器", "成功任务", "变更任务", "失败", "无法连接", "跳过"}, recap)
				log := []rune(string(s.executionLog(r.ID, st)))
				if len(log) > 12000 {
					log = log[len(log)-12000:]
					b.note("以下保留最近 12000 字符。完整脱敏日志可在这份交付的执行批次下载。")
				}
				if len(log) > 0 {
					b.code(string(log))
				}
				b.p("完整日志：" + strings.TrimRight(s.cfg.PublicURL, "/") + "/api/jobs/" + j.ID + "/executions/" + r.ID + "/logs/" + st.ID)
				for i := start; i < len(b.blocks); i++ {
					b.blocks[i].Detail = true
					b.blocks[i].Variant = variantResult
				}
			}
		}
	}
}

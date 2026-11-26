package server

import (
	"encoding/json"
	"fmt"
	"delivery-studio/mwpack"
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

type aiVexSpec struct {
	CVEs          []string `json:"cves,omitempty"`
	CVE           string   `json:"cve,omitempty"`
	Package       string   `json:"package,omitempty"`
	Ecosystem     string   `json:"ecosystem,omitempty"`
	ClusterID     string   `json:"cluster_id,omitempty"`
	Global        bool     `json:"global,omitempty"`
	Status        string   `json:"status"` // planned | mitigated | not_affected | accepted
	Justification string   `json:"justification,omitempty"`
	ExpiresAt     string   `json:"expires_at,omitempty"`
	Note          string   `json:"note"`
}

type aiBaselineSpec struct {
	ClusterID string `json:"cluster_id"`
	CheckID   string `json:"check_id"`
	Title     string `json:"title,omitempty"`
	Note      string `json:"note"`
}

type aiRehearsalSpec struct {
	ClusterID string   `json:"cluster_id"`
	Kind      string   `json:"kind,omitempty"` // upgrade | scale | tune | switch | security | change
	Mode      string   `json:"mode,omitempty"` // light | full
	Title     string   `json:"title"`
	Goal      string   `json:"goal,omitempty"`
	Packages  []string `json:"packages,omitempty"`
	CVEs      []string `json:"cves,omitempty"`
	Summary   string   `json:"summary,omitempty"`
	Reason    string   `json:"reason,omitempty"`
	Running   bool     `json:"running,omitempty"`
	AppLabel  string   `json:"app_label,omitempty"`
}

type aiKnowledgeSpec struct {
	Title        string `json:"title"`
	Summary      string `json:"summary,omitempty"`
	Content      string `json:"content"`
	Scope        string `json:"scope,omitempty"`         // personal | team
	Source       string `json:"source,omitempty"`        // origin hint, e.g. cluster or page
	KBID         string `json:"kb_id,omitempty"`         // saved personal KB doc id
	TeamDocID    string `json:"team_doc_id,omitempty"`   // directly published team KB doc id
	SubmissionID string `json:"submission_id,omitempty"` // submitted team KB review id
}

type aiComponentSpec struct {
	Component string `json:"component"`
	Title     string `json:"title"`
	Detail    string `json:"detail"`
	Why       string `json:"why,omitempty"`
}

type aiRehearsalStepSpec struct {
	ClusterID      string `json:"cluster_id"`
	RehearsalID    string `json:"rehearsal_id"`
	RehearsalTitle string `json:"rehearsal_title,omitempty"`
	StepID         string `json:"step_id"`
	StepOrder      int    `json:"step_order,omitempty"`
	Action         string `json:"action"` // replace | insert_before | insert_after | delete
	Phase          string `json:"phase,omitempty"`
	Title          string `json:"title,omitempty"`
	TargetRole     string `json:"target_role,omitempty"`
	Command        string `json:"command,omitempty"`
	Expect         string `json:"expect,omitempty"`
	Rollback       string `json:"rollback,omitempty"`
	RiskNote       string `json:"risk_note,omitempty"`
	OldTitle       string `json:"old_title,omitempty"`
	OldTargetRole  string `json:"old_target_role,omitempty"`
	OldCommand     string `json:"old_command,omitempty"`
}

type aiProposal struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"`    // add | replace | file | component | vex | baseline_waive | rehearsal | rehearsal_step | knowledge
	Session    string     `json:"session"` // conversation key
	Status     string     `json:"status"`  // pending | accepted | rejected
	Phase      string     `json:"phase"`
	AfterTitle string     `json:"after_title,omitempty"`
	Step       aiStepSpec `json:"step"`
	Reason     string     `json:"reason"`
	Verify     string     `json:"verify,omitempty"`
	Warnings   []string   `json:"warnings,omitempty"`
	// File is the change to one file of the delivery's project when Kind is "file" (ai_patch.go).
	File          *aiFilePatch         `json:"file,omitempty"`
	Vex           *aiVexSpec           `json:"vex,omitempty"`
	Baseline      *aiBaselineSpec      `json:"baseline,omitempty"`
	Rehearsal     *aiRehearsalSpec     `json:"rehearsal,omitempty"`
	RehearsalStep *aiRehearsalStepSpec `json:"rehearsal_step,omitempty"`
	Knowledge     *aiKnowledgeSpec     `json:"knowledge,omitempty"`
	At            string               `json:"at"`
	DecidedBy     string               `json:"decided_by,omitempty"`
	DecidedAt     string               `json:"decided_at,omitempty"`
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

type deliveryRehearsalBrief struct {
	ID             string                   `json:"id"`
	Title          string                   `json:"title"`
	Stage          string                   `json:"stage"`
	UpdatedAt      string                   `json:"updated_at,omitempty"`
	Applied        bool                     `json:"applied,omitempty"`
	AppliedAt      string                   `json:"applied_at,omitempty"`
	AppliedBy      string                   `json:"applied_by,omitempty"`
	AppliedSummary string                   `json:"applied_summary,omitempty"`
	AppliedChanges []rehearsalAppliedChange `json:"applied_changes,omitempty"`
	Voided         bool                     `json:"voided,omitempty"`
}

type deliveryLifecycle struct {
	ClusterID      string                   `json:"cluster_id"`
	JobID          string                   `json:"job_id"`
	AppLabel       string                   `json:"app_label,omitempty"`
	DeliveryMode   string                   `json:"delivery_mode"`
	ClusterRunning bool                     `json:"cluster_running"`
	LifecycleCode  string                   `json:"lifecycle_status"`
	LifecycleLabel string                   `json:"lifecycle_label"`
	Outcome        string                   `json:"outcome"`
	OutcomeNote    string                   `json:"outcome_note,omitempty"`
	MarkedAt       string                   `json:"marked_at,omitempty"`
	MarkedBy       string                   `json:"marked_by,omitempty"`
	HeadJobID      string                   `json:"head_job_id,omitempty"`
	RunDone        int                      `json:"run_done,omitempty"`
	RunFailed      int                      `json:"run_failed,omitempty"`
	RunTotal       int                      `json:"run_total,omitempty"`
	Rehearsals     []deliveryRehearsalBrief `json:"rehearsals,omitempty"`
}

func (s *storeServer) deliveryLifecycleInfo(jobID string) (deliveryLifecycle, bool) {
	s.mu.Lock()
	j, ok := s.jobs[jobID]
	var clusterJobs []storeJob
	if ok && j.ClusterID != "" {
		clusterJobs = s.clusterOf(j.ClusterID)
	}
	s.mu.Unlock()
	if !ok {
		return deliveryLifecycle{}, false
	}
	head, hasHead := clusterHead(clusterJobs)
	appLabel := strings.TrimSpace(strings.TrimSpace(j.AppName) + " " + strings.TrimSpace(j.Version))
	info := deliveryLifecycle{
		ClusterID:      j.ClusterID,
		JobID:          j.ID,
		AppLabel:       appLabel,
		DeliveryMode:   firstNonEmptyStr(j.DeliveryMode, "offline"),
		ClusterRunning: hasHead,
		Outcome:        j.Outcome,
		OutcomeNote:    j.OutcomeNote,
		MarkedAt:       j.Marked,
		MarkedBy:       j.MarkedBy,
		RunDone:        j.RunDone,
		RunFailed:      j.RunFailed,
		RunTotal:       j.RunTotal,
	}
	if hasHead {
		info.HeadJobID = head.ID
	}
	switch {
	case info.DeliveryMode == "configuration":
		info.LifecycleCode = "config_only"
		info.LifecycleLabel = "仅生成配置（不执行现场部署）"
	case j.Outcome == outcomeVoid:
		info.LifecycleCode = "void"
		info.LifecycleLabel = "已作废"
	case hasHead:
		info.LifecycleCode = "running"
		if j.ID == head.ID {
			if j.Outcome == outcomeDeviated {
				info.LifecycleLabel = "已部署完成（有现场偏差）· 运行中（已投产）"
			} else {
				info.LifecycleLabel = "已部署完成 · 运行中（已投产）"
			}
		} else {
			curLabel := firstNonEmptyStr(outcomeNames[j.Outcome], "待执行")
			info.LifecycleLabel = fmt.Sprintf("该集群已部署运行中（运行基线为交付 %s），当前查看交付状态为：%s", head.ID, curLabel)
		}
	case j.Outcome == outcomeFailed:
		info.LifecycleCode = "failed"
		info.LifecycleLabel = "部署失败（尚未投产）"
	case j.RunDone > 0 || j.RunFailed > 0:
		info.LifecycleCode = "in_progress"
		info.LifecycleLabel = fmt.Sprintf("部署执行中 / 待确认结果（已记录 %d/%d 步，失败 %d 步；尚未标记完成）", j.RunDone, j.RunTotal, j.RunFailed)
	default:
		info.LifecycleCode = "pending"
		info.LifecycleLabel = "待执行（尚未部署 / 未投产）"
	}
	if j.ClusterID != "" {
		rhs := s.listRehearsals(j.ClusterID)
		for i, r := range rhs {
			if i >= 8 {
				break
			}
			info.Rehearsals = append(info.Rehearsals, deliveryRehearsalBrief{
				ID:             r.ID,
				Title:          r.Title,
				Stage:          r.Stage,
				UpdatedAt:      day(r.UpdatedAt),
				Applied:        r.Applied,
				AppliedAt:      day(r.AppliedAt),
				AppliedBy:      r.AppliedBy,
				AppliedSummary: r.AppliedSummary,
				AppliedChanges: r.AppliedChanges,
				Voided:         r.Voided,
			})
		}
	}
	return info, true
}

func (s *storeServer) deliveryLifecycleFacts(jobID string) string {
	info, ok := s.deliveryLifecycleInfo(jobID)
	if !ok {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\n# 平台实时集群与交付生命周期状态（权威事实，禁止向用户反问是否已部署或已投产）\n")
	fmt.Fprintf(&b, "- 集群标识：%s", info.ClusterID)
	if info.AppLabel != "" {
		fmt.Fprintf(&b, "（应用：%s", info.AppLabel)
		fmt.Fprintf(&b, "，当前交付编号：%s）\n", info.JobID)
	} else {
		fmt.Fprintf(&b, "（当前交付编号：%s）\n", info.JobID)
	}
	fmt.Fprintf(&b, "- 当前部署/投产状态：%s", info.LifecycleLabel)
	if info.MarkedAt != "" || info.MarkedBy != "" {
		b.WriteString("（")
		if info.MarkedBy != "" {
			b.WriteString(info.MarkedBy + " ")
		}
		if info.MarkedAt != "" {
			b.WriteString("于 " + day(info.MarkedAt) + " 确认")
		}
		b.WriteString("）")
	}
	b.WriteString("\n")
	if info.OutcomeNote != "" {
		fmt.Fprintf(&b, "- 现场结果说明：%s\n", truncRunes(info.OutcomeNote, 300))
	}
	if info.RunTotal > 0 {
		fmt.Fprintf(&b, "- 现场执行进度：已完成 %d / %d 步（失败 %d 步）\n", info.RunDone, info.RunTotal, info.RunFailed)
	}
	if len(info.Rehearsals) > 0 {
		stageName := map[string]string{"scoping": "边界对齐", "probing": "只读探针", "rehearsing": "测试演练", "finalized": "已定稿待实施"}
		parts := make([]string, 0, len(info.Rehearsals))
		var appliedLines []string
		for _, r := range info.Rehearsals {
			st := firstNonEmptyStr(stageName[r.Stage], r.Stage)
			if r.Voided {
				st = "已作废"
			} else if r.Stage == "finalized" && r.Applied {
				st = "已落地生效"
				line := fmt.Sprintf("  * [%s] 「%s」（#%s，%s 确认已实施）", firstNonEmptyStr(r.AppliedAt, r.UpdatedAt), r.Title, r.ID, firstNonEmptyStr(r.AppliedBy, "运维"))
				if r.AppliedSummary != "" {
					line += "：" + truncRunes(r.AppliedSummary, 160)
				}
				if len(r.AppliedChanges) > 0 {
					var deltas []string
					for _, ch := range r.AppliedChanges {
						if ch.Before != "" {
							deltas = append(deltas, fmt.Sprintf("%s: %s -> %s", ch.Key, ch.Before, ch.After))
						} else {
							deltas = append(deltas, fmt.Sprintf("%s=%s", ch.Key, ch.After))
						}
					}
					line += " [" + strings.Join(deltas, "; ") + "]"
				}
				appliedLines = append(appliedLines, line)
			}
			parts = append(parts, fmt.Sprintf("「%s」(#%s, %s)", r.Title, r.ID, st))
		}
		fmt.Fprintf(&b, "- 已有变更演练：%s（可用 read_rehearsal 读取步骤详情，需要修改演练步骤时调用 propose_rehearsal_step_edit 输出一键修订卡片）\n", strings.Join(parts, "；"))
		if len(appliedLines) > 0 {
			b.WriteString("- **投产后已确认落地的生产变更（当前生产集群已生效，优先于初始部署基线）**：\n")
			for _, ln := range appliedLines {
				b.WriteString(ln + "\n")
			}
		}
	} else {
		b.WriteString("- 已有变更演练：暂无\n")
	}
	switch {
	case info.ClusterRunning:
		b.WriteString("- **强制决策约束**：该集群已经完成部署并处于**运行中（已投产）**状态。**绝不要再向用户反问“这个集群已经投产了吗 / 部署完成了吗”**。\n")
		b.WriteString("- **投产后操作治理铁律（任何配置/状态变化一律进演练并出《变更报告》，绝不失控）**：\n")
		b.WriteString("  1. **纯只读查询（零修改，不进演练）**：仅查状态、看日志、查主从角色/连接数/复制延迟/核对配置现状（**不改任何配置、参数、规则、文件或服务状态**）→ 直接给出 1～3 条只读命令即可，**不要调用 `propose_rehearsal`**。\n")
		b.WriteString("  2. **极速变更（`propose_rehearsal` + `mode=\"quick\"`）**：只要涉及**任何修改配置/参数/规则/文件**，哪怕非常简单、无需重启与切主且现状已在对话或截图中明确（例如在线 `reload` 改 `log_filename` / `log_rotation_size`、补单条明确规则/白名单），**也必须调用 `propose_rehearsal` 并设 `mode=\"quick\"`**（跳过问答与只读探针，一步直出 2～3 步执行清单，完成后一键生成归档《变更报告》），绝不只丢命令而不留变更记录！\n")
		b.WriteString("  3. **简单推演（`propose_rehearsal` + `mode=\"light\"`）**：要改配置/补规则/动态调参且无需重启和切主，但**现场当前状态还拿不准，需先跑一屏只读探针核实后再执行与出《变更报告》** → **主动调用 `propose_rehearsal` 并设 `mode=\"light\"`**；若同时识别到组件模板/默认配置遗漏，核对 `component_sync_status` 后一并调用 `suggest_component_change`。\n")
		b.WriteString("  4. **全量推演（`propose_rehearsal` + `mode=\"full\"`）**：高风险/复杂变更（滚动重启服务、主备切换/switchover、版本或 CVE 补丁升级、扩缩容、备份/WAL 归档架构改造、TLS 证书轮换、跨节点或有业务闪断/数据风险的变更）→ **主动调用 `propose_rehearsal` 并设 `mode=\"full\"`**（走完整四步并定稿生产 SOP），不要只口头提示去演练页。\n")
	case info.LifecycleCode == "pending" || info.LifecycleCode == "in_progress":
		b.WriteString("- **强制决策约束**：该集群目前尚未标记完成首次部署（未投产）。**不要向用户反问是否已投产**。如用户需调整拓扑、参数或备份策略，应优先按首次交付阶段修订规格或补充交付步骤处理；仅在用户明确要求走演练时才调用 `propose_rehearsal`。\n")
	case info.LifecycleCode == "failed":
		b.WriteString("- **强制决策约束**：该集群首次部署结果为失败（尚未投产），当前重点是定位根因并修复交付/现场问题，而不是发起投产后变更演练。\n")
	}
	return b.String()
}

func aiReadRehearsalTool() aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return aiToolDef{
		Name:        "read_rehearsal",
		Description: "读取当前集群某次变更演练的完整详情：演练目标、档位、阶段、漂移摘要、全部演练步骤（含 step_id、序号、执行机器 target_role、命令、预期判据、注意事项、回退方式、实测状态与历轮核验历史）。讨论或修改变更演练步骤前必须先调用此工具确认最新内容。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"rehearsal_id": str("可选：变更演练 ID；省略时自动读取当前集群最近一次进行中或最新的变更演练"),
			},
		},
	}
}

func aiProposeRehearsalStepEditTool() aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return aiToolDef{
		Name:        "propose_rehearsal_step_edit",
		Description: "提议修改当前集群某次变更演练中的指定步骤（支持替换命令/执行机器/判据/标题、在该步之前或之后插入新步骤，或删除冗余步骤）。不会自动改动，会在对话中输出一张交互式「修改演练步骤」卡片，用户点击「采纳并更新演练步骤」后立即写入演练方案并同步刷新演练页面。严禁用 propose_step / propose_change 去改变更演练步骤。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"rehearsal_id": str("变更演练 ID（可从步骤上下文或 read_rehearsal 获取；省略时自动匹配当前集群最新演练）"),
				"step_id":      str("目标步骤 ID（如 s4，也可传步骤序号如 4 或步骤标题关键词）"),
				"action":       map[string]any{"type": "string", "enum": []string{"replace", "insert_before", "insert_after", "delete"}, "description": "操作类型：replace（修改目标步骤，默认）、insert_before（在目标步骤之前插入新步骤）、insert_after（在目标步骤之后插入新步骤）、delete（删除目标步骤）"},
				"phase":        map[string]any{"type": "string", "enum": []string{"precheck", "execute", "verify", "rollback"}, "description": "可选：步骤所属阶段（insert_before/insert_after 时默认继承目标步骤阶段）"},
				"title":        str("步骤标题（insert_* 必填；replace 时如不改标题可省略）"),
				"target_role":  str("明确的执行机器指引，例如「在 node-1 (172.30.4.26) 上执行」（必须写清具体主机名/IP，不要含糊写控制节点或 OLD）"),
				"command":      str("完整可直接复制执行的 Bash 命令（1～6 行为宜，禁止 read -r -p 交互式读变量；action=delete 时可省略）"),
				"expect":       str("清晰的成功判据（replace 时不改可省略）"),
				"rollback":     str("可选：回退命令"),
				"risk_note":    str("可选：注意事项或风险提示"),
				"reason":       str("为什么做这次修改，以及修改后解决了什么问题（1～2 句）"),
			},
			"required": []string{"step_id", "reason"},
		},
	}
}

func (s *storeServer) resolveClusterRehearsal(clusterID, rid string) (changeRehearsal, bool) {
	rid = strings.TrimSpace(rid)
	if rid != "" {
		return s.loadRehearsal(clusterID, rid)
	}
	list := s.listRehearsals(clusterID)
	if len(list) == 0 {
		return changeRehearsal{}, false
	}
	for _, r := range list {
		if r.Stage != "finalized" {
			return r, true
		}
	}
	return list[0], true
}

func findRehearsalStepIdx(steps []rehearsalStep, ref string) int {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return -1
	}
	for i, st := range steps {
		if strings.EqualFold(st.ID, ref) {
			return i
		}
	}
	cleanNum := strings.TrimPrefix(ref, "#")
	cleanNum = strings.TrimPrefix(cleanNum, "s")
	cleanNum = strings.TrimPrefix(cleanNum, "S")
	if n := 0; len(cleanNum) > 0 {
		if _, err := fmt.Sscanf(cleanNum, "%d", &n); err == nil && n > 0 {
			for i, st := range steps {
				if st.Order == n {
					return i
				}
			}
			if n <= len(steps) {
				return n - 1
			}
		}
	}
	low := strings.ToLower(ref)
	for i, st := range steps {
		if strings.Contains(strings.ToLower(st.Title), low) {
			return i
		}
	}
	return -1
}

func (s *storeServer) runReadRehearsal(clusterID, rid string) string {
	if strings.TrimSpace(clusterID) == "" {
		return "当前交付未关联集群，无法读取变更演练。"
	}
	rehearsalMu.Lock()
	rh, ok := s.resolveClusterRehearsal(clusterID, rid)
	rehearsalMu.Unlock()
	if !ok {
		return "该集群暂无变更演练记录。"
	}
	type stepOut struct {
		ID            string                   `json:"id"`
		Order         int                      `json:"order"`
		Phase         string                   `json:"phase"`
		Title         string                   `json:"title"`
		TargetRole    string                   `json:"target_role"`
		Command       string                   `json:"command"`
		Expect        string                   `json:"expect"`
		RiskNote      string                   `json:"risk_note,omitempty"`
		Rollback      string                   `json:"rollback,omitempty"`
		Optional      bool                     `json:"optional,omitempty"`
		Status        string                   `json:"status"`
		Note          string                   `json:"note,omitempty"`
		LastError     string                   `json:"last_error,omitempty"`
		Proposal      *rehearsalStepProposal   `json:"proposal,omitempty"`
		VerifyHistory []rehearsalVerifyAttempt `json:"verify_history,omitempty"`
	}
	steps := make([]stepOut, 0, len(rh.Steps))
	for _, st := range rh.Steps {
		steps = append(steps, stepOut{
			ID:            st.ID,
			Order:         st.Order,
			Phase:         st.Phase,
			Title:         st.Title,
			TargetRole:    st.TargetRole,
			Command:       st.Command,
			Expect:        st.Expect,
			RiskNote:      st.RiskNote,
			Rollback:      st.Rollback,
			Optional:      st.Optional,
			Status:        st.Status,
			Note:          st.Note,
			LastError:     truncRunes(st.LastError, 600),
			Proposal:      st.Proposal,
			VerifyHistory: st.VerifyHistory,
		})
	}
	out := map[string]any{
		"cluster_id": rh.ClusterID,
		"id":         rh.ID,
		"title":      rh.Title,
		"mode":       rh.Mode,
		"stage":      rh.Stage,
		"goal":       rh.Goal,
		"steps":      steps,
	}
	if rh.Drift != nil {
		out["drift_summary"] = rh.Drift.Summary
		out["drift_hosts"] = rh.Drift.Hosts
	}
	if len(rh.RestorationAlerts) > 0 {
		out["restoration_alerts"] = rh.RestorationAlerts
	}
	b, _ := json.Marshal(out)
	return aiScrub(string(b))
}

var reRehearsalCatastrophic = regexp.MustCompile(`(?i)\b(mkfs\.[a-z0-9]+|fdisk|parted|wipefs|dd\s+if=.*of=/dev/|rm\s+-[a-z]*r[a-z]*f[a-z]*\s+/(\s|$))\b`)

func (s *storeServer) createRehearsalStepEditProposal(proposalsPath, session, clusterID string, args map[string]any, proposed *[]string) string {
	if strings.TrimSpace(clusterID) == "" {
		return "提案没有通过平台校验：当前交付未关联集群。"
	}
	str := func(k string) string { v, _ := args[k].(string); return strings.TrimSpace(v) }
	rid := str("rehearsal_id")
	stepRef := str("step_id")
	action := strings.ToLower(firstNonEmptyStr(str("action"), "replace"))
	switch action {
	case "replace", "insert_before", "insert_after", "delete":
	default:
		return "提案没有通过平台校验：action 仅支持 replace / insert_before / insert_after / delete。"
	}
	reason := truncRunes(str("reason"), 500)
	if reason == "" {
		return "提案没有通过平台校验：reason 必填，请简述修改原因。"
	}
	rehearsalMu.Lock()
	rh, ok := s.resolveClusterRehearsal(clusterID, rid)
	rehearsalMu.Unlock()
	if !ok {
		return "提案没有通过平台校验：找不到对应的变更演练会话，请先用 read_rehearsal 确认演练 ID。"
	}
	idx := findRehearsalStepIdx(rh.Steps, stepRef)
	if idx < 0 {
		return fmt.Sprintf("提案没有通过平台校验：在演练「%s」(#%s) 中未找到步骤 %q，请先调用 read_rehearsal 核对准确的 step_id。", rh.Title, rh.ID, stepRef)
	}
	target := rh.Steps[idx]
	cmd := aiScrub(strings.TrimSpace(str("command")))
	title := truncRunes(str("title"), 120)
	targetRole := truncRunes(str("target_role"), 160)
	expect := truncRunes(str("expect"), 500)
	rollback := truncRunes(str("rollback"), 400)
	riskNote := truncRunes(str("risk_note"), 400)
	phase := strings.ToLower(str("phase"))
	if phase != "" && phase != "precheck" && phase != "execute" && phase != "verify" && phase != "rollback" {
		phase = ""
	}

	if action == "delete" {
		if len(rh.Steps) <= 1 {
			return "提案没有通过平台校验：演练至少需要保留 1 个步骤，不能删除唯一步骤。"
		}
		if title == "" {
			title = target.Title
		}
	} else {
		if action == "replace" {
			if cmd == "" && title == "" && targetRole == "" && expect == "" && rollback == "" && riskNote == "" {
				return "提案没有通过平台校验：replace 至少需要提供修改后的 command、target_role、title、expect、rollback 或 risk_note 之一。"
			}
			if cmd == "" {
				cmd = target.Command
			}
			if title == "" {
				title = target.Title
			}
			if targetRole == "" {
				targetRole = target.TargetRole
			}
			if expect == "" {
				expect = target.Expect
			}
			if phase == "" {
				phase = target.Phase
			}
		} else {
			if title == "" || cmd == "" {
				return "提案没有通过平台校验：insert_before / insert_after 必须填写新步骤的 title 和 command。"
			}
			if targetRole == "" {
				targetRole = target.TargetRole
			}
			if phase == "" {
				phase = target.Phase
			}
		}
		if reRehearsalCatastrophic.MatchString(cmd) {
			return "提案没有通过平台校验：命令包含磁盘格式化或清空根目录等毁灭性操作，平台拒绝生成修订卡片。"
		}
	}

	spec := &aiRehearsalStepSpec{
		ClusterID:      rh.ClusterID,
		RehearsalID:    rh.ID,
		RehearsalTitle: rh.Title,
		StepID:         target.ID,
		StepOrder:      target.Order,
		Action:         action,
		Phase:          phase,
		Title:          title,
		TargetRole:     targetRole,
		Command:        cmd,
		Expect:         expect,
		Rollback:       rollback,
		RiskNote:       riskNote,
		OldTitle:       target.Title,
		OldTargetRole:  target.TargetRole,
		OldCommand:     target.Command,
	}
	p := aiProposal{
		ID:      randomStoreToken(6),
		Kind:    "rehearsal_step",
		Session: session,
		Status:  "pending",
		Phase:   firstNonEmptyStr(phase, target.Phase),
		Step: aiStepSpec{
			Title:    title,
			Command:  cmd,
			Expect:   expect,
			Rollback: rollback,
		},
		Reason:        reason,
		RehearsalStep: spec,
		At:            time.Now().UTC().Format(time.RFC3339),
	}
	aiMu.Lock()
	defer aiMu.Unlock()
	all := loadProposalsAt(proposalsPath)
	for _, x := range all {
		if x.Session == session && x.Kind == "rehearsal_step" && x.Status == "pending" && x.RehearsalStep != nil &&
			x.RehearsalStep.RehearsalID == spec.RehearsalID &&
			x.RehearsalStep.StepID == spec.StepID &&
			x.RehearsalStep.Action == spec.Action &&
			x.RehearsalStep.Command == spec.Command &&
			x.RehearsalStep.Title == spec.Title &&
			x.RehearsalStep.TargetRole == spec.TargetRole {
			return "这条演练步骤修订卡片已经提交过（#" + x.ID + "），用户点击下方卡片即可采纳并同步更新演练步骤。"
		}
	}
	all = append(all, p)
	if err := writeJSONFile(proposalsPath, all); err != nil {
		return "演练步骤修订卡片保存失败"
	}
	*proposed = append(*proposed, p.ID)
	return "演练步骤修订卡片 #" + p.ID + " 已生成（待用户确认，尚未写入演练）。请在回答中简明说明修改要点，并提示用户在下方卡片点击「采纳并更新演练步骤」即可立即生效。"
}

func (s *storeServer) applyRehearsalStepProposal(user string, spec *aiRehearsalStepSpec, reason string) error {
	if spec == nil || spec.ClusterID == "" || spec.RehearsalID == "" || spec.StepID == "" {
		return fmt.Errorf("演练步骤修订内容不完整")
	}
	rehearsalMu.Lock()
	defer rehearsalMu.Unlock()
	rh, ok := s.loadRehearsal(spec.ClusterID, spec.RehearsalID)
	if !ok {
		return fmt.Errorf("变更演练会话不存在或已删除")
	}
	idx := findRehearsalStepIdx(rh.Steps, spec.StepID)
	if idx < 0 {
		return fmt.Errorf("目标演练步骤已不存在（可能已被删除或重建）")
	}
	now := nowStamp()
	diag := "AI 助手对话修订：" + firstNonEmptyStr(strings.TrimSpace(reason), spec.Title)
	switch spec.Action {
	case "delete":
		if len(rh.Steps) <= 1 {
			return fmt.Errorf("演练至少需要保留 1 个步骤")
		}
		rh.Steps = append(rh.Steps[:idx], rh.Steps[idx+1:]...)
	case "insert_before", "insert_after":
		newStep := rehearsalStep{
			ID:         "s-" + randomStoreToken(4),
			Phase:      firstNonEmptyStr(spec.Phase, rh.Steps[idx].Phase, "execute"),
			Title:      firstNonEmptyStr(spec.Title, "新增演练步骤"),
			TargetRole: firstNonEmptyStr(spec.TargetRole, rh.Steps[idx].TargetRole),
			Command:    ensurePasteSafeShellCommand(spec.Command),
			Expect:     firstNonEmptyStr(spec.Expect, "命令返回码为 0 且状态符合预期"),
			Rollback:   strings.TrimSpace(spec.Rollback),
			RiskNote:   strings.TrimSpace(spec.RiskNote),
			Status:     "pending",
			Revisions: []rehearsalStepRevision{{
				At:         now,
				By:         user,
				Diagnosis:  diag,
				NewCommand: ensurePasteSafeShellCommand(spec.Command),
			}},
		}
		pos := idx
		if spec.Action == "insert_after" {
			pos = idx + 1
		}
		next := make([]rehearsalStep, 0, len(rh.Steps)+1)
		next = append(next, rh.Steps[:pos]...)
		next = append(next, newStep)
		next = append(next, rh.Steps[pos:]...)
		rh.Steps = next
	default: // replace
		st := &rh.Steps[idx]
		oldCmd := st.Command
		if spec.Title != "" {
			st.Title = spec.Title
		}
		if spec.TargetRole != "" {
			st.TargetRole = spec.TargetRole
		}
		if spec.Phase != "" {
			st.Phase = spec.Phase
		}
		if strings.TrimSpace(spec.Command) != "" {
			st.Command, st.Commands = reconcileStepCommands(st.Commands, spec.Command, st.TargetRole, "zh-CN")
		}
		if spec.Expect != "" {
			st.Expect = spec.Expect
		}
		if spec.Rollback != "" {
			st.Rollback = spec.Rollback
		}
		if spec.RiskNote != "" {
			st.RiskNote = spec.RiskNote
		}
		st.Revisions = append(st.Revisions, rehearsalStepRevision{
			At:         now,
			By:         user,
			Diagnosis:  diag,
			OldCommand: oldCmd,
			NewCommand: st.Command,
		})
		st.Status = "pending"
		st.VerifiedByAI = false
		st.Proposal = nil
	}
	for i := range rh.Steps {
		rh.Steps[i].Order = i + 1
	}
	return s.saveRehearsal(rh)
}

func aiProposeRehearsalTool() aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return aiToolDef{
		Name:        "propose_rehearsal",
		Description: "当目标集群已投产/运行中且涉及**任何配置、参数、规则、文件或服务状态的变更**（哪怕只是 1 条热重载命令！）时，必须调用此工具生成变更入口卡片，确保每次改动都能在演练台执行留痕并生成归档《变更报告》：（1）仅纯只读排查/查日志/查状态（零修改）不要调用；（2）变更极简、无需重启切主且现场现状已明确（如在线 reload 改 log_filename / log_rotation_size）→ mode=\"quick\"（极速变更：跳过问答与探针，2 步直出执行清单并一键生成《变更报告》）；（3）无需重启切主但现场状态拿不准需先跑只读探针 → mode=\"light\"（简单推演）；（4）涉及滚动重启、切主、升级、扩缩容、备份/WAL 或 TLS 证书改造 → mode=\"full\"（全量四步推演与生产 SOP）。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"cluster_id": str("目标集群标识（已关联交付或当前交付对话中可省略，自动取当前集群）"),
				"mode":       map[string]any{"type": "string", "enum": []string{"quick", "light", "full"}, "description": "变更档位：quick（极速变更：特别简单、无需重启切主且现场现状已在对话/截图中明确，跳过问答和探针直出 2～3 步执行清单并生成《变更报告》）；light（简单推演：局部改配置/动态调参无需重启切主但现场状态拿不准，先出一屏只读探针再执行并生成《变更报告》）；full（全量推演：需滚动重启、切主、版本/CVE 升级、扩缩容、备份/WAL 或证书改造等高风险变更，走完整四步并定稿生产 SOP）"},
				"kind":       map[string]any{"type": "string", "enum": []string{"tune", "upgrade", "scale", "switch", "security", "change"}, "description": "变更类别：tune（参数/配置/备份策略调整）、upgrade（版本升级/补丁）、scale（扩缩容/架构变更）、switch（主备切换/容灾演练）、security（CVE/安全加固）、change（其他投产后变更）"},
				"title":      str("简明变更标题，如「调整 PostgreSQL 日志文件名与 1GB 轮转阈值」或「Patroni pg_hba 补充 127.0.0.1 复制规则」"),
				"goal":       str("写入演练目标输入框的完整、可执行变更诉求（明确变更对象、原值→目标值、具体命令要点及验证与回退要求；quick 模式尤其要写清已确认的现状与目标参数，以便直出精确步骤）"),
				"summary":    str("卡片正文展示的简要摘要与核心验证点（1～3 句话）"),
				"reason":     str("为什么建议走极速变更 / 简单推演 / 全量推演（1 句话，如：属于在线 reload 参数修改且现状已确认，走极速变更直出执行步骤并自动归档变更报告）"),
				"packages":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "可选：仅安全修复或软件包升级时填写涉及的包名"},
				"cves":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "可选：仅安全修复演练时填写涉及的 CVE 编号"},
			},
			"required": []string{"title", "goal", "summary"},
		},
	}
}

func normalizeRehearsalKind(kind string, hasSec bool) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "upgrade", "scale", "tune", "switch", "security", "change":
		return strings.ToLower(strings.TrimSpace(kind))
	}
	if hasSec {
		return "security"
	}
	return "change"
}

func normalizeRehearsalMode(mode string, hasSec bool) string {
	if hasSec {
		return "full"
	}
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "quick":
		return "quick"
	case "light":
		return "light"
	case "full":
		return "full"
	default:
		return "full"
	}
}

func (s *storeServer) buildRehearsalSpec(user, defaultCluster, defaultJobID string, a map[string]any, forceSecurity bool) (*aiRehearsalSpec, string) {
	str := func(k string) string { v, _ := a[k].(string); return strings.TrimSpace(v) }
	ref := firstNonEmptyStr(str("cluster_id"), str("delivery"), defaultCluster)
	var matchedJob storeJob
	var hasJob bool
	if ref != "" && user != "" {
		matchedJob, hasJob = s.ownJob(user, ref)
	}
	if !hasJob && defaultJobID != "" {
		s.mu.Lock()
		matchedJob, hasJob = s.jobs[defaultJobID]
		s.mu.Unlock()
	}
	cid := ref
	if hasJob && matchedJob.ClusterID != "" {
		cid = matchedJob.ClusterID
	}
	title := truncRunes(str("title"), 100)
	goal := truncRunes(str("goal"), 1600)
	summary := truncRunes(str("summary"), 400)
	reason := truncRunes(str("reason"), 300)
	if goal == "" {
		goal = summary
	}
	if summary == "" {
		summary = truncRunes(goal, 320)
	}
	if cid == "" || title == "" || summary == "" {
		return nil, "演练卡片参数不完整：cluster_id、title、summary/goal 为必填。"
	}
	toList := func(k string) []string {
		var out []string
		if arr, ok := a[k].([]any); ok {
			for _, it := range arr {
				if sv, ok := it.(string); ok && strings.TrimSpace(sv) != "" {
					out = append(out, strings.TrimSpace(sv))
				}
			}
		}
		return out
	}
	pkgs := toList("packages")
	cves := toList("cves")
	isSec := forceSecurity || len(pkgs) > 0 || len(cves) > 0
	kind := normalizeRehearsalKind(str("kind"), isSec)
	mode := normalizeRehearsalMode(str("mode"), isSec || kind == "security")

	running := false
	appLabel := ""
	if hasJob {
		appLabel = strings.TrimSpace(strings.TrimSpace(matchedJob.AppName) + " " + strings.TrimSpace(matchedJob.Version))
		s.mu.Lock()
		_, running = clusterHead(s.clusterOf(cid))
		s.mu.Unlock()
	} else {
		s.mu.Lock()
		jobs := s.clusterOf(cid)
		if head, ok := clusterHead(jobs); ok {
			running = true
			appLabel = strings.TrimSpace(strings.TrimSpace(head.AppName) + " " + strings.TrimSpace(head.Version))
		} else if cur, ok := clusterCurrent(jobs); ok {
			appLabel = strings.TrimSpace(strings.TrimSpace(cur.AppName) + " " + strings.TrimSpace(cur.Version))
		}
		s.mu.Unlock()
	}

	return &aiRehearsalSpec{
		ClusterID: cid,
		Kind:      kind,
		Mode:      mode,
		Title:     title,
		Goal:      goal,
		Packages:  pkgs,
		CVEs:      cves,
		Summary:   summary,
		Reason:    reason,
		Running:   running,
		AppLabel:  appLabel,
	}, ""
}

func aiProposeKnowledgeTool() aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return aiToolDef{
		Name:        "propose_knowledge",
		Description: "当用户要求把本次排障、变更方案或操作经验整理/生成/写入知识库，或一段有复用价值的现场排障/变更经验已经明确且适合沉淀时，调用此工具生成一张「写入知识库总结卡片」。用户可以在卡片中预览、微调标题和 Markdown 正文，并一键「存入我的知识库」或「发布/提交到团队知识库」。严禁编造未确认的根因，严禁包含任何密码、私钥或令牌。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"title":   str("知识库文档标题（不超过 100 字），如「Patroni 管理的 PostgreSQL 17 开启日志落盘与轮转操作指南」"),
				"summary": str("一句话核心摘要/适用场景（不超过 240 字）"),
				"content": str("完整的 Markdown 正文，建议包含适用范围、前置原则、清晰操作步骤、验证命令、回退方式与风险注意事项；未确认的根因须如实标明「待确认」，严禁包含口令密钥"),
				"scope":   map[string]any{"type": "string", "enum": []string{"personal", "team"}, "description": "推荐写入位置：personal（我的知识库）或 team（团队知识库）；用户提到团队/共享/规范时优先 team，否则可填 personal"},
				"source":  str("可选：来源说明（如集群标识或主题，省略时自动填充）"),
			},
			"required": []string{"title", "summary", "content"},
		},
	}
}

func buildKnowledgeSpec(defaultSource string, a map[string]any) (*aiKnowledgeSpec, string) {
	str := func(k string) string { v, _ := a[k].(string); return strings.TrimSpace(v) }
	title := truncRunes(str("title"), 120)
	summary := truncRunes(str("summary"), 300)
	content := strings.TrimRight(str("content"), " \n")
	if title == "" {
		return nil, "知识库卡片缺少标题（title）。"
	}
	if content == "" {
		return nil, "知识库卡片缺少正文内容（content）。"
	}
	if len(content) > 200<<10 {
		return nil, "知识库正文过长（请控制在 200 KiB 以内）。"
	}
	title = aiScrub(title)
	summary = aiScrub(summary)
	content = aiScrub(content)
	scope := strings.ToLower(str("scope"))
	if scope != "team" {
		scope = "personal"
	}
	source := truncRunes(firstNonEmptyStr(str("source"), defaultSource), 200)
	if summary == "" {
		summary = truncRunes(strings.Join(strings.Fields(content), " "), 180)
	}
	return &aiKnowledgeSpec{
		Title:   title,
		Summary: summary,
		Content: content,
		Scope:   scope,
		Source:  source,
	}, ""
}

func (s *storeServer) createKnowledgeProposal(proposalsPath, session, defaultSource string, a map[string]any, proposed *[]string) string {
	spec, errMsg := buildKnowledgeSpec(defaultSource, a)
	if errMsg != "" {
		return "知识库卡片未通过校验：" + errMsg
	}
	p := aiProposal{
		ID:        randomStoreToken(6),
		Kind:      "knowledge",
		Session:   session,
		Status:    "pending",
		Step:      aiStepSpec{Title: spec.Title, Desc: spec.Summary},
		Reason:    spec.Summary,
		Knowledge: spec,
		At:        time.Now().UTC().Format(time.RFC3339),
	}
	aiMu.Lock()
	defer aiMu.Unlock()
	var all []aiProposal
	if b, err := os.ReadFile(proposalsPath); err == nil {
		_ = json.Unmarshal(b, &all)
	}
	for _, x := range all {
		if x.Session == session && x.Kind == "knowledge" && x.Status == "pending" && x.Knowledge != nil && x.Knowledge.Title == spec.Title {
			return "知识库总结卡片 #" + x.ID + " 已生成（标题：「" + spec.Title + "」），用户可在卡片上预览微调并一键存入个人或团队知识库。"
		}
	}
	all = append(all, p)
	if err := writeJSONFile(proposalsPath, all); err != nil {
		return "知识库卡片无法保存"
	}
	if proposed != nil {
		*proposed = append(*proposed, p.ID)
	}
	return "已生成写入知识库总结卡片 #" + p.ID + "（标题：「" + spec.Title + "」）。用户可在下方卡片直接预览/微调内容，一键「存入我的知识库」或「发布/提交到团队知识库」。"
}

func (s *storeServer) buildComponentSpec(a map[string]any) (*aiComponentSpec, string) {
	str := func(k string) string { v, _ := a[k].(string); return strings.TrimSpace(v) }
	name, title, detail, why := str("component"), str("title"), str("detail"), str("why")
	if _, ok := s.plat.cat().Get(name); !ok {
		return nil, "没有叫 " + name + " 的组件。用 list_components 或交付里的组件名。"
	}
	if title == "" || detail == "" || len([]rune(title)) > 80 || len([]rune(detail)) > 800 {
		return nil, "title（80 字内）和 detail（800 字内）都要写：说明要加什么参数、检查或修复、为什么、放在哪个阶段。"
	}
	return &aiComponentSpec{
		Component: name,
		Title:     aiScrub(title),
		Detail:    aiScrub(detail),
		Why:       aiScrub(truncRunes(why, 300)),
	}, ""
}

// controllerFacts is how commands are run on this delivery's controller, so every command the assistant writes works
// as typed: where the project is, which Ansible binaries, which inventory, where uploads go.
func (s *storeServer) controllerFacts(job string) string {
	var p struct {
		DeliveryMode  string                `json:"delivery_mode"`
		Platform      string                `json:"platform"`
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
	modeLine := "- 交付模式：离线手工部署（offline）——平台不直接连接目标服务器；涉及目标机现场运行状态（如磁盘、日志、服务、内核参数）时，给出只读检查命令请工程师在目标机执行并贴回。\n"
	switch p.DeliveryMode {
	case "automatic":
		modeLine = "- 交付模式：自动化执行（automatic）——可通过 execution_history / execution_log 查看授权执行节点回传的真实步骤与日志；平台本身仍不直接 SSH 目标机。\n"
	case "configuration":
		modeLine = "- 交付模式：仅生成配置（configuration）——只产出配置文件与说明，不执行部署步骤。\n"
	}
	plLine := ""
	if p.Platform != "" {
		plLine = "- 目标操作系统：" + p.Platform + "。\n"
	}
	location := ""
	if p.ExecutionHost != nil {
		location = "- 这是独立管理机（" + p.ExecutionHost.IP + "），不承载数据库角色。psql、redis-cli、数据库配置和服务检查必须在对应业务机器执行，不能假设控制节点就是主库。跨主机命令仍通过本交付清单和 playbook 执行。\n"
	}
	return "\n\n# 这份交付在控制节点上怎么执行命令（写给工程师的命令必须照这个写，能直接复制执行）\n" +
		modeLine +
		plLine +
		"- 控制节点：" + p.Controller + "，用 root 执行。\n" +
		location +
		"- 项目目录：" + p.Dir + "。手册里的 playbook 命令都是在这个目录下执行的。\n" +
		"- 交付只提供两个离线命令入口：" + bin + "/ansible-playbook 和 " + bin + "/ansible-inventory。没有 " + bin + "/ansible，不得生成该路径或裸 ansible 命令，也不得假设系统 PATH 已安装 Ansible。\n" +
		"- 清单：inventory/hosts.yml（相对项目目录）。主机名用清单里的名字。\n" +
		"- 上传目录：" + p.Upload + "。\n" +
		"- 执行已有 playbook 的完整形式：cd " + p.Dir + " && " + bin + "/ansible-playbook -i inventory/hosts.yml <已核实存在的playbook路径>。不要原样输出占位符。查看清单：cd " + p.Dir + " && " + bin + "/ansible-inventory -i inventory/hosts.yml --graph。\n" +
		"- ansible-playbook 不支持 ad-hoc 的 -m/-a 参数，不能把 ansible -m 的命令仅替换名字。单机只读排查应写明目标机器并直接执行 shell 命令；跨机器检查用已核实的 playbook，若需临时 playbook 必须给出完整文件内容和保存位置，不能臆造已有文件。\n"
}

// deliverySkillHint suggests the exact domain skills matching the components in this delivery so the model routes immediately.
func (s *storeServer) deliverySkillHint(job string) string {
	var p struct {
		DeliveryMode string `json:"delivery_mode"`
		Instances    []struct {
			Component string `json:"component"`
		} `json:"instances"`
	}
	if json.Unmarshal(s.jobPlan(job), &p) != nil || len(p.Instances) == 0 {
		return ""
	}
	seen := map[string]bool{}
	var comps, skills []string
	addSkill := func(n string) {
		if !seen["sk:"+n] {
			seen["sk:"+n] = true
			skills = append(skills, n)
		}
	}
	for _, inst := range p.Instances {
		c := strings.TrimSpace(inst.Component)
		if c == "" || seen["c:"+c] {
			continue
		}
		seen["c:"+c] = true
		comps = append(comps, c)
		switch c {
		case "postgresql", "patroni":
			addSkill("postgresql-patroni")
		case "etcd":
			addSkill("etcd-ops")
		case "redis":
			addSkill("redis-sentinel")
		case "haproxy", "keepalived":
			addSkill("haproxy-keepalived")
		case "nginx":
			addSkill("nginx-stream")
		}
	}
	if p.DeliveryMode == "automatic" {
		addSkill("automatic-execution")
	}
	if len(skills) == 0 {
		return ""
	}
	return "\n本次交付涉及组件：" + strings.Join(comps, "、") + "。涉及具体中间件运行机制、调优或排障时，可按需用 use_skill 读取：" + strings.Join(skills, "、") + "；涉及日志落盘、轮转、journald 或监控核对时可读取 middleware-logging-observability。\n"
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
	_ = s.loadJobDocValue(job, "proposals_json", s.proposalsPath(job), &out)
	return out
}

func (s *storeServer) saveProposals(job string, list []aiProposal) error {
	return s.saveJobDocValue(job, "proposals_json", s.proposalsPath(job), list)
}

func (s *storeServer) loadAmendments(job string) []aiAmendment {
	out := []aiAmendment{}
	_ = s.loadJobDocValue(job, "amendments_json", s.amendmentsPath(job), &out)
	return out
}

func (s *storeServer) saveAmendments(job string, list []aiAmendment) error {
	return s.saveJobDocValue(job, "amendments_json", s.amendmentsPath(job), list)
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
	return aiToolDef{"suggest_component_change", "当识别到组件本身的缺陷、缺失通用前置检查，或组件缺少有普遍价值的配置参数/能力入口（例如 PostgreSQL 组件未暴露 logging_collector / log_directory / 日志轮转参数导致无法固化到交付规格，或部署前缺少通用盘符/权限核对）时，调用此工具生成一张「组件改进建议」卡片，让用户一键跳转组件工作台让 AI 起草改动。交付对话中调用前必须先用 component_sync_status 核对当前已发布组件和草稿是否已经支持/修复：若当前已发布组件已修复，不要重复提交建议，直接引导用户点击「同步组件更新」。可与「变更演练卡片」或「写入知识库卡片」同时输出。", map[string]any{"type": "object", "properties": map[string]any{
		"component": str("组件名，如 postgresql"),
		"title":     str("一句话：要补充什么参数、检查或修复"),
		"detail":    str("具体加/改什么、放在哪个阶段或配置入口、通过标准、为什么；本次遇到的问题或缺失是什么"),
		"why":       str("本次识别到的组件缺陷或能力缺失根因（一句话）"),
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
	var latestSync *jobSync
	s.mu.Lock()
	j, hasJob := s.jobs[job]
	s.mu.Unlock()
	var plan *syncPlanMeta
	if hasJob && len(j.Syncs) > 0 && j.DeliveryMode != "automatic" && j.DeliveryMode != "configuration" {
		plan = parseSyncPlanMeta(s.jobPlan(job))
		if plan != nil && plan.DeliveryMode != "automatic" && plan.DeliveryMode != "configuration" {
			enriched := s.enrichJobSyncs(job, plan, j.Syncs)
			last := enriched[len(enriched)-1]
			if last.VerifyCmd != "" {
				latestSync = &last
			}
		}
	}
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
			if phase == "deploy" && latestSync != nil && plan != nil {
				md = injectSyncDeploySection(md, plan, *latestSync)
			}
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
		// Enforce per-kind permission (route allows delivery.run|security.manage).
		switch p.Kind {
		case "vex", "baseline_waive":
			if !s.accessOf(user.User).can("security.manage") {
				aiMu.Unlock()
				s.need(w, user.User, "security.manage")
				return
			}
		case "rehearsal", "rehearsal_step", "knowledge":
			// navigating to rehearsal, editing an active rehearsal step, or saving personal KB requires only signed-in AI user; team KB checked below
		default:
			if !s.accessOf(user.User).can("delivery.run") {
				aiMu.Unlock()
				s.need(w, user.User, "delivery.run")
				return
			}
		}
		now := time.Now().UTC().Format(time.RFC3339)
		if parts[1] == "accept" && p.Kind == "vex" {
			if err := s.applyVexProposal(r, user.User, p.Vex); err != nil {
				aiMu.Unlock()
				s.fail(w, 409, err.Error())
				return
			}
			p.Status = "accepted"
		} else if parts[1] == "accept" && p.Kind == "baseline_waive" {
			if err := s.applyBaselineWaiveProposal(r, user.User, p.Baseline); err != nil {
				aiMu.Unlock()
				s.fail(w, 409, err.Error())
				return
			}
			p.Status = "accepted"
		} else if parts[1] == "accept" && p.Kind == "rehearsal" {
			p.Status = "accepted"
		} else if parts[1] == "accept" && p.Kind == "rehearsal_step" {
			if err := s.applyRehearsalStepProposal(user.User, p.RehearsalStep, p.Reason); err != nil {
				aiMu.Unlock()
				s.fail(w, 409, err.Error())
				return
			}
			p.Status = "accepted"
		} else if parts[1] == "accept" && p.Kind == "knowledge" {
			if p.Knowledge == nil {
				aiMu.Unlock()
				s.fail(w, 400, "知识库提案内容为空")
				return
			}
			var kbIn struct {
				Scope   string `json:"scope"`
				Title   string `json:"title"`
				Content string `json:"content"`
				Team    string `json:"team"`
			}
			_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&kbIn)
			kb := *p.Knowledge
			if t := strings.TrimSpace(kbIn.Title); t != "" {
				kb.Title = truncRunes(t, 120)
			}
			if c := strings.TrimRight(kbIn.Content, " \n"); strings.TrimSpace(c) != "" {
				kb.Content = c
			}
			targetScope := strings.ToLower(strings.TrimSpace(kbIn.Scope))
			if targetScope == "" {
				targetScope = firstNonEmptyStr(kb.Scope, "personal")
			}
			if targetScope == "team" {
				acc := s.accessOf(user.User)
				if !acc.can("kb.manage") && !acc.can("kb.submit") {
					aiMu.Unlock()
					s.need(w, user.User, "kb.submit")
					return
				}
				teamKBMu.Lock()
				if acc.can("kb.manage") {
					d, err := s.saveTeamDoc(teamDoc{
						kbDoc:  kbDoc{Title: kb.Title, Text: kb.Content},
						Team:   strings.TrimSpace(kbIn.Team),
						By:     user.User,
						Source: kb.Source,
						Editor: user.User,
					})
					teamKBMu.Unlock()
					if err != nil {
						aiMu.Unlock()
						s.fail(w, 400, err.Error())
						return
					}
					kb.Scope = "team"
					kb.TeamDocID = d.ID
					s.auditReq(r, "kb-edit", user.User, d.Title)
				} else {
					sub := kbSubmission{
						ID:     randomStoreToken(6),
						Title:  kb.Title,
						Text:   kb.Content,
						Team:   strings.TrimSpace(kbIn.Team),
						Source: kb.Source,
						By:     user.User,
						At:     now,
						Status: "pending",
					}
					err := writeJSONFile(filepath.Join(s.teamKBDir("submissions"), sub.ID+".json"), sub)
					teamKBMu.Unlock()
					if err != nil {
						aiMu.Unlock()
						s.fail(w, 500, "提交团队知识库失败")
						return
					}
					kb.Scope = "team"
					kb.SubmissionID = sub.ID
					s.auditReq(r, "kb-submit", user.User, sub.Title)
				}
			} else {
				d, err := s.kbSave(user.User, kbDoc{Title: kb.Title, Text: kb.Content})
				if err != nil {
					aiMu.Unlock()
					s.fail(w, 400, err.Error())
					return
				}
				kb.Scope = "personal"
				kb.KBID = d.ID
			}
			p.Knowledge = &kb
			p.Step.Title = kb.Title
			p.Status = "accepted"
		} else if parts[1] == "accept" && p.Kind == "file" {
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
			if err := s.saveAmendments(id, ams); err != nil {
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
		err := s.saveProposals(id, all)
		aiMu.Unlock()
		if err != nil {
			s.fail(w, 500, "无法保存")
			return
		}
		state := "ai-accepted"
		if p.Status == "rejected" {
			state = "ai-rejected"
		}
		evTitle := p.Step.Title
		if evTitle == "" && p.Vex != nil {
			evTitle = "VEX: " + firstNonEmptyStr(p.Vex.CVE, strings.Join(p.Vex.CVEs, ","))
		} else if evTitle == "" && p.Baseline != nil {
			evTitle = "基线豁免: " + firstNonEmptyStr(p.Baseline.Title, p.Baseline.CheckID)
		} else if evTitle == "" && p.Rehearsal != nil {
			evTitle = "演练建议: " + p.Rehearsal.Title
		} else if evTitle == "" && p.RehearsalStep != nil {
			evTitle = "演练步骤修订: " + firstNonEmptyStr(p.RehearsalStep.Title, p.RehearsalStep.StepID)
		} else if evTitle == "" && p.Knowledge != nil {
			evTitle = "知识库沉淀: " + p.Knowledge.Title
		}
		s.mu.Lock()
		doc := s.readProgress(id)
		doc.Events = append(doc.Events, progressEvent{At: now, By: user.User, Key: "ai-" + p.ID, Title: truncRunes(evTitle, 120), State: state})
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
		if err := s.saveAmendments(id, keep); err != nil {
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
		_ = s.saveProposals(id, all)
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

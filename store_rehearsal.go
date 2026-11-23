package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"middleware-deployer/mwpack"
)

// Guided AI Change Rehearsal Workbench (变更演练工作台):
// Rather than pre-baking brittle post-deployment playbooks that assume zero drift on production, this workbench uses
// AI (only when the global AI master switch is ON) to:
//   1. Align scope & maintenance window boundaries against the cluster's initial delivery baseline (scoping);
//   2. Generate a statically verified 100% read-only inspection script to detect live topology/config drift (probing);
//   3. Walk the engineer step-by-step through rehearsing & troubleshooting commands in a test environment (rehearsing);
//   4. Finalize a verified Production Change SOP document mapped to real production hosts & exportable to Word (finalized).

var (
	reRehearsalID  = regexp.MustCompile(`^[0-9a-f]{12}$`)
	reRehearsalImg = regexp.MustCompile(`^[0-9a-f]{20}\.(png|jpg|gif|webp)$`)
	reStepID       = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,40}$`)
	rehearsalMu    sync.Mutex
)

type rehearsalTraceStep struct {
	ID     string      `json:"id"`
	Kind   string      `json:"kind"` // inspect | guard | connect | think | synthesize
	Title  string      `json:"title"`
	Detail string      `json:"detail,omitempty"`
	MS     int64       `json:"ms,omitempty"`
	OK     bool        `json:"ok"`
	Status string      `json:"status,omitempty"` // pending | running | done | warn | error
	Diag   *aiCallDiag `json:"diag,omitempty"`
}

type rehearsalPipelineSpec struct {
	PreSteps   []rehearsalTraceStep
	ThinkTitle string
	ThinkWait  string
	SynthID    string
	SynthKind  string
	SynthTitle string
	SynthWait  string
	Validate   func(string) error
}

type rehearsalTrace struct {
	Stage     string               `json:"stage"` // create | scope | probe | troubleshoot
	Model     string               `json:"model,omitempty"`
	Provider  string               `json:"provider,omitempty"`
	Thinking  string               `json:"thinking,omitempty"`
	Reasoning int                  `json:"reasoning,omitempty"`
	Steps     []rehearsalTraceStep `json:"steps,omitempty"`
	InTokens  int                  `json:"in_tokens,omitempty"`
	OutTokens int                  `json:"out_tokens,omitempty"`
	MS        int64                `json:"ms,omitempty"`
	At        string               `json:"at,omitempty"`
	Diag      *aiCallDiag          `json:"diag,omitempty"`
}

type rehearsalScopeQuestion struct {
	ID       string   `json:"id"`
	Label    string   `json:"label,omitempty"`
	Question string   `json:"question"`
	Options  []string `json:"options,omitempty"`
	Answer   string   `json:"answer,omitempty"`
}

type rehearsalDriftHost struct {
	Name        string `json:"name"`
	IP          string `json:"ip"`
	InitialRole string `json:"initial_role"`
	ActualRole  string `json:"actual_role"`
	Version     string `json:"version,omitempty"`
	Status      string `json:"status"`
}

type rehearsalDriftParam struct {
	Key     string `json:"key"`
	Initial string `json:"initial"`
	Actual  string `json:"actual"`
	Risk    string `json:"risk,omitempty"`
}

type rehearsalDrift struct {
	Summary         string                `json:"summary"`
	Drifted         bool                  `json:"drifted"`
	Hosts           []rehearsalDriftHost  `json:"hosts"`
	ParamDiffs      []rehearsalDriftParam `json:"param_diffs,omitempty"`
	Risks           []string              `json:"risks,omitempty"`
	Recommendations []string              `json:"recommendations,omitempty"`
}

type rehearsalStepProposal struct {
	Diagnosis     string   `json:"diagnosis"`
	Action        string   `json:"action"` // replace | insert_before | retry
	Title         string   `json:"title,omitempty"`
	TargetRole    string   `json:"target_role,omitempty"`
	Command       string   `json:"command"`
	Expect        string   `json:"expect,omitempty"`
	Rollback      string   `json:"rollback,omitempty"`
	RiskNote      string   `json:"risk_note,omitempty"`
	VerifiedFacts []string `json:"verified_facts,omitempty"`
	MissingItems  []string `json:"missing_items,omitempty"`
}

type rehearsalStepRevision struct {
	At           string `json:"at"`
	By           string `json:"by,omitempty"`
	ErrorSnippet string `json:"error_snippet,omitempty"`
	Diagnosis    string `json:"diagnosis"`
	OldCommand   string `json:"old_command,omitempty"`
	NewCommand   string `json:"new_command"`
}

type rehearsalVerifyAttempt struct {
	Round         int      `json:"round"`
	At            string   `json:"at"`
	By            string   `json:"by,omitempty"`
	Verdict       string   `json:"verdict"` // passed | failed
	Summary       string   `json:"summary,omitempty"`
	Diagnosis     string   `json:"diagnosis,omitempty"`
	Action        string   `json:"action,omitempty"`
	TargetRole    string   `json:"target_role,omitempty"`
	FixCommand    string   `json:"fix_command,omitempty"`
	VerifiedFacts []string `json:"verified_facts,omitempty"`
	MissingItems  []string `json:"missing_items,omitempty"`
	Thinking      string   `json:"thinking,omitempty"`
	Output        string   `json:"output,omitempty"`
	Images        []string `json:"images,omitempty"`
	Model         string   `json:"model,omitempty"`
}

type rehearsalStepCommand struct {
	Label      string `json:"label,omitempty"`
	TargetRole string `json:"target_role,omitempty"`
	Command    string `json:"command"`
	Gate       string `json:"gate,omitempty"`
}

type rehearsalStep struct {
	ID             string                   `json:"id"`
	Phase          string                   `json:"phase"` // precheck | execute | verify | rollback
	Order          int                      `json:"order"`
	Title          string                   `json:"title"`
	TargetRole     string                   `json:"target_role"`
	Command        string                   `json:"command"`
	Commands       []rehearsalStepCommand   `json:"commands,omitempty"`
	Expect         string                   `json:"expect"`
	RiskNote       string                   `json:"risk_note,omitempty"`
	Rollback       string                   `json:"rollback,omitempty"`
	Optional       bool                     `json:"optional,omitempty"`
	Status         string                   `json:"status"` // pending | passed | failed | skipped
	Elapsed        string                   `json:"elapsed,omitempty"`
	Note           string                   `json:"note,omitempty"`
	VerifiedByAI   bool                     `json:"verified_by_ai,omitempty"`
	EvidenceImages []string                 `json:"evidence_images,omitempty"`
	LastError      string                   `json:"last_error,omitempty"`
	ErrorImages    []string                 `json:"error_images,omitempty"`
	TroubleTrace   *rehearsalTrace          `json:"trouble_trace,omitempty"`
	Proposal       *rehearsalStepProposal   `json:"proposal,omitempty"`
	Revisions      []rehearsalStepRevision  `json:"revisions,omitempty"`
	VerifyHistory  []rehearsalVerifyAttempt `json:"verify_history,omitempty"`
}

type rehearsalSecurityContext struct {
	Kind             string   `json:"kind"` // cve_patch | config_hardening | cert_rotation
	FindingKeys      []string `json:"finding_keys,omitempty"`
	CVEs             []string `json:"cves,omitempty"`
	Package          string   `json:"package,omitempty"`
	Ecosystem        string   `json:"ecosystem,omitempty"`
	CurrentVersion   string   `json:"current_version,omitempty"`
	TargetVersion    string   `json:"target_version,omitempty"`
	RepoFixReady     bool     `json:"repo_fix_ready,omitempty"`
	BaselineCheckIDs []string `json:"baseline_check_ids,omitempty"`
	CertTarget       string   `json:"cert_target,omitempty"`
	VEXSynced        bool     `json:"vex_synced,omitempty"`
	VEXStatus        string   `json:"vex_status,omitempty"`
	VEXSyncedAt      string   `json:"vex_synced_at,omitempty"`
}

type rehearsalProbeIssue struct {
	Status        string   `json:"status"`                   // failed | incomplete
	Summary       string   `json:"summary"`                  // 简明阻断结论
	Cause         string   `json:"cause"`                    // 根因诊断
	FixCommand    string   `json:"fix_command,omitempty"`    // 推荐直接执行的修复命令（如 bash /tmp/collect-...sh）
	FixSteps      []string `json:"fix_steps,omitempty"`      // 逐步补救建议
	FixedScript   string   `json:"fixed_script,omitempty"`   // 若脚本需修订，提供完整新版纯只读脚本
	FixedSafe     bool     `json:"fixed_safe,omitempty"`     // 修订版是否通过静态只读安全扫描
	FixedWarnings []string `json:"fixed_warnings,omitempty"` // 修订版告警（如有）
	ScriptUpdated bool     `json:"script_updated,omitempty"` // 是否已自动替换上方探针脚本
	MissingItems  []string `json:"missing_items,omitempty"`  // 仍缺失的关键现场数据项
	At            string   `json:"at,omitempty"`
}

type rehearsalRestorationAlert struct {
	Kind       string `json:"kind"` // switchover | maintenance_pause | lb_drain | sync_relaxed | debug_log | service_stopped | temp_artifact
	StepID     string `json:"step_id"`
	StepOrder  int    `json:"step_order"`
	StepTitle  string `json:"step_title"`
	Summary    string `json:"summary"`
	Suggestion string `json:"suggestion"`
}

type rehearsalAppliedChange struct {
	Key    string `json:"key"`
	Before string `json:"before,omitempty"`
	After  string `json:"after"`
	Note   string `json:"note,omitempty"`
}

type rehearsalConflictAlert struct {
	Severity        string   `json:"severity"` // conflict | stale | earlier_pending
	OtherID         string   `json:"other_id"`
	OtherTitle      string   `json:"other_title"`
	OtherAt         string   `json:"other_at,omitempty"`
	OverlappingKeys []string `json:"overlapping_keys,omitempty"`
	Summary         string   `json:"summary"`
}

type changeRehearsal struct {
	ID                string                      `json:"id"`
	ClusterID         string                      `json:"cluster_id"`
	AppID             string                      `json:"app_id"`
	AppName           string                      `json:"app_name"`
	BaseJobID         string                      `json:"base_job_id"`
	Title             string                      `json:"title"`
	Goal              string                      `json:"goal"`
	GoalImages        []string                    `json:"goal_images,omitempty"`
	ExtraScope        string                      `json:"extra_scope,omitempty"`
	Owner             string                      `json:"owner"`
	Mode              string                      `json:"mode,omitempty"` // quick | light | full (empty treated as full)
	Stage             string                      `json:"stage"`          // scoping | probing | rehearsing | finalized
	SecurityContext   *rehearsalSecurityContext   `json:"security_context,omitempty"`
	ScopeQuestions    []rehearsalScopeQuestion    `json:"scope_questions,omitempty"`
	ScopeSummary      string                      `json:"scope_summary,omitempty"`
	IntentUnclear     bool                        `json:"intent_unclear,omitempty"`
	ProbeScript       string                      `json:"probe_script,omitempty"`
	ProbeNotes        []string                    `json:"probe_notes,omitempty"`
	ProbeSafe         bool                        `json:"probe_safe"`
	ProbeWarnings     []string                    `json:"probe_warnings,omitempty"`
	ProbeOutput       string                      `json:"probe_output,omitempty"`
	ProbeImages       []string                    `json:"probe_images,omitempty"`
	ProbeIssue        *rehearsalProbeIssue        `json:"probe_issue,omitempty"`
	ManualState       string                      `json:"manual_state,omitempty"`
	Drift             *rehearsalDrift             `json:"drift,omitempty"`
	TestEnvNote       string                      `json:"test_env_note,omitempty"`
	Steps             []rehearsalStep             `json:"steps,omitempty"`
	RestorationAlerts []rehearsalRestorationAlert `json:"restoration_alerts,omitempty"`
	ConflictAlerts    []rehearsalConflictAlert    `json:"conflict_alerts,omitempty"`
	Traces            map[string]rehearsalTrace   `json:"traces,omitempty"`
	DocID             string                      `json:"doc_id,omitempty"`
	BaseAppliedIDs    []string                    `json:"base_applied_ids,omitempty"`
	Applied           bool                        `json:"applied,omitempty"`
	AppliedAt         string                      `json:"applied_at,omitempty"`
	AppliedBy         string                      `json:"applied_by,omitempty"`
	AppliedNote       string                      `json:"applied_note,omitempty"`
	AppliedSummary    string                      `json:"applied_summary,omitempty"`
	AppliedChanges    []rehearsalAppliedChange    `json:"applied_changes,omitempty"`
	Voided            bool                        `json:"voided,omitempty"`
	VoidedAt          string                      `json:"voided_at,omitempty"`
	VoidedBy          string                      `json:"voided_by,omitempty"`
	VoidReason        string                      `json:"void_reason,omitempty"`
	SupersededBy      string                      `json:"superseded_by,omitempty"`
	SupersededTitle   string                      `json:"superseded_title,omitempty"`
	Source            *rehearsalSourceRef         `json:"source,omitempty"`
	CreatedAt         string                      `json:"created_at"`
	UpdatedAt         string                      `json:"updated_at"`
}

func (s *storeServer) rehearsalDir(cluster string) string {
	return filepath.Join(s.cfg.DataDir, "rehearsals", cluster)
}

func (s *storeServer) rehearsalPath(cluster, rid string) string {
	return filepath.Join(s.rehearsalDir(cluster), rid+".json")
}

func (s *storeServer) rehearsalImgDir(cluster, rid string) string {
	return filepath.Join(s.rehearsalDir(cluster), rid+"_img")
}

func (s *storeServer) storeRehearsalImages(cluster, rid string, images []string) ([]string, error) {
	if len(images) == 0 {
		return nil, nil
	}
	if len(images) > 6 {
		return nil, fmt.Errorf("单次最多上传 6 张图片")
	}
	dir := s.rehearsalImgDir(cluster, rid)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("无法创建图片存储目录")
	}
	var names []string
	for _, data := range images {
		m := reDataImage.FindStringSubmatch(data)
		if m == nil || len(data) > 6<<20 {
			return nil, fmt.Errorf("图片格式需为 png、jpg、gif 或 webp，且单张不超过 4 MiB")
		}
		raw, err := base64.StdEncoding.DecodeString(data[len(m[0]):])
		if err != nil || len(raw) == 0 {
			return nil, fmt.Errorf("图片内容无法解码")
		}
		h := sha256.Sum256(raw)
		ext := m[1]
		if ext == "jpeg" {
			ext = "jpg"
		}
		name := hex.EncodeToString(h[:10]) + "." + ext
		if err := os.WriteFile(filepath.Join(dir, name), raw, 0o600); err != nil {
			return nil, fmt.Errorf("保存图片失败")
		}
		names = append(names, name)
	}
	return names, nil
}

func (s *storeServer) rehearsalImageData(cluster, rid, name string) string {
	if !reRehearsalImg.MatchString(name) {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(s.rehearsalImgDir(cluster, rid), filepath.Base(name)))
	if err != nil {
		return ""
	}
	return "data:" + http.DetectContentType(b) + ";base64," + base64.StdEncoding.EncodeToString(b)
}

func (s *storeServer) loadRehearsal(cluster, rid string) (changeRehearsal, bool) {
	var rh changeRehearsal
	if !docClusterID.MatchString(cluster) || !reRehearsalID.MatchString(rid) {
		return rh, false
	}
	b, err := os.ReadFile(s.rehearsalPath(cluster, rid))
	if err != nil || json.Unmarshal(b, &rh) != nil || rh.ID == "" {
		return changeRehearsal{}, false
	}
	rh.RestorationAlerts = auditRehearsalRestorations(rh.Goal, rh.ExtraScope, rh.Steps, "zh-CN")
	return rh, true
}

func (s *storeServer) saveRehearsal(rh changeRehearsal) error {
	rh.RestorationAlerts = auditRehearsalRestorations(rh.Goal, rh.ExtraScope, rh.Steps, "zh-CN")
	rh.ConflictAlerts = nil // always computed dynamically against live cluster peers
	rh.UpdatedAt = nowStamp()
	return writeJSONFile(s.rehearsalPath(rh.ClusterID, rh.ID), rh)
}

func (s *storeServer) listRehearsalsLang(cluster, lang string) []changeRehearsal {
	out := s.listRehearsals(cluster)
	for i := range out {
		out[i].RestorationAlerts = auditRehearsalRestorations(out[i].Goal, out[i].ExtraScope, out[i].Steps, lang)
		out[i].ConflictAlerts = computeRehearsalConflicts(out[i], out, lang)
	}
	return out
}

func (s *storeServer) listRehearsals(cluster string) []changeRehearsal {
	out := []changeRehearsal{}
	if !docClusterID.MatchString(cluster) {
		return out
	}
	entries, err := os.ReadDir(s.rehearsalDir(cluster))
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		rid := strings.TrimSuffix(e.Name(), ".json")
		if rh, ok := s.loadRehearsal(cluster, rid); ok {
			out = append(out, rh)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

func (s *storeServer) listFinalizedRehearsals(cluster string) []changeRehearsal {
	all := s.listRehearsals(cluster)
	var out []changeRehearsal
	for _, rh := range all {
		if rh.Stage == "finalized" {
			out = append(out, rh)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out
}

func (s *storeServer) finalizedRehearsalDocIDs(cluster string) []string {
	var ids []string
	for _, rh := range s.listFinalizedRehearsals(cluster) {
		ids = append(ids, "sop-"+rh.ID)
	}
	return ids
}

// ---- static read-only probe script validator ----

var (
	reSafeDevNullRedir = regexp.MustCompile(`(?:\d*>&\d+|\d*>\s*/dev/(?:null|stdout|stderr)|&>\s*/dev/(?:null|stdout|stderr))`)
	reSubshellEval     = regexp.MustCompile(`(?i)\b(?:(?:ba|z|da|k)?sh\s+-[a-zA-Z]*c|eval)\b`)
	reQuotedSpan       = regexp.MustCompile(`'[^']*'|"(?:\\.|[^"\\])*"`)
	reBashTestOrArith  = regexp.MustCompile(`\[\[[^\n]*?\]\]|\(\([^\n]*?\)\)`)
	reFileRedir        = regexp.MustCompile(`(^|[^0-9>&=-])>{1,2}\s*[^&\s=]`)

	probeMutatingRules = []struct {
		re  *regexp.Regexp
		why string
	}{
		{regexp.MustCompile(`(?i)\b(rm|mv|dd|mkfs(\.\w+)?|wipefs|fdisk|parted|shred|truncate)\b`), "包含文件或磁盘修改/删除命令"},
		{regexp.MustCompile(`(?i)\b(cp|chmod|chown|mkdir|rmdir|touch|install|tee)\b`), "包含目录、文件写入或权限变更命令"},
		{regexp.MustCompile(`(?i)\bsed\s+-[a-zA-Z]*i`), "包含 sed -i 原地修改文件操作"},
		{regexp.MustCompile(`(?i)\bsystemctl\s+(start|stop|restart|reload|try-restart|reload-or-restart|enable|disable|mask|unmask|kill)\b`), "包含 systemctl 服务状态变更操作"},
		{regexp.MustCompile(`(?i)\bservice\s+\S+\s+(start|stop|restart|reload|force-reload)\b`), "包含 service 服务启停操作"},
		{regexp.MustCompile(`(?i)\b(kill|pkill|killall|reboot|shutdown|halt|poweroff|init\s+[06])\b`), "包含进程终止或机器重启/关机指令"},
		{regexp.MustCompile(`(?i)\bsysctl\s+-w\b`), "包含 sysctl -w 内核参数修改操作"},
		{regexp.MustCompile(`(?i)\b(apt|apt-get|yum|dnf|zypper)\s+(install|upgrade|dist-upgrade|update|remove|purge|erase|autoremove|reinstall)\b`), "包含系统软件包安装/升级/卸载操作"},
		{regexp.MustCompile(`(?i)\b(rpm\s+-[a-zA-Z]*[iUe]|dpkg\s+-[a-zA-Z]*[irP]|pip\d?\s+(install|uninstall))\b`), "包含底层包安装或卸载操作"},
		{regexp.MustCompile(`(?i)\bansible-playbook\b`), "采集脚本不允许调用 ansible-playbook"},
		{regexp.MustCompile(`(?i)\bpatronictl\b[^|\n;&]*\b(switchover|failover|restart|reload|reinit|edit-config|remove|pause|resume)\b`), "包含 patronictl 集群控制/切换动作"},
		{regexp.MustCompile(`(?i)\betcdctl\b[^|\n;&]*\b(put|del|compaction|defrag|snapshot\s+restore|member\s+(add|remove|update|promote))\b`), "包含 etcdctl 数据写入或成员变更动作"},
		{regexp.MustCompile(`(?i)\bredis-cli\b[^|\n;&]*\b(config\s+set|config\s+rewrite|flushall|flushdb|slaveof|replicaof|cluster\s+(failover|reset|addslots|delslots|meet|forget)|shutdown|bgrewriteaof)\b`), "包含 redis-cli 状态或配置修改动作"},
		{regexp.MustCompile(`(?i)\bpg_ctl\b[^|\n;&]*\b(start|stop|restart|reload|promote|kill)\b`), "包含 pg_ctl 数据库启停或升主动作"},
		{regexp.MustCompile(`(?i)\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|DATABASE|ROLE|USER|INDEX|SCHEMA|EXTENSION)|ALTER\s+(SYSTEM|TABLE|DATABASE|ROLE|USER|SCHEMA)|TRUNCATE\s+|CREATE\s+(TABLE|DATABASE|ROLE|USER|INDEX|EXTENSION)|GRANT\s+|REVOKE\s+|pg_promote|pg_reload_conf|pg_terminate_backend)\b`), "包含数据库写操作或变更控制语句"},
	}
)

var rehearsalProbeRulesEn = map[string]string{
	"包含文件或磁盘修改/删除命令":                        "Contains file or disk write/delete commands",
	"包含目录、文件写入或权限变更命令":                     "Contains directory, file write, or permission-change commands",
	"包含 sed -i 原地修改文件操作":                   "Contains in-place file edit (sed -i)",
	"包含 systemctl 服务状态变更操作":                "Contains systemctl service state transition command",
	"包含 service 服务启停操作":                    "Contains service start/stop/restart command",
	"包含进程终止或机器重启/关机指令":                    "Contains process kill or host reboot/shutdown command",
	"包含 sysctl -w 内核参数修改操作":                "Contains sysctl -w kernel tuning write",
	"包含系统软件包安装/升级/卸载操作":                    "Contains OS package install/upgrade/remove command",
	"包含底层包安装或卸载操作":                         "Contains low-level package install/remove command",
	"采集脚本不允许调用 ansible-playbook":           "Probe script must not invoke ansible-playbook",
	"包含 patronictl 集群控制/切换动作":              "Contains patronictl cluster mutation/switchover command",
	"包含 etcdctl 数据写入或成员变更动作":               "Contains etcdctl write or membership change command",
	"包含 redis-cli 状态或配置修改动作":               "Contains redis-cli state or config mutation command",
	"包含 pg_ctl 数据库启停或升主动作":                 "Contains pg_ctl database start/stop/promote command",
	"包含数据库写操作或变更控制语句":                      "Contains database write or DDL/DCL statement",
	"包含向文件写入的重定向操作（仅允许重定向到 /dev/null 或标准流）": "Contains file output redirection (only /dev/null or stdout/stderr allowed)",
	"采集脚本内容为空":                             "Probe script is empty",
}

func validateReadOnlyProbeScriptLang(script, lang string) (bool, []string) {
	ok, warns := validateReadOnlyProbeScript(script)
	if !isEnLang(lang) || len(warns) == 0 {
		return ok, warns
	}
	out := make([]string, len(warns))
	for i, w := range warns {
		if en, has := rehearsalProbeRulesEn[w]; has {
			out[i] = en
		} else {
			out[i] = w
		}
	}
	return ok, out
}

// ensureProbeBashGuard injects a POSIX-safe guard right after the shebang so that even if an operator
// accidentally invokes a bash probe script with `sh script.sh` on Ubuntu/Debian (where /bin/sh is dash),
// it transparently re-executes under bash instead of failing on `set -o pipefail`.
func ensureProbeBashGuard(script string) string {
	s := strings.ReplaceAll(strings.TrimSpace(script), "\r\n", "\n")
	if s == "" || strings.Contains(s, "BASH_VERSION") {
		return s
	}
	needsBash := strings.Contains(s, "pipefail") ||
		strings.Contains(s, "[[") ||
		strings.HasPrefix(s, "#!/usr/bin/env bash") ||
		strings.HasPrefix(s, "#!/bin/bash")
	if !needsBash {
		return s
	}
	const guard = `if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi`
	lines := strings.Split(s, "\n")
	if strings.HasPrefix(lines[0], "#!") {
		out := make([]string, 0, len(lines)+1)
		out = append(out, lines[0], guard)
		out = append(out, lines[1:]...)
		return strings.Join(out, "\n")
	}
	return "#!/usr/bin/env bash\n" + guard + "\n" + s
}

// validateReadOnlyProbeScript statically checks that a generated inspection script contains zero mutating shell/SQL commands.
func validateReadOnlyProbeScript(script string) (bool, []string) {
	trimmed := strings.TrimSpace(script)
	if trimmed == "" {
		return false, []string{"采集脚本内容为空"}
	}
	var nonComment []string
	for _, line := range strings.Split(trimmed, "\n") {
		l := strings.TrimSpace(line)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		nonComment = append(nonComment, l)
	}
	body := strings.Join(nonComment, "\n")
	seen := map[string]bool{}
	var warnings []string
	addWarn := func(msg string) {
		if !seen[msg] {
			seen[msg] = true
			warnings = append(warnings, msg)
		}
	}
	for _, rule := range probeMutatingRules {
		if rule.re.MatchString(body) {
			addWarn(rule.why)
		}
	}
	for _, line := range nonComment {
		cleaned := line
		if !reSubshellEval.MatchString(cleaned) {
			cleaned = reQuotedSpan.ReplaceAllString(cleaned, `""`)
		}
		cleaned = reBashTestOrArith.ReplaceAllString(cleaned, "")
		cleaned = reSafeDevNullRedir.ReplaceAllString(cleaned, "")
		if reFileRedir.MatchString(cleaned) {
			addWarn("包含向文件写入的重定向操作（仅允许重定向到 /dev/null 或标准流）")
			break
		}
	}
	return len(warnings) == 0, warnings
}

// ---- cluster baseline context for rehearsal prompts ----

func (s *storeServer) clusterBaselinePrompt(f clusterFacts) (string, *aiRedactor) {
	var b strings.Builder
	var hostNames []string
	fmt.Fprintf(&b, "集群标识：%s\n应用组件：%s %s\n初始交付任务：%s（状态：%s）\n", f.ID, f.Current.AppName, f.Current.Version, f.Current.ID, jobOutcomeName(f.Current))
	if f.Current.OutcomeNote != "" {
		fmt.Fprintf(&b, "首次部署现场登记说明：%s\n", aiScrub(f.Current.OutcomeNote))
	}
	if f.Plan != nil {
		fmt.Fprintf(&b, "操作系统平台：%s\n控制节点：%s\n", f.Plan.Platform.ID, f.Plan.Controller)
		b.WriteString("初始交付机器清单：\n")
		for _, h := range f.Plan.Hosts {
			hostNames = append(hostNames, h.Name)
			fmt.Fprintf(&b, "  - %s: %s\n", h.Name, h.IP)
		}
		b.WriteString("初始交付实例与角色拓扑：\n")
		for _, inst := range f.Plan.Instances {
			if inst.External {
				continue
			}
			var roles []string
			for _, r := range inst.R.Roles {
				if hs := inst.Roles[r.Name]; len(hs) > 0 {
					roles = append(roles, fmt.Sprintf("%s=[%s]", firstNonEmptyStr(r.Title, r.Name), strings.Join(hs, ",")))
				}
			}
			fmt.Fprintf(&b, "  - 实例 %s（%s %s）：%s\n", inst.ID, inst.Title, inst.Version, strings.Join(roles, "；"))
			if len(inst.Spec.Params) > 0 {
				keys := make([]string, 0, len(inst.Spec.Params))
				for k := range inst.Spec.Params {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				var kvs []string
				for _, k := range keys {
					kvs = append(kvs, fmt.Sprintf("%s=%s", k, show(inst.Spec.Params[k])))
				}
				fmt.Fprintf(&b, "    定制参数：%s\n", aiScrub(strings.Join(kvs, ", ")))
			}
			for _, ep := range inst.Endpoints {
				if fr, ok := inst.Fronts[ep.Name]; ok {
					fmt.Fprintf(&b, "    对外入口 %s：%s:%d（经 %s；注意：当前主库本机直连指向自身的四层 LB/ELB VIP 可能回环不通；测写入入口优先在独立客户端/跳板机，若现场无独立主机也可在非当前主库的从库节点测试，连通并返回目标主库 IP 即为有效证据）\n", ep.Name, fr.Address, fr.Listen, fr.Balancer)
				}
			}
			if ops := inst.InstanceOperations(f.ID); ops != nil {
				if len(ops.Checks) > 0 {
					b.WriteString("    组件内置只读巡检参考命令（仅作命令与路径语法参考，严禁全盘塞入采集脚本）：\n")
					for i, ck := range ops.Checks {
						if i >= 6 {
							break
						}
						fmt.Fprintf(&b, "      * %s: %s\n", ck.Title, strings.ReplaceAll(strings.TrimSpace(ck.Cmd), "\n", " ; "))
					}
				}
				if len(ops.Tasks) > 0 {
					b.WriteString("    组件内置标准运维动作参考：\n")
					for i, tk := range ops.Tasks {
						if i >= 6 {
							break
						}
						fmt.Fprintf(&b, "      * %s: %s\n", tk.Title, strings.ReplaceAll(strings.TrimSpace(tk.Cmd), "\n", " ; "))
					}
				}
			}
		}
	}
	if pk := s.lockPackages(f.Current.ID); len(pk) > 0 {
		names := make([]string, 0, len(pk))
		for n := range pk {
			names = append(names, n)
		}
		sort.Strings(names)
		var items []string
		for i, n := range names {
			if i >= 20 {
				break
			}
			items = append(items, n+"="+strings.Join(pk[n], "/"))
		}
		fmt.Fprintf(&b, "初始离线锁定核心包：%s\n", strings.Join(items, ", "))
	}
	if applied := s.listAppliedRehearsals(f.ID); len(applied) > 0 {
		if eff := effectiveAppliedChanges(applied); len(eff) > 0 {
			b.WriteString("\n【投产后当前最终生效的参数/配置变动（按落地时间归并后，优先于上方初始交付基线！）】\n")
			for _, ch := range eff {
				extra := ""
				if ch.UpdateCount > 1 {
					extra = fmt.Sprintf("，累计调整 %d 次，以最新为准", ch.UpdateCount)
				}
				if ch.Before != "" {
					fmt.Fprintf(&b, "- %s: %s -> %s（由「%s」于 %s 生效%s）\n", ch.Key, ch.Before, ch.After, ch.SourceTitle, day(ch.AppliedAt), extra)
				} else {
					fmt.Fprintf(&b, "- %s = %s（由「%s」于 %s 生效%s）\n", ch.Key, ch.After, ch.SourceTitle, day(ch.AppliedAt), extra)
				}
			}
		}
		b.WriteString("\n【投产后已确认落地的生产变更记录（按时间顺序）】\n")
		for _, rh := range applied {
			when := day(firstNonEmptyStr(rh.AppliedAt, rh.UpdatedAt))
			who := firstNonEmptyStr(rh.AppliedBy, rh.Owner)
			fmt.Fprintf(&b, "- [%s] 「%s」（#%s，%s 确认生产已落地）", when, rh.Title, rh.ID, who)
			if rh.AppliedSummary != "" {
				fmt.Fprintf(&b, "：%s", rh.AppliedSummary)
			}
			b.WriteString("\n")
			if len(rh.AppliedChanges) > 0 {
				var deltas []string
				for _, ch := range rh.AppliedChanges {
					if ch.Before != "" {
						deltas = append(deltas, fmt.Sprintf("%s: %s -> %s", ch.Key, ch.Before, ch.After))
					} else {
						deltas = append(deltas, fmt.Sprintf("%s=%s", ch.Key, ch.After))
					}
				}
				fmt.Fprintf(&b, "  已生效改动：%s\n", strings.Join(deltas, "；"))
			}
			if rh.AppliedNote != "" {
				fmt.Fprintf(&b, "  生产实施说明：%s\n", truncRunes(rh.AppliedNote, 200))
			}
		}
	}
	var red *aiRedactor
	if s.aiLoad().RedactHosts {
		red = newAIRedactor(hostNames)
	}
	return aiScrub(b.String()), red
}

// rehearsalSkillBlock loads enabled platform & personal skills relevant to a change rehearsal:
//  1. Core `change-rehearsal` skill (honoring admin overrides or disable toggle);
//  2. Domain built-in skills matching the cluster's components, LB/ELB frontends, logging, or security context;
//  3. Any enabled custom organization skills or the user's own personal skills (so site-specific network/ELB/SOP
//     skills authored in the Skills page automatically govern rehearsal probes and runbooks).
func (s *storeServer) rehearsalSkillBlock(user string, f clusterFacts, goal string, sec *rehearsalSecurityContext) (string, []string) {
	all := s.skillsFor(user, true)
	if len(all) == 0 {
		return "", nil
	}
	byName := make(map[string]aiSkill, len(all))
	for _, sk := range all {
		byName[sk.Name] = sk
	}

	want := []string{"change-rehearsal"}
	seen := map[string]bool{"change-rehearsal": true}
	addName := func(n string) {
		if n != "" && !seen[n] {
			seen[n] = true
			want = append(want, n)
		}
	}

	addComp := func(comp string) {
		switch strings.ToLower(strings.TrimSpace(comp)) {
		case "postgresql", "patroni", "pg":
			addName("postgresql-patroni")
		case "etcd":
			addName("etcd-ops")
		case "redis":
			addName("redis-sentinel")
		case "haproxy", "keepalived", "external-lb", "elb", "slb", "lvs":
			addName("haproxy-keepalived")
		case "nginx":
			addName("nginx-stream")
		}
	}

	hasLB := false
	addComp(f.Current.AppID)
	if f.Plan != nil {
		for _, inst := range f.Plan.Instances {
			if inst.External {
				continue
			}
			addComp(inst.Component)
			if len(inst.Fronts) > 0 {
				hasLB = true
				for _, fr := range inst.Fronts {
					addComp(fr.Balancer)
				}
			}
		}
	}

	goalLow := strings.ToLower(goal)
	if hasLB || strings.Contains(goalLow, "elb") || strings.Contains(goalLow, "elp") || strings.Contains(goalLow, "slb") || strings.Contains(goalLow, "vip") || strings.Contains(goalLow, "lvs") || strings.Contains(goal, "负载均衡") || strings.Contains(goal, "回环") {
		addName("haproxy-keepalived")
	}
	if strings.Contains(goalLow, "log") || strings.Contains(goalLow, "journal") || strings.Contains(goal, "日志") || strings.Contains(goal, "轮转") || strings.Contains(goal, "落盘") || strings.Contains(goal, "监控") {
		addName("middleware-logging-observability")
	}
	if sec != nil || strings.Contains(goalLow, "cve") || strings.Contains(goalLow, "tls") || strings.Contains(goalLow, "ssl") || strings.Contains(goal, "漏洞") || strings.Contains(goal, "补丁") || strings.Contains(goal, "证书") {
		addName("security-cve-audit")
	}

	var b strings.Builder
	var titles []string
	added := map[string]bool{}
	appendSkill := func(sk aiSkill, maxRunes int) {
		content := strings.TrimSpace(sk.Content)
		if content == "" || added[sk.Name] {
			return
		}
		if maxRunes > 0 {
			content = truncRunes(content, maxRunes)
		}
		if b.Len() == 0 {
			b.WriteString("\n\n【平台技能与现场经验规范（须严格遵循；若与通用习惯冲突，以技能规范为准）】")
		}
		title := firstNonEmptyStr(strings.TrimSpace(sk.Title), sk.Name)
		b.WriteString("\n\n### 技能：" + title + "\n" + content)
		titles = append(titles, title)
		added[sk.Name] = true
	}

	for _, n := range want {
		if sk, ok := byName[n]; ok && sk.Enabled {
			appendSkill(sk, 3200)
		}
	}

	// Include enabled custom org skills and user's personal skills within a bounded prompt budget.
	customBudget := 6000
	for _, sk := range all {
		if sk.Builtin || !sk.Enabled || added[sk.Name] || customBudget <= 0 {
			continue
		}
		limit := min(2400, customBudget)
		before := len([]rune(sk.Content))
		appendSkill(sk, limit)
		customBudget -= min(before, limit)
	}

	return b.String(), titles
}

func rehearsalSkillNote(lang string, titles []string) string {
	if len(titles) == 0 {
		return ""
	}
	shown := titles
	suffix := ""
	if len(shown) > 4 {
		shown = titles[:4]
		suffix = tr(lang, fmt.Sprintf(" 等 %d 项", len(titles)), fmt.Sprintf(" +%d more", len(titles)-4))
	}
	return tr(lang, " · 已加载技能：", " · Skills: ") + strings.Join(shown, "、") + suffix
}

func wantsRehearsalStream(r *http.Request) bool {
	return r.URL.Query().Get("stream") == "1" || strings.Contains(r.Header.Get("Accept"), "text/event-stream")
}

func startRehearsalSSE(w http.ResponseWriter, r *http.Request) *sse {
	if !wantsRehearsalStream(r) {
		return nil
	}
	fl, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ev := sse{w: w, f: fl}
	return &ev
}

var reJSONThinkingStart = regexp.MustCompile(`"thinking"\s*:\s*"`)

// extractLiveJSONThinking incrementally unescapes the leading "thinking" string field from a streaming JSON payload
// and detects the active downstream section key so even non-reasoning models stream live thought & progress transparently.
func extractLiveJSONThinking(raw string) (thinking string, phase string) {
	loc := reJSONThinkingStart.FindStringIndex(raw)
	if loc != nil {
		s := raw[loc[1]:]
		var out strings.Builder
		for i := 0; i < len(s); {
			c := s[i]
			if c == '"' {
				break
			}
			if c == '\\' {
				if i+1 >= len(s) {
					break
				}
				switch s[i+1] {
				case '"', '\\', '/':
					out.WriteByte(s[i+1])
					i += 2
				case 'n':
					out.WriteByte('\n')
					i += 2
				case 'r':
					out.WriteByte('\r')
					i += 2
				case 't':
					out.WriteByte('\t')
					i += 2
				case 'u':
					if i+6 > len(s) {
						i = len(s)
						break
					}
					if v, err := strconv.ParseUint(s[i+2:i+6], 16, 32); err == nil {
						out.WriteRune(rune(v))
					}
					i += 6
				default:
					out.WriteByte(s[i+1])
					i += 2
				}
				continue
			}
			if !utf8.FullRuneInString(s[i:]) {
				break
			}
			r, w := utf8.DecodeRuneInString(s[i:])
			out.WriteRune(r)
			i += w
		}
		thinking = out.String()
	}
	switch {
	case strings.Contains(raw, `"probe_issue"`):
		phase = "检测到探针执行异常或数据缺失，正在生成修复与补采方案…"
	case strings.Contains(raw, `"fixed_script"`):
		phase = "正在修订纯只读采集脚本…"
	case strings.Contains(raw, `"steps"`):
		phase = "正在编排测试环境分步演练序列（预检 / 执行 / 验收 / 回退）…"
	case strings.Contains(raw, `"drift"`):
		phase = "正在逐台对比初始交付基线与生产现场真实状态…"
	case strings.Contains(raw, `"probe_script"`):
		phase = "正在编写 100% 纯只读现场采集探针脚本…"
	case strings.Contains(raw, `"questions"`):
		phase = "正在提炼维护窗口与高可用边界澄清问题…"
	case strings.Contains(raw, `"command"`):
		phase = "正在生成可直接采纳的修订命令提案…"
	case strings.Contains(raw, `"verdict"`):
		phase = "正在对照预期判据研判此步是否通过…"
	case strings.Contains(raw, `"diagnosis"`):
		phase = "正在分析测试环境报错根因…"
	}
	return thinking, phase
}

func parseRehearsalStreamMetaLang(raw, lang string) (thinking string, phase string) {
	thinking, phase = extractLiveJSONThinking(raw)
	if !isEnLang(lang) || phase == "" {
		return thinking, phase
	}
	enPhase := map[string]string{
		"检测到探针执行异常或数据缺失，正在生成修复与补采方案…":       "Probe error or missing data detected; preparing fix & re-collection guidance...",
		"正在修订纯只读采集脚本…":                       "Revising read-only probe script...",
		"正在编排测试环境分步演练序列（预检 / 执行 / 验收 / 回退）…": "Orchestrating staged staging rehearsal plan (precheck / execute / verify / rollback)...",
		"正在逐台对比初始交付基线与生产现场真实状态…":             "Comparing initial baseline against live production node state...",
		"正在编写 100% 纯只读现场采集探针脚本…":              "Generating 100% read-only live discovery probe script...",
		"正在提炼维护窗口与高可用边界澄清问题…":                "Extracting maintenance window and HA scope questions...",
		"正在生成可直接采纳的修订命令提案…":                  "Drafting directly applicable command fix proposal...",
		"正在对照预期判据研判此步是否通过…":                  "Evaluating execution output against expected pass criteria...",
		"正在分析测试环境报错根因…":                      "Analyzing staging error root cause...",
	}[phase]
	if enPhase != "" {
		return thinking, enPhase
	}
	return thinking, phase
}

func (s *storeServer) rehearsalCheckAILang(user string, needVision bool, pick, lang string) ([]aiProvider, int, error) {
	providers, status, err := s.rehearsalCheckAI(user, needVision, pick)
	if err != nil && isEnLang(lang) {
		return nil, status, fmt.Errorf("%s", localizeGoMessage(lang, err.Error()))
	}
	return providers, status, err
}

func (s *storeServer) rehearsalCheckAI(user string, needVision bool, pick string) ([]aiProvider, int, error) {
	if code, msg := s.checkAIFeature(user, "change_rehearsal"); code != 0 {
		return nil, code, fmt.Errorf("%s", msg)
	}
	st := s.aiLoad()
	pick = strings.TrimSpace(pick)
	providers := st.aiProvidersForPick("change_rehearsal", pick)
	if pick != "" && s.can(user, "ai.settings") {
		pid, mid, _ := strings.Cut(pick, "|")
		for _, p := range st.Providers {
			if p.ID != pid || !p.Enabled || (p.KeyEnc == "" && !p.Private) || (st.PrivateOnly && !p.Private) {
				continue
			}
			var chosen aiModel
			found := false
			if mid != "" {
				if m, ok := p.model(mid); ok && m.Enabled {
					chosen, found = m, true
				}
			} else {
				for _, m := range p.Models {
					if m.Enabled {
						chosen, found = m, true
						break
					}
				}
			}
			if found {
				picked := []aiProvider{p.withModel(chosen)}
				for _, b := range providers {
					if b.ID != p.ID || b.Model != chosen.ID {
						picked = append(picked, b)
					}
				}
				providers = picked
				break
			}
		}
	}
	if len(providers) == 0 {
		return nil, 409, fmt.Errorf("没有可用的模型供应商，请管理员在平台设置 → AI 中配置模型")
	}
	if st.MonthlyLimit > 0 && s.aiCallsThisMonth(user) >= st.MonthlyLimit {
		return nil, 429, fmt.Errorf("本月 AI 使用次数已达上限")
	}
	if needVision && providers[0].Vision == "no" {
		return nil, 409, fmt.Errorf("当前变更演练模型不支持识别截图，请粘贴文字回显，或切换支持视觉的模型")
	}
	return providers, 200, nil
}

func fmtTraceMS(ms int64) string {
	if ms < 1000 {
		return fmt.Sprintf("%dms", max(1, ms))
	}
	return fmt.Sprintf("%.1fs", float64(ms)/1000.0)
}

func finalizeTraceSynth(trace *rehearsalTrace, ev *sse, id, detail string, ok bool, ms int64) {
	stStatus := "done"
	if !ok {
		stStatus = "warn"
	}
	for i := range trace.Steps {
		if trace.Steps[i].ID == id {
			trace.Steps[i].Detail = detail
			trace.Steps[i].OK = ok
			trace.Steps[i].Status = stStatus
			if ms > 0 {
				trace.Steps[i].MS = ms
			} else if trace.Steps[i].MS == 0 {
				trace.Steps[i].MS = 1
			}
			if ev != nil {
				ev.send(map[string]any{"t": "step", "step": trace.Steps[i]})
			}
			return
		}
	}
	fallback := rehearsalTraceStep{
		ID:     id,
		Kind:   "synthesize",
		Title:  "完成结构化方案编排",
		Detail: detail,
		MS:     max(1, ms),
		OK:     ok,
		Status: stStatus,
	}
	trace.Steps = append(trace.Steps, fallback)
	if ev != nil {
		ev.send(map[string]any{"t": "step", "step": fallback})
	}
}

func (s *storeServer) rehearsalRunAI(
	r *http.Request,
	providers []aiProvider,
	user, target, session, stageKey string,
	red *aiRedactor,
	sys, prompt string,
	imageDataURLs []string,
	spec rehearsalPipelineSpec,
	effort thinkLevel,
	ev *sse,
) (string, rehearsalTrace, int, error) {
	prepStart := time.Now()
	sendSys, sendPrompt := aiScrub(sys), aiScrub(prompt)
	if red != nil {
		sendSys = red.out(sendSys)
		sendPrompt = red.out(sendPrompt)
	}
	var userContent any = sendPrompt
	if len(imageDataURLs) > 0 {
		parts := []map[string]any{{"type": "text", "text": sendPrompt}}
		for _, url := range imageDataURLs {
			if url != "" {
				parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": url}})
			}
		}
		if len(parts) > 1 {
			userContent = parts
		}
	}
	msgs := []aiMessage{{Role: "system", Content: sendSys}, {Role: "user", Content: userContent}}

	preSteps := make([]rehearsalTraceStep, len(spec.PreSteps))
	prepMS := max(1, time.Since(prepStart).Milliseconds())
	for i, st := range spec.PreSteps {
		if st.Status == "" {
			st.Status = "done"
		}
		if st.MS == 0 {
			st.MS = prepMS
		}
		preSteps[i] = st
	}

	lang := reqLang(r)
	firstProv := ""
	firstModel := ""
	if len(providers) > 0 {
		firstProv = firstNonEmptyStr(providers[0].Name, tr(lang, "模型网关", "Model Gateway"))
		firstModel = providers[0].Model
	}
	connectStep := rehearsalTraceStep{
		ID:     "connect-model",
		Kind:   "connect",
		Title:  tr(lang, "连接模型网关与投递上下文", "Connect Model Gateway & Dispatch Context"),
		Detail: tr(lang, fmt.Sprintf("正在连接 %s · %s 并投递脱敏上下文…", firstProv, firstModel), fmt.Sprintf("Connecting to %s · %s and dispatching scrubbed context...", firstProv, firstModel)),
		OK:     true,
		Status: "running",
	}
	thinkStep := rehearsalTraceStep{
		ID:     "model-think",
		Kind:   "think",
		Title:  firstNonEmptyStr(spec.ThinkTitle, tr(lang, "推演集群拓扑与变更风险", "Analyze Topology & Change Risks")),
		Detail: tr(lang, "等待模型通道返回首包后展开推演", "Waiting for first token from model stream..."),
		OK:     true,
		Status: "pending",
	}
	synthStep := rehearsalTraceStep{
		ID:     firstNonEmptyStr(spec.SynthID, "synth-output"),
		Kind:   firstNonEmptyStr(spec.SynthKind, "synthesize"),
		Title:  firstNonEmptyStr(spec.SynthTitle, tr(lang, "生成结构化演练结果", "Build Structured Rehearsal Output")),
		Detail: firstNonEmptyStr(spec.SynthWait, tr(lang, "等待风险推演完成后编排输出", "Waiting for risk analysis before structuring output")),
		OK:     true,
		Status: "pending",
	}

	trace := rehearsalTrace{
		Stage: stageKey,
		Steps: append(append([]rehearsalTraceStep(nil), preSteps...), connectStep, thinkStep, synthStep),
		At:    nowStamp(),
	}
	if ev != nil {
		// Send the authoritative full pipeline step list upfront so the client never merges mismatched placeholder IDs (e.g. 1/8).
		ev.send(map[string]any{"t": "steps", "steps": trace.Steps})
	}

	var err error
	var failedAttempts []aiAttemptDiag
	overallStart := time.Now()
	for i, p := range providers {
		if len(imageDataURLs) > 0 && p.Vision == "no" {
			msgs[1] = aiMessage{Role: "user", Content: sendPrompt + fmt.Sprintf("\n（附带 %d 张现场截图，备用模型不支持视觉识别）", len(imageDataURLs))}
		}
		provLabel := firstNonEmptyStr(p.Name, tr(lang, "模型网关", "Model Gateway"))
		connectStep.Status = "running"
		connectStep.OK = true
		connectStep.Diag = nil
		if i > 0 {
			connectStep.Detail = tr(lang, fmt.Sprintf("正在切换备用节点 %s · %s 重试连接…", provLabel, p.Model), fmt.Sprintf("Failing over to %s · %s and retrying...", provLabel, p.Model))
		} else {
			connectStep.Detail = tr(lang, fmt.Sprintf("正在连接 %s · %s 并投递脱敏上下文…", provLabel, p.Model), fmt.Sprintf("Connecting to %s · %s and dispatching scrubbed context...", provLabel, p.Model))
		}
		if ev != nil {
			ev.send(map[string]any{"t": "meta", "model": p.Model, "provider": p.Name, "failover": i > 0})
			ev.send(map[string]any{"t": "step", "step": connectStep})
			ev.send(map[string]any{"t": "phase", "v": connectStep.Detail})
		}

		start := time.Now()
		ctx, cancel := context.WithTimeout(r.Context(), 420*time.Second)
		if effort != "" {
			ctx = withEffort(ctx, string(effort))
		}
		var nativeThinking strings.Builder
		var rawStream strings.Builder
		sentJSONThinkLen := 0
		lastPhase := ""
		lastProgressAt := time.Time{}
		lastBeatAt := time.Time{}
		beatCount := 0
		var connHandsMS int64
		gotFirstToken := false
		var firstTokenAt time.Time
		var synthStartedAt time.Time

		connectDone := false
		completeConnect := func(ms int64, detail string) {
			if connectDone {
				return
			}
			connectDone = true
			connectStep.Status = "done"
			connectStep.OK = true
			connectStep.MS = max(1, ms)
			connectStep.Detail = detail
			thinkStep.Status = "running"
			thinkStep.Detail = firstNonEmptyStr(spec.ThinkWait, tr(lang, "正在结合集群拓扑与运行参数展开风险推演…", "Evaluating cluster topology and runtime risks..."))
			if ev != nil {
				ev.send(map[string]any{"t": "step", "step": connectStep})
				ev.send(map[string]any{"t": "step", "step": thinkStep})
				ev.send(map[string]any{"t": "phase", "v": thinkStep.Detail})
			}
		}

		markFirstToken := func() {
			if gotFirstToken {
				return
			}
			gotFirstToken = true
			firstTokenAt = time.Now()
			ttft := max(1, firstTokenAt.Sub(start).Milliseconds())
			completeConnect(
				ttft,
				tr(lang, fmt.Sprintf("%s · %s 首包响应 %s", provLabel, p.Model, fmtTraceMS(ttft)), fmt.Sprintf("%s · %s first token in %s", provLabel, p.Model, fmtTraceMS(ttft))),
			)
		}

		ctx = withConnect(ctx, func(connMS int64) {
			connHandsMS = connMS
			if gotFirstToken {
				return
			}
			completeConnect(
				connMS,
				tr(lang, fmt.Sprintf("%s · %s 握手成功（%s），上下文已投递", provLabel, p.Model, fmtTraceMS(connMS)), fmt.Sprintf("%s · %s connected (%s); context dispatched", provLabel, p.Model, fmtTraceMS(connMS))),
			)
		})

		ctx = withStreamBeat(ctx, func(kind string) {
			if gotFirstToken || ev == nil {
				return
			}
			beatCount++
			if !connectDone {
				handMS := connHandsMS
				if handMS <= 0 {
					handMS = max(1, time.Since(start).Milliseconds())
				}
				completeConnect(
					handMS,
					tr(lang, fmt.Sprintf("%s · %s 流式通道已建立（%s）", provLabel, p.Model, fmtTraceMS(handMS)), fmt.Sprintf("%s · %s stream connected (%s)", provLabel, p.Model, fmtTraceMS(handMS))),
				)
			}
			if !lastBeatAt.IsZero() && time.Since(lastBeatAt) < 1500*time.Millisecond {
				return
			}
			lastBeatAt = time.Now()
			waitMS := max(1, time.Since(start).Milliseconds())
			thinkStep.Detail = tr(lang,
				fmt.Sprintf("%s 正在深度推演（流式通道活跃 · 已收 %d 帧，%s）…", p.Model, beatCount, fmtTraceMS(waitMS)),
				fmt.Sprintf("%s reasoning deeply (stream active · %d frames, %s)...", p.Model, beatCount, fmtTraceMS(waitMS)),
			)
			ev.send(map[string]any{"t": "step", "step": thinkStep})
			ev.send(map[string]any{"t": "phase", "v": thinkStep.Detail})
		})

		ctx = withThinking(ctx, func(delta string) {
			clean := delta
			if red != nil {
				clean = red.back(clean)
			}
			if clean == "" {
				return
			}
			// Ignore pure leading whitespace chunks so models that emit blank reasoning_content do not suppress JSON thinking fallback or render an empty box.
			if strings.TrimSpace(nativeThinking.String()) == "" && strings.TrimSpace(clean) == "" {
				return
			}
			markFirstToken()
			nativeThinking.WriteString(clean)
			if ev != nil {
				ev.send(map[string]any{"t": "think", "v": clean})
			}
		})
		onText := func(delta string) {
			if delta != "" {
				markFirstToken()
			}
			rawStream.WriteString(delta)
			if ev == nil {
				return
			}
			curRaw := rawStream.String()
			if red != nil {
				curRaw = red.back(curRaw)
			}
			jt, ph := parseRehearsalStreamMetaLang(curRaw, lang)
			if strings.TrimSpace(nativeThinking.String()) == "" && len(jt) > sentJSONThinkLen {
				chunk := jt[sentJSONThinkLen:]
				sentJSONThinkLen = len(jt)
				if strings.TrimSpace(chunk) != "" || sentJSONThinkLen > len(chunk) {
					ev.send(map[string]any{"t": "think", "v": chunk})
				}
			}
			if ph != "" && ph != lastPhase {
				lastPhase = ph
				if thinkStep.Status != "done" {
					thinkStep.Status = "done"
					thinkStep.OK = true
					thinkStep.MS = max(1, time.Since(firstTokenAt).Milliseconds())
					thinkStep.Detail = tr(lang, "已完成集群拓扑与高可用风险推演", "Completed cluster topology & HA risk analysis")
					ev.send(map[string]any{"t": "step", "step": thinkStep})
				}
				if synthStartedAt.IsZero() {
					synthStartedAt = time.Now()
				}
				synthStep.Status = "running"
				synthStep.Detail = ph
				ev.send(map[string]any{"t": "step", "step": synthStep})
				ev.send(map[string]any{"t": "phase", "v": ph})
				ev.send(map[string]any{"t": "progress", "chars": utf8.RuneCountInString(curRaw)})
			} else if time.Since(lastProgressAt) >= 180*time.Millisecond {
				lastProgressAt = time.Now()
				ev.send(map[string]any{"t": "progress", "chars": utf8.RuneCountInString(curRaw)})
			}
		}

		reply, chatErr := s.aiChat(ctx, p, msgs, nil, onText)
		cancel()
		err = chatErr
		txt := strings.TrimSpace(reply.Text)
		if err == nil && red != nil {
			txt = red.back(txt)
		}
		if err == nil && spec.Validate != nil {
			if vErr := spec.Validate(txt); vErr != nil {
				var dCopy aiCallDiag
				if reply.Diag != nil {
					dCopy = *reply.Diag
				} else {
					dCopy = aiCallDiag{
						Provider:   p.Name,
						Model:      p.Model,
						API:        providerAPIName(p),
						HTTPStatus: 200,
						MS:         max(1, time.Since(start).Milliseconds()),
						InTokens:   reply.In,
						OutTokens:  reply.Out,
					}
				}
				if dCopy.ReasonCode == "" {
					dCopy.ReasonCode = "invalid_output"
				}
				if dCopy.ResponseRaw == "" && txt != "" {
					dCopy.ResponseRaw = s.scrubDiagText(p, txt)
				}
				reply.Diag = &dCopy
				if !gotFirstToken {
					markFirstToken()
				}
				if thinkStep.Status != "done" {
					thinkStep.Status = "done"
					thinkStep.OK = true
					thinkStep.MS = max(1, time.Since(firstTokenAt).Milliseconds())
					thinkStep.Detail = tr(lang, "已完成集群拓扑与高可用风险推演", "Completed cluster topology & HA risk analysis")
				}
				err = &aiCallError{Msg: vErr.Error(), Diag: &dCopy, Err: vErr}
			}
		}

		u := usageFrom(p, reply)
		u.User, u.IP, u.Feature, u.Target, u.Session = user, clientIP(r), "change_rehearsal", target, session
		u.MS, u.OK, u.Failover = time.Since(start).Milliseconds(), err == nil, i > 0
		if err != nil {
			u.Error = truncRunes(err.Error(), 200)
			if d := aiDiagFromErr(err); d != nil {
				u.applyDiag(d)
				if len(d.Attempts) > 0 {
					for _, att := range d.Attempts {
						if len(providers) > 1 && att.RequestNote != "" && !strings.Contains(att.RequestNote, provLabel) {
							att.RequestNote = provLabel + " · " + p.Model + " / " + att.RequestNote
						}
						failedAttempts = append(failedAttempts, att)
					}
				} else {
					failedAttempts = append(failedAttempts, aiAttemptDiag{
						Endpoint:     d.Endpoint,
						API:          d.API,
						HTTPStatus:   d.HTTPStatus,
						MS:           max(1, d.MS),
						ResponseID:   d.ResponseID,
						Reason:       d.ReasonCode,
						InTokens:     d.InTokens,
						OutTokens:    d.OutTokens,
						CachedTokens: d.CachedTokens,
						SSEEvents:    d.SSEEvents,
						Keepalives:   d.Keepalives,
						RequestNote:  provLabel + " · " + p.Model,
					})
				}
			}
		}
		s.aiRecordUsage(u)

		if err == nil {
			if !gotFirstToken {
				markFirstToken()
			}
			if thinkStep.Status != "done" {
				thinkStep.Status = "done"
				thinkStep.OK = true
				thinkStep.MS = max(1, time.Since(firstTokenAt).Milliseconds())
				thinkStep.Detail = tr(lang, "已完成集群拓扑与高可用风险推演", "Completed cluster topology & HA risk analysis")
				if ev != nil {
					ev.send(map[string]any{"t": "step", "step": thinkStep})
				}
			}
			if !synthStartedAt.IsZero() {
				synthStep.MS = max(1, time.Since(synthStartedAt).Milliseconds())
			}
			if synthStep.Status == "pending" {
				synthStep.Status = "running"
				if ev != nil {
					ev.send(map[string]any{"t": "step", "step": synthStep})
				}
			}
			finalThink := strings.TrimSpace(nativeThinking.String())
			if finalThink == "" {
				jt, _ := extractLiveJSONThinking(txt)
				finalThink = strings.TrimSpace(jt)
			}
			trace.Model = p.Model
			trace.Provider = p.Name
			trace.Thinking = truncRunes(finalThink, 12000)
			trace.Reasoning = reply.Reasoning
			trace.InTokens = reply.In
			trace.OutTokens = reply.Out
			trace.MS = max(1, time.Since(overallStart).Milliseconds())
			if reply.Diag != nil && (reply.Diag.FallbackUsed != "" || len(failedAttempts) > 0) {
				cp := *reply.Diag
				if len(failedAttempts) > 0 {
					cp.Attempts = append(append([]aiAttemptDiag(nil), failedAttempts...), cp.Attempts...)
				}
				trace.Diag = &cp
			}
			trace.Steps = append(append([]rehearsalTraceStep(nil), preSteps...), connectStep, thinkStep, synthStep)
			return txt, trace, 200, nil
		}
		if r.Context().Err() != nil {
			return "", trace, 499, err
		}
		if i+1 < len(providers) {
			if ev != nil {
				ev.send(map[string]any{"t": "phase", "v": tr(lang, "主模型响应异常，正在自动切换备用模型重试…", "Primary model failed; failing over to backup provider...")})
			}
			continue
		}

		var finalDiag *aiCallDiag
		if d := aiDiagFromErr(err); d != nil {
			cp := *d
			if len(failedAttempts) > len(cp.Attempts) {
				cp.Attempts = failedAttempts
			}
			cp.MS = max(cp.MS, time.Since(overallStart).Milliseconds())
			finalDiag = &cp
			err = &aiCallError{Msg: err.Error(), Diag: finalDiag, Err: err}
		}
		trace.Diag = finalDiag

		failMS := max(1, time.Since(start).Milliseconds())
		failSummary := truncRunes(cleanUpstreamErrText(localizeGoMessage(lang, err.Error())), 160)
		if !gotFirstToken {
			connectStep.Status = "error"
			connectStep.OK = false
			connectStep.MS = failMS
			connectStep.Detail = failSummary
			connectStep.Diag = finalDiag
			if ev != nil {
				ev.send(map[string]any{"t": "step", "step": connectStep})
			}
		} else if thinkStep.Status != "done" {
			thinkStep.Status = "error"
			thinkStep.OK = false
			thinkStep.MS = max(1, time.Since(firstTokenAt).Milliseconds())
			thinkStep.Detail = failSummary
			thinkStep.Diag = finalDiag
			if ev != nil {
				ev.send(map[string]any{"t": "step", "step": thinkStep})
			}
		} else {
			synthStep.Status = "error"
			synthStep.OK = false
			synthStep.MS = failMS
			synthStep.Detail = failSummary
			synthStep.Diag = finalDiag
			if ev != nil {
				ev.send(map[string]any{"t": "step", "step": synthStep})
			}
		}
		trace.Steps = append(append([]rehearsalTraceStep(nil), preSteps...), connectStep, thinkStep, synthStep)
	}
	return "", trace, 502, err
}

func finishRehearsalResp(w http.ResponseWriter, ev *sse, status int, rh changeRehearsal) {
	rh.RestorationAlerts = auditRehearsalRestorations(rh.Goal, rh.ExtraScope, rh.Steps, wLang(w))
	if ev != nil {
		ev.send(map[string]any{"t": "done", "rehearsal": rh})
		return
	}
	sWriteJSON(w, status, rh)
}

func failRehearsalResp(s *storeServer, w http.ResponseWriter, ev *sse, code int, msg string, diags ...*aiCallDiag) {
	msg = localizeGoMessage(wLang(w), msg)
	var diag *aiCallDiag
	for _, d := range diags {
		if d != nil {
			diag = d
			break
		}
	}
	if ev != nil {
		payload := map[string]any{"t": "error", "v": msg, "code": code}
		if diag != nil {
			payload["diag"] = diag
		}
		ev.send(payload)
		return
	}
	if diag != nil {
		sWriteJSON(w, code, map[string]any{"error": msg, "diag": diag})
		return
	}
	s.fail(w, code, msg)
}

func sWriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ---- HTTP router under /api/clusters/{id}/rehearsals ----

func (s *storeServer) handleRehearsals(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, parts []string) {
	// Listing and viewing existing sessions only require delivery.view, but when AI master switch is OFF we block
	// mutating rehearsal operations completely to honor the strict Scheme 1 / Scheme 2 boundary.
	if len(parts) == 0 && r.Method == "GET" {
		if !s.aiStatus().Enabled {
			s.writeJSON(w, 200, []changeRehearsal{})
			return
		}
		s.writeJSON(w, 200, s.listRehearsalsLang(f.ID, reqLang(r)))
		return
	}
	if len(parts) == 2 && parts[1] == "sync-vex" && r.Method == "POST" && reRehearsalID.MatchString(parts[0]) {
		s.syncRehearsalVEX(w, r, session, f, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "apply" && r.Method == "POST" && reRehearsalID.MatchString(parts[0]) {
		s.applyRehearsalProduction(w, r, session, f, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "void" && r.Method == "POST" && reRehearsalID.MatchString(parts[0]) {
		s.voidRehearsal(w, r, session, f, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "propagate-targets" && r.Method == "GET" && reRehearsalID.MatchString(parts[0]) {
		s.handlePropagateTargets(w, r, session, f, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "propagate" && r.Method == "POST" && reRehearsalID.MatchString(parts[0]) {
		s.handlePropagateRehearsal(w, r, session, f, parts[0])
		return
	}
	if !s.aiStatus().Enabled {
		s.fail(w, 409, "平台 AI 功能当前未开启，无法使用变更演练工作台")
		return
	}
	if len(parts) == 3 && parts[1] == "img" && r.Method == "GET" {
		rid, name := parts[0], parts[2]
		if !reRehearsalID.MatchString(rid) || !reRehearsalImg.MatchString(name) {
			s.fail(w, 404, "图片不存在")
			return
		}
		b, err := os.ReadFile(filepath.Join(s.rehearsalImgDir(f.ID, rid), name))
		if err != nil {
			s.fail(w, 404, "图片不存在")
			return
		}
		w.Header().Set("Content-Type", http.DetectContentType(b))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "private, max-age=86400")
		_, _ = w.Write(b)
		return
	}
	if f.Current.DeliveryMode == "configuration" {
		s.fail(w, 409, "仅配置交付不代表现场已安装集群，不支持变更演练")
		return
	}
	if len(parts) == 0 && r.Method == "POST" {
		s.createRehearsal(w, r, session, f)
		return
	}
	if len(parts) < 1 || !reRehearsalID.MatchString(parts[0]) {
		s.fail(w, 404, "演练会话不存在")
		return
	}
	rid := parts[0]
	switch {
	case len(parts) == 1 && r.Method == "GET":
		rh, ok := s.loadRehearsal(f.ID, rid)
		if !ok {
			s.fail(w, 404, "演练会话不存在")
			return
		}
		lang := reqLang(r)
		rh.RestorationAlerts = auditRehearsalRestorations(rh.Goal, rh.ExtraScope, rh.Steps, lang)
		rh.ConflictAlerts = computeRehearsalConflicts(rh, s.listRehearsals(f.ID), lang)
		s.writeJSON(w, 200, rh)
	case len(parts) == 1 && r.Method == "DELETE":
		rehearsalMu.Lock()
		_, ok := s.loadRehearsal(f.ID, rid)
		if ok {
			_ = os.Remove(s.rehearsalPath(f.ID, rid))
			_ = os.RemoveAll(s.rehearsalImgDir(f.ID, rid))
		}
		rehearsalMu.Unlock()
		if !ok {
			s.fail(w, 404, "演练会话不存在")
			return
		}
		s.auditReq(r, "rehearsal-delete", session.User, f.ID+" "+rid)
		s.writeJSON(w, 200, map[string]bool{"ok": true})
	case len(parts) == 2 && parts[1] == "refine" && r.Method == "POST":
		s.refineRehearsal(w, r, session, f, rid)
	case len(parts) == 2 && parts[1] == "scope" && r.Method == "POST":
		s.submitRehearsalScope(w, r, session, f, rid)
	case len(parts) == 2 && parts[1] == "probe" && r.Method == "POST":
		s.submitRehearsalProbe(w, r, session, f, rid)
	case len(parts) == 3 && parts[1] == "steps" && r.Method == "PATCH":
		s.patchRehearsalStep(w, r, session, f, rid, parts[2])
	case len(parts) == 4 && parts[1] == "steps" && parts[3] == "verify" && r.Method == "POST":
		s.verifyRehearsalStep(w, r, session, f, rid, parts[2])
	case len(parts) == 4 && parts[1] == "steps" && parts[3] == "troubleshoot" && r.Method == "POST":
		s.troubleshootRehearsalStep(w, r, session, f, rid, parts[2])
	case len(parts) == 4 && parts[1] == "steps" && parts[3] == "apply" && r.Method == "POST":
		s.applyRehearsalProposal(w, r, session, f, rid, parts[2])
	case len(parts) == 2 && parts[1] == "finalize" && r.Method == "POST":
		s.finalizeRehearsal(w, r, session, f, rid)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

const rehearsalScopeSystem = `你是资深离线中间件变更架构师。用户打算对一个已经部署运行的生产中间件集群做变更。
因为生产集群可能已经发生过主从切换、参数手动调整或周边环境变化，你第一步只需做「诉求核对与边界对齐」：
- 阅读平台提供的初始交付拓扑、关键参数与用户的变更诉求（若附带架构/报错/工单截图请一并识别）；
- **先判断诉求是否清晰完整（intent_unclear）**：若用户的文字非常简略模糊（如「看这个截图有点问题」「帮我看下报错」「配置改一下」）、缺少明确目标值/处理方式（仅排查 vs 改配置修复）或主要依赖你从截图中反推问题，请设 "intent_unclear": true，并在 scope_summary 中明确写出你识别到的具体现象/节点/报错与拟处理方向，把 **第 1 题留给「意图核对 / 诉求补全」**（让用户确认你是否识别准确，并给出具体处理方向选项及「识别有偏，补充真实诉求（补充真实目标）」），再视需要补 1～2 题；
- 先在 JSON 第一个字段 thinking 中先评估本次变更的复杂度与风险级别（轻量在线 reload 变更 vs 需重启/切主/升级/扩缩容的中高风险变更），再简明写出分析推演过程；
- 给出 1 句话的变更边界摘要（scope_summary），并**严格按变更复杂度提出最少且必要的边界确认项（绝不凑数问无关问题）**：
  * **轻量在线变更**（仅补规则/reload/动态参数，无需重启与切主）：只提 **1～2 个**真正影响执行的确认项（严禁硬问「停机窗口」「离线包就绪」「应用重连」「备份恢复」等无关项！）；
  * **中高风险变更**（需滚动重启/切主/升级/扩缩容/证书或备份架构改造）：提 **2～4 个**最关键的边界确认项（聚焦维护窗口与闪断口径、目标离线包/节点就绪度、应用连接重试机制、备份与演练条件）；
- 每项必须精炼克制，禁止把三四个子问题塞进一个长句：
  * label：4～6 字维度短标签（如「意图核对」「版本与离线包」「拓扑与复制」「窗口与重连」「备份与演练」）；
  * question：一句直达核心的简短确认问句（不超过 32 字）；
  * options：3～4 个结构化单选卡片文案，统一采用「核心结论，简要补充说明」两段式（卡片正文控制在 26 字以内）；若某选项代表具体目标已确定但用户诉求中尚未写明具体值（如版本已定/目标明确、待调参数目标值已定、新增节点已就绪、排期窗口已定、识别有偏需补充真实目标），请在该选项末尾附加「（补充目标版本号）」「（补充参数与目标值）」「（补充节点IP）」「（补充真实诉求）」等简短括号标记以便前端自动展开输入框，而「版本待定/状态不明/按默认/通用策略」类选项严禁附加。
严格只输出一个 JSON 对象，不要附加 Markdown 代码块：
{"thinking":"1. 诉求清晰度与集群基线分析...；2. 变更核心风险点...；3. 需对齐的意图或窗口前提...","intent_unclear":false,"title":"不超过28字的演练标题","scope_summary":"一句话概括本次变更核心边界（若为截图识别则写清识别到的现象与拟处理方向）","questions":[{"id":"q1","label":"窗口与闪断","question":"可接受的业务闪断窗口与应用重连条件？","options":["秒级闪断滚动切换，应用具备自动重连","低峰计划窗口内执行，允许数秒中断","必须零中断在线操作，暂不允许切主"]},{"id":"q2","label":"版本与就绪","question":"目标小版本及离线包、节点准备到哪一步？","options":["全部就绪，目标明确且包与节点已核验（补充目标版本号）","版本已定，离线包或节点待核验（补充目标版本号）","版本待定，需先确认兼容目标","状态不明，先核实现网与离线资源"]}]}`

func cleanSecurityContext(sc *rehearsalSecurityContext) *rehearsalSecurityContext {
	if sc == nil {
		return nil
	}
	out := &rehearsalSecurityContext{
		Kind:             strings.TrimSpace(sc.Kind),
		FindingKeys:      cleanStringList(sc.FindingKeys, 40, 120),
		CVEs:             cleanStringList(sc.CVEs, 40, 60),
		Package:          truncRunes(strings.TrimSpace(sc.Package), 100),
		Ecosystem:        truncRunes(strings.TrimSpace(sc.Ecosystem), 80),
		CurrentVersion:   truncRunes(strings.TrimSpace(sc.CurrentVersion), 100),
		TargetVersion:    truncRunes(strings.TrimSpace(sc.TargetVersion), 100),
		RepoFixReady:     sc.RepoFixReady,
		BaselineCheckIDs: cleanStringList(sc.BaselineCheckIDs, 15, 60),
		CertTarget:       truncRunes(strings.TrimSpace(sc.CertTarget), 160),
	}
	switch out.Kind {
	case "cve_patch", "config_hardening", "cert_rotation":
	default:
		if len(out.CVEs) > 0 || out.Package != "" {
			out.Kind = "cve_patch"
		} else if out.CertTarget != "" {
			out.Kind = "cert_rotation"
		} else if len(out.BaselineCheckIDs) > 0 {
			out.Kind = "config_hardening"
		} else {
			return nil
		}
	}
	return out
}

func securityContextPrompt(sc *rehearsalSecurityContext, stage string) string {
	if sc == nil {
		return ""
	}
	var sb strings.Builder
	kindLabel := map[string]string{
		"cve_patch":        "CVE 软件漏洞补丁升级与修复",
		"config_hardening": "安全配置基线加固 / 漏洞临时缓解",
		"cert_rotation":    "TLS 证书无中断滚动轮换",
	}[sc.Kind]
	fmt.Fprintf(&sb, "\n【安全修复上下文（由平台安全中心自动注入）】\n- 安全演练类型：%s\n", kindLabel)
	if len(sc.CVEs) > 0 {
		fmt.Fprintf(&sb, "- 关联漏洞编号（%d 个）：%s\n", len(sc.CVEs), strings.Join(sc.CVEs, ", "))
	}
	if sc.Package != "" {
		fmt.Fprintf(&sb, "- 受影响软件包：%s（生态：%s）\n", sc.Package, firstNonEmptyStr(sc.Ecosystem, "OS"))
	}
	if sc.CurrentVersion != "" || sc.TargetVersion != "" {
		fmt.Fprintf(&sb, "- 版本基线对照：%s → %s\n", firstNonEmptyStr(sc.CurrentVersion, "待现场探针核实"), firstNonEmptyStr(sc.TargetVersion, "待确认修复版或配置缓解"))
	}
	if sc.RepoFixReady {
		sb.WriteString("- 平台离线软件源状态：本地软件源索引已存在可用修复版本，可通过离线软件库同步备包。\n")
	}
	if len(sc.BaselineCheckIDs) > 0 {
		fmt.Fprintf(&sb, "- 关联配置基线项：%s\n", strings.Join(sc.BaselineCheckIDs, ", "))
	}
	if sc.CertTarget != "" {
		fmt.Fprintf(&sb, "- 关联 TLS 证书对象：%s\n", sc.CertTarget)
	}
	switch stage {
	case "scope":
		sb.WriteString("- 探针采集硬性要求：请在只读脚本中额外核实（1）每台节点当前真实安装的软件包版本（dpkg-query -W 或 rpm -q）；（2）与上述 CVE/基线直接相关的运行配置或可选模块是否实际启用（如 nginx -T、keepalived 配置、pg_hba.conf、TLS 监听与证书有效期 openssl x509 -noout -dates）；（3）当前主从/VIP/LB 拓扑状态，以便准确判断是需升级打补丁、配置缓解还是实为不受影响。\n")
	case "probe":
		sb.WriteString("- 演练步骤硬性要求：请确保在【变更前预检】核验当前漏洞包版本/基线配置与离线包就绪；在【核心变更执行】采用高可用滚动顺序（先备后主 / 先摘流量再升包）以最小化中断；在【变更后验收】包含验证修复后版本号或加密握手/配置生效的明确命令；在【应急回退】给出精确的降级或配置恢复命令。\n")
	}
	return sb.String()
}

const rehearsalLightCreateSystem = `你是资深中间件运维与变更专家。用户对一个已投产集群发起了「简单推演（light）」——跳过繁琐的维护窗口多选题，直接生成一份 **100% 纯只读、极简一屏** 的 Bash 现场状态采集脚本（probe_script），以便先核实生产真实状态再做 3～5 步快速验证。

核心采集约束（克制聚焦、一屏可截图，严禁发散）：
1. **固定 1～2 行基础身份头（必采，对齐下游「节点角色与状态」表的 节点/地址/角色/版本/状态 5 列）**：无论本次变更是否涉及升级，脚本开头都必须用 1～2 行精简输出本机 hostname -s、本机业务 IP、**主组件及关键伴随组件的实测版本号**（如 PostgreSQL server_version + patroni --version、Redis redis-server -v、Nginx nginx -v、HAProxy haproxy -v、Keepalived keepalived -v、etcd etcd --version 等，单行合并输出，绝不遗漏导致下游表出现「待采集」）以及当前真实主从/集群健康状态；
2. 除上述基础身份头外，只采本次变更真正需要知道的 2～3 个核心配置项、参数或目录状态，严禁做成全量巡检脚本；
3. 终端总输出严格控制在约 12～28 行以内（单屏可完整截图），脚本总行数尽量不超过 40 行，严禁 cat 整份配置文件或打印无过滤长列表；
4. 规避 ELB / 四层负载均衡回环（Hairpinning）：后端节点本机采集脚本严禁访问指向自身的云 ELB / SLB / LVS VIP，本机只查本地监听与 127.0.0.1/本机 IP；如需测 VIP 请在 probe_notes 说明在集群外客户端验证。

硬性安全红线：
1. 脚本只能包含只读查看命令，并在开头保留 bash 自保护与 set -uo pipefail；
2. 严禁任何写入、删除、重启、切换、改配置、装包或写临时文件操作（禁止 rm/mv/cp/mkdir/chmod/chown/sed -i/tee、systemctl stop|restart|reload、patronictl switchover|failover|restart|edit-config、etcdctl put|del、SQL 写操作、重定向写文件；仅允许 2>/dev/null 或 >/dev/null）；
3. 严禁输出任何密码、私钥或凭据内容（过滤 password/secret/requirepass/masterauth 行）。

严格只输出一个 JSON 对象，不要附加 Markdown 代码块：
{"thinking":"1. 变更定位（无需重启切主，走简单推演）...；2. 本次必查哪 2-4 项核心现场状态...；3. 单屏精简与纯只读/ELB 回环规避...","title":"不超过28字的演练标题","scope_summary":"一句话概括本次简单推演的核心目标与安全边界","probe_script":"#!/usr/bin/env bash\nif [ -z \"${BASH_VERSION:-}\" ]; then exec bash \"$0\" \"$@\"; fi\nset -uo pipefail\n...","probe_notes":["使用 bash 执行，输出约一屏以内，可直接复制或单张截图回传"]}`

const rehearsalQuickCreateSystem = `你是资深中间件运维与变更专家。用户对一个已投产运行的集群发起了「极速变更（quick）」——目标简单明确、现场现状已在诉求/截图中明确，只需在线动态调参、热重载（reload）或局部单点调整，**无需重启服务与切主**。
请**跳过维护窗口问答与只读采集探针**，直接输出一份极简、可直接照抄执行的步骤清单（steps），以便工程师快速执行核验后一键生成《变更报告》归档留痕！

核心编制约束：
1. **极简精炼**：正向步骤严格控制在 **2～3 步**（例如：1 步执行在线修改与热重载 → 1 步核验参数生效与集群状态；如有必要最多加 1 步可选即时触发动作），外加 **1 步独立应急回退**（phase="rollback"），绝不凑步数；
2. **每步独立可复制、堡垒机整块防吞行（严禁多台滚动动作合进同一复制框）**：
   - 严禁 read -r -p 交互变量、严禁跨步骤隐藏变量（OLD/R1/R2/CFG 等）；若同一步内存在必须分步人工确认中间结果的两段命令，必须拆成独立步骤或使用 commands 数组分框（含 label、command、gate），绝不拼进同一个 command 字符串；
   - **多行命令整块防吞行铁律**：凡单框包含 **2 条及以上命令**（尤其含 sudo、psql、patronictl、sleep、systemctl 等耗时或读 stdin 的命令），**必须**整块包裹在 ( ... ) </dev/null 子 Shell 中（不要裸写多行，也不要用 bash <<'EOF'），防止 JumpServer/WebSSH 及 Ubuntu sudo use_pty 吞掉后续行或输出交错；同时避免把多条不相关命令用 ; 硬拼成超长单行（拆成子 Shell 内清晰短行），直接使用基线里的真实配置路径与服务名；
3. **执行机器（target_role）明确写清具体主机名与 IP**：例如「任一数据节点（如当前主库 node-1 / 172.30.4.26）执行一次」「所有数据节点（node-1 / node-2 / node-3，逐台执行）」；
4. **临时改动必须收尾复位**：若执行或验收中涉及任何临时测试对象（测试表/测试 Key/临时文件）或临时开关/摘流/放宽规则，必须在验收收尾步一并还原并清理干净，绝不遗留脏状态；
5. 若诉求中某参数值需要热重载后观察生效，expect 写清客观简洁的通过判据。

严格只输出一个 JSON 对象，不要附加 Markdown 代码块：
{"thinking":"1. 变更定性（仅热重载/轻量改配置且现状明确，走极速变更）...；2. 步骤设计与回退要点...","title":"不超过28字的变更标题","scope_summary":"一句话概括本次极速变更内容与影响边界（如仅 reload 无中断）","steps":[{"id":"s1","phase":"execute","order":1,"title":"步骤标题","target_role":"明确执行机器与IP","command":"1-6行原生命令","expect":"成功判据","risk_note":"注意事项","rollback":"即时回退命令","optional":false},{"id":"s2","phase":"verify","order":2,"title":"核验生效与集群状态","target_role":"明确执行机器与IP","command":"核验命令","expect":"预期结果","risk_note":"","rollback":"","optional":false},{"id":"s3","phase":"rollback","order":3,"title":"回退：恢复原配置","target_role":"明确执行机器与IP","command":"回退命令","expect":"已恢复原值","risk_note":"仅变更异常时按需执行","rollback":"","optional":true}]}`

const rehearsalAutoCreateSystem = `你是资深离线中间件变更架构师。用户对一个已投产运行的生产中间件集群发起了变更推演，你需要先**核验诉求是否清晰完整，再精准判断三档变更模式（resolved_mode）**，绝不瞎猜直接出方案，也绝不一刀切：

第 0 原则（诉求完整度前置门禁 — 优先于档位判断）：
- 如果用户的文字描述**模糊、笼统、缺少明确变更目标/期望结果/作用范围**（例如只写了「看这个截图有点问题」「帮我看下这个报错」「配置/日志需要改下」「主备好像异常」），或主要依赖你从附带截图中反推问题与改法、尚未得到用户本人确认：
  -> **严禁跳过确认直接进 quick（直出步骤）或 light（跳过确认直出探针）！**
  -> **必须设 "intent_unclear": true 且 "resolved_mode": "full"**，先停在「诉求核对与边界对齐」：
     1. 在 scope_summary 里清晰、具体地写出你从文字/截图中识别出的**核心现象、报错/参数、涉及节点与拟处理方向**，方便用户一眼核对是否识别正确；
     2. 在 questions 里 **第 1 题必须直接核对并补全需求本身**（label 如「意图核对」「诉求确认」）：复述识别到的问题，提供明确的处理方向选项（如「按识别方向补规则并热重载修复」「仅只读排查定位原因，暂不改配置」「识别有偏，按我的真实需求推进（补充真实诉求）」）；若还缺目标参数值或作用范围（单节点 vs 全集群），再补 1～2 题精准补全（总计 1～3 题，轻量问题严禁硬问无关的「停机窗口」「离线包就绪」）；
     3. probe_script 与 steps 留空。

仅当用户的变更目标、期望动作与大致范围已经**明确无歧义（intent_unclear=false）**时，按以下三档判断：
1. **极速变更（resolved_mode="quick"）**：变更特别简单、无需重启服务和主备切换（例如在线动态调参 reload 如改 log_filename / log_rotation_size、补单条明确规则/白名单），**且现场现状已在用户诉求或附带截图中明确**，无需再额外跑采集脚本。
   -> 跳过维护窗口多选题与只读探针！直接输出 **2～3 步正向步骤（execute/verify）+ 1 步独立回退（rollback）** 的 steps（每步 1～6 行原生命令、含 2 条及以上命令时整块包在 ( ... ) </dev/null 防堡垒机 WebSSH 与 sudo use_pty 吞后续行、target_role 写清具体节点与 IP、禁止 read -r -p 或隐藏变量；若验收创建了临时测试数据/文件或动了临时开关，必须在收尾步恢复并清理），questions 与 probe_script 均留空。
2. **简单推演（resolved_mode="light"）**：只需局部改配置/补规则/在线动态调参（仅 reload 即可生效，无需重启与切主、不涉及升级/扩缩容/证书或架构大改），**且变更意图已明确**，只是现场当前真实配置/规则/拓扑拿不准，需要先跑一屏只读探针核实后再出步骤。
   -> 跳过维护窗口多选题！直接输出 **100% 纯只读、极简一屏（总输出 12～28 行、脚本不超过 40 行）** 的 probe_script 和 probe_notes（带 bash 自保护头与 set -uo pipefail；开头必采 1～2 行基础身份头：节点名 + 本机 IP + 主组件及伴随组件实测版本号 + 当前真实主从/健康状态，对齐下游漂移表列不留「待采集」；再查本次变更相关的 2～3 个核心项；严禁写/重启/改配置/重定向写文件/输出密码，且严禁后端节点直连自身 ELB VIP），questions 与 steps 留空。
3. **全量推演（resolved_mode="full"）**：涉及滚动重启服务、主备切换/switchover、版本或补丁升级、扩缩容、备份/WAL 归档架构改造、TLS 证书轮换、跨节点或有业务闪断/数据风险的复杂变更。
   -> 先做「边界对齐」：提 2～4 个最关键的边界确认项（questions），probe_script 与 steps 留空。

questions 规则（仅 resolved_mode="full" 或 intent_unclear=true 时输出）：
- label：4～6 字维度短标签（如「意图核对」「作用范围」「窗口与闪断」「版本与就绪」「备份与演练」）；
- question：一句直达核心的简短确认问句（不超过 32 字）；
- options：3～4 个「核心结论，简要补充说明」两段式单选文案（不超过 26 字）；若某选项代表具体目标已定但诉求未写明具体值，或需要用户纠正/补充真实诉求，末尾加「（补充目标版本号）」「（补充真实诉求）」等短括号标记。

严格只输出一个 JSON 对象，不要附加 Markdown 代码块：
- 极速变更格式（resolved_mode="quick"，仅诉求清晰时）：
{"thinking":"1. 诉求清晰度与复杂度判定：诉求明确且仅在线热重载、现状已明确 -> resolved_mode=quick；2. 精简步骤与回退要点...","intent_unclear":false,"resolved_mode":"quick","title":"不超过28字的标题","scope_summary":"一句话概括变更内容与无中断边界","steps":[{"id":"s1","phase":"execute","order":1,"title":"...","target_role":"...","command":"...","expect":"...","risk_note":"","rollback":"","optional":false},{"id":"s2","phase":"verify","order":2,"title":"...","target_role":"...","command":"...","expect":"...","risk_note":"","rollback":"","optional":false},{"id":"s3","phase":"rollback","order":3,"title":"回退：恢复原值","target_role":"...","command":"...","expect":"...","risk_note":"仅异常时执行","rollback":"","optional":true}]}
- 简单推演格式（resolved_mode="light"，仅诉求清晰时）：
{"thinking":"1. 诉求清晰度与复杂度判定：诉求明确，仅单条规则/动态参数 reload 但现状拿不准 -> resolved_mode=light；2. 必查现场关键项（2-4项）...","intent_unclear":false,"resolved_mode":"light","title":"不超过28字的标题","scope_summary":"一句话概括本次变更核心目标与安全边界","probe_script":"#!/usr/bin/env bash\nif [ -z \"${BASH_VERSION:-}\" ]; then exec bash \"$0\" \"$@\"; fi\nset -uo pipefail\n...","probe_notes":["使用 bash 执行，输出约一屏以内，可直接复制或单张截图回传"]}
- 诉求待核对 / 全量推演格式（intent_unclear=true 或 resolved_mode="full"）：
{"thinking":"1. 诉求清晰度判定：...；2. 识别到的核心现象/风险点...；3. 需用户核对补全的关键项...","intent_unclear":true,"resolved_mode":"full","title":"不超过28字的标题","scope_summary":"一句话清晰复述识别到的现象/问题与拟处理方向","questions":[{"id":"q1","label":"意图核对","question":"截图识别到 XXX 报错，确认本次希望如何处理？","options":["定位根因并补全配置热重载修复","先纯只读采集排查，暂不做配置改动","识别有偏，按我的实际诉求推进（补充真实诉求）"]}]}`

type rehearsalTriageResult struct {
	Title          string
	Mode           string
	Stage          string
	ScopeSummary   string
	IntentUnclear  bool
	ScopeQuestions []rehearsalScopeQuestion
	ProbeScript    string
	ProbeNotes     []string
	ProbeSafe      bool
	ProbeWarnings  []string
	Steps          []rehearsalStep
	Drift          *rehearsalDrift
	Trace          rehearsalTrace
}

func (s *storeServer) runRehearsalTriage(
	r *http.Request,
	providers []aiProvider,
	user string,
	f clusterFacts,
	rid string,
	reqMode string,
	customTitle string,
	goal string,
	images []string,
	secCtx *rehearsalSecurityContext,
	effort thinkLevel,
	lang string,
	ev *sse,
) (rehearsalTriageResult, int, error) {
	inspectStart := time.Now()
	baseline, red := s.clusterBaselinePrompt(f)
	reqMode = strings.ToLower(strings.TrimSpace(reqMode))
	switch reqMode {
	case "quick", "light", "full", "auto":
	default:
		reqMode = "auto"
	}
	if secCtx != nil {
		reqMode = "full"
	}
	skillBlock, skillTitles := s.rehearsalSkillBlock(user, f, goal, secCtx)
	hostCount := 0
	if f.Plan != nil {
		hostCount = len(f.Plan.Hosts)
	}
	guardDetail := tr(lang, "自动剥离敏感口令与私钥字段，仅向模型提供架构拓扑与运行参数基线", "Automatically stripped passwords and private keys; sending only architecture topology and runtime parameters")
	if len(images) > 0 {
		guardDetail += tr(lang, fmt.Sprintf("（附带 %d 张参考截图）", len(images)), fmt.Sprintf(" (with %d reference image(s))", len(images)))
	}

	sysPrompt := rehearsalScopeSystem
	thinkTitle := tr(lang, "研判变更诉求与集群高可用边界", "Analyze change intent & HA boundaries")
	thinkWait := tr(lang, "正在结合集群拓扑与运行参数展开风险推演…", "Evaluating cluster topology and runtime parameters for risks...")
	synthID := "build-scope"
	synthKind := "synthesize"
	synthTitle := tr(lang, "生成变更边界澄清清单", "Generate change scope checklist")
	synthWait := tr(lang, "等待风险推演完成后提炼维护窗口与前提问题", "Synthesizing maintenance window and prerequisite questions...")
	var validateFn func(string) error

	switch reqMode {
	case "quick":
		sysPrompt = rehearsalQuickCreateSystem
		thinkTitle = tr(lang, "按极速变更直出执行与核验步骤", "Draft direct execution & verify steps (Quick Change)")
		thinkWait = tr(lang, "跳过窗口问答与只读探针，正在编排 2～3 步极简在线执行与回退清单…", "Skipping scope Q&A & probe; drafting 2–3 direct execution & rollback steps...")
		synthID = "build-quick-steps"
		synthKind = "synthesize"
		synthTitle = tr(lang, "生成极速变更执行清单", "Build Quick Change checklist")
		synthWait = tr(lang, "生成可直接复制执行的精简步骤，执行核验后即可一键生成变更报告", "Structuring ready-to-run steps for fast execution and change report archival...")
		validateFn = func(outText string) error {
			var chk struct {
				Steps []rehearsalStep `json:"steps"`
			}
			if raw := extractJSON(outText); raw != "" {
				_ = json.Unmarshal([]byte(raw), &chk)
			}
			if len(normalizeRehearsalStepsLang(chk.Steps, lang)) == 0 {
				return fmt.Errorf("%s", tr(lang, "模型未能生成有效的极速变更步骤（响应可能被截断），请重试", "Model did not return valid quick-change steps; please retry"))
			}
			return nil
		}
	case "light":
		sysPrompt = rehearsalLightCreateSystem
		thinkTitle = tr(lang, "研判轻量变更并定制极简只读探针", "Analyze light change & design concise probe")
		thinkWait = tr(lang, "跳过冗长窗口问答，正在紧扣变更目标筛选 2～4 项核心核查点…", "Skipping heavy scope Q&A; selecting 2–4 target-focused live checks...")
		synthID = "readonly-ast-guard"
		synthKind = "guard"
		synthTitle = tr(lang, "生成极简探针与静态安全红线扫描", "Generate concise probe & run static safety audit")
		synthWait = tr(lang, "等待脚本编写完成后执行 15 类高危写操作静态扫描", "Awaiting probe completion to run 15-category write-mutation checks...")
		validateFn = func(outText string) error {
			var chk struct {
				ProbeScript string `json:"probe_script"`
			}
			if raw := extractJSON(outText); raw != "" {
				_ = json.Unmarshal([]byte(raw), &chk)
			}
			if strings.TrimSpace(chk.ProbeScript) == "" {
				return fmt.Errorf("%s", tr(lang, "模型未能生成有效的只读采集脚本（响应可能被截断或未输出完整 JSON），请重试", "Model did not return a valid read-only probe script; please retry"))
			}
			return nil
		}
	case "auto":
		sysPrompt = rehearsalAutoCreateSystem
		thinkTitle = tr(lang, "评估诉求完整度、复杂度并选择推演档位", "Evaluate goal clarity, complexity & workflow depth")
		thinkWait = tr(lang, "正在核验诉求是否明确，并判断先做需求确认、直出极简探针还是全量边界对齐…", "Checking goal clarity and selecting intent confirmation, direct probe, or full alignment...")
		synthID = "build-scope"
		synthKind = "synthesize"
		synthTitle = tr(lang, "生成需求核对项或只读探针", "Generate intent checklist or direct probe")
		synthWait = tr(lang, "诉求模糊先输出意图核对问题；诉求明确则按风险直出探针或步骤", "Clarifying vague goals first; generating direct probe or steps for clear requests...")
	}

	pipeSpec := rehearsalPipelineSpec{
		PreSteps: []rehearsalTraceStep{
			{
				ID:     "read-baseline",
				Kind:   "inspect",
				Title:  tr(lang, "读取集群初始交付基线", "Load initial cluster delivery baseline"),
				Detail: fmt.Sprintf("%s %s · %s · %s %s%s", f.Current.AppName, f.Current.Version, tr(lang, fmt.Sprintf("%d 台节点", hostCount), fmt.Sprintf("%d host(s)", hostCount)), tr(lang, "基线交付", "Baseline"), truncRunes(f.Current.ID, 8), rehearsalSkillNote(lang, skillTitles)),
				MS:     max(1, time.Since(inspectStart).Milliseconds()),
				OK:     true,
				Status: "done",
			},
			{
				ID:     "scrub-context",
				Kind:   "guard",
				Title:  tr(lang, "敏感凭据脱敏与边界检查", "Scrub credentials and validate boundary"),
				Detail: guardDetail,
				MS:     1,
				OK:     true,
				Status: "done",
			},
		},
		ThinkTitle: thinkTitle,
		ThinkWait:  thinkWait,
		SynthID:    synthID,
		SynthKind:  synthKind,
		SynthTitle: synthTitle,
		SynthWait:  synthWait,
		Validate:   validateFn,
	}

	prompt := "【集群初始交付基线】\n" + baseline + securityContextPrompt(secCtx, "create") + "\n\n【用户本次变更诉求】\n" + goal
	text, trace, code, err := s.rehearsalRunAI(r, providers, user, f.ID, rid+"/create", "create", red, sysPrompt+skillBlock, prompt, images, pipeSpec, effort, ev)
	if err != nil {
		return rehearsalTriageResult{Trace: trace}, code, err
	}
	parseStart := time.Now()
	var parsed struct {
		Thinking      string                   `json:"thinking"`
		IntentUnclear bool                     `json:"intent_unclear"`
		ResolvedMode  string                   `json:"resolved_mode"`
		Title         string                   `json:"title"`
		ScopeSummary  string                   `json:"scope_summary"`
		Questions     []rehearsalScopeQuestion `json:"questions"`
		ProbeScript   string                   `json:"probe_script"`
		ProbeNotes    []string                 `json:"probe_notes"`
		Steps         []rehearsalStep          `json:"steps"`
		Drift         *rehearsalDrift          `json:"drift"`
	}
	if raw := extractJSON(text); raw != "" {
		_ = json.Unmarshal([]byte(raw), &parsed)
	}
	title := strings.TrimSpace(customTitle)
	if title == "" {
		title = truncRunes(strings.TrimSpace(parsed.Title), 60)
	}
	if title == "" {
		title = truncRunes(f.Current.AppName+tr(lang, " 变更演练", " Change Rehearsal"), 60)
	}
	summary := truncRunes(strings.TrimSpace(parsed.ScopeSummary), 300)

	// Decide final mode & initial stage:
	// - auto + intent_unclear=true: MUST pause in scoping (full) so the user can confirm/complete AI's interpretation first!
	// - quick (or auto -> quick with valid steps & clear intent): skips scoping & probing -> lands directly in rehearsing.
	// - light (or auto -> light with valid probe_script & clear intent): skips scoping -> lands in probing.
	// - full: lands in scoping.
	finalMode := "full"
	script := ensureProbeBashGuard(parsed.ProbeScript)
	quickSteps := normalizeRehearsalStepsLang(parsed.Steps, lang)
	resolvedLow := strings.ToLower(strings.TrimSpace(parsed.ResolvedMode))
	if reqMode == "quick" && len(quickSteps) > 0 {
		finalMode = "quick"
	} else if reqMode == "auto" && !parsed.IntentUnclear && resolvedLow == "quick" && len(quickSteps) > 0 {
		finalMode = "quick"
	} else if reqMode == "light" {
		finalMode = "light"
	} else if reqMode == "auto" && !parsed.IntentUnclear && resolvedLow == "light" && script != "" {
		finalMode = "light"
	}

	res := rehearsalTriageResult{
		Title:        title,
		Mode:         finalMode,
		ScopeSummary: summary,
		ProbeSafe:    true,
	}

	if finalMode == "quick" && len(quickSteps) > 0 {
		if trace.Thinking == "" {
			trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), tr(lang, fmt.Sprintf("已判定为极速变更（现状明确且仅在线热重载），跳过问答与探针，直接生成 %d 步执行与核验清单。", len(quickSteps)), fmt.Sprintf("Classified as Quick Change; skipped scope Q&A & probe and generated %d step(s).", len(quickSteps))))
		}
		finalizeTraceSynth(
			&trace,
			ev,
			synthID,
			tr(lang, fmt.Sprintf("已按「极速变更」直出 %d 步执行与回退清单，完成后可一键生成变更报告", len(quickSteps)), fmt.Sprintf("Generated %d Quick Change step(s); ready for execution & change report archival", len(quickSteps))),
			true,
			max(1, time.Since(parseStart).Milliseconds()),
		)
		res.Stage = "rehearsing"
		res.Steps = quickSteps
		res.Drift = parsed.Drift
		res.Trace = trace
	} else if finalMode == "light" && script != "" {
		safe, warns := validateReadOnlyProbeScriptLang(script, lang)
		if trace.Thinking == "" {
			trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), tr(lang, fmt.Sprintf("已判定为轻量变更（简单推演），跳过窗口多选题并直接定制 %s 极简单屏只读采集探针。", f.Current.AppName), fmt.Sprintf("Classified as Light Rehearsal; skipped scope Q&A and generated concise read-only probe for %s.", f.Current.AppName)))
		}
		synthDetail := tr(lang, "已按「简单推演」跳过窗口问答，生成极简只读探针并通过 15 类静态安全扫描", "Skipped scope Q&A (Light Rehearsal), generated concise probe and passed 15 static safety checks")
		if !safe {
			synthDetail = tr(lang, fmt.Sprintf("已按「简单推演」生成只读探针，但静态扫描发现 %d 项告警，请人工审阅脚本", len(warns)), fmt.Sprintf("Generated Light Rehearsal probe; static audit flagged %d warning(s) for review", len(warns)))
		}
		finalizeTraceSynth(
			&trace,
			ev,
			synthID,
			synthDetail,
			safe,
			max(1, time.Since(parseStart).Milliseconds()),
		)
		res.Stage = "probing"
		res.ProbeScript = script
		res.ProbeNotes = cleanStringList(parsed.ProbeNotes, 6, 200)
		res.ProbeSafe = safe
		res.ProbeWarnings = warns
		res.Trace = trace
	} else {
		res.Mode = "full"
		res.IntentUnclear = parsed.IntentUnclear
		qs := normalizeScopeQuestionsLang(parsed.Questions, lang)
		if trace.Thinking == "" {
			if parsed.IntentUnclear {
				trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), tr(lang, fmt.Sprintf("已结合集群 %s 基线与输入线索识别潜在变更诉求，因原始描述待进一步确认，先提炼 %d 项核对问题供确认。", f.ID, len(qs)), fmt.Sprintf("Inferred likely change intent for cluster %s; generated %d confirmation item(s) before proceeding.", f.ID, len(qs))))
			} else {
				trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), tr(lang, fmt.Sprintf("已核对集群 %s（%s %s）初始拓扑与参数基线，提炼出 %d 个变更窗口与高可用约束澄清项。", f.ID, f.Current.AppName, f.Current.Version, len(qs)), fmt.Sprintf("Checked baseline topology & parameters for cluster %s (%s %s), extracting %d scope clarification question(s).", f.ID, f.Current.AppName, f.Current.Version, len(qs))))
			}
		}
		synthMsg := tr(lang, fmt.Sprintf("已按「全量推演」提炼 %d 个现场前提问题，确认后自动生成纯只读探针", len(qs)), fmt.Sprintf("Extracted %d prerequisite question(s) for Full Rehearsal; ready to generate probe", len(qs)))
		if parsed.IntentUnclear {
			synthMsg = tr(lang, fmt.Sprintf("识别到诉求待确认或补全，已提炼 %d 项需求核对问题（如识别有偏可直接点击「修正诉求」）", len(qs)), fmt.Sprintf("Detected ambiguous goal; prepared %d intent-confirmation item(s) (click Refine Goal if misinterpreted)", len(qs)))
		}
		finalizeTraceSynth(
			&trace,
			ev,
			synthID,
			synthMsg,
			true,
			max(1, time.Since(parseStart).Milliseconds()),
		)
		res.Stage = "scoping"
		res.ScopeQuestions = qs
		res.Trace = trace
	}
	return res, 0, nil
}

func (s *storeServer) createRehearsal(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts) {
	var in struct {
		Title           string                    `json:"title"`
		Goal            string                    `json:"goal"`
		Mode            string                    `json:"mode"` // auto | quick | light | full
		Images          []string                  `json:"images"`
		Model           string                    `json:"model"`
		Effort          thinkLevel                `json:"effort"`
		SecurityContext *rehearsalSecurityContext `json:"security_context"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 28<<20)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容格式不对或图片超过大小限制")
		return
	}
	lang := reqLang(r)
	goal := strings.TrimSpace(in.Goal)
	title := strings.TrimSpace(in.Title)
	if len([]rune(goal)) < 4 || len([]rune(goal)) > 4000 {
		s.fail(w, 400, "请填写清楚变更诉求（4～4000 字）")
		return
	}
	providers, code, err := s.rehearsalCheckAILang(session.User, len(in.Images) > 0, in.Model, lang)
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}
	rid := randomStoreToken(6)
	imgNames, err := s.storeRehearsalImages(f.ID, rid, in.Images)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}

	ev := startRehearsalSSE(w, r)
	secCtx := cleanSecurityContext(in.SecurityContext)
	res, code, err := s.runRehearsalTriage(r, providers, session.User, f, rid, in.Mode, title, goal, in.Images, secCtx, in.Effort, lang, ev)
	if err != nil {
		if len(imgNames) > 0 {
			_ = os.RemoveAll(s.rehearsalImgDir(f.ID, rid))
		}
		failRehearsalResp(s, w, ev, code, err.Error(), aiDiagFromErr(err), res.Trace.Diag)
		return
	}

	now := nowStamp()
	rh := changeRehearsal{
		ID:              rid,
		ClusterID:       f.ID,
		AppID:           f.Current.AppID,
		AppName:         f.Current.AppName,
		BaseJobID:       f.Current.ID,
		Title:           res.Title,
		Goal:            goal,
		GoalImages:      imgNames,
		Owner:           session.User,
		Mode:            res.Mode,
		Stage:           res.Stage,
		SecurityContext: secCtx,
		ScopeQuestions:  res.ScopeQuestions,
		ScopeSummary:    res.ScopeSummary,
		IntentUnclear:   res.IntentUnclear,
		ProbeScript:     res.ProbeScript,
		ProbeNotes:      res.ProbeNotes,
		ProbeSafe:       res.ProbeSafe,
		ProbeWarnings:   res.ProbeWarnings,
		Drift:           res.Drift,
		Steps:           res.Steps,
		Traces:          map[string]rehearsalTrace{"create": res.Trace},
		CreatedAt:       now,
		UpdatedAt:       now,
	}

	rehearsalMu.Lock()
	err = s.saveRehearsal(rh)
	rehearsalMu.Unlock()
	if err != nil {
		failRehearsalResp(s, w, ev, 500, "保存演练会话失败")
		return
	}
	s.auditReq(r, "rehearsal-create", session.User, f.ID+" "+rid+" "+rh.Mode)
	finishRehearsalResp(w, ev, 201, rh)
}

func (s *storeServer) refineRehearsal(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string) {
	var in struct {
		Title      string     `json:"title"`
		Goal       string     `json:"goal"`
		Mode       string     `json:"mode"` // auto | quick | light | full
		KeepImages []string   `json:"keep_images"`
		AddImages  []string   `json:"add_images"`
		Model      string     `json:"model"`
		Effort     thinkLevel `json:"effort"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 28<<20)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容格式不对或图片超过大小限制")
		return
	}
	lang := reqLang(r)
	goal := strings.TrimSpace(in.Goal)
	title := strings.TrimSpace(in.Title)
	if len([]rune(goal)) < 4 || len([]rune(goal)) > 4000 {
		s.fail(w, 400, tr(lang, "请填写清楚变更诉求（4～4000 字）", "Please provide a clear change goal (4–4000 characters)"))
		return
	}
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	rehearsalMu.Unlock()
	if !ok {
		s.fail(w, 404, tr(lang, "演练会话不存在", "Rehearsal session not found"))
		return
	}
	if rh.Stage == "finalized" || rh.Applied || rh.Voided {
		s.fail(w, 409, tr(lang, "已定稿、已落地或已作废的演练不可修改原始诉求，请发起新演练", "Finalized, applied, or voided rehearsals cannot be refined; please start a new rehearsal"))
		return
	}

	// Only keep image filenames that genuinely belong to this rehearsal's GoalImages.
	allowedKeep := map[string]bool{}
	for _, n := range rh.GoalImages {
		allowedKeep[n] = true
	}
	var keptNames []string
	seenKeep := map[string]bool{}
	for _, n := range in.KeepImages {
		n = strings.TrimSpace(n)
		if allowedKeep[n] && !seenKeep[n] {
			seenKeep[n] = true
			keptNames = append(keptNames, n)
		}
	}
	if len(keptNames)+len(in.AddImages) > 6 {
		s.fail(w, 400, tr(lang, "参考截图总数不能超过 6 张", "Total reference screenshots cannot exceed 6"))
		return
	}
	// Validate newly uploaded data URLs up front before running AI.
	for _, data := range in.AddImages {
		if m := reDataImage.FindStringSubmatch(data); m == nil || len(data) > 6<<20 {
			s.fail(w, 400, tr(lang, "图片格式需为 png、jpg、gif 或 webp，且单张不超过 4 MiB", "Images must be PNG, JPG, GIF, or WebP and under 4 MiB each"))
			return
		}
	}

	allImageData := make([]string, 0, len(keptNames)+len(in.AddImages))
	for _, name := range keptNames {
		if d := s.rehearsalImageData(f.ID, rid, name); d != "" {
			allImageData = append(allImageData, d)
		}
	}
	allImageData = append(allImageData, in.AddImages...)

	providers, code, err := s.rehearsalCheckAILang(session.User, len(allImageData) > 0, in.Model, lang)
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}

	ev := startRehearsalSSE(w, r)
	res, code, err := s.runRehearsalTriage(r, providers, session.User, f, rid, in.Mode, title, goal, allImageData, rh.SecurityContext, in.Effort, lang, ev)
	if err != nil {
		failRehearsalResp(s, w, ev, code, err.Error(), aiDiagFromErr(err), res.Trace.Diag)
		return
	}

	var addedNames []string
	if len(in.AddImages) > 0 {
		addedNames, err = s.storeRehearsalImages(f.ID, rid, in.AddImages)
		if err != nil {
			failRehearsalResp(s, w, ev, 400, err.Error())
			return
		}
	}
	finalImgs := append([]string{}, keptNames...)
	for _, n := range addedNames {
		if !seenKeep[n] {
			seenKeep[n] = true
			finalImgs = append(finalImgs, n)
		}
	}

	rehearsalMu.Lock()
	cur, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		failRehearsalResp(s, w, ev, 404, tr(lang, "演练会话不存在", "Rehearsal session not found"))
		return
	}
	if cur.Stage == "finalized" || cur.Applied || cur.Voided {
		rehearsalMu.Unlock()
		failRehearsalResp(s, w, ev, 409, tr(lang, "已定稿、已落地或已作废的演练不可修改原始诉求", "Finalized, applied, or voided rehearsals cannot be refined"))
		return
	}
	oldImgs := append(append([]string{}, cur.GoalImages...), cur.ProbeImages...)
	cur.Title = res.Title
	cur.Goal = goal
	cur.GoalImages = finalImgs
	cur.ExtraScope = ""
	cur.Mode = res.Mode
	cur.Stage = res.Stage
	cur.ScopeQuestions = res.ScopeQuestions
	cur.ScopeSummary = res.ScopeSummary
	cur.IntentUnclear = res.IntentUnclear
	cur.ProbeScript = res.ProbeScript
	cur.ProbeNotes = res.ProbeNotes
	cur.ProbeSafe = res.ProbeSafe
	cur.ProbeWarnings = res.ProbeWarnings
	cur.ProbeOutput = ""
	cur.ProbeImages = nil
	cur.ProbeIssue = nil
	cur.ManualState = ""
	cur.Drift = res.Drift
	cur.Steps = res.Steps
	cur.RestorationAlerts = nil
	cur.Traces = map[string]rehearsalTrace{"create": res.Trace}
	cur.UpdatedAt = nowStamp()
	err = s.saveRehearsal(cur)
	rehearsalMu.Unlock()
	if err != nil {
		failRehearsalResp(s, w, ev, 500, tr(lang, "保存演练会话失败", "Failed to save refined rehearsal"))
		return
	}
	// Clean up removed old goal/probe image files no longer referenced by cur.
	keepSet := map[string]bool{}
	for _, n := range finalImgs {
		keepSet[n] = true
	}
	for _, old := range oldImgs {
		if old != "" && !keepSet[old] && reRehearsalImg.MatchString(old) {
			_ = os.Remove(filepath.Join(s.rehearsalImgDir(f.ID, rid), filepath.Base(old)))
		}
	}
	s.auditReq(r, "rehearsal-refine", session.User, f.ID+" "+rid+" "+cur.Mode)
	finishRehearsalResp(w, ev, 200, cur)
}

func normalizeScopeQuestions(in []rehearsalScopeQuestion) []rehearsalScopeQuestion {
	return normalizeScopeQuestionsLang(in, "zh-CN")
}

func normalizeScopeQuestionsLang(in []rehearsalScopeQuestion, lang string) []rehearsalScopeQuestion {
	var out []rehearsalScopeQuestion
	for i, q := range in {
		if i >= 4 {
			break
		}
		qt := strings.TrimSpace(q.Question)
		if qt == "" {
			continue
		}
		id := strings.TrimSpace(q.ID)
		if id == "" {
			id = fmt.Sprintf("q%d", len(out)+1)
		}
		var opts []string
		for j, o := range q.Options {
			if j >= 4 {
				break
			}
			if ot := strings.TrimSpace(o); ot != "" {
				opts = append(opts, truncRunes(ot, 80))
			}
		}
		out = append(out, rehearsalScopeQuestion{
			ID:       id,
			Label:    truncRunes(strings.TrimSpace(q.Label), 16),
			Question: truncRunes(qt, 200),
			Options:  opts,
			Answer:   strings.TrimSpace(q.Answer),
		})
	}
	if len(out) == 0 {
		out = []rehearsalScopeQuestion{
			{
				ID:       "q1",
				Label:    tr(lang, "窗口与闪断", "Window & Impact"),
				Question: tr(lang, "本次生产变更可接受的维护窗口与业务闪断要求？", "What maintenance window and brief interruption policy apply to this production change?"),
				Options: []string{
					tr(lang, "低峰期滚动变更，控制在秒级闪断", "Off-peak rolling change within sub-second failover"),
					tr(lang, "计划停机窗口执行，允许短暂中断", "Scheduled maintenance window; brief downtime acceptable"),
					tr(lang, "必须零停机在线操作，不触发切主", "Zero-downtime online change without primary switchover"),
				},
			},
			{
				ID:       "q2",
				Label:    tr(lang, "离线包就绪", "Artifacts Ready"),
				Question: tr(lang, "离线变更所需的软件包或新增节点是否已在内网就绪？", "Are required offline packages or new nodes already staged in the intranet?"),
				Options: []string{
					tr(lang, "已在内网就绪，可直接校验兼容性", "Staged in intranet; ready to verify compatibility"),
					tr(lang, "尚未完备，需在方案中列出所需清单", "Not staged yet; include artifact checklist in SOP"),
				},
			},
		}
	}
	return out
}

const rehearsalProbeSystem = `你是资深中间件运维与变更专家。请根据「集群初始交付基线」「变更目标」「已确认的变更边界」以及下方注入的平台技能规范，生成一份在生产节点执行的 **100% 纯只读、极简聚焦** Bash 现场状态采集脚本（probe_script）。

核心采集约束（克制聚焦、一屏可截图，严禁发散）：
1. **固定 1～2 行基础身份头（必采，与下游「节点角色与状态」表 5 列强对齐）**：无论本次变更是否涉及升级，脚本开头必须用 1～2 行紧凑输出本机 hostname -s、本机业务 IP、**主组件及关键伴随组件的实测版本号**（如 PostgreSQL server_version + patroni --version、Redis redis-server -v、Nginx nginx -v、HAProxy haproxy -v、Keepalived keepalived -v、etcd etcd --version 等，单行合并输出，绝不遗漏导致下游漂移表出现「待采集」），并输出当前真实主从/集群角色与健康状态；
2. **业务核查项克制聚焦**：除上述基础身份头外，只采本次变更直接涉及的 2～5 个核心参数/配置项/目标目录权限或目标路径磁盘余量。**严禁发散做成大而全的巡检脚本**！与本次变更无关的项（如全量 pg_hba、全量已安装包、全量 sysctl/ss/ps、大段 journalctl 日志、AppArmor/SELinux 冗长输出、无关备份历史等）一律不查。
2. **输出严格控制在 1 屏以内（目标总输出约 15～35 行，适配堡垒机/VDI 单张截图或复制受限环境）**：
   - 脚本本身保持简短清晰（通常 3～5 个核心检查块、总行数尽量不超过 45 行），不要堆砌大段辅助函数或重复样板；
   - 严禁 cat 整份配置文件，严禁无过滤打印长表或大段输出；
   - 查询必须精准裁剪：SQL 用单行/精简查询（如 psql -Atc 只输出本次相关的少数参数），配置文件用 grep -E 精准取行，磁盘只查目标目录（df -h <目标目录>，严禁无过滤打印整机几十个 loop/overlay 挂载点）；
   - 基线中附带的「组件内置巡检参考命令」仅作路径和语法参考，绝不可全盘塞入采集脚本。
3. **规避 ELB / 四层负载均衡回环（Hairpinning）**：
   - 后端数据/中间件节点本机执行探针时，**严禁**从后端节点直接探测/连接指向自身的云 ELB / SLB / LVS VIP（四层负载均衡通常回环不通，会导致超时误判）；
   - 后端节点本机只查本地监听与 127.0.0.1/本机 IP 健康状态；若需验证 ELB/VIP 入口连通性，请在 probe_notes 中注明须在后端集群之外的客户端/跳板机验证，不要写入后端节点采集脚本。

硬性安全红线：
1. 脚本只能包含只读查看命令，并在开头保留 bash 自保护与 set -uo pipefail；
2. 严禁包含任何写入、删除、重启、切换、改配置、装包或写临时文件操作（禁止 rm/mv/cp/mkdir/chmod/chown/sed -i/tee、禁止 systemctl stop|restart|reload、禁止 patronictl switchover|failover|restart|edit-config、禁止 etcdctl put|del|member add|remove、禁止 SQL INSERT|UPDATE|DELETE|ALTER|DROP、禁止重定向写文件；仅允许 2>/dev/null 或 >/dev/null）；
3. 脚本严禁输出任何密码、私钥或凭据内容（读取配置时过滤掉 password/secret/requirepass/masterauth 行）。

请先在 JSON 第一个字段 thinking 中简明说明：本次变更真正必查哪 3～5 个关键事实、刻意省去了哪些无关巡检以保证单屏可读、以及如何确保 100% 纯只读并避开 ELB 回环。
严格只输出一个 JSON 对象：
{"thinking":"1. 本次变更必查关键项（3-5项）...；2. 单屏精简与剔除无关项...；3. 纯只读与避开 ELB 回环...","probe_script":"#!/usr/bin/env bash\nif [ -z \"${BASH_VERSION:-}\" ]; then exec bash \"$0\" \"$@\"; fi\nset -uo pipefail\n...","probe_notes":["使用 bash 执行，输出已控制在约一屏以内，可直接复制或单张截图回传","执行提示2"]}`

func (s *storeServer) submitRehearsalScope(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string) {
	var in struct {
		Answers []struct {
			ID       string `json:"id"`
			Question string `json:"question"`
			Answer   string `json:"answer"`
		} `json:"answers"`
		Extra  string     `json:"extra"`
		Model  string     `json:"model"`
		Effort thinkLevel `json:"effort"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容格式不对")
		return
	}
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	rehearsalMu.Unlock()
	if !ok {
		s.fail(w, 404, "演练会话不存在")
		return
	}
	lang := reqLang(r)
	providers, code, err := s.rehearsalCheckAILang(session.User, false, in.Model, lang)
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}

	ansMap := map[string]string{}
	for _, a := range in.Answers {
		ansMap[a.ID] = truncRunes(strings.TrimSpace(a.Answer), 500)
	}
	answeredCount := 0
	for i := range rh.ScopeQuestions {
		if v, exists := ansMap[rh.ScopeQuestions[i].ID]; exists {
			rh.ScopeQuestions[i].Answer = v
		}
		if strings.TrimSpace(rh.ScopeQuestions[i].Answer) != "" {
			answeredCount++
		}
	}
	rh.ExtraScope = truncRunes(strings.TrimSpace(in.Extra), 2000)

	ev := startRehearsalSSE(w, r)
	inspectStart := time.Now()
	baseline, red := s.clusterBaselinePrompt(f)
	skillBlock, skillTitles := s.rehearsalSkillBlock(session.User, f, rh.Goal, rh.SecurityContext)
	var qa strings.Builder
	for _, q := range rh.ScopeQuestions {
		fmt.Fprintf(&qa, "- 问：%s\n  答：%s\n", q.Question, firstNonEmptyStr(q.Answer, "（未填写，按常规生产保守策略处理）"))
	}
	if rh.ExtraScope != "" {
		fmt.Fprintf(&qa, "- 补充约束：%s\n", rh.ExtraScope)
	}
	pipeSpec := rehearsalPipelineSpec{
		PreSteps: []rehearsalTraceStep{
			{
				ID:     "align-scope",
				Kind:   "inspect",
				Title:  tr(lang, "锁定变更边界与窗口约束", "Lock change scope & window constraints"),
				Detail: tr(lang, fmt.Sprintf("已对齐 %d/%d 项前提条件，按最小必要原则编排单屏只读探针", answeredCount, len(rh.ScopeQuestions)), fmt.Sprintf("Aligned %d/%d prerequisite(s); designing concise single-screen probe", answeredCount, len(rh.ScopeQuestions))) + rehearsalSkillNote(lang, skillTitles),
				MS:     max(1, time.Since(inspectStart).Milliseconds()),
				OK:     true,
				Status: "done",
			},
			{
				ID:     "inject-ro-policy",
				Kind:   "guard",
				Title:  tr(lang, "注入纯只读安全红线规则", "Inject strict read-only safety guardrails"),
				Detail: tr(lang, "锁定零修改、零服务控制、单屏输出收敛及 ELB 回环规避约束", "Enforcing zero mutation, single-screen output cap, and ELB hairpinning guard"),
				MS:     1,
				OK:     true,
				Status: "done",
			},
		},
		ThinkTitle: tr(lang, "设计生产现场纯只读采集策略", "Design read-only live inspection strategy"),
		ThinkWait:  tr(lang, "正在紧扣变更目标筛选最小必要采集项，确保一屏可读…", "Selecting minimal target-focused read-only probes for single-screen capture..."),
		SynthID:    "readonly-ast-guard",
		SynthKind:  "guard",
		SynthTitle: tr(lang, "生成探针与静态安全红线扫描", "Generate probe & run static safety audit"),
		SynthWait:  tr(lang, "等待脚本编写完成后执行 15 类高危写操作静态扫描", "Awaiting script completion to run 15-category write-mutation static checks..."),
		Validate: func(outText string) error {
			var chk struct {
				ProbeScript string `json:"probe_script"`
			}
			if raw := extractJSON(outText); raw != "" {
				_ = json.Unmarshal([]byte(raw), &chk)
			}
			if strings.TrimSpace(chk.ProbeScript) == "" {
				return fmt.Errorf("%s", tr(lang, "模型未能生成有效的只读采集脚本（响应可能被截断或未输出完整 JSON），请重试", "Model did not return a valid read-only probe script (truncated or incomplete JSON); please retry"))
			}
			return nil
		},
	}

	var scopePrompt strings.Builder
	fmt.Fprintf(&scopePrompt, "【集群初始交付基线】\n%s%s\n\n【变更目标】\n%s\n", baseline, securityContextPrompt(rh.SecurityContext, "scope"), rh.Goal)
	if sum := strings.TrimSpace(rh.ScopeSummary); sum != "" && sum != strings.TrimSpace(rh.Goal) {
		fmt.Fprintf(&scopePrompt, "\n【已识别的变更诉求摘要】\n%s\n", sum)
	}
	fmt.Fprintf(&scopePrompt, "\n【已对齐的边界条件】\n%s", qa.String())
	var goalImgData []string
	if len(rh.GoalImages) > 0 && len(providers) > 0 && providers[0].Vision != "no" {
		for _, name := range rh.GoalImages {
			if d := s.rehearsalImageData(f.ID, rid, name); d != "" {
				goalImgData = append(goalImgData, d)
			}
		}
	}
	text, trace, code, err := s.rehearsalRunAI(r, providers, session.User, f.ID, rid+"/scope", "scope", red, rehearsalProbeSystem+skillBlock, scopePrompt.String(), goalImgData, pipeSpec, in.Effort, ev)
	if err != nil {
		failRehearsalResp(s, w, ev, code, err.Error(), aiDiagFromErr(err), trace.Diag)
		return
	}
	scanStart := time.Now()
	var parsed struct {
		Thinking    string   `json:"thinking"`
		ProbeScript string   `json:"probe_script"`
		ProbeNotes  []string `json:"probe_notes"`
	}
	if raw := extractJSON(text); raw != "" {
		_ = json.Unmarshal([]byte(raw), &parsed)
	}
	script := ensureProbeBashGuard(parsed.ProbeScript)
	if script == "" {
		failRehearsalResp(s, w, ev, 502, "模型未能生成有效的只读采集脚本，请重试", trace.Diag)
		return
	}
	safe, warns := validateReadOnlyProbeScriptLang(script, lang)
	if trace.Thinking == "" {
		trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), tr(lang, fmt.Sprintf("已结合已确认的 %d 项边界约束定制 %s 现场只读状态采集脚本，覆盖角色、版本、关键参数与系统资源检查。", answeredCount, f.Current.AppName), fmt.Sprintf("Tailored read-only live probe script for %s against %d confirmed constraint(s), checking roles, versions, key parameters, and host resources.", f.Current.AppName, answeredCount)))
	}
	guardDetail := tr(lang, "已通过 15 类高危写命令、服务控制与文件写入重定向静态扫描（100% 纯只读）", "Passed all 15 static safety checks for mutating commands, service controls, and file write redirects (100% read-only)")
	if !safe {
		guardDetail = tr(lang, fmt.Sprintf("静态扫描发现 %d 项疑似写操作告警，请人工审阅脚本", len(warns)), fmt.Sprintf("Static audit flagged %d potential write warning(s); manual review required", len(warns)))
	}
	finalizeTraceSynth(
		&trace,
		ev,
		"readonly-ast-guard",
		guardDetail,
		safe,
		max(1, time.Since(scanStart).Milliseconds()),
	)

	rehearsalMu.Lock()
	cur, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		failRehearsalResp(s, w, ev, 404, "演练会话不存在")
		return
	}
	cur.ScopeQuestions = rh.ScopeQuestions
	cur.ExtraScope = rh.ExtraScope
	cur.IntentUnclear = false
	cur.ProbeScript = script
	cur.ProbeNotes = cleanStringList(parsed.ProbeNotes, 6, 200)
	cur.ProbeSafe = safe
	cur.ProbeWarnings = warns
	cur.ProbeIssue = nil
	if cur.Traces == nil {
		cur.Traces = map[string]rehearsalTrace{}
	}
	cur.Traces["scope"] = trace
	if cur.Stage == "scoping" {
		cur.Stage = "probing"
	}
	err = s.saveRehearsal(cur)
	rehearsalMu.Unlock()
	if err != nil {
		failRehearsalResp(s, w, ev, 500, "保存演练进度失败")
		return
	}
	s.auditReq(r, "rehearsal-scope", session.User, f.ID+" "+rid)
	finishRehearsalResp(w, ev, 200, cur)
}

const rehearsalPlanSystem = `你是资深中间件变更实施专家。现在你同时拥有「平台首次交付基线」与「生产现场回填的采集输出/手动现状说明/终端截图」。

【第 0 步：硬性采集有效性门禁（必须最先核验，绝不可跳过）】
先严格判断工程师提交的内容是否真正包含有效的生产现场状态证据：
- 如果文本或截图显示**采集脚本执行报错提前退出**（例如 sh 执行 bash 脚本报 Illegal option -o pipefail、语法错误、命令不存在、权限拒绝、只写了“报错了”等），或者**未获取到核心节点角色/服务状态/关键参数的任何有效输出**（且并非工程师直接文字说明了明确的节点主从角色、版本与现状）：
  - **必须阻断！严禁编造全是“未知”的漂移表，严禁强行编排测试演练步骤！**
  - 请将 "probe_status" 设为 "failed"（报错中断）或 "incomplete"（仅采集到残缺信息，不足以判断主从/关键状态），并在 "probe_issue" 中明确给出：
    1. summary：一句话说明为什么阻断（未拿到有效现场结果）
    2. cause：报错或采集失败的准确根因
    3. fix_command：工程师在现场立即可复制执行的正确命令（例如改用 bash /tmp/collect-xxx.sh）
    4. fix_steps：简洁的修复与重新采集步骤（2-4 条）
    5. missing_items：仍缺少哪些关键现场信息
    6. fixed_script：仅当原探针脚本本身有 bug 或兼容性问题时，提供完整的 100% 纯只读修订版脚本（严禁任何写操作、重启、改配置或输出密码）；若只是现场调用方式问题（如用了 sh 而非 bash），fixed_script 可留空或提供带 bash 自保护头的修订版。
  - 阻断格式（不要输出 drift 和 steps）：
    {"thinking":"...","probe_status":"failed","probe_issue":{"summary":"...","cause":"...","fix_command":"...","fix_steps":["..."],"missing_items":["..."],"fixed_script":""}}

【第 1-2 步：仅当确认拿到有效现场状态（probe_status="valid"）时才执行】
1. 漂移诊断（drift）：仔细读取文字回显与附带的终端/监控截图，对比初始交付规格与现场真实状态，明确每台节点的初始角色 vs 当前真实角色（特别是主从是否已切换）、当前版本、被人工修改过的关键参数以及潜在变更风险；
   - **字段简洁规范**：hosts[*].initial_role 与 actual_role 仅写简短角色标签（如「主库」「从库」「Leader」「Quorum Standby」「待核实」，不超过 12 字），详细映射或补充说明放入 status 字段；hosts[*].version 优先填写探针实测的精简版本号（如「17.11」或「17.11 / Patroni 4.1.0」），仅当该节点确实未执行本机探针回传时填「未在本机采集」，**不要**在 status 字段中重复抱怨「截图未提供实际软件版本」；param_diffs 尽量按单个参数拆行，initial/actual 只写简明值，目标策略与风险放入 risk 字段。
2. 生成分步演练清单（steps）：围绕「步骤清晰、每步复制即跑、一看就懂在哪台机器执行」的原则，按以下 4 个阶段生成**精炼聚焦、按复杂度控制步数、输出简短易单屏核验**的步骤（严禁为了凑形式拆成十几步，严禁把命令写得像几十行脚本程序）：
   - **总步数与命令篇幅严格控制**：
     * **轻量在线变更**（如补一条 pg_hba/白名单规则、在线动态调参 reload、补日志目录或轮转规则，无需重启和切主）：总步数严格控制在 **3～4 步**（1 步预检 → 1 步执行与 reload → 1 步验收 → 1 步回退）；
     * **中高风险变更**（需滚动重启、切主、升级、扩缩容、架构或证书改造）：常规变更严格控制在 **5～8 步**（把琐碎的小检查合并，例如日志落盘滚动重启：1 步只读核对现状 → 1 步所有节点建目录 → 1 步修改 DCS 参数 → 1 步滚动重启从库（通过 commands 拆成每台独立的命令框，或拆分为两步） → 1 步切主并重启原主库（切主与重启分框） → 1 步切回原主库恢复初始角色 → 1 步验收日志与入口 → 1 步回退）；
     * **单步命令短小直白 + 堡垒机 WebSSH 整块防吞行铁律**：每步 command 尽量控制在 **1～6 行**原生命令，不要写大段 Bash 控制流或跨节点 SSH for 循环，也不要把多条不相关耗时命令用 ; 硬拼成超过 160 字符的超长单行；凡单框含 **2 条及以上命令**（尤其含 sudo、psql、patronictl、sleep、systemctl 等耗时或读 stdin 的命令），**必须**整块包裹在 ( ... ) </dev/null 子 Shell 中（严禁裸贴多行，严禁用 bash <<'EOF'），防止 JumpServer/WebSSH 及 Ubuntu sudo use_pty 吞掉缓冲区后续行或造成输出交错；单条命令无需包裹。
   - **单框原子复制铁律（严禁多台滚动操作塞进同一个命令复制框！）**：
     * 工程师会直接点击命令框右上角「复制」把整块命令一次粘贴到终端连续执行！
     * 因此**绝对禁止**把多台节点的滚动/破坏性操作（例如同时重启 node-2 与 node-3、连续多次 systemctl restart/stop/reload、计划内 switchover 紧接重启原主库、先看 diff 确认再 apply 等中间必须人工确认健康后再推进的命令）写进同一个 command 字符串里！
     * 遇到这类必须「做完一段 → 确认恢复健康/无报错 → 再做下一段」的操作，**必须二选一**：
       1) 在本步骤中填写 **commands 数组**，按节点或阶段拆成多个**独立可复制的子命令框**（每段含 label、command、可选 target_role 以及段间 gate 暂停核验提示，例如先重启 node-2 + patronictl list 为第 1 框，gate 写明确认 node-2 恢复 streaming 且 Lag=0 后再执行第 2 框重启 node-3 + patronictl list）；
       2) 或直接拆成独立的步骤（如「重启从库 node-2」「重启从库 node-3」）。
     * 当提供了多段 commands 时，每段仍保持 1～4 行简洁直白；单段简单步骤无需填 commands，只填 command 即可。
   - **变更临时状态复位与现场收尾铁律（做了什么临时改动，就必须原样弄回来！）**：
     * 凡是为了配合变更、降低风险或做验收而临时引入的任何状态改动，**都必须在正向流程的收尾/验收阶段安排显式的「复位/恢复/清理」步骤把它还原**（除非用户在诉求或边界对齐里明确要求保留新状态），绝不能改完不管，也绝不能只藏在应急回退（rollback）里！生成步骤前必须逐项自查以下 6 类临时改动，只要前序步骤涉及其中任意一项，就必须在后续正向步骤配齐对应恢复命令：
       1) **主从角色复位（切回原主库）与 VIP 归位**：只要目标不是刻意永久迁主，而是为滚动重启、升级或补丁做了计划内切主（Patroni switchover、Redis SENTINEL FAILOVER、MySQL 切主或 Keepalived 降权漂移 VIP），在原主重启追平（streaming、Lag=0）后，必须显式安排一步「切回原主库（如 node-2 → node-1）恢复变更前主从角色/VIP」放在最终验收之前（risk_note 可注明：若维护窗口紧张不希望二次短暂闪断，可点击跳过保留新主）；
       2) **维护模式与高可用保护开关复位**：如执行过 patronictl pause（维护模式）、临时关闭自动故障转移或监控静默，变更完成后必须显式执行 patronictl resume 并确认退出维护模式；
       3) **负载均衡临时摘流/降权复位**：如执行过 HAProxy set server ... state maint/drain、Nginx 临时加 down/注释/调低 upstream 权重或 ELB 临时摘除后端，完成后必须恢复 ready / 原权重并 reload 生效；
       4) **同步复制/调试日志/安全限流临时放宽复位**：如变更期间临时关闭 synchronous_mode、临时调低 synchronous_node_count / min-replicas-to-write、临时开启 log_statement=all / debug 日志或临时放宽 pg_hba/防火墙，完成后必须恢复变更前严格策略与正常日志级别；
       5) **定时任务与后台服务暂停复位**：如变更前临时停止了 cron、systemd timer、备份/归档任务或同步消费服务，验收前必须重新启动并确认状态 active；
       6) **临时测试对象与残留文件清理**：如验收时创建的临时测试库/表/写入记录、Redis 临时测试 Key、临时诊断账号/权限、/tmp 下的临时采集脚本或 .bak/.tmp 文件，验收后必须显式清理干净。
   - **每步必须独立可复制执行（严禁跨步骤隐藏变量与交互式 read）**：
     * **绝对禁止**使用 read -r -p 让运维手填一串变量，**绝对禁止** export CFG/SCOPE/OLD/R1/R2 或 source /tmp/env 这类跨步骤隐藏变量！
     * **绝对禁止**在标题、target_role 或命令里出现令人困惑的内部代号（如 OLD、R1、R2、OLD_PRIMARY、TARGET_A），一律使用运维一眼能看懂的直白中文表述（如「当前主库（如 node-1）」「当前从库（先 node-2 再 node-3）」）；
     * 直接使用交付基线里的真实配置路径与服务名（如 /etc/patroni/patroni.yml、postgres:postgres）；仅在需按实际环境替换节点名时使用清晰中文占位符（如 <当前主库节点名>）。
   - **执行机器（target_role）必须一目了然、毫不含糊**：
     * 写清本步究竟要 SSH 登录哪一类/哪几台机器执行，例如：「所有数据节点（node-1 / node-2 / node-3，逐台登录执行）」「任一数据库节点（如当前主库 node-1，修改共享 DCS）」「当前从库（先 node-2 再 node-3，逐台滚动重启）」「当前主库（如 node-1，切主后重启）」「集群外客户端/跳板机，或非当前主库的从库节点（如 node-2 / node-3）」。
     * 严禁把“控制机 + 三台节点”混写在同一句里让人不知该登哪台，也不要假设存在免密 ssh 控制机或一定存在集群外的独立第 4 台跳板机。
   - precheck（变更前预检：核对当前主从角色、复制同步状态、本次变更直接相关的配置与前置条件）
   - execute（核心变更执行：严格遵循高可用滚动顺序，先备后主、计划内平滑切主，并在原主重启追平后切回原主库恢复初始角色）
   - verify（变更后验收：服务状态、目标参数/版本生效、数据复制恢复、入口连通性验证）
   - rollback（回退预案：一旦演练或生产执行受阻时的明确回退步骤与命令）
   - **ELB / 四层负载均衡入口验证（贴合现场，严禁强求不存在的独立主机）**：
     * 后端主库本机直连指向自身的云 ELB / SLB / LVS VIP 可能发生回环超时，因此测试写入入口时 target_role 应写为「集群外客户端/跳板机；若无独立主机，请在非当前主库的从库节点（如主库为 node-1 时在 node-2 或 node-3）执行」（从非主库连接写入 VIP 会路由到不同机器的主库，通常可避开同机回环），并将该入口验收步设为 optional: true（或在 risk_note 注明：若云 ELB 策略禁止所有后端节点访问自身 VIP 导致超时，可跳过此步，以各节点本机 Patroni /primary 健康状态及业务端验证为准）。绝不要把无独立跳板机的现场卡死！

请先在 JSON 第一个字段 thinking 中写出你的采集有效性判定、漂移比对发现（若有效）或报错根因（若失败）。
严格只输出一个 JSON 对象，有效时格式如下：
{
  "thinking": "1. 现场证据有效性判定...；2. 拓扑与参数比对结论...；3. 高可用滚动演练顺序设计...",
  "probe_status": "valid",
  "drift": {
    "summary": "漂移诊断结论摘要",
    "drifted": true,
    "hosts": [{"name":"节点名","ip":"节点IP","initial_role":"初始角色","actual_role":"现场当前角色","version":"当前版本","status":"运行状态"}],
    "param_diffs": [{"key":"参数名","initial":"初始值","actual":"现场值","risk":"影响说明"}],
    "risks": ["风险点1"],
    "recommendations": ["建议1"]
  },
  "steps": [
    {
      "id": "s1",
      "phase": "precheck|execute|verify|rollback",
      "order": 1,
      "title": "步骤标题",
      "target_role": "执行目标（如：当前从库 node-01 / 10.0.1.11）",
      "command": "单段步骤时直接填写具体执行的 shell/SQL 命令；多段滚动步骤可留空或写摘要并改用下方 commands 数组",
      "commands": [{"label":"第 1 段 · 重启从库 node-2","command":"单台执行与立即状态检查命令","gate":"确认 node-2 回到 streaming、Lag=0 后再执行下一段"}],
      "expect": "明确的预期输出与成功判据",
      "risk_note": "风险与注意事项",
      "rollback": "本步异常时的即时回退命令（无则留空）",
      "optional": false
    }
  ]
}`

const rehearsalProbeDiagnoseSystem = `你是资深 Linux 与中间件现场排障专家。工程师在生产节点执行只读采集探针脚本时遇到报错或未能采集到完整结果。
你的唯一任务是：**诊断探针执行失败的根因，并给出立即可用的修复命令或修订版 100% 纯只读脚本**，帮助工程师顺利拿到真实生产状态。
严禁编造现场漂移表，严禁编排变更演练步骤。
修订脚本硬性红线：
1. 100% 纯只读（禁止 rm/mv/cp/mkdir/chmod/chown/sed -i/tee、禁止 systemctl start|stop|restart|reload、禁止 patronictl/etcdctl/redis-cli/pg_ctl 写或切换动作、禁止 SQL 写语句、禁止写文件重定向、禁止输出密码或密钥），并在脚本开头包含 bash 自保护（if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi）；
2. **极简聚焦、一屏可截图**：只保留与本次变更直接相关的 3～5 项关键查询，输出控制在约 15～35 行以内，严禁发散或整份输出配置/长列表；
3. **避开 ELB 回环**：禁止在后端节点脚本中直连指向自身的云 ELB / SLB / LVS VIP。

严格只输出一个 JSON 对象：
{
  "thinking": "报错根因分析与纯只读修订思路...",
  "probe_status": "failed",
  "probe_issue": {
    "summary": "一句话总结失败原因",
    "cause": "详细根因说明",
    "fix_command": "现场直接可执行的修复/重跑命令（例如 bash /tmp/collect-xxx.sh）",
    "fix_steps": ["步骤1", "步骤2"],
    "missing_items": ["仍需采集的关键项1"],
    "fixed_script": "若需要修订原探针脚本，给出完整的新版纯只读脚本；若仅需调整调用方式可留空"
  }
}`

func (s *storeServer) submitRehearsalProbe(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string) {
	var in struct {
		ProbeOutput string     `json:"probe_output"`
		ManualState string     `json:"manual_state"`
		TestEnvNote string     `json:"test_env_note"`
		Images      []string   `json:"images"`
		Mode        string     `json:"mode"` // "" | "analyze" | "diagnose"
		Model       string     `json:"model"`
		Effort      thinkLevel `json:"effort"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 30<<20)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容格式不对或超过大小限制")
		return
	}
	diagnoseOnly := strings.EqualFold(strings.TrimSpace(in.Mode), "diagnose")
	probeOut := aiScrub(truncRunes(strings.TrimSpace(in.ProbeOutput), 24000))
	manual := aiScrub(truncRunes(strings.TrimSpace(in.ManualState), 8000))
	testEnv := truncRunes(strings.TrimSpace(in.TestEnvNote), 1000)
	if probeOut == "" && manual == "" && len(in.Images) == 0 {
		s.fail(w, 400, "请粘贴现场采集回显、上传/粘贴终端截图，或手动填写生产集群当前状态说明")
		return
	}
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	rehearsalMu.Unlock()
	if !ok {
		s.fail(w, 404, "演练会话不存在")
		return
	}
	lang := reqLang(r)
	providers, code, err := s.rehearsalCheckAILang(session.User, len(in.Images) > 0, in.Model, lang)
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}
	imgNames, err := s.storeRehearsalImages(f.ID, rid, in.Images)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}

	ev := startRehearsalSSE(w, r)
	baseline, red := s.clusterBaselinePrompt(f)
	var prompt strings.Builder
	fmt.Fprintf(&prompt, "【集群初始交付基线】\n%s\n\n【变更目标】\n%s\n", baseline, rh.Goal)
	if sum := strings.TrimSpace(rh.ScopeSummary); sum != "" && sum != strings.TrimSpace(rh.Goal) {
		fmt.Fprintf(&prompt, "\n【已确认的变更诉求摘要】\n%s\n", sum)
	}
	if rh.Mode == "light" {
		prompt.WriteString("\n【当前推演档位：简单推演（light）】\n本次为轻量级推演：如确认现场状态有效且无高风险漂移，请严格将步骤精简控制在 3～5 步（1 步预检现状 → 1～2 步执行与 reload → 1 步验收 → 1 步回退）；若现场回显暴露出需要重启服务、切主或严重漂移的高风险问题，请在 drift.risks 中明确提示风险并建议升级为全量推演。\n")
	}
	for _, q := range rh.ScopeQuestions {
		if q.Answer != "" {
			fmt.Fprintf(&prompt, "- %s：%s\n", q.Question, q.Answer)
		}
	}
	if rh.ExtraScope != "" {
		fmt.Fprintf(&prompt, "- 补充约束：%s\n", rh.ExtraScope)
	}
	if scPrompt := securityContextPrompt(rh.SecurityContext, "probe"); scPrompt != "" {
		prompt.WriteString(scPrompt)
	}
	if bp := s.rehearsalSourceBlueprintPrompt(rh); bp != "" && !diagnoseOnly {
		prompt.WriteString(bp)
	}
	if rh.ProbeScript != "" && (diagnoseOnly || len(probeOut) < 400 || len(imgNames) > 0) {
		fmt.Fprintf(&prompt, "\n【当前只读探针脚本（前 4000 字符）】\n%s\n", truncRunes(rh.ProbeScript, 4000))
	}
	if probeOut != "" {
		if diagnoseOnly {
			fmt.Fprintf(&prompt, "\n【探针执行报错输出（已脱敏）】\n%s\n", probeOut)
		} else {
			fmt.Fprintf(&prompt, "\n【生产现场探针回显或工程师现状说明（已脱敏）】\n%s\n", probeOut)
		}
	}
	if manual != "" {
		fmt.Fprintf(&prompt, "\n【工程师手动声明的现场现状】\n%s\n", manual)
	}
	if len(imgNames) > 0 {
		if diagnoseOnly {
			fmt.Fprintf(&prompt, "\n【附带探针报错截图】共 %d 张，请结合报错信息诊断根因并给出修复命令或修订版纯只读脚本。\n", len(imgNames))
		} else {
			fmt.Fprintf(&prompt, "\n【附带现场终端/状态截图】共 %d 张，请先核验截图是否为有效采集输出；若是脚本报错截图则触发门禁阻断并给出修复指引，只有确认拿到有效现场状态后才进行漂移比对。\n", len(imgNames))
		}
	}
	if testEnv != "" {
		fmt.Fprintf(&prompt, "\n【测试演练环境说明】\n%s\n", aiScrub(testEnv))
	}

	var evidenceParts []string
	if probeOut != "" {
		lines := strings.Count(probeOut, "\n") + 1
		evidenceParts = append(evidenceParts, tr(lang, fmt.Sprintf("回显文本 %d 行", lines), fmt.Sprintf("%d line(s) of output", lines)))
	}
	if len(imgNames) > 0 {
		evidenceParts = append(evidenceParts, tr(lang, fmt.Sprintf("现场截图 %d 张", len(imgNames)), fmt.Sprintf("%d screenshot(s)", len(imgNames))))
	}
	if manual != "" {
		evidenceParts = append(evidenceParts, tr(lang, "人工现状说明", "Manual status notes"))
	}

	sysPrompt := rehearsalPlanSystem
	thinkTitle := tr(lang, "核验采集有效性并比对现场漂移", "Verify probe validity & compare live drift")
	thinkWait := tr(lang, "正在校验采集结果是否完整，再逐台比对交付基线与生产现场状态…", "Verifying probe completeness before comparing baseline against live state...")
	synthTitle := tr(lang, "校验门禁与生成演练方案", "Validate gate & synthesize rehearsal plan")
	synthWait := tr(lang, "采集有效则编排演练步骤；若探针报错或缺失则阻断并输出修复指引", "Planning steps if probe succeeded, or blocking with fix guidance if probe failed")
	if diagnoseOnly {
		sysPrompt = rehearsalProbeDiagnoseSystem
		thinkTitle = tr(lang, "诊断只读探针报错根因", "Diagnose read-only probe error")
		thinkWait = tr(lang, "正在结合终端报错与探针脚本定位兼容性或权限问题…", "Analyzing terminal error and probe script compatibility...")
		synthTitle = tr(lang, "生成探针修复指引与只读校验", "Generate probe fix & read-only audit")
		synthWait = tr(lang, "等待根因分析完成后输出修复命令或修订版纯只读脚本", "Preparing fix commands or revised read-only script...")
	}
	skillBlock, skillTitles := s.rehearsalSkillBlock(session.User, f, rh.Goal, rh.SecurityContext)

	pipeSpec := rehearsalPipelineSpec{
		PreSteps: []rehearsalTraceStep{
			{
				ID:     "parse-probe",
				Kind:   "inspect",
				Title:  tr(lang, "解析现场回显与交付基线", "Parse submitted evidence & baseline"),
				Detail: strings.Join(evidenceParts, " · ") + rehearsalSkillNote(lang, skillTitles),
				MS:     1,
				OK:     true,
				Status: "done",
			},
			{
				ID:     "scrub-probe",
				Kind:   "guard",
				Title:  tr(lang, "敏感凭据二次脱敏", "Scrub credentials from evidence"),
				Detail: tr(lang, "自动擦除回显中的口令、密钥与连接串", "Automatically wiped passwords, keys, and connection strings"),
				MS:     1,
				OK:     true,
				Status: "done",
			},
		},
		ThinkTitle: thinkTitle,
		ThinkWait:  thinkWait,
		SynthID:    "build-rehearsal-plan",
		SynthKind:  "synthesize",
		SynthTitle: synthTitle,
		SynthWait:  synthWait,
		Validate: func(outText string) error {
			var chk struct {
				ProbeStatus string               `json:"probe_status"`
				ProbeIssue  *rehearsalProbeIssue `json:"probe_issue"`
				Steps       []rehearsalStep      `json:"steps"`
			}
			if raw := extractJSON(outText); raw != "" {
				_ = json.Unmarshal([]byte(raw), &chk)
			}
			st := strings.ToLower(strings.TrimSpace(chk.ProbeStatus))
			if diagnoseOnly || st == "failed" || st == "incomplete" {
				if chk.ProbeIssue != nil && (strings.TrimSpace(chk.ProbeIssue.Summary) != "" || strings.TrimSpace(chk.ProbeIssue.Cause) != "") {
					return nil
				}
				return fmt.Errorf("%s", tr(lang, "模型未能输出有效的探针报错诊断结果，请重试", "Model failed to return valid probe diagnosis; please retry"))
			}
			if len(normalizeRehearsalStepsLang(chk.Steps, lang)) == 0 {
				return fmt.Errorf("%s", tr(lang, "模型未能生成有效的测试演练步骤（响应可能被截断或未输出完整 JSON），请重试", "Model failed to return valid staging rehearsal steps (truncated or incomplete JSON); please retry"))
			}
			return nil
		},
	}

	text, trace, code, err := s.rehearsalRunAI(r, providers, session.User, f.ID, rid+"/probe", "probe", red, sysPrompt+skillBlock, prompt.String(), in.Images, pipeSpec, in.Effort, ev)
	if err != nil {
		failRehearsalResp(s, w, ev, code, err.Error(), aiDiagFromErr(err), trace.Diag)
		return
	}
	parseStart := time.Now()
	var parsed struct {
		Thinking    string               `json:"thinking"`
		ProbeStatus string               `json:"probe_status"`
		ProbeIssue  *rehearsalProbeIssue `json:"probe_issue"`
		Drift       *rehearsalDrift      `json:"drift"`
		Steps       []rehearsalStep      `json:"steps"`
	}
	if raw := extractJSON(text); raw != "" {
		_ = json.Unmarshal([]byte(raw), &parsed)
	}
	pStatus := strings.ToLower(strings.TrimSpace(parsed.ProbeStatus))
	// Defensive gate: even if the model omits probe_status="failed", never accept a fake drift table where every host role is unknown.
	if !diagnoseOnly && pStatus != "failed" && pStatus != "incomplete" && parsed.Drift != nil && len(parsed.Drift.Hosts) > 0 {
		allUnknown := true
		for _, h := range parsed.Drift.Hosts {
			role := strings.ToLower(strings.TrimSpace(h.ActualRole))
			if role != "" && !strings.Contains(role, "未知") && !strings.Contains(role, "unknown") && !strings.Contains(role, "未采集") && !strings.Contains(role, "未获取") {
				allUnknown = false
				break
			}
		}
		if allUnknown && manual == "" {
			pStatus = "failed"
			if parsed.ProbeIssue == nil {
				parsed.ProbeIssue = &rehearsalProbeIssue{
					Status:       "failed",
					Summary:      firstNonEmptyStr(strings.TrimSpace(parsed.Drift.Summary), tr(lang, "未采集到有效的生产节点真实状态，已阻断进入漂移分析", "Failed to collect live node roles; blocked before drift analysis")),
					Cause:        tr(lang, "所有目标节点的现场角色与状态均为未知，无法进行可靠的基线漂移比对。", "All node roles/states remained unknown; cannot perform reliable drift comparison."),
					FixSteps:     parsed.Drift.Recommendations,
					MissingItems: []string{tr(lang, "各节点真实主从角色与运行状态", "Live primary/replica roles and status per node")},
				}
			}
		}
	}
	if diagnoseOnly || pStatus == "failed" || pStatus == "incomplete" {
		issue := parsed.ProbeIssue
		if issue == nil {
			issue = &rehearsalProbeIssue{
				Status:  "failed",
				Summary: tr(lang, "现场探针未成功采集到有效数据，已阻断进入漂移分析", "Probe failed to collect valid live data; blocked from drift analysis"),
			}
		}
		if issue.Status != "incomplete" {
			issue.Status = "failed"
		}
		issue.Summary = strings.TrimSpace(issue.Summary)
		issue.Cause = strings.TrimSpace(issue.Cause)
		issue.FixCommand = strings.TrimSpace(issue.FixCommand)
		issue.FixSteps = cleanStringList(issue.FixSteps, 6, 300)
		issue.MissingItems = cleanStringList(issue.MissingItems, 8, 200)
		issue.At = nowStamp()

		fixedScript := ensureProbeBashGuard(issue.FixedScript)
		issue.FixedScript = fixedScript
		scriptUpdated := false
		if fixedScript != "" {
			safe, warns := validateReadOnlyProbeScriptLang(fixedScript, lang)
			issue.FixedSafe = safe
			issue.FixedWarnings = warns
			if safe {
				scriptUpdated = true
				issue.ScriptUpdated = true
			}
		}
		if trace.Thinking == "" {
			trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), issue.Cause, issue.Summary)
		}
		synthMsg := tr(lang,
			"采集未拿到有效现场结果 · 已阻断进入漂移比对，请按修复指引重新采集",
			"No valid live probe result · Blocked before drift analysis; follow fix guidance and re-run",
		)
		if scriptUpdated {
			synthMsg = tr(lang,
				"已定位报错并自动更新纯只读探针脚本 · 请重新采集后再核对漂移",
				"Diagnosed error & updated read-only probe script · Re-run probe before drift analysis",
			)
		}
		finalizeTraceSynth(
			&trace,
			ev,
			"build-rehearsal-plan",
			synthMsg,
			false,
			max(1, time.Since(parseStart).Milliseconds()),
		)

		rehearsalMu.Lock()
		cur, ok := s.loadRehearsal(f.ID, rid)
		if !ok {
			rehearsalMu.Unlock()
			failRehearsalResp(s, w, ev, 404, "演练会话不存在")
			return
		}
		cur.ProbeOutput = probeOut
		if len(imgNames) > 0 {
			cur.ProbeImages = imgNames
		}
		cur.ManualState = manual
		cur.TestEnvNote = testEnv
		cur.ProbeIssue = issue
		if scriptUpdated {
			cur.ProbeScript = fixedScript
			cur.ProbeSafe = issue.FixedSafe
			cur.ProbeWarnings = issue.FixedWarnings
		}
		if cur.Traces == nil {
			cur.Traces = map[string]rehearsalTrace{}
		}
		cur.Traces["probe"] = trace
		// Gate enforced: clear any unverified drift/steps and stay in probing stage until valid live output is obtained.
		if cur.Stage != "finalized" {
			cur.Drift = nil
			cur.Steps = nil
			cur.Stage = "probing"
		}
		err = s.saveRehearsal(cur)
		rehearsalMu.Unlock()
		if err != nil {
			failRehearsalResp(s, w, ev, 500, "保存诊断结果失败")
			return
		}
		s.auditReq(r, "rehearsal-probe-blocked", session.User, f.ID+" "+rid)
		finishRehearsalResp(w, ev, 200, cur)
		return
	}

	steps := normalizeRehearsalStepsLang(parsed.Steps, lang)
	if len(steps) == 0 {
		failRehearsalResp(s, w, ev, 502, "模型未能生成有效的测试演练步骤，请检查回显或截图内容后重试", trace.Diag)
		return
	}
	drift := parsed.Drift
	if drift == nil {
		drift = &rehearsalDrift{Summary: tr(lang, "已依据录入的现场信息生成测试环境演练步骤", "Generated staging rehearsal steps from provided live state information"), Hosts: []rehearsalDriftHost{}}
	}
	if drift.Hosts == nil {
		drift.Hosts = []rehearsalDriftHost{}
	}
	if trace.Thinking == "" {
		trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), drift.Summary)
	}
	finalizeTraceSynth(
		&trace,
		ev,
		"build-rehearsal-plan",
		fmt.Sprintf("%s · %s", map[bool]string{
			true:  tr(lang, "识别到现场漂移", "Live drift detected"),
			false: tr(lang, "拓扑与基线一致", "Matches baseline topology"),
		}[drift.Drifted], tr(lang, fmt.Sprintf("生成 %d 个可验证演练步骤", len(steps)), fmt.Sprintf("Generated %d verifiable rehearsal step(s)", len(steps)))),
		true,
		max(1, time.Since(parseStart).Milliseconds()),
	)

	rehearsalMu.Lock()
	cur, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		failRehearsalResp(s, w, ev, 404, "演练会话不存在")
		return
	}
	cur.ProbeOutput = probeOut
	if len(imgNames) > 0 {
		cur.ProbeImages = imgNames
	}
	cur.ManualState = manual
	cur.TestEnvNote = testEnv
	cur.ProbeIssue = nil
	cur.Drift = drift
	cur.Steps = steps
	if cur.Traces == nil {
		cur.Traces = map[string]rehearsalTrace{}
	}
	cur.Traces["probe"] = trace
	cur.Stage = "rehearsing"
	err = s.saveRehearsal(cur)
	rehearsalMu.Unlock()
	if err != nil {
		failRehearsalResp(s, w, ev, 500, "保存演练步骤失败")
		return
	}
	s.auditReq(r, "rehearsal-probe", session.User, f.ID+" "+rid)
	finishRehearsalResp(w, ev, 200, cur)
}

var (
	reRollingActionLine = regexp.MustCompile(`(?i)\b(patronictl\b[^\n]*\b(restart|reinit|reload|switchover|failover|pause|resume)\b|systemctl\b[^\n]*\b(restart|stop|reload)\b|service\s+\S+\s+(restart|stop|reload)\b|pg_ctl\b[^\n]*\b(restart|stop|promote|reload)\b|redis-cli\b[^\n]*\b(failover|shutdown|replicaof|slaveof)\b|etcdctl\b[^\n]*\b(move-leader|member\s+(remove|add|replace))\b|set\s+server\s+\S+\s+state\s+(maint|drain|ready)\b|nginx\s+-s\s+(reload|stop)\b|repmgr\b[^\n]*\b(switchover|promote|follow)\b)`)
	reSystemctlDaemon   = regexp.MustCompile(`(?i)\bsystemctl\b[^\n]*\bdaemon-reload\b`)
	rePatroniMemberNode = regexp.MustCompile(`(?i)\bpatronictl\b[^\n]*\b(?:restart|reinit|reload)\s+(?:-[^\s]+\s+\S+\s+)*[^\s-]+\s+([a-zA-Z0-9][a-zA-Z0-9._-]{1,40})\b`)
	reNodeNameHint      = regexp.MustCompile(`\b((?:node|pg|db|etcd|redis|master|primary|standby|replica|host|srv|vm)[-_]?[0-9]{1,3}|[0-9]{1,3}(?:\.[0-9]{1,3}){3})\b`)
	reHeredocStart      = regexp.MustCompile(`<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?`)
	reShellBlockOpen    = regexp.MustCompile(`(?i)(?:^|[;&|]\s*)(if|for|while|until|case)\b`)
	reShellBlockClose   = regexp.MustCompile(`(?i)(?:^|[;&|]\s*)(fi|done|esac)\b`)
)

func isRollingActionCommandLine(trimmed string) bool {
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return false
	}
	if reSystemctlDaemon.MatchString(trimmed) && !regexp.MustCompile(`(?i)\bsystemctl\b[^\n]*\b(restart|stop)\b`).MatchString(trimmed) {
		return false
	}
	return reRollingActionLine.MatchString(trimmed)
}

func extractRollingSegmentHint(lines []string) string {
	for _, raw := range lines {
		t := strings.TrimSpace(raw)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		if m := rePatroniMemberNode.FindStringSubmatch(t); len(m) >= 2 {
			tok := strings.TrimSpace(m[1])
			if tok != "" && !strings.HasPrefix(tok, "-") {
				return tok
			}
		}
		if isRollingActionCommandLine(t) {
			low := strings.ToLower(t)
			if strings.Contains(low, "switchover") || strings.Contains(low, "failover") {
				return "switchover"
			}
			if m := reNodeNameHint.FindStringSubmatch(t); len(m) >= 2 {
				return m[1]
			}
		}
	}
	for _, raw := range lines {
		t := strings.TrimSpace(raw)
		if strings.HasPrefix(t, "#") {
			c := strings.TrimSpace(strings.TrimLeft(t, "#"))
			if c != "" {
				return truncRunes(c, 28)
			}
		}
	}
	return ""
}

// splitSequentialRollingCommands detects when multiple rolling/disruptive commands
// (e.g. restarting node-2 and node-3, or switchover followed by restarting the old primary)
// are packed inside a single copyable block, and splits them into separate copyable
// sub-commands with an explicit pause-and-verify gate between them.
var (
	reInteractiveTTYCmd      = regexp.MustCompile(`(?m)(^|[;&|]\s*)(vi|vim|nano|less|more|top|htop|passwd|tmux|screen)\b|\b(su\s+-|sudo\s+-i|sudo\s+su)\b`)
	reInteractivePatroniEdit = regexp.MustCompile(`(?i)\bpatronictl\b[^\n]*\bedit-config\b`)
	rePatroniNonInteractive  = regexp.MustCompile(`(?i)(--force|\s-[ps]\s|--set\b|--replace\b)`)
	reCloseSubshellLine      = regexp.MustCompile(`^\)\s*(<\s*/dev/null\s*)?(2>&1\s*)?$`)
	reCloseBraceLine         = regexp.MustCompile(`^\}\s*(<\s*/dev/null\s*)?(2>&1\s*)?$`)
)

func shellNeedsInteractiveTTY(s string) bool {
	if reInteractiveTTYCmd.MatchString(s) {
		return true
	}
	for _, line := range strings.Split(s, "\n") {
		if reInteractivePatroniEdit.MatchString(line) && !rePatroniNonInteractive.MatchString(line) {
			return true
		}
	}
	return false
}

// unwrapOuterPasteGroup strips a single top-level (\n...\n) [</dev/null] or {\n...\n} [</dev/null]
// wrapper if present so structural helpers like splitSequentialRollingCommands inspect inner lines.
func unwrapOuterPasteGroup(cmd string) string {
	s := strings.TrimSpace(strings.ReplaceAll(cmd, "\r\n", "\n"))
	lines := strings.Split(s, "\n")
	if len(lines) < 3 {
		return s
	}
	first := strings.TrimSpace(lines[0])
	last := strings.TrimSpace(lines[len(lines)-1])
	if (first == "(" && reCloseSubshellLine.MatchString(last)) || (first == "{" && reCloseBraceLine.MatchString(last)) {
		return strings.TrimSpace(strings.Join(lines[1:len(lines)-1], "\n"))
	}
	return s
}

func countLogicalShellCommands(s string) int {
	lines := strings.Split(s, "\n")
	logical := 0
	heredocEnd := ""
	blockDepth := 0
	prevCont := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if heredocEnd != "" {
			if trimmed == heredocEnd {
				heredocEnd = ""
			}
			continue
		}
		if trimmed == "" || (!prevCont && strings.HasPrefix(trimmed, "#")) {
			prevCont = false
			continue
		}
		if !prevCont && blockDepth == 0 {
			logical++
		}
		if m := reHeredocStart.FindStringSubmatch(trimmed); len(m) >= 2 {
			heredocEnd = m[1]
		}
		if reShellBlockOpen.MatchString(trimmed) && !reShellBlockClose.MatchString(trimmed) {
			blockDepth++
		} else if reShellBlockClose.MatchString(trimmed) && blockDepth > 0 {
			blockDepth--
		}
		prevCont = strings.HasSuffix(strings.TrimRight(line, " \t"), `\`)
	}
	return logical
}

// ensurePasteSafeShellCommand wraps multi-command shell blocks in a POSIX subshell with stdin
// redirected from /dev/null:
//
//	(
//	cmd1
//	cmd2
//	) </dev/null
//
// In bastion / WebSSH terminals (e.g. JumpServer) and Ubuntu hosts with `Defaults use_pty` in sudoers,
// pasting bare multi-line commands causes slow CLIs or `sudo` to drain the PTY buffer and swallow
// subsequent lines (`sleep`, `patronictl list`, `df -h`, etc.) or interleave output mid-paste.
// Wrapping in `(...) </dev/null` forces interactive bash to parse ALL lines before running line 1,
// isolates `exit`/`cd`, and prevents child commands from reading or flushing terminal stdin.
func ensurePasteSafeShellCommand(cmd string) string {
	s := strings.TrimSpace(strings.ReplaceAll(cmd, "\r\n", "\n"))
	if s == "" || strings.HasPrefix(s, "#!") {
		return s
	}
	lines := strings.Split(s, "\n")
	if len(lines) < 2 {
		return s
	}
	first := strings.TrimSpace(lines[0])
	last := strings.TrimSpace(lines[len(lines)-1])
	interactive := shellNeedsInteractiveTTY(s)

	// Idempotent handling if already wrapped in (...) or {...}.
	if (first == "(" && reCloseSubshellLine.MatchString(last)) || (first == "{" && reCloseBraceLine.MatchString(last)) {
		if !interactive && !strings.Contains(last, "/dev/null") {
			if first == "(" {
				lines[len(lines)-1] = ") </dev/null"
			} else {
				lines[len(lines)-1] = "} </dev/null"
			}
			return strings.Join(lines, "\n")
		}
		return s
	}
	if countLogicalShellCommands(s) < 2 {
		return s
	}
	if interactive {
		return "(\n" + s + "\n)"
	}
	return "(\n" + s + "\n) </dev/null"
}

func splitSequentialRollingCommands(cmd, lang string) []rehearsalStepCommand {
	rawLines := strings.Split(unwrapOuterPasteGroup(cmd), "\n")
	if len(rawLines) < 2 {
		return nil
	}
	type seg struct {
		lines      []string
		hasRolling bool
	}
	var segs []seg
	cur := seg{}
	heredocEnd := ""
	blockDepth := 0
	prevCont := false

	for _, line := range rawLines {
		trimmed := strings.TrimSpace(line)
		inMulti := heredocEnd != "" || blockDepth > 0 || prevCont
		if !inMulti && isRollingActionCommandLine(trimmed) && cur.hasRolling {
			// Carry trailing leading comments / blank lines attached to this new rolling command.
			var carry []string
			for len(cur.lines) > 0 {
				last := strings.TrimSpace(cur.lines[len(cur.lines)-1])
				if last == "" || strings.HasPrefix(last, "#") {
					carry = append([]string{cur.lines[len(cur.lines)-1]}, carry...)
					cur.lines = cur.lines[:len(cur.lines)-1]
				} else {
					break
				}
			}
			for len(carry) > 0 && strings.TrimSpace(carry[0]) == "" {
				carry = carry[1:]
			}
			if len(cur.lines) > 0 {
				segs = append(segs, cur)
			}
			cur = seg{lines: carry, hasRolling: false}
		}

		cur.lines = append(cur.lines, line)
		if !inMulti && isRollingActionCommandLine(trimmed) {
			cur.hasRolling = true
		}

		// Update multi-line shell syntax trackers so we never break heredocs or loops.
		if heredocEnd != "" {
			if trimmed == heredocEnd {
				heredocEnd = ""
			}
		} else if !strings.HasPrefix(trimmed, "#") {
			if m := reHeredocStart.FindStringSubmatch(trimmed); len(m) >= 2 {
				heredocEnd = m[1]
			}
			if reShellBlockOpen.MatchString(trimmed) && !reShellBlockClose.MatchString(trimmed) {
				blockDepth++
			} else if reShellBlockClose.MatchString(trimmed) && blockDepth > 0 {
				blockDepth--
			}
		}
		prevCont = strings.HasSuffix(strings.TrimRight(line, " \t"), "\\")
	}
	if len(cur.lines) > 0 {
		segs = append(segs, cur)
	}
	if len(segs) < 2 {
		return nil
	}

	out := make([]rehearsalStepCommand, 0, len(segs))
	for i, sg := range segs {
		body := strings.TrimSpace(strings.Join(sg.lines, "\n"))
		if body == "" {
			continue
		}
		hint := extractRollingSegmentHint(sg.lines)
		label := tr(lang, fmt.Sprintf("第 %d 段", i+1), fmt.Sprintf("Part %d", i+1))
		if hint == "switchover" {
			label = tr(lang, fmt.Sprintf("第 %d 段 · 切主", i+1), fmt.Sprintf("Part %d · Switchover", i+1))
		} else if hint != "" {
			label = tr(lang, fmt.Sprintf("第 %d 段 · %s", i+1, hint), fmt.Sprintf("Part %d · %s", i+1, hint))
		}
		gate := ""
		if i < len(segs)-1 {
			if hint != "" && hint != "switchover" {
				gate = tr(lang,
					fmt.Sprintf("暂停核验：确认 %s 恢复健康（如 streaming / Lag=0 / 无告警）后，再复制执行下一段", hint),
					fmt.Sprintf("Pause & verify: confirm %s is healthy (streaming / Lag=0 / no alerts) before running the next block", hint))
			} else {
				gate = tr(lang,
					"暂停核验：确认本段执行成功且集群恢复健康后，再复制执行下一段",
					"Pause & verify: confirm this block succeeded and cluster is healthy before running the next block")
			}
		}
		out = append(out, rehearsalStepCommand{
			Label:   label,
			Command: body,
			Gate:    gate,
		})
	}
	if len(out) < 2 {
		return nil
	}
	return out
}

func joinStepCommandsFallback(cmds []rehearsalStepCommand) string {
	var parts []string
	for i, c := range cmds {
		body := strings.TrimSpace(c.Command)
		if body == "" {
			continue
		}
		if lbl := strings.TrimSpace(c.Label); lbl != "" {
			parts = append(parts, fmt.Sprintf("# %s\n%s", lbl, body))
		} else if i > 0 {
			parts = append(parts, fmt.Sprintf("# Part %d\n%s", i+1, body))
		} else {
			parts = append(parts, body)
		}
	}
	return strings.Join(parts, "\n\n")
}

func normalizeRehearsalSteps(in []rehearsalStep) []rehearsalStep {
	return normalizeRehearsalStepsLang(in, "zh-CN")
}

func normalizeRehearsalStepsLang(in []rehearsalStep, lang string) []rehearsalStep {
	validPhase := map[string]bool{"precheck": true, "execute": true, "verify": true, "rollback": true}
	var out []rehearsalStep
	seenID := map[string]bool{}
	for i, st := range in {
		if i >= 40 {
			break
		}
		var cleanCmds []rehearsalStepCommand
		for _, sub := range st.Commands {
			sc := strings.TrimSpace(sub.Command)
			if sc == "" {
				continue
			}
			cleanCmds = append(cleanCmds, rehearsalStepCommand{
				Label:      truncRunes(strings.TrimSpace(sub.Label), 80),
				TargetRole: truncRunes(strings.TrimSpace(sub.TargetRole), 80),
				Command:    sc,
				Gate:       truncRunes(strings.TrimSpace(sub.Gate), 220),
			})
		}
		cmd := strings.TrimSpace(st.Command)
		if cmd == "" && len(cleanCmds) > 0 {
			cmd = joinStepCommandsFallback(cleanCmds)
		}
		if len(cleanCmds) == 1 {
			if cmd == "" {
				cmd = cleanCmds[0].Command
			}
			cleanCmds = nil
		}
		if len(cleanCmds) == 0 && cmd != "" {
			cleanCmds = splitSequentialRollingCommands(cmd, lang)
		}
		if len(cleanCmds) > 1 {
			for ci := range cleanCmds {
				cleanCmds[ci].Command = ensurePasteSafeShellCommand(cleanCmds[ci].Command)
			}
			cmd = joinStepCommandsFallback(cleanCmds)
		} else if cmd != "" {
			cmd = ensurePasteSafeShellCommand(cmd)
		}
		title := strings.TrimSpace(st.Title)
		if cmd == "" || title == "" {
			continue
		}
		ph := strings.TrimSpace(st.Phase)
		if !validPhase[ph] {
			ph = "execute"
		}
		id := strings.TrimSpace(st.ID)
		if !reStepID.MatchString(id) || seenID[id] {
			id = fmt.Sprintf("step-%d", len(out)+1)
		}
		seenID[id] = true
		role := strings.TrimSpace(st.TargetRole)
		if role == "" {
			role = tr(lang, "目标节点", "Target Host")
		}
		expect := strings.TrimSpace(st.Expect)
		if expect == "" {
			expect = tr(lang, "命令退出码为 0，输出符合预期", "Command exits 0 with expected output")
		}
		out = append(out, rehearsalStep{
			ID:         id,
			Phase:      ph,
			Order:      len(out) + 1,
			Title:      truncRunes(title, 120),
			TargetRole: truncRunes(role, 80),
			Command:    cmd,
			Commands:   cleanCmds,
			Expect:     truncRunes(expect, 300),
			RiskNote:   truncRunes(strings.TrimSpace(st.RiskNote), 300),
			Rollback:   strings.TrimSpace(st.Rollback),
			Optional:   st.Optional,
			Status:     "pending",
		})
	}
	return out
}

var (
	reRestoreKeepNewPrimary  = regexp.MustCompile(`(?i)(永久切主|永久迁主|保留新主|不切回|无需切回|下线原主|替换原主|迁移至新主|keep\s+new\s+primary|no\s+switchback|permanent\s+(switchover|failover|migration))`)
	reRestoreSwitchoverCmd   = regexp.MustCompile(`(?i)\b(patronictl\b[^\n]*\b(switchover|failover)\b|sentinel\s+failover\b|repmgr\s+standby\s+switchover\b|masterha_master_switch\b|pg_ctl\s+promote\b)`)
	reRestoreSwitchbackHint  = regexp.MustCompile(`(?i)(切回|恢复原主|原主归位|主从复位|原主库|switchback|failback|restore\s+(original\s+)?(primary|leader|master))`)
	reRestorePauseCmd        = regexp.MustCompile(`(?i)\bpatronictl\b[^\n]*\bpause\b`)
	reRestoreResumeCmd       = regexp.MustCompile(`(?i)\bpatronictl\b[^\n]*\bresume\b`)
	reRestoreDrainGoalSkip   = regexp.MustCompile(`(?i)(永久下线|缩容下线|摘除节点|下线节点|decommission|remove\s+node)`)
	reRestoreDrainCmd        = regexp.MustCompile(`(?i)(\bset\s+server\s+\S+\s+state\s+(maint|drain)\b|\bdisable\s+server\b|\bset\s+weight\s+\S+\s+0\b|\bweight\s*=\s*0\b)`)
	reRestoreUndrainCmd      = regexp.MustCompile(`(?i)(\bstate\s+ready\b|\benable\s+server\b|\bset\s+weight\s+\S+\s+[1-9]|\bweight\s*=\s*[1-9])`)
	reRestoreSyncGoalSkip    = regexp.MustCompile(`(?i)(synchronous_mode|synchronous_node_count|synchronous_standby_names|min-replicas-to-write|关闭同步|改为异步|调整同步|降低同步)`)
	reRestoreSyncRelaxCmd    = regexp.MustCompile(`(?i)(synchronous_mode\s*[:=]\s*false|synchronous_standby_names\s*=\s*['"]?['"]|min-replicas-to-write\s+0\b)`)
	reRestoreSyncTightCmd    = regexp.MustCompile(`(?i)(synchronous_mode\s*[:=]\s*true|synchronous_standby_names\s*=\s*['"]?[a-z0-9_*]|min-replicas-to-write\s+[1-9])`)
	reRestoreDebugGoalSkip   = regexp.MustCompile(`(?i)(log_statement|log_min_duration_statement|debug|开启全量|慢查询日志|全量日志)`)
	reRestoreDebugOnCmd      = regexp.MustCompile(`(?i)(log_statement\s*[:=]\s*['"]?all['"]?|log_min_duration_statement\s*[:=]\s*['"]?0['"]?)`)
	reRestoreDebugOffCmd     = regexp.MustCompile(`(?i)(log_statement\s*[:=]\s*['"]?(none|ddl|mod)['"]?|log_min_duration_statement\s*[:=]\s*['"]?(-1|[1-9][0-9]*)['"]?|reset\s+log_)`)
	reRestoreStopGoalSkip    = regexp.MustCompile(`(?i)(永久停|停用|关闭|卸载|禁用|disable|uninstall)`)
	reRestoreStopSvcCmd      = regexp.MustCompile(`(?i)\bsystemctl\s+stop\s+([a-z0-9_@.-]*(?:keepalived|cron|crond|timer|backup|pgbackrest|exporter|prometheus|alertmanager)[a-z0-9_@.-]*)`)
	reRestoreStartSvcCmd     = regexp.MustCompile(`(?i)\bsystemctl\s+(start|restart)\s+([a-z0-9_@.-]+)`)
	reRestoreTempTableCmd    = regexp.MustCompile(`(?i)\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."']*(?:test|probe|verify|rehearsal|tmp|check|smoke)[a-z0-9_."']*)`)
	reRestoreDropTableCmd    = regexp.MustCompile(`(?i)\bdrop\s+table\b`)
	reRestoreTempRedisKeyCmd = regexp.MustCompile(`(?i)\bredis-cli\b[^\n]*\bset\s+['"]?([a-z0-9_:.-]*(?:test|probe|verify|rehearsal|tmp|check|smoke)[a-z0-9_:.-]*)`)
	reRestoreDelRedisKeyCmd  = regexp.MustCompile(`(?i)\b(del|unlink)\b`)
)

// auditRehearsalRestorations deterministically scans forward rehearsal steps for temporary state changes
// (switchover, maintenance pause, LB drain, relaxed sync, debug logging, stopped cron/keepalived/backup services,
// or temp test tables/keys) that have no matching restoration or cleanup command in subsequent forward steps.
func auditRehearsalRestorations(goal, extraScope string, steps []rehearsalStep, lang string) []rehearsalRestorationAlert {
	if len(steps) == 0 {
		return nil
	}
	type fwdStep struct {
		step     rehearsalStep
		fwdOrder int
	}
	var fwd []fwdStep
	for _, st := range steps {
		if st.Phase == "rollback" {
			continue
		}
		fwd = append(fwd, fwdStep{step: st, fwdOrder: len(fwd) + 1})
	}
	if len(fwd) == 0 {
		return nil
	}
	goalText := goal + "\n" + extraScope
	var alerts []rehearsalRestorationAlert
	added := map[string]bool{}
	addAlert := func(a rehearsalRestorationAlert) {
		key := a.Kind + ":" + a.StepID + ":" + a.Summary
		if !added[key] {
			added[key] = true
			alerts = append(alerts, a)
		}
	}
	// helper: checks whether re matches in the remainder of fwd[idx] after offset or in any subsequent fwd[j] (j > idx)
	hasLater := func(idx, offset int, re *regexp.Regexp) bool {
		if offset >= 0 && offset < len(fwd[idx].step.Command) {
			if re.MatchString(fwd[idx].step.Command[offset:]) {
				return true
			}
		}
		for j := idx + 1; j < len(fwd); j++ {
			if re.MatchString(fwd[j].step.Command) {
				return true
			}
		}
		return false
	}

	// 1. Temporary switchover / failover without switchback
	if !reRestoreKeepNewPrimary.MatchString(goalText) {
		firstSwitchIdx := -1
		totalSwitchCmds := 0
		hasLaterSwitchbackHint := false
		for i, item := range fwd {
			matches := reRestoreSwitchoverCmd.FindAllStringIndex(item.step.Command, -1)
			if len(matches) > 0 {
				if firstSwitchIdx < 0 {
					firstSwitchIdx = i
				}
				totalSwitchCmds += len(matches)
			} else if firstSwitchIdx >= 0 && (reRestoreSwitchbackHint.MatchString(item.step.Title) || reRestoreSwitchbackHint.MatchString(item.step.Command)) {
				hasLaterSwitchbackHint = true
			}
		}
		if firstSwitchIdx >= 0 && totalSwitchCmds == 1 && !hasLaterSwitchbackHint {
			it := fwd[firstSwitchIdx]
			addAlert(rehearsalRestorationAlert{
				Kind:      "switchover",
				StepID:    it.step.ID,
				StepOrder: it.fwdOrder,
				StepTitle: it.step.Title,
				Summary: tr(lang,
					fmt.Sprintf("步骤 #%d 执行了临时切主，但后续正向步骤未安排切回原主库", it.fwdOrder),
					fmt.Sprintf("Step #%d performs a temporary switchover/failover without a forward switchback step", it.fwdOrder),
				),
				Suggestion: tr(lang,
					"在原主库恢复并追平复制（Lag=0）后，补充「切回原主库恢复变更前主从角色」步骤（若确认保留新主可忽略）",
					"Add a switchback step to restore the original primary once replication lag reaches 0 (ignore if keeping the new primary intentionally)",
				),
			})
		}
	}

	// 2-7. Per-step temporary mutations checked against later commands
	for i, item := range fwd {
		cmd := item.step.Command
		// 2. Patroni maintenance mode (pause without resume)
		if loc := reRestorePauseCmd.FindStringIndex(cmd); loc != nil && !hasLater(i, loc[1], reRestoreResumeCmd) {
			addAlert(rehearsalRestorationAlert{
				Kind:      "maintenance_pause",
				StepID:    item.step.ID,
				StepOrder: item.fwdOrder,
				StepTitle: item.step.Title,
				Summary: tr(lang,
					fmt.Sprintf("步骤 #%d 开启了 Patroni 维护模式（patronictl pause），但后续缺少 patronictl resume", item.fwdOrder),
					fmt.Sprintf("Step #%d enables Patroni maintenance mode (pause) without a subsequent patronictl resume", item.fwdOrder),
				),
				Suggestion: tr(lang,
					"必须在变更收尾前补充 patronictl resume 并核验退出维护模式，恢复自动故障转移能力",
					"Add a patronictl resume step before closing so automatic HA failover is re-enabled",
				),
			})
		}
		// 3. LB drain / maint / weight 0
		if !reRestoreDrainGoalSkip.MatchString(goalText) {
			if loc := reRestoreDrainCmd.FindStringIndex(cmd); loc != nil && !hasLater(i, loc[1], reRestoreUndrainCmd) {
				addAlert(rehearsalRestorationAlert{
					Kind:      "lb_drain",
					StepID:    item.step.ID,
					StepOrder: item.fwdOrder,
					StepTitle: item.step.Title,
					Summary: tr(lang,
						fmt.Sprintf("步骤 #%d 将负载均衡后端置为维护/摘流或零权重状态，但后续未恢复放流", item.fwdOrder),
						fmt.Sprintf("Step #%d puts a load-balancer backend into maint/drain/weight-0 without restoring it", item.fwdOrder),
					),
					Suggestion: tr(lang,
						"在收尾阶段补充恢复后端为 ready / 还原原权重并确认健康检查 UP 的步骤",
						"Add a restoration step to set the backend back to ready / original weight and verify UP health",
					),
				})
			}
		}
		// 4. Temporary synchronous replication relaxation
		if !reRestoreSyncGoalSkip.MatchString(goalText) {
			if loc := reRestoreSyncRelaxCmd.FindStringIndex(cmd); loc != nil && !hasLater(i, loc[1], reRestoreSyncTightCmd) {
				addAlert(rehearsalRestorationAlert{
					Kind:      "sync_relaxed",
					StepID:    item.step.ID,
					StepOrder: item.fwdOrder,
					StepTitle: item.step.Title,
					Summary: tr(lang,
						fmt.Sprintf("步骤 #%d 临时放宽或关闭了同步复制策略，但后续步骤未恢复原强同步设置", item.fwdOrder),
						fmt.Sprintf("Step #%d temporarily relaxes synchronous replication without restoring it afterward", item.fwdOrder),
					),
					Suggestion: tr(lang,
						"在收尾步骤恢复原 synchronous_mode / min-replicas-to-write 配置并核验同步副本正常",
						"Restore original synchronous_mode / min-replicas-to-write settings and verify sync replicas",
					),
				})
			}
		}
		// 5. Temporary verbose/debug SQL logging
		if !reRestoreDebugGoalSkip.MatchString(goalText) {
			if loc := reRestoreDebugOnCmd.FindStringIndex(cmd); loc != nil && !hasLater(i, loc[1], reRestoreDebugOffCmd) {
				addAlert(rehearsalRestorationAlert{
					Kind:      "debug_log",
					StepID:    item.step.ID,
					StepOrder: item.fwdOrder,
					StepTitle: item.step.Title,
					Summary: tr(lang,
						fmt.Sprintf("步骤 #%d 临时开启了全量调试日志，但后续未恢复原日志级别", item.fwdOrder),
						fmt.Sprintf("Step #%d enables verbose/debug logging without restoring normal log levels", item.fwdOrder),
					),
					Suggestion: tr(lang,
						"在验收后将 log_statement / log_min_duration_statement 复原，避免日志暴涨打满磁盘",
						"Reset log_statement / log_min_duration_statement back to normal after verification",
					),
				})
			}
		}
		// 6. Temporarily stopped background/HA/cron/backup service
		if !reRestoreStopGoalSkip.MatchString(goalText) {
			if m := reRestoreStopSvcCmd.FindStringSubmatchIndex(cmd); m != nil {
				svc := strings.TrimSpace(cmd[m[2]:m[3]])
				svcLower := strings.ToLower(svc)
				restarted := false
				checkStart := func(txt string) bool {
					for _, sm := range reRestoreStartSvcCmd.FindAllStringSubmatch(txt, -1) {
						if len(sm) >= 3 && strings.ToLower(strings.TrimSpace(sm[2])) == svcLower {
							return true
						}
					}
					return false
				}
				if m[1] < len(cmd) && checkStart(cmd[m[1]:]) {
					restarted = true
				}
				for j := i + 1; j < len(fwd) && !restarted; j++ {
					if checkStart(fwd[j].step.Command) {
						restarted = true
					}
				}
				if !restarted {
					addAlert(rehearsalRestorationAlert{
						Kind:      "service_stopped",
						StepID:    item.step.ID,
						StepOrder: item.fwdOrder,
						StepTitle: item.step.Title,
						Summary: tr(lang,
							fmt.Sprintf("步骤 #%d 临时停止了服务/定时任务（%s），但后续正向步骤未重新启动", item.fwdOrder, svc),
							fmt.Sprintf("Step #%d temporarily stops service/timer (%s) without starting it again", item.fwdOrder, svc),
						),
						Suggestion: tr(lang,
							fmt.Sprintf("在收尾步骤补充 systemctl start %s 并核验其恢复 active 状态", svc),
							fmt.Sprintf("Add systemctl start %s and verify active status before closing", svc),
						),
					})
				}
			}
		}
		// 7. Temporary test table or test Redis key left behind
		if m := reRestoreTempTableCmd.FindStringSubmatchIndex(cmd); m != nil && !hasLater(i, m[1], reRestoreDropTableCmd) {
			tbl := strings.TrimSpace(cmd[m[2]:m[3]])
			addAlert(rehearsalRestorationAlert{
				Kind:      "temp_artifact",
				StepID:    item.step.ID,
				StepOrder: item.fwdOrder,
				StepTitle: item.step.Title,
				Summary: tr(lang,
					fmt.Sprintf("步骤 #%d 创建了验收用临时测试表（%s），但后续正向步骤未清理", item.fwdOrder, tbl),
					fmt.Sprintf("Step #%d creates a temporary test table (%s) without dropping it afterward", item.fwdOrder, tbl),
				),
				Suggestion: tr(lang,
					fmt.Sprintf("在验收末尾补充 DROP TABLE IF EXISTS %s 清理测试脏数据", tbl),
					fmt.Sprintf("Add DROP TABLE IF EXISTS %s at the end of verification to clean up", tbl),
				),
			})
		}
		if m := reRestoreTempRedisKeyCmd.FindStringSubmatchIndex(cmd); m != nil && !hasLater(i, m[1], reRestoreDelRedisKeyCmd) {
			key := strings.TrimSpace(cmd[m[2]:m[3]])
			addAlert(rehearsalRestorationAlert{
				Kind:      "temp_artifact",
				StepID:    item.step.ID,
				StepOrder: item.fwdOrder,
				StepTitle: item.step.Title,
				Summary: tr(lang,
					fmt.Sprintf("步骤 #%d 写入了验收用临时测试 Key（%s），但后续正向步骤未清理", item.fwdOrder, key),
					fmt.Sprintf("Step #%d writes a temporary test key (%s) without deleting it afterward", item.fwdOrder, key),
				),
				Suggestion: tr(lang,
					fmt.Sprintf("在验收末尾补充 DEL %s 清理临时测试数据", key),
					fmt.Sprintf("Add DEL %s at the end of verification to clean up", key),
				),
			})
		}
	}
	return alerts
}

func (s *storeServer) patchRehearsalStep(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid, sid string) {
	var in struct {
		Status  *string `json:"status"`
		Elapsed *string `json:"elapsed"`
		Note    *string `json:"note"`
		Command *string `json:"command"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容格式不对")
		return
	}
	if in.Status != nil {
		switch *in.Status {
		case "pending", "passed", "failed", "skipped":
		default:
			s.fail(w, 400, "无效的步骤状态")
			return
		}
	}
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		s.fail(w, 404, "演练会话不存在")
		return
	}
	idx := -1
	for i := range rh.Steps {
		if rh.Steps[i].ID == sid {
			idx = i
			break
		}
	}
	if idx < 0 {
		rehearsalMu.Unlock()
		s.fail(w, 404, "演练步骤不存在")
		return
	}
	st := &rh.Steps[idx]
	if in.Command != nil {
		nextCmd := strings.TrimSpace(*in.Command)
		if nextCmd == "" {
			rehearsalMu.Unlock()
			s.fail(w, 400, "步骤命令不能为空")
			return
		}
		if nextCmd != st.Command {
			st.Revisions = append(st.Revisions, rehearsalStepRevision{
				At:         nowStamp(),
				By:         session.User,
				Diagnosis:  tr(reqLang(r), "工程师在测试环境手动调整命令", "Command manually adjusted in staging"),
				OldCommand: st.Command,
				NewCommand: nextCmd,
			})
			st.Command = nextCmd
			st.Commands = splitSequentialRollingCommands(nextCmd, reqLang(r))
			st.Proposal = nil
		}
	}
	if in.Elapsed != nil {
		st.Elapsed = truncRunes(strings.TrimSpace(*in.Elapsed), 40)
	}
	if in.Note != nil {
		st.Note = truncRunes(strings.TrimSpace(*in.Note), 500)
	}
	if in.Status != nil {
		if rh.Source != nil && rh.Source.StrictPrecheck && len(rh.Steps) > 0 && rh.Steps[0].Phase == "precheck" {
			lang := reqLang(r)
			if idx == 0 && *in.Status == "skipped" {
				rehearsalMu.Unlock()
				s.fail(w, 409, tr(lang,
					"同架构快车道引入的严格前置预检不可跳过，请先执行并核验通过后再推进后续步骤",
					"Strict precheck on a fast-track propagated rehearsal cannot be skipped; execute and verify it first"))
				return
			}
			if idx > 0 && st.Phase != "rollback" && *in.Status == "passed" && rh.Steps[0].Status != "passed" {
				rehearsalMu.Unlock()
				s.fail(w, 409, tr(lang,
					"请先执行并核验通过第 1 步「严格前置预检」，预检通过前不允许直接标记后续变更步骤为已通过",
					"Complete and pass Step 1 (Strict Precheck) before marking subsequent forward steps as passed"))
				return
			}
		}
		st.Status = *in.Status
		st.VerifiedByAI = false
		if *in.Status == "passed" {
			st.Proposal = nil
		}
	}
	err := s.saveRehearsal(rh)
	rehearsalMu.Unlock()
	if err != nil {
		s.fail(w, 500, "保存步骤状态失败")
		return
	}
	s.auditReq(r, "rehearsal-step", session.User, f.ID+" "+rid+" "+sid)
	rh.RestorationAlerts = auditRehearsalRestorations(rh.Goal, rh.ExtraScope, rh.Steps, reqLang(r))
	s.writeJSON(w, 200, rh)
}

const rehearsalVerifyStepSystem = `你是资深中间件变更验收与排障专家（SRE 实务风格）。工程师刚刚在测试环境执行了变更演练中的某一步，并把终端执行回显或截图回传给你。
请以**目标导向、上下文连贯、结果优先**的原则核验本步是否达成核心预期，并决定 verdict（passed 或 failed）：

1. 先在 JSON 第一个字段 thinking 中简明写出你从本轮回显/截图（以及前序步骤、本步前序轮次已证实事实）中提取到的关键证据，逐条比对核心目标状态。
2. **上下文继承与务实判定红线（严禁失忆、教条与反复折腾）**：
   - **继承前序步骤成果**：提示词中的【演练全局上下文：前序步骤实测进展】列出了本次演练中已完成步骤的实测结论（如前序步骤已完成 DCS 配置修改、切主或节点重启），可直接作为既成事实采信，不得当成未发生。
   - **强制合并本步前序轮次已证实事实（多节点分批回传绝不失忆）**：若【本步前序轮次已累计证实达标的事实】或【本步此前核验与处置历史】中已记录前序轮次证实了部分节点或子动作（例如第 1 轮截图已证实 node-1 和 node-3 参数生效且日志持续增长、当时仅缺 node-2；或第 1 轮已改 DCS 并重启 node-3、当时仅缺 node-2 重启），本轮工程师按要求单独补传了 node-2 的截图/回显且 node-2 达标，**必须把前序已证实的 node-1、node-3 与本轮新证实的 node-2 合并评估——全部节点已拼齐，直接判 passed！**严禁因为本轮截图只展示了 node-2 就又报「缺少另外两台节点证据」或「未看到前序命令输出」，更严禁让用户重测已经通过的节点。
   - **允许等价强证据推断（严禁死扣单行输出）**：例如终端滚动导致某一行参数回显未完整入镜（如没截到 log_directory 这一行），但同屏已清晰看到目标目录下的当日日志文件（如 /data/logs/postgresql/postgresql-2026-11-23.log）存在且字节数持续增长，这在运行事实上已经等价证明了 log_directory 与日志写入生效，直接视为达标，不得以此卡住通过。
   - **实事求是采信【集群基线】IP 映射与成功的 ELB/VIP 入口验证（严禁教条拒收）**：
     * 【集群基线】中已明确给出每台节点的名称与 IP 对应关系（例如 node-1=172.30.4.26、node-2=172.30.4.22），核验时直接以此作为权威映射，**严禁**在回显已经返回正确主库 IP（如 172.30.4.22 | f）时还反问「未能证明 172.30.4.22 就是 node-2」！
     * 很多现场没有独立的第 4 台跳板机，只要工程师从**非当前主库的节点**（例如切主后在从库 node-1 上）连接 ELB/VIP 写入入口**已经成功连通并返回了目标主库 IP 且可写（如 pg_is_in_recovery=f）**，这就已经实打实证明了 ELB 路由生效且指向正确主库，**必须直接判 passed**！严禁以「不是集群外独立跳板机、违反 ELB 回环规避要求」为由教条拒收已经成功的实测结果！只有当后端节点连 VIP 确实发生超时/连接失败时，才提示可能是 ELB 回环限制并建议换非主库节点、业务端验证或跳过改查本机健康接口。
   - **忽略无害终端噪声**：终端里偶尔误粘了说明文字/注释导致的 command not found、多余换行或额外的只读查询回显，只要核心状态已经正确达成且无实际故障，不得以此判 failed。
   - **最终收尾/复位状态核验**：核验涉及恢复原状态或最终验收的步骤时，若输出显示集群仍处于临时异常/维护态（如 Patroni 仍显示 Maintenance mode / paused、HAProxy 后端仍为 MAINT/DRAIN、原主库尚未恢复且本步目标就是切回原主），必须判 failed 并给出最小恢复命令。
   - **只有真正的阻断或核心缺口未补齐才判 failed**：例如目标参数仍为旧值、仍有目标节点卡在 Pending restart、节点离线/复制断开、多节点验收中确实还有节点在所有轮次里都从未提供过达标证据。
3. 输出规则：
   - **passed（通过）**：合并前序已证实事实与本轮新证据后，核心目标状态已全部满足且集群健康。输出精炼、可审计的实测结论 summary（1-2 句，同步写入最终生产 SOP；多轮补齐时简述全部节点已验证一致），并在 verified_facts 中列出本轮新证实的要点（可选；仅当输出明确可见耗时再填 elapsed）。
   - **failed（未通过）**：核心目标尚未补齐或存在真阻断。必须同时填好：
     * **verified_facts（极重要！）**：逐条列出**本轮从截图/文本中新证实已经达标的每一项具体事实**（务必写清具体节点名、关键参数或状态，例如 "node-1: logging_collector=on 等参数生效且当日日志持续增长"、"node-3: 参数生效且当日日志持续增长"），平台会自动持久化并在下一轮传回给你，防止遗忘！若本轮无新达标项则填 []。
     * **missing_items（极重要！）**：仅列出合并前序轮次后**仍然真正缺少的剩余缺口**（例如 ["node-2 参数生效与日志持续增长验证"]），禁止把已经通过的节点再列进来！
     * **diagnosis**：准确简明的未通过原因（明确指出哪些已确认 OK、仅剩什么未补齐）。
     * **action、target_role & command**：尽量最小化、**只针对剩余缺口**给出下一步动作（不要让用户重跑已经通过的节点或前半段），并且 **target_role 必须必填且写清具体要登录哪台/哪几台机器与 IP**（例如「仅在从库 node-3 (172.30.4.20) 上执行」或「在 node-1 / node-2 / node-3 逐台执行」，严禁留空让工程师猜在哪台机器跑）：
       - 若当前步骤命令本身需要修改：action="replace"，给出修正后的完整 command 与 target_role；
       - 若缺少前置步骤：action="insert_before"，给出前置步骤 title、target_role、command、expect；
       - 若只需补测剩余节点或补跑一条轻量补救命令：action="retry"，给出只针对剩余缺口的最小复测命令，并在 target_role 中明确指出该命令要登录哪台/哪几台机器执行。
       - **防吞行格式**：若 command 包含 2 条及以上命令（尤其含 sudo/psql/patronictl/sleep），请整块包在 ( ... ) </dev/null 中（不要裸写多行，也不要用 bash <<'EOF'），保证堡垒机/WebSSH 一次复制粘贴即可按序跑全。

严格只输出一个 JSON 对象：
- 通过时：
{"thinking":"...","verdict":"passed","verified_facts":["本轮新证实的达标项（可选）"],"summary":"客观实测通过摘要（同步写入 SOP）","elapsed":""}
- 未通过时：
{"thinking":"...","verdict":"failed","verified_facts":["本轮已证实达标的节点/指标（写清节点名与状态，供下轮沿用）"],"missing_items":["合并前序后仅剩的待补缺口"],"diagnosis":"未通过或尚缺证据的准确根因","action":"replace|insert_before|retry","title":"前置步骤标题（insert_before必填）","target_role":"复测/修正命令的具体执行机器（必填，写清节点名与 IP，如：仅在从库 node-3 (172.30.4.20) 执行）","command":"修正后命令或仅针对剩余缺口的最小复测命令","expect":"成功判据","rollback":"回退命令（可选）","risk_note":"注意事项（可选）"}`

func cleanFactSlice(xs []string, maxItems, maxRunes int) []string {
	if len(xs) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(xs))
	out := make([]string, 0, min(len(xs), maxItems))
	for _, raw := range xs {
		s := truncRunes(strings.TrimSpace(raw), maxRunes)
		if s == "" {
			continue
		}
		k := strings.ToLower(s)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, s)
		if len(out) >= maxItems {
			break
		}
	}
	return out
}

func collectCumulativeVerifiedFacts(st *rehearsalStep) []string {
	var all []string
	for _, it := range st.VerifyHistory {
		all = append(all, it.VerifiedFacts...)
	}
	if st.Proposal != nil {
		all = append(all, st.Proposal.VerifiedFacts...)
	}
	return cleanFactSlice(all, 24, 180)
}

func buildPriorStepsContext(rh *changeRehearsal, currentStepID string) string {
	if rh == nil {
		return ""
	}
	var lines []string
	if rh.Drift != nil && strings.TrimSpace(rh.Drift.Summary) != "" {
		lines = append(lines, "- 探针阶段现场摘要："+truncRunes(strings.TrimSpace(rh.Drift.Summary), 360))
	}
	phaseLabel := map[string]string{"precheck": "预检", "execute": "执行", "verify": "验收", "rollback": "回退"}
	statusLabel := map[string]string{"passed": "已通过", "skipped": "已跳过", "failed": "未通过", "pending": "待执行"}
	for _, st := range rh.Steps {
		if st.ID == currentStepID {
			continue
		}
		if st.Status == "pending" {
			continue
		}
		ph := firstNonEmptyStr(phaseLabel[st.Phase], st.Phase)
		sl := firstNonEmptyStr(statusLabel[st.Status], st.Status)
		if st.Status == "passed" && st.VerifiedByAI {
			sl = "已通过（AI 核验）"
		}
		detail := strings.TrimSpace(st.Note)
		if detail == "" && len(st.VerifyHistory) > 0 {
			last := st.VerifyHistory[len(st.VerifyHistory)-1]
			detail = firstNonEmptyStr(strings.TrimSpace(last.Summary), strings.TrimSpace(last.Diagnosis), strings.TrimSpace(last.Thinking))
		}
		if detail == "" && st.TroubleTrace != nil {
			detail = strings.TrimSpace(st.TroubleTrace.Thinking)
		}
		if detail != "" {
			lines = append(lines, fmt.Sprintf("- 步骤 #%d [%s]「%s」— %s：%s", st.Order, ph, st.Title, sl, truncRunes(strings.ReplaceAll(detail, "\n", " "), 320)))
		} else {
			lines = append(lines, fmt.Sprintf("- 步骤 #%d [%s]「%s」— %s", st.Order, ph, st.Title, sl))
		}
	}
	if len(lines) == 0 {
		return ""
	}
	return "\n\n【演练全局上下文：前序步骤实测进展（已通过步骤的成果可直接采信，不要失忆）】\n" + strings.Join(lines, "\n")
}

func buildVerifyHistoryPrompt(st *rehearsalStep) string {
	var items []rehearsalVerifyAttempt
	if len(st.VerifyHistory) > 0 {
		items = st.VerifyHistory
	} else if st.Proposal != nil || strings.TrimSpace(st.LastError) != "" || (st.TroubleTrace != nil && strings.TrimSpace(st.TroubleTrace.Thinking) != "") {
		// Backward-compatibility for in-flight steps that failed before verify_history existed.
		att := rehearsalVerifyAttempt{
			Round:   1,
			Verdict: "failed",
			Output:  strings.TrimSpace(st.LastError),
		}
		if st.TroubleTrace != nil {
			att.Thinking = truncRunes(strings.TrimSpace(st.TroubleTrace.Thinking), 900)
		}
		if st.Proposal != nil {
			att.Diagnosis = strings.TrimSpace(st.Proposal.Diagnosis)
			att.Action = st.Proposal.Action
			att.FixCommand = strings.TrimSpace(st.Proposal.Command)
			att.VerifiedFacts = append([]string(nil), st.Proposal.VerifiedFacts...)
			att.MissingItems = append([]string(nil), st.Proposal.MissingItems...)
		}
		items = []rehearsalVerifyAttempt{att}
	}
	if len(items) == 0 {
		return ""
	}
	var b strings.Builder
	if cumFacts := collectCumulativeVerifiedFacts(st); len(cumFacts) > 0 {
		b.WriteString("\n\n【本步前序轮次已累计证实达标的事实（既成事实，自动沿用，严禁要求用户重测或重贴）】\n")
		for _, f := range cumFacts {
			fmt.Fprintf(&b, "- ✓ %s\n", f)
		}
	}
	b.WriteString("\n\n【本步此前核验与处置历史（请结合下方每轮已提取的截图/文本证据与本轮新证据合并判定）】\n")
	for _, it := range items {
		vLabel := "未通过"
		if it.Verdict == "passed" {
			vLabel = "已通过"
		}
		fmt.Fprintf(&b, "- 第 %d 轮（%s", it.Round, vLabel)
		if it.At != "" {
			fmt.Fprintf(&b, " · %s", it.At)
		}
		b.WriteString("）：")
		if len(it.VerifiedFacts) > 0 {
			fmt.Fprintf(&b, "本轮已证实达标=[%s]；", strings.Join(it.VerifiedFacts, "；"))
		}
		if len(it.MissingItems) > 0 {
			fmt.Fprintf(&b, "当时仅剩缺口=[%s]；", strings.Join(it.MissingItems, "；"))
		}
		if it.Thinking != "" {
			fmt.Fprintf(&b, "当时从截图/回显提取的实测证据=%s；", truncRunes(strings.ReplaceAll(it.Thinking, "\n", " "), 650))
		}
		if it.Summary != "" {
			fmt.Fprintf(&b, "结论=%s；", truncRunes(it.Summary, 300))
		}
		if it.Diagnosis != "" {
			fmt.Fprintf(&b, "当时诊断=%s；", truncRunes(it.Diagnosis, 350))
		}
		if it.FixCommand != "" {
			fmt.Fprintf(&b, "当时建议补救命令=%s；", truncRunes(strings.ReplaceAll(it.FixCommand, "\n", " ; "), 240))
		}
		if it.Output != "" {
			fmt.Fprintf(&b, "当时回传文字回显=%s", truncRunes(strings.ReplaceAll(it.Output, "\n", " | "), 320))
		} else if len(it.Images) > 0 {
			fmt.Fprintf(&b, "当时回传了 %d 张终端截图（证据已提取在上方）", len(it.Images))
		}
		b.WriteString("\n")
	}
	return b.String()
}

func appendUniqueStrings(dst []string, add []string) []string {
	seen := make(map[string]bool, len(dst))
	for _, x := range dst {
		seen[x] = true
	}
	for _, x := range add {
		if x != "" && !seen[x] {
			seen[x] = true
			dst = append(dst, x)
		}
	}
	return dst
}

func backfillLegacyVerifyHistory(st *rehearsalStep) {
	if len(st.VerifyHistory) > 0 {
		return
	}
	if st.Proposal == nil && strings.TrimSpace(st.LastError) == "" && len(st.ErrorImages) == 0 {
		return
	}
	att := rehearsalVerifyAttempt{
		Round:   1,
		At:      nowStamp(),
		Verdict: "failed",
		Output:  truncRunes(strings.TrimSpace(st.LastError), 2000),
		Images:  append([]string(nil), st.ErrorImages...),
	}
	if st.TroubleTrace != nil {
		if st.TroubleTrace.At != "" {
			att.At = st.TroubleTrace.At
		}
		att.Model = st.TroubleTrace.Model
		att.Thinking = truncRunes(strings.TrimSpace(st.TroubleTrace.Thinking), 1200)
	}
	if st.Proposal != nil {
		att.Diagnosis = strings.TrimSpace(st.Proposal.Diagnosis)
		att.Action = st.Proposal.Action
		att.FixCommand = strings.TrimSpace(st.Proposal.Command)
		att.VerifiedFacts = append([]string(nil), st.Proposal.VerifiedFacts...)
		att.MissingItems = append([]string(nil), st.Proposal.MissingItems...)
	}
	st.VerifyHistory = []rehearsalVerifyAttempt{att}
}

func (s *storeServer) verifyRehearsalStep(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid, sid string) {
	var in struct {
		Output string     `json:"output"`
		Images []string   `json:"images"`
		Model  string     `json:"model"`
		Effort thinkLevel `json:"effort"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 28<<20)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容格式不对或图片超过大小限制")
		return
	}
	outText := aiScrub(truncRunes(strings.TrimSpace(in.Output), 12000))
	if outText == "" && len(in.Images) == 0 {
		s.fail(w, 400, "请贴入本步执行输出或上传/粘贴终端截图，由 AI 核验是否通过")
		return
	}
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	rehearsalMu.Unlock()
	if !ok {
		s.fail(w, 404, "演练会话不存在")
		return
	}
	var target *rehearsalStep
	for i := range rh.Steps {
		if rh.Steps[i].ID == sid {
			cp := rh.Steps[i]
			target = &cp
			break
		}
	}
	if target == nil {
		s.fail(w, 404, "演练步骤不存在")
		return
	}
	lang := reqLang(r)
	providers, code, err := s.rehearsalCheckAILang(session.User, len(in.Images) > 0, in.Model, lang)
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}
	imgNames, err := s.storeRehearsalImages(f.ID, rid, in.Images)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}

	ev := startRehearsalSSE(w, r)
	baseline, red := s.clusterBaselinePrompt(f)
	evidDesc := outText
	if evidDesc == "" && len(imgNames) > 0 {
		evidDesc = fmt.Sprintf("（详见附带的 %d 张执行结果终端截图）", len(imgNames))
	} else if len(imgNames) > 0 {
		evidDesc += fmt.Sprintf("\n（同时附带 %d 张现场执行终端截图，请结合截图完整核验是否满足预期判据）", len(imgNames))
	}
	priorStepsBlock := buildPriorStepsContext(&rh, target.ID)
	historyBlock := buildVerifyHistoryPrompt(target)
	curRound := len(target.VerifyHistory) + 1
	if len(target.VerifyHistory) == 0 && historyBlock != "" {
		curRound = 2
	}
	prompt := fmt.Sprintf("【集群基线】\n%s\n\n【演练目标】\n%s%s\n\n【待核验演练步骤】\n步骤序号：#%d\n阶段：%s\n标题：%s\n执行对象：%s\n执行命令：\n%s\n预期判据：%s%s\n\n【本轮（第 %d 轮）测试环境实际执行回显（已脱敏）】\n%s",
		baseline, rh.Goal, priorStepsBlock, target.Order, target.Phase, target.Title, target.TargetRole, target.Command, target.Expect, historyBlock, curRound, evidDesc)

	pipeSpec := rehearsalPipelineSpec{
		PreSteps: []rehearsalTraceStep{
			{
				ID:     "inspect-step-evid",
				Kind:   "inspect",
				Title:  tr(lang, "读取步骤判据与实测证据", "Load step criteria & execution evidence"),
				Detail: tr(lang, fmt.Sprintf("步骤 #%d「%s」· 第 %d 轮核验 · 执行对象：%s", target.Order, target.Title, curRound, target.TargetRole), fmt.Sprintf("Step #%d \"%s\" · Round %d · Target: %s", target.Order, target.Title, curRound, target.TargetRole)),
				MS:     1,
				OK:     true,
				Status: "done",
			},
			{
				ID:     "scrub-step-evid",
				Kind:   "guard",
				Title:  tr(lang, "回显凭据二次脱敏", "Scrub credentials from output"),
				Detail: tr(lang, "自动剥离输出中的口令与私钥，结合前序轮次事实客观核验", "Stripped credentials and loaded prior round context before verification"),
				MS:     1,
				OK:     true,
				Status: "done",
			},
		},
		ThinkTitle: tr(lang, "对照预期判据自动核验结果", "Verify output against expected criteria"),
		ThinkWait:  tr(lang, "正在逐项比对终端输出/截图与核心目标状态，判定通过或定位真阻断…", "Comparing terminal output/screenshots against core goal state..."),
		SynthID:    "verify-verdict",
		SynthKind:  "synthesize",
		SynthTitle: tr(lang, "输出核验结论与后续动作", "Emit verification verdict & next action"),
		SynthWait:  tr(lang, "通过则自动回写实测记录；未通过则直接给出根因与最小补救方案", "Recording verified summary if passed, or proposing minimal fix if failed"),
		Validate: func(out string) error {
			var chk struct {
				Verdict   string `json:"verdict"`
				Summary   string `json:"summary"`
				Diagnosis string `json:"diagnosis"`
			}
			if raw := extractJSON(out); raw != "" {
				_ = json.Unmarshal([]byte(raw), &chk)
			}
			v := strings.ToLower(strings.TrimSpace(chk.Verdict))
			if v == "passed" {
				return nil
			}
			if v == "failed" && strings.TrimSpace(chk.Diagnosis) != "" {
				return nil
			}
			return fmt.Errorf("%s", tr(lang, "模型未能输出明确的核验判定（passed/failed），请重试", "Model failed to return a clear verification verdict (passed/failed); please retry"))
		},
	}

	skillBlock, _ := s.rehearsalSkillBlock(session.User, f, rh.Goal, rh.SecurityContext)
	text, trace, code, err := s.rehearsalRunAI(r, providers, session.User, f.ID, rid+"/verify/"+sid, "troubleshoot", red, rehearsalVerifyStepSystem+skillBlock, prompt, in.Images, pipeSpec, in.Effort, ev)
	if err != nil {
		failRehearsalResp(s, w, ev, code, err.Error(), aiDiagFromErr(err), trace.Diag)
		return
	}
	parseStart := time.Now()
	var parsed struct {
		rehearsalStepProposal
		Thinking string `json:"thinking"`
		Verdict  string `json:"verdict"`
		Summary  string `json:"summary"`
		Elapsed  string `json:"elapsed"`
	}
	if raw := extractJSON(text); raw != "" {
		_ = json.Unmarshal([]byte(raw), &parsed)
	}
	verdict := strings.ToLower(strings.TrimSpace(parsed.Verdict))
	if verdict != "passed" && verdict != "failed" {
		failRehearsalResp(s, w, ev, 502, "模型未能输出明确的核验结论，请补充更完整的终端输出或截图重试", trace.Diag)
		return
	}
	if trace.Thinking == "" {
		trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), strings.TrimSpace(parsed.Summary), strings.TrimSpace(parsed.Diagnosis))
	}

	rehearsalMu.Lock()
	cur, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		failRehearsalResp(s, w, ev, 404, "演练会话不存在")
		return
	}

	roundFacts := cleanFactSlice(parsed.VerifiedFacts, 12, 180)
	roundMissing := cleanFactSlice(parsed.MissingItems, 8, 180)
	roundThinking := truncRunes(firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), strings.TrimSpace(trace.Thinking)), 1200)

	if verdict == "passed" {
		summary := truncRunes(strings.TrimSpace(parsed.Summary), 500)
		if summary == "" {
			summary = tr(lang, "AI 已核验现场执行结果，满足预期判据。", "AI verified execution output against expected criteria.")
		}
		finalizeTraceSynth(
			&trace,
			ev,
			"verify-verdict",
			tr(lang, "AI 核验通过 · 已自动回写实测结论", "AI verified PASSED · Summary saved"),
			true,
			max(1, time.Since(parseStart).Milliseconds()),
		)
		for i := range cur.Steps {
			if cur.Steps[i].ID == sid {
				backfillLegacyVerifyHistory(&cur.Steps[i])
				attempt := rehearsalVerifyAttempt{
					Round:         len(cur.Steps[i].VerifyHistory) + 1,
					At:            nowStamp(),
					By:            session.User,
					Verdict:       "passed",
					Summary:       summary,
					VerifiedFacts: roundFacts,
					Thinking:      roundThinking,
					Output:        truncRunes(outText, 2000),
					Images:        append([]string(nil), imgNames...),
					Model:         trace.Model,
				}
				cur.Steps[i].VerifyHistory = append(cur.Steps[i].VerifyHistory, attempt)
				cur.Steps[i].Status = "passed"
				cur.Steps[i].VerifiedByAI = true
				cur.Steps[i].Note = summary
				if e := truncRunes(strings.TrimSpace(parsed.Elapsed), 40); e != "" {
					cur.Steps[i].Elapsed = e
				}
				cur.Steps[i].LastError = ""
				cur.Steps[i].Proposal = nil
				if len(imgNames) > 0 {
					cur.Steps[i].EvidenceImages = appendUniqueStrings(cur.Steps[i].EvidenceImages, imgNames)
				}
				trCopy := trace
				cur.Steps[i].TroubleTrace = &trCopy
				break
			}
		}
	} else {
		prop := parsed.rehearsalStepProposal
		prop.Command = ensurePasteSafeShellCommand(prop.Command)
		prop.TargetRole = truncRunes(strings.TrimSpace(prop.TargetRole), 160)
		prop.Diagnosis = truncRunes(strings.TrimSpace(prop.Diagnosis), 600)
		prop.VerifiedFacts = roundFacts
		prop.MissingItems = roundMissing
		if prop.Action != "insert_before" && prop.Action != "retry" {
			prop.Action = "replace"
		}
		if prop.Action != "retry" && prop.Command == "" {
			prop.Action = "retry"
		}
		finalizeTraceSynth(
			&trace,
			ev,
			"verify-verdict",
			tr(lang, "核验未通过 · 已生成根因诊断与处理建议", "Verification FAILED · Root cause & fix ready"),
			false,
			max(1, time.Since(parseStart).Milliseconds()),
		)
		savedErr := outText
		if savedErr == "" && len(imgNames) > 0 {
			savedErr = tr(lang, fmt.Sprintf("（已上传 %d 张执行截图）", len(imgNames)), fmt.Sprintf("(Uploaded %d execution screenshot(s))", len(imgNames)))
		}
		for i := range cur.Steps {
			if cur.Steps[i].ID == sid {
				backfillLegacyVerifyHistory(&cur.Steps[i])
				if prop.TargetRole == "" {
					prop.TargetRole = cur.Steps[i].TargetRole
				}
				attempt := rehearsalVerifyAttempt{
					Round:         len(cur.Steps[i].VerifyHistory) + 1,
					At:            nowStamp(),
					By:            session.User,
					Verdict:       "failed",
					Diagnosis:     prop.Diagnosis,
					Action:        prop.Action,
					TargetRole:    prop.TargetRole,
					FixCommand:    prop.Command,
					VerifiedFacts: roundFacts,
					MissingItems:  roundMissing,
					Thinking:      roundThinking,
					Output:        truncRunes(outText, 2000),
					Images:        append([]string(nil), imgNames...),
					Model:         trace.Model,
				}
				cur.Steps[i].VerifyHistory = append(cur.Steps[i].VerifyHistory, attempt)
				// Accumulate all verified facts across prior + current rounds onto the active proposal card so the UI clearly shows what AI already remembers.
				prop.VerifiedFacts = collectCumulativeVerifiedFacts(&cur.Steps[i])
				cur.Steps[i].Status = "failed"
				cur.Steps[i].VerifiedByAI = false
				cur.Steps[i].LastError = savedErr
				if len(imgNames) > 0 {
					cur.Steps[i].ErrorImages = imgNames
				}
				trCopy := trace
				cur.Steps[i].TroubleTrace = &trCopy
				p := prop
				cur.Steps[i].Proposal = &p
				break
			}
		}
	}
	err = s.saveRehearsal(cur)
	rehearsalMu.Unlock()
	if err != nil {
		failRehearsalResp(s, w, ev, 500, "保存核验结果失败")
		return
	}
	s.auditReq(r, "rehearsal-verify-"+verdict, session.User, f.ID+" "+rid+" "+sid)
	finishRehearsalResp(w, ev, 200, cur)
}

const rehearsalTroubleSystem = `你是资深中间件变更排障专家。工程师正在测试环境按演练步骤验证变更方案，某一步执行报错（包含报错文本或终端截图）。
请先在 JSON 第一个字段 thinking 中简明写出你的报错信号提取、环境/权限/状态根因推理过程，然后给出可直接采纳的修正提案：
- 若当前步骤本身的命令参数、路径、权限或语法需要调整，action 设为 "replace"，给出修正后的完整命令；
- 若报错是因为缺少一个前置准备步骤（例如需要先创建目录、暂停守护、释放锁或检查依赖），action 设为 "insert_before"，给出需要插入在此步骤之前的前置步骤标题、目标角色、命令与判据。
- 若给出的 command 包含 2 条及以上命令（尤其含 sudo/psql/patronictl/sleep），请整块包裹在 ( ... ) </dev/null 中（严禁裸写多行或 bash <<'EOF'），防止堡垒机/WebSSH 粘贴时后续行被吞或输出交错。
严格只输出一个 JSON 对象：
{"thinking":"1. 报错信号识别...；2. 根因定位...；3. 修订方案推演...","diagnosis":"简明准确的报错根因诊断","action":"replace|insert_before","title":"前置步骤标题（insert_before时必填）","target_role":"执行角色","command":"修正后或新增前置的完整命令","expect":"成功判据","rollback":"回退命令（可选）","risk_note":"注意事项（可选）"}`

func (s *storeServer) troubleshootRehearsalStep(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid, sid string) {
	var in struct {
		ErrorOutput string     `json:"error_output"`
		Images      []string   `json:"images"`
		Model       string     `json:"model"`
		Effort      thinkLevel `json:"effort"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 28<<20)).Decode(&in) != nil {
		s.fail(w, 400, "提交的内容格式不对或图片超过大小限制")
		return
	}
	errOut := aiScrub(truncRunes(strings.TrimSpace(in.ErrorOutput), 8000))
	if errOut == "" && len(in.Images) == 0 {
		s.fail(w, 400, "请粘贴测试环境执行报错信息或上传/粘贴报错截图")
		return
	}
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	rehearsalMu.Unlock()
	if !ok {
		s.fail(w, 404, "演练会话不存在")
		return
	}
	var target *rehearsalStep
	for i := range rh.Steps {
		if rh.Steps[i].ID == sid {
			cp := rh.Steps[i]
			target = &cp
			break
		}
	}
	if target == nil {
		s.fail(w, 404, "演练步骤不存在")
		return
	}
	lang := reqLang(r)
	providers, code, err := s.rehearsalCheckAILang(session.User, len(in.Images) > 0, in.Model, lang)
	if err != nil {
		s.fail(w, code, err.Error())
		return
	}
	imgNames, err := s.storeRehearsalImages(f.ID, rid, in.Images)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}

	ev := startRehearsalSSE(w, r)
	baseline, red := s.clusterBaselinePrompt(f)
	errDesc := errOut
	if errDesc == "" && len(imgNames) > 0 {
		errDesc = fmt.Sprintf("（详见附带的 %d 张报错终端截图）", len(imgNames))
	} else if len(imgNames) > 0 {
		errDesc += fmt.Sprintf("\n（同时附带 %d 张现场报错终端截图，请结合截图识别完整报错上下文）", len(imgNames))
	}
	priorStepsBlock := buildPriorStepsContext(&rh, target.ID)
	historyBlock := buildVerifyHistoryPrompt(target)
	prompt := fmt.Sprintf("【集群基线】\n%s\n\n【演练目标】\n%s%s\n\n【当前受阻步骤】\n步骤序号：#%d\n阶段：%s\n标题：%s\n执行对象：%s\n原命令：\n%s\n预期判据：%s%s\n\n【测试环境实际报错输出（已脱敏）】\n%s",
		baseline, rh.Goal, priorStepsBlock, target.Order, target.Phase, target.Title, target.TargetRole, target.Command, target.Expect, historyBlock, errDesc)

	pipeSpec := rehearsalPipelineSpec{
		PreSteps: []rehearsalTraceStep{
			{
				ID:     "inspect-step-err",
				Kind:   "inspect",
				Title:  tr(lang, "定位受阻步骤与报错证据", "Locate blocked step & error evidence"),
				Detail: tr(lang, fmt.Sprintf("步骤 #%d「%s」· 执行对象：%s", target.Order, target.Title, target.TargetRole), fmt.Sprintf("Step #%d \"%s\" · Target: %s", target.Order, target.Title, target.TargetRole)),
				MS:     1,
				OK:     true,
				Status: "done",
			},
			{
				ID:     "scrub-err-context",
				Kind:   "guard",
				Title:  tr(lang, "报错回显脱敏与上下文封装", "Scrub error output & package context"),
				Detail: tr(lang, "剥离报错输出中的敏感凭据，锁定演练步骤预期判据", "Stripped sensitive credentials from error logs and anchored expected pass criteria"),
				MS:     1,
				OK:     true,
				Status: "done",
			},
		},
		ThinkTitle: tr(lang, "诊断报错信号与环境根因推理", "Diagnose error signals & root cause"),
		ThinkWait:  tr(lang, "正在提取终端报错信号并定位配置、权限或环境根因…", "Extracting terminal error signals to isolate configuration, permission, or environment root causes..."),
		SynthID:    "propose-fix",
		SynthKind:  "synthesize",
		SynthTitle: tr(lang, "生成命令修订提案", "Draft command fix proposal"),
		SynthWait:  tr(lang, "等待根因明确后生成就地替换或前置步骤命令", "Drafting in-place command fix or prerequisite step once root cause is clear..."),
		Validate: func(outText string) error {
			var chk struct {
				rehearsalStepProposal
			}
			if raw := extractJSON(outText); raw != "" {
				_ = json.Unmarshal([]byte(raw), &chk)
			}
			if strings.TrimSpace(chk.Command) == "" || strings.TrimSpace(chk.Diagnosis) == "" {
				return fmt.Errorf("%s", tr(lang, "模型未能给出有效的修正命令提案（响应可能被截断或格式不完整），请重试", "Model failed to return a valid fix proposal (truncated or incomplete JSON); please retry"))
			}
			return nil
		},
	}

	skillBlock, _ := s.rehearsalSkillBlock(session.User, f, rh.Goal, rh.SecurityContext)
	text, trace, code, err := s.rehearsalRunAI(r, providers, session.User, f.ID, rid+"/troubleshoot/"+sid, "troubleshoot", red, rehearsalTroubleSystem+skillBlock, prompt, in.Images, pipeSpec, in.Effort, ev)
	if err != nil {
		failRehearsalResp(s, w, ev, code, err.Error(), aiDiagFromErr(err), trace.Diag)
		return
	}
	parseStart := time.Now()
	var parsed struct {
		rehearsalStepProposal
		Thinking string `json:"thinking"`
	}
	if raw := extractJSON(text); raw != "" {
		_ = json.Unmarshal([]byte(raw), &parsed)
	}
	prop := parsed.rehearsalStepProposal
	prop.Command = ensurePasteSafeShellCommand(prop.Command)
	prop.Diagnosis = truncRunes(strings.TrimSpace(prop.Diagnosis), 600)
	if prop.Command == "" || prop.Diagnosis == "" {
		failRehearsalResp(s, w, ev, 502, "模型未能给出有效的修正命令提案，请补充更完整的报错信息或截图重试", trace.Diag)
		return
	}
	if prop.Action != "insert_before" {
		prop.Action = "replace"
	}
	if trace.Thinking == "" {
		trace.Thinking = firstNonEmptyStr(strings.TrimSpace(parsed.Thinking), prop.Diagnosis)
	}
	finalizeTraceSynth(
		&trace,
		ev,
		"propose-fix",
		map[string]string{
			"replace":       tr(lang, "就地修正本步命令", "Update step command in place"),
			"insert_before": tr(lang, "在此步骤前插入前置准备步骤", "Insert prerequisite step before this step"),
		}[prop.Action],
		true,
		max(1, time.Since(parseStart).Milliseconds()),
	)

	rehearsalMu.Lock()
	cur, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		failRehearsalResp(s, w, ev, 404, "演练会话不存在")
		return
	}
	savedErr := errOut
	if savedErr == "" && len(imgNames) > 0 {
		savedErr = tr(lang, fmt.Sprintf("（已上传 %d 张报错截图）", len(imgNames)), fmt.Sprintf("(Uploaded %d error screenshot(s))", len(imgNames)))
	}
	for i := range cur.Steps {
		if cur.Steps[i].ID == sid {
			cur.Steps[i].Status = "failed"
			cur.Steps[i].LastError = savedErr
			if len(imgNames) > 0 {
				cur.Steps[i].ErrorImages = imgNames
			}
			trCopy := trace
			cur.Steps[i].TroubleTrace = &trCopy
			p := prop
			cur.Steps[i].Proposal = &p
			break
		}
	}
	err = s.saveRehearsal(cur)
	rehearsalMu.Unlock()
	if err != nil {
		failRehearsalResp(s, w, ev, 500, "保存排障提案失败")
		return
	}
	s.auditReq(r, "rehearsal-troubleshoot", session.User, f.ID+" "+rid+" "+sid)
	finishRehearsalResp(w, ev, 200, cur)
}

func (s *storeServer) applyRehearsalProposal(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid, sid string) {
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		s.fail(w, 404, "演练会话不存在")
		return
	}
	idx := -1
	for i := range rh.Steps {
		if rh.Steps[i].ID == sid {
			idx = i
			break
		}
	}
	if idx < 0 || rh.Steps[idx].Proposal == nil {
		rehearsalMu.Unlock()
		s.fail(w, 409, "当前步骤没有待采纳的排障提案")
		return
	}
	lang := reqLang(r)
	st := rh.Steps[idx]
	prop := *st.Proposal
	now := nowStamp()
	if prop.Action == "insert_before" {
		newID := fmt.Sprintf("pre-%s-%d", st.ID, len(st.Revisions)+1)
		inserted := rehearsalStep{
			ID:         newID,
			Phase:      st.Phase,
			Title:      firstNonEmptyStr(truncRunes(strings.TrimSpace(prop.Title), 120), tr(lang, "前置准备：", "Prerequisite: ")+st.Title),
			TargetRole: firstNonEmptyStr(strings.TrimSpace(prop.TargetRole), st.TargetRole),
			Command:    prop.Command,
			Expect:     firstNonEmptyStr(strings.TrimSpace(prop.Expect), tr(lang, "命令执行成功，无报错", "Command succeeds with no errors")),
			RiskNote:   strings.TrimSpace(prop.RiskNote),
			Rollback:   strings.TrimSpace(prop.Rollback),
			Status:     "pending",
		}
		rh.Steps[idx].Revisions = append(rh.Steps[idx].Revisions, rehearsalStepRevision{
			At:           now,
			By:           session.User,
			ErrorSnippet: truncRunes(st.LastError, 300),
			Diagnosis:    tr(lang, "插入前置步骤「"+inserted.Title+"」："+prop.Diagnosis, "Inserted prerequisite step \""+inserted.Title+"\": "+prop.Diagnosis),
			OldCommand:   st.Command,
			NewCommand:   prop.Command,
		})
		rh.Steps[idx].Status = "pending"
		rh.Steps[idx].Proposal = nil
		next := make([]rehearsalStep, 0, len(rh.Steps)+1)
		next = append(next, rh.Steps[:idx]...)
		next = append(next, inserted)
		next = append(next, rh.Steps[idx:]...)
		for i := range next {
			next[i].Order = i + 1
		}
		rh.Steps = next
	} else {
		rh.Steps[idx].Revisions = append(rh.Steps[idx].Revisions, rehearsalStepRevision{
			At:           now,
			By:           session.User,
			ErrorSnippet: truncRunes(st.LastError, 300),
			Diagnosis:    prop.Diagnosis,
			OldCommand:   st.Command,
			NewCommand:   prop.Command,
		})
		rh.Steps[idx].Command = prop.Command
		if strings.TrimSpace(prop.Expect) != "" {
			rh.Steps[idx].Expect = truncRunes(strings.TrimSpace(prop.Expect), 300)
		}
		if strings.TrimSpace(prop.Rollback) != "" {
			rh.Steps[idx].Rollback = strings.TrimSpace(prop.Rollback)
		}
		if strings.TrimSpace(prop.RiskNote) != "" {
			rh.Steps[idx].RiskNote = truncRunes(strings.TrimSpace(prop.RiskNote), 300)
		}
		rh.Steps[idx].Status = "pending"
		rh.Steps[idx].Proposal = nil
	}
	err := s.saveRehearsal(rh)
	rehearsalMu.Unlock()
	if err != nil {
		s.fail(w, 500, "采纳修正提案失败")
		return
	}
	s.auditReq(r, "rehearsal-apply", session.User, f.ID+" "+rid+" "+sid)
	rh.RestorationAlerts = auditRehearsalRestorations(rh.Goal, rh.ExtraScope, rh.Steps, reqLang(r))
	s.writeJSON(w, 200, rh)
}

func (s *storeServer) finalizeRehearsal(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string) {
	var in struct {
		TestEnvNote string `json:"test_env_note"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in)

	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		s.fail(w, 404, "演练会话不存在")
		return
	}
	reqCount, pendingCount := 0, 0
	for _, st := range rh.Steps {
		if st.Optional || st.Phase == "rollback" {
			continue
		}
		reqCount++
		if st.Status != "passed" && st.Status != "skipped" {
			pendingCount++
		}
	}
	if reqCount == 0 || pendingCount > 0 {
		rehearsalMu.Unlock()
		s.fail(w, 409, fmt.Sprintf("还有 %d 个必测演练步骤未验证通过，请先在测试环境完成演练后再定稿生产 SOP", pendingCount))
		return
	}
	if note := strings.TrimSpace(in.TestEnvNote); note != "" {
		rh.TestEnvNote = truncRunes(note, 1000)
	}
	docID := "sop-" + rh.ID
	rh.DocID = docID
	rh.Stage = "finalized"
	// Untouched emergency rollback steps default to auto-skipped once forward steps pass;
	// their full commands remain included in Section 5 of the finalized SOP / Change Report.
	for i := range rh.Steps {
		if rh.Steps[i].Phase == "rollback" && rh.Steps[i].Status == "pending" {
			rh.Steps[i].Status = "skipped"
			if strings.TrimSpace(rh.Steps[i].Note) == "" {
				rh.Steps[i].Note = "正向步骤已全部验收通过，应急回退预案默认自动跳过（完整回退命令已自动收录至方案第 5 节）。"
			}
		}
	}
	if len(rh.BaseAppliedIDs) == 0 {
		for _, prev := range s.listAppliedRehearsals(f.ID) {
			if prev.ID != rh.ID {
				rh.BaseAppliedIDs = append(rh.BaseAppliedIDs, prev.ID)
			}
		}
	}
	err := s.saveRehearsal(rh)
	rehearsalMu.Unlock()
	if err != nil {
		s.fail(w, 500, "定稿生产变更实施方案失败")
		return
	}

	// Pre-populate editable overview & signoff sections on first finalize so the generated SOP is immediately complete
	// for Word export while remaining editable in the cluster's Documents center.
	lang := reqLang(r)
	saved := s.docLoad(f.ID, docID)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, exists := saved.Sections["overview"]; !exists {
		overview := rh.Goal
		if rh.ScopeSummary != "" {
			overview += tr(lang, "\n边界说明：", "\nScope Summary: ") + rh.ScopeSummary
		}
		saved.Sections["overview"] = docSection{Text: overview, Source: "user", Confirmed: true, By: session.User, At: now, Basis: f.Current.ID}
	}
	if _, exists := saved.Sections["signoff"]; !exists {
		signoff := tr(lang,
			fmt.Sprintf("本方案已由 %s 在测试环境完成全部必测步骤演练并核验通过。生产执行窗口内如遇单步超出预期耗时 2 倍或核心业务指标异常，立即按第 5 节应急回退预案执行回退。", session.User),
			fmt.Sprintf("All required rehearsal steps have been validated and verified in staging by %s. During production execution, if any step exceeds 2x expected duration or critical business KPIs degrade, immediately execute Section 5 rollback procedures.", session.User),
		)
		saved.Sections["signoff"] = docSection{Text: signoff, Source: "user", Confirmed: true, By: session.User, At: now, Basis: f.Current.ID}
	}
	_ = s.docSave(f.ID, docID, saved)

	s.auditReq(r, "rehearsal-finalize", session.User, f.ID+" "+docID)
	rh.RestorationAlerts = auditRehearsalRestorations(rh.Goal, rh.ExtraScope, rh.Steps, reqLang(r))
	rh.ConflictAlerts = computeRehearsalConflicts(rh, s.listRehearsals(f.ID), reqLang(r))
	s.writeJSON(w, 200, rh)
}

var (
	reAppliedPatroniKV = regexp.MustCompile(`(?i)(?:^|\s)-[ps]\s+(?:'([a-zA-Z0-9_.-]+)=([^']+)'|"([a-zA-Z0-9_.-]+)=([^"]+)"|([a-zA-Z0-9_.-]+)=(?:'([^']+)'|"([^"]+)"|([^\s'"\\]+)))`)
	reAppliedAlterSys  = regexp.MustCompile(`(?i)\bALTER\s+SYSTEM\s+SET\s+([a-zA-Z0-9_.-]+)\s*(?:=|TO)\s*'?([^';\n]+)'?`)
	reAppliedRedisCfg  = regexp.MustCompile(`(?i)\bCONFIG\s+SET\s+([a-zA-Z0-9_.-]+)\s+([^\s'"\n;]+)`)
	reAppliedHBA       = regexp.MustCompile(`(?i)\b(pg_hba|hostssl\s+\S+|hostnossl\s+\S+|host\s+\S+)`)
	reAppliedHBARule   = regexp.MustCompile(`(?i)\b((?:hostssl|hostnossl|hostgssenc|hostnogssenc|host|local)\s+[a-zA-Z0-9_,.-]+\s+[a-zA-Z0-9_,.-]+(?:\s+[0-9a-fA-F.:\/]+(?:\s+[0-9.]+)?)?\s+(?:scram-sha-256|md5|trust|reject|peer|ident|cert|ldap|radius|pam|password))\b`)
)

func matchPatroniKV(m []string) (string, string) {
	if len(m) < 9 {
		return "", ""
	}
	if m[1] != "" {
		return m[1], m[2]
	}
	if m[3] != "" {
		return m[3], m[4]
	}
	if m[5] != "" {
		return m[5], firstNonEmptyStr(m[6], m[7], m[8])
	}
	return "", ""
}

func extractHBARuleDisplay(rh changeRehearsal, st rehearsalStep) string {
	for _, src := range []string{st.Command, st.Note, rh.Goal, rh.Title} {
		if m := reAppliedHBARule.FindStringSubmatch(src); len(m) >= 2 {
			rule := strings.Join(strings.Fields(m[1]), " ")
			prefix := "+ "
			low := strings.ToLower(rh.Title + " " + st.Title)
			if strings.Contains(low, "删除") || strings.Contains(low, "移除") || strings.Contains(low, "remove") || strings.Contains(low, "revoke") {
				prefix = "- "
			}
			return truncRunes(prefix+rule, 120)
		}
	}
	return truncRunes(firstNonEmptyStr(strings.TrimSpace(rh.Title), strings.TrimSpace(st.Title)), 100)
}

// extractDefaultAppliedChanges derives a concise production-change summary and structured key/before/after
// entries from a finalized rehearsal's security context, drift diff, and executed steps.
func extractDefaultAppliedChanges(rh changeRehearsal) (string, []rehearsalAppliedChange) {
	var execNotes []string
	for _, st := range rh.Steps {
		if st.Phase == "execute" && st.Status == "passed" && strings.TrimSpace(st.Note) != "" {
			n := strings.TrimRight(strings.TrimSpace(st.Note), "。；; ")
			if n != "" {
				execNotes = append(execNotes, n)
			}
		}
	}
	joinedNotes := strings.Join(execNotes, "；")
	if joinedNotes != "" {
		joinedNotes += "。"
	}
	scopeSum := strings.TrimSpace(rh.ScopeSummary)
	if strings.Contains(scopeSum, "探针") || strings.Contains(scopeSum, "不改变任何") || strings.Contains(scopeSum, "只读采集") {
		scopeSum = ""
	}
	summary := truncRunes(firstNonEmptyStr(joinedNotes, scopeSum, strings.TrimSpace(rh.Title), strings.TrimSpace(rh.Goal)), 240)
	beforeMap := map[string]string{}
	hbaBefore := ""
	if rh.Drift != nil {
		for _, p := range rh.Drift.ParamDiffs {
			k := strings.TrimSpace(p.Key)
			if k == "" {
				continue
			}
			val := firstNonEmptyStr(strings.TrimSpace(p.Actual), strings.TrimSpace(p.Initial))
			if val != "" {
				lk := strings.ToLower(k)
				beforeMap[lk] = truncRunes(val, 80)
				if hbaBefore == "" && strings.Contains(lk, "pg_hba") {
					hbaBefore = truncRunes(val, 80)
				}
			}
		}
	}
	if hbaBefore != "" && beforeMap["pg_hba"] == "" {
		beforeMap["pg_hba"] = hbaBefore
	}
	var out []rehearsalAppliedChange
	seen := map[string]bool{}
	add := func(k, before, after, note string) {
		k = truncRunes(strings.TrimSpace(k), 64)
		after = truncRunes(strings.TrimSpace(after), 120)
		before = truncRunes(strings.TrimSpace(before), 80)
		note = truncRunes(strings.TrimSpace(note), 120)
		if k == "" || after == "" || len(out) >= 12 {
			return
		}
		lk := strings.ToLower(k)
		if seen[lk] {
			return
		}
		seen[lk] = true
		if before == "" {
			before = beforeMap[lk]
		}
		out = append(out, rehearsalAppliedChange{Key: k, Before: before, After: after, Note: note})
	}
	if sc := rh.SecurityContext; sc != nil && sc.Package != "" && sc.TargetVersion != "" {
		note := ""
		if len(sc.CVEs) > 0 {
			note = strings.Join(sc.CVEs[:min(3, len(sc.CVEs))], ", ")
		}
		add(sc.Package, sc.CurrentVersion, sc.TargetVersion, note)
	}
	for _, st := range rh.Steps {
		if st.Phase != "execute" || st.Status == "skipped" {
			continue
		}
		for _, m := range reAppliedPatroniKV.FindAllStringSubmatch(st.Command, -1) {
			if k, v := matchPatroniKV(m); k != "" && v != "" {
				add(k, "", v, "")
			}
		}
		for _, m := range reAppliedAlterSys.FindAllStringSubmatch(st.Command, -1) {
			if len(m) >= 3 {
				add(m[1], "", m[2], "")
			}
		}
		for _, m := range reAppliedRedisCfg.FindAllStringSubmatch(st.Command, -1) {
			if len(m) >= 3 {
				add(m[1], "", m[2], "")
			}
		}
		if reAppliedHBA.MatchString(st.Command) && !seen["pg_hba"] {
			add("pg_hba", "", extractHBARuleDisplay(rh, st), "")
		}
	}
	return summary, out
}

func cleanAppliedChanges(in []rehearsalAppliedChange) []rehearsalAppliedChange {
	var out []rehearsalAppliedChange
	for _, c := range in {
		k := truncRunes(strings.TrimSpace(c.Key), 64)
		a := truncRunes(strings.TrimSpace(c.After), 160)
		if k == "" && a == "" {
			continue
		}
		if k == "" {
			k = "变更项"
		}
		out = append(out, rehearsalAppliedChange{
			Key:    k,
			Before: truncRunes(strings.TrimSpace(c.Before), 120),
			After:  a,
			Note:   truncRunes(strings.TrimSpace(c.Note), 200),
		})
		if len(out) >= 20 {
			break
		}
	}
	return out
}

func (s *storeServer) listAppliedRehearsals(cluster string) []changeRehearsal {
	all := s.listRehearsals(cluster)
	var out []changeRehearsal
	for _, rh := range all {
		if rh.Stage == "finalized" && rh.Applied && !rh.Voided {
			out = append(out, rh)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		ai := firstNonEmptyStr(out[i].AppliedAt, out[i].UpdatedAt)
		aj := firstNonEmptyStr(out[j].AppliedAt, out[j].UpdatedAt)
		return ai < aj
	})
	return out
}

type effectiveClusterChange struct {
	Key         string
	Before      string
	After       string
	SourceID    string
	SourceTitle string
	AppliedAt   string
	AppliedBy   string
	UpdateCount int
}

// effectiveAppliedChanges chronologically folds applied parameter/config deltas by lowercase key
// so later production changes supersede earlier values for the same key.
func effectiveAppliedChanges(applied []changeRehearsal) []effectiveClusterChange {
	var order []string
	byKey := map[string]*effectiveClusterChange{}
	for _, rh := range applied {
		at := firstNonEmptyStr(rh.AppliedAt, rh.UpdatedAt)
		by := firstNonEmptyStr(rh.AppliedBy, rh.Owner)
		for _, ch := range rh.AppliedChanges {
			k := strings.TrimSpace(ch.Key)
			if k == "" {
				continue
			}
			lk := strings.ToLower(k)
			if cur, ok := byKey[lk]; ok {
				cur.After = ch.After
				cur.SourceID = rh.ID
				cur.SourceTitle = rh.Title
				cur.AppliedAt = at
				cur.AppliedBy = by
				cur.UpdateCount++
			} else {
				order = append(order, lk)
				byKey[lk] = &effectiveClusterChange{
					Key:         k,
					Before:      ch.Before,
					After:       ch.After,
					SourceID:    rh.ID,
					SourceTitle: rh.Title,
					AppliedAt:   at,
					AppliedBy:   by,
					UpdateCount: 1,
				}
			}
		}
	}
	out := make([]effectiveClusterChange, 0, len(order))
	for _, lk := range order {
		out = append(out, *byKey[lk])
	}
	return out
}

func rehearsalTopicKeys(rh changeRehearsal) map[string]string {
	keys := map[string]string{}
	add := func(k string) {
		k = strings.TrimSpace(k)
		if k == "" {
			return
		}
		lk := strings.ToLower(k)
		if _, ok := keys[lk]; !ok {
			keys[lk] = k
		}
	}
	for _, ch := range rh.AppliedChanges {
		add(ch.Key)
	}
	if len(rh.AppliedChanges) == 0 {
		_, def := extractDefaultAppliedChanges(rh)
		for _, ch := range def {
			add(ch.Key)
		}
	}
	var execCmd strings.Builder
	for _, st := range rh.Steps {
		if st.Phase != "execute" || st.Status == "skipped" {
			continue
		}
		execCmd.WriteString(st.Command)
		execCmd.WriteByte('\n')
	}
	txt := execCmd.String()
	if reAppliedHBA.MatchString(txt) {
		add("pg_hba")
	}
	if strings.Contains(strings.ToLower(txt), "haproxy.cfg") {
		add("haproxy.cfg")
	}
	if strings.Contains(strings.ToLower(txt), "nginx.conf") || strings.Contains(strings.ToLower(txt), "stream.d") {
		add("nginx配置")
	}
	// Only add generic Patroni DCS tag when no specific parameter / pg_hba key was extracted
	// so unrelated Patroni changes (e.g., logging_collector vs pg_hba) never falsely collide.
	if len(keys) == 0 && (strings.Contains(strings.ToLower(txt), "patroni.yml") || strings.Contains(strings.ToLower(txt), "edit-config")) {
		add("Patroni DCS配置")
	}
	return keys
}

// computeRehearsalConflicts checks an unapplied, non-voided rehearsal against peer rehearsals on the same cluster:
//  1. conflict: a peer change was applied to production after this plan's baseline and touches overlapping config keys/topics
//  2. stale: a peer change was applied after this plan's baseline (even without overlapping keys)
//  3. earlier_pending: an earlier finalized peer plan is still waiting to be applied (order / dependency check)
func computeRehearsalConflicts(rh changeRehearsal, peers []changeRehearsal, lang string) []rehearsalConflictAlert {
	if rh.Applied || rh.Voided || len(peers) <= 1 {
		return nil
	}
	baseSet := map[string]bool{}
	for _, bid := range rh.BaseAppliedIDs {
		baseSet[bid] = true
	}
	myKeys := rehearsalTopicKeys(rh)
	var alerts []rehearsalConflictAlert
	for _, other := range peers {
		if other.ID == rh.ID || other.Voided {
			continue
		}
		if other.Stage == "finalized" && other.Applied {
			// Skip peers that were already applied BEFORE this rehearsal's snapshot
			if baseSet[other.ID] {
				continue
			}
			otherAt := firstNonEmptyStr(other.AppliedAt, other.UpdatedAt)
			// For legacy rehearsals without BaseAppliedIDs, compare against CreatedAt/UpdatedAt
			if len(rh.BaseAppliedIDs) == 0 && rh.CreatedAt != "" && otherAt != "" && otherAt < rh.CreatedAt {
				continue
			}
			otherKeys := rehearsalTopicKeys(other)
			var overlap []string
			for lk, display := range myKeys {
				if _, hit := otherKeys[lk]; hit {
					overlap = append(overlap, display)
				}
			}
			sort.Strings(overlap)
			if len(overlap) > 0 {
				alerts = append(alerts, rehearsalConflictAlert{
					Severity:        "conflict",
					OtherID:         other.ID,
					OtherTitle:      other.Title,
					OtherAt:         otherAt,
					OverlappingKeys: overlap,
					Summary: tr(lang,
						fmt.Sprintf("冲突预警：已落地变更「%s」与本方案均涉及 %s，直接照旧执行可能覆盖最新配置", other.Title, strings.Join(overlap, "、")),
						fmt.Sprintf("Conflict: applied change %q also touches %s; running as-is may overwrite newer settings", other.Title, strings.Join(overlap, ", ")),
					),
				})
			} else {
				alerts = append(alerts, rehearsalConflictAlert{
					Severity:   "stale",
					OtherID:    other.ID,
					OtherTitle: other.Title,
					OtherAt:    otherAt,
					Summary: tr(lang,
						fmt.Sprintf("集群状态已更新：本方案生成后，集群已落地变更「%s」，执行前建议核对拓扑与参数现状", other.Title),
						fmt.Sprintf("Cluster updated: %q was applied after this plan was drafted; verify live state before running", other.Title),
					),
				})
			}
		} else if rh.Stage == "finalized" && other.Stage == "finalized" && !other.Applied && other.CreatedAt != "" && rh.CreatedAt != "" && other.CreatedAt < rh.CreatedAt {
			otherKeys := rehearsalTopicKeys(other)
			var overlap []string
			for lk, display := range myKeys {
				if _, hit := otherKeys[lk]; hit {
					overlap = append(overlap, display)
				}
			}
			sort.Strings(overlap)
			if len(overlap) > 0 {
				alerts = append(alerts, rehearsalConflictAlert{
					Severity:        "earlier_pending",
					OtherID:         other.ID,
					OtherTitle:      other.Title,
					OtherAt:         other.UpdatedAt,
					OverlappingKeys: overlap,
					Summary: tr(lang,
						fmt.Sprintf("同配置待实施提醒：同集群还有更早定稿的方案「%s」也涉及 %s，请确认先后执行顺序，或判断旧方案是否已被替代", other.Title, strings.Join(overlap, "、")),
						fmt.Sprintf("Overlapping pending plan: earlier finalized plan %q also touches %s; verify order or whether it is superseded", other.Title, strings.Join(overlap, ", ")),
					),
				})
			}
		}
	}
	prio := map[string]int{"conflict": 0, "stale": 1, "earlier_pending": 2}
	sort.Slice(alerts, func(i, j int) bool {
		if prio[alerts[i].Severity] != prio[alerts[j].Severity] {
			return prio[alerts[i].Severity] < prio[alerts[j].Severity]
		}
		return alerts[i].OtherAt > alerts[j].OtherAt
	})
	return alerts
}

// applyRehearsalProduction confirms (or reverts) that a finalized Change SOP / Change Report has been executed
// in production so the change reflects immediately in Cluster Overview, Config, Delivery Report, and future AI context.
func (s *storeServer) applyRehearsalProduction(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string) {
	var in struct {
		Applied      *bool                    `json:"applied"`
		Summary      string                   `json:"summary"`
		Note         string                   `json:"note"`
		Changes      []rehearsalAppliedChange `json:"changes"`
		SupersedeIDs []string                 `json:"supersede_ids"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil && err.Error() != "EOF" {
		s.fail(w, 400, "提交的内容格式不对")
		return
	}
	wantApplied := true
	if in.Applied != nil {
		wantApplied = *in.Applied
	}

	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		s.fail(w, 404, "演练会话不存在")
		return
	}
	if wantApplied && rh.Voided {
		rehearsalMu.Unlock()
		s.fail(w, 409, "该方案已标记为作废，如需执行请先恢复为待实施状态")
		return
	}
	if wantApplied && rh.Stage != "finalized" {
		rehearsalMu.Unlock()
		s.fail(w, 409, "请先定稿实施方案或生成变更报告，再确认生产已实施落地")
		return
	}
	if wantApplied {
		defSummary, defChanges := extractDefaultAppliedChanges(rh)
		rh.Applied = true
		if rh.AppliedAt == "" {
			rh.AppliedAt = nowStamp()
		}
		rh.AppliedBy = session.User
		rh.AppliedNote = truncRunes(strings.TrimSpace(in.Note), 1000)
		if strings.TrimSpace(in.Summary) != "" {
			rh.AppliedSummary = truncRunes(strings.TrimSpace(in.Summary), 500)
		} else if rh.AppliedSummary == "" {
			rh.AppliedSummary = defSummary
		}
		if in.Changes != nil {
			rh.AppliedChanges = cleanAppliedChanges(in.Changes)
		} else if len(rh.AppliedChanges) == 0 {
			rh.AppliedChanges = defChanges
		}
		// Atomically mark user-selected obsolete peer plans as superseded/voided
		for _, sid := range in.SupersedeIDs {
			sid = strings.TrimSpace(sid)
			if sid == "" || sid == rh.ID || !reRehearsalID.MatchString(sid) {
				continue
			}
			if old, exists := s.loadRehearsal(f.ID, sid); exists && !old.Applied && !old.Voided {
				old.Voided = true
				old.VoidedAt = nowStamp()
				old.VoidedBy = session.User
				old.SupersededBy = rh.ID
				old.SupersededTitle = rh.Title
				old.VoidReason = fmt.Sprintf("已被已落地变更「%s」替代", rh.Title)
				_ = s.saveRehearsal(old)
			}
		}
	} else {
		rh.Applied = false
		rh.AppliedAt = ""
		rh.AppliedBy = ""
		rh.AppliedNote = ""
		rh.AppliedSummary = ""
		rh.AppliedChanges = nil
	}
	err := s.saveRehearsal(rh)
	peers := s.listRehearsals(f.ID)
	rehearsalMu.Unlock()
	if err != nil {
		s.fail(w, 500, "保存生产落地状态失败")
		return
	}
	action := "rehearsal-apply-prod"
	if !wantApplied {
		action = "rehearsal-unapply-prod"
	}
	s.auditReq(r, action, session.User, f.ID+" "+rid)
	lang := reqLang(r)
	rh.RestorationAlerts = auditRehearsalRestorations(rh.Goal, rh.ExtraScope, rh.Steps, lang)
	rh.ConflictAlerts = computeRehearsalConflicts(rh, peers, lang)
	s.writeJSON(w, 200, rh)
}

// voidRehearsal marks a non-applied rehearsal plan as void/obsolete (or restores it back to active/pending)
// so obsolete plans are visually separated and locked against accidental production sign-off.
func (s *storeServer) voidRehearsal(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string) {
	var in struct {
		Voided       *bool  `json:"voided"`
		Reason       string `json:"reason"`
		SupersededBy string `json:"superseded_by"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil && err.Error() != "EOF" {
		s.fail(w, 400, "提交的内容格式不对")
		return
	}
	wantVoid := true
	if in.Voided != nil {
		wantVoid = *in.Voided
	}
	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		s.fail(w, 404, "演练会话不存在")
		return
	}
	if wantVoid && rh.Applied {
		rehearsalMu.Unlock()
		s.fail(w, 409, "该方案已确认生产落地，请先撤销落地标记后再作废")
		return
	}
	if wantVoid {
		rh.Voided = true
		rh.VoidedAt = nowStamp()
		rh.VoidedBy = session.User
		rh.VoidReason = truncRunes(strings.TrimSpace(in.Reason), 300)
		if sid := strings.TrimSpace(in.SupersededBy); sid != "" && sid != rh.ID && reRehearsalID.MatchString(sid) {
			if newer, exists := s.loadRehearsal(f.ID, sid); exists {
				rh.SupersededBy = newer.ID
				rh.SupersededTitle = newer.Title
				if rh.VoidReason == "" {
					rh.VoidReason = fmt.Sprintf("已被方案「%s」替代", newer.Title)
				}
			}
		}
		if rh.VoidReason == "" {
			rh.VoidReason = "手动标记作废，不再执行"
		}
	} else {
		rh.Voided = false
		rh.VoidedAt = ""
		rh.VoidedBy = ""
		rh.VoidReason = ""
		rh.SupersededBy = ""
		rh.SupersededTitle = ""
	}
	err := s.saveRehearsal(rh)
	peers := s.listRehearsals(f.ID)
	rehearsalMu.Unlock()
	if err != nil {
		s.fail(w, 500, "更新作废状态失败")
		return
	}
	act := "rehearsal-void"
	if !wantVoid {
		act = "rehearsal-restore"
	}
	s.auditReq(r, act, session.User, f.ID+" "+rid)
	lang := reqLang(r)
	rh.RestorationAlerts = auditRehearsalRestorations(rh.Goal, rh.ExtraScope, rh.Steps, lang)
	rh.ConflictAlerts = computeRehearsalConflicts(rh, peers, lang)
	s.writeJSON(w, 200, rh)
}

// syncRehearsalVEX writes VEX triage statuses back to Security Center linked with this rehearsal (and SOP doc when finalized).
func (s *storeServer) syncRehearsalVEX(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, rid string) {
	if !s.need(w, session.User, "security.manage") {
		return
	}
	var in struct {
		Status        string `json:"status"` // planned | mitigated | not_affected | accepted
		Justification string `json:"justification"`
		Note          string `json:"note"`
		ExpiresAt     string `json:"expires_at"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&in) != nil {
		s.fail(w, 400, "请求格式错误")
		return
	}
	in.Status = strings.ToLower(strings.TrimSpace(in.Status))
	in.Justification = strings.TrimSpace(in.Justification)
	in.Note = truncRunes(strings.TrimSpace(in.Note), 500)
	in.ExpiresAt = strings.TrimSpace(in.ExpiresAt)
	valid := map[string]bool{"planned": true, "mitigated": true, "not_affected": true, "accepted": true}
	if !valid[in.Status] {
		s.fail(w, 400, "请选择有效的 VEX 处置状态（planned / mitigated / not_affected / accepted）")
		return
	}
	if in.ExpiresAt != "" {
		if _, err := time.Parse("2006-01-02", in.ExpiresAt); err != nil {
			s.fail(w, 400, "豁免到期日期格式应为 YYYY-MM-DD")
			return
		}
	}

	rehearsalMu.Lock()
	rh, ok := s.loadRehearsal(f.ID, rid)
	if !ok {
		rehearsalMu.Unlock()
		s.fail(w, 404, "演练会话不存在")
		return
	}
	if rh.SecurityContext == nil || len(rh.SecurityContext.CVEs) == 0 {
		rehearsalMu.Unlock()
		s.fail(w, 400, "当前演练未关联具体 CVE 漏洞，无需回写 VEX")
		return
	}
	sc := rh.SecurityContext
	note := in.Note
	if note == "" {
		if rh.DocID != "" {
			note = fmt.Sprintf("已通过集群 %s 变更演练「%s」完成测试环境验证并固化生产 SOP（%s）。", f.ID, rh.Title, rh.DocID)
		} else {
			note = fmt.Sprintf("依据集群 %s 变更演练「%s」的现网只读探针/演练评估结果更新状态。", f.ID, rh.Title)
		}
	}
	stamp := now()
	updated := 0
	secDBMu.Lock()
	triageMap := s.loadSecTriage()
	for _, cve := range sc.CVEs {
		vid := strings.ToUpper(strings.TrimSpace(cve))
		if vid == "" {
			continue
		}
		key := vid
		if sc.Package != "" && sc.Ecosystem != "" {
			key = vid + "|" + strings.ToLower(sc.Package) + "|" + normalizeEcoKey(sc.Ecosystem)
		}
		prev := triageMap[key]
		hist := append([]secTriageEvent{{
			Status:    in.Status,
			Note:      note,
			ExpiresAt: in.ExpiresAt,
			By:        session.User,
			At:        stamp,
		}}, prev.History...)
		if len(hist) > 20 {
			hist = hist[:20]
		}
		triageMap[key] = secTriageRecord{
			Key:               key,
			VulnID:            vid,
			Package:           sc.Package,
			Ecosystem:         sc.Ecosystem,
			Status:            in.Status,
			Justification:     firstNonEmptyStr(in.Justification, "rehearsal_verified"),
			Note:              note,
			ExpiresAt:         in.ExpiresAt,
			LinkedClusterID:   f.ID,
			LinkedRehearsalID: rh.ID,
			LinkedSOPDocID:    rh.DocID,
			UpdatedBy:         session.User,
			UpdatedAt:         stamp,
			History:           hist,
		}
		updated++
	}
	err := s.saveSecTriage(triageMap)
	secDBMu.Unlock()
	if err != nil {
		rehearsalMu.Unlock()
		s.fail(w, 500, "回写安全中心 VEX 状态失败")
		return
	}
	sc.VEXSynced = true
	sc.VEXStatus = in.Status
	sc.VEXSyncedAt = stamp
	_ = s.saveRehearsal(rh)
	rehearsalMu.Unlock()

	s.auditReq(r, "rehearsal-sync-vex", session.User, fmt.Sprintf("%s %s -> %s (%d CVEs)", f.ID, rid, in.Status, updated))
	s.writeJSON(w, 200, map[string]any{
		"rehearsal": rh,
		"updated":   updated,
	})
}

// buildRehearsalSOP renders a finalized rehearsal session into a formal clusterDoc ("change" kind) for preview,
// section editing, and .docx Word export.
func (s *storeServer) buildRehearsalSOP(f clusterFacts, rid string) (*clusterDoc, bool) {
	lang := f.Lang
	rh, ok := s.loadRehearsal(f.ID, rid)
	if !ok || rh.Stage != "finalized" {
		return nil, false
	}
	coverRows := [][2]string{
		{tr(lang, "变更主题", "Change Topic"), rh.Title},
		{tr(lang, "演练负责人", "Rehearsal Owner"), rh.Owner},
		{tr(lang, "定稿时间", "Finalized"), stamp(rh.UpdatedAt)},
	}
	if rh.SecurityContext != nil {
		if len(rh.SecurityContext.CVEs) > 0 {
			coverRows = append(coverRows, [2]string{tr(lang, "关联安全漏洞", "Target CVEs"), strings.Join(rh.SecurityContext.CVEs, ", ")})
		}
		if rh.SecurityContext.Package != "" && rh.SecurityContext.TargetVersion != "" {
			coverRows = append(coverRows, [2]string{tr(lang, "目标修复版本", "Target Fix Version"), fmt.Sprintf("%s: %s → %s", rh.SecurityContext.Package, firstNonEmptyStr(rh.SecurityContext.CurrentVersion, "—"), rh.SecurityContext.TargetVersion)})
		}
	}
	docTitle := tr(lang, "生产变更实施方案", "Production Change SOP")
	if rh.Mode == "quick" || rh.Mode == "light" {
		docTitle = tr(lang, "变更报告", "Change Report")
	}
	modeLabel := tr(lang, "全量推演（生产 SOP）", "Full Rehearsal (Production SOP)")
	if rh.Mode == "quick" {
		modeLabel = tr(lang, "极速变更（直出步骤与报告）", "Quick Change (Direct Steps & Report)")
	} else if rh.Mode == "light" {
		modeLabel = tr(lang, "简单推演（探针核实与报告）", "Light Rehearsal (Probe & Report)")
	}
	coverRows = append(coverRows, [2]string{tr(lang, "变更模式", "Change Mode"), modeLabel})
	if rh.Applied {
		appliedLabel := tr(lang,
			fmt.Sprintf("已实施落地（%s 于 %s 确认）", firstNonEmptyStr(rh.AppliedBy, rh.Owner), stamp(firstNonEmptyStr(rh.AppliedAt, rh.UpdatedAt))),
			fmt.Sprintf("Applied to Production (confirmed by %s on %s)", firstNonEmptyStr(rh.AppliedBy, rh.Owner), stamp(firstNonEmptyStr(rh.AppliedAt, rh.UpdatedAt))),
		)
		coverRows = append(coverRows, [2]string{tr(lang, "生产落地状态", "Production Status"), appliedLabel})
	} else if rh.Voided {
		voidLabel := tr(lang,
			fmt.Sprintf("已作废（%s 于 %s 标记：%s）", firstNonEmptyStr(rh.VoidedBy, rh.Owner), stamp(firstNonEmptyStr(rh.VoidedAt, rh.UpdatedAt)), firstNonEmptyStr(rh.VoidReason, "不再执行")),
			fmt.Sprintf("Voided by %s on %s (%s)", firstNonEmptyStr(rh.VoidedBy, rh.Owner), stamp(firstNonEmptyStr(rh.VoidedAt, rh.UpdatedAt)), firstNonEmptyStr(rh.VoidReason, "Obsolete")),
		)
		coverRows = append(coverRows, [2]string{tr(lang, "生产落地状态", "Production Status"), voidLabel})
	} else {
		coverRows = append(coverRows, [2]string{tr(lang, "生产落地状态", "Production Status"), tr(lang, "已定稿 · 待确认生产落地", "Finalized · Pending Production Sign-Off")})
	}
	d := &clusterDoc{
		ID:       "sop-" + rh.ID,
		Kind:     "change",
		Title:    docTitle,
		Subtitle: rh.Title,
		Cluster:  f.ID,
		Job:      rh.BaseJobID,
		Cover:    f.cover(coverRows...),
	}
	b := &docBuilder{}
	b.section(1, "overview", tr(lang, "1 变更目标与维护窗口", "1 Change Objective & Maintenance Window"), tr(lang, "本次变更的业务背景、目标、计划维护窗口起止时间及审批单号。", "Business context, objectives, planned maintenance window start/end, and approval ticket ID."), true)
	if rh.Applied {
		b.h(2, tr(lang, "1.1 生产实施落地确认与生效变更", "1.1 Production Completion & Effective Changes"))
		confirmLine := tr(lang,
			fmt.Sprintf("本次变更已由 %s 于 %s 确认在生产环境执行完成并同步至集群运行台账。", firstNonEmptyStr(rh.AppliedBy, rh.Owner), stamp(firstNonEmptyStr(rh.AppliedAt, rh.UpdatedAt))),
			fmt.Sprintf("Confirmed applied to production by %s on %s and synced to the cluster operational ledger.", firstNonEmptyStr(rh.AppliedBy, rh.Owner), stamp(firstNonEmptyStr(rh.AppliedAt, rh.UpdatedAt))),
		)
		if rh.AppliedSummary != "" {
			confirmLine += "\n" + tr(lang, "生效摘要：", "Applied Summary: ") + rh.AppliedSummary
		}
		if rh.AppliedNote != "" {
			confirmLine += "\n" + tr(lang, "现场说明：", "Execution Note: ") + rh.AppliedNote
		}
		b.note(confirmLine)
		if len(rh.AppliedChanges) > 0 {
			var rows [][]string
			for _, ch := range rh.AppliedChanges {
				rows = append(rows, []string{ch.Key, firstNonEmptyStr(ch.Before, "—"), ch.After, firstNonEmptyStr(ch.Note, "—")})
			}
			b.table([]string{tr(lang, "变更项", "Item"), tr(lang, "变更前", "Before"), tr(lang, "变更后（已生效）", "After (Active)"), tr(lang, "说明", "Note")}, rows)
		}
	}

	b.h(1, tr(lang, "2 生产现状核对与漂移诊断", "2 Production Baseline & Drift Diagnosis"))
	var scopeItems []string
	for _, q := range rh.ScopeQuestions {
		if strings.TrimSpace(q.Answer) != "" {
			scopeItems = append(scopeItems, q.Question+tr(lang, "：", ": ")+q.Answer)
		}
	}
	if rh.ExtraScope != "" {
		scopeItems = append(scopeItems, tr(lang, "补充说明：", "Additional Scope: ")+rh.ExtraScope)
	}
	if len(scopeItems) > 0 {
		b.h(2, tr(lang, "2.1 已确认的变更边界", "2.1 Confirmed Change Scope"))
		b.list(scopeItems)
	}
	if rh.Drift != nil {
		b.h(2, tr(lang, "2.2 生产现场拓扑与漂移核查", "2.2 Live Topology & Drift Check"))
		b.note(rh.Drift.Summary)
		if len(rh.Drift.Hosts) > 0 {
			var rows [][]string
			for _, h := range rh.Drift.Hosts {
				rows = append(rows, []string{h.Name, h.IP, firstNonEmptyStr(h.InitialRole, "—"), firstNonEmptyStr(h.ActualRole, "—"), firstNonEmptyStr(h.Version, f.Current.Version), firstNonEmptyStr(h.Status, tr(lang, "正常", "Healthy"))})
			}
			b.table([]string{tr(lang, "节点", "Host"), tr(lang, "生产 IP", "Prod IP"), tr(lang, "初始交付角色", "Initial Role"), tr(lang, "现场当前角色", "Live Role"), tr(lang, "版本", "Version"), tr(lang, "运行状态", "Status")}, rows)
		} else {
			topology(b, f.Plan, lang)
		}
		if len(rh.Drift.ParamDiffs) > 0 {
			var rows [][]string
			for _, p := range rh.Drift.ParamDiffs {
				rows = append(rows, []string{p.Key, p.Initial, p.Actual, p.Risk})
			}
			b.h(3, tr(lang, "现场参数差异", "Live Parameter Diffs"))
			b.table([]string{tr(lang, "参数", "Parameter"), tr(lang, "初始交付值", "Initial Value"), tr(lang, "现场当前值", "Live Value"), tr(lang, "影响与风险说明", "Impact & Risk")}, rows)
		}
		if len(rh.Drift.Risks) > 0 {
			b.h(3, tr(lang, "识别到的变更风险点", "Identified Change Risks"))
			b.list(rh.Drift.Risks)
		}
	} else {
		topology(b, f.Plan, lang)
	}

	b.h(1, tr(lang, "3 测试环境演练验证记录", "3 Staging Rehearsal Verification"))
	passed, skipped, revTotal := 0, 0, 0
	for _, st := range rh.Steps {
		revTotal += len(st.Revisions)
		if st.Phase == "rollback" {
			continue
		}
		switch st.Status {
		case "passed":
			passed++
		case "skipped":
			skipped++
		}
	}
	summary := tr(lang, fmt.Sprintf("测试环境共实测通过 %d 个步骤", passed), fmt.Sprintf("Verified %d step(s) in staging", passed))
	if skipped > 0 {
		summary += tr(lang, fmt.Sprintf("，跳过 %d 个可选/不适用步骤", skipped), fmt.Sprintf(", skipped %d optional/N/A step(s)", skipped))
	}
	if revTotal > 0 {
		summary += tr(lang, fmt.Sprintf("，演练过程中累计排障与打磨修正命令 %d 次", revTotal), fmt.Sprintf(", with %d command revision(s) refined during rehearsal", revTotal))
	}
	summary += tr(lang, "。", ".")
	if rh.TestEnvNote != "" {
		summary += tr(lang, " 测试环境说明：", " Staging notes: ") + rh.TestEnvNote
	}
	b.p(summary)

	b.h(1, tr(lang, "4 生产变更分步实施步骤（SOP）", "4 Production Change Procedure (SOP)"))
	writeStepCmds := func(st rehearsalStep) {
		subs := st.Commands
		if len(subs) <= 1 {
			subs = splitSequentialRollingCommands(st.Command, lang)
		}
		if len(subs) > 1 {
			for j, sub := range subs {
				lbl := strings.TrimSpace(sub.Label)
				if lbl == "" {
					lbl = tr(lang, fmt.Sprintf("第 %d 段", j+1), fmt.Sprintf("Part %d", j+1))
				}
				if sub.TargetRole != "" {
					lbl += tr(lang, "（"+sub.TargetRole+"）", " ("+sub.TargetRole+")")
				}
				b.p(lbl + "：")
				b.code(sub.Command)
				if j < len(subs)-1 && strings.TrimSpace(sub.Gate) != "" {
					b.note(sub.Gate)
				}
			}
			return
		}
		b.code(st.Command)
	}
	writePhase := func(subTitle, phase string) {
		var list []rehearsalStep
		for _, st := range rh.Steps {
			if st.Phase == phase && st.Status != "skipped" {
				list = append(list, st)
			}
		}
		if len(list) == 0 {
			return
		}
		b.h(2, subTitle)
		for i, st := range list {
			b.h(3, tr(lang, fmt.Sprintf("%d) %s（执行对象：%s）", i+1, st.Title, st.TargetRole), fmt.Sprintf("%d) %s (Target: %s)", i+1, st.Title, st.TargetRole)))
			var meta []string
			if st.Elapsed != "" {
				meta = append(meta, tr(lang, "演练实测耗时：", "Measured duration: ")+st.Elapsed)
			}
			if st.Note != "" {
				meta = append(meta, tr(lang, "演练实测备注：", "Verification note: ")+st.Note)
			}
			if st.RiskNote != "" {
				meta = append(meta, tr(lang, "注意事项：", "Caution: ")+st.RiskNote)
			}
			if len(meta) > 0 {
				b.p(strings.Join(meta, " | "))
			}
			writeStepCmds(st)
			b.p(tr(lang, "成功判据：", "Pass Criteria: ") + st.Expect)
			if st.Rollback != "" {
				b.note(tr(lang, "本步即时回退：", "Step Rollback: ") + st.Rollback)
			}
		}
	}
	writePhase(tr(lang, "4.1 变更前预检", "4.1 Pre-Change Checks"), "precheck")
	writePhase(tr(lang, "4.2 核心变更执行", "4.2 Core Change Execution"), "execute")
	writePhase(tr(lang, "4.3 变更后验收", "4.3 Post-Change Verification"), "verify")
	if restAlerts := auditRehearsalRestorations(rh.Goal, rh.ExtraScope, rh.Steps, lang); len(restAlerts) > 0 {
		b.h(2, tr(lang, "4.4 临时状态复位与收尾核对提醒", "4.4 Temporary State Restoration Checklist"))
		var items []string
		for _, a := range restAlerts {
			items = append(items, a.Summary+tr(lang, " — ", " — ")+a.Suggestion)
		}
		b.note(tr(lang,
			"系统检测到以下临时状态改动在正向步骤中未配齐显式复位/清理动作，生产收尾前请务必确认或补齐：",
			"The following temporary state changes have no explicit forward restoration step; verify or restore before closing the window:",
		))
		b.list(items)
	}

	b.h(1, tr(lang, "5 应急回退预案", "5 Emergency Rollback Plan"))
	var rollbacks []rehearsalStep
	for _, st := range rh.Steps {
		if st.Phase == "rollback" {
			rollbacks = append(rollbacks, st)
		}
	}
	if len(rollbacks) > 0 {
		for i, st := range rollbacks {
			b.h(2, tr(lang, fmt.Sprintf("5.%d %s（执行对象：%s）", i+1, st.Title, st.TargetRole), fmt.Sprintf("5.%d %s (Target: %s)", i+1, st.Title, st.TargetRole)))
			if st.RiskNote != "" {
				b.p(tr(lang, "触发条件与说明：", "Trigger & notes: ") + st.RiskNote)
			}
			writeStepCmds(st)
			b.p(tr(lang, "回退确认判据：", "Rollback Verification: ") + st.Expect)
		}
	} else {
		var inlineRB []string
		for _, st := range rh.Steps {
			if st.Rollback != "" {
				inlineRB = append(inlineRB, st.Title+tr(lang, "：", ": ")+st.Rollback)
			}
		}
		if len(inlineRB) > 0 {
			b.list(inlineRB)
		} else {
			b.p(tr(lang, "按各执行步骤下方标注的单步回退方式逆序恢复服务与配置。", "Restore services and configuration in reverse order using each step's inline rollback procedure."))
		}
	}

	b.section(1, "signoff", tr(lang, "6 回退红线与审批签字", "6 Rollback Triggers & Sign-Off"), tr(lang, "回退触发红线、窗口负责人、执行人与复核人签字确认。", "Rollback trigger thresholds and sign-off from change lead, executor, and reviewer."), true)
	d.Blocks = b.blocks
	return d, true
}

func cleanStringList(in []string, maxItems, maxRunes int) []string {
	var out []string
	for _, s := range in {
		if len(out) >= maxItems {
			break
		}
		if t := strings.TrimSpace(s); t != "" {
			out = append(out, truncRunes(t, maxRunes))
		}
	}
	return out
}

var _ = mwpack.DeploymentSchema

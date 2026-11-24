package main

import (
	"strings"

	"middleware-deployer/mwpack"
)

func localizeReasonText(lang, reason string) string {
	if !isEnLang(lang) || reason == "" {
		return reason
	}
	parts := strings.Split(reason, "；")
	for i, p := range parts {
		parts[i] = mwpack.TranslateCatalogText(lang, strings.TrimSpace(p))
	}
	return strings.Join(parts, "; ")
}

func localizePlatformSummary(lang, platform string) string {
	if !isEnLang(lang) || platform == "" || platform == "—" {
		return platform
	}
	out := platform
	for _, p := range mwpack.Platforms {
		out = strings.ReplaceAll(out, p.Title, mwpack.LocalizePlatformTitle(lang, p.Title))
	}
	if out == platform {
		out = mwpack.LocalizePlatformTitle(lang, out)
	}
	return out
}

func localizeCatalogEntry(lang string, e catalogEntry) catalogEntry {
	if !isEnLang(lang) {
		return e
	}
	e.Info = mwpack.LocalizeInfo(lang, e.Info)
	e.Platform = localizePlatformSummary(lang, e.Platform)
	e.Reason = localizeReasonText(lang, e.Reason)
	if len(e.Plans) > 0 {
		plans := make([]catalogPlan, len(e.Plans))
		for i, pl := range e.Plans {
			pl.Name = mwpack.TranslateCatalogText(lang, pl.Name)
			pl.Tag = mwpack.TranslateCatalogText(lang, pl.Tag)
			pl.Spec = mwpack.TranslateCatalogText(lang, pl.Spec)
			pl.Contract = mwpack.LocalizeSeriesContract(lang, pl.Contract)
			plans[i] = pl
		}
		e.Plans = plans
	}
	return e
}

func localizeCatalogEntries(lang string, src []catalogEntry) []catalogEntry {
	if !isEnLang(lang) || len(src) == 0 {
		return src
	}
	out := make([]catalogEntry, len(src))
	for i, e := range src {
		out[i] = localizeCatalogEntry(lang, e)
	}
	return out
}

func localizeBlockedMessage(lang, msg string) string {
	if !isEnLang(lang) || msg == "" {
		return msg
	}
	return tr(lang, msg, localizeGoMessage(lang, msg))
}

func localizeMWProblems(lang string, ps []mwpack.Problem) []mwpack.Problem {
	if !isEnLang(lang) || len(ps) == 0 {
		return ps
	}
	out := make([]mwpack.Problem, len(ps))
	for i, p := range ps {
		p.Message = localizeGoMessage(lang, p.Message)
		out[i] = p
	}
	return out
}

func localizeCompCheck(lang string, c *compCheck) *compCheck {
	if !isEnLang(lang) || c == nil {
		return c
	}
	cp := *c
	if len(c.Problems) > 0 {
		cp.Problems = make([]compProblem, len(c.Problems))
		for i, p := range c.Problems {
			p.Message = localizeGoMessage(lang, p.Message)
			cp.Problems[i] = p
		}
	}
	if len(c.Ignored) > 0 {
		cp.Ignored = make([]compProblem, len(c.Ignored))
		for i, p := range c.Ignored {
			p.Message = localizeGoMessage(lang, p.Message)
			cp.Ignored[i] = p
		}
	}
	return &cp
}

func localizePreviewResp(lang string, r *previewResp) *previewResp {
	if !isEnLang(lang) || r == nil {
		return r
	}
	cp := *r
	if cp.Error != "" {
		cp.Error = localizeGoMessage(lang, cp.Error)
	}
	cp.Issues = localizeMWProblems(lang, cp.Issues)
	if cp.Plan != nil {
		pl := mwpack.LocalizePlanView(lang, *cp.Plan)
		cp.Plan = &pl
	}
	if len(cp.Roles) > 0 {
		roles := make([]mwpack.RoleSpec, len(cp.Roles))
		for i, rl := range cp.Roles {
			rl.Title = mwpack.TranslateCatalogText(lang, rl.Title)
			rl.AdviseWhy = mwpack.TranslateCatalogText(lang, rl.AdviseWhy)
			roles[i] = rl
		}
		cp.Roles = roles
	}
	if len(cp.Presets) > 0 {
		presets := make([]mwpack.Preset, len(cp.Presets))
		for i, pr := range cp.Presets {
			pr.Name = mwpack.TranslateCatalogText(lang, pr.Name)
			pr.Tag = mwpack.TranslateCatalogText(lang, pr.Tag)
			pr.Spec = mwpack.TranslateCatalogText(lang, pr.Spec)
			pr.Contract = mwpack.LocalizeSeriesContract(lang, pr.Contract)
			presets[i] = pr
		}
		cp.Presets = presets
	}
	return &cp
}

func localizeSyncPreview(lang string, pv syncPreview) syncPreview {
	if !isEnLang(lang) {
		return pv
	}
	if pv.Blocked != "" {
		pv.Blocked = localizeGoMessage(lang, pv.Blocked)
	}
	if len(pv.Why) > 0 {
		why := make(map[string]string, len(pv.Why))
		for k, v := range pv.Why {
			why[k] = localizeGoMessage(lang, v)
		}
		pv.Why = why
	}
	if len(pv.Phases) > 0 {
		phases := make([]syncPhase, len(pv.Phases))
		for i, ph := range pv.Phases {
			ph.Label = mwpack.TranslateCatalogText(lang, ph.Label)
			if len(ph.Changed) > 0 {
				ch := make([]syncStep, len(ph.Changed))
				for j, st := range ph.Changed {
					st.Why = localizeGoMessage(lang, st.Why)
					ch[j] = st
				}
				ph.Changed = ch
			}
			phases[i] = ph
		}
		pv.Phases = phases
	}
	return pv
}

func localizeExecutionChoices(lang string, in []executionChoice) []executionChoice {
	if !isEnLang(lang) || len(in) == 0 {
		return in
	}
	out := make([]executionChoice, len(in))
	for i, c := range in {
		c.Title = mwpack.TranslateCatalogText(lang, c.Title)
		c.Phase = mwpack.TranslateCatalogText(lang, c.Phase)
		c.Reason = localizeGoMessage(lang, c.Reason)
		out[i] = c
	}
	return out
}

func localizeExecutionOption(lang string, o executionNodeOption) executionNodeOption {
	if !isEnLang(lang) {
		return o
	}
	o.Reason = localizeGoMessage(lang, o.Reason)
	return o
}

func localizeExecutionRun(lang string, r executionRun) executionRun {
	if !isEnLang(lang) || len(r.Steps) == 0 {
		return r
	}
	steps := make([]executionStep, len(r.Steps))
	for i, st := range r.Steps {
		st.Title = mwpack.TranslateCatalogText(lang, st.Title)
		st.Message = localizeGoMessage(lang, st.Message)
		steps[i] = st
	}
	r.Steps = steps
	return r
}

func localizeExecutionPrep(lang string, p executionPreparation) executionPreparation {
	if !isEnLang(lang) {
		return p
	}
	if p.Invalidated != "" {
		p.Invalidated = localizeGoMessage(lang, p.Invalidated)
	}
	if len(p.Checks) > 0 {
		checks := make([]executionCheck, len(p.Checks))
		for i, c := range p.Checks {
			c.Title = localizeGoMessage(lang, c.Title)
			c.Message = localizeGoMessage(lang, c.Message)
			checks[i] = c
		}
		p.Checks = checks
	}
	return p
}

func localizeTargetAgent(lang string, a targetAgent) targetAgent {
	if !isEnLang(lang) || a.Message == "" {
		return a
	}
	a.Message = localizeGoMessage(lang, a.Message)
	return a
}

func localizedNotifyKinds(lang string) map[string]string {
	if !isEnLang(lang) {
		return notifyKinds
	}
	return map[string]string{
		"webhook":  "Generic Webhook",
		"wecom":    "WeCom Bot",
		"dingtalk": "DingTalk Bot",
		"feishu":   "Feishu Bot",
	}
}

func localizedNotifyEvents(lang string, src []notifyEvent) []notifyEvent {
	if !isEnLang(lang) {
		return src
	}
	out := make([]notifyEvent, len(src))
	for i, ev := range src {
		if ev.ID == "test" {
			ev.Group = "System"
			ev.Title = "Test Notification"
			ev.Desc = "Sent when clicking \"Send Test\" on a notification channel."
			ev.Vars = []notifyVar{
				{Key: "channel", Desc: "Channel Name"},
				{Key: "link", Desc: "Platform URL"},
			}
			ev.Default = notifyTpl{
				Title: "Kyndryl Delivery Studio Test Message",
				Body:  "This message confirms that notification channel \"{{channel}}\" can deliver alerts.\n{{link}}",
			}
			ev.Sample = map[string]string{"channel": "On-call Ops", "link": "https://hub.example"}
		}
		out[i] = ev
	}
	return out
}

func localizedWebProviders(lang string, src []map[string]any) []map[string]any {
	if !isEnLang(lang) {
		return src
	}
	hints := map[string]string{
		"duckduckgo": "No API key required; fetches public web results (may rate-limit occasionally)",
		"tavily":     "AI-oriented web search API; requires API key (tavily.com)",
		"brave":      "Requires API key (api.search.brave.com)",
		"bocha":      "Available in mainland China; requires API key (open.bochaai.com)",
		"searxng":    "Enter your self-hosted SearXNG URL (JSON output format must be enabled)",
	}
	names := map[string]string{
		"bocha":   "Bocha",
		"searxng": "SearXNG (Self-hosted)",
	}
	out := make([]map[string]any, len(src))
	for i, p := range src {
		cp := make(map[string]any, len(p))
		for k, v := range p {
			cp[k] = v
		}
		id, _ := cp["id"].(string)
		if h, ok := hints[id]; ok {
			cp["hint"] = h
		}
		if n, ok := names[id]; ok {
			cp["name"] = n
		}
		out[i] = cp
	}
	return out
}

func sandboxBackendLabelLang(lang string) string {
	if !isEnLang(lang) {
		return sandboxBackendLabel()
	}
	switch sandboxBackendLabel() {
	case "Linux 内核命名空间 + Seccomp":
		return "Linux Kernel Namespaces + Seccomp"
	case "Windows Job Object + UI 隔离 + PEP-578 审计沙箱":
		return "Windows Job Object + UI Isolation + PEP-578 Audit Sandbox"
	case "macOS Seatbelt + PEP-578 审计沙箱":
		return "macOS Seatbelt + PEP-578 Audit Sandbox"
	default:
		return "Process Limits + PEP-578 Isolation Sandbox"
	}
}

func localizeSandboxPayload(lang string, out map[string]any) map[string]any {
	if !isEnLang(lang) {
		return out
	}
	out["backend"] = sandboxBackendLabelLang(lang)
	if re, ok := out["runtime_error"].(string); ok && re != "" {
		out["runtime_error"] = localizeGoMessage(lang, re)
	}
	if st, ok := out["settings"].(sandboxSettings); ok {
		if st.Note != "" {
			st.Note = localizeGoMessage(lang, st.Note)
		}
		if len(st.Checks) > 0 {
			checks := make([]sandboxCheck, len(st.Checks))
			for i, c := range st.Checks {
				c.Name = localizeGoMessage(lang, c.Name)
				if c.Note != "" {
					c.Note = localizeGoMessage(lang, c.Note)
				}
				checks[i] = c
			}
			st.Checks = checks
		}
		out["settings"] = st
	}
	return out
}

func localizedSkills(lang string, src []aiSkill) []aiSkill {
	if !isEnLang(lang) || len(src) == 0 {
		return src
	}
	skillTextEn := map[string]struct{ title, desc string }{
		"ansible-debug":        {"Ansible Troubleshooting", "Diagnose failing Ansible playbooks: unreachable hosts, privilege escalation, module errors, undefined variables, idempotency, and missing offline dependencies."},
		"automatic-execution":  {"Automatic Execution & Streaming", "Independent or in-cluster executors, bastion target agents, grants and readiness checks, immutable snapshots, log streaming, and execution reports."},
		"change-rehearsal":     {"Guided Change Rehearsal & SOP", "Safe 4-step workflow for live cluster scaling, tuning, patching, or upgrades: align scope, run read-only discovery, rehearse in staging, and finalize production SOP."},
		"component-authoring":  {"Component Authoring Standards", "Authoring rules for component.yaml and Ansible roles: declarative specs, idempotent tasks, checks and rollbacks, secrets handling, and change steps."},
		"delivery-review":      {"Delivery Review Checklist", "Review middleware deliveries across HA architecture, role counts, parameter risks, disk and resource sizing, backup/recovery, security baseline, and rollback."},
		"deployment-form":      {"Assisted Deployment Form", "Turn natural-language cluster requirements (hosts, subnets, VIPs, sizing) into validated deployment specs inside the creation wizard."},
		"document-writing":     {"Operations Docs & Reports", "Structure, tone, and checklists for deployment guides, change notes, inspection reports, runbooks, and handover summaries."},
		"etcd-ops":             {"etcd Cluster Operations", "etcd health checks, member management, NOSPACE quota alerts, compaction and defragmentation, snapshot backup/restore, and election/disk latency tuning."},
		"haproxy-keepalived":   {"Load Balancing & VIP", "HAProxy backend health checks, config validation, graceful reloads, and keepalived VIP failover, split-brain, and VRRP troubleshooting."},
		"incident-report":      {"Incident Postmortem Report", "Compile field incidents into objective, actionable postmortems covering timeline, impact, root cause, mitigation, and follow-up actions."},
		"linux-diagnostics":    {"Linux Host Diagnostics", "Diagnose host issues including full disks, port conflicts, failing systemd units, clock drift, SELinux/firewall blocks, memory/inode pressure, and DNS."},
		"middleware-logging-observability": {"Logging, Rotation & Observability", "Audit middleware log paths, logging_collector, journald persistence/caps, logrotate policies, slow/audit logs, and monitoring hooks across deliveries."},
		"nginx-stream":         {"Nginx Stream L4 Load Balancing", "Validate Nginx Stream TCP/UDP load balancing configs, upstream health/failover tuning, timeouts, reload safety, and VIP/firewall integration."},
		"offline-packages":     {"Offline Packages & Repos", "Build and validate offline apt/dnf mirrors, resolve missing dependencies, version conflicts, GPG signatures, and checksum errors."},
		"postgresql-patroni":   {"PostgreSQL & Patroni HA", "Interpret Patroni cluster state, replication lag, switchover/failover, pg_rewind, replication slots/WAL buildup, and pg_hba authentication."},
		"proposal-writing":     {"Actionable Proposal Cards", "Format propose_step and propose_change proposals cleanly so automated platform checks accept them on the first pass."},
		"reading-attachments":  {"Reading Screenshots & Docs", "Analyze screenshots, PDFs, Word docs, spreadsheets, presentations, logs, and configs accurately while scrubbing sensitive fields."},
		"redis-sentinel":       {"Redis & Sentinel HA", "Verify Redis standalone and Sentinel HA topology, replication, failover event logs, memory/eviction/persistence tuning, and safe read-only checks."},
		"security-cve-audit":   {"Package Security & Dependency Audit", "Audit Ansible runtime builds, wheel version diffs, OSV/PyPI CVE advisories, upgrade compatibility, and whether historical builds can be safely deleted."},
		"spreadsheet-analysis": {"Spreadsheet Data Analysis", "Summarize, compare, detect anomalies, and build actionable checklists from uploaded Excel or CSV files."},
		"step-troubleshooting": {"Runbook Step Troubleshooting", "Root-cause analysis when executing runbooks: isolate signal from noise, decide between answers and proposals, and capture lessons into KB or components."},
	}
	scriptDescEn := map[string]string{
		"calc_pg_tuning.py":          "Calculate PostgreSQL memory and concurrency settings from RAM (memory_gb), CPU cores (cpus), max_connections, and workload type (oltp/olap/mixed).",
		"calc_etcd_quorum.py":        "Evaluate etcd quorum tolerance, fault redundancy, DB size (db_size_mb), and quota fragmentation warnings.",
		"calc_redis_memory.py":       "Calculate safe Redis maxmemory, fork CoW headroom, and repl-backlog-size from host RAM (memory_gb), persistence mode, and instance count.",
		"parse_disk_mem_snapshot.py": "Parse df -h and free memory text (or /in snapshot files) to report mount points exceeding thresholds and Swap/memory warnings.",
		"profile_csv_quality.py":     "Scan CSV files in /in to compute row counts, null rates per column, distinct cardinality, and numeric min/max/avg.",
	}
	out := make([]aiSkill, len(src))
	for i, sk := range src {
		if sk.Builtin && !sk.Customized {
			if trMeta, ok := skillTextEn[sk.Name]; ok {
				sk.Title = trMeta.title
				sk.Description = trMeta.desc
			}
		}
		if len(sk.Scripts) > 0 {
			scripts := make([]aiSkillScript, len(sk.Scripts))
			for j, sc := range sk.Scripts {
				if en, ok := scriptDescEn[sc.Name]; ok && (!sk.Customized || sc.Description == "") {
					sc.Description = en
				} else if en, ok := scriptDescEn[sc.Name]; ok && sk.Builtin {
					sc.Description = en
				}
				scripts[j] = sc
			}
			sk.Scripts = scripts
		}
		out[i] = sk
	}
	return out
}

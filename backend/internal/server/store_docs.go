package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"delivery-studio/mwpack"
)

// Cluster documents: the delivery report (交付报告), a change report per plan (变更报告), the operations handover
// (运维交接) and a root-cause analysis per failed plan (根因分析). Facts — topology, versions, packages, what was
// changed, who did what when — are always assembled by the platform from the cluster's deliveries, so they cannot be
// wrong or stale. Only the written sections (a summary, risks, a conclusion, the root cause) are stored; people write
// them or let the assistant draft them, and a draft counts once someone confirms it. The same blocks are shown on the
// page and written into Word.

// docBlock is one piece of a document.
type docBlock struct {
	Detail bool       `json:"detail,omitempty"`
	Kind   string     `json:"kind"` // h | p | note | table | code | list | image | section
	Level  int        `json:"level,omitempty"`
	Text   string     `json:"text,omitempty"`
	Head   []string   `json:"head,omitempty"`
	Rows   [][]string `json:"rows,omitempty"`
	Items  []string   `json:"items,omitempty"`
	// Variant says which part of an execution report the block belongs to: auto (the playbooks that are run), cmd (the
	// commands on each machine), result (common on-site results), result_auto (raw Ansible execution logs), or
	// result_cmd (Linux terminal command execution transcripts). Empty blocks are always shown.
	Variant string `json:"variant,omitempty"`
	// Style hints how a code block should be presented in Web and Word: "" / "shell" (command manual), "terminal" (dark
	// Linux terminal session log), or "ansible" (raw automation log).
	Style string `json:"style,omitempty"`
	// An image block lists the pictures recorded for a step (Items) and the delivery they belong to.
	Job string `json:"job,omitempty"`
	// A section is a heading (Title) and text people write; Key names it.
	Key       string `json:"key,omitempty"`
	Title     string `json:"title,omitempty"`
	Hint      string `json:"hint,omitempty"`
	AI        bool   `json:"ai,omitempty"`     // the assistant may draft it
	Source    string `json:"source,omitempty"` // ai | user
	Confirmed bool   `json:"confirmed,omitempty"`
	By        string `json:"by,omitempty"`
	At        string `json:"at,omitempty"`
	// Stale names what the cluster went through after the section was written (it may no longer be true).
	Stale string `json:"stale,omitempty"`
}

type clusterDoc struct {
	ID       string      `json:"id"`
	Kind     string      `json:"kind"` // delivery | change | kt | rca | assess
	Title    string      `json:"title"`
	Subtitle string      `json:"subtitle,omitempty"`
	Cluster  string      `json:"cluster"`
	Job      string      `json:"job,omitempty"`
	Cover    [][2]string `json:"cover"`
	Blocks   []docBlock  `json:"blocks"`
	// Counts over the sections: how many there are, how many are empty, how many are assistant drafts nobody has
	// confirmed yet.
	Sections int    `json:"sections"`
	Empty    int    `json:"empty"`
	Drafts   int    `json:"drafts"`
	Stale    int    `json:"stale"`
	Updated  string `json:"updated,omitempty"`
	// Manual is set for a root-cause analysis someone started by hand; only those can be removed.
	Manual bool `json:"manual,omitempty"`
}

type docSection struct {
	Text      string `json:"text"`
	Source    string `json:"source"`
	Confirmed bool   `json:"confirmed"`
	By        string `json:"by"`
	At        string `json:"at"`
	// Basis is the job that described the cluster when the section was written.
	Basis string `json:"basis,omitempty"`
}

type planQA struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
}

type docSaved struct {
	Sections map[string]docSection `json:"sections"`
	// Answers are what people on site told the assistant when it asked (root-cause analyses).
	Answers []planQA `json:"answers,omitempty"`
}

// docIndex lists the documents people started themselves: root-cause analyses of a plan that did not fail, or of an
// incident that has nothing to do with a plan, plus archived on-site change reports from AI chats.
type docIndex struct {
	RCA     []rcaEntry        `json:"rca"`
	Assess  []assessEntry     `json:"assess,omitempty"`
	Changes []changeNoteEntry `json:"changes,omitempty"`
}

type changeNoteEntry struct {
	ID        string   `json:"id"`
	Session   string   `json:"session,omitempty"`
	Title     string   `json:"title"`
	Symptom   string   `json:"symptom"`
	Evidence  string   `json:"evidence,omitempty"`
	Cause     string   `json:"cause"`
	Fix       string   `json:"fix"`
	Changed   bool     `json:"changed,omitempty"`
	Followups []string `json:"followups,omitempty"`
	Model     string   `json:"model,omitempty"`
	Created   string   `json:"created"`
	Updated   string   `json:"updated,omitempty"`
	By        string   `json:"by"`
}

func (x docIndex) change(id string) (changeNoteEntry, bool) {
	for _, e := range x.Changes {
		if e.ID == id {
			return e, true
		}
	}
	return changeNoteEntry{}, false
}

// assessEntry is an assessment someone asked for: capacity (is the cluster big enough, what to grow) or selection
// (which architecture or component fits).
type assessEntry struct {
	ID       string `json:"id"`
	Type     string `json:"type"` // capacity | selection
	Question string `json:"question"`
	Created  string `json:"created"`
	By       string `json:"by"`
}

func (x docIndex) assess(id string) (assessEntry, bool) {
	for _, e := range x.Assess {
		if e.ID == id {
			return e, true
		}
	}
	return assessEntry{}, false
}

type rcaEntry struct {
	ID      string `json:"id"`
	Job     string `json:"job,omitempty"`
	Title   string `json:"title,omitempty"`
	Created string `json:"created"`
	By      string `json:"by"`
}

func (s *storeServer) docIndex(cluster string) docIndex {
	var x docIndex
	if b, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "docs", cluster, "index.json")); err == nil {
		_ = json.Unmarshal(b, &x)
	}
	return x
}

func (x docIndex) rca(id string) (rcaEntry, bool) {
	for _, e := range x.RCA {
		if e.ID == id {
			return e, true
		}
	}
	return rcaEntry{}, false
}

var (
	docClusterID = regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`)
	docIDRe      = regexp.MustCompile(`^(delivery|kt|sop-[0-9a-f]{12}|chg-[0-9a-f]{12}|rca-[0-9a-f]{32}|rca-x[0-9a-f]{12}|assess-[0-9a-f]{12})$`)
	docIdxMu     sync.Mutex
)

func (s *storeServer) docPath(cluster, doc string) string {
	return filepath.Join(s.cfg.DataDir, "docs", cluster, doc+".json")
}

func (s *storeServer) docLoad(cluster, doc string) docSaved {
	out := docSaved{Sections: map[string]docSection{}}
	if b, err := os.ReadFile(s.docPath(cluster, doc)); err == nil {
		_ = json.Unmarshal(b, &out)
	}
	if out.Sections == nil {
		out.Sections = map[string]docSection{}
	}
	return out
}

func (s *storeServer) docSave(cluster, doc string, d docSaved) error {
	return writeJSONFile(s.docPath(cluster, doc), d)
}

// ---- facts ----

// clusterFacts is what every document of a cluster is built from.
type clusterFacts struct {
	ID      string
	Lang    string
	Jobs    []storeJob // oldest first; generation failures left out
	Current storeJob
	Plan    *mwpack.Plan // the current job's specification, solved
}

// clusterFactsFor gathers a cluster the user may see; ok is false when there is none.
func (s *storeServer) clusterFactsFor(user, id string) (clusterFacts, bool) {
	vis := s.visibleJobs(user)
	s.mu.Lock()
	all := s.clusterOf(id)
	s.mu.Unlock()
	f := clusterFacts{ID: id}
	seen := false
	for _, j := range all {
		seen = seen || vis(j.Owner)
		if j.State == "succeeded" {
			f.Jobs = append(f.Jobs, j)
		}
	}
	if !seen || len(f.Jobs) == 0 {
		return f, false
	}
	cur, ok := clusterCurrent(all)
	if !ok {
		cur = f.Jobs[len(f.Jobs)-1]
	}
	f.Current = cur
	f.Plan = s.solvedJob(cur.ID)
	return f, true
}

func (s *storeServer) solvedJob(id string) *mwpack.Plan {
	d := s.readSpec(id)
	if d == nil {
		return nil
	}
	if d.DeliveryMode == "imported" {
		return mwpack.SolveImported(s.plat.cat(), d)
	}
	return mwpack.Solve(s.plat.cat(), d)
}

func (f clusterFacts) job(id string) (storeJob, bool) {
	for _, j := range f.Jobs {
		if j.ID == id {
			return j, true
		}
	}
	return storeJob{}, false
}

func (f clusterFacts) first() storeJob {
	for i := len(f.Jobs) - 1; i >= 0; i-- {
		if f.Jobs[i].Outcome != outcomeVoid {
			return f.Jobs[i]
		}
	}
	return f.Jobs[0]
}

func jobTitle(j storeJob) string { return jobTitleLang(j, "") }

func jobTitleLang(j storeJob, lang string) string {
	if j.DeliveryMode == "imported" {
		return tr(lang, "存量纳管基线", "Imported Baseline")
	}
	if j.DeliveryMode == "configuration" {
		return tr(lang, "配置交付", "Configuration Delivery")
	}
	return tr(lang, "首次部署", "Initial Deployment")
}

func jobOutcomeName(j storeJob) string { return jobOutcomeNameLang(j, "") }

func jobOutcomeNameLang(j storeJob, lang string) string {
	if j.DeliveryMode == "imported" && j.Outcome != outcomeVoid {
		return tr(lang, "存量纳管运行中", "Onboarded & Running")
	}
	if j.DeliveryMode == "configuration" && j.Outcome != outcomeVoid {
		return tr(lang, "仅生成配置，未执行现场部署", "Configuration generated only; on-site deployment not executed")
	}
	if isEnLang(lang) {
		return map[string]string{
			"":              "Pending",
			outcomeDone:     "Completed",
			outcomeDeviated: "Completed with Deviations",
			outcomeFailed:   "Failed",
			outcomeVoid:     "Voided",
		}[j.Outcome]
	}
	return outcomeNames[j.Outcome]
}

var outcomeNames = map[string]string{"": "待执行", outcomeDone: "已完成", outcomeDeviated: "完成，有偏差", outcomeFailed: "失败", outcomeVoid: "已作废"}

func day(ts string) string {
	if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
		return t.Local().Format("2006-01-02")
	}
	return ts
}

func stamp(ts string) string {
	if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
		return t.Local().Format("2006-01-02 15:04")
	}
	return ts
}

// execStep is one step of an execution record.
type execStep struct {
	Key, Title, State, By, At, Note, Log string
	Images                               []string
}

var stepStates = map[string]string{"done": "完成", "failed": "失败", "skipped": "跳过", "resolved": "完成（遇到问题已解决）"}

func stepStateLabel(lang, state string) string {
	if isEnLang(lang) {
		return map[string]string{"done": "Completed", "failed": "Failed", "skipped": "Skipped", "resolved": "Completed (issue resolved)"}[state]
	}
	return stepStates[state]
}

// execRecord is what was recorded on site for a job, in the order it happened.
func (s *storeServer) execRecord(id string) ([]execStep, progressDoc) {
	s.mu.Lock()
	doc := s.readProgress(id)
	s.mu.Unlock()
	titles := map[string]string{}
	order := map[string]int{} // when each step's current record was made, in the order of the event log
	for i, e := range doc.Events {
		if e.Title != "" {
			titles[e.Key] = e.Title
		}
		order[e.Key] = i
	}
	var out []execStep
	for k, r := range doc.Steps {
		out = append(out, execStep{k, firstNonEmptyStr(titles[k], k), r.State, r.By, r.At, r.Note, r.Log, r.Images})
	}
	// timestamps have whole seconds only, so steps recorded in one second keep the order they were recorded in
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].At != out[b].At {
			return out[a].At < out[b].At
		}
		return order[out[a].Key] < order[out[b].Key]
	})
	return out, doc
}

// ---- blocks ----

type docBuilder struct {
	blocks []docBlock
}

func (b *docBuilder) h(level int, text string) {
	b.blocks = append(b.blocks, docBlock{Kind: "h", Level: level, Text: text})
}
func (b *docBuilder) p(text string) {
	if strings.TrimSpace(text) != "" {
		b.blocks = append(b.blocks, docBlock{Kind: "p", Text: text})
	}
}
func (b *docBuilder) note(text string) {
	b.blocks = append(b.blocks, docBlock{Kind: "note", Text: text})
}
func (b *docBuilder) code(text string) {
	if strings.TrimSpace(text) != "" {
		b.blocks = append(b.blocks, docBlock{Kind: "code", Text: text})
	}
}
func (b *docBuilder) list(items []string) {
	if len(items) > 0 {
		b.blocks = append(b.blocks, docBlock{Kind: "list", Items: items})
	}
}
func (b *docBuilder) table(head []string, rows [][]string) {
	if len(rows) > 0 {
		b.blocks = append(b.blocks, docBlock{Kind: "table", Head: head, Rows: rows})
	}
}
func (b *docBuilder) section(level int, key, title, hint string, ai bool) {
	b.blocks = append(b.blocks, docBlock{Kind: "section", Level: level, Key: key, Title: title, Hint: hint, AI: ai})
}

func roleTitle(inst *mwpack.Instance, role string) string {
	for _, r := range inst.R.Roles {
		if r.Name == role {
			return firstNonEmptyStr(r.Title, r.Name)
		}
	}
	return role
}

func roleTitleLang(inst *mwpack.Instance, role, lang string) string {
	return mwpack.TranslateCatalogText(lang, roleTitle(inst, role))
}

// topology writes the machines and instances of a solved plan.
func topology(b *docBuilder, p *mwpack.Plan, langOpt ...string) {
	lang := ""
	if len(langOpt) > 0 {
		lang = langOpt[0]
	}
	if p == nil {
		b.note(tr(lang, "这份交付的部署规格读不出来，拓扑无法列出。", "Deployment specification is unreadable; topology cannot be listed."))
		return
	}
	carry := map[string][]string{}
	for _, inst := range p.Instances {
		if inst.External {
			continue
		}
		for _, r := range inst.R.Roles {
			for _, h := range inst.Roles[r.Name] {
				carry[h] = append(carry[h], inst.ID+" "+roleTitleLang(inst, r.Name, lang))
			}
		}
	}
	var rows [][]string
	sep := tr(lang, "、", ", ")
	for _, h := range p.Hosts {
		name := h.Name
		if h.Name == p.Controller {
			name += tr(lang, "（控制节点）", " (Controller)")
		}
		rows = append(rows, []string{name, h.IP, strings.Join(carry[h.Name], sep)})
	}
	b.table([]string{tr(lang, "机器", "Host"), "IP", tr(lang, "承担", "Roles")}, rows)
	if e := p.Dep.ExecutionHost; e != nil {
		b.p(tr(lang, "独立执行机："+e.Name+"（"+e.IP+"），不计入业务机器；运行目录 "+p.RuntimeRoot()+"。", "Standalone execution host: "+e.Name+" ("+e.IP+"), excluded from workload hosts; runtime root "+p.RuntimeRoot()+"."))
	}
	rows = nil
	for _, inst := range p.Instances {
		place := tr(lang, "客户自行运维", "Customer-managed")
		if !inst.External {
			var parts []string
			for _, r := range inst.R.Roles {
				if hs := inst.Roles[r.Name]; len(hs) > 0 {
					parts = append(parts, roleTitleLang(inst, r.Name, lang)+tr(lang, "：", ": ")+strings.Join(hs, sep))
				}
			}
			place = strings.Join(parts, tr(lang, "；", "; "))
		}
		note := ""
		if inst.Auto {
			note = tr(lang, "平台自动加入：", "Auto-added by platform: ") + mwpack.TranslateCatalogText(lang, inst.AutoReason)
		}
		rows = append(rows, []string{inst.ID, mwpack.TranslateCatalogText(lang, inst.Title) + " " + inst.Version, place, note})
	}
	b.table([]string{tr(lang, "实例", "Instance"), tr(lang, "组件与版本", "Component & Version"), tr(lang, "放置", "Placement"), tr(lang, "说明", "Notes")}, rows)
}

// entries lists the addresses applications use, and how a balancer picks the backend that takes the connection.
func entries(b *docBuilder, p *mwpack.Plan, langOpt ...string) {
	lang := ""
	if len(langOpt) > 0 {
		lang = langOpt[0]
	}
	if p == nil {
		return
	}
	var rows [][]string
	several := false
	for _, inst := range p.Instances {
		for _, e := range inst.Endpoints {
			var be []string
			for _, x := range e.Backends {
				be = append(be, fmt.Sprintf("%s:%d", x.IP, x.Port))
			}
			addr := strings.Join(be, tr(lang, "、", ", "))
			via := tr(lang, "直连", "Direct")
			health := mwpack.TranslateCatalogText(lang, mwpack.EndpointHealth(e))
			if f, ok := inst.Fronts[e.Name]; ok {
				addr = fmt.Sprintf("%s:%d", f.Address, f.Listen)
				via = tr(lang, "经 "+f.Balancer+"，"+health, "Via "+f.Balancer+", "+health)
			} else if len(e.Backends) > 1 {
				several = true
				via = tr(lang, "没有负载均衡；"+health, "No load balancer; "+health)
			}
			rows = append(rows, []string{inst.ID + "." + e.Name, firstNonEmptyStr(mwpack.TranslateCatalogText(lang, e.Title), e.Name), addr, via})
		}
	}
	b.table([]string{tr(lang, "入口", "Endpoint"), tr(lang, "用途", "Purpose"), tr(lang, "地址", "Address"), tr(lang, "如何选到可用节点", "Routing & Health Check")}, rows)
	if several {
		b.note(tr(lang, "没有负载均衡的入口列出的是所有可能承担这个角色的节点，同一时间只有通过检查的那台（例如当前主库）能用。应用要么经负载均衡访问，要么使用支持多主机的连接串（PostgreSQL 例如 host=节点1,节点2,节点3 target_session_attrs=read-write），主库切换后才能自动找到新的主库。", "Endpoints without a load balancer list all candidate hosts for the role; only the host passing health checks (such as the active primary) serves writes at any given time. Clients should either connect via a load balancer or use a multi-host connection string (e.g., PostgreSQL host=h1,h2,h3 target_session_attrs=read-write) so traffic follows failover automatically."))
	}
}

func paramsTable(b *docBuilder, p *mwpack.Plan, langOpt ...string) {
	lang := ""
	if len(langOpt) > 0 {
		lang = langOpt[0]
	}
	if p == nil {
		return
	}
	var rows [][]string
	for _, inst := range p.Instances {
		keys := make([]string, 0, len(inst.Spec.Params))
		for k := range inst.Spec.Params {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			rows = append(rows, []string{inst.ID, k, show(inst.Spec.Params[k])})
		}
	}
	if len(rows) == 0 {
		b.p(tr(lang, "所有参数使用组件默认值。", "All parameters use component defaults."))
		return
	}
	b.table([]string{tr(lang, "实例", "Instance"), tr(lang, "参数", "Parameter"), tr(lang, "取值", "Value")}, rows)
}

func (s *storeServer) packagesTable(b *docBuilder, id string, langOpt ...string) {
	lang := ""
	if len(langOpt) > 0 {
		lang = langOpt[0]
	}
	pk := s.lockPackages(id)
	names := make([]string, 0, len(pk))
	for n := range pk {
		names = append(names, n)
	}
	sort.Strings(names)
	var rows [][]string
	for _, n := range names {
		rows = append(rows, []string{n, strings.Join(pk[n], tr(lang, "、", ", "))})
	}
	if len(rows) == 0 {
		if dep := s.readSpec(id); dep != nil && dep.Imported != nil && len(dep.Imported.Packages) > 0 {
			for _, p := range dep.Imported.Packages {
				rows = append(rows, []string{p.Name, p.Version})
			}
		}
	}
	if len(rows) == 0 {
		b.p(tr(lang, "没有软件包清单。", "No package inventory recorded."))
		return
	}
	b.table([]string{tr(lang, "软件包", "Package"), tr(lang, "版本", "Version")}, rows)
}

// record writes a job's execution record, what was changed during it and the problems solved with the assistant.
func (s *storeServer) record(b *docBuilder, level int, j storeJob, langOpt ...string) {
	lang := ""
	if len(langOpt) > 0 {
		lang = langOpt[0]
	}
	if scheme := mwpack.LocalizeSchemeSummary(lang, s.deliveryScheme(j.ID, j.AppID, j.Scheme)); scheme != nil {
		b.note(tr(lang, "本次交付部署方案：", "Delivery architecture scheme: ") + scheme.Name + tr(lang, "；", "; ") + scheme.Topology + tr(lang, "；", "; ") + scheme.Contract.Mechanism)
	}
	steps, prog := s.execRecord(j.ID)
	s.executionSummary(b, level, j, prog, lang)
	facts := []string{tr(lang, "交付负责人登记的结论：", "Recorded delivery outcome: ") + jobOutcomeNameLang(j, lang)}
	if j.MarkedBy != "" {
		facts = append(facts, tr(lang, fmt.Sprintf("确认：%s，%s", j.MarkedBy, stamp(j.Marked)), fmt.Sprintf("Confirmed by %s at %s", j.MarkedBy, stamp(j.Marked))))
	}
	if j.RunTotal > 0 {
		facts = append(facts, tr(lang, fmt.Sprintf("现场记录：%d / %d 步，%d 步失败", j.RunDone, j.RunTotal, j.RunFailed), fmt.Sprintf("On-site progress: %d / %d step(s) done, %d failed", j.RunDone, j.RunTotal, j.RunFailed)))
	}
	b.p(strings.Join(facts, tr(lang, "；", "; ")))
	if j.OutcomeNote != "" {
		b.note(tr(lang, "现场说明：", "On-site notes: ") + j.OutcomeNote)
	}
	if !s.stepReport(b, level, j, lang) {
		var rows [][]string
		for _, st := range steps {
			rows = append(rows, []string{st.Title, stepStateLabel(lang, st.State), st.By, stamp(st.At), st.Note})
		}
		if len(rows) == 0 {
			b.p(tr(lang, "现场没有在平台上逐步记录。", "No step-by-step on-site execution records logged on platform."))
		} else {
			b.table([]string{tr(lang, "步骤", "Step"), tr(lang, "结果", "Result"), tr(lang, "执行人", "Operator"), tr(lang, "时间", "Timestamp"), tr(lang, "说明", "Notes")}, rows)
		}
	}
	if ams := s.loadAmendments(j.ID); len(ams) > 0 {
		b.h(level, tr(lang, "执行中对手册的修改", "Runbook Amendments During Execution"))
		var items []string
		for _, a := range ams {
			what := tr(lang, "新增步骤「"+a.Step.Title+"」", fmt.Sprintf("Added step %q", a.Step.Title))
			if a.Kind == "replace" {
				what = tr(lang, "修改步骤「"+firstNonEmptyStr(a.AfterTitle, a.Step.Title)+"」的命令", fmt.Sprintf("Updated command for step %q", firstNonEmptyStr(a.AfterTitle, a.Step.Title)))
			}
			items = append(items, tr(lang, fmt.Sprintf("%s（%s，%s）：%s", what, a.By, stamp(a.At), a.Reason), fmt.Sprintf("%s (%s, %s): %s", what, a.By, stamp(a.At), a.Reason)))
		}
		b.list(items)
	}
	// problems met on a step are written under that step; the rest (about the delivery as a whole) are here
	var loose []aiReport
	inline := map[string]bool{}
	for _, t := range s.runbookStepsLang(j.ID, lang) {
		for _, st := range t.Steps {
			inline["step:"+st.Key] = true
		}
	}
	for _, r := range prog.Reports {
		if !inline[r.Key] {
			loose = append(loose, r)
		}
	}
	if len(loose) > 0 {
		b.h(level, tr(lang, "现场解决的问题", "Issues Resolved On-Site"))
		for _, r := range loose {
			writeUpBlocksLang(b, "", r, lang)
		}
	}
}

func nonEmpty(items ...string) []string {
	var out []string
	for _, x := range items {
		if i := strings.Index(x, "："); i >= 0 && strings.TrimSpace(x[i+len("："):]) == "" {
			continue
		}
		out = append(out, x)
	}
	return out
}

func (f clusterFacts) cover(extra ...[2]string) [][2]string {
	lang := f.Lang
	out := [][2]string{{tr(lang, "集群", "Cluster"), f.ID}, {tr(lang, "应用", "Application"), f.Current.AppName + " " + f.Current.Version}}
	if f.Plan != nil {
		out = append(out, [2]string{tr(lang, "规模", "Scale"), tr(lang, fmt.Sprintf("%d 台机器，控制节点 %s", len(f.Plan.Hosts), f.Plan.Controller), fmt.Sprintf("%d host(s), controller %s", len(f.Plan.Hosts), f.Plan.Controller))})
	}
	return append(out, extra...)
}

// ---- the documents ----

func (s *storeServer) buildDelivery(f clusterFacts) *clusterDoc {
	lang := f.Lang
	first := f.first()
	if first.DeliveryMode == "imported" {
		return s.buildImportedBaselineDoc(f, first)
	}
	d := &clusterDoc{ID: "delivery", Kind: "delivery", Title: tr(lang, "交付报告", "Delivery Report"), Subtitle: f.ID, Cluster: f.ID,
		Cover: f.cover([2]string{tr(lang, "首次部署", "Initial Deploy"), day(first.Created)}, [2]string{tr(lang, "负责人", "Owner"), first.Owner})}
	b := &docBuilder{}
	b.section(1, "summary", tr(lang, "1 概述", "1 Overview"), tr(lang, "这个集群是什么、为谁服务、怎么部署的、现在是什么状态。", "What this cluster is, what workload it serves, how it was deployed, and its current status."), true)
	b.h(1, tr(lang, "2 架构与拓扑", "2 Architecture & Topology"))
	b.p(tr(lang, fmt.Sprintf("以下按平台保存的「%s」配置展示。现场完成情况以执行结果和交付负责人确认记录为准。", jobTitleLang(f.Current, lang)), fmt.Sprintf("Displayed below from the platform-saved %q specification. Actual on-site state follows execution records and owner sign-off.", jobTitleLang(f.Current, lang))))
	topology(b, f.Plan, lang)
	b.h(2, tr(lang, "2.1 访问入口", "2.1 Access Endpoints"))
	if f.Plan != nil {
		n := len(b.blocks)
		entries(b, f.Plan, lang)
		if len(b.blocks) == n {
			b.p(tr(lang, "没有声明对外入口。", "No external endpoints declared."))
		}
	}
	b.h(1, tr(lang, "3 规格与版本", "3 Specification & Versions"))
	b.h(2, tr(lang, "3.1 定制参数", "3.1 Customized Parameters"))
	paramsTable(b, f.Plan, lang)
	b.h(2, tr(lang, "3.2 软件包", "3.2 Packages"))
	s.packagesTable(b, f.Current.ID, lang)
	if first.DeliveryMode == "configuration" {
		b.h(1, tr(lang, "4 配置交付记录", "4 Configuration Delivery Record"))
	} else {
		b.h(1, tr(lang, "4 首次部署记录", "4 Initial Deployment Record"))
	}
	b.p(tr(lang, fmt.Sprintf("%s 由 %s 生成交付材料。", stamp(first.Created), first.Owner), fmt.Sprintf("Generated on %s by %s.", stamp(first.Created), first.Owner)))
	s.record(b, 2, first, lang)
	b.h(1, tr(lang, "5 当前状态", "5 Current State"))
	var devs []string
	for _, j := range f.Jobs {
		if j.Outcome == outcomeDeviated && j.OutcomeNote != "" {
			devs = append(devs, jobTitleLang(j, lang)+tr(lang, "：", ": ")+j.OutcomeNote)
		}
	}
	b.p(tr(lang, fmt.Sprintf("集群当前以「%s」为准：%s。", jobTitleLang(f.Current, lang), jobOutcomeNameLang(f.Current, lang)), fmt.Sprintf("Active baseline is %q: %s.", jobTitleLang(f.Current, lang), jobOutcomeNameLang(f.Current, lang))))
	if len(devs) > 0 {
		b.p(tr(lang, "实际执行与原交付的出入（已计入当前状态）：", "On-site deviations from original delivery (accounted in current state):"))
		b.list(devs)
	}
	if sops := s.listFinalizedRehearsals(f.ID); len(sops) > 0 {
		b.h(2, tr(lang, "5.1 投产后变更台账与生产落地状态", "5.1 Post-Deployment Change Ledger"))
		var rows [][]string
		for _, rh := range sops {
			statusText := tr(lang, "已定稿 · 待实施", "Finalized · Pending")
			whoWhen := fmt.Sprintf("%s / %s", rh.Owner, stamp(rh.UpdatedAt))
			sumText := firstNonEmptyStr(rh.AppliedSummary, rh.ScopeSummary, "—")
			if rh.Applied && !rh.Voided {
				statusText = tr(lang, "已落地生效", "Applied in Prod")
				whoWhen = fmt.Sprintf("%s / %s", firstNonEmptyStr(rh.AppliedBy, rh.Owner), stamp(firstNonEmptyStr(rh.AppliedAt, rh.UpdatedAt)))
			} else if rh.Voided {
				statusText = tr(lang, "已作废", "Voided")
				whoWhen = fmt.Sprintf("%s / %s", firstNonEmptyStr(rh.VoidedBy, rh.Owner), stamp(firstNonEmptyStr(rh.VoidedAt, rh.UpdatedAt)))
				sumText = firstNonEmptyStr(rh.VoidReason, sumText)
			}
			rows = append(rows, []string{rh.Title, statusText, truncRunes(sumText, 120), whoWhen, "sop-" + rh.ID})
		}
		b.table([]string{
			tr(lang, "变更方案", "Change Plan"),
			tr(lang, "生产状态", "Prod Status"),
			tr(lang, "生效变更摘要", "Effective Summary"),
			tr(lang, "确认人 / 时间", "Confirmed By / At"),
			tr(lang, "文档编号", "Document ID"),
		}, rows)
		if eff := effectiveAppliedChanges(s.listAppliedRehearsals(f.ID)); len(eff) > 0 {
			b.h(2, tr(lang, "5.2 相对初始基线的当前最终生效参数与配置变更", "5.2 Effective Config & Parameter Deltas"))
			var deltaRows [][]string
			for _, ch := range eff {
				src := ch.SourceTitle
				if ch.UpdateCount > 1 {
					src += tr(lang, fmt.Sprintf("（累计调整 %d 次，以最新为准）", ch.UpdateCount), fmt.Sprintf(" (updated %dx, latest active)", ch.UpdateCount))
				}
				deltaRows = append(deltaRows, []string{ch.Key, firstNonEmptyStr(ch.Before, "—"), ch.After, src})
			}
			b.table([]string{
				tr(lang, "变更项", "Item"),
				tr(lang, "初始/变更前", "Before"),
				tr(lang, "当前最终生效", "Active Value"),
				tr(lang, "最新来源变更", "Latest Source"),
			}, deltaRows)
		}
	}
	b.section(1, "risks", tr(lang, "6 风险与遗留问题", "6 Risks & Open Issues"), tr(lang, "仍然存在的风险、没有解决的问题和建议，例如执行中的偏差、单点、后续容量与监控关注项。", "Remaining risks, unresolved issues, and follow-up recommendations covering deviations, SPOFs, capacity, and monitoring."), true)
	b.section(1, "acceptance", tr(lang, "7 验收结论", "7 Acceptance Conclusion"), tr(lang, "根据执行记录和测试结果给出结论；有失败或没执行的步骤要如实写明。", "Final acceptance verdict grounded in execution and verification logs; state any failed or unexecuted steps explicitly."), true)
	d.Blocks = b.blocks
	return d
}

func (s *storeServer) buildImportedBaselineDoc(f clusterFacts, first storeJob) *clusterDoc {
	lang := f.Lang
	dep := s.readSpec(f.Current.ID)
	var meta *mwpack.ImportedMeta
	if dep != nil {
		meta = dep.Imported
	}
	d := &clusterDoc{
		ID:       "delivery",
		Kind:     "delivery",
		Title:    tr(lang, "存量集群纳管基线档案", "Imported Cluster Baseline Archive"),
		Subtitle: f.ID,
		Cluster:  f.ID,
		Cover: f.cover(
			[2]string{tr(lang, "纳管来源", "Onboarding Source"), tr(lang, "存量纳管（非平台首次部署）", "Brownfield Imported")},
			[2]string{tr(lang, "建档时间", "Onboarded"), day(first.Created)},
			[2]string{tr(lang, "负责人", "Owner"), first.Owner},
		),
	}
	b := &docBuilder{}
	b.section(1, "summary", tr(lang, "1 集群概述", "1 Cluster Overview"), tr(lang, "描述该存量集群承载的业务系统、核心高可用架构、责任团队与日常运维边界。", "Business workload served by this brownfield cluster, HA architecture, owning team, and day-2 operational boundaries."), true)
	b.h(1, tr(lang, "2 架构与拓扑", "2 Architecture & Topology"))
	b.p(tr(lang, "以下基线由存量纳管档案记录，并可随现场只读探针或人工校对持续更新。", "Baseline recorded during brownfield onboarding; kept current via read-only probes or manual baseline updates."))
	topology(b, f.Plan, lang)
	b.h(2, tr(lang, "2.1 访问入口", "2.1 Access Endpoints"))
	if f.Plan != nil {
		n := len(b.blocks)
		entries(b, f.Plan, lang)
		if len(b.blocks) == n {
			b.p(tr(lang, "暂未登记对外访问入口。", "No access endpoints recorded."))
		}
	}
	if meta != nil && len(meta.Companions) > 0 {
		b.h(2, tr(lang, "2.2 伴生与支撑组件栈", "2.2 Companion & Supporting Stack"))
		kindLabel := map[string]string{
			"ha_manager": tr(lang, "高可用管理", "HA Manager"),
			"dcs":        tr(lang, "分布式协调 (DCS)", "Consensus / DCS"),
			"proxy":      tr(lang, "代理与负载均衡", "Proxy / LB"),
			"vip":        tr(lang, "虚拟 IP (VRRP)", "VIP / VRRP"),
			"pooler":     tr(lang, "连接池", "Connection Pooler"),
			"backup":       tr(lang, "备份工具", "Backup"),
			"monitoring":   tr(lang, "监控采集", "Monitoring"),
			"os_component": tr(lang, "OS 组件", "OS Component"),
			"companion":    tr(lang, "伴生组件", "Companion"),
		}
		var compRows [][]string
		for _, cm := range meta.Companions {
			effKind := cm.Kind
			if mwpack.IsOSCompanion(cm.Component) && (effKind == "" || effKind == "monitoring" || effKind == "companion") {
				effKind = "os_component"
			}
			var portStrs []string
			for _, pn := range cm.Ports {
				if pn > 0 {
					portStrs = append(portStrs, fmt.Sprint(pn))
				}
			}
			hostSummary := strings.Join(cm.Hosts, ", ")
			if hostSummary == "" && len(cm.Placement) > 0 {
				var parts []string
				for rk, hs := range cm.Placement {
					parts = append(parts, fmt.Sprintf("%s: %s", rk, strings.Join(hs, ",")))
				}
				hostSummary = strings.Join(parts, "; ")
			}
			compRows = append(compRows, []string{
				firstNonEmptyStr(cm.DisplayName, cm.Component),
				firstNonEmptyStr(kindLabel[effKind], effKind, tr(lang, "伴生组件", "Companion")),
				firstNonEmptyStr(cm.Version, "—"),
				firstNonEmptyStr(strings.Join(portStrs, ", "), "—"),
				firstNonEmptyStr(hostSummary, "—"),
				firstNonEmptyStr(cm.Evidence, strings.Join(cm.ServiceUnits, ", "), "—"),
			})
		}
		b.table([]string{
			tr(lang, "组件", "Component"),
			tr(lang, "定位", "Role"),
			tr(lang, "版本", "Version"),
			tr(lang, "端口", "Ports"),
			tr(lang, "部署节点", "Hosts"),
			tr(lang, "识别依据", "Evidence"),
		}, compRows)
	}
	b.h(1, tr(lang, "3 运行环境与路径基线", "3 Runtime Environment & Path Baseline"))
	if meta != nil {
		var rows [][]string
		addRow := func(k, v string) {
			if strings.TrimSpace(v) != "" {
				rows = append(rows, []string{k, v})
			}
		}
		deployMap := map[string]string{
			"systemd": tr(lang, "systemd 系统服务", "systemd service"),
			"docker":  tr(lang, "Docker / 容器化", "Docker / Container"),
			"binary":  tr(lang, "二进制手工部署", "Binary / Manual"),
			"k8s":     "Kubernetes",
			"other":   tr(lang, "其他部署形态", "Other"),
		}
		srcMap := map[string]string{
			"probe":  tr(lang, "只读探针脚本采集", "Read-only probe script"),
			"ai_doc": tr(lang, "文档 / 配置 / 截图识别", "Document / config / screenshot"),
			"manual": tr(lang, "手工录入建档", "Manual entry"),
		}
		addRow(tr(lang, "纳管录入方式", "Onboarding Method"), firstNonEmptyStr(srcMap[meta.SourceKind], meta.SourceKind))
		addRow(tr(lang, "部署形态", "Deploy Method"), firstNonEmptyStr(deployMap[meta.DeployMethod], meta.DeployMethod))
		addRow(tr(lang, "精确版本", "Exact Version"), firstNonEmptyStr(meta.ExactVersion, f.Current.Version))
		addRow(tr(lang, "操作系统", "Operating System"), firstNonEmptyStr(meta.OSDetail, dep.Platform))
		addRow(tr(lang, "架构摘要", "Architecture Summary"), meta.ArchSummary)
		addRow(tr(lang, "系统服务单元", "Service Units"), strings.Join(meta.ServiceUnits, ", "))
		addRow(tr(lang, "配置文件路径", "Config Paths"), strings.Join(meta.ConfigPaths, ", "))
		addRow(tr(lang, "数据目录", "Data Directories"), strings.Join(meta.DataDirs, ", "))
		addRow(tr(lang, "日志目录", "Log Directories"), strings.Join(meta.LogDirs, ", "))
		if meta.LastProbedAt != "" {
			addRow(tr(lang, "最近探针采集", "Last Probed"), stamp(meta.LastProbedAt))
		}
		if meta.BaselineUpdatedAt != "" {
			addRow(tr(lang, "最近基线更新", "Baseline Updated"), fmt.Sprintf("%s (%s)", stamp(meta.BaselineUpdatedAt), meta.BaselineUpdatedBy))
		}
		if len(rows) > 0 {
			b.table([]string{tr(lang, "基线项", "Baseline Field"), tr(lang, "登记值", "Recorded Value")}, rows)
		}
		if meta.Notes != "" {
			b.note(tr(lang, "运维备注：", "Operations Notes: ") + meta.Notes)
		}
	}
	b.h(2, tr(lang, "3.1 关键运行参数", "3.1 Key Parameters"))
	paramsTable(b, f.Plan, lang)
	b.h(2, tr(lang, "3.2 采集到的软件包清单", "3.2 Collected Packages"))
	s.packagesTable(b, f.Current.ID, lang)
	if sops := s.listFinalizedRehearsals(f.ID); len(sops) > 0 {
		b.h(1, tr(lang, "4 纳管后变更演练与生产落地台账", "4 Post-Onboarding Change Ledger"))
		var rows [][]string
		for _, rh := range sops {
			statusText := tr(lang, "已定稿 · 待实施", "Finalized · Pending")
			whoWhen := fmt.Sprintf("%s / %s", rh.Owner, stamp(rh.UpdatedAt))
			sumText := firstNonEmptyStr(rh.AppliedSummary, rh.ScopeSummary, "—")
			if rh.Applied && !rh.Voided {
				statusText = tr(lang, "已落地生效", "Applied in Prod")
				whoWhen = fmt.Sprintf("%s / %s", firstNonEmptyStr(rh.AppliedBy, rh.Owner), stamp(firstNonEmptyStr(rh.AppliedAt, rh.UpdatedAt)))
			} else if rh.Voided {
				statusText = tr(lang, "已作废", "Voided")
				whoWhen = fmt.Sprintf("%s / %s", firstNonEmptyStr(rh.VoidedBy, rh.Owner), stamp(firstNonEmptyStr(rh.VoidedAt, rh.UpdatedAt)))
				sumText = firstNonEmptyStr(rh.VoidReason, sumText)
			}
			rows = append(rows, []string{rh.Title, statusText, truncRunes(sumText, 120), whoWhen, "sop-" + rh.ID})
		}
		b.table([]string{
			tr(lang, "变更方案", "Change Plan"),
			tr(lang, "生产状态", "Prod Status"),
			tr(lang, "生效变更摘要", "Effective Summary"),
			tr(lang, "确认人 / 时间", "Confirmed By / At"),
			tr(lang, "文档编号", "Document ID"),
		}, rows)
		if eff := effectiveAppliedChanges(s.listAppliedRehearsals(f.ID)); len(eff) > 0 {
			b.h(2, tr(lang, "4.1 相对纳管基线的当前生效变更", "4.1 Active Deltas vs. Onboarded Baseline"))
			var deltaRows [][]string
			for _, ch := range eff {
				src := ch.SourceTitle
				if ch.UpdateCount > 1 {
					src += tr(lang, fmt.Sprintf("（累计调整 %d 次，以最新为准）", ch.UpdateCount), fmt.Sprintf(" (updated %dx, latest active)", ch.UpdateCount))
				}
				deltaRows = append(deltaRows, []string{ch.Key, firstNonEmptyStr(ch.Before, "—"), ch.After, src})
			}
			b.table([]string{
				tr(lang, "变更项", "Item"),
				tr(lang, "变更前", "Before"),
				tr(lang, "当前最终生效", "Active Value"),
				tr(lang, "来源变更", "Source Change"),
			}, deltaRows)
		}
	}
	b.section(1, "risks", tr(lang, "5 风险项与后续治理建议", "5 Risks & Governance Notes"), tr(lang, "记录该存量集群已知的单点风险、版本升级窗口、备份核验与监控告警待补齐项。", "Known SPOFs, upgrade windows, backup verification gaps, and monitoring action items."), true)
	d.Blocks = b.blocks
	return d
}

func (s *storeServer) buildKT(f clusterFacts) *clusterDoc {
	lang := f.Lang
	d := &clusterDoc{ID: "kt", Kind: "kt", Title: tr(lang, "运维交接文档", "Operations Handover"), Subtitle: f.ID, Cluster: f.ID,
		Cover: f.cover([2]string{tr(lang, "依据", "Baseline"), tr(lang, jobTitleLang(f.Current, lang)+"的配置与执行记录", jobTitleLang(f.Current, lang)+" configuration & execution record")})}
	b := &docBuilder{}
	b.h(1, tr(lang, "1 架构", "1 Architecture"))
	topology(b, f.Plan, lang)
	b.section(2, "arch", tr(lang, "1.1 架构说明", "1.1 Architecture Notes"), tr(lang, "面向运维人员：各节点做什么，数据怎么复制，高可用怎么工作，坏了一台会发生什么。", "For operations teams: node roles, data replication, HA failover mechanics, and single-node failure impact."), true)
	b.h(1, tr(lang, "2 访问与位置", "2 Access & Locations"))
	if f.Plan != nil {
		entries(b, f.Plan, lang)
		var rows [][]string
		sep := tr(lang, "、", ", ")
		for _, inst := range f.Plan.Instances {
			for _, pu := range inst.Ports {
				rows = append(rows, []string{inst.ID, pu.Name, fmt.Sprintf("%d/%s", pu.Port, pu.Proto), strings.Join(pu.Hosts, sep)})
			}
		}
		b.h(2, tr(lang, "2.1 端口", "2.1 Ports"))
		b.table([]string{tr(lang, "实例", "Instance"), tr(lang, "用途", "Purpose"), tr(lang, "端口", "Port"), tr(lang, "机器", "Hosts")}, rows)
		b.h(2, tr(lang, "2.2 平台生成的文件", "2.2 Platform-Generated Files"))
		b.list([]string{
			tr(lang, "Ansible 项目在执行机 "+f.Plan.Controller+" 的 "+f.Plan.RuntimeRoot()+"/projects/"+f.Plan.ProjectName()+" 下。", "Ansible project resides on controller "+f.Plan.Controller+" under "+f.Plan.RuntimeRoot()+"/projects/"+f.Plan.ProjectName()+"."),
			tr(lang, "密码保存在该项目的 secrets/ 目录（只有 root 可读），不在本文档里；交接时当面确认谁有权查看。", "Credentials are stored in the project's secrets/ directory (root-only permissions) and omitted from this document; verify authorized access during handover."),
		})
	}
	ops := 0
	if f.Plan != nil {
		for _, inst := range f.Plan.Instances {
			if inst.External {
				continue
			}
			o := mwpack.LocalizeOperations(lang, inst.InstanceOperations(f.ID))
			if o == nil {
				continue
			}
			ops++
			b.h(1, fmt.Sprintf("%d %s (%s %s)", 2+ops, inst.ID, mwpack.TranslateCatalogText(lang, inst.Title), inst.Version))
			b.p(o.Overview)
			if len(o.Checks) > 0 {
				b.h(2, tr(lang, "日常巡检", "Routine Health Checks"))
				for _, c := range o.Checks {
					b.h(3, c.Title)
					if c.Hosts != "" {
						b.p(tr(lang, "在"+c.Hosts+"上执行：", "Run on "+c.Hosts+":"))
					}
					b.code(c.Cmd)
					if c.Expect != "" {
						b.p(tr(lang, "正常："+c.Expect, "Expected: "+c.Expect))
					}
				}
			}
			if len(o.Tasks) > 0 {
				b.h(2, tr(lang, "常见操作", "Routine Operations"))
				for _, t := range o.Tasks {
					b.h(3, t.Title)
					b.code(t.Cmd)
					if t.Note != "" {
						b.note(t.Note)
					}
				}
			}
			if len(o.Faults) > 0 {
				b.h(2, tr(lang, "典型问题与排查", "Troubleshooting & Faults"))
				for _, x := range o.Faults {
					b.h(3, x.Title)
					if x.Symptom != "" {
						b.p(tr(lang, "现象："+x.Symptom, "Symptom: "+x.Symptom))
					}
					b.list(x.Steps)
					b.code(x.Cmd)
				}
			}
			if len(o.Logs) > 0 {
				b.h(2, tr(lang, "日志与文件", "Logs & Config Paths"))
				var rows [][]string
				for _, l := range o.Logs {
					rows = append(rows, []string{l.Name, l.Text})
				}
				b.table([]string{tr(lang, "内容", "Item"), tr(lang, "位置", "Path")}, rows)
			}
		}
	}
	if ops == 0 {
		b.note(tr(lang, "组件没有提供运维知识。可以在组件工作台为组件补上 operations，或让 AI 在下一节起草。", "Component does not declare operations runbook metadata. Add operations in Component Workbench or have AI draft the notes below."))
	}
	n := 3 + ops
	b.section(1, "specific", fmt.Sprintf("%d %s", n, tr(lang, "这个集群的注意事项", "Cluster-Specific Notes")), tr(lang, "结合实际拓扑、版本、经历过的变更和执行偏差，补充上面的通用内容没有覆盖、只适用于这个集群的注意点。", "Add cluster-specific caveats not covered above, accounting for topology, versions, changes, and deviations."), true)
	b.h(1, fmt.Sprintf("%d %s", n+1, tr(lang, "变更须知", "Change Guidelines")))
	b.list([]string{
		tr(lang, "生产集群后续的升级、扩容、缩容与关键参数变更，应先核实现场真实主从角色与配置现状，严禁直接盲跑首次部署剧本覆盖运行中的集群。", "For production upgrades, scaling, or parameter changes, always verify live primary/replica roles and config drift first; never blindly re-run initial deployment playbooks over live clusters."),
		tr(lang, "启用平台 AI 后，可在该集群的「变更演练」工作台生成 100% 只读采集探针，并在测试环境逐步验证命令与回退预案，定稿输出《生产变更实施方案》。", "With platform AI enabled, generate a 100% read-only discovery probe in the Change Rehearsal workspace, validate steps and rollback in staging, and finalize a Production Change SOP."),
		tr(lang, "首次部署执行中若实际做法与手册不同，确认结果时选择「有偏差」并写明差异。", "If actual initial deployment diverged from the runbook, record 'Completed with Deviations' when confirming outcome and document the differences."),
	})
	var devs []string
	for _, j := range f.Jobs {
		if j.Outcome == outcomeDeviated && j.OutcomeNote != "" {
			devs = append(devs, jobTitleLang(j, lang)+tr(lang, "：", ": ")+j.OutcomeNote)
		}
	}
	if len(devs) > 0 {
		b.p(tr(lang, "已知的执行偏差：", "Known execution deviations:"))
		b.list(devs)
	}
	b.section(1, "contacts", fmt.Sprintf("%d %s", n+2, tr(lang, "联系人与升级路径", "Contacts & Escalation Path")), tr(lang, "运维联系人、值班电话、遇到问题时逐级找谁。", "On-call contacts, phone numbers, and escalation chain when issues arise."), false)
	d.Blocks = b.blocks
	return d
}

func (s *storeServer) buildRCA(f clusterFacts, j storeJob) *clusterDoc {
	lang := f.Lang
	d := &clusterDoc{ID: "rca-" + j.ID, Kind: "rca", Title: tr(lang, "根因分析报告", "Root Cause Analysis"), Subtitle: jobTitleLang(j, lang), Cluster: f.ID, Job: j.ID,
		Cover: f.cover([2]string{tr(lang, "交付", "Delivery"), jobTitleLang(j, lang)}, [2]string{tr(lang, "结果", "Outcome"), jobOutcomeNameLang(j, lang)})}
	b := &docBuilder{}
	steps, prog := s.execRecord(j.ID)
	n := 0
	num := func(t string) string { n++; return fmt.Sprintf("%d %s", n, t) }
	b.section(1, "symptom", num(tr(lang, "现象", "Symptoms")), tr(lang, "出了什么问题，在哪一步、什么时间被发现。", "What went wrong, at which step, and when it was observed."), true)
	b.section(1, "impact", num(tr(lang, "影响范围", "Impact Scope")), tr(lang, "影响了哪些机器、服务和业务，持续多久。", "Affected hosts, services, workloads, and total duration."), true)
	b.h(1, num(tr(lang, "时间线", "Timeline")))
	var rows [][]string
	for _, e := range prog.Events {
		st := stepStateLabel(lang, e.State)
		if e.State == "" {
			st = tr(lang, "清除记录", "Cleared")
		}
		rows = append(rows, []string{stamp(e.At), e.By, e.Title, st})
	}
	if j.Marked != "" {
		rows = append(rows, []string{stamp(j.Marked), j.MarkedBy, tr(lang, "确认结果", "Confirmed Outcome"), jobOutcomeNameLang(j, lang)})
	}
	if len(rows) == 0 {
		b.p(tr(lang, "现场没有在平台上记录。", "No on-site timeline recorded on platform."))
	}
	b.table([]string{tr(lang, "时间", "Time"), tr(lang, "人", "Actor"), tr(lang, "步骤", "Step"), tr(lang, "记录", "State")}, rows)
	b.h(1, num(tr(lang, "失败的步骤", "Failed Steps")))
	failed := 0
	for _, st := range steps {
		if st.State != "failed" {
			continue
		}
		failed++
		b.h(2, st.Title)
		b.p(tr(lang, fmt.Sprintf("%s 由 %s 记为失败。%s", stamp(st.At), st.By, st.Note), fmt.Sprintf("Marked failed on %s by %s. %s", stamp(st.At), st.By, st.Note)))
		log := st.Log
		if len(log) > 4000 {
			log = "...\n" + log[len(log)-4000:]
		}
		b.code(log)
	}
	if failed == 0 {
		b.p(tr(lang, "执行记录里没有标为失败的步骤。", "No step was marked as failed in the execution log."))
	}
	if j.OutcomeNote != "" {
		b.note(tr(lang, "现场说明：", "On-site notes: ") + j.OutcomeNote)
	}
	if len(prog.Reports) > 0 || len(s.loadAmendments(j.ID)) > 0 {
		b.h(1, num(tr(lang, "现场的排查", "On-Site Investigation")))
		for _, r := range prog.Reports {
			b.p("**" + firstNonEmptyStr(r.Title, r.Symptom) + "**")
			b.list(nonEmpty(
				tr(lang, "现象：", "Symptom: ")+r.Symptom,
				tr(lang, "证据：", "Evidence: ")+r.Evidence,
				tr(lang, "原因：", "Cause: ")+r.Cause,
				tr(lang, "处理：", "Resolution: ")+r.Fix,
			))
		}
		var items []string
		for _, a := range s.loadAmendments(j.ID) {
			items = append(items, fmt.Sprintf("%q: %s", a.Step.Title, a.Reason))
		}
		if len(items) > 0 {
			b.p(tr(lang, "执行中采纳的手册修改：", "Runbook amendments adopted during execution:"))
			b.list(items)
		}
	}
	b.section(1, "cause", num(tr(lang, "根因分析", "Root Cause Analysis")), tr(lang, "直接原因和根本原因，说明依据；判断不了的写明还需要什么信息。", "Immediate and underlying causes with supporting evidence; note missing data if inconclusive."), true)
	b.section(1, "handling", num(tr(lang, "处理过程", "Remediation & Recovery")), tr(lang, "做了什么、恢复到了什么状态。", "Actions taken and the verified recovery state."), true)
	b.section(1, "improve", num(tr(lang, "改进建议", "Corrective Actions")), tr(lang, "避免再次发生要改什么：组件、手册、流程、监控。", "Preventive improvements across components, runbooks, workflows, and monitoring."), true)
	d.Blocks = b.blocks
	return d
}

// buildIncident is a root-cause analysis of something that happened to the running cluster outside any plan: the
// platform knows the cluster and its history, the people on site know what happened.
func (s *storeServer) buildIncident(f clusterFacts, e rcaEntry) *clusterDoc {
	lang := f.Lang
	d := &clusterDoc{ID: e.ID, Kind: "rca", Title: tr(lang, "根因分析报告", "Root Cause Analysis"), Subtitle: firstNonEmptyStr(e.Title, tr(lang, "集群故障", "Cluster Incident")), Cluster: f.ID,
		Cover: f.cover([2]string{tr(lang, "事件", "Incident"), firstNonEmptyStr(e.Title, tr(lang, "集群故障", "Cluster Incident"))}, [2]string{tr(lang, "发起", "Opened"), stamp(e.Created) + tr(lang, "，", ", ") + e.By})}
	b := &docBuilder{}
	n := 0
	num := func(t string) string { n++; return fmt.Sprintf("%d %s", n, t) }
	b.section(1, "symptom", num(tr(lang, "现象", "Symptoms")), tr(lang, "出了什么问题，什么时间、怎么发现的，报错或告警是什么。", "What failed, when and how it was detected, and the exact error or alert."), true)
	b.section(1, "impact", num(tr(lang, "影响范围", "Impact Scope")), tr(lang, "影响了哪些机器、服务和业务，持续多久。", "Affected hosts, services, workloads, and total duration."), true)
	b.section(1, "timeline", num(tr(lang, "时间线", "Timeline")), tr(lang, "按时间写清楚发生了什么、谁做了什么。", "Chronological log of events and operator actions."), true)
	b.h(1, num(tr(lang, "出事时的集群", "Cluster Baseline at Incident")))
	b.p(tr(lang, fmt.Sprintf("平台记录的集群以「%s」为准（%s）。", jobTitleLang(f.Current, lang), jobOutcomeNameLang(f.Current, lang)), fmt.Sprintf("Recorded cluster baseline is %q (%s).", jobTitleLang(f.Current, lang), jobOutcomeNameLang(f.Current, lang))))
	topology(b, f.Plan, lang)
	var rows [][]string
	for _, j := range f.Jobs {
		rows = append(rows, []string{jobTitleLang(j, lang), stamp(j.Created), jobOutcomeNameLang(j, lang), j.OutcomeNote})
	}
	b.h(2, tr(lang, "经历过的交付", "Delivery History"))
	b.table([]string{tr(lang, "交付", "Delivery"), tr(lang, "生成", "Created"), tr(lang, "结果", "Outcome"), tr(lang, "说明", "Notes")}, rows)
	b.section(1, "cause", num(tr(lang, "根因分析", "Root Cause Analysis")), tr(lang, "直接原因和根本原因，说明依据；判断不了的写明还需要什么信息。", "Immediate and underlying causes with evidence; note missing data if inconclusive."), true)
	b.section(1, "handling", num(tr(lang, "处理过程", "Remediation & Recovery")), tr(lang, "做了什么、恢复到了什么状态。", "Actions taken and the verified recovery state."), true)
	b.section(1, "improve", num(tr(lang, "改进建议", "Corrective Actions")), tr(lang, "避免再次发生要改什么：组件、手册、流程、监控；需要后续变更集群的，写明建议通过变更演练或调整哪些参数。", "Preventive actions across components, runbooks, process, and monitoring; note recommended Change Rehearsal or config adjustments."), true)
	d.Blocks = b.blocks
	return d
}

var assessTypes = map[string]string{"capacity": "容量评估", "selection": "选型建议"}

func assessTitle(lang, typ string) string {
	if isEnLang(lang) {
		return map[string]string{"capacity": "Capacity Assessment", "selection": "Architecture Selection"}[typ]
	}
	return assessTypes[typ]
}

// buildAssess is an assessment in the cluster's case file: the question, the cluster as it is, what people told the
// assistant, the analysis and the conclusion — which ends in the plan to make, if any.
func (s *storeServer) buildAssess(f clusterFacts, e assessEntry) *clusterDoc {
	lang := f.Lang
	title := assessTitle(lang, e.Type)
	d := &clusterDoc{ID: e.ID, Kind: "assess", Title: title, Subtitle: truncRunes(e.Question, 40), Cluster: f.ID,
		Cover: f.cover([2]string{tr(lang, "类型", "Type"), title}, [2]string{tr(lang, "提出", "Requested"), stamp(e.Created) + tr(lang, "，", ", ") + e.By})}
	b := &docBuilder{}
	b.section(1, "goal", tr(lang, "1 要回答的问题", "1 Objective"), tr(lang, "要评估什么，为什么现在要评估。", "What is being evaluated and why it is needed now."), false)
	b.h(1, tr(lang, "2 集群现状", "2 Current Cluster State"))
	b.p(tr(lang, fmt.Sprintf("平台记录的集群以「%s」为准（%s）。", jobTitleLang(f.Current, lang), jobOutcomeNameLang(f.Current, lang)), fmt.Sprintf("Recorded cluster baseline is %q (%s).", jobTitleLang(f.Current, lang), jobOutcomeNameLang(f.Current, lang))))
	topology(b, f.Plan, lang)
	b.h(2, tr(lang, "2.1 定制参数", "2.1 Customized Parameters"))
	paramsTable(b, f.Plan, lang)
	if f.Plan != nil {
		var rows [][]string
		for _, inst := range f.Plan.Instances {
			if inst.External {
				continue
			}
			for _, r := range inst.R.Roles {
				if hs := inst.Roles[r.Name]; len(hs) > 0 {
					adv := ""
					if r.Advise > 0 {
						why := mwpack.TranslateCatalogText(lang, r.AdviseWhy)
						adv = tr(lang, fmt.Sprintf("超过 %d 台时注意：%s", r.Advise, r.AdviseWhy), fmt.Sprintf("Note above %d nodes: %s", r.Advise, why))
					}
					rows = append(rows, []string{inst.ID, roleTitleLang(inst, r.Name, lang), fmt.Sprint(len(hs)), adv})
				}
			}
		}
		b.h(2, tr(lang, "2.2 角色与规模", "2.2 Roles & Scale"))
		b.table([]string{tr(lang, "实例", "Instance"), tr(lang, "角色", "Role"), tr(lang, "台数", "Count"), tr(lang, "组件的建议", "Component Advisory")}, rows)
	}
	if e.Type == "selection" {
		var rows [][]string
		for _, n := range s.plat.cat().Names() {
			c, ok := s.plat.cat().Get(n)
			if !ok {
				continue
			}
			rows = append(rows, []string{mwpack.TranslateCatalogText(lang, c.Title), mwpack.TranslateCatalogText(lang, c.Category), truncRunes(mwpack.TranslateCatalogText(lang, c.Summary), 120)})
		}
		b.h(2, tr(lang, "2.3 平台上可用的组件", "2.3 Available Platform Components"))
		b.table([]string{tr(lang, "组件", "Component"), tr(lang, "类别", "Category"), tr(lang, "说明", "Summary")}, rows)
	}
	b.section(1, "inputs", tr(lang, "3 输入与假设", "3 Inputs & Assumptions"), tr(lang, "业务量、数据量、增长速度、机器配置等评估依据；平台不知道的由现场提供，没有的写成假设。", "Workload volume, data size, growth rate, and hardware specs; document unknown parameters explicitly as assumptions."), true)
	b.section(1, "analysis", tr(lang, "4 分析", "4 Analysis"), tr(lang, "依据上面的现状和输入，说明计算过程和判断理由。", "Detailed sizing calculations and engineering rationale based on current state and inputs."), true)
	b.section(1, "conclusion", tr(lang, "5 结论与建议", "5 Conclusions & Recommendations"), tr(lang, "结论；需要后续变更集群的，写明建议通过变更演练实施的调整方向（如扩容、改配置、升级），以及主要参数。", "Summary verdict; specify recommended scaling, tuning, or upgrades to validate via Change Rehearsal."), true)
	d.Blocks = b.blocks
	return d
}

func (s *storeServer) upsertChangeNoteDoc(clusterID string, rep aiReport) string {
	if !docClusterID.MatchString(clusterID) {
		return ""
	}
	docIdxMu.Lock()
	defer docIdxMu.Unlock()
	idx := s.docIndex(clusterID)
	now := firstNonEmptyStr(rep.At, time.Now().UTC().Format(time.RFC3339))
	title := truncRunes(firstNonEmptyStr(strings.TrimSpace(rep.Title), "现场变更报告"), 80)
	for i := range idx.Changes {
		if rep.Session != "" && idx.Changes[i].Session == rep.Session {
			idx.Changes[i].Title = title
			idx.Changes[i].Symptom = rep.Symptom
			idx.Changes[i].Evidence = rep.Evidence
			idx.Changes[i].Cause = rep.Cause
			idx.Changes[i].Fix = rep.Fix
			idx.Changes[i].Changed = rep.Changed
			idx.Changes[i].Followups = rep.Followups
			idx.Changes[i].Model = rep.Model
			idx.Changes[i].Updated = now
			idx.Changes[i].By = rep.By
			_ = writeJSONFile(filepath.Join(s.cfg.DataDir, "docs", clusterID, "index.json"), idx)
			return idx.Changes[i].ID
		}
	}
	e := changeNoteEntry{
		ID:        "chg-" + randomStoreToken(6),
		Session:   rep.Session,
		Title:     title,
		Symptom:   rep.Symptom,
		Evidence:  rep.Evidence,
		Cause:     rep.Cause,
		Fix:       rep.Fix,
		Changed:   rep.Changed,
		Followups: rep.Followups,
		Model:     rep.Model,
		Created:   now,
		Updated:   now,
		By:        rep.By,
	}
	idx.Changes = append([]changeNoteEntry{e}, idx.Changes...)
	if err := writeJSONFile(filepath.Join(s.cfg.DataDir, "docs", clusterID, "index.json"), idx); err != nil {
		return ""
	}
	return e.ID
}

func appendMarkdownBlocks(b *docBuilder, raw string) {
	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	var paraBuf []string
	var codeBuf []string
	inCode := false
	flushPara := func() {
		if len(paraBuf) == 0 {
			return
		}
		txt := strings.TrimSpace(strings.Join(paraBuf, "\n"))
		if txt != "" {
			b.p(txt)
		}
		paraBuf = nil
	}
	for _, ln := range lines {
		trim := strings.TrimSpace(ln)
		if strings.HasPrefix(trim, "```") {
			if !inCode {
				flushPara()
				inCode = true
				codeBuf = nil
			} else {
				b.code(strings.Join(codeBuf, "\n"))
				inCode = false
				codeBuf = nil
			}
			continue
		}
		if inCode {
			codeBuf = append(codeBuf, ln)
			continue
		}
		if trim == "" {
			flushPara()
		} else {
			paraBuf = append(paraBuf, ln)
		}
	}
	if inCode && len(codeBuf) > 0 {
		b.code(strings.Join(codeBuf, "\n"))
	} else {
		flushPara()
	}
}

func (s *storeServer) buildChangeNoteDoc(f clusterFacts, e changeNoteEntry) *clusterDoc {
	lang := f.Lang
	sub := firstNonEmptyStr(e.Title, tr(lang, "现场变更与处置", "On-Site Change"))
	ts := firstNonEmptyStr(e.Updated, e.Created)
	coverFacts := [][2]string{
		{tr(lang, "变更主题", "Change Title"), sub},
		{tr(lang, "归档时间", "Archived At"), stamp(ts) + tr(lang, "，", ", ") + e.By},
		{tr(lang, "记录来源", "Source"), tr(lang, "AI 助手对话归档", "AI Assistant Chat")},
	}
	if e.Changed {
		coverFacts = append(coverFacts, [2]string{tr(lang, "基线偏差", "Baseline Drift"), tr(lang, "已标记首次交付规格待同步改进", "Flagged baseline delivery for follow-up update")})
	}
	d := &clusterDoc{
		ID:       e.ID,
		Kind:     "change",
		Title:    tr(lang, "变更报告", "Change Report"),
		Subtitle: sub,
		Cluster:  f.ID,
		Cover:    f.cover(coverFacts...),
		Updated:  ts,
		Manual:   true,
	}
	b := &docBuilder{}
	if strings.TrimSpace(e.Symptom) != "" {
		b.h(1, tr(lang, "1 变更背景与现象", "1 Background & Context"))
		appendMarkdownBlocks(b, e.Symptom)
	}
	if strings.TrimSpace(e.Cause) != "" {
		b.h(1, tr(lang, "2 原因与变更依据", "2 Root Cause & Rationale"))
		appendMarkdownBlocks(b, e.Cause)
	}
	if strings.TrimSpace(e.Fix) != "" {
		b.h(1, tr(lang, "3 执行命令与处理经过", "3 Execution Commands & Resolution"))
		appendMarkdownBlocks(b, e.Fix)
	}
	if strings.TrimSpace(e.Evidence) != "" {
		b.h(1, tr(lang, "4 关键现场证据", "4 Key Evidence"))
		b.code(e.Evidence)
	}
	if len(e.Followups) > 0 {
		b.h(1, tr(lang, "5 后续跟进事项", "5 Follow-Up Actions"))
		b.list(e.Followups)
	}
	b.section(1, "remark", tr(lang, "附：复核与签字说明", "Appendix: Review & Sign-Off Notes"), tr(lang, "可补充本次变更的审批单号、观察结果或复核签字信息。", "Optional ticket ID, post-change observations, or sign-off notes."), false)
	d.Blocks = b.blocks
	return d
}

// rcaJobs are the plans that failed, or had failed steps, and so deserve a root-cause analysis.
func rcaJobs(f clusterFacts) []storeJob {
	var out []storeJob
	for _, j := range f.Jobs {
		if j.Outcome == outcomeFailed || j.RunFailed > 0 {
			out = append(out, j)
		}
	}
	return out
}

// buildDoc builds one document by id, with its saved sections filled in.
func (s *storeServer) buildDoc(f clusterFacts, id string) (*clusterDoc, bool) {
	var d *clusterDoc
	switch {
	case id == "delivery":
		d = s.buildDelivery(f)
	case id == "kt":
		d = s.buildKT(f)
	case strings.HasPrefix(id, "sop-"):
		var ok bool
		d, ok = s.buildRehearsalSOP(f, strings.TrimPrefix(id, "sop-"))
		if !ok {
			return nil, false
		}
	case strings.HasPrefix(id, "chg-"):
		e, ok := s.docIndex(f.ID).change(id)
		if !ok {
			return nil, false
		}
		d = s.buildChangeNoteDoc(f, e)
	case strings.HasPrefix(id, "assess-"):
		e, ok := s.docIndex(f.ID).assess(id)
		if !ok {
			return nil, false
		}
		d = s.buildAssess(f, e)
	case strings.HasPrefix(id, "rca-x"):
		e, ok := s.docIndex(f.ID).rca(id)
		if !ok {
			return nil, false
		}
		d = s.buildIncident(f, e)
	case strings.HasPrefix(id, "rca-"):
		j, ok := f.job(strings.TrimPrefix(id, "rca-"))
		_, started := s.docIndex(f.ID).rca(id)
		if !ok || !(j.Outcome == outcomeFailed || j.RunFailed > 0 || started) {
			return nil, false
		}
		d = s.buildRCA(f, j)
	default:
		return nil, false
	}
	if d.Kind == "rca" {
		_, d.Manual = s.docIndex(f.ID).rca(id)
	}
	if d.Kind == "assess" {
		d.Manual = true
	}
	saved := s.docLoad(f.ID, id)
	if (d.Kind == "rca" || d.Kind == "assess") && len(saved.Answers) > 0 {
		var items []string
		for _, a := range saved.Answers {
			items = append(items, tr(f.Lang, "问："+a.Question+" 答："+a.Answer, "Q: "+a.Question+" A: "+a.Answer))
		}
		d.Blocks = append(d.Blocks, docBlock{Kind: "h", Level: 1, Text: tr(f.Lang, "附：现场补充的信息", "Appendix: Additional On-Site Notes")}, docBlock{Kind: "list", Items: items})
	}
	for i := range d.Blocks {
		b := &d.Blocks[i]
		if b.Kind != "section" {
			continue
		}
		d.Sections++
		if sec, ok := saved.Sections[b.Key]; ok && strings.TrimSpace(sec.Text) != "" {
			b.Text, b.Source, b.Confirmed, b.By, b.At = sec.Text, sec.Source, sec.Confirmed, sec.By, sec.At
			if sec.Source == "ai" && !sec.Confirmed {
				d.Drafts++
			}
			if sec.At > d.Updated {
				d.Updated = sec.At
			}
		} else {
			d.Empty++
		}
	}
	return d, true
}

// docIDs lists the documents a cluster has, in the order they are shown.
func docIDs(f clusterFacts, idx docIndex, sopIDs []string) []string {
	ids := []string{"delivery", "kt"}
	if f.Current.DeliveryMode == "imported" {
		ids = []string{"delivery"}
	}
	ids = append(ids, sopIDs...)
	for _, e := range idx.Changes {
		ids = append(ids, e.ID)
	}
	seen := map[string]bool{}
	for _, j := range rcaJobs(f) {
		ids = append(ids, "rca-"+j.ID)
		seen["rca-"+j.ID] = true
	}
	for _, e := range idx.RCA {
		if !seen[e.ID] {
			ids = append(ids, e.ID)
		}
	}
	for _, e := range idx.Assess {
		ids = append(ids, e.ID)
	}
	return ids
}

// ---- report template ----

// reportSettings is what the built-in Word template lets an organisation set. {org}, {cluster}, {title} and
// {date} are filled in.
type reportSettings struct {
	// UseTemplate exports into the uploaded Word template instead of the built-in one; Template is its file name.
	UseTemplate  bool   `json:"use_template"`
	Template     string `json:"template,omitempty"`
	Org          string `json:"org"`
	Project      string `json:"project,omitempty"`
	Slogan       string `json:"slogan,omitempty"`
	DocVersion   string `json:"doc_version,omitempty"`
	Author       string `json:"author,omitempty"`
	Reviewer     string `json:"reviewer,omitempty"`
	Theme        string `json:"theme,omitempty"`
	Banner       string `json:"banner,omitempty"`
	Confidential string `json:"confidential"`
	Header       string `json:"header"`
	Footer       string `json:"footer"`
	Note         string `json:"note"`
}

func (s *storeServer) reportSettings() reportSettings {
	r := reportSettings{
		Confidential: "内部",
		DocVersion:   "V1.0",
		Theme:        "teal",
		Slogan:       "标准化部署与高可用运维体系",
		Header:       "{cluster} · {title}",
		Footer:       "{org}",
	}
	if b, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "settings", "report.json")); err == nil {
		_ = json.Unmarshal(b, &r)
	}
	r.Theme = themeOf(r.Theme).ID
	if strings.TrimSpace(r.DocVersion) == "" {
		r.DocVersion = "V1.0"
	}
	return r
}

func (r reportSettings) fill(t, cluster, title string, extra ...string) string {
	app := ""
	if len(extra) > 0 {
		app = extra[0]
	}
	return strings.NewReplacer(
		"{org}", r.Org,
		"{cluster}", cluster,
		"{title}", title,
		"{date}", time.Now().Format("2006-01-02"),
		"{version}", firstNonEmptyStr(r.DocVersion, "V1.0"),
		"{project}", firstNonEmptyStr(r.Project, cluster),
		"{author}", r.Author,
		"{reviewer}", r.Reviewer,
		"{slogan}", r.Slogan,
		"{app}", app,
	).Replace(t)
}

func (s *storeServer) reportBannerPath() string {
	return filepath.Join(s.cfg.DataDir, "settings", "report-banner.bin")
}

func (s *storeServer) reportBannerBytes() []byte {
	b, err := os.ReadFile(s.reportBannerPath())
	if err != nil || len(b) == 0 {
		return nil
	}
	return b
}

func (s *storeServer) reportTemplatePath() string {
	return filepath.Join(s.cfg.DataDir, "settings", "report-template.docx")
}

// reportTemplate is the uploaded Word template; nil when there is none or it cannot be read.
func (s *storeServer) reportTemplate() *docxTemplate {
	b, err := os.ReadFile(s.reportTemplatePath())
	if err != nil {
		return nil
	}
	t, err := parseTemplate(b)
	if err != nil {
		return nil
	}
	return t
}

func (s *storeServer) reportSettingsFor(lang string) reportSettings {
	r := s.reportSettings()
	if isEnLang(lang) {
		if r.Confidential == "内部" {
			r.Confidential = "Internal"
		}
		if r.Slogan == "标准化部署与高可用运维体系" {
			r.Slogan = "Standardized Deployment & High-Availability Operations"
		}
	}
	return r
}

func (s *storeServer) handleReportSettings(w http.ResponseWriter, r *http.Request, session storeSession) {
	sub := strings.TrimPrefix(r.URL.Path, "/api/settings/report")
	switch sub {
	case "/template":
		s.handleReportTemplate(w, r, session)
		return
	case "/banner":
		s.handleReportBanner(w, r, session)
		return
	case "/starter-template":
		s.handleReportStarterTemplate(w, r)
		return
	case "/summary":
		s.handleReportSummary(w, r)
		return
	case "", "/":
	default:
		s.fail(w, 404, "接口不存在")
		return
	}
	switch r.Method {
	case "GET":
		s.writeJSON(w, 200, s.reportSettings())
	case "PUT":
		var in reportSettings
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in) != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		for _, v := range []string{in.Org, in.Project, in.Slogan, in.DocVersion, in.Author, in.Reviewer, in.Confidential, in.Header, in.Footer} {
			if len([]rune(v)) > 120 {
				s.fail(w, 400, "基础字段、标语、密级、页眉和页脚各不超过 120 字")
				return
			}
		}
		if len([]rune(in.Note)) > 1000 {
			s.fail(w, 400, "封面说明不超过 1000 字")
			return
		}
		cur := s.reportSettings()
		in.Theme = themeOf(in.Theme).ID
		if strings.TrimSpace(in.DocVersion) == "" {
			in.DocVersion = "V1.0"
		}
		in.Template = cur.Template
		in.Banner = cur.Banner
		in.UseTemplate = in.UseTemplate && cur.Template != ""
		if err := writeJSONFile(filepath.Join(s.cfg.DataDir, "settings", "report.json"), in); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "report-settings", session.User, in.Org)
		s.writeJSON(w, 200, in)
	default:
		s.fail(w, 405, "方法不支持")
	}
}

func (s *storeServer) handleReportSummary(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		s.fail(w, 405, "方法不支持")
		return
	}
	lang := wLang(w)
	rs := s.reportSettingsFor(lang)
	th := themeOf(rs.Theme)
	s.writeJSON(w, 200, map[string]any{
		"use_template": rs.UseTemplate,
		"template":     rs.Template,
		"theme":        th.ID,
		"theme_name":   th.Name,
		"org":          rs.Org,
		"doc_version":  firstNonEmptyStr(rs.DocVersion, "V1.0"),
		"has_banner":   rs.Banner != "",
	})
}

func (s *storeServer) handleReportStarterTemplate(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		s.fail(w, 405, "方法不支持")
		return
	}
	lang := wLang(w)
	b, err := starterTemplateDocxLang(s.reportSettingsFor(lang), lang)
	if err != nil {
		s.fail(w, 500, tr(lang, "生成标准模板失败：", "Failed to generate starter template: ")+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	w.Header().Set("Content-Disposition", "attachment; filename=standard-template.docx; filename*=UTF-8''"+url.PathEscape(tr(lang, "企业标准交付文档模板.docx", "Enterprise_Standard_Delivery_Template.docx")))
	_, _ = w.Write(b)
}

func (s *storeServer) handleReportBanner(w http.ResponseWriter, r *http.Request, session storeSession) {
	const maxBanner = 3 << 20
	switch r.Method {
	case "GET":
		b := s.reportBannerBytes()
		if len(b) == 0 {
			s.fail(w, 404, "还没有上传自定义封面横幅")
			return
		}
		_, format, err := image.DecodeConfig(bytes.NewReader(b))
		if err != nil {
			s.fail(w, 404, "横幅图片已损坏")
			return
		}
		ctype := "image/" + format
		if format == "jpg" || format == "jpeg" {
			ctype = "image/jpeg"
		}
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(b)
	case "POST":
		r.Body = http.MaxBytesReader(w, r.Body, maxBanner+(1<<20))
		file, header, err := r.FormFile("file")
		if err != nil {
			s.fail(w, 400, "请选择 PNG、JPG 或 GIF 横幅图片（3 MiB 以内）")
			return
		}
		defer file.Close()
		b, err := io.ReadAll(io.LimitReader(file, maxBanner+1))
		if err != nil || len(b) > maxBanner {
			s.fail(w, 400, "横幅图片不能超过 3 MiB")
			return
		}
		cfg, format, err := image.DecodeConfig(bytes.NewReader(b))
		if err != nil || (format != "png" && format != "jpeg" && format != "gif") {
			s.fail(w, 400, "仅支持 PNG、JPG 或 GIF 格式图片")
			return
		}
		if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > 8192 || cfg.Height > 8192 {
			s.fail(w, 400, "图片尺寸不合法")
			return
		}
		if err := os.MkdirAll(filepath.Dir(s.reportBannerPath()), 0o700); err != nil || os.WriteFile(s.reportBannerPath()+".tmp", b, 0o600) != nil || os.Rename(s.reportBannerPath()+".tmp", s.reportBannerPath()) != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		rs := s.reportSettings()
		rs.Banner = truncRunes(filepath.Base(header.Filename), 120)
		if err := writeJSONFile(filepath.Join(s.cfg.DataDir, "settings", "report.json"), rs); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "report-banner", session.User, rs.Banner)
		s.writeJSON(w, 200, rs)
	case "DELETE":
		_ = os.Remove(s.reportBannerPath())
		rs := s.reportSettings()
		rs.Banner = ""
		if err := writeJSONFile(filepath.Join(s.cfg.DataDir, "settings", "report.json"), rs); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "report-banner-delete", session.User, "")
		s.writeJSON(w, 200, rs)
	default:
		s.fail(w, 405, "方法不支持")
	}
}

// handleReportTemplate serves /api/settings/report/template: upload (and start using), download, remove.
func (s *storeServer) handleReportTemplate(w http.ResponseWriter, r *http.Request, session storeSession) {
	switch r.Method {
	case "GET":
		f, err := os.Open(s.reportTemplatePath())
		if err != nil {
			s.fail(w, 404, "还没有上传模板")
			return
		}
		defer f.Close()
		name := firstNonEmptyStr(s.reportSettings().Template, "report-template.docx")
		w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
		w.Header().Set("Content-Disposition", "attachment; filename=template.docx; filename*=UTF-8''"+url.PathEscape(name))
		_, _ = io.Copy(w, f)
	case "POST":
		r.Body = http.MaxBytesReader(w, r.Body, maxTemplate+(1<<20))
		file, header, err := r.FormFile("file")
		if err != nil {
			s.fail(w, 400, "请选择一个 .docx 文件（5 MiB 以内）")
			return
		}
		defer file.Close()
		b, err := io.ReadAll(io.LimitReader(file, maxTemplate+1))
		if err != nil {
			s.fail(w, 400, "文件读取失败，请重试")
			return
		}
		if _, err := parseTemplate(b); err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		if err := os.MkdirAll(filepath.Dir(s.reportTemplatePath()), 0o700); err != nil || os.WriteFile(s.reportTemplatePath()+".tmp", b, 0o600) != nil || os.Rename(s.reportTemplatePath()+".tmp", s.reportTemplatePath()) != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		rs := s.reportSettings()
		rs.Template, rs.UseTemplate = truncRunes(filepath.Base(header.Filename), 120), true
		if err := writeJSONFile(filepath.Join(s.cfg.DataDir, "settings", "report.json"), rs); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "report-template", session.User, rs.Template)
		s.writeJSON(w, 200, rs)
	case "DELETE":
		_ = os.Remove(s.reportTemplatePath())
		rs := s.reportSettings()
		rs.Template, rs.UseTemplate = "", false
		if err := writeJSONFile(filepath.Join(s.cfg.DataDir, "settings", "report.json"), rs); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		s.auditReq(r, "report-template-delete", session.User, "")
		s.writeJSON(w, 200, rs)
	default:
		s.fail(w, 405, "方法不支持")
	}
}

// ---- Word ----

func writeDocBody(w *docxWriter, d *clusterDoc, shift int, load func(job, name string) []byte) {
	writeDocBodyLang(w, d, shift, load, w.lang)
}

func writeDocBodyLang(w *docxWriter, d *clusterDoc, shift int, load func(job, name string) []byte, lang string) {
	for _, b := range d.Blocks {
		switch b.Kind {
		case "h":
			w.heading(b.Level+shift, b.Text)
		case "p":
			w.text(b.Text)
		case "note":
			w.note(b.Text)
		case "code":
			if b.Style == "terminal" {
				w.terminal(b.Text)
			} else {
				w.codeStyled(b.Text, b.Style)
			}
		case "old":
			w.struck(b.Title, b.Text, b.Items)
		case "list":
			for _, it := range b.Items {
				w.text("- " + it)
			}
		case "table":
			w.table(b.Head, b.Rows)
		case "image":
			for i, n := range b.Items {
				if load == nil || !w.picture(load(b.Job, n), tr(lang, fmt.Sprintf("截图 %d", i+1), fmt.Sprintf("Screenshot %d", i+1))) {
					w.note(tr(lang, fmt.Sprintf("（截图 %d 无法放进 Word，请在平台的执行记录里查看）", i+1), fmt.Sprintf("(Screenshot %d could not be embedded in Word; view it in platform execution logs.)", i+1)))
				}
			}
		case "section":
			w.heading(b.Level+shift, b.Title)
			if strings.TrimSpace(b.Text) == "" {
				w.note(tr(lang, "（未填写）", "(Not filled in) ") + b.Hint)
			} else {
				w.text(b.Text)
			}
		}
	}
}

func buildVersionHistory(f clusterFacts, rs reportSettings, user, docVersion, today string) [][4]string {
	var rows [][4]string
	start := 0
	if len(f.Jobs) > 6 {
		start = len(f.Jobs) - 6
	}
	for i := start; i < len(f.Jobs); i++ {
		j := f.Jobs[i]
		v := fmt.Sprintf("V1.%d", i)
		if len(f.Jobs) == 1 {
			v = docVersion
		}
		rows = append(rows, [4]string{
			v,
			day(j.Created),
			firstNonEmptyStr(j.Owner, rs.Author, user, "Kyndryl Delivery Studio"),
			tr(f.Lang, fmt.Sprintf("%s（%s）", jobTitleLang(j, f.Lang), jobOutcomeNameLang(j, f.Lang)), fmt.Sprintf("%s (%s)", jobTitleLang(j, f.Lang), jobOutcomeNameLang(j, f.Lang))),
		})
	}
	if len(rows) == 0 {
		rows = append(rows, [4]string{docVersion, today, firstNonEmptyStr(rs.Author, user, "Kyndryl Delivery Studio"), tr(f.Lang, "文档生成与基线归档", "Document generated and baselined")})
	}
	rows = append(rows, [4]string{"", "", "", ""})
	return rows
}

func (s *storeServer) docxOf(f clusterFacts, docs []*clusterDoc, user string, frontOpt ...bool) ([]byte, string, error) {
	lang := f.Lang
	withFront := true
	if len(frontOpt) > 0 {
		withFront = frontOpt[0]
	}
	rs := s.reportSettingsFor(lang)
	theme := themeOf(rs.Theme)
	appLabel := strings.TrimSpace(f.Current.AppName + " " + f.Current.Version)

	title := docs[0].Title
	sub := docs[0].Subtitle
	coverFacts := docs[0].Cover
	if len(docs) > 1 {
		title, sub, coverFacts = tr(lang, "交付文档", "Delivery Documentation"), firstNonEmptyStr(appLabel, f.ID), f.cover()
		var names []string
		for _, d := range docs {
			names = append(names, d.Title+(map[bool]string{true: tr(lang, "（"+d.Subtitle+"）", " ("+d.Subtitle+")"), false: ""}[d.Kind == "change" || d.Kind == "rca" || d.Kind == "assess"]))
		}
		coverFacts = append(coverFacts, [2]string{tr(lang, "包含文档", "Included Documents"), strings.Join(names, tr(lang, "、", ", "))})
	} else if sub == f.ID && appLabel != "" {
		sub = appLabel
	}

	// Render the body first so bw.headings collects normalized chapter numbers (第1章, 1.1, ...) for the TOC preview.
	bw := newDocxWriterLang(theme, "rIdMw", lang)
	for i, d := range docs {
		if len(docs) > 1 {
			if i > 0 {
				bw.pageBreak()
			}
			name := d.Title
			if d.Kind == "change" || d.Kind == "rca" || d.Kind == "assess" {
				name += tr(lang, "：", ": ") + d.Subtitle
			}
			bw.heading(1, name)
			writeDocBodyLang(bw, d, 1, s.progressImage, lang)
		} else {
			writeDocBodyLang(bw, d, 0, s.progressImage, lang)
		}
	}

	today := time.Now().Format("2006-01-02")
	docVersion := firstNonEmptyStr(rs.DocVersion, "V1.0")
	project := firstNonEmptyStr(rs.fill(rs.Project, f.ID, title, appLabel), appLabel, f.ID)
	author := firstNonEmptyStr(rs.Author, user, "Kyndryl Delivery Studio")
	reviewer := firstNonEmptyStr(rs.Reviewer, "—")
	note := rs.fill(rs.Note, f.ID, title, appLabel)
	headerTxt := rs.fill(rs.Header, f.ID, title, appLabel)
	footerTxt := rs.fill(rs.Footer, f.ID, title, appLabel)

	// Only an organization-uploaded banner is placed on the cover; no built-in decorative artwork.
	customBanner := s.reportBannerBytes()

	coverCfg := docxCover{
		Org:          rs.Org,
		Project:      project,
		Slogan:       rs.Slogan,
		Title:        title,
		Subtitle:     sub,
		DocVersion:   docVersion,
		Date:         today,
		Confidential: rs.Confidential,
		Note:         note,
		Cluster:      f.ID,
		Facts:        coverFacts,
		BannerData:   customBanner,
		CustomBanner: len(customBanner) > 0,
		Lang:         lang,
	}
	vcCfg := docxVersionControl{
		Project:      project,
		Title:        title,
		Version:      docVersion,
		Date:         today,
		Author:       author,
		Reviewer:     reviewer,
		Cluster:      f.ID,
		Confidential: rs.Confidential,
		Facts:        coverFacts,
		History:      buildVersionHistory(f, rs, user, docVersion, today),
		Lang:         lang,
	}

	var body []byte
	var err error
	if tpl := s.reportTemplate(); tpl != nil && rs.UseTemplate {
		cw := newDocxWriterLang(theme, "rIdFc", lang)
		tw := newDocxWriterLang(theme, "rIdFt", lang)
		if withFront {
			cw.cover(coverCfg)
			tw.toc(bw.headings)
			cw.versionControl(vcCfg)
			cw.pageBreak()
		} else {
			tw.toc(bw.headings)
		}
		vals := map[string]string{
			"title":        title,
			"subtitle":     sub,
			"cluster":      f.ID,
			"org":          rs.Org,
			"date":         today,
			"confidential": rs.Confidential,
			"version":      docVersion,
			"project":      project,
			"author":       author,
			"reviewer":     reviewer,
			"slogan":       rs.Slogan,
			"app":          appLabel,
		}
		body, err = tpl.render(cw.b.String(), tw.b.String(), bw.b.String(), cw.media, tw.media, bw.media, vals, title, author, theme)
	} else if withFront {
		front := newDocxWriterLang(theme, "rIdF", lang)
		front.cover(coverCfg)
		front.toc(bw.headings)
		front.versionControl(vcCfg)
		body, err = docxFileDual(front, bw, docxBuildMeta{
			Title:        title,
			Header:       headerTxt,
			Footer:       footerTxt,
			FrontOrg:     firstNonEmptyStr(rs.Org, project, f.ID),
			Author:       author,
			Theme:        theme,
			HasFrontSect: true,
			Lang:         lang,
		})
	} else {
		body, err = docxFile(bw, title, headerTxt, footerTxt, author)
	}
	name := f.ID + "-" + title
	if len(docs) == 1 && (docs[0].Kind == "change" || docs[0].Kind == "rca" || docs[0].Kind == "assess") {
		name += "-" + strings.ReplaceAll(docs[0].Subtitle, " ", "")
	}
	return body, name + "-" + time.Now().Format("20060102") + ".docx", err
}

// ---- API ----

// handleCluster serves /api/clusters/{id}/docs…, /export.
func (s *storeServer) handleCluster(w http.ResponseWriter, r *http.Request, session storeSession) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/clusters/"), "/"), "/")
	if len(parts) < 2 || !docClusterID.MatchString(parts[0]) {
		s.fail(w, 404, "接口不存在")
		return
	}
	f, ok := s.clusterFactsFor(session.User, parts[0])
	if !ok {
		s.fail(w, 404, "找不到这个集群，或它还没有生成成功的交付")
		return
	}
	f.Lang = wLang(w)
	switch {
	case len(parts) == 2 && parts[1] == "docs" && r.Method == "GET":
		out := []clusterDoc{}
		for _, id := range docIDs(f, s.docIndex(f.ID), s.finalizedRehearsalDocIDs(f.ID)) {
			if d, ok := s.buildDoc(f, id); ok {
				d.Blocks, d.Cover = nil, nil
				out = append(out, *d)
			}
		}
		s.writeJSON(w, 200, out)
	case len(parts) >= 2 && parts[1] == "rehearsals":
		s.handleRehearsals(w, r, session, f, parts[2:])
	case len(parts) >= 2 && parts[1] == "security":
		s.handleClusterSecurity(w, r, session, f, parts[2:])
	case len(parts) == 2 && parts[1] == "baseline":
		s.handleClusterBaseline(w, r, session, f)
	case len(parts) == 2 && parts[1] == "docs" && r.Method == "POST":
		s.startRCA(w, r, session, f)
	case len(parts) == 3 && parts[1] == "docs" && (strings.HasPrefix(parts[2], "rca-") || strings.HasPrefix(parts[2], "assess-") || strings.HasPrefix(parts[2], "chg-")) && r.Method == "DELETE":
		s.dropRCA(w, r, session, f, parts[2])
	case len(parts) == 2 && parts[1] == "export" && r.Method == "GET":
		s.exportDocs(w, r, session, f)
	case len(parts) >= 3 && parts[1] == "docs" && docIDRe.MatchString(parts[2]):
		d, ok := s.buildDoc(f, parts[2])
		if !ok {
			s.fail(w, 404, "这份文档不存在")
			return
		}
		switch {
		case len(parts) == 3 && r.Method == "GET":
			s.writeJSON(w, 200, d)
		case len(parts) == 5 && parts[3] == "sections" && r.Method == "PUT":
			s.saveSection(w, r, session, f, d, parts[4])
		case len(parts) == 6 && parts[3] == "sections" && parts[5] == "draft" && r.Method == "POST":
			s.draftSection(w, r, session, f, d, parts[4])
		case len(parts) == 4 && parts[3] == "draft-all" && r.Method == "POST":
			s.draftAllSections(w, r, session, f, d)
		case len(parts) == 4 && parts[3] == "check" && r.Method == "POST":
			s.checkDoc(w, r, session, f, d)
		default:
			s.fail(w, 404, "接口不存在")
		}
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func docSectionOf(d *clusterDoc, key string) *docBlock {
	for i := range d.Blocks {
		if d.Blocks[i].Kind == "section" && d.Blocks[i].Key == key {
			return &d.Blocks[i]
		}
	}
	return nil
}

// saveSection stores what a person wrote, or confirms a draft. Text that is not changed keeps its source, so
// confirming a draft as it is still shows it came from the assistant.
func (s *storeServer) saveSection(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, d *clusterDoc, key string) {
	sec := docSectionOf(d, key)
	if sec == nil {
		s.fail(w, 404, "这份文档没有这一节")
		return
	}
	var in struct {
		Text      string `json:"text"`
		Confirmed bool   `json:"confirmed"`
		Source    string `json:"source"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&in) != nil || len([]rune(in.Text)) > 20000 {
		s.fail(w, 400, "每一节最多 20000 字")
		return
	}
	saved := s.docLoad(f.ID, d.ID)
	old := saved.Sections[key]
	src := "user"
	if in.Source == "ai" {
		src = "ai"
	} else if strings.TrimSpace(in.Text) == strings.TrimSpace(old.Text) && old.Source != "" {
		src = old.Source
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if strings.TrimSpace(in.Text) == "" {
		delete(saved.Sections, key)
	} else {
		saved.Sections[key] = docSection{Text: in.Text, Source: src, Confirmed: in.Confirmed || src == "user", By: session.User, At: now, Basis: f.Current.ID}
	}
	if err := s.docSave(f.ID, d.ID, saved); err != nil {
		s.fail(w, 500, "保存失败，请稍后重试")
		return
	}
	s.auditReq(r, "doc-section", session.User, f.ID+" "+d.ID+" "+key)
	nd, _ := s.buildDoc(f, d.ID)
	s.writeJSON(w, 200, nd)
}

func (s *storeServer) exportDocs(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts) {
	want := strings.Split(r.URL.Query().Get("docs"), ",")
	opt := parseExportOptions(r.URL.Query())
	var docs []*clusterDoc
	for _, id := range want {
		if !docIDRe.MatchString(id) {
			continue
		}
		if d, ok := s.buildDoc(f, id); ok {
			docs = append(docs, opt.filtered(d))
		}
	}
	if len(docs) == 0 {
		s.fail(w, 400, "请选择要导出的文档")
		return
	}
	merge := r.URL.Query().Get("merge") == "1"
	withFront := r.URL.Query().Get("front") != "0"
	var data []byte
	var name, ctype string
	if merge || len(docs) == 1 {
		b, n, err := s.docxOf(f, docs, session.User, withFront)
		if err != nil {
			s.fail(w, 500, "生成 Word 失败："+err.Error())
			return
		}
		data, name, ctype = b, n, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	} else {
		var buf bytes.Buffer
		z := zip.NewWriter(&buf)
		for _, d := range docs {
			b, n, err := s.docxOf(f, []*clusterDoc{d}, session.User, withFront)
			if err != nil {
				s.fail(w, 500, "生成 Word 失败："+err.Error())
				return
			}
			zf, err := z.Create(n)
			if err == nil {
				_, err = zf.Write(b)
			}
			if err != nil {
				s.fail(w, 500, "打包失败")
				return
			}
		}
		if err := z.Close(); err != nil {
			s.fail(w, 500, "打包失败")
			return
		}
		data, name, ctype = buf.Bytes(), f.ID+tr(f.Lang, "-文档-", "-docs-")+time.Now().Format("20060102")+".zip", "application/zip"
	}
	var ids []string
	for _, d := range docs {
		ids = append(ids, d.ID)
	}
	s.auditReq(r, "doc-export", session.User, f.ID+" "+strings.Join(ids, ",")+map[bool]string{true: " 合并", false: ""}[merge]+fmt.Sprintf(" 自动化=%t 命令=%t 结果=%t 终端日志=%t 自动化日志=%t", opt.Auto, opt.Cmd, opt.Result, opt.LogCmd, opt.LogAuto))
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Disposition", "attachment; filename=cluster-docs; filename*=UTF-8''"+url.PathEscape(name))
	_, _ = w.Write(data)
}

// startRCA begins a root-cause analysis by hand: of one of the cluster's plans, or (no job) of an incident.
func (s *storeServer) startRCA(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts) {
	var in struct {
		Kind     string `json:"kind"` // "" (root-cause analysis) or assess
		Job      string `json:"job"`
		Title    string `json:"title"`
		Type     string `json:"type"`
		Question string `json:"question"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in) != nil || len([]rune(in.Title)) > 80 {
		s.fail(w, 400, "事件名称最多 80 字")
		return
	}
	idx := s.docIndex(f.ID)
	if in.Kind == "assess" {
		q := strings.TrimSpace(in.Question)
		if assessTypes[in.Type] == "" || q == "" || len([]rune(q)) > 1000 {
			s.fail(w, 400, "请选择评估类型，并写下要回答的问题（1000 字以内）")
			return
		}
		e := assessEntry{ID: "assess-" + randomStoreToken(6), Type: in.Type, Question: q, Created: time.Now().UTC().Format(time.RFC3339Nano), By: session.User}
		idx.Assess = append(idx.Assess, e)
		if err := writeJSONFile(filepath.Join(s.cfg.DataDir, "docs", f.ID, "index.json"), idx); err != nil {
			s.fail(w, 500, "保存失败，请稍后重试")
			return
		}
		// the question is the first section, written by the person who asked
		saved := docSaved{Sections: map[string]docSection{"goal": {Text: q, Source: "user", Confirmed: true, By: session.User, At: e.Created, Basis: f.Current.ID}}}
		_ = s.docSave(f.ID, e.ID, saved)
		s.auditReq(r, "doc-assess", session.User, f.ID+" "+e.ID)
		s.writeJSON(w, 201, map[string]string{"id": e.ID})
		return
	}
	e := rcaEntry{Created: time.Now().UTC().Format(time.RFC3339Nano), By: session.User, Title: strings.TrimSpace(in.Title)}
	if in.Job != "" {
		j, ok := f.job(in.Job)
		if !ok {
			s.fail(w, 404, "找不到这份交付")
			return
		}
		e.ID, e.Job = "rca-"+j.ID, j.ID
		if _, ok := idx.rca(e.ID); ok || j.Outcome == outcomeFailed || j.RunFailed > 0 {
			s.writeJSON(w, 200, map[string]string{"id": e.ID})
			return
		}
	} else {
		if e.Title == "" {
			s.fail(w, 400, "请给这次故障起个名字，例如：10 月 27 日主库切换后写入中断")
			return
		}
		e.ID = "rca-x" + randomStoreToken(6)
	}
	idx.RCA = append(idx.RCA, e)
	if err := writeJSONFile(filepath.Join(s.cfg.DataDir, "docs", f.ID, "index.json"), idx); err != nil {
		s.fail(w, 500, "保存失败，请稍后重试")
		return
	}
	s.auditReq(r, "doc-rca", session.User, f.ID+" "+e.ID)
	s.writeJSON(w, 201, map[string]string{"id": e.ID})
}

// dropRCA removes a root-cause analysis someone started by hand, with what was written in it.
func (s *storeServer) dropRCA(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, id string) {
	docIdxMu.Lock()
	defer docIdxMu.Unlock()
	idx := s.docIndex(f.ID)
	keep := idx.RCA[:0]
	found := false
	for _, e := range idx.RCA {
		if e.ID == id {
			found = true
			continue
		}
		keep = append(keep, e)
	}
	ka := idx.Assess[:0]
	for _, e := range idx.Assess {
		if e.ID == id {
			found = true
			continue
		}
		ka = append(ka, e)
	}
	idx.Assess = ka
	kc := idx.Changes[:0]
	for _, e := range idx.Changes {
		if e.ID == id {
			found = true
			continue
		}
		kc = append(kc, e)
	}
	idx.Changes = kc
	if !found {
		s.fail(w, 409, "只有手动归档的变更报告、评估或根因分析可以删除；交付执行失败自动产生的会一直保留")
		return
	}
	idx.RCA = keep
	if err := writeJSONFile(filepath.Join(s.cfg.DataDir, "docs", f.ID, "index.json"), idx); err != nil {
		s.fail(w, 500, "删除失败，请稍后重试")
		return
	}
	_ = os.Remove(s.docPath(f.ID, id))
	s.auditReq(r, "doc-rca-delete", session.User, f.ID+" "+id)
	s.writeJSON(w, 200, map[string]bool{"ok": true})
}

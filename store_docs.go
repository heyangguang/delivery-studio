package main

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
	"time"

	"middleware-deployer/mwpack"
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
	// commands on each machine) or result (what was recorded on site). Empty blocks are always shown.
	Variant string `json:"variant,omitempty"`
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
// incident that has nothing to do with a plan.
type docIndex struct {
	RCA    []rcaEntry    `json:"rca"`
	Assess []assessEntry `json:"assess,omitempty"`
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
	docIDRe      = regexp.MustCompile(`^(delivery|kt|sop-[0-9a-f]{12}|rca-[0-9a-f]{32}|rca-x[0-9a-f]{12}|assess-[0-9a-f]{12})$`)
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

func jobTitle(j storeJob) string {
	if j.DeliveryMode == "configuration" {
		return "配置交付"
	}
	return "首次部署"
}

func jobOutcomeName(j storeJob) string {
	if j.DeliveryMode == "configuration" && j.Outcome != outcomeVoid {
		return "仅生成配置，未执行现场部署"
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

// topology writes the machines and instances of a solved plan.
func topology(b *docBuilder, p *mwpack.Plan) {
	if p == nil {
		b.note("这份交付的部署规格读不出来，拓扑无法列出。")
		return
	}
	carry := map[string][]string{}
	for _, inst := range p.Instances {
		if inst.External {
			continue
		}
		for _, r := range inst.R.Roles {
			for _, h := range inst.Roles[r.Name] {
				carry[h] = append(carry[h], inst.ID+" "+roleTitle(inst, r.Name))
			}
		}
	}
	var rows [][]string
	for _, h := range p.Hosts {
		name := h.Name
		if h.Name == p.Controller {
			name += "（控制节点）"
		}
		rows = append(rows, []string{name, h.IP, strings.Join(carry[h.Name], "、")})
	}
	b.table([]string{"机器", "IP", "承担"}, rows)
	if e := p.Dep.ExecutionHost; e != nil {
		b.p("独立执行机：" + e.Name + "（" + e.IP + "），不计入业务机器；运行目录 " + p.RuntimeRoot() + "。")
	}
	rows = nil
	for _, inst := range p.Instances {
		place := "客户自行运维"
		if !inst.External {
			var parts []string
			for _, r := range inst.R.Roles {
				if hs := inst.Roles[r.Name]; len(hs) > 0 {
					parts = append(parts, roleTitle(inst, r.Name)+"："+strings.Join(hs, "、"))
				}
			}
			place = strings.Join(parts, "；")
		}
		note := ""
		if inst.Auto {
			note = "平台自动加入：" + inst.AutoReason
		}
		rows = append(rows, []string{inst.ID, inst.Title + " " + inst.Version, place, note})
	}
	b.table([]string{"实例", "组件与版本", "放置", "说明"}, rows)
}

// entries lists the addresses applications use, and how a balancer picks the backend that takes the connection.
func entries(b *docBuilder, p *mwpack.Plan) {
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
			addr := strings.Join(be, "、")
			via := "直连"
			if f, ok := inst.Fronts[e.Name]; ok {
				addr = fmt.Sprintf("%s:%d", f.Address, f.Listen)
				via = "经 " + f.Balancer + "，" + mwpack.EndpointHealth(e)
			} else if len(e.Backends) > 1 {
				several = true
				via = "没有负载均衡；" + mwpack.EndpointHealth(e)
			}
			rows = append(rows, []string{inst.ID + "." + e.Name, firstNonEmptyStr(e.Title, e.Name), addr, via})
		}
	}
	b.table([]string{"入口", "用途", "地址", "如何选到可用节点"}, rows)
	if several {
		b.note("没有负载均衡的入口列出的是所有可能承担这个角色的节点，同一时间只有通过检查的那台（例如当前主库）能用。应用要么经负载均衡访问，要么使用支持多主机的连接串（PostgreSQL 例如 host=节点1,节点2,节点3 target_session_attrs=read-write），主库切换后才能自动找到新的主库。")
	}
}

func paramsTable(b *docBuilder, p *mwpack.Plan) {
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
		b.p("所有参数使用组件默认值。")
		return
	}
	b.table([]string{"实例", "参数", "取值"}, rows)
}

func (s *storeServer) packagesTable(b *docBuilder, id string) {
	pk := s.lockPackages(id)
	names := make([]string, 0, len(pk))
	for n := range pk {
		names = append(names, n)
	}
	sort.Strings(names)
	var rows [][]string
	for _, n := range names {
		rows = append(rows, []string{n, strings.Join(pk[n], "、")})
	}
	if len(rows) == 0 {
		b.p("没有软件包清单。")
		return
	}
	b.table([]string{"软件包", "版本"}, rows)
}

// record writes a job's execution record, what was changed during it and the problems solved with the assistant.
func (s *storeServer) record(b *docBuilder, level int, j storeJob) {
	if scheme := s.deliveryScheme(j.ID, j.AppID, j.Scheme); scheme != nil {
		b.note("本次交付部署方案：" + scheme.Name + "；" + scheme.Topology + "；" + scheme.Contract.Mechanism)
	}
	steps, prog := s.execRecord(j.ID)
	s.executionSummary(b, level, j, prog)
	facts := []string{"交付负责人登记的结论：" + jobOutcomeName(j)}
	if j.MarkedBy != "" {
		facts = append(facts, fmt.Sprintf("确认：%s，%s", j.MarkedBy, stamp(j.Marked)))
	}
	if j.RunTotal > 0 {
		facts = append(facts, fmt.Sprintf("现场记录：%d / %d 步，%d 步失败", j.RunDone, j.RunTotal, j.RunFailed))
	}
	b.p(strings.Join(facts, "；"))
	if j.OutcomeNote != "" {
		b.note("现场说明：" + j.OutcomeNote)
	}
	if !s.stepReport(b, level, j) {
		var rows [][]string
		for _, st := range steps {
			rows = append(rows, []string{st.Title, stepStates[st.State], st.By, stamp(st.At), st.Note})
		}
		if len(rows) == 0 {
			b.p("现场没有在平台上逐步记录。")
		} else {
			b.table([]string{"步骤", "结果", "执行人", "时间", "说明"}, rows)
		}
	}
	if ams := s.loadAmendments(j.ID); len(ams) > 0 {
		b.h(level, "执行中对手册的修改")
		var items []string
		for _, a := range ams {
			what := "新增步骤「" + a.Step.Title + "」"
			if a.Kind == "replace" {
				what = "修改步骤「" + firstNonEmptyStr(a.AfterTitle, a.Step.Title) + "」的命令"
			}
			items = append(items, fmt.Sprintf("%s（%s，%s）：%s", what, a.By, stamp(a.At), a.Reason))
		}
		b.list(items)
	}
	// problems met on a step are written under that step; the rest (about the delivery as a whole) are here
	var loose []aiReport
	inline := map[string]bool{}
	for _, t := range s.runbookSteps(j.ID) {
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
		b.h(level, "现场解决的问题")
		for _, r := range loose {
			writeUpBlocks(b, "", r)
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
	out := [][2]string{{"集群", f.ID}, {"应用", f.Current.AppName + " " + f.Current.Version}}
	if f.Plan != nil {
		out = append(out, [2]string{"规模", fmt.Sprintf("%d 台机器，控制节点 %s", len(f.Plan.Hosts), f.Plan.Controller)})
	}
	return append(out, extra...)
}

// ---- the documents ----

func (s *storeServer) buildDelivery(f clusterFacts) *clusterDoc {
	first := f.first()
	d := &clusterDoc{ID: "delivery", Kind: "delivery", Title: "交付报告", Subtitle: f.ID, Cluster: f.ID,
		Cover: f.cover([2]string{"首次部署", day(first.Created)}, [2]string{"负责人", first.Owner})}
	b := &docBuilder{}
	b.section(1, "summary", "1 概述", "这个集群是什么、为谁服务、怎么部署的、现在是什么状态。", true)
	b.h(1, "2 架构与拓扑")
	b.p(fmt.Sprintf("以下按平台保存的「%s」配置展示。现场完成情况以执行结果和交付负责人确认记录为准。", jobTitle(f.Current)))
	topology(b, f.Plan)
	b.h(2, "2.1 访问入口")
	if f.Plan != nil {
		n := len(b.blocks)
		entries(b, f.Plan)
		if len(b.blocks) == n {
			b.p("没有声明对外入口。")
		}
	}
	b.h(1, "3 规格与版本")
	b.h(2, "3.1 定制参数")
	paramsTable(b, f.Plan)
	b.h(2, "3.2 软件包")
	s.packagesTable(b, f.Current.ID)
	if first.DeliveryMode == "configuration" {
		b.h(1, "4 配置交付记录")
	} else {
		b.h(1, "4 首次部署记录")
	}
	b.p(fmt.Sprintf("%s 由 %s 生成交付材料。", stamp(first.Created), first.Owner))
	s.record(b, 2, first)
	b.h(1, "5 当前状态")
	var devs []string
	for _, j := range f.Jobs {
		if j.Outcome == outcomeDeviated && j.OutcomeNote != "" {
			devs = append(devs, jobTitle(j)+"："+j.OutcomeNote)
		}
	}
	b.p(fmt.Sprintf("集群当前以「%s」为准：%s。", jobTitle(f.Current), jobOutcomeName(f.Current)))
	if len(devs) > 0 {
		b.p("实际执行与原交付的出入（已计入当前状态）：")
		b.list(devs)
	}
	if sops := s.listFinalizedRehearsals(f.ID); len(sops) > 0 {
		b.h(2, "5.1 已归档的生产变更实施方案")
		var rows [][]string
		for _, rh := range sops {
			rows = append(rows, []string{rh.Title, rh.Owner, stamp(rh.UpdatedAt), "sop-" + rh.ID})
		}
		b.table([]string{"变更方案", "负责人", "定稿时间", "文档编号"}, rows)
	}
	b.section(1, "risks", "6 风险与遗留问题", "仍然存在的风险、没有解决的问题和建议，例如执行中的偏差、单点、后续容量与监控关注项。", true)
	b.section(1, "acceptance", "7 验收结论", "根据执行记录和测试结果给出结论；有失败或没执行的步骤要如实写明。", true)
	d.Blocks = b.blocks
	return d
}

func (s *storeServer) buildKT(f clusterFacts) *clusterDoc {
	d := &clusterDoc{ID: "kt", Kind: "kt", Title: "运维交接文档", Subtitle: f.ID, Cluster: f.ID,
		Cover: f.cover([2]string{"依据", jobTitle(f.Current) + "的配置与执行记录"})}
	b := &docBuilder{}
	b.h(1, "1 架构")
	topology(b, f.Plan)
	b.section(2, "arch", "1.1 架构说明", "面向运维人员：各节点做什么，数据怎么复制，高可用怎么工作，坏了一台会发生什么。", true)
	b.h(1, "2 访问与位置")
	if f.Plan != nil {
		entries(b, f.Plan)
		var rows [][]string
		for _, inst := range f.Plan.Instances {
			for _, pu := range inst.Ports {
				rows = append(rows, []string{inst.ID, pu.Name, fmt.Sprintf("%d/%s", pu.Port, pu.Proto), strings.Join(pu.Hosts, "、")})
			}
		}
		b.h(2, "2.1 端口")
		b.table([]string{"实例", "用途", "端口", "机器"}, rows)
		b.h(2, "2.2 平台生成的文件")
		b.list([]string{
			"Ansible 项目在执行机 " + f.Plan.Controller + " 的 " + f.Plan.RuntimeRoot() + "/projects/" + f.Plan.ProjectName() + " 下。",
			"密码保存在该项目的 secrets/ 目录（只有 root 可读），不在本文档里；交接时当面确认谁有权查看。",
		})
	}
	ops := 0
	if f.Plan != nil {
		for _, inst := range f.Plan.Instances {
			if inst.External {
				continue
			}
			o := inst.InstanceOperations(f.ID)
			if o == nil {
				continue
			}
			ops++
			b.h(1, fmt.Sprintf("%d %s（%s %s）", 2+ops, inst.ID, inst.Title, inst.Version))
			b.p(o.Overview)
			if len(o.Checks) > 0 {
				b.h(2, "日常巡检")
				for _, c := range o.Checks {
					b.h(3, c.Title)
					if c.Hosts != "" {
						b.p("在" + c.Hosts + "上执行：")
					}
					b.code(c.Cmd)
					if c.Expect != "" {
						b.p("正常：" + c.Expect)
					}
				}
			}
			if len(o.Tasks) > 0 {
				b.h(2, "常见操作")
				for _, t := range o.Tasks {
					b.h(3, t.Title)
					b.code(t.Cmd)
					if t.Note != "" {
						b.note(t.Note)
					}
				}
			}
			if len(o.Faults) > 0 {
				b.h(2, "典型问题与排查")
				for _, x := range o.Faults {
					b.h(3, x.Title)
					if x.Symptom != "" {
						b.p("现象：" + x.Symptom)
					}
					b.list(x.Steps)
					b.code(x.Cmd)
				}
			}
			if len(o.Logs) > 0 {
				b.h(2, "日志与文件")
				var rows [][]string
				for _, l := range o.Logs {
					rows = append(rows, []string{l.Name, l.Text})
				}
				b.table([]string{"内容", "位置"}, rows)
			}
		}
	}
	if ops == 0 {
		b.note("组件没有提供运维知识。可以在组件工作台为组件补上 operations，或让 AI 在下一节起草。")
	}
	n := 3 + ops
	b.section(1, "specific", fmt.Sprintf("%d 这个集群的注意事项", n), "结合实际拓扑、版本、经历过的变更和执行偏差，补充上面的通用内容没有覆盖、只适用于这个集群的注意点。", true)
	b.h(1, fmt.Sprintf("%d 变更须知", n+1))
	b.list([]string{
		"生产集群后续的升级、扩容、缩容与关键参数变更，应先核实现场真实主从角色与配置现状，严禁直接盲跑首次部署剧本覆盖运行中的集群。",
		"启用平台 AI 后，可在该集群的「变更演练」工作台生成 100% 只读采集探针，并在测试环境逐步验证命令与回退预案，定稿输出《生产变更实施方案》。",
		"首次部署执行中若实际做法与手册不同，确认结果时选择「有偏差」并写明差异。",
	})
	var devs []string
	for _, j := range f.Jobs {
		if j.Outcome == outcomeDeviated && j.OutcomeNote != "" {
			devs = append(devs, jobTitle(j)+"："+j.OutcomeNote)
		}
	}
	if len(devs) > 0 {
		b.p("已知的执行偏差：")
		b.list(devs)
	}
	b.section(1, "contacts", fmt.Sprintf("%d 联系人与升级路径", n+2), "运维联系人、值班电话、遇到问题时逐级找谁。", false)
	d.Blocks = b.blocks
	return d
}

func (s *storeServer) buildRCA(f clusterFacts, j storeJob) *clusterDoc {
	d := &clusterDoc{ID: "rca-" + j.ID, Kind: "rca", Title: "根因分析报告", Subtitle: jobTitle(j), Cluster: f.ID, Job: j.ID,
		Cover: f.cover([2]string{"交付", jobTitle(j)}, [2]string{"结果", jobOutcomeName(j)})}
	b := &docBuilder{}
	steps, prog := s.execRecord(j.ID)
	n := 0
	num := func(t string) string { n++; return fmt.Sprintf("%d %s", n, t) }
	b.section(1, "symptom", num("现象"), "出了什么问题，在哪一步、什么时间被发现。", true)
	b.section(1, "impact", num("影响范围"), "影响了哪些机器、服务和业务，持续多久。", true)
	b.h(1, num("时间线"))
	var rows [][]string
	for _, e := range prog.Events {
		st := stepStates[e.State]
		if e.State == "" {
			st = "清除记录"
		}
		rows = append(rows, []string{stamp(e.At), e.By, e.Title, st})
	}
	if j.Marked != "" {
		rows = append(rows, []string{stamp(j.Marked), j.MarkedBy, "确认结果", jobOutcomeName(j)})
	}
	if len(rows) == 0 {
		b.p("现场没有在平台上记录。")
	}
	b.table([]string{"时间", "人", "步骤", "记录"}, rows)
	b.h(1, num("失败的步骤"))
	failed := 0
	for _, st := range steps {
		if st.State != "failed" {
			continue
		}
		failed++
		b.h(2, st.Title)
		b.p(fmt.Sprintf("%s 由 %s 记为失败。%s", stamp(st.At), st.By, st.Note))
		log := st.Log
		if len(log) > 4000 {
			log = "……\n" + log[len(log)-4000:]
		}
		b.code(log)
	}
	if failed == 0 {
		b.p("执行记录里没有标为失败的步骤。")
	}
	if j.OutcomeNote != "" {
		b.note("现场说明：" + j.OutcomeNote)
	}
	if len(prog.Reports) > 0 || len(s.loadAmendments(j.ID)) > 0 {
		b.h(1, num("现场的排查"))
		for _, r := range prog.Reports {
			b.p("**" + firstNonEmptyStr(r.Title, r.Symptom) + "**")
			b.list(nonEmpty("现象："+r.Symptom, "证据："+r.Evidence, "原因："+r.Cause, "处理："+r.Fix))
		}
		var items []string
		for _, a := range s.loadAmendments(j.ID) {
			items = append(items, fmt.Sprintf("「%s」：%s", a.Step.Title, a.Reason))
		}
		if len(items) > 0 {
			b.p("执行中采纳的手册修改：")
			b.list(items)
		}
	}
	b.section(1, "cause", num("根因分析"), "直接原因和根本原因，说明依据；判断不了的写明还需要什么信息。", true)
	b.section(1, "handling", num("处理过程"), "做了什么、恢复到了什么状态。", true)
	b.section(1, "improve", num("改进建议"), "避免再次发生要改什么：组件、手册、流程、监控。", true)
	d.Blocks = b.blocks
	return d
}

// buildIncident is a root-cause analysis of something that happened to the running cluster outside any plan: the
// platform knows the cluster and its history, the people on site know what happened.
func (s *storeServer) buildIncident(f clusterFacts, e rcaEntry) *clusterDoc {
	d := &clusterDoc{ID: e.ID, Kind: "rca", Title: "根因分析报告", Subtitle: firstNonEmptyStr(e.Title, "集群故障"), Cluster: f.ID,
		Cover: f.cover([2]string{"事件", firstNonEmptyStr(e.Title, "集群故障")}, [2]string{"发起", stamp(e.Created) + "，" + e.By})}
	b := &docBuilder{}
	n := 0
	num := func(t string) string { n++; return fmt.Sprintf("%d %s", n, t) }
	b.section(1, "symptom", num("现象"), "出了什么问题，什么时间、怎么发现的，报错或告警是什么。", true)
	b.section(1, "impact", num("影响范围"), "影响了哪些机器、服务和业务，持续多久。", true)
	b.section(1, "timeline", num("时间线"), "按时间写清楚发生了什么、谁做了什么。", true)
	b.h(1, num("出事时的集群"))
	b.p(fmt.Sprintf("平台记录的集群以「%s」为准（%s）。", jobTitle(f.Current), jobOutcomeName(f.Current)))
	topology(b, f.Plan)
	var rows [][]string
	for _, j := range f.Jobs {
		rows = append(rows, []string{jobTitle(j), stamp(j.Created), jobOutcomeName(j), j.OutcomeNote})
	}
	b.h(2, "经历过的交付")
	b.table([]string{"交付", "生成", "结果", "说明"}, rows)
	b.section(1, "cause", num("根因分析"), "直接原因和根本原因，说明依据；判断不了的写明还需要什么信息。", true)
	b.section(1, "handling", num("处理过程"), "做了什么、恢复到了什么状态。", true)
	b.section(1, "improve", num("改进建议"), "避免再次发生要改什么：组件、手册、流程、监控；需要后续变更集群的，写明建议通过变更演练或调整哪些参数。", true)
	d.Blocks = b.blocks
	return d
}

var assessTypes = map[string]string{"capacity": "容量评估", "selection": "选型建议"}

// buildAssess is an assessment in the cluster's case file: the question, the cluster as it is, what people told the
// assistant, the analysis and the conclusion — which ends in the plan to make, if any.
func (s *storeServer) buildAssess(f clusterFacts, e assessEntry) *clusterDoc {
	title := assessTypes[e.Type]
	d := &clusterDoc{ID: e.ID, Kind: "assess", Title: title, Subtitle: truncRunes(e.Question, 40), Cluster: f.ID,
		Cover: f.cover([2]string{"类型", title}, [2]string{"提出", stamp(e.Created) + "，" + e.By})}
	b := &docBuilder{}
	b.section(1, "goal", "1 要回答的问题", "要评估什么，为什么现在要评估。", false)
	b.h(1, "2 集群现状")
	b.p(fmt.Sprintf("平台记录的集群以「%s」为准（%s）。", jobTitle(f.Current), jobOutcomeName(f.Current)))
	topology(b, f.Plan)
	b.h(2, "2.1 定制参数")
	paramsTable(b, f.Plan)
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
						adv = fmt.Sprintf("超过 %d 台时注意：%s", r.Advise, r.AdviseWhy)
					}
					rows = append(rows, []string{inst.ID, roleTitle(inst, r.Name), fmt.Sprint(len(hs)), adv})
				}
			}
		}
		b.h(2, "2.2 角色与规模")
		b.table([]string{"实例", "角色", "台数", "组件的建议"}, rows)
	}
	if e.Type == "selection" {
		var rows [][]string
		for _, n := range s.plat.cat().Names() {
			c, ok := s.plat.cat().Get(n)
			if !ok {
				continue
			}
			rows = append(rows, []string{c.Title, c.Category, truncRunes(c.Summary, 120)})
		}
		b.h(2, "2.3 平台上可用的组件")
		b.table([]string{"组件", "类别", "说明"}, rows)
	}
	b.section(1, "inputs", "3 输入与假设", "业务量、数据量、增长速度、机器配置等评估依据；平台不知道的由现场提供，没有的写成假设。", true)
	b.section(1, "analysis", "4 分析", "依据上面的现状和输入，说明计算过程和判断理由。", true)
	b.section(1, "conclusion", "5 结论与建议", "结论；需要后续变更集群的，写明建议通过变更演练实施的调整方向（如扩容、改配置、升级），以及主要参数。", true)
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
			items = append(items, "问："+a.Question+" 答："+a.Answer)
		}
		d.Blocks = append(d.Blocks, docBlock{Kind: "h", Level: 1, Text: "附：现场补充的信息"}, docBlock{Kind: "list", Items: items})
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
	ids = append(ids, sopIDs...)
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
	rs := s.reportSettings()
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
	b, err := starterTemplateDocx(s.reportSettings())
	if err != nil {
		s.fail(w, 500, "生成标准模板失败："+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	w.Header().Set("Content-Disposition", "attachment; filename=standard-template.docx; filename*=UTF-8''"+url.PathEscape("企业标准交付文档模板.docx"))
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
	for _, b := range d.Blocks {
		switch b.Kind {
		case "h":
			w.heading(b.Level+shift, b.Text)
		case "p":
			w.text(b.Text)
		case "note":
			w.note(b.Text)
		case "code":
			w.code(b.Text)
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
				if load == nil || !w.picture(load(b.Job, n), fmt.Sprintf("截图 %d", i+1)) {
					w.note(fmt.Sprintf("（截图 %d 无法放进 Word，请在平台的执行记录里查看）", i+1))
				}
			}
		case "section":
			w.heading(b.Level+shift, b.Title)
			if strings.TrimSpace(b.Text) == "" {
				w.note("（未填写）" + b.Hint)
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
			firstNonEmptyStr(j.Owner, rs.Author, user, "Middleware Hub"),
			fmt.Sprintf("%s（%s）", jobTitle(j), jobOutcomeName(j)),
		})
	}
	if len(rows) == 0 {
		rows = append(rows, [4]string{docVersion, today, firstNonEmptyStr(rs.Author, user, "Middleware Hub"), "文档生成与基线归档"})
	}
	rows = append(rows, [4]string{"", "", "", ""})
	return rows
}

func (s *storeServer) docxOf(f clusterFacts, docs []*clusterDoc, user string, frontOpt ...bool) ([]byte, string, error) {
	withFront := true
	if len(frontOpt) > 0 {
		withFront = frontOpt[0]
	}
	rs := s.reportSettings()
	theme := themeOf(rs.Theme)
	appLabel := strings.TrimSpace(f.Current.AppName + " " + f.Current.Version)

	title := docs[0].Title
	sub := docs[0].Subtitle
	coverFacts := docs[0].Cover
	if len(docs) > 1 {
		title, sub, coverFacts = "交付文档", firstNonEmptyStr(appLabel, f.ID), f.cover()
		var names []string
		for _, d := range docs {
			names = append(names, d.Title+(map[bool]string{true: "（" + d.Subtitle + "）", false: ""}[d.Kind == "change" || d.Kind == "rca" || d.Kind == "assess"]))
		}
		coverFacts = append(coverFacts, [2]string{"包含文档", strings.Join(names, "、")})
	} else if sub == f.ID && appLabel != "" {
		sub = appLabel
	}

	// Render the body first so bw.headings collects normalized chapter numbers (第1章, 1.1, ...) for the TOC preview.
	bw := newDocxWriter(theme, "rIdMw")
	for i, d := range docs {
		if len(docs) > 1 {
			if i > 0 {
				bw.pageBreak()
			}
			name := d.Title
			if d.Kind == "change" || d.Kind == "rca" || d.Kind == "assess" {
				name += "：" + d.Subtitle
			}
			bw.heading(1, name)
			writeDocBody(bw, d, 1, s.progressImage)
		} else {
			writeDocBody(bw, d, 0, s.progressImage)
		}
	}

	today := time.Now().Format("2006-01-02")
	docVersion := firstNonEmptyStr(rs.DocVersion, "V1.0")
	project := firstNonEmptyStr(rs.fill(rs.Project, f.ID, title, appLabel), appLabel, f.ID)
	author := firstNonEmptyStr(rs.Author, user, "Middleware Hub")
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
	}

	var body []byte
	var err error
	if tpl := s.reportTemplate(); tpl != nil && rs.UseTemplate {
		cw := newDocxWriter(theme, "rIdFc")
		tw := newDocxWriter(theme, "rIdFt")
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
		front := newDocxWriter(theme, "rIdF")
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
	case len(parts) == 2 && parts[1] == "docs" && r.Method == "POST":
		s.startRCA(w, r, session, f)
	case len(parts) == 3 && parts[1] == "docs" && (strings.HasPrefix(parts[2], "rca-") || strings.HasPrefix(parts[2], "assess-")) && r.Method == "DELETE":
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
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&in) != nil || len([]rune(in.Text)) > 20000 {
		s.fail(w, 400, "每一节最多 20000 字")
		return
	}
	saved := s.docLoad(f.ID, d.ID)
	old := saved.Sections[key]
	src := "user"
	if strings.TrimSpace(in.Text) == strings.TrimSpace(old.Text) && old.Source != "" {
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
		data, name, ctype = buf.Bytes(), f.ID+"-文档-"+time.Now().Format("20060102")+".zip", "application/zip"
	}
	var ids []string
	for _, d := range docs {
		ids = append(ids, d.ID)
	}
	s.auditReq(r, "doc-export", session.User, f.ID+" "+strings.Join(ids, ",")+map[bool]string{true: " 合并", false: ""}[merge]+fmt.Sprintf(" 自动化=%t 命令=%t 结果=%t", opt.Auto, opt.Cmd, opt.Result))
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
	if !found {
		s.fail(w, 409, "只有手动发起的根因分析可以删除；交付执行失败自动产生的会一直保留")
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

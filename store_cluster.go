package main

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"middleware-deployer/mwpack"
)

// A cluster is what the people using the platform think in: one cluster id, deployed once and then changed by plans
// (upgrade, patch, scale out, scale in). Every one of them is a job with the same cluster id; Seq orders them. The
// platform never connects to the cluster, so its state is what the engineers report back:
//
//   - a job holds the cluster from the moment it is generated until its outcome is reported as done, done with
//     deviations, or void; while one does, no other plan can be made for the cluster;
//   - the next plan always starts from the cluster's head: the newest job reported done.
//
// Jobs whose generation failed, and voided jobs, take no part.

// Outcomes an engineer reports for a generated job.
const (
	outcomeDone     = "done"     // carried out as written
	outcomeDeviated = "deviated" // carried out, but not exactly as written; the note says how
	outcomeFailed   = "failed"   // stopped part way; the job still holds the cluster until it is settled
	outcomeVoid     = "void"     // not carried out, or rolled back; the cluster is as it was before
)

// live says whether a job takes part in its cluster's history.
func (j storeJob) live() bool { return j.State != "failed" && j.Outcome != outcomeVoid }

// finished says whether a job's result is in: what it did is now the cluster's state.
func (j storeJob) finished() bool {
	return j.State == "succeeded" && (j.Outcome == outcomeDone || j.Outcome == outcomeDeviated)
}

// holds says whether a job keeps the cluster busy: being generated, or generated and not settled yet.
func (j storeJob) holds() bool { return j.live() && !j.finished() }

// clusterOf lists the jobs of one cluster, oldest first. The caller holds s.mu.
func (s *storeServer) clusterOf(cluster string) []storeJob {
	var out []storeJob
	for _, j := range s.jobs {
		if j.ClusterID == cluster {
			out = append(out, j)
		}
	}
	sortJobs(out)
	return out
}

func sortJobs(js []storeJob) {
	sort.Slice(js, func(a, b int) bool {
		if js[a].Seq != js[b].Seq {
			return js[a].Seq < js[b].Seq
		}
		return js[a].Created < js[b].Created
	})
}

// clusterHead is the job the next plan starts from: the newest finished one.
func clusterHead(jobs []storeJob) (storeJob, bool) {
	for i := len(jobs) - 1; i >= 0; i-- {
		if jobs[i].live() && jobs[i].finished() {
			return jobs[i], true
		}
	}
	return storeJob{}, false
}

// clusterHolder is the job that keeps the cluster busy, if any.
func clusterHolder(jobs []storeJob) (storeJob, bool) {
	for i := len(jobs) - 1; i >= 0; i-- {
		if jobs[i].holds() {
			return jobs[i], true
		}
	}
	return storeJob{}, false
}

// clusterCurrent is the job that describes the cluster as it is now: the head, or before anything is finished the
// newest generated job that is still live (the deployment that is about to happen).
func clusterCurrent(jobs []storeJob) (storeJob, bool) {
	if h, ok := clusterHead(jobs); ok {
		return h, true
	}
	for i := len(jobs) - 1; i >= 0; i-- {
		if jobs[i].live() && jobs[i].State == "succeeded" {
			return jobs[i], true
		}
	}
	return storeJob{}, false
}

// currentJobs is, for every cluster, the id of the job that describes it now. Security and anything else that asks
// "what is running out there" look at these only; an earlier deployment a plan has replaced is history. The caller
// holds s.mu.
func (s *storeServer) currentJobs() map[string]bool {
	by := map[string][]storeJob{}
	for _, j := range s.jobs {
		by[j.ClusterID] = append(by[j.ClusterID], j)
	}
	out := map[string]bool{}
	for _, js := range by {
		sortJobs(js)
		if c, ok := clusterCurrent(js); ok {
			out[c.ID] = true
		}
	}
	return out
}

// clusterTaken says why a first deployment cannot use a cluster id: some live job already has it. The caller holds
// s.mu.
func (s *storeServer) clusterTaken(cluster string) string {
	for _, j := range s.jobs {
		if j.ClusterID == cluster && j.live() {
			return "集群标识 " + cluster + " 已经被使用。一个集群只做一次首次部署；如需对已运行集群做升级、扩缩容或调参，请在集群详情的「变更演练」中生成实施方案"
		}
	}
	return ""
}

// markOutcome records what the engineer reports for a job. The returned message is empty on success; code is the
// HTTP status otherwise.
func (s *storeServer) markOutcome(id, user, outcome, note string) (storeJob, int, string) {
	note = strings.TrimSpace(note)
	switch outcome {
	case "", outcomeDone, outcomeFailed:
	case outcomeDeviated, outcomeVoid:
		if len([]rune(note)) < 2 {
			return storeJob{}, 400, map[string]string{outcomeDeviated: "请写明实际做法和原交付有什么不同", outcomeVoid: "请写明为什么作废，以及集群现在是否保持原样"}[outcome]
		}
	default:
		return storeJob{}, 400, "状态只能是待执行、完成、有偏差、失败或作废"
	}
	if len([]rune(note)) > 2000 {
		return storeJob{}, 400, "说明最多 2000 字"
	}
	s.jobPersistMu.Lock()
	defer s.jobPersistMu.Unlock()
	s.mu.Lock()
	j := s.jobs[id]
	switch {
	case j.DeliveryMode == "imported":
		s.mu.Unlock()
		return j, 409, "存量纳管集群无需登记首次部署结果，请直接编辑纳管基线或发起变更演练"
	case j.DeliveryMode == "configuration" && outcome != "" && outcome != outcomeVoid:
		s.mu.Unlock()
		return j, 409, "仅配置交付不能登记为现场部署结果；配置生成不代表已安装或验证服务"
	case j.State != "succeeded":
		s.mu.Unlock()
		return j, 409, "交付材料生成成功后才能确认结果"
	case j.Outcome == outcomeVoid:
		s.mu.Unlock()
		return j, 409, "已作废的交付不能再改；要做同样的事，请重新生成一份"
	case j.Outcome == outcome && note == j.OutcomeNote:
		s.mu.Unlock()
		return j, 200, ""
	}
	j.Outcome, j.OutcomeNote, j.Marked, j.MarkedBy = outcome, note, "", ""
	if outcome != "" {
		j.Marked, j.MarkedBy = time.Now().UTC().Format(time.RFC3339Nano), user
	}
	s.mu.Unlock()
	if err := s.persistJob(j); err != nil {
		return j, 500, "状态无法保存，请联系管理员"
	}
	s.mu.Lock()
	s.jobs[id] = j
	s.mu.Unlock()
	return j, 200, ""
}

// planEntry is one job as the cluster page lists it.
type planEntry struct {
	DeliveryMode string                `json:"delivery_mode,omitempty"`
	Purpose      string                `json:"purpose,omitempty"`
	VerifyTarget *verifyTarget         `json:"verify_target,omitempty"`
	Scheme       *mwpack.SchemeSummary `json:"scheme,omitempty"`
	ID           string                `json:"id"`
	Seq          int                   `json:"seq"`
	Owner        string                `json:"owner"`
	Version      string                `json:"version"`
	State        string                `json:"state"`
	Stage        string                `json:"stage,omitempty"`
	Error        string                `json:"error,omitempty"`
	Outcome      string                `json:"outcome,omitempty"`
	OutcomeNote  string                `json:"outcome_note,omitempty"`
	Marked       string                `json:"marked,omitempty"`
	MarkedBy     string                `json:"marked_by,omitempty"`
	RunDone      int                   `json:"run_done,omitempty"`
	RunFailed    int                   `json:"run_failed,omitempty"`
	RunTotal     int                   `json:"run_total,omitempty"`
	Revises      string                `json:"revises,omitempty"`
	RevisedBy    string                `json:"revised_by,omitempty"`
	Created      string                `json:"created"`
	Updated      string                `json:"updated,omitempty"`
}

// clusterView is one cluster: its first deployment, revision history, and state.
type clusterView struct {
	DeliveryMode string                `json:"delivery_mode,omitempty"`
	Imported     *mwpack.ImportedMeta  `json:"imported,omitempty"`
	Icon         string                `json:"icon,omitempty"`
	Purpose      string                `json:"purpose,omitempty"`
	VerifyTarget *verifyTarget         `json:"verify_target,omitempty"`
	Scheme       *mwpack.SchemeSummary `json:"scheme,omitempty"`
	ID           string                `json:"id"`
	AppID        string                `json:"app_id"`
	AppName      string                `json:"app_name"`
	Owner        string                `json:"owner"`
	// Version, Platform and Hosts describe the cluster as it is now (see clusterCurrent).
	Version  string      `json:"version"`
	Platform string      `json:"platform,omitempty"`
	Hosts    int         `json:"hosts"`
	Created  string      `json:"created"`
	Updated  string      `json:"updated"`
	Current  string      `json:"current,omitempty"`
	Head     string      `json:"head,omitempty"`
	Holder   string      `json:"holder,omitempty"`
	Plans               []planEntry `json:"plans"` // newest first
	Blocked             string      `json:"blocked,omitempty"`
	AppliedChangesCount int         `json:"applied_changes_count,omitempty"`
	LastChangeAt        string      `json:"last_change_at,omitempty"`
	LastChangeTitle     string      `json:"last_change_title,omitempty"`
}

func entryOf(j storeJob) planEntry {
	return planEntry{j.DeliveryMode, j.Purpose, j.VerifyTarget, j.Scheme, j.ID, j.Seq, j.Owner, j.Version, j.State, j.Stage, j.Error, j.Outcome, j.OutcomeNote, j.Marked, j.MarkedBy, j.RunDone, j.RunFailed, j.RunTotal, j.Revises, j.RevisedBy, j.Created, j.Updated}
}

// autoExecutedJobs returns the set of job IDs that have at least one automated execution run.
func (s *storeServer) autoExecutedJobs() map[string]bool {
	out := map[string]bool{}
	executionMu.Lock()
	db, err := s.readExecutions()
	executionMu.Unlock()
	if err != nil {
		return out
	}
	for _, r := range db.Runs {
		if r.Job != "" {
			out[r.Job] = true
		}
	}
	return out
}

func effectiveDeliveryMode(jobID, raw string, autoJobs map[string]bool) string {
	switch raw {
	case "automatic", "configuration", "imported":
		return raw
	}
	if jobID != "" && autoJobs[jobID] {
		return "automatic"
	}
	return "offline"
}

// clusters lists the clusters the user can see.
func (s *storeServer) clusters(w http.ResponseWriter, r *http.Request, session storeSession) {
	vis := s.visibleJobs(session.User)
	only := r.URL.Query().Get("id")
	s.mu.Lock()
	by := map[string][]storeJob{}
	for _, j := range s.jobs {
		if only == "" || j.ClusterID == only {
			by[j.ClusterID] = append(by[j.ClusterID], j)
		}
	}
	var views []clusterView
	for id, jobs := range by {
		sortJobs(jobs)
		seen := false
		for _, j := range jobs {
			seen = seen || vis(j.Owner)
		}
		if !seen {
			continue
		}
		first := jobs[0]
		for _, j := range jobs {
			if j.Seq == 0 && j.live() {
				first = j
				break
			}
		}
		v := clusterView{Purpose: first.Purpose, VerifyTarget: first.VerifyTarget, Scheme: first.Scheme, ID: id, AppID: first.AppID, AppName: first.AppName, Owner: first.Owner, Version: first.Version, Created: first.Created, Plans: []planEntry{}}
		for i := len(jobs) - 1; i >= 0; i-- {
			j := jobs[i]
			v.Plans = append(v.Plans, entryOf(j))
			if u := firstNonEmptyStr(j.Updated, j.Created); u > v.Updated {
				v.Updated = u
			}
		}
		if c, ok := clusterCurrent(jobs); ok {
			v.Current = c.ID
			v.Scheme = c.Scheme
			if c.Purpose != "" {
				v.Purpose = c.Purpose
				v.VerifyTarget = c.VerifyTarget
			}
			if c.AppID == v.AppID {
				v.Version = c.Version
			}
		}
		if h, ok := clusterHead(jobs); ok {
			v.Head = h.ID
		}
		if h, ok := clusterHolder(jobs); ok {
			v.Holder = h.ID
		}
		views = append(views, v)
	}
	s.mu.Unlock()
	lang := wLang(w)
	autoJobs := s.autoExecutedJobs()
	for i := range views {
		v := &views[i]
		modeJob := v.Current
		rawMode := ""
		if modeJob == "" && len(v.Plans) > 0 {
			modeJob = v.Plans[0].ID
			rawMode = v.Plans[0].DeliveryMode
		}
		if modeJob != "" {
			if dep := s.readSpec(modeJob); dep != nil && dep.DeliveryMode != "" {
				rawMode = dep.DeliveryMode
			}
		}
		v.DeliveryMode = effectiveDeliveryMode(modeJob, rawMode, autoJobs)
		if v.DeliveryMode == "configuration" {
			v.Blocked = tr(lang, "本次仅交付配置文件；生成成功不代表已安装或验证现场服务", "Configuration-only delivery: generation succeeded, but on-site installation and runtime checks have not run.")
		}
		for n := range v.Plans {
			entry := &v.Plans[n]
			entryRaw := entry.DeliveryMode
			if entryRaw == "" {
				if dep := s.readSpec(entry.ID); dep != nil {
					entryRaw = dep.DeliveryMode
				}
			}
			entry.DeliveryMode = effectiveDeliveryMode(entry.ID, entryRaw, autoJobs)
			entry.Scheme = mwpack.LocalizeSchemeSummary(lang, s.deliveryScheme(entry.ID, v.AppID, entry.Scheme))
		}
		if v.Current == "" {
			continue
		}
		if d := s.readSpec(v.Current); d != nil {
			v.Hosts, v.Platform = len(d.Hosts), d.Platform
			if d.Imported != nil {
				v.Imported = d.Imported
				if d.Imported.Icon != "" {
					v.Icon = d.Imported.Icon
				}
			}
		}
		if v.Icon == "" {
			if pr, ok := mwpack.LookupImportPreset(v.AppID); ok {
				v.Icon = pr.Icon
			}
		}
		v.Scheme = mwpack.LocalizeSchemeSummary(lang, s.deliveryScheme(v.Current, v.AppID, v.Scheme))
		v.Version = s.deliveryAppVersion(v.Current, v.AppID, v.Version)
		if applied := s.listAppliedRehearsals(v.ID); len(applied) > 0 {
			v.AppliedChangesCount = len(applied)
			latest := applied[len(applied)-1]
			v.LastChangeAt = firstNonEmptyStr(latest.AppliedAt, latest.UpdatedAt)
			v.LastChangeTitle = latest.Title
			if v.LastChangeAt > v.Updated {
				v.Updated = v.LastChangeAt
			}
		}
	}
	sort.Slice(views, func(a, b int) bool { return views[a].Updated > views[b].Updated })
	if views == nil {
		views = []clusterView{}
	}
	s.writeJSON(w, 200, views)
}

// clusterHistoryText is a cluster's history in words, for the assistant.
func (s *storeServer) clusterHistoryText(cluster string) string {
	s.mu.Lock()
	jobs := s.clusterOf(cluster)
	s.mu.Unlock()
	head, hasHead := clusterHead(jobs)
	cur, _ := clusterCurrent(jobs)
	holder, busy := clusterHolder(jobs)
	var b strings.Builder
	if cur.DeliveryMode == "imported" {
		when := firstNonEmptyStr(day(cur.Created), day(cur.Updated))
		fmt.Fprintf(&b, "集群 %s 当前状态：【存量纳管运行中集群】（非平台首次部署，于 %s 纳管建档，组件：%s %s）。\n", cluster, when, cur.AppName, cur.Version)
		if dep := s.readSpec(cur.ID); dep != nil && dep.Imported != nil {
			im := dep.Imported
			if im.DeployMethod != "" || im.ArchSummary != "" {
				fmt.Fprintf(&b, "- 部署形态：%s；架构摘要：%s\n", firstNonEmptyStr(im.DeployMethod, "未知"), firstNonEmptyStr(im.ArchSummary, "—"))
			}
			if len(im.ServiceUnits) > 0 {
				fmt.Fprintf(&b, "- 系统服务：%s\n", strings.Join(im.ServiceUnits, ", "))
			}
			if len(im.ConfigPaths) > 0 {
				fmt.Fprintf(&b, "- 配置路径：%s\n", strings.Join(im.ConfigPaths, ", "))
			}
			if len(im.DataDirs) > 0 {
				fmt.Fprintf(&b, "- 数据目录：%s\n", strings.Join(im.DataDirs, ", "))
			}
			if im.Notes != "" {
				fmt.Fprintf(&b, "- 纳管备注：%s\n", truncRunes(im.Notes, 240))
			}
		}
	} else if hasHead {
		when := firstNonEmptyStr(day(head.Marked), day(head.Created))
		fmt.Fprintf(&b, "集群 %s 当前状态：【已部署完成 / 运行中（已投产）】，运行基线为 %s（编号 %s，%s 确认）；共 %d 份交付记录（旧的在前）。\n", cluster, jobTitle(head), head.ID, when, len(jobs))
	} else {
		fmt.Fprintf(&b, "集群 %s 当前状态：【尚未完成首次部署（未投产）】，共 %d 份交付记录（旧的在前）。\n", cluster, len(jobs))
	}
	for _, j := range jobs {
		state := outcomeNames[j.Outcome]
		if j.State != "succeeded" {
			state = map[string]string{"failed": "生成失败", "queued": "生成中", "running": "生成中"}[j.State]
		}
		fmt.Fprintf(&b, "- %s（编号 %s，%s 由 %s 生成）：%s", jobTitle(j), j.ID, day(j.Created), j.Owner, state)
		if j.ID == cur.ID {
			b.WriteString("【当前状态以它为准】")
		}
		if j.OutcomeNote != "" {
			b.WriteString("；现场说明：" + j.OutcomeNote)
		}
		if j.RunTotal > 0 {
			fmt.Fprintf(&b, "；现场记录 %d/%d 步，%d 步失败", j.RunDone, j.RunTotal, j.RunFailed)
		}
		b.WriteString("\n")
	}
	if busy {
		fmt.Fprintf(&b, "待确认结果的交付：%s。\n", jobTitle(holder))
	}
	if rhs := s.listRehearsals(cluster); len(rhs) > 0 {
		stageName := map[string]string{"scoping": "边界对齐", "probing": "只读探针", "rehearsing": "测试演练", "finalized": "已定稿待实施"}
		fmt.Fprintf(&b, "已有变更演练（共 %d 个，最新的在前）：\n", len(rhs))
		for i, r := range rhs {
			if i >= 8 {
				break
			}
			st := firstNonEmptyStr(stageName[r.Stage], r.Stage)
			if r.Voided {
				st = "已作废（不执行）"
			} else if r.Stage == "finalized" && r.Applied {
				st = fmt.Sprintf("已落地生效（%s 于 %s 确认）", firstNonEmptyStr(r.AppliedBy, r.Owner), day(firstNonEmptyStr(r.AppliedAt, r.UpdatedAt)))
			}
			fmt.Fprintf(&b, "- 「%s」（%s", r.Title, st)
			if r.Applied && r.AppliedSummary != "" {
				fmt.Fprintf(&b, "；生效内容：%s", truncRunes(r.AppliedSummary, 160))
			}
			b.WriteString("）\n")
		}
	}
	return b.String()
}

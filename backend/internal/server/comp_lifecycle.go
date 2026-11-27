package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"delivery-studio/mwpack"
)

var compVerifyMu sync.Mutex

// verifyTarget identifies the component version & OS a verification delivery is testing.
type verifyTarget struct {
	Component string `json:"component"`
	Version   string `json:"version"`
	Platform  string `json:"platform"`
}

// compReportStep is one lightweight step summary stored inside an automated component test report.
type compReportStep struct {
	Key         string `json:"key"`
	Title       string `json:"title"`
	Phase       string `json:"phase,omitempty"` // deploy | tests | endpoint
	State       string `json:"state"`           // done | resolved
	DurationSec int    `json:"duration_sec,omitempty"`
}

// compVerification is one decoupled test/release record attached to a component version + OS.
//   - test_mode == "automatic": captured automatically from a passing automated execution run, with a full self-contained step report.
//   - test_mode == "manual"   : human sign-off after offline/manual testing (no automated report).
type compVerification struct {
	ID             string           `json:"id"`
	Component      string           `json:"component"`
	Version        string           `json:"version"`
	Platform       string           `json:"platform"`
	PlatformName   string           `json:"platform_name,omitempty"`
	TestMode       string           `json:"test_mode,omitempty"` // automatic | manual
	HasReport      bool             `json:"has_report,omitempty"`
	JobID          string           `json:"job_id,omitempty"`
	ClusterID      string           `json:"cluster_id,omitempty"`
	DeliveryMode   string           `json:"delivery_mode,omitempty"` // legacy compat: automatic | offline
	SchemeName     string           `json:"scheme_name,omitempty"`
	Topology       string           `json:"topology,omitempty"`
	Hosts          int              `json:"hosts,omitempty"`
	PassedSteps    int              `json:"passed_steps,omitempty"`
	TotalSteps     int              `json:"total_steps,omitempty"`
	DurationSec    int              `json:"duration_sec,omitempty"`
	Executor       string           `json:"executor,omitempty"`
	Steps          []compReportStep `json:"steps,omitempty"`
	ManifestHash   string           `json:"manifest_hash,omitempty"`
	VerifiedBy     string           `json:"verified_by"`
	VerifiedAt     string           `json:"verified_at"`
	Note           string           `json:"note,omitempty"`
	Stale          bool             `json:"stale,omitempty"`
	DeliveryExists bool             `json:"delivery_exists,omitempty"`
}

// verificationCandidate is an eligible passing delivery (automatic or offline manual) that can certify a version + OS.
type verificationCandidate struct {
	JobID               string   `json:"job_id"`
	ClusterID           string   `json:"cluster_id"`
	Version             string   `json:"version"`
	Platform            string   `json:"platform"`
	PlatformName        string   `json:"platform_name"`
	DeliveryMode        string   `json:"delivery_mode"`
	Purpose             string   `json:"purpose,omitempty"`
	SchemeName          string   `json:"scheme_name,omitempty"`
	Topology            string   `json:"topology,omitempty"`
	Hosts               int      `json:"hosts,omitempty"`
	PassedSteps         int      `json:"passed_steps"`
	TotalSteps          int      `json:"total_steps"`
	DurationSec         int      `json:"duration_sec,omitempty"`
	Executor            string   `json:"executor,omitempty"`
	ManifestHash        string   `json:"manifest_hash,omitempty"`
	Stale               bool     `json:"stale,omitempty"`
	CompletedAt         string   `json:"completed_at"`
	Owner               string   `json:"owner"`
	AlreadyRecorded     bool     `json:"already_recorded,omitempty"`
	CanCleanup          bool     `json:"can_cleanup,omitempty"`
	OtherPendingTargets []string `json:"other_pending_targets,omitempty"`
}

func isTempVerificationJob(j storeJob) bool {
	return j.Purpose == "verification" || strings.HasPrefix(j.ClusterID, "verify-")
}

// jobPromoteTarget is returned on GET /api/jobs/<id> when a passing delivery can certify/unlock a component version + OS.
type jobPromoteTarget struct {
	Component       string `json:"component"`
	ComponentTitle  string `json:"component_title"`
	Version         string `json:"version"`
	Platform        string `json:"platform"`
	PlatformName    string `json:"platform_name"`
	CurrentStatus   string `json:"current_status"`
	NeedsUnlock     bool   `json:"needs_unlock"`
	Stale           bool   `json:"stale,omitempty"`
	AlreadyRecorded bool   `json:"already_recorded,omitempty"`
	DeliveryMode    string `json:"delivery_mode"`
	PassedSteps     int    `json:"passed_steps"`
	TotalSteps      int    `json:"total_steps"`
	DurationSec     int    `json:"duration_sec,omitempty"`
	Executor        string `json:"executor,omitempty"`
}

func (s *storeServer) compVerifyPath(name string) string {
	return filepath.Join(s.cfg.DataDir, "comp-verifications", name+".json")
}

func (s *storeServer) loadCompVerifications(name string) []compVerification {
	if !safeName(name) {
		return []compVerification{}
	}
	if s.repo != nil {
		if row, ok, err := s.repo.getComponentSlot(name, "verifications"); err == nil && ok && len(row.Meta) > 0 {
			var out []compVerification
			if json.Unmarshal(row.Meta, &out) == nil && out != nil {
				return out
			}
		}
		return []compVerification{}
	}
	if s.cfg.DataDir == "" {
		return []compVerification{}
	}
	b, err := os.ReadFile(s.compVerifyPath(name))
	if err != nil {
		return []compVerification{}
	}
	var out []compVerification
	if json.Unmarshal(b, &out) != nil || out == nil {
		return []compVerification{}
	}
	return out
}

func (s *storeServer) saveCompVerifications(name string, list []compVerification) error {
	if !safeName(name) {
		return nil
	}
	if list == nil {
		list = []compVerification{}
	}
	if s.repo != nil {
		return s.repo.saveComponentSlot(name, "verifications", 0, fileSet{}, list)
	}
	if s.cfg.DataDir == "" {
		return nil
	}
	return writeJSONFile(s.compVerifyPath(name), list)
}

func (s *storeServer) appendCompVerification(rec compVerification) error {
	compVerifyMu.Lock()
	defer compVerifyMu.Unlock()
	list := s.loadCompVerifications(rec.Component)
	replaced := false
	for i := range list {
		// Maintain one clean latest record per (version, platform) so the component stays tidy and decoupled from deliveries.
		if list[i].Version == rec.Version && list[i].Platform == rec.Platform {
			if rec.ID == "" {
				rec.ID = list[i].ID
			}
			list[i] = rec
			replaced = true
			break
		}
	}
	if !replaced {
		if rec.ID == "" {
			rec.ID = randomStoreToken(6)
		}
		list = append([]compVerification{rec}, list...)
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].VerifiedAt > list[j].VerifiedAt })
	return s.saveCompVerifications(rec.Component, list)
}

func normalizeVerificationTestMode(r compVerification) string {
	switch strings.ToLower(strings.TrimSpace(r.TestMode)) {
	case "automatic", "manual":
		return strings.ToLower(strings.TrimSpace(r.TestMode))
	}
	if r.DeliveryMode == "automatic" && (r.TotalSteps > 0 || len(r.Steps) > 0) {
		return "automatic"
	}
	return "manual"
}

func (s *storeServer) currentManifestHash(name string) string {
	if c, ok := s.plat.cat().Get(name); ok {
		return c.ManifestSum()
	}
	return ""
}

func (s *storeServer) enrichVerifications(name string, recs []compVerification) []compVerification {
	curSum := s.currentManifestHash(name)
	var execDB *executionDB
	out := make([]compVerification, len(recs))
	for i, r := range recs {
		if r.PlatformName == "" && r.Platform != "" {
			if def, ok := mwpack.PlatformByID(r.Platform); ok {
				r.PlatformName = def.Title
			} else {
				r.PlatformName = r.Platform
			}
		}
		r.TestMode = normalizeVerificationTestMode(r)
		// Best-effort backfill of step breakdown for legacy automated records whose original job still exists.
		if r.TestMode == "automatic" && len(r.Steps) == 0 && r.JobID != "" {
			if execDB == nil {
				executionMu.Lock()
				if db, err := s.readExecutions(); err == nil {
					execDB = &db
				}
				executionMu.Unlock()
			}
			if rawPlan := s.readJobPlanRaw(r.JobID); len(rawPlan) > 0 {
				if steps := s.extractAutoReportSteps(r.JobID, rawPlan, execDB); len(steps) > 0 {
					r.Steps = steps
				}
			}
		}
		r.HasReport = r.TestMode == "automatic" && (r.TotalSteps > 0 || len(r.Steps) > 0)
		r.Stale = curSum != "" && r.ManifestHash != "" && r.ManifestHash != curSum
		r.DeliveryExists = false
		out[i] = r
	}
	return out
}

// extractAutoReportSteps builds a compact, self-contained list of required deploy/test/endpoint steps and their durations
// from a passing automated job. It carries zero raw stdout logs so the report stays tiny and independent forever.
func (s *storeServer) extractAutoReportSteps(jobID string, rawPlan []byte, execDB *executionDB) []compReportStep {
	if len(rawPlan) == 0 {
		return nil
	}
	tabs := s.runbookStepsOf(rawPlan, jobID)
	doc := s.readProgress(jobID)
	if execDB != nil {
		doc = s.enrichProgressWithExecutionDB(jobID, doc, *execDB, tabs)
	}
	durByKey := map[string]int{}
	if execDB != nil {
		// Sort runs oldest -> newest so latest completed attempt duration wins per step key.
		var runs []executionRun
		for _, r := range execDB.Runs {
			if r.Job == jobID && !r.CheckMode {
				runs = append(runs, r)
			}
		}
		sort.Slice(runs, func(i, j int) bool { return runs[i].Created < runs[j].Created })
		for _, r := range runs {
			for _, st := range r.Steps {
				if st.Started != "" && st.Finished != "" && (st.State == "succeeded" || st.State == "skipped") {
					if t0, e0 := time.Parse(time.RFC3339Nano, st.Started); e0 == nil {
						if t1, e1 := time.Parse(time.RFC3339Nano, st.Finished); e1 == nil && !t1.Before(t0) {
							durByKey[st.Key] = int(t1.Sub(t0).Seconds())
						}
					}
				}
			}
		}
	}
	var out []compReportStep
	for _, tab := range tabs {
		for _, st := range tab.Steps {
			isReq := strings.HasPrefix(st.Key, "deploy/") || strings.HasPrefix(st.Key, "tests/") || strings.HasPrefix(st.Key, "endpoint/")
			if !isReq || st.Key == "deploy/deploy-bootstrap" {
				continue
			}
			rec := doc.Steps[st.Key]
			if rec.State != "done" && rec.State != "resolved" {
				continue
			}
			phase := "deploy"
			if strings.HasPrefix(st.Key, "tests/") {
				phase = "tests"
			} else if strings.HasPrefix(st.Key, "endpoint/") {
				phase = "endpoint"
			}
			out = append(out, compReportStep{
				Key:         st.Key,
				Title:       st.Title,
				Phase:       phase,
				State:       rec.State,
				DurationSec: durByKey[st.Key],
			})
		}
	}
	return out
}

// captureAutoVerificationReports automatically snapshots a decoupled, self-contained automated test report
// onto every managed component instance inside jobID once an automated execution passes all required steps.
// It never auto-publishes unreleased components — admins still explicitly click Publish in the component view.
func (s *storeServer) captureAutoVerificationReports(jobID string, execDB executionDB) {
	if s.cfg.DataDir == "" || jobID == "" {
		return
	}
	s.mu.Lock()
	j, ok := s.jobs[jobID]
	s.mu.Unlock()
	if !ok || j.State != "succeeded" || j.Outcome == outcomeVoid || j.Outcome == outcomeFailed || j.DeliveryMode == "configuration" {
		return
	}
	rawPlan := s.readJobPlanRaw(jobID)
	if len(rawPlan) == 0 {
		return
	}
	var pl jobPlanLite
	if json.Unmarshal(rawPlan, &pl) != nil || pl.DeliveryMode == "configuration" {
		return
	}
	steps := s.extractAutoReportSteps(jobID, rawPlan, &execDB)
	cat := s.plat.cat()
	seen := map[string]bool{}
	for _, inst := range pl.Instances {
		key := inst.Component + "\x00" + inst.Version
		if seen[key] {
			continue
		}
		seen[key] = true
		c, ok := cat.Get(inst.Component)
		if !ok || c.Kind == "external" {
			continue
		}
		cand, _, reason := s.evalVerificationJobFast(j, inst.Component, inst.Version, pl.Platform, rawPlan, &execDB)
		if reason != "" || cand == nil || cand.DeliveryMode != "automatic" {
			continue
		}
		rec := compVerification{
			ID:           randomStoreToken(6),
			Component:    inst.Component,
			Version:      inst.Version,
			Platform:     pl.Platform,
			PlatformName: cand.PlatformName,
			TestMode:     "automatic",
			HasReport:    true,
			DeliveryMode: "automatic",
			SchemeName:   cand.SchemeName,
			Topology:     cand.Topology,
			Hosts:        cand.Hosts,
			PassedSteps:  cand.PassedSteps,
			TotalSteps:   cand.TotalSteps,
			DurationSec:  cand.DurationSec,
			Executor:     cand.Executor,
			Steps:        steps,
			ManifestHash: firstNonEmptyStr(cand.ManifestHash, s.currentManifestHash(inst.Component)),
			VerifiedBy:   firstNonEmptyStr(j.Owner, "自动执行"),
			VerifiedAt:   firstNonEmptyStr(cand.CompletedAt, now()),
		}
		_ = s.appendCompVerification(rec)
	}
}

// releaseGateIssues enforces the production delivery release gate:
//   - Formal deliveries require every component instance (primary + companions) to be "published" AND released on the target OS.
//   - Maintainer test deliveries (purpose == "verification") allow ANY unpublished version or OS so maintainers can test before publishing.
func (s *storeServer) releaseGateIssues(plan *mwpack.Plan, purpose string) []mwpack.Problem {
	if purpose == "verification" {
		return nil
	}
	var out []mwpack.Problem
	targetOS := plan.Platform.ID
	if targetOS == "" {
		targetOS = plan.Dep.Platform
	}
	osTitle := targetOS
	if def, ok := mwpack.PlatformByID(targetOS); ok {
		osTitle = def.Title
	}
	for _, inst := range plan.Instances {
		if inst == nil || inst.R == nil {
			continue
		}
		verStatus := firstNonEmptyStr(inst.R.Version.Status, "draft")
		plStatus := inst.R.PlatformStatus(targetOS)
		path := "instances[" + inst.ID + "]"
		if plStatus == "published" {
			continue
		}
		if verStatus == "published" && targetOS != "" {
			out = append(out, mwpack.Problem{
				Severity: "error",
				Path:     path,
				Message:  fmt.Sprintf("%s %s 在 %s 上尚未发布，禁止用于正式交付；请维护者在「组件」页完成测试并发布该系统", inst.Title, inst.Version, osTitle),
			})
		} else {
			out = append(out, mwpack.Problem{
				Severity: "error",
				Path:     path,
				Message:  fmt.Sprintf("%s %s 当前尚未发布，禁止用于正式交付；请维护者在「组件」页完成测试并发布后再用于生产交付", inst.Title, inst.Version),
			})
		}
	}
	return out
}

type jobPlanLite struct {
	DeliveryMode string `json:"delivery_mode"`
	Platform     string `json:"platform"`
	Cluster      string `json:"cluster"`
	Hosts        []struct {
		Name string `json:"name"`
	} `json:"hosts"`
	Instances []struct {
		ID        string                `json:"id"`
		Component string                `json:"component"`
		Title     string                `json:"title"`
		Version   string                `json:"version"`
		Status    string                `json:"status"`
		Manifest  string                `json:"manifest"`
		Scheme    *mwpack.SchemeSummary `json:"scheme"`
	} `json:"instances"`
}

func (s *storeServer) readJobManifestHash(jobID, comp string) string {
	b, err := s.readJobLockBytes(jobID)
	if err != nil {
		return ""
	}
	var lock struct {
		Instances []struct {
			Component string `json:"component"`
			Manifest  string `json:"manifest"`
		} `json:"instances"`
	}
	if json.Unmarshal(b, &lock) != nil {
		return ""
	}
	for _, in := range lock.Instances {
		if in.Component == comp && in.Manifest != "" {
			return in.Manifest
		}
	}
	return ""
}

func (s *storeServer) readJobPlanRaw(jobID string) []byte {
	b, err := s.readJobPlanBytes(jobID)
	if err != nil {
		return nil
	}
	return b
}

// evalVerificationJob checks whether a delivery job satisfies full verification criteria (either via automated execution
// OR offline manual runbook confirmation) for a given component + version + OS platform.
func (s *storeServer) evalVerificationJob(j storeJob, comp, ver, platform string) (*verificationCandidate, string) {
	executionMu.Lock()
	execDB, execErr := s.readExecutions()
	executionMu.Unlock()
	var dbPtr *executionDB
	if execErr == nil {
		dbPtr = &execDB
	}
	cand, _, reason := s.evalVerificationJobFast(j, comp, ver, platform, nil, dbPtr)
	return cand, reason
}

func (s *storeServer) evalVerificationJobFast(j storeJob, comp, ver, platform string, rawPlan []byte, execDB *executionDB) (*verificationCandidate, *jobPlanLite, string) {
	if j.State != "succeeded" {
		return nil, nil, "该交付尚未生成成功"
	}
	if j.Outcome == outcomeVoid {
		return nil, nil, "该交付已作废，不能作为验证证据"
	}
	if j.Outcome == outcomeFailed {
		return nil, nil, "该交付已标记失败，不能作为验证证据"
	}
	if j.DeliveryMode == "configuration" {
		return nil, nil, "仅配置交付未执行实际部署与测试，不能作为真机验证证据"
	}
	if len(rawPlan) == 0 {
		rawPlan = s.readJobPlanRaw(j.ID)
	}
	if len(rawPlan) == 0 {
		return nil, nil, "找不到该交付的执行计划（plan.json）"
	}
	var pl jobPlanLite
	if json.Unmarshal(rawPlan, &pl) != nil {
		return nil, nil, "该交付的执行计划无法读取"
	}
	if pl.DeliveryMode == "configuration" {
		return nil, nil, "仅配置交付未执行实际部署与测试，不能作为真机验证证据"
	}
	if platform != "" && pl.Platform != platform {
		wantName := platform
		if def, ok := mwpack.PlatformByID(platform); ok {
			wantName = def.Title
		}
		gotName := pl.Platform
		if def, ok := mwpack.PlatformByID(pl.Platform); ok {
			gotName = def.Title
		}
		return nil, nil, fmt.Sprintf("该交付的目标系统是 %s，与待验证系统 %s 不一致", gotName, wantName)
	}
	var matchedInst *struct {
		ID        string                `json:"id"`
		Component string                `json:"component"`
		Title     string                `json:"title"`
		Version   string                `json:"version"`
		Status    string                `json:"status"`
		Manifest  string                `json:"manifest"`
		Scheme    *mwpack.SchemeSummary `json:"scheme"`
	}
	for i := range pl.Instances {
		if pl.Instances[i].Component == comp && (ver == "" || pl.Instances[i].Version == ver) {
			matchedInst = &pl.Instances[i]
			break
		}
	}
	if matchedInst == nil {
		return nil, nil, fmt.Sprintf("该交付未包含 %s %s", comp, ver)
	}

	tabs := s.runbookStepsOf(rawPlan, j.ID)
	doc := s.readProgress(j.ID)
	if execDB != nil {
		doc = s.enrichProgressWithExecutionDB(j.ID, doc, *execDB, tabs)
	}

	// Check active execution runs & duration
	var totalDurSec int
	var hasAutoRun bool
	var executorName string
	if execDB != nil {
		for _, r := range execDB.Runs {
			if r.Job != j.ID || r.CheckMode {
				continue
			}
			hasAutoRun = true
			if r.ExecutorName != "" {
				executorName = r.ExecutorName
			}
			for _, st := range r.Steps {
				if st.Started != "" && st.Finished != "" {
					if t0, e0 := time.Parse(time.RFC3339Nano, st.Started); e0 == nil {
						if t1, e1 := time.Parse(time.RFC3339Nano, st.Finished); e1 == nil && t1.After(t0) {
							totalDurSec += int(t1.Sub(t0).Seconds())
						}
					}
				}
			}
		}
	}

	totalReq, passedReq := 0, 0
	var failedTitles []string
	var missingTitles []string
	var latestAt string
	autoStepCount := 0

	for _, tab := range tabs {
		for _, st := range tab.Steps {
			rec := doc.Steps[st.Key]
			if rec.Source == "automatic" {
				autoStepCount++
				if rec.Executor != "" && executorName == "" {
					executorName = rec.Executor
				}
			}
			if rec.Finished > latestAt {
				latestAt = rec.Finished
			}
			if rec.At > latestAt {
				latestAt = rec.At
			}
			if rec.State == "failed" {
				failedTitles = append(failedTitles, st.Title)
				continue
			}
			isRequired := strings.HasPrefix(st.Key, "deploy/") || strings.HasPrefix(st.Key, "tests/") || strings.HasPrefix(st.Key, "endpoint/")
			if !isRequired {
				continue
			}
			// Bootstrap step is only needed for offline deliveries, not automated executions.
			if st.Key == "deploy/deploy-bootstrap" && (hasAutoRun || pl.DeliveryMode == "automatic") {
				continue
			}
			totalReq++
			if rec.State == "done" || rec.State == "resolved" {
				passedReq++
			} else {
				missingTitles = append(missingTitles, st.Title)
			}
		}
	}

	if len(failedTitles) > 0 {
		return nil, nil, fmt.Sprintf("该交付仍有 %d 个失败步骤未恢复（如：%s），不能作为发布证据", len(failedTitles), failedTitles[0])
	}
	if totalReq == 0 {
		return nil, nil, "该交付没有可验收的部署与测试步骤"
	}
	if passedReq < totalReq {
		return nil, nil, fmt.Sprintf("该交付仅完成 %d/%d 个必跑步骤，尚有步骤未验收通过（如：%s）", passedReq, totalReq, missingTitles[0])
	}

	mode := "offline"
	if hasAutoRun || autoStepCount > 0 || pl.DeliveryMode == "automatic" {
		mode = "automatic"
	}
	manifestHash := matchedInst.Manifest
	if manifestHash == "" {
		manifestHash = s.readJobManifestHash(j.ID, comp)
	}
	curHash := s.currentManifestHash(comp)
	plName := pl.Platform
	if def, ok := mwpack.PlatformByID(pl.Platform); ok {
		plName = def.Title
	}
	var schemeName, topology string
	if matchedInst.Scheme != nil {
		schemeName = matchedInst.Scheme.Name
		topology = matchedInst.Scheme.Topology
	} else if j.Scheme != nil {
		schemeName = j.Scheme.Name
		topology = j.Scheme.Topology
	}
	completedAt := firstNonEmptyStr(latestAt, j.Marked, j.Updated, j.Created)
	return &verificationCandidate{
		JobID:        j.ID,
		ClusterID:    firstNonEmptyStr(j.ClusterID, pl.Cluster),
		Version:      matchedInst.Version,
		Platform:     pl.Platform,
		PlatformName: plName,
		DeliveryMode: mode,
		Purpose:      j.Purpose,
		SchemeName:   schemeName,
		Topology:     topology,
		Hosts:        len(pl.Hosts),
		PassedSteps:  passedReq,
		TotalSteps:   totalReq,
		DurationSec:  totalDurSec,
		Executor:     executorName,
		ManifestHash: manifestHash,
		Stale:        curHash != "" && manifestHash != "" && manifestHash != curHash,
		CompletedAt:  completedAt,
		Owner:        j.Owner,
	}, &pl, ""
}

func (s *storeServer) listVerificationCandidates(comp, user string) []verificationCandidate {
	s.mu.Lock()
	jobs := make([]storeJob, 0, len(s.jobs))
	for _, j := range s.jobs {
		if j.State != "succeeded" || j.Outcome == outcomeVoid || j.Outcome == outcomeFailed || j.DeliveryMode == "configuration" {
			continue
		}
		jobs = append(jobs, j)
	}
	s.mu.Unlock()

	executionMu.Lock()
	execDB, execErr := s.readExecutions()
	executionMu.Unlock()
	var dbPtr *executionDB
	if execErr == nil {
		dbPtr = &execDB
	}

	existing := map[string]bool{}
	for _, r := range s.loadCompVerifications(comp) {
		existing[r.JobID+"\x00"+r.Version+"\x00"+r.Platform] = true
	}

	cat := s.plat.cat()
	canDelAny := user != "" && s.can(user, "delivery.delete")
	canPub := user != "" && s.can(user, "component.publish")
	out := []verificationCandidate{}
	for _, j := range jobs {
		if user != "" && !s.jobVisible(user, j) {
			continue
		}
		cand, pl, reason := s.evalVerificationJobFast(j, comp, "", "", nil, dbPtr)
		if reason != "" || cand == nil {
			continue
		}
		cand.AlreadyRecorded = existing[cand.JobID+"\x00"+cand.Version+"\x00"+cand.Platform]
		if isTempVerificationJob(j) && (canDelAny || (user != "" && j.Owner == user)) {
			locked := dbPtr == nil || executionLockedInDB(*dbPtr, j.ID)
			if !locked {
				cand.CanCleanup = true
				if canPub && pl != nil {
					seenOther := map[string]bool{}
					for _, inst := range pl.Instances {
						if inst.Component == comp || seenOther[inst.Component+"\x00"+inst.Version] {
							continue
						}
						seenOther[inst.Component+"\x00"+inst.Version] = true
						c, ok := cat.Get(inst.Component)
						if !ok || c.Kind == "external" {
							continue
						}
						r, err := c.Resolve(inst.Version)
						if err != nil {
							continue
						}
						if r.PlatformStatus(pl.Platform) != "published" {
							cand.OtherPendingTargets = append(cand.OtherPendingTargets, firstNonEmptyStr(c.Title, inst.Title, inst.Component)+" "+inst.Version)
						}
					}
				}
			}
		}
		out = append(out, *cand)
	}
	sort.Slice(out, func(i, j int) bool {
		// Prioritize dedicated verification deliveries, then non-stale, then newest.
		if (out[i].Purpose == "verification") != (out[j].Purpose == "verification") {
			return out[i].Purpose == "verification"
		}
		if out[i].Stale != out[j].Stale {
			return !out[i].Stale
		}
		return out[i].CompletedAt > out[j].CompletedAt
	})
	if len(out) > 40 {
		out = out[:40]
	}
	return out
}

// jobPromotionTargets computes which component versions/OSes inside a passing delivery can be promoted/unlocked right now.
func (s *storeServer) jobPromotionTargets(j storeJob, user string) []jobPromoteTarget {
	if !s.can(user, "component.publish") || j.State != "succeeded" || j.Outcome == outcomeVoid || j.Outcome == outcomeFailed || j.DeliveryMode == "configuration" {
		return nil
	}
	rawPlan := s.readJobPlanRaw(j.ID)
	if len(rawPlan) == 0 {
		return nil
	}
	var pl jobPlanLite
	if json.Unmarshal(rawPlan, &pl) != nil || pl.DeliveryMode == "configuration" {
		return nil
	}
	executionMu.Lock()
	execDB, execErr := s.readExecutions()
	executionMu.Unlock()
	var dbPtr *executionDB
	if execErr == nil {
		dbPtr = &execDB
	}
	cat := s.plat.cat()
	out := []jobPromoteTarget{}
	seen := map[string]bool{}
	for _, inst := range pl.Instances {
		key := inst.Component + "\x00" + inst.Version
		if seen[key] {
			continue
		}
		seen[key] = true
		c, ok := cat.Get(inst.Component)
		if !ok || c.Kind == "external" {
			continue
		}
		r, err := c.Resolve(inst.Version)
		if err != nil {
			continue
		}
		cand, _, reason := s.evalVerificationJobFast(j, inst.Component, inst.Version, pl.Platform, rawPlan, dbPtr)
		if reason != "" || cand == nil {
			continue
		}
		plStatus := r.PlatformStatus(pl.Platform)
		recs := s.enrichVerifications(inst.Component, s.loadCompVerifications(inst.Component))
		alreadyRecorded := false
		latestStale := false
		for _, rec := range recs {
			if rec.Version == inst.Version && rec.Platform == pl.Platform {
				if rec.JobID == j.ID {
					alreadyRecorded = true
				}
				if !latestStale && rec.Stale {
					latestStale = true
				}
			}
		}
		needsUnlock := plStatus != "published"
		// Surface banner if:
		//  1) this component+OS isn't unlocked/published yet, OR
		//  2) this is a dedicated verification delivery and this run hasn't been recorded yet, OR
		//  3) existing verification for this OS is stale after playbook edits.
		if !needsUnlock && !(j.Purpose == "verification" && !alreadyRecorded) && !latestStale {
			continue
		}
		out = append(out, jobPromoteTarget{
			Component:       inst.Component,
			ComponentTitle:  firstNonEmptyStr(c.Title, inst.Title, inst.Component),
			Version:         inst.Version,
			Platform:        pl.Platform,
			PlatformName:    cand.PlatformName,
			CurrentStatus:   plStatus,
			NeedsUnlock:     needsUnlock,
			Stale:           latestStale,
			AlreadyRecorded: alreadyRecorded,
			DeliveryMode:    cand.DeliveryMode,
			PassedSteps:     cand.PassedSteps,
			TotalSteps:      cand.TotalSteps,
			DurationSec:     cand.DurationSec,
			Executor:        cand.Executor,
		})
	}
	return out
}

func (s *storeServer) getCompVerifications(w http.ResponseWriter, r *http.Request, session storeSession, name string) {
	if !safeName(name) {
		s.fail(w, 400, "组件名无效")
		return
	}
	compVerifyMu.Lock()
	recs := s.loadCompVerifications(name)
	compVerifyMu.Unlock()
	enriched := s.enrichVerifications(name, recs)
	s.writeJSON(w, 200, map[string]any{
		"current_manifest": s.currentManifestHash(name),
		"records":          enriched,
		"candidates":       []verificationCandidate{},
	})
}

func (s *storeServer) deleteCompVerification(w http.ResponseWriter, r *http.Request, session storeSession, name, recID string) {
	if !s.need(w, session.User, "component.publish") {
		return
	}
	if !safeName(name) || strings.TrimSpace(recID) == "" {
		s.fail(w, 400, "参数无效")
		return
	}
	compVerifyMu.Lock()
	list := s.loadCompVerifications(name)
	kept := make([]compVerification, 0, len(list))
	removed := false
	for _, item := range list {
		if item.ID == recID {
			removed = true
			continue
		}
		kept = append(kept, item)
	}
	var saveErr error
	if removed {
		saveErr = s.saveCompVerifications(name, kept)
	}
	compVerifyMu.Unlock()
	if !removed {
		s.fail(w, 404, "找不到该验证凭证")
		return
	}
	if saveErr != nil {
		s.fail(w, 500, "删除验证凭证失败")
		return
	}
	s.auditReq(r, "component-verification-delete", session.User, name+" "+recID)
	s.writeJSON(w, 200, map[string]bool{"ok": true})
}

// mutateVersionYAMLNode updates `status` and `verified_platforms` on a target version entry inside raw YAML bytes
// while preserving comments, formatting style, and unrelated files.
func mutateVersionYAMLNode(raw []byte, ver, newStatus string, addPlatforms []string, revokePlatform string, allPlatforms []string) ([]byte, bool, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil || len(doc.Content) == 0 {
		return nil, false, fmt.Errorf("无法解析版本清单 YAML")
	}
	root := doc.Content[0]
	var list *yaml.Node
	switch root.Kind {
	case yaml.SequenceNode:
		list = root
	case yaml.MappingNode:
		for i := 0; i+1 < len(root.Content); i += 2 {
			if root.Content[i].Value == "versions" && root.Content[i+1].Kind == yaml.SequenceNode {
				list = root.Content[i+1]
				break
			}
		}
	}
	if list == nil {
		return nil, false, fmt.Errorf("找不到 versions 列表")
	}
	var target *yaml.Node
	for _, item := range list.Content {
		if item.Kind != yaml.MappingNode {
			continue
		}
		for i := 0; i+1 < len(item.Content); i += 2 {
			if item.Content[i].Value == "id" && item.Content[i+1].Value == ver {
				target = item
				break
			}
		}
		if target != nil {
			break
		}
	}
	if target == nil {
		return nil, false, fmt.Errorf("找不到版本 %s", ver)
	}

	getKeyIdx := func(k string) int {
		for i := 0; i+1 < len(target.Content); i += 2 {
			if target.Content[i].Value == k {
				return i
			}
		}
		return -1
	}
	setScalar := func(k, val string) bool {
		idx := getKeyIdx(k)
		if idx >= 0 {
			if target.Content[idx+1].Value == val {
				return false
			}
			target.Content[idx+1].Value = val
			target.Content[idx+1].Tag = "!!str"
			target.Content[idx+1].Style = 0
			return true
		}
		kNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: k}
		vNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: val}
		target.Content = append(target.Content, kNode, vNode)
		return true
	}
	removeKey := func(k string) bool {
		idx := getKeyIdx(k)
		if idx < 0 {
			return false
		}
		target.Content = append(target.Content[:idx], target.Content[idx+2:]...)
		return true
	}
	readSeq := func(k string) []string {
		idx := getKeyIdx(k)
		if idx < 0 || target.Content[idx+1].Kind != yaml.SequenceNode {
			return nil
		}
		var out []string
		for _, n := range target.Content[idx+1].Content {
			if n.Value != "" {
				out = append(out, n.Value)
			}
		}
		return out
	}
	writeSeq := func(k string, vals []string) {
		seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Style: yaml.FlowStyle}
		for _, v := range vals {
			seq.Content = append(seq.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v})
		}
		idx := getKeyIdx(k)
		if idx >= 0 {
			target.Content[idx+1] = seq
			return
		}
		// Insert right after status if present for clean readability.
		kNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: k}
		if sIdx := getKeyIdx("status"); sIdx >= 0 {
			pos := sIdx + 2
			tail := append([]*yaml.Node{kNode, seq}, target.Content[pos:]...)
			target.Content = append(target.Content[:pos], tail...)
			return
		}
		target.Content = append(target.Content, kNode, seq)
	}

	changed := false
	curStatus := ""
	if sIdx := getKeyIdx("status"); sIdx >= 0 {
		curStatus = target.Content[sIdx+1].Value
	}

	if revokePlatform != "" {
		curVP := readSeq("verified_platforms")
		if len(curVP) == 0 && curStatus == "published" && len(allPlatforms) > 0 {
			curVP = append([]string(nil), allPlatforms...)
		}
		nextVP := []string{}
		for _, p := range curVP {
			if p != revokePlatform {
				nextVP = append(nextVP, p)
			}
		}
		if len(nextVP) != len(curVP) {
			changed = true
		}
		if len(nextVP) == 0 {
			if removeKey("verified_platforms") {
				changed = true
			}
			if setScalar("status", "draft") {
				changed = true
			}
		} else {
			writeSeq("verified_platforms", nextVP)
		}
	} else if newStatus == "published" {
		if setScalar("status", "published") {
			changed = true
		}
		if len(addPlatforms) > 0 {
			curVP := readSeq("verified_platforms")
			addedAny := false
			for _, addPlatform := range addPlatforms {
				if addPlatform == "" {
					continue
				}
				has := false
				for _, p := range curVP {
					if p == addPlatform {
						has = true
						break
					}
				}
				if !has {
					curVP = append(curVP, addPlatform)
					addedAny = true
				}
			}
			if addedAny {
				writeSeq("verified_platforms", curVP)
				changed = true
			}
		}
	} else {
		if setScalar("status", newStatus) {
			changed = true
		}
		if removeKey("verified_platforms") {
			changed = true
		}
	}

	if !changed {
		return raw, false, nil
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return nil, false, err
	}
	_ = enc.Close()
	return buf.Bytes(), true, nil
}

// migrateComponentLifecycle performs a one-time, idempotent migration on existing live Hub data:
//  1. Fixes stale "verifying"/"draft" instance statuses in existing jobs' plan.json snapshots when the catalog
//     component+version+OS is now published (preserving all jobs and deleting nothing).
//  2. Extracts structured Ubuntu 24.04 verification evidence from existing passing deliveries (preferring verify-*)
//     and archives them under <DataDir>/comp-verifications/<comp>.json so the component pages show real history immediately.
func (s *storeServer) migrateComponentLifecycle() {
	if s.plat == nil || len(s.jobs) == 0 {
		return
	}
	const migKey = "comp_lifecycle_v1"
	marker := ""
	if s.repo != nil {
		if s.repo.hasMigration(migKey) {
			return
		}
	} else {
		if s.cfg.DataDir == "" {
			return
		}
		marker = filepath.Join(s.cfg.DataDir, "comp-verifications", ".migrated-v1")
		if _, err := os.Stat(marker); err == nil {
			return
		}
	}
	cat := s.plat.cat()

	// Step 1: Normalize existing jobs' plan.json snapshots so already-published versions don't stay labeled "待验证".
	s.mu.Lock()
	allJobs := make([]storeJob, 0, len(s.jobs))
	for _, j := range s.jobs {
		allJobs = append(allJobs, j)
	}
	s.mu.Unlock()

	for _, j := range allJobs {
		b, err := s.readJobPlanBytes(j.ID)
		if err != nil {
			continue
		}
		var doc map[string]any
		if json.Unmarshal(b, &doc) != nil {
			continue
		}
		platformID, _ := doc["platform"].(string)
		insts, ok := doc["instances"].([]any)
		if !ok {
			continue
		}
		changed := false
		publishedTitles := map[string]bool{}
		for _, rawInst := range insts {
			m, ok := rawInst.(map[string]any)
			if !ok {
				continue
			}
			compName, _ := m["component"].(string)
			verID, _ := m["version"].(string)
			curSt, _ := m["status"].(string)
			c, ok := cat.Get(compName)
			if !ok {
				continue
			}
			r, err := c.Resolve(verID)
			if err != nil {
				continue
			}
			if r.PlatformStatus(platformID) == "published" {
				publishedTitles[c.Title+" "+verID] = true
				if curSt != "published" {
					m["status"] = "published"
					changed = true
				}
			}
		}
		if warns, ok := doc["warnings"].([]any); ok && len(publishedTitles) > 0 {
			filtered := make([]any, 0, len(warns))
			for _, w := range warns {
				wm, _ := w.(map[string]any)
				msg, _ := wm["message"].(string)
				drop := false
				if strings.Contains(msg, "不要用于生产") {
					for k := range publishedTitles {
						if strings.Contains(msg, k) {
							drop = true
							break
						}
					}
				}
				if drop {
					changed = true
					continue
				}
				filtered = append(filtered, w)
			}
			if changed {
				doc["warnings"] = filtered
			}
		}
		if changed {
			if out, err := json.MarshalIndent(doc, "", "  "); err == nil {
				_ = s.writeJobPlanAndLock(j.ID, j.ClusterID, out, nil)
			}
		}
	}

	// Step 2: Backfill initial structured verification evidence for published components from passing deliveries.
	sort.Slice(allJobs, func(i, j int) bool {
		iv := strings.HasPrefix(allJobs[i].ClusterID, "verify-")
		jv := strings.HasPrefix(allJobs[j].ClusterID, "verify-")
		if iv != jv {
			return iv
		}
		ia := strings.HasPrefix(allJobs[i].ClusterID, "auto-")
		ja := strings.HasPrefix(allJobs[j].ClusterID, "auto-")
		if ia != ja {
			return ia
		}
		return allJobs[i].Created > allJobs[j].Created
	})
	for _, info := range cat.Infos() {
		if info.Kind == "external" {
			continue
		}
		existing := s.loadCompVerifications(info.Name)
		hasKey := map[string]bool{}
		for _, r := range existing {
			hasKey[r.Version+"\x00"+r.Platform] = true
		}
		for _, v := range info.Versions {
			if v.Status != "published" {
				continue
			}
			for _, pl := range v.VerifiedPlatforms {
				if hasKey[v.ID+"\x00"+pl] {
					continue
				}
				for _, j := range allJobs {
					cand, reason := s.evalVerificationJob(j, info.Name, v.ID, pl)
					if reason != "" || cand == nil {
						continue
					}
					rec := compVerification{
						ID:           randomStoreToken(6),
						Component:    info.Name,
						Version:      v.ID,
						Platform:     pl,
						PlatformName: cand.PlatformName,
						JobID:        cand.JobID,
						ClusterID:    cand.ClusterID,
						DeliveryMode: cand.DeliveryMode,
						SchemeName:   cand.SchemeName,
						Topology:     cand.Topology,
						Hosts:        cand.Hosts,
						PassedSteps:  cand.PassedSteps,
						TotalSteps:   cand.TotalSteps,
						DurationSec:  cand.DurationSec,
						Executor:     cand.Executor,
						ManifestHash: s.currentManifestHash(info.Name),
						VerifiedBy:   firstNonEmptyStr(cand.Owner, "admin"),
						VerifiedAt:   cand.CompletedAt,
						Note:         "存量实测验证记录自动归档",
					}
					_ = s.appendCompVerification(rec)
					hasKey[v.ID+"\x00"+pl] = true
					break
				}
			}
		}
	}
	if s.repo != nil {
		_ = s.repo.recordMigration(migKey, map[string]any{"done": true})
	} else if marker != "" {
		_ = os.MkdirAll(filepath.Dir(marker), 0o700)
		_ = os.WriteFile(marker, []byte(now()+"\n"), 0o600)
	}
}

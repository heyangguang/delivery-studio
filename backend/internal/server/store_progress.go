package server

import (
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
	"strings"
	"time"

	"delivery-studio/mwpack"
)

// The execution record of a delivery: what happened on site, step by step. The platform never connects to the
// machines, so this is what the person following the runbook writes down — done, failed or skipped, a note, and the
// output they pasted. It lives beside the delivery's files and is shared by everyone who can open the delivery, so it
// does not depend on one browser.

const (
	maxStepLog     = 64 << 10
	maxProgressDoc = 3 << 20
	maxEvents      = 400
	maxStepImages  = 8
	maxImageBytes  = 4 << 20
	maxDeliveryImg = 300
)

type stepAttempt struct {
	Execution string     `json:"execution"`
	Attempt   string     `json:"attempt"`
	RunIndex  int        `json:"run_index,omitempty"`
	State     string     `json:"state"` // done | failed | skipped | running | unknown | blocked | ...
	AutoState string     `json:"auto_state,omitempty"`
	Executor  string     `json:"executor,omitempty"`
	By        string     `json:"by,omitempty"`
	Started   string     `json:"started,omitempty"`
	Finished  string     `json:"finished,omitempty"`
	At        string     `json:"at,omitempty"`
	ExitCode  *int       `json:"exit_code,omitempty"`
	Message   string     `json:"message,omitempty"`
	Recap     []logRecap `json:"recap,omitempty"`
	LogSeq    int        `json:"log_seq,omitempty"`
	Snapshot  string     `json:"snapshot,omitempty"`
	Outdated  bool       `json:"outdated,omitempty"`
}

type stepRecord struct {
	Source    string        `json:"source,omitempty"`
	Execution string        `json:"execution,omitempty"`
	Attempt   string        `json:"attempt,omitempty"`
	AutoState string        `json:"auto_state,omitempty"`
	Executor  string        `json:"executor,omitempty"`
	Started   string        `json:"started,omitempty"`
	Finished  string        `json:"finished,omitempty"`
	ExitCode  *int          `json:"exit_code,omitempty"`
	Recap     []logRecap    `json:"recap,omitempty"`
	LogSeq    int           `json:"log_seq,omitempty"`
	State     string        `json:"state"` // done | failed | skipped | resolved (a problem came up and was solved); empty: no result marked, what was written is kept
	By        string        `json:"by"`
	At        string        `json:"at"`
	Note      string        `json:"note,omitempty"`
	Log       string        `json:"log,omitempty"`
	// Images are screenshots pasted or dropped next to the output, as file names under the delivery's progress-img.
	Images []string `json:"images,omitempty"`
	// Attempts is populated dynamically from immutable execution runs on GET (never persisted into progress.json).
	Attempts []stepAttempt `json:"attempts,omitempty"`
}

type progressEvent struct {
	At        string     `json:"at"`
	By        string     `json:"by"`
	Key       string     `json:"key"`
	Title     string     `json:"title,omitempty"`
	State     string     `json:"state"` // "" means the record was cleared
	Source    string     `json:"source,omitempty"`
	Execution string     `json:"execution,omitempty"`
	Attempt   string     `json:"attempt,omitempty"`
	Note      string     `json:"note,omitempty"`
	Started   string     `json:"started,omitempty"`
	Finished  string     `json:"finished,omitempty"`
	ExitCode  *int       `json:"exit_code,omitempty"`
	Recap     []logRecap `json:"recap,omitempty"`
	LogSeq    int        `json:"log_seq,omitempty"`
	Executor  string     `json:"executor,omitempty"`
	Snapshot  string     `json:"snapshot,omitempty"`
}

type progressDoc struct {
	Steps  map[string]stepRecord `json:"steps"`
	Events []progressEvent       `json:"events"`
	// Reports are the write-ups of problems solved with the assistant (see ai_chat.go).
	Reports []aiReport `json:"reports,omitempty"`
	// Superseded are the versions of a step a sync replaced, with what was recorded against them (see store_sync.go).
	Superseded map[string][]supersededRecord `json:"superseded,omitempty"`
}

func (s *storeServer) progressPath(id string) string {
	return filepath.Join(s.jobDir(id), "progress.json")
}

func (s *storeServer) readProgress(id string) progressDoc {
	doc := progressDoc{Steps: map[string]stepRecord{}, Events: []progressEvent{}}
	if b, err := os.ReadFile(s.progressPath(id)); err == nil {
		_ = json.Unmarshal(b, &doc)
	}
	if doc.Steps == nil {
		doc.Steps = map[string]stepRecord{}
	}
	if doc.Events == nil {
		doc.Events = []progressEvent{}
	}
	return doc
}

func (s *storeServer) writeProgress(id string, doc progressDoc) error {
	if len(doc.Steps) > 0 {
		clean := make(map[string]stepRecord, len(doc.Steps))
		for k, st := range doc.Steps {
			st.Attempts = nil
			clean[k] = st
		}
		doc.Steps = clean
	}
	b, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	if len(b) > maxProgressDoc {
		return errProgressFull
	}
	tmp := s.progressPath(id) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.progressPath(id))
}

type progressError string

func (e progressError) Error() string { return string(e) }

const errProgressFull = progressError("执行记录太大了（超过 3 MiB），请清理较长的输出")

var (
	reSyncEventTitle  = regexp.MustCompile(`^按最新组件同步（第 (\d+) 次）：(\d+) 个文件、(\d+) 个步骤有变化$`)
	rePatchEventTitle = regexp.MustCompile(`^修改了交付的自动化文件 (.+)$`)
)

func localizeProgressTitle(lang, title string) string {
	if !isEnLang(lang) || title == "" {
		return title
	}
	if m := reSyncEventTitle.FindStringSubmatch(title); m != nil {
		return fmt.Sprintf("Synced with latest components (#%s): %s file(s), %s step(s) changed", m[1], m[2], m[3])
	}
	if m := rePatchEventTitle.FindStringSubmatch(title); m != nil {
		return "Modified delivery automation file " + m[1]
	}
	if sec, rest, ok := strings.Cut(title, " · "); ok {
		secEn := map[string]string{
			"部署":    "Deploy",
			"环境准备":  "Prepare",
			"功能测试":  "Functional Tests",
			"入口测试":  "Endpoint Tests",
			"清理":    "Cleanup",
			"变更后检查": "Post-change Checks",
			"执行":    "Run",
		}[strings.TrimSpace(sec)]
		if secEn == "" {
			secEn = mwpack.TranslateCatalogText(lang, strings.TrimSpace(sec))
		}
		return secEn + " · " + mwpack.TranslateCatalogText(lang, strings.TrimSpace(rest))
	}
	if out := mwpack.TranslateCatalogText(lang, title); out != title {
		return out
	}
	return localizeGoMessage(lang, title)
}

func localizeProgressDoc(lang string, doc progressDoc) progressDoc {
	if !isEnLang(lang) {
		return doc
	}
	if len(doc.Steps) > 0 {
		steps := make(map[string]stepRecord, len(doc.Steps))
		for k, st := range doc.Steps {
			if st.By == "执行节点" {
				st.By = "Execution node"
			}
			if st.Note != "" {
				st.Note = localizeGoMessage(lang, st.Note)
			}
			if len(st.Attempts) > 0 {
				atts := make([]stepAttempt, len(st.Attempts))
				for i, a := range st.Attempts {
					if a.By == "执行节点" {
						a.By = "Execution node"
					}
					if a.Message != "" {
						a.Message = localizeGoMessage(lang, a.Message)
					}
					atts[i] = a
				}
				st.Attempts = atts
			}
			steps[k] = st
		}
		doc.Steps = steps
	}
	if len(doc.Events) > 0 {
		evs := make([]progressEvent, len(doc.Events))
		for i, ev := range doc.Events {
			ev.Title = localizeProgressTitle(lang, ev.Title)
			if ev.By == "执行节点" {
				ev.By = "Execution node"
			}
			if ev.Note != "" {
				ev.Note = localizeGoMessage(lang, ev.Note)
			}
			evs[i] = ev
		}
		doc.Events = evs
	}
	if len(doc.Superseded) > 0 {
		sup := make(map[string][]supersededRecord, len(doc.Superseded))
		for k, list := range doc.Superseded {
			cp := make([]supersededRecord, len(list))
			for i, r := range list {
				r.Title = localizeProgressTitle(lang, r.Title)
				cp[i] = r
			}
			sup[k] = cp
		}
		doc.Superseded = sup
	}
	return doc
}

func formatPreparationLog(p executionPreparation) string {
	var b strings.Builder
	for _, c := range p.Checks {
		status := "PASSED"
		if c.State != "passed" {
			status = strings.ToUpper(c.State)
		}
		target := c.Host
		if target == "" {
			target = c.ID
		}
		fmt.Fprintf(&b, "[%s] %s (%s): %s\n", status, c.Title, target, c.Message)
	}
	return strings.TrimRight(b.String(), "\n")
}

func mapAutoStepState(state string) string {
	switch state {
	case "succeeded":
		return "done"
	case "failed", "interrupted":
		return "failed"
	case "skipped":
		return "skipped"
	default:
		return state
	}
}

func (s *storeServer) enrichProgressWithExecutions(id string, doc progressDoc) progressDoc {
	executionMu.Lock()
	d, err := s.readExecutions()
	executionMu.Unlock()
	if err != nil {
		return doc
	}
	return s.enrichProgressWithExecutionDB(id, doc, d, nil)
}

func (s *storeServer) enrichProgressWithExecutionDB(id string, doc progressDoc, d executionDB, tabs []reportTab) progressDoc {
	rev := s.executionRevision(id)
	steps := make(map[string]stepRecord, len(doc.Steps))
	for k, v := range doc.Steps {
		steps[k] = v
	}

	// 1. Reflect verified ready preparation checks onto unrecorded prep/bootstrap steps
	// (handles both live deliveries and existing deliveries completed before persistence).
	var latestPrep *executionPreparation
	for _, p := range d.Preparations {
		if p.Job != id || p.State != "ready" || (p.Revision != "" && p.Revision != rev) {
			continue
		}
		if latestPrep == nil || p.Finished > latestPrep.Finished {
			cp := p
			latestPrep = &cp
		}
	}
	if latestPrep != nil {
		prepLog := formatPreparationLog(*latestPrep)
		execName := latestPrep.ExecutorName
		if tabs == nil {
			tabs = s.runbookSteps(id)
		}
		for _, tab := range tabs {
			for _, st := range tab.Steps {
				if !strings.HasPrefix(st.Key, "prepare/") && st.Key != "deploy/deploy-bootstrap" {
					continue
				}
				if steps[st.Key].State != "" {
					continue
				}
				steps[st.Key] = stepRecord{
					Source:   "automatic",
					Executor: execName,
					State:    "done",
					By:       "执行节点",
					At:       firstNonEmptyStr(latestPrep.Finished, latestPrep.Created),
					Note:     "已通过执行准备检查核验",
					Log:      prepLog,
				}
			}
		}
	}

	// 2. Collect ALL immutable execution runs for this delivery (across all sync revisions)
	// so every historical attempt (including earlier failed attempts) stays inspectable with full logs.
	allRuns := []executionRun{}
	for _, r := range d.Runs {
		if r.Job == id {
			allRuns = append(allRuns, r)
		}
	}
	sort.Slice(allRuns, func(i, j int) bool { return allRuns[i].Created < allRuns[j].Created })

	type attemptMeta struct {
		key   string
		title string
		att   stepAttempt
	}
	attemptsByKey := map[string][]stepAttempt{}
	allAttempts := []attemptMeta{}

	for runIdx, run := range allRuns {
		isCurrentRev := run.Revision == "" || run.Revision == rev
		for _, st := range run.Steps {
			ts := firstNonEmptyStr(st.Returned, st.Finished, st.Started, run.Updated, run.Created)
			// Skip steps that never started because an earlier step halted the batch.
			neverStarted := st.State == "pending" && st.Started == "" && st.Finished == "" && st.Seq == 0
			if !neverStarted {
				att := stepAttempt{
					Execution: run.ID,
					Attempt:   st.ID,
					RunIndex:  runIdx + 1,
					State:     mapAutoStepState(st.State),
					AutoState: st.State,
					Executor:  run.ExecutorName,
					By:        firstNonEmptyStr(run.By, "执行节点"),
					Started:   st.Started,
					Finished:  st.Finished,
					At:        ts,
					ExitCode:  st.ExitCode,
					Message:   st.Message,
					Recap:     st.Recap,
					LogSeq:    st.Seq,
					Snapshot:  run.Snapshot,
					Outdated:  !isCurrentRev,
				}
				attemptsByKey[st.Key] = append(attemptsByKey[st.Key], att)
				allAttempts = append(allAttempts, attemptMeta{key: st.Key, title: st.Title, att: att})
			}

			// Only current-revision runs project onto the active step state.
			if !isCurrentRev {
				continue
			}
			rec := steps[st.Key]
			if neverStarted && rec.State != "" {
				continue
			}
			// Respect a newer manual record for State/Note, while still attaching automated evidence metadata if it matches.
			manualNewer := rec.Source != "automatic" && rec.State != "" && rec.At > ts && st.State != "running" && st.State != "leased" && st.State != "queued" && st.State != "unknown"
			if manualNewer {
				continue
			}
			rec.Execution = run.ID
			rec.Attempt = st.ID
			rec.AutoState = st.State
			rec.Executor = firstNonEmptyStr(run.ExecutorName, rec.Executor)
			rec.Started = st.Started
			rec.Finished = st.Finished
			rec.ExitCode = st.ExitCode
			rec.Recap = st.Recap
			rec.LogSeq = st.Seq
			if rec.Source == "" || rec.Source == "automatic" || st.State == "running" || st.State == "leased" || st.State == "queued" || st.State == "unknown" {
				rec.Source = "automatic"
				rec.By = "执行节点"
				if ts != "" {
					rec.At = ts
				}
				if st.Message != "" {
					rec.Note = st.Message
				}
				if mapped := map[string]string{"succeeded": "done", "failed": "failed", "skipped": "skipped", "interrupted": "failed"}[st.State]; mapped != "" {
					rec.State = mapped
				}
			}
			steps[st.Key] = rec
		}
	}

	for key, list := range attemptsByKey {
		rec := steps[key]
		rec.Attempts = list
		steps[key] = rec
	}

	// 3. Enrich existing progress events with execution/attempt/log references and backfill any
	// historical automated attempts not yet present in doc.Events (e.g. from older runs).
	evs := make([]progressEvent, len(doc.Events))
	copy(evs, doc.Events)
	usedAttempt := make(map[string]bool, len(allAttempts))
	byAttemptID := make(map[string]attemptMeta, len(allAttempts))
	for _, am := range allAttempts {
		byAttemptID[am.att.Attempt] = am
	}
	for i := range evs {
		ev := &evs[i]
		if ev.Source == "" && (ev.Key == "_sync" || reSyncEventTitle.MatchString(ev.Title) || rePatchEventTitle.MatchString(ev.Title)) {
			ev.Source = "sync"
		}
		if ev.Attempt != "" {
			usedAttempt[ev.Attempt] = true
			if am, ok := byAttemptID[ev.Attempt]; ok {
				ev.Source = "automatic"
				ev.Execution = firstNonEmptyStr(ev.Execution, am.att.Execution)
				ev.Note = firstNonEmptyStr(ev.Note, am.att.Message)
				ev.Started = firstNonEmptyStr(ev.Started, am.att.Started)
				ev.Finished = firstNonEmptyStr(ev.Finished, am.att.Finished)
				if ev.ExitCode == nil {
					ev.ExitCode = am.att.ExitCode
				}
				if len(ev.Recap) == 0 {
					ev.Recap = am.att.Recap
				}
				if ev.LogSeq == 0 {
					ev.LogSeq = am.att.LogSeq
				}
				ev.Executor = firstNonEmptyStr(ev.Executor, am.att.Executor)
				ev.Snapshot = firstNonEmptyStr(ev.Snapshot, am.att.Snapshot)
			}
			continue
		}
		if ev.By != "执行节点" && ev.By != "Execution node" {
			continue
		}
		for _, am := range allAttempts {
			if usedAttempt[am.att.Attempt] || am.key != ev.Key || am.att.State != ev.State {
				continue
			}
			if ev.At == am.att.Finished || ev.At == am.att.At || (ev.At != "" && strings.HasPrefix(am.att.At, ev.At[:min(len(ev.At), 19)])) {
				usedAttempt[am.att.Attempt] = true
				ev.Source = "automatic"
				ev.Execution = am.att.Execution
				ev.Attempt = am.att.Attempt
				ev.Note = am.att.Message
				ev.Started = am.att.Started
				ev.Finished = am.att.Finished
				ev.ExitCode = am.att.ExitCode
				ev.Recap = am.att.Recap
				ev.LogSeq = am.att.LogSeq
				ev.Executor = am.att.Executor
				ev.Snapshot = am.att.Snapshot
				break
			}
		}
	}
	addedBackfill := false
	for _, am := range allAttempts {
		if usedAttempt[am.att.Attempt] {
			continue
		}
		if am.att.State != "done" && am.att.State != "failed" && am.att.State != "skipped" && am.att.State != "blocked" && am.att.State != "unknown" {
			continue
		}
		evs = append(evs, progressEvent{
			At:        firstNonEmptyStr(am.att.Finished, am.att.At),
			By:        "执行节点",
			Key:       am.key,
			Title:     am.title,
			State:     am.att.State,
			Source:    "automatic",
			Execution: am.att.Execution,
			Attempt:   am.att.Attempt,
			Note:      am.att.Message,
			Started:   am.att.Started,
			Finished:  am.att.Finished,
			ExitCode:  am.att.ExitCode,
			Recap:     am.att.Recap,
			LogSeq:    am.att.LogSeq,
			Executor:  am.att.Executor,
			Snapshot:  am.att.Snapshot,
		})
		addedBackfill = true
	}
	if addedBackfill {
		sort.SliceStable(evs, func(i, j int) bool { return evs[i].At < evs[j].At })
	}

	doc.Steps = steps
	doc.Events = evs
	return doc
}

// handleProgress serves /api/jobs/{id}/progress for a delivery whose files exist.
func (s *storeServer) handleProgress(w http.ResponseWriter, r *http.Request, session storeSession, id string) {
	switch r.Method {
	case "GET":
		s.mu.Lock()
		doc := s.readProgress(id)
		s.mu.Unlock()
		doc = s.enrichProgressWithExecutions(id, doc)
		doc = localizeProgressDoc(wLang(w), doc)
		s.writeJSON(w, 200, map[string]any{"steps": doc.Steps, "events": doc.Events, "reports": doc.Reports, "amendments": s.loadAmendments(id), "superseded": doc.Superseded})
	case "PUT":
		var body struct {
			Key    string   `json:"key"`
			Title  string   `json:"title"`
			State  string   `json:"state"`
			Note   string   `json:"note"`
			Log    string   `json:"log"`
			Images []string `json:"images"`
			Total  int      `json:"total"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxStepLog+(32<<10))).Decode(&body); err != nil {
			s.fail(w, 400, "提交的内容有问题，或者输出超过了 64 KiB")
			return
		}
		if body.Key == "" || len(body.Key) > 120 || strings.ContainsAny(body.Key, "\x00\n") {
			s.fail(w, 400, "找不到这个步骤")
			return
		}
		if body.State != "" && body.State != "done" && body.State != "failed" && body.State != "skipped" && body.State != "resolved" {
			s.fail(w, 400, "状态只能是完成、失败、跳过或遇到问题已解决")
			return
		}
		if len(body.Log) > maxStepLog || len([]rune(body.Note)) > 500 {
			s.fail(w, 400, "说明最多 500 字，输出最多 64 KiB")
			return
		}
		if len(body.Images) > maxStepImages {
			s.fail(w, 400, "每一步最多附 8 张图片")
			return
		}
		for _, n := range body.Images {
			if !reProgressImg.MatchString(n) {
				s.fail(w, 400, "图片不存在，请重新上传")
				return
			}
			if _, err := os.Stat(filepath.Join(s.progressImgDir(id), n)); err != nil {
				s.fail(w, 400, "图片不存在，请重新上传")
				return
			}
		}
		now := time.Now().UTC().Format(time.RFC3339)
		s.mu.Lock()
		defer s.mu.Unlock()
		doc := s.readProgress(id)
		if body.State == "" {
			// taking the result back does not take away what was written down: the output, the note, the pictures stay
			if old, ok := doc.Steps[body.Key]; ok && (old.Note != "" || old.Log != "" || len(old.Images) > 0) {
				old.State, old.By, old.At = "", session.User, now
				doc.Steps[body.Key] = old
			} else {
				delete(doc.Steps, body.Key)
			}
		} else {
			doc.Steps[body.Key] = stepRecord{State: body.State, By: session.User, At: now, Note: strings.TrimSpace(body.Note), Log: body.Log, Images: body.Images}
		}
		defer s.sweepProgressImages(id, doc)
		doc.Events = append(doc.Events, progressEvent{At: now, By: session.User, Key: body.Key, Title: truncRunes(body.Title, 120), State: body.State})
		if len(doc.Events) > maxEvents {
			doc.Events = doc.Events[len(doc.Events)-maxEvents:]
		}
		if err := s.writeProgress(id, doc); err != nil {
			if err == errProgressFull {
				s.fail(w, 413, err.Error())
				return
			}
			s.fail(w, 500, "执行记录无法保存")
			return
		}
		go s.auditReq(r, "job-step", session.User, id+" "+truncRunes(body.Title, 60)+" "+map[string]string{"": "清除", "done": "完成", "failed": "失败", "skipped": "跳过", "resolved": "遇到问题已解决"}[body.State])
		// the list shows how far each delivery is without opening every record
		cur := s.jobs[id]
		cur.RunDone, cur.RunFailed = countSteps(doc)
		if body.Total > 0 && body.Total <= 1000 {
			cur.RunTotal = body.Total
		}
		if err := s.persistJob(cur); err == nil {
			s.jobs[id] = cur
		}
		s.writeJSON(w, 200, doc)
	case "DELETE":
		// by default only the results are cleared; what people wrote and attached stays. ?all=1 removes everything.
		everything := r.URL.Query().Get("all") == "1"
		s.mu.Lock()
		doc := s.readProgress(id)
		if everything {
			_ = os.Remove(s.progressPath(id))
			_ = os.RemoveAll(s.progressImgDir(id))
			_ = os.RemoveAll(s.runLogDir(id))
			doc = progressDoc{Steps: map[string]stepRecord{}, Events: []progressEvent{}}
		} else {
			now := time.Now().UTC().Format(time.RFC3339)
			for k, rec := range doc.Steps {
				if rec.Note == "" && rec.Log == "" && len(rec.Images) == 0 {
					delete(doc.Steps, k)
					continue
				}
				rec.State, rec.At, rec.By = "", now, session.User
				doc.Steps[k] = rec
			}
			_ = s.writeProgress(id, doc)
		}
		cur := s.jobs[id]
		cur.RunDone, cur.RunFailed = countSteps(doc)
		if err := s.persistJob(cur); err == nil {
			s.jobs[id] = cur
		}
		s.mu.Unlock() // audit takes the lock itself
		s.auditReq(r, "job-progress-clear", session.User, id+map[bool]string{true: " 全部删除", false: " 只清除结果"}[everything])
		s.writeJSON(w, 200, map[string]any{"steps": doc.Steps, "events": doc.Events, "reports": doc.Reports, "amendments": s.loadAmendments(id)})
	default:
		s.fail(w, 405, "方法不支持")
	}
}

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

var reProgressImg = regexp.MustCompile(`^[0-9a-f]{20}\.(png|jpg|gif|webp)$`)

func (s *storeServer) progressImgDir(id string) string {
	return filepath.Join(s.jobDir(id), "progress-img")
}

// sweepProgressImages removes the pictures no step refers to any more (a record was changed or cleared).
func (s *storeServer) sweepProgressImages(id string, doc progressDoc) {
	used := map[string]bool{}
	for _, r := range doc.Steps {
		for _, n := range r.Images {
			used[n] = true
		}
	}
	ents, err := os.ReadDir(s.progressImgDir(id))
	if err != nil {
		return
	}
	for _, e := range ents {
		if !used[e.Name()] {
			// a picture uploaded a moment ago belongs to a record that is still being written
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) < time.Hour {
				continue
			}
			_ = os.Remove(filepath.Join(s.progressImgDir(id), e.Name()))
		}
	}
}

// handleProgressImg serves /api/jobs/{id}/progress/img (POST a picture) and /img/{name} (GET it).
func (s *storeServer) handleProgressImg(w http.ResponseWriter, r *http.Request, session storeSession, id string, rest []string) {
	switch {
	case len(rest) == 0 && r.Method == "POST":
		var in struct {
			Data string `json:"data"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, maxImageBytes*4/3+4096)).Decode(&in) != nil {
			s.fail(w, 400, "图片不能超过 4 MiB")
			return
		}
		m := reDataImage.FindStringSubmatch(in.Data)
		if m == nil {
			s.fail(w, 400, "图片需要是 png、jpg、gif 或 webp")
			return
		}
		raw, err := base64.StdEncoding.DecodeString(in.Data[len(m[0]):])
		if err != nil || len(raw) > maxImageBytes || len(raw) == 0 {
			s.fail(w, 400, "图片无法读取，或超过 4 MiB")
			return
		}
		// what is stored must really be the picture it says it is
		want := map[string]string{"png": "image/png", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}[m[1]]
		if http.DetectContentType(raw) != want {
			s.fail(w, 400, "文件内容和图片格式不符")
			return
		}
		dir := s.progressImgDir(id)
		if ents, _ := os.ReadDir(dir); len(ents) >= maxDeliveryImg {
			s.fail(w, 413, "这份交付的图片已经很多了，请先清理不用的记录")
			return
		}
		h := sha256.Sum256(raw)
		ext := map[string]string{"jpeg": "jpg"}[m[1]]
		if ext == "" {
			ext = m[1]
		}
		name := hex.EncodeToString(h[:10]) + "." + ext
		if err := os.MkdirAll(dir, 0o700); err != nil || os.WriteFile(filepath.Join(dir, name), raw, 0o600) != nil {
			s.fail(w, 500, "图片无法保存")
			return
		}
		s.writeJSON(w, 201, map[string]string{"name": name})
	case len(rest) == 1 && r.Method == "GET":
		if !reProgressImg.MatchString(rest[0]) {
			s.fail(w, 404, "图片不存在")
			return
		}
		b, err := os.ReadFile(filepath.Join(s.progressImgDir(id), rest[0]))
		if err != nil {
			s.fail(w, 404, "图片不存在")
			return
		}
		w.Header().Set("Content-Type", http.DetectContentType(b))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'")
		w.Header().Set("Cache-Control", "private, max-age=86400")
		_, _ = w.Write(b)
	default:
		s.fail(w, 405, "方法不支持")
	}
}

// progressImage is a recorded picture's bytes; nil when it is gone.
func (s *storeServer) progressImage(job, name string) []byte {
	if !reProgressImg.MatchString(name) {
		return nil
	}
	b, _ := os.ReadFile(filepath.Join(s.progressImgDir(job), name))
	return b
}

// countSteps is how many steps are done (or skipped, or done after a problem was solved) and how many failed.
func countSteps(doc progressDoc) (done, failed int) {
	for _, rec := range doc.Steps {
		switch rec.State {
		case "done", "skipped", "resolved":
			done++
		case "failed":
			failed++
		}
	}
	return
}

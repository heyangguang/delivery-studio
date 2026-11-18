package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"middleware-deployer/mwpack"
)

// Bringing a component fix into a delivery that is already generated. A delivery is made from the component as it was
// that day; when the component is fixed later (an entry test that ran on the wrong machine, a missing check), a
// delivery still being carried out can take the fix without being made again from scratch: the same specification and
// certificates are generated again with the component as it is now, as long as the software packages stay the same
// (anything that installs different packages is an upgrade or patch plan). What was already recorded is kept: a step
// that did not change keeps its record; a step that did keeps its old version and record, shown struck through above
// the new one, so the delivery's report still tells everything that happened. The controller gets an update package
// with only the project files that changed.

// jobSync is one time a delivery took the component as it is now.
type jobSync struct {
	N      int      `json:"n"`
	At     string   `json:"at"`
	By     string   `json:"by"`
	Files  []string `json:"files"`
	Steps  []string `json:"steps"`
	Update string   `json:"update,omitempty"` // the update package for the controller
	Remove []string `json:"remove,omitempty"` // project files that are gone
	// Kind is "patch" when this entry is a change the assistant made to the delivery's own files (ai_patch.go); Reason
	// says why.
	Kind   string `json:"kind,omitempty"`
	Reason string `json:"reason,omitempty"`
	// Kept are steps the sync marked for running again that a person decided are not affected after all: their old
	// result stands, with who said so and why.
	Kept map[string]keptNote `json:"kept,omitempty"`
}

type keptNote struct {
	By     string `json:"by"`
	At     string `json:"at"`
	Reason string `json:"reason"`
}

// supersededRecord is a step as it was before a sync changed it, with what was recorded against that version.
type supersededRecord struct {
	Sync    int    `json:"sync"`
	At      string `json:"at"`
	Title   string `json:"title"`
	Purpose string `json:"purpose,omitempty"`
	Expect  string `json:"expect,omitempty"`
	Command string `json:"command,omitempty"`
	// Why is what reaches the step from the sync's changes, so a person can judge the decision.
	Why    string     `json:"why,omitempty"`
	Record stepRecord `json:"record"`
}

type syncPreview struct {
	Available bool     `json:"available"`
	Blocked   string   `json:"blocked,omitempty"`
	Files     []string `json:"files"`
	Removed   []string `json:"removed,omitempty"`
	Steps     []string `json:"steps"`
	// Recorded are the changed steps that already have something recorded: their old version will be kept.
	Recorded []string `json:"recorded,omitempty"`
	// Why says for each changed step what reaches it, so the person can check the reasoning.
	Why map[string]string `json:"why,omitempty"`
	// Phases is the same, laid out the way the handbook is: per tab (environment, deployment, functional tests, entry
	// tests, cleanup), the steps that change with the reason and the ones that stay as they are.
	Phases []syncPhase `json:"phases,omitempty"`
	// Diffs shows what changed in each text file (secrets never are in the project), so the change can be read.
	Diffs map[string]string `json:"diffs,omitempty"`
}

type syncStep struct {
	Key      string `json:"key"`
	Title    string `json:"title"`
	Why      string `json:"why"`
	Recorded bool   `json:"recorded,omitempty"` // something was recorded against the old version, which is kept struck through
	New      bool   `json:"new,omitempty"`      // a step the delivery did not have
}

type syncPhase struct {
	Label   string     `json:"label"`
	Total   int        `json:"total"`
	Changed []syncStep `json:"changed"`
	Same    []string   `json:"same,omitempty"`
}

// projectFiles reads every file of the delivery's Ansible project from the controller's package.
func (s *storeServer) projectFiles(id string) (map[string][]byte, error) {
	f := s.deliveryTar(id)
	prefix := s.projectPrefix(id)
	if f == "" || prefix == "" {
		return nil, fmt.Errorf("交付包不存在")
	}
	fh, err := os.Open(f)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	gz, err := gzip.NewReader(fh)
	if err != nil {
		return nil, err
	}
	out := map[string][]byte{}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		if h.Typeflag != tar.TypeReg || !strings.HasPrefix(h.Name, prefix) || h.Size > 8<<20 {
			continue
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			return nil, err
		}
		out[strings.TrimPrefix(h.Name, prefix)] = b
	}
	for k, b := range s.patchedFiles(id) {
		out[k] = b
	}
	return out, nil
}

// syncPlan solves the delivery's own specification against the components as they are now and renders it, without
// packing anything.
func (s *storeServer) syncPlan(j storeJob) (*mwpack.Plan, mwpack.RenderOptions, *mwpack.Bundle, error) {
	var opt mwpack.RenderOptions
	d := s.readSpec(j.ID)
	if d == nil {
		return nil, opt, nil, fmt.Errorf("这份交付没有保存部署规格")
	}
	plan := mwpack.Solve(s.plat.cat(), d)
	if err := plan.Err(); err != nil {
		return nil, opt, nil, fmt.Errorf("按现在的组件，这份规格已经不能通过校验：%v", err)
	}
	opt = mwpack.RenderOptions{Artifacts: s.plat.artifactsFor(plan), Materials: s.sourceCertificates(j.ID)}
	if plan.NeedsPackages() {
		// the repository the delivery already carries: the same packages, so the same file
		var lock struct {
			Repo struct{ File, SHA256 string } `json:"package_repository"`
		}
		b, _ := os.ReadFile(filepath.Join(s.jobDir(j.ID), "output", "deployment.lock.json"))
		_ = json.Unmarshal(b, &lock)
		st, err := os.Stat(filepath.Join(s.jobDir(j.ID), "output", lock.Repo.File))
		if lock.Repo.File == "" || err != nil {
			return nil, opt, nil, fmt.Errorf("这份交付的离线软件仓库不在了，不能同步")
		}
		opt.PackageRepo = &mwpack.PackageRepo{File: lock.Repo.File, SHA256: lock.Repo.SHA256, Size: st.Size()}
	}
	b, err := mwpack.Render(plan, opt)
	if err != nil {
		return nil, opt, nil, err
	}
	// what was patched on site stays on top of whatever the component now says
	for k, data := range s.patchedFiles(j.ID) {
		f := b.Project[k]
		f.Data = data
		if f.Mode == 0 {
			f.Mode = 0o644
		}
		b.Project[k] = f
	}
	return plan, opt, b, nil
}

// lockPackages is what a lock says each instance installs, for comparing two of them.
func lockPackages(b []byte) string {
	var l struct {
		Instances []struct {
			ID       string `json:"id"`
			Packages []struct {
				Name, Version string
			} `json:"packages"`
		} `json:"instances"`
	}
	_ = json.Unmarshal(b, &l)
	var lines []string
	for _, i := range l.Instances {
		for _, p := range i.Packages {
			lines = append(lines, i.ID+" "+p.Name+" "+p.Version)
		}
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

// stepIdentity names a runbook step by what it is rather than where it is, so a step is matched across two versions
// of a runbook even when steps were added before it.
func stepIdentity(st reportStep) string {
	k := st.Key
	if len(st.Parts) == 1 && st.Parts[0].ID != "" && !strings.HasPrefix(k, "deploy/") {
		return strings.SplitN(k, "/", 2)[0] + "/" + st.Parts[0].Instance + "/" + st.Parts[0].ID
	}
	return k
}

func flatSteps(tabs []reportTab) []reportStep {
	var out []reportStep
	for _, t := range tabs {
		out = append(out, t.Steps...)
	}
	return out
}

// projectMap is the generated project as plain file contents (the structured handbook is kept beside the project, not
// inside it).
func projectMap(b *mwpack.Bundle) map[string][]byte {
	out := map[string][]byte{}
	for name, f := range b.Project {
		if name != "plan.json" {
			out[name] = f.Data
		}
	}
	return out
}

// previewSync says what taking the components as they are now would change in this delivery, and for every step why.
func (s *storeServer) previewSync(j storeJob) (syncPreview, *mwpack.Bundle, map[string][]byte) {
	pv := syncPreview{Files: []string{}, Steps: []string{}}
	switch {
	case j.State != "succeeded":
		pv.Blocked = "交付材料还没有生成成功"
		return pv, nil, nil
	case j.finished():
		pv.Blocked = "这份交付已经执行完成，不再同步组件改动；已运行集群的后续调整请前往集群「变更演练」。"
		return pv, nil, nil
	case j.Outcome == outcomeVoid:
		pv.Blocked = "这份交付已作废"
		return pv, nil, nil
	}
	_, _, b, err := s.syncPlan(j)
	if err != nil {
		pv.Blocked = err.Error()
		return pv, nil, nil
	}
	old, err := s.projectFiles(j.ID)
	if err != nil {
		pv.Blocked = err.Error()
		return pv, nil, nil
	}
	oldLock, _ := os.ReadFile(filepath.Join(s.jobDir(j.ID), "output", "deployment.lock.json"))
	if lockPackages(oldLock) != lockPackages(b.Lock) {
		pv.Blocked = "组件当前关联的软件包版本与这份交付不一致，不能直接同步；请重新生成交付，已运行集群的后续变更请走「变更演练」。"
		return pv, nil, nil
	}
	now := projectMap(b)
	changed := map[string]bool{}
	for name, data := range now {
		if o, ok := old[name]; !ok || !bytes.Equal(o, data) {
			pv.Files = append(pv.Files, name)
			changed[name] = true
		}
	}
	for name := range old {
		if name == "plan.json" {
			continue
		}
		if _, ok := now[name]; !ok {
			pv.Removed = append(pv.Removed, name)
			changed[name] = true
		}
	}
	sort.Strings(pv.Files)
	sort.Strings(pv.Removed)
	pv.Diffs = map[string]string{}
	for _, name := range pv.Files {
		if len(now[name]) < 256<<10 && len(old[name]) < 256<<10 && !bytes.Contains(now[name], []byte{0}) {
			pv.Diffs[name] = lineDiff(string(old[name]), string(now[name]), 200)
		}
	}
	before := map[string]reportStep{}
	for _, st := range flatSteps(s.runbookStepsOf(s.jobPlan(j.ID), j.ID)) {
		before[stepIdentity(st)] = st
	}
	s.mu.Lock()
	doc := s.readProgress(j.ID)
	s.mu.Unlock()
	nowSteps := flatSteps(s.runbookStepsOf(b.PlanDoc, j.ID))
	impact := impactOf(nowSteps, before, old, now, changed)
	for _, tab := range s.runbookStepsOf(b.PlanDoc, j.ID) {
		ph := syncPhase{Label: tab.Label, Total: len(tab.Steps), Changed: []syncStep{}}
		for _, st := range tab.Steps {
			im := impact[st.Key]
			if !im.Changed {
				ph.Same = append(ph.Same, st.Title)
				continue
			}
			pv.Steps = append(pv.Steps, st.Title)
			if pv.Why == nil {
				pv.Why = map[string]string{}
			}
			pv.Why[st.Title] = im.Why
			item := syncStep{Key: st.Key, Title: st.Title, Why: im.Why}
			if o, ok := before[stepIdentity(st)]; ok {
				if r, has := doc.Steps[o.Key]; has && (r.State != "" || r.Note != "" || r.Log != "" || len(r.Images) > 0) {
					pv.Recorded = append(pv.Recorded, st.Title)
					item.Recorded = true
				}
			} else {
				item.New = true
			}
			ph.Changed = append(ph.Changed, item)
		}
		if ph.Total > 0 {
			pv.Phases = append(pv.Phases, ph)
		}
	}
	pv.Available = len(pv.Files)+len(pv.Removed)+len(pv.Steps) > 0
	return pv, b, old
}

func (s *storeServer) handleSync(w http.ResponseWriter, r *http.Request, session storeSession, j storeJob) {
	switch r.Method {
	case "GET":
		pv, _, _ := s.previewSync(j)
		s.writeJSON(w, 200, map[string]any{"preview": pv, "syncs": j.Syncs})
	case "POST":
		pv, b, old := s.previewSync(j)
		if pv.Blocked != "" || !pv.Available {
			s.fail(w, 409, firstNonEmptyStr(pv.Blocked, "这份交付已经和组件一致，不需要同步"))
			return
		}
		sy, err := s.applySync(j, session.User, b, old, pv)
		if err != nil {
			s.fail(w, 500, "同步失败："+err.Error())
			return
		}
		s.auditReq(r, "job-sync", session.User, j.ID+" "+strconv.Itoa(sy.N))
		s.writeJSON(w, 200, sy)
	default:
		s.fail(w, 405, "方法不支持")
	}
}

// reevaluateSyncs applies the strict rule again to every earlier sync. A step with a result recorded before a sync that
// the sync's changes can reach goes back to "not run yet" (its result stays as the old version), unless a person
// decided otherwise or it was carried out again after the sync. Safe to run again.
func (s *storeServer) reevaluateSyncs() {
	s.mu.Lock()
	var ids []string
	for id, j := range s.jobs {
		if len(j.Syncs) > 0 && !j.finished() {
			ids = append(ids, id)
		}
	}
	s.mu.Unlock()
	for _, id := range ids {
		files, err := s.projectFiles(id)
		if err != nil {
			continue
		}
		cur := flatSteps(s.runbookStepsOf(s.jobPlan(id), ""))
		before := map[string]reportStep{}
		for _, st := range cur {
			before[stepIdentity(st)] = st
		}
		s.mu.Lock()
		j := s.jobs[id]
		doc := s.readProgress(id)
		s.mu.Unlock()
		changed := false
		for _, sy := range j.Syncs {
			if sy.Kind == "patch" || len(sy.Files) == 0 {
				continue
			}
			set := map[string]bool{}
			for _, f := range sy.Files {
				set[f] = true
			}
			for _, f := range sy.Remove {
				set[f] = true
			}
			// only what can be compared is judged again: where the text before the sync is gone (the first sync of a
			// delivery replaced the original package) the decision made at the time stands
			prior := s.filesBeforeSync(id, sy.N, set)
			known := map[string]bool{}
			for f := range prior {
				known[f] = true
			}
			if len(known) == 0 {
				continue
			}
			im := impactOf(cur, before, prior, files, known)
			for _, st := range cur {
				rec, has := doc.Steps[st.Key]
				if !has || !im[st.Key].Changed || rec.At >= sy.At {
					continue
				}
				if _, kept := sy.Kept[st.Key]; kept {
					continue
				}
				if doc.Superseded == nil {
					doc.Superseded = map[string][]supersededRecord{}
				}
				doc.Superseded[st.Key] = append(doc.Superseded[st.Key], supersededRecord{Sync: sy.N, At: sy.At, Title: st.Title, Purpose: st.Purpose, Expect: st.Expect, Command: st.Command, Why: im[st.Key].Why, Record: rec})
				delete(doc.Steps, st.Key)
				changed = true
			}
		}
		if changed {
			s.mu.Lock()
			_ = s.writeProgress(id, doc)
			j = s.jobs[id]
			j.RunDone, j.RunFailed = countSteps(doc)
			s.jobs[id] = j
			s.mu.Unlock()
			_ = s.persistJob(j)
		}
	}
}

// keepStep is a person's decision that a step a sync marked as affected is not: its old result stands again.
func (s *storeServer) keepStep(id, key, user, reason string, syncN int) error {
	reason = strings.TrimSpace(reason)
	if len([]rune(reason)) < 4 {
		return fmt.Errorf("请写明为什么这一步不受影响（会和你的名字一起记录在交付里）")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	j := s.jobs[id]
	doc := s.readProgress(id)
	list := doc.Superseded[key]
	idx := -1
	for i, o := range list {
		if o.Sync == syncN {
			idx = i
		}
	}
	if idx < 0 {
		return fmt.Errorf("这一步没有被这次同步划掉的旧结果")
	}
	if _, taken := doc.Steps[key]; taken {
		return fmt.Errorf("这一步已经有新的结果了")
	}
	doc.Steps[key] = list[idx].Record
	doc.Superseded[key] = append(list[:idx:idx], list[idx+1:]...)
	if len(doc.Superseded[key]) == 0 {
		delete(doc.Superseded, key)
	}
	at := time.Now().UTC().Format(time.RFC3339)
	for i := range j.Syncs {
		if j.Syncs[i].N == syncN {
			if j.Syncs[i].Kept == nil {
				j.Syncs[i].Kept = map[string]keptNote{}
			}
			j.Syncs[i].Kept[key] = keptNote{By: user, At: at, Reason: reason}
		}
	}
	doc.Events = append(doc.Events, progressEvent{At: at, By: user, Key: key, Title: "确认这一步不受第 " + strconv.Itoa(syncN) + " 次同步影响：" + truncRunes(reason, 80), State: "done"})
	if err := s.writeProgress(id, doc); err != nil {
		return err
	}
	j.RunDone, j.RunFailed = countSteps(doc)
	if err := s.persistJob(j); err != nil {
		return err
	}
	s.jobs[id] = j
	return nil
}

// filesBeforeSync is what the changed files of sync n were like before it, as far as the update packages of the earlier
// syncs and patches still hold them; a file that no package holds is left out (nothing to compare with).
func (s *storeServer) filesBeforeSync(id string, n int, changed map[string]bool) map[string][]byte {
	out := map[string][]byte{}
	for k := 1; k < n; k++ {
		matches, _ := filepath.Glob(filepath.Join(s.jobDir(id), "output", fmt.Sprintf("update-%d-*.tar.gz", k)))
		for _, m := range matches {
			if strings.HasSuffix(m, ".sha256") {
				continue
			}
			fh, err := os.Open(m)
			if err != nil {
				continue
			}
			gz, err := gzip.NewReader(fh)
			if err == nil {
				tr := tar.NewReader(gz)
				for {
					h, err := tr.Next()
					if err != nil {
						break
					}
					if h.Typeflag != tar.TypeReg {
						continue
					}
					if i := strings.Index(h.Name, "/projects/"); i >= 0 {
						rel := h.Name[i+len("/projects/"):]
						if j := strings.Index(rel, "/"); j >= 0 {
							rel = rel[j+1:]
						}
						if changed[rel] {
							b, _ := io.ReadAll(tr)
							out[rel] = b
						}
					}
				}
			}
			fh.Close()
		}
	}
	return out
}

// applySync generates the delivery again, keeps the old handbook beside it, writes the update package and carries the
// execution record over.
func (s *storeServer) applySync(j storeJob, user string, b *mwpack.Bundle, old map[string][]byte, pv syncPreview) (jobSync, error) {
	n := len(j.Syncs) + 1
	dir := s.jobDir(j.ID)
	plan, opt, _, err := s.syncPlan(j)
	if err != nil {
		return jobSync{}, err
	}
	fresh := filepath.Join(dir, fmt.Sprintf(".sync-%d", n))
	_ = os.RemoveAll(fresh)
	if err := s.generate(plan, opt.Materials, fresh, func(string) {}); err != nil {
		os.RemoveAll(fresh)
		return jobSync{}, err
	}
	oldPlan := s.jobPlan(j.ID)
	// the old handbook stays with the delivery, for its report; the big packages do not
	keep := filepath.Join(dir, "history", fmt.Sprintf("sync-%d", n))
	if err := os.MkdirAll(keep, 0o700); err != nil {
		os.RemoveAll(fresh)
		return jobSync{}, err
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "output"))
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".md") || name == "plan.json" || name == "deployment.lock.json" || name == "SHA256SUMS" || strings.HasPrefix(name, "update-") {
			src := filepath.Join(dir, "output", name)
			if data, err := os.ReadFile(src); err == nil {
				_ = os.WriteFile(filepath.Join(keep, name), data, 0o600)
			}
		}
	}
	// update packages of earlier syncs stay downloadable
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "update-") {
			_ = os.Rename(filepath.Join(dir, "output", e.Name()), filepath.Join(fresh, e.Name()))
		}
	}
	prefix := "middleware-automation/projects/" + plan.ProjectName() + "/"
	upd := fmt.Sprintf("update-%d-%s.tar.gz", n, plan.ProjectName())
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	now := time.Now()
	for _, name := range pv.Files {
		f := b.Project[name]
		mode := int64(0o600)
		if f.Mode != 0 {
			mode = int64(f.Mode)
		}
		if err := tw.WriteHeader(&tar.Header{Name: prefix + name, Mode: mode, Size: int64(len(f.Data)), ModTime: now, Typeflag: tar.TypeReg}); err != nil {
			return jobSync{}, err
		}
		if _, err := tw.Write(f.Data); err != nil {
			return jobSync{}, err
		}
	}
	tw.Close()
	gz.Close()
	if err := os.WriteFile(filepath.Join(fresh, upd), buf.Bytes(), 0o600); err != nil {
		return jobSync{}, err
	}
	sum := digest(buf.Bytes())
	_ = os.WriteFile(filepath.Join(fresh, upd+".sha256"), []byte(sum+"  "+upd+"\n"), 0o600)
	if sums, err := os.ReadFile(filepath.Join(fresh, "SHA256SUMS")); err == nil {
		_ = os.WriteFile(filepath.Join(fresh, "SHA256SUMS"), append(sums, []byte(sum+"  "+upd+"\n")...), 0o600)
	}
	// swap: the new output in place, the old one gone
	gone := filepath.Join(dir, fmt.Sprintf(".old-%d", n))
	if err := os.Rename(filepath.Join(dir, "output"), gone); err != nil {
		os.RemoveAll(fresh)
		return jobSync{}, err
	}
	if err := os.Rename(fresh, filepath.Join(dir, "output")); err != nil {
		_ = os.Rename(gone, filepath.Join(dir, "output"))
		return jobSync{}, err
	}
	os.RemoveAll(gone)
	// accepted AI amendments are applied again to the new handbook
	_ = os.RemoveAll(filepath.Join(s.aiDir(j.ID), "orig"))
	_ = s.applyAmendmentDocs(j.ID)

	sy := jobSync{N: n, At: now.UTC().Format(time.RFC3339), By: user, Files: pv.Files, Steps: pv.Steps, Update: upd, Remove: pv.Removed}
	// the execution record follows the steps to where they are now
	before := map[string]reportStep{}
	for _, st := range flatSteps(s.runbookStepsOf(oldPlan, j.ID)) {
		before[stepIdentity(st)] = st
	}
	changedSet := map[string]bool{}
	for _, f := range pv.Files {
		changedSet[f] = true
	}
	for _, f := range pv.Removed {
		changedSet[f] = true
	}
	nowSteps := flatSteps(s.runbookStepsOf(s.jobPlan(j.ID), j.ID))
	impact := impactOf(nowSteps, before, old, projectMap(b), changedSet)
	s.mu.Lock()
	defer s.mu.Unlock()
	doc := s.readProgress(j.ID)
	steps := map[string]stepRecord{}
	if doc.Superseded == nil {
		doc.Superseded = map[string][]supersededRecord{}
	}
	used := map[string]bool{}
	for _, st := range nowSteps {
		o, ok := before[stepIdentity(st)]
		if !ok {
			continue
		}
		used[o.Key] = true
		rec, has := doc.Steps[o.Key]
		if prev := doc.Superseded[o.Key]; len(prev) > 0 && o.Key != st.Key {
			doc.Superseded[st.Key] = prev
			delete(doc.Superseded, o.Key)
		}
		if !has {
			continue
		}
		if !impact[st.Key].Changed {
			steps[st.Key] = rec
			continue
		}
		doc.Superseded[st.Key] = append(doc.Superseded[st.Key], supersededRecord{Sync: n, At: sy.At, Title: o.Title, Purpose: o.Purpose, Expect: o.Expect, Command: o.Command, Why: impact[st.Key].Why, Record: rec})
	}
	// records of steps that are no longer in the runbook stay, under their old key, for the report
	for k, rec := range doc.Steps {
		if !used[k] {
			if _, taken := steps[k]; !taken {
				steps[k] = rec
			}
		}
	}
	doc.Steps = steps
	doc.Events = append(doc.Events, progressEvent{At: sy.At, By: user, Key: "sync-" + strconv.Itoa(n), Title: fmt.Sprintf("按最新组件同步（第 %d 次）：%d 个文件、%d 个步骤有变化", n, len(pv.Files)+len(pv.Removed), len(pv.Steps)), State: "sync"})
	if err := s.writeProgress(j.ID, doc); err != nil {
		return sy, err
	}
	cur := s.jobs[j.ID]
	cur.Syncs = append(cur.Syncs, sy)
	cur.RunDone, cur.RunFailed = countSteps(doc)
	if err := s.persistJob(cur); err != nil {
		return sy, err
	}
	s.jobs[j.ID] = cur
	return sy, nil
}

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing/fstest"
	"time"

	"middleware-deployer/catalog"
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
	// FileHashes maps every project-relative file carried by the cumulative update package to its expected SHA-256.
	// UpdateSHA is the SHA-256 of the update-*.tar.gz archive itself. VerifyCmd is computed for UI & offline docs.
	FileHashes map[string]string `json:"file_hashes,omitempty"`
	UpdateSHA  string            `json:"update_sha,omitempty"`
	VerifyCmd  string            `json:"verify_cmd,omitempty"`
	// Kind is "patch" when this entry is a change the assistant made to the delivery's own files (ai_patch.go); Reason
	// says why.
	Kind   string `json:"kind,omitempty"`
	Reason string `json:"reason,omitempty"`
	// Kept are steps the sync marked for running again that a person decided are not affected after all: their old
	// result stands, with who said so and why.
	Kept map[string]keptNote `json:"kept,omitempty"`
	// AppliedAt / AppliedBy / AppliedMode record when an engineer confirmed the updated files are verified on the
	// controller ("verified" = self-verifying check/apply script succeeded; "patch"/"full" kept for compatibility).
	AppliedAt   string `json:"applied_at,omitempty"`
	AppliedBy   string `json:"applied_by,omitempty"`
	AppliedMode string `json:"applied_mode,omitempty"`
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
	// UsingDrafts lists components whose workspace drafts were overlaid (verification deliveries only).
	UsingDrafts []string `json:"using_drafts,omitempty"`
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

// syncCatalogFor returns the published catalog for formal deliveries; for temporary verification deliveries
// (purpose == "verification"), it overlays any saved component workspace drafts so maintainers can hot-sync draft
// fixes straight into their active verification test delivery and resume from the failing step without publishing first.
func (s *storeServer) syncCatalogFor(j storeJob, d *mwpack.Deployment) (*mwpack.Catalog, []string) {
	base := s.plat.cat()
	if !isTempVerificationJob(j) || d == nil {
		return base, nil
	}
	cs := s.comps()
	seen := map[string]bool{}
	draftNames := []string{}
	draftSets := map[string]fileSet{}
	for _, inst := range d.Instances {
		name := strings.TrimSpace(inst.Component)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		if cs.hasDraft(name) {
			if files, _, err := cs.readDraft(name); err == nil && len(files) > 0 {
				draftNames = append(draftNames, name)
				draftSets[name] = files
			}
		}
	}
	var platDraft fileSet
	if cs.hasDraft(sharedPlatformName) {
		if files, _, err := cs.readDraft(sharedPlatformName); err == nil && len(files) > 0 {
			platDraft = files
			draftNames = append(draftNames, sharedPlatformName)
		}
	}
	if len(draftNames) == 0 {
		return base, nil
	}
	sort.Strings(draftNames)
	sources := []fs.FS{catalog.FS}
	if s.plat.componentsDir != "" {
		custom := os.DirFS(s.plat.componentsDir)
		if entries, err := os.ReadDir(s.plat.componentsDir); err == nil {
			for _, e := range entries {
				if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || draftSets[e.Name()] != nil {
					continue
				}
				one := single{custom, e.Name()}
				if _, err := mwpack.LoadCatalog(catalog.FS, one); err == nil {
					sources = append(sources, one)
				}
			}
		}
	}
	for name, files := range draftSets {
		mem := fstest.MapFS{}
		for p, b := range files {
			mem[name+"/"+p] = &fstest.MapFile{Data: b, Mode: 0o600}
		}
		sources = append(sources, single{mem, name})
	}
	cat, err := mwpack.LoadCatalog(sources...)
	if err != nil {
		return base, nil
	}
	if len(platDraft) > 0 {
		cat = cat.WithPlatformFiles(platDraft)
	} else {
		cat = cat.WithPlatformFiles(base.PlatformSnapshot())
	}
	return cat, draftNames
}

// syncPlan solves the delivery's own specification against the components as they are now and renders it, without
// packing anything.
func (s *storeServer) syncPlan(j storeJob) (*mwpack.Plan, mwpack.RenderOptions, *mwpack.Bundle, []string, error) {
	var opt mwpack.RenderOptions
	d := s.readSpec(j.ID)
	if d == nil {
		return nil, opt, nil, nil, fmt.Errorf("这份交付没有保存部署规格")
	}
	cat, usingDrafts := s.syncCatalogFor(j, d)
	plan := mwpack.Solve(cat, d)
	if err := plan.Err(); err != nil {
		return nil, opt, nil, usingDrafts, fmt.Errorf("按现在的组件，这份规格已经不能通过校验：%v", err)
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
			return nil, opt, nil, usingDrafts, fmt.Errorf("这份交付的离线软件仓库不在了，不能同步")
		}
		opt.PackageRepo = &mwpack.PackageRepo{File: lock.Repo.File, SHA256: lock.Repo.SHA256, Size: st.Size()}
	}
	b, err := mwpack.Render(plan, opt)
	if err != nil {
		return nil, opt, nil, usingDrafts, err
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
	return plan, opt, b, usingDrafts, nil
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
	_, _, b, usingDrafts, err := s.syncPlan(j)
	if err != nil {
		pv.Blocked = err.Error()
		return pv, nil, nil
	}
	pv.UsingDrafts = usingDrafts
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
		s.writeJSON(w, 200, map[string]any{"preview": localizeSyncPreview(wLang(w), pv), "syncs": j.Syncs})
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
	plan, opt, _, _, err := s.syncPlan(j)
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
	// Pack every file changed across this sync AND all earlier syncs (that still exist in b.Project),
	// so the latest update archive alone brings any prior controller state up to date.
	packSet := map[string]bool{}
	for _, name := range pv.Files {
		if _, ok := b.Project[name]; ok {
			packSet[name] = true
		}
	}
	removeSet := map[string]bool{}
	for _, name := range pv.Removed {
		if _, ok := b.Project[name]; !ok {
			removeSet[name] = true
		}
	}
	for _, prev := range j.Syncs {
		for _, name := range prev.Files {
			if _, ok := b.Project[name]; ok {
				packSet[name] = true
			}
		}
		for name := range prev.FileHashes {
			if _, ok := b.Project[name]; ok {
				packSet[name] = true
			}
		}
		for _, name := range prev.Remove {
			if _, ok := b.Project[name]; !ok {
				removeSet[name] = true
			}
		}
	}
	packNames := make([]string, 0, len(packSet))
	for name := range packSet {
		packNames = append(packNames, name)
	}
	sort.Strings(packNames)
	removeNames := make([]string, 0, len(removeSet))
	for name := range removeSet {
		removeNames = append(removeNames, name)
	}
	sort.Strings(removeNames)

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	now := time.Now()
	fileHashes := map[string]string{}
	for _, name := range packNames {
		f := b.Project[name]
		fileHashes[name] = digest(f.Data)
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
	// reset cached originals so applyAmendmentDocs rebuilds from the newly generated handbook
	_ = os.RemoveAll(filepath.Join(s.aiDir(j.ID), "orig"))

	sy := jobSync{
		N:          n,
		At:         now.UTC().Format(time.RFC3339),
		By:         user,
		Files:      pv.Files,
		Steps:      pv.Steps,
		Update:     upd,
		Remove:     removeNames,
		FileHashes: fileHashes,
		UpdateSHA:  sum,
	}
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
		s.mu.Unlock()
		return sy, err
	}
	cur := s.jobs[j.ID]
	cur.Syncs = append(cur.Syncs, sy)
	cur.RunDone, cur.RunFailed = countSteps(doc)
	if err := s.persistJob(cur); err != nil {
		s.mu.Unlock()
		return sy, err
	}
	s.jobs[j.ID] = cur
	s.mu.Unlock()
	// accepted AI amendments AND the sync verification step are written into the offline handbook
	aiMu.Lock()
	_ = s.applyAmendmentDocs(j.ID)
	aiMu.Unlock()
	return sy, nil
}

func syncPackageBase(projectDir string) string {
	const marker = "/middleware-automation/projects/"
	if i := strings.Index(projectDir, marker); i > 0 {
		return projectDir[:i]
	}
	return "/root"
}

func shellSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// readUpdateArchiveInfo inspects an update-*.tar.gz on disk to recover archive SHA-256 and every project-relative
// file's SHA-256 (used for retroactive enrichment of deliveries synced before FileHashes was persisted).
func readUpdateArchiveInfo(archivePath string) (map[string]string, string) {
	raw, err := os.ReadFile(archivePath)
	if err != nil {
		return nil, ""
	}
	archiveSHA := digest(raw)
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, archiveSHA
	}
	defer gz.Close()
	hashes := map[string]string{}
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
				if rel != "" {
					if data, err := io.ReadAll(tr); err == nil {
						hashes[rel] = digest(data)
					}
				}
			}
		}
	}
	return hashes, archiveSHA
}

type syncPlanMeta struct {
	Controller   string `json:"controller"`
	ProjectDir   string `json:"project_dir"`
	UploadDir    string `json:"upload_dir"`
	DeliveryMode string `json:"delivery_mode"`
}

func parseSyncPlanMeta(raw json.RawMessage) *syncPlanMeta {
	if len(raw) == 0 {
		return nil
	}
	var m syncPlanMeta
	if json.Unmarshal(raw, &m) != nil || m.ProjectDir == "" {
		return nil
	}
	return &m
}

// buildSyncVerifyCommand returns a single idempotent, self-verifying command for the controller.
// It inspects the actual files in projectDir:
//   - if projectDir does not exist yet: fails without exiting an interactive shell, reminding to unpack base package first
//   - if all expected file hashes already match (e.g. fresh full bundle unpacked): prints OK and succeeds without needing update-*.tar.gz
//   - if projectDir has older files and update-*.tar.gz is in uploadDir: verifies archive SHA-256, extracts, removes deleted files, re-verifies hashes
//   - if projectDir has older files and update-*.tar.gz is missing: fails loudly telling the engineer the exact archive to upload
func buildSyncVerifyCommand(plan *syncPlanMeta, sy jobSync) string {
	if plan == nil || sy.Update == "" {
		return ""
	}
	proj := strings.TrimRight(plan.ProjectDir, "/")
	if proj == "" {
		return ""
	}
	uploadDir := strings.TrimRight(plan.UploadDir, "/")
	if uploadDir == "" {
		uploadDir = "/tmp/mw-upload"
	}
	pkgBase := syncPackageBase(proj)
	ctl := plan.Controller
	if ctl == "" {
		ctl = "控制节点"
	}
	label := fmt.Sprintf("第 %d 次同步", sy.N)
	if sy.Kind == "patch" {
		label = fmt.Sprintf("第 %d 次 AI 补丁", sy.N)
	}
	updPath := uploadDir + "/" + sy.Update

	hashKeys := make([]string, 0, len(sy.FileHashes))
	for k := range sy.FileHashes {
		hashKeys = append(hashKeys, k)
	}
	sort.Strings(hashKeys)
	removes := append([]string(nil), sy.Remove...)
	sort.Strings(removes)

	var applyParts []string
	if sy.UpdateSHA != "" {
		applyParts = append(applyParts, fmt.Sprintf(`echo "%s  $UPD" | sha256sum -c`, sy.UpdateSHA))
	}
	applyParts = append(applyParts, fmt.Sprintf(`tar -xzf "$UPD" -C %s`, shellSingleQuote(pkgBase)))
	if len(removes) > 0 {
		quoted := make([]string, 0, len(removes))
		for _, r := range removes {
			quoted = append(quoted, shellSingleQuote(r))
		}
		applyParts = append(applyParts, fmt.Sprintf(`(cd "$PROJ" && rm -f %s)`, strings.Join(quoted, " ")))
	}

	var b strings.Builder
	fmt.Fprintf(&b, "PROJ=%s\n", shellSingleQuote(proj))
	fmt.Fprintf(&b, "UPD=%s\n", shellSingleQuote(updPath))

	if len(hashKeys) == 0 && len(removes) == 0 {
		fmt.Fprintf(&b, "if [ ! -d \"$PROJ\" ]; then\n")
		fmt.Fprintf(&b, "  echo \"ERROR: 未找到 $PROJ，请先完成「环境准备」中的基础包解包。\" >&2\n")
		fmt.Fprintf(&b, "  false\n")
		fmt.Fprintf(&b, "elif [ -f \"$UPD\" ]; then\n")
		fmt.Fprintf(&b, "  %s && echo \"OK: 已应用更新包（%s）。\"\n", strings.Join(applyParts, " && "), label)
		fmt.Fprintf(&b, "else\n")
		fmt.Fprintf(&b, "  echo \"ERROR: 未找到 $UPD，请先上传 %s 到 %s 后重跑。\" >&2\n", sy.Update, uploadDir)
		fmt.Fprintf(&b, "  false\n")
		fmt.Fprintf(&b, "fi")
		return b.String()
	}

	b.WriteString("check_sync() {\n")
	var conds []string
	conds = append(conds, `[ -d "$PROJ" ]`)
	if len(removes) > 0 {
		rmChecks := make([]string, 0, len(removes))
		for _, r := range removes {
			rmChecks = append(rmChecks, fmt.Sprintf(`[ ! -e %s ]`, shellSingleQuote(r)))
		}
		conds = append(conds, fmt.Sprintf(`(cd "$PROJ" && %s)`, strings.Join(rmChecks, " && ")))
	}
	if len(hashKeys) > 0 {
		var sumLines strings.Builder
		for _, k := range hashKeys {
			fmt.Fprintf(&sumLines, "%s  %s\n", sy.FileHashes[k], k)
		}
		conds = append(conds, fmt.Sprintf("(cd \"$PROJ\" && sha256sum -c --status <<'MW_SYNC_EOF'\n%sMW_SYNC_EOF\n  )", sumLines.String()))
	}
	fmt.Fprintf(&b, "  %s\n", strings.Join(conds, " && "))
	b.WriteString("}\n")

	fmt.Fprintf(&b, "if [ ! -d \"$PROJ\" ]; then\n")
	fmt.Fprintf(&b, "  echo \"ERROR: 未找到 $PROJ，请先完成「环境准备」中的基础包解包。\" >&2\n")
	fmt.Fprintf(&b, "  false\n")
	fmt.Fprintf(&b, "elif check_sync; then\n")
	fmt.Fprintf(&b, "  echo \"OK: %s 项目文件已是最新（%s），无需重复覆盖。\"\n", ctl, label)
	fmt.Fprintf(&b, "elif [ -f \"$UPD\" ]; then\n")
	fmt.Fprintf(&b, "  %s && check_sync && echo \"OK: 已覆盖更新包并校验通过（%s）。\"\n", strings.Join(applyParts, " && "), label)
	fmt.Fprintf(&b, "else\n")
	fmt.Fprintf(&b, "  echo \"ERROR: 检测到 %s 仍是旧版本文件！请先上传 %s 到 %s 后重跑此命令。\" >&2\n", ctl, sy.Update, uploadDir)
	fmt.Fprintf(&b, "  false\n")
	fmt.Fprintf(&b, "fi")
	return b.String()
}

func (s *storeServer) enrichJobSyncs(id string, plan *syncPlanMeta, syncs []jobSync) []jobSync {
	if len(syncs) == 0 {
		return syncs
	}
	out := make([]jobSync, len(syncs))
	copy(out, syncs)
	outDir := filepath.Join(s.jobDir(id), "output")
	for i := range out {
		sy := &out[i]
		if sy.Update != "" && (len(sy.FileHashes) == 0 || sy.UpdateSHA == "") {
			hashes, sha := readUpdateArchiveInfo(filepath.Join(outDir, sy.Update))
			if len(sy.FileHashes) == 0 && len(hashes) > 0 {
				sy.FileHashes = hashes
			}
			if sy.UpdateSHA == "" && sha != "" {
				sy.UpdateSHA = sha
			}
		}
		if plan != nil && sy.Update != "" {
			sy.VerifyCmd = buildSyncVerifyCommand(plan, *sy)
		}
	}
	return out
}

// syncDeploySectionMarker lets us detect whether an offline 01-*.md handbook already carries sync #n's check step.
func syncDeploySectionMarker(sy jobSync) string {
	if sy.Kind == "patch" {
		return fmt.Sprintf("## 0. 核对并应用第 %d 次 AI 补丁更新（必做）", sy.N)
	}
	return fmt.Sprintf("## 0. 核对并应用第 %d 次同步更新（必做）", sy.N)
}

func injectSyncDeploySection(md string, plan *syncPlanMeta, sy jobSync) string {
	if plan == nil || sy.VerifyCmd == "" {
		return md
	}
	ctl := plan.Controller
	if ctl == "" {
		ctl = "控制节点"
	}
	uploadDir := strings.TrimRight(plan.UploadDir, "/")
	if uploadDir == "" {
		uploadDir = "/tmp/mw-upload"
	}
	heading := syncDeploySectionMarker(sy)
	var sec strings.Builder
	sec.WriteString(heading + "\n\n")
	if sy.Kind == "patch" {
		fmt.Fprintf(&sec, "作用于 %s。AI 补丁更新不会重打基础包，请先将 `%s` 上传至 `%s`，再在控制节点执行下方核对与覆盖命令：\n", ctl, sy.Update, uploadDir)
	} else {
		fmt.Fprintf(&sec, "作用于 %s。无需凭记忆判断之前上传的是旧包还是最新完整包，执行下方命令会自动按 SHA256 核对项目文件：\n", ctl)
		sec.WriteString("- 若已解包最新基础包/完整交付包，命令会自动校验通过并放行（无需重复覆盖）；\n")
		fmt.Fprintf(&sec, "- 若 %s 仍是旧版本，将增量更新包 `%s` 上传至 `%s` 后重跑本命令即可自动校验并覆盖。\n", ctl, sy.Update, uploadDir)
	}
	sec.WriteString("\n```bash\n")
	sec.WriteString(sy.VerifyCmd)
	sec.WriteString("\n```\n\n")
	sec.WriteString("通过标准：终端输出 `OK:`（已是最新无需覆盖，或已覆盖更新包并校验通过）。\n\n")
	if i := strings.Index(md, "\n## "); i >= 0 {
		return md[:i+1] + sec.String() + md[i+1:]
	}
	return strings.TrimRight(md, "\n") + "\n\n" + sec.String()
}

// confirmSyncApplied records that an engineer has ensured the updated files from sync #syncN
// are present on the controller (verified via the self-checking command, or legacy patch/full mode).
func (s *storeServer) confirmSyncApplied(jobID string, syncN int, user, mode string) (jobSync, error) {
	if mode == "" {
		mode = "verified"
	}
	if mode != "verified" && mode != "patch" && mode != "full" {
		return jobSync{}, fmt.Errorf("无效的确认方式")
	}
	s.jobPersistMu.Lock()
	defer s.jobPersistMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, ok := s.jobs[jobID]
	if !ok {
		return jobSync{}, fmt.Errorf("交付不存在")
	}
	idx := -1
	for i := range cur.Syncs {
		if cur.Syncs[i].N == syncN {
			idx = i
			break
		}
	}
	if idx < 0 {
		return jobSync{}, fmt.Errorf("找不到对应的更新记录")
	}
	if cur.Syncs[idx].Kind == "patch" && mode == "full" {
		return jobSync{}, fmt.Errorf("AI 补丁更新不会重打基础包，请在控制节点执行补丁覆盖命令后再确认")
	}
	nextSyncs := append([]jobSync(nil), cur.Syncs...)
	now := time.Now().UTC().Format(time.RFC3339)
	nextSyncs[idx].AppliedAt = now
	nextSyncs[idx].AppliedBy = user
	nextSyncs[idx].AppliedMode = mode
	cur.Syncs = nextSyncs
	if err := s.persistJob(cur); err != nil {
		return jobSync{}, err
	}
	s.jobs[jobID] = cur
	doc := s.readProgress(jobID)
	label := fmt.Sprintf("已在控制节点核对并应用第 %d 次同步更新（校验通过）", syncN)
	if nextSyncs[idx].Kind == "patch" {
		label = fmt.Sprintf("已在控制节点核对并应用第 %d 次 AI 补丁更新（校验通过）", syncN)
	} else if mode == "full" {
		label = fmt.Sprintf("确认第 %d 次同步已使用最新完整交付包（无需单独覆盖）", syncN)
	} else if mode == "patch" {
		label = fmt.Sprintf("确认第 %d 次同步文件已覆盖到控制节点", syncN)
	}
	doc.Events = append(doc.Events, progressEvent{
		At:    now,
		By:    user,
		Key:   fmt.Sprintf("sync-confirm-%d", syncN),
		Title: label,
		State: "sync",
	})
	_ = s.writeProgress(jobID, doc)
	return nextSyncs[idx], nil
}

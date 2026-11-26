package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing/fstest"
	"time"
)

// fileSetToFS builds an in-memory fs.FS containing top-level directory `name`
// populated with `files`, suitable for passing directly to mwpack.LoadCatalog.
func fileSetToFS(name string, files fileSet) fs.FS {
	m := fstest.MapFS{}
	for rel, data := range files {
		clean := strings.TrimPrefix(filepath.ToSlash(rel), "/")
		if clean == "" {
			continue
		}
		cp := make([]byte, len(data))
		copy(cp, data)
		m[name+"/"+clean] = &fstest.MapFile{
			Data: cp,
			Mode: 0o600,
		}
	}
	return m
}

// ---- Unified Setting Helpers (PostgreSQL primary, local file fallback for unit tests) ----

func (s *storeServer) loadSettingDoc(ns, fallbackPath string, out any) bool {
	if s.repo != nil {
		if ok, err := s.repo.loadSettingValue(ns, out); err == nil && ok {
			return true
		}
		if fallbackPath != "" {
			if b, err := os.ReadFile(fallbackPath); err == nil && json.Valid(b) && json.Unmarshal(b, out) == nil {
				_ = s.repo.saveSettingRaw(ns, b)
				return true
			}
		}
		return false
	}
	if fallbackPath == "" {
		return false
	}
	b, err := os.ReadFile(fallbackPath)
	if err != nil {
		return false
	}
	return json.Unmarshal(b, out) == nil
}

func (s *storeServer) saveSettingDoc(ns, fallbackPath string, val any) error {
	if s.repo != nil {
		return s.repo.saveSettingValue(ns, val)
	}
	if fallbackPath == "" {
		return nil
	}
	return writeJSONFile(fallbackPath, val)
}

func (s *storeServer) loadBinaryKeySetting(ns, fallbackPath string, wantLen int) ([]byte, bool) {
	if s.repo != nil {
		var wrap struct {
			KeyB64 string `json:"key_b64"`
		}
		if ok, err := s.repo.loadSettingValue(ns, &wrap); err == nil && ok && wrap.KeyB64 != "" {
			if raw, derr := base64.StdEncoding.DecodeString(wrap.KeyB64); derr == nil && (wantLen <= 0 || len(raw) == wantLen) {
				return raw, true
			}
		}
		return nil, false
	}
	if fallbackPath == "" {
		return nil, false
	}
	b, err := os.ReadFile(fallbackPath)
	if err != nil || (wantLen > 0 && len(b) != wantLen) {
		return nil, false
	}
	return b, true
}

func (s *storeServer) saveBinaryKeySetting(ns, fallbackPath string, key []byte) error {
	if s.repo != nil {
		return s.repo.saveSettingValue(ns, map[string]string{
			"key_b64": base64.StdEncoding.EncodeToString(key),
		})
	}
	if fallbackPath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(fallbackPath), 0o700); err != nil {
		return err
	}
	tmp := fallbackPath + ".tmp"
	if err := os.WriteFile(tmp, key, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, fallbackPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// ---- Job Spec, Plan, Lock & Structured Columns ----

func (s *storeServer) jobClusterID(jobID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if j, ok := s.jobs[jobID]; ok {
		return j.ClusterID
	}
	return ""
}

func (s *storeServer) readJobSpecBytes(jobID string) ([]byte, error) {
	if s.repo != nil {
		if b, ok, err := s.repo.getJobSpecYAML(jobID); err == nil && ok {
			return b, nil
		}
		// Lazy one-shot fallback & backfill if legacy file still exists on disk
		if s.cfg.DataDir != "" {
			if b, err := os.ReadFile(filepath.Join(s.jobDir(jobID), "deployment.yml")); err == nil && len(b) > 0 {
				_ = s.repo.upsertJobSpecYAML(jobID, s.jobClusterID(jobID), b)
				return b, nil
			}
		}
		return nil, os.ErrNotExist
	}
	return os.ReadFile(filepath.Join(s.jobDir(jobID), "deployment.yml"))
}

func (s *storeServer) writeJobSpecBytes(jobID, clusterID string, specYAML []byte) error {
	defer s.evictJobCaches(jobID)
	if s.repo != nil {
		if clusterID == "" {
			clusterID = s.jobClusterID(jobID)
		}
		return s.repo.upsertJobSpecYAML(jobID, clusterID, specYAML)
	}
	dir := s.jobDir(jobID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "deployment.yml"), specYAML, 0o600)
}

func (s *storeServer) readJobPlanBytes(jobID string) ([]byte, error) {
	if s.repo != nil {
		if b, ok, err := s.repo.getJobPlanJSON(jobID); err == nil && ok {
			return b, nil
		}
		if s.cfg.DataDir != "" {
			if b, err := os.ReadFile(filepath.Join(s.jobDir(jobID), "output", "plan.json")); err == nil && len(b) > 0 {
				lb, _ := os.ReadFile(filepath.Join(s.jobDir(jobID), "output", "deployment.lock.json"))
				_ = s.repo.upsertJobPlanAndLock(jobID, s.jobClusterID(jobID), b, lb)
				return b, nil
			}
		}
		return nil, os.ErrNotExist
	}
	return os.ReadFile(filepath.Join(s.jobDir(jobID), "output", "plan.json"))
}

func (s *storeServer) readJobLockBytes(jobID string) ([]byte, error) {
	if s.repo != nil {
		if b, ok, err := s.repo.getJobLockJSON(jobID); err == nil && ok {
			return b, nil
		}
		if s.cfg.DataDir != "" {
			if b, err := os.ReadFile(filepath.Join(s.jobDir(jobID), "output", "deployment.lock.json")); err == nil && len(b) > 0 {
				_ = s.repo.upsertJobPlanAndLock(jobID, s.jobClusterID(jobID), nil, b)
				return b, nil
			}
		}
		return nil, os.ErrNotExist
	}
	return os.ReadFile(filepath.Join(s.jobDir(jobID), "output", "deployment.lock.json"))
}

func (s *storeServer) writeJobPlanAndLock(jobID, clusterID string, planBytes, lockBytes []byte) error {
	defer s.evictJobCaches(jobID)
	if s.repo != nil {
		if clusterID == "" {
			clusterID = s.jobClusterID(jobID)
		}
		return s.repo.upsertJobPlanAndLock(jobID, clusterID, planBytes, lockBytes)
	}
	outDir := filepath.Join(s.jobDir(jobID), "output")
	if err := os.MkdirAll(outDir, 0o700); err != nil {
		return err
	}
	if len(planBytes) > 0 {
		if err := os.WriteFile(filepath.Join(outDir, "plan.json"), planBytes, 0o600); err != nil {
			return err
		}
	}
	if len(lockBytes) > 0 {
		if err := os.WriteFile(filepath.Join(outDir, "deployment.lock.json"), lockBytes, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (s *storeServer) loadJobDocValue(jobID, col, fallbackPath string, out any) bool {
	if s.repo != nil {
		if b, ok, err := s.repo.getJobDocCol(jobID, col); err == nil && ok {
			return json.Unmarshal(b, out) == nil
		}
		if fallbackPath != "" {
			if b, err := os.ReadFile(fallbackPath); err == nil && len(b) > 0 && json.Unmarshal(b, out) == nil {
				_ = s.repo.upsertJobDocCol(jobID, col, b)
				return true
			}
		}
		return false
	}
	if fallbackPath == "" {
		return false
	}
	b, err := os.ReadFile(fallbackPath)
	if err != nil {
		return false
	}
	return json.Unmarshal(b, out) == nil
}

func (s *storeServer) saveJobDocValue(jobID, col, fallbackPath string, val any) error {
	if s.repo != nil {
		if val == nil {
			return s.repo.upsertJobDocCol(jobID, col, nil)
		}
		b, err := json.Marshal(val)
		if err != nil {
			return err
		}
		return s.repo.upsertJobDocCol(jobID, col, b)
	}
	if fallbackPath == "" {
		return nil
	}
	if val == nil {
		_ = os.Remove(fallbackPath)
		return nil
	}
	return writeJSONFile(fallbackPath, val)
}

// ---- Startup Zero-Loss Idempotent Migration from Legacy DataDir YAML/JSON Files ----

func (s *storeServer) migrateLocalFilesToPostgres() {
	if s.repo == nil || s.cfg.DataDir == "" {
		return
	}
	const migKey = "full_pg_storage_v1"
	if s.repo.hasMigration(migKey) {
		s.migrateSettingsDirToPostgresV2()
		return
	}
	counts := map[string]int{}

	// 1. Migrate binary signing / encryption keys
	for _, kp := range []struct{ ns, rel string }{
		{"auth_signing_key", "auth_signing.key"},
		{"ai_encryption_key", "ai.key"},
	} {
		if _, _, err := s.repo.getSettingRaw(kp.ns); err == nil {
			if _, has := s.loadBinaryKeySetting(kp.ns, "", 32); !has {
				p := filepath.Join(s.cfg.DataDir, kp.rel)
				if b, rerr := os.ReadFile(p); rerr == nil && len(b) == 32 {
					if s.saveBinaryKeySetting(kp.ns, "", b) == nil {
						counts[kp.ns] = 1
					}
				}
			}
		}
	}

	// 2. Migrate sources.yaml -> settings("sources_yaml")
	if _, has, _ := s.repo.getSettingRaw("sources_yaml"); !has && s.cfg.SourcesFile != "" {
		if b, err := os.ReadFile(s.cfg.SourcesFile); err == nil && len(strings.TrimSpace(string(b))) > 0 {
			if s.repo.saveSettingValue("sources_yaml", map[string]string{"yaml": string(b)}) == nil {
				counts["sources_yaml"] = 1
			}
		}
	}

	// 3. Migrate JSON settings files
	jsonSettings := []struct{ ns, path string }{
		{"iam", filepath.Join(s.cfg.DataDir, "iam.json")},
		{"ai_settings", filepath.Join(s.cfg.DataDir, "ai.json")},
		{"ai_skills", filepath.Join(s.cfg.DataDir, "ai-skills.json")},
		{"ai_mcp", filepath.Join(s.cfg.DataDir, "ai-mcp.json")},
		{"library_tasks", filepath.Join(s.cfg.DataDir, "library-tasks.json")},
		{"notify_channels", filepath.Join(s.cfg.DataDir, "settings", "channels.json")},
		{"notify_log", filepath.Join(s.cfg.DataDir, "settings", "notify-log.json")},
		{"notify_templates", filepath.Join(s.cfg.DataDir, "settings", "notify-templates.json")},
		{"report_settings", filepath.Join(s.cfg.DataDir, "settings", "report.json")},
		{"storage_settings", filepath.Join(s.cfg.DataDir, "settings", "storage.json")},
		{"sandbox_settings", filepath.Join(s.cfg.DataDir, "settings", "sandbox.json")},
		{"security_meta", filepath.Join(s.cfg.DataDir, "security", "meta.json")},
		{"security_policy", filepath.Join(s.cfg.DataDir, "security", "policy.json")},
		{"security_waivers", filepath.Join(s.cfg.DataDir, "security", "baseline_waivers.json")},
		{"security_sources", filepath.Join(s.cfg.DataDir, "security", "sources.json")},
		{"security_report_templates", filepath.Join(s.cfg.DataDir, "security", "report-templates.json")},
	}
	for _, it := range jsonSettings {
		if _, has, _ := s.repo.getSettingRaw(it.ns); !has {
			if b, err := os.ReadFile(it.path); err == nil && json.Valid(b) {
				if s.repo.saveSettingRaw(it.ns, b) == nil {
					counts["settings"]++
				}
			}
		}
	}

	// 4. Migrate custom/override components, drafts, history, and verifications
	if s.cfg.ComponentsDir != "" {
		if entries, err := os.ReadDir(s.cfg.ComponentsDir); err == nil {
			for _, e := range entries {
				if !e.IsDir() {
					continue
				}
				dname := e.Name()
				if dname == ".platform" {
					if !s.repo.hasComponentSlot(sharedPlatformName, "live") {
						if set, rerr := readFileSetDir(filepath.Join(s.cfg.ComponentsDir, ".platform")); rerr == nil && len(set) > 0 {
							if s.repo.saveComponentSlot(sharedPlatformName, "live", 0, set, nil) == nil {
								counts["components_live"]++
							}
						}
					}
					continue
				}
				if strings.HasPrefix(dname, ".") {
					continue
				}
				if !s.repo.hasComponentSlot(dname, "live") {
					cdir := filepath.Join(s.cfg.ComponentsDir, dname)
					if st, serr := os.Stat(filepath.Join(cdir, "component.yaml")); serr == nil && st.Mode().IsRegular() {
						if set, rerr := readFileSetDir(cdir); rerr == nil {
							if s.repo.saveComponentSlot(dname, "live", 0, set, nil) == nil {
								counts["components_live"]++
							}
						}
					}
				}
			}
		}
		if entries, err := os.ReadDir(filepath.Join(s.cfg.ComponentsDir, ".work")); err == nil {
			for _, e := range entries {
				if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
					continue
				}
				name := e.Name()
				if !s.repo.hasComponentSlot(name, "draft") {
					wdir := filepath.Join(s.cfg.ComponentsDir, ".work", name)
					mb, merr := os.ReadFile(filepath.Join(wdir, "meta.json"))
					set, ferr := readFileSetDir(filepath.Join(wdir, "files"))
					if merr == nil && ferr == nil && json.Valid(mb) {
						if s.repo.saveComponentSlot(name, "draft", 0, set, mb) == nil {
							counts["components_draft"]++
						}
					}
				}
			}
		}
		if entries, err := os.ReadDir(filepath.Join(s.cfg.ComponentsDir, ".history")); err == nil {
			for _, e := range entries {
				if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
					continue
				}
				name := e.Name()
				revs, _ := os.ReadDir(filepath.Join(s.cfg.ComponentsDir, ".history", name))
				maxRev := 0
				for _, rv := range revs {
					n, nerr := strconv.Atoi(rv.Name())
					if !rv.IsDir() || nerr != nil {
						continue
					}
					slot := fmt.Sprintf("history:%04d", n)
					if n > maxRev {
						maxRev = n
					}
					if !s.repo.hasComponentSlot(name, slot) {
						rdir := filepath.Join(s.cfg.ComponentsDir, ".history", name, rv.Name())
						mb, merr := os.ReadFile(filepath.Join(rdir, "meta.json"))
						set, ferr := readFileSetDir(filepath.Join(rdir, "files"))
						if merr == nil && ferr == nil && json.Valid(mb) {
							_ = s.repo.saveComponentSlot(name, slot, n, set, mb)
							counts["components_history"]++
						}
					}
				}
				if maxRev > 0 {
					if live, ok, _ := s.repo.getComponentSlot(name, "live"); ok && live.Rev == 0 {
						_ = s.repo.saveComponentSlot(name, "live", maxRev, live.Files, live.Meta)
					}
				}
			}
		}
	}
	if vfiles, err := filepath.Glob(filepath.Join(s.cfg.DataDir, "comp-verifications", "*.json")); err == nil {
		for _, vf := range vfiles {
			cname := strings.TrimSuffix(filepath.Base(vf), ".json")
			if !s.repo.hasComponentSlot(cname, "verifications") {
				if b, rerr := os.ReadFile(vf); rerr == nil && json.Valid(b) {
					if s.repo.saveComponentSlot(cname, "verifications", 0, fileSet{}, b) == nil {
						counts["comp_verifications"]++
					}
				}
			}
		}
	}

	// 5. Migrate job specs (deployment.yml, plan.json, deployment.lock.json, progress, patches, proposals, amendments, run-logs)
	if jdirs, err := os.ReadDir(filepath.Join(s.cfg.DataDir, "jobs")); err == nil {
		for _, jd := range jdirs {
			if !jd.IsDir() || !storeJobID.MatchString(jd.Name()) {
				continue
			}
			jid := jd.Name()
			dir := filepath.Join(s.cfg.DataDir, "jobs", jid)
			cid := ""
			if jb, jerr := os.ReadFile(filepath.Join(dir, "job.json")); jerr == nil {
				var meta struct {
					ClusterID string `json:"cluster_id"`
				}
				_ = json.Unmarshal(jb, &meta)
				cid = meta.ClusterID
			}
			if _, has, _ := s.repo.getJobSpecYAML(jid); !has {
				if sb, serr := os.ReadFile(filepath.Join(dir, "deployment.yml")); serr == nil && len(sb) > 0 {
					_ = s.repo.upsertJobSpecYAML(jid, cid, sb)
					counts["job_specs"]++
				}
			}
			if _, has, _ := s.repo.getJobPlanJSON(jid); !has {
				pb, _ := os.ReadFile(filepath.Join(dir, "output", "plan.json"))
				lb, _ := os.ReadFile(filepath.Join(dir, "output", "deployment.lock.json"))
				if (len(pb) > 0 && json.Valid(pb)) || (len(lb) > 0 && json.Valid(lb)) {
					if !json.Valid(pb) {
						pb = nil
					}
					if !json.Valid(lb) {
						lb = nil
					}
					_ = s.repo.upsertJobPlanAndLock(jid, cid, pb, lb)
					counts["job_plans"]++
				}
			}
			for _, jc := range []struct{ col, rel string }{
				{"progress_json", "progress.json"},
				{"patches_json", "patches.json"},
				{"amendments_json", "amendments.json"},
				{"proposals_json", filepath.Join("ai", "proposals.json")},
			} {
				if _, has, _ := s.repo.getJobDocCol(jid, jc.col); !has {
					if cb, cerr := os.ReadFile(filepath.Join(dir, jc.rel)); cerr == nil && json.Valid(cb) {
						_ = s.repo.upsertJobDocCol(jid, jc.col, cb)
					}
				}
			}
			// Migrate run-logs/*.log into structured run_logs_json if present
			if _, has, _ := s.repo.getJobDocCol(jid, "run_logs_json"); !has {
				if lfiles, lerr := os.ReadDir(filepath.Join(dir, "run-logs")); lerr == nil && len(lfiles) > 0 {
					rawLogs := map[string]string{}
					for _, lf := range lfiles {
						if lf.IsDir() {
							continue
						}
						if lb, rerr := os.ReadFile(filepath.Join(dir, "run-logs", lf.Name())); rerr == nil {
							rawLogs[lf.Name()] = string(lb)
						}
					}
					if len(rawLogs) > 0 {
						if enc, merr := json.Marshal(rawLogs); merr == nil {
							_ = s.repo.upsertJobDocCol(jid, "run_logs_json", enc)
						}
					}
				}
			}
			// Migrate job AI sessions
			if sfiles, serr := filepath.Glob(filepath.Join(dir, "ai", "sessions", "*.json")); serr == nil {
				for _, sf := range sfiles {
					sid := strings.TrimSuffix(filepath.Base(sf), ".json")
					if b, rerr := os.ReadFile(sf); rerr == nil && json.Valid(b) {
						_ = s.repo.putKV("job_ai:"+jid, sid, "", b)
					}
				}
			}
		}
	}

	// 6. Migrate execution state, cluster automation configs & rehearsal tasks
	if _, has, _ := s.repo.getExecStateSlot("main"); !has {
		if b, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "execution", "state.json")); err == nil && json.Valid(b) {
			if s.repo.saveExecStateSlot("main", b) == nil {
				counts["exec_state"] = 1
			}
		}
	}
	if afiles, err := filepath.Glob(filepath.Join(s.cfg.DataDir, "automation", "*.json")); err == nil {
		for _, af := range afiles {
			cid := strings.TrimSuffix(filepath.Base(af), ".json")
			if _, has, _ := s.repo.getClusterAutomation(cid); !has {
				if b, rerr := os.ReadFile(af); rerr == nil && json.Valid(b) {
					if s.repo.saveClusterAutomation(cid, b) == nil {
						counts["cluster_automation"]++
					}
				}
			}
		}
	}
	if tdirs, err := os.ReadDir(filepath.Join(s.cfg.DataDir, "execution", "rehearsal_tasks")); err == nil {
		for _, td := range tdirs {
			if !td.IsDir() {
				continue
			}
			tfiles, _ := filepath.Glob(filepath.Join(s.cfg.DataDir, "execution", "rehearsal_tasks", td.Name(), "*.json"))
			for _, tf := range tfiles {
				var t rehearsalExecTask
				if b, rerr := os.ReadFile(tf); rerr == nil && json.Unmarshal(b, &t) == nil && t.ID != "" {
					if _, has, _ := s.repo.getRehearsalTask(t.ClusterID, t.ID); !has {
						if s.repo.saveRehearsalTask(t) == nil {
							counts["rehearsal_tasks"]++
						}
					}
				}
			}
		}
	}

	// 7. Migrate rehearsals & cluster docs
	if rdirs, err := os.ReadDir(filepath.Join(s.cfg.DataDir, "rehearsals")); err == nil {
		for _, rd := range rdirs {
			if !rd.IsDir() {
				continue
			}
			rfiles, _ := filepath.Glob(filepath.Join(s.cfg.DataDir, "rehearsals", rd.Name(), "*.json"))
			for _, rf := range rfiles {
				var rh changeRehearsal
				if b, rerr := os.ReadFile(rf); rerr == nil && json.Unmarshal(b, &rh) == nil && rh.ID != "" && rh.ClusterID != "" {
					if _, has, _ := s.repo.getRehearsal(rh.ClusterID, rh.ID); !has {
						if s.repo.saveRehearsal(rh) == nil {
							counts["rehearsals"]++
						}
					}
				}
			}
		}
	}
	if ddirs, err := os.ReadDir(filepath.Join(s.cfg.DataDir, "docs")); err == nil {
		for _, dd := range ddirs {
			if !dd.IsDir() {
				continue
			}
			cid := dd.Name()
			dfiles, _ := filepath.Glob(filepath.Join(s.cfg.DataDir, "docs", cid, "*.json"))
			for _, df := range dfiles {
				dkey := strings.TrimSuffix(filepath.Base(df), ".json")
				if _, has, _ := s.repo.getClusterDoc(cid, dkey); !has {
					if b, rerr := os.ReadFile(df); rerr == nil && json.Valid(b) {
						if s.repo.saveClusterDoc(cid, dkey, b) == nil {
							counts["cluster_docs"]++
						}
					}
				}
			}
		}
	}

	// 8. Migrate security advisories, scans & VEX triage
	for _, ss := range []struct{ slot, path string }{
		{"advisories", filepath.Join(s.cfg.DataDir, "security", "advisories.json")},
		{"latest", filepath.Join(s.cfg.DataDir, "security", "scans", "latest.json")},
		{"history", filepath.Join(s.cfg.DataDir, "security", "scans", "history.json")},
	} {
		if _, has, _ := s.repo.getSecScanSlot(ss.slot); !has {
			if b, rerr := os.ReadFile(ss.path); rerr == nil && json.Valid(b) {
				if s.repo.saveSecScanSlot(ss.slot, b) == nil {
					counts["sec_"+ss.slot] = 1
				}
			}
		}
	}
	if existingTriage, err := s.repo.loadSecTriageMap(); err == nil && len(existingTriage) == 0 {
		if b, rerr := os.ReadFile(filepath.Join(s.cfg.DataDir, "security", "triage.json")); rerr == nil {
			var list []secTriageRecord
			if json.Unmarshal(b, &list) == nil && len(list) > 0 {
				m := map[string]secTriageRecord{}
				for _, rec := range list {
					if rec.Key != "" {
						m[rec.Key] = rec
					}
				}
				if s.repo.replaceSecTriageMap(m) == nil {
					counts["sec_triage"] = len(m)
				}
			}
		}
	}

	// 9. Migrate Team KB, AI Chats, Portal Sessions, User Prefs & User File Metadata Indexes
	for _, kind := range []string{"docs", "submissions"} {
		kfiles, _ := filepath.Glob(filepath.Join(s.cfg.DataDir, "kb-team", kind, "*.json"))
		for _, kf := range kfiles {
			kid := strings.TrimSuffix(filepath.Base(kf), ".json")
			if b, rerr := os.ReadFile(kf); rerr == nil && json.Valid(b) {
				_ = s.repo.putKV("kb_team:"+kind, kid, "", b)
				counts["kb_team"]++
			}
		}
	}
	if udirs, err := os.ReadDir(filepath.Join(s.cfg.DataDir, "ai-chats")); err == nil {
		for _, ud := range udirs {
			if !ud.IsDir() {
				continue
			}
			cfiles, _ := filepath.Glob(filepath.Join(s.cfg.DataDir, "ai-chats", ud.Name(), "*.json"))
			for _, cf := range cfiles {
				cid := strings.TrimSuffix(filepath.Base(cf), ".json")
				if b, rerr := os.ReadFile(cf); rerr == nil && json.Valid(b) {
					_ = s.repo.putKV("ai_chats:"+ud.Name(), cid, "", b)
					counts["ai_chats"]++
				}
			}
		}
	}
	if pdirs, err := os.ReadDir(filepath.Join(s.cfg.DataDir, "ai-portal")); err == nil {
		for _, pd := range pdirs {
			if !pd.IsDir() {
				continue
			}
			sfiles, _ := filepath.Glob(filepath.Join(s.cfg.DataDir, "ai-portal", pd.Name(), "sessions", "*.json"))
			for _, sf := range sfiles {
				sid := strings.TrimSuffix(filepath.Base(sf), ".json")
				if b, rerr := os.ReadFile(sf); rerr == nil && json.Valid(b) {
					_ = s.repo.putKV("ai_portal:"+pd.Name(), sid, "", b)
				}
			}
		}
	}
	if fdirs, err := os.ReadDir(filepath.Join(s.cfg.DataDir, "files")); err == nil {
		for _, fd := range fdirs {
			if !fd.IsDir() {
				continue
			}
			idxPath := filepath.Join(s.cfg.DataDir, "files", fd.Name(), "index.json")
			if b, rerr := os.ReadFile(idxPath); rerr == nil && json.Valid(b) {
				_ = s.repo.putKV("user_file_index", fd.Name(), "", b)
				counts["user_file_index"]++
			}
		}
	}
	if udirs, err := os.ReadDir(filepath.Join(s.cfg.DataDir, "users")); err == nil {
		for _, ud := range udirs {
			if !ud.IsDir() {
				continue
			}
			prefPath := filepath.Join(s.cfg.DataDir, "users", ud.Name(), "ai-prefs.json")
			if b, rerr := os.ReadFile(prefPath); rerr == nil && json.Valid(b) {
				_ = s.repo.putKV("user_ai_prefs", ud.Name(), "", b)
			}
		}
	}

	_ = s.repo.recordMigration(migKey, counts)
	s.migrateSettingsDirToPostgresV2()
}

// migrateSettingsDirToPostgresV2 imports all settings, keys, AI providers/features, MCP servers,
// skills, pricing, sandbox, Team KB, per-user AI preferences/skills/MCP/files, and historical
// AI usage JSONL logs from s.settingsDir() (DataDir/settings/*) into PostgreSQL, ensuring
// configured AI capabilities are enabled out of the box without manual re-entry.
func (s *storeServer) migrateSettingsDirToPostgresV2() {
	if s.repo == nil || s.cfg.DataDir == "" {
		return
	}
	const migKey2 = "full_pg_storage_v2_ai_and_settings"
	if s.repo.hasMigration(migKey2) {
		s.syncSingleNodeComponentStepTitlesV3()
		return
	}
	counts := map[string]int{}

	readFirst := func(paths ...string) ([]byte, bool) {
		for _, p := range paths {
			if p == "" {
				continue
			}
			if b, err := os.ReadFile(p); err == nil && len(b) > 0 {
				return b, true
			}
		}
		return nil, false
	}

	// 1. Auth signing key & AI encryption key + AI settings (providers, models, features, web)
	if _, has := s.loadBinaryKeySetting("auth_signing_key", "", 32); !has {
		if b, ok := readFirst(filepath.Join(s.settingsDir(), "auth_signing.key"), filepath.Join(s.cfg.DataDir, "auth_signing.key")); ok && len(b) == 32 {
			if s.saveBinaryKeySetting("auth_signing_key", "", b) == nil {
				counts["auth_signing_key"] = 1
			}
		}
	}

	var pgAI aiSettings
	hasPGAI, _ := s.repo.loadSettingValue("ai_settings", &pgAI)
	if !hasPGAI || len(pgAI.Providers) == 0 {
		// Restore the authentic 32-byte ai.key from settings/ai.key BEFORE decrypting/using ai.json or ai-mcp.json,
		// overwriting any empty-state random key generated before settings/ai.key was migrated.
		if kb, ok := readFirst(s.aiFile("ai.key"), filepath.Join(s.cfg.DataDir, "ai.key")); ok && len(kb) == 32 {
			if s.saveBinaryKeySetting("ai_encryption_key", "", kb) == nil {
				counts["ai_encryption_key"] = 1
			}
		}
		if ab, ok := readFirst(s.aiFile("ai.json"), filepath.Join(s.cfg.DataDir, "ai.json")); ok && json.Valid(ab) {
			var diskAI aiSettings
			if json.Unmarshal(ab, &diskAI) == nil {
				for i := range diskAI.Providers {
					diskAI.Providers[i].migrate()
				}
				if diskAI.Features == nil {
					diskAI.Features = map[string]aiFeature{}
				}
				if len(diskAI.Providers) > 0 {
					diskAI.Enabled = true
					for _, f := range aiFeatures {
						cur := diskAI.Features[f.ID]
						cur.Enabled = true
						diskAI.Features[f.ID] = cur
					}
				}
				if s.repo.saveSettingValue("ai_settings", diskAI) == nil {
					counts["ai_settings"] = 1
				}
			}
		}
	} else if len(pgAI.Providers) > 0 && !pgAI.Enabled {
		pgAI.Enabled = true
		if pgAI.Features == nil {
			pgAI.Features = map[string]aiFeature{}
		}
		for _, f := range aiFeatures {
			cur := pgAI.Features[f.ID]
			cur.Enabled = true
			pgAI.Features[f.ID] = cur
		}
		if s.repo.saveSettingValue("ai_settings", pgAI) == nil {
			counts["ai_settings_enabled"] = 1
		}
	}

	// 2. Migrate settingsDir JSON configs (IAM, MCP, Skills, Prices, Sandbox, Report, Storage, Notify)
	for _, it := range []struct {
		ns    string
		paths []string
	}{
		{"iam", []string{s.iamFile(), filepath.Join(s.cfg.DataDir, "iam.json")}},
		{"ai_mcp", []string{s.aiFile("ai-mcp.json"), filepath.Join(s.cfg.DataDir, "ai-mcp.json")}},
		{"ai_skills", []string{s.aiFile("ai-skills.json"), filepath.Join(s.cfg.DataDir, "ai-skills.json")}},
		{"ai_prices", []string{s.pricesPath(), filepath.Join(s.cfg.DataDir, "ai-prices.json")}},
		{"sandbox_settings", []string{filepath.Join(s.settingsDir(), "sandbox.json"), filepath.Join(s.cfg.DataDir, "sandbox.json")}},
		{"report_settings", []string{filepath.Join(s.settingsDir(), "report.json"), filepath.Join(s.cfg.DataDir, "report.json")}},
		{"storage_settings", []string{filepath.Join(s.settingsDir(), "storage.json"), filepath.Join(s.cfg.DataDir, "storage.json")}},
		{"notify_channels", []string{filepath.Join(s.settingsDir(), "channels.json")}},
		{"notify_log", []string{filepath.Join(s.settingsDir(), "notify-log.json")}},
		{"notify_templates", []string{filepath.Join(s.settingsDir(), "notify-templates.json")}},
	} {
		if _, has, _ := s.repo.getSettingRaw(it.ns); !has {
			if b, ok := readFirst(it.paths...); ok && json.Valid(b) {
				if s.repo.saveSettingRaw(it.ns, b) == nil {
					counts[it.ns] = 1
				}
			}
		}
	}

	// 3. Migrate Team KB (settings/kb-team/{docs,submissions}/*.json)
	for _, kind := range []string{"docs", "submissions"} {
		kfiles, _ := filepath.Glob(filepath.Join(s.teamKBDir(kind), "*.json"))
		for _, kf := range kfiles {
			kid := strings.TrimSuffix(filepath.Base(kf), ".json")
			if _, has, _ := s.repo.getKV("kb_team:"+kind, kid); !has {
				if b, rerr := os.ReadFile(kf); rerr == nil && json.Valid(b) {
					var tsMeta struct {
						Updated string `json:"updated"`
						At      string `json:"at"`
					}
					_ = json.Unmarshal(b, &tsMeta)
					sortTS := tsMeta.Updated
					if sortTS == "" {
						sortTS = tsMeta.At
					}
					if s.repo.putKV("kb_team:"+kind, kid, sortTS, b) == nil {
						counts["kb_team"]++
					}
				}
			}
		}
	}

	// 4. Migrate per-user AI prefs, personal skills, personal MCP & file indexes (settings/users/<user>/*)
	for _, usersRoot := range []string{s.aiFile("users"), filepath.Join(s.cfg.DataDir, "users")} {
		udirs, err := os.ReadDir(usersRoot)
		if err != nil {
			continue
		}
		for _, ud := range udirs {
			if !ud.IsDir() || !userNameOK(ud.Name()) {
				continue
			}
			uname := ud.Name()
			base := filepath.Join(usersRoot, uname)
			for _, uf := range []struct{ scope, rel string }{
				{"user_ai_prefs", "ai-prefs.json"},
				{"user_ai_skills", "skills.json"},
				{"user_ai_mcp", "mcp.json"},
				{"user_file_index", filepath.Join("files", "index.json")},
			} {
				if _, has, _ := s.repo.getKV(uf.scope, uname); !has {
					if b, rerr := os.ReadFile(filepath.Join(base, uf.rel)); rerr == nil && json.Valid(b) {
						if s.repo.putKV(uf.scope, uname, "", b) == nil {
							counts[uf.scope]++
						}
					}
				}
			}
		}
	}

	// 5. Migrate historical AI usage logs (settings/ai-usage/*.jsonl) -> middleware_store_ai_usage
	if ufiles, err := filepath.Glob(filepath.Join(s.usageDir(), "*.jsonl")); err == nil {
		for _, uf := range ufiles {
			b, rerr := os.ReadFile(uf)
			if rerr != nil || len(b) == 0 {
				continue
			}
			for _, line := range strings.Split(string(b), "\n") {
				line = strings.TrimSpace(line)
				if line == "" {
					continue
				}
				var u aiUsage
				if json.Unmarshal([]byte(line), &u) == nil && len(u.At) >= 7 {
					if u.ID == "" {
						u.ID = u.At + "-" + u.User + "-" + u.Model
					}
					if s.repo.saveAIUsage(u) == nil {
						counts["ai_usage"]++
					}
				}
			}
		}
	}

	// 6. Migrate component warning ignores (DataDir/comp-ignores/*.json)
	if igFiles, err := filepath.Glob(filepath.Join(s.cfg.DataDir, "comp-ignores", "*.json")); err == nil {
		for _, igf := range igFiles {
			cname := strings.TrimSuffix(filepath.Base(igf), ".json")
			if _, has, _ := s.repo.getKV("comp_ignores", cname); !has {
				if b, rerr := os.ReadFile(igf); rerr == nil && json.Valid(b) {
					if s.repo.putKV("comp_ignores", cname, "", b) == nil {
						counts["comp_ignores"]++
					}
				}
			}
		}
	}

	_ = s.repo.recordMigration(migKey2, counts)
	s.syncSingleNodeComponentStepTitlesV3()
}

// syncSingleNodeComponentStepTitlesV3 patches already-generated single-node plan_json rows
// in middleware_store_job_specs (and disk plan.json if present) so single-node deployments
// never display misleading HA/Patroni/Sentinel step titles.
func (s *storeServer) syncSingleNodeComponentStepTitlesV3() {
	if s.repo == nil || s.repo.db == nil {
		return
	}
	const migKey3 = "single_node_step_titles_v3"
	if s.repo.hasMigration(migKey3) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	counts := map[string]int{}

	if rows, err := s.repo.db.QueryContext(ctx, `SELECT job_id, plan_json FROM middleware_store_job_specs WHERE plan_json IS NOT NULL`); err == nil {
		type planFix struct {
			jobID string
			plan  []byte
		}
		var fixes []planFix
		for rows.Next() {
			var jobID string
			var raw []byte
			if rows.Scan(&jobID, &raw) != nil || len(raw) == 0 {
				continue
			}
			sraw := string(raw)
			if !strings.Contains(sraw, "写入数据库与高可用配置") && !strings.Contains(sraw, "写入实例、哨兵与日志切割配置") {
				continue
			}
			var doc map[string]any
			if json.Unmarshal(raw, &doc) != nil {
				continue
			}
			hosts, _ := doc["hosts"].([]any)
			if len(hosts) != 1 && !strings.Contains(sraw, "启动单节点") {
				continue
			}
			changed := false
			if phases, ok := doc["deploy"].([]any); ok {
				for _, phAny := range phases {
					ph, _ := phAny.(map[string]any)
					steps, _ := ph["steps"].([]any)
					for _, stAny := range steps {
						st, _ := stAny.(map[string]any)
						if st == nil {
							continue
						}
						switch st["title"] {
						case "写入数据库与高可用配置":
							st["title"] = "写入数据库配置"
							st["desc"] = "初始化单节点数据库目录，写入 postgresql.conf、pg_hba.conf 与 systemd 覆盖项。"
							st["expect"] = "部署归属标记及单节点 PostgreSQL 配置已写入。"
							changed = true
						case "写入实例、哨兵与日志切割配置":
							st["title"] = "写入实例与日志切割配置"
							st["desc"] = "备份包自带配置后写入单节点 redis.conf、systemd 覆盖项与 logrotate。"
							st["expect"] = "单节点 redis.conf 与 systemd/logrotate 配置已写入并校验通过。"
							changed = true
						}
					}
				}
			}
			if changed {
				if b, merr := json.Marshal(doc); merr == nil {
					fixes = append(fixes, planFix{jobID: jobID, plan: b})
				}
			}
		}
		rows.Close()
		for _, fx := range fixes {
			if _, uerr := s.repo.db.ExecContext(ctx, `UPDATE middleware_store_job_specs SET plan_json=$2, updated_at=now() WHERE job_id=$1`, fx.jobID, fx.plan); uerr == nil {
				counts["single_node_plans"]++
			}
			if s.cfg.DataDir != "" {
				p := filepath.Join(s.cfg.DataDir, "jobs", fx.jobID, "output", "plan.json")
				if _, serr := os.Stat(p); serr == nil {
					_ = os.WriteFile(p, fx.plan, 0o644)
				}
			}
		}
	}

	_ = s.repo.recordMigration(migKey3, counts)
}

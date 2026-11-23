package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
	"middleware-deployer/mwpack"
)

// consolidateLegacyChangeDeliveries is an idempotent startup migration for databases upgraded from
// older multi-delivery releases where post-deployment changes were stored as seq > 0 jobs with a
// non-null `change:` block in deployment.yml.
//
// In the single-delivery + Change Rehearsal architecture, each cluster has one initial deployment
// baseline. For any cluster that still carries retired legacy change jobs alongside a seq == 0
// initial deployment:
//   - Finished (done / deviated) legacy change jobs have their effective spec changes (params,
//     addons, binds, versions, hosts/placement), plan.json endpoints/fronts/ports/params, and any
//     AI chat sessions/images merged cleanly into the seq == 0 initial deployment, then the
//     redundant legacy change job is removed.
//   - Explicitly voided or failed legacy change jobs (never executed on production) are pruned
//     WITHOUT merging their config into the baseline.
//   - Active/unconfirmed jobs or non-change pre-deployment revisions (seq == 0) are never touched.
func (s *storeServer) consolidateLegacyChangeDeliveries() {
	s.mu.Lock()
	byCluster := map[string][]storeJob{}
	for _, j := range s.jobs {
		if j.ClusterID != "" {
			byCluster[j.ClusterID] = append(byCluster[j.ClusterID], j)
		}
	}
	s.mu.Unlock()

	for cid, jobs := range byCluster {
		if len(jobs) < 2 {
			continue
		}
		sortJobs(jobs)

		// Skip clusters with any active generation job.
		busy := false
		for _, j := range jobs {
			if j.State == "queued" || j.State == "running" {
				busy = true
				break
			}
		}
		if busy {
			continue
		}

		// Find the seq == 0 non-legacy initial deployment and any seq > 0 legacy change jobs.
		var base storeJob
		hasBase := false
		var legacy []storeJob
		for _, j := range jobs {
			if s.isLegacyChangeJob(j) {
				legacy = append(legacy, j)
				continue
			}
			if j.Seq == 0 && j.State == "succeeded" && j.Outcome != outcomeVoid {
				if !hasBase || j.finished() || !base.finished() {
					base = j
					hasBase = true
				}
			}
		}
		if !hasBase || len(legacy) == 0 {
			continue
		}

		mergedAny := false
		for _, leg := range legacy {
			switch {
			case leg.finished():
				if err := s.mergeLegacyChangeIntoBase(&base, leg); err != nil {
					log.Printf("legacy-change-consolidate: cluster %s merge %s -> %s skipped: %v", cid, leg.ID, base.ID, err)
					continue
				}
				mergedAny = true
				if code, msg := s.deleteJobData(leg.ID); code != 0 {
					log.Printf("legacy-change-consolidate: cluster %s delete merged legacy job %s failed (%d): %s", cid, leg.ID, code, msg)
					continue
				}
				s.audit("legacy-change-consolidate", "system", base.ID+" <- "+leg.ID+" (merged)")
				log.Printf("legacy-change-consolidate: cluster %s merged legacy change %s into initial delivery %s and removed legacy job", cid, leg.ID[:8], base.ID[:8])

			case leg.Outcome == outcomeVoid || leg.State == "failed":
				// Never merge unapplied void/failed config into the baseline; preserve any AI chats first, then prune.
				s.migrateLegacyJobAI(leg.ID, base.ID)
				if code, msg := s.deleteJobData(leg.ID); code != 0 {
					log.Printf("legacy-change-consolidate: cluster %s prune void/failed legacy job %s failed (%d): %s", cid, leg.ID, code, msg)
					continue
				}
				reason := leg.Outcome
				if reason == "" {
					reason = leg.State
				}
				s.audit("legacy-change-consolidate", "system", base.ID+" x "+leg.ID+" (pruned "+reason+")")
				log.Printf("legacy-change-consolidate: cluster %s pruned unapplied legacy change %s (%s)", cid, leg.ID[:8], reason)
			}
		}

		if mergedAny {
			s.evictJobCaches(base.ID)
			s.mu.Lock()
			s.jobs[base.ID] = base
			s.mu.Unlock()
			if err := s.persistJob(base); err != nil {
				log.Printf("legacy-change-consolidate: cluster %s persist base %s failed: %v", cid, base.ID, err)
			}
		}
	}
}

func (s *storeServer) isLegacyChangeJob(j storeJob) bool {
	if j.Seq <= 0 {
		return false
	}
	b, err := os.ReadFile(filepath.Join(s.jobDir(j.ID), "deployment.yml"))
	if err != nil {
		return false
	}
	var raw map[string]any
	if err := yaml.Unmarshal(b, &raw); err != nil || raw == nil {
		return false
	}
	return raw["change"] != nil
}

func (s *storeServer) mergeLegacyChangeIntoBase(base *storeJob, leg storeJob) error {
	baseDir := s.jobDir(base.ID)
	legDir := s.jobDir(leg.ID)

	baseSpecPath := filepath.Join(baseDir, "deployment.yml")
	legSpecPath := filepath.Join(legDir, "deployment.yml")
	baseBytes, err := os.ReadFile(baseSpecPath)
	if err != nil {
		return err
	}
	legBytes, err := os.ReadFile(legSpecPath)
	if err != nil {
		return err
	}
	baseDep, err := mwpack.ParseSavedDeployment(baseBytes)
	if err != nil {
		return err
	}
	legDep, err := mwpack.ParseSavedDeployment(legBytes)
	if err != nil {
		return err
	}

	basePlanPath := filepath.Join(baseDir, "output", "plan.json")
	legPlanPath := filepath.Join(legDir, "output", "plan.json")
	baseAutoIDs := readPlanAutoInstanceIDs(basePlanPath)

	// 1. Merge effective deployment.yml (preserving initial deployment hosts[*].initialize and clean schema).
	mergeDeploymentSpecs(baseDep, legDep, baseAutoIDs)
	mergedYAML, err := yaml.Marshal(baseDep)
	if err != nil {
		return err
	}
	if err := writeBytesAtomic(baseSpecPath, mergedYAML, 0o600); err != nil {
		return err
	}
	baseOutSpecPath := filepath.Join(baseDir, "output", "部署规格.yml")
	if fileExistsRegular(baseOutSpecPath) {
		_ = writeBytesAtomic(baseOutSpecPath, mergedYAML, 0o600)
	}

	// 2. Merge effective instance state (params, endpoints, fronts, ports, roles, version) into base output/plan.json
	//    while keeping base's initial deployment runbooks (prepare/deploy/tests/endpoint_tests/cleanup) intact.
	if err := mergeLegacyPlanJSON(basePlanPath, legPlanPath); err != nil {
		log.Printf("legacy-change-consolidate: merge plan.json %s -> %s warning: %v", leg.ID[:8], base.ID[:8], err)
	}

	// 3. Migrate any AI chat sessions and images from legacy job into base job so no history is lost.
	s.migrateLegacyJobAI(leg.ID, base.ID)

	// 4. Sync job-level metadata (version & deviation notes if any).
	if leg.AppID == base.AppID && strings.TrimSpace(leg.Version) != "" {
		base.Version = leg.Version
	}
	if note := strings.TrimSpace(leg.OutcomeNote); note != "" && !strings.Contains(base.OutcomeNote, note) {
		if strings.TrimSpace(base.OutcomeNote) == "" {
			base.OutcomeNote = note
		} else {
			base.OutcomeNote = strings.TrimSpace(base.OutcomeNote) + "；" + note
		}
	}
	return nil
}

func readPlanAutoInstanceIDs(planPath string) map[string]bool {
	out := map[string]bool{}
	b, err := os.ReadFile(planPath)
	if err != nil {
		return out
	}
	var p map[string]any
	if json.Unmarshal(b, &p) != nil {
		return out
	}
	insts, _ := p["instances"].([]any)
	for _, raw := range insts {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if auto, _ := m["auto"].(bool); auto {
			if id, _ := m["id"].(string); id != "" {
				out[id] = true
			}
		}
	}
	return out
}

func mergeDeploymentSpecs(base, leg *mwpack.Deployment, baseAutoIDs map[string]bool) {
	// Keep initial deployment host initialize flags; append any newly added hosts from legacy change.
	haveHost := map[string]bool{}
	for _, h := range base.Hosts {
		haveHost[h.Name] = true
	}
	for _, lh := range leg.Hosts {
		if !haveHost[lh.Name] {
			base.Hosts = append(base.Hosts, lh)
			haveHost[lh.Name] = true
		}
	}

	idxByID := map[string]int{}
	for i, bi := range base.Instances {
		idxByID[bi.ID] = i
	}
	for _, li := range leg.Instances {
		if idx, exists := idxByID[li.ID]; exists {
			bi := &base.Instances[idx]
			if strings.TrimSpace(li.Version) != "" {
				bi.Version = li.Version
			}
			if len(li.Placement) > 0 {
				bi.Placement = li.Placement
			}
			if len(li.Params) > 0 {
				if bi.Params == nil {
					bi.Params = map[string]any{}
				}
				for k, v := range li.Params {
					bi.Params[k] = v
				}
			}
			if len(li.Uses) > 0 {
				if bi.Uses == nil {
					bi.Uses = map[string]string{}
				}
				for k, v := range li.Uses {
					bi.Uses[k] = v
				}
			}
			if len(li.Binds) > 0 {
				bi.Binds = li.Binds
			}
			if len(li.Addons) > 0 {
				bi.Addons = mergeAddonSels(bi.Addons, li.Addons)
			}
			continue
		}
		// Avoid polluting deployment.yml with an auto-generated helper instance (e.g. pg-dcs) that had no custom overrides.
		if baseAutoIDs[li.ID] && len(li.Params) == 0 && len(li.Addons) == 0 && len(li.Binds) == 0 && len(li.Uses) == 0 {
			continue
		}
		base.Instances = append(base.Instances, li)
		idxByID[li.ID] = len(base.Instances) - 1
	}
}

func mergeAddonSels(base, extra []mwpack.AddonSel) []mwpack.AddonSel {
	out := make([]mwpack.AddonSel, 0, len(base)+len(extra))
	idxByID := map[string]int{}
	for _, a := range base {
		idxByID[a.ID] = len(out)
		out = append(out, a)
	}
	for _, a := range extra {
		if idx, ok := idxByID[a.ID]; ok {
			out[idx] = a
		} else {
			idxByID[a.ID] = len(out)
			out = append(out, a)
		}
	}
	return out
}

func mergeLegacyPlanJSON(basePath, legPath string) error {
	baseBytes, err := os.ReadFile(basePath)
	if err != nil {
		return err
	}
	legBytes, err := os.ReadFile(legPath)
	if err != nil {
		return err
	}
	var basePlan, legPlan map[string]any
	if err := json.Unmarshal(baseBytes, &basePlan); err != nil {
		return err
	}
	if err := json.Unmarshal(legBytes, &legPlan); err != nil {
		return err
	}

	// Merge hosts list (append any newly added host).
	if legHosts, ok := legPlan["hosts"].([]any); ok && len(legHosts) > 0 {
		baseHosts, _ := basePlan["hosts"].([]any)
		seen := map[string]bool{}
		for _, raw := range baseHosts {
			if hm, ok := raw.(map[string]any); ok {
				if n, _ := hm["name"].(string); n != "" {
					seen[n] = true
				}
			}
		}
		for _, raw := range legHosts {
			if hm, ok := raw.(map[string]any); ok {
				if n, _ := hm["name"].(string); n != "" && !seen[n] {
					baseHosts = append(baseHosts, hm)
					seen[n] = true
				}
			}
		}
		basePlan["hosts"] = baseHosts
	}

	// Merge instances' effective runtime properties while preserving sync-added params & base runbooks.
	baseInsts, _ := basePlan["instances"].([]any)
	legInsts, _ := legPlan["instances"].([]any)
	byID := map[string]map[string]any{}
	for _, raw := range baseInsts {
		if m, ok := raw.(map[string]any); ok {
			if id, _ := m["id"].(string); id != "" {
				byID[id] = m
			}
		}
	}
	for _, raw := range legInsts {
		lm, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id, _ := lm["id"].(string)
		if id == "" {
			continue
		}
		bm, exists := byID[id]
		if !exists {
			baseInsts = append(baseInsts, lm)
			byID[id] = lm
			continue
		}
		if v, _ := lm["version"].(string); v != "" {
			bm["version"] = v
		}
		if roles, ok := lm["roles"].(map[string]any); ok && len(roles) > 0 {
			bm["roles"] = roles
		}
		if hosts, ok := lm["hosts"].([]any); ok && len(hosts) > 0 {
			bm["hosts"] = hosts
		}
		if lParams, ok := lm["params"].(map[string]any); ok && len(lParams) > 0 {
			bParams, _ := bm["params"].(map[string]any)
			if bParams == nil {
				bParams = map[string]any{}
			}
			for k, v := range lParams {
				bParams[k] = v
			}
			bm["params"] = bParams
		}
		if lVis, ok := lm["visible"].(map[string]any); ok && len(lVis) > 0 {
			bVis, _ := bm["visible"].(map[string]any)
			if bVis == nil {
				bVis = map[string]any{}
			}
			for k, v := range lVis {
				bVis[k] = v
			}
			bm["visible"] = bVis
		}
		if eps, ok := lm["endpoints"].([]any); ok && len(eps) > 0 {
			bm["endpoints"] = eps
		}
		if fronts, ok := lm["fronts"].(map[string]any); ok && len(fronts) > 0 {
			bm["fronts"] = fronts
		}
		if ports, ok := lm["ports"].([]any); ok && len(ports) > 0 {
			bm["ports"] = ports
		}
	}
	basePlan["instances"] = baseInsts

	out, err := json.MarshalIndent(basePlan, "", "  ")
	if err != nil {
		return err
	}
	return writeBytesAtomic(basePath, out, 0o600)
}

func writeBytesAtomic(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *storeServer) migrateLegacyJobAI(fromJobID, toJobID string) {
	fromAI := s.aiDir(fromJobID)
	toAI := s.aiDir(toJobID)

	// 1. Copy any AI chat images that don't already exist on base job.
	if imgEntries, err := os.ReadDir(filepath.Join(fromAI, "img")); err == nil && len(imgEntries) > 0 {
		dstImgDir := filepath.Join(toAI, "img")
		_ = os.MkdirAll(dstImgDir, 0o700)
		for _, e := range imgEntries {
			if e.IsDir() {
				continue
			}
			dst := filepath.Join(dstImgDir, e.Name())
			if fileExistsRegular(dst) {
				continue
			}
			if b, err := os.ReadFile(filepath.Join(fromAI, "img", e.Name())); err == nil {
				_ = os.WriteFile(dst, b, 0o600)
			}
		}
	}

	// 2. Copy non-empty AI sessions, re-keying on collision so neither base nor legacy chats are overwritten.
	sessFiles, _ := filepath.Glob(filepath.Join(fromAI, "sessions", "*.json"))
	for _, f := range sessFiles {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var ss aiSession
		if json.Unmarshal(b, &ss) != nil || len(ss.Messages) == 0 {
			continue
		}
		if ss.Key == "" {
			ss.Key = "review"
		}
		dstID := sessionID(ss.Key)
		dstPath := filepath.Join(toAI, "sessions", dstID+".json")
		if fileExistsRegular(dstPath) {
			suffix := ss.ID
			if len(suffix) > 8 {
				suffix = suffix[:8]
			}
			if suffix == "" {
				suffix = fromJobID[:8]
			}
			ss.Key = "review:leg" + strings.ToLower(suffix)
			ss.ID = sessionID(ss.Key)
			dstPath = filepath.Join(toAI, "sessions", ss.ID+".json")
		} else {
			ss.ID = dstID
		}
		if !fileExistsRegular(dstPath) {
			_ = writeJSONFile(dstPath, ss)
		}
	}
}

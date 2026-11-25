package server

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Direct human delivery file hotfix layer (delivery.run):
// Shares the exact same patches.json + cumulative update-N-*.tar.gz + SHA256 verification infrastructure as AI file
// proposals (ai_patch.go), so both human edits and AI fixes work identically for automated execution (auto-pushed into
// .hub-<runID> on next step resume) and offline manual execution (one-line controller patch command).

type deliveryFileItem struct {
	Path      string `json:"path"`
	Size      int    `json:"size"`
	Related   bool   `json:"related,omitempty"` // directly referenced by the selected step
	Patched   bool   `json:"patched,omitempty"`
	PatchID   string `json:"patch_id,omitempty"`
	PatchBy   string `json:"patch_by,omitempty"`
	PatchAt   string `json:"patch_at,omitempty"`
	PatchNote string `json:"patch_note,omitempty"`
	Added     int    `json:"added,omitempty"`
	Deleted   int    `json:"deleted,omitempty"`
}

func splitDiffLines(s string) []string {
	if s == "" {
		return nil
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.TrimSuffix(s, "\n")
	return strings.Split(s, "\n")
}

// lineDiffCounts returns exact added/deleted line counts between two texts using prefix/suffix
// trimming and O(min(n,m))-space LCS DP (gracefully falling back on very large files).
func lineDiffCounts(before, after string) (added, deleted int) {
	if before == after {
		return 0, 0
	}
	a := splitDiffLines(before)
	b := splitDiffLines(after)
	start := 0
	for start < len(a) && start < len(b) && a[start] == b[start] {
		start++
	}
	ea := len(a) - 1
	eb := len(b) - 1
	for ea >= start && eb >= start && a[ea] == b[eb] {
		ea--
		eb--
	}
	la := ea - start + 1
	lb := eb - start + 1
	if la <= 0 && lb <= 0 {
		return 0, 0
	}
	if la <= 0 {
		return lb, 0
	}
	if lb <= 0 {
		return 0, la
	}
	if la*lb > 4_000_000 {
		return lb, la
	}
	subA := a[start : ea+1]
	subB := b[start : eb+1]
	if len(subB) > len(subA) {
		subA, subB = subB, subA
	}
	prev := make([]int, len(subB)+1)
	curr := make([]int, len(subB)+1)
	for i := 1; i <= len(subA); i++ {
		for j := 1; j <= len(subB); j++ {
			if subA[i-1] == subB[j-1] {
				curr[j] = prev[j-1] + 1
			} else if prev[j] >= curr[j-1] {
				curr[j] = prev[j]
			} else {
				curr[j] = curr[j-1]
			}
		}
		prev, curr = curr, prev
		clear(curr)
	}
	lcs := prev[len(subB)]
	return lb - lcs, la - lcs
}

var reRoleRef = regexp.MustCompile(`(?m)^\s*-\s*(?:role:\s*)?([a-zA-Z0-9_-]+)\s*$`)

// rawTarProjectFiles reads the original unpatched project files directly from the delivery tar.
func (s *storeServer) rawTarProjectFiles(id string) (map[string][]byte, error) {
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
	defer gz.Close()
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
	return out, nil
}

// stepRelatedFiles determines which project files are directly executed or read by a given runbook step key.
func (s *storeServer) stepRelatedFiles(jobID, stepKey string, files map[string][]byte) map[string]bool {
	rel := map[string]bool{}
	if stepKey == "" {
		return rel
	}
	var pbPath string
	for _, tab := range s.runbookSteps(jobID) {
		for _, st := range tab.Steps {
			if st.Key == stepKey {
				if st.Playbook != "" {
					pbPath = st.Playbook
				} else if len(st.Parts) > 0 && st.Parts[0].Playbook != "" {
					pbPath = st.Parts[0].Playbook
				}
				break
			}
		}
	}
	if pbPath == "" {
		return rel
	}
	pbPath = path.Clean(pbPath)
	rel[pbPath] = true
	rel["inventory/group_vars/all.yml"] = true
	if raw, ok := files[pbPath]; ok {
		text := string(raw)
		// Parse role references inside the playbook (e.g. "- role: nginx" or "roles:\n  - keepalived").
		roleNames := map[string]bool{}
		for _, m := range reRoleRef.FindAllStringSubmatch(text, -1) {
			if len(m) > 1 {
				roleNames[m[1]] = true
			}
		}
		// Also inspect YAML structure for include_role / import_role / roles lists.
		var plays []map[string]any
		if yaml.Unmarshal(raw, &plays) == nil {
			var scanRoles func(v any)
			scanRoles = func(v any) {
				switch x := v.(type) {
				case map[string]any:
					if rn, ok := x["role"].(string); ok && rn != "" {
						roleNames[rn] = true
					}
					if rn, ok := x["name"].(string); ok && rn != "" {
						if _, hasIR := x["include_role"]; hasIR {
							roleNames[rn] = true
						}
					}
					if roles, ok := x["roles"].([]any); ok {
						for _, item := range roles {
							switch r := item.(type) {
							case string:
								roleNames[r] = true
							case map[string]any:
								if rn, ok := r["role"].(string); ok && rn != "" {
									roleNames[rn] = true
								}
							}
						}
					}
					for _, ch := range x {
						scanRoles(ch)
					}
				case []any:
					for _, ch := range x {
						scanRoles(ch)
					}
				}
			}
			scanRoles(plays)
		}
		for fp := range files {
			for rn := range roleNames {
				if strings.HasPrefix(fp, "roles/"+rn+"/") {
					rel[fp] = true
				}
			}
			// Check import_playbook / include_tasks direct relative path references.
			if strings.Contains(text, fp) {
				rel[fp] = true
			}
		}
	}
	return rel
}

// buildCumulativeUpdateArchive builds update-N-<project>.tar.gz covering all active patches and prior sync files,
// computes SHA256 + verify command, appends jobSync, and persists the updated job.
func (s *storeServer) persistDeliveryPatchSync(j storeJob, user, kind, reason string, changedFiles []string) (jobSync, error) {
	n := len(j.Syncs) + 1
	prefix := s.projectPrefix(j.ID)
	if prefix == "" {
		return jobSync{}, fmt.Errorf("无法定位交付包项目目录")
	}
	latest := s.patchedFiles(j.ID)
	pack := map[string][]byte{}
	for k, v := range latest {
		pack[k] = v
	}
	// Ensure explicitly changed files (e.g. on patch revert) are also included with their current content.
	for _, f := range changedFiles {
		if _, ok := pack[f]; !ok {
			if data, exists := s.projectFile(j.ID, f); exists {
				pack[f] = data
			}
		}
	}
	removeSet := map[string]bool{}
	for _, prev := range j.Syncs {
		for _, f := range prev.Files {
			if _, ok := pack[f]; !ok {
				if data, exists := s.projectFile(j.ID, f); exists {
					pack[f] = data
				}
			}
		}
		for f := range prev.FileHashes {
			if _, ok := pack[f]; !ok {
				if data, exists := s.projectFile(j.ID, f); exists {
					pack[f] = data
				}
			}
		}
		for _, r := range prev.Remove {
			if _, ok := pack[r]; !ok {
				if _, exists := s.projectFile(j.ID, r); !exists {
					removeSet[r] = true
				}
			}
		}
	}
	names := make([]string, 0, len(pack))
	for k := range pack {
		names = append(names, k)
	}
	sort.Strings(names)
	removes := make([]string, 0, len(removeSet))
	for r := range removeSet {
		removes = append(removes, r)
	}
	sort.Strings(removes)

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	fileHashes := map[string]string{}
	for _, name := range names {
		b := pack[name]
		fileHashes[name] = digest(b)
		if err := tw.WriteHeader(&tar.Header{Name: prefix + name, Mode: 0o644, Size: int64(len(b)), ModTime: time.Now(), Typeflag: tar.TypeReg}); err != nil {
			return jobSync{}, err
		}
		if _, err := tw.Write(b); err != nil {
			return jobSync{}, err
		}
	}
	_ = tw.Close()
	_ = gz.Close()

	upd := fmt.Sprintf("update-%d-%s.tar.gz", n, path.Base(strings.TrimSuffix(prefix, "/")))
	out := filepath.Join(s.jobDir(j.ID), "output")
	if err := os.WriteFile(filepath.Join(out, upd), buf.Bytes(), 0o600); err != nil {
		return jobSync{}, err
	}
	sum := digest(buf.Bytes())
	_ = os.WriteFile(filepath.Join(out, upd+".sha256"), []byte(sum+"  "+upd+"\n"), 0o600)
	if sums, err := os.ReadFile(filepath.Join(out, "SHA256SUMS")); err == nil {
		_ = os.WriteFile(filepath.Join(out, "SHA256SUMS"), append(sums, []byte(sum+"  "+upd+"\n")...), 0o600)
	}
	at := time.Now().UTC().Format(time.RFC3339)
	sy := jobSync{
		N:          n,
		At:         at,
		By:         user,
		Kind:       kind,
		Reason:     reason,
		Files:      changedFiles,
		Steps:      []string{},
		Update:     upd,
		Remove:     removes,
		FileHashes: fileHashes,
		UpdateSHA:  sum,
	}
	s.mu.Lock()
	cj := s.jobs[j.ID]
	cj.Syncs = append(cj.Syncs, sy)
	if err := s.persistJob(cj); err != nil {
		s.mu.Unlock()
		return sy, err
	}
	s.jobs[j.ID] = cj
	doc := s.readProgress(j.ID)
	title := "热修交付文件 " + strings.Join(changedFiles, ", ")
	if kind == "hotfix-revert" {
		title = "还原交付热修文件 " + strings.Join(changedFiles, ", ")
	}
	doc.Events = append(doc.Events, progressEvent{At: at, By: user, Key: kind + "-" + strconv.Itoa(n), Title: truncRunes(title, 120), State: "sync"})
	if len(doc.Events) > maxEvents {
		doc.Events = doc.Events[len(doc.Events)-maxEvents:]
	}
	_ = s.writeProgress(j.ID, doc)
	s.mu.Unlock()
	_ = s.applyAmendmentDocs(j.ID)
	return sy, nil
}

func (s *storeServer) handleDeliveryFiles(w http.ResponseWriter, r *http.Request, session storeSession, j storeJob, parts []string) {
	if j.State != "succeeded" {
		s.fail(w, 409, "交付尚未生成成功，无法查看或修改脚本文件")
		return
	}
	switch {
	case len(parts) == 0 && r.Method == "GET":
		files, err := s.projectFiles(j.ID)
		if err != nil {
			s.fail(w, 404, err.Error())
			return
		}
		stepKey := strings.TrimSpace(r.URL.Query().Get("step"))
		relMap := s.stepRelatedFiles(j.ID, stepKey, files)
		patches := s.loadPatches(j.ID)
		latestPatch := map[string]deliveryPatch{}
		for _, p := range patches {
			latestPatch[p.Path] = p
		}
		var rawFiles map[string][]byte
		if len(latestPatch) > 0 {
			rawFiles, _ = s.rawTarProjectFiles(j.ID)
		}
		items := make([]deliveryFileItem, 0, len(files))
		for fp, data := range files {
			if patchablePath(fp) != nil {
				continue
			}
			it := deliveryFileItem{
				Path:    fp,
				Size:    len(data),
				Related: relMap[fp],
			}
			if lp, ok := latestPatch[fp]; ok {
				it.Patched = true
				it.PatchID = lp.ID
				it.PatchBy = lp.By
				it.PatchAt = lp.At
				it.PatchNote = lp.Reason
				orig := string(rawFiles[fp])
				it.Added, it.Deleted = lineDiffCounts(orig, string(data))
			}
			items = append(items, it)
		}
		sort.Slice(items, func(i, j int) bool {
			if items[i].Patched != items[j].Patched {
				return items[i].Patched
			}
			if items[i].Related != items[j].Related {
				return items[i].Related
			}
			return items[i].Path < items[j].Path
		})
		autoJobs := s.autoExecutedJobs()
		rawMode := j.DeliveryMode
		if rawMode == "" {
			if dep := s.readSpec(j.ID); dep != nil {
				rawMode = dep.DeliveryMode
			}
		}
		effMode := effectiveDeliveryMode(j.ID, rawMode, autoJobs)
		s.writeJSON(w, 200, map[string]any{
			"files":         items,
			"patches":       patches,
			"revision":      s.executionRevision(j.ID),
			"delivery_mode": effMode,
			"sync_count":    len(j.Syncs),
		})

	case len(parts) == 1 && parts[0] == "content" && r.Method == "GET":
		rel := path.Clean(strings.TrimSpace(r.URL.Query().Get("path")))
		if err := patchablePath(rel); err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		cur, exists := s.projectFile(j.ID, rel)
		if !exists {
			s.fail(w, 404, "文件不存在："+rel)
			return
		}
		rawFiles, _ := s.rawTarProjectFiles(j.ID)
		rawBytes, existedInTar := rawFiles[rel]
		var latest *deliveryPatch
		for _, p := range s.loadPatches(j.ID) {
			if p.Path == rel {
				cp := p
				latest = &cp
			}
		}
		orig := string(rawBytes)
		if !existedInTar && latest == nil && len(cur) > 0 {
			orig = string(cur)
		}
		diffText := ""
		addedLines, deletedLines := 0, 0
		if orig != string(cur) {
			diffText = lineDiff(orig, string(cur), 200)
			addedLines, deletedLines = lineDiffCounts(orig, string(cur))
		}
		s.writeJSON(w, 200, map[string]any{
			"path":     rel,
			"content":  string(cur),
			"original": orig,
			"patched":  latest != nil,
			"patch":    latest,
			"diff":     diffText,
			"added":    addedLines,
			"deleted":  deletedLines,
		})

	case len(parts) == 1 && parts[0] == "content" && r.Method == "PUT":
		if j.Outcome == outcomeVoid || j.RevisedBy != "" {
			s.fail(w, 409, "这份交付已作废或已被新修订替代，不能修改文件")
			return
		}
		var in struct {
			Path    string `json:"path"`
			Content string `json:"content"`
			Reason  string `json:"reason"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 512<<10)).Decode(&in) != nil {
			s.fail(w, 400, "请求格式错误")
			return
		}
		rel := path.Clean(strings.TrimSpace(in.Path))
		reason := truncRunes(strings.TrimSpace(in.Reason), 500)
		if err := patchablePath(rel); err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		if reason == "" {
			s.fail(w, 400, "请填写简短的修改原因（写入交付审计日志）")
			return
		}
		if len(in.Content) > 256<<10 {
			s.fail(w, 400, "文件大小不能超过 256 KiB")
			return
		}
		if aiScrub(in.Content) != in.Content {
			s.fail(w, 400, "文件内容疑似包含硬编码口令、私钥或令牌，请改用控制节点 secrets/ 变量引用")
			return
		}
		if reForbidden.MatchString(in.Content) {
			s.fail(w, 400, "文件包含格式化磁盘、递归删除根目录或重启关机等高危禁止命令，已拒绝保存")
			return
		}
		if strings.HasSuffix(rel, ".yml") || strings.HasSuffix(rel, ".yaml") {
			var parsed any
			if err := yaml.Unmarshal([]byte(in.Content), &parsed); err != nil {
				s.fail(w, 400, "YAML 语法校验未通过："+err.Error())
				return
			}
		}
		cur, exists := s.projectFile(j.ID, rel)
		if exists && string(cur) == in.Content {
			s.fail(w, 400, "文件内容与当前版本完全一致，无需保存")
			return
		}
		at := time.Now().UTC().Format(time.RFC3339)
		patch := deliveryPatch{
			ID:      randomStoreToken(6),
			Path:    rel,
			Content: in.Content,
			Before:  string(cur),
			New:     !exists,
			Reason:  reason,
			By:      session.User,
			At:      at,
		}
		patches := append(s.loadPatches(j.ID), patch)
		if err := writeJSONFile(s.patchesPath(j.ID), patches); err != nil {
			s.fail(w, 500, "保存热修补丁失败")
			return
		}
		sy, err := s.persistDeliveryPatchSync(j, session.User, "hotfix", reason, []string{rel})
		if err != nil {
			s.fail(w, 500, "生成交付增量更新包失败："+err.Error())
			return
		}
		// Compute offline controller verify/apply command for immediate display.
		verifyCmd := ""
		updateURL := ""
		shaURL := ""
		if sy.Update != "" {
			updateURL = "/api/jobs/" + j.ID + "/files/" + url.PathEscape(sy.Update)
			shaURL = "/api/jobs/" + j.ID + "/files/" + url.PathEscape(sy.Update+".sha256")
			if projDir := s.projectDirOf(j.ID); projDir != "" {
				parent := path.Dir(strings.TrimSuffix(projDir, "/"))
				verifyCmd = fmt.Sprintf("cd %s && sha256sum -c %s.sha256 && tar -xzf %s", parent, sy.Update, sy.Update)
			}
		}
		s.auditReq(r, "delivery-file-patch", session.User, fmt.Sprintf("%s %s (%s)", j.ID, rel, reason))
		s.writeJSON(w, 200, map[string]any{
			"patch":      patch,
			"sync":       sy,
			"patches":    patches,
			"revision":   s.executionRevision(j.ID),
			"verify_cmd": verifyCmd,
			"update_url": updateURL,
			"sha_url":    shaURL,
			"diff":       lineDiff(string(cur), in.Content, 200),
		})

	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) handleDeliveryPatches(w http.ResponseWriter, r *http.Request, session storeSession, j storeJob, parts []string) {
	switch {
	case len(parts) == 0 && r.Method == "GET":
		s.writeJSON(w, 200, map[string]any{
			"patches":  s.loadPatches(j.ID),
			"revision": s.executionRevision(j.ID),
		})

	case len(parts) == 0 && r.Method == "DELETE":
		rel := path.Clean(strings.TrimSpace(r.URL.Query().Get("path")))
		if rel == "" || rel == "." {
			s.fail(w, 400, "请指定要还原的补丁文件路径")
			return
		}
		oldPatches := s.loadPatches(j.ID)
		keep := make([]deliveryPatch, 0, len(oldPatches))
		removed := false
		for _, p := range oldPatches {
			if p.Path == rel {
				removed = true
				continue
			}
			keep = append(keep, p)
		}
		if !removed {
			s.fail(w, 404, "该文件没有热修补丁")
			return
		}
		if err := writeJSONFile(s.patchesPath(j.ID), keep); err != nil {
			s.fail(w, 500, "还原热修补丁失败")
			return
		}
		sy, err := s.persistDeliveryPatchSync(j, session.User, "hotfix-revert", "还原热修文件 "+rel, []string{rel})
		if err != nil {
			s.fail(w, 500, "生成还原更新包失败："+err.Error())
			return
		}
		s.auditReq(r, "delivery-file-patch-revert", session.User, j.ID+" "+rel)
		s.writeJSON(w, 200, map[string]any{
			"patches":  keep,
			"sync":     sy,
			"revision": s.executionRevision(j.ID),
		})

	case len(parts) == 1 && parts[0] == "promote-draft" && r.Method == "POST":
		if !s.need(w, session.User, "component.edit") {
			return
		}
		var in struct {
			Path      string `json:"path"`
			Component string `json:"component"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&in) != nil {
			s.fail(w, 400, "请求格式错误")
			return
		}
		rel := path.Clean(strings.TrimSpace(in.Path))
		if !strings.HasPrefix(rel, "roles/") {
			s.fail(w, 400, "仅支持将 roles/ 下的组件角色文件沉淀回组件草稿")
			return
		}
		content, exists := s.projectFile(j.ID, rel)
		if !exists {
			s.fail(w, 404, "交付文件不存在")
			return
		}
		// Identify target component from either explicit input or role directory name / cluster AppID.
		compName := strings.TrimSpace(in.Component)
		if compName == "" {
			segs := strings.Split(rel, "/")
			if len(segs) >= 2 {
				roleDir := segs[1]
				if _, ok := s.plat.cat().Get(roleDir); ok {
					compName = roleDir
				} else if roleDir == "mw_common" || roleDir == "mw_repo" || roleDir == "mw_disk" {
					compName = sharedPlatformName
				}
			}
		}
		if compName == "" {
			compName = j.AppID
		}
		if compName == "" {
			s.fail(w, 400, "无法识别对应的目标组件，请指定组件名称")
			return
		}
		// Copy file into component draft under the matching relative path (roles/<role>/... -> roles/<role>/...).
		compMu.Lock()
		cs := s.comps()
		var curDraft fileSet
		var meta draftMeta
		var err error
		if cs.hasDraft(compName) {
			curDraft, meta, err = cs.readDraft(compName)
		} else {
			curDraft, _, err = cs.liveSet(compName)
			meta = draftMeta{
				Source:  "live",
				BaseRev: cs.liveRev(compName),
				Created: now(),
			}
		}
		if err != nil {
			compMu.Unlock()
			s.fail(w, 404, "目标组件不存在或无法加载草稿："+compName)
			return
		}
		// Find matching file path inside the component's fileSet (exact match or matching suffix after roles/<role>/).
		targetRel := rel
		if _, ok := curDraft[targetRel]; !ok {
			segs := strings.SplitN(rel, "/", 3)
			if len(segs) == 3 {
				suffix := "/" + segs[2]
				for k := range curDraft {
					if strings.HasSuffix(k, suffix) && strings.HasPrefix(k, "roles/") {
						targetRel = k
						break
					}
				}
			}
		}
		curDraft[targetRel] = content
		meta.Updated = now()
		meta.User = session.User
		if err := cs.writeDraft(compName, curDraft, meta); err != nil {
			compMu.Unlock()
			s.fail(w, 500, "写入组件草稿失败："+err.Error())
			return
		}
		compMu.Unlock()
		s.auditReq(r, "delivery-patch-promote-draft", session.User, fmt.Sprintf("%s %s -> %s:%s", j.ID, rel, compName, targetRel))
		s.writeJSON(w, 200, map[string]any{
			"component": compName,
			"path":      targetRel,
		})

	default:
		s.fail(w, 404, "接口不存在")
	}
}

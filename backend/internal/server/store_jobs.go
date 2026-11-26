package server

import (
	"archive/zip"
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"delivery-studio/mwpack"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func (s *storeServer) jobDir(id string) string { return filepath.Join(s.cfg.DataDir, "jobs", id) }
func (s *storeServer) listJobs(w http.ResponseWriter, session storeSession) {
	vis := s.visibleJobs(session.User)
	s.mu.Lock()
	jobs := []storeJob{}
	for _, j := range s.jobs {
		if vis(j.Owner, j.ClusterID) {
			jobs = append(jobs, j)
		}
	}
	s.mu.Unlock()
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].Created > jobs[j].Created })
	lang := wLang(w)
	autoJobs := s.autoExecutedJobs()
	for i := range jobs {
		rawMode := jobs[i].DeliveryMode
		if rawMode == "" {
			if dep := s.readSpec(jobs[i].ID); dep != nil {
				rawMode = dep.DeliveryMode
			}
		}
		jobs[i].DeliveryMode = effectiveDeliveryMode(jobs[i].ID, rawMode, autoJobs)
		jobs[i].Scheme = mwpack.LocalizeSchemeSummary(lang, s.deliveryScheme(jobs[i].ID, jobs[i].AppID, jobs[i].Scheme))
	}
	s.writeJSON(w, 200, jobs)
}
func (s *storeServer) removeFailedReservation(id string) {
	s.mu.Lock()
	delete(s.jobs, id)
	s.mu.Unlock()
}

// deleteJobData safely removes a delivery's artifacts, inactive execution runs/logs, DB row, and in-memory record.
// Component verification vouchers in comp-verifications/ remain intact as lightweight decoupled static evidence.
func (s *storeServer) deleteJobData(id string) (int, string) {
	s.mu.Lock()
	j, ok := s.jobs[id]
	s.mu.Unlock()
	if !ok {
		return 404, "交付记录不存在"
	}
	if j.State == "running" || j.State == "queued" {
		return 409, "生成中不能删除"
	}
	executionMu.Lock()
	locked := s.executionLocked(id)
	executionMu.Unlock()
	if locked {
		return 409, "自动执行进行中，请先结束批次再删除"
	}
	dir := s.jobDir(id)
	root, _ := filepath.Abs(filepath.Join(s.cfg.DataDir, "jobs"))
	target, _ := filepath.Abs(dir)
	if filepath.Dir(target) != root || filepath.Base(target) != id {
		return 500, "任务路径无效"
	}
	if st, err := os.Lstat(target); err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return 500, "任务目录无效"
	}
	if err := os.RemoveAll(target); err != nil {
		return 500, "交付材料删除失败"
	}
	s.purgeJobExecutions(id)
	s.evictJobCaches(id)
	if s.repo != nil {
		if err := s.repo.deleteJob(id); err != nil {
			return 500, "交付记录删除失败"
		}
	}
	s.removeFailedReservation(id)
	return 0, ""
}
func (s *storeServer) updateJob(id, state, stage, message string) {
	s.jobPersistMu.Lock()
	defer s.jobPersistMu.Unlock()
	s.mu.Lock()
	j := s.jobs[id]
	j.State = state
	j.Stage = stage
	j.Error = message
	j.Updated = time.Now().UTC().Format(time.RFC3339Nano)
	logs := make([]string, 0, len(j.Logs)+1)
	logs = append(logs, j.Logs...)
	logs = append(logs, stage)
	if len(logs) > 30 {
		logs = logs[len(logs)-30:]
	}
	j.Logs = logs
	s.jobs[id] = j
	s.mu.Unlock()
	if err := s.persistJob(j); err != nil {
		s.mu.Lock()
		cur := s.jobs[id]
		cur.State = "failed"
		cur.Error = "任务状态无法保存，请联系管理员"
		s.jobs[id] = cur
		s.mu.Unlock()
	}
}
func (s *storeServer) handleJob(w http.ResponseWriter, r *http.Request, session storeSession) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/jobs/"), "/")
	id := parts[0]
	if !storeJobID.MatchString(id) {
		s.fail(w, 404, "任务不存在")
		return
	}
	s.mu.Lock()
	j, ok := s.jobs[id]
	s.mu.Unlock()
	if !ok || !s.jobVisible(session.User, j) {
		s.fail(w, 404, "任务不存在")
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && !s.clusterCanOperate(session.User, j.Owner, j.ClusterID) {
		s.fail(w, 403, "你对集群「"+firstNonEmptyStr(j.ClusterID, j.ID)+"」仅有只读查看权限，无法执行修改或操作")
		return
	}
	mutatesExecution := len(parts) == 1 || (len(parts) > 1 && (parts[1] == "executions" || parts[1] == "sync" || parts[1] == "progress" || parts[1] == "scripts" || parts[1] == "patches" || (parts[1] == "ai" && len(parts) > 2 && (parts[2] == "proposals" || parts[2] == "resolve"))))
	if mutatesExecution && r.Method != "GET" && r.Method != "HEAD" {
		unlock := s.lockExecutionJob(id)
		defer unlock()
		s.mu.Lock()
		j, ok = s.jobs[id]
		s.mu.Unlock()
		if !ok {
			s.fail(w, 404, "交付已删除")
			return
		}
		executionMu.Lock()
		locked := s.executionLocked(id)
		executionMu.Unlock()
		if !(len(parts) > 1 && parts[1] == "executions") && locked {
			s.fail(w, 409, "这份交付正在自动执行或等待状态核实，请先暂停并结束执行批次，再修改交付或记录")
			return
		}
	}
	if len(parts) >= 2 && parts[1] == "executions" {
		s.handleExecutions(w, r, session, j, parts[2:])
		return
	}
	if len(parts) >= 2 && parts[1] == "scripts" {
		s.handleDeliveryFiles(w, r, session, j, parts[2:])
		return
	}
	if len(parts) >= 2 && parts[1] == "patches" {
		s.handleDeliveryPatches(w, r, session, j, parts[2:])
		return
	}
	if len(parts) == 1 && r.Method == "PATCH" {
		var body struct {
			Outcome string `json:"outcome"`
			Note    string `json:"note"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body); err != nil {
			s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
			return
		}
		cur, code, msg := s.markOutcome(id, session.User, body.Outcome, body.Note)
		if msg != "" {
			s.fail(w, code, msg)
			return
		}
		s.auditReq(r, "job-mark", session.User, id+" "+body.Outcome)
		s.writeJSON(w, 200, cur)
		return
	}
	if len(parts) == 1 && r.Method == "DELETE" {
		if code, msg := s.deleteJobData(id); code != 0 {
			s.fail(w, code, msg)
			return
		}
		s.auditReq(r, "job-delete", session.User, id)
		s.writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	if len(parts) >= 2 && parts[1] == "ai" {
		if j.State != "succeeded" {
			s.fail(w, 409, "交付材料尚未生成成功")
			return
		}
		s.handleJobAI(w, r, session, j, parts[2:])
		return
	}
	if len(parts) == 2 && parts[1] == "sync" {
		s.handleSync(w, r, session, j)
		return
	}
	if len(parts) == 3 && parts[1] == "sync" && parts[2] == "keep" && r.Method == "POST" {
		var in struct {
			Key    string `json:"key"`
			Sync   int    `json:"sync"`
			Reason string `json:"reason"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in) != nil || in.Key == "" || in.Sync < 1 {
			s.fail(w, 400, "提交的内容有问题")
			return
		}
		if err := s.keepStep(id, in.Key, session.User, in.Reason, in.Sync); err != nil {
			s.fail(w, 409, err.Error())
			return
		}
		s.auditReq(r, "job-sync-keep", session.User, id+" "+in.Key)
		s.writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	if len(parts) == 3 && parts[1] == "sync" && parts[2] == "confirm" && r.Method == "POST" {
		var in struct {
			Sync int    `json:"sync"`
			Mode string `json:"mode"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&in) != nil || in.Sync < 1 {
			s.fail(w, 400, "提交的内容有问题")
			return
		}
		sy, err := s.confirmSyncApplied(id, in.Sync, session.User, in.Mode)
		if err != nil {
			s.fail(w, 409, err.Error())
			return
		}
		s.auditReq(r, "job-sync-confirm", session.User, fmt.Sprintf("%s #%d %s", id, in.Sync, sy.AppliedMode))
		s.writeJSON(w, 200, sy)
		return
	}
	if len(parts) >= 2 && parts[1] == "progress" {
		if j.State != "succeeded" {
			s.fail(w, 409, "交付材料尚未生成成功")
			return
		}
		if len(parts) == 2 {
			s.handleProgress(w, r, session, id)
		} else if parts[2] == "img" {
			s.handleProgressImg(w, r, session, id, parts[3:])
		} else if parts[2] == "logs" && len(parts) == 3 {
			s.handleRunLogs(w, r, session, id)
		} else {
			s.fail(w, 404, "接口不存在")
		}
		return
	}
	if r.Method != "GET" {
		s.fail(w, 405, "方法不支持")
		return
	}
	if len(parts) == 1 {
		lang := wLang(w)
		autoJobs := s.autoExecutedJobs()
		rawMode := j.DeliveryMode
		if rawMode == "" {
			if dep := s.readSpec(j.ID); dep != nil {
				rawMode = dep.DeliveryMode
			}
		}
		j.DeliveryMode = effectiveDeliveryMode(j.ID, rawMode, autoJobs)
		j.Scheme = mwpack.LocalizeSchemeSummary(lang, s.deliveryScheme(j.ID, j.AppID, j.Scheme))
		rawPlan := s.jobPlan(id)
		if j.State == "succeeded" && len(j.Syncs) > 0 {
			j.Syncs = s.enrichJobSyncs(id, parseSyncPlanMeta(rawPlan), j.Syncs)
			// Retroactively ensure offline 01-*.md carries the latest sync check step for deliveries synced earlier.
			if j.DeliveryMode != "automatic" && j.DeliveryMode != "configuration" {
				last := j.Syncs[len(j.Syncs)-1]
				if last.VerifyCmd != "" {
					marker := syncDeploySectionMarker(last)
					if docs, _ := filepath.Glob(filepath.Join(s.jobDir(id), "output", "01-*.md")); len(docs) > 0 {
						if b, err := os.ReadFile(docs[0]); err == nil && !strings.Contains(string(b), marker) {
							aiMu.Lock()
							_ = s.applyAmendmentDocs(id)
							aiMu.Unlock()
						}
					}
				}
			}
		}
		files := []map[string]any{}
		if j.State == "succeeded" {
			entries, _ := os.ReadDir(filepath.Join(s.jobDir(id), "output"))
			for _, entry := range entries {
				info, err := entry.Info()
				if err == nil && info.Mode().IsRegular() {
					files = append(files, map[string]any{"name": entry.Name(), "bytes": info.Size(), "url": "/api/jobs/" + id + "/files/" + url.PathEscape(entry.Name())})
				}
			}
		}
		var verifyTargets []jobPromoteTarget
		if isTempVerificationJob(j) {
			verifyTargets = s.jobPromotionTargets(j, session.User)
		}
		s.writeJSON(w, 200, map[string]any{
			"job":                  j,
			"files":                files,
			"spec":                 s.jobSpec(id),
			"plan":                 mwpack.LocalizePlanJSON(lang, rawPlan),
			"lineage":              s.lineageOf(j),
			"verification_promote": verifyTargets,
		})
		return
	}
	if j.State != "succeeded" {
		s.fail(w, 409, "交付材料尚未生成成功")
		return
	}
	if len(parts) == 2 && parts[1] == "archive" {
		s.auditReq(r, "job-download", session.User, id)
		s.downloadArchive(w, r, id)
		return
	}
	if len(parts) == 3 && parts[1] == "files" {
		name := parts[2]
		if name == "" || name == "." || filepath.Base(name) != name || strings.ContainsAny(name, "/\\\x00") {
			s.fail(w, 404, "文件不存在")
			return
		}
		filename := filepath.Join(s.jobDir(id), "output", name)
		info, err := os.Lstat(filename)
		if err != nil || !info.Mode().IsRegular() {
			s.fail(w, 404, "文件不存在")
			return
		}
		f, err := os.Open(filename)
		if err != nil {
			s.fail(w, 404, "文件不存在")
			return
		}
		defer f.Close()
		if r.Header.Get("Range") == "" {
			s.auditReq(r, "job-file-download", session.User, id+" "+name)
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=delivery-file; filename*=UTF-8''"+url.PathEscape(name))
		http.ServeContent(w, r, name, info.ModTime(), f)
		return
	}
	s.fail(w, 404, "接口不存在")
}

func (s *storeServer) downloadArchive(w http.ResponseWriter, r *http.Request, id string) {
	dir := filepath.Join(s.jobDir(id), "output")
	entries, err := os.ReadDir(dir)
	if err != nil {
		s.fail(w, 500, "交付材料不可读")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=delivery-%s.zip", id))
	bw := bufio.NewWriterSize(w, 256<<10)
	z := zip.NewWriter(bw)
	buf := make([]byte, 256<<10)
	streamFailed := false
	for _, entry := range entries {
		if r.Context().Err() != nil {
			streamFailed = true
			break
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		f, err := os.Open(filepath.Join(dir, entry.Name()))
		if err != nil {
			streamFailed = true
			break
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			f.Close()
			streamFailed = true
			break
		}
		header.Method = zip.Store
		out, err := z.CreateHeader(header)
		if err != nil {
			f.Close()
			streamFailed = true
			break
		}
		_, err = io.CopyBuffer(out, f, buf)
		f.Close()
		if err != nil {
			streamFailed = true
			break
		}
	}
	if !streamFailed {
		if err := z.Close(); err == nil {
			_ = bw.Flush()
		}
	}
}

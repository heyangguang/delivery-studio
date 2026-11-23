package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Run logs: the project's logs/ directory on the controller holds a file for every playbook run (see
// mwpack/platform/files/mw_log.py). Uploading them is the shortest way to fill in the execution record: the
// platform reads which playbook ran, whether it passed, and what every task did on every machine, and puts that
// into the report next to the step — without anyone pasting output by hand.

const (
	maxRunLogFile   = 20 << 20
	maxRunLogs      = 200
	maxRunLogUpload = 60 << 20
)

type logOutcome struct {
	Kind  string   `json:"kind"` // ok | changed | FAILED | UNREACHABLE | skipped …
	Host  string   `json:"host"`
	Lines []string `json:"lines,omitempty"`
}

type logTask struct {
	Name     string       `json:"name"`
	Outcomes []logOutcome `json:"outcomes"`
}

type logRecap struct {
	Host        string `json:"host"`
	OK          int    `json:"ok"`
	Changed     int    `json:"changed"`
	Unreachable int    `json:"unreachable"`
	Failed      int    `json:"failed"`
	Skipped     int    `json:"skipped"`
}

// runLog is one run of one playbook, read from its log file.
type runLog struct {
	File     string     `json:"file"`
	Playbook string     `json:"playbook"`
	Started  string     `json:"started"`
	Finished string     `json:"finished"`
	Command  string     `json:"command"`
	Result   string     `json:"result"` // PASSED | FAILED | SKIPPED | "" (the run was cut off)
	Recap    []logRecap `json:"recap"`
	Tasks    []logTask  `json:"tasks"`
}

var (
	reLogStamp = regexp.MustCompile(`^\d\d:\d\d:\d\d ?`)
	reLogRecap = regexp.MustCompile(`^(\S+)\s+ok=(\d+) changed=(\d+) unreachable=(\d+) failed=(\d+) skipped=(\d+)`)
	reLogOut   = regexp.MustCompile(`^(ok|changed|skipped|retrying|FAILED(?: \(ignored\))?|UNREACHABLE)\s+(\S+)`)
)

// parseRunLog reads a log written by mw_log.py. It is forgiving: a run that was interrupted has no RECAP, and a
// file that is not such a log gives an empty Playbook.
func parseRunLog(name string, data []byte) runLog {
	rl := runLog{File: name}
	var task *logTask
	var out *logOutcome
	inRecap := false
	structuredResult, structuredStep := "", ""
	invalidContract := false
	for _, raw := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		line := reLogStamp.ReplaceAllString(raw, "")
		switch {
		case strings.HasPrefix(line, "playbook "):
			rl.Playbook = strings.TrimSpace(line[len("playbook "):])
		case strings.HasPrefix(line, "started "):
			rl.Started = strings.TrimSpace(line[len("started "):])
		case strings.HasPrefix(line, "command "):
			rl.Command = strings.TrimSpace(line[len("command "):])
		case strings.HasPrefix(line, "finished "):
			rl.Finished = strings.TrimSpace(line[len("finished "):])
		case strings.HasPrefix(line, "TASK  "):
			rl.Tasks = append(rl.Tasks, logTask{Name: strings.TrimSpace(line[len("TASK  "):])})
			task, out, inRecap = &rl.Tasks[len(rl.Tasks)-1], nil, false
		case line == "RECAP":
			task, out, inRecap = nil, nil, true
		case strings.HasPrefix(line, "STEP_RESULT "):
			var result struct{ Schema, Step, Status, Finished string }
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "STEP_RESULT ")), &result); err != nil || result.Schema != "mwstep-result/v1" || (result.Status != "passed" && result.Status != "failed" && result.Status != "skipped") {
				invalidContract = true
			} else {
				if structuredResult != "" {
					invalidContract = true
				}
				structuredResult, structuredStep = strings.ToUpper(result.Status), result.Step
			}
		case strings.HasPrefix(line, "RESULT "):
			rl.Result = strings.TrimSpace(line[len("RESULT "):])
			inRecap = false
		case inRecap:
			if m := reLogRecap.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
				var r logRecap
				r.Host = m[1]
				fmt.Sscan(m[2], &r.OK)
				fmt.Sscan(m[3], &r.Changed)
				fmt.Sscan(m[4], &r.Unreachable)
				fmt.Sscan(m[5], &r.Failed)
				fmt.Sscan(m[6], &r.Skipped)
				rl.Recap = append(rl.Recap, r)
			}
		case task != nil && strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "   "):
			if m := reLogOut.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
				task.Outcomes = append(task.Outcomes, logOutcome{Kind: m[1], Host: m[2]})
				out = &task.Outcomes[len(task.Outcomes)-1]
			}
		case out != nil && strings.HasPrefix(line, "    "):
			out.Lines = append(out.Lines, strings.TrimPrefix(line, "    "))
		}
	}
	if structuredResult != "" && (structuredStep != rl.Playbook || (rl.Result != "" && rl.Result != structuredResult)) {
		invalidContract = true
	}
	if invalidContract {
		rl.Result = "FAILED"
	} else if structuredResult != "" {
		rl.Result = structuredResult
	}
	return rl
}

func (r runLog) ok() bool { return r.Result == "PASSED" }

// time of the run, for ordering; logs without a readable time keep the order of their names.
func (r runLog) when() string {
	if t, err := time.Parse("2006-01-02 15:04:05 -0700", r.Started); err == nil {
		return t.UTC().Format(time.RFC3339)
	}
	return r.File
}

func (s *storeServer) runLogDir(id string) string { return filepath.Join(s.jobDir(id), "run-logs") }

var reLogName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,120}\.log$`)

// runLogs are the logs uploaded for a delivery, oldest first.
func (s *storeServer) runLogs(id string) []runLog {
	ents, err := os.ReadDir(s.runLogDir(id))
	if err != nil {
		return nil
	}
	var out []runLog
	for _, e := range ents {
		if !reLogName.MatchString(e.Name()) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(s.runLogDir(id), e.Name()))
		if err != nil {
			continue
		}
		if rl := parseRunLog(e.Name(), b); rl.Playbook != "" {
			out = append(out, rl)
		}
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].when() < out[b].when() })
	return out
}

// logFilesIn pulls the .log files out of what was uploaded: a log, a .zip or a .tar.gz of the logs directory.
func logFilesIn(name string, data []byte) (map[string][]byte, error) {
	out := map[string][]byte{}
	add := func(n string, b []byte) {
		base := filepath.Base(n)
		if reLogName.MatchString(base) && len(b) > 0 {
			out[base] = b
		}
	}
	switch {
	case bytes.HasPrefix(data, []byte("PK\x03\x04")):
		z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, fmt.Errorf("压缩包打不开")
		}
		for _, f := range z.File {
			if f.FileInfo().IsDir() || !strings.HasSuffix(f.Name, ".log") || len(out) >= maxRunLogs {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				continue
			}
			b, _ := io.ReadAll(io.LimitReader(rc, maxRunLogFile+1))
			rc.Close()
			if len(b) <= maxRunLogFile {
				add(f.Name, b)
			}
		}
	case bytes.HasPrefix(data, []byte{0x1f, 0x8b}):
		gz, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("压缩包打不开")
		}
		tr := tar.NewReader(gz)
		for len(out) < maxRunLogs {
			h, err := tr.Next()
			if err != nil {
				break
			}
			if h.Typeflag != tar.TypeReg || !strings.HasSuffix(h.Name, ".log") {
				continue
			}
			b, _ := io.ReadAll(io.LimitReader(tr, maxRunLogFile+1))
			if len(b) <= maxRunLogFile {
				add(h.Name, b)
			}
		}
	default:
		if len(data) <= maxRunLogFile {
			add(name, data)
		}
	}
	return out, nil
}

// handleRunLogs serves /api/jobs/{id}/progress/logs: GET lists them, POST takes files (multipart), DELETE removes one
// (?name=) or all.
func (s *storeServer) handleRunLogs(w http.ResponseWriter, r *http.Request, session storeSession, id string) {
	switch r.Method {
	case "GET":
		s.writeJSON(w, 200, s.runLogSummaries(id))
	case "POST":
		r.Body = http.MaxBytesReader(w, r.Body, maxRunLogUpload)
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			s.fail(w, 400, "上传的内容太大（最多 60 MiB），或格式不对")
			return
		}
		files := map[string][]byte{}
		for _, fh := range r.MultipartForm.File["files"] {
			f, err := fh.Open()
			if err != nil {
				continue
			}
			b, _ := io.ReadAll(io.LimitReader(f, maxRunLogUpload))
			f.Close()
			got, err := logFilesIn(fh.Filename, b)
			if err != nil {
				s.fail(w, 400, fh.Filename+"："+err.Error())
				return
			}
			for k, v := range got {
				files[k] = v
			}
		}
		kept, skipped := []string{}, []string{}
		parsed := map[string]runLog{}
		for n, b := range files {
			if rl := parseRunLog(n, b); rl.Playbook != "" {
				parsed[n] = rl
			} else {
				skipped = append(skipped, n)
			}
		}
		if len(parsed) == 0 {
			s.fail(w, 400, "没有找到可以读取的日志。请上传控制节点项目目录 logs/ 下的 .log 文件，或把整个 logs 目录打成 .zip / .tar.gz")
			return
		}
		if err := os.MkdirAll(s.runLogDir(id), 0o700); err != nil {
			s.fail(w, 500, "日志无法保存")
			return
		}
		if ents, _ := os.ReadDir(s.runLogDir(id)); len(ents)+len(parsed) > maxRunLogs {
			s.fail(w, 413, "这份交付的日志已经很多了，请先清理")
			return
		}
		for n := range parsed {
			if os.WriteFile(filepath.Join(s.runLogDir(id), n), files[n], 0o600) != nil {
				s.fail(w, 500, "日志无法保存")
				return
			}
			kept = append(kept, n)
		}
		sort.Strings(kept)
		matched := s.recordFromLogs(id, session.User)
		go s.auditReq(r, "job-runlogs", session.User, fmt.Sprintf("%s 导入 %d 份日志，对上 %d 步", id, len(kept), matched))
		s.writeJSON(w, 200, map[string]any{"imported": kept, "skipped": skipped, "matched": matched, "logs": s.runLogSummaries(id)})
	case "DELETE":
		name := r.URL.Query().Get("name")
		if name == "" {
			_ = os.RemoveAll(s.runLogDir(id))
		} else if reLogName.MatchString(name) {
			_ = os.Remove(filepath.Join(s.runLogDir(id), name))
		}
		s.auditReq(r, "job-runlogs-delete", session.User, id+" "+name)
		s.writeJSON(w, 200, s.runLogSummaries(id))
	default:
		s.fail(w, 405, "方法不支持")
	}
}

type runLogSummary struct {
	File     string `json:"file"`
	Playbook string `json:"playbook"`
	Started  string `json:"started"`
	Result   string `json:"result"`
	Step     string `json:"step,omitempty"` // the runbook step it belongs to
}

func (s *storeServer) runLogSummaries(id string) []runLogSummary {
	byPlaybook := map[string]string{}
	for _, t := range s.runbookSteps(id) {
		for _, st := range t.Steps {
			if st.Playbook != "" {
				byPlaybook[st.Playbook] = st.Title
				if strings.Count(filepath.ToSlash(st.Playbook), "/") == 1 {
					byPlaybook[filepath.Base(st.Playbook)] = st.Title
				}
			}
		}
	}
	out := []runLogSummary{}
	for _, rl := range s.runLogs(id) {
		out = append(out, runLogSummary{rl.File, rl.Playbook, rl.Started, rl.Result, byPlaybook[rl.Playbook]})
	}
	return out
}

// stepRuns are the runs of the playbook behind a step.
func stepRuns(logs []runLog, playbook string) []runLog {
	var out []runLog
	for _, l := range logs {
		if playbook != "" && (l.Playbook == playbook || (strings.Count(filepath.ToSlash(playbook), "/") == 1 && l.Playbook == filepath.Base(playbook))) {
			out = append(out, l)
		}
	}
	return out
}

// recordFromLogs writes the result of each step whose playbook has a log, unless a person recorded that step
// themselves. It returns how many steps the logs belong to.
func (s *storeServer) recordFromLogs(id, user string) int {
	logs := s.runLogs(id)
	tabs := s.runbookSteps(id)
	total, matched := 0, 0
	s.mu.Lock()
	defer s.mu.Unlock()
	doc := s.readProgress(id)
	now := time.Now().UTC().Format(time.RFC3339)
	for _, t := range tabs {
		for _, st := range t.Steps {
			total++
			runs := stepRuns(logs, st.Playbook)
			if len(runs) == 0 {
				continue
			}
			matched++
			if old, ok := doc.Steps[st.Key]; ok && old.By != runLogBy {
				continue // somebody wrote this one down by hand
			}
			last := runs[len(runs)-1]
			state := "failed"
			if last.ok() {
				state = "done"
			} else if last.Result == "SKIPPED" {
				state = "" // no successful task: do not count an unexecuted step as complete
			}
			note := fmt.Sprintf("来自执行日志 %s：%s", last.File, map[string]string{"PASSED": "通过", "FAILED": "失败", "SKIPPED": "未执行，仍待验证"}[last.Result])
			if last.Result == "" {
				note = fmt.Sprintf("来自执行日志 %s：运行没有结束（日志里没有结果）", last.File)
			}
			if len(runs) > 1 {
				note += fmt.Sprintf("；这个步骤共运行了 %d 次，以最后一次为准", len(runs))
			}
			doc.Steps[st.Key] = stepRecord{State: state, By: runLogBy, Source: "imported", At: firstNonEmptyStr(last.when(), now), Note: note, Log: logSummary(last)}
			doc.Events = append(doc.Events, progressEvent{At: now, By: user, Key: st.Key, Title: truncRunes(t.Label+" · "+st.Title, 120), State: state})
		}
	}
	if len(doc.Events) > maxEvents {
		doc.Events = doc.Events[len(doc.Events)-maxEvents:]
	}
	if err := s.writeProgress(id, doc); err != nil {
		return matched
	}
	cur := s.jobs[id]
	cur.RunDone, cur.RunFailed = countSteps(doc)
	if total > 0 {
		cur.RunTotal = total
	}
	if err := s.persistJob(cur); err == nil {
		s.jobs[id] = cur
	}
	return matched
}

const runLogBy = "日志导入"

// logSummary is the short form kept in the record: the recap and what failed.
func logSummary(r runLog) string {
	var b strings.Builder
	fmt.Fprintf(&b, "playbook %s  %s → %s  %s\n", r.Playbook, r.Started, r.Finished, r.Result)
	for _, c := range r.Recap {
		fmt.Fprintf(&b, "%-20s ok=%d changed=%d unreachable=%d failed=%d skipped=%d\n", c.Host, c.OK, c.Changed, c.Unreachable, c.Failed, c.Skipped)
	}
	for _, t := range r.Tasks {
		for _, o := range t.Outcomes {
			if strings.HasPrefix(o.Kind, "FAILED") || o.Kind == "UNREACHABLE" {
				fmt.Fprintf(&b, "\nTASK %s\n  %s %s\n", t.Name, o.Kind, o.Host)
				for _, l := range o.Lines {
					b.WriteString("    " + l + "\n")
				}
			}
		}
	}
	return truncRunes(b.String(), maxStepLog/2)
}

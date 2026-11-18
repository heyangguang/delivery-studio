package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
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

type stepRecord struct {
	Source    string `json:"source,omitempty"`
	Execution string `json:"execution,omitempty"`
	Attempt   string `json:"attempt,omitempty"`
	State     string `json:"state"` // done | failed | skipped | resolved (a problem came up and was solved); empty: no result marked, what was written is kept
	By        string `json:"by"`
	At        string `json:"at"`
	Note      string `json:"note,omitempty"`
	Log       string `json:"log,omitempty"`
	// Images are screenshots pasted or dropped next to the output, as file names under the delivery's progress-img.
	Images []string `json:"images,omitempty"`
}

type progressEvent struct {
	At    string `json:"at"`
	By    string `json:"by"`
	Key   string `json:"key"`
	Title string `json:"title,omitempty"`
	State string `json:"state"` // "" means the record was cleared
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

// handleProgress serves /api/jobs/{id}/progress for a delivery whose files exist.
func (s *storeServer) handleProgress(w http.ResponseWriter, r *http.Request, session storeSession, id string) {
	switch r.Method {
	case "GET":
		s.mu.Lock()
		doc := s.readProgress(id)
		s.mu.Unlock()
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

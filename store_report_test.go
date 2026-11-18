package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExecutionReport(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	bob, bcsrf := storeLogin(t, s, "bob")
	w := storeCreate(t, s, alice, csrf, `{"id":"etcd-rep","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	var j storeJob
	json.Unmarshal(w.Body.Bytes(), &j)
	req := func(cookie *http.Cookie, tok, method, path string, body any) (int, []byte) {
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		if method == "GET" {
			tok = ""
		}
		r := storeRequest(s, method, path, rd, cookie, tok)
		return r.Code, r.Body.Bytes()
	}
	// a picture pasted in the browser
	var pic bytes.Buffer
	im := image.NewRGBA(image.Rect(0, 0, 40, 20))
	for x := 0; x < 40; x++ {
		im.Set(x, 5, color.RGBA{200, 30, 30, 255})
	}
	png.Encode(&pic, im)
	data := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pic.Bytes())
	code, body := req(alice, csrf, "POST", "/api/jobs/"+j.ID+"/progress/img", map[string]string{"data": data})
	var up struct{ Name string }
	json.Unmarshal(body, &up)
	if code != 201 || up.Name == "" {
		t.Fatal(code, string(body))
	}
	// not a picture, whatever it claims
	if code, _ := req(alice, csrf, "POST", "/api/jobs/"+j.ID+"/progress/img", map[string]string{"data": "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("<script>alert(1)</script>"))}); code != 400 {
		t.Fatal("stored a file that is not a picture", code)
	}
	// somebody else's delivery
	if code, _ := req(bob, bcsrf, "POST", "/api/jobs/"+j.ID+"/progress/img", map[string]string{"data": data}); code == 201 {
		t.Fatal("bob attached a picture to alice's delivery")
	}
	if code, _ := req(bob, bcsrf, "GET", "/api/jobs/"+j.ID+"/progress/img/"+up.Name, nil); code == 200 {
		t.Fatal("bob read alice's picture")
	}
	if code, _ := req(alice, csrf, "PUT", "/api/jobs/"+j.ID+"/progress", map[string]any{"key": "prepare/prepare-0", "title": "x", "state": "done", "images": []string{"0123456789abcdef0123.png"}}); code != 400 {
		t.Fatal("referred to a picture that does not exist", code)
	}
	// a webp picture goes into Word too, as png
	const webp = "UklGRh4AAABXRUJQVlA4TBEAAAAvJ8AEAAdQvHoUuf+BiOh/AAA="
	code, body = req(alice, csrf, "POST", "/api/jobs/"+j.ID+"/progress/img", map[string]string{"data": "data:image/webp;base64," + webp})
	var upw struct{ Name string }
	json.Unmarshal(body, &upw)
	if code != 201 || !strings.HasSuffix(upw.Name, ".webp") {
		t.Fatal(code, string(body))
	}
	tabs := s.runbookSteps(j.ID)
	if len(tabs) < 2 || len(tabs[0].Steps) == 0 {
		t.Fatalf("no runbook: %+v", tabs)
	}
	first := tabs[0].Steps[0]
	var phase reportStep
	for _, st := range tabs[1].Steps {
		if st.Playbook != "" {
			phase = st
			break
		}
	}
	if phase.Key == "" {
		t.Fatal("no playbook step in the runbook")
	}
	if code, b := req(alice, csrf, "PUT", "/api/jobs/"+j.ID+"/progress", map[string]any{"key": first.Key, "title": first.Title, "state": "done", "note": "核对通过，共 3 个文件", "log": "RESULT-TEXT-ONE OK", "images": []string{up.Name, upw.Name}, "total": 5}); code != 200 {
		t.Fatal(code, string(b))
	}
	if code, _ := req(alice, csrf, "PUT", "/api/jobs/"+j.ID+"/progress", map[string]any{"key": phase.Key, "title": phase.Title, "state": "failed", "note": "RESULT-TEXT-TWO", "total": 5}); code != 200 {
		t.Fatal(code)
	}
	// the picture is served, and only with the right type
	r := storeRequest(s, "GET", "/api/jobs/"+j.ID+"/progress/img/"+up.Name, nil, alice, "")
	if r.Code != 200 || r.Header().Get("Content-Type") != "image/png" || r.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal(r.Code, r.Header())
	}

	// the document carries every step, tagged by what it is
	_, body = req(alice, "", "GET", "/api/clusters/etcd-rep/docs/delivery", nil)
	var d clusterDoc
	json.Unmarshal(body, &d)
	var variants = map[string]int{}
	var images int
	for _, b := range d.Blocks {
		variants[b.Variant]++
		if b.Kind == "image" {
			images++
			if b.Job != j.ID || len(b.Items) != 2 {
				t.Fatalf("image block %+v", b)
			}
		}
	}
	if variants[variantAuto] == 0 || variants[variantCmd] == 0 || variants[variantResult] == 0 || images != 1 {
		t.Fatalf("variants %v images %d", variants, images)
	}

	text := func(q string) (string, int) {
		r := storeRequest(s, "GET", "/api/clusters/etcd-rep/export?docs=delivery"+q, nil, alice, "")
		if r.Code != 200 {
			t.Fatal(q, r.Code, r.Body.String())
		}
		z, err := zip.NewReader(bytes.NewReader(r.Body.Bytes()), int64(r.Body.Len()))
		if err != nil {
			t.Fatal(err)
		}
		var doc string
		media := 0
		for _, f := range z.File {
			if strings.HasPrefix(f.Name, "word/media/") {
				media++
			}
			if f.Name == "word/document.xml" {
				rc, _ := f.Open()
				b, _ := io.ReadAll(rc)
				rc.Close()
				doc = string(b)
			}
		}
		return doc, media
	}
	// the default is the manuals' format: commands and results
	doc, media := text("")
	for _, want := range []string{"RESULT-TEXT-ONE", "RESULT-TEXT-TWO", "核对通过", "执行结果", "判据", "<w:drawing>"} {
		if !strings.Contains(doc, want) {
			t.Errorf("default export lacks %q", want)
		}
	}
	if media != 2 {
		t.Errorf("media files: %d", media)
	}
	if strings.Contains(doc, phase.Playbook+"</w:t>") && strings.Contains(doc, "执行 "+phase.Playbook) {
		t.Error("the default export carries the automation version")
	}
	// without results: the steps only, no pictures
	doc, media = text("&results=0")
	if strings.Contains(doc, "RESULT-TEXT") || strings.Contains(doc, "核对通过") || strings.Contains(doc, "<w:drawing>") || media != 0 {
		t.Error("an export without results carries results")
	}
	if !strings.Contains(doc, "判据") {
		t.Error("an export without results lost the steps")
	}
	// automation only, then both
	auto, _ := text("&steps=auto&results=0")
	if !strings.Contains(auto, "执行 "+phase.Playbook) {
		t.Errorf("the automation version lacks the playbook %s", phase.Playbook)
	}
	both, _ := text("&steps=cmd,auto&results=0")
	if !strings.Contains(both, "执行 "+phase.Playbook) || len(both) <= len(auto) {
		t.Error("both versions are not both")
	}
	// clearing the results keeps what people wrote and attached; only "all" removes it
	if code, _ := req(alice, csrf, "DELETE", "/api/jobs/"+j.ID+"/progress", nil); code != 200 {
		t.Fatal(code)
	}
	if r := storeRequest(s, "GET", "/api/jobs/"+j.ID+"/progress/img/"+up.Name, nil, alice, ""); r.Code != 200 {
		t.Fatal("clearing the results took the picture away", r.Code)
	}
	steps, _ := s.execRecord(j.ID)
	if len(steps) == 0 || steps[0].State != "" || !strings.Contains(steps[0].Log, "RESULT-TEXT-ONE") {
		t.Fatalf("the output was not kept: %+v", steps)
	}
	if code, _ := req(alice, csrf, "DELETE", "/api/jobs/"+j.ID+"/progress?all=1", nil); code != 200 {
		t.Fatal(code)
	}
	if r := storeRequest(s, "GET", "/api/jobs/"+j.ID+"/progress/img/"+up.Name, nil, alice, ""); r.Code != 404 {
		t.Fatal("the picture outlived a full delete", r.Code)
	}
}

// Uploading the controller's logs fills in the record, and the report carries what the tasks did.
func TestRunLogsFillTheRecord(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	w := storeCreate(t, s, alice, csrf, `{"id":"etcd-log","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	var j storeJob
	json.Unmarshal(w.Body.Bytes(), &j)
	var phase reportStep
	for _, t := range s.runbookSteps(j.ID) {
		for _, st := range t.Steps {
			if st.Playbook != "" && phase.Key == "" {
				phase = st
			}
		}
	}
	sample, err := os.ReadFile("testdata/runlog-sample.log")
	if err != nil {
		t.Fatal(err)
	}
	logText := strings.ReplaceAll(string(sample), "11-demo.yml", phase.Playbook)
	upload := func(name string, data []byte) (int, []byte) {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		f, _ := form.CreateFormFile("files", name)
		f.Write(data)
		form.Close()
		r := httptest.NewRequest("POST", s.cfg.PublicURL+"/api/jobs/"+j.ID+"/progress/logs", &body)
		r.Header.Set("Origin", s.cfg.PublicURL)
		r.Header.Set("X-CSRF-Token", csrf)
		r.Header.Set("Content-Type", form.FormDataContentType())
		r.AddCookie(alice)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, r)
		return rec.Code, rec.Body.Bytes()
	}
	// a zip of the logs directory
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	zf, _ := zw.Create("logs/20261027-192000-" + filepath.Base(phase.Playbook) + ".log")
	zf.Write([]byte(logText))
	zf2, _ := zw.Create("logs/notes.txt")
	zf2.Write([]byte("not a log"))
	zw.Close()
	code, body := upload("logs.zip", zb.Bytes())
	if code != 200 || !strings.Contains(string(body), `"matched":1`) {
		t.Fatal(code, string(body))
	}
	if code, _ := upload("x.log", []byte("just some text")); code != 400 {
		t.Fatal("took a file that is not a log", code)
	}
	steps, _ := s.execRecord(j.ID)
	if len(steps) != 1 || steps[0].By != runLogBy || steps[0].State != "failed" || !strings.Contains(steps[0].Log, "boom 失败了") {
		t.Fatalf("record from the log: %+v", steps)
	}
	// a person's own record is not overwritten by a later upload
	req := func(method, path string, body any) int {
		b, _ := json.Marshal(body)
		return storeRequest(s, method, path, bytes.NewReader(b), alice, csrf).Code
	}
	if c := req("PUT", "/api/jobs/"+j.ID+"/progress", map[string]any{"key": phase.Key, "title": phase.Title, "state": "done", "note": "现场重跑后通过"}); c != 200 {
		t.Fatal(c)
	}
	upload("logs.zip", zb.Bytes())
	if steps, _ = s.execRecord(j.ID); steps[0].State != "done" || steps[0].By == runLogBy {
		t.Fatalf("a hand-written record was replaced: %+v", steps[0])
	}
	r := storeRequest(s, "GET", "/api/clusters/etcd-log/export?docs=delivery", nil, alice, "")
	z, _ := zip.NewReader(bytes.NewReader(r.Body.Bytes()), int64(r.Body.Len()))
	var doc string
	for _, f := range z.File {
		if f.Name == "word/document.xml" {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			doc = string(b)
		}
	}
	for _, want := range []string{"自动化执行", "boom 失败了", "hello from test", "output hidden", "unreachable"} {
		if !strings.Contains(doc, want) {
			t.Errorf("the report lacks %q", want)
		}
	}
	// the files are kept with the delivery and go with it
	if code := req("DELETE", "/api/jobs/"+j.ID+"/progress", nil); code != 200 || len(s.runLogs(j.ID)) == 0 {
		t.Fatal("clearing the results took the logs away", code)
	}
	if code := req("DELETE", "/api/jobs/"+j.ID+"/progress?all=1", nil); code != 200 {
		t.Fatal(code)
	}
	if len(s.runLogs(j.ID)) != 0 {
		t.Fatal("logs outlived the record")
	}
}

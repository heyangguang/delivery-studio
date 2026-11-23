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

	"middleware-deployer/mwpack"
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

func TestTerminalTranscriptAndWordExport(t *testing.T) {
	// 1. Verify buildTerminalTranscript strips Ansible boilerplate/telemetry and pairs real commands with real host output.
	rawLog := strings.Join([]string{
		"18:11:52 playbook   tests/vip/vip-holder.yml",
		"18:11:52 started    2026-11-19 18:11:52 +0800",
		"18:11:52 PLAY  确认集群标识",
		"18:11:52 TASK  必须带 -e confirm_cluster=verify-keepalived-ha",
		"18:11:52   ok          ka-1",
		"18:11:52     msg: All assertions passed",
		"18:11:52 PLAY  [vip] VIP 持有者",
		"18:11:52 TASK  keepalived : 读取本机网卡地址",
		"18:11:53   ok          ka-1",
		"18:11:53     stdout:",
		"18:11:53       2: eth0    inet 172.26.198.120/20 scope global dynamic eth0",
		"18:11:53       2: eth0    inet 172.26.198.250/20 scope global secondary eth0",
		"18:11:53     delta: 0:00:00.007667",
		"18:11:53     ansible_job_id: j12345",
		"18:11:53   ok          ka-2",
		"18:11:53     stdout: 2: eth0    inet 172.26.198.118/20 scope global dynamic eth0",
		"18:11:53     delta: 0:00:00.007505",
		"18:11:53 TASK  keepalived : 恰好一台机器持有 VIP",
		"18:11:53   ok          ka-1",
		"18:11:53     msg: VIP 172.26.198.250 由 ka-1 持有",
		"18:11:53 TASK  核对步骤完成条件",
		"18:11:53   ok          ka-1",
		"18:11:53     msg: All assertions passed",
		"18:11:53 RECAP",
		"18:11:53   ka-1                 ok=3 changed=0 unreachable=0 failed=0 skipped=0",
		"18:11:53   ka-2                 ok=2 changed=0 unreachable=0 failed=0 skipped=0",
		"18:11:53 RESULT  PASSED",
	}, "\n")
	rl := parseRunLog("vip-holder.log", []byte(rawLog))
	step := reportStep{
		Key:   "tests/vip/vip-holder",
		Title: "[vip] VIP 持有者",
		Hosts: []string{"ka-1", "ka-2"},
		Parts: []planStepDoc{{
			Actions: []mwpack.Action{
				{Name: "读取本机网卡地址", Cmd: "ip -4 -o addr show dev eth0"},
				{Name: "恰好一台机器持有 VIP", Check: true},
			},
		}},
	}
	exit0 := 0
	hostIPs := map[string]string{"ka-1": "172.26.198.120", "ka-2": "172.26.198.118"}
	term := buildTerminalTranscript(step, rl, hostIPs, terminalMeta{
		State:    "succeeded",
		ExitCode: &exit0,
		Hosts:    []string{"ka-1", "ka-2"},
	}, "")
	for _, want := range []string{
		"ka-1 (172.26.198.120)",
		"ka-2 (172.26.198.118)",
		"PASSED (exit 0)",
		"[root@ka-1 ~]# ip -4 -o addr show dev eth0",
		"172.26.198.250/20",
		"[root@ka-2 ~]# ip -4 -o addr show dev eth0",
		"172.26.198.118/20",
		"VIP 172.26.198.250 由 ka-1 持有",
	} {
		if !strings.Contains(term, want) {
			t.Fatalf("terminal transcript missing %q:\n%s", want, term)
		}
	}
	for _, unwanted := range []string{"delta:", "ansible_job_id:", "confirm_cluster", "All assertions passed"} {
		if strings.Contains(term, unwanted) {
			t.Fatalf("terminal transcript leaked Ansible noise %q:\n%s", unwanted, term)
		}
	}

	// 2. Verify formatManualTerminalLog wraps clean 2-line manual command with host prompt.
	man := formatManualTerminalLog(reportStep{
		Title:   "核对上传文件",
		Hosts:   []string{"ka-1"},
		Command: "cd /tmp/mw-upload\nsha256sum --check SHA256SUMS",
	}, hostIPs, "packages.tar.gz: OK\n", "")
	if !strings.Contains(man, "[root@ka-1 ~]# cd /tmp/mw-upload && sha256sum --check SHA256SUMS") || !strings.Contains(man, "packages.tar.gz: OK") {
		t.Fatalf("unexpected manual terminal log:\n%s", man)
	}

	// 3. Verify export filtering by log_style=cmd vs log_style=auto vs log_style=cmd,auto and Word dark terminal + shell syntax XML.
	doc := &clusterDoc{
		Title: "交付报告",
		Blocks: []docBlock{
			{Kind: "h", Level: 1, Text: "1 步骤"},
			{Kind: "code", Style: "shell", Variant: variantCmd, Detail: true, Text: "# ka-1 (172.26.198.120) root  检查网卡\nip -4 -o addr show dev eth0"},
			{Kind: "code", Style: "terminal", Variant: variantResultCmd, Detail: true, Text: term},
			{Kind: "code", Style: "ansible", Variant: variantResultAuto, Detail: true, Text: rawLog},
		},
	}
	cmdOnly := parseExportOptions(map[string][]string{"detail": {"1"}, "steps": {"cmd"}, "results": {"1"}, "log_style": {"cmd"}}).filtered(doc)
	if len(cmdOnly.Blocks) != 3 {
		t.Fatalf("log_style=cmd expected 3 blocks (h + shell + terminal), got %d: %+v", len(cmdOnly.Blocks), cmdOnly.Blocks)
	}
	autoOnly := parseExportOptions(map[string][]string{"detail": {"1"}, "steps": {"cmd"}, "results": {"1"}, "log_style": {"auto"}}).filtered(doc)
	if len(autoOnly.Blocks) != 3 || autoOnly.Blocks[2].Variant != variantResultAuto {
		t.Fatalf("log_style=auto expected ansible log block, got %+v", autoOnly.Blocks)
	}
	bothLogs := parseExportOptions(map[string][]string{"detail": {"1"}, "steps": {"cmd"}, "results": {"1"}, "log_style": {"cmd,auto"}}).filtered(doc)
	if len(bothLogs.Blocks) != 4 {
		t.Fatalf("log_style=cmd,auto expected all 4 blocks, got %d", len(bothLogs.Blocks))
	}

	w := newDocxWriter(themeOf("teal"), "rIdTest")
	writeDocBody(w, cmdOnly, 0, nil)
	xmlOut := w.b.String()
	for _, wantXML := range []string{
		`w:color w:val="1D4ED8"`, // shell command verb highlight
		`w:color w:val="4D7C0F"`, // shell flag highlight
		`w:fill="0F172A"`,        // dark Linux terminal background
		`w:color w:val="4ADE80"`, // green terminal prompt
		`[root@ka-1 ~]# `,
	} {
		if !strings.Contains(xmlOut, wantXML) {
			t.Fatalf("docx XML missing %q", wantXML)
		}
	}
}

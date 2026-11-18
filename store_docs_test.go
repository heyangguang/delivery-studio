package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClusterDocs(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	bob, _ := storeLogin(t, s, "bob")
	create := func(spec string) storeJob {
		w := storeCreate(t, s, alice, csrf, spec, nil)
		s.wg.Wait()
		var j storeJob
		json.Unmarshal(w.Body.Bytes(), &j)
		if w.Code != 202 {
			t.Fatal(w.Code, w.Body.String())
		}
		return j
	}
	req := func(cookie *http.Cookie, method, path string, body any) (int, []byte) {
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		tok := ""
		if method != "GET" {
			tok = csrf
		}
		w := storeRequest(s, method, path, rd, cookie, tok)
		return w.Code, w.Body.Bytes()
	}
	one := `{"id":"etcd-doc","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	a := create(one)
	if code, b := req(alice, "PUT", "/api/jobs/"+a.ID+"/progress", map[string]any{"key": "deploy-preflight", "title": "阶段：环境检查", "state": "done", "total": 5}); code != 200 {
		t.Fatal(code, string(b))
	}
	req(alice, "PUT", "/api/jobs/"+a.ID+"/progress", map[string]any{"key": "deploy-bootstrap", "title": "阶段：集群引导", "state": "failed", "note": "n1 引导超时", "log": "context deadline exceeded", "total": 5})
	req(alice, "PUT", "/api/jobs/"+a.ID+"/progress", map[string]any{"key": "deploy-z-verify", "title": "阶段：复核", "state": "skipped", "total": 5})
	req(alice, "PATCH", "/api/jobs/"+a.ID, map[string]string{"outcome": "failed", "note": "停在集群引导"})
	if steps, _ := s.execRecord(a.ID); len(steps) != 3 || steps[0].Title != "阶段：环境检查" || steps[1].Title != "阶段：集群引导" || steps[2].Title != "阶段：复核" {
		t.Fatalf("record out of order: %+v", steps)
	}

	code, body := req(alice, "GET", "/api/clusters/etcd-doc/docs", nil)
	var list []clusterDoc
	json.Unmarshal(body, &list)
	var ids []string
	for _, d := range list {
		ids = append(ids, d.ID)
	}
	if code != 200 || strings.Join(ids, ",") != "delivery,kt,rca-"+a.ID {
		t.Fatalf("%d %s", code, body)
	}
	// somebody who cannot see the cluster sees no documents
	if code, _ := req(bob, "GET", "/api/clusters/etcd-doc/docs", nil); code != 404 {
		t.Fatal("bob saw alice's documents", code)
	}
	var d clusterDoc
	_, body = req(alice, "GET", "/api/clusters/etcd-doc/docs/delivery", nil)
	json.Unmarshal(body, &d)
	all := string(body)
	for _, want := range []string{"10.0.1.11", "阶段：环境检查", "n1 引导超时", "停在集群引导"} {
		if !strings.Contains(all, want) {
			t.Errorf("the delivery report lacks %q", want)
		}
	}
	if d.Sections != 3 || d.Empty != 3 {
		t.Fatalf("sections %d empty %d", d.Sections, d.Empty)
	}
	// the handover carries the component's operations knowledge, filled in for this instance
	_, body = req(alice, "GET", "/api/clusters/etcd-doc/docs/kt", nil)
	if !strings.Contains(string(body), "endpoint health --cluster") || !strings.Contains(string(body), "127.0.0.1:2379") || strings.Contains(string(body), "${") {
		t.Fatalf("handover %s", body)
	}
	_, body = req(alice, "GET", "/api/clusters/etcd-doc/docs/rca-"+a.ID, nil)
	if !strings.Contains(string(body), "context deadline exceeded") {
		t.Fatalf("rca %s", body)
	}
	// a section people write is saved and counts as confirmed
	code, body = req(alice, "PUT", "/api/clusters/etcd-doc/docs/delivery/sections/summary", map[string]any{"text": "这是一个 **etcd** 集群。\n- 第一点"})
	json.Unmarshal(body, &d)
	if code != 200 || d.Empty != 2 || d.Drafts != 0 {
		t.Fatalf("%d %s", code, body)
	}
	if code, _ := req(alice, "PUT", "/api/clusters/etcd-doc/docs/delivery/sections/nope", map[string]any{"text": "x"}); code != 404 {
		t.Fatal("saved a section that does not exist", code)
	}
	// Word: one document, several merged, several apart
	check := func(data []byte) string {
		z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			t.Fatal(err)
		}
		var doc string
		for _, f := range z.File {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			if strings.HasSuffix(f.Name, ".xml") || strings.HasSuffix(f.Name, ".rels") {
				dec := xml.NewDecoder(bytes.NewReader(b))
				for {
					if _, err := dec.Token(); err != nil {
						if err != io.EOF {
							t.Fatalf("%s is not well-formed: %v", f.Name, err)
						}
						break
					}
				}
			}
			if f.Name == "word/document.xml" {
				doc = string(b)
			}
		}
		return doc
	}
	w := storeRequest(s, "GET", "/api/clusters/etcd-doc/export?docs=delivery", nil, alice, "")
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Disposition"), ".docx") {
		t.Fatal(w.Code, w.Body.String())
	}
	if doc := check(w.Body.Bytes()); !strings.Contains(doc, "etcd-doc") || !strings.Contains(doc, "<w:b/>") || !strings.Contains(doc, "TOC") {
		t.Fatal("the report misses its content")
	}
	w = storeRequest(s, "GET", "/api/clusters/etcd-doc/export?docs=delivery,kt,rca-"+a.ID+"&merge=1", nil, alice, "")
	if doc := check(w.Body.Bytes()); !strings.Contains(doc, "运维交接文档") || !strings.Contains(doc, "根因分析报告") {
		t.Fatal("the merged file misses a document")
	}
	w = storeRequest(s, "GET", "/api/clusters/etcd-doc/export?docs=delivery,kt", nil, alice, "")
	z, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil || len(z.File) != 2 || !strings.HasSuffix(z.File[0].Name, ".docx") {
		t.Fatalf("separate export: %v", err)
	}
	for _, f := range z.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		check(b)
	}
	// the template is a setting of its own
	if code, _ := req(alice, "PUT", "/api/settings/report", map[string]string{"org": "某公司"}); code != 403 {
		t.Fatal("an engineer changed the report template", code)
	}
}

func TestClusterDocsAIDraft(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	w := storeCreate(t, s, alice, csrf, `{"id":"etcd-ai","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	srv, bodies := fakeModel(t, "这是一个单成员的 etcd 集群，部署在 n1 上。【待补充：业务用途】")
	enableAI(t, s, srv.URL, 0)
	w = storeRequest(s, "POST", "/api/clusters/etcd-ai/docs/delivery/sections/summary/draft", strings.NewReader(`{"ask":"写短一点"}`), alice, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var d clusterDoc
	json.Unmarshal(w.Body.Bytes(), &d)
	sec := docSectionOf(&d, "summary")
	if sec == nil || sec.Source != "ai" || sec.Confirmed || d.Drafts != 1 || !strings.Contains(sec.Text, "单成员") {
		t.Fatalf("%s", w.Body.String())
	}
	if joined := strings.Join(*bodies, "\n"); !strings.Contains(joined, "10.0.1.11") || !strings.Contains(joined, "写短一点") {
		t.Fatal("the model was not given the facts and the request")
	}
	// confirming the draft unchanged keeps its source; editing it makes it the person's
	w = storeRequest(s, "PUT", "/api/clusters/etcd-ai/docs/delivery/sections/summary", strings.NewReader(`{"text":`+string(mustJSON(sec.Text))+`,"confirmed":true}`), alice, csrf)
	json.Unmarshal(w.Body.Bytes(), &d)
	if sec = docSectionOf(&d, "summary"); sec.Source != "ai" || !sec.Confirmed || d.Drafts != 0 {
		t.Fatalf("%s", w.Body.String())
	}
	// a section people write themselves cannot be drafted
	if w = storeRequest(s, "POST", "/api/clusters/etcd-ai/docs/kt/sections/contacts/draft", nil, alice, csrf); w.Code != 404 {
		t.Fatal("drafted the contacts", w.Code)
	}
}

func TestReportTemplate(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	admin, acsrf := storeLogin(t, s, "admin")
	w := storeCreate(t, s, alice, csrf, `{"id":"etcd-tpl","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()
	// a template as Word would save it: a cover whose placeholder is split over runs, {{content}}, a heading style
	// with a localised id, and no code style
	base := &docxWriter{}
	base.b.WriteString(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>{{ti</w:t></w:r><w:r><w:t>tle}} · {{cluster}}</w:t></w:r></w:p><w:p><w:r><w:t>某公司内部模板</w:t></w:r></w:p><w:p><w:r><w:t>{{content}}</w:t></w:r></w:p>`)
	raw, err := docxFile(base, "模板", "{{cluster}} 页眉", "页脚", "t")
	if err != nil {
		t.Fatal(err)
	}
	tpl, err := parseTemplate(raw)
	if err != nil {
		t.Fatal(err)
	}
	st := string(tpl.files["word/styles.xml"])
	st = strings.Replace(st, `w:styleId="Heading1"`, `w:styleId="1"`, 1)
	st = reStyle.ReplaceAllStringFunc(st, func(x string) string {
		if strings.Contains(x, `w:styleId="Code"`) {
			return ""
		}
		return x
	})
	tpl.files["word/styles.xml"] = []byte(st)
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	for _, n := range tpl.order {
		f, _ := z.Create(n)
		f.Write(tpl.files[n])
	}
	z.Close()
	upload := func(cookie *http.Cookie, tok string, data []byte) int {
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		fw, _ := mw.CreateFormFile("file", "公司模板.docx")
		fw.Write(data)
		mw.Close()
		r := httptest.NewRequest("POST", s.cfg.PublicURL+"/api/settings/report/template", &body)
		r.Header.Set("Origin", s.cfg.PublicURL)
		r.Header.Set("X-CSRF-Token", tok)
		r.Header.Set("Content-Type", mw.FormDataContentType())
		r.AddCookie(cookie)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, r)
		return rec.Code
	}
	if code := upload(alice, csrf, buf.Bytes()); code != 403 {
		t.Fatal("an engineer uploaded a template", code)
	}
	if code := upload(admin, acsrf, []byte("not a docx")); code != 400 {
		t.Fatal("accepted something that is not a docx", code)
	}
	if code := upload(admin, acsrf, buf.Bytes()); code != 200 {
		t.Fatal(code)
	}
	if rs := s.reportSettings(); !rs.UseTemplate || rs.Template != "公司模板.docx" {
		t.Fatalf("%+v", rs)
	}
	w = storeRequest(s, "GET", "/api/clusters/etcd-tpl/export?docs=kt", nil, alice, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	out, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, f := range out.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		files[f.Name] = string(b)
		if strings.HasSuffix(f.Name, ".xml") {
			dec := xml.NewDecoder(bytes.NewReader(b))
			for {
				if _, err := dec.Token(); err != nil {
					if err != io.EOF {
						t.Fatalf("%s is not well-formed: %v", f.Name, err)
					}
					break
				}
			}
		}
	}
	doc := files["word/document.xml"]
	for _, want := range []string{"运维交接文档 · etcd-tpl", "某公司内部模板", "endpoint health", `<w:pStyle w:val="1"/>`} {
		if !strings.Contains(doc, want) {
			t.Errorf("the exported file lacks %q", want)
		}
	}
	if strings.Contains(doc, "{{") || strings.Contains(doc, `w:val="Heading1"`) {
		t.Error("a placeholder or the platform's own heading id was left")
	}
	if !strings.Contains(files["word/styles.xml"], `w:styleId="Code"`) || !strings.Contains(files["word/header1.xml"], "etcd-tpl 页眉") {
		t.Error("missing style was not added, or the header placeholder was not filled")
	}
	// switching back to the built-in template
	if rec := storeRequest(s, "DELETE", "/api/settings/report/template", nil, admin, acsrf); rec.Code != 200 || s.reportTemplate() != nil {
		t.Fatal(rec.Code)
	}
}

func TestDocsStaleAndRCA(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	call := func(method, path, body string) (int, string) {
		var rd io.Reader
		if body != "" {
			rd = strings.NewReader(body)
		}
		tok := csrf
		if method == "GET" {
			tok = ""
		}
		w := storeRequest(s, method, path, rd, alice, tok)
		return w.Code, w.Body.String()
	}
	create := func(spec string) storeJob {
		w := storeCreate(t, s, alice, csrf, spec, nil)
		s.wg.Wait()
		var j storeJob
		json.Unmarshal(w.Body.Bytes(), &j)
		return j
	}
	a := create(`{"id":"etcd-st","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`)
	call("PATCH", "/api/jobs/"+a.ID, `{"outcome":"done"}`)
	call("PUT", "/api/clusters/etcd-st/docs/kt/sections/arch", `{"text":"单成员 etcd","confirmed":true}`)
	// a root-cause analysis started by hand: of a delivery that did not fail, and of an incident
	code, body := call("POST", "/api/clusters/etcd-st/docs", `{"job":"`+a.ID+`"}`)
	if code != 201 || !strings.Contains(body, "rca-"+a.ID) {
		t.Fatal(code, body)
	}
	if code, _ = call("POST", "/api/clusters/etcd-st/docs", `{}`); code != 400 {
		t.Fatal("an incident without a name was accepted", code)
	}
	code, body = call("POST", "/api/clusters/etcd-st/docs", `{"title":"10 月 27 日 n2 掉线"}`)
	var created struct{ ID string }
	json.Unmarshal([]byte(body), &created)
	if code != 201 || !strings.HasPrefix(created.ID, "rca-x") {
		t.Fatal(code, body)
	}
	_, body = call("GET", "/api/clusters/etcd-st/docs", "")
	if !strings.Contains(body, created.ID) || !strings.Contains(body, "rca-"+a.ID) || !strings.Contains(body, "n2 掉线") {
		t.Fatal(body)
	}
	_, body = call("GET", "/api/clusters/etcd-st/docs/"+created.ID, "")
	if !strings.Contains(body, "经历过的交付") || !strings.Contains(body, "timeline") {
		t.Fatal(body)
	}
	// the assistant asks before writing a root cause; the answers are kept and used next time
	srv, bodies := fakeModel(t, `{"questions":[{"question":"掉线前有没有人动过 n2？","options":["没有","有"]}]}`, "直接原因：n2 的数据盘写满。")
	enableAI(t, s, srv.URL, 0)
	code, body = call("POST", "/api/clusters/etcd-st/docs/"+created.ID+"/sections/cause/draft", `{}`)
	if code != 200 || !strings.Contains(body, "掉线前有没有人动过") {
		t.Fatal(code, body)
	}
	code, body = call("POST", "/api/clusters/etcd-st/docs/"+created.ID+"/sections/cause/draft", `{"answers":[{"question":"掉线前有没有人动过 n2？","answer":"有人在 n2 上拷了大文件"}]}`)
	if code != 200 || !strings.Contains(body, "数据盘写满") || !strings.Contains(body, "现场补充的信息") || !strings.Contains((*bodies)[1], "拷了大文件") {
		t.Fatal(code, body)
	}
	// an assessment: the question is its first section; the platform supplies the cluster and, for a selection,
	// the components it offers
	if code, _ = call("POST", "/api/clusters/etcd-st/docs", `{"kind":"assess","type":"capacity"}`); code != 400 {
		t.Fatal("an assessment without a question was accepted", code)
	}
	code, body = call("POST", "/api/clusters/etcd-st/docs", `{"kind":"assess","type":"selection","question":"前面要不要加负载均衡？"}`)
	var as struct{ ID string }
	json.Unmarshal([]byte(body), &as)
	if code != 201 || !strings.HasPrefix(as.ID, "assess-") {
		t.Fatal(code, body)
	}
	_, body = call("GET", "/api/clusters/etcd-st/docs/"+as.ID, "")
	if !strings.Contains(body, "前面要不要加负载均衡") || !strings.Contains(body, "平台上可用的组件") || !strings.Contains(body, "HAProxy") || !strings.Contains(body, `"manual":true`) {
		t.Fatal(body)
	}
	if code, _ = call("DELETE", "/api/clusters/etcd-st/docs/"+as.ID, ""); code != 200 {
		t.Fatal("could not remove the assessment", code)
	}
	// only the ones started by hand can be removed
	if code, _ = call("DELETE", "/api/clusters/etcd-st/docs/"+created.ID, ""); code != 200 {
		t.Fatal(code)
	}
	if code, _ = call("GET", "/api/clusters/etcd-st/docs/"+created.ID, ""); code != 404 {
		t.Fatal("removed analysis is still there", code)
	}
}

func makeTestPNG(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, color.RGBA{17, 82, 72, 255})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func readDocxZip(t *testing.T, data []byte) map[string]string {
	t.Helper()
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("invalid docx zip: %v", err)
	}
	files := map[string]string{}
	for _, f := range z.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		files[f.Name] = string(b)
	}
	return files
}

func assertValidXML(t *testing.T, name, raw string) {
	t.Helper()
	dec := xml.NewDecoder(strings.NewReader(raw))
	for {
		if _, err := dec.Token(); err != nil {
			if err == io.EOF {
				return
			}
			t.Fatalf("%s invalid XML: %v", name, err)
		}
	}
}

func uploadReportMultipart(s *storeServer, path, fname string, data []byte, cookie *http.Cookie, tok string) int {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", fname)
	fw.Write(data)
	mw.Close()
	r := httptest.NewRequest("POST", s.cfg.PublicURL+path, &body)
	r.Header.Set("Origin", s.cfg.PublicURL)
	r.Header.Set("X-CSRF-Token", tok)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r.AddCookie(cookie)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, r)
	return rec.Code
}

func TestDocsEnterpriseLayoutAndFrontControl(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	admin, acsrf := storeLogin(t, s, "admin")

	// 1. Update corporate report settings
	cfgBody := `{"org":"测试企业研发中心","project":"金融核心数据库项目","slogan":"高可用自动化交付","doc_version":"V2.3","author":"张工","reviewer":"李工","theme":"navy","confidential":"内部机密","header":"{project} · {title}","footer":"{org}"}`
	if w := storeRequest(s, "PUT", "/api/settings/report", strings.NewReader(cfgBody), alice, csrf); w.Code != 403 {
		t.Fatalf("operator updated report settings: %d", w.Code)
	}
	if w := storeRequest(s, "PUT", "/api/settings/report", strings.NewReader(cfgBody), admin, acsrf); w.Code != 200 {
		t.Fatalf("admin update settings: %d %s", w.Code, w.Body.String())
	}

	// 2. Summary endpoint readable with report.export (operator)
	if w := storeRequest(s, "GET", "/api/settings/report/summary", nil, alice, ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"theme":"navy"`) {
		t.Fatalf("summary endpoint: %d %s", w.Code, w.Body.String())
	}

	// 3. Banner upload IAM & validation
	if code := uploadReportMultipart(s, "/api/settings/report/banner", "bad.png", makeTestPNG(320, 90), alice, csrf); code != 403 {
		t.Fatalf("non-admin uploaded banner: %d", code)
	}
	if code := uploadReportMultipart(s, "/api/settings/report/banner", "notimg.png", []byte("plain text"), admin, acsrf); code != 400 {
		t.Fatalf("corrupt image accepted: %d", code)
	}
	if code := uploadReportMultipart(s, "/api/settings/report/banner", "corp-banner.png", makeTestPNG(400, 120), admin, acsrf); code != 200 {
		t.Fatalf("valid banner upload failed: %d", code)
	}
	if w := storeRequest(s, "GET", "/api/settings/report/banner", nil, admin, ""); w.Code != 200 || w.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("GET banner: %d %s", w.Code, w.Header().Get("Content-Type"))
	}

	// 4. Create cluster job and export merged enterprise manual
	w := storeCreate(t, s, alice, csrf, `{"id":"pg-ent","hosts":[{"name":"n1","ip":"10.0.1.11"},{"name":"n2","ip":"10.0.1.12"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1","n2"]}}]}`, nil)
	s.wg.Wait()
	if w.Code != 202 {
		t.Fatalf("create job: %d %s", w.Code, w.Body.String())
	}
	var j storeJob
	_ = json.Unmarshal(w.Body.Bytes(), &j)
	storeRequest(s, "PATCH", "/api/jobs/"+j.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf)

	exp := storeRequest(s, "GET", "/api/clusters/pg-ent/export?docs=delivery,kt&merge=1", nil, alice, "")
	if exp.Code != 200 {
		t.Fatalf("export merged docx: %d %s", exp.Code, exp.Body.String())
	}
	files := readDocxZip(t, exp.Body.Bytes())
	doc := files["word/document.xml"]
	for _, xmlName := range []string{"word/document.xml", "word/styles.xml", "word/settings.xml", "word/header1.xml", "word/footer1.xml", "word/header2.xml", "word/footer2.xml"} {
		if files[xmlName] == "" {
			t.Fatalf("missing OOXML part %s", xmlName)
		}
		assertValidXML(t, xmlName, files[xmlName])
	}
	for _, want := range []string{
		`<w:pgNumType w:fmt="upperRoman" w:start="1"/>`,
		`<w:pgNumType w:fmt="decimal"/>`,
		`TOCHeading`,
		`TOC \o "1-3"`,
		`版本控制信息`,
		`文档属性`,
		`文档变更过程`,
		`金融核心数据库项目`,
		`高可用自动化交付`,
		`V2.3`,
		`张工`,
		`李工`,
		`第1章`,
		`w:tblLayout w:type="fixed"`,
		`<w:tblHeader/>`,
		`w:fill="F1F2F4"`,
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("enterprise document.xml missing %q", want)
		}
	}
	if strings.Contains(doc, `<w:gridCol w:w="0"/>`) || strings.Contains(doc, `<w:tcW w:w="0"`) {
		t.Error("zero-width gridCol or tcW generated")
	}
	if !strings.Contains(files["word/styles.xml"], `w:leader="dot"`) {
		t.Error("styles.xml missing dotted TOC tab leader")
	}
	if !strings.Contains(files["word/footer1.xml"], "测试企业研发中心") || !strings.Contains(files["word/header2.xml"], "金融核心数据库项目") || !strings.Contains(files["word/footer2.xml"], "测试企业研发中心") {
		t.Errorf("header/footer variables not rendered: h2=%s f1=%s f2=%s", files["word/header2.xml"], files["word/footer1.xml"], files["word/footer2.xml"])
	}
	if !strings.Contains(files["word/settings.xml"], `<w:updateFields w:val="true"/>`) {
		t.Error("settings.xml missing auto-updateFields")
	}
	// The uploaded organization banner is used as-is; no generated cover artwork is added next to it.
	if strings.Contains(doc, `name="cover-banner-art"`) {
		t.Error("generated cover artwork must not be embedded in the standard manual")
	}
	for k := range files {
		if strings.HasPrefix(k, "word/media/mw-cover") {
			t.Errorf("generated cover media embedded: %s", k)
		}
	}

	// 5. Verify front=0 exports compact body-only docx without front matter cover/version-control
	compact := storeRequest(s, "GET", "/api/clusters/pg-ent/export?docs=kt&front=0", nil, alice, "")
	if compact.Code != 200 {
		t.Fatalf("compact export failed: %d", compact.Code)
	}
	cfiles := readDocxZip(t, compact.Body.Bytes())
	assertValidXML(t, "compact-doc", cfiles["word/document.xml"])
	if strings.Contains(cfiles["word/document.xml"], "版本控制信息") || strings.Contains(cfiles["word/document.xml"], `upperRoman`) {
		t.Error("front=0 should omit front matter and Roman section")
	}

	// 6. Delete custom banner: the manual then carries no pictures at all on its front matter
	if w := storeRequest(s, "DELETE", "/api/settings/report/banner", nil, admin, acsrf); w.Code != 200 || strings.Contains(w.Body.String(), `"banner":"corp-banner.png"`) {
		t.Fatalf("DELETE banner: %d %s", w.Code, w.Body.String())
	}
	if w := storeRequest(s, "GET", "/api/settings/report/banner", nil, admin, ""); w.Code != 404 {
		t.Fatalf("banner still present after delete: %d", w.Code)
	}
	plain := storeRequest(s, "GET", "/api/clusters/pg-ent/export?docs=kt", nil, alice, "")
	if plain.Code != 200 {
		t.Fatalf("export after banner delete failed: %d", plain.Code)
	}
	pfiles := readDocxZip(t, plain.Body.Bytes())
	assertValidXML(t, "plain-doc", pfiles["word/document.xml"])
	for k := range pfiles {
		if strings.HasPrefix(k, "word/media/") {
			t.Errorf("standard manual without an uploaded banner embeds a picture: %s", k)
		}
	}
	if strings.Contains(pfiles["word/document.xml"], "<w:drawing>") {
		t.Error("standard manual without an uploaded banner contains a drawing")
	}
}

func TestDocsStarterTemplateRoundTripAndDrawingML(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	admin, acsrf := storeLogin(t, s, "admin")

	if w := storeRequest(s, "PUT", "/api/settings/report", strings.NewReader(`{"org":"星辰科技","project":"核心中间件交付","slogan":"全链路高可用","doc_version":"V3.1","author":"陈工","reviewer":"王工","theme":"indigo","confidential":"机密","header":"{cluster} | {title}","footer":"{org}"}`), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}

	// 1. Download starter corporate template (.docx)
	if w := storeRequest(s, "GET", "/api/settings/report/starter-template", nil, alice, ""); w.Code != 403 {
		t.Fatalf("non-admin fetched starter template: %d", w.Code)
	}
	stRes := storeRequest(s, "GET", "/api/settings/report/starter-template", nil, admin, "")
	if stRes.Code != 200 || !strings.Contains(stRes.Header().Get("Content-Disposition"), ".docx") {
		t.Fatalf("starter-template failed: %d", stRes.Code)
	}
	// the editable starter template is plain text and styles: no embedded pictures that WPS/Word may fail to show
	for k := range readDocxZip(t, stRes.Body.Bytes()) {
		if strings.HasPrefix(k, "word/media/") {
			t.Errorf("starter template embeds a picture: %s", k)
		}
	}

	// 2. Upload starter-template back directly and export (must not duplicate TOC and must preserve footer PAGE field)
	if code := uploadReportMultipart(s, "/api/settings/report/template", "starter-custom.docx", stRes.Body.Bytes(), admin, acsrf); code != 200 {
		t.Fatalf("upload starter template failed: %d", code)
	}
	storeCreate(t, s, alice, csrf, `{"id":"etcd-rt","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	s.wg.Wait()

	rtExp := storeRequest(s, "GET", "/api/clusters/etcd-rt/export?docs=kt", nil, alice, "")
	if rtExp.Code != 200 {
		t.Fatalf("round-trip export failed: %d %s", rtExp.Code, rtExp.Body.String())
	}
	rtFiles := readDocxZip(t, rtExp.Body.Bytes())
	assertValidXML(t, "rt-doc", rtFiles["word/document.xml"])
	assertValidXML(t, "rt-footer2", rtFiles["word/footer2.xml"])
	if strings.Count(rtFiles["word/document.xml"], `TOC \o "1-3"`) != 1 {
		t.Errorf("expected exactly 1 TOC field when template already embeds TOC, got %d", strings.Count(rtFiles["word/document.xml"], `TOC \o "1-3"`))
	}
	if !strings.Contains(rtFiles["word/footer2.xml"], `PAGE`) || !strings.Contains(rtFiles["word/footer2.xml"], "星辰科技") {
		t.Errorf("footer2 lost PAGE field or placeholder: %s", rtFiles["word/footer2.xml"])
	}
	if strings.Contains(rtFiles["word/document.xml"], "{{") {
		t.Error("unfilled placeholder left after starter-template round-trip")
	}

	// 3. Test nested DrawingML <w:txbxContent><w:p>{{version}}</w:p> and Chinese Word style "标题 1"
	drawingDoc := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<w:body>
  <w:p>
    <w:r>
      <mc:AlternateContent><mc:Choice Requires="wps">
        <w:drawing><wp:inline><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><wps:txbx xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:txbxContent>
          <w:p><w:r><w:t>{{version}} · {{project}}</w:t></w:r></w:p>
        </w:txbxContent></wps:txbx></a:graphicData></a:graphic></wp:inline></w:drawing>
      </mc:Choice></mc:AlternateContent>
    </w:r>
  </w:p>
  <w:p><w:r><w:t>{{content}}</w:t></w:r></w:p>
  <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`
	cnStyles := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="正文"/></w:style>
  <w:style w:type="paragraph" w:styleId="ChH1"><w:name w:val="标题 1"/></w:style>
</w:styles>`

	// Re-pack from stRes skeleton replacing document.xml & styles.xml
	baseFiles := readDocxZip(t, stRes.Body.Bytes())
	baseFiles["word/document.xml"] = drawingDoc
	baseFiles["word/styles.xml"] = cnStyles
	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	for k, v := range baseFiles {
		fw, _ := zw.Create(k)
		_, _ = fw.Write([]byte(v))
	}
	_ = zw.Close()

	if code := uploadReportMultipart(s, "/api/settings/report/template", "drawing-cn.docx", zbuf.Bytes(), admin, acsrf); code != 200 {
		t.Fatalf("upload drawing-cn template: %d", code)
	}
	dExp := storeRequest(s, "GET", "/api/clusters/etcd-rt/export?docs=kt", nil, alice, "")
	if dExp.Code != 200 {
		t.Fatalf("drawing-cn export: %d %s", dExp.Code, dExp.Body.String())
	}
	dFiles := readDocxZip(t, dExp.Body.Bytes())
	dXML := dFiles["word/document.xml"]
	assertValidXML(t, "drawing-cn-doc", dXML)
	for _, want := range []string{`</w:txbxContent>`, `</mc:AlternateContent>`, `V3.1 · 核心中间件交付`, `<w:pStyle w:val="ChH1"/>`} {
		if !strings.Contains(dXML, want) {
			t.Errorf("drawing-cn exported document missing %q", want)
		}
	}
	if strings.Contains(dXML, "{{") {
		t.Error("placeholder remaining in DrawingML template export")
	}
}

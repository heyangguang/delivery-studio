package main

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	for n, c := range files {
		w, _ := zw.Create(n)
		w.Write([]byte(c))
	}
	zw.Close()
	return b.Bytes()
}

func testPDF(compress bool) []byte {
	content := "BT /F1 12 Tf 72 700 Td (Hello etcd needs SSD) Tj ET\nBT /F2 12 Tf 72 680 Td <00010002> Tj ET\n"
	cmap := "/CIDInit begincmap 2 beginbfchar <0001> <4F60> <0002> <597D> endbfchar endcmap"
	enc := func(s string) (string, string) {
		if !compress {
			return s, ""
		}
		var b bytes.Buffer
		zw := zlib.NewWriter(&b)
		zw.Write([]byte(s))
		zw.Close()
		return b.String(), "/Filter/FlateDecode"
	}
	c, f := enc(content)
	m, mf := enc(cmap)
	var o strings.Builder
	o.WriteString("%PDF-1.4\n")
	o.WriteString("1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n")
	o.WriteString("2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n")
	o.WriteString("3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>endobj\n")
	fmt.Fprintf(&o, "4 0 obj<</Length %d%s>>stream\n%s\nendstream endobj\n", len(c), f, c)
	o.WriteString("5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n")
	o.WriteString("6 0 obj<</Type/Font/Subtype/Type0/BaseFont/X/ToUnicode 7 0 R>>endobj\n")
	fmt.Fprintf(&o, "7 0 obj<</Length %d%s>>stream\n%s\nendstream endobj\n", len(m), mf, m)
	o.WriteString("trailer<</Root 1 0 R>>\n%%EOF\n")
	return []byte(o.String())
}

func TestExtractedText(t *testing.T) {
	for _, comp := range []bool{false, true} {
		got, err := pdfText(testPDF(comp))
		if err != nil || !strings.Contains(got, "Hello etcd needs SSD") || !strings.Contains(got, "你好") {
			t.Fatalf("pdf compressed=%v: %q %v", comp, got, err)
		}
	}
	docx := zipOf(t, map[string]string{"word/document.xml": `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>磁盘必须用 SSD</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>`})
	if got, err := docxText(docx); err != nil || !strings.Contains(got, "磁盘必须用 SSD\n第二段") {
		t.Fatalf("docx %q %v", got, err)
	}
	xlsx := zipOf(t, map[string]string{
		"xl/workbook.xml":            `<workbook xmlns:r="r"><sheets><sheet name="机器" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
		"xl/sharedStrings.xml":       `<sst><si><t>主机</t></si><si><t>IP</t></si><si><t>node-01</t></si></sst>`,
		"xl/worksheets/sheet1.xml":   `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>10</v></c></row></sheetData></worksheet>`,
	})
	if got, err := xlsxText(xlsx); err != nil || !strings.Contains(got, "工作表：机器") || !strings.Contains(got, "主机\tIP") || !strings.Contains(got, "node-01\t10") {
		t.Fatalf("xlsx %q %v", got, err)
	}
	pptx := zipOf(t, map[string]string{"ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>`, "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>标题页</a:t></a:r></a:p></p:sld>`})
	if got, err := pptxText(pptx); err != nil || strings.Index(got, "标题页") > strings.Index(got, "第二页") {
		t.Fatalf("pptx %q %v", got, err)
	}
	if _, err := pdfText([]byte("%PDF-1.4\nnot really")); err == nil {
		t.Fatal("a broken pdf was read")
	}
}

func upload(t *testing.T, s *storeServer, c *http.Cookie, csrf, query string, files map[string][]byte) (*httptest.ResponseRecorder, struct {
	Added  []fileNode `json:"added"`
	Failed []string   `json:"failed"`
}) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for n, b := range files {
		fw, _ := mw.CreateFormFile("file", n)
		fw.Write(b)
	}
	mw.Close()
	r := httptest.NewRequest("POST", s.cfg.PublicURL+"/api/me/files"+query, &body)
	r.Header.Set("Origin", s.cfg.PublicURL)
	r.Header.Set("X-CSRF-Token", csrf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r.AddCookie(c)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	var out struct {
		Added  []fileNode `json:"added"`
		Failed []string   `json:"failed"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestStorageSpace(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	bob, bcsrf := storeLogin(t, s, "bob")
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{1}, 100)...)
	w, up := upload(t, s, alice, csrf, "", map[string][]byte{"notes.md": []byte("# 机房\n管理网 10.8.0.0/16"), "shot.png": png, "plan.pdf": testPDF(true), "tool.exe": []byte("MZ\x90\x00binary")})
	if w.Code != 200 || len(up.Added) != 4 {
		t.Fatal(w.Code, w.Body.String())
	}
	kinds := map[string]fileNode{}
	for _, n := range up.Added {
		kinds[n.Name] = n
	}
	if kinds["notes.md"].Kind != "doc" || kinds["shot.png"].Kind != "file" || kinds["shot.png"].Text || !kinds["plan.pdf"].Text || kinds["tool.exe"].Text {
		t.Fatalf("%+v", kinds)
	}
	// a folder, moving into it, and the same name twice
	w = storeRequest(s, "POST", "/api/me/files", strings.NewReader(`{"kind":"folder","name":"现场"}`), alice, csrf)
	var folder fileNode
	json.Unmarshal(w.Body.Bytes(), &folder)
	if w.Code != 201 || folder.Kind != "folder" {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := storeRequest(s, "PATCH", "/api/me/files/"+kinds["plan.pdf"].ID, strings.NewReader(`{"parent":"`+folder.ID+`"}`), alice, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, again := upload(t, s, alice, csrf, "?parent="+folder.ID, map[string][]byte{"plan.pdf": testPDF(false)}); len(again.Added) != 1 || again.Added[0].Name != "plan (2).pdf" {
		t.Fatalf("%+v", again)
	}
	if w := storeRequest(s, "PATCH", "/api/me/files/"+folder.ID, strings.NewReader(`{"parent":"`+folder.ID+`"}`), alice, csrf); w.Code != 400 {
		t.Fatal("a folder went into itself", w.Code)
	}
	// text out of the PDF is what the assistant finds, and only for its owner
	x := s.extFor("assistant", aiOpts{User: "alice"})
	if got := x.wrap(nil)("search_knowledge", `{"query":"etcd SSD"}`); !strings.Contains(got, "plan.pdf") || !strings.Contains(got, "Hello etcd needs SSD") {
		t.Fatal(got)
	}
	if s.extFor("assistant", aiOpts{User: "bob"}).kb {
		t.Fatal("someone else's files are searchable")
	}
	if w := storeRequest(s, "GET", "/api/me/files/"+kinds["notes.md"].ID, nil, bob, ""); w.Code != 404 {
		t.Fatal("another person's file was opened", w.Code)
	}
	// what the browser may show inline, and what is always a download
	if w := storeRequest(s, "GET", "/api/me/files/"+kinds["shot.png"].ID+"/raw", nil, alice, ""); w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "inline") || !strings.Contains(w.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatal(w.Code, w.Header())
	}
	if w := storeRequest(s, "GET", "/api/me/files/"+kinds["tool.exe"].ID+"/raw", nil, alice, ""); w.Header().Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment") {
		t.Fatal(w.Header())
	}
	// a folder goes with everything in it, and the space is given back
	var usage struct {
		Usage struct{ Used, Quota int64 } `json:"usage"`
	}
	json.Unmarshal(storeRequest(s, "GET", "/api/me/files", nil, alice, "").Body.Bytes(), &usage)
	if usage.Usage.Quota != 20<<30 || usage.Usage.Used < 100 {
		t.Fatal(usage)
	}
	if w := storeRequest(s, "DELETE", "/api/me/files/"+folder.ID, nil, alice, csrf); w.Code != 200 {
		t.Fatal(w.Code)
	}
	var after struct {
		Usage struct{ Used int64 } `json:"usage"`
	}
	json.Unmarshal(storeRequest(s, "GET", "/api/me/files", nil, alice, "").Body.Bytes(), &after)
	if after.Usage.Used >= usage.Usage.Used {
		t.Fatal("the space was not given back", usage, after)
	}
	_ = bcsrf
}

func TestStorageQuotaAndLimits(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, csrf := storeLogin(t, s, "alice")
	// 1 KB for alice
	if w := storeRequest(s, "PUT", "/api/users/alice/quota", strings.NewReader(`{"gb":0.000001}`), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	_, up := upload(t, s, alice, csrf, "", map[string][]byte{"big.bin": bytes.Repeat([]byte{7}, 5000)})
	if len(up.Added) != 0 || len(up.Failed) != 1 || !strings.Contains(up.Failed[0], "存储空间") {
		t.Fatalf("%+v", up)
	}
	if w := storeRequest(s, "POST", "/api/me/files", strings.NewReader(`{"kind":"doc","name":"x","text":"`+strings.Repeat("字", 600)+`"}`), alice, csrf); w.Code != 413 {
		t.Fatal("a document went over the quota", w.Code)
	}
	// back to the default; the file limit applies
	storeRequest(s, "PUT", "/api/users/alice/quota", strings.NewReader(`{"gb":-1}`), admin, acsrf)
	if w := storeRequest(s, "PUT", "/api/settings/storage", strings.NewReader(`{"default_gb":20,"max_file_mb":1}`), admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	_, up = upload(t, s, alice, csrf, "", map[string][]byte{"two.bin": bytes.Repeat([]byte{7}, 2<<20)})
	if len(up.Added) != 0 || len(up.Failed) != 1 || !strings.Contains(up.Failed[0], "1 MB") {
		t.Fatalf("%+v", up)
	}
	// only those with the permission may change the settings
	if w := storeRequest(s, "PUT", "/api/settings/storage", strings.NewReader(`{"default_gb":1000,"max_file_mb":9}`), alice, csrf); w.Code != 403 {
		t.Fatal("anyone could change the quota", w.Code)
	}
}

func TestOldKnowledgeBaseMovesIn(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	dir := s.aiFile("users/alice/kb")
	os.MkdirAll(dir, 0o700)
	b, _ := json.Marshal(map[string]any{"id": "0123456789ab", "title": "老资料", "text": "etcd 用 SSD", "created": "2026-01-01T00:00:00Z", "updated": "2026-01-01T00:00:00Z"})
	os.WriteFile(filepath.Join(dir, "0123456789ab.json"), b, 0o600)
	if got := s.kbList("alice"); len(got) != 1 || got[0].Title != "老资料" {
		t.Fatal(got)
	}
	if d, ok := s.kbGet("alice", "0123456789ab"); !ok || d.Text != "etcd 用 SSD" {
		t.Fatal(d)
	}
	if w := storeRequest(s, "GET", "/api/me/kb/search?q=SSD", nil, alice, ""); !strings.Contains(w.Body.String(), "老资料") {
		t.Fatal(w.Body.String())
	}
	_ = csrf
}

func TestChatAttachmentsReachTheModel(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	bob, bcsrf := storeLogin(t, s, "bob")
	srv, bodies := fakeModel(t, "看到了。")
	enableAI(t, s, srv.URL, 1)
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{1}, 50)...)
	secret := []byte("机房说明\npassword=hunter2-very-secret\n管理网 10.8.0.0/16")
	_, up := upload(t, s, alice, csrf, "?parent=@chat&source=chat", map[string][]byte{"shot.png": png, "plan.pdf": testPDF(true), "说明.txt": secret})
	if len(up.Added) != 3 {
		t.Fatal(up)
	}
	ids := []string{}
	for _, n := range up.Added {
		ids = append(ids, `"`+n.ID+`"`)
		if n.Parent == "" {
			t.Fatal("not in the conversation folder", n)
		}
	}
	id := "0123456789ab"
	w := storeRequest(s, "POST", "/api/ai/chats/"+id+"/chat", strings.NewReader(`{"message":"看看这些","attachments":[`+strings.Join(ids, ",")+`]}`), alice, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	sent := strings.Join(*bodies, "\n")
	if !strings.Contains(sent, "Hello etcd needs SSD") || !strings.Contains(sent, "10.8.0.0/16") || !strings.Contains(sent, "image_url") || !strings.Contains(sent, "data:image/png;base64,") {
		t.Fatal("the model was not given the files")
	}
	if strings.Contains(sent, "hunter2-very-secret") {
		t.Fatal("a secret in an attached file reached the model")
	}
	// the conversation keeps what was attached, for the page to show
	w = storeRequest(s, "GET", "/api/ai/chats/"+id, nil, alice, "")
	if !strings.Contains(w.Body.String(), `"files"`) || !strings.Contains(w.Body.String(), "plan.pdf") {
		t.Fatal(w.Body.String())
	}
	// someone else's files cannot be attached
	w = storeRequest(s, "POST", "/api/ai/chats/aaaaaaaaaaaa/chat", strings.NewReader(`{"message":"x","attachments":[`+ids[0]+`]}`), bob, bcsrf)
	if w.Code != 400 {
		t.Fatal("attached another person's file", w.Code, w.Body.String())
	}
	// archive and bring back
	if w := storeRequest(s, "PATCH", "/api/ai/chats/"+id, strings.NewReader(`{"archived":true}`), alice, csrf); w.Code != 200 || !strings.Contains(w.Body.String(), `"archived":true`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := storeRequest(s, "GET", "/api/ai/chats", nil, alice, ""); !strings.Contains(w.Body.String(), `"archived":true`) {
		t.Fatal(w.Body.String())
	}
}

func TestPersonalizationAndMemory(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	w := storeRequest(s, "PUT", "/api/me/ai-prefs", strings.NewReader(`{"tone":"direct","warmth":"more","emoji":"less","structure":"less","nickname":"小李","about":"我负责数据库，密码是 password=hunter2abc","instructions":"命令给完整版本"}`), alice, csrf)
	if w.Code != 200 || strings.Contains(w.Body.String(), "hunter2abc") {
		t.Fatal(w.Code, w.Body.String())
	}
	p := s.loadPrefs("alice").prompt()
	for _, want := range []string{"先给结论", "多一些体贴", "小李", "命令给完整版本", "不要使用表情符号"} {
		if !strings.Contains(p, want) {
			t.Fatal("missing", want, p)
		}
	}
	if got := s.runMemory("alice", `{"text":"用户负责两个机房的数据库运维"}`); !strings.HasPrefix(got, "已记住") {
		t.Fatal(got)
	}
	if got := s.runMemory("alice", `{"text":"主机 10.1.2.3 的 root 口令"}`); !strings.HasPrefix(got, "没有记") {
		t.Fatal("must not remember an address", got)
	}
	if !strings.Contains(s.loadPrefs("alice").prompt(), "两个机房") {
		t.Fatal("memory not in prompt")
	}
	x := s.extFor("assistant", aiOpts{User: "alice"})
	if !strings.Contains(x.prompt, "两个机房") || !x.memory {
		t.Fatal(x.prompt)
	}
	w = storeRequest(s, "PUT", "/api/me/ai-prefs", strings.NewReader(`{"tone":"default","memory_off":true}`), alice, csrf)
	if w.Code != 200 || strings.Contains(s.extFor("assistant", aiOpts{User: "alice"}).prompt, "两个机房") {
		t.Fatal("memory off must stop using memories")
	}
	if got := s.runMemory("alice", `{"text":"另一件事"}`); !strings.HasPrefix(got, "用户关闭了记忆") {
		t.Fatal(got)
	}
}

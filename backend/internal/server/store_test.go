package server

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"delivery-studio/mwpack"
)

func testStore(t *testing.T) (*storeServer, storeConfig) {
	t.Helper()
	root := t.TempDir()
	artifacts := filepath.Join(root, "artifacts")
	os.MkdirAll(artifacts, 0700)
	runtime := fixtureAutomationArchive(t, root)
	fakeLibrary(t, filepath.Join(root, "data", "library"), mwpack.DefaultPlatform, allUbuntuPackages(t))
	c := storeConfig{Listen: "127.0.0.1:8090", PublicURL: "http://127.0.0.1:8090", DataDir: filepath.Join(root, "data"), ArtifactsDir: artifacts, RuntimeArchive: runtime, MaxParallel: 2}
	for _, name := range []string{"alice", "bob"} {
		if err := addStoreUser(c.DataDir, name, "operator", "test-password-123456"); err != nil {
			t.Fatal(err)
		}
	}
	if err := addStoreUser(c.DataDir, "admin", "admin", "test-password-123456"); err != nil {
		t.Fatal(err)
	}
	s, err := newStoreServer(c)
	if err != nil {
		t.Fatal(err)
	}
	return s, c
}

type noNetwork struct{}

func (noNetwork) RoundTrip(r *http.Request) (*http.Response, error) {
	return nil, fmt.Errorf("no network in tests: %s", r.URL)
}
func storeRequest(s *storeServer, method, path string, body io.Reader, cookie *http.Cookie, csrf string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8090"+path, body)
	r.Header.Set("Origin", s.cfg.PublicURL)
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if csrf != "" {
		r.Header.Set("X-CSRF-Token", csrf)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func storeLogin(t *testing.T, s *storeServer, user string) (*http.Cookie, string) {
	t.Helper()
	w := storeRequest(s, "POST", "/api/login", strings.NewReader(`{"Username":"`+user+`","Password":"test-password-123456"}`), nil, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var session map[string]string
	json.Unmarshal(w.Body.Bytes(), &session)
	return w.Result().Cookies()[0], session["csrf"]
}

const singleNodeSpec = `{"id":"pg-one","hosts":[{"name":"db-1","ip":"10.0.1.11","disk":"/dev/vdb"}],"instances":[{"id":"pg","component":"postgresql","placement":{"primary":["db-1"]},"params":{"client_cidr":"10.0.1.0/24","tls":false,"tde":false}}]}`

func storeCreate(t *testing.T, s *storeServer, cookie *http.Cookie, csrf string, deployment string, files map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	form.WriteField("request", `{"deployment":`+deployment+`}`)
	for field, content := range files {
		f, _ := form.CreateFormFile(field, "../../not-used.pem")
		f.Write([]byte(content))
	}
	form.Close()
	r := httptest.NewRequest("POST", s.cfg.PublicURL+"/api/jobs", &body)
	r.Header.Set("Origin", s.cfg.PublicURL)
	if csrf != "" {
		r.Header.Set("X-CSRF-Token", csrf)
	}
	r.Header.Set("Content-Type", form.FormDataContentType())
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func TestStorePasswordHashAndAuthenticationBoundaries(t *testing.T) {
	if storePasswordHash("password", "salt", 1) != "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b" {
		t.Fatal("PBKDF2 vector mismatch")
	}
	s, c := testStore(t)
	b, _ := os.ReadFile(filepath.Join(c.DataDir, "users.json"))
	if bytes.Contains(b, []byte("test-password-123456")) {
		t.Fatal("plaintext persisted")
	}
	if w := storeRequest(s, "GET", "/api/catalog", nil, nil, ""); w.Code != 401 {
		t.Fatal("anonymous catalog access")
	}
	cookie, csrf := storeLogin(t, s, "alice")
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("unsafe session cookie")
	}
	if w := storeRequest(s, "POST", "/api/logout", nil, cookie, ""); w.Code != 403 {
		t.Fatal("missing CSRF accepted")
	}
	r := httptest.NewRequest("POST", s.cfg.PublicURL+"/api/logout", nil)
	r.AddCookie(cookie)
	r.Header.Set("Origin", "https://attacker.invalid")
	r.Header.Set("X-CSRF-Token", csrf)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("foreign origin accepted")
	}
	w = storeRequest(s, "GET", "/api/users", nil, cookie, "")
	if w.Code != 403 {
		t.Fatal("operator managed users")
	}
	w = storeRequest(s, "GET", "/api/catalog", nil, cookie, "")
	if w.Code != 200 || bytes.Contains(w.Body.Bytes(), []byte(c.ArtifactsDir)) || bytes.Contains(w.Body.Bytes(), []byte(c.DataDir)) {
		t.Fatal("catalog leaked server paths")
	}
	var catalog []struct {
		ID        string `json:"id"`
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
		Versions  []struct {
			ID       string `json:"id"`
			Coverage map[string]struct {
				Ready      bool `json:"ready"`
				Deployable bool `json:"deployable"`
			} `json:"coverage"`
		} `json:"versions"`
	}
	json.Unmarshal(w.Body.Bytes(), &catalog)
	seen := map[string]bool{}
	for _, e := range catalog {
		seen[e.ID] = e.Available
		if e.ID == "nginx" {
			// nginx 1.26 is for RedHat-family systems, which have no Ansible runtime here: not deployable, though ready.
			for _, v := range e.Versions {
				if v.ID == "1.26" && (v.Coverage["el9-amd64"].Deployable || v.Coverage["el9-amd64"].Ready) {
					t.Fatalf("el9 has neither library content nor runtime in this fixture: %+v", v.Coverage)
				}
				if v.ID == "1.24" && !(v.Coverage["ubuntu-24.04-amd64"].Ready && v.Coverage["ubuntu-24.04-amd64"].Deployable) {
					t.Fatalf("nginx 1.24 on ubuntu should be ready: %+v", v.Coverage)
				}
			}
		}
	}
	if len(seen) != 6 || seen["external-lb"] || !seen["postgresql"] || !seen["haproxy"] || !seen["redis"] {
		t.Fatalf("customer-operated components must not be listed, and fully stocked ones are available: %v", seen)
	}
	// Removing a package from the library makes exactly the components that need it unavailable, with the reason.
	if err := s.plat.lib.Delete(mwpack.DefaultPlatform, mwpack.PackageRequest{Name: "haproxy", Version: "2.8.30-0ubuntu0.24.04.1"}); err != nil {
		t.Fatal(err)
	}
	w = storeRequest(s, "GET", "/api/catalog", nil, cookie, "")
	var after []struct {
		ID        string `json:"id"`
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
	}
	json.Unmarshal(w.Body.Bytes(), &after)
	for _, e := range after {
		if e.ID == "haproxy" && (e.Available || !strings.Contains(e.Reason, "软件库")) {
			t.Fatalf("haproxy must be unavailable because the library lacks it: %+v", e)
		}
		if e.ID == "postgresql" && !e.Available {
			t.Fatal("unrelated components stay available")
		}
	}
	w = storeRequest(s, "GET", "/api/catalog?fronts=1", nil, cookie, "")
	if !bytes.Contains(w.Body.Bytes(), []byte(`"id":"external-lb"`)) {
		t.Fatal("the wizard needs the external load balancer as a front")
	}
	if w = storeRequest(s, "POST", "/api/logout", nil, cookie, csrf); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w = storeRequest(s, "GET", "/api/session", nil, cookie, ""); w.Code != 401 {
		t.Fatal("logged-out cookie accepted")
	}
}
func TestStoreJobsIsolationDownloadsDeletionAndRestart(t *testing.T) {
	s, c := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	bob, bobCSRF := storeLogin(t, s, "bob")
	if w := storeCreate(t, s, alice, "", singleNodeSpec, nil); w.Code == 202 {
		t.Fatal("create without csrf accepted")
	}
	bad := strings.Replace(singleNodeSpec, `"client_cidr":"10.0.1.0/24"`, `"client_cidr":"not-a-cidr"`, 1)
	if w := storeCreate(t, s, alice, csrf, bad, nil); w.Code != 400 || !bytes.Contains(w.Body.Bytes(), []byte("网段")) {
		t.Fatal("invalid spec accepted or unexplained", w.Code, w.Body.String())
	}
	w := storeCreate(t, s, alice, csrf, singleNodeSpec, nil)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	var job storeJob
	json.Unmarshal(w.Body.Bytes(), &job)
	s.wg.Wait()
	if job.AppID != "postgresql" || job.ClusterID != "pg-one" {
		t.Fatalf("job = %+v", job)
	}
	for _, path := range []string{"/api/jobs/" + job.ID, "/api/jobs/" + job.ID + "/archive", "/api/jobs/" + job.ID + "/files/01-部署步骤.md"} {
		if w = storeRequest(s, "GET", path, nil, bob, ""); w.Code != 404 {
			t.Fatal("cross-user job access", path, w.Code)
		}
	}
	if w = storeRequest(s, "DELETE", "/api/jobs/"+job.ID, nil, bob, bobCSRF); w.Code != 404 {
		t.Fatal("cross-user delete accepted")
	}
	w = storeRequest(s, "GET", "/api/jobs/"+job.ID, nil, alice, "")
	if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte("succeeded")) {
		t.Fatal(w.Body.String())
	}
	var detail struct {
		Files []struct{ Name string } `json:"files"`
		Spec  struct {
			YAML string `json:"yaml"`
		} `json:"spec"`
		Plan struct {
			Deploy []struct{ Phase string } `json:"deploy"`
		} `json:"plan"`
	}
	json.Unmarshal(w.Body.Bytes(), &detail)
	if !strings.Contains(detail.Spec.YAML, "client_cidr: 10.0.1.0/24") || len(detail.Plan.Deploy) < 4 || bytes.Contains(w.Body.Bytes(), []byte(c.DataDir)) {
		t.Fatal("job detail lacks the submitted spec or structured plan, or leaks server paths", w.Body.String())
	}
	names := map[string]bool{}
	for _, f := range detail.Files {
		names[f.Name] = true
	}
	for _, want := range []string{"00-环境准备.md", "01-部署步骤.md", "plan.json", "SHA256SUMS", "node01-pg-one-10.0.1.11.tar.gz", "packages-ubuntu-24.04-amd64.tar.gz"} {
		if !names[want] {
			t.Fatal("delivery lacks", want, names)
		}
	}
	w = storeRequest(s, "GET", "/api/jobs/"+job.ID+"/files/01-部署步骤.md", nil, alice, "")
	if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte("playbooks/00-preflight.yml")) {
		t.Fatal("owner download failed", w.Code)
	}
	w = storeRequest(s, "GET", "/api/jobs/"+job.ID+"/archive", nil, alice, "")
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Disposition"), "delivery-"+job.ID+".zip") {
		t.Fatalf("archive download failed: code=%d cd=%q", w.Code, w.Header().Get("Content-Disposition"))
	}
	zr, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatalf("invalid archive zip: %v", err)
	}
	zipNames := map[string]bool{}
	for _, zf := range zr.File {
		rc, err := zf.Open()
		if err != nil {
			t.Fatalf("open zip entry %s: %v", zf.Name, err)
		}
		_, err = io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("read zip entry %s: %v", zf.Name, err)
		}
		zipNames[zf.Name] = true
	}
	for _, want := range []string{"00-环境准备.md", "01-部署步骤.md", "plan.json", "SHA256SUMS"} {
		if !zipNames[want] {
			t.Fatalf("archive zip lacks %s: %v", want, zipNames)
		}
	}
	if w = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), bob, bobCSRF); w.Code != 404 {
		t.Fatal("cross-user status change accepted", w.Code)
	}
	if w = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"bogus"}`), alice, csrf); w.Code != 400 {
		t.Fatal("invalid status accepted", w.Code)
	}
	if w = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, ""); w.Code == 200 {
		t.Fatal("status change without CSRF accepted")
	}
	if w = storeRequest(s, "PATCH", "/api/jobs/"+job.ID, strings.NewReader(`{"outcome":"done"}`), alice, csrf); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"outcome":"done"`)) {
		t.Fatal("owner could not mark the delivery done", w.Code, w.Body.String())
	}
	s2, err := newStoreServer(c)
	if err != nil {
		t.Fatal(err)
	}
	if s2.jobs[job.ID].Outcome != "done" || s2.jobs[job.ID].State != "succeeded" {
		t.Fatal("marked status not persisted")
	}
	if w = storeRequest(s, "DELETE", "/api/jobs/"+job.ID, nil, alice, csrf); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if _, err = os.Stat(s.jobDir(job.ID)); !os.IsNotExist(err) {
		t.Fatal("private material not deleted")
	}
}

func TestStoreResolveShowsWhatThePlatformAdds(t *testing.T) {
	s, _ := testStore(t)
	cookie, csrf := storeLogin(t, s, "alice")
	ha := `{"id":"pg-ha","hosts":[{"name":"db-1","ip":"10.0.1.11","disk":"/dev/vdb"},{"name":"db-2","ip":"10.0.1.12","disk":"/dev/vdb"},{"name":"db-3","ip":"10.0.1.13","disk":"/dev/vdb"}],"instances":[{"id":"pg","component":"postgresql","placement":{"primary":["db-1"],"replica":["db-2","db-3"]},"params":{"client_cidr":"10.0.1.0/24","tls":false}}]}`
	w := storeRequest(s, "POST", "/api/resolve", strings.NewReader(ha), cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var res struct {
		Plan struct {
			OK        bool `json:"ok"`
			Instances []struct {
				ID         string `json:"id"`
				Auto       bool   `json:"auto"`
				AutoReason string `json:"auto_reason"`
			} `json:"instances"`
			Phases []struct{ Phase string } `json:"phases"`
		} `json:"plan"`
		Packages struct {
			Platform string                  `json:"platform"`
			Total    int                     `json:"total"`
			Missing  []mwpack.PackageRequest `json:"missing"`
		} `json:"packages"`
	}
	json.Unmarshal(w.Body.Bytes(), &res)
	auto := ""
	for _, i := range res.Plan.Instances {
		if i.Auto {
			auto = i.ID + ":" + i.AutoReason
		}
	}
	if !res.Plan.OK || !strings.HasPrefix(auto, "pg-dcs:") || len(res.Plan.Phases) == 0 || res.Packages.Platform != mwpack.DefaultPlatform || res.Packages.Total < 5 || len(res.Packages.Missing) != 0 {
		t.Fatal("resolve must show the etcd it added, the phases, and the material state", w.Body.String())
	}
	// A single node needs no coordination service.
	w = storeRequest(s, "POST", "/api/resolve", strings.NewReader(singleNodeSpec), cookie, csrf)
	if bytes.Contains(w.Body.Bytes(), []byte(`"auto":true`)) {
		t.Fatal("single node must not get automatic dependencies", w.Body.String())
	}
	// Problems come back together, not one at a time.
	broken := strings.Replace(singleNodeSpec, `"placement":{"primary":["db-1"]}`, `"placement":{"primary":["nobody"]}`, 1)
	w = storeRequest(s, "POST", "/api/resolve", strings.NewReader(broken), cookie, csrf)
	if !bytes.Contains(w.Body.Bytes(), []byte(`"ok":false`)) || !bytes.Contains(w.Body.Bytes(), []byte("nobody")) {
		t.Fatal(w.Body.String())
	}
}

func TestStoreSpecImportExportRoundTrip(t *testing.T) {
	s, _ := testStore(t)
	cookie, csrf := storeLogin(t, s, "alice")
	w := storeRequest(s, "POST", "/api/spec/export", strings.NewReader(singleNodeSpec), cookie, csrf)
	var out struct {
		YAML string `json:"yaml"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	if w.Code != 200 || !strings.Contains(out.YAML, "component: postgresql") {
		t.Fatal(w.Code, w.Body.String())
	}
	body, _ := json.Marshal(map[string]string{"yaml": out.YAML})
	w = storeRequest(s, "POST", "/api/spec/import", bytes.NewReader(body), cookie, csrf)
	if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"pg-one"`)) {
		t.Fatal(w.Code, w.Body.String())
	}
	body, _ = json.Marshal(map[string]string{"yaml": "id: x\nbogus_field: 1\n"})
	if w = storeRequest(s, "POST", "/api/spec/import", bytes.NewReader(body), cookie, csrf); w.Code != 400 {
		t.Fatal("unknown fields must be rejected so typos do not vanish", w.Code)
	}
}

func TestStoreComponentSchema(t *testing.T) {
	s, _ := testStore(t)
	cookie, _ := storeLogin(t, s, "alice")
	w := storeRequest(s, "GET", "/api/components/postgresql", nil, cookie, "")
	var sc struct {
		Version string                       `json:"version"`
		Roles   []struct{ Name string }      `json:"roles"`
		Params  []struct{ Key, Type string } `json:"params"`
	}
	json.Unmarshal(w.Body.Bytes(), &sc)
	if w.Code != 200 || sc.Version != "17" || len(sc.Roles) != 2 || len(sc.Params) < 40 {
		t.Fatal(w.Code, w.Body.String()[:200])
	}
	if w = storeRequest(s, "GET", "/api/components/nope", nil, cookie, ""); w.Code != 404 {
		t.Fatal("unknown component")
	}
}

func TestStoreAdminCreationAndHostValidation(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	w := storeRequest(s, "POST", "/api/users", strings.NewReader(`{"Username":"charlie","Role":"operator","Password":"test-password-123456"}`), admin, csrf)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	storeLogin(t, s, "charlie")
	s.jobs["0123456789abcdef0123456789abcdef"] = storeJob{ID: "0123456789abcdef0123456789abcdef", Owner: "charlie", ClusterID: "private-cluster", State: "running", Created: "2026-10-23T10:00:00Z"}
	w = storeRequest(s, "GET", "/api/users", nil, admin, "")
	var users []struct {
		Username   string `json:"username"`
		Deliveries int    `json:"deliveries"`
		Active     int    `json:"active"`
		Last       string `json:"last_delivery"`
	}
	json.Unmarshal(w.Body.Bytes(), &users)
	found := false
	for _, u := range users {
		if u.Username == "charlie" {
			found = u.Deliveries == 1 && u.Active == 1 && u.Last == "2026-10-23T10:00:00Z"
		}
	}
	if !found || bytes.Contains(w.Body.Bytes(), []byte("private-cluster")) {
		t.Fatal("account usage wrong or leaked delivery content", w.Body.String())
	}
	r := httptest.NewRequest("GET", "http://evil.invalid/api/catalog", nil)
	r.AddCookie(admin)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("host spoof accepted")
	}
}
func TestStorePostgreSQLPersistence(t *testing.T) {
	dsn := os.Getenv("TEST_STORE_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_STORE_DATABASE_URL for real PostgreSQL integration")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	schema := "store_test_" + randomStoreToken(8)
	if _, err = db.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	defer db.Exec("DROP SCHEMA " + schema + " CASCADE")
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	repo, err := openStoreRepository(u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer repo.db.Close()
	user, err := newStoreUser("alice", "admin", "integration-password-123")
	if err != nil {
		t.Fatal(err)
	}
	if err = repo.addUser(user); err != nil {
		t.Fatal(err)
	}
	users, err := repo.users()
	if err != nil || users["alice"].PasswordHash != user.PasswordHash {
		t.Fatal("database account persistence", err)
	}
	job := storeJob{ID: randomStoreToken(16), Owner: "alice", State: "running", Logs: []string{"stage"}}
	if err = repo.saveJob(job); err != nil {
		t.Fatal(err)
	}
	job.State = "succeeded"
	if err = repo.saveJob(job); err != nil {
		t.Fatal(err)
	}
	jobs, err := repo.jobs()
	if err != nil || jobs[job.ID].State != "succeeded" {
		t.Fatal("database job persistence", err)
	}
	if err = repo.audit(map[string]string{"action": "integration-test"}); err != nil {
		t.Fatal(err)
	}
	if err = repo.catalog("postgresql", map[string]string{"id": "postgresql"}); err != nil {
		t.Fatal(err)
	}
	if err = repo.deleteJob(job.ID); err != nil {
		t.Fatal(err)
	}
	jobs, err = repo.jobs()
	if err != nil || len(jobs) != 0 {
		t.Fatal("database delete", err)
	}
}

func packTarGz(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		tw.WriteHeader(&tar.Header{Name: n, Mode: 0o644, Size: int64(len(files[n])), Typeflag: tar.TypeReg})
		tw.Write([]byte(files[n]))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func importPack(t *testing.T, s *storeServer, cookie *http.Cookie, csrf, filename string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	f, _ := form.CreateFormFile("pack", filename)
	f.Write(data)
	form.Close()
	r := httptest.NewRequest("POST", s.cfg.PublicURL+"/api/components/import", &body)
	r.Header.Set("Origin", s.cfg.PublicURL)
	r.Header.Set("X-CSRF-Token", csrf)
	r.Header.Set("Content-Type", form.FormDataContentType())
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

const memcachedManifest = `schema: mwpack/v1
component: memcached
short: mc
title: Memcached
category: 缓存
summary: 通过组件包录入的示例应用
detail:
  presets:
    - id: single
      name: 基础系列
      roles: [{role: node, count: 1}]
      contract:
        series: basic
        when: count(roles.node) == 1
        failover: none
        mechanism: Memcached 单节点
        read_access: 单节点读写
        sharding: false
        limitations: [内存数据不持久化]
        acceptance: [memcached/port]
        operations: [deploy]
provides: [cache-endpoint]
roles:
  - {name: node, title: 节点, min: 1, max: 8, default: 2}
params:
  - {key: port, label: 端口, type: port, default: 11211}
  - {key: memory_mb, label: 内存（MB）, type: int, default: 64, min: 16, max: 65536}
ports:
  - {name: service, value: =params.port}
versions:
  - id: "1.6"
    status: published
    verified_platforms: [ubuntu-24.04-amd64]
    platforms: [ubuntu-24.04-amd64]
    packages: [{name: memcached, version: "1.6.24-1ubuntu3"}]
lifecycle:
  install:
    - id: packages
      title: 安装 memcached
      tasks:
        - name: 安装
          ansible.builtin.apt:
            name: "{{ mw.packages | map(attribute='spec') | list }}"
            state: present
            update_cache: false
  configure:
    - id: config
      title: 写入配置
      tasks:
        - name: 渲染
          ansible.builtin.template:
            src: memcached.conf.j2
            dest: /etc/memcached.conf
            mode: '0644'
  start:
    - id: start
      title: 启动
      tasks:
        - name: 启动
          ansible.builtin.systemd: {name: memcached, enabled: true, state: restarted}
tests:
  - id: port
    title: 端口可达
    expect: 配置端口接受连接
    effect: read-only
    tasks:
      - name: 连接
        ansible.builtin.wait_for: {port: "{{ mw.params.port }}", timeout: 5}
`

func TestComponentImportExportAndSafety(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, acsrf2 := storeLogin(t, s, "alice")
	good := packTarGz(t, map[string]string{
		"memcached/component.yaml":              memcachedManifest,
		"memcached/templates/memcached.conf.j2": "-p {{ mw.params.port }}\n-m {{ mw.params.memory_mb }}\n",
	})
	if w := importPack(t, s, alice, acsrf2, "memcached.tar.gz", good); w.Code != 403 {
		t.Fatal("an operator must not import components", w.Code)
	}
	w := importPack(t, s, admin, acsrf, "memcached.tar.gz", good)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	// A new application's packages come from the library like any other: until they are there it cannot be generated.
	spec0 := `{"id":"mc-one","hosts":[{"name":"mc-1","ip":"10.0.9.11"}],"instances":[{"id":"mc","component":"memcached","placement":{"node":["mc-1"]}}]}`
	if w = storeCreate(t, s, alice, acsrf2, spec0, nil); w.Code != 400 || !bytes.Contains(w.Body.Bytes(), []byte("memcached=1.6.24-1ubuntu3")) {
		t.Fatal("generation must name the packages the library lacks", w.Code, w.Body.String())
	}
	fakeLibrary(t, s.plat.lib.Dir, mwpack.DefaultPlatform, []mwpack.PackageRequest{{Name: "memcached", Version: "1.6.24-1ubuntu3"}})
	// Now visible and usable without a restart.
	w = storeRequest(s, "GET", "/api/components", nil, alice, "")
	if !bytes.Contains(w.Body.Bytes(), []byte(`"id":"memcached"`)) || !bytes.Contains(w.Body.Bytes(), []byte(`"source":"custom"`)) {
		t.Fatal("imported component not listed", strings.Contains(w.Body.String(), "memcached"), strings.Contains(w.Body.String(), `"source":"custom"`), strings.Count(w.Body.String(), `"source"`))
	}
	spec := `{"id":"mc-one","hosts":[{"name":"mc-1","ip":"10.0.9.11"},{"name":"mc-2","ip":"10.0.9.12"}],"instances":[{"id":"mc","component":"memcached","placement":{"node":["mc-1","mc-2"]},"params":{"memory_mb":128}}]}`
	w = storeRequest(s, "POST", "/api/resolve", strings.NewReader(spec), alice, acsrf2)
	if !bytes.Contains(w.Body.Bytes(), []byte(`"ok":true`)) {
		t.Fatal("a new application must resolve straight away", w.Body.String())
	}
	w = storeCreate(t, s, alice, acsrf2, spec, nil)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	s.wg.Wait()
	var job storeJob
	json.Unmarshal(w.Body.Bytes(), &job)
	if j := s.jobs[job.ID]; j.State != "succeeded" {
		t.Fatal("generation for an implementer-defined component failed:", j.Error)
	}
	// Export and re-import is lossless.
	w = storeRequest(s, "GET", "/api/components/memcached/pack", nil, alice, "")
	if w.Code != 200 || w.Body.Len() < 200 {
		t.Fatal("export failed", w.Code)
	}
	if w = importPack(t, s, admin, acsrf, "memcached.tar.gz", w.Body.Bytes()); w.Code != 200 {
		t.Fatal("re-import of an exported pack failed", w.Code, w.Body.String())
	}
	w = storeRequest(s, "GET", "/api/components/memcached/manifest", nil, alice, "")
	if !bytes.Contains(w.Body.Bytes(), []byte("通过组件包录入")) {
		t.Fatal("manifest not readable")
	}

	// Unsafe or broken packs are refused with a reason, and nothing changes.
	cases := map[string][]byte{
		"path traversal":   packTarGz(t, map[string]string{"x/component.yaml": memcachedManifest, "x/../../evil": "x"}),
		"unknown dir":      packTarGz(t, map[string]string{"memcached/component.yaml": memcachedManifest, "memcached/scripts/run.sh": "x"}),
		"no manifest":      packTarGz(t, map[string]string{"memcached/readme.txt": "x"}),
		"shell step":       packTarGz(t, map[string]string{"memcached/component.yaml": strings.Replace(memcachedManifest, "ansible.builtin.wait_for: {port: \"{{ mw.params.port }}\", timeout: 5}", "ansible.builtin.shell: id", 1), "memcached/templates/memcached.conf.j2": "x"}),
		"missing template": packTarGz(t, map[string]string{"memcached/component.yaml": memcachedManifest}),
	}
	for name, data := range cases {
		w := importPack(t, s, admin, acsrf, "bad.tar.gz", data)
		if w.Code == 200 {
			t.Errorf("%s: accepted", name)
		}
	}
	if w = importPack(t, s, admin, acsrf, "bad.rar", good); w.Code != 400 {
		t.Error("unsupported archive type accepted")
	}
	// The built-in set cannot be deleted; custom ones can, and the catalog follows.
	if w = storeRequest(s, "DELETE", "/api/components/postgresql", nil, admin, acsrf); w.Code != 409 {
		t.Error("a built-in component was deletable", w.Code)
	}
	if w = storeRequest(s, "DELETE", "/api/components/memcached", nil, alice, acsrf2); w.Code != 403 {
		t.Error("operator deleted a component", w.Code)
	}
	if w = storeRequest(s, "DELETE", "/api/components/memcached", nil, admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = storeRequest(s, "GET", "/api/components/memcached", nil, alice, ""); w.Code != 404 {
		t.Error("deleted component still known")
	}
}

func TestLibraryAPI(t *testing.T) {
	s, c := testStore(t)
	s.plat.fetcher.Docker = "/nonexistent/docker"
	admin, acsrf := storeLogin(t, s, "admin")
	alice, acsrf2 := storeLogin(t, s, "alice")

	w := storeRequest(s, "GET", "/api/library", nil, alice, "")
	var ov struct {
		Platforms []struct {
			ID         string `json:"id"`
			Deployable bool   `json:"deployable"`
			Stats      struct{ Closures int }
			Direct     bool `json:"direct"`
		} `json:"platforms"`
	}
	json.Unmarshal(w.Body.Bytes(), &ov)
	if w.Code != 200 || len(ov.Platforms) != 2 {
		t.Fatalf("overview: %d %s", w.Code, w.Body.String())
	}
	for _, p := range ov.Platforms {
		if !p.Direct {
			t.Errorf("%s must find packages through its source index, not a container", p.ID)
		}
	}
	for _, p := range ov.Platforms {
		if p.ID == mwpack.DefaultPlatform && (!p.Deployable || p.Stats.Closures < 10) {
			t.Fatalf("ubuntu should be deployable with a stocked library: %+v", p)
		}
		if p.ID == "el9-amd64" && p.Deployable {
			t.Fatal("a system with no Ansible runtime must not be offered for deliveries")
		}
	}

	// Without a source index fetching is refused, saying how to get one, and only administrators may fetch.
	body := `{"platform":"ubuntu-24.04-amd64","packages":[{"name":"htop","version":"3.3.0-4build1"}]}`
	if w = storeRequest(s, "POST", "/api/library/fetch", strings.NewReader(body), alice, acsrf2); w.Code != 403 {
		t.Fatal("operator fetched packages", w.Code)
	}
	for _, platform := range []string{"ubuntu-24.04-amd64", "el9-amd64"} {
		b := strings.Replace(body, "ubuntu-24.04-amd64", platform, 1)
		if w = storeRequest(s, "POST", "/api/library/fetch", strings.NewReader(b), admin, acsrf); w.Code != 409 || !bytes.Contains(w.Body.Bytes(), []byte("索引")) || bytes.Contains(w.Body.Bytes(), []byte("Docker")) {
			t.Fatal(platform+": fetch without an index must point to updating or importing it", w.Code, w.Body.String())
		}
	}
	bad := `{"platform":"ubuntu-24.04-amd64","packages":[{"name":"x; rm -rf /","version":"1"}]}`
	if w = storeRequest(s, "POST", "/api/library/fetch", strings.NewReader(bad), admin, acsrf); w.Code != 400 {
		t.Fatal("a shell-looking package name was accepted", w.Code)
	}

	// Closures list says what each package is used by.
	w = storeRequest(s, "GET", "/api/library/closures?platform=ubuntu-24.04-amd64", nil, alice, "")
	if !bytes.Contains(w.Body.Bytes(), []byte(`"used_by":["etcd 3.5"]`)) {
		t.Fatalf("closures must say which components use a package: %s", w.Body.String()[:400])
	}

	// Offline replenishment: export from one platform, import into a fresh one.
	req := mwpack.PackageRequest{Name: "haproxy", Version: "2.8.30-0ubuntu0.24.04.1"}
	w = storeRequest(s, "GET", "/api/library/export?platform=ubuntu-24.04-amd64&pkg="+url.QueryEscape(req.Key()), nil, admin, "")
	if w.Code != 200 || w.Body.Len() < 100 {
		t.Fatal("export failed", w.Code, w.Body.String())
	}
	if w2 := storeRequest(s, "GET", "/api/library/export?platform=ubuntu-24.04-amd64&pkg="+url.QueryEscape(req.Key()), nil, alice, ""); w2.Code != 403 {
		t.Fatal("operator exported the library")
	}
	pack := append([]byte(nil), w.Body.Bytes()...)
	if err := s.plat.lib.Delete(mwpack.DefaultPlatform, req); err != nil {
		t.Fatal(err)
	}
	if s.plat.lib.Has(mwpack.DefaultPlatform, req) {
		t.Fatal("delete did not remove it")
	}
	var form bytes.Buffer
	mp := multipart.NewWriter(&form)
	fw, _ := mp.CreateFormFile("pack", "library.tar.gz")
	fw.Write(pack)
	mp.Close()
	post := func(user *http.Cookie, csrf string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", s.cfg.PublicURL+"/api/library/import", bytes.NewReader(form.Bytes()))
		r.Header.Set("Origin", s.cfg.PublicURL)
		r.Header.Set("X-CSRF-Token", csrf)
		r.Header.Set("Content-Type", mp.FormDataContentType())
		r.AddCookie(user)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, r)
		return rec
	}
	if post(alice, acsrf2).Code != 403 {
		t.Fatal("operator imported into the library")
	}
	if rec := post(admin, acsrf); rec.Code != 200 || !s.plat.lib.Has(mwpack.DefaultPlatform, req) {
		t.Fatal("import did not restore the package", rec.Code, rec.Body.String())
	}

	// Package sources: an administrator points a source at an internal mirror; a bad list is refused and changes nothing.
	custom := `[{"id":"ubuntu-noble","platforms":["ubuntu-24.04-amd64"],"kind":"apt","url":"https://mirror.corp/ubuntu","suites":["noble"],"components":["main"],"key_file":"ubuntu-archive-keyring.gpg"}]`
	if w = storeRequest(s, "PUT", "/api/library/sources", strings.NewReader(`{"yaml":`+strconv.Quote(custom)+`}`), admin, acsrf); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte("mirror.corp")) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = storeRequest(s, "PUT", "/api/library/sources", strings.NewReader(`{"yaml":"- {id: x, kind: apt}"}`), admin, acsrf); w.Code != 422 {
		t.Fatal("an invalid source list was saved", w.Code)
	}
	if s.plat.sources.Load().ForPlatform("ubuntu-24.04-amd64")[0].URL != "https://mirror.corp/ubuntu" {
		t.Fatal("the saved mirror is not in effect")
	}
	s2, err := newStoreServer(c)
	if err != nil {
		t.Fatal(err)
	}
	if s2.plat.sources.Load().ForPlatform("ubuntu-24.04-amd64")[0].URL != "https://mirror.corp/ubuntu" {
		t.Fatal("sources must survive a restart")
	}
}

func TestBrokenCustomComponentDoesNotStopThePlatform(t *testing.T) {
	_, c := testStore(t)
	// An old-format component left behind in the data directory (here: the retired apt-repo artifact style).
	dir := filepath.Join(c.DataDir, "components", "legacy-app")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	old := "schema: mwpack/v1\ncomponent: legacy-app\ntitle: 旧组件\ncategory: 其他\nroles: [{name: node, min: 1, max: 1}]\nversions:\n  - id: \"1\"\n    status: draft\n    platforms: [ubuntu-24.04-amd64]\n    artifacts: [{name: r, kind: apt-repo, root: r, file: r.tar.gz}]\n"
	if err := os.WriteFile(filepath.Join(dir, "component.yaml"), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	s2, err := newStoreServer(c)
	if err != nil {
		t.Fatalf("a bad custom component must not stop the platform: %v", err)
	}
	admin, csrf := storeLogin(t, s2, "admin")
	w := storeRequest(s2, "GET", "/api/components", nil, admin, "")
	var list []struct {
		ID      string `json:"id"`
		Broken  bool   `json:"broken"`
		Problem string `json:"problem"`
	}
	json.Unmarshal(w.Body.Bytes(), &list)
	found, others := false, 0
	for _, e := range list {
		if e.ID == "legacy-app" {
			found = e.Broken && strings.Contains(e.Problem, "root")
		} else if !e.Broken {
			others++
		}
	}
	if !found || others < 5 {
		t.Fatalf("the broken component must be listed with its reason, and the rest keep working: %s", w.Body.String()[:300])
	}
	if w = storeRequest(s2, "GET", "/api/components/legacy-app/manifest", nil, admin, ""); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte("apt-repo")) {
		t.Fatal("a broken component's manifest must stay readable so it can be fixed", w.Code)
	}
	if w = storeRequest(s2, "DELETE", "/api/components/legacy-app", nil, admin, csrf); w.Code != 200 {
		t.Fatal("it must be deletable", w.Code, w.Body.String())
	}
	if len(s2.plat.brokenList()) != 0 {
		t.Fatal("deleting it clears the problem")
	}
}

// writeIndexFixture stores a cached source index for the default platform in the server's library directory, the way
// "更新索引" leaves it, so searching and previewing can be tested without a network.
func writeIndexFixture(t *testing.T, libDir, packages string) {
	t.Helper()
	dir := filepath.Join(libDir, "index", mwpack.DefaultPlatform)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write([]byte(packages))
	zw.Close()
	os.WriteFile(filepath.Join(dir, "s__suite__main.Packages.gz"), buf.Bytes(), 0o600)
	state, _ := json.Marshal(map[string]any{"platform": mwpack.DefaultPlatform, "updated": "2026-10-24T00:00:00Z", "files": []map[string]any{{"source": "s", "suite": "suite", "component": "main", "file": "s__suite__main.Packages.gz", "packages": 3}}})
	os.WriteFile(filepath.Join(dir, "state.json"), state, 0o600)
}

func TestLibrarySearchVersionsAndPlanComeFromTheCachedIndex(t *testing.T) {
	s, c := testStore(t)
	alice, aliceCSRF := storeLogin(t, s, "alice")
	pkg := func(name, ver, deps string) string {
		return "Package: " + name + "\nVersion: " + ver + "\nArchitecture: amd64\nDepends: " + deps + "\nFilename: pool/" + name + "_" + ver + ".deb\nSize: 2048\nSHA256: " + strings.Repeat("c", 64) + "\nDescription: the " + name + " server\n\n"
	}
	base := "/api/library"
	// before the first update there is nothing to search, and the reply says what to do
	if w := storeRequest(s, "GET", base+"/search?platform="+mwpack.DefaultPlatform+"&q=redis", nil, alice, ""); w.Code != 409 || !strings.Contains(w.Body.String(), "更新索引") {
		t.Fatalf("search without an index: %d %s", w.Code, w.Body.String())
	}
	writeIndexFixture(t, filepath.Join(c.DataDir, "library"), pkg("redis-server", "7.0.1", "redis-tools (= 7.0.1), libjemalloc2")+pkg("redis-server", "7.2.0", "redis-tools (= 7.2.0), libjemalloc2")+pkg("redis-tools", "7.0.1", "")+pkg("redis-tools", "7.2.0", "")+pkg("libjemalloc2", "5.3", ""))
	// a fresh server instance picks up the cached files from disk
	s, err := newStoreServer(c)
	if err != nil {
		t.Fatal(err)
	}
	alice, aliceCSRF = storeLogin(t, s, "alice")

	w := storeRequest(s, "GET", base+"/search?platform="+mwpack.DefaultPlatform+"&q=redis", nil, alice, "")
	var found struct {
		Hits []struct{ Name, Latest string }
	}
	if json.Unmarshal(w.Body.Bytes(), &found); w.Code != 200 || len(found.Hits) != 2 || found.Hits[0].Name != "redis-tools" && found.Hits[0].Name != "redis-server" {
		t.Fatalf("search: %d %s", w.Code, w.Body.String())
	}
	w = storeRequest(s, "GET", base+"/versions?platform="+mwpack.DefaultPlatform+"&package=redis-server", nil, alice, "")
	var vs struct {
		Versions []string
		From     string
	}
	json.Unmarshal(w.Body.Bytes(), &vs)
	if w.Code != 200 || len(vs.Versions) != 2 || vs.Versions[0] != "7.2.0" || vs.From != "index" {
		t.Fatalf("versions must come from the index, newest first: %d %s", w.Code, w.Body.String())
	}
	w = storeRequest(s, "GET", base+"/plan?platform="+mwpack.DefaultPlatform+"&package=redis-server&version=7.0.1", nil, alice, "")
	var plan struct {
		Packages      []struct{ Name, Version string }
		Bytes         int64
		DownloadBytes int64 `json:"download_bytes"`
		Unresolved    []string
	}
	json.Unmarshal(w.Body.Bytes(), &plan)
	if w.Code != 200 || len(plan.Packages) != 3 || plan.Bytes != 3*2048 || plan.DownloadBytes != 3*2048 || len(plan.Unresolved) != 0 {
		t.Fatalf("plan: %d %s", w.Code, w.Body.String())
	}
	// the exact pinned dependency follows the requested version, not the newest one
	for _, p := range plan.Packages {
		if p.Name == "redis-tools" && p.Version != "7.0.1" {
			t.Errorf("redis-tools must be pinned to 7.0.1, got %s", p.Version)
		}
	}
	if w = storeRequest(s, "GET", base+"/plan?platform="+mwpack.DefaultPlatform+"&package=redis-server&version=9.9", nil, alice, ""); w.Code != 404 {
		t.Errorf("an unknown version must be 404, got %d", w.Code)
	}
	// only an administrator refreshes the index (which is what reaches out to the network)
	if w = storeRequest(s, "POST", base+"/index/update", strings.NewReader(`{"platform":"`+mwpack.DefaultPlatform+`"}`), alice, aliceCSRF); w.Code != 403 {
		t.Errorf("operator updating the index: %d", w.Code)
	}
	// exporting and importing an index is for administrators too, and an index that has no signed releases is not exported
	if w = storeRequest(s, "GET", base+"/index/export?platform="+mwpack.DefaultPlatform, nil, alice, ""); w.Code != 403 {
		t.Errorf("operator exporting the index: %d", w.Code)
	}
	if w = storeRequest(s, "POST", base+"/index/import", strings.NewReader(""), alice, aliceCSRF); w.Code != 403 {
		t.Errorf("operator importing an index: %d", w.Code)
	}
	adminCookie, _ := storeLogin(t, s, "admin")
	if w = storeRequest(s, "GET", base+"/index/export?platform="+mwpack.DefaultPlatform, nil, adminCookie, ""); w.Code != 409 || !strings.Contains(w.Body.String(), "更新索引") {
		t.Errorf("an index without signed releases must ask for an update first: %d %s", w.Code, w.Body.String())
	}
	// the overview reports the cached index so the page can show when it was updated
	w = storeRequest(s, "GET", base, nil, alice, "")
	if !strings.Contains(w.Body.String(), `"direct":true`) || !strings.Contains(w.Body.String(), "2026-10-24T00:00:00Z") {
		t.Errorf("overview lacks the index state: %s", w.Body.String())
	}
}

func TestExecutionRecord(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	bob, bobCSRF := storeLogin(t, s, "bob")
	w := storeCreate(t, s, alice, csrf, singleNodeSpec, nil)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	s.wg.Wait()
	var job storeJob
	json.Unmarshal(w.Body.Bytes(), &job)
	put := func(user *http.Cookie, token, body string) *httptest.ResponseRecorder {
		return storeRequest(s, "PUT", "/api/jobs/"+job.ID+"/progress", strings.NewReader(body), user, token)
	}
	if w = put(alice, csrf, `{"key":"env/1","title":"核对上传文件","state":"done","total":17}`); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = put(alice, csrf, `{"key":"deploy/2","title":"安装","state":"failed","note":"端口被占用","log":"E: Unable to locate package\n"}`); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = storeRequest(s, "GET", "/api/jobs/"+job.ID+"/progress", nil, alice, "")
	if !bytes.Contains(w.Body.Bytes(), []byte("Unable to locate package")) || !bytes.Contains(w.Body.Bytes(), []byte(`"by":"alice"`)) {
		t.Fatal("the record is missing what was written", w.Body.String())
	}
	// the list carries a summary
	w = storeRequest(s, "GET", "/api/jobs", nil, alice, "")
	if !bytes.Contains(w.Body.Bytes(), []byte(`"run_done":1`)) || !bytes.Contains(w.Body.Bytes(), []byte(`"run_failed":1`)) || !bytes.Contains(w.Body.Bytes(), []byte(`"run_total":17`)) {
		t.Fatal("the delivery list does not summarise the record", w.Body.String())
	}
	// only the owner sees or changes it; bad input is refused
	if w = put(bob, bobCSRF, `{"key":"x","state":"done"}`); w.Code != 404 {
		t.Fatal("another user wrote to someone's record", w.Code)
	}
	if w = put(alice, "", `{"key":"x","state":"done"}`); w.Code == 200 {
		t.Fatal("a write without the CSRF token was accepted")
	}
	if w = put(alice, csrf, `{"key":"x","state":"exploded"}`); w.Code != 400 {
		t.Fatal("an unknown state was accepted", w.Code)
	}
	if w = put(alice, csrf, `{"key":"x","state":"done","log":"`+strings.Repeat("a", 70000)+`"}`); w.Code != 400 {
		t.Fatal("an oversized log was accepted", w.Code)
	}
	// clearing a step takes its result back but keeps what was written; "all" empties the record
	if w = put(alice, csrf, `{"key":"deploy/2","state":""}`); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte("Unable to locate")) || !bytes.Contains(w.Body.Bytes(), []byte(`"deploy/2":{"state":""`)) {
		t.Fatal("a step's result was not taken back, or its output was lost", w.Body.String())
	}
	if w = storeRequest(s, "DELETE", "/api/jobs/"+job.ID+"/progress", nil, alice, csrf); w.Code != 200 || bytes.Contains(w.Body.Bytes(), []byte(`"env/1":{`)) || !bytes.Contains(w.Body.Bytes(), []byte("Unable to locate")) {
		t.Fatal("clearing the results lost the output, or kept a step without any", w.Body.String())
	}
	if w = storeRequest(s, "DELETE", "/api/jobs/"+job.ID+"/progress?all=1", nil, alice, csrf); w.Code != 200 || bytes.Contains(w.Body.Bytes(), []byte("Unable to locate")) {
		t.Fatal("the record was not emptied", w.Body.String())
	}
}

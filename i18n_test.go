package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func containsCJKRune(s string) bool {
	for _, r := range s {
		if r >= 0x4E00 && r <= 0x9FFF {
			return true
		}
	}
	return false
}

func TestReqLang(t *testing.T) {
	if got := reqLang(nil); got != langZhCN {
		t.Fatalf("nil request got %q want %q", got, langZhCN)
	}
	cases := []struct {
		name  string
		url   string
		xLang string
		acpt  string
		want  string
	}{
		{"default", "http://example/", "", "", langZhCN},
		{"query-en", "http://example/?lang=en-US", "zh-CN", "zh-CN", langEnUS},
		{"header-en", "http://example/", "en", "zh-CN", langEnUS},
		{"accept-en", "http://example/", "", "en-GB,en;q=0.9,zh-CN;q=0.8", langEnUS},
		{"accept-zh", "http://example/", "", "zh-CN,en-US;q=0.9", langZhCN},
		{"unknown-fallback", "http://example/?lang=fr", "", "ja-JP", langZhCN},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", tc.url, nil)
			if tc.xLang != "" {
				r.Header.Set("X-Lang", tc.xLang)
			}
			if tc.acpt != "" {
				r.Header.Set("Accept-Language", tc.acpt)
			}
			if got := reqLang(r); got != tc.want {
				t.Fatalf("reqLang got %q want %q", got, tc.want)
			}
		})
	}
}

func TestLocalizeGoMessageCoverage(t *testing.T) {
	samples := []string{
		"演练会话不存在",
		"保存失败，请稍后重试",
		"修复漏洞: pip 25.3->26.2.0",
		"没有「管理账户、角色和团队」权限",
		"已有同名组件：demo-app",
		"还有 3 处错误，不能发布",
		"模型未能生成有效的只读采集脚本，请重试",
		"步骤「init」要运行 missing.yml，但组件里没有这个文件：到「文件」页签新建它，或改这一步的 run",
		"任务「check cluster」有改动，并且对这一步可能执行",
		"变量 pg_port（在 roles/pg/tasks/main.yml 中用到）；data_dir（在 vars.yml 中读取机器字段） 有改动",
		"软件库没有 patroni=3.3.0（ubuntu-24.04-amd64）：请先在“软件库”页获取或导入",
		"目标接入或授权已改变，请重新检查",
		"准备自检程序",
		"组件当前关联的软件包版本与这份交付不一致，不能直接同步；请重新生成交付，已运行集群的后续变更请走「变更演练」。",
		"PostgreSQL 17 的状态是「待验证」，尚未在空环境验证，不要用于生产",
		"Nginx（stream）",
	}
	for _, s := range samples {
		got := localizeGoMessage(langEnUS, s)
		if got == s || containsCJKRune(got) {
			t.Fatalf("message not fully translated to EN: %q -> %q", s, got)
		}
		if same := localizeGoMessage(langZhCN, s); same != s {
			t.Fatalf("zh-CN altered string: got %q want %q", same, s)
		}
	}
}

func storeRequestLang(s *storeServer, method, path, lang string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8090"+path, nil)
	r.Header.Set("Origin", s.cfg.PublicURL)
	if lang != "" {
		r.Header.Set("X-Lang", lang)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestHTTPEnglishEndpointsNoCJK(t *testing.T) {
	s, _ := testStore(t)
	cookie, _ := storeLogin(t, s, "admin")

	endpoints := []string{
		"/api/version?lang=en-US",
		"/api/catalog?lang=en-US",
		"/api/components/templates?lang=en-US",
		"/api/components/patroni/manifest?lang=en-US",
		"/api/components/postgresql/manifest?lang=en-US",
		"/api/components/redis/manifest?lang=en-US",
		"/api/components/etcd/manifest?lang=en-US",
		"/api/components/haproxy/manifest?lang=en-US",
		"/api/components/keepalived/manifest?lang=en-US",
		"/api/components/nginx/manifest?lang=en-US",
		"/api/components/external-lb/manifest?lang=en-US",
		"/api/settings/ai",
		"/api/settings/ai/web",
		"/api/settings/ai/skills",
		"/api/settings/templates",
		"/api/settings/channels",
		"/api/settings/sandbox",
		"/api/library",
		"/api/library/python",
	}
	for _, ep := range endpoints {
		w := storeRequestLang(s, "GET", ep, langEnUS, cookie)
		if w.Code != 200 {
			t.Errorf("GET %s status=%d body=%s", ep, w.Code, w.Body.String())
			continue
		}
		if ep == "/api/settings/ai/skills" {
			var payload struct {
				Skills []aiSkill `json:"skills"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
				t.Errorf("decode %s: %v", ep, err)
				continue
			}
			for _, sk := range payload.Skills {
				if containsCJKRune(sk.Title) || containsCJKRune(sk.Description) {
					t.Errorf("skill %s metadata has CJK: title=%q desc=%q", sk.Name, sk.Title, sk.Description)
				}
				for _, sc := range sk.Scripts {
					if containsCJKRune(sc.Description) {
						t.Errorf("skill %s script %s desc has CJK: %q", sk.Name, sc.Name, sc.Description)
					}
				}
			}
			continue
		}
		if containsCJKRune(w.Body.String()) {
			t.Errorf("GET %s returned CJK runes under en-US: %s", ep, w.Body.String())
		}
	}

	wDocx := storeRequestLang(s, "GET", "/api/settings/report/starter-template?lang=en-US", langEnUS, cookie)
	if wDocx.Code != 200 {
		t.Fatalf("starter-template status=%d body=%s", wDocx.Code, wDocx.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(wDocx.Body.Bytes()), int64(wDocx.Body.Len()))
	if err != nil {
		t.Fatalf("invalid docx zip: %v", err)
	}
	for _, f := range zr.File {
		if !strings.HasSuffix(f.Name, ".xml") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		if containsCJKRune(string(b)) {
			t.Errorf("EN starter-template %s contains CJK runes: %s", f.Name, string(b))
		}
	}
}

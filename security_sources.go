package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Configurable CVE Vulnerability Feed Sources (/api/security/sources*)
// Supports multiple concurrent sources:
//   - osv_api    : OSV.dev compatible query API (/v1/querybatch + /v1/vulns/{id}) or internal mirror
//   - json_feed  : HTTP/HTTPS JSON feed ([]secDBAdvisory, []osvFullDoc, single osvFullDoc, or {"advisories":[...]})
//   - bundle_url : HTTP/HTTPS URL to a SHA256SUMS-verified .tar.gz offline bundle exported by Middleware Hub
//   - cisa_kev   : CISA Known Exploited Vulnerabilities JSON catalog (enriches matched local CVEs)

type secFeedSource struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Kind          string   `json:"kind"` // osv_api | json_feed | bundle_url | cisa_kev
	URL           string   `json:"url"`
	Enabled       bool     `json:"enabled"`
	Builtin       bool     `json:"builtin,omitempty"`
	Ecosystems    []string `json:"ecosystems,omitempty"`
	AuthHeader    string   `json:"auth_header,omitempty"`
	AuthToken     string   `json:"auth_token,omitempty"`
	HasAuthToken  bool     `json:"has_auth_token,omitempty"`
	InsecureTLS   bool     `json:"insecure_tls,omitempty"`
	Note          string   `json:"note,omitempty"`
	LastSyncAt    string   `json:"last_sync_at,omitempty"`
	LastSyncCount int      `json:"last_sync_count,omitempty"`
	LastSyncError string   `json:"last_sync_error,omitempty"`
	LastSyncMS    int64    `json:"last_sync_ms,omitempty"`
	CreatedAt     string   `json:"created_at,omitempty"`
	UpdatedAt     string   `json:"updated_at,omitempty"`
}

func defaultSecFeedSources() []secFeedSource {
	return []secFeedSource{
		{
			ID:      "builtin-osv",
			Name:    "OSV.dev 官方漏洞 API",
			Kind:    "osv_api",
			URL:     "https://api.osv.dev",
			Enabled: true,
			Builtin: true,
			Note:    "聚合 Ubuntu / Rocky / Red Hat / Debian / PyPI 官方安全公告；内网有反代镜像时可直接编辑修改 URL。",
		},
		{
			ID:      "builtin-cisa-kev",
			Name:    "CISA KEV 在野活跃利用目录",
			Kind:    "cisa_kev",
			URL:     "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
			Enabled: false,
			Builtin: true,
			Note:    "美国 CISA 已知在野利用漏洞目录；启用后为本地命中的 CVE 标注在野利用高优警示。",
		},
	}
}

func (s *storeServer) loadSecSources() []secFeedSource {
	defaults := defaultSecFeedSources()
	if s.cfg.DataDir == "" {
		return defaults
	}
	b, err := os.ReadFile(filepath.Join(s.secDir(), "sources.json"))
	if err != nil {
		return defaults
	}
	var saved []secFeedSource
	if json.Unmarshal(b, &saved) != nil || len(saved) == 0 {
		return defaults
	}
	// Ensure all builtin defaults exist even after upgrades.
	byID := map[string]bool{}
	for i := range saved {
		byID[saved[i].ID] = true
		if saved[i].ID == "builtin-osv" || saved[i].ID == "builtin-cisa-kev" {
			saved[i].Builtin = true
		}
	}
	for _, d := range defaults {
		if !byID[d.ID] {
			saved = append(saved, d)
		}
	}
	return saved
}

func (s *storeServer) saveSecSources(list []secFeedSource) error {
	if s.cfg.DataDir == "" {
		return nil
	}
	clean := make([]secFeedSource, len(list))
	for i, x := range list {
		x.HasAuthToken = false
		clean[i] = x
	}
	return writeJSONFile(filepath.Join(s.secDir(), "sources.json"), clean)
}

func sanitizeSecSourcesForAPI(list []secFeedSource) []secFeedSource {
	out := make([]secFeedSource, len(list))
	for i, x := range list {
		x.HasAuthToken = strings.TrimSpace(x.AuthToken) != ""
		x.AuthToken = ""
		if x.Ecosystems == nil {
			x.Ecosystems = []string{}
		}
		out[i] = x
	}
	return out
}

func validateFeedSourceURL(raw string) (string, error) {
	u := strings.TrimSpace(raw)
	if u == "" {
		return "", errors.New("请填写漏洞源 URL")
	}
	parsed, err := url.Parse(u)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", errors.New("漏洞源地址必须是有效的 http:// 或 https:// URL")
	}
	return u, nil
}

func validFeedKind(k string) bool {
	return k == "osv_api" || k == "json_feed" || k == "bundle_url" || k == "cisa_kev"
}

func feedHTTPClient(src secFeedSource, timeout time.Duration) *http.Client {
	tr := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
	}
	if src.InsecureTLS {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // explicit admin opt-in for internal self-signed mirrors
	}
	return &http.Client{Timeout: timeout, Transport: tr}
}

func applyFeedAuth(req *http.Request, src secFeedSource) {
	req.Header.Set("User-Agent", "middleware-hub-security/1.0")
	tok := strings.TrimSpace(src.AuthToken)
	if tok == "" {
		return
	}
	hdr := strings.TrimSpace(src.AuthHeader)
	if hdr == "" {
		hdr = "Authorization"
	}
	req.Header.Set(hdr, tok)
}

func effectiveFeedURL(src secFeedSource) string {
	// Keep existing unit-test hook (`osvAPIBase = srv.URL`) working seamlessly.
	if src.ID == "builtin-osv" && osvAPIBase != "https://api.osv.dev" {
		return osvAPIBase
	}
	return src.URL
}

// ---- HTTP Handlers: /api/security/sources* ----

func (s *storeServer) handleSecuritySources(w http.ResponseWriter, r *http.Request, session storeSession, parts []string) {
	switch {
	case len(parts) == 0 && r.Method == "GET":
		secDBMu.Lock()
		srcs := s.loadSecSources()
		secDBMu.Unlock()
		s.writeJSON(w, 200, map[string]any{"sources": sanitizeSecSourcesForAPI(srcs)})

	case len(parts) == 0 && r.Method == "POST":
		var in struct {
			Name        string   `json:"name"`
			Kind        string   `json:"kind"`
			URL         string   `json:"url"`
			Enabled     *bool    `json:"enabled"`
			Ecosystems  []string `json:"ecosystems"`
			AuthHeader  string   `json:"auth_header"`
			AuthToken   string   `json:"auth_token"`
			InsecureTLS bool     `json:"insecure_tls"`
			Note        string   `json:"note"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in) != nil {
			s.fail(w, 400, "请求格式错误")
			return
		}
		name := truncRunes(strings.TrimSpace(in.Name), 80)
		kind := strings.ToLower(strings.TrimSpace(in.Kind))
		if name == "" {
			s.fail(w, 400, "请填写漏洞源名称")
			return
		}
		if !validFeedKind(kind) {
			s.fail(w, 400, "不支持的漏洞源类型（支持 osv_api / json_feed / bundle_url / cisa_kev）")
			return
		}
		cleanURL, err := validateFeedSourceURL(in.URL)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		enabled := true
		if in.Enabled != nil {
			enabled = *in.Enabled
		}
		var ecos []string
		for _, e := range in.Ecosystems {
			e = strings.TrimSpace(e)
			if e != "" {
				ecos = append(ecos, e)
			}
		}
		stamp := now()
		src := secFeedSource{
			ID:          "src-" + randomStoreToken(6),
			Name:        name,
			Kind:        kind,
			URL:         cleanURL,
			Enabled:     enabled,
			Ecosystems:  ecos,
			AuthHeader:  truncRunes(strings.TrimSpace(in.AuthHeader), 64),
			AuthToken:   strings.TrimSpace(in.AuthToken),
			InsecureTLS: in.InsecureTLS,
			Note:        truncRunes(strings.TrimSpace(in.Note), 240),
			CreatedAt:   stamp,
			UpdatedAt:   stamp,
		}
		secDBMu.Lock()
		list := append(s.loadSecSources(), src)
		saveErr := s.saveSecSources(list)
		secDBMu.Unlock()
		if saveErr != nil {
			s.fail(w, 500, "保存漏洞源配置失败")
			return
		}
		s.auditReq(r, "security-source-add", session.User, fmt.Sprintf("%s (%s) %s", src.Name, src.Kind, src.URL))
		s.writeJSON(w, 200, map[string]any{
			"source":  sanitizeSecSourcesForAPI([]secFeedSource{src})[0],
			"sources": sanitizeSecSourcesForAPI(list),
		})

	case len(parts) == 1 && r.Method == "PUT":
		id := parts[0]
		var in struct {
			Name        *string  `json:"name"`
			Kind        *string  `json:"kind"`
			URL         *string  `json:"url"`
			Enabled     *bool    `json:"enabled"`
			Ecosystems  []string `json:"ecosystems"`
			HasEcos     bool     `json:"has_ecosystems"`
			AuthHeader  *string  `json:"auth_header"`
			AuthToken   *string  `json:"auth_token"`
			ClearToken  bool     `json:"clear_token"`
			InsecureTLS *bool    `json:"insecure_tls"`
			Note        *string  `json:"note"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in) != nil {
			s.fail(w, 400, "请求格式错误")
			return
		}
		secDBMu.Lock()
		list := s.loadSecSources()
		idx := -1
		for i := range list {
			if list[i].ID == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			secDBMu.Unlock()
			s.fail(w, 404, "找不到该漏洞源")
			return
		}
		cur := list[idx]
		if in.Name != nil {
			n := truncRunes(strings.TrimSpace(*in.Name), 80)
			if n == "" {
				secDBMu.Unlock()
				s.fail(w, 400, "漏洞源名称不能为空")
				return
			}
			cur.Name = n
		}
		if in.Kind != nil && !cur.Builtin {
			k := strings.ToLower(strings.TrimSpace(*in.Kind))
			if !validFeedKind(k) {
				secDBMu.Unlock()
				s.fail(w, 400, "不支持的漏洞源类型")
				return
			}
			cur.Kind = k
		}
		if in.URL != nil {
			cleanURL, err := validateFeedSourceURL(*in.URL)
			if err != nil {
				secDBMu.Unlock()
				s.fail(w, 400, err.Error())
				return
			}
			cur.URL = cleanURL
		}
		if in.Enabled != nil {
			cur.Enabled = *in.Enabled
		}
		if in.HasEcos || in.Ecosystems != nil {
			var ecos []string
			for _, e := range in.Ecosystems {
				e = strings.TrimSpace(e)
				if e != "" {
					ecos = append(ecos, e)
				}
			}
			cur.Ecosystems = ecos
		}
		if in.AuthHeader != nil {
			cur.AuthHeader = truncRunes(strings.TrimSpace(*in.AuthHeader), 64)
		}
		if in.ClearToken {
			cur.AuthToken = ""
		} else if in.AuthToken != nil && strings.TrimSpace(*in.AuthToken) != "" {
			cur.AuthToken = strings.TrimSpace(*in.AuthToken)
		}
		if in.InsecureTLS != nil {
			cur.InsecureTLS = *in.InsecureTLS
		}
		if in.Note != nil {
			cur.Note = truncRunes(strings.TrimSpace(*in.Note), 240)
		}
		cur.UpdatedAt = now()
		list[idx] = cur
		saveErr := s.saveSecSources(list)
		secDBMu.Unlock()
		if saveErr != nil {
			s.fail(w, 500, "保存漏洞源配置失败")
			return
		}
		s.auditReq(r, "security-source-update", session.User, fmt.Sprintf("%s enabled=%v", cur.ID, cur.Enabled))
		s.writeJSON(w, 200, map[string]any{
			"source":  sanitizeSecSourcesForAPI([]secFeedSource{cur})[0],
			"sources": sanitizeSecSourcesForAPI(list),
		})

	case len(parts) == 1 && r.Method == "DELETE":
		id := parts[0]
		secDBMu.Lock()
		list := s.loadSecSources()
		idx := -1
		for i := range list {
			if list[i].ID == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			secDBMu.Unlock()
			s.fail(w, 404, "找不到该漏洞源")
			return
		}
		if list[idx].Builtin {
			secDBMu.Unlock()
			s.fail(w, 409, "内置默认漏洞源不可删除，可通过开关停用或编辑 URL 指向内网镜像")
			return
		}
		removed := list[idx]
		list = append(list[:idx], list[idx+1:]...)
		saveErr := s.saveSecSources(list)
		secDBMu.Unlock()
		if saveErr != nil {
			s.fail(w, 500, "保存漏洞源配置失败")
			return
		}
		s.auditReq(r, "security-source-delete", session.User, removed.ID+" "+removed.Name)
		s.writeJSON(w, 200, map[string]any{"sources": sanitizeSecSourcesForAPI(list)})

	case len(parts) == 2 && parts[1] == "test" && r.Method == "POST":
		id := parts[0]
		secDBMu.Lock()
		list := s.loadSecSources()
		var found *secFeedSource
		for i := range list {
			if list[i].ID == id {
				cp := list[i]
				found = &cp
				break
			}
		}
		secDBMu.Unlock()
		if found == nil {
			s.fail(w, 404, "找不到该漏洞源")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		res := s.testSecFeedSource(ctx, *found)
		s.writeJSON(w, 200, res)

	default:
		s.fail(w, 404, "接口不存在")
	}
}

type secSourceTestResult struct {
	OK          bool   `json:"ok"`
	StatusCode  int    `json:"status_code,omitempty"`
	LatencyMS   int64  `json:"latency_ms"`
	SampleCount int    `json:"sample_count,omitempty"`
	Message     string `json:"message"`
}

func (s *storeServer) testSecFeedSource(ctx context.Context, src secFeedSource) secSourceTestResult {
	start := time.Now()
	client := feedHTTPClient(src, 15*time.Second)
	targetURL := effectiveFeedURL(src)

	switch src.Kind {
	case "osv_api":
		payload := []byte(`{"queries":[{"package":{"name":"nginx","ecosystem":"Ubuntu:24.04:LTS"}}]}`)
		req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(targetURL, "/")+"/v1/querybatch", bytes.NewReader(payload))
		if err != nil {
			return secSourceTestResult{OK: false, LatencyMS: time.Since(start).Milliseconds(), Message: err.Error()}
		}
		req.Header.Set("Content-Type", "application/json")
		applyFeedAuth(req, src)
		resp, err := client.Do(req)
		if err != nil {
			return secSourceTestResult{OK: false, LatencyMS: time.Since(start).Milliseconds(), Message: "连接失败：" + err.Error()}
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		resp.Body.Close()
		ms := time.Since(start).Milliseconds()
		if resp.StatusCode != 200 {
			return secSourceTestResult{OK: false, StatusCode: resp.StatusCode, LatencyMS: ms, Message: fmt.Sprintf("返回 HTTP %d", resp.StatusCode)}
		}
		var out struct {
			Results []struct {
				Vulns []struct{ ID string `json:"id"` } `json:"vulns"`
			} `json:"results"`
		}
		if json.Unmarshal(b, &out) != nil {
			return secSourceTestResult{OK: false, StatusCode: 200, LatencyMS: ms, Message: "响应不是合法的 OSV querybatch JSON"}
		}
		cnt := 0
		for _, r := range out.Results {
			cnt += len(r.Vulns)
		}
		return secSourceTestResult{
			OK:          true,
			StatusCode:  200,
			LatencyMS:   ms,
			SampleCount: cnt,
			Message:     fmt.Sprintf("连通正常，OSV API 探针返回 %d 条示例公告索引（%d ms）", cnt, ms),
		}

	case "json_feed":
		req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
		if err != nil {
			return secSourceTestResult{OK: false, LatencyMS: time.Since(start).Milliseconds(), Message: err.Error()}
		}
		applyFeedAuth(req, src)
		resp, err := client.Do(req)
		if err != nil {
			return secSourceTestResult{OK: false, LatencyMS: time.Since(start).Milliseconds(), Message: "连接失败：" + err.Error()}
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		ms := time.Since(start).Milliseconds()
		if resp.StatusCode != 200 {
			return secSourceTestResult{OK: false, StatusCode: resp.StatusCode, LatencyMS: ms, Message: fmt.Sprintf("返回 HTTP %d", resp.StatusCode)}
		}
		advs := parseFlexibleAdvisoryJSON(b)
		if len(advs) == 0 {
			return secSourceTestResult{OK: false, StatusCode: 200, LatencyMS: ms, Message: "连通成功，但未识别到合法的 CVE/OSV 公告记录"}
		}
		return secSourceTestResult{
			OK:          true,
			StatusCode:  200,
			LatencyMS:   ms,
			SampleCount: len(advs),
			Message:     fmt.Sprintf("连通正常，成功解析 %d 条安全公告（%d ms）", len(advs), ms),
		}

	case "bundle_url":
		req, err := http.NewRequestWithContext(ctx, "HEAD", targetURL, nil)
		if err != nil {
			return secSourceTestResult{OK: false, LatencyMS: time.Since(start).Milliseconds(), Message: err.Error()}
		}
		applyFeedAuth(req, src)
		resp, err := client.Do(req)
		if err == nil && (resp.StatusCode == http.StatusMethodNotAllowed || resp.StatusCode == http.StatusNotImplemented) {
			resp.Body.Close()
			req, _ = http.NewRequestWithContext(ctx, "GET", targetURL, nil)
			applyFeedAuth(req, src)
			req.Header.Set("Range", "bytes=0-1023")
			resp, err = client.Do(req)
		}
		if err != nil {
			return secSourceTestResult{OK: false, LatencyMS: time.Since(start).Milliseconds(), Message: "连接失败：" + err.Error()}
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		ms := time.Since(start).Milliseconds()
		if resp.StatusCode >= 400 {
			return secSourceTestResult{OK: false, StatusCode: resp.StatusCode, LatencyMS: ms, Message: fmt.Sprintf("返回 HTTP %d", resp.StatusCode)}
		}
		return secSourceTestResult{
			OK:         true,
			StatusCode: resp.StatusCode,
			LatencyMS:  ms,
			Message:    fmt.Sprintf("离线包地址可访问（HTTP %d，%d ms）", resp.StatusCode, ms),
		}

	case "cisa_kev":
		req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
		if err != nil {
			return secSourceTestResult{OK: false, LatencyMS: time.Since(start).Milliseconds(), Message: err.Error()}
		}
		applyFeedAuth(req, src)
		resp, err := client.Do(req)
		if err != nil {
			return secSourceTestResult{OK: false, LatencyMS: time.Since(start).Milliseconds(), Message: "连接失败：" + err.Error()}
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		ms := time.Since(start).Milliseconds()
		if resp.StatusCode != 200 {
			return secSourceTestResult{OK: false, StatusCode: resp.StatusCode, LatencyMS: ms, Message: fmt.Sprintf("返回 HTTP %d", resp.StatusCode)}
		}
		var kev struct {
			Vulnerabilities []struct {
				CVEID string `json:"cveID"`
			} `json:"vulnerabilities"`
		}
		if json.Unmarshal(b, &kev) != nil || len(kev.Vulnerabilities) == 0 {
			return secSourceTestResult{OK: false, StatusCode: 200, LatencyMS: ms, Message: "未识别到 CISA KEV vulnerabilities 字段"}
		}
		return secSourceTestResult{
			OK:          true,
			StatusCode:  200,
			LatencyMS:   ms,
			SampleCount: len(kev.Vulnerabilities),
			Message:     fmt.Sprintf("连通正常，包含 %d 条 CISA KEV 在野利用目录（%d ms）", len(kev.Vulnerabilities), ms),
		}
	}
	return secSourceTestResult{OK: false, LatencyMS: time.Since(start).Milliseconds(), Message: "未知的漏洞源类型"}
}

// ---- Multi-Source Sync Engine ----

func (s *storeServer) syncSecurityDBFromSources(ctx context.Context, user, onlySourceID string) (secDBMeta, error) {
	secSyncMu.Lock()
	if secSyncSt.Running {
		secSyncMu.Unlock()
		return s.loadSecMeta(), errors.New("漏洞库正在同步中，请稍候")
	}
	secSyncSt = secSyncStatus{Running: true, Mode: "online", StartedAt: now(), Progress: "正在加载已启用的 CVE 漏洞源..."}
	secSyncMu.Unlock()

	defer func() {
		secSyncMu.Lock()
		secSyncSt.Running = false
		secSyncSt.FinishedAt = now()
		secSyncMu.Unlock()
	}()

	secDBMu.Lock()
	allSources := s.loadSecSources()
	secDBMu.Unlock()

	var activeIdxs []int
	for i, src := range allSources {
		if onlySourceID != "" {
			if src.ID == onlySourceID {
				activeIdxs = append(activeIdxs, i)
			}
		} else if src.Enabled {
			activeIdxs = append(activeIdxs, i)
		}
	}
	if len(activeIdxs) == 0 {
		if onlySourceID != "" {
			return s.loadSecMeta(), errors.New("找不到指定的漏洞源")
		}
		return s.loadSecMeta(), errors.New("当前没有已启用的在线 CVE 漏洞源，请先在「漏洞源与门禁」中启用至少一个数据源")
	}

	inv := s.extractSBOM()
	var incoming []secDBAdvisory
	kevMap := map[string]string{} // CVE -> short KEV note
	var syncErrs []string
	succeeded := 0

	for _, idx := range activeIdxs {
		src := allSources[idx]
		start := time.Now()
		secSyncMu.Lock()
		secSyncSt.Progress = fmt.Sprintf("正在同步漏洞源「%s」...", src.Name)
		secSyncMu.Unlock()

		var got []secDBAdvisory
		var kevHits map[string]string
		var err error

		switch src.Kind {
		case "osv_api":
			got, err = s.fetchFromOSVSource(ctx, src, inv)
		case "json_feed":
			got, err = fetchFromJSONFeedSource(ctx, src)
		case "bundle_url":
			got, err = fetchFromBundleURLSource(ctx, src)
		case "cisa_kev":
			kevHits, err = fetchFromCISAKEVSource(ctx, src)
		default:
			err = fmt.Errorf("不支持的源类型：%s", src.Kind)
		}

		allSources[idx].LastSyncAt = now()
		allSources[idx].LastSyncMS = time.Since(start).Milliseconds()
		if err != nil {
			allSources[idx].LastSyncError = truncRunes(err.Error(), 240)
			syncErrs = append(syncErrs, fmt.Sprintf("%s：%s", src.Name, err.Error()))
		} else {
			succeeded++
			allSources[idx].LastSyncError = ""
			if src.Kind == "cisa_kev" {
				allSources[idx].LastSyncCount = len(kevHits)
				for k, v := range kevHits {
					kevMap[k] = v
				}
			} else {
				allSources[idx].LastSyncCount = len(got)
				incoming = append(incoming, got...)
			}
		}
	}

	secDBMu.Lock()
	_ = s.saveSecSources(allSources)
	if succeeded == 0 {
		secDBMu.Unlock()
		errMsg := strings.Join(syncErrs, "；")
		secSyncMu.Lock()
		secSyncSt.Error = errMsg
		secSyncMu.Unlock()
		return s.loadSecMeta(), errors.New(errMsg)
	}
	merged := mergeSecAdvisories(s.loadSecAdvisories(), incoming)
	if len(kevMap) > 0 {
		for i := range merged {
			cve := strings.ToUpper(strings.TrimSpace(merged[i].CVE))
			if note, ok := kevMap[cve]; ok {
				if !strings.Contains(merged[i].Summary, "[CISA KEV]") {
					merged[i].Summary = strings.TrimSpace("[CISA KEV 在野活跃利用] " + merged[i].Summary)
				}
				if note != "" && !strings.Contains(merged[i].Details, note) {
					merged[i].Details = strings.TrimSpace(merged[i].Details + "\n" + note)
				}
				if merged[i].Severity == "" || merged[i].Severity == "UNKNOWN" {
					merged[i].Severity = "HIGH"
				}
			}
		}
	}
	if err := s.saveSecAdvisories(merged); err != nil {
		secDBMu.Unlock()
		return s.loadSecMeta(), err
	}
	meta := summarizeSecDBMeta(merged, "online", user, "")
	if len(syncErrs) > 0 {
		meta.LastError = truncRunes(strings.Join(syncErrs, "；"), 300)
	}
	_ = s.saveSecMeta(meta)
	secDBMu.Unlock()

	secSyncMu.Lock()
	secSyncSt.Progress = "同步完成，正在执行全平台离线匹配扫描..."
	secSyncSt.Error = strings.Join(syncErrs, "；")
	secSyncMu.Unlock()
	return meta, nil
}

func (s *storeServer) fetchFromOSVSource(ctx context.Context, src secFeedSource, inv secSBOMInventory) ([]secDBAdvisory, error) {
	ecoAllow := map[string]bool{}
	for _, e := range src.Ecosystems {
		ecoAllow[normalizeEcoKey(e)] = true
	}
	type ecoPkg struct{ eco, pkg string }
	seen := map[string]bool{}
	var targets []ecoPkg
	for _, item := range inv.Items {
		ecos := item.OSVEcosystems
		if len(ecos) == 0 && item.Ecosystem != "" {
			ecos = []string{item.Ecosystem}
		}
		for _, eco := range ecos {
			if eco == "" || item.Package == "" {
				continue
			}
			if len(ecoAllow) > 0 && !ecoAllow[normalizeEcoKey(eco)] {
				continue
			}
			k := eco + "|" + strings.ToLower(item.Package)
			if !seen[k] {
				seen[k] = true
				targets = append(targets, ecoPkg{eco: eco, pkg: item.Package})
			}
		}
	}
	if len(targets) == 0 {
		return nil, nil
	}

	baseURL := strings.TrimRight(effectiveFeedURL(src), "/")
	client := feedHTTPClient(src, 30*time.Second)
	vulnIDSet := map[string]bool{}
	const batchSize = 50
	for start := 0; start < len(targets); start += batchSize {
		end := start + batchSize
		if end > len(targets) {
			end = len(targets)
		}
		secSyncMu.Lock()
		secSyncSt.Progress = fmt.Sprintf("正在查询「%s」公告索引 (%d/%d 个软件包)...", src.Name, end, len(targets))
		secSyncMu.Unlock()

		var reqBody struct {
			Queries []map[string]any `json:"queries"`
		}
		for _, t := range targets[start:end] {
			reqBody.Queries = append(reqBody.Queries, map[string]any{
				"package": map[string]string{
					"name":      t.pkg,
					"ecosystem": t.eco,
				},
			})
		}
		raw, _ := json.Marshal(reqBody)
		req, err := http.NewRequestWithContext(ctx, "POST", baseURL+"/v1/querybatch", bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		applyFeedAuth(req, src)
		resp, err := client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("无法连接 %s（离线内网请改用导入离线包）：%w", src.Name, err)
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("返回 HTTP %d", resp.StatusCode)
		}
		var batchResp struct {
			Results []struct {
				Vulns []struct{ ID string `json:"id"` } `json:"vulns"`
			} `json:"results"`
		}
		if err := json.Unmarshal(body, &batchResp); err != nil {
			return nil, fmt.Errorf("解析响应失败：%w", err)
		}
		for _, r := range batchResp.Results {
			for _, v := range r.Vulns {
				if v.ID != "" {
					vulnIDSet[v.ID] = true
				}
			}
		}
	}

	vulnIDs := make([]string, 0, len(vulnIDSet))
	for id := range vulnIDSet {
		vulnIDs = append(vulnIDs, id)
	}
	sort.Strings(vulnIDs)
	if len(vulnIDs) > 600 {
		vulnIDs = vulnIDs[:600]
	}
	secSyncMu.Lock()
	secSyncSt.Progress = fmt.Sprintf("正在从「%s」拉取 %d 条公告详情...", src.Name, len(vulnIDs))
	secSyncMu.Unlock()

	var incoming []secDBAdvisory
	var incMu sync.Mutex
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	srcLabel := firstNonEmptyStr(src.Name, "OSV")
	for _, vid := range vulnIDs {
		vid := vid
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/v1/vulns/"+url.PathEscape(vid), nil)
			if err != nil {
				return
			}
			applyFeedAuth(req, src)
			resp, err := client.Do(req)
			if err != nil {
				return
			}
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
			resp.Body.Close()
			if resp.StatusCode != 200 {
				return
			}
			var doc osvFullDoc
			if json.Unmarshal(b, &doc) != nil || doc.ID == "" {
				return
			}
			advs := advisoriesFromOSVDoc(doc, srcLabel)
			if len(advs) > 0 {
				incMu.Lock()
				incoming = append(incoming, advs...)
				incMu.Unlock()
			}
		}()
	}
	wg.Wait()
	return incoming, nil
}

func fetchFromJSONFeedSource(ctx context.Context, src secFeedSource) ([]secDBAdvisory, error) {
	client := feedHTTPClient(src, 30*time.Second)
	req, err := http.NewRequestWithContext(ctx, "GET", src.URL, nil)
	if err != nil {
		return nil, err
	}
	applyFeedAuth(req, src)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 24<<20))
	resp.Body.Close()
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("返回 HTTP %d", resp.StatusCode)
	}
	advs := parseFlexibleAdvisoryJSON(b)
	if len(advs) == 0 {
		return nil, errors.New("未识别到有效的 CVE/OSV 安全公告记录")
	}
	ecoAllow := map[string]bool{}
	for _, e := range src.Ecosystems {
		ecoAllow[normalizeEcoKey(e)] = true
	}
	out := make([]secDBAdvisory, 0, len(advs))
	for _, a := range advs {
		if len(ecoAllow) > 0 && !ecoAllow[normalizeEcoKey(a.Ecosystem)] {
			continue
		}
		a.Source = firstNonEmptyStr(src.Name, a.Source, "custom-json")
		out = append(out, a)
	}
	return out, nil
}

func fetchFromBundleURLSource(ctx context.Context, src secFeedSource) ([]secDBAdvisory, error) {
	client := feedHTTPClient(src, 60*time.Second)
	req, err := http.NewRequestWithContext(ctx, "GET", src.URL, nil)
	if err != nil {
		return nil, err
	}
	applyFeedAuth(req, src)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	resp.Body.Close()
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("返回 HTTP %d", resp.StatusCode)
	}
	if len(raw) < 2 || raw[0] != 0x1f || raw[1] != 0x8b {
		return parseFlexibleAdvisoryJSON(raw), nil
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("无法解压远程离线包：%w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	files := map[string][]byte{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("远程离线包损坏：%w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(tr, 64<<20))
		if err != nil {
			return nil, err
		}
		files[filepath.Base(hdr.Name)] = data
	}
	if sumsRaw, ok := files["SHA256SUMS"]; ok {
		for _, line := range strings.Split(string(sumsRaw), "\n") {
			fields := strings.Fields(strings.TrimSpace(line))
			if len(fields) < 2 {
				continue
			}
			want, fname := strings.ToLower(fields[0]), filepath.Base(fields[1])
			data, exists := files[fname]
			if !exists {
				return nil, fmt.Errorf("离线包缺少文件 %s", fname)
			}
			gotH := sha256.Sum256(data)
			if hex.EncodeToString(gotH[:]) != want {
				return nil, fmt.Errorf("离线包 %s SHA256 校验失败", fname)
			}
		}
	}
	var incoming []secDBAdvisory
	if advRaw, ok := files["advisories.json"]; ok {
		if err := json.Unmarshal(advRaw, &incoming); err != nil {
			return nil, fmt.Errorf("解析 advisories.json 失败：%w", err)
		}
	} else {
		for name, data := range files {
			if strings.HasSuffix(strings.ToLower(name), ".json") && name != "manifest.json" {
				incoming = append(incoming, parseFlexibleAdvisoryJSON(data)...)
			}
		}
	}
	for i := range incoming {
		if incoming[i].Source == "" {
			incoming[i].Source = src.Name
		}
	}
	return incoming, nil
}

func fetchFromCISAKEVSource(ctx context.Context, src secFeedSource) (map[string]string, error) {
	client := feedHTTPClient(src, 30*time.Second)
	req, err := http.NewRequestWithContext(ctx, "GET", src.URL, nil)
	if err != nil {
		return nil, err
	}
	applyFeedAuth(req, src)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	resp.Body.Close()
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("返回 HTTP %d", resp.StatusCode)
	}
	var kev struct {
		Vulnerabilities []struct {
			CVEID          string `json:"cveID"`
			DateAdded      string `json:"dateAdded"`
			RequiredAction string `json:"requiredAction"`
		} `json:"vulnerabilities"`
	}
	if err := json.Unmarshal(b, &kev); err != nil {
		return nil, fmt.Errorf("解析 CISA KEV JSON 失败：%w", err)
	}
	out := map[string]string{}
	for _, v := range kev.Vulnerabilities {
		id := strings.ToUpper(strings.TrimSpace(v.CVEID))
		if id == "" {
			continue
		}
		note := fmt.Sprintf("CISA KEV 收录日期：%s", v.DateAdded)
		if v.RequiredAction != "" {
			note += "；处置要求：" + truncRunes(v.RequiredAction, 160)
		}
		out[id] = note
	}
	return out, nil
}

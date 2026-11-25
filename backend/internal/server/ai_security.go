package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"delivery-studio/pkglib"
)

// Native read-only security & release advisory lookup tool (`check_package_security`).
// Queries official public OSV.dev and PyPI JSON APIs directly in Go with fixed public hosts (zero SSRF surface),
// avoiding slow Python sandbox web-scraping scripts while still keeping sandbox available as a fallback.

const checkPkgSecName = "check_package_security"

var (
	osvAPIBase  = "https://api.osv.dev"
	pypiAPIBase = "https://pypi.org"

	reSecPkgName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,120}$`)
	reSecPkgVer  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:+!~-]{0,80}$`)
	reSecEco     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 .:_/-]{0,60}$`)
	reSecVulnID  = regexp.MustCompile(`^[A-Za-z0-9_-]{4,64}$`)
)

func checkPackageSecurityTool() aiToolDef {
	return aiToolDef{
		Name: checkPkgSecName,
		Description: "直接查询官方安全公告库（OSV.dev）与 PyPI 元数据，批量核实软件包的已知 CVE/GHSA 漏洞、首个修复版本、最新稳定版及 Python 兼容性，或按漏洞编号查询详情。" +
			"核查依赖包 CVE、安全修复价值与版本升级必要性时首选此工具（可配合 web_search / web_fetch 补查发行说明），无需为此启动 Python 沙箱写爬虫。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"packages": map[string]any{
					"type":        "array",
					"description": "要批量核查的软件包列表（单次最多 15 个）",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"name":      map[string]any{"type": "string", "description": "包名，如 pip、cryptography、ansible-core、postgresql、redis"},
							"version":   map[string]any{"type": "string", "description": "当前版本号，如 25.3、50.0.2（可省略以仅查最新元信息）"},
							"ecosystem": map[string]any{"type": "string", "description": "生态名，默认 PyPI；也支持 Ubuntu:24.04、Debian:12、Rocky Linux、AlmaLinux、Red Hat、Go、npm 等"},
						},
						"required": []string{"name"},
					},
				},
				"vuln_id": map[string]any{
					"type":        "string",
					"description": "可选：按漏洞编号直接查询官方详情（如 CVE-2026-1703、GHSA-xxxx）",
				},
			},
		},
	}
}

type secPkgQuery struct {
	Name      string `json:"name"`
	Version   string `json:"version,omitempty"`
	Ecosystem string `json:"ecosystem,omitempty"`
}

type secAdvisory struct {
	ID        string   `json:"id"`
	Aliases   []string `json:"aliases,omitempty"`
	Summary   string   `json:"summary,omitempty"`
	Severity  string   `json:"severity,omitempty"`
	FixedIn   []string `json:"fixed_in,omitempty"`
	Published string   `json:"published,omitempty"`
	URL       string   `json:"url,omitempty"`
	Source    string   `json:"source,omitempty"`
}

type secPkgResult struct {
	Name            string        `json:"name"`
	Version         string        `json:"version,omitempty"`
	Ecosystem       string        `json:"ecosystem"`
	LatestVersion   string        `json:"latest_version,omitempty"`
	HasNewer        bool          `json:"has_newer,omitempty"`
	RequiresPython  string        `json:"requires_python,omitempty"`
	Yanked          bool          `json:"yanked,omitempty"`
	YankedReason    string        `json:"yanked_reason,omitempty"`
	Vulnerabilities []secAdvisory `json:"vulnerabilities"`
	ReleaseURL      string        `json:"release_url,omitempty"`
	Warnings        []string      `json:"warnings,omitempty"`
}

type osvVulnDoc struct {
	ID         string   `json:"id"`
	Aliases    []string `json:"aliases"`
	Summary    string   `json:"summary"`
	Details    string   `json:"details"`
	Published  string   `json:"published"`
	Modified   string   `json:"modified"`
	Severity   []struct {
		Type  string `json:"type"`
		Score string `json:"score"`
	} `json:"severity"`
	DatabaseSpecific struct {
		Severity string `json:"severity"`
	} `json:"database_specific"`
	Affected []struct {
		Package struct {
			Name      string `json:"name"`
			Ecosystem string `json:"ecosystem"`
		} `json:"package"`
		Ranges []struct {
			Type   string `json:"type"`
			Events []struct {
				Introduced string `json:"introduced,omitempty"`
				Fixed      string `json:"fixed,omitempty"`
			} `json:"events"`
		} `json:"ranges"`
	} `json:"affected"`
	References []struct {
		Type string `json:"type"`
		URL  string `json:"url"`
	} `json:"references"`
}

func normalizeSecEcosystem(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "PyPI"
	}
	switch strings.ToLower(raw) {
	case "pypi", "python", "pip":
		return "PyPI"
	case "go", "golang":
		return "Go"
	case "npm", "node", "nodejs":
		return "npm"
	case "ubuntu":
		return "Ubuntu"
	case "debian":
		return "Debian"
	case "redhat", "red hat", "rhel":
		return "Red Hat"
	case "rocky", "rocky linux":
		return "Rocky Linux"
	case "almalinux", "alma":
		return "AlmaLinux"
	}
	return raw
}

func secVulnFromOSV(v osvVulnDoc, matchPkg string) secAdvisory {
	adv := secAdvisory{
		ID:        v.ID,
		Aliases:   v.Aliases,
		Summary:   strings.TrimSpace(v.Summary),
		Published: v.Published,
		URL:       "https://osv.dev/vulnerability/" + v.ID,
		Source:    "OSV",
	}
	if adv.Summary == "" && v.Details != "" {
		firstLine := strings.TrimSpace(strings.SplitN(v.Details, "\n", 2)[0])
		adv.Summary = truncRunes(firstLine, 180)
	}
	if v.DatabaseSpecific.Severity != "" {
		adv.Severity = v.DatabaseSpecific.Severity
	} else if len(v.Severity) > 0 {
		adv.Severity = v.Severity[0].Type + ":" + v.Severity[0].Score
	}
	fixedSeen := map[string]bool{}
	normMatch := pkglib.NormPy(matchPkg)
	for _, af := range v.Affected {
		if matchPkg != "" && !strings.EqualFold(af.Package.Name, matchPkg) && pkglib.NormPy(af.Package.Name) != normMatch {
			continue
		}
		for _, rg := range af.Ranges {
			for _, ev := range rg.Events {
				if ev.Fixed != "" && !fixedSeen[ev.Fixed] {
					fixedSeen[ev.Fixed] = true
					adv.FixedIn = append(adv.FixedIn, ev.Fixed)
				}
			}
		}
	}
	sort.Strings(adv.FixedIn)
	for _, ref := range v.References {
		if ref.Type == "ADVISORY" && ref.URL != "" {
			adv.URL = ref.URL
			break
		}
	}
	return adv
}

func (s *storeServer) fetchOSVVuln(ctx context.Context, client *http.Client, id string) (osvVulnDoc, error) {
	var doc osvVulnDoc
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(osvAPIBase, "/")+"/v1/vulns/"+url.PathEscape(id), nil)
	if err != nil {
		return doc, err
	}
	req.Header.Set("User-Agent", webUA)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return doc, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return doc, fmt.Errorf("OSV 返回 %d", resp.StatusCode)
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&doc)
	return doc, err
}

type pypiJSONDoc struct {
	Info struct {
		Name           string `json:"name"`
		Version        string `json:"version"`
		RequiresPython string `json:"requires_python"`
		ReleaseURL     string `json:"release_url"`
		ProjectURL     string `json:"project_url"`
		Yanked         bool   `json:"yanked"`
		YankedReason   string `json:"yanked_reason"`
	} `json:"info"`
	Vulnerabilities []struct {
		ID      string   `json:"id"`
		Aliases []string `json:"aliases"`
		Summary string   `json:"summary"`
		Details string   `json:"details"`
		FixedIn []string `json:"fixed_in"`
		Link    string   `json:"link"`
	} `json:"vulnerabilities"`
}

func (s *storeServer) fetchPyPIJSON(ctx context.Context, client *http.Client, pkgName, ver string) (pypiJSONDoc, error) {
	var doc pypiJSONDoc
	u := strings.TrimRight(pypiAPIBase, "/") + "/pypi/" + url.PathEscape(pkglib.NormPy(pkgName))
	if ver != "" {
		u += "/" + url.PathEscape(ver)
	}
	u += "/json"
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return doc, err
	}
	req.Header.Set("User-Agent", webUA)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return doc, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return doc, fmt.Errorf("PyPI 返回 %d", resp.StatusCode)
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&doc)
	return doc, err
}

func mergeAdvisories(base []secAdvisory, extra []secAdvisory) []secAdvisory {
	seen := map[string]bool{}
	mark := func(a secAdvisory) {
		seen[strings.ToUpper(a.ID)] = true
		for _, al := range a.Aliases {
			seen[strings.ToUpper(al)] = true
		}
	}
	has := func(a secAdvisory) bool {
		if seen[strings.ToUpper(a.ID)] {
			return true
		}
		for _, al := range a.Aliases {
			if seen[strings.ToUpper(al)] {
				return true
			}
		}
		return false
	}
	out := make([]secAdvisory, 0, len(base)+len(extra))
	for _, a := range base {
		if !has(a) {
			mark(a)
			out = append(out, a)
		}
	}
	for _, a := range extra {
		if !has(a) {
			mark(a)
			out = append(out, a)
		}
	}
	return out
}

func (s *storeServer) checkPackageSecurity(ctx context.Context, args string) string {
	var in struct {
		Packages []secPkgQuery `json:"packages"`
		VulnID   string        `json:"vuln_id"`
	}
	if json.Unmarshal([]byte(args), &in) != nil {
		return "参数格式错误：请提供 packages 数组或 vuln_id。"
	}
	client := &http.Client{Timeout: 18 * time.Second}

	// Single vulnerability ID lookup.
	if vid := strings.TrimSpace(in.VulnID); vid != "" && len(in.Packages) == 0 {
		if !reSecVulnID.MatchString(vid) {
			return "漏洞编号格式无效：" + vid
		}
		doc, err := s.fetchOSVVuln(ctx, client, vid)
		if err != nil {
			return "安全公告查询失败（" + vid + "）：" + err.Error()
		}
		adv := secVulnFromOSV(doc, "")
		var affected []map[string]any
		for _, af := range doc.Affected {
			var fixed []string
			for _, rg := range af.Ranges {
				for _, ev := range rg.Events {
					if ev.Fixed != "" {
						fixed = append(fixed, ev.Fixed)
					}
				}
			}
			affected = append(affected, map[string]any{
				"ecosystem": af.Package.Ecosystem,
				"package":   af.Package.Name,
				"fixed_in":  fixed,
			})
			if len(affected) >= 12 {
				break
			}
		}
		var refs []string
		for _, r := range doc.References {
			if r.URL != "" {
				refs = append(refs, r.URL)
				if len(refs) >= 6 {
					break
				}
			}
		}
		payload := map[string]any{
			"id":         adv.ID,
			"aliases":    adv.Aliases,
			"summary":    adv.Summary,
			"details":    truncRunes(strings.TrimSpace(doc.Details), 1200),
			"severity":   adv.Severity,
			"published":  adv.Published,
			"affected":   affected,
			"references": refs,
		}
		b, _ := json.MarshalIndent(payload, "", "  ")
		head := fmt.Sprintf("已查询官方漏洞公告 %s", adv.ID)
		if len(adv.Aliases) > 0 {
			head += "（" + strings.Join(adv.Aliases, " / ") + "）"
		}
		return aiScrub(head + "\n" + string(b))
	}

	if len(in.Packages) == 0 {
		return "请提供至少一个软件包（packages）或漏洞编号（vuln_id）。"
	}
	if len(in.Packages) > 15 {
		in.Packages = in.Packages[:15]
	}

	queries := make([]secPkgQuery, 0, len(in.Packages))
	results := make([]secPkgResult, 0, len(in.Packages))
	for _, p := range in.Packages {
		name := strings.TrimSpace(p.Name)
		ver := strings.TrimSpace(p.Version)
		eco := normalizeSecEcosystem(p.Ecosystem)
		if name == "" || !reSecPkgName.MatchString(name) {
			continue
		}
		if ver != "" && !reSecPkgVer.MatchString(ver) {
			continue
		}
		if !reSecEco.MatchString(eco) {
			eco = "PyPI"
		}
		queries = append(queries, secPkgQuery{Name: name, Version: ver, Ecosystem: eco})
		results = append(results, secPkgResult{
			Name:            name,
			Version:         ver,
			Ecosystem:       eco,
			Vulnerabilities: []secAdvisory{},
		})
	}
	if len(queries) == 0 {
		return "没有合法的软件包名称可供查询。"
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	var osvErr string
	osvVulnIDsByIdx := make([][]string, len(queries))
	osvDetails := map[string]osvVulnDoc{}

	// 1. Batch query OSV.dev for all versioned packages in one round-trip.
	type osvBatchReqItem struct {
		Version string `json:"version"`
		Package struct {
			Name      string `json:"name"`
			Ecosystem string `json:"ecosystem"`
		} `json:"package"`
	}
	var batchItems []osvBatchReqItem
	var batchMap []int
	for i, q := range queries {
		if q.Version == "" {
			continue
		}
		var item osvBatchReqItem
		item.Version = q.Version
		item.Package.Name = q.Name
		item.Package.Ecosystem = q.Ecosystem
		batchItems = append(batchItems, item)
		batchMap = append(batchMap, i)
	}
	if len(batchItems) > 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body, _ := json.Marshal(map[string]any{"queries": batchItems})
			req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(osvAPIBase, "/")+"/v1/querybatch", bytes.NewReader(body))
			if err != nil {
				mu.Lock()
				osvErr = err.Error()
				mu.Unlock()
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("User-Agent", webUA)
			resp, err := client.Do(req)
			if err != nil {
				mu.Lock()
				osvErr = err.Error()
				mu.Unlock()
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 {
				mu.Lock()
				osvErr = fmt.Sprintf("OSV querybatch 返回 %d", resp.StatusCode)
				mu.Unlock()
				return
			}
			var br struct {
				Results []struct {
					Vulns []struct {
						ID string `json:"id"`
					} `json:"vulns"`
				} `json:"results"`
			}
			if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&br); err != nil {
				mu.Lock()
				osvErr = err.Error()
				mu.Unlock()
				return
			}
			uniq := map[string]bool{}
			var toFetch []string
			for k, r := range br.Results {
				if k >= len(batchMap) {
					break
				}
				idx := batchMap[k]
				for _, v := range r.Vulns {
					if v.ID == "" {
						continue
					}
					osvVulnIDsByIdx[idx] = append(osvVulnIDsByIdx[idx], v.ID)
					if !uniq[v.ID] && len(toFetch) < 20 {
						uniq[v.ID] = true
						toFetch = append(toFetch, v.ID)
					}
				}
			}
			if len(toFetch) == 0 {
				return
			}
			sem := make(chan struct{}, 6)
			var dwg sync.WaitGroup
			for _, vid := range toFetch {
				dwg.Add(1)
				go func(id string) {
					defer dwg.Done()
					sem <- struct{}{}
					defer func() { <-sem }()
					if doc, derr := s.fetchOSVVuln(ctx, client, id); derr == nil && doc.ID != "" {
						mu.Lock()
						osvDetails[id] = doc
						mu.Unlock()
					}
				}(vid)
			}
			dwg.Wait()
		}()
	}

	// 2. Concurrently fetch PyPI version metadata & inline advisories for PyPI packages.
	sem := make(chan struct{}, 6)
	pypiAnyOK := false
	pypiAnyAttempt := false
	for i, q := range queries {
		if q.Ecosystem != "PyPI" {
			continue
		}
		pypiAnyAttempt = true
		wg.Add(1)
		go func(idx int, pq secPkgQuery) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			var verDoc, latestDoc pypiJSONDoc
			var verErr, latestErr error
			if pq.Version != "" {
				verDoc, verErr = s.fetchPyPIJSON(ctx, client, pq.Name, pq.Version)
			}
			latestDoc, latestErr = s.fetchPyPIJSON(ctx, client, pq.Name, "")

			mu.Lock()
			defer mu.Unlock()
			if verErr == nil && pq.Version != "" {
				pypiAnyOK = true
				results[idx].RequiresPython = verDoc.Info.RequiresPython
				results[idx].Yanked = verDoc.Info.Yanked
				results[idx].YankedReason = verDoc.Info.YankedReason
				results[idx].ReleaseURL = firstNonEmptyStr(verDoc.Info.ReleaseURL, verDoc.Info.ProjectURL)
				var pyAdvs []secAdvisory
				for _, pv := range verDoc.Vulnerabilities {
					adv := secAdvisory{
						ID:      pv.ID,
						Aliases: pv.Aliases,
						Summary: strings.TrimSpace(pv.Summary),
						FixedIn: pv.FixedIn,
						URL:     pv.Link,
						Source:  "PyPI",
					}
					if adv.Summary == "" && pv.Details != "" {
						adv.Summary = truncRunes(strings.TrimSpace(strings.SplitN(pv.Details, "\n", 2)[0]), 180)
					}
					pyAdvs = append(pyAdvs, adv)
				}
				results[idx].Vulnerabilities = mergeAdvisories(results[idx].Vulnerabilities, pyAdvs)
			} else if verErr != nil && pq.Version != "" {
				results[idx].Warnings = append(results[idx].Warnings, "PyPI 版本查询失败："+verErr.Error())
			}

			if latestErr == nil && latestDoc.Info.Version != "" {
				pypiAnyOK = true
				results[idx].LatestVersion = latestDoc.Info.Version
				if results[idx].RequiresPython == "" {
					results[idx].RequiresPython = latestDoc.Info.RequiresPython
				}
				if results[idx].ReleaseURL == "" {
					results[idx].ReleaseURL = firstNonEmptyStr(latestDoc.Info.ReleaseURL, latestDoc.Info.ProjectURL)
				}
				if pq.Version != "" && pkglib.ComparePy(latestDoc.Info.Version, pq.Version) > 0 {
					results[idx].HasNewer = true
				}
			} else if latestErr != nil {
				results[idx].Warnings = append(results[idx].Warnings, "PyPI 最新版本查询失败："+latestErr.Error())
			}
		}(i, q)
	}

	wg.Wait()

	// Merge OSV findings into results.
	totalVulns := 0
	vulnPkgs := []string{}
	newerCount := 0
	for i := range results {
		var osvAdvs []secAdvisory
		for _, vid := range osvVulnIDsByIdx[i] {
			if doc, ok := osvDetails[vid]; ok {
				osvAdvs = append(osvAdvs, secVulnFromOSV(doc, results[i].Name))
			} else {
				osvAdvs = append(osvAdvs, secAdvisory{
					ID:     vid,
					URL:    "https://osv.dev/vulnerability/" + vid,
					Source: "OSV",
				})
			}
		}
		results[i].Vulnerabilities = mergeAdvisories(osvAdvs, results[i].Vulnerabilities)
		if osvErr != "" && results[i].Version != "" {
			results[i].Warnings = append(results[i].Warnings, "OSV 查询失败："+osvErr)
		}
		if len(results[i].Vulnerabilities) > 0 {
			totalVulns += len(results[i].Vulnerabilities)
			label := results[i].Name
			if results[i].Version != "" {
				label += " " + results[i].Version
			}
			vulnPkgs = append(vulnPkgs, label)
		}
		if results[i].HasNewer {
			newerCount++
		}
	}

	if osvErr != "" && (!pypiAnyAttempt || !pypiAnyOK) {
		return "安全公告查询失败：无法访问 OSV.dev/PyPI（" + osvErr + "）。请检查外网/代理配置，或改用 web_search 补充查询。"
	}

	var head string
	if totalVulns > 0 {
		head = fmt.Sprintf("已核查 %d 个软件包安全公告：发现 %d 条已知漏洞（涉及 %s）", len(results), totalVulns, strings.Join(vulnPkgs, "、"))
	} else {
		head = fmt.Sprintf("已核查 %d 个软件包安全公告：未发现已知 CVE/OSV 漏洞", len(results))
	}
	if newerCount > 0 {
		head += fmt.Sprintf("，%d 个包有更新版本", newerCount)
	}
	payload := map[string]any{
		"sources": []string{"OSV.dev (api.osv.dev)", "PyPI JSON API (pypi.org)"},
		"results": results,
	}
	if osvErr != "" {
		payload["osv_warning"] = osvErr
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	out := head + "\n" + string(b)
	if len(out) > aiMaxResult {
		out = out[:aiMaxResult] + "\n…（结果过长，已截断；可分批缩小 packages 数量）"
	}
	return aiScrub(out)
}

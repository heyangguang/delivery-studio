package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"middleware-deployer/mwpack"
)

// ---- Brownfield Middleware Cluster Onboarding (Import / Adoption) ----
//
// Endpoints:
//   GET  /api/clusters/import/presets       - Catalog components + 36+ built-in presets + platforms + icons
//   POST /api/clusters/import/probe-script  - Generate 100% statically validated read-only Bash probe script
//   POST /api/clusters/import/parse         - Parse probe output / CMDB / config / screenshots (AI + deterministic fallback)
//   POST /api/clusters/import               - Onboard cluster (DeliveryMode="imported", State="succeeded", Outcome="done")
//   GET  /api/clusters/{id}/baseline        - Read current baseline & ImportedMeta for editing
//   PUT  /api/clusters/{id}/baseline        - Update imported cluster baseline (re-writes spec, plan.json, storeJob)

type importPresetItem struct {
	ID              string                    `json:"id"`
	Name            string                    `json:"name"`
	NameEn          string                    `json:"name_en,omitempty"`
	Category        string                    `json:"category"`
	CategoryTitle   string                    `json:"category_title"`
	CategoryTitleEn string                    `json:"category_title_en,omitempty"`
	Icon            string                    `json:"icon"`
	Color           string                    `json:"color"`
	Summary         string                    `json:"summary"`
	SummaryEn       string                    `json:"summary_en,omitempty"`
	InCatalog       bool                      `json:"in_catalog"`
	DefaultPort     int                       `json:"default_port,omitempty"`
	Versions        []string                  `json:"versions,omitempty"`
	Roles           []mwpack.ImportRolePreset `json:"roles"`
	ServiceHints    []string                  `json:"service_hints,omitempty"`
	ConfigHints     []string                  `json:"config_hints,omitempty"`
	DataHints       []string                  `json:"data_hints,omitempty"`
	LogHints        []string                  `json:"log_hints,omitempty"`
}

type importHostInput struct {
	Name string `json:"name"`
	IP   string `json:"ip"`
	Role string `json:"role,omitempty"`
	Disk string `json:"disk,omitempty"`
}

type importClusterReq struct {
	ID           string                    `json:"id"`
	Title        string                    `json:"title,omitempty"`
	Component    string                    `json:"component"`
	DisplayName  string                    `json:"display_name,omitempty"`
	Category     string                    `json:"category,omitempty"`
	Icon         string                    `json:"icon,omitempty"`
	Color        string                    `json:"color,omitempty"`
	Version      string                    `json:"version"`
	ExactVersion string                    `json:"exact_version,omitempty"`
	Platform     string                    `json:"platform,omitempty"`
	OSDetail     string                    `json:"os_detail,omitempty"`
	SourceKind   string                    `json:"source_kind,omitempty"` // manual | probe | ai_doc
	DeployMethod string                    `json:"deploy_method,omitempty"`
	ArchSummary  string                    `json:"arch_summary,omitempty"`
	Hosts        []importHostInput         `json:"hosts"`
	Endpoints    []mwpack.ImportedEndpoint `json:"endpoints,omitempty"`
	ServiceUnits []string                  `json:"service_units,omitempty"`
	ConfigPaths  []string                  `json:"config_paths,omitempty"`
	DataDirs     []string                  `json:"data_dirs,omitempty"`
	LogDirs      []string                  `json:"log_dirs,omitempty"`
	Params       map[string]any            `json:"params,omitempty"`
	Packages     []mwpack.ImportedPkg      `json:"packages,omitempty"`
	Notes        string                    `json:"notes,omitempty"`
	LastProbedAt string                    `json:"last_probed_at,omitempty"`
}

type importProbeScriptReq struct {
	Component    string   `json:"component"`
	DisplayName  string   `json:"display_name,omitempty"`
	DeployMethod string   `json:"deploy_method,omitempty"`
	ServiceUnits []string `json:"service_units,omitempty"`
	ConfigPaths  []string `json:"config_paths,omitempty"`
}

type importParseReq struct {
	Component   string   `json:"component,omitempty"`
	DisplayName string   `json:"display_name,omitempty"`
	SourceKind  string   `json:"source_kind,omitempty"` // probe | ai_doc
	Text        string   `json:"text,omitempty"`
	Images      []string `json:"images,omitempty"`
	UseAI       *bool    `json:"use_ai,omitempty"`
}

type importParseDraft struct {
	SuggestedID  string                    `json:"suggested_id,omitempty"`
	Component    string                    `json:"component,omitempty"`
	DisplayName  string                    `json:"display_name,omitempty"`
	Version      string                    `json:"version,omitempty"`
	ExactVersion string                    `json:"exact_version,omitempty"`
	Platform     string                    `json:"platform,omitempty"`
	OSDetail     string                    `json:"os_detail,omitempty"`
	DeployMethod string                    `json:"deploy_method,omitempty"`
	ArchSummary  string                    `json:"arch_summary,omitempty"`
	Hosts        []importHostInput         `json:"hosts"`
	Endpoints    []mwpack.ImportedEndpoint `json:"endpoints"`
	ServiceUnits []string                  `json:"service_units"`
	ConfigPaths  []string                  `json:"config_paths"`
	DataDirs     []string                  `json:"data_dirs"`
	LogDirs      []string                  `json:"log_dirs"`
	Params       map[string]any            `json:"params"`
	Packages     []mwpack.ImportedPkg      `json:"packages"`
	Notes        string                    `json:"notes,omitempty"`
}

// handleClusterImport dispatches /api/clusters/import... routes.
func (s *storeServer) handleClusterImport(w http.ResponseWriter, r *http.Request, session storeSession) {
	sub := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/clusters/import"), "/")
	switch {
	case sub == "" && r.Method == "POST":
		s.importCluster(w, r, session)
	case sub == "presets" && r.Method == "GET":
		s.importPresetsHandler(w, r, session)
	case sub == "probe-script" && r.Method == "POST":
		s.importProbeScriptHandler(w, r, session)
	case sub == "parse" && r.Method == "POST":
		s.importParseHandler(w, r, session)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

func (s *storeServer) importPresetsHandler(w http.ResponseWriter, r *http.Request, session storeSession) {
	lang := wLang(w)
	cat := s.plat.cat()
	inCat := map[string]bool{}
	var catalogItems []importPresetItem

	if cat != nil {
		for _, name := range cat.Names() {
			c, ok := cat.Get(name)
			if !ok || c.Kind == "external" || c.Name == "external-lb" {
				continue
			}
			inCat[c.Name] = true
			item := importPresetItem{
				ID:        c.Name,
				Name:      firstNonEmptyStr(c.Title, c.Name),
				NameEn:    mwpack.TranslateCatalogText("en-US", firstNonEmptyStr(c.Title, c.Name)),
				Category:  firstNonEmptyStr(c.Category, "middleware"),
				Icon:      firstNonEmptyStr(c.Icon, "server"),
				Color:     firstNonEmptyStr(c.Color, "blue"),
				Summary:   c.Summary,
				SummaryEn: mwpack.TranslateCatalogText("en-US", c.Summary),
				InCatalog: true,
			}
			for _, v := range c.Versions {
				if v.ID != "" {
					item.Versions = append(item.Versions, v.ID)
				}
			}
			if len(c.Versions) > 0 {
				if res, err := c.Resolve(c.Versions[0].ID); err == nil {
					for _, rl := range res.Roles {
						item.Roles = append(item.Roles, mwpack.ImportRolePreset{
							ID:      rl.Name,
							Title:   firstNonEmptyStr(rl.Title, rl.Name),
							TitleEn: mwpack.TranslateCatalogText("en-US", firstNonEmptyStr(rl.Title, rl.Name)),
						})
					}
				}
			}
			if pr, okP := mwpack.LookupImportPreset(c.Name); okP {
				item.Category = pr.Category
				item.CategoryTitle = pr.CategoryTitle
				item.CategoryTitleEn = pr.CategoryTitleEn
				item.DefaultPort = pr.DefaultPort
				item.ServiceHints = pr.ServiceHints
				item.ConfigHints = pr.ConfigHints
				item.DataHints = pr.DataHints
				item.LogHints = pr.LogHints
				if len(item.Roles) == 0 {
					item.Roles = pr.Roles
				}
			} else {
				item.CategoryTitle = tr(lang, "平台组件", "Catalog Component")
				item.CategoryTitleEn = "Catalog Component"
				if len(item.Roles) == 0 {
					item.Roles = []mwpack.ImportRolePreset{{ID: "node", Title: "节点", TitleEn: "Node"}}
				}
			}
			catalogItems = append(catalogItems, item)
		}
	}

	var presetItems []importPresetItem
	for _, pr := range mwpack.ImportPresets {
		if inCat[pr.ID] {
			continue
		}
		presetItems = append(presetItems, importPresetItem{
			ID:              pr.ID,
			Name:            pr.Name,
			NameEn:          pr.NameEn,
			Category:        pr.Category,
			CategoryTitle:   pr.CategoryTitle,
			CategoryTitleEn: pr.CategoryTitleEn,
			Icon:            pr.Icon,
			Color:           pr.Color,
			Summary:         pr.Summary,
			SummaryEn:       pr.SummaryEn,
			InCatalog:       false,
			DefaultPort:     pr.DefaultPort,
			Roles:           pr.Roles,
			ServiceHints:    pr.ServiceHints,
			ConfigHints:     pr.ConfigHints,
			DataHints:       pr.DataHints,
			LogHints:        pr.LogHints,
		})
	}

	type platItem struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	var plats []platItem
	for _, pl := range mwpack.Platforms {
		plats = append(plats, platItem{ID: pl.ID, Title: pl.Title})
	}

	s.writeJSON(w, 200, map[string]any{
		"catalog":    catalogItems,
		"presets":    presetItems,
		"platforms":  plats,
		"icons":      mwpack.ComponentIcons,
		"ai_enabled": s.aiStatusFor(session.User).Enabled,
	})
}

func buildImportProbeScript(req importProbeScriptReq, lang string) (string, string) {
	compID := mwpack.NormalizeImportComponentID(firstNonEmptyStr(req.Component, req.DisplayName))
	preset, hasPreset := mwpack.LookupImportPreset(compID)
	displayName := firstNonEmptyStr(strings.TrimSpace(req.DisplayName), preset.Name, compID)
	pkgMatch := preset.PkgMatch
	if pkgMatch == "" {
		pkgMatch = regexp.QuoteMeta(compID)
	}
	var sb strings.Builder
	sb.WriteString("#!/usr/bin/env bash\n")
	sb.WriteString("# ============================================================================\n")
	sb.WriteString(fmt.Sprintf("# Kyndryl Delivery Studio - Read-Only Cluster Inventory Probe (%s)\n", displayName))
	sb.WriteString("# 100% READ-ONLY: zero writes, zero restarts, zero config mutations, secrets redacted.\n")
	sb.WriteString("# Run on each target node (or primary node) and paste output back to the Import page.\n")
	sb.WriteString("# ============================================================================\n")
	sb.WriteString("set -u\nexport LC_ALL=C\n\n")

	sb.WriteString("echo '=== MW_IMPORT_BEGIN ==='\n")
	sb.WriteString(fmt.Sprintf("echo 'PROBE_COMPONENT=%s'\n", compID))
	sb.WriteString("echo 'PROBE_TIME='\"$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)\"\n\n")

	sb.WriteString("echo '=== MW_IMPORT_HOST ==='\n")
	sb.WriteString("echo \"HOSTNAME=$(hostname -s 2>/dev/null || hostname)\"\n")
	sb.WriteString("echo \"FQDN=$(hostname -f 2>/dev/null || hostname)\"\n")
	sb.WriteString("echo \"IPS=$(hostname -I 2>/dev/null | xargs)\"\n")
	sb.WriteString("echo \"KERNEL=$(uname -sr)\"\n")
	sb.WriteString("echo \"ARCH=$(uname -m)\"\n")
	sb.WriteString("echo \"CPU_CORES=$(nproc 2>/dev/null || echo unknown)\"\n")
	sb.WriteString("free -h 2>/dev/null | awk 'NR==1 || NR==2 {print \"MEM=\"$0}' || true\n\n")

	sb.WriteString("echo '=== MW_IMPORT_OS ==='\n")
	sb.WriteString("[ -r /etc/os-release ] && grep -E '^(ID|VERSION_ID|PRETTY_NAME)=' /etc/os-release || uname -a\n\n")

	sb.WriteString("echo '=== MW_IMPORT_STORAGE ==='\n")
	sb.WriteString("df -hT -x tmpfs -x devtmpfs -x overlay 2>/dev/null | head -n 20 || true\n\n")

	sb.WriteString("echo '=== MW_IMPORT_PORTS ==='\n")
	sb.WriteString("if command -v ss >/dev/null 2>&1; then\n")
	sb.WriteString("  ss -tlnp 2>/dev/null | head -n 40\n")
	sb.WriteString("elif command -v netstat >/dev/null 2>&1; then\n")
	sb.WriteString("  netstat -tlnp 2>/dev/null | head -n 40\n")
	sb.WriteString("fi\n\n")

	sb.WriteString("echo '=== MW_IMPORT_HOSTS_FILE ==='\n")
	sb.WriteString("[ -r /etc/hosts ] && grep -vE '^\\s*(#|$|127\\.|::1|fe00|ff0)' /etc/hosts | head -n 30 || true\n\n")

	sb.WriteString("echo '=== MW_IMPORT_MIDDLEWARE ==='\n")
	if req.DeployMethod == "docker" || req.DeployMethod == "k8s" {
		sb.WriteString("command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}\\t{{.Image}}\\t{{.Ports}}\\t{{.Status}}' 2>/dev/null | head -n 30 || true\n")
		sb.WriteString("command -v crictl >/dev/null 2>&1 && crictl ps 2>/dev/null | head -n 30 || true\n")
	}
	if hasPreset && strings.TrimSpace(preset.ProbeSnippet) != "" {
		sb.WriteString(strings.TrimSpace(preset.ProbeSnippet) + "\n")
	} else {
		sb.WriteString(fmt.Sprintf("systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE '%s' || true\n", pkgMatch))
		sb.WriteString(fmt.Sprintf("ps -ef 2>/dev/null | grep -iE '%s' | grep -v grep | head -n 20 || true\n", pkgMatch))
	}

	// Custom service units or config paths hints provided by user
	for _, u := range req.ServiceUnits {
		u = strings.TrimSpace(u)
		if u == "" || !reSafeShellToken.MatchString(u) {
			continue
		}
		sb.WriteString(fmt.Sprintf("systemctl show '%s' -p ActiveState -p SubState -p ExecStart -p FragmentPath --no-pager 2>/dev/null || true\n", u))
	}
	for _, cf := range req.ConfigPaths {
		cf = strings.TrimSpace(cf)
		if cf == "" || !reSafePathToken.MatchString(cf) {
			continue
		}
		sb.WriteString(fmt.Sprintf("[ -r '%s' ] && { echo '# file: %s'; grep -vE '^\\s*(#|;|\\s*$|.*pass|.*secret|.*token|.*key)' '%s' | head -n 40; } || true\n", cf, cf, cf))
	}

	sb.WriteString("\necho '=== MW_IMPORT_PACKAGES ==='\n")
	sb.WriteString("if command -v dpkg-query >/dev/null 2>&1; then\n")
	sb.WriteString(fmt.Sprintf("  dpkg-query -W -f='${Package}\\t${Version}\\n' 2>/dev/null | grep -iE '%s' | sort -u | head -n 60 || true\n", pkgMatch))
	sb.WriteString("elif command -v rpm >/dev/null 2>&1; then\n")
	sb.WriteString(fmt.Sprintf("  rpm -qa --qf '%%{NAME}\\t%%{VERSION}-%%{RELEASE}\\n' 2>/dev/null | grep -iE '%s' | sort -u | head -n 60 || true\n", pkgMatch))
	sb.WriteString("fi\n")
	sb.WriteString("echo '=== MW_IMPORT_END ==='\n")

	filename := fmt.Sprintf("mw-import-probe-%s.sh", compID)
	return sb.String(), filename
}

var (
	reSafeShellToken = regexp.MustCompile(`^[a-zA-Z0-9._:@-]+$`)
	reSafePathToken  = regexp.MustCompile(`^/[a-zA-Z0-9._/@*+-]+$`)
)

func (s *storeServer) importProbeScriptHandler(w http.ResponseWriter, r *http.Request, session storeSession) {
	var req importProbeScriptReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		s.fail(w, 400, "请求参数无法解析")
		return
	}
	lang := wLang(w)
	script, filename := buildImportProbeScript(req, lang)
	safe, warns := validateReadOnlyProbeScriptLang(script, lang)
	s.writeJSON(w, 200, map[string]any{
		"script":   script,
		"filename": filename,
		"safe":     safe,
		"warnings": nz(warns),
	})
}

func (s *storeServer) importParseHandler(w http.ResponseWriter, r *http.Request, session storeSession) {
	var req importParseReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 20<<20)).Decode(&req); err != nil {
		s.fail(w, 400, "请求内容无法解析或超出大小限制")
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" && len(req.Images) == 0 {
		s.fail(w, 400, "请先粘贴采集脚本输出、CMDB/配置文本，或上传架构/终端截图")
		return
	}
	if len(req.Images) > 4 {
		s.fail(w, 400, "单次最多上传 4 张截图")
		return
	}
	for _, img := range req.Images {
		if !reDataImage.MatchString(img) || len(img) > 6<<20 {
			s.fail(w, 400, "截图格式需为 png、jpg、gif 或 webp，且单张不超过 4 MiB")
			return
		}
	}

	lang := wLang(w)
	preset, _ := mwpack.LookupImportPreset(req.Component)
	det := parseImportedDeterministic(text, req.Component, req.DisplayName, preset)

	wantAI := true
	if req.UseAI != nil {
		wantAI = *req.UseAI
	}

	aiUsed := false
	parserMode := "deterministic"
	var warns []string
	draft := det

	if wantAI && s.aiStatusFor(session.User).Enabled {
		st := s.aiLoad()
		providers := st.aiProvidersFor("chat")
		if len(providers) == 0 {
			providers = st.aiProvidersFor("rehearsal")
		}
		if len(providers) > 0 && (st.MonthlyLimit <= 0 || s.aiCallsThisMonth(session.User) < st.MonthlyLimit) {
			p := providers[0]
			if len(req.Images) > 0 && p.Vision == "no" {
				for _, cand := range providers {
					if cand.Vision != "no" {
						p = cand
						break
					}
				}
			}
			aiDraft, aiErr := s.aiExtractImportDraft(r.Context(), p, session.User, req, det, preset, lang)
			if aiErr == nil && aiDraft != nil {
				draft = mergeImportDrafts(*aiDraft, det)
				aiUsed = true
				parserMode = "ai"
			} else if aiErr != nil {
				warns = append(warns, tr(lang, "AI 解析暂时不可用，已自动回退为内置规则解析："+aiErr.Error(), "AI extraction unavailable; fell back to deterministic parser: "+aiErr.Error()))
			}
		}
	} else if len(req.Images) > 0 && text == "" {
		warns = append(warns, tr(lang, "当前未开启 AI 助手，无法直接识别纯截图；请粘贴文本或在设置中启用 AI。", "AI is disabled and cannot parse image-only inputs; paste text or enable AI in Settings."))
	}

	for i := range draft.Endpoints {
		draft.Endpoints[i].Role = normalizeImportEndpointRole(draft.Endpoints[i].Role)
	}
	// Compute missing fields checklist for the UI
	var missing []string
	if len(draft.Hosts) == 0 {
		missing = append(missing, tr(lang, "主机节点清单（hostname / IP）", "Host list (hostname / IP)"))
	}
	if strings.TrimSpace(draft.Version) == "" && strings.TrimSpace(draft.ExactVersion) == "" {
		missing = append(missing, tr(lang, "中间件版本号", "Middleware version"))
	}
	if strings.TrimSpace(draft.Platform) == "" {
		missing = append(missing, tr(lang, "操作系统平台", "Operating system platform"))
	}

	s.writeJSON(w, 200, map[string]any{
		"draft":          draft,
		"parser":         parserMode,
		"ai_used":        aiUsed,
		"warnings":       nz(warns),
		"missing_fields": nz(missing),
	})
}

func (s *storeServer) aiExtractImportDraft(ctx context.Context, p aiProvider, user string, req importParseReq, det importParseDraft, preset mwpack.ImportPreset, lang string) (*importParseDraft, error) {
	var roleHint []string
	for _, r := range preset.Roles {
		roleHint = append(roleHint, r.ID+"("+r.Title+")")
	}
	sys := `你是一位企业级中间件架构师，负责把运维工程师粘贴的只读采集脚本输出、CMDB 表格、配置文件或截图整理为严格的 JSON 纳管基线草稿。
严格要求：
1. 只输出一个合法 JSON 对象，不要包含 Markdown 代码块围栏或额外解释文字。
2. 所有信息必须严格来自输入文本或截图，严禁凭空编造 IP、主机名或版本号；未在输入中出现的可留空。
3. 严禁在 params 或 notes 中输出任何密码、私钥或密钥明文（如有请脱敏为 <redacted>）。
4. platform 如能识别，优先映射到以下标准 ID 之一：ubuntu-24.04-amd64, ubuntu-22.04-amd64, el9-amd64, el8-amd64, debian-12-amd64, kylin-v10-amd64, openeuler-22.03-amd64；无法映射可留空并在 os_detail 填写原始发行版名称。
5. deploy_method 取值为 systemd / docker / binary / k8s / other 之一。
6. JSON 结构：
{
  "suggested_id": "小写字母数字连字符集群标识，如 mysql-erp-prod",
  "component": "中间件标识，如 postgresql / mysql / redis / kafka",
  "display_name": "展示名称，如 MySQL / PostgreSQL",
  "version": "主版本或版本，如 8.0 / 17",
  "exact_version": "精确版本，如 8.0.36 / 17.2",
  "platform": "平台 ID",
  "os_detail": "原始操作系统描述，如 Ubuntu 24.04.1 LTS",
  "deploy_method": "systemd|docker|binary|k8s|other",
  "arch_summary": "一句话架构总结，如 一主两从高可用 / 3节点 Raft 集群",
  "hosts": [{"name":"node-1","ip":"10.0.1.11","role":"primary"}],
  "endpoints": [{"name":"writer","address":"10.0.1.100:3306","role":"readwrite"}], // role 仅取 readwrite | readonly | admin 之一
  "service_units": ["mysqld.service"],
  "config_paths": ["/etc/my.cnf"],
  "data_dirs": ["/data/mysql"],
  "log_dirs": ["/var/log/mysql"],
  "params": {"port": 3306},
  "packages": [{"name":"mysql-server","version":"8.0.36","role":"primary"}],
  "notes": "其他有价值的运维线索摘要"
}`
	var prompt strings.Builder
	if req.Component != "" || req.DisplayName != "" {
		fmt.Fprintf(&prompt, "用户已预选中间件：%s (%s)\n", firstNonEmptyStr(req.DisplayName, req.Component), req.Component)
	}
	if len(roleHint) > 0 {
		fmt.Fprintf(&prompt, "推荐角色名：%s\n", strings.Join(roleHint, ", "))
	}
	if req.SourceKind != "" {
		fmt.Fprintf(&prompt, "输入来源类型：%s\n", req.SourceKind)
	}
	if strings.TrimSpace(req.Text) != "" {
		prompt.WriteString("\n--- 原始粘贴文本 ---\n")
		prompt.WriteString(truncRunes(aiScrub(req.Text), 14000))
		prompt.WriteString("\n")
	} else {
		prompt.WriteString("\n请结合附图提取集群主机、角色、版本、入口地址与关键参数。\n")
	}

	var userContent any = prompt.String()
	if len(req.Images) > 0 && p.Vision != "no" {
		parts := []map[string]any{{"type": "text", "text": prompt.String()}}
		for _, img := range req.Images {
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": img}})
		}
		userContent = parts
	}

	callCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	started := time.Now()
	rep, err := s.aiChat(callCtx, p, []aiMessage{
		{Role: "system", Content: sys},
		{Role: "user", Content: userContent},
	}, nil, nil)
	if err != nil {
		return nil, err
	}
	s.aiRecordUsage(aiUsage{
		At:        nowStamp(),
		User:      user,
		Feature:   "import_parse",
		Provider:  firstNonEmptyStr(p.Name, p.ID),
		Model:     p.Model,
		In:        rep.In,
		Out:       rep.Out,
		Cached:    rep.Cached,
		Reasoning: rep.Reasoning,
		MS:        time.Since(started).Milliseconds(),
		OK:        true,
	})
	raw := extractJSONObject(rep.Text)
	if raw == "" {
		return nil, fmt.Errorf("AI 未返回有效 JSON")
	}
	var out importParseDraft
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, fmt.Errorf("AI 返回 JSON 解析失败: %v", err)
	}
	return &out, nil
}

func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.Index(s, "```"); idx >= 0 {
		if end := strings.LastIndex(s, "```"); end > idx {
			inner := s[idx+3 : end]
			if nl := strings.IndexByte(inner, '\n'); nl >= 0 {
				inner = inner[nl+1:]
			}
			s = strings.TrimSpace(inner)
		}
	}
	start := strings.IndexByte(s, '{')
	end := strings.LastIndexByte(s, '}')
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return ""
}

var (
	reIPv4          = regexp.MustCompile(`\b((?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168|\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3})\b`)
	reVersionSemver = regexp.MustCompile(`\b(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9._]+)?)\b`)
	reHostLine      = regexp.MustCompile(`(?i)^\s*([a-z][a-z0-9._-]{1,62})[\s,;|\t]+(\d{1,3}(?:\.\d{1,3}){3})(?:[\s,;|\t]+([a-z0-9_-]+))?`)
	reIPFirstLine   = regexp.MustCompile(`(?i)^\s*(\d{1,3}(?:\.\d{1,3}){3})[\s,;|\t]+([a-z][a-z0-9._-]{1,62})(?:[\s,;|\t]+([a-z0-9_-]+))?`)
)

func parseImportedDeterministic(text, component, displayName string, preset mwpack.ImportPreset) importParseDraft {
	draft := importParseDraft{
		Component:    strings.TrimSpace(component),
		DisplayName:  firstNonEmptyStr(strings.TrimSpace(displayName), preset.Name),
		Hosts:        []importHostInput{},
		Endpoints:    []mwpack.ImportedEndpoint{},
		ServiceUnits: []string{},
		ConfigPaths:  []string{},
		DataDirs:     []string{},
		LogDirs:      []string{},
		Params:       map[string]any{},
		Packages:     []mwpack.ImportedPkg{},
	}
	if strings.TrimSpace(text) == "" {
		return draft
	}

	seenHost := map[string]bool{}
	seenUnit := map[string]bool{}
	seenCfg := map[string]bool{}
	seenPkg := map[string]bool{}
	addHost := func(name, ip, role string) {
		name = strings.TrimSpace(name)
		ip = strings.TrimSpace(ip)
		if ip != "" && (strings.HasPrefix(ip, "127.") || ip == "0.0.0.0" || net.ParseIP(ip) == nil) {
			return
		}
		if name == "" && ip == "" {
			return
		}
		if name == "" {
			name = "node-" + fmt.Sprint(len(draft.Hosts)+1)
		}
		key := strings.ToLower(name)
		if seenHost[key] {
			return
		}
		seenHost[key] = true
		if role == "" && len(preset.Roles) > 0 {
			if len(draft.Hosts) == 0 {
				role = preset.Roles[0].ID
			} else if len(preset.Roles) > 1 {
				role = preset.Roles[1].ID
			} else {
				role = preset.Roles[0].ID
			}
		}
		draft.Hosts = append(draft.Hosts, importHostInput{Name: name, IP: ip, Role: role})
	}

	section := ""
	curHost := ""
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for _, raw := range lines {
		ln := strings.TrimSpace(raw)
		if ln == "" {
			continue
		}
		if strings.HasPrefix(ln, "=== MW_IMPORT_") && strings.HasSuffix(ln, "===") {
			section = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(ln, "=== MW_IMPORT_"), "==="))
			continue
		}
		if strings.HasPrefix(ln, "PROBE_COMPONENT=") && draft.Component == "" {
			draft.Component = strings.TrimSpace(strings.TrimPrefix(ln, "PROBE_COMPONENT="))
			continue
		}
		if strings.HasPrefix(ln, "HOSTNAME=") {
			curHost = strings.TrimSpace(strings.TrimPrefix(ln, "HOSTNAME="))
			continue
		}
		if strings.HasPrefix(ln, "IPS=") {
			ips := strings.Fields(strings.TrimSpace(strings.TrimPrefix(ln, "IPS=")))
			chosen := ""
			for _, cand := range ips {
				if net.ParseIP(cand) != nil && !strings.HasPrefix(cand, "127.") && !strings.Contains(cand, ":") {
					chosen = cand
					break
				}
			}
			if curHost != "" || chosen != "" {
				addHost(curHost, chosen, "")
				curHost = ""
			}
			continue
		}
		if strings.HasPrefix(ln, "PRETTY_NAME=") {
			osName := strings.Trim(strings.TrimPrefix(ln, "PRETTY_NAME="), `"'`)
			draft.OSDetail = osName
			if draft.Platform == "" {
				draft.Platform = inferPlatformFromOS(osName)
			}
			continue
		}
		if strings.HasPrefix(ln, "# file: ") {
			cf := strings.TrimSpace(strings.TrimPrefix(ln, "# file: "))
			if cf != "" && !seenCfg[cf] {
				seenCfg[cf] = true
				draft.ConfigPaths = append(draft.ConfigPaths, cf)
			}
			continue
		}
		if section == "PACKAGES" {
			fields := strings.Split(ln, "\t")
			if len(fields) < 2 {
				fields = strings.Fields(ln)
			}
			if len(fields) >= 2 && !strings.HasPrefix(fields[0], "#") {
				pkgName, pkgVer := strings.TrimSpace(fields[0]), strings.TrimSpace(fields[1])
				k := pkgName + "|" + pkgVer
				if pkgName != "" && pkgVer != "" && !seenPkg[k] {
					seenPkg[k] = true
					role := "dependency"
					if strings.Contains(strings.ToLower(pkgName), strings.ToLower(firstNonEmptyStr(draft.Component, "mw"))) {
						role = "primary"
					}
					draft.Packages = append(draft.Packages, mwpack.ImportedPkg{Name: pkgName, Version: pkgVer, Role: role})
				}
			}
			continue
		}
		// Extract systemd service unit names
		if strings.Contains(ln, ".service") {
			for _, tok := range strings.Fields(ln) {
				if strings.HasSuffix(tok, ".service") && reSafeShellToken.MatchString(tok) && !seenUnit[tok] {
					seenUnit[tok] = true
					draft.ServiceUnits = append(draft.ServiceUnits, tok)
					if draft.DeployMethod == "" {
						draft.DeployMethod = "systemd"
					}
				}
			}
		}
		// Detect docker deployment
		if strings.Contains(strings.ToLower(ln), "docker") && strings.Contains(ln, "Up ") && draft.DeployMethod == "" {
			draft.DeployMethod = "docker"
		}
		// Extract version from typical middleware --version banners
		if draft.ExactVersion == "" {
			low := strings.ToLower(ln)
			if strings.Contains(low, "version") || strings.Contains(low, "ver ") || strings.Contains(low, "(postgresql)") || strings.Contains(low, "redis server v=") || strings.Contains(low, "nginx/") || strings.Contains(low, "haproxy") || strings.Contains(low, "mysqld") || strings.Contains(low, "mongod") || strings.Contains(low, "clickhouse") {
				if m := reVersionSemver.FindStringSubmatch(ln); len(m) == 2 {
					draft.ExactVersion = m[1]
					draft.Version = majorMinorVersion(m[1], draft.Component)
				}
			}
		}
		// Extract hosts from /etc/hosts or pasted CMDB lines (hostname ip [role] or ip hostname [role])
		if section == "HOSTS_FILE" || section == "" {
			if m := reIPFirstLine.FindStringSubmatch(ln); len(m) >= 3 {
				addHost(m[2], m[1], strings.ToLower(m[3]))
			} else if m := reHostLine.FindStringSubmatch(ln); len(m) >= 3 {
				addHost(m[1], m[2], strings.ToLower(m[3]))
			}
		}
	}

	if draft.DeployMethod == "" {
		draft.DeployMethod = "systemd"
	}
	if draft.Platform == "" && draft.OSDetail != "" {
		draft.Platform = inferPlatformFromOS(draft.OSDetail)
	}
	if draft.Version == "" && draft.ExactVersion != "" {
		draft.Version = majorMinorVersion(draft.ExactVersion, draft.Component)
	}
	if len(draft.ConfigPaths) == 0 && len(preset.ConfigHints) > 0 {
		draft.ConfigPaths = append([]string(nil), preset.ConfigHints[0])
	}
	if len(draft.DataDirs) == 0 && len(preset.DataHints) > 0 {
		draft.DataDirs = append([]string(nil), preset.DataHints[0])
	}
	if len(draft.LogDirs) == 0 && len(preset.LogHints) > 0 {
		draft.LogDirs = append([]string(nil), preset.LogHints[0])
	}
	if len(draft.Hosts) > 0 && draft.ArchSummary == "" {
		if len(draft.Hosts) == 1 {
			draft.ArchSummary = "存量单节点实例"
		} else {
			draft.ArchSummary = fmt.Sprintf("存量 %d 节点集群", len(draft.Hosts))
		}
	}
	return draft
}

func mergeImportDrafts(aiD, det importParseDraft) importParseDraft {
	out := aiD
	if out.Component == "" {
		out.Component = det.Component
	}
	if out.DisplayName == "" {
		out.DisplayName = det.DisplayName
	}
	if out.ExactVersion == "" {
		out.ExactVersion = det.ExactVersion
	}
	if out.Version == "" {
		out.Version = firstNonEmptyStr(det.Version, majorMinorVersion(out.ExactVersion, out.Component))
	}
	if out.Platform == "" {
		out.Platform = det.Platform
	}
	if out.OSDetail == "" {
		out.OSDetail = det.OSDetail
	}
	if out.DeployMethod == "" {
		out.DeployMethod = det.DeployMethod
	}
	if out.ArchSummary == "" {
		out.ArchSummary = det.ArchSummary
	}
	if len(out.Hosts) == 0 {
		out.Hosts = det.Hosts
	}
	if len(out.ServiceUnits) == 0 {
		out.ServiceUnits = det.ServiceUnits
	}
	if len(out.ConfigPaths) == 0 {
		out.ConfigPaths = det.ConfigPaths
	}
	if len(out.DataDirs) == 0 {
		out.DataDirs = det.DataDirs
	}
	if len(out.LogDirs) == 0 {
		out.LogDirs = det.LogDirs
	}
	// Preserve deterministic packages if AI returned none or fewer
	if len(out.Packages) < len(det.Packages) {
		seen := map[string]bool{}
		for _, pk := range out.Packages {
			seen[pk.Name+"|"+pk.Version] = true
		}
		for _, pk := range det.Packages {
			if !seen[pk.Name+"|"+pk.Version] {
				out.Packages = append(out.Packages, pk)
			}
		}
	}
	if out.Hosts == nil {
		out.Hosts = []importHostInput{}
	}
	if out.Endpoints == nil {
		out.Endpoints = []mwpack.ImportedEndpoint{}
	} else {
		for i := range out.Endpoints {
			out.Endpoints[i].Role = normalizeImportEndpointRole(out.Endpoints[i].Role)
		}
	}
	if out.ServiceUnits == nil {
		out.ServiceUnits = []string{}
	}
	if out.ConfigPaths == nil {
		out.ConfigPaths = []string{}
	}
	if out.DataDirs == nil {
		out.DataDirs = []string{}
	}
	if out.LogDirs == nil {
		out.LogDirs = []string{}
	}
	if out.Params == nil {
		out.Params = map[string]any{}
	}
	if out.Packages == nil {
		out.Packages = []mwpack.ImportedPkg{}
	}
	return out
}

func normalizeImportEndpointRole(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "readonly", "ro", "read", "reader", "replica", "standby", "slave", "secondary", "follower":
		return "readonly"
	case "admin", "console", "mgmt", "management", "ui", "dashboard", "metrics", "monitor", "web":
		return "admin"
	case "readwrite", "rw", "write", "writer", "primary", "master", "leader", "client", "service", "":
		return "readwrite"
	default:
		return "readwrite"
	}
}

func inferPlatformFromOS(osStr string) string {
	low := strings.ToLower(osStr)
	switch {
	case strings.Contains(low, "ubuntu") && strings.Contains(low, "24.04"):
		return "ubuntu-24.04-amd64"
	case strings.Contains(low, "ubuntu") && strings.Contains(low, "22.04"):
		return "ubuntu-22.04-amd64"
	case (strings.Contains(low, "rocky") || strings.Contains(low, "red hat") || strings.Contains(low, "rhel") || strings.Contains(low, "alma") || strings.Contains(low, "centos")) && strings.Contains(low, "9"):
		return "el9-amd64"
	case (strings.Contains(low, "rocky") || strings.Contains(low, "red hat") || strings.Contains(low, "rhel") || strings.Contains(low, "alma") || strings.Contains(low, "centos")) && strings.Contains(low, "8"):
		return "el8-amd64"
	case strings.Contains(low, "debian") && strings.Contains(low, "12"):
		return "debian-12-amd64"
	case strings.Contains(low, "kylin"):
		return "kylin-v10-amd64"
	case strings.Contains(low, "openeuler"):
		return "openeuler-22.03-amd64"
	}
	return ""
}

func majorMinorVersion(exact, comp string) string {
	exact = strings.TrimSpace(exact)
	if exact == "" {
		return ""
	}
	parts := strings.Split(exact, ".")
	c := strings.ToLower(comp)
	if c == "postgresql" || c == "patroni" {
		return parts[0]
	}
	if len(parts) >= 2 {
		return parts[0] + "." + parts[1]
	}
	return parts[0]
}

func buildImportedDeployment(cat *mwpack.Catalog, req importClusterReq, user, now string) (*mwpack.Deployment, string, string, string, error) {
	cid := strings.TrimSpace(req.ID)
	if !docClusterID.MatchString(cid) {
		return nil, "", "", "", fmt.Errorf("集群标识只允许小写字母开头，由小写字母、数字和连字符组成（最多 41 位）")
	}
	compID := mwpack.NormalizeImportComponentID(firstNonEmptyStr(req.Component, req.DisplayName))
	preset, hasPreset := mwpack.LookupImportPreset(compID)

	inCatalog := false
	catTitle := ""
	catIcon := ""
	catColor := ""
	catCategory := ""
	if cat != nil {
		if c, ok := cat.Get(compID); ok && c.Kind != "external" {
			inCatalog = true
			catTitle = c.Title
			catIcon = c.Icon
			catColor = c.Color
			catCategory = c.Category
		}
	}

	displayName := firstNonEmptyStr(strings.TrimSpace(req.DisplayName), catTitle, preset.Name, compID)
	icon := firstNonEmptyStr(strings.TrimSpace(req.Icon), catIcon, preset.Icon, "server")
	color := firstNonEmptyStr(strings.TrimSpace(req.Color), catColor, preset.Color, "slate")
	category := firstNonEmptyStr(strings.TrimSpace(req.Category), catCategory, preset.Category, "middleware")
	ver := firstNonEmptyStr(strings.TrimSpace(req.Version), majorMinorVersion(req.ExactVersion, compID), "unknown")
	exactVer := strings.TrimSpace(req.ExactVersion)
	if exactVer == "" && ver != "unknown" {
		exactVer = ver
	}

	if len(req.Hosts) == 0 {
		return nil, "", "", "", fmt.Errorf("请至少填写 1 台集群主机节点")
	}
	var hosts []mwpack.Host
	placement := map[string][]string{}
	seenH := map[string]bool{}
	defaultRole := "node"
	if hasPreset && len(preset.Roles) > 0 {
		defaultRole = preset.Roles[0].ID
	}
	for i, h := range req.Hosts {
		hn := strings.TrimSpace(h.Name)
		hip := strings.TrimSpace(h.IP)
		if hn == "" && hip == "" {
			continue
		}
		if hn == "" {
			hn = fmt.Sprintf("node-%d", i+1)
		}
		if seenH[hn] {
			return nil, "", "", "", fmt.Errorf("主机名 %q 重复，请保证每个节点名称唯一", hn)
		}
		seenH[hn] = true
		hosts = append(hosts, mwpack.Host{Name: hn, IP: hip, Disk: strings.TrimSpace(h.Disk)})
		role := strings.TrimSpace(h.Role)
		if role == "" {
			role = defaultRole
		}
		placement[role] = append(placement[role], hn)
	}
	if len(hosts) == 0 {
		return nil, "", "", "", fmt.Errorf("请至少填写 1 台有效的主机节点")
	}

	sourceKind := strings.TrimSpace(req.SourceKind)
	if sourceKind != "manual" && sourceKind != "probe" && sourceKind != "ai_doc" {
		sourceKind = "manual"
	}
	deployMethod := strings.TrimSpace(req.DeployMethod)
	if deployMethod == "" {
		deployMethod = "systemd"
	}

	cleanSlice := func(in []string) []string {
		var out []string
		seen := map[string]bool{}
		for _, v := range in {
			t := strings.TrimSpace(v)
			if t != "" && !seen[t] {
				seen[t] = true
				out = append(out, t)
			}
		}
		return out
	}

	var endpoints []mwpack.ImportedEndpoint
	for _, ep := range req.Endpoints {
		addr := strings.TrimSpace(ep.Address)
		if addr == "" {
			continue
		}
		endpoints = append(endpoints, mwpack.ImportedEndpoint{
			Name:    strings.TrimSpace(ep.Name),
			Address: addr,
			Role:    normalizeImportEndpointRole(ep.Role),
		})
	}

	var pkgs []mwpack.ImportedPkg
	seenPk := map[string]bool{}
	for _, pk := range req.Packages {
		pn := strings.TrimSpace(pk.Name)
		pv := strings.TrimSpace(pk.Version)
		if pn == "" || pv == "" || seenPk[pn+"|"+pv] {
			continue
		}
		seenPk[pn+"|"+pv] = true
		role := strings.TrimSpace(pk.Role)
		if role == "" {
			role = "dependency"
		}
		pkgs = append(pkgs, mwpack.ImportedPkg{Name: pn, Version: pv, Role: role})
	}

	meta := &mwpack.ImportedMeta{
		SourceKind:        sourceKind,
		ManagedCatalog:    inCatalog,
		DisplayName:       displayName,
		Category:          category,
		Icon:              icon,
		Color:             color,
		DeployMethod:      deployMethod,
		ArchSummary:       strings.TrimSpace(req.ArchSummary),
		ExactVersion:      exactVer,
		OSDetail:          strings.TrimSpace(req.OSDetail),
		ServiceUnits:      cleanSlice(req.ServiceUnits),
		ConfigPaths:       cleanSlice(req.ConfigPaths),
		DataDirs:          cleanSlice(req.DataDirs),
		LogDirs:           cleanSlice(req.LogDirs),
		Endpoints:         endpoints,
		Packages:          pkgs,
		Notes:             strings.TrimSpace(req.Notes),
		LastProbedAt:      strings.TrimSpace(req.LastProbedAt),
		BaselineUpdatedAt: now,
		BaselineUpdatedBy: user,
	}
	if sourceKind == "probe" && meta.LastProbedAt == "" {
		meta.LastProbedAt = now
	}

	instID := compID
	if cat != nil {
		if c, ok := cat.Get(compID); ok && c.Short != "" {
			instID = c.Short
		}
	}

	dep := &mwpack.Deployment{
		Schema:       mwpack.DeploymentSchema,
		DeliveryMode: "imported",
		ID:           cid,
		Title:        strings.TrimSpace(req.Title),
		Controller:   hosts[0].Name,
		Platform:     strings.TrimSpace(req.Platform),
		Hosts:        hosts,
		Instances: []mwpack.InstanceSpec{{
			ID:        instID,
			Component: compID,
			Version:   ver,
			Placement: placement,
			Params:    req.Params,
		}},
		Imported: meta,
	}
	return dep, compID, displayName, ver, nil
}

func writeImportedPlanFiles(dir string, dep *mwpack.Deployment, plan *mwpack.Plan) error {
	outDir := filepath.Join(dir, "output")
	if err := os.MkdirAll(outDir, 0o700); err != nil {
		return err
	}
	specBytes, err := dep.YAML()
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "deployment.yml"), specBytes, 0o600); err != nil {
		return err
	}
	pv := plan.View()
	planDoc := map[string]any{
		"delivery_mode":  "imported",
		"step_format":    2,
		"cluster":        dep.ID,
		"project":        dep.ID,
		"controller":     plan.Controller,
		"platforms":      plan.Platforms,
		"hosts":          dep.Hosts,
		"instances":      pv.Instances,
		"imported":       dep.Imported,
		"prepare":        []any{},
		"deploy":         []any{},
		"tests":          []any{},
		"endpoint_tests": []any{},
		"cleanup":        []any{},
	}
	planBytes, err := json.MarshalIndent(planDoc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(outDir, "plan.json"), planBytes, 0o600)
}

func (s *storeServer) invalidateJobCaches(jobID string) {
	s.cacheMu.Lock()
	delete(s.specCache, jobID)
	delete(s.planCache, jobID)
	s.cacheMu.Unlock()
}

func (s *storeServer) importCluster(w http.ResponseWriter, r *http.Request, session storeSession) {
	if !s.need(w, session.User, "delivery.create") {
		return
	}
	var req importClusterReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
		s.fail(w, 400, "提交的纳管配置格式有误")
		return
	}
	now := nowStamp()
	dep, compID, displayName, ver, err := buildImportedDeployment(s.plat.cat(), req, session.User, now)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}

	s.jobPersistMu.Lock()
	defer s.jobPersistMu.Unlock()

	s.mu.Lock()
	if msg := s.clusterTaken(dep.ID); msg != "" {
		s.mu.Unlock()
		s.fail(w, 409, msg)
		return
	}
	jobID := randomStoreToken(16)
	plan := mwpack.SolveImported(s.plat.cat(), dep)
	j := storeJob{
		DeliveryMode: "imported",
		Scheme:       mwpack.ImportedSchemeSummary(dep),
		ID:           jobID,
		Owner:        session.User,
		AppID:        compID,
		AppName:      displayName,
		Version:      ver,
		ClusterID:    dep.ID,
		Seq:          0,
		State:        "succeeded",
		Stage:        "已纳管运行中",
		Outcome:      outcomeDone,
		Marked:       now,
		MarkedBy:     session.User,
		Created:      now,
		Updated:      now,
		Logs:         []string{fmt.Sprintf("[%s] 存量集群纳管建档完成（组件：%s %s，节点：%d 台）", now, displayName, ver, len(dep.Hosts))},
	}
	s.jobs[jobID] = j
	s.mu.Unlock()

	dir := s.jobDir(jobID)
	if err := writeImportedPlanFiles(dir, dep, plan); err != nil {
		s.removeFailedReservation(jobID)
		_ = os.RemoveAll(dir)
		s.fail(w, 500, "保存纳管基线文件失败："+err.Error())
		return
	}
	if err := s.persistJob(j); err != nil {
		s.removeFailedReservation(jobID)
		_ = os.RemoveAll(dir)
		s.fail(w, 500, "保存集群档案失败："+err.Error())
		return
	}

	s.auditReq(r, "cluster-import", session.User, fmt.Sprintf("%s (%s %s, %d hosts, source=%s)", dep.ID, compID, ver, len(dep.Hosts), dep.Imported.SourceKind))
	s.writeJSON(w, 201, map[string]any{
		"cluster_id": dep.ID,
		"job_id":     jobID,
		"component":  compID,
		"app_name":   displayName,
		"version":    ver,
		"imported":   dep.Imported,
	})
}

func (s *storeServer) handleClusterBaseline(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts) {
	dep := s.readSpec(f.Current.ID)
	if dep == nil || (dep.DeliveryMode != "imported" && f.Current.DeliveryMode != "imported") {
		s.fail(w, 400, "仅存量纳管集群支持在线编辑纳管基线档案")
		return
	}
	switch r.Method {
	case "GET":
		hosts := make([]importHostInput, 0, len(dep.Hosts))
		roleByHost := map[string]string{}
		if len(dep.Instances) > 0 {
			for rk, hs := range dep.Instances[0].Placement {
				for _, hn := range hs {
					if _, ok := roleByHost[hn]; !ok {
						roleByHost[hn] = rk
					}
				}
			}
		}
		for _, h := range dep.Hosts {
			hosts = append(hosts, importHostInput{Name: h.Name, IP: h.IP, Role: roleByHost[h.Name], Disk: h.Disk})
		}
		var params map[string]any
		compID := f.Current.AppID
		ver := f.Current.Version
		if len(dep.Instances) > 0 {
			params = dep.Instances[0].Params
			if dep.Instances[0].Component != "" {
				compID = dep.Instances[0].Component
			}
			if dep.Instances[0].Version != "" {
				ver = dep.Instances[0].Version
			}
		}
		if params == nil {
			params = map[string]any{}
		}
		meta := dep.Imported
		if meta == nil {
			meta = &mwpack.ImportedMeta{}
		}
		normEps := make([]mwpack.ImportedEndpoint, 0, len(meta.Endpoints))
		for _, ep := range meta.Endpoints {
			ep.Role = normalizeImportEndpointRole(ep.Role)
			normEps = append(normEps, ep)
		}
		s.writeJSON(w, 200, importClusterReq{
			ID:           dep.ID,
			Title:        dep.Title,
			Component:    compID,
			DisplayName:  firstNonEmptyStr(meta.DisplayName, f.Current.AppName),
			Category:     meta.Category,
			Icon:         meta.Icon,
			Color:        meta.Color,
			Version:      ver,
			ExactVersion: meta.ExactVersion,
			Platform:     dep.Platform,
			OSDetail:     meta.OSDetail,
			SourceKind:   meta.SourceKind,
			DeployMethod: meta.DeployMethod,
			ArchSummary:  meta.ArchSummary,
			Hosts:        hosts,
			Endpoints:    normEps,
			ServiceUnits: meta.ServiceUnits,
			ConfigPaths:  meta.ConfigPaths,
			DataDirs:     meta.DataDirs,
			LogDirs:      meta.LogDirs,
			Params:       params,
			Packages:     meta.Packages,
			Notes:        meta.Notes,
			LastProbedAt: meta.LastProbedAt,
		})

	case "PUT":
		if !s.need(w, session.User, "delivery.create") {
			return
		}
		var req importClusterReq
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&req); err != nil {
			s.fail(w, 400, "基线配置格式有误")
			return
		}
		req.ID = f.ID
		if req.Component == "" {
			req.Component = f.Current.AppID
		}
		if dep.Imported != nil {
			if req.SourceKind == "" {
				req.SourceKind = dep.Imported.SourceKind
			}
			if req.LastProbedAt == "" {
				req.LastProbedAt = dep.Imported.LastProbedAt
			}
		}
		now := nowStamp()
		newDep, compID, displayName, ver, err := buildImportedDeployment(s.plat.cat(), req, session.User, now)
		if err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		plan := mwpack.SolveImported(s.plat.cat(), newDep)

		s.jobPersistMu.Lock()
		defer s.jobPersistMu.Unlock()
		if err := writeImportedPlanFiles(s.jobDir(f.Current.ID), newDep, plan); err != nil {
			s.fail(w, 500, "更新基线文件失败："+err.Error())
			return
		}
		s.invalidateJobCaches(f.Current.ID)

		s.mu.Lock()
		j := s.jobs[f.Current.ID]
		j.AppID = compID
		j.AppName = displayName
		j.Version = ver
		j.Scheme = mwpack.ImportedSchemeSummary(newDep)
		j.Updated = now
		j.Logs = append(j.Logs, fmt.Sprintf("[%s] %s 更新了存量纳管基线档案（版本：%s，节点：%d 台）", now, session.User, ver, len(newDep.Hosts)))
		s.mu.Unlock()
		if err := s.persistJob(j); err != nil {
			s.fail(w, 500, "保存更新后的集群信息失败")
			return
		}
		s.mu.Lock()
		s.jobs[j.ID] = j
		s.mu.Unlock()

		s.auditReq(r, "cluster-baseline-update", session.User, fmt.Sprintf("%s (%s %s, %d hosts)", f.ID, compID, ver, len(newDep.Hosts)))
		s.writeJSON(w, 200, map[string]any{
			"cluster_id": f.ID,
			"job_id":     j.ID,
			"version":    ver,
			"app_name":   displayName,
			"imported":   newDep.Imported,
		})

	default:
		s.fail(w, 405, "方法不允许")
	}
}

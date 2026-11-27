package server

import (
	"fmt"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"delivery-studio/internal/ansiblev2"
	"delivery-studio/mwpack"
)

var (
	v2BridgeClusterIDRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`)
	v2BridgeWhenGroupRe = regexp.MustCompile(`^group\.([a-zA-Z0-9_-]+)\s*(==|!=|>|>=|<|<=)\s*(\d+)$`)
	v2BridgeWhenStrRe   = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9_]*)\s*(==|!=)\s*['"]([^'"]*)['"]$`)
	v2BridgeWhenBoolRe  = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9_]*)\s*(==|!=)\s*(true|false)$`)
)

func (s *storeServer) isAnsibleV2Component(name string) bool {
	if strings.TrimSpace(name) == "" {
		return false
	}
	_, _, ok := s.loadV2Component(name)
	return ok
}

func (s *storeServer) allV2ComponentNames() []string {
	seen := map[string]bool{}
	var names []string
	for _, n := range ansiblev2.BuiltinNames() {
		if !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	for n := range s.loadV2CustomMap() {
		if !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	sort.Strings(names)
	return names
}

func v2SupportedPlatforms() []string {
	return []string{"ubuntu-24.04-amd64", "el9-amd64", "kylin-v10-amd64"}
}

func v2WhenToSchemaWhen(whenExpr string) string {
	raw := strings.TrimSpace(whenExpr)
	if raw == "" {
		return ""
	}
	parts := strings.Split(raw, "&&")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		c := strings.TrimSpace(p)
		if c == "" {
			continue
		}
		if v2BridgeWhenGroupRe.MatchString(c) {
			out = append(out, c)
			continue
		}
		if m := v2BridgeWhenStrRe.FindStringSubmatch(c); len(m) == 4 {
			out = append(out, fmt.Sprintf("params.%s %s '%s'", m[1], m[2], m[3]))
			continue
		}
		if m := v2BridgeWhenBoolRe.FindStringSubmatch(strings.ToLower(c)); len(m) == 4 {
			// Preserve exact variable key casing from original clause
			origKey := strings.TrimSpace(strings.Split(c, m[2])[0])
			want := m[3] == "true"
			if m[2] == "!=" {
				want = !want
			}
			if want {
				out = append(out, "params."+origKey)
			} else {
				out = append(out, "!params."+origKey)
			}
			continue
		}
		out = append(out, c)
	}
	return strings.Join(out, " && ")
}

func evalV2WhenServer(whenExpr string, params map[string]any, placement map[string][]string) bool {
	raw := strings.TrimSpace(whenExpr)
	if raw == "" {
		return true
	}
	parts := strings.Split(raw, "&&")
	for _, p := range parts {
		c := strings.TrimSpace(p)
		if c == "" {
			continue
		}
		if m := v2BridgeWhenGroupRe.FindStringSubmatch(c); len(m) == 4 {
			cnt := len(placement[m[1]])
			target, _ := strconv.Atoi(m[3])
			switch m[2] {
			case "==":
				if !(cnt == target) {
					return false
				}
			case "!=":
				if !(cnt != target) {
					return false
				}
			case ">":
				if !(cnt > target) {
					return false
				}
			case ">=":
				if !(cnt >= target) {
					return false
				}
			case "<":
				if !(cnt < target) {
					return false
				}
			case "<=":
				if !(cnt <= target) {
					return false
				}
			}
			continue
		}
		if m := v2BridgeWhenStrRe.FindStringSubmatch(c); len(m) == 4 {
			cur := strings.TrimSpace(fmt.Sprintf("%v", params[m[1]]))
			if params[m[1]] == nil {
				cur = ""
			}
			if m[2] == "==" && cur != m[3] {
				return false
			}
			if m[2] == "!=" && cur == m[3] {
				return false
			}
			continue
		}
		if m := v2BridgeWhenBoolRe.FindStringSubmatch(strings.ToLower(c)); len(m) == 4 {
			origKey := strings.TrimSpace(strings.Split(c, m[2])[0])
			cur := asBoolVal(params[origKey])
			expected := m[3] == "true"
			if m[2] == "==" && cur != expected {
				return false
			}
			if m[2] == "!=" && cur == expected {
				return false
			}
			continue
		}
	}
	return true
}

func asBoolVal(v any) bool {
	switch b := v.(type) {
	case bool:
		return b
	case string:
		s := strings.ToLower(strings.TrimSpace(b))
		return s == "true" || s == "yes" || s == "1" || s == "on"
	case int:
		return b != 0
	case float64:
		return b != 0
	default:
		return false
	}
}

func v2GroupToTab(groupID string) string {
	switch groupID {
	case "basic", "network":
		return "base"
	case "ha":
		return "ha"
	case "security":
		return "security"
	case "tuning":
		return "tuning"
	case "baseline", "advanced":
		return "os"
	default:
		return "main"
	}
}

func v2VarTypeToParamType(v ansiblev2.VarSpec) string {
	lk := strings.ToLower(v.Key)
	switch v.Type {
	case "select":
		return "enum"
	case "port":
		return "port"
	case "int":
		return "int"
	case "bool":
		return "bool"
	case "secret":
		return "secret"
	case "cidr":
		return "cidr"
	case "list":
		if strings.Contains(lk, "cidr") {
			return "cidr-list"
		}
		return "list"
	case "dict":
		return "dict"
	case "path":
		return "path"
	default:
		return "string"
	}
}

func v2InferSeriesContract(compName string, sc ansiblev2.SchemeSpec, m ansiblev2.Manifest) *mwpack.SeriesContract {
	total := 0
	for _, g := range m.Groups {
		if cnt := sc.GroupCounts[g.Name]; cnt > 0 && (g.Exclusive || total == 0) {
			total += cnt
		}
	}
	if total == 0 {
		for _, cnt := range sc.GroupCounts {
			if cnt > total {
				total = cnt
			}
		}
	}
	lid := strings.ToLower(sc.ID)
	series := "basic"
	failover := "none"
	readAccess := "单节点读写"
	switch {
	case strings.Contains(lid, "sync") || strings.Contains(lid, "ha") || strings.Contains(lid, "sentinel") || strings.Contains(lid, "vip") || strings.Contains(lid, "patroni") || strings.Contains(lid, "colocated") || strings.Contains(lid, "external-etcd"):
		series = "ha"
		failover = "automatic"
		readAccess = "支持高可用主写与自动故障切换"
	case strings.Contains(lid, "replica"):
		series = "replication"
		failover = "manual"
		readAccess = "主库读写、从库只读（人工切换）"
	}
	return &mwpack.SeriesContract{
		When:       "scheme == '" + sc.ID + "'",
		Series:     series,
		Failover:   failover,
		Mechanism:  firstNonEmptyStr(sc.Summary, sc.Title),
		ReadAccess: readAccess,
		Sharding:   false,
		Limitations: []string{
			"100% 标准原生 Ansible 2.0 工程，可脱离平台直接执行 ansible-playbook",
		},
		Operations: []string{"deploy"},
	}
}

func v2BuildTopologyFromScheme(m ansiblev2.Manifest, sc ansiblev2.SchemeSpec) []mwpack.RoleCount {
	out := make([]mwpack.RoleCount, 0, len(m.Groups))
	seen := map[string]bool{}
	for _, g := range m.Groups {
		seen[g.Name] = true
		if cnt, ok := sc.GroupCounts[g.Name]; ok {
			out = append(out, mwpack.RoleCount{Role: g.Name, Count: cnt})
		} else {
			out = append(out, mwpack.RoleCount{Role: g.Name, Count: g.DefaultCount})
		}
	}
	for k, cnt := range sc.GroupCounts {
		if !seen[k] {
			out = append(out, mwpack.RoleCount{Role: k, Count: cnt})
		}
	}
	return out
}

func v2RolesFromManifest(m ansiblev2.Manifest, lang string) []mwpack.RoleSpec {
	roles := make([]mwpack.RoleSpec, 0, len(m.Groups))
	for i, g := range m.Groups {
		title := g.Title
		if lang == langEnUS && g.TitleEn != "" {
			title = g.TitleEn
		}
		if title == "" {
			title = g.Name
		}
		def := g.DefaultCount
		if def == 0 && g.Min > 0 {
			def = g.Min
		}
		roles = append(roles, mwpack.RoleSpec{
			Name:      g.Name,
			Title:     title,
			Min:       g.Min,
			Max:       g.Max,
			Default:   def,
			Exclusive: g.Exclusive,
			Initial:   i == 0,
		})
	}
	if len(roles) == 0 {
		roles = append(roles, mwpack.RoleSpec{
			Name:    "nodes",
			Title:   tr(lang, "目标节点", "Target Nodes"),
			Min:     1,
			Default: 1,
			Initial: true,
		})
	}
	return roles
}

func v2DeliveryModes(m ansiblev2.Manifest) []string {
	if len(m.DeliveryModes) > 0 {
		return append([]string(nil), m.DeliveryModes...)
	}
	return []string{"offline", "automatic"}
}

func v2InferFlows(roles map[string][]string, params map[string]any, lang string) []mwpack.FlowView {
	var flows []mwpack.FlowView
	if p := roles["primary"]; len(p) > 0 {
		if r := roles["replica"]; len(r) > 0 {
			flows = append(flows, mwpack.FlowView{
				ID:       "repl",
				Title:    tr(lang, "主从复制", "Replication"),
				Kind:     "replication",
				From:     append([]string(nil), p...),
				To:       append([]string(nil), r...),
				FromRole: "primary",
				ToRole:   "replica",
			})
		}
	}
	if pt := roles["patroni"]; len(pt) >= 2 {
		syncOn := asBoolVal(params["patroni_synchronous_mode"])
		flows = append(flows, mwpack.FlowView{
			ID:       "patroni-repl",
			Title:    tr(lang, "Patroni 流复制", "Patroni Streaming"),
			Kind:     "mesh",
			From:     append([]string(nil), pt...),
			To:       append([]string(nil), pt...),
			FromRole: "patroni",
			ToRole:   "patroni",
			Sync:     syncOn,
		})
	}
	if et := roles["etcd"]; len(et) >= 2 {
		flows = append(flows, mwpack.FlowView{
			ID:       "etcd-raft",
			Title:    tr(lang, "etcd Raft 仲裁", "etcd Raft Quorum"),
			Kind:     "mesh",
			From:     append([]string(nil), et...),
			To:       append([]string(nil), et...),
			FromRole: "etcd",
			ToRole:   "etcd",
			Sync:     true,
		})
	}
	if sn := roles["sentinel"]; len(sn) >= 2 {
		flows = append(flows, mwpack.FlowView{
			ID:       "sentinel-quorum",
			Title:    tr(lang, "Sentinel 哨兵仲裁", "Sentinel Quorum"),
			Kind:     "mesh",
			From:     append([]string(nil), sn...),
			To:       append([]string(nil), sn...),
			FromRole: "sentinel",
			ToRole:   "sentinel",
		})
	}
	return flows
}

// ansibleV2CatalogEntries converts every built-in and imported Ansible 2.0 component into
// standard catalogEntry items consumed seamlessly by #/apps, #/new picker, and Wizard.tsx.
func (s *storeServer) ansibleV2CatalogEntries(lang string) []catalogEntry {
	names := s.allV2ComponentNames()
	plats := v2SupportedPlatforms()
	out := make([]catalogEntry, 0, len(names))
	for _, name := range names {
		files, src, ok := s.loadV2Component(name)
		if !ok {
			continue
		}
		rep := ansiblev2.Inspect(files, name, src)
		m := rep.Manifest
		ver := firstNonEmptyStr(m.Version, "1.0.0")
		title := m.Title
		summary := m.Summary
		if lang == langEnUS {
			if m.TitleEn != "" {
				title = m.TitleEn
			}
			if m.SummaryEn != "" {
				summary = m.SummaryEn
			}
		}
		cov := make(map[string]coverage, len(plats))
		for _, pl := range plats {
			cov[pl] = coverage{Ready: true, Deployable: true}
		}
		ve := versionEntry{
			VerInfo: mwpack.VerInfo{
				ID:                ver,
				Status:            "published",
				Platforms:         plats,
				VerifiedPlatforms: plats,
			},
			Coverage: cov,
		}
		plans := make([]catalogPlan, 0, len(m.Schemes))
		presets := make([]mwpack.Preset, 0, len(m.Schemes))
		for idx, sc := range m.Schemes {
			scTitle := sc.Title
			if lang == langEnUS && sc.TitleEn != "" {
				scTitle = sc.TitleEn
			}
			topo := v2BuildTopologyFromScheme(m, sc)
			contract := v2InferSeriesContract(name, sc, m)
			tag := ""
			if idx == 0 {
				tag = tr(lang, "推荐", "Recommended")
			}
			plans = append(plans, catalogPlan{
				Contract: contract,
				ID:       sc.ID,
				Name:     scTitle,
				Tag:      tag,
				Spec:     sc.Summary,
				Topology: topo,
				Params:   sc.Vars,
			})
			presets = append(presets, mwpack.Preset{
				Contract: contract,
				ID:       sc.ID,
				Name:     scTitle,
				Tag:      tag,
				Spec:     sc.Summary,
				Roles:    topo,
				Params:   sc.Vars,
			})
		}
		tags := append([]string(nil), m.Tags...)
		hasV2Tag := false
		for _, t := range tags {
			if strings.Contains(strings.ToLower(t), "ansible 2.0") || strings.Contains(t, "原生 Ansible") {
				hasV2Tag = true
				break
			}
		}
		if !hasV2Tag {
			tags = append(tags, "Ansible 2.0")
		}
		includes := []mwpack.NamedText{
			{
				Name: tr(lang, "标准 Ansible 工程", "Standard Ansible Project"),
				Text: tr(lang, "完整 inventory/hosts.yml、group_vars/all.yml、ansible.cfg 与原生 Role/Playbook，无私有 DSL 魔改，可脱离平台独立运行。", "Standard inventory/hosts.yml, group_vars/all.yml, ansible.cfg & native Roles/Playbooks — runnable standalone without vendor lock-in."),
			},
			{
				Name: tr(lang, "全生命周期剧本", "Full Lifecycle Playbooks"),
				Text: fmt.Sprintf(tr(lang, "包含 %d 个可执行 Playbook 步骤（部署、健康验收、只读探测与清理），支持 --check --diff 真实差异预演。", "Includes %d executable playbook steps (deploy, verify, probe & cleanup) with real --check --diff dry-run."), len(rep.Steps)),
			},
			{
				Name: tr(lang, "离线包与自动化双通道", "Offline & Automated Delivery"),
				Text: tr(lang, "一键生成带 SHA256SUMS 的离线 .tar.gz 工程包，也可通过执行中心在控制节点全自动编排并实时回传日志。", "Generates SHA256SUMS-verified offline .tar.gz bundles or dispatches automated runs via Execution Center with live log streaming."),
			},
		}
		caps := []mwpack.NamedText{
			{
				Name: tr(lang, "动态变量识别", "AST Dynamic Variables"),
				Text: fmt.Sprintf(tr(lang, "自动从 meta/argument_specs.yml、defaults/main.yml、when 与模板条件解析 %d 项参数，修改 Ansible 文件即自动反映在交付表单。", "Automatically inspects %d variables & conditional guards from argument_specs, defaults, when clauses & templates."), len(rep.Vars)),
			},
			{
				Name: tr(lang, "来源形态", "Asset Source"),
				Text: fmt.Sprintf("%s (%s)", rep.AssetKind, src),
			},
		}
		info := mwpack.Info{
			DeliveryModes: v2DeliveryModes(m),
			Name:          name,
			Short:         strings.TrimSuffix(name, "-native"),
			Title:         title,
			Category:      firstNonEmptyStr(m.Category, tr(lang, "中间件", "Middleware")),
			Summary:       summary,
			Tags:          tags,
			Icon:          firstNonEmptyStr(m.Icon, "server"),
			Color:         firstNonEmptyStr(m.Color, "blue"),
			Default:       ver,
			Versions:      []mwpack.VerInfo{ve.VerInfo},
			Roles:         v2RolesFromManifest(m, lang),
			Detail: &mwpack.Detail{
				Tagline:      summary,
				Includes:     includes,
				Capabilities: caps,
				Presets:      presets,
			},
		}
		out = append(out, catalogEntry{
			Info:                info,
			Versions:            []versionEntry{ve},
			Platform:            "Ubuntu 24.04 / EL9 / Kylin V10",
			Available:           rep.Valid,
			DeploymentAvailable: rep.Valid,
			Materials:           []catalogMaterial{},
			Plans:               plans,
		})
	}
	return out
}

// ansibleV2Schema builds a full mwpack.Schema directly from an Ansible 2.0 component's AST inspection,
// powering Wizard.tsx's classic delivery form AND FormChat AI automatically with zero hardcoding.
func (s *storeServer) ansibleV2Schema(name, lang string) (*mwpack.Schema, bool) {
	files, src, ok := s.loadV2Component(name)
	if !ok {
		return nil, false
	}
	rep := ansiblev2.Inspect(files, name, src)
	m := rep.Manifest
	ver := firstNonEmptyStr(m.Version, "1.0.0")
	plats := v2SupportedPlatforms()
	title := m.Title
	if lang == langEnUS && m.TitleEn != "" {
		title = m.TitleEn
	}

	groupOrder := []string{"basic", "network", "ha", "security", "tuning", "baseline", "advanced"}
	groupMeta := map[string]mwpack.Group{}
	var customGroups []string
	params := make([]mwpack.Param, 0, len(rep.Vars))

	for _, v := range rep.Vars {
		gid := firstNonEmptyStr(v.Group, "basic")
		if _, exists := groupMeta[gid]; !exists {
			gl := v.GroupLabel
			if lang == langEnUS && v.GroupLabelEn != "" {
				gl = v.GroupLabelEn
			}
			if gl == "" {
				gl = gid
			}
			groupMeta[gid] = mwpack.Group{
				ID:    gid,
				Label: gl,
				Tab:   v2GroupToTab(gid),
			}
			inStd := false
			for _, sg := range groupOrder {
				if sg == gid {
					inStd = true
					break
				}
			}
			if !inStd {
				customGroups = append(customGroups, gid)
			}
		}
		lbl := v.Label
		if lang == langEnUS && v.LabelEn != "" {
			lbl = v.LabelEn
		}
		if lbl == "" {
			lbl = v.Key
		}
		var minAny, maxAny any
		if v.Min != nil {
			minAny = *v.Min
		}
		if v.Max != nil {
			maxAny = *v.Max
		}
		ptype := v2VarTypeToParamType(v)
		unit := v.Unit
		if ptype == "port" && unit == "" {
			unit = "TCP/UDP"
		}
		params = append(params, mwpack.Param{
			Key:      v.Key,
			Group:    gid,
			Label:    lbl,
			Type:     ptype,
			Default:  v.Default,
			Min:      minAny,
			Max:      maxAny,
			Unit:     unit,
			Options:  v.Choices,
			Hint:     v.Description,
			Required: v.Required,
			Advanced: v.Advanced,
			When:     v2WhenToSchemaWhen(v.When),
		})
	}

	groups := make([]mwpack.Group, 0, len(groupMeta))
	for _, gid := range append(groupOrder, customGroups...) {
		if g, okG := groupMeta[gid]; okG {
			groups = append(groups, g)
		}
	}

	presets := make([]mwpack.Preset, 0, len(m.Schemes))
	for idx, sc := range m.Schemes {
		scTitle := sc.Title
		if lang == langEnUS && sc.TitleEn != "" {
			scTitle = sc.TitleEn
		}
		tag := ""
		if idx == 0 {
			tag = tr(lang, "推荐", "Recommended")
		}
		presets = append(presets, mwpack.Preset{
			Contract: v2InferSeriesContract(name, sc, m),
			ID:       sc.ID,
			Name:     scTitle,
			Tag:      tag,
			Spec:     sc.Summary,
			Roles:    v2BuildTopologyFromScheme(m, sc),
			Params:   sc.Vars,
		})
	}

	sc := &mwpack.Schema{
		DeliveryModes:     v2DeliveryModes(m),
		Component:         name,
		Title:             title,
		Version:           ver,
		Status:            "published",
		Platforms:         plats,
		VerifiedPlatforms: plats,
		Roles:             v2RolesFromManifest(m, lang),
		Groups:            groups,
		Params:            params,
		Presets:           presets,
	}
	return sc, true
}

// resolveAnsibleV2Deployment validates and resolves a Wizard.tsx Deployment targeting an Ansible 2.0 component.
func (s *storeServer) resolveAnsibleV2Deployment(d *mwpack.Deployment, lang string) (*mwpack.PlanView, bool) {
	if d == nil || len(d.Instances) == 0 {
		return nil, false
	}
	compName := strings.TrimSpace(d.Instances[0].Component)
	files, src, ok := s.loadV2Component(compName)
	if !ok {
		return nil, false
	}
	rep := ansiblev2.Inspect(files, compName, src)
	m := rep.Manifest
	inst := d.Instances[0]

	var issues []mwpack.Problem
	addErr := func(p, msg string) {
		issues = append(issues, mwpack.Problem{Severity: "error", Path: p, Message: msg})
	}
	addWarn := func(p, msg string) {
		issues = append(issues, mwpack.Problem{Severity: "warning", Path: p, Message: msg})
	}

	cid := strings.TrimSpace(d.ID)
	if cid == "" {
		addErr("id", tr(lang, "请填写集群标识（小写字母开头，可含数字与短横线）", "Please enter a cluster ID (lowercase letters, digits, hyphens)"))
	} else if !v2BridgeClusterIDRe.MatchString(cid) {
		addErr("id", tr(lang, "集群标识须以小写字母开头，仅含小写字母、数字和短横线", "Cluster ID must start with a lowercase letter and use only a-z, 0-9, '-'"))
	}

	if len(d.Hosts) == 0 {
		addErr("hosts", tr(lang, "请至少配置 1 台目标主机", "Please configure at least 1 target host"))
	}
	seenHostName := map[string]bool{}
	seenHostIP := map[string]bool{}
	hostNames := make([]string, 0, len(d.Hosts))
	for i, h := range d.Hosts {
		hn := strings.TrimSpace(h.Name)
		hip := strings.TrimSpace(h.IP)
		if hn == "" {
			addErr(fmt.Sprintf("hosts[%d].name", i), tr(lang, "主机名不能为空", "Host name is required"))
		} else if seenHostName[hn] {
			addErr(fmt.Sprintf("hosts[%d].name", i), tr(lang, "主机名重复："+hn, "Duplicate host name: "+hn))
		} else {
			seenHostName[hn] = true
			hostNames = append(hostNames, hn)
		}
		if hip == "" {
			addErr(fmt.Sprintf("hosts[%d].ip", i), tr(lang, fmt.Sprintf("请填写机器 %s 的 IPv4 地址", firstNonEmptyStr(hn, fmt.Sprintf("#%d", i+1))), fmt.Sprintf("Enter IPv4 address for %s", firstNonEmptyStr(hn, fmt.Sprintf("#%d", i+1)))))
		} else if ip := net.ParseIP(hip); ip == nil || ip.To4() == nil {
			addErr(fmt.Sprintf("hosts[%d].ip", i), tr(lang, "无效的 IPv4 地址："+hip, "Invalid IPv4 address: "+hip))
		} else if seenHostIP[hip] {
			addErr(fmt.Sprintf("hosts[%d].ip", i), tr(lang, "IP 地址重复："+hip, "Duplicate IP address: "+hip))
		} else {
			seenHostIP[hip] = true
		}
	}

	placement := map[string][]string{}
	for g, hs := range inst.Placement {
		for _, hn := range hs {
			if seenHostName[hn] {
				placement[g] = append(placement[g], hn)
			}
		}
	}
	knownGroups := map[string]bool{}
	roleTitles := map[string]string{}
	for _, g := range m.Groups {
		knownGroups[g.Name] = true
		roleTitles[g.Name] = firstNonEmptyStr(g.Title, g.Name)
		if lang == langEnUS && g.TitleEn != "" {
			roleTitles[g.Name] = g.TitleEn
		}
		cnt := len(placement[g.Name])
		if g.Min > 0 && cnt < g.Min {
			addErr(fmt.Sprintf("instances[%s].placement.%s", inst.ID, g.Name),
				fmt.Sprintf(tr(lang, "分组 %s 至少需要 %d 台主机（当前 %d 台）", "Group %s requires at least %d host(s) (currently %d)"), roleTitles[g.Name], g.Min, cnt))
		}
		if g.Max > 0 && cnt > g.Max {
			addErr(fmt.Sprintf("instances[%s].placement.%s", inst.ID, g.Name),
				fmt.Sprintf(tr(lang, "分组 %s 最多允许 %d 台主机（当前 %d 台）", "Group %s allows at most %d host(s) (currently %d)"), roleTitles[g.Name], g.Max, cnt))
		}
	}

	resolvedParams := map[string]any{}
	for _, v := range rep.Vars {
		if inst.Params != nil {
			if val, exists := inst.Params[v.Key]; exists {
				resolvedParams[v.Key] = val
				continue
			}
		}
		if v.Default != nil {
			resolvedParams[v.Key] = v.Default
		}
	}

	visible := map[string]bool{}
	for _, v := range rep.Vars {
		vis := evalV2WhenServer(v.When, resolvedParams, placement)
		visible[v.Key] = vis
		if !vis {
			continue
		}
		val := resolvedParams[v.Key]
		sVal := ""
		if val != nil {
			sVal = strings.TrimSpace(fmt.Sprintf("%v", val))
		}
		if v.Required && sVal == "" {
			addErr(fmt.Sprintf("instances[%s].params.%s", inst.ID, v.Key),
				fmt.Sprintf(tr(lang, "请填写必填参数 %s", "Required parameter %s is missing"), firstNonEmptyStr(v.Label, v.Key)))
		}
		if v.Type == "cidr" && sVal != "" {
			if _, _, err := net.ParseCIDR(sVal); err != nil {
				addErr(fmt.Sprintf("instances[%s].params.%s", inst.ID, v.Key),
					tr(lang, "请输入合法的 CIDR 网段，例如 10.0.0.0/24", "Enter a valid CIDR block, e.g. 10.0.0.0/24"))
			}
		}
	}

	if d.DeliveryMode == "automatic" && d.ExecutionHost == nil && strings.TrimSpace(d.Controller) == "" && len(hostNames) > 0 {
		addWarn("controller", tr(lang, "自动编排模式下建议指定控制执行节点（也可在生成后绑定）", "Select an execution controller for automated runs"))
	}

	controller := strings.TrimSpace(d.Controller)
	if d.ExecutionHost != nil && strings.TrimSpace(d.ExecutionHost.Name) != "" {
		controller = strings.TrimSpace(d.ExecutionHost.Name)
	} else if controller == "" && len(hostNames) > 0 {
		controller = hostNames[0]
	}

	// Match active scheme for summary card
	var matchedScheme *mwpack.SchemeSummary
	var matchedContract *mwpack.SeriesContract
	for _, sc := range m.Schemes {
		okMatch := true
		for gName, want := range sc.GroupCounts {
			if len(placement[gName]) != want {
				okMatch = false
				break
			}
		}
		if okMatch {
			for vk, vv := range sc.Vars {
				if fmt.Sprintf("%v", resolvedParams[vk]) != fmt.Sprintf("%v", vv) {
					okMatch = false
					break
				}
			}
		}
		if okMatch {
			matchedContract = v2InferSeriesContract(compName, sc, m)
			scName := sc.Title
			if lang == langEnUS && sc.TitleEn != "" {
				scName = sc.TitleEn
			}
			matchedScheme = &mwpack.SchemeSummary{
				ID:    sc.ID,
				Name:  scName,
				Nodes: len(hostNames),
			}
			break
		}
	}

	// Build preview phases from actual Ansible Playbook steps
	var deploySteps, testSteps, cleanupSteps []*mwpack.PlanStep
	for _, st := range rep.Steps {
		stepHosts, active := resolveV2StepHosts(st.Hosts, placement, knownGroups, hostNames)
		if !active {
			continue
		}
		ps := &mwpack.PlanStep{
			ID:        st.ID,
			Section:   st.Phase,
			Phase:     st.Phase,
			Instance:  compName,
			Title:     st.Title,
			Effect:    st.Effect,
			Hosts:     stepHosts,
			Playbook:  st.Playbook,
			Command:   st.Command,
			Automatic: true,
		}
		switch st.Phase {
		case "verify", "probe":
			testSteps = append(testSteps, ps)
		case "cleanup":
			cleanupSteps = append(cleanupSteps, ps)
		default:
			deploySteps = append(deploySteps, ps)
		}
	}
	var phases []mwpack.PhaseView
	if len(deploySteps) > 0 {
		phases = append(phases, mwpack.PhaseView{Phase: "deploy", Title: tr(lang, "原生 Ansible 部署", "Native Ansible Deploy"), Steps: deploySteps})
	}
	if len(testSteps) > 0 {
		phases = append(phases, mwpack.PhaseView{Phase: "tests", Title: tr(lang, "验收与探测", "Verify & Probe"), Steps: testSteps})
	}
	if len(cleanupSteps) > 0 {
		phases = append(phases, mwpack.PhaseView{Phase: "cleanup", Title: tr(lang, "清理回收", "Cleanup"), Steps: cleanupSteps})
	}

	title := m.Title
	if lang == langEnUS && m.TitleEn != "" {
		title = m.TitleEn
	}
	hasErr := false
	for _, is := range issues {
		if is.Severity == "error" {
			hasErr = true
			break
		}
	}
	if issues == nil {
		issues = []mwpack.Problem{}
	}
	pv := &mwpack.PlanView{
		ExecutionHost: d.ExecutionHost,
		OK:            !hasErr,
		Issues:        issues,
		Controller:    controller,
		Platforms:     v2SupportedPlatforms(),
		Inputs:        []mwpack.InputReq{},
		Artifacts:     []mwpack.ArtifactView{},
		Phases:        phases,
		Instances: []mwpack.InstanceView{
			{
				ID:         firstNonEmptyStr(inst.ID, compName),
				Component:  compName,
				Title:      title,
				Version:    firstNonEmptyStr(inst.Version, m.Version, "1.0.0"),
				Status:     "published",
				Roles:      placement,
				RoleTitles: roleTitles,
				Flows:      v2InferFlows(placement, resolvedParams, lang),
				Hosts:      hostNames,
				Params:     resolvedParams,
				Visible:    visible,
				Scheme:     matchedScheme,
				Contract:   matchedContract,
			},
		},
	}
	return pv, true
}

// createAnsibleV2JobFromDeployment handles POST /api/jobs seamlessly when Wizard.tsx submits
// a deployment targeting any Ansible 2.0 component, returning the created storeJob JSON.
func (s *storeServer) createAnsibleV2JobFromDeployment(w http.ResponseWriter, r *http.Request, session storeSession, d *mwpack.Deployment, revises string) bool {
	if d == nil || len(d.Instances) == 0 {
		return false
	}
	compName := strings.TrimSpace(d.Instances[0].Component)
	if !s.isAnsibleV2Component(compName) {
		return false
	}
	inst := d.Instances[0]
	// Map mwpack.Deployment hosts + placement -> ansiblev2.RenderHost[]
	groupsByHost := map[string][]string{}
	for g, hs := range inst.Placement {
		for _, hn := range hs {
			groupsByHost[hn] = append(groupsByHost[hn], g)
		}
	}
	rHosts := make([]ansiblev2.RenderHost, 0, len(d.Hosts))
	for _, h := range d.Hosts {
		rHosts = append(rHosts, ansiblev2.RenderHost{
			Name:   strings.TrimSpace(h.Name),
			IP:     strings.TrimSpace(h.IP),
			Groups: groupsByHost[strings.TrimSpace(h.Name)],
		})
	}
	vars := map[string]any{}
	for k, v := range inst.Params {
		vars[k] = v
	}
	var offRepo *ansiblev2.OfflineRepoConfig
	aptM, _ := vars["delivery_studio_apt_mirror"].(string)
	rpmM, _ := vars["delivery_studio_rpm_mirror"].(string)
	if strings.TrimSpace(aptM) != "" || strings.TrimSpace(rpmM) != "" {
		offRepo = &ansiblev2.OfflineRepoConfig{
			APTURL:      strings.TrimSpace(aptM),
			RPMURL:      strings.TrimSpace(rpmM),
			DisableBase: asBoolVal(vars["delivery_studio_disable_base_repos"]),
		}
		delete(vars, "delivery_studio_apt_mirror")
		delete(vars, "delivery_studio_rpm_mirror")
		delete(vars, "delivery_studio_disable_base_repos")
	}

	req := ansibleV2DeliverInput{
		RenderRequest: ansiblev2.RenderRequest{
			ClusterID:    strings.TrimSpace(d.ID),
			Platform:     firstNonEmptyStr(d.Platform, "ubuntu-24.04-amd64"),
			DeliveryMode: firstNonEmptyStr(d.DeliveryMode, "offline"),
			Controller:   strings.TrimSpace(d.Controller),
			Hosts:        rHosts,
			Vars:         vars,
			OfflineRepo:  offRepo,
		},
		ExecutionHost: d.ExecutionHost,
		Revises:       strings.TrimSpace(revises),
	}
	job, _, code, errMsg := s.executeAnsibleV2Deliver(r, session, compName, req)
	if code != 0 {
		s.fail(w, code, errMsg)
		return true
	}
	s.writeJSON(w, 201, job)
	return true
}

// ansibleV2ComponentBrief describes any Ansible 2.0 component for FormChat AI (describe_component tool),
// so conversational form-filling inside Wizard.tsx works 100% natively for built-in and imported 2.0 assets.
func (s *storeServer) ansibleV2ComponentBrief(name string) (string, *mwpack.Schema, bool) {
	sc, ok := s.ansibleV2Schema(name, langZhCN)
	if !ok {
		return "", nil, false
	}
	files, src, _ := s.loadV2Component(name)
	rep := ansiblev2.Inspect(files, name, src)
	m := rep.Manifest

	var b strings.Builder
	fmt.Fprintf(&b, "原生 Ansible 2.0 组件 %s（%s），版本 %s（形态：%s，来源：%s）\n", name, m.Title, sc.Version, rep.AssetKind, src)
	fmt.Fprintf(&b, "支持的系统：%s\n", strings.Join(sc.Platforms, "、"))
	if m.Summary != "" {
		b.WriteString(m.Summary + "\n")
	}
	b.WriteString("该组件 100% 由标准 Ansible Playbook/Role 驱动，无私有 mw.* 变量；以下分组名直接对应 inventory/hosts.yml 的主机组，变量名直接对应 group_vars/all.yml：\n")
	if len(sc.Roles) > 0 {
		b.WriteString("Ansible 主机分组（placement 的键，值是机器名列表）：\n")
		for _, r := range sc.Roles {
			max := "不限"
			if r.Max > 0 {
				max = fmt.Sprint(r.Max)
			}
			fmt.Fprintf(&b, "- %s（%s）：至少 %d 台，最多 %s，默认 %d 台", r.Name, r.Title, r.Min, max, r.Default)
			if r.Exclusive {
				b.WriteString("，互斥角色")
			}
			b.WriteString("\n")
		}
	}
	groups := map[string]string{}
	for _, g := range sc.Groups {
		groups[g.ID] = g.Label
	}
	b.WriteString("标准 Ansible 变量（params 的键；未修改项自动沿用 defaults/main.yml 默认值）：\n")
	for _, p := range sc.Params {
		fmt.Fprintf(&b, "- %s（%s", p.Key, p.Label)
		if gl := groups[p.Group]; gl != "" {
			b.WriteString("，" + gl)
		}
		fmt.Fprintf(&b, "）类型 %s", p.Type)
		if p.Default != nil {
			fmt.Fprintf(&b, "，默认 %v", p.Default)
		}
		if len(p.Options) > 0 {
			fmt.Fprintf(&b, "，可选 %s", strings.Join(p.Options, "/"))
		}
		if p.Unit != "" {
			fmt.Fprintf(&b, "，单位 %s", p.Unit)
		}
		if p.Required {
			b.WriteString("，必填")
		}
		if p.When != "" {
			fmt.Fprintf(&b, "，条件显现：%s", p.When)
		}
		if p.Hint != "" {
			fmt.Fprintf(&b, "。%s", p.Hint)
		}
		b.WriteString("\n")
	}
	if len(sc.Presets) > 0 {
		b.WriteString("推荐架构方案：\n")
		for _, pr := range sc.Presets {
			var rs []string
			for _, rc := range pr.Roles {
				rs = append(rs, fmt.Sprintf("%s×%d", rc.Role, rc.Count))
			}
			fmt.Fprintf(&b, "- %s（%s）：%s；%s\n", pr.Name, pr.ID, strings.Join(rs, "，"), pr.Spec)
		}
	}
	return b.String(), sc, true
}

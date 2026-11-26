package ansiblev2

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// NormalizeFiles strips redundant single root folder prefixes (e.g. GitHub zipball roots),
// normalizes slash separators, and removes OS junk entries (__MACOSX, .DS_Store, .git/*).
func NormalizeFiles(raw map[string][]byte) map[string][]byte {
	cleaned := make(map[string][]byte, len(raw))
	for k, v := range raw {
		p := strings.TrimPrefix(path.Clean(strings.ReplaceAll(strings.TrimSpace(k), "\\", "/")), "/")
		if p == "" || p == "." || strings.HasPrefix(p, "..") {
			continue
		}
		if strings.HasPrefix(p, ".git/") || p == ".git" ||
			strings.HasPrefix(p, "__MACOSX/") ||
			strings.HasSuffix(p, "/.DS_Store") || p == ".DS_Store" {
			continue
		}
		cp := make([]byte, len(v))
		copy(cp, v)
		cleaned[p] = cp
	}
	if len(cleaned) == 0 {
		return cleaned
	}
	// Strip single common top-level directory (unless it is a standard Ansible dir like roles/ or playbooks/)
	var top string
	allSameTop := true
	for p := range cleaned {
		idx := strings.IndexByte(p, '/')
		if idx <= 0 {
			allSameTop = false
			break
		}
		seg := p[:idx]
		if top == "" {
			top = seg
		} else if top != seg {
			allSameTop = false
			break
		}
	}
	standardTops := map[string]bool{
		"roles": true, "playbooks": true, "tasks": true, "defaults": true, "vars": true,
		"templates": true, "files": true, "handlers": true, "meta": true,
		"group_vars": true, "host_vars": true, "inventory": true, "plugins": true,
		"callback_plugins": true, "library": true,
	}
	if allSameTop && top != "" && !standardTops[strings.ToLower(top)] {
		prefix := top + "/"
		stripped := make(map[string][]byte, len(cleaned))
		for p, v := range cleaned {
			stripped[strings.TrimPrefix(p, prefix)] = v
		}
		return stripped
	}
	return cleaned
}

// DetectAssetKind classifies any normalized Ansible file tree into one of the 4 standard kinds.
func DetectAssetKind(files map[string][]byte) AssetKind {
	if _, ok := files["galaxy.yml"]; ok {
		return AssetAnsibleCollection
	}
	if _, ok := files["galaxy.yaml"]; ok {
		return AssetAnsibleCollection
	}
	if hasAnyPrefix(files, "playbooks/") || hasRootPlaybook(files) {
		if len(files) == 1 || (len(files) == 2 && hasManifest(files)) {
			// A single YAML playbook file (optionally with delivery-studio.yaml)
			for p := range files {
				if p != ManifestFileName && isYAML(p) && !strings.Contains(p, "/") {
					return AssetSinglePlaybook
				}
			}
		}
		return AssetPlaybookProject
	}
	if hasAnyPrefix(files, "tasks/") || hasAnyPrefix(files, "defaults/") || hasAnyPrefix(files, "meta/") {
		return AssetAnsibleRole
	}
	if hasAnyPrefix(files, "roles/") {
		return AssetPlaybookProject
	}
	// Check if there is a single YAML file anywhere that parses as a playbook
	yamlCount := 0
	for p := range files {
		if p != ManifestFileName && isYAML(p) {
			yamlCount++
		}
	}
	if yamlCount == 1 {
		return AssetSinglePlaybook
	}
	return AssetPlaybookProject
}

// WrapIntoRunnableProject normalizes standalone roles or single playbook files into a
// clean, standard runnable Ansible project structure WITHOUT altering user code.
// Returns (normalizedFiles, assetKind, inferredRoleName).
func WrapIntoRunnableProject(raw map[string][]byte, hintName string) (map[string][]byte, AssetKind, string) {
	files := NormalizeFiles(raw)
	kind := DetectAssetKind(files)
	slug := SanitizeName(hintName)

	switch kind {
	case AssetSinglePlaybook:
		out := make(map[string][]byte, len(files)+1)
		var pbFile string
		for p, data := range files {
			if p == ManifestFileName {
				out[p] = data
				continue
			}
			if isYAML(p) && pbFile == "" {
				pbFile = p
			}
			if !strings.Contains(p, "/") && isYAML(p) {
				out["playbooks/deploy.yml"] = data
			} else {
				out[p] = data
			}
		}
		if pbFile != "" && slug == "ansible-app" {
			slug = SanitizeName(path.Base(pbFile))
		}
		return out, kind, slug

	case AssetAnsibleRole:
		// Wrap standalone role tree under roles/<roleName>/ and add a clean standard playbooks/deploy.yml
		roleName := slug
		if rawMeta, ok := files["meta/main.yml"]; ok {
			if n := galaxyRoleName(rawMeta); n != "" {
				roleName = SanitizeName(n)
			}
		} else if rawMeta, ok := files["meta/main.yaml"]; ok {
			if n := galaxyRoleName(rawMeta); n != "" {
				roleName = SanitizeName(n)
			}
		}
		out := make(map[string][]byte, len(files)+2)
		for p, data := range files {
			if p == ManifestFileName || p == "README.md" || p == "LICENSE" || p == "requirements.yml" || p == "requirements.yaml" {
				out[p] = data
				continue
			}
			out["roles/"+roleName+"/"+p] = data
		}
		deployPlay := fmt.Sprintf(`---
- name: Deploy %s
  hosts: all
  become: true
  roles:
    - role: %s
`, roleName, roleName)
		out["playbooks/deploy.yml"] = []byte(deployPlay)
		return out, kind, roleName

	case AssetAnsibleCollection:
		// Collections already contain roles/ and optionally playbooks/; synthesize playbooks/deploy.yml if absent.
		out := cloneFiles(files)
		playbooks := discoverPlaybooks(out)
		if len(playbooks) == 0 {
			roles := discoverRoles(out)
			if len(roles) > 0 {
				var b strings.Builder
				b.WriteString("---\n- name: Deploy collection roles\n  hosts: all\n  become: true\n  roles:\n")
				for _, r := range roles {
					b.WriteString("    - role: " + r + "\n")
				}
				out["playbooks/deploy.yml"] = []byte(b.String())
			}
		}
		return out, kind, slug

	default:
		// Playbook project: if roles exist without any playbook, synthesize a deploy playbook.
		out := cloneFiles(files)
		if len(discoverPlaybooks(out)) == 0 {
			roles := discoverRoles(out)
			if len(roles) > 0 {
				var b strings.Builder
				b.WriteString("---\n- name: Deploy roles\n  hosts: all\n  become: true\n  roles:\n")
				for _, r := range roles {
					b.WriteString("    - role: " + r + "\n")
				}
				out["playbooks/deploy.yml"] = []byte(b.String())
			}
		}
		return out, kind, slug
	}
}

// Inspect analyzes any Ansible file tree (raw or normalized), auto-extracts playbooks,
// inventory host groups, native argument_specs + defaults + group_vars variables,
// OS packages, and validation problems, and produces a ready-to-use Manifest.
func Inspect(raw map[string][]byte, hintName, source string) InspectionReport {
	files, kind, inferredName := WrapIntoRunnableProject(raw, hintName)
	return InspectNormalized(files, kind, inferredName, source)
}

// InspectNormalized inspects an already normalized/wrapped Ansible file tree.
func InspectNormalized(files map[string][]byte, kind AssetKind, hintName, source string) InspectionReport {
	playbooks := discoverPlaybooks(files)
	roles := discoverRoles(files)
	reqs := parseRequirements(files)

	// Parse existing delivery-studio.yaml if present
	var existingManifest Manifest
	hasExisting := false
	var problems []Problem
	if rawM, ok := files[ManifestFileName]; ok && len(strings.TrimSpace(string(rawM))) > 0 {
		parsed, err := ParseManifest(rawM)
		if err != nil {
			problems = append(problems, Problem{Severity: "error", Path: ManifestFileName, Message: err.Error()})
		} else {
			existingManifest = parsed
			hasExisting = true
		}
	}

	// Read galaxy.yml if present for rich metadata
	galaxyMeta := parseGalaxyYAML(files)

	// Pick entrypoints
	ep := existingManifest.Entrypoints
	if ep.Deploy == "" {
		ep.Deploy = pickEntryPlaybook(playbooks, []string{"playbooks/deploy.yml", "playbooks/deploy.yaml", "playbooks/site.yml", "site.yml", "deploy.yml", "main.yml", "playbook.yml"})
		if ep.Deploy == "" && len(playbooks) > 0 {
			ep.Deploy = playbooks[0]
		}
	}
	if ep.Verify == "" {
		ep.Verify = pickEntryPlaybook(playbooks, []string{"playbooks/verify.yml", "playbooks/verify.yaml", "playbooks/test.yml", "verify.yml", "test.yml"})
	}
	if ep.Probe == "" {
		ep.Probe = pickEntryPlaybook(playbooks, []string{"playbooks/probe.yml", "playbooks/probe.yaml", "playbooks/inspect.yml", "probe.yml"})
	}
	if ep.Cleanup == "" {
		ep.Cleanup = pickEntryPlaybook(playbooks, []string{"playbooks/cleanup.yml", "playbooks/cleanup.yaml", "cleanup.yml"})
	}

	// Parse plays, inventory groups, and steps across entry playbooks
	steps, discoveredGroups, playProblems := extractPlaysAndSteps(files, ep)
	problems = append(problems, playProblems...)

	// Extract variables: argument_specs.yml -> defaults/main.yml -> group_vars/all.yml -> manifest overrides
	extractedVars := extractAllVars(files)
	mergedVars := mergeVarSpecs(extractedVars, existingManifest.Vars)

	// Extract OS packages statically from apt/yum/dnf/package tasks
	discoveredPkgs := extractPackages(files)
	mergedPkgs := mergePackageHints(discoveredPkgs, existingManifest.Packages)

	// Build final manifest
	m := existingManifest
	m.Schema = SchemaVersion
	if m.Name == "" {
		if galaxyMeta.Name != "" {
			m.Name = SanitizeName(galaxyMeta.Name)
		} else if hintName != "" {
			m.Name = SanitizeName(hintName)
		} else {
			m.Name = "ansible-app"
		}
	}
	if m.Title == "" {
		if galaxyMeta.Name != "" {
			m.Title = strings.Title(strings.ReplaceAll(galaxyMeta.Name, "_", " "))
		} else {
			m.Title = strings.Title(strings.ReplaceAll(m.Name, "-", " "))
		}
	}
	if m.Category == "" {
		m.Category = inferCategory(m.Name, m.Title, roles, mergedPkgs)
	}
	if m.Version == "" {
		if galaxyMeta.Version != "" {
			m.Version = galaxyMeta.Version
		} else {
			m.Version = "1.0.0"
		}
	}
	if m.Summary == "" {
		if galaxyMeta.Description != "" {
			m.Summary = galaxyMeta.Description
		} else {
			m.Summary = fmt.Sprintf("标准 Ansible 2.0 组件（%s），支持离线与自动化交付。", kindLabelZh(kind))
		}
	}
	if m.AssetKind == "" {
		m.AssetKind = kind
	}
	if m.Source == "" && source != "" {
		m.Source = source
	}
	if len(m.DeliveryModes) == 0 {
		m.DeliveryModes = []string{"offline", "automatic"}
	}
	m.Entrypoints = ep
	if len(m.Groups) == 0 {
		m.Groups = discoveredGroups
	}
	if len(m.Groups) == 0 {
		m.Groups = []GroupSpec{{Name: "nodes", Title: "目标节点", TitleEn: "Target Hosts", Min: 1, DefaultCount: 1}}
	}
	if len(m.Vars) == 0 {
		// Keep auto-generated delivery-studio.yaml concise: embed up to 24 most relevant top-level vars if manifest is auto-generated
		if len(mergedVars) <= 24 {
			m.Vars = mergedVars
		} else {
			m.Vars = mergedVars[:24]
		}
	}
	if len(m.Packages) == 0 && len(mergedPkgs) > 0 {
		m.Packages = mergedPkgs
	}

	// Run full structural & security validation
	valProblems := Validate(files, m)
	problems = append(problems, valProblems...)

	manifestYAML, _ := MarshalManifest(m)
	valid := true
	for _, p := range problems {
		if p.Severity == "error" {
			valid = false
			break
		}
	}

	return InspectionReport{
		AssetKind:       m.AssetKind,
		Manifest:        m,
		ManifestYAML:    manifestYAML,
		ManifestAutoGen: !hasExisting,
		Playbooks:       playbooks,
		Roles:           roles,
		Requirements:    reqs,
		Steps:           steps,
		Vars:            mergedVars,
		Packages:        mergedPkgs,
		Problems:        problems,
		FileCount:       len(files),
		Valid:           valid,
	}
}

func kindLabelZh(k AssetKind) string {
	switch k {
	case AssetSinglePlaybook:
		return "单文件 Playbook"
	case AssetAnsibleRole:
		return "标准 Ansible Role"
	case AssetAnsibleCollection:
		return "标准 Ansible Collection"
	default:
		return "Ansible Playbook 工程"
	}
}

func isYAML(p string) bool {
	lp := strings.ToLower(p)
	return strings.HasSuffix(lp, ".yml") || strings.HasSuffix(lp, ".yaml")
}

func hasAnyPrefix(files map[string][]byte, prefix string) bool {
	for p := range files {
		if strings.HasPrefix(p, prefix) {
			return true
		}
	}
	return false
}

func hasManifest(files map[string][]byte) bool {
	_, ok := files[ManifestFileName]
	return ok
}

func hasRootPlaybook(files map[string][]byte) bool {
	for p, data := range files {
		if p == ManifestFileName || strings.Contains(p, "/") || !isYAML(p) {
			continue
		}
		lp := strings.ToLower(p)
		if lp == "galaxy.yml" || lp == "galaxy.yaml" || lp == "requirements.yml" || lp == "requirements.yaml" {
			continue
		}
		if looksLikePlaybook(data) {
			return true
		}
	}
	return false
}

func looksLikePlaybook(data []byte) bool {
	var plays []map[string]any
	if err := yaml.Unmarshal(data, &plays); err != nil || len(plays) == 0 {
		return false
	}
	for _, pl := range plays {
		if _, ok := pl["hosts"]; ok {
			return true
		}
		if _, ok := pl["import_playbook"]; ok {
			return true
		}
		if _, ok := pl["ansible.builtin.import_playbook"]; ok {
			return true
		}
	}
	return false
}

func discoverPlaybooks(files map[string][]byte) []string {
	var out []string
	for p, data := range files {
		if p == ManifestFileName || !isYAML(p) {
			continue
		}
		if strings.HasPrefix(p, "roles/") || strings.HasPrefix(p, "group_vars/") ||
			strings.HasPrefix(p, "host_vars/") || strings.HasPrefix(p, "inventory/") ||
			strings.HasPrefix(p, "meta/") || strings.HasPrefix(p, "defaults/") {
			continue
		}
		lp := strings.ToLower(path.Base(p))
		if lp == "galaxy.yml" || lp == "galaxy.yaml" || lp == "requirements.yml" || lp == "requirements.yaml" {
			continue
		}
		if strings.HasPrefix(p, "playbooks/") || looksLikePlaybook(data) {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

func discoverRoles(files map[string][]byte) []string {
	seen := map[string]bool{}
	for p := range files {
		if strings.HasPrefix(p, "roles/") {
			rest := strings.TrimPrefix(p, "roles/")
			if idx := strings.IndexByte(rest, '/'); idx > 0 {
				seen[rest[:idx]] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func pickEntryPlaybook(playbooks, preferred []string) string {
	set := map[string]bool{}
	for _, p := range playbooks {
		set[p] = true
	}
	for _, cand := range preferred {
		if set[cand] {
			return cand
		}
	}
	return ""
}

type galaxyInfo struct {
	Namespace   string
	Name        string
	Version     string
	Description string
}

func parseGalaxyYAML(files map[string][]byte) galaxyInfo {
	var raw []byte
	if b, ok := files["galaxy.yml"]; ok {
		raw = b
	} else if b, ok := files["galaxy.yaml"]; ok {
		raw = b
	}
	if len(raw) == 0 {
		return galaxyInfo{}
	}
	var doc struct {
		Namespace   string `yaml:"namespace"`
		Name        string `yaml:"name"`
		Version     string `yaml:"version"`
		Description string `yaml:"description"`
	}
	_ = yaml.Unmarshal(raw, &doc)
	return galaxyInfo{
		Namespace:   strings.TrimSpace(doc.Namespace),
		Name:        strings.TrimSpace(doc.Name),
		Version:     strings.TrimSpace(doc.Version),
		Description: strings.TrimSpace(doc.Description),
	}
}

func galaxyRoleName(raw []byte) string {
	var doc struct {
		GalaxyInfo struct {
			RoleName string `yaml:"role_name"`
		} `yaml:"galaxy_info"`
	}
	_ = yaml.Unmarshal(raw, &doc)
	return strings.TrimSpace(doc.GalaxyInfo.RoleName)
}

func parseRequirements(files map[string][]byte) []string {
	var raw []byte
	if b, ok := files["requirements.yml"]; ok {
		raw = b
	} else if b, ok := files["requirements.yaml"]; ok {
		raw = b
	}
	if len(raw) == 0 {
		return nil
	}
	var doc struct {
		Collections []any `yaml:"collections"`
		Roles       []any `yaml:"roles"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	var out []string
	for _, c := range doc.Collections {
		switch v := c.(type) {
		case string:
			out = append(out, "collection:"+v)
		case map[string]any:
			if name, _ := v["name"].(string); name != "" {
				ver, _ := v["version"].(string)
				if ver != "" {
					out = append(out, fmt.Sprintf("collection:%s@%s", name, ver))
				} else {
					out = append(out, "collection:"+name)
				}
			}
		}
	}
	for _, r := range doc.Roles {
		switch v := r.(type) {
		case string:
			out = append(out, "role:"+v)
		case map[string]any:
			name, _ := v["name"].(string)
			if name == "" {
				name, _ = v["src"].(string)
			}
			if name != "" {
				out = append(out, "role:"+name)
			}
		}
	}
	return out
}

func extractPlaysAndSteps(files map[string][]byte, ep Entrypoints) ([]PlayStep, []GroupSpec, []Problem) {
	var steps []PlayStep
	var problems []Problem
	groupOrder := []string{}
	groupSeen := map[string]bool{}
	addGroup := func(g string) {
		g = strings.TrimSpace(g)
		if g == "" || g == "all" || g == "localhost" || g == "127.0.0.1" || strings.Contains(g, "{{") {
			return
		}
		g = strings.TrimLeft(g, "!&")
		if g == "" || g == "all" || g == "localhost" {
			return
		}
		if !groupSeen[g] {
			groupSeen[g] = true
			groupOrder = append(groupOrder, g)
		}
	}

	phaseFiles := []struct {
		phase, pb, effect string
	}{
		{"deploy", ep.Deploy, "change"},
		{"verify", ep.Verify, "read-only"},
		{"probe", ep.Probe, "read-only"},
		{"cleanup", ep.Cleanup, "change"},
	}

	for _, pf := range phaseFiles {
		if pf.pb == "" {
			continue
		}
		raw, ok := files[pf.pb]
		if !ok {
			continue
		}
		var plays []map[string]any
		if err := yaml.Unmarshal(raw, &plays); err != nil {
			problems = append(problems, Problem{
				Severity: "error",
				Path:     pf.pb,
				Message:  fmt.Sprintf("Playbook YAML 语法错误: %v", err),
			})
			continue
		}
		for idx, pl := range plays {
			if imp, ok := pl["import_playbook"].(string); ok && imp != "" {
				steps = append(steps, PlayStep{
					ID:       fmt.Sprintf("%s-import-%d", pf.phase, idx+1),
					Phase:    pf.phase,
					Playbook: pf.pb,
					PlayName: "Import " + imp,
					Hosts:    "all",
					Title:    fmt.Sprintf("执行子剧本 %s", imp),
					Effect:   pf.effect,
					Command:  fmt.Sprintf("ansible-playbook -i inventory/hosts.yml %s", pf.pb),
				})
				continue
			}
			hostsExpr := stringifyHosts(pl["hosts"])
			for _, token := range splitHostPattern(hostsExpr) {
				addGroup(token)
			}
			playName, _ := pl["name"].(string)
			if strings.TrimSpace(playName) == "" {
				playName = fmt.Sprintf("%s #%d (%s)", path.Base(pf.pb), idx+1, hostsExpr)
			}
			tags := collectStringSlice(pl["tags"])
			// If a single-play deploy playbook has multiple distinct task-level tags, expose them as granular tags or keep play-level steps clean
			playTag := ""
			if len(tags) > 0 {
				playTag = tags[0]
			}
			cmd := fmt.Sprintf("ansible-playbook -i inventory/hosts.yml %s", pf.pb)
			if playTag != "" {
				cmd += " --tags " + playTag
			}
			steps = append(steps, PlayStep{
				ID:       fmt.Sprintf("%s-%d", pf.phase, idx+1),
				Phase:    pf.phase,
				Playbook: pf.pb,
				PlayName: playName,
				Hosts:    hostsExpr,
				Tag:      playTag,
				Title:    playName,
				Effect:   pf.effect,
				Command:  cmd,
			})
		}
	}

	groups := make([]GroupSpec, 0, len(groupOrder))
	for _, g := range groupOrder {
		groups = append(groups, GroupSpec{
			Name:         g,
			Title:        humanizeGroup(g),
			TitleEn:      strings.Title(strings.ReplaceAll(g, "_", " ")),
			Min:          1,
			DefaultCount: 1,
		})
	}
	return steps, groups, problems
}

func stringifyHosts(v any) string {
	switch h := v.(type) {
	case string:
		return strings.TrimSpace(h)
	case []any:
		parts := make([]string, 0, len(h))
		for _, item := range h {
			if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
				parts = append(parts, strings.TrimSpace(s))
			}
		}
		return strings.Join(parts, ",")
	default:
		return "all"
	}
}

func splitHostPattern(expr string) []string {
	f := func(r rune) bool { return r == ':' || r == ',' || r == ' ' || r == ';' }
	return strings.FieldsFunc(expr, f)
}

func humanizeGroup(g string) string {
	switch strings.ToLower(g) {
	case "primary", "master", "masters", "leader":
		return "主节点"
	case "replica", "replicas", "standby", "slave", "slaves":
		return "从节点"
	case "sentinel", "sentinels":
		return "哨兵节点"
	case "etcd", "dcs":
		return "协调集群 (etcd)"
	case "lb", "haproxy", "nginx", "loadbalancer", "proxy":
		return "负载均衡节点"
	case "nodes", "all", "servers", "targets":
		return "目标节点"
	default:
		return g
	}
}

func collectStringSlice(v any) []string {
	switch x := v.(type) {
	case string:
		if strings.TrimSpace(x) != "" {
			return []string{strings.TrimSpace(x)}
		}
	case []any:
		var out []string
		for _, item := range x {
			if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
				out = append(out, strings.TrimSpace(s))
			}
		}
		return out
	}
	return nil
}

// extractAllVars discovers variables natively from:
//  1. meta/argument_specs.yml (Ansible 2.11+ official role schema)
//  2. roles/*/defaults/main.yml
//  3. group_vars/all.yml
func extractAllVars(files map[string][]byte) []VarSpec {
	byKey := map[string]VarSpec{}
	order := []string{}
	record := func(v VarSpec) {
		if v.Key == "" {
			return
		}
		if prev, exists := byKey[v.Key]; exists {
			// Enrich defaults with argument_specs metadata if missing
			if prev.Description == "" && v.Description != "" {
				prev.Description = v.Description
			}
			if len(prev.Choices) == 0 && len(v.Choices) > 0 {
				prev.Choices = v.Choices
			}
			if prev.Default == nil && v.Default != nil {
				prev.Default = v.Default
			}
			if prev.Type == "" && v.Type != "" {
				prev.Type = v.Type
			}
			byKey[v.Key] = prev
			return
		}
		byKey[v.Key] = v
		order = append(order, v.Key)
	}

	paths := sortedKeys(files)

	// 1. Official Ansible meta/argument_specs.yml
	for _, p := range paths {
		base := strings.ToLower(path.Base(p))
		if base != "argument_specs.yml" && base != "argument_specs.yaml" {
			continue
		}
		var doc struct {
			ArgumentSpecs map[string]struct {
				Options map[string]struct {
					Type        string `yaml:"type"`
					Required    bool   `yaml:"required"`
					Default     any    `yaml:"default"`
					Choices     []any  `yaml:"choices"`
					Description any    `yaml:"description"`
				} `yaml:"options"`
			} `yaml:"argument_specs"`
		}
		if err := yaml.Unmarshal(files[p], &doc); err != nil {
			continue
		}
		entryNames := make([]string, 0, len(doc.ArgumentSpecs))
		for en := range doc.ArgumentSpecs {
			entryNames = append(entryNames, en)
		}
		sort.Strings(entryNames)
		for _, en := range entryNames {
			opts := doc.ArgumentSpecs[en].Options
			optKeys := make([]string, 0, len(opts))
			for ok := range opts {
				optKeys = append(optKeys, ok)
			}
			sort.Strings(optKeys)
			for _, k := range optKeys {
				spec := opts[k]
				choices := make([]string, 0, len(spec.Choices))
				for _, ch := range spec.Choices {
					choices = append(choices, fmt.Sprint(ch))
				}
				vtype := normalizeAnsibleType(spec.Type, k, spec.Default, choices)
				record(VarSpec{
					Key:         k,
					Label:       humanizeVarKey(k),
					Type:        vtype,
					Default:     spec.Default,
					Required:    spec.Required,
					Choices:     choices,
					Description: flattenDescription(spec.Description),
					Source:      "argument_specs",
				})
			}
		}
	}

	// 2. Role defaults/main.yml
	for _, p := range paths {
		lp := strings.ToLower(p)
		if !strings.HasSuffix(lp, "/defaults/main.yml") && !strings.HasSuffix(lp, "/defaults/main.yaml") &&
			lp != "defaults/main.yml" && lp != "defaults/main.yaml" {
			continue
		}
		var m map[string]any
		if err := yaml.Unmarshal(files[p], &m); err != nil {
			continue
		}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if strings.HasPrefix(k, "_") {
				continue
			}
			record(VarSpec{
				Key:     k,
				Label:   humanizeVarKey(k),
				Type:    normalizeAnsibleType("", k, m[k], nil),
				Default: m[k],
				Source:  "defaults",
			})
		}
	}

	// 3. group_vars/all.yml
	for _, p := range paths {
		lp := strings.ToLower(p)
		if lp != "group_vars/all.yml" && lp != "group_vars/all.yaml" && lp != "group_vars/all/main.yml" {
			continue
		}
		var m map[string]any
		if err := yaml.Unmarshal(files[p], &m); err != nil {
			continue
		}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if strings.HasPrefix(k, "_") || strings.HasPrefix(k, "ansible_") {
				continue
			}
			record(VarSpec{
				Key:     k,
				Label:   humanizeVarKey(k),
				Type:    normalizeAnsibleType("", k, m[k], nil),
				Default: m[k],
				Source:  "group_vars",
			})
		}
	}

	out := make([]VarSpec, 0, len(order))
	for _, k := range order {
		out = append(out, byKey[k])
	}
	return out
}

func normalizeAnsibleType(declared, key string, def any, choices []string) string {
	if len(choices) > 0 {
		return "select"
	}
	lk := strings.ToLower(key)
	if strings.Contains(lk, "password") || strings.Contains(lk, "secret") || strings.Contains(lk, "token") {
		return "secret"
	}
	switch strings.ToLower(strings.TrimSpace(declared)) {
	case "int", "integer", "float":
		if strings.HasSuffix(lk, "_port") || lk == "port" {
			return "port"
		}
		return "int"
	case "bool", "boolean":
		return "bool"
	case "list":
		return "list"
	case "dict":
		return "dict"
	case "str", "string", "path", "raw":
		return "string"
	}
	switch def.(type) {
	case bool:
		return "bool"
	case int, int64, float64:
		if strings.HasSuffix(lk, "_port") || lk == "port" {
			return "port"
		}
		return "int"
	case []any:
		return "list"
	case map[string]any:
		return "dict"
	default:
		return "string"
	}
}

func flattenDescription(v any) string {
	switch d := v.(type) {
	case string:
		return strings.TrimSpace(d)
	case []any:
		parts := make([]string, 0, len(d))
		for _, item := range d {
			if s := strings.TrimSpace(fmt.Sprint(item)); s != "" {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, " ")
	default:
		return ""
	}
}

func humanizeVarKey(k string) string {
	parts := strings.Split(k, "_")
	for i, p := range parts {
		if len(p) > 0 {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return strings.Join(parts, " ")
}

func mergeVarSpecs(discovered, declared []VarSpec) []VarSpec {
	byKey := map[string]VarSpec{}
	order := []string{}
	// Manifest-declared vars come first in declared order, enriched by discovered defaults/schema
	discMap := map[string]VarSpec{}
	for _, d := range discovered {
		discMap[d.Key] = d
	}
	for _, v := range declared {
		if d, ok := discMap[v.Key]; ok {
			if v.Type == "" {
				v.Type = d.Type
			}
			if v.Default == nil {
				v.Default = d.Default
			}
			if len(v.Choices) == 0 {
				v.Choices = d.Choices
			}
			if v.Description == "" {
				v.Description = d.Description
			}
			if v.Source == "" {
				v.Source = d.Source
			}
		} else if v.Source == "" {
			v.Source = "manifest"
		}
		if v.Label == "" {
			v.Label = humanizeVarKey(v.Key)
		}
		byKey[v.Key] = v
		order = append(order, v.Key)
	}
	for _, d := range discovered {
		if _, exists := byKey[d.Key]; !exists {
			byKey[d.Key] = d
			order = append(order, d.Key)
		}
	}
	out := make([]VarSpec, 0, len(order))
	for _, k := range order {
		out = append(out, byKey[k])
	}
	return out
}

var pkgModuleNames = map[string]bool{
	"apt": true, "ansible.builtin.apt": true,
	"yum": true, "ansible.builtin.yum": true,
	"dnf": true, "ansible.builtin.dnf": true,
	"package": true, "ansible.builtin.package": true,
}

var safePkgNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,80}$`)

// extractPackages statically scans Ansible playbooks & role tasks for apt/yum/dnf/package installs.
func extractPackages(files map[string][]byte) []PackageHint {
	seen := map[string]PackageHint{}
	for _, p := range sortedKeys(files) {
		if !isYAML(p) || p == ManifestFileName {
			continue
		}
		var list []map[string]any
		if err := yaml.Unmarshal(files[p], &list); err != nil {
			continue
		}
		walkTasksForPackages(list, p, seen)
	}
	keys := make([]string, 0, len(seen))
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]PackageHint, 0, len(keys))
	for _, k := range keys {
		out = append(out, seen[k])
	}
	return out
}

func walkTasksForPackages(items []map[string]any, filePath string, seen map[string]PackageHint) {
	for _, item := range items {
		// Recurse into play tasks/pre_tasks/post_tasks/block/rescue
		for _, subKey := range []string{"tasks", "pre_tasks", "post_tasks", "block", "rescue", "always"} {
			if rawSub, ok := item[subKey].([]any); ok {
				subMaps := make([]map[string]any, 0, len(rawSub))
				for _, x := range rawSub {
					if m, ok := x.(map[string]any); ok {
						subMaps = append(subMaps, m)
					}
				}
				walkTasksForPackages(subMaps, filePath, seen)
			}
		}
		for modKey, modVal := range item {
			if !pkgModuleNames[modKey] {
				continue
			}
			var names []string
			switch mv := modVal.(type) {
			case map[string]any:
				names = append(names, collectStringSlice(mv["name"])...)
				names = append(names, collectStringSlice(mv["pkg"])...)
			case string:
				for _, tok := range strings.Fields(mv) {
					if strings.HasPrefix(tok, "name=") {
						names = append(names, strings.Split(strings.TrimPrefix(tok, "name="), ",")...)
					}
				}
			}
			for _, n := range names {
				n = strings.TrimSpace(n)
				if n == "" || strings.Contains(n, "{{") || !safePkgNameRe.MatchString(n) {
					continue
				}
				if _, exists := seen[n]; !exists {
					seen[n] = PackageHint{Name: n, DetectedFrom: filePath}
				}
			}
		}
	}
}

func mergePackageHints(discovered, declared []PackageHint) []PackageHint {
	seen := map[string]PackageHint{}
	order := []string{}
	for _, p := range declared {
		if p.Name == "" {
			continue
		}
		seen[p.Name] = p
		order = append(order, p.Name)
	}
	for _, p := range discovered {
		if _, exists := seen[p.Name]; !exists {
			seen[p.Name] = p
			order = append(order, p.Name)
		}
	}
	out := make([]PackageHint, 0, len(order))
	for _, k := range order {
		out = append(out, seen[k])
	}
	return out
}

func inferCategory(name, title string, roles []string, pkgs []PackageHint) string {
	hay := strings.ToLower(name + " " + title + " " + strings.Join(roles, " "))
	for _, p := range pkgs {
		hay += " " + strings.ToLower(p.Name)
	}
	switch {
	case strings.Contains(hay, "postgres") || strings.Contains(hay, "mysql") || strings.Contains(hay, "mariadb") || strings.Contains(hay, "mongo") || strings.Contains(hay, "oracle"):
		return "数据库"
	case strings.Contains(hay, "redis") || strings.Contains(hay, "memcache") || strings.Contains(hay, "valkey"):
		return "缓存"
	case strings.Contains(hay, "nginx") || strings.Contains(hay, "haproxy") || strings.Contains(hay, "keepalived") || strings.Contains(hay, "envoy"):
		return "负载均衡"
	case strings.Contains(hay, "kafka") || strings.Contains(hay, "rabbit") || strings.Contains(hay, "rocketmq") || strings.Contains(hay, "nats"):
		return "消息队列"
	case strings.Contains(hay, "etcd") || strings.Contains(hay, "consul") || strings.Contains(hay, "zookeeper"):
		return "协调服务"
	case strings.Contains(hay, "prometheus") || strings.Contains(hay, "grafana") || strings.Contains(hay, "exporter"):
		return "监控可观测"
	default:
		return "中间件"
	}
}

func cloneFiles(in map[string][]byte) map[string][]byte {
	out := make(map[string][]byte, len(in))
	for k, v := range in {
		cp := make([]byte, len(v))
		copy(cp, v)
		out[k] = cp
	}
	return out
}

func sortedKeys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

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

	if playbooks == nil {
		playbooks = []string{}
	}
	if roles == nil {
		roles = []string{}
	}
	if steps == nil {
		steps = []PlayStep{}
	}
	if mergedVars == nil {
		mergedVars = []VarSpec{}
	}
	if mergedPkgs == nil {
		mergedPkgs = []PackageHint{}
	}
	if problems == nil {
		problems = []Problem{}
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
//  1. meta/argument_specs.yml (Ansible 2.11+ official role schema, preserving YAML declaration order)
//  2. roles/*/defaults/main.yml (preserving order + extracting YAML comments as descriptions/sections)
//  3. group_vars/all.yml
//  4. Playbook top-level vars:
//  5. Automatic conditional visibility (when:) & semantic form grouping inferred from tasks & templates
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
			if prev.Group == "" && v.Group != "" {
				prev.Group = v.Group
			}
			if prev.When == "" && v.When != "" {
				prev.When = v.When
			}
			if !prev.Required && v.Required {
				prev.Required = true
			}
			if !prev.Advanced && v.Advanced {
				prev.Advanced = true
			}
			byKey[v.Key] = prev
			return
		}
		byKey[v.Key] = v
		order = append(order, v.Key)
	}

	paths := sortedKeys(files)

	// 1. Official Ansible meta/argument_specs.yml (preserving exact YAML key order!)
	for _, p := range paths {
		base := strings.ToLower(path.Base(p))
		if base != "argument_specs.yml" && base != "argument_specs.yaml" {
			continue
		}
		var root yaml.Node
		if err := yaml.Unmarshal(files[p], &root); err != nil || len(root.Content) == 0 {
			continue
		}
		docNode := root.Content[0]
		argSpecsNode := yamlMapGet(docNode, "argument_specs")
		if argSpecsNode == nil || argSpecsNode.Kind != yaml.MappingNode {
			continue
		}
		for i := 0; i+1 < len(argSpecsNode.Content); i += 2 {
			entryVal := argSpecsNode.Content[i+1]
			optsNode := yamlMapGet(entryVal, "options")
			if optsNode == nil || optsNode.Kind != yaml.MappingNode {
				continue
			}
			for j := 0; j+1 < len(optsNode.Content); j += 2 {
				kNode := optsNode.Content[j]
				vNode := optsNode.Content[j+1]
				k := strings.TrimSpace(kNode.Value)
				if k == "" || strings.HasPrefix(k, "_") {
					continue
				}
				var spec struct {
					Type        string `yaml:"type"`
					Required    bool   `yaml:"required"`
					NoLog       bool   `yaml:"no_log"`
					Default     any    `yaml:"default"`
					Choices     []any  `yaml:"choices"`
					Description any    `yaml:"description"`
				}
				if err := vNode.Decode(&spec); err != nil {
					continue
				}
				choices := make([]string, 0, len(spec.Choices))
				for _, ch := range spec.Choices {
					choices = append(choices, fmt.Sprint(ch))
				}
				vtype := normalizeAnsibleType(spec.Type, k, spec.Default, choices)
				if spec.NoLog {
					vtype = "secret"
				}
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

	// 2. Role defaults/main.yml (preserving YAML order & reading head/line comments for zero-config roles!)
	for _, p := range paths {
		lp := strings.ToLower(p)
		if !strings.HasSuffix(lp, "/defaults/main.yml") && !strings.HasSuffix(lp, "/defaults/main.yaml") &&
			lp != "defaults/main.yml" && lp != "defaults/main.yaml" {
			continue
		}
		for _, item := range parseOrderedYAMLMapping(files[p]) {
			if strings.HasPrefix(item.Key, "_") {
				continue
			}
			record(VarSpec{
				Key:         item.Key,
				Label:       humanizeVarKey(item.Key),
				Type:        normalizeAnsibleType("", item.Key, item.Value, nil),
				Default:     item.Value,
				Description: item.Comment,
				Source:      "defaults",
			})
		}
	}

	// 3. group_vars/all.yml
	for _, p := range paths {
		lp := strings.ToLower(p)
		if lp != "group_vars/all.yml" && lp != "group_vars/all.yaml" && lp != "group_vars/all/main.yml" {
			continue
		}
		for _, item := range parseOrderedYAMLMapping(files[p]) {
			if strings.HasPrefix(item.Key, "_") || strings.HasPrefix(item.Key, "ansible_") {
				continue
			}
			record(VarSpec{
				Key:         item.Key,
				Label:       humanizeVarKey(item.Key),
				Type:        normalizeAnsibleType("", item.Key, item.Value, nil),
				Default:     item.Value,
				Description: item.Comment,
				Source:      "group_vars",
			})
		}
	}

	// 4. Top-level play vars: inside playbooks (makes standalone single playbooks immediately parameterized!)
	for _, p := range paths {
		if !isYAML(p) || p == ManifestFileName {
			continue
		}
		lp := strings.ToLower(p)
		if strings.Contains(lp, "/tasks/") || strings.Contains(lp, "/handlers/") ||
			strings.Contains(lp, "/defaults/") || strings.Contains(lp, "/vars/") ||
			strings.Contains(lp, "/meta/") || strings.Contains(lp, "/group_vars/") ||
			strings.Contains(lp, "/host_vars/") {
			continue
		}
		var root yaml.Node
		if err := yaml.Unmarshal(files[p], &root); err != nil || len(root.Content) == 0 {
			continue
		}
		seq := root.Content[0]
		if seq.Kind != yaml.SequenceNode {
			continue
		}
		for _, playNode := range seq.Content {
			if playNode.Kind != yaml.MappingNode || yamlMapGet(playNode, "hosts") == nil {
				continue
			}
			varsNode := yamlMapGet(playNode, "vars")
			if varsNode == nil || varsNode.Kind != yaml.MappingNode {
				continue
			}
			for _, item := range parseYAMLMappingNode(varsNode) {
				if strings.HasPrefix(item.Key, "_") || strings.HasPrefix(item.Key, "ansible_") {
					continue
				}
				record(VarSpec{
					Key:         item.Key,
					Label:       humanizeVarKey(item.Key),
					Type:        normalizeAnsibleType("", item.Key, item.Value, nil),
					Default:     item.Value,
					Description: item.Comment,
					Source:      "playbook_vars",
				})
			}
		}
	}

	out := make([]VarSpec, 0, len(order))
	for _, k := range order {
		out = append(out, byKey[k])
	}
	// 5. Infer dynamic form conditions (when:) from Ansible tasks & Jinja2 templates, plus semantic form groups
	enrichVarsFromAnsibleAST(files, out)
	return out
}

type orderedYAMLItem struct {
	Key     string
	Value   any
	Comment string
}

func yamlMapGet(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			return node.Content[i+1]
		}
	}
	return nil
}

func parseOrderedYAMLMapping(raw []byte) []orderedYAMLItem {
	var root yaml.Node
	if err := yaml.Unmarshal(raw, &root); err != nil || len(root.Content) == 0 {
		return nil
	}
	return parseYAMLMappingNode(root.Content[0])
}

func parseYAMLMappingNode(m *yaml.Node) []orderedYAMLItem {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	out := make([]orderedYAMLItem, 0, len(m.Content)/2)
	for i := 0; i+1 < len(m.Content); i += 2 {
		kn := m.Content[i]
		vn := m.Content[i+1]
		var val any
		_ = vn.Decode(&val)
		cmt := cleanYAMLComment(firstNonEmptyString(vn.LineComment, kn.HeadComment))
		out = append(out, orderedYAMLItem{
			Key:     strings.TrimSpace(kn.Value),
			Value:   val,
			Comment: cmt,
		})
	}
	return out
}

func firstNonEmptyString(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func cleanYAMLComment(raw string) string {
	var lines []string
	for _, ln := range strings.Split(raw, "\n") {
		s := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(ln), "#"))
		if s == "" || strings.Trim(s, "-=*") == "" {
			continue
		}
		lines = append(lines, s)
	}
	return strings.Join(lines, " ")
}

var (
	jinjaVarTokenRe      = regexp.MustCompile(`\b([a-zA-Z][a-zA-Z0-9_]{2,63})\b`)
	jinjaIfBlockRe       = regexp.MustCompile(`(?s)\{%-?\s*if\s+([^%]+?)\s*-?%\}(.*?)\{%-?\s*(?:elif|else|endif)\b`)
	condEqStrRe          = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9_]*)(?:\s*\|\s*default\([^)]*\))?(?:\s*\|\s*(?:trim|lower|string))?\s*(==|!=)\s*['"]([^'"]+)['"]$`)
	condBoolVarRe        = regexp.MustCompile(`^(?:not\s+)?\(?([a-zA-Z][a-zA-Z0-9_]*)(?:\s*\|\s*default\([^)]*\))?(?:\s*\|\s*bool)?\)?$`)
	condGroupEmptyRe     = regexp.MustCompile(`groups\[['"]([a-zA-Z0-9_-]+)['"]\][^|]*\|\s*length\s*(==\s*0|>\s*0|>=\s*1)`)
	condElseGroupEmptyRe = regexp.MustCompile(`(?s)\{%-?\s*if\s+[^%]*groups\[['"]([a-zA-Z0-9_-]+)['"]\][^%]*\|\s*length\s*>\s*0\s*-?%\}.*?\{%-?\s*else\s*-?%\}(.*?)\{%-?\s*endif\b`)
)

// enrichVarsFromAnsibleAST inspects Ansible tasks (when:) and Jinja2 templates ({% if ... %})
// to automatically infer conditional form visibility, semantic form sections, and advanced toggles
// purely from standard Ansible source code (zero hardcoded component logic!).
func enrichVarsFromAnsibleAST(files map[string][]byte, vars []VarSpec) {
	known := make(map[string]int, len(vars))
	for i, v := range vars {
		known[v.Key] = i
	}
	// Track every variable's guarded vs unguarded usage across tasks & templates.
	// Using intersection across usage sites: if template uses var under {A} and verify task uses var under {A, B},
	// the necessary condition is {A} (if A is false, var is never used anywhere!).
	unguardedUse := map[string]bool{}
	guardedIntersect := map[string]map[string]bool{}
	addGuardedSet := func(varName string, conds []string) {
		if len(conds) == 0 {
			return
		}
		if _, ok := known[varName]; !ok {
			return
		}
		cur := map[string]bool{}
		for _, c := range conds {
			if c != "" && !strings.HasPrefix(c, varName+" ") {
				cur[c] = true
			}
		}
		if len(cur) == 0 {
			return
		}
		prev, exists := guardedIntersect[varName]
		if !exists {
			guardedIntersect[varName] = cur
			return
		}
		for k := range prev {
			if !cur[k] {
				delete(prev, k)
			}
		}
	}
	addGuarded := func(varName, cond string) {
		if cond != "" {
			addGuardedSet(varName, []string{cond})
		}
	}

	normalizeCond := func(raw string) string {
		c := strings.TrimSpace(raw)
		if c == "" {
			return ""
		}
		if m := condGroupEmptyRe.FindStringSubmatch(c); len(m) == 3 {
			op := strings.ReplaceAll(m[2], " ", "")
			if op == "==0" {
				return "group." + m[1] + " == 0"
			}
			return "group." + m[1] + " > 0"
		}
		// Check simple equality `foo == 'bar'` or `foo != 'bar'`
		if m := condEqStrRe.FindStringSubmatch(c); len(m) == 4 {
			if _, ok := known[m[1]]; ok {
				return fmt.Sprintf("%s %s '%s'", m[1], m[2], m[3])
			}
		}
		// Check simple boolean guard `foo | bool` or `not (foo | bool)`
		neg := strings.HasPrefix(c, "not ")
		trimmed := strings.TrimSpace(strings.TrimPrefix(c, "not "))
		if m := condBoolVarRe.FindStringSubmatch(trimmed); len(m) == 2 {
			if idx, ok := known[m[1]]; ok && vars[idx].Type == "bool" {
				if neg {
					return m[1] + " == false"
				}
				return m[1] + " == true"
			}
		}
		return ""
	}

	extractNormalizedConds := func(whenField any) []string {
		var raws []string
		switch w := whenField.(type) {
		case string:
			raws = append(raws, w)
		case []any:
			for _, it := range w {
				if s, ok := it.(string); ok {
					raws = append(raws, s)
				}
			}
		}
		var out []string
		for _, r := range raws {
			for _, part := range strings.Split(r, " and ") {
				if nc := normalizeCond(part); nc != "" {
					out = append(out, nc)
				}
			}
		}
		return out
	}

	// Scan tasks/*.yml and playbooks/*.yml for task/block `when:` guards
	var scanTaskList func(items []any, inheritedConds []string)
	scanTaskList = func(items []any, inheritedConds []string) {
		for _, rawIt := range items {
			m, ok := rawIt.(map[string]any)
			if !ok {
				continue
			}
			conds := append([]string(nil), inheritedConds...)
			conds = append(conds, extractNormalizedConds(m["when"])...)
			if blk, ok := m["block"].([]any); ok {
				scanTaskList(blk, conds)
				continue
			}
		// Skip task/playbook diagnostic assertions and read-only probe/cleanup playbooks when determining
		// whether a variable is unguarded in deployment templates/tasks.
		if _, hasAssert := m["ansible.builtin.assert"]; hasAssert {
			continue
		}
		if _, hasAssert := m["assert"]; hasAssert {
			continue
		}
		if _, hasDebug := m["ansible.builtin.debug"]; hasDebug {
			continue
		}
		if _, hasDebug := m["debug"]; hasDebug {
			continue
		}
		// Collect variable names referenced in task module args (excluding `when:` itself)
			var buf strings.Builder
			for tk, tv := range m {
				if tk == "when" || tk == "name" || tk == "tags" || tk == "register" || tk == "notify" {
					continue
				}
				b, _ := yaml.Marshal(tv)
				buf.Write(b)
				buf.WriteByte('\n')
			}
			txt := buf.String()
			for _, sm := range jinjaVarTokenRe.FindAllStringSubmatch(txt, -1) {
				vn := sm[1]
				if _, ok := known[vn]; !ok {
					continue
				}
				if len(conds) == 0 {
					unguardedUse[vn] = true
				} else {
					addGuardedSet(vn, conds)
				}
			}
		}
	}

	for _, p := range sortedKeys(files) {
		lp := strings.ToLower(p)
		if p == ManifestFileName || strings.Contains(lp, "/defaults/") || strings.Contains(lp, "/meta/") || strings.Contains(lp, "/group_vars/") {
			continue
		}
		// Templates (.j2): scan {% if ... %} blocks & unguarded lines
		if strings.HasSuffix(lp, ".j2") {
			src := string(files[p])
			// Special case: {% if groups['X'] | length > 0 %} ... {% else %} ... {% endif %}
			for _, m := range condElseGroupEmptyRe.FindAllStringSubmatch(src, -1) {
				grpName := m[1]
				elseBody := m[2]
				for _, sm := range jinjaVarTokenRe.FindAllStringSubmatch(elseBody, -1) {
					addGuarded(sm[1], "group."+grpName+" == 0")
				}
			}
			// Regular {% if <cond> %} ... {% endif %} blocks
			stripped := src
			for _, m := range jinjaIfBlockRe.FindAllStringSubmatch(src, -1) {
				condExpr := strings.TrimSpace(m[1])
				body := m[2]
				nc := normalizeCond(condExpr)
				if nc != "" {
					for _, sm := range jinjaVarTokenRe.FindAllStringSubmatch(body, -1) {
						addGuarded(sm[1], nc)
					}
					stripped = strings.Replace(stripped, body, "", 1)
				}
			}
			// Also strip elseBody from stripped before counting unguarded refs
			for _, m := range condElseGroupEmptyRe.FindAllStringSubmatch(src, -1) {
				stripped = strings.Replace(stripped, m[2], "", 1)
			}
			for _, sm := range jinjaVarTokenRe.FindAllStringSubmatch(stripped, -1) {
				if _, ok := known[sm[1]]; ok {
					unguardedUse[sm[1]] = true
				}
			}
			continue
		}
		// Task YAML & Playbook YAML (skip read-only probe/cleanup diagnostic playbooks so deployment guards govern form visibility)
		if isYAML(p) {
			if strings.Contains(lp, "probe.yml") || strings.Contains(lp, "probe.yaml") || strings.Contains(lp, "cleanup.yml") || strings.Contains(lp, "cleanup.yaml") {
				continue
			}
			var list []any
			if err := yaml.Unmarshal(files[p], &list); err != nil {
				continue
			}
			if strings.Contains(lp, "/tasks/") {
				scanTaskList(list, nil)
			} else {
				// Playbook: inspect play tasks/pre_tasks/post_tasks
				for _, pl := range list {
					pm, ok := pl.(map[string]any)
					if !ok {
						continue
					}
					for _, sec := range []string{"pre_tasks", "tasks", "post_tasks"} {
						if sub, ok := pm[sec].([]any); ok {
							scanTaskList(sub, nil)
						}
					}
				}
			}
		}
	}

	// Apply inferred conditions & semantic groups to each VarSpec
	for i := range vars {
		v := &vars[i]
		// Assign inferred When only if not explicitly declared AND variable is never used unguarded
		if v.When == "" && !unguardedUse[v.Key] {
			if cset := guardedIntersect[v.Key]; len(cset) > 0 {
				cs := make([]string, 0, len(cset))
				for c := range cset {
					cs = append(cs, c)
				}
				sort.Strings(cs)
				v.When = strings.Join(cs, " && ")
			}
		}
		// Infer semantic form group + advanced flag
		if v.Group == "" {
			v.Group, v.Advanced = inferVarGroupAndAdvanced(v.Key, v.Type, v.When)
		}
		v.GroupLabel, v.GroupLabelEn = varGroupLabels(v.Group)
		// Infer sensible unit/min/max hints
		if v.Type == "port" && v.Min == nil && v.Max == nil {
			lo, hi := 1, 65535
			v.Min, v.Max = &lo, &hi
		}
		if v.Unit == "" {
			lk := strings.ToLower(v.Key)
			switch {
			case strings.HasSuffix(lk, "_ms"):
				v.Unit = "ms"
			case strings.HasSuffix(lk, "_ttl") || strings.HasSuffix(lk, "_wait") || strings.HasSuffix(lk, "_timeout") && v.Type == "int" || strings.HasSuffix(lk, "_advert_int") || strings.HasSuffix(lk, "_keepalive"):
				v.Unit = "s"
			case strings.HasSuffix(lk, "_bytes") || strings.Contains(lk, "lag_on_failover"):
				v.Unit = "bytes"
			}
		}
	}
}

func inferVarGroupAndAdvanced(key, vtype, whenExpr string) (string, bool) {
	lk := strings.ToLower(key)
	// OS kernel baseline parameters
	if strings.Contains(lk, "apply_baseline") || strings.Contains(lk, "vm_") ||
		strings.Contains(lk, "somaxconn") || strings.Contains(lk, "nofile") ||
		strings.Contains(lk, "nproc") || strings.Contains(lk, "thp") ||
		strings.Contains(lk, "disable_swap") || strings.Contains(lk, "sysctl") ||
		strings.Contains(lk, "syn_backlog") {
		return "baseline", !strings.Contains(lk, "apply_baseline")
	}
	// Security & credentials
	if vtype == "secret" || strings.Contains(lk, "password") || strings.Contains(lk, "secret") ||
		strings.Contains(lk, "auth") || strings.Contains(lk, "tls") || strings.Contains(lk, "ssl") ||
		strings.Contains(lk, "cert") || strings.Contains(lk, "cidr") || strings.Contains(lk, "_user") {
		return "security", false
	}
	// HA, replication, failover, health checks, upstreams/backends
	if strings.Contains(lk, "sentinel") || strings.Contains(lk, "repl") ||
		strings.Contains(lk, "sync") || strings.Contains(lk, "failover") ||
		strings.Contains(lk, "quorum") || strings.Contains(lk, "ttl") ||
		strings.Contains(lk, "loop_wait") || strings.Contains(lk, "retry_timeout") ||
		strings.Contains(lk, "heartbeat") || strings.Contains(lk, "election") ||
		strings.Contains(lk, "vrrp") || strings.Contains(lk, "router_id") ||
		strings.Contains(lk, "advert_int") || strings.Contains(lk, "check_") ||
		strings.Contains(lk, "health_check") || strings.Contains(lk, "upstream") ||
		strings.Contains(lk, "backend") || strings.Contains(lk, "external_etcd") ||
		strings.Contains(lk, "hot_standby") || strings.Contains(lk, "max_fails") ||
		strings.Contains(lk, "fail_timeout") {
		return "ha", false
	}
	// Network & ports
	if vtype == "port" || vtype == "ip" || strings.Contains(lk, "_port") ||
		strings.Contains(lk, "listen") || strings.Contains(lk, "bind") ||
		strings.Contains(lk, "address") || strings.Contains(lk, "vip") ||
		strings.Contains(lk, "interface") || strings.Contains(lk, "protocol") ||
		strings.Contains(lk, "resolve_ip") || strings.Contains(lk, "timeout") ||
		strings.Contains(lk, "tcp_") || strings.Contains(lk, "keepalive") {
		return "network", false
	}
	// Performance, memory, storage & logging
	if strings.Contains(lk, "memory") || strings.Contains(lk, "buffer") ||
		strings.Contains(lk, "cache") || strings.Contains(lk, "work_mem") ||
		strings.Contains(lk, "wal") || strings.Contains(lk, "checkpoint") ||
		strings.Contains(lk, "conn") || strings.Contains(lk, "worker") ||
		strings.Contains(lk, "persist") || strings.Contains(lk, "data_dir") ||
		strings.Contains(lk, "quota") || strings.Contains(lk, "compaction") ||
		strings.Contains(lk, "snapshot") || strings.Contains(lk, "log") ||
		strings.Contains(lk, "timezone") || strings.Contains(lk, "database") ||
		strings.Contains(lk, "backlog") || strings.Contains(lk, "samples") {
		return "tuning", false
	}
	return "basic", false
}

func varGroupLabels(g string) (string, string) {
	switch g {
	case "basic":
		return "基础配置", "General"
	case "network":
		return "网络与端口", "Network & Ports"
	case "ha":
		return "高可用与流量治理", "HA, Replication & Health"
	case "security":
		return "安全与凭据", "Security & Access"
	case "tuning":
		return "性能、存储与日志", "Performance, Storage & Logs"
	case "baseline":
		return "操作系统内核基线", "OS Kernel Baseline"
	default:
		return "高级参数", "Advanced"
	}
}

func normalizeAnsibleType(declared, key string, def any, choices []string) string {
	if len(choices) > 0 {
		return "select"
	}
	lk := strings.ToLower(key)
	if strings.Contains(lk, "password") || strings.Contains(lk, "secret") || strings.Contains(lk, "auth_pass") || (strings.Contains(lk, "token") && !strings.Contains(lk, "cluster_token")) {
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
	case "path":
		return "path"
	case "str", "string", "raw":
		if strings.Contains(lk, "cidr") {
			return "cidr"
		}
		if strings.HasSuffix(lk, "_dir") || strings.HasSuffix(lk, "_path") || strings.HasSuffix(lk, "_file") {
			return "path"
		}
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
		if strings.Contains(lk, "cidr") {
			return "cidr"
		}
		if strings.HasSuffix(lk, "_dir") || strings.HasSuffix(lk, "_path") || strings.HasSuffix(lk, "_file") {
			return "path"
		}
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
			if v.Group == "" {
				v.Group = d.Group
			}
			if v.When == "" {
				v.When = d.When
			}
			if !v.Advanced && d.Advanced {
				v.Advanced = d.Advanced
			}
			if v.Unit == "" {
				v.Unit = d.Unit
			}
			if v.Min == nil {
				v.Min = d.Min
			}
			if v.Max == nil {
				v.Max = d.Max
			}
		} else if v.Source == "" {
			v.Source = "manifest"
		}
		if v.Group == "" {
			v.Group, v.Advanced = inferVarGroupAndAdvanced(v.Key, v.Type, v.When)
		}
		v.GroupLabel, v.GroupLabelEn = varGroupLabels(v.Group)
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

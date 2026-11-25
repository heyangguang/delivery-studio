package server

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing/fstest"

	"gopkg.in/yaml.v3"

	"delivery-studio/catalog"
	"delivery-studio/mwpack"
)

// compProblem is one finding of the workbench checks, located in a file (and a line when it can be told).
type compProblem struct {
	Severity string `json:"severity"` // error | warning
	File     string `json:"file,omitempty"`
	Line     int    `json:"line,omitempty"`
	Path     string `json:"path,omitempty"`
	Message  string `json:"message"`
}

type compCheck struct {
	OK       bool          `json:"ok"`
	Errors   int           `json:"errors"`
	Warnings int           `json:"warnings"`
	Problems []compProblem `json:"problems"`
	// Ignored are warnings the people who look after the component decided are fine; they are not counted.
	Ignored []compProblem `json:"ignored,omitempty"`
}

// ignoreKey identifies a warning without its line, so the decision survives edits above it.
func ignoreKey(p compProblem) string { return p.File + "|" + p.Message }

// ignoring moves the warnings that were set aside out of the problems and counts again. Errors are never ignored.
func (c *compCheck) ignoring(keys map[string]bool) *compCheck {
	if len(keys) == 0 {
		return c
	}
	kept := c.Problems[:0:0]
	for _, p := range c.Problems {
		if p.Severity != "error" && keys[ignoreKey(p)] {
			c.Ignored = append(c.Ignored, p)
			continue
		}
		kept = append(kept, p)
	}
	c.Problems, c.Errors, c.Warnings = kept, 0, 0
	return c.finish()
}

func (c *compCheck) add(sev, file string, line int, p, f string, a ...any) {
	c.Problems = append(c.Problems, compProblem{Severity: sev, File: file, Line: line, Path: p, Message: fmt.Sprintf(f, a...)})
}

func (c *compCheck) finish() *compCheck {
	sort.SliceStable(c.Problems, func(i, j int) bool { return c.Problems[i].Severity == "error" && c.Problems[j].Severity != "error" })
	for _, p := range c.Problems {
		if p.Severity == "error" {
			c.Errors++
		} else {
			c.Warnings++
		}
	}
	c.OK = c.Errors == 0
	return c
}

var yamlLineRE = regexp.MustCompile(`line (\d+)`)

// yamlErrLine pulls the line number out of a yaml.v3 error message.
func yamlErrLine(err error) int {
	if m := yamlLineRE.FindStringSubmatch(err.Error()); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	return 0
}

// pathLine finds the line of a validation path such as versions[3.5].params[port] in component.yaml. It walks as deep
// as the document allows and reports the deepest node found, so a message about a missing field still points at its
// parent. A problem reported for a version (versions[3.5].lifecycle...) may really live in the base component, which
// every version inherits; both places are tried and the deeper hit wins.
func pathLine(root *yaml.Node, p string) int {
	if root == nil || len(root.Content) == 0 {
		return 0
	}
	top := root.Content[0]
	toks := splitPath(p)
	line, depth := walkPath(top, toks)
	if len(toks) >= 2 && toks[0] == "versions" {
		if l, d := walkPath(top, toks[2:]); d > depth {
			line, depth = l, d
		}
	}
	return line
}

func walkPath(n *yaml.Node, toks []string) (line, depth int) {
	line = n.Line
	for _, tok := range toks {
		next := descend(n, tok)
		if next == nil {
			break
		}
		n, line = next, next.Line
		depth++
	}
	return
}

func splitPath(p string) []string {
	var out []string
	for _, seg := range strings.Split(p, ".") {
		if seg == "" {
			continue
		}
		if i := strings.Index(seg, "["); i >= 0 && strings.HasSuffix(seg, "]") {
			if i > 0 {
				out = append(out, seg[:i])
			}
			out = append(out, seg[i+1:len(seg)-1])
			continue
		}
		out = append(out, seg)
	}
	return out
}

func descend(n *yaml.Node, tok string) *yaml.Node {
	switch n.Kind {
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			if n.Content[i].Value == tok {
				return n.Content[i+1]
			}
		}
	case yaml.SequenceNode:
		if idx, err := strconv.Atoi(tok); err == nil && idx >= 0 && idx < len(n.Content) {
			return n.Content[idx]
		}
		for _, item := range n.Content {
			if item.Kind != yaml.MappingNode {
				continue
			}
			for i := 0; i+1 < len(item.Content); i += 2 {
				switch item.Content[i].Value {
				case "id", "key", "name", "capability", "role":
					if item.Content[i+1].Value == tok {
						return item
					}
				}
			}
		}
	}
	return nil
}

// trialCatalog loads the catalog as it would be with files published as the component name. The component lives in
// memory, so the catalog stays usable (its role files readable) after this returns and nothing is written to disk.
func trialCatalog(p *platform, name string, files fileSet) (*mwpack.Catalog, error) {
	mem := fstest.MapFS{}
	for path, b := range files {
		mem[name+"/"+path] = &fstest.MapFile{Data: b, Mode: 0o600}
	}
	staged := single{mem, name}
	if _, err := mwpack.LoadCatalog(catalog.FS, staged); err != nil {
		return nil, trimLoadErr(err)
	}
	sources := []fs.FS{catalog.FS}
	if p.componentsDir != "" {
		custom := os.DirFS(p.componentsDir)
		if entries, err := os.ReadDir(p.componentsDir); err == nil {
			for _, e := range entries {
				if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || e.Name() == name {
					continue
				}
				one := single{custom, e.Name()}
				if _, err := mwpack.LoadCatalog(catalog.FS, one); err == nil {
					sources = append(sources, one)
				}
			}
		}
	}
	cat, err := mwpack.LoadCatalog(append(sources, staged)...)
	if err != nil {
		return nil, trimLoadErr(err)
	}
	if _, ok := cat.Get(name); !ok {
		return nil, fmt.Errorf("组件 %s 无法与现有组件一起载入", name)
	}
	return cat.WithPlatformFiles(p.cat().PlatformSnapshot()), nil
}

func trimLoadErr(err error) error {
	msg := err.Error()
	if i := strings.Index(msg, "：\n"); i >= 0 {
		msg = strings.TrimSpace(msg[i+len("：\n"):])
	}
	return errors.New(msg)
}

// checkComponent runs every static check on a draft. It never runs Ansible; see previewComponent for that.
func checkComponent(p *platform, name string, files fileSet) *compCheck {
	if name == sharedPlatformName {
		return checkSharedPlatform(p, files)
	}
	res := &compCheck{Problems: []compProblem{}}
	if err := files.check(); err != nil {
		res.add("error", "", 0, "", "%v", err)
		return res.finish()
	}
	// Syntax of every YAML file first: later checks are meaningless on a file that does not parse.
	nodes := map[string]*yaml.Node{}
	for _, f := range files.paths() {
		if fileKind(f) != "yaml" && fileKind(f) != "manifest" {
			continue
		}
		var n yaml.Node
		if err := yaml.Unmarshal(files[f], &n); err != nil {
			res.add("error", f, yamlErrLine(err), "", "YAML 语法错误：%v", err)
			continue
		}
		nodes[f] = &n
	}
	manifest := nodes["component.yaml"]
	if manifest == nil {
		return res.finish()
	}
	expanded, origins, expansionErr := mwpack.ExpandManifest(files.manifestRead)
	if expansionErr != nil {
		res.add("error", "component.yaml", 0, "", "%v", expansionErr)
		return res.finish()
	}
	manifest = expanded
	defer func() {
		for index := range res.Problems {
			problem := &res.Problems[index]
			if problem.File != "component.yaml" || problem.Path == "" {
				continue
			}
			locate := func(tokens []string) (*yaml.Node, int) {
				node := manifest.Content[0]
				depth := 0
				for _, tok := range tokens {
					next := descend(node, tok)
					if next == nil {
						break
					}
					node = next
					depth++
				}
				return node, depth
			}
			tokens := splitPath(problem.Path)
			node, depth := locate(tokens)
			if len(tokens) >= 2 && tokens[0] == "versions" {
				if inherited, d := locate(tokens[2:]); d > depth {
					node = inherited
				}
			}
			if origin := origins[node]; origin != "" {
				problem.File = origin
				problem.Line = node.Line
			}
		}
	}()
	c, err := files.component()
	if err != nil {
		var source *mwpack.ManifestSourceError
		if errors.As(err, &source) {
			res.add("error", source.File, source.Line, "", "%v", err)
		} else {
			res.add("error", "component.yaml", yamlErrLine(err), "", "%v", err)
		}
		return res.finish()
	}
	if c.Name != name {
		res.add("error", "component.yaml", pathLine(manifest, "component"), "component", "组件名是 %q，但这个草稿属于 %q（组件名不能在草稿里改，请用「复制为新组件」）", c.Name, name)
		return res.finish()
	}
	for _, pr := range mwpack.ValidateComponent(c, p.cat()) {
		res.add(pr.Severity, "component.yaml", pathLine(manifest, pr.Path), pr.Path, "%s", pr.Message)
	}
	for _, pr := range mwpack.ValidateSeries(c, p.cat(), true) {
		if pr.Severity != "error" {
			continue
		}
		found := false
		for index := range res.Problems {
			existing := &res.Problems[index]
			if existing.Path == pr.Path && existing.Message == pr.Message {
				existing.Severity = "error"
				found = true
				break
			}
		}
		if !found {
			res.add("error", "component.yaml", pathLine(manifest, pr.Path), pr.Path, "%s", pr.Message)
		}
	}
	missing := checkRunRefs(res, c, files, manifest)
	if !missing {
		mem := fstest.MapFS{}
		for fp, b := range files {
			mem[name+"/"+fp] = &fstest.MapFile{Data: b, Mode: 0o600}
		}
		c.AttachFS(mem, name)
		for _, pr := range mwpack.ValidateStepOwnership(c) {
			res.add(pr.Severity, "component.yaml", pathLine(manifest, pr.Path), pr.Path, "%s", pr.Message)
		}
	}
	// Loading it together with the other components catches what only shows up in company: default_impl, capabilities
	// provided elsewhere. Problems already reported above are not repeated.
	if _, err := trialCatalog(p, name, files); err != nil && !missing {
		msg := uniqueLines(err.Error())
		seen := false
		for _, pr := range res.Problems {
			if pr.Severity == "error" && strings.Contains(msg, pr.Message) {
				seen = true
			}
		}
		if !seen {
			res.add("error", "component.yaml", 0, "", "与其他组件一起载入时失败：%s", msg)
		}
	}
	checkPackages(res, p, c, manifest)
	checkRoleFiles(res, c, files, manifest)
	for _, f := range files.paths() {
		if strings.HasSuffix(f, ".j2") {
			checkJinja(res, f, string(files[f]))
		}
	}
	return res.finish()
}

var (
	srcRE    = regexp.MustCompile(`(?m)^\s*(?:-\s+)?src:\s*['"]?([^'"\s#]+)`)
	lookupRE = regexp.MustCompile(`\b(lookup|query|q)\s*\(`)
)

// checkRoleFiles reports role directories no step uses, and templates a task names but the component lacks.
func checkRoleFiles(res *compCheck, c *mwpack.Component, files fileSet, manifest *yaml.Node) {
	used := map[string]bool{}
	var scan func(steps []mwpack.Step)
	scan = func(steps []mwpack.Step) {
		for _, s := range steps {
			if s.Run != nil {
				used[s.Run.Role] = true
			}
		}
	}
	for _, st := range c.Lifecycle {
		scan(st)
	}
	scan(c.Tests)
	scan(c.Cleanup)
	for _, v := range c.Versions {
		scan(v.Tests)
		scan(v.Cleanup)
		for _, st := range v.Lifecycle {
			scan(st)
		}
	}
	roles := map[string]bool{}
	for f := range files {
		parts := strings.Split(f, "/")
		if len(parts) >= 3 && parts[0] == "roles" {
			roles[parts[1]] = true
		}
	}
	for r := range roles {
		if !used[r] {
			res.add("warning", "roles/"+r, 0, "", "角色 %s 没有被任何步骤使用（步骤的 run.role 没有指向它）", r)
		}
	}
	for _, f := range files.paths() {
		parts := strings.Split(f, "/")
		if len(parts) < 4 || parts[0] != "roles" || parts[2] != "tasks" || fileKind(f) != "yaml" {
			continue
		}
		role := parts[1]
		text := string(files[f])
		for _, m := range srcRE.FindAllStringSubmatch(text, -1) {
			src := m[1]
			if !strings.HasSuffix(src, ".j2") || strings.Contains(src, "{{") {
				continue
			}
			if _, ok := files["roles/"+role+"/templates/"+src]; ok {
				continue
			}
			if _, ok := files["templates/"+src]; ok {
				continue
			}
			res.add("error", f, lineOf(text, m[0]), "", "任务用到模板 %s，但 roles/%s/templates/ 与 templates/ 下都没有它", src, role)
		}
		if lookupRE.MatchString(text) {
			res.add("warning", f, lineOf(text, lookupRE.FindString(text)), "", "使用了 lookup/query：它在控制机上执行，预览与检查会跳过含它的模板")
		}
	}
}

func lineOf(text, needle string) int {
	i := strings.Index(text, needle)
	if i < 0 {
		return 0
	}
	return strings.Count(text[:i], "\n") + 1
}

var jinjaBlockRE = regexp.MustCompile(`\{%-?\s*(\w+)`)

// checkJinja finds the mistakes that make a template fail only on the target: unbalanced delimiters and blocks.
func checkJinja(res *compCheck, file, text string) {
	pairs := [][2]string{{"{{", "}}"}, {"{%", "%}"}, {"{#", "#}"}}
	for _, pr := range pairs {
		open, closeN := strings.Count(text, pr[0]), strings.Count(text, pr[1])
		if open != closeN {
			res.add("error", file, 0, "", "模板里 %s 有 %d 个，%s 有 %d 个，没有成对", pr[0], open, pr[1], closeN)
			return
		}
	}
	type frame struct {
		kind string
		line int
	}
	var stack []frame
	for _, m := range jinjaBlockRE.FindAllStringSubmatchIndex(text, -1) {
		word := text[m[2]:m[3]]
		line := strings.Count(text[:m[0]], "\n") + 1
		switch word {
		case "if", "for", "macro", "block", "call", "filter", "raw":
			stack = append(stack, frame{word, line})
		case "elif", "else":
			if len(stack) == 0 {
				res.add("error", file, line, "", "多出的 {%% %s %%}，前面没有 if 或 for", word)
				return
			}
		case "endif", "endfor", "endmacro", "endblock", "endcall", "endfilter", "endraw":
			want := strings.TrimPrefix(word, "end")
			if len(stack) == 0 || stack[len(stack)-1].kind != want {
				open := "没有对应的开头"
				if len(stack) > 0 {
					open = fmt.Sprintf("上一个未结束的是第 %d 行的 %s", stack[len(stack)-1].line, stack[len(stack)-1].kind)
				}
				res.add("error", file, line, "", "{%% %s %%} 对不上：%s", word, open)
				return
			}
			stack = stack[:len(stack)-1]
		}
	}
	if len(stack) > 0 {
		f := stack[len(stack)-1]
		res.add("error", file, f.line, "", "第 %d 行的 {%% %s %%} 没有结束", f.line, f.kind)
	}
}

// taskFileNames lists the task files of a role for the editor.
func taskFileNames(files fileSet, role string) []string {
	var out []string
	prefix := path.Join("roles", role, "tasks") + "/"
	for f := range files {
		if strings.HasPrefix(f, prefix) {
			out = append(out, strings.TrimSuffix(strings.TrimPrefix(f, prefix), ".yml"))
		}
	}
	sort.Strings(out)
	return out
}

const placeholderVersion = "REPLACE-WITH-LIBRARY-VERSION"

// checkPackages tells the author which packages the library cannot supply yet. A missing package is a warning (the
// library can be filled later); the template's placeholder version is an error, so it cannot be published unchanged.
func checkPackages(res *compCheck, p *platform, c *mwpack.Component, manifest *yaml.Node) {
	for vi, v := range c.Versions {
		for pi, pk := range v.Packages {
			at := fmt.Sprintf("versions[%s].packages[%d]", v.ID, pi)
			line := pathLine(manifest, fmt.Sprintf("versions[%d].packages[%d]", vi, pi))
			if pk.Version == placeholderVersion {
				res.add("error", "component.yaml", line, at, "软件包 %s 的版本还是模板里的占位符：到「版本」页签点「从软件库选择」，换成真实的版本", pk.Name)
				continue
			}
			plats := pk.Platforms
			if len(plats) == 0 {
				plats = v.Platforms
			}
			if p.lib == nil {
				continue
			}
			for _, pl := range plats {
				if !p.lib.Has(pl, mwpack.PackageRequest{Name: pk.Name, Version: pk.Version}) {
					res.add("warning", "component.yaml", line, at, "软件库里还没有 %s=%s（%s）：到「软件库」下载之后，这个版本才能生成交付", pk.Name, pk.Version, pl)
				}
			}
		}
	}
}

func uniqueLines(s string) string {
	seen := map[string]bool{}
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(l); t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return strings.Join(out, "\n")
}

// checkRunRefs finds steps that run a role task file the component does not have, and says where the step is.
func checkRunRefs(res *compCheck, c *mwpack.Component, files fileSet, manifest *yaml.Node) bool {
	missing := false
	// shown is the path in the form validation messages use (versions[3.5].lifecycle.install[0]); lookup is the same
	// place as a walk through the YAML document (versions.0.lifecycle.install.0).
	each := func(shown, lookup string, steps []mwpack.Step) {
		for i, st := range steps {
			if st.Run == nil || st.Run.Role == "" || st.Run.Tasks == "" {
				continue
			}
			want := path.Join("roles", st.Run.Role, "tasks", st.Run.Tasks+".yml")
			if _, ok := files[want]; ok || mwpack.PlatformTaskExists(st.Run.Role, st.Run.Tasks) {
				continue
			}
			missing = true
			res.add("error", "component.yaml", pathLine(manifest, fmt.Sprintf("%s.%d.run", lookup, i)), fmt.Sprintf("%s[%d].run", shown, i), "步骤「%s」要运行 %s，但组件里没有这个文件：到「文件」页签新建它，或改这一步的 run", st.ID, want)
		}
	}
	scope := func(shownBase, lookupBase string, lc map[string][]mwpack.Step, tests, cleanup []mwpack.Step) {
		for _, ph := range mwpack.Phases {
			each(shownBase+"lifecycle."+ph, lookupBase+"lifecycle."+ph, lc[ph])
		}
		each(shownBase+"tests", lookupBase+"tests", tests)
		each(shownBase+"cleanup", lookupBase+"cleanup", cleanup)
	}
	scope("", "", c.Lifecycle, c.Tests, c.Cleanup)
	for vi, v := range c.Versions {
		scope(fmt.Sprintf("versions[%s].", v.ID), fmt.Sprintf("versions.%d.", vi), v.Lifecycle, v.Tests, v.Cleanup)
	}
	return missing
}

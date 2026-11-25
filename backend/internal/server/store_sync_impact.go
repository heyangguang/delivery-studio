package server

import (
	"path"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Which steps a changed file touches, decided the strict way. This is production: a step that already ran must be run
// again unless it can be PROVEN that the change cannot reach it. Nothing is guessed from names or wording.
//
// A step is unaffected only when every changed file in what it runs is one of:
//
//   - a task file whose changed tasks cannot run for this step: each changed (or added, or removed) task is guarded by
//     a `when` that is false given the values the step's playbook fixes (for example pg_test == 'front-failover' is false
//     for the step that runs pg_test: failover). Tasks are compared as whole tasks, not as lines. The conditions are
//     evaluated, not read: anything the evaluator cannot decide counts as "may run";
//   - nothing else. Templates, scripts, defaults and any file the step uses that is not a task file cannot be shown
//     unrelated, so a change to one of them reaches every step that uses it.
//
// Where the earlier text of a file is not known, there is nothing to compare, so the change reaches the step. A person
// can still decide a step is not affected; that decision is recorded with their name and reason (see store_sync.go).

// walkYAML visits every mapping of a YAML document.
func walkYAML(n *yaml.Node, f func(m map[string]*yaml.Node)) {
	if n == nil {
		return
	}
	if n.Kind == yaml.MappingNode {
		m := map[string]*yaml.Node{}
		for i := 0; i+1 < len(n.Content); i += 2 {
			m[n.Content[i].Value] = n.Content[i+1]
		}
		f(m)
	}
	for _, c := range n.Content {
		walkYAML(c, f)
	}
}

func scalar(n *yaml.Node) string {
	if n == nil || n.Kind != yaml.ScalarNode {
		return ""
	}
	return n.Value
}

// closureOf is the files a playbook runs: itself, the task files of every role it imports (and what those include),
// and the templates and files those tasks name.
func closureOf(files map[string][]byte, playbook string) map[string]bool {
	out := map[string]bool{}
	if _, ok := files[playbook]; !ok {
		return out
	}
	out[playbook] = true
	type job struct{ role, tasks string }
	var queue []job
	seen := map[job]bool{}
	depsDone := map[string]bool{}
	scan := func(text []byte) {
		var doc yaml.Node
		if yaml.Unmarshal(text, &doc) != nil {
			return
		}
		walkYAML(&doc, func(m map[string]*yaml.Node) {
			for _, k := range []string{"ansible.builtin.import_role", "ansible.builtin.include_role", "import_role", "include_role"} {
				if r, ok := m[k]; ok && r.Kind == yaml.MappingNode {
					rm := map[string]string{}
					for i := 0; i+1 < len(r.Content); i += 2 {
						rm[r.Content[i].Value] = scalar(r.Content[i+1])
					}
					from := rm["tasks_from"]
					if from == "" {
						from = "main"
					}
					if rm["name"] != "" {
						queue = append(queue, job{rm["name"], strings.TrimSuffix(from, ".yml")})
					}
				}
			}
			if r, ok := m["roles"]; ok && r.Kind == yaml.SequenceNode {
				for _, x := range r.Content {
					name := scalar(x)
					if x.Kind == yaml.MappingNode {
						for i := 0; i+1 < len(x.Content); i += 2 {
							if x.Content[i].Value == "role" || x.Content[i].Value == "name" {
								name = x.Content[i+1].Value
							}
						}
					}
					if name != "" {
						queue = append(queue, job{name, "main"})
					}
				}
			}
		})
	}
	var texts []string
	scan(files[playbook])
	texts = append(texts, string(files[playbook]))
	for len(queue) > 0 {
		j := queue[0]
		queue = queue[1:]
		if seen[j] {
			continue
		}
		seen[j] = true
		if !depsDone[j.role] {
			depsDone[j.role] = true
			var meta yaml.Node
			if yaml.Unmarshal(files["roles/"+j.role+"/meta/main.yml"], &meta) == nil {
				walkYAML(&meta, func(m map[string]*yaml.Node) {
					if d, ok := m["dependencies"]; ok {
						for _, x := range d.Content {
							name := scalar(x)
							if x.Kind == yaml.MappingNode {
								for i := 0; i+1 < len(x.Content); i += 2 {
									if x.Content[i].Value == "role" || x.Content[i].Value == "name" {
										name = x.Content[i+1].Value
									}
								}
							}
							if name != "" {
								queue = append(queue, job{name, "main"})
							}
						}
					}
				})
			}
		}
		for _, ext := range []string{".yml", ".yaml"} {
			p := "roles/" + j.role + "/tasks/" + j.tasks + ext
			if b, ok := files[p]; ok && !out[p] {
				out[p] = true
				texts = append(texts, string(b))
				scan(b)
				// include_tasks / import_tasks of the same role
				var doc yaml.Node
				if yaml.Unmarshal(b, &doc) == nil {
					walkYAML(&doc, func(m map[string]*yaml.Node) {
						for _, k := range []string{"ansible.builtin.include_tasks", "ansible.builtin.import_tasks", "include_tasks", "import_tasks"} {
							if v, ok := m[k]; ok {
								name := scalar(v)
								if v.Kind == yaml.MappingNode {
									for i := 0; i+1 < len(v.Content); i += 2 {
										if v.Content[i].Value == "file" {
											name = v.Content[i+1].Value
										}
									}
								}
								if name != "" && !strings.Contains(name, "{{") {
									queue = append(queue, job{j.role, strings.TrimSuffix(strings.TrimSuffix(name, ".yml"), ".yaml")})
								}
							}
						}
					})
				}
			}
		}
	}
	all := strings.Join(texts, "\n")
	// templates and files of the roles involved, by the name the tasks give them
	roles := map[string]bool{}
	for p := range out {
		if strings.HasPrefix(p, "roles/") {
			roles[strings.SplitN(p, "/", 3)[1]] = true
		}
	}
	// a task that names its template or file by a variable, or by a pattern, may use any of the role's
	for p := range files {
		parts := strings.SplitN(p, "/", 4)
		if len(parts) < 3 || parts[0] != "roles" || !roles[parts[1]] {
			continue
		}
		switch parts[2] {
		case "templates", "files":
			if len(parts) == 4 && (dynamicSrc.MatchString(all) || strings.Contains(all, path.Base(p))) {
				out[p] = true
			}
		case "defaults", "vars", "meta", "handlers", "library", "module_utils", "filter_plugins", "lookup_plugins", "action_plugins":
			out[p] = true // read whenever the role is used
		}
	}
	return out
}

// A task names a template or file of its role by a variable (src: "{{ name }}.j2") or by a pattern; a source that is a
// path built from variables ("{{ dir }}/file") is a place on a machine, not a file of the role.
var dynamicSrc = regexp.MustCompile(`(?m)^\s*(src|with_fileglob|with_file)\s*:\s*['"]?\{\{[^}\n]*\}\}[^/\n]*['"]?\s*$|lookup\(\s*['"](file|template|fileglob)['"]`)

// globalFile is read by every Ansible run of the project.
func globalFile(p string) bool {
	return p == "ansible.cfg" || strings.HasPrefix(p, "callback_plugins/") || strings.HasPrefix(p, "filter_plugins/") ||
		strings.HasPrefix(p, "lookup_plugins/") || strings.HasPrefix(p, "library/") || strings.HasPrefix(p, "collections/") ||
		(strings.HasPrefix(p, "inventory/") && !isGroupVars(p))
}

func isGroupVars(p string) bool {
	return strings.HasPrefix(p, "inventory/group_vars/") || strings.HasPrefix(p, "inventory/host_vars/")
}

// usedBy is every file a playbook's run reads: what it runs (closureOf), the project-wide files, and the variable files.
func usedBy(files map[string][]byte, playbook string) map[string]bool {
	out := closureOf(files, playbook)
	if len(out) == 0 {
		return out
	}
	for p := range files {
		if globalFile(p) || isGroupVars(p) {
			out[p] = true
		}
	}
	return out
}

type tri int

const (
	unknown tri = iota
	yes
	no
)

// ---- a small evaluator for the conditions tasks are guarded with ----

type condToken struct{ kind, text string } // id, str, op, lp, rp, lb, rb, comma

func condLex(src string) ([]condToken, bool) {
	var out []condToken
	rs := []rune(src)
	for i := 0; i < len(rs); {
		c := rs[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n':
			i++
		case c == '\'' || c == '"':
			j := i + 1
			for j < len(rs) && rs[j] != c {
				j++
			}
			if j >= len(rs) {
				return nil, false
			}
			out = append(out, condToken{"str", string(rs[i+1 : j])})
			i = j + 1
		case c == '(':
			out = append(out, condToken{"lp", "("})
			i++
		case c == ')':
			out = append(out, condToken{"rp", ")"})
			i++
		case c == '[':
			out = append(out, condToken{"lb", "["})
			i++
		case c == ']':
			out = append(out, condToken{"rb", "]"})
			i++
		case c == ',':
			out = append(out, condToken{"comma", ","})
			i++
		case c == '=' && i+1 < len(rs) && rs[i+1] == '=':
			out = append(out, condToken{"op", "=="})
			i += 2
		case c == '!' && i+1 < len(rs) && rs[i+1] == '=':
			out = append(out, condToken{"op", "!="})
			i += 2
		case c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z':
			j := i
			for j < len(rs) && (rs[j] == '_' || rs[j] == '.' || rs[j] >= 'a' && rs[j] <= 'z' || rs[j] >= 'A' && rs[j] <= 'Z' || rs[j] >= '0' && rs[j] <= '9') {
				j++
			}
			out = append(out, condToken{"id", string(rs[i:j])})
			i = j
		default:
			return nil, false // anything else (filters, arithmetic, calls): not decided here
		}
	}
	return out, true
}

type condParser struct {
	t   []condToken
	i   int
	env map[string]string
}

func (p *condParser) peek() condToken {
	if p.i < len(p.t) {
		return p.t[p.i]
	}
	return condToken{}
}

func (p *condParser) isID(w string) bool { t := p.peek(); return t.kind == "id" && t.text == w }

func (p *condParser) or() tri {
	l := p.and()
	for p.isID("or") {
		p.i++
		r := p.and()
		switch {
		case l == yes || r == yes:
			l = yes
		case l == no && r == no:
			l = no
		default:
			l = unknown
		}
	}
	return l
}

func (p *condParser) and() tri {
	l := p.not()
	for p.isID("and") {
		p.i++
		r := p.not()
		switch {
		case l == no || r == no:
			l = no
		case l == yes && r == yes:
			l = yes
		default:
			l = unknown
		}
	}
	return l
}

func (p *condParser) not() tri {
	if p.isID("not") {
		p.i++
		switch p.not() {
		case yes:
			return no
		case no:
			return yes
		}
		return unknown
	}
	return p.atom()
}

// value is a variable the step fixes, a string, or a list of strings; ok is false for anything else.
func (p *condParser) value() (vals []string, known bool, list bool, ok bool) {
	t := p.peek()
	switch t.kind {
	case "str":
		p.i++
		return []string{t.text}, true, false, true
	case "id":
		p.i++
		if v, have := p.env[t.text]; have {
			return []string{v}, true, false, true
		}
		return nil, false, false, true
	case "lb":
		p.i++
		var out []string
		for {
			e := p.peek()
			if e.kind == "str" {
				out = append(out, e.text)
				p.i++
			} else {
				return nil, false, true, false
			}
			if p.peek().kind == "comma" {
				p.i++
				continue
			}
			break
		}
		if p.peek().kind != "rb" {
			return nil, false, true, false
		}
		p.i++
		return out, true, true, true
	}
	return nil, false, false, false
}

func (p *condParser) atom() tri {
	if p.peek().kind == "lp" {
		p.i++
		v := p.or()
		if p.peek().kind == "rp" {
			p.i++
			return v
		}
		p.i = len(p.t) + 1
		return unknown
	}
	l, lk, _, ok := p.value()
	if !ok {
		p.i = len(p.t) + 1
		return unknown
	}
	t := p.peek()
	neg := false
	switch {
	case t.kind == "op" && (t.text == "==" || t.text == "!="):
		p.i++
		neg = t.text == "!="
		r, rk, rl, ok := p.value()
		if !ok || rl {
			p.i = len(p.t) + 1
			return unknown
		}
		if !lk || !rk {
			return unknown
		}
		if (l[0] == r[0]) != neg {
			return yes
		}
		return no
	case p.isID("in") || p.isID("not"):
		if p.isID("not") {
			p.i++
			if !p.isID("in") {
				p.i = len(p.t) + 1
				return unknown
			}
			neg = true
		}
		p.i++
		r, rk, rl, ok := p.value()
		if !ok || !rl || !rk {
			p.i = len(p.t) + 1
			return unknown
		}
		if !lk {
			return unknown
		}
		in := false
		for _, x := range r {
			in = in || x == l[0]
		}
		if in != neg {
			return yes
		}
		return no
	}
	// a bare name or anything else we cannot decide
	return unknown
}

// evalWhen decides a `when` condition (a string, or a list that must all hold) given the values a step fixes.
func evalWhen(when *yaml.Node, env map[string]string) tri {
	if when == nil {
		return yes
	}
	var conds []string
	switch when.Kind {
	case yaml.ScalarNode:
		conds = []string{when.Value}
	case yaml.SequenceNode:
		for _, c := range when.Content {
			conds = append(conds, c.Value)
		}
	default:
		return unknown
	}
	res := yes
	for _, c := range conds {
		toks, ok := condLex(c)
		if !ok {
			res = unknown
			continue
		}
		p := &condParser{t: toks, env: env}
		v := p.or()
		if p.i != len(toks) {
			v = unknown
		}
		switch {
		case v == no:
			return no
		case v == unknown:
			res = unknown
		}
	}
	return res
}

// ---- tasks compared as tasks ----

type flatTask struct {
	name string
	dump string
	when []*yaml.Node // the conditions of the task and of every block around it
}

func dumpNode(n *yaml.Node) string {
	b, _ := yaml.Marshal(n)
	return string(b)
}

// flattenTasks lists every task of a task file (blocks, rescue and always included) with the conditions that guard it.
func flattenTasks(n *yaml.Node, guards []*yaml.Node, out *[]flatTask) bool {
	switch n.Kind {
	case yaml.DocumentNode:
		for _, c := range n.Content {
			if !flattenTasks(c, guards, out) {
				return false
			}
		}
	case yaml.SequenceNode:
		for _, c := range n.Content {
			if c.Kind != yaml.MappingNode {
				return false
			}
			var name string
			var when *yaml.Node
			var nested []*yaml.Node
			for i := 0; i+1 < len(c.Content); i += 2 {
				switch c.Content[i].Value {
				case "name":
					name = c.Content[i+1].Value
				case "when":
					when = c.Content[i+1]
				case "block", "rescue", "always":
					nested = append(nested, c.Content[i+1])
				}
			}
			g := guards
			if when != nil {
				g = append(append([]*yaml.Node{}, guards...), when)
			}
			if len(nested) > 0 {
				// the block as a whole (its own keys) and every task inside it
				*out = append(*out, flatTask{name: name + " [block]", dump: dumpWithout(c), when: g})
				for _, nn := range nested {
					if !flattenTasks(nn, g, out) {
						return false
					}
				}
				continue
			}
			*out = append(*out, flatTask{name: name, dump: dumpNode(c), when: g})
		}
	default:
		return false
	}
	return true
}

// dumpWithout is a block task without the tasks inside it: only its own settings.
func dumpWithout(c *yaml.Node) string {
	cp := &yaml.Node{Kind: yaml.MappingNode}
	for i := 0; i+1 < len(c.Content); i += 2 {
		switch c.Content[i].Value {
		case "block", "rescue", "always":
			continue
		}
		cp.Content = append(cp.Content, c.Content[i], c.Content[i+1])
	}
	return dumpNode(cp)
}

// taskFileReaches says whether a change between two versions of a task file can run for a step that fixes env. The
// reason names what could not be ruled out.
func taskFileReaches(old, now []byte, env map[string]string) (bool, string) {
	var a, b yaml.Node
	if yaml.Unmarshal(old, &a) != nil || yaml.Unmarshal(now, &b) != nil {
		return true, "文件解析不了，无法比较"
	}
	var ta, tb []flatTask
	if !flattenTasks(&a, nil, &ta) || !flattenTasks(&b, nil, &tb) {
		return true, "文件结构不是任务列表，无法逐个任务比较"
	}
	count := map[string]int{}
	for _, t := range ta {
		count[t.dump]++
	}
	var diff []flatTask
	for _, t := range tb {
		if count[t.dump] > 0 {
			count[t.dump]--
			continue
		}
		diff = append(diff, t)
	}
	removed := map[string]int{}
	for _, t := range tb {
		removed[t.dump]++
	}
	for _, t := range ta {
		if removed[t.dump] > 0 {
			removed[t.dump]--
			continue
		}
		diff = append(diff, t)
	}
	for _, t := range diff {
		runs := yes
		for _, w := range t.when {
			switch evalWhen(w, env) {
			case no:
				runs = no
			case unknown:
				if runs != no {
					runs = unknown
				}
			}
		}
		if runs != no {
			return true, "任务「" + strings.TrimSpace(t.name) + "」有改动，并且对这一步可能执行"
		}
	}
	return false, ""
}

// stepEnv is what a step's playbook fixes: the plain values of the variables of its plays.
func stepEnv(files map[string][]byte, playbook string) map[string]string {
	env := map[string]string{}
	var doc yaml.Node
	if yaml.Unmarshal(files[playbook], &doc) != nil {
		return env
	}
	clash := map[string]bool{}
	walkYAML(&doc, func(m map[string]*yaml.Node) {
		if v, ok := m["vars"]; ok && v.Kind == yaml.MappingNode {
			for i := 0; i+1 < len(v.Content); i += 2 {
				k, s := v.Content[i].Value, scalar(v.Content[i+1])
				if s == "" || strings.Contains(s, "{{") {
					clash[k] = true // not a plain value: not fixed
					continue
				}
				if prev, seen := env[k]; seen && prev != s {
					clash[k] = true // plays that disagree: not fixed for the playbook as a whole
				}
				env[k] = s
			}
		}
	})
	for k := range clash {
		delete(env, k)
	}
	return env
}

func isTaskFile(p string) bool {
	return strings.HasPrefix(p, "roles/") && strings.Contains(p, "/tasks/") && (strings.HasSuffix(p, ".yml") || strings.HasSuffix(p, ".yaml"))
}

// stepImpact says whether a change reaches a step, and why when it does.
type stepImpact struct {
	Changed bool
	Why     string
}

func impactOf(steps []reportStep, before map[string]reportStep, oldFiles, newFiles map[string][]byte, changed map[string]bool) map[string]stepImpact {
	out := map[string]stepImpact{}
	for _, st := range steps {
		o, had := before[stepIdentity(st)]
		var im stepImpact
		switch {
		case !had:
			im = stepImpact{true, "新增的步骤"}
		case o.Command != st.Command || o.Playbook != st.Playbook:
			im = stepImpact{true, "命令或 Playbook 变了"}
		case st.Playbook == "":
			// a step that is only a command: the command is all there is
		default:
			env := stepEnv(newFiles, st.Playbook)
			closure := usedBy(newFiles, st.Playbook)
			// Removed dependencies still belong to the old execution contract.
			for f := range usedBy(oldFiles, o.Playbook) {
				closure[f] = true
			}
			// what the step runs, without the file being judged (a variable is always named where it is defined)
			textWithout := func(self string) map[string]string {
				out := map[string]string{}
				for g := range closure {
					if t := templatedText(g, newFiles[g]); g != self && t != "" {
						out[g] = t
					}
				}
				return reachableVariableTexts(out)
			}
			var files []string
			for f := range closure {
				if changed[f] {
					files = append(files, f)
				}
			}
			sort.Strings(files)
			var reasons []string
			for _, f := range files {
				why := ""
				switch {
				case f == st.Playbook:
					why = "它自己的 Playbook " + f + " 有改动"
				case isTaskFile(f) && oldFiles[f] != nil && newFiles[f] != nil:
					if hit, w := taskFileReaches(oldFiles[f], newFiles[f], env); hit {
						why = f + "：" + w
					}
				case isTaskFile(f):
					why = f + " 是新增或删除的依赖文件"
				case isVarsFile(f) && oldFiles[f] != nil && newFiles[f] != nil:
					if hit, w := varsReach(oldFiles[f], newFiles[f], textWithout(f)); hit {
						why = f + "：" + w
					}
				case isVarsFile(f):
					why = f + " 是新增或删除的依赖文件"
				case globalFile(f):
					why = f + " 对项目里每一次 Ansible 执行都生效，无法证明与这一步无关"
				case strings.HasSuffix(f, ".py") && strings.Contains(f, "/files/") && oldFiles[f] != nil && newFiles[f] != nil:
					action, known := actionOf(newFiles, closure, f, env)
					if !known {
						why = f + " 是这一步用到的脚本，分析不出这一步让它执行哪个动作，无法证明改动与它无关"
						break
					}
					hit, w, ok := pyReaches(oldFiles[f], newFiles[f], action)
					switch {
					case !ok:
						why = f + " 是这一步用到的脚本，无法逐函数分析（" + firstNonEmptyStr(w, "分析程序不可用") + "），无法证明改动与它无关"
					case hit:
						why = f + "：" + w
					}
				default:
					why = f + " 是这一步用到的文件（模板、脚本或变量），无法证明改动与这一步无关"
				}
				if why != "" {
					reasons = append(reasons, why)
				}
			}
			if len(reasons) > 0 {
				im = stepImpact{true, strings.Join(reasons, "\n")}
			}
		}
		out[st.Key] = im
	}
	return out
}

var jinjaComment = regexp.MustCompile(`(?s)\{#.*?#\}`)

// templatedText is the part of a file in which variables can be read: YAML and Jinja files, without their comments. A
// script that is copied as it is (files/*.py, *.sh) sees no variable; what it knows reaches it through a template or its
// arguments, which are themselves read.
func templatedText(name string, b []byte) string {
	switch {
	case strings.HasSuffix(name, ".yml"), strings.HasSuffix(name, ".yaml"), strings.HasSuffix(name, ".j2"), strings.HasSuffix(name, ".jinja"):
	default:
		return ""
	}
	t := jinjaComment.ReplaceAllString(string(b), "")
	if !strings.HasSuffix(name, ".j2") {
		var keep []string
		for _, l := range strings.Split(t, "\n") {
			if !strings.HasPrefix(strings.TrimSpace(l), "#") {
				keep = append(keep, l)
			}
		}
		t = strings.Join(keep, "\n")
	}
	return t
}

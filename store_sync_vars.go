package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Variable files (inventory group_vars and the defaults/vars of a role): a change reaches a step only if the step reads
// the variable that changed. Decided by the path of the change, not by the file:
//
//   - a changed value is a leaf of the mapping, e.g. mw_instances.pg.params.test_sslmode;
//   - the plays of this project take their instance from the mapping by a literal id (mw: mw_instances['pg']), so a
//     change inside instance X reaches only steps that bind X (a step that reaches into mw_instances any other way is
//     not provable);
//   - below that the step reaches the change if it names the leaf, names the whole path (mw.params.test_sslmode), or
//     uses a part of the path as a whole value (mw.params | to_json, loop over mw.params, mw passed on as a variable) or
//     with a computed key;
//   - a variable built from a changed one counts as changed.
//
// Looking variables up by a computed name (lookup('vars', …), vars[…]) or loading further variable files cannot be
// followed, so such a step is never called unaffected.

var dynamicVars = regexp.MustCompile(`lookup\(\s*['"]vars['"]|query\(\s*['"]vars['"]|\bvars\s*\[|\bvars\.get\(|include_vars|vars_files`)

func wordIn(text, w string) bool {
	if w == "" {
		return false
	}
	re := regexp.MustCompile(`(^|[^A-Za-z0-9_])` + regexp.QuoteMeta(w) + `($|[^A-Za-z0-9_])`)
	return re.MatchString(text)
}

// isVarsFile is a file of variables a play reads: project group/host vars, a role's defaults and vars.
func isVarsFile(p string) bool {
	if isGroupVars(p) {
		return true
	}
	if !strings.HasPrefix(p, "roles/") || !(strings.HasSuffix(p, ".yml") || strings.HasSuffix(p, ".yaml")) {
		return false
	}
	parts := strings.SplitN(p, "/", 4)
	return len(parts) == 4 && (parts[2] == "defaults" || parts[2] == "vars")
}

// changedPaths lists where two YAML values differ, down to the leaf. Lists are compared whole.
func changedPaths(a, b any, path []string, out *[][]string) {
	am, aok := a.(map[string]any)
	bm, bok := b.(map[string]any)
	if aok && bok {
		keys := map[string]bool{}
		for k := range am {
			keys[k] = true
		}
		for k := range bm {
			keys[k] = true
		}
		for k := range keys {
			av, ain := am[k]
			bv, bin := bm[k]
			switch {
			case !ain || !bin:
				*out = append(*out, append(append([]string{}, path...), k))
			default:
				changedPaths(av, bv, append(append([]string{}, path...), k), out)
			}
		}
		return
	}
	if fmt.Sprintf("%v", a) != fmt.Sprintf("%v", b) {
		*out = append(*out, append([]string{}, path...))
	}
}

// chainUsed says whether text uses the dotted chain as a whole value: nothing is taken from it by name (it is passed
// on, looped over, piped), or the key is computed (chain[...]). A use like chain.name is not a whole use.
func chainUsed(text, chain string) bool {
	// Ignore bare literal service-name prefixes, while retaining expressions
	// such as mw - other (and mw-other) as whole-object uses.
	literal := regexp.MustCompile("['\"]+" + regexp.QuoteMeta(chain) + "-[A-Za-z0-9_-]*['\"]+")
	text = literal.ReplaceAllString(text, "''")
	re := regexp.MustCompile(`(^|[^A-Za-z0-9_.])` + regexp.QuoteMeta(chain) + `([^A-Za-z0-9_]|$)`)
	for _, m := range re.FindAllStringSubmatchIndex(text, -1) {
		if m[4] < 0 || m[4] >= len(text) || text[m[4]] != '.' {
			return true
		}
	}
	return false
}

var bindingLine = regexp.MustCompile(`\b(mw|mw_manager)\s*:\s*['"]*\{\{\s*mw_instances\s*\[\s*['"]+[^'"\]]+['"]+\s*\]\s*\}\}['"]*`)

var instanceBinding = regexp.MustCompile(`mw_instances\s*\[\s*['"]+([^'"\]]+)['"]+\s*\]`)

// usedIn says in which of the files the path below base is read: its leaf is named, or a part of it is used as a whole.
func usedIn(texts map[string]string, base string, sub []string) string {
	names := make([]string, 0, len(texts))
	for n := range texts {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		t := texts[n]
		if len(sub) == 0 {
			if wordIn(t, base) {
				return n
			}
			continue
		}
		if wordIn(t, sub[len(sub)-1]) {
			return n
		}
		chain := base
		if chainUsed(t, chain) {
			return n
		}
		for k := 0; k < len(sub)-1; k++ {
			chain += "." + sub[k]
			if chainUsed(t, chain) {
				return n
			}
		}
	}
	return ""
}

// varsReach says whether the change between two versions of a variable file can reach a step that reads the given
// files (what the step runs, without the variable file itself), and where.
func varsReach(old, now []byte, texts map[string]string) (bool, string) {
	var a, b map[string]any
	if yaml.Unmarshal(old, &a) != nil || yaml.Unmarshal(now, &b) != nil {
		return true, "变量文件解析不了，无法比较"
	}
	joined := ""
	for _, t := range texts {
		joined += t + "\n"
	}
	if dynamicVars.MatchString(joined) {
		return true, "这一步按变量名动态取值，无法证明改动的变量与它无关"
	}
	var paths [][]string
	changedPaths(a, b, nil, &paths)
	// a variable built from a changed one has changed too
	changedTop := map[string]bool{}
	for _, p := range paths {
		changedTop[p[0]] = true
	}
	for grew := true; grew; {
		grew = false
		for k, v := range b {
			if changedTop[k] {
				continue
			}
			for c := range changedTop {
				if c != "mw_instances" && wordIn(fmt.Sprintf("%v", v), c) {
					changedTop[k], grew = true, true
					paths = append(paths, []string{k})
					break
				}
			}
		}
	}
	bound := map[string][]string{}
	for _, m := range bindingLine.FindAllStringSubmatch(joined, -1) {
		instance := instanceBinding.FindStringSubmatch(m[0])
		if len(instance) > 1 {
			bound[instance[1]] = append(bound[instance[1]], m[1])
		}
	}
	// the binding itself (mw: mw_instances['pg']) is where the instance is picked, not a use of its contents
	clean := map[string]string{}
	for n, t := range texts {
		clean[n] = bindingLine.ReplaceAllString(t, "")
	}
	var why []string
	for _, p := range paths {
		desc := strings.Join(p, ".")
		base, sub := p[0], p[1:]
		if base == "mw_hosts" && len(p) >= 2 {
			// Selecting the current host is not reading all fields of that host.
			// Track the parameter leaf instead of treating the computed host key as a whole-map read.
			currentHost := regexp.MustCompile("mw_hosts\\s*\\[\\s*inventory_hostname\\s*\\]")
			scoped := map[string]string{}
			remaining := map[string]string{}
			for name, text := range clean {
				scoped[name] = currentHost.ReplaceAllString(text, "mw_selected_host")
				rest := currentHost.ReplaceAllString(text, "mw_selected_host")
				if wordIn(rest, "mw_hosts") {
					remaining[name] = rest
				}
			}
			if f := usedIn(scoped, "mw_selected_host", p[2:]); f != "" {
				why = append(why, desc+"（在 "+f+" 中读取机器字段）")
			} else if f := usedIn(remaining, base, sub); f != "" {
				why = append(why, desc+"（在 "+f+" 中读取机器集合）")
			}
			continue
		}
		if base == "mw_instances" {
			for n, t := range clean {
				if strings.Contains(instanceBinding.ReplaceAllString(t, ""), "mw_instances") {
					why = append(why, desc+"（"+n+" 不指明实例地读取 mw_instances）")
					break
				}
			}
			if len(p) >= 2 {
				for n, t := range clean {
					for _, m := range instanceBinding.FindAllStringSubmatch(t, -1) {
						if m[1] == p[1] {
							why = append(why, desc+"（在 "+n+" 中直接读取实例）")
						}
					}
				}
			}
			if len(p) < 2 || len(bound[p[1]]) == 0 {
				continue // the instance is not one this step works on
			}
			sub = p[2:]
			for _, alias := range bound[p[1]] {
				scoped := map[string]string{}
				other := "mw_manager"
				if alias == other {
					other = "mw"
				}
				// Literal paths under the other context cannot be reads of this
				// instance, even when their parameter names happen to coincide.
				re := regexp.MustCompile("\\b" + other + "\\b(?:\\.[A-Za-z_][A-Za-z0-9_]*|\\[[^]\\n]*\\])*")
				for n, t := range clean {
					scoped[n] = re.ReplaceAllString(t, "")
				}
				if f := usedIn(scoped, alias, sub); f != "" {
					why = append(why, desc+"（在 "+f+" 中用到）")
				}
			}
			continue
		}
		if f := usedIn(clean, base, sub); f != "" {
			why = append(why, desc+"（在 "+f+" 中用到）")
		}
	}
	if len(why) == 0 {
		return false, ""
	}
	sort.Strings(why)
	if len(why) > 3 {
		why = append(why[:3], fmt.Sprintf("等 %d 项", len(why)))
	}
	return true, "变量 " + strings.Join(why, "；") + " 有改动"
}

// reachableVariableTexts models Ansible's lazy variables: merely defining a
// setting in role defaults does not mean every task reads that setting.
func reachableVariableTexts(texts map[string]string) map[string]string {
	out := map[string]string{}
	type definition struct{ file, key, text string }
	var defs []definition
	for file, text := range texts {
		if !isVarsFile(file) {
			out[file] = text
			continue
		}
		var values map[string]any
		if yaml.Unmarshal([]byte(text), &values) != nil {
			out[file] = text
			continue
		}
		for key, value := range values {
			b, err := yaml.Marshal(map[string]any{key: value})
			if err == nil {
				defs = append(defs, definition{file, key, string(b)})
			}
		}
	}
	sort.Slice(defs, func(i, j int) bool { return defs[i].file+"/"+defs[i].key < defs[j].file+"/"+defs[j].key })
	active := map[int]bool{}
	for changed := true; changed; {
		changed = false
		all := ""
		for _, text := range out {
			all += text + "\n"
		}
		if dynamicVars.MatchString(all) {
			return texts
		}
		for i, d := range defs {
			if !active[i] && wordIn(all, d.key) {
				out[d.file] += d.text
				active[i] = true
				changed = true
			}
		}
	}
	return out
}

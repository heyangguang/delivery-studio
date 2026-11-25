package mwpack

import (
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/nikolalohinski/gonja/v2/builtins"
	"github.com/nikolalohinski/gonja/v2/config"
	"github.com/nikolalohinski/gonja/v2/exec"
	"github.com/nikolalohinski/gonja/v2/loaders"
	"gopkg.in/yaml.v3"
)

// Commands in a report are worth reading only with the values filled in. This renders the Jinja in a step's
// commands the way Ansible would for one machine, from the same variables the delivery carries: group_vars, the
// role's defaults and vars, and the instance. What only exists at run time (a registered result, a generated
// password) stays as it is, or as a short placeholder for passwords, and is never guessed.

var distillEnv = func() *exec.Environment {
	f := exec.NewFilterSet(map[string]exec.FilterFunction{}).Update(builtins.Filters)
	_ = f.Register("bool", func(e *exec.Evaluator, in *exec.Value, p *exec.VarArgs) *exec.Value {
		if in.IsString() {
			switch strings.ToLower(strings.TrimSpace(in.String())) {
			case "true", "yes", "1", "on":
				return exec.AsValue(true)
			}
			return exec.AsValue(false)
		}
		return exec.AsValue(in.Bool())
	})
	_ = f.Register("regex_replace", func(e *exec.Evaluator, in *exec.Value, p *exec.VarArgs) *exec.Value {
		var pat, rep string
		if len(p.Args) > 0 {
			pat = p.Args[0].String()
		}
		if len(p.Args) > 1 {
			rep = p.Args[1].String()
		}
		re, err := regexp.Compile(pat)
		if err != nil {
			return exec.AsValue(exec.ErrInvalidCall(err))
		}
		return exec.AsValue(re.ReplaceAllString(in.String(), regexp.MustCompile(`\\(\d)`).ReplaceAllString(rep, "$${$1}")))
	})
	_ = f.Register("mandatory", func(e *exec.Evaluator, in *exec.Value, p *exec.VarArgs) *exec.Value { return in })
	return &exec.Environment{Context: exec.EmptyContext(), Filters: f, Tests: builtins.Tests, ControlStructures: builtins.ControlStructures, Methods: builtins.Methods}
}()

func hasJinja(s string) bool { return strings.Contains(s, "{{") || strings.Contains(s, "{%") }

var reExpr = regexp.MustCompile(`\{\{.*?\}\}`)

// jinja renders s, or reports that it cannot (an unknown variable, filter or function).
func jinja(s string, vars map[string]any) (string, bool) {
	cfg := config.New()
	cfg.StrictUndefined = true
	cfg.TrimBlocks = true
	loader, err := loaders.NewMemoryLoader(map[string]string{"/t": s})
	if err != nil {
		return s, false
	}
	t, err := exec.NewTemplate("/t", cfg, loader, distillEnv)
	if err != nil {
		return s, false
	}
	out, err := t.ExecuteToString(exec.NewContext(vars))
	if err != nil {
	}
	if err != nil || hasJinja(out) {
		return s, false
	}
	return out, true
}

// fill renders what can be rendered: the whole text if possible, otherwise each {{ }} on its own.
func fill(s string, vars map[string]any) string {
	if !hasJinja(s) {
		return s
	}
	if out, ok := jinja(s, vars); ok {
		return out
	}
	return reExpr.ReplaceAllStringFunc(s, func(m string) string {
		out, _ := jinja(m, vars)
		return out
	})
}

// resolveAll renders every string inside v.
func resolveAll(v any, vars map[string]any) any {
	switch x := v.(type) {
	case string:
		// a value that is one expression keeps its type (a list stays a list), as it does in Ansible
		if t := strings.TrimSpace(x); strings.HasPrefix(t, "{{") && strings.HasSuffix(t, "}}") && strings.Count(t, "{{") == 1 {
			if out, ok := jinja("{{ ("+strings.TrimSpace(t[2:len(t)-2])+") | tojson }}", vars); ok {
				var typed any
				if json.Unmarshal([]byte(out), &typed) == nil {
					if _, isString := typed.(string); !isString && typed != nil {
						return wholeNumbers(typed)
					}
				}
			}
		}
		return fill(x, vars)
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = resolveAll(e, vars)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = resolveAll(e, vars)
		}
		return out
	}
	return v
}

func readYAMLMap(files map[string]File, name string) map[string]any {
	f, ok := files[name]
	if !ok {
		return nil
	}
	var m map[string]any
	if yaml.Unmarshal(f.Data, &m) != nil {
		return nil
	}
	return m
}

// secretsHidden replaces every instance's passwords with a note, so no value of theirs can end up in a report.
func secretsHidden(all map[string]any) {
	insts, _ := all["mw_instances"].(map[string]any)
	for id, iv := range insts {
		m, ok := iv.(map[string]any)
		if !ok {
			continue
		}
		if sec, ok := m["secrets"].(map[string]any); ok {
			for k := range sec {
				sec[k] = "<密码：控制节点 secrets/" + id + "/" + k + ">"
			}
		}
	}
}

// varsFor is the variables of one step on one machine, with the ones that refer to each other worked out.
func varsFor(files map[string]File, projectDir string, s *PlanStep, host string) map[string]any {
	ctx := readYAMLMap(files, "inventory/group_vars/all.yml")
	if ctx == nil {
		return nil
	}
	secretsHidden(ctx)
	roles := [][2]string{}
	for _, tf := range s.taskFiles() {
		roles = append(roles, tf)
	}
	if s.step.Run != nil {
		roles = append([][2]string{{s.step.Run.Role, ""}}, roles...)
	}
	for _, r := range roles {
		for _, sub := range []string{"defaults", "vars"} {
			for k, v := range readYAMLMap(files, path.Join("roles", r[0], sub, "main.yml")) {
				ctx[k] = v
			}
		}
	}
	if s.step.Run != nil {
		for k, v := range s.step.Run.Vars {
			ctx[k] = v
		}
	}
	ctx["inventory_hostname"] = host
	ctx["inventory_dir"] = path.Join(projectDir, "inventory")
	if s.inst != nil {
		if insts, ok := ctx["mw_instances"].(map[string]any); ok {
			ctx["mw"] = insts[s.inst.ID]
		}
	}
	// variables defined in terms of one another settle after a few rounds; what cannot be worked out stays as text
	for i := 0; i < 5; i++ {
		next := resolveAll(ctx, ctx).(map[string]any)
		same := fmt.Sprint(next) == fmt.Sprint(ctx)
		ctx = next
		if same {
			break
		}
	}
	return ctx
}

// expandLoop lists the items a task loops over, when they can be worked out.
func expandLoop(t map[string]any, vars map[string]any) ([]any, bool) {
	if wd, ok := t["with_dict"]; ok {
		resolved := resolveAll(wd, vars)
		if m, ok := resolved.(map[string]any); ok && len(m) > 0 {
			keys := make([]string, 0, len(m))
			for k := range m {
				keys = append(keys, k)
			}
			for i := 0; i < len(keys); i++ {
				for j := i + 1; j < len(keys); j++ {
					if keys[j] < keys[i] {
						keys[i], keys[j] = keys[j], keys[i]
					}
				}
			}
			out := make([]any, 0, len(keys))
			for _, k := range keys {
				out = append(out, map[string]any{"key": k, "value": m[k]})
			}
			return out, true
		}
	}
	raw, ok := t["loop"]
	if !ok {
		raw, ok = t["with_items"]
	}
	if !ok {
		return nil, false
	}
	switch x := raw.(type) {
	case []any:
		out := resolveAll(x, vars).([]any)
		return out, true
	case string:
		expr := strings.Trim(strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(x), "{{"), "}}")), " ")
		if strings.HasSuffix(expr, "| dict2items") || strings.HasSuffix(expr, "|dict2items") {
			base := strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(expr, "dict2items"), "|"))
			if m, ok := resolveAll("{{ "+base+" }}", vars).(map[string]any); ok && len(m) > 0 {
				keys := make([]string, 0, len(m))
				for k := range m {
					keys = append(keys, k)
				}
				for i := 0; i < len(keys); i++ {
					for j := i + 1; j < len(keys); j++ {
						if keys[j] < keys[i] {
							keys[i], keys[j] = keys[j], keys[i]
						}
					}
				}
				out := make([]any, 0, len(keys))
				for _, k := range keys {
					out = append(out, map[string]any{"key": k, "value": m[k]})
				}
				return out, true
			}
		}
		if out, ok := jinja("{{ ("+expr+") | tojson }}", vars); ok {
			var l []any
			if json.Unmarshal([]byte(out), &l) == nil {
				return wholeNumbers(l).([]any), true
			}
		}
	}
	return nil, false
}

// holds reports whether a task's condition is true on this machine; known is false when it cannot be told.
func holds(when any, vars map[string]any) (val, known bool) {
	var conds []string
	switch w := when.(type) {
	case string:
		conds = []string{w}
	case []any:
		for _, x := range w {
			conds = append(conds, fmt.Sprint(x))
		}
	case bool:
		return w, true
	default:
		return true, true
	}
	all, unknown := true, false
	for _, c := range conds {
		out, ok := jinja("{{ ("+c+") }}", vars)
		if !ok {
			unknown = true
			continue
		}
		if strings.TrimSpace(out) != "True" {
			all = false
		}
	}
	if !all {
		return false, true // one false condition decides, whatever the others are
	}
	return true, !unknown
}

// argvText is a command given as a list expression (a list, or lists added together) written as a command line.
func argvText(expr string, vars map[string]any) (string, bool) {
	e := strings.TrimSpace(expr)
	if !strings.HasPrefix(e, "{{") || !strings.HasSuffix(e, "}}") {
		return "", false
	}
	e = strings.TrimSpace(e[2 : len(e)-2])
	var parts []string
	depth, quote, start := 0, byte(0), 0
	for i := 0; i < len(e); i++ {
		c := e[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '\'' || c == '"':
			quote = c
		case c == '[' || c == '(':
			depth++
		case c == ']' || c == ')':
			depth--
		case c == '+' && depth == 0:
			parts = append(parts, e[start:i])
			start = i + 1
		}
	}
	parts = append(parts, e[start:])
	var words []string
	for _, p := range parts {
		out, ok := jinja("{{ ("+strings.TrimSpace(p)+") | tojson }}", vars)
		if !ok {
			return "", false
		}
		var l []any
		if json.Unmarshal([]byte(out), &l) != nil {
			return "", false
		}
		l = wholeNumbers(l).([]any)
		for _, w := range l {
			t := fmt.Sprint(w)
			if t == "" || strings.ContainsAny(t, " \t\"'$&|;<>*?()") {
				t = "'" + strings.ReplaceAll(t, "'", `'\''`) + "'"
			}
			words = append(words, t)
		}
	}
	return strings.Join(words, " "), true
}

// wholeNumbers turns the floats JSON decoding makes of integers back into integers, so 6379 is not shown as 6379.0.
func wholeNumbers(v any) any {
	switch x := v.(type) {
	case float64:
		if x == float64(int64(x)) {
			return int64(x)
		}
	case []any:
		for i := range x {
			x[i] = wholeNumbers(x[i])
		}
	case map[string]any:
		for k := range x {
			x[k] = wholeNumbers(x[k])
		}
	}
	return v
}

var reSimpleVar = regexp.MustCompile(`^[A-Za-z_][\w]*(\.[A-Za-z_]\w*)*$`)

// placeholders turns what could not be worked out into a placeholder in the manuals' style: <path> instead of
// {{ item.path }}. Such a value only exists once the earlier commands have run; the result recorded for the step
// (or the uploaded log) shows it.
func placeholders(cmd string) string {
	return reExpr.ReplaceAllStringFunc(cmd, func(m string) string {
		e := strings.TrimSpace(m[2 : len(m)-2])
		if reSimpleVar.MatchString(e) {
			if i := strings.LastIndex(e, "."); i >= 0 {
				e = e[i+1:]
			}
			return "<" + strings.TrimPrefix(e, "mw_") + ">"
		}
		return "<执行时得到的值>"
	})
}

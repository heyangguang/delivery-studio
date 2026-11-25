package server

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// Function-level analysis of a helper script a task runs with an action name (pgtest.py CONFIG NODE ACTION). The script
// is parsed, not read: what ACTION runs is the module's own statements plus the function the dispatch table names for
// it plus every function those call, transitively. A step is reached only if one of those parts differs between the
// two versions of the script. Anything the analysis cannot prove (a script that does not parse, no recognisable
// dispatch table, calls by computed name, no Python on the hub) counts as "reached" — the caller then treats the whole
// file as shared.

const pyAnalyzer = `
import ast, json, sys
d = json.load(sys.stdin)
action = d["action"]
DYN = {"globals", "locals", "vars", "eval", "exec", "__import__", "getattr", "importlib"}

def parse(t):
    return ast.parse(t)

def split(tree):
    defs, glob = {}, []
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defs[n.name] = n
        else:
            glob.append(n)
    return defs, glob

def table_of(glob):
    found = []
    for i, n in enumerate(glob):
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and isinstance(n.value, ast.Dict):
            keys = [k.value if isinstance(k, ast.Constant) and isinstance(k.value, str) else None for k in n.value.keys]
            if None not in keys and action in keys:
                found.append((i, n.targets[0].id, dict(zip(keys, n.value.values))))
    return found[0] if len(found) == 1 else None

def names(node):
    return {x.id for x in ast.walk(node) if isinstance(x, ast.Name)}

def const_set(glob, name):
    for n in glob:
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and n.targets[0].id == name and isinstance(n.value, (ast.Set, ast.List, ast.Tuple)):
            if all(isinstance(e, ast.Constant) for e in n.value.elts):
                return [e.value for e in n.value.elts]
    return None

def live_names(node, glob, avar):
    """names a module-level statement refers to when run for this action; an if on the action is decided when it can be"""
    if isinstance(node, ast.If):
        t = node.test
        verdict = None
        if isinstance(t, ast.Compare) and len(t.ops) == 1 and isinstance(t.left, ast.Name) and t.left.id == avar:
            c = t.comparators[0]
            if isinstance(t.ops[0], ast.In) and isinstance(c, ast.Name):
                s = const_set(glob, c.id)
                if s is not None:
                    verdict = action in s
            elif isinstance(t.ops[0], ast.NotIn) and isinstance(c, ast.Name):
                s = const_set(glob, c.id)
                if s is not None:
                    verdict = action not in s
            elif isinstance(t.ops[0], ast.Eq) and isinstance(c, ast.Constant):
                verdict = (action == c.value)
        out = names(t)
        if verdict is not False:
            for b in node.body:
                out |= live_names(b, glob, avar)
        if verdict is not True:
            for b in node.orelse:
                out |= live_names(b, glob, avar)
        return out
    out = set()
    for ch in ast.iter_child_nodes(node):
        if isinstance(ch, ast.If):
            out |= live_names(ch, glob, avar)
        else:
            out |= names(ch)
    if isinstance(node, ast.Name):
        out.add(node.id)
    return out

def closure(defs, glob, ti, tname, targets, avar):
    roots = set()
    for i, n in enumerate(glob):
        if i == ti:
            continue
        roots |= live_names(n, glob, avar)
    roots |= names(targets[action])
    seen, todo = set(), [r for r in roots if r in defs]
    while todo:
        r = todo.pop()
        if r in seen:
            continue
        seen.add(r)
        for x in names(defs[r]):
            if x in defs and x not in seen:
                todo.append(x)
        if names(defs[r]) & DYN:
            raise ValueError("function " + r + " calls by computed name")
    return seen, roots

def analyse(src):
    tree = parse(src)
    defs, glob = split(tree)
    t = table_of(glob)
    if not t:
        raise ValueError("no dispatch table names the action " + action)
    ti, tname, targets = t
    # the action variable is the one the table is indexed with
    avar = None
    for n in glob:
        for x in ast.walk(n):
            if isinstance(x, ast.Subscript) and isinstance(x.value, ast.Name) and x.value.id == tname and isinstance(x.slice, ast.Name):
                avar = x.slice.id
    if not avar:
        raise ValueError("the script does not look the action up in " + tname)
    for i, n in enumerate(glob):
        if i != ti and names(n) & DYN:
            raise ValueError("module-level code calls by computed name")
    seen, roots = closure(defs, glob, ti, tname, targets, avar)
    others = [ast.dump(n) for i, n in enumerate(glob) if i != ti]
    return defs, seen, others, ast.dump(targets[action]), {i: n for i, n in enumerate(glob)}

try:
    od, oseen, oglob, otarget, _ = analyse(d["old"])
    nd, nseen, nglob, ntarget, _ = analyse(d["new"])
except Exception as e:
    print(json.dumps({"ok": False, "why": str(e)}))
    sys.exit(0)

why = None
if oglob != nglob:
    why = "脚本里每个动作都会执行的部分（导入、公共变量、入口代码）有改动"
elif otarget != ntarget:
    why = "动作 " + action + " 对应的处理函数换了"
else:
    for name in sorted(oseen | nseen):
        a, b = od.get(name), nd.get(name)
        if (a is None) != (b is None) or (a is not None and ast.dump(a) != ast.dump(b)):
            line = b.lineno if b is not None else 0
            why = "动作 " + action + " 会执行的函数 " + name + " 有改动" + ("（第 %d 行）" % line if line else "（已删除）")
            break
print(json.dumps({"ok": True, "hit": why is not None, "why": why or ""}))
`

// pyReaches says whether the change of a Python helper reaches the given action of it. ok is false when the analysis
// could not decide; the caller must then count the change as reaching.
func pyReaches(old, now []byte, action string) (hit bool, why string, ok bool) {
	key := digest(old) + digest(now) + action
	if v, found := pyMemo.Load(key); found {
		r := v.(pyResult)
		return r.hit, r.why, r.ok
	}
	hit, why, ok = pyAnalyse(old, now, action)
	pyMemo.Store(key, pyResult{hit, why, ok})
	return
}

type pyResult struct {
	hit bool
	why string
	ok  bool
}

// the same two versions are asked about again and again (every look at the delivery page), and the answer cannot change
var pyMemo sync.Map

func pyAnalyse(old, now []byte, action string) (hit bool, why string, ok bool) {
	py, err := exec.LookPath("python3")
	if err != nil || action == "" {
		return true, "", false
	}
	in, _ := json.Marshal(map[string]string{"old": string(old), "new": string(now), "action": action})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, py, "-I", "-c", pyAnalyzer)
	cmd.Stdin = bytes.NewReader(in)
	var out bytes.Buffer
	cmd.Stdout = &out
	if cmd.Run() != nil {
		return true, "", false
	}
	var r struct {
		OK  bool   `json:"ok"`
		Hit bool   `json:"hit"`
		Why string `json:"why"`
	}
	if json.Unmarshal(out.Bytes(), &r) != nil || !r.OK {
		return true, r.Why, false
	}
	return r.Hit, r.Why, true
}

var argvVar = regexp.MustCompile(`^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$`)
var cmdVar = regexp.MustCompile(`\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$`)

// actionOf finds what action the tasks of a step hand to the script, read from the task that runs it: the last
// argument of its argv (or command line) is a variable the step's playbook fixes. Several tasks must agree.
func actionOf(files map[string][]byte, closure map[string]bool, script string, env map[string]string) (string, bool) {
	base := script[strings.LastIndex(script, "/")+1:]
	action := ""
	found, bad := false, false
	for f := range closure {
		if !isTaskFile(f) {
			continue
		}
		var doc yaml.Node
		if yaml.Unmarshal(files[f], &doc) != nil {
			continue
		}
		walkYAML(&doc, func(m map[string]*yaml.Node) {
			for key, mod := range m {
				if k := key[strings.LastIndex(key, ".")+1:]; k != "command" && k != "shell" && k != "raw" {
					continue
				}
				var argv []string
				line := ""
				switch mod.Kind {
				case yaml.MappingNode:
					for i := 0; i+1 < len(mod.Content); i += 2 {
						switch mod.Content[i].Value {
						case "argv":
							for _, x := range mod.Content[i+1].Content {
								argv = append(argv, x.Value)
							}
						case "cmd":
							line = mod.Content[i+1].Value
						}
					}
				case yaml.ScalarNode:
					line = mod.Value
				}
				runs := strings.Contains(line, base)
				for _, a := range argv {
					if strings.Contains(a, base) {
						runs = true
					}
				}
				if !runs {
					continue
				}
				v := ""
				if len(argv) > 0 {
					if mm := argvVar.FindStringSubmatch(strings.TrimSpace(argv[len(argv)-1])); mm != nil {
						v = mm[1]
					}
				} else if mm := cmdVar.FindStringSubmatch(strings.TrimSpace(line)); mm != nil {
					v = mm[1]
				}
				val, has := env[v]
				if v == "" || !has {
					bad = true
					return
				}
				if found && val != action {
					bad = true
				}
				action, found = val, true
			}
		})
	}
	return action, found && !bad
}

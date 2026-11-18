package mwpack

import (
	"fmt"
	"path"
	"strings"

	"gopkg.in/yaml.v3"
)

// Action is one task of a step, said as the command a person would type on the machine. The automated run executes
// the YAML; this is the same thing in words and commands, so a customer who runs it by hand — or wants to see what
// the automation does — gets it per step. Values written as {{ … }} are deployment variables; their values are in
// inventory/group_vars/all.yml of the delivery.
type Action struct {
	Name string `json:"name"`
	Cmd  string `json:"cmd,omitempty"`
	When string `json:"when,omitempty"`
	// Check is an assertion: it reads the machine and stops the play when the answer is wrong. The report states it
	// by its name, not by the expression behind it.
	Check bool `json:"check,omitempty"`
}

const maxDistillDepth = 3

// distillTasks reads the role's task file from the delivery's files and turns its tasks into actions.
func distillTasks(files map[string]File, role, tasks string, depth int, vars map[string]any) []Action {
	f, ok := files[path.Join("roles", role, "tasks", tasks+".yml")]
	if !ok {
		return nil
	}
	var list []map[string]any
	if yaml.Unmarshal(f.Data, &list) != nil {
		return nil
	}
	return distillList(files, role, list, depth, vars)
}

func distillList(files map[string]File, role string, list []map[string]any, depth int, vars map[string]any) []Action {
	var out []Action
	for _, t := range list {
		name, _ := t["name"].(string)
		// a condition that is false on this machine means the task does not run there
		when, whenKnown := "", false
		if vars != nil {
			if v, known := holds(t["when"], vars); !v {
				continue
			} else {
				whenKnown = known
			}
		}
		if !whenKnown || vars == nil {
			when = whenText(t["when"])
		}
		if _, ok := t["block"].([]any); ok {
			for _, k := range []string{"block", "rescue", "always"} {
				if sub, ok := t[k].([]any); ok {
					out = append(out, distillList(files, role, maps(sub), depth, vars)...)
				}
			}
			continue
		}
		mod, args := moduleOf(t)
		short := mod[strings.LastIndex(mod, ".")+1:]
		switch short {
		case "include_tasks", "import_tasks":
			if file, ok := args.(string); ok && depth < maxDistillDepth {
				out = append(out, distillTasks(files, role, strings.TrimSuffix(fill(file, vars), ".yml"), depth+1, vars)...)
			}
			continue
		case "include_role", "import_role":
			if m, ok := args.(map[string]any); ok && depth < maxDistillDepth {
				r, _ := m["name"].(string)
				from, _ := m["tasks_from"].(string)
				if from == "" {
					from = "main"
				}
				out = append(out, distillTasks(files, r, from, depth+1, vars)...)
			}
			continue
		case "set_fact", "meta", "debug", "":
			continue
		}
		items, looped := []any{nil}, false
		if vars != nil {
			if l, ok := expandLoop(t, vars); ok {
				items, looped = l, true
			}
		}
		for _, it := range items {
			v := vars
			if vars != nil {
				v = make(map[string]any, len(vars)+2)
				for k, x := range vars {
					v[k] = x
				}
				if looped {
					v["item"] = it
				}
				if tv, ok := t["vars"].(map[string]any); ok {
					for k, x := range tv {
						v[k] = resolveAll(x, v)
					}
				}
			}
			cmd := commandOf(short, args, t)
			nm := name
			if v != nil {
				if m, ok := args.(map[string]any); ok {
					if av, ok := m["argv"].(string); ok {
						if txt, ok := argvText(av, v); ok {
							cmd = txt
						}
					}
				}
				cmd, nm = fill(cmd, v), fill(name, v)
			}
			if nm == "" && cmd == "" {
				continue
			}
			if v != nil {
				cmd = placeholders(cmd)
			}
			w := when
			if v != nil && w != "" {
				w = fill(w, v)
			}
			out = append(out, Action{Name: nm, Cmd: cmd, When: w, Check: short == "assert"})
		}
	}
	return out
}

func maps(l []any) []map[string]any {
	var out []map[string]any
	for _, x := range l {
		if m, ok := x.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

var distillSkip = map[string]bool{"name": true, "when": true, "register": true, "changed_when": true, "failed_when": true, "loop": true, "with_items": true, "with_dict": true, "vars": true, "become": true, "become_user": true, "delegate_to": true, "run_once": true, "tags": true, "no_log": true, "ignore_errors": true, "retries": true, "delay": true, "until": true, "notify": true, "loop_control": true, "environment": true, "args": true, "check_mode": true, "throttle": true, "any_errors_fatal": true, "block": true, "rescue": true, "always": true, "listen": true, "timeout": true, "async": true, "poll": true, "diff": true, "module_defaults": true}

func moduleOf(t map[string]any) (string, any) {
	for k, v := range t {
		if !distillSkip[k] {
			return k, v
		}
	}
	return "", nil
}

func whenText(w any) string {
	switch v := w.(type) {
	case string:
		return v
	case []any:
		var p []string
		for _, x := range v {
			p = append(p, fmt.Sprint(x))
		}
		return strings.Join(p, " 且 ")
	case bool:
		return ""
	}
	return ""
}

func str(m map[string]any, k string) string {
	if v, ok := m[k]; ok && v != nil {
		return strings.TrimSpace(fmt.Sprint(v))
	}
	return ""
}

func commandOf(mod string, args any, t map[string]any) string {
	m, _ := args.(map[string]any)
	switch mod {
	case "command", "shell", "raw":
		if s, ok := args.(string); ok {
			return strings.TrimSpace(s)
		}
		if c := str(m, "cmd"); c != "" {
			return c
		}
		if av, ok := m["argv"]; ok {
			if l, ok := av.([]any); ok {
				var p []string
				for _, x := range l {
					p = append(p, fmt.Sprint(x))
				}
				return strings.Join(p, " ")
			}
			return fmt.Sprint(av)
		}
		return ""
	case "script":
		if s, ok := args.(string); ok {
			return "bash " + s
		}
		return "bash " + str(m, "cmd")
	case "file":
		p, st := str(m, "path"), str(m, "state")
		if p == "" {
			p = str(m, "dest")
		}
		var parts []string
		switch st {
		case "directory":
			parts = append(parts, "mkdir -p "+p)
		case "absent":
			return "rm -rf " + p
		case "link":
			return "ln -sfn " + str(m, "src") + " " + p
		case "touch":
			parts = append(parts, "touch "+p)
		}
		if o := str(m, "owner"); o != "" {
			if g := str(m, "group"); g != "" {
				o += ":" + g
			}
			parts = append(parts, "chown "+o+" "+p)
		}
		if md := str(m, "mode"); md != "" {
			parts = append(parts, "chmod "+md+" "+p)
		}
		return strings.Join(parts, "\n")
	case "copy", "template":
		dest := str(m, "dest")
		var l []string
		if c, ok := m["content"]; ok {
			body := strings.TrimRight(fmt.Sprint(c), "\n")
			if strings.Count(body, "\n") < 8 {
				l = append(l, "cat > "+dest+" <<'EOF'\n"+body+"\nEOF")
			} else {
				l = append(l, "# 写入 "+dest+"（内容见交付里的任务文件）")
			}
		} else if mod == "template" {
			l = append(l, "# 按模板 "+str(m, "src")+" 生成 "+dest)
		} else {
			l = append(l, "cp "+str(m, "src")+" "+dest)
		}
		if o := str(m, "owner"); o != "" {
			if g := str(m, "group"); g != "" {
				o += ":" + g
			}
			l = append(l, "chown "+o+" "+dest)
		}
		if md := str(m, "mode"); md != "" {
			l = append(l, "chmod "+md+" "+dest)
		}
		return strings.Join(l, "\n")
	case "lineinfile":
		return "# 在 " + str(m, "path") + " 中确保有这一行：" + str(m, "line")
	case "blockinfile":
		return "# 在 " + str(m, "path") + " 中写入一段配置"
	case "systemd", "service", "systemd_service":
		unit := str(m, "name")
		var l []string
		if str(m, "masked") == "true" {
			l = append(l, "systemctl mask "+unit)
		}
		if str(m, "masked") == "false" {
			l = append(l, "systemctl unmask "+unit)
		}
		if str(m, "daemon_reload") == "true" {
			l = append(l, "systemctl daemon-reload")
		}
		if str(m, "enabled") == "true" {
			l = append(l, "systemctl enable "+unit)
		}
		switch str(m, "state") {
		case "started":
			l = append(l, "systemctl start "+unit)
		case "stopped":
			l = append(l, "systemctl stop "+unit)
		case "restarted":
			l = append(l, "systemctl restart "+unit)
		case "reloaded":
			l = append(l, "systemctl reload "+unit)
		}
		return strings.Join(l, "\n")
	case "apt", "package", "dnf", "yum":
		return "# 从离线软件源安装：" + str(m, "name")
	case "stat":
		return "stat " + str(m, "path")
	case "slurp":
		return "cat " + str(m, "src")
	case "assert":
		return ""
	case "fail":
		return ""
	case "wait_for":
		if p := str(m, "port"); p != "" {
			return "# 等待 " + firstNonEmpty(str(m, "host"), "本机") + ":" + p + " 可连接"
		}
		return "# 等待 " + str(m, "path")
	case "uri":
		return "curl -s " + str(m, "url")
	case "user":
		return "useradd " + str(m, "name")
	case "group":
		return "groupadd " + str(m, "name")
	case "sysctl":
		return "sysctl -w " + str(m, "name") + "=" + str(m, "value")
	case "get_url", "unarchive":
		return "# " + mod + " " + firstNonEmpty(str(m, "url"), str(m, "src")) + " → " + str(m, "dest")
	case "find":
		return "find " + str(m, "paths")
	}
	return ""
}

func oneLine(v any) string {
	if l, ok := v.([]any); ok {
		var p []string
		for _, x := range l {
			p = append(p, fmt.Sprint(x))
		}
		return strings.Join(p, "；")
	}
	return fmt.Sprint(v)
}

// stepTasks names the task files a step runs, as role and task file; a step may run more than one.
func (s *PlanStep) taskFiles() [][2]string {
	switch s.platform {
	case "secrets":
		return [][2]string{{"mw_secrets", "main"}}
	case "preflight":
		return [][2]string{{"mw_preflight", "main"}}
	case "data-disk":
		return [][2]string{{"mw_data_disk", "main"}}
	case "offline-repo":
		return [][2]string{{"mw_offline_repo", "serve"}, {"mw_offline_repo", "client"}}
	}
	if s.step.Run != nil {
		return [][2]string{{s.step.Run.Role, s.step.Run.Tasks}}
	}
	if s.TaskFile != "" {
		return [][2]string{{s.TaskRole, s.TaskFile}}
	}
	return nil
}

// attachActions fills in what each step does, from the task files the delivery carries.
func attachActions(st *Steps, files map[string]File, projectDir string) {
	each := func(s *PlanStep) {
		if s == nil || s.Skipped != "" {
			return
		}
		host := ""
		if len(s.Hosts) > 0 {
			host = s.Hosts[0]
		}
		vars := varsFor(files, projectDir, s, host)
		for _, tf := range s.taskFiles() {
			s.Actions = append(s.Actions, distillTasks(files, tf[0], tf[1], 0, vars)...)
		}
	}
	for _, ph := range st.Phases {
		for _, s := range ph.Steps {
			each(s)
		}
	}
	for _, l := range [][]*PlanStep{st.Tests, st.Endpoint, st.Cleanup} {
		for _, s := range l {
			each(s)
		}
	}
}

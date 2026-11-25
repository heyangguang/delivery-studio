package mwpack

import (
	"crypto/sha256"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

type StepSource struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Shared bool   `json:"shared"`
}

func attachStepSources(st *Steps) error {
	lists := [][]*PlanStep{st.Tests, st.Endpoint, st.Cleanup}
	for _, ph := range st.Phases {
		lists = append(lists, ph.Steps)
	}
	for _, list := range lists {
		for _, s := range list {
			if s.inst == nil {
				continue
			}
			c := s.inst.R.C
			files, err := StepSourceFiles(c, s.step)
			if err != nil {
				return err
			}
			for _, f := range files {
				b, err := fs.ReadFile(c.fsys, path.Join(c.dir, f))
				if err != nil {
					return err
				}
				s.Sources = append(s.Sources, StepSource{Path: f, SHA256: fmt.Sprintf("%x", sha256.Sum256(b)), Shared: contains(c.SharedFiles, f)})
			}
		}
	}
	return nil
}

// StepSourceFiles follows local Ansible imports and source assets. Files are private
// by default; sharing requires an exact shared_files declaration in the component.
// Role defaults/vars/handlers are role-wide dependencies, not private step code.
// This is a source ownership check, not a sandbox for arbitrary remote commands.
func StepSourceFiles(c *Component, step Step) ([]string, error) {
	if c.fsys == nil {
		return nil, nil
	}
	seen := map[string]bool{}
	var visit func(string, string) error
	var scan func(*yaml.Node, string, string) error
	value := func(n *yaml.Node, key string) string {
		if n == nil || n.Kind != yaml.MappingNode {
			return ""
		}
		for i := 0; i+1 < len(n.Content); i += 2 {
			if n.Content[i].Value == key {
				return n.Content[i+1].Value
			}
		}
		return ""
	}
	add := func(f string) error {
		if !fs.ValidPath(f) || strings.Contains(f, "\\") {
			return fmt.Errorf("非法步骤依赖路径 %q", f)
		}
		if _, err := fs.Stat(c.fsys, path.Join(c.dir, f)); err != nil {
			return fmt.Errorf("找不到步骤依赖 %s", f)
		}
		seen[f] = true
		return nil
	}
	scan = func(n *yaml.Node, role, taskDir string) error {
		if n.Kind == yaml.MappingNode {
			for i := 0; i+1 < len(n.Content); i += 2 {
				key := strings.TrimPrefix(n.Content[i].Value, "ansible.builtin.")
				v := n.Content[i+1]
				switch key {
				case "include_tasks", "import_tasks":
					src := v.Value
					if v.Kind == yaml.MappingNode {
						src = value(v, "file")
					}
					if src == "" || strings.Contains(src, "{{") {
						return fmt.Errorf("步骤任务引用必须是静态路径，不能动态选择 %q", src)
					}
					if strings.HasPrefix(src, "/") || strings.Contains(src, "..") {
						return fmt.Errorf("任务引用不能越过步骤所属角色：%s", src)
					}
					if err := visit(path.Join(taskDir, src), role); err != nil {
						return err
					}
				case "include_role", "import_role":
					name, from := value(v, "name"), value(v, "tasks_from")
					if from == "" {
						from = "main"
					}
					if !nameRE.MatchString(strings.ReplaceAll(name, "_", "-")) || strings.Contains(from, "..") || strings.ContainsAny(from, "{}\\") || strings.HasPrefix(from, "/") {
						return fmt.Errorf("角色引用必须是组件内静态路径：%s/%s", name, from)
					}
					f := path.Join("roles", name, "tasks", strings.TrimSuffix(from, ".yml")+".yml")
					if _, err := fs.Stat(c.fsys, path.Join(c.dir, f)); err != nil {
						if _, err = fs.Stat(platformFS, path.Join("platform", f)); err == nil {
							continue
						}
					}
					if err := visit(f, name); err != nil {
						return err
					}
				case "copy", "template", "script":
					src := value(v, "src")
					if key == "script" && v.Kind == yaml.ScalarNode {
						if fields := strings.Fields(v.Value); len(fields) > 0 {
							src = fields[0]
						}
					}
					if src == "" || value(v, "remote_src") == "true" || strings.HasPrefix(src, "/") {
						continue
					}
					if strings.Contains(src, "{{") {
						if strings.Contains(src, "/") {
							continue
						} // runtime path, not a role-local asset name

						// Dynamic asset selection cannot prove ownership: include all candidate assets.
						root := path.Join("roles", role, "files")
						if key == "template" {
							root = path.Join("roles", role, "templates")
						}
						_ = fs.WalkDir(c.fsys, path.Join(c.dir, root), func(f string, d fs.DirEntry, err error) error {
							if err == nil && !d.IsDir() {
								seen[strings.TrimPrefix(f, c.dir+"/")] = true
							}
							return nil
						})
						continue
					}
					root := "files"
					if key == "template" {
						root = "templates"
					}
					if role != "" {
						root = path.Join("roles", role, root)
					}
					if strings.Contains(src, "..") {
						return fmt.Errorf("资源引用不能越过所属目录：%s", src)
					}
					if err := add(path.Join(root, src)); err != nil {
						return err
					}
				}
			}
		}
		for _, ch := range n.Content {
			if err := scan(ch, role, taskDir); err != nil {
				return err
			}
		}
		return nil
	}
	visit = func(f, role string) error {
		if seen[f] {
			return nil
		}
		if err := add(f); err != nil {
			return err
		}
		b, err := fs.ReadFile(c.fsys, path.Join(c.dir, f))
		if err != nil {
			return err
		}
		var n yaml.Node
		if err = yaml.Unmarshal(b, &n); err != nil {
			return fmt.Errorf("%s: %w", f, err)
		}
		return scan(&n, role, path.Dir(f))
	}
	if step.Run != nil {
		role, from := step.Run.Role, step.Run.Tasks
		if !nameRE.MatchString(strings.ReplaceAll(role, "_", "-")) || !fs.ValidPath(from) || strings.ContainsAny(from, "{}\\") {
			return nil, fmt.Errorf("run 必须引用静态的角色任务路径")
		}
		f := path.Join("roles", role, "tasks", from+".yml")
		if _, err := fs.Stat(c.fsys, path.Join(c.dir, f)); err != nil {
			if _, err = fs.Stat(platformFS, path.Join("platform", f)); err == nil {
				return nil, nil
			}
		}
		if err := visit(f, role); err != nil {
			return nil, err
		}
	} else {
		b, _ := yaml.Marshal(step.Tasks)
		var n yaml.Node
		if err := yaml.Unmarshal(b, &n); err != nil {
			return nil, err
		}
		if err := scan(&n, "", ""); err != nil {
			return nil, err
		}
	}
	out := make([]string, 0, len(seen))
	for f := range seen {
		out = append(out, f)
	}
	sort.Strings(out)
	return out, nil
}

// ValidateStepOwnership checks shared_files declarations and per-step file ownership across every resolved version of c,
// deduplicating component-wide diagnostics so multi-version components report each issue once.
func ValidateStepOwnership(c *Component) []Problem {
	if c == nil || c.fsys == nil {
		return nil
	}
	var out []Problem
	seen := map[string]bool{}
	for _, v := range c.Versions {
		if v.ID == "" {
			continue
		}
		r, err := c.Resolve(v.ID)
		if err != nil {
			continue
		}
		for _, pr := range validateStepOwnership(r) {
			key := pr.Severity + "|" + pr.Path + "|" + pr.Message
			if !seen[key] {
				seen[key] = true
				out = append(out, pr)
			}
		}
	}
	return out
}

func validateStepOwnership(r *Resolved) []Problem {
	if r.C.fsys == nil {
		return nil
	}
	var out []Problem
	bad := func(p, msg string) { out = append(out, Problem{Severity: "error", Path: p, Message: msg}) }
	warn := func(p, msg string) { out = append(out, Problem{Severity: "warning", Path: p, Message: msg}) }
	shared := map[string]bool{}
	for _, f := range r.C.SharedFiles {
		if !fs.ValidPath(f) || strings.ContainsAny(f, "*?\\") {
			bad("shared_files", "共享文件必须是精确的组件内路径："+f)
			continue
		}
		if shared[f] {
			warn("shared_files", "重复声明共享文件："+f)
		}
		shared[f] = true
		if _, err := fs.Stat(r.C.fsys, path.Join(r.C.dir, f)); err != nil {
			warn("shared_files", "共享文件不存在，可从 shared_files 移除："+f)
		}
	}
	users := map[string][]string{}
	check := func(area string, steps []Step) {
		for _, s := range steps {
			id := area + "/" + s.ID
			files, err := StepSourceFiles(r.C, s)
			if err != nil {
				bad(id, err.Error())
				continue
			}
			for _, f := range files {
				users[f] = append(users[f], id)
			}
		}
	}
	for area, steps := range r.Lifecycle {
		check("lifecycle/"+area, steps)
	}
	check("tests", r.Tests)
	check("cleanup", r.Cleanup)
	var paths []string
	for f := range users {
		paths = append(paths, f)
	}
	sort.Strings(paths)
	for _, f := range paths {
		if len(users[f]) > 1 && !shared[f] {
			sort.Strings(users[f])
			bad("shared_files", fmt.Sprintf("文件 %s 被多个步骤引用（%s）；请拆成步骤私有文件，或在 shared_files 明确声明公共依赖", f, strings.Join(users[f], ", ")))
		}
	}
	return out
}

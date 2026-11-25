package mwpack

import (
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strconv"
	"strings"
)

type Problem struct {
	Severity string `json:"severity"` // error | warning
	Path     string `json:"path,omitempty"`
	Message  string `json:"message"`
}

var (
	nameRE     = regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`)
	keyRE      = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,60}$`)
	idRE       = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,60}$`)
	capRE      = regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`)
	paramTypes = map[string]bool{"int": true, "float": true, "bool": true, "enum": true, "string": true, "size": true, "port": true, "cidr": true, "cidr-list": true, "ip": true, "host": true}
	effects    = map[string]bool{"": true, "read-only": true, "change": true, "disruptive": true, "destructive": true}
	statuses   = map[string]bool{"": true, "draft": true, "verifying": true, "published": true}
)

// Modules a declarative task may use. Everything is ansible-core, because delivery sites are offline and
// carry no extra collections. shell and ignore_errors are deliberately absent: they hide failures.
var allowedModules = map[string]bool{
	"apt": true, "package": true, "copy": true, "template": true, "file": true, "lineinfile": true, "blockinfile": true,
	"systemd": true, "systemd_service": true, "service": true, "command": true, "wait_for": true, "assert": true,
	"debug": true, "set_fact": true, "stat": true, "fail": true, "uri": true, "get_url": true, "unarchive": true,
	"user": true, "group": true, "slurp": true, "find": true, "pause": true, "meta": true, "script": true, "sysctl_file": false,
}

var taskKeywords = map[string]bool{
	"name": true, "when": true, "register": true, "loop": true, "loop_control": true, "become": true, "become_user": true,
	"no_log": true, "vars": true, "tags": true, "delegate_to": true, "run_once": true, "changed_when": true,
	"failed_when": true, "retries": true, "delay": true, "until": true, "notify": true, "args": true,
	"environment": true, "check_mode": true, "async": true, "poll": true, "throttle": true, "timeout": true,
}

// TaskModule returns the module key of an inline task.
func TaskModule(t map[string]any) (string, error) {
	module := ""
	for k := range t {
		if taskKeywords[k] {
			continue
		}
		if module != "" {
			return "", fmt.Errorf("一个任务里只能写一个模块，这里除了模块还有别的关键字：%s、%s", module, k)
		}
		module = k
	}
	if module == "" {
		return "", fmt.Errorf("这个任务没有写要用的模块")
	}
	short := strings.TrimPrefix(module, "ansible.builtin.")
	if strings.Contains(short, ".") || !allowedModules[short] {
		return module, fmt.Errorf("模块 %s 不能直接用（只允许 ansible.builtin 里的安全模块）；需要别的能力，请写成一个 role", module)
	}
	return module, nil
}

// HostSelector splits a Step.Hosts value. first applies to the single role in roles.
func HostSelector(sel string) (roles []string, first bool) {
	sel = strings.TrimSpace(sel)
	if sel == "" || sel == "all" {
		return nil, false
	}
	if strings.HasPrefix(sel, "first:") {
		return []string{strings.TrimPrefix(sel, "first:")}, true
	}
	for _, r := range strings.Split(sel, ",") {
		roles = append(roles, strings.TrimSpace(r))
	}
	return roles, false
}

func ValidateComponent(c *Component, cat *Catalog) []Problem {
	out := ValidateSeries(c, cat, false)
	out = append(out, ValidateDeliveryModes(c)...)
	out = append(out, ValidateConfiguration(c)...)
	bad := func(p, f string, a ...any) { out = append(out, Problem{"error", p, fmt.Sprintf(f, a...)}) }
	warn := func(p, f string, a ...any) { out = append(out, Problem{"warning", p, fmt.Sprintf(f, a...)}) }
	if !nameRE.MatchString(c.Name) {
		bad("component", "组件名「%s」不合规：用小写字母开头，只含小写字母、数字和短横线", c.Name)
	}
	if c.Title == "" || c.Category == "" {
		bad("component", "请填写组件的标题（title）和分类（category）")
	}
	if c.Icon != "" && !contains(ComponentIcons, c.Icon) {
		bad("icon", "没有叫「%s」的图标，可选：%s", c.Icon, strings.Join(ComponentIcons, "、"))
	}
	if c.Color != "" && !contains(ComponentColors, c.Color) {
		bad("color", "没有叫「%s」的颜色，可选：%s", c.Color, strings.Join(ComponentColors, "、"))
	}
	if c.Kind != "" && c.Kind != "external" {
		bad("kind", "组件类型（kind）只能留空，或写 external（由客户自己运维）")
	}
	for _, p := range c.Provides {
		if !capRE.MatchString(p) {
			bad("provides", "能力名「%s」不合规", p)
		}
	}
	if len(c.Versions) == 0 {
		bad("versions", "至少要有一个版本")
	}
	seen := map[string]bool{}
	for i, v := range c.Versions {
		p := fmt.Sprintf("versions[%d]", i)
		if v.ID == "" || seen[v.ID] {
			bad(p, "版本号没填，或者和别的版本重复了：「%s」", v.ID)
			continue
		}
		seen[v.ID] = true
		if !statuses[v.Status] {
			bad(p, "版本状态「%s」不对，只能是 draft、verifying 或 published", v.Status)
		}
		r, err := c.Resolve(v.ID)
		if err != nil {
			bad(p, "%v", err)
			continue
		}
		for _, vp := range v.VerifiedPlatforms {
			if !contains(r.Platforms, vp) {
				bad(p, "verified_platforms 中的系统「%s」不在该版本声明的 platforms 里", vp)
			}
		}
		for _, pr := range validateResolved(r, cat) {
			pr.Path = "versions[" + v.ID + "]." + pr.Path
			out = append(out, pr)
		}
	}
	out = append(out, ValidateStepOwnership(c)...)
	_ = warn
	return out
}

func validateResolved(r *Resolved, cat *Catalog) []Problem {
	var out []Problem
	bad := func(p, f string, a ...any) { out = append(out, Problem{"error", p, fmt.Sprintf(f, a...)}) }
	checkExpr := func(p, src string) {
		if strings.TrimSpace(src) == "" {
			return
		}
		if err := CheckExpr(strings.TrimPrefix(strings.TrimSpace(src), "=")); err != nil {
			bad(p, "表达式「%s」写得不对：%v", src, err)
		}
	}
	external := r.C.Kind == "external"
	roles := map[string]RoleSpec{}
	for _, x := range r.Roles {
		if !idRE.MatchString(x.Name) || roles[x.Name].Name != "" {
			bad("roles", "角色名「%s」不合规，或者重复了", x.Name)
		}
		if x.Advise != 0 && (x.Advise < x.Min || (x.Max != 0 && x.Advise > x.Max)) {
			bad("roles."+x.Name, "建议数量上限 %d 要在最少数量 %d 和最多数量之间", x.Advise, x.Min)
		}
		if x.Max != 0 && x.Max < x.Min {
			bad("roles."+x.Name, "最多数量（max）不能比最少数量（min）小")
		}
		roles[x.Name] = x
	}
	if !external && len(roles) == 0 {
		bad("roles", "至少要定义一个角色")
	}

	seenCompanions := map[string]bool{}
	for _, x := range r.C.Companions {
		if !idRE.MatchString(x.ID) || seenCompanions[x.ID] {
			bad("companions", "方案管理组件 ID 不合规或重复")
		}
		seenCompanions[x.ID] = true
		if !capRE.MatchString(x.Capability) || !nameRE.MatchString(x.Component) {
			bad("companions", "组件或能力名称不合规")
		}
		if x.When == "" {
			bad("companions", "管理组件必须显式声明启用条件")
		}
		checkExpr("companions."+x.ID+".when", x.When)
	}
	if r.C.Context != "" {
		found := false
		for _, q := range r.Requires {
			found = found || q.Capability == r.C.Context
		}
		if !found {
			bad("context", "管理上下文必须指向已声明的依赖能力")
		}
	}
	for _, q := range r.Requires {
		p := "requires." + q.Capability
		if !capRE.MatchString(q.Capability) {
			bad(p, "能力名不合规")
		}
		checkExpr(p+".when", q.When)
		if q.Placement != "" && q.Placement != "same_hosts" && q.Placement != "dedicated" {
			bad(p, "放置方式（placement）只能是 same_hosts（可与其它组件同机）或 dedicated（独占机器）")
		}
		if q.DefaultImpl != "" && cat != nil {
			dep, ok := cat.Get(q.DefaultImpl)
			if ok {
				provides := false
				for _, c := range dep.Provides {
					provides = provides || c == q.Capability
				}
				if !provides {
					bad(p, "默认实现 %s 并不提供「%s」这个能力", q.DefaultImpl, q.Capability)
				}
			} else if len(cat.byName) > 0 {
				bad(p, "默认实现 %s 在平台里找不到", q.DefaultImpl)
			}
		}
	}
	groups := map[string]bool{}
	for _, g := range r.Groups {
		groups[g.ID] = true
	}
	keys := map[string]bool{}
	for _, x := range r.Params {
		p := "params." + x.Key
		if !keyRE.MatchString(x.Key) || keys[x.Key] {
			bad(p, "参数的 key 不合规，或者重复了")
		}
		keys[x.Key] = true
		if !paramTypes[x.Type] {
			bad(p, "参数类型「%s」不对", x.Type)
		}
		if x.Label == "" {
			bad(p, "参数缺少显示名（label）")
		}
		if x.Type == "enum" && len(x.Options) == 0 {
			bad(p, "枚举类型的参数要列出可选项（options）")
		}
		if x.Group != "" && len(groups) > 0 && !groups[x.Group] {
			bad(p, "分组「%s」没有定义", x.Group)
		}
		if x.Pattern != "" {
			if _, err := regexp.Compile(x.Pattern); err != nil {
				bad(p, "格式要求（pattern）写得不对：%v", err)
			}
		}
		checkExpr(p+".when", x.When)
		if s, ok := x.Default.(string); ok && strings.HasPrefix(s, "=") {
			checkExpr(p+".default", s)
		} else if x.Default != nil {
			if _, err := coerce(x, x.Default); err != nil {
				bad(p, "默认值 %v 和参数类型不符：%v", x.Default, err)
			}
		}
	}
	flowIDs := map[string]bool{}
	for _, f := range r.Flows {
		p := "flows." + f.ID
		if !idRE.MatchString(f.ID) || flowIDs[f.ID] || f.Title == "" {
			bad(p, "每条数据流都要有不重复的 id 和 title")
		}
		flowIDs[f.ID] = true
		if f.Kind != "replication" && f.Kind != "mesh" {
			bad(p, "数据流的类型（kind）只能是 replication（复制）或 mesh（互联）")
		}
		for _, role := range []string{f.From, f.To} {
			if _, ok := roles[role]; !ok {
				bad(p, "角色「%s」没有定义", role)
			}
		}
		if f.Kind == "mesh" && f.From != f.To {
			bad(p, "互联（mesh）数据流的 from 和 to 要是同一个角色")
		}
		checkExpr(p+".when", f.When)
		checkExpr(p+".sync", f.Sync)
	}
	ruleIDs := map[string]bool{}
	for _, x := range r.Rules {
		if x.ID == "" || ruleIDs[x.ID] || x.Message == "" {
			bad("rules."+x.ID, "每条规则都要有不重复的 id 和提示语（message）")
		}
		ruleIDs[x.ID] = true
		if strings.TrimSpace(x.Expr) == "" {
			bad("rules."+x.ID, "规则缺少判断条件（expr）")
		}
		checkExpr("rules."+x.ID, x.Expr)
	}
	for _, x := range r.Ports {
		checkExpr("ports."+x.Name+".when", x.When)
		if s, ok := x.Value.(string); ok {
			checkExpr("ports."+x.Name, s)
		}
		for _, role := range x.Roles {
			if _, ok := roles[role]; !ok {
				bad("ports."+x.Name, "角色「%s」没有定义", role)
			}
		}
	}
	epNames := map[string]bool{}
	for _, e := range r.Endpoints {
		p := "endpoints." + e.Name
		epNames[e.Name] = true
		if e.Protocol != "tcp" && e.Protocol != "http" {
			bad(p, "端点协议（protocol）只能是 tcp 或 http")
		}
		if e.LB != "" && e.LB != "allowed" && e.LB != "discouraged" && e.LB != "none" {
			bad(p, "负载均衡（lb）只能是 allowed、discouraged 或 none")
		}
		if len(e.Backends) == 0 {
			bad(p, "请列出作为后端的角色")
		}
		for _, role := range e.Backends {
			if _, ok := roles[role]; !ok {
				bad(p, "后端角色「%s」没有定义", role)
			}
		}
		switch e.Health.Type {
		case "tcp", "http", "tcp-script":
		default:
			bad(p+".health", "健康检查类型「%s」不对", e.Health.Type)
		}
	}
	for _, s := range r.Secrets {
		if !idRE.MatchString(s.Name) {
			bad("secrets", "机密名「%s」不合规", s.Name)
		}
		checkExpr("secrets."+s.Name+".when", s.When)
	}
	for _, in := range r.Inputs {
		if in.Kind != "tls-bundle" {
			bad("inputs."+in.Name, "不认识的输入类型「%s」", in.Kind)
		}
		checkExpr("inputs."+in.Name+".when", in.When)
	}
	for _, pk := range r.Packages {
		pp := "packages." + pk.Name
		checkExpr(pp+".when", pk.When)
		if pk.Name == "" || strings.ContainsAny(pk.Name, " =\t") {
			bad(pp, "软件包名「%s」不合规", pk.Name)
		}
		if strings.TrimSpace(pk.Version) == "" {
			bad(pp, "软件包 %s 要写明确切的版本：交付要能原样重现，软件是平台软件库按版本提供的", pk.Name)
		}
		for _, id := range pk.Platforms {
			if _, ok := PlatformByID(id); !ok {
				bad(pp, "不认识操作系统「%s」", id)
			} else if len(r.Platforms) > 0 && !contains(r.Platforms, id) {
				bad(pp, "软件包限定的系统 %s，不在这个版本支持的系统里", id)
			}
		}
	}
	for _, id := range r.Platforms {
		if _, ok := PlatformByID(id); !ok {
			bad("platforms", "不认识操作系统「%s」", id)
		}
	}
	for _, a := range r.Artifacts {
		if a.Kind != "file" {
			bad("artifacts."+a.Name, "制品类型只能是 file；软件包由平台软件库按 packages 提供，不要再写 apt-repo")
		}
	}
	if r.C.hasProvide("l4-lb") && r.LB == nil {
		bad("lb", "提供 l4-lb 能力的组件，要声明 lb（支持的协议和健康检查类型）")
	}

	checkStep := func(p string, s Step, lifecycle bool) {
		for key, input := range s.Inputs {
			if !idRE.MatchString(key) || strings.Contains(key, "-") {
				bad(p, "步骤输入名必须使用字母数字和下划线：%s", key)
			}
			if !contains([]string{"string", "int", "bool", "list", "map"}, input.Type) {
				bad(p, "步骤输入 %s 的类型不支持：%s", key, input.Type)
			}
			if input.Value == nil {
				bad(p, "步骤输入 %s 缺少 value", key)
			}
		}
		for _, conditions := range [][]string{s.Preconditions, s.Postconditions} {
			for _, condition := range conditions {
				if strings.TrimSpace(condition) == "" || strings.Contains(condition, "{{") || strings.Contains(condition, "{%") {
					bad(p, "步骤前置/完成条件必须是非空 Ansible 表达式，不要包含模板分隔符")
				}
			}
		}
		if !idRE.MatchString(s.ID) {
			bad(p, "步骤 id「%s」不合规", s.ID)
		}
		if s.Title == "" {
			bad(p, "步骤缺少标题（title）")
		}
		if !effects[s.Effect] {
			bad(p, "步骤的影响（effect）「%s」不对", s.Effect)
		}
		checkExpr(p+".when", s.When)
		if (s.Run == nil) == (len(s.Tasks) == 0) {
			bad(p, "每个步骤要写 run 或 tasks，而且只能写其中一个")
		}
		if s.Run != nil {
			if s.Run.Role == "" || s.Run.Tasks == "" {
				bad(p, "run 要同时写 role 和 tasks")
			} else if r.C.fsys != nil {
				f := path.Join(r.C.dir, "roles", s.Run.Role, "tasks", s.Run.Tasks+".yml")
				_, err := fs.Stat(r.C.fsys, f)
				if _, perr := fs.Stat(platformFS, path.Join("platform/roles", s.Run.Role, "tasks", s.Run.Tasks+".yml")); err != nil && perr != nil {
					bad(p, "找不到角色的任务文件 %s", f)
				}
			}
		}
		for i, t := range s.Tasks {
			module, err := TaskModule(t)
			if err != nil {
				bad(fmt.Sprintf("%s.tasks[%d]", p, i), "%v", err)
			} else if r.C.fsys != nil {
				// A template or copy source must ship with the component, or the delivery would fail on site.
				short := strings.TrimPrefix(module, "ansible.builtin.")
				if args, ok := t[module].(map[string]any); ok && (short == "template" || short == "copy") {
					if src, ok := args["src"].(string); ok && src != "" && !strings.Contains(src, "{{") && !strings.HasPrefix(src, "/") {
						dirs := []string{"files", "templates"}
						if short == "template" {
							dirs = []string{"templates"}
						}
						found := false
						for _, d := range dirs {
							if _, e := fs.Stat(r.C.fsys, path.Join(r.C.dir, d, src)); e == nil {
								found = true
							}
						}
						if !found {
							bad(fmt.Sprintf("%s.tasks[%d]", p, i), "%s 的 src %q 在组件目录的 %s/ 下不存在", short, src, strings.Join(dirs, " 或 "))
						}
					}
				}
			}
			if v, ok := t["ignore_errors"]; ok && v != false {
				bad(fmt.Sprintf("%s.tasks[%d]", p, i), "不允许用 ignore_errors（会掩盖失败）")
			}
		}
		sel, _ := HostSelector(s.Hosts)
		for _, role := range sel {
			if _, ok := roles[role]; !ok && role != "controller" {
				bad(p, "hosts 里用到了没有定义的角色「%s」", role)
			}
		}
		if s.Serial < 0 {
			bad(p, "serial（每批台数）不能是负数")
		}
		if strings.HasPrefix(s.Scope, "endpoint:") {
			if r.C.Context == "" && !epNames[strings.TrimPrefix(s.Scope, "endpoint:")] {
				bad(p, "scope 里用到了没有定义的端点「%s」", s.Scope)
			}
		} else if s.Scope != "" {
			bad(p, "scope 只能写成 endpoint:端点名")
		}
		if !lifecycle && s.Effect == "" {
			bad(p, "功能测试和清理步骤要声明影响（effect）")
		}
	}
	for phase, steps := range r.Lifecycle {
		known := false
		for _, ph := range Phases {
			known = known || ph == phase
		}
		if !known {
			bad("lifecycle."+phase, "不认识的阶段，可选：%s", strings.Join(Phases, "、"))
			continue
		}
		ids := map[string]bool{}
		for _, s := range steps {
			if ids[s.ID] {
				bad("lifecycle."+phase+"."+s.ID, "步骤 id 重复了")
			}
			ids[s.ID] = true
			checkStep("lifecycle."+phase+"."+s.ID, s, true)
		}
	}
	// An "only a configuration sheet" component may still carry deployment steps: they are kept with it and simply not
	// used (nor shown) in what is delivered, so switching the mode back and forth loses nothing.
	for _, list := range []struct {
		name  string
		steps []Step
	}{{"tests", r.Tests}, {"cleanup", r.Cleanup}} {
		ids := map[string]bool{}
		for _, s := range list.steps {
			if ids[s.ID] {
				bad(list.name+"."+s.ID, "步骤 id 重复了")
			}
			ids[s.ID] = true
			checkStep(list.name+"."+s.ID, s, false)
		}
	}
	if r.Addons != nil {
		ids := map[string]bool{}
		for _, a := range r.Addons.Items {
			if ids[a.ID] || a.ID == "" {
				bad("addons", "附加项的 id 没填，或者重复了：「%s」", a.ID)
			}
			ids[a.ID] = true
		}
	}
	if d := r.C.Detail; d != nil {
		for _, pr := range d.Presets {
			if pr.Contract != nil {
				checkExpr("detail.presets."+pr.ID+".contract.when", pr.Contract.When)
			}
			for _, rc := range pr.Roles {
				role, ok := roles[rc.Role]
				if !ok {
					bad("detail.presets."+pr.ID, "推荐方案里用到了没有定义的角色「%s」", rc.Role)
					continue
				}
				if rc.Count < role.Min || (role.Max != 0 && rc.Count > role.Max) {
					bad("detail.presets."+pr.ID, "推荐方案里角色 %s 的数量 %d，超出了允许的 %d 到 %d", rc.Role, rc.Count, role.Min, role.Max)
				}
			}
		}
	}
	return out
}

func (c *Component) hasProvide(cap string) bool {
	for _, p := range c.Provides {
		if p == cap {
			return true
		}
	}
	return false
}

// coerce converts a raw value (from YAML, JSON or a form) into the canonical Go type of the parameter.
func coerce(p Param, v any) (any, error) {
	switch p.Type {
	case "int", "port":
		n, err := toInt(v)
		if err != nil {
			return nil, err
		}
		if p.Type == "port" && (n < 1 || n > 65535) {
			return nil, fmt.Errorf("端口要在 1 到 65535 之间")
		}
		return n, nil
	case "float":
		switch x := v.(type) {
		case float64:
			return x, nil
		case int:
			return float64(x), nil
		case string:
			return strconv.ParseFloat(strings.TrimSpace(x), 64)
		}
		return nil, fmt.Errorf("要填数字")
	case "bool":
		switch x := v.(type) {
		case bool:
			return x, nil
		case string:
			return strconv.ParseBool(strings.TrimSpace(x))
		}
		return nil, fmt.Errorf("要填 true 或 false")
	case "size":
		s := fmt.Sprint(v)
		if _, err := ParseSize(s); err != nil {
			return nil, err
		}
		return strings.TrimSpace(s), nil
	case "cidr-list":
		switch x := v.(type) {
		case []string:
			return x, nil
		case []any:
			out := make([]string, 0, len(x))
			for _, e := range x {
				out = append(out, fmt.Sprint(e))
			}
			return out, nil
		case nil:
			return []string{}, nil
		}
		return nil, fmt.Errorf("要填一个列表")
	default: // string enum cidr ip host
		return fmt.Sprint(v), nil
	}
}

func toInt(v any) (int, error) {
	switch x := v.(type) {
	case int:
		return x, nil
	case int64:
		return int(x), nil
	case float64:
		if x != float64(int(x)) {
			return 0, fmt.Errorf("要填整数")
		}
		return int(x), nil
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		if err != nil {
			return 0, fmt.Errorf("要填整数")
		}
		return n, nil
	}
	return 0, fmt.Errorf("要填整数")
}

// ParseSize converts 8GB, 256MB, 100kB into kilobytes.
func ParseSize(s string) (int64, error) {
	m := regexp.MustCompile(`^([0-9]+)\s*(kB|MB|GB|TB)$`).FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, fmt.Errorf("大小要写成 256MB、8GB 这样（单位 kB、MB、GB、TB）")
	}
	n, _ := strconv.ParseInt(m[1], 10, 64)
	return n << map[string]uint{"kB": 0, "MB": 10, "GB": 20, "TB": 30}[m[2]], nil
}

// PlatformTaskExists reports whether a role task file is one the platform itself provides (mw_packages and so on), so a
// component may run it without carrying a copy.
func PlatformTaskExists(role, tasks string) bool {
	_, err := fs.Stat(platformFS, path.Join("platform/roles", role, "tasks", tasks+".yml"))
	return err == nil
}

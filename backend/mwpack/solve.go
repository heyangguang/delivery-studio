package mwpack

import (
	"fmt"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Instance is a component placed on machines, fully resolved: version flattened, parameters validated and
// defaulted, dependencies bound, endpoints and fronts computed.
type Instance struct {
	dataRoots map[string]string
	ID        string
	Component string
	Version   string
	Title     string
	R         *Resolved
	// Auto is set when the platform added the instance to satisfy a requirement.
	Auto       bool
	AutoReason string
	External   bool
	Roles      map[string][]string // role -> machine names, in the order given
	Hosts      []string            // every machine of the instance, first role order
	Params     map[string]any      // every parameter, defaulted
	Visible    map[string]bool     // parameters that are active under the current choices
	Uses       map[string]*Use
	Endpoints  []EndpointFacts
	Binds      []BindFacts // what this instance (a load balancer) fronts
	Fronts     map[string]FrontFacts
	Addons     []AddonSel
	Secrets    []string
	Packages   []Package
	Ports      []PortUse
	Spec       InstanceSpec
	controller string
	cluster    string   // the deployment's id
	needs      []string // instances this one depends on
}

type Use struct {
	Capability string `json:"capability"`
	Instance   string `json:"instance"`
	Component  string `json:"component"`
}

type EndpointFacts struct {
	Name     string    `json:"name"`
	Title    string    `json:"title"`
	Protocol string    `json:"protocol"`
	Port     int       `json:"port"`
	Backends []Backend `json:"backends"`
	Health   Health    `json:"health"`
	LB       string    `json:"lb"`
	Note     string    `json:"note,omitempty"`
}

type Backend struct {
	Host string `json:"host"`
	IP   string `json:"ip"`
	Port int    `json:"port"`
	Role string `json:"role"`
}

type BindFacts struct {
	Name     string        `json:"name"`
	Target   string        `json:"target"` // instance.endpoint
	Listen   int           `json:"listen"`
	Endpoint EndpointFacts `json:"endpoint"`
	// Check is the health check actually used, port resolved.
	Check Health `json:"check"`
}

type FrontFacts struct {
	Balancer string `json:"balancer"`
	Name     string `json:"name"`
	Listen   int    `json:"listen"`
	Address  string `json:"address"` // vip when the balancer has one, else its first machine
	External bool   `json:"external"`
	// Mode and ResolveIP come from an external balancer: "domain" or "ip", and the address a domain should resolve to.
	Mode      string `json:"mode,omitempty"`
	ResolveIP string `json:"resolve_ip,omitempty"`
}

type PortUse struct {
	Instance string
	Name     string
	Port     int
	Proto    string
	Hosts    []string
}

// Plan is the validated result of solving a deployment.
type Plan struct {
	Dep        *Deployment
	Cat        *Catalog
	Hosts      []Host
	Controller string
	Instances  []*Instance // dependencies first
	Issues     []Problem
	Inputs     []InputReq
	// Platforms is what every installed component supports in common; Platform is the one this deployment uses.
	Platforms []string
	Platform  PlatformDef
}

type InputReq struct {
	Instance string `json:"instance"`
	Name     string `json:"name"`
	Label    string `json:"label"`
	Kind     string `json:"kind"`
}

func (p *Plan) Instance(id string) *Instance {
	for _, i := range p.Instances {
		if i.ID == id {
			return i
		}
	}
	return nil
}

// Normalized is the deployment with everything the platform decided made explicit: the version of every instance the
// user wrote, and the controller. Saving this (not the raw input) lets the same delivery be generated again later
// even if defaults change.
func (p *Plan) Normalized() *Deployment {
	d := *p.Dep
	d.Controller = p.Controller
	d.Platform = p.Platform.ID
	d.Hosts = append([]Host(nil), p.Hosts...)
	d.Instances = make([]InstanceSpec, len(p.Dep.Instances))
	for i, sp := range p.Dep.Instances {
		if inst := p.Instance(sp.ID); inst != nil {
			sp.Version = inst.Version
		}
		d.Instances[i] = sp
	}
	return &d
}

// ProjectName returns the Ansible project directory name for the deployment.
func (p *Plan) ProjectName() string { return p.Dep.ID }

func (p *Plan) hostIP(n string) string {
	h, _ := p.HostByName(n)
	return h.IP
}

func (p *Plan) HostByName(n string) (Host, bool) {
	if e := p.Dep.ExecutionHost; e != nil && e.Name == n {
		return Host{Name: e.Name, IP: e.IP}, true
	}
	for _, h := range p.Hosts {
		if h.Name == n {
			return h, true
		}
	}
	return Host{}, false
}

func (p *Plan) Errors() []Problem {
	var out []Problem
	for _, i := range p.Issues {
		if i.Severity == "error" {
			out = append(out, i)
		}
	}
	return out
}

// Err summarises blocking problems, or returns nil.
func (p *Plan) Err() error {
	errs := p.Errors()
	if len(errs) == 0 {
		return nil
	}
	lines := make([]string, len(errs))
	for i, e := range errs {
		lines[i] = e.Message
		if e.Path != "" {
			lines[i] = e.Path + "：" + e.Message
		}
	}
	return fmt.Errorf("%s", strings.Join(lines, "\n"))
}

type solver struct {
	cat  *Catalog
	plan *Plan
}

func (s *solver) bad(path, f string, a ...any) {
	s.plan.Issues = append(s.plan.Issues, Problem{"error", path, fmt.Sprintf(f, a...)})
}
func (s *solver) warn(path, f string, a ...any) {
	s.plan.Issues = append(s.plan.Issues, Problem{"warning", path, fmt.Sprintf(f, a...)})
}

var hostRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`)

// Solve validates a deployment against the catalog and expands it into a plan. The plan always carries
// whatever could be resolved plus every problem found, so a form can show them all at once.
func Solve(cat *Catalog, dep *Deployment) *Plan {
	p := &Plan{Dep: dep, Cat: cat}
	s := &solver{cat: cat, plan: p}
	if dep.Schema != "" && dep.Schema != DeploymentSchema {
		s.bad("schema", "不支持的规格版本 %q，需要 %s", dep.Schema, DeploymentSchema)
	}
	s.hosts()
	specs := append([]InstanceSpec(nil), dep.Instances...)
	byID := map[string]*Instance{}
	idRE2 := regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}$`)
	for i, sp := range specs {
		path := fmt.Sprintf("instances[%s]", sp.ID)
		if !idRE2.MatchString(sp.ID) || strings.Contains(sp.ID, "--") || strings.HasSuffix(sp.ID, "-") {
			s.bad(fmt.Sprintf("instances[%d]", i), "实例标识「%s」不合规：用小写字母开头，只含小写字母、数字和短横线", sp.ID)
			continue
		}
		if byID[sp.ID] != nil {
			s.bad(path, "有两个实例用了同一个标识，请改成不同的")
			continue
		}
		inst := s.build(sp, false, "")
		if inst != nil {
			p.Instances = append(p.Instances, inst)
			byID[inst.ID] = inst
		}
	}
	s.pickController()
	s.expandCompanions(byID)
	// Bind requirements; this may append auto instances, so iterate by index.
	for i := 0; i < len(p.Instances); i++ {
		s.bindRequires(p.Instances[i], byID)
	}
	for _, inst := range p.Instances {
		s.finishParams(inst)
	}
	for _, inst := range p.Instances {
		inst.dataRoots = map[string]string{}
		for _, host := range inst.Hosts {
			if h, ok := p.HostByName(host); ok {
				inst.dataRoots[host] = DataRoot(h)
			}
		}
	}
	s.validateManagedContexts()
	for _, inst := range s.plan.Instances {
		if _, err := inst.SelectedSeries(); err != nil {
			s.bad("instances["+inst.ID+"].series", "%v", err)
		}
	}
	s.order()
	for _, inst := range p.Instances {
		s.endpoints(inst)
	}
	for _, inst := range p.Instances {
		s.binds(inst, byID)
	}
	s.platforms()
	for _, inst := range p.Instances {
		s.rules(inst)
		s.inputsAndSecrets(inst)
	}
	s.ports()
	s.addons()
	return p
}

func (s *solver) platforms() {
	var common []string
	first := true
	for _, inst := range s.plan.Instances {
		if inst.External || len(inst.R.Platforms) == 0 {
			continue
		}
		if first {
			common = append([]string(nil), inst.R.Platforms...)
			first = false
			continue
		}
		var keep []string
		for _, x := range common {
			if contains(inst.R.Platforms, x) {
				keep = append(keep, x)
			}
		}
		common = keep
	}
	if !first && len(common) == 0 {
		s.bad("instances", "选中的这些组件，没有一个它们都支持的操作系统；请换个版本，或把它们分开部署")
	}
	s.plan.Platforms = common
	want := s.plan.Dep.Platform
	if want != "" {
		if _, known := PlatformByID(want); !known {
			s.bad("platform", "不认识操作系统「%s」", want)
			return
		}
		if !first && !contains(common, want) {
			s.bad("platform", "所选组件不支持 %s，可以换成：%s", want, strings.Join(common, "、"))
			return
		}
		def, _ := PlatformByID(want)
		s.plan.Platform = def
		s.noteFamily()
		return
	}
	pick := ""
	switch {
	case contains(common, DefaultPlatform):
		pick = DefaultPlatform
	case len(common) > 0:
		pick = common[0]
	}
	if def, ok := PlatformByID(pick); ok {
		s.plan.Platform = def
	}
	s.noteFamily()
}

// noteFamily warns about operating systems whose deployment has not been run on real machines.
func (s *solver) noteFamily() {
	if s.plan.Platform.Family == "rpm" {
		s.warn("platform", "RedHat 系平台的部署尚未在真实机器上验证；若系统启用了 SELinux，负载均衡监听非标准端口时需要另行放行")
	}
}

func (s *solver) hosts() {
	p := s.plan
	seenName, seenIP := map[string]bool{}, map[string]bool{}
	contract, err := p.Cat.HostContract()
	if err != nil {
		s.bad("hosts", "公共参数契约错误：%v", err)
		return
	}
	for i, h := range p.Dep.Hosts {
		path := fmt.Sprintf("hosts[%d]", i)
		if !hostRE.MatchString(h.Name) {
			s.bad(path, "主机名「%s」不合规：用小写字母开头，只含小写字母、数字和短横线", h.Name)
		}
		if seenName[h.Name] {
			s.bad(path, "主机名「%s」重复，每台机器要有不同的名字", h.Name)
		}
		seenName[h.Name] = true
		ip := net.ParseIP(h.IP)
		if ip == nil || ip.To4() == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() {
			if strings.TrimSpace(h.IP) == "" {
				s.bad(path, "%s 还没有填 IP 地址", h.Name)
			} else {
				s.bad(path, "%s 的 IP「%s」不是有效的 IPv4 地址（不能是 0.0.0.0、127.x 或组播地址）", h.Name, h.IP)
			}
		} else if seenIP[h.IP] {
			s.bad(path, "IP %s 被两台机器重复使用", h.IP)
		}
		seenIP[h.IP] = true
		if h.Initialize && h.Disk == "" {
			s.bad(path, "%s 勾选了初始化数据盘，请填写要初始化的磁盘，例如 /dev/sdb", h.Name)
		}
		if h.Disk != "" && !strings.HasPrefix(h.Disk, "/dev/") {
			s.bad(path, "%s 的数据盘要填 /dev/ 开头的设备，例如 /dev/sdb", h.Name)
		}
		if h.Disk == "/dev/vda" || h.Disk == "/dev/sda" || h.Disk == "/dev/nvme0n1" {
			s.bad(path, "%s 的数据盘 %s 一般是系统盘，不能用来存数据，请换一块", h.Name, h.Disk)
		}
		hh, problems := contract.Resolve(h)
		for _, problem := range problems {
			s.bad(path+".params", "%s", problem)
		}
		if hh.Disk != "" && hh.Partition == "" {
			hh.Partition = hh.Disk + "1"
			if strings.Contains(hh.Disk, "nvme") || strings.Contains(hh.Disk, "mmcblk") {
				hh.Partition = hh.Disk + "p1"
			}
		}
		p.Hosts = append(p.Hosts, hh)
	}
	if len(p.Hosts) == 0 {
		s.bad("hosts", "至少要添加一台机器")
	}
	p.Controller = p.Dep.Controller
	if e := p.Dep.ExecutionHost; e != nil {
		if !hostRE.MatchString(e.Name) || seenName[e.Name] {
			s.bad("execution_host.name", "独立执行机名称须合规，且不能与业务机器重名")
		}
		ip := net.ParseIP(e.IP)
		if ip == nil || ip.To4() == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() || seenIP[e.IP] {
			s.bad("execution_host.ip", "请填写独立执行机的有效 IPv4 地址，不能与业务机器相同")
		}
		if p.Dep.Controller != "" && p.Dep.Controller != e.Name {
			s.bad("controller", "已选择独立执行机，不能同时选择集群内控制机器")
		}
		if e.RepositoryPort < 1024 || e.RepositoryPort > 65535 {
			s.bad("execution_host.repository_port", "请为这份交付指定独立的软件源端口（1024–65535）；同一执行机上的不同集群使用不同端口")
		}
		p.Controller = e.Name
	}
	if p.Controller == "" && len(p.Hosts) > 0 {
		p.Controller = p.Hosts[0].Name
	}
	if p.Dep.ExecutionHost == nil && p.Controller != "" && !seenName[p.Controller] {
		s.bad("controller", "控制节点「%s」不在机器列表里，请在机器里选一台作为控制节点", p.Controller)
	}
	if !regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`).MatchString(p.Dep.ID) {
		if strings.TrimSpace(p.Dep.ID) == "" {
			s.bad("id", "还没有填集群标识，给这个集群起个名字，例如 pg-order-prod")
		} else {
			s.bad("id", "集群标识不合规：用小写字母开头，只含小写字母、数字和短横线，最长 41 个字符")
		}
	}
}

// pickController chooses the machine that runs Ansible when the deployment does not say: the first machine of the
// first role that is bootstrapped first (initial primary, seed), else simply the first machine.
func (s *solver) pickController() {
	p := s.plan
	if p.Dep.Controller == "" && p.Dep.ExecutionHost == nil {
		for _, inst := range p.Instances {
			for _, r := range inst.R.Roles {
				if r.Initial && len(inst.Roles[r.Name]) > 0 {
					p.Controller = inst.Roles[r.Name][0]
					goto done
				}
			}
		}
	}
done:
	for _, inst := range p.Instances {
		inst.controller = p.Controller
		inst.cluster = p.Dep.ID
	}
}

func (s *solver) hostExists(n string) bool {
	for _, h := range s.plan.Hosts {
		if h.Name == n {
			return true
		}
	}
	return false
}

// build resolves one instance spec; defaults are applied later, once dependencies are known.
func (s *solver) build(sp InstanceSpec, auto bool, reason string) *Instance {
	path := "instances[" + sp.ID + "]"
	c, ok := s.cat.Get(sp.Component)
	if !ok {
		s.bad(path, "组件「%s」在平台里找不到", sp.Component)
		return nil
	}
	ver := sp.Version
	if ver == "" {
		want := s.plan.Dep.Platform
		if want == "" {
			want = DefaultPlatform
		}
		ver = defaultVersionFor(c, want)
	}
	r, err := c.Resolve(ver)
	if err != nil {
		s.bad(path, "%v", err)
		return nil
	}
	inst := &Instance{ID: sp.ID, Component: c.Name, Version: ver, Title: c.Title, R: r, Auto: auto, AutoReason: reason,
		External: c.Kind == "external", Roles: map[string][]string{}, Uses: map[string]*Use{}, Spec: sp, Fronts: map[string]FrontFacts{}, controller: s.plan.Controller, cluster: s.plan.Dep.ID}
	targetOS := s.plan.Platform.ID
	if targetOS == "" {
		targetOS = s.plan.Dep.Platform
	}
	if st := r.PlatformStatus(targetOS); st != "published" {
		if r.Version.Status == "published" && targetOS != "" {
			plTitle := targetOS
			if def, ok := PlatformByID(targetOS); ok {
				plTitle = def.Title
			}
			s.warn(path, "%s %s 在 %s 上尚未实测验证，不要用于生产", c.Title, ver, plTitle)
		} else {
			s.warn(path, "%s %s 的状态是「%s」，尚未在空环境验证，不要用于生产", c.Title, ver, statusName(r.Version.Status))
		}
	}
	// Placement
	if inst.External {
		if len(sp.Placement) > 0 {
			s.bad(path, "外部实例由客户自己运维，不能放到机器上")
		}
	} else {
		known := map[string]bool{}
		for _, role := range r.Roles {
			known[role.Name] = true
		}
		for role, hosts := range sp.Placement {
			if !known[role] {
				s.bad(path+".placement", "组件 %s 没有「%s」这个角色", c.Name, role)
				continue
			}
			seen := map[string]bool{}
			for _, h := range hosts {
				if !s.hostExists(h) {
					s.bad(path+".placement."+role, "机器「%s」不在机器列表里", h)
				}
				if seen[h] {
					s.bad(path+".placement."+role, "机器「%s」被放了两次", h)
				}
				seen[h] = true
			}
		}
		for _, role := range r.Roles {
			hosts := sp.Placement[role.Name]
			inst.Roles[role.Name] = append([]string{}, hosts...)
		}
		// A machine may hold several roles of one instance (single node: primary only; sentinel with data): union in role order.
		seen := map[string]bool{}
		for _, role := range r.Roles {
			for _, h := range inst.Roles[role.Name] {
				if !seen[h] {
					seen[h] = true
					inst.Hosts = append(inst.Hosts, h)
				}
			}
		}
	}
	return inst
}

func statusName(s string) string {
	switch s {
	case "published":
		return "已发布"
	case "verifying":
		return "待验证"
	}
	return "草稿"
}

// defaultVersion picks the newest published version, else the newest version.
func defaultVersion(c *Component) string { return defaultVersionFor(c, "") }

// defaultVersionFor does the same among the versions that support the platform (any, when platform is empty).
func defaultVersionFor(c *Component, platform string) string {
	best := ""
	pick := func(mode int) {
		for _, v := range c.Versions {
			r, err := c.Resolve(v.ID)
			if err != nil {
				continue
			}
			if platform != "" && len(r.Platforms) > 0 && !contains(r.Platforms, platform) {
				continue
			}
			if mode == 2 && r.PlatformStatus(platform) != "published" {
				continue
			}
			if mode == 1 && v.Status != "published" {
				continue
			}
			if best == "" || CompareVersions(v.ID, best) > 0 {
				best = v.ID
			}
		}
	}
	pick(2)
	if best == "" {
		pick(1)
	}
	if best == "" {
		pick(0)
	}
	if best == "" && platform != "" {
		return defaultVersion(c)
	}
	return best
}

func (s *solver) env(inst *Instance) Env { return inst.Env() }

// Env is the expression environment of the instance as currently resolved.
func (inst *Instance) Env() Env {
	uses := map[string]map[string]any{}
	for cap, u := range inst.Uses {
		uses[cap] = map[string]any{"instance": u.Instance, "component": u.Component}
	}
	fronts := map[string]map[string]any{}
	for name, f := range inst.Fronts {
		fronts[name] = map[string]any{"balancer": f.Balancer, "listen": f.Listen, "address": f.Address, "external": f.External}
	}
	var addons []string
	for _, a := range inst.Spec.Addons {
		addons = append(addons, a.ID)
	}
	return Env{Params: inst.Params, Roles: inst.Roles, Hosts: inst.Hosts, Version: inst.Version, Instance: inst.ID, Controller: inst.controller, Addons: addons, Uses: uses, Fronts: fronts}
}

// applyParams fills Params from defaults and user values and records which are visible. It is called twice:
// before dependencies (for requires.when, which may only look at roles and params) and again afterwards.
func (s *solver) applyParams(inst *Instance, report bool) {
	path := "instances[" + inst.ID + "].params"
	inst.Params = map[string]any{}
	inst.Visible = map[string]bool{}
	known := map[string]Param{}
	for _, p := range inst.R.Params {
		known[p.Key] = p
	}
	if report {
		keys := make([]string, 0, len(inst.Spec.Params))
		for k := range inst.Spec.Params {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if _, ok := known[k]; !ok {
				s.bad(path+"."+k, "组件 %s %s 没有「%s」这个参数", inst.Component, inst.Version, k)
			}
		}
	}
	// Zero values first so expressions always see typed data, then defaults, then user values; two passes let
	// defaults refer to other parameters.
	for _, p := range inst.R.Params {
		inst.Params[p.Key] = zero(p)
	}
	for pass := 0; pass < 2; pass++ {
		env := s.env(inst)
		for _, p := range inst.R.Params {
			if p.Default == nil {
				continue
			}
			v, err := env.Value(p.Default)
			if err == nil {
				if cv, e2 := coerce(p, v); e2 == nil {
					inst.Params[p.Key] = cv
				}
			}
		}
	}
	for _, p := range inst.R.Params {
		raw, given := inst.Spec.Params[p.Key]
		if !given {
			continue
		}
		cv, err := coerce(p, raw)
		if err != nil {
			if report {
				s.bad(path+"."+p.Key, "%s：%v", p.Label, err)
			}
			continue
		}
		inst.Params[p.Key] = cv
	}
	env := s.env(inst)
	for _, p := range inst.R.Params {
		on, err := env.Bool(p.When)
		if err != nil {
			if report {
				s.bad(path+"."+p.Key, "%v", err)
			}
			on = true
		}
		inst.Visible[p.Key] = on
		if !on {
			if _, given := inst.Spec.Params[p.Key]; given && report && !valuesEqual(inst.Spec.Params[p.Key], inst.Params[p.Key]) {
				s.warn(path+"."+p.Key, "%s 在当前选择下不生效，已忽略", p.Label)
			}
			continue
		}
		if !report {
			continue
		}
		s.checkParam(path+"."+p.Key, p, inst.Params[p.Key])
	}
}

func valuesEqual(a, b any) bool { return fmt.Sprint(a) == fmt.Sprint(b) }

func zero(p Param) any {
	switch p.Type {
	case "int", "port":
		return 0
	case "float":
		return 0.0
	case "bool":
		return false
	case "cidr-list":
		return []string{}
	}
	return ""
}

func (s *solver) checkParam(path string, p Param, v any) {
	if p.Required && (v == "" || v == nil) {
		s.bad(path, "请填写「%s」", p.Label)
		return
	}
	str := fmt.Sprint(v)
	switch p.Type {
	case "int", "float", "port":
		f, _ := strconv.ParseFloat(str, 64)
		if p.Min != nil {
			if lo, err := strconv.ParseFloat(fmt.Sprint(p.Min), 64); err == nil && f < lo {
				s.bad(path, "「%s」不能小于 %v%s", p.Label, p.Min, p.Unit)
			}
		}
		if p.Max != nil {
			if hi, err := strconv.ParseFloat(fmt.Sprint(p.Max), 64); err == nil && f > hi {
				s.bad(path, "「%s」不能大于 %v%s", p.Label, p.Max, p.Unit)
			}
		}
	case "size":
		kb, _ := ParseSize(str)
		if p.Min != nil {
			if lo, err := ParseSize(fmt.Sprint(p.Min)); err == nil && kb < lo {
				s.bad(path, "「%s」不能小于 %v", p.Label, p.Min)
			}
		}
		if p.Max != nil {
			if hi, err := ParseSize(fmt.Sprint(p.Max)); err == nil && kb > hi {
				s.bad(path, "「%s」不能大于 %v", p.Label, p.Max)
			}
		}
	case "enum":
		ok := false
		for _, o := range p.Options {
			ok = ok || o == str
		}
		if !ok {
			s.bad(path, "「%s」只能选：%s", p.Label, strings.Join(p.Options, "、"))
		}
	case "cidr":
		if str != "" {
			if ip, n, err := net.ParseCIDR(str); err != nil || ip.To4() == nil || n.String() != str {
				s.bad(path, "「%s」要写成网段，例如 10.20.0.0/16", p.Label)
			}
		}
	case "cidr-list":
		for _, c := range v.([]string) {
			if ip, n, err := net.ParseCIDR(c); err != nil || ip.To4() == nil || n.String() != c {
				s.bad(path, "「%s」里的「%s」不是有效的网段，应写成例如 10.20.0.0/16", p.Label, c)
			}
		}
	case "ip":
		if str != "" {
			if ip := net.ParseIP(str); ip == nil || ip.To4() == nil {
				s.bad(path, "「%s」要填一个有效的 IPv4 地址", p.Label)
			}
		}
	}
	if p.Pattern != "" && str != "" {
		if re, err := regexp.Compile(p.Pattern); err == nil && !re.MatchString(str) {
			s.bad(path, "「%s」的格式不对", p.Label)
		}
	}
}

// finishParams runs after dependencies are bound so params and rules can look at uses.
func (s *solver) finishParams(inst *Instance) {
	if inst.Auto {
		// Auto instances take their params from the requirement's "with"; they were set in Spec already.
	}
	s.applyParams(inst, true)
	// Roles: counts within bounds.
	if inst.External {
		return
	}
	path := "instances[" + inst.ID + "].placement"
	for _, role := range inst.R.Roles {
		n := len(inst.Roles[role.Name])
		if n < role.Min || (role.Max != 0 && n > role.Max) {
			rng := fmt.Sprintf("至少 %d 台", role.Min)
			if role.Max != 0 {
				rng = fmt.Sprintf("%d 到 %d 台", role.Min, role.Max)
			}
			s.bad(path+"."+role.Name, "%s 的「%s」需要 %s，现在放了 %d 台", inst.Title, firstNonEmpty(role.Title, role.Name), rng, n)
		}
		if role.Advise > 0 && n > role.Advise {
			why := role.AdviseWhy
			if why == "" {
				why = "超过常见规模，请确认确实需要"
			}
			s.warn(path+"."+role.Name, "%s 的「%s」为 %d 台：%s（建议不超过 %d 台）", inst.Title, firstNonEmpty(role.Title, role.Name), n, why, role.Advise)
		}
		if role.Odd && n > 0 && n%2 == 0 {
			s.warn(path+"."+role.Name, "%s 的「%s」为 %d 个（偶数）：多数派为 %d 票，不比 %d 个更能容忍故障，建议奇数", inst.Title, firstNonEmpty(role.Title, role.Name), n, n/2+1, n-1)
		}
	}
	// A machine can only appear once per instance in two roles when the component allows it; flag the common mistake.
	for h, roles := range roleOfHost(inst) {
		if len(roles) > 1 && !s.rolesMayShare(inst, roles) {
			s.bad(path, "机器 %s 同时放了 %s，这个组件不允许放在同一台上", h, strings.Join(roles, "、"))
		}
	}
	if len(inst.Hosts) == 0 {
		s.bad(path, "%s 还没有放到任何机器上", inst.Title)
	}
}

func roleOfHost(inst *Instance) map[string][]string {
	m := map[string][]string{}
	for role, hosts := range inst.Roles {
		for _, h := range hosts {
			m[h] = append(m[h], role)
		}
	}
	for h := range m {
		sort.Strings(m[h])
	}
	return m
}

func (s *solver) rolesMayShare(inst *Instance, roles []string) bool {
	for _, r := range roles {
		if rs, ok := inst.R.Role(r); ok && rs.Exclusive {
			return false
		}
	}
	return true
}

func firstNonEmpty(a ...string) string {
	for _, x := range a {
		if x != "" {
			return x
		}
	}
	return ""
}

func (s *solver) bindRequires(inst *Instance, byID map[string]*Instance) {
	if inst.External {
		return
	}
	// Params must be known to evaluate requires.when.
	s.applyParams(inst, false)
	env := s.env(inst)
	path := "instances[" + inst.ID + "]"
	for _, q := range inst.R.Requires {
		on, err := env.Bool(q.When)
		if err != nil {
			s.bad(path+".requires."+q.Capability, "%v", err)
			continue
		}
		if !on {
			continue
		}
		// An explicit pin wins; then a single matching instance in the deployment; otherwise add the default.
		var provider *Instance
		if pin := inst.Spec.Uses[q.Capability]; pin != "" {
			provider = byID[pin]
			if provider == nil {
				s.bad(path+".uses."+q.Capability, "实例「%s」不存在", pin)
				continue
			}
			if !providesCap(provider, q.Capability) {
				s.bad(path+".uses."+q.Capability, "实例 %s 不提供 %s", pin, q.Capability)
				continue
			}
		} else {
			var cands []*Instance
			for _, other := range s.plan.Instances {
				if other != inst && providesCap(other, q.Capability) && !other.Auto {
					cands = append(cands, other)
				}
			}
			// Auto instances created earlier for the same requirer are reused.
			autoID := inst.ID + "-" + q.Capability
			switch {
			case len(cands) == 1:
				provider = cands[0]
			case len(cands) > 1:
				s.bad(path+".uses."+q.Capability, "有多个实例都提供 %s（%s），请指定用哪一个", q.Capability, instIDs(cands))
				continue
			case byID[autoID] != nil:
				provider = byID[autoID]
			default:
				provider = s.addAuto(inst, q, autoID)
				if provider != nil {
					byID[provider.ID] = provider
				}
			}
		}
		if provider == nil {
			continue
		}
		if q.Version != "" && !SatisfiesVersion(provider.Version, q.Version) {
			s.bad(path+".requires."+q.Capability, "%s 需要 %s %s，但现在选的是 %s", inst.Title, q.Capability, q.Version, provider.Version)
		}
		inst.Uses[q.Capability] = &Use{Capability: q.Capability, Instance: provider.ID, Component: provider.Component}
		inst.needs = append(inst.needs, provider.ID)
	}
}

func instIDs(l []*Instance) string {
	ids := make([]string, len(l))
	for i, x := range l {
		ids[i] = x.ID
	}
	return strings.Join(ids, "、")
}

func providesCap(i *Instance, cap string) bool {
	return i.R.C.hasProvide(cap)
}

func (s *solver) addAuto(req *Instance, q Require, id string) *Instance {
	path := "instances[" + req.ID + "].requires." + q.Capability
	if q.DefaultImpl == "" {
		s.bad(path, "%s 需要「%s」，但部署里没有实例能提供，也没有可以自动补上的默认实现", req.Title, q.Capability)
		return nil
	}
	comp, ok := s.cat.Get(q.DefaultImpl)
	if !ok {
		s.bad(path, "自动补上的默认实现「%s」在平台里找不到", q.DefaultImpl)
		return nil
	}
	sp := InstanceSpec{ID: id, Component: comp.Name, Params: map[string]any{}}
	env := s.env(req)
	for k, v := range q.With {
		rv, err := env.Value(v)
		if err != nil {
			s.bad(path+".with."+k, "%v", err)
			continue
		}
		sp.Params[k] = rv
	}
	// Placement: every machine of the requirer, into the provider's single role.
	if q.Placement == "dedicated" {
		s.bad(path, "%s 需要单独的 %s：请添加一个 %s 实例，放到专门的机器上", req.Title, q.Capability, comp.Name)
		return nil
	}
	ver := defaultVersion(comp)
	r, err := comp.Resolve(ver)
	if err != nil {
		s.bad(path, "%v", err)
		return nil
	}
	if comp.Kind != "external" && len(r.Roles) != 1 {
		s.bad(path, "默认的 %s 有多个角色，没法自动放置，请手动添加这个实例", comp.Name)
		return nil
	}
	if comp.Kind != "external" {
		sp.Placement = map[string][]string{r.Roles[0].Name: append([]string(nil), req.Hosts...)}
	}
	what := firstNonEmpty(q.Title, q.Capability)
	reason := fmt.Sprintf("%s 需要%s", req.Title, what)
	inst := s.build(sp, true, reason)
	if inst == nil {
		return nil
	}
	s.plan.Instances = append(s.plan.Instances, inst)
	return inst
}

// order sorts instances so providers precede users, and reports cycles.
func (s *solver) order() {
	idx := map[string]*Instance{}
	for _, i := range s.plan.Instances {
		idx[i.ID] = i
	}
	var out []*Instance
	state := map[string]int{}
	var visit func(i *Instance)
	visit = func(i *Instance) {
		switch state[i.ID] {
		case 2:
			return
		case 1:
			s.bad("instances["+i.ID+"]", "实例之间的依赖绕成了圈，请检查它们的「使用」设置")
			return
		}
		state[i.ID] = 1
		deps := append([]string(nil), i.needs...)
		for _, d := range deps {
			if dep := idx[d]; dep != nil {
				visit(dep)
			}
		}
		state[i.ID] = 2
		out = append(out, i)
	}
	for _, i := range s.plan.Instances {
		visit(i)
	}
	s.plan.Instances = out
}

func (s *solver) endpoints(inst *Instance) {
	if inst.External {
		return
	}
	env := s.env(inst)
	for _, e := range inst.R.Endpoints {
		if on, err := env.Bool(e.When); err != nil || !on {
			continue
		}
		port, err := intOf(env, e.Port)
		if err != nil {
			s.bad("instances["+inst.ID+"].endpoints."+e.Name, "端口有问题：%v", err)
			continue
		}
		f := EndpointFacts{Name: e.Name, Title: firstNonEmpty(e.Title, e.Name), Protocol: e.Protocol, Port: port, Health: e.Health, LB: firstNonEmpty(e.LB, "allowed"), Note: e.Note}
		if e.Health.Port != nil {
			hp, err := intOf(env, e.Health.Port)
			if err != nil {
				s.bad("instances["+inst.ID+"].endpoints."+e.Name, "健康检查端口有问题：%v", err)
			}
			f.Health.Port = hp
		}
		for _, role := range e.Backends {
			for _, h := range inst.Roles[role] {
				host, _ := s.plan.HostByName(h)
				f.Backends = append(f.Backends, Backend{Host: h, IP: host.IP, Port: port, Role: role})
			}
		}
		inst.Endpoints = append(inst.Endpoints, f)
	}
}

func intOf(env Env, v any) (int, error) {
	rv, err := env.Value(v)
	if err != nil {
		return 0, err
	}
	return toInt(rv)
}

func (s *solver) binds(lb *Instance, byID map[string]*Instance) {
	if len(lb.Spec.Binds) == 0 {
		return
	}
	path := "instances[" + lb.ID + "].binds"
	if !providesCap(lb, "l4-lb") {
		s.bad(path, "%s 不是负载均衡组件，不能把端点接到它后面", lb.Title)
		return
	}
	used := map[int]bool{}
	for i, b := range lb.Spec.Binds {
		bp := fmt.Sprintf("%s[%d]", path, i)
		target, epName, ok := strings.Cut(b.Endpoint, ".")
		ti := byID[target]
		if !ok || ti == nil {
			s.bad(bp, "端点「%s」写法不对，应是「实例.端点」，并且这个实例要存在", b.Endpoint)
			continue
		}
		var ep *EndpointFacts
		for k := range ti.Endpoints {
			if ti.Endpoints[k].Name == epName {
				ep = &ti.Endpoints[k]
			}
		}
		if ep == nil {
			s.bad(bp, "实例 %s 没有「%s」这个端点", target, epName)
			continue
		}
		if ep.LB == "none" {
			s.bad(bp, "%s 的端点「%s」不适合放在负载均衡后面：%s", ti.Title, ep.Title, firstNonEmpty(ep.Note, "客户端需要直连各节点"))
			continue
		}
		if ep.LB == "discouraged" {
			s.warn(bp, "%s 的端点 %s 不推荐放在负载均衡之后：%s", ti.Title, ep.Title, ep.Note)
		}
		listen := b.Listen
		if listen == 0 {
			listen = ep.Port
		}
		if listen < 1 || listen > 65535 {
			s.bad(bp, "监听端口不对，要在 1 到 65535 之间")
		}
		if used[listen] {
			s.bad(bp, "监听端口 %d 在同一个负载均衡里用了两次", listen)
		}
		used[listen] = true
		if !lb.External && lb.R.LB != nil {
			if !contains(lb.R.LB.Protocols, ep.Protocol) {
				s.bad(bp, "%s 不支持 %s 协议", lb.Title, ep.Protocol)
			}
			if !contains(lb.R.LB.Health, ep.Health.Type) {
				s.bad(bp, "%s 做不了「%s」类型的健康检查，而 %s 的「%s」需要它（例如按 Patroni 的 /primary 找主库）；请换一个支持的负载均衡，或用外部 ELB", lb.Title, ep.Health.Type, ti.Title, ep.Title)
			}
		}
		name := firstNonEmpty(b.Name, strings.ReplaceAll(target+"-"+epName, "_", "-"))
		bf := BindFacts{Name: name, Target: b.Endpoint, Listen: listen, Endpoint: *ep, Check: ep.Health}
		lb.Binds = append(lb.Binds, bf)
		addr := ""
		if vip, ok := lb.Params["vip"].(string); ok && vip != "" && lb.Visible["vip"] {
			addr = vip
		} else if len(lb.Hosts) > 0 {
			h, _ := s.plan.HostByName(lb.Hosts[0])
			addr = h.IP
		} else if ip, ok := lb.Params["address"].(string); ok {
			addr = ip
		}
		ff := FrontFacts{Balancer: lb.ID, Name: name, Listen: listen, Address: addr, External: lb.External}
		ff.Mode, _ = lb.Params["mode"].(string)
		ff.ResolveIP, _ = lb.Params["resolve_ip"].(string)
		ti.Fronts[epName] = ff
		lb.needs = append(lb.needs, ti.ID)
	}
	s.order()
}

func contains(l []string, x string) bool {
	for _, v := range l {
		if v == x {
			return true
		}
	}
	return false
}

func (s *solver) rules(inst *Instance) {
	env := s.env(inst)
	for _, r := range inst.R.Rules {
		ok, err := env.Bool(r.Expr)
		if err != nil {
			s.bad("instances["+inst.ID+"].rules."+r.ID, "%v", err)
			continue
		}
		if !ok {
			if r.Warn {
				s.warn("instances["+inst.ID+"]", "%s", r.Message)
			} else {
				s.bad("instances["+inst.ID+"]", "%s", r.Message)
			}
		}
	}
}

func (s *solver) inputsAndSecrets(inst *Instance) {
	env := s.env(inst)
	for _, in := range inst.R.Inputs {
		if on, _ := env.Bool(in.When); on {
			s.plan.Inputs = append(s.plan.Inputs, InputReq{Instance: inst.ID, Name: in.Name, Label: in.Label, Kind: in.Kind})
		}
	}
	for _, sec := range inst.R.Secrets {
		if on, _ := env.Bool(sec.When); on {
			inst.Secrets = append(inst.Secrets, sec.Name)
		}
	}
	if inst.External {
		return
	}
	for _, pk := range inst.R.Packages {
		if len(pk.Platforms) > 0 && !contains(pk.Platforms, s.plan.Platform.ID) {
			continue
		}
		if on, _ := env.Bool(pk.When); on {
			inst.Packages = append(inst.Packages, pk)
		}
	}
}

// Requests lists the exact packages the delivery needs on its platform, once each, in a stable order.
func (p *Plan) Requests() []PackageRequest {
	var out []PackageRequest
	seen := map[string]bool{}
	for _, r := range p.Platform.ControllerPackages {
		seen[r.Key()] = true
		out = append(out, r)
	}
	for _, i := range p.Instances {
		for _, pk := range i.Packages {
			r := PackageRequest{Name: pk.Name, Version: pk.Version}
			if !seen[r.Key()] {
				seen[r.Key()] = true
				out = append(out, r)
			}
		}
	}
	return out
}

// NeedsPackages reports whether the delivery must carry a package repository.
func (p *Plan) NeedsPackages() bool { return len(p.Requests()) > 0 }

func (s *solver) ports() {
	type key struct {
		host  string
		port  int
		proto string
	}
	seen := map[key]string{}
	for _, inst := range s.plan.Instances {
		if inst.External {
			continue
		}
		env := s.env(inst)
		add := func(name string, port int, proto string, hosts []string) {
			for _, h := range hosts {
				k := key{h, port, proto}
				if prev, ok := seen[k]; ok && prev != inst.ID+"."+name {
					s.bad("instances["+inst.ID+"]", "机器 %s 的 %s 端口 %d 被 %s 和 %s.%s 同时占用，请改掉其中一个", h, strings.ToUpper(proto), port, prev, inst.ID, name)
					continue
				}
				seen[k] = inst.ID + "." + name
			}
			inst.Ports = append(inst.Ports, PortUse{inst.ID, name, port, proto, hosts})
		}
		for _, ps := range inst.R.Ports {
			if on, _ := env.Bool(ps.When); !on {
				continue
			}
			n, err := intOf(env, ps.Value)
			if err != nil {
				s.bad("instances["+inst.ID+"].ports."+ps.Name, "%v", err)
				continue
			}
			hosts := inst.Hosts
			if len(ps.Roles) > 0 {
				hosts = nil
				for _, r := range ps.Roles {
					hosts = append(hosts, inst.Roles[r]...)
				}
			}
			add(ps.Name, n, firstNonEmpty(ps.Proto, "tcp"), hosts)
		}
		for _, b := range inst.Binds {
			add("listen-"+b.Name, b.Listen, "tcp", inst.Hosts)
		}
	}
	// The offline package repository is served from the controller.
	if s.plan.NeedsPackages() {
		k := key{s.plan.Controller, s.plan.RepositoryPort(), "tcp"}
		if prev, ok := seen[k]; ok {
			s.bad("instances", "控制节点 %s 的 TCP 端口 %d 要用来提供离线软件仓库，但已被 %s 占用，请换一个端口", s.plan.Controller, k.port, prev)
		}
	}
}

func (s *solver) addons() {
	for _, inst := range s.plan.Instances {
		path := "instances[" + inst.ID + "].addons"
		if len(inst.Spec.Addons) == 0 {
			continue
		}
		if inst.R.Addons == nil {
			s.bad(path, "%s 没有可选的附加项", inst.Title)
			continue
		}
		catalog := map[string]Addon{}
		for _, a := range inst.R.Addons.Items {
			catalog[a.ID] = a
		}
		seen := map[string]bool{}
		for _, sel := range inst.Spec.Addons {
			a, ok := catalog[sel.ID]
			if !ok {
				s.bad(path+"."+sel.ID, "%s %s 没有「%s」这个附加项", inst.Title, inst.Version, sel.ID)
				continue
			}
			if seen[sel.ID] {
				s.bad(path+"."+sel.ID, "这个附加项选了两次")
			}
			seen[sel.ID] = true
			if a.Since != "" && CompareVersions(inst.Version, a.Since) < 0 || a.Until != "" && CompareVersions(inst.Version, a.Until) > 0 {
				s.bad(path+"."+sel.ID, "附加项 %s 不适用于 %s 这个版本", sel.ID, inst.Version)
			}
			if len(sel.Databases) == 0 && len(inst.R.Addons.Scope.Defaults) == 0 {
				s.bad(path+"."+sel.ID, "请至少选择一个%s", inst.R.Addons.Scope.Name)
			}
			for _, d := range sel.Databases {
				if !regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`).MatchString(d) {
					s.bad(path+"."+sel.ID, "目标名称「%s」不合法", d)
				}
			}
			for k := range sel.Params {
				found := false
				for _, p := range a.Params {
					found = found || p.Key == k
				}
				if !found {
					s.bad(path+"."+sel.ID+".params."+k, "附加项 %s 没有「%s」这个参数", sel.ID, k)
				}
			}
			for k, v := range a.SetParams {
				if _, ok := inst.Params[k]; ok {
					inst.Params[k] = mergeSetParam(inst.Params[k], v)
				}
			}
			inst.Addons = append(inst.Addons, sel)
		}
	}
}

// mergeSetParam adds an add-on's required value to a comma list parameter (shared_preload_libraries style).
func mergeSetParam(cur, want any) any {
	c, w := fmt.Sprint(cur), fmt.Sprint(want)
	if c == "" {
		return w
	}
	for _, p := range strings.Split(c, ",") {
		if strings.TrimSpace(p) == w {
			return c
		}
	}
	return c + "," + w
}

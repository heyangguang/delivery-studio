package mwpack

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

//go:embed platform
var platformFS embed.FS

type File struct {
	Data []byte
	Mode int64
}

// ArtifactInfo describes an offline file as the artifact store holds it.
type ArtifactInfo struct {
	File   string
	SHA256 string
	Size   int64
}

type RenderOptions struct {
	// Runner is the ansible-playbook command as typed on the controller, relative to ProjectDir.
	Runner     string
	ProjectDir string
	UploadDir  string
	// InventoryCmd shows the inventory graph command in the handbook.
	InventoryCmd string
	// Artifacts maps file name to store info. When non-nil every artifact the plan needs must be present.
	Artifacts map[string]ArtifactInfo
	// Materials maps "<instance>/<input>/<file>" to uploaded file content.
	Materials map[string][]byte
	// PackageRepo is the assembled offline package repository for the plan's platform and packages.
	PackageRepo *PackageRepo
}

// PackageRepo describes the repository archive the delivery carries.
type PackageRepo struct {
	File   string
	SHA256 string
	Size   int64
}

// RepoFileName is the archive name used for a platform's repository.
func RepoFileName(platform string) string { return "packages-" + platform + ".tar.gz" }

func (o RenderOptions) repoFile(p *Plan) string {
	if o.PackageRepo != nil && o.PackageRepo.File != "" {
		return o.PackageRepo.File
	}
	return RepoFileName(p.Platform.ID)
}

func (o *RenderOptions) defaults(p *Plan) {
	if o.Runner == "" {
		o.Runner = "../../bin/ansible-playbook -i inventory/hosts.yml"
	}
	if o.ProjectDir == "" {
		o.ProjectDir = p.RuntimeRoot() + "/projects/" + p.ProjectName()
	}
	if o.UploadDir == "" {
		o.UploadDir = "/tmp/mw-upload"
		if p.Dep.ExecutionHost != nil {
			o.UploadDir += "/" + p.Dep.ID
		}
	}
}

// Bundle is the complete, deterministic output for one deployment.
type Bundle struct {
	Plan    *Plan
	Steps   *Steps
	Project map[string]File   // Ansible project, relative to its root
	Docs    map[string][]byte // handbooks
	Lock    []byte
	PlanDoc []byte // plan.json, the structured form of the handbooks
}

// omap is a YAML mapping that keeps insertion order, so generated files read the way a person would write them.
type kv struct {
	k string
	v any
}
type omap []kv

func (o omap) MarshalYAML() (any, error) {
	n := &yaml.Node{Kind: yaml.MappingNode}
	for _, e := range o {
		k := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: e.k}
		v := &yaml.Node{}
		if err := v.Encode(e.v); err != nil {
			return nil, err
		}
		n.Content = append(n.Content, k, v)
	}
	return n, nil
}

func yamlDoc(header string, v any) []byte {
	var b bytes.Buffer
	b.WriteString("---\n")
	if header != "" {
		for _, l := range strings.Split(strings.TrimRight(header, "\n"), "\n") {
			b.WriteString("# " + l + "\n")
		}
	}
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(2)
	_ = enc.Encode(v)
	_ = enc.Close()
	return b.Bytes()
}

const generatedNote = "由 Middleware Hub 生成，请勿手工修改；需要变化时回到平台修改规格后重新生成。"

func Render(p *Plan, opt RenderOptions) (*Bundle, error) {
	if err := ValidateDeliveryMode(p); err != nil {
		return nil, err
	}
	if p.Dep.DeliveryMode == "configuration" {
		return nil, fmt.Errorf("本次只生成配置，不能创建执行步骤；请使用配置输出流程")
	}
	if err := p.Err(); err != nil {
		return nil, fmt.Errorf("部署规格有错误，不能生成：\n%v", err)
	}
	// Generation is also an enforcement boundary: callers cannot bypass the
	// workbench/catalog checks by keeping or modifying an already resolved plan.
	for _, inst := range p.Instances {
		for _, problem := range validateStepOwnership(inst.R) {
			if problem.Severity == "error" {
				return nil, fmt.Errorf("组件 %s 不符合步骤独立性标准：%s", inst.Component, problem.Message)
			}
		}
	}
	opt.defaults(p)
	st := p.BuildSteps(opt.Runner)
	if err := attachStepSources(st); err != nil {
		return nil, fmt.Errorf("生成步骤依赖清单：%w", err)
	}
	b := &Bundle{Plan: p, Steps: st, Project: map[string]File{}, Docs: map[string][]byte{}}
	put := func(name string, data []byte, mode int64) { b.Project[name] = File{data, mode} }

	// Artifacts must exist and carry a digest.
	arts := p.Artifacts()
	resolved := map[string]Artifact{}
	for _, a := range arts {
		if opt.Artifacts != nil {
			info, ok := opt.Artifacts[a.File]
			if !ok {
				return nil, fmt.Errorf("离线材料 %s 不在材料库中，不能生成交付", a.File)
			}
			if a.SHA256 != "" && a.SHA256 != info.SHA256 {
				return nil, fmt.Errorf("离线材料 %s 的哈希与清单声明不一致", a.File)
			}
			a.SHA256 = info.SHA256
		}
		resolved[a.Name] = a
	}

	put("ansible.cfg", []byte(ansibleCfg), 0o600)
	// every run leaves a full log under logs/ (see platform/files/mw_log.py)
	if cb, err := fs.ReadFile(p.Cat.platformFS(), "files/mw_log.py"); err == nil {
		put("callback_plugins/mw_log.py", cb, 0o600)
	}
	inv, err := inventoryDoc(p)
	if err != nil {
		return nil, err
	}
	put("inventory/hosts.yml", inv, 0o600)
	gv, err := groupVars(p, opt, resolved)
	if err != nil {
		return nil, err
	}
	put("inventory/group_vars/all.yml", gv, 0o600)

	// Playbooks.
	for _, ph := range st.Phases {
		put(ph.Playbook, phasePlaybook(p, ph), 0o600)
		for _, step := range ph.Steps {
			put(step.Playbook, singlePlaybook(p, step), 0o600)
		}
	}
	for _, list := range [][]*PlanStep{st.Tests, st.Endpoint, st.Cleanup} {
		for _, s := range list {
			if s.Skipped != "" {
				continue
			}
			put(s.Playbook, singlePlaybook(p, s), 0o600)
		}
	}

	if err := copyRoles(p, b); err != nil {
		return nil, err
	}
	if err := inlineRoles(p, st, b); err != nil {
		return nil, err
	}
	attachActions(st, b.Project, opt.ProjectDir)
	for name, data := range opt.Materials {
		put("files/"+name, data, 0o600)
	}
	for _, in := range p.Inputs {
		for _, f := range tlsFiles {
			if _, ok := opt.Materials[in.Instance+"/"+in.Name+"/"+f]; !ok {
				return nil, fmt.Errorf("缺少 %s 的 %s（%s）", in.Instance, in.Label, f)
			}
		}
	}

	spec, err := p.Normalized().YAML()
	if err != nil {
		return nil, err
	}
	put("deployment.yml", spec, 0o600)
	b.Lock = lockDoc(p, resolved, opt)
	put("deployment.lock.json", b.Lock, 0o600)
	b.Docs = Handbooks(p, st, opt, resolved)
	b.PlanDoc = planDoc(p, st, opt)
	put("plan.json", b.PlanDoc, 0o600)
	return b, nil
}

var tlsFiles = []string{"server.crt", "server.key", "ca.crt"}

// SSHTrustScript is the root SSH trust helper that every machine package carries.
func SSHTrustScript(catalog ...*Catalog) []byte {
	var c *Catalog
	if len(catalog) > 0 {
		c = catalog[0]
	}
	b, _ := fs.ReadFile(c.platformFS(), "files/setup-root-ssh-trust.sh")
	return b
}

const ansibleCfg = `[defaults]
inventory = inventory/hosts.yml
roles_path = roles
host_key_checking = True
retry_files_enabled = False
gathering = explicit
forks = 20
interpreter_python = /usr/bin/python3
stdout_callback = default
callback_plugins = callback_plugins
callbacks_enabled = mw_log
nocows = 1

timeout = 30

[ssh_connection]
ssh_args = -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
pipelining = True
usetty = False
`

func hostGroup(hosts []string) omap {
	m := omap{}
	for _, h := range hosts {
		m = append(m, kv{h, omap{}})
	}
	return m
}

func firstOf(l []string) []string {
	if len(l) == 0 {
		return nil
	}
	return l[:1]
}

func inventoryDoc(p *Plan) ([]byte, error) {
	hosts := omap{}
	for _, h := range p.DeliveryHosts() {
		e := omap{{"ansible_host", h.IP}, {"ansible_user", "root"}, {"ansible_python_interpreter", "/usr/bin/python3"}}
		if h.Name == p.Controller {
			e = append(e, kv{"ansible_connection", "local"})
		}
		hosts = append(hosts, kv{h.Name, e})
	}
	children := omap{
		{"controller", omap{{"hosts", hostGroup([]string{p.Controller})}}},
		{"managed", omap{{"hosts", hostGroup(p.managedHosts())}}},
	}
	if dh := p.dataHosts(); len(dh) > 0 {
		children = append(children, kv{"mw_data", omap{{"hosts", hostGroup(dh)}}})
	}
	for _, inst := range p.Instances {
		if inst.External {
			continue
		}
		children = append(children, kv{grp(inst.ID), omap{{"hosts", hostGroup(inst.Hosts)}}})
		for _, role := range inst.R.Roles {
			hs := inst.Roles[role.Name]
			if len(hs) == 0 {
				continue
			}
			children = append(children, kv{roleGrp(inst.ID, role.Name), omap{{"hosts", hostGroup(hs)}}})
			children = append(children, kv{firstGrp(inst.ID, role.Name), omap{{"hosts", hostGroup(hs[:1])}}})
		}
	}
	doc := omap{{"all", omap{{"hosts", hosts}, {"children", children}}}}
	return yamlDoc(generatedNote, doc), nil
}

func healthMap(h Health) map[string]any {
	return map[string]any{"type": h.Type, "port": h.Port, "path": h.Path, "status": h.Status, "send": h.Send, "expect": h.Expect}
}

func epMap(e EndpointFacts) map[string]any {
	be := make([]map[string]any, 0, len(e.Backends))
	for _, x := range e.Backends {
		be = append(be, map[string]any{"host": x.Host, "ip": x.IP, "port": x.Port, "role": x.Role})
	}
	return map[string]any{"name": e.Name, "title": e.Title, "protocol": e.Protocol, "port": e.Port, "backends": be, "health": healthMap(e.Health), "lb": e.LB, "note": e.Note}
}

func paramVars(inst *Instance) map[string]any {
	out := map[string]any{}
	for k, v := range inst.Params {
		out[k] = v
	}
	for _, pr := range inst.R.Params {
		if pr.Type == "size" {
			if kb, err := ParseSize(fmt.Sprint(inst.Params[pr.Key])); err == nil {
				out[pr.Key+"_bytes"] = kb * 1024
			}
		}
	}
	return out
}

func providerView(p *Plan, id string) map[string]any {
	i := p.Instance(id)
	if i == nil {
		return nil
	}
	roles := map[string]any{}
	for k, v := range i.Roles {
		roles[k] = v
	}
	return map[string]any{"id": i.ID, "component": i.Component, "version": i.Version, "hosts": i.Hosts, "roles": roles, "params": paramVars(i)}
}

func instanceVars(p *Plan, inst *Instance, res map[string]Artifact) map[string]any {
	roles := map[string]any{}
	for _, r := range inst.R.Roles {
		hs := inst.Roles[r.Name]
		if hs == nil {
			hs = []string{}
		}
		roles[r.Name] = hs
	}
	pk := make([]map[string]any, 0, len(inst.Packages))
	for _, x := range inst.Packages {
		pk = append(pk, map[string]any{"name": x.Name, "version": x.Version, "spec": PackageSpec(p.Platform.Family, x.Name, x.Version)})
	}
	uses := map[string]any{}
	for cap, u := range inst.Uses {
		uses[cap] = providerView(p, u.Instance)
	}
	binds := make([]map[string]any, 0, len(inst.Binds))
	for _, bd := range inst.Binds {
		binds = append(binds, map[string]any{"name": bd.Name, "target": bd.Target, "listen": bd.Listen, "endpoint": epMap(bd.Endpoint), "check": healthMap(bd.Check)})
	}
	eps := make([]map[string]any, 0, len(inst.Endpoints))
	for _, e := range inst.Endpoints {
		eps = append(eps, epMap(e))
	}
	fronts := map[string]any{}
	for k, f := range inst.Fronts {
		fronts[k] = map[string]any{"balancer": f.Balancer, "name": f.Name, "listen": f.Listen, "address": f.Address, "external": f.External, "mode": f.Mode, "resolve_ip": f.ResolveIP}
	}
	// Machines of load balancers in front of this instance: a layer-4 balancer makes clients look like the balancer.
	var sources []string
	seenSrc := map[string]bool{}
	for _, f := range inst.Fronts {
		if f.External {
			continue
		}
		if lb := p.Instance(f.Balancer); lb != nil {
			for _, h := range lb.Hosts {
				if ip := p.hostIP(h); ip != "" && !seenSrc[ip] {
					seenSrc[ip] = true
					sources = append(sources, ip)
				}
			}
		}
	}
	sort.Strings(sources)
	if sources == nil {
		sources = []string{}
	}
	secrets := map[string]any{}
	for _, s := range inst.R.Secrets {
		if !contains(inst.Secrets, s.Name) {
			continue
		}
		secrets[s.Name] = secretExpr(inst.ID, s)
	}
	inputs := map[string]any{}
	for _, in := range p.Inputs {
		if in.Instance == inst.ID {
			inputs[in.Name] = "{{ mw_files_dir }}/" + inst.ID + "/" + in.Name
		}
	}
	addons := make([]map[string]any, 0, len(inst.Addons))
	for _, a := range inst.Addons {
		dbs := a.Databases
		if len(dbs) == 0 && inst.R.Addons != nil {
			dbs = inst.R.Addons.Scope.Defaults
		}
		if dbs == nil {
			dbs = []string{}
		}
		addons = append(addons, map[string]any{"id": a.ID, "targets": dbs, "params": a.Params})
	}
	hostsList := inst.Hosts
	if hostsList == nil {
		hostsList = []string{}
	}
	return map[string]any{
		"id": inst.ID, "component": inst.Component, "title": inst.Title, "version": inst.Version,
		"auto": inst.Auto, "external": inst.External, "roles": roles, "hosts": hostsList,
		"params": paramVars(inst), "packages": pk, "uses": uses, "endpoints": eps, "binds": binds,
		"fronts": fronts, "front_sources": sources, "secrets": secrets, "inputs": inputs, "addons": addons,
	}
}

func secretExpr(inst string, s SecretSpec) string {
	n := s.Length
	if n == 0 {
		n = 32
	}
	return fmt.Sprintf("{{ lookup('ansible.builtin.password', mw_secret_dir ~ '/%s/%s length=%d chars=ascii_letters,digits') }}", inst, s.Name, n)
}

func groupVars(p *Plan, opt RenderOptions, res map[string]Artifact) ([]byte, error) {
	hosts := map[string]any{}
	for i, h := range p.Hosts {
		hosts[h.Name] = map[string]any{"params": h.Params, "ip": h.IP, "disk": h.Disk, "partition": h.Partition, "initialize": h.Initialize, "data": p.NeedsData(h.Name), "index": i}
	}
	if e := p.Dep.ExecutionHost; e != nil {
		hosts[e.Name] = map[string]any{"ip": e.IP, "data": false, "initialize": false, "disk": "", "partition": "", "params": map[string]any{}, "execution_only": true}
	}
	insts := map[string]any{}
	var secretList []map[string]any
	for _, inst := range p.Instances {
		insts[inst.ID] = instanceVars(p, inst, res)
		for _, s := range inst.R.Secrets {
			if contains(inst.Secrets, s.Name) {
				n := s.Length
				if n == 0 {
					n = 32
				}
				secretList = append(secretList, map[string]any{"instance": inst.ID, "name": s.Name, "length": n})
			}
		}
	}
	repos := []map[string]any{}
	if p.NeedsPackages() {
		sum := ""
		if opt.PackageRepo != nil {
			sum = opt.PackageRepo.SHA256
		}
		repos = append(repos, map[string]any{"name": "packages", "file": opt.repoFile(p), "root": "repo", "sha256": sum, "port": p.RepositoryPort()})
	}
	if secretList == nil {
		secretList = []map[string]any{}
	}
	doc := map[string]any{
		"mw_cluster":     map[string]any{"id": p.Dep.ID, "title": p.Dep.Title, "controller": p.Controller, "project": p.ProjectName()},
		"mw_hosts":       hosts,
		"mw_platforms":   p.Platforms,
		"mw_platform":    map[string]any{"id": p.Platform.ID, "family": p.Platform.Family, "os_ids": p.Platform.OSIDs, "version": p.Platform.Version, "arch": p.Platform.Arch},
		"mw_pkg_family":  p.Platform.Family,
		"mw_instances":   insts,
		"mw_repos":       repos,
		"mw_secret_list": secretList,
		"mw_secret_dir":  "{{ inventory_dir }}/../secrets",
		"mw_files_dir":   "{{ inventory_dir }}/../files",
		"mw_upload_dir":  opt.UploadDir,
	}
	var buf bytes.Buffer
	buf.WriteString("---\n# " + generatedNote + "\n")
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	return buf.Bytes(), enc.Close()
}

// ---- playbooks ----

func orderedTask(t map[string]any) omap {
	var out omap
	if v, ok := t["name"]; ok {
		out = append(out, kv{"name", v})
	}
	module, _ := TaskModule(t)
	if module != "" {
		out = append(out, kv{module, t[module]})
	}
	keys := make([]string, 0, len(t))
	for k := range t {
		if k != "name" && k != module {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		out = append(out, kv{k, t[k]})
	}
	return out
}

func confirmPlay(p *Plan, extra []string) omap {
	that := []string{"confirm_cluster | default('') == mw_cluster.id"}
	msg := "这一步会修改机器，请在命令末尾加上 -e confirm_cluster=" + p.Dep.ID + " 以确认操作的是这个集群"
	for _, v := range extra {
		that = append(that, v+" | default(false) | bool")
		msg += "，并加上 -e " + v + "=true 明确确认"
	}
	return omap{
		{"name", "确认集群标识"},
		{"hosts", "controller"},
		{"gather_facts", false},
		{"tags", []string{"always"}},
		{"tasks", []any{omap{
			{"name", "必须带 -e confirm_cluster=" + p.Dep.ID},
			{"ansible.builtin.assert", omap{
				{"that", that},
				{"fail_msg", msg},
				{"quiet", true},
			}},
		}}},
	}
}

func rolePlay(name, hosts string, tags []string, role, tasksFrom string, extraVars map[string]any, serial int, instVar string) omap {
	m := omap{{"name", name}, {"hosts", hosts}, {"gather_facts", false}, {"any_errors_fatal", true}}
	if serial > 0 {
		m = append(m, kv{"serial", serial})
	}
	if len(tags) > 0 {
		m = append(m, kv{"tags", tags})
	}
	vars := omap{}
	if instVar != "" {
		vars = append(vars, kv{"mw", "{{ mw_instances['" + instVar + "'] }}"})
	}
	keys := make([]string, 0, len(extraVars))
	for k := range extraVars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		vars = append(vars, kv{k, extraVars[k]})
	}
	if len(vars) > 0 {
		m = append(m, kv{"vars", vars})
	}
	imp := omap{{"name", name}, {"ansible.builtin.import_role", omap{{"name", role}, {"tasks_from", tasksFrom}}}}
	return append(m, kv{"tasks", []any{imp}})
}

func stepPlays(p *Plan, s *PlanStep) []any {
	title := s.Title
	if s.Instance != "" {
		title = "[" + s.Instance + "] " + s.Title
	}
	tags := []string{s.ID}
	if s.Instance != "" {
		tags = []string{s.Instance, s.ID}
	}
	if s.Phase != "" {
		tags = append(tags, s.Phase)
	}
	switch s.platform {
	case "secrets":
		return []any{rolePlay(title, "controller", tags, "mw_secrets", "main", nil, 0, "")}
	case "preflight":
		return []any{rolePlay(title, "managed", tags, "mw_preflight", "main", nil, 0, "")}
	case "data-disk":
		hosts := "mw_data"
		if strings.Contains(s.selector, ":&") {
			hosts = s.selector
		}
		return []any{rolePlay(title, hosts, tags, "mw_data_disk", "main", nil, 0, "")}
	case "offline-repo":
		return []any{
			rolePlay(title+"（控制节点提供仓库）", "controller", tags, "mw_offline_repo", "serve", nil, 0, ""),
			rolePlay(title+"（全部机器改用离线源）", "managed", tags, "mw_offline_repo", "client", nil, 0, ""),
		}
	}
	m := omap{{"name", title}, {"hosts", s.selector}, {"gather_facts", false}, {"any_errors_fatal", true}}
	if s.Serial > 0 {
		m = append(m, kv{"serial", s.Serial})
	}
	m = append(m, kv{"tags", tags})
	vars := omap{{"mw", p.taskContext(s.inst)}}
	if s.inst.R.C.Context != "" {
		vars = append(vars, kv{"mw_manager", "{{ mw_instances['" + s.inst.ID + "'] }}"})
	}
	if s.step.Run != nil {
		keys := make([]string, 0, len(s.step.Run.Vars))
		for k := range s.step.Run.Vars {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			vars = append(vars, kv{k, s.step.Run.Vars[k]})
		}
	}
	m = append(m, kv{"vars", vars})
	role, from := "", ""
	if s.step.Run != nil {
		role, from = s.step.Run.Role, s.step.Run.Tasks
	} else {
		role, from = s.TaskRole, s.TaskFile
	}
	tasks := []any{omap{{"name", s.Title}, {"ansible.builtin.import_role", omap{{"name", role}, {"tasks_from", from}}}}}
	return []any{append(m, kv{"tasks", tasks})}
}

// The callback uses this reserved identity even during a whole-phase run.
func identifiedStepPlays(p *Plan, s *PlanStep) []any {
	// Platform tasks are maintained with the runner contract; component tasks must opt in at publication.
	if s.platform != "" {
		s.Automatic = true
		if s.Timeout == 0 {
			s.Timeout = 1800
		}
	}
	plays := stepPlays(p, s)
	inputValues := omap{}
	inputChecks := []string{}
	inputNames := []string{}
	for name := range s.step.Inputs {
		inputNames = append(inputNames, name)
	}
	sort.Strings(inputNames)
	for _, name := range inputNames {
		input := s.step.Inputs[name]
		inputValues = append(inputValues, kv{name, input.Value})
		expr := "mw_step_inputs['" + name + "']"
		test := map[string]string{"string": "string", "int": "integer", "bool": "boolean", "list": "sequence", "map": "mapping"}[input.Type]
		inputChecks = append(inputChecks, expr+" is "+test)
		if input.Type == "list" {
			inputChecks = append(inputChecks, expr+" is not string", expr+" is not mapping")
		}
	}
	for i, value := range plays {
		play := value.(omap)
		found := false
		for j := range play {
			if play[j].k == "vars" {
				vars := play[j].v.(omap)
				kept := omap{}
				for _, v := range vars {
					if v.k != "_mw_step_playbook" && v.k != "mw_step_inputs" {
						kept = append(kept, v)
					}
				}
				play[j].v = append(kept, kv{"_mw_step_playbook", s.Playbook}, kv{"mw_step_inputs", inputValues})
				found = true
			}
		}
		if !found {
			play = append(play, kv{"vars", omap{{"_mw_step_playbook", s.Playbook}, {"mw_step_inputs", inputValues}}})
		}
		gate := func(name string, conditions []string) []any {
			return []any{omap{{"name", name}, {"ansible.builtin.assert", omap{{"that", conditions}, {"fail_msg", "步骤 " + s.ID + " 的契约条件未通过"}}}}}
		}
		conditions := append(append([]string{}, inputChecks...), s.step.Preconditions...)
		if i == 0 && len(conditions) > 0 {
			checks := gate("核对步骤输入与前置条件", conditions)
			// Inputs may include credentials; assertion values must not enter logs.
			task := checks[0].(omap)
			checks[0] = append(task, kv{"no_log", true})
			play = append(play, kv{"pre_tasks", checks})
		}
		if i == len(plays)-1 && len(s.step.Postconditions) > 0 {
			play = append(play, kv{"post_tasks", gate("核对步骤完成条件", s.step.Postconditions)})
		}
		plays[i] = play
	}
	return plays
}

func phasePlaybook(p *Plan, ph *PhaseDoc) []byte {
	var plays []any
	if ph.Confirm {
		plays = append(plays, confirmPlay(p, nil))
	}
	for _, s := range ph.Steps {
		plays = append(plays, identifiedStepPlays(p, s)...)
	}
	return yamlDoc(ph.Title+"（阶段 "+ph.Phase+"）\n"+generatedNote, plays)
}

func singlePlaybook(p *Plan, s *PlanStep) []byte {
	var plays []any
	if s.Confirm {
		plays = append(plays, confirmPlay(p, s.ConfirmVars))
	}
	plays = append(plays, identifiedStepPlays(p, s)...)
	return yamlDoc(s.Title+"\n"+generatedNote, plays)
}

// ---- roles ----

func copyRoles(p *Plan, b *Bundle) error {
	add := func(name string, data []byte, mode int64, from string) error {
		if prev, ok := b.Project[name]; ok && !bytes.Equal(prev.Data, data) {
			return fmt.Errorf("角色文件 %s 被多个来源提供且内容不同（%s）：请给角色换一个不冲突的名字", name, from)
		}
		b.Project[name] = File{data, mode}
		return nil
	}
	walk := func(fsys fs.FS, root, prefix string) error {
		return fs.WalkDir(fsys, root, func(fp string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			data, err := fs.ReadFile(fsys, fp)
			if err != nil {
				return err
			}
			rel := strings.TrimPrefix(fp, root+"/")
			mode := int64(0o600)
			if strings.HasSuffix(fp, ".sh") || strings.HasSuffix(fp, ".py") {
				mode = 0o700
			}
			return add(prefix+rel, data, mode, fp)
		})
	}
	if err := walk(p.Cat.platformFS(), "roles", "roles/"); err != nil {
		return err
	}
	done := map[string]bool{}
	for _, inst := range p.Instances {
		if inst.External || done[inst.Component] {
			continue
		}
		done[inst.Component] = true
		fsys, dir := inst.R.C.FS()
		if fsys == nil {
			continue
		}
		root := path.Join(dir, "roles")
		if _, err := fs.Stat(fsys, root); err != nil {
			continue
		}
		if err := walk(fsys, root, "roles/"); err != nil {
			return err
		}
	}
	return nil
}

// ---- lock and plan documents ----

func lockDoc(p *Plan, res map[string]Artifact, opt RenderOptions) []byte {
	type art struct {
		Name   string `json:"name"`
		File   string `json:"file"`
		SHA256 string `json:"sha256,omitempty"`
	}
	type pkg struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	type inst struct {
		DeliveryModes []string       `json:"delivery_modes"`
		Scheme        *SchemeSummary `json:"scheme,omitempty"`
		Packages      []pkg          `json:"packages,omitempty"`
		ID            string         `json:"id"`
		Comp          string         `json:"component"`
		Version       string         `json:"version"`
		Status        string         `json:"status"`
		Manifest      string         `json:"manifest_sha256"`
		Auto          bool           `json:"auto,omitempty"`
		Artifacts     []art          `json:"artifacts,omitempty"`
	}
	doc := struct {
		Schema     string   `json:"schema"`
		Cluster    string   `json:"cluster"`
		Controller string   `json:"controller"`
		Platform   string   `json:"platform"`
		Platforms  []string `json:"platforms"`
		Repo       *struct {
			File   string `json:"file"`
			SHA256 string `json:"sha256,omitempty"`
		} `json:"package_repository,omitempty"`
		Instances []inst `json:"instances"`
	}{Schema: "mwlock/v1", Cluster: p.Dep.ID, Controller: p.Controller, Platform: p.Platform.ID, Platforms: p.Platforms}
	if p.NeedsPackages() {
		doc.Repo = &struct {
			File   string `json:"file"`
			SHA256 string `json:"sha256,omitempty"`
		}{File: opt.repoFile(p)}
		if opt.PackageRepo != nil {
			doc.Repo.SHA256 = opt.PackageRepo.SHA256
		}
	}
	for _, i := range p.Instances {
		x := inst{DeliveryModes: i.R.C.EffectiveDeliveryModes(), Scheme: i.SchemeSummary(), ID: i.ID, Comp: i.Component, Version: i.Version, Status: i.R.PlatformStatus(p.Platform.ID), Manifest: i.R.C.sum, Auto: i.Auto}
		for _, pk := range i.Packages {
			x.Packages = append(x.Packages, pkg{pk.Name, pk.Version})
		}
		if !i.External {
			env := i.Env()
			for _, a := range i.R.Artifacts {
				if on, _ := env.Bool(a.When); !on {
					continue
				}
				r := res[a.Name]
				x.Artifacts = append(x.Artifacts, art{a.Name, a.File, r.SHA256})
			}
		}
		doc.Instances = append(doc.Instances, x)
	}
	b, _ := json.MarshalIndent(doc, "", "  ")
	return append(b, '\n')
}

func planDoc(p *Plan, st *Steps, opt RenderOptions) []byte {
	type phase struct {
		Phase    string      `json:"phase"`
		Title    string      `json:"title"`
		Playbook string      `json:"playbook"`
		Command  string      `json:"command"`
		Steps    []*PlanStep `json:"steps"`
	}
	type hostView struct {
		Name string `json:"name"`
		IP   string `json:"ip"`
	}
	mode := p.Dep.DeliveryMode
	if mode == "" {
		mode = "offline"
	}
	doc := struct {
		DeliveryMode  string         `json:"delivery_mode,omitempty"`
		ExecutionHost *ExecutionHost `json:"execution_host,omitempty"`
		Platform      string         `json:"platform"`
		StepFormat    int            `json:"step_format"`
		Cluster       string         `json:"cluster"`
		Project       string         `json:"project"`
		Controller    string         `json:"controller"`
		ProjectDir    string         `json:"project_dir"`
		RuntimeRoot   string         `json:"runtime_root"`
		UploadDir     string         `json:"upload_dir"`
		Hosts         []hostView     `json:"hosts"`
		Instances     []InstanceView `json:"instances"`
		Prepare       []*PlanStep    `json:"prepare"`
		Deploy        []phase        `json:"deploy"`
		Tests         []*PlanStep    `json:"tests"`
		Endpoint      []*PlanStep    `json:"endpoint_tests"`
		Cleanup       []*PlanStep    `json:"cleanup"`
		Warnings      []Problem      `json:"warnings,omitempty"`
	}{DeliveryMode: mode, RuntimeRoot: p.RuntimeRoot(), Platform: p.Platform.ID, ExecutionHost: p.Dep.ExecutionHost, StepFormat: 2, Cluster: p.Dep.ID, Project: p.ProjectName(), Controller: p.Controller, ProjectDir: opt.ProjectDir, UploadDir: opt.UploadDir, Instances: p.View().Instances, Prepare: PrepareSteps(p, opt), Tests: st.Tests, Endpoint: st.Endpoint, Cleanup: st.Cleanup}
	for _, h := range p.Hosts {
		doc.Hosts = append(doc.Hosts, hostView{h.Name, h.IP})
	}
	// Empty lists must be [] and not null, or consumers have to guard every access.
	for _, l := range []*[]*PlanStep{&doc.Prepare, &doc.Tests, &doc.Endpoint, &doc.Cleanup} {
		if *l == nil {
			*l = []*PlanStep{}
		}
	}
	if doc.Instances == nil {
		doc.Instances = []InstanceView{}
	}
	for _, ph := range st.Phases {
		doc.Deploy = append(doc.Deploy, phase{ph.Phase, ph.Title, ph.Playbook, ph.Command, ph.Steps})
	}
	for _, i := range p.Issues {
		if i.Severity == "warning" {
			doc.Warnings = append(doc.Warnings, i)
		}
	}
	b, _ := json.MarshalIndent(doc, "", "  ")
	return append(b, '\n')
}

// Digest is a convenience for callers hashing generated files.
func Digest(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// inlineRoles turns the declarative steps of components into role task files, together with each component's
// templates/ and files/, so L1 components need no hand-written role but can still ship configuration templates.
func inlineRoles(p *Plan, st *Steps, b *Bundle) error {
	put := func(name string, data []byte, mode int64) error {
		if prev, ok := b.Project[name]; ok && !bytes.Equal(prev.Data, data) {
			return fmt.Errorf("生成的角色文件 %s 在不同实例间内容不同（同一组件的两个版本不能同时带有不同的内联步骤）", name)
		}
		b.Project[name] = File{data, mode}
		return nil
	}
	var all []*PlanStep
	for _, ph := range st.Phases {
		all = append(all, ph.Steps...)
	}
	all = append(all, st.Tests...)
	all = append(all, st.Endpoint...)
	all = append(all, st.Cleanup...)
	copied := map[string]bool{}
	for _, s := range all {
		if s.TaskFile == "" || s.Skipped != "" {
			continue
		}
		tasks := make([]any, 0, len(s.step.Tasks))
		for _, t := range s.step.Tasks {
			tasks = append(tasks, orderedTask(t))
		}
		if err := put("roles/"+s.TaskRole+"/tasks/"+s.TaskFile+".yml", yamlDoc(s.Title+"\n"+generatedNote, tasks), 0o600); err != nil {
			return err
		}
		if copied[s.TaskRole] {
			continue
		}
		copied[s.TaskRole] = true
		fsys, dir := s.inst.R.C.FS()
		if fsys == nil {
			continue
		}
		for _, sub := range []string{"templates", "files"} {
			root := path.Join(dir, sub)
			if _, err := fs.Stat(fsys, root); err != nil {
				continue
			}
			err := fs.WalkDir(fsys, root, func(fp string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() {
					return err
				}
				data, err := fs.ReadFile(fsys, fp)
				if err != nil {
					return err
				}
				mode := int64(0o600)
				if strings.HasSuffix(fp, ".sh") || strings.HasSuffix(fp, ".py") {
					mode = 0o700
				}
				return put("roles/"+s.TaskRole+"/"+sub+"/"+strings.TrimPrefix(fp, root+"/"), data, mode)
			})
			if err != nil {
				return err
			}
		}
	}
	return nil
}

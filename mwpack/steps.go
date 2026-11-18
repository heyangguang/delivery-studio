package mwpack

import (
	"fmt"
	"path"
	"strings"
)

// Step sections of the handbook.
const (
	SecDeploy   = "deploy"
	SecTest     = "test"
	SecEndpoint = "endpoint"
	SecCleanup  = "cleanup"
)

// PlanStep is one reviewable unit as it appears in a playbook and in the handbook. Both are rendered from
// this list, so they cannot disagree.
type PlanStep struct {
	Automatic      bool     `json:"automatic,omitempty"`
	Timeout        int      `json:"timeout,omitempty"`
	Postconditions []string `json:"postconditions,omitempty"`

	// Sources records exact source ownership and hashes for review/reproduction.
	Sources  []StepSource `json:"sources,omitempty"`
	Section  string       `json:"section"`
	Phase    string       `json:"phase,omitempty"`
	Instance string       `json:"instance,omitempty"` // empty for platform steps
	ID       string       `json:"id"`
	Title    string       `json:"title"`
	Desc     string       `json:"desc,omitempty"`
	Effect   string       `json:"effect"`
	Expect   string       `json:"expect,omitempty"`
	Hosts    []string     `json:"hosts"`
	Serial   int          `json:"serial,omitempty"`
	Playbook string       `json:"playbook"`
	Command  string       `json:"command"`
	Confirm  bool         `json:"confirm,omitempty"`
	// ConfirmVars are extra -e flags the command carries for dangerous steps (for example discarding backups).
	ConfirmVars []string `json:"confirm_vars,omitempty"`
	// Skipped is set for steps that exist in the component but do not apply to this deployment.
	Skipped string `json:"skipped,omitempty"`
	// Rollback is how to undo the step (see Step.Rollback); empty when nobody declared it.
	Rollback string `json:"rollback,omitempty"`

	// Actions are the step's tasks said as commands (see distill.go), for a person who runs the step by hand.
	Actions []Action `json:"actions,omitempty"`

	// TaskRole/TaskFile name the generated role task file that holds an inline step's tasks.
	TaskRole string `json:"-"`
	TaskFile string `json:"-"`

	step     Step
	inst     *Instance
	platform string // platform step kind
	selector string // inventory host pattern
}

// PhaseDoc is a deploy phase: one playbook with several steps.
type PhaseDoc struct {
	Phase    string
	Title    string
	Playbook string
	Command  string
	Confirm  bool
	Steps    []*PlanStep
}

// Steps is everything the handbooks and playbooks are built from.
type Steps struct {
	Phases   []*PhaseDoc
	Tests    []*PlanStep // ordered; includes skipped ones for the handbook
	Endpoint []*PlanStep
	Cleanup  []*PlanStep
}

func stepOwner(s *PlanStep) string {
	if s.Instance == "" {
		return "platform"
	}
	return "instance-" + s.Instance
}

func grp(id string) string { return strings.ReplaceAll(id, "-", "_") }
func roleGrp(id, role string) string {
	return grp(id) + "__" + strings.ReplaceAll(role, "-", "_")
}
func firstGrp(id, role string) string { return roleGrp(id, role) + "__first" }

// pattern turns a host selector into an inventory pattern and the machines it covers.
func (i *Instance) pattern(sel string) (string, []string) {
	roles, first := HostSelector(sel)
	if len(roles) == 1 && roles[0] == "controller" && !first {
		return "controller", []string{i.controller}
	}
	if len(roles) == 0 {
		return grp(i.ID), append([]string(nil), i.Hosts...)
	}
	if first {
		hs := i.Roles[roles[0]]
		if len(hs) == 0 {
			return "", nil
		}
		return firstGrp(i.ID, roles[0]), []string{hs[0]}
	}
	var pats, hosts []string
	seen := map[string]bool{}
	for _, r := range roles {
		if len(i.Roles[r]) == 0 {
			continue
		}
		pats = append(pats, roleGrp(i.ID, r))
		for _, h := range i.Roles[r] {
			if !seen[h] {
				seen[h] = true
				hosts = append(hosts, h)
			}
		}
	}
	return strings.Join(pats, ":"), hosts
}

func (p *Plan) NeedsData(host string) bool {
	for _, i := range p.Instances {
		if i.External || !i.R.C.DataVolume {
			continue
		}
		for _, h := range i.Hosts {
			if h == host {
				return true
			}
		}
	}
	return false
}

func (p *Plan) dataHosts() []string {
	var out []string
	for _, h := range p.Hosts {
		if p.NeedsData(h.Name) {
			out = append(out, h.Name)
		}
	}
	return out
}

func (p *Plan) managedHosts() []string {
	var out []string
	seen := map[string]bool{}
	for _, i := range p.Instances {
		for _, h := range i.Hosts {
			if !seen[h] {
				seen[h] = true
				out = append(out, h)
			}
		}
	}
	// Keep the user's machine order.
	ordered := []string{}
	for _, h := range p.Hosts {
		if seen[h.Name] {
			ordered = append(ordered, h.Name)
		}
	}
	_ = out
	return ordered
}

// Artifacts lists every offline file the delivery must carry.
func (p *Plan) Artifacts() []Artifact {
	var out []Artifact
	seen := map[string]bool{}
	for _, i := range p.Instances {
		if i.External {
			continue
		}
		env := i.Env()
		list := append([]Artifact(nil), i.R.Artifacts...)
		for _, ad := range i.Addons {
			if i.R.Addons != nil {
				for _, a := range i.R.Addons.Items {
					if a.ID == ad.ID {
						list = append(list, a.Artifacts...)
					}
				}
			}
		}
		for _, a := range list {
			if seen[a.Name] {
				continue
			}
			if on, _ := env.Bool(a.When); !on {
				continue
			}
			seen[a.Name] = true
			out = append(out, a)
		}
	}
	return out
}

// BuildSteps expands lifecycle, tests and cleanup of every instance, in dependency order.
func (p *Plan) BuildSteps(runner string) *Steps {
	st := &Steps{}
	cmd := func(playbook string, confirm bool) string {
		c := runner + " " + playbook
		if confirm {
			c += " -e confirm_cluster=" + p.Dep.ID
		}
		return c
	}
	n := 0
	for _, phase := range Phases {
		pd := &PhaseDoc{Phase: phase, Title: PhaseTitles[phase], Playbook: fmt.Sprintf("playbooks/%02d-%s.yml", n, phase)}
		n++
		// Platform steps come first.
		switch phase {
		case "preflight":
			if p.hasSecrets() {
				pd.Steps = append(pd.Steps, &PlanStep{Section: SecDeploy, Phase: phase, ID: "secrets", Title: "生成并保存密码", Desc: "在控制节点的 secrets/ 目录为本次部署生成随机密码；已存在的保持不变。密码只保存在控制节点，不会进入手册和日志。", Effect: "change", Hosts: []string{p.Controller}, Rollback: "不需要回退：重跑时已有的密码保持不变。不要删除 secrets/ 目录，集群建好后删掉的密码无法找回。", platform: "secrets", selector: "controller"})
			}
			pd.Steps = append(pd.Steps, &PlanStep{Section: SecDeploy, Phase: phase, ID: "host-check", Title: "核对机器与系统", Desc: "只读：主机名、IP、系统版本与架构、各机器互相解析、数据盘状态。不修改任何东西，是最便宜的一次试跑。", Effect: "read-only", Expect: "每台机器都通过；任何一项失败都先排查再继续。", Hosts: p.managedHosts(), Rollback: "只读，不需要回退。", platform: "preflight", selector: "managed"})
		case "install":
			if dh := p.dataHosts(); len(dh) > 0 {
				init := false
				for _, h := range p.Hosts {
					for _, x := range dh {
						init = init || (x == h.Name && h.Initialize)
					}
				}
				eff, desc := "read-only", "按机器的数据存储方式准备配置的数据根目录：独立数据盘检查挂载，系统盘目录只准备普通目录，不格式化磁盘。"
				for _, h := range p.Hosts {
					if h.Params["storage_mode"] == "system_directory" {
						eff = "change"
					}
				}
				if init {
					eff, desc = "destructive", "对选择初始化的新空盘分区、格式化并挂载到配置的数据根目录；盘上已有签名、分区或数据时停止。未选择初始化的机器只核对挂载。"
				}
				pd.Steps = append(pd.Steps, &PlanStep{Section: SecDeploy, Phase: phase, ID: "data-disk", Title: "数据盘", Desc: desc, Effect: eff, Hosts: dh, Rollback: map[bool]string{true: "不可回退：分区和格式化无法撤销。盘上已有签名、分区或数据时这一步会自己停下；执行前再确认一次设备名。", false: "只读，不需要回退。"}[init], platform: "data-disk", selector: "data"})
			}
			if p.NeedsPackages() {
				pd.Steps = append(pd.Steps, &PlanStep{Section: SecDeploy, Phase: phase, ID: "offline-repo", Title: "离线软件仓库", Desc: "校验软件仓库包的哈希，在控制节点解包并以 HTTP 提供，所有机器改用该仓库；原有软件源备份后停用，不安装任何软件。", Effect: "change", Hosts: p.managedHosts(), Rollback: fmt.Sprintf("每台机器原来的软件源都移到了备份目录（这一步输出里 Old sources saved to 那一行），要恢复就把备份里的文件移回原处，删除 mw-%[1]s 的源文件，再刷新软件包列表。控制节点上的仓库服务用 systemctl disable --now mw-repo-%[1]s-packages 停掉。", p.Dep.ID), platform: "offline-repo", selector: "managed"})
			}
		}
		for _, inst := range p.Instances {
			if inst.External {
				continue
			}
			env := inst.Env()
			for _, s := range inst.R.Lifecycle[phase] {
				if on, _ := env.Bool(s.When); !on {
					continue
				}
				pat, hosts := inst.pattern(s.Hosts)
				if len(hosts) == 0 {
					continue
				}
				ps := stepOf(SecDeploy, phase, inst, s, pat, hosts)
				pd.Steps = append(pd.Steps, ps)
			}
		}
		if len(pd.Steps) == 0 {
			n--
			continue
		}
		for _, s := range pd.Steps {
			s.Playbook = path.Join("steps", "deploy", pd.Phase, stepOwner(s), s.ID+".yml")
			if s.Effect != "read-only" {
				pd.Confirm = true
			}
		}
		pd.Command = cmd(pd.Playbook, pd.Confirm)
		for _, s := range pd.Steps {
			s.Confirm = s.Effect != "read-only"
			s.ConfirmVars = s.step.Confirm
			s.Command = cmd(s.Playbook, s.Confirm)
			for _, v := range s.ConfirmVars {
				s.Command += " -e " + v + "=true"
			}
		}
		st.Phases = append(st.Phases, pd)
	}
	p.buildChecks(runner, st)
	return st
}

// buildChecks adds the tests, endpoint tests and cleanup steps. A first deployment carries all of them; a plan only
// the read-only checks.
func (p *Plan) buildChecks(runner string, st *Steps) {
	cmd := func(playbook string, confirm bool) string {
		c := runner + " " + playbook
		if confirm {
			c += " -e confirm_cluster=" + p.Dep.ID
		}
		return c
	}
	collect := func(sec string, pick func(*Resolved) []Step, dir string) []*PlanStep {
		var out []*PlanStep
		for _, inst := range p.Instances {
			if inst.External {
				continue
			}
			env := inst.Env()
			fronts := inst.Fronts
			if cap := inst.R.C.Context; cap != "" {
				if u := inst.Uses[cap]; u != nil {
					if target := p.Instance(u.Instance); target != nil {
						fronts = target.Fronts
					}
				}
			}
			for _, s := range pick(inst.R) {
				isEndpoint := strings.HasPrefix(s.Scope, "endpoint:")
				if (sec == SecEndpoint) != isEndpoint {
					continue
				}
				missingEndpoint := false
				if isEndpoint {
					_, bound := fronts[strings.TrimPrefix(s.Scope, "endpoint:")]
					missingEndpoint = !bound
				}
				on, _ := env.Bool(s.When)
				pat, hosts := inst.pattern(s.Hosts)
				ps := stepOf(sec, "", inst, s, pat, hosts)
				if !on || len(hosts) == 0 {
					ps.Skipped = p.checkSkipReason(inst, s)
					out = append(out, ps)
					continue
				}
				if missingEndpoint {
					ps.Skipped = "未配置访问入口（负载均衡），不执行此入口测试"
					out = append(out, ps)
					continue
				}
				ps.Playbook = path.Join(dir, inst.ID, s.ID+".yml")
				ps.Confirm = ps.Effect != "read-only"
				ps.ConfirmVars = s.Confirm
				ps.Command = cmd(ps.Playbook, ps.Confirm)
				for _, v := range s.Confirm {
					ps.Command += " -e " + v + "=true"
				}
				out = append(out, ps)
			}
		}
		return out
	}
	st.Tests = collect(SecTest, func(r *Resolved) []Step { return r.Tests }, "tests")
	st.Endpoint = collect(SecEndpoint, func(r *Resolved) []Step { return r.Tests }, "tests-endpoint")
	st.Cleanup = collect(SecCleanup, func(r *Resolved) []Step { return r.Cleanup }, "cleanup")
}

// inlineRole is the role an inline step is generated into; it also carries the component's templates and files.
func inlineRole(component string) string { return "mw_" + strings.ReplaceAll(component, "-", "_") }

func stepOf(sec, phase string, inst *Instance, s Step, pat string, hosts []string) *PlanStep {
	eff := s.Effect
	if eff == "" {
		eff = "change"
	}
	var taskRole, taskFile string
	if len(s.Tasks) > 0 {
		kind := phase
		if sec != SecDeploy {
			kind = sec
		}
		taskRole, taskFile = inlineRole(inst.Component), kind+"_"+s.ID
	}
	rb := s.Rollback
	if rb == "" && eff == "read-only" {
		rb = "只读，不需要回退。"
	}
	return &PlanStep{Automatic: inst.R.C.SupportsDelivery("automatic"), Timeout: s.Timeout, Postconditions: s.Postconditions, TaskRole: taskRole, TaskFile: taskFile, Section: sec, Phase: phase, Instance: inst.ID, ID: s.ID, Title: s.Title, Desc: s.Desc, Effect: eff, Expect: s.Expect, Hosts: hosts, Serial: s.Serial, Rollback: inst.FillText(rb), step: s, inst: inst, selector: pat}
}

func (p *Plan) hasSecrets() bool {
	for _, i := range p.Instances {
		if len(i.Secrets) > 0 {
			return true
		}
	}
	return false
}

// Disabled checks must describe ownership rather than invent missing replicas.
func (p *Plan) checkSkipReason(inst *Instance, step Step) string {
	for _, manager := range p.Instances {
		if cap := manager.R.C.Context; cap != "" {
			if use := manager.Uses[cap]; use != nil && use.Instance == inst.ID {
				return fmt.Sprintf("当前实例由 %s 管理；%s 不单独执行此项，请查看管理组件的对应检查及适用条件", manager.ID, inst.ID)
			}
		}
	}
	if inst.Component == "postgresql" {
		mode, _ := inst.Params["deployment_mode"].(string)
		if mode == "replication" && strings.Contains(step.When, "params.deployment_mode") {
			return "当前为原生主从方案，此项的方案条件未满足；请查看原生主从流复制验收"
		}
	}
	return firstNonEmpty(step.Skip, "不适用于当前配置")
}

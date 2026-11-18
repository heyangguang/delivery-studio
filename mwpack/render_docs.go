package mwpack

import (
	"fmt"
	"sort"
	"strings"
)

// PackageName is the upload archive for the i-th (0-based) machine of a plan whose project is called project (see
// ProjectName).
func PackageName(i int, project, ip string) string {
	return fmt.Sprintf("node%02d-%s-%s.tar.gz", i+1, project, ip)
}

var effectLabel = map[string]string{
	"read-only":   "只读",
	"change":      "修改",
	"disruptive":  "会中断服务",
	"destructive": "会清除或格式化数据",
}

func fence(code string) string { return "```bash\n" + strings.TrimRight(code, "\n") + "\n```\n\n" }

func hostList(hs []string) string { return strings.Join(hs, "、") }

func controllerTrustCommand(p *Plan, h Host) string {
	kit := "cd " + p.PackageBase() + "/mw-setup\n"
	if p.Dep.ExecutionHost != nil {
		return kit + fmt.Sprintf("bash setup-root-ssh-trust.sh trust-host %s %s\nbash setup-root-ssh-trust.sh check %s %s", h.IP, h.Name, h.IP, h.Name)
	}
	return kit + fmt.Sprintf("bash setup-root-ssh-trust.sh trust-node %s\nbash setup-root-ssh-trust.sh check-node %s", h.Name, h.Name)
}

func statusLabel(s string) string { return statusName(s) }

// Handbooks renders the field documents from the plan and its steps.
func Handbooks(p *Plan, st *Steps, opt RenderOptions, res map[string]Artifact) map[string][]byte {
	docs := map[string][]byte{}
	docs["00-环境准备.md"] = []byte(docPrepare(p, opt, res))
	docs["01-部署步骤.md"] = []byte(docDeploy(p, st, opt))
	docs["02-功能测试.md"] = []byte(docTests(p, st, opt))
	if d := docEndpoint(p, st, opt); d != "" {
		docs["03-入口测试.md"] = []byte(d)
	}
	if len(st.Cleanup) > 0 {
		docs["04-清理步骤.md"] = []byte(docCleanup(p, st, opt))
	}
	return docs
}

func overview(p *Plan) string {
	var b strings.Builder
	title := p.Dep.Title
	if title == "" {
		title = p.Dep.ID
	}
	fmt.Fprintf(&b, "集群标识 `%s`（%s）。控制节点是 **%s**：所有 Ansible 命令都在这台机器上以 root 执行，其他机器只需要完成免密配置。\n\n", p.Dep.ID, title, p.Controller)
	if e := p.Dep.ExecutionHost; e != nil {
		fmt.Fprintf(&b, "独立执行机：**%s**（%s），不部署数据库、不初始化数据盘。软件源端口：%d。执行机当前须使用与目标相同的平台 %s。\n\n", e.Name, e.IP, e.RepositoryPort, p.Platform.ID)
	}
	b.WriteString("### 机器\n\n|名称|IP|数据盘|承担|\n|---|---|---|---|\n")
	roles := map[string][]string{}
	for _, inst := range p.Instances {
		if inst.External {
			continue
		}
		for _, r := range inst.R.Roles {
			for _, h := range inst.Roles[r.Name] {
				roles[h] = append(roles[h], inst.ID+" / "+firstNonEmpty(r.Title, r.Name))
			}
		}
	}
	for _, h := range p.Hosts {
		disk := "无"
		root, _ := h.Params["data_root"].(string)
		if root == "" {
			root = "/data"
		}
		if p.NeedsData(h.Name) {
			switch {
			case h.Params["storage_mode"] == "system_directory":
				disk = "系统盘普通目录 " + root + "（不格式化磁盘）"
			case h.Initialize:
				disk = h.Disk + "（初始化新盘并挂载到 " + root + "）"
			case h.Disk != "":
				disk = h.Disk + "（沿用已挂载的 " + root + "）"
			default:
				disk = "沿用已挂载的 " + root
			}
		}
		fmt.Fprintf(&b, "|%s%s|%s|%s|%s|\n", h.Name, map[bool]string{true: "（控制节点）", false: ""}[h.Name == p.Controller], h.IP, disk, strings.Join(roles[h.Name], "；"))
	}
	b.WriteString("\n### 组件实例\n\n|实例|组件|版本|放置|说明|\n|---|---|---|---|---|\n")
	for _, inst := range p.Instances {
		place := "客户自行运维"
		if !inst.External {
			var parts []string
			for _, r := range inst.R.Roles {
				if hs := inst.Roles[r.Name]; len(hs) > 0 {
					parts = append(parts, fmt.Sprintf("%s：%s", firstNonEmpty(r.Title, r.Name), hostList(hs)))
				}
			}
			place = strings.Join(parts, "；")
		}
		note := ""
		if scheme := inst.SchemeSummary(); scheme != nil {
			note = "部署方案：" + scheme.Name + "；" + scheme.Topology + "；" + scheme.Contract.Mechanism
		}
		if inst.Auto {
			note += " 由依赖自动加入：" + inst.AutoReason
		}
		fmt.Fprintf(&b, "|%s|%s|%s（%s）|%s|%s|\n", inst.ID, inst.Title, inst.Version, statusLabel(inst.R.Version.Status), place, note)
	}
	b.WriteString("\n")
	var warns []string
	for _, i := range p.Issues {
		if i.Severity == "warning" {
			warns = append(warns, i.Message)
		}
	}
	used := map[string]bool{}
	for _, h := range p.managedHosts() {
		used[h] = true
	}
	for _, h := range p.Hosts {
		if !used[h.Name] {
			warns = append(warns, fmt.Sprintf("机器 %s 没有承担任何组件，仍会参与免密配置", h.Name))
		}
	}
	if len(warns) > 0 {
		b.WriteString("### 需要注意\n\n")
		for _, w := range warns {
			fmt.Fprintf(&b, "- %s\n", w)
		}
		b.WriteString("\n")
	}
	return b.String()
}

// PrepareSteps are the manual steps before Ansible can run: upload, unpack, and the SSH trust handshake. The
// handbook and the structured runbook are both built from this list.
func PrepareSteps(p *Plan, opt RenderOptions) []*PlanStep {
	var out []*PlanStep
	add := func(s PlanStep) {
		s.Section = "prepare"
		if s.Effect == "" {
			s.Effect = "change"
		}
		out = append(out, &s)
	}
	add(PlanStep{ID: "verify-upload", Title: "核对控制节点上的上传文件", Desc: "把各机器的上传包与控制节点的离线材料通过堡垒机上传到 " + opt.UploadDir + "，然后在控制节点核对哈希。", Effect: "read-only", Hosts: []string{p.Controller},
		Command: "cd " + opt.UploadDir + "\nsha256sum --check --ignore-missing SHA256SUMS", Expect: "每个文件都显示 OK。"})
	for i, h := range p.DeliveryHosts() {
		name := PackageName(i, p.ProjectName(), h.IP)
		base := "/root"
		if h.Name == p.Controller {
			base = p.PackageBase()
		}
		kit := base + "/mw-setup"
		guard := "[[ -e " + kit
		if h.Name == p.Controller {
			guard += " || -e " + p.RuntimeRoot()
		}
		guard += " ]]"
		prepare := "bash setup-root-ssh-trust.sh prepare " + h.Name
		desc := "上传包 " + name + " 及同名 .sha256；已有部署目录时命令会停止，不覆盖旧环境。"
		if p.Dep.ExecutionHost != nil && h.Name == p.Controller {
			prepare = "test \"$(hostname)\" = " + h.Name + " && hostname -I | tr ' ' '\\n' | grep -Fx " + h.IP
			desc += "独立管理机只核对现有主机名和 IP，不修改主机名或系统 hosts。"
		}
		add(PlanStep{ID: "unpack-" + h.Name, Title: "解包并准备 " + h.Name, Desc: desc, Hosts: []string{h.Name},
			Command: fmt.Sprintf("cd %s\nif %s; then\n  echo '已有部署目录，停止；请核对旧环境，不覆盖。'\nelse\n  mkdir -p %s && sha256sum -c %s.sha256 && tar -xzf %s -C %s && cd %s && %s\nfi", opt.UploadDir, guard, base, name, name, base, kit, prepare)})
	}
	if len(p.DeliveryHosts()) > 1 {
		add(PlanStep{ID: "ssh-source", Title: "生成控制节点的公钥", Desc: "只输出控制节点 root 用户的公钥，用于后面的免密登录；不交换私钥。", Hosts: []string{p.Controller}, Command: "cd " + p.PackageBase() + "/mw-setup\nbash setup-root-ssh-trust.sh source"})
		for _, h := range p.Hosts {
			if h.Name == p.Controller {
				continue
			}
			add(PlanStep{ID: "ssh-target-" + h.Name, Title: "在 " + h.Name + " 接受公钥并取回主机公钥", Desc: "按提示粘贴控制节点的公钥并核对指纹；随后复制它输出的 SSH 主机公钥。", Hosts: []string{h.Name}, Command: "cd /root/mw-setup\nbash setup-root-ssh-trust.sh target\nbash setup-root-ssh-trust.sh host-key"})
			add(PlanStep{ID: "ssh-trust-" + h.Name, Title: "在控制节点信任 " + h.Name + " 并核对", Desc: "粘贴 " + h.Name + " 刚才输出的主机公钥；check-node 须显示免密登录成功。", Hosts: []string{p.Controller}, Command: controllerTrustCommand(p, h), Expect: "check-node 显示免密登录成功。"})
		}
	}
	return out
}

func docPrepare(p *Plan, opt RenderOptions, res map[string]Artifact) string {
	var b strings.Builder
	b.WriteString("# 环境准备：上传与免密配置\n\n")
	b.WriteString(overview(p))
	b.WriteString("## 上传文件\n\n生成交付不会操作机器。先把下列文件通过堡垒机上传到各机器的 `" + opt.UploadDir + "`，再按顺序操作。\n\n|机器|上传文件|\n|---|---|\n")
	for i, h := range p.DeliveryHosts() {
		files := "`" + PackageName(i, p.ProjectName(), h.IP) + "` 及同名 `.sha256`"
		if h.Name == p.Controller {
			files += "；另有 `SHA256SUMS`、`" + strings.Join(artifactFiles(p, res, opt), "`、`") + "`"
		}
		fmt.Fprintf(&b, "|%s|%s|\n", h.Name, files)
	}
	b.WriteString("\n")
	if arts := artifactList(p, res); len(arts) > 0 || p.NeedsPackages() {
		b.WriteString("离线材料及其 SHA256（与 SHA256SUMS 相同，部署时还会再次核对）：\n\n|文件|用途|SHA256|\n|---|---|---|\n")
		if p.NeedsPackages() {
			sum := "—"
			if opt.PackageRepo != nil && opt.PackageRepo.SHA256 != "" {
				sum = opt.PackageRepo.SHA256
			}
			fmt.Fprintf(&b, "|%s|软件包仓库（%s，共 %d 个软件包版本）|`%s`|\n", opt.repoFile(p), p.Platform.Title, len(p.Requests()), sum)
		}
		for _, a := range arts {
			fmt.Fprintf(&b, "|%s|%s|`%s`|\n", a.File, a.Name, firstNonEmpty(a.SHA256, "—"))
		}
		b.WriteString("\n")
	}
	b.WriteString("所有机器都完成解包之后再开始免密配置。除标明在其他机器执行的步骤外，都在控制节点 **" + p.Controller + "** 执行。\n\n")
	for n, s := range PrepareSteps(p, opt) {
		fmt.Fprintf(&b, "## %d. %s\n\n作用于 %s。%s\n\n", n+1, s.Title, hostList(s.Hosts), s.Desc)
		b.WriteString(fence(s.Command))
		if s.Expect != "" {
			b.WriteString("通过标准：" + s.Expect + "\n\n")
		}
	}
	if len(p.DeliveryHosts()) == 1 {
		b.WriteString("只有一台机器，不需要配置免密登录。\n\n")
	}
	return b.String()
}

func artifactList(p *Plan, res map[string]Artifact) []Artifact {
	var out []Artifact
	for _, a := range p.Artifacts() {
		if r, ok := res[a.Name]; ok {
			a = r
		}
		out = append(out, a)
	}
	return out
}

func artifactFiles(p *Plan, res map[string]Artifact, opt RenderOptions) []string {
	var out []string
	if p.NeedsPackages() {
		out = append(out, opt.repoFile(p))
	}
	for _, a := range artifactList(p, res) {
		out = append(out, a.File)
	}
	if len(out) == 0 {
		return []string{"（无离线材料）"}
	}
	return out
}

func stepBlock(b *strings.Builder, n int, s *PlanStep, showCommand bool) {
	title := s.Title
	if s.Instance != "" {
		title = "[" + s.Instance + "] " + s.Title
	}
	fmt.Fprintf(b, "**%d. %s**　`%s` · 作用于 %s\n\n", n, title, effectLabel[s.Effect], hostList(s.Hosts))
	if s.Desc != "" {
		b.WriteString(s.Desc + "\n\n")
	}
	if s.Expect != "" {
		b.WriteString("通过标准：" + s.Expect + "\n\n")
	}
	if s.Effect != "read-only" {
		b.WriteString("出了问题怎么退回：" + firstNonEmpty(s.Rollback, "组件没有声明。先停下，保留现场和输出，联系平台维护人员，不要自行尝试撤销。") + "\n\n")
	}
}

func docDeploy(p *Plan, st *Steps, opt RenderOptions) string {
	var b strings.Builder
	b.WriteString("# 部署步骤（控制节点 " + p.Controller + "，root）\n\n")
	b.WriteString("全部在控制节点的 root 终端完成，需先完成免密配置。**每一步的 Ansible 输出末尾必须是 `failed=0`、`unreachable=0` 才继续下一步**；失败或中断时保留日志，不要删锁、不要删数据目录、不要重建集群，先把现象和日志发给平台维护人员。\n\n")
	n := 1
	fmt.Fprintf(&b, "## %d. 离线安装 Ansible 并核对清单\n\n引导脚本只使用随包的离线材料，不访问外网。\n\n", n)
	b.WriteString(fence("cd " + p.RuntimeRoot() + "\nbash bootstrap/bootstrap-ansible.sh\ncd " + opt.ProjectDir + "\n" + inventoryCmd(opt)))
	b.WriteString("清单应列出全部机器和各实例的分组；缺少机器说明材料与上传包不一致，先停下核对。\n\n")
	for _, ph := range st.Phases {
		n++
		fmt.Fprintf(&b, "## %d. 阶段：%s\n\n", n, ph.Title)
		b.WriteString(phaseIntro(ph.Phase))
		for i, s := range ph.Steps {
			stepBlock(&b, i+1, s, false)
		}
		b.WriteString(fence("cd " + opt.ProjectDir + "\n" + ph.Command))
	}
	b.WriteString("## 补充说明\n\n")
	b.WriteString("- 只重跑某个实例：在命令末尾加 `--tags <实例名>`，例如 `--tags " + firstInstance(p) + "`。\n")
	b.WriteString("- 密码只保存在控制节点的 `" + opt.ProjectDir + "/secrets/`，不进入手册和日志；不要手工改动。\n")
	b.WriteString("- 每次执行 Ansible（部署、测试、清理）都会在项目的 `logs/` 目录留一份完整日志，文件名带执行时间，例如 `20261027-133309-11-pg-failover.log`：每个任务、每台机器的结果和输出都在里面，隐藏了密码的任务只记“已隐藏”。屏幕输出结束时会显示这份日志的路径；出问题时把对应的日志发给平台维护人员。日志只有 root 能读。\n")
	b.WriteString("- 切换类测试还会在日志里记下切换前后的 `patronictl list`（角色、状态、时间线、延迟）和选主耗时，作为切换确实发生的证据；Patroni 自己的详细过程在各节点 `journalctl -u patroni`。\n")
	b.WriteString("- 首次写入后会记录关键配置（例如初始集群成员）；规格改变后再次执行会停止，而不是悄悄改动已有集群。\n")
	return b.String()
}

func firstInstance(p *Plan) string {
	for _, i := range p.Instances {
		if !i.External {
			return i.ID
		}
	}
	return "实例名"
}

func inventoryCmd(opt RenderOptions) string {
	if opt.InventoryCmd != "" {
		return opt.InventoryCmd
	}
	return "../../bin/ansible-inventory -i inventory/hosts.yml --graph"
}

func phaseIntro(phase string) string {
	switch phase {
	case "preflight":
		return "只读检查。这是最便宜的一次试跑，先过这一关再动磁盘和软件。\n\n"
	case "install":
		return "耗时最长，输出会持续滚动。中断后先确认远端任务已结束，再重跑本阶段。\n\n"
	case "configure":
		return "写入配置，不启动服务。\n\n"
	case "start":
		return "按依赖顺序启动并确认健康；被依赖的组件先完成整个阶段。启动期间连接可能短暂中断。\n\n"
	case "verify":
		return "只读复核，不改动数据。\n\n"
	}
	return ""
}

func testList(b *strings.Builder, steps []*PlanStep, dir string) {
	n := 0
	var skipped []string
	for _, s := range steps {
		if s.Skipped != "" {
			skipped = append(skipped, fmt.Sprintf("%s/%s（%s）", s.Instance, s.ID, s.Skipped))
			continue
		}
		n++
		fmt.Fprintf(b, "## %d. [%s] %s\n\n", n, s.Instance, s.Title)
		fmt.Fprintf(b, "`%s` · 作用于 %s\n\n", effectLabel[s.Effect], hostList(s.Hosts))
		if s.Desc != "" {
			b.WriteString(s.Desc + "\n\n")
		}
		b.WriteString(fence("cd " + dir + "\n" + s.Command))
		if s.Expect != "" {
			b.WriteString("通过标准：" + s.Expect + "\n\n")
		}
	}
	if len(skipped) > 0 {
		b.WriteString("本次配置不适用、已跳过：" + strings.Join(skipped, "、") + "。\n\n")
	}
}

func docTests(p *Plan, st *Steps, opt RenderOptions) string {
	var b strings.Builder
	b.WriteString("# 功能测试（逐项执行）\n\n")
	b.WriteString("部署阶段全部通过后，按顺序一项一项执行；每项必须 `failed=0` 才继续。标为“会中断服务”的项目会让连接短暂中断，应在应用接入前的测试窗口执行；所有会修改数据的项目都要求在命令末尾带上 `-e confirm_cluster=" + p.Dep.ID + "`。\n\n")
	if len(st.Tests) == 0 {
		b.WriteString("所选组件没有提供功能测试。\n")
		return b.String()
	}
	testList(&b, st.Tests, opt.ProjectDir)
	return b.String()
}

// EndpointHealth says in words how a balancer decides a backend of the endpoint may take connections.
func EndpointHealth(ep EndpointFacts) string { return healthText(ep.Health, healthPort(ep)) }

func healthText(h Health, port int) string {
	switch h.Type {
	case "http":
		return fmt.Sprintf("HTTP 检查，端口 %d，路径 %s，仅返回 %d 视为健康", port, h.Path, h.Status)
	case "tcp-script":
		return fmt.Sprintf("TCP 脚本检查：发送 %q，期望收到 %q", h.Send, h.Expect)
	}
	return "TCP 连接检查"
}

func docEndpoint(p *Plan, st *Steps, opt RenderOptions) string {
	type front struct {
		inst *Instance
		ep   string
		f    FrontFacts
	}
	var fronts []front
	for _, i := range p.Instances {
		var names []string
		for k := range i.Fronts {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			fronts = append(fronts, front{i, k, i.Fronts[k]})
		}
	}
	if len(fronts) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("# 入口测试\n\n")
	for _, fr := range fronts {
		lb := p.Instance(fr.f.Balancer)
		var ep EndpointFacts
		for _, e := range fr.inst.Endpoints {
			if e.Name == fr.ep {
				ep = e
			}
		}
		fmt.Fprintf(&b, "## 入口 %s.%s → %s:%d\n\n", fr.inst.ID, fr.ep, fr.f.Address, fr.f.Listen)
		if fr.f.External {
			fmt.Fprintf(&b, "由 **%s**（客户运维）提供。本平台不调用云平台创建监听：请先按下表配置，再执行入口测试。\n\n|配置项|值|\n|---|---|\n|前端|%s:%d，%s|\n", firstNonEmpty(fmt.Sprint(lb.Params["vendor"]), "外部负载均衡"), fr.f.Address, fr.f.Listen, strings.ToUpper(ep.Protocol)+" 透传")
			if m, _ := lb.Params["mode"].(string); m == "domain" {
				fmt.Fprintf(&b, "|应用域名|%s（应解析到负载均衡的 IP）|\n", fr.f.Address)
			}
			fmt.Fprintf(&b, "|健康检查|%s|\n", healthText(ep.Health, healthPort(ep)))
			for _, be := range ep.Backends {
				fmt.Fprintf(&b, "|后端|%s (%s):%d|\n", be.Host, be.IP, be.Port)
			}
			b.WriteString("\n" + firstNonEmpty(ep.Note, "") + "\n\n放通：应用到负载均衡的前端端口；负载均衡到各后端的服务端口与健康检查端口。\n\n")
		} else {
			fmt.Fprintf(&b, "由本次部署的实例 **%s**（%s %s）提供，监听 %d，后端与健康检查已写入它的配置：%s。\n\n", lb.ID, lb.Title, lb.Version, fr.f.Listen, healthText(ep.Health, healthPort(ep)))
		}
	}
	if len(st.Endpoint) > 0 {
		b.WriteString("---\n\n")
		testList(&b, st.Endpoint, opt.ProjectDir)
	}
	return b.String()
}

func docCleanup(p *Plan, st *Steps, opt RenderOptions) string {
	var b strings.Builder
	b.WriteString("# 测试清理\n\n")
	b.WriteString("只处理本集群的测试资源，逐项执行，失败就停下，不要手工删除生产目录。先盘点，再清理；全部测试做完后再开始。运行中的生产数据目录和密钥不在清理范围内。\n\n")
	testList(&b, st.Cleanup, opt.ProjectDir)
	return b.String()
}

func healthPort(ep EndpointFacts) int {
	if v, ok := ep.Health.Port.(int); ok {
		return v
	}
	return ep.Port
}

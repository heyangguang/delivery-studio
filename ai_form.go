package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"middleware-deployer/mwpack"
)

// The form conversation: on the new-delivery page a person describes the cluster in their own words and talks it
// through with the assistant. The assistant looks up what the components accept, writes the whole specification into
// the form (the page shows it being filled in), asks when something is unclear, and the person confirms once at the
// end. The form is only a draft: nothing is generated until the person does it there. How to fill a form well is the
// built-in skill "deployment-form", so an administrator can adapt it to local conventions; what the components accept
// comes from the catalogue through tools, so new components work without touching the assistant.

const formSkill = "deployment-form"

// formState is what the page sends with every message: the form as it is now and the systems it may use.
type formState struct {
	AllowSwitch bool               `json:"allow_switch,omitempty"`
	Deployment  *mwpack.Deployment `json:"deployment"`
	Platforms   []string           `json:"platforms"`
}

// formFill is what one answer wrote into the form, kept with the message so the conversation can say so later.
type formFill struct {
	TargetComponent string             `json:"target_component,omitempty"`
	Summary         string             `json:"summary,omitempty"`
	Deployment      *mwpack.Deployment `json:"deployment"`
	Blocking        int                `json:"blocking"`
}

// componentBrief describes a component version for the assistant: everything a specification may say about it.
func componentBrief(cat *mwpack.Catalog, name, version string) (string, *mwpack.Schema, error) {
	c, ok := cat.Get(name)
	if !ok {
		return "", nil, fmt.Errorf("没有这个组件：%s", name)
	}
	sc, err := c.Describe(version)
	if err != nil {
		return "", nil, err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "组件 %s（%s），版本 %s", c.Name, c.Title, sc.Version)
	var versions []string
	for _, v := range c.Versions {
		versions = append(versions, v.ID)
	}
	fmt.Fprintf(&b, "，可选版本 %s\n支持的系统：%s\n", strings.Join(versions, "、"), strings.Join(sc.Platforms, "、"))
	if c.Summary != "" {
		b.WriteString(c.Summary + "\n")
	}
	if c.Context != "" {
		fmt.Fprintf(&b, "这是管理组件，由父组件方案自动创建；管理能力 %s，不能单独部署或改节点。\n", c.Context)
	}
	if len(c.Companions) > 0 {
		b.WriteString("这个组件提供独立的管理方案；新建时必须显式选择常用规格里的方案参数，不能用历史兼容默认值推断架构。\n")
		for _, manager := range c.Companions {
			fmt.Fprintf(&b, "- 条件 %s 自动引入 %s；管理器自己的依赖按条件计算。\n", manager.When, manager.Component)
		}
	}
	if sc.Kind == "external" {
		b.WriteString("这是客户自己运维的外部组件：平台不部署它、没有机器，instances 里不要写 placement；交付里只给出它的配置清单。\n")
	}
	if len(sc.Roles) > 0 {
		b.WriteString("角色（placement 的键，值是机器名列表）：\n")
		for _, r := range sc.Roles {
			max := "不限"
			if r.Max > 0 {
				max = fmt.Sprint(r.Max)
			}
			fmt.Fprintf(&b, "- %s（%s）：至少 %d 台，最多 %s，默认 %d 台", r.Name, r.Title, r.Min, max, r.Default)
			if r.Odd {
				b.WriteString("，建议奇数")
			}
			if r.Exclusive {
				b.WriteString("，不能与同一实例的其他角色同机")
			}
			b.WriteString("\n")
		}
	}
	groups := map[string]string{}
	for _, g := range sc.Groups {
		groups[g.ID] = g.Label
	}
	b.WriteString("参数（params 的键；没提到的不要写，用默认值）：\n")
	for _, p := range sc.Params {
		if p.Locked {
			continue
		}
		fmt.Fprintf(&b, "- %s（%s", p.Key, p.Label)
		if g := groups[p.Group]; g != "" {
			b.WriteString("，" + g)
		}
		fmt.Fprintf(&b, "）类型 %s", p.Type)
		if p.Default != nil {
			fmt.Fprintf(&b, "，默认 %v", p.Default)
		}
		if p.Min != nil || p.Max != nil {
			fmt.Fprintf(&b, "，范围 %v～%v", p.Min, p.Max)
		}
		if p.Unit != "" {
			fmt.Fprintf(&b, " %s", p.Unit)
		}
		if len(p.Options) > 0 {
			fmt.Fprintf(&b, "，可选 %s", strings.Join(p.Options, "/"))
		}
		if p.Required {
			b.WriteString("，必填")
		}
		if p.When != "" {
			fmt.Fprintf(&b, "，仅当 %s 时有效", p.When)
		}
		if p.Hint != "" {
			fmt.Fprintf(&b, "。%s", p.Hint)
		}
		b.WriteString("\n")
	}
	if len(sc.Endpoints) > 0 {
		b.WriteString("端点（入口用 binds 代理它，写成 实例名.端点名）：\n")
		seen := map[string]bool{}
		for _, e := range sc.Endpoints {
			if seen[e.Name] {
				continue
			}
			seen[e.Name] = true
			lb := map[string]string{"allowed": "可以接负载均衡", "discouraged": "不建议接负载均衡", "none": "不能接负载均衡"}[e.LB]
			fmt.Fprintf(&b, "- %s（%s），端口 %v，%s", e.Name, firstNonEmptyStr(e.Title, e.Name), e.Port, firstNonEmptyStr(lb, "可以接负载均衡"))
			if e.Note != "" {
				b.WriteString("。" + e.Note)
			}
			b.WriteString("\n")
		}
	}
	if sc.LB != nil || containsStr(sc.Provides, "l4-lb") {
		b.WriteString("这是一个负载均衡（入口）组件：在它的实例上写 binds: [{\"endpoint\": \"<被代理的实例名>.<端点名>\", \"listen\": <入口对外端口>}]。\n")
	}
	if len(sc.Presets) > 0 {
		b.WriteString("常用规格：\n")
		for _, p := range sc.Presets {
			var rs []string
			for _, r := range p.Roles {
				rs = append(rs, fmt.Sprintf("%s×%d", r.Role, r.Count))
			}
			var ps []string
			for k, v := range p.Params {
				ps = append(ps, fmt.Sprintf("%s=%v", k, v))
			}
			sort.Strings(ps)
			fmt.Fprintf(&b, "- %s：%s", p.Name, strings.Join(rs, "，"))
			if p.Contract != nil {
				contract, _ := json.Marshal(p.Contract)
				fmt.Fprintf(&b, "；平台系列契约：%s", contract)
			}
			if len(ps) > 0 {
				fmt.Fprintf(&b, "；%s", strings.Join(ps, "，"))
			}
			b.WriteString("\n")
		}
	}
	if len(sc.Requires) > 0 {
		b.WriteString("依赖（平台会自动补上对应组件，不要自己加实例）：")
		for _, r := range sc.Requires {
			fmt.Fprintf(&b, " %s", firstNonEmptyStr(r.Title, r.Capability))
			if r.When != "" {
				fmt.Fprintf(&b, "（当 %s）", r.When)
			}
		}
		b.WriteString("\n")
	}
	if sc.Addons != nil && len(sc.Addons.Items) > 0 {
		b.WriteString("可选的扩展/附加项（写在实例的 addons 里：{id, databases}；不写 databases 就装进默认的 " + strings.Join(sc.Addons.Scope.Defaults, "、") + "，以后新建的数据库也会带上）：")
		for _, it := range sc.Addons.Items {
			fmt.Fprintf(&b, " %s（%s）", it.ID, firstNonEmptyStr(it.Title, it.ID))
		}
		b.WriteString("\n用户点名要、但不在这个清单里的扩展，说明组件还没提供：如实告诉他，并建议到组件工作台里让组件助手添加；不要说成“没有扩展配置项”。\n")
	}
	if len(sc.Inputs) > 0 {
		b.WriteString("需要用户提供的文件（用户可以直接把文件发给你，你用 inspect_files 看、place_certificate 放进表单；还没给就主动问他要）：")
		for _, in := range sc.Inputs {
			fmt.Fprintf(&b, " %s", in.Label)
			if in.When != "" {
				fmt.Fprintf(&b, "（当 %s）", in.When)
			}
		}
		b.WriteString("\n")
	}
	if c.Detail != nil && len(c.Detail.Limits) > 0 {
		b.WriteString("限制：\n")
		for _, l := range c.Detail.Limits {
			b.WriteString("- " + l + "\n")
		}
	}
	return b.String(), sc, nil
}

// fillContext is the description of an application for the assistants that turn words into a specification.
func fillContext(cat *mwpack.Catalog, app string) (string, []string, error) {
	text, sc, err := componentBrief(cat, app, "")
	if err != nil {
		return "", nil, fmt.Errorf("没有这个应用")
	}
	return text, sc.Platforms, nil
}

// extractJSON cuts the outermost JSON object out of a model's answer, which may have words around it.
func extractJSON(text string) string {
	a, b := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if a < 0 || b < a {
		return ""
	}
	return text[a : b+1]
}

func containsStr(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func formTools() []aiToolDef {
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	obj := func(props map[string]any, req ...string) map[string]any {
		return map[string]any{"type": "object", "properties": props, "required": req}
	}
	return []aiToolDef{
		{"read_form", "读取新建交付表单现在的内容（部署规格 JSON），以及可用的系统。填表前先读，用户没提到的部分保持不变。", obj(map[string]any{})},
		{"list_components", "列出平台里可以部署的组件：名称、用途、版本，以及哪些是负载均衡（入口）。", obj(map[string]any{})},
		{"describe_component", "读取一个组件（某个版本）能写什么：角色、参数（键、含义、默认值、范围）、端点、常用规格、依赖和限制。写规格前必须先读。", obj(map[string]any{"name": str("组件名，例如 postgresql、external-lb"), "version": str("版本，可省略（默认版本）")}, "name")},
		{"switch_form", "用户明确要求改用另一个中间件时，校验目标部署规格并切换创建页面，保留当前对话。先查目标组件；仅适用于全新集群。目标规格只沿用用户已给出的机器、环境等通用需求，不复制源组件专有参数。调用成功后停止填表工具。", obj(map[string]any{
			"target_component": str("目标组件ID，例如redis"),
			"deployment":       map[string]any{"type": "object", "description": "目标组件的完整部署规格，与fill_form相同"},
			"summary":          str("切换及沿用需求的简短说明"),
		}, "target_component", "deployment")},
		{"fill_form", "把一份完整的部署规格写进表单，用户能看到表单被填上。平台会先校验：不通过时不会写入，并返回要修正的问题。", obj(map[string]any{
			"deployment": map[string]any{"type": "object", "description": "完整的部署规格：{id, title, platform, delivery_mode(offline、automatic或configuration), controller(集群内执行机) 或 execution_host:{name,ip,repository_port}(独立执行机，不可放入业务hosts), hosts:[{name,ip,disk,initialize,params}], instances:[{id,component,version,placement,params,binds,addons}]}。不是只写改动。"},
			"summary":    str("一句话说明这次填了什么，例如：3 台机器、一主两从，并加上云 ELB 入口"),
		}, "deployment")},
	}
}

type formCtx struct {
	messages []aiMsg
	s        *storeServer
	user     string
	files    []fileNode // what the person attached to this message
	hist     []fileRef  // everything attached earlier in this conversation, so nothing has to be sent twice
	app      string
	state    *formState
	ev       sse
	// filled is what the last successful fill_form wrote, kept with the answer
	filled *formFill
}

func (c *formCtx) run(name, args string) string {
	var a map[string]json.RawMessage
	_ = json.Unmarshal([]byte(args), &a)
	str := func(k string) string {
		var v string
		_ = json.Unmarshal(a[k], &v)
		return v
	}
	cat := c.s.plat.cat()
	switch name {
	case "read_form":
		if c.state == nil || c.state.Deployment == nil {
			return "现在不在新建交付页面，读不到表单。请告诉用户回到「新建交付」页面继续这段对话。"
		}
		d := *c.state.Deployment
		b, _ := json.Marshal(d)
		out := "表单当前内容：\n" + aiScrub(string(b))
		if len(c.state.Platforms) > 0 {
			out += "\n可用的系统 id：" + strings.Join(c.state.Platforms, "、")
		}
		contract, e := cat.HostContract()
		if e == nil {
			b, _ := json.Marshal(contract)
			out += "\n公共机器参数与联动规则（写入hosts[].params）：" + string(b)
		}
		return out + "\n要部署的组件：" + c.app
	case "inspect_files":
		var refs []string
		_ = json.Unmarshal(a["files"], &refs)
		return c.inspectFiles(refs)
	case "place_certificate":
		return c.placeCertificate(a)
	case "list_components":
		var b strings.Builder
		for _, n := range cat.Names() {
			comp, _ := cat.Get(n)
			var vs []string
			for _, v := range comp.Versions {
				vs = append(vs, v.ID)
			}
			role := ""
			if containsStr(comp.Provides, "l4-lb") {
				role = "，负载均衡（入口）"
			}
			if comp.Kind == "external" {
				role += "，客户自己运维的外部组件"
			}
			fmt.Fprintf(&b, "- %s（%s，%s%s）版本 %s：%s\n", n, comp.Title, comp.Category, role, strings.Join(vs, "、"), comp.Summary)
		}
		return b.String()
	case "describe_component":
		text, _, err := componentBrief(cat, str("name"), str("version"))
		if err != nil {
			return err.Error() + "。可以先用 list_components 查看有哪些组件。"
		}
		return text
	case "fill_form", "switch_form":
		if c.filled != nil && c.filled.TargetComponent != "" {
			return "切换配置已准备好，请结束本轮，等待目标页面完成切换后继续。"
		}
		target := c.app
		if name == "switch_form" {
			if c.state == nil || !c.state.AllowSwitch {
				return "当前流程不允许切换组件。已有交付的复制、变更或修订必须保留原应用。"
			}
			target = str("target_component")
			comp, ok := cat.Get(target)
			if !ok || comp.Kind == "external" || comp.Context != "" {
				return "目标不是可独立部署的组件，请先查询组件目录。"
			}
			if target == c.app {
				return "已经是这个组件，请使用fill_form。"
			}
		}
		if c.state == nil || c.state.Deployment == nil {
			return "现在不在新建交付页面，无法填写表单。把你的建议用文字告诉用户，并请他回到「新建交付」页面继续这段对话。"
		}
		raw := a["deployment"]
		if len(raw) == 0 {
			return "没有收到部署规格。fill_form 需要 deployment：一份完整的部署规格。"
		}
		d, err := mwpack.ParseDeployment(raw)
		if err != nil {
			return "规格写法不对，没有填入表单：" + err.Error() + "。只用 describe_component 列出的字段。"
		}

		for _, instance := range d.Instances {
			if instance.Component != "postgresql" {
				continue
			}
			mode, _ := instance.Params["deployment_mode"].(string)
			if mode == "replication" || mode == "patroni" || len(instance.Placement["replica"]) > 0 {
				choice := pgArchitectureChoice(c.messages)
				if choice == "" {
					return "PostgreSQL 主从架构尚未由用户确认，未写入表单。必须调用 ask_user，提供「原生主从方案」（人工切换）和「Patroni 主从方案」（自动切换、平台部署etcd）两张选项卡片。不能根据主从数量或高可用一词擅自选择。"
				}
				if mode != choice {
					return "拟填写的 PostgreSQL 方案与用户确认的架构不一致，未写入表单。请按用户选择填写 deployment_mode；改方案必须先确认。"
				}
			}
		}
		d.Schema = mwpack.DeploymentSchema
		if d.Platform == "" {
			d.Platform = c.state.Deployment.Platform
		}
		var found bool
		for _, in := range d.Instances {
			if in.Component == target {
				found = true
			}
		}
		if name == "switch_form" && (len(d.Instances) == 0 || d.Instances[0].Component != target) {
			return "目标组件必须是部署规格的第一个实例，没有切换。"
		}
		if !found {
			return "规格里没有要部署的组件 " + target + "，没有填入表单。"
		}
		if strings.TrimSpace(d.ID) != "" {
			c.s.mu.Lock()
			why := c.s.clusterTaken(d.ID)
			c.s.mu.Unlock()
			if why != "" {
				return why + "。没有填入表单。请换一个没被用过的集群标识（小写字母、数字、短横线），再调用 fill_form，并把这个情况告诉用户。"
			}
		}
		plan := mwpack.Solve(cat, d)
		// what is still for the person to supply is not an objection: a missing address or a certificate to upload
		var blocking, rest []string
		for _, p := range plan.Errors() {
			if strings.Contains(p.Path, ".ip") || strings.Contains(p.Message, "IP") || strings.Contains(p.Message, "证书") {
				rest = append(rest, p.Message)
				continue
			}
			blocking = append(blocking, p.Message)
		}
		if len(blocking) > 0 {
			return "平台校验没有通过，这份规格没有填入表单。请修正后再调用 fill_form：\n- " + strings.Join(blocking, "\n- ")
		}
		summary := truncRunes(strings.TrimSpace(str("summary")), 120)
		c.filled = &formFill{Summary: summary, Deployment: d, Blocking: len(rest)}
		if name == "switch_form" {
			c.filled.TargetComponent = target
			c.app = target
		}
		c.state.Deployment = d
		c.ev.send(map[string]any{"t": "form", "v": c.filled})
		var warn []string
		for _, p := range plan.Issues {
			if p.Severity == "warning" && !strings.Contains(p.Message, "尚未在空环境验证") {
				warn = append(warn, p.Message)
			}
		}
		out := "已填入表单，用户正在看着它被填上。"
		if len(rest) > 0 {
			out += "\n还需要用户补充（在回复里告诉他）：\n- " + strings.Join(rest, "\n- ")
		}
		if len(warn) > 0 {
			out += "\n平台的提醒（重要的转告用户）：\n- " + strings.Join(warn, "\n- ")
		}
		return out
	}
	return "没有这个工具：" + name
}

const formSystem = `你是 Middleware Hub（离线中间件交付平台）的填表助手，在「新建交付」页面和用户对话，帮他把部署表单填好。
- PostgreSQL 主从架构必须由用户明确选择。只说主从、一主一从、一主多从、高可用时，必须先用 ask_user 卡片询问「原生主从方案」或「Patroni 主从方案」，不能默认选择任何一个。明确选择后才调用 fill_form；历史默认值、机器数量和AI填入值不算用户确认。原生方案人工切换，Patroni方案自动切换并由平台部署etcd。
- 用工具查实际内容：read_form 读表单，list_components、describe_component 查组件能写什么，fill_form 写入表单。不要凭记忆编造组件的角色、参数或端口。公共机器参数由read_form返回，写入hosts[].params，按联动规则清理冲突磁盘字段。
- 用户进入错误组件页面时，不要反复拒绝或声称只能手工返回。用户明确要求Redis等其他组件，就读取目标组件定义，用switch_form切换并沿用IP、环境和节点需求；意图不明确才提问。切换成功后结束本轮，页面会保留对话并进入目标组件。
- 你只改表单这份草稿；生成交付要用户自己在表单里确认。每次填完，页面会请用户确认一次你的全部改动。
- 用户可以上传任何文件：证书、p7b 证书包、私钥、报错截图、配置。先用 inspect_files 看清里面是什么，再动手：该转换的转换（p7b 拆成 PEM），该拆开的拆开（一个文件里的服务器证书、中间证书、根 CA 分别放进各自的位置），用 place_certificate 放进表单。用户不需要懂格式，也不必按平台的要求准备——你来替他整理。放完看平台核对的结果，缺什么（根 CA、匹配的私钥、覆盖域名的证书）如实告诉他，并说明怎么拿到；不要为了通过而绕过平台的规则。
- 用户发来压缩包（tar.gz、zip）也直接 inspect_files，平台会替你解开，里面每个文件都能看、能放；不要让用户先在本地解压再传。用户之前发过的文件还在，不用他再传一遍。
- 要主动，不要等用户把话说全：组件需要证书（TLS、云 ELB 域名入口）而用户还没给，就在第一次回复里问他要，并说明可以直接把证书、私钥、压缩包发过来；只要有不确定、不妥或和现有集群冲突的地方（集群标识被占用、网段不清楚、证书不覆盖域名、版本有已知问题），用提问卡片把选项摆给用户选，也允许他自己写，不要自己悄悄定。
- 默认值能定的就直接定并告诉用户，不要什么都问：只问会影响结果、你又无法从已有信息判断的事。
- 私钥内容不会给你看，也不要索取；密码不要写进规格。
- 回答用中文，简短，用表单上的中文名称说话，不要贴 JSON。
- 思考和推理摘要也用中文，和回答保持一致。`

// formPrompt is the system prompt of a form conversation: the rules, then the skill that says how to fill a form.
func (s *storeServer) formPrompt(user, app string) string {
	p := formSystem + "\n\n本次要部署的组件：" + app + "。"
	if sk, ok := s.skillFor(user, formSkill); ok && sk.Enabled {
		p += "\n\n# 技能：" + sk.Title + "\n\n" + sk.Content
	}
	return p
}

package mwpack

import (
	"fmt"
	"strings"
)

// SeriesContract describes capabilities, not vendor-specific product names.
// Absent contracts remain readable for old delivered components; publication
// requires a contract for every advertised preset.
type SeriesContract struct {
	When        string   `yaml:"when" json:"when"`
	Series      string   `yaml:"series" json:"series"`
	Failover    string   `yaml:"failover" json:"failover"`
	Mechanism   string   `yaml:"mechanism" json:"mechanism"`
	ReadAccess  string   `yaml:"read_access" json:"read_access"`
	Sharding    bool     `yaml:"sharding" json:"sharding"`
	Limitations []string `yaml:"limitations" json:"limitations"`
	Acceptance  []string `yaml:"acceptance" json:"acceptance"`
	Operations  []string `yaml:"operations" json:"operations"`
}

func SeriesTitle(series string) string {
	return map[string]string{"basic": "基础系列", "replication": "主从系列", "ha": "高可用系列", "sharded": "分片集群系列"}[series]
}

// PresetTitle names PostgreSQL architectures by their actual implementation.
// IDs and capability contracts stay stable for existing deployments.
func PresetTitle(component, id, fallback string) string {
	if component == "postgresql" {
		if title := map[string]string{"single": "单机方案", "replication": "原生主从方案", "patroni": "Patroni 主从方案"}[id]; title != "" {
			return title
		}
	}
	return fallback
}

// ValidateSeries is shared by catalog validation and the non-bypassable authoring gate.
func ValidateSeries(c *Component, cat *Catalog, strict bool) []Problem {
	var out []Problem
	if c.Detail == nil || len(c.Detail.Presets) == 0 {
		if strict && c.Kind != "external" && c.Context == "" {
			out = append(out, Problem{"error", "detail.presets", "可独立部署的组件必须提供至少一个带系列契约的方案"})
		}
		return out
	}
	seen := map[string]bool{}
	for _, p := range c.Detail.Presets {
		at := "detail.presets." + p.ID
		bad := func(msg string) { out = append(out, Problem{"error", at + ".contract", msg}) }
		if p.ID == "" || seen[p.ID] {
			bad("方案 ID 必须填写且不能重复")
		}
		seen[p.ID] = true
		x := p.Contract
		if x == nil {
			severity := "warning"
			if strict {
				severity = "error"
			}
			out = append(out, Problem{severity, at + ".contract", "旧方案缺少系列契约；继续读取兼容，编辑发布前必须声明能力、限制和验收"})
			continue
		}
		if strings.TrimSpace(x.When) == "" {
			bad("必须声明 when，供界面和执行器识别当前系列")
		}
		title := SeriesTitle(x.Series)
		if title == "" {
			bad("series 只能是 basic、replication、ha、sharded")
		}
		identity := c.Name
		// Forks keep the database capability and architecture names.
		if contains(c.Provides, "postgresql-database") {
			identity = "postgresql"
		}
		preferred := PresetTitle(identity, p.ID, title)
		if title != "" && p.Name != preferred && p.Name != title && !strings.HasPrefix(p.Name, title+" · ") {
			bad("方案名称应为「" + preferred + "」或「" + title + " · 具体架构」")
		}
		if x.Failover != "none" && x.Failover != "manual" && x.Failover != "automatic" {
			bad("必须声明 failover: none/manual/automatic")
		}
		if strings.TrimSpace(x.Mechanism) == "" || strings.TrimSpace(x.ReadAccess) == "" || len(x.Limitations) == 0 {
			bad("必须说明实现机制、读取能力和限制")
		}
		nodes := 0
		for _, role := range p.Roles {
			nodes += role.Count
		}
		if x.Series == "basic" && (nodes != 1 || x.Failover != "none" || x.Sharding) {
			bad("基础系列必须为单节点、无故障切换且不分片")
		}
		if x.Series == "replication" && (nodes < 2 || x.Failover != "manual" || x.Sharding) {
			bad("主从系列必须有多个节点、人工切换且不分片")
		}
		if x.Series == "ha" && (nodes < 2 || x.Failover != "automatic" || x.Sharding) {
			bad("高可用系列必须有多个节点和自动故障切换，分片请使用分片集群系列")
		}
		if x.Series == "sharded" && (!x.Sharding || nodes < 2) {
			bad("分片集群系列必须声明分片且有多个节点")
		}
		for _, limitation := range x.Limitations {
			if strings.TrimSpace(limitation) == "" {
				bad("限制说明不能是空白")
			}
		}
		if len(x.Acceptance) == 0 {
			bad("必须引用验收测试，格式为 组件名/测试ID")
		}
		for _, ref := range x.Acceptance {
			parts := strings.Split(ref, "/")
			if len(parts) != 2 {
				bad("验收引用格式错误：" + ref)
				continue
			}
			target := c
			if parts[0] != c.Name {
				var ok bool
				if cat != nil {
					target, ok = cat.Get(parts[0])
				}
				if !ok {
					bad("验收组件不存在：" + ref)
					continue
				}
			}
			found := false
			for _, v := range target.Versions {
				r, e := target.Resolve(v.ID)
				if e != nil {
					continue
				}
				for _, test := range r.Tests {
					if test.ID == parts[1] && strings.TrimSpace(test.Expect) != "" {
						found = true
					}
				}
			}
			if !found {
				bad("验收测试不存在或缺少通过标准：" + ref)
			}
		}
		ops := map[string]bool{}
		for _, op := range x.Operations {
			if ops[op] {
				bad("操作声明重复：" + op)
			}
			ops[op] = true
			if op != "deploy" {
				bad("未知操作：" + op)
			}
		}

		// Prove each advertised preset activates its contract and operation
		// steps on every supported version, rather than merely finding an ID.
		for _, version := range c.Versions {
			resolved, err := c.Resolve(version.ID)
			if err != nil {
				continue
			}
			env := Env{Params: map[string]any{}, Roles: map[string][]string{}, Version: version.ID}
			for _, param := range resolved.Params {
				env.Params[param.Key] = param.Default
			}
			for key, value := range p.Params {
				env.Params[key] = value
			}
			for _, role := range resolved.Roles {
				env.Roles[role.Name] = []string{}
			}
			for _, role := range p.Roles {
				for n := 0; n < role.Count; n++ {
					env.Roles[role.Role] = append(env.Roles[role.Role], fmt.Sprintf("node%d", n))
				}
			}
			active, err := env.Bool(x.When)
			if err != nil || !active {
				bad("方案自身的节点和参数不满足系列 when 条件（版本 " + version.ID + "）")
			}
			matches := 0
			for _, candidate := range c.Detail.Presets {
				if candidate.Contract != nil {
					on, e := env.Bool(candidate.Contract.When)
					if e == nil && on {
						matches++
					}
				}
			}
			if matches > 1 {
				bad("预设同时匹配多个系列，请修正 when 条件")
			}
			for _, ref := range x.Acceptance {
				parts := strings.Split(ref, "/")
				if len(parts) != 2 {
					continue
				}
				testResolved := resolved
				if parts[0] != c.Name {
					linked := false
					for _, companion := range c.Companions {
						on, err := env.Bool(companion.When)
						linked = linked || (companion.Component == parts[0] && err == nil && on)
					}
					for _, require := range resolved.Requires {
						on, err := env.Bool(require.When)
						linked = linked || (require.DefaultImpl == parts[0] && err == nil && on)
					}
					if !linked {
						bad("验收引用了不参与该方案的组件：" + ref)
						continue
					}
					if cat == nil {
						continue
					}
					target, ok := cat.Get(parts[0])
					if !ok || len(target.Versions) == 0 {
						continue
					}
					var err error
					testResolved, err = target.Resolve(defaultVersion(target))
					if err != nil {
						continue
					}
				}
				testEnv := env
				if parts[0] != c.Name && testResolved.C.Context == "" {
					testEnv = Env{Params: map[string]any{}, Roles: map[string][]string{}, Version: testResolved.Version.ID}
					for _, param := range testResolved.Params {
						testEnv.Params[param.Key] = param.Default
					}
					for _, require := range resolved.Requires {
						if require.DefaultImpl == parts[0] {
							for key, val := range require.With {
								if text, ok := val.(string); ok && strings.HasPrefix(text, "=") {
									value, err := env.Eval(strings.TrimPrefix(text, "="))
									if err == nil {
										testEnv.Params[key] = value
									}
								} else {
									testEnv.Params[key] = val
								}
							}
						}
					}
					if len(testResolved.Roles) == 1 {
						for n := 0; n < nodes; n++ {
							role := testResolved.Roles[0].Name
							testEnv.Roles[role] = append(testEnv.Roles[role], fmt.Sprintf("node%d", n))
						}
					}
				}
				active := false
				for _, step := range testResolved.Tests {
					if step.ID == parts[1] {
						on, err := testEnv.Bool(step.When)
						active = err == nil && on
					}
				}
				if !active {
					bad("验收测试在当前方案中不执行：" + ref + "（版本 " + version.ID + "）")
				}
			}
		}
		if !ops["deploy"] {
			bad("必须声明 deploy 操作")
		}
	}
	return out
}

// SelectedSeries evaluates architecture conditions rather than comparing all
// preset values: tuning memory or TLS must not change the selected series.
func (i *Instance) SelectedSeries() (*SeriesContract, error) {
	if i.R.C.Detail == nil {
		return nil, nil
	}
	var selected *SeriesContract
	for _, preset := range i.R.C.Detail.Presets {
		if preset.Contract == nil {
			continue
		}
		on, err := i.Env().Bool(preset.Contract.When)
		if err != nil {
			return nil, fmt.Errorf("系列 %s 条件错误：%w", preset.ID, err)
		}
		if on {
			if selected != nil {
				return nil, fmt.Errorf("多个系列同时匹配当前配置")
			}
			selected = preset.Contract
		}
	}
	return selected, nil
}

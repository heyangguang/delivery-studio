package mwpack

import (
	"fmt"
	"reflect"
)

// expandCompanions copies the selected database's placement/configuration into
// its explicitly selected manager. A managed context is a dependency, not a
// second independently configurable copy of the database.
func (s *solver) expandCompanions(byID map[string]*Instance) {
	parents := append([]*Instance(nil), s.plan.Instances...)
	for _, parent := range parents {
		s.applyParams(parent, false)
		for _, c := range parent.R.C.Companions {
			on, err := s.env(parent).Bool(c.When)
			if err != nil {
				s.bad("instances["+parent.ID+"].companions", "%v", err)
				continue
			}
			if !on {
				continue
			}
			id := parent.ID + "-" + c.ID
			sp := InstanceSpec{ID: id, Component: c.Component, Placement: parent.Spec.Placement, Params: parent.Spec.Params, Addons: parent.Spec.Addons, Uses: map[string]string{c.Capability: parent.ID}}
			if previous := byID[id]; previous != nil {
				if previous.Component != c.Component || previous.Spec.Uses[c.Capability] != parent.ID || !reflect.DeepEqual(previous.Spec.Placement, sp.Placement) || !reflect.DeepEqual(previous.Spec.Params, sp.Params) || !reflect.DeepEqual(previous.Spec.Addons, sp.Addons) {
					s.bad("instances["+id+"]", "方案管理组件与数据库配置不一致；请从数据库方案重新生成，不能单独修改管理组件")
				}
				continue
			}
			manager := s.build(sp, true, fmt.Sprintf("%s 选择了 %s 管理方案", parent.Title, c.Component))
			if manager == nil {
				continue
			}
			// The parent's effective defaults are authoritative too. Editing a
			// database default must not leave a second, stale manager default.
			inherited := map[string]any{}
			for _, param := range manager.R.Params {
				if value, ok := parent.Params[param.Key]; ok {
					inherited[param.Key] = value
				}
			}
			manager.Spec.Params = inherited
			if manager.R.C.Context != c.Capability || len(manager.R.C.Companions) > 0 {
				s.bad("instances["+id+"]", "管理组件必须声明对应 context，且不能递归创建管理组件")
				continue
			}
			s.plan.Instances = append(s.plan.Instances, manager)
			byID[id] = manager
		}
	}
}

func (p *Plan) taskContext(inst *Instance) string {
	source := "mw_instances['" + inst.ID + "']"
	if cap := inst.R.C.Context; cap != "" {
		if u := inst.Uses[cap]; u != nil {
			// Manager packages and dependency bindings belong to the manager, while
			// database scope, certificates and secrets continue to belong to the database.
			return "{{ mw_instances['" + u.Instance + "'] }}"
		}
	}
	return "{{ " + source + " }}"
}

// validateManagedContexts prevents independent managers from claiming arbitrary
// databases or managing one database twice.
func (s *solver) validateManagedContexts() {
	seen := map[string]string{}
	for _, i := range s.plan.Instances {
		cap := i.R.C.Context
		if cap == "" {
			continue
		}
		u := i.Uses[cap]
		if u == nil {
			continue
		}
		target := s.plan.Instance(u.Instance)
		if target == nil {
			continue
		}
		if !reflect.DeepEqual(i.Params, target.Params) || !reflect.DeepEqual(i.Spec.Addons, target.Spec.Addons) {
			s.bad("instances["+i.ID+"]", "管理组件的数据库参数及扩展必须跟随被管理对象")
		}
		if !reflect.DeepEqual(i.Roles, target.Roles) {
			s.bad("instances["+i.ID+"]", "管理组件必须与数据库使用相同节点和角色")
		}
		key := target.ID + "/" + cap
		if other := seen[key]; other != "" {
			s.bad("instances["+i.ID+"]", "数据库已由 %s 管理，不能再添加第二个管理器", other)
		}
		seen[key] = i.ID
		allowed := false
		for _, c := range target.R.C.Companions {
			on, err := target.Env().Bool(c.When)
			allowed = allowed || (err == nil && on && c.Component == i.Component && c.Capability == cap)
		}
		if !allowed {
			s.bad("instances["+i.ID+"]", "目标数据库未选择这个管理方案，不能独立接管")
		}
	}
}

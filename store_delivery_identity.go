package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"middleware-deployer/mwpack"
)

// Providers execute first, but the first submitted managed instance names the delivery.
// Derived specifications explicitly include dependencies, so Auto is not an identity.
func deliveryPrimary(plan *mwpack.Plan, d *mwpack.Deployment) *mwpack.Instance {
	for _, sp := range d.Instances {
		for _, i := range plan.Instances {
			if i.ID == sp.ID && !i.External {
				return i
			}
		}
	}
	return plan.Instances[0]
}

// Read the resolved version of the named application, including for old jobs whose
// summary accidentally used a dependency's version. Never rewrite stored history.
func (s *storeServer) deliveryAppVersion(id, component, fallback string) string {
	var lock struct {
		Instances []struct{ Component, Version string }
	}
	b, err := os.ReadFile(filepath.Join(s.jobDir(id), "output", "deployment.lock.json"))
	if err == nil && json.Unmarshal(b, &lock) == nil {
		for _, i := range lock.Instances {
			if i.Component == component && i.Version != "" {
				return i.Version
			}
		}
	}
	return fallback
}

// Read only persisted delivery data. Never infer historical capabilities using
// the current catalog, and never assume the first instance is the application.
func (s *storeServer) deliveryScheme(id, component string, fallback *mwpack.SchemeSummary) *mwpack.SchemeSummary {
	if fallback != nil {
		if fallback.Contract != nil && (fallback.Contract.Limitations == nil || fallback.Contract.Acceptance == nil || fallback.Contract.Operations == nil) {
			cp := *fallback
			cc := *fallback.Contract
			if cc.Limitations == nil {
				cc.Limitations = []string{}
			}
			if cc.Acceptance == nil {
				cc.Acceptance = []string{}
			}
			if cc.Operations == nil {
				cc.Operations = []string{}
			}
			cp.Contract = &cc
			return &cp
		}
		return fallback
	}
	raw := s.jobPlan(id)
	if len(raw) == 0 {
		return nil
	}
	var plan struct {
		Instances []mwpack.InstanceView `json:"instances"`
	}
	if json.Unmarshal(raw, &plan) != nil {
		return nil
	}
	instanceID := ""
	if dep := s.readSpec(id); dep != nil {
		for _, i := range dep.Instances {
			if i.Component == component {
				instanceID = i.ID
				break
			}
		}
	}
	var matches []mwpack.InstanceView
	for _, i := range plan.Instances {
		if i.Component == component && (instanceID == "" || i.ID == instanceID) {
			matches = append(matches, i)
		}
	}
	if len(matches) != 1 {
		return nil
	}
	i := matches[0]
	if i.Scheme != nil {
		return i.Scheme
	}
	out := &mwpack.SchemeSummary{}
	if i.Contract == nil {
		out.Name = "历史部署架构"
		if i.Title != "" {
			out.Name = i.Title + " 部署架构"
		}
		out.Source = "delivery-evidence"
		out.Contract = &mwpack.SeriesContract{Mechanism: "已保存的角色配置", Limitations: []string{"依据生成时的交付材料展示，不代表已重新检查现场运行状态；原交付没有保存系列名称。"}}
		out.Evidence = []string{"交付 plan.json 的角色与节点记录"}
		if len(i.Roles["primary"]) == 1 && len(i.Roles["replica"]) > 0 && i.Title != "" {
			out.Name = i.Title + " 主从架构"
		}
		if i.Component == "postgresql" {
			patroniPort := false
			for _, port := range i.Ports {
				if port.Name == "patroni-rest" {
					patroniPort = true
				}
			}
			dcs := i.Uses["dcs"]
			linked := false
			if dcs != nil {
				for _, other := range plan.Instances {
					if other.ID == dcs.Instance && other.Component == "etcd" {
						linked = true
					}
				}
			}
			if patroniPort && linked && len(i.Roles["primary"]) == 1 && len(i.Roles["replica"]) > 0 {
				out.Name = "Patroni 高可用架构"
				out.Contract.Mechanism = "PostgreSQL + Patroni + etcd"
				out.Evidence = append(out.Evidence, "已声明 Patroni REST 端口", "dcs 关联到交付中的 etcd 实例")
			} else if len(i.Roles["primary"]) == 1 && len(i.Roles["replica"]) > 0 {
				out.Name = "PostgreSQL 主从架构"
			}
		}
	} else {
		out.Name = mwpack.SeriesTitle(i.Contract.Series)
		out.Contract = i.Contract
	}
	if out.Name == "" {
		return nil
	}
	keys := []string{}
	hosts := map[string]bool{}
	parts := []string{}
	for role := range i.Roles {
		keys = append(keys, role)
	}
	sort.Strings(keys)
	for _, role := range keys {
		assigned := i.Roles[role]
		if len(assigned) == 0 {
			continue
		}
		title := i.RoleTitles[role]
		if title == "" {
			title = role
		}
		parts = append(parts, fmt.Sprintf("%s × %d", title, len(assigned)))
		for _, host := range assigned {
			hosts[host] = true
		}
	}
	out.Nodes = len(hosts)
	out.Topology = strings.Join(parts, " · ")
	return out
}

package mwpack

import (
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
)

// SolveImported constructs a valid, read-only *Plan for an onboarded brownfield cluster
// (DeliveryMode == "imported") without requiring initial-deployment mandatory parameters,
// offline package locks, or catalog presence. Both catalog components (PostgreSQL, Redis,
// etcd, Nginx, HAProxy, keepalived) and any of the 36+ non-catalog presets or custom
// middlewares produce a full Plan compatible with InstanceGraph, Docs, Rehearsal,
// Multi-Cluster Rollout, Security Scanning, and AI Assistant.
func SolveImported(cat *Catalog, d *Deployment) *Plan {
	if d == nil {
		return &Plan{}
	}
	ctrl := d.Controller
	if ctrl == "" && len(d.Hosts) > 0 {
		ctrl = d.Hosts[0].Name
	}
	platDef, okPlat := PlatformByID(d.Platform)
	if !okPlat {
		plID := strings.TrimSpace(d.Platform)
		if plID == "" {
			plID = "linux-custom"
		}
		title := plID
		if d.Imported != nil && strings.TrimSpace(d.Imported.OSDetail) != "" {
			title = strings.TrimSpace(d.Imported.OSDetail)
		}
		platDef = PlatformDef{ID: plID, Title: title}
	}
	p := &Plan{
		Dep:        d,
		Cat:        cat,
		Hosts:      append([]Host(nil), d.Hosts...),
		Controller: ctrl,
		Platforms:  []string{platDef.ID},
		Platform:   platDef,
	}

	hostIP := map[string]string{}
	for _, h := range d.Hosts {
		hostIP[h.Name] = h.IP
	}

	specs := d.Instances
	if len(specs) == 0 {
		compID := "custom-middleware"
		if d.Imported != nil && strings.TrimSpace(d.Imported.DisplayName) != "" {
			compID = NormalizeImportComponentID(d.Imported.DisplayName)
		}
		var names []string
		for _, h := range d.Hosts {
			names = append(names, h.Name)
		}
		specs = []InstanceSpec{{
			ID:        compID,
			Component: compID,
			Placement: map[string][]string{"node": names},
		}}
	}

	for idx, sp := range specs {
		instID := strings.TrimSpace(sp.ID)
		if instID == "" {
			instID = NormalizeImportComponentID(sp.Component)
		}
		compID := strings.TrimSpace(sp.Component)
		if compID == "" {
			compID = instID
		}

		var catComp *Component
		var catRes *Resolved
		if cat != nil {
			if c, ok := cat.Get(compID); ok {
				catComp = c
				verTry := sp.Version
				if verTry == "" && len(c.Versions) > 0 {
					verTry = c.Versions[0].ID
				}
				if r, err := c.Resolve(verTry); err == nil {
					catRes = r
				} else if len(c.Versions) > 0 {
					if r2, err2 := c.Resolve(c.Versions[0].ID); err2 == nil {
						catRes = r2
					}
				}
			}
		}

		preset, hasPreset := LookupImportPreset(compID)

		title := compID
		icon := "server"
		color := "slate"
		category := "middleware"
		if hasPreset {
			title = preset.Name
			icon = preset.Icon
			color = preset.Color
			category = preset.Category
		}
		if catComp != nil {
			if catComp.Title != "" {
				title = catComp.Title
			}
			if catComp.Icon != "" {
				icon = catComp.Icon
			}
			if catComp.Color != "" {
				color = catComp.Color
			}
			if catComp.Category != "" {
				category = catComp.Category
			}
		}
		if idx == 0 && d.Imported != nil {
			if strings.TrimSpace(d.Imported.DisplayName) != "" {
				title = strings.TrimSpace(d.Imported.DisplayName)
			}
			if strings.TrimSpace(d.Imported.Icon) != "" {
				icon = strings.TrimSpace(d.Imported.Icon)
			}
			if strings.TrimSpace(d.Imported.Color) != "" {
				color = strings.TrimSpace(d.Imported.Color)
			}
			if strings.TrimSpace(d.Imported.Category) != "" {
				category = strings.TrimSpace(d.Imported.Category)
			}
		}

		// Build ordered role map & host list
		rolesMap := map[string][]string{}
		roleTitleMap := map[string]string{}
		var roleOrder []string
		addRoleTitle := func(rid, rtitle string) {
			if rid == "" {
				return
			}
			if _, ok := roleTitleMap[rid]; !ok {
				roleTitleMap[rid] = rtitle
				roleOrder = append(roleOrder, rid)
			} else if roleTitleMap[rid] == "" && rtitle != "" {
				roleTitleMap[rid] = rtitle
			}
		}
		if catRes != nil {
			for _, r := range catRes.Roles {
				addRoleTitle(r.Name, r.Title)
			}
		}
		if hasPreset {
			for _, r := range preset.Roles {
				addRoleTitle(r.ID, r.Title)
			}
		}
		// Ensure every role used in Placement is registered with a readable title.
		specRoles := make([]string, 0, len(sp.Placement))
		for rk := range sp.Placement {
			specRoles = append(specRoles, rk)
		}
		sort.Strings(specRoles)
		for _, rk := range specRoles {
			hs := sp.Placement[rk]
			if len(hs) == 0 {
				continue
			}
			rolesMap[rk] = append([]string(nil), hs...)
			addRoleTitle(rk, defaultImportedRoleTitle(rk))
		}

		hosts := []string{}
		seenHost := map[string]bool{}
		for _, rk := range roleOrder {
			for _, h := range rolesMap[rk] {
				if h != "" && !seenHost[h] {
					seenHost[h] = true
					hosts = append(hosts, h)
				}
			}
		}
		if len(hosts) == 0 && len(d.Hosts) > 0 {
			for _, h := range d.Hosts {
				if h.Name != "" && !seenHost[h.Name] {
					seenHost[h.Name] = true
					hosts = append(hosts, h.Name)
				}
			}
			if len(hosts) > 0 {
				rolesMap["node"] = append([]string(nil), hosts...)
				addRoleTitle("node", "节点")
			}
		}

		// Assemble RoleSpec & FlowSpec for InstanceGraph topology rendering
		roleSpecs := []RoleSpec{}
		for _, rk := range roleOrder {
			if len(rolesMap[rk]) == 0 {
				continue
			}
			roleSpecs = append(roleSpecs, RoleSpec{Name: rk, Title: roleTitleMap[rk]})
		}
		flowSpecs := []FlowSpec{}
		if catRes != nil && len(catRes.Flows) > 0 {
			for _, fl := range catRes.Flows {
				if len(rolesMap[fl.From]) > 0 && len(rolesMap[fl.To]) > 0 {
					// Clear condition so flowViews always renders declared topology relationships on imported clusters.
					copyFl := fl
					copyFl.When = ""
					flowSpecs = append(flowSpecs, copyFl)
				}
			}
		}
		if len(flowSpecs) == 0 && hasPreset {
			for fi, fl := range preset.Flows {
				if len(rolesMap[fl.From]) == 0 || len(rolesMap[fl.To]) == 0 {
					continue
				}
				kind := "replication"
				if fl.From == fl.To || fl.Kind == "quorum" || fl.Kind == "peer" {
					if fl.From == fl.To {
						kind = "mesh"
					}
				}
				flowSpecs = append(flowSpecs, FlowSpec{
					ID:    fmt.Sprintf("flow-%d", fi),
					Title: fl.Label,
					From:  fl.From,
					To:    fl.To,
					Kind:  kind,
				})
			}
		}

		ver := strings.TrimSpace(sp.Version)
		if idx == 0 && d.Imported != nil && strings.TrimSpace(d.Imported.ExactVersion) != "" && ver == "" {
			ver = strings.TrimSpace(d.Imported.ExactVersion)
		}

		synComp := &Component{
			Schema:   ComponentSchema,
			Name:     compID,
			Short:    instID,
			Title:    title,
			Category: category,
			Icon:     icon,
			Color:    color,
		}
		if catComp != nil {
			synComp.Operations = catComp.Operations
			synComp.sum = catComp.sum
		}
		synRes := &Resolved{
			C:         synComp,
			Version:   Version{ID: ver, Status: "published"},
			Platforms: []string{platDef.ID},
			Overlay: Overlay{
				Roles: roleSpecs,
				Flows: flowSpecs,
			},
		}

		params := map[string]any{}
		visible := map[string]bool{}
		for k, v := range sp.Params {
			params[k] = v
			visible[k] = true
		}

		// Build endpoints, fronts, and ports from ImportedMeta.Endpoints (for primary instance) + preset default port
		endpoints := []EndpointFacts{}
		fronts := map[string]FrontFacts{}
		ports := []PortUse{}
		if idx == 0 && d.Imported != nil && len(d.Imported.Endpoints) > 0 {
			for ei, ep := range d.Imported.Endpoints {
				addr, portNum := splitImportedAddressPort(ep.Address, preset.DefaultPort)
				epName := strings.TrimSpace(ep.Name)
				if epName == "" {
					if ep.Role != "" {
						epName = ep.Role
					} else {
						epName = fmt.Sprintf("endpoint-%d", ei+1)
					}
				}
				backends := make([]Backend, 0, len(hosts))
				for _, h := range hosts {
					backends = append(backends, Backend{Host: h, IP: hostIP[h], Port: portNum})
				}
				endpoints = append(endpoints, EndpointFacts{
					Name:     epName,
					Title:    epName,
					Protocol: "tcp",
					Port:     portNum,
					Backends: backends,
				})
				if addr != "" {
					fronts[epName] = FrontFacts{
						Balancer: "external",
						Name:     epName,
						Listen:   portNum,
						Address:  addr,
						External: true,
					}
				}
				if portNum > 0 {
					ports = append(ports, PortUse{Instance: instID, Name: epName, Port: portNum, Proto: "tcp", Hosts: hosts})
				}
			}
		} else if preset.DefaultPort > 0 && len(hosts) > 0 {
			ports = append(ports, PortUse{Instance: instID, Name: "service", Port: preset.DefaultPort, Proto: "tcp", Hosts: hosts})
		}

		inst := &Instance{
			ID:         instID,
			Component:  compID,
			Version:    ver,
			Title:      title,
			R:          synRes,
			Roles:      rolesMap,
			Hosts:      hosts,
			Params:     params,
			Visible:    visible,
			Uses:       map[string]*Use{},
			Endpoints:  endpoints,
			Fronts:     fronts,
			Ports:      ports,
			Spec:       sp,
			controller: ctrl,
			cluster:    d.ID,
		}
		p.Instances = append(p.Instances, inst)
	}

	return p
}

// ImportedSchemeSummary builds a concise SchemeSummary for an imported cluster's architecture header.
func ImportedSchemeSummary(d *Deployment) *SchemeSummary {
	if d == nil {
		return nil
	}
	hostCount := len(d.Hosts)
	name := "存量纳管集群"
	if d.Imported != nil && strings.TrimSpace(d.Imported.ArchSummary) != "" {
		name = strings.TrimSpace(d.Imported.ArchSummary)
	} else if hostCount == 1 {
		name = "存量单节点实例"
	} else if hostCount > 1 {
		name = fmt.Sprintf("存量多节点架构（%d 节点）", hostCount)
	}
	var roleParts []string
	if len(d.Instances) > 0 {
		keys := make([]string, 0, len(d.Instances[0].Placement))
		for k := range d.Instances[0].Placement {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if n := len(d.Instances[0].Placement[k]); n > 0 {
				roleParts = append(roleParts, fmt.Sprintf("%s × %d", defaultImportedRoleTitle(k), n))
			}
		}
	}
	topo := strings.Join(roleParts, " · ")
	if topo == "" {
		topo = fmt.Sprintf("%d 台主机", hostCount)
	}
	mech := "已纳管运行中集群"
	if d.Imported != nil {
		switch d.Imported.DeployMethod {
		case "systemd":
			mech = "systemd 服务纳管"
		case "docker":
			mech = "Docker / 容器纳管"
		case "binary":
			mech = "二进制手工部署纳管"
		case "k8s":
			mech = "Kubernetes 集群纳管"
		}
	}
	return &SchemeSummary{
		ID:       "imported",
		Name:     name,
		Topology: topo,
		Nodes:    hostCount,
		Source:   "imported",
		Evidence: []string{},
		Contract: &SeriesContract{
			Mechanism:   mech,
			Limitations: []string{},
			Acceptance:  []string{},
			Operations:  []string{},
		},
	}
}

func defaultImportedRoleTitle(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "primary", "master":
		return "主节点"
	case "replica", "secondary", "standby", "slave":
		return "从节点"
	case "arbiter":
		return "仲裁节点"
	case "sentinel":
		return "哨兵节点"
	case "member":
		return "成员节点"
	case "broker":
		return "Broker 节点"
	case "controller":
		return "Controller 节点"
	case "namesrv":
		return "NameServer"
	case "data":
		return "数据节点"
	case "coord":
		return "协调节点"
	case "router", "mongos", "obproxy":
		return "代理路由"
	case "gateway":
		return "网关节点"
	case "server":
		return "服务端节点"
	case "client":
		return "客户端节点"
	case "disc":
		return "磁盘节点"
	case "ram":
		return "内存节点"
	case "shard":
		return "分片节点"
	case "keeper":
		return "Keeper 节点"
	case "mon":
		return "MON 监控"
	case "osd":
		return "OSD 存储"
	case "rgw":
		return "RGW 网关"
	default:
		return "节点"
	}
}

func splitImportedAddressPort(raw string, fallbackPort int) (string, int) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fallbackPort
	}
	// Strip scheme if someone pasted http:// or tcp://
	if idx := strings.Index(s, "://"); idx >= 0 {
		s = s[idx+3:]
	}
	if slash := strings.IndexByte(s, '/'); slash >= 0 {
		s = s[:slash]
	}
	if host, portStr, err := net.SplitHostPort(s); err == nil {
		if pn, err2 := strconv.Atoi(portStr); err2 == nil && pn > 0 {
			return host, pn
		}
		return host, fallbackPort
	}
	return s, fallbackPort
}

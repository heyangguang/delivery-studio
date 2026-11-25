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

	companionByComp := map[string]ImportedCompanion{}
	if d.Imported != nil {
		for _, cm := range d.Imported.Companions {
			cid := NormalizeCompanionID(cm.Component)
			if cid != "" {
				companionByComp[cid] = cm
			}
		}
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
		compDef, hasCompDef := LookupCompanionDef(compID)
		compMeta, hasCompMeta := companionByComp[NormalizeCompanionID(compID)]

		title := compID
		icon := "server"
		color := "slate"
		category := "middleware"
		if hasCompDef {
			title = compDef.Name
			icon = compDef.Icon
			color = compDef.Color
		}
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
		if idx > 0 && hasCompMeta {
			if strings.TrimSpace(compMeta.DisplayName) != "" {
				title = strings.TrimSpace(compMeta.DisplayName)
			}
			if strings.TrimSpace(compMeta.Icon) != "" {
				icon = strings.TrimSpace(compMeta.Icon)
			}
			if strings.TrimSpace(compMeta.Color) != "" {
				color = strings.TrimSpace(compMeta.Color)
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
		if hasCompDef && compDef.DefaultRole != "" {
			addRoleTitle(compDef.DefaultRole, compDef.RoleTitle)
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
				fallbackRole := "node"
				fallbackTitle := "节点"
				if hasCompDef && compDef.DefaultRole != "" {
					fallbackRole = compDef.DefaultRole
					fallbackTitle = compDef.RoleTitle
				}
				rolesMap[fallbackRole] = append([]string(nil), hosts...)
				addRoleTitle(fallbackRole, fallbackTitle)
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
		isSyncRepl := false
		if sp.Params != nil {
			if rv, ok := sp.Params["replication"]; ok {
				s := strings.ToLower(strings.TrimSpace(fmt.Sprint(rv)))
				if s == "quorum" || s == "sync" || s == "synchronous" || s == "strict" {
					isSyncRepl = true
				}
			}
			if sv, ok := sp.Params["synchronous_mode"]; ok {
				s := strings.ToLower(strings.TrimSpace(fmt.Sprint(sv)))
				if s == "true" || s == "on" || s == "strict" || s == "1" {
					isSyncRepl = true
				}
			}
		}
		if catRes != nil && len(catRes.Flows) > 0 {
			for _, fl := range catRes.Flows {
				if len(rolesMap[fl.From]) > 0 && len(rolesMap[fl.To]) > 0 {
					copyFl := fl
					copyFl.When = ""
					if copyFl.Kind == "replication" && isSyncRepl {
						copyFl.Sync = "true"
					} else if copyFl.Sync != "" && copyFl.Sync != "true" {
						copyFl.Sync = ""
					}
					flowSpecs = append(flowSpecs, copyFl)
				}
			}
		}
		if len(flowSpecs) == 0 {
			srcFlows := preset.Flows
			if len(srcFlows) == 0 && hasCompDef {
				srcFlows = compDef.Flows
			}
			for fi, fl := range srcFlows {
				if len(rolesMap[fl.From]) == 0 || len(rolesMap[fl.To]) == 0 {
					continue
				}
				kind := "replication"
				syncExpr := ""
				if fl.From == fl.To {
					kind = "mesh"
					if fl.Kind == "quorum" {
						syncExpr = "true"
					}
				} else if isSyncRepl {
					syncExpr = "true"
				}
				flowSpecs = append(flowSpecs, FlowSpec{
					ID:    fmt.Sprintf("flow-%d", fi),
					Title: fl.Label,
					From:  fl.From,
					To:    fl.To,
					Kind:  kind,
					Sync:  syncExpr,
				})
			}
		}

		ver := strings.TrimSpace(sp.Version)
		if idx == 0 && d.Imported != nil && strings.TrimSpace(d.Imported.ExactVersion) != "" && ver == "" {
			ver = strings.TrimSpace(d.Imported.ExactVersion)
		}
		if idx > 0 && ver == "" && hasCompMeta {
			ver = strings.TrimSpace(compMeta.Version)
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
			synComp.Context = catComp.Context
			synComp.Provides = catComp.Provides
			synComp.Params = catComp.Params
			synComp.sum = catComp.sum
		}
		var synParams []Param
		if catRes != nil && len(catRes.Params) > 0 {
			synParams = catRes.Params
		} else if catComp != nil && len(catComp.Params) > 0 {
			synParams = catComp.Params
		}
		synRes := &Resolved{
			C:         synComp,
			Version:   Version{ID: ver, Status: "published"},
			Platforms: []string{platDef.ID},
			Overlay: Overlay{
				Roles:  roleSpecs,
				Flows:  flowSpecs,
				Params: synParams,
			},
		}

		params := map[string]any{}
		visible := map[string]bool{}
		for k, v := range sp.Params {
			params[k] = v
			visible[k] = true
		}

		// Build endpoints, fronts, and ports
		endpoints := []EndpointFacts{}
		fronts := map[string]FrontFacts{}
		ports := []PortUse{}
		seenPort := map[int]bool{}
		addPort := func(label string, pn int) {
			if pn <= 0 || seenPort[pn] || len(hosts) == 0 {
				return
			}
			seenPort[pn] = true
			ports = append(ports, PortUse{Instance: instID, Name: label, Port: pn, Proto: "tcp", Hosts: hosts})
		}

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
				epTitle := importedEndpointTitle(epName, ep.Role)
				backends := make([]Backend, 0, len(hosts))
				for _, h := range hosts {
					backends = append(backends, Backend{Host: h, IP: hostIP[h], Port: portNum})
				}
				endpoints = append(endpoints, EndpointFacts{
					Name:     epName,
					Title:    epTitle,
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
				addPort(importedPortLabel(epName, ep.Role, title), portNum)
			}
		} else if idx > 0 {
			if hasCompMeta && len(compMeta.Ports) > 0 {
				for _, pn := range compMeta.Ports {
					addPort(companionPortLabel(compDef, pn, title), pn)
				}
			} else if hasCompDef && len(compDef.DefaultPorts) > 0 {
				for _, dp := range compDef.DefaultPorts {
					addPort(dp.Name, dp.Port)
				}
			} else if preset.DefaultPort > 0 {
				addPort(title, preset.DefaultPort)
			}
		} else if preset.DefaultPort > 0 {
			addPort(title, preset.DefaultPort)
		}

		inst := &Instance{
			ID:         instID,
			Component:  compID,
			Version:    ver,
			Title:      title,
			R:          synRes,
			Auto:       idx > 0 && hasCompMeta && compMeta.Inferred,
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

	// Second pass: wire cross-instance Uses (e.g. Patroni -> etcd DCS & PostgreSQL database context).
	byID := map[string]*Instance{}
	for _, inst := range p.Instances {
		byID[inst.ID] = inst
	}
	for _, inst := range p.Instances {
		for capName, targetID := range inst.Spec.Uses {
			if tgt, ok := byID[targetID]; ok {
				inst.Uses[capName] = &Use{
					Capability: capName,
					Instance:   tgt.ID,
					Component:  tgt.Component,
				}
			}
		}
	}

	return p
}

// ImportedSchemeSummary builds a concise SchemeSummary for an imported cluster's architecture header.
func ImportedSchemeSummary(d *Deployment) *SchemeSummary {
	if d == nil {
		return nil
	}
	hostCount := len(d.Hosts)
	var stackTitles []string
	seenStack := map[string]bool{}
	addStackTitle := func(t string) {
		t = strings.TrimSpace(t)
		if t != "" && !seenStack[strings.ToLower(t)] {
			seenStack[strings.ToLower(t)] = true
			stackTitles = append(stackTitles, t)
		}
	}
	if len(d.Instances) > 0 {
		primaryTitle := d.Instances[0].Component
		if d.Imported != nil && strings.TrimSpace(d.Imported.DisplayName) != "" {
			primaryTitle = strings.TrimSpace(d.Imported.DisplayName)
		} else if pr, ok := LookupImportPreset(d.Instances[0].Component); ok {
			primaryTitle = pr.Name
		}
		addStackTitle(primaryTitle)
		for _, sp := range d.Instances[1:] {
			t := sp.Component
			if cd, ok := LookupCompanionDef(sp.Component); ok {
				t = cd.Name
			} else if pr, ok := LookupImportPreset(sp.Component); ok {
				t = pr.Name
			}
			addStackTitle(t)
		}
	}
	if d.Imported != nil {
		for _, cm := range d.Imported.Companions {
			if cm.Kind == "monitoring" {
				continue
			}
			t := strings.TrimSpace(cm.DisplayName)
			if t == "" {
				if cd, ok := LookupCompanionDef(cm.Component); ok {
					t = cd.Name
				} else {
					t = cm.Component
				}
			}
			addStackTitle(t)
		}
	}

	name := "存量纳管集群"
	if d.Imported != nil && strings.TrimSpace(d.Imported.ArchSummary) != "" {
		name = strings.TrimSpace(d.Imported.ArchSummary)
	} else if len(stackTitles) > 1 {
		name = fmt.Sprintf("%s 架构集群（%d 节点）", strings.Join(stackTitles, " + "), hostCount)
	} else if hostCount == 1 {
		name = "存量单节点实例"
	} else if hostCount > 1 {
		name = fmt.Sprintf("存量多节点架构（%d 节点）", hostCount)
	}

	var roleParts []string
	if len(d.Instances) > 0 {
		primaryComp := d.Instances[0].Component
		preset, hasPreset := LookupImportPreset(primaryComp)
		roleTitles := map[string]string{}
		if hasPreset {
			for _, r := range preset.Roles {
				roleTitles[r.ID] = r.Title
			}
		}
		keys := make([]string, 0, len(d.Instances[0].Placement))
		for k := range d.Instances[0].Placement {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if n := len(d.Instances[0].Placement[k]); n > 0 {
				rt := roleTitles[k]
				if rt == "" {
					rt = defaultImportedRoleTitle(k)
				}
				roleParts = append(roleParts, fmt.Sprintf("%s × %d", rt, n))
			}
		}
		for _, sp := range d.Instances[1:] {
			cnt := 0
			seenH := map[string]bool{}
			for _, hs := range sp.Placement {
				for _, hn := range hs {
					if hn != "" && !seenH[hn] {
						seenH[hn] = true
						cnt++
					}
				}
			}
			if cnt == 0 {
				cnt = hostCount
			}
			label := sp.Component
			if cd, ok := LookupCompanionDef(sp.Component); ok {
				label = cd.Name
			} else if pr, ok := LookupImportPreset(sp.Component); ok {
				label = pr.Name
			}
			roleParts = append(roleParts, fmt.Sprintf("%s × %d", label, cnt))
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
	evidence := []string{}
	if len(stackTitles) > 1 {
		evidence = append(evidence, fmt.Sprintf("已识别 %d 个架构组件：%s", len(stackTitles), strings.Join(stackTitles, " / ")))
	}
	return &SchemeSummary{
		ID:       "imported",
		Name:     name,
		Topology: topo,
		Nodes:    hostCount,
		Source:   "imported",
		Evidence: evidence,
		Contract: &SeriesContract{
			Mechanism:   mech,
			Limitations: []string{},
			Acceptance:  []string{},
			Operations:  []string{},
		},
	}
}

func importedEndpointTitle(epName, role string) string {
	lowName := strings.ToLower(strings.TrimSpace(epName))
	lowRole := strings.ToLower(strings.TrimSpace(role))
	switch lowName {
	case "eip":
		return "EIP 弹性公网"
	case "vip":
		return "VIP 虚拟 IP"
	case "f5":
		return "F5 负载均衡"
	case "elb":
		return "ELB 负载均衡"
	case "slb":
		return "SLB 负载均衡"
	case "lvs":
		return "LVS 四层均衡"
	case "haproxy":
		return "HAProxy 代理"
	case "nginx":
		return "Nginx 代理"
	case "pooler", "pgbouncer":
		return "连接池入口"
	case "dns":
		return "DNS 域名入口"
	case "metrics":
		return "监控指标入口"
	}
	genericNames := map[string]bool{
		"": true, "readwrite": true, "rw": true, "write": true, "writer": true, "primary": true, "master": true,
		"readonly": true, "ro": true, "read": true, "reader": true, "replica": true, "standby": true,
		"admin": true, "console": true, "mgmt": true, "management": true, "endpoint": true,
	}
	if !genericNames[lowName] && epName != "" {
		return epName
	}
	switch lowRole {
	case "readonly", "ro", "read", "reader", "replica", "standby":
		return "只读入口"
	case "admin", "console", "mgmt", "management":
		return "管理入口"
	default:
		if lowName == "readonly" || lowName == "ro" || lowName == "reader" || lowName == "read" {
			return "只读入口"
		}
		if lowName == "admin" || lowName == "console" || lowName == "mgmt" {
			return "管理入口"
		}
		return "读写入口"
	}
}

func importedPortLabel(epName, role, compTitle string) string {
	lowRole := strings.ToLower(strings.TrimSpace(role))
	lowName := strings.ToLower(strings.TrimSpace(epName))
	switch lowRole {
	case "readonly", "ro", "read", "reader":
		return "只读"
	case "admin", "console", "mgmt":
		return "管理"
	case "readwrite", "rw", "write", "writer":
		if strings.TrimSpace(compTitle) != "" {
			return compTitle
		}
		return "读写"
	default:
		if lowName == "readwrite" || lowName == "writer" || lowName == "" {
			if strings.TrimSpace(compTitle) != "" {
				return compTitle
			}
			return "读写"
		}
		if lowName == "readonly" || lowName == "reader" {
			return "只读"
		}
		return epName
	}
}

func companionPortLabel(def CompanionDef, port int, fallback string) string {
	for _, dp := range def.DefaultPorts {
		if dp.Port == port {
			return dp.Name
		}
	}
	if strings.TrimSpace(fallback) != "" {
		return fallback
	}
	return "service"
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

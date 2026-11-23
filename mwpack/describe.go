package mwpack

import "sort"

// Schema is what a form needs to render one component version: everything declarative, nothing executable.
type Schema struct {
	DeliveryModes     []string        `json:"delivery_modes"`
	Component         string          `json:"component"`
	Title             string          `json:"title"`
	Version           string          `json:"version"`
	Status            string          `json:"status"`
	Platforms         []string        `json:"platforms"`
	VerifiedPlatforms []string        `json:"verified_platforms,omitempty"`
	Context           string          `json:"context,omitempty"`
	Companions    []CompanionSpec `json:"companions,omitempty"`
	Kind          string          `json:"kind,omitempty"`
	Provides      []string        `json:"provides,omitempty"`
	Roles         []RoleSpec      `json:"roles"`
	Groups        []Group         `json:"groups"`
	Params        []Param         `json:"params"`
	Rules         []RuleView      `json:"rules,omitempty"`
	Requires      []Require       `json:"requires,omitempty"`
	Endpoints     []Endpoint      `json:"endpoints,omitempty"`
	Inputs        []Input         `json:"inputs,omitempty"`
	Addons        *AddonSet       `json:"addons,omitempty"`
	LB            *LBSpec         `json:"lb,omitempty"`
	Presets       []Preset        `json:"presets,omitempty"`
}

type RuleView struct {
	ID      string `json:"id"`
	Message string `json:"message"`
	Warn    bool   `json:"warn,omitempty"`
}

// Describe returns the schema of a component version.
func (c *Component) Describe(version string) (*Schema, error) {
	if version == "" {
		version = defaultVersion(c)
	}
	r, err := c.Resolve(version)
	if err != nil {
		return nil, err
	}
	s := &Schema{DeliveryModes: c.EffectiveDeliveryModes(), Component: c.Name, Title: c.Title, Version: version, Status: firstNonEmpty(r.Version.Status, "draft"), Platforms: r.Platforms, VerifiedPlatforms: r.EffectiveVerifiedPlatforms(),
		Context: c.Context, Companions: c.Companions, Kind: c.Kind, Provides: c.Provides, Roles: r.Roles, Groups: r.Groups, Params: r.Params, Requires: r.Requires,
		Endpoints: r.Endpoints, Inputs: r.Inputs, Addons: r.Addons, LB: r.LB}
	for _, x := range r.Rules {
		s.Rules = append(s.Rules, RuleView{x.ID, x.Message, x.Warn})
	}
	if c.Detail != nil {
		s.Presets = append([]Preset(nil), c.Detail.Presets...)
		for idx := range s.Presets {
			preset := &s.Presets[idx]
			preset.Name = PresetTitle(c.Name, preset.ID, preset.Name)
			if c.Name == "postgresql" && preset.ID == "patroni" {
				preset.Spec = "Patroni 管理主从 · 自动故障切换 · 平台部署 etcd"
			}
		}
	}
	return s, nil
}

// Info is a short description for catalog listings.
type Info struct {
	DeliveryModes []string  `json:"delivery_modes"`
	Name          string    `json:"id"`
	Short         string    `json:"short,omitempty"`
	Title         string    `json:"name"`
	Category      string    `json:"category"`
	Summary       string    `json:"description"`
	Tags          []string  `json:"tags,omitempty"`
	Icon          string    `json:"icon,omitempty"`
	Color         string    `json:"color,omitempty"`
	Context       string    `json:"context,omitempty"`
	Kind          string    `json:"kind,omitempty"`
	Provides      []string  `json:"provides,omitempty"`
	Default       string    `json:"version"`
	Versions      []VerInfo `json:"versions"`
	Detail        *Detail   `json:"detail,omitempty"`
	// Operations is the author's operations knowledge, as written (placeholders not filled in).
	Operations *Operations `json:"operations,omitempty"`
	Roles      []RoleSpec  `json:"roles"`
	// Flows are the declared data flows of the default version, for drawing a topology of the component.
	Flows []FlowSpec `json:"flows,omitempty"`
	// Artifacts lists, for the default version, the offline files needed regardless of options.
	Artifacts []Artifact `json:"artifacts,omitempty"`
}

type VerInfo struct {
	ID                string     `json:"id"`
	Status            string     `json:"status"`
	Platforms         []string   `json:"platforms,omitempty"`
	VerifiedPlatforms []string   `json:"verified_platforms,omitempty"`
	Artifacts         []Artifact `json:"artifacts,omitempty"`
	// Packages are the unconditional packages per platform; conditional ones are decided when a deployment is resolved.
	Packages map[string][]PackageRequest `json:"packages,omitempty"`
	Released string                      `json:"released,omitempty"`
	Notes    []string                    `json:"notes,omitempty"`
}

// Infos lists every component for the application catalog.
func (cat *Catalog) Infos() []Info {
	var out []Info
	for _, name := range cat.Names() {
		c := cat.byName[name]
		def := defaultVersion(c)
		info := Info{DeliveryModes: c.EffectiveDeliveryModes(), Name: c.Name, Short: c.Short, Title: c.Title, Category: c.Category, Summary: c.Summary, Tags: c.Tags, Icon: c.Icon, Color: c.Color, Context: c.Context, Kind: c.Kind, Provides: c.Provides, Default: def, Detail: c.Detail, Operations: c.Operations}
		for _, v := range c.Versions {
			r, err := c.Resolve(v.ID)
			if err != nil {
				continue
			}
			vi := VerInfo{ID: v.ID, Status: firstNonEmpty(r.Version.Status, "draft"), Platforms: r.Platforms, VerifiedPlatforms: r.EffectiveVerifiedPlatforms(), Released: v.Released, Notes: v.Notes}
			for _, a := range r.Artifacts {
				if a.When == "" {
					vi.Artifacts = append(vi.Artifacts, a)
				}
			}
			vi.Packages = map[string][]PackageRequest{}
			for _, pl := range r.Platforms {
				for _, pk := range r.Packages {
					if pk.When == "" && (len(pk.Platforms) == 0 || contains(pk.Platforms, pl)) {
						vi.Packages[pl] = append(vi.Packages[pl], PackageRequest{pk.Name, pk.Version})
					}
				}
			}
			info.Versions = append(info.Versions, vi)
			if v.ID == def {
				info.Roles = r.Roles
				info.Flows = r.Flows
				info.Artifacts = vi.Artifacts
			}
		}
		sort.SliceStable(info.Versions, func(i, j int) bool { return CompareVersions(info.Versions[i].ID, info.Versions[j].ID) > 0 })
		out = append(out, info)
	}
	return out
}

// ---- plan view for the resolve API ----

type InstanceView struct {
	Scheme         *SchemeSummary        `json:"scheme,omitempty"`
	Contract       *SeriesContract       `json:"contract,omitempty"`
	ManagedContext string                `json:"managed_context,omitempty"`
	ID             string                `json:"id"`
	Component      string                `json:"component"`
	Title          string                `json:"title"`
	Version        string                `json:"version"`
	Status         string                `json:"status"`
	Manifest       string                `json:"manifest,omitempty"`
	Auto           bool                  `json:"auto,omitempty"`
	AutoReason     string                `json:"auto_reason,omitempty"`
	External       bool                  `json:"external,omitempty"`
	Roles          map[string][]string   `json:"roles"`
	RoleTitles     map[string]string     `json:"role_titles,omitempty"`
	Flows          []FlowView            `json:"flows,omitempty"`
	Hosts          []string              `json:"hosts"`
	Params         map[string]any        `json:"params"`
	Visible        map[string]bool       `json:"visible"`
	Endpoints      []EndpointFacts       `json:"endpoints,omitempty"`
	Fronts         map[string]FrontFacts `json:"fronts,omitempty"`
	Uses           map[string]*Use       `json:"uses,omitempty"`
	Ports          []PortUse             `json:"ports,omitempty"`
}

// FlowView is a declared data flow resolved against this instance: the machines it starts on and ends on.
type FlowView struct {
	ID    string   `json:"id"`
	Title string   `json:"title"`
	Kind  string   `json:"kind"`
	From  []string `json:"from"`
	To    []string `json:"to"`
	// FromRole and ToRole name the roles the machines belong to, so the picture can start a line at the right component.
	FromRole string `json:"from_role"`
	ToRole   string `json:"to_role"`
	Sync     bool   `json:"sync,omitempty"`
}

// flowViews resolves the declared flows of an instance. A flow with no machine on either end is left out.
func flowViews(inst *Instance) []FlowView {
	var out []FlowView
	if inst.R == nil || inst.External {
		return out
	}
	env := inst.Env()
	for _, f := range inst.R.Flows {
		if on, err := env.Bool(f.When); err != nil || !on {
			continue
		}
		from, to := inst.Roles[f.From], inst.Roles[f.To]
		if len(from) == 0 || len(to) == 0 || (f.Kind == "mesh" && len(from) < 2) {
			continue
		}
		sync := false
		if f.Sync != "" {
			sync, _ = env.Bool(f.Sync)
		}
		out = append(out, FlowView{ID: f.ID, Title: f.Title, Kind: f.Kind, From: append([]string{}, from...), To: append([]string{}, to...), FromRole: f.From, ToRole: f.To, Sync: sync})
	}
	return out
}

type ArtifactView struct {
	Name string `json:"name"`
	File string `json:"file"`
	Kind string `json:"kind"`
}

type PlanView struct {
	ExecutionHost *ExecutionHost `json:"execution_host,omitempty"`
	OK            bool           `json:"ok"`
	Issues        []Problem      `json:"issues"`
	Controller    string         `json:"controller"`
	Platforms     []string       `json:"platforms"`
	Instances     []InstanceView `json:"instances"`
	Inputs        []InputReq     `json:"inputs"`
	Artifacts     []ArtifactView `json:"artifacts"`
	Phases        []PhaseView    `json:"phases,omitempty"`
}

type PhaseView struct {
	Phase string      `json:"phase"`
	Title string      `json:"title"`
	Steps []*PlanStep `json:"steps"`
}

// View summarises a plan for the form. Steps are included only when the plan has no errors.
func (p *Plan) View() PlanView {
	v := PlanView{ExecutionHost: p.Dep.ExecutionHost, OK: len(p.Errors()) == 0, Issues: p.Issues, Controller: p.Controller, Platforms: p.Platforms, Inputs: p.Inputs}
	if v.Issues == nil {
		v.Issues = []Problem{}
	}
	if v.Inputs == nil {
		v.Inputs = []InputReq{}
	}
	for _, i := range p.Instances {
		iv := InstanceView{ID: i.ID, Component: i.Component, Title: i.Title, Version: i.Version, Status: i.R.PlatformStatus(p.Platform.ID), Manifest: i.R.C.sum,
			Auto: i.Auto, AutoReason: i.AutoReason, External: i.External, Roles: i.Roles, Hosts: i.Hosts, Params: i.Params, Visible: i.Visible,
			Endpoints: i.Endpoints, Fronts: i.Fronts, Uses: i.Uses, Ports: i.Ports}
		if u := i.Uses[i.R.C.Context]; i.R.C.Context != "" && u != nil {
			iv.ManagedContext = u.Instance
		}
		iv.Contract, _ = i.SelectedSeries()
		iv.Scheme = i.SchemeSummary()
		iv.Flows = flowViews(i)
		iv.RoleTitles = map[string]string{}
		if i.R != nil {
			for _, role := range i.R.Roles {
				iv.RoleTitles[role.Name] = role.Title
			}
		}
		if iv.Hosts == nil {
			iv.Hosts = []string{}
		}
		v.Instances = append(v.Instances, iv)
	}
	if v.Instances == nil {
		v.Instances = []InstanceView{}
	}
	v.Artifacts = []ArtifactView{}
	if v.OK {
		for _, a := range p.Artifacts() {
			v.Artifacts = append(v.Artifacts, ArtifactView{a.Name, a.File, a.Kind})
		}
		st := p.BuildSteps("")
		for _, ph := range st.Phases {
			v.Phases = append(v.Phases, PhaseView{ph.Phase, ph.Title, ph.Steps})
		}
	}
	return v
}

// AllPackages lists every package of every version of every component for a platform, ignoring the conditions that
// decide at deployment time whether a package is needed (TDE, replicas). It is what a complete library holds.
func (cat *Catalog) AllPackages(platform string) []PackageRequest {
	var out []PackageRequest
	seen := map[string]bool{}
	if def, ok := PlatformByID(platform); ok {
		for _, r := range def.ControllerPackages {
			seen[r.Key()] = true
			out = append(out, r)
		}
	}
	for _, name := range cat.Names() {
		c := cat.byName[name]
		for _, v := range c.Versions {
			r, err := c.Resolve(v.ID)
			if err != nil || !contains(r.Platforms, platform) {
				continue
			}
			for _, pk := range r.Packages {
				if len(pk.Platforms) > 0 && !contains(pk.Platforms, platform) {
					continue
				}
				q := PackageRequest{pk.Name, pk.Version}
				if !seen[q.Key()] {
					seen[q.Key()] = true
					out = append(out, q)
				}
			}
		}
	}
	return out
}

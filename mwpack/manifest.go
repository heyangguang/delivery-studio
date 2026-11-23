// Package mwpack turns declarative component manifests plus a deployment spec into a reviewed plan,
// a complete offline Ansible project and the handbooks that go with it. It never touches a target host.
package mwpack

import "io/fs"

// Phase names in execution order. Components fill the ones they need.
// ComponentIcons and ComponentColors are the logos and tints a component may choose; the interface draws them
// (frontend/src/glyphs.tsx has the same lists, and a test keeps the two equal).
var (
	ComponentIcons  = []string{"database", "kv", "cache", "queue", "storage", "search", "balance", "gateway", "vip", "cloud", "server", "cluster", "monitor", "key", "container", "network", "file", "bell", "redis", "mysql", "kafka", "mongodb", "rabbitmq", "elasticsearch", "zookeeper", "minio", "prometheus", "grafana", "kubernetes", "docker"}
	ComponentColors = []string{"indigo", "blue", "teal", "green", "amber", "coral", "red", "pink", "slate"}
)

var Phases = []string{"preflight", "install", "configure", "start", "provision", "verify"}

var PhaseTitles = map[string]string{
	"preflight": "环境与作用域检查",
	"install":   "离线源与软件安装",
	"configure": "写入配置",
	"start":     "启动与组网",
	"provision": "初始化、加固与备份",
	"verify":    "只读健康检查",
}

// Component is one middleware (or helper) that can be placed on machines. Everything application specific
// lives here as data; the platform has no knowledge of any particular product.
type Component struct {
	Configuration []ConfigurationOutput `yaml:"configuration" json:"configuration,omitempty"`
	// DeliveryModes are publish-time capabilities. Omitted legacy manifests remain offline-only.
	DeliveryModes []string `yaml:"delivery_modes" json:"delivery_modes,omitempty"`

	// Companions are opt-in managers attached by a deployment scheme. Unlike
	// requires, the manager depends on this component, never the other way round.
	Companions []CompanionSpec `yaml:"companions" json:"companions,omitempty"`
	// Context names a required capability whose instance is managed by this
	// component. Its tasks receive that database's identity, secrets and endpoints.
	Context string `yaml:"context" json:"context,omitempty"`
	// SharedFiles explicitly opts a source file into use by more than one step.
	// Paths are component-relative, exact (no globs), and checked during catalog loading.
	SharedFiles []string `yaml:"shared_files" json:"shared_files,omitempty"`
	Schema      string   `yaml:"schema" json:"schema"`
	Name        string   `yaml:"component" json:"component"`
	// Short is the default instance id a form proposes (pg, lb).
	Short    string   `yaml:"short" json:"short,omitempty"`
	Title    string   `yaml:"title" json:"title"`
	Category string   `yaml:"category" json:"category"`
	Summary  string   `yaml:"summary" json:"summary,omitempty"`
	Tags     []string `yaml:"tags" json:"tags,omitempty"`
	// Icon and Color give the component its logo in the interface; both are names from ComponentIcons and
	// ComponentColors. Empty means the default for its category.
	Icon  string `yaml:"icon" json:"icon,omitempty"`
	Color string `yaml:"color" json:"color,omitempty"`
	// Kind is empty for software that is installed on machines, "external" for something the customer
	// operates (a cloud load balancer): the delivery is a configuration sheet, and any lifecycle steps the component
	// still carries are kept but not used.
	Kind     string   `yaml:"kind" json:"kind,omitempty"`
	Provides []string `yaml:"provides" json:"provides,omitempty"`
	// DataVolume marks software that stores data under the platform data mount (/data).
	DataVolume bool    `yaml:"data_volume" json:"data_volume,omitempty"`
	Detail     *Detail `yaml:"detail" json:"detail,omitempty"`
	// Operations is what the people running the software day to day need to know; it opens the handover document
	// (运维交接) of every cluster that uses the component and does not influence generation.
	Operations *Operations `yaml:"operations" json:"operations,omitempty"`
	Versions   []Version   `yaml:"versions" json:"versions"`
	Overlay    `yaml:",inline"`

	dir  string // directory the manifest was loaded from (roles/ live beside it)
	fsys fs.FS
	sum  string // sha256 of the manifest file, recorded in the version lock
}

// Detail is marketing and capability text for the product page; it does not influence generation.
type Detail struct {
	Tagline      string      `yaml:"tagline" json:"tagline,omitempty"`
	Scale        string      `yaml:"scale" json:"scale,omitempty"`
	Capabilities []NamedText `yaml:"capabilities" json:"capabilities,omitempty"`
	Includes     []NamedText `yaml:"includes" json:"includes,omitempty"`
	Limits       []string    `yaml:"limits" json:"limits,omitempty"`
	Presets      []Preset    `yaml:"presets" json:"presets,omitempty"`
}

// Operations is the component author's operations knowledge. Commands may name ${cluster}, ${instance} and
// ${params.<key>}; the handover document fills them in for each instance. Items with a When expression only apply when
// it is true for the instance (for example only with replicas).
type Operations struct {
	Overview string      `yaml:"overview" json:"overview,omitempty"`
	Checks   []OpsItem   `yaml:"checks" json:"checks,omitempty"` // daily inspection
	Tasks    []OpsItem   `yaml:"tasks" json:"tasks,omitempty"`   // routine operations
	Faults   []OpsFault  `yaml:"faults" json:"faults,omitempty"` // typical problems and how to look into them
	Logs     []NamedText `yaml:"logs" json:"logs,omitempty"`     // name: what is logged, text: where
}

type OpsItem struct {
	Title  string `yaml:"title" json:"title"`
	When   string `yaml:"when" json:"when,omitempty"`
	Hosts  string `yaml:"hosts" json:"hosts,omitempty"` // which machines, in words or a role name
	Cmd    string `yaml:"cmd" json:"cmd,omitempty"`
	Expect string `yaml:"expect" json:"expect,omitempty"`
	Note   string `yaml:"note" json:"note,omitempty"`
}

type OpsFault struct {
	Title   string   `yaml:"title" json:"title"`
	When    string   `yaml:"when" json:"when,omitempty"`
	Symptom string   `yaml:"symptom" json:"symptom,omitempty"`
	Steps   []string `yaml:"steps" json:"steps"`
	Cmd     string   `yaml:"cmd" json:"cmd,omitempty"`
}

type NamedText struct {
	Name string `yaml:"name" json:"name"`
	Text string `yaml:"text" json:"text"`
}

// Preset is a ready-made starting point shown as a plan card.
type Preset struct {
	Contract *SeriesContract `yaml:"contract" json:"contract,omitempty"`
	ID       string          `yaml:"id" json:"id"`
	Name     string          `yaml:"name" json:"name"`
	Tag      string          `yaml:"tag" json:"tag,omitempty"`
	Spec     string          `yaml:"spec" json:"spec,omitempty"`
	Roles    []RoleCount     `yaml:"roles" json:"roles"`
	Params   map[string]any  `yaml:"params" json:"params,omitempty"`
}

type RoleCount struct {
	Role  string `yaml:"role" json:"role"`
	Count int    `yaml:"count" json:"count"`
}

// Overlay is everything a version may add to or override on top of the component, or on top of the version it extends.
// Lists are merged by key, so a version only writes what differs.
type Overlay struct {
	Roles     []RoleSpec        `yaml:"roles" json:"roles,omitempty"`
	Flows     []FlowSpec        `yaml:"flows" json:"flows,omitempty"`
	Requires  []Require         `yaml:"requires" json:"requires,omitempty"`
	Groups    []Group           `yaml:"groups" json:"groups,omitempty"`
	Params    []Param           `yaml:"params" json:"params,omitempty"`
	Rules     []Rule            `yaml:"rules" json:"rules,omitempty"`
	Ports     []PortSpec        `yaml:"ports" json:"ports,omitempty"`
	Endpoints []Endpoint        `yaml:"endpoints" json:"endpoints,omitempty"`
	Secrets   []SecretSpec      `yaml:"secrets" json:"secrets,omitempty"`
	Inputs    []Input           `yaml:"inputs" json:"inputs,omitempty"`
	Lifecycle map[string][]Step `yaml:"lifecycle" json:"lifecycle,omitempty"`
	Tests     []Step            `yaml:"tests" json:"tests,omitempty"`
	Cleanup []Step            `yaml:"cleanup" json:"cleanup,omitempty"`
	Addons  *AddonSet         `yaml:"addons" json:"addons,omitempty"`
	// LB describes what a load balancer implementation can do; only components providing l4-lb set it.
	LB *LBSpec `yaml:"lb" json:"lb,omitempty"`
}

// Version is one installable release of the component.
type Version struct {
	ID                string   `yaml:"id" json:"id"`
	Extends           string   `yaml:"extends" json:"extends,omitempty"`
	Status            string   `yaml:"status" json:"status"` // draft | verifying | published
	VerifiedPlatforms []string `yaml:"verified_platforms,omitempty" json:"verified_platforms,omitempty"`
	// Released and Notes say what this version brings, for people choosing whether to upgrade to it.
	Released  string     `yaml:"released" json:"released,omitempty"`
	Notes     []string   `yaml:"notes" json:"notes,omitempty"`
	Platforms []string   `yaml:"platforms" json:"platforms,omitempty"`
	Packages  []Package  `yaml:"packages" json:"packages,omitempty"`
	Artifacts []Artifact `yaml:"artifacts" json:"artifacts,omitempty"`
	Overlay   `yaml:",inline"`
	Remove    Remove `yaml:"remove" json:"remove,omitempty"`
}

// Remove drops inherited entries by key.
type Remove struct {
	Roles     []string `yaml:"roles" json:"roles,omitempty"`
	Requires  []string `yaml:"requires" json:"requires,omitempty"`
	Params    []string `yaml:"params" json:"params,omitempty"`
	Rules     []string `yaml:"rules" json:"rules,omitempty"`
	Ports     []string `yaml:"ports" json:"ports,omitempty"`
	Endpoints []string `yaml:"endpoints" json:"endpoints,omitempty"`
	Secrets   []string `yaml:"secrets" json:"secrets,omitempty"`
	Inputs    []string `yaml:"inputs" json:"inputs,omitempty"`
	Tests     []string `yaml:"tests" json:"tests,omitempty"`
	Cleanup   []string `yaml:"cleanup" json:"cleanup,omitempty"`
	Steps     []string `yaml:"steps" json:"steps,omitempty"` // "phase/id"
}

// Package is one exact package version a component needs. Versions are always pinned so a delivery can be
// reproduced; the platform's package library supplies the files.
type Package struct {
	Name      string   `yaml:"name" json:"name"`
	Version   string   `yaml:"version" json:"version"`
	Platforms []string `yaml:"platforms" json:"platforms,omitempty"` // empty means every platform of the version
	When      string   `yaml:"when" json:"when,omitempty"`           // expression over params/roles
}

// Artifact is a plain offline file the delivery must carry (not a package; packages come from the package library).
type Artifact struct {
	Name   string `yaml:"name" json:"name"`
	Kind   string `yaml:"kind" json:"kind"` // file
	File   string `yaml:"file" json:"file"`
	SHA256 string `yaml:"sha256" json:"sha256,omitempty"`
	When   string `yaml:"when" json:"when,omitempty"`
}

// FlowSpec declares how data or traffic moves between the roles of one instance, so the plan can be drawn as a
// picture of connected machines. It never influences generation.
type FlowSpec struct {
	ID    string `yaml:"id" json:"id"`
	Title string `yaml:"title" json:"title"`
	// From and To are roles of the instance. From == To means the members of that role talk to each other.
	From string `yaml:"from" json:"from"`
	To   string `yaml:"to" json:"to"`
	// Kind picks the picture: replication (one way data stream), mesh (members of one role talk to each other).
	Kind string `yaml:"kind" json:"kind"`
	// When is an expression; the flow exists only while it is true. Sync is true when the flow is acknowledged
	// before the sender continues (synchronous replication, consensus).
	When string `yaml:"when" json:"when,omitempty"`
	Sync string `yaml:"sync" json:"sync,omitempty"`
}

type RoleSpec struct {
	Name  string `yaml:"name" json:"name"`
	Title string `yaml:"title" json:"title,omitempty"`
	Min   int    `yaml:"min" json:"min"`
	// Max is a hard upper bound, only for real rules (a database has exactly one primary); 0 means unbounded.
	Max int `yaml:"max" json:"max"`
	// Advise is a size above which a deployment works but is usually a mistake; the form warns with AdviseWhy.
	Advise    int    `yaml:"advise" json:"advise,omitempty"`
	AdviseWhy string `yaml:"advise_why" json:"advise_why,omitempty"`
	// Default is the number of machines an unconfigured deployment starts with.
	Default int `yaml:"default" json:"default,omitempty"`
	// Odd asks for an odd count (quorum members); even counts are allowed with a warning.
	Odd bool `yaml:"odd" json:"odd,omitempty"`
	// Exclusive roles cannot share a machine with another role of the same instance (primary and replica).
	Exclusive bool `yaml:"exclusive" json:"exclusive,omitempty"`
	// Initial marks the role whose first machine is bootstrapped first (initial primary, seed node).
	Initial bool `yaml:"initial" json:"initial,omitempty"`
}

// Require declares a dependency on a capability. It is only active when When is true.
type Require struct {
	Capability string `yaml:"capability" json:"capability"`
	When       string `yaml:"when" json:"when,omitempty"`
	// DefaultImpl is the component added automatically when the deployment does not supply a provider.
	DefaultImpl string `yaml:"default_impl" json:"default_impl,omitempty"`
	// Placement of the automatically added provider: same_hosts (default) puts it on every machine of the requirer.
	Placement string `yaml:"placement" json:"placement,omitempty"`
	// With sets params of the automatically added provider; values starting with "=" are expressions.
	With    map[string]any `yaml:"with" json:"with,omitempty"`
	Version string         `yaml:"version" json:"version,omitempty"` // required version of the provider, e.g. ">=3.4"
	Title   string         `yaml:"title" json:"title,omitempty"`
}

type CompanionSpec struct {
	ID         string `yaml:"id" json:"id"`
	Component  string `yaml:"component" json:"component"`
	When       string `yaml:"when" json:"when"`
	Capability string `yaml:"capability" json:"capability"`
}

type Group struct {
	ID    string `yaml:"id" json:"id"`
	Label string `yaml:"label" json:"label"`
	Scope string `yaml:"scope" json:"scope,omitempty"`
	Tab   string `yaml:"tab" json:"tab,omitempty"`
}

// Param is one tunable of an instance. Values starting with "=" in Default are expressions.
type Param struct {
	Key      string   `yaml:"key" json:"key"`
	Group    string   `yaml:"group" json:"group,omitempty"`
	Label    string   `yaml:"label" json:"label"`
	Type     string   `yaml:"type" json:"type"` // int float bool enum string size port cidr cidr-list ip host
	Default  any      `yaml:"default" json:"default,omitempty"`
	Min      any      `yaml:"min" json:"min,omitempty"`
	Max      any      `yaml:"max" json:"max,omitempty"`
	Unit     string   `yaml:"unit" json:"unit,omitempty"`
	Options  []string `yaml:"options" json:"options,omitempty"`
	Pattern  string   `yaml:"pattern" json:"pattern,omitempty"`
	Hint     string   `yaml:"hint" json:"hint,omitempty"`
	Required bool     `yaml:"required" json:"required,omitempty"`
	Restart  bool     `yaml:"restart" json:"restart,omitempty"`
	Advanced bool     `yaml:"advanced" json:"advanced,omitempty"`
	// When is an expression; the parameter is only shown and validated while it is true.
	When string `yaml:"when" json:"when,omitempty"`
	// Locked values are derived (for example by an add-on) and cannot be edited.
	Locked bool `yaml:"locked" json:"locked,omitempty"`
}

// Rule is a cross-field check: Expr must be true, otherwise Message is reported.
type Rule struct {
	ID      string `yaml:"id" json:"id"`
	Expr    string `yaml:"expr" json:"expr"`
	Message string `yaml:"message" json:"message"`
	Warn    bool   `yaml:"warn" json:"warn,omitempty"`
}

// PortSpec names a listening port for conflict detection; Value may be an expression.
type PortSpec struct {
	Name  string   `yaml:"name" json:"name"`
	Value any      `yaml:"value" json:"value"`
	Proto string   `yaml:"proto" json:"proto,omitempty"`
	Roles []string `yaml:"roles" json:"roles,omitempty"` // empty means every role
	When  string   `yaml:"when" json:"when,omitempty"`
}

// Endpoint is the contract a component offers to whatever sits in front of it.
type Endpoint struct {
	Name     string   `yaml:"name" json:"name"`
	Title    string   `yaml:"title" json:"title,omitempty"`
	Protocol string   `yaml:"protocol" json:"protocol"` // tcp | http
	Port     any      `yaml:"port" json:"port"`
	Backends []string `yaml:"backends" json:"backends"` // roles whose machines are backends
	// When selects this definition; several endpoints may share a name when their conditions exclude each other
	// (a single node answers on tcp, a Patroni cluster answers /primary).
	When   string `yaml:"when" json:"when,omitempty"`
	Health Health `yaml:"health" json:"health"`
	// LB: allowed | discouraged | none
	LB   string `yaml:"lb" json:"lb,omitempty"`
	Note string `yaml:"note" json:"note,omitempty"`
}

type Health struct {
	Type   string `yaml:"type" json:"type"` // tcp | http | tcp-script
	Port   any    `yaml:"port" json:"port,omitempty"`
	Path   string `yaml:"path" json:"path,omitempty"`
	Status int    `yaml:"status" json:"status,omitempty"`
	Send   string `yaml:"send" json:"send,omitempty"`
	Expect string `yaml:"expect" json:"expect,omitempty"`
}

// LBSpec lists what a load balancer implementation can honour.
type LBSpec struct {
	Protocols []string `yaml:"protocols" json:"protocols"`
	Health    []string `yaml:"health" json:"health"`
}

type SecretSpec struct {
	Name   string `yaml:"name" json:"name"`
	Length int    `yaml:"length" json:"length,omitempty"`
	When   string `yaml:"when" json:"when,omitempty"`
}

// Input is a file the user must supply (certificates). The platform validates it by Kind.
type Input struct {
	Name  string `yaml:"name" json:"name"`
	Label string `yaml:"label" json:"label"`
	Kind  string `yaml:"kind" json:"kind"` // tls-bundle
	When  string `yaml:"when" json:"when,omitempty"`
}

// Step is one reviewable unit of work. It becomes a play (lifecycle), a stand-alone playbook (tests, cleanup)
// and a numbered entry in the handbook, so these three can never drift apart.
type Step struct {
	Inputs map[string]StepInput `yaml:"inputs" json:"inputs,omitempty"`
	// Conditions are checked by the platform before/after the implementation.
	// They use Ansible expressions and must evaluate to true on each selected host.
	Preconditions  []string `yaml:"preconditions" json:"preconditions,omitempty"`
	Postconditions []string `yaml:"postconditions" json:"postconditions,omitempty"`
	ID             string   `yaml:"id" json:"id"`
	Title          string   `yaml:"title" json:"title"`
	Desc           string   `yaml:"desc" json:"desc,omitempty"`
	Effect         string   `yaml:"effect" json:"effect,omitempty"` // read-only | change | disruptive | destructive
	Expect         string   `yaml:"expect" json:"expect,omitempty"`
	When           string   `yaml:"when" json:"when,omitempty"`
	// Skip is shown in the handbook when When is false.
	Skip string `yaml:"skip" json:"skip,omitempty"`
	// Hosts selects machines: all, a role, "a,b" for several roles, or "first:<role>".
	Hosts  string `yaml:"hosts" json:"hosts,omitempty"`
	Serial int    `yaml:"serial" json:"serial,omitempty"`
	// Scope "endpoint:<name>" runs only when that endpoint has a front (load balancer) bound.
	Scope string `yaml:"scope" json:"scope,omitempty"`
	// Exactly one of Run (a role task file) or Tasks (inline Ansible tasks restricted to ansible.builtin modules).
	Run     *RunRef          `yaml:"run" json:"run,omitempty"`
	Tasks   []map[string]any `yaml:"tasks" json:"tasks,omitempty"`
	Timeout int              `yaml:"timeout" json:"timeout,omitempty"`
	// Extra confirmation variables the handbook command carries, beyond the cluster id.
	Confirm []string `yaml:"confirm" json:"confirm,omitempty"`
	// Rollback says how to undo the step when something goes wrong after it, for the people on site: the commands or
	// the way back, or that it cannot be undone and why. It may name ${cluster}, ${instance} and ${params.<key>}.
	Rollback string `yaml:"rollback" json:"rollback,omitempty"`
}

type RunRef struct {
	Role  string         `yaml:"role" json:"role"`
	Tasks string         `yaml:"tasks" json:"tasks"` // task file inside the role, without .yml
	Vars  map[string]any `yaml:"vars" json:"vars,omitempty"`
}

// StepInput is a named, typed value exposed only through mw_step_inputs.
// Values can be literals or Ansible expressions evaluated for the target host.
type StepInput struct {
	Type  string `yaml:"type" json:"type"`
	Value any    `yaml:"value" json:"value"`
}

// AddonSet describes optional enhancements that act on sub-objects of an instance (database extensions).
type AddonSet struct {
	Kind  string     `yaml:"kind" json:"kind"`
	Scope AddonScope `yaml:"scope" json:"scope"`
	Items []Addon    `yaml:"items" json:"items"`
}

type AddonScope struct {
	Name     string   `yaml:"name" json:"name"` // database
	Defaults []string `yaml:"defaults" json:"defaults,omitempty"`
}

type Addon struct {
	ID        string     `yaml:"id" json:"id"`
	Title     string     `yaml:"title" json:"title,omitempty"`
	Contrib   bool       `yaml:"contrib" json:"contrib,omitempty"`
	Builtin   bool       `yaml:"builtin" json:"builtin,omitempty"`
	Restart   bool       `yaml:"restart" json:"restart,omitempty"`
	Artifacts []Artifact `yaml:"artifacts" json:"artifacts,omitempty"`
	Params    []Param    `yaml:"params" json:"params,omitempty"`
	// SetParams are instance params the add-on forces, e.g. shared_preload_libraries.
	SetParams map[string]any `yaml:"set_params" json:"set_params,omitempty"`
	Since     string         `yaml:"since" json:"since,omitempty"`
	Until     string         `yaml:"until" json:"until,omitempty"`
}

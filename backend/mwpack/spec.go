package mwpack

import (
	"bytes"
	"encoding/json"
	"fmt"

	"gopkg.in/yaml.v3"
)

// ImportedPkg records a software package detected on or declared for an imported brownfield cluster.
type ImportedPkg struct {
	Name    string `yaml:"name" json:"name"`
	Version string `yaml:"version" json:"version"`
	Role    string `yaml:"role,omitempty" json:"role,omitempty"` // primary | dependency
}

// ImportedEndpoint records an access endpoint (VIP, LB, DNS, or host:port) for an imported cluster.
type ImportedEndpoint struct {
	Name    string `yaml:"name,omitempty" json:"name,omitempty"`
	Address string `yaml:"address" json:"address"`               // e.g. vip:5432 or host:3306
	Role    string `yaml:"role,omitempty" json:"role,omitempty"` // readwrite | readonly | admin
}

// ImportedCompanion records a co-located or supporting component detected alongside
// the primary middleware (e.g. Patroni, etcd, HAProxy, Keepalived, PgBouncer,
// pgBackRest, Redis Sentinel, ZooKeeper, ClickHouse Keeper, ProxySQL, OBProxy).
type ImportedCompanion struct {
	Component    string              `yaml:"component" json:"component"`
	DisplayName  string              `yaml:"display_name,omitempty" json:"display_name,omitempty"`
	Icon         string              `yaml:"icon,omitempty" json:"icon,omitempty"`
	Color        string              `yaml:"color,omitempty" json:"color,omitempty"`
	Version      string              `yaml:"version,omitempty" json:"version,omitempty"`
	Kind         string              `yaml:"kind,omitempty" json:"kind,omitempty"` // ha_manager | dcs | proxy | vip | pooler | backup | monitoring | companion
	Role         string              `yaml:"role,omitempty" json:"role,omitempty"` // default role when Placement is empty
	Hosts        []string            `yaml:"hosts,omitempty" json:"hosts,omitempty"`
	Placement    map[string][]string `yaml:"placement,omitempty" json:"placement,omitempty"`
	Ports        []int               `yaml:"ports,omitempty" json:"ports,omitempty"`
	ServiceUnits []string            `yaml:"service_units,omitempty" json:"service_units,omitempty"`
	ConfigPaths  []string            `yaml:"config_paths,omitempty" json:"config_paths,omitempty"`
	DataDirs     []string            `yaml:"data_dirs,omitempty" json:"data_dirs,omitempty"`
	Evidence     string              `yaml:"evidence,omitempty" json:"evidence,omitempty"`
	Inferred     bool                `yaml:"inferred,omitempty" json:"inferred,omitempty"`
}

// ImportedMeta holds onboarding provenance and runtime baseline details for brownfield clusters
// onboarded without initial platform deployment (DeliveryMode == "imported").
type ImportedMeta struct {
	SourceKind        string              `yaml:"source_kind,omitempty" json:"source_kind,omitempty"` // manual | probe | ai_doc
	ManagedCatalog    bool                `yaml:"managed_catalog,omitempty" json:"managed_catalog,omitempty"`
	DisplayName       string              `yaml:"display_name,omitempty" json:"display_name,omitempty"`
	Category          string              `yaml:"category,omitempty" json:"category,omitempty"`
	Icon              string              `yaml:"icon,omitempty" json:"icon,omitempty"`
	Color             string              `yaml:"color,omitempty" json:"color,omitempty"`
	DeployMethod      string              `yaml:"deploy_method,omitempty" json:"deploy_method,omitempty"` // systemd | docker | binary | k8s | other
	ArchSummary       string              `yaml:"arch_summary,omitempty" json:"arch_summary,omitempty"`
	ExactVersion      string              `yaml:"exact_version,omitempty" json:"exact_version,omitempty"`
	OSDetail          string              `yaml:"os_detail,omitempty" json:"os_detail,omitempty"`
	ServiceUnits      []string            `yaml:"service_units,omitempty" json:"service_units,omitempty"`
	ConfigPaths       []string            `yaml:"config_paths,omitempty" json:"config_paths,omitempty"`
	DataDirs          []string            `yaml:"data_dirs,omitempty" json:"data_dirs,omitempty"`
	LogDirs           []string            `yaml:"log_dirs,omitempty" json:"log_dirs,omitempty"`
	Endpoints         []ImportedEndpoint  `yaml:"endpoints,omitempty" json:"endpoints,omitempty"`
	Companions        []ImportedCompanion `yaml:"companions,omitempty" json:"companions,omitempty"`
	Packages          []ImportedPkg       `yaml:"packages,omitempty" json:"packages,omitempty"`
	Notes             string              `yaml:"notes,omitempty" json:"notes,omitempty"`
	DismissedGaps     []string            `yaml:"dismissed_gaps,omitempty" json:"dismissed_gaps,omitempty"`
	LastProbedAt      string              `yaml:"last_probed_at,omitempty" json:"last_probed_at,omitempty"`
	BaselineUpdatedAt string              `yaml:"baseline_updated_at,omitempty" json:"baseline_updated_at,omitempty"`
	BaselineUpdatedBy string              `yaml:"baseline_updated_by,omitempty" json:"baseline_updated_by,omitempty"`
}

// Deployment is what an implementer fills in (through the form or as YAML) for one customer cluster.
type Deployment struct {
	// ExecutionHost is an independent control machine, never a component/data target.
	// When absent the historical Controller-in-Hosts behaviour is preserved.
	ExecutionHost *ExecutionHost `yaml:"execution_host,omitempty" json:"execution_host,omitempty"`
	DeliveryMode  string         `yaml:"delivery_mode,omitempty" json:"delivery_mode,omitempty"`
	Imported      *ImportedMeta  `yaml:"imported,omitempty" json:"imported,omitempty"`
	Schema        string         `yaml:"schema" json:"schema"`
	ID            string         `yaml:"id" json:"id"`
	Title         string         `yaml:"title" json:"title,omitempty"`
	// Controller is the machine that runs Ansible; it defaults to the first host.
	Controller string `yaml:"controller" json:"controller,omitempty"`
	// Platform is the operating system of every machine; empty means the first one all components support.
	Platform  string         `yaml:"platform" json:"platform,omitempty"`
	Hosts     []Host         `yaml:"hosts" json:"hosts"`
	Instances []InstanceSpec `yaml:"instances" json:"instances"`
}

type ExecutionHost struct {
	Name           string `yaml:"name" json:"name"`
	IP             string `yaml:"ip" json:"ip"`
	RepositoryPort int    `yaml:"repository_port" json:"repository_port"`
}

type Host struct {
	Params map[string]any `yaml:"params,omitempty" json:"params,omitempty"`
	Name   string         `yaml:"name" json:"name"`
	IP     string         `yaml:"ip" json:"ip"`
	// Disk and Partition describe the data device mounted at /data. Initialize formats it (empty disks only).
	Disk       string `yaml:"disk" json:"disk,omitempty"`
	Partition  string `yaml:"partition" json:"partition,omitempty"`
	Initialize bool   `yaml:"initialize" json:"initialize,omitempty"`
}

// InstanceSpec places one component. Placement maps a role to machines; "external" instances have none.
type InstanceSpec struct {
	ID        string              `yaml:"id" json:"id"`
	Component string              `yaml:"component" json:"component"`
	Version   string              `yaml:"version" json:"version"`
	Placement map[string][]string `yaml:"placement" json:"placement,omitempty"`
	Params    map[string]any      `yaml:"params" json:"params,omitempty"`
	// Uses pins a required capability to a specific instance of the same deployment.
	Uses   map[string]string `yaml:"uses" json:"uses,omitempty"`
	Binds  []BindSpec        `yaml:"binds" json:"binds,omitempty"`
	Addons []AddonSel        `yaml:"addons" json:"addons,omitempty"`
}

// BindSpec makes a load balancer instance front an endpoint of another instance.
type BindSpec struct {
	Endpoint string `yaml:"endpoint" json:"endpoint"` // "<instance>.<endpoint>"
	Listen   int    `yaml:"listen" json:"listen,omitempty"`
	Name     string `yaml:"name" json:"name,omitempty"`
}

type AddonSel struct {
	ID        string         `yaml:"id" json:"id"`
	Databases []string       `yaml:"databases" json:"databases,omitempty"`
	Params    map[string]any `yaml:"params" json:"params,omitempty"`
}

const (
	ComponentSchema  = "mwpack/v1"
	DeploymentSchema = "mwdeploy/v1"
	AnsibleV2Schema  = "studio/v2"
)

// ParseDeployment reads a deployment from YAML or JSON (JSON is valid YAML).
func ParseDeployment(data []byte) (*Deployment, error) {
	var d Deployment
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&d); err != nil {
		return nil, fmt.Errorf("部署规格无法解析：%v", err)
	}
	if d.Schema == "" {
		d.Schema = DeploymentSchema
	}
	if d.Schema != DeploymentSchema {
		return nil, fmt.Errorf("不支持的规格版本 %q，需要 %s", d.Schema, DeploymentSchema)
	}
	return &d, nil
}

// ParseSavedDeployment reads an already-persisted deployment.yml from disk,
// supporting both v1 (ignoring retired historical keys) and studio/v2 native Ansible deployments.
func ParseSavedDeployment(data []byte) (*Deployment, error) {
	if d, err := ParseDeployment(data); err == nil {
		return d, nil
	}
	var v2 Deployment
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&v2); err == nil && v2.Schema == AnsibleV2Schema {
		return &v2, nil
	}
	var raw map[string]any
	if err := yaml.Unmarshal(data, &raw); err == nil && raw != nil {
		delete(raw, "change")
		delete(raw, "pins")
		delete(raw, "derived_from")
		if cleaned, err := yaml.Marshal(raw); err == nil {
			return ParseDeployment(cleaned)
		}
	}
	return ParseDeployment(data)
}

// YAML renders the deployment for export.
func (d *Deployment) YAML() ([]byte, error) {
	var b bytes.Buffer
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(2)
	if err := enc.Encode(d); err != nil {
		return nil, err
	}
	return b.Bytes(), enc.Close()
}

func (d *Deployment) JSON() []byte {
	b, _ := json.MarshalIndent(d, "", "  ")
	return append(b, '\n')
}

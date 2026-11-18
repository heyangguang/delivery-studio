package mwpack

import (
	"bytes"
	"encoding/json"
	"fmt"

	"gopkg.in/yaml.v3"
)

// Deployment is what an implementer fills in (through the form or as YAML) for one customer cluster.
type Deployment struct {
	// ExecutionHost is an independent control machine, never a component/data target.
	// When absent the historical Controller-in-Hosts behaviour is preserved.
	ExecutionHost *ExecutionHost `yaml:"execution_host,omitempty" json:"execution_host,omitempty"`
	DeliveryMode  string         `yaml:"delivery_mode,omitempty" json:"delivery_mode,omitempty"`
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
// ignoring retired historical keys (change, pins, derived_from) written by older releases.
func ParseSavedDeployment(data []byte) (*Deployment, error) {
	if d, err := ParseDeployment(data); err == nil {
		return d, nil
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

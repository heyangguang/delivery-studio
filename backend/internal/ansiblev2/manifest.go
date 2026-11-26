package ansiblev2

import (
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	SchemaVersion    = "studio/v2"
	ManifestFileName = "delivery-studio.yaml"
)

// AssetKind classifies any incoming Ansible artifact supported natively by Delivery Studio 2.0.
type AssetKind string

const (
	AssetSinglePlaybook    AssetKind = "single_playbook"
	AssetAnsibleRole       AssetKind = "ansible_role"
	AssetAnsibleCollection AssetKind = "ansible_collection"
	AssetPlaybookProject   AssetKind = "playbook_project"
)

// Manifest is the ultra-thin, optional platform adapter descriptor (delivery-studio.yaml)
// that sits alongside a 100% standard, standalone-runnable Ansible project/role/collection.
// Everything that Ansible itself declares (hosts groups, playbooks, defaults/main.yml,
// meta/argument_specs.yml, galaxy.yml, package tasks) is auto-discovered without duplication.
type Manifest struct {
	Schema        string         `yaml:"schema" json:"schema"`
	Name          string         `yaml:"name" json:"name"`
	Title         string         `yaml:"title" json:"title"`
	TitleEn       string         `yaml:"title_en,omitempty" json:"title_en,omitempty"`
	Category      string         `yaml:"category,omitempty" json:"category,omitempty"`
	Version       string         `yaml:"version,omitempty" json:"version,omitempty"`
	Summary       string         `yaml:"summary,omitempty" json:"summary,omitempty"`
	SummaryEn     string         `yaml:"summary_en,omitempty" json:"summary_en,omitempty"`
	Icon          string         `yaml:"icon,omitempty" json:"icon,omitempty"`
	Color         string         `yaml:"color,omitempty" json:"color,omitempty"`
	AssetKind     AssetKind      `yaml:"asset_kind,omitempty" json:"asset_kind,omitempty"`
	Source        string         `yaml:"source,omitempty" json:"source,omitempty"`
	DeliveryModes []string       `yaml:"delivery_modes,omitempty" json:"delivery_modes,omitempty"`
	Entrypoints   Entrypoints    `yaml:"entrypoints" json:"entrypoints"`
	Groups        []GroupSpec    `yaml:"groups,omitempty" json:"groups,omitempty"`
	Schemes       []SchemeSpec   `yaml:"schemes,omitempty" json:"schemes,omitempty"`
	Vars          []VarSpec      `yaml:"vars,omitempty" json:"vars,omitempty"`
	Packages      []PackageHint  `yaml:"packages,omitempty" json:"packages,omitempty"`
	Ports         []PortSpec     `yaml:"ports,omitempty" json:"ports,omitempty"`
	Secrets       []string       `yaml:"secrets,omitempty" json:"secrets,omitempty"`
	Tags          []string       `yaml:"tags,omitempty" json:"tags,omitempty"`
}

// Entrypoints point to standard Ansible playbooks inside the component tree.
type Entrypoints struct {
	Deploy  string `yaml:"deploy" json:"deploy"`
	Verify  string `yaml:"verify,omitempty" json:"verify,omitempty"`
	Probe   string `yaml:"probe,omitempty" json:"probe,omitempty"`
	Cleanup string `yaml:"cleanup,omitempty" json:"cleanup,omitempty"`
}

// GroupSpec maps directly to a standard Ansible inventory group under all.children.<name>.
type GroupSpec struct {
	Name         string `yaml:"name" json:"name"`
	Title        string `yaml:"title,omitempty" json:"title,omitempty"`
	TitleEn      string `yaml:"title_en,omitempty" json:"title_en,omitempty"`
	Description  string `yaml:"description,omitempty" json:"description,omitempty"`
	Min          int    `yaml:"min,omitempty" json:"min,omitempty"`
	Max          int    `yaml:"max,omitempty" json:"max,omitempty"`
	DefaultCount int    `yaml:"default_count,omitempty" json:"default_count,omitempty"`
	Exclusive    bool   `yaml:"exclusive,omitempty" json:"exclusive,omitempty"`
}

// SchemeSpec defines a topology/variable preset (e.g. single node vs HA) purely in terms of
// standard Ansible group sizes and standard group_vars overrides.
type SchemeSpec struct {
	ID          string         `yaml:"id" json:"id"`
	Title       string         `yaml:"title" json:"title"`
	TitleEn     string         `yaml:"title_en,omitempty" json:"title_en,omitempty"`
	Summary     string         `yaml:"summary,omitempty" json:"summary,omitempty"`
	GroupCounts map[string]int `yaml:"group_counts,omitempty" json:"group_counts,omitempty"`
	Vars        map[string]any `yaml:"vars,omitempty" json:"vars,omitempty"`
}

// VarSpec describes a standard Ansible variable (auto-extracted from meta/argument_specs.yml,
// defaults/main.yml, group_vars/all.yml, or declared explicitly in delivery-studio.yaml).
type VarSpec struct {
	Key         string   `yaml:"key" json:"key"`
	Label       string   `yaml:"label,omitempty" json:"label,omitempty"`
	LabelEn     string   `yaml:"label_en,omitempty" json:"label_en,omitempty"`
	Group       string   `yaml:"group,omitempty" json:"group,omitempty"`
	Type        string   `yaml:"type,omitempty" json:"type,omitempty"` // string | int | bool | select | list | dict | secret | port
	Default     any      `yaml:"default,omitempty" json:"default,omitempty"`
	Required    bool     `yaml:"required,omitempty" json:"required,omitempty"`
	Choices     []string `yaml:"choices,omitempty" json:"choices,omitempty"`
	Description string   `yaml:"description,omitempty" json:"description,omitempty"`
	Source      string   `yaml:"source,omitempty" json:"source,omitempty"` // argument_specs | defaults | group_vars | manifest
}

// PackageHint declares or auto-discovers OS packages needed for air-gapped repository bundling.
type PackageHint struct {
	Name         string   `yaml:"name" json:"name"`
	Platforms    []string `yaml:"platforms,omitempty" json:"platforms,omitempty"`
	DetectedFrom string   `yaml:"detected_from,omitempty" json:"detected_from,omitempty"`
}

// PortSpec documents a service listening port (literal or bound to an Ansible variable name).
type PortSpec struct {
	Name     string `yaml:"name" json:"name"`
	Var      string `yaml:"var,omitempty" json:"var,omitempty"`
	Port     int    `yaml:"port,omitempty" json:"port,omitempty"`
	Protocol string `yaml:"protocol,omitempty" json:"protocol,omitempty"`
}

// PlayStep represents a concrete executable step parsed directly from an Ansible playbook's plays/tags.
type PlayStep struct {
	ID       string   `json:"id"`
	Phase    string   `json:"phase"` // deploy | verify | probe | cleanup
	Playbook string   `json:"playbook"`
	PlayName string   `json:"play_name"`
	Hosts    string   `json:"hosts"`
	Tag      string   `json:"tag,omitempty"`
	Title    string   `json:"title"`
	Effect   string   `json:"effect"` // read-only | change
	Command  string   `json:"command"`
}

// Problem is a structured lint / validation finding.
type Problem struct {
	Severity string `json:"severity"` // error | warning
	Path     string `json:"path,omitempty"`
	Message  string `json:"message"`
}

// InspectionReport is the complete auto-analysis result of any Ansible artifact.
type InspectionReport struct {
	AssetKind       AssetKind       `json:"asset_kind"`
	Manifest        Manifest        `json:"manifest"`
	ManifestYAML    string          `json:"manifest_yaml"`
	ManifestAutoGen bool            `json:"manifest_auto_generated"`
	Playbooks       []string        `json:"playbooks"`
	Roles           []string        `json:"roles"`
	Requirements    []string        `json:"requirements,omitempty"`
	Steps           []PlayStep      `json:"steps"`
	Vars            []VarSpec       `json:"vars"`
	Packages        []PackageHint   `json:"packages"`
	Problems        []Problem       `json:"problems"`
	FileCount       int             `json:"file_count"`
	Valid           bool            `json:"valid"`
}

var validComponentNameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

// SanitizeName converts any repo/folder/role name into a valid component slug.
func SanitizeName(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.TrimSuffix(s, ".git")
	s = strings.TrimSuffix(s, ".tar.gz")
	s = strings.TrimSuffix(s, ".tgz")
	s = strings.TrimSuffix(s, ".zip")
	s = strings.TrimSuffix(s, ".yaml")
	s = strings.TrimSuffix(s, ".yml")
	for _, prefix := range []string{"ansible-role-", "ansible-collection-", "ansible-playbook-", "ansible-"} {
		if strings.HasPrefix(s, prefix) && len(s) > len(prefix) {
			s = strings.TrimPrefix(s, prefix)
		}
	}
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			prevDash = false
		} else if !prevDash && b.Len() > 0 {
			b.WriteByte('-')
			prevDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "ansible-app"
	}
	if out[0] < 'a' || out[0] > 'z' {
		out = "app-" + out
	}
	if len(out) > 63 {
		out = strings.TrimRight(out[:63], "-")
	}
	return out
}

// ValidComponentName checks whether name is a valid Studio v2 component identifier.
func ValidComponentName(name string) bool {
	return validComponentNameRe.MatchString(name)
}

// ParseManifest parses a delivery-studio.yaml payload.
func ParseManifest(data []byte) (Manifest, error) {
	var m Manifest
	if err := yaml.Unmarshal(data, &m); err != nil {
		return m, fmt.Errorf("解析 %s 失败: %w", ManifestFileName, err)
	}
	if strings.TrimSpace(m.Schema) == "" {
		m.Schema = SchemaVersion
	}
	if len(m.DeliveryModes) == 0 {
		m.DeliveryModes = []string{"offline", "automatic"}
	}
	return m, nil
}

// MarshalManifest renders a clean, minimal, human-readable delivery-studio.yaml.
func MarshalManifest(m Manifest) (string, error) {
	if strings.TrimSpace(m.Schema) == "" {
		m.Schema = SchemaVersion
	}
	if len(m.DeliveryModes) == 0 {
		m.DeliveryModes = []string{"offline", "automatic"}
	}
	var buf strings.Builder
	buf.WriteString("# Kyndryl Delivery Studio 2.0 — Native Ansible Component Descriptor\n")
	buf.WriteString("# 标准 Ansible 工程无需魔改即可独立运行；此文件仅声明入口 Playbook、分组与 UI 展示元数据。\n")
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&m); err != nil {
		return "", err
	}
	_ = enc.Close()
	return buf.String(), nil
}

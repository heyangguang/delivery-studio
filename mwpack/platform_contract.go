package mwpack

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"gopkg.in/yaml.v3"
	"io/fs"
	"math"
	"path"
	"regexp"
	"strings"
)

const PlatformContractPath = "manifest/host-parameters.yaml"

type HostParameter struct {
	Key      string       `yaml:"key" json:"key"`
	Label    string       `yaml:"label" json:"label"`
	Type     string       `yaml:"type" json:"type"`
	Default  any          `yaml:"default" json:"default"`
	Required bool         `yaml:"required,omitempty" json:"required,omitempty"`
	Help     string       `yaml:"help,omitempty" json:"help,omitempty"`
	Options  []HostOption `yaml:"options,omitempty" json:"options,omitempty"`
	Min      *float64     `yaml:"min,omitempty" json:"min,omitempty"`
	Max      *float64     `yaml:"max,omitempty" json:"max,omitempty"`
}
type HostOption struct {
	Value string `yaml:"value" json:"value"`
	Label string `yaml:"label" json:"label"`
}
type HostCondition struct {
	Field  string `yaml:"field" json:"field"`
	Equals any    `yaml:"equals" json:"equals"`
}
type HostRule struct {
	ID      string          `yaml:"id" json:"id"`
	When    HostCondition   `yaml:"when" json:"when"`
	Require []HostCondition `yaml:"require,omitempty" json:"require,omitempty"`
	Hide    []string        `yaml:"hide,omitempty" json:"hide,omitempty"`
	Message string          `yaml:"message" json:"message"`
}
type HostContract struct {
	Schema     string          `yaml:"schema" json:"schema"`
	Parameters []HostParameter `yaml:"parameters" json:"parameters"`
	Rules      []HostRule      `yaml:"rules" json:"rules"`
}

func ParseHostContract(b []byte) (*HostContract, error) {
	c := &HostContract{}
	d := yaml.NewDecoder(bytes.NewReader(b))
	d.KnownFields(true)
	if err := d.Decode(c); err != nil {
		return nil, err
	}
	if c.Schema != "mw-host-parameters/v1" {
		return nil, fmt.Errorf("公共参数 schema 必须为 mw-host-parameters/v1")
	}
	if len(c.Parameters) > 64 || len(c.Rules) > 128 {
		return nil, fmt.Errorf("最多64个公共参数、128条规则")
	}
	keys := map[string]HostParameter{}
	re := regexp.MustCompile("^[a-z][a-z0-9_]{0,63}$")
	for _, p := range c.Parameters {
		if !re.MatchString(p.Key) || strings.TrimSpace(p.Label) == "" {
			return nil, fmt.Errorf("参数键或中文名称不合规：%s", p.Key)
		}
		if _, ok := keys[p.Key]; ok {
			return nil, fmt.Errorf("重复参数：%s", p.Key)
		}
		switch p.Type {
		case "string", "path", "bool", "int", "enum":
		default:
			return nil, fmt.Errorf("%s 不支持的类型", p.Key)
		}
		for _, bound := range []*float64{p.Min, p.Max} {
			if bound != nil && (math.IsNaN(*bound) || math.IsInf(*bound, 0) || math.Trunc(*bound) != *bound || p.Type != "int") {
				return nil, fmt.Errorf("%s 范围只支持有限整数", p.Key)
			}
		}
		if p.Min != nil && p.Max != nil && *p.Min > *p.Max {
			return nil, fmt.Errorf("%s 最小值不能大于最大值", p.Key)
		}
		if p.Type == "enum" {
			if len(p.Options) == 0 {
				return nil, fmt.Errorf("%s 缺少选项", p.Key)
			}
			seen := map[string]bool{}
			for _, o := range p.Options {
				if o.Value == "" || o.Label == "" || seen[o.Value] {
					return nil, fmt.Errorf("%s 选项无效或重复", p.Key)
				}
				seen[o.Value] = true
			}
		}
		if p.Default == nil {
			return nil, fmt.Errorf("%s 必须提供默认值以兼容历史交付", p.Key)
		}
		if e := hostValueError(p, p.Default); e != "" {
			return nil, fmt.Errorf("%s 默认值：%s", p.Key, e)
		}
		keys[p.Key] = p
	}
	valid := func(field string, value any) error {
		if strings.HasPrefix(field, "params.") {
			p, ok := keys[strings.TrimPrefix(field, "params.")]
			if !ok {
				return fmt.Errorf("规则引用未知参数 %s", field)
			}
			if e := hostValueError(p, value); e != "" {
				return fmt.Errorf("%s：%s", field, e)
			}
			return nil
		}
		switch field {
		case "disk", "partition":
			if _, ok := value.(string); !ok {
				return fmt.Errorf("%s 要求字符串", field)
			}
		case "initialize":
			if _, ok := value.(bool); !ok {
				return fmt.Errorf("initialize 要求布尔值")
			}
		default:
			return fmt.Errorf("规则不能引用字段 %s", field)
		}
		return nil
	}
	seen := map[string]bool{}
	for _, r := range c.Rules {
		if !re.MatchString(r.ID) || seen[r.ID] || r.Message == "" {
			return nil, fmt.Errorf("规则ID重复、不合规或缺少提示：%s", r.ID)
		}
		seen[r.ID] = true
		if e := valid(r.When.Field, r.When.Equals); e != nil {
			return nil, e
		}
		for _, v := range r.Require {
			if e := valid(v.Field, v.Equals); e != nil {
				return nil, e
			}
		}
		for _, f := range r.Hide {
			found := false
			for _, v := range r.Require {
				if v.Field == f {
					if (f == "initialize" && v.Equals != false) || ((f == "disk" || f == "partition") && v.Equals != "") {
						if f == "initialize" {
							return nil, fmt.Errorf("规则 %s：初始化磁盘（initialize）不能隐藏后自动开启。请将要求值改为关闭（false），或移除隐藏设置。", r.ID)
						}
						return nil, fmt.Errorf("规则 %s：不能隐藏后自动指定磁盘设备 %s，请将要求值清空或移除隐藏设置。", r.ID, f)
					}
					found = true
				}
			}
			if !found {
				return nil, fmt.Errorf("隐藏字段 %s 必须同时声明其兼容值", f)
			}
		}
	}
	hidden := map[string]bool{}
	for _, r := range c.Rules {
		for _, field := range r.Hide {
			hidden[field] = true
		}
	}
	for _, r := range c.Rules {
		if hidden[r.When.Field] {
			return nil, fmt.Errorf("规则条件不能依赖会被自动设置的隐藏字段：%s", r.When.Field)
		}
	}
	return c, nil
}
func hostValueError(p HostParameter, v any) string {
	if v == nil {
		return "不能为null"
	}
	switch p.Type {
	case "bool":
		if _, ok := v.(bool); !ok {
			return "必须是开关值"
		}
	case "string", "path", "enum":
		s, ok := v.(string)
		if !ok {
			return "必须是字符串"
		}
		if p.Type == "path" {
			if !strings.HasPrefix(s, "/") || path.Clean(s) != s || !regexp.MustCompile("^/[A-Za-z0-9_/-]+$").MatchString(s) {
				return "必须是规范的绝对目录路径，不含空格、点号或特殊字符"
			}
			for _, reserved := range []string{"/", "/etc", "/usr", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev", "/run", "/var", "/root", "/home", "/tmp"} {
				if s == reserved || (reserved != "/" && reserved != "/var" && reserved != "/home" && strings.HasPrefix(s, reserved+"/")) {
					return "不能使用系统关键目录"
				}
			}
		}
		if p.Required && strings.TrimSpace(s) == "" {
			return "不能为空"
		}
		if len(s) > 4096 {
			return "最多4096字符"
		}
		if p.Type == "enum" {
			for _, o := range p.Options {
				if o.Value == s {
					return ""
				}
			}
			return "不在允许的选项中"
		}
	case "int":
		switch v.(type) {
		case int, int64, uint64, float64, float32, json.Number:
		default:
			return "必须是整数"
		}
		b, _ := json.Marshal(v)
		var n float64
		if json.Unmarshal(b, &n) != nil || math.Trunc(n) != n {
			return "必须是整数"
		}
		if p.Min != nil && n < *p.Min {
			return "小于最小值"
		}
		if p.Max != nil && n > *p.Max {
			return "超过最大值"
		}
	}
	return ""
}
func (c *Catalog) HostContract() (*HostContract, error) {
	b, e := fs.ReadFile(c.platformFS(), PlatformContractPath)
	if e != nil {
		if errors.Is(e, fs.ErrNotExist) {
			return &HostContract{Schema: "mw-host-parameters/v1", Parameters: []HostParameter{}, Rules: []HostRule{}}, nil
		}
		return nil, e
	}
	return ParseHostContract(b)
}
func hostField(h Host, k string) any {
	switch k {
	case "disk":
		return h.Disk
	case "partition":
		return h.Partition
	case "initialize":
		return h.Initialize
	}
	return h.Params[strings.TrimPrefix(k, "params.")]
}
func hostEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}
func (c *HostContract) Resolve(h Host) (Host, []string) {
	out := h
	out.Params = map[string]any{}
	errors := []string{}
	known := map[string]bool{}
	for _, p := range c.Parameters {
		known[p.Key] = true
		v, ok := h.Params[p.Key]
		if !ok {
			v = p.Default
			// Historical specs predate this field and physically use /data.
			// New forms persist their displayed defaults explicitly.
			if p.Key == "data_root" {
				v = "/data"
			}
		}
		out.Params[p.Key] = v
		if e := hostValueError(p, v); e != "" {
			errors = append(errors, p.Label+"："+e)
		}
	}
	for k := range h.Params {
		if !known[k] {
			errors = append(errors, "未知公共参数："+k)
		}
	}
	for _, r := range c.Rules {
		if hostEqual(hostField(out, r.When.Field), r.When.Equals) {
			for _, v := range r.Require {
				if !hostEqual(hostField(out, v.Field), v.Equals) {
					errors = append(errors, r.Message)
					break
				}
			}
		}
	}
	return out, errors
}

// DataRoot preserves the historical default for specs saved before this contract.
func DataRoot(h Host) string {
	root, _ := h.Params["data_root"].(string)
	if root == "" {
		return "/data"
	}
	return root
}

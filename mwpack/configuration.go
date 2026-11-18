package mwpack

import (
	"fmt"
	"path"
	"regexp"
	"strings"
)

// Non-executable templates; no lookups or server-side commands.
type ConfigurationOutput struct {
	Path    string `yaml:"path" json:"path"`
	Content string `yaml:"content" json:"content"`
}

var configurationPlaceholder = regexp.MustCompile(`\$\{([^}]*)\}`)

func configurationPath(p string) bool {
	return p != "" && p != "." && !strings.HasPrefix(p, "/") && path.Clean(p) == p && p != ".." && !strings.HasPrefix(p, "../") && !strings.ContainsAny(p, "\\\x00") && !strings.Contains(p, "${")
}
func ValidateConfiguration(c *Component) []Problem {
	var out []Problem
	seen := map[string]bool{}
	for _, x := range c.Configuration {
		if !configurationPath(x.Path) || seen[x.Path] || strings.TrimSpace(x.Content) == "" {
			out = append(out, Problem{"error", "configuration", "配置输出需要不重复的相对路径和非空内容"})
		}
		if strings.Contains(x.Content, "{{") || strings.Contains(x.Content, "{%") {
			out = append(out, Problem{"error", "configuration", "配置输出只支持字面参数占位，不支持 Jinja 或脚本；复杂模板请使用离线部署流程"})
		}
		seen[x.Path] = true
		for _, match := range configurationPlaceholder.FindAllStringSubmatch(x.Content, -1) {
			key := match[1]
			if key == "cluster" || key == "instance" || key == "host.name" || key == "host.ip" || key == "host.data_root" {
				continue
			}
			valid := strings.HasPrefix(key, "params.") && len(c.Versions) > 0
			for _, v := range c.Versions {
				r, e := c.Resolve(v.ID)
				found := false
				if e == nil {
					for _, p := range r.Params {
						if key == "params."+p.Key {
							found = true
						}
					}
				}
				valid = valid && found
			}
			if !valid {
				out = append(out, Problem{"error", "configuration", "配置文件 " + x.Path + " 使用了未定义的占位符：" + key})
			}
		}
		if strings.Contains(configurationPlaceholder.ReplaceAllString(x.Content, ""), "${") {
			out = append(out, Problem{"error", "configuration", "配置文件 " + x.Path + " 的占位符未闭合"})
		}
	}
	if c.SupportsDelivery("configuration") && c.Kind != "external" && len(c.Configuration) == 0 {
		out = append(out, Problem{"error", "configuration", "仅出配置能力需要先定义配置输出；可在概览中的「配置文件」添加"})
	}
	return out
}
func ValidateDeliveryMode(p *Plan) error {
	if p == nil || p.Dep == nil {
		return fmt.Errorf("交付规格缺失")
	}
	mode := p.Dep.DeliveryMode
	if mode == "" {
		mode = "offline"
	}
	if mode != "offline" && mode != "configuration" {
		return fmt.Errorf("交付方式只能选择 offline 或 configuration；自动执行需在计划生成后单独授权")
	}
	for _, i := range p.Instances {
		if i.R == nil || i.R.C == nil {
			return fmt.Errorf("%s 的组件定义不可用", i.ID)
		}
		if i.External {
			continue
		}
		if !i.R.C.SupportsDelivery(mode) && !(mode == "offline" && i.R.C.SupportsDelivery("automatic")) {
			return fmt.Errorf("%s 的当前修订不支持%s", i.ID, map[string]string{"offline": "生成执行包", "configuration": "仅出配置"}[mode])
		}
	}
	return nil
}
func ConfigurationFiles(p *Plan) (map[string][]byte, error) {
	if e := ValidateDeliveryMode(p); e != nil {
		return nil, e
	}
	out := map[string][]byte{}
	for _, i := range p.Instances {
		if i.External {
			var b strings.Builder
			fmt.Fprintf(&b, "# %s 配置清单\n\n由现场管理员按下列清单配置，平台没有创建或修改外部服务。\n\n", i.R.C.Title)
			for _, bind := range i.Binds {
				fmt.Fprintf(&b, "## %s → %s\n\n监听：%s / %d\n\n健康检查：%s\n\n| 后端机器 | 地址 | 端口 | 角色 |\n| --- | --- | --- | --- |\n", bind.Name, bind.Target, bind.Endpoint.Protocol, bind.Listen, healthText(bind.Check, healthPort(EndpointFacts{Port: bind.Endpoint.Port, Health: bind.Check})))
				for _, h := range bind.Endpoint.Backends {
					fmt.Fprintf(&b, "| %s | %s | %d | %s |\n", h.Host, h.IP, h.Port, h.Role)
				}
				b.WriteString("\n放通客户端到监听端口，以及负载均衡到后端服务和健康检查端口。配置后验证连通性，再记录验收结果。\n\n")
			}
			for _, component := range p.Instances {
				for _, front := range component.Fronts {
					if front.Balancer == i.ID {
						fmt.Fprintf(&b, "入口地址：%s:%d\n\n", front.Address, front.Listen)
					}
				}
			}
			out[i.ID+"/配置清单.md"] = []byte(b.String())
			continue
		}
		if !i.R.C.SupportsDelivery("configuration") {
			return nil, fmt.Errorf("%s 未声明配置输出", i.ID)
		}
		for _, host := range i.Hosts {
			var h Host
			for _, v := range p.Dep.Hosts {
				if v.Name == host {
					h = v
				}
			}
			for _, x := range i.R.C.Configuration {
				if !configurationPath(x.Path) {
					return nil, fmt.Errorf("配置文件路径无效")
				}
				value := i.FillText(x.Content)
				root := "/data"
				if v, ok := h.Params["data_root"].(string); ok && v != "" {
					root = v
				}
				value = strings.NewReplacer("${host.name}", h.Name, "${host.ip}", h.IP, "${host.data_root}", root).Replace(value)
				if strings.Contains(value, "${") {
					return nil, fmt.Errorf("%s/%s 仍有未定义的占位符，请修正组件的配置输出", i.ID, x.Path)
				}
				out[i.ID+"/"+host+"/"+x.Path] = []byte(value)
			}
		}
	}
	return out, nil
}

package ansiblev2

import (
	"fmt"
	"path"
	"strings"

	"gopkg.in/yaml.v3"
)

// Validate checks a normalized Ansible 2.0 component tree + manifest for structural correctness,
// playbook YAML validity, missing local roles, and common security pitfalls.
func Validate(files map[string][]byte, m Manifest) []Problem {
	var out []Problem

	if !ValidComponentName(m.Name) {
		out = append(out, Problem{
			Severity: "error",
			Path:     ManifestFileName,
			Message:  fmt.Sprintf("组件标识 %q 不合法：须以小写字母开头，仅含小写字母、数字和连字符", m.Name),
		})
	}
	if strings.TrimSpace(m.Entrypoints.Deploy) == "" {
		out = append(out, Problem{
			Severity: "error",
			Path:     ManifestFileName,
			Message:  "缺少部署入口 Playbook（entrypoints.deploy）",
		})
	}

	localRoles := map[string]bool{}
	for _, r := range discoverRoles(files) {
		localRoles[r] = true
	}
	declaredReqs := map[string]bool{}
	for _, r := range parseRequirements(files) {
		declaredReqs[r] = true
	}

	checkPlaybook := func(rel string, required bool) {
		if rel == "" {
			return
		}
		raw, ok := files[rel]
		if !ok {
			sev := "warning"
			if required {
				sev = "error"
			}
			out = append(out, Problem{
				Severity: sev,
				Path:     rel,
				Message:  fmt.Sprintf("入口 Playbook 文件不存在：%s", rel),
			})
			return
		}
		var plays []map[string]any
		if err := yaml.Unmarshal(raw, &plays); err != nil {
			out = append(out, Problem{
				Severity: "error",
				Path:     rel,
				Message:  fmt.Sprintf("Playbook YAML 语法错误：%v", err),
			})
			return
		}
		if len(plays) == 0 {
			out = append(out, Problem{
				Severity: "error",
				Path:     rel,
				Message:  "Playbook 为空，至少需要包含 1 个 Play",
			})
			return
		}
		for i, pl := range plays {
			if _, hasImp := pl["import_playbook"]; hasImp {
				continue
			}
			if _, hasImp := pl["ansible.builtin.import_playbook"]; hasImp {
				continue
			}
			if _, hasHosts := pl["hosts"]; !hasHosts {
				out = append(out, Problem{
					Severity: "error",
					Path:     rel,
					Message:  fmt.Sprintf("第 %d 个 Play 缺少 hosts 字段", i+1),
				})
			}
			// Check role references
			if rawRoles, ok := pl["roles"].([]any); ok {
				for _, rr := range rawRoles {
					rname := ""
					switch rv := rr.(type) {
					case string:
						rname = strings.TrimSpace(rv)
					case map[string]any:
						if s, _ := rv["role"].(string); s != "" {
							rname = strings.TrimSpace(s)
						} else if s, _ := rv["name"].(string); s != "" {
							rname = strings.TrimSpace(s)
						}
					}
					if rname == "" || strings.Contains(rname, ".") || strings.Contains(rname, "{{") {
						// Fully qualified collection role (ns.col.role) or dynamic role
						continue
					}
					if !localRoles[rname] && !declaredReqs["role:"+rname] {
						out = append(out, Problem{
							Severity: "warning",
							Path:     rel,
							Message:  fmt.Sprintf("Play 引用了未在本地 roles/ 或 requirements.yml 中声明的角色：%s", rname),
						})
					}
				}
			}
		}
	}

	checkPlaybook(m.Entrypoints.Deploy, true)
	checkPlaybook(m.Entrypoints.Verify, false)
	checkPlaybook(m.Entrypoints.Probe, false)
	checkPlaybook(m.Entrypoints.Cleanup, false)

	// Validate all YAML files in roles/ & playbooks/ parse cleanly and warn on accidental v1 mw.* remnants
	for _, p := range sortedKeys(files) {
		if !isYAML(p) || p == ManifestFileName {
			continue
		}
		var doc any
		if err := yaml.Unmarshal(files[p], &doc); err != nil {
			out = append(out, Problem{
				Severity: "error",
				Path:     p,
				Message:  fmt.Sprintf("YAML 语法错误：%v", err),
			})
		}
		body := string(files[p])
		if strings.Contains(body, "mw.params.") || strings.Contains(body, "mw.roles.") {
			out = append(out, Problem{
				Severity: "warning",
				Path:     p,
				Message:  "检测到 v1 私有变量前缀（mw.params / mw.roles），2.0 建议改为标准 Ansible 变量以实现零魔改独立运行",
			})
		}
		if path.Base(p) == "main.yml" && strings.Contains(p, "/tasks/") {
			if strings.Contains(body, "BEGIN RSA PRIVATE KEY") || strings.Contains(body, "BEGIN PRIVATE KEY") {
				out = append(out, Problem{
					Severity: "error",
					Path:     p,
					Message:  "检测到明文私钥内容，严禁将敏感凭据硬编码在组件源码中",
				})
			}
		}
	}

	return out
}

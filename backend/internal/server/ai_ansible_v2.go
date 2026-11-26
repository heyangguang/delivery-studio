package server

import (
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strings"
	"time"

	"delivery-studio/internal/ansiblev2"
)

// ansibleV2AITools exposes native Ansible 2.0 component discovery, inspection, static validation,
// and permission-checked authoring to both the Platform Portal AI Dock and the full AI Assistant.
func ansibleV2AITools() []aiToolDef {
	obj := func(props map[string]any, req ...string) map[string]any {
		return map[string]any{"type": "object", "properties": props, "required": req}
	}
	str := func(d string) map[string]any { return map[string]any{"type": "string", "description": d} }
	return []aiToolDef{
		{
			Name:        "list_ansible_v2_components",
			Description: "列出平台所有原生 Ansible 2.0 组件（内置标杆与外部导入的 Role/Collection/Playbook），含资产形态、分组、变量数、步骤数和校验状态。回答组件编写、导入或选型问题前优先调用此工具。",
			Parameters:  obj(map[string]any{}),
		},
		{
			Name:        "inspect_ansible_v2_component",
			Description: "查看指定 Ansible 2.0 组件的完整结构：delivery-studio.yaml 契约、Playbook 入口、自动提取变量、OS 依赖包、静态校验结果，以及可选读取某个具体标准 Ansible 文件源码。",
			Parameters: obj(map[string]any{
				"name": str("Ansible 2.0 组件标识（例如 postgresql-native、redis-native、nginx-native）"),
				"file": str("可选：读取组件内某个具体文件的文本源码，如 playbooks/deploy.yml 或 roles/nginx/tasks/main.yml"),
			}, "name"),
		},
		{
			Name:        "validate_ansible_v2_files",
			Description: "对一组候选标准 Ansible 2.0 文件（单文件 Playbook、标准 Role 或工程仓库）执行完整静态校验与元数据提取（语法、argument_specs 互斥规则、本地 Role 引用、明文私钥拦截、OS 包探测）。保存前必须先通过此校验。",
			Parameters: obj(map[string]any{
				"name":  str("组件标识（小写字母开头，仅含小写字母/数字/连字符）"),
				"files": map[string]any{"type": "object", "description": "相对文件路径 -> 文件文本内容的映射（例如 {\"playbooks/deploy.yml\": \"...\", \"roles/app/tasks/main.yml\": \"...\"}）"},
			}, "name", "files"),
		},
		{
			Name:        "save_ansible_v2_component",
			Description: "在通过全部静态规范与安全校验的前提下，创建或更新一个 100% 标准原生 Ansible 2.0 组件（仅当用户明确要求写入/创建/修复 2.0 组件且当前账户拥有 component.edit 或 component.import 权限时调用）。严禁写入 mw.params/mw.roles 等 v1 私有变量或任何明文私钥。",
			Parameters: obj(map[string]any{
				"name":   str("组件标识（小写字母开头，仅含小写字母/数字/连字符）"),
				"source": str("来源标注，默认 ai-authored"),
				"files":  map[string]any{"type": "object", "description": "相对文件路径 -> 标准 Ansible 文件文本内容的完整或增量映射"},
			}, "name", "files"),
		},
	}
}

func isAnsibleV2AITool(name string) bool {
	switch name {
	case "list_ansible_v2_components", "inspect_ansible_v2_component", "validate_ansible_v2_files", "save_ansible_v2_component":
		return true
	}
	return false
}

func (s *storeServer) runAnsibleV2AITool(user, name, args string) string {
	var a map[string]any
	_ = json.Unmarshal([]byte(args), &a)
	str := func(k string) string {
		v, _ := a[k].(string)
		return strings.TrimSpace(v)
	}

	switch name {
	case "list_ansible_v2_components":
		seen := map[string]bool{}
		var names []string
		for _, n := range ansiblev2.BuiltinNames() {
			if !seen[n] {
				seen[n] = true
				names = append(names, n)
			}
		}
		for n := range s.loadV2CustomMap() {
			if !seen[n] {
				seen[n] = true
				names = append(names, n)
			}
		}
		sort.Strings(names)
		rows := make([]map[string]any, 0, len(names))
		for _, n := range names {
			files, src, ok := s.loadV2Component(n)
			if !ok {
				continue
			}
			rep := ansiblev2.Inspect(files, n, src)
			m := rep.Manifest
			var schemeNames []string
			for _, sc := range m.Schemes {
				schemeNames = append(schemeNames, sc.Title+"("+sc.ID+")")
			}
			rows = append(rows, map[string]any{
				"name":       n,
				"title":      m.Title,
				"category":   m.Category,
				"version":    m.Version,
				"asset_kind": rep.AssetKind,
				"source":     src,
				"groups":     len(m.Groups),
				"vars":       len(rep.Vars),
				"steps":      len(rep.Steps),
				"packages":   len(rep.Packages),
				"schemes":    schemeNames,
				"valid":      rep.Valid,
			})
		}
		b, _ := json.MarshalIndent(rows, "", "  ")
		return string(b)

	case "inspect_ansible_v2_component":
		comp := str("name")
		if comp == "" {
			return "请提供组件标识 name。"
		}
		files, src, ok := s.loadV2Component(comp)
		if !ok {
			return "未找到 Ansible 2.0 组件：" + comp
		}
		if wantFile := str("file"); wantFile != "" {
			clean := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(wantFile, "\\", "/")), "/")
			raw, exists := files[clean]
			if !exists {
				return fmt.Sprintf("组件 %s 中不存在文件 %s。", comp, clean)
			}
			txt := string(raw)
			if len(txt) > aiMaxFile {
				txt = txt[:aiMaxFile] + "\n...[已截断]"
			}
			return fmt.Sprintf("# %s :: %s\n\n%s", comp, clean, aiScrub(txt))
		}
		rep := ansiblev2.Inspect(files, comp, src)
		filePaths := make([]string, 0, len(files))
		for p := range files {
			filePaths = append(filePaths, p)
		}
		sort.Strings(filePaths)
		b, _ := json.MarshalIndent(map[string]any{
			"name":          comp,
			"source":        src,
			"asset_kind":    rep.AssetKind,
			"valid":         rep.Valid,
			"manifest_yaml": rep.ManifestYAML,
			"files":         filePaths,
			"vars":          rep.Vars,
			"steps":         rep.Steps,
			"packages":      rep.Packages,
			"problems":      rep.Problems,
		}, "", "  ")
		return aiScrub(string(b))

	case "validate_ansible_v2_files", "save_ansible_v2_component":
		comp := ansiblev2.SanitizeName(str("name"))
		if !ansiblev2.ValidComponentName(comp) {
			return "组件标识不合法：" + comp
		}
		rawMap, _ := a["files"].(map[string]any)
		if len(rawMap) == 0 {
			return "请提供至少一个标准 Ansible 文件（files 对象）。"
		}
		// If saving/validating an update over an existing component, start from current files for patch ergonomics.
		merged := map[string][]byte{}
		if name == "save_ansible_v2_component" {
			if !s.can(user, "component.edit") && !s.can(user, "component.import") {
				return "当前账号缺少 component.edit 或 component.import 权限，无法保存 Ansible 2.0 组件。"
			}
			if cur, _, ok := s.loadV2Component(comp); ok {
				for k, v := range cur {
					merged[k] = append([]byte(nil), v...)
				}
			}
		}
		for k, v := range rawMap {
			clean := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(k, "\\", "/")), "/")
			if clean == "" || strings.HasPrefix(clean, "..") {
				continue
			}
			if sVal, ok := v.(string); ok {
				merged[clean] = []byte(sVal)
			}
		}
		origin := firstNonEmptyStr(str("source"), "ai-authored")
		wrapped, kind, inferred := ansiblev2.WrapIntoRunnableProject(merged, comp)
		rep := ansiblev2.InspectNormalized(wrapped, kind, inferred, origin)
		rep.Manifest.Name = comp
		if mYAML, merr := ansiblev2.MarshalManifest(rep.Manifest); merr == nil {
			wrapped[ansiblev2.ManifestFileName] = []byte(mYAML)
		}
		rep = ansiblev2.InspectNormalized(wrapped, kind, comp, origin)
		if name == "validate_ansible_v2_files" || !rep.Valid {
			b, _ := json.MarshalIndent(map[string]any{
				"name":       comp,
				"asset_kind": rep.AssetKind,
				"valid":      rep.Valid,
				"problems":   rep.Problems,
				"vars":       len(rep.Vars),
				"steps":      len(rep.Steps),
				"packages":   rep.Packages,
				"saved":      false,
			}, "", "  ")
			return string(b)
		}
		if err := s.saveV2Component(comp, wrapped, map[string]any{
			"asset_kind": rep.AssetKind,
			"version":    rep.Manifest.Version,
			"source":     origin,
			"updated_by": user,
			"updated_at": time.Now().UTC().Format(time.RFC3339),
		}); err != nil {
			return "保存 Ansible 2.0 组件失败：" + err.Error()
		}
		s.audit("ansible-v2-ai-save", user, fmt.Sprintf("%s (%s, %d files)", comp, rep.AssetKind, len(wrapped)))
		b, _ := json.MarshalIndent(map[string]any{
			"saved":      true,
			"name":       comp,
			"asset_kind": rep.AssetKind,
			"file_count": len(wrapped),
			"vars":       len(rep.Vars),
			"steps":      len(rep.Steps),
			"packages":   rep.Packages,
			"url_hint":   "#/components?v2=" + comp,
		}, "", "  ")
		return string(b)
	}
	return "未知 Ansible 2.0 工具：" + name
}

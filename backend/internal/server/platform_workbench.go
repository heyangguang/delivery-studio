package server

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"gopkg.in/yaml.v3"
	"delivery-studio/mwpack"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

func findScriptSyntaxBash() (string, bool) {
	if runtime.GOOS == "windows" {
		sysRoot := os.Getenv("SYSTEMROOT")
		if sysRoot == "" {
			sysRoot = `C:\Windows`
		}
		for _, c := range []string{
			`C:\Program Files\Git\bin\bash.exe`,
			`C:\Program Files\Git\usr\bin\bash.exe`,
			`C:\Program Files (x86)\Git\bin\bash.exe`,
			`C:\Program Files (x86)\Git\usr\bin\bash.exe`,
		} {
			if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
				return c, true
			}
		}
		if p, err := exec.LookPath("bash.exe"); err == nil && !strings.EqualFold(filepath.Dir(p), filepath.Join(sysRoot, "System32")) {
			return p, true
		}
		return "", false
	}
	if p, err := exec.LookPath("bash"); err == nil {
		return p, true
	}
	if fi, err := os.Stat("/bin/bash"); err == nil && !fi.IsDir() {
		return "/bin/bash", true
	}
	return "", false
}

func findScriptSyntaxPython() (string, bool) {
	if info, err := discoverHostPython(); err == nil && info != nil && info.PythonBin != "" {
		return info.PythonBin, true
	}
	return "", false
}

const sharedPlatformName = "platform-shared"
const sharedManifest = "name: platform-shared\ntitle: 平台公共流程\nkind: infrastructure\ndescription: 所有交付共享的预检、数据盘、离线源、软件安装及密钥流程。\n"


func sharedBuiltin() fileSet {
	out := fileSet(mwpack.PlatformFiles())
	out["component.yaml"] = []byte(sharedManifest)
	out["files/platform-contract.md"] = []byte(sharedContract)
	return out
}

// refreshSharedManagedFiles keeps platform-owned read-only metadata files aligned with the running binary so
// platform upgrades never invalidate older platform-shared drafts or live overrides.
func refreshSharedManagedFiles(set fileSet) {
	if set == nil {
		return
	}
	set["component.yaml"] = []byte(sharedManifest)
	set["files/platform-contract.md"] = []byte(sharedContract)
}
func sharedRuntime(set fileSet) map[string][]byte {
	out := map[string][]byte{}
	for p, b := range set {
		if p != "component.yaml" && p != "files/platform-contract.md" {
			out[p] = b
		}
	}
	return out
}
func sharedCatalog(p *platform, set fileSet) *mwpack.Catalog {
	return p.cat().WithPlatformFiles(sharedRuntime(set))
}
func checkSharedPlatform(p *platform, set fileSet) *compCheck {
	r := &compCheck{Problems: []compProblem{}}
	if err := set.check(); err != nil {
		r.add("error", "", 0, "", "%v", err)
		return r.finish()
	}
	contract, contractErr := mwpack.ParseHostContract(set[mwpack.PlatformContractPath])
	if contractErr != nil {
		line, location := hostContractErrorLocation(set[mwpack.PlatformContractPath], contractErr.Error())
		r.add("error", mwpack.PlatformContractPath, line, location, "%v", contractErr)
	} else {
		keys := map[string]bool{}
		for _, param := range contract.Parameters {
			keys[param.Key] = true
		}
		re := regexp.MustCompile("mw_hosts[^\\n]*?\\.params\\.([a-z][a-z0-9_]*)")
		for file, b := range set {
			if !strings.HasPrefix(file, "roles/") {
				continue
			}
			for _, hit := range re.FindAllSubmatch(b, -1) {
				key := string(hit[1])
				if !keys[key] {
					r.add("error", file, 0, "", "公共任务引用未定义的机器参数 %s", key)
				}
			}
		}
	}
	base := sharedBuiltin()
	for _, path := range base.paths() {
		if _, ok := set[path]; !ok {
			r.add("error", path, 0, "", "公共入口文件不能删除")
		}
	}
	for _, path := range []string{"component.yaml", "files/platform-contract.md"} {
		if !bytes.Equal(set[path], base[path]) {
			r.add("error", path, 0, "", "平台标识与参数契约由平台代码维护，不能在角色编辑器修改")
		}
	}
	bashBin, hasBash := findScriptSyntaxBash()
	pythonBin, hasPython := findScriptSyntaxPython()
	for _, path := range set.paths() {
		b := set[path]
		if !isText(b) {
			r.add("error", path, 0, "", "公共流程只接受文本文件")
			continue
		}
		if strings.HasSuffix(path, ".sh") {
			if !hasBash {
				r.add("warning", path, 0, "", "当前宿主机未检测到可用的 bash，已跳过本地脚本语法检查")
			} else {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				cmd := exec.CommandContext(ctx, bashBin, "-n")
				cmd.Stdin = bytes.NewReader(b)
				out, err := cmd.CombinedOutput()
				cancel()
				if err != nil {
					msg := strings.TrimSpace(string(out))
					if msg != "" {
						r.add("error", path, 0, "", "脚本语法检查失败：%s（%v）", msg, err)
					} else {
						r.add("error", path, 0, "", "脚本语法检查失败：%v", err)
					}
				}
			}
		} else if strings.HasSuffix(path, ".py") {
			if !hasPython {
				r.add("warning", path, 0, "", "当前宿主机未检测到可用的 Python 3，已跳过本地脚本语法检查")
			} else {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				cmd := exec.CommandContext(ctx, pythonBin, "-c", "import ast,sys;ast.parse(sys.stdin.read())")
				cmd.Stdin = bytes.NewReader(b)
				out, err := cmd.CombinedOutput()
				cancel()
				if err != nil {
					msg := strings.TrimSpace(string(out))
					if msg != "" {
						r.add("error", path, 0, "", "脚本语法检查失败：%s（%v）", msg, err)
					} else {
						r.add("error", path, 0, "", "脚本语法检查失败：%v", err)
					}
				}
			}
		}
		if strings.HasSuffix(path, ".yml") || strings.HasSuffix(path, ".yaml") {
			var n yaml.Node
			if err := yaml.Unmarshal(b, &n); err != nil {
				r.add("error", path, yamlErrLine(err), "", "YAML 语法错误：%v", err)
			} else if strings.Contains(path, "/tasks/") && (len(n.Content) == 0 || n.Content[0].Kind != yaml.SequenceNode) {
				r.add("error", path, 0, "", "任务文件必须是任务列表")
			}
		}
		if strings.HasPrefix(path, "roles/") {
			parts := strings.Split(path, "/")
			if len(parts) < 4 || !strings.HasPrefix(parts[1], "mw_") {
				r.add("error", path, 0, "", "公共角色必须位于 roles/mw_*/ 下")
			}
		}
	}
	if len(r.Problems) == 0 {
		cat := sharedCatalog(p, set)
		for _, name := range []string{"redis", "postgresql", "etcd"} {
			if _, ok := cat.Get(name); !ok {
				continue
			}
			if _, _, _, err := renderSample(cat, name, previewReq{}); err != nil {
				r.add("error", "", 0, "", "%s 试生成失败：%v", name, err)
			}
		}
	}
	return r.finish()
}
func previewSharedPlatform(p *platform, a ansibleEnv, set, live fileSet) *previewResp {
	r := &previewResp{OK: true, Files: []previewFile{}, Issues: []mwpack.Problem{}, Handbooks: []previewHandbook{}, Syntax: []syntaxResult{}, Ansible: a, Versions: []string{}, Presets: []mwpack.Preset{}, Platforms: []string{}, Roles: []mwpack.RoleSpec{}, Params: []mwpack.Param{}}
	check := checkSharedPlatform(p, set)
	if !check.OK {
		r.OK = false
		r.Error = problemsText(check, nil)
		return r
	}
	for _, name := range []string{"redis", "postgresql", "etcd"} {
		if _, ok := p.cat().Get(name); !ok {
			continue
		}
		b, _, _, err := renderSample(sharedCatalog(p, set), name, previewReq{})
		if err != nil {
			r.OK = false
			r.Error = err.Error()
			return r
		}
		for _, sx := range syntaxCheckShared(a, b) {
			sx.Playbook = name + "/" + sx.Playbook
			r.Syntax = append(r.Syntax, sx)
			if !sx.OK {
				r.OK = false
				r.Error = "公共流程语法检查失败"
			}
		}
		before := map[string][]byte{}
		if live != nil {
			old, _, _, e := renderSample(sharedCatalog(p, live), name, previewReq{})
			if e == nil {
				before = bundleFiles(old)
				r.Compared = true
			}
		}
		for path, data := range bundleFiles(b) {
			status := "same"
			if old, ok := before[path]; !ok {
				status = "added"
			} else if !bytes.Equal(old, data) {
				status = "changed"
			}
			if status != "same" {
				r.Changes++
			}
			r.Files = append(r.Files, previewFile{Path: name + "/" + path, Size: len(data), Status: status})
		}
	}
	return r
}
func (p *platform) loadShared(cat *mwpack.Catalog) (*mwpack.Catalog, error) {
	cs := &compStore{root: p.componentsDir, builtin: builtinFS(), repo: p.cfg.Repo}
	set, _, err := cs.liveSet(sharedPlatformName)
	if err != nil {
		return nil, fmt.Errorf("公共流程读取失败：%w", err)
	}
	return cat.WithPlatformFiles(sharedRuntime(set)), nil
}

func syntaxCheckShared(a ansibleEnv, b *mwpack.Bundle) []syntaxResult {
	if !a.Ready {
		return nil
	}
	dir, err := os.MkdirTemp("", "mw-platform-syntax-")
	if err != nil {
		return []syntaxResult{{Playbook: "准备目录", Output: err.Error()}}
	}
	defer os.RemoveAll(dir)
	if err = writeBundle(dir, b); err != nil {
		return []syntaxResult{{Playbook: "写入", Output: err.Error()}}
	}
	out := []syntaxResult{}
	for _, phase := range b.Steps.Phases {
		text, e := a.run(context.Background(), dir, 60*time.Second, "ansible-playbook", "-i", "inventory/hosts.yml", "--syntax-check", phase.Playbook)
		out = append(out, syntaxResult{Playbook: phase.Playbook, OK: e == nil, Output: trimOutput(text)})
	}
	return out
}

// Locate contract findings in the same YAML the user edits, including a rule's concrete required value.
func hostContractErrorLocation(data []byte, message string) (int, string) {
	if line := yamlErrLine(fmt.Errorf("%s", message)); line > 0 {
		return line, ""
	}
	var root yaml.Node
	if yaml.Unmarshal(data, &root) != nil || len(root.Content) == 0 {
		return 1, ""
	}
	get := func(n *yaml.Node, key string) *yaml.Node {
		for i := 0; i+1 < len(n.Content); i += 2 {
			if n.Content[i].Value == key {
				return n.Content[i+1]
			}
		}
		return nil
	}
	top := root.Content[0]
	if rules := get(top, "rules"); rules != nil {
		for i, rule := range rules.Content {
			id := get(rule, "id")
			if id == nil || !strings.Contains(message, "规则 "+id.Value+"：") {
				continue
			}
			if req := get(rule, "require"); req != nil {
				for j, item := range req.Content {
					field := get(item, "field")
					value := get(item, "equals")
					if field != nil && value != nil && (strings.Contains(message, "（"+field.Value+"）") || strings.Contains(message, "磁盘设备 "+field.Value+"，")) && strings.Contains(message, "隐藏") {
						return value.Line, fmt.Sprintf("rules[%d].require[%d].equals", i, j)
					}
				}
			}
			if id := get(rule, "id"); id != nil && id.Value != "" && strings.Contains(message, id.Value) {
				return id.Line, fmt.Sprintf("rules[%d].id", i)
			}
		}
	}
	if params := get(top, "parameters"); params != nil {
		for i, param := range params.Content {
			key := get(param, "key")
			if key != nil && key.Value != "" && strings.Contains(message, key.Value) {
				target := key
				part := "key"
				for _, entry := range []struct{ word, field string }{{"默认值", "default"}, {"类型", "type"}, {"选项", "options"}, {"范围", "min"}, {"最小值", "min"}} {
					if strings.Contains(message, entry.word) {
						if n := get(param, entry.field); n != nil {
							target = n
							part = entry.field
						}
						break
					}
				}
				return target.Line, fmt.Sprintf("parameters[%d].%s", i, part)
			}
		}
	}
	return 1, ""
}

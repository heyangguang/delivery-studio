package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"delivery-studio/mwpack"
)

// Trial generation: build a sample deployment of the draft, render it exactly as a real delivery would be rendered,
// and show what comes out. Nothing here touches a real machine; Ansible is used only to check syntax and to render a
// template locally.

type previewReq struct {
	DeliveryMode string `json:"delivery_mode"`
	Version      string `json:"version"`
	Preset       string `json:"preset"`
	Platform     string `json:"platform"`
	// Hosts and Placement let the author arrange the sample by hand: how many machines there are (host1…hostN) and which
	// machines hold each role. Params overrides parameter values on top of the preset's. All empty means "arrange it for
	// me", which is also how the first trial starts.
	Hosts     int                 `json:"hosts"`
	Placement map[string][]string `json:"placement"`
	Params    map[string]any      `json:"params"`
}

var sampleHostRE = regexp.MustCompile(`^host([1-9][0-9]?)$`)

type sampleInfo struct {
	DeliveryMode string              `json:"delivery_mode"`
	Instance     string              `json:"instance"`
	Version      string              `json:"version"`
	Platform     string              `json:"platform"`
	Preset       string              `json:"preset,omitempty"`
	Hosts        []string            `json:"hosts"`
	Placment     map[string][]string `json:"placement"`
}

type previewFile struct {
	Path   string `json:"path"`
	Size   int    `json:"size"`
	Status string `json:"status"` // same | added | changed | removed
	Diff   string `json:"diff,omitempty"`
}

type syntaxResult struct {
	Playbook string `json:"playbook"`
	OK       bool   `json:"ok"`
	Output   string `json:"output,omitempty"`
}

type previewHandbook struct {
	Name     string `json:"name"`
	Markdown string `json:"markdown"`
}

type previewResp struct {
	DeliveryModes []string          `json:"delivery_modes"`
	OK            bool              `json:"ok"`
	Error         string            `json:"error,omitempty"`
	Sample        *sampleInfo       `json:"sample,omitempty"`
	Plan          *mwpack.PlanView  `json:"plan,omitempty"`
	Issues        []mwpack.Problem  `json:"issues"`
	Handbooks     []previewHandbook `json:"handbooks"`
	Files         []previewFile     `json:"files"`
	Compared      bool              `json:"compared"` // there is a published version to compare with
	Changes       int               `json:"changes"`
	Ansible       ansibleEnv        `json:"ansible"`
	Syntax        []syntaxResult    `json:"syntax"`
	Versions      []string          `json:"versions"`
	Presets       []mwpack.Preset   `json:"presets"`
	Platforms     []string          `json:"platforms"`
	// Roles and Params describe the chosen version, so the sample can be arranged by hand.
	Roles  []mwpack.RoleSpec `json:"roles"`
	Params []mwpack.Param    `json:"params"`
}

// sampleDeployment places one instance of the component on as few machines as its roles allow.
func sampleDeployment(c *mwpack.Component, req previewReq) (*mwpack.Deployment, *sampleInfo, error) {
	if req.Preset == "" && c.Detail != nil && len(c.Detail.Presets) > 0 {
		req.Preset = c.Detail.Presets[0].ID
	}
	ver := req.Version
	if ver == "" {
		for _, v := range c.Versions {
			ver = v.ID
			if v.Status == "published" {
				break
			}
		}
	}
	r, err := c.Resolve(ver)
	if err != nil {
		return nil, nil, err
	}
	platform := req.Platform
	if platform == "" && len(r.Version.Platforms) > 0 {
		platform = r.Version.Platforms[0]
	}
	counts := map[string]int{}
	var params map[string]any
	if req.Preset != "" && c.Detail != nil {
		found := false
		for _, pr := range c.Detail.Presets {
			if pr.ID == req.Preset {
				found = true
				for _, rc := range pr.Roles {
					counts[rc.Role] = rc.Count
				}
				params = pr.Params
			}
		}
		if !found {
			return nil, nil, fmt.Errorf("没有名为 %q 的预设", req.Preset)
		}
	}
	for _, role := range r.Roles {
		if _, ok := counts[role.Name]; !ok {
			n := role.Default
			if req.Preset != "" {
				n = 0
			}
			if req.Preset == "" && n < role.Min {
				n = role.Min
			}
			counts[role.Name] = n
		}
	}
	placement := map[string][]string{}
	next, hostN := 0, 0
	hostName := func(i int) string { return fmt.Sprintf("host%d", i+1) }
	for _, role := range r.Roles {
		n := counts[role.Name]
		for i := 0; i < n; i++ {
			idx := i
			if role.Exclusive {
				idx = next
				next++
			}
			placement[role.Name] = append(placement[role.Name], hostName(idx))
			if idx+1 > hostN {
				hostN = idx + 1
			}
		}
	}
	if len(req.Placement) > 0 {
		// the author's own arrangement replaces the automatic one
		placement = map[string][]string{}
		hostN = 0
		known := map[string]bool{}
		for _, role := range r.Roles {
			known[role.Name] = true
		}
		for role, hs := range req.Placement {
			if !known[role] {
				return nil, nil, fmt.Errorf("版本 %s 没有角色 %q", ver, role)
			}
			for _, h := range hs {
				m := sampleHostRE.FindStringSubmatch(h)
				if m == nil {
					return nil, nil, fmt.Errorf("示例机器名「%s」不对，只能是 host1 到 host99", h)
				}
				n, _ := strconv.Atoi(m[1])
				if n > hostN {
					hostN = n
				}
			}
			placement[role] = append([]string(nil), hs...)
		}
	}
	if req.Hosts > hostN && req.Hosts <= 20 {
		hostN = req.Hosts
	}
	if hostN == 0 {
		hostN = 1
	}
	// A required parameter with no default has no value a person has not given; the sample invents a harmless one so the
	// trial is not stopped by a field the author never meant to test.
	for _, pm := range r.Params {
		if pm.Required && pm.Default == nil && pm.When == "" {
			if _, ok := params[pm.Key]; !ok {
				if params == nil {
					params = map[string]any{}
				}
				params[pm.Key] = sampleValue(pm)
			}
		}
	}
	if len(req.Params) > 0 {
		merged := map[string]any{}
		for k, v := range params {
			merged[k] = v
		}
		for k, v := range req.Params {
			merged[k] = v
		}
		params = merged
	}
	dep := &mwpack.Deployment{Schema: mwpack.DeploymentSchema, ID: "sample", Title: "试生成样例", Platform: platform}
	dep.DeliveryMode = req.DeliveryMode
	if dep.DeliveryMode == "" && c.SupportsDelivery("configuration") && !c.SupportsDelivery("offline") && !c.SupportsDelivery("automatic") {
		dep.DeliveryMode = "configuration"
	}
	var hosts []string
	for i := 0; i < hostN; i++ {
		dep.Hosts = append(dep.Hosts, mwpack.Host{Name: hostName(i), IP: fmt.Sprintf("10.0.0.%d", 11+i)})
		hosts = append(hosts, hostName(i))
	}
	id := c.Short
	if id == "" {
		id = c.Name
	}
	dep.Instances = []mwpack.InstanceSpec{{ID: id, Component: c.Name, Version: ver, Placement: placement, Params: params}}
	return dep, &sampleInfo{DeliveryMode: dep.DeliveryMode, Instance: id, Version: ver, Platform: platform, Preset: req.Preset, Hosts: hosts, Placment: placement}, nil
}

// renderSample solves and renders the sample against a catalog.
func renderSample(cat *mwpack.Catalog, name string, req previewReq) (*mwpack.Bundle, *mwpack.Plan, *sampleInfo, error) {
	c, ok := cat.Get(name)
	if !ok {
		return nil, nil, nil, errors.New("组件无法载入")
	}
	// A manager is previewed through a supported parent scheme, never as an
	// independent database. The catalog declaration supplies the relationship.
	if c.Context != "" {
		for _, name := range cat.Names() {
			parent, _ := cat.Get(name)
			if parent.Detail == nil {
				continue
			}
			for _, companion := range parent.Companions {
				if companion.Component != c.Name || companion.Capability != c.Context {
					continue
				}
				for _, preset := range parent.Detail.Presets {
					parentReq := req
					parentReq.Version = ""
					parentReq.Preset = preset.ID
					b, plan, info, err := renderSample(cat, name, parentReq)
					if err != nil {
						continue
					}
					for _, inst := range plan.Instances {
						if inst.Component == c.Name {
							info.Instance, info.Version = inst.ID, inst.Version
							return b, plan, info, nil
						}
					}
				}
			}
		}
		return nil, nil, nil, fmt.Errorf("管理组件 %s 没有可试生成的父组件方案", c.Name)
	}
	dep, info, err := sampleDeployment(c, req)
	if err != nil {
		return nil, nil, nil, err
	}
	plan := mwpack.Solve(cat, dep)
	if err := plan.Err(); err != nil {
		return nil, plan, info, err
	}
	if dep.DeliveryMode == "configuration" {
		files, err := mwpack.ConfigurationFiles(plan)
		if err != nil {
			return nil, plan, info, err
		}
		b := &mwpack.Bundle{Plan: plan, Project: map[string]mwpack.File{}, Docs: map[string][]byte{"配置交付说明.md": []byte("本次只生成配置文件，没有安装软件或验证现场。文件按实例和机器分开，需由现场人员审核并应用。")}}
		for path, data := range files {
			b.Project[path] = mwpack.File{Data: data, Mode: 0600}
		}
		return b, plan, info, nil
	}
	mats := map[string][]byte{}
	for _, in := range plan.Inputs {
		for _, f := range []string{"server.crt", "server.key", "ca.crt"} {
			mats[in.Instance+"/"+in.Name+"/"+f] = []byte("sample\n")
		}
	}
	b, err := mwpack.Render(plan, mwpack.RenderOptions{Materials: mats})
	return b, plan, info, err
}

func bundleFiles(b *mwpack.Bundle) map[string][]byte {
	out := map[string][]byte{}
	for p, f := range b.Project {
		out[p] = f.Data
	}
	for n, d := range b.Docs {
		out["docs/"+n] = d
	}
	return out
}

// previewComponent is the trial generation behind the workbench's 试生成 button.
func previewComponent(p *platform, ansible ansibleEnv, name string, files fileSet, live fileSet, req previewReq) *previewResp {
	if name == sharedPlatformName {
		return previewSharedPlatform(p, ansible, files, live)
	}
	resp := &previewResp{Issues: []mwpack.Problem{}, Handbooks: []previewHandbook{}, Files: []previewFile{}, Syntax: []syntaxResult{}, Ansible: ansible,
		Versions: []string{}, Presets: []mwpack.Preset{}, Platforms: []string{}, Roles: []mwpack.RoleSpec{}, Params: []mwpack.Param{}}
	cat, err := trialCatalog(p, name, files)
	if err != nil {
		resp.Error = "草稿无法载入，先修正检查中的错误：" + err.Error()
		return resp
	}
	c, _ := cat.Get(name)
	resp.DeliveryModes = c.EffectiveDeliveryModes()
	for _, v := range c.Versions {
		resp.Versions = append(resp.Versions, v.ID)
	}
	if c.Detail != nil {
		resp.Presets = append(resp.Presets, c.Detail.Presets...)
	}
	seenPlat := map[string]bool{}
	for _, v := range c.Versions {
		for _, pl := range v.Platforms {
			if !seenPlat[pl] {
				seenPlat[pl] = true
				resp.Platforms = append(resp.Platforms, pl)
			}
		}
	}
	b, plan, info, err := renderSample(cat, name, req)
	resp.Sample = info
	if info != nil {
		if r, rerr := c.Resolve(info.Version); rerr == nil {
			resp.Roles, resp.Params = r.Roles, r.Params
		}
	}
	if plan != nil {
		view := plan.View()
		if plan.Dep.DeliveryMode == "configuration" {
			view.Phases = nil
			view.Artifacts = nil
		}
		resp.Plan = &view
		resp.Issues = view.Issues
	}
	if err != nil {
		resp.Error = err.Error()
		return resp
	}
	resp.OK = true
	now := bundleFiles(b)
	for _, n := range sortedKeys(b.Docs) {
		resp.Handbooks = append(resp.Handbooks, previewHandbook{Name: n, Markdown: string(b.Docs[n])})
	}

	// Compare with what the published component generates for the same sample.
	before := map[string][]byte{}
	if live != nil {
		if pcat, err := trialCatalog(p, name, live); err == nil {
			if pb, _, _, err := renderSample(pcat, name, req); err == nil {
				before = bundleFiles(pb)
				resp.Compared = true
			}
		}
	}
	for _, path := range sortedKeys(now) {
		f := previewFile{Path: path, Size: len(now[path]), Status: "same"}
		old, had := before[path]
		switch {
		case resp.Compared && !had:
			f.Status = "added"
		case resp.Compared && string(old) != string(now[path]):
			f.Status = "changed"
			f.Diff = lineDiff(string(old), string(now[path]), 200)
		}
		if f.Status != "same" {
			resp.Changes++
		}
		resp.Files = append(resp.Files, f)
	}
	for _, path := range sortedKeys(before) {
		if _, ok := now[path]; !ok {
			resp.Files = append(resp.Files, previewFile{Path: path, Size: len(before[path]), Status: "removed"})
			resp.Changes++
		}
	}

	if ansible.Ready && plan.Dep.DeliveryMode != "configuration" {
		resp.Syntax = syntaxCheckBundle(ansible, b)
	}
	return resp
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func writeBundle(dir string, b *mwpack.Bundle) error {
	for rel, f := range b.Project {
		dest := filepath.Join(dir, filepath.FromSlash(rel))
		if !strings.HasPrefix(dest, dir+string(filepath.Separator)) {
			return fmt.Errorf("不安全的路径 %s", rel)
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(dest, f.Data, 0o600); err != nil {
			return err
		}
	}
	return nil
}

var trailingNoise = regexp.MustCompile(`(?m)^\[WARNING\].*\n?`)

// syntaxCheckBundle runs ansible-playbook --syntax-check on every generated playbook.
func syntaxCheckBundle(a ansibleEnv, b *mwpack.Bundle) []syntaxResult {
	dir, err := os.MkdirTemp("", "mw-syntax-")
	if err != nil {
		return []syntaxResult{{Playbook: "(准备目录)", Output: err.Error()}}
	}
	defer os.RemoveAll(dir)
	if err := writeBundle(dir, b); err != nil {
		return []syntaxResult{{Playbook: "(写入)", Output: err.Error()}}
	}
	var books []string
	for rel := range b.Project {
		if strings.HasSuffix(rel, ".yml") && !strings.Contains(rel, "/") && rel != "deployment.yml" {
			books = append(books, rel)
		}
	}
	for rel := range b.Project {
		if (strings.HasPrefix(rel, "playbooks/") || strings.HasPrefix(rel, "steps/") || strings.HasPrefix(rel, "tests/") || strings.HasPrefix(rel, "tests-endpoint/") || strings.HasPrefix(rel, "cleanup/")) && strings.HasSuffix(rel, ".yml") {
			books = append(books, rel)
		}
	}
	sort.Strings(books)
	var out []syntaxResult
	for _, pb := range books {
		o, err := a.run(context.Background(), dir, 60*time.Second, "ansible-playbook", "-i", "inventory/hosts.yml", "--syntax-check", pb)
		out = append(out, syntaxResult{Playbook: pb, OK: err == nil, Output: strings.TrimSpace(trailingNoise.ReplaceAllString(o, ""))})
	}
	return out
}

// renderTemplate renders one template of the component for one machine of the sample, with the variables a real
// delivery would give it, using Ansible's own template module on this server.
func renderTemplate(p *platform, a ansibleEnv, name string, files fileSet, tpl string, req previewReq, host string) (string, error) {
	if !a.Ready {
		return "", errors.New(a.Reason)
	}
	text, ok := files[tpl]
	if !ok || !strings.HasSuffix(tpl, ".j2") {
		return "", errors.New("请选择一个 .j2 模板文件")
	}
	if lookupRE.Match(text) {
		return "", errors.New("模板里用了 lookup/query，它在服务器上执行，预览不会运行它。请在真实环境中验证")
	}
	cat, err := trialCatalog(p, name, files)
	if err != nil {
		return "", fmt.Errorf("草稿无法载入：%w", err)
	}
	b, _, info, err := renderSample(cat, name, req)
	if err != nil {
		return "", err
	}
	if host == "" {
		host = info.Hosts[0]
	}
	dir, err := os.MkdirTemp("", "mw-render-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	if err := writeBundle(dir, b); err != nil {
		return "", err
	}
	tplAbs := filepath.Join(dir, "_template.j2")
	if err := os.WriteFile(tplAbs, text, 0o600); err != nil {
		return "", err
	}
	play := fmt.Sprintf(`- hosts: %q
  gather_facts: false
  vars:
    mw: "{{ mw_instances['%s'] }}"
  tasks:
    - ansible.builtin.template:
        src: %s
        dest: %s
      delegate_to: localhost
`, host, info.Instance, tplAbs, filepath.Join(dir, "_rendered.out"))
	if err := os.WriteFile(filepath.Join(dir, "_render.yml"), []byte(play), 0o600); err != nil {
		return "", err
	}
	o, err := a.run(context.Background(), dir, 60*time.Second, "ansible-playbook", "-c", "local", "-i", "inventory/hosts.yml", "-l", host, "_render.yml")
	if err != nil {
		return "", fmt.Errorf("渲染失败：\n%s", trimOutput(o))
	}
	got, err := os.ReadFile(filepath.Join(dir, "_rendered.out"))
	if err != nil {
		return "", errors.New("没有产生输出")
	}
	return string(got), nil
}

func trimOutput(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 4000 {
		s = s[:4000] + "\n…"
	}
	return s
}

// sampleValue is a plausible value for a parameter of the given type.
func sampleValue(p mwpack.Param) any {
	num := func(v any, def float64) float64 {
		switch x := v.(type) {
		case int:
			return float64(x)
		case int64:
			return float64(x)
		case float64:
			return x
		}
		return def
	}
	switch p.Type {
	case "cidr", "cidr-list":
		return "10.0.0.0/24"
	case "ip":
		return "10.0.0.100"
	case "host":
		return "host1"
	case "port":
		return int(num(p.Min, 8080))
	case "int":
		return int(num(p.Min, 1))
	case "float":
		return num(p.Min, 1)
	case "size":
		if s, ok := p.Min.(string); ok && s != "" {
			return s
		}
		return "1GB"
	case "bool":
		return false
	case "enum":
		if len(p.Options) > 0 {
			return p.Options[0]
		}
	}
	if p.Pattern != "" {
		if re, err := regexp.Compile(p.Pattern); err == nil {
			for _, c := range []string{"eth0", "sample.example.com", "sample", "/data/sample", "10.0.0.100", "10.0.0.0/24"} {
				if re.MatchString(c) {
					return c
				}
			}
		}
	}
	// plain text: a domain-like value passes the common "address or name" checks as well as any free text
	return "sample.example.com"
}

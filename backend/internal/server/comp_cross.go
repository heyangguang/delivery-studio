package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing/fstest"

	"delivery-studio/mwpack"
)

// Cross-workbench operations use the same administrator-only route and proposal
// gates as local edits. They never publish or execute generated playbooks.
func (c compToolCtx) targetFiles(name, view string) (fileSet, error) {
	if name != sharedPlatformName {
		if _, ok := c.s.plat.cat().Get(name); !ok {
			return nil, fmt.Errorf("未知组件 %q", name)
		}
	}
	if view != "live" && view != "draft" {
		return nil, fmt.Errorf("view 必须为 live 或 draft")
	}
	if view == "draft" {
		f, _, e := c.s.comps().readDraft(name)
		return f, e
	}
	f, _, e := c.s.comps().liveSet(name)
	return f, e
}

func (c compToolCtx) proposeTarget(name string, a map[string]any) string {
	if _, err := c.targetFiles(name, "live"); err != nil {
		return err.Error()
	}
	compMu.Lock()
	cs := c.s.comps()
	draft, _, err := cs.readDraft(name)
	if err == errNoDraft {
		draft, _, err = cs.liveSet(name)
		if err == nil {
			err = cs.writeDraft(name, draft, draftMeta{Source: "live", BaseRev: cs.liveRev(name), Created: now(), Updated: now(), User: "AI提案"})
		}
	}
	compMu.Unlock()
	if err != nil {
		return "无法准备目标草稿：" + err.Error()
	}
	ids := []string{}
	result := (compToolCtx{s: c.s, name: name, proposed: &ids}).propose(draft, a)
	if len(ids) == 0 {
		return result
	}
	aiMu.Lock()
	sessionPath := filepath.Join(c.s.compAIDir(name), "session.json")
	session := aiSession{Messages: []aiMsg{}}
	if b, e := os.ReadFile(sessionPath); e == nil {
		_ = json.Unmarshal(b, &session)
	}
	session.Messages = append(session.Messages, aiMsg{Role: "assistant", Text: "来自工作台「" + c.name + "」的关联修改提案。采纳只更新本草稿；请联合检查后分别发布。", Proposals: ids, At: now()})
	err = writeJSONFile(sessionPath, session)
	aiMu.Unlock()
	if err != nil {
		return result + "\n展示记录保存失败：" + err.Error()
	}
	return result + "\n请提供[审核关联组件提案](#/components/" + name + "/edit/files)，在新标签页打开。提案未采纳、未发布。"
}

func (c compToolCtx) searchWorkspace(query, view string, offset int) string {
	if strings.TrimSpace(query) == "" {
		return "text 不能为空"
	}
	names := append([]string{sharedPlatformName}, c.s.plat.cat().Names()...)
	var hits []string
	groups := [][]string{}
	for _, name := range names {
		group := []string{}
		f, err := c.targetFiles(name, view)
		if err != nil {
			continue
		}
		for _, p := range f.paths() {
			if !isText(f[p]) {
				continue
			}
			for i, line := range strings.Split(string(f[p]), "\n") {
				if strings.Contains(strings.ToLower(line), strings.ToLower(query)) {
					group = append(group, fmt.Sprintf("%s/%s:%d: %s", name, p, i+1, truncRunes(strings.TrimSpace(line), 180)))
				}
			}
		}
		groups = append(groups, group)
	}
	// Interleave components so a large shared role cannot hide every consumer
	// from the first page. Pagination remains deterministic and complete.
	for i := 0; ; i++ {
		found := false
		for _, group := range groups {
			if i < len(group) {
				hits = append(hits, group[i])
				found = true
			}
		}
		if !found {
			break
		}
	}
	if offset < 0 {
		offset = 0
	}
	if offset > len(hits) {
		offset = len(hits)
	}
	end := offset + 50
	if end > len(hits) {
		end = len(hits)
	}
	return fmt.Sprintf("检索 %s（draft 仅检索已有草稿）；共 %d 处，当前 %d～%d。\n%s\n", view, len(hits), offset, end, strings.Join(hits[offset:end], "\n")) + fmt.Sprintf("继续读取 offset=%d。搜索结果仅用于定位，不代表全部引用都已适配。", end)
}

type crossEntry struct {
	Component string        `json:"component"`
	Kind      string        `json:"kind"` // "static" | "render"
	Preset    string        `json:"preset,omitempty"`
	Status    string        `json:"status"` // "ok" | "error" | "warn"
	Summary   string        `json:"summary"`
	Files     int           `json:"files,omitempty"`
	Problems  []compProblem `json:"problems,omitempty"`
}

type crossResult struct {
	Incomplete bool         `json:"incomplete"`
	OK         bool         `json:"ok"`
	Scope      []string     `json:"scope"`
	Results    []string     `json:"results"`
	Entries    []crossEntry `json:"entries,omitempty"`
}

// Only explicitly selected drafts enter the snapshot. Unrelated drafts never leak
// into generation. All other components stay at their published versions.
func (s *storeServer) crossCheck(names []string) crossResult {
	r := crossResult{OK: true, Scope: []string{}, Results: []string{}, Entries: []crossEntry{}}
	fail := func(e error) crossResult { r.OK = false; r.Results = append(r.Results, e.Error()); return r }
	if len(names) == 0 || len(names) > 32 {
		return fail(fmt.Errorf("请选择1～32份草稿"))
	}
	selected := map[string]bool{}
	for _, n := range names {
		selected[n] = true
	}
	tc := compToolCtx{s: s}
	all := append([]string{sharedPlatformName}, s.plat.cat().Names()...)
	sets := map[string]fileSet{}
	compMu.Lock()
	for _, n := range all {
		view := "live"
		if selected[n] {
			view = "draft"
		}
		f, e := tc.targetFiles(n, view)
		if e != nil {
			compMu.Unlock()
			return fail(fmt.Errorf("%s: %w", n, e))
		}
		sets[n] = f.clone()
		if n == sharedPlatformName {
			refreshSharedManagedFiles(sets[n])
		}
		if selected[n] {
			r.Scope = append(r.Scope, n)
		}
	}
	compMu.Unlock()
	if len(r.Scope) != len(selected) {
		return fail(fmt.Errorf("选择中包含未知组件"))
	}
	mem := fstest.MapFS{}
	for n, f := range sets {
		if n == sharedPlatformName {
			continue
		}
		for p, b := range f {
			mem[n+"/"+p] = &fstest.MapFile{Data: b, Mode: 0600}
		}
	}
	cat, catErr := mwpack.LoadCatalog(mem)
	if catErr == nil {
		cat = cat.WithPlatformFiles(sharedRuntime(sets[sharedPlatformName]))
	}
	// Static checks use an isolated directory, never production drafts or releases.
	dir, e := os.MkdirTemp("", "mw-cross-check-")
	if e != nil {
		return fail(e)
	}
	defer os.RemoveAll(dir)
	for n, f := range sets {
		if n == sharedPlatformName {
			continue
		}
		for p, b := range f {
			target := filepath.Join(dir, n, p)
			if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
				return fail(e)
			}
			if e = os.WriteFile(target, b, 0600); e != nil {
				return fail(e)
			}
		}
	}
	p := &platform{componentsDir: dir}
	if cat != nil {
		p.catalog.Store(cat)
	} else {
		p.catalog.Store(s.plat.cat().WithPlatformFiles(sharedRuntime(sets[sharedPlatformName])))
	}
	staticFailed := false
	for _, n := range r.Scope {
		check := checkComponent(p, n, sets[n])
		if !check.OK {
			staticFailed = true
			r.OK = false
			r.Results = append(r.Results, fmt.Sprintf("%s：%s", n, problemsText(check, nil)))
			r.Entries = append(r.Entries, crossEntry{
				Component: n,
				Kind:      "static",
				Status:    "error",
				Summary:   fmt.Sprintf("静态校验发现 %d 项错误", check.Errors),
				Problems:  check.Problems,
			})
			continue
		}
		status := "ok"
		summary := "静态检查通过"
		if check.Warnings > 0 {
			status = "warn"
			summary = fmt.Sprintf("静态检查通过（%d 项提醒）", check.Warnings)
		}
		r.Results = append(r.Results, n+"："+summary)
		r.Entries = append(r.Entries, crossEntry{
			Component: n,
			Kind:      "static",
			Status:    status,
			Summary:   summary,
			Problems:  check.Problems,
		})
	}
	if staticFailed {
		sort.Strings(r.Scope)
		return r
	}
	if catErr != nil {
		return fail(catErr)
	}
	for _, n := range cat.Names() {
		component, _ := cat.Get(n)
		if component.Detail == nil || len(component.Detail.Presets) == 0 {
			continue
		}
		for _, preset := range component.Detail.Presets {
			bundle, _, _, err := renderSample(cat, n, previewReq{Preset: preset.ID})
			if err != nil {
				_, _, _, baselineErr := renderSample(s.plat.cat(), n, previewReq{Preset: preset.ID})
				if baselineErr != nil && baselineErr.Error() == err.Error() {
					r.Incomplete = true
					msg := "未完成验证（已发布版本也存在相同试生成问题）：" + err.Error()
					r.Results = append(r.Results, n+"/"+preset.ID+"："+msg)
					r.Entries = append(r.Entries, crossEntry{
						Component: n,
						Kind:      "render",
						Preset:    preset.ID,
						Status:    "warn",
						Summary:   msg,
					})
				} else {
					r.OK = false
					r.Results = append(r.Results, n+"/"+preset.ID+"："+err.Error())
					r.Entries = append(r.Entries, crossEntry{
						Component: n,
						Kind:      "render",
						Preset:    preset.ID,
						Status:    "error",
						Summary:   err.Error(),
					})
				}
				continue
			}
			msg := fmt.Sprintf("联合试生成通过（%d 个项目文件）", len(bundle.Project))
			r.Results = append(r.Results, n+"/"+preset.ID+"："+msg)
			r.Entries = append(r.Entries, crossEntry{
				Component: n,
				Kind:      "render",
				Preset:    preset.ID,
				Status:    "ok",
				Summary:   msg,
				Files:     len(bundle.Project),
			})
		}
	}
	r.Results = append(r.Results, "仅检查所选草稿与其余已发布组件的组合；未执行部署、未迁移数据，不代表现场验收通过。")
	sort.Strings(r.Scope)
	return r
}

func (s *storeServer) crossCheckAPI(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Names []string `json:"names"`
	}
	if e := decodeBody(w, r, 8192, &in); e != nil {
		s.fail(w, 400, e.Error())
		return
	}
	res := s.crossCheck(in.Names)
	if lang := wLang(w); isEnLang(lang) {
		if len(res.Results) > 0 {
			out := make([]string, len(res.Results))
			for i, item := range res.Results {
				out[i] = localizeGoMessage(lang, item)
			}
			res.Results = out
		}
		if len(res.Entries) > 0 {
			entries := make([]crossEntry, len(res.Entries))
			for i, e := range res.Entries {
				e.Summary = localizeGoMessage(lang, e.Summary)
				if len(e.Problems) > 0 {
					ps := make([]compProblem, len(e.Problems))
					for j, pr := range e.Problems {
						pr.Message = localizeGoMessage(lang, pr.Message)
						ps[j] = pr
					}
					e.Problems = ps
				}
				entries[i] = e
			}
			res.Entries = entries
		}
	}
	s.writeJSON(w, 200, res)
}

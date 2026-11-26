package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"delivery-studio/mwpack"

	"gopkg.in/yaml.v3"
)

// The component workbench API. Everything under /api/components/{name}/ except the read-only manifest and pack is
// for administrators editing a component: a draft is changed freely, checked and previewed as often as wanted, and
// only publishing changes what deliveries are generated from.

var compMu sync.Mutex // serialises draft writes and publishes

var reservedNames = map[string]bool{sharedPlatformName: true, "new": true, "import": true, "validate": true, "templates": true, "cross-check": true, "ansible": true, "guide": true}

func (s *storeServer) comps() *compStore {
	return &compStore{root: s.plat.componentsDir, builtin: builtinFS(), repo: s.repo}
}

func (s *storeServer) ansible() ansibleEnv { return detectAnsible(s.cfg.AnsibleBin, s.cfg.DataDir) }

func decodeBody(w http.ResponseWriter, r *http.Request, limit int64, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil && !errors.Is(err, fs.ErrNotExist) {
		if err.Error() == "EOF" {
			return nil
		}
		return err
	}
	return nil
}

type fileView struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Size   int    `json:"size"`
	Text   string `json:"text,omitempty"`
	Binary bool   `json:"binary,omitempty"`
}

func viewFiles(set fileSet) []fileView {
	out := []fileView{}
	for _, p := range set.paths() {
		v := fileView{Path: p, Kind: fileKind(p), Size: len(set[p])}
		if isText(set[p]) {
			v.Text = string(set[p])
		} else {
			v.Binary = true
		}
		out = append(out, v)
	}
	return out
}

// workbench routes the editing endpoints; ok is false when the path is not one of them.
func (s *storeServer) workbench(w http.ResponseWriter, r *http.Request, session storeSession, parts []string) bool {
	switch {
	case len(parts) == 1 && parts[0] == "cross-check" && r.Method == "POST":
		s.adminOnly(w, session, func() { s.crossCheckAPI(w, r) })
		return true
	case len(parts) == 1 && parts[0] == "templates" && r.Method == "GET":
		s.writeJSON(w, 200, localizedSkeletonKinds(wLang(w)))
		return true
	case len(parts) == 1 && parts[0] == "ansible" && r.Method == "GET":
		s.writeJSON(w, 200, s.ansible())
		return true
	case len(parts) == 1 && parts[0] == "new" && r.Method == "POST":
		s.adminOnly(w, session, func() { s.newComponent(w, r, session) })
		return true
	}
	if len(parts) < 2 {
		return false
	}
	name, what := parts[0], parts[1]
	if name == sharedPlatformName && (what == "fork" || what == "versions") {
		s.fail(w, 400, "平台公共流程使用独立修订，不支持组件派生或软件版本操作")
		return true
	}
	switch {
	case what == "workspace" && len(parts) == 2 && r.Method == "GET":
		s.adminOnly(w, session, func() { s.workspace(w, name) })
	case what == "draft" && len(parts) == 2:
		s.adminOnly(w, session, func() {
			switch r.Method {
			case "GET":
				s.getDraft(w, name)
			case "POST":
				s.startDraft(w, r, session, name)
			case "PUT":
				s.saveDraft(w, r, session, name)
			case "DELETE":
				s.dropDraft(w, r, session, name)
			default:
				s.fail(w, 405, "方法不允许")
			}
		})
	case what == "draft" && len(parts) == 3 && r.Method == "POST":
		s.adminOnly(w, session, func() { s.draftAction(w, r, session, name, parts[2]) })
	case what == "revisions" && len(parts) == 2 && r.Method == "GET":
		s.adminOnly(w, session, func() { s.writeJSON(w, 200, s.comps().revisions(name)) })
	case what == "revisions" && len(parts) == 3 && r.Method == "GET":
		s.adminOnly(w, session, func() { s.getRevision(w, name, parts[2]) })
	case what == "revisions" && len(parts) == 4 && parts[3] == "restore" && r.Method == "POST":
		s.adminOnly(w, session, func() { s.restoreRevision(w, r, session, name, parts[2]) })
	case what == "versions" && len(parts) == 4 && parts[3] == "status" && r.Method == "POST":
		s.adminOnly(w, session, func() { s.setVersionStatus(w, r, session, name, parts[2]) })
	case what == "ai" && len(parts) >= 3:
		s.adminOnly(w, session, func() { s.handleCompAI(w, r, session, name, parts[2:]) })
	case what == "fork" && len(parts) == 2 && r.Method == "POST":
		s.adminOnly(w, session, func() { s.forkComponent(w, r, session, name) })
	default:
		return false
	}
	return true
}

func (s *storeServer) adminOnly(w http.ResponseWriter, session storeSession, f func()) {
	if !s.can(session.User, "component.edit") {
		s.fail(w, 403, "没有「编辑组件」权限")
		return
	}
	if s.plat.componentsDir == "" {
		s.fail(w, 409, "服务没有配置组件目录（components_dir），不能编辑组件")
		return
	}
	f()
}

type workspaceResp struct {
	Name      string      `json:"name"`
	Exists    bool        `json:"exists"` // published (custom or built-in)
	Source    string      `json:"source"` // builtin | custom | override | none
	Rev       int         `json:"rev"`
	Draft     draftStatus `json:"draft"`
	Revisions []revMeta   `json:"revisions"`
	Ansible   ansibleEnv  `json:"ansible"`
	Builtin   bool        `json:"builtin"`
}

func (s *storeServer) workspace(w http.ResponseWriter, name string) {
	if !safeName(name) {
		s.fail(w, 404, "组件不存在")
		return
	}
	cs := s.comps()
	resp := workspaceResp{Name: name, Source: "none", Draft: cs.status(name), Revisions: cs.revisions(name), Ansible: s.ansible()}
	if resp.Revisions == nil {
		resp.Revisions = []revMeta{}
	}
	if _, src, err := cs.liveSet(name); err == nil {
		resp.Exists, resp.Source = true, src
	}
	_, resp.Builtin = builtinNamesIn(cs.builtin)[name]
	if name == sharedPlatformName {
		resp.Builtin = true
	}
	resp.Rev = cs.liveRev(name)
	if !resp.Exists && !resp.Draft.Exists {
		s.fail(w, 404, "组件不存在")
		return
	}
	s.writeJSON(w, 200, resp)
}

func (s *storeServer) getDraft(w http.ResponseWriter, name string) {
	if !safeName(name) {
		s.fail(w, 404, "组件不存在")
		return
	}
	set, meta, err := s.comps().readDraft(name)
	if err != nil {
		s.fail(w, 404, "还没有草稿")
		return
	}
	s.writeJSON(w, 200, map[string]any{"meta": meta, "files": viewFiles(set)})
}

type startReq struct {
	From string `json:"from"` // live (default) | builtin | revision
	Rev  int    `json:"rev"`
}

// startDraft opens a draft of a published component, its built-in original, or an older revision.
func (s *storeServer) startDraft(w http.ResponseWriter, r *http.Request, session storeSession, name string) {
	var req startReq
	if err := decodeBody(w, r, 1<<16, &req); err != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	if !safeName(name) {
		s.fail(w, 404, "组件不存在")
		return
	}
	compMu.Lock()
	defer compMu.Unlock()
	cs := s.comps()
	if cs.hasDraft(name) {
		s.fail(w, 409, "已经有草稿了")
		return
	}
	var set fileSet
	var err error
	src := "live"
	switch req.From {
	case "", "live":
		set, _, err = cs.liveSet(name)
	case "builtin":
		set, err = cs.builtinSet(name)
		src = "builtin"
	case "revision":
		set, err = cs.revisionSet(name, req.Rev)
		src = "revision:" + strconv.Itoa(req.Rev)
	default:
		s.fail(w, 400, "from 只能是 live、builtin 或 revision")
		return
	}
	if err != nil {
		s.fail(w, 404, "找不到要编辑的内容")
		return
	}
	s.archiveCompAI(name, "新草稿开始前", 0)
	meta := draftMeta{Source: src, BaseRev: cs.liveRev(name), Created: now(), Updated: now(), User: session.User}
	if err := cs.writeDraft(name, set, meta); err != nil {
		s.fail(w, 500, "无法创建草稿："+err.Error())
		return
	}
	s.auditReq(r, "component-draft-start", session.User, name)
	s.getDraft(w, name)
}

type saveReq struct {
	// Files maps a path to its new text; null deletes the file.
	Files map[string]*string `json:"files"`
	// Rename moves files: old path to new path.
	Rename map[string]string `json:"rename"`
	// IfUpdated is the draft's Updated stamp the editor last saw; a different one means someone else saved meanwhile.
	IfUpdated string `json:"if_updated"`
}

func (s *storeServer) saveDraft(w http.ResponseWriter, r *http.Request, session storeSession, name string) {
	var req saveReq
	if err := decodeBody(w, r, maxPackBytes+(1<<20), &req); err != nil {
		s.fail(w, 400, "提交的内容有问题，或者超过了 8 MiB")
		return
	}
	if !safeName(name) {
		s.fail(w, 404, "组件不存在")
		return
	}
	compMu.Lock()
	defer compMu.Unlock()
	cs := s.comps()
	set, meta, err := cs.readDraft(name)
	if err != nil {
		s.fail(w, 404, "还没有草稿")
		return
	}
	if req.IfUpdated != "" && req.IfUpdated != meta.Updated {
		s.fail(w, 409, "草稿已被别处保存过（"+meta.User+"），请刷新后再改")
		return
	}
	for from, to := range req.Rename {
		if name == sharedPlatformName && (from == "component.yaml" || from == "files/platform-contract.md" || to == "component.yaml" || to == "files/platform-contract.md") {
			s.fail(w, 400, "平台标识与参数契约由平台代码维护，不能在角色编辑器修改")
			return
		}
		b, ok := set[from]
		if !ok {
			s.fail(w, 400, "要改名的文件不存在："+from)
			return
		}
		if _, exists := set[to]; exists {
			s.fail(w, 400, "目标文件已存在："+to)
			return
		}
		delete(set, from)
		set[to] = b
	}
	deleted := map[string]bool{}
	for p, text := range req.Files {
		if name == sharedPlatformName && (p == "component.yaml" || p == "files/platform-contract.md") {
			want := sharedManifest
			if p == "files/platform-contract.md" {
				want = sharedContract
			}
			if text == nil || *text != want {
				s.fail(w, 400, "平台标识与参数契约由平台代码维护，不能在角色编辑器修改")
				return
			}
			continue
		}
		if text == nil {
			if p == "component.yaml" {
				s.fail(w, 400, "component.yaml 不能删除")
				return
			}
			delete(set, p)
			deleted[p] = true
			continue
		}
		if err := validFilePath(p); err != nil {
			s.fail(w, 400, err.Error())
			return
		}
		set[p] = []byte(*text)
	}
	if _, explicitManifest := req.Files["component.yaml"]; !explicitManifest {
		syncSharedFiles(set, req.Rename, deleted)
	}
	meta.Updated, meta.User = now(), session.User
	if err := cs.writeDraft(name, set, meta); err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	s.writeJSON(w, 200, map[string]any{"meta": meta, "status": cs.status(name)})
}

func (s *storeServer) dropDraft(w http.ResponseWriter, r *http.Request, session storeSession, name string) {
	if !safeName(name) {
		s.fail(w, 404, "组件不存在")
		return
	}
	compMu.Lock()
	defer compMu.Unlock()
	s.archiveCompAI(name, "草稿被放弃", 0)
	if err := s.comps().discardDraft(name); err != nil {
		s.fail(w, 500, "放弃草稿失败")
		return
	}
	s.auditReq(r, "component-draft-drop", session.User, name)
	s.writeJSON(w, 200, map[string]bool{"ok": true})
}

type actionReq struct {
	DeliveryModes []string `json:"delivery_modes"`
	IfUpdated     string   `json:"if_updated"`
	previewReq
	Note     string `json:"note"`
	Force    bool   `json:"force"`
	Template string `json:"template"`
	Host     string `json:"host"`
	// File and Message name a warning to set aside (action "ignore"); Undo takes the decision back.
	File    string `json:"file"`
	Message string `json:"message"`
	Reason  string `json:"reason"`
	Undo    bool   `json:"undo"`
}

func (s *storeServer) draftAction(w http.ResponseWriter, r *http.Request, session storeSession, name, action string) {
	var req actionReq
	if err := decodeBody(w, r, 1<<16, &req); err != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	if !safeName(name) {
		s.fail(w, 404, "组件不存在")
		return
	}
	if action == "leave" {
		s.leaveDraft(w, r, session, name, req)
		return
	}
	cs := s.comps()
	set, draftMeta, err := cs.readDraft(name)
	if err != nil {
		s.fail(w, 404, "还没有草稿")
		return
	}
	switch action {
	case "check":
		s.writeJSON(w, 200, localizeCompCheck(wLang(w), checkComponent(s.plat, name, set).ignoring(s.compIgnored(name))))
	case "ignore":
		// a warning the person has looked at and decided is fine, or taking that back
		in := struct {
			File, Message, Reason string
			Undo                  bool
		}{req.File, req.Message, req.Reason, req.Undo}
		if in.Message == "" {
			s.fail(w, 400, "没有指明要忽略哪一条提示")
			return
		}
		list := s.loadCompIgnores(name)
		key := in.File + "|" + in.Message
		out := list[:0:0]
		for _, x := range list {
			if x.File+"|"+x.Message != key {
				out = append(out, x)
			}
		}
		if !in.Undo {
			out = append(out, compIgnore{File: in.File, Message: in.Message, Reason: truncRunes(strings.TrimSpace(in.Reason), 200), By: session.User, At: now()})
		}
		if err := s.saveCompIgnores(name, out); err != nil {
			s.fail(w, 500, "无法保存")
			return
		}
		s.auditReq(r, "component-warning-ignore", session.User, name+" "+key+map[bool]string{true: " 取消", false: ""}[in.Undo])
		s.writeJSON(w, 200, localizeCompCheck(wLang(w), checkComponent(s.plat, name, set).ignoring(s.compIgnored(name))))
	case "preview":
		live, _, _ := cs.liveSet(name)
		s.writeJSON(w, 200, localizePreviewResp(wLang(w), previewComponent(s.plat, s.ansible(), name, set, live, req.previewReq)))
	case "diff":
		live, _, _ := cs.liveSet(name)
		type fileDiff struct {
			Path   string `json:"path"`
			Status string `json:"status"`
			Diff   string `json:"diff,omitempty"`
		}
		out := []fileDiff{}
		added, removed, changed := diffSets(live, set)
		for _, p := range added {
			out = append(out, fileDiff{p, "added", lineDiff("", string(set[p]), 150)})
		}
		for _, p := range changed {
			out = append(out, fileDiff{p, "changed", lineDiff(string(live[p]), string(set[p]), 250)})
		}
		for _, p := range removed {
			out = append(out, fileDiff{p, "removed", ""})
		}
		modes := []string{}
		problems := []mwpack.Problem{}
		configurationProblems := []mwpack.Problem{}
		if name != sharedPlatformName {
			if c, e := set.component(); e == nil {
				modes = c.EffectiveDeliveryModes()
				c.DeliveryModes = []string{"automatic"}
				problems = mwpack.ValidateDeliveryModes(c)
				c.DeliveryModes = []string{"configuration"}
				configurationProblems = mwpack.ValidateConfiguration(c)
			}
		}
		lang := wLang(w)
		s.writeJSON(w, 200, map[string]any{
			"diffs":                  out,
			"updated":                draftMeta.Updated,
			"delivery_modes":         modes,
			"automatic_problems":     localizeMWProblems(lang, problems),
			"configuration_problems": localizeMWProblems(lang, configurationProblems),
		})
	case "note":
		if code, msg := s.checkAIFeature(session.User, "component"); code != 0 {
			s.fail(w, code, msg)
			return
		}
		// a revision note written from what actually changed, for the person to keep or edit
		live, _, _ := cs.liveSet(name)
		added, removed, changed := diffSets(live, set)
		var b strings.Builder
		for _, p := range added {
			b.WriteString("新增文件 " + p + "\n" + truncRunes(lineDiff("", string(set[p]), 60), 1500) + "\n")
		}
		for _, p := range changed {
			b.WriteString("修改文件 " + p + "\n" + truncRunes(lineDiff(string(live[p]), string(set[p]), 150), 4000) + "\n")
		}
		for _, p := range removed {
			b.WriteString("删除文件 " + p + "\n")
		}
		if b.Len() == 0 {
			s.fail(w, 409, "草稿和已发布的内容一样，没有可说明的改动")
			return
		}
		st := s.aiLoad()
		providers := st.aiProvidersFor("component")
		if len(providers) == 0 {
			s.fail(w, 409, "没有可用的模型供应商")
			return
		}
		pr := providers[0]
		noteSys := tr(wLang(w),
			"你根据组件草稿相对已发布版本的差异，写一句修订说明给运维同事看：改了什么、为什么（能从改动看出来的话）。中文，不超过 80 字，不要列文件名，不要加引号和前缀，只输出这句话。",
			"Write one concise revision note for operations engineers explaining what changed between the component draft and published version and why. In English, under 160 characters, omit filenames, quotes, and prefixes; output only the sentence.",
		)
		rep, err := s.aiChat(r.Context(), pr, []aiMessage{
			{Role: "system", Content: noteSys},
			{Role: "user", Content: "组件：" + name + "\n" + aiScrub(truncRunes(b.String(), 12000))},
		}, nil, nil)
		u := usageFrom(pr, rep)
		u.User, u.Feature, u.Target, u.OK = session.User, "component", name, err == nil
		s.aiRecordUsage(u)
		if err != nil {
			s.fail(w, 502, "AI 暂时没有回应："+err.Error())
			return
		}
		s.writeJSON(w, 200, map[string]string{"note": truncRunes(strings.Trim(strings.TrimSpace(rep.Text), "\"“”「」"), 200)})
	case "render":
		out, err := renderTemplate(s.plat, s.ansible(), name, set, req.Template, req.previewReq, req.Host)
		if err != nil {
			s.writeJSON(w, 200, map[string]any{"ok": false, "error": localizeGoMessage(wLang(w), err.Error())})
			return
		}
		s.writeJSON(w, 200, map[string]any{"ok": true, "text": out})
	case "publish":
		s.publish(w, r, session, name, req)
	default:
		s.fail(w, 404, "接口不存在")
	}
}

// recordPublish stores the revision history for a change of the published component. When the component has never
// been published through the workbench, what was there before becomes revision 1, so there is something to return to.
func (cs *compStore) recordPublish(name string, prev, files fileSet, user, note string) (int, error) {
	if cs.liveRev(name) == 0 && prev != nil {
		if _, err := cs.snapshot(name, prev, nil, "系统", "发布前的版本"); err != nil {
			return 0, err
		}
	}
	return cs.snapshot(name, files, prev, user, note)
}

func (s *storeServer) publish(w http.ResponseWriter, r *http.Request, session storeSession, name string, req actionReq) {
	if name == sharedPlatformName && !s.need(w, session.User, "component.publish") {
		return
	}
	compMu.Lock()
	defer compMu.Unlock()
	cs := s.comps()
	set, meta, err := cs.readDraft(name)
	if err != nil {
		s.fail(w, 404, "还没有草稿")
		return
	}
	if req.IfUpdated != "" && req.IfUpdated != meta.Updated {
		s.fail(w, 409, "草稿在你查看修改后又被更新，请关闭发布窗口，刷新并重新核对修改")
		return
	}
	if len([]rune(strings.TrimSpace(req.Note))) > 200 {
		s.fail(w, 400, "说明过长（200 字以内）")
		return
	}
	if cs.liveRev(name) != meta.BaseRev && !req.Force {
		s.fail(w, 409, "已发布的内容在这个草稿创建之后又变化过，直接发布会覆盖那次修改。请先对照确认，或选择强制发布")
		return
	}
	if req.DeliveryModes != nil && name != sharedPlatformName {
		if len(req.DeliveryModes) == 0 {
			s.fail(w, 400, "至少选择一种交付方式")
			return
		}
		if err := setDeliveryModes(set, req.DeliveryModes); err != nil {
			s.fail(w, 400, err.Error())
			return
		}
	}
	res := checkComponent(s.plat, name, set)
	if !res.OK {
		lang := wLang(w)
		s.writeJSON(w, 422, map[string]any{"error": localizeGoMessage(lang, fmt.Sprintf("还有 %d 处错误，不能发布", res.Errors)), "check": localizeCompCheck(lang, res)})
		return
	}
	if name == sharedPlatformName {
		preview := previewSharedPlatform(s.plat, s.ansible(), set, nil)
		if !preview.OK {
			s.fail(w, 422, preview.Error)
			return
		}
	}
	prev, _, _ := cs.liveSet(name)
	done, err := cs.installLive(name, set, s.plat.reload)
	if err != nil {
		s.fail(w, 500, "发布失败，已恢复原状："+err.Error())
		return
	}
	done()
	rev, err := cs.recordPublish(name, prev, set, session.User, strings.TrimSpace(req.Note))
	if err != nil {
		s.fail(w, 500, "已发布，但记录修订失败："+err.Error())
		return
	}
	s.archiveCompAI(name, "发布为修订 "+strconv.Itoa(rev), rev)
	_ = cs.discardDraft(name)
	s.auditReq(r, "component-publish", session.User, name+"#"+strconv.Itoa(rev))
	s.writeJSON(w, 200, map[string]any{"ok": true, "rev": rev, "warnings": res.Warnings})
}

func (s *storeServer) getRevision(w http.ResponseWriter, name, num string) {
	n, err := strconv.Atoi(num)
	if err != nil || !safeName(name) {
		s.fail(w, 404, "修订不存在")
		return
	}
	cs := s.comps()
	set, err := cs.revisionSet(name, n)
	if err != nil {
		s.fail(w, 404, "修订不存在")
		return
	}
	// The diff is against the revision before it, so each revision reads as "what this publish changed".
	var prev fileSet
	if n > 1 {
		prev, _ = cs.revisionSet(name, n-1)
	}
	type fileDiff struct {
		Path   string `json:"path"`
		Status string `json:"status"`
		Diff   string `json:"diff,omitempty"`
	}
	var diffs []fileDiff
	added, removed, changed := diffSets(prev, set)
	for _, p := range added {
		diffs = append(diffs, fileDiff{p, "added", lineDiff("", string(set[p]), 120)})
	}
	for _, p := range changed {
		diffs = append(diffs, fileDiff{p, "changed", lineDiff(string(prev[p]), string(set[p]), 200)})
	}
	for _, p := range removed {
		diffs = append(diffs, fileDiff{p, "removed", ""})
	}
	if diffs == nil {
		diffs = []fileDiff{}
	}
	var meta revMeta
	for _, m := range cs.revisions(name) {
		if m.Rev == n {
			meta = m
		}
	}
	s.writeJSON(w, 200, map[string]any{"meta": meta, "diffs": diffs})
}

func (s *storeServer) restoreRevision(w http.ResponseWriter, r *http.Request, session storeSession, name, num string) {
	var req struct {
		Replace bool `json:"replace"`
	}
	_ = decodeBody(w, r, 1<<12, &req)
	n, err := strconv.Atoi(num)
	if err != nil || !safeName(name) {
		s.fail(w, 404, "修订不存在")
		return
	}
	compMu.Lock()
	defer compMu.Unlock()
	cs := s.comps()
	set, err := cs.revisionSet(name, n)
	if err != nil {
		s.fail(w, 404, "修订不存在")
		return
	}
	if cs.hasDraft(name) && !req.Replace {
		s.fail(w, 409, "已经有草稿；恢复会替换草稿里的全部修改")
		return
	}
	meta := draftMeta{Source: "revision:" + strconv.Itoa(n), BaseRev: cs.liveRev(name), Created: now(), Updated: now(), User: session.User}
	if err := cs.writeDraft(name, set, meta); err != nil {
		s.fail(w, 500, "无法创建草稿："+err.Error())
		return
	}
	s.auditReq(r, "component-restore", session.User, name+"#"+num)
	s.getDraft(w, name)
}

// newComponent creates a draft of a component that does not exist yet, from a skeleton.
func (s *storeServer) newComponent(w http.ResponseWriter, r *http.Request, session storeSession) {
	var o skeletonOpts
	if err := decodeBody(w, r, 1<<16, &o); err != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	if reservedNames[o.Name] {
		s.fail(w, 400, "这个名字被保留了，请换一个")
		return
	}
	files, err := buildSkeleton(o)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	if err := files.splitManifest(); err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	s.createDraftFor(w, r, session, o.Name, files, "template:"+o.Kind)
}

func (s *storeServer) createDraftFor(w http.ResponseWriter, r *http.Request, session storeSession, name string, files fileSet, source string) {
	compMu.Lock()
	defer compMu.Unlock()
	cs := s.comps()
	if _, _, err := cs.liveSet(name); err == nil {
		s.fail(w, 409, "已有同名组件："+name)
		return
	}
	if cs.hasDraft(name) {
		s.fail(w, 409, "已有同名草稿："+name)
		return
	}
	if _, broken := brokenNames(s.plat)[name]; broken {
		s.fail(w, 409, "已有同名但无法载入的组件，请先修复或删除它："+name)
		return
	}
	s.archiveCompAI(name, "新草稿开始前", 0)
	meta := draftMeta{Source: source, Created: now(), Updated: now(), User: session.User}
	if err := cs.writeDraft(name, files, meta); err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	s.auditReq(r, "component-draft-start", session.User, name)
	s.writeJSON(w, 200, map[string]any{"name": name})
}

func brokenNames(p *platform) map[string]struct{} {
	out := map[string]struct{}{}
	for _, b := range p.brokenList() {
		out[b.Name] = struct{}{}
	}
	return out
}

// forkComponent copies a component under a new name, renaming the role directory that carries the old name.
func (s *storeServer) forkComponent(w http.ResponseWriter, r *http.Request, session storeSession, from string) {
	var req struct {
		Name  string `json:"name"`
		Title string `json:"title"`
	}
	if err := decodeBody(w, r, 1<<16, &req); err != nil {
		s.fail(w, 400, "提交的内容有问题，请刷新页面后重试")
		return
	}
	if !nameRE.MatchString(req.Name) || reservedNames[req.Name] {
		s.fail(w, 400, "组件名要用小写字母开头，只含小写字母、数字和短横线")
		return
	}
	set, _, err := s.comps().liveSet(from)
	if err != nil {
		s.fail(w, 404, "组件不存在")
		return
	}
	out, err := renameComponent(set, from, req.Name, req.Title)
	if err != nil {
		s.fail(w, 400, err.Error())
		return
	}
	s.createDraftFor(w, r, session, req.Name, out, "fork:"+from)
}

var (
	topLineRE = func(key string) *regexp.Regexp { return regexp.MustCompile(`(?m)^` + key + `:.*$`) }
)

// renameComponent edits the manifest text (not the parsed document) so comments and layout survive.
func renameComponent(set fileSet, from, to, title string) (fileSet, error) {
	out := fileSet{}
	for p, b := range set {
		if strings.HasPrefix(p, "roles/"+from+"/") {
			p = "roles/" + to + strings.TrimPrefix(p, "roles/"+from)
		}
		out[p] = b
	}
	m := string(out["component.yaml"])
	if !topLineRE("component").MatchString(m) {
		return nil, errors.New("component.yaml 里找不到 component: 一行")
	}
	m = topLineRE("component").ReplaceAllString(m, "component: "+to)
	if topLineRE("short").MatchString(m) {
		m = topLineRE("short").ReplaceAllString(m, "short: "+to)
	}
	if strings.TrimSpace(title) != "" {
		m = topLineRE("title").ReplaceAllString(m, "title: "+yamlQuote(strings.TrimSpace(title)))
	}
	m = regexp.MustCompile(`\brole:(\s*)`+regexp.QuoteMeta(from)+`\b`).ReplaceAllString(m, "role:${1}"+to)
	out["component.yaml"] = []byte(m)
	// Self-owned acceptance references follow a fork, while references to
	// dependencies keep their original component identity.
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(m), &document); err != nil {
		return nil, err
	}
	lines := strings.Split(m, "\n")
	walkYAML(&document, func(fields map[string]*yaml.Node) {
		if acceptance := fields["acceptance"]; acceptance != nil && acceptance.Kind == yaml.SequenceNode {
			for _, ref := range acceptance.Content {
				if ref.Kind == yaml.ScalarNode && strings.HasPrefix(ref.Value, from+"/") && ref.Line > 0 {
					lines[ref.Line-1] = strings.ReplaceAll(lines[ref.Line-1], from+"/", to+"/")
				}
			}
		}
	})
	m = strings.Join(lines, "\n")
	// Shared source declarations follow the role directory when a component is forked.
	out["component.yaml"] = []byte(strings.ReplaceAll(m, "roles/"+from+"/", "roles/"+to+"/"))
	for file, content := range out {
		if strings.HasPrefix(file, "manifest/") {
			text := strings.ReplaceAll(string(content), "roles/"+from+"/", "roles/"+to+"/")
			text = regexp.MustCompile("\\brole:(\\s*)"+regexp.QuoteMeta(from)+"\\b").ReplaceAllString(text, "role:"+"$"+"{1}"+to)
			// Rewrite only acceptance entries, not arbitrary identifiers.
			var doc yaml.Node
			if yaml.Unmarshal([]byte(text), &doc) == nil {
				lines := strings.Split(text, "\n")
				walkYAML(&doc, func(fields map[string]*yaml.Node) {
					if n := fields["acceptance"]; n != nil && n.Kind == yaml.SequenceNode {
						for _, ref := range n.Content {
							if strings.HasPrefix(ref.Value, from+"/") {
								lines[ref.Line-1] = strings.ReplaceAll(lines[ref.Line-1], from+"/", to+"/")
							}
						}
					}
				})
				text = strings.Join(lines, "\n")
			}
			out[file] = []byte(text)
		}
	}
	return out, out.check()
}

func yamlQuote(s string) string {
	if regexp.MustCompile(`^[\p{L}\p{N} _.()（）-]+$`).MatchString(s) {
		return s
	}
	return strconv.Quote(s)
}

var _ = os.ErrNotExist
var _ = mwpack.DefaultPlatform

// setVersionStatus manages the simplified 2-state OS-granular release lifecycle of a component version (unpublished <-> published).
// Component publishing is completely decoupled from delivery records and supports two transparent testing modes:
//   - "automatic": backed by a self-contained automated execution report captured when all deploy/test steps pass;
//   - "manual"   : human sign-off after offline/manual testing (no automated report).
func (s *storeServer) setVersionStatus(w http.ResponseWriter, r *http.Request, session storeSession, name, ver string) {
	var req struct {
		Status         string   `json:"status"`
		Platform       string   `json:"platform"`
		Platforms      []string `json:"platforms"`
		TestMode       string   `json:"test_mode"` // automatic | manual
		RevokePlatform string   `json:"revoke_platform"`
		Note           string   `json:"note"`
	}
	if decodeBody(w, r, 1<<12, &req) != nil || !safeName(name) {
		s.fail(w, 400, "请求内容有问题")
		return
	}
	req.Platform = strings.TrimSpace(req.Platform)
	req.RevokePlatform = strings.TrimSpace(req.RevokePlatform)
	req.TestMode = strings.ToLower(strings.TrimSpace(req.TestMode))
	note := strings.TrimSpace(req.Note)
	if len([]rune(note)) > 200 {
		s.fail(w, 400, "说明过长（200 字以内）")
		return
	}
	if req.RevokePlatform == "" && req.Status != "draft" && req.Status != "verifying" && req.Status != "published" {
		s.fail(w, 400, "状态只能是未发布或已发布")
		return
	}
	if req.TestMode != "" && req.TestMode != "automatic" && req.TestMode != "manual" {
		s.fail(w, 400, "测试方式只能是自动化测试（automatic）或手动测试（manual）")
		return
	}
	if (req.Status == "published" || req.RevokePlatform != "") && !s.need(w, session.User, "component.publish") {
		return
	}

	// Validate component + version & resolve OS platforms before locking compMu.
	compObj, ok := s.plat.cat().Get(name)
	if !ok {
		s.fail(w, 404, "找不到这个组件")
		return
	}
	resolved, err := compObj.Resolve(ver)
	if err != nil {
		s.fail(w, 404, "这个组件没有这个版本")
		return
	}

	var targetPlatforms []string
	if req.Status == "published" && req.RevokePlatform == "" && len(resolved.Platforms) > 0 {
		seen := map[string]bool{}
		for _, p := range req.Platforms {
			p = strings.TrimSpace(p)
			if p != "" && !seen[p] {
				seen[p] = true
				targetPlatforms = append(targetPlatforms, p)
			}
		}
		if req.Platform != "" && !seen[req.Platform] {
			seen[req.Platform] = true
			targetPlatforms = append(targetPlatforms, req.Platform)
		}
		if len(targetPlatforms) == 0 && len(resolved.Platforms) == 1 {
			targetPlatforms = []string{resolved.Platforms[0]}
		}
		if len(targetPlatforms) == 0 {
			s.fail(w, 400, "请至少选择一个要发布的操作系统")
			return
		}
		allowedPl := map[string]bool{}
		for _, pl := range resolved.Platforms {
			allowedPl[pl] = true
		}
		for _, pl := range targetPlatforms {
			if !allowedPl[pl] {
				s.fail(w, 400, "该版本未声明支持操作系统「"+pl+"」")
				return
			}
		}
	}

	// Load existing automated test reports (if any) when publishing.
	existingByPl := map[string]compVerification{}
	if req.Status == "published" && req.RevokePlatform == "" && len(targetPlatforms) > 0 {
		compVerifyMu.Lock()
		recs := s.loadCompVerifications(name)
		compVerifyMu.Unlock()
		for _, rec := range s.enrichVerifications(name, recs) {
			if rec.Version == ver {
				if _, exists := existingByPl[rec.Platform]; !exists {
					existingByPl[rec.Platform] = rec
				}
			}
		}
		if req.TestMode == "" {
			allAuto := true
			for _, pl := range targetPlatforms {
				rec, ok := existingByPl[pl]
				if !ok || !rec.HasReport {
					allAuto = false
					break
				}
			}
			if allAuto {
				req.TestMode = "automatic"
			} else {
				req.TestMode = "manual"
			}
		}
		if req.TestMode == "automatic" {
			for _, pl := range targetPlatforms {
				rec, ok := existingByPl[pl]
				if !ok || !rec.HasReport {
					plTitle := pl
					if def, ok2 := mwpack.PlatformByID(pl); ok2 {
						plTitle = def.Title
					}
					s.fail(w, 400, fmt.Sprintf("「%s」暂无通过的自动化测试报告，请先点击「测试部署」完成自动化测试，或改选「手动测试」发布", plTitle))
					return
				}
			}
		}
		if cves := s.publishSecurityGateIssues(name, ver, targetPlatforms); len(cves) > 0 {
			s.fail(w, 409, "安全门禁已阻断发布：存在未豁免的严重 (Critical) CVE 漏洞："+strings.Join(cves, "、")+"。请先升级修复软件包，或在「安全中心」完成评估与豁免后再发布")
			return
		}
	}

	compMu.Lock()
	defer compMu.Unlock()
	cs := s.comps()
	if cs.hasDraft(name) {
		s.fail(w, 409, "这个组件有未发布的草稿。先发布或放弃草稿，再改版本状态，避免两边互相覆盖")
		return
	}
	prev, _, err := cs.liveSet(name)
	if err != nil || prev == nil {
		s.fail(w, 404, "找不到这个组件")
		return
	}
	expanded, origins, expandErr := mwpack.ExpandManifest(prev.manifestRead)
	if expandErr != nil {
		s.fail(w, 422, expandErr.Error())
		return
	}
	doc := *expanded
	var vs *yaml.Node
	for i := 0; i+1 < len(doc.Content[0].Content); i += 2 {
		if doc.Content[0].Content[i].Value == "versions" {
			vs = doc.Content[0].Content[i+1]
		}
	}
	var targetVer *yaml.Node
	if vs != nil {
		for _, v := range vs.Content {
			for i := 0; i+1 < len(v.Content); i += 2 {
				if v.Content[i].Value == "id" && v.Content[i+1].Value == ver {
					targetVer = v
					break
				}
			}
		}
	}
	if targetVer == nil {
		s.fail(w, 404, "这个组件没有这个版本")
		return
	}
	file := origins[targetVer]
	if file == "" {
		file = "component.yaml"
	}
	updatedYAML, changed, mutErr := mutateVersionYAMLNode(prev[file], ver, req.Status, targetPlatforms, req.RevokePlatform, resolved.Platforms)
	if mutErr != nil {
		s.fail(w, 422, mutErr.Error())
		return
	}

	recordPublishVouchers := func() []compVerification {
		if req.Status != "published" || req.RevokePlatform != "" || len(targetPlatforms) == 0 {
			return nil
		}
		curHash := s.currentManifestHash(name)
		saved := make([]compVerification, 0, len(targetPlatforms))
		ts := now()
		for _, pl := range targetPlatforms {
			plTitle := pl
			if def, ok := mwpack.PlatformByID(pl); ok {
				plTitle = def.Title
			}
			if req.TestMode == "automatic" {
				rec := existingByPl[pl]
				rec.Component = name
				rec.Version = ver
				rec.Platform = pl
				rec.PlatformName = plTitle
				rec.TestMode = "automatic"
				rec.DeliveryMode = "automatic"
				rec.HasReport = true
				rec.VerifiedBy = session.User
				if note != "" {
					rec.Note = note
				}
				if rec.ManifestHash == "" {
					rec.ManifestHash = curHash
				}
				_ = s.appendCompVerification(rec)
				saved = append(saved, rec)
			} else {
				rec := compVerification{
					ID:           randomStoreToken(6),
					Component:    name,
					Version:      ver,
					Platform:     pl,
					PlatformName: plTitle,
					TestMode:     "manual",
					HasReport:    false,
					ManifestHash: curHash,
					VerifiedBy:   session.User,
					VerifiedAt:   ts,
					Note:         note,
				}
				_ = s.appendCompVerification(rec)
				saved = append(saved, rec)
			}
		}
		return saved
	}

	if !changed {
		if req.Status == "published" && req.RevokePlatform == "" && len(targetPlatforms) > 0 {
			saved := recordPublishVouchers()
			s.auditReq(r, "component-version-verify", session.User, name+" "+ver+" "+strings.Join(targetPlatforms, ",")+" "+req.TestMode)
			s.writeJSON(w, 200, map[string]any{"ok": true, "verifications": saved})
			return
		}
		s.writeJSON(w, 200, map[string]any{"ok": true, "unchanged": true})
		return
	}

	set := fileSet{}
	for k, v := range prev {
		set[k] = v
	}
	set[file] = updatedYAML
	res := checkComponent(s.plat, name, set)
	if !res.OK {
		lang := wLang(w)
		s.writeJSON(w, 422, map[string]any{"error": localizeGoMessage(lang, fmt.Sprintf("还有 %d 处错误，不能修改状态", res.Errors)), "check": localizeCompCheck(lang, res)})
		return
	}
	done, err := cs.installLive(name, set, s.plat.reload)
	if err != nil {
		s.fail(w, 500, "保存失败，已恢复原状："+err.Error())
		return
	}
	done()

	savedRecs := recordPublishVouchers()

	lang := wLang(w)
	var msg string
	if req.RevokePlatform != "" {
		plName := req.RevokePlatform
		if def, ok := mwpack.PlatformByID(req.RevokePlatform); ok {
			plName = def.Title
		}
		msg = tr(lang, "版本 "+ver+" 下线 "+plName, "Version "+ver+" unpublished on "+plName)
	} else if req.Status == "published" && len(targetPlatforms) > 0 {
		var plNames []string
		for _, pl := range targetPlatforms {
			if def, ok := mwpack.PlatformByID(pl); ok {
				plNames = append(plNames, def.Title)
			} else {
				plNames = append(plNames, pl)
			}
		}
		modeTxt := tr(lang, "手动测试", "Manual test")
		if req.TestMode == "automatic" {
			modeTxt = tr(lang, "自动化测试", "Automated test")
		}
		msg = tr(lang,
			fmt.Sprintf("版本 %s 发布到 %s（%s）", ver, strings.Join(plNames, "、"), modeTxt),
			fmt.Sprintf("Version %s published on %s (%s)", ver, strings.Join(plNames, ", "), modeTxt),
		)
	} else {
		label := map[string]string{"draft": tr(lang, "未发布", "Unpublished"), "verifying": tr(lang, "未发布", "Unpublished"), "published": tr(lang, "已发布", "Published")}[req.Status]
		msg = tr(lang, "版本 "+ver+" 状态改为「"+label+"」", "Version "+ver+" status set to "+label)
	}
	if note != "" {
		msg += tr(lang, "：", ": ") + note
	}
	rev, err := cs.recordPublish(name, prev, set, session.User, msg)
	if err != nil {
		s.fail(w, 500, "已修改，但记录修订失败："+err.Error())
		return
	}
	auditVal := name + " " + ver + " " + req.Status
	if len(targetPlatforms) > 0 {
		auditVal += " " + strings.Join(targetPlatforms, ",") + " " + req.TestMode
	}
	if req.RevokePlatform != "" {
		auditVal = name + " " + ver + " revoke:" + req.RevokePlatform
	}
	s.auditReq(r, "component-version-status", session.User, auditVal)
	resp := map[string]any{"ok": true, "rev": rev}
	if len(savedRecs) > 0 {
		resp["verifications"] = savedRecs
		resp["verification"] = savedRecs[0]
	}
	s.writeJSON(w, 200, resp)
}

// Compare under the save/publish lock: another tab's edits must never be discarded.
func (s *storeServer) leaveDraft(w http.ResponseWriter, r *http.Request, session storeSession, name string, req actionReq) {
	compMu.Lock()
	defer compMu.Unlock()
	cs := s.comps()
	set, meta, err := cs.readDraft(name)
	if err != nil {
		s.writeJSON(w, 200, map[string]bool{"removed": false})
		return
	}
	if req.IfUpdated == "" || req.IfUpdated != meta.Updated {
		s.writeJSON(w, 200, map[string]bool{"removed": false})
		return
	}
	live, _, err := cs.liveSet(name)
	if err != nil {
		s.writeJSON(w, 200, map[string]bool{"removed": false})
		return
	}
	added, removed, changed := diffSets(live, set)
	if len(added)+len(removed)+len(changed) != 0 {
		s.writeJSON(w, 200, map[string]bool{"removed": false})
		return
	}
	if err := cs.discardDraft(name); err != nil {
		s.fail(w, 500, "关闭未修改草稿失败，请重试")
		return
	}
	s.auditReq(r, "component-draft-drop", session.User, name+" 未修改，离开编辑自动清理")
	s.writeJSON(w, 200, map[string]bool{"removed": true})
}

package main

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

	"middleware-deployer/mwpack"

	"gopkg.in/yaml.v3"
)

// The component workbench API. Everything under /api/components/{name}/ except the read-only manifest and pack is
// for administrators editing a component: a draft is changed freely, checked and previewed as often as wanted, and
// only publishing changes what deliveries are generated from.

var compMu sync.Mutex // serialises draft writes and publishes

var reservedNames = map[string]bool{sharedPlatformName: true, "new": true, "import": true, "validate": true, "templates": true, "cross-check": true, "ansible": true, "guide": true}

func (s *storeServer) comps() *compStore {
	return &compStore{root: s.plat.componentsDir, builtin: builtinFS()}
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
		if err := writeJSONFile(s.compIgnorePath(name), out); err != nil {
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
		if !st.Enabled || len(providers) == 0 {
			s.fail(w, 409, "AI 功能未开启")
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

// setVersionStatus changes only the status of one version (draft, verifying, published) of the published component and
// records it as a revision with the note: who verified it, where. It is the quick way to say "this version has now been
// deployed on clean machines", without opening the workbench for a one-word change.
func (s *storeServer) setVersionStatus(w http.ResponseWriter, r *http.Request, session storeSession, name, ver string) {
	var req struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if decodeBody(w, r, 1<<12, &req) != nil || !safeName(name) {
		s.fail(w, 400, "请求内容有问题")
		return
	}
	if req.Status != "draft" && req.Status != "verifying" && req.Status != "published" {
		s.fail(w, 400, "状态只能是草稿、待验证或已发布")
		return
	}
	note := strings.TrimSpace(req.Note)
	if req.Status == "published" && note == "" {
		s.fail(w, 400, "标为已发布前，请写下在哪套环境验证过（例如：2026-10-27 在三台全新 Ubuntu 24.04 上部署并通过全部测试）")
		return
	}
	if len([]rune(note)) > 200 {
		s.fail(w, 400, "说明过长（200 字以内）")
		return
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
	var target *yaml.Node
	if vs != nil {
		for _, v := range vs.Content {
			var id, status *yaml.Node
			for i := 0; i+1 < len(v.Content); i += 2 {
				switch v.Content[i].Value {
				case "id":
					id = v.Content[i+1]
				case "status":
					status = v.Content[i+1]
				}
			}
			if id != nil && id.Value == ver {
				target = status
			}
		}
	}
	if target == nil || target.Kind != yaml.ScalarNode || target.Line == 0 {
		s.fail(w, 404, "这个组件没有这个版本，或它没有写状态")
		return
	}
	if target.Value == req.Status {
		s.writeJSON(w, 200, map[string]any{"ok": true, "unchanged": true})
		return
	}
	file := origins[target]
	text := string(prev[file])
	// only the word changes: the file keeps its comments and layout
	lines := strings.Split(text, "\n")
	ln := []rune(lines[target.Line-1])
	col := target.Column - 1
	end := col + len([]rune(target.Value))
	if target.Style&(yaml.DoubleQuotedStyle|yaml.SingleQuotedStyle) != 0 {
		end += 2
	}
	if col < 0 || end > len(ln) || !strings.Contains(string(ln[col:end]), target.Value) {
		s.fail(w, 422, "component.yaml 的写法不支持这样改，请在工作台里改")
		return
	}
	lines[target.Line-1] = string(ln[:col]) + req.Status + string(ln[end:])
	set := fileSet{}
	for k, v := range prev {
		set[k] = v
	}
	set[file] = []byte(strings.Join(lines, "\n"))
	res := checkComponent(s.plat, name, set)
	if !res.OK {
		lang := wLang(w)
		s.writeJSON(w, 422, map[string]any{"error": localizeGoMessage(lang, fmt.Sprintf("还有 %d 处错误，不能发布", res.Errors)), "check": localizeCompCheck(lang, res)})
		return
	}
	done, err := cs.installLive(name, set, s.plat.reload)
	if err != nil {
		s.fail(w, 500, "保存失败，已恢复原状："+err.Error())
		return
	}
	done()
	lang := wLang(w)
	label := map[string]string{"draft": tr(lang, "草稿", "Draft"), "verifying": tr(lang, "待验证", "Verifying"), "published": tr(lang, "已发布", "Published")}[req.Status]
	msg := tr(lang, "版本 "+ver+" 状态改为「"+label+"」", "Version "+ver+" status set to "+label)
	if note != "" {
		msg += tr(lang, "：", ": ") + note
	}
	rev, err := cs.recordPublish(name, prev, set, session.User, msg)
	if err != nil {
		s.fail(w, 500, "已修改，但记录修订失败："+err.Error())
		return
	}
	s.auditReq(r, "component-version-status", session.User, name+" "+ver+" "+req.Status)
	s.writeJSON(w, 200, map[string]any{"ok": true, "rev": rev})
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

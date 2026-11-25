package server

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type wb struct {
	t    *testing.T
	s    *storeServer
	user interface{}
}

func (w *wb) do(method, path string, body any) (int, []byte) {
	w.t.Helper()
	ck, csrf := storeLogin(w.t, w.s, "admin")
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	rec := storeRequest(w.s, method, path, rd, ck, csrf)
	return rec.Code, rec.Body.Bytes()
}

func (w *wb) ok(method, path string, body any) map[string]any {
	w.t.Helper()
	code, b := w.do(method, path, body)
	if code != 200 {
		w.t.Fatalf("%s %s: %d %s", method, path, code, b)
	}
	var m map[string]any
	json.Unmarshal(b, &m)
	return m
}

func TestWorkbenchNewComponentLifecycle(t *testing.T) {
	s, _ := testStore(t)
	w := &wb{t: t, s: s}

	// Operators cannot touch the workbench.
	alice, acsrf := storeLogin(t, s, "alice")
	if r := storeRequest(s, "POST", "/api/components/new", strings.NewReader(`{}`), alice, acsrf); r.Code != 403 {
		t.Fatal("an operator started a component", r.Code)
	}

	kinds := w.ok("POST", "/api/components/new", map[string]any{"name": "mycache", "title": "我的缓存", "kind": "primary-replica", "package": "memcached", "port": 11211})
	if kinds["name"] != "mycache" {
		t.Fatal(kinds)
	}
	// The same name twice is refused; reserved names too.
	if code, _ := w.do("POST", "/api/components/new", map[string]any{"name": "mycache", "title": "x", "kind": "single", "package": "x", "port": 1}); code != 409 {
		t.Fatal("duplicate draft accepted", code)
	}
	if code, _ := w.do("POST", "/api/components/new", map[string]any{"name": "import", "title": "x", "kind": "single", "package": "x", "port": 1}); code != 400 {
		t.Fatal("reserved name accepted", code)
	}

	// The skeleton cannot be published until the version placeholder is replaced.
	chk := w.ok("POST", "/api/components/mycache/draft/check", nil)
	if chk["ok"] != false || !strings.Contains(string(mustJSON(chk)), "占位符") {
		t.Fatalf("a template placeholder passed the checks: %v", chk)
	}
	fixture, _ := buildSkeleton(skeletonOpts{Name: "mycache", Title: "我的缓存", Kind: "primary-replica", Package: "memcached", Port: 11211})
	{
		{
			fixed := strings.Replace(string(fixture["component.yaml"]), placeholderVersion, "1.6.24-1ubuntu3", 1)
			// This CRUD fixture advertises only the single-node capability it
			// implements, instead of pretending the scaffold implements replication.
			fixed = strings.Replace(fixed,
				"    - {id: single, name: 单节点, tag: 开发测试, spec: 1 台, roles: [{role: primary, count: 1}]}\n"+
					"    - {id: pair, name: 一主一从, tag: 推荐, spec: 2 台, roles: [{role: primary, count: 1}, {role: replica, count: 1}]}\n",
				"    - id: single\n      name: 基础系列\n      roles: [{role: primary, count: 1}]\n      contract:\n        series: basic\n        when: count(roles.replica) == 0\n        failover: none\n        mechanism: 单节点缓存\n        read_access: 单节点读写\n        sharding: false\n        limitations: [不提供自动切换]\n        acceptance: [mycache/port-open]\n        operations: [deploy]\n", 1)

			w.ok("PUT", "/api/components/mycache/draft", map[string]any{"files": map[string]any{"component.yaml": fixed}})
		}
	}
	chk = w.ok("POST", "/api/components/mycache/draft/check", nil)
	if chk["ok"] != true {
		t.Fatalf("skeleton does not pass its own checks: %v", chk)
	}

	// Break the manifest: the error carries a line.
	draft := w.ok("GET", "/api/components/mycache/draft", nil)
	var manifest string
	for _, f := range draft["files"].([]any) {
		fm := f.(map[string]any)
		if fm["path"] == "component.yaml" {
			manifest = fm["text"].(string)
		}
	}
	broken := strings.Replace(manifest, "type: port, default: 11211", "type: port, default: 99999999", 1)
	updated := draft["meta"].(map[string]any)["updated"].(string)
	w.ok("PUT", "/api/components/mycache/draft", map[string]any{"files": map[string]any{"component.yaml": broken}, "if_updated": updated})
	chk = w.ok("POST", "/api/components/mycache/draft/check", nil)
	if chk["ok"] != false {
		t.Fatalf("a port out of range passed: %v", chk)
	}
	hasLine := false
	for _, p := range chk["problems"].([]any) {
		if p.(map[string]any)["line"] != nil {
			hasLine = true
		}
	}
	if !hasLine {
		t.Fatal("no problem was located in the file", chk)
	}
	// Stale editors are refused.
	if code, _ := w.do("PUT", "/api/components/mycache/draft", map[string]any{"files": map[string]any{"component.yaml": manifest}, "if_updated": updated}); code != 409 {
		t.Fatal("a stale save was accepted", code)
	}
	// Publishing with errors is refused and changes nothing.
	if code, _ := w.do("POST", "/api/components/mycache/draft/publish", map[string]any{"note": "x"}); code != 422 {
		t.Fatal("published with errors", code)
	}
	w.ok("PUT", "/api/components/mycache/draft", map[string]any{"files": map[string]any{"component.yaml": manifest}})

	// A broken template is caught without Ansible.
	w.ok("PUT", "/api/components/mycache/draft", map[string]any{"files": map[string]any{"roles/mycache/templates/mycache.conf.j2": "{% if x %}\nport {{ mw.params.port }\n"}})
	chk = w.ok("POST", "/api/components/mycache/draft/check", nil)
	if chk["ok"] != false || !strings.Contains(string(mustJSON(chk)), "j2") {
		t.Fatal("a broken template passed", chk)
	}
	w.ok("PUT", "/api/components/mycache/draft", map[string]any{"files": map[string]any{"roles/mycache/templates/mycache.conf.j2": "port {{ mw.params.port }}\n"}})

	// A step pointing at a task file that is not there is reported on the step, once.
	w.ok("PUT", "/api/components/mycache/draft", map[string]any{"files": map[string]any{"roles/mycache/tasks/start.yml": nil}})
	chk = w.ok("POST", "/api/components/mycache/draft/check", nil)
	if chk["ok"] != false || strings.Count(string(mustJSON(chk)), "roles/mycache/tasks/start.yml") != 1 {
		t.Fatalf("a missing task file was not reported exactly once: %v", chk)
	}
	if p := chk["problems"].([]any)[0].(map[string]any); p["line"] == nil || p["path"] != "lifecycle.start[0].run" {
		t.Fatalf("the missing file is not located at its step: %v", p)
	}
	w.ok("PUT", "/api/components/mycache/draft", map[string]any{"files": map[string]any{"roles/mycache/tasks/start.yml": "- name: x\n  ansible.builtin.debug:\n    msg: x\n"}})

	// Trial generation.
	pv := w.ok("POST", "/api/components/mycache/draft/preview", map[string]any{"preset": "single"})
	if pv["ok"] != true {
		t.Fatalf("trial generation failed: %v", pv)
	}
	if len(pv["files"].([]any)) < 8 || len(pv["handbooks"].([]any)) == 0 {
		t.Fatal("trial generation produced too little", pv)
	}
	if pv["compared"] != false {
		t.Fatal("a new component has nothing to compare with")
	}
	// The sample can be arranged by hand: primary and replica on the same three machines' first two, one parameter changed.
	pv = w.ok("POST", "/api/components/mycache/draft/preview", map[string]any{"placement": map[string]any{"primary": []string{"host1"}, "replica": []string{"host2", "host3"}}, "params": map[string]any{"port": 7000}})
	if pv["ok"] != true || len(pv["sample"].(map[string]any)["hosts"].([]any)) != 3 {
		t.Fatalf("a hand-arranged sample was not honoured: %v", pv["error"])
	}
	if len(pv["params"].([]any)) == 0 || len(pv["roles"].([]any)) != 2 {
		t.Fatal("the preview does not describe the version's roles and params")
	}
	if bad := w.ok("POST", "/api/components/mycache/draft/preview", map[string]any{"placement": map[string]any{"primary": []string{"web1"}}}); bad["ok"] == true {
		t.Fatal("an invalid sample machine name was accepted")
	}

	// Publish: the component appears in the catalogue with revision 1.
	pub := w.ok("POST", "/api/components/mycache/draft/publish", map[string]any{"note": "第一版"})
	if pub["rev"].(float64) != 1 {
		t.Fatal(pub)
	}
	if _, ok := s.plat.cat().Get("mycache"); !ok {
		t.Fatal("published component not in the catalogue")
	}
	ws := w.ok("GET", "/api/components/mycache/workspace", nil)
	if ws["source"] != "custom" || ws["draft"].(map[string]any)["exists"] != false {
		t.Fatal(ws)
	}

	// Change it again: the draft starts from the published component and the preview compares with it.
	w.ok("POST", "/api/components/mycache/draft", map[string]any{})
	w.ok("PUT", "/api/components/mycache/draft", map[string]any{"files": map[string]any{"roles/mycache/templates/mycache.conf.j2": "port {{ mw.params.port }}\nmaxmemory 64mb\n"}})
	pv = w.ok("POST", "/api/components/mycache/draft/preview", map[string]any{})
	if pv["compared"] != true || pv["changes"].(float64) < 1 {
		t.Fatalf("the change was not seen against the published version: %v", pv["changes"])
	}
	df := w.ok("POST", "/api/components/mycache/draft/diff", nil)
	if !strings.Contains(string(mustJSON(df)), "+ maxmemory 64mb") {
		t.Fatal("the draft diff does not show the added line", df)
	}
	w.ok("POST", "/api/components/mycache/draft/publish", map[string]any{"note": "加内存限制"})
	_, revs := w.do("GET", "/api/components/mycache/revisions", nil)
	var list []map[string]any
	json.Unmarshal(revs, &list)
	if len(list) != 2 {
		t.Fatal("expected two revisions", string(revs))
	}
	rv := w.ok("GET", "/api/components/mycache/revisions/2", nil)
	if !strings.Contains(string(mustJSON(rv)), "maxmemory") {
		t.Fatal("the revision diff does not show the change", rv)
	}

	// Roll back through a draft.
	w.ok("POST", "/api/components/mycache/revisions/1/restore", nil)
	w.ok("POST", "/api/components/mycache/draft/publish", map[string]any{"note": "回到第一版"})
	got, _ := os.ReadFile(filepath.Join(s.plat.componentsDir, "mycache", "roles", "mycache", "templates", "mycache.conf.j2"))
	if strings.Contains(string(got), "maxmemory") {
		t.Fatal("rollback did not restore the file")
	}

	// Deleting removes everything, history included.
	if code, b := w.do("DELETE", "/api/components/mycache", nil); code != 200 {
		t.Fatal(code, string(b))
	}
	if _, err := os.Stat(filepath.Join(s.plat.componentsDir, ".history", "mycache")); err == nil {
		t.Fatal("history survived deletion")
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func TestWorkbenchOverrideAndFork(t *testing.T) {
	s, _ := testStore(t)
	w := &wb{t: t, s: s}

	// Edit a built-in: start a draft from it, change a default, publish; it is now an override.
	w.ok("POST", "/api/components/etcd/draft", map[string]any{"from": "builtin"})
	draft := w.ok("GET", "/api/components/etcd/draft", nil)
	var manifest string
	for _, f := range draft["files"].([]any) {
		if f.(map[string]any)["path"] == "manifest/common/params.yaml" {
			manifest = f.(map[string]any)["text"].(string)
		}
	}
	changed := strings.Replace(manifest, "unit: ms, default: 100, min: 10", "unit: ms, default: 200, min: 10", 1)
	if changed == manifest {
		t.Fatal("test edit did not apply")
	}
	w.ok("PUT", "/api/components/etcd/draft", map[string]any{"files": map[string]any{"manifest/common/params.yaml": changed}})
	pv := w.ok("POST", "/api/components/etcd/draft/preview", map[string]any{})
	if pv["ok"] != true || pv["compared"] != true || pv["changes"].(float64) < 1 {
		t.Fatalf("override preview: ok=%v compared=%v changes=%v err=%v", pv["ok"], pv["compared"], pv["changes"], pv["error"])
	}
	w.ok("POST", "/api/components/etcd/draft/publish", map[string]any{"note": "心跳改 200ms"})
	if ws := w.ok("GET", "/api/components/etcd/workspace", nil); ws["source"] != "override" {
		t.Fatal(ws)
	}
	// Revision 1 is the built-in as it was.
	if rv := w.ok("GET", "/api/components/etcd/revisions/1", nil); rv["meta"].(map[string]any)["note"] != "发布前的版本" {
		t.Fatal(rv)
	}
	// Restoring the built-in drops the override but keeps the history.
	if code, b := w.do("DELETE", "/api/components/etcd", nil); code != 200 {
		t.Fatal(code, string(b))
	}
	if ws := w.ok("GET", "/api/components/etcd/workspace", nil); ws["source"] != "builtin" || len(ws["revisions"].([]any)) != 2 {
		t.Fatal(ws)
	}

	// Fork a built-in under a new name: role directory and references follow.
	w.ok("POST", "/api/components/etcd/fork", map[string]any{"name": "etcd-lab", "title": "实验 etcd"})
	set, _, err := s.comps().readDraft("etcd-lab")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := set["roles/etcd-lab/tasks/install.yml"]; !ok {
		t.Fatal("role directory not renamed", set.paths())
	}
	if !strings.Contains(string(expandedTestManifest(t, set)), "role: etcd-lab") || !strings.Contains(string(set["component.yaml"]), "component: etcd-lab") {
		t.Fatal("manifest not renamed")
	}
	if chk := w.ok("POST", "/api/components/etcd-lab/draft/check", nil); chk["ok"] != true {
		t.Fatalf("fork does not pass checks: %v", chk)
	}
}

func TestCheckJinjaAndPathLine(t *testing.T) {
	res := &compCheck{}
	checkJinja(res, "a.j2", "{% for x in y %}\n{{ x }}\n{% endif %}\n")
	if len(res.Problems) != 1 || res.Problems[0].Line != 3 {
		t.Fatal(res.Problems)
	}
	res = &compCheck{}
	checkJinja(res, "a.j2", "{% if a %}\n{% else %}\n{% endif %}\n{# note #}\n")
	if len(res.Problems) != 0 {
		t.Fatal(res.Problems)
	}
}

func TestSkeletonsAllPass(t *testing.T) {
	s, _ := testStore(t)
	for _, k := range skeletonKinds {
		files, err := buildSkeleton(skeletonOpts{Name: "sk-" + k.ID, Title: "骨架", Kind: k.ID, Package: "memcached", Port: 11211})
		if err != nil {
			t.Fatal(k.ID, err)
		}
		// A generated skeleton is not a verified architecture.
		chk := checkComponent(s.plat, "sk-"+k.ID, files)
		placeholder, contract := false, false
		for _, problem := range chk.Problems {
			placeholder = placeholder || strings.Contains(problem.Message, "占位符")
			contract = contract || strings.Contains(problem.Message, "缺少系列契约")
		}
		if chk.OK || !placeholder || !contract {
			t.Fatal(k.ID, chk.Problems)
		}
		files["component.yaml"] = bytes.ReplaceAll(files["component.yaml"], []byte(placeholderVersion), []byte("1.6.24-1ubuntu3"))
		if chk := checkComponent(s.plat, "sk-"+k.ID, files); chk.OK {
			t.Fatal("incomplete series became publishable")
		}
		if pv := previewComponent(s.plat, ansibleEnv{}, "sk-"+k.ID, files, nil, previewReq{}); !pv.OK {
			t.Fatal(k.ID, pv.Error)
		}
	}
}

// With ansible-core available (MW_ANSIBLE_BIN), the generated playbooks pass --syntax-check and a template renders
// with the real variables.
func TestWorkbenchWithAnsible(t *testing.T) {
	env := detectAnsible("", t.TempDir())
	if !env.Ready {
		t.Skip("ansible-core not available: set MW_ANSIBLE_BIN")
	}
	s, _ := testStore(t)
	files, err := buildSkeleton(skeletonOpts{Name: "acache", Title: "缓存", Kind: "primary-replica", Package: "memcached", Port: 11211})
	if err != nil {
		t.Fatal(err)
	}
	pv := previewComponent(s.plat, env, "acache", files, nil, previewReq{Preset: "pair"})
	if !pv.OK || len(pv.Syntax) < 4 {
		t.Fatal(pv.Error, len(pv.Syntax))
	}
	for _, r := range pv.Syntax {
		if !r.OK {
			t.Errorf("%s: %s", r.Playbook, r.Output)
		}
	}
	// A task that is not valid Ansible is caught by the syntax check, not by a static rule.
	bad := files.clone()
	bad["roles/acache/tasks/start.yml"] = []byte("- name: x\n  ansible.builtin.systemd:\n    name: a\n   state: started\n")
	if chk := checkComponent(s.plat, "acache", bad); chk.OK {
		t.Fatal("a task file with a YAML error passed the checks")
	}
	out, err := renderTemplate(s.plat, env, "acache", files, "roles/acache/templates/acache.conf.j2", previewReq{Preset: "pair"}, "host2")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "port 11211") || !strings.Contains(out, "replicaof 10.0.0.11 11211") {
		t.Fatal("the replica's configuration is wrong:\n" + out)
	}
	out, _ = renderTemplate(s.plat, env, "acache", files, "roles/acache/templates/acache.conf.j2", previewReq{Preset: "pair"}, "host1")
	if strings.Contains(out, "replicaof") {
		t.Fatal("the primary must not replicate:\n" + out)
	}
}

// Every built-in component can be trial-generated with the automatic sample, including those with required parameters.
func TestPreviewWorksForEveryBuiltin(t *testing.T) {
	s, _ := testStore(t)
	cs := s.comps()
	for name := range builtinNamesIn(cs.builtin) {
		set, err := cs.builtinSet(name)
		if err != nil {
			t.Fatal(err)
		}
		if pv := previewComponent(s.plat, ansibleEnv{}, name, set, nil, previewReq{}); !pv.OK {
			t.Errorf("%s: %s", name, pv.Error)
		}
	}
}

// A configuration-sheet-only component may still carry deployment steps; they are kept, not rejected.
func TestOnlyConfigComponentMayKeepDeploymentSteps(t *testing.T) {
	s, _ := testStore(t)
	set, err := s.comps().builtinSet("external-lb")
	if err != nil {
		t.Fatal(err)
	}
	set["component.yaml"] = append(set["component.yaml"], []byte("\nlifecycle:\n  install:\n    - id: note\n      title: 备注\n      tasks:\n        - name: 打印\n          ansible.builtin.debug: {msg: hi}\n")...)
	if chk := checkComponent(s.plat, "external-lb", set); !chk.OK {
		t.Fatal(chk.Problems)
	}
	if pv := previewComponent(s.plat, ansibleEnv{}, "external-lb", set, nil, previewReq{}); !pv.OK {
		t.Fatal(pv.Error)
	}
}

func TestStaleSharedFilesAndOverrideDeduplication(t *testing.T) {
	s, cfg := testStore(t)
	set, err := s.comps().builtinSet("postgresql")
	if err != nil {
		t.Fatal(err)
	}
	// Simulate an older override/draft that still lists a removed task in shared_files.
	set["component.yaml"] = []byte(strings.Replace(
		string(set["component.yaml"]),
		"shared_files:\n",
		"shared_files:\n    - roles/postgresql/tasks/clonefrom_tags.yml\n",
		1,
	))
	chk := checkComponent(s.plat, "postgresql", set)
	if !chk.OK || chk.Errors != 0 {
		t.Fatalf("stale shared_files entry should not block checkComponent: %+v", chk.Problems)
	}
	foundWarn := false
	for _, p := range chk.Problems {
		if strings.Contains(p.Message, "与其他组件一起载入时失败") {
			t.Fatalf("unexpected generic cross-load failure: %+v", p)
		}
		if p.Severity == "warning" && p.Path == "shared_files" && strings.Contains(p.Message, "clonefrom_tags.yml") && p.Line > 0 {
			foundWarn = true
		}
	}
	if !foundWarn {
		t.Fatalf("expected warning located on shared_files, got %+v", chk.Problems)
	}

	// Deleting a shared file via saveDraft prunes it from shared_files automatically.
	w := &wb{t: t, s: s}
	w.ok("POST", "/api/components/postgresql/draft", map[string]any{"from": "builtin"})
	draftSet, _, err := s.comps().readDraft("postgresql")
	if err != nil {
		t.Fatal(err)
	}
	draftSet["roles/postgresql/tasks/clonefrom_tags.yml"] = []byte("- name: tag\n  ansible.builtin.debug: {msg: ok}\n")
	draftSet["component.yaml"] = set["component.yaml"]
	_, dm, _ := s.comps().readDraft("postgresql")
	if err := s.comps().writeDraft("postgresql", draftSet, dm); err != nil {
		t.Fatal(err)
	}
	w.ok("PUT", "/api/components/postgresql/draft", map[string]any{
		"files": map[string]any{"roles/postgresql/tasks/clonefrom_tags.yml": nil},
	})
	afterSet, _, err := s.comps().readDraft("postgresql")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(afterSet["component.yaml"]), "clonefrom_tags.yml") {
		t.Fatalf("deleted shared file remained in component.yaml:\n%s", afterSet["component.yaml"])
	}

	// Even if a built-in override on disk has broken YAML, /api/components must not return duplicate IDs.
	brokenDir := filepath.Join(cfg.DataDir, "components", "postgresql")
	if err := os.MkdirAll(brokenDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(brokenDir, "component.yaml"), []byte("broken: [\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.plat.reload(); err != nil {
		t.Fatal(err)
	}
	_, rawList := w.do("GET", "/api/components", nil)
	var items []map[string]any
	if err := json.Unmarshal(rawList, &items); err != nil {
		t.Fatal(err)
	}
	pgCount := 0
	for _, it := range items {
		if it["id"] == "postgresql" {
			pgCount++
			if it["broken"] != true || it["source"] != "override" {
				t.Fatalf("expected broken override metadata on single postgresql entry: %+v", it)
			}
		}
	}
	if pgCount != 1 {
		t.Fatalf("expected exactly 1 postgresql entry in /api/components, got %d", pgCount)
	}
}

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSharedPlatformWorkbench(t *testing.T) {
	s, _ := testStore(t)
	w := &wb{t: t, s: s}
	base := "/api/components/platform-shared"
	alice, csrf := storeLogin(t, s, "alice")
	if r := storeRequest(s, "POST", base+"/draft", strings.NewReader("{}"), alice, csrf); r.Code != 403 {
		t.Fatal(r.Code)
	}
	ws := w.ok("GET", base+"/workspace", nil)
	if ws["builtin"] != true {
		t.Fatal(ws)
	}
	w.ok("POST", base+"/draft", map[string]any{})
	files, _, _ := s.comps().readDraft(sharedPlatformName)
	check := checkSharedPlatform(s.plat, files)
	if !check.OK {
		t.Fatal(problemsText(check, nil))
	}
	original := s.plat.cat()
	file := "roles/mw_preflight/tasks/main.yml"
	old := string(files[file])
	changed := old + "\n- name: 公共流程测试标记\n  ansible.builtin.debug: {msg: isolated-check}\n"
	w.ok("PUT", base+"/draft", map[string]any{"files": map[string]string{file: changed}})
	if string(s.plat.cat().PlatformSnapshot()[file]) != old {
		t.Fatal("draft leaked into live")
	}
	w.ok("POST", base+"/draft/publish", map[string]any{"note": "公共预检测试"})
	if string(s.plat.cat().PlatformSnapshot()[file]) != changed {
		t.Fatal("published role not loaded")
	}
	if string(original.PlatformSnapshot()[file]) != old {
		t.Fatal("old snapshot mutated")
	}
	if _, ok := s.plat.cat().Get(sharedPlatformName); ok {
		t.Fatal("platform exposed as deployable component")
	}
	if _, e := os.Stat(filepath.Join(s.plat.componentsDir, ".platform", file)); e != nil {
		t.Fatal(e)
	}
	w.ok("POST", base+"/draft", map[string]any{})
	w.ok("PUT", base+"/draft", map[string]any{"files": map[string]string{file: "[broken:"}})
	if code, _ := w.do("POST", base+"/draft/publish", map[string]any{}); code != 422 {
		t.Fatal("invalid platform publish", code)
	}
	w.ok("DELETE", base+"/draft", nil)
	w.ok("POST", base+"/draft", map[string]any{"from": "builtin"})
	w.ok("POST", base+"/draft/publish", map[string]any{"note": "恢复内置"})
	if string(s.plat.cat().PlatformSnapshot()[file]) != old {
		t.Fatal("restore failed")
	}
}
func TestSharedPlatformAIAndImpact(t *testing.T) {
	s, _ := testStore(t)
	w := &wb{t: t, s: s}
	w.ok("POST", "/api/components/redis/draft", map[string]any{})
	ids := []string{}
	c := compToolCtx{s: s, name: "redis", proposed: &ids}
	if text := c.run("platform_files", sharedTestJSON(map[string]any{"path": "roles/mw_data_disk/tasks/main.yml"})); !strings.Contains(text, "mw_hosts") {
		t.Fatal(text)
	}
	if text := c.run("platform_files", sharedTestJSON(map[string]any{"path": "generated/inventory/group_vars/all.yml"})); !strings.Contains(text, "mw_hosts:") {
		t.Fatal(text)
	}
	file := "roles/mw_preflight/tasks/main.yml"
	base := sharedBuiltin()
	changed := base.clone()
	changed[file] = append(changed[file], []byte("\n- name: Shared impact check\n  ansible.builtin.debug: {msg: changed}\n")...)
	args, _ := json.Marshal(map[string]any{"summary": "公共预检增加检查", "files": []any{map[string]any{"path": file, "content": string(changed[file])}}})
	out := c.run("propose_platform_files", string(args))
	if !strings.Contains(out, "#/components/platform-shared/edit/files") {
		t.Fatal(out)
	}
	proposals := s.loadCompProposals(sharedPlatformName)
	if len(proposals) != 1 {
		t.Fatal(proposals)
	}
	if !bytes.Equal(s.plat.cat().PlatformSnapshot()[file], base[file]) {
		t.Fatal("proposal published unexpectedly")
	}
	session := w.ok("GET", "/api/components/platform-shared/ai/session", nil)
	if len(session["messages"].([]any)) == 0 {
		t.Fatal("cross-component proposal not visible")
	}
	w.ok("POST", "/api/components/platform-shared/ai/proposals/"+proposals[0].ID+"/accept", nil)
	accepted, _, _ := s.comps().readDraft(sharedPlatformName)
	if !bytes.Equal(accepted[file], changed[file]) {
		t.Fatal("accepted proposal not written to shared draft")
	}
	redis, _, _ := s.comps().readDraft("redis")
	if _, ok := redis[file]; ok {
		t.Fatal("shared role leaked into redis draft")
	}
	for _, name := range []string{"redis", "postgresql", "etcd"} {
		t.Run(name, func(t *testing.T) {
			before, _, _, e := renderSample(sharedCatalog(s.plat, base), name, previewReq{})
			if e != nil {
				t.Fatal(e)
			}
			after, _, _, e := renderSample(sharedCatalog(s.plat, changed), name, previewReq{})
			if e != nil {
				t.Fatal(e)
			}
			oldSteps := map[string]reportStep{}
			for _, st := range flatSteps(s.runbookStepsOf(before.PlanDoc, "")) {
				oldSteps[stepIdentity(st)] = st
			}
			steps := flatSteps(s.runbookStepsOf(after.PlanDoc, ""))
			oldFiles, newFiles := projectMap(before), projectMap(after)
			diff := map[string]bool{}
			for p, b := range newFiles {
				if !bytes.Equal(oldFiles[p], b) {
					diff[p] = true
				}
			}
			impact := impactOf(steps, oldSteps, oldFiles, newFiles, diff)
			hits, untouched := 0, 0
			for _, st := range steps {
				if st.Playbook == "" {
					continue
				}
				uses := usedBy(newFiles, st.Playbook)[file]
				if impact[st.Key].Changed {
					hits++
					if !uses {
						t.Errorf("leaked to %s: %v", st.Key, impact[st.Key])
					}
				} else {
					untouched++
					if uses {
						t.Errorf("missed %s", st.Key)
					}
				}
			}
			if hits == 0 || untouched < 2 {
				t.Fatal(hits, untouched)
			}
		})
	}
}

func sharedTestJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestSharedPlatformScriptCheckAndUpgradeRefresh(t *testing.T) {
	s, _ := testStore(t)
	w := &wb{t: t, s: s}
	base := "/api/components/platform-shared"
	w.ok("POST", base+"/draft", map[string]any{})

	// Simulate an older Middleware Hub version having written an outdated read-only platform-contract.md into the draft.
	contractDisk := filepath.Join(s.plat.componentsDir, ".work", sharedPlatformName, "files", "files", "platform-contract.md")
	if err := os.WriteFile(contractDisk, []byte("# outdated contract from previous binary\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	files, _, err := s.comps().readDraft(sharedPlatformName)
	if err != nil {
		t.Fatal(err)
	}
	if string(files["files/platform-contract.md"]) != sharedContract {
		t.Fatalf("expected stale platform-contract.md to auto-refresh on readDraft")
	}
	check := checkSharedPlatform(s.plat, files)
	if !check.OK {
		t.Fatalf("expected clean check after platform-contract refresh, got:\n%s", problemsText(check, nil))
	}

	// Genuine script syntax errors must still be rejected when host bash/python3 are available.
	if _, ok := findScriptSyntaxBash(); ok {
		badSh := files.clone()
		badSh["files/setup-root-ssh-trust.sh"] = []byte("#!/usr/bin/env bash\nif [ 1 = 1 ]; then\n")
		res := checkSharedPlatform(s.plat, badSh)
		if res.OK {
			t.Fatalf("expected broken bash script to fail checkSharedPlatform")
		}
	}
	if _, ok := findScriptSyntaxPython(); ok {
		badPy := files.clone()
		badPy["files/mw_log.py"] = []byte("def broken(:\n    pass\n")
		res := checkSharedPlatform(s.plat, badPy)
		if res.OK {
			t.Fatalf("expected broken python script to fail checkSharedPlatform")
		}
	}
}

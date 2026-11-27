package server

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAIControllerCommandContract(t *testing.T) {
	s, _ := testStore(t)
	id := "abcdefabcdefabcdefabcdefabcdefab"
	dir := filepath.Join(s.jobDir(id), "output")
	os.MkdirAll(dir, 0700)
	os.WriteFile(filepath.Join(dir, "plan.json"), []byte("{\"project_dir\":\"/root/middleware-automation/projects/demo\",\"controller\":\"node-01\"}"), 0600)
	facts := s.controllerFacts(id)
	for _, want := range []string{"/root/middleware-automation/bin/ansible-playbook -i inventory/hosts.yml", "/root/middleware-automation/bin/ansible-inventory -i inventory/hosts.yml --graph", "没有 /root/middleware-automation/bin/ansible", "不支持 ad-hoc 的 -m/-a"} {
		if !strings.Contains(facts, want) {
			t.Fatal("missing contract", want)
		}
	}
	if strings.Contains(facts, "/ansible ...") || strings.Contains(facts, "也可以写 ../../bin/ansible）") {
		t.Fatal("invalid command guidance retained")
	}
	for _, name := range []string{"step-troubleshooting", "ansible-debug", "proposal-writing", "component-authoring"} {
		sk, ok := s.skillFor("admin", name)
		if !ok || !strings.Contains(sk.Content, "没有 bin/ansible") {
			t.Fatal("skill not effective", name)
		}
	}
}

func TestBuiltinSkillsMatchCurrentPlatformBoundaries(t *testing.T) {
	seen := map[string]bool{}
	for _, sk := range builtinSkills() {
		if sk.Name == "" || sk.Title == "" || sk.Description == "" || sk.Content == "" || seen[sk.Name] {
			t.Fatalf("invalid skill metadata: %s", sk.Name)
		}
		seen[sk.Name] = true
		for _, obsolete := range []string{"ansible -i inventory/hosts.yml all -m ping", "优先级差要大于权重变化", "工具调用一般控制在 5 次以内", "172.30.2.44 → 172.30.2.0/24", "运行环境的漏洞只影响控制节点"} {
			if strings.Contains(sk.Content, obsolete) {
				t.Fatalf("%s retains obsolete guidance: %s", sk.Name, obsolete)
			}
		}
	}
	if len(seen) != 22 || !seen["ansible-v2-standards"] || !seen["automatic-execution"] || !seen["change-rehearsal"] || !seen["redis-sentinel"] || !seen["nginx-stream"] || !seen["middleware-logging-observability"] || !seen["security-cve-audit"] {
		t.Fatalf("audit coverage changed: %d skills; review new entries", len(seen))
	}
	for _, sk := range builtinSkills() {
		switch sk.Name {
		case "security-cve-audit":
			for _, want := range []string{"library_runtimes", "check_package_security", "web_search", "web_fetch"} {
				if !strings.Contains(sk.Content, want) {
					t.Fatalf("security-cve-audit misses %s", want)
				}
			}
		case "delivery-review", "middleware-logging-observability":
			if !strings.Contains(sk.Content, "search_files") {
				t.Fatalf("%s should guide model to use native search_files", sk.Name)
			}
		case "automatic-execution":
			for _, rule := range []string{"bin/ansible-playbook", "不自动重试", "execution_history", "execution_log", "日志导入、人工确认和执行节点验证必须分别标明"} {
				if !strings.Contains(sk.Content, rule) {
					t.Fatalf("automatic execution skill misses %s", rule)
				}
			}
		case "reading-attachments":
			if strings.Contains(sk.Content, "扫描版 PDF 没有文字层，提取不到内容时直接告诉用户") {
				t.Fatalf("reading-attachments retains pre-sandbox scanned PDF guidance")
			}
			for _, want := range []string{"run_python", "run_shell", "view_images", "/out/_view/"} {
				if !strings.Contains(sk.Content, want) {
					t.Fatalf("reading-attachments misses %s", want)
				}
			}
		case "step-troubleshooting", "ansible-debug", "component-authoring":
			for _, want := range []string{"run_shell", "run_python", "workspace=true", "/workspace"} {
				if !strings.Contains(sk.Content, want) {
					t.Fatalf("%s misses %s", sk.Name, want)
				}
			}
			if sk.Name == "step-troubleshooting" && !strings.Contains(sk.Content, "component_sync_status") {
				t.Fatalf("step-troubleshooting should require checking component_sync_status before suggesting component edits")
			}
		case "linux-diagnostics", "offline-packages":
			for _, want := range []string{"run_shell", "run_python"} {
				if !strings.Contains(sk.Content, want) {
					t.Fatalf("%s misses %s", sk.Name, want)
				}
			}
		}
		if scripts := builtinSkillScripts[sk.Name]; len(scripts) > 0 {
			if !strings.Contains(sk.Content, "run_skill_script") {
				t.Fatalf("%s has builtin scripts but does not mention run_skill_script", sk.Name)
			}
			for _, sc := range scripts {
				if !strings.Contains(sk.Content, sc.Name) {
					t.Fatalf("%s has builtin script %s but does not document it", sk.Name, sc.Name)
				}
			}
		}
	}
}

func TestSearchFilesAndLineReadAndSkillRouting(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	w := storeCreate(t, s, alice, csrf, singleNodeSpec, nil)
	if w.Code != 202 {
		t.Fatalf("create job failed: %d %s", w.Code, w.Body.String())
	}
	s.wg.Wait()
	var created storeJob
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	s.mu.Lock()
	j := s.jobs[created.ID]
	s.mu.Unlock()
	id := j.ID
	var proposed []string
	tc := aiToolCtx{s: s, job: j, session: "review", proposed: &proposed}

	infoOut := tc.run("delivery_info", `{}`)
	if !strings.Contains(infoOut, `"delivery_mode":"offline"`) || !strings.Contains(infoOut, `"ubuntu-24.04-amd64"`) {
		t.Fatalf("delivery_info missing mode/platform: %s", infoOut)
	}

	hitOut := tc.run("search_files", `{"query":"log_min_duration_statement|pgbackrest","regex":true}`)
	if !strings.Contains(hitOut, "命中") || !strings.Contains(hitOut, "roles/postgresql/defaults/main.yml:") {
		t.Fatalf("search_files did not find expected matches: %s", hitOut)
	}

	missOut := tc.run("search_files", `{"query":"nonexistent_xyz_token_999"}`)
	if !strings.Contains(missOut, "未命中") {
		t.Fatalf("search_files miss format unexpected: %s", missOut)
	}

	lineOut := tc.run("read_file", `{"path":"roles/postgresql/defaults/main.yml","from_line":1,"max_lines":15}`)
	if !strings.Contains(lineOut, "第 1–15 行") || !strings.Contains(lineOut, "pg_major") {
		t.Fatalf("read_file from_line output unexpected: %s", lineOut)
	}

	hint := s.deliverySkillHint(id)
	if !strings.Contains(hint, "postgresql-patroni") || !strings.Contains(hint, "middleware-logging-observability") {
		t.Fatalf("deliverySkillHint unexpected: %s", hint)
	}
	facts := s.controllerFacts(id)
	if !strings.Contains(facts, "离线手工部署") || !strings.Contains(facts, "ubuntu-24.04-amd64") {
		t.Fatalf("controllerFacts missing mode/platform: %s", facts)
	}
}

func TestComponentSyncStatusTool(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	spec := `{"id":"etcd-ai-sync","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	w := storeCreate(t, s, admin, csrf, spec, nil)
	if w.Code != 202 {
		t.Fatalf("create failed: %d %s", w.Code, w.Body.String())
	}
	s.wg.Wait()
	var j storeJob
	_ = json.Unmarshal(w.Body.Bytes(), &j)
	s.mu.Lock()
	j = s.jobs[j.ID]
	s.mu.Unlock()
	if j.State != "succeeded" {
		t.Fatalf("job not succeeded: %s %s", j.State, j.Error)
	}

	task := "roles/etcd/tasks/test_health.yml"
	var proposed []string
	tc := aiToolCtx{s: s, job: j, session: "step:tests/etcd/health", proposed: &proposed}

	// 1. Before any component edit: delivery matches published component and no drafts exist.
	out1 := tc.run("component_sync_status", `{"file":"`+task+`"}`)
	if !strings.Contains(out1, `"sync_available": false`) || !strings.Contains(out1, `"status": "same_as_published"`) {
		t.Fatalf("expected up-to-date status before edit, got: %s", out1)
	}
	if sum := stepSummary("component_sync_status", out1); !strings.Contains(sum, "完全一致") {
		t.Fatalf("unexpected stepSummary before edit: %s", sum)
	}

	// 2. Edit component in unpublished draft: tool should surface draft_exists + draft_diff.
	if w := storeRequest(s, "POST", "/api/components/etcd/draft", strings.NewReader(`{"from":"builtin"}`), admin, csrf); w.Code != 200 {
		t.Fatalf("start draft failed: %d %s", w.Code, w.Body.String())
	}
	set, _, err := s.comps().readDraft("etcd")
	if err != nil {
		t.Fatal(err)
	}
	fixed := string(set[task]) + "\n- name: 修复后的健康断言\n  ansible.builtin.command: /bin/true\n  changed_when: false\n"
	body, _ := json.Marshal(map[string]any{"files": map[string]string{task: fixed}})
	if w := storeRequest(s, "PUT", "/api/components/etcd/draft", bytes.NewReader(body), admin, csrf); w.Code != 200 {
		t.Fatalf("save draft failed: %d %s", w.Code, w.Body.String())
	}
	out2 := tc.run("component_sync_status", `{"file":"`+task+`"}`)
	if !strings.Contains(out2, `"sync_available": false`) || !strings.Contains(out2, `"draft_exists": true`) || !strings.Contains(out2, "修复后的健康断言") {
		t.Fatalf("expected unpublished draft diff to be visible, got: %s", out2)
	}

	// 3. Publish the component fix: tool should immediately report sync_available=true + updated_in_published + diff!
	if w := storeRequest(s, "POST", "/api/components/etcd/draft/publish", strings.NewReader(`{"note":"修复健康检查断言","force":true}`), admin, csrf); w.Code != 200 {
		t.Fatalf("publish failed: %d %s", w.Code, w.Body.String())
	}
	out3 := tc.run("component_sync_status", `{"file":"`+task+`"}`)
	if !strings.Contains(out3, `"sync_available": true`) || !strings.Contains(out3, `"status": "updated_in_published"`) || !strings.Contains(out3, "修复后的健康断言") || !strings.Contains(out3, "修复健康检查断言") {
		t.Fatalf("expected published fix & diff after publish, got: %s", out3)
	}
	if sum := stepSummary("component_sync_status", out3); !strings.Contains(sum, "存在可同步的已发布组件更新") {
		t.Fatalf("unexpected stepSummary after publish: %s", sum)
	}

	// 4. Global AI Assistant also exposes and runs component_sync_status for the delivery.
	foundAssistTool := false
	for _, td := range assistantTools() {
		if td.Name == "component_sync_status" {
			foundAssistTool = true
			break
		}
	}
	if !foundAssistTool {
		t.Fatal("assistantTools missing component_sync_status")
	}
	ac := assistCtx{s: s, user: "admin", ctx: chatCtx{Kind: "job", ID: j.ID}}
	out4 := ac.run("component_sync_status", `{}`)
	if !strings.Contains(out4, `"sync_available": true`) || !strings.Contains(out4, task) {
		t.Fatalf("global assistant component_sync_status unexpected: %s", out4)
	}

	// 5. Secret-like path is denied.
	outSecret := tc.run("component_sync_status", `{"file":"secrets/admin.key"}`)
	if !strings.Contains(outSecret, "密钥/凭据") {
		t.Fatalf("expected secret file denial, got: %s", outSecret)
	}
}

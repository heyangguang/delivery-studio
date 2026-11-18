package main

import (
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
	if len(seen) != 17 || !seen["automatic-execution"] || !seen["change-rehearsal"] {
		t.Fatalf("audit coverage changed: %d skills; review new entries", len(seen))
	}
	for _, sk := range builtinSkills() {
		switch sk.Name {
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

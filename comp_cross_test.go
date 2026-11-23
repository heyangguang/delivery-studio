package main

import (
	"encoding/json"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
	"middleware-deployer/mwpack"
)

func TestCrossWorkspaceParameterWorkflow(t *testing.T) {
	s, _ := testStore(t)
	w := &wb{t: t, s: s}
	w.ok("POST", "/api/components/platform-shared/draft", map[string]any{})
	ids := []string{}
	tc := compToolCtx{s: s, name: sharedPlatformName, proposed: &ids}
	if out := tc.run("workspace_search", sharedTestJSON(map[string]any{"text": "/data", "view": "live"})); !strings.Contains(out, "redis/") {
		t.Fatal(out)
	}
	if out := tc.run("component_files", sharedTestJSON(map[string]any{"name": "redis", "view": "draft"})); !strings.Contains(out, "没有草稿") {
		t.Fatal("unexpected live fallback", out)
	}
	if out := tc.run("propose_component_files", sharedTestJSON(map[string]any{"name": "../escape"})); !strings.Contains(out, "未知组件") {
		t.Fatal(out)
	}
	shared, _, _ := s.comps().readDraft(sharedPlatformName)
	var contract mwpack.HostContract
	if err := yaml.Unmarshal(shared[mwpack.PlatformContractPath], &contract); err != nil {
		t.Fatal(err)
	}
	contract.Parameters = append(contract.Parameters, mwpack.HostParameter{Key: "custom_data_root", Label: "数据根目录", Type: "string", Default: "/data"})
	content, _ := yaml.Marshal(contract)
	w.ok("PUT", "/api/components/platform-shared/draft", map[string]any{"files": map[string]string{mwpack.PlatformContractPath: string(content)}})
	// The shared workbench can propose a private consumer without switching chats.
	file := "roles/redis/tasks/install.yml"
	redis, _, _ := s.comps().liveSet("redis")
	args := sharedTestJSON(map[string]any{"name": "redis", "summary": "读取扩展的公共目录参数", "files": []any{map[string]any{"path": file, "content": string(redis[file]) + "\n- name: 验证公共目录参数传递\n  ansible.builtin.debug:\n    msg: \"{{ mw_hosts[inventory_hostname].params.custom_data_root | default('/data') }}\"\n"}}})
	out := tc.run("propose_component_files", args)
	if !strings.Contains(out, "#/components/redis/edit/files") {
		t.Fatal(out)
	}
	ps := s.loadCompProposals("redis")
	if len(ps) != 1 {
		t.Fatal(ps)
	}
	current, _, _ := s.comps().liveSet("redis")
	if string(current[file]) != string(redis[file]) {
		t.Fatal("proposal changed live component")
	}
	w.ok("POST", "/api/components/redis/ai/proposals/"+ps[0].ID+"/accept", nil)
	result := s.crossCheck([]string{sharedPlatformName, "redis"})
	if !result.OK {
		t.Fatal(result.Results)
	}
	if len(result.Scope) != 2 {
		t.Fatal(result)
	}
	w.ok("POST", "/api/components/etcd/draft", map[string]any{})
	w.ok("PUT", "/api/components/etcd/draft", map[string]any{"files": map[string]string{"component.yaml": "broken: ["}})
	if r := s.crossCheck([]string{sharedPlatformName, "redis"}); !r.OK {
		t.Fatal("unrelated draft leaked", r)
	}
	if r := s.crossCheck([]string{sharedPlatformName, "redis", "etcd"}); r.OK {
		t.Fatal("broken selected draft accepted")
	}
	if r := s.crossCheck([]string{"../escape"}); r.OK {
		t.Fatal("unknown component accepted")
	}
	live, _ := s.plat.cat().HostContract()
	for _, p := range live.Parameters {
		if p.Key == "custom_data_root" {
			t.Fatal("contract published unexpectedly")
		}
	}
	alice, csrf := storeLogin(t, s, "alice")
	if r := storeRequest(s, "POST", "/api/components/cross-check", strings.NewReader(sharedTestJSON(map[string]any{"names": []string{sharedPlatformName}})), alice, csrf); r.Code != 403 {
		t.Fatal(r.Code)
	}
	r := w.ok("POST", "/api/components/cross-check", map[string]any{"names": []string{sharedPlatformName, "redis"}})
	b, _ := json.Marshal(r)
	if !strings.Contains(string(b), "联合试生成通过") {
		t.Fatal(string(b))
	}
	// Structured entries should cover all selected components even when multiple fail.
	w.ok("PUT", "/api/components/redis/draft", map[string]any{"files": map[string]string{"component.yaml": "broken_redis: ["}})
	res := s.crossCheck([]string{sharedPlatformName, "redis", "etcd"})
	if res.OK {
		t.Fatal("expected failure with broken redis and etcd drafts")
	}
	if len(res.Entries) != 3 {
		t.Fatalf("expected 3 structured entries (all checked without short-circuit), got %d: %+v", len(res.Entries), res.Entries)
	}
	if res.Entries[0].Status != "ok" || res.Entries[1].Status != "error" || res.Entries[2].Status != "error" {
		t.Fatalf("unexpected per-entry statuses: %+v", res.Entries)
	}
}

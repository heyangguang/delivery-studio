package server

import (
	"encoding/json"
	"gopkg.in/yaml.v3"
	"delivery-studio/mwpack"
	"strings"
	"testing"
)

func TestPlatformParameterPublishAndAI(t *testing.T) {
	s, _ := testStore(t)
	w := &wb{t: t, s: s}
	w.ok("POST", "/api/components/platform-shared/draft", map[string]any{})
	set, _, _ := s.comps().readDraft(sharedPlatformName)
	var c mwpack.HostContract
	yaml.Unmarshal(set[mwpack.PlatformContractPath], &c)
	c.Parameters = append(c.Parameters, mwpack.HostParameter{Key: "custom_limit", Label: "自定义阈值", Type: "int", Default: 42})
	text, _ := yaml.Marshal(c)
	w.ok("PUT", "/api/components/platform-shared/draft", map[string]any{"files": map[string]string{mwpack.PlatformContractPath: string(text)}})
	live := w.ok("GET", "/api/components/platform-shared/parameters", nil)
	if strings.Contains(sharedTestJSON(live), "custom_limit") {
		t.Fatal("draft leaked into live parameters")
	}
	w.ok("POST", "/api/components/platform-shared/draft/publish", map[string]any{"note": "动态公共参数测试"})
	live = w.ok("GET", "/api/components/platform-shared/parameters", nil)
	if !strings.Contains(sharedTestJSON(live), "custom_limit") {
		t.Fatal("published parameter missing")
	}
	d, err := mwpack.ParseDeployment([]byte(switchRedisSpec))
	if err != nil {
		t.Fatal(err)
	}
	ctx := formCtx{s: s, app: "redis", state: &formState{Deployment: d}}
	if !strings.Contains(ctx.run("read_form", "{}"), "custom_limit") {
		t.Fatal("AI cannot read contract")
	}
	original := set[mwpack.PlatformContractPath]
	ids := []string{}
	comp := compToolCtx{s: s, name: sharedPlatformName, proposed: &ids}
	w.ok("POST", "/api/components/platform-shared/draft", map[string]any{})
	// A proposal changes definitions through the same schema checks as manual edits.
	c.Parameters = append(c.Parameters, mwpack.HostParameter{Key: "ai_note", Label: "AI备注", Type: "string", Default: ""})
	text, _ = yaml.Marshal(c)
	args, _ := json.Marshal(map[string]any{"summary": "新增AI参数", "files": []any{map[string]any{"path": mwpack.PlatformContractPath, "content": string(text)}}})
	out := comp.run("propose_files", string(args))
	if len(ids) == 0 {
		t.Fatal(out)
	}
	if string(s.plat.cat().PlatformSnapshot()[mwpack.PlatformContractPath]) == string(original) {
		t.Fatal("publication was lost")
	}
}

func TestPublicHostParameterStepIsolation(t *testing.T) {
	old := []byte("mw_hosts:\n  n1:\n    ip: 10.0.1.11\n    params: {data_min_free_mb: 1024, custom_limit: 1}\n")
	next := []byte("mw_hosts:\n  n1:\n    ip: 10.0.1.11\n    params: {data_min_free_mb: 2048, custom_limit: 1}\n")
	for _, tc := range []struct {
		text string
		want bool
	}{
		{"value: '{{ mw_hosts[inventory_hostname].params.data_min_free_mb }}'", true},
		{"value: '{{ mw_hosts[inventory_hostname].params.custom_limit }}'", false},
		{"value: '{{ mw_hosts[inventory_hostname].ip }}'", false},
		{"value: '{{ mw_hosts[inventory_hostname].params | to_json }}'", true},
	} {
		hit, why := varsReach(old, next, map[string]string{"task.yml": tc.text})
		if hit != tc.want {
			t.Errorf("%s: hit=%v %s", tc.text, hit, why)
		}
	}
}

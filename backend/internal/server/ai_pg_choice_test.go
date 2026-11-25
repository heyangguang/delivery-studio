package server

import (
	"encoding/json"
	"delivery-studio/mwpack"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPGArchitectureRequiresHumanChoice(t *testing.T) {
	for _, text := range []string{"部署PG一主两从", "一主一从", "三台主从，高可用", "PG用原生还是Patroni主从，有什么区别"} {
		if !needsPGArchitectureAsk("postgresql", text, []aiMsg{{Role: "user", Text: text}}) {
			t.Fatal("missing choice card", text)
		}
	}
	for _, text := range []string{"使用原生主从方案", "Patroni 主从方案", "单机部署"} {
		if needsPGArchitectureAsk("postgresql", text, []aiMsg{{Role: "user", Text: text}}) {
			t.Fatal("unnecessary question", text)
		}
	}
	if pgArchitectureChoice([]aiMsg{{Role: "assistant", Text: "选择 Patroni 主从方案"}}) != "" {
		t.Fatal("assistant guessed choice accepted")
	}
	if pgArchitectureChoice([]aiMsg{{Role: "user", Text: "Patroni是什么"}}) != "" {
		t.Fatal("question treated as consent")
	}
	if needsPGArchitectureAsk("redis", "Redis主从", []aiMsg{{Role: "user", Text: "Redis主从"}}) {
		t.Fatal("PG question leaked into Redis")
	}
}

func TestPGArchitectureCardAndFillGate(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	model, _ := fakeModel(t, "不应调用模型替用户选择")
	enableAI(t, s, model.URL, 0)
	state := s.aiLoad()
	state.Features["form"] = aiFeature{Enabled: true}
	s.aiSave(state)
	original := &mwpack.Deployment{Instances: []mwpack.InstanceSpec{{ID: "pg", Component: "postgresql"}}}
	body, _ := json.Marshal(map[string]any{"message": "部署一个PG一主两从", "ctx": map[string]string{"kind": "form", "id": "postgresql"}, "form": formState{Deployment: original}})
	response := storeRequest(s, "POST", "/api/ai/chats/abcdef234567/chat", strings.NewReader(string(body)), admin, csrf)
	if response.Code != 200 || !strings.Contains(response.Body.String(), "原生主从方案") || !strings.Contains(response.Body.String(), "Patroni 主从方案") {
		t.Fatal(response.Code, response.Body.String())
	}
	chat, _ := s.loadChat("admin", "abcdef234567")
	last := chat.Messages[len(chat.Messages)-1]
	if last.Ask == nil || last.Form != nil || len(last.Ask.Questions[0].Options) != 2 {
		t.Fatal(last)
	}
	comp, _ := s.plat.cat().Get("postgresql")
	dep, _, err := sampleDeployment(comp, previewReq{Preset: "replication"})
	if err != nil {
		t.Fatal(err)
	}
	dep.Schema = mwpack.DeploymentSchema
	args, _ := json.Marshal(map[string]any{"deployment": dep})
	rec := httptest.NewRecorder()
	ctx := formCtx{s: s, app: "postgresql", state: &formState{Deployment: original}, ev: sse{w: rec, f: rec}, messages: []aiMsg{{Role: "user", Text: "一主两从"}}}
	out := ctx.run("fill_form", string(args))
	if ctx.filled != nil || !strings.Contains(out, "ask_user") {
		t.Fatal(out)
	}
	ctx.messages = []aiMsg{{Role: "user", Text: "Patroni 主从方案"}}
	if out = ctx.run("fill_form", string(args)); ctx.filled != nil || !strings.Contains(out, "不一致") {
		t.Fatal(out)
	}
	ctx.messages = []aiMsg{{Role: "user", Text: "原生主从方案"}}
	out = ctx.run("fill_form", string(args))
	if ctx.filled == nil {
		t.Fatal(out)
	}
	schema, err := comp.Describe("")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range schema.Presets {
		if strings.Contains(p.Name, "系列") || strings.Contains(p.Spec, "复用 etcd") {
			t.Fatal(p)
		}
	}
}

func TestPublishedPGNamesUseArchitectureLabels(t *testing.T) {
	s, _ := testStore(t)
	// Existing published manifests can still have old names. Display normalization
	// must not mutate their versioned definitions or change deployment parameters.
	c, _ := s.plat.cat().Get("postgresql")
	for i := range c.Detail.Presets {
		c.Detail.Presets[i].Name = "高可用系列"
	}
	for _, entry := range s.plat.entries() {
		if entry.Name != "postgresql" {
			continue
		}
		for _, p := range entry.Plans {
			if strings.Contains(p.Name, "系列") || strings.Contains(p.Spec, "复用") {
				t.Fatal(p)
			}
		}
	}
	for _, p := range c.Detail.Presets {
		if p.Name != "高可用系列" {
			t.Fatal("display mutated published manifest")
		}
	}
}

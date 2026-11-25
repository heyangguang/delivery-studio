package server

import (
	"encoding/json"
	"delivery-studio/mwpack"
	"net/http/httptest"
	"strings"
	"testing"
)

const switchRedisSpec = `{"id":"redis-dev","platform":"ubuntu-24.04-amd64","hosts":[{"name":"node-01","ip":"172.30.6.163","disk":"/dev/vdb"}],"instances":[{"id":"redis","component":"redis","version":"7.2","placement":{"primary":["node-01"]},"params":{"maxmemory":"3GB"}}]}`

func TestFormSwitchValidationAndPersistence(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	args := `{"target_component":"redis","deployment":` + switchRedisSpec + `,"summary":"Redis dev单节点，沿用机器地址"}`
	model, _ := fakeModel(t, "tool:switch_form:"+args, "已切换到 Redis，地址和单节点需求已保留。")
	enableAI(t, s, model.URL, 0)
	st := s.aiLoad()
	st.Features["form"] = aiFeature{Enabled: true}
	s.aiSave(st)
	original := &mwpack.Deployment{ID: "", Instances: []mwpack.InstanceSpec{{ID: "pg", Component: "postgresql"}}}
	body, _ := json.Marshal(map[string]any{"message": "改为Redis dev单节点，地址172.30.6.163", "ctx": map[string]string{"kind": "form", "id": "postgresql"}, "form": formState{Deployment: original, AllowSwitch: true}})
	r := storeRequest(s, "POST", "/api/ai/chats/abcdef123456/chat", strings.NewReader(string(body)), admin, csrf)
	if r.Code != 200 || !strings.Contains(r.Body.String(), "target_component") {
		t.Fatal(r.Code, r.Body.String())
	}
	chat, ok := s.loadChat("admin", "abcdef123456")
	if !ok || chat.Ctx.ID != "redis" {
		t.Fatal("chat context not switched", chat.Ctx)
	}
	fill := chat.Messages[len(chat.Messages)-1].Form
	if fill == nil || fill.TargetComponent != "redis" || fill.Deployment.Hosts[0].IP != "172.30.6.163" {
		t.Fatal(fill)
	}
	if original.Instances[0].Component != "postgresql" {
		t.Fatal("original overwritten")
	}
	for _, tc := range []struct {
		allow bool
		args  string
	}{{false, args}, {true, strings.Replace(args, `"target_component":"redis"`, `"target_component":"patroni"`, 1)}, {true, strings.Replace(args, `"target_component":"redis"`, `"target_component":"etcd"`, 1)}} {
		ctx := formCtx{s: s, app: "postgresql", state: &formState{Deployment: original, AllowSwitch: tc.allow}, ev: sse{w: httptest.NewRecorder()}}
		ctx.run("switch_form", tc.args)
		if ctx.filled != nil || ctx.app != "postgresql" {
			t.Fatal("invalid switch changed form")
		}
	}
}

func TestFormSwitchIsGeneric(t *testing.T) {
	s, _ := testStore(t)
	for _, pair := range [][2]string{{"postgresql", "redis"}, {"redis", "postgresql"}, {"redis", "nginx"}, {"nginx", "etcd"}} {
		t.Run(pair[0]+"-to-"+pair[1], func(t *testing.T) {
			comp, _ := s.plat.cat().Get(pair[1])
			dep, _, err := sampleDeployment(comp, previewReq{})
			if err != nil {
				t.Fatal(err)
			}
			dep.Schema = mwpack.DeploymentSchema
			rec := httptest.NewRecorder()
			ctx := formCtx{s: s, app: pair[0], state: &formState{AllowSwitch: true, Deployment: &mwpack.Deployment{Instances: []mwpack.InstanceSpec{{Component: pair[0]}}}}, ev: sse{w: rec, f: rec}}
			args, _ := json.Marshal(map[string]any{"target_component": pair[1], "deployment": dep})
			out := ctx.run("switch_form", string(args))
			if ctx.filled == nil || ctx.filled.TargetComponent != pair[1] {
				t.Fatal(out)
			}
		})
	}
}

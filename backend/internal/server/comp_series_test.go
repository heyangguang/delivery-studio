package server

import (
	"gopkg.in/yaml.v3"
	"strings"
	"testing"
)

func TestSeriesPublicationGate(t *testing.T) {
	s, _ := testStore(t)
	files, _, err := s.comps().liveSet("redis")
	if err != nil {
		t.Fatal(err)
	}
	if chk := checkComponent(s.plat, "redis", files); !chk.OK {
		t.Fatal(chk.Problems)
	}
	var manifest map[string]any
	if err := yaml.Unmarshal(expandedTestManifest(t, files), &manifest); err != nil {
		t.Fatal(err)
	}
	presets := manifest["detail"].(map[string]any)["presets"].([]any)
	delete(presets[0].(map[string]any), "contract")
	files["component.yaml"], _ = yaml.Marshal(manifest)
	chk := checkComponent(s.plat, "redis", files)
	if chk.OK {
		t.Fatal("missing series contract can publish")
	}
	found := false
	for _, p := range chk.Problems {
		if strings.Contains(p.Message, "缺少系列契约") {
			found = true
		}
	}
	if !found {
		t.Fatal(chk.Problems)
	}
}

func TestForcePublishCannotBypassSeriesContract(t *testing.T) {
	s, _ := testStore(t)
	w := &wb{t: t, s: s}
	base := "/api/components/redis/draft"
	w.ok("POST", base, map[string]any{"from": "live"})
	files, _, err := s.comps().readDraft("redis")
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	yaml.Unmarshal(expandedTestManifest(t, files), &manifest)
	delete(manifest["detail"].(map[string]any), "presets")
	raw, _ := yaml.Marshal(manifest)
	w.ok("PUT", base, map[string]any{"files": map[string]string{"component.yaml": string(raw)}})
	if code, _ := w.do("POST", base+"/publish", map[string]any{"note": "缺少契约不能发布", "force": true}); code != 422 {
		t.Fatal("force bypassed contract", code)
	}
	if !s.comps().hasDraft("redis") {
		t.Fatal("invalid draft was lost")
	}
}

func TestAIReceivesTheSameSeriesContract(t *testing.T) {
	s, _ := testStore(t)
	text, schema, err := componentBrief(s.plat.cat(), "postgresql", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(schema.Presets) != 3 || schema.Presets[1].Contract == nil {
		t.Fatal("missing schema contract")
	}
	for _, want := range []string{"原生主从方案", "平台系列契约", "manual", "postgresql/native-replication"} {
		if !strings.Contains(text, want) {
			t.Fatal("AI missing", want)
		}
	}
}

func TestSeriesPreviewUsesSelectedTopology(t *testing.T) {
	s, _ := testStore(t)
	c, _ := s.plat.cat().Get("postgresql")
	dep, info, err := sampleDeployment(c, previewReq{})
	if err != nil {
		t.Fatal(err)
	}
	if info.Preset != "single" || len(dep.Instances[0].Placement["replica"]) != 0 {
		t.Fatal("single preset inherited default replicas", info, dep)
	}
}

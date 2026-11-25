package mwpack_test

import (
	"gopkg.in/yaml.v3"
	"delivery-studio/mwpack"
	"strings"
	"testing"
)

func TestPublicHostContract(t *testing.T) {
	cat := fullCatalog(t)
	files := mwpack.PlatformFiles()
	var spec map[string]any
	if e := yaml.Unmarshal(files[mwpack.PlatformContractPath], &spec); e != nil {
		t.Fatal(e)
	}
	params := spec["parameters"].([]any)
	spec["parameters"] = append(params, map[string]any{"key": "custom_limit", "label": "自定义阈值", "type": "int", "default": 42, "min": 1, "max": 100})
	b, _ := yaml.Marshal(spec)
	files[mwpack.PlatformContractPath] = b
	cat = cat.WithPlatformFiles(files)
	d, e := mwpack.ParseDeployment([]byte("id: host-contract\nhosts:\n- name: n1\n  ip: 10.0.1.11\n  params: {storage_mode: system_directory, custom_limit: 66}\ninstances:\n- id: redis\n  component: redis\n  version: '7.2'\n  placement: {primary: [n1]}\n"))
	if e != nil {
		t.Fatal(e)
	}
	plan := mwpack.Solve(cat, d)
	if e := plan.Err(); e != nil {
		t.Fatal(e)
	}
	bundle, e := mwpack.Render(plan, mwpack.RenderOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(bundle.Project["inventory/group_vars/all.yml"].Data), "custom_limit: 66") {
		t.Fatal("dynamic parameter not passed")
	}
	saved := plan.Normalized()
	if saved.Hosts[0].Params["data_min_free_mb"] == nil {
		t.Fatal("defaults not pinned")
	}
	d.Hosts[0].Initialize = true
	if mwpack.Solve(cat, d).Err() == nil {
		t.Fatal("conflicting initialization accepted")
	}
	d.Hosts[0].Initialize = false
	for _, bad := range []any{101, "42", true, nil} {
		d.Hosts[0].Params["custom_limit"] = bad
		if mwpack.Solve(cat, d).Err() == nil {
			t.Fatalf("invalid value accepted %v", bad)
		}
	}
	d.Hosts[0].Params = map[string]any{"unknown": 1}
	if mwpack.Solve(cat, d).Err() == nil {
		t.Fatal("unknown param accepted")
	}
}
func TestPublicContractInvalidRules(t *testing.T) {
	b := mwpack.PlatformFiles()[mwpack.PlatformContractPath]
	for _, bad := range []string{strings.Replace(string(b), "type: enum", "type: script", 1), strings.Replace(string(b), "field: params.storage_mode", "field: params.unknown", 1), strings.Replace(string(b), "hide: [disk, partition, initialize]", "hide: [name]", 1)} {
		if _, err := mwpack.ParseHostContract([]byte(bad)); err == nil {
			t.Fatal("invalid schema accepted")
		}
	}
}

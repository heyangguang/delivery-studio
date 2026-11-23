package mwpack_test

import (
	"encoding/json"
	"middleware-deployer/catalog"
	"middleware-deployer/mwpack"
	"strings"
	"testing"
)

func TestDeliveryModesRequireExecutableContract(t *testing.T) {
	c := &mwpack.Component{DeliveryModes: []string{"automatic"}, Versions: []mwpack.Version{{ID: "1"}}, Overlay: mwpack.Overlay{Tests: []mwpack.Step{{ID: "check", Expect: "command must succeed"}}}}
	problems := mwpack.ValidateDeliveryModes(c)
	if len(problems) != 2 {
		t.Fatalf("missing timeout/postcondition not rejected: %+v", problems)
	}
	c.Tests[0].Timeout = 30
	c.Tests[0].Postconditions = []string{"result.rc == 0"}
	if got := mwpack.ValidateDeliveryModes(c); len(got) != 0 {
		t.Fatal(got)
	}
	c.DeliveryModes = nil
	if c.SupportsDelivery("automatic") || !c.SupportsDelivery("offline") {
		t.Fatal("legacy auto enrollment")
	}
	c.DeliveryModes = []string{"offline", "configuration"}
	if len(mwpack.ValidateConfiguration(c)) == 0 {
		t.Fatal("configuration without outputs accepted")
	}
	c.Configuration = []mwpack.ConfigurationOutput{{Path: "../escape", Content: "text"}}
	if len(mwpack.ValidateConfiguration(c)) == 0 {
		t.Fatal("path escape")
	}
}
func TestConfigurationRendersHostAndParameterWithoutExecution(t *testing.T) {
	cat := loadCatalog(t)
	c, _ := cat.Get("redis")
	c.DeliveryModes = []string{"offline", "configuration"}
	c.Configuration = []mwpack.ConfigurationOutput{{Path: "redis.conf", Content: "bind ${host.ip}\nport ${params.redis_port}\ndir ${host.data_root}/redis\n"}}
	p := mustSolve(t, cat, `id: config-only
schema: mwdeploy/v1
delivery_mode: configuration
hosts:
- name: node-1
  ip: 10.0.0.1
  params: {storage_mode: system_directory, data_root: /srv/data}
instances:
- id: cache
  component: redis
  placement: {primary: [node-1]}
  params: {}
`)
	if e := p.Err(); e != nil {
		t.Fatal(e)
	}
	files, e := mwpack.ConfigurationFiles(p)
	if e != nil {
		t.Fatal(e)
	}
	got := string(files["cache/node-1/redis.conf"])
	if !strings.Contains(got, "bind 10.0.0.1") || !strings.Contains(got, "dir /srv/data/redis") || strings.Contains(got, "${") {
		t.Fatal(got)
	}
	c.Configuration[0].Content = "${params.unknown}"
	if _, e = mwpack.ConfigurationFiles(p); e == nil {
		t.Fatal("unknown placeholder silently emitted")
	}
}

func TestAllDeployableBuiltinCatalogComponentsSupportAutomatic(t *testing.T) {
	cat, err := mwpack.LoadCatalog(catalog.FS)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range cat.Names() {
		c, ok := cat.Get(name)
		if !ok {
			t.Fatalf("missing %s", name)
		}
		if c.Kind == "external" {
			if c.SupportsDelivery("automatic") {
				t.Fatalf("external component %s must not declare automatic delivery", name)
			}
			continue
		}
		if !c.SupportsDelivery("automatic") {
			t.Fatalf("deployable component %s must support automatic execution", name)
		}
		if probs := mwpack.ValidateDeliveryModes(c); len(probs) != 0 {
			t.Fatalf("%s ValidateDeliveryModes errors: %+v", name, probs)
		}
	}
}

func TestRenderedAnsibleCfgDisablesUseTTY(t *testing.T) {
	cat := loadCatalog(t)
	p := mustSolve(t, cat, `id: usetty-check
schema: mwdeploy/v1
hosts:
- name: n1
  ip: 10.0.0.1
  params: {storage_mode: system_directory, data_root: /srv/data}
instances:
- id: etcd
  component: etcd
  placement: {member: [n1]}
  params: {}
`)
	b, err := mwpack.Render(p, mwpack.RenderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cfg := string(b.Project["ansible.cfg"].Data)
	if !strings.Contains(cfg, "usetty = False") {
		t.Fatalf("ansible.cfg must disable TTY allocation (usetty = False) for restricted target-agent keys:\n%s", cfg)
	}
}

func TestAutomaticDeliveryModeDiffersFromOfflineRunbook(t *testing.T) {
	cat := loadCatalog(t)
	baseYAML := `id: mode-diff
schema: mwdeploy/v1
delivery_mode: %s
hosts:
- name: n1
  ip: 10.0.0.1
  params: {storage_mode: system_directory, data_root: /srv/data}
- name: n2
  ip: 10.0.0.2
  params: {storage_mode: system_directory, data_root: /srv/data}
- name: n3
  ip: 10.0.0.3
  params: {storage_mode: system_directory, data_root: /srv/data}
instances:
- id: etcd
  component: etcd
  placement: {member: [n1, n2, n3]}
  params: {}
`
	autoPlan := mustSolve(t, cat, strings.Replace(baseYAML, "%s", "automatic", 1))
	if err := mwpack.ValidateDeliveryMode(autoPlan); err != nil {
		t.Fatalf("automatic ValidateDeliveryMode failed: %v", err)
	}
	offPlan := mustSolve(t, cat, strings.Replace(baseYAML, "%s", "offline", 1))
	if err := mwpack.ValidateDeliveryMode(offPlan); err != nil {
		t.Fatalf("offline ValidateDeliveryMode failed: %v", err)
	}

	autoBundle, err := mwpack.Render(autoPlan, mwpack.RenderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	offBundle, err := mwpack.Render(offPlan, mwpack.RenderOptions{})
	if err != nil {
		t.Fatal(err)
	}

	type planSnippet struct {
		DeliveryMode string `json:"delivery_mode"`
		Prepare      []struct {
			ID string `json:"id"`
		} `json:"prepare"`
	}
	var ap, op planSnippet
	if err := json.Unmarshal(autoBundle.PlanDoc, &ap); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(offBundle.PlanDoc, &op); err != nil {
		t.Fatal(err)
	}
	if ap.DeliveryMode != "automatic" {
		t.Fatalf("expected automatic plan.json delivery_mode, got %q", ap.DeliveryMode)
	}
	if op.DeliveryMode != "offline" {
		t.Fatalf("expected offline plan.json delivery_mode, got %q", op.DeliveryMode)
	}

	autoKeys := map[string]bool{}
	for _, s := range ap.Prepare {
		autoKeys[s.ID] = true
		if s.ID == "ssh-source" || strings.HasPrefix(s.ID, "ssh-target-") || strings.HasPrefix(s.ID, "ssh-trust-") {
			t.Fatalf("automatic prepare steps must not include manual SSH trust step %q", s.ID)
		}
	}
	if !autoKeys["bootstrap-runtime"] {
		t.Fatalf("automatic prepare steps must include bootstrap-runtime: %+v", ap.Prepare)
	}

	offKeys := map[string]bool{}
	for _, s := range op.Prepare {
		offKeys[s.ID] = true
	}
	if !offKeys["ssh-source"] || !offKeys["ssh-target-n2"] || !offKeys["ssh-trust-n2"] {
		t.Fatalf("offline prepare steps must preserve manual SSH trust steps: %+v", op.Prepare)
	}

	autoDeployDoc := string(autoBundle.Docs["01-部署步骤.md"])
	if strings.Contains(autoDeployDoc, "bootstrap-ansible.sh") {
		t.Fatalf("automatic 01-部署步骤.md should not duplicate manual bootstrap-ansible.sh step")
	}
	offDeployDoc := string(offBundle.Docs["01-部署步骤.md"])
	if !strings.Contains(offDeployDoc, "bootstrap-ansible.sh") {
		t.Fatalf("offline 01-部署步骤.md should keep manual bootstrap-ansible.sh step")
	}
}

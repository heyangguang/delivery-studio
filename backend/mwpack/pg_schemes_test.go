package mwpack_test

import (
	"encoding/json"
	"delivery-studio/mwpack"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPostgresDeploymentSchemes(t *testing.T) {
	cat := fullCatalog(t)
	for _, tc := range []struct {
		mode     string
		replicas int
		want     []string
	}{{"single", 0, []string{"postgresql"}}, {"replication", 1, []string{"postgresql"}}, {"replication", 3, []string{"postgresql"}}, {"patroni", 2, []string{"postgresql", "patroni", "etcd"}}, {"legacy", 2, []string{"postgresql", "etcd"}}} {
		t.Run(tc.mode+string(rune('0'+tc.replicas)), func(t *testing.T) {
			hosts := []mwpack.Host{{Name: "pg1", IP: "10.77.0.11", Disk: "/dev/vdb"}}
			placement := map[string][]string{"primary": {"pg1"}}
			for i := 0; i < tc.replicas; i++ {
				name := "pg" + string(rune('2'+i))
				hosts = append(hosts, mwpack.Host{Name: name, IP: "10.77.0.1" + string(rune('2'+i)), Disk: "/dev/vdb"})
				placement["replica"] = append(placement["replica"], name)
			}
			d := &mwpack.Deployment{Schema: mwpack.DeploymentSchema, ID: "scheme-test", Hosts: hosts, Instances: []mwpack.InstanceSpec{{ID: "pg", Component: "postgresql", Version: "17", Placement: placement, Params: map[string]any{"deployment_mode": tc.mode, "tls": false, "tde": false, "replication": "async", "client_cidr": "10.77.0.0/24"}}}}
			p := mwpack.Solve(cat, d)
			if err := p.Err(); err != nil {
				t.Fatal(err)
			}
			checks := p.BuildSteps("runner").Tests
			for _, check := range checks {
				if check.Instance == "pg" && check.Skipped != "" && tc.mode == "patroni" && !strings.Contains(check.Skipped, "由 pg-ha 管理") {
					t.Fatalf("manager ownership missing: %+v", check)
				}
				if check.Instance == "pg" && check.ID == "ha-check" {
					if tc.mode == "single" && !strings.Contains(check.Skipped, "单节点") {
						t.Fatal("single-node reason lost")
					}
					if tc.mode == "replication" && strings.Contains(check.Skipped, "单节点") {
						t.Fatal("replicas mislabeled as single node")
					}
				}
				if check.Instance == "pg-ha" && check.ID == "ha-check" && check.Skipped != "" {
					t.Fatal("manager check must remain executable")
				}
				if check.Instance == "pg-ha" && check.ID == "tde" && check.Skipped != "未启用 TDE" {
					t.Fatal("real skip reason lost")
				}
			}
			endpointChecks := p.BuildSteps("runner").Endpoint
			foundTLS := false
			for _, check := range endpointChecks {
				if check.ID == "tls-negative" && (check.Instance == "pg-ha" || (tc.mode == "single" && check.Instance == "pg")) {
					foundTLS = true
					if check.Skipped != "未启用 TLS" || check.Command != "" {
						t.Fatalf("disabled TLS must remain visible without a command: %+v", check)
					}
				}
				if check.Skipped == "" {
					t.Fatalf("unbound endpoint must never execute: %+v", check)
				}
			}
			if (tc.mode == "single" || tc.mode == "patroni") && !foundTLS {
				t.Fatal("TLS skip disappeared without an endpoint")
			}
			got := map[string]bool{}
			for _, i := range p.Instances {
				got[i.Component] = true
			}
			if len(got) != len(tc.want) {
				t.Fatalf("components %v", got)
			}
			for _, c := range tc.want {
				if !got[c] {
					t.Fatal("missing", c)
				}
			}
			b, err := mwpack.Render(p, mwpack.RenderOptions{})
			if err != nil {
				t.Fatal(err)
			}

			if root := os.Getenv("MW_SCHEME_OUTPUT"); root != "" {
				dir := filepath.Join(root, tc.mode+string(rune('0'+tc.replicas)))
				for name, file := range b.Project {
					path := filepath.Join(dir, name)
					if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, file.Data, 0600); err != nil {
						t.Fatal(err)
					}
				}
			}

			summary := p.Instance("pg").SchemeSummary()
			if tc.mode != "legacy" {
				if summary == nil || summary.ID != tc.mode || summary.Nodes != tc.replicas+1 {
					t.Fatalf("wrong scheme: %+v", summary)
				}
				var lock struct {
					Instances []struct {
						ID     string
						Scheme *mwpack.SchemeSummary
					}
				}
				if err := json.Unmarshal(b.Project["deployment.lock.json"].Data, &lock); err != nil {
					t.Fatal(err)
				}
				found := false
				for _, inst := range lock.Instances {
					if inst.ID == "pg" {
						found = inst.Scheme != nil && inst.Scheme.ID == tc.mode && inst.Scheme.Nodes == tc.replicas+1
					}
				}
				if !found {
					t.Fatal("scheme missing in delivery lock")
				}
				docs := string(b.Docs["00-环境准备.md"])
				if !strings.Contains(docs, summary.Name) {
					t.Fatal("scheme missing in handbook")
				}
			}
			if tc.mode == "patroni" {
				if p.Instance("pg").Uses["dcs"] != nil {
					t.Fatal("database directly requires DCS")
				}
				if p.Instance("pg-ha").Uses["dcs"] == nil {
					t.Fatal("manager missing DCS")
				}
				var play string
				for k, v := range b.Project {
					if strings.Contains(k, "instance-pg-ha/") && strings.HasSuffix(k, "/config.yml") {
						play = string(v.Data)
					}
				}
				if !strings.Contains(play, "mw_instances[''pg'']") {
					t.Fatalf("manager lost database identity: %s", play)
				}
			}
			if tc.mode == "replication" {
				for _, i := range p.Instances {
					for _, pkg := range i.Packages {
						if strings.Contains(pkg.Name, "patroni") || strings.Contains(pkg.Name, "etcd") {
							t.Fatal("unwanted dependency", pkg.Name)
						}
					}
				}
			}
		})
	}
}

func TestPatroniRejectsRemovedExternalDCS(t *testing.T) {
	cat := fullCatalog(t)
	d, err := mwpack.ParseDeployment([]byte("id: existing-dcs\nhosts:\n  - {name: pg1, ip: 10.77.0.11, disk: /dev/vdb}\n  - {name: pg2, ip: 10.77.0.12, disk: /dev/vdb}\ninstances:\n  - id: pg\n    component: postgresql\n    placement: {primary: [pg1], replica: [pg2]}\n    params: {deployment_mode: patroni, dcs_mode: existing, dcs_endpoints: '10.77.1.11:2379,10.77.1.12:2379,10.77.1.13:2379', tls: false, tde: false, client_cidr: 10.77.0.0/24}\n    addons: [{id: pgcrypto, databases: [postgres]}]\n  - id: elb\n    component: external-lb\n    params: {address: pg.example.test, resolve_ip: 10.77.0.100}\n    binds: [{endpoint: pg.writer, listen: 5435}]\n"))
	if err != nil {
		t.Fatal(err)
	}
	if mwpack.Solve(cat, d).Err() == nil {
		t.Fatal("removed external DCS parameters must be rejected, not silently replaced by a new cluster")
	}
	if _, ok := cat.Get("external-etcd"); ok {
		t.Fatal("removed external etcd still in catalog")
	}
}

func TestManagerCannotOverrideDatabase(t *testing.T) {
	cat := fullCatalog(t)
	d, err := mwpack.ParseDeployment([]byte("id: manager-guard\nhosts:\n  - {name: pg1, ip: 10.77.0.11, disk: /dev/vdb}\n  - {name: pg2, ip: 10.77.0.12, disk: /dev/vdb}\ninstances:\n  - id: pg\n    component: postgresql\n    placement: {primary: [pg1], replica: [pg2]}\n    params: {deployment_mode: patroni, tls: false, tde: false, client_cidr: 10.77.0.0/24}\n"))
	if err != nil {
		t.Fatal(err)
	}
	p := mwpack.Solve(cat, d)
	if err := p.Err(); err != nil {
		t.Fatal(err)
	}
	c, _ := cat.Get("postgresql")
	for index := range c.Params {
		if c.Params[index].Key == "max_connections" {
			c.Params[index].Default = 999
		}
	}
	p = mwpack.Solve(cat, d)
	if err := p.Err(); err != nil {
		t.Fatal("manager must inherit database defaults:", err)
	}
	if p.Instance("pg-ha").Params["max_connections"] != p.Instance("pg").Params["max_connections"] {
		t.Fatal("stale manager default")
	}
	manager := p.Instance("pg-ha").Spec
	manager.Params = map[string]any{}
	for k, v := range d.Instances[0].Params {
		manager.Params[k] = v
	}
	manager.Params["max_connections"] = 998
	d.Instances = append(d.Instances, manager)
	if mwpack.Solve(cat, d).Err() == nil {
		t.Fatal("independent database settings accepted")
	}
}

func TestManagerAllowsExtraCustomDatabaseParams(t *testing.T) {
	cat := fullCatalog(t)
	c, _ := cat.Get("postgresql")
	c.Params = append(c.Params, mwpack.Param{
		Key:     "log_to_file",
		Group:   "logging",
		Label:   "日志写入文件",
		Type:    "bool",
		Default: false,
	})
	d, err := mwpack.ParseDeployment([]byte("id: custom-pg-param\nhosts:\n  - {name: pg1, ip: 10.77.0.11, disk: /dev/vdb}\n  - {name: pg2, ip: 10.77.0.12, disk: /dev/vdb}\ninstances:\n  - id: pg\n    component: postgresql\n    placement: {primary: [pg1], replica: [pg2]}\n    params: {deployment_mode: patroni, tls: false, tde: false, client_cidr: 10.77.0.0/24, log_to_file: true}\n"))
	if err != nil {
		t.Fatal(err)
	}
	p := mwpack.Solve(cat, d)
	if err := p.Err(); err != nil {
		t.Fatalf("extra custom database params should not fail companion validation: %v", err)
	}
	if p.Instance("pg").Params["log_to_file"] != true {
		t.Fatalf("expected database custom param log_to_file=true, got %v", p.Instance("pg").Params["log_to_file"])
	}
}

func TestBuiltinSchemeTitlesDescribeCapabilities(t *testing.T) {
	cat := fullCatalog(t)
	for name, want := range map[string][]string{"postgresql": {"单机方案", "原生主从方案", "Patroni 主从方案"}, "redis": {"基础系列", "高可用系列"}} {
		c, _ := cat.Get(name)
		if c.Detail == nil || len(c.Detail.Presets) != len(want) {
			t.Fatalf("%s missing schemes", name)
		}
		for i, p := range c.Detail.Presets {
			if p.Name != want[i] {
				t.Fatalf("%s scheme %d: %s", name, i, p.Name)
			}
		}
	}
}

func TestLBBindsIgnoreHiddenVIPWhenHADisabled(t *testing.T) {
	cat := fullCatalog(t)
	for _, tc := range []struct {
		name     string
		ha       string
		wantAddr string
	}{
		{name: "ha_none_ignores_hidden_vip", ha: "none", wantAddr: "10.77.0.21"},
		{name: "ha_keepalived_uses_vip", ha: "keepalived", wantAddr: "10.77.0.99"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &mwpack.Deployment{
				Schema: mwpack.DeploymentSchema,
				ID:     "lb-vip-guard",
				Hosts: []mwpack.Host{
					{Name: "pg1", IP: "10.77.0.11", Disk: "/dev/vdb"},
					{Name: "pg2", IP: "10.77.0.12", Disk: "/dev/vdb"},
					{Name: "lb1", IP: "10.77.0.21"},
					{Name: "lb2", IP: "10.77.0.22"},
				},
				Instances: []mwpack.InstanceSpec{
					{
						ID:        "pg",
						Component: "postgresql",
						Placement: map[string][]string{"primary": {"pg1"}, "replica": {"pg2"}},
						Params:    map[string]any{"deployment_mode": "patroni", "tls": false, "tde": false, "client_cidr": "10.77.0.0/24"},
					},
					{
						ID:        "lb",
						Component: "haproxy",
						Placement: map[string][]string{"balancer": {"lb1", "lb2"}},
						Params:    map[string]any{"ha": tc.ha, "vip": "10.77.0.99", "vip_interface": "eth0"},
						Binds:     []mwpack.BindSpec{{Endpoint: "pg.writer", Listen: 5435}},
					},
				},
			}
			p := mwpack.Solve(cat, d)
			if err := p.Err(); err != nil {
				t.Fatalf("Solve failed: %v", err)
			}
			front, ok := p.Instance("pg").Fronts["writer"]
			if !ok {
				t.Fatalf("missing pg.Fronts[writer]: %+v", p.Instance("pg").Fronts)
			}
			if front.Address != tc.wantAddr {
				t.Fatalf("Fronts[writer].Address = %q, want %q", front.Address, tc.wantAddr)
			}
		})
	}
}

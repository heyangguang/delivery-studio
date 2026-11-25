package mwpack_test

import (
	"strings"
	"testing"

	"delivery-studio/mwpack"
)

func TestOperationsFollowTheInstance(t *testing.T) {
	p := mustSolve(t, fullCatalog(t), pgHA)
	for _, inst := range p.Instances {
		if inst.External {
			continue
		}
		ops := inst.InstanceOperations(p.Dep.ID)
		if ops == nil || len(ops.Checks) == 0 || len(ops.Faults) == 0 {
			t.Fatalf("%s (%s) has no operations knowledge", inst.ID, inst.Component)
		}
		all := ops.Overview
		for _, c := range ops.Checks {
			all += c.Cmd + c.Expect
		}
		for _, f := range ops.Faults {
			all += f.Cmd + strings.Join(f.Steps, "")
		}
		if strings.Contains(all, "${") {
			t.Errorf("%s: a placeholder was left: %s", inst.ID, all)
		}
	}
	// with replicas the database is run through Patroni; the single-node check is left out
	pg := p.Instance("pg").InstanceOperations(p.Dep.ID)
	titles := ""
	for _, c := range pg.Checks {
		titles += c.Title + "|"
	}
	if !strings.Contains(titles, "集群拓扑") || strings.Contains(titles, "服务状态|") {
		t.Fatalf("checks %s", titles)
	}
	if !strings.Contains(pg.Checks[len(pg.Checks)-2].Cmd, "pg-prod-pg") {
		t.Fatalf("stanza not filled in: %s", pg.Checks[len(pg.Checks)-2].Cmd)
	}
	single := mustSolve(t, fullCatalog(t), pgSingle).Instance("pg").InstanceOperations("pg-one")
	for _, c := range single.Checks {
		if strings.Contains(c.Cmd, "patronictl") {
			t.Fatalf("a single node got a Patroni check: %s", c.Title)
		}
	}
}

func TestImportedOperationsResolvePlaceholders(t *testing.T) {
	dep := &mwpack.Deployment{
		Schema:       mwpack.DeploymentSchema,
		ID:           "redis-imported-qa",
		DeliveryMode: "imported",
		Platform:     "ubuntu-22.04-amd64",
		Imported: &mwpack.ImportedMeta{
			ExactVersion: "6.0.16",
			DataDirs:     []string{"/var/lib/redis"},
			LogDirs:      []string{"/var/log/redis"},
		},
		Hosts: []mwpack.Host{{Name: "pass-4", IP: "192.168.31.153"}},
		Instances: []mwpack.InstanceSpec{{
			ID:        "redis",
			Component: "redis",
			Version:   "6.0.16",
			Placement: map[string][]string{"primary": {"pass-4"}},
			Params:    map[string]any{"redis_port": 6379, "data_dir": "/var/lib/redis"},
		}},
	}
	p := mwpack.SolveImported(fullCatalog(t), dep)
	if p == nil || len(p.Issues) > 0 {
		t.Fatalf("imported solve failed: %+v", p)
	}
	ops := p.Instance("redis").InstanceOperations(dep.ID)
	if ops == nil {
		t.Fatalf("expected operations for imported redis")
	}
	var all strings.Builder
	all.WriteString(ops.Overview)
	for _, c := range ops.Checks {
		all.WriteString(c.Cmd)
		all.WriteString(c.Expect)
	}
	for _, tk := range ops.Tasks {
		all.WriteString(tk.Cmd)
		all.WriteString(tk.Note)
	}
	for _, f := range ops.Faults {
		all.WriteString(f.Cmd)
		all.WriteString(strings.Join(f.Steps, " "))
	}
	for _, l := range ops.Logs {
		all.WriteString(l.Text)
	}
	if strings.Contains(all.String(), "${params.") {
		t.Fatalf("unsubstituted ${params.*} leaked in imported operations: %s", all.String())
	}
}

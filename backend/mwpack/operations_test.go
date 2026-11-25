package mwpack_test

import (
	"strings"
	"testing"
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

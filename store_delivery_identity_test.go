package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"middleware-deployer/mwpack"
)

func TestDeliveryPrimaryDependencyOrder(t *testing.T) {
	pg := &mwpack.Instance{ID: "pg", Component: "postgresql", Version: "17"}
	dcs := &mwpack.Instance{ID: "pg-dcs", Component: "etcd", Version: "3.5"}
	elb := &mwpack.Instance{ID: "elb", Component: "external-lb", External: true}
	plan := &mwpack.Plan{Instances: []*mwpack.Instance{dcs, pg, elb}}
	d := &mwpack.Deployment{Instances: []mwpack.InstanceSpec{{ID: "pg"}, {ID: "elb"}, {ID: "pg-dcs"}}}
	if got := deliveryPrimary(plan, d); got != pg {
		t.Fatalf("derived PG delivery selected dependency: %+v", got)
	}
	// An external frontend must not become the managed application either.
	d.Instances[0], d.Instances[1] = d.Instances[1], d.Instances[0]
	if got := deliveryPrimary(plan, d); got != pg {
		t.Fatalf("selected frontend: %+v", got)
	}
}

func TestDeliveryAppVersionUsesMatchingLockedComponent(t *testing.T) {
	s, _ := testStore(t)
	dir := filepath.Join(s.jobDir("identity-test"), "output")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{"17", "18"} {
		body := []byte("{\"instances\":[{\"component\":\"etcd\",\"version\":\"3.5\"},{\"component\":\"postgresql\",\"version\":\"" + version + "\"}]}")
		if err := os.WriteFile(filepath.Join(dir, "deployment.lock.json"), body, 0600); err != nil {
			t.Fatal(err)
		}
		if got := s.deliveryAppVersion("identity-test", "postgresql", "3.5"); got != version {
			t.Fatalf("got %s, want %s", got, version)
		}
	}
	if got := s.deliveryAppVersion("missing", "postgresql", "17"); got != "17" {
		t.Fatal(got)
	}
}

func TestDeliverySchemeUsesStoredSnapshotOnly(t *testing.T) {
	s, _ := testStore(t)
	dir := filepath.Join(s.jobDir("scheme-history"), "output")
	os.MkdirAll(dir, 0700)
	saved := &mwpack.SchemeSummary{ID: "replication", Name: "主从系列", Nodes: 2, Contract: &mwpack.SeriesContract{Series: "replication", Failover: "manual", Mechanism: "原生复制"}}
	cases := []struct {
		name      string
		instances []mwpack.InstanceView
		want      string
	}{
		{"dependency first", []mwpack.InstanceView{{ID: "dcs", Component: "etcd", Scheme: &mwpack.SchemeSummary{Name: "高可用系列"}}, {ID: "pg", Component: "postgresql", Scheme: saved}}, "主从系列"},
		{"old contract", []mwpack.InstanceView{{ID: "pg", Component: "postgresql", Contract: saved.Contract, Roles: map[string][]string{"primary": {"a"}, "replica": {"b"}}}}, "主从系列"},
		{"unknown history", []mwpack.InstanceView{{ID: "pg", Component: "postgresql", Roles: map[string][]string{"primary": {"a"}, "replica": {"b", "c"}}}}, "PostgreSQL 主从架构"},
		{"ambiguous application", []mwpack.InstanceView{{ID: "pg1", Component: "postgresql", Scheme: saved}, {ID: "pg2", Component: "postgresql", Scheme: saved}}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, _ := json.Marshal(map[string]any{"instances": tc.instances})
			os.WriteFile(filepath.Join(dir, "plan.json"), raw, 0600)
			got := s.deliveryScheme("scheme-history", "postgresql", nil)
			if tc.want == "" {
				if got != nil {
					t.Fatal("invented historical scheme", got)
				}
			} else if got == nil || got.Name != tc.want || got.Nodes != 2 && tc.name != "unknown history" {
				t.Fatalf("wrong snapshot: %+v", got)
			}
		})
	}
	if got := s.deliveryScheme("missing", "postgresql", saved); got != saved {
		t.Fatal("queued delivery lost snapshot")
	}
}
func TestCurrentSchemeDoesNotUsePendingTarget(t *testing.T) {
	current := storeJob{ID: "done", State: "succeeded", Outcome: outcomeDone, Scheme: &mwpack.SchemeSummary{Name: "主从系列", Nodes: 2}}
	pending := storeJob{ID: "next", Seq: 1, State: "succeeded", Scheme: &mwpack.SchemeSummary{Name: "主从系列", Nodes: 4}}
	got, ok := clusterCurrent([]storeJob{current, pending})
	if !ok || got.Scheme.Nodes != 2 {
		t.Fatal("pending target shown as current", got)
	}
	pending.Outcome = outcomeDone
	got, ok = clusterCurrent([]storeJob{current, pending})
	if !ok || got.Scheme.Nodes != 4 {
		t.Fatal("confirmed scheme not advanced", got)
	}
}

func TestLegacyPatroniArchitectureRequiresLinkedEvidence(t *testing.T) {
	s, _ := testStore(t)
	dir := filepath.Join(s.jobDir("legacy-proof"), "output")
	os.MkdirAll(dir, 0700)
	// Read-only display evidence must not invent a series contract or operations.
	raw := `{"instances":[{"id":"pg","component":"postgresql","roles":{"primary":["a"],"replica":["b","c"]},"ports":[{"Name":"patroni-rest","Port":8008}],"uses":{"dcs":{"instance":"dcs","component":"etcd"}}},{"id":"dcs","component":"etcd"}]}`
	os.WriteFile(filepath.Join(dir, "plan.json"), []byte(raw), 0600)
	got := s.deliveryScheme("legacy-proof", "postgresql", nil)
	if got == nil || got.Name != "Patroni 高可用架构" || got.Source != "delivery-evidence" || got.Nodes != 3 || len(got.Evidence) != 3 {
		t.Fatal(got)
	}
	if got.Contract.Series != "" || got.Contract.Failover != "" || len(got.Contract.Operations) != 0 {
		t.Fatal("display inferred execution permissions", got)
	}
	raw = strings.Replace(raw, "patroni-rest", "other-port", 1)
	os.WriteFile(filepath.Join(dir, "plan.json"), []byte(raw), 0600)
	if got = s.deliveryScheme("legacy-proof", "postgresql", nil); got.Name == "Patroni 高可用架构" {
		t.Fatal("guessed HA from three hosts", got)
	}
}

package server

import (
	"encoding/json"
	"delivery-studio/mwpack"
	"net/http/httptest"
	"strings"
	"testing"
)

// A first deployment that has not been carried out can be changed: the new delivery replaces it, the old one is
// voided, the cluster id stays, and what changed is shown.
func TestReviseFirstDeployment(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	make1 := func(spec string) (int, storeJob, string) {
		w := storeCreate(t, s, alice, csrf, spec, nil)
		s.wg.Wait()
		var j storeJob
		json.Unmarshal(w.Body.Bytes(), &j)
		if j.ID != "" {
			s.mu.Lock()
			j = s.jobs[j.ID]
			s.mu.Unlock()
		}
		return w.Code, j, w.Body.String()
	}
	one := `{"id":"etcd-rev","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	code, a, body := make1(one)
	if code != 202 || a.State != "succeeded" {
		t.Fatal(code, body, a.State, a.Error)
	}
	changed := strings.Replace(one, "10.0.1.11", "10.0.1.21", 1)
	// the cluster id is the cluster: a revision cannot move to another one
	other := strings.Replace(changed, "etcd-rev", "etcd-other", 1)
	if code, _, body = make1(other + `,"revises":"` + a.ID + `"`); code != 409 || !strings.Contains(body, "集群标识不能变") {
		t.Fatal("a revision changed the cluster id", code, body)
	}
	code, b, body := make1(changed + `,"revises":"` + a.ID + `"`)
	_ = b
	if code != 202 {
		t.Fatal(code, body)
	}
	s.mu.Lock()
	old, nw := s.jobs[a.ID], s.jobs[b.ID]
	s.mu.Unlock()
	if nw.Revises != a.ID || nw.Seq != 0 || nw.ClusterID != "etcd-rev" || nw.State != "succeeded" {
		t.Fatalf("revision not recorded: %+v", nw)
	}
	if old.Outcome != outcomeVoid || old.RevisedBy != nw.ID {
		t.Fatalf("the replaced deployment was not voided: %+v", old)
	}
	// what changed is what the new delivery's page shows
	l := s.lineageOf(nw)
	if l == nil || !l.Revision || l.Source == nil || l.Source.ID != a.ID || len(l.Changes) == 0 {
		t.Fatalf("lineage does not show the revision: %+v", l)
	}
	// the new one now holds the cluster; the old one cannot be revised again, the new one can
	if code, _, body = make1(one + `,"revises":"` + a.ID + `"`); code != 409 {
		t.Fatal("a voided deployment was revised", code, body)
	}
	// the newest one holds the cluster and can be revised again
	if code, _, body = make1(changed + `,"revises":"` + nw.ID + `"`); code != 202 {
		t.Fatal("the newest deployment could not be revised", code, body)
	}
}

// The assistant must not write a cluster id that already has a delivery into the form: it is told, and picks another.
func TestFillFormRefusesTakenClusterID(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	spec := `{"id":"etcd-taken","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	if w := storeCreate(t, s, alice, csrf, spec, nil); w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	s.wg.Wait()
	c := &formCtx{s: s, app: "etcd", state: &formState{Deployment: &mwpack.Deployment{}}, ev: sse{w: httptest.NewRecorder()}}
	out := c.run("fill_form", `{"deployment":`+spec+`}`)
	if !strings.Contains(out, "已经被使用") || !strings.Contains(out, "没有填入表单") {
		t.Fatal("the taken id was written into the form:", out)
	}
	fresh := strings.Replace(spec, "etcd-taken", "etcd-fresh", 1)
	if out = c.run("fill_form", `{"deployment":`+fresh+`}`); !strings.Contains(out, "已填入表单") {
		t.Fatal("a free id was refused:", out)
	}
}

func TestSpecDiffHostParamsPerKeyAndMultiField(t *testing.T) {
	a := &mwpack.Deployment{
		Platform: "ubuntu-24.04-amd64",
		Hosts: []mwpack.Host{
			{
				Name: "pass-4",
				IP:   "192.168.31.153",
				Disk: "/dev/sdb",
				Params: map[string]any{
					"storage_mode":     "system_directory",
					"data_root":        "/opt/nginx-change-data",
					"data_min_free_mb": 1024,
					"legacy_opt":       "old",
				},
			},
		},
	}
	b := &mwpack.Deployment{
		Platform: "ubuntu-24.04-amd64",
		Hosts: []mwpack.Host{
			{
				Name: "pass-4",
				IP:   "192.168.31.154",
				Disk: "/dev/sdc",
				Params: map[string]any{
					"storage_mode":     "system_directory",
					"data_root":        "/opt/nginx-change-data",
					"data_min_free_mb": 512,
					"extra_opt":        "new",
				},
			},
		},
	}

	changes := specDiff(a, b)
	byLabel := map[string]Change{}
	for _, c := range changes {
		if strings.Contains(c.From, "map[") || strings.Contains(c.To, "map[") {
			t.Fatalf("host diff leaked raw Go map syntax: %+v", c)
		}
		byLabel[c.Label] = c
	}
	if ch, ok := byLabel["机器 pass-4 的 IP"]; !ok || ch.From != "192.168.31.153" || ch.To != "192.168.31.154" {
		t.Fatalf("missing IP diff: %+v", changes)
	}
	if ch, ok := byLabel["机器 pass-4 · data_min_free_mb"]; !ok || ch.Op != "change" || ch.From != "1024" || ch.To != "512" {
		t.Fatalf("missing per-key host param change: %+v", changes)
	}
	if ch, ok := byLabel["机器 pass-4 · extra_opt"]; !ok || ch.Op != "add" || ch.To != "new" {
		t.Fatalf("missing per-key host param add: %+v", changes)
	}
	if ch, ok := byLabel["机器 pass-4 · legacy_opt"]; !ok || ch.Op != "remove" || ch.From != "old" {
		t.Fatalf("missing per-key host param remove: %+v", changes)
	}
	if _, unchanged := byLabel["机器 pass-4 · storage_mode"]; unchanged {
		t.Fatalf("unchanged host param should not appear in diff: %+v", changes)
	}
	if ch, ok := byLabel["机器 pass-4 的数据盘"]; !ok || ch.From != "/dev/sdb" || ch.To != "/dev/sdc" {
		t.Fatalf("missing disk diff alongside IP/param changes: %+v", changes)
	}
}

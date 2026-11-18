package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"gopkg.in/yaml.v3"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestPGELBDeliverySyncIsolation(t *testing.T)      { testPGELBDeliverySyncIsolation(t, false) }
func TestPatroniELBDeliverySyncIsolation(t *testing.T) { testPGELBDeliverySyncIsolation(t, true) }
func testPGELBDeliverySyncIsolation(t *testing.T, managed bool) {
	s, _ := testStore(t)
	// Release validation may supply installed overrides; always copy into the
	// isolated test store before exercising edits, publication and restoration.
	if packs := os.Getenv("MW_TEST_COMPONENTS"); packs != "" {
		entries, err := os.ReadDir(packs)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			if err := os.CopyFS(filepath.Join(s.cfg.ComponentsDir, entry.Name()), os.DirFS(filepath.Join(packs, entry.Name()))); err != nil {
				t.Fatal(err)
			}
		}
		if err := s.plat.reload(); err != nil {
			t.Fatal(err)
		}
		if broken := s.plat.brokenList(); len(broken) != 0 {
			t.Fatalf("invalid release components: %+v", broken)
		}
	}
	admin, csrf := storeLogin(t, s, "admin")
	spec := map[string]any{
		"id":    "pg-elb-isolation",
		"hosts": []any{map[string]any{"name": "db-1", "ip": "10.77.0.11", "disk": "/dev/vdb"}, map[string]any{"name": "db-2", "ip": "10.77.0.12", "disk": "/dev/vdb"}, map[string]any{"name": "db-3", "ip": "10.77.0.13", "disk": "/dev/vdb"}},
		"instances": []any{
			map[string]any{"id": "pg", "component": "postgresql", "placement": map[string]any{"primary": []string{"db-1"}, "replica": []string{"db-2", "db-3"}}, "params": map[string]any{"client_cidr": "10.77.0.0/24", "tls": false, "tde": false}},
			map[string]any{"id": "elb", "component": "external-lb", "params": map[string]any{"address": "pg.example.test", "resolve_ip": "10.77.0.100"}, "binds": []any{map[string]any{"endpoint": "pg.writer", "listen": 5435}}},
		}}
	if managed {
		spec["instances"].([]any)[0].(map[string]any)["params"].(map[string]any)["deployment_mode"] = "patroni"
	}
	raw, _ := json.Marshal(spec)
	w := storeCreate(t, s, admin, csrf, string(raw), nil)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	var j storeJob
	json.Unmarshal(w.Body.Bytes(), &j)
	s.wg.Wait()
	s.mu.Lock()
	j = s.jobs[j.ID]
	s.mu.Unlock()
	if j.State != "succeeded" {
		t.Fatal(j.Error)
	}
	original, err := s.projectFiles(j.ID)
	if err != nil {
		t.Fatal(err)
	}
	baselineComponent, _, err := s.comps().liveSet("postgresql")
	if err != nil {
		t.Fatal(err)
	}
	managerComponent := baselineComponent
	if managed {
		managerComponent, _, err = s.comps().liveSet("patroni")
		if err != nil {
			t.Fatal(err)
		}
	}
	instance := "pg"
	if managed {
		instance = "pg-ha"
	}
	allChecks := []string{}
	for _, st := range flatSteps(s.runbookSteps(j.ID)) {
		// The installed PG pack has an Ansible-only frontend preflight;
		// it does not consume the Python test runtime or its directory.
		if st.Key == "endpoint/"+instance+"/front-preflight" {
			continue
		}
		if strings.HasPrefix(st.Key, "tests/"+instance+"/") || strings.HasPrefix(st.Key, "endpoint/"+instance+"/") || strings.HasPrefix(st.Key, "cleanup/"+instance+"/") {
			allChecks = append(allChecks, st.Key)
		}
	}
	for _, tc := range []struct{ name, file, step string }{
		{"private action", "roles/postgresql/files/pgstep_full_backup.py", "tests/pg/full-backup"},
		{"private template", "roles/postgresql/templates/pgstep_full_backup.json.j2", "tests/pg/full-backup"},
		{"ELB action", "roles/postgresql/files/pgstep_front_failover.py", "endpoint/pg/front-failover"},
		{"deployment task", "roles/postgresql/tasks/os_baseline.yml", "deploy/install/instance-pg/os-baseline"},
		{"private configuration", "component.yaml", "tests/pg/full-backup"},
		{"database parameter", "component.yaml", "deploy/configure/instance-pg/config"},
		{"shared test directory", "roles/postgresql/defaults/main.yml", strings.Join(allChecks, "|")},
		{"shared runtime", "roles/postgresql/files/pgcommon.py", strings.Join(allChecks, "|")},
	} {
		component := "postgresql"
		baselineFiles := baselineComponent
		if managed {
			if tc.name != "deployment task" && tc.name != "database parameter" {
				component, baselineFiles = "patroni", managerComponent
				tc.file = strings.ReplaceAll(tc.file, "roles/postgresql/", "roles/patroni/")
			}
			if tc.name != "deployment task" {
				tc.step = strings.ReplaceAll(tc.step, "/pg/", "/pg-ha/")
				tc.step = strings.ReplaceAll(tc.step, "instance-pg/", "instance-pg-ha/")
			}
		}
		t.Run(tc.name, func(t *testing.T) {
			// Seed separate evidence for every step; none is a claim about a real cluster.
			saved := map[string]stepRecord{}
			for _, st := range flatSteps(s.runbookSteps(j.ID)) {
				saved[st.Key] = stepRecord{State: "done", Note: "isolated fixture: " + st.Key}
			}
			s.mu.Lock()
			doc := s.readProgress(j.ID)
			doc.Steps = saved
			if err := s.writeProgress(j.ID, doc); err != nil {
				t.Fatal(err)
			}
			s.mu.Unlock()
			publish := func(text string) {
				w := storeRequest(s, "POST", "/api/components/"+component+"/draft", strings.NewReader("{\"from\":\"live\"}"), admin, csrf)
				if w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
				body, _ := json.Marshal(map[string]any{"files": map[string]string{tc.file: text}})
				w = storeRequest(s, "PUT", "/api/components/"+component+"/draft", bytes.NewReader(body), admin, csrf)
				if w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
				w = storeRequest(s, "POST", "/api/components/"+component+"/draft/publish", strings.NewReader("{\"note\":\"isolated sync test\",\"force\":true}"), admin, csrf)
				if w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
			}
			baseline := string(baselineFiles[tc.file])
			if tc.file == "component.yaml" {
				baseline = string(expandedTestManifest(t, baselineFiles))
			}
			want := strings.Split(tc.step, "|")
			affected := map[string]bool{}
			for _, key := range want {
				affected[key] = true
			}
			changed := baseline
			switch {
			case tc.file == "component.yaml":
				var manifest map[string]any
				if err := yaml.Unmarshal([]byte(changed), &manifest); err != nil {
					t.Fatal(err)
				}
				if tc.name == "database parameter" {
					for _, value := range manifest["params"].([]any) {
						param := value.(map[string]any)
						if param["key"] == "max_connections" {
							param["default"] = 250
						}
					}
				} else {
					found := false
					for _, value := range manifest["tests"].([]any) {
						step := value.(map[string]any)
						if step["id"] == "full-backup" {
							// Keep the step contract; change only its private setting.
							raw, _ := yaml.Marshal(step)
							next := strings.Replace(string(raw), "value: 7200", "value: 3600", 1)
							if next == string(raw) {
								t.Fatal("missing full-backup timeout")
							}
							if err := yaml.Unmarshal([]byte(next), &step); err != nil {
								t.Fatal(err)
							}
							found = true
						}
					}
					if !found {
						t.Fatal("missing full-backup contract")
					}
				}
				raw, err := yaml.Marshal(manifest)
				if err != nil {
					t.Fatal(err)
				}
				changed = string(raw)
			case strings.HasSuffix(tc.file, "/defaults/main.yml"):
				changed = strings.Replace(changed, "pg_testroot:", "pg_testroot_unused:", 1)
				changed += "\npg_testroot: /tmp/isolated-pg-testroot\n"
			case strings.HasSuffix(tc.file, ".py"):
				changed += "\nISOLATED_TEST_REVISION = 2\n"
			case strings.HasSuffix(tc.file, ".j2"):
				changed = strings.Replace(changed, "'pg_port': mw.params.pg_port", "'pg_port': (mw.params.pg_port | int) + 1", 1)
			default:
				changed += "\n- name: Isolated regression check\n  ansible.builtin.debug: {msg: test-only}\n"
			}
			if changed == baseline {
				t.Fatal("mutation failed")
			}
			publish(changed)
			check := func(want []string) {
				s.mu.Lock()
				j = s.jobs[j.ID]
				s.mu.Unlock()
				pv, _, _ := s.previewSync(j)
				if pv.Blocked != "" {
					t.Fatal(pv.Blocked)
				}
				var keys []string
				for _, phase := range pv.Phases {
					for _, step := range phase.Changed {
						keys = append(keys, step.Key)
					}
				}
				sort.Strings(keys)
				sort.Strings(want)
				if !reflect.DeepEqual(keys, want) {
					t.Fatalf("changed steps = %v, want %v; reasons=%v", keys, want, pv.Why)
				}
				t.Logf("%s: exactly %v; changed files=%v", tc.name, keys, pv.Files)
				w := storeRequest(s, "POST", "/api/jobs/"+j.ID+"/sync", nil, admin, csrf)
				if w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
			}
			check(append([]string(nil), want...))
			s.mu.Lock()
			after := s.readProgress(j.ID)
			s.mu.Unlock()
			for key, rec := range saved {
				if affected[key] {
					if _, ok := after.Steps[key]; ok {
						t.Fatal("changed step retained old success")
					}
					continue
				}
				if !reflect.DeepEqual(after.Steps[key], rec) {
					t.Fatal("unrelated record changed", key)
				}
			}
			files, _ := s.projectFiles(j.ID)
			if tc.file != "component.yaml" && string(files[tc.file]) != changed {
				t.Fatal("delivery did not take patch")
			}
			publish(baseline)
			check(append([]string(nil), want...))
			files, _ = s.projectFiles(j.ID)
			if tc.file != "component.yaml" && !bytes.Equal(files[tc.file], original[tc.file]) {
				t.Fatal("restoration failed")
			}
			s.mu.Lock()
			j = s.jobs[j.ID]
			s.mu.Unlock()
			pv, _, _ := s.previewSync(j)
			if pv.Available {
				t.Fatal("still out of sync after restoration", fmt.Sprint(pv))
			}
		})
	}
	final, _ := s.projectFiles(j.ID)
	for name, b := range original {
		if !bytes.Equal(b, final[name]) {
			t.Errorf("not restored: %s", name)
		}
	}
	t.Log("All temporary component modifications restored; isolated delivery matches original project bytes")
}

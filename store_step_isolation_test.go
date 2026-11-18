package main

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"middleware-deployer/catalog"
	"middleware-deployer/mwpack"
	"strings"
	"testing"
	"testing/fstest"
)

func TestRealComponentPrivateStepChangesStayLocal(t *testing.T) {
	for _, tc := range []struct{ name, placement, params, file string }{
		{"postgresql", "primary: [n1]", "{client_cidr: 10.0.1.0/24, tls: false, tde: false}", "roles/postgresql/files/pgstep_full_backup.py"},
		{"redis", "primary: [n1]", "{}", "roles/redis/tasks/test_auth.yml"},
		{"nginx", "balancer: [n1]", "{}", "roles/nginx/tasks/configure.yml"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := fstest.MapFS{}
			err := fs.WalkDir(catalog.FS, ".", func(p string, d fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if !d.IsDir() {
					b, e := fs.ReadFile(catalog.FS, p)
					if e != nil {
						return e
					}
					source[p] = &fstest.MapFile{Data: b}
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			spec := "id: isolation\nhosts:\n  - {name: n1, ip: 10.0.1.11, disk: /dev/vdb}\ninstances:\n  - id: subject\n    component: " + tc.name + "\n    placement: {" + tc.placement + "}\n    params: " + tc.params + "\n"
			render := func() *mwpack.Bundle {
				cat, err := mwpack.LoadCatalog(source)
				if err != nil {
					t.Fatal(err)
				}
				dep, err := mwpack.ParseDeployment([]byte(spec))
				if err != nil {
					t.Fatal(err)
				}
				p := mwpack.Solve(cat, dep)
				b, err := mwpack.Render(p, mwpack.RenderOptions{})
				if err != nil {
					t.Fatal(err)
				}
				return b
			}
			old := render()
			f := source[tc.name+"/"+tc.file]
			if strings.HasSuffix(tc.file, ".py") {
				f.Data = append(append([]byte(nil), f.Data...), []byte("\n# revised private action\n")...)
			} else {
				f.Data = append(append([]byte(nil), f.Data...), []byte("\n- name: Additional private check\n  ansible.builtin.debug: {msg: revised}\n")...)
			}
			now := render()
			server := &storeServer{}
			before := map[string]reportStep{}
			for _, st := range flatSteps(server.runbookStepsOf(old.PlanDoc, "")) {
				before[stepIdentity(st)] = st
			}
			steps := flatSteps(server.runbookStepsOf(now.PlanDoc, ""))
			oldFiles, newFiles := projectMap(old), projectMap(now)
			changed := map[string]bool{}
			for f, b := range newFiles {
				if !bytes.Equal(oldFiles[f], b) {
					changed[f] = true
				}
			}
			impact := impactOf(steps, before, oldFiles, newFiles, changed)
			hits, untouched := 0, 0
			for _, st := range steps {
				if st.Playbook == "" {
					continue
				}
				uses := usedBy(newFiles, st.Playbook)[tc.file]
				if impact[st.Key].Changed {
					hits++
					if !uses {
						t.Errorf("private change leaked to %s: %s", st.Key, impact[st.Key].Why)
					}
				} else {
					untouched++
					if uses {
						t.Errorf("missed owner %s", st.Key)
					}
				}
			}
			if hits == 0 || untouched < 2 {
				t.Fatalf("expected owner and at least two unchanged steps; changed=%d unchanged=%d", hits, untouched)
			}
		})
	}
}

func TestRunbookStepFormatKeepsLegacyAndSeparatesNewRecords(t *testing.T) {
	raw := []byte("{\"step_format\":2,\"deploy\":[{\"phase\":\"install\",\"title\":\"Install\",\"playbook\":\"phase.yml\",\"steps\":[{\"id\":\"a\",\"instance\":\"x\",\"playbook\":\"a.yml\"},{\"id\":\"b\",\"instance\":\"x\",\"playbook\":\"b.yml\"}]}]}")
	s := &storeServer{}
	steps := flatSteps(s.runbookStepsOf(raw, ""))
	found := map[string]bool{}
	for _, st := range steps {
		found[st.Key] = true
	}
	if !found["deploy/install/instance-x/a"] || !found["deploy/install/instance-x/b"] || found["deploy/deploy-install"] {
		t.Fatalf("new steps not separate: %v", found)
	}
	var doc map[string]any
	json.Unmarshal(raw, &doc)
	delete(doc, "step_format")
	legacy, _ := json.Marshal(doc)
	found = map[string]bool{}
	for _, st := range flatSteps(s.runbookStepsOf(legacy, "")) {
		found[st.Key] = true
	}
	if !found["deploy/deploy-install"] {
		t.Fatal("legacy record identity lost")
	}
}

func TestRemovedDependencyStillInvalidatesItsOwner(t *testing.T) {
	play := []byte("- hosts: all\n  roles: [demo]\n")
	old := map[string][]byte{"a.yml": play, "roles/demo/tasks/main.yml": []byte("- copy: {src: a.txt, dest: /tmp/a}\n"), "roles/demo/files/a.txt": []byte("before")}
	now := map[string][]byte{}
	for k, v := range old {
		if k != "roles/demo/files/a.txt" {
			now[k] = v
		}
	}
	st := reportStep{Key: "a", Playbook: "a.yml"}
	im := impactOf([]reportStep{st}, map[string]reportStep{"a": st}, old, now, map[string]bool{"roles/demo/files/a.txt": true})
	if !im["a"].Changed {
		t.Fatal("deleted source dependency was ignored")
	}
}

func TestRunLogsNeverMatchAnotherInstancesSameNamedStep(t *testing.T) {
	a := "steps/deploy/verify/instance-a/health.yml"
	b := "steps/deploy/verify/instance-b/health.yml"
	logs := []runLog{{Playbook: a, Result: "PASSED"}, {Playbook: b, Result: "FAILED"}, {Playbook: "health.yml", Result: "PASSED"}}
	if got := stepRuns(logs, a); len(got) != 1 || got[0].Result != "PASSED" {
		t.Fatalf("A log collision: %+v", got)
	}
	if got := stepRuns(logs, b); len(got) != 1 || got[0].Result != "FAILED" {
		t.Fatalf("B log collision: %+v", got)
	}
	if got := stepRuns([]runLog{{Playbook: "01-install.yml"}}, "playbooks/01-install.yml"); len(got) != 1 {
		t.Fatal("legacy log matching lost")
	}
}

func TestStructuredStepResultIsValidated(t *testing.T) {
	log := "playbook   tests/pg/a.yml\nSTEP_RESULT {\"schema\":\"mwstep-result/v1\",\"step\":\"tests/pg/a.yml\",\"status\":\"passed\"}\nRESULT  PASSED\n"
	if r := parseRunLog("x.log", []byte(log)); !r.ok() {
		t.Fatal("valid structured result rejected", r)
	}
	for _, bad := range []string{
		strings.Replace(log, "\"step\":\"tests/pg/a.yml\"", "\"step\":\"tests/pg/b.yml\"", 1),
		strings.Replace(log, "\"status\":\"passed\"", "\"status\":\"failed\"", 1),
		strings.Replace(log, "mwstep-result/v1", "mwstep-result/v9", 1),
	} {
		if r := parseRunLog("x.log", []byte(bad)); r.ok() {
			t.Fatal("inconsistent step result accepted")
		}
	}
}

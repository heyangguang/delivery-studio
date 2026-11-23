package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// A component is fixed after a delivery was generated from it. The delivery takes the fix in one go: the changed test
// gets a new version, its old version and the record against it are kept (for the report), an untouched step keeps
// its record, and the controller gets an update package with only the changed project file.
func TestDeliveryTakesAComponentFix(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	spec := `{"id":"etcd-sync","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	w := storeCreate(t, s, admin, csrf, spec, nil)
	s.wg.Wait()
	var j storeJob
	json.Unmarshal(w.Body.Bytes(), &j)
	s.mu.Lock()
	j = s.jobs[j.ID]
	s.mu.Unlock()
	if j.State != "succeeded" {
		t.Fatal(j.State, j.Error)
	}
	var health, putget string
	for _, st := range flatSteps(s.runbookSteps(j.ID)) {
		if strings.HasSuffix(st.Key, "/health") {
			health = st.Key
		}
		if strings.HasSuffix(st.Key, "/put-get") {
			putget = st.Key
		}
	}
	if health == "" || putget == "" {
		t.Fatal("test steps not found", s.runbookSteps(j.ID))
	}
	rec := func(key, note string) {
		b, _ := json.Marshal(map[string]any{"key": key, "title": key, "state": "failed", "note": note})
		if w := storeRequest(s, "PUT", "/api/jobs/"+j.ID+"/progress", bytes.NewReader(b), admin, csrf); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	rec(health, "旧的健康检查在这台机器上失败")
	rec(putget, "写入读取正常")
	// nothing changed yet
	if w := storeRequest(s, "GET", "/api/jobs/"+j.ID+"/sync", nil, admin, ""); !strings.Contains(w.Body.String(), `"available":false`) {
		t.Fatal("a sync was offered with no change", w.Body.String())
	}
	// fix the component: the health test task changes
	if w := storeRequest(s, "POST", "/api/components/etcd/draft", strings.NewReader(`{"from":"builtin"}`), admin, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	set, _, _ := s.comps().readDraft("etcd")
	task := "roles/etcd/tasks/test_health.yml"
	fixed := string(set[task]) + "\n- name: 修复后的检查\n  ansible.builtin.command: /bin/true\n  changed_when: false\n"
	body, _ := json.Marshal(map[string]any{"files": map[string]string{task: fixed}})
	if w := storeRequest(s, "PUT", "/api/components/etcd/draft", bytes.NewReader(body), admin, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := storeRequest(s, "POST", "/api/components/etcd/draft/publish", strings.NewReader(`{"note":"修复健康检查","force":true}`), admin, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = storeRequest(s, "GET", "/api/jobs/"+j.ID+"/sync", nil, admin, "")
	var got struct {
		Preview syncPreview `json:"preview"`
	}
	json.Unmarshal(w.Body.Bytes(), &got)
	if !got.Preview.Available || len(got.Preview.Files) != 1 || got.Preview.Files[0] != task || len(got.Preview.Recorded) != 1 {
		t.Fatalf("preview: %s", w.Body.String())
	}
	// every step that changes says why, and the handbook's phases are laid out for the person to read
	if len(got.Preview.Why) == 0 || len(got.Preview.Phases) == 0 {
		t.Fatalf("no reasons in the preview: %s", w.Body.String())
	}
	for _, ph := range got.Preview.Phases {
		for _, c := range ph.Changed {
			if c.Why == "" {
				t.Fatalf("a step is marked as changed without a reason: %+v", c)
			}
		}
	}
	w = storeRequest(s, "POST", "/api/jobs/"+j.ID+"/sync", nil, admin, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var sy jobSync
	json.Unmarshal(w.Body.Bytes(), &sy)
	if sy.N != 1 || sy.Update == "" {
		t.Fatal(w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.jobDir(j.ID), "output", sy.Update)); err != nil {
		t.Fatal("no update package", err)
	}
	if _, err := os.Stat(filepath.Join(s.jobDir(j.ID), "history", "sync-1", "plan.json")); err != nil {
		t.Fatal("the old handbook was not kept", err)
	}
	// the delivery's own project now carries the fix
	files, _ := s.projectFiles(j.ID)
	if !strings.Contains(string(files[task]), "修复后的检查") {
		t.Fatal("the delivery did not take the fix")
	}
	s.mu.Lock()
	doc := s.readProgress(j.ID)
	s.mu.Unlock()
	if _, ok := doc.Steps[health]; ok {
		t.Fatal("the changed step kept its old record as if it were the new one")
	}
	if old := doc.Superseded[health]; len(old) != 1 || old[0].Record.Note != "旧的健康检查在这台机器上失败" || old[0].Sync != 1 {
		t.Fatalf("the old version is not kept: %+v", doc.Superseded)
	}
	if doc.Steps[putget].Note != "写入读取正常" {
		t.Fatal("an untouched step lost its record")
	}
	// the report tells both
	r := httptest.NewRecorder()
	_ = r
	if w := storeRequest(s, "GET", "/api/clusters/etcd-sync/docs/delivery", nil, admin, ""); !strings.Contains(w.Body.String(), "旧版本（第 1 次按最新组件同步前") || !strings.Contains(w.Body.String(), "旧的健康检查在这台机器上失败") {
		t.Fatal("the report does not show the replaced version", w.Code)
	}
	// and now it is in step with the component
	if w := storeRequest(s, "GET", "/api/jobs/"+j.ID+"/sync", nil, admin, ""); !strings.Contains(w.Body.String(), `"available":false`) {
		t.Fatal("still offered after syncing", w.Body.String())
	}

	// a person may decide that a step marked for running again is not affected — never without a reason
	keep := func(reason string) int {
		b, _ := json.Marshal(map[string]any{"key": health, "sync": 1, "reason": reason})
		return storeRequest(s, "POST", "/api/jobs/"+j.ID+"/sync/keep", bytes.NewReader(b), admin, csrf).Code
	}
	if c := keep("  "); c != 409 {
		t.Fatal("a step was kept without a reason", c)
	}
	if c := keep("只加了一个检查任务，对这一步没有影响"); c != 200 {
		t.Fatal(c)
	}
	s.reevaluateSyncs() // starting again must not undo it
	s.mu.Lock()
	doc = s.readProgress(j.ID)
	cur := s.jobs[j.ID]
	s.mu.Unlock()
	if doc.Steps[health].Note != "旧的健康检查在这台机器上失败" || len(doc.Superseded[health]) != 0 {
		t.Fatalf("the old result did not come back: %+v", doc.Steps[health])
	}
	if n := cur.Syncs[0].Kept[health]; n.By != "admin" || n.Reason == "" {
		t.Fatalf("the decision is not recorded with who and why: %+v", cur.Syncs[0].Kept)
	}
	if c := keep("再确认一次"); c != 409 {
		t.Fatal("the same step was kept twice", c)
	}
}

// The assistant changes a file of the delivery's own automation: it is a proposal, accepting it gives the controller an
// update package, the file reads back as changed, and it stays when the delivery later takes a component fix.
func TestAssistantPatchesTheDeliveryAutomation(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	spec := `{"id":"etcd-patch","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`
	w := storeCreate(t, s, admin, csrf, spec, nil)
	s.wg.Wait()
	var j storeJob
	json.Unmarshal(w.Body.Bytes(), &j)
	s.mu.Lock()
	j = s.jobs[j.ID]
	s.mu.Unlock()
	task := "roles/etcd/tasks/test_health.yml"
	orig, ok := s.projectFile(j.ID, task)
	if !ok {
		t.Fatal("cannot read the task")
	}
	var made []string
	c := aiToolCtx{s: s, job: j, session: "s1", proposed: &made}
	first := strings.SplitN(string(orig), "\n", 2)[0]
	// refused: secrets, forbidden commands, a file that is not in the project's changeable parts, a wrong edit
	for name, args := range map[string]map[string]any{
		"secret path": {"path": "secrets/x.yml", "content": "a: 1", "reason": "x"},
		"outside":     {"path": "bootstrap/x.sh", "content": "echo", "reason": "x"},
		"forbidden":   {"path": "roles/etcd/tasks/zz.yml", "content": "- shell: mkfs.ext4 /dev/vdb\n", "reason": "x"},
		"bad yaml":    {"path": "roles/etcd/tasks/zz.yml", "content": "- a: [", "reason": "x"},
		"old twice":   {"path": task, "edits": []any{map[string]any{"old": "name:", "new": "nome:"}}, "reason": "x"},
	} {
		if out := c.proposeFile(args); len(made) != 0 || !strings.Contains(out, "没有保存") {
			t.Fatal(name, "was not refused:", out)
		}
	}
	out := c.proposeFile(map[string]any{"path": task, "edits": []any{map[string]any{"old": first, "new": first + "\n# 修过的"}}, "reason": "测试"})
	if len(made) != 1 {
		t.Fatal(out)
	}
	if w := storeRequest(s, "POST", "/api/jobs/"+j.ID+"/ai/proposals/"+made[0]+"/accept", nil, admin, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	now, _ := s.projectFile(j.ID, task)
	if !strings.Contains(string(now), "# 修过的") {
		t.Fatal("the patched file does not read back as patched")
	}
	s.mu.Lock()
	j = s.jobs[j.ID]
	s.mu.Unlock()
	if len(j.Syncs) != 1 || j.Syncs[0].Kind != "patch" || j.Syncs[0].Update == "" {
		t.Fatalf("%+v", j.Syncs)
	}
	if _, err := os.Stat(filepath.Join(s.jobDir(j.ID), "output", j.Syncs[0].Update)); err != nil {
		t.Fatal(err)
	}
	// after the patch the delivery is still in step with the component: nothing to sync, and the patch is not undone
	if w := storeRequest(s, "GET", "/api/jobs/"+j.ID+"/sync", nil, admin, ""); !strings.Contains(w.Body.String(), `"available":false`) {
		t.Fatal("a patch made the delivery look out of date", w.Body.String())
	}
}

// A step is marked as changed only when the change can be shown to reach it: a task guarded by one test's name does not
// reach another test, an unguarded task or a shared script/template reaches every step that uses it.
func TestImpactIsProvable(t *testing.T) {
	play := func(test string) []byte {
		return []byte("- name: x\n  hosts: controller\n  vars:\n    pg_test: " + test + "\n  tasks:\n    - ansible.builtin.import_role:\n        name: r\n        tasks_from: test\n")
	}
	const base = "- name: shared\n  script: helper.py\n"
	guarded := base + "- name: only front\n  command: run front_failover\n  when: pg_test == 'front-failover'\n"
	unguarded := base + "- name: for all\n  command: run everything\n"
	steps := []reportStep{
		{Key: "a/failover", Playbook: "playbooks/failover.yml"}, {Key: "a/front", Playbook: "playbooks/front-failover.yml"}, {Key: "a/switch", Playbook: "playbooks/switchover.yml"},
	}
	before := map[string]reportStep{}
	for _, st := range steps {
		before[stepIdentity(st)] = st
	}
	files := func(task string) map[string][]byte {
		return map[string][]byte{
			"roles/r/tasks/test.yml": []byte(task), "roles/r/files/helper.py": []byte("print(1)\n"),
			"playbooks/failover.yml": play("failover"), "playbooks/front-failover.yml": play("front-failover"), "playbooks/switchover.yml": play("switchover"),
		}
	}
	old := files(base)

	im := impactOf(steps, before, old, files(guarded), map[string]bool{"roles/r/tasks/test.yml": true})
	if !im["a/front"].Changed || im["a/failover"].Changed || im["a/switch"].Changed {
		t.Fatalf("a task guarded by one test reached others: %+v", im)
	}
	im = impactOf(steps, before, old, files(unguarded), map[string]bool{"roles/r/tasks/test.yml": true})
	for k, v := range im {
		if !v.Changed || v.Why == "" {
			t.Fatalf("an unguarded new task must reach %s with a reason: %+v", k, im)
		}
	}
	// a changed task file whose old text is unknown cannot be proven harmless
	im = impactOf(steps, before, nil, files(guarded), map[string]bool{"roles/r/tasks/test.yml": true})
	if !im["a/failover"].Changed {
		t.Fatal("unknown old text must count as affecting")
	}
	// a file the step uses that is not a task list is shared: no step can be proven free of it
	im = impactOf(steps, before, old, files(base), map[string]bool{"roles/r/files/helper.py": true})
	for k, v := range im {
		if !v.Changed {
			t.Fatalf("a shared file reaches every user, not %s: %+v", k, im)
		}
	}
	// a file nobody uses changes nothing
	im = impactOf(steps, before, old, files(base), map[string]bool{"roles/other/tasks/main.yml": true})
	for k, v := range im {
		if v.Changed {
			t.Fatalf("%s: %+v", k, im)
		}
	}
}

func TestWhenIsThreeValued(t *testing.T) {
	cond := func(src string, env map[string]string) tri {
		var n yaml.Node
		if err := yaml.Unmarshal([]byte("when: "+src), &n); err != nil {
			t.Fatal(err)
		}
		return evalWhen(n.Content[0].Content[1], env)
	}
	env := map[string]string{"pg_test": "failover"}
	if cond("pg_test == 'front-failover'", env) != no || cond("pg_test == 'failover'", env) != yes {
		t.Fatal("equality on a known variable")
	}
	if cond("unknown_var == 'x'", env) != unknown {
		t.Fatal("an unknown variable must stay undecided")
	}
	if cond("pg_test == 'failover' or unknown_var", env) != yes || cond("pg_test == 'x' and unknown_var", env) != no {
		t.Fatal("or/and with one decided side")
	}
}

func TestConfirmSyncApplied(t *testing.T) {
	if perm, ok := routePermFor("POST", "/api/jobs/abc/sync/confirm"); !ok || perm != "delivery.run" {
		t.Fatalf("expected delivery.run for sync/confirm, got %q ok=%v", perm, ok)
	}
	s, cfg := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	id := "0123456789abcdef0123456789abcdef"
	j := storeJob{
		ID:        id,
		Owner:     "admin",
		ClusterID: "sync-confirm-demo",
		State:     "succeeded",
		Syncs: []jobSync{
			{N: 1, At: "2026-11-19T00:00:00Z", By: "admin", Update: "update-1-sync-confirm-demo.tar.gz"},
			{N: 2, At: "2026-11-19T01:00:00Z", By: "admin", Kind: "patch", Reason: "fix task", Update: "update-2-sync-confirm-demo.tar.gz"},
		},
	}
	if err := s.persistJob(j); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.jobs[id] = j
	s.mu.Unlock()

	// Component sync allows "full" confirmation
	w := storeRequest(s, "POST", "/api/jobs/"+id+"/sync/confirm", strings.NewReader(`{"sync":1,"mode":"full"}`), admin, csrf)
	if w.Code != 200 {
		t.Fatalf("expected 200 for full sync confirm, got %d: %s", w.Code, w.Body.String())
	}
	var sy1 jobSync
	if err := json.Unmarshal(w.Body.Bytes(), &sy1); err != nil || sy1.AppliedAt == "" || sy1.AppliedBy != "admin" || sy1.AppliedMode != "full" {
		t.Fatalf("unexpected sync confirm response: %+v (%v)", sy1, err)
	}

	// AI patch rejects "full" mode because base packages aren't rebuilt
	w = storeRequest(s, "POST", "/api/jobs/"+id+"/sync/confirm", strings.NewReader(`{"sync":2,"mode":"full"}`), admin, csrf)
	if w.Code != 409 {
		t.Fatalf("expected 409 for full mode on AI patch, got %d: %s", w.Code, w.Body.String())
	}

	// AI patch accepts "patch" confirmation and persists
	w = storeRequest(s, "POST", "/api/jobs/"+id+"/sync/confirm", strings.NewReader(`{"sync":2,"mode":"patch"}`), admin, csrf)
	if w.Code != 200 {
		t.Fatalf("expected 200 for patch confirm, got %d: %s", w.Code, w.Body.String())
	}
	var sy2 jobSync
	if err := json.Unmarshal(w.Body.Bytes(), &sy2); err != nil || sy2.AppliedAt == "" || sy2.AppliedMode != "patch" {
		t.Fatalf("unexpected patch confirm response: %+v (%v)", sy2, err)
	}

	// Persists across server restart and writes progress timeline events
	s2, err := newStoreServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s2.mu.Lock()
	reloaded := s2.jobs[id]
	s2.mu.Unlock()
	if len(reloaded.Syncs) != 2 || reloaded.Syncs[0].AppliedMode != "full" || reloaded.Syncs[1].AppliedMode != "patch" {
		t.Fatalf("sync confirmation did not persist across restart: %+v", reloaded.Syncs)
	}
	doc := s2.readProgress(id)
	if len(doc.Events) != 2 || doc.Events[0].State != "sync" || doc.Events[1].Key != "sync-confirm-2" {
		t.Fatalf("unexpected progress events after confirm: %+v", doc.Events)
	}

	// "verified" mode works for both component sync and AI patch
	admin2, csrf2 := storeLogin(t, s2, "admin")
	w = storeRequest(s2, "POST", "/api/jobs/"+id+"/sync/confirm", strings.NewReader(`{"sync":2,"mode":"verified"}`), admin2, csrf2)
	if w.Code != 200 {
		t.Fatalf("expected 200 for verified confirm, got %d: %s", w.Code, w.Body.String())
	}
	var sy3 jobSync
	if err := json.Unmarshal(w.Body.Bytes(), &sy3); err != nil || sy3.AppliedMode != "verified" {
		t.Fatalf("unexpected verified confirm response: %+v (%v)", sy3, err)
	}
}

func TestSyncVerifyCommandAndOfflineDocInjection(t *testing.T) {
	plan := &syncPlanMeta{
		Controller: "pg-1",
		ProjectDir: "/root/middleware-automation/projects/ecs-pg-manual",
		UploadDir:  "/tmp/mw-upload",
	}
	sy := jobSync{
		N:         1,
		Update:    "update-1-ecs-pg-manual.tar.gz",
		UpdateSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		FileHashes: map[string]string{
			"ansible.cfg": "1111111111111111111111111111111111111111111111111111111111111111",
		},
		Remove: []string{"roles/old/legacy.yml"},
	}
	cmd := buildSyncVerifyCommand(plan, sy)
	for _, want := range []string{
		"PROJ='/root/middleware-automation/projects/ecs-pg-manual'",
		"UPD='/tmp/mw-upload/update-1-ecs-pg-manual.tar.gz'",
		"sha256sum -c --status <<'MW_SYNC_EOF'",
		"1111111111111111111111111111111111111111111111111111111111111111  ansible.cfg",
		"[ ! -e 'roles/old/legacy.yml' ]",
		"rm -f 'roles/old/legacy.yml'",
		"tar -xzf \"$UPD\" -C '/root'",
		"无需重复覆盖",
		"false",
	} {
		if !strings.Contains(cmd, want) {
			t.Fatalf("verify command missing %q:\n%s", want, cmd)
		}
	}
	if strings.Contains(cmd, "exit 1") {
		t.Fatalf("verify command must not call exit 1 (would close interactive SSH session):\n%s", cmd)
	}
	sy.VerifyCmd = cmd

	md := "# 部署步骤\n\n导语。\n\n## 1. 离线安装 Ansible\n\n步骤正文。\n"
	out := injectSyncDeploySection(md, plan, sy)
	idx0 := strings.Index(out, "## 0. 核对并应用第 1 次同步更新（必做）")
	idx1 := strings.Index(out, "## 1. 离线安装 Ansible")
	if idx0 < 0 || idx1 < 0 || idx0 >= idx1 {
		t.Fatalf("expected sync section before step 1, got:\n%s", out)
	}
	if !strings.Contains(out, cmd) {
		t.Fatalf("injected doc missing verify command:\n%s", out)
	}
}

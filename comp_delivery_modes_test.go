package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPublishModeSelectionIsEnforced(t *testing.T) {
	s, _ := testStore(t)
	w := &wb{t: t, s: s}
	base := "/api/components/redis/draft"
	w.ok("POST", base, map[string]any{"from": "live"})
	rev := s.comps().liveRev("redis")
	code, _ := w.do("POST", base+"/publish", map[string]any{"note": "invalid auto publish", "delivery_modes": []string{"automatic"}})
	if code != 422 || s.comps().liveRev("redis") != rev {
		t.Fatal("invalid auto capability published", code)
	}
	if !s.comps().hasDraft("redis") {
		t.Fatal("rejected draft removed")
	}
	code, _ = w.do("POST", base+"/publish", map[string]any{"note": "empty capabilities", "delivery_modes": []string{}})
	if code != 400 {
		t.Fatal(code)
	}
	w.ok("POST", base+"/publish", map[string]any{"note": "explicit offline capability", "delivery_modes": []string{"offline"}})
	set, _, _ := s.comps().liveSet("redis")
	if !strings.Contains(string(set["component.yaml"]), "delivery_modes:") {
		t.Fatal("capability not in revision")
	}
}
func TestSummaryReportFilteringPreservesDetailExport(t *testing.T) {
	doc := &clusterDoc{Blocks: []docBlock{{Kind: "p", Text: "summary"}, {Kind: "code", Text: "evidence", Detail: true, Variant: variantResult}}}
	summary := parseExportOptions(map[string][]string{"detail": {"0"}}).filtered(doc)
	if len(summary.Blocks) != 1 {
		t.Fatal("summary leaked raw evidence")
	}
	detail := parseExportOptions(map[string][]string{"detail": {"1"}}).filtered(doc)
	if len(detail.Blocks) != 2 {
		t.Fatal("evidence removed from detailed report")
	}
}

func TestExecutionReportIncludesVerifiableEvidence(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	w := storeCreate(t, s, admin, csrf, `{"id":"execution-report","hosts":[{"name":"n1","ip":"10.0.1.11"}],"instances":[{"id":"etcd","component":"etcd","placement":{"member":["n1"]}}]}`, nil)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	s.wg.Wait()
	var j storeJob
	json.Unmarshal(w.Body.Bytes(), &j)
	j = s.jobs[j.ID]
	var choice executionChoice
	for _, c := range s.executionChoices(j.ID) {
		if c.Available {
			choice = c
			break
		}
	}
	if choice.Key == "" {
		t.Fatal("no executable choice")
	}
	playbook := ""
	for _, tab := range s.runbookSteps(j.ID) {
		for _, st := range tab.Steps {
			if st.Key == choice.Key {
				playbook = st.Playbook
			}
		}
	}
	if playbook == "" {
		t.Fatal("executable step missing playbook")
	}
	_, d, n, run := executionFixture(t)
	run.Job, run.Cluster, run.Revision = j.ID, j.ClusterID, s.executionRevision(j.ID)
	run.Steps[0].Key, run.Steps[0].Playbook, run.Steps[0].Title = choice.Key, playbook, choice.Title
	run.Steps[0].Hosts = []string{"n1"}
	d.Runs[run.ID] = run
	if err := s.applyExecutionEvent(&d, n, stepEvent(run, 1, "started", "")); err != nil {
		t.Fatal(err)
	}
	if err := s.applyExecutionEvent(&d, n, stepEvent(run, 2, "log", "verification-evidence-fixture\n")); err != nil {
		t.Fatal(err)
	}
	output := "playbook " + playbook + "\nstarted 2026-11-11 10:00:00 +0000\nRECAP\n  n1 ok=2 changed=0 unreachable=0 failed=0 skipped=0\nfinished 2026-11-11 10:00:01 +0000\nSTEP_RESULT {\"schema\":\"mwstep-result/v1\",\"step\":\"" + playbook + "\",\"status\":\"passed\"}\n"
	ev := stepEvent(run, 3, "finished", output)
	code := 0
	ev.ExitCode = &code
	if err := s.applyExecutionEvent(&d, n, ev); err != nil {
		t.Fatal(err)
	}
	if err := s.saveExecutions(d); err != nil {
		t.Fatal(err)
	}
	var b docBuilder
	s.executionSummary(&b, 1, j, s.readProgress(j.ID))
	doc := &clusterDoc{Blocks: b.blocks}
	detail := parseExportOptions(map[string][]string{"detail": {"1"}, "results": {"1"}}).filtered(doc)
	raw, _ := json.Marshal(detail)
	for _, want := range []string{"执行节点验证通过 1 步", "进程退出码：0", "verification-evidence-fixture", "/executions/" + run.ID + "/logs/" + run.Steps[0].ID} {
		if !strings.Contains(string(raw), want) {
			t.Fatal("report missing evidence", want, string(raw))
		}
	}
	summary := parseExportOptions(map[string][]string{"detail": {"0"}, "results": {"1"}}).filtered(doc)
	raw, _ = json.Marshal(summary)
	if strings.Contains(string(raw), "verification-evidence-fixture") {
		t.Fatal("summary includes raw logs")
	}
}

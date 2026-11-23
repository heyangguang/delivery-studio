package main

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"middleware-deployer/mwpack"
)

func createDeliveryWithPurpose(t *testing.T, s *storeServer, cookie *http.Cookie, csrf, depJSON, purpose string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	payload := fmtRequest(depJSON, purpose)
	if err := mw.WriteField("request", payload); err != nil {
		t.Fatal(err)
	}
	mw.Close()
	r := httptest.NewRequest("POST", s.cfg.PublicURL+"/api/jobs", &body)
	r.Header.Set("Origin", s.cfg.PublicURL)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r.Header.Set("X-CSRF-Token", csrf)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func fmtRequest(depJSON, purpose string) string {
	if purpose == "" {
		return `{"deployment":` + depJSON + `}`
	}
	return `{"deployment":` + depJSON + `,"purpose":"` + purpose + `"}`
}

func TestComponentLifecycleTwoModeTestingAndDecoupledPublish(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, ucsrf := storeLogin(t, s, "alice")

	// 1. Formal delivery on unpublished OS (el9-amd64 for nginx 1.26) MUST remain blocked on /api/resolve and /api/jobs.
	el9Spec := `{"id":"nginx-el9-formal","platform":"el9-amd64","hosts":[{"name":"n1","ip":"10.0.8.11"}],"instances":[{"id":"lb","component":"nginx","version":"1.26","placement":{"balancer":["n1"]}}]}`
	w := storeRequest(s, "POST", "/api/resolve", strings.NewReader(el9Spec), alice, ucsrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"ok":false`) || !strings.Contains(w.Body.String(), "尚未发布") {
		t.Fatalf("expected formal /api/resolve to reject unpublished el9-amd64, got %d: %s", w.Code, w.Body.String())
	}
	w = createDeliveryWithPurpose(t, s, alice, ucsrf, el9Spec, "")
	if w.Code != 400 || !strings.Contains(w.Body.String(), "尚未发布") {
		t.Fatalf("expected formal POST /api/jobs to reject unpublished el9-amd64, got %d: %s", w.Code, w.Body.String())
	}

	// 2. Non-maintainer (alice) CANNOT use the verification test channel.
	w = storeRequest(s, "POST", "/api/resolve?purpose=verification", strings.NewReader(el9Spec), alice, ucsrf)
	if w.Code != 403 {
		t.Fatalf("operator must not access verification resolve channel, got %d", w.Code)
	}
	w = createDeliveryWithPurpose(t, s, alice, ucsrf, el9Spec, "verification")
	if w.Code != 403 {
		t.Fatalf("operator must not create verification delivery, got %d", w.Code)
	}

	// 3. Import an unpublished (draft) component:
	//    - Formal delivery is blocked;
	//    - Maintainer CAN immediately launch a test delivery (no redundant draft->verifying dance!).
	draftManifest := strings.Replace(memcachedManifest, "status: published\n    verified_platforms: [ubuntu-24.04-amd64]", "status: draft", 1)
	pack := packTarGz(t, map[string]string{
		"memcached/component.yaml":              draftManifest,
		"memcached/templates/memcached.conf.j2": "-p {{ mw.params.port }}\n",
	})
	if w = importPack(t, s, admin, acsrf, "memcached.tar.gz", pack); w.Code != 200 {
		t.Fatalf("import draft component: %d %s", w.Code, w.Body.String())
	}
	fakeLibrary(t, s.plat.lib.Dir, mwpack.DefaultPlatform, []mwpack.PackageRequest{{Name: "memcached", Version: "1.6.24-1ubuntu3"}})

	mcSpec := `{"id":"mc-v1","platform":"ubuntu-24.04-amd64","hosts":[{"name":"mc-1","ip":"10.0.9.11"}],"instances":[{"id":"mc","component":"memcached","version":"1.6","placement":{"node":["mc-1"]}}]}`
	w = createDeliveryWithPurpose(t, s, alice, ucsrf, mcSpec, "")
	if w.Code != 400 || !strings.Contains(w.Body.String(), "尚未发布") {
		t.Fatalf("unpublished component must be blocked for formal delivery, got %d: %s", w.Code, w.Body.String())
	}

	// 4. Publishing with test_mode="automatic" BEFORE any automated test report exists MUST be rejected clearly.
	w = storeRequest(s, "POST", "/api/components/memcached/versions/1.6/status",
		strings.NewReader(`{"status":"published","platform":"ubuntu-24.04-amd64","test_mode":"automatic"}`), admin, acsrf)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "自动化测试报告") {
		t.Fatalf("expected 400 when automatic mode has no captured report, got %d: %s", w.Code, w.Body.String())
	}

	// 5. Mode B (Manual test): admin can publish directly with test_mode="manual" — ZERO delivery required, no fake report!
	w = storeRequest(s, "POST", "/api/components/memcached/versions/1.6/status",
		strings.NewReader(`{"status":"published","platform":"ubuntu-24.04-amd64","test_mode":"manual","note":"现场离线机手工测通"}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("manual publish failed: %d %s", w.Code, w.Body.String())
	}
	vw := storeRequest(s, "GET", "/api/components/memcached/verifications", nil, alice, "")
	if vw.Code != 200 {
		t.Fatalf("get verifications failed: %d %s", vw.Code, vw.Body.String())
	}
	var vResp struct {
		Records    []compVerification      `json:"records"`
		Candidates []verificationCandidate `json:"candidates"`
	}
	_ = json.Unmarshal(vw.Body.Bytes(), &vResp)
	if len(vResp.Candidates) != 0 {
		t.Fatalf("expected zero candidate delivery scanning, got %d", len(vResp.Candidates))
	}
	if len(vResp.Records) != 1 || vResp.Records[0].TestMode != "manual" || vResp.Records[0].HasReport || len(vResp.Records[0].Steps) != 0 || vResp.Records[0].Note != "现场离线机手工测通" {
		t.Fatalf("unexpected manual verification record: %+v", vResp.Records)
	}

	// Now alice CAN create a formal delivery on ubuntu-24.04-amd64!
	formalSpec := `{"id":"mc-prod","platform":"ubuntu-24.04-amd64","hosts":[{"name":"mc-1","ip":"10.0.9.21"}],"instances":[{"id":"mc","component":"memcached","version":"1.6","placement":{"node":["mc-1"]}}]}`
	w = createDeliveryWithPurpose(t, s, alice, ucsrf, formalSpec, "")
	if w.Code != 202 {
		t.Fatalf("formal delivery should succeed after manual publish, got %d: %s", w.Code, w.Body.String())
	}
	s.wg.Wait()

	// 6. Unpublish OS returns version cleanly to unpublished (draft) and blocks formal delivery again.
	w = storeRequest(s, "POST", "/api/components/memcached/versions/1.6/status",
		strings.NewReader(`{"revoke_platform":"ubuntu-24.04-amd64"}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("revoke OS failed: %d %s", w.Code, w.Body.String())
	}

	// 7. Mode A (Automated test): maintainer launches test delivery directly on unpublished component!
	w = createDeliveryWithPurpose(t, s, admin, acsrf, mcSpec, "verification")
	if w.Code != 202 {
		t.Fatalf("maintainer test delivery on unpublished component failed: %d %s", w.Code, w.Body.String())
	}
	s.wg.Wait()
	var testJob storeJob
	_ = json.Unmarshal(w.Body.Bytes(), &testJob)

	// Simulate an automated execution run completing all required steps and capturing the decoupled report.
	tabs := s.runbookSteps(testJob.ID)
	t0 := time.Now().Add(-30 * time.Second)
	execSteps := []executionStep{}
	for _, tab := range tabs {
		for _, st := range tab.Steps {
			if (strings.HasPrefix(st.Key, "deploy/") || strings.HasPrefix(st.Key, "tests/") || strings.HasPrefix(st.Key, "endpoint/")) && st.Key != "deploy/deploy-bootstrap" {
				t1 := t0.Add(5 * time.Second)
				execSteps = append(execSteps, executionStep{
					ID:       "st-" + st.Key,
					Key:      st.Key,
					Title:    st.Title,
					State:    "succeeded",
					Started:  t0.UTC().Format(time.RFC3339Nano),
					Finished: t1.UTC().Format(time.RFC3339Nano),
				})
				t0 = t1
				_ = storeRequest(s, "PUT", "/api/jobs/"+testJob.ID+"/progress",
					strings.NewReader(`{"key":"`+st.Key+`","state":"done"}`), admin, acsrf)
			}
		}
	}
	execDB := executionDB{
		Nodes:        map[string]executionNode{},
		Preparations: map[string]executionPreparation{},
		Runs: map[string]executionRun{
			"run-auto-1": {
				ID:           "run-auto-1",
				Job:          testJob.ID,
				ExecutorName: "auto-runner-01",
				State:        "completed",
				Created:      time.Now().UTC().Format(time.RFC3339Nano),
				Steps:        execSteps,
			},
		},
	}
	s.captureAutoVerificationReports(testJob.ID, execDB)

	// Delete the temporary test delivery BEFORE publishing — the self-contained automated report MUST remain intact!
	if code, msg := s.deleteJobData(testJob.ID); code != 0 {
		t.Fatalf("delete temp test delivery failed: %d %s", code, msg)
	}

	// Publish with test_mode="automatic" (no job_id!) using the decoupled automated report!
	w = storeRequest(s, "POST", "/api/components/memcached/versions/1.6/status",
		strings.NewReader(`{"status":"published","platform":"ubuntu-24.04-amd64","test_mode":"automatic","note":"自动实测通过"}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("automatic publish after temp delivery deletion failed: %d %s", w.Code, w.Body.String())
	}

	vw2 := storeRequest(s, "GET", "/api/components/memcached/verifications", nil, alice, "")
	var vResp2 struct {
		Records []compVerification `json:"records"`
	}
	_ = json.Unmarshal(vw2.Body.Bytes(), &vResp2)
	if len(vResp2.Records) != 1 || vResp2.Records[0].TestMode != "automatic" || !vResp2.Records[0].HasReport || len(vResp2.Records[0].Steps) == 0 || vResp2.Records[0].PassedSteps != len(execSteps) {
		t.Fatalf("expected decoupled automatic test report with step breakdown, got: %+v", vResp2.Records)
	}
}

func TestMigrateComponentLifecycleNormalizesOldSnapshots(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	spec := `{"id":"verify-etcd-mig","platform":"ubuntu-24.04-amd64","hosts":[{"name":"e1","ip":"10.0.7.11"}],"instances":[{"id":"etcd","component":"etcd","version":"3.5","placement":{"member":["e1"]}}]}`
	w := createDeliveryWithPurpose(t, s, admin, acsrf, spec, "")
	if w.Code != 202 {
		t.Fatalf("create etcd job: %d %s", w.Code, w.Body.String())
	}
	s.wg.Wait()
	var job storeJob
	_ = json.Unmarshal(w.Body.Bytes(), &job)

	planPath := filepath.Join(s.jobDir(job.ID), "output", "plan.json")
	raw, _ := os.ReadFile(planPath)
	mutated := strings.Replace(string(raw), `"status": "published"`, `"status": "verifying"`, 1)
	if err := os.WriteFile(planPath, []byte(mutated), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tab := range s.runbookSteps(job.ID) {
		for _, st := range tab.Steps {
			if strings.HasPrefix(st.Key, "deploy/") || strings.HasPrefix(st.Key, "tests/") || strings.HasPrefix(st.Key, "endpoint/") {
				pw := storeRequest(s, "PUT", "/api/jobs/"+job.ID+"/progress", strings.NewReader(`{"key":"`+st.Key+`","state":"done"}`), admin, acsrf)
				if pw.Code != 200 {
					t.Fatalf("mark step %s done failed: %d %s", st.Key, pw.Code, pw.Body.String())
				}
			}
		}
	}

	s.migrateComponentLifecycle()

	after, _ := os.ReadFile(planPath)
	if strings.Contains(string(after), `"status": "verifying"`) {
		t.Fatalf("migration did not normalize old plan.json status to published: %s", string(after))
	}
	recs := s.loadCompVerifications("etcd")
	if len(recs) != 1 || recs[0].Platform != "ubuntu-24.04-amd64" {
		t.Fatalf("expected migrated verification record for etcd 3.5, got %+v", recs)
	}
}

package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// An answer belongs to its conversation: when the page leaves (another conversation, a closed window) the answer is
// still written and kept, the question is never lost, and only "stop" ends it.
func TestAIAnswerSurvivesThePageLeaving(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	w := storeCreate(t, s, alice, csrf, singleNodeSpec, nil)
	s.wg.Wait()
	var job storeJob
	json.Unmarshal(w.Body.Bytes(), &job)

	release := make(chan struct{})
	var once sync.Once
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		if strings.Contains(string(b), "整理成一份记录") {
			io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"好的，记录如下：{\\\"symptom\\\":\\\"锁冲突\\\",\\\"cause\\\":\\\"apt 持有锁\\\",\\\"fix\\\":\\\"等待\\\"} 以上\"}}]}\n\ndata: [DONE]\n\n")
			return
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"慢慢写完的回答\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer slow.Close()
	defer once.Do(func() { close(release) })
	enableAI(t, s, slow.URL, 0)
	st := s.aiLoad()
	st.Features = map[string]aiFeature{"review": {Enabled: true}, "troubleshoot": {Enabled: true}}
	_ = s.aiSave(st)

	session := func(key string) string {
		return storeRequest(s, "GET", "/api/jobs/"+job.ID+"/ai/session?key="+key, nil, alice, "").Body.String()
	}
	for _, key := range []string{"review", "step:deploy/2"} {
		ctx, leave := context.WithCancel(context.Background())
		r := httptest.NewRequest("POST", s.cfg.PublicURL+"/api/jobs/"+job.ID+"/ai/chat", strings.NewReader(`{"key":"`+key+`","message":"问题一"}`)).WithContext(ctx)
		r.Header.Set("Origin", s.cfg.PublicURL)
		r.Header.Set("X-CSRF-Token", csrf)
		r.AddCookie(alice)
		done := make(chan struct{})
		go func() {
			s.ServeHTTP(httptest.NewRecorder(), r)
			close(done)
		}()
		deadline := time.Now().Add(5 * time.Second)
		for !strings.Contains(session(key), `"running":true`) {
			if time.Now().After(deadline) {
				t.Fatal(key, "the answer never started", session(key))
			}
			time.Sleep(20 * time.Millisecond)
		}
		if !strings.Contains(session(key), "问题一") {
			t.Fatal(key, "the question was not kept at once")
		}
		// a second question in the same conversation waits for the first
		if w := storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/chat", strings.NewReader(`{"key":"`+key+`","message":"又问"}`), alice, csrf); w.Code != 409 {
			t.Fatal(key, "two answers at once", w.Code)
		}
		leave() // the page goes elsewhere
		time.Sleep(150 * time.Millisecond)
		if !strings.Contains(session(key), `"running":true`) {
			t.Fatal(key, "the answer stopped when the page left")
		}
		if key == "review" {
			once.Do(func() { close(release) })
			deadline = time.Now().Add(5 * time.Second)
			for strings.Contains(session(key), `"running":true`) {
				if time.Now().After(deadline) {
					t.Fatal("the answer never finished")
				}
				time.Sleep(20 * time.Millisecond)
			}
			if got := session(key); !strings.Contains(got, "慢慢写完的回答") || !strings.Contains(got, "问题一") {
				t.Fatal("the finished answer was not kept", got)
			}
			// the next conversation uses a model that waits again
			release = make(chan struct{})
			once = sync.Once{}
			continue
		}
		// stop ends it
		if w := storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/stop", strings.NewReader(`{"key":"`+key+`"}`), alice, csrf); w.Code != 200 {
			t.Fatal(w.Code)
		}
		deadline = time.Now().Add(5 * time.Second)
		for strings.Contains(session(key), `"running":true`) {
			if time.Now().After(deadline) {
				t.Fatal("stop did not end the answer")
			}
			time.Sleep(20 * time.Millisecond)
		}
		if !strings.Contains(session(key), "问题一") {
			t.Fatal("stopping lost the question")
		}
		<-done
	}
	// the write-up copes with a model that wraps its JSON in words
	w = storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/resolve", strings.NewReader(`{"key":"review"}`), alice, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "apt 持有锁") {
		t.Fatal("resolve", w.Code, w.Body.String())
	}
}

// Solved: the write-up is a draft first. Nothing is written until the person confirms it, and confirming also marks the
// step as done after a problem was solved.
func TestAIWriteUpIsADraftFirst(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	w := storeCreate(t, s, alice, csrf, singleNodeSpec, nil)
	s.wg.Wait()
	var job storeJob
	json.Unmarshal(w.Body.Bytes(), &job)
	srv, _ := fakeModel(t, "先等锁释放。", `{"symptom":"锁冲突","cause":"apt 持有锁","fix":"等待后重跑"}`)
	enableAI(t, s, srv.URL, 0)
	st := s.aiLoad()
	st.Features = map[string]aiFeature{"review": {Enabled: true}, "troubleshoot": {Enabled: true}}
	_ = s.aiSave(st)
	key := "step:deploy/deploy-install"
	if w := storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/chat", strings.NewReader(`{"key":"`+key+`","message":"装不上"}`), alice, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/resolve", strings.NewReader(`{"key":"`+key+`","draft":true}`), alice, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "apt 持有锁") {
		t.Fatal(w.Code, w.Body.String())
	}
	if p := storeRequest(s, "GET", "/api/jobs/"+job.ID+"/progress", nil, alice, "").Body.String(); strings.Contains(p, "apt 持有锁") {
		t.Fatal("a draft was written into the record")
	}
	body := `{"key":"` + key + `","mark_step":true,"to_kb":true,"report":{"symptom":"锁冲突","cause":"apt 持有锁","fix":"` + "```\\nkill -TERM 1\\n```" + `","followups":["给脚本加锁等待"]}}`
	if w = storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/resolve", strings.NewReader(body), alice, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	p := storeRequest(s, "GET", "/api/jobs/"+job.ID+"/progress", nil, alice, "").Body.String()
	if !strings.Contains(p, "apt 持有锁") || !strings.Contains(p, `"state":"resolved"`) {
		t.Fatal("the confirmed record or the step state is missing", p)
	}
	// kept in the writer's own knowledge base, private to them, and the record points at it
	if !strings.Contains(p, `"kb_id"`) {
		t.Fatal("the record does not point at the knowledge-base copy", p)
	}
	if kb := storeRequest(s, "GET", "/api/me/kb/search?q=apt", nil, alice, "").Body.String(); !strings.Contains(kb, "apt 持有锁") {
		t.Fatal("the write-up is not in the personal knowledge base", kb)
	}
	if kb := storeRequest(s, "GET", "/api/kb", nil, alice, "").Body.String(); strings.Contains(kb, "apt 持有锁") {
		t.Fatal("the write-up went to the team base without review")
	}
	// and it is in the delivery report
	r := storeRequest(s, "GET", "/api/clusters/"+job.ClusterID+"/docs/delivery", nil, alice, "")
	if !strings.Contains(r.Body.String(), "apt 持有锁") || !strings.Contains(r.Body.String(), "kill -TERM 1") {
		t.Fatal("the report does not carry the write-up", r.Body.String()[:200])
	}
}

// Whoever starts a new conversation about the whole delivery gets a new one; the old one stays as it was.
func TestAIGeneralConversationsAreSeparate(t *testing.T) {
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	w := storeCreate(t, s, alice, csrf, singleNodeSpec, nil)
	s.wg.Wait()
	var job storeJob
	json.Unmarshal(w.Body.Bytes(), &job)
	srv, _ := fakeModel(t, "回答甲", "回答乙")
	enableAI(t, s, srv.URL, 0)
	st := s.aiLoad()
	st.Features = map[string]aiFeature{"review": {Enabled: true}, "troubleshoot": {Enabled: true}}
	_ = s.aiSave(st)
	ask := func(key, msg string) {
		if w := storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/chat", strings.NewReader(`{"key":"`+key+`","message":"`+msg+`"}`), alice, csrf); w.Code != 200 {
			t.Fatal(key, w.Code, w.Body.String())
		}
	}
	ask("review", "第一个问题")
	ask("review:ab12cd34", "另起一段的问题")
	one := storeRequest(s, "GET", "/api/jobs/"+job.ID+"/ai/session?key=review", nil, alice, "").Body.String()
	two := storeRequest(s, "GET", "/api/jobs/"+job.ID+"/ai/session?key=review:ab12cd34", nil, alice, "").Body.String()
	if !strings.Contains(one, "第一个问题") || strings.Contains(one, "另起一段") || !strings.Contains(two, "另起一段的问题") || strings.Contains(two, "第一个问题") {
		t.Fatal("the conversations are mixed up", one, two)
	}
	if !strings.Contains(two, `"title":"另起一段的问题"`) {
		t.Fatal("a new conversation is not named after its first question", two)
	}
	if w := storeRequest(s, "POST", "/api/jobs/"+job.ID+"/ai/chat", strings.NewReader(`{"key":"review:../x","message":"x"}`), alice, csrf); w.Code != 400 {
		t.Fatal("an odd key was accepted", w.Code)
	}
}

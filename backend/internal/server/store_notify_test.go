package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNotificationChannels(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, csrf := storeLogin(t, s, "alice")
	var mu sync.Mutex
	var got []map[string]any
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		json.Unmarshal(b, &m)
		mu.Lock()
		got = append(got, m)
		mu.Unlock()
		w.Write([]byte(`{"errcode":0}`))
	}))
	defer receiver.Close()

	// only an administrator manages channels
	if w := storeRequest(s, "GET", "/api/settings/channels", nil, alice, ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := storeRequest(s, "POST", "/api/settings/channels", strings.NewReader(`{"name":"x","kind":"wecom","url":"ftp://bad","enabled":true}`), admin, acsrf); w.Code != 400 {
		t.Fatal("a non-http address was accepted", w.Code)
	}
	w := storeRequest(s, "POST", "/api/settings/channels", strings.NewReader(`{"name":"运维群","kind":"wecom","url":"`+receiver.URL+`","enabled":true}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var ch notifyChannel
	json.Unmarshal(w.Body.Bytes(), &ch)
	// a test message arrives in the robot's format and is logged
	if w = storeRequest(s, "POST", "/api/settings/channels/"+ch.ID+"/test", nil, admin, acsrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	mu.Lock()
	if len(got) != 1 || got[0]["msgtype"] != "markdown" {
		t.Fatalf("%+v", got)
	}
	mu.Unlock()
	if l := s.notifyLog(); len(l) != 1 || !l[0].OK || l[0].Event != "test" {
		t.Fatalf("%+v", l)
	}
	_ = csrf
	_ = time.Second
}

package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestStoreExecutionNodeDelete(t *testing.T) {
	s, _ := testStore(t)
	admin, csrf := storeLogin(t, s, "admin")
	req := func(method string, body any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		return storeRequest(s, method, "/api/settings/execution-nodes", bytes.NewReader(raw), admin, csrf)
	}
	w := req("POST", map[string]any{"name": "to delete", "kind": "independent", "controller_ip": "10.0.1.21"})
	var reg struct {
		Node  executionNode
		Token string
	}
	_ = json.Unmarshal(w.Body.Bytes(), &reg)
	if w.Code != 201 || reg.Node.ID == "" {
		t.Fatal(w.Code, w.Body.String())
	}
	// a node with an unfinished run is kept
	d, err := s.readExecutions()
	if err != nil {
		t.Fatal(err)
	}
	d.Runs["r1"] = executionRun{ID: "r1", Node: reg.Node.ID, Cluster: "c1", State: "paused"}
	if err = s.saveExecutions(d); err != nil {
		t.Fatal(err)
	}
	if w = req("DELETE", map[string]any{"id": reg.Node.ID}); w.Code != 409 {
		t.Fatal("node with unfinished run deleted", w.Code, w.Body.String())
	}
	d, _ = s.readExecutions()
	run := d.Runs["r1"]
	run.State = "completed"
	d.Runs["r1"] = run
	_ = s.saveExecutions(d)
	if w = req("DELETE", map[string]any{"id": reg.Node.ID}); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	d, _ = s.readExecutions()
	if _, ok := d.Nodes[reg.Node.ID]; ok {
		t.Fatal("node still stored")
	}
	if _, ok := d.Runs["r1"]; !ok {
		t.Fatal("finished run history removed")
	}
	// the deleted node's credential no longer authenticates
	ar := httptest.NewRequest("POST", "/api/execution-agent/poll", bytes.NewReader([]byte(`{"protocol":2,"heartbeat":true}`)))
	ar.Header.Set("Authorization", "Bearer "+reg.Token)
	aw := httptest.NewRecorder()
	s.handleExecutionAgent(aw, ar)
	if aw.Code == 200 {
		t.Fatal("deleted node can still poll")
	}
	if w = req("DELETE", map[string]any{"id": reg.Node.ID}); w.Code != 404 {
		t.Fatal(w.Code)
	}
}

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGranularAIFeatureSwitchesAndIAMPermissions(t *testing.T) {
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, csrf := storeLogin(t, s, "alice")

	// Start a dummy OpenAI-compatible server so a model provider can be enabled.
	mockAI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}`))
	}))
	defer mockAI.Close()

	// Add a provider and enable the AI master switch.
	w := storeRequest(s, "POST", "/api/settings/ai/providers", strings.NewReader(`{
		"name":"LocalMock","preset":"custom","url":"`+mockAI.URL+`","private":true,"enabled":true,
		"models":[{"id":"mock-1","enabled":true,"tools":"yes"}]
	}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("add provider: %d %s", w.Code, w.Body.String())
	}
	w = storeRequest(s, "POST", "/api/ai/toggle", strings.NewReader(`{"enabled":true}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("toggle master on: %d %s", w.Code, w.Body.String())
	}

	readStatus := func(ck *http.Cookie) aiStatus {
		w := storeRequest(s, "GET", "/api/ai/status", nil, ck, "")
		if w.Code != 200 {
			t.Fatalf("GET /api/ai/status: %d %s", w.Code, w.Body.String())
		}
		var st aiStatus
		if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil {
			t.Fatal(err)
		}
		return st
	}

	// 1. Admin (sysadmin) has all 11 AI features enabled.
	stAdmin := readStatus(admin)
	if !stAdmin.Enabled || !stAdmin.Features["component"] || !stAdmin.Features["assistant"] || !stAdmin.Features["kb"] || !stAdmin.Features["skills"] || !stAdmin.Features["mcp"] || !stAdmin.Features["library"] {
		t.Fatalf("expected sysadmin to have all AI features on, got %+v", stAdmin)
	}

	// 2. Alice (builtin engineer) has assistant & troubleshoot & change_rehearsal, but NOT component AI.
	stAlice := readStatus(alice)
	if !stAlice.Enabled || !stAlice.Features["assistant"] || !stAlice.Features["troubleshoot"] || !stAlice.Features["change_rehearsal"] {
		t.Fatalf("expected engineer to have delivery AI features on, got %+v", stAlice)
	}
	if stAlice.Features["component"] {
		t.Fatalf("expected builtin engineer NOT to have component AI perm, got %+v", stAlice.Features)
	}

	// 3. Platform-level switch: admin turns OFF "component" and "kb" while keeping master ON.
	w = storeRequest(s, "PUT", "/api/settings/ai", strings.NewReader(`{
		"enabled":true,
		"features":{
			"component":{"enabled":false},
			"kb":{"enabled":false}
		}
	}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("PUT /api/settings/ai: %d %s", w.Code, w.Body.String())
	}
	stAdmin = readStatus(admin)
	if stAdmin.Features["component"] || stAdmin.Features["kb"] {
		t.Fatalf("expected component & kb disabled platform-wide, got %+v", stAdmin.Features)
	}
	if !stAdmin.Features["assistant"] || !stAdmin.Features["troubleshoot"] {
		t.Fatalf("expected untouched features to stay enabled (partial update preservation), got %+v", stAdmin.Features)
	}
	// Backend API gate must reject component AI revision note when component AI is disabled.
	// Create a draft of etcd first so we reach the AI gate.
	_ = storeRequest(s, "POST", "/api/components/etcd/draft", strings.NewReader(`{"from":"live"}`), admin, acsrf)
	w = storeRequest(s, "POST", "/api/components/etcd/draft/note", strings.NewReader(`{}`), admin, acsrf)
	if w.Code != 409 {
		t.Fatalf("expected 409 when component AI switch is OFF, got %d %s", w.Code, w.Body.String())
	}

	// 4. Turning master switch OFF hides everything; turning it back ON remembers component=false, kb=false!
	w = storeRequest(s, "POST", "/api/ai/toggle", strings.NewReader(`{"enabled":false}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("master off: %d", w.Code)
	}
	stAdmin = readStatus(admin)
	if stAdmin.Enabled || stAdmin.Features["assistant"] {
		t.Fatalf("expected all features false when master off, got %+v", stAdmin)
	}
	w = storeRequest(s, "POST", "/api/ai/toggle", strings.NewReader(`{"enabled":true}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("master on again: %d", w.Code)
	}
	stAdmin = readStatus(admin)
	if stAdmin.Features["component"] || stAdmin.Features["kb"] || !stAdmin.Features["assistant"] {
		t.Fatalf("expected master re-enable to remember sub-feature states, got %+v", stAdmin.Features)
	}

	// Re-enable component & kb platform-wide so we can test IAM granular role control.
	w = storeRequest(s, "PUT", "/api/settings/ai", strings.NewReader(`{
		"enabled":true,
		"features":{"component":{"enabled":true},"kb":{"enabled":true}}
	}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("re-enable features: %d", w.Code)
	}

	// 5. IAM Granular Role (方案 B): create a role with component.edit + ai.use + ai.feat.assistant ONLY (NO ai.feat.component).
	w = storeRequest(s, "POST", "/api/iam/roles", strings.NewReader(`{
		"name":"无组件AI维护者",
		"perms":["delivery.view","component.edit","ai.use","ai.feat.assistant"],
		"scope":"own",
		"granular_ai":true
	}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("create granular role: %d %s", w.Code, w.Body.String())
	}
	var iamResp struct {
		Roles []role `json:"roles"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &iamResp)
	var customRoleID string
	for _, r := range iamResp.Roles {
		if r.Name == "无组件AI维护者" {
			customRoleID = r.ID
		}
	}
	if customRoleID == "" {
		t.Fatal("custom role not found")
	}
	w = storeRequest(s, "PUT", "/api/users/alice/grant", strings.NewReader(`{"roles":["`+customRoleID+`"]}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("grant custom role: %d %s", w.Code, w.Body.String())
	}
	stAlice = readStatus(alice)
	if !stAlice.Features["assistant"] || stAlice.Features["component"] || stAlice.Features["troubleshoot"] {
		t.Fatalf("expected alice to only have assistant AI per role, got %+v", stAlice.Features)
	}
	// Alice has component.edit, so routePerm allows /api/components/etcd/draft/note,
	// but granular IAM AI check MUST reject with 403 because she lacks ai.feat.component!
	w = storeRequest(s, "POST", "/api/components/etcd/draft/note", strings.NewReader(`{}`), alice, csrf)
	if w.Code != 403 {
		t.Fatalf("expected 403 for user lacking ai.feat.component, got %d %s", w.Code, w.Body.String())
	}

	// 6. Legacy custom role compatibility: a role with only ["ai.use"] and granular_ai=false expands all ai.feat.*.
	w = storeRequest(s, "POST", "/api/iam/roles", strings.NewReader(`{
		"name":"旧版AI角色",
		"perms":["delivery.view","ai.use"],
		"scope":"own"
	}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("create legacy role: %d %s", w.Code, w.Body.String())
	}
	_ = json.Unmarshal(w.Body.Bytes(), &iamResp)
	var legacyID string
	for _, r := range iamResp.Roles {
		if r.Name == "旧版AI角色" {
			legacyID = r.ID
		}
	}
	w = storeRequest(s, "PUT", "/api/users/alice/grant", strings.NewReader(`{"roles":["`+legacyID+`"]}`), admin, acsrf)
	if w.Code != 200 {
		t.Fatalf("grant legacy role: %d", w.Code)
	}
	stAlice = readStatus(alice)
	if !stAlice.Features["assistant"] || !stAlice.Features["component"] || !stAlice.Features["troubleshoot"] {
		t.Fatalf("expected legacy ai.use role to expand all ai features, got %+v", stAlice.Features)
	}
}

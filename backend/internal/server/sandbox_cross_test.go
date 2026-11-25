package server

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestUntarSafeHandlesSymlinksCrossPlatform(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)

	addFile := func(name, body string) {
		_ = tw.WriteHeader(&tar.Header{
			Name:     name,
			Typeflag: tar.TypeReg,
			Mode:     0o755,
			Size:     int64(len(body)),
		})
		_, _ = tw.Write([]byte(body))
	}
	addLink := func(name, link string) {
		_ = tw.WriteHeader(&tar.Header{
			Name:     name,
			Typeflag: tar.TypeSymlink,
			Linkname: link,
			Mode:     0o777,
		})
	}

	// Put symlink BEFORE its target (just like 2to3 -> 2to3-3.12 in Python tarballs!)
	addLink("python/bin/2to3", "2to3-3.12")
	addFile("python/bin/2to3-3.12", "#!/usr/bin/env python3\nprint('2to3')\n")
	addLink("python/bin/escape", "../../../etc/passwd")

	_ = tw.Close()
	_ = gz.Close()

	tmp := t.TempDir()
	archive := filepath.Join(tmp, "sandbox-runtime.tar.gz")
	if err := os.WriteFile(archive, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(tmp, "out")
	if err := untarSafe(archive, dst); err != nil {
		t.Fatalf("untarSafe failed on symlink archive: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(dst, "bin", "2to3"))
	if err != nil || !strings.Contains(string(b), "2to3") {
		t.Fatalf("expected bin/2to3 to resolve cleanly, got err=%v body=%q", err, string(b))
	}
	if _, err := os.Stat(filepath.Join(dst, "bin", "escape")); err == nil {
		t.Fatal("out-of-tree symlink should have been skipped")
	}
}

func TestCrossPlatformSandboxSelfCheckAndPolicies(t *testing.T) {
	info, err := discoverHostPython()
	if err != nil {
		t.Skip("no host python3 available:", err)
	}
	t.Logf("Discovered Python %s (%s) via %s", info.Version, info.PythonBin, sandboxBackendLabel())

	ok, checks := sandboxSelfCheck(context.Background(), t.TempDir(), info.Dir, info.PythonBin, 8443)
	for _, c := range checks {
		t.Logf("check [%v] %s %s", c.OK, c.Name, c.Note)
	}
	if !ok {
		t.Fatalf("cross-platform sandboxSelfCheck did not pass all checks")
	}

	// Verify live approval flow + execution/network policies via chat SSE
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	alice, csrf := storeLogin(t, s, "alice")
	bob, bcsrf := storeLogin(t, s, "bob")

	// 1. Run POST /api/settings/sandbox/check and enable with exec_policy="ask", net_policy="ask"
	cw := storeRequest(s, "POST", "/api/settings/sandbox/check", nil, admin, acsrf)
	if cw.Code != 200 || !strings.Contains(cw.Body.String(), `"passed":true`) {
		t.Fatalf("sandbox check API failed: %d %s", cw.Code, cw.Body.String())
	}
	pw := storeRequest(s, "PUT", "/api/settings/sandbox", strings.NewReader(`{"enabled":true,"seconds":60,"memory_mb":1024,"procs":32,"output_mb":50,"exec_policy":"ask","net_policy":"ask"}`), admin, acsrf)
	if pw.Code != 200 {
		t.Fatalf("sandbox PUT failed: %d %s", pw.Code, pw.Body.String())
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		b, _ := io.ReadAll(r.Body)
		if strings.Contains(string(b), `"role":"tool"`) {
			io.WriteString(w, "data: "+`{"choices":[{"delta":{"content":"计算完成：21"}}]}`+"\n\ndata: [DONE]\n\n")
			return
		}
		args, _ := json.Marshal(map[string]any{"code": "print(6 * 7 // 2)", "purpose": "计算结果"})
		call, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "c1", "function": map[string]any{"name": "run_python", "arguments": string(args)}}}}}}})
		io.WriteString(w, "data: "+string(call)+"\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()
	enableAI(t, s, srv.URL, 1)

	// Background goroutine watches for pending approval, tests Bob cannot hijack Alice's approval, then Alice approves!
	doneApprove := make(chan struct{})
	go func() {
		defer close(doneApprove)
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			var foundID string
			sandboxApprovals.Range(func(k, _ any) bool {
				foundID = k.(string)
				return false
			})
			if foundID != "" {
				// Bob attempts to approve Alice's sandbox request -> MUST be 403
				bw := storeRequest(s, "POST", "/api/ai/sandbox/approve", strings.NewReader(`{"id":"`+foundID+`","decision":"allow"}`), bob, bcsrf)
				if bw.Code != 403 {
					t.Errorf("expected 403 when bob approves alice's sandbox run, got %d", bw.Code)
				}
				// Alice approves
				aw := storeRequest(s, "POST", "/api/ai/sandbox/approve", strings.NewReader(`{"id":"`+foundID+`","decision":"allow"}`), alice, csrf)
				if aw.Code != 200 {
					t.Errorf("alice approve failed: %d %s", aw.Code, aw.Body.String())
				}
				return
			}
			time.Sleep(30 * time.Millisecond)
		}
	}()

	w := storeRequest(s, "POST", "/api/ai/chats/abcdef012345/chat", strings.NewReader(`{"message":"帮我算一下"}`), alice, csrf)
	<-doneApprove
	out := w.Body.String()
	if w.Code != 200 || !strings.Contains(out, `"t":"sandbox_confirm"`) || !strings.Contains(out, `"t":"sandbox_confirmed"`) || !strings.Contains(out, "计算完成：21") {
		t.Fatalf("expected live approval SSE roundtrip and output, got %d:\n%s", w.Code, out)
	}
}

func TestCrossPlatformSandboxShellAndWorkspace(t *testing.T) {
	info, err := discoverHostPython()
	if err != nil {
		t.Skip("no host python3 available:", err)
	}

	// 1. Verify policy assessment for "shell" runs under ask / auto / open + session approval
	for _, tc := range []struct {
		name        string
		execPol     string
		sessionOpen bool
		wantAsk     bool
	}{
		{"ask_prompts", "ask", false, true},
		{"auto_prompts_shell", "auto", false, true},
		{"open_runs_shell", "open", false, false},
		{"session_approved_auto", "auto", true, false},
	} {
		needExec, _, _, _ := assessSandboxRun(
			sandboxSettings{ExecPolicy: tc.execPol, NetPolicy: "deny"},
			&sandboxGate{SessionOpen: tc.sessionOpen},
			"shell",
			"echo hi",
			false, false, "",
		)
		if needExec != tc.wantAsk {
			t.Fatalf("%s: want needExec=%v, got %v", tc.name, tc.wantAsk, needExec)
		}
	}

	// 2. Verify shell execution with scrubbed host env + sanitized read-only /workspace exposure
	t.Setenv("SUPER_SECRET_TOKEN", "topsecret-leak-check")
	ws := []sandboxWorkspaceFile{
		{Rel: "playbooks/deploy.yml", Data: []byte("---\n- name: test\n  vars:\n    redis_password: \"hunter2\"\n")},
		{Rel: "meta.json", Data: []byte(`{"name":"redis","api_key":"sk-secretvalue123"}`)},
		{Rel: "certs/server.key", Data: []byte("-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n")},
		{Rel: "../outside.txt", Data: []byte("escape")},
	}
	cmd := `grep -q "hunter2" "$MW_WORKSPACE/playbooks/deploy.yml" && exit 10
test -f "$MW_WORKSPACE/certs/server.key" && exit 11
test -n "$SUPER_SECRET_TOKEN" && exit 12
cat "$MW_WORKSPACE/meta.json" > "$MW_OUT/ws_check.json"
printf 'ok\n'`
	if runtime.GOOS == "windows" {
		cmd = `$yml = Get-Content -Raw -LiteralPath "$env:MW_WORKSPACE\playbooks\deploy.yml"
if ($yml -match 'hunter2') { exit 10 }
if (Test-Path -LiteralPath "$env:MW_WORKSPACE\certs\server.key") { exit 11 }
if ($env:SUPER_SECRET_TOKEN) { exit 12 }
Copy-Item -LiteralPath "$env:MW_WORKSPACE\meta.json" -Destination "$env:MW_OUT\ws_check.json"
Write-Output "ok"`
	}
	res, err := runSandbox(context.Background(), t.TempDir(), sandboxRun{
		Mode:      "shell",
		Runtime:   info.Dir,
		PythonBin: info.PythonBin,
		Command:   cmd,
		Workspace: ws,
		Limits:    sandboxLimits{Seconds: 15, MemoryMB: 512, Procs: 32, OutputMB: 8},
	})
	if err != nil {
		t.Fatalf("runSandbox shell failed: %v", err)
	}
	defer res.Cleanup()
	if res.ExitCode != 0 || !strings.Contains(res.Stdout, "ok") {
		t.Fatalf("expected shell exit=0 & ok stdout, got code=%d stdout=%q stderr=%q", res.ExitCode, res.Stdout, res.Stderr)
	}
	if len(res.Files) != 1 || res.Files[0].Name != "ws_check.json" {
		t.Fatalf("expected ws_check.json in outputs, got %#v", res.Files)
	}
	var parsed map[string]string
	rawMeta, _ := os.ReadFile(res.Files[0].Path)
	if err := json.Unmarshal(rawMeta, &parsed); err != nil {
		t.Fatalf("expected valid JSON after workspace secret scrubbing, got err=%v raw=%q", err, string(rawMeta))
	}
	if strings.Contains(string(rawMeta), "sk-secretvalue123") {
		t.Fatalf("workspace secret leaked into sandbox: %q", string(rawMeta))
	}

	// 3. Verify run_shell & workspace schema visibility in extFor, plus end-to-end tool call
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	_, _ = storeLogin(t, s, "alice")
	if cw := storeRequest(s, "POST", "/api/settings/sandbox/check", nil, admin, acsrf); cw.Code != 200 {
		t.Fatalf("sandbox check failed: %d %s", cw.Code, cw.Body.String())
	}
	if pw := storeRequest(s, "PUT", "/api/settings/sandbox", strings.NewReader(`{"enabled":true,"seconds":30,"memory_mb":512,"procs":32,"output_mb":20,"exec_policy":"open","net_policy":"deny"}`), admin, acsrf); pw.Code != 200 {
		t.Fatalf("sandbox put failed: %d", pw.Code)
	}

	plainExt := s.extFor("assistant", aiOpts{User: "alice"})
	wsExt := s.extFor("assistant", aiOpts{User: "alice", Workspace: &sandboxWorkspaceSpec{
		Label: "组件 redis 工作区",
		Files: func(context.Context) ([]sandboxWorkspaceFile, error) { return ws, nil },
	}})
	findTool := func(defs []aiToolDef, name string) (aiToolDef, bool) {
		for _, d := range defs {
			if d.Name == name {
				return d, true
			}
		}
		return aiToolDef{}, false
	}
	dNoWS, ok1 := findTool(plainExt.tools, runShellName)
	dWithWS, ok2 := findTool(wsExt.tools, runShellName)
	if !ok1 || !ok2 {
		t.Fatal("expected run_shell tool to be registered when sandbox is enabled")
	}
	p1, _ := dNoWS.Parameters["properties"].(map[string]any)
	p2, _ := dWithWS.Parameters["properties"].(map[string]any)
	if _, has := p1["workspace"]; has {
		t.Fatal("run_shell should not advertise workspace param when no project/component workspace is bound")
	}
	if _, has := p2["workspace"]; !has {
		t.Fatal("run_shell should advertise workspace param when workspace is bound")
	}

	made := &producedFiles{}
	wsExt.made = made
	wsExt.bindCtx(context.Background(), sse{})
	runFn := wsExt.wrap(func(string, string) string { return "" })
	toolCmd := `cat "$MW_WORKSPACE/playbooks/deploy.yml" | wc -l`
	if runtime.GOOS == "windows" {
		toolCmd = `(Get-Content -LiteralPath "$env:MW_WORKSPACE\playbooks\deploy.yml").Count`
	}
	toolArgs, _ := json.Marshal(map[string]any{"command": toolCmd, "workspace": true, "purpose": "统计部署脚本行数"})
	toolOut := runFn(runShellName, string(toolArgs))
	if !strings.Contains(toolOut, "退出码 0") {
		t.Fatalf("expected run_shell with workspace to succeed, got: %s", toolOut)
	}
}

func TestSandboxSmartNetworkAutoPolicy(t *testing.T) {
	// 1. Domain allowlist normalization
	gotDomains := normalizeNetAllowDomains([]string{
		"https://PyPI.Corp.Example.com/simple/",
		"*.com",
		"localhost",
		"127.0.0.1",
		".mirrors.internal.net",
		"pypi.corp.example.com",
		"bad domain/x",
	})
	if len(gotDomains) != 2 || gotDomains[0] != "pypi.corp.example.com" || gotDomains[1] != "*.mirrors.internal.net" {
		t.Fatalf("unexpected normalized domains: %#v", gotDomains)
	}

	autoSt := sandboxSettings{
		ExecPolicy:      "auto",
		NetPolicy:       "auto",
		NetAllowDomains: []string{"pypi.corp.example.com", "*.mirrors.internal.net"},
	}
	pypiSnippet := `import urllib.request, json
pkgs = {'ansible-core': '2.20.10', 'cryptography': '50.0.2'}
for p, v in pkgs.items():
    req = urllib.request.Request(f'https://pypi.org/pypi/{p}/{v}/json', headers={'User-Agent': 'audit/1.0'})
    data = json.load(urllib.request.urlopen(req, timeout=25))
    print(p, data['info']['version'])
`

	// 2. Policy decision matrix
	cases := []struct {
		name            string
		gate            *sandboxGate
		req             sandboxConfirmReq
		wantExecAsk     bool
		wantNetAsk      bool
		wantAllowNet    bool
		wantReadOnly    bool
		wantBlockPriv   bool
		wantReasonMatch string
	}{
		{
			name:          "trusted_pypi_readonly_auto_approved",
			req:           sandboxConfirmReq{Kind: "python", Code: pypiSnippet, WantNet: true, NetReason: "查询 PyPI 版本"},
			wantAllowNet:  true,
			wantReadOnly:  true,
			wantBlockPriv: true,
		},
		{
			name:            "mounted_user_file_must_ask",
			req:             sandboxConfirmReq{Kind: "python", Code: pypiSnippet, Files: []string{"servers.xlsx"}, WantNet: true},
			wantNetAsk:      true,
			wantReasonMatch: "用户资料或只读工作区",
		},
		{
			name:            "mounted_workspace_must_ask",
			req:             sandboxConfirmReq{Kind: "python", Code: pypiSnippet, Workspace: "组件 pg 工作区", WantNet: true},
			wantNetAsk:      true,
			wantReasonMatch: "用户资料或只读工作区",
		},
		{
			name:            "http_post_data_must_ask",
			req:             sandboxConfirmReq{Kind: "python", Code: `import urllib.request; urllib.request.urlopen(urllib.request.Request("https://api.osv.dev/v1/query", data=b"{}"))`, WantNet: true},
			wantNetAsk:      true,
			wantReasonMatch: "写入",
		},
		{
			name:            "unknown_domain_must_ask",
			req:             sandboxConfirmReq{Kind: "python", Code: `import urllib.request; urllib.request.urlopen("https://webhook.site/abc")`, WantNet: true},
			wantNetAsk:      true,
			wantReasonMatch: "webhook.site",
		},
		{
			name:            "plaintext_http_must_ask",
			req:             sandboxConfirmReq{Kind: "python", Code: `import urllib.request; urllib.request.urlopen("http://pypi.org/simple/")`, WantNet: true},
			wantNetAsk:      true,
			wantReasonMatch: "HTTP",
		},
		{
			name:            "dynamic_host_must_ask",
			req:             sandboxConfirmReq{Kind: "python", Code: `import urllib.request; h="pypi.org"; urllib.request.urlopen(f"https://{h}/simple/")`, WantNet: true},
			wantNetAsk:      true,
			wantReasonMatch: "动态拼接",
		},
		{
			name:            "shell_network_must_ask",
			req:             sandboxConfirmReq{Kind: "shell", Code: `curl https://pypi.org/pypi/pip/json`, WantNet: true},
			wantExecAsk:     true,
			wantNetAsk:      true,
			wantReasonMatch: "Shell",
		},
		{
			name:          "custom_enterprise_domain_auto_approved",
			req:           sandboxConfirmReq{Kind: "python", Code: `import urllib.request; urllib.request.urlopen("https://sub.mirrors.internal.net/simple/")`, WantNet: true},
			wantAllowNet:  true,
			wantReadOnly:  true,
			wantBlockPriv: false,
		},
		{
			name:        "user_ask_mode_overrides_auto_net",
			gate:        &sandboxGate{UserMode: "ask"},
			req:         sandboxConfirmReq{Kind: "python", Code: pypiSnippet, WantNet: true},
			wantExecAsk: true,
			wantNetAsk:  true,
		},
		{
			name:        "user_open_overrides_platform_default_auto",
			gate:        &sandboxGate{UserMode: "open"},
			req:         sandboxConfirmReq{Kind: "shell", Code: `echo hi`, WantNet: false},
			wantExecAsk: false,
		},
		{
			name:            "user_open_still_enforces_net_policy_on_untrusted_host",
			gate:            &sandboxGate{UserMode: "open"},
			req:             sandboxConfirmReq{Kind: "python", Code: `import urllib.request; urllib.request.urlopen("https://evil.example.com/a")`, WantNet: true},
			wantExecAsk:     false,
			wantNetAsk:      true,
			wantReasonMatch: "evil.example.com",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			needExec, needNet, guard, reasons := assessSandboxRunWithGuard(autoSt, tc.gate, tc.req)
			if needExec != tc.wantExecAsk || needNet != tc.wantNetAsk || guard.AllowNet != tc.wantAllowNet || guard.ReadOnly != tc.wantReadOnly || guard.BlockPrivate != tc.wantBlockPriv {
				t.Fatalf("got (exec=%v net=%v guard=%+v reasons=%v), want (exec=%v net=%v allowNet=%v ro=%v blockPriv=%v)",
					needExec, needNet, guard, reasons, tc.wantExecAsk, tc.wantNetAsk, tc.wantAllowNet, tc.wantReadOnly, tc.wantBlockPriv)
			}
			if tc.wantReasonMatch != "" && !strings.Contains(strings.Join(reasons, " | "), tc.wantReasonMatch) {
				t.Fatalf("expected reason containing %q, got %v", tc.wantReasonMatch, reasons)
			}
		})
	}

	// End-user's explicit "open" selection also overrides a stricter platform default ("ask").
	askDefSt := sandboxSettings{ExecPolicy: "ask", NetPolicy: "ask"}
	if needExec, needNet, _, _ := assessSandboxRunWithGuard(askDefSt, &sandboxGate{UserMode: "open"}, sandboxConfirmReq{Kind: "shell", Code: "echo ok", WantNet: false}); needExec || needNet {
		t.Fatalf("expected user open mode to override platform default ask, got needExec=%v needNet=%v", needExec, needNet)
	}
	if needExec, needNet, _, _ := assessSandboxRunWithGuard(askDefSt, &sandboxGate{UserMode: "open"}, sandboxConfirmReq{Kind: "python", Code: "import urllib.request", WantNet: true}); needExec || !needNet {
		t.Fatalf("expected user open mode to skip exec ask while still respecting net_policy=ask, got needExec=%v needNet=%v", needExec, needNet)
	}

	// 3. Settings API roundtrip for net_policy="auto" + net_allow_domains + builtin_net_domains
	s, _ := testStore(t)
	admin, acsrf := storeLogin(t, s, "admin")
	pw := storeRequest(s, "PUT", "/api/settings/sandbox", strings.NewReader(`{"enabled":false,"seconds":60,"memory_mb":1024,"procs":32,"output_mb":50,"exec_policy":"auto","net_policy":"auto","net_allow_domains":["https://pypi.corp.example.com/simple","*.com","localhost","*.mirrors.internal.net"]}`), admin, acsrf)
	if pw.Code != 200 {
		t.Fatalf("PUT /api/settings/sandbox failed: %d %s", pw.Code, pw.Body.String())
	}
	gw := storeRequest(s, "GET", "/api/settings/sandbox", nil, admin, "")
	if gw.Code != 200 {
		t.Fatalf("GET /api/settings/sandbox failed: %d %s", gw.Code, gw.Body.String())
	}
	var gotResp struct {
		Settings          sandboxSettings `json:"settings"`
		BuiltinNetDomains []string        `json:"builtin_net_domains"`
	}
	if err := json.Unmarshal(gw.Body.Bytes(), &gotResp); err != nil {
		t.Fatalf("decode sandbox GET: %v", err)
	}
	if gotResp.Settings.NetPolicy != "auto" || len(gotResp.Settings.NetAllowDomains) != 2 || len(gotResp.BuiltinNetDomains) < 20 {
		t.Fatalf("unexpected sandbox GET payload: %+v", gotResp)
	}

	// 4. Live PEP-578 runtime audit hook verification (zero external traffic needed!)
	info, err := discoverHostPython()
	if err != nil {
		t.Skip("no host python3 available for runtime PEP-578 test:", err)
	}
	work := t.TempDir()
	codePath := filepath.Join(work, "net_guard_test.py")
	pyTest := `import json, socket, urllib.request
res = {}
def check(name, fn):
    try:
        fn()
        res[name] = "ALLOWED"
    except PermissionError as e:
        res[name] = "BLOCKED:" + str(e)
    except Exception as e:
        res[name] = "OTHER:" + type(e).__name__ + ":" + str(e)

check("unlisted_host", lambda: urllib.request.urlopen("https://evil.example.com/"))
check("post_body", lambda: urllib.request.urlopen(urllib.request.Request("https://pypi.org/pypi/pip/json", data=b"{}")))
check("http_plain", lambda: urllib.request.urlopen("http://pypi.org/pypi/pip/json"))
check("direct_ip", lambda: socket.socket().connect(("1.1.1.1", 443)))
check("private_ip", lambda: socket.socket().connect(("10.0.0.1", 443)))
print(json.dumps(res))
`
	if err := os.WriteFile(codePath, []byte(pyTest), 0o644); err != nil {
		t.Fatal(err)
	}
	runRes, err := runSandbox(context.Background(), work, sandboxRun{
		Runtime:         info.Dir,
		PythonBin:       info.PythonBin,
		Argv:            []string{info.InnerArg0, "/in/_main.py"},
		Inputs:          []sandboxInput{{Name: "_main.py", Path: codePath}},
		Limits:          sandboxLimits{Seconds: 15, MemoryMB: 512, Procs: 32, OutputMB: 8},
		AllowNet:        true,
		NetReadOnly:     true,
		NetAllowHosts:   []string{"pypi.org", "*.pythonhosted.org"},
		NetBlockPrivate: true,
		ProbePort:       8443,
	})
	if err != nil {
		t.Fatalf("runSandbox runtime guard test failed: %v", err)
	}
	defer runRes.Cleanup()
	if runRes.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d stderr=%s stdout=%s", runRes.ExitCode, runRes.Stderr, runRes.Stdout)
	}
	var guardResults map[string]string
	if err := json.Unmarshal([]byte(strings.TrimSpace(runRes.Stdout)), &guardResults); err != nil {
		t.Fatalf("parse runtime guard output %q: %v", runRes.Stdout, err)
	}
	for _, k := range []string{"unlisted_host", "post_body", "http_plain", "direct_ip", "private_ip"} {
		if !strings.HasPrefix(guardResults[k], "BLOCKED:") {
			t.Fatalf("expected %s to be blocked by PEP-578 audit hook, got %q (all=%v)", k, guardResults[k], guardResults)
		}
	}
}

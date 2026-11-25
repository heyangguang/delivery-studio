//go:build linux

package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The tests need a Python to stand in for the runtime and a kernel that allows user namespaces; without them they skip.
func sandboxTestRuntime(t *testing.T) (string, string) {
	if rt := os.Getenv("MW_SB_RT"); rt != "" {
		return rt, os.Getenv("MW_SB_PY")
	}
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("no python3")
	}
	real, _ := filepath.EvalSymlinks(py)
	if out, err := exec.Command("sh", "-c", "pyenv prefix 2>/dev/null || true").Output(); err == nil && strings.TrimSpace(string(out)) != "" {
		return strings.TrimSpace(string(out)), "python3"
	}
	return filepath.Dir(filepath.Dir(real)), filepath.Base(real)
}

func TestSandboxHoldsAndWorks(t *testing.T) {
	if os.Getenv("MW_SANDBOX_TEST") == "" {
		t.Skip("set MW_SANDBOX_TEST=1 to run the sandbox against this machine's kernel")
	}
	rt, py := sandboxTestRuntime(t)
	ok, checks := sandboxSelfCheck(context.Background(), t.TempDir(), rt, py, 8443)
	for _, c := range checks {
		t.Logf("%v %s %s", c.OK, c.Name, c.Note)
	}
	if !ok {
		t.Fatal("self-check did not pass")
	}
	// inputs in, files out
	work := t.TempDir()
	in := filepath.Join(work, "data.txt")
	os.WriteFile(in, []byte("三 个 词"), 0o644)
	code := filepath.Join(work, "main.py")
	os.WriteFile(code, []byte("import os\ns=open('/in/data.txt',encoding='utf-8').read()\nopen('/out/n.txt','w').write(str(len(s.split())))\nprint('done')\n"), 0o644)
	res, err := runSandbox(context.Background(), work, sandboxRun{Runtime: rt, Argv: []string{"/rt/bin/" + py, "/in/main.py"}, Inputs: []sandboxInput{{"data.txt", in}, {"main.py", code}}})
	if err != nil {
		t.Fatal(err)
	}
	defer res.Cleanup()
	if res.ExitCode != 0 || !strings.Contains(res.Stdout, "done") || len(res.Files) != 1 || res.Files[0].Name != "n.txt" {
		t.Fatalf("%+v", res)
	}
	if b, _ := os.ReadFile(res.Files[0].Path); string(b) != "3" {
		t.Fatalf("%q", b)
	}
}

// the sandbox starts a copy of the running program; in tests that copy is the test binary
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "sandbox-child" {
		_ = sandboxCommand(os.Args[2:])
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestSandboxStopsHostileCode(t *testing.T) {
	if os.Getenv("MW_SANDBOX_TEST") == "" {
		t.Skip("set MW_SANDBOX_TEST=1")
	}
	rt, py := sandboxTestRuntime(t)
	run := func(code string, lim sandboxLimits) sandboxResult {
		work := t.TempDir()
		f := filepath.Join(work, "main.py")
		os.WriteFile(f, []byte(code), 0o644)
		res, err := runSandbox(context.Background(), work, sandboxRun{Runtime: rt, Argv: []string{"/rt/bin/" + py, "/in/main.py"}, Inputs: []sandboxInput{{"main.py", f}}, Limits: lim})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(res.Cleanup)
		return res
	}
	// fills the disk
	if r := run("f=open('/out/big','wb')\nwhile True: f.write(b'x'*1000000)\n", sandboxLimits{Seconds: 20, OutputMB: 5}); !(r.TooBig || r.ExitCode != 0) || dirSize(filepath.Dir(r.Files[0].Path)) > 40<<20 {
		t.Fatalf("file bomb: %+v", r)
	}
	// fork bomb
	r := run("import os\nn=0\ntry:\n  while n<500:\n    os.fork(); n+=1\nexcept OSError as e:\n  print('limited',n)\n", sandboxLimits{Seconds: 10, Procs: 16})
	if r.TimedOut {
		t.Fatalf("fork bomb ran away: %+v", r)
	}
	// wanders: the host's root is not reachable by any path
	r = run("import os\nfor p in ['/proc/1/root/etc/shadow','/proc/self/root/root','/.old','/proc/1/environ','/../../etc/shadow','/sys/fs','/proc/sys/kernel/hostname']:\n  print(p, os.path.exists(p))\nprint(open('/proc/self/mountinfo').read().count('/home'))\n", sandboxLimits{Seconds: 10})
	t.Log(r.Stdout, r.Stderr)
	for _, bad := range []string{"/etc/shadow True", "/root True", "/.old True"} {
		if strings.Contains(r.Stdout, bad) {
			t.Fatalf("reached the host: %s", r.Stdout)
		}
	}
	// the platform's own files are not there
	r = run("import os\nprint(sorted(os.listdir('/')))\n", sandboxLimits{Seconds: 10})
	t.Log(r.Stdout)
	for _, host := range []string{"home", "root", "var", "opt", "mnt", "srv", "boot"} {
		if strings.Contains(r.Stdout, "'"+host+"'") {
			t.Fatalf("host directory %s is visible: %s", host, r.Stdout)
		}
	}
}

func TestAssistantRunsPythonAndKeepsWhatItMakes(t *testing.T) {
	if os.Getenv("MW_SANDBOX_TEST") == "" {
		t.Skip("set MW_SANDBOX_TEST=1")
	}
	rt, _ := sandboxTestRuntime(t)
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		w.Header().Set("Content-Type", "text/event-stream")
		b, _ := io.ReadAll(r.Body)
		if strings.Contains(string(b), `"role":"tool"`) {
			io.WriteString(w, "data: "+`{"choices":[{"delta":{"content":"已生成 summary.txt"}}]}`+"\n\ndata: [DONE]\n\n")
			return
		}
		args, _ := json.Marshal(map[string]any{"code": "s=open('/in/notes.txt',encoding='utf-8').read()\nopen('/out/summary.txt','w',encoding='utf-8').write('字数:'+str(len(s)))\nprint('ok')", "files": []string{"notes.txt"}, "purpose": "数字数"})
		call, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "c1", "function": map[string]any{"name": "run_python", "arguments": string(args)}}}}}}})
		io.WriteString(w, "data: "+string(call)+"\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()
	s, _ := testStore(t)
	alice, csrf := storeLogin(t, s, "alice")
	enableAI(t, s, srv.URL, 1)
	st := s.sandboxSettings()
	st.Runtime, st.Passed, st.Enabled = rt, true, true
	s.saveSandboxSettings(st)
	fst := s.storageSettings()
	if _, err := s.storeOne("alice", "", "notes.txt", strings.NewReader("一二三四五"), fst, fst.quotaOf("alice"), ""); err != nil {
		t.Fatal(err)
	}
	w := storeRequest(s, "POST", "/api/ai/chats/0123456789ab/chat", strings.NewReader(`{"message":"数一下字数"}`), alice, csrf)
	out := w.Body.String()
	if w.Code != 200 || !strings.Contains(out, `"t":"files"`) || !strings.Contains(out, "summary.txt") || !strings.Contains(out, "已生成 summary.txt") {
		t.Fatal(w.Code, out)
	}
	if !strings.Contains(out, "s=open") {
		t.Fatal("the code is not shown in the step", out)
	}
	filesMu.Lock()
	ix := s.filesLoad("alice")
	filesMu.Unlock()
	var found bool
	for _, f := range ix.Nodes {
		if f.Name == "summary.txt" && f.Source == "" || f.Name == "summary.txt" {
			if b, _ := os.ReadFile(s.blobPath("alice", f.ID)); string(b) == "字数:5" {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("the file it made is not in the person's space: %+v", ix.Nodes)
	}
	// off by default for everyone else
	st.Enabled = false
	s.saveSandboxSettings(st)
	for _, d := range s.extFor("assistant", aiOpts{User: "alice"}).tools {
		if d.Name == "run_python" {
			t.Fatal("offered while switched off")
		}
	}
}

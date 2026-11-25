package mwpack_test

import (
	"delivery-studio/mwpack"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGeneratedStepContractEnforcesConditions(t *testing.T) {
	ansibleAvailable(t)
	p := mustSolve(t, fullCatalog(t), etcdOnly)
	inst := p.Instance("etcd")
	marker := filepath.Join(t.TempDir(), "marker")
	step := mwpack.Step{ID: "contract-check", Title: "Contract", Effect: "read-only", Hosts: "first:member", Preconditions: []string{"false"}, Postconditions: []string{"false"}, Tasks: []map[string]any{{"ansible.builtin.copy": map[string]any{"content": "executed", "dest": marker}}}}
	step.Inputs = map[string]mwpack.StepInput{"timeout": {Type: "int", Value: 10}}
	inst.R.Tests = []mwpack.Step{step}
	run := func(pre, post []string) (string, error) {
		inst.R.Tests[0].Preconditions = pre
		inst.R.Tests[0].Postconditions = post
		b, err := mwpack.Render(p, mwpack.RenderOptions{})
		if err != nil {
			t.Fatal(err)
		}
		dir := t.TempDir()
		for f, data := range b.Project {
			fp := filepath.Join(dir, f)
			os.MkdirAll(filepath.Dir(fp), 0700)
			if err := os.WriteFile(fp, data.Data, 0600); err != nil {
				t.Fatal(err)
			}
		}
		book := b.Steps.Tests[0].Playbook
		cmd := exec.Command(ansibleCmd("ansible-playbook"), "-i", "inventory/hosts.yml", "-c", "local", book)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "ANSIBLE_CONFIG="+filepath.Join(dir, "ansible.cfg"))
		output, err := cmd.CombinedOutput()
		return string(output), err
	}
	inst.R.Tests[0].Inputs["timeout"] = mwpack.StepInput{Type: "int", Value: "wrong"}
	if out, err := run(nil, nil); err == nil {
		t.Fatal("invalid typed input accepted", out)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("implementation ran with invalid inputs")
	}
	inst.R.Tests[0].Inputs["timeout"] = mwpack.StepInput{Type: "int", Value: 10}
	if out, err := run([]string{"false"}, nil); err == nil {
		t.Fatal("failed precondition accepted", out)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("implementation ran before failed precondition")
	}
	if out, err := run([]string{"true"}, []string{"false"}); err == nil {
		t.Fatal("failed postcondition accepted", out)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("implementation did not run", err)
	}
	if out, err := run([]string{"true"}, []string{"true"}); err != nil {
		t.Fatal(err, out)
	}
}

func TestStepContractRejectsTemplatedConditions(t *testing.T) {
	cat := fullCatalog(t)
	c, _ := cat.Get("etcd")
	r, _ := c.Resolve(c.Versions[0].ID)
	_ = r
	// Validation happens in the same path as catalog import and publication.
	old := c.Tests
	defer func() { c.Tests = old }()
	c.Tests = append(c.Tests, mwpack.Step{ID: "bad-contract", Title: "bad", Preconditions: []string{"{{ true }}"}, Tasks: []map[string]any{{"ansible.builtin.debug": map[string]any{"msg": "x"}}}})
	found := false
	for _, p := range mwpack.ValidateComponent(c, cat) {
		if strings.Contains(p.Message, "模板分隔符") {
			found = true
		}
	}
	if !found {
		t.Fatal("invalid condition accepted")
	}
}

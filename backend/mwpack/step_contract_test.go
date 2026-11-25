package mwpack

import (
	"strings"
	"testing"
	"testing/fstest"
)

func TestStepOwnershipRequiresExplicitSharing(t *testing.T) {
	files := fstest.MapFS{
		"demo/roles/demo/tasks/a.yml": {Data: []byte("- copy: {src: a.py, dest: /tmp/a.py}\n")},
		"demo/roles/demo/tasks/b.yml": {Data: []byte("- copy: {src: a.py, dest: /tmp/b.py}\n")},
		"demo/roles/demo/files/a.py":  {Data: []byte("print('a')\n")},
	}
	c := &Component{dir: "demo", fsys: files}
	r := &Resolved{C: c, Overlay: Overlay{Tests: []Step{
		{ID: "a", Run: &RunRef{Role: "demo", Tasks: "a"}},
		{ID: "b", Run: &RunRef{Role: "demo", Tasks: "b"}},
	}}}
	problems := validateStepOwnership(r)
	if len(problems) != 1 || !strings.Contains(problems[0].Message, "roles/demo/files/a.py") {
		t.Fatalf("undeclared sharing accepted: %+v", problems)
	}
	c.SharedFiles = []string{"roles/demo/files/a.py"}
	if p := validateStepOwnership(r); len(p) != 0 {
		t.Fatalf("explicit sharing refused: %+v", p)
	}
	c.SharedFiles = []string{"roles/demo/files/*.py"}
	if p := validateStepOwnership(r); len(p) == 0 {
		t.Fatal("wildcard sharing must not bypass private ownership")
	}
}

func TestStepOwnershipFollowsNestedImports(t *testing.T) {
	c := &Component{dir: "demo", fsys: fstest.MapFS{
		"demo/roles/demo/tasks/a.yml":           {Data: []byte("- import_tasks: nested/part.yml\n")},
		"demo/roles/demo/tasks/nested/part.yml": {Data: []byte("- template: {src: config.j2, dest: /tmp/config}\n")},
		"demo/roles/demo/templates/config.j2":   {Data: []byte("hello")},
	}}
	files, err := StepSourceFiles(c, Step{Run: &RunRef{Role: "demo", Tasks: "a"}})
	if err != nil || len(files) != 3 {
		t.Fatalf("missing transitive dependency: %v %v", files, err)
	}
	for _, from := range []string{"../escape", "/absolute", "{{ action }}"} {
		if _, err := StepSourceFiles(c, Step{Run: &RunRef{Role: "demo", Tasks: from}}); err == nil {
			t.Fatalf("unsafe entry allowed: %s", from)
		}
	}
}

func TestStaleSharedFilesWarnWithoutBlockingCatalogLoad(t *testing.T) {
	files := fstest.MapFS{
		"demo/component.yaml": {Data: []byte(`schema: mwpack/v1
component: demo
title: Demo
category: 数据库
roles:
  - {name: primary, title: 主节点, min: 1, max: 1, default: 1}
versions:
  - id: "1.0"
    status: draft
    platforms: [ubuntu-24.04-amd64]
lifecycle:
  install:
    - id: install
      title: 安装
      run: {role: demo, tasks: install}
shared_files:
  - roles/demo/tasks/install.yml
  - roles/demo/tasks/clonefrom_tags.yml
`)},
		"demo/roles/demo/tasks/install.yml": {Data: []byte("- name: ok\n  ansible.builtin.debug: {msg: hi}\n")},
	}
	cat, err := LoadCatalog(files)
	if err != nil {
		t.Fatalf("stale shared_files entry must not block catalog load: %v", err)
	}
	comp, ok := cat.Get("demo")
	if !ok {
		t.Fatal("component missing from loaded catalog")
	}
	probs := ValidateStepOwnership(comp)
	if len(probs) != 1 || probs[0].Severity != "warning" || probs[0].Path != "shared_files" {
		t.Fatalf("expected single shared_files warning, got %+v", probs)
	}

	// If a step actually imports the missing file, it must still fail with an error.
	files["demo/roles/demo/tasks/install.yml"] = &fstest.MapFile{
		Data: []byte("- import_tasks: clonefrom_tags.yml\n"),
	}
	if _, err := LoadCatalog(files); err == nil {
		t.Fatal("step importing missing file must still fail LoadCatalog")
	}
}

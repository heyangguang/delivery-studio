package main

import (
	"strings"
	"testing"
)

const pyBase = `import sys
action=sys.argv[3]
def helper(): return 1
def a(): return helper()
def b(): return 2
def front(): return 3
def prepare_front(): return 4
FRONT={'b','c'}
ACTIONS={'a':a,'b':b,'c':front}
if __name__=='__main__':
 if action in FRONT: prepare_front()
 ACTIONS[action]()
`

func TestPythonHelperIsAnalysedPerAction(t *testing.T) {
	check := func(name, now string, want map[string]bool) {
		t.Helper()
		for action, w := range want {
			hit, why, ok := pyReaches([]byte(pyBase), []byte(now), action)
			if !ok {
				t.Skip("no python3 on this machine")
			}
			if hit != w {
				t.Fatalf("%s, action %s: hit=%v (%s), want %v", name, action, hit, why, w)
			}
			if hit && why == "" {
				t.Fatalf("%s, action %s: no reason given", name, action)
			}
		}
	}
	check("a function only one action runs", strings.Replace(pyBase, "def b(): return 2", "def b(): return 20", 1), map[string]bool{"a": false, "b": true, "c": false})
	check("a function many call", strings.Replace(pyBase, "return 1", "return 10", 1), map[string]bool{"a": true, "b": false, "c": false})
	check("the step run only for some actions", strings.Replace(pyBase, "return 4", "return 40", 1), map[string]bool{"a": false, "b": true, "c": true})
	check("the dispatch of one action", strings.Replace(pyBase, "'c':front", "'c':b", 1), map[string]bool{"a": false, "b": false, "c": true})
	check("the rule that picks the preparation", strings.Replace(pyBase, "FRONT={'b','c'}", "FRONT={'b'}", 1), map[string]bool{"a": true, "b": true, "c": true})
	check("code every action runs", strings.Replace(pyBase, "import sys", "import sys, os", 1), map[string]bool{"a": true, "b": true, "c": true})
	check("nothing", pyBase, map[string]bool{"a": false, "b": false, "c": false})

	// anything it cannot prove is reported as such, never as "unaffected"
	if hit, _, ok := pyReaches([]byte(pyBase), []byte("def ("), "a"); ok || !hit {
		t.Fatal("a script that does not parse must not be called unaffected")
	}
	if hit, _, ok := pyReaches([]byte(pyBase), []byte(pyBase+"\n"), "nope"); ok || !hit {
		t.Fatal("an action the script does not dispatch must not be called unaffected")
	}
	dyn := strings.Replace(pyBase, "def b(): return 2", "def b(): return globals()['a']()", 1)
	if hit, _, ok := pyReaches([]byte(pyBase), []byte(dyn), "b"); ok || !hit {
		t.Fatal("a call by computed name must not be called unaffected")
	}
}

func TestStepActionIsReadFromTheTask(t *testing.T) {
	files := map[string][]byte{"roles/r/tasks/test.yml": []byte("- name: x\n  ansible.builtin.command:\n    argv:\n      - /usr/bin/python3\n      - \"/opt/{{ x }}/pgtest.py\"\n      - cfg.json\n      - \"{{ pg_test }}\"\n")}
	closure := map[string]bool{"roles/r/tasks/test.yml": true}
	if a, ok := actionOf(files, closure, "roles/r/files/pgtest.py", map[string]string{"pg_test": "failover"}); !ok || a != "failover" {
		t.Fatal(a, ok)
	}
	if _, ok := actionOf(files, closure, "roles/r/files/pgtest.py", map[string]string{}); ok {
		t.Fatal("an action the playbook does not fix must be unknown")
	}
}

func TestVariableFileChangeReachesOnlyUsers(t *testing.T) {
	old := []byte("pg_port: 5432\nmw_cluster: {id: a}\nlisten: \"{{ pg_port }}\"\n")
	now := []byte("pg_port: 5433\nmw_cluster: {id: a}\nlisten: \"{{ pg_port }}\"\nnew_var: 1\n")
	if hit, _ := varsReach(old, now, one("- debug: {msg: \"{{ mw_cluster.id }}\"}")); hit {
		t.Fatal("a step that names none of the changed variables is not reached")
	}
	if hit, why := varsReach(old, now, one("- debug: {msg: \"{{ listen }}\"}")); !hit || !strings.Contains(why, "listen") {
		t.Fatal("a variable built from a changed one must reach its users", why)
	}
	if hit, _ := varsReach(old, now, one("- debug: {msg: \"{{ lookup('vars', name) }}\"}")); !hit {
		t.Fatal("a computed lookup cannot be proven unrelated")
	}
}

// A new option inside one instance reaches only the steps that work on that instance and name the option (or use the
// options as a whole); not the others.
func TestChangeInsideAnInstanceIsFollowedByPath(t *testing.T) {
	old := []byte("mw_instances:\n  pg:\n    params: {tls: true}\n  other:\n    params: {tls: true}\nmw_cluster: {id: a}\n")
	now := []byte("mw_instances:\n  pg:\n    params: {tls: true, test_sslmode: verify-full}\n  other:\n    params: {tls: true}\nmw_cluster: {id: a}\n")
	pgPlay := "vars:\n  mw: '{{ mw_instances[''pg''] }}'\n"
	otherPlay := "vars:\n  mw: '{{ mw_instances[''other''] }}'\n"
	for name, c := range map[string]struct {
		text string
		want bool
	}{
		"works on pg, never reads the option":     {pgPlay + "{{ mw.params.tls }}", false},
		"works on pg and names the option":        {pgPlay + "{{ mw.params.test_sslmode | default('x') }}", true},
		"works on pg, takes the options whole":    {pgPlay + "{{ mw.params | to_json }}", true},
		"works on pg, takes the instance whole":   {pgPlay + "{{ mw | to_json }}", true},
		"works on pg, computed key":               {pgPlay + "{{ mw.params[item] }}", true},
		"works on another instance":               {otherPlay + "{{ mw.params | to_json }}", false},
		"reads all instances without naming them": {"{{ mw_instances | dict2items }}", true},
	} {
		if hit, why := varsReach(old, now, one(c.text)); hit != c.want {
			t.Errorf("%s: hit=%v (%s), want %v", name, hit, why, c.want)
		}
	}
}

func one(text string) map[string]string { return map[string]string{"roles/r/tasks/main.yml": text} }

func TestUnusedDefaultDefinitionsDoNotReachEveryStep(t *testing.T) {
	texts := map[string]string{
		"tests/a.yml":               "vars:\n  mw: '{{ mw_instances[''pg''] }}'\n",
		"roles/r/tasks/a.yml":       "- debug: {msg: '{{ pg_port }}'}\n",
		"roles/r/defaults/main.yml": "pg_port: '{{ mw.params.pg_port }}'\npg_parameters: {max_connections: '{{ mw.params.max_connections }}'}\n",
	}
	old := []byte("mw_instances: {pg: {params: {pg_port: 5432, max_connections: 100}}}\n")
	now := []byte("mw_instances: {pg: {params: {pg_port: 5432, max_connections: 200}}}\n")
	if hit, why := varsReach(old, now, reachableVariableTexts(texts)); hit {
		t.Fatal("unused definition expanded impact", why)
	}
	texts["roles/r/tasks/a.yml"] = "- debug: {msg: '{{ pg_parameters }}'}\n"
	if hit, _ := varsReach(old, now, reachableVariableTexts(texts)); !hit {
		t.Fatal("transitive default dependency missed")
	}
}

// Identical keys in database and manager contexts must not couple their steps.
func TestManagerVariableBindingsAreIndependent(t *testing.T) {
	old := []byte("mw_instances:\n  pg:\n    params: {port: 5432}\n  pg-ha:\n    params: {port: 8008}\n")
	now := []byte("mw_instances:\n  pg:\n    params: {port: 5433}\n  pg-ha:\n    params: {port: 8008}\n")
	binding := "mw: \"{{ mw_instances['pg'] }}\"\nmw_manager: \"{{ mw_instances['pg-ha'] }}\"\n"
	for _, tc := range []struct {
		text string
		want bool
	}{
		{"{{ mw_manager.params.port }}", false},
		{"{{ mw.params.port }}", true},
		{"{{ mw_manager.params | to_json }}", false},
		{"{{ mw.params | to_json }}", true},
		{"{{ mw_instances['pg'].params.port }}", true},
	} {
		hit, why := varsReach(old, now, map[string]string{"step.yml": binding + tc.text})
		if hit != tc.want {
			t.Fatalf("%s: affected=%v want=%v (%s)", tc.text, hit, tc.want, why)
		}
	}
}

func TestManagerWholeParameterReadIsTracked(t *testing.T) {
	old := []byte("mw_instances: {pg: {params: {port: 5432}}, pg-ha: {params: {port: 8008}}}\n")
	now := []byte("mw_instances: {pg: {params: {port: 5432}}, pg-ha: {params: {port: 8009}}}\n")
	binding := "mw: \"{{ mw_instances['pg'] }}\"\nmw_manager: \"{{ mw_instances['pg-ha'] }}\"\n"
	for _, tc := range []struct {
		text string
		want bool
	}{
		{"{{ mw_manager.params | to_json }}", true},
		{"{{ mw.params | to_json }}", false},
	} {
		if hit, why := varsReach(old, now, one(binding+tc.text)); hit != tc.want {
			t.Fatalf("%s: %v (%s)", tc.text, hit, why)
		}
	}
}

func TestLiteralServiceNameIsNotAnInstanceRead(t *testing.T) {
	old := []byte("mw_instances:\n  pg:\n    params: {max_connections: 200}\n")
	now := []byte("mw_instances:\n  pg:\n    params: {max_connections: 800}\n")
	texts := one("mw: '{{ mw_instances[''pg''] }}'\nunit: '{{ ''mw-postgresql-'' ~ pg_scope }}'")
	if hit, why := varsReach(old, now, texts); hit {
		t.Fatal(why)
	}
	if !chainUsed("{{ mw-other }}", "mw") {
		t.Fatal("subtraction still consumes whole object")
	}
}

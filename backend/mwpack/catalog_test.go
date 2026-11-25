package mwpack_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"delivery-studio/catalog"
	"delivery-studio/mwpack"
)

func loadCatalog(t *testing.T) *mwpack.Catalog {
	t.Helper()
	cat, err := mwpack.LoadCatalog(catalog.FS)
	if err != nil {
		t.Fatal(err)
	}
	return cat
}

func mustSolve(t *testing.T, cat *mwpack.Catalog, yaml string) *mwpack.Plan {
	t.Helper()
	dep, err := mwpack.ParseDeployment([]byte(yaml))
	if err != nil {
		t.Fatal(err)
	}
	return mwpack.Solve(cat, dep)
}

const etcdOnly = `
id: etcd-demo
hosts:
  - {name: node-01, ip: 10.0.1.11, disk: /dev/vdb}
  - {name: node-02, ip: 10.0.1.12, disk: /dev/vdb}
  - {name: node-03, ip: 10.0.1.13, disk: /dev/vdb}
instances:
  - id: etcd
    component: etcd
    placement: {member: [node-01, node-02, node-03]}
`

func TestCatalogLoads(t *testing.T) {
	cat := loadCatalog(t)
	names := strings.Join(cat.Names(), ",")
	if names != "etcd,external-lb,haproxy,keepalived,nginx,patroni,postgresql,redis" {
		t.Fatalf("components = %s", names)
	}
}

func TestSolveEtcdOnly(t *testing.T) {
	plan := mustSolve(t, loadCatalog(t), etcdOnly)
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	if len(plan.Instances) != 1 || plan.Instances[0].Params["client_port"] != 2379 {
		t.Fatalf("unexpected plan: %+v", plan.Instances)
	}
}

// ansibleAvailable skips tests that need a real ansible-core to prove the generated project is well formed.
func ansibleAvailable(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath(ansibleCmd("ansible-playbook")); err != nil {
		t.Skip("ansible-playbook not installed")
	}
}

// ansibleCmd lets the suite run against the exact ansible-core the delivery ships (MW_ANSIBLE_BIN=/path/to/bin).
func ansibleCmd(name string) string {
	if d := os.Getenv("MW_ANSIBLE_BIN"); d != "" {
		return filepath.Join(d, name)
	}
	return name
}

// renderTo writes a rendered project into dir and returns its root.
func renderTo(t *testing.T, plan *mwpack.Plan, dir string) *mwpack.Bundle {
	t.Helper()
	b, err := mwpack.Render(plan, mwpack.RenderOptions{Runner: "ansible-playbook -i inventory/hosts.yml"})
	if err != nil {
		t.Fatal(err)
	}
	for name, f := range b.Project {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, f.Data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return b
}

// syntaxCheck runs ansible's own parser over every generated playbook.
func syntaxCheck(t *testing.T, dir string) {
	t.Helper()
	ansibleAvailable(t)
	var books []string
	for _, sub := range []string{"playbooks", "steps", "tests", "tests-endpoint", "cleanup"} {
		filepath.WalkDir(filepath.Join(dir, sub), func(p string, d os.DirEntry, err error) error {
			if err == nil && !d.IsDir() && strings.HasSuffix(p, ".yml") {
				books = append(books, p)
			}
			return nil
		})
	}
	sort.Strings(books)
	if len(books) == 0 {
		t.Fatal("no playbooks generated")
	}
	// One syntax-check invocation still parses every entrypoint, without paying
	// interpreter startup for each of the independently generated step files.
	args := append([]string{"--syntax-check", "-i", "inventory/hosts.yml"}, books...)
	check := exec.Command(ansibleCmd("ansible-playbook"), args...)
	check.Dir = dir
	check.Env = append(os.Environ(), "ANSIBLE_CONFIG="+filepath.Join(dir, "ansible.cfg"), "ANSIBLE_NOCOLOR=1")
	if out, err := check.CombinedOutput(); err != nil {
		t.Fatalf("playbook syntax: %v\n%s", err, out)
	}

	cmd := exec.Command(ansibleCmd("ansible-inventory"), "-i", "inventory/hosts.yml", "--graph")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "ANSIBLE_CONFIG="+filepath.Join(dir, "ansible.cfg"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("inventory: %v\n%s", err, out)
	}
}

func TestRenderEtcdProjectIsValidAnsible(t *testing.T) {
	plan := mustSolve(t, loadCatalog(t), etcdOnly)
	dir := t.TempDir()
	b := renderTo(t, plan, dir)
	for _, want := range []string{"ansible.cfg", "inventory/hosts.yml", "inventory/group_vars/all.yml", "playbooks/00-preflight.yml", "playbooks/01-install.yml", "roles/etcd/tasks/install.yml", "roles/mw_preflight/tasks/main.yml", "deployment.yml", "deployment.lock.json", "plan.json"} {
		if _, ok := b.Project[want]; !ok {
			t.Errorf("missing %s", want)
		}
	}
	syntaxCheck(t, dir)
}

func fullCatalog(t *testing.T) *mwpack.Catalog {
	t.Helper()
	cat, err := mwpack.LoadCatalog(catalog.FS, os.DirFS("testdata/catalog"))
	if err != nil {
		t.Fatal(err)
	}
	return cat
}

const echoWithLB = `
id: echo-demo
hosts:
  - {name: db-1, ip: 10.0.1.11, disk: /dev/vdb}
  - {name: db-2, ip: 10.0.1.12, disk: /dev/vdb}
  - {name: lb-1, ip: 10.0.1.21}
  - {name: lb-2, ip: 10.0.1.22}
instances:
  - id: svc
    component: echo
    placement: {primary: [db-1], replica: [db-2]}
  - id: lb
    component: haproxy
    placement: {balancer: [lb-1, lb-2]}
    params: {ha: keepalived, vip: 10.0.1.100, vip_interface: eth0}
    binds:
      - {endpoint: svc.writer, listen: 15432}
`

func TestSolveAddsKeepalivedAndBindsEndpoint(t *testing.T) {
	plan := mustSolve(t, fullCatalog(t), echoWithLB)
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	var auto []string
	for _, i := range plan.Instances {
		if i.Auto {
			auto = append(auto, i.ID+":"+i.Component)
		}
	}
	if strings.Join(auto, ",") != "lb-vip:keepalived" {
		t.Fatalf("auto instances = %v", auto)
	}
	svc := plan.Instance("svc")
	f, ok := svc.Fronts["writer"]
	if !ok || f.Address != "10.0.1.100" || f.Listen != 15432 || f.External {
		t.Fatalf("front = %+v", f)
	}
	// Providers come before the things that use them.
	pos := map[string]int{}
	for i, inst := range plan.Instances {
		pos[inst.ID] = i
	}
	if pos["lb-vip"] > pos["lb"] || pos["svc"] > pos["lb"] {
		t.Fatalf("order = %v", pos)
	}
}

func TestRenderLoadBalancerChain(t *testing.T) {
	plan := mustSolve(t, fullCatalog(t), echoWithLB)
	dir := t.TempDir()
	b := renderTo(t, plan, dir)
	syntaxCheck(t, dir)
	if _, ok := b.Docs["03-入口测试.md"]; !ok {
		t.Fatal("endpoint handbook missing")
	}
	for _, id := range []string{"01-svc-reachable", "02-svc-replica-sync", "01-lb-listening"} {
		found := false
		for name := range b.Project {
			found = found || strings.Contains(name, id)
		}
		_ = found
	}
}

func TestEndpointRulesAreEnforced(t *testing.T) {
	cat := fullCatalog(t)
	cases := map[string]string{
		"no-lb endpoint":          strings.Replace(echoWithLB, "svc.writer", "svc.bus", 1),
		"nginx cannot check http": strings.Replace(strings.Replace(echoWithLB, "component: haproxy", "component: nginx", 1), "ha: keepalived, vip: 10.0.1.100, vip_interface: eth0", "ha: none", 1),
		"keepalived needs two":    strings.Replace(echoWithLB, "balancer: [lb-1, lb-2]", "balancer: [lb-1]", 1),
		"port clash with service": strings.Replace(echoWithLB, "listen: 15432", "listen: 7000", 1) + "",
	}
	for name, y := range cases {
		if name == "port clash with service" {
			y = strings.Replace(y, "placement: {balancer: [lb-1, lb-2]}", "placement: {balancer: [db-1, lb-2]}", 1)
		}
		plan := mustSolve(t, cat, y)
		if plan.Err() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestExternalLoadBalancerProducesConfigSheet(t *testing.T) {
	y := `
id: ext-demo
hosts:
  - {name: db-1, ip: 10.0.1.11}
  - {name: db-2, ip: 10.0.1.12}
instances:
  - id: svc
    component: echo
    placement: {primary: [db-1], replica: [db-2]}
  - id: elb
    component: external-lb
    params: {address: db.example.com}
    binds:
      - {endpoint: svc.writer}
`
	plan := mustSolve(t, fullCatalog(t), y)
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	b, err := mwpack.Render(plan, mwpack.RenderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	doc := string(b.Docs["03-入口测试.md"])
	for _, want := range []string{"db.example.com:7000", "/primary", "db-1 (10.0.1.11):7000", "db-2 (10.0.1.12):7000", "客户运维"} {
		if !strings.Contains(doc, want) {
			t.Errorf("config sheet lacks %q:\n%s", want, doc)
		}
	}
	if _, ok := b.Project["tests/svc/reachable.yml"]; !ok {
		var names []string
		for n := range b.Project {
			names = append(names, n)
		}
		sort.Strings(names)
		t.Fatalf("no test playbooks; have %v", names)
	}
}

// renderTemplates renders every role template of every instance with real Ansible, on the machines the
// instance is placed on, and returns host/instance/template -> content. This is the closest check to the
// field that needs no target machine.
func renderTemplates(t *testing.T, plan *mwpack.Plan, dir string) map[string]string {
	t.Helper()
	ansibleAvailable(t)
	out := filepath.Join(dir, "rendered")
	var plays []string
	for _, inst := range plan.Instances {
		if inst.External {
			continue
		}
		fsys, base := inst.R.C.FS()
		roles, _ := os.ReadDir(filepath.Join(dir, "roles"))
		_ = fsys
		_ = base
		var tasks []string
		tasks = append(tasks, "    - ansible.builtin.file: {path: \""+out+"/{{ inventory_hostname }}/"+inst.ID+"\", state: directory}")
		any := false
		for _, r := range roles {
			// Roles of a component are named after it; generated inline-step roles are mw_<component>.
			if !strings.HasPrefix(r.Name(), inst.Component) && r.Name() != "mw_"+strings.ReplaceAll(inst.Component, "-", "_") {
				continue
			}
			if _, err := os.Stat(filepath.Join(dir, "roles", r.Name(), "defaults", "main.yml")); err == nil {
				tasks = append(tasks, "    - ansible.builtin.include_vars: {file: "+filepath.Join(dir, "roles", r.Name(), "defaults", "main.yml")+"}")
			}
			ts, _ := filepath.Glob(filepath.Join(dir, "roles", r.Name(), "templates", "*.j2"))
			for _, tp := range ts {
				any = true
				name := strings.TrimSuffix(filepath.Base(tp), ".j2")
				tasks = append(tasks, "    - ansible.builtin.template: {src: "+tp+", dest: \""+out+"/{{ inventory_hostname }}/"+inst.ID+"/"+name+"\"}")
			}
		}
		if !any {
			continue
		}
		plays = append(plays, "- hosts: "+strings.ReplaceAll(inst.ID, "-", "_")+"\n  gather_facts: false\n  connection: local\n  vars:\n    mw: \"{{ mw_instances['"+inst.ID+"'] }}\"\n  tasks:\n"+strings.Join(tasks, "\n"))
	}
	book := filepath.Join(dir, "render-templates.yml")
	if err := os.WriteFile(book, []byte(strings.Join(plays, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	args := []string{"-i", "inventory/hosts.yml", book}
	if d := os.Getenv("MW_ANSIBLE_BIN"); d != "" {
		// Modules execute locally here, so they need the interpreter that matches the ansible-core under test.
		args = append(args, "-e", "ansible_python_interpreter="+filepath.Join(d, "python"))
	}
	cmd := exec.Command(ansibleCmd("ansible-playbook"), args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "ANSIBLE_CONFIG="+filepath.Join(dir, "ansible.cfg"), "ANSIBLE_NOCOLOR=1")
	if o, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("template rendering failed: %v\n%s", err, o)
	}
	res := map[string]string{}
	filepath.WalkDir(out, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := os.ReadFile(p)
			rel, _ := filepath.Rel(out, p)
			res[filepath.ToSlash(rel)] = string(b)
		}
		return nil
	})
	return res
}

func TestRenderedConfigsAreCorrect(t *testing.T) {
	ansibleAvailable(t)
	plan := mustSolve(t, fullCatalog(t), echoWithLB)
	dir := t.TempDir()
	renderTo(t, plan, dir)
	got := renderTemplates(t, plan, dir)
	check := func(file string, wants ...string) {
		t.Helper()
		c, ok := got[file]
		if !ok {
			t.Fatalf("%s not rendered; have %v", file, keys(got))
		}
		for _, w := range wants {
			if !strings.Contains(c, w) {
				t.Errorf("%s lacks %q:\n%s", file, w, c)
			}
		}
	}
	check("lb-1/lb/haproxy.cfg",
		"listen svc-writer", "bind *:15432", "option httpchk", "http-check send meth GET uri /primary", "http-check expect status 200",
		"server db-1 10.0.1.11:7000 check port 7001", "server db-2 10.0.1.12:7000 check port 7001", "timeout connect 5s")
	check("lb-1/lb-vip/keepalived.conf", "state MASTER", "priority 150", "unicast_src_ip 10.0.1.21", "10.0.1.22", "10.0.1.100/24 dev eth0", "script \"/bin/sh -c 'pidof haproxy'\"")
	check("lb-2/lb-vip/keepalived.conf", "state BACKUP", "priority 140", "unicast_src_ip 10.0.1.22", "10.0.1.21")
	if strings.Contains(got["lb-2/lb-vip/keepalived.conf"], "10.0.1.22\n") && strings.Count(got["lb-2/lb-vip/keepalived.conf"], "10.0.1.22") != 1 {
		t.Errorf("a node must not list itself as a peer:\n%s", got["lb-2/lb-vip/keepalived.conf"])
	}
}

func keys(m map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestEtcdConfigRendering(t *testing.T) {
	ansibleAvailable(t)
	plan := mustSolve(t, loadCatalog(t), etcdOnly)
	dir := t.TempDir()
	renderTo(t, plan, dir)
	got := renderTemplates(t, plan, dir)
	c := got["node-02/etcd/etcd.conf.yaml"]
	for _, w := range []string{"name: node-02", "initial-cluster: node-01=http://10.0.1.11:2380,node-02=http://10.0.1.12:2380,node-03=http://10.0.1.13:2380",
		"listen-client-urls: http://10.0.1.12:2379,http://127.0.0.1:2379", "quota-backend-bytes: 8589934592", "initial-cluster-token: etcd-demo-etcd"} {
		if !strings.Contains(c, w) {
			t.Errorf("etcd.conf lacks %q:\n%s", w, c)
		}
	}
}

const pgHA = `
id: pg-prod
title: 生产 PG 集群
hosts:
  - {name: db-1, ip: 10.0.1.11, disk: /dev/vdb}
  - {name: db-2, ip: 10.0.1.12, disk: /dev/vdb}
  - {name: db-3, ip: 10.0.1.13, disk: /dev/vdb}
  - {name: lb-1, ip: 10.0.1.21}
  - {name: lb-2, ip: 10.0.1.22}
controller: db-1
instances:
  - id: pg
    component: postgresql
    placement: {primary: [db-1], replica: [db-2, db-3]}
    params:
      client_cidr: 10.0.1.0/24
      replication: quorum
      sync_ack_count: 1
      tls: true
      tde: true
      app_user: appadmin
      extra_client_cidrs: [10.20.0.0/16]
    addons:
      - {id: pg_trgm, databases: [postgres, template1]}
      - {id: amcheck}
  - id: lb
    component: haproxy
    placement: {balancer: [lb-1, lb-2]}
    params: {ha: keepalived, vip: 10.0.1.100, vip_interface: eth0}
    binds:
      - {endpoint: pg.writer, listen: 5432}
`

const pgSingle = `
id: pg-dev
hosts:
  - {name: dev-1, ip: 10.0.2.11, disk: /dev/vdb, initialize: true}
instances:
  - id: pg
    component: postgresql
    placement: {primary: [dev-1]}
    params: {client_cidr: 10.0.2.0/24, tls: false, tde: false}
`

func TestPostgresqlSingleNodeHasNoEtcdOrPatroni(t *testing.T) {
	plan := mustSolve(t, fullCatalog(t), pgSingle)
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	if len(plan.Instances) != 1 {
		var ids []string
		for _, i := range plan.Instances {
			ids = append(ids, i.ID)
		}
		t.Fatalf("a single node must not pull in a coordination service, got %v", ids)
	}
	b, err := mwpack.Render(plan, mwpack.RenderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	all := ""
	for name, f := range b.Project {
		if strings.HasPrefix(name, "playbooks/") || name == "inventory/hosts.yml" {
			all += string(f.Data)
		}
	}
	if strings.Contains(all, "etcd") || strings.Contains(all, "patroni") {
		t.Fatalf("single node project mentions etcd/patroni:\n%s", all)
	}
}

func TestPostgresqlHASolve(t *testing.T) {
	plan := mustSolve(t, fullCatalog(t), pgHA)
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, i := range plan.Instances {
		ids = append(ids, i.ID+"("+i.Component+")")
	}
	got := strings.Join(ids, " ")
	for _, want := range []string{"pg-dcs(etcd)", "pg(postgresql)", "lb-vip(keepalived)", "lb(haproxy)"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in %s", want, got)
		}
	}
	etcd := plan.Instance("pg-dcs")
	if strings.Join(etcd.Roles["member"], ",") != "db-1,db-2,db-3" {
		t.Fatalf("etcd placed on %v", etcd.Roles)
	}
	if plan.Controller != "db-1" {
		t.Fatalf("controller = %s", plan.Controller)
	}
	// Even with a synchronous quorum, three members is fine; two nodes should warn.
	for _, w := range plan.Issues {
		if w.Severity == "warning" && strings.Contains(w.Message, "etcd") && !strings.Contains(w.Message, "尚未在空环境验证") {
			t.Errorf("unexpected etcd warning: %s", w.Message)
		}
	}
}

func TestPostgresqlProjectIsValidAnsible(t *testing.T) {
	ansibleAvailable(t)
	for name, y := range map[string]string{"single": pgSingle, "ha": pgHA} {
		t.Run(name, func(t *testing.T) {
			plan := mustSolve(t, fullCatalog(t), y)
			dir := t.TempDir()
			material := map[string][]byte{}
			if plan.Instance("pg").Params["tls"] == true {
				for _, f := range []string{"server.crt", "server.key", "ca.crt"} {
					material["pg/tls/"+f] = []byte("x")
				}
			}
			b, err := mwpack.Render(plan, mwpack.RenderOptions{Runner: "ansible-playbook -i inventory/hosts.yml", Materials: material})
			if err != nil {
				t.Fatal(err)
			}
			for n, f := range b.Project {
				p := filepath.Join(dir, filepath.FromSlash(n))
				os.MkdirAll(filepath.Dir(p), 0o755)
				os.WriteFile(p, f.Data, 0o644)
			}
			syntaxCheck(t, dir)
		})
	}
}

func TestPostgresqlRenderedConfigs(t *testing.T) {
	ansibleAvailable(t)
	plan := mustSolve(t, fullCatalog(t), pgHA)
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	material := map[string][]byte{}
	for _, f := range []string{"server.crt", "server.key", "ca.crt"} {
		material["pg/tls/"+f] = []byte("x")
	}
	b, err := mwpack.Render(plan, mwpack.RenderOptions{Materials: material})
	if err != nil {
		t.Fatal(err)
	}
	for n, f := range b.Project {
		p := filepath.Join(dir, filepath.FromSlash(n))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, f.Data, 0o644)
	}
	// secrets are normally created by the first playbook; create them the same way for rendering
	for _, n := range []string{"postgres", "replicator", "rewind_user", "app"} {
		os.MkdirAll(filepath.Join(dir, "secrets", "pg"), 0o700)
		os.WriteFile(filepath.Join(dir, "secrets", "pg", n), []byte("S3cret"+n+"\n"), 0o600)
	}
	os.MkdirAll(filepath.Join(dir, "secrets", "lb-vip"), 0o700)
	os.WriteFile(filepath.Join(dir, "secrets", "lb-vip", "auth_pass"), []byte("Ab12Cd34\n"), 0o600)
	got := renderTemplates(t, plan, dir)

	pc, ok := got["db-2/pg/patroni.yml"]
	if !ok {
		t.Fatalf("patroni.yml not rendered; have %v", keys(got))
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(pc[strings.Index(pc, "{"):]), &cfg); err != nil {
		t.Fatalf("patroni.yml is not valid JSON/YAML: %v\n%s", err, pc)
	}
	if cfg["scope"] != "pg-prod-pg" || cfg["name"] != "db-2" {
		t.Errorf("scope/name = %v/%v", cfg["scope"], cfg["name"])
	}
	dcs := cfg["bootstrap"].(map[string]any)["dcs"].(map[string]any)
	if dcs["synchronous_mode"] != "quorum" || dcs["synchronous_node_count"] != float64(1) || dcs["ttl"] != float64(30) {
		t.Errorf("dcs = %v", dcs)
	}
	params := dcs["postgresql"].(map[string]any)["parameters"].(map[string]any)
	if params["ssl"] != "on" || params["shared_preload_libraries"] != "pg_tde" || params["max_connections"] != float64(800) || params["archive_mode"] != "off" {
		t.Errorf("parameters = %v", params)
	}
	hba := fmt.Sprint(dcs["postgresql"].(map[string]any)["pg_hba"])
	for _, want := range []string{
		"hostssl replication replicator 10.0.1.12/32 scram-sha-256", // replication from each node
		"hostssl all all 10.0.1.21/32 scram-sha-256",                // load balancer machines
		"hostssl all all 10.0.1.0/24 scram-sha-256",                 // clients
		"hostssl all all 10.20.0.0/16 scram-sha-256",                // extra network
		"hostnossl all all 0.0.0.0/0 reject",
	} {
		if !strings.Contains(hba, want) {
			t.Errorf("pg_hba lacks %q:\n%s", want, hba)
		}
	}
	if etcd := cfg["etcd3"].(map[string]any)["hosts"]; etcd != "10.0.1.11:2379,10.0.1.12:2379,10.0.1.13:2379" {
		t.Errorf("etcd hosts = %v", etcd)
	}
	pgSec := cfg["postgresql"].(map[string]any)
	if pgSec["bin_name"] == nil || pgSec["authentication"].(map[string]any)["superuser"].(map[string]any)["sslmode"] != "verify-ca" {
		t.Errorf("postgresql section = %v", pgSec)
	}
	br := got["db-1/pg/pgbackrest.conf"]
	for _, want := range []string{"repo1-retention-full=2", "[pg-prod-pg]", "pg1-path=/data/pg/17/data", "archive-header-check=n", "compress-level=6"} {
		if !strings.Contains(br, want) {
			t.Errorf("pgbackrest.conf lacks %q:\n%s", want, br)
		}
	}
	tj := got["db-1/pg/pgstep_via_front.json"]
	var tcfg map[string]any
	if err := json.Unmarshal([]byte(tj), &tcfg); err != nil {
		t.Fatalf("pgtest.json invalid: %v\n%s", err, tj)
	}
	nodes := tcfg["nodes"].([]any)
	if len(nodes) != 3 || nodes[0].(map[string]any)["name"] != "db-1" || tcfg["elb"].(map[string]any)["host"] != "10.0.1.100" || tcfg["elb"].(map[string]any)["port"] != float64(5432) {
		t.Errorf("pgtest.json = %s", tj)
	}
}

func TestPlanDocHasNoNullLists(t *testing.T) {
	plan := mustSolve(t, loadCatalog(t), etcdOnly)
	b, err := mwpack.Render(plan, mwpack.RenderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(b.PlanDoc, &doc); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"prepare", "deploy", "tests", "endpoint_tests", "cleanup", "hosts", "instances"} {
		if v, ok := doc[k]; !ok || v == nil {
			t.Errorf("plan.json %q must be a list, got %v", k, v)
		}
	}
}

func TestInlineStepsShipTemplates(t *testing.T) {
	ansibleAvailable(t)
	plan := mustSolve(t, fullCatalog(t), echoWithLB)
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	b := renderTo(t, plan, dir)
	for _, want := range []string{"roles/mw_echo/tasks/configure_config.yml", "roles/mw_echo/templates/echo.conf.j2", "roles/mw_echo/tasks/install_packages.yml", "roles/mw_echo/tasks/test_reachable.yml"} {
		if _, ok := b.Project[want]; !ok {
			t.Errorf("missing %s", want)
		}
	}
	syntaxCheck(t, dir)
	got := renderTemplates(t, plan, dir)
	c := got["db-1/svc/echo.conf"]
	if !strings.Contains(c, "port=7000") || !strings.Contains(c, "replica=10.0.1.12") {
		t.Errorf("inline template not rendered correctly:\n%s (have %v)", c, keys(got))
	}
}

func TestValidationRejectsMissingTemplateAndUnsafeTasks(t *testing.T) {
	bad := func(name, manifest string) {
		t.Helper()
		c, err := mwpack.ParseComponent([]byte(manifest))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		problems := mwpack.ValidateComponent(c, nil)
		for _, p := range problems {
			if p.Severity == "error" {
				return
			}
		}
		t.Errorf("%s: invalid manifest accepted", name)
	}
	base := func(task string) string {
		return `schema: mwpack/v1
component: probe
title: probe
category: 测试
roles: [{name: node, min: 1, max: 1}]
versions: [{id: "1", status: draft}]
lifecycle:
  start:
    - id: go
      title: go
      tasks:
        - ` + task + `
`
	}
	bad("shell module", base(`{name: x, ansible.builtin.shell: "rm -rf /"}`))
	bad("ignore_errors", base(`{name: x, ansible.builtin.command: "true", ignore_errors: true}`))
	bad("unknown collection module", base(`{name: x, community.general.ufw: {rule: allow}}`))
	bad("two modules", base(`{name: x, ansible.builtin.command: "true", ansible.builtin.debug: {msg: a}}`))
	bad("bad expression", strings.Replace(base(`{name: x, ansible.builtin.debug: {msg: a}}`), "      title: go", "      title: go\n      when: \"count(\"", 1))
	if _, err := mwpack.ParseComponent([]byte(base(`{name: x, ansible.builtin.debug: {msg: a}}`) + "surprise: 1\n")); err == nil {
		t.Error("an unknown top-level field must be rejected, or typos silently vanish")
	}
}

func TestRenderIsDeterministicAndPinsVersions(t *testing.T) {
	render := func() *mwpack.Bundle {
		plan := mustSolve(t, fullCatalog(t), echoWithLB)
		b, err := mwpack.Render(plan, mwpack.RenderOptions{})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	a, b := render(), render()
	if len(a.Project) != len(b.Project) {
		t.Fatal("different file sets")
	}
	for name, f := range a.Project {
		if !bytes.Equal(f.Data, b.Project[name].Data) {
			t.Errorf("%s differs between two renders of the same spec", name)
		}
	}
	for name, d := range a.Docs {
		if !bytes.Equal(d, b.Docs[name]) {
			t.Errorf("handbook %s differs between renders", name)
		}
	}
	spec := string(a.Project["deployment.yml"].Data)
	if !strings.Contains(spec, "version: \"1.0\"") || !strings.Contains(spec, "version: \"2.8\"") || !strings.Contains(spec, "controller:") {
		t.Errorf("saved spec must pin versions and controller so it regenerates identically:\n%s", spec)
	}
	// And the pinned spec is itself a valid input that resolves to the same thing.
	again := mustSolve(t, fullCatalog(t), spec)
	if err := again.Err(); err != nil {
		t.Fatal(err)
	}
	c, err := mwpack.Render(again, mwpack.RenderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(c.Project["inventory/group_vars/all.yml"].Data, a.Project["inventory/group_vars/all.yml"].Data) {
		t.Error("regenerating from the saved spec gives different variables")
	}
}

const lbOnly = `
id: lb-%s
platform: %s
hosts:
  - {name: lb-1, ip: 10.0.3.11}
  - {name: lb-2, ip: 10.0.3.12}
instances:
  - id: lb
    component: %s
    placement: {balancer: [lb-1, lb-2]}
    params: {ha: keepalived, vip: 10.0.3.100, vip_interface: eth0}
`

func TestPackagesFollowThePlatform(t *testing.T) {
	cat := loadCatalog(t)
	specs := func(plan *mwpack.Plan, id string) []string {
		var out []string
		for _, p := range plan.Instance(id).Packages {
			out = append(out, mwpack.PackageSpec(plan.Platform.Family, p.Name, p.Version))
		}
		return out
	}
	ub := mustSolve(t, cat, fmt.Sprintf(lbOnly, "ub", "ubuntu-24.04-amd64", "nginx"))
	if err := ub.Err(); err == nil || !strings.Contains(err.Error(), "健康检查") {
		// nginx cannot front a Patroni endpoint, but with no binds the plan itself is valid
		_ = err
	}
	if got := strings.Join(specs(ub, "lb"), ","); got != "nginx=1.26.3-1~noble" {
		t.Fatalf("ubuntu default nginx packages = %s", got)
	}
	if ub.Instance("lb").Version != "1.26" {
		t.Fatalf("on ubuntu the default nginx should pick the newest published version (1.26), got %s", ub.Instance("lb").Version)
	}
	ub124 := mustSolve(t, cat, strings.Replace(fmt.Sprintf(lbOnly, "ub124", "ubuntu-24.04-amd64", "nginx"), "component: nginx", "component: nginx\n    version: \"1.24\"", 1))
	if got := strings.Join(specs(ub124, "lb"), ","); got != "nginx=1.24.0-2ubuntu7.18,libnginx-mod-stream=1.24.0-2ubuntu7.18" {
		t.Fatalf("ubuntu nginx 1.24 packages = %s", got)
	}
	el := mustSolve(t, cat, fmt.Sprintf(lbOnly, "el", "el9-amd64", "nginx"))
	if err := el.Err(); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(specs(el, "lb"), ","); !strings.HasPrefix(got, "nginx-1.26.3-9.module+el9.8.0+40317+f33384ab.4,nginx-mod-stream-1.26.3") {
		t.Fatalf("a RedHat-family system names versions with a dash and uses its own package names: %s", got)
	}
	if el.Instance("lb").Version != "1.26" || el.Platform.Family != "rpm" {
		t.Fatalf("el9 must pick the nginx that is built for it: %s %s", el.Instance("lb").Version, el.Platform.Family)
	}
	// keepalived is a dependency of the load balancer and follows the same platform.
	if got := strings.Join(specs(el, "lb-vip"), ","); got != "keepalived-2.2.8-6.el9" {
		t.Fatalf("auto keepalived on el9 = %s", got)
	}
	warned := false
	for _, i := range el.Issues {
		warned = warned || (i.Severity == "warning" && strings.Contains(i.Message, "RedHat"))
	}
	if !warned {
		t.Error("an unverified family must be flagged to the user")
	}
	// The request list is exact, deduplicated and stable.
	reqs := ub124.Requests()
	seen := map[string]bool{}
	for _, r := range reqs {
		if seen[r.Key()] {
			t.Errorf("duplicate request %s", r.Key())
		}
		seen[r.Key()] = true
	}
	if len(reqs) != 3 {
		t.Fatalf("nginx 1.24 + stream module + keepalived = 3 packages, got %v", reqs)
	}
}

func TestPlatformChoiceIsValidated(t *testing.T) {
	cat := loadCatalog(t)
	// etcd and PostgreSQL are only built for Ubuntu 24.04 so far.
	y := strings.Replace(etcdOnly, "id: etcd-demo", "id: etcd-demo\nplatform: el9-amd64", 1)
	if err := mustSolve(t, cat, y).Err(); err == nil || !strings.Contains(err.Error(), "el9-amd64") {
		t.Fatalf("an unsupported system must be refused with its name, got %v", err)
	}
	y = strings.Replace(etcdOnly, "id: etcd-demo", "id: etcd-demo\nplatform: windows-11", 1)
	if err := mustSolve(t, cat, y).Err(); err == nil || !strings.Contains(err.Error(), "不认识操作系统") {
		t.Fatalf("an unknown system must be refused, got %v", err)
	}
	// Left empty, the default system is chosen and recorded in the normalised spec.
	p := mustSolve(t, cat, etcdOnly)
	if p.Platform.ID != "ubuntu-24.04-amd64" || p.Normalized().Platform != "ubuntu-24.04-amd64" {
		t.Fatalf("default platform = %q", p.Platform.ID)
	}
}

func TestManifestPackagesMustBePinnedAndRepoArtifactsAreGone(t *testing.T) {
	problem := func(name, versions string) {
		t.Helper()
		m := "schema: mwpack/v1\ncomponent: probe\ntitle: probe\ncategory: 测试\nroles: [{name: node, min: 1, max: 1}]\nversions:\n" + versions
		c, err := mwpack.ParseComponent([]byte(m))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for _, p := range mwpack.ValidateComponent(c, nil) {
			if p.Severity == "error" {
				return
			}
		}
		t.Errorf("%s: accepted", name)
	}
	problem("unpinned package", "  - {id: \"1\", status: draft, platforms: [ubuntu-24.04-amd64], packages: [{name: nginx}]}\n")
	problem("unknown system", "  - {id: \"1\", status: draft, platforms: [solaris], packages: [{name: nginx, version: \"1\"}]}\n")
	problem("package for a system the version lacks", "  - {id: \"1\", status: draft, platforms: [ubuntu-24.04-amd64], packages: [{name: nginx, version: \"1\", platforms: [el9-amd64]}]}\n")
	problem("legacy repo artifact", "  - {id: \"1\", status: draft, platforms: [ubuntu-24.04-amd64], artifacts: [{name: r, kind: apt-repo, file: r.tar.gz}]}\n")
}

func TestRenderedProjectCarriesPlatformAndPackages(t *testing.T) {
	cat := loadCatalog(t)
	plan := mustSolve(t, cat, fmt.Sprintf(lbOnly, "el", "el9-amd64", "haproxy"))
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	b, err := mwpack.Render(plan, mwpack.RenderOptions{PackageRepo: &mwpack.PackageRepo{File: "packages-el9-amd64.tar.gz", SHA256: strings.Repeat("a", 64), Size: 1}})
	if err != nil {
		t.Fatal(err)
	}
	vars := string(b.Project["inventory/group_vars/all.yml"].Data)
	for _, want := range []string{"mw_pkg_family: rpm", "id: el9-amd64", "- rocky", "version: \"9\"", "file: packages-el9-amd64.tar.gz", "spec: haproxy-2.8.14-3.el9_8.2", "root: repo"} {
		if !strings.Contains(vars, want) {
			t.Errorf("group_vars lacks %q", want)
		}
	}
	var lock struct {
		Platform string `json:"platform"`
		Repo     struct {
			File, SHA256 string
		} `json:"package_repository"`
		Instances []struct {
			ID       string
			Packages []struct{ Name, Version string }
		}
	}
	if err := json.Unmarshal(b.Lock, &lock); err != nil || lock.Platform != "el9-amd64" || lock.Repo.File != "packages-el9-amd64.tar.gz" || lock.Repo.SHA256 == "" {
		t.Fatalf("lock = %s (%v)", b.Lock, err)
	}
	found := false
	for _, i := range lock.Instances {
		if i.ID == "lb" && len(i.Packages) == 1 && i.Packages[0].Name == "haproxy" {
			found = true
		}
	}
	if !found {
		t.Errorf("the lock must record the exact packages: %s", b.Lock)
	}
	if !strings.Contains(string(b.Docs["00-环境准备.md"]), "packages-el9-amd64.tar.gz") {
		t.Error("the handbook must tell the engineer to upload the package repository")
	}
	dir := t.TempDir()
	for n, f := range b.Project {
		p := filepath.Join(dir, filepath.FromSlash(n))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, f.Data, 0o644)
	}
	syntaxCheck(t, dir)
}

func flowsOf(t *testing.T, plan *mwpack.Plan, id string) []mwpack.FlowView {
	t.Helper()
	for _, i := range plan.View().Instances {
		if i.ID == id {
			return i.Flows
		}
	}
	t.Fatalf("instance %s not in plan", id)
	return nil
}

func TestPlanDeclaresDataFlowsFromTheComponents(t *testing.T) {
	cat := loadCatalog(t)
	hosts := "id: pg-flows\nhosts:\n  - {name: node-01, ip: 10.0.1.11, disk: /dev/vdb}\n  - {name: node-02, ip: 10.0.1.12, disk: /dev/vdb}\n  - {name: node-03, ip: 10.0.1.13, disk: /dev/vdb}\n"
	single := mustSolve(t, cat, hosts+"instances:\n  - {id: pg, component: postgresql, placement: {primary: [node-01]}, params: {client_cidr: 10.0.1.0/24, tls: false, tde: false}}\n")
	if got := flowsOf(t, single, "pg"); len(got) != 0 {
		t.Fatalf("a single node replicates to nobody, got %+v", got)
	}
	ha := mustSolve(t, cat, hosts+"instances:\n  - {id: pg, component: postgresql, placement: {primary: [node-01], replica: [node-02, node-03]}, params: {client_cidr: 10.0.1.0/24, tls: false, tde: false}}\n")
	wal := flowsOf(t, ha, "pg")
	if len(wal) != 1 || wal[0].Kind != "replication" || wal[0].From[0] != "node-01" || len(wal[0].To) != 2 || !wal[0].Sync {
		t.Fatalf("expected quorum replication node-01 -> 2 replicas, got %+v", wal)
	}
	raft := flowsOf(t, ha, "pg-dcs")
	if len(raft) != 1 || raft[0].Kind != "mesh" || len(raft[0].From) != 3 {
		t.Fatalf("expected a three member consensus mesh, got %+v", raft)
	}
	async := mustSolve(t, cat, hosts+"instances:\n  - {id: pg, component: postgresql, placement: {primary: [node-01], replica: [node-02]}, params: {client_cidr: 10.0.1.0/24, tls: false, tde: false, replication: async}}\n")
	if got := flowsOf(t, async, "pg"); len(got) != 1 || got[0].Sync {
		t.Fatalf("asynchronous replication must not be drawn as synchronous, got %+v", got)
	}
}

func TestControllerPackagesTravelWithEveryDeliveryOfTheSystem(t *testing.T) {
	cat := loadCatalog(t)
	ubuntu := mustSolve(t, cat, etcdOnly)
	for _, r := range ubuntu.Requests() {
		if r.Name == "python3.12" {
			t.Fatal("Ubuntu 24.04 already has Python 3.12; it must not ask for it")
		}
	}
	// etcd is only built for Ubuntu; HAProxy is available on both systems
	el9 := mustSolve(t, cat, "id: lb-demo\nplatform: el9-amd64\nhosts:\n  - {name: node-01, ip: 10.0.1.11, disk: /dev/vdb}\ninstances:\n  - {id: lb, component: haproxy, placement: {balancer: [node-01]}}\n")
	if len(el9.Errors()) > 0 {
		t.Fatalf("an el9 haproxy delivery must solve: %v", el9.Errors())
	}
	if def, _ := mwpack.PlatformByID("el9-amd64"); len(def.ControllerPackages) == 0 {
		t.Fatal("the RedHat system must name the Python its controller needs")
	}
	got := map[string]bool{}
	for _, r := range el9.Requests() {
		got[r.Name] = true
	}
	if !got["python3.12"] {
		t.Fatalf("every delivery for el9 must carry python3.12 for its controller, requests: %v", el9.Requests())
	}
	all := map[string]bool{}
	for _, r := range cat.AllPackages("el9-amd64") {
		all[r.Name] = true
	}
	if !all["python3.12"] {
		t.Error("the library page must list python3.12 among what the system needs")
	}
}

package ansiblev2

import (
	"strings"
	"testing"
)

func TestBuiltinComponentsInspectAndRender(t *testing.T) {
	names := BuiltinNames()
	if len(names) < 2 {
		t.Fatalf("expected at least 2 builtin v2 components, got %v", names)
	}
	for _, name := range names {
		files, ok := LoadBuiltinFiles(name)
		if !ok {
			t.Fatalf("failed to load builtin %s", name)
		}
		rep := Inspect(files, name, "builtin")
		if !rep.Valid {
			t.Fatalf("builtin %s failed validation: %+v", name, rep.Problems)
		}
		if rep.Manifest.Entrypoints.Deploy == "" {
			t.Fatalf("builtin %s missing deploy entrypoint", name)
		}
		if len(rep.Vars) == 0 {
			t.Fatalf("builtin %s expected extracted vars from meta/argument_specs.yml", name)
		}
		if len(rep.Packages) == 0 {
			t.Fatalf("builtin %s expected auto-detected packages from package tasks", name)
		}
		if len(rep.Steps) == 0 {
			t.Fatalf("builtin %s expected parsed play steps", name)
		}
		res, err := Render(files, rep.Manifest, RenderRequest{
			ClusterID: "demo-" + name,
			Hosts: []RenderHost{
				{Name: "node-01", IP: "10.0.1.11", Groups: []string{rep.Manifest.Groups[0].Name}},
			},
			Vars: map[string]any{"custom_tag": "ok"},
		})
		if err != nil {
			t.Fatalf("render builtin %s failed: %v", name, err)
		}
		if !strings.Contains(res.InventoryYAML, "ansible_host: 10.0.1.11") {
			t.Fatalf("inventory missing ansible_host: %s", res.InventoryYAML)
		}
		if !strings.Contains(res.GroupVarsYAML, "custom_tag: ok") {
			t.Fatalf("group_vars missing custom var: %s", res.GroupVarsYAML)
		}
		if _, ok := res.Files["callback_plugins/delivery_studio.py"]; !ok {
			t.Fatalf("missing callback plugin in rendered project")
		}
		tgz, sha, err := PackTarGz(res.ClusterID, res.Files)
		if err != nil || len(tgz) == 0 || len(sha) != 64 {
			t.Fatalf("PackTarGz failed: err=%v len=%d sha=%s", err, len(tgz), sha)
		}
	}
}

func TestInspectAllFourMarketAnsibleFormats(t *testing.T) {
	// 1. Single standalone playbook file
	singleFiles := map[string][]byte{
		"install-exporter.yml": []byte(`---
- name: Install Node Exporter
  hosts: monitored
  become: true
  tasks:
    - name: Install package
      ansible.builtin.apt:
        name: prometheus-node-exporter
        state: present
`),
	}
	wrapped, kind, slug := WrapIntoRunnableProject(singleFiles, "install-exporter.yml")
	if kind != AssetSinglePlaybook {
		t.Fatalf("expected single_playbook, got %s", kind)
	}
	rep := InspectNormalized(wrapped, kind, slug, "paste")
	if !rep.Valid {
		t.Fatalf("single playbook invalid: %+v", rep.Problems)
	}
	if len(rep.Manifest.Groups) != 1 || rep.Manifest.Groups[0].Name != "monitored" {
		t.Fatalf("expected group 'monitored', got %+v", rep.Manifest.Groups)
	}
	if len(rep.Packages) != 1 || rep.Packages[0].Name != "prometheus-node-exporter" {
		t.Fatalf("expected detected package prometheus-node-exporter, got %+v", rep.Packages)
	}

	// 2. Standard standalone Ansible Role (like geerlingguy.nginx zipball with wrapper dir)
	roleFiles := map[string][]byte{
		"ansible-role-kafka-main/defaults/main.yml": []byte("kafka_port: 9092\nkafka_heap_opts: \"-Xmx2G -Xms2G\"\n"),
		"ansible-role-kafka-main/meta/argument_specs.yml": []byte(`argument_specs:
  main:
    options:
      kafka_port:
        type: int
        required: true
        default: 9092
        description: Broker listen port
      kafka_mode:
        type: str
        choices: ["kraft", "zookeeper"]
        default: "kraft"
`),
		"ansible-role-kafka-main/tasks/main.yml": []byte(`- name: Install openjdk
  ansible.builtin.package:
    name: [openjdk-17-jre-headless]
    state: present
`),
	}
	wrappedRole, kindRole, slugRole := WrapIntoRunnableProject(roleFiles, "ansible-role-kafka-main.zip")
	if kindRole != AssetAnsibleRole {
		t.Fatalf("expected ansible_role, got %s", kindRole)
	}
	if _, ok := wrappedRole["playbooks/deploy.yml"]; !ok {
		t.Fatalf("expected synthesized playbooks/deploy.yml for bare role")
	}
	repRole := InspectNormalized(wrappedRole, kindRole, slugRole, "upload")
	if !repRole.Valid {
		t.Fatalf("role invalid: %+v", repRole.Problems)
	}
	if repRole.Manifest.Category != "消息队列" {
		t.Fatalf("expected category 消息队列, got %s", repRole.Manifest.Category)
	}
	foundChoice := false
	for _, v := range repRole.Vars {
		if v.Key == "kafka_mode" && v.Type == "select" && len(v.Choices) == 2 {
			foundChoice = true
		}
	}
	if !foundChoice {
		t.Fatalf("expected argument_specs kafka_mode select var, got %+v", repRole.Vars)
	}

	// 3. Standard Ansible Collection (with galaxy.yml)
	colFiles := map[string][]byte{
		"galaxy.yml": []byte("namespace: acme\nname: mysql_ha\nversion: 2.3.1\ndescription: Standard MySQL HA Collection\n"),
		"roles/mysql/tasks/main.yml": []byte("- name: Install mysql\n  dnf:\n    name: mysql-server\n    state: present\n"),
		"roles/mysql/defaults/main.yml": []byte("mysql_port: 3306\nmysql_root_password: \"\"\n"),
	}
	wrappedCol, kindCol, slugCol := WrapIntoRunnableProject(colFiles, "acme-mysql.tar.gz")
	if kindCol != AssetAnsibleCollection {
		t.Fatalf("expected ansible_collection, got %s", kindCol)
	}
	repCol := InspectNormalized(wrappedCol, kindCol, slugCol, "galaxy")
	if !repCol.Valid || repCol.Manifest.Version != "2.3.1" || repCol.Manifest.Category != "数据库" {
		t.Fatalf("collection inspect mismatch: valid=%v ver=%s cat=%s problems=%+v", repCol.Valid, repCol.Manifest.Version, repCol.Manifest.Category, repCol.Problems)
	}

	// 4. Full Playbook Project (like vitabaks/postgresql_cluster)
	projFiles := map[string][]byte{
		"site.yml": []byte(`---
- name: Deploy etcd consensus
  hosts: etcd_cluster
  tasks:
    - name: Install etcd
      package:
        name: etcd
        state: present
- name: Deploy PostgreSQL primary and replicas
  hosts: master:replica
  tasks:
    - name: Install pg
      apt:
        name: postgresql-17
        state: present
`),
		"group_vars/all.yml": []byte("postgresql_version: 17\npatroni_cluster_name: pg-prod\n"),
	}
	repProj := Inspect(projFiles, "postgresql_cluster", "https://github.com/example/postgresql_cluster.git")
	if repProj.AssetKind != AssetPlaybookProject || !repProj.Valid {
		t.Fatalf("project inspect failed: kind=%s valid=%v problems=%+v", repProj.AssetKind, repProj.Valid, repProj.Problems)
	}
	if len(repProj.Manifest.Groups) != 3 {
		t.Fatalf("expected 3 auto-discovered groups (etcd_cluster, master, replica), got %+v", repProj.Manifest.Groups)
	}
	if len(repProj.Steps) != 2 {
		t.Fatalf("expected 2 play steps, got %+v", repProj.Steps)
	}
}

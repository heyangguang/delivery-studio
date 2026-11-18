package main

import (
	"archive/tar"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"middleware-deployer/mwpack"
)

const packagingDeployment = `
id: pg-prod
hosts:
  - {name: db-1, ip: 10.0.1.11, disk: /dev/vdb}
  - {name: db-2, ip: 10.0.1.12, disk: /dev/vdb}
  - {name: db-3, ip: 10.0.1.13, disk: /dev/vdb}
controller: db-1
instances:
  - id: pg
    component: postgresql
    placement: {primary: [db-1], replica: [db-2, db-3]}
    params: {client_cidr: 10.0.1.0/24, tls: true, tde: false}
`

func readTar(t *testing.T, name string) map[string][]byte {
	t.Helper()
	f, err := os.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	out := map[string][]byte{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Mode&0077 != 0 {
			t.Fatalf("%s: %s is not private (%o)", name, h.Name, h.Mode)
		}
		if h.Typeflag == tar.TypeReg {
			b, _ := io.ReadAll(tr)
			out[h.Name] = b
		}
	}
	return out
}

func TestPackageDeliveryLayoutAndPrivacy(t *testing.T) {
	root := t.TempDir()
	runtime := fixtureAutomationArchive(t, root)
	fakeLibrary(t, filepath.Join(root, "library"), mwpack.DefaultPlatform, allUbuntuPackages(t))
	plat, err := loadPlatform(platformConfig{LibraryDir: filepath.Join(root, "library"), Runtimes: map[string]string{mwpack.DefaultPlatform: runtime}})
	if err != nil {
		t.Fatal(err)
	}
	dep, err := mwpack.ParseDeployment([]byte(packagingDeployment))
	if err != nil {
		t.Fatal(err)
	}
	plan := mwpack.Solve(plat.cat(), dep)
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	material := map[string][]byte{}
	for _, f := range []string{"server.crt", "server.key", "ca.crt"} {
		material["pg/tls/"+f] = []byte("PRIVATE-" + f)
	}
	if issues := plat.readiness(plan); len(issues) != 0 {
		t.Fatalf("library should satisfy the plan: %v", issues)
	}
	repo, err := plat.lib.Assemble(plan.Platform, plan.Requests())
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := mwpack.Render(plan, mwpack.RenderOptions{Artifacts: plat.artifactsFor(plan), Materials: material, PackageRepo: &mwpack.PackageRepo{File: repo.File, SHA256: repo.SHA256, Size: repo.Size}})
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(root, "delivery")
	var stages []string
	if err := packageDelivery(bundle, plat, repo, out, func(m string) { stages = append(stages, m) }); err != nil {
		t.Fatal(err)
	}
	if len(stages) < 5 {
		t.Fatalf("stages = %v", stages)
	}
	if err := packageDelivery(bundle, plat, repo, out, func(string) {}); err == nil {
		t.Fatal("an existing delivery was overwritten")
	}

	ctl := readTar(t, filepath.Join(out, "node01-pg-prod-10.0.1.11.tar.gz"))
	for _, want := range []string{
		"mw-setup/nodes.conf", "mw-setup/setup-root-ssh-trust.sh",
		"middleware-automation/bootstrap/bootstrap-ansible.sh", "middleware-automation/bin/ansible-playbook", "middleware-automation/SHA256SUMS",
		"middleware-automation/projects/pg-prod/inventory/hosts.yml", "middleware-automation/projects/pg-prod/playbooks/00-preflight.yml",
		"middleware-automation/projects/pg-prod/roles/postgresql/tasks/install.yml", "middleware-automation/projects/pg-prod/files/pg/tls/server.key",
	} {
		if _, ok := ctl[want]; !ok {
			t.Errorf("controller package lacks %s", want)
		}
	}
	if !strings.HasPrefix(string(ctl["mw-setup/nodes.conf"]), "10.0.1.11 db-1\n") {
		t.Errorf("nodes.conf must start with the controller: %q", ctl["mw-setup/nodes.conf"])
	}
	for _, name := range []string{"node02-pg-prod-10.0.1.12.tar.gz", "node03-pg-prod-10.0.1.13.tar.gz"} {
		other := readTar(t, filepath.Join(out, name))
		if len(other) != 2 {
			t.Errorf("%s should hold only the SSH helper, has %d files", name, len(other))
		}
		for n, b := range other {
			if strings.Contains(string(b), "PRIVATE-") || strings.HasPrefix(n, "middleware-automation/") {
				t.Errorf("%s leaks controller material: %s", name, n)
			}
		}
	}
	// The outer checksum list must cover every delivered file and match.
	sums, _ := os.ReadFile(filepath.Join(out, "SHA256SUMS"))
	rows := strings.Split(strings.TrimSpace(string(sums)), "\n")
	entries, _ := os.ReadDir(out)
	if len(rows) != len(entries)-1 {
		t.Errorf("SHA256SUMS lists %d files, directory has %d", len(rows), len(entries)-1)
	}
	for _, row := range rows {
		p := strings.SplitN(row, "  ", 2)
		b, err := os.ReadFile(filepath.Join(out, p[1]))
		if err != nil || digest(b) != p[0] {
			t.Errorf("bad checksum row %q", row)
		}
	}
	for _, name := range []string{"00-环境准备.md", "01-部署步骤.md", "plan.json", "部署规格.yml", "packages-ubuntu-24.04-amd64.tar.gz"} {
		if _, err := os.Stat(filepath.Join(out, name)); err != nil {
			t.Errorf("missing %s", name)
		}
	}
}

func TestReadinessReportsMissingPackagesAndRuntime(t *testing.T) {
	root := t.TempDir()
	plat, err := loadPlatform(platformConfig{LibraryDir: filepath.Join(root, "library"), Runtimes: map[string]string{mwpack.DefaultPlatform: fixtureAutomationArchive(t, root)}})
	if err != nil {
		t.Fatal(err)
	}
	dep, _ := mwpack.ParseDeployment([]byte(strings.Replace(packagingDeployment, "tls: true", "tls: false", 1)))
	plan := mwpack.Solve(plat.cat(), dep)
	issues := plat.readiness(plan)
	if len(issues) != 1 || !strings.Contains(issues[0].Message, "软件库里没有") || !strings.Contains(issues[0].Message, "percona-postgresql-17=2:17.11-1.noble") {
		t.Fatalf("an empty library must be reported with the exact missing packages: %v", issues)
	}
	// A system without an Ansible runtime cannot be generated for, however complete its library is.
	plat.cfg.Runtimes = map[string]string{}
	if issues := plat.readiness(plan); len(issues) < 1 || !strings.Contains(issues[0].Message, "运行环境") {
		t.Fatalf("a missing runtime must be reported: %v", issues)
	}
}

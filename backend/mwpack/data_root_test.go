package mwpack_test

import (
	"delivery-studio/mwpack"
	"strings"
	"testing"
)

func TestDataRootContractValidationAndGeneration(t *testing.T) {
	cat := fullCatalog(t)
	contract, err := cat.HostContract()
	if err != nil {
		t.Fatal(err)
	}
	for i := range contract.Parameters {
		if contract.Parameters[i].Key == "data_root" {
			contract.Parameters[i].Default = "/new-default"
		}
	}
	historical, issues := contract.Resolve(mwpack.Host{})
	if len(issues) > 0 || historical.Params["data_root"] != "/data" {
		t.Fatal("historical path changed", historical, issues)
	}
	for _, root := range []string{"/data", "/middleware", "/mnt/ssd/data", "/var/lib/middleware"} {
		_, issues := contract.Resolve(mwpack.Host{Params: map[string]any{"data_root": root}})
		if len(issues) > 0 {
			t.Fatal(root, issues)
		}
	}
	for _, root := range []string{"", "/", "relative", "/data/../etc", "/etc/data", "/usr/local", "/data dir", "/mnt//data", "/data/", "/dev/vdb", "/var"} {
		_, issues := contract.Resolve(mwpack.Host{Params: map[string]any{"data_root": root}})
		if len(issues) == 0 {
			t.Fatal("unsafe path accepted", root)
		}
	}
	for _, component := range []string{"redis", "etcd", "postgresql"} {
		for _, mode := range []string{"dedicated_disk", "system_directory"} {
			t.Run(component+"/"+mode, func(t *testing.T) {
				role := "primary"
				params := "{}"
				if component == "etcd" {
					role = "member"
				}
				if component == "postgresql" {
					params = "{deployment_mode: single, tls: false, tde: false, client_cidr: 10.0.1.0/24}"
				}
				disk := "  disk: /dev/vdb\n"
				if mode == "system_directory" {
					disk = ""
				}
				spec := "id: mount-test\nhosts:\n- name: node-1\n  ip: 10.0.1.11\n" + disk + "  params: {storage_mode: " + mode + ", data_root: /middleware}\ninstances:\n- id: app\n  component: " + component + "\n  placement: {" + role + ": [node-1]}\n  params: " + params + "\n"
				d, e := mwpack.ParseDeployment([]byte(spec))
				if e != nil {
					t.Fatal(e)
				}
				plan := mwpack.Solve(cat, d)
				if e = plan.Err(); e != nil {
					t.Fatal(e)
				}
				b, e := mwpack.Render(plan, mwpack.RenderOptions{})
				if e != nil {
					t.Fatal(e)
				}
				if !strings.Contains(string(b.Project["inventory/group_vars/all.yml"].Data), "data_root: /middleware") {
					t.Fatal("root missing from generated inventory")
				}
				if plan.Normalized().Hosts[0].Params["data_root"] != "/middleware" {
					t.Fatal("root not pinned")
				}
			})
		}
	}
}

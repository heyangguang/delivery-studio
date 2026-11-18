package mwpack_test

import (
	"encoding/json"
	"gopkg.in/yaml.v3"
	"middleware-deployer/mwpack"
	"strings"
	"testing"
)

func TestIndependentExecutorNeverBecomesDatabaseTarget(t *testing.T) {
	d, e := mwpack.ParseDeployment([]byte(pgSingle))
	if e != nil {
		t.Fatal(e)
	}
	d.Controller = ""
	d.ExecutionHost = &mwpack.ExecutionHost{Name: "management", IP: "10.0.2.99", RepositoryPort: 18190}
	p := mwpack.Solve(fullCatalog(t), d)
	if e = p.Err(); e != nil {
		t.Fatal(e)
	}
	if len(p.Hosts) != 1 || len(p.DeliveryHosts()) != 2 || p.Controller != "management" {
		t.Fatalf("wrong host model: %+v", p)
	}
	if p.NeedsData("management") {
		t.Fatal("manager has data disk")
	}
	for _, i := range p.Instances {
		for _, h := range i.Hosts {
			if h == "management" {
				t.Fatal("manager placed into business role")
			}
		}
	}
	b, e := mwpack.Render(p, mwpack.RenderOptions{})
	if e != nil {
		t.Fatal(e)
	}
	var inv struct {
		All struct {
			Hosts    map[string]map[string]any
			Children map[string]struct{ Hosts map[string]any }
		}
	}
	if e = yaml.Unmarshal(b.Project["inventory/hosts.yml"].Data, &inv); e != nil {
		t.Fatal(e)
	}
	if inv.All.Hosts["management"]["ansible_connection"] != "local" {
		t.Fatal("executor is not local")
	}
	for _, h := range p.Hosts {
		if inv.All.Hosts[h.Name]["ansible_connection"] == "local" {
			t.Fatal("database wrongly executes on manager")
		}
	}
	for _, g := range []string{"managed", "mw_data"} {
		if _, exists := inv.All.Children[g].Hosts["management"]; exists {
			t.Fatal("executor is in business group", g)
		}
	}
	var gv map[string]any
	_ = yaml.Unmarshal(b.Project["inventory/group_vars/all.yml"].Data, &gv)
	repos := gv["mw_repos"].([]any)
	if repos[0].(map[string]any)["port"] != 18190 {
		t.Fatal("wrong repository port")
	}
	var plan struct {
		Hosts         []mwpack.Host         `json:"hosts"`
		ExecutionHost *mwpack.ExecutionHost `json:"execution_host"`
	}
	_ = json.Unmarshal(b.PlanDoc, &plan)
	if len(plan.Hosts) != 1 || plan.ExecutionHost == nil {
		t.Fatal("business node count includes executor")
	}
	for _, st := range b.Steps.Phases {
		for _, step := range st.Steps {
			if step.Instance != "" && strings.Contains(step.Title, "安装") {
				for _, h := range step.Hosts {
					if h == "management" {
						t.Fatal("component install targets executor")
					}
				}
			}
		}
	}
	if !strings.Contains(string(b.Docs["00-环境准备.md"]), "独立执行机") || !strings.Contains(string(b.Docs["00-环境准备.md"]), "10.0.2.99") {
		t.Fatal("handbook missing independent executor")
	}
	root := "/root/middleware-executions/" + d.ID + "/middleware-automation"
	if !strings.Contains(string(b.PlanDoc), root+"/projects/") || !strings.Contains(string(b.Docs["01-部署步骤.md"]), "cd "+root) {
		t.Fatal("independent runtime location is missing from plan or handbook")
	}
	if !strings.Contains(string(b.Docs["00-环境准备.md"]), "-C /root/middleware-executions/"+d.ID) {
		t.Fatal("independent unpack overwrites shared root")
	}
	if gv["mw_upload_dir"] != "/tmp/mw-upload/"+d.ID {
		t.Fatal("independent upload directory is shared")
	}
	normalized := p.Normalized()
	if len(normalized.Hosts) != 1 || normalized.ExecutionHost == nil {
		t.Fatal("normalization lost separation")
	}
}
func TestIndependentExecutorCannotBePlacedOrAliasATarget(t *testing.T) {
	for _, variant := range []string{"placement", "ip", "name", "port", "two-controllers"} {
		t.Run(variant, func(t *testing.T) {
			d, _ := mwpack.ParseDeployment([]byte(pgSingle))
			d.Controller = ""
			for k := range d.Instances {
				if d.Instances[k].Component == "postgresql" {
					d.Instances[k].Params["tls"] = false
					d.Instances[k].Params["tde"] = false
				}
			}
			d.ExecutionHost = &mwpack.ExecutionHost{Name: "manager", IP: "10.0.2.99", RepositoryPort: 18190}
			switch variant {
			case "placement":
				for role := range d.Instances[0].Placement {
					d.Instances[0].Placement[role] = []string{"manager"}
				}
			case "ip":
				d.ExecutionHost.IP = d.Hosts[0].IP
			case "name":
				d.ExecutionHost.Name = d.Hosts[0].Name
			case "port":
				d.ExecutionHost.RepositoryPort = 22
			case "two-controllers":
				d.Controller = d.Hosts[0].Name
			}
			if p := mwpack.Solve(fullCatalog(t), d); p.Err() == nil {
				t.Fatal("unsafe executor accepted")
			}
		})
	}
}

func TestIndependentExecutorAcrossComponentSchemes(t *testing.T) {
	for name, spec := range map[string]string{"pg-single": pgSingle, "pg-legacy": pgHA, "redis-single": redisSingle, "redis-ha": redisHA, "etcd": etcdOnly} {
		t.Run(name, func(t *testing.T) {
			d, _ := mwpack.ParseDeployment([]byte(spec))
			d.Controller = ""
			for k := range d.Instances {
				if d.Instances[k].Component == "postgresql" {
					d.Instances[k].Params["tls"] = false
					d.Instances[k].Params["tde"] = false
				}
			}
			d.ExecutionHost = &mwpack.ExecutionHost{Name: "executor", IP: "10.0.3.99", RepositoryPort: 18190}
			p := mwpack.Solve(fullCatalog(t), d)
			if e := p.Err(); e != nil {
				t.Fatal(e)
			}
			b, e := mwpack.Render(p, mwpack.RenderOptions{})
			if e != nil {
				t.Fatal(e)
			}
			for _, list := range [][]*mwpack.PlanStep{b.Steps.Tests, b.Steps.Cleanup} {
				for _, st := range list {
					for _, host := range st.Hosts {
						if host == "executor" {
							t.Fatalf("business test targets manager: %s", st.ID)
						}
					}
				}
			}
		})
	}
	for _, mode := range []string{"replication", "patroni"} {
		d, _ := mwpack.ParseDeployment([]byte(pgHA))
		d.Controller = ""
		d.ExecutionHost = &mwpack.ExecutionHost{Name: "executor", IP: "10.0.3.99", RepositoryPort: 18190}
		for k := range d.Instances {
			if d.Instances[k].Component == "postgresql" {
				d.Instances[k].Params["deployment_mode"] = mode
				d.Instances[k].Params["replication"] = "async"
				d.Instances[k].Params["tde"] = false
				d.Instances[k].Params["tls"] = false
			}
		}
		p := mwpack.Solve(fullCatalog(t), d)
		if e := p.Err(); e != nil {
			t.Fatal(mode, e)
		}
		if _, e := mwpack.Render(p, mwpack.RenderOptions{}); e != nil {
			t.Fatal(mode, e)
		}
	}
}

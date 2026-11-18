package mwpack_test

import (
	"middleware-deployer/mwpack"
	"strings"
	"testing"
)

func TestDeliveryModesRequireExecutableContract(t *testing.T) {
	c := &mwpack.Component{DeliveryModes: []string{"automatic"}, Versions: []mwpack.Version{{ID: "1"}}, Overlay: mwpack.Overlay{Tests: []mwpack.Step{{ID: "check", Expect: "command must succeed"}}}}
	problems := mwpack.ValidateDeliveryModes(c)
	if len(problems) != 2 {
		t.Fatalf("missing timeout/postcondition not rejected: %+v", problems)
	}
	c.Tests[0].Timeout = 30
	c.Tests[0].Postconditions = []string{"result.rc == 0"}
	if got := mwpack.ValidateDeliveryModes(c); len(got) != 0 {
		t.Fatal(got)
	}
	c.DeliveryModes = nil
	if c.SupportsDelivery("automatic") || !c.SupportsDelivery("offline") {
		t.Fatal("legacy auto enrollment")
	}
	c.DeliveryModes = []string{"offline", "configuration"}
	if len(mwpack.ValidateConfiguration(c)) == 0 {
		t.Fatal("configuration without outputs accepted")
	}
	c.Configuration = []mwpack.ConfigurationOutput{{Path: "../escape", Content: "text"}}
	if len(mwpack.ValidateConfiguration(c)) == 0 {
		t.Fatal("path escape")
	}
}
func TestConfigurationRendersHostAndParameterWithoutExecution(t *testing.T) {
	cat := loadCatalog(t)
	c, _ := cat.Get("redis")
	c.DeliveryModes = []string{"offline", "configuration"}
	c.Configuration = []mwpack.ConfigurationOutput{{Path: "redis.conf", Content: "bind ${host.ip}\nport ${params.redis_port}\ndir ${host.data_root}/redis\n"}}
	p := mustSolve(t, cat, `id: config-only
schema: mwdeploy/v1
delivery_mode: configuration
hosts:
- name: node-1
  ip: 10.0.0.1
  params: {storage_mode: system_directory, data_root: /srv/data}
instances:
- id: cache
  component: redis
  placement: {primary: [node-1]}
  params: {}
`)
	if e := p.Err(); e != nil {
		t.Fatal(e)
	}
	files, e := mwpack.ConfigurationFiles(p)
	if e != nil {
		t.Fatal(e)
	}
	got := string(files["cache/node-1/redis.conf"])
	if !strings.Contains(got, "bind 10.0.0.1") || !strings.Contains(got, "dir /srv/data/redis") || strings.Contains(got, "${") {
		t.Fatal(got)
	}
	c.Configuration[0].Content = "${params.unknown}"
	if _, e = mwpack.ConfigurationFiles(p); e == nil {
		t.Fatal("unknown placeholder silently emitted")
	}
}

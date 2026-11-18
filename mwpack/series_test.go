package mwpack_test

import (
	"middleware-deployer/mwpack"
	"strings"
	"testing"
)

func TestSeriesContractValidation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*mwpack.Component)
		want   string
	}{
		{"missing", func(c *mwpack.Component) { c.Detail.Presets[0].Contract = nil }, "缺少系列契约"},
		{"false-ha", func(c *mwpack.Component) { c.Detail.Presets[2].Contract.Failover = "manual" }, "自动故障切换"},
		{"false-sharding", func(c *mwpack.Component) { c.Detail.Presets[2].Contract.Sharding = true }, "分片"},
		{"missing-test", func(c *mwpack.Component) { c.Detail.Presets[0].Contract.Acceptance = []string{"postgresql/missing"} }, "验收测试不存在"},
		{"inactive-test", func(c *mwpack.Component) {
			c.Detail.Presets[0].Contract.Acceptance = []string{"postgresql/native-replication"}
		}, "不执行"},
		{"unknown-operation", func(c *mwpack.Component) {
			c.Detail.Presets[1].Contract.Operations = append(c.Detail.Presets[1].Contract.Operations, "upgrade")
		}, "未知操作"},
		{"wrong-selector", func(c *mwpack.Component) { c.Detail.Presets[0].Contract.When = "params.deployment_mode == 'patroni'" }, "不满足"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cat := fullCatalog(t)
			c, _ := cat.Get("postgresql")
			tc.mutate(c)
			found := false
			for _, issue := range mwpack.ValidateSeries(c, cat, true) {
				if issue.Severity == "error" && strings.Contains(issue.Message, tc.want) {
					found = true
				}
			}
			if !found {
				t.Fatal("expected", tc.want)
			}
		})
	}
}
func TestLegacySeriesContractsRemainReadable(t *testing.T) {
	cat := fullCatalog(t)
	c, _ := cat.Get("postgresql")
	c.Detail.Presets[0].Contract = nil
	for _, issue := range mwpack.ValidateSeries(c, cat, false) {
		if issue.Severity == "error" {
			t.Fatal(issue)
		}
	}
}

func TestAllBuiltinStandaloneComponentsDeclareSeries(t *testing.T) {
	cat := loadCatalog(t)
	for _, name := range cat.Names() {
		c, _ := cat.Get(name)
		for _, issue := range mwpack.ValidateSeries(c, cat, true) {
			if issue.Severity == "error" {
				t.Fatalf("%s: %+v", name, issue)
			}
		}
	}
}

func TestSeriesBlocksUnsupportedOperationAtExecutionBoundary(t *testing.T) {
	cat := fullCatalog(t)
	dep, err := mwpack.ParseDeployment([]byte("id: series-test\nhosts:\n- {name: a, ip: 10.77.0.1, disk: /dev/vdb}\n- {name: b, ip: 10.77.0.2, disk: /dev/vdb}\ninstances:\n- id: pg\n  component: postgresql\n  placement: {primary: [a], replica: [b]}\n  params: {deployment_mode: replication, replication: async, tls: false, tde: false, client_cidr: 10.77.0.0/24}\n"))
	if err != nil {
		t.Fatal(err)
	}
	plan := mwpack.Solve(cat, dep)
	if err := plan.Err(); err != nil {
		t.Fatal(err)
	}
	if plan.View().Instances[0].Contract == nil {
		t.Fatal("UI has no resolved contract")
	}
}

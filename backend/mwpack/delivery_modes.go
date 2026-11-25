package mwpack

import "fmt"

func (c *Component) EffectiveDeliveryModes() []string {
	if len(c.DeliveryModes) > 0 {
		return append([]string{}, c.DeliveryModes...)
	}
	if c.Kind == "external" {
		return []string{"configuration"}
	}
	return []string{"offline"}
}
func (c *Component) SupportsDelivery(mode string) bool {
	return contains(c.EffectiveDeliveryModes(), mode)
}

// Publishing an automatic capability requires bounded steps and machine-checkable
// postconditions. Retries are never implicit.
func ValidateDeliveryModes(c *Component) []Problem {
	var out []Problem
	bad := func(p, msg string) { out = append(out, Problem{"error", p, msg}) }
	if c.DeliveryModes != nil && len(c.DeliveryModes) == 0 {
		bad("delivery_modes", "至少选择一种交付方式")
	}
	seen := map[string]bool{}
	for _, m := range c.DeliveryModes {
		if (m != "offline" && m != "automatic" && m != "configuration") || seen[m] {
			bad("delivery_modes", "交付方式无效或重复："+m)
		}
		seen[m] = true
	}
	if !c.SupportsDelivery("automatic") {
		return out
	}
	if c.Kind == "external" {
		bad("delivery_modes", "人工配置的外部服务不能声明自动执行")
		return out
	}
	for _, v := range c.Versions {
		r, e := c.Resolve(v.ID)
		if e != nil {
			continue
		}
		count := 0
		check := func(group string, steps []Step) {
			for _, s := range steps {
				count++
				p := fmt.Sprintf("versions[%s].%s[%s]", v.ID, group, s.ID)
				if s.Timeout < 1 || s.Timeout > 86400 {
					bad(p+".timeout", "自动执行需要 1–86400 秒的超时设置")
				}
				if len(s.Postconditions) == 0 {
					bad(p+".postconditions", "自动执行需要可检查的完成条件（postconditions），不能只填写文字判据")
				}
				if s.Expect == "" {
					bad(p+".expect", "请说明完成条件验证了什么，供执行者核对")
				}
			}
		}
		for k, st := range r.Lifecycle {
			check("lifecycle."+k, st)
		}
		check("tests", r.Tests)
		check("cleanup", r.Cleanup)
		if count == 0 {
			bad("delivery_modes", "自动执行至少需要一个可执行步骤")
		}
	}
	return out
}

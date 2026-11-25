package mwpack

import (
	"fmt"
	"strconv"
	"strings"
)

// Resolved is a component flattened for one selected version: the base definition with every
// version in the extends chain applied on top, in order.
type Resolved struct {
	C         *Component
	Version   Version
	Platforms []string
	Packages  []Package
	Artifacts []Artifact
	Overlay
}

func mergeBy[T any](base, over []T, key func(T) string, remove []string) []T {
	drop := map[string]bool{}
	for _, r := range remove {
		drop[r] = true
	}
	out := make([]T, 0, len(base)+len(over))
	idx := map[string]int{}
	for _, b := range base {
		k := key(b)
		if drop[k] {
			continue
		}
		idx[k] = len(out)
		out = append(out, b)
	}
	for _, o := range over {
		k := key(o)
		if i, ok := idx[k]; ok {
			out[i] = o
			continue
		}
		idx[k] = len(out)
		out = append(out, o)
	}
	return out
}

func applyOverlay(base Overlay, over Overlay, rm Remove) Overlay {
	base.Roles = mergeBy(base.Roles, over.Roles, func(r RoleSpec) string { return r.Name }, rm.Roles)
	base.Flows = mergeBy(base.Flows, over.Flows, func(f FlowSpec) string { return f.ID }, nil)
	base.Requires = mergeBy(base.Requires, over.Requires, func(r Require) string { return r.Capability }, rm.Requires)
	base.Groups = mergeBy(base.Groups, over.Groups, func(g Group) string { return g.ID }, nil)
	base.Params = mergeBy(base.Params, over.Params, func(p Param) string { return p.Key }, rm.Params)
	base.Rules = mergeBy(base.Rules, over.Rules, func(r Rule) string { return r.ID }, rm.Rules)
	base.Ports = mergeBy(base.Ports, over.Ports, func(p PortSpec) string { return p.Name }, rm.Ports)
	base.Endpoints = mergeBy(base.Endpoints, over.Endpoints, func(e Endpoint) string { return e.Name }, rm.Endpoints)
	base.Secrets = mergeBy(base.Secrets, over.Secrets, func(s SecretSpec) string { return s.Name }, rm.Secrets)
	base.Inputs = mergeBy(base.Inputs, over.Inputs, func(i Input) string { return i.Name }, rm.Inputs)
	base.Tests = mergeBy(base.Tests, over.Tests, func(s Step) string { return s.ID }, rm.Tests)
	base.Cleanup = mergeBy(base.Cleanup, over.Cleanup, func(s Step) string { return s.ID }, rm.Cleanup)
	lc := map[string][]Step{}
	for phase, steps := range base.Lifecycle {
		lc[phase] = steps
	}
	for phase, steps := range over.Lifecycle {
		var drop []string
		for _, r := range rm.Steps {
			if p, id, ok := strings.Cut(r, "/"); ok && p == phase {
				drop = append(drop, id)
			}
		}
		lc[phase] = mergeBy(lc[phase], steps, func(s Step) string { return s.ID }, drop)
	}
	for _, r := range rm.Steps {
		if p, id, ok := strings.Cut(r, "/"); ok {
			if _, touched := over.Lifecycle[p]; !touched {
				lc[p] = mergeBy(lc[p], nil, func(s Step) string { return s.ID }, []string{id})
			}
		}
	}
	base.Lifecycle = lc
	if over.Addons != nil {
		a := AddonSet{}
		if base.Addons != nil {
			a = *base.Addons
		}
		if over.Addons.Kind != "" {
			a.Kind = over.Addons.Kind
		}
		if over.Addons.Scope.Name != "" {
			a.Scope = over.Addons.Scope
		}
		a.Items = mergeBy(a.Items, over.Addons.Items, func(x Addon) string { return x.ID }, nil)
		base.Addons = &a
	}
	if over.LB != nil {
		base.LB = over.LB
	}
	return base
}

// Version looks up a version by id.
func (c *Component) Version(id string) (*Version, bool) {
	for i := range c.Versions {
		if c.Versions[i].ID == id {
			return &c.Versions[i], true
		}
	}
	return nil, false
}

// Resolve flattens the component for a version.
func (c *Component) Resolve(id string) (*Resolved, error) {
	var chain []*Version
	seen := map[string]bool{}
	for cur := id; cur != ""; {
		if seen[cur] {
			return nil, fmt.Errorf("组件 %s 的版本继承出现循环：%s", c.Name, cur)
		}
		seen[cur] = true
		v, ok := c.Version(cur)
		if !ok {
			return nil, fmt.Errorf("组件 %s 没有版本 %s", c.Name, cur)
		}
		chain = append([]*Version{v}, chain...)
		cur = v.Extends
	}
	r := &Resolved{C: c, Overlay: c.Overlay}
	for _, v := range chain {
		r.Overlay = applyOverlay(r.Overlay, v.Overlay, v.Remove)
		if len(v.Platforms) > 0 {
			r.Platforms = v.Platforms
		}
		if len(v.Packages) > 0 {
			r.Packages = v.Packages
		}
		if len(v.Artifacts) > 0 {
			r.Artifacts = v.Artifacts
		}
	}
	r.Version = *chain[len(chain)-1]
	return r, nil
}

// EffectiveVerifiedPlatforms returns the OS platforms that are verified and released for this version.
//   - If status != "published", returns nil (no OS is released for formal delivery).
//   - If status == "published" and VerifiedPlatforms is explicitly listed, returns those declared platforms.
//   - If status == "published" and VerifiedPlatforms is omitted on a legacy pack, all declared Platforms count as verified.
func (r *Resolved) EffectiveVerifiedPlatforms() []string {
	if firstNonEmpty(r.Version.Status, "draft") != "published" || len(r.Platforms) == 0 {
		return nil
	}
	if len(r.Version.VerifiedPlatforms) > 0 {
		var out []string
		for _, p := range r.Version.VerifiedPlatforms {
			if contains(r.Platforms, p) && !contains(out, p) {
				out = append(out, p)
			}
		}
		return out
	}
	return append([]string(nil), r.Platforms...)
}

// PlatformStatus returns the effective release state of this version on a specific OS platform:
//   - "draft"     : version is still in draft
//   - "verifying" : version is verifying, OR published on other OSes but not yet verified on this OS
//   - "published" : version is published AND verified on this OS (or external / platform-agnostic)
func (r *Resolved) PlatformStatus(platform string) string {
	st := firstNonEmpty(r.Version.Status, "draft")
	if st != "published" {
		return st
	}
	if len(r.Platforms) == 0 || platform == "" {
		return "published"
	}
	if contains(r.EffectiveVerifiedPlatforms(), platform) {
		return "published"
	}
	return "verifying"
}

// ManifestSum returns the SHA256 digest of the component's manifest & files.
func (c *Component) ManifestSum() string {
	if c == nil {
		return ""
	}
	return c.sum
}

func (r *Resolved) Role(name string) (RoleSpec, bool) {
	for _, x := range r.Roles {
		if x.Name == name {
			return x, true
		}
	}
	return RoleSpec{}, false
}

func (r *Resolved) Endpoint(name string) (Endpoint, bool) {
	for _, x := range r.Endpoints {
		if x.Name == name {
			return x, true
		}
	}
	return Endpoint{}, false
}

// ---- version comparison ----

func versionParts(v string) []int {
	var out []int
	for _, p := range strings.FieldsFunc(v, func(r rune) bool { return r == '.' || r == '-' || r == '_' }) {
		n, err := strconv.Atoi(p)
		if err != nil {
			break
		}
		out = append(out, n)
	}
	return out
}

// CompareVersions compares dotted numeric versions; a missing part counts as zero.
func CompareVersions(a, b string) int {
	x, y := versionParts(a), versionParts(b)
	for i := 0; i < len(x) || i < len(y); i++ {
		var p, q int
		if i < len(x) {
			p = x[i]
		}
		if i < len(y) {
			q = y[i]
		}
		if p != q {
			if p < q {
				return -1
			}
			return 1
		}
	}
	return 0
}

// SatisfiesVersion checks constraints like ">=3.4", "<4", "=17" (space separated terms are all required).
func SatisfiesVersion(v, constraint string) bool {
	for _, term := range strings.Fields(constraint) {
		op := ""
		for _, o := range []string{">=", "<=", "!=", "==", ">", "<", "="} {
			if strings.HasPrefix(term, o) {
				op = o
				break
			}
		}
		c := CompareVersions(v, strings.TrimPrefix(term, op))
		ok := false
		switch op {
		case ">=":
			ok = c >= 0
		case "<=":
			ok = c <= 0
		case ">":
			ok = c > 0
		case "<":
			ok = c < 0
		case "!=":
			ok = c != 0
		default:
			ok = c == 0
		}
		if !ok {
			return false
		}
	}
	return true
}

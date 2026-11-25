package pkglib

import (
	"embed"
	"fmt"
	"sort"
	"strings"

	"delivery-studio/mwpack"
)

//go:embed base/*.tsv base/*.gz
var baseFS embed.FS

// baseSet is the packages a clean installation of the platform already has (the contents of its container image).
// A dependency one of them satisfies is not downloaded.
type baseSet struct {
	have     map[string]string // package -> version
	prov     map[string][]provided
	requires map[string][]rpmDep // rpm platforms: what each base package needs, to see what an upgrade would break
}

func loadBaseSet(platform string) (*baseSet, error) {
	b, err := baseFS.ReadFile("base/" + platform + ".tsv")
	if err != nil {
		return nil, fmt.Errorf("没有 %s 的基础系统清单，无法判断哪些依赖已经自带", platform)
	}
	if gz, err := baseFS.ReadFile("base/" + platform + ".files.gz"); err == nil {
		return loadRpmBase(b, gz)
	}
	s := &baseSet{have: map[string]string{}, prov: map[string][]provided{}}
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 2 {
			continue
		}
		s.have[f[0]] = f[1]
		if len(f) > 2 && f[2] != "" {
			for _, alt := range strings.Split(f[2], ",") {
				n, v := splitProvide(alt)
				if n != "" {
					s.prov[n] = append(s.prov[n], provided{&IndexPkg{Name: f[0], Version: f[1]}, v})
				}
			}
		}
	}
	return s, nil
}

// ---- dependency fields ----

type depAlt struct{ name, op, ver string }

// parseDepends reads "a (>= 1), b | c" into groups of alternatives. Alternatives restricted to other architectures
// are dropped; architecture qualifiers such as :any are ignored.
func parseDepends(s string) [][]depAlt {
	var out [][]depAlt
	for _, group := range strings.Split(s, ",") {
		group = strings.TrimSpace(group)
		if group == "" {
			continue
		}
		var alts []depAlt
		for _, a := range strings.Split(group, "|") {
			a = strings.TrimSpace(a)
			if i := strings.IndexByte(a, '['); i >= 0 {
				arch := a[i:]
				a = strings.TrimSpace(a[:i])
				if strings.Contains(arch, "!amd64") || (!strings.Contains(arch, "!") && !strings.Contains(arch, "amd64") && !strings.Contains(arch, "any")) {
					continue
				}
			}
			alt := depAlt{}
			if i := strings.IndexByte(a, '('); i >= 0 {
				constraint := strings.Trim(strings.TrimSpace(a[i:]), "()")
				a = strings.TrimSpace(a[:i])
				for _, op := range []string{"<<", "<=", ">=", ">>", "=", "<", ">"} {
					if strings.HasPrefix(constraint, op) {
						alt.op = op
						alt.ver = strings.TrimSpace(strings.TrimPrefix(constraint, op))
						break
					}
				}
			}
			if i := strings.IndexByte(a, ':'); i >= 0 {
				a = a[:i]
			}
			alt.name = strings.TrimSpace(a)
			if alt.name != "" {
				alts = append(alts, alt)
			}
		}
		if len(alts) > 0 {
			out = append(out, alts)
		}
	}
	return out
}

func satisfies(have, op, want string) bool {
	if op == "" {
		return true
	}
	c := CompareDeb(have, want)
	switch op {
	case "<<", "<":
		return c < 0
	case "<=":
		return c <= 0
	case "=":
		return c == 0
	case ">=":
		return c >= 0
	case ">>", ">":
		return c > 0
	}
	return false
}

// ---- resolving ----

// PlanPkg is one package file a request needs downloaded.
type PlanPkg struct {
	Name     string `json:"name"`
	Version  string `json:"version"`
	Arch     string `json:"arch,omitempty"`
	Size     int64  `json:"size"`
	Source   string `json:"source"`
	Suite    string `json:"suite"`
	Reason   string `json:"reason"`
	Upgrade  bool   `json:"upgrade,omitempty"` // replaces a package the base system already has
	File     string `json:"file"`
	Filename string `json:"-"`
	SHA256   string `json:"-"`
}

// Plan is what installing one package at one version needs, worked out from the cached indexes alone.
type Plan struct {
	Request    mwpack.PackageRequest `json:"request"`
	Packages   []PlanPkg             `json:"packages"`
	Bytes      int64                 `json:"bytes"`
	Unresolved []string              `json:"unresolved"`
	Notes      []string              `json:"notes"`
}

// PoolFile is the name a package file has in the library, the same one the container based fetch gives it.
func PoolFile(p *IndexPkg) string {
	return SafeFile(fmt.Sprintf("%s_%s_%s.deb", p.Name, strings.ReplaceAll(p.Version, ":", "%3a"), p.Arch))
}

type entry struct {
	owner string
	ver   string
	real  bool
}

// Resolve works out the closure of name=version the way apt would for a clean system of the platform: Depends and
// Pre-Depends only (no Recommends), skipping what the base system already satisfies and taking the newest version
// the sources offer for everything else.
func (x *Index) Resolve(def mwpack.PlatformDef, req mwpack.PackageRequest) (*Plan, error) {
	pi, err := x.load(def)
	if err != nil {
		return nil, err
	}
	if def.Family == "rpm" {
		return x.resolveRpm(pi, def, req)
	}
	var root *IndexPkg
	for _, p := range pi.byName[req.Name] {
		if p.Version == req.Version {
			root = p
			break
		}
	}
	if root == nil {
		return nil, fmt.Errorf("软件源里没有 %s 的 %s 版本", req.Name, req.Version)
	}
	have := map[string][]entry{}
	for n, v := range pi.base.have {
		have[n] = append(have[n], entry{owner: n, ver: v, real: true})
	}
	for n, list := range pi.base.prov {
		for _, pr := range list {
			have[n] = append(have[n], entry{owner: pr.pkg.Name, ver: pr.ver})
		}
	}
	chosen := map[string]*IndexPkg{}
	why := map[string]string{}
	upgrade := map[string]bool{}
	var order []*IndexPkg
	plan := &Plan{Request: req, Unresolved: []string{}, Notes: []string{}}
	add := func(p *IndexPkg, reason string) {
		if _, base := pi.base.have[p.Name]; base {
			upgrade[p.Name] = true
			for n, list := range have { // the base version is replaced
				kept := list[:0]
				for _, e := range list {
					if e.owner != p.Name {
						kept = append(kept, e)
					}
				}
				have[n] = kept
			}
		}
		chosen[p.Name] = p
		why[p.Name] = reason
		order = append(order, p)
		have[p.Name] = append(have[p.Name], entry{owner: p.Name, ver: p.Version, real: true})
		if p.Provides != "" {
			for _, alt := range strings.Split(p.Provides, ",") {
				if n, v := splitProvide(alt); n != "" && n != p.Name {
					have[n] = append(have[n], entry{owner: p.Name, ver: v})
				}
			}
		}
	}
	met := func(a depAlt) bool {
		for _, e := range have[a.name] {
			if e.real || e.ver != "" {
				if satisfies(e.ver, a.op, a.ver) {
					return true
				}
			} else if a.op == "" {
				return true // an unversioned provide satisfies only an unversioned dependency
			}
		}
		return false
	}
	candidate := func(a depAlt) (*IndexPkg, string) {
		for _, p := range pi.byName[a.name] {
			if satisfies(p.Version, a.op, a.ver) {
				return p, ""
			}
		}
		var provs []*IndexPkg
		seen := map[string]bool{}
		for _, pr := range pi.prov[a.name] {
			if (pr.ver != "" && satisfies(pr.ver, a.op, a.ver)) || (pr.ver == "" && a.op == "") {
				if !seen[pr.pkg.Name] {
					seen[pr.pkg.Name] = true
					provs = append(provs, pr.pkg)
				}
			}
		}
		if len(provs) == 0 {
			return nil, ""
		}
		sort.Slice(provs, func(i, j int) bool { return provs[i].Name < provs[j].Name })
		note := ""
		if len(provs) > 1 {
			var names []string
			for _, p := range provs {
				names = append(names, p.Name)
			}
			note = fmt.Sprintf("%s 是虚拟包，有多个软件包提供它（%s），选了 %s", a.name, strings.Join(names, "、"), provs[0].Name)
		}
		return pi.byName[provs[0].Name][0], note
	}
	add(root, "请求的软件包")
	for i := 0; i < len(order); i++ {
		cur := order[i]
		for _, group := range parseDepends(cur.Deps) {
			ok := false
			for _, a := range group {
				if met(a) {
					ok = true
					break
				}
			}
			if ok {
				continue
			}
			picked := false
			for _, a := range group {
				if c, note := candidate(a); c != nil {
					if prev, dup := chosen[c.Name]; dup && prev != c {
						continue
					}
					if note != "" {
						plan.Notes = append(plan.Notes, note)
					}
					add(c, "被 "+cur.Name+" 依赖")
					picked = true
					break
				}
			}
			if !picked {
				var parts []string
				for _, a := range group {
					s := a.name
					if a.op != "" {
						s += " (" + a.op + " " + a.ver + ")"
					}
					parts = append(parts, s)
				}
				plan.Unresolved = append(plan.Unresolved, fmt.Sprintf("%s 依赖 %s，软件源里没有满足的版本", cur.Name, strings.Join(parts, " | ")))
			}
		}
	}
	for _, p := range order {
		pp := PlanPkg{Name: p.Name, Version: p.Version, Size: p.Size, Source: p.Source, Suite: p.Suite, Reason: why[p.Name], Upgrade: upgrade[p.Name], File: PoolFile(p), Filename: p.Filename, SHA256: p.SHA256}
		plan.Packages = append(plan.Packages, pp)
		plan.Bytes += p.Size
	}
	return plan, nil
}

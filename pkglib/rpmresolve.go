package pkglib

import (
	"fmt"
	"sort"
	"strings"

	"middleware-deployer/mwpack"
)

// ---- rich dependencies ----

// richNode is a parsed boolean dependency: "(A or B)", "(A and (B if C))", or a plain capability at the leaves.
type richNode struct {
	op   string // "" for a leaf; and or if else unless with without
	dep  rpmDep
	args []*richNode
}

var richOps = map[string]bool{"and": true, "or": true, "if": true, "else": true, "unless": true, "with": true, "without": true}
var symOp = map[string]string{"=": "EQ", "<": "LT", "<=": "LE", ">": "GT", ">=": "GE"}

// parseRich reads a boolean dependency. Requirements written in primary.xml as a plain name are leaves; those starting
// with "(" are parsed. An unreadable expression returns nil, and the requirement is reported as unresolved.
func parseRich(s string) *richNode {
	toks := richTokens(s)
	n, rest := parseRichExpr(toks)
	if n == nil || len(rest) != 0 {
		return nil
	}
	return n
}

func richTokens(s string) []string {
	var out []string
	cur := ""
	flush := func() {
		if cur != "" {
			out = append(out, cur)
			cur = ""
		}
	}
	for _, c := range s {
		switch c {
		case '(', ')':
			// a parenthesis directly after a name belongs to it: "libfoo.so()(64bit)"
			if cur != "" && (c == ')' && strings.Count(cur, "(") > strings.Count(cur, ")") || c == '(' && cur != "") {
				cur += string(c)
				continue
			}
			flush()
			out = append(out, string(c))
		case ' ':
			flush()
		default:
			cur += string(c)
		}
	}
	flush()
	return out
}

func parseRichExpr(t []string) (*richNode, []string) {
	if len(t) == 0 {
		return nil, t
	}
	if t[0] != "(" {
		d := rpmDep{Name: t[0]}
		t = t[1:]
		if len(t) >= 2 && symOp[t[0]] != "" {
			d.Op, d.EVR = symOp[t[0]], t[1]
			t = t[2:]
		}
		return &richNode{dep: d}, t
	}
	t = t[1:]
	first, t := parseRichExpr(t)
	if first == nil {
		return nil, t
	}
	node := first
	for len(t) > 0 && t[0] != ")" {
		op := t[0]
		if !richOps[op] {
			return nil, t
		}
		next, rest := parseRichExpr(t[1:])
		if next == nil {
			return nil, rest
		}
		t = rest
		if op == "else" && node.op == "if" {
			node.args = append(node.args, next)
			continue
		}
		node = &richNode{op: op, args: []*richNode{node, next}}
	}
	if len(t) == 0 {
		return nil, t
	}
	return node, t[1:]
}

// ---- resolving ----

type rpmSolver struct {
	pi       *platIndex
	have     map[string][]entry // capability -> what provides it now (base system and chosen)
	chosen   map[string]*IndexPkg
	upgrade  map[string]bool
	why      map[string]string
	order    []*IndexPkg
	notes    []string
	missing  []string
	baseHave map[string]string
	reported map[string]bool // base packages already reported as broken
}

func (s *rpmSolver) addProvide(name, ver, owner string, real bool) {
	s.have[name] = append(s.have[name], entry{owner: owner, ver: ver, real: real})
}

func (s *rpmSolver) add(p *IndexPkg, reason string) {
	if _, base := s.baseHave[p.Name]; base {
		s.upgrade[p.Name] = true
		for n, list := range s.have { // the base copy is replaced
			kept := list[:0]
			for _, e := range list {
				if e.owner != p.Name {
					kept = append(kept, e)
				}
			}
			s.have[n] = kept
		}
	}
	s.chosen[p.Name] = p
	s.why[p.Name] = reason
	s.order = append(s.order, p)
	s.addProvide(p.Name, p.Version, p.Name, true)
	for _, d := range p.rpm.Provides {
		s.addProvide(d.Name, d.EVR, p.Name, false)
	}
	for _, f := range p.rpm.Files {
		s.addProvide(f, "", p.Name, false)
	}
}

func (s *rpmSolver) met(d rpmDep) bool {
	for _, e := range s.have[d.Name] {
		if d.Op == "" || rpmSatisfies(e.ver, d.Op, d.EVR) {
			return true
		}
	}
	return false
}

// candidate is what dnf would install for a capability: the newest package of that name that satisfies it, otherwise
// the newest version of a provider, preferring one built from the same source package as the package that needs it,
// then the shortest name.
func (s *rpmSolver) candidate(d rpmDep, from *IndexPkg) (*IndexPkg, string) {
	for _, p := range s.pi.byName[d.Name] {
		if d.Op == "" || rpmSatisfies(p.Version, d.Op, d.EVR) {
			return p, ""
		}
	}
	best := map[string]*IndexPkg{}
	for _, pr := range s.pi.prov[d.Name] {
		if d.Op != "" && !rpmSatisfies(pr.ver, d.Op, d.EVR) {
			continue
		}
		if cur, ok := best[pr.pkg.Name]; !ok || CompareRPM(pr.pkg.Version, cur.Version) > 0 {
			best[pr.pkg.Name] = pr.pkg
		}
	}
	if len(best) == 0 {
		return nil, ""
	}
	var names []string
	for n := range best {
		names = append(names, n)
	}
	same := func(n string) bool {
		return from != nil && best[n].rpm.SrcName != "" && best[n].rpm.SrcName == from.rpm.SrcName
	}
	sort.Slice(names, func(i, j int) bool {
		// a provider built from the same source package as what needs it goes first (openssl-libs → openssl-fips-provider)
		if a, b := same(names[i]), same(names[j]); a != b {
			return a
		}
		if len(names[i]) != len(names[j]) {
			return len(names[i]) < len(names[j])
		}
		return names[i] < names[j]
	})
	note := ""
	if len(names) > 1 {
		note = fmt.Sprintf("%s 有多个软件包提供（%s），选了 %s", d.Name, strings.Join(names, "、"), names[0])
	}
	return best[names[0]], note
}

// need satisfies one requirement of cur, installing what it takes. It reports whether the requirement could be met.
func (s *rpmSolver) need(n *richNode, cur *IndexPkg) bool {
	switch n.op {
	case "":
		if s.met(n.dep) {
			return true
		}
		c, note := s.candidate(n.dep, cur)
		if c == nil {
			return false
		}
		if prev, dup := s.chosen[c.Name]; dup && prev != c {
			// another version of it is already chosen and does not satisfy this; rpm would conflict here
			return false
		}
		if note != "" {
			s.notes = append(s.notes, note)
		}
		s.add(c, "被 "+cur.Name+" 依赖")
		return true
	case "and", "with":
		return s.need(n.args[0], cur) && s.need(n.args[1], cur)
	case "or":
		if s.holds(n.args[0]) || s.holds(n.args[1]) {
			return true
		}
		// like dnf, take the first alternative that can actually be installed, not merely the first one named
		if s.viable(n.args[0]) || !s.viable(n.args[1]) {
			if s.need(n.args[0], cur) {
				return true
			}
		}
		return s.need(n.args[1], cur)
	case "if":
		if s.holds(n.args[1]) {
			return s.need(n.args[0], cur)
		}
		if len(n.args) > 2 {
			return s.need(n.args[2], cur)
		}
		return true
	case "unless":
		if !s.holds(n.args[1]) {
			return s.need(n.args[0], cur)
		}
		return true
	case "without":
		return s.need(n.args[0], cur)
	}
	return false
}

// viable tells whether an expression could be installed: what it names exists, and what that needs in turn is either
// there already or available (looked at one level deep, which is where a dead alternative shows).
func (s *rpmSolver) viable(n *richNode) bool {
	switch n.op {
	case "":
		if s.met(n.dep) {
			return true
		}
		c, _ := s.candidate(n.dep, nil)
		if c == nil {
			return false
		}
		for _, d := range c.rpm.Requires {
			if strings.HasPrefix(d.Name, "(") || s.met(d) {
				continue
			}
			if x, _ := s.candidate(d, c); x == nil {
				return false
			}
		}
		return true
	case "and", "with":
		return s.viable(n.args[0]) && s.viable(n.args[1])
	case "or":
		return s.viable(n.args[0]) || s.viable(n.args[1])
	}
	return true
}

// holds tells whether an expression is already true of what is installed, without installing anything.
func (s *rpmSolver) holds(n *richNode) bool {
	switch n.op {
	case "":
		return s.met(n.dep)
	case "and", "with":
		return s.holds(n.args[0]) && s.holds(n.args[1])
	case "or":
		return s.holds(n.args[0]) || s.holds(n.args[1])
	case "if":
		if s.holds(n.args[1]) {
			return s.holds(n.args[0])
		}
		return len(n.args) < 3 || s.holds(n.args[2])
	case "unless":
		return s.holds(n.args[1]) || s.holds(n.args[0])
	case "without":
		return s.holds(n.args[0]) && !s.holds(n.args[1])
	}
	return false
}

// upgradeBroken upgrades base packages whose requirements are no longer met. It reports whether it added any.
func (s *rpmSolver) upgradeBroken() bool {
	var names []string
	for n := range s.baseHave {
		names = append(names, n)
	}
	sort.Strings(names)
	added := false
	for _, n := range names {
		if s.chosen[n] != nil {
			continue
		}
		var broken *rpmDep
		for _, d := range s.pi.base.requires[n] {
			if !strings.HasPrefix(d.Name, "(") && !s.met(d) {
				d := d
				broken = &d
				break
			}
		}
		if broken == nil {
			continue
		}
		list := s.pi.byName[n]
		if len(list) == 0 {
			if s.reported[n] {
				continue
			}
			s.reported[n] = true
			s.missing = append(s.missing, fmt.Sprintf("系统自带的 %s 需要 %s，替换后不再满足，软件源里也没有它的新版本", n, broken.Name))
			continue
		}
		s.add(list[0], fmt.Sprintf("系统自带的 %s 要求旧版本的 %s，一起升级", n, strings.SplitN(broken.Name, "(", 2)[0]))
		added = true
	}
	return added
}

// resolveRpm works out the closure of name-version the way dnf would on a clean system of the platform with weak
// dependencies off: Requires only, skipping what the base system already satisfies, newest versions otherwise.
func (x *Index) resolveRpm(pi *platIndex, def mwpack.PlatformDef, req mwpack.PackageRequest) (*Plan, error) {
	var root *IndexPkg
	for _, p := range pi.byName[req.Name] {
		bare := p.Version
		if i := strings.IndexByte(bare, ':'); i >= 0 {
			bare = bare[i+1:]
		}
		if p.Version == req.Version || bare == req.Version {
			root = p
			break
		}
	}
	if root == nil {
		return nil, fmt.Errorf("软件源里没有 %s 的 %s 版本", req.Name, req.Version)
	}
	s := &rpmSolver{pi: pi, have: map[string][]entry{}, chosen: map[string]*IndexPkg{}, upgrade: map[string]bool{}, why: map[string]string{}, baseHave: pi.base.have, reported: map[string]bool{}}
	for n, v := range pi.base.have {
		s.addProvide(n, v, n, true)
	}
	for n, list := range pi.base.prov {
		for _, pr := range list {
			s.addProvide(n, pr.ver, pr.pkg.Name, false)
		}
	}
	s.add(root, "请求的软件包")
	for i := 0; ; i++ {
		if i == len(s.order) {
			// everything chosen has its requirements; now the base system must still hold together, since replacing
			// a base package (openssl-libs) can leave another (openssl) asking for the old version
			if !s.upgradeBroken() {
				break
			}
		}
		cur := s.order[i]
		for _, d := range cur.rpm.Requires {
			var n *richNode
			if strings.HasPrefix(d.Name, "(") {
				if n = parseRich(d.Name); n == nil {
					s.missing = append(s.missing, fmt.Sprintf("%s 的依赖 %s 无法解析", cur.Name, d.Name))
					continue
				}
			} else {
				n = &richNode{dep: d}
			}
			if !s.need(n, cur) {
				text := d.Name
				if d.Op != "" {
					text += " " + d.Op + " " + d.EVR
				}
				s.missing = append(s.missing, fmt.Sprintf("%s 依赖 %s，软件源里没有满足的版本", cur.Name, text))
			}
		}
	}
	plan := &Plan{Request: req, Unresolved: s.missing, Notes: s.notes}
	if plan.Unresolved == nil {
		plan.Unresolved = []string{}
	}
	if plan.Notes == nil {
		plan.Notes = []string{}
	}
	for _, p := range s.order {
		plan.Packages = append(plan.Packages, PlanPkg{Name: p.Name, Version: p.Version, Arch: p.Arch, Size: p.Size, Source: p.Source, Reason: s.why[p.Name], Upgrade: s.upgrade[p.Name], File: rpmFileName(p.Filename), Filename: p.Filename, SHA256: p.SHA256})
		plan.Bytes += p.Size
	}
	return plan, nil
}

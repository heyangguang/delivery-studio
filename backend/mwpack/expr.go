package mwpack

import (
	"fmt"
	"strings"
	"sync"

	"github.com/expr-lang/expr"
	"github.com/expr-lang/expr/vm"
)

// Env is what manifest expressions can see. Params always holds every parameter of the instance
// (defaults for the ones the user did not set), so expressions never meet a missing key.
type Env struct {
	Params   map[string]any
	Roles    map[string][]string
	Hosts    []string
	Version  string
	Instance string
	// Controller is the machine that runs Ansible.
	Controller string
	// Addons lists the selected add-on ids.
	Addons []string
	Uses   map[string]map[string]any
	Fronts map[string]map[string]any
}

func (e Env) vars() map[string]any {
	roles := map[string]any{}
	for k, v := range e.Roles {
		roles[k] = v
	}
	return map[string]any{
		"params":     e.Params,
		"roles":      roles,
		"hosts":      e.Hosts,
		"version":    e.Version,
		"instance":   e.Instance,
		"controller": e.Controller,
		"addons":     e.Addons,
		"uses":       e.Uses,
		"fronts":     e.Fronts,
		"count":      func(x any) int { return lenOf(x) },
		// size("2GB") is the size in kilobytes, for comparing memory style parameters.
		"size": func(s string) int64 { n, _ := ParseSize(s); return n },
		// vge/vlt compare dotted versions: vge(version, "17").
		"vge": func(a, b string) bool { return CompareVersions(a, b) >= 0 },
		"vlt": func(a, b string) bool { return CompareVersions(a, b) < 0 },
	}
}

func lenOf(x any) int {
	switch v := x.(type) {
	case nil:
		return 0
	case []string:
		return len(v)
	case []any:
		return len(v)
	case map[string]any:
		return len(v)
	case string:
		return len(v)
	}
	return 0
}

var programs sync.Map // source -> *vm.Program

func compile(src string) (*vm.Program, error) {
	if p, ok := programs.Load(src); ok {
		return p.(*vm.Program), nil
	}
	p, err := expr.Compile(src, expr.Env(Env{}.vars()), expr.AllowUndefinedVariables())
	if err != nil {
		return nil, err
	}
	programs.Store(src, p)
	return p, nil
}

// Eval evaluates an expression against the environment.
func (e Env) Eval(src string) (any, error) {
	p, err := compile(src)
	if err != nil {
		return nil, fmt.Errorf("表达式 %q 无效：%v", src, err)
	}
	out, err := vm.Run(p, e.vars())
	if err != nil {
		return nil, fmt.Errorf("表达式 %q 求值失败：%v", src, err)
	}
	return out, nil
}

// Bool evaluates a condition; an empty condition is true.
func (e Env) Bool(src string) (bool, error) {
	if strings.TrimSpace(src) == "" {
		return true, nil
	}
	v, err := e.Eval(src)
	if err != nil {
		return false, err
	}
	b, ok := v.(bool)
	if !ok {
		return false, fmt.Errorf("表达式 %q 的结果不是布尔值", src)
	}
	return b, nil
}

// Value resolves a manifest value: strings starting with "=" are expressions, everything else is literal.
func (e Env) Value(v any) (any, error) {
	s, ok := v.(string)
	if !ok || !strings.HasPrefix(s, "=") {
		return v, nil
	}
	return e.Eval(strings.TrimSpace(s[1:]))
}

// CheckExpr reports whether an expression compiles; used by manifest validation.
func CheckExpr(src string) error {
	_, err := compile(src)
	return err
}

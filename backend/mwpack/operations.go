package mwpack

import (
	"fmt"
	"strings"
)

// InstanceOperations is the component's operations knowledge as it applies to one instance: items whose When is false
// are left out and the placeholders in commands are filled in. Nil when the component declares none.
func (inst *Instance) InstanceOperations(cluster string) *Operations {
	if inst.R == nil || inst.R.C == nil || inst.R.C.Operations == nil {
		return nil
	}
	src := inst.R.C.Operations
	env := inst.Env()
	keep := func(when string) bool {
		on, err := env.Bool(when)
		return on && err == nil
	}
	fill := func(s string) string {
		out := inst.fill(s, cluster)
		root := ""
		mixed := false
		for _, r := range inst.dataRoots {
			if root != "" && r != root {
				mixed = true
			}
			root = r
		}
		if root != "" && root != "/data" && !mixed {
			out = strings.ReplaceAll(out, "/data", root)
		}
		if mixed && strings.Contains(out, "/data") {
			out = "各机器数据根目录不同，请按交付机器表将以下 /data 替换为当前目标机器的根目录后执行：\n" + out
		}
		return out
	}
	items := func(in []OpsItem) []OpsItem {
		var out []OpsItem
		for _, it := range in {
			if keep(it.When) {
				it.When, it.Cmd, it.Expect, it.Note = "", fill(it.Cmd), fill(it.Expect), fill(it.Note)
				out = append(out, it)
			}
		}
		return out
	}
	out := &Operations{Overview: fill(src.Overview), Checks: items(src.Checks), Tasks: items(src.Tasks)}
	for _, f := range src.Faults {
		if !keep(f.When) {
			continue
		}
		steps := make([]string, len(f.Steps))
		for i, st := range f.Steps {
			steps[i] = fill(st)
		}
		f.When, f.Cmd, f.Steps, f.Symptom = "", fill(f.Cmd), steps, fill(f.Symptom)
		out.Faults = append(out.Faults, f)
	}
	for _, l := range src.Logs {
		out.Logs = append(out.Logs, NamedText{l.Name, fill(l.Text)})
	}
	return out
}

// fill puts the instance's values into ${cluster}, ${instance} and ${params.<key>}.
func (inst *Instance) fill(s, cluster string) string {
	if !strings.Contains(s, "${") {
		return s
	}
	s = strings.ReplaceAll(s, "${cluster}", cluster)
	s = strings.ReplaceAll(s, "${instance}", inst.ID)
	for k, v := range inst.Params {
		s = strings.ReplaceAll(s, "${params."+k+"}", fmt.Sprint(v))
	}
	// Fallback to component parameter defaults (e.g. for imported clusters whose raw config params
	// omit catalog deployment param keys like redis_port, data_dir, or maxmemory_policy).
	if strings.Contains(s, "${params.") && inst.R != nil {
		fillFrom := func(ps []Param) {
			for _, p := range ps {
				if p.Key == "" {
					continue
				}
				tok := "${params." + p.Key + "}"
				if !strings.Contains(s, tok) {
					continue
				}
				if p.Default != nil && fmt.Sprint(p.Default) != "" {
					s = strings.ReplaceAll(s, tok, fmt.Sprint(p.Default))
				}
			}
		}
		fillFrom(inst.R.Params)
		if inst.R.C != nil && strings.Contains(s, "${params.") {
			fillFrom(inst.R.C.Params)
		}
	}
	return s
}

// FillText is fill with the instance's own cluster.
func (inst *Instance) FillText(s string) string { return inst.fill(s, inst.cluster) }

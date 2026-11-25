package mwpack_test

import (
	"bytes"
	"delivery-studio/mwpack"
	"testing"
)

func TestDeploymentStepsHaveIndependentStableEntrypoints(t *testing.T) {
	for name, spec := range map[string]string{"etcd": etcdOnly, "postgresql": pgSingle, "redis": redisSingle} {
		t.Run(name, func(t *testing.T) {
			p := mustSolve(t, fullCatalog(t), spec)
			b, err := mwpack.Render(p, mwpack.RenderOptions{})
			if err != nil {
				t.Fatal(err)
			}
			seen := map[string]bool{}
			for _, phase := range b.Steps.Phases {
				for _, s := range phase.Steps {
					if s.Playbook == phase.Playbook || seen[s.Playbook] {
						t.Fatalf("shared entrypoint: %s", s.Playbook)
					}
					seen[s.Playbook] = true
					if len(b.Project[s.Playbook].Data) == 0 {
						t.Fatalf("missing entrypoint: %s", s.Playbook)
					}
				}
			}
			if len(b.Steps.Tests) < 2 {
				return
			}
			a, before := b.Steps.Tests[0], b.Steps.Tests[1]
			inst := p.Instance(a.Instance)
			for i, st := range inst.R.Tests {
				if st.ID == a.ID {
					inst.R.Tests[i].Title += " changed"
				}
			}
			after, err := mwpack.Render(p, mwpack.RenderOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(b.Project[before.Playbook].Data, after.Project[before.Playbook].Data) {
				t.Fatal("editing A changed B")
			}
			// Inserting a new step must not rename existing playbooks.
			st := inst.R.Tests[0]
			st.ID = "new-independent-step"
			st.Run = nil
			st.Tasks = []map[string]any{{"ansible.builtin.debug": map[string]any{"msg": "new"}}}
			inst.R.Tests = append([]mwpack.Step{st}, inst.R.Tests...)
			after, err = mwpack.Render(p, mwpack.RenderOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(b.Project[before.Playbook].Data, after.Project[before.Playbook].Data) {
				t.Fatal("inserting A renamed or modified B")
			}
		})
	}
}

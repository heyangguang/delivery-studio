package mwpack

import "fmt"

// SchemeSummary records the delivered architecture, independent of future catalog edits.
type SchemeSummary struct {
	Source   string          `json:"source,omitempty"`
	Evidence []string        `json:"evidence,omitempty"`
	ID       string          `json:"id,omitempty"`
	Name     string          `json:"name"`
	Nodes    int             `json:"nodes"`
	Topology string          `json:"topology"`
	Contract *SeriesContract `json:"contract"`
}

func (i *Instance) SchemeSummary() *SchemeSummary {
	contract, err := i.SelectedSeries()
	if err != nil || contract == nil {
		return nil
	}
	out := &SchemeSummary{Name: SeriesTitle(contract.Series), Contract: contract}
	for _, preset := range i.R.C.Detail.Presets {
		if preset.Contract == contract {
			out.ID = preset.ID
			out.Name = PresetTitle(i.R.C.Name, preset.ID, preset.Name)
			break
		}
	}
	hosts := map[string]bool{}
	for _, role := range i.R.Roles {
		assigned := i.Roles[role.Name]
		if len(assigned) == 0 {
			continue
		}
		if out.Topology != "" {
			out.Topology += " · "
		}
		title := role.Title
		if title == "" {
			title = role.Name
		}
		out.Topology += fmt.Sprintf("%s × %d", title, len(assigned))
		for _, host := range assigned {
			hosts[host] = true
		}
	}
	out.Nodes = len(hosts)
	return out
}

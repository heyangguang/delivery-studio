package server

import (
	"fmt"
	"gopkg.in/yaml.v3"
	"strings"
)

// splitManifest keeps component identity in the entry and gives each definition
// a single source owner. Existing multi-file manifests are left untouched.
func (files fileSet) splitManifest() error {
	var doc yaml.Node
	if err := yaml.Unmarshal(files["component.yaml"], &doc); err != nil {
		return err
	}
	if len(doc.Content) != 1 {
		return fmt.Errorf("missing manifest")
	}
	root := doc.Content[0]
	save := func(n *yaml.Node, path string) error {
		if n.Kind == yaml.MappingNode && len(n.Content) > 0 && n.Content[0].Value == "$file" {
			return nil
		}
		if _, exists := files[path]; exists {
			return fmt.Errorf("fragment already exists: %s", path)
		}
		b, err := yaml.Marshal(n)
		if err != nil {
			return err
		}
		files[path] = b
		*n = yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Style: yaml.FlowStyle, Content: []*yaml.Node{{Kind: yaml.ScalarNode, Tag: "!!str", Value: "$file"}, {Kind: yaml.ScalarNode, Tag: "!!str", Value: path}}}
		return nil
	}
	id := func(n *yaml.Node) string {
		for i := 0; i+1 < len(n.Content); i += 2 {
			if n.Content[i].Value == "id" {
				return n.Content[i+1].Value
			}
		}
		return ""
	}
	for i := 0; i+1 < len(root.Content); i += 2 {
		key, n := root.Content[i].Value, root.Content[i+1]
		switch key {
		case "params", "roles", "groups", "rules", "requires", "companions", "ports", "endpoints", "inputs", "secrets", "addons", "versions", "operations":
			if err := save(n, "manifest/common/"+key+".yaml"); err != nil {
				return err
			}
		case "detail":
			for j := 0; j+1 < len(n.Content); j += 2 {
				if n.Content[j].Value == "presets" {
					for _, p := range n.Content[j+1].Content {
						v := id(p)
						if v != "" && !strings.ContainsAny(v, "/\\.") {
							if err := save(p, "manifest/schemes/"+v+".yaml"); err != nil {
								return err
							}
						}
					}
				}
			}
		case "lifecycle", "changes":
			for j := 0; j+1 < len(n.Content); j += 2 {
				if n.Content[j].Value == "$file" {
					break
				}
				if err := save(n.Content[j+1], "manifest/actions/"+key+"/"+n.Content[j].Value+".yaml"); err != nil {
					return err
				}
			}
		case "tests", "cleanup":
			for _, p := range n.Content {
				v := id(p)
				if v != "" && !strings.ContainsAny(v, "/\\.") {
					if err := save(p, "manifest/actions/"+key+"/"+v+".yaml"); err != nil {
						return err
					}
				}
			}
		}
	}
	b, err := yaml.Marshal(&doc)
	if err != nil {
		return err
	}
	files["component.yaml"] = b
	return nil
}

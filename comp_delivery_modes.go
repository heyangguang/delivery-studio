package main

import (
	"fmt"
	"gopkg.in/yaml.v3"
)

func setDeliveryModes(files fileSet, modes []string) error {
	var doc yaml.Node
	if e := yaml.Unmarshal(files["component.yaml"], &doc); e != nil {
		return e
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("component.yaml 必须是有效的组件定义")
	}
	root := doc.Content[0]
	var node yaml.Node
	_ = node.Encode(modes)
	found := false
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == "delivery_modes" {
			root.Content[i+1] = &node
			found = true
			break
		}
	}
	if !found {
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "delivery_modes"}, &node)
	}
	b, e := yaml.Marshal(&doc)
	if e == nil {
		files["component.yaml"] = b
	}
	return e
}

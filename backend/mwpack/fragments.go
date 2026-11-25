package mwpack

import (
	"bytes"
	"fmt"
	"gopkg.in/yaml.v3"
	"io"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// ExpandManifest resolves explicit component-relative $file references. Each
// fragment has one owner; aliases, cycles, traversal and repeated ownership are
// rejected. Source locations remain attached to nodes for workbench errors.
func ExpandManifest(read func(string) ([]byte, error)) (*yaml.Node, map[*yaml.Node]string, error) {
	origins := map[*yaml.Node]string{}
	seen := map[string]bool{}
	total := 0
	var load func(string, int) (*yaml.Node, error)
	var visit func(*yaml.Node, string, int) error
	visit = func(n *yaml.Node, file string, depth int) error {
		origins[n] = file
		if n.Kind == yaml.AliasNode {
			return fmt.Errorf("%s:%d：清单分片不支持 YAML 别名", file, n.Line)
		}
		if n.Kind == yaml.MappingNode {
			keys := map[string]bool{}
			for i := 0; i < len(n.Content); i += 2 {
				key := n.Content[i].Value
				if keys[key] {
					return fmt.Errorf("%s:%d：重复字段 %s", file, n.Content[i].Line, key)
				}
				keys[key] = true
				if key == "$file" {
					if len(n.Content) != 2 || n.Content[1].Kind != yaml.ScalarNode {
						return fmt.Errorf("%s:%d：$file 必须独占一个映射", file, n.Line)
					}
					ref := n.Content[1].Value
					if !strings.HasPrefix(ref, "manifest/") || path.Clean(ref) != ref || strings.Contains(ref, "..") || !strings.HasSuffix(ref, ".yaml") {
						return fmt.Errorf("%s:%d：分片路径必须是 manifest/ 下的 .yaml 相对路径", file, n.Line)
					}
					child, err := load(ref, depth+1)
					if err != nil {
						return err
					}
					*n = *child
					origins[n] = ref
					return nil
				}
			}
		}
		for _, child := range n.Content {
			if err := visit(child, file, depth); err != nil {
				return err
			}
		}
		return nil
	}
	load = func(file string, depth int) (*yaml.Node, error) {
		if depth > 12 || seen[file] {
			return nil, fmt.Errorf("%s：循环引用或重复归属", file)
		}
		seen[file] = true
		b, err := read(file)
		if err != nil {
			return nil, fmt.Errorf("%s：%w", file, err)
		}
		total += len(b)
		if total > 8<<20 {
			return nil, fmt.Errorf("组件清单超过 8 MiB")
		}
		var doc yaml.Node
		decoder := yaml.NewDecoder(bytes.NewReader(b))
		if err := decoder.Decode(&doc); err != nil {
			return nil, fmt.Errorf("%s：%w", file, err)
		}
		var extra yaml.Node
		if err := decoder.Decode(&extra); err != io.EOF {
			return nil, fmt.Errorf("%s：只允许一个 YAML 文档", file)
		}
		if len(doc.Content) != 1 {
			return nil, fmt.Errorf("%s：需要一个 YAML 文档", file)
		}
		n := doc.Content[0]
		if err := visit(n, file, depth); err != nil {
			return nil, err
		}
		return n, nil
	}
	root, err := load("component.yaml", 0)
	if err != nil {
		return nil, nil, err
	}
	return &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{root}}, origins, nil
}

func ParseComponentFiles(read func(string) ([]byte, error)) (*Component, error) {
	doc, origins, err := ExpandManifest(read)
	if err != nil {
		return nil, err
	}
	b, err := yaml.Marshal(doc)
	if err != nil {
		return nil, err
	}
	component, parseErr := ParseComponent(b)
	if parseErr != nil {
		match := regexp.MustCompile("line ([0-9]+)").FindStringSubmatch(parseErr.Error())
		if len(match) > 1 {
			line, _ := strconv.Atoi(match[1])
			var generated yaml.Node
			if yaml.Unmarshal(b, &generated) == nil {
				var source *yaml.Node
				var walk func(*yaml.Node, *yaml.Node)
				walk = func(original, current *yaml.Node) {
					if current.Line == line {
						source = original
					}
					for i, child := range current.Content {
						if i < len(original.Content) {
							walk(original.Content[i], child)
						}
					}
				}
				walk(doc, &generated)
				if source != nil && origins[source] != "" {
					return nil, &ManifestSourceError{File: origins[source], Line: source.Line, Err: parseErr}
				}
			}
		}
	}
	return component, parseErr
}

// ManifestSourceError locates strict decoder errors in the author's fragment.
type ManifestSourceError struct {
	File string
	Line int
	Err  error
}

func (e *ManifestSourceError) Error() string { return fmt.Sprintf("%s:%d：%v", e.File, e.Line, e.Err) }
func (e *ManifestSourceError) Unwrap() error { return e.Err }

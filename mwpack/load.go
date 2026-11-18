package mwpack

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
	"testing/fstest"

	"gopkg.in/yaml.v3"
)

// Catalog holds every loaded component. Components live in <name>/component.yaml, with Ansible roles in <name>/roles/.
type Catalog struct {
	platform fstest.MapFS
	byName   map[string]*Component
}

// LoadCatalog reads all components under the root of each fsys (later ones win on a name clash) and
// statically validates them.
func LoadCatalog(sources ...fs.FS) (*Catalog, error) {
	cat := &Catalog{byName: map[string]*Component{}}
	var problems []string
	for _, fsys := range sources {
		entries, err := fs.ReadDir(fsys, ".")
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			data, err := fs.ReadFile(fsys, path.Join(e.Name(), "component.yaml"))
			if err != nil {
				continue
			}
			c, err := ParseComponentFiles(func(file string) ([]byte, error) { return fs.ReadFile(fsys, path.Join(e.Name(), file)) })
			if err != nil {
				problems = append(problems, fmt.Sprintf("%s：%v", e.Name(), err))
				continue
			}
			if c.Name != e.Name() {
				problems = append(problems, fmt.Sprintf("%s：目录名与组件名 %q 不一致", e.Name(), c.Name))
				continue
			}
			if canonical, marshalErr := yaml.Marshal(c); marshalErr == nil {
				data = canonical
			}

			sum := sha256.Sum256(data)
			c.sum = hex.EncodeToString(sum[:])
			c.dir = e.Name()
			c.fsys = fsys
			cat.byName[c.Name] = c
		}
	}
	for _, name := range cat.Names() {
		for _, p := range ValidateComponent(cat.byName[name], cat) {
			if p.Severity == "error" {
				problems = append(problems, name+"："+p.Message)
			}
		}
	}
	if len(problems) > 0 {
		return cat, fmt.Errorf("组件清单有 %d 处错误：\n  %s", len(problems), join(problems, "\n  "))
	}
	return cat, nil
}

func join(s []string, sep string) string {
	var b bytes.Buffer
	for i, x := range s {
		if i > 0 {
			b.WriteString(sep)
		}
		b.WriteString(x)
	}
	return b.String()
}

// ParseComponent reads one manifest; unknown keys are rejected so typos do not silently disappear.
func ParseComponent(data []byte) (*Component, error) {
	var c Component
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("清单无法解析：%v", err)
	}
	if c.Schema != ComponentSchema {
		return nil, fmt.Errorf("不支持的清单版本 %q，需要 %s", c.Schema, ComponentSchema)
	}
	return &c, nil
}

func (c *Catalog) Get(name string) (*Component, bool) {
	x, ok := c.byName[name]
	return x, ok
}

func (c *Catalog) Names() []string {
	names := make([]string, 0, len(c.byName))
	for n := range c.byName {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// Providers lists components that provide a capability, by name.
func (c *Catalog) Providers(capability string) []*Component {
	var out []*Component
	for _, n := range c.Names() {
		for _, p := range c.byName[n].Provides {
			if p == capability {
				out = append(out, c.byName[n])
				break
			}
		}
	}
	return out
}

// FS gives access to the files of a component (roles, templates).
func (c *Component) FS() (fs.FS, string) { return c.fsys, c.dir }

// AttachFS binds a filesystem root to a parsed component so step-ownership checks can inspect its files.
func (c *Component) AttachFS(fsys fs.FS, dir string) {
	c.fsys = fsys
	c.dir = dir
}

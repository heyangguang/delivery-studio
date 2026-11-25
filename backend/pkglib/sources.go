// Package pkglib is the platform's package library: where packages come from (sources), what has been fetched
// (the library on disk), and how a delivery's offline repository is assembled from it. Resolving dependencies
// happens once, when the library is prepared, inside a container of the target operating system; assembling a
// delivery only looks files up, so it needs neither containers nor network.
package pkglib

import (
	"bytes"
	"embed"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

//go:embed sources.yaml keys/*
var builtin embed.FS

// Source is one place packages can be downloaded from.
type Source struct {
	ID         string   `yaml:"id" json:"id"`
	Title      string   `yaml:"title" json:"title"`
	Platforms  []string `yaml:"platforms" json:"platforms"`
	Kind       string   `yaml:"kind" json:"kind"` // apt | rpm
	URL        string   `yaml:"url" json:"url,omitempty"`
	Suites     []string `yaml:"suites" json:"suites,omitempty"`
	Components []string `yaml:"components" json:"components,omitempty"`
	BaseURL    string   `yaml:"baseurl" json:"baseurl,omitempty"`
	KeyFile    string   `yaml:"key_file" json:"key_file,omitempty"`
	Disabled   bool     `yaml:"disabled" json:"disabled,omitempty"`
	// Builtin is set on sources shipped with the platform and not replaced by the administrator.
	Builtin bool `yaml:"-" json:"builtin"`
}

var idRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,60}$`)

func (s Source) validate() error {
	if !idRE.MatchString(s.ID) {
		return fmt.Errorf("软件源 id %q 无效", s.ID)
	}
	if len(s.Platforms) == 0 {
		return fmt.Errorf("软件源 %s 没有适用的系统", s.ID)
	}
	check := func(raw string) error {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || strings.ContainsAny(raw, " \t\r\n'\"") {
			return fmt.Errorf("软件源 %s 的地址 %q 须是 http(s) 地址", s.ID, raw)
		}
		return nil
	}
	switch s.Kind {
	case "apt":
		if err := check(s.URL); err != nil {
			return err
		}
		if len(s.Suites) == 0 || len(s.Components) == 0 {
			return fmt.Errorf("apt 软件源 %s 需要 suites 与 components", s.ID)
		}
		for _, v := range append(append([]string{}, s.Suites...), s.Components...) {
			if v == "" || strings.ContainsAny(v, " \t\r\n'\"/") {
				return fmt.Errorf("apt 软件源 %s 的 suites/components 含无效值 %q", s.ID, v)
			}
		}
	case "rpm":
		if err := check(s.BaseURL); err != nil {
			return err
		}
	default:
		return fmt.Errorf("软件源 %s 的类型须为 apt 或 rpm", s.ID)
	}
	if s.KeyFile != "" && (strings.ContainsAny(s.KeyFile, "/\\") || strings.HasPrefix(s.KeyFile, ".")) {
		return fmt.Errorf("软件源 %s 的 key_file 只能是文件名", s.ID)
	}
	return nil
}

// ParseSources reads a YAML source list; unknown fields are rejected so typos do not silently vanish.
func ParseSources(data []byte) ([]Source, error) {
	var out []Source
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&out); err != nil && err.Error() != "EOF" {
		return nil, fmt.Errorf("软件源无法解析：%v", err)
	}
	seen := map[string]bool{}
	for _, s := range out {
		if err := s.validate(); err != nil {
			return nil, err
		}
		if seen[s.ID] {
			return nil, fmt.Errorf("软件源 id 重复：%s", s.ID)
		}
		seen[s.ID] = true
	}
	return out, nil
}

// Sources is the effective list: built-in sources, with administrator definitions replacing those of the same id.
type Sources struct {
	List []Source
	// Custom is the administrator's file content, as saved.
	Custom []Source
	path   string
}

// LoadSources reads the built-in list and the administrator's file (which may not exist).
func LoadSources(customPath string) (*Sources, error) {
	data, err := builtin.ReadFile("sources.yaml")
	if err != nil {
		return nil, err
	}
	base, err := ParseSources(data)
	if err != nil {
		return nil, fmt.Errorf("内置软件源：%w", err)
	}
	s := &Sources{path: customPath}
	if customPath != "" {
		if b, err := os.ReadFile(customPath); err == nil {
			if s.Custom, err = ParseSources(b); err != nil {
				return nil, err
			}
		}
	}
	over := map[string]Source{}
	for _, c := range s.Custom {
		over[c.ID] = c
	}
	for _, b := range base {
		if c, ok := over[b.ID]; ok {
			s.List = append(s.List, c)
			delete(over, b.ID)
			continue
		}
		b.Builtin = true
		s.List = append(s.List, b)
	}
	for _, c := range s.Custom {
		if _, ok := over[c.ID]; ok {
			s.List = append(s.List, c)
		}
	}
	return s, nil
}

// ForPlatform lists the enabled sources for a platform.
func (s *Sources) ForPlatform(platform string) []Source {
	var out []Source
	for _, x := range s.List {
		if x.Disabled {
			continue
		}
		for _, p := range x.Platforms {
			if p == platform {
				out = append(out, x)
				break
			}
		}
	}
	return out
}

// Key returns the content of a source's key file: one the administrator placed beside the source file wins over a
// built-in one.
func (s *Sources) Key(name string) ([]byte, error) {
	if name == "" {
		return nil, nil
	}
	if s.path != "" {
		if b, err := os.ReadFile(strings.TrimSuffix(s.path, ".yaml") + ".keys/" + name); err == nil {
			return b, nil
		}
	}
	return builtin.ReadFile("keys/" + name)
}

// Save writes the administrator's source list. The list is validated first.
func (s *Sources) Save(data []byte) error {
	if s.path == "" {
		return fmt.Errorf("未配置软件源文件位置")
	}
	if _, err := ParseSources(data); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// BuiltinYAML returns the shipped list, as a starting point for editing.
func BuiltinYAML() string {
	b, _ := builtin.ReadFile("sources.yaml")
	return string(b)
}

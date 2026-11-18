package main

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// RuntimeInfo describes the offline Ansible runtime a platform ships to controllers, read from the archive itself so
// the page shows what is really inside: which ansible-core, what the controller must run, and the wheels it carries.
type RuntimeInfo struct {
	File       string           `json:"file"`
	Bundle     string           `json:"bundle,omitempty"` // the release the archive was built as, from its .sha256
	Size       int64            `json:"size"`
	SHA256     string           `json:"sha256,omitempty"`
	Ansible    string           `json:"ansible,omitempty"`
	Python     string           `json:"python,omitempty"`
	Controller string           `json:"controller,omitempty"`
	Packages   []RuntimePackage `json:"packages"`
}

type RuntimePackage struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

var (
	wheelRE  = regexp.MustCompile(`/wheels/([A-Za-z0-9_.]+)-([0-9][^-]*)-[^/]*\.whl$`)
	pyRE     = regexp.MustCompile(`version_info\[:2\]\s*==\s*\((\d+),\s*(\d+)\)`)
	osIDRE   = regexp.MustCompile(`\$ID\s*==\s*([a-z]+)`)
	osVerRE  = regexp.MustCompile(`\$VERSION_ID\s*==\s*([0-9.]+)`)
	archRE   = regexp.MustCompile(`uname -m\)\s*==\s*([a-z0-9_]+)`)
	runtimes sync.Map // path -> cachedRuntime
)

type cachedRuntime struct {
	mod  time.Time
	size int64
	info *RuntimeInfo
}

// readRuntimeInfo opens the runtime archive once per change and remembers what it found.
func readRuntimeInfo(path string) *RuntimeInfo {
	st, err := os.Stat(path)
	if err != nil || !st.Mode().IsRegular() {
		return nil
	}
	if c, ok := runtimes.Load(path); ok {
		if c := c.(cachedRuntime); c.mod.Equal(st.ModTime()) && c.size == st.Size() {
			return c.info
		}
	}
	info := &RuntimeInfo{File: filepath.Base(path), Size: st.Size(), Packages: []RuntimePackage{}}
	if b, err := os.ReadFile(path + ".sha256"); err == nil {
		if f := strings.Fields(string(b)); len(f) >= 2 {
			info.SHA256 = f[0]
			info.Bundle = strings.TrimSuffix(strings.TrimSuffix(f[1], ".gz"), ".tar")
		}
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return nil
	}
	tr := tar.NewReader(zr)
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		if m := wheelRE.FindStringSubmatch(h.Name); m != nil {
			name := strings.ReplaceAll(strings.ToLower(m[1]), "_", "-")
			info.Packages = append(info.Packages, RuntimePackage{name, m[2]})
			if name == "ansible-core" {
				info.Ansible = m[2]
			}
			continue
		}
		if strings.HasSuffix(h.Name, "/runtime.json") && h.Size < 1<<16 {
			var meta struct{ Controller, Python, Ansible string }
			if b, _ := io.ReadAll(io.LimitReader(tr, 1<<16)); json.Unmarshal(b, &meta) == nil {
				info.Controller, info.Python = meta.Controller, meta.Python
				if info.Ansible == "" {
					info.Ansible = meta.Ansible
				}
			}
			continue
		}
		if strings.HasSuffix(h.Name, "/bootstrap/bootstrap-ansible.sh") && info.Controller == "" && h.Size < 1<<20 {
			b, _ := io.ReadAll(io.LimitReader(tr, 1<<20))
			s := string(b)
			if m := pyRE.FindStringSubmatch(s); m != nil {
				info.Python = m[1] + "." + m[2]
			}
			var parts []string
			if m := osIDRE.FindStringSubmatch(s); m != nil {
				parts = append(parts, strings.ToUpper(m[1][:1])+m[1][1:])
			}
			if m := osVerRE.FindStringSubmatch(s); m != nil {
				parts = append(parts, m[1])
			}
			if m := archRE.FindStringSubmatch(s); m != nil {
				parts = append(parts, strings.ReplaceAll(m[1], "x86_64", "amd64"))
			}
			info.Controller = strings.Join(parts, " ")
		}
	}
	sort.Slice(info.Packages, func(i, j int) bool { return info.Packages[i].Name < info.Packages[j].Name })
	runtimes.Store(path, cachedRuntime{st.ModTime(), st.Size(), info})
	return info
}

package ansiblev2

import (
	"embed"
	"io/fs"
	"sort"
	"strings"
)

//go:embed all:builtin
var builtinFS embed.FS

// BuiltinNames returns all embedded 2.0 pure-Ansible benchmark component names.
func BuiltinNames() []string {
	entries, err := fs.ReadDir(builtinFS, "builtin")
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// LoadBuiltinFiles reads an embedded 2.0 pure-Ansible component's complete file tree.
func LoadBuiltinFiles(name string) (map[string][]byte, bool) {
	root := "builtin/" + strings.TrimSpace(name)
	if _, err := fs.Stat(builtinFS, root); err != nil {
		return nil, false
	}
	files := map[string][]byte{}
	_ = fs.WalkDir(builtinFS, root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		b, rerr := fs.ReadFile(builtinFS, p)
		if rerr != nil {
			return nil
		}
		rel := strings.TrimPrefix(p, root+"/")
		files[rel] = b
		return nil
	})
	if len(files) == 0 {
		return nil, false
	}
	return files, true
}

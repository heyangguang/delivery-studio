package server

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"delivery-studio/mwpack"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// A component is a set of files: component.yaml, and roles/, templates/ and files/ beside it. The workbench edits such
// a set as a whole, so that what is checked, previewed and published is exactly what was edited.

const (
	maxFileBytes  = 512 << 10
	maxFilesTotal = 400
)

type fileSet map[string][]byte

var filePathRE = regexp.MustCompile(`^[A-Za-z0-9._@+-]+(/[A-Za-z0-9._@+-]+)*$`)

// validFilePath says whether a path may be part of a component, and why not.
func validFilePath(p string) error {
	if p == "component.yaml" {
		return nil
	}
	if !filePathRE.MatchString(p) || strings.Contains(p, "..") || len(p) > 200 {
		return fmt.Errorf("文件路径「%s」不合规：只能用字母、数字和 . _ - @ +，不能含 ..", p)
	}
	top := strings.SplitN(p, "/", 2)[0]
	if !allowedPackDirs[top] || !strings.Contains(p, "/") {
		return fmt.Errorf("文件 %q 不在允许的位置（只能放在 manifest/、roles/、templates/、files/ 下，或是 component.yaml）", p)
	}
	return nil
}

func (s fileSet) clone() fileSet {
	out := make(fileSet, len(s))
	for k, v := range s {
		out[k] = append([]byte(nil), v...)
	}
	return out
}

func (s fileSet) paths() []string {
	out := make([]string, 0, len(s))
	for p := range s {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// isText reports whether a file can be shown and edited as text.
func isText(b []byte) bool { return utf8.Valid(b) && !bytes.Contains(b, []byte{0}) }

// check enforces the size limits and path rules on a whole set.
func (s fileSet) check() error {
	if _, ok := s["component.yaml"]; !ok {
		return errors.New("缺少 component.yaml")
	}
	if len(s) > maxFilesTotal {
		return fmt.Errorf("文件超过 %d 个", maxFilesTotal)
	}
	var total int
	for p, b := range s {
		if err := validFilePath(p); err != nil {
			return err
		}
		if len(b) > maxFileBytes {
			return fmt.Errorf("%s 超过 %d KiB", p, maxFileBytes>>10)
		}
		if total += len(b); total > maxPackBytes {
			return errors.New("组件总大小超过 8 MiB")
		}
	}
	return nil
}

// readFileSet reads every file of a component directory from any filesystem.
func readFileSet(fsys fs.FS, dir string) (fileSet, error) {
	out := fileSet{}
	err := fs.WalkDir(fsys, dir, func(fp string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(fp, dir), "/")
		if strings.Contains(rel, "__pycache__") || strings.HasSuffix(rel, ".pyc") {
			return nil
		}
		b, err := fs.ReadFile(fsys, fp)
		if err != nil {
			return err
		}
		out[rel] = b
		return nil
	})
	return out, err
}

func readFileSetDir(dir string) (fileSet, error) { return readFileSet(os.DirFS(dir), ".") }

// writeFileSet writes a set into a directory that must not exist yet.
func writeFileSet(dir string, s fileSet) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for p, b := range s {
		if err := validFilePath(p); err != nil {
			return err
		}
		dest := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			return err
		}
		mode := os.FileMode(0o600)
		if strings.HasSuffix(p, ".sh") || strings.HasSuffix(p, ".py") {
			mode = 0o700
		}
		if err := os.WriteFile(dest, b, mode); err != nil {
			return err
		}
	}
	return nil
}

// fileKind tells the editor how to treat a file.
func fileKind(p string) string {
	switch {
	case p == "component.yaml":
		return "manifest"
	case strings.HasSuffix(p, ".j2"):
		return "template"
	case strings.HasSuffix(p, ".yml"), strings.HasSuffix(p, ".yaml"):
		return "yaml"
	case strings.HasSuffix(p, ".py"):
		return "python"
	case strings.HasSuffix(p, ".sh"):
		return "shell"
	}
	return "text"
}

// diffSets lists what differs between two sets: added, removed and changed paths.
func diffSets(from, to fileSet) (added, removed, changed []string) {
	for p, b := range to {
		old, ok := from[p]
		switch {
		case !ok:
			added = append(added, p)
		case !bytes.Equal(old, b):
			changed = append(changed, p)
		}
	}
	for p := range from {
		if _, ok := to[p]; !ok {
			removed = append(removed, p)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	sort.Strings(changed)
	return
}

// lineDiff is a compact unified-style line diff of two texts, with a few lines of context. It is meant for showing a
// person what changed in a file, so it stops growing after maxLines lines.
func lineDiff(a, b string, maxLines int) string {
	x, y := strings.Split(a, "\n"), strings.Split(b, "\n")
	n, m := len(x), len(y)
	if n*m > 4_000_000 {
		return "（文件太大，不显示逐行差异）"
	}
	lcs := make([][]int32, n+1)
	for i := range lcs {
		lcs[i] = make([]int32, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if x[i] == y[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}
	type row struct {
		op   byte
		text string
	}
	var rows []row
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case x[i] == y[j]:
			rows = append(rows, row{' ', x[i]})
			i++
			j++
		case lcs[i+1][j] >= lcs[i][j+1]:
			rows = append(rows, row{'-', x[i]})
			i++
		default:
			rows = append(rows, row{'+', y[j]})
			j++
		}
	}
	for ; i < n; i++ {
		rows = append(rows, row{'-', x[i]})
	}
	for ; j < m; j++ {
		rows = append(rows, row{'+', y[j]})
	}
	keep := make([]bool, len(rows))
	const ctx = 2
	for k, r := range rows {
		if r.op != ' ' {
			for d := -ctx; d <= ctx; d++ {
				if k+d >= 0 && k+d < len(rows) {
					keep[k+d] = true
				}
			}
		}
	}
	var out strings.Builder
	skipped := false
	lines := 0
	for k, r := range rows {
		if !keep[k] {
			skipped = true
			continue
		}
		if skipped && out.Len() > 0 {
			out.WriteString("…\n")
		}
		skipped = false
		out.WriteString(string(r.op) + " " + r.text + "\n")
		if lines++; lines >= maxLines {
			out.WriteString("…（差异太长，已截断）\n")
			break
		}
	}
	return out.String()
}

var _ = path.Join

func (s fileSet) manifestRead(name string) ([]byte, error) {
	b, ok := s[name]
	if !ok {
		return nil, fmt.Errorf("引用文件不存在")
	}
	return b, nil
}
func (s fileSet) component() (*mwpack.Component, error) {
	return mwpack.ParseComponentFiles(s.manifestRead)
}

// syncSharedFiles updates or prunes top-level shared_files entries in component.yaml when component files are
// renamed or deleted. It leaves component.yaml untouched unless a declared shared file actually moved or disappeared.
func syncSharedFiles(files fileSet, renamed map[string]string, deleted map[string]bool) bool {
	if len(renamed) == 0 && len(deleted) == 0 {
		return false
	}
	raw, ok := files["component.yaml"]
	if !ok {
		return false
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return false
	}
	root := doc.Content[0]
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value != "shared_files" || root.Content[i+1].Kind != yaml.SequenceNode {
			continue
		}
		seq := root.Content[i+1]
		changed := false
		kept := make([]*yaml.Node, 0, len(seq.Content))
		seen := map[string]bool{}
		for _, item := range seq.Content {
			val := item.Value
			if deleted[val] {
				changed = true
				continue
			}
			if to, moved := renamed[val]; moved && to != "" {
				cp := *item
				cp.Value = to
				item = &cp
				val = to
				changed = true
			}
			if seen[val] {
				changed = true
				continue
			}
			seen[val] = true
			kept = append(kept, item)
		}
		if !changed {
			return false
		}
		if len(kept) == 0 {
			root.Content = append(root.Content[:i], root.Content[i+2:]...)
		} else {
			seq.Content = kept
		}
		if b, err := yaml.Marshal(&doc); err == nil {
			files["component.yaml"] = b
			return true
		}
		return false
	}
	return false
}

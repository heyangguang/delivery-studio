package catalog

import (
	"io/fs"
	"path"
	"regexp"
	"strings"
	"testing"
)

var includeRe = regexp.MustCompile(`(?m)^\s*(?:ansible\.builtin\.)?(?:include_tasks|import_tasks):\s*"?([A-Za-z0-9_./-]+\.yml)"?\s*$`)

// A task file that includes another one by name must find it in the built-in component, or the step fails on the
// machine with "Could not find or access". Go's embed drops files starting with "_" unless told otherwise.
func TestEveryIncludedTaskFileIsEmbedded(t *testing.T) {
	checked := 0
	err := fs.WalkDir(FS, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".yml") || !strings.Contains(p, "/tasks/") {
			return err
		}
		b, err := fs.ReadFile(FS, p)
		if err != nil {
			return err
		}
		for _, m := range includeRe.FindAllStringSubmatch(string(b), -1) {
			target := path.Join(path.Dir(p), m[1])
			if _, err := fs.Stat(FS, target); err != nil {
				t.Errorf("%s includes %s, which is not in the built-in component", p, m[1])
			}
			checked++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked < 6 {
		t.Fatalf("only %d includes found; the pattern no longer matches the tasks", checked)
	}
}

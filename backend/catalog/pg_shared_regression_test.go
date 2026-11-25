package catalog_test

import (
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"

	"delivery-studio/catalog"
	"delivery-studio/mwpack"
)

func TestRealPostgreSQLOverrideWithClonefromTagsLoadsCleanly(t *testing.T) {
	mem := fstest.MapFS{}
	err := fs.WalkDir(catalog.FS, "postgresql", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(catalog.FS, p)
		if err != nil {
			return err
		}
		mem[p] = &fstest.MapFile{Data: b, Mode: 0o600}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	orig := strings.ReplaceAll(string(mem["postgresql/component.yaml"].Data), "\r\n", "\n")
	if !strings.Contains(orig, "shared_files:\n") {
		t.Fatal("expected shared_files in postgresql/component.yaml")
	}
	mem["postgresql/component.yaml"] = &fstest.MapFile{
		Data: []byte(strings.Replace(orig, "shared_files:\n", "shared_files:\n    - roles/postgresql/tasks/clonefrom_tags.yml\n", 1)),
		Mode: 0o600,
	}
	cat, err := mwpack.LoadCatalog(catalog.FS, mem)
	if err != nil {
		t.Fatalf("LoadCatalog failed on postgresql override with stale clonefrom_tags.yml: %v", err)
	}
	pg, ok := cat.Get("postgresql")
	if !ok {
		t.Fatal("postgresql missing from catalog")
	}
	probs := mwpack.ValidateStepOwnership(pg)
	warns := 0
	for _, pr := range probs {
		if pr.Severity == "error" {
			t.Fatalf("unexpected error problem: %+v", pr)
		}
		if pr.Severity == "warning" && pr.Path == "shared_files" && strings.Contains(pr.Message, "clonefrom_tags.yml") {
			warns++
		}
	}
	if warns != 1 {
		t.Fatalf("expected exactly 1 shared_files warning for clonefrom_tags.yml, got %d (%+v)", warns, probs)
	}
}

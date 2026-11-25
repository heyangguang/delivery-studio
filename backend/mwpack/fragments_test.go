package mwpack

import (
	"errors"
	"fmt"
	"testing"
)

func TestManifestFragmentSafety(t *testing.T) {
	base := map[string]string{"component.yaml": "schema: mwpack/v1\ncomponent: demo\nparams: {$file: manifest/params.yaml}\n", "manifest/params.yaml": "- {key: port, type: int, default: 1234}\n"}
	read := func(name string) ([]byte, error) {
		v, ok := base[name]
		if !ok {
			return nil, fmt.Errorf("missing")
		}
		return []byte(v), nil
	}
	c, err := ParseComponentFiles(read)
	if err != nil || len(c.Params) != 1 {
		t.Fatal(c, err)
	}
	for _, text := range []string{"{$file: ../escape.yaml}", "{$file: manifest/missing.yaml}", "{$file: manifest/params.yaml, extra: true}", "{$file: manifest/cycle.yaml}"} {
		base["component.yaml"] = "schema: mwpack/v1\ncomponent: demo\nparams: " + text + "\n"
		base["manifest/cycle.yaml"] = "{$file: manifest/cycle.yaml}"
		if _, err := ParseComponentFiles(read); err == nil {
			t.Fatal("accepted", text)
		}
	}
	for _, bad := range []string{
		"component: demo\ncomponent: again\n",
		"component: demo\n---\ncomponent: hidden\n",
		"a: {$file: manifest/params.yaml}\nb: {$file: manifest/params.yaml}\n",
		"a: &a {k: v}\nb: *a\n",
	} {
		base["component.yaml"] = bad
		if _, _, err := ExpandManifest(read); err == nil {
			t.Fatalf("accepted unsafe manifest: %s", bad)
		}
	}
}

func TestFragmentUnknownFieldSource(t *testing.T) {
	files := map[string]string{"component.yaml": "schema: mwpack/v1\ncomponent: demo\nparams: {$file: manifest/params.yaml}\n", "manifest/params.yaml": "- key: port\n  type: int\n  mystery: 123\n"}
	_, err := ParseComponentFiles(func(name string) ([]byte, error) { return []byte(files[name]), nil })
	var source *ManifestSourceError
	if !errors.As(err, &source) || source.File != "manifest/params.yaml" || source.Line != 3 {
		t.Fatal(err)
	}
}

package main

import (
	"gopkg.in/yaml.v3"
	"middleware-deployer/mwpack"
	"testing"
)

func expandedTestManifest(t *testing.T, files fileSet) []byte {
	t.Helper()
	doc, _, err := mwpack.ExpandManifest(files.manifestRead)
	if err != nil {
		t.Fatal(err)
	}
	b, err := yaml.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

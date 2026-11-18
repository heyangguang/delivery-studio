package main

import (
	"encoding/json"
	"gopkg.in/yaml.v3"
	"middleware-deployer/mwpack"
	"strings"
	"testing"
)

func TestComponentReadManifestExpandsAllFragments(t *testing.T) {
	s, _ := testStore(t)
	admin, _ := storeLogin(t, s, "admin")
	for _, name := range s.plat.cat().Names() {
		t.Run(name, func(t *testing.T) {
			files, _, err := s.comps().liveSet(name)
			if err != nil {
				t.Fatal(err)
			}
			before := string(files["component.yaml"])
			r := storeRequest(s, "GET", "/api/components/"+name+"/manifest", nil, admin, "")
			if r.Code != 200 {
				t.Fatal(r.Code, r.Body.String())
			}
			var body struct{ YAML string }
			if err = json.Unmarshal(r.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(body.YAML, "$file:") {
				t.Fatal("reader received unresolved fragment")
			}
			c, err := mwpack.ParseComponent([]byte(body.YAML))
			if err != nil {
				t.Fatal(err)
			}
			original, err := files.component()
			if err != nil {
				t.Fatal(err)
			}
			a, _ := yaml.Marshal(c)
			b, _ := yaml.Marshal(original)
			if string(a) != string(b) {
				t.Fatal("reader lost manifest data")
			}
			after, _, _ := s.comps().liveSet(name)
			if string(after["component.yaml"]) != before {
				t.Fatal("read rewrote source")
			}
		})
	}
}

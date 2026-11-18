package main

import (
	"os"
	"regexp"
	"slices"
	"testing"

	"middleware-deployer/mwpack"
)

// The logos and tints a component may name are drawn by the front end; the two lists must be the same.
func TestComponentStyleListsMatchFrontend(t *testing.T) {
	b, err := os.ReadFile("frontend/src/glyphs.tsx")
	if err != nil {
		t.Skip("front end sources not present")
	}
	ids := func(block string) []string {
		start := regexp.MustCompile(block).FindIndex(b)
		if start == nil {
			t.Fatalf("%s not found in glyphs.tsx", block)
		}
		rest := b[start[1]:]
		end := regexp.MustCompile(`(?m)^\];`).FindIndex(rest)
		var out []string
		for _, m := range regexp.MustCompile(`(?m)^\s*(?:\{\s*)?id: "([a-z]+)"`).FindAllSubmatch(rest[:end[0]], -1) {
			out = append(out, string(m[1]))
		}
		return out
	}
	if got := ids(`export const ICONS`); !slices.Equal(got, mwpack.ComponentIcons) {
		t.Errorf("icons differ:\nfront end %v\nGo        %v", got, mwpack.ComponentIcons)
	}
	if got := ids(`export const COLORS`); !slices.Equal(got, mwpack.ComponentColors) {
		t.Errorf("colors differ:\nfront end %v\nGo        %v", got, mwpack.ComponentColors)
	}
}

func TestUnknownIconOrColorIsRefused(t *testing.T) {
	s, _ := testStore(t)
	files, err := buildSkeleton(skeletonOpts{Name: "styled", Title: "有标识", Kind: "single", Package: "memcached", Port: 1, Icon: "gateway", Color: "teal"})
	if err != nil {
		t.Fatal(err)
	}
	if !contains2(string(files["component.yaml"]), "icon: gateway") || !contains2(string(files["component.yaml"]), "color: teal") {
		t.Fatal("the chosen logo is not in the manifest")
	}
	bad := files.clone()
	bad["component.yaml"] = []byte(string(bad["component.yaml"]) + "")
	for _, c := range []struct{ from, to string }{{"icon: gateway", "icon: rocket"}, {"color: teal", "color: neon"}} {
		x := files.clone()
		x["component.yaml"] = []byte(replace1(string(x["component.yaml"]), c.from, c.to))
		if chk := checkComponent(s.plat, "styled", x); chk.OK {
			t.Errorf("%s was accepted", c.to)
		}
	}
	if _, err := buildSkeleton(skeletonOpts{Name: "styled", Title: "x", Kind: "single", Package: "m", Port: 1, Icon: "rocket"}); err == nil {
		t.Error("a skeleton with an unknown icon was built")
	}
}

func contains2(s, sub string) bool { return regexp.MustCompile(regexp.QuoteMeta(sub)).MatchString(s) }
func replace1(s, a, b string) string {
	return regexp.MustCompile(regexp.QuoteMeta(a)).ReplaceAllLiteralString(s, b)
}

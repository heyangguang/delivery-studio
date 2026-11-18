package pkglib

import (
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"middleware-deployer/mwpack"
)

func TestCompareDebFollowsDpkgOrdering(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"1.0", "1.0", 0},
		{"1.0-1", "1.0-2", -1},
		{"1:1.0", "2.0", 1},    // an epoch beats everything
		{"1.0~rc1", "1.0", -1}, // a tilde sorts before the end
		{"1.0+b1", "1.0", 1},   // anything else sorts after it
		{"1.10", "1.9", 1},     // numbers compare as numbers
		{"2.0ubuntu1", "2.0", 1},
		{"3.5.33-1.noble", "3.5.9-1", 1},
		{"1.0-1ubuntu1", "1.0-1", 1},
	} {
		if got := CompareDeb(c.a, c.b); got != c.want {
			t.Errorf("CompareDeb(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
		if got := CompareDeb(c.b, c.a); got != -c.want {
			t.Errorf("CompareDeb(%q, %q) = %d, want %d", c.b, c.a, got, -c.want)
		}
	}
}

func TestParseDependsHandlesAlternativesVersionsAndArchitectures(t *testing.T) {
	g := parseDepends("libc6 (>= 2.34), a:any | b (<< 2.0), c [i386], d [!amd64], e [amd64 arm64]")
	if len(g) != 3 {
		t.Fatalf("want 3 groups (c and d are not for amd64), got %d: %+v", len(g), g)
	}
	if g[0][0] != (depAlt{"libc6", ">=", "2.34"}) {
		t.Errorf("first: %+v", g[0])
	}
	if len(g[1]) != 2 || g[1][0].name != "a" || g[1][1] != (depAlt{"b", "<<", "2.0"}) {
		t.Errorf("second: %+v", g[1])
	}
	if g[2][0].name != "e" {
		t.Errorf("third: %+v", g[2])
	}
}

// fixtureIndex writes a cached index for a made-up platform made of the given Packages text.
func fixtureIndex(t *testing.T, packages string) (*Index, mwpack.PlatformDef) {
	t.Helper()
	def := mwpack.PlatformDef{ID: "ubuntu-24.04-amd64", Family: "apt", Arch: "amd64", Title: "t"}
	x := OpenIndex(t.TempDir())
	dir := x.pdir(def.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write([]byte(packages))
	zw.Close()
	if err := os.WriteFile(filepath.Join(dir, "s__suite__main.Packages.gz"), buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(dir, "state.json"), IndexState{Platform: def.ID, Files: []IndexFile{{Source: "s", Suite: "suite", Component: "main", File: "s__suite__main.Packages.gz", Packages: 1}}}); err != nil {
		t.Fatal(err)
	}
	return x, def
}

func stanza(name, version, depends, provides string) string {
	s := "Package: " + name + "\nVersion: " + version + "\nArchitecture: amd64\n"
	if depends != "" {
		s += "Depends: " + depends + "\n"
	}
	if provides != "" {
		s += "Provides: " + provides + "\n"
	}
	return s + "Filename: pool/" + name + "_" + version + ".deb\nSize: 100\nSHA256: " + strings.Repeat("a", 64) + "\nDescription: " + name + " package\n\n"
}

func names(p *Plan) string {
	var n []string
	for _, x := range p.Packages {
		n = append(n, x.Name+"="+x.Version)
	}
	return strings.Join(n, " ")
}

func TestResolveSkipsTheBaseSystemAndPicksNewestSatisfyingVersions(t *testing.T) {
	x, def := fixtureIndex(t,
		stanza("app", "1.0", "libc6 (>= 2.30), libfoo (>= 2), bar | baz, mail-agent", "")+
			stanza("libfoo", "1", "", "")+stanza("libfoo", "2.5", "", "")+stanza("libfoo", "3.1", "libbase (= 7)", "")+
			stanza("bar", "1", "", "")+stanza("baz", "1", "", "")+
			stanza("libbase", "7", "", "")+stanza("libbase", "8", "", "")+
			stanza("postfix", "3", "", "mail-agent")+
			stanza("libc6", "9.9", "", ""))
	plan, err := x.Resolve(def, mwpack.PackageRequest{Name: "app", Version: "1.0"})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Unresolved) != 0 {
		t.Fatalf("unresolved: %v", plan.Unresolved)
	}
	// libc6 is in the base system and satisfies >= 2.30, so it is not downloaded; libfoo takes the newest version, whose
	// exact dependency pins libbase; bar is the first alternative; mail-agent is virtual and provided by postfix.
	if got, want := names(plan), "app=1.0 libfoo=3.1 bar=1 postfix=3 libbase=7"; got != want {
		t.Errorf("plan = %s, want %s", got, want)
	}
	if len(plan.Notes) != 0 {
		t.Errorf("a single provider needs no note: %v", plan.Notes)
	}
}

func TestResolveUpgradesABasePackageWhenTheVersionIsNotEnoughAndReportsWhatIsMissing(t *testing.T) {
	x, def := fixtureIndex(t,
		stanza("app", "1.0", "libc6 (>= 99.0), ghost (>= 1)", "")+stanza("libc6", "99.1", "", ""))
	plan, err := x.Resolve(def, mwpack.PackageRequest{Name: "app", Version: "1.0"})
	if err != nil {
		t.Fatal(err)
	}
	if got := names(plan); got != "app=1.0 libc6=99.1" {
		t.Errorf("plan = %s", got)
	}
	if !plan.Packages[1].Upgrade {
		t.Error("libc6 replaces the base system's copy and must say so")
	}
	if len(plan.Unresolved) != 1 || !strings.Contains(plan.Unresolved[0], "ghost") {
		t.Errorf("unresolved = %v", plan.Unresolved)
	}
	if _, err := x.Resolve(def, mwpack.PackageRequest{Name: "app", Version: "2.0"}); err == nil {
		t.Error("a version the index does not list must be refused")
	}
}

func TestSearchRanksNamesBeforeDescriptions(t *testing.T) {
	x, def := fixtureIndex(t, stanza("postgresql-17", "17.1", "", "")+stanza("pgadmin", "1", "", "")+stanza("libpq5", "17.1", "", "")+"Package: tool\nVersion: 1\nArchitecture: amd64\nFilename: pool/t.deb\nSize: 1\nSHA256: "+strings.Repeat("b", 64)+"\nDescription: client for postgresql\n\n")
	hits, err := x.Search(def, "postgresql", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 || hits[0].Name != "postgresql-17" || hits[1].Name != "tool" {
		t.Errorf("hits = %+v", hits)
	}
}

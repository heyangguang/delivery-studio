package pkglib

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"delivery-studio/mwpack"
)

// TestIndexResolverMatchesContainerClosures compares the closures worked out from the signed indexes with the ones
// apt computed inside a container. It needs the network and an existing library, so it only runs when MW_NET_TEST
// names that library directory.
func TestIndexResolverMatchesContainerClosures(t *testing.T) {
	libDir := os.Getenv("MW_NET_TEST")
	if libDir == "" {
		t.Skip("set MW_NET_TEST=<library dir> to compare against container closures")
	}
	def, _ := mwpack.PlatformByID("ubuntu-24.04-amd64")
	srcs, err := LoadSources("")
	if err != nil {
		t.Fatal(err)
	}
	x := OpenIndex(t.TempDir())
	if err := x.Update(context.Background(), def, srcs, LogReporter(func(m string) { t.Log(m) })); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(libDir, def.ID, "closures", "*.json"))
	if len(files) == 0 {
		t.Fatal("no closures to compare with")
	}
	bad := 0
	for _, f := range files {
		var c Closure
		b, _ := os.ReadFile(f)
		if err := json.Unmarshal(b, &c); err != nil {
			t.Fatal(err)
		}
		plan, err := x.Resolve(def, c.Request)
		if err != nil {
			t.Errorf("%s: %v", c.Request.Key(), err)
			bad++
			continue
		}
		want, got := map[string]bool{}, map[string]bool{}
		for _, fr := range c.Files {
			want[fr.File] = true
		}
		for _, p := range plan.Packages {
			got[p.File] = true
		}
		var missing, extra []string
		for k := range want {
			if !got[k] {
				missing = append(missing, k)
			}
		}
		for k := range got {
			if !want[k] {
				extra = append(extra, k)
			}
		}
		sort.Strings(missing)
		sort.Strings(extra)
		if len(missing)+len(extra)+len(plan.Unresolved) > 0 {
			bad++
			t.Errorf("%s differs\n  container only: %s\n  index only:     %s\n  unresolved:     %v", c.Request.Key(), strings.Join(missing, " "), strings.Join(extra, " "), plan.Unresolved)
		} else {
			t.Logf("%s: identical (%d files)", c.Request.Key(), len(want))
		}
	}
	t.Logf("%d of %d closures identical", len(files)-bad, len(files))
}

// TestFetchDirectStoresTheSameFilesAsTheContainerFetch downloads a closure through the index into an empty library
// and compares every stored file with what the container fetch stored.
func TestFetchDirectStoresTheSameFilesAsTheContainerFetch(t *testing.T) {
	libDir := os.Getenv("MW_NET_TEST")
	if libDir == "" {
		t.Skip("set MW_NET_TEST=<library dir>")
	}
	def, _ := mwpack.PlatformByID("ubuntu-24.04-amd64")
	srcs, _ := LoadSources("")
	lib, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	x := OpenIndex(lib.Dir)
	if err := x.Update(context.Background(), def, srcs, nil); err != nil {
		t.Fatal(err)
	}
	t0 := time.Now()
	for _, name := range []string{"etcd-server=1:3.5.33-1.noble", "haproxy=2.8.30-0ubuntu0.24.04.1"} {
		n, v, _ := strings.Cut(name, "=")
		if err := x.FetchDirect(context.Background(), lib, def, srcs, []mwpack.PackageRequest{{Name: n, Version: v}}, LogReporter(func(m string) { t.Log(m) })); err != nil {
			t.Fatal(err)
		}
		ref, _ := Open(libDir)
		want, err := ref.Get(def.ID, mwpack.PackageRequest{Name: n, Version: v})
		if err != nil || want == nil {
			t.Fatalf("reference closure missing: %v", err)
		}
		got, err := lib.Get(def.ID, mwpack.PackageRequest{Name: n, Version: v})
		if err != nil || got == nil {
			t.Fatalf("stored closure missing: %v", err)
		}
		if len(got.Files) != len(want.Files) {
			t.Fatalf("%s: %d files, container fetch had %d", name, len(got.Files), len(want.Files))
		}
		for i := range want.Files {
			if got.Files[i] != want.Files[i] {
				t.Errorf("%s: file %d is %+v, container fetch stored %+v", name, i, got.Files[i], want.Files[i])
			}
		}
		for _, f := range want.Files {
			wm, _ := os.ReadFile(filepath.Join(libDir, def.ID, "meta", f.File+".json"))
			gm, _ := os.ReadFile(filepath.Join(lib.Dir, def.ID, "meta", f.File+".json"))
			var a, b Meta
			json.Unmarshal(wm, &a)
			json.Unmarshal(gm, &b)
			if a.Name != b.Name || a.Version != b.Version || a.Arch != b.Arch || a.SHA256 != b.SHA256 {
				t.Errorf("meta of %s differs: %+v vs %+v", f.File, a, b)
			}
			// the index stanza lists fields in another order and carries only the first line of the description; every
			// field that matters to the package manager must be identical
			for _, k := range []string{"Package", "Version", "Architecture", "Source", "Depends", "Pre-Depends", "Provides", "Conflicts", "Breaks", "Replaces", "Recommends", "Suggests", "Multi-Arch", "Essential", "Installed-Size", "Maintainer"} {
				if x, y := controlField(a.Control, k), controlField(b.Control, k); x != y {
					t.Errorf("%s: field %s is %q in the container fetch and %q from the index", f.File, k, x, y)
				}
			}
			if !strings.HasPrefix(controlField(b.Control, "Description"), strings.SplitN(controlField(a.Control, "Description"), "\n", 2)[0]) {
				t.Errorf("%s: description differs", f.File)
			}
		}
	}
	t.Logf("two closures stored in %s", time.Since(t0).Round(time.Second))
}

// TestRpmResolverMatchesContainerClosures is the rpm counterpart: the closures worked out from Rocky's signed
// repository metadata must be the ones dnf computed inside a rockylinux:9 container.
func TestRpmResolverMatchesContainerClosures(t *testing.T) {
	libDir := os.Getenv("MW_NET_TEST")
	if libDir == "" {
		t.Skip("set MW_NET_TEST=<library dir> to compare against container closures")
	}
	def, _ := mwpack.PlatformByID("el9-amd64")
	srcs, err := LoadSources("")
	if err != nil {
		t.Fatal(err)
	}
	x := OpenIndex(t.TempDir())
	t0 := time.Now()
	if err := x.Update(context.Background(), def, srcs, LogReporter(func(m string) { t.Log(m) })); err != nil {
		t.Fatal(err)
	}
	t.Logf("index updated in %s", time.Since(t0).Round(time.Second))
	files, _ := filepath.Glob(filepath.Join(libDir, def.ID, "closures", "*.json"))
	if len(files) == 0 {
		t.Fatal("no closures to compare with")
	}
	bad := 0
	for _, f := range files {
		var c Closure
		b, _ := os.ReadFile(f)
		if err := json.Unmarshal(b, &c); err != nil {
			t.Fatal(err)
		}
		plan, err := x.Resolve(def, c.Request)
		if err != nil {
			t.Errorf("%s: %v", c.Request.Key(), err)
			bad++
			continue
		}
		want, got := map[string]bool{}, map[string]bool{}
		for _, fr := range c.Files {
			want[fr.File] = true
		}
		for _, p := range plan.Packages {
			got[p.File] = true
		}
		var missing, extra []string
		for k := range want {
			if !got[k] {
				missing = append(missing, k)
			}
		}
		for k := range got {
			if !want[k] {
				extra = append(extra, k)
			}
		}
		sort.Strings(missing)
		sort.Strings(extra)
		if len(missing)+len(extra)+len(plan.Unresolved) > 0 {
			bad++
			t.Errorf("%s differs\n  container only: %s\n  index only:     %s\n  unresolved:     %v\n  notes: %v", c.Request.Key(), strings.Join(missing, " "), strings.Join(extra, " "), plan.Unresolved, plan.Notes)
		} else {
			t.Logf("%s: identical (%d files)", c.Request.Key(), len(want))
		}
	}
	t.Logf("%d of %d closures identical", len(files)-bad, len(files))
}

func TestRpmFetchDirectStoresTheSameFilesAsTheContainerFetch(t *testing.T) {
	libDir := os.Getenv("MW_NET_TEST")
	if libDir == "" {
		t.Skip("set MW_NET_TEST=<library dir>")
	}
	def, _ := mwpack.PlatformByID("el9-amd64")
	srcs, _ := LoadSources("")
	lib, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	x := OpenIndex(lib.Dir)
	if err := x.Update(context.Background(), def, srcs, nil); err != nil {
		t.Fatal(err)
	}
	req := mwpack.PackageRequest{Name: "haproxy", Version: "2.8.14-3.el9_8.2"}
	t0 := time.Now()
	if err := x.FetchDirect(context.Background(), lib, def, srcs, []mwpack.PackageRequest{req}, LogReporter(func(m string) { t.Log(m) })); err != nil {
		t.Fatal(err)
	}
	t.Logf("stored in %s", time.Since(t0).Round(time.Second))
	ref, _ := Open(libDir)
	want, _ := ref.Get(def.ID, req)
	got, err := lib.Get(def.ID, req)
	if err != nil || got == nil || want == nil {
		t.Fatalf("closure missing: %v", err)
	}
	if len(got.Files) != len(want.Files) {
		t.Fatalf("%d files, container fetch had %d", len(got.Files), len(want.Files))
	}
	for i := range want.Files {
		if got.Files[i] != want.Files[i] {
			t.Errorf("file %d is %+v, container fetch stored %+v", i, got.Files[i], want.Files[i])
		}
	}
	for _, f := range got.Files {
		var a, b Meta
		wm, _ := os.ReadFile(filepath.Join(libDir, def.ID, "meta", f.File+".json"))
		gm, _ := os.ReadFile(filepath.Join(lib.Dir, def.ID, "meta", f.File+".json"))
		json.Unmarshal(wm, &a)
		json.Unmarshal(gm, &b)
		if a.Name != b.Name || a.Version != b.Version || a.Arch != b.Arch || a.SHA256 != b.SHA256 {
			t.Errorf("meta of %s differs: %+v vs %+v", f.File, a, b)
		}
		for kind, blk := range map[string]string{"primary": b.Primary, "filelists": b.Filelists, "other": b.Other} {
			if !strings.Contains(blk, b.SHA256) || !strings.HasPrefix(blk, "<package") || !strings.HasSuffix(blk, "</package>") {
				t.Errorf("%s of %s is not one whole package entry", kind, f.File)
			}
		}
	}
	repo, err := lib.Assemble(def, []mwpack.PackageRequest{req})
	if err != nil {
		t.Fatalf("assembling an offline repository from the stored packages: %v", err)
	}
	t.Logf("assembled %s", repo.Path)
	// the proof: a clean rockylinux:9 container with no network installs it from that repository alone
	if os.Getenv("MW_VERIFY_INSTALL") != "" {
		f := &Fetcher{Lib: lib, Sources: srcs, Log: func(m string) { t.Log(m) }}
		if err := f.VerifyInstall(context.Background(), def, repo.Path, []mwpack.PackageRequest{req}); err != nil {
			t.Fatalf("installing from the assembled repository without network: %v", err)
		}
		t.Log("installed from the assembled repository with the network cut off")
	}
}

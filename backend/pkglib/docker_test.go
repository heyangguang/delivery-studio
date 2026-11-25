package pkglib

import (
	"context"
	"os"
	"testing"
	"time"

	"delivery-studio/mwpack"
)

// These tests use real containers and the network; they only run when MW_DOCKER_TESTS=1.
func dockerEnv(t *testing.T) *Fetcher {
	t.Helper()
	if os.Getenv("MW_DOCKER_TESTS") != "1" {
		t.Skip("set MW_DOCKER_TESTS=1 to run container tests")
	}
	lib, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	src, err := LoadSources("")
	if err != nil {
		t.Fatal(err)
	}
	return &Fetcher{Lib: lib, Sources: src, Log: func(s string) { t.Log(s) }}
}

func fetchAndProve(t *testing.T, f *Fetcher, platform string, reqs []mwpack.PackageRequest) *RepoArchive {
	t.Helper()
	def, _ := mwpack.PlatformByID(platform)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	if err := f.Fetch(ctx, def, reqs); err != nil {
		t.Fatal(err)
	}
	if missing := f.Lib.Missing(platform, reqs); len(missing) != 0 {
		t.Fatalf("library lacks %v after fetch", missing)
	}
	// Every request must be installable ON ITS OWN from a repository assembled for just that request: a closure that
	// only works together with the others would break the first delivery that needs only one of them.
	if len(reqs) > 1 {
		for _, r := range reqs {
			one, err := f.Lib.Assemble(def, []mwpack.PackageRequest{r})
			if err != nil {
				t.Fatal(err)
			}
			if err := f.VerifyInstall(ctx, def, one.Path, []mwpack.PackageRequest{r}); err != nil {
				t.Fatalf("%s is not installable on its own from its closure: %v", r.Key(), err)
			}
		}
	}
	repo, err := f.Lib.Assemble(def, reqs)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("repository %s: %d files, %d bytes", repo.File, repo.Files, repo.Size)
	if err := f.VerifyInstall(ctx, def, repo.Path, reqs); err != nil {
		t.Fatalf("the assembled repository is not self-sufficient: %v", err)
	}
	return repo
}

func TestDockerUbuntuKeepalivedAndHaproxy(t *testing.T) {
	f := dockerEnv(t)
	repo := fetchAndProve(t, f, "ubuntu-24.04-amd64", []mwpack.PackageRequest{{Name: "keepalived", Version: "1:2.2.8-1build2"}, {Name: "haproxy", Version: "2.8.5-1ubuntu3"}})
	again, err := f.Lib.Assemble(mustPlatform("ubuntu-24.04-amd64"), []mwpack.PackageRequest{{Name: "haproxy", Version: "2.8.5-1ubuntu3"}, {Name: "keepalived", Version: "1:2.2.8-1build2"}})
	if err != nil || again.SHA256 != repo.SHA256 {
		t.Fatalf("assembly must be deterministic regardless of request order: %v", err)
	}
}

func mustPlatform(id string) mwpack.PlatformDef {
	d, _ := mwpack.PlatformByID(id)
	return d
}

func TestDockerRockyVersionsAndInstall(t *testing.T) {
	f := dockerEnv(t)
	def := mustPlatform("el9-amd64")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	var reqs []mwpack.PackageRequest
	for _, name := range []string{"haproxy", "keepalived", "nginx", "nginx-mod-stream"} {
		vs, err := f.Versions(ctx, def, name)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("%s versions: %v", name, vs)
		reqs = append(reqs, mwpack.PackageRequest{Name: name, Version: vs[0]})
	}
	fetchAndProve(t, f, "el9-amd64", reqs)
}

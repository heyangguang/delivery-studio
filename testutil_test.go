package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"middleware-deployer/mwpack"
	"middleware-deployer/pkglib"
)

// fixtureAutomationArchive builds a small stand-in for the offline Ansible runtime release archive.
func fixtureAutomationArchive(t *testing.T, root string) string {
	t.Helper()
	files := map[string]deliveryFile{}
	for _, name := range []string{"bootstrap/bootstrap-ansible.sh", "bootstrap/run-ansible.py", "bootstrap/requirements.lock"} {
		files["middleware-automation/"+name] = deliveryFile{[]byte("fixture " + name), 0600}
	}
	var manifest strings.Builder
	for name, x := range files {
		manifest.WriteString(digest(x.Data) + "  " + strings.TrimPrefix(name, "middleware-automation/") + "\n")
	}
	files["middleware-automation/SHA256SUMS"] = deliveryFile{[]byte(manifest.String()), 0600}
	filename := filepath.Join(root, "automation.tar.gz")
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, x := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: x.Mode, Size: int64(len(x.Data)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		tw.Write(x.Data)
	}
	tw.Close()
	gz.Close()
	os.WriteFile(filename, buf.Bytes(), 0600)
	os.WriteFile(filename+".sha256", []byte(digest(buf.Bytes())+"  automation.tar.gz\n"), 0600)
	return filename
}

// fakeLibrary fills a library directory with stand-in closures (one tiny file per package) so generation can be
// exercised without containers or a network.
func fakeLibrary(t *testing.T, dir, platformID string, reqs []mwpack.PackageRequest) {
	t.Helper()
	lib, err := pkglib.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	def, _ := mwpack.PlatformByID(platformID)
	src := t.TempDir()
	for _, r := range reqs {
		file := pkglib.SafeFile(r.Name+"_"+r.Version) + ".deb"
		body := []byte("fake package " + r.Key())
		if err := os.WriteFile(filepath.Join(src, file), body, 0o600); err != nil {
			t.Fatal(err)
		}
		meta := pkglib.Meta{File: file, Name: r.Name, Version: r.Version, Arch: "amd64", Control: "Package: " + r.Name + "\nVersion: " + r.Version + "\nArchitecture: amd64\nDescription: fake"}
		if def.Family == "rpm" {
			t.Fatal("fake rpm library not needed in these tests")
		}
		c := pkglib.Closure{Request: r, Platform: platformID, Files: []pkglib.FileRef{{File: file}}, Packages: []pkglib.PkgRef{{Name: r.Name, Version: r.Version}}, Via: "test"}
		if err := lib.Put(c, []pkglib.Meta{meta}, func(string) string { return filepath.Join(src, file) }); err != nil {
			t.Fatal(err)
		}
	}
}

// allUbuntuPackages is every package any built-in component needs on Ubuntu 24.04.
func allUbuntuPackages(t *testing.T) []mwpack.PackageRequest {
	t.Helper()
	plat, err := loadPlatform(platformConfig{})
	if err != nil {
		t.Fatal(err)
	}
	return plat.cat().AllPackages(mwpack.DefaultPlatform)
}

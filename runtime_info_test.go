package main

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestRuntimeInfoReadsWhatTheArchiveCarries(t *testing.T) {
	root := t.TempDir()
	archive := fixtureAutomationArchive(t, root)
	info := readRuntimeInfo(archive)
	if info == nil {
		t.Fatal("no information read from the runtime archive")
	}
	if info.File != filepath.Base(archive) || info.Size == 0 || info.Packages == nil {
		t.Fatalf("basic facts missing: %+v", info)
	}
	if again := readRuntimeInfo(archive); again != info {
		t.Error("an unchanged archive must be read only once")
	}
	if readRuntimeInfo(filepath.Join(root, "missing.tar.gz")) != nil {
		t.Error("a missing archive has no information")
	}
}

// writeRuntimeArchive builds a runtime archive the way the loader expects (checksummed, owner-only modes).
func writeRuntimeArchive(t *testing.T, path string, files map[string]string) {
	t.Helper()
	all := map[string]deliveryFile{}
	var sums strings.Builder
	names := []string{}
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		all["middleware-automation/"+n] = deliveryFile{[]byte(files[n]), 0600}
		sums.WriteString(digest([]byte(files[n])) + "  " + n + "\n")
	}
	all["middleware-automation/SHA256SUMS"] = deliveryFile{[]byte(sums.String()), 0600}
	if err := writeDeliveryTar(path, all); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeInfoPrefersTheRuntimeDescriptionAndKeepsWorkingForOlderArchives(t *testing.T) {
	dir := t.TempDir()
	el9 := filepath.Join(dir, "el9.tar.gz")
	writeRuntimeArchive(t, el9, map[string]string{
		"bootstrap/bootstrap-ansible.sh":                                     "#!/bin/bash\n[[ $ID =~ ^(rocky)$ && $(uname -m) == x86_64 ]] || exit 1\n",
		"bootstrap/run-ansible.py":                                           "x",
		"bootstrap/requirements.lock":                                        "x",
		"bootstrap/wheels/ansible_core-2.20.10-py3-none-any.whl":             "w",
		"bootstrap/wheels/PyYAML-6.0.3-cp312-cp312-manylinux2014_x86_64.whl": "w",
		"runtime.json": `{"controller":"RedHat 系 9 amd64","python":"3.12","ansible":"2.20.10"}`,
	})
	info := readRuntimeInfo(el9)
	if info == nil || info.Ansible != "2.20.10" || info.Python != "3.12" || info.Controller != "RedHat 系 9 amd64" || len(info.Packages) != 2 {
		t.Fatalf("el9 runtime: %+v", info)
	}
	ubuntu := filepath.Join(dir, "ubuntu.tar.gz")
	writeRuntimeArchive(t, ubuntu, map[string]string{
		"bootstrap/bootstrap-ansible.sh":                         "[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(uname -m) == x86_64 ]]\npython3 -c 'import sys; assert sys.version_info[:2] == (3,12)'\n",
		"bootstrap/run-ansible.py":                               "x",
		"bootstrap/requirements.lock":                            "x",
		"bootstrap/wheels/ansible_core-2.20.10-py3-none-any.whl": "w",
	})
	if u := readRuntimeInfo(ubuntu); u == nil || u.Controller != "Ubuntu 24.04 amd64" || u.Python != "3.12" {
		t.Fatalf("an archive without runtime.json is read from its bootstrap script: %+v", u)
	}
}

func TestControllerWrapperUsesPython312WhenTheSystemHasIt(t *testing.T) {
	w := fmt.Sprintf(ansibleWrapper, "playbook")
	if !strings.Contains(w, "/usr/bin/python3.12 /usr/bin/python3") || strings.Index(w, "python3.12") > strings.Index(w, "run-ansible.py") {
		t.Fatalf("the wrapper must try python3.12 before python3:\n%s", w)
	}
}

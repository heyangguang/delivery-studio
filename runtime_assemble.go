package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"middleware-deployer/mwpack"
	"middleware-deployer/pkglib"
)

// The Ansible runtime of a delivery is assembled from the package library: the wheels of the runtime chosen as the
// platform's default, the bootstrap that installs them on the controller, and the command wrappers. A prebuilt
// runtime archive is only used, unchanged, on a platform that has no runtime in its library yet.

//go:embed runtime_assets
var runtimeAssets embed.FS

// migrateRuntimes brings the old prebuilt archives into the library once, so every platform that could deliver before
// still can, now from wheels.
func (p *platform) migrateRuntimes() {
	for _, def := range mwpack.Platforms {
		if _, ok := p.py.Default(def.ID); ok {
			continue
		}
		path := p.runtimeFor(def.ID)
		if path == "" {
			continue
		}
		if id, err := p.py.ImportArchive(path); err == nil {
			_ = p.py.SetDefault(def.ID, id)
		} else {
			fmt.Fprintln(os.Stderr, "无法把 Ansible 运行环境导入软件库：", path, err)
		}
	}
}

// runtimeReady says whether deliveries for a platform can carry an Ansible runtime.
func (p *platform) runtimeReady(id string) bool {
	if _, ok := p.py.Default(id); ok {
		return true
	}
	return p.runtimeFor(id) != ""
}

// runtimePackages is what the platform's runtime carries, for scanning: the ansible-core version and every wheel.
func (p *platform) runtimePackages(id string) (ansible, stamp string, pkgs []RuntimePackage) {
	if r, ok := p.py.Default(id); ok {
		for _, w := range r.Wheels {
			pkgs = append(pkgs, RuntimePackage{w.Name, w.Version})
		}
		return r.Ansible, r.ID, pkgs
	}
	if info := readRuntimeInfo(p.runtimeFor(id)); info != nil {
		return info.Ansible, info.SHA256, info.Packages
	}
	return "", "", nil
}

// runtimeFiles are the controller files of a delivery's Ansible runtime.
// A patch may name the runtime to carry (one that fixes vulnerabilities); otherwise it is the platform's default.
func (p *platform) runtimeFiles(def mwpack.PlatformDef, want string) (map[string]deliveryFile, error) {
	if want != "" {
		if r, ok := p.py.Runtime(want); ok {
			return assembleRuntime(def, r, p.py)
		}
	}
	r, ok := p.py.Default(def.ID)
	if !ok {
		path := p.runtimeFor(def.ID)
		if path == "" {
			return nil, fmt.Errorf("没有 %s 的 Ansible 运行环境：到「软件库 → Ansible 运行环境」准备一个", def.Title)
		}
		return controllerRuntime(path)
	}
	return assembleRuntime(def, r, p.py)
}

func assembleRuntime(def mwpack.PlatformDef, r *pkglib.PyRuntime, store *pkglib.PyStore) (map[string]deliveryFile, error) {
	script := "runtime_assets/bootstrap-apt.sh"
	if def.Family == "rpm" {
		script = "runtime_assets/bootstrap-rpm.sh"
	}
	boot, err := runtimeAssets.ReadFile(script)
	if err != nil {
		return nil, err
	}
	runner, err := runtimeAssets.ReadFile("runtime_assets/run-ansible.py")
	if err != nil {
		return nil, err
	}
	out := map[string]deliveryFile{
		"middleware-automation/bootstrap/bootstrap-ansible.sh": {[]byte(strings.ReplaceAll(string(boot), "__ANSIBLE__", r.Ansible)), 0700},
		"middleware-automation/bootstrap/run-ansible.py":       {runner, 0600},
		"middleware-automation/bootstrap/requirements.lock":    {[]byte(r.Lock()), 0600},
		"middleware-automation/bin/ansible-playbook":           {[]byte(fmt.Sprintf(ansibleWrapper, "playbook")), 0700},
		"middleware-automation/bin/ansible-inventory":          {[]byte(fmt.Sprintf(ansibleWrapper, "inventory")), 0700},
	}
	for _, w := range r.Wheels {
		data, err := store.WheelData(w)
		if err != nil {
			return nil, err
		}
		out["middleware-automation/bootstrap/wheels/"+filepath.Base(w.File)] = deliveryFile{data, 0600}
	}
	meta, _ := json.MarshalIndent(map[string]string{"runtime": r.ID, "ansible": r.Ansible, "python": r.Python, "controller": def.Title}, "", "  ")
	out["middleware-automation/runtime.json"] = deliveryFile{meta, 0600}
	return out, nil
}

// pythonFor is the interpreter whose pip downloads and resolves wheels: the one beside the platform's own ansible,
// else the system python3.
func pythonFor(ansibleBin, dataDir string) string {
	for _, dir := range []string{ansibleBin, os.Getenv("MW_ANSIBLE_BIN"), filepath.Join(dataDir, "ansible", "bin")} {
		if dir == "" {
			continue
		}
		for _, n := range []string{"python3", "python"} {
			if st, err := os.Stat(filepath.Join(dir, n)); err == nil && !st.IsDir() {
				return filepath.Join(dir, n)
			}
		}
	}
	return "python3"
}

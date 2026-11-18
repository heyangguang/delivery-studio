package main

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"middleware-deployer/mwpack"
	"middleware-deployer/pkglib"
)

const ansibleWrapper = `#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
export ANSIBLE_CONFIG="${ANSIBLE_CONFIG:-$PWD/ansible.cfg}"
# Ansible 2.20 needs Python 3.12 on the controller; systems that ship an older default install python3.12 beside it.
for PY in /usr/bin/python3.12 /usr/bin/python3; do [[ -x $PY ]] && break; done
exec "$PY" -I -u "$ROOT/bootstrap/run-ansible.py" %s "$@"
`

// controllerRuntime returns the offline Ansible runtime files for the controller package: the bootstrap and the
// command wrappers. Wrappers run against the ansible.cfg of the project they are started in.
func controllerRuntime(archive string) (map[string]deliveryFile, error) {
	all, err := loadDeliveryAutomation(archive)
	if err != nil {
		return nil, err
	}
	out := map[string]deliveryFile{}
	for name, f := range all {
		if strings.HasPrefix(name, "middleware-automation/bootstrap/") {
			out[name] = f
		}
	}
	if _, ok := out["middleware-automation/bootstrap/bootstrap-ansible.sh"]; !ok {
		return nil, errors.New("Ansible运行环境缺少离线引导脚本")
	}
	out["middleware-automation/bin/ansible-playbook"] = deliveryFile{[]byte(fmt.Sprintf(ansibleWrapper, "playbook")), 0700}
	out["middleware-automation/bin/ansible-inventory"] = deliveryFile{[]byte(fmt.Sprintf(ansibleWrapper, "inventory")), 0700}
	return out, nil
}

// packageDelivery writes the complete delivery directory for a rendered bundle. The directory appears only when
// everything in it has been written and checksummed.
func packageDelivery(b *mwpack.Bundle, plat *platform, repo *pkglib.RepoArchive, destination string, emit func(string)) error {
	plan := b.Plan
	destination, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	if _, e := os.Lstat(destination); !os.IsNotExist(e) {
		return errors.New("交付目录已存在或不可访问")
	}
	emit("[1/5] 校验离线材料与 Ansible 运行环境")
	runtime, err := plat.runtimeFiles(plan.Platform, "")
	if err != nil {
		return err
	}
	arts := plan.Artifacts()
	for _, a := range arts {
		if _, ok := plat.artifactInfo(a.File); !ok {
			return fmt.Errorf("离线材料 %s 不在材料库中", a.File)
		}
	}
	if err = os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(filepath.Dir(destination), ".delivery-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	emit("[2/5] 生成手册与结构化步骤")
	for name, data := range b.Docs {
		if err = privateWriteNew(filepath.Join(tmp, name), data); err != nil {
			return err
		}
	}
	for name, data := range map[string][]byte{"plan.json": b.PlanDoc, "deployment.lock.json": b.Lock} {
		if err = privateWriteNew(filepath.Join(tmp, name), data); err != nil {
			return err
		}
	}
	if f, ok := b.Project["deployment.yml"]; ok {
		if err = privateWriteNew(filepath.Join(tmp, "部署规格.yml"), f.Data); err != nil {
			return err
		}
	}

	uploads := len(plan.DeliveryHosts())
	emit(fmt.Sprintf("[3/5] 打包 %d 台机器；私钥与全部材料只进控制节点的包", uploads))
	var nodes strings.Builder
	order := []mwpack.Host{}
	for _, h := range plan.DeliveryHosts() {
		if h.Name == plan.Controller {
			order = append([]mwpack.Host{h}, order...)
		} else {
			order = append(order, h)
		}
	}
	for _, h := range order {
		fmt.Fprintf(&nodes, "%s %s\n", h.IP, h.Name)
	}
	project := "middleware-automation/projects/" + plan.ProjectName() + "/"
	for i, h := range plan.DeliveryHosts() {
		files := map[string]deliveryFile{
			"mw-setup/nodes.conf":              {[]byte(nodes.String()), 0600},
			"mw-setup/setup-root-ssh-trust.sh": {mwpack.SSHTrustScript(plan.Cat), 0700},
		}
		if h.Name == plan.Controller {
			for k, v := range runtime {
				files[k] = v
			}
			for k, v := range b.Project {
				files[project+k] = deliveryFile{v.Data, v.Mode}
			}
			var sums strings.Builder
			var names []string
			for k := range files {
				if strings.HasPrefix(k, "middleware-automation/") {
					names = append(names, k)
				}
			}
			sort.Strings(names)
			for _, k := range names {
				fmt.Fprintf(&sums, "%s  %s\n", digest(files[k].Data), strings.TrimPrefix(k, "middleware-automation/"))
			}
			files["middleware-automation/SHA256SUMS"] = deliveryFile{[]byte(sums.String()), 0600}
		}
		name := mwpack.PackageName(i, plan.ProjectName(), h.IP)
		if err = writeDeliveryTar(filepath.Join(tmp, name), files); err != nil {
			return err
		}
		data, readErr := os.ReadFile(filepath.Join(tmp, name))
		if readErr != nil {
			return readErr
		}
		if err = privateWriteNew(filepath.Join(tmp, name+".sha256"), []byte(digest(data)+"  "+name+"\n")); err != nil {
			return err
		}
	}

	emit("[4/5] 复制离线材料与软件仓库")
	if repo != nil {
		if err = copyDeliveryFile(repo.Path, filepath.Join(tmp, repo.File)); err != nil {
			return err
		}
	}
	for _, a := range arts {
		if err = copyDeliveryFile(filepath.Join(plat.artifactsDir, a.File), filepath.Join(tmp, a.File)); err != nil {
			return err
		}
	}

	emit("[5/5] 计算完整交付校验清单")
	entries, err := os.ReadDir(tmp)
	if err != nil {
		return err
	}
	var sums strings.Builder
	for _, e := range entries {
		data, e2 := os.ReadFile(filepath.Join(tmp, e.Name()))
		if e2 != nil {
			return e2
		}
		fmt.Fprintf(&sums, "%s  %s\n", digest(data), e.Name())
	}
	if err = privateWriteNew(filepath.Join(tmp, "SHA256SUMS"), []byte(sums.String())); err != nil {
		return err
	}
	if err = os.Rename(tmp, destination); err != nil {
		return err
	}
	emit("交付材料已生成。材料生成成功不代表已部署；新组件版本须先在空环境完成部署与验收。")
	return nil
}

var _ = path.Join

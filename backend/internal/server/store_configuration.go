package server

import (
	"archive/zip"
	"encoding/json"
	"gopkg.in/yaml.v3"
	"delivery-studio/mwpack"
	"os"
	"path/filepath"
	"sort"
)

func generateConfiguration(plan *mwpack.Plan, output string) error {
	files, e := mwpack.ConfigurationFiles(plan)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(output, 0700); e != nil {
		return e
	}
	f, e := os.OpenFile(filepath.Join(output, "configuration.zip"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	z := zip.NewWriter(f)
	keys := []string{}
	for k := range files {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		w, err := z.Create(k)
		if err != nil {
			z.Close()
			f.Close()
			return err
		}
		if _, err = w.Write(files[k]); err != nil {
			z.Close()
			f.Close()
			return err
		}
	}
	if e = z.Close(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	d, _ := yaml.Marshal(plan.Dep)
	if e = os.WriteFile(filepath.Join(output, "部署规格.yml"), d, 0600); e != nil {
		return e
	}
	p := map[string]any{"delivery_mode": "configuration", "step_format": 2, "cluster": plan.Dep.ID, "project": plan.ProjectName(), "controller": plan.Controller, "hosts": plan.Dep.Hosts, "instances": plan.View().Instances, "prepare": []any{}, "deploy": []any{}, "tests": []any{}, "endpoint_tests": []any{}, "cleanup": []any{}}
	b, _ := json.Marshal(p)
	if e = os.WriteFile(filepath.Join(output, "plan.json"), b, 0600); e != nil {
		return e
	}
	return os.WriteFile(filepath.Join(output, "配置交付说明.md"), []byte("# 配置交付\n\n本次只生成配置文件，没有运行安装、修改配置或验证现场服务。\n\n解压 configuration.zip，按实例和机器选择文件；由现场人员审核、安装并验证。报告不会把生成配置记为部署成功。\n"), 0600)
}

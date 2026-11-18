package main

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"middleware-deployer/mwpack"
)

// A new component starts from a skeleton: a minimal manifest with the role files it needs, which installs one
// package, writes one configuration file, starts the service and checks its port. The person then replaces the parts
// that are specific to their middleware.

type skeletonKind struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Text  string `json:"text"`
	Roles string `json:"roles"`
}

var skeletonKinds = []skeletonKind{
	{"single", "只有一种角色", "没有主从之分：每台机器装的东西一样，互不相关（如 nginx、node_exporter）。", "server"},
	{"primary-replica", "主 + 从", "一个主节点，加 0 台或多台从节点。从节点可以是 0 台，所以单机也能跑（PostgreSQL 就这样）。", "primary、replica"},
	{"cluster", "对等成员", "成员互相组网、地位平等，通常 3 台起（如 etcd、Kafka、ZooKeeper）。", "node"},
}

type skeletonOpts struct {
	Name    string `json:"name"`
	Title   string `json:"title"`
	Kind    string `json:"kind"`
	Package string `json:"package"`
	Service string `json:"service"`
	Port    int    `json:"port"`
	Icon    string `json:"icon"`
	Color   string `json:"color"`
}

func (o *skeletonOpts) check() error {
	if !nameRE.MatchString(o.Name) {
		return errors.New("组件名要用小写字母开头，只含小写字母、数字和短横线")
	}
	if strings.TrimSpace(o.Title) == "" {
		return errors.New("请填写显示名称")
	}
	if !pkgNameRE.MatchString(o.Package) {
		return errors.New("软件包名称不对")
	}
	if o.Service == "" {
		o.Service = o.Package
	}
	if !pkgNameRE.MatchString(o.Service) {
		return errors.New("服务名称不对")
	}
	if o.Port < 1 || o.Port > 65535 {
		return errors.New("端口要在 1 到 65535 之间")
	}
	if o.Icon != "" && !slices.Contains(mwpack.ComponentIcons, o.Icon) {
		return errors.New("未知的图标")
	}
	if o.Color != "" && !slices.Contains(mwpack.ComponentColors, o.Color) {
		return errors.New("未知的颜色")
	}
	for _, k := range skeletonKinds {
		if k.ID == o.Kind {
			defIcon, defColor := map[string]string{"single": "server", "primary-replica": "database", "cluster": "cluster"}[k.ID], map[string]string{"single": "blue", "primary-replica": "indigo", "cluster": "teal"}[k.ID]
			if o.Icon == "" {
				o.Icon = defIcon
			}
			if o.Color == "" {
				o.Color = defColor
			}
			return nil
		}
	}
	return errors.New("未知的模板类型")
}

func buildSkeleton(o skeletonOpts) (fileSet, error) {
	if err := o.check(); err != nil {
		return nil, err
	}
	var roles, flows, detail, preset string
	switch o.Kind {
	case "single":
		roles = "  - {name: server, title: 服务, min: 1, default: 1}\n"
		preset = "    - {id: one, name: 单机, tag: 开发测试, spec: 1 台, roles: [{role: server, count: 1}]}\n"
	case "primary-replica":
		roles = "  - {name: primary, title: 主节点, min: 1, max: 1, default: 1, exclusive: true, initial: true}\n" +
			"  - {name: replica, title: 从节点, min: 0, default: 1, exclusive: true}\n"
		flows = "\nflows:\n  - {id: replication, title: 主从复制, kind: replication, from: primary, to: replica, when: \"count(roles.replica) > 0\"}\n"
		preset = "    - {id: single, name: 单节点, tag: 开发测试, spec: 1 台, roles: [{role: primary, count: 1}]}\n" +
			"    - {id: pair, name: 一主一从, tag: 推荐, spec: 2 台, roles: [{role: primary, count: 1}, {role: replica, count: 1}]}\n"
	case "cluster":
		roles = "  - {name: node, title: 节点, min: 1, default: 3, odd: true}\n"
		flows = "\nflows:\n  - {id: peers, title: 节点间同步, kind: mesh, from: node, to: node}\n"
		preset = "    - {id: single, name: 单节点, tag: 开发测试, spec: 1 台, roles: [{role: node, count: 1}]}\n" +
			"    - {id: three, name: 三节点, tag: 推荐, spec: 3 台, roles: [{role: node, count: 3}]}\n"
	}
	// A skeleton is not a verified architecture. Keep its contract incomplete
	// and visible to the author; publication must require a real mechanism and tests.
	preset = "    # 发布前为每个方案填写 contract：series/when/failover/mechanism/read_access/sharding/limitations/acceptance/operations。\n" +
		"    # 多节点不等于高可用或分片；必须按真实实现选择系列，禁止只为通过校验而填写能力。\n" + preset
	detail = "detail:\n  tagline: " + o.Title + "，由模板生成，请按实际情况补充\n  scale: 1 台起\n  presets:\n" + preset

	manifest := fmt.Sprintf(`schema: mwpack/v1
component: %[1]s
short: %[1]s
title: %[2]s
category: 自定义
icon: %[10]s
color: %[11]s
summary: %[2]s（由「%[7]s」模板创建，请补充说明）。
tags: [自定义]
data_volume: true

%[9]s
roles:
%[4]s%[3]s
groups:
  - {id: network, label: 网络与端口}

params:
  - {key: port, group: network, label: 服务端口, type: port, default: %[6]d}
  - {key: data_dir, group: network, label: 数据目录, type: string, default: /data/%[1]s, pattern: '^/data/[A-Za-z0-9_./-]+$', hint: 须位于 /data 下, restart: true}

ports:
  - {name: service, value: =params.port}

versions:
  - id: "1.0"
    status: draft
    platforms: [ubuntu-24.04-amd64]
    packages:
      # 在「软件库」里找到真实的版本号后替换这里；版本号必须与库里的完全一致。
      - {name: %[8]s, version: "REPLACE-WITH-LIBRARY-VERSION"}

lifecycle:
  install:
    - id: packages
      title: 安装 %[2]s 软件包
      desc: 从随交付附带的离线软件源安装；安装期间临时屏蔽服务，避免用默认配置启动。
      effect: change
      run: {role: %[1]s, tasks: install}
  configure:
    - id: config
      title: 写入 %[2]s 配置
      effect: change
      run: {role: %[1]s, tasks: configure}
  start:
    - id: start
      title: 启动 %[2]s
      effect: change
      run: {role: %[1]s, tasks: start}
  verify:
    - id: port
      title: 核对服务端口
      effect: read-only
      expect: 每台机器的服务端口都在监听。
      run: {role: %[1]s, tasks: health}

tests:
  - id: port-open
    title: 服务端口可连接
    desc: 从控制机连接每台机器的服务端口。
    effect: read-only
    expect: 全部端口可连接。
    run: {role: %[1]s, tasks: test_port}
`, o.Name, o.Title, flows, roles, "", o.Port, kindTitle(o.Kind), o.Package, detail, o.Icon, o.Color)

	files := fileSet{"component.yaml": []byte(manifest)}
	r := "roles/" + o.Name + "/"
	files[r+"tasks/install.yml"] = []byte(fmt.Sprintf(`# 安装软件包。mw_packages 是平台自带的角色：它按本组件声明的 packages 从离线软件源安装。
- name: 临时屏蔽服务
  ansible.builtin.command: systemctl mask --runtime %[1]s.service
  changed_when: false

- name: 安装软件包
  block:
    - name: 安装 %[1]s 软件包
      ansible.builtin.include_role:
        name: mw_packages
        tasks_from: install
  always:
    - name: 取消临时屏蔽
      ansible.builtin.command: systemctl unmask --runtime %[1]s.service
      changed_when: false

- name: 创建数据目录
  ansible.builtin.file:
    path: "{{ mw.params.data_dir }}"
    state: directory
    mode: '0750'
`, o.Service))
	files[r+"tasks/configure.yml"] = []byte(fmt.Sprintf(`# 写入配置。模板在 roles/%s/templates/ 下，可以用 mw.params、mw.roles 等变量。
- name: 写入 %s 配置
  ansible.builtin.template:
    src: %s.conf.j2
    dest: /etc/%s.conf
    mode: '0644'
`, o.Name, o.Title, o.Name, o.Name))
	files[r+"tasks/start.yml"] = []byte(fmt.Sprintf(`- name: 启动并设为开机自启
  ansible.builtin.systemd:
    name: %s
    enabled: true
    state: restarted
    daemon_reload: true

- name: 等待服务端口
  ansible.builtin.wait_for:
    host: "{{ mw_hosts[inventory_hostname].ip }}"
    port: "{{ mw.params.port }}"
    timeout: 120
`, o.Service))
	files[r+"tasks/health.yml"] = []byte(`- name: 服务端口在监听
  ansible.builtin.wait_for:
    host: "{{ mw_hosts[inventory_hostname].ip }}"
    port: "{{ mw.params.port }}"
    timeout: 30
`)
	conf := "# Managed by Middleware Hub for {{ mw_cluster.id }}/{{ mw.id }}. Do not edit by hand.\n" +
		"bind {{ mw_hosts[inventory_hostname].ip }}\nport {{ mw.params.port }}\ndir {{ mw.params.data_dir }}\n"
	switch o.Kind {
	case "primary-replica":
		conf += "{% if inventory_hostname in mw.roles.replica %}\nreplicaof {{ mw_hosts[mw.roles.primary[0]].ip }} {{ mw.params.port }}\n{% endif %}\n"
	case "cluster":
		conf += "{% for h in mw.roles.node %}\npeer {{ mw_hosts[h].ip }}:{{ mw.params.port }}\n{% endfor %}\n"
	}
	files[r+"templates/"+o.Name+".conf.j2"] = []byte(conf)
	files[r+"tasks/test_port.yml"] = append([]byte(nil), files[r+"tasks/health.yml"]...)
	return files, files.check()
}

var pkgNameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9.+-]{0,80}$`)

func kindTitle(k string) string {
	for _, s := range skeletonKinds {
		if s.ID == k {
			return s.Title
		}
	}
	return k
}

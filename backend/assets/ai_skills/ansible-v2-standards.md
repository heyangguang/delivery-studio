---
name: ansible-v2-standards
title: Ansible 2.0 原生架构、动态表单与全场景交付标准
description: Kyndryl Delivery Studio 2.0 纯原生 Ansible 架构全景规范：标准目录布局、AST 动态变量与条件表单、离线交付包独立执行、执行中心自动编排（含 --check --diff）及存量集群纳管。
---
# Ansible 2.0 原生架构、动态表单与全场景交付标准

## 1. 核心理念：100% 标准 Ansible，零私有锁定
Kyndryl Delivery Studio 2.0 彻底摒弃私有 DSL 与 `mw.*` 魔改变量，所有内置 8 大标杆组件（`patroni-native`、`postgresql-native`、`redis-native`、`etcd-native`、`nginx-native`、`haproxy-native`、`keepalived-native`、`external-lb-native`）与外部导入资产均为标准 Ansible 工程，脱离平台即可直接运行：
```bash
ansible-inventory -i inventory/hosts.yml --graph
ansible-playbook -i inventory/hosts.yml playbooks/deploy.yml --check --diff
ansible-playbook -i inventory/hosts.yml playbooks/deploy.yml
ansible-playbook -i inventory/hosts.yml playbooks/verify.yml
ansible-playbook -i inventory/hosts.yml playbooks/probe.yml
```

## 2. AST 动态表单自动识别协议
向任意 2.0 组件的 Ansible 源码新增或修改变量，无需改一行前端代码，经典交付页面（`#/new/<component>`）自动同步渲染：
- **来源优先级**：`roles/*/meta/argument_specs.yml` → `roles/*/defaults/main.yml`（保序解析并提取 `#` 注释）→ `group_vars/all.yml` → Playbook `vars:`。
- **自动类型与控件**：`choices`→下拉枚举、`password/secret/no_log`→密码框+一键随机生成、`*_port`→端口(`1..65535`)、`bool`→开关、`*cidr*`→CIDR 校验、`*_dir/*_path/*_file`→路径、`list`/`dict`→标签数组/JSON 块。
- **自动条件显隐（`when:`）**：引擎扫描模板 `{% if ... %}` 与任务 `when:`（取部署路径交集，排除 `probe.yml`/`cleanup.yml`/`assert`/`debug`），自动生成前端实时联动条件：
  - 开关联动（如 `patroni_synchronous_mode == true`、`haproxy_stats_enabled == true`、`*_apply_baseline == true`）
  - 枚举联动（如 `nginx_proxy_mode == 'stream'`、`elb_mode == 'domain'`、`elb_health_check_type == 'http'`）
  - 主机组联动（如 `group.etcd == 0` 自动显现 `patroni_external_etcd_hosts`）

## 3. 三大交付与治理闭环
1. **离线交付模式（`offline`）**：生成 `<cluster>-ansible-v2.tar.gz`、`SHA256SUMS` 与交互式交付手册；可选内网镜像源时自动注入 `playbooks/configure-offline-repo.yml`。在任意装有 `ansible-core` 的控制节点验签解压即可离线部署。
2. **自动化编排模式（`automatic`）**：通过执行中心已授权的 Linux 控制节点全自动下发执行、流式回传脱敏日志与结构化结果；支持开启 `--check --diff` 只读差异预演（严格隔离不污染正式完成度），以及在线修订配置二次应用。
3. **存量集群纳管（`#/import`）**：支持直接选择 2.0 原生组件或外部中间件，生成 100% 只读探针脚本或利用 2.0 `playbooks/probe.yml` 采集现网拓扑、版本与生效参数，经解析确认后一键纳管并进入日常巡检、安全评估与变更演练闭环。

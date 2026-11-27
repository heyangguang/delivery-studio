---
name: component-authoring
title: 原生 Ansible 2.0 组件编写与动态表单规范
description: 编写、导入或修改 Kyndryl Delivery Studio 2.0 纯原生 Ansible 组件（Role / Collection / Playbook 工程）的标准规范：零私有 DSL、自动动态表单识别、条件显现、幂等任务、离线与自动化双通道验收。
---
# 原生 Ansible 2.0 组件编写与动态表单规范

Kyndryl Delivery Studio 2.0 全面采用 **100% 标准原生 Ansible 引擎**（`schema: studio/v2`）。所有组件都是标准、可脱离平台直接执行 `ansible-playbook` 的 Ansible 工程，**严禁引入 `mw.params`、`mw.roles`、`mw_step_inputs` 等 v1 私有变量或魔改 DSL**。

## 1. 标准目录结构（4 类原生形态全部支持）
平台原生支持导入或编写以下任意一种标准 Ansible 资产，且原 Ansible 源码零改动：
1. **标准 Playbook 工程仓库（推荐，内置 8 大标杆组件形态）**：
   - `delivery-studio.yaml`：极薄平台适配描述（仅声明标题、图标、入口 Playbook、分组与快捷方案；可自动推导生成）
   - `playbooks/deploy.yml`：主部署剧本（可含多个 Play 或 `--tags`）
   - `playbooks/verify.yml`：验收检查剧本（校验配置语法、端口监听、主从复制/仲裁状态）
   - `playbooks/probe.yml`：纯只读探测剧本（用于纳管存量集群及线上实测采集，严禁任何写操作）
   - `playbooks/cleanup.yml`：清理回收剧本（安全停止服务并回收配置）
   - `roles/<role>/defaults/main.yml`：所有可配参数及默认值（保持声明顺序与中文注释）
   - `roles/<role>/meta/argument_specs.yml`：Ansible 2.11+ 官方参数契约（`type` / `default` / `choices` / `required` / `no_log` / `description`）
   - `roles/<role>/tasks/main.yml`、`handlers/main.yml`、`templates/*.j2`
2. **标准 Ansible Role**（Galaxy / GitHub Role 压缩包或仓库，平台自动无损封装 `roles/<name>/` 与 `playbooks/deploy.yml`）
3. **标准 Ansible Collection**（含 `galaxy.yml`）
4. **单文件 Playbook YAML**（含 `hosts:` 与顶层 `vars:`，直接粘贴即可解析）

## 2. 动态表单与自动变量识别标准（新增 Ansible 变量即自动出表单）
前端经典交付页（`#/new/<component>`）的**全部参数表单控件、语义分组、单位、范围校验与条件显隐**，均由后端 AST 解析引擎自动从 Ansible 源码提取，**禁止在前端硬编码任何组件表单逻辑**：
- **自动提取来源（按顺序保序合并）**：
  1. `roles/*/meta/argument_specs.yml`（推荐：声明 `type`、`choices`、`required`、`no_log` 与中文 `description`）
  2. `roles/*/defaults/main.yml`（保序解析 YAML 键，并自动提取行尾/行首 `#` 注释作为字段说明）
  3. `group_vars/all.yml` 与 Playbook 顶层 `vars:`
- **控件类型自动映射规则**：
  - `choices` 非空 → 下拉单选（`select` / `enum`）
  - 变量名含 `password` / `secret` / `auth_pass` 或 `no_log: true` → 密码框 + 一键随机生成强密码（`secret`）
  - 整型且变量名以 `_port` 结尾或等于 `port` → 端口输入框（`1..65535`，带 `TCP/UDP` 单位）
  - `type: bool` 或布尔默认值 → 开关控件（`bool`）
  - 变量名含 `cidr` → CIDR 网段校验框（`cidr` / `cidr-list`）
  - 变量名以 `_dir` / `_path` / `_file` 结尾 → 路径输入框（`path`）
  - YAML 数组 / 字典 → 多项标签/数组控件（`list`）或 JSON/YAML 键值对控件（`dict`）
  - 单位自动识别：`_ms` → `ms`，`_ttl` / `_wait` / `_timeout`（整型）/ `_advert_int` / `_keepalive` → `s`，`_bytes` / `lag_on_failover` → `bytes`
- **语义分组自动归类**：
  - `basic`（基础配置）→ `network`（网络与端口）→ `ha`（高可用与流量治理）→ `security`（安全与凭据）→ `tuning`（性能、存储与日志）→ `baseline`（操作系统内核基线，含 `*_apply_baseline` 开关，子项默认折叠为高级参数）
- **条件显现（`when:`）全自动 AST 推导**：
  - 后端自动扫描 `roles/*/tasks/*.yml`、`playbooks/deploy.yml`、`playbooks/verify.yml` 中的 `when:` 条件，以及 `templates/*.j2` 中的 `{% if ... %}` 分支（计算跨文件使用点的最小必要条件交集，自动跳过只读 `probe.yml`/`cleanup.yml`/`assert`/`debug`）。
  - 只要在模板或任务中用标准 Ansible 写法守卫变量，前端即自动添加「条件联动」徽章并实时联动显隐：
    - 枚举条件：`{% if nginx_proxy_mode == 'stream' %}` / `when: elb_mode == 'domain'` → `nginx_proxy_mode == 'stream'` / `elb_mode == 'domain'`
    - 开关条件：`when: haproxy_stats_enabled | bool` / `{% if patroni_synchronous_mode | bool %}` / `when: redis_apply_baseline | bool` → `xxx == true`
    - 主机组空/非空条件：`{% if groups['etcd'] | length > 0 %} ... {% else %} {{ patroni_external_etcd_hosts }} {% endif %}` → `group.etcd == 0`
- **新增变量规范**：只需在 `defaults/main.yml` 与 `meta/argument_specs.yml` 追加变量，并在模板/任务中真实消费（若为条件变量则包裹在对应 `{% if %}` 或 `when:` 中），保存后交付表单立即自动渲染新控件。

## 3. 编写与修改 2.0 组件的 AI 工具链
- 查看现有 2.0 组件：`list_ansible_v2_components`
- 检查组件结构、AST 变量、Playbook 步骤与源码：`inspect_ansible_v2_component`
- 静态规范与安全校验（拦截 `mw.*` 私有变量、路径逃逸、硬编码私钥等）：`validate_ansible_v2_files`
- 用户明确要求创建/保存/修复时，校验通过后调用：`save_ansible_v2_component`

## 4. 质量与生产实践红线
- **100% 幂等**：优先使用标准内置模块（`ansible.builtin.package` / `template` / `systemd` / `wait_for`），使用 `command`/`shell` 时必须配置 `changed_when` 或 `creates`。
- **配置变更触发重启/重载**：模板任务务必绑定 `notify:` handler（如重启 `etcd`、`haproxy`、`nginx`、`redis-server`、`postgresql`、`patroni`），保证调参修订后真实生效。
- **支持 `--check --diff` 预演**：模板渲染、配置下发与内核参数支持 check mode；有依赖前序产物的只读校验任务可按需设置 `check_mode: false` 或条件跳过。
- **Ubuntu 24.04 etcd 3.4 必配**：以 YAML `--config-file` 启动 etcd 3.4 时，必须显式写入 `enable-grpc-gateway: true`，否则 Patroni `etcd3:` 访问 `/v3` 会报 404。
- **安全与敏感信息**：严禁在组件中硬编码私钥或真实生产凭据；敏感变量在 `argument_specs.yml` 中标注 `no_log: true`，任务中涉及口令时加 `no_log: true`。
- **离线与自动化兼容**：平台交付自动生成标准 `inventory/hosts.yml`、`inventory/group_vars/all.yml`、`ansible.cfg`、`README.md`、`SHA256SUMS` 与 `<cluster>-ansible-v2.tar.gz`，同时支持离线独立运行与执行中心自动编排；可选内网镜像源时自动注入 `playbooks/configure-offline-repo.yml`。

## 5. v1 历史组件兼容、命令入口与沙箱校验说明
- 若用户维护位于「v1 兼容组件」标签页的历史 `component.yaml` 组件，沿用 `component_guide` 与 `propose_files` 局部修改；v1 离线交付包仅提供 `bin/ansible-playbook` 和 `bin/ansible-inventory`（没有 bin/ansible）。所有新建组件与演进均以 **Ansible 2.0 原生组件**为唯一标准。
- 编写或排错期间如需离线校验脚本语法、YAML 结构或对照工程快照，在沙箱可用时可调用 `run_shell` / `run_python`（传入 `workspace=true` 将脱敏只读快照挂载至 `/workspace`）。

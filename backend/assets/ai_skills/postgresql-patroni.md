---
name: postgresql-patroni
title: PostgreSQL 与 Patroni 高可用
description: Patroni 集群状态判读、主从复制、故障切换、pg_rewind、复制槽与 WAL 堆积、连接与认证（pg_hba）问题。
---
# PostgreSQL 与 Patroni

## 先识别方案（兼容 Ansible 2.0 与 v1 历史交付）
- **Ansible 2.0 原生组件**：
  - `postgresql-native`：单机（`single`）或一主一从/一主二从物理流复制（`primary-replica` / `primary-2replicas`，人工切换，无 etcd）。
  - `patroni-native`：三节点同机融合高可用（`ha-3-colocated`）、双节点 Patroni + 外部独立 etcd（`ha-2-external-etcd`，`etcd` 组为空时填写 `patroni_external_etcd_hosts`）、或三节点强一致同步高可用（`ha-3-sync`，`patroni_synchronous_mode: true`）。
  - 注意：Ubuntu 24.04 下 `etcd 3.4` 通过 YAML `--config-file` 启动时必须包含 `enable-grpc-gateway: true`，否则 Patroni `etcd3:` 访问 `/v3` 会报 404。
- **v1 历史交付**：读当前 `scheme`、`deployment_mode`、角色及生成配置；`single` 是单机、`replication` 是原生复制、`patroni` 才有 Patroni/etcd。不能在单机要求 `patronictl`，不用节点数推断高可用。

## 核对实际状态
从生成 unit/任务确认可执行文件、服务名、配置路径、端口和数据目录。Patroni 模式才用已核实配置路径的 patronictl list；REST 端口读交付定义，不固定为 8008。SQL 注明主库或从库，使用实际 psql 路径和账号，不嵌入口令。

## 配置生效
对照 SHOW config_file、SHOW hba_file、SHOW data_directory 及 pg_settings 的 setting/source/sourcefile/pending_restart，敏感结果需隐藏。检查主配置确实加载 conf.d，不因文件存在就认定已生效。
pg_hba 报错应查实际加载文件、源地址及 TLS。Patroni bootstrap.dcs 只在初始化生效；区分动态配置、本地配置与模板来源，不能一律建议 edit-config。现场修改后还需说明是否修正组件源。

## 故障与恢复
Replica 不启动核对日志、复制权限、槽和基础备份；主库查看 pg_stat_replication。WAL 堆积核对槽、归档和保留策略，不先删槽或 WAL。无 Leader 仅在 Patroni 场景核对 DCS，不手工 promote 绕过管理器。
切换、重启、reinit、配置编辑均非只读操作；提供影响、前置条件、验证和回退。PITR 要核对可用全量备份及连续 WAL。单机跳过 HA、切换和从库备份属于不适用，不是失败。
**临时状态复位红线**：凡为变更临时执行了 `patronictl pause`（维护模式）、计划内 `switchover`（非永久迁主）、临时放宽 `synchronous_mode`/`synchronous_node_count`/`pg_hba`/调试日志，或创建了临时测试表/账号/备份槽，必须在正向收尾步骤中显式 `patronictl resume`、切回原主库、恢复原同步与日志策略并清理临时测试对象，验收时确认 `patronictl list` 无 `Maintenance mode` 残留。

## 参数核算脚本（可用时）
评估或复核内存与并发参数时，若可用 `run_skill_script`，可调用本技能随附的 `calc_pg_tuning.py`（传入 `memory_gb`、`cpus`、`max_connections`、`workload` 可选 `oltp`/`olap`/`mixed`），结合核算输出与现场 `pg_settings`、连接池形态及余量综合给出建议。

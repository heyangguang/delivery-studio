---
name: middleware-logging-observability
title: 日志、轮转与可观测性核对
description: 核对交付中的日志参数、文件落盘、journald 持久化与容量上限、logrotate 轮转、慢查询/审计日志及监控接入缺口。
---
# 日志、轮转与可观测性核对

## 一步快速定位（优先用原生搜索）
回答“日志配置有没有、哪些日志开了、会不会撑爆磁盘、有没有轮转”这类高频问题时，不要逐个盲读文件，也不必为此启动沙箱命令：
1. 先看 `delivery_info` 确认交付包含的组件、模式（离线/自动/仅配置）与显式参数。
2. 用 `search_files`（设置 `regex: true`）一次性在交付项目中检索日志相关关键字：
   - 例如：`log_directory|logging_collector|log_filename|log_rotation|logfile|logrotate|journald|log-path|access_log|error_log|log_level|log_min_duration`
3. 只对命中的模板或 `defaults/main.yml` 用 `read_file`（可带 `from_line`）精读上下文，对照未命中的项直接给出“已有 / 缺失”清单。

## 各组件常见日志检查点
- **PostgreSQL / Patroni**：
  - 区分“日志内容参数”（`log_min_duration_statement`、`log_checkpoints`、`log_connections`、`log_disconnections`、`log_lock_waits`、`log_line_prefix`）与“落盘与轮转参数”（`logging_collector`、`log_destination`、`log_directory`、`log_filename`、`log_rotation_age`、`log_rotation_size`、`log_truncate_on_rotation`）。
  - Patroni 模式下，若未开 `logging_collector` 且 `patroni.yml` 无 `log:` 段，PG 与 Patroni 日志均走 `stderr` 进入 `systemd-journald`（`journalctl -u patroni`）。
  - 同步核对 `pgBackRest` 日志目录（如 `/var/log/pgbackrest`）是否有 `logrotate` 规则。
- **Redis / Sentinel**：
  - 核对 `redis.conf` 与 `sentinel.conf` 的 `logfile`、`loglevel`、`slowlog-log-slower-than`、`slowlog-max-len` 以及对应的 `logrotate`（注意 `copytruncate` 或 `postrotate` 处理方式）。
- **etcd**：
  - 核对 `logger: zap`、`log-level`、`log-outputs`（默认 `stderr` 进 `journald`）。
- **Nginx / HAProxy / keepalived**：
  - 核对 `access_log` / `error_log` / `syslog` 目标路径、`logrotate` 保留天数与大小上限，避免入口高 QPS 撑爆 `/var/log`。

## 离线交付如何核对现场实际生效状态
交付包只决定“平台下发了什么”，宿主机默认 `journald` 持久化（`/var/log/journal` 与 `SystemMaxUse`）和系统自带 `/etc/logrotate.d/*` 需在现场确认。回答时分开写清：
1. **交付包内已配置项**（附具体文件路径和行号）；
2. **交付包内未配置/沿用默认项**及潜在运维风险（丢日志或占满磁盘）；
3. **目标机只读核对命令**（如 `journalctl --disk-usage`、`ls -ld /var/log/journal`、`ls /etc/logrotate.d`、`df -h /var/log`），再询问是否需要出提案补齐。

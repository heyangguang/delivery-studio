---
name: redis-sentinel
title: Redis 与哨兵高可用
description: Redis 单机与主从+哨兵（Sentinel）架构核对、复制与故障转移排障、内存与持久化评估、日志与轮转核查。
---
# Redis 与哨兵高可用

## 先核对方案与交付事实
先用 `delivery_info` 和 `search_files` 确认当前交付是单机还是主从+哨兵 HA（`master_name`、`redis_port`、`sentinel_port`、`sentinel_quorum`、`persistence`、`maxmemory`、`data_dir`），不要凭节点数量假设有哨兵，也不要在单机方案上给出 `SENTINEL` 命令。

## 只读状态核对
在已核实的业务节点上执行只读检查（注意不要在命令里明文嵌入密码，如需认证使用现场环境变量或交互方式）：
- 服务状态：`systemctl status redis-server redis-sentinel --no-pager`（实际 unit 名以交付任务文件为准）
- 复制与内存：`redis-cli -h 127.0.0.1 -p <redis_port> INFO replication`、`INFO memory`、`INFO persistence`
- 哨兵视角：`redis-cli -h 127.0.0.1 -p <sentinel_port> SENTINEL masters`、`SENTINEL replicas <master_name>`、`SENTINEL ckquorum <master_name>`

## 故障转移与哨兵日志判读
- **哨兵事件顺序不要误判**：分布式选举中，某个哨兵节点可能先响应其他哨兵的投票请求（本地日志先出现 `+vote-for-leader`），之后才在本机记录 `+sdown`、`+odown`，最终记录 `+switch-master`。只要多数派达成一致、选出新主且旧主恢复后顺利降为从库并同步数据，本地日志中 `+vote-for-leader` 排在 `+sdown`/`+odown` 之前属于正常现象，不能据此误判故障转移异常。
- **常见故障转移失败原因**：`sentinel_quorum` 超过存活哨兵数、`down-after-milliseconds` 与网络抖动不匹配、从库 `replica-priority 0` 禁止升主、密码认证（`masterauth` / `requirepass`）主从不一致、防火墙拦截 `redis_port` 或 `sentinel_port`。
- **切主或重启旧主前务必核对持久化**：若 `persistence: none`（纯缓存模式），任意节点重启会清空该节点数据；严禁把空数据的旧主直接当主库拉起导致覆盖新主，必须先确认哨兵已指向新主再以从库身份恢复。
- **临时状态复位与测试数据清理**：凡为滚动升级或维护临时执行了 `SENTINEL FAILOVER`、临时调低 `replica-priority` / `min-replicas-to-write`、或写入了临时验收 Key，完成后必须在正向收尾步骤中切回原主（除非明确保留新主）、恢复原参数配置并 `DEL` 清理临时测试 Key。

## 内存、持久化与内核基线
- 检查 `maxmemory`、`maxmemory-policy`、`vm.overcommit_memory=1`、`transparent_hugepage=never`、`somaxconn` 和 `nofile`。
- 若开启 RDB 或 AOF 持久化，`bgsave` / `bgrewriteaof` 会触发 `fork()` 写时复制（Copy-on-Write），高写入场景下内存占用可能短时翻倍，必须预留足够内存余量。
- 核对日志路径（`logfile`）与 `logrotate` 配置，防止大流量或频繁连接导致日志占满磁盘。

## 内存与复制积压核算（可用时）
评估或复核 Redis 内存上限与持久化安全余量时，若可用 `run_skill_script`，可调用本技能随附的 `calc_redis_memory.py`（传入 `memory_gb`、`persistence` 可选 `none`/`rdb`/`aof`/`both`、`instances`），结合宿主机实际内存与客户端连接峰值给出配置建议。

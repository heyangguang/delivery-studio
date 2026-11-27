---
name: etcd-ops
title: etcd 集群运维
description: etcd 健康检查、成员管理、空间配额告警（NOSPACE）、压缩与碎片整理、快照备份恢复、选举超时与磁盘延迟。
---
# etcd 运维

## 交付事实优先（兼容 Ansible 2.0 与 v1）
先核对版本、端点、成员、工具路径、配置文件（如 `/etc/etcd/etcd.conf.yml`）与 systemd `LimitNOFILE`。内置 2.0 `etcd-native` 支持独立 3 节点 Raft 集群（可由 `patroni-native` 的 `ha-2-external-etcd` 方案接入）及 `etcd_heartbeat_interval` / `etcd_election_timeout` / `etcd_log_level` / `etcd_nofile` 等参数调优；Ubuntu 24.04 的 etcd 3.4 YAML 配置必须保留 `enable-grpc-gateway: true` 以开启 `/v3` HTTP gRPC-Gateway 接口。内置默认未启用自身 TLS，不能把 PG TLS 当 etcd TLS；现场已有证书时也不能忽略。

## 健康
在明确节点使用已核实路径的 etcdctl。每条命令都带实际 --endpoints 或明确设置的 ETCDCTL_ENDPOINTS，不能默认为 localhost；检查 endpoint health、endpoint status -w table、member list -w table、alarm list。不原样输出省略号或占位符。

## 配额与成员
NOSPACE 先检查 DB 大小、配额、磁盘和 revision。compact、defrag、alarm disarm 均改变状态，不当只读检查连着运行；确认备份、多数派及历史 revision 使用需求后逐成员处理，不能直接压缩到最新 revision。
成员变更应先在集群「变更演练」评估步骤与风险；手工 member add/remove 需成员 ID、顺序和回退。多数派丢失时不盲目移除成员。性能参数依据指标、日志和网络延迟调整。

## 备份恢复
确认当前版本实际提供 etcdctl/etcdutl 及所需功能，不假设两个工具都存在。备份要明确位置、校验与离机副本。恢复会重建集群，须核对快照、成员映射、新数据目录和停机范围，不给通用单行命令就声称可执行。

## 容量与多数派核算（可用时）
评估节点故障容错或 NOSPACE 配额水位时，若可用 `run_skill_script`，可调用本技能随附的 `calc_etcd_quorum.py`（传入 `nodes`、`db_size_mb`、`quota_gb`），先核算法定多数派 `quorum`、容错节点数及使用率分级，再给出压缩、碎片整理或调整方案。

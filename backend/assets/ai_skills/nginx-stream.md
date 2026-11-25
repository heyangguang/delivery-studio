---
name: nginx-stream
title: Nginx Stream 四层负载均衡
description: Nginx Stream TCP/UDP 负载均衡配置核对、上游健康探测与熔断、超时参数、平滑重载与 VIP/防火墙联动排查。
---
# Nginx Stream 四层负载均衡

## 先核对交付事实
先用 `delivery_info` 与 `search_files` 确认当前交付中 Nginx（stream）监听的入口端口、绑定后端（`binds` / `upstream`）、是否搭配 `keepalived` 提供 VIP、配置路径（如 `/etc/nginx/nginx.conf` 与 `stream.d/`）以及日志路径，不要照搬 HTTP 7 层指令（`http {}` 下的指令在 `stream {}` 中大多不合法）。

## 配置校验与平滑重载
- 改动或核对配置前，先执行只读语法校验：`nginx -t`（或查看完整展开配置 `nginx -T`）。
- 确认通过后再平滑重载：`systemctl reload nginx`（不要直接 `restart` 导致存量长连接被强行断开）。
- **临时摘除/降权必须复位**：若维护期间在 `upstream` 中临时加了 `down`、调低权重或注释了后端节点，维护完成后必须在正向收尾步骤中恢复原配置、`nginx -t` 校验并 `systemctl reload nginx` 确认全部后端恢复承载流量。

## 四层代理关键参数核查
- **被动健康检查与熔断**：核对 `server <ip>:<port> max_fails=<N> fail_timeout=<T>;`，以及 `proxy_next_upstream on;`、`proxy_next_upstream_tries`、`proxy_next_upstream_timeout`，避免后端单节点故障时连接长时间挂死。
- **连接与空闲超时**：数据库长连接（如 PostgreSQL、Redis）要重点核对 `proxy_connect_timeout` 与 `proxy_timeout`；`proxy_timeout` 过短会频繁断开空闲连接池，过长会堆积僵尸连接。
- **连接数与文件句柄**：核对 `worker_processes`、`worker_connections`、`worker_rlimit_nofile` 与 systemd `LimitNOFILE`，确保承载并发连接（每条四层连接占用前后 2 个 fd）。
- **透明代理与源 IP**：默认四层 NAT 代理下后端看到的是 Nginx 节点 IP；确认后端白名单（如 PG `pg_hba.conf` / `client_cidr`）已放行 Nginx 节点网段。

## 日志与网络排查
- 核对 `stream` 是否配置了 `access_log`、`error_log` 及对应的 `logrotate` 规则；高并发短连接场景注意开启 `buffer` 或控制日志级别避免磁盘 I/O 成为瓶颈。
- 端口不通时按顺序排查：监听端口 `ss -lntp | grep nginx` → 本机到后端连通性 → 防火墙与 SELinux（RHEL 系注意 `semanage port -l | grep http_port_t` 与 `nis_enabled` 布尔值，按最小权限放行）→ 若启用 VIP，再核对 `keepalived` 状态。

---
name: haproxy-keepalived
title: 负载均衡与 VIP
description: HAProxy 后端健康检查、配置校验与平滑重载，keepalived VIP 漂移、脑裂、VRRP 通信问题。
---
# HAProxy 与 keepalived

## HAProxy
- 校验配置：`haproxy -c -f /etc/haproxy/haproxy.cfg`（先校验再重载）。
- 平滑重载：`systemctl reload haproxy`。
- 健康检查不过：从 HAProxy 机器上直接 `curl` / `nc` 后端检查地址（比如 Patroni 的 `:8008/primary`），看返回码。

## keepalived
- VIP 在哪台：`ip -br addr | grep <vip>`。
- 日志：`journalctl -u keepalived -n 100 --no-pager`。
- **两台都持有 VIP（脑裂）**：VRRP 报文不通。检查防火墙是否放行 VRRP（协议 112）、组播是否被网络屏蔽（可改单播 `unicast_peer`）、`virtual_router_id` 两边一致且网段内唯一。
- **VIP 不漂移**：`track_script` 的检查脚本返回值、`weight` 设置；失败后的有效优先级应低于健康备机；例如 150/140 配合失败减 30 可以让位，不能要求优先级差大于扣分。
- 云环境通常不支持 VRRP/漂移 IP，需要云负载均衡。

## 平台实际配置优先
当前模板仅按 stats_enabled 开启本机 stats HTTP 页面，未默认声明 admin.sock；不要生成不存在的套接字命令。健康检查地址/端口读取交付端点，不固定套用 8008。external-lb 仍受支持但只登记入口，不代表平台已配置云 ELB。SELinux 先核对 AVC 与最小放行范围，不默认放开 haproxy_connect_any。

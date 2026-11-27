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
- **临时摘流/维护态必须复位**：若为维护临时将后端置为 `maint`/`drain`、权重置 `0`，或临时调整 Keepalived 优先级/停止 Keepalived 触发 VIP 漂移，变更完成后必须在正向收尾步骤中恢复 `ready` / 原权重与原主节点 VIP 归属，并确认后端全部 `UP`。

## keepalived
- VIP 在哪台：`ip -br addr | grep <vip>`。
- 日志：`journalctl -u keepalived -n 100 --no-pager`。
- **两台都持有 VIP（脑裂）**：VRRP 报文不通。检查防火墙是否放行 VRRP（协议 112）、组播是否被网络屏蔽（可改单播 `unicast_peer`）、`virtual_router_id` 两边一致且网段内唯一。
- **VIP 不漂移**：`track_script` 的检查脚本返回值、`weight` 设置；失败后的有效优先级应低于健康备机；例如 150/140 配合失败减 30 可以让位，不能要求优先级差大于扣分。
- 云环境通常不支持 VRRP/漂移 IP，需要云负载均衡。

## 云 ELB / 四层负载均衡回环（Hairpinning）
- 绝大多数云 ELB / SLB / F5 / LVS DR 四层负载均衡在**当前承接流量的后端 RS 本机回环访问指向自身的 VIP** 时（例如当前主库本机连写入 VIP）会出现连接超时或 RST（回包走本地环路绕过 LB 会话表）。
- **务实操作与验收原则**：
  - 后端节点只读采集脚本不要内置直连自身 ELB/VIP 的探测，本机只检查本地监听端口、进程与 `127.0.0.1`/本机 IP 的健康检查接口；
  - 验证 ELB/VIP 入口连通性、读写路由及切主恢复时，优先在**后端集群之外的独立客户端或跳板机**执行；**若现场没有独立跳板机，也可以在非当前主库的从库节点测试写入入口**（流量经 ELB 转发至另一台主库，通常可避开同机回环）；
  - **禁止教条拒收有效实测结果**：只要从非主库节点连 VIP **实际连接成功并返回了目标主库 IP 且可读写**，即已证明 ELB 路由生效，直接认可为有效验收证据；
  - 只有当从后端节点侧连 VIP **确实报超时/RST** 时，才需区分是「ELB 回环限制」还是「入口真实故障」，建议改由业务端验证或改验各节点健康检查接口，切勿误判为服务不可用或把无独立跳板机的现场卡死。

## 平台实际配置优先（兼容 Ansible 2.0 `haproxy-native` / `keepalived-native` / `external-lb-native`）
- `haproxy-native`：按 `haproxy_stats_enabled` 动态联动开启 Stats 监控页（`haproxy_stats_port`，默认 8404），支持 `haproxy_check_interval` / `haproxy_check_fall` / `haproxy_check_rise` / `haproxy_maxconn` 调优；未默认声明 `admin.sock`，不要生成不存在的套接字命令。
- `keepalived-native`：支持 `keepalived_interface: auto` 自动识别默认网卡，配置 `keepalived_vip` / `keepalived_vip_prefix` / `keepalived_router_id` / `keepalived_advert_int`。
- `external-lb-native`：面向云 ELB / F5 硬件负载均衡生成标准配置清单（`checklist.md` + `listeners.json`），支持 `elb_mode`（`ip` / `domain` 自动联动 `elb_resolve_ip`）与 `elb_health_check_type`（`tcp` / `http` 自动联动 `elb_health_check_path`），并在 `elb_verify_frontend=true` 时核验前端入口连通性，但不自动调用云厂商 API 创建 ELB。
- SELinux 先核对 AVC 与最小放行范围，不默认放开 `haproxy_connect_any`。

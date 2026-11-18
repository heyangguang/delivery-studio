---
name: linux-diagnostics
title: Linux 现场诊断
description: 目标机器上的常见问题：磁盘满、端口被占、服务起不来、时间不同步、SELinux/防火墙拦截、内存与 inode、DNS 解析。
---
# Linux 现场诊断

给出的命令都是只读的；需要修改时明确说出来并给回退办法。

## 空间
- `df -h`，`df -i`（inode 也会满）
- 找大文件：`du -xh --max-depth=1 /data | sort -h | tail`
- 已删除但仍被进程占用的文件：`lsof +L1 | head`

## 端口与进程
- 谁在监听：`ss -ltnp '( sport = :5432 )'`
- 进程详情：`ps -o pid,ppid,user,lstart,cmd -p <pid>`
- 被占用时先确认是不是旧部署留下的，再决定停不停。

## 服务
- `systemctl status <svc> --no-pager`、`journalctl -u <svc> -n 200 --no-pager`
- 启动失败看 `Main PID` 退出码和日志最后几行；`ExecStartPre` 失败也会显示在这里。
- 改了 unit 文件要 `systemctl daemon-reload`。

## 时间
- `timedatectl`、`chronyc tracking`；集群（etcd、Patroni）对时间偏差敏感，阈值以交付检查和现场 SLA 为准，不把 1 秒当所有组件硬性标准。

## SELinux 与防火墙（RHEL 系）
- `getenforce`；被拦截时看 `ausearch -m avc -ts recent`。
- 非标准端口需要 `semanage port -a -t <type> -p tcp <port>`。
- `firewall-cmd --list-all`；Ubuntu 看 `ufw status` 或 `nft list ruleset`。

## 内存与资源
- `free -h`、`dmesg -T | grep -i -E 'oom|killed'`
- `ulimit -n`、服务的 `LimitNOFILE`。

## 网络与解析
- `getent hosts <name>`、`cat /etc/hosts`
- 节点之间：`nc -vz <ip> <port>`，必要时 `tracepath`。

## 当前交付优先
先核对系统、角色、服务名和数据目录。工具未安装时用已有只读替代，不要求离线机器临时联网安装。storage_mode=system_directory 允许普通目录，不因 /data 非挂载点判失败；检查目录及可用空间。

## 沙箱快照与日志解析（可用时）
- 用户在对话中提供磁盘/内存快照、系统日志或压缩诊断文本时，若可用 `run_skill_script`，可调用本技能随附的 `parse_disk_mem_snapshot.py`（支持 `warn_percent`、`df_text`、`free_text` 或自动读取 `/in` 下文件）统计挂载点超阈值情况；需要过滤、聚合长日志或对照配置片段时，可用 `run_python` 或 `run_shell` 在平台沙箱内离线分析 `$MW_IN`（`/in`）中的文件。
- 严格区分平台沙箱与客户目标机器：`run_shell` / `run_python` 仅用于平台隔离沙箱内对已上传材料的分析，不能访问或代替生产主机执行；涉及现场只读命令仍须明确目标主机后交由用户或授权后的现场执行步骤运行。

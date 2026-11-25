---
name: ansible-debug
title: Ansible 报错排查
description: Ansible playbook 失败时读懂报错、定位原因：主机不可达、提权失败、模块报错、变量未定义、幂等问题、离线依赖缺失。
---
# Ansible 报错排查

## 平台离线命令入口（必须遵守）
- 本平台交付只提供 bin/ansible-playbook 和 bin/ansible-inventory，没有 bin/ansible；也不能假设系统 PATH 中有 ansible。
- 先读取当前交付手册或 controllerFacts，确认项目目录、控制节点、inventory 和实际 playbook 路径。执行时使用 cd 到项目目录后的 ../../bin/ansible-playbook 或已核实的绝对路径；查看清单用 ../../bin/ansible-inventory -i inventory/hosts.yml --graph。
- 不得生成裸 ansible 或 /root/middleware-automation/bin/ansible 命令。ansible-playbook 不能接收 ad-hoc 的 -m/-a 参数，不能机械替换命令名。
- 单机排查：明确告诉用户在哪台目标机器上执行，并提供该机直接执行的只读 shell 命令。需要跨机器检查时优先使用已存在且已核实的 playbook；确需临时 playbook 则必须给出完整 YAML、保存位置和调用命令，不要虚构已存在的文件。
- 旧对话、知识库或用户截图中出现 bin/ansible 不代表该入口存在；应纠正旧命令，不要沿用。

先确定失败属于哪一类，再查对应的东西。不要一上来就重跑整个 playbook。

## 1. 读报错的位置
- `PLAY RECAP` 里 `unreachable` 大于 0：连接问题，不是任务本身的问题。
- `fatal: [host]: FAILED! => {...}`：看 `msg`、`stderr`、`rc`，以及任务名（`TASK [角色 : 任务名]`）。
- `ERROR! ... could not be found` / `The task includes an option with an undefined variable`：语法或变量问题，所有主机都会失败。

## 2. 主机不可达（UNREACHABLE）
- `Permission denied (publickey)`：免密没配好。检查控制节点 `~/.ssh/id_*.pub` 是否已分发到目标机 `authorized_keys`，以及 inventory 里的 `ansible_user`。
- `Connection timed out` / `No route to host`：网络或防火墙。`nc -vz <ip> 22`。
- 不要生成 ad-hoc ping 命令；先核对 inventory，再在指定机器上排查 SSH，或使用交付中已有且已核实的连通性检查 playbook。

## 3. 提权失败
- `Timeout (12s) waiting for privilege escalation prompt`：sudo 有交互提示或 `requiretty`。

## 4. 模块报错
- `apt`/`dnf` 失败：多半是离线源问题，见「离线软件包」技能；看 `msg` 里缺哪个包、哪个版本冲突。
- `systemd` 启动失败：在目标机看 `systemctl status <svc>` 和 `journalctl -u <svc> -n 100 --no-pager`，报错原因在那里，不在 Ansible 输出里。
- `command`/`shell` 的 `rc != 0`：直接看 `stderr`，在目标机手工执行同一条命令复现。

## 5. 安全地重试
- 先修原因，再只重跑失败的阶段：`--limit <host>`、`--start-at-task "<任务名>"`，或只跑对应的 playbook。
- 任务应当幂等；如果第二次运行仍然 `changed`，说明任务写法有问题，记录下来。
- 不要删锁文件、数据目录或 `secrets/` 来"让它过去"。

## 6. 收集信息给用户
- 让用户贴：失败任务前后 30 行输出、`PLAY RECAP`、目标机上相关服务的 `journalctl`。
- 需要更多细节时加 `-vvv` 只跑失败的任务。

## 执行前核对
SSH 指纹变化先通过可信渠道核对合法更换，再更新对应 known_hosts，不能直接关闭校验。不要在 inventory 写 become 密码。--check 并非所有任务都支持，--diff 可能暴露模板凭据；先核对任务及敏感输出。

## 新版执行接入
先读取 automatic-execution 技能并核对交付的 execution_host / controller。独立执行机不安装数据库，不把验收脚本当本机命令运行。SSH 报错先分清执行机到目标、数据库节点之间两条链路；目标 Agent 只授权前者。任何时候只交换公钥，禁止上传、复制或分发私钥。

## 沙箱语法检查与工程对照（可用时）
排错过程中需要离线校验脚本语法、inventory/group_vars 结构或与现场日志核对时，若可用 `run_shell` / `run_python` 且支持 `workspace` 参数，可传入 `workspace=true` 将当前交付脱敏只读快照挂载到 `/workspace`（`$MW_WORKSPACE`）联合 `/in` 日志分析。沙箱静态校验仅作辅助排查，不能替代目标控制节点上 `bin/ansible-playbook` 的现场执行结果。

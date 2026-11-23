---
name: offline-packages
title: 离线软件包与软件源
description: 离线 apt/dnf 源的搭建与校验、依赖缺失、版本冲突、GPG/签名、哈希校验失败的处理。
---
# 离线软件包

## 校验失败
- `sha256sum: WARNING: ... did NOT match`：上传不完整或被改写。在源端重算哈希对比；用二进制方式重传（堡垒机不要用文本模式）；不要改校验文件绕过。
- `--ignore-missing` 会静默跳过缺失文件，核对时要确认每个文件都显示 `OK`。

## apt（Ubuntu）
- 离线源配置在 `/etc/apt/sources.list.d/`，`apt-get update` 后看是否有 `404` 或 `Release` 问题。
- `Unable to locate package`：包不在离线仓库里，或 `Packages` 索引没生成。
- 依赖冲突：`apt-cache policy <pkg>` 看可选版本和来源；`apt-get install -s <pkg>` 模拟安装。
- 原有源被备份停用时，备份通常在 `/etc/apt/backup-before-offline-*`。

## dnf（RHEL 系）
- `dnf repolist`、`dnf --disablerepo='*' --enablerepo=<离线源> list available`。
- `nothing provides X needed by Y`：依赖闭包不全，需要在平台软件库里补包重新生成。
- 模块流冲突（如 postgresql 模块）：`dnf module list`，必要时 `dnf module disable`。

## 原则
- 缺包的根本解决是在平台软件库里补齐并重新生成交付，而不是在现场临时联网下载。

## 当前离线源实现
内置 apt 脚本生成 trusted=yes，dnf 生成 gpgcheck=0；这是当前实现，不是遇到签名错误就关闭验证的建议。先核对实际生成脚本、SHA256SUMS 和来源，不擅自降低已有签名策略。软件库、运行环境和应用版本分别核对；重新生成包不等于已现场部署。

## 沙箱离线校验说明（可用时）
用户上传 `SHA256SUMS`、包清单或索引文件（如 apt `Packages`、dnf 仓库清单）到存储空间时，可用 `run_shell` / `run_python`（读取 `/in` / `$MW_IN`）在平台沙箱内离线核对哈希列表或比对缺失依赖；不得假设沙箱自身联网或把沙箱内软件环境当作客户现场的离线源。

## Ansible 运行环境构建与依赖安全评估
评估软件库中 Ansible 运行环境的历史构建、依赖差异、CVE 修复价值及可否清理时：
1. 先调用 `library_runtimes` 读取平台真实的全部运行环境构建、各操作系统当前默认构建以及历史构建与默认构建的逐包差异；已生成的离线交付包自带运行环境快照，不依赖历史构建条目，只要历史构建不是任何操作系统的默认构建（`can_delete: true`）即可安全删除。
2. 核实依赖包的已知 CVE/GHSA 漏洞、首个修复版本、最新稳定版与 Python 兼容性时，首选专用工具 `check_package_security`（支持一次批量核查，直连 OSV.dev 与 PyPI 官方接口），必要时再用 `web_search` / `web_fetch` 查阅官方发行说明；仅在专用安全查询与搜索工具无法满足时，才将代码沙箱作为最后兜底。

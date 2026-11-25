# Kyndryl Delivery Studio — 分支管理、版本号与发版规范

> **状态**：**正式生效（v1.x+ 团队研发与交付基线）**
> 本规范统一约定 Git 分支模型、Commit 提交格式、语义化版本号（SemVer 2.0）、Tag 生命周期与发版流程，确保代码主干始终可构建、可回溯、GitHub Tags / Releases 清爽有序。

---

## 1. 分支模型（Trunk-Based + Release Branches）

采用业界主流的「**主干驱动 + 版本维护分支**」模型，避免长期双主干（GitFlow `develop`）带来的合并冲突：

| 分支类型 | 命名格式 | 生命周期 | 职责与规则 |
| :--- | :--- | :--- | :--- |
| **主干分支** | `main` | 永久保护 | 当前活跃演进主线。要求**始终保持可编译、核心测试绿灯**，严禁直接提交未验证代码或临时调试产物。 |
| **维护分支** | `release/<major>.<minor>`<br>例：`release/1.0`、`release/1.1` | 长期维护（至该版本停止支持） | 某正式大/次版本的稳定基线分支。只接收该版本的稳定修补与安全补丁（通过 `cherry-pick` 或 `hotfix/*` 合入），**不再合入破坏性新特性**。 |
| **特性分支** | `feat/<scope>-<slug>`<br>例：`feat/cluster-companion-versions` | 短期（1~5 天，合并后即删） | 从 `main` 拉出，开发新能力；验证通过合入 `main` 后立即删除本地与远端分支。 |
| **缺陷修复分支** | `fix/<scope>-<slug>`<br>例：`fix/import-exporter-icon` | 短期（合并后即删） | 从 `main` 拉出，修复缺陷；合入 `main` 后立即删除。 |
| **紧急热修分支** | `hotfix/<ver>-<slug>`<br>例：`hotfix/1.0-pg-tls` | 短期（合并后即删） | 当已交付版本（如 `release/1.0`）出现线上紧急故障时，从对应 `release/*` 分支拉出修复；合入后在维护分支发修订版（如 `v1.0.1`），并视需要 `cherry-pick` 回 `main`。 |
| **重构 / 文档 / 工程分支** | `refactor/<slug>`<br>`docs/<slug>`<br>`chore/<slug>` | 短期（合并后即删） | 目录治理、前端视觉重构、文档规范更新、依赖升级与构建脚本调整。 |

### 分支操作红线
1. **禁止对 `main` 与 `release/*` 执行 `git push --force`**，严禁随意改写已发布提交历史。
2. **短期分支合并即清理**：功能/修复/重构分支合入后立即删除，避免堆积僵尸分支。
3. **跨分支修 Bug 优先「先 `main` 后 `cherry-pick`」**：除非缺陷仅存在于维护分支，否则先在 `main` 修复验证，再 `git cherry-pick -x <sha>` 到 `release/*`。

---

## 2. Commit 提交规范（Conventional Commits）

所有提交统一格式：`<type>(<scope>): <简明描述>`

| Type | 含义 | 示例 |
| :--- | :--- | :--- |
| `feat` | 新功能 / 能力增强 | `feat(import): classify OS exporters and auto-detect generic *_exporter` |
| `fix` | 缺陷修复 | `fix(cluster): display locked package versions for embedded Patroni and pgBackRest` |
| `refactor` | 代码重构（不改变外部语义） | `refactor(repo): standardize 6-directory backend/frontend layout` |
| `perf` | 性能优化 | `perf(ai): throttle floating dock resize with rAF` |
| `style` | 样式/排版微调 | `style(design): refine pill spacing in cluster header` |
| `docs` | 文档与规范 | `docs(standard): add v1.0 directory and branching standards` |
| `test` | 补充或修正测试用例 | `test(import): add exporter classification and version parsing tests` |
| `chore` | 构建、发版、脚本、依赖 | `chore(release): v1.0.1 - companion versions & exporter classification` |

**常用 Scope**：`cluster`、`import`、`catalog`、`workbench`、`rehearsal`、`automation`、`library`、`security`、`ai`、`iam`、`settings`、`design`、`mwpack`、`pkglib`、`server`、`repo`、`scripts`、`release`、`standard`。

---

## 3. 版本号与 Git Tag 铁律（SemVer 2.0）

### 3.1 正式版格式：`vMAJOR.MINOR.PATCH`
- **`MAJOR`（主版本号）**：架构级不兼容演进或代际升级（如 `v1.0.0` → `v2.0.0`）。
- **`MINOR`（次版本号）**：向下兼容的新功能模块或重要能力增强（如 `v1.0.0` → `v1.1.0`）。
- **`PATCH`（修订版本号）**：向下兼容的 Bug 修复、体验优化与安全补丁（如 `v1.0.0` → `v1.0.1`）。

### 3.2 预发布版格式：`vMAJOR.MINOR.PATCH-(alpha|beta|rc).N`
仅在大/次版本对外发版前需要内测/验收时使用：
- `v1.1.0-alpha.1` → `v1.1.0-beta.1` → `v1.1.0-rc.1` → **`v1.1.0`**
- 按 SemVer 2.0 规则，正式版 `v1.1.0` 天然大于 `v1.1.0-*`，GitHub Tags 列表始终有序置顶。

### 3.3 Tag 严禁事项
1. **严禁使用 `v1.0.123-dev` 类递增 Patch 的开发标签**，会导致正式版倒挂在列表底部。
2. **日常开发与本地热更新不打 Tag**：日常联调统一使用 `.\scripts\dev-reload.ps1`（自动注入 `buildID = <短SHA>-<时间戳>`），普通代码改动正常 `git commit` 即可。
3. **禁止删除或移动已发布的正式 Tag**：正式版一旦打出并交付，历史锚点不可更改。

---

## 4. 标准发版流程

正式发版统一通过 [`scripts/release.ps1`](../scripts/release.ps1) 执行：

```powershell
# 1. 预览目标版本号（不改动文件）
& ".\scripts\release.ps1" -DryRun

# 2. 执行正式发版（自动跑回归测试 -> 构建双端 -> 更新 main.go 版本与公告 -> commit + tag + push + 本地热更新）
& ".\scripts\release.ps1" `
  -Version "1.0.1" `
  -Title "集群架构版本透传与 OS Exporter 智能分级" `
  -Highlights @(
    "平台交付集群架构组件胶囊自动透传 Patroni / pgBackRest / Redis Sentinel 锁定版本",
    "存量纳管新增 OS 组件分类并泛化支持任意 *_exporter 识别与版本采集"
  ) `
  -Commit -Push -Reload
```

发版完成后，可在 GitHub Releases 页面基于对应 Tag 创建正式 Release（附中英双语变更摘要、`delivery-studio-linux-amd64`、`delivery-studio-windows-amd64.exe` 与 `SHA256SUMS.txt`）。

# Kyndryl Delivery Studio — 分支管理、PR 评审与 SemVer 发版规范

> **状态**：**正式生效（v1.x+ 团队研发与交付基线）**
> 本规范统一约定 GitFlow 分支模型、Pull Request 强制门禁、CI 自动化检查、Conventional Commits、语义化版本号（SemVer 2.0）与发版流程，确保 `main` 始终对应已验证正式版本、`develop` 保持高水准集成质量。

---

## 1. 分支模型（GitFlow + PR Gate）

采用标准的「**开发集成主干（`develop`）+ 正式发布主干（`main`）+ 版本维护分支（`release/*`）+ 全流程 Pull Request**」模型：

| 分支类型 | 命名格式 | 生命周期 | 职责与合入规则 |
| :--- | :--- | :--- | :--- |
| **正式发布主干** | `main` | 永久保护 | **只对应已通过完整验收的正式发布版本**（对应 `vX.Y.Z` Tag）。**严禁直接 push**，仅通过 `release/*` → `main` 或 `hotfix/*` → `main` 的 PR 合入。 |
| **开发集成主干** | `develop` | 永久保护 | **日常研发、联调与全量回归测试主线**。所有新功能、优化、普通修复均从 `develop` 拉出短期分支，完成后提 PR 合入 `develop`。**严禁直接 push**。 |
| **版本预备/维护分支** | `release/<major>.<minor>`<br>例：`release/1.0`、`release/1.1` | 长期维护（至该版本停止支持） | 某大/次版本的稳定基线分支。从 `develop` 切出准备发版；正式发布后**冻结新特性**，仅接收 `hotfix/*` 或 `cherry-pick` 的缺陷/安全修补 PR。 |
| **特性分支** | `feat/<scope>-<slug>`<br>例：`feat/rehearsal-automation` | 短期（合入即自动删） | **从 `develop` 拉出**，开发新能力；推远端并提 PR 到 `develop`，由维护者审阅且 CI 全绿后合入。 |
| **缺陷修复分支** | `fix/<scope>-<slug>`<br>例：`fix/import-exporter-icon` | 短期（合入即自动删） | **从 `develop` 拉出**，修复缺陷；推远端并提 PR 到 `develop`。 |
| **紧急热修分支** | `hotfix/<ver>-<slug>`<br>例：`hotfix/1.0-pg-tls` | 短期（合入即自动删） | 当已发布版本（如 `release/1.0`）出现线上紧急故障时，**从对应 `release/*` 拉出**；分别提 PR 合入 `release/*`（发 `v1.0.x`）与 `develop` / `main`。 |
| **工程 / 重构 / 样式 / 文档** | `refactor/<slug>`、`style/<slug>`<br>`docs/<slug>`、`chore/<slug>` | 短期（合入即自动删） | 目录治理、视觉调优、CI 流水线、文档规范与脚本调整，均从 `develop` 拉出并提 PR 到 `develop`。 |

### 分支与 PR 铁律（硬红线）
1. **禁止直推保护分支**：严禁向 `main`、`develop`、`release/*` 直接执行 `git push` 或 `git push --force`，所有改动**必须走 GitHub Pull Request**。
2. **必须通过 CI 门禁**：PR 必须等待 `.github/workflows/ci.yml` 全部检查项（`Backend CI`、`Frontend Build & Typecheck`、`Repo Standard & Contracts`）绿灯。
3. **人工审阅合入（Owner Merge）**：AI 助手负责完成开发、本地验证、推送远端分支并创建结构化 PR（`gh pr create`），**严禁未经用户明确授权擅自合并 PR**，统一由仓库维护者审阅 Diff 后亲自在 GitHub 点击 Merge。
4. **合并后自动清理临时分支**：仓库开启 `delete_branch_on_merge`，PR 合入后自动删除远端短期分支；本地拉取最新 `develop` 并清理已合并分支。
5. **维护分支冻结新特性**：已发版的 `release/1.0` 绝不再合入新 `feat/*` 特性，新特性统一在 `develop` 演进并于下一小版本（如 `release/1.1` → `v1.1.0`）随 PR 正式合入 `main`。

---

## 2. Commit 提交规范（Conventional Commits）

所有提交统一格式：`<type>(<scope>): <简明描述>`

| Type | 含义 | 示例 |
| :--- | :--- | :--- |
| `feat` | 新功能 / 能力增强 | `feat(rehearsal): add dual-transport automated execution` |
| `fix` | 缺陷修复 | `fix(cluster): display locked package versions for embedded Patroni` |
| `refactor` | 代码重构（不改变外部语义） | `refactor(repo): standardize 6-directory backend/frontend layout` |
| `perf` | 性能优化 | `perf(ai): throttle floating dock resize with rAF` |
| `style` | 样式/排版微调 | `style(automation): add semantic amber/green status colors to icons` |
| `docs` | 文档与规范 | `docs(standard): upgrade to GitFlow PR and CI governance` |
| `test` | 补充或修正测试用例 | `test(rehearsal): add dual-transport execution safety gate tests` |
| `chore` | 构建、CI、发版、脚本、依赖 | `chore(ci): add GitHub Actions CI workflow and PR template` |

**常用 Scope**：`cluster`、`import`、`catalog`、`workbench`、`rehearsal`、`automation`、`library`、`security`、`ai`、`iam`、`settings`、`design`、`mwpack`、`pkglib`、`server`、`repo`、`ci`、`scripts`、`release`、`standard`。

---

## 3. 版本号与 Git Tag 铁律（SemVer 2.0）

### 3.1 正式版格式：`vMAJOR.MINOR.PATCH`
- **`MAJOR`（主版本号）**：架构级不兼容演进或代际升级（如 `v1.0.0` → `v2.0.0`）。
- **`MINOR`（次版本号）**：向下兼容的新功能模块或重要能力增强（如 `v1.0.0` → `v1.1.0`）。
- **`PATCH`（修订版本号）**：向下兼容的 Bug 修复、体验优化与安全补丁（如 `v1.0.0` → `v1.0.1`）。

### 3.2 预发布版格式：`vMAJOR.MINOR.PATCH-(alpha|beta|rc).N`
- `v1.1.0-alpha.1` → `v1.1.0-beta.1` → `v1.1.0-rc.1` → **`v1.1.0`**
- 按 SemVer 2.0 规则，正式版 `v1.1.0` 天然高于 `v1.1.0-*`，GitHub Tags 列表始终有序置顶。

### 3.3 Tag 严禁事项
1. **严禁使用 `v1.0.123-dev` 类递增 Patch 的开发标签**，会导致正式版倒挂在列表底部。
2. **日常开发与本地热更新不打 Tag**：日常联调统一在功能分支或 `develop` 执行 `.\scripts\dev-reload.ps1`（二进制自动注入 `buildID = <短SHA>-<时间戳>`）。
3. **禁止删除或移动已发布的正式 Tag**。

---

## 4. 标准开发与发版全流程

### 4.1 日常开发（必走 PR → `develop`）
```powershell
git checkout develop; git pull origin develop
git checkout -b feat/<scope>-<slug>
# ... 编码 + 定向测试 + 前端构建验证 ...
git add -A; git commit -m "feat(<scope>): <简明描述>"
git push -u origin feat/<scope>-<slug>
gh pr create --base develop --title "feat(<scope>): <简明描述>" --body-file ...
# 等待 GitHub Actions CI 全绿 -> 维护者在 GitHub 亲自审阅并 Merge
```

### 4.2 正式发版（`develop` → `release/X.Y` → PR → `main` → Tag）
1. 从已全量测试通过的 `develop` 切出 `release/<major>.<minor>`（如 `release/1.1`），执行 `& ".\scripts\release.ps1"` 生成版本变更提交（不直接强推 `main`）；
2. 推送 `release/1.1` 并创建发布 PR（`release/1.1` → `main`），等待 CI 绿灯；
3. 维护者审阅并合并至 `main` 后，在 `main` 对应提交打正式 Tag `v1.1.0` 并推送，再提 PR 将版本元数据同步回 `develop`；
4. 在 GitHub Releases 基于 `v1.1.0` 发布正式版本与双端构建产物。

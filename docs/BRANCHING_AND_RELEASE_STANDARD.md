# Kyndryl Delivery Studio — 分支管理、PR 评审与 SemVer 发版规范

> **状态**：**正式生效（v1.x+ 团队研发与交付基线）**
> 本规范统一约定「**`develop` 日常直推 + `main` 强制 PR 门禁**」分支模型、CI 自动化检查、Conventional Commits、语义化版本号（SemVer 2.0）与发版流程，在保证日常研发高频顺畅迭代的同时，确保 `main` 始终对应严格验收通过的正式基线。

---

## 1. 分支模型（`develop` 直推 + `main` PR Gate）

采用轻量高效的「**开发主干（`develop` 直推）+ 正式发布主干（`main` 强制 PR & CI 门禁）+ 版本维护分支（`release/*`）**」模型：

| 分支类型 | 命名格式 | 生命周期 | 职责与合入规则 |
| :--- | :--- | :--- | :--- |
| **正式发布主干** | `main` | 永久保护（强制 PR + CI） | **只对应已通过完整验收的正式发布版本**（对应 `vX.Y.Z` Tag）。**严禁直接 push**，仅通过 `develop` → `main`、`release/*` → `main` 或 `hotfix/*` → `main` 的 PR，经 CI 全绿与审查通过后合入。 |
| **开发集成主干** | `develop` | 长期保留（防强推、防误删） | **日常研发、联调与增量迭代主线**。**允许直接 commit 并 `git push origin develop`**（不再强求切短期分支和提 PR），推送前在本地跑通受影响模块的定向测试与前端构建即可。 |
| **版本预备/维护分支** | `release/<major>.<minor>`<br>例：`release/1.0`、`release/1.1` | 长期维护（至该版本停止支持） | 某大/次版本的稳定基线分支。从 `develop` 切出准备发版；正式发布后**冻结新特性**，仅接收 `hotfix/*` 或 `cherry-pick` 的缺陷/安全修补。 |
| **可选短期/热修分支** | `feat/<scope>-<slug>`、`fix/<scope>-<slug>`<br>`hotfix/<ver>-<slug>` | 按需短期使用 | 仅在跨天大型实验性改动或基于 `release/*` 的紧急线上热修时按需使用；日常常规开发无需建短期分支。 |

### 分支与 PR 铁律（硬红线）
1. **仅 `main` 强制走 Pull Request**：严禁向 `main` 直接 `git push`；所有合入 `main` 的变更必须创建 PR 并通过 `.github/workflows/ci.yml` 全部检查项（`Backend CI`、`Frontend Build & Typecheck`、`Repo Standard & Contracts`）。
2. **`develop` 保持高速直推**：日常功能、修复、样式与文档改动直接在 `develop` 提交并推送，本地做好定向测试与 `npm run build` 验证即可，不再反复开 PR 空等 CI。
3. **防强推与防误删**：严禁对 `main`、`develop`、`release/*` 执行 `git push --force` 或删除分支（除非用户显式要求重置历史）。
4. **`main` PR 审查与自动合入**：指向 `main` 的 PR 由受控的 **`Delivery Studio PR Auto-Reviewer`** 自动化工作流（或仓库维护者）进行代码/安全/规范深度审查；通过且 CI 全绿后自动合并并写入中文分析 Commit；若存在阻断缺陷则打回并支持隔离 Worktree 自动修复重推复审。日常编码 AI 助手不得擅自合并 `main` PR。
5. **维护分支冻结新特性**：已发版的 `release/1.0` 绝不再合入新 `feat/*` 特性，新特性统一在 `develop` 演进，阶段稳定后通过 PR（`develop` → `main` 或 `release/1.x` → `main`）合入 `main`。

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

### 4.1 日常开发（直接在 `develop` 提交与推送）
```powershell
git checkout develop; git pull origin develop
# ... 编码 + 定向测试 + 前端构建验证 ...
git add -A; git commit -m "feat(<scope>): <简明描述>"
git push origin develop
```

### 4.2 合入 `main` 与正式发版（`develop` / `release/X.Y` → PR → `main` → Tag）
1. 当 `develop` 达到阶段验收基线时，直接提 PR（`develop` → `main`），或从 `develop` 切出 `release/<major>.<minor>` 执行 `& ".\scripts\release.ps1"` 生成版本提交后提 PR（`release/1.1` → `main`）；
2. PR 创建后自动触发 GitHub Actions CI（`Backend CI`、`Frontend Build & Typecheck`、`Repo Standard & Contracts`）及 **`Delivery Studio PR Auto-Reviewer`** 深度代码审查；
3. 审查通过且 CI 全绿后合入 `main`（并保留中文审查分析 Commit；若被拒将自动修复推送并触发复审）；
4. 正式发版时，在 `main` 对应提交打正式 Tag `v1.1.0` 并推送，并在 GitHub Releases 发布正式版本与双端构建产物。

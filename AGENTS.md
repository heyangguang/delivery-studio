# Kyndryl Delivery Studio (`delivery-studio`) — AI 开发与交付总规范

> 本文件是本仓库的常驻最高工程红线，所有 AI 助手与自动化工作流在修改代码、文档、脚本或执行发版前必须严格遵守。

---

## 1. 工程目录与架构铁律

完整规范见 [`docs/DIRECTORY_STANDARD.md`](./docs/DIRECTORY_STANDARD.md)。

- **前后端彻底分目录，仓库根目录永久锁定为 6 个标准目录 + 3 个顶层元文件**：
  - `backend/`：全部 Go 后端代码与静态嵌入（`module delivery-studio`，含 `go.mod`、`cmd/studio/`、`assets/`、`internal/`、`catalog/`、`mwpack/`、`pkglib/`）；
  - `frontend/`：全部 React + TypeScript + Vite 前端代码（`delivery-studio-ui`，构建产物输出至 `../backend/assets/store_assets/`）；
  - `deploy/`：Linux 生产部署模板（`deploy/linux/`）与线上热更新脚本（`deploy/ops/`）；
  - `scripts/`：开发热更、SemVer 发版、离线打包与工作区脚本；
  - `tests/`：Python 契约单测（`tests/python/`）与测试夹具（`tests/fixtures/`）；
  - `docs/`：工程与分支规范、运维手册（`docs/ops/`）、品牌素材（`docs/assets/`）及 1.0 历史归档（`docs/archive-1.0/`）；
  - 顶层元文件/隐藏目录仅允许：`README.md`、`LICENSE`、`AGENTS.md`、`.gitignore` 以及 `.github/`（CI 工作流与 PR 模板）。
- **严禁堆放散落文件**：禁止在仓库根目录、`backend/` 根目录或 `frontend/src/` 根目录新增散落源码/文档，禁止再创建 `ops/`、`packaging/`、`store_deploy/`、`testdata/` 等平行目录。
- **后端模块化与演进边界**：
  - 后续逐步演进的新独立领域包统一落在 `backend/internal/<domain>/`，领域包之间严禁互相 `import`，跨领域编排收敛于 `backend/internal/server/`；
  - 所有新增 HTTP API 必须同步在 `backend/internal/server/iam.go` 登记 RBAC 路由权限并补齐中英双语操作审计事件。
- **前端模块化边界**：
  - 顶层壳与路由放 `frontend/src/app/`，设计令牌与基础原语放 `frontend/src/design/`，跨模块共享放 `frontend/src/shared/`，业务页面按域归入 `frontend/src/modules/<domain>/`。
- **演进原则**：基于纯净稳定的 1.0 循序渐进地迭代，**严禁未经用户明确确认一次性堆砌大量演示假数据或塞满顶栏导航**。

---

## 2. 分支管理、Commit 与 SemVer 发版铁律

完整规范见 [`docs/BRANCHING_AND_RELEASE_STANDARD.md`](./docs/BRANCHING_AND_RELEASE_STANDARD.md)。

### 2.1 分支模型与 PR 强制门禁（GitFlow + Owner Merge）
- `main`：**正式发布主干**（永久保护，仅对应已验证正式版本与 `vX.Y.Z` Tag）；**严禁直接 push**，仅通过 `release/*` 或 `hotfix/*` 的 PR 合入。
- `develop`：**日常开发与集成测试主干**（永久保护）；**严禁直接 push**，所有新功能、修复与工程改动必须从 `develop` 切出短期分支并提 PR 合入。
- `release/<major>.<minor>`（如 `release/1.0`、`release/1.1`）：对应大/次版本的预备与长期维护分支；正式发版后**冻结新特性**，仅通过 PR 接收 Bugfix/安全补丁。
- 短期工作分支按类型命名（**严禁本地直接合入主干**）：
  - `feat/<scope>-<slug>`（新特性，基于 `develop`）
  - `fix/<scope>-<slug>`（普通缺陷修复，基于 `develop`）
  - `hotfix/<ver>-<slug>`（紧急热修，基于对应 `release/*`）
  - `refactor/<slug>`、`style/<slug>`、`docs/<slug>`、`chore/<slug>`（重构/样式/文档/工程，基于 `develop`）
- **PR 与合入红线（最高优先级）**：
  1. 任何代码或文档改动完成后，必须推送短期分支至 `origin` 并使用 `gh pr create --base develop`（发版/热修除外）创建结构化 Pull Request；
  2. **AI 严禁擅自 Merge PR 或直推 `main`/`develop`/`release/*`**，等待 GitHub Actions CI 全绿后，统一由用户亲自审阅并在 GitHub 点击 Merge（合并后远端分支自动清理）；
  3. **严禁对 `main`、`develop`、`release/*` 执行 `git push --force`**（除非用户显式要求重置历史）。

### 2.2 Commit 规范
- 统一采用 Conventional Commits：`<type>(<scope>): <简明描述>`（`feat`/`fix`/`refactor`/`perf`/`style`/`docs`/`test`/`chore`）。

### 2.3 版本号与 Git Tag 铁律（SemVer 2.0）
- **仅里程碑版本打 Tag**：
  - 正式版：`vMAJOR.MINOR.PATCH`（如 `v1.0.0`、`v1.0.1`、`v1.1.0`）
  - 预发布版：`vMAJOR.MINOR.PATCH-(alpha|beta|rc).N`（如 `v1.1.0-rc.1`）
- **严禁打 `vX.Y.Z-dev` 类开发标签**；日常开发与本地热更新统一执行 `.\scripts\dev-reload.ps1`（二进制自动注入 `buildID = <短SHA>-<时间戳>`），普通提交不打 Tag。
- **正式发版统一入口**：通过 `& ".\scripts\release.ps1"` 执行（PowerShell 带数组参数 `-Highlights @(...)` 时须用 `&` 直接调用），禁止手工散改版本号。

---

## 3. Apple 级前端 UI、表单控件与性能红线

- **统一标准表单控件**：避免裸写可见原生 `<input>` / `<select>` / `<textarea>`，优先使用 Arco Design 标准组件并保持合理尺寸（`default` / `small`）。
- **防布局崩塌与文字竖排折行**：短按钮、标签、徽章保持 `white-space: nowrap; flex-shrink: 0`；抽屉/弹窗复合表单行优先 `@container` 或 `auto-fit` 布局；Flex/Grid 子项补齐 `min-width: 0`。
- **主题与语义令牌**：样式复用 `frontend/src/design/theme.css` 语义 CSS 变量，禁止写死亮色十六进制色值破坏暗色主题。
- **交互与性能**：异步操作按钮具备 `loading` 与防重锁；`ResizeObserver` / `resize` / 拖拽监听使用 `requestAnimationFrame` 合帧并覆盖 `prefers-reduced-motion`；顶级页面在 `frontend/src/app/main.tsx` 走 `lazyPage(...)` 路由懒加载。

---

## 4. 本地环境、按需定向测试与热更新约定（Windows）

- **Shell 规范**：当前为 Windows PowerShell，命令链使用 `;`（禁止 `&&`）；代码检索使用 `git grep`（本机未安装 `rg`）。
- **工具链与网关**：
  - Go 路径：`D:\BMW\_go_runtime\go\bin\go.exe`（所有 Go 命令在 `backend/` 目录下执行）；
  - 本地零中断热更新网关端口 `8443` 支持 HTTP / HTTPS 双协议（`http://127.0.0.1:8443/`），**严禁随意杀死运行中的热更新网关进程**；热更新统一调用 `.\scripts\dev-reload.ps1`（自动识别 `delivery-studio-run` 或旧目录 `middleware-hub-run`；仅改后端时可加 `-SkipFrontend -SkipLinux` 提速）。
- **按需定向测试原则（杜绝每次全量慢跑）**：
  - **日常局部改动**：只运行**直接受影响包的定向单测**（如 `go test -count=1 ./mwpack/...` 或 `go test -count=1 ./internal/server -run "^(TestClusterImport|TestGateway)"`），确保秒级反馈；纯文档改动无需重跑测试。
  - **前端改动**：运行 `Push-Location frontend; npm run build; Pop-Location` 确保 `tsc --noEmit && vite build` 零报错。
  - **全量回归时机**：仅在跨模块重构、底层引擎大改或通过 `.\scripts\release.ps1` 正式发版前，执行全量核心回归测试。

---

## 5. 多智能体蜂巢（Swarm）规范

- 在 `/swarm` 模式下创建或调度任何成员（含常规 worker 与子助手）时，必须先通过 `swarm{action:"models", all:true}` 核验并显式指定 **`model: "gemini-4-neon-xhigh"`（Gemini 4 Neon XHigh）**，切分互不重叠的文件所有权，完成后及时回收 worker。

# Delivery Studio — 工程与交付上下文

> 详细目录与发版规范按需查阅 [`docs/DIRECTORY_STANDARD.md`](./docs/DIRECTORY_STANDARD.md) 与 [`docs/BRANCHING_AND_RELEASE_STANDARD.md`](./docs/BRANCHING_AND_RELEASE_STANDARD.md)。

## 1. 架构与目录边界
- **根目录锁定**：仅保留 `backend/`、`frontend/`、`deploy/`、`scripts/`、`tests/`、`docs/` 及顶层文件（`README.md`、`LICENSE`、`AGENTS.md`、`.gitignore`、`.github/`）；不要在根目录、`backend/` 或 `frontend/src/` 顶层散放源码/文档，也不要自造平行目录。
- **后端（Go，`backend/`）**：独立领域包放在 `backend/internal/<domain>/` 且互不 `import`，跨领域编排收敛到 `backend/internal/server/`；新增 HTTP API 需在 `backend/internal/server/iam.go` 补齐 RBAC 路由权限及中英双语审计事件。
- **前端（React + TS + Vite，`frontend/`，构建输出至 `../backend/assets/store_assets/`）**：分层为 `src/app/`、`src/design/`、`src/shared/`、`src/modules/<domain>/`；顶级页面在 `src/app/main.tsx` 走 `lazyPage(...)` 懒加载。

## 2. 质量与验收标准（以真实可用为准）
- **交互与状态闭环**：改前端或接口时，不要把“编译通过”当成完成——必须核对完整交互链路（按钮点击 → 接口请求 → 状态回写与禁用/加载态防重），避免重复控件、空洞排版、尺寸不统一或点击无响应；尽量使用 Arco Design 标准组件与 `frontend/src/design/theme.css` 语义变量（避免写死亮色十六进制色值破坏暗色主题），短按钮/徽章防止文字竖排折行。
- **循序演进**：不要未经确认一次性堆砌演示假数据或塞满顶栏导航。
- **真实测试验证**：
  - 后端改动在 `backend/` 跑受影响包的定向 `go test -count=1` 与 `go vet`；
  - 前端改动跑 `Push-Location frontend; npm run build; Pop-Location`，涉及复杂 UI/交互变更时应实际核查渲染与点击闭环；
  - 跨模块大改或正式发版前跑全量回归。

## 3. 本地环境约定（Windows）
- **Shell 与检索**：Windows PowerShell 用 `;` 连接命令（不用 `&&`）；代码搜索用 `git grep`（本机无 `rg`）。
- **Go 路径**：`D:\BMW\_go_runtime\go\bin\go.exe`。
- **本地热更新网关（端口 `8443`）**：不要随意杀掉运行中的网关进程；热更新统一用 `.\scripts\dev-reload.ps1`（仅改后端可加 `-SkipFrontend -SkipLinux`）。

## 4. 分支与发版
- **日常开发**：直接在 `develop` 提交（Conventional Commits：`<type>(<scope>): <desc>`）并 `git push origin develop`，无需强制建短期分支或提 PR。
- **合入 `main`**：必须通过 Pull Request（CI 全绿后由 PR 自动审查工作流或维护者合入；日常写码会话不要直接合并 `main` PR）。
- **版本与保护**：严禁对 `main` / `develop` / `release/*` 强推或删除；正式发版统一通过 `& ".\scripts\release.ps1"` 执行 SemVer 2.0 发版，不打 `-dev` 标签。

# Kyndryl Delivery Studio (`delivery-studio`) 工程目录锁定规范

> **状态**：**正式锁定（v1.x+ 永久基线）**
> 本文档是仓库目录结构的唯一权威约定。前后端彻底分目录，所有新功能、脚本、测试与文档必须按本规范落盘，**严禁在仓库根目录、`backend/` 根目录或 `frontend/src/` 根目录堆放散落文件**，亦不得另起 `ops/`、`packaging/`、`store_deploy/`、`testdata/` 等平行目录。

---

## 1. 仓库顶层目录锁定清单（6 个标准目录 + 3 个顶层元文件）

| 目录 / 文件 | 职责定位 | 允许存放的内容 | 严禁存放的内容 |
| :--- | :--- | :--- | :--- |
| `README.md` | 仓库中文总览入口 | 品牌头图、Badges、核心能力、快速开始、生产部署与协议 | 临时调试记录、冗长需求草稿 |
| `LICENSE` | 开源许可证 | Apache License 2.0 标准全文 | 非协议文件 |
| `AGENTS.md` | 仓库级 AI 开发与交付总规范 | 目录红线、分支与 SemVer 发版铁律、前端与性能约束、本地热更新约定 | 临时对话记录、个人密钥 |
| `backend/` | **【后端】全部 Go 代码与静态嵌入** | `go.mod`、`go.sum`、`cmd/studio/`、`assets/`、`internal/`、`catalog/`、`mwpack/`、`pkglib/` | 前端源码、临时构建二进制 |
| `frontend/` | **【前端】React + TS + Vite 工程** | `package.json`、`vite.config.ts`、`src/{app,design,shared,modules/*}` | 后端代码、服务端脚本 |
| `deploy/` | 生产部署与线上运维交付 | `deploy/linux/`（systemd、Nginx、`install.sh`、配置样例）、`deploy/ops/`（`update-hub.py`） | 历史验收 `.md` 文档 |
| `scripts/` | 本地开发、构建、打包、迁移与发版脚本 | `dev-reload.ps1`、`release.ps1`、`rename-local-workspace.ps1`、`build-store.py`、`build-sandbox-runtime.py` | 线上运行态数据或密钥 |
| `tests/` | 非 Go 回归测试与测试夹具 | `tests/python/`（Python 契约单测）、`tests/fixtures/`（测试样本文件） | `__pycache__`、临时输出日志 |
| `docs/` | 统一文档中心 | `DIRECTORY_STANDARD.md`、`BRANCHING_AND_RELEASE_STANDARD.md`、`assets/`（品牌 SVG）、`ops/`（现役运维手册）、`archive-1.0/`（1.0 历史设计/验收归档） | 可执行脚本、二进制 |
| `.github/` | GitHub 工程治理配置 | `workflows/ci.yml`（PR/主干自动化 CI 检查）、`PULL_REQUEST_TEMPLATE.md`（PR 规范模板） | 业务源码、构建产物 |

*(本地忽略目录：`dist/`、`frontend/node_modules/`、`__pycache__/` 均由 `.gitignore` 管控，不入库。)*

---

## 2. 后端 `backend/` 分层规范（`module delivery-studio`）

```text
backend/
├── go.mod / go.sum
├── cmd/studio/         # 唯一 Go 可执行入口（极薄 main.go，仅调用 server.Main()）
├── assets/             # 统一 //go:embed 资源包（store_assets/、ai_skills/、runtime_assets/ 等）
├── internal/
│   └── server/         # HTTP API、IAM RBAC、AI 底座、存量纳管、变更演练、安全体检、Word/Excel 报告
│   # 后续按需新增的独立领域引擎统一放入 internal/<domain>/，且领域包彼此禁止互相 import
├── catalog/            # 内置中间件组件目录（Go 公开内嵌包）
├── mwpack/             # Ansible 清单与 Playbook 渲染核心
└── pkglib/             # OS 离线软件包与依赖闭包解析核心
```

### 后端硬性约束
1. **领域解耦**：未来从 `server/` 拆出或新增的 `backend/internal/<domain>/` 领域包之间**严禁互相 `import`**，跨领域协作统一在 `backend/internal/server/` 层编排。
2. **统一资源嵌入**：所有静态资源与前端编译产物统一由 `backend/assets/assets.go` 嵌入，避免散落 `//go:embed`。
3. **按需定向测试**：日常改动在 `backend/` 内优先只跑直接受影响的包或 `-run TestXXX`；跨模块重构与正式发版前再运行完整回归。

---

## 3. 前端 `frontend/src/` 模块锁定结构（`delivery-studio-ui`）

```text
frontend/src/
├── app/            # 顶栏壳、路由表、双语国际化（main.tsx, router.ts, i18n.tsx）
├── design/         # 设计令牌、图标、图表、基础原语（theme.css, ui.tsx, glyphs.tsx, brandlogos.tsx, ...）
├── shared/         # API 客户端、登录、个人中心、命令面板、标准表单字段
└── modules/
    ├── projects/   # 集群列表、概览、配置、存量纳管、运行拓扑（clusters.tsx, clusterconfig.tsx, importcluster.tsx, topology.ts）
    ├── catalog/    # 应用目录、新建交付向导、组件工作台（catalog.tsx, workbench.tsx, components.tsx, ...）
    ├── rehearsal/  # 变更演练与跨集群推广（rehearsal.tsx, rehearsal_live.ts）
    ├── automation/ # 执行监控、执行手册、步骤热修（monitor.tsx, executions.tsx, runbook.tsx）
    ├── library/    # 离线软件包库、依赖闭包与运行时管理（library.tsx）
    ├── security/   # 供应链 CVE 扫描、VEX 研判与安全报告（security.tsx, clustersecurity.tsx, vextriage.tsx）
    ├── ai/         # AI 对话、技能库、知识库与设置（aichat.tsx, aipage.tsx, aisettings.tsx）
    ├── iam/        # 用户、角色、权限与审计日志（accounts.tsx）
    └── settings/   # 系统设置、通知与文档模板（settings.tsx, docs.tsx）
```

Vite 构建产物自动输出至 `../backend/assets/store_assets/`（由 `frontend/vite.config.ts` 控制）。

---

## 4. 新增文件归属速查表

| 你要新增的文件类型 | 唯一合法路径 |
| :--- | :--- |
| 新的 Go 独立领域引擎 | `backend/internal/<domain>/<file>.go` |
| 新的 HTTP API / 服务层逻辑 | `backend/internal/server/<file>.go` |
| 新的内置中间件组件 | `backend/catalog/<component>/` |
| 新的内置 AI 领域技能 | `backend/assets/ai_skills/<skill>.md` |
| 新的前端业务页面/组件 | `frontend/src/modules/<domain>/<Component>.tsx` |
| 新的前端通用设计原语 | `frontend/src/design/<Component>.tsx` |
| 新的运维手册 | `docs/ops/<主题>.md` |
| 新的本地开发/打包脚本 | `scripts/<name>.(ps1|py)` |
| 新的生产部署配置模板 | `deploy/linux/<file>` |
| 新的 Python 契约单测或夹具 | `tests/python/test_<name>.py` / `tests/fixtures/<file>` |

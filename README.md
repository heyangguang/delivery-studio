<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/logo-banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./docs/assets/logo-banner-light.svg">
  <img alt="Kyndryl Delivery Studio" src="./docs/assets/logo-banner-light.svg" width="440">
</picture>

# Kyndryl Delivery Studio — 企业级中间件自动化交付平台

**离线优先 · 授权直连 · 全生命周期可回溯的企业级中间件交付、纳管与变更演练工作台**

<p>
  <a href="https://github.com/heyangguang/delivery-studio/releases"><img src="https://img.shields.io/badge/release-v1.0.0-DC311B?style=flat-square&labelColor=1F242D" alt="Release v1.0.0"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-3E4652?style=flat-square&labelColor=1F242D" alt="License Apache-2.0"></a>
  <a href="https://go.dev/"><img src="https://img.shields.io/badge/Go-1.25+-3E4652?style=flat-square&labelColor=1F242D&logo=go&logoColor=white" alt="Go 1.25+"></a>
  <a href="https://www.ansible.com/"><img src="https://img.shields.io/badge/Ansible-2.14+-3E4652?style=flat-square&labelColor=1F242D&logo=ansible&logoColor=white" alt="Ansible 2.14+"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-18-3E4652?style=flat-square&labelColor=1F242D&logo=react&logoColor=white" alt="React 18"></a>
  <a href="#离线优先与授权直连双模交付"><img src="https://img.shields.io/badge/Air--Gap-Ready-2B6E4F?style=flat-square&labelColor=1F242D" alt="Air-Gap Ready"></a>
</p>

<p>
  <a href="#核心能力">核心能力</a> •
  <a href="#离线优先与授权直连双模交付">双模交付</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#生产部署与零中断升级">生产部署</a> •
  <a href="#工程目录与分支规范">工程规范</a> •
  <a href="#开源协议">开源协议</a>
</p>

</div>

---

## 核心能力

**Kyndryl Delivery Studio (`delivery-studio`)** 面向私有云、金融信创与物理隔离（Air-Gap）客户现场，以标准 **Ansible** 为底层执行语言、单一 Go 静态二进制 + React Web 工作台为控制平面，提供从 **首次离线/自动部署 → 存量纳管 → 变更演练 → 安全体检 → 验收交付文档** 的完整闭环：

| 能力域 | 核心特性 |
| :--- | :--- |
| **应用目录与标准组件交付** | 内置经实测验证的企业级高可用组件目录：**PostgreSQL（Patroni + etcd + pgBackRest + TDE/TLS）**、**Redis（主从 / Sentinel）**、**etcd**、**HAProxy**、**Keepalived**、**Nginx Stream**；支持按拓扑自动求解依赖、端口、数据流与证书校验，一键输出自包含离线包或自动执行方案。 |
| **存量集群零侵入纳管** | 支持对现场已有集群生成 100% 静态只读探针脚本（自动识别主中间件、Patroni/etcd/LB/备份伴生组件栈、OS 层 `node_exporter` 及各类监控 Exporter），建立完整数字基线档案并纳入统一变更与安全管理。 |
| **引导式变更演练与推广** | 严格遵循“零未留痕变更”：支持在测试/验证环境先行演练、自动采集只读证据、生成标准化《变更实施方案》与《变更报告》，验证通过后一键推广至生产集群。 |
| **供应链安全与 CVE/VEX 体检** | 基于 `deployment.lock.json` 与纳管软件包清单执行 100% 确定性离线 CVE 漏洞比对（区分中间件本体与 OS 底层包暴露面），支持 VEX 研判工作流、基线豁免与企业标准安全报告导出。 |
| **软件库与离线依赖闭包** | 统一托管 Ubuntu (DEB) / Rocky・RHEL (RPM) 离线软件包依赖闭包与离线 Ansible Python 运行时，所有产物携带 `SHA256SUMS` 与 `deployment.lock.json` 防篡改校验。 |
| **组件工作台与实测门禁** | 支持在 Web 工作台在线编辑多文件组件清单、模板、校验规则与验收步骤，跨组件联动预检，并通过实测验证凭证控制组件发布门禁。 |
| **内置 AI 交付助手与隔离沙箱** | 内置 21 项专业运维领域技能（PG/Patroni、Redis、etcd、HAProxy、Nginx、演练、安全审计、日志排障等）与跨平台隔离代码沙箱，支持智能填表、证书拆解、日志诊断与凭据全程脱敏。 |
| **企业级 Word（`.docx`）报告引擎** | 自动生成包含封面横幅、罗马页码前置目录、文档变更控制页、架构拓扑表、命令代码块与验收判据的正式 Word 交付/变更/安全手册，并支持自定义企业配色与模板。 |

---

## 离线优先与授权直连双模交付

| 交付阶段 | 物理隔离模式（Air-Gap / Offline） | 联网直连模式（Authorized Execution Node） |
| :--- | :--- | :--- |
| **集群部署与验收** | 每机生成自包含 `.tar.gz` 与 `SHA256SUMS`、离线软件源、离线 Ansible 运行时及分步 Markdown/Word 手册 | 通过已授权执行节点按固定快照分步自动执行，支持断线续传与实时日志回传 |
| **目标主机接入** | 零平台网络侵入，不碰客户堡垒机与防火墙策略 | 复用现场 root SSH 或通过堡垒机安装短期 Target Agent（私钥永不离执行机） |
| **存量纳管与巡检** | 导出 100% 只读探针脚本，现场执行回贴自动解析建档 | 结合演练与执行证据链形成持续可追溯档案 |

---

## 技术栈

- **后端控制平面**：Go `1.25+`、`net/http` 零框架轻量服务端、单一静态内嵌二进制（`//go:embed`）、HTTP/HTTPS 双协议零中断热更新网关
- **数据与模板引擎**：PostgreSQL `15+`（`pgx/v5`）、`expr-lang/expr`、`gonja/v2`、内置 `.docx`/`.xlsx` 排版与导出引擎
- **自动化底层**：Ansible `2.14+`（离线自包含 Python 运行时）、DEB/RPM 依赖闭包解析
- **前端工作台**：React `18`、TypeScript、Vite `8`、Arco Design、CodeMirror `6`、KaTeX、浅/深色语义令牌与全路由懒加载

---

## 快速开始

### 环境要求
- **Go** `1.22+`（推荐 `1.25+`）
- **Node.js** `20+` 与 `npm`
- **PostgreSQL** `15+`
- **Python** `3.10+`（可选，用于 `scripts/build-store.py` 与 `tests/python/` 契约单测）

### 1. 构建前端（产物自动嵌入 `backend/assets/store_assets/`）

```bash
cd frontend
npm ci
npm run build
```

### 2. 编译后端单一可执行文件

```bash
cd ../backend
go build -o ../dist/delivery-studio ./cmd/studio
```

### 3. 启动本地零中断热更新网关

```bash
export MW_DB="postgresql://user:pass@127.0.0.1:5432/middleware_hub?sslmode=disable"
../dist/delivery-studio store supervise --config /path/to/config.json
```

### 4. Windows 日常开发热更新与正式发版

```powershell
# 日常开发：增量编译并零中断热更新至本地网关（不打 Tag）
.\scripts\dev-reload.ps1
# 仅改后端快速热更新
.\scripts\dev-reload.ps1 -SkipFrontend -SkipLinux

# 正式发版（严格 SemVer 2.0）：跑发版回归测试 + 双端编译 + 写公告 + 打标推送 + 热更新
& ".\scripts\release.ps1" `
  -Version "1.0.1" `
  -Title "1.0.1 版本主题" `
  -Highlights @("核心改进 1", "核心改进 2") `
  -Commit -Push -Reload
```

---

## 生产部署与零中断升级

```bash
# 构建完整 Linux 离线安装包（含二进制、离线 Ansible 运行时与软件库）
python3 scripts/build-store.py --runtime /path/to/ansible-runtime.tar.gz --library /path/to/package-library

# 线上零中断热更新（不中断进行中的 AI 对话与执行任务）
python3 deploy/ops/update-hub.py --root /opt --binary ./delivery-studio
```

生产部署模板（`delivery-studio.service`、`nginx.example.conf`、`store-config.example.json`、`install.sh`）位于 [`deploy/linux/`](./deploy/linux/)，平滑更新手册见 [`docs/ops/平滑更新.md`](./docs/ops/%E5%B9%B3%E6%BB%91%E6%9B%B4%E6%96%B0.md)。

---

## 工程目录与分支规范

仓库根目录永久锁定为 **6 个标准目录 + 3 个顶层元文件**（详见 [`docs/DIRECTORY_STANDARD.md`](./docs/DIRECTORY_STANDARD.md) 与 [`docs/BRANCHING_AND_RELEASE_STANDARD.md`](./docs/BRANCHING_AND_RELEASE_STANDARD.md)）：

```text
delivery-studio/
├── README.md                      # 中文总览入口
├── LICENSE                        # Apache License 2.0 开源协议
├── AGENTS.md                      # 仓库级 AI 开发与交付总规范
├── backend/                       # 【后端】全部 Go 代码与 //go:embed 资源（module delivery-studio）
│   ├── go.mod / go.sum
│   ├── cmd/studio/                # 唯一 Go 启动入口
│   ├── assets/                    # //go:embed 资源（store_assets/、ai_skills/、runtime_assets/ 等）
│   ├── internal/server/           # HTTP API、IAM RBAC、AI 底座、演练、安全体检与报告引擎
│   ├── catalog/                   # 内置中间件组件目录（Go 公开内嵌包）
│   ├── mwpack/                    # Ansible 清单与 Playbook 渲染引擎
│   └── pkglib/                    # OS 离线软件包与依赖闭包解析核心
├── frontend/                      # 【前端】React 18 + TS + Vite 8（delivery-studio-ui）
│   └── src/
│       ├── app/                   # 顶栏壳、路由懒加载与双语国际化
│       ├── design/                # 设计令牌、图标、图表与基础原语
│       ├── shared/                # API 客户端、登录、命令面板与通用组件
│       └── modules/               # 业务模块（projects/catalog/rehearsal/automation/library/security/ai/iam/settings）
├── deploy/                        # Linux 生产部署模板与线上热更新脚本
├── scripts/                       # 开发热更、SemVer 发版、离线打包与工作区脚本
├── tests/                         # Python 契约单测与测试夹具
└── docs/                          # 目录规范、分支发版规范、品牌素材、运维手册与 1.0 历史归档
```

### 测试策略（按需定向 + 发版回归）

```bash
# 1. 日常局部改动：只跑受影响包或定向单测
cd backend
go test -count=1 ./mwpack/...
go test -count=1 ./internal/server -run "^(TestClusterImport|TestGateway)"

# 2. 前端类型检查与生产构建
cd frontend && npm run build

# 3. Python 契约单测
python3 -m unittest discover -s tests/python
```

---

## 开源协议

本项目基于 [**Apache License 2.0**](./LICENSE) 协议开源。

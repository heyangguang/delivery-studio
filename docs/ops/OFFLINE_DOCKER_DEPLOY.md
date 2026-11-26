# 离线 Docker 全量安装包构建与服务端一键部署指南

## 1. 在开发机一键生成全量离线包（含应用镜像 + PostgreSQL 16 镜像 + 数据库全量快照）

```powershell
python .\scripts\build-offline-docker.py
```

输出产物位于 `dist/` 目录（已被 `.gitignore` 忽略，不污染代码库）：
- `dist/delivery-studio-v1.0.0-offline-docker-amd64.tar.gz`
- `dist/delivery-studio-v1.0.0-offline-docker-amd64.tar.gz.sha256`

离线包内置内容：
- **Docker 镜像**：`postgres:16-alpine`（`linux/amd64`）与 `delivery-studio:1.0.0`（`linux/amd64`，含最新前端、Go 后端、Python 3.12 及 glibc 运行库）；
- **PostgreSQL 全量种子库**（`db/01-delivery-studio-seed.sql`）：账户密码、IAM 角色/团队/授权、集群实测状态与配置基线（`deployment.yml` / `plan.json`）、AI 供应商与加密主密钥、MCP 服务、技能库、沙箱配置、团队/个人知识库、安全漏洞库与扫描记录、审计及 AI 用量历史；
- **离线文件资源**（`data/`）：Ansible 离线运行环境、AI 代码沙箱运行环境、附件文件及离线 RPM/DEB 软件源池（如需不含系统包池的轻量包可加 `--skip-library`）；
- **一键部署脚本**（`install.sh`）与 `docker-compose.yml`。

---

## 2. 在离线 Linux 服务器一键部署（默认端口 `8080`）

将压缩包上传至离线服务器（例如 `/root/` 或 `/tmp/`），执行：

```bash
tar -xzf delivery-studio-v1.0.0-offline-docker-amd64.tar.gz
cd delivery-studio-v1.0.0-offline-docker-amd64
sudo bash install.sh
```

可选参数：
- `--port 8080`：指定宿主机监听端口（默认 `8080`）；
- `--dir /opt/delivery-studio-docker`：指定数据库与文件持久化目录（默认 `/opt/delivery-studio-docker`）；
- `--force-reseed`：在已有环境上强制覆盖重导离线包中的数据库快照。

---

## 3. 访问与日常运维命令

- **浏览器访问**：`http://<服务器IP>:8080` 或 `https://<服务器IP>:8080`（同一 `8080` 端口自动识别并兼容 HTTP 与 HTTPS）；
- **查看服务日志**：`docker logs -f delivery-studio-app`
- **查看数据库日志**：`docker logs -f delivery-studio-postgres`
- **重启服务**：`docker restart delivery-studio-app`

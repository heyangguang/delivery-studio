#!/usr/bin/env bash
# ==============================================================================
# Kyndryl Delivery Studio — 离线服务器一键部署脚本（含 PostgreSQL 数据库与全量数据）
# 默认启动端口：8080（支持 http://<服务器IP>:8080 与 https://<服务器IP>:8080 双协议直连）
# 用法：
#   bash install.sh
#   bash install.sh --port 8080 --dir /opt/delivery-studio-docker
#   bash install.sh --force-reseed   # 强制重新覆盖导入打包时的数据库快照
# ==============================================================================
set -Eeuo pipefail

PORT="8080"
INSTALL_DIR="/opt/delivery-studio-docker"
FORCE_RESEED="0"
NET_NAME="delivery-studio-net"
PG_CONTAINER="delivery-studio-postgres"
APP_CONTAINER="delivery-studio-app"
PG_IMAGE="postgres:16-alpine"
APP_VERSION="1.5.0"
APP_IMAGE="delivery-studio:${APP_VERSION}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p)
      PORT="$2"
      shift 2
      ;;
    --dir|-d)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --force-reseed)
      FORCE_RESEED="1"
      shift
      ;;
    --help|-h)
      echo "用法: bash install.sh [--port 8080] [--dir /opt/delivery-studio-docker] [--force-reseed]"
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 1
      ;;
  esac
done

BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${BUNDLE_DIR}"

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：当前服务器未安装 docker，请先安装 Docker Engine 后再执行。" >&2
  exit 1
fi

DOCKER_CMD="docker"
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER_CMD="sudo docker"
  else
    echo "错误：无法连接 Docker 守护进程，请使用 root 执行或确认 systemctl start docker 已启动。" >&2
    exit 1
  fi
fi

SUDO_PREFIX=""
if [[ $EUID -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
  SUDO_PREFIX="sudo"
fi

echo "================================================================"
echo "  Delivery Studio 离线全量部署（应用镜像 + PostgreSQL 数据库 + 数据）"
echo "  监听端口: ${PORT}    安装目录: ${INSTALL_DIR}"
echo "================================================================"

if [[ -f "${BUNDLE_DIR}/SHA256SUMS" ]] && command -v sha256sum >/dev/null 2>&1; then
  echo "==> [1/6] 校验离线安装包文件完整性..."
  sha256sum -c "${BUNDLE_DIR}/SHA256SUMS"
else
  echo "==> [1/6] 跳过 SHA256SUMS 校验..."
fi

echo "==> [2/6] 导入离线 Docker 镜像（PostgreSQL + Delivery Studio）..."
${DOCKER_CMD} load -i "${BUNDLE_DIR}/images/postgres-16-alpine-amd64.tar"
${DOCKER_CMD} load -i "${BUNDLE_DIR}/images/delivery-studio-${APP_VERSION}-amd64.tar"

echo "==> [3/6] 初始化持久化目录与离线文件资源 (${INSTALL_DIR})..."
${SUDO_PREFIX} mkdir -p "${INSTALL_DIR}/pgdata" "${INSTALL_DIR}/data/artifacts" "${INSTALL_DIR}/data/components" "${INSTALL_DIR}/data/library" "${INSTALL_DIR}/seed"

ENV_FILE="${INSTALL_DIR}/.env"
if [[ -f "${ENV_FILE}" ]]; then
  # 复用已有数据库密码，防止重复执行脚本时密码不一致
  PG_PASS="$(grep -E '^POSTGRES_PASSWORD=' "${ENV_FILE}" | head -n1 | cut -d= -f2- || true)"
fi
if [[ -z "${PG_PASS:-}" ]]; then
  if command -v tr >/dev/null 2>&1 && [[ -r /dev/urandom ]]; then
    PG_PASS="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24 || true)"
  fi
  PG_PASS="${PG_PASS:-ds_offline_pg_2026}"
fi

${SUDO_PREFIX} tee "${ENV_FILE}" >/dev/null <<EOF
PORT=${PORT}
POSTGRES_PASSWORD=${PG_PASS}
EOF
${SUDO_PREFIX} chmod 0600 "${ENV_FILE}"

if [[ -f "${BUNDLE_DIR}/db/01-delivery-studio-seed.sql" ]]; then
  ${SUDO_PREFIX} cp -f "${BUNDLE_DIR}/db/01-delivery-studio-seed.sql" "${INSTALL_DIR}/seed/01-delivery-studio-seed.sql"
  ${SUDO_PREFIX} chmod 0644 "${INSTALL_DIR}/seed/01-delivery-studio-seed.sql"
fi

if [[ -d "${BUNDLE_DIR}/data" ]]; then
  ${SUDO_PREFIX} cp -a "${BUNDLE_DIR}/data/." "${INSTALL_DIR}/data/"
fi

if [[ -f "${BUNDLE_DIR}/docker-compose.yml" ]]; then
  ${SUDO_PREFIX} cp -f "${BUNDLE_DIR}/docker-compose.yml" "${INSTALL_DIR}/docker-compose.yml"
fi

echo "==> [4/6] 创建容器网络并启动 PostgreSQL 16 数据库容器..."
if ! ${DOCKER_CMD} network inspect "${NET_NAME}" >/dev/null 2>&1; then
  ${DOCKER_CMD} network create "${NET_NAME}" >/dev/null
fi

if ${DOCKER_CMD} ps -a --format '{{.Names}}' | grep -Fxq "${PG_CONTAINER}"; then
  if ! ${DOCKER_CMD} ps --format '{{.Names}}' | grep -Fxq "${PG_CONTAINER}"; then
    ${DOCKER_CMD} start "${PG_CONTAINER}" >/dev/null
  fi
else
  ${DOCKER_CMD} run -d \
    --name "${PG_CONTAINER}" \
    --network "${NET_NAME}" \
    --network-alias postgres \
    --restart unless-stopped \
    -e POSTGRES_USER=postgres \
    -e "POSTGRES_PASSWORD=${PG_PASS}" \
    -e POSTGRES_DB=delivery_studio \
    -e TZ=Asia/Shanghai \
    -v "${INSTALL_DIR}/pgdata:/var/lib/postgresql/data" \
    "${PG_IMAGE}" >/dev/null
fi

echo "    等待 PostgreSQL 就绪..."
pg_ok=0
for i in $(seq 1 45); do
  if ${DOCKER_CMD} exec "${PG_CONTAINER}" pg_isready -U postgres -d delivery_studio >/dev/null 2>&1; then
    pg_ok=1
    break
  fi
  sleep 2
done
if [[ "${pg_ok}" -ne 1 ]]; then
  echo "错误：PostgreSQL 容器启动超时，请执行 '${DOCKER_CMD} logs ${PG_CONTAINER}' 查看原因。" >&2
  exit 1
fi

echo "==> [5/6] 启动 Delivery Studio 容器并同步全量数据库（端口 ${PORT}）..."
if ${DOCKER_CMD} ps -a --format '{{.Names}}' | grep -Fxq "${APP_CONTAINER}"; then
  ${DOCKER_CMD} rm -f "${APP_CONTAINER}" >/dev/null
fi

DB_URL="postgresql://postgres:${PG_PASS}@${PG_CONTAINER}:5432/delivery_studio?sslmode=disable"
ALLOWED_HOSTS="$(hostname 2>/dev/null || true),$(hostname -f 2>/dev/null || true)"

if ! ${DOCKER_CMD} run -d \
  --name "${APP_CONTAINER}" \
  --network "${NET_NAME}" \
  --restart unless-stopped \
  --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined \
  -p "${PORT}:8080" \
  -e PORT=8080 \
  -e TZ=Asia/Shanghai \
  -e "DELIVERY_STUDIO_ALLOWED_HOSTS=${ALLOWED_HOSTS}" \
  -e "FORCE_IMPORT_DB=${FORCE_RESEED}" \
  -e "DELIVERY_STUDIO_DATABASE_URL=${DB_URL}" \
  -v "${INSTALL_DIR}/data:/var/lib/delivery-studio" \
  -v "${INSTALL_DIR}/seed:/opt/delivery-studio/seed:ro" \
  "${APP_IMAGE}" >/dev/null 2>&1; then
  echo "    提示：宿主机安全策略限制 SYS_ADMIN，自动回退为标准非特权模式启动..."
  ${DOCKER_CMD} rm -f "${APP_CONTAINER}" >/dev/null 2>&1 || true
  ${DOCKER_CMD} run -d \
    --name "${APP_CONTAINER}" \
    --network "${NET_NAME}" \
    --restart unless-stopped \
    -p "${PORT}:8080" \
    -e PORT=8080 \
    -e TZ=Asia/Shanghai \
    -e "DELIVERY_STUDIO_ALLOWED_HOSTS=${ALLOWED_HOSTS}" \
    -e "FORCE_IMPORT_DB=${FORCE_RESEED}" \
    -e "DELIVERY_STUDIO_DATABASE_URL=${DB_URL}" \
    -v "${INSTALL_DIR}/data:/var/lib/delivery-studio" \
    -v "${INSTALL_DIR}/seed:/opt/delivery-studio/seed:ro" \
    "${APP_IMAGE}" >/dev/null
fi

echo "==> [6/6] 验证 127.0.0.1:${PORT} 服务健康状态..."
app_ok=0
for i in $(seq 1 45); do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "http://127.0.0.1:${PORT}/api/version" >/dev/null 2>&1; then
      app_ok=1
      break
    fi
  elif ${DOCKER_CMD} exec "${APP_CONTAINER}" python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/version', timeout=3)" >/dev/null 2>&1; then
    app_ok=1
    break
  fi
  sleep 2
done

if [[ "${app_ok}" -ne 1 ]]; then
  echo "错误：Delivery Studio 未在预期时间内就绪，最近日志如下：" >&2
  ${DOCKER_CMD} logs --tail 60 "${APP_CONTAINER}" >&2 || true
  exit 1
fi

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
HOST_IP="${HOST_IP:-<服务器IP>}"

echo ""
echo "================================================================"
echo "  部署成功！Delivery Studio 与 PostgreSQL 已启动并完成数据恢复"
echo "----------------------------------------------------------------"
echo "  浏览器访问地址 (HTTP) : http://${HOST_IP}:${PORT}"
echo "  浏览器访问地址 (HTTPS): https://${HOST_IP}:${PORT}"
echo "  持久化数据目录        : ${INSTALL_DIR}"
echo "  查看应用日志          : ${DOCKER_CMD} logs -f ${APP_CONTAINER}"
echo "  查看数据库日志        : ${DOCKER_CMD} logs -f ${PG_CONTAINER}"
echo "  登录账户              : 直接使用打包前已有的全部账户/密码及 AI 配置"
echo "================================================================"

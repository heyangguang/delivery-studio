#!/usr/bin/env bash
set -Eeuo pipefail

PORT="${PORT:-8080}"
DATA_DIR="${DELIVERY_STUDIO_DATA_DIR:-/var/lib/delivery-studio}"
CFG_FILE="${DELIVERY_STUDIO_CONFIG:-${DATA_DIR}/config.docker.json}"
SEED_SQL="${DELIVERY_STUDIO_SEED_SQL:-/opt/delivery-studio/seed/01-delivery-studio-seed.sql}"
PUBLIC_URL="${PUBLIC_URL:-https://0.0.0.0:${PORT}}"

mkdir -p "${DATA_DIR}" "${DATA_DIR}/components" "${DATA_DIR}/artifacts" "${DATA_DIR}/library" "${DATA_DIR}/jobs"

if [[ -z "${DELIVERY_STUDIO_DATABASE_URL:-}" ]]; then
  echo "错误：未设置环境变量 DELIVERY_STUDIO_DATABASE_URL" >&2
  exit 1
fi

if [[ ! -f "${CFG_FILE}" || "${REGENERATE_CONFIG:-1}" == "1" ]]; then
  cat > "${CFG_FILE}" <<EOF
{
  "listen": "0.0.0.0:${PORT}",
  "public_url": "${PUBLIC_URL}",
  "local_dev": true,
  "data_dir": "${DATA_DIR}",
  "components_dir": "${DATA_DIR}/components",
  "artifacts_dir": "${DATA_DIR}/artifacts",
  "runtime_archive": "${DATA_DIR}/artifacts/ansible-runtime.tar.gz",
  "library_dir": "${DATA_DIR}/library",
  "tls_cert": "${DATA_DIR}/dev-tls.crt",
  "tls_key": "${DATA_DIR}/dev-tls.key",
  "database_url_env": "DELIVERY_STUDIO_DATABASE_URL",
  "max_parallel": 2
}
EOF
  chmod 0600 "${CFG_FILE}"
fi

echo "==> 等待 PostgreSQL 数据库就绪..."
ready=0
for i in $(seq 1 60); do
  if [[ -f "${SEED_SQL}" ]]; then
    if [[ "${FORCE_IMPORT_DB:-0}" == "1" ]]; then
      if /usr/local/bin/delivery-studio store db-import --config "${CFG_FILE}" --input "${SEED_SQL}"; then
        ready=1
        break
      fi
    else
      if /usr/local/bin/delivery-studio store db-import --config "${CFG_FILE}" --input "${SEED_SQL}" --only-if-empty; then
        ready=1
        break
      fi
    fi
  else
    ready=1
    break
  fi
  sleep 2
done

if [[ "${ready}" -ne 1 ]]; then
  echo "错误：PostgreSQL 连接或初始数据导入超时，请检查数据库容器状态。" >&2
  exit 1
fi

echo "==> 启动 Delivery Studio 服务（监听端口 ${PORT}，同时兼容 HTTP 与 HTTPS 访问）..."
exec /usr/local/bin/delivery-studio store supervise --config "${CFG_FILE}"

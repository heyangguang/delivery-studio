#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo '请使用root安装。' >&2; exit 1; }
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT"
sha256sum -c SHA256SUMS
if [[ -e /opt/middleware-store || -e /etc/middleware-store/config.json ]]; then
  echo '已有平台目录或配置，停止以免覆盖。升级请先备份并按版本计划执行。' >&2
  exit 1
fi
if ! id middleware-store >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/middleware-store --shell /usr/sbin/nologin middleware-store
fi
[[ $(id -u middleware-store) != 0 ]] || { echo '服务账户不能是root。' >&2; exit 1; }
install -d -m 0755 /opt/middleware-store
cp -a bin /opt/middleware-store/
chmod 0755 /opt/middleware-store/bin/middleware-store
chown -R root:root /opt/middleware-store
install -d -m 0750 -o root -g middleware-store /etc/middleware-store
install -m 0640 -o root -g middleware-store config/store-config.example.json /etc/middleware-store/config.json
install -m 0640 -o root -g middleware-store config/service.env.example /etc/middleware-store/service.env
install -d -m 0700 -o middleware-store -g middleware-store /var/lib/middleware-store
# Offline materials live in the data directory, so they can be refreshed without touching the program.
install -d -m 0700 -o middleware-store -g middleware-store /var/lib/middleware-store/artifacts /var/lib/middleware-store/components
for f in assets/*; do
  install -m 0600 -o middleware-store -g middleware-store "$f" "/var/lib/middleware-store/artifacts/$(basename "$f")"
done
# The prepared package library (per operating system: pool, meta, closures).
if [[ -d library ]]; then
  cp -a library /var/lib/middleware-store/library
  chown -R middleware-store:middleware-store /var/lib/middleware-store/library
  find /var/lib/middleware-store/library -type d -exec chmod 0700 {} +
  find /var/lib/middleware-store/library -type f -exec chmod 0600 {} +
fi
install -m 0644 deploy/middleware-store.service /etc/systemd/system/middleware-store.service
systemctl daemon-reload
echo '安装完成，尚未启动。请按README配置平台数据库、访问地址和HTTPS，再创建首个管理员并启动。'

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo '请使用root安装。' >&2; exit 1; }
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT"
sha256sum -c SHA256SUMS
if [[ -e /opt/delivery-studio || -e /etc/delivery-studio/config.json ]]; then
  echo '已有平台目录或配置，停止以免覆盖。升级请先备份并按版本计划执行。' >&2
  exit 1
fi
if ! id delivery-studio >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/delivery-studio --shell /usr/sbin/nologin delivery-studio
fi
[[ $(id -u delivery-studio) != 0 ]] || { echo '服务账户不能是root。' >&2; exit 1; }
install -d -m 0755 /opt/delivery-studio
cp -a bin /opt/delivery-studio/
chmod 0755 /opt/delivery-studio/bin/delivery-studio
chown -R root:root /opt/delivery-studio
install -d -m 0750 -o root -g delivery-studio /etc/delivery-studio
install -m 0640 -o root -g delivery-studio config/store-config.example.json /etc/delivery-studio/config.json
install -m 0640 -o root -g delivery-studio config/service.env.example /etc/delivery-studio/service.env
install -d -m 0700 -o delivery-studio -g delivery-studio /var/lib/delivery-studio
# Offline materials live in the data directory, so they can be refreshed without touching the program.
install -d -m 0700 -o delivery-studio -g delivery-studio /var/lib/delivery-studio/artifacts /var/lib/delivery-studio/components
for f in assets/*; do
  install -m 0600 -o delivery-studio -g delivery-studio "$f" "/var/lib/delivery-studio/artifacts/$(basename "$f")"
done
# The prepared package library (per operating system: pool, meta, closures).
if [[ -d library ]]; then
  cp -a library /var/lib/delivery-studio/library
  chown -R delivery-studio:delivery-studio /var/lib/delivery-studio/library
  find /var/lib/delivery-studio/library -type d -exec chmod 0700 {} +
  find /var/lib/delivery-studio/library -type f -exec chmod 0600 {} +
fi
install -m 0644 deploy/delivery-studio.service /etc/systemd/system/delivery-studio.service
systemctl daemon-reload
echo '安装完成，尚未启动。请按README配置平台数据库、访问地址和HTTPS，再创建首个管理员并启动。'

#!/usr/bin/env bash
# mw-apt-setup.sh CLUSTER CONTROLLER_IP PORT...
# Points apt at the controller's offline repositories. Reachability is verified BEFORE any source is touched;
# existing sources are moved to a timestamped backup, never deleted. Installs nothing.
set -Eeuo pipefail
trap 'echo "ERROR at line $LINENO. Old sources, if moved, are in: ${APT_BACKUP:-not-created}" >&2' ERR
CLUSTER=${1:?cluster}; HOST=${2:?controller ip}; shift 2
[[ $# -ge 1 ]] || { echo 'No repository ports given.' >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
for cmd in python3 apt-get apt-cache dpkg; do command -v "$cmd" >/dev/null || { echo "Missing command: $cmd" >&2; exit 1; }; done
LIST=/etc/apt/sources.list.d/mw-$CLUSTER.list
WANT=$(for p in "$@"; do printf 'deb [trusted=yes] http://%s:%s/ ./\n' "$HOST" "$p"; done)
# Already pointing here (a later plan): the repository behind the address may have new packages, so refresh the lists.
if [[ -f "$LIST" && "$(cat "$LIST")" == "$WANT" ]]; then
  apt-get -o APT::Update::Error-Mode=any update
  echo 'Repository already in use; package lists refreshed.'; exit 0
fi

python3 - "$HOST" "$@" <<'PY'
import sys, urllib.request
host, ports = sys.argv[1], sys.argv[2:]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for port in ports:
    for name in ('Packages', 'Release'):
        url = 'http://%s:%s/%s' % (host, port, name)
        with opener.open(url, timeout=10) as response:
            if not response.read(1):
                raise SystemExit('Empty repository file: ' + url)
        print('OK:', url)
PY

APT_BACKUP="/etc/apt/backup-before-offline-$(date +%Y%m%d_%H%M%S)-$$"
mkdir -p "$APT_BACKUP/sources.list.d" /etc/apt/sources.list.d
cp -a /etc/apt/apt.conf.d "$APT_BACKUP/" 2>/dev/null || true
if [[ -e /etc/apt/sources.list || -L /etc/apt/sources.list ]]; then mv /etc/apt/sources.list "$APT_BACKUP/"; fi
shopt -s nullglob
for f in /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [[ "$f" == "$LIST" ]] && continue
    mv -- "$f" "$APT_BACKUP/sources.list.d/"
done
printf '%s\n' "$WANT" > "$LIST"; chmod 644 "$LIST"
printf 'Acquire::http::Proxy::%s "DIRECT";\n' "$HOST" > /etc/apt/apt.conf.d/99-mw-offline-direct
chmod 644 /etc/apt/apt.conf.d/99-mw-offline-direct
apt-get -o APT::Update::Error-Mode=any update
echo "Old sources saved to: $APT_BACKUP"
echo 'Repository configured; no packages installed.'

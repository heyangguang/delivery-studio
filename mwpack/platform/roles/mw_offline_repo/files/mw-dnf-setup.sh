#!/usr/bin/env bash
# mw-dnf-setup.sh CLUSTER CONTROLLER_IP PORT...
# Points dnf at the controller's offline repositories. Reachability is verified BEFORE any repo file is touched;
# existing repo files are moved to a timestamped backup, never deleted. Installs nothing.
set -Eeuo pipefail
trap 'echo "ERROR at line $LINENO. Old repo files, if moved, are in: ${REPO_BACKUP:-not-created}" >&2' ERR
CLUSTER=${1:?cluster}; HOST=${2:?controller ip}; shift 2
[[ $# -ge 1 ]] || { echo 'No repository ports given.' >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
command -v dnf >/dev/null || { echo 'Missing command: dnf' >&2; exit 1; }
FILE=/etc/yum.repos.d/mw-$CLUSTER.repo
WANT=$(i=0; for p in "$@"; do i=$((i+1)); printf '[mw-%s-%s]\nname=Middleware Hub offline repository %s\nbaseurl=http://%s:%s/\nenabled=1\ngpgcheck=0\nmodule_hotfixes=1\nproxy=_none_\n\n' "$CLUSTER" "$i" "$i" "$HOST" "$p"; done)
# Already pointing here (a later plan): the repository behind the address may have new packages, so refresh metadata.
if [[ -f "$FILE" && "$(cat "$FILE")" == "$WANT" ]]; then
  dnf -y -q clean metadata
  dnf -y -q makecache
  echo 'Repository already in use; package lists refreshed.'; exit 0
fi

python3 - "$HOST" "$@" <<'PY'
import sys, urllib.request
host, ports = sys.argv[1], sys.argv[2:]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for port in ports:
    url = 'http://%s:%s/repodata/repomd.xml' % (host, port)
    with opener.open(url, timeout=10) as response:
        if not response.read(1):
            raise SystemExit('Empty repository file: ' + url)
    print('OK:', url)
PY

REPO_BACKUP="/etc/yum.repos.d.backup-before-offline-$(date +%Y%m%d_%H%M%S)-$$"
mkdir -p "$REPO_BACKUP"
shopt -s nullglob
for f in /etc/yum.repos.d/*.repo; do
    [[ "$f" == "$FILE" ]] && continue
    mv -- "$f" "$REPO_BACKUP/"
done
printf '%s' "$WANT" > "$FILE"; chmod 644 "$FILE"
dnf -y -q clean all
dnf -y -q makecache
echo "Old repo files saved to: $REPO_BACKUP"
echo 'Repository configured; no packages installed.'

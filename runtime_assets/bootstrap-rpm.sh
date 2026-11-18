#!/usr/bin/env bash
# Offline Ansible for a RedHat family 9 controller (RHEL / Rocky / Alma). Unlike Ubuntu 24.04 the system Python here is
# 3.9, and Ansible 2.20 needs 3.12 on the controller, so python3.12 is installed first from the delivery's own offline
# package repository (no network, no other repository is used or changed), then the private Ansible runtime is built.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $EUID -eq 0 ]] || { echo '请在控制节点以root执行'; exit 1; }
source /etc/os-release
[[ $ID =~ ^(rhel|rocky|almalinux|centos)$ && ${VERSION_ID%%.*} == 9 && $(uname -m) == x86_64 ]] || { echo '仅支持 RedHat 系 9（RHEL / Rocky / Alma）amd64 控制节点'; exit 1; }
cd "$ROOT"
sha256sum --check --strict SHA256SUMS
[[ ! -L runtime ]] || { echo '拒绝runtime链接'; exit 1; }
PY=/usr/bin/python3.12
if [[ ! -x $PY ]]; then
  UPLOAD=${MW_UPLOAD_DIR:-/tmp/mw-upload}
  ARCHIVE=$(find "$UPLOAD" -maxdepth 1 -name 'packages-el9-amd64.tar.gz' -print -quit 2>/dev/null || true)
  [[ -n $ARCHIVE && -f $ARCHIVE ]] || { echo "没有 python3.12，也找不到离线软件包 $UPLOAD/packages-el9-amd64.tar.gz。请先把交付里的这个文件上传到 $UPLOAD（或用 MW_UPLOAD_DIR 指定目录）。"; exit 1; }
  REPO=$(mktemp -d /var/tmp/mw-bootstrap-repo-XXXXXXXX)
  trap 'rm -rf -- "$REPO"' EXIT
  tar -xzf "$ARCHIVE" -C "$REPO" --no-same-owner
  DIR=$(dirname "$(find "$REPO" -maxdepth 3 -name repomd.xml -print -quit)")/..
  [[ -f $DIR/repodata/repomd.xml ]] || { echo '离线软件包里没有 repodata'; exit 1; }
  # only this repository is enabled, so nothing outside the delivery can be reached or installed
  dnf -y -q --disablerepo='*' --repofrompath=mwboot,"$DIR" --setopt=mwboot.gpgcheck=0 --setopt=mwboot.module_hotfixes=1 \
    --setopt=install_weak_deps=False install python3.12
fi
"$PY" -c 'import sys; assert sys.version_info[:2] == (3,12), "需要Python3.12"'
LOCK=$(sha256sum bootstrap/requirements.lock | cut -d' ' -f1)
if [[ -d runtime ]]; then
  if [[ -f runtime/.mw-lock && $(cat runtime/.mw-lock) == "$LOCK" ]]; then
    PYTHONPATH="$ROOT/runtime" "$PY" -c 'import ansible,yaml,cryptography; assert ansible.__version__ == "__ANSIBLE__"'
    "$ROOT/bin/ansible-playbook" --version
    echo '复用已有Ansible运行环境；未覆盖或修改系统Python。'
    exit 0
  fi
  # the package list changed (a newer runtime or fixed packages): build the new one beside it, then swap
  echo '运行环境的软件包清单已变化，将重新安装；旧的保留为 runtime.prev。'
fi
[[ ! -e runtime || -d runtime ]] || { echo 'runtime不是普通目录'; exit 1; }
TMP=$(mktemp -d "$ROOT/.runtime-XXXXXXXX")
trap 'rm -rf -- "$TMP" "${REPO:-}"' EXIT
PIP_WHEEL=$(find "$ROOT/bootstrap/wheels" -maxdepth 1 -name 'pip-*.whl' -print -quit)
[[ -f $PIP_WHEEL ]]
PYTHONPATH="$PIP_WHEEL" "$PY" -m pip install --no-index --disable-pip-version-check \
  --find-links "$ROOT/bootstrap/wheels" --require-hashes --only-binary=:all: \
  --target "$TMP" -r "$ROOT/bootstrap/requirements.lock"
PYTHONPATH="$TMP" "$PY" -c 'import ansible,yaml,cryptography; assert ansible.__version__ == "__ANSIBLE__"'
echo "$LOCK" > "$TMP/.mw-lock"
if [[ -d "$ROOT/runtime" ]]; then rm -rf -- "$ROOT/runtime.prev"; mv -- "$ROOT/runtime" "$ROOT/runtime.prev"; fi
mv -- "$TMP" "$ROOT/runtime"
"$ROOT/bin/ansible-playbook" --version
echo '离线Ansible已就绪。免密配置未改变；没有执行部署、测试或备份。'

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $EUID -eq 0 ]] || { echo '请在控制节点以root执行'; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(uname -m) == x86_64 ]] || { echo '仅支持Ubuntu 24.04 amd64控制节点'; exit 1; }
python3 -c 'import sys; assert sys.version_info[:2] == (3,12), "需要系统Python3.12"'
cd "$ROOT"
sha256sum --check --strict SHA256SUMS
[[ ! -L runtime ]] || { echo '拒绝runtime链接'; exit 1; }
LOCK=$(sha256sum bootstrap/requirements.lock | cut -d' ' -f1)
if [[ -d runtime ]]; then
  if [[ -f runtime/.mw-lock && $(cat runtime/.mw-lock) == "$LOCK" ]]; then
    PYTHONPATH="$ROOT/runtime" python3 -c 'import ansible,yaml,cryptography; assert ansible.__version__ == "__ANSIBLE__"'
    "$ROOT/bin/ansible-playbook" --version
    echo '复用已有Ansible运行环境；未覆盖或修改系统Python。'
    exit 0
  fi
  # the package list changed (a newer runtime or fixed packages): build the new one beside it, then swap
  echo '运行环境的软件包清单已变化，将重新安装；旧的保留为 runtime.prev。'
fi
[[ ! -e runtime || -d runtime ]] || { echo 'runtime不是普通目录'; exit 1; }
TMP=$(mktemp -d "$ROOT/.runtime-XXXXXXXX")
trap 'rm -rf -- "$TMP"' EXIT
PIP_WHEEL=$(find "$ROOT/bootstrap/wheels" -maxdepth 1 -name 'pip-*.whl' -print -quit)
[[ -f $PIP_WHEEL ]]
PYTHONPATH="$PIP_WHEEL" python3 -m pip install --no-index --disable-pip-version-check \
  --find-links "$ROOT/bootstrap/wheels" --require-hashes --only-binary=:all: \
  --target "$TMP" -r "$ROOT/bootstrap/requirements.lock"
PYTHONPATH="$TMP" python3 -c 'import ansible,yaml,cryptography; assert ansible.__version__ == "__ANSIBLE__"'
echo "$LOCK" > "$TMP/.mw-lock"
if [[ -d "$ROOT/runtime" ]]; then rm -rf -- "$ROOT/runtime.prev"; mv -- "$ROOT/runtime" "$ROOT/runtime.prev"; fi
mv -- "$TMP" "$ROOT/runtime"
"$ROOT/bin/ansible-playbook" --version
echo '离线Ansible已就绪。免密配置未改变；没有执行部署、测试或备份。'

#!/usr/bin/env bash
# mw-data-disk.sh init|check DISK PARTITION TARGET
# init   : partition, format ext4 and mount a NEW EMPTY disk on TARGET; stops on any sign the disk is in use.
# check  : only verify TARGET is mounted (from PARTITION when given) on ext4/xfs.
set -Eeuo pipefail
trap 'echo "ERROR: stopped at line $LINENO. Inspect the current disk state before retrying." >&2' ERR
MODE=${1:?mode}; DISK=${2:-}; PART=${3:-}; TARGET=${4:-/data}
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }

# Validate before inspecting or formatting any block device.
[[ "$TARGET" =~ ^/[A-Za-z0-9_/-]+$ && "$TARGET" != / && "$TARGET" != */ && "$TARGET" != *//* ]] || { echo 'Invalid data directory.' >&2; exit 1; }
case "$TARGET" in /etc|/etc/*|/usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/boot|/boot/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/run|/run/*|/root|/root/*|/tmp|/tmp/*|/var|/home) echo 'Reserved system directory.' >&2; exit 1;; esac
ancestor="$TARGET"
while [[ "$ancestor" != / ]]; do
    [[ ! -L "$ancestor" ]] || { echo "Symlink in data path: $ancestor" >&2; exit 1; }
    ancestor=$(dirname "$ancestor")
done

if mountpoint -q "$TARGET"; then
    src=$(findmnt -nro SOURCE --mountpoint "$TARGET"); fs=$(findmnt -nro FSTYPE --mountpoint "$TARGET")
    [[ -z "$PART" || "$src" == "$PART" ]] || { echo "$TARGET is mounted from $src, expected $PART; stopping." >&2; exit 1; }
    [[ "$fs" == ext4 || "$fs" == xfs ]] || { echo "$TARGET has filesystem $fs; stopping." >&2; exit 1; }
    echo "$TARGET already mounted from $src ($fs)."
    exit 0
fi
[[ "$MODE" == init ]] || { echo "$TARGET is not mounted. Prepare the disk manually or choose initialize for this machine." >&2; exit 1; }

for cmd in lsblk wipefs parted partprobe udevadm mkfs.ext4 blkid findmnt mountpoint mount awk cp; do
    command -v "$cmd" >/dev/null || { echo "Missing command: $cmd" >&2; exit 1; }
done
[[ -b "$DISK" ]] || { echo "Missing block device: $DISK" >&2; exit 1; }
echo "Host: $(hostname)"; lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS "$DISK"
[[ "$(lsblk -dnro TYPE "$DISK")" == disk ]] || { echo 'Target is not a whole disk.' >&2; exit 1; }
[[ "$(lsblk -nrpo NAME "$DISK" | wc -l)" -eq 1 ]] || { echo 'Disk has partitions or dependent devices; stopping.' >&2; exit 1; }
[[ -z "$(lsblk -dnro MOUNTPOINTS "$DISK")" ]] || { echo 'Disk is in use; stopping.' >&2; exit 1; }
[[ -z "$(wipefs --no-act --noheadings --output TYPE "$DISK")" ]] || { echo 'Disk has existing signatures; stopping.' >&2; exit 1; }
if awk -v t="$TARGET" '$1 !~ /^#/ && $2 == t {found=1} END {exit !found}' /etc/fstab; then
    echo "/etc/fstab already contains $TARGET; stopping." >&2; exit 1
fi
if [[ -e "$TARGET" ]]; then
    [[ -d "$TARGET" && ! -L "$TARGET" ]] || { echo "$TARGET is not a regular directory; stopping." >&2; exit 1; }
    [[ -z "$(find "$TARGET" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo "$TARGET contains files; stopping." >&2; exit 1; }
fi

echo "Initializing $DISK: new GPT partition table and ext4 filesystem."
parted -s "$DISK" mklabel gpt
parted -s -a optimal "$DISK" mkpart primary ext4 1MiB 100%
partprobe "$DISK"; udevadm settle
[[ -b "$PART" ]] || { echo "$PART did not appear; stopping." >&2; exit 1; }
mkfs.ext4 -L mwdata "$PART"
UUID=$(blkid -s UUID -o value "$PART"); [[ -n "$UUID" ]]
mkdir -p "$TARGET"
cp -a /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d_%H%M%S).$$"
printf 'UUID=%s %s ext4 defaults,noatime,nodev,nosuid 0 2\n' "$UUID" "$TARGET" >> /etc/fstab
systemctl daemon-reload
mount "$TARGET"
mountpoint -q "$TARGET"
[[ "$(findmnt -nro UUID --mountpoint "$TARGET")" == "$UUID" ]]
df -hT "$TARGET"
echo "initialized $DISK -> $TARGET"

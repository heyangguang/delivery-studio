#!/usr/bin/env bash
# Root SSH trust via manually copied PUBLIC keys. Run after sudo -i.
# No passwords are changed. Private keys are never copied or printed.
set -Eeuo pipefail
umask 077
export SYSTEMD_PAGER=cat PAGER=cat

fail() { echo "停止：$*" >&2; exit 1; }
[[ $EUID -eq 0 && ${HOME:-} == /root ]] || fail '先执行 sudo -i，进入 root 登录环境。'
for tool in ssh ssh-keygen awk grep stat mktemp; do command -v "$tool" >/dev/null || fail "缺少基础工具：$tool"; done
[[ -d /root && ! -L /root/.ssh ]] || fail '/root/.ssh 不能是符号链接。'
[[ $(stat -c %u /root) == 0 ]] || fail '/root 属主不是 root。'
root_mode=$(stat -c %a /root)
(( (8#$root_mode & 0022) == 0 )) || fail '/root 不能对组或其他用户开放写权限。'
mkdir -p /root/.ssh
chown root:root /root/.ssh
chmod 700 /root/.ssh

load_nodes() {
 local file=${MWCTL_NODES_FILE:-$(dirname -- "${BASH_SOURCE[0]}")/nodes.conf} row ip name extra part
 [[ -f $file ]] || fail "找不到节点关系文件：$file。请将同一份 nodes.conf 放在脚本旁边。"
 NODE_IPS=(); NODE_NAMES=()
 while IFS= read -r row || [[ -n $row ]]; do
  row=${row%$'\r'}; row=${row%%#*}
  read -r ip name extra <<< "$row"
  [[ -n ${ip:-} ]] || continue
  [[ -n ${name:-} && -z ${extra:-} && $name =~ ^[a-z][a-z0-9-]{0,40}$ && $name != localhost ]] || fail 'nodes.conf 每行须为 IPv4 节点名；名称须为小写字母、数字、短横线。'
  [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail "IPv4 无效：$ip"
  local -a octets
  IFS=. read -r -a octets <<< "$ip"
  for part in "${octets[@]}"; do
   [[ $part == 0 || $part != 0* ]] && ((10#$part <= 255)) || fail "IPv4 无效：$ip"
  done
  ((10#${octets[0]} > 0 && 10#${octets[0]} < 224 && 10#${octets[0]} != 127)) || fail "不支持此节点地址：$ip"
  local i
  for i in "${!NODE_IPS[@]}"; do
   [[ ${NODE_IPS[i]} != "$ip" && ${NODE_NAMES[i]} != "$name" ]] || fail 'nodes.conf 中 IP 或名称重复。'
  done
  NODE_IPS+=("$ip"); NODE_NAMES+=("$name")
 done < "$file"
 (( ${#NODE_IPS[@]} >= 1 && ${#NODE_IPS[@]} <= 50 )) || fail 'nodes.conf 须包含 1 到 50 个节点，首行为控制节点。'
 NODE_MAP=$(for i in "${!NODE_IPS[@]}"; do printf '%s %s\n' "${NODE_IPS[i]}" "${NODE_NAMES[i]}"; done)
 printf '本次节点关系（第一个是控制节点）：\n%s\n' "$NODE_MAP"
}

select_node() {
 local name=${1:-} i
 SELECTED_IP=''
 for i in "${!NODE_NAMES[@]}"; do
  if [[ ${NODE_NAMES[i]} == "$name" ]]; then SELECTED_IP=${NODE_IPS[i]}; return; fi
 done
 fail "节点名不在 nodes.conf：$name"
}

prepare_node() {
 local name=${1:-} hosts=/etc/hosts record=/root/.ssh/mwctl-nodes.conf tmp backup i
 load_nodes; select_node "$name"
 for tool in ip hostnamectl getent cmp cp sha256sum; do command -v "$tool" >/dev/null || fail "缺少工具：$tool"; done
 ip -o -4 addr show | awk '{split($4,a,"/"); print a[1]}' | grep -Fxq "$SELECTED_IP" || fail "本机没有 $SELECTED_IP，节点选择错误；未修改 hosts 或主机名。"
 safe_file "$hosts"; safe_file "$record"
 if [[ -f $record ]]; then
  [[ $(cat "$record") == "$NODE_MAP" ]] || fail '本机已有不同的免密节点关系记录，先核对旧集群；未修改。'
 fi
 tmp=$(mktemp /root/.ssh/.hosts-plan.XXXXXX)
 # Remove only these three names from old aliases, preserving unrelated aliases/comments.
 awk -v names="${NODE_NAMES[*]}" '
 BEGIN {split(names,a," "); for(i in a) managed[a[i]]=1}
 { original=$0; body=$0; comment=""; p=index(body,"#"); if(p){comment=substr(body,p);body=substr(body,1,p-1)}
   n=split(body,f); changed=0; aliases=""
   for(i=2;i<=n;i++) {if(f[i] in managed) changed=1; else aliases=aliases " " f[i]}
   if(!changed) print original; else if(aliases!="") print f[1] aliases (comment!="" ? " " comment : ""); else if(comment!="") print comment
 }' "$hosts" > "$tmp"
 if ! awk '{sub(/#.*/, ""); for(i=2;i<=NF;i++) if($i=="localhost") found=1} END{exit !found}' "$tmp"; then
  printf '127.0.0.1 localhost\n' >> "$tmp"
 fi
 printf '%s\n' "$NODE_MAP" >> "$tmp"
 if ! cmp -s "$hosts" "$tmp"; then
  backup=/root/hosts-before-ssh-trust-$(date +%s%N)
  cp -a -- "$hosts" "$backup"
  cat "$tmp" > "$hosts"
  echo "hosts 已更新，备份：$backup"
 fi
 rm -f -- "$tmp"
 hostnamectl set-hostname "$name"
 for i in "${!NODE_NAMES[@]}"; do
  [[ $(getent ahostsv4 "${NODE_NAMES[i]}" | awk '{print $1}' | sort -u) == "${NODE_IPS[i]}" ]] || fail "名称解析与计划不一致：${NODE_NAMES[i]}；请检查 NSS/DNS。"
 done
 printf '%s\n' "$NODE_MAP" > "$record"
 chmod 600 "$record"
 echo "主机名及 hosts 已核对：$name ($SELECTED_IP)。节点关系记录：$record"
 sha256sum "$record"
}

mapped_operation() {
 local operation=$1 name=${2:-}
 load_nodes; select_node "$name"
 [[ $name != "${NODE_NAMES[0]}" ]] || fail '请选择控制节点以外的机器。'
 [[ -f /root/.ssh/mwctl-nodes.conf && $(cat /root/.ssh/mwctl-nodes.conf) == "$NODE_MAP" ]] || fail '先用同一份 nodes.conf 执行 prepare。'
 ip -o -4 addr show | awk '{split($4,a,"/"); print a[1]}' | grep -Fxq "${NODE_IPS[0]}" || fail 'trust-node/check-node 必须在控制节点（nodes.conf 首行）执行。'
 "$operation" "$SELECTED_IP" "$name"
}

read_public_key() {
 local kind=$1
 echo "粘贴${kind}的完整一行 ssh-ed25519 公钥，然后回车：" >&2
 IFS= read -r PUBLIC_KEY || fail '没有读到公钥。'
 PUBLIC_KEY=${PUBLIC_KEY%$'\r'}
 [[ $PUBLIC_KEY == ssh-ed25519\ * && $PUBLIC_KEY != *$'\n'* ]] || fail '只接受 ssh-ed25519 公钥整行，不能粘贴私钥或其他文本。'
 local tmp
 tmp=$(mktemp /root/.ssh/.check-public.XXXXXX)
 printf '%s\n' "$PUBLIC_KEY" > "$tmp"
 if ! ssh-keygen -lf "$tmp"; then rm -f -- "$tmp"; fail '公钥无法解析，请重新复制。'; fi
 rm -f -- "$tmp"
}

safe_file() {
 [[ ! -L $1 ]] || fail "$1 不能是符号链接。"
 [[ ! -e $1 || -f $1 ]] || fail "$1 不是普通文件。"
 if [[ -e $1 ]]; then [[ $(stat -c %h "$1") == 1 ]] || fail "$1 不能是硬链接。"; fi
}

source_key() {
 local private=/root/.ssh/id_ed25519 public=/root/.ssh/id_ed25519.pub derived
 safe_file "$private"; safe_file "$public"
 if [[ ! -e $private ]]; then
  [[ ! -e $public ]] || fail '只有公钥、没有私钥。请检查现有文件，脚本不覆盖。'
  ssh-keygen -q -t ed25519 -f "$private" -N '' -C "root@$(hostname)"
 fi
 [[ -s $private ]] || fail '现有私钥为空，脚本不覆盖。'
 chown root:root "$private"; chmod 600 "$private"
 derived=$(ssh-keygen -y -P '' -f "$private") || fail '现有私钥无法无交互使用；可能已加密。脚本不会替换它。'
 derived=$(awk '{print $1" "$2}' <<< "$derived")
 if [[ ! -e $public ]]; then printf '%s root@%s\n' "$derived" "$(hostname)" > "$public"; fi
 [[ $(awk '{print $1" "$2}' "$public") == "$derived" ]] || fail '已有公钥与私钥不匹配，停止且不覆盖。'
 chown root:root "$public"; chmod 644 "$public"
 echo '===== 控制节点的 root 用户公钥指纹 ====='
 ssh-keygen -lf "$public"
 echo '===== 只复制下面这一行，分别粘贴到其他每台机器 ====='
 cat "$public"
}

target_key() {
 local file=/root/.ssh/authorized_keys alg blob comment tmp
 safe_file "$file"
 read_public_key '控制节点的 root 用户'
 read -r alg blob comment <<< "$PUBLIC_KEY"
 touch "$file"; chown root:root "$file"; chmod 600 "$file"
 if awk -v a="$alg" -v b="$blob" '$1==a && $2==b {found=1} END {exit !found}' "$file"; then
  echo '公钥已存在，不重复追加。'
 else
  cp -a -- "$file" "$file.before-mwctl-$(date +%s%N)"
  # A separating newline prevents corrupting a pre-existing final line.
  printf '\n%s\n' "$PUBLIC_KEY" >> "$file"
  echo '已追加公钥，原有 authorized_keys 内容保留。'
 fi
 echo '请核对刚显示的指纹与控制节点 source 输出一致。'
 echo '接着执行 host-key，复制本机主机公钥到控制节点。'
 echo '若后续登录被 sshd 策略拒绝，先执行 inspect；需要时再执行 enable-root-key。'
}

host_key() {
 local file=/etc/ssh/ssh_host_ed25519_key.pub
 [[ -s $file && ! -L $file ]] || fail '没有找到本机 Ed25519 SSH 主机公钥，请检查 sshd 的 HostKey 配置。'
 echo '===== 本机 SSH 主机公钥指纹（不是用户公钥） ====='
 ssh-keygen -lf "$file"
 echo '===== 复制下面这一行，回到控制节点执行 trust-node 本节点名 ====='
 cat "$file"
}

trust_host() {
 local ip=${1:-} name=${2:-} file=/root/.ssh/known_hosts tmp alg blob comment
 [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && $name =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail '用法：trust-host <目标IPv4> <目标主机名>'
 local part
 IFS=. read -r -a parts <<< "$ip"
 for part in "${parts[@]}"; do ((10#$part <= 255)) || fail 'IPv4 地址无效。'; done
 safe_file "$file"
 read_public_key "目标 $name ($ip) 的 SSH 主机"
 read -r alg blob comment <<< "$PUBLIC_KEY"
 touch "$file"; chown root:root "$file"; chmod 600 "$file"
 tmp=$(mktemp /root/.ssh/.known-hosts.XXXXXX)
 for alias in "$ip" "$name"; do
  if ssh-keygen -F "$alias" -f "$file" > "$tmp"; then
   if awk -v a="$alg" -v b="$blob" '$1 !~ /^#/ && $2==a && $3!=b {bad=1} END {exit !bad}' "$tmp"; then
    rm -f -- "$tmp"; fail "$alias 已记录不同的 Ed25519 主机密钥，停止；请核对后人工处理，不自动删除。"
   fi
   if awk -v a="$alg" -v b="$blob" '$1 !~ /^#/ && $2==a && $3==b {ok=1} END {exit !ok}' "$tmp"; then continue; fi
  fi
  printf '\n%s %s %s\n' "$alias" "$alg" "$blob" >> "$file"
 done
 rm -f -- "$tmp"
 echo "已记录 $ip 和 $name 的主机公钥。请确保它来自目标机器的 host-key 输出。"
}

inspect_sshd() {
 local from=${1:-}
 command -v sshd >/dev/null || fail '找不到 sshd。'
 if [[ -n $from ]]; then
  [[ $from =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail '来源 IP 格式错误。'
  sshd -T -C "user=root,addr=$from,host=$from" | awk '$1 ~ /^(permitrootlogin|pubkeyauthentication|authorizedkeysfile|authenticationmethods|allowusers|denyusers|allowgroups|denygroups|strictmodes)$/ {print}'
 else
  sshd -T | awk '$1 ~ /^(permitrootlogin|pubkeyauthentication|authorizedkeysfile|authenticationmethods|allowusers|denyusers|allowgroups|denygroups|strictmodes)$/ {print}'
  echo '若有 Match 条件，请再传控制节点 IP，检查实际来源对应的 root 策略。'
 fi
}

enable_root_key() {
 local from=${1:-} cfg=/etc/ssh/sshd_config drop=/etc/ssh/sshd_config.d/00-mwctl-root-key.conf backup effective
 [[ $from =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail '用法：enable-root-key <控制节点的IPv4>'
 command -v sshd >/dev/null || fail '找不到 sshd。'
 safe_file "$cfg"; safe_file "$drop"
 [[ -d /etc/ssh/sshd_config.d && ! -L /etc/ssh/sshd_config.d ]] || fail 'sshd_config.d 必须是现有普通目录。'
 sshd -t
 backup=$(mktemp -d /root/sshd-before-mwctl.XXXXXX)
 cp -a -- "$cfg" "$backup/sshd_config"
 if [[ -e $drop ]]; then cp -a -- "$drop" "$backup/drop.conf"; fi
 printf '%s\n' '# Managed by setup-root-ssh-trust.sh: root uses keys; other users retain password policy.' 'PermitRootLogin prohibit-password' 'PubkeyAuthentication yes' > "$drop"
 chmod 644 "$drop"; chown root:root "$drop"
 # OpenSSH takes the first global value. Put our explicit include before others.
 if [[ $(head -n 1 "$cfg") != "Include $drop" ]]; then
  { printf 'Include %s\n' "$drop"; cat "$backup/sshd_config"; } > "$cfg"
 fi
 if ! sshd -t; then
  cp -a -- "$backup/sshd_config" "$cfg"
  if [[ -f $backup/drop.conf ]]; then cp -a -- "$backup/drop.conf" "$drop"; else rm -f -- "$drop"; fi
  fail "语法检查失败，已恢复配置；备份：$backup"
 fi
 effective=$(sshd -T -C "user=root,addr=$from,host=$from")
 printf '%s\n' "$effective" | awk '$1 ~ /^(permitrootlogin|pubkeyauthentication|authorizedkeysfile|authenticationmethods|allowusers|denyusers|allowgroups|denygroups)$/ {print}'
 if ! grep -Eq '^permitrootlogin (prohibit-password|without-password)$' <<< "$effective" || ! grep -Fxq 'pubkeyauthentication yes' <<< "$effective"; then
  cp -a -- "$backup/sshd_config" "$cfg"
  if [[ -f $backup/drop.conf ]]; then cp -a -- "$backup/drop.conf" "$drop"; else rm -f -- "$drop"; fi
  fail "现有 Match 规则覆盖 root 策略，已恢复且未 reload。请人工检查；备份：$backup"
 fi
 # Never rewrite access lists: root eligibility still depends on those policies.
 if systemctl is-active --quiet ssh.service; then systemctl reload ssh.service
 elif systemctl is-active --quiet sshd.service; then systemctl reload sshd.service
 else fail "SSH 服务未运行，未启动服务；配置备份：$backup"; fi
 echo "已 reload SSH：root 允许公钥、禁用密码；其他用户的密码策略未修改。备份：$backup"
 echo '若仍被拒绝，检查 AllowUsers/DenyUsers/AllowGroups/DenyGroups、AuthenticationMethods 和实际 AuthorizedKeysFile；脚本不自动改访问名单。'
}

check_login() {
 local ip=${1:-} expected=${2:-} actual
 [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && $expected =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail '用法：check <目标IPv4> <目标主机名>'
 # -n prevents a web terminal's next pasted command becoming SSH stdin.
 actual=$(ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 "root@$ip" 'test "$(id -u)" = 0 && hostname') || fail '免密验收失败。检查用户公钥、权限、主机指纹、root 登录策略和网络。'
 printf '连接返回主机名：%s\n' "$actual"
 [[ $actual == "$expected" ]] || fail "已通过 root 免密，但主机名不是 $expected；请核对目标机器及主机名。"
 echo "验收通过：root → $expected ($ip)，无密码提示，主机指纹严格验证。"
}

case ${1:-help} in
 prepare) prepare_node "${2:-}";;
 trust-node) mapped_operation trust_host "${2:-}";;
 check-node) mapped_operation check_login "${2:-}";;
 source) source_key;;
 target) target_key;;
 host-key) host_key;;
 trust-host) trust_host "${2:-}" "${3:-}";;
 inspect) inspect_sshd "${2:-}";;
 enable-root-key) enable_root_key "${2:-}";;
 check) check_login "${2:-}" "${3:-}";;
 help|--help|-h)
  cat <<'HELP'
root SSH 免密（先 sudo -i；只复制公钥）
  同一份 nodes.conf 放在脚本旁边，每行一个 IPv4 与节点名，第一行是控制节点。
  bash setup-root-ssh-trust.sh prepare NAME        每台按节点关系配置本机 hostname 与全部节点的 hosts
  bash setup-root-ssh-trust.sh trust-node NAME     控制节点按 nodes.conf 登记目标主机公钥
  bash setup-root-ssh-trust.sh check-node NAME     控制节点按 nodes.conf 验收目标免密
  bash setup-root-ssh-trust.sh source              控制节点生成/复用root密钥，显示公钥
  bash setup-root-ssh-trust.sh target              其他机器粘贴控制节点公钥，追加authorized_keys
  bash setup-root-ssh-trust.sh host-key            其他机器显示本机SSH主机公钥
  bash setup-root-ssh-trust.sh trust-host IP NAME  控制节点粘贴目标主机公钥，写known_hosts
  bash setup-root-ssh-trust.sh inspect SOURCE_IP   目标机器检查root有效sshd策略
  bash setup-root-ssh-trust.sh enable-root-key SOURCE_IP
                                                  目标机器显式允许root公钥，禁用root密码
  bash setup-root-ssh-trust.sh check IP NAME       控制节点验收root免密
HELP
  ;;
 *) fail '未知操作，使用 help 查看用法。';;
esac

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"delivery-studio/mwpack"
)

// ---- Agent Heartbeat Policy (Default Enabled + Configurable Interval) ----

type agentHeartbeatPolicy struct {
	DefaultIntervalSec int    `json:"default_interval_sec"` // default 5s, allowed 3..300s
	UpdatedAt          string `json:"updated_at,omitempty"`
	UpdatedBy          string `json:"updated_by,omitempty"`
}

func defaultAgentHeartbeatPolicy() agentHeartbeatPolicy {
	return agentHeartbeatPolicy{DefaultIntervalSec: 5}
}

func normalizeHeartbeatIntervalSec(sec int, allowZeroInherit bool) int {
	if sec <= 0 {
		if allowZeroInherit {
			return 0
		}
		return 5
	}
	if sec < 3 {
		return 3
	}
	if sec > 300 {
		return 300
	}
	return sec
}

func effectiveAgentHeartbeatSec(agentOverrideSec, globalDefaultSec int) int {
	if agentOverrideSec >= 3 {
		return normalizeHeartbeatIntervalSec(agentOverrideSec, false)
	}
	if globalDefaultSec >= 3 {
		return normalizeHeartbeatIntervalSec(globalDefaultSec, false)
	}
	return 5
}

func agentOnlineTimeout(configuredIntervalSec int, probe *agentHostProbe) time.Duration {
	sec := configuredIntervalSec
	if sec <= 0 && probe != nil && probe.IntervalSec > 0 {
		sec = probe.IntervalSec
	}
	if sec < 5 {
		sec = 5
	}
	if sec > 300 {
		sec = 300
	}
	d := time.Duration(sec)*3*time.Second + 15*time.Second
	if d < 35*time.Second {
		return 35 * time.Second
	}
	return d
}

func (s *storeServer) heartbeatPolicyPath() string {
	if s == nil || s.cfg.DataDir == "" {
		return ""
	}
	return filepath.Join(s.cfg.DataDir, "agent_heartbeat_policy.json")
}

func (s *storeServer) loadHeartbeatPolicy() agentHeartbeatPolicy {
	pol := defaultAgentHeartbeatPolicy()
	if s == nil {
		return pol
	}
	var saved agentHeartbeatPolicy
	if s.loadSettingDoc("agent_heartbeat_policy", s.heartbeatPolicyPath(), &saved) {
		saved.DefaultIntervalSec = normalizeHeartbeatIntervalSec(saved.DefaultIntervalSec, false)
		return saved
	}
	return pol
}

func (s *storeServer) saveHeartbeatPolicy(pol agentHeartbeatPolicy) error {
	pol.DefaultIntervalSec = normalizeHeartbeatIntervalSec(pol.DefaultIntervalSec, false)
	if pol.UpdatedAt == "" {
		pol.UpdatedAt = nowStamp()
	}
	return s.saveSettingDoc("agent_heartbeat_policy", s.heartbeatPolicyPath(), pol)
}

// ---- Read-Only Structured Target-Host Live Inspection Script Builder ----
//
// IMPORTANT: Every line in buildLiveInspectScript MUST pass validateReadOnlyProbeScriptLang
// with zero warnings (no mutating verbs, no file output redirections, no private keys).

func buildLiveInspectScript(f clusterFacts, dep *mwpack.Deployment, overrides clusterBaselineOverrides) string {
	appID := strings.ToLower(strings.TrimSpace(f.Current.AppID))
	var extraUnits, extraCfgPaths, extraDataDirs, extraLogDirs []string
	var hintPorts []int

	addPort := func(p int) {
		if p > 0 && p <= 65535 {
			for _, ex := range hintPorts {
				if ex == p {
					return
				}
			}
			hintPorts = append(hintPorts, p)
		}
	}
	if dep != nil {
		if dep.Imported != nil {
			extraUnits = append(extraUnits, dep.Imported.ServiceUnits...)
			extraCfgPaths = append(extraCfgPaths, dep.Imported.ConfigPaths...)
			extraDataDirs = append(extraDataDirs, dep.Imported.DataDirs...)
			extraLogDirs = append(extraLogDirs, dep.Imported.LogDirs...)
		}
		for _, inst := range dep.Instances {
			if inst.Params != nil {
				for _, pk := range []string{"port", "tls_port", "http_port", "https_port", "client_port", "stats_port"} {
					if raw, ok := inst.Params[pk]; ok {
						if pn, err := strconv.Atoi(strings.TrimSpace(fmt.Sprintf("%v", raw))); err == nil {
							addPort(pn)
						}
					}
				}
			}
		}
	}
	extraUnits = mergeUniqueStrings(extraUnits, overrides.ServiceUnits)
	extraCfgPaths = mergeUniqueStrings(extraCfgPaths, overrides.ConfigPaths)
	extraDataDirs = mergeUniqueStrings(extraDataDirs, overrides.DataDirs)
	extraLogDirs = mergeUniqueStrings(extraLogDirs, overrides.LogDirs)

	switch {
	case strings.Contains(appID, "postgres"):
		addPort(5432)
		addPort(8008)
	case strings.Contains(appID, "redis"):
		addPort(6379)
		addPort(26379)
	case strings.Contains(appID, "etcd"):
		addPort(2379)
	case strings.Contains(appID, "nginx") || strings.Contains(appID, "openresty"):
		addPort(443)
		addPort(80)
	case strings.Contains(appID, "haproxy"):
		addPort(443)
		addPort(5000)
	}

	safeShellToken := regexp.MustCompile(`^[a-zA-Z0-9_./:@-]+$`)
	cleanShellList := func(items []string) string {
		var out []string
		for _, it := range items {
			it = strings.TrimSpace(it)
			if it != "" && safeShellToken.MatchString(it) {
				out = append(out, fmt.Sprintf("%q", it))
			}
		}
		return strings.Join(out, " ")
	}

	portTokens := make([]string, 0, len(hintPorts))
	for _, p := range hintPorts {
		portTokens = append(portTokens, strconv.Itoa(p))
	}

	var b strings.Builder
	b.WriteString("#!/usr/bin/env bash\n")
	b.WriteString("if [ -z \"${BASH_VERSION:-}\" ]; then exec bash \"$0\" \"$@\"; fi\n")
	b.WriteString("set -uo pipefail\n")
	b.WriteString("export LC_ALL=C LANG=C PATH=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}\"\n\n")

	// 1. Host identity & OS kernel
	b.WriteString("echo '@@MW_HOST_BEGIN@@'\n")
	b.WriteString("echo \"HOSTNAME=$(hostname 2>/dev/null || uname -n 2>/dev/null || echo unknown)\"\n")
	b.WriteString("if command -v ip >/dev/null 2>&1; then\n")
	b.WriteString("  IPS_OUT=$(ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,\"/\"); print a[1]}' | paste -sd ' ' -)\n")
	b.WriteString("  echo \"IPS=${IPS_OUT:-}\"\n")
	b.WriteString("fi\n")
	b.WriteString("if [ -r /etc/os-release ]; then\n")
	b.WriteString("  OS_P=$(grep -E '^PRETTY_NAME=' /etc/os-release 2>/dev/null | head -n 1 | cut -d= -f2- | tr -d '\"')\n")
	b.WriteString("  echo \"OS_PRETTY=${OS_P:-}\"\n")
	b.WriteString("fi\n")
	b.WriteString("echo \"KERNEL=$(uname -r 2>/dev/null || echo '')\"\n")
	b.WriteString("echo '@@MW_HOST_END@@'\n\n")

	// 2. Systemd service units & listening TCP ports
	b.WriteString("echo '@@MW_SERVICES_BEGIN@@'\n")
	b.WriteString("if command -v systemctl >/dev/null 2>&1; then\n")
	b.WriteString("  systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null | awk '$1 ~ /^(postgres|patroni|etcd|redis|sentinel|haproxy|keepalived|nginx|openresty|pgbouncer|pgbackrest|node_exporter|postgres_exporter|redis_exporter|mysqld|mariadb|kafka|zookeeper|rabbitmq)/ {print \"SVC|\" $1 \"|\" $3 \"|\" $4}'\n")
	if unitArgs := cleanShellList(extraUnits); unitArgs != "" {
		fmt.Fprintf(&b, "  for u in %s; do\n", unitArgs)
		b.WriteString("    st=$(systemctl is-active \"$u\" 2>/dev/null || true)\n")
		b.WriteString("    if [ -n \"$st\" ] && [ \"$st\" != \"unknown\" ]; then echo \"SVC|${u}|${st}|-\"; fi\n")
		b.WriteString("  done\n")
	}
	b.WriteString("fi\n")
	b.WriteString("if command -v ss >/dev/null 2>&1; then\n")
	b.WriteString("  ss -tlnH 2>/dev/null | awk '{print \"PORT|\" $4}'\n")
	b.WriteString("fi\n")
	b.WriteString("echo '@@MW_SERVICES_END@@'\n\n")

	// 3. Runtime paths verification
	b.WriteString("echo '@@MW_PATHS_BEGIN@@'\n")
	defaultCfgs := []string{
		"/etc/patroni/patroni.yml", "/etc/patroni/config.yml",
		"/etc/etcd/etcd.conf", "/etc/etcd/etcd.yml",
		"/etc/redis/redis.conf", "/etc/redis.conf", "/etc/redis/sentinel.conf",
		"/etc/haproxy/haproxy.cfg", "/etc/keepalived/keepalived.conf",
		"/etc/nginx/nginx.conf", "/usr/local/openresty/nginx/conf/nginx.conf",
		"/etc/pgbouncer/pgbouncer.ini", "/etc/pgbackrest/pgbackrest.conf",
	}
	for _, p := range mergeUniqueStrings(defaultCfgs, extraCfgPaths) {
		if safeShellToken.MatchString(p) {
			fmt.Fprintf(&b, "if [ -e %q ]; then echo %q; fi\n", p, "CFG|"+p)
		}
	}
	defaultDatas := []string{
		"/var/lib/postgresql", "/var/lib/pgsql", "/data/postgresql", "/data/patroni",
		"/var/lib/etcd", "/data/etcd",
		"/var/lib/redis", "/data/redis",
	}
	for _, p := range mergeUniqueStrings(defaultDatas, extraDataDirs) {
		if safeShellToken.MatchString(p) {
			fmt.Fprintf(&b, "if [ -d %q ]; then echo %q; fi\n", p, "DATA|"+p)
		}
	}
	defaultLogs := []string{
		"/var/log/postgresql", "/var/log/patroni", "/var/log/redis", "/var/log/nginx", "/var/log/haproxy",
	}
	for _, p := range mergeUniqueStrings(defaultLogs, extraLogDirs) {
		if safeShellToken.MatchString(p) {
			fmt.Fprintf(&b, "if [ -d %q ]; then echo %q; fi\n", p, "LOG|"+p)
		}
	}
	b.WriteString("echo '@@MW_PATHS_END@@'\n\n")

	// 4. Runtime role, exact version, effective parameters & client CIDRs
	b.WriteString("echo '@@MW_RUNTIME_BEGIN@@'\n")
	b.WriteString("PG_SQL_OK=0\n")
	b.WriteString("if command -v psql >/dev/null 2>&1; then\n")
	b.WriteString("  echo \"VER|postgresql|$(psql --version 2>/dev/null | head -n 1)\"\n")
	b.WriteString("  PSQL_OUT=\"\"\n")
	b.WriteString("  if command -v runuser >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then\n")
	b.WriteString("    PSQL_OUT=$(timeout 5 runuser -u postgres -- psql -X -A -t -c \"SELECT 'ROLE|' || CASE WHEN pg_is_in_recovery() THEN 'replica' ELSE 'primary' END UNION ALL SELECT 'PARAM|' || name || '=' || setting || CASE WHEN unit IS NOT NULL AND unit != '' THEN unit ELSE '' END FROM pg_settings WHERE name IN ('port','max_connections','shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','wal_level','max_wal_size','ssl','archive_mode','synchronous_commit','synchronous_standby_names','logging_collector','log_directory','statement_timeout','shared_preload_libraries')\" 2>/dev/null || true)\n")
	b.WriteString("  elif command -v sudo >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then\n")
	b.WriteString("    PSQL_OUT=$(timeout 5 sudo -n -u postgres psql -X -A -t -c \"SELECT 'ROLE|' || CASE WHEN pg_is_in_recovery() THEN 'replica' ELSE 'primary' END UNION ALL SELECT 'PARAM|' || name || '=' || setting || CASE WHEN unit IS NOT NULL AND unit != '' THEN unit ELSE '' END FROM pg_settings WHERE name IN ('port','max_connections','shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','wal_level','max_wal_size','ssl','archive_mode','synchronous_commit','synchronous_standby_names','logging_collector','log_directory','statement_timeout','shared_preload_libraries')\" 2>/dev/null || true)\n")
	b.WriteString("  fi\n")
	b.WriteString("  if [ -n \"$PSQL_OUT\" ]; then\n")
	b.WriteString("    PG_SQL_OK=1\n")
	b.WriteString("    printf '%s\\n' \"$PSQL_OUT\"\n")
	b.WriteString("  fi\n")
	b.WriteString("fi\n")

	b.WriteString("if command -v patronictl >/dev/null 2>&1 && [ -r /etc/patroni/patroni.yml ]; then\n")
	b.WriteString("  echo \"VER|patroni|$(patronictl version 2>/dev/null | head -n 1)\"\n")
	b.WriteString("  PT_JSON=$(timeout 4 patronictl -c /etc/patroni/patroni.yml list -f json 2>/dev/null | tr -d '\\n' || true)\n")
	b.WriteString("  if [ -n \"$PT_JSON\" ]; then echo \"PATRONI_JSON|${PT_JSON}\"; fi\n")
	b.WriteString("fi\n")

	b.WriteString("for hba in /etc/postgresql/*/*/pg_hba.conf /var/lib/pgsql/*/data/pg_hba.conf /data/patroni*/pg_hba.conf /var/lib/postgresql/data/pg_hba.conf; do\n")
	b.WriteString("  if [ -r \"$hba\" ]; then\n")
	b.WriteString("    echo \"CFG|${hba}\"\n")
	b.WriteString("    awk '!/^[[:space:]]*#/ && ($1==\"host\" || $1==\"hostssl\" || $1==\"hostnossl\") && $4 ~ /[0-9.:]+\\/[0-9]+/ {print \"CIDR|\" $4}' \"$hba\" 2>/dev/null\n")
	b.WriteString("  fi\n")
	b.WriteString("done\n")

	b.WriteString("if [ \"$PG_SQL_OK\" -eq 0 ]; then\n")
	b.WriteString("  for pgc in /etc/postgresql/*/*/postgresql.conf /var/lib/pgsql/*/data/postgresql.conf /data/patroni*/postgresql.conf; do\n")
	b.WriteString("    if [ -r \"$pgc\" ]; then\n")
	b.WriteString("      echo \"CFG|${pgc}\"\n")
	b.WriteString("      grep -E '^[[:space:]]*(port|max_connections|shared_buffers|work_mem|maintenance_work_mem|wal_level|ssl|archive_mode|synchronous_commit)[[:space:]]*=' \"$pgc\" 2>/dev/null | sed 's/#.*//; s/[[:space:]]*=[[:space:]]*/=/; s/^[[:space:]]*//; s/[[:space:]]*$//' | awk -F= 'NF==2 {gsub(/\\047|\"/, \"\", $2); print \"PARAM|\" $1 \"=\" $2}'\n")
	b.WriteString("    fi\n")
	b.WriteString("  done\n")
	b.WriteString("fi\n")

	// Redis / Sentinel
	b.WriteString("if command -v redis-server >/dev/null 2>&1; then\n")
	b.WriteString("  echo \"VER|redis|$(redis-server --version 2>/dev/null | head -n 1)\"\n")
	b.WriteString("fi\n")
	b.WriteString("for rcf in /etc/redis/redis.conf /etc/redis.conf /opt/redis*/etc/redis.conf; do\n")
	b.WriteString("  if [ -r \"$rcf\" ]; then\n")
	b.WriteString("    awk '!/^[[:space:]]*#/ && ($1==\"port\" || $1==\"tls-port\" || $1==\"bind\" || $1==\"protected-mode\" || $1==\"maxmemory\" || $1==\"maxmemory-policy\" || $1==\"appendonly\" || $1==\"appendfsync\" || $1==\"hz\" || $1==\"timeout\") {k=$1; $1=\"\"; sub(/^[[:space:]]+/, \"\"); gsub(/\"/, \"\"); print \"PARAM|\" k \"=\" $0}' \"$rcf\" 2>/dev/null\n")
	b.WriteString("  fi\n")
	b.WriteString("done\n")
	b.WriteString("if command -v redis-cli >/dev/null 2>&1; then\n")
	b.WriteString("  R_INFO=$(timeout 3 redis-cli info replication 2>/dev/null | tr -d '\\r' || true)\n")
	b.WriteString("  if printf '%s\\n' \"$R_INFO\" | grep -q '^role:master'; then echo 'ROLE|primary'; fi\n")
	b.WriteString("  if printf '%s\\n' \"$R_INFO\" | grep -q '^role:slave'; then echo 'ROLE|replica'; fi\n")
	b.WriteString("fi\n")

	// etcd
	b.WriteString("if command -v etcd >/dev/null 2>&1; then\n")
	b.WriteString("  echo \"VER|etcd|$(etcd --version 2>/dev/null | head -n 1)\"\n")
	b.WriteString("fi\n")
	b.WriteString("for ecf in /etc/etcd/etcd.conf /etc/etcd/etcd.yml /etc/etcd/etcd.conf.yml; do\n")
	b.WriteString("  if [ -r \"$ecf\" ]; then\n")
	b.WriteString("    if grep -Eq '(cert-file|ETCD_CERT_FILE|https://)' \"$ecf\" 2>/dev/null; then echo 'PARAM|tls=true'; fi\n")
	b.WriteString("  fi\n")
	b.WriteString("done\n")

	// Nginx / OpenResty / HAProxy / Keepalived
	b.WriteString("if command -v nginx >/dev/null 2>&1; then echo \"VER|nginx|$(nginx -v 2>&1 | head -n 1)\"; fi\n")
	b.WriteString("if command -v openresty >/dev/null 2>&1; then echo \"VER|openresty|$(openresty -v 2>&1 | head -n 1)\"; fi\n")
	b.WriteString("if command -v haproxy >/dev/null 2>&1; then echo \"VER|haproxy|$(haproxy -v 2>/dev/null | head -n 1)\"; fi\n")
	b.WriteString("if command -v keepalived >/dev/null 2>&1; then echo \"VER|keepalived|$(keepalived --version 2>&1 | head -n 1)\"; fi\n")
	b.WriteString("if [ -r /etc/keepalived/keepalived.conf ]; then\n")
	b.WriteString("  VIPS_CFG=$(awk '/virtual_ipaddress/,/}/ {if ($1 ~ /^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+/) {split($1,a,\"/\"); print a[1]}}' /etc/keepalived/keepalived.conf 2>/dev/null)\n")
	b.WriteString("  for vip in $VIPS_CFG; do\n")
	b.WriteString("    if printf ' %s ' \"${IPS_OUT:-}\" | grep -Fq \" $vip \"; then\n")
	b.WriteString("      echo \"VIP|${vip}\"\n")
	b.WriteString("    fi\n")
	b.WriteString("  done\n")
	b.WriteString("fi\n")
	b.WriteString("echo '@@MW_RUNTIME_END@@'\n\n")

	// 5. Public X.509 Certificates ONLY (strictly CERTIFICATE blocks, never private keys!)
	b.WriteString("echo '@@MW_CERTS_BEGIN@@'\n")
	b.WriteString("for crt in /etc/patroni/*.crt /etc/patroni/certs/*.crt /etc/etcd/*.crt /etc/etcd/pki/*.crt /etc/redis/tls/*.crt /etc/nginx/ssl/*.crt /etc/nginx/certs/*.crt /etc/haproxy/certs/*.crt /var/lib/postgresql/*/*/*.crt /var/lib/pgsql/*/data/*.crt; do\n")
	b.WriteString("  if [ -r \"$crt\" ]; then\n")
	b.WriteString("    PEM_BLK=$(sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' \"$crt\" 2>/dev/null || true)\n")
	b.WriteString("    if [ -n \"$PEM_BLK\" ]; then\n")
	b.WriteString("      echo \"@@CERT_SOURCE|file:${crt}@@\"\n")
	b.WriteString("      printf '%s\\n' \"$PEM_BLK\"\n")
	b.WriteString("    fi\n")
	b.WriteString("  fi\n")
	b.WriteString("done\n")
	if len(portTokens) > 0 {
		b.WriteString("if command -v openssl >/dev/null 2>&1; then\n")
		fmt.Fprintf(&b, "  for tp in %s; do\n", strings.Join(portTokens, " "))
		b.WriteString("    PEM_LIVE=\"\"\n")
		b.WriteString("    if [ \"$tp\" = \"5432\" ]; then\n")
		b.WriteString("      PEM_LIVE=$(timeout 3 openssl s_client -starttls postgres -connect \"127.0.0.1:${tp}\" </dev/null 2>/dev/null | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' || true)\n")
		b.WriteString("    else\n")
		b.WriteString("      PEM_LIVE=$(timeout 3 openssl s_client -connect \"127.0.0.1:${tp}\" </dev/null 2>/dev/null | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' || true)\n")
		b.WriteString("    fi\n")
		b.WriteString("    if [ -n \"$PEM_LIVE\" ]; then\n")
		b.WriteString("      echo \"@@CERT_SOURCE|port:${tp}@@\"\n")
		b.WriteString("      printf '%s\\n' \"$PEM_LIVE\"\n")
		b.WriteString("    fi\n")
		b.WriteString("  done\n")
		b.WriteString("fi\n")
	}
	b.WriteString("echo '@@MW_CERTS_END@@'\n\n")

	// 6. Real Installed OS & Middleware Packages (drives real CVE & SBOM scan)
	b.WriteString("echo '@@MW_PKGS_BEGIN@@'\n")
	b.WriteString("if command -v dpkg-query >/dev/null 2>&1; then\n")
	b.WriteString("  dpkg-query -W -f='DEB|${Package}|${Version}\\n' 2>/dev/null | head -n 4000\n")
	b.WriteString("elif command -v rpm >/dev/null 2>&1; then\n")
	b.WriteString("  rpm -qa --queryformat 'RPM|%{NAME}|%{EPOCHNUM}:%{VERSION}-%{RELEASE}\\n' 2>/dev/null | head -n 4000\n")
	b.WriteString("fi\n")
	b.WriteString("echo '@@MW_PKGS_END@@'\n")

	return b.String()
}

// ---- Deterministic Parser for Structured Live Inspection & Offline Probe Output ----

var reCleanPkgVerPrefix = regexp.MustCompile(`^(?:\(none\)|0):`)

func parseSingleHostInspectOutput(hostName, hostIP, raw string, appID string, primaryPkgNames map[string]bool) clusterHostLive {
	now := nowStamp()
	hl := clusterHostLive{
		Host:     strings.TrimSpace(hostName),
		IP:       strings.TrimSpace(hostIP),
		ProbedAt: now,
		Online:   strings.TrimSpace(raw) != "",
		Params:   map[string]string{},
	}
	if !hl.Online {
		return hl
	}

	hasStructured := strings.Contains(raw, "@@MW_HOST_BEGIN@@") ||
		strings.Contains(raw, "@@MW_SERVICES_BEGIN@@") ||
		strings.Contains(raw, "@@MW_RUNTIME_BEGIN@@") ||
		strings.Contains(raw, "@@MW_PKGS_BEGIN@@")

	if !hasStructured {
		// Fallback for ad-hoc pasted read-only probe outputs from offline machines
		parsed, parsedParams := parseProbeEvidenceText(raw, appID)
		hl.OSDetail = parsed.OSDetail
		hl.ExactVersion = parsed.ExactVersion
		hl.ServiceUnits = parsed.ServiceUnits
		hl.ConfigPaths = parsed.ConfigPaths
		hl.DataDirs = parsed.DataDirs
		hl.LogDirs = parsed.LogDirs
		hl.Packages = parsed.Packages
		hl.Companions = parsed.Companions
		for k, v := range parsedParams {
			hl.Params[k] = v
		}
		hl.Certs = parseCertChecksFromRawPEM(firstNonEmptyStr(hl.Host, hl.IP), "probe", raw)
		return hl
	}

	section := ""
	certSource := ""
	var certBuf strings.Builder
	flushCert := func() {
		if certBuf.Len() == 0 {
			return
		}
		bundle := "live"
		if strings.HasPrefix(certSource, "port:") {
			bundle = "tls-" + strings.TrimPrefix(certSource, "port:")
		} else if strings.HasPrefix(certSource, "file:") {
			fp := strings.TrimPrefix(certSource, "file:")
			parts := strings.Split(fp, "/")
			bundle = parts[len(parts)-1]
		}
		instLabel := firstNonEmptyStr(hl.Host, hl.IP, "cluster")
		hl.Certs = append(hl.Certs, parseCertChecksFromRawPEM(instLabel, bundle, certBuf.String())...)
		certBuf.Reset()
	}

	portSeen := map[int]bool{}
	svcSeen := map[string]bool{}
	cidrSeen := map[string]bool{}
	var hostIPs []string
	var patroniMembers []struct {
		Member string `json:"Member"`
		Host   string `json:"Host"`
		Role   string `json:"Role"`
		State  string `json:"State"`
	}

	for _, rawLine := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(rawLine)
		switch line {
		case "@@MW_HOST_BEGIN@@":
			section = "host"
			continue
		case "@@MW_SERVICES_BEGIN@@":
			section = "services"
			continue
		case "@@MW_PATHS_BEGIN@@":
			section = "paths"
			continue
		case "@@MW_RUNTIME_BEGIN@@":
			section = "runtime"
			continue
		case "@@MW_CERTS_BEGIN@@":
			section = "certs"
			certSource = ""
			certBuf.Reset()
			continue
		case "@@MW_CERTS_END@@":
			flushCert()
			section = ""
			continue
		case "@@MW_PKGS_BEGIN@@":
			section = "pkgs"
			continue
		case "@@MW_HOST_END@@", "@@MW_SERVICES_END@@", "@@MW_PATHS_END@@", "@@MW_RUNTIME_END@@", "@@MW_PKGS_END@@":
			section = ""
			continue
		}
		if line == "" {
			continue
		}

		switch section {
		case "host":
			if k, v, ok := strings.Cut(line, "="); ok {
				v = strings.TrimSpace(v)
				switch k {
				case "HOSTNAME":
					if hl.Host == "" && v != "" && v != "unknown" {
						hl.Host = v
					}
				case "IPS":
					hostIPs = strings.Fields(v)
					if hl.IP == "" && len(hostIPs) > 0 {
						hl.IP = hostIPs[0]
					}
				case "OS_PRETTY":
					hl.OSDetail = v
				case "KERNEL":
					hl.Kernel = v
				}
			}

		case "services":
			if strings.HasPrefix(line, "SVC|") {
				parts := strings.SplitN(line, "|", 4)
				if len(parts) >= 3 {
					unit := strings.TrimSpace(parts[1])
					active := strings.TrimSpace(parts[2])
					sub := ""
					if len(parts) == 4 && parts[3] != "-" {
						sub = strings.TrimSpace(parts[3])
					}
					if unit != "" && !svcSeen[unit] {
						svcSeen[unit] = true
						hl.Services = append(hl.Services, clusterServiceLive{
							Unit:        unit,
							ActiveState: active,
							SubState:    sub,
							Healthy:     active == "active",
						})
						hl.ServiceUnits = mergeUniqueStrings(hl.ServiceUnits, []string{unit})
						hl.Companions = mergeCompanionsNonDestructive(hl.Companions, detectCompanionFromUnit(unit, appID))
					}
				}
			} else if strings.HasPrefix(line, "PORT|") {
				addr := strings.TrimPrefix(line, "PORT|")
				if idx := strings.LastIndexByte(addr, ':'); idx >= 0 && idx+1 < len(addr) {
					if pn, err := strconv.Atoi(addr[idx+1:]); err == nil && pn > 0 && pn <= 65535 && !portSeen[pn] {
						portSeen[pn] = true
						hl.ListeningPorts = append(hl.ListeningPorts, pn)
					}
				}
			}

		case "paths":
			switch {
			case strings.HasPrefix(line, "CFG|"):
				hl.ConfigPaths = mergeUniqueStrings(hl.ConfigPaths, []string{strings.TrimPrefix(line, "CFG|")})
			case strings.HasPrefix(line, "DATA|"):
				hl.DataDirs = mergeUniqueStrings(hl.DataDirs, []string{strings.TrimPrefix(line, "DATA|")})
			case strings.HasPrefix(line, "LOG|"):
				hl.LogDirs = mergeUniqueStrings(hl.LogDirs, []string{strings.TrimPrefix(line, "LOG|")})
			}

		case "runtime":
			switch {
			case strings.HasPrefix(line, "ROLE|"):
				r := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(line, "ROLE|")))
				if r != "" {
					hl.Role = r
				}
			case strings.HasPrefix(line, "VIP|"):
				vip := strings.TrimSpace(strings.TrimPrefix(line, "VIP|"))
				if vip != "" {
					hl.VIPs = mergeUniqueStrings(hl.VIPs, []string{vip})
				}
			case strings.HasPrefix(line, "CFG|"):
				hl.ConfigPaths = mergeUniqueStrings(hl.ConfigPaths, []string{strings.TrimPrefix(line, "CFG|")})
			case strings.HasPrefix(line, "CIDR|"):
				cidr := strings.TrimSpace(strings.TrimPrefix(line, "CIDR|"))
				if cidr != "" && !cidrSeen[cidr] {
					cidrSeen[cidr] = true
					hl.ClientCIDRs = append(hl.ClientCIDRs, cidr)
				}
			case strings.HasPrefix(line, "VER|"):
				parts := strings.SplitN(line, "|", 3)
				if len(parts) == 3 {
					compKey := strings.ToLower(strings.TrimSpace(parts[1]))
					verRaw := extractCleanVersionToken(parts[2])
					if verRaw != "" {
						if strings.Contains(strings.ToLower(appID), compKey) || hl.ExactVersion == "" {
							hl.ExactVersion = verRaw
						}
						if !strings.Contains(strings.ToLower(appID), compKey) {
							hl.Companions = mergeCompanionsNonDestructive(hl.Companions, []mwpack.ImportedCompanion{{
								Component: compKey,
								Version:   verRaw,
							}})
						}
					}
				}
			case strings.HasPrefix(line, "PATRONI_JSON|"):
				rawJ := strings.TrimSpace(strings.TrimPrefix(line, "PATRONI_JSON|"))
				_ = json.Unmarshal([]byte(rawJ), &patroniMembers)
			case strings.HasPrefix(line, "PARAM|"):
				kv := strings.TrimPrefix(line, "PARAM|")
				if k, v, ok := strings.Cut(kv, "="); ok {
					k = strings.TrimSpace(k)
					v = strings.TrimSpace(v)
					if k != "" && v != "" {
						hl.Params[k] = v
						lk := normClusterParamKey(k)
						if lk == "ssl" {
							if equivParamValues(v, "true") {
								hl.Params["tls"] = "true"
							} else if equivParamValues(v, "false") {
								hl.Params["tls"] = "false"
							}
						}
						if lk == "tls_port" {
							if pn, err := strconv.Atoi(v); err == nil && pn > 0 {
								hl.Params["tls"] = "true"
							}
						}
						if lk == "shared_preload_libraries" && strings.Contains(strings.ToLower(v), "pg_tde") {
							hl.Params["tde"] = "true"
						}
					}
				}
			}

		case "certs":
			if strings.HasPrefix(line, "@@CERT_SOURCE|") && strings.HasSuffix(line, "@@") {
				flushCert()
				certSource = strings.TrimSuffix(strings.TrimPrefix(line, "@@CERT_SOURCE|"), "@@")
			} else {
				certBuf.WriteString(line + "\n")
			}

		case "pkgs":
			if strings.HasPrefix(line, "DEB|") || strings.HasPrefix(line, "RPM|") {
				parts := strings.SplitN(line, "|", 3)
				if len(parts) == 3 {
					name := strings.TrimSpace(parts[1])
					ver := reCleanPkgVerPrefix.ReplaceAllString(strings.TrimSpace(parts[2]), "")
					if name != "" && ver != "" {
						role := classifySecPkgRole("os_package", name, []string{appID}, primaryPkgNames)
						hl.Packages = append(hl.Packages, mwpack.ImportedPkg{
							Name:    name,
							Version: ver,
							Role:    role,
						})
					}
				}
			}
		}
	}

	// Refine role from Patroni cluster state if available
	if len(patroniMembers) > 0 {
		for _, m := range patroniMembers {
			matchesHost := (hl.Host != "" && strings.EqualFold(m.Member, hl.Host)) ||
				(hl.IP != "" && m.Host == hl.IP) ||
				contains(hostIPs, m.Host)
			if matchesHost {
				rl := strings.ToLower(strings.TrimSpace(m.Role))
				switch {
				case rl == "leader" || rl == "master" || rl == "primary":
					hl.Role = "primary"
				case strings.Contains(rl, "standby") || rl == "replica":
					hl.Role = "replica"
				}
				hl.ReplicationState = m.State
				break
			}
		}
	}
	if hl.Role == "" && len(hl.VIPs) > 0 {
		hl.Role = "primary"
	}
	if len(hl.ClientCIDRs) > 0 && hl.Params["client_cidr"] == "" {
		hl.Params["client_cidr"] = strings.Join(hl.ClientCIDRs, ",")
	}
	sort.Ints(hl.ListeningPorts)
	return hl
}

var reVerToken = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?`)

func extractCleanVersionToken(s string) string {
	return reVerToken.FindString(s)
}

func detectCompanionFromUnit(unit, primaryAppID string) []mwpack.ImportedCompanion {
	lu := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(unit), ".service"))
	for _, item := range []struct {
		match string
		comp  string
		title string
		kind  string
	}{
		{"patroni", "patroni", "Patroni", "ha_manager"},
		{"etcd", "etcd", "etcd", "dcs"},
		{"haproxy", "haproxy", "HAProxy", "proxy"},
		{"keepalived", "keepalived", "Keepalived", "vip"},
		{"pgbouncer", "pgbouncer", "PgBouncer", "pooler"},
		{"pgbackrest", "pgbackrest", "pgBackRest", "backup"},
		{"postgres_exporter", "postgres_exporter", "Postgres Exporter", "monitoring"},
		{"redis_exporter", "redis_exporter", "Redis Exporter", "monitoring"},
		{"node_exporter", "node_exporter", "Node Exporter", "monitoring"},
	} {
		if strings.HasPrefix(lu, item.match) && !strings.Contains(strings.ToLower(primaryAppID), item.comp) {
			return []mwpack.ImportedCompanion{{
				Component:    item.comp,
				DisplayName:  item.title,
				Kind:         item.kind,
				ServiceUnits: []string{unit},
			}}
		}
	}
	return nil
}

func parseCertChecksFromRawPEM(instanceLabel, bundle, raw string) []secCertCheck {
	certs := parseX509CertsLenient([]byte(raw))
	if len(certs) == 0 {
		return nil
	}
	nowTime := time.Now().UTC()
	out := make([]secCertCheck, 0, len(certs))
	lb := strings.ToLower(bundle)
	for idx, c := range certs {
		daysLeft := int(time.Until(c.NotAfter).Hours() / 24)
		status := "ok"
		switch {
		case nowTime.After(c.NotAfter):
			status = "expired"
		case daysLeft <= 7:
			status = "critical"
		case daysLeft <= 30:
			status = "expiring"
		}
		role := "server"
		if idx > 0 || c.IsCA || strings.HasPrefix(lb, "ca.") || strings.Contains(lb, "ca-") || strings.Contains(lb, "root") {
			role = "ca"
		}
		algo, bits := certKeyInfo(c)
		sans := append([]string(nil), c.DNSNames...)
		for _, ip := range c.IPAddresses {
			sans = append(sans, ip.String())
		}
		subj := firstNonEmptyStr(c.Subject.CommonName, c.Subject.String())
		iss := firstNonEmptyStr(c.Issuer.CommonName, c.Issuer.String())
		out = append(out, secCertCheck{
			Instance:     instanceLabel,
			Bundle:       bundle,
			Role:         role,
			Subject:      subj,
			Issuer:       iss,
			SANs:         sans,
			NotBefore:    c.NotBefore.UTC().Format("2006-01-02"),
			NotAfter:     c.NotAfter.UTC().Format("2006-01-02"),
			DaysLeft:     daysLeft,
			KeyAlgo:      algo,
			KeyBits:      bits,
			SigAlgo:      c.SignatureAlgorithm.String(),
			IsSelfSigned: subj != "" && subj == iss,
			Status:       status,
		})
	}
	return out
}

func parseProbeEvidenceText(raw, appID string) (mwpack.ImportedMeta, map[string]string) {
	var meta mwpack.ImportedMeta
	preset, _ := mwpack.LookupImportPreset(appID)
	res := parseImportedDeterministic(raw, appID, preset.Name, preset)
	meta.OSDetail = res.OSDetail
	meta.ExactVersion = res.ExactVersion
	meta.ServiceUnits = res.ServiceUnits
	meta.ConfigPaths = res.ConfigPaths
	meta.DataDirs = res.DataDirs
	meta.LogDirs = res.LogDirs
	meta.Packages = res.Packages
	meta.Companions = res.Companions
	params := map[string]string{}
	for k, v := range res.Params {
		sv := stringifyParamVal(v)
		if sv != "" {
			params[k] = sv
		}
	}
	return meta, params
}

// ---- Dispatching & Ingesting Cluster Live Inspection Tasks ----

type triggerLiveInspectOptions struct {
	AgentID        string
	NodeExecMethod string
	SSHUser        string
	SSHPort        int
	User           string
	Reason         string // manual | scheduled | bind_auto
	Lang           string
}

func (s *storeServer) selectBestClusterAgent(clusterID, explicitAgentID string, allTargets []rehearsalExecTarget) (string, []rehearsalExecTarget) {
	if strings.TrimSpace(explicitAgentID) != "" {
		return strings.TrimSpace(explicitAgentID), allTargets
	}
	cfg := s.loadClusterAutomationConfig(clusterID)
	executionMu.Lock()
	d, err := s.readExecutions()
	executionMu.Unlock()
	if err != nil {
		return "", allTargets
	}

	// 1. Prefer cluster's last chosen agent if still bound & online
	if last := strings.TrimSpace(cfg.LastAgentID); last != "" {
		if n, ok := d.Nodes[last]; ok && !n.Disabled && executionOnline(n) && n.Protocol >= 3 && nodeClusterMode(n, clusterID) != "" {
			return n.ID, allTargets
		}
		if a, ok := d.Agents[last]; ok && a.Mode == "direct" && a.Desired == "active" && !a.Disabled && targetAgentOnline(a) && targetAgentAllowsCluster(a, clusterID) {
			var filtered []rehearsalExecTarget
			for _, tg := range allTargets {
				if tg.IP == a.IP {
					tg.AgentID = a.ID
					filtered = append(filtered, tg)
				}
			}
			if len(filtered) > 0 {
				return a.ID, filtered
			}
		}
	}

	// 2. Any online v3 execution node authorized for this cluster (covers all cluster hosts via local/SSH)
	var nodeIDs []string
	for id, n := range d.Nodes {
		if !n.Disabled && executionOnline(n) && n.Protocol >= 3 && nodeClusterMode(n, clusterID) != "" {
			nodeIDs = append(nodeIDs, id)
		}
	}
	if len(nodeIDs) > 0 {
		sort.Strings(nodeIDs)
		return nodeIDs[0], allTargets
	}

	// 3. Direct target agents online on cluster target hosts (non-destructively probe whichever hosts are online!)
	var directTargets []rehearsalExecTarget
	for _, tg := range allTargets {
		for _, a := range d.Agents {
			if a.Mode == "direct" && a.Desired == "active" && !a.Disabled && targetAgentOnline(a) && targetAgentAllowsCluster(a, clusterID) && a.IP == tg.IP {
				tg.AgentID = a.ID
				directTargets = append(directTargets, tg)
				break
			}
		}
	}
	if len(directTargets) > 0 {
		return "__direct__", directTargets
	}
	return "", allTargets
}

func (s *storeServer) triggerClusterLiveInspect(clusterID string, opts triggerLiveInspectOptions) (rehearsalExecTask, int, string) {
	f, ok := s.clusterFactsAny(clusterID)
	if !ok {
		return rehearsalExecTask{}, 404, tr(opts.Lang, "找不到该集群", "Cluster not found")
	}
	if activeID := s.activeLiveInspectTaskID(clusterID); activeID != "" {
		if existing, exists := s.findRehearsalExecTaskByID(activeID); exists {
			return existing, 200, ""
		}
	}
	cfg := s.loadClusterAutomationConfig(clusterID)
	var allTargets []rehearsalExecTarget
	for _, h := range s.clusterAutomationHostsFor(f, cfg) {
		if net.ParseIP(strings.TrimSpace(h.IP)) != nil {
			allTargets = append(allTargets, rehearsalExecTarget{Host: h.Name, IP: h.IP, Role: h.Role})
		}
	}
	if len(allTargets) == 0 {
		return rehearsalExecTask{}, 409, tr(opts.Lang, "该集群尚未登记有效的主机 IP，无法发起远程实测采集", "Cluster has no valid host IPs configured for live inspection")
	}

	chosenAgent, targets := s.selectBestClusterAgent(clusterID, opts.AgentID, allTargets)
	if chosenAgent == "" {
		return rehearsalExecTask{}, 409, tr(opts.Lang,
			"当前集群没有在线的已授权 Agent；请先在「执行节点 / Agent」关联在线 Agent，或使用离线探针脚本回贴",
			"No online authorized Agent is bound to this cluster; bind an online Agent or paste offline read-only probe output")
	}

	dep := s.readSpec(f.Current.ID)
	rec := s.loadClusterStateRecord(clusterID)
	script := buildLiveInspectScript(f, dep, rec.Overrides)

	return s.enqueueRehearsalExecTask(enqueueRehearsalTaskSpec{
		ClusterID:      clusterID,
		StepTitle:      tr(opts.Lang, "集群主机只读实况采集", "Cluster Live Read-Only Telemetry"),
		SubIndex:       -1,
		Kind:           "live_inspect",
		ReadOnly:       true,
		Script:         script,
		TimeoutSec:     120,
		Targets:        targets,
		AgentID:        chosenAgent,
		RememberChoice: opts.AgentID != "",
		NodeExecMethod: opts.NodeExecMethod,
		SSHUser:        opts.SSHUser,
		SSHPort:        opts.SSHPort,
		User:           firstNonEmptyStr(opts.User, "system"),
		Lang:           opts.Lang,
	})
}

func (s *storeServer) ingestCompletedLiveInspectTask(t rehearsalExecTask) {
	if t.Kind != "live_inspect" || t.ClusterID == "" {
		return
	}
	f, ok := s.clusterFactsAny(t.ClusterID)
	if !ok {
		return
	}
	dep := s.readSpec(f.Current.ID)
	totalHosts := len(t.Targets)
	if dep != nil && len(dep.Hosts) > totalHosts {
		totalHosts = len(dep.Hosts)
	}
	primaryPkgNames := map[string]bool{}
	if s.plat != nil {
		primaryPkgNames = buildMiddlewarePrimarySet(s.plat.cat())
	}

	incoming := clusterLiveSnapshot{
		Source:      clusterSourceLiveAgent,
		TaskID:      t.ID,
		AgentID:     t.NodeID,
		AgentName:   t.NodeName,
		CollectedAt: firstNonEmptyStr(t.FinishedAt, nowStamp()),
		CollectedBy: t.By,
		TotalHosts:  totalHosts,
		Hosts:       map[string]clusterHostLive{},
	}
	anySucceeded := false
	for _, res := range t.Results {
		if res.State != "succeeded" || strings.TrimSpace(res.Output) == "" {
			continue
		}
		anySucceeded = true
		hl := parseSingleHostInspectOutput(res.Host, res.IP, res.Output, f.Current.AppID, primaryPkgNames)
		key := firstNonEmptyStr(hl.IP, res.IP, hl.Host, res.Host)
		if key != "" {
			incoming.Hosts[key] = hl
		}
	}
	if !anySucceeded {
		return
	}

	rec := s.loadClusterStateRecord(f.ID)
	merged := mergeLiveSnapshotNonDestructive(rec.Live, incoming, totalHosts)
	drift := s.computeClusterDrift(f, rec.Overrides, merged)
	rec.Live = &merged
	rec.Drift = &drift
	rec.DataSource = clusterSourceLiveAgent
	rec.LastProbedAt = merged.CollectedAt
	_ = s.saveClusterStateRecord(rec)

	if dep != nil && dep.DeliveryMode == "imported" {
		s.syncLiveIntoImportedBaseline(f, merged, firstNonEmptyStr(t.By, "agent"))
	}
	if len(merged.Packages) > 0 && s.loadLatestScan() != nil {
		s.runSecurityScan("live-inspect", false)
	}
}

// ---- Background Auto-Inspection Scheduler ----

func (s *storeServer) hasActiveMutatingClusterWork(clusterID string) bool {
	for _, t := range s.listRehearsalExecTasks(clusterID, "", 10) {
		if rehearsalTaskActive(t.State) && (!t.ReadOnly || t.Kind == "live_inspect") {
			return true
		}
	}
	executionMu.Lock()
	d, err := s.readExecutions()
	executionMu.Unlock()
	if err == nil {
		for _, r := range d.Runs {
			if r.Cluster == clusterID && activeExecution(r) {
				return true
			}
		}
	}
	return false
}

func (s *storeServer) runAutoInspectTick() {
	owners := s.clusterOwners()
	now := time.Now()
	for cid := range owners {
		rec := s.loadClusterStateRecord(cid)
		if !rec.ProbePolicy.AutoInspectEnabled {
			continue
		}
		bound, online, _ := s.clusterAgentAvailability(cid)
		if !bound || !online {
			continue
		}
		interval := time.Duration(normalizeClusterProbePolicy(rec.ProbePolicy).AutoInspectIntervalSec) * time.Second
		if rec.LastProbedAt != "" {
			if lastT, err := time.Parse(time.RFC3339Nano, rec.LastProbedAt); err == nil {
				if now.Sub(lastT) < interval {
					continue
				}
			} else if lastT2, err2 := time.Parse(time.RFC3339, rec.LastProbedAt); err2 == nil {
				if now.Sub(lastT2) < interval {
					continue
				}
			}
		}
		if s.hasActiveMutatingClusterWork(cid) {
			continue
		}
		_, _, _ = s.triggerClusterLiveInspect(cid, triggerLiveInspectOptions{
			User:   "auto-scheduler",
			Reason: "scheduled",
			Lang:   "zh-CN",
		})
	}
}

func (s *storeServer) runAutoInspectLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runAutoInspectTick()
		}
	}
}

// ---- HTTP API: /api/clusters/{id}/live-state ----

func (s *storeServer) handleClusterLiveState(w http.ResponseWriter, r *http.Request, session storeSession, f clusterFacts, parts []string) {
	switch {
	case len(parts) == 0 && r.Method == "GET":
		view := s.buildClusterEffectiveView(f, f.Lang)
		out := map[string]any{
			"effective": view,
		}
		if view.Summary.ActiveInspectTaskID != "" {
			if tk, ok := s.findRehearsalExecTaskByID(view.Summary.ActiveInspectTaskID); ok {
				out["active_task"] = tk
			}
		}
		if r.URL.Query().Get("script") == "1" {
			dep := s.readSpec(f.Current.ID)
			out["inspect_script"] = buildLiveInspectScript(f, dep, view.Overrides)
		}
		s.writeJSON(w, 200, out)

	case len(parts) == 1 && parts[0] == "policy" && (r.Method == "PUT" || r.Method == "PATCH" || r.Method == "POST"):
		var in struct {
			AutoInspectEnabled     *bool `json:"auto_inspect_enabled"`
			AutoInspectIntervalSec *int  `json:"auto_inspect_interval_sec"`
			InspectOnBind          *bool `json:"inspect_on_bind"`
		}
		if decodeBody(w, r, 8192, &in) != nil {
			s.fail(w, 400, "请求格式错误")
			return
		}
		rec := s.loadClusterStateRecord(f.ID)
		if in.AutoInspectEnabled != nil {
			rec.ProbePolicy.AutoInspectEnabled = *in.AutoInspectEnabled
		}
		if in.AutoInspectIntervalSec != nil {
			rec.ProbePolicy.AutoInspectIntervalSec = *in.AutoInspectIntervalSec
		}
		if in.InspectOnBind != nil {
			rec.ProbePolicy.InspectOnBind = *in.InspectOnBind
		}
		rec.ProbePolicy = normalizeClusterProbePolicy(rec.ProbePolicy)
		if err := s.saveClusterStateRecord(rec); err != nil {
			s.fail(w, 500, "保存巡检策略失败")
			return
		}
		s.auditReq(r, "cluster-inspect-policy", session.User, fmt.Sprintf("%s enabled=%v interval=%ds on_bind=%v", f.ID, rec.ProbePolicy.AutoInspectEnabled, rec.ProbePolicy.AutoInspectIntervalSec, rec.ProbePolicy.InspectOnBind))
		s.writeJSON(w, 200, map[string]any{
			"probe_policy": rec.ProbePolicy,
			"effective":    s.buildClusterEffectiveView(f, f.Lang),
		})

	case len(parts) == 1 && parts[0] == "inspect" && r.Method == "POST":
		var in struct {
			AgentID        string `json:"agent_id"`
			NodeExecMethod string `json:"node_exec_method"`
			SSHUser        string `json:"ssh_user"`
			SSHPort        int    `json:"ssh_port"`
		}
		_ = decodeBody(w, r, 16384, &in)
		task, code, msg := s.triggerClusterLiveInspect(f.ID, triggerLiveInspectOptions{
			AgentID:        in.AgentID,
			NodeExecMethod: in.NodeExecMethod,
			SSHUser:        in.SSHUser,
			SSHPort:        in.SSHPort,
			User:           session.User,
			Reason:         "manual",
			Lang:           f.Lang,
		})
		if msg != "" {
			s.fail(w, code, msg)
			return
		}
		s.auditReq(r, "cluster-live-inspect", session.User, fmt.Sprintf("%s task=%s targets=%d", f.ID, task.ID, len(task.Targets)))
		s.writeJSON(w, 201, map[string]any{
			"task":      task,
			"effective": s.buildClusterEffectiveView(f, f.Lang),
		})

	case len(parts) == 1 && parts[0] == "parse-probe" && r.Method == "POST":
		var in struct {
			Host        string `json:"host"`
			IP          string `json:"ip"`
			ProbeOutput string `json:"probe_output"`
			RescanSec   bool   `json:"rescan_security"`
		}
		if decodeBody(w, r, 4<<20, &in) != nil {
			s.fail(w, 400, "提交格式错误")
			return
		}
		if strings.TrimSpace(in.ProbeOutput) == "" {
			s.failBi(w, 400, "请粘贴只读探针回显内容", "Please paste read-only probe output")
			return
		}
		dep := s.readSpec(f.Current.ID)
		totalHosts := 1
		hostName := strings.TrimSpace(in.Host)
		hostIP := strings.TrimSpace(in.IP)
		if dep != nil {
			if len(dep.Hosts) > 0 {
				totalHosts = len(dep.Hosts)
				if hostName == "" && hostIP == "" {
					hostName = dep.Hosts[0].Name
					hostIP = dep.Hosts[0].IP
				}
			}
		}
		primaryPkgNames := map[string]bool{}
		if s.plat != nil {
			primaryPkgNames = buildMiddlewarePrimarySet(s.plat.cat())
		}
		hl := parseSingleHostInspectOutput(hostName, hostIP, in.ProbeOutput, f.Current.AppID, primaryPkgNames)
		hk := firstNonEmptyStr(hl.IP, hl.Host, "probe-host")
		incoming := clusterLiveSnapshot{
			Source:      clusterSourceManualProbe,
			CollectedAt: nowStamp(),
			CollectedBy: session.User,
			TotalHosts:  totalHosts,
			Hosts:       map[string]clusterHostLive{hk: hl},
		}
		rec := s.loadClusterStateRecord(f.ID)
		merged := mergeLiveSnapshotNonDestructive(rec.Live, incoming, totalHosts)
		drift := s.computeClusterDrift(f, rec.Overrides, merged)
		rec.Live = &merged
		rec.Drift = &drift
		rec.DataSource = clusterSourceManualProbe
		rec.LastProbedAt = merged.CollectedAt
		if err := s.saveClusterStateRecord(rec); err != nil {
			s.fail(w, 500, "保存实测快照失败")
			return
		}
		if dep != nil && dep.DeliveryMode == "imported" {
			s.syncLiveIntoImportedBaseline(f, merged, session.User)
		}
		if in.RescanSec || (len(merged.Packages) > 0 && s.loadLatestScan() != nil) {
			s.runSecurityScan(session.User, false)
		}
		s.auditReq(r, "cluster-probe-ingest", session.User, fmt.Sprintf("%s host=%s pkgs=%d certs=%d", f.ID, hk, len(merged.Packages), len(merged.Certs)))
		s.writeJSON(w, 200, map[string]any{
			"effective": s.buildClusterEffectiveView(f, f.Lang),
		})

	case len(parts) == 1 && parts[0] == "accept-drift" && r.Method == "POST":
		var in struct {
			Keys []string `json:"keys"` // empty means accept all current param drifts
		}
		if decodeBody(w, r, 16384, &in) != nil {
			s.fail(w, 400, "请求格式错误")
			return
		}
		rec := s.loadClusterStateRecord(f.ID)
		if rec.Live == nil || rec.Drift == nil || len(rec.Drift.ParamDrifts) == 0 {
			s.writeJSON(w, 200, map[string]any{"effective": s.buildClusterEffectiveView(f, f.Lang)})
			return
		}
		wantKey := map[string]bool{}
		for _, k := range in.Keys {
			nk := normClusterParamKey(k)
			if nk != "" {
				wantKey[nk] = true
			}
		}
		if rec.Overrides.Params == nil {
			rec.Overrides.Params = map[string]string{}
		}
		now := nowStamp()
		accepted := 0
		for _, pd := range rec.Drift.ParamDrifts {
			nk := normClusterParamKey(pd.Key)
			if len(wantKey) > 0 && !wantKey[nk] {
				continue
			}
			rec.Overrides.Params[nk] = pd.Actual
			rec.Overrides.Entries = upsertOverrideEntry(rec.Overrides.Entries, clusterOverrideEntry{
				Key:         pd.Key,
				Before:      pd.Expected,
				After:       pd.Actual,
				SourceID:    "drift_accept",
				SourceTitle: tr(f.Lang, "采纳主机实测值", "Accepted Live Measurement"),
				By:          session.User,
				At:          now,
			})
			accepted++
		}
		rec.Overrides.UpdatedAt = now
		rec.Overrides.UpdatedBy = session.User
		d := s.computeClusterDrift(f, rec.Overrides, *rec.Live)
		rec.Drift = &d
		if err := s.saveClusterStateRecord(rec); err != nil {
			s.fail(w, 500, "保存基线更新失败")
			return
		}
		s.auditReq(r, "cluster-drift-accept", session.User, fmt.Sprintf("%s accepted=%d", f.ID, accepted))
		s.writeJSON(w, 200, map[string]any{
			"accepted":  accepted,
			"effective": s.buildClusterEffectiveView(f, f.Lang),
		})

	default:
		s.fail(w, 404, "接口不存在")
	}
}

package mwpack

import (
	"regexp"
	"strings"
)

// ImportRolePreset defines a default topology role for an onboarded brownfield middleware.
type ImportRolePreset struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	TitleEn string `json:"title_en"`
}

// ImportFlowPreset defines directional topology links between roles for InstanceGraph rendering.
type ImportFlowPreset struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label"`
	Kind  string `json:"kind,omitempty"` // replication | quorum | peer | traffic
}

// ImportPreset describes a common enterprise middleware supported for zero-playbook brownfield onboarding.
type ImportPreset struct {
	ID              string             `json:"id"`
	Name            string             `json:"name"`
	NameEn          string             `json:"name_en"`
	Category        string             `json:"category"` // database | cache | queue | search | storage | proxy | observability | runtime
	CategoryTitle   string             `json:"category_title"`
	CategoryTitleEn string             `json:"category_title_en"`
	Icon            string             `json:"icon"`
	Color           string             `json:"color"`
	Summary         string             `json:"summary"`
	SummaryEn       string             `json:"summary_en"`
	DefaultPort     int                `json:"default_port"`
	Roles           []ImportRolePreset `json:"roles"`
	Flows           []ImportFlowPreset `json:"flows,omitempty"`
	ServiceHints    []string           `json:"service_hints,omitempty"`
	ConfigHints     []string           `json:"config_hints,omitempty"`
	DataHints       []string           `json:"data_hints,omitempty"`
	LogHints        []string           `json:"log_hints,omitempty"`
	PkgMatch        string             `json:"pkg_match,omitempty"`     // regex fragment for dpkg/rpm filtering
	ProbeSnippet    string             `json:"probe_snippet,omitempty"` // 100% read-only bash snippet
}

// ImportPresets lists 36 common enterprise middleware presets aligned with ComponentIcons & brandlogos.tsx.
var ImportPresets = []ImportPreset{
	// ---- Databases ----
	{
		ID: "postgresql", Name: "PostgreSQL", NameEn: "PostgreSQL",
		Category: "database", CategoryTitle: "数据库", CategoryTitleEn: "Database",
		Icon: "postgresql", Color: "blue", DefaultPort: 5432,
		Summary: "开源关系型数据库（单机 / 原生流复制 / Patroni 高可用）", SummaryEn: "Open-source relational database (Standalone / Streaming Replication / Patroni HA)",
		Roles: []ImportRolePreset{
			{ID: "primary", Title: "主库", TitleEn: "Primary"},
			{ID: "replica", Title: "从库", TitleEn: "Replica"},
			{ID: "arbiter", Title: "仲裁/DCS", TitleEn: "Arbiter/DCS"},
		},
		Flows:        []ImportFlowPreset{{From: "primary", To: "replica", Label: "流复制", Kind: "replication"}},
		ServiceHints: []string{"patroni", "postgresql"},
		ConfigHints:  []string{"/etc/patroni/patroni.yml", "/etc/postgresql/*/main/postgresql.conf", "/var/lib/pgsql/*/data/postgresql.conf"},
		DataHints:    []string{"/data/pg", "/var/lib/postgresql", "/var/lib/pgsql"},
		LogHints:     []string{"/var/log/postgresql", "/data/logs/postgresql"},
		PkgMatch:     "postgres|patroni|pgbackrest|pgbouncer|percona-postgresql|etcd|haproxy|keepalived",
		ProbeSnippet: `echo "--- [POSTGRESQL / PATRONI / ETCD] ---"
command -v psql >/dev/null 2>&1 && psql --version || true
for b in /usr/lib/postgresql/*/bin/postgres /usr/pgsql-*/bin/postgres; do [ -x "$b" ] && "$b" --version; done 2>/dev/null || true
ps -ef 2>/dev/null | grep -E 'postgres.*-D|patroni' | grep -v grep | head -n 10 || true
PG_D_PROC="$(ps -eo args 2>/dev/null | grep -E 'postgres.*-D[[:space:]]+/' | grep -v grep | sed -nE 's/.*-D[[:space:]]+([^[:space:]]+).*/\1/p' | head -n 1 || true)"
[ -n "$PG_D_PROC" ] && echo "PG_DATA_DIR=$PG_D_PROC"
PATRONI_CFG=""
for cand in /etc/patroni/patroni.yml /etc/patroni/patroni.yaml /etc/patroni.yml /data/patroni/patroni.yml; do
  [ -r "$cand" ] && { PATRONI_CFG="$cand"; break; }
done
if [ -z "$PATRONI_CFG" ]; then
  PATRONI_CFG="$(systemctl show patroni -p ExecStart --no-pager 2>/dev/null | grep -oE '/[^[:space:];"]+patroni[^[:space:];"]*\.ya?ml' | head -n 1 || true)"
fi
if [ -z "$PATRONI_CFG" ]; then
  PATRONI_CFG="$(ps -eo args 2>/dev/null | grep -i patroni | grep -v grep | grep -oE '/[^[:space:];"]+\.ya?ml' | head -n 1 || true)"
fi
if [ -n "$PATRONI_CFG" ] && [ -r "$PATRONI_CFG" ]; then
  echo "# file: $PATRONI_CFG"
  grep -iE '^\s*(scope|name|data_dir|config_dir|bin_dir|listen|connect_address|hosts|log_directory|logging_collector|max_connections|shared_buffers|wal_level|ssl|ssl_cert_file|synchronous_mode|synchronous_node_count|use_pg_rewind|loop_wait|ttl|retry_timeout):' "$PATRONI_CFG" | grep -viE 'pass|secret|token|key|auth' | head -n 45 || true
fi
if [ -n "$PG_D_PROC" ]; then
  for pcf in "$PG_D_PROC/postgresql.conf" "$PG_D_PROC/postgresql.base.conf"; do
    if [ -r "$pcf" ]; then
      echo "PG_CONFIG_FILE=$pcf"
      echo "# file: $pcf"
      grep -iE '^\s*(port|max_connections|shared_buffers|wal_level|log_directory|logging_collector|ssl|ssl_cert_file|archive_mode|archive_command)\s*=' "$pcf" | grep -viE 'pass|secret|token|key' | head -n 25 || true
    fi
  done
fi
if command -v patronictl >/dev/null 2>&1; then
  patronictl version 2>/dev/null || true
  [ -n "$PATRONI_CFG" ] && [ -r "$PATRONI_CFG" ] && patronictl -c "$PATRONI_CFG" list 2>/dev/null || true
fi
if command -v psql >/dev/null 2>&1; then
  sudo -n -u postgres psql -X -w -Atc "SELECT 'PG_DATA_DIR='||setting FROM pg_settings WHERE name='data_directory' UNION ALL SELECT 'PG_CONFIG_FILE='||setting FROM pg_settings WHERE name='config_file' UNION ALL SELECT 'PG_LOG_DIR='||setting FROM pg_settings WHERE name='log_directory' UNION ALL SELECT 'PG_MAX_CONN='||setting FROM pg_settings WHERE name='max_connections' UNION ALL SELECT 'PG_SHARED_BUFFERS='||setting FROM pg_settings WHERE name='shared_buffers' UNION ALL SELECT 'PG_WAL_LEVEL='||setting FROM pg_settings WHERE name='wal_level' UNION ALL SELECT 'PG_SSL='||setting FROM pg_settings WHERE name='ssl';" 2>/dev/null || true
fi
command -v etcd >/dev/null 2>&1 && etcd --version 2>/dev/null | head -n 3 || true
for ef in /etc/etcd/etcd.conf.yaml /etc/etcd/etcd.conf.yml /etc/etcd/etcd.conf; do
  [ -r "$ef" ] && { echo "# file: $ef"; grep -vE '^\s*(#|$|.*pass|.*secret|.*token|.*key)' "$ef" | head -n 30; }
done
command -v etcdctl >/dev/null 2>&1 && ETCDCTL_API=3 etcdctl member list 2>/dev/null || true
if command -v pgbackrest >/dev/null 2>&1; then
  pgbackrest version 2>/dev/null || true
  for bf in /etc/pgbackrest/pgbackrest.conf /etc/pgbackrest.conf; do
    [ -r "$bf" ] && { echo "# file: $bf"; grep -vE '^\s*(#|$|.*pass|.*secret|.*token|.*key)' "$bf" | head -n 25; }
  done
  sudo -n -u postgres pgbackrest info 2>/dev/null | head -n 20 || pgbackrest info 2>/dev/null | head -n 20 || true
fi
command -v pgbouncer >/dev/null 2>&1 && pgbouncer --version 2>/dev/null | head -n 2 || true
for cert in /etc/patroni/*.crt /etc/etcd/*.crt /etc/postgresql/*/*/*.crt "${PG_D_PROC:-/nonexistent}"/*.crt; do
  [ -r "$cert" ] && command -v openssl >/dev/null 2>&1 && echo "CERT=$cert $(openssl x509 -in "$cert" -noout -enddate 2>/dev/null || true)"
done 2>/dev/null | head -n 6 || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'patroni|postgres|etcd|pgbouncer|haproxy|keepalived' || true`,
	},
	{
		ID: "mysql", Name: "MySQL", NameEn: "MySQL",
		Category: "database", CategoryTitle: "数据库", CategoryTitleEn: "Database",
		Icon: "mysql", Color: "blue", DefaultPort: 3306,
		Summary: "主流关系型数据库（主从复制 / MGR / MHA / InnoDB Cluster）", SummaryEn: "Relational database (Primary-Replica / MGR / MHA / InnoDB Cluster)",
		Roles: []ImportRolePreset{
			{ID: "primary", Title: "主库", TitleEn: "Primary"},
			{ID: "replica", Title: "从库", TitleEn: "Replica"},
			{ID: "router", Title: "路由/代理", TitleEn: "Router/Proxy"},
		},
		Flows:        []ImportFlowPreset{{From: "primary", To: "replica", Label: "Binlog 复制", Kind: "replication"}},
		ServiceHints: []string{"mysqld", "mysql"},
		ConfigHints:  []string{"/etc/my.cnf", "/etc/mysql/mysql.conf.d/mysqld.cnf"},
		DataHints:    []string{"/var/lib/mysql", "/data/mysql"},
		LogHints:     []string{"/var/log/mysql", "/var/log/mysqld.log"},
		PkgMatch:     "mysql|percona-server|proxysql|orchestrator",
		ProbeSnippet: `echo "--- [MYSQL] ---"
command -v mysqld >/dev/null 2>&1 && mysqld --version || true
command -v mysql >/dev/null 2>&1 && mysql --version || true
for f in /etc/my.cnf /etc/mysql/my.cnf /etc/mysql/mysql.conf.d/mysqld.cnf; do
  [ -r "$f" ] && { echo "# file: $f"; grep -vE '^\s*(#|;|password|pass\s*=)' "$f" | head -n 40; }
done
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'mysql|proxysql|mha' || true`,
	},
	{
		ID: "mariadb", Name: "MariaDB", NameEn: "MariaDB",
		Category: "database", CategoryTitle: "数据库", CategoryTitleEn: "Database",
		Icon: "mariadb", Color: "indigo", DefaultPort: 3306,
		Summary: "兼容 MySQL 生态的关系型数据库（主从 / Galera 多主集群）", SummaryEn: "MySQL-compatible RDBMS (Primary-Replica / Galera Cluster)",
		Roles: []ImportRolePreset{
			{ID: "primary", Title: "主库", TitleEn: "Primary"},
			{ID: "replica", Title: "从库", TitleEn: "Replica"},
			{ID: "member", Title: "Galera 成员", TitleEn: "Galera Member"},
		},
		Flows:        []ImportFlowPreset{{From: "primary", To: "replica", Label: "复制", Kind: "replication"}},
		ServiceHints: []string{"mariadb"},
		ConfigHints:  []string{"/etc/my.cnf", "/etc/mysql/mariadb.conf.d/50-server.cnf"},
		DataHints:    []string{"/var/lib/mysql", "/data/mariadb"},
		LogHints:     []string{"/var/log/mariadb", "/var/log/mysql"},
		PkgMatch:     "mariadb|galera|maxscale",
		ProbeSnippet: `echo "--- [MARIADB] ---"
command -v mariadbd >/dev/null 2>&1 && mariadbd --version || true
command -v mysqld >/dev/null 2>&1 && mysqld --version || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'mariadb|maxscale' || true`,
	},
	{
		ID: "mongodb", Name: "MongoDB", NameEn: "MongoDB",
		Category: "database", CategoryTitle: "数据库", CategoryTitleEn: "Database",
		Icon: "mongodb", Color: "green", DefaultPort: 27017,
		Summary: "文档型 NoSQL 数据库（副本集 ReplicaSet / 分片集群 Sharded）", SummaryEn: "Document NoSQL database (ReplicaSet / Sharded Cluster)",
		Roles: []ImportRolePreset{
			{ID: "primary", Title: "主节点", TitleEn: "Primary"},
			{ID: "secondary", Title: "从节点", TitleEn: "Secondary"},
			{ID: "arbiter", Title: "仲裁节点", TitleEn: "Arbiter"},
			{ID: "mongos", Title: "路由 mongos", TitleEn: "Router mongos"},
		},
		Flows:        []ImportFlowPreset{{From: "primary", To: "secondary", Label: "Oplog 复制", Kind: "replication"}},
		ServiceHints: []string{"mongod", "mongos"},
		ConfigHints:  []string{"/etc/mongod.conf"},
		DataHints:    []string{"/var/lib/mongodb", "/data/mongodb"},
		LogHints:     []string{"/var/log/mongodb"},
		PkgMatch:     "mongodb|mongod|mongosh",
		ProbeSnippet: `echo "--- [MONGODB] ---"
command -v mongod >/dev/null 2>&1 && mongod --version | head -n 5 || true
[ -r /etc/mongod.conf ] && grep -vE '^\s*(#|.*password|.*keyFile)' /etc/mongod.conf | head -n 45 || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'mongo' || true`,
	},
	{
		ID: "clickhouse", Name: "ClickHouse", NameEn: "ClickHouse",
		Category: "database", CategoryTitle: "数据库", CategoryTitleEn: "Database",
		Icon: "clickhouse", Color: "amber", DefaultPort: 9000,
		Summary: "高性能列式 OLAP 分析型数据库（分片副本 + Keeper/ZK）", SummaryEn: "Column-oriented OLAP database (Shards & Replicas + Keeper)",
		Roles: []ImportRolePreset{
			{ID: "shard", Title: "分片节点", TitleEn: "Shard Node"},
			{ID: "keeper", Title: "Keeper 协调节点", TitleEn: "Keeper Node"},
		},
		Flows:        []ImportFlowPreset{{From: "shard", To: "keeper", Label: "元数据协同", Kind: "quorum"}},
		ServiceHints: []string{"clickhouse-server", "clickhouse-keeper"},
		ConfigHints:  []string{"/etc/clickhouse-server/config.xml", "/etc/clickhouse-server/config.d/"},
		DataHints:    []string{"/var/lib/clickhouse", "/data/clickhouse"},
		LogHints:     []string{"/var/log/clickhouse-server"},
		PkgMatch:     "clickhouse",
		ProbeSnippet: `echo "--- [CLICKHOUSE] ---"
command -v clickhouse-server >/dev/null 2>&1 && clickhouse-server --version || true
command -v clickhouse-client >/dev/null 2>&1 && clickhouse-client --version || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'clickhouse' || true`,
	},
	{
		ID: "tidb", Name: "TiDB", NameEn: "TiDB",
		Category: "database", CategoryTitle: "数据库", CategoryTitleEn: "Database",
		Icon: "tidb", Color: "red", DefaultPort: 4000,
		Summary: "分布式 HTAP 数据库（TiDB / TiKV / PD / TiFlash）", SummaryEn: "Distributed HTAP database (TiDB / TiKV / PD / TiFlash)",
		Roles: []ImportRolePreset{
			{ID: "tidb", Title: "TiDB 计算", TitleEn: "TiDB SQL"},
			{ID: "pd", Title: "PD 调度", TitleEn: "PD"},
			{ID: "tikv", Title: "TiKV 存储", TitleEn: "TiKV"},
			{ID: "tiflash", Title: "TiFlash 分析", TitleEn: "TiFlash"},
		},
		Flows:        []ImportFlowPreset{{From: "tidb", To: "tikv", Label: "读写存储", Kind: "traffic"}, {From: "tidb", To: "pd", Label: "路由调度", Kind: "quorum"}},
		ServiceHints: []string{"tidb-4000", "pd-2379", "tikv-20160"},
		ConfigHints:  []string{"/tidb-deploy/*/conf/"},
		DataHints:    []string{"/tidb-data", "/data/tidb"},
		LogHints:     []string{"/tidb-deploy/*/log"},
		PkgMatch:     "tidb|tikv|pd-server",
		ProbeSnippet: `echo "--- [TIDB] ---"
command -v tiup >/dev/null 2>&1 && tiup cluster list 2>/dev/null || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'tidb|tikv|pd-|tiflash' || true`,
	},
	{
		ID: "oracle", Name: "Oracle Database", NameEn: "Oracle Database",
		Category: "database", CategoryTitle: "数据库", CategoryTitleEn: "Database",
		Icon: "database", Color: "red", DefaultPort: 1521,
		Summary: "企业级关系型数据库（单实例 / Data Guard / RAC）", SummaryEn: "Enterprise relational database (Single / Data Guard / RAC)",
		Roles: []ImportRolePreset{
			{ID: "primary", Title: "主库", TitleEn: "Primary"},
			{ID: "standby", Title: "备库 (DG)", TitleEn: "Standby (DG)"},
			{ID: "rac", Title: "RAC 节点", TitleEn: "RAC Node"},
		},
		Flows:        []ImportFlowPreset{{From: "primary", To: "standby", Label: "Redo 同步", Kind: "replication"}},
		ServiceHints: []string{"oracle-xe", "ohasd"},
		ConfigHints:  []string{"$ORACLE_HOME/dbs/init*.ora", "$ORACLE_HOME/network/admin/listener.ora"},
		DataHints:    []string{"/u01/app/oracle/oradata", "/oradata"},
		LogHints:     []string{"/u01/app/oracle/diag"},
		PkgMatch:     "oracle-database|oracle-instantclient",
		ProbeSnippet: `echo "--- [ORACLE] ---"
ps -ef | grep -E 'ora_pmon|tnslsnr' | grep -v grep || true
command -v lsnrctl >/dev/null 2>&1 && lsnrctl status 2>/dev/null | head -n 30 || true`,
	},
	{
		ID: "dm", Name: "达梦数据库 (DM8)", NameEn: "Dameng DM8",
		Category: "database", CategoryTitle: "数据库", CategoryTitleEn: "Database",
		Icon: "database", Color: "indigo", DefaultPort: 5236,
		Summary: "国产关系型数据库（单机 / 数据守护主备 / DSC 共享集群）", SummaryEn: "Dameng DM8 RDBMS (Standalone / Data Watch / DSC)",
		Roles: []ImportRolePreset{
			{ID: "primary", Title: "主库", TitleEn: "Primary"},
			{ID: "standby", Title: "备库", TitleEn: "Standby"},
			{ID: "monitor", Title: "监视器", TitleEn: "Monitor"},
		},
		Flows:        []ImportFlowPreset{{From: "primary", To: "standby", Label: "数据守护", Kind: "replication"}},
		ServiceHints: []string{"DmServiceDMSERVER", "DmWatcherServiceWatcher"},
		ConfigHints:  []string{"/dmdata/DAMENG/dm.ini", "/dmdata/DAMENG/dmwatcher.ini"},
		DataHints:    []string{"/dmdata", "/data/dmdata"},
		LogHints:     []string{"/opt/dmdbms/log"},
		PkgMatch:     "dmdbms|dm8",
		ProbeSnippet: `echo "--- [DAMENG DM8] ---"
ps -ef | grep -iE 'dmserver|dmwatcher|dmmonitor' | grep -v grep || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'DmService|DmWatcher|DmMonitor' || true`,
	},
	{
		ID: "kingbase", Name: "人大金仓 (KingbaseES)", NameEn: "KingbaseES",
		Category: "database", CategoryTitle: "数据库", CategoryTitleEn: "Database",
		Icon: "database", Color: "blue", DefaultPort: 54321,
		Summary: "国产企业级数据库（主备读写分离集群 / repmgrd）", SummaryEn: "KingbaseES Enterprise RDBMS (Primary-Standby HA)",
		Roles: []ImportRolePreset{
			{ID: "primary", Title: "主库", TitleEn: "Primary"},
			{ID: "standby", Title: "备库", TitleEn: "Standby"},
		},
		Flows:        []ImportFlowPreset{{From: "primary", To: "standby", Label: "流复制", Kind: "replication"}},
		ServiceHints: []string{"kingbase8d", "repmgrd"},
		ConfigHints:  []string{"/data/kingbase/data/kingbase.conf", "/home/kingbase/cluster/*/kingbase/etc/repmgr.conf"},
		DataHints:    []string{"/data/kingbase", "/opt/Kingbase/ES"},
		LogHints:     []string{"/data/kingbase/data/sys_log"},
		PkgMatch:     "kingbase",
		ProbeSnippet: `echo "--- [KINGBASE] ---"
ps -ef | grep -iE 'kingbase|repmgrd' | grep -v grep || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'kingbase|repmgr' || true`,
	},
	{
		ID: "oceanbase", Name: "OceanBase", NameEn: "OceanBase",
		Category: "database", CategoryTitle: "数据库", CategoryTitleEn: "Database",
		Icon: "database", Color: "teal", DefaultPort: 2881,
		Summary: "分布式关系型数据库（OBServer 三副本 + OBProxy）", SummaryEn: "Distributed RDBMS (OBServer + OBProxy)",
		Roles: []ImportRolePreset{
			{ID: "observer", Title: "OBServer 节点", TitleEn: "OBServer"},
			{ID: "obproxy", Title: "OBProxy 代理", TitleEn: "OBProxy"},
		},
		Flows:        []ImportFlowPreset{{From: "obproxy", To: "observer", Label: "路由代理", Kind: "traffic"}},
		ServiceHints: []string{"oceanbase", "obproxy"},
		ConfigHints:  []string{"/home/admin/oceanbase/etc/observer.config.bin"},
		DataHints:    []string{"/data/1", "/data/log1"},
		LogHints:     []string{"/home/admin/oceanbase/log"},
		PkgMatch:     "oceanbase|obproxy",
		ProbeSnippet: `echo "--- [OCEANBASE] ---"
ps -ef | grep -iE 'observer|obproxy' | grep -v grep || true
command -v obd >/dev/null 2>&1 && obd cluster list 2>/dev/null || true`,
	},

	// ---- Cache / KV / Coordination ----
	{
		ID: "redis", Name: "Redis", NameEn: "Redis",
		Category: "cache", CategoryTitle: "缓存与协调", CategoryTitleEn: "Cache & Coordination",
		Icon: "redis", Color: "red", DefaultPort: 6379,
		Summary: "内存键值数据库（单机 / 主从哨兵 Sentinel / Cluster 分片）", SummaryEn: "In-memory KV store (Standalone / Sentinel HA / Cluster)",
		Roles: []ImportRolePreset{
			{ID: "primary", Title: "主节点", TitleEn: "Primary"},
			{ID: "replica", Title: "从节点", TitleEn: "Replica"},
			{ID: "sentinel", Title: "哨兵节点", TitleEn: "Sentinel"},
		},
		Flows:        []ImportFlowPreset{{From: "primary", To: "replica", Label: "主从复制", Kind: "replication"}},
		ServiceHints: []string{"redis-server", "redis-sentinel", "redis"},
		ConfigHints:  []string{"/etc/redis/redis.conf", "/etc/redis/sentinel.conf", "/etc/redis.conf"},
		DataHints:    []string{"/var/lib/redis", "/data/redis"},
		LogHints:     []string{"/var/log/redis"},
		PkgMatch:     "redis",
		ProbeSnippet: `echo "--- [REDIS] ---"
command -v redis-server >/dev/null 2>&1 && redis-server --version || true
for f in /etc/redis/redis.conf /etc/redis.conf /etc/redis/sentinel.conf; do
  [ -r "$f" ] && { echo "# file: $f"; grep -vE '^\s*(#|$|requirepass|masterauth|sentinel auth-pass|user )' "$f" | head -n 40; }
done
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'redis' || true`,
	},
	{
		ID: "valkey", Name: "Valkey", NameEn: "Valkey",
		Category: "cache", CategoryTitle: "缓存与协调", CategoryTitleEn: "Cache & Coordination",
		Icon: "valkey", Color: "indigo", DefaultPort: 6379,
		Summary: "开源社区分支内存键值存储（完全兼容 Redis 协议）", SummaryEn: "Open-source Redis-compatible in-memory datastore",
		Roles: []ImportRolePreset{
			{ID: "primary", Title: "主节点", TitleEn: "Primary"},
			{ID: "replica", Title: "从节点", TitleEn: "Replica"},
			{ID: "sentinel", Title: "哨兵节点", TitleEn: "Sentinel"},
		},
		Flows:        []ImportFlowPreset{{From: "primary", To: "replica", Label: "复制", Kind: "replication"}},
		ServiceHints: []string{"valkey-server", "valkey-sentinel"},
		ConfigHints:  []string{"/etc/valkey/valkey.conf"},
		DataHints:    []string{"/var/lib/valkey", "/data/valkey"},
		LogHints:     []string{"/var/log/valkey"},
		PkgMatch:     "valkey",
		ProbeSnippet: `echo "--- [VALKEY] ---"
command -v valkey-server >/dev/null 2>&1 && valkey-server --version || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'valkey' || true`,
	},
	{
		ID: "memcached", Name: "Memcached", NameEn: "Memcached",
		Category: "cache", CategoryTitle: "缓存与协调", CategoryTitleEn: "Cache & Coordination",
		Icon: "memcached", Color: "teal", DefaultPort: 11211,
		Summary: "轻量级分布式内存对象缓存系统", SummaryEn: "Lightweight distributed memory object caching system",
		Roles:        []ImportRolePreset{{ID: "node", Title: "缓存节点", TitleEn: "Cache Node"}},
		ServiceHints: []string{"memcached"},
		ConfigHints:  []string{"/etc/memcached.conf", "/etc/sysconfig/memcached"},
		DataHints:    []string{},
		LogHints:     []string{"/var/log/memcached.log"},
		PkgMatch:     "memcached",
		ProbeSnippet: `echo "--- [MEMCACHED] ---"
command -v memcached >/dev/null 2>&1 && memcached -h | head -n 2 || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'memcached' || true`,
	},
	{
		ID: "etcd", Name: "etcd", NameEn: "etcd",
		Category: "cache", CategoryTitle: "缓存与协调", CategoryTitleEn: "Cache & Coordination",
		Icon: "etcd", Color: "blue", DefaultPort: 2379,
		Summary: "分布式强一致键值存储与 Raft 共识协调服务", SummaryEn: "Distributed reliable Raft key-value store & DCS",
		Roles:        []ImportRolePreset{{ID: "member", Title: "成员节点", TitleEn: "Member"}},
		Flows:        []ImportFlowPreset{{From: "member", To: "member", Label: "Raft 共识", Kind: "quorum"}},
		ServiceHints: []string{"etcd"},
		ConfigHints:  []string{"/etc/etcd/etcd.conf.yaml", "/etc/etcd/etcd.conf"},
		DataHints:    []string{"/data/etcd", "/var/lib/etcd"},
		LogHints:     []string{"/var/log/etcd"},
		PkgMatch:     "etcd",
		ProbeSnippet: `echo "--- [ETCD] ---"
command -v etcd >/dev/null 2>&1 && etcd --version | head -n 4 || true
command -v etcdctl >/dev/null 2>&1 && { etcdctl version | head -n 4 || true; ETCDCTL_API=3 etcdctl member list 2>/dev/null || true; }
for ef in /etc/etcd/etcd.conf.yaml /etc/etcd/etcd.conf.yml /etc/etcd/etcd.conf; do
  [ -r "$ef" ] && { echo "# file: $ef"; grep -vE '^\s*(#|$|.*pass|.*secret|.*token|.*key)' "$ef" | head -n 35; }
done
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'etcd' || true`,
	},
	{
		ID: "patroni", Name: "Patroni", NameEn: "Patroni",
		Category: "cache", CategoryTitle: "缓存与协调", CategoryTitleEn: "Cache & Coordination",
		Icon: "patroni", Color: "blue", DefaultPort: 8008,
		Summary: "PostgreSQL 高可用自动故障切换与生命周期管理器", SummaryEn: "PostgreSQL high-availability failover and lifecycle manager",
		Roles: []ImportRolePreset{
			{ID: "primary", Title: "主控", TitleEn: "Leader"},
			{ID: "replica", Title: "备控", TitleEn: "Standby"},
		},
		ServiceHints: []string{"patroni"},
		ConfigHints:  []string{"/etc/patroni/patroni.yml"},
		DataHints:    []string{},
		LogHints:     []string{"/var/log/patroni"},
		PkgMatch:     "patroni|etcd|postgres",
		ProbeSnippet: `echo "--- [PATRONI] ---"
command -v patronictl >/dev/null 2>&1 && { patronictl version 2>/dev/null || true; [ -r /etc/patroni/patroni.yml ] && patronictl -c /etc/patroni/patroni.yml list 2>/dev/null || true; }
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'patroni|etcd|postgres' || true`,
	},
	{
		ID: "consul", Name: "Consul", NameEn: "Consul",
		Category: "cache", CategoryTitle: "缓存与协调", CategoryTitleEn: "Cache & Coordination",
		Icon: "consul", Color: "pink", DefaultPort: 8500,
		Summary: "服务发现、健康检查与分布式配置中心", SummaryEn: "Service discovery, health checking, and KV configuration",
		Roles: []ImportRolePreset{
			{ID: "server", Title: "Server 节点", TitleEn: "Server"},
			{ID: "client", Title: "Client 节点", TitleEn: "Client"},
		},
		Flows:        []ImportFlowPreset{{From: "server", To: "server", Label: "Raft 同步", Kind: "quorum"}},
		ServiceHints: []string{"consul"},
		ConfigHints:  []string{"/etc/consul.d/consul.hcl"},
		DataHints:    []string{"/opt/consul", "/var/lib/consul"},
		LogHints:     []string{"/var/log/consul"},
		PkgMatch:     "consul",
		ProbeSnippet: `echo "--- [CONSUL] ---"
command -v consul >/dev/null 2>&1 && { consul version; consul members 2>/dev/null || true; }
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'consul' || true`,
	},
	{
		ID: "zookeeper", Name: "ZooKeeper", NameEn: "ZooKeeper",
		Category: "cache", CategoryTitle: "缓存与协调", CategoryTitleEn: "Cache & Coordination",
		Icon: "zookeeper", Color: "amber", DefaultPort: 2181,
		Summary: "分布式协调、选举与配置同步服务", SummaryEn: "Distributed coordination and leader election service",
		Roles:        []ImportRolePreset{{ID: "node", Title: "集群节点", TitleEn: "Ensemble Node"}},
		Flows:        []ImportFlowPreset{{From: "node", To: "node", Label: "ZAB 共识", Kind: "quorum"}},
		ServiceHints: []string{"zookeeper"},
		ConfigHints:  []string{"/etc/zookeeper/conf/zoo.cfg", "/opt/zookeeper/conf/zoo.cfg"},
		DataHints:    []string{"/var/lib/zookeeper", "/data/zookeeper"},
		LogHints:     []string{"/var/log/zookeeper"},
		PkgMatch:     "zookeeper|openjdk|java",
		ProbeSnippet: `echo "--- [ZOOKEEPER] ---"
ps -ef | grep -i QuorumPeerMain | grep -v grep || true
for f in /etc/zookeeper/conf/zoo.cfg /opt/zookeeper/conf/zoo.cfg; do [ -r "$f" ] && { echo "# file: $f"; grep -vE '^\s*(#|$)' "$f"; }; done`,
	},

	// ---- Message Queues ----
	{
		ID: "kafka", Name: "Apache Kafka", NameEn: "Apache Kafka",
		Category: "queue", CategoryTitle: "消息队列", CategoryTitleEn: "Message Queue",
		Icon: "kafka", Color: "slate", DefaultPort: 9092,
		Summary: "高吞吐分布式事件流与消息中间件（KRaft / ZooKeeper 模式）", SummaryEn: "Distributed event streaming platform (KRaft / ZooKeeper)",
		Roles: []ImportRolePreset{
			{ID: "broker", Title: "Broker 节点", TitleEn: "Broker"},
			{ID: "controller", Title: "Controller / ZK", TitleEn: "Controller / ZK"},
		},
		Flows:        []ImportFlowPreset{{From: "broker", To: "controller", Label: "元数据协同", Kind: "quorum"}},
		ServiceHints: []string{"kafka", "kafka-server"},
		ConfigHints:  []string{"/etc/kafka/server.properties", "/opt/kafka/config/server.properties", "/opt/kafka/config/kraft/server.properties"},
		DataHints:    []string{"/data/kafka-logs", "/var/lib/kafka"},
		LogHints:     []string{"/var/log/kafka", "/opt/kafka/logs"},
		PkgMatch:     "kafka|confluent|openjdk|java",
		ProbeSnippet: `echo "--- [KAFKA] ---"
ps -ef | grep -i 'kafka\.Kafka' | grep -v grep || true
for f in /etc/kafka/server.properties /opt/kafka/config/server.properties /opt/kafka/config/kraft/server.properties; do
  [ -r "$f" ] && { echo "# file: $f"; grep -vE '^\s*(#|$|.*password|.*secret)' "$f" | head -n 45; }
done
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'kafka|zookeeper' || true`,
	},
	{
		ID: "rabbitmq", Name: "RabbitMQ", NameEn: "RabbitMQ",
		Category: "queue", CategoryTitle: "消息队列", CategoryTitleEn: "Message Queue",
		Icon: "rabbitmq", Color: "coral", DefaultPort: 5672,
		Summary: "企业级 AMQP 消息代理（镜像队列 / Quorum 仲裁队列集群）", SummaryEn: "Enterprise AMQP message broker (Cluster / Quorum Queues)",
		Roles: []ImportRolePreset{
			{ID: "disc", Title: "磁盘节点", TitleEn: "Disc Node"},
			{ID: "ram", Title: "内存节点", TitleEn: "RAM Node"},
		},
		Flows:        []ImportFlowPreset{{From: "disc", To: "disc", Label: "Erlang 集群", Kind: "peer"}},
		ServiceHints: []string{"rabbitmq-server"},
		ConfigHints:  []string{"/etc/rabbitmq/rabbitmq.conf", "/etc/rabbitmq/advanced.config"},
		DataHints:    []string{"/var/lib/rabbitmq", "/data/rabbitmq"},
		LogHints:     []string{"/var/log/rabbitmq"},
		PkgMatch:     "rabbitmq|erlang",
		ProbeSnippet: `echo "--- [RABBITMQ] ---"
command -v rabbitmqctl >/dev/null 2>&1 && { rabbitmqctl version 2>/dev/null || true; rabbitmqctl cluster_status 2>/dev/null | head -n 40 || true; }
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'rabbitmq' || true`,
	},
	{
		ID: "rocketmq", Name: "Apache RocketMQ", NameEn: "Apache RocketMQ",
		Category: "queue", CategoryTitle: "消息队列", CategoryTitleEn: "Message Queue",
		Icon: "rocketmq", Color: "amber", DefaultPort: 9876,
		Summary: "金融级分布式事务消息与流计算平台（NameServer + Broker）", SummaryEn: "Distributed messaging & streaming platform (NameServer + Broker)",
		Roles: []ImportRolePreset{
			{ID: "namesrv", Title: "NameServer", TitleEn: "NameServer"},
			{ID: "broker", Title: "Broker 主从", TitleEn: "Broker"},
		},
		Flows:        []ImportFlowPreset{{From: "broker", To: "namesrv", Label: "路由注册", Kind: "quorum"}},
		ServiceHints: []string{"rocketmq-namesrv", "rocketmq-broker"},
		ConfigHints:  []string{"/opt/rocketmq/conf/broker.conf"},
		DataHints:    []string{"/data/rocketmq/store", "/root/store"},
		LogHints:     []string{"/root/logs/rocketmqlogs", "/var/log/rocketmq"},
		PkgMatch:     "rocketmq|openjdk|java",
		ProbeSnippet: `echo "--- [ROCKETMQ] ---"
ps -ef | grep -iE 'NamesrvStartup|BrokerStartup' | grep -v grep || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'rocketmq' || true`,
	},
	{
		ID: "activemq", Name: "ActiveMQ / Artemis", NameEn: "ActiveMQ / Artemis",
		Category: "queue", CategoryTitle: "消息队列", CategoryTitleEn: "Message Queue",
		Icon: "queue", Color: "pink", DefaultPort: 61616,
		Summary: "JMS/AMQP 多协议消息中间件（Classic / Artemis 高可用）", SummaryEn: "Multi-protocol JMS/AMQP broker (Classic / Artemis)",
		Roles:        []ImportRolePreset{{ID: "broker", Title: "Broker 节点", TitleEn: "Broker"}},
		ServiceHints: []string{"activemq", "artemis"},
		ConfigHints:  []string{"/opt/activemq/conf/activemq.xml", "/var/lib/artemis/etc/broker.xml"},
		DataHints:    []string{"/opt/activemq/data", "/var/lib/artemis/data"},
		LogHints:     []string{"/opt/activemq/data/activemq.log", "/var/lib/artemis/log"},
		PkgMatch:     "activemq|artemis|openjdk",
		ProbeSnippet: `echo "--- [ACTIVEMQ] ---"
ps -ef | grep -iE 'activemq|artemis' | grep -v grep || true`,
	},
	{
		ID: "pulsar", Name: "Apache Pulsar", NameEn: "Apache Pulsar",
		Category: "queue", CategoryTitle: "消息队列", CategoryTitleEn: "Message Queue",
		Icon: "queue", Color: "blue", DefaultPort: 6650,
		Summary: "云原生存算分离消息与流平台（Broker + BookKeeper + ZK）", SummaryEn: "Cloud-native pub-sub & streaming platform (Broker + BookKeeper)",
		Roles: []ImportRolePreset{
			{ID: "broker", Title: "Broker 节点", TitleEn: "Broker"},
			{ID: "bookie", Title: "BookKeeper 存储", TitleEn: "Bookie"},
			{ID: "zk", Title: "ZooKeeper 元数据", TitleEn: "ZooKeeper"},
		},
		Flows:        []ImportFlowPreset{{From: "broker", To: "bookie", Label: "持久化写入", Kind: "traffic"}},
		ServiceHints: []string{"pulsar-broker", "pulsar-bookie"},
		ConfigHints:  []string{"/opt/pulsar/conf/broker.conf", "/opt/pulsar/conf/bookkeeper.conf"},
		DataHints:    []string{"/data/bookkeeper"},
		LogHints:     []string{"/opt/pulsar/logs"},
		PkgMatch:     "pulsar|openjdk",
		ProbeSnippet: `echo "--- [PULSAR] ---"
ps -ef | grep -iE 'PulsarBrokerStarter|BookieServer' | grep -v grep || true`,
	},

	// ---- Search & Object Storage ----
	{
		ID: "elasticsearch", Name: "Elasticsearch", NameEn: "Elasticsearch",
		Category: "search", CategoryTitle: "搜索与存储", CategoryTitleEn: "Search & Storage",
		Icon: "elasticsearch", Color: "teal", DefaultPort: 9200,
		Summary: "分布式全文检索、日志分析与向量搜索引擎", SummaryEn: "Distributed search, log analytics, and vector engine",
		Roles: []ImportRolePreset{
			{ID: "master", Title: "Master 节点", TitleEn: "Master"},
			{ID: "data", Title: "Data 数据节点", TitleEn: "Data"},
			{ID: "coord", Title: "协调/Ingest 节点", TitleEn: "Coordinating"},
		},
		Flows:        []ImportFlowPreset{{From: "master", To: "data", Label: "分片调度", Kind: "quorum"}},
		ServiceHints: []string{"elasticsearch"},
		ConfigHints:  []string{"/etc/elasticsearch/elasticsearch.yml", "/etc/elasticsearch/jvm.options"},
		DataHints:    []string{"/var/lib/elasticsearch", "/data/elasticsearch"},
		LogHints:     []string{"/var/log/elasticsearch"},
		PkgMatch:     "elasticsearch",
		ProbeSnippet: `echo "--- [ELASTICSEARCH] ---"
[ -r /etc/elasticsearch/elasticsearch.yml ] && grep -vE '^\s*(#|$|.*password|.*secret)' /etc/elasticsearch/elasticsearch.yml | head -n 45 || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'elasticsearch' || true`,
	},
	{
		ID: "opensearch", Name: "OpenSearch", NameEn: "OpenSearch",
		Category: "search", CategoryTitle: "搜索与存储", CategoryTitleEn: "Search & Storage",
		Icon: "opensearch", Color: "blue", DefaultPort: 9200,
		Summary: "开源分布式搜索与可观测性分析引擎", SummaryEn: "Open-source distributed search and analytics suite",
		Roles: []ImportRolePreset{
			{ID: "cluster_manager", Title: "Cluster Manager", TitleEn: "Cluster Manager"},
			{ID: "data", Title: "Data 数据节点", TitleEn: "Data"},
		},
		Flows:        []ImportFlowPreset{{From: "cluster_manager", To: "data", Label: "集群调度", Kind: "quorum"}},
		ServiceHints: []string{"opensearch"},
		ConfigHints:  []string{"/etc/opensearch/opensearch.yml"},
		DataHints:    []string{"/var/lib/opensearch", "/data/opensearch"},
		LogHints:     []string{"/var/log/opensearch"},
		PkgMatch:     "opensearch",
		ProbeSnippet: `echo "--- [OPENSEARCH] ---"
[ -r /etc/opensearch/opensearch.yml ] && grep -vE '^\s*(#|$|.*password|.*secret)' /etc/opensearch/opensearch.yml | head -n 45 || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'opensearch' || true`,
	},
	{
		ID: "minio", Name: "MinIO", NameEn: "MinIO",
		Category: "storage", CategoryTitle: "搜索与存储", CategoryTitleEn: "Search & Storage",
		Icon: "minio", Color: "coral", DefaultPort: 9000,
		Summary: "高性能 S3 兼容分布式对象存储集群", SummaryEn: "High-performance S3-compatible object storage",
		Roles:        []ImportRolePreset{{ID: "node", Title: "存储节点", TitleEn: "Storage Node"}},
		Flows:        []ImportFlowPreset{{From: "node", To: "node", Label: "纠删码同步", Kind: "peer"}},
		ServiceHints: []string{"minio"},
		ConfigHints:  []string{"/etc/default/minio"},
		DataHints:    []string{"/data/minio", "/mnt/data"},
		LogHints:     []string{"/var/log/minio"},
		PkgMatch:     "minio",
		ProbeSnippet: `echo "--- [MINIO] ---"
command -v minio >/dev/null 2>&1 && minio --version || true
[ -r /etc/default/minio ] && grep -vE '^\s*(#|$|.*SECRET|.*PASSWORD)' /etc/default/minio || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'minio' || true`,
	},
	{
		ID: "ceph", Name: "Ceph", NameEn: "Ceph",
		Category: "storage", CategoryTitle: "搜索与存储", CategoryTitleEn: "Search & Storage",
		Icon: "storage", Color: "red", DefaultPort: 6789,
		Summary: "统一分布式块/文件/对象存储集群（MON / OSD / RGW / MDS）", SummaryEn: "Unified distributed block/file/object storage (MON/OSD/RGW)",
		Roles: []ImportRolePreset{
			{ID: "mon", Title: "MON 监控", TitleEn: "MON"},
			{ID: "osd", Title: "OSD 存储", TitleEn: "OSD"},
			{ID: "rgw", Title: "RGW 网关", TitleEn: "RGW"},
		},
		Flows:        []ImportFlowPreset{{From: "mon", To: "osd", Label: "集群映射", Kind: "quorum"}},
		ServiceHints: []string{"ceph.target", "ceph-mon.target"},
		ConfigHints:  []string{"/etc/ceph/ceph.conf"},
		DataHints:    []string{"/var/lib/ceph"},
		LogHints:     []string{"/var/log/ceph"},
		PkgMatch:     "ceph",
		ProbeSnippet: `echo "--- [CEPH] ---"
command -v ceph >/dev/null 2>&1 && { ceph --version; ceph -s 2>/dev/null | head -n 30 || true; }`,
	},

	// ---- Proxy / Load Balancer / Gateway / Registry ----
	{
		ID: "nginx", Name: "Nginx", NameEn: "Nginx",
		Category: "proxy", CategoryTitle: "代理与网关", CategoryTitleEn: "Proxy & Gateway",
		Icon: "nginx", Color: "green", DefaultPort: 80,
		Summary: "高性能 Web 服务、反向代理与四层/七层负载均衡", SummaryEn: "High-performance web server, reverse proxy, and L4/L7 LB",
		Roles:        []ImportRolePreset{{ID: "node", Title: "代理节点", TitleEn: "Proxy Node"}},
		ServiceHints: []string{"nginx"},
		ConfigHints:  []string{"/etc/nginx/nginx.conf", "/etc/nginx/conf.d/"},
		DataHints:    []string{"/var/cache/nginx"},
		LogHints:     []string{"/var/log/nginx"},
		PkgMatch:     "nginx|openresty",
		ProbeSnippet: `echo "--- [NGINX] ---"
command -v nginx >/dev/null 2>&1 && { nginx -V 2>&1 | head -n 5; nginx -t 2>&1 || true; }
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'nginx|openresty' || true`,
	},
	{
		ID: "haproxy", Name: "HAProxy", NameEn: "HAProxy",
		Category: "proxy", CategoryTitle: "代理与网关", CategoryTitleEn: "Proxy & Gateway",
		Icon: "haproxy", Color: "blue", DefaultPort: 5000,
		Summary: "高可靠四层/七层 TCP/HTTP 负载均衡器", SummaryEn: "High-reliability L4/L7 TCP/HTTP load balancer",
		Roles:        []ImportRolePreset{{ID: "node", Title: "负载均衡节点", TitleEn: "LB Node"}},
		ServiceHints: []string{"haproxy"},
		ConfigHints:  []string{"/etc/haproxy/haproxy.cfg"},
		DataHints:    []string{"/var/lib/haproxy"},
		LogHints:     []string{"/var/log/haproxy.log"},
		PkgMatch:     "haproxy",
		ProbeSnippet: `echo "--- [HAPROXY] ---"
command -v haproxy >/dev/null 2>&1 && { haproxy -v | head -n 3; haproxy -c -f /etc/haproxy/haproxy.cfg 2>&1 || true; }
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'haproxy' || true`,
	},
	{
		ID: "keepalived", Name: "Keepalived", NameEn: "Keepalived",
		Category: "proxy", CategoryTitle: "代理与网关", CategoryTitleEn: "Proxy & Gateway",
		Icon: "keepalived", Color: "teal", DefaultPort: 0,
		Summary: "基于 VRRP 协议的虚拟 IP（VIP）高可用漂移守护进程", SummaryEn: "VRRP Virtual IP high-availability failover daemon",
		Roles:        []ImportRolePreset{{ID: "node", Title: "VRRP 节点", TitleEn: "VRRP Node"}},
		Flows:        []ImportFlowPreset{{From: "node", To: "node", Label: "VRRP 心跳", Kind: "peer"}},
		ServiceHints: []string{"keepalived"},
		ConfigHints:  []string{"/etc/keepalived/keepalived.conf"},
		DataHints:    []string{},
		LogHints:     []string{"/var/log/messages", "/var/log/syslog"},
		PkgMatch:     "keepalived",
		ProbeSnippet: `echo "--- [KEEPALIVED] ---"
command -v keepalived >/dev/null 2>&1 && keepalived --version 2>&1 | head -n 2 || true
[ -r /etc/keepalived/keepalived.conf ] && grep -vE '^\s*(#|auth_pass)' /etc/keepalived/keepalived.conf | head -n 45 || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'keepalived' || true`,
	},
	{
		ID: "envoy", Name: "Envoy Proxy", NameEn: "Envoy Proxy",
		Category: "proxy", CategoryTitle: "代理与网关", CategoryTitleEn: "Proxy & Gateway",
		Icon: "envoy", Color: "pink", DefaultPort: 10000,
		Summary: "云原生边缘与服务网格代理", SummaryEn: "Cloud-native edge and service mesh proxy",
		Roles:        []ImportRolePreset{{ID: "node", Title: "代理节点", TitleEn: "Proxy Node"}},
		ServiceHints: []string{"envoy"},
		ConfigHints:  []string{"/etc/envoy/envoy.yaml"},
		LogHints:     []string{"/var/log/envoy"},
		PkgMatch:     "envoy",
		ProbeSnippet: `echo "--- [ENVOY] ---"
command -v envoy >/dev/null 2>&1 && envoy --version || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'envoy' || true`,
	},
	{
		ID: "traefik", Name: "Traefik", NameEn: "Traefik",
		Category: "proxy", CategoryTitle: "代理与网关", CategoryTitleEn: "Proxy & Gateway",
		Icon: "traefik", Color: "teal", DefaultPort: 80,
		Summary: "现代化云原生反向代理与 API 入口网关", SummaryEn: "Modern cloud-native reverse proxy and ingress gateway",
		Roles:        []ImportRolePreset{{ID: "node", Title: "网关节点", TitleEn: "Gateway Node"}},
		ServiceHints: []string{"traefik"},
		ConfigHints:  []string{"/etc/traefik/traefik.yml"},
		LogHints:     []string{"/var/log/traefik"},
		PkgMatch:     "traefik",
		ProbeSnippet: `echo "--- [TRAEFIK] ---"
command -v traefik >/dev/null 2>&1 && traefik version || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'traefik' || true`,
	},
	{
		ID: "apisix", Name: "Apache APISIX", NameEn: "Apache APISIX",
		Category: "proxy", CategoryTitle: "代理与网关", CategoryTitleEn: "Proxy & Gateway",
		Icon: "gateway", Color: "coral", DefaultPort: 9080,
		Summary: "动态高性能云原生 API 网关（基于 OpenResty + etcd）", SummaryEn: "Dynamic high-performance API gateway (OpenResty + etcd)",
		Roles: []ImportRolePreset{
			{ID: "gateway", Title: "网关节点", TitleEn: "Gateway"},
			{ID: "etcd", Title: "配置中心 etcd", TitleEn: "Config etcd"},
		},
		Flows:        []ImportFlowPreset{{From: "gateway", To: "etcd", Label: "配置同步", Kind: "quorum"}},
		ServiceHints: []string{"apisix"},
		ConfigHints:  []string{"/usr/local/apisix/conf/config.yaml"},
		LogHints:     []string{"/usr/local/apisix/logs"},
		PkgMatch:     "apisix|openresty",
		ProbeSnippet: `echo "--- [APISIX] ---"
command -v apisix >/dev/null 2>&1 && apisix version || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'apisix|etcd' || true`,
	},
	{
		ID: "nacos", Name: "Nacos", NameEn: "Nacos",
		Category: "proxy", CategoryTitle: "代理与网关", CategoryTitleEn: "Proxy & Gateway",
		Icon: "nacos", Color: "blue", DefaultPort: 8848,
		Summary: "微服务动态服务发现、配置管理与元数据中心", SummaryEn: "Dynamic service discovery and configuration center",
		Roles:        []ImportRolePreset{{ID: "server", Title: "Nacos 节点", TitleEn: "Nacos Node"}},
		Flows:        []ImportFlowPreset{{From: "server", To: "server", Label: "JRaft 同步", Kind: "quorum"}},
		ServiceHints: []string{"nacos"},
		ConfigHints:  []string{"/opt/nacos/conf/application.properties", "/opt/nacos/conf/cluster.conf"},
		DataHints:    []string{"/opt/nacos/data"},
		LogHints:     []string{"/opt/nacos/logs"},
		PkgMatch:     "nacos|openjdk|java",
		ProbeSnippet: `echo "--- [NACOS] ---"
ps -ef | grep -i 'nacos-server' | grep -v grep || true
for f in /opt/nacos/conf/cluster.conf /usr/local/nacos/conf/cluster.conf; do [ -r "$f" ] && { echo "# file: $f"; cat "$f"; }; done`,
	},

	// ---- Observability & Runtime ----
	{
		ID: "prometheus", Name: "Prometheus", NameEn: "Prometheus",
		Category: "observability", CategoryTitle: "可观测与运行", CategoryTitleEn: "Observability & Runtime",
		Icon: "prometheus", Color: "coral", DefaultPort: 9090,
		Summary: "时序指标采集监控与告警引擎", SummaryEn: "Time-series metrics monitoring and alerting engine",
		Roles: []ImportRolePreset{
			{ID: "server", Title: "采集节点", TitleEn: "Prometheus"},
			{ID: "alertmanager", Title: "告警中心", TitleEn: "Alertmanager"},
		},
		ServiceHints: []string{"prometheus", "alertmanager"},
		ConfigHints:  []string{"/etc/prometheus/prometheus.yml"},
		DataHints:    []string{"/var/lib/prometheus", "/data/prometheus"},
		LogHints:     []string{"/var/log/prometheus"},
		PkgMatch:     "prometheus|alertmanager",
		ProbeSnippet: `echo "--- [PROMETHEUS] ---"
command -v prometheus >/dev/null 2>&1 && prometheus --version 2>&1 | head -n 3 || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'prometheus|alertmanager|thanos' || true`,
	},
	{
		ID: "grafana", Name: "Grafana", NameEn: "Grafana",
		Category: "observability", CategoryTitle: "可观测与运行", CategoryTitleEn: "Observability & Runtime",
		Icon: "grafana", Color: "amber", DefaultPort: 3000,
		Summary: "统一指标、日志与链路可视化大盘平台", SummaryEn: "Unified observability visualization and dashboard platform",
		Roles:        []ImportRolePreset{{ID: "node", Title: "服务节点", TitleEn: "Server Node"}},
		ServiceHints: []string{"grafana-server"},
		ConfigHints:  []string{"/etc/grafana/grafana.ini"},
		DataHints:    []string{"/var/lib/grafana"},
		LogHints:     []string{"/var/log/grafana"},
		PkgMatch:     "grafana",
		ProbeSnippet: `echo "--- [GRAFANA] ---"
command -v grafana-server >/dev/null 2>&1 && grafana-server -v || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'grafana' || true`,
	},
	{
		ID: "harbor", Name: "Harbor", NameEn: "Harbor",
		Category: "runtime", CategoryTitle: "可观测与运行", CategoryTitleEn: "Observability & Runtime",
		Icon: "harbor", Color: "teal", DefaultPort: 443,
		Summary: "企业级云原生容器镜像与 OCI 制品仓库", SummaryEn: "Enterprise OCI container image & artifact registry",
		Roles:        []ImportRolePreset{{ID: "node", Title: "Harbor 节点", TitleEn: "Harbor Node"}},
		ServiceHints: []string{"harbor", "docker"},
		ConfigHints:  []string{"/opt/harbor/harbor.yml"},
		DataHints:    []string{"/data/harbor", "/data/registry"},
		LogHints:     []string{"/var/log/harbor"},
		PkgMatch:     "docker|containerd",
		ProbeSnippet: `echo "--- [HARBOR] ---"
command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null | grep -i harbor || true`,
	},
	{
		ID: "zabbix", Name: "Zabbix", NameEn: "Zabbix",
		Category: "observability", CategoryTitle: "可观测与运行", CategoryTitleEn: "Observability & Runtime",
		Icon: "zabbix", Color: "red", DefaultPort: 10051,
		Summary: "企业级基础设施与中间件监控平台（Server / Proxy）", SummaryEn: "Enterprise infrastructure monitoring (Server / Proxy)",
		Roles: []ImportRolePreset{
			{ID: "server", Title: "Zabbix Server", TitleEn: "Server"},
			{ID: "proxy", Title: "Zabbix Proxy", TitleEn: "Proxy"},
		},
		Flows:        []ImportFlowPreset{{From: "proxy", To: "server", Label: "指标上报", Kind: "traffic"}},
		ServiceHints: []string{"zabbix-server", "zabbix-proxy"},
		ConfigHints:  []string{"/etc/zabbix/zabbix_server.conf"},
		LogHints:     []string{"/var/log/zabbix"},
		PkgMatch:     "zabbix",
		ProbeSnippet: `echo "--- [ZABBIX] ---"
command -v zabbix_server >/dev/null 2>&1 && zabbix_server -V | head -n 2 || true
systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -iE 'zabbix' || true`,
	},
	{
		ID: "tomcat", Name: "Tomcat / JVM 应用", NameEn: "Tomcat / JVM Runtime",
		Category: "runtime", CategoryTitle: "可观测与运行", CategoryTitleEn: "Observability & Runtime",
		Icon: "server", Color: "amber", DefaultPort: 8080,
		Summary: "Java Web 容器与通用 JVM 中间件运行集群", SummaryEn: "Java servlet container and JVM middleware runtime",
		Roles:        []ImportRolePreset{{ID: "node", Title: "应用节点", TitleEn: "App Node"}},
		ServiceHints: []string{"tomcat", "tomcat9", "tomcat10"},
		ConfigHints:  []string{"/opt/tomcat/conf/server.xml", "/etc/tomcat/server.xml"},
		DataHints:    []string{"/opt/tomcat/webapps"},
		LogHints:     []string{"/opt/tomcat/logs", "/var/log/tomcat"},
		PkgMatch:     "tomcat|openjdk|java",
		ProbeSnippet: `echo "--- [TOMCAT / JVM] ---"
command -v java >/dev/null 2>&1 && java -version 2>&1 | head -n 3 || true
ps -ef | grep -iE 'catalina|tomcat' | grep -v grep || true`,
	},
}

var reImportCompSlug = regexp.MustCompile(`[^a-z0-9-]+`)

// NormalizeImportComponentID converts a preset ID or custom middleware name into a safe slug identifier.
func NormalizeImportComponentID(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.ReplaceAll(s, "_", "-")
	s = strings.ReplaceAll(s, " ", "-")
	s = reImportCompSlug.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		return "custom-middleware"
	}
	if len(s) > 36 {
		s = strings.TrimRight(s[:36], "-")
	}
	return s
}

// LookupImportPreset returns a built-in middleware preset by ID or alias.
func LookupImportPreset(id string) (ImportPreset, bool) {
	key := strings.ToLower(strings.TrimSpace(id))
	aliases := map[string]string{
		"pg": "postgresql", "postgres": "postgresql",
		"es": "elasticsearch", "elastic": "elasticsearch",
		"zk": "zookeeper", "mongo": "mongodb", "rmq": "rabbitmq",
		"ch": "clickhouse", "dm8": "dm", "dameng": "dm", "kes": "kingbase",
		"ob": "oceanbase", "openresty": "nginx",
	}
	if target, ok := aliases[key]; ok {
		key = target
	}
	for _, p := range ImportPresets {
		if p.ID == key {
			return p, true
		}
	}
	return ImportPreset{}, false
}

// CompanionPortDef defines a named listening port for a companion component.
type CompanionPortDef struct {
	Name string `json:"name"`
	Port int    `json:"port"`
}

// CompanionDef describes canonical metadata for co-located/supporting architectural components
// (Patroni, etcd, HAProxy, Keepalived, PgBouncer, pgBackRest, Redis Sentinel, ZooKeeper, etc.).
type CompanionDef struct {
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	Kind          string             `json:"kind"` // ha_manager | dcs | proxy | vip | pooler | backup | monitoring | os_component | companion
	Icon          string             `json:"icon"`
	Color         string             `json:"color"`
	DefaultRole   string             `json:"default_role"`
	RoleTitle     string             `json:"role_title"`
	Topology      bool               `json:"topology"` // materialize as a first-class InstanceSpec in Deployment.Instances
	InheritRoles  bool               `json:"inherit_roles,omitempty"`
	DefaultPorts  []CompanionPortDef `json:"default_ports,omitempty"`
	Flows         []ImportFlowPreset `json:"flows,omitempty"`
	ServiceHints  []string           `json:"service_hints,omitempty"`
	ConfigHints   []string           `json:"config_hints,omitempty"`
	DataHints     []string           `json:"data_hints,omitempty"`
}

// CompanionCatalog lists canonical companion components recognized across enterprise stacks.
var CompanionCatalog = []CompanionDef{
	{
		ID: "patroni", Name: "Patroni", Kind: "ha_manager", Icon: "patroni", Color: "blue",
		DefaultRole: "primary", RoleTitle: "主控", Topology: true, InheritRoles: true,
		DefaultPorts: []CompanionPortDef{{Name: "patroni-rest", Port: 8008}},
		ServiceHints: []string{"patroni.service"}, ConfigHints: []string{"/etc/patroni/patroni.yml"},
	},
	{
		ID: "etcd", Name: "etcd", Kind: "dcs", Icon: "etcd", Color: "teal",
		DefaultRole: "member", RoleTitle: "成员", Topology: true,
		DefaultPorts: []CompanionPortDef{{Name: "etcd 客户端", Port: 2379}, {Name: "etcd 节点通信", Port: 2380}},
		Flows:        []ImportFlowPreset{{From: "member", To: "member", Label: "Raft 共识（选主与写入）", Kind: "quorum"}},
		ServiceHints: []string{"etcd.service"}, ConfigHints: []string{"/etc/etcd/etcd.conf.yaml"}, DataHints: []string{"/data/etcd"},
	},
	{
		ID: "haproxy", Name: "HAProxy", Kind: "proxy", Icon: "haproxy", Color: "blue",
		DefaultRole: "node", RoleTitle: "负载均衡", Topology: true,
		DefaultPorts: []CompanionPortDef{{Name: "HAProxy 入口", Port: 5000}},
		ServiceHints: []string{"haproxy.service"}, ConfigHints: []string{"/etc/haproxy/haproxy.cfg"},
	},
	{
		ID: "keepalived", Name: "Keepalived", Kind: "vip", Icon: "keepalived", Color: "teal",
		DefaultRole: "node", RoleTitle: "VRRP 节点", Topology: true,
		Flows:        []ImportFlowPreset{{From: "node", To: "node", Label: "VRRP 心跳", Kind: "peer"}},
		ServiceHints: []string{"keepalived.service"}, ConfigHints: []string{"/etc/keepalived/keepalived.conf"},
	},
	{
		ID: "nginx", Name: "Nginx", Kind: "proxy", Icon: "nginx", Color: "green",
		DefaultRole: "node", RoleTitle: "代理节点", Topology: true,
		DefaultPorts: []CompanionPortDef{{Name: "Nginx 代理", Port: 80}},
		ServiceHints: []string{"nginx.service"}, ConfigHints: []string{"/etc/nginx/nginx.conf"},
	},
	{
		ID: "pgbouncer", Name: "PgBouncer", Kind: "pooler", Icon: "postgresql", Color: "indigo",
		DefaultRole: "node", RoleTitle: "连接池", Topology: true,
		DefaultPorts: []CompanionPortDef{{Name: "PgBouncer", Port: 6432}},
		ServiceHints: []string{"pgbouncer.service"}, ConfigHints: []string{"/etc/pgbouncer/pgbouncer.ini"},
	},
	{
		ID: "pgbackrest", Name: "pgBackRest", Kind: "backup", Icon: "storage", Color: "green",
		DefaultRole: "backup", RoleTitle: "物理备份", Topology: false,
		ConfigHints: []string{"/etc/pgbackrest/pgbackrest.conf"},
	},
	{
		ID: "redis-sentinel", Name: "Redis Sentinel", Kind: "ha_manager", Icon: "redis", Color: "red",
		DefaultRole: "sentinel", RoleTitle: "哨兵", Topology: true,
		DefaultPorts: []CompanionPortDef{{Name: "Sentinel", Port: 26379}},
		Flows:        []ImportFlowPreset{{From: "sentinel", To: "sentinel", Label: "哨兵仲裁", Kind: "quorum"}},
		ServiceHints: []string{"redis-sentinel.service"}, ConfigHints: []string{"/etc/redis/sentinel.conf"},
	},
	{
		ID: "zookeeper", Name: "ZooKeeper", Kind: "dcs", Icon: "zookeeper", Color: "amber",
		DefaultRole: "node", RoleTitle: "集群节点", Topology: true,
		DefaultPorts: []CompanionPortDef{{Name: "ZooKeeper", Port: 2181}},
		Flows:        []ImportFlowPreset{{From: "node", To: "node", Label: "ZAB 共识", Kind: "quorum"}},
		ServiceHints: []string{"zookeeper.service"}, ConfigHints: []string{"/etc/zookeeper/conf/zoo.cfg"},
	},
	{
		ID: "consul", Name: "Consul", Kind: "dcs", Icon: "consul", Color: "pink",
		DefaultRole: "server", RoleTitle: "Server", Topology: true,
		DefaultPorts: []CompanionPortDef{{Name: "Consul HTTP", Port: 8500}},
		Flows:        []ImportFlowPreset{{From: "server", To: "server", Label: "Raft 同步", Kind: "quorum"}},
		ServiceHints: []string{"consul.service"}, ConfigHints: []string{"/etc/consul.d/consul.hcl"},
	},
	{
		ID: "clickhouse-keeper", Name: "ClickHouse Keeper", Kind: "dcs", Icon: "clickhouse", Color: "amber",
		DefaultRole: "keeper", RoleTitle: "Keeper", Topology: true,
		DefaultPorts: []CompanionPortDef{{Name: "Keeper", Port: 9181}},
		Flows:        []ImportFlowPreset{{From: "keeper", To: "keeper", Label: "Raft 协调", Kind: "quorum"}},
		ServiceHints: []string{"clickhouse-keeper.service"}, ConfigHints: []string{"/etc/clickhouse-keeper/keeper_config.xml"},
	},
	{
		ID: "proxysql", Name: "ProxySQL", Kind: "proxy", Icon: "mysql", Color: "blue",
		DefaultRole: "router", RoleTitle: "代理路由", Topology: true,
		DefaultPorts: []CompanionPortDef{{Name: "ProxySQL", Port: 6033}, {Name: "ProxySQL 管理", Port: 6032}},
		ServiceHints: []string{"proxysql.service"}, ConfigHints: []string{"/etc/proxysql.cnf"},
	},
	{
		ID: "maxscale", Name: "MariaDB MaxScale", Kind: "proxy", Icon: "mariadb", Color: "indigo",
		DefaultRole: "router", RoleTitle: "代理路由", Topology: true,
		DefaultPorts: []CompanionPortDef{{Name: "MaxScale", Port: 4006}},
		ServiceHints: []string{"maxscale.service"}, ConfigHints: []string{"/etc/maxscale.cnf"},
	},
	{
		ID: "obproxy", Name: "OBProxy (ODP)", Kind: "proxy", Icon: "oceanbase", Color: "teal",
		DefaultRole: "router", RoleTitle: "代理路由", Topology: true,
		DefaultPorts: []CompanionPortDef{{Name: "OBProxy", Port: 2883}},
		ServiceHints: []string{"obproxy.service"},
	},
	{
		ID: "node-exporter", Name: "node_exporter", Kind: "os_component", Icon: "prometheus", Color: "coral",
		DefaultRole: "exporter", RoleTitle: "OS 指标采集", Topology: false,
		DefaultPorts: []CompanionPortDef{{Name: "Metrics", Port: 9100}},
		ServiceHints: []string{"node_exporter.service"},
	},
	{
		ID: "process-exporter", Name: "process_exporter", Kind: "os_component", Icon: "prometheus", Color: "coral",
		DefaultRole: "exporter", RoleTitle: "OS 进程采集", Topology: false,
		DefaultPorts: []CompanionPortDef{{Name: "Metrics", Port: 9256}},
		ServiceHints: []string{"process_exporter.service"},
	},
	{
		ID: "postgres-exporter", Name: "postgres_exporter", Kind: "monitoring", Icon: "prometheus", Color: "coral",
		DefaultRole: "exporter", RoleTitle: "PG 指标采集", Topology: false,
		DefaultPorts: []CompanionPortDef{{Name: "Metrics", Port: 9187}},
		ServiceHints: []string{"postgres_exporter.service"},
	},
	{
		ID: "mysqld-exporter", Name: "mysqld_exporter", Kind: "monitoring", Icon: "prometheus", Color: "coral",
		DefaultRole: "exporter", RoleTitle: "MySQL 指标采集", Topology: false,
		DefaultPorts: []CompanionPortDef{{Name: "Metrics", Port: 9104}},
		ServiceHints: []string{"mysqld_exporter.service"},
	},
	{
		ID: "redis-exporter", Name: "redis_exporter", Kind: "monitoring", Icon: "prometheus", Color: "coral",
		DefaultRole: "exporter", RoleTitle: "Redis 指标采集", Topology: false,
		DefaultPorts: []CompanionPortDef{{Name: "Metrics", Port: 9121}},
		ServiceHints: []string{"redis_exporter.service"},
	},
	{
		ID: "haproxy-exporter", Name: "haproxy_exporter", Kind: "monitoring", Icon: "prometheus", Color: "coral",
		DefaultRole: "exporter", RoleTitle: "HAProxy 指标采集", Topology: false,
		DefaultPorts: []CompanionPortDef{{Name: "Metrics", Port: 9101}},
		ServiceHints: []string{"haproxy_exporter.service"},
	},
	{
		ID: "nginx-exporter", Name: "nginx_exporter", Kind: "monitoring", Icon: "prometheus", Color: "coral",
		DefaultRole: "exporter", RoleTitle: "Nginx 指标采集", Topology: false,
		DefaultPorts: []CompanionPortDef{{Name: "Metrics", Port: 9113}},
		ServiceHints: []string{"nginx_exporter.service"},
	},
	{
		ID: "kafka-exporter", Name: "kafka_exporter", Kind: "monitoring", Icon: "prometheus", Color: "coral",
		DefaultRole: "exporter", RoleTitle: "Kafka 指标采集", Topology: false,
		DefaultPorts: []CompanionPortDef{{Name: "Metrics", Port: 9308}},
		ServiceHints: []string{"kafka_exporter.service"},
	},
	{
		ID: "blackbox-exporter", Name: "blackbox_exporter", Kind: "monitoring", Icon: "prometheus", Color: "coral",
		DefaultRole: "exporter", RoleTitle: "拨测采集", Topology: false,
		DefaultPorts: []CompanionPortDef{{Name: "Metrics", Port: 9115}},
		ServiceHints: []string{"blackbox_exporter.service"},
	},
}

// NormalizeCompanionID canonicalizes companion aliases (e.g. "zk" -> "zookeeper", "node_exporter" -> "node-exporter").
func NormalizeCompanionID(raw string) string {
	k := strings.ToLower(strings.TrimSpace(raw))
	k = strings.ReplaceAll(k, "_", "-")
	k = strings.ReplaceAll(k, " ", "-")
	aliases := map[string]string{
		"zk":                        "zookeeper",
		"sentinel":                  "redis-sentinel",
		"redis-sentinel":            "redis-sentinel",
		"ch-keeper":                 "clickhouse-keeper",
		"clickhouse-keeper":         "clickhouse-keeper",
		"pg-backrest":               "pgbackrest",
		"pgbackrest":                "pgbackrest",
		"pg-bouncer":                "pgbouncer",
		"pgbouncer":                 "pgbouncer",
		"node-exporter":             "node-exporter",
		"pg-exporter":               "postgres-exporter",
		"postgresql-exporter":       "postgres-exporter",
		"mysql-exporter":            "mysqld-exporter",
		"nginx-prometheus-exporter": "nginx-exporter",
		"openresty":                 "nginx",
		"nginx-stream":              "nginx",
		"odp":                       "obproxy",
	}
	if mapped, ok := aliases[k]; ok {
		return mapped
	}
	return NormalizeImportComponentID(k)
}

// IsOSCompanion reports whether a companion ID represents an OS/host-level agent or exporter
// (such as node_exporter or process_exporter) rather than a middleware-specific component.
func IsOSCompanion(id string) bool {
	switch NormalizeCompanionID(id) {
	case "node-exporter", "process-exporter", "systemd-exporter", "host-exporter", "linux-exporter",
		"cadvisor", "telegraf", "filebeat", "fluent-bit", "fluentbit", "vector", "alloy":
		return true
	}
	return false
}

// IsExporterCompanion reports whether a companion ID represents a Prometheus-style exporter (*-exporter).
func IsExporterCompanion(id string) bool {
	norm := NormalizeCompanionID(id)
	return strings.HasSuffix(norm, "-exporter") && len(norm) > len("-exporter")
}

// ExporterDisplayName returns the canonical Prometheus-style display name (using underscores) for an exporter ID.
func ExporterDisplayName(id string) string {
	norm := NormalizeCompanionID(id)
	if def, ok := LookupCompanionDef(norm); ok && def.Name != "" {
		return def.Name
	}
	return strings.ReplaceAll(norm, "-", "_")
}

// LookupCompanionDef returns canonical companion metadata by ID or alias.
func LookupCompanionDef(id string) (CompanionDef, bool) {
	norm := NormalizeCompanionID(id)
	for _, c := range CompanionCatalog {
		if c.ID == norm {
			return c, true
		}
	}
	return CompanionDef{}, false
}

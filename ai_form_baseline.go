package main

import (
	"fmt"
	"sort"
	"strings"

	"middleware-deployer/mwpack"
)

// formBaseline is a single production-readiness baseline finding surfaced as an interactive
// card beneath the AI's form-fill summary, letting the user inspect the gap, jump straight
// to the corresponding form step, or let AI apply the recommended baseline in one click.
type formBaseline struct {
	ID             string `json:"id"`
	Category       string `json:"category"`                  // storage | logging | security | backup | ha | resource
	Severity       string `json:"severity"`                  // action | warn | info
	Title          string `json:"title"`                     // concise ZH headline
	TitleEN        string `json:"title_en,omitempty"`        // concise EN headline
	Detail         string `json:"detail"`                    // 1-line impact & rationale (ZH)
	DetailEN       string `json:"detail_en,omitempty"`       // 1-line impact & rationale (EN)
	Current        string `json:"current,omitempty"`         // current value pill (ZH)
	CurrentEN      string `json:"current_en,omitempty"`      // current value pill (EN)
	Recommended    string `json:"recommended,omitempty"`     // recommended value pill (ZH)
	RecommendedEN  string `json:"recommended_en,omitempty"`  // recommended value pill (EN)
	Section        string `json:"section,omitempty"`         // basics | hosts | placement | params | access
	ActionLabel    string `json:"action_label,omitempty"`    // quick action button label (ZH)
	ActionLabelEN  string `json:"action_label_en,omitempty"` // quick action button label (EN)
	ActionPrompt   string `json:"action_prompt,omitempty"`   // prompt sent to AI to apply this item
	DefaultChecked bool   `json:"default_checked,omitempty"` // pre-selected for safe batch apply
}

// evaluateFormBaselines inspects a solved deployment plan against real schema parameters,
// host storage contracts, and enterprise production baselines (logging, security, backup,
// storage consistency, HA/entrypoint, and OS/resource posture). It never fabricates
// parameters that do not exist in the component's resolved schema.
func evaluateFormBaselines(plan *mwpack.Plan, d *mwpack.Deployment) []formBaseline {
	if plan == nil || d == nil {
		return nil
	}
	var out []formBaseline
	seen := map[string]bool{}
	add := func(b formBaseline) {
		if b.ID == "" || seen[b.ID] {
			return
		}
		seen[b.ID] = true
		out = append(out, b)
	}

	// Find primary (non-auto, non-external) instance.
	var primary *mwpack.Instance
	for _, inst := range plan.Instances {
		if inst == nil || inst.Auto || inst.External {
			continue
		}
		primary = inst
		break
	}

	// ---- 1. Host IP & Storage consistency baselines ----
	evalHostBaselines(plan, d, primary, add)

	// ---- 2. Component & Schema-driven baselines ----
	if primary != nil {
		evalPrimaryBaselines(plan, primary, add)
	}

	// ---- 3. Multi-node unified access entry baseline ----
	if primary != nil {
		evalAccessEntryBaseline(plan, primary, add)
	}

	sortBaselines(out)
	if len(out) > 7 {
		out = out[:7]
	}
	return out
}

func evalHostBaselines(plan *mwpack.Plan, d *mwpack.Deployment, primary *mwpack.Instance, add func(formBaseline)) {
	hosts := plan.Hosts
	if len(hosts) == 0 {
		hosts = d.Hosts
	}
	if len(hosts) == 0 {
		return
	}

	var missingIPs []string
	var emptyDiskHosts []string
	var sysDirHosts []string
	sampleDisk := ""
	sampleHost := ""
	for _, h := range hosts {
		if strings.TrimSpace(h.IP) == "" {
			missingIPs = append(missingIPs, h.Name)
		}
		mode := strings.TrimSpace(asString(h.Params["storage_mode"]))
		if mode == "" {
			mode = "dedicated_disk"
		}
		if mode == "system_directory" {
			sysDirHosts = append(sysDirHosts, h.Name)
			continue
		}
		if strings.TrimSpace(h.Disk) == "" {
			emptyDiskHosts = append(emptyDiskHosts, h.Name)
		} else if sampleDisk == "" {
			sampleDisk = strings.TrimSpace(h.Disk)
			sampleHost = h.Name
		}
	}

	if len(missingIPs) > 0 {
		names := strings.Join(missingIPs, "、")
		namesEN := strings.Join(missingIPs, ", ")
		add(formBaseline{
			ID:            "host-ip-missing",
			Category:      "storage",
			Severity:      "action",
			Title:         fmt.Sprintf("%d 台主机尚未填写 IP 地址", len(missingIPs)),
			TitleEN:       fmt.Sprintf("%d host(s) missing IP address", len(missingIPs)),
			Detail:        fmt.Sprintf("%s 缺少 IP，生成交付前必须补齐。", names),
			DetailEN:      fmt.Sprintf("%s missing IP; required before generating the delivery.", namesEN),
			Current:       names + " 留空",
			CurrentEN:     namesEN + " empty",
			Recommended:   "补齐真实内网 IP",
			RecommendedEN: "Provide valid private IP(s)",
			Section:       "hosts",
		})
	}

	// Only enforce dedicated-disk baseline for stateful components or when sibling hosts already declare a disk.
	stateful := primary == nil || isStatefulComponent(primary.Component)
	if len(emptyDiskHosts) > 0 && (sampleDisk != "" || stateful) {
		names := strings.Join(emptyDiskHosts, "、")
		namesEN := strings.Join(emptyDiskHosts, ", ")
		if sampleDisk != "" {
			add(formBaseline{
				ID:            "host-disk-missing",
				Category:      "storage",
				Severity:      "action",
				Title:         fmt.Sprintf("%d 台主机尚未填写数据盘设备", len(emptyDiskHosts)),
				TitleEN:       fmt.Sprintf("%d host(s) missing data disk device", len(emptyDiskHosts)),
				Detail:        fmt.Sprintf("%s 已配置独立数据盘 %s，而 %s 数据盘留空；独立数据盘模式建议各节点一致。", sampleHost, sampleDisk, names),
				DetailEN:      fmt.Sprintf("%s uses dedicated disk %s while %s are blank; keep disk devices consistent across nodes.", sampleHost, sampleDisk, namesEN),
				Current:       fmt.Sprintf("%s 留空", names),
				CurrentEN:     fmt.Sprintf("%s empty", namesEN),
				Recommended:   fmt.Sprintf("统一为 %s（不格式化）", sampleDisk),
				RecommendedEN: fmt.Sprintf("Set %s (no format)", sampleDisk),
				Section:       "hosts",
				ActionLabel:   "按 " + sampleDisk + " 补齐",
				ActionLabelEN: "Use " + sampleDisk,
				ActionPrompt:  fmt.Sprintf("请将 %s 的独立数据盘设备统一补齐为 %s（保持不格式化磁盘，其余配置不变）。", names, sampleDisk),
			})
		} else {
			add(formBaseline{
				ID:            "host-disk-missing",
				Category:      "storage",
				Severity:      "action",
				Title:         "独立数据盘模式尚未指定磁盘设备",
				TitleEN:       "Dedicated data disk device not specified",
				Detail:        "当前全部节点均为独立数据盘模式但数据盘留空，请确认块设备路径（如 /dev/vdb）或切换为系统盘目录模式。",
				DetailEN:      "All hosts use dedicated disk mode with blank devices; specify a block device (e.g. /dev/vdb) or switch to system directory mode.",
				Current:       "全部留空",
				CurrentEN:     "All empty",
				Recommended:   "填写块设备或改用系统盘目录",
				RecommendedEN: "Set disk device or system directory",
				Section:       "hosts",
				ActionLabel:   "让 AI 协助确认存储",
				ActionLabelEN: "Confirm storage with AI",
				ActionPrompt:  "当前各节点的数据盘设备尚未填写，请用选项卡片让我确认：统一使用哪块独立数据盘（例如 /dev/vdb）、是否需要格式化，或者改为系统盘目录模式。",
			})
		}
	}

	if len(sysDirHosts) > 0 && stateful {
		names := strings.Join(sysDirHosts, "、")
		namesEN := strings.Join(sysDirHosts, ", ")
		add(formBaseline{
			ID:            "host-system-directory",
			Category:      "storage",
			Severity:      "warn",
			Title:         "数据目录位于系统盘（无独立磁盘隔离）",
			TitleEN:       "Data stored on system root disk",
			Detail:        fmt.Sprintf("%s 使用系统盘目录模式，数据与日志增长可能占满根分区；生产建议挂载独立数据盘。", names),
			DetailEN:      fmt.Sprintf("%s use system directory mode; data/log growth may fill the root filesystem. A dedicated data disk is recommended for production.", namesEN),
			Current:       "系统盘目录",
			CurrentEN:     "System directory",
			Recommended:   "生产建议独立数据盘",
			RecommendedEN: "Dedicated data disk",
			Section:       "hosts",
		})
	}
}

func evalPrimaryBaselines(plan *mwpack.Plan, inst *mwpack.Instance, add func(formBaseline)) {
	switch inst.Component {
	case "postgresql", "patroni":
		evalPostgreSQLBaselines(inst, add)
	case "redis":
		evalRedisBaselines(inst, add)
	case "haproxy":
		evalHAProxyBaselines(inst, add)
	case "nginx":
		evalNginxBaselines(inst, add)
	case "etcd":
		evalEtcdBaselines(inst, add)
	default:
		evalGenericSchemaBaselines(inst, add)
	}
	// Cross-component OS baseline check whenever the schema exposes apply_baseline.
	if hasVisibleParam(inst, "apply_baseline") && !paramBool(inst, "apply_baseline", true) {
		add(formBaseline{
			ID:             "os-baseline-off",
			Category:       "resource",
			Severity:       "warn",
			Title:          "已关闭操作系统内核与限额基线",
			TitleEN:        "OS kernel & limits baseline is disabled",
			Detail:         "关闭后交付不会写入 sysctl（swappiness/overcommit/somaxconn）、nofile 与关闭透明大页 THP，需现场人工保证。",
			DetailEN:       "Disabling skips sysctl, nofile limits, and THP tuning; host admins must configure these manually.",
			Current:        "关闭",
			CurrentEN:      "Off",
			Recommended:    "开启（自动配置）",
			RecommendedEN:  "On (auto-applied)",
			Section:        "params",
			ActionLabel:    "开启内核基线",
			ActionLabelEN:  "Enable OS baseline",
			ActionPrompt:   "请开启「写入内核与限额基线」（apply_baseline=true），保留其余配置不变。",
			DefaultChecked: true,
		})
	}
}

func evalPostgreSQLBaselines(inst *mwpack.Instance, add func(formBaseline)) {
	// 1. Logging & slow-query / lock-wait troubleshooting baseline.
	slowMS, hasSlow := paramInt(inst, "log_min_duration_statement")
	logConn := paramBool(inst, "log_connections", true)
	logDisc := paramBool(inst, "log_disconnections", true)
	logCkpt := paramBool(inst, "log_checkpoints", true)
	logLock := paramBool(inst, "log_lock_waits", false)

	var offLogs []string
	var offLogsEN []string
	if hasSlow && slowMS < 0 {
		offLogs = append(offLogs, "慢 SQL 日志")
		offLogsEN = append(offLogsEN, "slow SQL log")
	}
	if hasVisibleParam(inst, "log_connections") && !logConn {
		offLogs = append(offLogs, "记录连接")
		offLogsEN = append(offLogsEN, "log_connections")
	}
	if hasVisibleParam(inst, "log_disconnections") && !logDisc {
		offLogs = append(offLogs, "记录断开")
		offLogsEN = append(offLogsEN, "log_disconnections")
	}
	if hasVisibleParam(inst, "log_checkpoints") && !logCkpt {
		offLogs = append(offLogs, "记录检查点")
		offLogsEN = append(offLogsEN, "log_checkpoints")
	}
	if len(offLogs) > 0 {
		add(formBaseline{
			ID:             "pg-logging-disabled",
			Category:       "logging",
			Severity:       "warn",
			Title:          "关键数据库日志基线被关闭",
			TitleEN:        "Core PostgreSQL logging baseline disabled",
			Detail:         fmt.Sprintf("当前关闭了 %s，生产故障排查与慢查询定位会缺少关键审计与诊断记录。", strings.Join(offLogs, "、")),
			DetailEN:       fmt.Sprintf("%s disabled; production troubleshooting and slow-query diagnosis will lack essential logs.", strings.Join(offLogsEN, ", ")),
			Current:        strings.Join(offLogs, " / ") + " 关闭",
			CurrentEN:      strings.Join(offLogsEN, " / ") + " off",
			Recommended:    "慢 SQL 1000 ms · 全开连接/检查点/锁等待",
			RecommendedEN:  "1000 ms slow SQL · all core logs on",
			Section:        "params",
			ActionLabel:    "补齐日志基线",
			ActionLabelEN:  "Enable logging baseline",
			ActionPrompt:   "请按生产日志基线配置 PostgreSQL：将慢 SQL 阈值设为 1000 ms，开启记录连接、记录断开、记录检查点与记录锁等待（其余配置不变）。",
			DefaultChecked: true,
		})
	} else if hasVisibleParam(inst, "log_lock_waits") && !logLock {
		curSlow := "1000 ms"
		if hasSlow {
			curSlow = fmt.Sprintf("%d ms", slowMS)
		}
		add(formBaseline{
			ID:             "pg-log-lock-waits",
			Category:       "logging",
			Severity:       "warn",
			Title:          "锁等待日志未开启（生产排查基线）",
			TitleEN:        "Lock-wait logging is off",
			Detail:         "当前已开启连接/检查点与慢 SQL 日志，但未开启「记录锁等待」；线上出现表锁阻塞或死锁时难以回溯原因。",
			DetailEN:       "Connections, checkpoints, and slow SQL logs are active, but log_lock_waits is off—making lock contention hard to diagnose.",
			Current:        fmt.Sprintf("锁等待 关闭 · 慢 SQL %s", curSlow),
			CurrentEN:      fmt.Sprintf("lock_waits off · slow SQL %s", curSlow),
			Recommended:    "开启记录锁等待",
			RecommendedEN:  "log_lock_waits = on",
			Section:        "params",
			ActionLabel:    "开启锁等待日志",
			ActionLabelEN:  "Enable lock-wait log",
			ActionPrompt:   "请开启 PostgreSQL 的「记录锁等待」（log_lock_waits=true），保持慢 SQL、连接与检查点日志开启（其余配置不变）。",
			DefaultChecked: true,
		})
	}

	// 2. Client CIDR overly broad (0.0.0.0/0).
	cidr := strings.TrimSpace(asString(inst.Params["client_cidr"]))
	if cidr == "0.0.0.0/0" || cidr == "::/0" {
		add(formBaseline{
			ID:            "pg-cidr-open",
			Category:      "security",
			Severity:      "action",
			Title:         "客户端放通网段为全网开放",
			TitleEN:       "Client access CIDR is open to all networks",
			Detail:        "pg_hba 允许 0.0.0.0/0 访问数据库端口，存在越权访问风险，生产建议收紧为应用所在网段。",
			DetailEN:      "pg_hba allows 0.0.0.0/0 access to PostgreSQL; restrict this to application subnets in production.",
			Current:       cidr,
			CurrentEN:     cidr,
			Recommended:   "收紧为业务子网（如 /24）",
			RecommendedEN: "Restrict to app subnet",
			Section:       "params",
			ActionLabel:   "收紧网段",
			ActionLabelEN: "Restrict CIDR",
			ActionPrompt:  "当前允许访问的客户端网段是全网开放（0.0.0.0/0），请用选项卡片帮我收紧为实际的应用网段。",
		})
	}

	// 3. Idle-in-transaction timeout protection.
	if hasVisibleParam(inst, "idle_in_transaction_session_timeout") {
		if idleMS, ok := paramInt(inst, "idle_in_transaction_session_timeout"); ok && idleMS == 0 {
			add(formBaseline{
				ID:             "pg-idle-tx-timeout",
				Category:       "security",
				Severity:       "warn",
				Title:          "未限制空闲事务超时（易锁表与膨胀）",
				TitleEN:        "Idle-in-transaction timeout is unlimited",
				Detail:         "应用异常断开后滞留的空闲事务会长期持锁并阻止 VACUUM 回收死元组，生产建议设为 5 分钟（300000 ms）。",
				DetailEN:       "Abandoned idle transactions hold locks and block VACUUM cleanup; 300000 ms (5 min) is recommended for production.",
				Current:        "0 ms（不限制）",
				CurrentEN:      "0 ms (unlimited)",
				Recommended:    "300000 ms（5 分钟）",
				RecommendedEN:  "300000 ms (5 min)",
				Section:        "params",
				ActionLabel:    "设为 5 分钟",
				ActionLabelEN:  "Set 5 min",
				ActionPrompt:   "请将 PostgreSQL 的「空闲事务超时」（idle_in_transaction_session_timeout）设为 300000 ms（5 分钟），其余配置保持不变。",
				DefaultChecked: true,
			})
		}
	}

	// 4. TLS transport encryption baseline.
	if hasVisibleParam(inst, "tls") && !paramBool(inst, "tls", true) {
		add(formBaseline{
			ID:            "pg-tls-disabled",
			Category:      "security",
			Severity:      "warn",
			Title:         "未启用 TLS 传输加密",
			TitleEN:       "TLS transport encryption is disabled",
			Detail:        "当前客户端与流复制流量为明文传输；若生产或合规要求加密，可开启 TLS 并直接将证书文件拖入对话框解析。",
			DetailEN:      "Client and replication traffic will run in plaintext; enable TLS for encrypted transport and upload certificates directly in chat.",
			Current:       "TLS 关闭",
			CurrentEN:     "TLS off",
			Recommended:   "开启 TLSv1.2+（需证书）",
			RecommendedEN: "TLSv1.2+ (certs required)",
			Section:       "params",
			ActionLabel:   "开启 TLS",
			ActionLabelEN: "Enable TLS",
			ActionPrompt:  "请为当前 PostgreSQL 集群开启 TLS 传输加密（最低 TLSv1.2），并说明需要准备或拖入上传哪些证书文件。",
		})
	}

	// 5. TDE encryption (only when visible — e.g. Patroni/single, NOT replication).
	if hasVisibleParam(inst, "tde") && !paramBool(inst, "tde", true) {
		add(formBaseline{
			ID:            "pg-tde-disabled",
			Category:      "security",
			Severity:      "info",
			Title:         "未启用 TDE 透明数据加密",
			TitleEN:       "TDE transparent data encryption is off",
			Detail:        "表数据与 WAL 落盘未加密；若需满足落盘加密合规要求可开启（注意本地密钥需妥善保管）。",
			DetailEN:      "Table data and WAL are not encrypted at rest; enable TDE if required for compliance (keep local key file backed up).",
			Current:       "TDE 关闭",
			CurrentEN:     "TDE off",
			Recommended:   "按合规要求开启",
			RecommendedEN: "Enable if required",
			Section:       "params",
			ActionLabel:   "开启 TDE",
			ActionLabelEN: "Enable TDE",
			ActionPrompt:  "请开启 PostgreSQL 的 TDE 透明数据加密（tde=true），其余配置保持不变。",
		})
	}

	// 6. Dedicated business admin user (app_user).
	if hasVisibleParam(inst, "app_user") && strings.TrimSpace(asString(inst.Params["app_user"])) == "" {
		add(formBaseline{
			ID:            "pg-app-user-empty",
			Category:      "security",
			Severity:      "info",
			Title:         "未配置独立业务管理账户",
			TitleEN:       "No dedicated application admin account",
			Detail:        "「业务管理账户」留空时仅初始化超级用户；生产建议规划独立业务账户，密码由平台自动生成并保存在控制节点。",
			DetailEN:      "Leaving app_user blank creates only the superuser; configure a dedicated app account (password auto-generated).",
			Current:       "留空（仅超级用户）",
			CurrentEN:     "Empty (superuser only)",
			Recommended:   "配置独立账户（如 app_admin）",
			RecommendedEN: "e.g. app_admin",
			Section:       "params",
			ActionLabel:   "配置业务账户",
			ActionLabelEN: "Add app user",
			ActionPrompt:  "请为 PostgreSQL 配置独立业务管理账户（app_user=app_admin），密码由平台自动生成，其余配置保持不变。",
		})
	}

	// 7. Backup retention & WAL archive window baseline (only when untouched defaults).
	if hasVisibleParam(inst, "backup_retention_full") && hasVisibleParam(inst, "archive_timeout") {
		fullRet, _ := paramInt(inst, "backup_retention_full")
		diffRet, _ := paramInt(inst, "retention_diff")
		archSec, _ := paramInt(inst, "archive_timeout")
		_, setFull := inst.Spec.Params["backup_retention_full"]
		_, setDiff := inst.Spec.Params["retention_diff"]
		_, setArch := inst.Spec.Params["archive_timeout"]
		if !setFull && !setDiff && !setArch && fullRet <= 2 && diffRet == 0 {
			add(formBaseline{
				ID:            "pg-backup-policy",
				Category:      "backup",
				Severity:      "info",
				Title:         "备份保留与归档策略沿用默认值",
				TitleEN:       "Backup retention & WAL archive left at defaults",
				Detail:        fmt.Sprintf("当前全量保留 %d 份、差异 0、归档间隔 %d s（仅写策略不建定时任务）；生产建议留 3 份并缩短 PITR 归档窗口。", fullRet, archSec),
				DetailEN:      fmt.Sprintf("Currently %d full backups, 0 diff, %ds archive timeout (policy only, no cron); consider 3 full/diff and 300s archive timeout.", fullRet, archSec),
				Current:       fmt.Sprintf("全量 %d 份 · 归档 %d s", fullRet, archSec),
				CurrentEN:     fmt.Sprintf("%d full · %ds archive", fullRet, archSec),
				Recommended:   "全量 3 份 · 差异 3 份 · 归档 300 s",
				RecommendedEN: "3 full · 3 diff · 300s archive",
				Section:       "params",
				ActionLabel:   "优化备份基线",
				ActionLabelEN: "Tune backup policy",
				ActionPrompt:  "请按生产备份基线调整 PostgreSQL 备份参数：全量备份保留 3 份、差异备份保留 3 份、压缩算法 zst、强制归档间隔设为 300 秒（其余配置不变）。",
			})
		}
	}
}

func evalRedisBaselines(inst *mwpack.Instance, add func(formBaseline)) {
	// 1. Persistence disabled (default is "none"!).
	if hasVisibleParam(inst, "persistence") {
		pers := strings.TrimSpace(asString(inst.Params["persistence"]))
		if pers == "" || pers == "none" {
			add(formBaseline{
				ID:            "redis-persistence-none",
				Category:      "backup",
				Severity:      "warn",
				Title:         "未开启持久化（重启将清空数据）",
				TitleEN:       "Persistence is disabled (data lost on restart)",
				Detail:        "当前持久化为 none（纯内存模式）；若非纯可重建缓存，生产建议开启 AOF（每秒刷盘）或 RDB 快照。",
				DetailEN:      "Persistence is set to none (in-memory only); enable AOF or RDB if data must survive restarts.",
				Current:       "none（不落盘）",
				CurrentEN:     "none",
				Recommended:   "aof 或 rdb",
				RecommendedEN: "aof or rdb",
				Section:       "params",
				ActionLabel:   "开启 AOF 持久化",
				ActionLabelEN: "Enable AOF",
				ActionPrompt:  "请为 Redis 开启 AOF 持久化基线（persistence=aof），其余配置保持不变。",
			})
		}
	}

	// 2. Logging level & log rotation baseline.
	level := strings.TrimSpace(asString(inst.Params["loglevel"]))
	rotDays, hasRot := paramInt(inst, "logrotate_days")
	if level == "debug" || (hasRot && rotDays < 7) {
		add(formBaseline{
			ID:             "redis-logging",
			Category:       "logging",
			Severity:       "warn",
			Title:          "Redis 日志级别或保留天数不符生产基线",
			TitleEN:        "Redis logging level or retention below baseline",
			Detail:         "debug 日志会放大磁盘 I/O，保留不足 7 天不利于故障回溯；生产建议 loglevel=notice 且日志保留 ≥ 14 天。",
			DetailEN:       "Debug logging increases disk I/O and <7d retention hurts forensics; use notice level with ≥14d retention.",
			Current:        fmt.Sprintf("%s · 保留 %d 天", level, rotDays),
			CurrentEN:      fmt.Sprintf("%s · %dd retention", level, rotDays),
			Recommended:    "notice · 保留 14 天",
			RecommendedEN:  "notice · 14d retention",
			Section:        "params",
			ActionLabel:    "调整日志基线",
			ActionLabelEN:  "Fix logging baseline",
			ActionPrompt:   "请将 Redis 日志级别调整为 notice，日志保留天数设为 14 天（其余配置保持不变）。",
			DefaultChecked: true,
		})
	}

	// 3. Swap disabling baseline.
	if hasVisibleParam(inst, "disable_swap") && !paramBool(inst, "disable_swap", false) {
		add(formBaseline{
			ID:            "redis-swap-enabled",
			Category:      "resource",
			Severity:      "warn",
			Title:         "未开启关闭 Swap（易引发延迟毛刺）",
			TitleEN:       "Swap disabling is off (latency spike risk)",
			Detail:        "Redis 官方基线要求关闭宿主机 Swap，避免热点内存换出导致响应延迟骤增。",
			DetailEN:      "Redis recommends disabling swap on hosts to prevent severe latency spikes from memory paging.",
			Current:       "保持现状",
			CurrentEN:     "Keep as-is",
			Recommended:   "交付时关闭 Swap",
			RecommendedEN: "Disable swap",
			Section:       "params",
			ActionLabel:   "开启关闭 Swap",
			ActionLabelEN: "Disable swap",
			ActionPrompt:  "请开启 Redis 的「关闭 swap」操作系统基线（disable_swap=true），其余配置保持不变。",
		})
	}

	// 4. Client idle timeout.
	if hasVisibleParam(inst, "client_timeout") {
		if timeout, ok := paramInt(inst, "client_timeout"); ok && timeout == 0 {
			add(formBaseline{
				ID:             "redis-client-timeout",
				Category:       "security",
				Severity:       "info",
				Title:          "客户端空闲连接超时未限制",
				TitleEN:        "Client idle timeout is unlimited",
				Detail:         "空闲连接永不断开容易在连接池泄漏时耗尽句柄，生产建议设为 300 秒。",
				DetailEN:       "Unlimited idle connections can exhaust descriptors during client leaks; 300s is recommended.",
				Current:        "0 s（不断开）",
				CurrentEN:      "0 s (unlimited)",
				Recommended:    "300 s",
				RecommendedEN:  "300 s",
				Section:        "params",
				ActionLabel:    "设为 300 秒",
				ActionLabelEN:  "Set 300 s",
				ActionPrompt:   "请将 Redis 的「客户端空闲超时」（client_timeout）设为 300 秒，其余配置保持不变。",
				DefaultChecked: true,
			})
		}
	}
}

func evalHAProxyBaselines(inst *mwpack.Instance, add func(formBaseline)) {
	if hasVisibleParam(inst, "stats_enabled") && !paramBool(inst, "stats_enabled", false) {
		add(formBaseline{
			ID:             "haproxy-stats-off",
			Category:       "logging",
			Severity:       "warn",
			Title:          "未开启 HAProxy 状态监控页",
			TitleEN:        "HAProxy stats monitoring page is off",
			Detail:         "开启后仅监听本机 127.0.0.1:8404，便于运维巡检后端健康状态与连接水位，不暴露外网。",
			DetailEN:       "Enabling exposes health and connection metrics on 127.0.0.1:8404 only for local inspection.",
			Current:        "关闭",
			CurrentEN:      "Off",
			Recommended:    "开启（127.0.0.1:8404）",
			RecommendedEN:  "On (127.0.0.1:8404)",
			Section:        "params",
			ActionLabel:    "开启状态页",
			ActionLabelEN:  "Enable stats",
			ActionPrompt:   "请开启 HAProxy 的本地监控状态页（stats_enabled=true），其余配置保持不变。",
			DefaultChecked: true,
		})
	}
	if len(inst.Hosts) >= 2 && hasVisibleParam(inst, "ha") && strings.TrimSpace(asString(inst.Params["ha"])) == "none" {
		add(formBaseline{
			ID:            "haproxy-no-vip",
			Category:      "ha",
			Severity:      "warn",
			Title:         "多节点 HAProxy 尚未启用 Keepalived VIP",
			TitleEN:       "Multi-node HAProxy lacks Keepalived VIP",
			Detail:        "已分配多台代理节点但未开启虚拟 IP，单节点故障时入口无法自动漂移。",
			DetailEN:      "Multiple proxy nodes are assigned without a virtual IP; traffic will not fail over automatically.",
			Current:       "无 VIP（ha=none）",
			CurrentEN:     "No VIP",
			Recommended:   "启用 Keepalived VIP",
			RecommendedEN: "Enable Keepalived VIP",
			Section:       "params",
			ActionLabel:   "配置 VIP",
			ActionLabelEN: "Configure VIP",
			ActionPrompt:  "请帮我为 HAProxy 启用 Keepalived 虚拟 IP，并用选项卡片询问 VIP 地址和承载网卡名。",
		})
	}
}

func evalNginxBaselines(inst *mwpack.Instance, add func(formBaseline)) {
	if len(inst.Hosts) >= 2 && hasVisibleParam(inst, "ha") && strings.TrimSpace(asString(inst.Params["ha"])) == "none" {
		add(formBaseline{
			ID:            "nginx-no-vip",
			Category:      "ha",
			Severity:      "warn",
			Title:         "多节点 Nginx 尚未启用 Keepalived VIP",
			TitleEN:       "Multi-node Nginx lacks Keepalived VIP",
			Detail:        "已分配多台代理节点但未配置虚拟 IP，建议开启 Keepalived 提供高可用入口。",
			DetailEN:      "Multiple Nginx nodes are placed without a VIP; enable Keepalived for automatic failover.",
			Current:       "无 VIP（ha=none）",
			CurrentEN:     "No VIP",
			Recommended:   "启用 Keepalived VIP",
			RecommendedEN: "Enable Keepalived VIP",
			Section:       "params",
			ActionLabel:   "配置 VIP",
			ActionLabelEN: "Configure VIP",
			ActionPrompt:  "请帮我为 Nginx 启用 Keepalived 虚拟 IP，并用选项卡片询问 VIP 地址和承载网卡名。",
		})
	}
}

func evalEtcdBaselines(inst *mwpack.Instance, add func(formBaseline)) {
	members := len(inst.Roles["member"])
	if members == 1 {
		add(formBaseline{
			ID:            "etcd-single-node",
			Category:      "ha",
			Severity:      "warn",
			Title:         "单节点 etcd 无高可用容灾",
			TitleEN:       "Single-node etcd has no fault tolerance",
			Detail:        "单节点故障会导致协调服务整体不可用；生产环境建议使用 3 台奇数节点组成 Raft 多数派。",
			DetailEN:      "A single etcd node has zero fault tolerance; 3 odd nodes are recommended for production quorum.",
			Current:       "1 节点",
			CurrentEN:     "1 node",
			Recommended:   "3 节点奇数集群",
			RecommendedEN: "3-node odd cluster",
			Section:       "placement",
		})
	} else if members > 1 && members%2 == 0 {
		add(formBaseline{
			ID:            "etcd-even-quorum",
			Category:      "ha",
			Severity:      "warn",
			Title:         fmt.Sprintf("etcd 节点数为偶数（%d 台）", members),
			TitleEN:       fmt.Sprintf("Even number of etcd members (%d)", members),
			Detail:        "偶数节点不会比少一台的奇数节点提供更高容错，反而增加投票脑裂概率；建议调整为奇数台（3 或 5 台）。",
			DetailEN:      "Even node counts do not improve fault tolerance over N-1 odd nodes and risk split votes; prefer 3 or 5 nodes.",
			Current:       fmt.Sprintf("%d 节点（偶数）", members),
			CurrentEN:     fmt.Sprintf("%d nodes (even)", members),
			Recommended:   fmt.Sprintf("%d 节点（奇数）", members+1),
			RecommendedEN: fmt.Sprintf("%d nodes (odd)", members+1),
			Section:       "placement",
		})
	}
	if strings.TrimSpace(asString(inst.Params["log_level"])) == "debug" {
		add(formBaseline{
			ID:             "etcd-log-debug",
			Category:       "logging",
			Severity:       "warn",
			Title:          "etcd 日志级别处于 debug（易产生高 I/O）",
			TitleEN:        "etcd log_level is set to debug",
			Detail:         "生产开启 debug 日志会显著增大磁盘写入与 WAL 竞争，建议调整为 info。",
			DetailEN:       "Debug logging increases disk I/O contention with etcd WAL; use info for production.",
			Current:        "debug",
			CurrentEN:      "debug",
			Recommended:    "info",
			RecommendedEN:  "info",
			Section:        "params",
			ActionLabel:    "改为 info",
			ActionLabelEN:  "Set info",
			ActionPrompt:   "请将 etcd 的日志级别（log_level）调整为 info，其余配置保持不变。",
			DefaultChecked: true,
		})
	}
}

// evalGenericSchemaBaselines handles any custom or workbench-authored component by inspecting
// declared schema params in logging / security groups.
func evalGenericSchemaBaselines(inst *mwpack.Instance, add func(formBaseline)) {
	if inst.R == nil {
		return
	}
	var offLogging []string
	for _, p := range inst.R.Params {
		if p.Locked || !inst.Visible[p.Key] {
			continue
		}
		if p.Group == "logging" {
			if p.Type == "bool" && !paramBool(inst, p.Key, true) {
				offLogging = append(offLogging, firstNonEmptyStr(p.Label, p.Key))
			} else if p.Type == "enum" && strings.EqualFold(strings.TrimSpace(asString(inst.Params[p.Key])), "debug") {
				offLogging = append(offLogging, firstNonEmptyStr(p.Label, p.Key)+"=debug")
			}
		}
	}
	if len(offLogging) > 0 {
		add(formBaseline{
			ID:             "generic-logging-baseline",
			Category:       "logging",
			Severity:       "warn",
			Title:          "组件日志基线存在未开启或调试项",
			TitleEN:        "Component logging baseline needs review",
			Detail:         fmt.Sprintf("以下日志参数处于关闭或调试级别：%s，建议按生产基线调整。", strings.Join(offLogging, "、")),
			DetailEN:       fmt.Sprintf("Review these logging parameters for production: %s.", strings.Join(offLogging, ", ")),
			Current:        strings.Join(offLogging, " / "),
			CurrentEN:      strings.Join(offLogging, " / "),
			Recommended:    "按生产日志基线开启",
			RecommendedEN:  "Enable production logging",
			Section:        "params",
			ActionLabel:    "按基线补齐日志",
			ActionLabelEN:  "Fix logging",
			ActionPrompt:   fmt.Sprintf("请检查并按生产基线开启 %s 的日志相关参数（%s），其余配置保持不变。", inst.Title, strings.Join(offLogging, "、")),
			DefaultChecked: true,
		})
	}
}

func evalAccessEntryBaseline(plan *mwpack.Plan, primary *mwpack.Instance, add func(formBaseline)) {
	if len(primary.Hosts) < 2 || len(primary.Fronts) > 0 {
		return
	}
	// Check whether the primary component offers at least one LB-allowed endpoint and isn't itself a balancer.
	if primary.R != nil && (primary.R.LB != nil || (primary.R.C != nil && containsStr(primary.R.C.Provides, "l4-lb"))) {
		return
	}
	hasAllowedEndpoint := false
	for _, ep := range primary.Endpoints {
		if ep.LB == "" || ep.LB == "allowed" {
			hasAllowedEndpoint = true
			break
		}
	}
	if !hasAllowedEndpoint {
		return
	}
	// Also check if another instance already binds to this primary.
	for _, other := range plan.Instances {
		if other != nil && len(other.Binds) > 0 {
			return
		}
	}
	add(formBaseline{
		ID:            "ha-no-access-entry",
		Category:      "ha",
		Severity:      "info",
		Title:         "多节点集群尚未配置统一访问入口",
		TitleEN:       "No unified access entry configured",
		Detail:        "主库切换后若无统一入口（云 ELB / HAProxy），应用端需手工修改数据库连接地址。",
		DetailEN:      "Without a unified LB entry (cloud ELB or HAProxy), applications must manually update endpoints after failover.",
		Current:       "直连节点 IP",
		CurrentEN:     "Direct host IPs",
		Recommended:   "接入云 ELB 或 HAProxy",
		RecommendedEN: "Cloud ELB or HAProxy",
		Section:       "access",
		ActionLabel:   "配置访问入口",
		ActionLabelEN: "Add access entry",
		ActionPrompt:  "请帮我为当前集群规划统一访问入口，用选项卡片让我选择接入客户已有云 ELB/F5 还是由平台部署 HAProxy。",
	})
}

// mergeAIBaselines appends optional contextual baseline notes proposed by the model
// (e.g., memory sizing vs user-stated host specs, compliance audit caveats) while
// deduplicating against platform-detected items and enforcing clean bounds.
func mergeAIBaselines(base []formBaseline, extra []formBaseline) []formBaseline {
	if len(extra) == 0 {
		return base
	}
	out := append([]formBaseline(nil), base...)
	seenID := map[string]bool{}
	seenTitle := map[string]bool{}
	for _, b := range out {
		seenID[b.ID] = true
		seenTitle[strings.ToLower(strings.TrimSpace(b.Title))] = true
	}
	validCat := map[string]bool{"storage": true, "logging": true, "security": true, "backup": true, "ha": true, "resource": true}
	validSev := map[string]bool{"action": true, "warn": true, "info": true}
	validSec := map[string]bool{"": true, "basics": true, "hosts": true, "placement": true, "params": true, "access": true}
	for i, item := range extra {
		title := truncRunes(strings.TrimSpace(item.Title), 60)
		detail := truncRunes(strings.TrimSpace(item.Detail), 160)
		if title == "" || detail == "" {
			continue
		}
		key := strings.ToLower(title)
		if seenTitle[key] {
			continue
		}
		id := strings.TrimSpace(item.ID)
		if id == "" {
			id = fmt.Sprintf("ai-baseline-%d", i+1)
		}
		if seenID[id] {
			continue
		}
		cat := strings.TrimSpace(item.Category)
		if !validCat[cat] {
			cat = "resource"
		}
		sev := strings.TrimSpace(item.Severity)
		if !validSev[sev] {
			sev = "info"
		}
		sec := strings.TrimSpace(item.Section)
		if !validSec[sec] {
			sec = "params"
		}
		out = append(out, formBaseline{
			ID:             id,
			Category:       cat,
			Severity:       sev,
			Title:          title,
			TitleEN:        truncRunes(strings.TrimSpace(item.TitleEN), 80),
			Detail:         detail,
			DetailEN:       truncRunes(strings.TrimSpace(item.DetailEN), 200),
			Current:        truncRunes(strings.TrimSpace(item.Current), 48),
			CurrentEN:      truncRunes(strings.TrimSpace(item.CurrentEN), 48),
			Recommended:    truncRunes(strings.TrimSpace(item.Recommended), 48),
			RecommendedEN:  truncRunes(strings.TrimSpace(item.RecommendedEN), 48),
			Section:        sec,
			ActionLabel:    truncRunes(strings.TrimSpace(item.ActionLabel), 24),
			ActionLabelEN:  truncRunes(strings.TrimSpace(item.ActionLabelEN), 28),
			ActionPrompt:   truncRunes(strings.TrimSpace(item.ActionPrompt), 240),
			DefaultChecked: false, // AI-proposed extras stay opt-in by default
		})
		seenID[id] = true
		seenTitle[key] = true
	}
	sortBaselines(out)
	if len(out) > 7 {
		out = out[:7]
	}
	return out
}

// formatBaselineSummaryForAI summarizes the evaluated baselines for the fill_form tool
// response so the assistant knows what the interactive BaselineCard already displays.
func formatBaselineSummaryForAI(items []formBaseline) string {
	if len(items) == 0 {
		return "\n生产基线巡检：常见生产基线项（存储、日志、安全、备份与高可用）均已满足，无需额外提醒卡片。"
	}
	var b strings.Builder
	b.WriteString("\n生产基线自动巡检（页面已自动渲染为「生产基线检查」交互卡片供用户勾选一键补齐，回复中用 1 句话引导查看卡片即可，不要逐条重复写成大段文字）：")
	for _, it := range items {
		sevLabel := map[string]string{"action": "需补齐", "warn": "建议关注", "info": "可选加固"}[it.Severity]
		if sevLabel == "" {
			sevLabel = "建议"
		}
		fmt.Fprintf(&b, "\n- [%s] %s", sevLabel, it.Title)
		if it.Current != "" && it.Recommended != "" {
			fmt.Fprintf(&b, "（当前：%s → 建议：%s）", it.Current, it.Recommended)
		}
	}
	return b.String()
}

func sortBaselines(items []formBaseline) {
	sevRank := map[string]int{"action": 0, "warn": 1, "info": 2}
	catRank := map[string]int{"storage": 0, "logging": 1, "security": 2, "backup": 3, "ha": 4, "resource": 5}
	sort.SliceStable(items, func(i, j int) bool {
		si, sj := sevRank[items[i].Severity], sevRank[items[j].Severity]
		if si != sj {
			return si < sj
		}
		return catRank[items[i].Category] < catRank[items[j].Category]
	})
}

func isStatefulComponent(name string) bool {
	switch name {
	case "postgresql", "patroni", "redis", "etcd":
		return true
	default:
		return false
	}
}

func hasVisibleParam(inst *mwpack.Instance, key string) bool {
	if inst == nil {
		return false
	}
	if inst.Visible != nil && inst.Visible[key] {
		return true
	}
	if inst.R != nil {
		for _, p := range inst.R.Params {
			if p.Key == key && p.When == "" && !p.Locked {
				return true
			}
		}
	}
	return false
}

func paramBool(inst *mwpack.Instance, key string, def bool) bool {
	if inst == nil || inst.Params == nil {
		return def
	}
	v, ok := inst.Params[key]
	if !ok || v == nil {
		return def
	}
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return strings.EqualFold(strings.TrimSpace(x), "true")
	default:
		return def
	}
}

func paramInt(inst *mwpack.Instance, key string) (int, bool) {
	if inst == nil || inst.Params == nil {
		return 0, false
	}
	v, ok := inst.Params[key]
	if !ok || v == nil {
		return 0, false
	}
	switch x := v.(type) {
	case int:
		return x, true
	case int64:
		return int(x), true
	case float64:
		return int(x), true
	default:
		return 0, false
	}
}

func asString(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

import { sameScheme, SchemeInfo } from "../../design/scheme";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Drawer,
  Input,
  Select,
  Skeleton,
  Tag,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCheck,
  IconCopy,
  IconDesktop,
  IconDown,
  IconDownload,
  IconEdit,
  IconEye,
  IconEyeInvisible,
  IconFile,
  IconInfoCircle,
  IconLink,
  IconRefresh,
  IconRight,
  IconSearch,
} from "@arco-design/web-react/icon";
import {
  ago,
  api,
  can,
  copy,
  fullTime,
  platformShort,
  useConnectivity,
} from "../../shared/shared";
import type {
  ChangeRehearsal,
  ClusterView,
  HostSpec,
  InstanceView,
  JobDetail,
  ParamDef,
  PlanEntry,
  Schema,
} from "../../shared/shared";
import { go } from "../../app/router";
import { AppGlyph, Segmented } from "../../design/ui";
import { cachedDetail, putDetailCache, subscribeDetailCache } from "./deliveries";
import {
  buildClusterStackPills,
  computeEffectiveClusterChanges,
  hostStorage,
  lazySubView,
  localizeEndpointTitle,
  localizePortName,
  packageUpstreamVersion,
  type EffectiveClusterChange,
} from "./topology";
import { bi, useLang, withLang } from "../../app/i18n";
import "./clusterconfig.css";

const LazyImportedBaselineModal = lazySubView(() =>
  import("./importcluster").then((m) => ({ default: m.ImportedBaselineModal })),
);

const schemaCache = new Map<string, Schema>();
if (typeof window !== "undefined") {
  window.addEventListener("mh-lang-change", () => schemaCache.clear());
}

const completed = (p: PlanEntry) =>
  p.outcome === "done" || p.outcome === "deviated";
const titleOf = (p: PlanEntry) =>
  p.delivery_mode === "imported"
    ? bi("存量纳管基线", "Imported Baseline")
    : p.delivery_mode === "configuration"
      ? bi("配置交付", "Config Delivery")
      : completed(p)
        ? bi("初始部署基线", "Initial Baseline")
        : bi("部署交付", "Deployment Delivery");
const SECRET_KEY_RE =
  /(password|passwd|pwd|secret|token|requirepass|access_key|secret_key|auth_key|private_key|admin_pass|repl_pass|superuser_pass)/i;

const raw = (v: unknown): string =>
  typeof v === "string" ? v : (JSON.stringify(v) ?? "");
const display = (v: unknown): string =>
  v === true
    ? bi("开启", "On")
    : v === false
      ? bi("关闭", "Off")
      : v === "" || v == null
        ? bi("未设置", "Unset")
        : Array.isArray(v)
          ? v.map(raw).join(bi("、", ", ")) || bi("无", "None")
          : raw(v);
const schemaKey = (i: InstanceView) => `${i.component}@${i.version}`;
const normParamKey = (k: string) =>
  k.trim().toLowerCase().replace(/-/g, "_");

// Patroni HA & replication orchestration keys (separated cleanly from PostgreSQL DB params)
const PATRONI_PARAM_KEY_RE =
  /^(patroni_|restapi_|deployment_mode$|replication$|sync_ack_count$|sync_strict$|clonefrom_node$|synchronous_commit$|maximum_lag_on_failover$|failover_|loop_wait$|retry_timeout$|ttl$)/i;

function isPatroniParam(key: string, defGroup?: string): boolean {
  if (defGroup === "patroni" || defGroup === "replication") return true;
  return PATRONI_PARAM_KEY_RE.test(key.trim());
}

function hasEmbeddedPatroni(pg: InstanceView, all: InstanceView[]): boolean {
  if (pg.component !== "postgresql" || pg.external) return false;
  if (all.some((i) => i.component === "patroni")) return false;
  const dm = String(pg.params?.deployment_mode || "").toLowerCase();
  if (dm === "single" || dm === "replication") return false;
  if (dm === "patroni") return true;
  const hasReplica = (pg.roles?.replica || []).length > 0;
  const hasPatroniKeys =
    (Object.hasOwn(pg.params || {}, "patroni_ttl") &&
      pg.visible?.patroni_ttl !== false) ||
    (Object.hasOwn(pg.params || {}, "restapi_port") &&
      pg.visible?.restapi_port !== false);
  return hasReplica && hasPatroniKeys;
}

const COMPONENT_KEY_HINTS: [RegExp, string[]][] = [
  [PATRONI_PARAM_KEY_RE, ["patroni", "postgresql"]],
  [
    /^(pg_|postgres|log_|logging_|wal_|max_connections|shared_buffers|work_mem|maintenance_work_mem|effective_cache|checkpoint|autovacuum|archive_|hot_standby|max_wal|min_wal|idle_in_transaction|statement_timeout|ssl_)/i,
    ["postgresql"],
  ],
  [
    /^(etcd|quota_backend|heartbeat_interval|election_timeout|auto_compaction|snapshot_count)/i,
    ["etcd"],
  ],
  [
    /^(redis|maxmemory|appendonly|appendfsync|requirepass|masterauth|sentinel|hz|tcp_keepalive|databases|save)/i,
    ["redis"],
  ],
  [
    /^(nginx|worker_processes|worker_connections|keepalive_timeout|client_max_body|gzip|upstream|proxy_)/i,
    ["nginx"],
  ],
  [
    /^(haproxy|maxconn|timeout_connect|timeout_client|timeout_server|balance)/i,
    ["haproxy"],
  ],
  [
    /^(keepalived|vrrp|virtual_ip|unicast_peer|priority|advert_int)/i,
    ["keepalived"],
  ],
];

// Built-in bilingual labels for common runtime-added parameters not present in Day-0 schema
const RUNTIME_PARAM_LABELS: Record<string, [string, string]> = {
  pg_hba: ["客户端认证规则", "Client Auth Rules (pg_hba)"],
  logging_collector: ["日志落盘采集器", "Log Collector"],
  log_directory: ["日志输出目录", "Log Directory"],
  log_filename: ["日志文件命名格式", "Log Filename Pattern"],
  log_rotation_age: ["日志按时间轮转周期", "Log Rotation Age"],
  log_rotation_size: ["单日志文件轮转上限", "Log Rotation Size"],
  log_truncate_on_rotation: ["轮转时覆盖同名日志", "Truncate on Rotation"],
  log_line_prefix: ["日志行前缀格式", "Log Line Prefix"],
  log_statement: ["SQL 语句记录级别", "SQL Statement Logging"],
  log_min_duration_statement: ["慢 SQL 阈值", "Slow Query Threshold"],
  log_destination: ["日志输出目标", "Log Destination"],
  log_timezone: ["日志时区", "Log Timezone"],
  wal_level: ["WAL 日志级别", "WAL Level"],
  archive_mode: ["WAL 归档开关", "Archive Mode"],
  archive_command: ["WAL 归档命令", "Archive Command"],
  statement_timeout: ["单语句执行超时", "Statement Timeout"],
  lock_timeout: ["锁等待超时", "Lock Timeout"],
  synchronous_standby_names: ["同步从库配置", "Synchronous Standby Names"],
  maxmemory: ["最大内存上限", "Max Memory"],
  maxmemory_policy: ["内存淘汰策略", "Eviction Policy"],
  appendonly: ["AOF 持久化开关", "Append-Only File"],
  appendfsync: ["AOF 刷盘策略", "AOF Fsync Policy"],
};

function friendlyParamLabel(key: string, def?: ParamDef): string {
  if (def?.label) return def.label;
  const hit = RUNTIME_PARAM_LABELS[normParamKey(key)];
  if (hit) return bi(hit[0], hit[1]);
  return key;
}

type DisplayInstance = InstanceView & {
  /** Legacy PostgreSQL cluster where Patroni was bundled into the PG instance */
  embeddedFrom?: string;
  /** Real companion ID (split mode) or virtual ID (legacy mode) when PG & Patroni are partitioned */
  partitionPeerId?: string;
  /** Schema lookup override for virtual embedded Patroni view */
  schemaLookupKey?: string;
};

type ParamRow = {
  key: string;
  value: unknown;
  def?: ParamDef;
  group: string;
  label: string;
  specified: boolean;
  active: boolean;
  applied?: EffectiveClusterChange;
  runtimeAdded?: boolean;
};

type SearchHit = {
  id: string;
  section: string;
  title: string;
  context: string;
  value: string;
  focus?: string;
};

function CopyValue({ value, label }: { value: unknown; label: string }) {
  useLang();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const text = raw(value);
  return text ? (
    <Tooltip
      content={copied ? bi("已复制", "Copied") : bi(`复制${label}`, `Copy ${label}`)}
      mini
    >
      <button
        type="button"
        className={`cx-copy ${copied ? "copied" : ""}`}
        onClick={() => {
          copy(text);
          setCopied(true);
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        }}
        aria-label={
          copied
            ? bi(`已复制${label}`, `Copied ${label}`)
            : bi(`复制${label}`, `Copy ${label}`)
        }
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
    </Tooltip>
  ) : null;
}

function Empty({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="cx-empty" role="status">
      <IconFile />
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}

/** Saved values only. Today's schema supplies labels, never values or defaults. */
export function ClusterConfig({
  c,
  source,
  section,
  rehearsals,
}: {
  c: ClusterView;
  source?: string;
  section?: string;
  rehearsals?: ChangeRehearsal[] | null;
}) {
  useLang();
  const plans = Array.isArray(c.plans) ? c.plans : [];
  const id = source || c.current || c.head || plans[0]?.id;
  const p = plans.find((entry) => entry.id === id);
  if (!p)
    return (
      <Empty
        title={
          source
            ? bi("找不到这份交付", "Delivery not found")
            : bi("还没有配置记录", "No configuration records")
        }
        text={
          source
            ? bi(
                "这份交付不属于当前集群，或已被删除。",
                "This delivery does not belong to this cluster or was deleted.",
              )
            : bi(
                "提交部署规格后，可以在这里查看配置。",
                "Configuration will appear here after submitting a deployment spec.",
              )
        }
      >
        {source && (
          <Button
            onClick={() =>
              go(
                { name: "deliveries", id: c.id, tab: "config" },
                { replace: true },
              )
            }
          >
            {bi("查看当前配置", "View Current Config")}
          </Button>
        )}
      </Empty>
    );
  return (
    <ConfigRecord
      key={p.id}
      c={c}
      p={p}
      source={source}
      section={section}
      rehearsals={rehearsals}
    />
  );
}

function ConfigRecord({
  c,
  p,
  source,
  section,
  rehearsals,
}: {
  c: ClusterView;
  p: PlanEntry;
  source?: string;
  section?: string;
  rehearsals?: ChangeRehearsal[] | null;
}) {
  const lang = useLang();
  const [data, setData] = useState<JobDetail | null>(() => cachedDetail(p.id));
  const [loading, setLoading] = useState(() => !cachedDetail(p.id));
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [schemas, setSchemas] = useState<Record<string, Schema>>(() => {
    const hit = cachedDetail(p.id);
    const rawInsts = hit?.plan?.instances || hit?.spec?.deployment?.instances || [];
    const init: Record<string, Schema> = {};
    for (const i of rawInsts) {
      const k = `${i.component}@${i.version || ""}`;
      const s = schemaCache.get(k);
      if (s) init[k] = s;
    }
    return init;
  });
  const [schemaError, setSchemaError] = useState(false);
  const [schemaRetry, setSchemaRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [focusKey, setFocusKey] = useState("");
  const [rawView, setRawView] = useState("yaml");
  const [roleFilter, setRoleFilter] = useState("all");
  const [paramFilter, setParamFilter] = useState<"all" | "changed" | "specified">("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<Record<string, boolean>>({});
  const [shownSecrets, setShownSecrets] = useState<Record<string, boolean>>({});
  const [rawCopied, setRawCopied] = useState(false);
  const rawCopyTimer = useRef<number | null>(null);
  const detail = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const net = useConnectivity();
  useEffect(
    () => () => {
      if (rawCopyTimer.current) window.clearTimeout(rawCopyTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!historyOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setHistoryOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [historyOpen]);
  useEffect(
    () =>
      subscribeDetailCache((changedId, next) => {
        if (changedId === p.id) {
          setData(next);
          setLoading(false);
          setError("");
        }
      }),
    [p.id],
  );
  useEffect(() => {
    const abort = new AbortController();
    if (!cachedDetail(p.id)) setLoading(true);
    setError("");
    api<JobDetail>(`/api/jobs/${encodeURIComponent(p.id)}`, {
      signal: abort.signal,
      cache: "no-store",
    })
      .then((d) => {
        if (!abort.signal.aborted) {
          putDetailCache(p.id, d);
          setData(d);
        }
      })
      .catch((e: Error & { status?: number }) => {
        if (!abort.signal.aborted) {
          setError(e.message);
          if ([401, 403, 404].includes(e.status || 0)) setData(null);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [p.id, retry, lang]);

  const dep = data?.spec?.deployment;
  const plan = data?.plan;
  const rawInstances = useMemo<InstanceView[]>(
    () =>
      (Array.isArray(plan?.instances) ? plan.instances : null) ||
      (Array.isArray(dep?.instances) ? dep.instances : []).map((i) => ({
        id: i.id,
        component: i.component,
        title: i.component,
        version: i.version || "",
        status: "",
        roles: i.placement || {},
        hosts: [...new Set(Object.values(i.placement || {}).flat().filter(Boolean))],
        params: i.params || {},
        visible: {},
      })),
    [plan, dep],
  );

  // Build consistent, deduplicated display instances:
  // 1) Split PG+Patroni clusters: partition PG DB params vs Patroni HA params cleanly (no 62-vs-62 duplication).
  // 2) Legacy bundled PG+Patroni clusters: expose a clean Patroni view extracted from the bundled PG instance.
  // 3) Sort tabs deterministically: Primary app -> Patroni -> etcd -> LB/VIP -> others -> External LB.
  const displayInstances = useMemo<DisplayInstance[]>(() => {
    const out: DisplayInstance[] = [];
    const realPatroni = rawInstances.find((i) => i.component === "patroni");

    for (const inst of rawInstances) {
      if (inst.component === "postgresql" && realPatroni) {
        out.push({ ...inst, partitionPeerId: realPatroni.id });
      } else if (inst.component === "patroni" && rawInstances.some((x) => x.component === "postgresql")) {
        const pg = rawInstances.find((x) => x.component === "postgresql")!;
        out.push({ ...inst, partitionPeerId: pg.id });
      } else if (hasEmbeddedPatroni(inst, rawInstances)) {
        const virtId = `${inst.id}-patroni`;
        out.push({ ...inst, partitionPeerId: virtId });
        const dcsInst = rawInstances.find((x) => x.component === "etcd");
        out.push({
          id: virtId,
          component: "patroni",
          title: "Patroni",
          version: packageUpstreamVersion(inst.packages, /patroni/i),
          status: inst.status,
          auto: true,
          auto_reason: bi(
            "旧版一体化交付 · 随 PostgreSQL 同包部署",
            "Legacy bundled delivery · deployed with PostgreSQL",
          ),
          roles: inst.roles,
          role_titles: inst.role_titles,
          hosts: inst.hosts,
          params: inst.params,
          visible: inst.visible,
          uses: dcsInst
            ? {
                dcs: {
                  capability: "dcs",
                  instance: dcsInst.id,
                  component: dcsInst.component,
                },
              }
            : undefined,
          embeddedFrom: inst.id,
          partitionPeerId: inst.id,
          schemaLookupKey: schemaKey(inst),
        });
      } else {
        out.push({ ...inst });
      }
    }

    const rankOf = (i: DisplayInstance): number => {
      if (i.external) return 50;
      if (i.component === c.app_id) return 10;
      if (i.component === "patroni") return 20;
      if (i.component === "etcd") return 30;
      if (["haproxy", "nginx", "keepalived"].includes(i.component)) return 35;
      return 40;
    };
    return out.sort((a, b) => rankOf(a) - rankOf(b));
  }, [rawInstances, c.app_id, lang]);

  const hosts: HostSpec[] =
    (Array.isArray(dep?.hosts) ? dep.hosts : null) ||
    (Array.isArray(plan?.hosts) ? plan.hosts : null) ||
    [];
  const controller = plan?.controller || dep?.controller;
  const isImported = c.delivery_mode === "imported";
  const skipCatalogSchema = isImported && c.imported?.managed_catalog === false;
  const keys = rawInstances.map(schemaKey).join("|");
  useEffect(() => {
    if (!rawInstances.length || skipCatalogSchema) {
      setSchemaError(false);
      return;
    }
    const abort = new AbortController();
    setSchemaError(false);
    const unique = [
      ...new Map(rawInstances.map((i) => [schemaKey(i), i])).values(),
    ];
    Promise.allSettled(
      unique.map((i) => {
        const k = schemaKey(i);
        const cachedSchema = schemaRetry === 0 ? schemaCache.get(k) : undefined;
        if (cachedSchema) return Promise.resolve([k, cachedSchema] as const);
        return api<Schema>(
          `/api/components/${encodeURIComponent(i.component)}${i.version ? `?version=${encodeURIComponent(i.version)}` : ""}`,
          { signal: abort.signal },
        ).then((s) => {
          schemaCache.set(k, s);
          return [k, s] as const;
        });
      }),
    ).then((results) => {
      if (abort.signal.aborted) return;
      setSchemas(
        Object.fromEntries(
          results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
        ),
      );
      setSchemaError(!isImported && results.some((r) => r.status === "rejected"));
    });
    return () => abort.abort();
  }, [keys, schemaRetry, lang, skipCatalogSchema, isImported]);

  const schemaFor = (i: DisplayInstance): Schema | undefined =>
    schemas[i.schemaLookupKey || schemaKey(i)];

  const ownsParamKey = (
    i: DisplayInstance,
    key: string,
    defGroup?: string,
  ): boolean => {
    if (!i.partitionPeerId) return true;
    const patroniKey = isPatroniParam(key, defGroup);
    if (i.component === "patroni") return patroniKey;
    if (i.component === "postgresql") return !patroniKey;
    return true;
  };

  const current = p.id === c.current;
  const appliedList = useMemo(
    () =>
      (rehearsals || [])
        .filter((x) => x.stage === "finalized" && x.applied && !x.voided)
        .slice()
        .sort((a, b) =>
          (b.applied_at || b.updated_at || "").localeCompare(
            a.applied_at || a.updated_at || "",
          ),
        ),
    [rehearsals],
  );
  const effectiveChanges = useMemo(
    () =>
      current || !c.current
        ? computeEffectiveClusterChanges(appliedList)
        : {
            items: [] as EffectiveClusterChange[],
            latestByKey: new Map<string, EffectiveClusterChange>(),
          },
    [appliedList, current, c.current],
  );

  // Assign each merged effective production change to its owning display instance.
  const effectiveByInstance = useMemo(() => {
    const map = new Map<string, EffectiveClusterChange[]>();
    const nonExt = displayInstances.filter((i) => !i.external);
    if (!nonExt.length || !effectiveChanges.items.length) return map;
    const primary =
      nonExt.find((i) => i.component === c.app_id) || nonExt[0];
    const patroniInst = nonExt.find((i) => i.component === "patroni");
    const ordered = primary
      ? [primary, ...nonExt.filter((i) => i.id !== primary.id)]
      : nonExt;

    const push = (instId: string, ef: EffectiveClusterChange) => {
      const list = map.get(instId);
      if (list) list.push(ef);
      else map.set(instId, [ef]);
    };

    for (const ef of effectiveChanges.items) {
      const nk = normParamKey(ef.key);
      // 0) Explicit Patroni HA key routing when Patroni view exists
      if (patroniInst && isPatroniParam(ef.key)) {
        push(patroniInst.id, ef);
        continue;
      }
      // 1) Exact / normalized match in Day-0 owned instance params
      let owner = ordered.find((i) => {
        const s = schemaFor(i);
        const defs = new Map((s?.params || []).map((d) => [normParamKey(d.key), d]));
        return Object.keys(i.params || {}).some((k) => {
          const kn = normParamKey(k);
          return kn === nk && ownsParamKey(i, k, defs.get(kn)?.group);
        });
      });
      // 2) Exact / normalized match in component schema param definitions
      if (!owner) {
        owner = ordered.find((i) =>
          (schemaFor(i)?.params || []).some(
            (d) => normParamKey(d.key) === nk && ownsParamKey(i, d.key, d.group),
          ),
        );
      }
      // 3) Keyword/prefix affinity match
      if (!owner) {
        const hint = COMPONENT_KEY_HINTS.find(([re]) => re.test(ef.key));
        if (hint) {
          owner = ordered.find((i) => hint[1].includes(i.component));
        }
      }
      // 4) Fallback to primary app instance
      push((owner || primary).id, ef);
    }
    return map;
  }, [displayInstances, schemas, effectiveChanges.items, c.app_id]);

  const runtimeGroupLabel = bi("运行期生产变更", "Production Runtime Changes");

  const parameterRows = useMemo(
    () =>
      new Map(
        displayInstances.map((i) => {
          const s = schemaFor(i);
          const sourceSpecId = i.embeddedFrom || i.id;
          const explicit =
            (Array.isArray(dep?.instances) ? dep.instances : []).find(
              (sp) => sp.id === sourceSpecId,
            )?.params || {};
          const defs = new Map((s?.params || []).map((d) => [d.key, d]));
          const defsNorm = new Map(
            (s?.params || []).map((d) => [normParamKey(d.key), d]),
          );
          const order = new Map(
            (s?.params || []).map((d, index) => [d.key, index]),
          );
          const instChanges = effectiveByInstance.get(i.id) || [];
          const changeByNorm = new Map(
            instChanges.map((ef) => [normParamKey(ef.key), ef]),
          );
          const matchedNorms = new Set<string>();

          const baseRows: ParamRow[] = Object.entries(i.params || {})
            .filter(([key]) => ownsParamKey(i, key, defs.get(key)?.group))
            .map(([key, value]) => {
              const def = defs.get(key);
              const nk = normParamKey(key);
              const applied = changeByNorm.get(nk);
              if (applied) matchedNorms.add(nk);
              const defaultGroup =
                i.component === "patroni" && key === "restapi_port"
                  ? bi("管理接口", "Management API")
                  : s?.groups?.find((g) => g.id === def?.group)?.label ||
                    bi("其他参数", "Other parameters");
              return {
                key,
                value,
                def,
                group: defaultGroup,
                label: friendlyParamLabel(key, def),
                specified: Object.hasOwn(explicit, key),
                active: i.visible?.[key] !== false,
                applied,
              };
            })
            .sort((a, b) => {
              // Keep active params above inactive params within the same group, preserving schema order
              if (a.group === b.group && a.active !== b.active) {
                return a.active ? -1 : 1;
              }
              return (order.get(a.key) ?? 9999) - (order.get(b.key) ?? 9999);
            });

          // Synthesize runtime-added params (e.g. logging_collector, pg_hba) directly inside this component
          const extraRows: ParamRow[] = instChanges
            .filter((ef) => !matchedNorms.has(normParamKey(ef.key)))
            .map((ef) => {
              const def = defsNorm.get(normParamKey(ef.key));
              return {
                key: ef.key,
                value: ef.after,
                def,
                group: runtimeGroupLabel,
                label: friendlyParamLabel(ef.key, def),
                specified: false,
                active: true,
                applied: ef,
                runtimeAdded: true,
              };
            });

          return [i.id, [...extraRows, ...baseRows]] as [string, ParamRow[]];
        }),
      ),
    [displayInstances, schemas, dep, lang, effectiveByInstance, runtimeGroupLabel],
  );

  const rowsFor = (i: DisplayInstance): ParamRow[] =>
    parameterRows.get(i.id) || [];

  const routes = rawInstances.flatMap((i) =>
    (i.endpoints || []).map((ep) => ({ i, ep, front: i.fronts?.[ep.name] })),
  );
  const portRows = rawInstances.flatMap((i) =>
    (i.ports || []).map((port) => ({ i, port })),
  );

  const nav = [
    {
      id: "hosts",
      label: bi("机器与角色", "Hosts & Roles"),
      note:
        hosts.length === 1
          ? bi("1 台", "1 host")
          : bi(`${hosts.length} 台`, `${hosts.length} hosts`),
      icon: <IconDesktop />,
      changeCount: 0,
      embedded: false,
    },
    {
      id: "access",
      label: bi("访问入口", "Access Endpoints"),
      note:
        routes.length === 1
          ? bi("1 个端点", "1 endpoint")
          : bi(`${routes.length} 个端点`, `${routes.length} endpoints`),
      icon: <IconLink />,
      changeCount: 0,
      embedded: false,
    },
    ...displayInstances.map((i) => ({
      id: `component:${i.id}`,
      label: i.external ? bi("外部负载均衡", "External LB") : i.title,
      note: i.embeddedFrom
        ? bi("随 PostgreSQL 内置", "Bundled with PostgreSQL")
        : i.id,
      icon: (
        <AppGlyph
          id={i.component}
          icon={i.component === c.app_id ? c.icon : undefined}
          color={i.component === c.app_id ? c.imported?.color : undefined}
          size={18}
        />
      ),
      changeCount: (effectiveByInstance.get(i.id) || []).length,
      embedded: Boolean(i.embeddedFrom),
    })),
    {
      id: "spec",
      label: bi("原始规格", "Raw Spec"),
      note: "YAML / JSON",
      icon: <IconFile />,
      changeCount: 0,
      embedded: false,
    },
  ];
  const selected = section || "hosts";
  const active = nav.find((n) => n.id === selected);
  const pendingFilterRef = useRef<"all" | "changed" | "specified" | null>(null);

  useEffect(() => {
    const list = navigation.current;
    const button = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !button || list.scrollWidth <= list.clientWidth) return;
    const bounds = list.getBoundingClientRect();
    const item = button.getBoundingClientRect();
    if (item.left < bounds.left) list.scrollLeft -= bounds.left - item.left;
    else if (item.right > bounds.right)
      list.scrollLeft += item.right - bounds.right;
  }, [selected, data]);

  const instance = displayInstances.find((i) => `component:${i.id}` === selected);

  useEffect(() => {
    if (pendingFilterRef.current) {
      setParamFilter(pendingFilterRef.current);
      pendingFilterRef.current = null;
    } else {
      setParamFilter("all");
    }
    setGroupFilter("all");
  }, [selected]);

  const navigate = (
    next: string,
    focus = "",
    initialFilter: "all" | "changed" | "specified" = "all",
  ) => {
    setQuery("");
    setFocusKey(focus);
    setGroupFilter("all");
    if (next === "hosts") setRoleFilter("all");
    if (next.startsWith("component:")) {
      if (next === selected) {
        setParamFilter(initialFilter);
      } else {
        pendingFilterRef.current = initialFilter;
      }
    }
    go({ name: "deliveries", id: c.id, tab: "config", source, section: next });
  };

  useEffect(() => {
    if (!focusKey || query) return;
    const row = [
      ...(detail.current?.querySelectorAll<HTMLElement>("[data-config-key]") ||
        []),
    ].find((el) => el.dataset.configKey === focusKey);
    row?.scrollIntoView({ block: "center", behavior: "instant" });
    row?.focus({ preventScroll: true });
  }, [selected, focusKey, query]);

  const isSecretRow = (r: ParamRow) =>
    SECRET_KEY_RE.test(r.key) &&
    typeof r.value === "string" &&
    r.value.length > 0;

  const hits: SearchHit[] = [
    ...hosts.map((h) => {
      const storage = hostStorage(h, {
        imported: isImported,
        importedDataDirs: c.imported?.data_dirs,
      });
      const storageSummary = storage.path
        ? `${storage.label} ${storage.path}`
        : storage.label;
      return {
        id: `host:${h.name}`,
        section: "hosts",
        title: h.name,
        context: `${bi("机器", "Host")} · ${storageSummary}${h.name === controller ? bi(" · 控制节点", " · Controller") : ""}${
          displayInstances.some((i) => !i.external && (i.hosts || []).includes(h.name))
            ? ` · ${displayInstances
                .filter((i) => !i.external && (i.hosts || []).includes(h.name))
                .map((i) => {
                  const roles = Object.entries(i.roles || {})
                    .filter(([, hs]) => (hs || []).includes(h.name))
                    .map(([role]) => `${i.role_titles?.[role] || role} ${role}`)
                    .join(bi("、", ", "));
                  return roles
                    ? `${i.title}${bi("（", " (")}${roles}${bi("）", ")")}`
                    : i.title;
                })
                .join(" / ")}`
            : ""
        }`,
        value: h.ip,
        focus: `host:${h.name}`,
      };
    }),
    ...displayInstances.flatMap((i) =>
      rowsFor(i).map((r) => ({
        id: `${i.id}.${r.key}`,
        section: `component:${i.id}`,
        title: r.label !== r.key ? `${r.label} · ${r.key}` : r.key,
        context: `${i.title} · ${r.group}`,
        value: isSecretRow(r)
          ? "••••••••"
          : r.applied
            ? `${r.applied.before ? `${r.applied.before} → ` : ""}${r.applied.after}`
            : display(r.value),
        focus: r.key,
      })),
    ),
    ...routes.map(({ i, ep, front }) => {
      const epLabel =
        /^(readwrite|readonly|admin|writer|reader)$/i.test((ep.title || "").trim()) || !ep.title
          ? localizeEndpointTitle(ep.title || ep.name, ep.name)
          : ep.title;
      return {
        id: `endpoint:${i.id}.${ep.name}`,
        section: "access",
        title: `${i.title} · ${epLabel}`,
        context: `${(ep.protocol || "").toUpperCase()} · ${front ? `${front.balancer} · ${front.resolve_ip || ""}` : bi("节点直连", "Direct node access")}`,
        value: front
          ? `${front.address}:${front.listen} → ${bi("后端", "backend")} ${ep.port}`
          : (ep.backends || [])
              .map((b) => `${b.ip}:${b.port}`)
              .join(bi("、", ", ")),
        focus: `endpoint:${i.id}.${ep.name}`,
      };
    }),
  ];

  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const results = hits.filter((h) =>
    tokens.every((t) => {
      const searchable =
        h.value === "••••••••"
          ? `${h.title} ${h.context}`
          : `${h.title} ${h.context} ${h.value}`;
      return searchable.toLocaleLowerCase().includes(t);
    }),
  );

  const stateLabel =
    p.outcome === "void"
      ? bi("已作废的交付", "Voided delivery")
      : p.state === "failed"
        ? bi("生成失败 · 提交配置", "Build failed · Submitted")
        : completed(p)
          ? current
            ? bi("当前配置", "Current config")
            : bi("历史配置", "Historical config")
          : current
            ? bi("交付配置", "Delivery config")
            : bi("交付目标", "Target config");

  const yaml = data?.spec?.yaml;
  const generated = plan
    ? JSON.stringify(
        {
          cluster: plan.cluster,
          controller: plan.controller,
          hosts: plan.hosts,
          instances: plan.instances,
        },
        null,
        2,
      )
    : undefined;
  const specFile = (data?.files || []).find(
    (f) => f.name === "部署规格.yml" || f.name === "deployment-spec.yml",
  );

  const nonExternalInstances = displayInstances.filter((i) => !i.external);

  // Deduplicate identical role filters (e.g. PostgreSQL · 主库 & Patroni · 主库 share the exact same host list)
  const roleOptions = useMemo(() => {
    const opts: {
      id: string;
      label: string;
      match: (h: HostSpec) => boolean;
      count: number;
    }[] = [
      {
        id: "all",
        label: bi("全部", "All"),
        match: () => true,
        count: hosts.length,
      },
    ];
    if (
      controller &&
      hosts.length > 1 &&
      hosts.some((h) => h.name === controller)
    ) {
      opts.push({
        id: "controller",
        label: bi("控制节点", "Controller"),
        match: (h) => h.name === controller,
        count: 1,
      });
    }
    const seenByRoleHosts = new Map<string, number>();
    const realNonExt = nonExternalInstances.filter((i) => !i.embeddedFrom);
    for (const i of realNonExt) {
      for (const [role, hs] of Object.entries(i.roles || {})) {
        const matchedHosts = (hs || [])
          .filter((name) => hosts.some((h) => h.name === name))
          .slice()
          .sort();
        const count = matchedHosts.length;
        if (!count || count === hosts.length) continue;
        const roleLabel = i.role_titles?.[role] || role;
        const sig = `${role}:${matchedHosts.join(",")}`;
        const existingIdx = seenByRoleHosts.get(sig);
        if (existingIdx !== undefined) {
          // Merge co-located roles cleanly (e.g. "PostgreSQL / Patroni · 主库")
          const prev = opts[existingIdx];
          if (!prev.label.includes(i.title)) {
            const parts = prev.label.split(" · ");
            prev.label =
              parts.length === 2
                ? `${parts[0]} / ${i.title} · ${parts[1]}`
                : `${prev.label} / ${i.title}`;
          }
          continue;
        }
        seenByRoleHosts.set(sig, opts.length);
        opts.push({
          id: `role:${i.id}:${role}`,
          label:
            realNonExt.length > 1 ? `${i.title} · ${roleLabel}` : roleLabel,
          match: (h) => (Array.isArray(hs) ? hs : []).includes(h.name),
          count,
        });
      }
    }
    return opts;
  }, [hosts, controller, nonExternalInstances, lang]);

  const activeRoleOption =
    roleOptions.find((o) => o.id === roleFilter) || roleOptions[0];
  const filteredHosts = activeRoleOption
    ? hosts.filter(activeRoleOption.match)
    : hosts;

  const allInstanceRows = instance ? rowsFor(instance) : [];
  const changedCount = allInstanceRows.filter((r) => Boolean(r.applied)).length;
  const specifiedCount = allInstanceRows.filter((r) => r.specified).length;
  const canFilterSpecified =
    Boolean(plan) && specifiedCount > 0 && specifiedCount < allInstanceRows.length;
  const canFilterRows = changedCount > 0 || canFilterSpecified;

  const scopeFilteredRows =
    paramFilter === "changed" && changedCount > 0
      ? allInstanceRows.filter((r) => Boolean(r.applied))
      : paramFilter === "specified" && canFilterSpecified
        ? allInstanceRows.filter((r) => r.specified)
        : allInstanceRows;

  const allParamGroups = useMemo(() => {
    if (!instance) return [] as { name: string; count: number; isRuntime: boolean }[];
    const seen = new Map<string, number>();
    for (const r of scopeFilteredRows) {
      seen.set(r.group, (seen.get(r.group) || 0) + 1);
    }
    return [...seen.entries()].map(([name, count]) => ({
      name,
      count,
      isRuntime: name === runtimeGroupLabel,
    }));
  }, [instance, scopeFilteredRows, runtimeGroupLabel]);

  const activeGroupFilter =
    groupFilter !== "all" && allParamGroups.some((g) => g.name === groupFilter)
      ? groupFilter
      : "all";

  const visibleGroups =
    activeGroupFilter === "all"
      ? allParamGroups
      : allParamGroups.filter((g) => g.name === activeGroupFilter);

  const visibleInstanceRows =
    activeGroupFilter === "all"
      ? scopeFilteredRows
      : scopeFilteredRows.filter((r) => r.group === activeGroupFilter);

  const primaryChangedInstanceId = useMemo(() => {
    let best = "";
    let max = 0;
    for (const [id, list] of effectiveByInstance.entries()) {
      if (list.length > max) {
        best = id;
        max = list.length;
      }
    }
    return best;
  }, [effectiveByInstance]);

  // Effective JSON payload for "Copy all parameters" on the active component tab
  const effectiveCopyPayload = useMemo(() => {
    if (!instance) return null;
    const obj: Record<string, unknown> = {};
    for (const r of allInstanceRows) {
      obj[r.key] = r.applied ? r.applied.after : r.value;
    }
    return obj;
  }, [instance, allInstanceRows]);

  const [baselineEdit, setBaselineEdit] = useState<null | "edit" | "probe">(null);

  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyOpen]);

  return (
    <div className="cx">
      <div className="cx-source">
        <div className="cx-source-title">
          <h2>{isImported ? bi("纳管基线配置", "Imported Baseline") : bi("部署配置", "Configuration")}</h2>
          <span className={`cx-record ${completed(p) ? "done" : ""}`}>
            {isImported ? bi("存量纳管运行中", "Managed & Running") : stateLabel}
          </span>
        </div>
        <div className="cx-source-actions">
          {isImported && can("delivery.create") && (
            <>
              <Button
                size="small"
                icon={<IconEdit />}
                onMouseEnter={() => void import("./importcluster")}
                onClick={() => setBaselineEdit("edit")}
              >
                {bi("编辑基线", "Edit Baseline")}
              </Button>
              <Button
                size="small"
                icon={<IconRefresh />}
                onMouseEnter={() => void import("./importcluster")}
                onClick={() => setBaselineEdit("probe")}
              >
                {bi("重新只读采集", "Re-Run Probe")}
              </Button>
            </>
          )}
          {(Array.isArray(c.plans) ? c.plans : []).length > 1 && (
            <Select
              size="small"
              value={p.id}
              aria-label={bi("配置来源交付", "Configuration source delivery")}
              className="cx-source-select"
              triggerProps={{
                autoFitPosition: true,
                autoAlignPopupWidth: false,
                autoAlignPopupMinWidth: true,
                position: "br",
              }}
              onChange={(value: string) =>
                go({
                  name: "deliveries",
                  id: c.id,
                  tab: "config",
                  source: value,
                  section,
                })
              }
              options={(Array.isArray(c.plans) ? c.plans : []).map((entry) => ({
                value: entry.id,
                label: `${titleOf(entry)}${entry.id === c.current ? bi(" · 当前", " · Current") : ""}${entry.outcome === "void" ? bi(" · 已作废", " · Void") : ""}`,
              }))}
            />
          )}
          <Button
            type="text"
            size="small"
            onClick={() =>
              isImported
                ? go({ name: "deliveries", id: c.id, tab: "docs" })
                : go({ name: "deliveries", id: c.id, tab: "plans", plan: p.id })
            }
          >
            {isImported
              ? bi("查看基线档案", "View Baseline Doc")
              : bi("查看部署手册", "View Runbook")}{" "}
            <IconRight />
          </Button>
        </div>
        <p>
          <span title={fullTime(p.marked || p.created)}>{titleOf(p)}</span>
        </p>
        {data && (() => {
          const stackPills = buildClusterStackPills(
            c,
            displayInstances.filter((x) => !x.external),
          );
          return stackPills.length > 0 ? (
            <div className="cx-stack-row">
              <span className="cx-stack-lbl">{bi("架构组件栈", "Stack")}</span>
              <div className="cx-stack-pills">
                {stackPills.map((sp) => (
                  <span
                    key={sp.key}
                    className={`cx-stack-pill${sp.primary ? " is-primary" : ""}`}
                  >
                    <AppGlyph id={sp.component} icon={sp.icon} size={15} />
                    <b>{sp.title}</b>
                    {sp.version && <span className="cx-stack-ver">{sp.version}</span>}
                    <span className="cx-stack-kind">{sp.kindLabel}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null;
        })()}
        {!sameScheme(data?.job.scheme || p.scheme, c.scheme) && (
          <SchemeInfo
            scheme={data?.job.scheme || p.scheme}
            detail
            label={bi("此配置对应部署方案", "Scheme for this config")}
          />
        )}
        {p.outcome === "deviated" && (
          <div className="cx-notice warn">
            <b>{bi("现场执行有偏差", "On-site deviations recorded")}</b>
            <span>
              {p.outcome_note ||
                bi(
                  "请查看该次交付的确认说明。",
                  "See the confirmation note for this delivery.",
                )}{" "}
              {bi(
                "以下仍是原交付配置，请结合现场变更核对。",
                "Below is the original delivered configuration; reconcile with on-site changes.",
              )}
            </span>
          </div>
        )}
        {c.holder && c.holder !== p.id && (
          <p className="cx-pending">
            {bi(
              "另有交付尚未完成，当前记录未随它改变。",
              "Another delivery is still pending; current records have not changed yet.",
            )}
            <button
              type="button"
              className="link"
              onClick={() =>
                go({
                  name: "deliveries",
                  id: c.id,
                  tab: "config",
                  source: c.holder,
                  section,
                })
              }
            >
              {bi("查看待执行交付的配置", "View pending delivery config")}{" "}
              <IconRight />
            </button>
          </p>
        )}
        {appliedList.length > 0 && (current || !c.current) && (
          <div className="cx-chg-strip" role="status">
            <span className="cx-chg-strip-main">
              <span className="cx-chg-dot" aria-hidden />
              <b>
                {bi(
                  `已叠加 ${appliedList.length} 次生产变更`,
                  `${appliedList.length} production change(s) applied`,
                )}
              </b>
              {effectiveChanges.items.length > 0 && (
                <span className="cx-chg-strip-sub">
                  {bi(
                    `· 共 ${effectiveChanges.items.length} 项参数/规则已合并至下方对应组件`,
                    `· ${effectiveChanges.items.length} parameter/rule updates merged inline below`,
                  )}
                </span>
              )}
            </span>
            <span className="cx-chg-strip-acts">
              {primaryChangedInstanceId && effectiveChanges.items.length > 0 && (
                <button
                  type="button"
                  className="cx-chg-strip-btn primary"
                  onClick={() =>
                    navigate(
                      `component:${primaryChangedInstanceId}`,
                      "",
                      "changed",
                    )
                  }
                >
                  {bi(
                    `查看变更项 (${effectiveChanges.items.length})`,
                    `View Changes (${effectiveChanges.items.length})`,
                  )}
                  <IconRight />
                </button>
              )}
              <button
                type="button"
                className="cx-chg-strip-btn"
                onClick={() => setHistoryOpen(true)}
              >
                {bi(
                  `变更历史 (${appliedList.length})`,
                  `History (${appliedList.length})`,
                )}
              </button>
            </span>
          </div>
        )}
      </div>

      {(net !== "online" || error) && (
        <div className="cx-notice" role="status">
          <span>
            {net !== "online" ? bi("连接已断开。", "Disconnected. ") : ""}
            {data
              ? `${bi("显示已读取的配置。", "Showing loaded configuration.")}${error ? bi(`刷新失败：${error}`, ` Refresh failed: ${error}`) : bi("恢复连接后可刷新。", " Refresh when reconnected.")}`
              : error ||
                bi(
                  "暂时无法读取配置，请恢复连接后重试。",
                  "Unable to load configuration; reconnect and retry.",
                )}
          </span>
          <Button
            size="small"
            icon={<IconRefresh />}
            disabled={net !== "online" || loading}
            onClick={() => setRetry((v) => v + 1)}
          >
            {bi("重试", "Retry")}
          </Button>
        </div>
      )}

      {loading && !data ? (
        <div
          className="cx-loading"
          aria-label={bi("正在读取配置", "Loading configuration")}
        >
          <Skeleton animation text={{ rows: 8 }} />
        </div>
      ) : !data ? (
        <Empty
          title={bi("配置未能载入", "Failed to load configuration")}
          text={bi(
            "交付记录暂时不可用，请重试。",
            "Delivery record temporarily unavailable; please retry.",
          )}
        />
      ) : !dep && !plan ? (
        <Empty
          title={bi("这份交付还没有配置记录", "No configuration record yet")}
          text={
            p.state === "running" || p.state === "queued"
              ? bi(
                  "材料正在生成，完成后刷新即可查看。",
                  "Artifacts are building; refresh once complete.",
                )
              : bi(
                  "未保存部署规格或生成配置，可打开交付检查生成记录。",
                  "No deployment spec or generated config saved; check the delivery record.",
                )
          }
        >
          <Button icon={<IconRefresh />} onClick={() => setRetry((v) => v + 1)}>
            {bi("刷新", "Refresh")}
          </Button>
        </Empty>
      ) : (
        <>
          {!plan && (
            <div className="cx-notice">
              <span>
                {bi(
                  "这份记录只有提交规格，尚无生成配置。以下只展示已提交的值。",
                  "This record only contains the submitted spec without generated config; only submitted values are shown.",
                )}
              </span>
            </div>
          )}

          <div className="cx-layout">
            <div className="cx-browser-head">
              <nav
                className="cx-nav"
                aria-label={bi("配置分类", "Config sections")}
                ref={navigation}
              >
                {nav.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={!tokens.length && selected === n.id ? "on" : ""}
                    aria-current={
                      !tokens.length && selected === n.id ? "page" : undefined
                    }
                    onClick={() => navigate(n.id)}
                    title={`${n.label} · ${n.note}`}
                  >
                    {n.icon}
                    <span>{n.label}</span>
                    {n.changeCount > 0 && (
                      <em
                        className="cx-nav-chg-cnt num"
                        title={bi(
                          `${n.changeCount} 项生产变更已生效`,
                          `${n.changeCount} applied production change(s)`,
                        )}
                      >
                        {n.changeCount}
                      </em>
                    )}
                  </button>
                ))}
              </nav>
              <div className="cx-toolbar">
                <Input
                  prefix={<IconSearch />}
                  value={query}
                  onChange={setQuery}
                  allowClear
                  aria-label={bi("搜索集群配置", "Search cluster configuration")}
                  placeholder={bi(
                    "搜索机器、IP 或参数…",
                    "Search hosts, IPs, params…",
                  )}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setQuery("");
                    }
                  }}
                />
                <Button
                  icon={<IconRefresh />}
                  aria-label={bi("刷新配置", "Refresh configuration")}
                  loading={loading}
                  disabled={net !== "online"}
                  onClick={() => setRetry((v) => v + 1)}
                />
              </div>
            </div>

            <div className="cx-detail" ref={detail}>
              {tokens.length ? (
                <section className="cx-section">
                  <div className="cx-heading">
                    <div>
                      <h2>
                        {bi("搜索结果", "Search Results")}{" "}
                        <span className="faint num">{results.length}</span>
                      </h2>
                      <p>
                        {bi(
                          "搜索这份记录的机器角色、组件参数与访问入口",
                          "Search host roles, component parameters, and access endpoints in this record",
                        )}
                      </p>
                    </div>
                    <Button type="text" onClick={() => setQuery("")}>
                      {bi("清除搜索", "Clear search")}
                    </Button>
                  </div>
                  {results.length ? (
                    <div className="cx-spec-card">
                      <div className="cx-results">
                        {results.map((h) => (
                          <button
                            type="button"
                            key={h.id}
                            onClick={() => navigate(h.section, h.focus)}
                          >
                            <span>
                              <b>{h.title}</b>
                              <small>{h.context}</small>
                            </span>
                            <code>{h.value}</code>
                            <IconRight />
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <Empty
                      title={bi("没有匹配的配置", "No matching entries")}
                      text={bi(
                        "试试机器名、角色名称、参数英文名，或只搜索端口数字。",
                        "Try a hostname, role name, parameter key, or port number.",
                      )}
                    />
                  )}
                </section>
              ) : !active ? (
                <Empty
                  title={bi("找不到这个配置分区", "Section not found")}
                  text={bi(
                    "可以从上方选择机器、入口或组件参数。",
                    "Select hosts, endpoints, or component parameters above.",
                  )}
                >
                  <Button onClick={() => navigate("hosts")}>
                    {bi("查看机器与角色", "View Hosts & Roles")}
                  </Button>
                </Empty>
              ) : (
                <section className="cx-section" key={selected}>
                  {/* Non-component section heading (Hosts / Access / Spec) */}
                  {!instance && (
                    <div className="cx-heading">
                      <div>
                        <h2>{active.label}</h2>
                        <p>
                          {selected === "hosts" ? (
                            <>
                              {platformShort(dep?.platform || c.platform || "")}{" "}
                              · {bi("控制节点", "Controller")}{" "}
                              <code>{controller || bi("未记录", "Unrecorded")}</code>
                            </>
                          ) : selected === "access" ? (
                            bi(
                              "区分应用访问地址与后端监听端口，按交付记录查看连接关系",
                              "Distinguish application entrypoints from backend listen ports in this delivery record",
                            )
                          ) : (
                            bi(
                              "保留提交规格和生成时的参数，便于核对、复制与复现",
                              "Preserves submitted spec and generated values for verification and reproduction",
                            )
                          )}
                        </p>
                      </div>
                      <div className="cx-heading-actions">
                        {selected === "hosts" && filteredHosts.length > 1 && (
                          <CopyValue
                            value={filteredHosts.map((h) => h.ip).join("\n")}
                            label={bi("机器 IP 列表", "Host IP list")}
                          />
                        )}
                      </div>
                    </div>
                  )}

                  {/* Section: Hosts & Roles */}
                  {selected === "hosts" &&
                    (hosts.length ? (
                      <>
                        {roleOptions.length > 1 && (
                          <div
                            className="cx-role-filters"
                            role="group"
                            aria-label={bi("按角色筛选机器", "Filter hosts by role")}
                          >
                            {roleOptions.map((opt) => (
                              <button
                                key={opt.id}
                                type="button"
                                className={`cx-filter-pill ${activeRoleOption?.id === opt.id ? "on" : ""}`}
                                onClick={() => setRoleFilter(opt.id)}
                              >
                                {opt.label} <em>{opt.count}</em>
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="cx-hosts">
                          {filteredHosts.map((h) => {
                            const hostComps = displayInstances.filter(
                              (i) => !i.external && (i.hosts || []).includes(h.name),
                            );
                            const storage = hostStorage(h, {
                              imported: isImported,
                              importedDataDirs: c.imported?.data_dirs,
                            });
                            return (
                              <div
                                key={h.name}
                                className={`cx-host-card ${focusKey === `host:${h.name}` ? "focused" : ""}`}
                                data-config-key={`host:${h.name}`}
                                tabIndex={-1}
                              >
                                <div className="cx-host-card-head">
                                  <div className="cx-host-card-id">
                                    <span className="cx-host-ico" aria-hidden>
                                      <IconDesktop />
                                    </span>
                                    <b className="mono">{h.name}</b>
                                    <code className="cx-host-ip">{h.ip}</code>
                                    {h.name === controller && (
                                      <Tag size="small" color="arcoblue">
                                        {bi("控制节点", "Controller")}
                                      </Tag>
                                    )}
                                  </div>
                                  <CopyValue
                                    value={h.ip}
                                    label={bi(`${h.name}地址`, `${h.name} IP`)}
                                  />
                                </div>
                                <div className="cx-host-card-body">
                                  <div className="cx-host-kv">
                                    <span className="cx-host-k">
                                      {isImported
                                        ? bi("数据存储", "Data Storage")
                                        : bi("数据盘", "Data Disk")}
                                    </span>
                                    <div className="cx-host-v">
                                      <code className="cx-disk-val">
                                        {storage.label}
                                        {storage.path ? ` · ${storage.path}` : ""}
                                      </code>
                                      <span className="cx-host-sub">
                                        {storage.note}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="cx-host-kv">
                                    <span className="cx-host-k">
                                      {bi("部署角色", "Assigned Roles")}
                                    </span>
                                    <div className="cx-role-chips">
                                      {hostComps.map((i) => {
                                        const roleText = Object.entries(i.roles || {})
                                          .filter(([, hs]) => (hs || []).includes(h.name))
                                          .map(
                                            ([role]) =>
                                              i.role_titles?.[role] || role,
                                          )
                                          .join(bi("、", ", "));
                                        return (
                                          <button
                                            key={i.id}
                                            type="button"
                                            className="cx-role-chip"
                                            onClick={() =>
                                              navigate(`component:${i.id}`)
                                            }
                                          >
                                            <AppGlyph
                                              id={i.component}
                                              icon={i.component === c.app_id ? c.icon : undefined}
                                              color={i.component === c.app_id ? c.imported?.color : undefined}
                                              size={15}
                                            />
                                            <span className="cx-role-chip-name">
                                              {i.title}
                                            </span>
                                            {roleText && (
                                              <code className="cx-role-chip-val">
                                                {roleText}
                                              </code>
                                            )}
                                            <IconRight />
                                          </button>
                                        );
                                      })}
                                      {!hostComps.length && (
                                        <span className="muted small">
                                          {bi("未承担组件角色", "No component roles assigned")}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    ) : (
                      <Empty
                        title={bi("没有机器记录", "No hosts recorded")}
                        text={bi(
                          "这份规格未包含可展示的机器。",
                          "This spec contains no hosts to display.",
                        )}
                      />
                    ))}

                  {/* Section: Access Endpoints */}
                  {selected === "access" && (
                    <div className="cx-spec-stack">
                      {routes.length ? (
                        routes.map(({ i, ep, front }) => (
                          <section
                            key={`${i.id}.${ep.name}`}
                            className={`cx-spec-card cx-endpoint-card ${focusKey === `endpoint:${i.id}.${ep.name}` ? "focused" : ""}`}
                            data-config-key={`endpoint:${i.id}.${ep.name}`}
                            tabIndex={-1}
                          >
                            <div className="cx-spec-card-head">
                              <div className="cx-ep-title">
                                <IconLink />
                                <h3>
                                  {/^(readwrite|readonly|admin|writer|reader)$/i.test(
                                    (ep.title || "").trim(),
                                  ) || !ep.title
                                    ? localizeEndpointTitle(ep.title || ep.name, ep.name)
                                    : ep.title}
                                </h3>
                                <code className="cx-ep-key">
                                  {i.id}.{ep.name}
                                </code>
                              </div>
                              <span className="cx-ep-proto mono">
                                {(ep.protocol || "").toUpperCase()}
                              </span>
                            </div>
                            <div className="cx-ep-body">
                              <div className="cx-ep-addr-bar">
                                <span className="cx-ep-badge">
                                  {front
                                    ? front.external
                                      ? bi("外部入口", "External")
                                      : bi("集群入口", "Cluster")
                                    : bi("节点直连", "Direct")}
                                </span>
                                <code className="cx-ep-addr">
                                  {front
                                    ? `${front.address}:${front.listen}`
                                    : bi(
                                        "通过下方节点地址访问",
                                        "Connect via backend addresses below",
                                      )}
                                </code>
                                {front && (
                                  <CopyValue
                                    value={`${front.address}:${front.listen}`}
                                    label={bi(
                                      `${ep.title}地址`,
                                      `${ep.title} endpoint`,
                                    )}
                                  />
                                )}
                              </div>
                              {(front || ep.health) && (
                                <div className="cx-ep-meta-chips">
                                  {front?.resolve_ip && (
                                    <span className="cx-ep-meta">
                                      <em>{bi("DNS 解析", "DNS")}</em>
                                      <code>{front.resolve_ip}</code>
                                    </span>
                                  )}
                                  {front && (
                                    <span className="cx-ep-meta">
                                      <em>{bi("转发映射", "Route")}</em>
                                      <code>
                                        :{front.listen} → :{ep.port}
                                      </code>
                                    </span>
                                  )}
                                  {front?.balancer && (
                                    <span className="cx-ep-meta">
                                      <em>{bi("均衡器", "Balancer")}</em>
                                      <code>{front.balancer}</code>
                                    </span>
                                  )}
                                  {ep.health && (
                                    <span className="cx-ep-meta">
                                      <em>{bi("健康检查", "Health")}</em>
                                      <code>
                                        {(ep.health.type || "").toUpperCase()}
                                        {ep.health.port ? ` :${ep.health.port}` : ""}
                                        {ep.health.path || ""}
                                        {ep.health.status
                                          ? ` (${ep.health.status})`
                                          : ""}
                                      </code>
                                    </span>
                                  )}
                                </div>
                              )}
                              {ep.note && (
                                <p className="cx-ep-note">{ep.note}</p>
                              )}
                              {(ep.backends || []).length > 0 && (
                                <div className="cx-ep-backends">
                                  <div className="cx-ep-backends-label">
                                    {bi("后端节点", "Backend Nodes")}
                                  </div>
                                  <div className="cx-backends">
                                    {(ep.backends || []).map((b) => (
                                      <div key={`${b.host}:${b.port}`}>
                                        <span className="mono cx-be-host">
                                          {b.host}
                                        </span>
                                        <code className="cx-be-addr">
                                          {b.ip}:{b.port}
                                        </code>
                                        <small>
                                          {i.role_titles?.[b.role] || b.role}
                                        </small>
                                        <CopyValue
                                          value={`${b.ip}:${b.port}`}
                                          label={bi(
                                            `${b.host}后端地址`,
                                            `${b.host} backend`,
                                          )}
                                        />
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </section>
                        ))
                      ) : (
                        <Empty
                          title={bi("未声明访问端点", "No endpoints declared")}
                          text={bi(
                            "这份交付未保存访问端点，可在组件参数中查看端口和地址。",
                            "No endpoints saved in this delivery; check component parameters for ports and addresses.",
                          )}
                        />
                      )}
                      {portRows.length > 0 && (
                        <div className="cx-spec-card">
                          <div className="cx-spec-card-head">
                            <h3>
                              {bi("组件监听端口", "Component Listen Ports")}
                              <span className="cx-card-cnt num">
                                {portRows.length}
                              </span>
                            </h3>
                          </div>
                          <div className="cx-port-list">
                            {portRows.map(({ i, port }, index) => {
                              const portLabel = localizePortName(port.Name, i.component);
                              const showPortRole =
                                portLabel &&
                                portLabel.toLowerCase() !== (i.title || "").toLowerCase();
                              const showRawKey =
                                port.Name &&
                                port.Name.toLowerCase() !== (portLabel || "").toLowerCase();
                              return (
                                <div
                                  className="cx-port"
                                  key={`${i.id}.${port.Name}.${index}`}
                                >
                                  <span className="cx-port-comp">
                                    <AppGlyph
                                      id={i.component}
                                      icon={i.component === c.app_id ? c.icon : undefined}
                                      color={i.component === c.app_id ? c.imported?.color : undefined}
                                      size={15}
                                    />
                                    <b>{i.title}</b>
                                    {showPortRole && (
                                      <span className="cx-port-role">{portLabel}</span>
                                    )}
                                    {showRawKey && <code>{port.Name}</code>}
                                  </span>
                                  <code className="cx-port-num">
                                    {port.Port}/{(port.Proto || "tcp").toUpperCase()}
                                  </code>
                                  <small>{(port.Hosts || []).join(bi("、", ", "))}</small>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Section: Component Parameters (Redesigned Clean Structured Inspector) */}
                  {instance && (
                    <>
                      {/* Component Summary Hero Bar */}
                      <div className="cx-comp-hero">
                        <div className="cx-comp-hero-main">
                          <div className="cx-comp-hero-top">
                            <span className="cx-comp-hero-ico" aria-hidden>
                              <AppGlyph
                                id={instance.component}
                                icon={instance.component === c.app_id ? c.icon : undefined}
                                color={instance.component === c.app_id ? c.imported?.color : undefined}
                                size={22}
                              />
                            </span>
                            <h2>
                              {instance.external
                                ? bi("外部负载均衡", "External LB")
                                : instance.title}
                            </h2>
                            {instance.version && (
                              <span className="cx-ver-pill mono">
                                {instance.version}
                              </span>
                            )}
                            <code className="cx-id-pill">{instance.id}</code>
                            {instance.embeddedFrom && (
                              <Tooltip
                                mini
                                content={bi(
                                  "此集群采用旧版一体化交付（Patroni 随 PostgreSQL 同包部署）；已将 Patroni 高可用与复制策略参数拆至本页独立检视，原始规格文件保持不变。",
                                  "Legacy bundled delivery (Patroni deployed inside PostgreSQL); HA & replication parameters are shown here for consistent inspection while raw specs remain unchanged.",
                                )}
                              >
                                <span className="cx-origin-badge is-embedded">
                                  {bi("内置随 PG 部署", "Bundled with PG")}
                                </span>
                              </Tooltip>
                            )}
                            {!instance.embeddedFrom &&
                              instance.component === "patroni" &&
                              instance.partitionPeerId && (
                                <span className="cx-origin-badge is-split">
                                  {bi("独立伴生实例", "Companion Instance")}
                                </span>
                              )}
                            {instance.external && (
                              <span className="cx-origin-badge">
                                {bi("外部托管", "Customer-managed")}
                              </span>
                            )}
                          </div>
                          {!instance.external && (
                            <div className="cx-comp-hero-meta">
                              <span className="cx-comp-host-cnt">
                                {(instance.hosts || []).length === 1
                                  ? bi("1 台机器", "1 host")
                                  : bi(
                                      `${(instance.hosts || []).length} 台机器`,
                                      `${(instance.hosts || []).length} hosts`,
                                    )}
                              </span>
                              {Object.entries(instance.roles || {})
                                .filter(([, hs]) => (hs || []).length)
                                .map(([role, hs]) => (
                                  <span key={role} className="cx-place-chip">
                                    <b>{instance.role_titles?.[role] || role}</b>
                                    <code>{(hs || []).join(bi("、", ", "))}</code>
                                  </span>
                                ))}
                            </div>
                          )}
                        </div>

                        <div className="cx-comp-hero-acts">
                          {canFilterRows && (
                            <div
                              className="cx-scope-pills"
                              role="group"
                              aria-label={bi("参数筛选", "Parameter filter")}
                            >
                              <button
                                type="button"
                                className={`cx-filter-pill ${paramFilter === "all" ? "on" : ""}`}
                                onClick={() => {
                                  setParamFilter("all");
                                  setGroupFilter("all");
                                }}
                              >
                                {bi("全部", "All")}{" "}
                                <em>{allInstanceRows.length}</em>
                              </button>
                              {changedCount > 0 && (
                                <button
                                  type="button"
                                  className={`cx-filter-pill is-chg ${paramFilter === "changed" ? "on" : ""}`}
                                  onClick={() => {
                                    setParamFilter("changed");
                                    setGroupFilter("all");
                                  }}
                                >
                                  {bi("生产变更", "Changed")}{" "}
                                  <em>{changedCount}</em>
                                </button>
                              )}
                              {canFilterSpecified && (
                                <button
                                  type="button"
                                  className={`cx-filter-pill ${paramFilter === "specified" ? "on" : ""}`}
                                  onClick={() => {
                                    setParamFilter("specified");
                                    setGroupFilter("all");
                                  }}
                                >
                                  {bi("已指定", "Specified")}{" "}
                                  <em>{specifiedCount}</em>
                                </button>
                              )}
                            </div>
                          )}
                          <CopyValue
                            value={effectiveCopyPayload || instance.params}
                            label={bi(
                              `${instance.title}当前参数`,
                              `${instance.title} effective parameters`,
                            )}
                          />
                        </div>
                      </div>

                      {schemaError && (
                        <div className="cx-notice">
                          <span>
                            {bi(
                              "部分参数说明未能读取，配置值仍来自原交付记录。",
                              "Some parameter descriptions could not be loaded; values shown are still from the saved delivery.",
                            )}
                          </span>
                          <Button
                            size="small"
                            disabled={net !== "online"}
                            onClick={() => setSchemaRetry((v) => v + 1)}
                          >
                            {bi("重试说明", "Retry")}
                          </Button>
                        </div>
                      )}

                      {/* Quick Group Filter Strip when component has multiple parameter groups */}
                      {allParamGroups.length > 1 && (
                        <div
                          className="cx-group-bar"
                          role="group"
                          aria-label={bi("参数分组筛选", "Filter parameter groups")}
                        >
                          <button
                            type="button"
                            className={`cx-grp-pill ${activeGroupFilter === "all" ? "on" : ""}`}
                            onClick={() => setGroupFilter("all")}
                          >
                            {bi("全部分组", "All Groups")}{" "}
                            <em className="num">{scopeFilteredRows.length}</em>
                          </button>
                          {allParamGroups.map((g) => (
                            <button
                              key={g.name}
                              type="button"
                              className={`cx-grp-pill${g.isRuntime ? " is-rt" : ""}${activeGroupFilter === g.name ? " on" : ""}`}
                              onClick={() =>
                                setGroupFilter((prev) =>
                                  prev === g.name ? "all" : g.name,
                                )
                              }
                            >
                              {g.isRuntime && (
                                <i className="cx-grp-dot" aria-hidden />
                              )}
                              <span>{g.name}</span>
                              <em className="num">{g.count}</em>
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Structured Single-Column Bordered Specification Cards */}
                      {visibleGroups.length > 0 ? (
                        <div className="cx-spec-stack">
                          {visibleGroups.map((grp) => {
                            const groupRows = visibleInstanceRows.filter(
                              (r) => r.group === grp.name,
                            );
                            const isRt = grp.isRuntime;
                            return (
                              <div
                                className={`cx-spec-card${isRt ? " is-runtime-card" : ""}`}
                                key={grp.name}
                              >
                                <div className="cx-spec-card-head">
                                  <h3>
                                    {isRt && (
                                      <span className="cx-chg-dot" aria-hidden />
                                    )}
                                    {grp.name}
                                    <span className="cx-card-cnt num">
                                      {groupRows.length}
                                    </span>
                                  </h3>
                                  {isRt && appliedList.length > 0 && (
                                    <button
                                      type="button"
                                      className="cx-card-action"
                                      onClick={() => setHistoryOpen(true)}
                                    >
                                      {bi("查看变更记录", "Change History")}{" "}
                                      <IconRight />
                                    </button>
                                  )}
                                </div>
                                <div className="cx-spec-rows">
                                  {groupRows.map((r) => {
                                    const secretKey = `${instance.id}:${r.key}`;
                                    const secret = isSecretRow(r);
                                    const revealed = Boolean(
                                      shownSecrets[secretKey],
                                    );
                                    const ef = r.applied;
                                    const oldDiffVal = ef
                                      ? ef.before ||
                                        (!r.runtimeAdded
                                          ? display(r.value)
                                          : "")
                                      : "";
                                    const showDistinctKey =
                                      r.label.toLowerCase() !==
                                      r.key.toLowerCase();
                                    const hasHint = Boolean(r.def?.hint);
                                    return (
                                      <div
                                        key={r.key}
                                        className={`cx-spec-row${!r.active ? " is-inactive" : ""}${ef ? " is-changed" : ""}${focusKey === r.key ? " focused" : ""}`}
                                        data-config-key={r.key}
                                        tabIndex={-1}
                                      >
                                        <div className="cx-spec-k">
                                          <div className="cx-spec-label-line">
                                            <b>{r.label}</b>
                                            {hasHint && (
                                              <Tooltip
                                                content={r.def!.hint}
                                                mini
                                              >
                                                <span
                                                  className="cx-hint-ico"
                                                  tabIndex={0}
                                                  aria-label={r.def!.hint}
                                                >
                                                  <IconInfoCircle />
                                                </span>
                                              </Tooltip>
                                            )}
                                          </div>
                                          {showDistinctKey && (
                                            <code className="cx-spec-key">
                                              {r.key}
                                            </code>
                                          )}
                                        </div>

                                        <div
                                          className={`cx-spec-v${ef ? " is-diff" : ""}`}
                                        >
                                          {ef ? (
                                            <>
                                              {oldDiffVal && (
                                                <del className="cx-val-old mono">
                                                  {oldDiffVal}
                                                </del>
                                              )}
                                              <span className="cx-hist-next">
                                                {oldDiffVal && (
                                                  <span
                                                    className="cx-val-arrow"
                                                    aria-hidden
                                                  >
                                                    →
                                                  </span>
                                                )}
                                                <code className="cx-val-new">
                                                  {ef.after}
                                                </code>
                                              </span>
                                            </>
                                          ) : typeof r.value === "boolean" ? (
                                            <span
                                              className={`cx-bool-pill ${r.value ? "yes" : ""}`}
                                            >
                                              <i />
                                              {display(r.value)}
                                            </span>
                                          ) : secret ? (
                                            <span className="cx-secret-wrap">
                                              <code className="cx-val-code">
                                                {revealed
                                                  ? display(r.value)
                                                  : "••••••••"}
                                              </code>
                                              <Tooltip
                                                content={
                                                  revealed
                                                    ? bi(
                                                        `隐藏${r.label}`,
                                                        `Hide ${r.label}`,
                                                      )
                                                    : bi(
                                                        `显示${r.label}`,
                                                        `Show ${r.label}`,
                                                      )
                                                }
                                                mini
                                              >
                                                <button
                                                  type="button"
                                                  className="cx-secret-btn"
                                                  aria-label={
                                                    revealed
                                                      ? bi(
                                                          `隐藏${r.label}`,
                                                          `Hide ${r.label}`,
                                                        )
                                                      : bi(
                                                          `显示${r.label}`,
                                                          `Show ${r.label}`,
                                                        )
                                                  }
                                                  onClick={() =>
                                                    setShownSecrets((prev) => ({
                                                      ...prev,
                                                      [secretKey]:
                                                        !prev[secretKey],
                                                    }))
                                                  }
                                                >
                                                  {revealed ? (
                                                    <IconEyeInvisible />
                                                  ) : (
                                                    <IconEye />
                                                  )}
                                                </button>
                                              </Tooltip>
                                            </span>
                                          ) : (
                                            <span className="cx-val-plain">
                                              <code className="cx-val-code">
                                                {display(r.value)}
                                              </code>
                                              {r.def?.unit && r.value !== "" && (
                                                <small className="cx-val-unit">
                                                  {r.def.unit}
                                                </small>
                                              )}
                                            </span>
                                          )}
                                        </div>

                                        <div className="cx-spec-meta">
                                          {ef ? (
                                            <Tooltip
                                              mini
                                              content={bi(
                                                `由《${ef.source_title}》于 ${ago(ef.applied_at)} 生效${ef.update_count > 1 ? `（累计调整 ${ef.update_count} 次，当前为最新值）` : ""} · 点击查看变更历史`,
                                                `Applied via "${ef.source_title}" ${ago(ef.applied_at)}${ef.update_count > 1 ? ` (${ef.update_count} updates merged)` : ""} · Click for history`,
                                              )}
                                            >
                                              <button
                                                type="button"
                                                className="cx-origin-pill is-chg"
                                                onClick={() =>
                                                  setHistoryOpen(true)
                                                }
                                              >
                                                <IconCheck />
                                                <span>
                                                  {bi("生产变更", "Changed")}
                                                </span>
                                                {ef.update_count > 1 && (
                                                  <em className="num">
                                                    ×{ef.update_count}
                                                  </em>
                                                )}
                                              </button>
                                            </Tooltip>
                                          ) : !r.active ? (
                                            <span className="cx-origin-pill is-off">
                                              {bi("未启用", "Inactive")}
                                            </span>
                                          ) : !plan ? (
                                            <span className="cx-origin-pill is-spec">
                                              {bi("提交值", "Submitted")}
                                            </span>
                                          ) : r.specified ? (
                                            <span className="cx-origin-pill is-spec">
                                              {bi("已指定", "Specified")}
                                            </span>
                                          ) : (
                                            <span className="cx-origin-default">
                                              {bi("默认", "Default")}
                                            </span>
                                          )}
                                          <CopyValue
                                            value={ef ? ef.after : r.value}
                                            label={r.label}
                                          />
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}

                          {/* Database Extensions (if any) */}
                          {(
                            (Array.isArray(dep?.instances) ? dep.instances : []).find(
                              (sp) => sp.id === (instance.embeddedFrom || instance.id),
                            )?.addons || []
                          ).length > 0 &&
                            instance.component !== "patroni" && (
                              <div className="cx-spec-card">
                                <div className="cx-spec-card-head">
                                  <h3>
                                    {bi("数据库扩展", "Database Extensions")}
                                  </h3>
                                </div>
                                <div className="cx-spec-rows">
                                  {(Array.isArray(dep?.instances) ? dep.instances : [])
                                    .find(
                                      (sp) =>
                                        sp.id ===
                                        (instance.embeddedFrom || instance.id),
                                    )
                                    ?.addons?.map((a) => (
                                      <div className="cx-addon" key={a.id}>
                                        <code>{a.id}</code>
                                        <span>
                                          {a.databases?.join(bi("、", ", ")) ||
                                            bi(
                                              "按规格指定的数据库",
                                              "Databases from spec",
                                            )}
                                        </span>
                                        {a.params && (
                                          <code>{JSON.stringify(a.params)}</code>
                                        )}
                                      </div>
                                    ))}
                                </div>
                              </div>
                            )}

                          {/* Component Dependencies (if any) */}
                          {instance.uses &&
                            Object.keys(instance.uses).length > 0 && (
                              <div className="cx-spec-card">
                                <div className="cx-spec-card-head">
                                  <h3>
                                    {bi("组件依赖", "Component Dependencies")}
                                  </h3>
                                </div>
                                <div className="cx-spec-rows">
                                  {Object.entries(instance.uses).map(
                                    ([cap, use]) => (
                                      <button
                                        key={cap}
                                        type="button"
                                        className="cx-dependency"
                                        onClick={() =>
                                          navigate(`component:${use.instance}`)
                                        }
                                      >
                                        <AppGlyph id={use.component} size={16} />
                                        <span className="cx-dep-cap">{cap}</span>
                                        <code>{use.instance}</code>
                                        <span className="muted">
                                          {use.component}
                                        </span>
                                        <IconRight />
                                      </button>
                                    ),
                                  )}
                                </div>
                              </div>
                            )}
                        </div>
                      ) : (
                        <Empty
                          title={bi("没有匹配的参数", "No matching parameters")}
                          text={bi(
                            "可以切换上方的分组或筛选条件查看全部参数。",
                            "Switch group or filter pills above to inspect all parameters.",
                          )}
                        />
                      )}
                    </>
                  )}

                  {/* Section: Raw Spec */}
                  {selected === "spec" && (
                    <>
                      <div className="cx-raw-tools">
                        <Segmented<string>
                          label={bi("原始规格格式", "Raw spec format")}
                          value={rawView}
                          onChange={(v) => {
                            setRawView(v);
                            setRawCopied(false);
                          }}
                          options={[
                            {
                              label: bi("提交规格 · YAML", "Submitted · YAML"),
                              value: "yaml",
                            },
                            {
                              label: bi("生成配置 · JSON", "Generated · JSON"),
                              value: "json",
                            },
                          ]}
                        />
                        {(rawView === "yaml" ? yaml : generated) && (
                          <Button
                            icon={rawCopied ? <IconCheck /> : <IconCopy />}
                            onClick={() => {
                              copy(
                                (rawView === "yaml" ? yaml : generated) || "",
                              );
                              setRawCopied(true);
                              if (rawCopyTimer.current)
                                window.clearTimeout(rawCopyTimer.current);
                              rawCopyTimer.current = window.setTimeout(
                                () => setRawCopied(false),
                                1500,
                              );
                            }}
                          >
                            {rawCopied
                              ? bi("已复制", "Copied")
                              : bi("复制", "Copy")}
                          </Button>
                        )}
                        {specFile && can("delivery.download") && (
                          <Button
                            icon={<IconDownload />}
                            href={withLang(specFile.url)}
                            download={specFile.name}
                          >
                            {bi("下载部署规格", "Download Spec")}
                          </Button>
                        )}
                      </div>
                      {(rawView === "yaml" ? yaml : generated) ? (
                        <pre
                          className="cx-raw"
                          tabIndex={0}
                          aria-label={
                            rawView === "yaml"
                              ? bi("提交规格 YAML", "Submitted YAML spec")
                              : bi("生成配置 JSON", "Generated JSON config")
                          }
                        >
                          <code>{rawView === "yaml" ? yaml : generated}</code>
                        </pre>
                      ) : (
                        <Empty
                          title={
                            rawView === "yaml"
                              ? bi("未保存提交规格", "No submitted spec saved")
                              : bi("尚无生成配置", "No generated config yet")
                          }
                          text={bi(
                            "可以切换查看另一种记录，或打开交付检查生成结果。",
                            "Switch formats above or open the delivery to inspect generation logs.",
                          )}
                        />
                      )}
                    </>
                  )}
                </section>
              )}
            </div>
          </div>

          <div className="cx-footer">
            <span>
              <IconFile /> {titleOf(p)} <code>#{p.id.slice(0, 8)}</code>
              {instance && (
                <>
                  <span className="cx-meta-sep">·</span>
                  <span>
                    {bi(
                      "未标注来源的参数为生成时默认补全",
                      "Unlabeled values are defaulted at plan generation",
                    )}
                  </span>
                </>
              )}
            </span>
            {source && source !== c.current && c.current && (
              <button
                type="button"
                className="link"
                onClick={() =>
                  go({ name: "deliveries", id: c.id, tab: "config", section })
                }
              >
                <IconArrowLeft />{" "}
                {bi("返回当前配置", "Back to current config")}
              </button>
            )}
          </div>
        </>
      )}

      <Drawer
        visible={historyOpen}
        onCancel={() => setHistoryOpen(false)}
        width="min(560px, 100vw)"
        footer={null}
        className="cx-chg-drawer"
        title={
          <div className="cx-chg-drawer-head">
            <b>
              {bi(
                `生产变更历史（${appliedList.length} 次）`,
                `Production Change History (${appliedList.length})`,
              )}
            </b>
            <span>
              {bi(
                "所有已生效参数已按时间归并至对应组件配置，此处可追溯每次变更详情与报告",
                "Effective changes are merged inline per component; inspect individual rollout records below",
              )}
            </span>
          </div>
        }
      >
        <div className="cx-chg-drawer-body">
          {appliedList.map((rh, idx) => {
            const open = expandedHistoryIds[rh.id] ?? idx === 0;
            const changes = rh.applied_changes || [];
            return (
              <div
                key={rh.id}
                className={`cx-hist-row${open ? " is-open" : ""}`}
              >
                <div
                  className="cx-hist-head"
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    setExpandedHistoryIds((prev) => ({
                      ...prev,
                      [rh.id]: !open,
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setExpandedHistoryIds((prev) => ({
                        ...prev,
                        [rh.id]: !open,
                      }));
                    }
                  }}
                >
                  <span className="cx-chg-dot" aria-hidden />
                  <div className="cx-hist-title-col">
                    <b>{rh.title}</b>
                    <small className="num">
                      {rh.applied_by || rh.owner} ·{" "}
                      {ago(rh.applied_at || rh.updated_at)}
                      {changes.length > 0 &&
                        ` · ${bi(`${changes.length} 项配置`, `${changes.length} change(s)`)}`}
                    </small>
                  </div>
                  <IconDown className="cx-hist-chev" />
                </div>
                {open && (
                  <div className="cx-hist-detail">
                    {rh.applied_summary && (
                      <p className="cx-hist-sum">{rh.applied_summary}</p>
                    )}
                    {changes.length > 0 && (
                      <div className="cx-hist-deltas">
                        {changes.map((ch, cidx) => {
                          const latest = effectiveChanges.latestByKey.get(
                            (ch.key || "").trim().toLowerCase(),
                          );
                          const isOverwritten = Boolean(
                            latest && latest.source_id !== rh.id,
                          );
                          return (
                            <div
                              key={`${ch.key}-${cidx}`}
                              className={`cx-hist-delta${isOverwritten ? " is-overwritten" : ""}`}
                            >
                              <code className="cx-hist-k mono">{ch.key}</code>
                              <span className="cx-hist-v">
                                {ch.before && (
                                  <del className="cx-val-old mono">
                                    {ch.before}
                                  </del>
                                )}
                                <span className="cx-hist-next">
                                  {ch.before && (
                                    <span className="cx-val-arrow" aria-hidden>
                                      →
                                    </span>
                                  )}
                                  <code className="cx-val-new">{ch.after}</code>
                                </span>
                                {isOverwritten && (
                                  <em className="cx-delta-sup">
                                    {bi("已被后续更新", "Superseded")}
                                  </em>
                                )}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="cx-hist-links">
                      {rh.doc_id && (
                        <button
                          type="button"
                          className="link small"
                          onClick={() => {
                            setHistoryOpen(false);
                            go({
                              name: "deliveries",
                              id: c.id,
                              tab: "docs",
                              doc: rh.doc_id,
                            });
                          }}
                        >
                          {bi("查看变更报告", "Change Report")} <IconRight />
                        </button>
                      )}
                      <button
                        type="button"
                        className="link small"
                        onClick={() => {
                          setHistoryOpen(false);
                          go({
                            name: "deliveries",
                            id: c.id,
                            tab: "rehearsal",
                            rehearsal: rh.id,
                          });
                        }}
                      >
                        {bi("打开演练详情", "Open Rehearsal")} <IconRight />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <div className="cx-chg-drawer-foot">
            <Button
              size="small"
              onClick={() => {
                setHistoryOpen(false);
                go({ name: "deliveries", id: c.id, tab: "rehearsal" });
              }}
            >
              {bi("前往变更演练工作台", "Go to Rehearsal Workbench")}{" "}
              <IconRight />
            </Button>
          </div>
        </div>
      </Drawer>
      {isImported && baselineEdit !== null && (
        <React.Suspense fallback={null}>
          <LazyImportedBaselineModal
            visible
            mode={baselineEdit}
            cluster={c}
            onClose={() => setBaselineEdit(null)}
            onSaved={async () => {
              if (p.id) {
                putDetailCache(
                  p.id,
                  await api<JobDetail>(`/api/jobs/${encodeURIComponent(p.id)}`, {
                    cache: "no-store",
                  }),
                );
              }
              setRetry((x) => x + 1);
            }}
          />
        </React.Suspense>
      )}
    </div>
  );
}

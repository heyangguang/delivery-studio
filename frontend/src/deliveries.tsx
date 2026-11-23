import {SchemeInfo, schemeName} from "./scheme";
import { ExecutionHostSummary } from "./execution-placement";
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Button,
  Checkbox,
  Dropdown,
  Input,
  Menu,
  Message,
  Modal,
  Popover,
  Skeleton,
  Spin,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCheckCircleFill,
  IconCloudDownload,
  IconCopy,
  IconDelete,
  IconDownload,
  IconExclamationCircle,
  IconFilter,
  IconLock,
  IconMore,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconEdit,
  IconFile,
  IconUndo,
} from "@arco-design/web-react/icon";
import {
  api,
  ago,
  clock,
  copy,
  dayLabel,
  duration,
  err,
  formatDuration,
  fullTime,
  phaseOf,
  platformShort,
  running,
  size,
  typing,
  useConnectivity,
  useMedia,
  useStored,
} from "./shared";
import {
  can,
  cached,
  putCached,
  clusterStatus,
  meName,
  planPhase,
  PLAN_PHASE,
} from "./shared";
import type {
  AppInfo,
  ClusterView,
  Job,
  JobDetail,
  JobFile,
  JobPromoteTarget,
} from "./shared";
import { OsLogo } from "./oslogo";
import { go } from "./router";
import {
  AppGlyph,
  DeliveryModeIcon,
  DeliveryModeTag,
  FilterChip,
  PackagesArt,
  Segmented,
  StageTrack,
  StatusBadge,
  StatusDot,
  InstanceGraph,
  Kbd,
  deliveryModeKeywords,
  normalizeDeliveryMode,
} from "./ui";
import { ExecutionPanel } from "./executions";
import { Runbook } from "./runbook";
import { AIDock, Spark, useAIDock, useAIStatus } from "./aichat";
import { LineagePanel } from "./lineage";
import { OutcomeBar } from "./outcome";
import {
  ClusterDetail,
  HistoryDots,
  parseClusterUrlCompat,
} from "./clusters";
import { bi, catLabel, useLang, withLang } from "./i18n";

export type LoadState = "loading" | "error" | "ready";

/* ---------- detail cache: switching is instant for anything already seen or hovered ---------- */

const detailCache = new Map<string, JobDetail>();
if (typeof window !== "undefined") {
  window.addEventListener("mh-lang-change", () => detailCache.clear());
}
const inflight = new Set<string>();
const jobApiPath = (id: string) => `/api/jobs/${encodeURIComponent(id)}`;
export const cachedDetail = (id: string) =>
  detailCache.get(id) || cached<JobDetail>(jobApiPath(id)) || null;
export function putDetailCache(id: string, d: JobDetail) {
  detailCache.set(id, d);
  putCached(jobApiPath(id), d);
}
export function prefetchDetail(id: string) {
  if (!id || detailCache.has(id) || inflight.has(id)) return;
  inflight.add(id);
  api<JobDetail>(jobApiPath(id))
    .then((d) => {
      putDetailCache(id, d);
    })
    .catch(() => {})
    .finally(() => inflight.delete(id));
}

/* ---------- filters ---------- */

type Status = "all" | "generated" | "configuration" | "done" | "failed";
type ModeFilter = "all" | "automatic" | "offline" | "configuration";
type ScopeFilter = "formal" | "verification";
type Range = "all" | "today" | "7d" | "30d";
type Sort = "new" | "old" | "name";
type Group = "day" | "app" | "none";
type DF = {
  q: string;
  scope: ScopeFilter;
  status: Status;
  mode: ModeFilter;
  apps: string[];
  range: Range;
  sort: Sort;
  group: Group;
};
const DF0: DF = {
  q: "",
  scope: "formal",
  status: "all",
  mode: "all",
  apps: [],
  range: "all",
  sort: "new",
  group: "day",
};
const RANGE_LABEL: Record<Range, string> = {
  get all() { return bi("不限", "Any time"); },
  get today() { return bi("今天", "Today"); },
  get "7d"() { return bi("近 7 天", "Last 7d"); },
  get "30d"() { return bi("近 30 天", "Last 30d"); },
};

const sinceOf = (r: Range) => {
  const d = new Date();
  if (r === "today")
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (r === "7d") return d.getTime() - 7 * 86400000;
  if (r === "30d") return d.getTime() - 30 * 86400000;
  return 0;
};
/** `skip` leaves one facet out, so each facet's counts show what choosing that option would give. */
function matchJob(j: Job, f: DF, skip?: "scope" | "status" | "apps" | "mode") {
  const isVerify = j.purpose === "verification";
  if (skip !== "scope") {
    if (f.scope === "verification" && !isVerify) return false;
    if (f.scope === "formal" && isVerify) return false;
  }
  const q = f.q.trim().toLowerCase();
  if (
    q &&
    !`${j.cluster_id} ${j.app_name} ${j.version} ${j.id.slice(0, 8)} ${schemeName(j.scheme)} ${j.scheme?.topology || ""} ${deliveryModeKeywords(j.delivery_mode)}`
      .toLowerCase()
      .includes(q)
  )
    return false;
  if (skip !== "status" && f.status !== "all" && phaseOf(j) !== f.status)
    return false;
  if (
    skip !== "mode" &&
    f.mode !== "all" &&
    normalizeDeliveryMode(j.delivery_mode) !== f.mode
  )
    return false;
  if (skip !== "apps" && f.apps.length && !f.apps.includes(j.app_id))
    return false;
  if (f.range !== "all" && new Date(j.created).getTime() < sinceOf(f.range))
    return false;
  return true;
}

function FilterPanel({
  f,
  set,
  apps,
  jobs,
  close,
}: {
  f: DF;
  set: (p: Partial<DF>) => void;
  apps: AppInfo[];
  jobs: Job[];
  close: () => void;
}) {
  useLang();
  const [q, setQ] = useState("");
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    jobs
      .filter((j) => matchJob(j, f, "apps"))
      .forEach((j) => m.set(j.app_id, (m.get(j.app_id) || 0) + 1));
    return m;
  }, [jobs, f]);
  const shown = apps.filter((a) =>
    `${a.name} ${a.category || ""} ${catLabel(a.category)}`
      .toLowerCase()
      .includes(q.trim().toLowerCase()),
  );
  return (
    <div className="fpanel" role="dialog" aria-label={bi("筛选交付", "Filter deliveries")}>
      <section>
        <h4>{bi("应用", "Application")}</h4>
        {apps.length > 6 && (
          <Input
            size="small"
            allowClear
            prefix={<IconSearch />}
            placeholder={bi("找应用", "Find app")}
            value={q}
            onChange={setQ}
            aria-label={bi("在应用中查找", "Filter applications")}
          />
        )}
        <div className="fpanel-apps">
          {shown.map((a) => (
            <Checkbox
              key={a.id}
              checked={f.apps.includes(a.id)}
              onChange={(c) =>
                set({
                  apps: c
                    ? [...f.apps, a.id]
                    : f.apps.filter((x) => x !== a.id),
                })
              }
            >
              <span className="fpanel-app">
                <AppGlyph id={a.id} category={a.category} size={18} />
                <span>{a.name}</span>
                <em className="num">{counts.get(a.id) || 0}</em>
              </span>
            </Checkbox>
          ))}
          {!shown.length && <span className="muted small">{bi("没有匹配的应用", "No matching applications")}</span>}
        </div>
      </section>
      <section>
        <h4>{bi("部署方式", "Delivery Mode")}</h4>
        <Segmented<ModeFilter>
          size="sm"
          label={bi("部署方式", "Delivery Mode")}
          value={f.mode}
          onChange={(v) => set({ mode: v })}
          options={[
            { value: "all", label: bi("全部", "All") },
            { value: "automatic", label: bi("自动部署", "Automated") },
            { value: "offline", label: bi("离线部署", "Offline") },
            { value: "configuration", label: bi("仅配置", "Config") },
          ]}
        />
      </section>
      <section>
        <h4>{bi("创建时间", "Created")}</h4>
        <Segmented<Range>
          size="sm"
          label={bi("创建时间", "Created")}
          value={f.range}
          onChange={(v) => set({ range: v })}
          options={(Object.keys(RANGE_LABEL) as Range[]).map((v) => ({
            value: v,
            label: RANGE_LABEL[v],
          }))}
        />
      </section>
      <section>
        <h4>{bi("排序", "Sort")}</h4>
        <Segmented<Sort>
          size="sm"
          label={bi("排序", "Sort")}
          value={f.sort}
          onChange={(v) => set({ sort: v })}
          options={[
            { value: "new", label: bi("最新", "Newest") },
            { value: "old", label: bi("最早", "Oldest") },
            { value: "name", label: bi("名称", "Name") },
          ]}
        />
      </section>
      <section>
        <h4>{bi("分组", "Group by")}</h4>
        <Segmented<Group>
          size="sm"
          label={bi("分组", "Group by")}
          value={f.sort === "name" && f.group === "day" ? "none" : f.group}
          onChange={(v) => set({ group: v })}
          options={[
            { value: "day", label: bi("按日期", "Date"), disabled: f.sort === "name" },
            { value: "app", label: bi("按应用", "Application") },
            { value: "none", label: bi("不分组", "None") },
          ]}
        />
      </section>
      <footer>
        <button
          className="link quiet"
          onClick={() =>
            set({ apps: [], mode: "all", range: "all", sort: "new", group: "day" })
          }
        >
          {bi("恢复默认", "Reset")}
        </button>
        <Button size="small" type="primary" onClick={close}>
          {bi("完成", "Done")}
        </Button>
      </footer>
    </div>
  );
}

/** A cluster as a list row: the fields the filters read, plus the cluster itself. */
type Row = Job & { c: ClusterView };

/** Filters read rows the way they read deliveries: "generated" is waiting on site, "done" running with nothing open,
    "failed" a plan that failed or nothing usable, "running" a plan being generated. */
function rowOf(c: ClusterView): Row {
  const st = clusterStatus(c);
  const ph = st.holder ? planPhase(st.holder) : null;
  return {
    c,
    delivery_mode: c.delivery_mode,
    purpose: c.purpose,
    verify_target: c.verify_target,
    id: c.id,
    owner: c.owner,
    app_id: c.app_id,
    app_name: c.app_name,
    version: c.version,
    scheme: c.scheme,
    cluster_id: c.id,
    state:
      ph === "generating"
        ? "running"
        : !st.holder && !c.head && !(c.delivery_mode === "configuration" && c.current)
          ? "failed"
          : "succeeded",
    outcome:
      ph === "failed" ? "failed" : !st.holder && c.head ? "done" : undefined,
    stage: st.holder?.stage || "",
    created: c.updated || c.created,
    logs: [],
  };
}

export function DeliveriesPage({
  jobs,
  load,
  reload,
  selected,
  tab,
  plan,
  doc,
  rehearsal,
  source,
  section,
  apps,
}: {
  jobs: Job[];
  load: LoadState;
  reload: () => Promise<void>;
  selected?: string;
  tab?: "config" | "plans" | "docs" | "rehearsal" | "security";
  plan?: string;
  doc?: string;
  rehearsal?: string;
  source?: string;
  section?: string;
  apps: AppInfo[];
}) {
  const lang = useLang();
  const narrow = useMedia("(max-width: 900px)");
  const conn = useConnectivity();
  const [stored, setF] = useStored<DF>("mh-del-filters", DF0);
  // Filters saved before the statuses or delivery mode filter existed must not hide everything.
  const f: DF = {
    ...stored,
    scope:
      stored.scope === "verification" || stored.scope === "formal"
        ? stored.scope
        : "formal",
    status: ["all", "generated", "configuration", "done", "failed"].includes(
      stored.status,
    )
      ? stored.status
      : "all",
    mode: ["all", "automatic", "offline", "configuration"].includes(
      stored.mode,
    )
      ? stored.mode
      : "all",
  };
  const set = (p: Partial<DF>) => setF((c) => ({ ...c, ...p }));
  const [panel, setPanel] = useState(false);
  const search = useRef<HTMLInputElement | null>(null);
  const appMap = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);
  // Clusters are worked out by the server from the deliveries; they are fetched again whenever the deliveries change.
  const [clusters, setClusters] = useState<ClusterView[] | null>(
    () => cached<ClusterView[]>("/api/clusters") ?? null,
  );
  const [cload, setCload] = useState<LoadState>(clusters ? "ready" : "loading");
  const loadClusters = async () => {
    try {
      const r = await api<ClusterView[]>("/api/clusters");
      setClusters(r);
      setCload("ready");
    } catch {
      setCload((x) => (clusters ? x : "error"));
    }
  };
  useEffect(() => {
    if (load !== "loading") loadClusters();
  }, [jobs, load, lang]);
  // something on the cluster page changed the cluster without a new delivery (its roadmap)
  useEffect(() => {
    const f = () => loadClusters();
    window.addEventListener("mh-clusters-changed", f);
    return () => window.removeEventListener("mh-clusters-changed", f);
  }, []);
  const refresh = async () => {
    await reload();
    await loadClusters();
  };
  const rows = useMemo(() => (clusters || []).map(rowOf), [clusters]);
  const list = useMemo(() => {
    const l = rows.filter((j) => matchJob(j, f));
    return l.sort(
      f.sort === "name"
        ? (a, b) => a.cluster_id.localeCompare(b.cluster_id)
        : f.sort === "old"
          ? (a, b) => a.created.localeCompare(b.created)
          : (a, b) => b.created.localeCompare(a.created),
    );
  }, [rows, f]);
  const statusCounts = useMemo(() => {
    const base = rows.filter((j) => matchJob(j, f, "status"));
    return {
      all: base.length,
      configuration: base.filter((j) => phaseOf(j) === "configuration").length,
      generated: base.filter((j) => phaseOf(j) === "generated").length,
      done: base.filter((j) => phaseOf(j) === "done").length,
      failed: base.filter((j) => phaseOf(j) === "failed").length,
    };
  }, [rows, f]);
  const modeCounts = useMemo(() => {
    const base = rows.filter((j) => matchJob(j, f, "mode"));
    return {
      all: base.length,
      automatic: base.filter((j) => normalizeDeliveryMode(j.delivery_mode) === "automatic").length,
      offline: base.filter((j) => normalizeDeliveryMode(j.delivery_mode) === "offline").length,
      configuration: base.filter((j) => normalizeDeliveryMode(j.delivery_mode) === "configuration").length,
    };
  }, [rows, f]);
  const scopeCounts = useMemo(() => {
    const base = rows.filter((j) => matchJob(j, f, "scope"));
    const verification = base.filter((j) => j.purpose === "verification").length;
    return {
      formal: base.length - verification,
      verification,
      totalVerification: rows.filter((j) => j.purpose === "verification").length,
    };
  }, [rows, f]);
  const usable = apps.filter((a) => a.available);
  const app = usable[0];
  const extra =
    f.apps.length +
    (f.mode !== "all" ? 1 : 0) +
    (f.range !== "all" ? 1 : 0) +
    (f.sort !== "new" ? 1 : 0) +
    (f.group !== "day" ? 1 : 0);
  const filtered =
    !!f.q.trim() ||
    f.status !== "all" ||
    f.mode !== "all" ||
    f.apps.length > 0 ||
    f.range !== "all";
  const clear = () =>
    setF((c) => ({ ...DF0, scope: c.scope, sort: c.sort, group: c.group }));
  const multiApp =
    new Set(rows.map((j) => j.app_id)).size > 1 || apps.length > 1;
  const cluster = clusters?.find((c) => c.id === selected);

  // Keep scope aligned when deep-linking directly to a verification or formal cluster.
  useEffect(() => {
    if (!cluster) return;
    const want: ScopeFilter =
      cluster.purpose === "verification" ? "verification" : "formal";
    if (f.scope !== want) {
      set({ scope: want });
    }
  }, [cluster?.id, cluster?.purpose]);

  // Desktop always shows a detail; pick the first one in view when nothing is selected. Not something the user asked for, so no transition.
  useEffect(() => {
    if (!narrow && !selected && list.length) {
      const compat = parseClusterUrlCompat();
      go(
        {
          name: "deliveries",
          id: list[0].id,
          tab: compat.tab,
          plan: compat.plan,
          doc: compat.doc,
          rehearsal: compat.rehearsal,
          source: compat.source,
          section: compat.section,
        },
        { replace: true, instant: true },
      );
    }
  }, [narrow, selected, list]);

  // Links made before clusters existed point at a delivery; open it inside its cluster.
  useEffect(() => {
    if (!selected || cluster || cload !== "ready") return;
    const j = jobs.find((x) => x.id === selected);
    if (j)
      go(
        { name: "deliveries", id: j.cluster_id, tab: "plans", plan: j.id },
        { replace: true, instant: true },
      );
  }, [selected, cluster, cload, jobs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        document.querySelector(
          ".arco-modal-wrapper,.arco-drawer-wrapper,.pal-mask",
        )
      )
        return;
      if (e.key === "/" && !typing(e)) {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      if (typing(e)) return;
      if (e.key === "f") {
        e.preventDefault();
        setPanel((p) => !p);
        return;
      }
      const d =
        e.key === "ArrowDown" || e.key === "j"
          ? 1
          : e.key === "ArrowUp" || e.key === "k"
            ? -1
            : 0;
      if (!d || !list.length) return;
      e.preventDefault();
      const i = list.findIndex((j) => j.id === selected);
      const next =
        list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + d))];
      go({ name: "deliveries", id: next.id, tab }, { replace: true });
      document
        .getElementById(`row-${next.id}`)
        ?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, selected, tab]);

  // A cluster opened by link may be newer than the list we hold; refresh once instead of hiding it.
  const known = !selected || !!cluster;
  useEffect(() => {
    if (cload === "ready" && !known) loadClusters();
  }, [selected, known, cload]);

  const [rehearsalFocus, setRehearsalFocus] = useState(false);
  useEffect(() => {
    if (tab !== "rehearsal" || !!plan) {
      setRehearsalFocus(false);
    }
  }, [selected, tab, plan]);

  if (cload === "ready" && rows.length === 0 && !selected)
    return (
      <div className="page-empty enter">
        <PackagesArt />
        <h1>{bi("还没有交付", "No deliveries yet")}</h1>
        <p>
          {bi(
            "选择应用和拓扑、填写节点与入口，平台会为每台机器生成上传包和对应的执行手册，支持离线手工部署或授权执行节点自动部署。",
            "Choose an app and topology, specify hosts and endpoints, and generate per-host upload packages and runbooks for manual offline or automated node execution.",
          )}
        </p>
        <div className="row-gap">
          {can("delivery.create") && (
            <Button
              type="primary"
              size="large"
              icon={<IconPlus />}
              onClick={() => go({ name: "new" })}
            >
              {bi("新建集群交付", "New Cluster Delivery")}
            </Button>
          )}
          <Button size="large" onClick={() => go({ name: "apps" })}>
            {bi("浏览应用", "Browse Apps")}
          </Button>
        </div>
        {!app && (
          <p className="muted small">
            {bi("当前没有离线材料齐全的应用，请联系管理员", "No apps with complete offline artifacts; contact your administrator")}
          </p>
        )}
      </div>
    );

  const showList = !narrow || !selected;
  const showDetail = !narrow || !!selected;
  const isImmersiveRehearsal = rehearsalFocus && tab === "rehearsal" && !plan;

  return (
    <div className={`md-split ${isImmersiveRehearsal ? "rh-immersive" : ""}`}>
      {showList && (
        <aside
          className="md-list"
          aria-label={bi("集群列表", "Cluster list")}
          aria-hidden={isImmersiveRehearsal || undefined}
        >
          <div className="list-head">
            <div className="list-title">
              <h1>{bi("交付", "Deliveries")}</h1>
              {can("delivery.create") && (
                <Button
                  type="primary"
                  size="small"
                  icon={<IconPlus />}
                  onClick={() => go({ name: "new" })}
                >
                  {bi("新建", "New")}
                </Button>
              )}
            </div>
            <div className="search-row">
              <Input
                ref={(r) => {
                  search.current =
                    (r as unknown as { dom?: HTMLInputElement })?.dom ?? null;
                }}
                prefix={<IconSearch />}
                suffix={!f.q ? <Kbd>/</Kbd> : undefined}
                allowClear
                placeholder={bi(
                  "搜索集群、应用、自动/离线",
                  "Search cluster, app, auto/offline",
                )}
                value={f.q}
                onChange={(v) => set({ q: v })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && list[0])
                    go({ name: "deliveries", id: list[0].id });
                  if (e.key === "Escape")
                    (set({ q: "" }), (e.target as HTMLInputElement).blur());
                }}
                aria-label={bi("搜索集群", "Search clusters")}
              />
              <Popover
                className="fpanel-pop"
                trigger="click"
                position="bl"
                triggerProps={{ autoFitPosition: true }}
                popupVisible={panel}
                onVisibleChange={setPanel}
                unmountOnExit
                content={
                  <FilterPanel
                    f={f}
                    set={set}
                    apps={apps}
                    jobs={rows}
                    close={() => setPanel(false)}
                  />
                }
              >
                <Button
                  className={`filter-btn ${extra ? "on" : ""}`}
                  icon={<IconFilter />}
                  aria-label={bi(`筛选${extra ? `，已设置 ${extra} 项` : ""}`, `Filter${extra ? ` (${extra} active)` : ""}`)}
                  aria-expanded={panel}
                >
                  {extra > 0 && <em className="num">{extra}</em>}
                </Button>
              </Popover>
            </div>
            {(scopeCounts.totalVerification > 0 || f.scope === "verification") && (
              <Segmented<ScopeFilter>
                size="sm"
                label={bi("交付类型", "Delivery scope")}
                value={f.scope}
                onChange={(v) => set({ scope: v })}
                options={[
                  {
                    value: "formal",
                    label: bi("正式集群", "Production"),
                    count: scopeCounts.formal,
                  },
                  {
                    value: "verification",
                    label: bi("组件验证", "Verification"),
                    count: scopeCounts.verification,
                  },
                ]}
              />
            )}
            <Segmented<Status>
              size="sm"
              label={bi("按状态筛选", "Filter by status")}
              value={f.status}
              onChange={(v) => set({ status: v })}
              options={[
                { value: "all", label: bi("全部", "All"), count: statusCounts.all },
                {
                  value: "generated",
                  label: bi("待执行", "Ready"),
                  count: statusCounts.generated,
                },
                ...(statusCounts.configuration || f.status === "configuration"
                  ? [{ value: "configuration" as const, label: bi("仅配置", "Config"), count: statusCounts.configuration }]
                  : []),
                { value: "done", label: bi("运行中", "Running"), count: statusCounts.done },
                { value: "failed", label: bi("失败", "Failed"), count: statusCounts.failed },
              ]}
            />
            <div
              className="dm-filter-bar"
              role="group"
              aria-label={bi("按部署方式筛选", "Filter by delivery mode")}
            >
              <button
                type="button"
                className={`dm-filter-pill ${f.mode === "all" ? "on" : ""}`}
                aria-pressed={f.mode === "all"}
                onClick={() => set({ mode: "all" })}
              >
                {bi("全部方式", "All modes")}
              </button>
              <button
                type="button"
                className={`dm-filter-pill is-auto ${f.mode === "automatic" ? "on" : ""}`}
                aria-pressed={f.mode === "automatic"}
                title={bi("自动部署", "Automated deployment")}
                onClick={() =>
                  set({ mode: f.mode === "automatic" ? "all" : "automatic" })
                }
              >
                <DeliveryModeIcon mode="automatic" size={11} />
                <span>{bi("自动", "Auto")}</span>
                <em className="num">{modeCounts.automatic}</em>
              </button>
              <button
                type="button"
                className={`dm-filter-pill ${f.mode === "offline" ? "on" : ""}`}
                aria-pressed={f.mode === "offline"}
                title={bi("离线部署", "Offline deployment")}
                onClick={() =>
                  set({ mode: f.mode === "offline" ? "all" : "offline" })
                }
              >
                <DeliveryModeIcon mode="offline" size={11} />
                <span>{bi("离线", "Offline")}</span>
                <em className="num">{modeCounts.offline}</em>
              </button>
              {(modeCounts.configuration > 0 || f.mode === "configuration") && (
                <button
                  type="button"
                  className={`dm-filter-pill is-config ${f.mode === "configuration" ? "on" : ""}`}
                  aria-pressed={f.mode === "configuration"}
                  onClick={() =>
                    set({
                      mode: f.mode === "configuration" ? "all" : "configuration",
                    })
                  }
                >
                  <DeliveryModeIcon mode="configuration" size={11} />
                  <span>{bi("仅配置", "Config")}</span>
                  <em className="num">{modeCounts.configuration}</em>
                </button>
              )}
            </div>
            {(f.apps.length > 0 || f.range !== "all") && (
              <div className="active-filters tight">
                {f.apps.map((id) => (
                  <FilterChip
                    key={id}
                    size="small"
                    label={appMap.get(id)?.name || id}
                    onClose={() =>
                      set({ apps: f.apps.filter((x) => x !== id) })
                    }
                  />
                ))}
                {f.range !== "all" && (
                  <FilterChip
                    size="small"
                    label={RANGE_LABEL[f.range]}
                    onClose={() => set({ range: "all" })}
                  />
                )}
              </div>
            )}
            {filtered && cload === "ready" && (
              <div className="result-line num" aria-live="polite">
                {bi(`显示 ${list.length} / ${rows.length} 个集群`, `Showing ${list.length} of ${rows.length} ${rows.length === 1 ? "cluster" : "clusters"}`)}
                {list.length > 0 && (
                  <button className="link quiet" onClick={clear}>
                    {bi("清除筛选", "Clear filters")}
                  </button>
                )}
              </div>
            )}
            {conn !== "online" && (
              <div className="cl-conn-bar" role="status" aria-live="polite">
                <StatusDot state={conn === "offline" ? "failed" : "deviated"} />
                <span>
                  {conn === "offline"
                    ? bi("网络已断开，当前显示本地缓存", "Offline — showing cached data")
                    : bi("服务暂时不可达，当前显示本地缓存", "Server unreachable — showing cached data")}
                </span>
                <button type="button" className="link quiet" onClick={refresh}>
                  {bi("重试", "Retry")}
                </button>
              </div>
            )}
          </div>
          <JobList
            jobs={list}
            selected={selected}
            activeTab={tab}
            load={cload}
            reload={refresh}
            filtered={filtered}
            clear={clear}
            f={f}
            appMap={appMap}
            multiApp={multiApp}
          />
        </aside>
      )}
      {showDetail && (
        <section className="md-detail" aria-live="polite">
          {cluster ? (
            <ClusterDetail
              key={cluster.id}
              c={cluster}
              tab={tab}
              plan={plan}
              doc={doc}
              rehearsal={rehearsal}
              source={source}
              section={section}
              narrow={narrow}
              reload={refresh}
              appMap={appMap}
              rehearsalFocus={isImmersiveRehearsal}
              onRehearsalFocusChange={setRehearsalFocus}
            />
          ) : cload === "loading" ||
            (selected && cload === "ready" && !known) ? (
            <DetailSkeleton />
          ) : cload === "error" ? (
            <div className="detail-none enter" role="alert">
              <IconExclamationCircle className="bad" />
              <h2>{bi("集群列表读取失败", "Failed to load clusters")}</h2>
              <p>{bi("无法获取最新集群状态，请检查网络连接后重试。", "Unable to retrieve cluster status. Check your connection and retry.")}</p>
              <Button icon={<IconRefresh />} onClick={refresh}>
                {bi("重试", "Retry")}
              </Button>
            </div>
          ) : selected ? (
            <div className="detail-none enter">
              <h2>{bi("找不到这个集群", "Cluster not found")}</h2>
              <p>{bi("它可能已被删除，或属于其他账户。", "It may have been deleted or belong to another account.")}</p>
              <Button
                onClick={() => go({ name: "deliveries" }, { replace: true })}
              >
                {bi("返回列表", "Back to List")}
              </Button>
            </div>
          ) : (
            <div className="detail-none">
              <p>{bi("没有符合条件的集群", "No matching clusters")}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function JobList({
  jobs,
  selected,
  activeTab,
  load,
  reload,
  filtered,
  clear,
  f,
  appMap,
  multiApp,
}: {
  jobs: Row[];
  selected?: string;
  activeTab?: "config" | "plans" | "docs" | "rehearsal" | "security";
  load: LoadState;
  reload: () => Promise<void>;
  filtered: boolean;
  clear: () => void;
  f: DF;
  appMap: Map<string, AppInfo>;
  multiApp: boolean;
}) {
  useLang();
  const box = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ y: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = selected ? document.getElementById(`row-${selected}`) : null;
    const container = box.current;
    const measure = () => setInd(
      el && container?.contains(el)
        ? { y: el.offsetTop, h: el.offsetHeight }
        : null,
    );
    measure();
    if (!container || !el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    container.querySelectorAll('[role="group"]').forEach((group) => observer.observe(group));
    return () => observer.disconnect();
  }, [selected, jobs, f.group]);

  if (load === "loading" && !jobs.length)
    return (
      <div className="list-body">
        {[0, 1, 2, 3, 4].map((i) => (
          <div className="row-skel" key={i}>
            <Skeleton animation text={{ rows: 2, width: ["62%", "40%"] }} />
          </div>
        ))}
      </div>
    );
  if (load === "error" && !jobs.length)
    return (
      <div className="list-state">
        <IconExclamationCircle className="bad" />
        <p>{bi("交付记录加载失败", "Failed to load deliveries")}</p>
        <Button size="small" icon={<IconRefresh />} onClick={reload}>
          {bi("重试", "Retry")}
        </Button>
      </div>
    );
  if (!jobs.length)
    return (
      <div className="list-state">
        <p>{bi("没有匹配的集群", "No matching clusters")}</p>
        {filtered && (
          <Button size="small" onClick={clear}>
            {bi("清除筛选", "Clear filters")}
          </Button>
        )}
      </div>
    );

  const mode: Group = f.sort === "name" && f.group === "day" ? "none" : f.group;
  const groups: { key: string; label: React.ReactNode; items: Row[] }[] = [];
  for (const j of jobs) {
    const key =
      mode === "none" ? "" : mode === "app" ? j.app_id : dayLabel(j.created);
    let g = groups[groups.length - 1];
    if (mode === "app") g = groups.find((x) => x.key === key) || g;
    if (!g || g.key !== key) {
      const a = appMap.get(j.app_id);
      g = {
        key,
        label:
          mode === "app" ? (
            <>
              <AppGlyph id={j.app_id} category={a?.category} size={16} />
              {j.app_name}
            </>
          ) : (
            key
          ),
        items: [],
      };
      groups.push(g);
    }
    g.items.push(j);
  }
  return (
    <div className="list-body" ref={box} role="listbox" aria-label={bi("集群", "Clusters")}>
      {ind && (
        <span
          className="row-indicator"
          style={{ transform: `translateY(${ind.y}px)`, height: ind.h }}
          aria-hidden
        />
      )}
      {groups.map((g) => (
        <div key={g.key || "all"} role="group" aria-label={g.key || bi("全部", "All")}>
          {mode !== "none" && (
            <div className="list-day">
              {g.label}
              {mode === "app" && <em className="num">{g.items.length}</em>}
            </div>
          )}
          {g.items.map((j) => {
            const a = appMap.get(j.app_id);
            const c = j.c;
            const st = clusterStatus(c);
            const stLabel = st.label
              .replace(/^首次部署待执行$/, bi("待执行", "Ready"))
              .replace(/^部署待执行$/, bi("待执行", "Ready"))
              .replace(/^首次部署执行中$/, bi("执行中", "Deploying"))
              .replace(/^部署执行中$/, bi("执行中", "Deploying"))
              .replace(/^首次部署/, bi("部署", "Deploy"))
              .replace(/^Initial Deploy\b/, "Deploy");
            const bad = st.dot === "failed";
            const appMeta = `${multiApp && mode !== "app" ? `${j.app_name} ` : ""}${j.version.split("·")[0].trim()}`;
            const fullSubTitle = [st.label, appMeta, schemeName(c.scheme)]
              .filter(Boolean)
              .join(" · ");
            return (
              <a
                key={j.id}
                id={`row-${j.id}`}
                href={`#/d/${encodeURIComponent(j.id)}${activeTab ? `/${activeTab}` : ""}`}
                role="option"
                aria-selected={j.id === selected}
                className={`row row-dlv ${j.id === selected ? "on" : ""}`}
                onPointerEnter={() => c.current && prefetchDetail(c.current)}
                onFocus={() => c.current && prefetchDetail(c.current)}
                onClick={(e) => {
                  e.preventDefault();
                  go(
                    { name: "deliveries", id: j.id, tab: activeTab },
                    { replace: !!selected },
                  );
                }}
              >
                <span className="row-ico">
                  <AppGlyph id={j.app_id} category={a?.category} size={30} />
                  <StatusDot state={st.dot} />
                </span>
                <div className="row-main">
                  <div className="row-top">
                    <span className="row-name" title={j.cluster_id}>
                      {j.cluster_id}
                    </span>
                    {j.owner && j.owner !== meName() && (
                      <span className="row-owner">{j.owner}</span>
                    )}
                    <span className="row-time num">
                      {mode === "day" ? clock(j.created) : ago(j.created)}
                    </span>
                  </div>
                  <div className="row-sub-line">
                    <div
                      className={`row-sub ${bad ? "bad" : ""}`}
                      title={fullSubTitle}
                    >
                      <HistoryDots c={c} />
                      {st.holder && running(st.holder.state)
                        ? `${stLabel} · ${(st.holder.stage || "").replace(/^\[\d\/5\]\s*/, "")}`
                        : [stLabel, appMeta].filter(Boolean).join(" · ")}
                    </div>
                    <div className="row-sub-tags">
                      {j.purpose === "verification" && (
                        <span className="row-verify-tag">
                          {bi("验证", "Verify")}
                        </span>
                      )}
                      <DeliveryModeTag mode={j.delivery_mode} compact />
                    </div>
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="detail">
      <div className="detail-head">
        <Skeleton animation text={{ rows: 2, width: ["40%", "60%"] }} />
      </div>
      <div className="dsec">
        <Skeleton
          animation
          image={{ style: { width: "100%", height: 150 } }}
          text={false}
        />
      </div>
      <div className="dsec">
        <Skeleton animation text={{ rows: 4 }} />
      </div>
    </div>
  );
}

/** Lightweight completion banner shown on temporary component test deliveries once all deploy/test steps pass.
 *  Component publishing is fully decoupled from deliveries: automated test reports are auto-saved on the component,
 *  and this temporary test delivery can be deleted anytime without affecting component release status or reports. */
export function VerificationPromoteBanner({
  jobId,
  targets,
  isTempVerification = true,
  onCleaned,
}: {
  jobId: string;
  targets?: JobPromoteTarget[];
  isTempVerification?: boolean;
  onPromoted?: () => void | Promise<void>;
  onCleaned?: () => void | Promise<void>;
}) {
  useLang();
  const [deleting, setDeleting] = useState(false);
  if (!targets || targets.length === 0) return null;
  const isAuto = targets.some((t) => t.delivery_mode === "automatic");

  const confirmDelete = () => {
    Modal.confirm({
      title: bi("删除此临时测试交付？", "Delete this temporary test delivery?"),
      content: isAuto
        ? bi(
            "自动化测试报告已独立归档至组件库；删除此临时交付及执行日志不会影响组件已保存的测试报告或发布状态。",
            "The automated test report is already archived independently on the component. Deleting this temporary delivery will not affect the saved report or release status.",
          )
        : bi(
            "将删除本次临时测试交付及其离线材料包，不影响组件发布状态。",
            "Deletes this temporary test delivery and its offline bundle without affecting component release status.",
          ),
      okText: bi("确认删除", "Delete"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        setDeleting(true);
        try {
          await api(`/api/jobs/${encodeURIComponent(jobId)}`, {
            method: "DELETE",
          });
          Message.success(
            bi("已删除临时测试交付", "Temporary test delivery deleted"),
          );
          if (onCleaned) {
            await onCleaned();
          } else {
            go({ name: "deliveries" });
          }
        } catch (e) {
          err(e);
        } finally {
          setDeleting(false);
        }
      },
    });
  };

  return (
    <section className="dsec">
      <div
        className="verify-promote-bar"
        role="region"
        aria-label={bi("组件测试结果", "Component test result")}
      >
        <div className="vp-head">
          <IconCheckCircleFill className="vp-ic" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>
              {isAuto
                ? bi(
                    "自动化测试已全步通过 · 完整测试报告已自动归档至组件",
                    "Automated test passed · Full report archived on component",
                  )
                : bi(
                    "测试部署步骤已全部标记完成",
                    "Test deployment steps marked complete",
                  )}
            </b>
            <span>
              {isAuto
                ? bi(
                    "测试报告（含分步状态与耗时）已独立保存到组件库，与本次交付完全解耦；可前往组件页确认发布，并随时删除此临时测试交付。",
                    "The step-by-step test report is saved independently on the component. Go to the component page to publish, and delete this temporary delivery anytime.",
                  )
                : bi(
                    "离线手工测试不生成自动化测试报告；如需发布版本，请前往组件页选择「手动测试」确认发布，本临时交付可随时删除。",
                    "Offline manual runs do not produce an automated report. Publish via Manual Test on the component page, and delete this temporary delivery anytime.",
                  )}
            </span>
          </div>
          {isTempVerification && (
            <Button
              size="small"
              status="danger"
              type="outline"
              icon={<IconDelete />}
              loading={deleting}
              onClick={confirmDelete}
            >
              {bi("删除测试交付", "Delete Test Delivery")}
            </Button>
          )}
        </div>
        <div className="vp-list">
          {targets.map((t) => {
            const key = `${t.component}:${t.version}:${t.platform}`;
            return (
              <div key={key} className="vp-item">
                <div className="vp-item-info">
                  <b>
                    {t.component_title} <span className="mono">{t.version}</span>
                  </b>
                  <span className="vp-os">
                    <OsLogo id={t.platform} size={13} />
                    {platformShort(t.platform)}
                  </span>
                  <span className="vp-steps num">
                    {t.delivery_mode === "automatic"
                      ? bi("自动化测试", "Automated")
                      : bi("手动测试", "Manual")}{" "}
                    · {t.passed_steps}/{t.total_steps}
                    {bi(" 步通过", " steps")}
                    {t.duration_sec ? ` · ${formatDuration(t.duration_sec)}` : ""}
                  </span>
                  <span
                    className={`vp-state ${t.needs_unlock ? "unlock" : "refresh"}`}
                  >
                    {t.needs_unlock
                      ? bi("未发布", "Unpublished")
                      : bi("已发布", "Published")}
                  </span>
                </div>
                <div className="vp-item-acts">
                  <Button
                    type="primary"
                    size="small"
                    onClick={() =>
                      go({ name: "components", id: t.component })
                    }
                  >
                    {t.needs_unlock
                      ? bi("前往组件页发布", "Go to Publish")
                      : bi("查看组件报告", "View on Component")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---------- detail ---------- */

type Grouped = {
  nodes: { index: number; ip: string; pkg?: JobFile; sha?: JobFile }[];
  extras: JobFile[];
  updates: JobFile[];
  docs: JobFile[];
  records: JobFile[];
};
function groupFiles(files: JobFile[]): Grouped {
  const g: Grouped = { nodes: [], extras: [], updates: [], docs: [], records: [] };
  const byIndex = new Map<number, Grouped["nodes"][number]>();
  for (const f of files) {
    const m = /^node(\d{2})-.+-(\d+\.\d+\.\d+\.\d+)\.tar\.gz(\.sha256)?$/.exec(
      f.name,
    );
    if (m) {
      const i = Number(m[1]);
      const n = byIndex.get(i) || { index: i, ip: m[2] };
      if (m[3]) n.sha = f;
      else n.pkg = f;
      byIndex.set(i, n);
    } else if (/^update-\d+-.*\.tar\.gz(\.sha256)?$/.test(f.name)) {
      g.updates.push(f);
    } else if (/\.tar\.gz$|^SHA256SUMS$/.test(f.name)) g.extras.push(f);
    else if (/^\d\d-.+\.md$/.test(f.name)) g.docs.push(f);
    else g.records.push(f);
  }
  g.nodes = [...byIndex.values()].sort((a, b) => a.index - b.index);
  g.docs.sort((a, b) => a.name.localeCompare(b.name));
  g.updates.sort((a, b) => a.name.localeCompare(b.name));
  g.extras.sort((a, b) =>
    a.name === "SHA256SUMS"
      ? 1
      : b.name === "SHA256SUMS"
        ? -1
        : a.name.localeCompare(b.name),
  );
  return g;
}

/** The on-site progress of a delivery. */
const runNote = (j: Job) =>
  j.state === "succeeded" && ((j.run_done || 0) > 0 || (j.run_failed || 0) > 0)
    ? bi(
        ` · 现场 ${j.run_done || 0}${j.run_total ? `/${j.run_total}` : ""} 步${j.run_failed ? `，${j.run_failed} 步失败` : ""}`,
        ` · On-site ${j.run_done || 0}${j.run_total ? `/${j.run_total}` : ""} steps${j.run_failed ? `, ${j.run_failed} failed` : ""}`,
      )
    : "";

/** One delivery of a cluster — its first deployment or a plan — with its files, runbook and the engineer's report. */
export function DeliveryDetail({
  id,
  narrow,
  onChanged,
  cluster,
  embedded = false,
  revisionBar,
}: {
  id: string;
  narrow: boolean;
  onChanged: () => Promise<void>;
  cluster: ClusterView;
  embedded?: boolean;
  revisionBar?: React.ReactNode;
}) {
  const lang = useLang();
  const cached = detailCache.get(id) || null;
  const [d, setD] = useState<JobDetail | null>(cached);
  const [state, setState] = useState<"loading" | "missing" | "error" | "ready">(
    cached ? "ready" : "loading",
  );
  const [message, setMessage] = useState("");
  const [undoingOutcome, setUndoingOutcome] = useState(false);
  const [syncCheckTick, setSyncCheckTick] = useState(0);
  const [focusSyncTick, setFocusSyncTick] = useState(0);
  const wasRunning = useRef(!!cached && running(cached.job.state));
  // The detail pane is one scroller shared by every delivery; start each at the top.
  useLayoutEffect(() => {
    if (!embedded) document.querySelector(".md-detail")?.scrollTo({ top: 0 });
  }, [id, embedded]);

  const fetchDetail = async () => {
    try {
      const r = await api<JobDetail>(`/api/jobs/${id}`);
      putDetailCache(id, r);
      setD(r);
      setState("ready");
      if (wasRunning.current && !running(r.job.state)) {
        onChanged();
        if (r.job.state === "succeeded")
          Message.success(
            r.job.delivery_mode === "configuration"
              ? bi(`${r.job.cluster_id} 的配置交付已生成`, `Config delivery for ${r.job.cluster_id} is ready`)
              : bi(`${r.job.cluster_id} 的部署材料已生成`, `Deployment bundle for ${r.job.cluster_id} is ready`),
          );
      }
      wasRunning.current = running(r.job.state);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) setState("missing");
      else if (!d) {
        setState("error");
        setMessage((e as Error).message);
      }
    }
  };
  useEffect(() => {
    fetchDetail();
  }, [id, lang]);
  useEffect(() => {
    if (!d || !running(d.job.state)) return;
    const t = setInterval(fetchDetail, 1000);
    return () => clearInterval(t);
  }, [d?.job.state, id]);

  const toPlans = () =>
    go({ name: "deliveries", id: cluster.id, tab: "plans" }, { replace: true });
  const back = embedded ? null : (
    <nav className="cl-crumb" aria-label={bi("返回部署", "Back to deployments")}>
      <button type="button" className="cl-return" onClick={toPlans}>
        <IconArrowLeft /> {bi("部署", "Deploy")}
      </button>
      <span className="cl-crumb-sep" aria-hidden>
        /
      </span>
      <span className="cl-back-id mono" title={cluster.id}>
        {cluster.id}
      </span>
    </nav>
  );

  if (state === "loading")
    return embedded ? (
      <section className="dsec">
        <Skeleton animation text={{ rows: 6 }} />
      </section>
    ) : (
      <DetailSkeleton />
    );
  if (state === "missing")
    return (
      <div className="detail-none enter">
        {back}
        <h2>{bi("找不到这份交付", "Delivery not found")}</h2>
        <p>{bi("它可能已被删除，或属于其他账户。", "It may have been deleted or belong to another account.")}</p>
        {!embedded && <Button onClick={toPlans}>{bi("返回部署", "Back to Deploy")}</Button>}
      </div>
    );
  if (state === "error" || !d)
    return (
      <div className="detail-none enter">
        {back}
        <h2>{bi("详情加载失败", "Failed to load details")}</h2>
        <p>{message}</p>
        <Button
          icon={<IconRefresh />}
          onClick={() => (setState("loading"), fetchDetail())}
        >
          {bi("重试", "Retry")}
        </Button>
      </div>
    );

  const { job, files, spec } = d;
  const input = spec?.deployment;
  const plan = d.plan;
  const g = groupFiles(files);
  const done = !running(job.state);

  const remove = () =>
    Modal.confirm({
      title:
        job.delivery_mode === "configuration"
          ? bi("删除这份配置交付？", "Delete this config delivery?")
          : bi("删除这份部署交付？", "Delete this delivery?"),
      content:
        job.outcome === "done" || job.outcome === "deviated"
          ? bi(
              "它已经确认完成，是集群当前状态的来源。删除后不会改动任何目标服务器；只在确实没有执行过时删除。",
              "This delivery is marked completed and represents the cluster's current baseline. Deleting it will not alter target hosts; only delete if it was never executed.",
            )
          : bi(
              "只删除平台上保存的证书、私钥和交付文件，不会连接或改动任何目标服务器。",
              "Only removes certificates, keys, and bundle files stored on the platform; target hosts are untouched.",
            ),
      okText: bi("删除", "Delete"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          await api(`/api/jobs/${job.id}`, { method: "DELETE" });
          detailCache.delete(job.id);
          Message.success(bi("已删除", "Deleted"));
          await onChanged();
          go(
            cluster.plans.length > 1
              ? { name: "deliveries", id: cluster.id, tab: "plans" }
              : { name: "deliveries" },
            { replace: true },
          );
        } catch (e) {
          err(e);
        }
      },
    });

  const saved = async (r: Job) => {
    const next = { ...d, job: r };
    detailCache.set(job.id, next);
    setD(next);
    await onChanged();
  };
  const later = false;
  const canRevise =
    job.state === "succeeded" &&
    !job.revised_by &&
    job.outcome !== "done" &&
    job.outcome !== "deviated" &&
    job.outcome !== "void" &&
    cluster.holder === job.id &&
    can("delivery.create");

  const files0 = files;
  const totalBytes = files0.reduce((n, f) => n + f.bytes, 0);
  const params = (input?.instances || []).flatMap((i) =>
    Object.entries(i.params || {}).map(
      ([k, v]) =>
        [`${i.id}.${k}`, Array.isArray(v) ? v.join(bi("、", ", ")) : String(v)] as [
          string,
          string,
        ],
    ),
  );
  const controllerName = plan?.controller;
  const executorHost = plan?.execution_host || input?.execution_host;
  const deliveryHosts = [...(plan?.hosts || input?.hosts || []), ...(executorHost ? [executorHost] : [])];

  const reviewStart = {
    key: "review",
    title: bi("对话", "Chat"),
    context: `${job.cluster_id} · ${job.app_name}`,
  };
  const ph = planPhase(job);
  const settled = ph === "done" || ph === "deviated";
  const canUndoConfirm =
    job.state === "succeeded" &&
    plan?.delivery_mode !== "configuration" &&
    job.delivery_mode !== "configuration" &&
    can("delivery.run") &&
    settled &&
    !later;
  const undoConfirm = async () => {
    if (undoingOutcome) return;
    setUndoingOutcome(true);
    try {
      const j = await api<Job>(`/api/jobs/${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({ outcome: "", note: "" }),
      });
      await saved(j);
      Message.success(bi("已改回待执行", "Reverted to ready"));
    } catch (e) {
      err(e);
    } finally {
      setUndoingOutcome(false);
    }
  };
  const confirmedMeta =
    job.marked && job.outcome ? (
      <Tooltip content={fullTime(job.marked)} mini>
        <span>
          {job.marked_by || bi("管理员", "Admin")} {ago(job.marked)}
          {job.outcome === "void"
            ? bi(" 作废", " voided")
            : job.outcome === "failed"
              ? bi(" 记为失败", " marked failed")
              : bi(" 确认", " confirmed")}
        </span>
      </Tooltip>
    ) : null;
  const actionButtons = (
    <>
      {(spec || plan) && (
        <Button
          icon={<IconFile />}
          aria-label={bi("查看这份交付的配置", "View delivery configuration")}
          onClick={() =>
            go({
              name: "deliveries",
              id: cluster.id,
              tab: "config",
              source: job.id,
            })
          }
        >
          {bi("部署配置", "Configuration")}
        </Button>
      )}
      {canRevise && (
        <Button
          icon={<IconEdit />}
          onClick={() =>
            go({ name: "new", app: job.app_id, revise: job.id })
          }
        >
          {bi("修订部署配置", "Revise Config")}
        </Button>
      )}
      {job.state === "failed" && input && can("delivery.create") && (
        <Button
          type="primary"
          icon={<IconEdit />}
          onClick={() => go({ name: "new", app: job.app_id, from: job.id })}
        >
          {bi("修改后重新生成", "Edit & Rebuild")}
        </Button>
      )}
      {job.state === "succeeded" && <ReviewButton />}
      {job.state === "succeeded" && can("delivery.download") && (() => {
        const syncs = job.syncs || [];
        const latestSync = syncs[syncs.length - 1];
        const btn = (
          <Button
            type="primary"
            icon={<IconCloudDownload />}
            href={withLang(`/api/jobs/${job.id}/archive`)}
            download={`delivery-${job.cluster_id || job.id.slice(0, 8)}.zip`}
          >
            {bi("下载完整交付包", "Download Bundle")}
          </Button>
        );
        if (!latestSync) return btn;
        return (
          <Tooltip
            mini
            content={
              latestSync.kind === "patch"
                ? bi(
                    `包含全部基础包与第 ${latestSync.n} 次 AI 补丁（${latestSync.update}）；解压基础包后需按「交付文件」中的补丁命令覆盖生效`,
                    `Includes base packages & AI patch #${latestSync.n} (${latestSync.update}); apply the patch command under Delivery Files after unpacking`,
                  )
                : bi(
                    `已同步至第 ${latestSync.n} 次组件更新：包含最新全部基础包与手册，首次部署直接下载使用即可，无需再单独执行增量更新包`,
                    `Synced to update #${latestSync.n}: includes latest base packages & runbooks; fresh deployments do not need the incremental patch`,
                  )
            }
          >
            {btn}
          </Tooltip>
        );
      })()}
      <Dropdown
        trigger="click"
        position="br"
        triggerProps={{ autoFitPosition: true }}
        droplist={
          <Menu
            onClickMenuItem={(k) => {
              if (k === "clone" && input) {
                go({ name: "new", app: job.app_id, from: job.id });
              }
              if (k === "undo") undoConfirm();
              if (k === "copy") copy(job.cluster_id);
              if (k === "delete") remove();
            }}
          >
            {job.state !== "failed" && input && can("delivery.create") && (
              <Menu.Item key="clone">
                <IconEdit /> {bi("以此配置新建集群", "Clone to New Cluster")}
              </Menu.Item>
            )}
            {canUndoConfirm && (
              <Menu.Item key="undo" disabled={undoingOutcome}>
                <IconUndo /> {bi("撤销确认", "Undo Confirmation")}
              </Menu.Item>
            )}
            <Menu.Item key="copy">
              <IconCopy /> {bi("复制集群标识", "Copy Cluster ID")}
            </Menu.Item>
            {can("delivery.delete") && (
              <Menu.Item
                key="delete"
                disabled={!done || later}
                className="danger-item"
              >
                <IconDelete /> {bi("删除交付", "Delete Delivery")}
              </Menu.Item>
            )}
          </Menu>
        }
      >
        <Button icon={<IconMore />} aria-label={bi("更多操作", "More actions")} />
      </Dropdown>
    </>
  );

  const effectiveMode =
    job.delivery_mode === "configuration" ||
    plan?.delivery_mode === "configuration"
      ? "configuration"
      : job.delivery_mode === "automatic" ||
          plan?.delivery_mode === "automatic"
        ? "automatic"
        : "offline";
  const latestSync = (job.syncs || [])[(job.syncs || []).length - 1] || null;
  const refreshJob = async () => {
    await fetchDetail();
    await onChanged();
  };

  const mainGrid = (
      <div className={`detail-grid ${input ? "" : "single"}`}>
        <div className="detail-main">
          {d?.verification_promote && d.verification_promote.length > 0 && (
            <VerificationPromoteBanner
              jobId={job.id}
              targets={d.verification_promote}
              isTempVerification={
                job.purpose === "verification" ||
                job.cluster_id.startsWith("verify-")
              }
              onPromoted={refreshJob}
              onCleaned={async () => {
                await onChanged();
                go({ name: "deliveries" });
              }}
            />
          )}
          {running(job.state) && (
            <section className="dsec">
              <div className="callout c-run">
                <Spin size={14} />
                <div>
                  <b>
                    {job.state === "queued"
                      ? bi("等待空闲的生成位", "Queued for build slot")
                      : bi("正在生成交付材料", "Building delivery artifacts")}
                  </b>
                  <span>
                    {bi(
                      "只在平台内校验和打包，不会连接目标服务器。可以离开此页，完成后列表会更新。",
                      "Validates and packages offline without touching target hosts. You may leave this page.",
                    )}
                  </span>
                </div>
              </div>
              <StageTrack job={job} />
            </section>
          )}
          {job.state === "failed" && (
            <section className="dsec">
              <div className="callout c-bad">
                <IconExclamationCircle />
                <div>
                  <b>{bi("生成未完成", "Build failed")}</b>
                  <span className="pre">{job.error || bi("没有返回具体原因", "No details returned")}</span>
                </div>
              </div>
              <StageTrack job={job} />
            </section>
          )}

          {job.state === "succeeded" && (
            <section className="dsec">
              <h2 className="dsec-title">
                {bi("交付文件", "Delivery Files")}
                <span className="dsec-note num">
                  {files0.length === 1
                    ? bi("1 个文件", "1 file")
                    : bi(`${files0.length} 个文件`, `${files0.length} files`)}{" "}
                  · {size(totalBytes)} ·{" "}
                  {plan?.delivery_mode === "configuration"
                    ? bi("仅生成配置，审核后应用", "Config only; apply after review")
                    : bi(
                        `逐台上传到 ${plan?.upload_dir || "/tmp/mw-upload"}`,
                        `Upload per host to ${plan?.upload_dir || "/tmp/mw-upload"}`,
                      )}
                </span>
                {plan && effectiveMode !== "configuration" && (
                  <button
                    type="button"
                    className="dsec-link link quiet"
                    onClick={() => setSyncCheckTick((n) => n + 1)}
                  >
                    <IconRefresh />
                    {bi("检查组件更新", "Check Updates")}
                  </button>
                )}
              </h2>
              {(() => {
                const fileList = (
                  <div className="uplist">
                    {plan?.delivery_mode === "configuration" && (
                      <div className="up-files">
                        {files0.map((f) => (
                          <FileLink key={f.name} f={f} />
                        ))}
                      </div>
                    )}
                    {g.nodes.map((n) => {
                      const nd = deliveryHosts[n.index - 1];
                      const isCtl = !!nd && nd.name === controllerName;
                      return (
                        <div className="up" key={n.index}>
                          <div className="up-who">
                            <span className={`role-chip ${isCtl ? "p" : ""}`}>
                              {isCtl
                                ? executorHost
                                  ? bi("执行", "Exec")
                                  : bi("控制", "Ctrl")
                                : bi("机器", "Host")}
                            </span>
                            <div>
                              <b>
                                {nd?.name ||
                                  `node${String(n.index).padStart(2, "0")}`}
                              </b>
                              <span className="mono">{n.ip}</span>
                            </div>
                          </div>
                          <div className="up-files">
                            {n.pkg && <FileLink f={n.pkg} />}
                            {n.sha && <FileLink f={n.sha} quiet />}
                            {isCtl &&
                              g.extras.map((f) => (
                                <FileLink
                                  key={f.name}
                                  f={f}
                                  quiet={f.name === "SHA256SUMS"}
                                />
                              ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
                if (!plan || effectiveMode === "configuration") return fileList;
                return (
                  <SyncCard
                    key={job.id}
                    legacySteps={(plan.step_format || 0) < 2}
                    job={job}
                    files={files0}
                    uploadDir={plan.upload_dir}
                    controllerName={controllerName}
                    isAutoDelivery={effectiveMode === "automatic"}
                    triggerTick={syncCheckTick}
                    onSynced={refreshJob}
                    onJumpToSyncStep={() => setFocusSyncTick((n) => n + 1)}
                  >
                    {fileList}
                  </SyncCard>
                );
              })()}
            </section>
          )}

          {job.state === "succeeded" && plan && effectiveMode !== "configuration" && (
            <section className="dsec">
              <h2 className="dsec-title">
                {bi("现场执行", "On-site Execution")}
                <DeliveryModeTag mode={effectiveMode} />
              </h2>
              <ExecutionPanel
                key={job.id}
                jobId={job.id}
                cluster={job.cluster_id}
                deliveryMode={effectiveMode}
              />
              <Runbook
                key={`${job.id}-${(job.syncs || []).length}`}
                plan={plan}
                docs={g.docs}
                jobId={job.id}
                files={files0}
                deliveryMode={effectiveMode}
                latestSync={latestSync}
                onSyncConfirmed={refreshJob}
                focusSyncTick={focusSyncTick}
              />
            </section>
          )}
          {job.state === "succeeded" && (!plan || plan.delivery_mode==="configuration") && g.docs.length > 0 && (
            <section className="dsec">
              <h2 className="dsec-title">{bi("手册", "Runbook Docs")}</h2>
              <div className="up-files">
                {g.docs.map((f) => (
                  <FileLink key={f.name} f={f} />
                ))}
              </div>
            </section>
          )}

          {!input && job.state === "succeeded" && files0.length === 0 && (
            <section className="dsec">
              <p className="muted">{bi("这份交付没有可下载的文件。", "No downloadable files in this delivery.")}</p>
            </section>
          )}
        </div>

        {input && (
          <aside className="detail-side" aria-label={bi("集群配置", "Cluster configuration")}>
            <section className="side-sec">
              <h2 className="dsec-title">{bi("集群", "Cluster")}</h2>
              <ExecutionHostSummary host={executorHost} />
              {plan && (
                <InstanceGraph
                  hosts={plan.hosts}
                  instances={plan.instances}
                  controller={plan.controller}
                />
              )}
              <dl className="side-facts">
                <div>
                  <dt>{bi("机器", "Hosts")}</dt>
                  <dd>{input.hosts.length === 1 ? bi("1 台", "1 host") : bi(`${input.hosts.length} 台`, `${input.hosts.length} hosts`)}</dd>
                </div>
                <div>
                  <dt>{executorHost ? bi("独立执行机", "Standalone executor") : bi("集群内执行机", "In-cluster executor")}</dt>
                  <dd className="mono">
                    {controllerName || input.controller || bi("自动", "Auto")}
                  </dd>
                </div>
                {(
                  plan?.instances ||
                  input.instances.map((i) => ({
                    id: i.id,
                    title: i.component,
                    version: i.version || "",
                    auto: false,
                    status: "",
                  }))
                ).map((i) => (
                  <div key={i.id}>
                    <dt>
                      <span className="mono">{i.id}</span>
                    </dt>
                    <dd>
                      {i.title} {i.version}
                      {"auto" in i && i.auto ? (
                        <span className="flag info">{bi("自动", "Auto")}</span>
                      ) : null}
                      {"status" in i && i.status && i.status !== "published" ? (
                        <span className="flag warn">{bi("待验证", "Unverified")}</span>
                      ) : null}
                    </dd>
                  </div>
                ))}
                {input.hosts.some((h) => h.initialize) && (
                  <div>
                    <dt>{bi("数据盘", "Data disk")}</dt>
                    <dd>
                      <span className="warn">{bi("格式化空盘", "Format empty disk")}</span>
                    </dd>
                  </div>
                )}
              </dl>
            </section>
            {params.length > 0 && (
              <section className="side-sec">
                <h2 className="dsec-title">
                  {bi("定制参数", "Custom Parameters")}{" "}
                  <span className="dsec-count num">{params.length}</span>
                </h2>
                <div className="kvlist">
                  {params.map(([k, v]) => (
                    <div key={k}>
                      <code>{k}</code>
                      <span className="mono">{v}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {job.state === "succeeded" && g.records.length > 0 && (
              <section className="side-sec">
                <h2 className="dsec-title">{bi("生成记录", "Build Logs")}</h2>
                {job.logs.length > 0 && (
                  <details className="gen-log">
                    <summary>
                      {bi("生成过程", "Build trace")}{" "}
                      <span className="faint small">
                        {job.logs.length === 1
                          ? bi("1 行", "1 line")
                          : bi(`${job.logs.length} 行`, `${job.logs.length} lines`)}
                        {job.updated
                          ? bi(` · 用时 ${duration(job.created, job.updated)}`, ` · Took ${duration(job.created, job.updated)}`)
                          : ""}
                      </span>
                    </summary>
                    <ol>
                      {job.logs.map((l, i) => (
                        <li key={i}>{l.replace(/^\[\d\/\d\]\s*/, "")}</li>
                      ))}
                    </ol>
                  </details>
                )}
                <div className="up-files">
                  {g.records.map((f) => (
                    <FileLink key={f.name} f={f} quiet />
                  ))}
                </div>
              </section>
            )}
          </aside>
        )}
      </div>
  );

  const deployLabel =
    job.delivery_mode === "configuration"
      ? bi("配置交付", "Config Delivery")
      : bi("部署手册", "Deployment Runbook");
  const standaloneLabel =
    job.delivery_mode === "configuration"
      ? bi("配置交付", "Config Delivery")
      : bi("集群部署", "Cluster Deployment");

  if (embedded) {
    return (
      <div className="cl-init-deploy">
        {revisionBar}
        <div className="cl-deploy-head">
          <div className="cl-deploy-head-left">
            <div className="cl-deploy-title-row">
              <h2 className="cl-deploy-title">{deployLabel}</h2>
              <StatusBadge
                state={PLAN_PHASE[ph].dot}
                label={PLAN_PHASE[ph].label}
              />
              <DeliveryModeTag mode={effectiveMode} />
            </div>
            <div className="cl-deploy-meta">
              {job.owner && job.owner !== meName() && (
                <span>{bi(`${job.owner} 生成`, `Built by ${job.owner}`)}</span>
              )}
              <Tooltip content={fullTime(job.created)} mini>
                <span>{bi(`创建于 ${ago(job.created)}`, `Created ${ago(job.created)}`)}</span>
              </Tooltip>
              {done && job.updated && (
                <span className="num">
                  {bi(`耗时 ${duration(job.created, job.updated)}`, `Duration ${duration(job.created, job.updated)}`)}
                </span>
              )}
              {confirmedMeta}
              <span className="mono faint">#{job.id.slice(0, 8)}</span>
            </div>
          </div>
          <div className="cl-deploy-actions">{actionButtons}</div>
        </div>
        {job.state === "succeeded" &&
          plan?.delivery_mode !== "configuration" &&
          job.delivery_mode !== "configuration" && (
            <OutcomeBar
              job={job}
              later={later}
              onSaved={saved}
              plan={plan}
              spec={input}
            />
          )}
        {!!job.revises && <LineagePanel lineage={d.lineage} />}
        {mainGrid}
      </div>
    );
  }

  const page = (
    <article
      className="detail enter"
      aria-label={`${standaloneLabel} ${job.cluster_id}`}
    >
      {back}
      <header className="detail-head">
        <div className="detail-title">
          <h1 className="cl-plan-title">{standaloneLabel}</h1>
          <StatusBadge
            state={PLAN_PHASE[ph].dot}
            label={PLAN_PHASE[ph].label}
          />
          <DeliveryModeTag mode={effectiveMode} />
        </div>
        <div className="detail-meta">
          {job.owner && job.owner !== meName() && (
            <span className="row-owner">{bi(`${job.owner} 生成`, `Built by ${job.owner}`)}</span>
          )}
          <span>
            {job.app_name} {job.version}
          </span>
          <Tooltip content={fullTime(job.created)} mini>
            <span>{bi(`创建于 ${ago(job.created)}`, `Created ${ago(job.created)}`)}</span>
          </Tooltip>
          {done && job.updated && (
            <span className="num">{bi(`用时 ${duration(job.created, job.updated)}`, `Took ${duration(job.created, job.updated)}`)}</span>
          )}
          {confirmedMeta}
          <span className="mono faint">#{job.id.slice(0, 8)}</span>
        </div>
        <SchemeInfo scheme={job.scheme} detail label={bi("部署方案", "Deployment scheme")} />
        {job.state === "succeeded" &&
          plan?.delivery_mode !== "configuration" &&
          job.delivery_mode !== "configuration" && (
            <OutcomeBar
              job={job}
              later={later}
              onSaved={saved}
              plan={plan}
              spec={input}
            />
          )}
        {!!job.revises && <LineagePanel lineage={d.lineage} />}
        <div className="detail-actions">{actionButtons}</div>
      </header>
      {mainGrid}
    </article>
  );
  return (
    <AIDock
      scope={{ kind: "job", jobId: job.id }}
      start={reviewStart}
      hidden={job.state !== "succeeded"}
    >
      {page}
    </AIDock>
  );
}

type SyncPreview = {
  available: boolean;
  blocked?: string;
  using_drafts?: string[];
  files: string[];
  removed?: string[];
  steps: string[];
  recorded?: string[];
  phases?: {
    label: string;
    total: number;
    changed: { key: string; title: string; why: string; recorded?: boolean; new?: boolean }[];
    same?: string[];
  }[];
};

/** A component fix that came after this delivery was generated: taken into the delivery in one go, with the update
 *  package and the one command the controller needs. */
function SyncCard({
  legacySteps,
  job,
  files,
  uploadDir,
  controllerName,
  isAutoDelivery,
  triggerTick = 0,
  onSynced,
  onJumpToSyncStep,
  children,
}: {
  legacySteps: boolean;
  job: Job;
  files: JobFile[];
  uploadDir: string;
  controllerName?: string;
  isAutoDelivery?: boolean;
  triggerTick?: number;
  onSynced: () => Promise<void>;
  onJumpToSyncStep?: () => void;
  children?: React.ReactNode;
}) {
  useLang();
  const [pv, setPv] = useState<SyncPreview | null>(null);
  const [syncError, setSyncError] = useState("");
  const [retry, setRetry] = useState(0);
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const syncs = job.syncs || [];
  const last = syncs[syncs.length - 1];
  useEffect(() => {
    if (triggerTick > 0) {
      setRequested(true);
      setRetry((n) => n + 1);
    }
  }, [triggerTick]);
  useEffect(() => {
    let live = true;
    setPv(null);
    setSyncError("");
    setOpen(false);
    if (!requested) return;
    api<{ preview: SyncPreview }>(`/api/jobs/${job.id}/sync`)
      .then((r) => live && setPv(r.preview))
      .catch((e) => { if (live) setSyncError((e as Error).message); });
    return () => {
      live = false;
    };
  }, [job.id, syncs.length, retry, requested]);
  const run = () => {
    const isDraftSync = (pv?.using_drafts?.length || 0) > 0;
    Modal.confirm({
      title: isDraftSync
        ? bi(
            `热同步组件草稿（${pv!.using_drafts!.join("、")}）？`,
            `Hot-sync component draft (${pv!.using_drafts!.join(", ")})?`,
          )
        : bi("采用这次组件更新？", "Adopt component update?"),
      content: (
        <div className="sync-confirm">
          <p>
            {isDraftSync
              ? bi(
                  "验证交付可直接采用组件工作区草稿（无需提前发布）。这会更新本交付的自动化文件和手册，软件包与历史记录保留。",
                  "Verification deliveries can adopt workspace drafts directly without publishing. Updates automation files and runbook while keeping packages and history.",
                )
              : bi(
                  "这会更新本交付的自动化文件和手册，软件包不变。受影响步骤的新版本不再沿用原来的完成状态，需要重新核对；原执行记录保留在历史版本中，未受影响步骤保持原状。",
                  "Updates automation files and runbook for this delivery while keeping packages unchanged. Changed steps reset their completion status for re-verification while preserving prior records; unaffected steps stay as-is.",
                )}
          </p>
          <p>
            {isAutoDelivery
              ? bi(
                  "本交付为自动执行模式：不会立即连接目标机执行命令；你后续点击「续跑 / 自动执行」时，平台将自动把最新脚本推送至执行节点，无需重新预检环境或手工拷贝。",
                  "Automated delivery: nothing runs immediately. On your next resume, the platform automatically pushes the updated scripts to the execution node without re-running host prep.",
                )
              : bi(
                  "此操作不会连接机器或自动执行命令。更新包需要你另行应用；请核对实际变化后决定补做哪些操作，不要直接重跑初始化、数据盘等已完成步骤。",
                  "Does not connect to hosts or execute commands. Apply the update archive manually and review actual changes before deciding which steps to re-run—never blindly re-run initialization or disk formatting.",
                )}
          </p>
        </div>
      ),
      okText: isAutoDelivery
        ? bi("采用更新（续跑自动下发）", "Adopt Update")
        : bi("采用更新并生成更新包", "Adopt & Generate Update"),
      onOk: async () => {
        setBusy(true);
        try {
          await api(`/api/jobs/${job.id}/sync`, { method: "POST" });
          window.dispatchEvent(
            new CustomEvent("mh-delivery-patched", { detail: { jobId: job.id } }),
          );
          Message.success(
            isAutoDelivery
              ? bi(
                  "已同步最新脚本，下次点击「续跑 / 自动执行」将自动推送到执行节点",
                  "Synced! Next resume will auto-push the updated scripts to the execution node",
                )
              : bi(
                  "已同步，请在下方「部署」第 0 步核对并应用更新",
                  "Synced; verify and apply in Deploy step 0 below",
                ),
          );
          await onSynced();
        } catch (e) {
          err(e);
        } finally {
          setBusy(false);
        }
      },
    });
  };
  const upd = last?.update
    ? files.find((f) => f.name === last.update)
    : undefined;
  const sumFile = last?.update
    ? files.find((f) => f.name === `${last.update}.sha256`)
    : undefined;
  const aiStatus = useAIStatus();
  const canRehearse =
    aiStatus.enabled &&
    !!aiStatus.features?.change_rehearsal &&
    can("ai.use");
  const rehearsalClusterId =
    pv?.blocked &&
    job.cluster_id &&
    job.delivery_mode !== "configuration" &&
    (job.outcome === "done" || job.outcome === "deviated") &&
    canRehearse
      ? job.cluster_id
      : "";
  const hasCheckBanner = Boolean(requested || pv?.available || syncError);
  if (!hasCheckBanner && !last) return <>{children}</>;
  return (
    <>
      {hasCheckBanner && (
        <div className="sync-card">
          {requested && !pv?.available && (
        <div className="sync-pend sync-optional">
          <div className="sync-head">
            <div className="sync-text" role="status" aria-live="polite">
              <b>
                {syncError
                  ? bi("暂时无法检查更新", "Unable to check updates")
                  : !pv
                    ? bi("正在检查可选更新…", "Checking for updates…")
                    : pv.blocked
                      ? bi("当前交付暂不能同步", "Sync currently unavailable")
                      : bi("当前已是最新组件版本", "Already up to date")}
              </b>
              <span>
                {syncError
                  ? bi("检查未完成，当前交付和执行记录保持不变。", "Check incomplete; delivery and execution records remain unchanged.")
                  : pv?.blocked ||
                    (!pv
                      ? bi("正在比较新版内容，不影响查看或继续当前交付。", "Comparing component version without interrupting your current delivery.")
                      : bi("未检测到新的组件改动，可继续当前执行。", "No new component changes found; continue with this delivery."))}
              </span>
            </div>
            <div className="sync-head-actions">
              {rehearsalClusterId && (
                <Button
                  size="small"
                  type="primary"
                  onClick={() =>
                    go({
                      name: "deliveries",
                      id: rehearsalClusterId,
                      tab: "rehearsal",
                    })
                  }
                >
                  {bi("前往变更演练", "Go to Rehearsal")}
                </Button>
              )}
              <Button
                size="small"
                loading={!pv && !syncError}
                onClick={() => setRetry((n) => n + 1)}
              >
                {bi("重新检查", "Check Again")}
              </Button>
              {(pv || syncError) && (
                <Button
                  size="small"
                  type="text"
                  onClick={() => {
                    setRequested(false);
                    setPv(null);
                    setSyncError("");
                  }}
                >
                  {bi("收起", "Dismiss")}
                </Button>
              )}
            </div>
          </div>
          {syncError && <details><summary>{bi("错误详情", "Error details")}</summary><p>{syncError}</p></details>}
        </div>
      )}
      {pv?.available && (
        <div className="sync-pend">
          <div className="sync-head">
            <div className="sync-text">
              <b>
                {pv.using_drafts && pv.using_drafts.length > 0
                  ? bi(
                      `组件工作区草稿有更新（${pv.using_drafts.join("、")}）· 验证交付可直接热同步`,
                      `Component draft updated (${pv.using_drafts.join(", ")}) · Ready to hot-sync`,
                    )
                  : bi("组件有新版本", "Component update available")}
              </b>
              <span>
                {isAutoDelivery
                  ? bi(
                      "采用后仅更新本交付脚本，不立即执行命令；下次点击「续跑 / 自动执行」时将自动推送至执行节点（免重新预检）。",
                      "Adopting updates delivery scripts only; next resume auto-pushes them to the runner.",
                    )
                  : bi(
                      "你的交付尚未更新，已完成的执行记录保留。系统没有自动执行任何命令。",
                      "Your delivery is not updated yet; completed records are preserved and no commands were executed.",
                    )}
              </span>
              <span>
                {pv.steps.length > 0
                  ? bi(
                      `新版与当前版本有 ${pv.steps.length} 个步骤存在差异，不代表要全部重跑。`,
                      `${pv.steps.length} ${pv.steps.length === 1 ? "step differs" : "steps differ"} from the new version; not all require re-running.`,
                    )
                  : bi("自动化文件有更新，未检测到执行步骤受影响。", "Automation files updated; no execution steps affected.")}
              </span>
            </div>
            <Button onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? bi("收起更新详情", "Hide Update Details") : bi("查看更新详情", "View Update Details")}
            </Button>
          </div>
          {open && <>
          <p className="sync-rule">
            {bi(
              "当前集群不会自动更新，已有执行记录仍然保留。下面是采用新版后需要复核的范围，不是要求全部重跑。",
              "The cluster will not update automatically and existing records stay intact. Below is the scope to review after syncing—not everything needs to be re-run.",
            )}
          </p>
          {legacySteps && (
            <p className="sync-rule">
              {bi(
                "下方当前交付按旧版阶段执行；此处预览的是同步后的独立步骤。同步后执行列表会按相同名称和数量展开，旧阶段记录保留，不会自动视作每个新步骤已完成。",
                "This delivery currently uses legacy phase steps; previewing expanded individual steps after sync. Legacy phase records are preserved and will not automatically mark new steps complete.",
              )}
            </p>
          )}
          <div className="sync-phases">
            {(pv.phases || []).map((ph) => (
              <section
                key={ph.label}
                className={`sync-phase ${ph.changed.length ? "hit" : "calm"}`}
              >
                <h4>
                  {ph.label}
                  <span className="sync-count">
                    {ph.changed.length
                      ? bi(`${ph.changed.length} / ${ph.total} 个步骤内容有变化`, `${ph.changed.length} / ${ph.total} steps changed`)
                      : bi(`${ph.total} 个步骤都不受影响`, `All ${ph.total} steps unaffected`)}
                  </span>
                </h4>
                {ph.changed.map((c) => (
                  <div key={c.key || c.title} className="sync-step">
                    <div className="sync-step-top">
                      {legacySteps ? <span>{c.title}</span> : <button className="wb-link" onClick={() => window.dispatchEvent(new CustomEvent("mh-runbook-focus", { detail: { key: c.key, title: c.title } }))}>{c.title}</button>}
                      {c.new ? (
                        <em className="new">{bi("新增步骤", "New step")}</em>
                      ) : c.recorded ? (
                        <em>{bi("已执行 · 采用更新后需复核", "Executed · Needs review after sync")}</em>
                      ) : (
                        <em className="soft">{bi("还没执行过", "Not executed yet")}</em>
                      )}
                    </div>
                    {(() => {
                      const lines = c.why.split("\n").filter(Boolean);
                      return (
                        <details className="sync-why">
                          <summary>
                            {bi(`查看技术差异 · ${lines.length} 条`, `Technical diff · ${lines.length}`)}
                          </summary>
                          <ul>
                            {lines.map((l) => (
                              <li key={l}>{l}</li>
                            ))}
                          </ul>
                        </details>
                      );
                    })()}
                  </div>
                ))}
                {ph.same && ph.same.length > 0 && ph.changed.length > 0 && (
                  <details className="sync-same">
                    <summary>{bi(`另外 ${ph.same.length} 个不受影响，结果保留`, `${ph.same.length} unaffected (records preserved)`)}</summary>
                    <ul>
                      {ph.same.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            ))}
          </div>
          <details className="sync-files">
            <summary>
              {bi(
                `涉及 ${pv.files.length + (pv.removed?.length || 0)} 个自动化文件`,
                `${pv.files.length + (pv.removed?.length || 0)} automation files affected`,
              )}
            </summary>
            <ul className="mono">
              {pv.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
              {(pv.removed || []).map((f) => (
                <li key={f}>
                  <s>{f}</s>{bi("（删除）", " (deleted)")}
                </li>
              ))}
            </ul>
          </details>
          <p className="sync-rule">
            {bi(
              "差异分析覆盖任务、脚本和变量。内容有变化不等于必须重跑；无法证明行为相同的步骤会标记为待复核。如果你核对后认为某一步不受影响，可以在同步后的步骤里确认，理由会记入报告。",
              "Diff analysis covers tasks, scripts, and variables. Changed content does not automatically require re-running; steps that cannot be proven identical are flagged for review and can be marked unaffected with a reason.",
            )}
          </p>
          {can("delivery.create") && <div className="sync-actions">
            <span>{bi("采用后会更新交付文件，并保留原执行记录；不会自动执行。", "Adopting updates delivery files while preserving execution records; nothing executes automatically.")}</span>
            <Button type="primary" loading={busy} onClick={run}>{bi("采用更新…", "Adopt Update…")}</Button>
          </div>}
          </>}
        </div>
      )}
        </div>
      )}
      {children}
      {last && (() => {
        const isPatch = last.kind === "patch";
        const isHotfix = last.kind === "hotfix" || last.kind === "hotfix-revert";
        const isFilePatch = isPatch || isHotfix;
        const confirmed = Boolean(last.applied_at);
        const needsConfirm = !isAutoDelivery && !confirmed;
        const hostLabel = controllerName || bi("控制节点", "controller");
        return (
          <div
            className={`sync-file-strip ${needsConfirm ? "is-pending" : confirmed ? "is-confirmed" : ""}`}
          >
            <div className="sync-file-strip-top">
              <div className="sync-file-strip-meta">
                <span className="sync-done-badge">
                  {isPatch
                    ? bi("AI 补丁更新", "AI Patch")
                    : isHotfix
                      ? bi("脚本热修补丁", "Script Hotfix")
                      : bi("增量更新包", "Incremental Update")}
                </span>
                <b>
                  {isPatch
                    ? bi(`第 ${last.n} 次 AI 修改自动化文件`, `AI Patch #${last.n}`)
                    : isHotfix
                      ? bi(`第 ${last.n} 次单步热修脚本`, `Hotfix #${last.n}`)
                      : bi(`第 ${last.n} 次同步`, `Sync #${last.n}`)}
                </b>
                <span className="faint small">
                  {last.by} · {ago(last.at)}
                </span>
              </div>
              <div className="sync-file-strip-actions">
                {confirmed ? (
                  <span className="sync-file-strip-ok">
                    <IconCheckCircleFill />
                    {bi("已在手册核对通过", "Verified in runbook")}
                    <span className="faint small">
                      · {last.applied_by || last.by} ·{" "}
                      <time title={fullTime(last.applied_at!)}>
                        {ago(last.applied_at!)}
                      </time>
                    </span>
                  </span>
                ) : needsConfirm ? (
                  <Button
                    size="mini"
                    type="outline"
                    status="warning"
                    icon={<IconLock />}
                    onClick={() => onJumpToSyncStep?.()}
                  >
                    {bi("前往「部署」核对更新", "Verify in Deploy")}
                  </Button>
                ) : (
                  <span className="sync-done-pill">
                    {isAutoDelivery
                      ? bi("续跑时将自动推送最新补丁包", "Auto-pushes patch on next resume")
                      : bi("基础包与完整包已同步最新", "Base & full bundle up to date")}
                  </span>
                )}
              </div>
            </div>
            <p className="sync-file-strip-note">
              {isAutoDelivery
                ? bi(
                    `本交付为自动执行模式：最新热修补丁与组件更新已就绪，下次启动或续跑任意步骤时将自动推送至执行节点，无需手工拷贝。`,
                    `Automated delivery: patched/synced scripts are ready and will auto-push to the execution node on your next run.`,
                  )
                : isFilePatch
                  ? bi(
                      `「下载完整交付包」已附带此补丁，但基础包未重打：需将下方补丁上传至 ${hostLabel} 的 ${uploadDir}，并在下方「现场执行 → 部署」第 0 步执行校验覆盖。`,
                      `Included in Download Bundle, but base packages are unchanged: upload to ${uploadDir} on ${hostLabel} and verify/apply in On-site Execution → Deploy step 0.`,
                    )
                  : bi(
                      `上方基础包与「下载完整交付包」均已包含本次更新。无论 ${hostLabel} 之前是旧包还是新包，都在下方「现场执行 → 部署」第 0 步运行一条自动核对命令即可：已是最新自动放行，仍是旧版则补传下方增量包至 ${uploadDir} 自动覆盖。`,
                      `Base packages and Download Bundle already include this update. Run Deploy step 0 below to auto-verify ${hostLabel}: fresh bundles pass immediately, older bundles apply the incremental archive below from ${uploadDir}.`,
                    )}
            </p>
            {upd && (
              <div className="rstep-files">
                <a href={withLang(upd.url)} download={upd.name} className="fchip">
                  <IconDownload />
                  <span className="mono">{upd.name}</span>
                  <span className="faint num">{size(upd.bytes)}</span>
                </a>
                {sumFile && (
                  <a href={withLang(sumFile.url)} download={sumFile.name} className="fchip">
                    <IconDownload />
                    <span className="mono">{sumFile.name}</span>
                    <span className="faint num">{size(sumFile.bytes)}</span>
                  </a>
                )}
              </div>
            )}
          </div>
        );
      })()}
    </>
  );
}

/** Opens the page's assistant on the review of this delivery. */
function ReviewButton() {
  useLang();
  const dock = useAIDock();
  if (!dock?.available("review") || !can("ai.use")) return null;
  return (
    <Button
      shape="round"
      className="ai-pill"
      icon={<Spark size={14} rainbow />}
      onClick={() =>
        dock.open({
          key: `review:${Math.random().toString(36).slice(2, 10)}`,
          title: bi("新对话", "New Chat"),
        })
      }
    >
      {bi("向 AI 提问", "Ask AI")}
    </Button>
  );
}

function FileLink({ f, quiet }: { f: JobFile; quiet?: boolean }) {
  useLang();
  if (!can("delivery.download"))
    return (
      <span className={`file ${quiet ? "quiet" : ""}`}>
        <IconFile />
        <span className="file-name">{f.name}</span>
        <span className="file-size num">{size(f.bytes)}</span>
      </span>
    );
  return (
    <a
      className={`file ${quiet ? "quiet" : ""}`}
      href={withLang(f.url)}
      download={f.name}
      title={bi(`下载 ${f.name}`, `Download ${f.name}`)}
    >
      {quiet ? <IconFile /> : <IconDownload />}
      <span className="file-name">{f.name}</span>
      <span className="file-size num">{size(f.bytes)}</span>
    </a>
  );
}

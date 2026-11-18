import { sameScheme, SchemeInfo } from "./scheme";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
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
  IconDownload,
  IconEye,
  IconEyeInvisible,
  IconFile,
  IconLink,
  IconRefresh,
  IconRight,
  IconSearch,
} from "@arco-design/web-react/icon";
import {
  api,
  can,
  copy,
  fullTime,
  platformShort,
  useConnectivity,
} from "./shared";
import type {
  ClusterView,
  HostSpec,
  InstanceView,
  JobDetail,
  ParamDef,
  PlanEntry,
  Schema,
} from "./shared";
import { go } from "./router";
import { AppGlyph, Segmented } from "./ui";
import { cachedDetail, putDetailCache } from "./deliveries";
import { bi, useLang, withLang } from "./i18n";
import "./clusterconfig.css";

const schemaCache = new Map<string, Schema>();
if (typeof window !== "undefined") {
  window.addEventListener("mh-lang-change", () => schemaCache.clear());
}

const completed = (p: PlanEntry) =>
  p.outcome === "done" || p.outcome === "deviated";
const titleOf = (p: PlanEntry) =>
  p.delivery_mode === "configuration"
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
type ParamRow = {
  key: string;
  value: unknown;
  def?: ParamDef;
  group: string;
  label: string;
  specified: boolean;
  active: boolean;
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
    <Tooltip content={copied ? bi("已复制", "Copied") : bi(`复制${label}`, `Copy ${label}`)} mini>
      <button
        type="button"
        className={`cx-copy ${copied ? "copied" : ""}`}
        onClick={() => {
          copy(text);
          setCopied(true);
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        }}
        aria-label={copied ? bi(`已复制${label}`, `Copied ${label}`) : bi(`复制${label}`, `Copy ${label}`)}
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
}: {
  c: ClusterView;
  source?: string;
  section?: string;
}) {
  useLang();
  const id = source || c.current || c.head || c.plans[0]?.id;
  const p = c.plans.find((entry) => entry.id === id);
  if (!p)
    return (
      <Empty
        title={source ? bi("找不到这份交付", "Delivery not found") : bi("还没有配置记录", "No configuration records")}
        text={
          source
            ? bi("这份交付不属于当前集群，或已被删除。", "This delivery does not belong to this cluster or was deleted.")
            : bi("提交部署规格后，可以在这里查看配置。", "Configuration will appear here after submitting a deployment spec.")
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
    <ConfigRecord key={p.id} c={c} p={p} source={source} section={section} />
  );
}

function ConfigRecord({
  c,
  p,
  source,
  section,
}: {
  c: ClusterView;
  p: PlanEntry;
  source?: string;
  section?: string;
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
  const [onlySpecified, setOnlySpecified] = useState(false);
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
    const abort = new AbortController();
    if (!cachedDetail(p.id)) setLoading(true);
    setError("");
    api<JobDetail>(`/api/jobs/${p.id}`, { signal: abort.signal })
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
  const instances = useMemo<InstanceView[]>(
    () =>
      plan?.instances ||
      (dep?.instances || []).map((i) => ({
        id: i.id,
        component: i.component,
        title: i.component,
        version: i.version || "",
        status: "",
        roles: i.placement || {},
        hosts: [...new Set(Object.values(i.placement || {}).flat())],
        params: i.params || {},
        visible: {},
      })),
    [plan, dep],
  );
  const hosts: HostSpec[] = dep?.hosts || plan?.hosts || [];
  const controller = plan?.controller || dep?.controller;
  const keys = instances.map(schemaKey).join("|");
  useEffect(() => {
    if (!instances.length) return;
    const abort = new AbortController();
    setSchemaError(false);
    const unique = [
      ...new Map(instances.map((i) => [schemaKey(i), i])).values(),
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
      setSchemaError(results.some((r) => r.status === "rejected"));
    });
    return () => abort.abort();
  }, [keys, schemaRetry, lang]);

  const parameterRows = useMemo(
    () =>
      new Map(
        instances.map((i) => {
          const s = schemas[schemaKey(i)];
          const explicit =
            dep?.instances.find((sp) => sp.id === i.id)?.params || {};
          const defs = new Map((s?.params || []).map((d) => [d.key, d]));
          const order = new Map(
            (s?.params || []).map((d, index) => [d.key, index]),
          );
          const rows = Object.entries(i.params)
            .map(([key, value]) => {
              const def = defs.get(key);
              return {
                key,
                value,
                def,
                group:
                  s?.groups?.find((g) => g.id === def?.group)?.label ||
                  bi("其他参数", "Other parameters"),
                label: def?.label || key,
                specified: Object.hasOwn(explicit, key),
                active: i.visible?.[key] !== false,
              };
            })
            .sort((a, b) => {
              return (order.get(a.key) ?? 9999) - (order.get(b.key) ?? 9999);
            });
          return [i.id, rows] as const;
        }),
      ),
    [instances, schemas, dep, lang],
  );
  const rowsFor = (i: InstanceView): ParamRow[] =>
    parameterRows.get(i.id) || [];
  const routes = instances.flatMap((i) =>
    (i.endpoints || []).map((ep) => ({ i, ep, front: i.fronts?.[ep.name] })),
  );
  const portRows = instances.flatMap((i) =>
    (i.ports || []).map((port) => ({ i, port })),
  );
  const nav = [
    {
      id: "hosts",
      label: bi("机器与角色", "Hosts & Roles"),
      note: hosts.length === 1 ? bi("1 台", "1 host") : bi(`${hosts.length} 台`, `${hosts.length} hosts`),
      icon: <IconDesktop />,
    },
    {
      id: "access",
      label: bi("访问入口", "Access Endpoints"),
      note: routes.length === 1 ? bi("1 个端点", "1 endpoint") : bi(`${routes.length} 个端点`, `${routes.length} endpoints`),
      icon: <IconLink />,
    },
    ...instances.map((i) => ({
      id: `component:${i.id}`,
      label: i.title,
      note: i.id,
      icon: <AppGlyph id={i.component} size={20} />,
    })),
    { id: "spec", label: bi("原始规格", "Raw Spec"), note: "YAML / JSON", icon: <IconFile /> },
  ];
  const selected = section || "hosts";
  const active = nav.find((n) => n.id === selected);
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
  const instance = instances.find((i) => `component:${i.id}` === selected);
  useEffect(() => {
    setOnlySpecified(false);
  }, [selected]);
  const navigate = (next: string, focus = "") => {
    setQuery("");
    setFocusKey(focus);
    if (next === "hosts") setRoleFilter("all");
    if (next.startsWith("component:")) setOnlySpecified(false);
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
    ...hosts.map((h) => ({
      id: `host:${h.name}`,
      section: "hosts",
      title: h.name,
      context: `${bi("机器", "Host")} · ${h.disk || bi("未记录磁盘", "Disk unrecorded")}${h.name === controller ? bi(" · 控制节点", " · Controller") : ""}${
        instances.some((i) => i.hosts.includes(h.name))
          ? ` · ${instances
              .filter((i) => i.hosts.includes(h.name))
              .map((i) => {
                const roles = Object.entries(i.roles)
                  .filter(([, hs]) => hs.includes(h.name))
                  .map(([role]) => `${i.role_titles?.[role] || role} ${role}`)
                  .join(bi("、", ", "));
                return roles ? `${i.title}${bi("（", " (")}${roles}${bi("）", ")")}` : i.title;
              })
              .join(" / ")}`
          : ""
      }`,
      value: h.ip,
      focus: `host:${h.name}`,
    })),
    ...instances.flatMap((i) =>
      rowsFor(i).map((r) => ({
        id: `${i.id}.${r.key}`,
        section: `component:${i.id}`,
        title: `${r.label} · ${r.key}`,
        context: `${i.title} · ${i.id} · ${r.group}`,
        value: isSecretRow(r) ? "••••••••" : display(r.value),
        focus: r.key,
      })),
    ),
    ...routes.map(({ i, ep, front }) => ({
      id: `endpoint:${i.id}.${ep.name}`,
      section: "access",
      title: `${i.title} · ${ep.title || ep.name}`,
      context: `${ep.protocol.toUpperCase()} · ${front ? `${front.balancer} · ${front.resolve_ip || ""}` : bi("节点直连", "Direct node access")}`,
      value: front
        ? `${front.address}:${front.listen} → ${bi("后端", "backend")} ${ep.port}`
        : (ep.backends || []).map((b) => `${b.ip}:${b.port}`).join(bi("、", ", ")),
      focus: `endpoint:${i.id}.${ep.name}`,
    })),
  ];
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const results = hits.filter((h) =>
    tokens.every((t) => {
      const searchable = h.value === "••••••••"
        ? `${h.title} ${h.context}`
        : `${h.title} ${h.context} ${h.value}`;
      return searchable.toLocaleLowerCase().includes(t);
    }),
  );
  const current = p.id === c.current;
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
  const specFile = data?.files.find(
    (f) => f.name === "部署规格.yml" || f.name === "deployment-spec.yml",
  );

  const nonExternalInstances = instances.filter((i) => !i.external);
  const roleOptions = useMemo(() => {
    const opts: { id: string; label: string; match: (h: HostSpec) => boolean; count: number }[] = [
      { id: "all", label: bi("全部", "All"), match: () => true, count: hosts.length },
    ];
    if (controller && hosts.length > 1 && hosts.some((h) => h.name === controller)) {
      opts.push({
        id: "controller",
        label: bi("控制节点", "Controller"),
        match: (h) => h.name === controller,
        count: 1,
      });
    }
    for (const i of nonExternalInstances) {
      for (const [role, hs] of Object.entries(i.roles)) {
        const count = hs.filter((name) => hosts.some((h) => h.name === name)).length;
        if (!count || count === hosts.length) continue;
        const roleLabel = i.role_titles?.[role] || role;
        opts.push({
          id: `role:${i.id}:${role}`,
          label: nonExternalInstances.length > 1 ? `${i.title} · ${roleLabel}` : roleLabel,
          match: (h) => hs.includes(h.name),
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
  const specifiedCount = allInstanceRows.filter((r) => r.specified).length;
  const canFilterSpecified =
    Boolean(plan) && specifiedCount > 0 && specifiedCount < allInstanceRows.length;
  const visibleInstanceRows =
    canFilterSpecified && onlySpecified
      ? allInstanceRows.filter((r) => r.specified)
      : allInstanceRows;
  const paramGroups = instance
    ? [...new Set(visibleInstanceRows.map((r) => r.group))]
    : [];

  return (
    <div className="cx">
      <div className="cx-source">
        <div className="cx-source-title">
          <h2>{bi("部署配置", "Configuration")}</h2>
          <span className={`cx-record ${completed(p) ? "done" : ""}`}>
            {stateLabel}
          </span>
        </div>
        <div className="cx-source-actions">
          {c.plans.length > 1 && (
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
              options={c.plans.map((entry) => ({
                value: entry.id,
                label: `${titleOf(entry)}${entry.id === c.current ? bi(" · 当前", " · Current") : ""}${entry.outcome === "void" ? bi(" · 已作废", " · Void") : ""}`,
              }))}
            />
          )}
          <Button
            type="text"
            size="small"
            onClick={() =>
              go({ name: "deliveries", id: c.id, tab: "plans", plan: p.id })
            }
          >
            {bi("查看部署手册", "View Runbook")} <IconRight />
          </Button>
        </div>
        <p>
          <span title={fullTime(p.marked || p.created)}>{titleOf(p)}</span>
        </p>
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
              {p.outcome_note || bi("请查看该次交付的确认说明。", "See the confirmation note for this delivery.")}{" "}
              {bi("以下仍是原交付配置，请结合现场变更核对。", "Below is the original delivered configuration; reconcile with on-site changes.")}
            </span>
          </div>
        )}
        {c.holder && c.holder !== p.id && (
          <p className="cx-pending">
            {bi("另有交付尚未完成，当前记录未随它改变。", "Another delivery is still pending; current records have not changed yet.")}
            <button
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
              {bi("查看待执行交付的配置", "View pending delivery config")} <IconRight />
            </button>
          </p>
        )}
      </div>
      {(net !== "online" || error) && (
        <div className="cx-notice" role="status">
          <span>
            {net !== "online" ? bi("连接已断开。", "Disconnected. ") : ""}
            {data
              ? `${bi("显示已读取的配置。", "Showing loaded configuration.")}${error ? bi(`刷新失败：${error}`, ` Refresh failed: ${error}`) : bi("恢复连接后可刷新。", " Refresh when reconnected.")}`
              : error || bi("暂时无法读取配置，请恢复连接后重试。", "Unable to load configuration; reconnect and retry.")}
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
        <div className="cx-loading" aria-label={bi("正在读取配置", "Loading configuration")}>
          <Skeleton animation text={{ rows: 8 }} />
        </div>
      ) : !data ? (
        <Empty
          title={bi("配置未能载入", "Failed to load configuration")}
          text={bi("交付记录暂时不可用，请重试。", "Delivery record temporarily unavailable; please retry.")}
        />
      ) : !dep && !plan ? (
        <Empty
          title={bi("这份交付还没有配置记录", "No configuration record yet")}
          text={
            p.state === "running" || p.state === "queued"
              ? bi("材料正在生成，完成后刷新即可查看。", "Artifacts are building; refresh once complete.")
              : bi("未保存部署规格或生成配置，可打开交付检查生成记录。", "No deployment spec or generated config saved; check the delivery record.")
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
              <nav className="cx-nav" aria-label={bi("配置分类", "Config sections")} ref={navigation}>
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
                    <span>
                      {n.id.startsWith("component:") &&
                      instances.find((i) => `component:${i.id}` === n.id)
                        ?.external
                        ? bi("外部负载均衡", "External LB")
                        : n.label}
                    </span>
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
                  placeholder={bi("搜索机器、角色、IP、端口或参数…", "Search hosts, roles, IPs, ports, or params…")}
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
                      <p>{bi("搜索这份记录的机器角色、组件参数与访问入口", "Search host roles, component parameters, and access endpoints in this record")}</p>
                    </div>
                    <Button type="text" onClick={() => setQuery("")}>
                      {bi("清除搜索", "Clear search")}
                    </Button>
                  </div>
                  {results.length ? (
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
                  ) : (
                    <Empty
                      title={bi("没有匹配的配置", "No matching entries")}
                      text={bi("试试机器名、角色名称、参数英文名，或只搜索端口数字。", "Try a hostname, role name, parameter key, or port number.")}
                    />
                  )}
                </section>
              ) : !active ? (
                <Empty
                  title={bi("找不到这个配置分区", "Section not found")}
                  text={bi("可以从上方选择机器、入口或组件参数。", "Select hosts, endpoints, or component parameters above.")}
                >
                  <Button onClick={() => navigate("hosts")}>
                    {bi("查看机器与角色", "View Hosts & Roles")}
                  </Button>
                </Empty>
              ) : (
                <section className="cx-section" key={selected}>
                  <div className="cx-heading">
                    <div>
                      <h2>
                        {active.label}
                        {instance && (
                          <span className="cx-version mono">
                            {instance.version}
                          </span>
                        )}
                      </h2>
                      <p>
                        {instance ? (
                          <>
                            <code>{instance.id}</code> ·{" "}
                            {instance.external
                              ? bi("外部服务，由客户配置", "External service, customer-managed")
                              : instance.hosts.length === 1
                                ? bi("1 台机器", "1 host")
                                : bi(`${instance.hosts.length} 台机器`, `${instance.hosts.length} hosts`)}
                            {instance.auto
                              ? ` · ${instance.auto_reason || bi("按依赖自动加入", "Added automatically by dependency")}`
                              : ""}
                          </>
                        ) : selected === "hosts" ? (
                          <>
                            {platformShort(dep?.platform || c.platform || "")} ·{" "}
                            {bi("控制节点", "Controller")} <code>{controller || bi("未记录", "Unrecorded")}</code>
                          </>
                        ) : selected === "access" ? (
                          bi("区分应用访问地址与后端监听端口，按交付记录查看连接关系", "Distinguish application entrypoints from backend listen ports in this delivery record")
                        ) : (
                          bi("保留提交规格和生成时的参数，便于核对、复制与复现", "Preserves submitted spec and generated values for verification and reproduction")
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
                      {instance && canFilterSpecified && (
                        <div
                          className="cx-scope-pills"
                          role="group"
                          aria-label={bi("参数筛选", "Parameter filter")}
                        >
                          <button
                            type="button"
                            className={`cx-filter-pill ${!onlySpecified ? "on" : ""}`}
                            onClick={() => setOnlySpecified(false)}
                          >
                            {bi("全部", "All")} <em>{allInstanceRows.length}</em>
                          </button>
                          <button
                            type="button"
                            className={`cx-filter-pill ${onlySpecified ? "on" : ""}`}
                            onClick={() => setOnlySpecified(true)}
                          >
                            {bi("已指定", "Specified")} <em>{specifiedCount}</em>
                          </button>
                        </div>
                      )}
                      {instance && (
                        <CopyValue
                          value={instance.params}
                          label={bi(`${instance.title}全部参数`, `all ${instance.title} parameters`)}
                        />
                      )}
                    </div>
                  </div>
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
                          {filteredHosts.map((h) => (
                            <div
                              key={h.name}
                              className={`cx-host ${focusKey === `host:${h.name}` ? "focused" : ""}`}
                              data-config-key={`host:${h.name}`}
                              tabIndex={-1}
                            >
                              <div className="cx-host-id">
                                <IconDesktop />
                                <div>
                                  <b className="mono">{h.name}</b>
                                  <span className="mono">{h.ip}</span>
                                </div>
                                {h.name === controller && (
                                  <Tag size="small" color="arcoblue">
                                    {bi("控制节点", "Controller")}
                                  </Tag>
                                )}
                                <CopyValue value={h.ip} label={bi(`${h.name}地址`, `${h.name} IP`)} />
                              </div>
                              <dl className="cx-host-info">
                                <div>
                                  <dt>{bi("数据盘", "Data disk")}</dt>
                                  <dd>
                                    <code>
                                      {h.disk || bi("未记录", "Unrecorded")}
                                      {h.partition ? ` · ${h.partition}` : ""}
                                    </code>
                                    <span className="cx-sub">
                                      {h.initialize === true
                                        ? bi("配置要求初始化磁盘", "Disk initialization enabled")
                                        : h.initialize === false
                                          ? bi("配置不初始化磁盘", "Disk initialization disabled")
                                          : bi("未记录初始化选项", "Initialization unrecorded")}
                                    </span>
                                  </dd>
                                </div>
                                <div>
                                  <dt>{bi("部署角色", "Assigned roles")}</dt>
                                  <dd className="cx-roles">
                                    {instances
                                      .filter((i) => i.hosts.includes(h.name))
                                      .map((i) => (
                                        <button
                                          key={i.id}
                                          type="button"
                                          onClick={() =>
                                            navigate(`component:${i.id}`)
                                          }
                                        >
                                          <AppGlyph id={i.component} size={17} />
                                          <span>{i.title}</span>
                                          <code>
                                            {Object.entries(i.roles)
                                              .filter(([, hs]) =>
                                                hs.includes(h.name),
                                              )
                                              .map(
                                                ([role]) =>
                                                  i.role_titles?.[role] || role,
                                              )
                                              .join(bi("、", ", "))}
                                          </code>
                                          <IconRight />
                                        </button>
                                      ))}
                                    {!instances.some((i) =>
                                      i.hosts.includes(h.name),
                                    ) && (
                                      <span className="muted">
                                        {bi("未承担组件角色", "No component roles assigned")}
                                      </span>
                                    )}
                                  </dd>
                                </div>
                              </dl>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <Empty
                        title={bi("没有机器记录", "No hosts recorded")}
                        text={bi("这份规格未包含可展示的机器。", "This spec contains no hosts to display.")}
                      />
                    ))}
                  {selected === "access" && (
                    <>
                      {routes.length ? (
                        routes.map(({ i, ep, front }) => (
                          <section
                            key={`${i.id}.${ep.name}`}
                            className={`cx-endpoint ${focusKey === `endpoint:${i.id}.${ep.name}` ? "focused" : ""}`}
                            data-config-key={`endpoint:${i.id}.${ep.name}`}
                            tabIndex={-1}
                          >
                            <h3>
                              <IconLink />
                              {ep.title || ep.name}
                              <code>
                                {i.id}.{ep.name}
                              </code>
                            </h3>
                            <div className="cx-address">
                              <span>
                                {front
                                  ? front.external
                                    ? bi("外部入口", "External entry")
                                    : bi("集群入口", "Cluster entry")
                                  : bi("节点直连", "Direct node")}
                              </span>
                              <code>
                                {front
                                  ? `${front.address}:${front.listen}`
                                  : bi("通过下方节点地址访问", "Connect via backend addresses below")}
                              </code>
                              {front && (
                                <CopyValue
                                  value={`${front.address}:${front.listen}`}
                                  label={bi(`${ep.title}地址`, `${ep.title} endpoint`)}
                                />
                              )}
                            </div>
                            {front?.resolve_ip && (
                              <p className="cx-endpoint-note">
                                {bi("域名对应地址", "DNS resolves to")} <code>{front.resolve_ip}</code> ·{" "}
                                {front.balancer} · {ep.protocol.toUpperCase()}
                              </p>
                            )}
                            {front && (
                              <p className="cx-endpoint-note">
                                {bi("入口监听", "Frontend listen")} <code>{front.listen}</code>
                                <IconRight /> {bi("后端端口", "Backend port")} <code>
                                  {ep.port}
                                </code> · {ep.protocol.toUpperCase()}
                              </p>
                            )}
                            <div className="cx-backends">
                              {(ep.backends || []).map((b) => (
                                <div key={`${b.host}:${b.port}`}>
                                  <span className="mono">{b.host}</span>
                                  <code>
                                    {b.ip}:{b.port}
                                  </code>
                                  <small>
                                    {i.role_titles?.[b.role] || b.role}
                                  </small>
                                  <CopyValue
                                    value={`${b.ip}:${b.port}`}
                                    label={bi(`${b.host}后端地址`, `${b.host} backend`)}
                                  />
                                </div>
                              ))}
                            </div>
                            {ep.health && (
                              <p className="cx-endpoint-note">
                                {bi("健康检查", "Health check")}{" "}
                                <code>
                                  {ep.health.type.toUpperCase()}
                                  {ep.health.port ? ` :${ep.health.port}` : ""}
                                  {ep.health.path || ""}
                                </code>
                                {ep.health.status
                                  ? bi(` · 预期 ${ep.health.status}`, ` · expect ${ep.health.status}`)
                                  : ""}
                              </p>
                            )}
                            {ep.note && (
                              <p className="cx-endpoint-note">{ep.note}</p>
                            )}
                          </section>
                        ))
                      ) : (
                        <Empty
                          title={bi("未声明访问端点", "No endpoints declared")}
                          text={bi("这份交付未保存访问端点，可在组件参数中查看端口和地址。", "No endpoints saved in this delivery; check component parameters for ports and addresses.")}
                        />
                      )}
                      {portRows.length > 0 && (
                        <div className="cx-param-group">
                          <h3>{bi("组件监听端口", "Component Listen Ports")}</h3>
                          {portRows.map(({ i, port }, index) => (
                            <div
                              className="cx-port"
                              key={`${i.id}.${port.Name}.${index}`}
                            >
                              <span>
                                <b>{i.title}</b>
                                <code>{port.Name}</code>
                              </span>
                              <code>
                                {port.Port}/{port.Proto.toUpperCase()}
                              </code>
                              <small>{port.Hosts.join(bi("、", ", "))}</small>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  {instance && (
                    <>
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
                      {!instance.external && (
                        <div className="cx-placement">
                          {Object.entries(instance.roles)
                            .filter(([, hs]) => hs.length)
                            .map(([role, hs]) => (
                              <span key={role}>
                                <b>{instance.role_titles?.[role] || role}</b>
                                <code>{hs.join(bi("、", ", "))}</code>
                              </span>
                            ))}
                        </div>
                      )}
                      <div className="cx-param-groups">
                        {paramGroups.map((group) => (
                          <div className="cx-param-group" key={group}>
                            <h3>
                              {group}
                              <span>
                                {
                                  visibleInstanceRows.filter(
                                    (r) => r.group === group,
                                  ).length
                                }
                              </span>
                            </h3>
                            {visibleInstanceRows
                              .filter((r) => r.group === group)
                              .map((r) => {
                                const secretKey = `${instance.id}:${r.key}`;
                                const secret = isSecretRow(r);
                                const revealed = Boolean(
                                  shownSecrets[secretKey],
                                );
                                return (
                                  <div
                                    key={r.key}
                                    className={`cx-param ${r.active ? "" : "inactive"} ${focusKey === r.key ? "focused" : ""}`}
                                    data-config-key={r.key}
                                    tabIndex={-1}
                                  >
                                    <div className="cx-param-name">
                                      <Tooltip
                                        content={r.def?.hint || r.key}
                                        mini
                                      >
                                        <b>{r.label}</b>
                                      </Tooltip>
                                      <code>{r.key}</code>
                                    </div>
                                    <div className="cx-param-value">
                                      {typeof r.value === "boolean" ? (
                                        <span
                                          className={`cx-bool ${r.value ? "yes" : ""}`}
                                        >
                                          <i />
                                          {display(r.value)}
                                        </span>
                                      ) : secret ? (
                                        <>
                                          <code>
                                            {revealed
                                              ? display(r.value)
                                              : "••••••••"}
                                          </code>
                                          <Tooltip
                                            content={
                                              revealed
                                                ? bi(`隐藏${r.label}`, `Hide ${r.label}`)
                                                : bi(`显示${r.label}`, `Show ${r.label}`)
                                            }
                                            mini
                                          >
                                            <button
                                              type="button"
                                              className="cx-secret-btn"
                                              aria-label={
                                                revealed
                                                  ? bi(`隐藏${r.label}`, `Hide ${r.label}`)
                                                  : bi(`显示${r.label}`, `Show ${r.label}`)
                                              }
                                              onClick={() =>
                                                setShownSecrets((prev) => ({
                                                  ...prev,
                                                  [secretKey]: !prev[secretKey],
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
                                        </>
                                      ) : (
                                        <code>{display(r.value)}</code>
                                      )}
                                      {r.def?.unit && r.value !== "" && (
                                        <small>{r.def.unit}</small>
                                      )}
                                    </div>
                                    <span className="cx-param-origin">
                                      {!r.active
                                        ? bi("未启用", "Inactive")
                                        : !plan
                                          ? bi("提交值", "Submitted")
                                          : r.specified
                                            ? bi("已指定", "Specified")
                                            : bi("生成时补全", "Defaulted")}
                                    </span>
                                    <CopyValue value={r.value} label={r.label} />
                                  </div>
                                );
                              })}
                          </div>
                        ))}
                      </div>
                      {!paramGroups.length && (
                        <Empty
                          title={bi("没有参数记录", "No parameters recorded")}
                          text={bi("这份记录未保存组件参数。", "No component parameters saved in this record.")}
                        />
                      )}
                      {(
                        dep?.instances.find((sp) => sp.id === instance.id)
                          ?.addons || []
                      ).length > 0 && (
                        <div className="cx-param-group">
                          <h3>{bi("数据库扩展", "Database Extensions")}</h3>
                          {dep?.instances
                            .find((sp) => sp.id === instance.id)
                            ?.addons?.map((a) => (
                              <div className="cx-addon" key={a.id}>
                                <code>{a.id}</code>
                                <span>
                                  {a.databases?.join(bi("、", ", ")) ||
                                    bi("按规格指定的数据库", "Databases from spec")}
                                </span>
                                {a.params && (
                                  <code>{JSON.stringify(a.params)}</code>
                                )}
                              </div>
                            ))}
                        </div>
                      )}
                      {instance.uses &&
                        Object.keys(instance.uses).length > 0 && (
                          <div className="cx-param-group">
                            <h3>{bi("组件依赖", "Component Dependencies")}</h3>
                            {Object.entries(instance.uses).map(([cap, use]) => (
                              <button
                                key={cap}
                                type="button"
                                className="cx-dependency"
                                onClick={() =>
                                  navigate(`component:${use.instance}`)
                                }
                              >
                                <span>{cap}</span>
                                <code>{use.instance}</code>
                                <span className="muted">{use.component}</span>
                                <IconRight />
                              </button>
                            ))}
                          </div>
                        )}
                    </>
                  )}
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
                            { label: bi("提交规格 · YAML", "Submitted · YAML"), value: "yaml" },
                            { label: bi("生成配置 · JSON", "Generated · JSON"), value: "json" },
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
                            {rawCopied ? bi("已复制", "Copied") : bi("复制", "Copy")}
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
                          text={bi("可以切换查看另一种记录，或打开交付检查生成结果。", "Switch formats above or open the delivery to inspect generation logs.")}
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
            </span>
            {source && source !== c.current && c.current && (
              <button
                type="button"
                className="link"
                onClick={() =>
                  go({ name: "deliveries", id: c.id, tab: "config", section })
                }
              >
                <IconArrowLeft /> {bi("返回当前配置", "Back to current config")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

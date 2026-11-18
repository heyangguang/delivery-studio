import {displayInstances,hostStorage} from "./topology";
import { ExecutionHostSummary } from "./execution-placement";
import {SchemeInfo, schemeName} from "./scheme";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Button,
  Dropdown,
  Menu,
  Skeleton,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCopy,
  IconEye,
  IconEyeInvisible,
  IconMore,
  IconPlayArrow,
  IconCheck,
  IconExclamationCircle,
  IconLoading,
  IconRefresh,
  IconRight,
} from "@arco-design/web-react/icon";
import {
  ago,
  api,
  cached,
  can,
  clusterStatus,
  copy,
  fullTime,
  meName,
  planPhase,
  planTitle,
  platformShort,
  PLAN_PHASE,
  putCached,
} from "./shared";
import type {
  AppInfo,
  ChangeRehearsal,
  ClusterView,
  JobDetail,
  PlanEntry,
} from "./shared";
import { go } from "./router";
import { InstanceGraph, StatusBadge, StatusDot, UnderlineTabs } from "./ui";
import {
  DeliveryDetail,
  cachedDetail,
  prefetchDetail,
  putDetailCache,
} from "./deliveries";
import { DocsTab, prefetchClusterDocs } from "./docs";
import { AIDock, Spark, useAIStatus } from "./aichat";
import { ClusterConfig } from "./clusterconfig";
import { ClusterRehearsal, launchRehearsalIntent } from "./rehearsal";
import type { RehearsalPresetKind } from "./rehearsal";
import { bi, useLang } from "./i18n";
import "./clusters.css";

/* A cluster is deployed once; its tabs show the overview, saved configuration,
   deployment runbook, documents, and — when AI is enabled — guided change rehearsals. */

const openPlan = (c: ClusterView, id?: string, replace = false) =>
  go({ name: "deliveries", id: c.id, tab: "plans", plan: id }, { replace });

/* ---------- Unified 14px vector tab icons (optically centered at (8,8), strokeWidth 1.7) ---------- */

const TAB_SVG_PROPS: React.SVGProps<SVGSVGElement> = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  style: { display: "block", flex: "none" },
  "aria-hidden": true,
};

function TabOverviewIcon() {
  return (
    <svg {...TAB_SVG_PROPS}>
      <rect x="2.25" y="2.25" width="4.5" height="4.5" rx="1.15" />
      <rect x="9.25" y="2.25" width="4.5" height="4.5" rx="1.15" />
      <rect x="2.25" y="9.25" width="4.5" height="4.5" rx="1.15" />
      <rect x="9.25" y="9.25" width="4.5" height="4.5" rx="1.15" />
    </svg>
  );
}

function TabConfigIcon() {
  return (
    <svg {...TAB_SVG_PROPS}>
      <path d="M2.25 5.25H4.35M7.85 5.25H13.75" />
      <circle cx="6.1" cy="5.25" r="1.75" />
      <path d="M2.25 10.75H8.15M11.65 10.75H13.75" />
      <circle cx="9.9" cy="10.75" r="1.75" />
    </svg>
  );
}

function TabDeployIcon() {
  return (
    <svg {...TAB_SVG_PROPS}>
      <path d="M8 2.15L13.15 5.08V10.92L8 13.85L2.85 10.92V5.08L8 2.15Z" />
      <path d="M2.85 5.08L8 8L13.15 5.08M8 8V13.85" />
    </svg>
  );
}

function TabRehearsalIcon() {
  return (
    <svg {...TAB_SVG_PROPS}>
      <path d="M8 2.1C8.42 5.38 10.62 7.58 13.9 8C10.62 8.42 8.42 10.62 8 13.9C7.58 10.62 5.38 8.42 2.1 8C5.38 7.58 7.58 5.38 8 2.1Z" />
    </svg>
  );
}

function TabDocsIcon() {
  return (
    <svg {...TAB_SVG_PROPS}>
      <rect x="3.1" y="2.15" width="9.8" height="11.7" rx="1.5" />
      <path d="M5.6 5.65H10.4M5.6 8H10.4M5.6 10.35H8.8" />
    </svg>
  );
}

/* ---------- URL compatibility for ?tab=deploy and legacy ?tab=deliveries ---------- */

type ClusterTabCompat = {
  tab?: "config" | "plans" | "docs" | "rehearsal";
  plan?: string;
  doc?: string;
  rehearsal?: string;
  source?: string;
  section?: string;
  canonicalize?: boolean;
};

const subscribeLocation = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  window.addEventListener("popstate", cb);
  return () => {
    window.removeEventListener("hashchange", cb);
    window.removeEventListener("popstate", cb);
  };
};
const getLocationKey = () =>
  typeof window === "undefined"
    ? ""
    : `${window.location.search}|${window.location.hash}`;

export function parseClusterUrlCompat(clusterId?: string): ClusterTabCompat {
  if (typeof window === "undefined") return {};
  const [rawPath, hashQuery = ""] = window.location.hash
    .replace(/^#\/?/, "")
    .split("?");
  const parts = rawPath
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const hq = new URLSearchParams(hashQuery);
  const sq = new URLSearchParams(window.location.search);
  const qTab = hq.get("tab") || sq.get("tab");
  const matchesCluster =
    parts[0] === "d" && (!clusterId || parts[1] === clusterId);
  const subSeg = matchesCluster ? parts[2] : undefined;
  const subArg = matchesCluster ? parts[3] : undefined;

  if (
    qTab === "deploy" ||
    qTab === "deliveries" ||
    qTab === "plans" ||
    subSeg === "deploy" ||
    subSeg === "deliveries"
  ) {
    return {
      tab: "plans",
      plan: hq.get("plan") || sq.get("plan") || subArg || undefined,
      canonicalize: true,
    };
  }
  if (qTab === "config") {
    return {
      tab: "config",
      source: hq.get("source") || sq.get("source") || undefined,
      section: hq.get("section") || sq.get("section") || undefined,
      canonicalize: true,
    };
  }
  if (qTab === "rehearsal") {
    return {
      tab: "rehearsal",
      rehearsal: hq.get("rehearsal") || sq.get("rehearsal") || undefined,
      canonicalize: true,
    };
  }
  if (qTab === "docs") {
    return {
      tab: "docs",
      doc: hq.get("doc") || sq.get("doc") || undefined,
      canonicalize: true,
    };
  }
  if (qTab === "overview") {
    return { canonicalize: true };
  }
  return {};
}

const runText = (p: PlanEntry) =>
  (p.run_done || 0) + (p.run_failed || 0) > 0
    ? bi(
        `现场 ${p.run_done || 0}${p.run_total ? `/${p.run_total}` : ""} 步${p.run_failed ? `，${p.run_failed} 步失败` : ""}`,
        `On-site ${p.run_done || 0}${p.run_total ? `/${p.run_total}` : ""} steps${p.run_failed ? `, ${p.run_failed} failed` : ""}`,
      )
    : "";

export function ClusterDetail({
  c,
  tab,
  plan,
  doc,
  rehearsal,
  source,
  section,
  narrow,
  reload,
  appMap,
  rehearsalFocus,
  onRehearsalFocusChange,
}: {
  c: ClusterView;
  tab?: "config" | "plans" | "docs" | "rehearsal";
  plan?: string;
  doc?: string;
  rehearsal?: string;
  source?: string;
  section?: string;
  narrow: boolean;
  reload: () => Promise<void>;
  appMap: Map<string, AppInfo>;
  rehearsalFocus?: boolean;
  onRehearsalFocusChange?: (v: boolean) => void;
}) {
  const lang = useLang();
  const locKey = useSyncExternalStore(
    subscribeLocation,
    getLocationKey,
    () => "",
  );
  const compat = useMemo(() => parseClusterUrlCompat(c.id), [c.id, locKey]);
  const resolvedTab = tab || compat.tab;
  const resolvedPlan = plan || compat.plan;
  const resolvedDoc = doc || compat.doc;
  const resolvedRehearsal = rehearsal || compat.rehearsal;
  const resolvedSource = source || compat.source;
  const resolvedSection = section || compat.section;

  useEffect(() => {
    if (!compat.canonicalize) return;
    if (window.location.search) {
      const sq = new URLSearchParams(window.location.search);
      if (sq.has("tab") || sq.has("plan")) {
        sq.delete("tab");
        sq.delete("plan");
        const qs = sq.toString();
        history.replaceState(
          null,
          "",
          `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
        );
      }
    }
    go(
      {
        name: "deliveries",
        id: c.id,
        tab: compat.tab,
        plan: compat.plan,
        doc: compat.doc,
        rehearsal: compat.rehearsal,
        source: compat.source,
        section: compat.section,
      },
      { replace: true, instant: true },
    );
  }, [
    c.id,
    compat.canonicalize,
    compat.tab,
    compat.plan,
    compat.doc,
    compat.rehearsal,
    compat.source,
    compat.section,
  ]);

  const st = clusterStatus(c);
  const stLabel = st.label
    .replace(/^首次部署/, bi("部署", "Deploy"))
    .replace(/^Initial Deploy\b/, "Deploy");
  const app = appMap.get(c.app_id);
  const owner = c.owner && c.owner !== meName() ? c.owner : "";
  const entry = resolvedPlan
    ? c.plans.find((p) => p.id === resolvedPlan)
    : undefined;
  const aiStatus = useAIStatus();
  const canRehearse =
    aiStatus.enabled &&
    !!aiStatus.features?.change_rehearsal &&
    can("ai.use") &&
    !!c.head &&
    c.delivery_mode !== "configuration";
  const rehearsalsUrl = `/api/clusters/${encodeURIComponent(c.id)}/rehearsals`;
  const [rehearsals, setRehearsals] = useState<ChangeRehearsal[] | null>(() =>
    canRehearse ? cached<ChangeRehearsal[]>(rehearsalsUrl) ?? null : null,
  );
  const refreshRehearsals = useCallback(() => {
    if (!canRehearse) {
      setRehearsals(null);
      return;
    }
    const hit = cached<ChangeRehearsal[]>(rehearsalsUrl);
    if (hit !== undefined) setRehearsals(hit);
    api<ChangeRehearsal[]>(rehearsalsUrl)
      .then((r) => {
        putCached(rehearsalsUrl, r);
        for (const item of r) {
          putCached(
            `/api/clusters/${encodeURIComponent(c.id)}/rehearsals/${encodeURIComponent(item.id)}`,
            item,
          );
        }
        setRehearsals(r);
      })
      .catch(() => setRehearsals((prev) => prev ?? []));
  }, [c.id, canRehearse, rehearsalsUrl, lang]);

  useEffect(() => {
    refreshRehearsals();
  }, [refreshRehearsals]);

  const hasDocs = c.plans.some((p) => p.state === "succeeded");
  const basePlanId = c.current || c.holder || c.plans[0]?.id || "";
  useEffect(() => {
    if (basePlanId) prefetchDetail(basePlanId);
    if (hasDocs) prefetchClusterDocs(c.id);
  }, [c.id, basePlanId, hasDocs]);
  const effectiveTab =
    (resolvedTab === "rehearsal" && !canRehearse) ||
    (resolvedTab === "docs" && !hasDocs)
      ? undefined
      : resolvedTab;
  const tabKey = effectiveTab || "overview";
  const rhCount = rehearsals ? rehearsals.length : 0;
  const tabItems = [
    { value: "overview", label: bi("概览", "Overview"), icon: <TabOverviewIcon /> },
    { value: "config", label: bi("配置", "Config"), icon: <TabConfigIcon /> },
    { value: "plans", label: bi("部署", "Deploy"), icon: <TabDeployIcon /> },
    ...(canRehearse
      ? [
          {
            value: "rehearsal",
            label: bi("变更演练", "Rehearsals"),
            count: rhCount > 0 ? rhCount : undefined,
            icon: <TabRehearsalIcon />,
          },
        ]
      : []),
    ...(hasDocs
      ? [{ value: "docs", label: bi("文档", "Docs"), icon: <TabDocsIcon /> }]
      : []),
  ];
  const prevTabIdx = useRef(0);
  const curTabIdx = Math.max(
    0,
    tabItems.findIndex((t) => t.value === tabKey),
  );
  const paneDir = curTabIdx >= prevTabIdx.current ? "fwd" : "back";
  useEffect(() => {
    prevTabIdx.current = curTabIdx;
  }, [curTabIdx]);
  // keep the detail pane at the top when moving between tabs and plans
  useLayoutEffect(() => {
    document.querySelector(".md-detail")?.scrollTo({ top: 0 });
  }, [
    effectiveTab,
    resolvedPlan,
    resolvedDoc,
    resolvedRehearsal,
    resolvedSource,
    resolvedSection,
    c.id,
  ]);

  // Legacy unknown plan ID fallback: if a deep link specifies a non-existent plan ID, render standalone missing state
  if (resolvedPlan && !entry && effectiveTab === "plans")
    return (
      <DeliveryDetail
        key={resolvedPlan}
        id={resolvedPlan}
        narrow={narrow}
        onChanged={reload}
        cluster={c}
      />
    );

  const isFocusedRehearsal =
    !!rehearsalFocus && effectiveTab === "rehearsal" && canRehearse;

  const page = (
    <article
      className={`detail enter ${isFocusedRehearsal ? "rh-detail-focused" : ""}`}
      aria-label={bi(`集群 ${c.id}`, `Cluster ${c.id}`)}
    >
      <div
        className={`cl-chrome-shell ${isFocusedRehearsal ? "collapsed" : ""}`}
        aria-hidden={isFocusedRehearsal || undefined}
      >
        <div className="cl-chrome-inner">
          {narrow && (
            <Button
              type="text"
              className="back"
              icon={<IconArrowLeft />}
              onClick={() =>
                go({ name: "deliveries" })
              }
            >
              {bi("集群列表", "Clusters")}
            </Button>
          )}
          <header className="detail-head">
            <div className="detail-title">
              <h1>{c.id}</h1>
              <StatusBadge state={st.dot} label={stLabel} />
            </div>
            <div className="detail-meta">
              {owner && <span className="row-owner">{bi(`${owner} 的集群`, `${owner}'s cluster`)}</span>}
              <span>
                {c.app_name} {c.version}
              </span>
              {c.platform && <span>{platformShort(c.platform)}</span>}
              {c.hosts > 0 && (
                <span className="num">
                  {c.hosts === 1 ? bi("1 台机器", "1 host") : bi(`${c.hosts} 台机器`, `${c.hosts} hosts`)}
                </span>
              )}
              <Tooltip content={fullTime(c.created)} mini>
                <span>{bi(`创建于 ${ago(c.created)}`, `Created ${ago(c.created)}`)}</span>
              </Tooltip>
            </div>
            <SchemeInfo
              scheme={c.scheme}
              detail
              label={c.head ? bi("当前运行方案", "Active scheme") : bi("目标部署方案", "Target scheme")}
            />
            <div className="detail-actions">
              <Dropdown
                trigger="click"
                position="br"
                droplist={
                  <Menu onClickMenuItem={(k) => k === "copy" && copy(c.id)}>
                    <Menu.Item key="copy">
                      <IconCopy /> {bi("复制集群标识", "Copy Cluster ID")}
                    </Menu.Item>
                  </Menu>
                }
              >
                <Button icon={<IconMore />} aria-label={bi("更多操作", "More actions")} />
              </Dropdown>
            </div>
          </header>
          <UnderlineTabs
            className="cl-utabs"
            label={bi("集群视图", "Cluster views")}
            value={tabKey}
            items={tabItems}
            onHover={(next) => {
              if ((next === "overview" || next === "config" || next === "plans") && basePlanId) {
                prefetchDetail(basePlanId);
              } else if (next === "docs" && hasDocs) {
                prefetchClusterDocs(c.id);
              }
            }}
            onChange={(next) => {
              onRehearsalFocusChange?.(false);
              if (next === "overview") {
                go({ name: "deliveries", id: c.id }, { replace: true });
              } else if (next === "config") {
                go(
                  { name: "deliveries", id: c.id, tab: "config" },
                  { replace: true },
                );
              } else {
                go(
                  {
                    name: "deliveries",
                    id: c.id,
                    tab: next as "plans" | "rehearsal" | "docs",
                  },
                  { replace: true },
                );
              }
            }}
          />
        </div>
      </div>
      <div
        className={`cl-pane cl-pane-${paneDir}`}
        key={tabKey}
        role="tabpanel"
      >
        {effectiveTab === "config" ? (
          <ClusterConfig
            c={c}
            source={resolvedSource}
            section={resolvedSection}
          />
        ) : effectiveTab === "plans" ? (
          <InitialDeploymentView
            c={c}
            selectedId={resolvedPlan}
            narrow={narrow}
            reload={reload}
          />
        ) : effectiveTab === "rehearsal" && canRehearse ? (
          <ClusterRehearsal
            c={c}
            rehearsalId={resolvedRehearsal}
            initialList={rehearsals}
            focused={isFocusedRehearsal}
            onFocusChange={onRehearsalFocusChange}
            onListUpdated={refreshRehearsals}
          />
        ) : effectiveTab === "docs" ? (
          <DocsTab c={c} doc={resolvedDoc} />
        ) : (
          <Overview
            c={c}
            appIcon={app?.category}
            canRehearse={canRehearse}
            rehearsals={rehearsals}
          />
        )}
      </div>
    </article>
  );
  // the assistant on a cluster talks about the delivery that describes it now, or the viewed deployment
  const dockPlan =
    effectiveTab === "plans" && entry
      ? entry
      : c.plans.find((p) => p.id === (c.current || c.holder)) || c.plans[0];
  const hideDock =
    !dockPlan ||
    dockPlan.state !== "succeeded" ||
    effectiveTab === "rehearsal";
  return (
    <AIDock
      scope={{ kind: "job", jobId: dockPlan?.id || c.id }}
      start={{
        key: "review",
        title: bi("集群问答", "Cluster Q&A"),
        context: `${c.id} · ${c.app_name}`,
      }}
      hidden={hideDock}
    >
      {page}
    </AIDock>
  );
}

/** Direct view of the cluster's deployment runbook & bundle (with inline draft switcher only if pre-deployment drafts were voided). */
function InitialDeploymentView({
  c,
  selectedId,
  narrow,
  reload,
}: {
  c: ClusterView;
  selectedId?: string;
  narrow: boolean;
  reload: () => Promise<void>;
}) {
  useLang();
  const primary =
    c.plans.find((p) => p.id === (c.holder || c.current)) || c.plans[0];
  const active =
    (selectedId && c.plans.find((p) => p.id === selectedId)) || primary;

  if (!active) {
    return (
      <section className="dsec">
        <p className="muted">{bi("当前集群尚无部署材料。", "No deployment artifacts for this cluster yet.")}</p>
      </section>
    );
  }

  const hasVoidedRevisions = c.plans.length > 1;
  const revisionBar = hasVoidedRevisions ? (
    <div
      className="cl-init-drafts"
      role="navigation"
      aria-label={bi("当前生效交付与历史草稿", "Active delivery and archived drafts")}
    >
      <span>{bi("当前生效交付与归档草稿：", "Active delivery & archived drafts:")}</span>
      <div className="cl-init-draft-pills">
        {c.plans.map((p) => {
          const ph = planPhase(p);
          const isCur = p.id === active.id;
          const isBase = p.id === (c.current || c.holder);
          return (
            <button
              key={p.id}
              type="button"
              className={`cl-init-draft-pill ${isCur ? "on" : ""}`}
              onClick={() =>
                openPlan(c, p.id === primary?.id ? undefined : p.id, true)
              }
            >
              <StatusDot state={PLAN_PHASE[ph].dot} />
              <span>{isBase ? bi("当前交付", "Active delivery") : bi(`${PLAN_PHASE[ph].label}草稿`, `${PLAN_PHASE[ph].label} draft`)}</span>
              <span className="mono faint">#{p.id.slice(0, 6)}</span>
            </button>
          );
        })}
      </div>
    </div>
  ) : null;

  return (
    <DeliveryDetail
      key={active.id}
      id={active.id}
      narrow={narrow}
      onChanged={reload}
      cluster={c}
      embedded
      revisionBar={revisionBar}
    />
  );
}

function InlineCopyBtn({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  useLang();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Tooltip content={copied ? bi("已复制", "Copied") : bi(`复制${label}`, `Copy ${label}`)} mini>
      <button
        type="button"
        className={`cl-inline-copy ${copied ? "copied" : ""}`}
        aria-label={bi(`复制${label} ${value}`, `Copy ${label} ${value}`)}
        onClick={(e) => {
          e.stopPropagation();
          copy(value);
          setCopied(true);
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
    </Tooltip>
  );
}

function rehearsalStageShort(r: ChangeRehearsal): string {
  if (r.stage === "finalized") return bi("方案已定稿", "Finalized");
  if (r.stage === "rehearsing") {
    const req = (r.steps || []).filter(
      (s) => !s.optional && s.phase !== "rollback",
    );
    const done = req.filter(
      (s) => s.status === "passed" || s.status === "skipped",
    ).length;
    return req.length > 0 ? bi(`测试演练 ${done}/${req.length}`, `Rehearsing ${done}/${req.length}`) : bi("测试演练", "Rehearsing");
  }
  if (r.stage === "probing") return bi("现场采集", "Probing");
  return bi("边界确认", "Scoping");
}

function Overview({
  c,
  canRehearse,
  rehearsals,
}: {
  c: ClusterView;
  appIcon?: string;
  canRehearse: boolean;
  rehearsals: ChangeRehearsal[] | null;
}) {
  useLang();
  const holder = c.plans.find((p) => p.id === c.holder);
  const current = c.plans.find((p) => p.id === c.current);
  const basePlan = current || holder || c.plans[0];
  const canReviseHolder =
    !!holder &&
    holder.state === "succeeded" &&
    holder.outcome !== "done" &&
    holder.outcome !== "deviated" &&
    holder.outcome !== "void" &&
    can("delivery.create");
  const rhList = rehearsals || [];
  const finalizedCount = rhList.filter((x) => x.stage === "finalized").length;

  return (
    <div className="cl-over">
      {holder && <HolderCard c={c} p={holder} />}
      {canReviseHolder && (
        <div className="cl-revise">
          <span>
            {bi(
              "部署尚未确认完成：如机器地址或参数有误，可修订配置并重新生成交付包（原草稿自动作废）。",
              "Deployment not yet confirmed: if host IPs or parameters need changes, revise the config and rebuild (the current draft will be voided).",
            )}
          </span>
          <Button
            size="small"
            onClick={() =>
              go({
                name: "new",
                app: c.app_id,
                revise: holder!.id,
              })
            }
          >
            {bi("修订配置", "Revise Config")}
          </Button>
        </div>
      )}
      {!holder && canRehearse && (
        <RehearsalQuickStrip c={c} rehearsals={rehearsals} />
      )}
      {current ? (
        <Now key={current.id} c={c} p={current} />
      ) : (
        <section className="dsec">
          <p className="muted">{bi("尚无已生成的交付材料。", "No generated delivery artifacts yet.")}</p>
        </section>
      )}
      {basePlan && (
        <section className="dsec cl-ledger-sec">
          <h2 className="dsec-title">{bi("基线与变更记录", "Baseline & Change Ledger")}</h2>
          <div className="cl-ledger">
            <div className="cl-ledger-row">
              <div className="cl-ledger-main">
                <div className="cl-ledger-title-line">
                  <span className="cl-ledger-tag">{bi("初始部署基线", "Initial Baseline")}</span>
                  <StatusBadge
                    state={PLAN_PHASE[planPhase(basePlan)].dot}
                    label={PLAN_PHASE[planPhase(basePlan)].label}
                  />
                  <span className="cl-ledger-facts">
                    <span>
                      {c.app_name} {basePlan.version}
                    </span>
                    <span aria-hidden>·</span>
                    <span>{schemeName(basePlan.scheme)}</span>
                    {runText(basePlan) && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="num">{runText(basePlan)}</span>
                      </>
                    )}
                    <span aria-hidden>·</span>
                    <span className="mono faint num">
                      #{basePlan.id.slice(0, 8)} · {ago(basePlan.created)}
                      {c.plans.length > 1
                        ? bi(
                            ` · 归档 ${c.plans.length - 1} 份草稿`,
                            ` · ${c.plans.length - 1} archived ${c.plans.length - 1 === 1 ? "draft" : "drafts"}`,
                          )
                        : ""}
                    </span>
                  </span>
                </div>
                {(basePlan.outcome_note ||
                  (basePlan.marked_by && basePlan.marked)) && (
                  <p className="cl-ledger-note">
                    {basePlan.outcome_note
                      ? bi(`现场说明：${basePlan.outcome_note}`, `On-site note: ${basePlan.outcome_note}`)
                      : bi(`${basePlan.marked_by} 于 ${ago(basePlan.marked!)}确认部署完成`, `${basePlan.marked_by} confirmed completion ${ago(basePlan.marked!)}`)}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="dsec-link link cl-ledger-act"
                onClick={() =>
                  go(
                    { name: "deliveries", id: c.id, tab: "plans" },
                    { replace: true },
                  )
                }
              >
                {bi("查看部署手册", "View Runbook")} <IconRight />
              </button>
            </div>

            {canRehearse && (
              <div className="cl-ledger-group">
                <div className="cl-ledger-subhead">
                  <div className="cl-ledger-subhead-left">
                    <span className="cl-ledger-tag">{bi("变更演练记录", "Change Rehearsals")}</span>
                    <span className="dsec-count num">{rhList.length}</span>
                    {finalizedCount > 0 && (
                      <span className="cl-ledger-subnote num">
                        {bi(`已定稿 ${finalizedCount} 份生产方案`, `${finalizedCount} finalized`)}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="dsec-link link cl-ledger-act"
                    onClick={() =>
                      go(
                        { name: "deliveries", id: c.id, tab: "rehearsal" },
                        { replace: true },
                      )
                    }
                  >
                    {rhList.length > 0 ? bi("全部演练", "All Rehearsals") : bi("新建演练", "New Rehearsal")} <IconRight />
                  </button>
                </div>
                {rhList.length > 0 ? (
                  <ul className="cl-ledger-rh-list">
                    {rhList.slice(0, 5).map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="cl-ledger-rh-row"
                          onClick={() =>
                            go({
                              name: "deliveries",
                              id: c.id,
                              tab: "rehearsal",
                              rehearsal: item.id,
                            })
                          }
                        >
                          <span className="cl-ledger-rh-title">{item.title}</span>
                          <span className="cl-ledger-rh-meta">
                            <span
                              className={`cl-ledger-stage ${item.stage === "finalized" ? "done" : ""}`}
                            >
                              {rehearsalStageShort(item)}
                            </span>
                            <span className="num faint">
                              {ago(item.updated_at)}
                            </span>
                            <IconRight />
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="cl-ledger-empty">
                    {bi(
                      "暂无变更演练记录，支持版本升级、节点扩缩容、参数调优与主备切换。",
                      "No change rehearsals yet. Supports version upgrades, scaling, parameter tuning, and failover.",
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

const QUICK_INTENTS: { kind: RehearsalPresetKind; label: string }[] = [
  { kind: "upgrade", get label() { return bi("版本升级", "Upgrade"); } },
  { kind: "scale", get label() { return bi("节点扩缩", "Scale"); } },
  { kind: "tune", get label() { return bi("参数调优", "Tune"); } },
  { kind: "switch", get label() { return bi("主备切换", "Failover"); } },
];

function RehearsalQuickStrip({
  c,
  rehearsals,
}: {
  c: ClusterView;
  rehearsals: ChangeRehearsal[] | null;
}) {
  useLang();
  const active = (rehearsals || []).find((x) => x.stage !== "finalized");

  if (active) {
    const req = (active.steps || []).filter(
      (s) => !s.optional && s.phase !== "rollback",
    );
    const done = req.filter(
      (s) => s.status === "passed" || s.status === "skipped",
    ).length;
    const stageText =
      active.stage === "rehearsing" && req.length > 0
        ? bi(`测试演练 ${done}/${req.length}`, `Rehearsing ${done}/${req.length}`)
        : active.stage === "probing"
          ? bi("待录入现场只读探针", "Awaiting read-only probes")
          : bi("待确认变更边界", "Awaiting scope confirmation");
    return (
      <div className="cl-rh-strip" role="region" aria-label={bi("进行中的变更演练", "Active change rehearsal")}>
        <div className="cl-rh-strip-left">
          <b>
            <Spark size={14} /> {active.title}
          </b>
          <span className="cl-rh-strip-sub num">
            {stageText} · {ago(active.updated_at)}
          </span>
        </div>
        <div className="cl-rh-intents">
          <button
            type="button"
            className="cl-rh-chip primary"
            onClick={() =>
              go({
                name: "deliveries",
                id: c.id,
                tab: "rehearsal",
                rehearsal: active.id,
              })
            }
          >
            {bi("继续演练", "Continue")} <IconRight />
          </button>
          <button
            type="button"
            className="cl-rh-chip"
            onClick={() => launchRehearsalIntent(c.id)}
          >
            {bi("新建演练", "New Rehearsal")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cl-rh-strip" role="region" aria-label={bi("日常变更演练", "Change rehearsal")}>
      <div className="cl-rh-strip-left">
        <b>
          <Spark size={14} /> {bi("变更演练", "Change Rehearsal")}
        </b>
        <span className="cl-rh-strip-sub">
          {bi(
            "只读采集现场状态，先在测试环境逐步验证再输出实施方案",
            "Collect read-only site state and verify step-by-step in staging before finalizing a plan",
          )}
        </span>
      </div>
      <div className="cl-rh-intents">
        {QUICK_INTENTS.map((it) => (
          <button
            key={it.kind}
            type="button"
            className="cl-rh-chip"
            onClick={() => launchRehearsalIntent(c.id, it.kind)}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The delivery that keeps the cluster busy, with the way to it. */
function HolderCard({
  c,
  p,
}: {
  c: ClusterView;
  p: PlanEntry;
}) {
  useLang();
  const ph = planPhase(p);
  const title = p.delivery_mode === "configuration" ? bi("配置交付", "Config Delivery") : bi("集群部署", "Cluster Deployment");
  const total = Math.max(0, p.run_total || 0);
  const done = Math.max(0, p.run_done || 0);
  const failed = Math.max(0, p.run_failed || 0);
  const hasIssue = ph === "failed" || ph === "genfailed" || failed > 0;
  const complete = total > 0 && done >= total && !hasIssue;
  const progress = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const status = complete ? bi("待确认", "Awaiting confirmation") : PLAN_PHASE[ph].label;
  const action =
    ph === "generating"
      ? bi("查看进度", "View Progress")
      : hasIssue
        ? bi("查看问题", "Inspect Issue")
        : complete
          ? bi("确认结果", "Confirm Outcome")
          : ph === "ready"
            ? bi("开始执行", "Start")
            : bi("继续执行", "Continue");
  const detail =
    ph === "generating"
      ? (p.stage || bi("正在生成交付材料", "Generating delivery artifacts")).replace(/^\[\d\/5\]\s*/, "")
      : ph === "genfailed"
        ? p.error || bi("交付材料尚未生成完成", "Delivery build incomplete")
        : ph === "failed"
          ? p.outcome_note || bi("已记为失败，请查看执行记录", "Marked as failed; see execution records")
          : "";
  return (
    <button
      type="button"
      className={`cl-holder cl-h-${ph} ${hasIssue ? "has-issue" : ""} ${complete ? "is-complete" : ""}`}
      onClick={() => openPlan(c, p.id)}
      onPointerEnter={() => prefetchDetail(p.id)}
      onFocus={() => prefetchDetail(p.id)}
      aria-label={bi(
        `${title}，${status}${total ? `，现场已完成 ${done} / ${total} 步` : ""}，${action}`,
        `${title}, ${status}${total ? `, ${done} / ${total} on-site steps done` : ""}, ${action}`,
      )}
    >
      <span className="cl-holder-meter" aria-hidden>
        <svg viewBox="0 0 48 48" className="cl-holder-ring">
          <circle className="cl-holder-track" cx="24" cy="24" r="20" />
          {progress > 0 && (
            <circle
              className="cl-holder-progress"
              cx="24"
              cy="24"
              r="20"
              pathLength="100"
              strokeDasharray="100"
              style={{ strokeDashoffset: 100 - progress }}
            />
          )}
        </svg>
        {hasIssue ? (
          <IconExclamationCircle />
        ) : complete ? (
          <IconCheck />
        ) : ph === "generating" ? (
          <IconLoading spin />
        ) : (
          <IconPlayArrow />
        )}
      </span>
      <span className="cl-holder-main">
        <span className="cl-holder-heading">
          <strong>{title}</strong>
          <span className="cl-holder-status">{status}</span>
        </span>
        <span className="cl-holder-meta">
          {detail ? (
            <span className="cl-holder-detail" title={detail}>
              {detail}
            </span>
          ) : total ? (
            <span className="cl-holder-count">
              {bi("现场进度", "On-site progress")} <b className="num">{done}</b>
              <span className="num"> / {total}{bi(" 步", " steps")}</span>
            </span>
          ) : (
            <span>{bi("待开始现场执行", "Ready for on-site execution")}</span>
          )}
          {failed > 0 && (
            <span className="cl-holder-fail num">
              {failed === 1 ? bi("1 步失败", "1 step failed") : bi(`${failed} 步失败`, `${failed} steps failed`)}
            </span>
          )}
        </span>
      </span>
      <span className="cl-holder-go">
        <span>{action}</span>
        <span className="cl-holder-arrow">
          <IconRight />
        </span>
      </span>
    </button>
  );
}

/** The cluster as it is now: the topology, endpoints, and profile of the active baseline. */
function Now({ c, p }: { c: ClusterView; p: PlanEntry }) {
  const lang = useLang();
  const [d, setD] = useState<JobDetail | null>(() => cachedDetail(p.id));
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    const hit = cachedDetail(p.id);
    if (hit) setD(hit);
    setLoadError("");
    api<JobDetail>(`/api/jobs/${p.id}`)
      .then((r) => {
        putDetailCache(p.id, r);
        if (live) setD(r);
      })
      .catch((e) => {
        if (live) setLoadError(e.message || bi("读取失败", "Load failed"));
      });
    return () => {
      live = false;
    };
  }, [p.id, retry, lang]);
  const plan = d?.plan;
  const input = d?.spec?.deployment;
  const finished = p.outcome === "done" || p.outcome === "deviated";
  return (
    <section className="dsec">
      <h2 className="dsec-title">
        {c.delivery_mode === "configuration"
          ? bi("集群配置拓扑", "Configuration Topology")
          : bi("运行拓扑与连接", "Topology & Connections")}
        <span className="dsec-note">
          {finished ? bi("已确认运行基线", "Confirmed baseline") : bi("待执行部署交付", "Pending deployment")}
        </span>
        <button
          type="button"
          className="dsec-link link"
          onClick={() => go({ name: "deliveries", id: c.id, tab: "config" })}
        >
          {bi("查看配置", "View Config")} <IconRight />
        </button>
      </h2>
      {loadError ? (
        <div className="cl-load-err" role="alert">
          <IconExclamationCircle />
          <span>{bi("集群信息读取失败：", "Failed to load cluster info: ")}{loadError}</span>
          <Button
            size="small"
            icon={<IconRefresh />}
            onClick={() => setRetry((x) => x + 1)}
          >
            {bi("重试", "Retry")}
          </Button>
        </div>
      ) : !d ? (
        <Skeleton animation text={{ rows: 4 }} />
      ) : (
        <div className="cl-now">
          <div className="cl-now-left">
            <ExecutionHostSummary host={plan?.execution_host} />
            {plan && (
              <InstanceGraph
                hosts={plan.hosts}
                instances={plan.instances}
                controller={plan.controller}
                layout="row"
              />
            )}
            {plan && <HostTable plan={plan} input={input} />}
          </div>
          <ClusterProfile c={c} p={p} plan={plan} input={input} />
        </div>
      )}
    </section>
  );
}

/** Every machine of the cluster in one row: address, data disk, and what runs on it. */
function HostTable({
  plan,
  input,
}: {
  plan: NonNullable<JobDetail["plan"]>;
  input?: NonNullable<JobDetail["spec"]>["deployment"];
}) {
  useLang();
  const specs = (input?.hosts || []) as {
    name: string;
    disk?: string;
    params?: Record<string, unknown>;
  }[];
  const rows = plan.hosts.map((h) => ({
    ...h,
    storage: hostStorage(specs.find((x) => x.name === h.name)),
    roles: displayInstances(plan.instances).flatMap((i) =>
      Object.entries(i.roles || {})
        .filter(([, hs]) => hs.includes(h.name))
        .map(([r]) => `${i.title} ${i.role_titles?.[r] || r}`),
    ),
  }));
  return (
    <table className="cl-hosts">
      <thead>
        <tr>
          <th>{bi("机器", "Host")}</th>
          <th>{bi("地址", "Address")}</th>
          <th>{bi("数据存储", "Storage")}</th>
          <th>{bi("运行角色", "Roles")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td>
              <b>{r.name}</b>
              {r.name === plan.controller && <em>{bi("控制", "Ctrl")}</em>}
            </td>
            <td className="mono">
              <span className="cl-copy-cell">
                <span>{r.ip}</span>
                <InlineCopyBtn value={r.ip} label={bi(`${r.name} 地址`, `${r.name} IP`)} />
              </span>
            </td>
            <td>
              {r.storage.label}
              <br />
              <span className="mono faint small">{r.storage.path}</span>
            </td>
            <td>{r.roles.join(" · ") || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const PARAM_LABEL: Record<string, string> = {
  get tls() { return bi("传输加密", "TLS encryption"); },
  get tde() { return bi("存储加密", "Storage encryption (TDE)"); },
  get client_cidr() { return bi("允许的客户端网段", "Allowed client CIDRs"); },
  get extra_client_cidrs() { return bi("另外的客户端网段", "Extra client CIDRs"); },
  get replication() { return bi("复制方式", "Replication mode"); },
  get backup_retention_full() { return bi("全量备份保留", "Full backup retention"); },
  get persistence() { return bi("持久化", "Persistence"); },
  get maxmemory() { return bi("最大内存", "Max memory"); },
  get data_dir() { return bi("数据目录", "Data directory"); },
  get pg_port() { return bi("数据库端口", "Database port"); },
  get redis_port() { return bi("Redis 端口", "Redis port"); },
  get max_connections() { return bi("最大连接数", "Max connections"); },
};
const SECRET_PARAM_RE =
  /(password|passwd|pwd|secret|token|requirepass|access_key|secret_key|auth_key|private_key|admin_pass|repl_pass|superuser_pass)/i;

const showParam = (v: unknown) =>
  v === true
    ? bi("开启", "On")
    : v === false
      ? bi("关闭", "Off")
      : Array.isArray(v)
        ? v.join(bi("、", ", "))
        : String(v);

/** What is worth knowing about the cluster at a glance, in groups: connection & credentials, composition, key parameters, and delivery status. */
function ClusterProfile({
  c,
  p,
  plan,
  input,
}: {
  c: ClusterView;
  p: PlanEntry;
  plan?: JobDetail["plan"];
  input?: NonNullable<JobDetail["spec"]>["deployment"];
}) {
  useLang();
  const [shownSecrets, setShownSecrets] = useState<Record<string, boolean>>({});
  const insts = plan?.instances || [];
  const real = displayInstances(insts).filter((i) => !i.external);
  const defaultIp = plan?.hosts?.[0]?.ip || input?.hosts?.[0]?.ip || "";
  const entries = insts.flatMap((i) =>
    Object.values(i.fronts || {}).map((f) => ({
      label: f.external ? bi("外部入口", "External entry") : bi("访问入口", "Entrypoint"),
      addr: f.address
        ? `${f.address}:${f.listen}`
        : defaultIp
          ? `${defaultIp}:${f.listen}`
          : `:${f.listen}`,
    })),
  );
  const ports = real
    .flatMap((i) => (i.ports || []).map((x) => `${x.Name} ${x.Port}`))
    .slice(0, 4);

  const secrets = useMemo(() => {
    const out: { key: string; label: string; value: string }[] = [];
    const seen = new Set<string>();
    const scan = (
      prefix: string,
      title: string,
      params?: Record<string, unknown>,
    ) => {
      if (!params) return;
      for (const [k, v] of Object.entries(params)) {
        if (!SECRET_PARAM_RE.test(k)) continue;
        if (typeof v !== "string" || !v.trim()) continue;
        const id = `${prefix}.${k}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          key: id,
          label: real.length > 1 ? `${title} · ${k}` : k,
          value: v,
        });
      }
    };
    for (const i of insts) scan(i.id, i.title || i.id, i.params);
    for (const i of input?.instances || []) {
      const pi = insts.find((x) => x.id === i.id);
      scan(i.id, pi?.title || i.id, i.params);
    }
    return out.slice(0, 5);
  }, [insts, input?.instances, real.length]);

  const main =
    real.find((i) => i.id === c.app_id || i.component === c.app_id) || real[0];
  const picks = Object.keys(PARAM_LABEL)
    .filter(
      (k) =>
        main &&
        main.params &&
        k in main.params &&
        main.params[k] !== "" &&
        main.params[k] !== null &&
        !(
          Array.isArray(main.params[k]) && !(main.params[k] as unknown[]).length
        ),
    )
    .slice(0, 6);
  const roleLine = (i: (typeof insts)[number]) =>
    Object.entries(i.roles || {})
      .filter(([, hs]) => hs.length)
      .map(([r, hs]) => `${i.role_titles?.[r] || r} ${hs.join(bi("、", ", "))}`)
      .join(" · ");
  return (
    <div className="cl-profile">
      {(entries.length > 0 || ports.length > 0 || secrets.length > 0) && (
        <section>
          <h3>{bi("连接与凭据", "Endpoints & Credentials")}</h3>
          <dl className="cl-prof-kv">
            {entries.map((e) => (
              <React.Fragment key={e.addr}>
                <dt>{e.label}</dt>
                <dd className="mono">
                  <span className="cl-copy-cell right">
                    <span>{e.addr}</span>
                    <InlineCopyBtn value={e.addr} label={e.label} />
                  </span>
                </dd>
              </React.Fragment>
            ))}
            {ports.length > 0 && (
              <>
                <dt>{bi("监听端口", "Listen ports")}</dt>
                <dd className="mono">{ports.join(" · ")}</dd>
              </>
            )}
            {secrets.map((s) => {
              const shown = !!shownSecrets[s.key];
              return (
                <React.Fragment key={s.key}>
                  <dt className="mono">{s.label}</dt>
                  <dd className="mono">
                    <span className="cl-copy-cell right">
                      <span>{shown ? s.value : "••••••••"}</span>
                      <Tooltip content={shown ? bi("隐藏凭据", "Hide credential") : bi("显示凭据", "Show credential")} mini>
                        <button
                          type="button"
                          className="cl-inline-copy"
                          aria-label={`${shown ? bi("隐藏", "Hide") : bi("显示", "Show")} ${s.label}`}
                          aria-pressed={shown}
                          onClick={() =>
                            setShownSecrets((prev) => ({
                              ...prev,
                              [s.key]: !prev[s.key],
                            }))
                          }
                        >
                          {shown ? <IconEyeInvisible /> : <IconEye />}
                        </button>
                      </Tooltip>
                      <InlineCopyBtn value={s.value} label={s.label} />
                    </span>
                  </dd>
                </React.Fragment>
              );
            })}
          </dl>
        </section>
      )}
      <section>
        <h3>{bi("组成", "Components")}</h3>
        <ul className="cl-prof-list">
          {real.map((i) => (
            <li key={i.id}>
              <div>
                <b>
                  {i.title} {i.version}
                </b>
                {i.embedded ? (
                  <span className="flag info">{bi("内置管理", "Embedded")}</span>
                ) : (
                  i.auto && <span className="flag info">{bi("自动加入", "Auto-added")}</span>
                )}
                {i.status !== "published" && (
                  <span className="flag warn">{bi("待验证", "Unverified")}</span>
                )}
              </div>
              <small>{roleLine(i) || i.hosts.join(bi("、", ", "))}</small>
            </li>
          ))}
          {(input?.hosts.length ?? c.hosts) > 0 && (
            <li>
              <div>
                <b className="num">
                  {(input?.hosts.length ?? c.hosts) === 1
                    ? bi("1 台机器", "1 host")
                    : bi(`${input?.hosts.length ?? c.hosts} 台机器`, `${input?.hosts.length ?? c.hosts} hosts`)}
                </b>
              </div>
              <small>
                {plan?.execution_host ? bi("独立执行机", "Standalone executor") : bi("集群内执行机", "In-cluster executor")}{" "}
                {plan?.controller || input?.controller || "—"}
              </small>
            </li>
          )}
        </ul>
      </section>
      {picks.length > 0 && (
        <section>
          <h3>{bi("关键配置", "Key Parameters")}</h3>
          <dl className="cl-prof-kv">
            {picks.map((k) => (
              <React.Fragment key={k}>
                <dt>{PARAM_LABEL[k]}</dt>
                <dd
                  className={
                    typeof main!.params[k] === "boolean"
                      ? main!.params[k]
                        ? "on"
                        : "off"
                      : "mono"
                  }
                >
                  {showParam(main!.params[k])}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </section>
      )}
      <section>
        <h3>{bi("交付信息", "Delivery Info")}</h3>
        <dl className="cl-prof-kv">
          <dt>{bi("负责人", "Owner")}</dt>
          <dd>{c.owner}</dd>
          <dt>{bi("部署状态", "Status")}</dt>
          <dd>
            {PLAN_PHASE[planPhase(p)].label} ·{" "}
            <span className="mono">#{p.id.slice(0, 8)}</span>
          </dd>
          <dt>{bi("创建", "Created")}</dt>
          <dd>{ago(c.created)}</dd>
        </dl>
      </section>
    </div>
  );
}

/** The cluster's plans as a row of dots, oldest first: what happened to it at a glance. */
export function HistoryDots({ c }: { c: ClusterView }) {
  useLang();
  const plans = [...c.plans].reverse().slice(-8);
  if (plans.length < 2) return null;
  const labelOf = (p: PlanEntry) =>
    p.delivery_mode === "configuration" ? bi("配置交付", "Config delivery") : bi("部署交付", "Deploy delivery");
  return (
    <span
      className="cl-hist"
      aria-label={
        bi(`${c.plans.length} 份交付记录：`, `${c.plans.length} deliveries: `) +
        plans
          .map((p) => `${labelOf(p)} ${PLAN_PHASE[planPhase(p)].label}`)
          .join(bi("，", ", "))
      }
    >
      {plans.map((p) => (
        <i
          key={p.id}
          className={`s-${PLAN_PHASE[planPhase(p)].dot}`}
          title={`${labelOf(p)} · ${PLAN_PHASE[planPhase(p)].label}`}
        />
      ))}
    </span>
  );
}

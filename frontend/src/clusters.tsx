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
  Message,
  Modal,
  Skeleton,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCopy,
  IconDelete,
  IconDown,
  IconEdit,
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
import {
  DeliveryModeTag,
  InstanceGraph,
  StatusBadge,
  StatusDot,
  UnderlineTabs,
} from "./ui";
import {
  DeliveryDetail,
  VerificationPromoteBanner,
  cachedDetail,
  prefetchDetail,
  putDetailCache,
} from "./deliveries";
import { DocsTab, prefetchClusterDocs } from "./docs";
import { AIDock, Spark, useAIStatus } from "./aichat";
import { ClusterConfig } from "./clusterconfig";
import { ClusterSecurityTab } from "./clustersecurity";
import { ImportedBaselineModal } from "./importcluster";
import {
  ClusterRehearsal,
  computeEffectiveClusterChanges,
  launchRehearsalIntent,
} from "./rehearsal";
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

function TabSecurityIcon() {
  return (
    <svg {...TAB_SVG_PROPS}>
      <path d="M8 2.15L13 4.1V7.7C13 10.8 10.9 12.95 8 13.85C5.1 12.95 3 10.8 3 7.7V4.1L8 2.15Z" />
      <path d="M6.2 8.15L7.45 9.4L10 6.75" />
    </svg>
  );
}

/* ---------- URL compatibility for ?tab=deploy and legacy ?tab=deliveries ---------- */

type ClusterTabCompat = {
  tab?: "config" | "plans" | "docs" | "rehearsal" | "security";
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
  if (qTab === "security") {
    return {
      tab: "security",
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
  tab?: "config" | "plans" | "docs" | "rehearsal" | "security";
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
  const isImported = c.delivery_mode === "imported";
  const [baselineModal, setBaselineModal] = useState<null | "edit" | "probe">(null);
  const effectiveTab =
    (resolvedTab === "plans" && isImported) ||
    (resolvedTab === "rehearsal" && !canRehearse) ||
    (resolvedTab === "docs" && !hasDocs) ||
    (resolvedTab === "security" && !hasDocs)
      ? undefined
      : resolvedTab;
  const tabKey = effectiveTab || "overview";
  const rhCount = rehearsals ? rehearsals.length : 0;
  const tabItems = [
    { value: "overview", label: bi("概览", "Overview"), icon: <TabOverviewIcon /> },
    { value: "config", label: bi("配置", "Config"), icon: <TabConfigIcon /> },
    ...(!isImported
      ? [{ value: "plans", label: bi("部署", "Deploy"), icon: <TabDeployIcon /> }]
      : []),
    ...(hasDocs
      ? [{ value: "security", label: bi("安全", "Security"), icon: <TabSecurityIcon /> }]
      : []),
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
  // Keep the detail pane at the top when switching cluster tabs, plans, docs, or rehearsals,
  // but preserve scroll position when switching inner Config sub-sections (`resolvedSection`)
  // so clicking between long/short component tabs never yanks the tab bar away from the pointer.
  useLayoutEffect(() => {
    document.querySelector(".md-detail")?.scrollTo({ top: 0 });
  }, [
    effectiveTab,
    resolvedPlan,
    resolvedDoc,
    resolvedRehearsal,
    resolvedSource,
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
              <DeliveryModeTag mode={c.delivery_mode} />
              {(() => {
                const appliedList = (rehearsals || []).filter(
                  (x) => x.stage === "finalized" && x.applied && !x.voided,
                );
                const appliedCount = Math.max(
                  c.applied_changes_count || 0,
                  appliedList.length,
                );
                if (appliedCount <= 0) return null;
                const latestTitle =
                  appliedList[0]?.title || c.last_change_title || "";
                return (
                  <Tooltip
                    content={
                      latestTitle
                        ? bi(
                            `最近落地变更：${latestTitle}`,
                            `Latest applied change: ${latestTitle}`,
                          )
                        : bi(
                            `已确认 ${appliedCount} 次生产变更落地`,
                            `${appliedCount} production change(s) applied`,
                          )
                    }
                    mini
                  >
                    <button
                      type="button"
                      className="cl-applied-chip"
                      onClick={() =>
                        go(
                          { name: "deliveries", id: c.id, tab: "rehearsal" },
                          { replace: true },
                        )
                      }
                    >
                      <IconCheck />
                      <span>
                        {bi(
                          `已落地 ${appliedCount} 次变更`,
                          `${appliedCount} ${appliedCount === 1 ? "change" : "changes"} applied`,
                        )}
                      </span>
                    </button>
                  </Tooltip>
                );
              })()}
              {c.purpose === "verification" && (
                <span className="cl-verify-tag">
                  {bi("组件验证通道", "Component Verification")}
                </span>
              )}
            </div>
            <div className="detail-meta">
              {owner && <span className="row-owner">{bi(`${owner} 的集群`, `${owner}'s cluster`)}</span>}
              <span>
                {c.app_name} {c.version}
              </span>
              {c.platform && <span>{platformShort(c.platform)}</span>}
              {c.purpose === "verification" && c.verify_target && (
                <a
                  className="cl-verify-target-link"
                  href={`#/components/${encodeURIComponent(c.verify_target.component)}`}
                >
                  {bi(
                    `验证目标：${c.verify_target.component} ${c.verify_target.version} (${platformShort(c.verify_target.platform)})`,
                    `Target: ${c.verify_target.component} ${c.verify_target.version} (${platformShort(c.verify_target.platform)})`,
                  )}
                </a>
              )}
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
                  <Menu
                    onClickMenuItem={(k) => {
                      if (k === "copy") copy(c.id);
                      else if (k === "edit-baseline") setBaselineModal("edit");
                      else if (k === "reprobe") setBaselineModal("probe");
                      else if (k === "delete-imported" && c.current) {
                        Modal.confirm({
                          title: bi("移除存量纳管集群", "Remove Imported Cluster"),
                          content: bi(
                            `确定要从平台移除纳管集群「${c.id}」的基线档案吗？此操作仅删除平台档案，绝不会影响线上运行的中间件节点。`,
                            `Remove the onboarded baseline record for "${c.id}"? This only removes platform records and never touches your running cluster.`,
                          ),
                          okText: bi("确认移除", "Remove"),
                          okButtonProps: { status: "danger" },
                          cancelText: bi("取消", "Cancel"),
                          onOk: async () => {
                            await api(`/api/jobs/${encodeURIComponent(c.current!)}`, {
                              method: "DELETE",
                            });
                            Message.success(bi(`已移除纳管集群 ${c.id}`, `Removed ${c.id}`));
                            window.dispatchEvent(new Event("mh-clusters-changed"));
                            await reload();
                            go({ name: "deliveries" });
                          },
                        });
                      }
                    }}
                  >
                    <Menu.Item key="copy">
                      <IconCopy /> {bi("复制集群标识", "Copy Cluster ID")}
                    </Menu.Item>
                    {isImported && can("delivery.create") && (
                      <>
                        <Menu.Item key="edit-baseline">
                          <IconEdit /> {bi("编辑纳管基线", "Edit Baseline")}
                        </Menu.Item>
                        <Menu.Item key="reprobe">
                          <IconRefresh /> {bi("重新只读采集", "Re-Run Probe")}
                        </Menu.Item>
                        <Menu.Item key="delete-imported" style={{ color: "var(--bad)" }}>
                          <IconDelete /> {bi("移除纳管集群", "Remove Imported Cluster")}
                        </Menu.Item>
                      </>
                    )}
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
                    tab: next as "plans" | "rehearsal" | "docs" | "security",
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
            rehearsals={rehearsals}
          />
        ) : effectiveTab === "plans" ? (
          <InitialDeploymentView
            c={c}
            selectedId={resolvedPlan}
            narrow={narrow}
            reload={reload}
          />
        ) : effectiveTab === "security" ? (
          <ClusterSecurityTab c={c} canRehearse={canRehearse} />
        ) : effectiveTab === "rehearsal" && canRehearse ? (
          <ClusterRehearsal
            c={c}
            rehearsalId={resolvedRehearsal}
            initialList={rehearsals}
            focused={isFocusedRehearsal}
            onFocusChange={onRehearsalFocusChange}
            onListUpdated={refreshRehearsals}
            onClusterChanged={() => {
              refreshRehearsals();
              void reload();
            }}
          />
        ) : effectiveTab === "docs" ? (
          <DocsTab c={c} doc={resolvedDoc} />
        ) : (
          <Overview
            c={c}
            appIcon={app?.category}
            canRehearse={canRehearse}
            rehearsals={rehearsals}
            onOpenBaseline={isImported ? (m) => setBaselineModal(m) : undefined}
          />
        )}
      </div>
      {isImported && (
        <ImportedBaselineModal
          visible={baselineModal !== null}
          mode={baselineModal || "edit"}
          cluster={c}
          onClose={() => setBaselineModal(null)}
          onSaved={async () => {
            if (c.current) {
              putDetailCache(
                c.current,
                await api<JobDetail>(`/api/jobs/${encodeURIComponent(c.current)}`),
              );
            }
            await reload();
          }}
        />
      )}
    </article>
  );
  // the assistant on a cluster talks about the delivery that describes it now, or the viewed deployment
  const dockPlan =
    effectiveTab === "plans" && entry
      ? entry
      : c.plans.find((p) => p.id === (c.current || c.holder)) || c.plans[0];
  const hideDock = !dockPlan || dockPlan.state !== "succeeded";
  const activeRehearsal =
    effectiveTab === "rehearsal" && resolvedRehearsal
      ? (rehearsals || []).find((x) => x.id === resolvedRehearsal)
      : undefined;
  return (
    <AIDock
      scope={{ kind: "job", jobId: dockPlan?.id || c.id }}
      start={{
        key: "review",
        title:
          effectiveTab === "rehearsal"
            ? bi("变更演练助手", "Rehearsal Assistant")
            : bi("集群问答", "Cluster Q&A"),
        context:
          effectiveTab === "rehearsal" && activeRehearsal
            ? `${c.id} · ${activeRehearsal.title}`
            : `${c.id} · ${c.app_name}`,
      }}
      hidden={hideDock}
      compactLauncher={effectiveTab === "rehearsal"}
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

  const hasOtherRevisions = c.plans.length > 1;
  const hasCompletedHistory = c.plans.some(
    (p) =>
      p.id !== (c.current || c.holder) &&
      (planPhase(p) === "done" || planPhase(p) === "deviated"),
  );
  const revisionBar = hasOtherRevisions ? (
    <div
      className="cl-init-drafts"
      role="navigation"
      aria-label={bi("交付记录切换", "Delivery record switcher")}
    >
      <span>
        {hasCompletedHistory
          ? bi("交付记录切换：", "Delivery records:")
          : bi("当前生效交付与归档草稿：", "Active delivery & archived drafts:")}
      </span>
      <div className="cl-init-draft-pills">
        {c.plans.map((p) => {
          const ph = planPhase(p);
          const isCur = p.id === active.id;
          const isBase = p.id === (c.current || c.holder);
          const pillLabel = isBase
            ? bi("当前交付", "Active delivery")
            : ph === "done"
              ? bi("历史交付（已完成）", "Past delivery (done)")
              : ph === "deviated"
                ? bi("历史交付（有偏差）", "Past delivery (deviated)")
                : bi(`${PLAN_PHASE[ph].label}草稿`, `${PLAN_PHASE[ph].label} draft`);
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
              <span>{pillLabel}</span>
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
  if (r.voided) {
    return r.superseded_by
      ? bi("⊘ 已被替代", "⊘ Superseded")
      : bi("⊘ 已作废", "⊘ Voided");
  }
  if (r.stage === "finalized") {
    return r.applied
      ? bi("✓ 已落地", "✓ Applied")
      : bi("待生产实施", "Pending Apply");
  }
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

function AppliedChangesLedger({
  clusterId,
  primaryComponent,
  appliedRehearsals,
}: {
  clusterId: string;
  primaryComponent?: string;
  appliedRehearsals: ChangeRehearsal[];
}) {
  useLang();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(
    () =>
      [...appliedRehearsals].sort((a, b) =>
        (b.applied_at || b.updated_at || "").localeCompare(
          a.applied_at || a.updated_at || "",
        ),
      ),
    [appliedRehearsals],
  );
  const effective = useMemo(
    () => computeEffectiveClusterChanges(appliedRehearsals),
    [appliedRehearsals],
  );
  const visible = showAll ? sorted : sorted.slice(0, 3);
  const hiddenCount = sorted.length - visible.length;

  return (
    <div className="cl-u-changes">
      <div className="cl-u-sec-h">
        <span className="cl-u-changes-h">
          <IconCheck />
          {bi("生产已落地变更", "Applied Production Changes")}
          <em className="cl-u-changes-cnt num">
            {effective.items.length > 0
              ? bi(
                  `${sorted.length} 次 · ${effective.items.length} 项配置生效`,
                  `${sorted.length} rollout(s) · ${effective.items.length} active change(s)`,
                )
              : bi(`${sorted.length} 次`, `${sorted.length} rollout(s)`)}
          </em>
        </span>
        <button
          type="button"
          className="link small"
          onClick={() =>
            go({
              name: "deliveries",
              id: clusterId,
              tab: "config",
              section: primaryComponent ? `component:${primaryComponent}` : undefined,
            })
          }
        >
          {bi("在配置页查看生效项", "View Merged Config")} <IconRight />
        </button>
      </div>
      <div className="cl-u-chg-ledger">
        {visible.map((rh) => {
          const open = Boolean(expanded[rh.id]);
          const changes = rh.applied_changes || [];
          return (
            <div
              key={rh.id}
              className={`cl-u-chg-row${open ? " is-open" : ""}`}
            >
              <div
                className="cl-u-chg-head"
                role="button"
                tabIndex={0}
                onClick={() =>
                  setExpanded((prev) => ({ ...prev, [rh.id]: !open }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setExpanded((prev) => ({ ...prev, [rh.id]: !open }));
                  }
                }}
              >
                <span className="cl-u-chg-main">
                  <span className="cl-u-change-dot" aria-hidden />
                  <b className="cl-u-chg-title">{rh.title}</b>
                </span>
                <span className="cl-u-chg-pill-slot">
                  {changes.length > 0 && (
                    <span className="cl-u-chg-pill num">
                      {bi(`${changes.length} 项参数`, `${changes.length} params`)}
                    </span>
                  )}
                </span>
                <span className="cl-u-change-who num">
                  {rh.applied_by || rh.owner} · {ago(rh.applied_at || rh.updated_at)}
                </span>
                <div
                  className="cl-u-change-links"
                  onClick={(e) => e.stopPropagation()}
                >
                  {rh.doc_id && (
                    <button
                      type="button"
                      className="link small"
                      onClick={() =>
                        go({
                          name: "deliveries",
                          id: clusterId,
                          tab: "docs",
                          doc: rh.doc_id,
                        })
                      }
                    >
                      {bi("变更报告", "Report")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="link small"
                    onClick={() =>
                      go({
                        name: "deliveries",
                        id: clusterId,
                        tab: "rehearsal",
                        rehearsal: rh.id,
                      })
                    }
                  >
                    {bi("演练", "Details")}
                  </button>
                </div>
                <IconDown className="cl-u-chg-chev" />
              </div>
              {open && (
                <div className="cl-u-chg-detail">
                  {rh.applied_summary && (
                    <p className="cl-u-change-sum">{rh.applied_summary}</p>
                  )}
                  {changes.length > 0 && (
                    <div className="cl-u-chg-kv">
                      {changes.map((ch, idx) => {
                        const latest = effective.latestByKey.get(
                          (ch.key || "").trim().toLowerCase(),
                        );
                        const isOverwritten = Boolean(
                          latest && latest.source_id !== rh.id,
                        );
                        return (
                          <div
                            key={`${ch.key}-${idx}`}
                            className={`cl-u-chg-kv-row${isOverwritten ? " is-overwritten" : ""}`}
                          >
                            <code className="cl-u-chg-k mono">{ch.key}</code>
                            <span className="cl-u-chg-v">
                              {ch.before && (
                                <>
                                  <del className="cl-u-delta-old mono">
                                    {ch.before}
                                  </del>
                                  <span className="cl-u-chg-arr" aria-hidden>
                                    →
                                  </span>
                                </>
                              )}
                              <code className="cl-u-chg-new">{ch.after}</code>
                              {isOverwritten && (
                                <em className="cl-u-delta-sup">
                                  {bi("已被更新", "Updated")}
                                </em>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {sorted.length > 3 && (
        <button
          type="button"
          className="cl-u-chg-more"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll
            ? bi("收起历史记录", "Show fewer")
            : bi(
                `展开其余 ${hiddenCount} 条变更记录（共 ${sorted.length} 条）`,
                `Show ${hiddenCount} more (${sorted.length} total)`,
              )}
        </button>
      )}
    </div>
  );
}

function Overview({
  c,
  canRehearse,
  rehearsals,
  onOpenBaseline,
}: {
  c: ClusterView;
  appIcon?: string;
  canRehearse: boolean;
  rehearsals: ChangeRehearsal[] | null;
  onOpenBaseline?: (mode: "edit" | "probe") => void;
}) {
  useLang();
  const isImported = c.delivery_mode === "imported";
  const imp = c.imported;
  const holder = c.plans.find((p) => p.id === c.holder);
  const current = c.plans.find((p) => p.id === c.current);
  const basePlan = current || holder || c.plans[0];
  const canReviseHolder =
    !isImported &&
    !!holder &&
    holder.state === "succeeded" &&
    holder.outcome !== "done" &&
    holder.outcome !== "deviated" &&
    holder.outcome !== "void" &&
    can("delivery.create");
  const rhList = rehearsals || [];
  const appliedRehearsals = rhList.filter(
    (x) => x.stage === "finalized" && x.applied && !x.voided,
  );
  const pendingFinalizedCount = rhList.filter(
    (x) => x.stage === "finalized" && !x.applied && !x.voided,
  ).length;
  const voidedCount = rhList.filter((x) => x.voided).length;
  const sortedRhList = [...rhList].sort(
    (a, b) => Number(Boolean(a.voided)) - Number(Boolean(b.voided)),
  );
  const deployMethodLabel =
    imp?.deploy_method === "docker"
      ? bi("Docker / 容器化", "Docker / Container")
      : imp?.deploy_method === "binary"
        ? bi("二进制手工部署", "Binary / Manual")
        : imp?.deploy_method === "k8s"
          ? "Kubernetes"
          : imp?.deploy_method === "other"
            ? bi("其他形态", "Other")
            : bi("systemd 系统服务", "systemd Service");
  const sourceKindLabel =
    imp?.source_kind === "probe"
      ? bi("只读探针采集", "Read-Only Probe")
      : imp?.source_kind === "ai_doc"
        ? bi("文档 / 配置识别", "Doc / Config Extract")
        : bi("手工建档", "Manual Onboarding");

  return (
    <div className="cl-over">
      {isImported && (
        <section className="cl-imp-card" aria-label={bi("存量纳管基线", "Imported Baseline")}>
          <div className="cl-imp-card-head">
            <div className="cl-imp-title-wrap">
              <div>
                <h3>{bi("存量纳管基线档案", "Imported Brownfield Baseline")}</h3>
                <div className="cl-imp-sub">
                  {sourceKindLabel} · {deployMethodLabel}
                  {imp?.last_probed_at
                    ? bi(` · 最近采集 ${ago(imp.last_probed_at)}`, ` · Probed ${ago(imp.last_probed_at)}`)
                    : imp?.baseline_updated_at
                      ? bi(` · 基线更新于 ${ago(imp.baseline_updated_at)}`, ` · Updated ${ago(imp.baseline_updated_at)}`)
                      : ""}
                </div>
              </div>
            </div>
            <div className="cl-imp-actions">
              {can("delivery.create") && onOpenBaseline && (
                <>
                  <Button size="small" icon={<IconEdit />} onClick={() => onOpenBaseline("edit")}>
                    {bi("编辑基线", "Edit Baseline")}
                  </Button>
                  <Button size="small" icon={<IconRefresh />} onClick={() => onOpenBaseline("probe")}>
                    {bi("重新只读采集", "Re-Run Probe")}
                  </Button>
                </>
              )}
              {canRehearse && (
                <Button
                  size="small"
                  type="primary"
                  onClick={() => go({ name: "deliveries", id: c.id, tab: "rehearsal" })}
                >
                  {bi("发起变更演练", "Start Change Rehearsal")}
                </Button>
              )}
            </div>
          </div>
          <div className="cl-imp-facts">
            <div className="cl-imp-fact">
              <span className="cl-imp-fact-k">{bi("精确版本", "Exact Version")}</span>
              <span className="cl-imp-fact-v mono">{imp?.exact_version || c.version || "—"}</span>
            </div>
            <div className="cl-imp-fact">
              <span className="cl-imp-fact-k">{bi("操作系统", "Operating System")}</span>
              <span className="cl-imp-fact-v">{imp?.os_detail || (c.platform ? platformShort(c.platform) : "—")}</span>
            </div>
            <div className="cl-imp-fact">
              <span className="cl-imp-fact-k">{bi("服务单元", "Service Units")}</span>
              <span className="cl-imp-fact-v mono">
                {imp?.service_units?.length ? imp.service_units.join(", ") : "—"}
              </span>
            </div>
            <div className="cl-imp-fact">
              <span className="cl-imp-fact-k">{bi("配置路径", "Config Paths")}</span>
              <span className="cl-imp-fact-v mono">
                {imp?.config_paths?.length
                  ? imp.config_paths.join(", ").split("/").map((seg, idx) => (
                      <React.Fragment key={idx}>
                        {idx > 0 && (
                          <>
                            /<wbr />
                          </>
                        )}
                        {seg}
                      </React.Fragment>
                    ))
                  : "—"}
              </span>
            </div>
            <div className="cl-imp-fact">
              <span className="cl-imp-fact-k">{bi("数据目录", "Data Dirs")}</span>
              <span className="cl-imp-fact-v mono">
                {imp?.data_dirs?.length
                  ? imp.data_dirs.join(", ").split("/").map((seg, idx) => (
                      <React.Fragment key={idx}>
                        {idx > 0 && (
                          <>
                            /<wbr />
                          </>
                        )}
                        {seg}
                      </React.Fragment>
                    ))
                  : "—"}
              </span>
            </div>
            <div className="cl-imp-fact">
              <span className="cl-imp-fact-k">{bi("采集软件包", "Collected Packages")}</span>
              <span className="cl-imp-fact-v num">
                {imp?.packages?.length
                  ? bi(`${imp.packages.length} 项（已纳入 CVE 扫描）`, `${imp.packages.length} pkg(s) (CVE indexed)`)
                  : bi("未采集（可运行只读探针补齐）", "None (run probe to collect)")}
              </span>
            </div>
          </div>
          {imp?.notes && <div className="cl-imp-notes">{imp.notes}</div>}
        </section>
      )}
      {!isImported && holder && <HolderCard c={c} p={holder} />}
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
        <Now
          key={current.id}
          c={c}
          p={current}
          appliedRehearsals={appliedRehearsals}
        />
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
                  <span className="cl-ledger-tag">
                    {isImported ? bi("存量纳管基线", "Imported Baseline") : bi("初始部署基线", "Initial Baseline")}
                  </span>
                  <StatusBadge
                    state={PLAN_PHASE[planPhase(basePlan)].dot}
                    label={
                      isImported
                        ? bi("纳管运行中", "Managed")
                        : PLAN_PHASE[planPhase(basePlan)].label
                    }
                  />
                  <DeliveryModeTag mode={basePlan.delivery_mode} compact />
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
                        ? c.plans.some(
                            (p) =>
                              p.id !== basePlan.id &&
                              (planPhase(p) === "done" ||
                                planPhase(p) === "deviated"),
                          )
                          ? bi(
                              ` · 含 ${c.plans.length - 1} 份历史交付`,
                              ` · ${c.plans.length - 1} past ${c.plans.length - 1 === 1 ? "delivery" : "deliveries"}`,
                            )
                          : bi(
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
                      : bi(`${basePlan.marked_by} 于 ${ago(basePlan.marked!)} 确认部署完成`, `${basePlan.marked_by} confirmed completion ${ago(basePlan.marked!)}`)}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="dsec-link link cl-ledger-act"
                onClick={() =>
                  go(
                    isImported
                      ? { name: "deliveries", id: c.id, tab: "docs", doc: "delivery" }
                      : { name: "deliveries", id: c.id, tab: "plans" },
                    { replace: true },
                  )
                }
              >
                {isImported ? bi("查看基线档案", "View Baseline Doc") : bi("查看部署手册", "View Runbook")} <IconRight />
              </button>
            </div>

            {canRehearse && (
              <div className="cl-ledger-group">
                <div className="cl-ledger-subhead">
                  <div className="cl-ledger-subhead-left">
                    <span className="cl-ledger-tag">{bi("变更演练记录", "Change Rehearsals")}</span>
                    <span className="dsec-count num">{rhList.length}</span>
                    {appliedRehearsals.length > 0 && (
                      <span className="cl-ledger-subnote is-applied num">
                        {bi(
                          `已落地 ${appliedRehearsals.length} 次变更`,
                          `${appliedRehearsals.length} applied`,
                        )}
                      </span>
                    )}
                    {pendingFinalizedCount > 0 && (
                      <span className="cl-ledger-subnote is-pending num">
                        {bi(
                          `待实施 ${pendingFinalizedCount} 份方案`,
                          `${pendingFinalizedCount} pending apply`,
                        )}
                      </span>
                    )}
                    {voidedCount > 0 && (
                      <span className="cl-ledger-subnote num">
                        {bi(
                          `已作废 ${voidedCount} 份`,
                          `${voidedCount} voided`,
                        )}
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
                {sortedRhList.length > 0 ? (
                  <ul className="cl-ledger-rh-list">
                    {sortedRhList.slice(0, 5).map((item) => {
                      const hasConflict = Boolean(
                        !item.applied &&
                          !item.voided &&
                          item.conflict_alerts?.some(
                            (a) => a.severity === "conflict",
                          ),
                      );
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            className={`cl-ledger-rh-row${item.voided ? " is-voided" : ""}`}
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
                              {hasConflict && (
                                <span className="cl-ledger-conflict">
                                  {bi("冲突提醒", "Conflict")}
                                </span>
                              )}
                              <span
                                className={`cl-ledger-stage ${item.voided ? "is-voided" : item.applied ? "is-applied" : item.stage === "finalized" ? "is-pending" : ""}`}
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
                      );
                    })}
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
          <DeliveryModeTag mode={p.delivery_mode} compact />
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
function Now({
  c,
  p,
  appliedRehearsals = [],
}: {
  c: ClusterView;
  p: PlanEntry;
  appliedRehearsals?: ChangeRehearsal[];
}) {
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
    <>
      {d?.verification_promote && d.verification_promote.length > 0 && (
        <VerificationPromoteBanner
          jobId={p.id}
          targets={d.verification_promote}
          onPromoted={() => setRetry((n) => n + 1)}
        />
      )}
      <section className="dsec">
        <h2 className="dsec-title">
          {c.delivery_mode === "configuration"
            ? bi("集群配置拓扑", "Configuration Topology")
          : bi("运行拓扑与连接", "Topology & Connections")}
        <span className="dsec-note">
          {finished
            ? appliedRehearsals.length > 0
              ? bi(
                  `已确认运行基线 · 已叠加 ${appliedRehearsals.length} 次生产变更`,
                  `Confirmed baseline · ${appliedRehearsals.length} prod change(s) applied`,
                )
              : bi("已确认运行基线", "Confirmed baseline")
            : bi("待执行部署交付", "Pending deployment")}
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
        <ClusterUnifiedOverview
          c={c}
          p={p}
          plan={plan}
          input={input}
          appliedRehearsals={appliedRehearsals}
        />
      )}
      </section>
    </>
  );
}

/** Every machine of the cluster in one row: address, data disk, and what runs on it. */
function HostTable({
  plan,
  input,
  cluster,
}: {
  plan: NonNullable<JobDetail["plan"]>;
  input?: NonNullable<JobDetail["spec"]>["deployment"];
  cluster?: ClusterView;
}) {
  useLang();
  const specs = (input?.hosts || []) as {
    name: string;
    disk?: string;
    partition?: string;
    initialize?: boolean;
    params?: Record<string, unknown>;
  }[];
  const storageOpts = {
    imported: cluster?.delivery_mode === "imported",
    importedDataDirs: cluster?.imported?.data_dirs,
  };
  const rows = plan.hosts.map((h) => ({
    ...h,
    storage: hostStorage(specs.find((x) => x.name === h.name), storageOpts),
    roles: displayInstances(plan.instances).flatMap((i) =>
      Object.entries(i.roles || {})
        .filter(([, hs]) => hs.includes(h.name))
        .map(([r]) => `${i.title} ${i.role_titles?.[r] || r}`),
    ),
  }));
  return (
    <div className="cl-hosts-wrap">
      <table className="cl-hosts">
        <colgroup>
          <col style={{ width: "18%" }} />
          <col style={{ width: "21%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "39%" }} />
        </colgroup>
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
              <td className="cl-host-td">
                <span className="cl-host-cell">
                  <b title={r.name}>{r.name}</b>
                  {r.name === plan.controller && <em>{bi("控制", "Ctrl")}</em>}
                </span>
              </td>
              <td className="mono cl-ip-td">
                <span className="cl-copy-cell">
                  <span title={r.ip}>{r.ip}</span>
                  <InlineCopyBtn value={r.ip} label={bi(`${r.name} 地址`, `${r.name} IP`)} />
                </span>
              </td>
              <td
                className="cl-store-td"
                title={
                  r.storage.path
                    ? `${r.storage.label} ${r.storage.path}`
                    : r.storage.label
                }
              >
                <span className="cl-store-main">{r.storage.label}</span>
                {r.storage.path && (
                  <span className="mono faint small">{r.storage.path}</span>
                )}
              </td>
              <td>
                {r.roles.length > 0 ? (
                  <div className="cl-role-tags">
                    {r.roles.map((role) => (
                      <span key={role} className="cl-role-tag">
                        {role}
                      </span>
                    ))}
                  </div>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

/** Unified single-card overview integrating connection strip, topology canvas, components, key parameters, and host table. */
function ClusterUnifiedOverview({
  c,
  p,
  plan,
  input,
  appliedRehearsals = [],
}: {
  c: ClusterView;
  p: PlanEntry;
  plan?: JobDetail["plan"];
  input?: NonNullable<JobDetail["spec"]>["deployment"];
  appliedRehearsals?: ChangeRehearsal[];
}) {
  useLang();
  const [shownSecrets, setShownSecrets] = useState<Record<string, boolean>>({});
  const insts = plan?.instances || [];
  const real = displayInstances(insts).filter((i) => !i.external);
  const defaultIp = plan?.hosts?.[0]?.ip || input?.hosts?.[0]?.ip || "";
  const entries = insts
    .flatMap((i) =>
      Object.entries(i.fronts || {}).map(([epName, f]) => {
        const ep = (i.endpoints || []).find((x) => x.name === epName);
        const rawTitle = (ep?.title || "").trim();
        const label = f.external
          ? rawTitle
            ? bi(`外部 · ${rawTitle}`, `External · ${rawTitle}`)
            : bi("外部入口", "External entry")
          : rawTitle || bi("访问入口", "Entrypoint");
        const isPrimary = /write|primary|master|主|写/i.test(`${epName} ${rawTitle}`);
        return {
          key: `${i.id}.${epName}.${f.listen}`,
          label,
          listen: f.listen,
          isPrimary,
          addr: f.address
            ? `${f.address}:${f.listen}`
            : defaultIp
              ? `${defaultIp}:${f.listen}`
              : `:${f.listen}`,
        };
      }),
    )
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.listen - b.listen);

  const ports = real
    .flatMap((i) => (i.ports || []).map((x) => ({ name: x.Name, port: x.Port })))
    .filter((x, idx, arr) => arr.findIndex((y) => y.name === x.name && y.port === x.port) === idx)
    .slice(0, 8);

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
    .slice(0, 8);
  const roleLine = (i: (typeof insts)[number]) =>
    Object.entries(i.roles || {})
      .filter(([, hs]) => hs.length)
      .map(([r, hs]) => `${i.role_titles?.[r] || r} ${hs.join(bi("、", ", "))}`)
      .join(" · ");
  const hostCount = input?.hosts.length ?? c.hosts;

  return (
    <div className="cl-now-unified">
      {(entries.length > 0 || ports.length > 0 || secrets.length > 0) && (
        <div className="cl-u-access">
          {entries.length > 0 && (
            <div className="cl-u-acc-row">
              <span className="cl-u-eyebrow">{bi("访问入口", "Endpoints")}</span>
              <div className="cl-u-entries">
                {entries.map((e) => (
                  <div
                    key={e.key}
                    className={`cl-u-entry ${e.isPrimary ? "is-primary" : ""}`}
                  >
                    <span className="cl-u-entry-lbl">{e.label}</span>
                    <span className="cl-u-entry-addr mono">{e.addr}</span>
                    <InlineCopyBtn value={e.addr} label={e.label} />
                  </div>
                ))}
              </div>
            </div>
          )}
          {ports.length > 0 && (
            <div className="cl-u-acc-row">
              <span className="cl-u-eyebrow">{bi("监听端口", "Ports")}</span>
              <div className="cl-u-ports">
                {ports.map((pt) => (
                  <span key={`${pt.name}-${pt.port}`} className="cl-port-chip">
                    <span className="cl-port-k">{pt.name}</span>
                    <b className="mono">{pt.port}</b>
                  </span>
                ))}
              </div>
            </div>
          )}
          {secrets.length > 0 && (
            <div className="cl-u-acc-row">
              <span className="cl-u-eyebrow">{bi("连接凭据", "Credentials")}</span>
              <div className="cl-u-secrets">
                {secrets.map((s) => {
                  const shown = !!shownSecrets[s.key];
                  return (
                    <div key={s.key} className="cl-u-secret">
                      <span className="cl-u-secret-k mono">{s.label}</span>
                      <span className="cl-u-secret-v mono">
                        {shown ? s.value : "••••••••"}
                      </span>
                      <Tooltip
                        content={
                          shown
                            ? bi("隐藏凭据", "Hide credential")
                            : bi("显示凭据", "Show credential")
                        }
                        mini
                      >
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
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {plan && (
        <div className="cl-u-topo">
          <ExecutionHostSummary host={plan.execution_host} />
          <InstanceGraph
            hosts={plan.hosts}
            instances={plan.instances}
            controller={plan.controller}
            layout="row"
          />
        </div>
      )}

      {(real.length > 0 || picks.length > 0) && (
        <div className="cl-u-meta">
          {real.length > 0 && (
            <div className="cl-u-sec">
              <div className="cl-u-sec-h">
                <span>{bi("组件组成", "Components")}</span>
              </div>
              <div className="cl-u-comps">
                {real.map((i) => (
                  <div key={i.id} className="cl-u-comp">
                    <div className="cl-u-comp-top">
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
                  </div>
                ))}
              </div>
            </div>
          )}

          {picks.length > 0 && (
            <div className="cl-u-sec">
              <div className="cl-u-sec-h">
                <span>{bi("关键配置", "Key Parameters")}</span>
              </div>
              <div className="cl-u-params">
                {picks.map((k) => {
                  const val = main!.params[k];
                  const cls =
                    typeof val === "boolean" ? (val ? "on" : "off") : "mono";
                  return (
                    <div key={k} className="cl-u-param">
                      <span className="cl-u-param-k">{PARAM_LABEL[k]}</span>
                      <span className={`cl-u-param-v ${cls}`}>{showParam(val)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {appliedRehearsals.length > 0 && (
        <AppliedChangesLedger
          clusterId={c.id}
          primaryComponent={main?.id || c.app_id}
          appliedRehearsals={appliedRehearsals}
        />
      )}

      {plan && (
        <div className="cl-u-hosts">
          <div className="cl-u-sec-h">
            <span>{bi("节点与角色", "Hosts & Roles")}</span>
            {hostCount > 0 && (
              <span className="cl-u-hosts-meta num">
                {hostCount === 1
                  ? bi("1 台机器", "1 host")
                  : bi(`${hostCount} 台机器`, `${hostCount} hosts`)}
                {" · "}
                {plan.execution_host
                  ? bi("独立执行机", "Standalone executor")
                  : bi("集群内执行机", "In-cluster executor")}{" "}
                <b className="mono">{plan.controller || input?.controller || "—"}</b>
              </span>
            )}
          </div>
          <HostTable plan={plan} input={input} cluster={c} />
        </div>
      )}

      <div className="cl-u-foot">
        <span>
          {bi("负责人", "Owner")} <b>{c.owner}</b>
        </span>
        <span className="cl-u-foot-sep" aria-hidden>·</span>
        <span>
          {bi("交付状态", "Status")} <b>{PLAN_PHASE[planPhase(p)].label}</b>{" "}
          <span className="mono faint">#{p.id.slice(0, 8)}</span>
        </span>
        <span className="cl-u-foot-sep" aria-hidden>·</span>
        <span>
          {bi("创建", "Created")} {ago(c.created)}
        </span>
      </div>
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

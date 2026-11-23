import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Drawer,
  Input,
  Message,
  Modal,
  Skeleton,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconCheck,
  IconExclamationCircle,
  IconImport,
  IconRefresh,
  IconRight,
  IconSearch,
  IconShareExternal,
} from "@arco-design/web-react/icon";
import { ago, api } from "./shared";
import type {
  ChangeRehearsal,
  ClusterView,
  RehearsalAppliedChange,
} from "./shared";
import { go } from "./router";
import { bi, useLang } from "./i18n";
import "./rehearsal_rollout.css";

export type PropagateOriginSummary = {
  cluster_id: string;
  rehearsal_id: string;
  title: string;
  app_id: string;
  app_name: string;
  version: string;
  mode: string;
  scheme_id?: string;
  scheme_name?: string;
  hosts: number;
  applied_at?: string;
  applied_by?: string;
  rollout_id?: string;
  changed_keys?: string[];
};

export type PropagateTargetItem = {
  cluster_id: string;
  app_id: string;
  app_name: string;
  version: string;
  hosts: number;
  scheme_id?: string;
  scheme_name?: string;
  deployed: boolean;
  match_tier: "exact" | "compatible";
  match_reason: string;
  allow_skip_probe: boolean;
  skip_probe_block_reason?: string;
  already_imported: boolean;
  already_effective: boolean;
  conflict_keys?: string[];
  conflict_summary?: string;
  existing_rehearsal_id?: string;
  existing_stage?: string;
  existing_applied?: boolean;
  existing_voided?: boolean;
};

export type PropagateTargetsResponse = {
  origin: PropagateOriginSummary;
  default_mode: "probe" | "steps";
  targets: PropagateTargetItem[];
};

export type RehearsalTemplateItem = {
  origin_cluster_id: string;
  origin_rehearsal_id: string;
  rollout_id?: string;
  title: string;
  goal: string;
  mode: string;
  app_id: string;
  app_name: string;
  version: string;
  scheme_id?: string;
  scheme_name?: string;
  hosts: number;
  applied_at?: string;
  applied_by?: string;
  applied_summary?: string;
  applied_changes?: RehearsalAppliedChange[];
  steps_count: number;
  rollout_total?: number;
  rollout_applied?: number;
  match_tier?: "exact" | "compatible";
  match_reason?: string;
  allow_skip_probe: boolean;
  skip_probe_block_reason?: string;
  already_imported: boolean;
  already_effective: boolean;
  conflict_keys?: string[];
  conflict_summary?: string;
  existing_rehearsal_id?: string;
};

export type RolloutBoardMember = {
  cluster_id: string;
  rehearsal_id: string;
  is_origin: boolean;
  app_name: string;
  version: string;
  scheme_name?: string;
  hosts: number;
  match_tier: "origin" | "exact" | "compatible";
  import_mode?: string;
  strict_precheck?: boolean;
  stage: string;
  status_key:
    | "applied"
    | "finalized_pending"
    | "rehearsing"
    | "probing"
    | "scoping"
    | "voided";
  steps_done: number;
  steps_total: number;
  applied: boolean;
  applied_at?: string;
  applied_by?: string;
  voided: boolean;
  void_reason?: string;
  doc_id?: string;
  conflict_count: number;
  conflict_summary?: string;
  updated_at: string;
};

export type RolloutBoardResponse = {
  rollout_id: string;
  origin_cluster_id: string;
  origin_rehearsal_id: string;
  title: string;
  app_id: string;
  app_name: string;
  total: number;
  applied: number;
  in_progress: number;
  pending_probe: number;
  finalized_pending: number;
  attention: number;
  voided: number;
  available_more: number;
  next_pending?: RolloutBoardMember | null;
  members: RolloutBoardMember[];
};

type PropagateResult = {
  rollout_id: string;
  created: {
    cluster_id: string;
    rehearsal_id: string;
    stage: string;
    import_mode: string;
    strict_precheck: boolean;
    downgraded_reason?: string;
  }[];
  skipped: {
    cluster_id: string;
    reason: string;
    existing_rehearsal_id?: string;
  }[];
  board?: RolloutBoardResponse;
};

function memberStatusMeta(m: RolloutBoardMember): {
  label: string;
  cls: string;
  progress?: number;
} {
  switch (m.status_key) {
    case "applied":
      return { label: bi("已生产落地", "Applied"), cls: "is-applied" };
    case "finalized_pending":
      return { label: bi("待确认落地", "Pending Apply"), cls: "is-pending" };
    case "rehearsing": {
      const pct =
        m.steps_total > 0
          ? Math.round((m.steps_done / m.steps_total) * 100)
          : 0;
      return {
        label:
          m.steps_total > 0
            ? bi(`演练中 ${m.steps_done}/${m.steps_total}`, `Executing ${m.steps_done}/${m.steps_total}`)
            : bi("待执行步骤", "Ready to Execute"),
        cls: "is-rehearsing",
        progress: pct,
      };
    }
    case "probing":
      return { label: bi("只读探针 · 待采集", "Awaiting Probe"), cls: "is-probing" };
    case "voided":
      return { label: bi("已作废", "Voided"), cls: "is-voided" };
    default:
      return { label: bi("边界对齐", "Scoping"), cls: "is-probing" };
  }
}

/* ============================================================================
 * 1. RolloutBoardDrawer — Enterprise Multi-Cluster Rollout Console
 * ========================================================================== */

export function RolloutBoardDrawer({
  rolloutId,
  visible,
  currentClusterId,
  initialBoard,
  onClose,
  onAddMore,
}: {
  rolloutId: string;
  visible: boolean;
  currentClusterId?: string;
  initialBoard?: RolloutBoardResponse | null;
  onClose: () => void;
  onAddMore?: (originClusterId: string, originRehearsalId: string) => void;
}) {
  useLang();
  const [board, setBoard] = useState<RolloutBoardResponse | null>(
    initialBoard || null,
  );
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<
    "all" | "pending" | "applied" | "attention"
  >("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (initialBoard && initialBoard.rollout_id === rolloutId) {
      setBoard(initialBoard);
    }
  }, [initialBoard, rolloutId]);

  const load = useCallback(async () => {
    if (!rolloutId) return;
    setLoading(true);
    setErr("");
    try {
      const res = await api<RolloutBoardResponse>(
        `/api/rehearsals/rollout/${encodeURIComponent(rolloutId)}`,
      );
      setBoard(res);
    } catch (e: unknown) {
      setErr((e as Error).message || bi("读取推广看板失败", "Failed to load rollout board"));
    } finally {
      setLoading(false);
    }
  }, [rolloutId]);

  useEffect(() => {
    if (visible && rolloutId) {
      void load();
    }
  }, [visible, rolloutId, load]);

  const pct = useMemo(() => {
    if (!board || board.total <= 0) return 0;
    return Math.round((board.applied / board.total) * 100);
  }, [board]);

  const filtered = useMemo(() => {
    if (!board) return [];
    const q = query.trim().toLowerCase();
    return board.members.filter((m) => {
      if (filter === "pending" && (m.applied || m.voided)) return false;
      if (filter === "applied" && !m.applied) return false;
      if (filter === "attention" && m.conflict_count === 0) return false;
      if (q) {
        const hay = `${m.cluster_id} ${m.scheme_name || ""} ${m.version} ${m.applied_by || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [board, filter, query]);

  const jumpTo = (clusterId: string, rehearsalId: string) => {
    onClose();
    go({
      name: "deliveries",
      id: clusterId,
      tab: "rehearsal",
      rehearsal: rehearsalId,
    });
  };

  return (
    <Drawer
      visible={visible}
      onCancel={onClose}
      width={780}
      footer={null}
      className="ro-drawer"
      title={
        <div className="ro-drawer-head">
          <div className="ro-drawer-title-row">
            <b>{bi("跨集群变更推广看板", "Multi-Cluster Change Rollout")}</b>
            {rolloutId && <code className="ro-id-pill mono">{rolloutId}</code>}
          </div>
          {board && (
            <span className="ro-drawer-sub">
              {bi(
                `方案：《${board.title}》 · 样板集群 `,
                `Plan: "${board.title}" · Pilot `,
              )}
              <code className="mono">{board.origin_cluster_id}</code>
            </span>
          )}
        </div>
      }
    >
      {loading && !board ? (
        <Skeleton animation text={{ rows: 7 }} />
      ) : err && !board ? (
        <div className="ro-err">{err}</div>
      ) : board ? (
        <div className="ro-board">
          {/* Top Progress + 4 Clickable Metric Filters */}
          <div className="ro-kpi-strip">
            <button
              type="button"
              className={`ro-kpi${filter === "all" ? " on" : ""}`}
              onClick={() => setFilter("all")}
            >
              <span className="ro-kpi-lbl">{bi("参与集群", "Total")}</span>
              <b className="num">{board.total}</b>
            </button>
            <button
              type="button"
              className={`ro-kpi is-ok${filter === "applied" ? " on" : ""}`}
              onClick={() => setFilter("applied")}
            >
              <span className="ro-kpi-lbl">{bi("已生产落地", "Applied")}</span>
              <b className="num">{board.applied}</b>
            </button>
            <button
              type="button"
              className={`ro-kpi is-run${filter === "pending" ? " on" : ""}`}
              onClick={() => setFilter("pending")}
            >
              <span className="ro-kpi-lbl">{bi("待推进", "Remaining")}</span>
              <b className="num">{board.in_progress}</b>
            </button>
            <button
              type="button"
              className={`ro-kpi is-warn${filter === "attention" ? " on" : ""}`}
              onClick={() => setFilter("attention")}
            >
              <span className="ro-kpi-lbl">{bi("需关注 / 冲突", "Attention")}</span>
              <b className="num">{board.attention}</b>
            </button>
          </div>

          <div className="ro-prog-row">
            <div className="ro-prog-track" aria-hidden>
              <div className="ro-prog-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="ro-prog-txt num">
              {bi(
                `总进度 ${board.applied}/${board.total}（${pct}%）`,
                `${board.applied}/${board.total} completed (${pct}%)`,
              )}
            </span>
          </div>

          {/* Search & Actions Toolbar */}
          <div className="ro-toolbar">
            <Input
              size="small"
              prefix={<IconSearch />}
              value={query}
              onChange={setQuery}
              allowClear
              placeholder={bi("筛选集群名、架构或版本…", "Filter by cluster, architecture, or version…")}
              className="ro-search"
            />
            <div className="ro-toolbar-acts">
              <Button
                size="small"
                icon={<IconRefresh />}
                loading={loading}
                onClick={() => void load()}
              >
                {bi("刷新", "Refresh")}
              </Button>
              {onAddMore && board.available_more > 0 && (
                <Button
                  size="small"
                  type="primary"
                  icon={<IconShareExternal />}
                  onClick={() => {
                    onClose();
                    onAddMore(board.origin_cluster_id, board.origin_rehearsal_id);
                  }}
                >
                  {bi(
                    `补充推广（还有 ${board.available_more} 套）`,
                    `Propagate More (${board.available_more})`,
                  )}
                </Button>
              )}
            </div>
          </div>

          {/* Clean 5-Column Enterprise Table */}
          <div className="ro-tbl-wrap">
            <table className="ro-tbl">
              <colgroup>
                <col style={{ width: "31%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "21%" }} />
                <col style={{ width: "17%" }} />
                <col style={{ width: "13%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>{bi("集群", "Cluster")}</th>
                  <th>{bi("匹配 / 起点", "Match / Mode")}</th>
                  <th>{bi("当前阶段", "Stage")}</th>
                  <th>{bi("风险 / 落地", "Status")}</th>
                  <th className="ro-col-act">{bi("操作", "Action")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="ro-empty-cell">
                      {bi("当前筛选条件下暂无集群记录", "No clusters match the current filter")}
                    </td>
                  </tr>
                ) : (
                  filtered.map((m) => {
                    const st = memberStatusMeta(m);
                    const isHere = m.cluster_id === currentClusterId;
                    return (
                      <tr
                        key={`${m.cluster_id}-${m.rehearsal_id}`}
                        className={`${isHere ? "is-here" : ""}${m.voided ? " is-voided" : ""}`}
                      >
                        <td>
                          <div className="ro-cell-cl">
                            <b className="mono">{m.cluster_id}</b>
                            {m.is_origin && (
                              <span className="ro-tag is-origin">
                                {bi("样板源", "Pilot")}
                              </span>
                            )}
                            {isHere && (
                              <span className="ro-tag is-here">
                                {bi("当前", "Current")}
                              </span>
                            )}
                          </div>
                          <small className="ro-cell-sub">
                            {m.app_name} {m.version}
                            {m.hosts > 0 ? ` · ${m.hosts} ${bi("节点", "nodes")}` : ""}
                          </small>
                        </td>
                        <td>
                          <div className="ro-match-col">
                            <span
                              className={`ro-match-pill ${m.match_tier === "compatible" ? "is-diff" : "is-same"}`}
                            >
                              {m.match_tier === "origin"
                                ? bi("已验证样板", "Verified Pilot")
                                : m.match_tier === "exact"
                                  ? bi("同架构", "Exact Match")
                                  : bi("架构差异", "Diff Arch")}
                            </span>
                            {!m.is_origin && (
                              <small className="ro-cell-sub">
                                {m.strict_precheck
                                  ? bi("严格预检直达", "Strict Precheck")
                                  : bi("探针引入", "Via Probe")}
                              </small>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="ro-stage-col">
                            <span className={`ro-st-pill ${st.cls}`}>
                              {m.status_key === "applied" && <IconCheck />}
                              {st.label}
                            </span>
                            {typeof st.progress === "number" && m.steps_total > 0 && (
                              <div className="ro-mini-bar" aria-hidden>
                                <div style={{ width: `${st.progress}%` }} />
                              </div>
                            )}
                          </div>
                        </td>
                        <td>
                          {m.conflict_count > 0 ? (
                            <Tooltip mini content={m.conflict_summary}>
                              <span className="ro-risk-warn">
                                <IconExclamationCircle />
                                {bi(`${m.conflict_count} 项冲突`, `${m.conflict_count} conflict`)}
                              </span>
                            </Tooltip>
                          ) : m.applied ? (
                            <span className="ro-cell-sub num">
                              {m.applied_by} · {ago(m.applied_at || m.updated_at)}
                            </span>
                          ) : m.voided ? (
                            <span className="ro-cell-sub">
                              {m.void_reason || bi("已作废", "Voided")}
                            </span>
                          ) : (
                            <span className="ro-cell-sub">
                              {bi("无冲突 · 待处理", "Ready")}
                            </span>
                          )}
                        </td>
                        <td className="ro-col-act">
                          {isHere ? (
                            <span className="ro-here-txt">
                              {bi("当前页", "Here")}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className={`ro-go-btn${!m.applied && !m.voided ? " primary" : ""}`}
                              onClick={() => jumpTo(m.cluster_id, m.rehearsal_id)}
                            >
                              {!m.applied && !m.voided
                                ? bi("去处理", "Work")
                                : bi("查看", "View")}
                              <IconRight />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Sticky Footer with Next-Cluster Pipeline Shortcut */}
          <div className="ro-foot">
            <span className="ro-foot-stat">
              {board.in_progress === 0
                ? bi(
                    `全部 ${board.total} 套集群均已完成生产落地`,
                    `All ${board.total} cluster(s) applied in production`,
                  )
                : bi(
                    `已完成 ${board.applied}/${board.total} 套，剩余 ${board.in_progress} 套待逐一核验落地`,
                    `${board.applied}/${board.total} applied, ${board.in_progress} remaining`,
                  )}
            </span>
            {board.next_pending && (
              <Button
                type="primary"
                size="small"
                onClick={() =>
                  jumpTo(
                    board.next_pending!.cluster_id,
                    board.next_pending!.rehearsal_id,
                  )
                }
              >
                {bi(
                  `下一套待处理：${board.next_pending.cluster_id}`,
                  `Next: ${board.next_pending.cluster_id}`,
                )}{" "}
                <IconRight />
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}

/* ============================================================================
 * 2. RolloutProgressStrip — Compact 1-Line Context Bar on Active Rehearsals
 * ========================================================================== */

export function RolloutProgressStrip({
  rehearsal,
  currentClusterId,
  boardOverride,
  onOpenPropagate,
}: {
  rehearsal: ChangeRehearsal;
  currentClusterId: string;
  boardOverride?: RolloutBoardResponse | null;
  onOpenPropagate?: () => void;
}) {
  useLang();
  const src = rehearsal.source;
  const rolloutId = src?.rollout_id || "";
  const [board, setBoard] = useState<RolloutBoardResponse | null>(
    () => (boardOverride && boardOverride.rollout_id === rolloutId ? boardOverride : null),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (boardOverride && boardOverride.rollout_id === rolloutId) {
      setBoard(boardOverride);
    }
  }, [boardOverride, rolloutId]);

  useEffect(() => {
    if (!rolloutId) {
      setBoard(null);
      return;
    }
    let alive = true;
    api<RolloutBoardResponse>(
      `/api/rehearsals/rollout/${encodeURIComponent(rolloutId)}`,
    )
      .then((res) => {
        if (alive) setBoard(res);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [rolloutId, rehearsal.stage, rehearsal.applied, rehearsal.voided, rehearsal.updated_at]);

  if (!src || !rolloutId) return null;

  const pct =
    board && board.total > 0
      ? Math.round((board.applied / board.total) * 100)
      : 0;
  const nextCluster =
    board?.next_pending && board.next_pending.cluster_id !== currentClusterId
      ? board.next_pending
      : null;

  return (
    <>
      <div className="ro-strip" role="region" aria-label={bi("跨集群推广进度", "Cross-cluster rollout status")}>
        <div className="ro-strip-left">
          {src.is_origin ? (
            <span className="ro-tag is-origin">{bi("样板源", "Pilot")}</span>
          ) : (
            <button
              type="button"
              className="ro-origin-link"
              onClick={() =>
                go({
                  name: "deliveries",
                  id: src.origin_cluster_id,
                  tab: "rehearsal",
                  rehearsal: src.origin_rehearsal_id,
                })
              }
              title={bi("点击查看样板集群方案", "Open origin pilot rehearsal")}
            >
              {bi("引用自", "From")} <code className="mono">{src.origin_cluster_id}</code>
            </button>
          )}
          {!src.is_origin && src.strict_precheck && (
            <span className="ro-mode-badge is-strict">
              {bi("含严格首步预检", "Strict Precheck")}
            </span>
          )}
          {board && (
            <span className="ro-strip-stat num">
              {bi(
                `推广批次 · ${board.applied}/${board.total} 套已落地`,
                `Rollout · ${board.applied}/${board.total} applied`,
              )}
            </span>
          )}
          {board && board.total > 0 && (
            <span className="ro-strip-bar" aria-hidden>
              <i style={{ width: `${pct}%` }} />
            </span>
          )}
          {board && board.attention > 0 && (
            <span className="ro-strip-warn num">
              <IconExclamationCircle />
              {bi(`${board.attention} 套有冲突`, `${board.attention} conflict`)}
            </span>
          )}
        </div>
        <div className="ro-strip-right">
          {nextCluster && (
            <button
              type="button"
              className="ro-strip-btn"
              onClick={() =>
                go({
                  name: "deliveries",
                  id: nextCluster.cluster_id,
                  tab: "rehearsal",
                  rehearsal: nextCluster.rehearsal_id,
                })
              }
            >
              {bi(`下一套：${nextCluster.cluster_id}`, `Next: ${nextCluster.cluster_id}`)}
              <IconRight />
            </button>
          )}
          <button
            type="button"
            className="ro-strip-btn primary"
            onClick={() => setDrawerOpen(true)}
          >
            {board
              ? bi(`推广看板 (${board.total})`, `Rollout Board (${board.total})`)
              : bi("推广看板", "Rollout Board")}
          </button>
        </div>
      </div>

      <RolloutBoardDrawer
        rolloutId={rolloutId}
        visible={drawerOpen}
        currentClusterId={currentClusterId}
        initialBoard={board}
        onClose={() => setDrawerOpen(false)}
        onAddMore={
          src.is_origin && rehearsal.applied && !rehearsal.voided && onOpenPropagate
            ? () => onOpenPropagate()
            : undefined
        }
      />
    </>
  );
}

/* ============================================================================
 * 3. PropagateRehearsalModal — Entry A (1-to-N Push from Production-Applied Pilot)
 * ========================================================================== */

export function PropagateRehearsalModal({
  clusterId,
  rehearsal,
  visible,
  onClose,
  onPropagated,
}: {
  clusterId: string;
  rehearsal: ChangeRehearsal;
  visible: boolean;
  onClose: () => void;
  onPropagated: (res: PropagateResult) => void;
}) {
  useLang();
  const [data, setData] = useState<PropagateTargetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"probe" | "steps">("probe");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setErr("");
    setQuery("");
    api<PropagateTargetsResponse>(
      `/api/clusters/${encodeURIComponent(clusterId)}/rehearsals/${encodeURIComponent(rehearsal.id)}/propagate-targets`,
    )
      .then((res) => {
        setData(res);
        setMode(res.default_mode || "probe");
        const init: Record<string, boolean> = {};
        for (const t of res.targets) {
          if (
            !t.already_imported &&
            !t.already_effective &&
            t.match_tier === "exact" &&
            t.deployed &&
            (!t.conflict_keys || t.conflict_keys.length === 0)
          ) {
            init[t.cluster_id] = true;
          }
        }
        setPicked(init);
      })
      .catch((e: unknown) => {
        setErr((e as Error).message || bi("读取候选集群失败", "Failed to load target clusters"));
      })
      .finally(() => setLoading(false));
  }, [visible, clusterId, rehearsal.id]);

  const targets = data?.targets || [];
  const filteredTargets = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) =>
      `${t.cluster_id} ${t.scheme_name || ""} ${t.version} ${t.match_reason}`
        .toLowerCase()
        .includes(q),
    );
  }, [targets, query]);

  const exactReady = filteredTargets.filter(
    (t) => !t.already_imported && t.match_tier === "exact",
  );
  const diffReady = filteredTargets.filter(
    (t) => !t.already_imported && t.match_tier !== "exact",
  );
  const importedList = filteredTargets.filter((t) => t.already_imported);

  const pickedIds = Object.entries(picked)
    .filter(([, v]) => v)
    .map(([k]) => k);

  const selectAllExact = () => {
    const next = { ...picked };
    for (const t of targets) {
      if (!t.already_imported && !t.already_effective && t.match_tier === "exact") {
        next[t.cluster_id] = true;
      }
    }
    setPicked(next);
  };

  const clearAll = () => setPicked({});

  const submit = async () => {
    if (pickedIds.length === 0) return;
    setSubmitting(true);
    setErr("");
    try {
      const res = await api<PropagateResult>(
        `/api/clusters/${encodeURIComponent(clusterId)}/rehearsals/${encodeURIComponent(rehearsal.id)}/propagate`,
        {
          method: "POST",
          body: JSON.stringify({
            target_clusters: pickedIds,
            mode,
          }),
        },
      );
      const downgradedCount = (res.created || []).filter(
        (c) => Boolean(c.downgraded_reason),
      ).length;
      Message.success(
        downgradedCount > 0
          ? bi(
              `已同步至 ${res.created.length} 套集群（其中 ${downgradedCount} 套因差异/冲突已自动保留只读探针）`,
              `Propagated to ${res.created.length} cluster(s) (${downgradedCount} kept read-only probe for safety)`,
            )
          : bi(
              `已成功同步至 ${res.created.length} 套集群，可直接在推广看板逐一推进`,
              `Propagated to ${res.created.length} cluster(s)`,
            ),
      );
      onPropagated(res);
      onClose();
    } catch (e: unknown) {
      setErr((e as Error).message || bi("推广失败", "Propagation failed"));
    } finally {
      setSubmitting(false);
    }
  };

  const renderTargetRow = (t: PropagateTargetItem) => {
    const checked = Boolean(picked[t.cluster_id]);
    const willDowngrade = mode === "steps" && !t.allow_skip_probe && !t.already_imported;
    return (
      <div
        key={t.cluster_id}
        className={`ro-pick-row${t.already_imported ? " is-done" : ""}${checked ? " is-checked" : ""}`}
        onClick={() => {
          if (t.already_imported) return;
          setPicked((prev) => ({ ...prev, [t.cluster_id]: !prev[t.cluster_id] }));
        }}
      >
        <div
          className="ro-pick-chk"
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            disabled={t.already_imported}
            checked={t.already_imported ? true : checked}
            onChange={(v) =>
              setPicked((prev) => ({ ...prev, [t.cluster_id]: Boolean(v) }))
            }
          />
        </div>
        <div className="ro-pick-main">
          <div className="ro-pick-top">
            <b className="mono">{t.cluster_id}</b>
            <span className="ro-pick-ver mono">
              {t.app_name} {t.version}
            </span>
            {t.scheme_name && (
              <span className="ro-pick-scheme">{t.scheme_name}</span>
            )}
            {t.hosts > 0 && (
              <span className="ro-pick-hosts num">
                {t.hosts} {bi("节点", "nodes")}
              </span>
            )}
          </div>
          <div className="ro-pick-sub">
            <span>{t.match_reason}</span>
            {t.conflict_summary && (
              <span className="ro-pick-warn">
                <IconExclamationCircle /> {t.conflict_summary}
              </span>
            )}
            {t.already_effective && !t.already_imported && (
              <span className="ro-pick-warn">
                {bi("目标集群似乎已生效相同配置", "Identical config already effective")}
              </span>
            )}
            {willDowngrade && (
              <span className="ro-pick-note">
                {bi("→ 安全护栏：将自动以只读探针引入", "→ Safety guard: will import via probe")}
              </span>
            )}
          </div>
        </div>
        <div className="ro-pick-right" onClick={(e) => e.stopPropagation()}>
          {t.already_imported ? (
            <button
              type="button"
              className="ro-go-btn"
              onClick={() => {
                onClose();
                go({
                  name: "deliveries",
                  id: t.cluster_id,
                  tab: "rehearsal",
                  rehearsal: t.existing_rehearsal_id,
                });
              }}
            >
              {t.existing_applied
                ? bi("已落地 · 查看", "Applied · View")
                : bi("已引入 · 查看", "Imported · View")}
              <IconRight />
            </button>
          ) : (
            <span
              className={`ro-match-pill ${t.match_tier === "exact" ? "is-same" : "is-diff"}`}
            >
              {t.match_tier === "exact"
                ? bi("同架构", "Exact")
                : bi("有差异", "Diff")}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <Modal
      visible={visible}
      onCancel={onClose}
      title={bi("推广已落地变更到其他同组件集群", "Propagate Applied Change to Other Clusters")}
      style={{ width: "min(720px, 94vw)" }}
      footer={
        <div className="ro-modal-foot">
          <span className="ro-modal-foot-hint">
            {pickedIds.length > 0
              ? bi(
                  `已选择 ${pickedIds.length} 套集群（均独立核验留痕，不复制样板集群 IP 与状态）`,
                  `${pickedIds.length} cluster(s) selected (independent verification, zero IP leakage)`,
                )
              : bi("勾选下方候选集群即可批量引入", "Select target clusters below")}
          </span>
          <div className="ro-modal-foot-btns">
            <Button onClick={onClose} disabled={submitting}>
              {bi("取消", "Cancel")}
            </Button>
            <Button
              type="primary"
              disabled={pickedIds.length === 0 || submitting}
              loading={submitting}
              onClick={() => void submit()}
            >
              {bi(
                `批量同步至 ${pickedIds.length} 套集群`,
                `Propagate to ${pickedIds.length} Cluster(s)`,
              )}
            </Button>
          </div>
        </div>
      }
    >
      <div className="ro-modal-body">
        {/* Pilot Identity Header */}
        <div className="ro-origin-card">
          <div className="ro-origin-card-top">
            <span className="ro-st-pill is-applied">
              <IconCheck /> {bi("已确认生产落地样板", "Production-Applied Pilot")}
            </span>
            <code className="mono">{clusterId}</code>
            {data?.origin.changed_keys && data.origin.changed_keys.length > 0 && (
              <span className="ro-origin-cnt num">
                {bi(
                  `${data.origin.changed_keys.length} 项生效变更`,
                  `${data.origin.changed_keys.length} effective change(s)`,
                )}
              </span>
            )}
          </div>
          <b>{rehearsal.title}</b>
        </div>

        {/* Mode Selector (Scheme A: Probe Default vs Strict-Precheck Direct Steps) */}
        <div className="ro-mode-grid" role="radiogroup" aria-label={bi("目标集群引入起点", "Import starting stage")}>
          <button
            type="button"
            className={`ro-mode-card${mode === "probe" ? " on" : ""}`}
            onClick={() => setMode("probe")}
          >
            <div className="ro-mode-card-h">
              <span className="ro-radio" aria-hidden />
              <b>{bi("标准引入：直达只读探针", "Standard: Start at Read-Only Probe")}</b>
              <em className="ro-rec">{bi("推荐", "Recommended")}</em>
            </div>
            <p>
              {bi(
                "跳过重复边界问答，自动重映射探针地址；1 屏探针核实主从、版本与磁盘后，强参考样板蓝图生成贴合本集群的步骤。",
                "Skips scoping Q&A and remaps the 1-screen read-only probe; generates steps from the pilot blueprint after verifying live topology.",
              )}
            </p>
          </button>
          <button
            type="button"
            className={`ro-mode-card${mode === "steps" ? " on" : ""}`}
            onClick={() => setMode("steps")}
          >
            <div className="ro-mode-card-h">
              <span className="ro-radio" aria-hidden />
              <b>{bi("极速直达：待执行清单（严格预检）", "Fast Track: Direct Steps + Strict Precheck")}</b>
            </div>
            <p>
              {bi(
                "仅对同架构且无冲突的已部署集群直接映射可执行步骤，并自动强化第 1 步为强制阻断预检（版本/主从/参数现值/磁盘/无 Pending Restart）；其余集群自动降级为只读探针。",
                "Directly maps steps for exact-match conflict-free clusters with a mandatory strict Step 1 precheck gate; others safely fall back to probe.",
              )}
            </p>
          </button>
        </div>

        {err && <div className="ro-err">{err}</div>}

        {loading ? (
          <Skeleton animation text={{ rows: 5 }} />
        ) : targets.length === 0 ? (
          <div className="ro-empty-box">
            {bi(
              `当前平台没有其他同组件（${rehearsal.app_name}）集群可推广。`,
              `No other ${rehearsal.app_name} clusters found to propagate to.`,
            )}
          </div>
        ) : (
          <>
            <div className="ro-pick-bar">
              <Input
                size="small"
                prefix={<IconSearch />}
                value={query}
                onChange={setQuery}
                allowClear
                placeholder={bi("搜索候选集群…", "Search candidate clusters…")}
                className="ro-search"
              />
              <div className="ro-pick-bar-acts">
                <button
                  type="button"
                  className="link small"
                  onClick={selectAllExact}
                >
                  {bi("全选同架构可用", "Select Exact Matches")}
                </button>
                {pickedIds.length > 0 && (
                  <button
                    type="button"
                    className="link small"
                    onClick={clearAll}
                  >
                    {bi("清空", "Clear")}
                  </button>
                )}
              </div>
            </div>

            <div className="ro-pick-list">
              {exactReady.length > 0 && (
                <div className="ro-pick-group">
                  <div className="ro-pick-group-h">
                    {bi(`同架构推荐（${exactReady.length}）`, `Exact Architecture Match (${exactReady.length})`)}
                  </div>
                  {exactReady.map(renderTargetRow)}
                </div>
              )}
              {diffReady.length > 0 && (
                <div className="ro-pick-group">
                  <div className="ro-pick-group-h">
                    {bi(
                      `版本或架构有差异 · 将通过只读探针适配（${diffReady.length}）`,
                      `Architecture / Version Diff · Probe Required (${diffReady.length})`,
                    )}
                  </div>
                  {diffReady.map(renderTargetRow)}
                </div>
              )}
              {importedList.length > 0 && (
                <div className="ro-pick-group">
                  <div className="ro-pick-group-h">
                    {bi(`已同步至推广批次（${importedList.length}）`, `Already in Rollout (${importedList.length})`)}
                  </div>
                  {importedList.map(renderTargetRow)}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ============================================================================
 * 4. ImportTemplateBar — Entry B (Pull into Target Cluster from Applied Pilot)
 * ========================================================================== */

export function ImportTemplateBar({
  cluster,
  onImported,
}: {
  cluster: ClusterView;
  onImported: (rehearsalId: string) => void;
}) {
  useLang();
  const [templates, setTemplates] = useState<RehearsalTemplateItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState("");
  const [mode, setMode] = useState<"probe" | "steps">("probe");
  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const loadTemplates = useCallback(() => {
    api<RehearsalTemplateItem[]>(
      `/api/rehearsals/templates?app_id=${encodeURIComponent(cluster.app_id)}&target_cluster=${encodeURIComponent(cluster.id)}`,
    )
      .then((list) => setTemplates(list || []))
      .catch(() => setTemplates([]));
  }, [cluster.app_id, cluster.id]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const unimportedCount = useMemo(
    () => (templates || []).filter((t) => !t.already_imported).length,
    [templates],
  );

  const filtered = useMemo(() => {
    const list = templates || [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((t) =>
      `${t.title} ${t.origin_cluster_id} ${t.applied_summary || ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [templates, query]);

  const chosen = useMemo(
    () =>
      (templates || []).find(
        (t) => `${t.origin_cluster_id}/${t.origin_rehearsal_id}` === selectedKey,
      ) || null,
    [templates, selectedKey],
  );

  useEffect(() => {
    if (!chosen) return;
    if (chosen.mode === "quick" && chosen.allow_skip_probe) {
      setMode("steps");
    } else {
      setMode("probe");
    }
  }, [chosen]);

  if (!templates || templates.length === 0) return null;

  const submitImport = async () => {
    if (!chosen) return;
    setSubmitting(true);
    setErr("");
    try {
      const res = await api<PropagateResult>(
        `/api/clusters/${encodeURIComponent(chosen.origin_cluster_id)}/rehearsals/${encodeURIComponent(chosen.origin_rehearsal_id)}/propagate`,
        {
          method: "POST",
          body: JSON.stringify({
            target_clusters: [cluster.id],
            mode: chosen.allow_skip_probe ? mode : "probe",
          }),
        },
      );
      const created = res.created?.[0];
      if (created?.rehearsal_id) {
        Message.success(
          bi(
            `已引入样板变更《${chosen.title}》到当前集群`,
            `Imported "${chosen.title}" into ${cluster.id}`,
          ),
        );
        setOpen(false);
        onImported(created.rehearsal_id);
      } else if (res.skipped?.[0]?.existing_rehearsal_id) {
        setOpen(false);
        onImported(res.skipped[0].existing_rehearsal_id);
      } else {
        setErr(
          res.skipped?.[0]?.reason || bi("未能引入该变更", "Unable to import this change"),
        );
      }
    } catch (e: unknown) {
      setErr((e as Error).message || bi("引入变更失败", "Failed to import change"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="ro-import-bar">
        <div className="ro-import-bar-left">
          <IconImport className="ro-import-ic" />
          <span>
            {bi(
              `发现 ${templates.length} 项同组件（${cluster.app_name}）其他集群已生产落地的变更方案`,
              `${templates.length} production-applied ${cluster.app_name} change(s) available from other clusters`,
            )}
            {unimportedCount > 0 && (
              <small>
                {bi(
                  " · 无需重填诉求，一键引入并自动映射本集群基线",
                  " · Import directly with automatic baseline remapping",
                )}
              </small>
            )}
          </span>
        </div>
        <button
          type="button"
          className="ro-strip-btn primary"
          onClick={() => {
            setErr("");
            setQuery("");
            const firstAvail =
              templates.find((t) => !t.already_imported) || templates[0];
            if (firstAvail) {
              setSelectedKey(
                `${firstAvail.origin_cluster_id}/${firstAvail.origin_rehearsal_id}`,
              );
            }
            setOpen(true);
          }}
        >
          {bi("从已有变更引入", "Import Applied Change")}
          <IconRight />
        </button>
      </div>

      <Modal
        visible={open}
        onCancel={() => setOpen(false)}
        title={bi(
          `引入已落地变更到 ${cluster.id}`,
          `Import Applied Change into ${cluster.id}`,
        )}
        style={{ width: "min(700px, 94vw)" }}
        footer={
          <div className="ro-modal-foot">
            <span className="ro-modal-foot-hint">
              {bi(
                "仅展示其他集群已确认「生产已实施完成」的变更方案",
                "Only production-applied changes from other clusters are eligible",
              )}
            </span>
            <div className="ro-modal-foot-btns">
              <Button onClick={() => setOpen(false)} disabled={submitting}>
                {bi("取消", "Cancel")}
              </Button>
              <Button
                type="primary"
                disabled={!chosen || chosen.already_imported || submitting}
                loading={submitting}
                onClick={() => void submitImport()}
              >
                {bi("引入到当前集群", "Import to This Cluster")}
              </Button>
            </div>
          </div>
        }
      >
        <div className="ro-modal-body">
          <Input
            size="small"
            prefix={<IconSearch />}
            value={query}
            onChange={setQuery}
            allowClear
            placeholder={bi("搜索变更标题或样板集群…", "Search change title or pilot cluster…")}
          />

          <div className="ro-tpl-list">
            {filtered.map((t) => {
              const key = `${t.origin_cluster_id}/${t.origin_rehearsal_id}`;
              const active = key === selectedKey;
              return (
                <div
                  key={key}
                  className={`ro-tpl-card${active ? " on" : ""}${t.already_imported ? " is-done" : ""}`}
                  onClick={() => setSelectedKey(key)}
                >
                  <div className="ro-tpl-top">
                    <span className="ro-radio" aria-hidden />
                    <b>{t.title}</b>
                    {t.already_imported ? (
                      <button
                        type="button"
                        className="ro-go-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(false);
                          if (t.existing_rehearsal_id) {
                            onImported(t.existing_rehearsal_id);
                          }
                        }}
                      >
                        {bi("本集群已引入 · 打开", "Already Imported · Open")}
                        <IconRight />
                      </button>
                    ) : (
                      <span
                        className={`ro-match-pill ${t.match_tier === "exact" ? "is-same" : "is-diff"}`}
                      >
                        {t.match_tier === "exact"
                          ? bi("同架构", "Exact")
                          : bi("有差异", "Diff")}
                      </span>
                    )}
                  </div>
                  <div className="ro-tpl-meta num">
                    <span>
                      {bi("样板集群", "Pilot")}:{" "}
                      <code className="mono">{t.origin_cluster_id}</code>
                    </span>
                    <span>
                      {t.applied_by} · {ago(t.applied_at || "")}
                    </span>
                    {t.rollout_total && t.rollout_total > 1 ? (
                      <span className="ro-tpl-batch">
                        {bi(
                          `推广批次 ${t.rollout_applied}/${t.rollout_total} 已落地`,
                          `Rollout ${t.rollout_applied}/${t.rollout_total} applied`,
                        )}
                      </span>
                    ) : null}
                    {t.applied_changes && t.applied_changes.length > 0 && (
                      <span>
                        {bi(
                          `${t.applied_changes.length} 项生效参数`,
                          `${t.applied_changes.length} param(s)`,
                        )}
                      </span>
                    )}
                  </div>
                  {t.conflict_summary && (
                    <div className="ro-pick-warn">
                      <IconExclamationCircle /> {t.conflict_summary}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {chosen && !chosen.already_imported && (
            <div className="ro-mode-grid">
              <button
                type="button"
                className={`ro-mode-card${mode === "probe" ? " on" : ""}`}
                onClick={() => setMode("probe")}
              >
                <div className="ro-mode-card-h">
                  <span className="ro-radio" aria-hidden />
                  <b>{bi("标准引入：直达只读探针", "Standard: Read-Only Probe")}</b>
                  <em className="ro-rec">{bi("推荐", "Recommended")}</em>
                </div>
                <p>
                  {bi(
                    "跳过边界问答，先在本集群跑 1 屏探针核实拓扑与磁盘，再按样板蓝图映射步骤。",
                    "Skips Q&A; run a 1-screen probe on this cluster first, then map pilot blueprint.",
                  )}
                </p>
              </button>
              <button
                type="button"
                className={`ro-mode-card${mode === "steps" ? " on" : ""}${!chosen.allow_skip_probe ? " is-disabled" : ""}`}
                disabled={!chosen.allow_skip_probe}
                onClick={() => chosen.allow_skip_probe && setMode("steps")}
              >
                <div className="ro-mode-card-h">
                  <span className="ro-radio" aria-hidden />
                  <b>{bi("极速直达：严格预检 + 待执行清单", "Fast Track: Strict Precheck + Steps")}</b>
                </div>
                <p>
                  {chosen.allow_skip_probe
                    ? bi(
                        "架构与版本一致且无参数冲突，直接映射待执行清单并自动强化第 1 步为强制阻断预检。",
                        "Exact match & conflict-free: maps steps directly with a mandatory strict Step 1 precheck gate.",
                      )
                    : chosen.skip_probe_block_reason ||
                      bi("当前集群不满足跳过探针条件，请使用标准引入。", "Read-only probe required for this cluster.")}
                </p>
              </button>
            </div>
          )}

          {err && <div className="ro-err">{err}</div>}
        </div>
      </Modal>
    </>
  );
}

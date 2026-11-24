import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Message,
  Modal,
  Select,
  Skeleton,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconBranch,
  IconCheck,
  IconDown,
  IconExclamationCircle,
  IconImport,
  IconRefresh,
  IconRight,
  IconSearch,
  IconShareExternal,
  IconUp,
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

export type RehearsalTemplateVariant = {
  cluster_id: string;
  rehearsal_id: string;
  rollout_id?: string;
  title: string;
  version?: string;
  scheme_name?: string;
  hosts?: number;
  applied_at?: string;
  applied_by?: string;
  match_tier?: "exact" | "compatible";
  allow_skip_probe: boolean;
  skip_probe_block_reason?: string;
  is_origin?: boolean;
  steps_count: number;
};

export type RehearsalTemplateItem = {
  origin_cluster_id: string;
  origin_rehearsal_id: string;
  rollout_id?: string;
  title: string;
  goal: string;
  mode: string;
  category?: string;
  category_label?: string;
  content_signature?: string;
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
  verified_clusters?: string[];
  merged_count?: number;
  variants?: RehearsalTemplateVariant[];
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
    <Modal
      visible={visible}
      onCancel={onClose}
      alignCenter
      focusLock={false}
      autoFocus={false}
      footer={null}
      className="ro-board-modal"
      style={{ width: "min(940px, 94vw)", transformOrigin: "center center" }}
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
                <col style={{ width: "32%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "19%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "15%" }} />
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
    </Modal>
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
  const allApplied = Boolean(board && board.total > 0 && board.applied === board.total);
  const nextCluster =
    board?.next_pending && board.next_pending.cluster_id !== currentClusterId
      ? board.next_pending
      : null;
  const previewMembers = board?.members ? board.members.slice(0, 2) : [];
  const extraMembers = board?.members ? Math.max(0, board.members.length - previewMembers.length) : 0;

  return (
    <>
      <div
        className={`ro-strip${allApplied ? " is-done" : ""}`}
        role="region"
        aria-label={bi("跨集群推广进度", "Cross-cluster rollout status")}
      >
        <div className="ro-strip-left">
          {src.is_origin ? (
            <span className="ro-tag is-origin">{bi("样板源", "Pilot")}</span>
          ) : previewMembers.some((m) => m.cluster_id === src.origin_cluster_id) ? (
            <span className="ro-tag">{bi("跨集群推广", "Rollout")}</span>
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
          {previewMembers.length > 0 && (
            <div className="ro-strip-members" aria-label={bi("参与集群", "Participating clusters")}>
              {previewMembers.map((m) => {
                const isHere = m.cluster_id === currentClusterId;
                const isOriginChip = !src.is_origin && m.cluster_id === src.origin_cluster_id;
                const dotCls = m.applied
                  ? "is-ok"
                  : m.conflict_count > 0
                    ? "is-warn"
                    : m.voided
                      ? "is-void"
                      : "is-run";
                const inner = (
                  <>
                    <i className={`ro-strip-dot ${dotCls}`} aria-hidden />
                    <code className="mono">{m.cluster_id}</code>
                    {isOriginChip && (
                      <em className="ro-chip-role">{bi("样板", "Pilot")}</em>
                    )}
                  </>
                );
                return isHere ? (
                  <span
                    key={`${m.cluster_id}-${m.rehearsal_id}`}
                    className="ro-strip-chip is-here"
                    title={bi("当前集群", "Current cluster")}
                  >
                    {inner}
                  </span>
                ) : (
                  <button
                    key={`${m.cluster_id}-${m.rehearsal_id}`}
                    type="button"
                    className="ro-strip-chip is-link"
                    onClick={() =>
                      go({
                        name: "deliveries",
                        id: m.cluster_id,
                        tab: "rehearsal",
                        rehearsal: m.rehearsal_id,
                      })
                    }
                    title={bi(`切换到 ${m.cluster_id}`, `Open ${m.cluster_id}`)}
                  >
                    {inner}
                  </button>
                );
              })}
              {extraMembers > 0 && (
                <button
                  type="button"
                  className="ro-strip-chip is-more num"
                  onClick={() => setDrawerOpen(true)}
                  title={bi("查看全部推广集群", "View all rollout clusters")}
                >
                  +{extraMembers}
                </button>
              )}
            </div>
          )}
        </div>

        {board && board.total > 0 && (
          <div className="ro-strip-prog">
            <span className="ro-strip-bar" aria-hidden>
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="ro-strip-stat num">
              {bi(
                `${board.applied}/${board.total} 套已落地 · ${pct}%`,
                `${board.applied}/${board.total} applied · ${pct}%`,
              )}
            </span>
            {board.attention > 0 && (
              <span className="ro-strip-warn num">
                <IconExclamationCircle />
                {bi(`${board.attention} 套有冲突`, `${board.attention} conflict`)}
              </span>
            )}
          </div>
        )}

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
  const lang = useLang();
  const [data, setData] = useState<PropagateTargetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"probe" | "steps">("probe");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [targetFilter, setTargetFilter] = useState<"all" | "ready" | "exact" | "done">("all");

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setErr("");
    setQuery("");
    setTargetFilter("all");
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
  }, [visible, clusterId, rehearsal.id, lang]);

  const targets = data?.targets || [];
  const targetCounts = useMemo(() => {
    let ready = 0;
    let exact = 0;
    let done = 0;
    for (const t of targets) {
      if (t.already_imported || t.already_effective) done++;
      else ready++;
      if (!t.already_imported && !t.already_effective && t.match_tier === "exact") exact++;
    }
    return { all: targets.length, ready, exact, done };
  }, [targets]);

  const filteredTargets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return targets.filter((t) => {
      if (targetFilter === "ready" && (t.already_imported || t.already_effective)) return false;
      if (targetFilter === "exact" && (t.already_imported || t.already_effective || t.match_tier !== "exact")) return false;
      if (targetFilter === "done" && !t.already_imported && !t.already_effective) return false;
      if (!q) return true;
      return `${t.cluster_id} ${t.scheme_name || ""} ${t.version} ${t.match_reason}`
        .toLowerCase()
        .includes(q);
    });
  }, [targets, query, targetFilter]);

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
        <div className="ro-pick-right">
          {t.already_imported ? (
            <button
              type="button"
              className="ro-go-btn"
              onClick={(e) => {
                e.stopPropagation();
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
          ) : t.already_effective && t.existing_rehearsal_id ? (
            <button
              type="button"
              className="ro-go-btn is-eff"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
                go({
                  name: "deliveries",
                  id: t.cluster_id,
                  tab: "rehearsal",
                  rehearsal: t.existing_rehearsal_id,
                });
              }}
            >
              {bi("已独立生效 · 查看", "Already Effective · View")}
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
      focusLock={false}
      autoFocus={false}
      title={bi("推广已落地变更到其他同组件集群", "Propagate Applied Change to Other Clusters")}
      style={{ width: "min(720px, 94vw)", transformOrigin: "center center" }}
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

            <div className="ro-chip-row">
              {(
                [
                  ["all", bi("全部", "All"), targetCounts.all],
                  ["ready", bi("待推广", "Available"), targetCounts.ready],
                  ["exact", bi("仅同架构", "Exact Match"), targetCounts.exact],
                  ["done", bi("已引入/已生效", "Imported / Effective"), targetCounts.done],
                ] as const
              ).map(([k, lbl, cnt]) => (
                <button
                  key={k}
                  type="button"
                  className={`ro-filter-chip${targetFilter === k ? " on" : ""}`}
                  onClick={() => setTargetFilter(k)}
                >
                  <span>{lbl}</span>
                  <em className="num">{cnt}</em>
                </button>
              ))}
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

const CATEGORY_ORDER = [
  "logging",
  "security",
  "backup",
  "params",
  "ha",
  "upgrade",
  "ops",
] as const;

function modeLabel(m: string): string {
  switch (m) {
    case "quick":
      return bi("极速变更", "Quick");
    case "light":
      return bi("简单推演", "Light");
    default:
      return bi("全量推演", "Full");
  }
}

function truncVal(s: string, max = 36): string {
  const t = (s || "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function ImportTemplateBar({
  cluster,
  onImported,
}: {
  cluster: ClusterView;
  onImported: (rehearsalId: string) => void;
}) {
  const lang = useLang();
  const [templates, setTemplates] = useState<RehearsalTemplateItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState("");
  const [pilotOverrides, setPilotOverrides] = useState<Record<string, string>>({});
  const [expandedVariants, setExpandedVariants] = useState<Record<string, boolean>>({});
  const [expandedParams, setExpandedParams] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<"probe" | "steps">("probe");
  const [query, setQuery] = useState("");
  const [catFilter, setCatFilter] = useState<string>("all");
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [onlyExact, setOnlyExact] = useState(false);
  const [onlyFastTrack, setOnlyFastTrack] = useState(false);
  const [clusterFilter, setClusterFilter] = useState<string>("");
  const [modeFilter, setModeFilter] = useState<string>("");
  const [sortBy, setSortBy] = useState<"recommended" | "recent" | "clusters">("recommended");
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
  }, [loadTemplates, lang]);

  const templateKeyOf = (t: RehearsalTemplateItem) =>
    `${t.origin_cluster_id}/${t.origin_rehearsal_id}`;

  const activeVariantOf = useCallback(
    (t: RehearsalTemplateItem): RehearsalTemplateVariant | null => {
      const vs = t.variants || [];
      if (vs.length === 0) return null;
      const ov = pilotOverrides[templateKeyOf(t)];
      if (ov) {
        const hit = vs.find((v) => `${v.cluster_id}/${v.rehearsal_id}` === ov);
        if (hit) return hit;
      }
      return vs[0];
    },
    [pilotOverrides],
  );

  const stats = useMemo(() => {
    const list = templates || [];
    let available = 0;
    let exact = 0;
    let fastTrack = 0;
    let totalRuns = 0;
    const clusters = new Set<string>();
    const modes = new Set<string>();
    const cats = new Map<string, { id: string; label: string; count: number }>();

    for (const t of list) {
      const isAvail = !t.already_imported && !t.already_effective;
      if (isAvail) available++;
      if (t.match_tier === "exact") exact++;
      if (t.allow_skip_probe && isAvail) fastTrack++;
      totalRuns += Math.max(1, t.merged_count || t.variants?.length || 1);
      if (t.verified_clusters && t.verified_clusters.length > 0) {
        for (const c of t.verified_clusters) clusters.add(c);
      } else {
        clusters.add(t.origin_cluster_id);
      }
      if (t.mode) modes.add(t.mode);
      const cid = t.category || "ops";
      const prev = cats.get(cid);
      if (prev) prev.count++;
      else
        cats.set(cid, {
          id: cid,
          label: t.category_label || cid,
          count: 1,
        });
    }

    const catList = Array.from(cats.values()).sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a.id as (typeof CATEGORY_ORDER)[number]);
      const ib = CATEGORY_ORDER.indexOf(b.id as (typeof CATEGORY_ORDER)[number]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    return {
      total: list.length,
      available,
      exact,
      fastTrack,
      totalRuns,
      clusterList: Array.from(clusters).sort(),
      modeList: Array.from(modes),
      catList,
    };
  }, [templates]);

  const hasActiveFilters =
    Boolean(query.trim()) ||
    catFilter !== "all" ||
    onlyAvailable ||
    onlyExact ||
    onlyFastTrack ||
    Boolean(clusterFilter) ||
    Boolean(modeFilter);

  const resetFilters = () => {
    setQuery("");
    setCatFilter("all");
    setOnlyAvailable(false);
    setOnlyExact(false);
    setOnlyFastTrack(false);
    setClusterFilter("");
    setModeFilter("");
  };

  const filtered = useMemo(() => {
    const list = templates || [];
    const q = query.trim().toLowerCase();
    const matched = list.filter((t) => {
      if (catFilter !== "all" && (t.category || "ops") !== catFilter) return false;
      if (onlyAvailable && (t.already_imported || t.already_effective)) return false;
      if (onlyExact && t.match_tier !== "exact") return false;
      if (onlyFastTrack && (!t.allow_skip_probe || t.already_imported || t.already_effective)) {
        return false;
      }
      if (clusterFilter) {
        const hasCluster =
          t.origin_cluster_id === clusterFilter ||
          (t.verified_clusters || []).includes(clusterFilter) ||
          (t.variants || []).some((v) => v.cluster_id === clusterFilter);
        if (!hasCluster) return false;
      }
      if (modeFilter && (t.mode || "full") !== modeFilter) return false;
      if (!q) return true;
      const changeText = (t.applied_changes || [])
        .map((c) => `${c.key}=${c.after} ${c.key}`)
        .join(" ");
      const variantText = (t.variants || [])
        .map((v) => `${v.title} ${v.cluster_id} ${v.applied_by || ""}`)
        .join(" ");
      const hay = `${t.title} ${t.origin_cluster_id} ${t.applied_by || ""} ${t.applied_summary || ""} ${t.category_label || ""} ${changeText} ${variantText}`.toLowerCase();
      return hay.includes(q);
    });

    if (sortBy === "recommended") return matched;
    return [...matched].sort((a, b) => {
      if (sortBy === "recent") {
        const aMax = (a.variants || []).reduce(
          (best, v) => ((v.applied_at || "") > best ? v.applied_at || "" : best),
          a.applied_at || "",
        );
        const bMax = (b.variants || []).reduce(
          (best, v) => ((v.applied_at || "") > best ? v.applied_at || "" : best),
          b.applied_at || "",
        );
        return bMax.localeCompare(aMax);
      }
      const ac = a.verified_clusters?.length || 1;
      const bc = b.verified_clusters?.length || 1;
      if (ac !== bc) return bc - ac;
      return (b.applied_at || "").localeCompare(a.applied_at || "");
    });
  }, [
    templates,
    query,
    catFilter,
    onlyAvailable,
    onlyExact,
    onlyFastTrack,
    clusterFilter,
    modeFilter,
    sortBy,
  ]);

  const chosen = useMemo(
    () =>
      (templates || []).find((t) => templateKeyOf(t) === selectedKey) || null,
    [templates, selectedKey],
  );

  const chosenPilot = useMemo(() => {
    if (!chosen) return null;
    const v = activeVariantOf(chosen);
    return {
      clusterId: v?.cluster_id || chosen.origin_cluster_id,
      rehearsalId: v?.rehearsal_id || chosen.origin_rehearsal_id,
      title: v?.title || chosen.title,
      allowSkipProbe:
        chosen.already_effective || chosen.already_imported
          ? false
          : v
            ? v.allow_skip_probe
            : chosen.allow_skip_probe,
      skipProbeBlockReason:
        v?.skip_probe_block_reason || chosen.skip_probe_block_reason,
    };
  }, [chosen, activeVariantOf]);

  useEffect(() => {
    if (!chosen || !chosenPilot) return;
    if (chosen.mode === "quick" && chosenPilot.allowSkipProbe) {
      setMode("steps");
    } else {
      setMode("probe");
    }
  }, [chosen, chosenPilot]);

  if (!templates || templates.length === 0) return null;

  const submitImport = async () => {
    if (!chosen || !chosenPilot) return;
    setSubmitting(true);
    setErr("");
    try {
      const res = await api<PropagateResult>(
        `/api/clusters/${encodeURIComponent(chosenPilot.clusterId)}/rehearsals/${encodeURIComponent(chosenPilot.rehearsalId)}/propagate`,
        {
          method: "POST",
          body: JSON.stringify({
            target_clusters: [cluster.id],
            mode: chosenPilot.allowSkipProbe ? mode : "probe",
          }),
        },
      );
      const created = res.created?.[0];
      if (created?.rehearsal_id) {
        Message.success(
          bi(
            `已引入样板变更《${chosenPilot.title}》到当前集群`,
            `Imported "${chosenPilot.title}" into ${cluster.id}`,
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
            {stats.available > 0
              ? bi(
                  `发现 ${stats.available} 项可引入的 ${cluster.app_name} 已落地变更模板`,
                  `${stats.available} reusable ${cluster.app_name} change template(s) ready to import`,
                )
              : bi(
                  `共有 ${stats.total} 项 ${cluster.app_name} 已落地变更模板（本集群均已引入或生效）`,
                  `${stats.total} ${cluster.app_name} applied template(s) (all already imported or effective here)`,
                )}
            <small>
              {stats.totalRuns > stats.total
                ? bi(
                    ` · 已按实际内容去重（聚合 ${stats.totalRuns} 次实测 · ${stats.clusterList.length} 套集群）`,
                    ` · Deduplicated by effective diff (${stats.totalRuns} verified runs across ${stats.clusterList.length} clusters)`,
                  )
                : bi(
                    " · 无需重填诉求，一键引入并自动映射本集群基线",
                    " · Import directly with automatic baseline remapping",
                  )}
            </small>
          </span>
        </div>
        <button
          type="button"
          className={`ro-strip-btn${stats.available > 0 ? " primary" : ""}`}
          onClick={() => {
            setErr("");
            resetFilters();
            setSortBy("recommended");
            setExpandedVariants({});
            setExpandedParams({});
            const firstAvail =
              templates.find((t) => !t.already_imported && !t.already_effective) ||
              templates.find((t) => !t.already_imported) ||
              templates[0];
            if (firstAvail) {
              setSelectedKey(templateKeyOf(firstAvail));
            }
            setOpen(true);
          }}
        >
          {stats.available > 0
            ? bi("从已有变更引入", "Import Applied Change")
            : bi("查看变更模板", "Browse Templates")}
          <IconRight />
        </button>
      </div>

      <Modal
        visible={open}
        onCancel={() => setOpen(false)}
        focusLock={false}
        autoFocus={false}
        title={bi(
          `引入已落地变更到 ${cluster.id}`,
          `Import Applied Change into ${cluster.id}`,
        )}
        style={{ width: "min(780px, 94vw)", transformOrigin: "center center" }}
        footer={
          <div className="ro-modal-foot">
            <span className="ro-modal-foot-hint">
              {chosen?.already_effective && !chosen.already_imported
                ? bi(
                    "本集群似乎已独立生效相同参数；如需核查仍可以「标准探针」引入",
                    "Identical parameters appear already effective here; use Standard Probe if re-verifying",
                  )
                : bi(
                    "内容一致的跨集群变更已自动合并去重，点卡片内「合并记录」可切换指定样板",
                    "Equivalent changes across clusters are auto-consolidated; expand a card to switch pilot",
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
                {chosen?.already_effective && !chosen.already_imported
                  ? bi("仍以探针引入核查", "Import via Probe Anyway")
                  : bi("引入到当前集群", "Import to This Cluster")}
              </Button>
            </div>
          </div>
        }
      >
        <div className="ro-modal-body">
          {/* Row 1: Search + Cluster / Mode / Sort Selects */}
          <div className="ro-tpl-toolbar">
            <Input
              size="small"
              prefix={<IconSearch />}
              value={query}
              onChange={setQuery}
              allowClear
              className="ro-tpl-search"
              placeholder={bi(
                "搜索标题、参数名/值、样板集群或操作人…",
                "Search title, parameter key/value, pilot cluster, or operator…",
              )}
            />
            {stats.clusterList.length >= 2 && (
              <Select
                size="small"
                allowClear
                value={clusterFilter || undefined}
                onChange={(v) => setClusterFilter(v || "")}
                placeholder={bi("按样板集群", "Pilot Cluster")}
                className="ro-tpl-select"
                triggerProps={{ autoAlignPopupWidth: false }}
              >
                {stats.clusterList.map((cid) => (
                  <Select.Option key={cid} value={cid}>
                    <span className="mono">{cid}</span>
                  </Select.Option>
                ))}
              </Select>
            )}
            {stats.modeList.length >= 2 && (
              <Select
                size="small"
                allowClear
                value={modeFilter || undefined}
                onChange={(v) => setModeFilter(v || "")}
                placeholder={bi("推演档位", "Mode")}
                className="ro-tpl-select-sm"
              >
                <Select.Option value="full">{bi("全量推演", "Full")}</Select.Option>
                <Select.Option value="light">{bi("简单推演", "Light")}</Select.Option>
                <Select.Option value="quick">{bi("极速变更", "Quick")}</Select.Option>
              </Select>
            )}
            <Select
              size="small"
              value={sortBy}
              onChange={(v) => setSortBy(v as "recommended" | "recent" | "clusters")}
              className="ro-tpl-select-sm"
            >
              <Select.Option value="recommended">{bi("默认推荐", "Recommended")}</Select.Option>
              <Select.Option value="recent">{bi("最近落地", "Most Recent")}</Select.Option>
              <Select.Option value="clusters">{bi("落地集群最多", "Most Verified")}</Select.Option>
            </Select>
          </div>

          {/* Row 2: Semantic Categories + Quick Status/Match Chips */}
          <div className="ro-tpl-filter-bar">
            <div className="ro-chip-row">
              <button
                type="button"
                className={`ro-filter-chip${catFilter === "all" ? " on" : ""}`}
                onClick={() => setCatFilter("all")}
              >
                <span>{bi("全部分类", "All")}</span>
                <em className="num">{stats.total}</em>
              </button>
              {stats.catList.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`ro-filter-chip cat-${c.id}${catFilter === c.id ? " on" : ""}`}
                  onClick={() => setCatFilter(catFilter === c.id ? "all" : c.id)}
                >
                  <span>{c.label}</span>
                  <em className="num">{c.count}</em>
                </button>
              ))}
              <span className="ro-chip-sep" aria-hidden />
              <button
                type="button"
                className={`ro-filter-chip is-toggle${onlyAvailable ? " on" : ""}`}
                onClick={() => setOnlyAvailable((v) => !v)}
              >
                <span>{bi("仅可引入", "Available")}</span>
                <em className="num">{stats.available}</em>
              </button>
              <button
                type="button"
                className={`ro-filter-chip is-toggle${onlyExact ? " on" : ""}`}
                onClick={() => setOnlyExact((v) => !v)}
              >
                <span>{bi("仅同架构", "Exact Match")}</span>
                <em className="num">{stats.exact}</em>
              </button>
              {stats.fastTrack > 0 && (
                <button
                  type="button"
                  className={`ro-filter-chip is-toggle${onlyFastTrack ? " on" : ""}`}
                  onClick={() => setOnlyFastTrack((v) => !v)}
                >
                  <span>{bi("可极速直达", "Fast Track")}</span>
                  <em className="num">{stats.fastTrack}</em>
                </button>
              )}
            </div>
          </div>

          <div className="ro-tpl-summary-line">
            <span className="num">
              {bi(
                `显示 ${filtered.length} / ${stats.total} 项去重变更模板`,
                `Showing ${filtered.length} of ${stats.total} deduplicated template(s)`,
              )}
              {stats.totalRuns > stats.total &&
                bi(
                  ` · 自动聚合 ${stats.totalRuns} 次集群落地记录`,
                  ` · consolidated from ${stats.totalRuns} verified cluster runs`,
                )}
            </span>
            {hasActiveFilters && (
              <button type="button" className="link small" onClick={resetFilters}>
                {bi("重置筛选", "Reset filters")}
              </button>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="ro-empty-box">
              <div>{bi("当前筛选条件下暂无匹配的变更模板", "No templates match the current filters")}</div>
              {hasActiveFilters && (
                <Button size="mini" style={{ marginTop: 8 }} onClick={resetFilters}>
                  {bi("清空筛选条件", "Clear Filters")}
                </Button>
              )}
            </div>
          ) : (
            <div className="ro-tpl-list">
              {filtered.map((t) => {
                const key = templateKeyOf(t);
                const active = key === selectedKey;
                const activeV = activeVariantOf(t);
                const displayTitle = activeV?.title || t.title;
                const displayCluster = activeV?.cluster_id || t.origin_cluster_id;
                const displayBy = activeV?.applied_by || t.applied_by || "";
                const displayAt = activeV?.applied_at || t.applied_at || "";
                const displaySteps = activeV?.steps_count ?? t.steps_count;
                const verifiedCount = t.verified_clusters?.length || 1;
                const variants = t.variants || [];
                const hasMerged = variants.length > 1;
                const variantsOpen = Boolean(expandedVariants[key]);
                const changes = t.applied_changes || [];
                const paramsOpen = Boolean(expandedParams[key]);
                const visibleChanges = paramsOpen ? changes : changes.slice(0, 3);
                const hiddenParams = changes.length - visibleChanges.length;

                return (
                  <div
                    key={key}
                    className={`ro-tpl-card${active ? " on" : ""}${t.already_imported || t.already_effective ? " is-done" : ""}`}
                    onClick={() => setSelectedKey(key)}
                  >
                    <div className="ro-tpl-top">
                      <span className="ro-radio" aria-hidden />
                      {t.category_label && (
                        <span className={`ro-cat-pill cat-${t.category || "ops"}`}>
                          {t.category_label}
                        </span>
                      )}
                      <b>{displayTitle}</b>
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
                      ) : t.already_effective ? (
                        t.existing_rehearsal_id ? (
                          <button
                            type="button"
                            className="ro-go-btn is-eff"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpen(false);
                              onImported(t.existing_rehearsal_id!);
                            }}
                          >
                            {bi("本集群已生效 · 查看", "Already Effective · View")}
                            <IconRight />
                          </button>
                        ) : (
                          <span className="ro-match-pill is-eff">
                            {bi("本集群已生效", "Already Effective")}
                          </span>
                        )
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

                    {/* Inline Effective Parameter Diff Preview */}
                    {changes.length > 0 && (
                      <div className="ro-tpl-params">
                        {visibleChanges.map((ch, idx) => (
                          <Tooltip
                            key={`${ch.key}-${idx}`}
                            content={`${ch.key} = ${ch.after}${ch.before ? ` (${bi("原值", "was")}: ${ch.before})` : ""}`}
                          >
                            <span className="ro-param-chip mono">
                              <em>{ch.key}</em>={truncVal(ch.after, 32)}
                            </span>
                          </Tooltip>
                        ))}
                        {hiddenParams > 0 && (
                          <button
                            type="button"
                            className="ro-param-more"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedParams((prev) => ({ ...prev, [key]: true }));
                            }}
                          >
                            +{hiddenParams} {bi("项参数", "more")}
                          </button>
                        )}
                        {paramsOpen && changes.length > 3 && (
                          <button
                            type="button"
                            className="ro-param-more"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedParams((prev) => ({ ...prev, [key]: false }));
                            }}
                          >
                            {bi("收起", "Less")}
                          </button>
                        )}
                      </div>
                    )}

                    <div className="ro-tpl-meta num">
                      <span>
                        {bi("样板", "Pilot")}:{" "}
                        <code className="mono">{displayCluster}</code>
                      </span>
                      <span className="ro-tpl-mode-tag">{modeLabel(t.mode)}</span>
                      <span>
                        {displayBy} · {ago(displayAt)}
                      </span>
                      {displaySteps > 0 && (
                        <span>
                          {bi(`${displaySteps} 步`, `${displaySteps} steps`)}
                        </span>
                      )}
                      {verifiedCount > 1 && (
                        <span className="ro-tpl-batch">
                          <IconCheck />{" "}
                          {bi(
                            `已在 ${verifiedCount} 套集群落地`,
                            `Verified on ${verifiedCount} clusters`,
                          )}
                        </span>
                      )}
                      {hasMerged && (
                        <button
                          type="button"
                          className={`ro-merge-toggle${variantsOpen ? " open" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedVariants((prev) => ({
                              ...prev,
                              [key]: !prev[key],
                            }));
                          }}
                        >
                          <IconBranch />
                          <span>
                            {bi(
                              `已合并 ${variants.length} 份同内容变更`,
                              `Merged ${variants.length} equivalent runs`,
                            )}
                          </span>
                          {variantsOpen ? <IconUp /> : <IconDown />}
                        </button>
                      )}
                    </div>

                    {t.conflict_summary && (
                      <div className="ro-pick-warn ro-tpl-warn">
                        <IconExclamationCircle /> {t.conflict_summary}
                      </div>
                    )}

                    {/* Expandable Merged Equivalent Variants Drawer */}
                    {hasMerged && variantsOpen && (
                      <div
                        className="ro-tpl-variants"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="ro-tpl-variants-h">
                          {bi(
                            "以下记录虽然标题或发起方式不同，但实际生效的参数变更完全一致，已自动归并；可按需切换具体样板：",
                            "These runs modified the exact same normalized parameters despite different titles and were auto-consolidated. You may pick any verified run as pilot:",
                          )}
                        </div>
                        {variants.map((v) => {
                          const vKey = `${v.cluster_id}/${v.rehearsal_id}`;
                          const isCurrent =
                            displayCluster === v.cluster_id &&
                            (activeV?.rehearsal_id || t.origin_rehearsal_id) ===
                              v.rehearsal_id;
                          return (
                            <div
                              key={vKey}
                              className={`ro-var-row${isCurrent ? " is-cur" : " is-pickable"}`}
                              onClick={() => {
                                if (!isCurrent) {
                                  setPilotOverrides((prev) => ({
                                    ...prev,
                                    [key]: vKey,
                                  }));
                                }
                                setSelectedKey(key);
                              }}
                            >
                              <div className="ro-var-main">
                                <div className="ro-var-top">
                                  <code className="mono">{v.cluster_id}</code>
                                  {v.is_origin && (
                                    <span className="ro-var-tag">
                                      {bi("推广源", "Origin")}
                                    </span>
                                  )}
                                  {v.version && (
                                    <span className="ro-var-sub mono">
                                      v{v.version}
                                    </span>
                                  )}
                                  <span className="ro-var-sub num">
                                    {v.applied_by} · {ago(v.applied_at || "")}
                                  </span>
                                </div>
                                <div className="ro-var-title">{v.title}</div>
                              </div>
                              <div className="ro-var-act">
                                {isCurrent ? (
                                  <span className="ro-var-picked">
                                    <IconCheck /> {bi("当前样板", "Active Pilot")}
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    className="ro-var-pick-btn"
                                    onClick={() => {
                                      setPilotOverrides((prev) => ({
                                        ...prev,
                                        [key]: vKey,
                                      }));
                                      setSelectedKey(key);
                                    }}
                                  >
                                    {bi("选为样板", "Use as Pilot")}
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {chosen && chosenPilot && !chosen.already_imported && (
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
                className={`ro-mode-card${mode === "steps" ? " on" : ""}${!chosenPilot.allowSkipProbe ? " is-disabled" : ""}`}
                disabled={!chosenPilot.allowSkipProbe}
                onClick={() => chosenPilot.allowSkipProbe && setMode("steps")}
              >
                <div className="ro-mode-card-h">
                  <span className="ro-radio" aria-hidden />
                  <b>{bi("极速直达：严格预检 + 待执行清单", "Fast Track: Strict Precheck + Steps")}</b>
                </div>
                <p>
                  {chosenPilot.allowSkipProbe
                    ? bi(
                        "架构与版本一致且无参数冲突，直接映射待执行清单并自动强化第 1 步为强制阻断预检。",
                        "Exact match & conflict-free: maps steps directly with a mandatory strict Step 1 precheck gate.",
                      )
                    : chosenPilot.skipProbeBlockReason ||
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

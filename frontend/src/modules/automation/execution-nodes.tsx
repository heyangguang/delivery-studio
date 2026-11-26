import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Drawer,
  Input,
  Message,
  Modal,
  Popconfirm,
  Select,
  Skeleton,
  Switch,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconBook,
  IconCheckCircle,
  IconClose,
  IconCopy,
  IconDelete,
  IconDownload,
  IconExclamationCircle,
  IconLoading,
  IconPlus,
  IconRefresh,
  IconRight,
  IconSearch,
  IconSettings,
  IconThunderbolt,
} from "@arco-design/web-react/icon";
import {
  ClusterView,
  ago,
  api,
  cached,
  can,
  copy,
  csrfToken,
  err,
  fullTime,
  platformShort,
  putCached,
  typing,
  useMedia,
} from "../../shared/shared";
import { go } from "../../app/router";
import { Kbd, StatusBadge } from "../../design/ui";
import { bi, useLang, withLang } from "../../app/i18n";
import {
  AgentClusterCatalogItem,
  AgentHeartbeatSample,
  AgentHostProbe,
  AutomationBootstrapInfo,
  UnifiedAgentView,
  consumeAgentEnrollPrefill,
} from "./execution-types";
import { EnrollAgentModal } from "./enroll-agent-modal";
import "./executions.css";
import "./execution-center.css";
import "./rehearsal-automation.css";

type StatusFilter = "all" | "online" | "offline" | "disabled";

type UnifiedAgentsResponse = {
  agents: UnifiedAgentView[];
  manageable_clusters?: string[];
  cluster_catalog?: AgentClusterCatalogItem[];
  bootstrap: AutomationBootstrapInfo;
};

type UnifiedEnrollment = {
  agent: UnifiedAgentView;
  token: string;
  bootstrap: AutomationBootstrapInfo;
};

type HeartbeatSlot = {
  key: string;
  label: string;
  tone: "ok" | "warn" | "miss" | "idle";
  sample?: AgentHeartbeatSample;
};

const isLoopbackURL = (raw: string): boolean => {
  try {
    const h = new URL(raw.trim()).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
};

const runnerSlug = (name: string, ip: string): string => {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  const base = cleaned || ip.replace(/\./g, "-") || "agent";
  return base.slice(0, 36).replace(/[-.]+$/, "") || "agent";
};

function fmtUptime(sec?: number): string {
  if (!sec || sec <= 0) return "";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return bi(`${d}天 ${h}小时`, `${d}d ${h}h`);
  if (h > 0) return bi(`${h}小时 ${m}分`, `${h}h ${m}m`);
  return bi(`${Math.max(1, m)}分钟`, `${Math.max(1, m)}m`);
}

function toLocalMinuteKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function buildHeartbeatSlots(agent: UnifiedAgentView, count = 60): {
  slots: HeartbeatSlot[];
  uptimePct: number | null;
  activeSlots: number;
} {
  const now = new Date();
  now.setSeconds(0, 0);
  const byMinute = new Map<string, AgentHeartbeatSample>();
  let earliestMs = Infinity;

  for (const s of agent.heartbeats || []) {
    const t = new Date(s.at);
    if (Number.isNaN(t.getTime())) continue;
    if (t.getTime() < earliestMs) earliestMs = t.getTime();
    byMinute.set(toLocalMinuteKey(t), s);
  }

  if (agent.last_seen) {
    const lt = new Date(agent.last_seen);
    if (!Number.isNaN(lt.getTime())) {
      if (lt.getTime() < earliestMs) earliestMs = lt.getTime();
      const lk = toLocalMinuteKey(lt);
      if (!byMinute.has(lk)) {
        byMinute.set(lk, {
          at: agent.last_seen,
          load1: agent.probe?.load1,
          mem_pct: agent.probe?.mem_used_pct,
          disk_pct: agent.probe?.disk_used_pct,
        });
      }
    }
  }

  if (agent.online && !agent.disabled) {
    const curKey = toLocalMinuteKey(now);
    if (!byMinute.has(curKey)) {
      byMinute.set(curKey, {
        at: new Date().toISOString(),
        load1: agent.probe?.load1,
        mem_pct: agent.probe?.mem_used_pct,
        disk_pct: agent.probe?.disk_used_pct,
      });
      if (now.getTime() < earliestMs) earliestMs = now.getTime();
    }
  }

  const slots: HeartbeatSlot[] = [];
  let okOrWarn = 0;
  let monitored = 0;

  for (let i = count - 1; i >= 0; i--) {
    const slotDate = new Date(now.getTime() - i * 60_000);
    const key = toLocalMinuteKey(slotDate);
    const hhmm = key.slice(11);
    const sample = byMinute.get(key);
    if (sample) {
      monitored++;
      okOrWarn++;
      const highLoad =
        (sample.mem_pct !== undefined && sample.mem_pct >= 85) ||
        (sample.disk_pct !== undefined && sample.disk_pct >= 90);
      slots.push({
        key,
        label: hhmm,
        tone: highLoad ? "warn" : "ok",
        sample,
      });
    } else if (earliestMs !== Infinity && slotDate.getTime() >= earliestMs - 30_000) {
      monitored++;
      slots.push({
        key,
        label: hhmm,
        tone: "miss",
      });
    } else {
      slots.push({
        key,
        label: hhmm,
        tone: "idle",
      });
    }
  }

  const uptimePct =
    monitored > 0 ? Math.round((okOrWarn / monitored) * 1000) / 10 : null;
  return { slots, uptimePct, activeSlots: okOrWarn };
}

function CommandBlock({ title, code }: { title: string; code: string }) {
  useLang();
  return (
    <div className="exec-command">
      <div>
        <span>{title}</span>
        <Button
          type="text"
          size="mini"
          icon={<IconCopy />}
          onClick={() => copy(code)}
        >
          {bi("复制", "Copy")}
        </Button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function hasProbeMetrics(probe?: AgentHostProbe): boolean {
  if (!probe) return false;
  return Boolean(
    probe.hostname ||
      probe.os ||
      probe.cpu_cores ||
      probe.mem_total_mb ||
      probe.disk_total_gb,
  );
}

/** Interactive 60-minute Status Bar Strip (Porcelain/Obsidian Apple-grade edition) */
function HeartbeatPulseBars({
  agent,
  onOpenDetail,
}: {
  agent: UnifiedAgentView;
  onOpenDetail?: () => void;
}) {
  useLang();
  const { slots, uptimePct } = useMemo(
    () => buildHeartbeatSlots(agent, 60),
    [agent],
  );
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const hovered = hoverIdx !== null ? slots[hoverIdx] : null;

  const hoverSummary = hovered
    ? hovered.tone === "ok" || hovered.tone === "warn"
      ? `${hovered.label} · ${
          hovered.tone === "warn"
            ? bi("高负载告警", "High Load")
            : bi("心跳正常", "Healthy")
        }${
          hovered.sample?.load1 !== undefined
            ? ` · Load ${hovered.sample.load1.toFixed(2)}`
            : ""
        }${
          hovered.sample?.mem_pct !== undefined
            ? ` · ${bi("内存", "Mem")} ${hovered.sample.mem_pct.toFixed(1)}%`
            : ""
        }${
          hovered.sample?.disk_pct !== undefined
            ? ` · ${bi("磁盘", "Disk")} ${hovered.sample.disk_pct.toFixed(1)}%`
            : ""
        }`
      : hovered.tone === "miss"
        ? `${hovered.label} · ${bi("未收到心跳（离线中断）", "Missed heartbeat (offline)")}`
        : `${hovered.label} · ${bi("无上报记录", "No record")}`
    : null;

  return (
    <div className="ua-pulse-box">
      <div className="ua-pulse-top">
        <div className="ua-pulse-title">
          <span
            className={`ec-state-dot ${
              agent.disabled
                ? "is-disabled"
                : agent.online
                  ? "is-online"
                  : agent.last_seen
                    ? "is-offline"
                    : "is-waiting"
            }`}
          />
          <b>
            {agent.disabled
              ? bi("Agent 已停用", "Agent Disabled")
              : agent.online
                ? bi("心跳正常 · 每 15s 实时上报", "Operational · 15s Heartbeat")
                : agent.last_seen
                  ? bi("心跳中断 · 当前离线", "Heartbeat Interrupted")
                  : bi("等待首次心跳接入", "Awaiting First Heartbeat")}
          </b>
          {uptimePct !== null && (
            <span
              className={`ua-uptime-pill num ${
                uptimePct >= 99 ? "is-ok" : uptimePct >= 80 ? "is-warn" : "is-bad"
              }`}
            >
              {bi(`近 60 分钟在线率 ${uptimePct}%`, `60m Uptime ${uptimePct}%`)}
            </span>
          )}
        </div>

        <div className="ua-pulse-right">
          {hoverSummary ? (
            <span className="ua-pulse-hover-readout mono">{hoverSummary}</span>
          ) : (
            <span className="ua-pulse-legend">
              <span>
                <i className="is-ok" />
                {bi("正常", "OK")}
              </span>
              <span>
                <i className="is-warn" />
                {bi("高负载", "High Load")}
              </span>
              <span>
                <i className="is-miss" />
                {bi("丢失", "Missed")}
              </span>
            </span>
          )}
          {onOpenDetail && (
            <Button size="small" type="secondary" onClick={onOpenDetail}>
              {bi("心跳与探针记录", "Heartbeat & Probe Log")} <IconRight />
            </Button>
          )}
        </div>
      </div>

      <div
        className="ua-hb-bars"
        role="img"
        aria-label={bi("近 60 分钟心跳状态条", "Last 60 minutes heartbeat bars")}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {slots.map((s, idx) => (
          <span
            key={s.key}
            className={`ua-hb-bar is-${s.tone} ${hoverIdx === idx ? "is-hover" : ""}`}
            onMouseEnter={() => setHoverIdx(idx)}
            onClick={onOpenDetail}
          />
        ))}
      </div>

      <div className="ua-hb-axis num">
        <span>{bi("60 分钟前", "60m ago")}</span>
        <span>
          {agent.last_seen
            ? `${bi("最近上报", "Last report")}: ${fullTime(agent.last_seen)}`
            : bi("尚未收到心跳包", "No heartbeat packets yet")}
        </span>
        <span>{bi("现在", "Now")}</span>
      </div>
    </div>
  );
}

function HostProbeOverviewCard({
  agent,
  onOpenProbeDrawer,
  onOpenGuide,
}: {
  agent: UnifiedAgentView;
  onOpenProbeDrawer: () => void;
  onOpenGuide: () => void;
}) {
  useLang();
  const probe = agent.probe;
  const probed = hasProbeMetrics(probe);
  const memPct = Math.min(100, Math.max(0, probe?.mem_used_pct ?? 0));
  const diskPct = Math.min(100, Math.max(0, probe?.disk_used_pct ?? 0));
  const memTotalGB = probe?.mem_total_mb ? probe.mem_total_mb / 1024 : 0;
  const memUsedGB = memTotalGB > 0 ? (memTotalGB * memPct) / 100 : 0;
  const loadPct =
    probe?.load1 !== undefined && probe?.cpu_cores
      ? Math.min(100, Math.max(0, (probe.load1 / probe.cpu_cores) * 100))
      : 0;
  const barTone = (pct: number) =>
    pct >= 90 ? "is-bad" : pct >= 75 ? "is-warn" : "";
  const svcName = agent.service_name || "middleware-execution";
  const restartCmd = `sudo systemctl restart ${svcName} && sudo systemctl status ${svcName}`;

  return (
    <div className="ua-overview-stack">
      <div className="ec-surface-card ua-telemetry-surface">
        <HeartbeatPulseBars agent={agent} onOpenDetail={onOpenProbeDrawer} />

        <div className="ec-probe-grid ua-probe-divider">
          <div className="ec-probe-item" onClick={onOpenProbeDrawer}>
            <span className="ec-probe-lbl">
              {bi("主机名与操作系统", "Hostname & OS")}
            </span>
            <div className="ec-probe-val">
              <b>{probe?.hostname || agent.ip}</b>
              {probe?.arch && <span>{probe.arch}</span>}
            </div>
            <span
              className="ec-probe-sub"
              title={[probe?.os, probe?.kernel].filter(Boolean).join(" · ")}
            >
              {probed
                ? [probe?.os, probe?.kernel].filter(Boolean).join(" · ") || svcName
                : `${bi("服务单元", "systemd")}: ${svcName}`}
            </span>
          </div>

          <div className="ec-probe-item" onClick={onOpenProbeDrawer}>
            <span className="ec-probe-lbl">
              {bi("CPU 与系统负载", "CPU & Load Average")}
            </span>
            {probed && (probe?.cpu_cores || probe?.load1 !== undefined) ? (
              <>
                <div className="ec-probe-val num">
                  <b>
                    {probe?.cpu_cores
                      ? bi(`${probe.cpu_cores} 核`, `${probe.cpu_cores} vCPU`)
                      : "—"}
                  </b>
                  {probe?.load1 !== undefined && (
                    <span>
                      Load {probe.load1.toFixed(2)} / {(probe.load5 ?? 0).toFixed(2)}
                    </span>
                  )}
                </div>
                <div className="ec-probe-bar">
                  <i className={barTone(loadPct)} style={{ width: `${loadPct}%` }} />
                </div>
              </>
            ) : (
              <>
                <div className="ec-probe-val num">
                  <b>—</b>
                  <span>{bi("等待探针上报", "Awaiting probe")}</span>
                </div>
                <div className="ec-probe-bar">
                  <i style={{ width: "0%" }} />
                </div>
              </>
            )}
          </div>

          <div className="ec-probe-item" onClick={onOpenProbeDrawer}>
            <span className="ec-probe-lbl">
              {bi("物理内存占用", "Memory Usage")}
            </span>
            {probed && probe?.mem_used_pct !== undefined ? (
              <>
                <div className="ec-probe-val num">
                  <b>{`${memPct.toFixed(1)}%`}</b>
                  {memTotalGB > 0 && (
                    <span>{`${memUsedGB.toFixed(1)} / ${memTotalGB.toFixed(1)} GB`}</span>
                  )}
                </div>
                <div className="ec-probe-bar">
                  <i className={barTone(memPct)} style={{ width: `${memPct}%` }} />
                </div>
              </>
            ) : (
              <>
                <div className="ec-probe-val num">
                  <b>—</b>
                  <span>{bi("随心跳自动同步", "Synced on heartbeat")}</span>
                </div>
                <div className="ec-probe-bar">
                  <i style={{ width: "0%" }} />
                </div>
              </>
            )}
          </div>

          <div className="ec-probe-item" onClick={onOpenProbeDrawer}>
            <span className="ec-probe-lbl">
              {bi("根分区磁盘与运行时长", "Root Disk & Uptime")}
            </span>
            {probed && probe?.disk_used_pct !== undefined ? (
              <>
                <div className="ec-probe-val num">
                  <b>{`${diskPct.toFixed(1)}%`}</b>
                  <span>
                    {probe.disk_total_gb ? `${probe.disk_total_gb.toFixed(0)} GB` : ""}
                    {probe.uptime_sec ? ` · ${fmtUptime(probe.uptime_sec)}` : ""}
                  </span>
                </div>
                <div className="ec-probe-bar">
                  <i className={barTone(diskPct)} style={{ width: `${diskPct}%` }} />
                </div>
              </>
            ) : (
              <>
                <div className="ec-probe-val num">
                  <b>
                    {agent.online
                      ? bi("在线运行中", "Online")
                      : agent.disabled
                        ? bi("已停用", "Disabled")
                        : bi("未连接", "Offline")}
                  </b>
                </div>
                <span className="ec-probe-sub num">
                  {agent.last_seen
                    ? `${bi("上次在线", "Last seen")} ${ago(agent.last_seen)}`
                    : bi("尚未上报首次心跳", "No heartbeat reported yet")}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {!agent.online && !agent.disabled && (
        <div className="ua-diag-strip">
          <div className="ua-diag-txt">
            <span className="ec-state-dot is-offline" />
            <span>
              {agent.last_seen
                ? bi(
                    `当前未收到实时心跳（上次在线 ${fullTime(agent.last_seen)}），可在机器上重启服务恢复：`,
                    `Agent is offline (last seen ${fullTime(agent.last_seen)}). Restart service on the machine:`,
                  )
                : bi(
                    "尚未收到首次心跳，请确认已在目标机器运行安装脚本或检查服务状态：",
                    "No heartbeat received yet. Verify installation or check service status:",
                  )}
            </span>
            <code className="ua-diag-code mono">{restartCmd}</code>
          </div>
          <div className="ua-diag-acts">
            <Button
              size="small"
              type="secondary"
              icon={<IconCopy />}
              onClick={() =>
                copy(restartCmd, bi("已复制服务重启命令", "Copied restart command"))
              }
            >
              {bi("复制命令", "Copy")}
            </Button>
            <Button size="small" type="text" onClick={onOpenGuide}>
              {bi("更多命令", "More")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function matchClusterQuery(c: AgentClusterCatalogItem, kw: string): boolean {
  if (!kw) return true;
  if (
    c.id.toLowerCase().includes(kw) ||
    c.app_name.toLowerCase().includes(kw) ||
    (c.version || "").toLowerCase().includes(kw) ||
    (c.owner || "").toLowerCase().includes(kw) ||
    (c.platform || "").toLowerCase().includes(kw) ||
    platformShort(c.platform).toLowerCase().includes(kw)
  ) {
    return true;
  }
  if (c.host_ips?.some((ip) => ip.toLowerCase().includes(kw))) return true;
  if (c.host_names?.some((h) => h.toLowerCase().includes(kw))) return true;
  return false;
}

function isSameMachineCluster(agent: UnifiedAgentView, c?: AgentClusterCatalogItem): boolean {
  if (agent.backing === "direct") return true;
  if (c?.host_ips?.some((ip) => ip.trim() === agent.ip.trim())) return true;
  return Boolean(c && agent.suggested_clusters?.includes(c.id));
}

/** Slide-Over Rich Dual-Pane Cluster Transfer Drawer (supports IP, subnet, hostname, middleware, OS, owner search) */
function AgentClusterTransferDrawer({
  agent,
  visible,
  catalog,
  manageableSet,
  busy,
  initialScope = "all",
  onClose,
  onBind,
  onUnbind,
}: {
  agent: UnifiedAgentView | null;
  visible: boolean;
  catalog: AgentClusterCatalogItem[];
  manageableSet: Set<string>;
  busy: boolean;
  initialScope?: "all" | "same_ip";
  onClose: () => void;
  onBind: (cids: string[]) => void;
  onUnbind: (cids: string[]) => void;
}) {
  useLang();
  const [leftKw, setLeftKw] = useState("");
  const [rightKw, setRightKw] = useState("");
  const [scopeFilter, setScopeFilter] = useState<"all" | "same_ip">(initialScope);
  const [appFilter, setAppFilter] = useState<string>("all");
  const [leftChecked, setLeftChecked] = useState<Set<string>>(() => new Set());
  const [rightChecked, setRightChecked] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (visible) {
      setScopeFilter(initialScope);
      setLeftKw("");
      setRightKw("");
      setAppFilter("all");
      setLeftChecked(new Set());
      setRightChecked(new Set());
    }
  }, [visible, initialScope, agent?.id]);

  useEffect(() => {
    setLeftChecked(new Set());
    setRightChecked(new Set());
  }, [agent?.clusters.join(",")]);

  const clusterById = useMemo(
    () => new Map(catalog.map((c) => [c.id, c])),
    [catalog],
  );
  const boundSet = useMemo(() => new Set(agent?.clusters || []), [agent?.clusters]);

  const allUnboundOperable = useMemo(
    () => catalog.filter((c) => !boundSet.has(c.id) && (c.can_op || manageableSet.has(c.id))),
    [catalog, boundSet, manageableSet],
  );

  const sameIPUnbound = useMemo(
    () =>
      agent
        ? allUnboundOperable.filter(
            (c) =>
              Boolean(c.host_ips?.includes(agent.ip)) ||
              Boolean(agent.suggested_clusters?.includes(c.id)),
          )
        : [],
    [agent, allUnboundOperable],
  );

  const appOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of allUnboundOperable) {
      counts.set(c.app_name, (counts.get(c.app_name) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [allUnboundOperable]);

  const lq = leftKw.trim().toLowerCase();
  const availableList = useMemo(
    () =>
      allUnboundOperable.filter((c) => {
        if (
          scopeFilter === "same_ip" &&
          agent &&
          !(c.host_ips?.includes(agent.ip) || agent.suggested_clusters?.includes(c.id))
        ) {
          return false;
        }
        if (appFilter !== "all" && c.app_name !== appFilter) return false;
        return matchClusterQuery(c, lq);
      }),
    [allUnboundOperable, scopeFilter, appFilter, agent, lq],
  );

  const rq = rightKw.trim().toLowerCase();
  const boundList = useMemo(
    () =>
      (agent?.clusters || []).filter((cid) => {
        if (!rq) return true;
        const m = clusterById.get(cid);
        if (m) return matchClusterQuery(m, rq);
        return cid.toLowerCase().includes(rq);
      }),
    [agent?.clusters, clusterById, rq],
  );

  const manageableBoundList = useMemo(
    () =>
      boundList.filter((cid) => {
        const m = clusterById.get(cid);
        return Boolean(m?.can_op || manageableSet.has(cid));
      }),
    [boundList, clusterById, manageableSet],
  );

  const validLeftIds = useMemo(
    () => availableList.filter((c) => leftChecked.has(c.id)).map((c) => c.id),
    [availableList, leftChecked],
  );
  const validRightIds = useMemo(
    () => manageableBoundList.filter((cid) => rightChecked.has(cid)),
    [manageableBoundList, rightChecked],
  );

  const allLeftChecked =
    availableList.length > 0 && validLeftIds.length === availableList.length;
  const someLeftChecked = validLeftIds.length > 0 && !allLeftChecked;

  const allRightChecked =
    manageableBoundList.length > 0 &&
    validRightIds.length === manageableBoundList.length;
  const someRightChecked = validRightIds.length > 0 && !allRightChecked;

  return (
    <Drawer
      width={880}
      style={{ maxWidth: "100vw" }}
      visible={visible && !!agent}
      onCancel={onClose}
      footer={null}
      title={
        agent ? (
          <span className="iam-drawer-title">
            <span>{bi("配置关联集群", "Configure Cluster Associations")}</span>
            <code className="mono">
              {agent.name} ({agent.ip})
            </code>
          </span>
        ) : (
          ""
        )
      }
    >
      {agent && (
        <div className="ds-tf-drawer-wrap">
          <div className="ds-tf-drawer-lead">
            <span>
              {bi(
                "支持按集群标识、节点 IP / 网段、主机名、中间件、操作系统或创建者检索；移至右侧即刻保存生效。",
                "Search by cluster ID, node IP/subnet, hostname, middleware, OS, or creator. Changes save immediately.",
              )}
            </span>
            {sameIPUnbound.length > 0 && (
              <Button
                size="mini"
                type="outline"
                disabled={busy}
                onClick={() => onBind(sameIPUnbound.map((c) => c.id))}
              >
                {bi(
                  `一键关联同机 IP 集群 (${sameIPUnbound.length})`,
                  `Bind Same-IP (${sameIPUnbound.length})`,
                )}
              </Button>
            )}
          </div>

          <div className="ds-transfer">
            {/* Left Pane: Available Manageable Clusters */}
            <div className="ds-tf-pane">
              <div className="ds-tf-head">
                <label className="ds-tf-head-chk">
                  <Checkbox
                    checked={allLeftChecked}
                    indeterminate={someLeftChecked}
                    disabled={availableList.length === 0 || busy}
                    onChange={(chk) => {
                      const next = new Set(leftChecked);
                      for (const c of availableList) {
                        if (chk) next.add(c.id);
                        else next.delete(c.id);
                      }
                      setLeftChecked(next);
                    }}
                  />
                  <b>{bi("可关联集群", "Available Clusters")}</b>
                </label>
                <span className="ds-tf-cnt num">
                  {validLeftIds.length > 0
                    ? `${validLeftIds.length} / ${availableList.length}`
                    : availableList.length}
                </span>
              </div>

              <div className="ds-tf-facets">
                <div className="ds-tf-scope-pills">
                  <button
                    type="button"
                    className={`ds-tf-pill ${scopeFilter === "all" ? "on" : ""}`}
                    onClick={() => setScopeFilter("all")}
                  >
                    {bi("全部", "All")} ({allUnboundOperable.length})
                  </button>
                  {sameIPUnbound.length > 0 && (
                    <button
                      type="button"
                      className={`ds-tf-pill is-match ${scopeFilter === "same_ip" ? "on" : ""}`}
                      onClick={() => setScopeFilter("same_ip")}
                    >
                      {bi("同机 IP", "Same IP")} ({sameIPUnbound.length})
                    </button>
                  )}
                </div>
                {appOptions.length > 1 && (
                  <Select
                    size="mini"
                    style={{ width: 138 }}
                    value={appFilter}
                    onChange={setAppFilter}
                    getPopupContainer={() => document.body}
                    triggerProps={{ autoFitPosition: true }}
                    options={[
                      { value: "all", label: bi("全部中间件", "All Apps") },
                      ...appOptions.map(([app, n]) => ({
                        value: app,
                        label: `${app} (${n})`,
                      })),
                    ]}
                  />
                )}
              </div>

              <div className="ds-tf-search">
                <Input
                  size="small"
                  prefix={<IconSearch />}
                  allowClear
                  value={leftKw}
                  onChange={setLeftKw}
                  placeholder={bi(
                    "搜索集群名、节点 IP、主机名、中间件或创建者…",
                    "Search cluster, node IP, hostname, app, or owner…",
                  )}
                />
              </div>

              <div className="ds-tf-list" style={{ height: 390 }}>
                {availableList.length === 0 ? (
                  <div className="ds-tf-empty">
                    {lq || scopeFilter !== "all" || appFilter !== "all"
                      ? bi("没有符合筛选条件的可关联集群", "No clusters match filters")
                      : allUnboundOperable.length === 0
                        ? bi("你有权限的全部集群均已关联", "All operable clusters are associated")
                        : bi("暂无可关联的集群", "No operable clusters")}
                  </div>
                ) : (
                  availableList.map((c) => {
                    const checked = leftChecked.has(c.id);
                    const hasSameIP = Boolean(
                      c.host_ips?.includes(agent.ip) ||
                        agent.suggested_clusters?.includes(c.id),
                    );
                    const ips = c.host_ips || [];
                    return (
                      <div
                        key={c.id}
                        className={`ds-tf-row ${checked ? "is-checked" : ""}`}
                        onClick={() => {
                          if (busy) return;
                          setLeftChecked((prev) => {
                            const next = new Set(prev);
                            if (checked) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          });
                        }}
                      >
                        <Checkbox checked={checked} disabled={busy} />
                        <div className="ds-tf-item-col">
                          <div className="ds-tf-item-main">
                            <span className="ds-tf-id mono" title={c.id}>
                              {c.id}
                            </span>
                            <span className="iam-app-pill">
                              {c.app_name} {c.version}
                            </span>
                            {hasSameIP && (
                              <span className="ua-path-badge is-local">
                                {bi("同机 IP", "Same IP")}
                              </span>
                            )}
                          </div>
                          <div className="ds-tf-item-sub">
                            {ips.length > 0 ? (
                              <span>
                                IP:{" "}
                                {ips.slice(0, 2).map((ip, idx) => (
                                  <React.Fragment key={ip}>
                                    {idx > 0 && ", "}
                                    <code
                                      className={`mono ${
                                        ip === agent.ip || (lq && ip.includes(lq))
                                          ? "is-match"
                                          : ""
                                      }`}
                                    >
                                      {ip}
                                    </code>
                                  </React.Fragment>
                                ))}
                                {ips.length > 2 ? ` +${ips.length - 2}` : ""}
                              </span>
                            ) : (
                              <span>{bi("未登记节点 IP", "No node IP")}</span>
                            )}
                            {c.platform && <span>· {platformShort(c.platform)}</span>}
                            {c.owner && <span>· {c.owner}</span>}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          className="ds-tf-quick-btn"
                          title={bi("立即关联此集群", "Associate immediately")}
                          onClick={(e) => {
                            e.stopPropagation();
                            onBind([c.id]);
                          }}
                        >
                          <IconPlus />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Center Action Buttons */}
            <div className="ds-tf-mid">
              <Button
                size="small"
                type="primary"
                disabled={validLeftIds.length === 0 || busy}
                loading={busy && validLeftIds.length > 0}
                onClick={() => onBind(validLeftIds)}
              >
                <span>
                  {validLeftIds.length > 0
                    ? bi(`关联 (${validLeftIds.length})`, `Add (${validLeftIds.length})`)
                    : bi("关联", "Add")}
                </span>
                <IconArrowRight />
              </Button>
              <Button
                size="small"
                type="secondary"
                disabled={validRightIds.length === 0 || busy}
                loading={busy && validRightIds.length > 0}
                onClick={() => onUnbind(validRightIds)}
              >
                <IconArrowLeft />
                <span>
                  {validRightIds.length > 0
                    ? bi(`移除 (${validRightIds.length})`, `Remove (${validRightIds.length})`)
                    : bi("移除", "Remove")}
                </span>
              </Button>
            </div>

            {/* Right Pane: Associated Clusters */}
            <div className="ds-tf-pane is-target">
              <div className="ds-tf-head">
                <label className="ds-tf-head-chk">
                  <Checkbox
                    checked={allRightChecked}
                    indeterminate={someRightChecked}
                    disabled={manageableBoundList.length === 0 || busy}
                    onChange={(chk) => {
                      const next = new Set(rightChecked);
                      for (const cid of manageableBoundList) {
                        if (chk) next.add(cid);
                        else next.delete(cid);
                      }
                      setRightChecked(next);
                    }}
                  />
                  <b>{bi("已关联集群", "Associated Clusters")}</b>
                </label>
                <span className="ds-tf-cnt is-brand num">
                  {validRightIds.length > 0
                    ? `${validRightIds.length} / ${boundList.length}`
                    : boundList.length}
                </span>
              </div>

              <div className="ds-tf-search">
                <Input
                  size="small"
                  prefix={<IconSearch />}
                  allowClear
                  value={rightKw}
                  onChange={setRightKw}
                  placeholder={bi(
                    "按集群名、节点 IP、中间件或创建者筛选…",
                    "Filter by cluster, IP, app, or owner…",
                  )}
                />
              </div>

              <div className="ds-tf-list" style={{ height: 429 }}>
                {boundList.length === 0 ? (
                  <div className="ds-tf-empty">
                    {rq
                      ? bi("没有匹配的已关联集群", "No matching clusters")
                      : bi(
                          "尚未关联集群；从左侧勾选或点击「+」即可移入",
                          "None associated yet. Select on the left to add.",
                        )}
                  </div>
                ) : (
                  boundList.map((cid) => {
                    const cMeta = clusterById.get(cid);
                    const canOp = Boolean(cMeta?.can_op || manageableSet.has(cid));
                    const checked = rightChecked.has(cid);
                    const isLocal = isSameMachineCluster(agent, cMeta);
                    const ips = cMeta?.host_ips || [];
                    return (
                      <div
                        key={cid}
                        className={`ds-tf-row ${checked ? "is-checked" : ""}`}
                        onClick={() => {
                          if (!canOp || busy) return;
                          setRightChecked((prev) => {
                            const next = new Set(prev);
                            if (checked) next.delete(cid);
                            else next.add(cid);
                            return next;
                          });
                        }}
                      >
                        <Checkbox checked={checked} disabled={!canOp || busy} />
                        <div className="ds-tf-item-col">
                          <div className="ds-tf-item-main">
                            <a
                              href={`#/d/${encodeURIComponent(cid)}`}
                              className="ds-tf-link mono"
                              title={bi(`打开集群 ${cid}`, `Open ${cid}`)}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onClose();
                                go({ name: "deliveries", id: cid });
                              }}
                            >
                              {cid}
                            </a>
                            {cMeta && (
                              <span className="iam-app-pill">
                                {cMeta.app_name} {cMeta.version}
                              </span>
                            )}
                            <span className={`ua-path-badge ${isLocal ? "is-local" : ""}`}>
                              {isLocal
                                ? bi("本机直连", "Local Direct")
                                : bi("远程代管", "Jumpbox")}
                            </span>
                          </div>
                          {cMeta && (
                            <div className="ds-tf-item-sub">
                              {ips.length > 0 && (
                                <span>
                                  IP:{" "}
                                  {ips.slice(0, 2).map((ip, idx) => (
                                    <React.Fragment key={ip}>
                                      {idx > 0 && ", "}
                                      <code
                                        className={`mono ${
                                          ip === agent.ip || (rq && ip.includes(rq))
                                            ? "is-match"
                                            : ""
                                        }`}
                                      >
                                        {ip}
                                      </code>
                                    </React.Fragment>
                                  ))}
                                  {ips.length > 2 ? ` +${ips.length - 2}` : ""}
                                </span>
                              )}
                              {cMeta.platform && (
                                <span>· {platformShort(cMeta.platform)}</span>
                              )}
                              {cMeta.owner && <span>· {cMeta.owner}</span>}
                            </div>
                          )}
                        </div>
                        {canOp && (
                          <button
                            type="button"
                            disabled={busy}
                            className="ds-tf-quick-btn is-rm"
                            title={bi("解除关联", "Unbind")}
                            onClick={(e) => {
                              e.stopPropagation();
                              onUnbind([cid]);
                            }}
                          >
                            <IconClose />
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

/** Dedicated Slide-Over Drawer for Heartbeat History Timeline & Host Probe Telemetry */
function HeartbeatAndProbeDrawer({
  agent,
  visible,
  onClose,
}: {
  agent: UnifiedAgentView | null;
  visible: boolean;
  onClose: () => void;
}) {
  useLang();
  const records = useMemo(() => {
    if (!agent) return [];
    const list = [...(agent.heartbeats || [])];
    if (list.length === 0 && agent.last_seen) {
      list.push({
        at: agent.last_seen,
        load1: agent.probe?.load1,
        mem_pct: agent.probe?.mem_used_pct,
        disk_pct: agent.probe?.disk_used_pct,
      });
    }
    return list.reverse();
  }, [agent]);

  const probe = agent?.probe;
  const memPct = Math.min(100, Math.max(0, probe?.mem_used_pct ?? 0));
  const diskPct = Math.min(100, Math.max(0, probe?.disk_used_pct ?? 0));
  const memTotalGB = probe?.mem_total_mb ? probe.mem_total_mb / 1024 : 0;

  return (
    <Drawer
      width={660}
      style={{ maxWidth: "100vw" }}
      visible={visible && !!agent}
      onCancel={onClose}
      footer={null}
      title={
        agent ? (
          <span className="iam-drawer-title">
            <span>{bi("心跳监控与主机探针详情", "Heartbeat & Host Probe")}</span>
            <code className="mono">{agent.name}</code>
          </span>
        ) : (
          ""
        )
      }
    >
      {agent && (
        <div className="ua-probe-drawer">
          <HeartbeatPulseBars agent={agent} />

          <div className="ua-pd-sec">
            <h4>{bi("主机硬件与系统实时探针", "Real-Time Host Probe Specs")}</h4>
            <div className="ua-pd-facts">
              <div>
                <span>{bi("机器 IP", "Host IP")}</span>
                <b className="mono">{agent.ip}</b>
              </div>
              <div>
                <span>{bi("主机名", "Hostname")}</span>
                <b className="mono">{probe?.hostname || "—"}</b>
              </div>
              <div>
                <span>{bi("操作系统", "OS")}</span>
                <b>{probe?.os || "—"}</b>
              </div>
              <div>
                <span>{bi("内核与架构", "Kernel & Arch")}</span>
                <b className="mono">
                  {[probe?.kernel, probe?.arch].filter(Boolean).join(" · ") || "—"}
                </b>
              </div>
              <div>
                <span>{bi("CPU 与负载", "CPU & Load")}</span>
                <b className="num">
                  {probe?.cpu_cores ? `${probe.cpu_cores} vCPU` : "—"}
                  {probe?.load1 !== undefined
                    ? ` · Load ${probe.load1.toFixed(2)} / ${(probe.load5 ?? 0).toFixed(2)}`
                    : ""}
                </b>
              </div>
              <div>
                <span>{bi("内存与根分区", "Memory & Root Disk")}</span>
                <b className="num">
                  {probe?.mem_used_pct !== undefined
                    ? `${memPct.toFixed(1)}%${memTotalGB > 0 ? ` (${memTotalGB.toFixed(1)}G)` : ""}`
                    : "—"}
                  {" / "}
                  {probe?.disk_used_pct !== undefined
                    ? `${diskPct.toFixed(1)}%${probe.disk_total_gb ? ` (${probe.disk_total_gb.toFixed(0)}G)` : ""}`
                    : "—"}
                </b>
              </div>
              <div>
                <span>{bi("系统运行时长", "System Uptime")}</span>
                <b className="num">{fmtUptime(probe?.uptime_sec) || "—"}</b>
              </div>
              <div>
                <span>{bi("Agent 服务与版本", "Service & Version")}</span>
                <b className="mono">
                  {agent.service_name || "middleware-execution"}
                  {agent.version ? ` · v${agent.version}` : ""}
                </b>
              </div>
            </div>
          </div>

          <div className="ua-pd-sec">
            <div className="ua-pd-sec-head">
              <h4>
                {bi("心跳上报流水记录", "Heartbeat Telemetry History")}{" "}
                <em className="num">{records.length}</em>
              </h4>
              <span className="faint small">
                {bi("按分钟聚合保留最近 90 条上报快照", "Minute-bucketed rolling 90 samples")}
              </span>
            </div>

            {records.length === 0 ? (
              <div className="ua-pd-empty">
                {bi(
                  "尚未收到该机器上报的心跳记录；安装启动 Agent 后将每 15 秒自动上报心跳与资源指标。",
                  "No heartbeats recorded yet. Reports automatically every 15s once started.",
                )}
              </div>
            ) : (
              <div className="ua-pd-log-wrap">
                <table className="ua-pd-log-table num">
                  <thead>
                    <tr>
                      <th>{bi("上报时间", "Timestamp")}</th>
                      <th>{bi("状态", "Status")}</th>
                      <th>{bi("CPU Load (1m)", "Load 1m")}</th>
                      <th>{bi("内存占用", "Memory")}</th>
                      <th>{bi("磁盘占用", "Disk")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r, i) => {
                      const high =
                        (r.mem_pct !== undefined && r.mem_pct >= 85) ||
                        (r.disk_pct !== undefined && r.disk_pct >= 90);
                      return (
                        <tr key={`${r.at}-${i}`}>
                          <td className="mono">{fullTime(r.at)}</td>
                          <td>
                            <span className={`ua-hb-tag ${high ? "is-warn" : "is-ok"}`}>
                              {high ? bi("高负载", "High Load") : bi("心跳正常", "Healthy")}
                            </span>
                          </td>
                          <td className="mono">
                            {r.load1 !== undefined ? r.load1.toFixed(2) : "—"}
                          </td>
                          <td className="mono">
                            {r.mem_pct !== undefined ? `${r.mem_pct.toFixed(1)}%` : "—"}
                          </td>
                          <td className="mono">
                            {r.disk_pct !== undefined ? `${r.disk_pct.toFixed(1)}%` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

export function ExecutionNodes({
  centerNav,
}: {
  centerNav?: React.ReactNode;
  initialRole?: string;
}) {
  useLang();
  const narrow = useMedia("(max-width: 900px)");
  const canManage = can("execution.manage");

  const [agents, setAgents] = useState<UnifiedAgentView[]>([]);
  const [manageableIds, setManageableIds] = useState<string[]>([]);
  const [rawCatalog, setRawCatalog] = useState<AgentClusterCatalogItem[]>([]);
  const [bootInfo, setBootInfo] = useState<AutomationBootstrapInfo | null>(null);
  const [clusters, setClusters] = useState<ClusterView[]>(
    () => cached<ClusterView[]>("clusters") || [],
  );
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string>("");
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});
  const [guideOpen, setGuideOpen] = useState(false);
  const [probeDrawerOpen, setProbeDrawerOpen] = useState(false);
  const [transferDrawerOpen, setTransferDrawerOpen] = useState(false);
  const [transferInitScope, setTransferInitScope] = useState<"all" | "same_ip">("all");
  const [boundSearch, setBoundSearch] = useState("");

  // Enroll Modal state
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollName, setEnrollName] = useState("");
  const [enrollIP, setEnrollIP] = useState("");
  const [enrollClusters, setEnrollClusters] = useState<string[]>([]);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<UnifiedEnrollment | null>(null);
  const [hubURL, setHubURL] = useState("");
  const [includeCA, setIncludeCA] = useState(true);
  const [bundleBusy, setBundleBusy] = useState(false);

  const searchRef = useRef<HTMLInputElement | null>(null);

  const setKeyBusy = (key: string, on: boolean) => {
    setBusyMap((prev) => {
      if (on) return { ...prev, [key]: true };
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const loadAll = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [res, cls] = await Promise.all([
        api<UnifiedAgentsResponse>("/api/executions/unified-agents"),
        api<ClusterView[]>("/api/clusters").catch(() => cached<ClusterView[]>("clusters") || []),
      ]);
      setAgents(res.agents || []);
      setManageableIds(res.manageable_clusters || []);
      if (res.cluster_catalog) setRawCatalog(res.cluster_catalog);
      setBootInfo(res.bootstrap || null);
      if (cls) {
        setClusters(cls);
        putCached("clusters", cls);
      }
      setLoadErr("");
      setSelectedId((prev) => {
        if (prev && (res.agents || []).some((a) => a.id === prev)) return prev;
        return res.agents?.[0]?.id || "";
      });
    } catch (e) {
      if (!silent) setLoadErr((e as Error).message || bi("加载失败", "Failed to load"));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll(false);
    const prefill = consumeAgentEnrollPrefill();
    if (prefill && canManage) {
      setEnrollName(prefill.host || "");
      setEnrollIP(prefill.ip || "");
      setEnrollClusters(prefill.cluster ? [prefill.cluster] : []);
      setEnrollment(null);
      setEnrollOpen(true);
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadAll(true);
    }, 6000);
    return () => window.clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enrollment) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadAll(true);
    }, 3000);
    return () => window.clearInterval(t);
  }, [enrollment]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        document.querySelector(".pal-mask,.arco-modal,.arco-drawer")
      )
        return;
      if (e.key === "/" && !typing(e)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const manageableSet = useMemo(() => new Set(manageableIds), [manageableIds]);

  const counts = useMemo(() => {
    let online = 0;
    let offline = 0;
    let disabled = 0;
    for (const a of agents) {
      if (a.disabled) disabled++;
      else if (a.online) online++;
      else offline++;
    }
    return { all: agents.length, online, offline, disabled };
  }, [agents]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      agents.filter((a) => {
        if (statusFilter === "online" && (a.disabled || !a.online)) return false;
        if (statusFilter === "offline" && (a.disabled || a.online)) return false;
        if (statusFilter === "disabled" && !a.disabled) return false;
        if (!q) return true;
        return (
          a.name.toLowerCase().includes(q) ||
          a.ip.toLowerCase().includes(q) ||
          a.clusters.some((c) => c.toLowerCase().includes(q)) ||
          (a.probe?.hostname || "").toLowerCase().includes(q)
        );
      }),
    [agents, statusFilter, q],
  );

  const selected = useMemo(
    () => agents.find((a) => a.id === selectedId) || filtered[0] || null,
    [agents, filtered, selectedId],
  );

  const openEnrollModal = () => {
    setEnrollName("");
    setEnrollIP("");
    setEnrollClusters([]);
    setEnrollment(null);
    const defURL =
      bootInfo?.suggested_urls?.[0] || bootInfo?.origin || window.location.origin;
    setHubURL(defURL);
    setIncludeCA(Boolean(bootInfo?.ca_available));
    setEnrollOpen(true);
  };

  const submitEnroll = async () => {
    if (enrollBusy) return;
    const name = enrollName.trim();
    const ip = enrollIP.trim();
    if (!name || !ip) {
      Message.warning(bi("请填写 Agent 名称和机器 IP 地址", "Enter Agent name and IP"));
      return;
    }
    setEnrollBusy(true);
    try {
      const res = await api<UnifiedEnrollment>("/api/executions/unified-agents", {
        method: "POST",
        body: JSON.stringify({
          name,
          ip,
          clusters: enrollClusters,
        }),
      });
      setEnrollment(res);
      const defURL =
        res.bootstrap?.suggested_urls?.[0] ||
        res.bootstrap?.origin ||
        window.location.origin;
      setHubURL(defURL);
      setIncludeCA(Boolean(res.bootstrap?.ca_available));
      await loadAll(true);
      setSelectedId(res.agent.id);
    } catch (e) {
      err(e);
    } finally {
      setEnrollBusy(false);
    }
  };

  const downloadBundle = async () => {
    if (!enrollment || bundleBusy) return;
    setBundleBusy(true);
    try {
      const resp = await fetch(withLang("/api/executions/unified-agents/bundle"), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken(),
        },
        body: JSON.stringify({
          agent_id: enrollment.agent.id,
          token: enrollment.token,
          url: hubURL.trim(),
          include_ca: includeCA,
        }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const slug = runnerSlug(enrollment.agent.name, enrollment.agent.ip);
      const fname = `ds-agent-${slug}.tar.gz`;
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(u);
      Message.success(bi(`已下载安装包 ${fname}`, `Downloaded ${fname}`));
    } catch (e) {
      err(e);
    } finally {
      setBundleBusy(false);
    }
  };

  const toggleDisabled = async (agent: UnifiedAgentView, nextDisabled: boolean) => {
    const k = `dis:${agent.id}`;
    if (busyMap[k]) return;
    setKeyBusy(k, true);
    try {
      const updated = await api<UnifiedAgentView>("/api/executions/unified-agents", {
        method: "PATCH",
        body: JSON.stringify({ id: agent.id, disabled: nextDisabled }),
      });
      setAgents((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      Message.success(
        nextDisabled
          ? bi(`已禁用 Agent「${agent.name}」`, `Disabled Agent "${agent.name}"`)
          : bi(`已启用 Agent「${agent.name}」`, `Enabled Agent "${agent.name}"`),
      );
    } catch (e) {
      err(e);
    } finally {
      setKeyBusy(k, false);
    }
  };

  const transferBind = async (agent: UnifiedAgentView, cids: string[]) => {
    if (cids.length === 0) return;
    const k = `xfer:${agent.id}`;
    if (busyMap[k]) return;
    setKeyBusy(k, true);
    try {
      const updated = await api<UnifiedAgentView>("/api/executions/unified-agents", {
        method: "PATCH",
        body: JSON.stringify({
          id: agent.id,
          bind_clusters: cids,
        }),
      });
      setAgents((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      Message.success(
        cids.length === 1
          ? bi(`已关联集群「${cids[0]}」`, `Associated "${cids[0]}"`)
          : bi(`已关联 ${cids.length} 个集群`, `Associated ${cids.length} clusters`),
      );
    } catch (e) {
      err(e);
    } finally {
      setKeyBusy(k, false);
    }
  };

  const transferUnbind = async (agent: UnifiedAgentView, cids: string[]) => {
    if (cids.length === 0) return;
    const k = `xfer:${agent.id}`;
    if (busyMap[k]) return;
    setKeyBusy(k, true);
    try {
      const updated = await api<UnifiedAgentView>("/api/executions/unified-agents", {
        method: "PATCH",
        body: JSON.stringify({
          id: agent.id,
          unbind_clusters: cids,
        }),
      });
      setAgents((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      Message.success(
        cids.length === 1
          ? bi(`已移除集群「${cids[0]}」关联`, `Removed "${cids[0]}"`)
          : bi(`已移除 ${cids.length} 个集群关联`, `Removed ${cids.length} clusters`),
      );
    } catch (e) {
      err(e);
    } finally {
      setKeyBusy(k, false);
    }
  };

  const removeAgent = async (agent: UnifiedAgentView) => {
    const k = `del:${agent.id}`;
    if (busyMap[k]) return;
    setKeyBusy(k, true);
    try {
      await api("/api/executions/unified-agents", {
        method: "DELETE",
        body: JSON.stringify({ id: agent.id }),
      });
      setAgents((prev) => prev.filter((x) => x.id !== agent.id));
      Message.success(bi(`已删除 Agent「${agent.name}」`, `Deleted "${agent.name}"`));
    } catch (e) {
      err(e);
    } finally {
      setKeyBusy(k, false);
    }
  };

  const enrolledLive = enrollment
    ? agents.find((a) => a.id === enrollment.agent.id)?.online
    : false;
  const bundleSlug = enrollment
    ? `ds-agent-${runnerSlug(enrollment.agent.name, enrollment.agent.ip)}`
    : "ds-agent";
  const installCmd = `tar -xzf ${bundleSlug}.tar.gz && sudo bash ${bundleSlug}/install.sh`;

  const showList = !narrow || !mobileShowDetail || !selected;
  const showDetail = !narrow || (mobileShowDetail && !!selected);

  return (
    <div className={narrow ? "" : "md-split"}>
      {showList && (
        <aside className="md-list" aria-label="Agent">
          <div className="list-head">
            <div className="list-title">
              <h1>{centerNav ? bi("执行中心", "Execution Center") : "Agent"}</h1>
              <div className="ua-list-title-acts">
                <Tooltip mini content={bi("刷新状态", "Refresh")}>
                  <Button
                    size="small"
                    type="text"
                    icon={<IconRefresh />}
                    onClick={() => void loadAll(false)}
                    aria-label={bi("刷新", "Refresh")}
                  />
                </Tooltip>
                {canManage && (
                  <Button
                    size="small"
                    type="primary"
                    icon={<IconPlus />}
                    onClick={openEnrollModal}
                  >
                    {bi("接入 Agent", "Enroll")}
                  </Button>
                )}
              </div>
            </div>

            {centerNav}

            <div className="search-row">
              <Input
                ref={(r) => {
                  searchRef.current =
                    (r as unknown as { dom?: HTMLInputElement })?.dom ?? null;
                }}
                prefix={<IconSearch />}
                suffix={!query ? <Kbd>/</Kbd> : undefined}
                allowClear
                value={query}
                onChange={setQuery}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setQuery("");
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                placeholder={bi("搜索 Agent 名称、IP 或集群…", "Search name, IP, or cluster…")}
              />
            </div>

            <div className="ec-role-pills" role="tablist">
              {(
                [
                  ["all", bi("全部", "All"), counts.all],
                  ["online", bi("在线", "Online"), counts.online],
                  ["offline", bi("离线", "Offline"), counts.offline],
                  ...(counts.disabled > 0
                    ? ([["disabled", bi("已禁用", "Disabled"), counts.disabled]] as [
                        StatusFilter,
                        string,
                        number,
                      ][])
                    : []),
                ] as [StatusFilter, string, number][]
              ).map(([k, lbl, cnt]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={statusFilter === k}
                  className={`ec-role-pill ${statusFilter === k ? "on" : ""}`}
                  onClick={() => setStatusFilter(k)}
                >
                  <span>{lbl}</span>
                  <em className="num">{cnt}</em>
                </button>
              ))}
            </div>
          </div>

          <div className="list-body">
            {loading && agents.length === 0 ? (
              <div style={{ padding: 16 }}>
                <Skeleton animation text={{ rows: 5 }} />
              </div>
            ) : filtered.length === 0 ? (
              <div className="ua-rail-empty">
                <p className="faint small">
                  {agents.length === 0
                    ? bi("尚未接入任何 Agent", "No Agents enrolled yet")
                    : bi("没有匹配的 Agent", "No matching Agents")}
                </p>
              </div>
            ) : (
              <div className="ec-rail-group">
                {filtered.map((a) => {
                  const active = selected?.id === a.id;
                  const dotCls = a.disabled
                    ? "is-disabled"
                    : a.online
                      ? "is-online"
                      : a.last_seen
                        ? "is-offline"
                        : "is-waiting";
                  const cCount = a.clusters.length;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className={`ec-rail-row ${active ? "on" : ""}`}
                      onClick={() => {
                        setSelectedId(a.id);
                        if (narrow) setMobileShowDetail(true);
                      }}
                    >
                      <span className={`ec-state-dot ${dotCls}`} />
                      <span className="ec-rail-row-body">
                        <span className="ec-rail-row-top">
                          <b>{a.name}</b>
                          <span
                            className={`ec-micro-pill num ${
                              a.disabled
                                ? ""
                                : cCount > 0
                                  ? "is-ok"
                                  : ""
                            }`}
                          >
                            {a.disabled
                              ? bi("已禁用", "Disabled")
                              : cCount > 0
                                ? bi(`${cCount} 集群`, `${cCount} cl`)
                                : bi("未关联", "Unbound")}
                          </span>
                        </span>
                        <span className="ec-rail-row-sub">
                          <code className="mono">{a.ip}</code>
                          <span>
                            {a.online && a.probe?.mem_used_pct !== undefined
                              ? `${a.probe.cpu_cores || "—"}C · ${a.probe.mem_used_pct.toFixed(0)}%`
                              : a.last_seen
                                ? ago(a.last_seen)
                                : bi("待安装", "Pending")}
                          </span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
      )}

      {showDetail && (
        <main className="md-detail">
          <article className="detail ec-detail-article">
            {narrow && (
              <Button
                type="text"
                className="back"
                icon={<IconArrowLeft />}
                onClick={() => setMobileShowDetail(false)}
              >
                Agent
              </Button>
            )}

            {loadErr && agents.length === 0 ? (
              <div className="ua-empty-state">
                <IconExclamationCircle className="bad" />
                <b>{loadErr}</b>
                <Button size="small" icon={<IconRefresh />} onClick={() => void loadAll(false)}>
                  {bi("重试", "Retry")}
                </Button>
              </div>
            ) : !selected ? (
              <div className="ua-empty-state">
                <IconThunderbolt />
                <h3>{bi("接入 Agent 以开启集群自动化执行", "Enroll an Agent to Automate Clusters")}</h3>
                <p className="faint">
                  {bi(
                    "部署 Agent 到机器并关联目标集群后，即可在对应集群内选择该 Agent 执行探针采集与变更步骤。",
                    "Deploy an Agent on a machine and associate clusters to run probes and change steps.",
                  )}
                </p>
                {canManage && (
                  <Button type="primary" icon={<IconPlus />} onClick={openEnrollModal}>
                    {bi("接入 Agent", "Enroll Agent")}
                  </Button>
                )}
              </div>
            ) : (
              <>
                <header className="ec-hero-head">
                  <span
                    className={`ec-hero-glyph ${
                      selected.online && !selected.disabled ? "is-target" : ""
                    }`}
                    aria-hidden
                  >
                    <IconThunderbolt />
                  </span>

                  <div className="ua-hero-main">
                    <div className="ua-detail-name-row">
                      <h1>{selected.name}</h1>
                      <StatusBadge
                        state={
                          selected.disabled
                            ? "disabled"
                            : selected.online
                              ? "online"
                              : selected.last_seen
                                ? "offline"
                                : "waiting"
                        }
                        label={
                          selected.disabled
                            ? bi("已禁用", "Disabled")
                            : selected.online
                              ? bi("在线", "Online")
                              : selected.last_seen
                                ? bi("离线", "Offline")
                                : bi("待安装", "Waiting")
                        }
                      />
                    </div>
                    <div className="ua-detail-meta">
                      <button
                        type="button"
                        className="ec-meta-copy mono"
                        onClick={() => copy(selected.ip, bi("已复制机器 IP", "Copied IP"))}
                      >
                        <span>{selected.ip}</span>
                        <IconCopy />
                      </button>
                      {selected.version && <span className="mono">v{selected.version}</span>}
                      <span>
                        {selected.last_seen
                          ? `${bi("最近心跳", "Heartbeat")} ${fullTime(selected.last_seen)}`
                          : bi("尚未上报心跳", "No heartbeat yet")}
                      </span>
                    </div>
                  </div>

                  <div className="detail-actions">
                    {canManage && (
                      <label className="ua-enable-toggle">
                        <span>
                          {selected.disabled ? bi("已禁用", "Disabled") : bi("已启用", "Enabled")}
                        </span>
                        <Switch
                          size="small"
                          checked={!selected.disabled}
                          loading={Boolean(busyMap[`dis:${selected.id}`])}
                          onChange={(checked) => void toggleDisabled(selected, !checked)}
                        />
                      </label>
                    )}
                    <Button
                      type="secondary"
                      icon={<IconBook />}
                      onClick={() => setGuideOpen(true)}
                    >
                      {bi("运维命令", "Ops Guide")}
                    </Button>
                    {canManage && (
                      <Popconfirm
                        position="br"
                        title={bi(
                          `确认删除 Agent「${selected.name}」？`,
                          `Delete Agent "${selected.name}"?`,
                        )}
                        content={bi(
                          "删除后该机器凭证立即失效，不再接收任何集群任务。",
                          "Credentials will be revoked immediately.",
                        )}
                        onOk={() => void removeAgent(selected)}
                      >
                        <Button
                          type="secondary"
                          status="danger"
                          loading={Boolean(busyMap[`del:${selected.id}`])}
                          icon={<IconDelete />}
                        >
                          {bi("删除", "Delete")}
                        </Button>
                      </Popconfirm>
                    )}
                  </div>
                </header>

                <div className="ec-detail-grid">
                  <div className="ec-detail-main">
                    <section className="ec-sec">
                      <HostProbeOverviewCard
                        agent={selected}
                        onOpenProbeDrawer={() => setProbeDrawerOpen(true)}
                        onOpenGuide={() => setGuideOpen(true)}
                      />
                    </section>

                    {(() => {
                      const effectiveCatalog: AgentClusterCatalogItem[] =
                        rawCatalog.length > 0
                          ? rawCatalog
                          : clusters.map((c) => ({
                              id: c.id,
                              app_name: c.app_name,
                              version: c.version,
                              platform: c.platform,
                              owner: c.owner,
                              can_op: manageableSet.has(c.id),
                            }));
                      const catalogById = new Map(
                        effectiveCatalog.map((c) => [c.id, c]),
                      );
                      const hasAnyOperable =
                        manageableSet.size > 0 ||
                        effectiveCatalog.some((c) => c.can_op);
                      const boundSet = new Set(selected.clusters);
                      const sameIPUnboundCount = effectiveCatalog.filter(
                        (c) =>
                          !boundSet.has(c.id) &&
                          (c.can_op || manageableSet.has(c.id)) &&
                          (c.host_ips?.includes(selected.ip) ||
                            selected.suggested_clusters?.includes(c.id)),
                      ).length;
                      const bkw = boundSearch.trim().toLowerCase();
                      const visibleBound = selected.clusters.filter((cid) => {
                        if (!bkw) return true;
                        const m = catalogById.get(cid);
                        return m ? matchClusterQuery(m, bkw) : cid.toLowerCase().includes(bkw);
                      });
                      const xferBusy = Boolean(busyMap[`xfer:${selected.id}`]);

                      return (
                        <section className="ec-sec">
                          <div className="ec-sec-head">
                            <div>
                              <h2 className="ec-sec-title">
                                {bi("已关联集群", "Associated Clusters")}{" "}
                                <em className="num">{selected.clusters.length}</em>
                              </h2>
                              <p className="ec-sec-sub">
                                {bi(
                                  "已关联的集群可直接在集群自动化与演练中选择此 Agent 执行探针与变更步骤。",
                                  "Associated clusters can select this Agent to run probes and change steps.",
                                )}
                              </p>
                            </div>
                            <div className="ua-sec-toolbar">
                              {selected.clusters.length >= 4 && (
                                <Input
                                  size="small"
                                  className="ua-bound-filter-in"
                                  prefix={<IconSearch />}
                                  allowClear
                                  value={boundSearch}
                                  onChange={setBoundSearch}
                                  placeholder={bi(
                                    "按集群名、IP 或中间件筛选…",
                                    "Filter by cluster, IP, or app…",
                                  )}
                                />
                              )}
                              {hasAnyOperable && (
                                <Button
                                  size="small"
                                  type={
                                    selected.clusters.length === 0
                                      ? "primary"
                                      : "secondary"
                                  }
                                  icon={
                                    selected.clusters.length === 0 ? (
                                      <IconPlus />
                                    ) : (
                                      <IconSettings />
                                    )
                                  }
                                  onClick={() => {
                                    setTransferInitScope("all");
                                    setTransferDrawerOpen(true);
                                  }}
                                >
                                  {selected.clusters.length === 0
                                    ? bi("关联集群", "Associate Clusters")
                                    : bi("配置关联集群", "Configure Clusters")}
                                </Button>
                              )}
                            </div>
                          </div>

                          {selected.clusters.length === 0 ? (
                            <div className="ua-bound-empty">
                              <div className="ua-bound-empty-txt">
                                <b>
                                  {bi(
                                    "当前 Agent 尚未关联任何集群",
                                    "No clusters associated with this Agent yet",
                                  )}
                                </b>
                                <span>
                                  {hasAnyOperable
                                    ? bi(
                                        "点击右侧按钮打开穿梭面板，可按集群标识、节点 IP、主机名或中间件批量检索关联。",
                                        "Open the transfer drawer to search by cluster ID, node IP, hostname, or middleware.",
                                      )
                                    : bi(
                                        "当前账户暂无可运维的集群，请联系集群创建者或管理员完成关联。",
                                        "No operable clusters available on your account.",
                                      )}
                                </span>
                                {sameIPUnboundCount > 0 && (
                                  <span className="ua-ip-match-hint">
                                    {bi(
                                      `检测到 ${sameIPUnboundCount} 个可运维集群的节点包含本机 IP（${selected.ip}）`,
                                      `${sameIPUnboundCount} operable cluster(s) match this machine's IP (${selected.ip})`,
                                    )}
                                  </span>
                                )}
                              </div>
                              {hasAnyOperable && (
                                <div className="ua-sec-toolbar">
                                  {sameIPUnboundCount > 0 && (
                                    <Button
                                      size="small"
                                      type="outline"
                                      onClick={() => {
                                        setTransferInitScope("same_ip");
                                        setTransferDrawerOpen(true);
                                      }}
                                    >
                                      {bi(
                                        `查看同机 IP 集群 (${sameIPUnboundCount})`,
                                        `View Same-IP (${sameIPUnboundCount})`,
                                      )}
                                    </Button>
                                  )}
                                  <Button
                                    size="small"
                                    type="primary"
                                    icon={<IconPlus />}
                                    onClick={() => {
                                      setTransferInitScope("all");
                                      setTransferDrawerOpen(true);
                                    }}
                                  >
                                    {bi("选择关联集群", "Select Clusters")}
                                  </Button>
                                </div>
                              )}
                            </div>
                          ) : visibleBound.length === 0 ? (
                            <div className="ua-pd-empty">
                              {bi("没有匹配的已关联集群", "No matching associated clusters")}
                            </div>
                          ) : (
                            <div className="ua-assoc-ledger" role="table">
                              <div className="ua-assoc-head" role="row">
                                <span>{bi("集群标识", "Cluster ID")}</span>
                                <span>{bi("中间件与系统", "Middleware & OS")}</span>
                                <span>{bi("集群节点 IP", "Cluster Node IPs")}</span>
                                <span>{bi("执行链路", "Execution Path")}</span>
                                <span>{bi("创建者", "Creator")}</span>
                                <span style={{ justifyContent: "flex-end" }}>
                                  {bi("操作", "Action")}
                                </span>
                              </div>
                              {visibleBound.map((cid) => {
                                const cMeta = catalogById.get(cid);
                                const canOp = Boolean(
                                  cMeta?.can_op || manageableSet.has(cid),
                                );
                                const isLocal = isSameMachineCluster(selected, cMeta);
                                const ips = cMeta?.host_ips || [];
                                return (
                                  <div key={cid} className="ua-assoc-row" role="row">
                                    <div>
                                      <a
                                        href={`#/d/${encodeURIComponent(cid)}`}
                                        className="ds-tf-link mono"
                                        title={cid}
                                        onClick={(e) => {
                                          e.preventDefault();
                                          go({ name: "deliveries", id: cid });
                                        }}
                                      >
                                        {cid}
                                      </a>
                                    </div>
                                    <div>
                                      {cMeta ? (
                                        <>
                                          <span className="iam-app-pill">
                                            {cMeta.app_name} {cMeta.version}
                                          </span>
                                          {cMeta.platform && (
                                            <span className="ua-plat-sub">
                                              {platformShort(cMeta.platform)}
                                            </span>
                                          )}
                                        </>
                                      ) : (
                                        <span className="faint small">—</span>
                                      )}
                                    </div>
                                    <div className="ua-assoc-ips">
                                      {ips.length > 0 ? (
                                        <>
                                          {ips.slice(0, 3).map((ip) => (
                                            <code
                                              key={ip}
                                              className={`ua-ip-chip mono ${
                                                ip === selected.ip ? "is-match" : ""
                                              }`}
                                            >
                                              {ip}
                                            </code>
                                          ))}
                                          {ips.length > 3 && (
                                            <Tooltip
                                              mini
                                              content={ips.slice(3).join(", ")}
                                            >
                                              <span className="ua-plat-sub num">
                                                +{ips.length - 3}
                                              </span>
                                            </Tooltip>
                                          )}
                                        </>
                                      ) : (
                                        <span className="faint small">—</span>
                                      )}
                                    </div>
                                    <div>
                                      <span
                                        className={`ua-path-badge ${
                                          isLocal ? "is-local" : ""
                                        }`}
                                      >
                                        {isLocal
                                          ? bi("本机免密直连", "Local Direct")
                                          : bi("SSH 远程代管", "Jumpbox SSH")}
                                      </span>
                                    </div>
                                    <div>
                                      {cMeta?.owner ? (
                                        <span className="ua-plat-sub">
                                          {cMeta.owner}
                                        </span>
                                      ) : (
                                        <span className="faint small">—</span>
                                      )}
                                    </div>
                                    <div>
                                      <Button
                                        size="mini"
                                        type="text"
                                        onClick={() =>
                                          go({ name: "deliveries", id: cid })
                                        }
                                      >
                                        {bi("打开", "Open")} <IconRight />
                                      </Button>
                                      {canOp && (
                                        <Button
                                          size="mini"
                                          type="secondary"
                                          status="danger"
                                          disabled={xferBusy}
                                          onClick={() =>
                                            void transferUnbind(selected, [cid])
                                          }
                                        >
                                          {bi("解除", "Unbind")}
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </section>
                      );
                    })()}
                  </div>
                </div>
              </>
            )}
          </article>
        </main>
      )}

      <AgentClusterTransferDrawer
        agent={selected}
        visible={transferDrawerOpen}
        catalog={
          rawCatalog.length > 0
            ? rawCatalog
            : clusters.map((c) => ({
                id: c.id,
                app_name: c.app_name,
                version: c.version,
                platform: c.platform,
                owner: c.owner,
                can_op: manageableSet.has(c.id),
              }))
        }
        manageableSet={manageableSet}
        busy={Boolean(selected && busyMap[`xfer:${selected.id}`])}
        initialScope={transferInitScope}
        onClose={() => setTransferDrawerOpen(false)}
        onBind={(cids) => {
          if (selected) void transferBind(selected, cids);
        }}
        onUnbind={(cids) => {
          if (selected) void transferUnbind(selected, cids);
        }}
      />

      <HeartbeatAndProbeDrawer
        agent={selected}
        visible={probeDrawerOpen}
        onClose={() => setProbeDrawerOpen(false)}
      />

      <EnrollAgentModal
        visible={enrollOpen}
        onClose={() => setEnrollOpen(false)}
        defaultClusterId={enrollClusters[0]}
        defaultHostName={enrollName}
        defaultHostIP={enrollIP}
        initialCatalog={
          rawCatalog.length > 0
            ? rawCatalog
            : clusters.map((c) => ({
                id: c.id,
                app_name: c.app_name,
                version: c.version,
                platform: c.platform,
                owner: c.owner,
                can_op: manageableSet.has(c.id),
              }))
        }
        initialBootstrap={bootInfo}
        onEnrolled={(ag) => {
          void loadAll(true);
          setSelectedId(ag.id);
        }}
      />

      <Drawer
        width={480}
        style={{ maxWidth: "100vw" }}
        visible={guideOpen}
        onCancel={() => setGuideOpen(false)}
        footer={null}
        title={bi("Agent 日常运维命令", "Agent Maintenance Commands")}
      >
        {selected && (
          <div className="ua-guide-drawer">
            <CommandBlock
              title={bi("查看运行状态与实时日志", "Check systemd status & live logs")}
              code={`sudo systemctl status ${selected.service_name || "middleware-execution"}\nsudo journalctl -u ${selected.service_name || "middleware-execution"} -f`}
            />
            <CommandBlock
              title={bi("重启 Agent 服务", "Restart Agent service")}
              code={`sudo systemctl restart ${selected.service_name || "middleware-execution"}`}
            />
            <CommandBlock
              title={bi("彻底卸载清理", "Uninstall Agent")}
              code={`sudo systemctl disable --now ${selected.service_name || "middleware-execution"}\nsudo rm -f /etc/systemd/system/${selected.service_name || "middleware-execution"}.service\nsudo systemctl daemon-reload`}
            />
          </div>
        )}
      </Drawer>
    </div>
  );
}

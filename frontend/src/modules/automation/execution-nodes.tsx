import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Drawer,
  Input,
  Message,
  Modal,
  Popconfirm,
  Popover,
  Select,
  Skeleton,
  Switch,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconBook,
  IconCheck,
  IconCheckCircle,
  IconClose,
  IconCopy,
  IconDelete,
  IconDesktop,
  IconDownload,
  IconExclamationCircle,
  IconLoading,
  IconPlus,
  IconRefresh,
  IconRight,
  IconSearch,
  IconStorage,
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
  putCached,
  typing,
  useMedia,
} from "../../shared/shared";
import { go } from "../../app/router";
import { Kbd } from "../../design/ui";
import { bi, useLang, withLang } from "../../app/i18n";
import { invalidateIAMCache } from "../iam/iam";
import {
  AgentClusterMode,
  AgentHostProbe,
  AutomationBootstrapInfo,
  UnifiedAgentView,
  consumeAgentEnrollPrefill,
} from "./execution-types";
import "./executions.css";
import "./execution-center.css";
import "./rehearsal-automation.css";

type StatusFilter = "all" | "online" | "offline" | "disabled";

type UnifiedAgentsResponse = {
  agents: UnifiedAgentView[];
  bootstrap: AutomationBootstrapInfo;
};

type UnifiedEnrollment = {
  agent: UnifiedAgentView;
  token: string;
  bootstrap: AutomationBootstrapInfo;
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
  if (!sec || sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return bi(`${d}天 ${h}小时`, `${d}d ${h}h`);
  if (h > 0) return bi(`${h}小时 ${m}分`, `${h}h ${m}m`);
  return bi(`${Math.max(1, m)}分钟`, `${Math.max(1, m)}m`);
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

/** Apple-style gliding 3-state switch for Agent per-cluster authorization: Disabled / Read-only / Read-write */
export function AgentModeSwitch({
  value,
  disabled,
  onChange,
}: {
  value: "" | AgentClusterMode;
  disabled?: boolean;
  onChange: (next: "" | AgentClusterMode) => void;
}) {
  useLang();
  const idx = value === "readwrite" ? 2 : value === "readonly" ? 1 : 0;
  return (
    <span
      className={`iam-tri-switch ${disabled ? "is-disabled" : ""} idx-${idx}`}
      style={{ "--tri-idx": idx } as React.CSSProperties}
      role="radiogroup"
      aria-label={bi("Agent 集群权限", "Agent cluster permission")}
    >
      <button
        type="button"
        role="radio"
        aria-checked={value === ""}
        disabled={disabled}
        className={value === "" ? "on is-none" : ""}
        onClick={() => onChange("")}
      >
        {bi("禁用", "Off")}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "readonly"}
        disabled={disabled}
        className={value === "readonly" ? "on is-view" : ""}
        onClick={() => onChange("readonly")}
      >
        {bi("只读", "RO")}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "readwrite"}
        disabled={disabled}
        className={value === "readwrite" ? "on is-op" : ""}
        onClick={() => onChange("readwrite")}
      >
        {bi("读写", "RW")}
      </button>
    </span>
  );
}

function ProbeStrip({ probe, lastSeen }: { probe?: AgentHostProbe; lastSeen?: string }) {
  useLang();
  if (!probe && !lastSeen) {
    return (
      <div className="ua-probe-empty">
        <IconExclamationCircle />
        <span>
          {bi(
            "尚未收到首次心跳上报。在机器上运行安装脚本后，将每 15 秒实时同步 CPU、内存、磁盘与系统状态。",
            "Waiting for first heartbeat. Once installed, host CPU, memory, disk, and OS telemetry sync every 15s.",
          )}
        </span>
      </div>
    );
  }
  const memTotalGB = probe?.mem_total_mb ? (probe.mem_total_mb / 1024).toFixed(1) : "";
  return (
    <div className="ua-probe-strip">
      <div className="ua-probe-cell">
        <span className="ua-probe-lbl">{bi("主机与系统", "Host & OS")}</span>
        <b className="ua-probe-val">{probe?.hostname || "—"}</b>
        <small className="ua-probe-sub">
          {[probe?.os, probe?.kernel].filter(Boolean).join(" · ") || bi("等待探针同步", "Pending")}
        </small>
      </div>
      <div className="ua-probe-cell">
        <span className="ua-probe-lbl">{bi("CPU 与负载", "CPU & Load")}</span>
        <b className="ua-probe-val num">
          {probe?.cpu_cores ? bi(`${probe.cpu_cores} 核`, `${probe.cpu_cores} vCPU`) : "—"}
        </b>
        <small className="ua-probe-sub num">
          {probe?.load1 !== undefined
            ? `Load ${probe.load1.toFixed(2)} / ${(probe.load5 ?? 0).toFixed(2)}`
            : "—"}
        </small>
      </div>
      <div className="ua-probe-cell">
        <span className="ua-probe-lbl">{bi("内存使用", "Memory")}</span>
        <b className="ua-probe-val num">
          {probe?.mem_used_pct !== undefined ? `${probe.mem_used_pct.toFixed(1)}%` : "—"}
        </b>
        <small className="ua-probe-sub num">
          {memTotalGB ? bi(`共 ${memTotalGB} GB`, `${memTotalGB} GB total`) : "—"}
        </small>
      </div>
      <div className="ua-probe-cell">
        <span className="ua-probe-lbl">{bi("根分区与在线时长", "Disk & Uptime")}</span>
        <b className="ua-probe-val num">
          {probe?.disk_used_pct !== undefined ? `${probe.disk_used_pct.toFixed(1)}%` : "—"}
        </b>
        <small className="ua-probe-sub num">
          {probe?.disk_total_gb
            ? `${probe.disk_total_gb.toFixed(0)} GB · ${fmtUptime(probe.uptime_sec)}`
            : lastSeen
              ? `${bi("心跳", "Seen")} ${ago(lastSeen)}`
              : "—"}
        </small>
      </div>
    </div>
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
  const canGrant = can("execution.manage|iam.user|iam.team");

  const [agents, setAgents] = useState<UnifiedAgentView[]>([]);
  const [bootInfo, setBootInfo] = useState<AutomationBootstrapInfo | null>(null);
  const [clusters, setClusters] = useState<ClusterView[]>(
    () => cached<ClusterView[]>("clusters") || [],
  );
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string>("");
  const [busyKey, setBusyKey] = useState<string>("");
  const [guideOpen, setGuideOpen] = useState(false);

  // Enroll Modal state
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollName, setEnrollName] = useState("");
  const [enrollIP, setEnrollIP] = useState("");
  const [enrollClusters, setEnrollClusters] = useState<string[]>([]);
  const [enrollMode, setEnrollMode] = useState<AgentClusterMode>("readwrite");
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<UnifiedEnrollment | null>(null);
  const [hubURL, setHubURL] = useState("");
  const [includeCA, setIncludeCA] = useState(true);
  const [bundleBusy, setBundleBusy] = useState(false);

  // Add cluster popover
  const [addPopOpen, setAddPopOpen] = useState(false);
  const [addClusterKw, setAddClusterKw] = useState("");

  const searchRef = useRef<HTMLInputElement | null>(null);

  const loadAll = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [res, cls] = await Promise.all([
        api<UnifiedAgentsResponse>("/api/executions/unified-agents"),
        api<ClusterView[]>("/api/clusters").catch(() => cached<ClusterView[]>("clusters") || []),
      ]);
      setAgents(res.agents || []);
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
      setEnrollMode("readwrite");
      setEnrollment(null);
      setEnrollOpen(true);
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadAll(true);
    }, 6000);
    return () => window.clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fast 3s poll while waiting for newly enrolled Agent to come online
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

  const clusterById = useMemo(
    () => new Map(clusters.map((c) => [c.id, c])),
    [clusters],
  );

  const openEnrollModal = () => {
    setEnrollName("");
    setEnrollIP("");
    setEnrollClusters([]);
    setEnrollMode("readwrite");
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
      const clusterModes: Record<string, AgentClusterMode> = {};
      for (const cid of enrollClusters) clusterModes[cid] = enrollMode;
      const res = await api<UnifiedEnrollment>("/api/executions/unified-agents", {
        method: "POST",
        body: JSON.stringify({
          name,
          ip,
          cluster_modes: clusterModes,
        }),
      });
      setEnrollment(res);
      const defURL =
        res.bootstrap?.suggested_urls?.[0] ||
        res.bootstrap?.origin ||
        window.location.origin;
      setHubURL(defURL);
      setIncludeCA(Boolean(res.bootstrap?.ca_available));
      invalidateIAMCache();
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
    if (busyKey) return;
    setBusyKey(`dis:${agent.id}`);
    try {
      const updated = await api<UnifiedAgentView>("/api/executions/unified-agents", {
        method: "PATCH",
        body: JSON.stringify({ id: agent.id, disabled: nextDisabled }),
      });
      setAgents((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      invalidateIAMCache();
      Message.success(
        nextDisabled
          ? bi(`已禁用 Agent「${agent.name}」`, `Disabled Agent "${agent.name}"`)
          : bi(`已启用 Agent「${agent.name}」`, `Enabled Agent "${agent.name}"`),
      );
    } catch (e) {
      err(e);
    } finally {
      setBusyKey("");
    }
  };

  const updateClusterMode = async (
    agent: UnifiedAgentView,
    clusterId: string,
    mode: "" | AgentClusterMode,
  ) => {
    if (busyKey) return;
    setBusyKey(`cm:${agent.id}:${clusterId}`);
    try {
      const updated = await api<UnifiedAgentView>("/api/executions/unified-agents", {
        method: "PATCH",
        body: JSON.stringify({
          id: agent.id,
          set_cluster: { cluster_id: clusterId, mode },
        }),
      });
      setAgents((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      invalidateIAMCache();
    } catch (e) {
      err(e);
    } finally {
      setBusyKey("");
    }
  };

  const removeAgent = async (agent: UnifiedAgentView) => {
    if (busyKey) return;
    setBusyKey(`del:${agent.id}`);
    try {
      await api("/api/executions/unified-agents", {
        method: "DELETE",
        body: JSON.stringify({ id: agent.id }),
      });
      setAgents((prev) => prev.filter((x) => x.id !== agent.id));
      invalidateIAMCache();
      Message.success(bi(`已删除 Agent「${agent.name}」`, `Deleted "${agent.name}"`));
    } catch (e) {
      err(e);
    } finally {
      setBusyKey("");
    }
  };

  const enrolledLive = enrollment
    ? agents.find((a) => a.id === enrollment.agent.id)?.online
    : false;
  const bundleSlug = enrollment
    ? `ds-agent-${runnerSlug(enrollment.agent.name, enrollment.agent.ip)}`
    : "ds-agent";
  const installCmd = `tar -xzf ${bundleSlug}.tar.gz && sudo bash ${bundleSlug}/install.sh`;

  const unassignedClusters = useMemo(() => {
    if (!selected) return [];
    const aq = addClusterKw.trim().toLowerCase();
    return clusters.filter(
      (c) =>
        !selected.cluster_modes?.[c.id] &&
        (!aq ||
          c.id.toLowerCase().includes(aq) ||
          c.app_name.toLowerCase().includes(aq)),
    );
  }, [clusters, selected, addClusterKw]);

  return (
    <div className={`ec-shell ua-shell ${narrow ? "is-narrow" : ""}`}>
      <aside className="ec-rail ua-rail" aria-label="Agent">
        <div className="ec-rail-top">
          <div className="ec-rail-title-row">
            <h2>{bi("执行中心", "Execution")}</h2>
            <div className="ec-rail-actions">
              <Tooltip mini content={bi("刷新状态", "Refresh")}>
                <Button
                  size="mini"
                  type="text"
                  icon={<IconRefresh />}
                  onClick={() => void loadAll(false)}
                />
              </Tooltip>
              {canManage && (
                <Button
                  size="small"
                  type="primary"
                  icon={<IconPlus />}
                  onClick={openEnrollModal}
                >
                  {bi("接入 Agent", "Add Agent")}
                </Button>
              )}
            </div>
          </div>
          {centerNav}
        </div>

        <div className="ua-rail-filters">
          <Input
            ref={(r) => {
              searchRef.current =
                (r as unknown as { dom?: HTMLInputElement })?.dom ?? null;
            }}
            size="small"
            prefix={<IconSearch />}
            suffix={!query ? <Kbd>/</Kbd> : undefined}
            allowClear
            value={query}
            onChange={setQuery}
            placeholder={bi("搜索 Agent 名称、IP 或集群…", "Search name, IP, or cluster…")}
          />
          <div className="ua-filter-pills" role="tablist">
            {(
              [
                ["all", bi("全部", "All"), counts.all],
                ["online", bi("在线", "Online"), counts.online],
                ["offline", bi("离线", "Offline"), counts.offline],
                ["disabled", bi("已禁用", "Disabled"), counts.disabled],
              ] as [StatusFilter, string, number][]
            ).map(([k, lbl, cnt]) => (
              <button
                key={k}
                type="button"
                className={`ua-fpill ${statusFilter === k ? "on" : ""}`}
                onClick={() => setStatusFilter(k)}
              >
                <span>{lbl}</span>
                <em className="num">{cnt}</em>
              </button>
            ))}
          </div>
        </div>

        <div className="ua-rail-list">
          {loading && agents.length === 0 ? (
            <div style={{ padding: 14 }}>
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
            filtered.map((a) => {
              const active = selected?.id === a.id;
              const dotCls = a.disabled
                ? "is-disabled"
                : a.online
                  ? "is-online"
                  : "is-offline";
              const cCount = a.clusters.length;
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`ua-rail-item ${active ? "on" : ""}`}
                  onClick={() => setSelectedId(a.id)}
                >
                  <span className={`ua-dot ${dotCls}`} />
                  <span className="ua-rail-item-body">
                    <span className="ua-rail-item-top">
                      <b>{a.name}</b>
                      <small className="num">
                        {a.disabled
                          ? bi("已禁用", "Disabled")
                          : cCount > 0
                            ? bi(`${cCount} 集群`, `${cCount} cl`)
                            : bi("未关联集群", "Unbound")}
                      </small>
                    </span>
                    <span className="ua-rail-item-sub">
                      <code className="mono">{a.ip}</code>
                      <span>
                        {a.online && a.probe?.mem_used_pct !== undefined
                          ? `CPU ${a.probe.cpu_cores || "—"}C · Mem ${a.probe.mem_used_pct.toFixed(0)}%`
                          : a.last_seen
                            ? ago(a.last_seen)
                            : bi("待安装", "Pending")}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <main className="ec-main ua-main">
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
            <h3>{bi("部署 Agent 后即可按集群一键自动执行", "Enroll an Agent to Automate Clusters")}</h3>
            <p className="faint">
              {bi(
                "支持两种现场模式：在 1 台管理/跳板机部署 Agent 代管多个集群（SSH / Ansible），或直接在业务目标机部署 Agent 免密码直连执行。",
                "Deploy 1 Agent on a management host to manage multiple clusters over SSH/Ansible, or install directly on target hosts for passwordless execution.",
              )}
            </p>
            {canManage && (
              <Button type="primary" icon={<IconPlus />} onClick={openEnrollModal}>
                {bi("接入第一台 Agent", "Enroll First Agent")}
              </Button>
            )}
          </div>
        ) : (
          <div className="ua-detail">
            <header className="ua-detail-head">
              <div className="ua-detail-title">
                <div className="ua-detail-name-row">
                  <h1>{selected.name}</h1>
                  <span
                    className={`ua-status-pill ${
                      selected.disabled
                        ? "is-disabled"
                        : selected.online
                          ? "is-online"
                          : "is-offline"
                    }`}
                  >
                    <i />
                    {selected.disabled
                      ? bi("已禁用", "Disabled")
                      : selected.online
                        ? bi("在线运行中", "Online")
                        : selected.last_seen
                          ? bi("离线", "Offline")
                          : bi("等待安装上线", "Waiting")}
                  </span>
                </div>
                <div className="ua-detail-meta">
                  <button
                    type="button"
                    className="ua-ip-chip mono"
                    onClick={() => copy(selected.ip, bi("已复制机器 IP", "Copied IP"))}
                  >
                    <span>{selected.ip}</span>
                    <IconCopy />
                  </button>
                  {selected.version && <span className="mono">v{selected.version}</span>}
                  <span>
                    {selected.last_seen
                      ? `${bi("最近心跳", "Last heartbeat")} ${fullTime(selected.last_seen)}`
                      : bi("尚未上报心跳", "No heartbeat yet")}
                  </span>
                </div>
              </div>

              <div className="ua-detail-acts">
                {canManage && (
                  <label className="ua-enable-toggle">
                    <span>{selected.disabled ? bi("已禁用", "Disabled") : bi("已启用", "Enabled")}</span>
                    <Switch
                      size="small"
                      checked={!selected.disabled}
                      loading={busyKey === `dis:${selected.id}`}
                      onChange={(checked) => void toggleDisabled(selected, !checked)}
                    />
                  </label>
                )}
                <Button
                  size="small"
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
                      size="small"
                      type="secondary"
                      status="danger"
                      loading={busyKey === `del:${selected.id}`}
                      icon={<IconDelete />}
                    />
                  </Popconfirm>
                )}
              </div>
            </header>

            <section className="ua-sec">
              <div className="ua-sec-head">
                <h2>{bi("实时主机探针", "Live Host Telemetry")}</h2>
              </div>
              <ProbeStrip probe={selected.probe} lastSeen={selected.last_seen} />
            </section>

            <section className="ua-sec">
              <div className="ua-sec-head">
                <div>
                  <h2>
                    {bi("关联集群与执行权限", "Cluster Permissions")}{" "}
                    <em className="num">{selected.clusters.length}</em>
                  </h2>
                  <p className="faint small">
                    {bi(
                      "与「IAM → 集群权限」双向实时同步。设为「只读」仅允许跑巡检探针；设为「读写」可执行部署、变更演练与回滚。",
                      "Synced live with IAM → Cluster Permissions. Read-only allows probes; Read-write allows deployments & change steps.",
                    )}
                  </p>
                </div>
                <div className="ua-sec-head-acts">
                  {canGrant && clusters.length > 0 && (
                    <Popover
                      trigger="click"
                      position="br"
                      popupVisible={addPopOpen}
                      onVisibleChange={(v) => {
                        setAddPopOpen(v);
                        if (!v) setAddClusterKw("");
                      }}
                      unmountOnExit
                      content={
                        <div className="iam-quick-pop">
                          <div className="iam-quick-pop-head">
                            <b>{bi("关联到集群", "Authorize Cluster")}</b>
                          </div>
                          {clusters.length > 5 && (
                            <Input
                              size="small"
                              prefix={<IconSearch />}
                              allowClear
                              value={addClusterKw}
                              onChange={setAddClusterKw}
                              placeholder={bi("搜索集群…", "Search cluster…")}
                            />
                          )}
                          <div className="iam-quick-pop-list">
                            {unassignedClusters.length === 0 ? (
                              <p className="faint small" style={{ margin: "10px 4px", textAlign: "center" }}>
                                {bi("全部可见集群均已关联", "All visible clusters are already bound")}
                              </p>
                            ) : (
                              unassignedClusters.map((c) => (
                                <div key={c.id} className="iam-quick-pop-row">
                                  <span className="iam-quick-pop-who">
                                    <IconStorage />
                                    <b className="mono">{c.id}</b>
                                  </span>
                                  <span className="iam-quick-pop-btns">
                                    <button
                                      type="button"
                                      disabled={!!busyKey}
                                      className="iam-lvl-tag is-view is-btn"
                                      onClick={() => {
                                        setAddPopOpen(false);
                                        void updateClusterMode(selected, c.id, "readonly");
                                      }}
                                    >
                                      {bi("+ 只读", "+ RO")}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={!!busyKey}
                                      className="iam-lvl-tag is-operate is-btn"
                                      onClick={() => {
                                        setAddPopOpen(false);
                                        void updateClusterMode(selected, c.id, "readwrite");
                                      }}
                                    >
                                      {bi("+ 读写", "+ RW")}
                                    </button>
                                  </span>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      }
                    >
                      <Button size="small" type="primary" icon={<IconPlus />}>
                        {bi("关联集群", "Add Cluster")}
                      </Button>
                    </Popover>
                  )}
                  <Button
                    size="small"
                    type="text"
                    onClick={() => go({ name: "accounts", id: "~clusters" })}
                  >
                    {bi("前往集群权限全景 →", "Open IAM Cluster Matrix →")}
                  </Button>
                </div>
              </div>

              {selected.clusters.length === 0 ? (
                <div className="ua-cluster-empty">
                  <span className="faint">
                    {bi(
                      "当前 Agent 尚未关联任何集群；点击右上角「关联集群」或在「IAM → 集群权限」中分配后即可在集群内选择执行。",
                      "Not bound to any cluster yet. Click Add Cluster above or configure in IAM → Cluster Permissions.",
                    )}
                  </span>
                  {canGrant &&
                    (selected.suggested_clusters || []).length > 0 && (
                      <div className="ua-suggest-bar">
                        <span className="small faint">
                          {bi("检测到包含该 IP 的集群：", "Matching IP found in:")}
                        </span>
                        {(selected.suggested_clusters || []).map((cid) => (
                          <button
                            key={cid}
                            type="button"
                            className="iam-add-grant-chip"
                            onClick={() =>
                              void updateClusterMode(selected, cid, "readwrite")
                            }
                          >
                            <IconPlus />
                            <span className="mono">{cid}</span>
                            <em>{bi("关联读写", "Bind RW")}</em>
                          </button>
                        ))}
                      </div>
                    )}
                </div>
              ) : (
                <div className="ua-cluster-ledger">
                  {selected.clusters.map((cid) => {
                    const mode = selected.cluster_modes[cid] || "readonly";
                    const cMeta = clusterById.get(cid);
                    const isLocalHost = Boolean(
                      selected.suggested_clusters?.includes(cid),
                    );
                    const rowBusy = busyKey === `cm:${selected.id}:${cid}`;
                    return (
                      <div
                        key={cid}
                        className={`ua-cluster-row ${rowBusy ? "is-busy" : ""}`}
                      >
                        <div className="ua-cluster-info">
                          <a
                            href={`#/d/${encodeURIComponent(cid)}`}
                            className="ua-cluster-link mono"
                            onClick={(e) => {
                              e.preventDefault();
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
                          <span className={`ua-path-badge ${isLocalHost ? "is-local" : ""}`}>
                            {isLocalHost
                              ? bi("本机免密直连", "Local Direct")
                              : bi("远程代管 (SSH / Ansible)", "Remote Jumpbox")}
                          </span>
                        </div>
                        <div className="ua-cluster-ctrl">
                          <AgentModeSwitch
                            value={mode}
                            disabled={!canGrant || !!busyKey}
                            onChange={(next) =>
                              void updateClusterMode(selected, cid, next)
                            }
                          />
                          <button
                            type="button"
                            className="iam-row-go"
                            aria-label={cid}
                            onClick={() => go({ name: "deliveries", id: cid })}
                          >
                            <IconRight />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      <Modal
        visible={enrollOpen}
        onCancel={() => setEnrollOpen(false)}
        footer={null}
        style={{ width: 580, maxWidth: "94vw" }}
        title={
          enrollment
            ? bi("安装并启动 Agent", "Install & Start Agent")
            : bi("接入 Agent", "Enroll Agent")
        }
      >
        {!enrollment ? (
          <div className="ua-enroll-form">
            <p className="ua-enroll-lead">
              {bi(
                "统一 Agent 同时支持两种部署位置：装在 1 台管理机上可代管多个集群；直接装在业务目标机上则自动走本机免密直连。",
                "Install on a management host to manage multiple clusters over SSH/Ansible, or directly on a target host for passwordless local execution.",
              )}
            </p>
            <div className="ua-form-grid">
              <label className="ua-field">
                <span>{bi("Agent 名称", "Agent Name")}</span>
                <Input
                  value={enrollName}
                  onChange={setEnrollName}
                  placeholder={bi("如 prod-jumpbox-01 或 db-node-01", "e.g. prod-jumpbox-01 or db-node-01")}
                />
              </label>
              <label className="ua-field">
                <span>{bi("机器 IP 地址", "Host IP Address")}</span>
                <Input
                  value={enrollIP}
                  onChange={setEnrollIP}
                  placeholder={bi("部署该 Agent 的机器网卡 IP", "IP address of the machine")}
                />
              </label>
            </div>

            {clusters.length > 0 && (
              <label className="ua-field">
                <div className="ua-field-head">
                  <span>{bi("关联集群（可选，后续可随时在集群权限中调整）", "Initial Clusters (Optional)")}</span>
                  {enrollClusters.length > 0 && (
                    <AgentModeSwitch
                      value={enrollMode}
                      onChange={(m) => {
                        if (m) setEnrollMode(m);
                      }}
                    />
                  )}
                </div>
                <Select
                  mode="multiple"
                  allowClear
                  value={enrollClusters}
                  onChange={setEnrollClusters}
                  placeholder={bi("选择要关联授权的集群…", "Select clusters to authorize…")}
                  options={clusters.map((c) => ({
                    value: c.id,
                    label: `${c.id} · ${c.app_name} ${c.version}`,
                  }))}
                />
              </label>
            )}

            <div className="ua-modal-foot">
              <Button onClick={() => setEnrollOpen(false)}>{bi("取消", "Cancel")}</Button>
              <Button
                type="primary"
                loading={enrollBusy}
                onClick={() => void submitEnroll()}
              >
                {bi("下一步：生成安装命令", "Next: Generate Installer")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="ua-enroll-step2">
            <div className={`ua-live-banner ${enrolledLive ? "is-ok" : ""}`}>
              {enrolledLive ? <IconCheckCircle /> : <IconLoading />}
              <div>
                <b>
                  {enrolledLive
                    ? bi("Agent 已成功连接上线！", "Agent Connected & Online!")
                    : bi("等待机器执行安装脚本并上报首次心跳…", "Waiting for Agent installation & first heartbeat…")}
                </b>
                <small>
                  {enrollment.agent.name} ({enrollment.agent.ip})
                </small>
              </div>
            </div>

            <label className="ua-field">
              <span>{bi("Agent 回连平台的 HTTPS 地址", "Platform HTTPS URL")}</span>
              <Input
                value={hubURL}
                onChange={setHubURL}
                placeholder="https://192.168.1.10:8443"
              />
              {isLoopbackURL(hubURL) && (
                <small className="warn">
                  {bi(
                    "注意：127.0.0.1 仅适用于本机测试，远程机器请改为平台实际内网 IP 地址。",
                    "127.0.0.1 only works on the same host; use a reachable LAN IP for remote machines.",
                  )}
                </small>
              )}
            </label>

            <div className="ua-bundle-box">
              <Button
                type="primary"
                icon={<IconDownload />}
                loading={bundleBusy}
                onClick={() => void downloadBundle()}
              >
                {bi("1. 下载自包含安装包 (.tar.gz)", "1. Download Installer Bundle (.tar.gz)")}
              </Button>
              <span className="faint small">
                {bi("内含 Linux amd64 二进制、0600 凭证与 systemd 服务脚本", "Includes binary, 0600 credentials & systemd unit")}
              </span>
            </div>

            <CommandBlock
              title={bi("2. 上传至目标机器后执行一键安装命令", "2. Upload to machine and run installer")}
              code={installCmd}
            />

            <div className="ua-modal-foot">
              <Button type="primary" onClick={() => setEnrollOpen(false)}>
                {enrolledLive ? bi("完成", "Done") : bi("稍后在后台自动连接", "Close")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

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

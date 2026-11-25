import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Drawer,
  Input,
  InputNumber,
  Message,
  Popconfirm,
  Select,
  Skeleton,
  Switch,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconCheck,
  IconCheckCircle,
  IconCloseCircle,
  IconCopy,
  IconDesktop,
  IconDown,
  IconDownload,
  IconExclamationCircle,
  IconLoading,
  IconPlayArrow,
  IconPlus,
  IconRecordStop,
  IconRefresh,
  IconSafe,
  IconSettings,
  IconThunderbolt,
  IconUp,
} from "@arco-design/web-react/icon";
import { go } from "../../app/router";
import { api, can, copy, csrfToken, err, fullTime } from "../../shared/shared";
import { bi, useLang, withLang } from "../../app/i18n";
import {
  AutomationAgentView,
  ClusterAutomationConfig,
  ClusterAutomationSummary,
  RehearsalExecTask,
  RehearsalExecTarget,
  isRehearsalTaskTerminal,
} from "./execution-types";
import "./rehearsal-automation.css";

/** Polls a running rehearsal/baseline automation task until it reaches a terminal state. */
export async function pollRehearsalExecTask(
  clusterId: string,
  taskId: string,
  onUpdate: (t: RehearsalExecTask) => void,
  signal?: AbortSignal,
): Promise<RehearsalExecTask> {
  const url = `/api/clusters/${encodeURIComponent(clusterId)}/automation/tasks/${encodeURIComponent(taskId)}`;
  while (true) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const t = await api<RehearsalExecTask>(url);
    onUpdate(t);
    if (isRehearsalTaskTerminal(t.state)) {
      return t;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, 1100);
      if (signal) {
        const onAbort = () => {
          window.clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

export function LiveExecLogCard({
  task,
  clusterId,
  compact = false,
  onCancelled,
  title,
}: {
  task: RehearsalExecTask;
  clusterId: string;
  compact?: boolean;
  onCancelled?: (next: RehearsalExecTask) => void;
  title?: string;
}) {
  useLang();
  const [expanded, setExpanded] = useState(!compact);
  const [cancelling, setCancelling] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const running = !isRehearsalTaskTerminal(task.state);

  useEffect(() => {
    if (running && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [task.combined_output, running]);

  const cancelTask = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      const next = await api<RehearsalExecTask>(
        `/api/clusters/${encodeURIComponent(clusterId)}/automation/tasks/${encodeURIComponent(task.id)}/cancel`,
        { method: "POST" },
      );
      onCancelled?.(next);
      Message.info(bi("已发送中止信号，正在停止远端进程…", "Cancel signal sent; stopping remote process…"));
    } catch (e) {
      err(e);
    } finally {
      setCancelling(false);
    }
  };

  const stateLabel =
    task.state === "queued"
      ? bi("等待执行端拉取", "Queued")
      : task.state === "running"
        ? bi("正在执行", "Running")
        : task.state === "succeeded"
          ? bi("执行完成", "Succeeded")
          : task.state === "failed"
            ? bi("执行失败", "Failed")
            : task.state === "stopped"
              ? bi("已中止", "Stopped")
              : task.state === "blocked"
                ? bi("安全门禁拦截", "Blocked")
                : bi("状态待核实", "Unknown");

  const totalSec = task.results.reduce((acc, r) => acc + (r.elapsed_sec || 0), 0);

  return (
    <div className={`rha-log-card is-${task.state} ${compact ? "is-compact" : ""}`}>
      <div className="rha-log-head">
        <div className="rha-log-head-l">
          <span className={`rha-state-pill is-${task.state}`}>
            {running ? (
              <IconLoading />
            ) : task.state === "succeeded" ? (
              <IconCheckCircle />
            ) : (
              <IconCloseCircle />
            )}
            <span>{stateLabel}</span>
          </span>
          <span className="rha-transport-tag">
            {task.transport === "agent"
              ? bi("目标机 Agent 直连", "Direct Agent")
              : bi(
                  `控制机 · ${task.node_name || task.node_id || "Node"}${task.node_exec_method === "ansible" ? " (Ansible)" : ""}`,
                  `Controller · ${task.node_name || task.node_id || "Node"}`,
                )}
          </span>
          {task.read_only && (
            <span className="rha-ro-tag">
              <IconSafe /> {bi("100% 只读", "100% RO")}
            </span>
          )}
          {title && <span className="rha-log-title">{title}</span>}
          {totalSec > 0 && <span className="rha-log-dur num">{totalSec.toFixed(1)}s</span>}
        </div>
        <div className="rha-log-head-r">
          {running && (
            <Button
              size="mini"
              status="danger"
              type="outline"
              loading={cancelling}
              icon={<IconRecordStop />}
              onClick={() => void cancelTask()}
            >
              {bi("停止", "Stop")}
            </Button>
          )}
          {task.combined_output && (
            <Button
              size="mini"
              type="text"
              icon={<IconCopy />}
              onClick={() => {
                copy(task.combined_output || "");
                Message.success(bi("已复制脱敏执行输出", "Redacted output copied"));
              }}
            >
              {bi("复制输出", "Copy")}
            </Button>
          )}
          <Button
            size="mini"
            type="text"
            icon={expanded ? <IconUp /> : <IconDown />}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? bi("收起日志", "Fold") : bi("查看输出", "Output")}
          </Button>
        </div>
      </div>

      <div className="rha-target-chips">
        {task.results.map((r, i) => (
          <span key={`${r.host}-${r.ip}-${i}`} className={`rha-target-chip is-${r.state}`}>
            <i />
            <b>{r.host}</b>
            <span className="mono">{r.ip}</span>
            {r.exit_code !== undefined && r.exit_code !== null && (
              <em className="num">rc={r.exit_code}</em>
            )}
            {r.elapsed_sec ? <em className="num">{r.elapsed_sec.toFixed(1)}s</em> : null}
          </span>
        ))}
      </div>

      {expanded && (
        <pre ref={preRef} className="rha-log-pre mono">
          {task.combined_output ||
            (running
              ? bi("已下发任务，等待执行端回传实时脱敏终端输出…", "Task dispatched; waiting for live redacted terminal output…")
              : task.error || bi("（无标准输出）", "(No output)"))}
        </pre>
      )}
    </div>
  );
}

export function ClusterAutomationDrawer({
  visible,
  clusterId,
  onClose,
  onChanged,
}: {
  visible: boolean;
  clusterId: string;
  onClose: () => void;
  onChanged?: (summary: ClusterAutomationSummary) => void;
}) {
  useLang();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<ClusterAutomationSummary | null>(null);
  const [cfg, setCfg] = useState<ClusterAutomationConfig | null>(null);

  // Direct Target Agent enrollment modal state
  const [enrollingHost, setEnrollingHost] = useState("");
  const [enrolledInfo, setEnrolledInfo] = useState<{
    agent: AutomationAgentView;
    token: string;
    hubUrl: string;
    includeCA: boolean;
  } | null>(null);
  const [downloadingBundle, setDownloadingBundle] = useState(false);
  const [customHostName, setCustomHostName] = useState("");
  const [customHostIP, setCustomHostIP] = useState("");
  const [customHostRole, setCustomHostRole] = useState("");

  // Connectivity check state
  const [checking, setChecking] = useState(false);
  const [checkTask, setCheckTask] = useState<RehearsalExecTask | null>(null);
  const checkAbortRef = useRef<AbortController | null>(null);

  const canManage = can("delivery.execute") || can("execution.manage");

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await api<ClusterAutomationSummary>(
          `/api/clusters/${encodeURIComponent(clusterId)}/automation`,
        );
        setSummary(res);
        setCfg((cur) => (cur && silent ? cur : res.config));
        onChanged?.(res);
      } catch (e) {
        if (!silent) err(e);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [clusterId, onChanged],
  );

  useEffect(() => {
    if (!visible) return;
    void load(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 5000);
    return () => {
      window.clearInterval(timer);
      checkAbortRef.current?.abort();
    };
  }, [visible, load]);

  const saveConfig = async (override?: Partial<ClusterAutomationConfig>) => {
    if (!cfg || saving) return;
    const nextCfg: ClusterAutomationConfig = { ...cfg, ...override };
    setSaving(true);
    try {
      const res = await api<ClusterAutomationSummary>(
        `/api/clusters/${encodeURIComponent(clusterId)}/automation`,
        {
          method: "PUT",
          body: JSON.stringify(nextCfg),
        },
      );
      setSummary(res);
      setCfg(res.config);
      onChanged?.(res);
      Message.success(bi("集群自动化配置已保存", "Cluster automation settings saved"));
    } catch (e) {
      err(e);
    } finally {
      setSaving(false);
    }
  };

  const enrollDirectAgent = async (host: string, ip: string) => {
    if (enrollingHost) return;
    setEnrollingHost(ip);
    try {
      const res = await api<{
        agent: AutomationAgentView;
        enrollment_token: string;
        bootstrap?: ClusterAutomationSummary["bootstrap"];
      }>(`/api/clusters/${encodeURIComponent(clusterId)}/automation/agents`, {
        method: "POST",
        body: JSON.stringify({ host, ip, allow_mutating: true }),
      });
      const defaultUrl =
        res.bootstrap?.suggested_urls?.[0] ||
        summary?.bootstrap?.suggested_urls?.[0] ||
        location.origin;
      setEnrolledInfo({
        agent: res.agent,
        token: res.enrollment_token,
        hubUrl: defaultUrl,
        includeCA: Boolean(res.bootstrap?.ca_available ?? summary?.bootstrap?.ca_available),
      });
      await load(true);
      Message.success(bi(`已为 ${host} 生成直连 Agent 接入配置`, `Direct agent enrolled for ${host}`));
    } catch (e) {
      err(e);
    } finally {
      setEnrollingHost("");
    }
  };

  const toggleAgentMutating = async (agent: AutomationAgentView, allow: boolean) => {
    try {
      await api(`/api/clusters/${encodeURIComponent(clusterId)}/automation/agents`, {
        method: "PATCH",
        body: JSON.stringify({ id: agent.id, action: "update", allow_mutating: allow }),
      });
      await load(true);
    } catch (e) {
      err(e);
    }
  };

  const revokeAgent = async (agent: AutomationAgentView) => {
    try {
      await api(`/api/clusters/${encodeURIComponent(clusterId)}/automation/agents`, {
        method: "PATCH",
        body: JSON.stringify({ id: agent.id, action: "revoke" }),
      });
      if (enrolledInfo?.agent.id === agent.id) setEnrolledInfo(null);
      await load(true);
      Message.success(bi(`已撤销 ${agent.host} 的直连 Agent 授权`, `Revoked direct agent on ${agent.host}`));
    } catch (e) {
      err(e);
    }
  };

  const downloadAgentBundle = async () => {
    if (!enrolledInfo || downloadingBundle) return;
    setDownloadingBundle(true);
    try {
      const resp = await fetch(
        withLang(
          `/api/clusters/${encodeURIComponent(clusterId)}/automation/agents/${encodeURIComponent(enrolledInfo.agent.id)}/bundle`,
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken(),
          },
          body: JSON.stringify({
            token: enrolledInfo.token,
            url: enrolledInfo.hubUrl,
            include_ca: enrolledInfo.includeCA,
          }),
        },
      );
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const cd = resp.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="?([^"]+)"?/i);
      const fname = m?.[1] || `mw-target-agent-${enrolledInfo.agent.host}.tar.gz`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      Message.success(bi("已下载一键安装包，解压后执行 sudo bash install.sh 即可上线", "Bundle downloaded; extract and run sudo bash install.sh"));
    } catch (e) {
      err(e);
    } finally {
      setDownloadingBundle(false);
    }
  };

  const runConnectivityCheck = async () => {
    if (!cfg || checking) return;
    checkAbortRef.current?.abort();
    const ctrl = new AbortController();
    checkAbortRef.current = ctrl;
    setChecking(true);
    try {
      const targets: RehearsalExecTarget[] = (summary?.hosts || []).map((h) => ({
        host: h.name,
        ip: h.ip,
        role: h.role,
      }));
      const task = await api<RehearsalExecTask>(
        `/api/clusters/${encodeURIComponent(clusterId)}/automation/check`,
        {
          method: "POST",
          body: JSON.stringify({
            targets,
            transport: cfg.transport,
            node_id: cfg.node_id,
          }),
        },
      );
      setCheckTask(task);
      const fin = await pollRehearsalExecTask(clusterId, task.id, setCheckTask, ctrl.signal);
      if (fin.state === "succeeded") {
        Message.success(bi("只读连通性自检全部通过，可执行自动化探针与演练", "Read-only connectivity check passed"));
      } else {
        Message.warning(bi("部分节点连通自检未通过，请查看下方脱敏输出", "Connectivity check reported issues"));
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") err(e);
    } finally {
      setChecking(false);
    }
  };

  const addCustomHost = () => {
    if (!cfg) return;
    const ip = customHostIP.trim();
    const name = customHostName.trim() || ip;
    if (!ip) {
      Message.warning(bi("请填写主机 IP 地址", "Enter host IP"));
      return;
    }
    const next = [...(cfg.custom_hosts || []), { name, ip, role: customHostRole.trim() || "node" }];
    setCfg({ ...cfg, custom_hosts: next });
    setCustomHostName("");
    setCustomHostIP("");
    setCustomHostRole("");
  };

  const activeAgentsByIP = useMemo(() => {
    const map = new Map<string, AutomationAgentView>();
    for (const a of summary?.agents || []) {
      if (a.desired === "active" && (a.mode === "direct" || !map.has(a.ip))) {
        map.set(a.ip, a);
      }
    }
    return map;
  }, [summary?.agents]);

  const directConfigJSON = useMemo(() => {
    if (!enrolledInfo) return "";
    const obj: Record<string, unknown> = {
      url: enrolledInfo.hubUrl,
      id: enrolledInfo.agent.id,
      enrollment_token: enrolledInfo.token,
      state: `/var/lib/middleware-target/${enrolledInfo.agent.id}`,
    };
    if (enrolledInfo.includeCA) {
      obj.ca_file = "/etc/middleware-execution/platform-ca.pem";
    }
    return JSON.stringify(obj, null, 2);
  }, [enrolledInfo]);

  return (
    <Drawer
      visible={visible}
      width="min(780px, 95vw)"
      unmountOnExit
      title={
        <div className="rha-drawer-title">
          <IconThunderbolt />
          <span>{bi("集群变更演练自动化配置", "Cluster Rehearsal Automation")}</span>
          <span className="mono rha-cluster-pill">{clusterId}</span>
        </div>
      }
      onCancel={onClose}
      footer={
        <div className="rha-drawer-foot">
          <Button
            size="small"
            type="outline"
            loading={checking}
            disabled={!cfg || !canManage}
            icon={<IconPlayArrow />}
            onClick={() => void runConnectivityCheck()}
          >
            {bi("只读连通性自检", "Read-Only Self-Check")}
          </Button>
          <div className="rha-drawer-foot-r">
            <Button onClick={onClose}>{bi("关闭", "Close")}</Button>
            {canManage && (
              <Button type="primary" loading={saving} onClick={() => void saveConfig()}>
                <IconCheck /> {bi("保存自动化配置", "Save Settings")}
              </Button>
            )}
          </div>
        </div>
      }
    >
      {loading || !cfg || !summary ? (
        <Skeleton animation text={{ rows: 10 }} />
      ) : (
        <div className="rha-drawer-body">
          {/* Master switch & Live Readiness Banner */}
          <div className={`rha-master-card ${cfg.enabled ? (summary.ready ? "is-ready" : "is-warn") : ""}`}>
            <div className="rha-master-l">
              <div className="rha-master-title">
                <b>{bi("开启本集群自动化执行（只读探针 + 演练步骤）", "Enable Automated Execution for This Cluster")}</b>
                <span className={`rha-ready-dot ${cfg.enabled ? (summary.ready ? "is-ok" : "is-warn") : ""}`}>
                  {!cfg.enabled
                    ? bi("未开启", "Off")
                    : summary.ready
                      ? bi("通道就绪", "Ready")
                      : bi("待接入", "Needs Setup")}
                </span>
              </div>
              <p className="rha-master-sub">
                {cfg.enabled && summary.ready_reason
                  ? summary.ready_reason
                  : bi(
                      "支持「控制机直连（Ansible / SSH）」与「目标机直连 Agent（免密免控制机）」两种模式，存量纳管集群与平台交付集群通用。",
                      "Supports Controller Ansible/SSH and passwordless Direct Target Agent for both delivered and imported clusters.",
                    )}
              </p>
            </div>
            <Switch
              checked={cfg.enabled}
              disabled={!canManage}
              onChange={(v) => setCfg({ ...cfg, enabled: v })}
            />
          </div>

          {/* Dual Transport Mode Selector */}
          <section className="rha-sec">
            <div className="rha-sec-h">
              <h4>{bi("1. 选择目标机接入方式", "1. Choose Target Access Transport")}</h4>
            </div>
            <div className="rha-transport-grid">
              <button
                type="button"
                className={`rha-transport-card ${cfg.transport === "node" ? "is-on" : ""}`}
                disabled={!canManage}
                onClick={() => setCfg({ ...cfg, transport: "node" })}
              >
                <div className="rha-tc-top">
                  <IconDesktop />
                  <b>{bi("方式 A · 控制机直连（Ansible / SSH）", "Mode A · Controller (Ansible / SSH)")}</b>
                  <span className="rha-tc-badge">{bi("1 台主控机", "1 Control Host")}</span>
                </div>
                <p>
                  {bi(
                    "由已接入的在线执行节点（控制机）通过 Ansible 或 SSH 直连各被控机，适合已有 SSH 免密或集中跳板机环境。",
                    "Control host execution-node runs probes & steps over Ansible or SSH across cluster hosts.",
                  )}
                </p>
              </button>

              <button
                type="button"
                className={`rha-transport-card ${cfg.transport === "agent" ? "is-on" : ""}`}
                disabled={!canManage}
                onClick={() => setCfg({ ...cfg, transport: "agent" })}
              >
                <div className="rha-tc-top">
                  <IconThunderbolt />
                  <b>{bi("方式 B · 目标机直连 Agent（免密码）", "Mode B · Direct Target Agent (Passwordless)")}</b>
                  <span className="rha-tc-badge is-brand">{bi("无需密码 / 控制机", "No SSH / No Ctrl")}</span>
                </div>
                <p>
                  {bi(
                    "无 SSH 密码或无独立控制机时，直接在目标机装轻量 Agent（主动外连 HTTPS），平台直发只读探针与演练命令。",
                    "Zero SSH passwords or control host needed. Install lightweight outbound HTTPS Agent directly on target hosts.",
                  )}
                </p>
              </button>
            </div>

            {cfg.transport === "node" ? (
              <div className="rha-panel-box">
                <div className="rha-form-grid">
                  <div className="rha-field">
                    <label>{bi("执行节点（控制机）", "Execution Node (Control Host)")}</label>
                    <Select
                      placeholder={bi("选择一台在线执行节点", "Select an online execution node")}
                      value={cfg.node_id || undefined}
                      disabled={!canManage}
                      onChange={(v) => setCfg({ ...cfg, node_id: v })}
                    >
                      {summary.nodes.map((n) => (
                        <Select.Option key={n.id} value={n.id}>
                          {n.online ? "● " : "○ "}
                          {n.name} ({n.controller_ip})
                          {n.supports_v3 ? " · v3" : " · v2"}
                          {n.allow_rehearsal ? bi(" · 已授权演练", " · Rehearsal OK") : bi(" · 仅只读", " · RO Only")}
                        </Select.Option>
                      ))}
                    </Select>
                    <div className="rha-field-hint">
                      {summary.nodes.length === 0 ? (
                        <span>{bi("尚未接入任何执行节点，", "No execution nodes enrolled yet; ")}</span>
                      ) : (
                        <span>{bi("变更写步骤需在节点卡片开启「允许变更演练」，", "Mutating steps require enabling Rehearsal on the node; ")}</span>
                      )}
                      <button
                        type="button"
                        className="rha-link-btn"
                        onClick={() => {
                          onClose();
                          go({ name: "settings", id: "nodes" });
                        }}
                      >
                        <IconSettings /> {bi("前往设置 → 执行节点", "Open Settings → Execution Nodes")}
                      </button>
                    </div>
                  </div>
                  <div className="rha-field">
                    <label>{bi("控制机下发方式", "Controller Execution Method")}</label>
                    <Select
                      value={cfg.node_exec_method || "auto"}
                      disabled={!canManage}
                      onChange={(v) => setCfg({ ...cfg, node_exec_method: v })}
                    >
                      <Select.Option value="auto">
                        {bi("自动优选（本机直跑 / 托管或已有 SSH）", "Auto (Local / Managed or Existing SSH)")}
                      </Select.Option>
                      <Select.Option value="ansible">
                        {bi("Ansible（通过控制机 ansible -m script 访问被控机）", "Ansible (ansible -m script)")}
                      </Select.Option>
                      <Select.Option value="ssh">
                        {bi("SSH 直连（非交互 ssh bash -s）", "Direct SSH (BatchMode bash -s)")}
                      </Select.Option>
                    </Select>
                  </div>
                  <div className="rha-field">
                    <label>{bi("SSH 登录用户", "SSH User")}</label>
                    <Input
                      value={cfg.ssh_user || "root"}
                      disabled={!canManage}
                      onChange={(v) => setCfg({ ...cfg, ssh_user: v })}
                      placeholder="root"
                    />
                  </div>
                  <div className="rha-field">
                    <label>{bi("SSH 端口", "SSH Port")}</label>
                    <InputNumber
                      min={1}
                      max={65535}
                      value={cfg.ssh_port || 22}
                      disabled={!canManage}
                      onChange={(v) => setCfg({ ...cfg, ssh_port: Number(v) || 22 })}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="rha-panel-box">
                <div className="rha-agents-head">
                  <span>
                    {bi(
                      `目标主机清单（${summary.online_agents}/${summary.hosts.length} 台 Agent 在线）`,
                      `Target Hosts (${summary.online_agents}/${summary.hosts.length} Agents Online)`,
                    )}
                  </span>
                  <Button
                    size="mini"
                    type="text"
                    icon={<IconRefresh />}
                    onClick={() => void load(true)}
                  >
                    {bi("刷新心跳", "Refresh")}
                  </Button>
                </div>

                <div className="rha-agent-list">
                  {summary.hosts.map((h) => {
                    const ag = activeAgentsByIP.get(h.ip);
                    return (
                      <div key={`${h.name}-${h.ip}`} className="rha-agent-row">
                        <div className="rha-agent-row-l">
                          <span className={`rha-dot ${ag?.online ? "is-on" : ag ? "is-wait" : ""}`} />
                          <div>
                            <div className="rha-agent-host">
                              <b>{h.name}</b>
                              <code className="mono">{h.ip}</code>
                              {h.role && <span className="rha-role-tag">{h.role}</span>}
                            </div>
                            <div className="rha-agent-meta">
                              {!ag
                                ? bi("未接入直连 Agent", "Not enrolled")
                                : ag.online
                                  ? bi(
                                      `在线 · ${ag.mode === "direct" ? "直连执行模式" : "托管信任"} · 最近心跳 ${fullTime(ag.last_seen || "")}`,
                                      `Online · ${ag.mode === "direct" ? "Direct Exec" : "SSH Trust"} · Last seen ${fullTime(ag.last_seen || "")}`,
                                    )
                                  : bi("已生成配置，等待在目标机启动 Agent 服务…", "Enrolled; waiting for target-agent daemon…")}
                            </div>
                          </div>
                        </div>
                        <div className="rha-agent-row-r">
                          {ag ? (
                            <>
                              <Tooltip
                                content={bi(
                                  "关闭后该 Agent 仅放行 100% 只读探针，拒绝任何写操作命令",
                                  "When off, this agent only accepts 100% read-only probes",
                                )}
                              >
                                <label className="rha-mini-sw">
                                  <span>{bi("允许写操作", "Allow Mutate")}</span>
                                  <Switch
                                    size="small"
                                    checked={Boolean(ag.allow_mutating)}
                                    disabled={!canManage}
                                    onChange={(v) => void toggleAgentMutating(ag, v)}
                                  />
                                </label>
                              </Tooltip>
                              {canManage && (
                                <Popconfirm
                                  title={bi("确定撤销该目标机的直连 Agent 授权？", "Revoke direct agent on this host?")}
                                  onOk={() => void revokeAgent(ag)}
                                >
                                  <Button size="mini" status="danger" type="text">
                                    {bi("撤销", "Revoke")}
                                  </Button>
                                </Popconfirm>
                              )}
                            </>
                          ) : (
                            canManage && (
                              <Button
                                size="mini"
                                type="primary"
                                loading={enrollingHost === h.ip}
                                icon={<IconPlus />}
                                onClick={() => void enrollDirectAgent(h.name, h.ip)}
                              >
                                {bi("生成直连 Agent", "Enroll Agent")}
                              </Button>
                            )
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Enrolled one-click bundle & install commands box */}
                {enrolledInfo && (
                  <div className="rha-enroll-box">
                    <div className="rha-enroll-head">
                      <b>
                        <IconCheckCircle />{" "}
                        {bi(
                          `直连 Agent 已签发：${enrolledInfo.agent.host} (${enrolledInfo.agent.ip})`,
                          `Direct Agent Ready: ${enrolledInfo.agent.host} (${enrolledInfo.agent.ip})`,
                        )}
                      </b>
                      <Button size="mini" type="text" onClick={() => setEnrolledInfo(null)}>
                        {bi("收起", "Dismiss")}
                      </Button>
                    </div>
                    <div className="rha-enroll-url-row">
                      <label>{bi("目标机可达的平台地址（HTTPS）", "Reachable Hub URL (HTTPS)")}</label>
                      <Select
                        allowCreate
                        size="small"
                        value={enrolledInfo.hubUrl}
                        onChange={(v) => setEnrolledInfo({ ...enrolledInfo, hubUrl: v })}
                      >
                        {(summary.bootstrap.suggested_urls || []).map((u) => (
                          <Select.Option key={u} value={u}>
                            {u}
                          </Select.Option>
                        ))}
                      </Select>
                    </div>
                    <div className="rha-enroll-acts">
                      <Button
                        size="small"
                        type="primary"
                        loading={downloadingBundle}
                        icon={<IconDownload />}
                        onClick={() => void downloadAgentBundle()}
                      >
                        {bi("下载一键安装包 (.tar.gz)", "Download One-Click Bundle (.tar.gz)")}
                      </Button>
                      <Button
                        size="small"
                        type="outline"
                        icon={<IconCopy />}
                        onClick={() => {
                          copy(directConfigJSON);
                          Message.success(bi("已复制 target-agent.json 配置", "Copied target-agent.json"));
                        }}
                      >
                        {bi("复制配置文件 JSON", "Copy Config JSON")}
                      </Button>
                    </div>
                    <pre className="rha-enroll-cmd mono">{`# 上传压缩包到目标机 ${enrolledInfo.agent.ip} 并以 root 执行：
tar -xzf mw-target-agent-${enrolledInfo.agent.host.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}.tar.gz
sudo bash mw-target-agent-*/install.sh`}</pre>
                  </div>
                )}

                {/* Optional: append an extra/test host */}
                {canManage && (
                  <div className="rha-add-host-row">
                    <Input
                      size="small"
                      placeholder={bi("补充主机名（可选，如 test-pg-01）", "Extra hostname")}
                      value={customHostName}
                      onChange={setCustomHostName}
                    />
                    <Input
                      size="small"
                      className="mono"
                      placeholder={bi("IP 地址", "IP address")}
                      value={customHostIP}
                      onChange={setCustomHostIP}
                    />
                    <Input
                      size="small"
                      placeholder={bi("角色（primary/replica）", "Role")}
                      value={customHostRole}
                      onChange={setCustomHostRole}
                    />
                    <Button size="small" icon={<IconPlus />} onClick={addCustomHost}>
                      {bi("添加主机", "Add")}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 2. Execution Pacing & Production Safety Guardrails */}
          <section className="rha-sec">
            <div className="rha-sec-h">
              <h4>{bi("2. 推进节奏与生产安全护栏", "2. Execution Pacing & Safety Guardrails")}</h4>
            </div>
            <div className="rha-panel-box">
              <div className="rha-form-grid">
                <div className="rha-field">
                  <label>{bi("集群环境属性", "Environment Classification")}</label>
                  <Select
                    value={cfg.env_kind}
                    disabled={!canManage}
                    onChange={(v) =>
                      setCfg({
                        ...cfg,
                        env_kind: v,
                        pause_before_mutate: v === "prod" ? true : cfg.pause_before_mutate,
                      })
                    }
                  >
                    <Select.Option value="prod">
                      {bi("生产环境（强安全门禁 · 写操作需二次确认）", "Production (Strict Safety Gate)")}
                    </Select.Option>
                    <Select.Option value="test">
                      {bi("测试 / 演练环境（允许顺畅自动推进）", "Test / Staging (Smooth Auto-Run)")}
                    </Select.Option>
                  </Select>
                </div>

                <div className="rha-field">
                  <label>{bi("默认推进策略", "Default Pacing Strategy")}</label>
                  <Select
                    value={cfg.default_pacing || "step_confirm"}
                    disabled={!canManage}
                    onChange={(v) => setCfg({ ...cfg, default_pacing: v })}
                  >
                    <Select.Option value="step_confirm">
                      {bi("逐单步人工确认（每步点击执行 + AI 自动验收）", "Step-by-Step Human Trigger + AI Verify")}
                    </Select.Option>
                    <Select.Option value="ai_gated_auto">
                      {bi("AI 逐单步把关自动推进（跑一步 → AI 确认通过再跑下一步）", "AI-Gated Step Auto-Advance")}
                    </Select.Option>
                  </Select>
                </div>
              </div>

              <div className="rha-guard-switches">
                {cfg.env_kind === "prod" && (
                  <div className="rha-guard-row">
                    <div>
                      <b>{bi("允许在生产环境执行变更写操作步骤", "Allow Mutating Steps in Production")}</b>
                      <p>
                        {bi(
                          "关闭时仅放行 100% 只读探针与只读预检；开启后执行变更步骤前仍须核对集群标识，且与首次交付共享主机互斥锁。",
                          "When off, only 100% read-only probes/checks run. When on, prod mutations require cluster ID confirmation and hold host locks.",
                        )}
                      </p>
                    </div>
                    <Switch
                      checked={cfg.allow_prod_mutate}
                      disabled={!canManage}
                      onChange={(v) => setCfg({ ...cfg, allow_prod_mutate: v })}
                    />
                  </div>
                )}

                <div className="rha-guard-row">
                  <div>
                    <b>{bi("高危/变更步骤执行前暂停确认（断点保护）", "Pause Before Mutating Steps (Breakpoint)")}</b>
                    <p>
                      {bi(
                        "开启时，在「AI 逐单步把关自动推进」模式下遇到核心变更步骤（execute）会停下等你点头；关闭后将完全由 AI 逐单步严格验收通过后自动继续，任何报错或 AI 存疑仍立刻停机。",
                        "When on, AI-gated auto-advance pauses before execute-phase steps for human approval. When off, AI strictly gates every single step and halts on any failure or doubt.",
                      )}
                    </p>
                  </div>
                  <Switch
                    checked={cfg.pause_before_mutate}
                    disabled={!canManage}
                    onChange={(v) => setCfg({ ...cfg, pause_before_mutate: v })}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Live Connectivity Check Result */}
          {checkTask && (
            <section className="rha-sec">
              <div className="rha-sec-h">
                <h4>{bi("只读连通性自检结果", "Connectivity Self-Check Result")}</h4>
              </div>
              <LiveExecLogCard
                task={checkTask}
                clusterId={clusterId}
                onCancelled={setCheckTask}
              />
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}

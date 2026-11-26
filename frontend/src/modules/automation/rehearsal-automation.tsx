import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Drawer,
  Input,
  InputNumber,
  Message,
  Modal,
  Select,
  Skeleton,
} from "@arco-design/web-react";
import {
  IconCheckCircle,
  IconClose,
  IconCloseCircle,
  IconCopy,
  IconDown,
  IconLeft,
  IconLoading,
  IconPlayArrow,
  IconPlus,
  IconRecordStop,
  IconRefresh,
  IconRight,
  IconSafe,
  IconSearch,
  IconSettings,
  IconThunderbolt,
  IconUp,
} from "@arco-design/web-react/icon";
import { go } from "../../app/router";
import { api, can, copy, err } from "../../shared/shared";
import { bi, useLang } from "../../app/i18n";
import {
  ClusterAutomationHost,
  ClusterAutomationSummary,
  RehearsalExecTarget,
  RehearsalExecTask,
  UnifiedAgentView,
  isRehearsalTaskTerminal,
  saveAgentEnrollPrefill,
} from "./execution-types";
import "./rehearsal-automation.css";

export type ExecutionAgentChoice = {
  agent_id: string;
  targets: RehearsalExecTarget[];
  node_exec_method?: "auto" | "ansible" | "ssh";
  ssh_user?: string;
  ssh_port?: number;
};

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
      ? bi("等待 Agent 领取", "Queued")
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
              ? bi("Agent 本机直连", "Local Direct Agent")
              : bi(
                  `Agent · ${task.node_name || task.node_id || "Runner"}`,
                  `Agent · ${task.node_name || task.node_id || "Runner"}`,
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
              onClick={() =>
                void copy(
                  task.combined_output || "",
                  bi("已复制脱敏执行输出", "Redacted output copied"),
                )
              }
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
            task.error ||
            (running
              ? bi("正在等待 Agent 建立输出流…", "Waiting for Agent output stream…")
              : bi("（本次执行无标准输出）", "(Empty stdout/stderr)"))}
        </pre>
      )}
    </div>
  );
}

export function navigateToClusterAutomation(
  clusterId: string,
  _returnTo?: { tab?: string; rehearsal?: string },
) {
  go({ name: "deliveries", id: clusterId, tab: "automation" });
}

/**
 * On-demand Execution Agent Picker Modal.
 * Picks from Agents associated with this cluster; execution permission is governed cleanly by the user's IAM access.
 */
export function SelectExecutionAgentModal({
  visible,
  clusterId,
  taskTitle,
  readOnly,
  initialTargets,
  hostsFallback,
  confirmLoading,
  onCancel,
  onConfirm,
  onSummaryUpdated,
}: {
  visible: boolean;
  clusterId: string;
  taskTitle: string;
  readOnly: boolean;
  initialTargets?: RehearsalExecTarget[];
  hostsFallback?: ClusterAutomationHost[];
  confirmLoading?: boolean;
  onCancel: () => void;
  onConfirm: (choice: ExecutionAgentChoice) => void;
  onSummaryUpdated?: (next: ClusterAutomationSummary) => void;
}) {
  useLang();
  const canBindCluster = can("delivery.execute|delivery.create|execution.manage");
  const canEnrollAgent = can("execution.manage");

  const [summary, setSummary] = useState<ClusterAutomationSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [selectedIPs, setSelectedIPs] = useState<string[]>([]);
  const [sshOpen, setSshOpen] = useState(false);
  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState(22);
  const [execMethod, setExecMethod] = useState<"auto" | "ansible" | "ssh">("auto");
  const [bindBusy, setBindBusy] = useState("");

  const refreshSummary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<ClusterAutomationSummary>(
        `/api/clusters/${encodeURIComponent(clusterId)}/automation`,
      );
      setSummary(res);
      onSummaryUpdated?.(res);
      setSshUser(res.config?.ssh_user || "root");
      setSshPort(res.config?.ssh_port || 22);
      setExecMethod(
        (res.config?.node_exec_method as "auto" | "ansible" | "ssh") || "auto",
      );

      const allHosts = res.hosts?.length ? res.hosts : hostsFallback || [];
      const initIPs =
        initialTargets && initialTargets.length > 0
          ? initialTargets.map((t) => t.ip)
          : allHosts.map((h) => h.ip);
      setSelectedIPs(initIPs);

      const bound = res.unified_agents || [];
      const isEligible = (a: UnifiedAgentView) =>
        !a.disabled && a.online && a.supports_exec;
      const remembered = res.last_agent_id || "";
      if (remembered && bound.some((a) => a.id === remembered && isEligible(a))) {
        setSelectedAgentId(remembered);
      } else {
        const firstOk = bound.find(isEligible);
        setSelectedAgentId(firstOk ? firstOk.id : bound[0]?.id || "");
      }
    } catch (e) {
      err(e);
    } finally {
      setLoading(false);
    }
  }, [clusterId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visible) return;
    setSshOpen(false);
    void refreshSummary();
  }, [visible, refreshSummary]);

  const hosts = useMemo(
    () => (summary?.hosts?.length ? summary.hosts : hostsFallback || []),
    [summary?.hosts, hostsFallback],
  );

  const boundAgents = useMemo(
    () => summary?.unified_agents || [],
    [summary?.unified_agents],
  );
  const availableAgents = useMemo(
    () => summary?.available_agents || [],
    [summary?.available_agents],
  );

  const directCoverageCount = useMemo(() => {
    if (selectedIPs.length <= 1) return 0;
    let covered = 0;
    for (const ip of selectedIPs) {
      const ok = boundAgents.some(
        (a) => a.backing === "direct" && a.ip === ip && a.online && !a.disabled,
      );
      if (ok) covered++;
    }
    return covered;
  }, [boundAgents, selectedIPs]);

  const pickedAgent = useMemo(
    () => boundAgents.find((a) => a.id === selectedAgentId) || null,
    [boundAgents, selectedAgentId],
  );

  const pickedCanRun =
    selectedAgentId === "__direct__"
      ? directCoverageCount === selectedIPs.length && selectedIPs.length > 0
      : Boolean(
          pickedAgent &&
            pickedAgent.online &&
            !pickedAgent.disabled &&
            pickedAgent.supports_exec,
        );

  const isLocalDirect = useMemo(() => {
    if (selectedAgentId === "__direct__") return true;
    if (!pickedAgent) return false;
    if (pickedAgent.backing === "direct") return true;
    return (
      selectedIPs.length === 1 &&
      pickedAgent.ip.trim() === selectedIPs[0].trim()
    );
  }, [selectedAgentId, pickedAgent, selectedIPs]);

  const quickBindAgent = async (agentId: string) => {
    if (bindBusy) return;
    setBindBusy(agentId);
    try {
      await api("/api/executions/unified-agents", {
        method: "PATCH",
        body: JSON.stringify({
          id: agentId,
          bind_clusters: [clusterId],
        }),
      });
      await refreshSummary();
      setSelectedAgentId(agentId);
      Message.success(bi("已关联该 Agent", "Associated Agent"));
    } catch (e) {
      err(e);
    } finally {
      setBindBusy("");
    }
  };

  const handleStart = () => {
    if (!pickedCanRun) return;
    const chosenTargets: RehearsalExecTarget[] = hosts
      .filter((h) => selectedIPs.includes(h.ip))
      .map((h) => ({ host: h.name, ip: h.ip, role: h.role }));
    if (chosenTargets.length === 0 && initialTargets?.length) {
      chosenTargets.push(...initialTargets);
    }
    if (chosenTargets.length === 0) {
      Message.warning(bi("请至少勾选 1 台目标主机", "Select at least 1 target host"));
      return;
    }
    onConfirm({
      agent_id: selectedAgentId,
      targets: chosenTargets,
      node_exec_method: execMethod,
      ssh_user: sshUser.trim() || "root",
      ssh_port: sshPort || 22,
    });
  };

  return (
    <Modal
      visible={visible}
      onCancel={onCancel}
      footer={null}
      style={{ width: 560, maxWidth: "94vw" }}
      title={
        <span className="sea-modal-title">
          <IconThunderbolt />
          <span>{bi("选择执行 Agent", "Select Execution Agent")}</span>
        </span>
      }
    >
      <div className="sea-body">
        <div className="sea-task-bar">
          <span className="sea-task-name">{taskTitle}</span>
          <span className={`sea-kind-badge ${readOnly ? "is-ro" : "is-rw"}`}>
            {readOnly
              ? bi("100% 只读采集", "Read-Only Probe")
              : bi("变更步骤执行", "Change Step")}
          </span>
        </div>

        {loading && !summary ? (
          <Skeleton animation text={{ rows: 4 }} />
        ) : (
          <>
            <div className="sea-sec">
              <div className="sea-sec-head">
                <b>{bi("1. 选择本集群关联的 Agent", "1. Associated Cluster Agents")}</b>
                {canBindCluster && (
                  <button
                    type="button"
                    className="iam-text-act"
                    onClick={() => {
                      onCancel();
                      go({ name: "executions", view: "nodes" });
                    }}
                  >
                    {bi("前往 Agent 关联集群 →", "Associate in Agent →")}
                  </button>
                )}
              </div>

              {boundAgents.length === 0 ? (
                <div className="sea-empty-box">
                  <p>
                    {bi(
                      `集群「${clusterId}」尚未关联执行 Agent。`,
                      `No Agent is associated with cluster "${clusterId}" yet.`,
                    )}
                  </p>
                  {canBindCluster && availableAgents.length > 0 && (
                    <div className="sea-quick-bind">
                      <span className="small faint">
                        {bi("一键关联已有 Agent：", "Associate an existing Agent:")}
                      </span>
                      <div className="sea-quick-bind-list">
                        {availableAgents.map((a) => (
                          <div key={a.id} className="sea-quick-bind-row">
                            <span>
                              <span
                                className={`iam-ag-dot ${a.online && !a.disabled ? "is-online" : "is-offline"}`}
                              />{" "}
                              <b>{a.name}</b>{" "}
                              <code className="mono faint">{a.ip}</code>
                            </span>
                            <Button
                              size="mini"
                              type="primary"
                              loading={bindBusy === a.id}
                              onClick={() => void quickBindAgent(a.id)}
                            >
                              {bi("关联此集群", "Associate")}
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {canEnrollAgent && (
                    <Button
                      size="small"
                      type="outline"
                      icon={<IconPlus />}
                      onClick={() => {
                        saveAgentEnrollPrefill({
                          cluster: clusterId,
                          host: hosts[0]?.name,
                          ip: hosts[0]?.ip,
                        });
                        onCancel();
                        go({ name: "executions", view: "nodes" });
                      }}
                    >
                      {bi("接入新 Agent", "Enroll New Agent")}
                    </Button>
                  )}
                </div>
              ) : (
                <div className="sea-agent-list" role="radiogroup">
                  {selectedIPs.length > 1 && directCoverageCount > 0 && (
                    <div
                      role="radio"
                      aria-checked={selectedAgentId === "__direct__"}
                      tabIndex={0}
                      className={`sea-agent-card ${selectedAgentId === "__direct__" ? "is-selected" : ""} ${directCoverageCount < selectedIPs.length ? "is-muted" : ""}`}
                      onClick={() => {
                        if (directCoverageCount === selectedIPs.length) {
                          setSelectedAgentId("__direct__");
                        }
                      }}
                    >
                      <div className="sea-agent-main">
                        <span className="iam-ag-dot is-online" />
                        <b>{bi("各目标节点本机 Agent 直连", "Per-Host Local Agents")}</b>
                        <span className="ua-path-badge is-local">
                          {bi(
                            `${directCoverageCount}/${selectedIPs.length} 台就绪`,
                            `${directCoverageCount}/${selectedIPs.length} ready`,
                          )}
                        </span>
                      </div>
                    </div>
                  )}

                  {boundAgents.map((a) => {
                    const unusable =
                      a.disabled || !a.online || !a.supports_exec;
                    const isLocal =
                      a.backing === "direct" ||
                      hosts.some((h) => h.ip.trim() === a.ip.trim());
                    const selected = selectedAgentId === a.id;
                    return (
                      <div
                        key={a.id}
                        role="radio"
                        aria-checked={selected}
                        tabIndex={0}
                        className={`sea-agent-card ${selected ? "is-selected" : ""} ${unusable ? "is-muted" : ""}`}
                        onClick={() => setSelectedAgentId(a.id)}
                      >
                        <div className="sea-agent-main">
                          <span
                            className={`iam-ag-dot ${
                              a.disabled
                                ? "is-disabled"
                                : a.online
                                  ? "is-online"
                                  : "is-offline"
                            }`}
                          />
                          <b>{a.name}</b>
                          <code className="mono faint">{a.ip}</code>
                          <span
                            className={`ua-path-badge ${isLocal ? "is-local" : ""}`}
                          >
                            {isLocal
                              ? bi("本机免密直连", "Local Direct")
                              : bi("SSH 远程代管", "Jumpbox")}
                          </span>
                        </div>
                        <div className="sea-agent-right">
                          {a.online && !a.disabled && (
                            <small className="ok">{bi("在线", "Online")}</small>
                          )}
                          {!a.online && !a.disabled && (
                            <small className="warn">{bi("离线", "Offline")}</small>
                          )}
                          {a.disabled && (
                            <small className="faint">{bi("已禁用", "Disabled")}</small>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {hosts.length > 0 && (
              <div className="sea-sec">
                <div className="sea-sec-head">
                  <b>
                    {bi(
                      `2. 目标机器（已选 ${selectedIPs.length}/${hosts.length} 台）`,
                      `2. Target Hosts (${selectedIPs.length}/${hosts.length})`,
                    )}
                  </b>
                  {hosts.length > 1 && (
                    <button
                      type="button"
                      className="iam-text-act"
                      onClick={() =>
                        setSelectedIPs(
                          selectedIPs.length === hosts.length
                            ? [hosts[0].ip]
                            : hosts.map((h) => h.ip),
                        )
                      }
                    >
                      {selectedIPs.length === hosts.length
                        ? bi("仅选首节点", "First Host Only")
                        : bi("全选节点", "Select All")}
                    </button>
                  )}
                </div>
                <div className="sea-host-grid">
                  {hosts.map((h) => {
                    const checked = selectedIPs.includes(h.ip);
                    return (
                      <label
                        key={`${h.name}-${h.ip}`}
                        className={`sea-host-chip ${checked ? "on" : ""}`}
                      >
                        <Checkbox
                          checked={checked}
                          onChange={(v) => {
                            setSelectedIPs((prev) =>
                              v
                                ? [...prev, h.ip]
                                : prev.filter((x) => x !== h.ip),
                            );
                          }}
                        />
                        <b>{h.name}</b>
                        <code className="mono">{h.ip}</code>
                        {h.role && <em>{h.role}</em>}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {pickedAgent && !isLocalDirect && (
              <div className="sea-ssh-box">
                <div className="sea-ssh-summary">
                  <span className="faint small">
                    {bi(
                      `由「${pickedAgent.name}」经远程连接下发：${sshUser}@<目标IP>:${sshPort}（${execMethod === "ansible" ? "Ansible" : "SSH 直连"}）`,
                      `Via "${pickedAgent.name}": ${sshUser}@<target>:${sshPort} (${execMethod})`,
                    )}
                  </span>
                  <button
                    type="button"
                    className="iam-text-act"
                    onClick={() => setSshOpen((v) => !v)}
                  >
                    {sshOpen ? bi("收起参数", "Hide") : bi("调整 SSH 参数", "Edit SSH")}
                  </button>
                </div>
                {sshOpen && (
                  <div className="sea-ssh-grid">
                    <label>
                      <span>{bi("下发方式", "Method")}</span>
                      <Select
                        size="small"
                        value={execMethod}
                        getPopupContainer={() => document.body}
                        onChange={(v) =>
                          setExecMethod(v as "auto" | "ansible" | "ssh")
                        }
                        options={[
                          { value: "auto", label: bi("SSH 自动优选", "SSH Auto") },
                          { value: "ansible", label: "Ansible" },
                          { value: "ssh", label: bi("纯 SSH", "SSH Only") },
                        ]}
                      />
                    </label>
                    <label>
                      <span>{bi("SSH 用户", "SSH User")}</span>
                      <Input
                        size="small"
                        value={sshUser}
                        onChange={setSshUser}
                        placeholder="root"
                      />
                    </label>
                    <label>
                      <span>{bi("SSH 端口", "Port")}</span>
                      <InputNumber
                        size="small"
                        min={1}
                        max={65535}
                        value={sshPort}
                        onChange={(v) => setSshPort(Number(v) || 22)}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <div className="ua-modal-foot">
          <Button onClick={onCancel}>{bi("取消", "Cancel")}</Button>
          <Button
            type="primary"
            icon={<IconPlayArrow />}
            loading={confirmLoading}
            disabled={!pickedCanRun || selectedIPs.length === 0}
            onClick={handleStart}
          >
            {bi("开始执行", "Run Now")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Clean Cluster Automation Panel (under Cluster Detail -> Automation tab).
 */
export function ClusterAutomationPanel({
  clusterId,
  readOnly = false,
  onChanged,
}: {
  clusterId: string;
  readOnly?: boolean;
  onChanged?: (summary: ClusterAutomationSummary) => void;
}) {
  useLang();
  const canOperateCluster =
    !readOnly && can("delivery.execute|delivery.create|execution.manage");
  const canEnrollAgent = can("execution.manage");
  const canExec = !readOnly && can("delivery.execute|execution.manage");

  const [summary, setSummary] = useState<ClusterAutomationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<"all" | "online" | "local">("all");
  const [leftQ, setLeftQ] = useState("");
  const [rightQ, setRightQ] = useState("");
  const [leftChecked, setLeftChecked] = useState<Set<string>>(() => new Set());
  const [rightChecked, setRightChecked] = useState<Set<string>>(() => new Set());
  const [checkModalOpen, setCheckModalOpen] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [liveCheckTask, setLiveCheckTask] = useState<RehearsalExecTask | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await api<ClusterAutomationSummary>(
        `/api/clusters/${encodeURIComponent(clusterId)}/automation`,
      );
      setSummary(res);
      onChanged?.(res);
    } catch (e) {
      if (!silent) err(e);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [clusterId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load(false);
  }, [load]);

  const batchSetAgentsBound = async (agentIds: string[], bound: boolean) => {
    if (busy || agentIds.length === 0) return;
    setBusy(true);
    try {
      for (const agentId of agentIds) {
        await api("/api/executions/unified-agents", {
          method: "PATCH",
          body: JSON.stringify(
            bound
              ? { id: agentId, bind_clusters: [clusterId] }
              : { id: agentId, unbind_clusters: [clusterId] },
          ),
        });
      }
      setLeftChecked(new Set());
      setRightChecked(new Set());
      await load(true);
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  const runConnectivityCheck = async (choice: ExecutionAgentChoice) => {
    setCheckBusy(true);
    try {
      const task = await api<RehearsalExecTask>(
        `/api/clusters/${encodeURIComponent(clusterId)}/automation/check`,
        {
          method: "POST",
          body: JSON.stringify({
            agent_id: choice.agent_id,
            targets: choice.targets,
            node_exec_method: choice.node_exec_method,
            ssh_user: choice.ssh_user,
            ssh_port: choice.ssh_port,
            remember_choice: true,
          }),
        },
      );
      setCheckModalOpen(false);
      setLiveCheckTask(task);
      await pollRehearsalExecTask(clusterId, task.id, setLiveCheckTask);
      await load(true);
    } catch (e) {
      err(e);
    } finally {
      setCheckBusy(false);
    }
  };

  if (loading && !summary) {
    return <Skeleton animation text={{ rows: 6 }} />;
  }

  const bound = summary?.unified_agents || [];
  const available = summary?.available_agents || [];
  const recent = summary?.recent_tasks || [];
  const lkw = leftQ.trim().toLowerCase();
  const rkw = rightQ.trim().toLowerCase();

  const isLocalAgent = (a: UnifiedAgentView) =>
    a.backing === "direct" ||
    Boolean(summary?.hosts?.some((h) => h.ip.trim() === a.ip.trim()));

  const matchAgent = (a: UnifiedAgentView, kw: string) => {
    if (!kw) return true;
    return (
      a.name.toLowerCase().includes(kw) ||
      a.ip.toLowerCase().includes(kw) ||
      (a.probe?.hostname || "").toLowerCase().includes(kw) ||
      (a.probe?.os || "").toLowerCase().includes(kw)
    );
  };

  const filteredAvailable = available.filter((a) => {
    if (scopeFilter === "online" && (a.disabled || !a.online)) return false;
    if (scopeFilter === "local" && !isLocalAgent(a)) return false;
    return matchAgent(a, lkw);
  });
  const filteredBound = bound.filter((a) => matchAgent(a, rkw));
  const validLeftChecked = filteredAvailable.filter((a) => leftChecked.has(a.id));
  const validRightChecked = filteredBound.filter((a) => rightChecked.has(a.id));
  const localAvailCount = available.filter((a) => isLocalAgent(a)).length;
  const onlineAvailCount = available.filter((a) => a.online && !a.disabled).length;

  const fmtAgentProbe = (a: UnifiedAgentView) => {
    const parts: string[] = [];
    if (a.probe?.os) parts.push(a.probe.os);
    else if (a.probe?.hostname) parts.push(a.probe.hostname);
    if (a.probe?.cpu_cores) parts.push(`${a.probe.cpu_cores} vCPU`);
    if (a.probe?.mem_used_pct !== undefined)
      parts.push(`Mem ${a.probe.mem_used_pct.toFixed(0)}%`);
    return parts.join(" · ");
  };

  return (
    <div className="rha-clean-panel">
      <section className="ua-sec">
        <div className="ua-sec-head">
          <div>
            <h2>
              {bi("本集群关联的执行 Agent", "Associated Execution Agents")}{" "}
              <em className="num">{bound.length}</em>
            </h2>
            <p className="faint small">
              {bi(
                "在集群中运行只读探针或变更演练步骤时，直接从下方已关联的 Agent 中选择执行。",
                "Pick from associated Agents below when running probes or change steps in this cluster.",
              )}
            </p>
          </div>
          <div className="ua-sec-head-acts">
            {canExec && bound.length > 0 && (
              <Button
                size="small"
                type="secondary"
                icon={<IconPlayArrow />}
                onClick={() => setCheckModalOpen(true)}
              >
                {bi("连通测试", "Test Connectivity")}
              </Button>
            )}
            {canOperateCluster && (available.length > 0 || bound.length > 0) && (
              <Button
                size="small"
                type={bound.length === 0 ? "primary" : "secondary"}
                icon={bound.length === 0 ? <IconPlus /> : <IconSettings />}
                onClick={() => {
                  setScopeFilter("all");
                  setLeftQ("");
                  setRightQ("");
                  setTransferOpen(true);
                }}
              >
                {bound.length === 0
                  ? bi("关联 Agent", "Associate Agent")
                  : bi("配置关联 Agent", "Configure Agents")}
              </Button>
            )}
            <Button
              size="small"
              type="outline"
              icon={<IconSettings />}
              onClick={() => {
                if (canEnrollAgent) {
                  saveAgentEnrollPrefill({
                    cluster: clusterId,
                    host: summary?.hosts?.[0]?.name,
                    ip: summary?.hosts?.[0]?.ip,
                  });
                }
                go({ name: "executions", view: "nodes" });
              }}
            >
              {canEnrollAgent
                ? bi("管理 / 接入 Agent", "Manage Agents")
                : bi("前往 Agent 中心", "Open Agents")}
            </Button>
          </div>
        </div>

        {bound.length === 0 ? (
          <div className="ua-cluster-empty">
            <span className="faint">
              {canOperateCluster
                ? available.length > 0
                  ? bi(
                      `当前集群尚未关联执行 Agent（平台共有 ${available.length} 台可用 Agent）；点击右上角「关联 Agent」即可批量选择。`,
                      `No Agent associated yet (${available.length} available on platform). Click "Associate Agent" above.`,
                    )
                  : bi(
                      "平台尚未接入任何执行 Agent；可前往「执行中心 → Agent」接入机器后再关联。",
                      "No Agents enrolled on the platform yet.",
                    )
                : bi(
                    "当前集群尚未关联执行 Agent（你对本集群为只读权限，需集群创建者或运维成员配置关联）。",
                    "No Agent associated yet (read-only access on this cluster).",
                  )}
            </span>
          </div>
        ) : (
          <div className="rha-ag-ledger" role="table">
            <div className="rha-ag-head" role="row">
              <span>{bi("Agent 名称", "Agent")}</span>
              <span>{bi("机器 IP", "Host IP")}</span>
              <span>{bi("主机系统与探针负载", "OS & Probe Telemetry")}</span>
              <span>{bi("执行链路", "Execution Path")}</span>
              <span style={{ justifyContent: "flex-end" }}>
                {bi("状态与操作", "Status & Action")}
              </span>
            </div>
            {bound.map((a) => {
              const local = isLocalAgent(a);
              const probeSummary = fmtAgentProbe(a);
              return (
                <div key={a.id} className="rha-ag-row" role="row">
                  <div>
                    <span
                      className={`iam-ag-dot ${
                        a.disabled
                          ? "is-disabled"
                          : a.online
                            ? "is-online"
                            : "is-offline"
                      }`}
                    />
                    <b className="ds-tf-id">{a.name}</b>
                  </div>
                  <div>
                    <code className="mono small">{a.ip}</code>
                  </div>
                  <div>
                    <span className="small faint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {probeSummary || bi("等待探针上报", "Awaiting probe")}
                    </span>
                  </div>
                  <div>
                    <span className={`ua-path-badge ${local ? "is-local" : ""}`}>
                      {local
                        ? bi("本机免密直连", "Local Direct")
                        : bi("SSH 远程代管", "Jumpbox SSH")}
                    </span>
                  </div>
                  <div>
                    <span className="small faint">
                      {a.disabled
                        ? bi("已禁用", "Disabled")
                        : a.online
                          ? bi("在线", "Online")
                          : bi("离线", "Offline")}
                    </span>
                    {canOperateCluster && (
                      <Button
                        size="mini"
                        type="secondary"
                        status="danger"
                        disabled={busy}
                        onClick={() => void batchSetAgentsBound([a.id], false)}
                      >
                        {bi("解除关联", "Unbind")}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <Drawer
        width={840}
        style={{ maxWidth: "100vw" }}
        visible={transferOpen && canOperateCluster}
        onCancel={() => setTransferOpen(false)}
        footer={null}
        title={
          <span className="iam-drawer-title">
            <span>{bi("配置本集群关联 Agent", "Configure Associated Agents")}</span>
            <code className="mono">{clusterId}</code>
          </span>
        }
      >
        <div className="rha-clean-panel rha-tf-drawer">
          <div className="ds-transfer">
            <div className="ds-tf-pane">
              <div className="ds-tf-head">
                <label className="ds-tf-head-chk">
                  <Checkbox
                    checked={
                      filteredAvailable.length > 0 &&
                      validLeftChecked.length === filteredAvailable.length
                    }
                    indeterminate={
                      validLeftChecked.length > 0 &&
                      validLeftChecked.length < filteredAvailable.length
                    }
                    disabled={busy || filteredAvailable.length === 0}
                    onChange={(chk) => {
                      const next = new Set(leftChecked);
                      for (const a of filteredAvailable) {
                        if (chk) next.add(a.id);
                        else next.delete(a.id);
                      }
                      setLeftChecked(next);
                    }}
                  />
                  <b>{bi("可关联 Agent", "Available Agents")}</b>
                </label>
                <span className="ds-tf-cnt num">
                  {validLeftChecked.length > 0
                    ? `${validLeftChecked.length} / ${filteredAvailable.length}`
                    : filteredAvailable.length}
                </span>
              </div>

              <div className="ds-tf-facets">
                <div className="ds-tf-scope-pills">
                  <button
                    type="button"
                    className={`ds-tf-pill ${scopeFilter === "all" ? "on" : ""}`}
                    onClick={() => setScopeFilter("all")}
                  >
                    {bi("全部", "All")} ({available.length})
                  </button>
                  <button
                    type="button"
                    className={`ds-tf-pill ${scopeFilter === "online" ? "on" : ""}`}
                    onClick={() => setScopeFilter("online")}
                  >
                    {bi("在线", "Online")} ({onlineAvailCount})
                  </button>
                  {localAvailCount > 0 && (
                    <button
                      type="button"
                      className={`ds-tf-pill ${scopeFilter === "local" ? "on" : ""}`}
                      onClick={() => setScopeFilter("local")}
                    >
                      {bi("同机直连", "Same IP")} ({localAvailCount})
                    </button>
                  )}
                </div>
              </div>

              <div className="ds-tf-search">
                <Input
                  size="small"
                  prefix={<IconSearch />}
                  allowClear
                  value={leftQ}
                  onChange={setLeftQ}
                  placeholder={bi(
                    "搜索 Agent 名称、机器 IP、主机名或操作系统…",
                    "Search Agent name, IP, hostname, or OS…",
                  )}
                />
              </div>

              <div className="ds-tf-list" style={{ height: 360 }}>
                {filteredAvailable.length === 0 ? (
                  <div className="ds-tf-empty">
                    {available.length === 0
                      ? bi("全部可用 Agent 已关联至本集群", "All available Agents are associated")
                      : bi("没有符合筛选条件的 Agent", "No matching Agents")}
                  </div>
                ) : (
                  filteredAvailable.map((a) => {
                    const checked = leftChecked.has(a.id);
                    const local = isLocalAgent(a);
                    const sub = fmtAgentProbe(a);
                    return (
                      <div
                        key={a.id}
                        className={`ds-tf-row ${checked ? "is-checked" : ""}`}
                        onClick={() => {
                          if (busy) return;
                          const next = new Set(leftChecked);
                          if (checked) next.delete(a.id);
                          else next.add(a.id);
                          setLeftChecked(next);
                        }}
                      >
                        <Checkbox checked={checked} disabled={busy} />
                        <div className="ds-tf-item-col">
                          <div className="ds-tf-item-main">
                            <span
                              className={`iam-ag-dot ${
                                a.disabled
                                  ? "is-disabled"
                                  : a.online
                                    ? "is-online"
                                    : "is-offline"
                              }`}
                            />
                            <b className="ds-tf-id">{a.name}</b>
                            <code className="mono faint small">{a.ip}</code>
                            {local && (
                              <span className="ua-path-badge is-local">
                                {bi("本机直连", "Direct")}
                              </span>
                            )}
                          </div>
                          {sub && <div className="ds-tf-item-sub">{sub}</div>}
                        </div>
                        <button
                          type="button"
                          className="ds-tf-quick-btn"
                          disabled={busy}
                          title={bi("立即关联", "Associate")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void batchSetAgentsBound([a.id], true);
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

            <div className="ds-tf-mid">
              <Button
                type="primary"
                size="small"
                disabled={busy || validLeftChecked.length === 0}
                loading={busy && validLeftChecked.length > 0}
                onClick={() =>
                  void batchSetAgentsBound(
                    validLeftChecked.map((a) => a.id),
                    true,
                  )
                }
              >
                {validLeftChecked.length > 0
                  ? bi(`关联 (${validLeftChecked.length})`, `Add (${validLeftChecked.length})`)
                  : bi("关联", "Add")}{" "}
                <IconRight />
              </Button>
              <Button
                size="small"
                disabled={busy || validRightChecked.length === 0}
                loading={busy && validRightChecked.length > 0}
                onClick={() =>
                  void batchSetAgentsBound(
                    validRightChecked.map((a) => a.id),
                    false,
                  )
                }
              >
                <IconLeft />{" "}
                {validRightChecked.length > 0
                  ? bi(`移除 (${validRightChecked.length})`, `Remove (${validRightChecked.length})`)
                  : bi("移除", "Remove")}
              </Button>
            </div>

            <div className="ds-tf-pane is-target">
              <div className="ds-tf-head">
                <label className="ds-tf-head-chk">
                  <Checkbox
                    checked={
                      filteredBound.length > 0 &&
                      validRightChecked.length === filteredBound.length
                    }
                    indeterminate={
                      validRightChecked.length > 0 &&
                      validRightChecked.length < filteredBound.length
                    }
                    disabled={busy || filteredBound.length === 0}
                    onChange={(chk) => {
                      const next = new Set(rightChecked);
                      for (const a of filteredBound) {
                        if (chk) next.add(a.id);
                        else next.delete(a.id);
                      }
                      setRightChecked(next);
                    }}
                  />
                  <b>{bi("已关联 Agent", "Associated Agents")}</b>
                </label>
                <span className="ds-tf-cnt is-brand num">
                  {validRightChecked.length > 0
                    ? `${validRightChecked.length} / ${bound.length}`
                    : bound.length}
                </span>
              </div>

              <div className="ds-tf-search">
                <Input
                  size="small"
                  prefix={<IconSearch />}
                  allowClear
                  value={rightQ}
                  onChange={setRightQ}
                  placeholder={bi("按名称、IP、主机名或系统筛选…", "Filter by name, IP, or OS…")}
                />
              </div>

              <div className="ds-tf-list" style={{ height: 399 }}>
                {filteredBound.length === 0 ? (
                  <div className="ds-tf-empty">
                    {bound.length === 0
                      ? bi("从左侧勾选要用于本集群执行的 Agent", "Select Agents from the left pane")
                      : bi("无匹配的已关联 Agent", "No matching Agents")}
                  </div>
                ) : (
                  filteredBound.map((a) => {
                    const checked = rightChecked.has(a.id);
                    const local = isLocalAgent(a);
                    const sub = fmtAgentProbe(a);
                    return (
                      <div
                        key={a.id}
                        className={`ds-tf-row ${checked ? "is-checked" : ""}`}
                        onClick={() => {
                          if (busy) return;
                          const next = new Set(rightChecked);
                          if (checked) next.delete(a.id);
                          else next.add(a.id);
                          setRightChecked(next);
                        }}
                      >
                        <Checkbox checked={checked} disabled={busy} />
                        <div className="ds-tf-item-col">
                          <div className="ds-tf-item-main">
                            <span
                              className={`iam-ag-dot ${
                                a.disabled
                                  ? "is-disabled"
                                  : a.online
                                    ? "is-online"
                                    : "is-offline"
                              }`}
                            />
                            <b className="ds-tf-id">{a.name}</b>
                            <code className="mono faint small">{a.ip}</code>
                            <span className={`ua-path-badge ${local ? "is-local" : ""}`}>
                              {local
                                ? bi("本机免密直连", "Local Direct")
                                : bi("SSH 远程代管", "Jumpbox SSH")}
                            </span>
                          </div>
                          {sub && <div className="ds-tf-item-sub">{sub}</div>}
                        </div>
                        <button
                          type="button"
                          className="ds-tf-quick-btn is-rm"
                          disabled={busy}
                          title={bi("解除关联", "Unbind")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void batchSetAgentsBound([a.id], false);
                          }}
                        >
                          <IconClose />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      </Drawer>

      {liveCheckTask && (
        <LiveExecLogCard
          task={liveCheckTask}
          clusterId={clusterId}
          onCancelled={setLiveCheckTask}
          title={bi("连通性实测输出", "Connectivity Test")}
        />
      )}

      {recent.length > 0 && (
        <section className="ua-sec">
          <div className="ua-sec-head">
            <h2>
              {bi("近期自动执行记录", "Recent Automated Tasks")}{" "}
              <em className="num">{recent.length}</em>
            </h2>
            <Button
              size="mini"
              type="text"
              icon={<IconRefresh />}
              onClick={() => void load(false)}
            >
              {bi("刷新", "Refresh")}
            </Button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {recent.slice(0, 8).map((t) => (
              <LiveExecLogCard
                key={t.id}
                task={t}
                clusterId={clusterId}
                compact
                title={t.step_title || t.kind}
              />
            ))}
          </div>
        </section>
      )}

      <SelectExecutionAgentModal
        visible={checkModalOpen}
        clusterId={clusterId}
        taskTitle={bi("集群节点连通性实测", "Cluster Host Connectivity Check")}
        readOnly
        hostsFallback={summary?.hosts}
        confirmLoading={checkBusy}
        onCancel={() => setCheckModalOpen(false)}
        onConfirm={(choice) => void runConnectivityCheck(choice)}
        onSummaryUpdated={setSummary}
      />
    </div>
  );
}

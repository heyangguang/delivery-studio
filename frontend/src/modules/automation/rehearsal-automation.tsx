import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  InputNumber,
  Message,
  Modal,
  Popover,
  Select,
  Skeleton,
} from "@arco-design/web-react";
import {
  IconCheckCircle,
  IconCloseCircle,
  IconCopy,
  IconDown,
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
import { api, can, copy, err } from "../../shared/shared";
import { bi, useLang } from "../../app/i18n";
import { invalidateIAMCache } from "../iam/iam";
import { AgentModeSwitch } from "./execution-nodes";
import {
  AgentClusterMode,
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
 * Crisp on-demand Execution Agent Picker Modal (replaces the legacy 3-step setup wizard).
 * Pre-selects the cluster's remembered `last_agent_id`, validates `readonly` vs `readwrite`,
 * and automatically distinguishes local passwordless execution from jumpbox SSH/Ansible.
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
  const canGrant = can("execution.manage|iam.user|iam.team");
  const canEnroll = can("execution.manage");

  const [summary, setSummary] = useState<ClusterAutomationSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [selectedIPs, setSelectedIPs] = useState<string[]>([]);
  const [sshOpen, setSshOpen] = useState(false);
  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState(22);
  const [execMethod, setExecMethod] = useState<"auto" | "ansible" | "ssh">("auto");
  const [grantBusy, setGrantBusy] = useState("");

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

      // Pre-select remembered last_agent_id if eligible, else first online eligible Agent
      const bound = res.unified_agents || [];
      const isEligible = (a: UnifiedAgentView) => {
        if (a.disabled || !a.online || !a.supports_exec) return false;
        const m = a.cluster_modes?.[clusterId];
        if (!m) return false;
        if (!readOnly && m !== "readwrite") return false;
        return true;
      };
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
  }, [clusterId, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Check if multiple direct-only agents cover multiple selected hosts
  const directCoverageCount = useMemo(() => {
    if (selectedIPs.length <= 1) return 0;
    let covered = 0;
    for (const ip of selectedIPs) {
      const ok = boundAgents.some(
        (a) =>
          a.backing === "direct" &&
          a.ip === ip &&
          a.online &&
          !a.disabled &&
          (readOnly || a.cluster_modes?.[clusterId] === "readwrite"),
      );
      if (ok) covered++;
    }
    return covered;
  }, [boundAgents, selectedIPs, readOnly, clusterId]);

  const pickedAgent = useMemo(
    () => boundAgents.find((a) => a.id === selectedAgentId) || null,
    [boundAgents, selectedAgentId],
  );

  const pickedMode = pickedAgent?.cluster_modes?.[clusterId] || "readonly";
  const pickedPermBlocked = Boolean(
    pickedAgent && !readOnly && pickedMode !== "readwrite",
  );
  const pickedCanRun =
    selectedAgentId === "__direct__"
      ? directCoverageCount === selectedIPs.length && selectedIPs.length > 0
      : Boolean(
          pickedAgent &&
            pickedAgent.online &&
            !pickedAgent.disabled &&
            pickedAgent.supports_exec &&
            !pickedPermBlocked,
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

  const quickGrantAgent = async (agentId: string, mode: AgentClusterMode) => {
    if (grantBusy) return;
    setGrantBusy(agentId);
    try {
      await api("/api/executions/unified-agents", {
        method: "PATCH",
        body: JSON.stringify({
          id: agentId,
          set_cluster: { cluster_id: clusterId, mode },
        }),
      });
      invalidateIAMCache();
      await refreshSummary();
      setSelectedAgentId(agentId);
      Message.success(
        mode === "readwrite"
          ? bi("已授权该 Agent 读写权限", "Granted Read-Write to Agent")
          : bi("已授权该 Agent 只读权限", "Granted Read-Only to Agent"),
      );
    } catch (e) {
      err(e);
    } finally {
      setGrantBusy("");
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
              ? bi("只读采集（需只读或读写 Agent）", "Read-Only Task")
              : bi("变更操作（需读写 Agent）", "Read-Write Task")}
          </span>
        </div>

        {loading && !summary ? (
          <Skeleton animation text={{ rows: 4 }} />
        ) : (
          <>
            <div className="sea-sec">
              <div className="sea-sec-head">
                <b>{bi("1. 选择本集群已启用的 Agent", "1. Authorized Cluster Agents")}</b>
                <button
                  type="button"
                  className="iam-text-act"
                  onClick={() => {
                    onCancel();
                    go({ name: "accounts", id: "~clusters" });
                  }}
                >
                  {bi("管理集群权限 →", "Cluster Permissions →")}
                </button>
              </div>

              {boundAgents.length === 0 ? (
                <div className="sea-empty-box">
                  <p>
                    {bi(
                      `集群「${clusterId}」尚未启用任何执行 Agent。`,
                      `No Agent is authorized for cluster "${clusterId}" yet.`,
                    )}
                  </p>
                  {canGrant && availableAgents.length > 0 && (
                    <div className="sea-quick-bind">
                      <span className="small faint">
                        {bi("一键启用已有 Agent：", "Quickly authorize an existing Agent:")}
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
                              loading={grantBusy === a.id}
                              onClick={() =>
                                void quickGrantAgent(
                                  a.id,
                                  readOnly ? "readonly" : "readwrite",
                                )
                              }
                            >
                              {readOnly
                                ? bi("启用（只读）", "Enable RO")
                                : bi("启用（读写）", "Enable RW")}
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {canEnroll && (
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
                      {bi("前往执行中心接入新 Agent", "Enroll New Agent")}
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
                        <b>{bi("各目标节点本机 Agent 自动匹配", "Per-Host Local Agents")}</b>
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
                    const mode = a.cluster_modes?.[clusterId] || "readonly";
                    const roBlocked = !readOnly && mode !== "readwrite";
                    const unusable =
                      a.disabled || !a.online || !a.supports_exec || roBlocked;
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
                              : bi("远程代管", "Jumpbox")}
                          </span>
                        </div>
                        <div className="sea-agent-right">
                          <span
                            className={`iam-lvl-tag is-${mode === "readwrite" ? "operate" : "view"}`}
                          >
                            {mode === "readwrite"
                              ? bi("读写", "RW")
                              : bi("只读", "RO")}
                          </span>
                          {roBlocked && canGrant && (
                            <Button
                              size="mini"
                              type="outline"
                              loading={grantBusy === a.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                void quickGrantAgent(a.id, "readwrite");
                              }}
                            >
                              {bi("切为读写", "Set RW")}
                            </Button>
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
 * Shows bound cluster Agents (with Enable/Disable & RO/RW switch), 1-click connectivity test,
 * and recent execution logs — with zero 3-step pre-configuration ceremony.
 */
export function ClusterAutomationPanel({
  clusterId,
  onChanged,
}: {
  clusterId: string;
  onChanged?: (summary: ClusterAutomationSummary) => void;
}) {
  useLang();
  const canGrant = can("execution.manage|iam.user|iam.team");
  const canExec = can("delivery.execute|execution.manage");

  const [summary, setSummary] = useState<ClusterAutomationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [addPopOpen, setAddPopOpen] = useState(false);
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

  const setAgentMode = async (agentId: string, mode: "" | AgentClusterMode) => {
    if (busyKey) return;
    setBusyKey(agentId);
    try {
      await api("/api/executions/unified-agents", {
        method: "PATCH",
        body: JSON.stringify({
          id: agentId,
          set_cluster: { cluster_id: clusterId, mode },
        }),
      });
      invalidateIAMCache();
      await load(true);
    } catch (e) {
      err(e);
    } finally {
      setBusyKey("");
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

  return (
    <div className="rha-clean-panel">
      <section className="ua-sec">
        <div className="ua-sec-head">
          <div>
            <h2>
              {bi("本集群关联的执行 Agent", "Authorized Execution Agents")}{" "}
              <em className="num">{bound.length}</em>
            </h2>
            <p className="faint small">
              {bi(
                "在集群中点击「执行」时可直接从下方已启用的 Agent 中选择运行；权限与「IAM → 集群权限」实时互通。",
                "When running probes or change steps in this cluster, pick from enabled Agents below. Synced with IAM → Cluster Permissions.",
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
            {canGrant && available.length > 0 && (
              <Popover
                trigger="click"
                position="br"
                popupVisible={addPopOpen}
                onVisibleChange={setAddPopOpen}
                unmountOnExit
                content={
                  <div className="iam-quick-pop">
                    <div className="iam-quick-pop-head">
                      <b>{bi("关联已有 Agent", "Authorize Existing Agent")}</b>
                    </div>
                    <div className="iam-quick-pop-list">
                      {available.map((a) => (
                        <div key={a.id} className="iam-quick-pop-row">
                          <span className="iam-quick-pop-who">
                            <span
                              className={`iam-ag-dot ${a.online && !a.disabled ? "is-online" : "is-offline"}`}
                            />
                            <b>{a.name}</b>
                            <small className="mono faint">{a.ip}</small>
                          </span>
                          <span className="iam-quick-pop-btns">
                            <button
                              type="button"
                              className="iam-lvl-tag is-view is-btn"
                              onClick={() => {
                                setAddPopOpen(false);
                                void setAgentMode(a.id, "readonly");
                              }}
                            >
                              {bi("+ 只读", "+ RO")}
                            </button>
                            <button
                              type="button"
                              className="iam-lvl-tag is-operate is-btn"
                              onClick={() => {
                                setAddPopOpen(false);
                                void setAgentMode(a.id, "readwrite");
                              }}
                            >
                              {bi("+ 读写", "+ RW")}
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                }
              >
                <Button size="small" type="primary" icon={<IconPlus />}>
                  {bi("关联 Agent", "Add Agent")}
                </Button>
              </Popover>
            )}
            <Button
              size="small"
              type="outline"
              icon={<IconSettings />}
              onClick={() => {
                saveAgentEnrollPrefill({
                  cluster: clusterId,
                  host: summary?.hosts?.[0]?.name,
                  ip: summary?.hosts?.[0]?.ip,
                });
                go({ name: "executions", view: "nodes" });
              }}
            >
              {bi("接入新 Agent", "Enroll Agent")}
            </Button>
          </div>
        </div>

        {bound.length === 0 ? (
          <div className="ua-cluster-empty">
            <span className="faint">
              {bi(
                "当前集群尚未关联任何执行 Agent。关联后即可在基线巡检与变更演练中一键选择 Agent 自动执行。",
                "No Agent authorized for this cluster yet.",
              )}
            </span>
          </div>
        ) : (
          <div className="ua-cluster-ledger">
            {bound.map((a) => {
              const mode = a.cluster_modes?.[clusterId] || "readonly";
              const isLocal =
                a.backing === "direct" ||
                Boolean(summary?.hosts?.some((h) => h.ip.trim() === a.ip.trim()));
              return (
                <div
                  key={a.id}
                  className={`ua-cluster-row ${busyKey === a.id ? "is-busy" : ""}`}
                >
                  <div className="ua-cluster-info">
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
                    <span className={`ua-path-badge ${isLocal ? "is-local" : ""}`}>
                      {isLocal
                        ? bi("本机免密直连", "Local Direct")
                        : bi("远程代管 (SSH / Ansible)", "Remote Jumpbox")}
                    </span>
                    {summary?.last_agent_id === a.id && (
                      <span className="iam-app-pill">
                        {bi("上次使用", "Last Used")}
                      </span>
                    )}
                  </div>
                  <div className="ua-cluster-ctrl">
                    <AgentModeSwitch
                      value={mode}
                      disabled={!canGrant || !!busyKey}
                      onChange={(next) => void setAgentMode(a.id, next)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Radio,
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
} from "./execution-types";
import { EnrollAgentModal } from "./enroll-agent-modal";
import { ProTransfer, ProTransferItem } from "../../design/transfer";
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
                {canEnrollAgent && !readOnly && (
                  <InPlaceEnrollButton
                    asText
                    clusterId={clusterId}
                    hosts={hosts}
                    label={bi("+ 接入新 Agent", "+ Enroll Agent")}
                    onEnrolled={(ag) => {
                      void refreshSummary().then(() => setSelectedAgentId(ag.id));
                    }}
                  />
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
                    <InPlaceEnrollButton
                      clusterId={clusterId}
                      hosts={hosts}
                      label={bi("就地接入新 Agent", "Enroll New Agent")}
                      onEnrolled={(ag) => {
                        void refreshSummary().then(() => setSelectedAgentId(ag.id));
                      }}
                    />
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

function InPlaceEnrollButton({
  clusterId,
  hosts,
  label,
  size = "small",
  type = "outline",
  asText = false,
  onEnrolled,
}: {
  clusterId: string;
  hosts?: ClusterAutomationHost[];
  label: string;
  size?: "mini" | "small" | "default";
  type?: "primary" | "secondary" | "outline";
  asText?: boolean;
  onEnrolled: (ag: UnifiedAgentView) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {asText ? (
        <button
          type="button"
          className="iam-text-act"
          onClick={() => setOpen(true)}
        >
          {label}
        </button>
      ) : (
        <Button
          size={size}
          type={type}
          icon={<IconPlus />}
          onClick={() => setOpen(true)}
        >
          {label}
        </Button>
      )}
      <EnrollAgentModal
        visible={open}
        onClose={() => setOpen(false)}
        defaultClusterId={clusterId}
        clusterHosts={hosts}
        onEnrolled={onEnrolled}
      />
    </>
  );
}

/**
 * Clean, Mutually-Exclusive Cluster Automation Panel (under Cluster Detail -> Automation tab).
 * A cluster operates in ONE chosen mode at a time:
 *   - Mode A ("jumpbox"): Unified Controller / Jumpbox Agent schedules all cluster nodes via SSH/Ansible
 *   - Mode B ("per_host"): Lightweight passwordless Direct Agents installed on each of this cluster's machines
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
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollMode, setEnrollMode] = useState<"cluster_hosts" | "jumpbox">(
    "cluster_hosts",
  );
  const [enrollHostPrefill, setEnrollHostPrefill] = useState<{
    name?: string;
    ip?: string;
  }>({});
  const [scopeFilter, setScopeFilter] = useState<"all" | "online">("all");
  const [checkModalOpen, setCheckModalOpen] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [liveCheckTask, setLiveCheckTask] =
    useState<RehearsalExecTask | null>(null);

  const load = useCallback(
    async (silent = false) => {
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
    },
    [clusterId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const batchSetAgentsBound = async (
    agentIds: string[],
    bound: boolean,
    setTransport?: "node" | "agent",
  ) => {
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
      if (setTransport) {
        await api(
          `/api/clusters/${encodeURIComponent(clusterId)}/automation`,
          {
            method: "PUT",
            body: JSON.stringify({ enabled: true, transport: setTransport }),
          },
        ).catch(() => undefined);
      }
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

  const clusterHosts = summary?.hosts || [];
  const clusterIPSet = new Set(clusterHosts.map((h) => h.ip.trim()));
  const bound = summary?.unified_agents || [];
  const available = summary?.available_agents || [];
  const recent = summary?.recent_tasks || [];

  // Determine the single active mode when bound.length > 0 (zero mixing / contradiction!)
  const isPerHostDirectMode =
    bound.length > 0 &&
    (summary?.config?.transport === "agent" ||
      bound.some((a) => a.backing === "direct") ||
      (bound.length > 1 && bound.every((a) => clusterIPSet.has(a.ip.trim()))));

  const fmtAgentProbe = (a?: UnifiedAgentView) => {
    if (!a) return "";
    const parts: string[] = [];
    if (a.probe?.os) parts.push(a.probe.os);
    else if (a.probe?.hostname) parts.push(a.probe.hostname);
    if (a.probe?.cpu_cores) parts.push(`${a.probe.cpu_cores} vCPU`);
    if (a.probe?.mem_used_pct !== undefined)
      parts.push(`Mem ${a.probe.mem_used_pct.toFixed(0)}%`);
    return parts.join(" · ");
  };

  const onlineAvailCount = available.filter(
    (a) => a.online && !a.disabled,
  ).length;

  const makeAgentTransferItem = (a: UnifiedAgentView): ProTransferItem => {
    const sub = fmtAgentProbe(a);
    return {
      key: a.id,
      title: a.name,
      badge: a.ip,
      statusDot: a.disabled
        ? "disabled"
        : a.online
          ? "online"
          : "offline",
      subtitle:
        sub ||
        (a.online ? bi("在线就绪", "Online") : bi("离线", "Offline")),
      searchText: [
        a.name,
        a.ip,
        a.probe?.hostname || "",
        a.probe?.os || "",
      ].join(" "),
    };
  };

  const leftTransferAgents = available
    .filter((a) => (scopeFilter === "online" ? a.online && !a.disabled : true))
    .map(makeAgentTransferItem);
  const rightTransferAgents = bound.map(makeAgentTransferItem);

  const openEnrollModalWith = (
    mode: "cluster_hosts" | "jumpbox",
    host?: { name?: string; ip?: string },
  ) => {
    setEnrollMode(mode);
    setEnrollHostPrefill(host || {});
    setEnrollOpen(true);
  };

  const boundHostCount = clusterHosts.filter((h) =>
    bound.some((a) => a.ip.trim() === h.ip.trim()),
  ).length;
  const missingHostCount = Math.max(0, clusterHosts.length - boundHostCount);
  const primaryController =
    bound.find((a) => a.online && !a.disabled) || bound[0] || null;

  return (
    <div className="rha-clean-panel">
      {bound.length === 0 ? (
        /* ==================== STATE 0: CHOOSE ONE EXECUTION MODE ==================== */
        <section className="ua-sec">
          <div className="ua-sec-head">
            <div>
              <h2>{bi("配置集群自动化执行方式", "Configure Cluster Automation")}</h2>
              <p className="faint small">
                {bi(
                  "请为当前集群选择一种执行模式（跳板机统一代管 或 集群机器本机直连），避免多模式混用。",
                  "Choose one execution mode for this cluster (Jumpbox Controller or Per-Node Direct Agents).",
                )}
              </p>
            </div>
          </div>

          {clusterHosts.length > 0 && (
            <div className="rha-target-strip">
              <span className="rha-target-lbl">
                {bi(
                  `本集群目标机器 (${clusterHosts.length} 台)：`,
                  `Cluster Target Nodes (${clusterHosts.length}):`,
                )}
              </span>
              {clusterHosts.map((h) => (
                <span key={`${h.name}-${h.ip}`} className="rha-target-chip">
                  <b>{h.name}</b>
                  <code
                    className="mono"
                    title={bi("点击复制 IP", "Click to copy IP")}
                    onClick={() => copy(h.ip, bi("已复制 IP", "Copied IP"))}
                  >
                    {h.ip}
                  </code>
                  {h.role && <span className="rha-host-role">{h.role}</span>}
                </span>
              ))}
            </div>
          )}

          {canOperateCluster ? (
            <div className="rha-onboard-grid">
              <div className="rha-onboard-card">
                <div className="rha-onboard-top">
                  <div className="rha-onboard-title">
                    <b>
                      {bi(
                        "模式一：跳板机 / 控制机统一调度",
                        "Mode 1: Unified Jumpbox Controller",
                      )}
                    </b>
                    <span className="ptf-tag">SSH / Ansible</span>
                  </div>
                  <p>
                    {bi(
                      "绑定 1 台可 SSH 访问全集群节点的控制机或跳板机 Agent，统一调度本集群全部目标机器。",
                      "Bind one jumpbox/controller Agent with SSH access to schedule all cluster nodes.",
                    )}
                  </p>
                  {available.length > 0 && (
                    <div className="rha-onboard-pills">
                      {available.slice(0, 3).map((a) => (
                        <span key={a.id} className="rha-onboard-pill">
                          <span
                            className={`iam-ag-dot ${
                              a.online && !a.disabled
                                ? "is-online"
                                : "is-offline"
                            }`}
                          />
                          <b>{a.name}</b>
                          <code className="mono faint">{a.ip}</code>
                        </span>
                      ))}
                      {available.length > 3 && (
                        <span className="rha-onboard-pill faint">
                          +{available.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="rha-onboard-foot">
                  <Button
                    size="small"
                    type="primary"
                    disabled={available.length === 0}
                    onClick={() => {
                      setScopeFilter("all");
                      setTransferOpen(true);
                    }}
                  >
                    {bi(
                      `选择已有控制 Agent (${available.length})`,
                      `Select Existing Agent (${available.length})`,
                    )}
                  </Button>
                  {canEnrollAgent && (
                    <Button
                      size="small"
                      type="outline"
                      icon={<IconPlus />}
                      onClick={() => openEnrollModalWith("jumpbox")}
                    >
                      {bi("新接入跳板机", "Enroll Jumpbox")}
                    </Button>
                  )}
                </div>
              </div>

              {(canEnrollAgent ||
                available.some((a) => clusterIPSet.has(a.ip.trim()))) &&
                clusterHosts.length > 0 && (
                  <div className="rha-onboard-card is-primary">
                    <div className="rha-onboard-top">
                      <div className="rha-onboard-title">
                        <b>
                          {bi(
                            "模式二：本集群机器免密直连",
                            "Mode 2: Per-Node Direct Agents",
                          )}
                        </b>
                        <span className="ptf-tag is-ok">
                          {bi("免 SSH 密码", "Passwordless")}
                        </span>
                      </div>
                      <p>
                        {bi(
                          `直接为本集群这 ${clusterHosts.length} 台机器（${clusterHosts
                            .map((h) => h.name)
                            .join("、")}）配置本机直连 Agent，无需任何跨机 SSH 密钥或密码。`,
                          `Install lightweight local Agents directly on all ${clusterHosts.length} cluster machines without SSH keys or passwords.`,
                        )}
                      </p>
                    </div>
                    <div className="rha-onboard-foot">
                      <Button
                        size="small"
                        type="primary"
                        icon={<IconThunderbolt />}
                        onClick={() => openEnrollModalWith("cluster_hosts")}
                      >
                        {bi(
                          `配置本集群 ${clusterHosts.length} 台机器 Agent`,
                          `Configure ${clusterHosts.length} Cluster Nodes`,
                        )}
                      </Button>
                    </div>
                  </div>
                )}
            </div>
          ) : (
            <div className="ua-cluster-empty">
              <span className="faint">
                {bi(
                  "当前集群尚未配置执行 Agent（你对本集群为只读权限，需创建者或运维成员配置）。",
                  "No execution Agent configured yet (read-only access).",
                )}
              </span>
            </div>
          )}
        </section>
      ) : isPerHostDirectMode ? (
        /* ==================== STATE 2: PER-HOST DIRECT MODE ==================== */
        <section className="ua-sec">
          <div className="rha-mode-banner">
            <div>
              <div className="rha-mode-title">
                <h2>
                  {bi(
                    "自动化执行模式：本集群节点免密直连",
                    "Active Mode: Per-Node Direct Agents",
                  )}
                </h2>
                <span
                  className={`rha-cov-pill num ${
                    boundHostCount === clusterHosts.length &&
                    clusterHosts.length > 0
                      ? "is-ok"
                      : "is-warn"
                  }`}
                >
                  {bi(
                    `${boundHostCount} / ${clusterHosts.length} 台已接入`,
                    `${boundHostCount} / ${clusterHosts.length} bound`,
                  )}
                </span>
              </div>
              <p className="faint small" style={{ margin: "3px 0 0" }}>
                {bi(
                  "每台集群机器通过本机 Agent 直接拉取任务，无需 SSH 密码与跳板机。",
                  "Each cluster node runs tasks locally via its own Agent without SSH.",
                )}
              </p>
            </div>

            <div className="ua-sec-head-acts">
              {canExec && (
                <Button
                  size="small"
                  type="secondary"
                  icon={<IconPlayArrow />}
                  onClick={() => setCheckModalOpen(true)}
                >
                  {bi("连通测试", "Test Connectivity")}
                </Button>
              )}
              {canEnrollAgent && !readOnly && missingHostCount > 0 && (
                <Button
                  size="small"
                  type="primary"
                  icon={<IconPlus />}
                  onClick={() => openEnrollModalWith("cluster_hosts")}
                >
                  {bi(
                    `补齐剩余 ${missingHostCount} 台节点`,
                    `Install Remaining (${missingHostCount})`,
                  )}
                </Button>
              )}
              {canOperateCluster && (
                <Popconfirm
                  position="br"
                  title={bi(
                    "解除当前全部关联并重选执行模式？",
                    "Unbind all Agents to switch execution mode?",
                  )}
                  content={bi(
                    "仅解除与本集群的绑定关系，不会卸载机器上的 Agent 服务。",
                    "Only removes cluster association; Agent services remain intact.",
                  )}
                  onOk={() =>
                    void batchSetAgentsBound(
                      bound.map((a) => a.id),
                      false,
                    )
                  }
                >
                  <Button size="small" type="text" status="danger" disabled={busy}>
                    {bi("切换执行模式", "Switch Mode")}
                  </Button>
                </Popconfirm>
              )}
            </div>
          </div>

          <div className="rha-node-direct-ledger" role="table">
            <div className="rha-nd-head" role="row">
              <span>{bi("集群节点", "Node")}</span>
              <span>{bi("角色", "Role")}</span>
              <span>{bi("节点 IP", "Node IP")}</span>
              <span>{bi("本机 Agent 状态", "Local Agent Status")}</span>
              <span>{bi("主机系统与实时探针", "OS & Probe")}</span>
              <span style={{ justifyContent: "flex-end" }}>
                {bi("操作", "Action")}
              </span>
            </div>
            {clusterHosts.map((h) => {
              const hit = bound.find((a) => a.ip.trim() === h.ip.trim());
              const availSameIP = !hit
                ? available.find((a) => a.ip.trim() === h.ip.trim())
                : undefined;
              const probeStr = fmtAgentProbe(hit);
              return (
                <div key={`${h.name}-${h.ip}`} className="rha-nd-row" role="row">
                  <div>
                    <b className="ds-tf-id" title={h.name}>
                      {h.name}
                    </b>
                  </div>
                  <div>
                    {h.role ? (
                      <span className="rha-host-role">{h.role}</span>
                    ) : (
                      <span className="faint small">—</span>
                    )}
                  </div>
                  <div>
                    <code className="mono small">{h.ip}</code>
                  </div>
                  <div>
                    {hit ? (
                      <span
                        className={`rha-host-cov ${
                          hit.online && !hit.disabled ? "is-direct" : "is-off"
                        }`}
                      >
                        ●{" "}
                        {hit.disabled
                          ? bi("已禁用", "Disabled")
                          : hit.online
                            ? bi("在线就绪", "Online")
                            : bi("等待上线", "Offline")}
                      </span>
                    ) : (
                      <span className="rha-host-cov is-none">
                        ○ {bi("未安装", "Not Installed")}
                      </span>
                    )}
                  </div>
                  <div>
                    <span
                      className="small faint"
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {hit
                        ? probeStr || bi("等待心跳上报探针…", "Awaiting probe…")
                        : "—"}
                    </span>
                  </div>
                  <div>
                    {hit ? (
                      canOperateCluster && (
                        <Button
                          size="mini"
                          type="secondary"
                          status="danger"
                          disabled={busy}
                          onClick={() => void batchSetAgentsBound([hit.id], false)}
                        >
                          {bi("解除", "Unbind")}
                        </Button>
                      )
                    ) : canOperateCluster && availSameIP ? (
                      <Button
                        size="mini"
                        type="primary"
                        disabled={busy}
                        onClick={() =>
                          void batchSetAgentsBound(
                            [availSameIP.id],
                            true,
                            "agent",
                          )
                        }
                      >
                        {bi("直接关联", "Bind")}
                      </Button>
                    ) : (
                      canEnrollAgent &&
                      !readOnly && (
                        <Button
                          size="mini"
                          type="outline"
                          icon={<IconPlus />}
                          onClick={() =>
                            openEnrollModalWith("cluster_hosts", {
                              name: h.name,
                              ip: h.ip,
                            })
                          }
                        >
                          {bi("安装", "Install")}
                        </Button>
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : (
        /* ==================== STATE 1: UNIFIED CONTROLLER / JUMPBOX MODE ==================== */
        <section className="ua-sec">
          <div className="rha-mode-banner">
            <div>
              <div className="rha-mode-title">
                <h2>
                  {bi(
                    "自动化执行模式：控制机统一调度",
                    "Active Mode: Unified Controller",
                  )}
                </h2>
                <span className="ptf-tag">SSH / Ansible</span>
              </div>
              <p className="faint small" style={{ margin: "3px 0 0" }}>
                {bi(
                  "由下方已关联的控制机 / 跳板机 Agent 统一连接并调度本集群全部目标节点。",
                  "All target nodes in this cluster are uniformly scheduled through the associated controller Agent(s).",
                )}
              </p>
            </div>

            <div className="ua-sec-head-acts">
              {canExec && (
                <Button
                  size="small"
                  type="secondary"
                  icon={<IconPlayArrow />}
                  onClick={() => setCheckModalOpen(true)}
                >
                  {bi("连通测试", "Test Connectivity")}
                </Button>
              )}
              {canOperateCluster && (
                <Button
                  size="small"
                  type="secondary"
                  icon={<IconSettings />}
                  onClick={() => {
                    setScopeFilter("all");
                    setTransferOpen(true);
                  }}
                >
                  {bi("更换 / 管理控制 Agent", "Change Controller")}
                </Button>
              )}
              {canOperateCluster && (
                <Popconfirm
                  position="br"
                  title={bi(
                    "解除当前控制机关联并重选执行模式？",
                    "Unbind controller Agent(s) to switch mode?",
                  )}
                  content={bi(
                    "解除后可重新选择「跳板机统一调度」或「本集群节点各自免密直连」。",
                    "After unbinding, you can choose Jumpbox or Per-Node Direct mode.",
                  )}
                  onOk={() =>
                    void batchSetAgentsBound(
                      bound.map((a) => a.id),
                      false,
                    )
                  }
                >
                  <Button size="small" type="text" status="danger" disabled={busy}>
                    {bi("切换执行模式", "Switch Mode")}
                  </Button>
                </Popconfirm>
              )}
            </div>
          </div>

          <div className="rha-ag-ledger" role="table">
            <div className="rha-ag-head" role="row">
              <span>{bi("控制 Agent 名称", "Controller Agent")}</span>
              <span>{bi("机器 IP", "Host IP")}</span>
              <span>{bi("主机系统与探针负载", "OS & Probe Telemetry")}</span>
              <span>{bi("调度范围", "Scope")}</span>
              <span style={{ justifyContent: "flex-end" }}>
                {bi("状态与操作", "Status & Action")}
              </span>
            </div>
            {bound.map((a) => {
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
                    <span
                      className="small faint"
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {probeSummary || bi("等待探针上报", "Awaiting probe")}
                    </span>
                  </div>
                  <div>
                    <span className="ptf-tag is-cobalt">
                      {bi(
                        `全集群 ${clusterHosts.length || 1} 节点`,
                        `All ${clusterHosts.length || 1} Nodes`,
                      )}
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

            {clusterHosts.length > 0 && (
              <div className="rha-sub-hosts-foot">
                <span>
                  {primaryController?.online && !primaryController.disabled
                    ? bi(
                        `受管节点（均由 ${primaryController.name} 统一调度）：`,
                        `Managed nodes (scheduled via ${primaryController.name}):`,
                      )
                    : bi(
                        `受管节点（等待控制机 ${primaryController?.name || ""} 恢复在线）：`,
                        `Managed nodes (waiting for ${primaryController?.name || "controller"}):`,
                      )}
                </span>
                {clusterHosts.map((h) => (
                  <span key={`${h.name}-${h.ip}`} className="rha-target-chip">
                    <b>{h.name}</b>
                    <code className="mono">{h.ip}</code>
                    {h.role && <span className="rha-host-role">{h.role}</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <EnrollAgentModal
        visible={enrollOpen}
        onClose={() => setEnrollOpen(false)}
        defaultClusterId={clusterId}
        clusterMode={enrollMode}
        defaultHostName={enrollHostPrefill.name}
        defaultHostIP={enrollHostPrefill.ip}
        clusterHosts={clusterHosts}
        existingAgents={[...bound, ...available]}
        onEnrolled={() => void load(true)}
      />

      <Modal
        style={{ width: 840, maxWidth: "96vw" }}
        visible={transferOpen && canOperateCluster}
        onCancel={() => setTransferOpen(false)}
        footer={null}
        title={
          <span className="iam-drawer-title">
            <span>{bi("选择控制机 / 跳板机 Agent", "Select Controller Agent")}</span>
            <code className="mono">{clusterId}</code>
          </span>
        }
      >
        <div className="rha-clean-panel">
          <ProTransfer
            height={340}
            busy={busy}
            leftTitle={bi("平台可用 Agent", "Available Agents")}
            rightTitle={bi("本集群已关联 Agent", "Associated Agents")}
            leftItems={leftTransferAgents}
            rightItems={rightTransferAgents}
            leftPlaceholder={bi(
              "搜索 Agent 名称、机器 IP、主机名或操作系统…",
              "Search Agent name, IP, hostname, or OS…",
            )}
            topBar={
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", gap: 8 }}>
                <Radio.Group
                  type="button"
                  size="small"
                  value={scopeFilter}
                  onChange={(v) => setScopeFilter(v as "all" | "online")}
                >
                  <Radio value="all">
                    {bi("全部可用", "All")} ({available.length})
                  </Radio>
                  <Radio value="online">
                    {bi("仅在线", "Online")} ({onlineAvailCount})
                  </Radio>
                </Radio.Group>
                {canEnrollAgent && (
                  <Button
                    size="small"
                    type="outline"
                    icon={<IconPlus />}
                    onClick={() => {
                      setTransferOpen(false);
                      openEnrollModalWith("jumpbox");
                    }}
                  >
                    {bi("新接入跳板机 Agent", "Enroll New Jumpbox")}
                  </Button>
                )}
              </div>
            }
            onAdd={(ids) => void batchSetAgentsBound(ids, true, "node")}
            onRemove={(ids) => void batchSetAgentsBound(ids, false)}
          />

          <div
            className="eam-foot"
            style={{ paddingTop: 10, borderTop: "1px solid var(--line)" }}
          >
            <span className="faint small" style={{ marginRight: "auto" }}>
              {bi(
                `当前已关联 ${bound.length} 台控制 Agent（操作实时保存生效）`,
                `${bound.length} controller Agent(s) associated`,
              )}
            </span>
            <Button type="primary" onClick={() => setTransferOpen(false)}>
              {bi("完成", "Done")}
            </Button>
          </div>
        </div>
      </Modal>

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

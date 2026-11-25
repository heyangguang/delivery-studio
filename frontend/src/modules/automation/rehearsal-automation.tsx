import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
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
  IconArrowLeft,
  IconArrowRight,
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
  IconRight,
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
  ClusterAutomationHost,
  ClusterAutomationSummary,
  RehearsalExecTask,
  RehearsalExecTarget,
  isRehearsalTaskTerminal,
  saveAgentEnrollPrefill,
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

type PanelViewMode = "paused" | "wizard" | "manage";
type WizardStep = 1 | 2 | 3;

type AutomationReturnContext = {
  tab: "rehearsal";
  rehearsal?: string;
  ts: number;
};

const AUTO_RETURN_PREFIX = "ds:auto-return:";
const AUTO_RETURN_TTL_MS = 15 * 60 * 1000;

/** Navigates to the single source of truth: Cluster → Automation tab. */
export function navigateToClusterAutomation(
  clusterId: string,
  returnCtx?: { tab: "rehearsal"; rehearsal?: string },
) {
  try {
    const key = `${AUTO_RETURN_PREFIX}${clusterId}`;
    if (returnCtx) {
      sessionStorage.setItem(
        key,
        JSON.stringify({ ...returnCtx, ts: Date.now() } satisfies AutomationReturnContext),
      );
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore storage quota / private-mode errors
  }
  go({ name: "deliveries", id: clusterId, tab: "automation" });
}

function readAutomationReturnContext(clusterId: string): AutomationReturnContext | null {
  try {
    const raw = sessionStorage.getItem(`${AUTO_RETURN_PREFIX}${clusterId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AutomationReturnContext;
    if (!parsed || parsed.tab !== "rehearsal") return null;
    if (!parsed.ts || Date.now() - parsed.ts > AUTO_RETURN_TTL_MS) {
      sessionStorage.removeItem(`${AUTO_RETURN_PREFIX}${clusterId}`);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function clearAutomationReturnContext(clusterId: string) {
  try {
    sessionStorage.removeItem(`${AUTO_RETURN_PREFIX}${clusterId}`);
  } catch {}
}

function hasSavedAutomationSetup(res: ClusterAutomationSummary): boolean {
  return Boolean(
    res.config.updated_at ||
      res.config.node_id ||
      (res.config.custom_hosts && res.config.custom_hosts.length > 0) ||
      res.agents.some((a) => a.desired === "active"),
  );
}

function isConfigDirty(a: ClusterAutomationConfig, b: ClusterAutomationConfig): boolean {
  if (
    a.transport !== b.transport ||
    (a.node_id || "") !== (b.node_id || "") ||
    (a.node_exec_method || "auto") !== (b.node_exec_method || "auto") ||
    (a.ssh_user || "root") !== (b.ssh_user || "root") ||
    (a.ssh_port || 22) !== (b.ssh_port || 22) ||
    a.env_kind !== b.env_kind ||
    (a.default_pacing || "step_confirm") !== (b.default_pacing || "step_confirm") ||
    Boolean(a.pause_before_mutate) !== Boolean(b.pause_before_mutate) ||
    Boolean(a.allow_prod_mutate) !== Boolean(b.allow_prod_mutate)
  ) {
    return true;
  }
  const ah = a.custom_hosts || [];
  const bh = b.custom_hosts || [];
  if (ah.length !== bh.length) return true;
  return ah.some(
    (h, i) =>
      h.name !== bh[i]?.name || h.ip !== bh[i]?.ip || (h.role || "") !== (bh[i]?.role || ""),
  );
}

export function ClusterAutomationPanel({
  clusterId,
  onChanged,
}: {
  clusterId: string;
  onChanged?: (summary: ClusterAutomationSummary) => void;
}) {
  useLang();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [summary, setSummary] = useState<ClusterAutomationSummary | null>(null);
  const [cfg, setCfg] = useState<ClusterAutomationConfig | null>(null);
  const [viewMode, setViewMode] = useState<PanelViewMode>("paused");
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [justActivated, setJustActivated] = useState(false);

  // Direct Target Agent enrollment state
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
  const initializedForClusterRef = useRef("");

  const canManage = can("delivery.execute") || can("execution.manage");
  const returnCtx = useMemo(() => readAutomationReturnContext(clusterId), [clusterId]);

  const goBackToRehearsal = () => {
    if (!returnCtx) return;
    clearAutomationReturnContext(clusterId);
    go({
      name: "deliveries",
      id: clusterId,
      tab: "rehearsal",
      rehearsal: returnCtx.rehearsal,
    });
  };

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await api<ClusterAutomationSummary>(
          `/api/clusters/${encodeURIComponent(clusterId)}/automation`,
        );
        setSummary(res);
        if (!silent || initializedForClusterRef.current !== clusterId) {
          initializedForClusterRef.current = clusterId;
          setCfg(res.config);
          setViewMode(res.config.enabled ? "manage" : "paused");
          setWizardStep(1);
          setJustActivated(false);
        }
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
    initializedForClusterRef.current = "";
    setCheckTask(null);
    setEnrolledInfo(null);
    void load(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 5000);
    return () => {
      window.clearInterval(timer);
      checkAbortRef.current?.abort();
    };
  }, [clusterId, load]);

  const patchTransportCfg = (patch: Partial<ClusterAutomationConfig>) => {
    setCfg((cur) => (cur ? { ...cur, ...patch } : cur));
    checkAbortRef.current?.abort();
    setCheckTask(null);
  };

  const startWizard = (preferredTransport?: "node" | "agent") => {
    if (!cfg || !summary) return;
    let draft: ClusterAutomationConfig = {
      ...cfg,
      ...(preferredTransport ? { transport: preferredTransport } : {}),
    };
    if (draft.transport === "node" && !draft.node_id) {
      const bestNode =
        summary.nodes.find((n) => n.online && n.supports_v3) ||
        summary.nodes.find((n) => n.online);
      if (bestNode) {
        draft = { ...draft, node_id: bestNode.id };
      }
    }
    setCfg(draft);
    setCheckTask(null);
    setWizardStep(1);
    setViewMode("wizard");
  };

  const cancelWizard = () => {
    checkAbortRef.current?.abort();
    setCheckTask(null);
    if (summary) {
      setCfg(summary.config);
      setViewMode(summary.config.enabled ? "manage" : "paused");
    } else {
      setViewMode("paused");
    }
  };

  const saveConfig = async (
    override?: Partial<ClusterAutomationConfig>,
    opts?: { toast?: string; activated?: boolean },
  ) => {
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
      setViewMode(res.config.enabled ? "manage" : "paused");
      if (opts?.activated) setJustActivated(true);
      Message.success(
        opts?.toast || bi("集群自动化配置已保存", "Cluster automation settings saved"),
      );
    } catch (e) {
      err(e);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabledImmediate = async (enable: boolean) => {
    if (!summary || togglingEnabled) return;
    const baseCfg = enable ? cfg || summary.config : summary.config;
    setTogglingEnabled(true);
    try {
      const res = await api<ClusterAutomationSummary>(
        `/api/clusters/${encodeURIComponent(clusterId)}/automation`,
        {
          method: "PUT",
          body: JSON.stringify({ ...baseCfg, enabled: enable }),
        },
      );
      setSummary(res);
      setCfg(res.config);
      onChanged?.(res);
      setViewMode(enable ? "manage" : "paused");
      setJustActivated(enable);
      Message.success(
        enable
          ? bi("已恢复启用本集群自动化执行", "Cluster automation re-enabled")
          : bi("已停用自动化执行，已切回手工演练模式", "Cluster automation paused; switched to manual mode"),
      );
    } catch (e) {
      err(e);
    } finally {
      setTogglingEnabled(false);
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
      Message.success(
        bi(`已为 ${host} 生成直连 Agent 接入配置`, `Direct agent enrolled for ${host}`),
      );
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
      Message.success(
        bi(`已撤销 ${agent.host} 的直连 Agent 授权`, `Revoked direct agent on ${agent.host}`),
      );
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
      Message.success(
        bi(
          "已下载一键安装包，解压后执行 sudo bash install.sh 即可上线",
          "Bundle downloaded; extract and run sudo bash install.sh",
        ),
      );
    } catch (e) {
      err(e);
    } finally {
      setDownloadingBundle(false);
    }
  };

  const effectiveHosts = useMemo<ClusterAutomationHost[]>(() => {
    const out: ClusterAutomationHost[] = [];
    const seen = new Set<string>();
    const push = (h: ClusterAutomationHost) => {
      const ip = (h.ip || "").trim();
      const name = (h.name || "").trim() || ip;
      const key = (ip || name).toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ name, ip, role: h.role });
    };
    for (const h of summary?.hosts || []) push(h);
    for (const h of cfg?.custom_hosts || []) push(h);
    return out;
  }, [summary?.hosts, cfg?.custom_hosts]);

  const activeAgentsByIP = useMemo(() => {
    const map = new Map<string, AutomationAgentView>();
    for (const a of summary?.agents || []) {
      if (a.mode !== "direct" || a.desired !== "active") continue;
      const cur = map.get(a.ip);
      if (!cur || (a.online && !cur.online)) {
        map.set(a.ip, a);
      }
    }
    return map;
  }, [summary?.agents]);

  const onlineAgentHostCount = useMemo(
    () => effectiveHosts.filter((h) => activeAgentsByIP.get(h.ip)?.online).length,
    [effectiveHosts, activeAgentsByIP],
  );

  const selectedNode = useMemo(
    () => (cfg?.node_id ? summary?.nodes.find((n) => n.id === cfg.node_id) || null : null),
    [cfg?.node_id, summary?.nodes],
  );

  const checkBlockReason = useMemo(() => {
    if (!cfg || !summary) return "";
    if (effectiveHosts.length === 0) {
      return bi("当前集群暂无目标主机，请先补充目标主机 IP", "No target hosts found; add at least one host IP");
    }
    if (cfg.transport === "node") {
      if (!cfg.node_id) {
        return bi("请先选择一台在线执行节点（控制机）", "Select an online execution node first");
      }
      if (!selectedNode) {
        return bi("所选执行节点不存在，请重新选择", "Selected execution node no longer exists");
      }
      if (!selectedNode.online) {
        return bi(`执行节点「${selectedNode.name}」当前离线`, `Execution node "${selectedNode.name}" is offline`);
      }
      if (!selectedNode.supports_v3) {
        return bi(
          `执行节点「${selectedNode.name}」协议为 v2，需升级至 v3 才支持自动化执行`,
          `Node "${selectedNode.name}" uses protocol v2; upgrade to v3 first`,
        );
      }
      if (!selectedNode.allow_probe) {
        return bi(
          `执行节点「${selectedNode.name}」未开启「只读探针采集」，请先前往「执行中心 → Agent」开启`,
          `Node "${selectedNode.name}" is not authorized for read-only probes; enable it in Execution Center → Agent`,
        );
      }
      return "";
    }
    if (onlineAgentHostCount === 0) {
      return bi(
        "暂无在线的目标机直连 Agent，请先在「执行中心 → Agent」接入对应主机并启动服务",
        "No online Direct Target Agent yet; enroll the hosts in Execution Center → Agent",
      );
    }
    if (onlineAgentHostCount < effectiveHosts.length) {
      return bi(
        `当前 ${onlineAgentHostCount}/${effectiveHosts.length} 台目标主机 Agent 在线，其余主机上线后即可全量自检`,
        `${onlineAgentHostCount}/${effectiveHosts.length} target hosts have online agents`,
      );
    }
    return "";
  }, [cfg, summary, effectiveHosts.length, selectedNode, onlineAgentHostCount]);

  const canRunCheck = Boolean(cfg && summary && canManage && !checkBlockReason);

  const step1CanContinue = useMemo(() => {
    if (!cfg) return false;
    if (cfg.transport === "node") return Boolean(cfg.node_id);
    return true;
  }, [cfg]);

  const step1Hint = useMemo(() => {
    if (!cfg || !summary) return { tone: "neutral" as const, text: "" };
    if (cfg.transport === "node") {
      if (!cfg.node_id) {
        return {
          tone: "warn" as const,
          text:
            summary.nodes.length === 0
              ? bi("暂无已接入的控制机，可先前往「执行中心 → Agent」接入，或切换方式 B", "No control agents yet; enroll in Execution Center → Agent or use Mode B")
              : bi("请先选择一台执行节点（控制机）后继续", "Select an execution node to continue"),
        };
      }
      if (selectedNode && !selectedNode.online) {
        return {
          tone: "warn" as const,
          text: bi(`所选节点「${selectedNode.name}」当前离线，建议切换在线节点`, `Selected node "${selectedNode.name}" is offline`),
        };
      }
      if (selectedNode && !selectedNode.supports_v3) {
        return {
          tone: "warn" as const,
          text: bi(`节点「${selectedNode.name}」为旧版协议 v2，建议先升级节点程序`, `Node "${selectedNode.name}" runs v2; upgrade to v3`),
        };
      }
      return {
        tone: "ok" as const,
        text: bi(
          `已选择在线控制机「${selectedNode?.name || cfg.node_id}」，可进入连通性自检`,
          `Online controller "${selectedNode?.name || cfg.node_id}" selected`,
        ),
      };
    }
    if (onlineAgentHostCount > 0 && onlineAgentHostCount >= effectiveHosts.length) {
      return {
        tone: "ok" as const,
        text: bi(
          `全部 ${onlineAgentHostCount}/${effectiveHosts.length} 台目标机 Agent 在线，可进入连通性自检`,
          `All ${onlineAgentHostCount}/${effectiveHosts.length} Target Agents online`,
        ),
      };
    }
    return {
      tone: "neutral" as const,
      text: bi(
        `当前 ${onlineAgentHostCount}/${effectiveHosts.length} 台 Agent 在线；部署上线后可在下一步验证，也可先继续配置护栏`,
        `${onlineAgentHostCount}/${effectiveHosts.length} Agents online; verify next or continue`,
      ),
    };
  }, [cfg, summary, selectedNode, onlineAgentHostCount, effectiveHosts.length]);

  const runConnectivityCheck = async () => {
    if (!cfg || checking) return;
    checkAbortRef.current?.abort();
    const ctrl = new AbortController();
    checkAbortRef.current = ctrl;
    setChecking(true);
    try {
      const targets: RehearsalExecTarget[] = effectiveHosts.map((h) => ({
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
            node_exec_method: cfg.node_exec_method || "auto",
            ssh_user: cfg.ssh_user || "root",
            ssh_port: cfg.ssh_port || 22,
          }),
        },
      );
      setCheckTask(task);
      const fin = await pollRehearsalExecTask(clusterId, task.id, setCheckTask, ctrl.signal);
      await load(true);
      if (fin.state === "succeeded") {
        Message.success(
          bi("只读连通性自检全部通过，通道已验证可用", "Read-only connectivity check passed"),
        );
      } else {
        Message.warning(
          bi("部分节点连通自检未通过，请查看脱敏输出排查", "Connectivity check reported issues"),
        );
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
    patchTransportCfg({ custom_hosts: next });
    setCustomHostName("");
    setCustomHostIP("");
    setCustomHostRole("");
  };

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

  const methodLabel = (m?: string) =>
    m === "ansible"
      ? bi("Ansible", "Ansible")
      : m === "ssh"
        ? bi("SSH 直连", "Direct SSH")
        : bi("SSH（自动优选）", "SSH (Auto)");

  const channelSummaryText = useMemo(() => {
    if (!cfg) return "";
    if (cfg.transport === "agent") {
      return bi(
        `目标机直连 Agent · ${onlineAgentHostCount}/${effectiveHosts.length} 台在线`,
        `Direct Target Agent · ${onlineAgentHostCount}/${effectiveHosts.length} Online`,
      );
    }
    const nodeLabel = selectedNode
      ? `${selectedNode.name} (${selectedNode.controller_ip})`
      : cfg.node_id || bi("未选择控制机", "No node selected");
    return `${bi("控制机直连", "Controller")} · ${nodeLabel} · ${methodLabel(cfg.node_exec_method)} · ${cfg.ssh_user || "root"}:${cfg.ssh_port || 22}`;
  }, [cfg, selectedNode, onlineAgentHostCount, effectiveHosts.length]);

  const dirty = Boolean(cfg && summary && isConfigDirty(cfg, summary.config));
  const checkPassed = checkTask?.state === "succeeded";
  const checkFailed =
    Boolean(checkTask) &&
    isRehearsalTaskTerminal(checkTask?.state) &&
    checkTask?.state !== "succeeded";
  const savedSetup = summary ? hasSavedAutomationSetup(summary) : false;

  const renderTransportConfig = () => {
    if (!cfg || !summary) return null;
    return (
      <div className="rha-transport-wrap">
        <div className="rha-transport-grid">
          <button
            type="button"
            className={`rha-transport-card ${cfg.transport === "node" ? "is-on" : ""}`}
            disabled={!canManage}
            onClick={() => patchTransportCfg({ transport: "node" })}
          >
            <div className="rha-tc-top">
              <IconDesktop />
              <b>{bi("方式 A · 控制机直连（SSH / Ansible）", "Mode A · Controller (SSH / Ansible)")}</b>
              <span className="rha-tc-badge">
                {summary.nodes.length > 0
                  ? bi(`${summary.nodes.length} 台控制机`, `${summary.nodes.length} Ctrl`)
                  : bi("1 台主控机", "1 Control Host")}
              </span>
            </div>
            <p>
              {bi(
                "由在线执行节点通过 SSH 或 Ansible 访问集群主机，适合已有 SSH 免密或集中跳板机环境。",
                "Control host execution-node accesses cluster hosts over SSH or Ansible.",
              )}
            </p>
          </button>

          <button
            type="button"
            className={`rha-transport-card ${cfg.transport === "agent" ? "is-on" : ""}`}
            disabled={!canManage}
            onClick={() => patchTransportCfg({ transport: "agent" })}
          >
            <div className="rha-tc-top">
              <IconThunderbolt />
              <b>{bi("方式 B · 目标机直连 Agent（免密码）", "Mode B · Direct Target Agent (Passwordless)")}</b>
              <span className="rha-tc-badge is-brand">{bi("无需密码 / 控制机", "No SSH / No Ctrl")}</span>
            </div>
            <p>
              {bi(
                "无 SSH 免密或无独立控制机时，在目标机装轻量 Agent（主动外连 HTTPS），平台直发只读探针与演练步骤。",
                "Zero SSH passwords or control host needed. Install lightweight outbound HTTPS Agent directly on targets.",
              )}
            </p>
          </button>
        </div>

        {cfg.transport === "node" ? (
          <div className="rha-subpanel">
            <div className="rha-form-grid">
              <div className="rha-field">
                <label>{bi("执行节点（控制机）", "Execution Node (Control Host)")}</label>
                <Select
                  placeholder={bi("选择一台在线执行节点", "Select an online execution node")}
                  value={cfg.node_id || undefined}
                  disabled={!canManage}
                  onChange={(v) => patchTransportCfg({ node_id: v })}
                >
                  {summary.nodes.map((n) => (
                    <Select.Option key={n.id} value={n.id}>
                      {n.online ? "● " : "○ "}
                      {n.name} ({n.controller_ip})
                      {n.supports_v3 ? " · v3" : " · v2"}
                      {n.allow_rehearsal
                        ? bi(" · 可演练", " · Rehearsal")
                        : bi(" · 仅只读", " · RO Only")}
                    </Select.Option>
                  ))}
                </Select>
              </div>

              <div className="rha-field">
                <label>{bi("控制机下发方式", "Controller Execution Method")}</label>
                <Select
                  value={cfg.node_exec_method || "auto"}
                  disabled={!canManage}
                  onChange={(v) => patchTransportCfg({ node_exec_method: v })}
                >
                  <Select.Option value="auto">
                    {bi("SSH 直连（自动优选 · 默认推荐）", "Direct SSH (Auto · Recommended)")}
                  </Select.Option>
                  <Select.Option value="ansible">
                    {bi("通过 Ansible 执行（需控制机装有 Ansible）", "Via Ansible (requires ansible installed)")}
                  </Select.Option>
                  <Select.Option value="ssh">
                    {bi("仅非交互 SSH 直连", "Direct BatchMode SSH Only")}
                  </Select.Option>
                </Select>
              </div>

              <div className="rha-field">
                <label>{bi("SSH 登录用户", "SSH User")}</label>
                <Input
                  value={cfg.ssh_user || "root"}
                  disabled={!canManage}
                  onChange={(v) => patchTransportCfg({ ssh_user: v })}
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
                  onChange={(v) => patchTransportCfg({ ssh_port: Number(v) || 22 })}
                />
              </div>
            </div>

            {effectiveHosts.length > 0 && (
              <div className="rha-host-preview">
                <span className="rha-host-preview-lbl">
                  {bi(`将下发至 ${effectiveHosts.length} 台主机：`, `Target hosts (${effectiveHosts.length}):`)}
                </span>
                {effectiveHosts.map((h) => (
                  <span key={`${h.name}-${h.ip}`} className="rha-map-pill">
                    <b>{h.name}</b>
                    <span className="mono">{h.ip}</span>
                    {h.role && <em>· {h.role}</em>}
                  </span>
                ))}
              </div>
            )}

            <div className="rha-field-hint">
              {summary.nodes.length === 0 ? (
                <span>{bi("尚未接入任何执行节点，", "No execution nodes enrolled yet; ")}</span>
              ) : selectedNode && !selectedNode.allow_rehearsal ? (
                <span>
                  {bi(
                    `节点「${selectedNode.name}」当前仅允许只读采集；如需自动执行写步骤，需在节点卡片开启「变更演练步骤执行」，`,
                    `Node "${selectedNode.name}" currently allows read-only probes only; enable Rehearsal Steps on the node to run mutations, `,
                  )}
                </span>
              ) : (
                <span>
                  {bi(
                    "变更写步骤需在节点卡片开启「变更演练步骤执行」，",
                    "Mutating steps require enabling Rehearsal Steps on the node, ",
                  )}
                </span>
              )}
              <button
                type="button"
                className="rha-link-btn"
                onClick={() => go({ name: "executions", view: "nodes" })}
              >
                <IconSettings /> {bi("前往执行中心 → Agent", "Open Execution Center → Agent")}
              </button>
            </div>
          </div>
        ) : (
          <div className="rha-subpanel">
            <div className="rha-agents-head">
              <span>
                {bi(
                  `目标主机自动匹配状态（${onlineAgentHostCount}/${effectiveHosts.length} 台 Agent 在线）`,
                  `Matched Target Hosts (${onlineAgentHostCount}/${effectiveHosts.length} Agents Online)`,
                )}
              </span>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <Button
                  size="mini"
                  type="text"
                  icon={<IconRefresh />}
                  onClick={() => void load(true)}
                >
                  {bi("刷新心跳", "Refresh")}
                </Button>
                <button
                  type="button"
                  className="rha-link-btn"
                  onClick={() => go({ name: "executions", view: "nodes", fleet: "agents" })}
                >
                  <IconSettings /> {bi("管理全平台 Agent", "Manage Agents")}
                </button>
              </div>
            </div>

            <div className="rha-field-hint" style={{ marginTop: 0 }}>
              <span>
                {bi(
                  "按主机 IP 自动匹配「执行中心 → Agent」中已接入的目标机；1 台主机仅需接入 1 次即可跨集群复用。",
                  "Auto-matches Direct Target Agents enrolled in Execution Center → Agent by host IP; enroll each machine once.",
                )}
              </span>
            </div>

            <div className="rha-agent-list">
              {effectiveHosts.length === 0 ? (
                <div className="rha-agent-empty">
                  {bi("当前集群尚未登记主机 IP，请在下方补充目标主机。", "No hosts registered yet; add target hosts below.")}
                </div>
              ) : (
                effectiveHosts.map((h) => {
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
                              ? bi("执行中心尚未接入该主机 IP 的直连 Agent", "Not enrolled in Execution Center yet")
                              : ag.online
                                ? bi(
                                    `已匹配并在线 · 免密直连 · 最近心跳 ${fullTime(ag.last_seen || "")}`,
                                    `Matched & Online · Direct HTTPS · Last seen ${fullTime(ag.last_seen || "")}`,
                                  )
                                : bi(
                                    "已在执行中心签发，等待在目标机启动 Agent 服务…",
                                    "Enrolled in Execution Center; waiting for target-agent daemon…",
                                  )}
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
                                title={bi(
                                  "确定撤销该目标机的直连 Agent 授权？",
                                  "Revoke direct agent on this host?",
                                )}
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
                            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                              <Button
                                size="mini"
                                type="primary"
                                icon={<IconArrowRight />}
                                onClick={() => {
                                  saveAgentEnrollPrefill({
                                    role: "target",
                                    host: h.name,
                                    ip: h.ip,
                                  });
                                  go({ name: "executions", view: "nodes", fleet: "agents" });
                                }}
                              >
                                {bi("去执行中心接入", "Enroll in Center")}
                              </Button>
                              <Button
                                size="mini"
                                type="outline"
                                loading={enrollingHost === h.ip}
                                icon={<IconPlus />}
                                onClick={() => void enrollDirectAgent(h.name, h.ip)}
                              >
                                {bi("就地签发", "Quick Issue")}
                              </Button>
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

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
      </div>
    );
  };

  const renderPacingAndGuardrails = () => {
    if (!cfg) return null;
    const showProdMutate = cfg.env_kind === "prod";
    const showBreakpoint = cfg.default_pacing === "ai_gated_auto";
    return (
      <div className="rha-guard-wrap">
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
                {bi("逐单步人工确认（每步点击执行 + AI 验收）", "Step-by-Step Human Trigger + AI Verify")}
              </Select.Option>
              <Select.Option value="ai_gated_auto">
                {bi("AI 逐单步把关自动推进（验收通过自动继续）", "AI-Gated Step Auto-Advance")}
              </Select.Option>
            </Select>
          </div>
        </div>

        {showProdMutate || showBreakpoint ? (
          <div className="rha-guard-switches">
            {showProdMutate && (
              <div className="rha-guard-row">
                <div className="rha-guard-copy">
                  <b>{bi("允许在生产环境执行变更写操作步骤", "Allow Mutating Steps in Production")}</b>
                  <p>
                    {bi(
                      "关闭时仅放行 100% 只读探针与预检；开启后执行变更步骤前仍须核对集群标识，且与首次交付共享主机互斥锁。",
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

            {showBreakpoint && (
              <div className="rha-guard-row">
                <div className="rha-guard-copy">
                  <b>{bi("高危/变更步骤执行前暂停确认（断点保护）", "Pause Before Mutating Steps (Breakpoint)")}</b>
                  <p>
                    {bi(
                      "开启时，自动推进遇到核心变更步骤（execute）会暂停等你点头；关闭后由 AI 逐单步严格验收通过后自动继续，任何报错或存疑仍立刻停机。",
                      "When on, AI-gated auto-advance pauses before execute-phase steps for human approval. When off, AI strictly gates every step and halts on any error or doubt.",
                    )}
                  </p>
                </div>
                <Switch
                  checked={cfg.pause_before_mutate}
                  disabled={!canManage}
                  onChange={(v) => setCfg({ ...cfg, pause_before_mutate: v })}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="rha-guard-note">
            <IconSafe />
            <span>
              {bi(
                "当前为测试/演练环境 + 逐单步人工确认：每条命令都由你手动点击触发，执行完毕由 AI 自动核对回显，无需额外断点开关。",
                "Test environment with step-by-step confirmation: every step runs only when you click, followed by automatic AI verification.",
              )}
            </span>
          </div>
        )}
      </div>
    );
  };

  if (loading || !cfg || !summary) {
    return (
      <div className="rha-embedded">
        <div className="cx-heading">
          <div>
            <h2>{bi("自动化执行", "Automation")}</h2>
            <p>{bi("正在加载本集群自动化执行通道配置…", "Loading cluster automation settings…")}</p>
          </div>
        </div>
        <div className="cx-spec-card rha-card-body">
          <Skeleton animation text={{ rows: 5 }} />
        </div>
      </div>
    );
  }

  const wizardSteps: { step: WizardStep; title: string }[] = [
    { step: 1, title: bi("接入方式", "Transport") },
    { step: 2, title: bi("连通自检", "Verify") },
    { step: 3, title: bi("节奏与安全", "Guardrails") },
  ];

  const statusPill = summary.config.enabled
    ? summary.verified
      ? { cls: "is-ok", label: bi("已测试连通", "Verified") }
      : summary.ready
        ? { cls: "is-warn", label: bi("待连通自检", "Unverified") }
        : { cls: "is-warn", label: bi("通道待处理", "Needs Attention") }
    : savedSetup
      ? { cls: "", label: bi("已暂停", "Paused") }
      : { cls: "", label: bi("未开启", "Off") };

  return (
    <div className="rha-embedded">
      {/* Native Cluster Tab Section Heading */}
      <div className="cx-heading">
        <div>
          <h2>
            <span>{bi("集群自动化", "Cluster Automation")}</span>
            <span className={`rha-ready-dot ${statusPill.cls}`}>{statusPill.label}</span>
          </h2>
          <p>
            {bi(
              "集中配置本集群的只读探针采集与变更演练自动执行通道；配置并测试连通后，上方「自动化」标签将自动点亮。",
              "Configure read-only probe collection and automated rehearsal execution; the Automation tab lights up once connectivity check passes.",
            )}
          </p>
        </div>
        <div className="cx-heading-actions">
          {returnCtx && (
            <Button size="small" icon={<IconArrowLeft />} onClick={goBackToRehearsal}>
              {bi("返回变更演练", "Back to Rehearsal")}
            </Button>
          )}
          {viewMode === "manage" && canManage && (
            <>
              <Tooltip content={checkBlockReason || undefined} disabled={!checkBlockReason}>
                <Button
                  size="small"
                  type="outline"
                  loading={checking}
                  disabled={!canRunCheck}
                  icon={<IconPlayArrow />}
                  onClick={() => void runConnectivityCheck()}
                >
                  {bi("只读连通性自检", "Read-Only Self-Check")}
                </Button>
              </Tooltip>
              <Popconfirm
                title={bi(
                  "停用后将切回手工演练模式，已有接入配置会保留，随时可一键恢复。确定停用？",
                  "Pause automation and return to manual mode? Saved settings will be preserved.",
                )}
                okText={bi("停用", "Pause")}
                cancelText={bi("取消", "Cancel")}
                onOk={() => void toggleEnabledImmediate(false)}
              >
                <Button size="small" type="text" status="danger" loading={togglingEnabled}>
                  {bi("停用", "Pause")}
                </Button>
              </Popconfirm>
            </>
          )}
        </div>
      </div>

      {/* ---- Mode 1: Disabled / Paused Overview Card (Zero exposed forms, zero empty void) ---- */}
      {viewMode === "paused" && (
        <section className="cx-spec-card">
          <div className="cx-spec-card-head">
            <h3>
              <IconThunderbolt className="rha-ic-warn" />
              <span>{savedSetup ? bi("自动化通道已暂停", "Automation Paused") : bi("开启集群自动化通道", "Enable Cluster Automation")}</span>
              <span className="cx-card-cnt">
                {savedSetup ? bi("配置已保留", "Config Retained") : bi("手工演练模式", "Manual Mode")}
              </span>
            </h3>
            {savedSetup && canManage && (
              <Button
                size="mini"
                type="primary"
                loading={togglingEnabled}
                icon={<IconThunderbolt />}
                onClick={() => void toggleEnabledImmediate(true)}
              >
                {bi("恢复启用", "Resume")}
              </Button>
            )}
          </div>

          <div className="rha-overview-grid">
            <div className="rha-overview-main">
              {savedSetup ? (
                <>
                  <p className="rha-overview-lead">
                    {bi(
                      "当前集群已回退为纯手工复制命令模式；以下接入参数已完整保留，随时可一键恢复或重新配置。",
                      "Manual copy-and-run mode is active. Your saved channel settings below are preserved.",
                    )}
                  </p>
                  <div className="rha-saved-grid">
                    <div className="rha-saved-item">
                      <span>{bi("接入方式", "Transport")}</span>
                      <b>
                        {summary.config.transport === "agent"
                          ? bi("方式 B · 目标机直连 Agent", "Mode B · Direct Target Agent")
                          : bi("方式 A · 控制机直连", "Mode A · Controller")}
                      </b>
                    </div>
                    <div className="rha-saved-item">
                      <span>{bi("执行通道", "Channel")}</span>
                      <b>
                        {summary.config.transport === "agent"
                          ? bi(`${onlineAgentHostCount}/${effectiveHosts.length} 台 Agent 在线`, `${onlineAgentHostCount}/${effectiveHosts.length} Agents Online`)
                          : selectedNode
                            ? `${selectedNode.name} (${selectedNode.online ? bi("在线", "Online") : bi("离线", "Offline")})`
                            : summary.config.node_id || bi("未绑定节点", "Not bound")}
                      </b>
                    </div>
                    <div className="rha-saved-item">
                      <span>{bi("环境属性", "Environment")}</span>
                      <b>
                        {summary.config.env_kind === "prod"
                          ? bi("生产环境（强安全门禁）", "Production")
                          : bi("测试 / 演练环境", "Test / Staging")}
                      </b>
                    </div>
                    <div className="rha-saved-item">
                      <span>{bi("默认推进策略", "Default Pacing")}</span>
                      <b>
                        {summary.config.default_pacing === "ai_gated_auto"
                          ? bi("AI 逐单步把关自动推进", "AI-Gated Auto")
                          : bi("逐单步人工确认", "Step-by-Step Confirm")}
                      </b>
                    </div>
                  </div>
                  {canManage && (
                    <div className="rha-paused-acts">
                      <Button
                        size="small"
                        type="primary"
                        loading={togglingEnabled}
                        icon={<IconThunderbolt />}
                        onClick={() => void toggleEnabledImmediate(true)}
                      >
                        {bi("恢复启用自动化", "Resume Automation")}
                      </Button>
                      <Button
                        size="small"
                        type="outline"
                        icon={<IconSettings />}
                        onClick={() => startWizard()}
                      >
                        {bi("重新配置通道", "Reconfigure Channel")}
                      </Button>
                    </div>
                  )}
                </>
              ) : canManage ? (
                <>
                  <p className="rha-overview-lead">
                    {bi(
                      "当前集群采用纯手工演练模式。选择一种接入方式，按 3 步完成校验即可开启自动化：",
                      "Manual mode is active. Pick a transport below to finish 3-step setup and enable automation:",
                    )}
                  </p>
                  <div className="rha-entry-picks">
                    <button
                      type="button"
                      className="rha-entry-pick"
                      onClick={() => startWizard("node")}
                    >
                      <div className="rha-entry-pick-top">
                        <IconDesktop />
                        <b>{bi("方式 A · 控制机直连（SSH / Ansible）", "Mode A · Controller (SSH / Ansible)")}</b>
                        <span className="rha-tc-badge">
                          {summary.nodes.length > 0
                            ? bi(`${summary.nodes.length} 台控制机`, `${summary.nodes.length} Ctrl`)
                            : bi("1 台主控机", "1 Control Host")}
                        </span>
                      </div>
                      <p>
                        {bi(
                          "适合已有 SSH 免密或集中跳板机环境，选定控制机即可直连各节点。",
                          "Ideal when SSH key trust or a central control host already exists.",
                        )}
                      </p>
                      <span className="rha-entry-pick-go">
                        {bi("选择此方式并配置", "Configure via Controller")} <IconRight />
                      </span>
                    </button>

                    <button
                      type="button"
                      className="rha-entry-pick"
                      onClick={() => startWizard("agent")}
                    >
                      <div className="rha-entry-pick-top">
                        <IconThunderbolt />
                        <b>{bi("方式 B · 目标机直连 Agent（免密码）", "Mode B · Direct Target Agent")}</b>
                        <span className="rha-tc-badge is-brand">
                          {bi("无需密码 / 控制机", "No SSH / No Ctrl")}
                        </span>
                      </div>
                      <p>
                        {bi(
                          "无 SSH 免密或无独立控制机时，在目标机部署轻量外连 Agent，平台直发指令。",
                          "Zero SSH passwords required; deploy lightweight outbound HTTPS agents on target hosts.",
                        )}
                      </p>
                      <span className="rha-entry-pick-go">
                        {bi("选择此方式并配置", "Configure via Target Agent")} <IconRight />
                      </span>
                    </button>
                  </div>
                </>
              ) : (
                <p className="rha-overview-lead">
                  {bi(
                    "本集群尚未开启自动化执行；当前账号仅具只读权限，请联系具备执行权限的管理员完成通道接入。",
                    "Automation is not enabled yet. Contact an operator with execution permissions to configure it.",
                  )}
                </p>
              )}
            </div>

            <aside className="rha-cap-box">
              <div className="rha-cap-eyebrow">{bi("开启后解锁的能力与安全护栏", "Capabilities & Safety Guardrails")}</div>
              <ul className="rha-cap-list">
                <li>
                  <IconSafe />
                  <div>
                    <b>{bi("100% 只读探针自动采集", "100% Read-Only Probes")}</b>
                    <span>{bi("一键采集集群基线与漂移，静态安全门禁拦截任何写操作指令。", "Collect live baseline & drift in 1 click; static gate blocks mutating commands.")}</span>
                  </div>
                </li>
                <li>
                  <IconPlayArrow />
                  <div>
                    <b>{bi("演练步骤逐单步 / AI 把关执行", "Step Confirm or AI-Gated Run")}</b>
                    <span>{bi("实时脱敏日志流，支持手动单步点按或 AI 验收通过后自动推进。", "Live redacted terminal logs with manual trigger or AI-verified auto-advance.")}</span>
                  </div>
                </li>
                <li>
                  <IconCheckCircle />
                  <div>
                    <b>{bi("生产安全门禁与主机互斥锁", "Prod Gate & Host Locks")}</b>
                    <span>{bi("生产写操作默认锁定且需核对集群标识，与首次交付共享互斥锁。", "Production writes locked by default with cluster confirmation and shared host locks.")}</span>
                  </div>
                </li>
              </ul>
            </aside>
          </div>
        </section>
      )}

      {/* ---- Mode 2: Compact Inline 3-Step Setup Card (Zero viewport void) ---- */}
      {viewMode === "wizard" && (
        <section className="cx-spec-card">
          <div className="cx-spec-card-head rha-wiz-head">
            <ol className="rha-inline-steps" aria-label={bi("自动化配置步骤", "Automation setup steps")}>
              {wizardSteps.map((s, idx) => {
                const isDone = wizardStep > s.step || (s.step === 2 && checkPassed);
                const isActive = wizardStep === s.step;
                const canJump = s.step < wizardStep || (s.step > wizardStep && step1CanContinue);
                return (
                  <React.Fragment key={s.step}>
                    {idx > 0 && <IconRight className="rha-step-sep" aria-hidden />}
                    <li>
                      <button
                        type="button"
                        className={`rha-inline-step ${isActive ? "is-active" : ""} ${isDone ? "is-done" : ""}`}
                        disabled={!canJump && !isActive}
                        onClick={() => {
                          if (canJump) setWizardStep(s.step);
                        }}
                      >
                        <span className="rha-step-num">
                          {isDone && !isActive ? <IconCheck /> : s.step}
                        </span>
                        <span>{s.title}</span>
                      </button>
                    </li>
                  </React.Fragment>
                );
              })}
            </ol>
            <Button size="mini" type="text" onClick={cancelWizard}>
              {bi("取消配置", "Cancel")}
            </Button>
          </div>

          <div className="rha-card-body">
            {wizardStep === 1 && renderTransportConfig()}

            {wizardStep === 2 && (
              <div className="rha-check-wrap">
                <div className="rha-check-stage">
                  <div className="rha-check-stage-head">
                    <div className="rha-check-stage-meta">
                      <span className="rha-transport-tag">
                        {cfg.transport === "agent"
                          ? bi("方式 B · 目标机直连 Agent", "Mode B · Direct Agent")
                          : bi("方式 A · 控制机直连", "Mode A · Controller")}
                      </span>
                      <span className="rha-check-summary">{channelSummaryText}</span>
                    </div>
                    <Button size="mini" type="text" onClick={() => setWizardStep(1)}>
                      {bi("修改接入方式", "Change Transport")}
                    </Button>
                  </div>

                  <div className="rha-check-hosts">
                    <span className="rha-check-hosts-lbl">
                      {bi(`自检目标（${effectiveHosts.length} 台）：`, `Targets (${effectiveHosts.length}):`)}
                    </span>
                    {effectiveHosts.length === 0 ? (
                      <span className="rha-check-hosts-empty">
                        {bi("暂无目标主机，请返回第 1 步补充", "No targets yet")}
                      </span>
                    ) : (
                      effectiveHosts.map((h) => {
                        const ag = cfg.transport === "agent" ? activeAgentsByIP.get(h.ip) : null;
                        return (
                          <span key={`${h.name}-${h.ip}`} className="rha-map-pill">
                            {cfg.transport === "agent" && (
                              <i className={`rha-mini-dot ${ag?.online ? "is-on" : ag ? "is-wait" : ""}`} />
                            )}
                            <b>{h.name}</b>
                            <span className="mono">{h.ip}</span>
                            {h.role && <em>· {h.role}</em>}
                          </span>
                        );
                      })
                    )}
                  </div>

                  <div className="rha-check-safe-row">
                    <span className="rha-ro-tag">
                      <IconSafe /> {bi("100% 只读自检", "100% Read-Only")}
                    </span>
                    <span className="rha-check-safe-txt">
                      {bi(
                        "仅执行 hostname / id / uname 探活命令，绝不修改任何配置、文件或服务状态。",
                        "Runs hostname / id / uname only; never modifies files, configs, or services.",
                      )}
                    </span>
                  </div>

                  {checkBlockReason && (
                    <div className="rha-inline-banner is-warn">
                      <IconExclamationCircle />
                      <span>{checkBlockReason}</span>
                    </div>
                  )}

                  {checkPassed && (
                    <div className="rha-inline-banner is-ok">
                      <IconCheckCircle />
                      <span>
                        {bi(
                          "全部目标主机只读连通性自检通过，可进入最后一步开启自动化。",
                          "All target hosts passed read-only self-check. Proceed to finish setup.",
                        )}
                      </span>
                    </div>
                  )}

                  {checkFailed && (
                    <div className="rha-inline-banner is-warn">
                      <IconExclamationCircle />
                      <span>
                        {bi(
                          "自检未完全通过，请查看下方脱敏输出；可返回第 1 步调整控制机或 SSH 参数，也可先跳过自检。",
                          "Connectivity check reported issues. Review output below, adjust Step 1 settings, or skip for now.",
                        )}
                      </span>
                    </div>
                  )}
                </div>

                {checkTask && (
                  <LiveExecLogCard
                    task={checkTask}
                    clusterId={clusterId}
                    onCancelled={setCheckTask}
                  />
                )}
              </div>
            )}

            {wizardStep === 3 && (
              <div className="rha-step3-wrap">
                <div className="rha-summary-strip">
                  <div className="rha-summary-strip-l">
                    <div className="rha-summary-kv">
                      <span>{bi("接入通道", "Channel")}</span>
                      <b>{channelSummaryText}</b>
                    </div>
                    <div className="rha-summary-kv">
                      <span>{bi("连通自检", "Self-Check")}</span>
                      <span
                        className={`rha-ready-dot ${checkPassed ? "is-ok" : checkFailed ? "is-warn" : ""}`}
                      >
                        {checkPassed
                          ? bi("已通过", "Passed")
                          : checkFailed
                            ? bi("未通过", "Issues")
                            : bi("已跳过", "Skipped")}
                      </span>
                    </div>
                  </div>
                  <Button size="mini" type="text" onClick={() => setWizardStep(1)}>
                    {bi("返回修改", "Edit")}
                  </Button>
                </div>

                {renderPacingAndGuardrails()}
              </div>
            )}
          </div>

          <div className="rha-card-foot">
            {wizardStep === 1 && (
              <>
                <span className={`rha-foot-hint is-${step1Hint.tone}`}>{step1Hint.text}</span>
                <div className="rha-drawer-foot-r">
                  <Button size="small" onClick={cancelWizard}>
                    {bi("取消", "Cancel")}
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    disabled={!step1CanContinue}
                    onClick={() => setWizardStep(2)}
                  >
                    {bi("下一步：连通自检", "Next: Self-Check")} <IconArrowRight />
                  </Button>
                </div>
              </>
            )}

            {wizardStep === 2 && (
              <>
                <Button size="small" icon={<IconArrowLeft />} onClick={() => setWizardStep(1)}>
                  {bi("上一步", "Back")}
                </Button>
                <div className="rha-drawer-foot-r">
                  {checkPassed ? (
                    <>
                      <Button
                        size="small"
                        type="outline"
                        loading={checking}
                        disabled={!canRunCheck}
                        icon={<IconRefresh />}
                        onClick={() => void runConnectivityCheck()}
                      >
                        {bi("重新自检", "Re-check")}
                      </Button>
                      <Button size="small" type="primary" onClick={() => setWizardStep(3)}>
                        {bi("下一步：节奏与安全", "Next: Guardrails")} <IconArrowRight />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="small"
                        type={canRunCheck ? "default" : "primary"}
                        onClick={() => setWizardStep(3)}
                      >
                        {bi("跳过自检，下一步", "Skip & Continue")} <IconArrowRight />
                      </Button>
                      {canRunCheck && (
                        <Button
                          size="small"
                          type="primary"
                          loading={checking}
                          icon={<IconPlayArrow />}
                          onClick={() => void runConnectivityCheck()}
                        >
                          {checkTask ? bi("重新自检", "Retry Check") : bi("运行只读自检", "Run Self-Check")}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </>
            )}

            {wizardStep === 3 && (
              <>
                <Button size="small" icon={<IconArrowLeft />} onClick={() => setWizardStep(2)}>
                  {bi("上一步", "Back")}
                </Button>
                <div className="rha-drawer-foot-r">
                  <Button size="small" onClick={cancelWizard}>
                    {bi("取消", "Cancel")}
                  </Button>
                  {canManage && (
                    <Button
                      size="small"
                      type="primary"
                      loading={saving}
                      icon={<IconThunderbolt />}
                      onClick={() =>
                        void saveConfig(
                          { enabled: true },
                          {
                            activated: true,
                            toast: bi("集群自动化执行已启用", "Cluster automation enabled"),
                          },
                        )
                      }
                    >
                      {bi("保存并启用自动化", "Save & Enable Automation")}
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {/* ---- Mode 3: Active Management Mode (Native .cx-spec-stack) ---- */}
      {viewMode === "manage" && (
        <div className="rha-manage-stack">
          <div className={`rha-status-bar ${summary.verified ? "is-ready" : "is-warn"}`}>
            <div className="rha-status-bar-l">
              <div className="rha-master-title">
                <span className={`rha-ready-dot ${summary.verified ? "is-ok" : "is-warn"}`}>
                  {summary.verified
                    ? bi("已测试连通", "Verified")
                    : summary.ready
                      ? bi("待连通自检", "Unverified")
                      : bi("通道待处理", "Needs Attention")}
                </span>
                <b>{channelSummaryText}</b>
              </div>
              {!summary.ready && summary.ready_reason ? (
                <p className="rha-master-sub">{summary.ready_reason}</p>
              ) : !summary.verified ? (
                <p className="rha-master-sub">
                  {summary.last_check_state && summary.last_check_state !== "succeeded"
                    ? bi(
                        "最近一次只读连通性自检未通过，排查后重新自检通过即可点亮「自动化」标签状态。",
                        "Last connectivity check failed. Resolve issues and re-run self-check to mark verified.",
                      )
                    : bi(
                        "尚未对当前连接参数完成只读连通性自检；点击右上角「只读连通性自检」通过后将自动点亮「自动化」标签。",
                        "Run a quick read-only self-check on the current settings to verify connectivity and light up the Automation tab.",
                      )}
                </p>
              ) : summary.last_check_at ? (
                <p className="rha-master-sub">
                  {bi(
                    `最近一次只读连通性自检通过：${fullTime(summary.last_check_at)}`,
                    `Last verified read-only check: ${fullTime(summary.last_check_at)}`,
                  )}
                </p>
              ) : null}
            </div>
            {justActivated && returnCtx && (
              <Button size="small" type="primary" icon={<IconArrowLeft />} onClick={goBackToRehearsal}>
                {bi("已启用 · 返回变更演练", "Enabled · Back to Rehearsal")}
              </Button>
            )}
          </div>

          {checkTask && (
            <LiveExecLogCard
              task={checkTask}
              clusterId={clusterId}
              onCancelled={setCheckTask}
              title={bi("只读连通性自检结果", "Read-Only Connectivity Check")}
            />
          )}

          <section className="cx-spec-card">
            <div className="cx-spec-card-head">
              <h3>
                <span>{bi("1. 目标机接入方式", "1. Target Access Transport")}</span>
                <span className="cx-card-cnt">
                  {effectiveHosts.length === 1
                    ? bi("1 台主机", "1 host")
                    : bi(`${effectiveHosts.length} 台主机`, `${effectiveHosts.length} hosts`)}
                </span>
              </h3>
            </div>
            <div className="rha-card-body">{renderTransportConfig()}</div>
          </section>

          <section className="cx-spec-card">
            <div className="cx-spec-card-head">
              <h3>{bi("2. 推进节奏与生产安全护栏", "2. Execution Pacing & Safety Guardrails")}</h3>
            </div>
            <div className="rha-card-body">{renderPacingAndGuardrails()}</div>
            {canManage && (
              <div className="rha-card-foot">
                <span className={`rha-foot-hint ${dirty ? "is-warn" : "is-neutral"}`}>
                  {dirty
                    ? bi("有未保存的配置修改", "You have unsaved changes")
                    : cfg.updated_at
                      ? bi(`上次更新：${fullTime(cfg.updated_at)}`, `Updated ${fullTime(cfg.updated_at)}`)
                      : bi("自动化执行已启用", "Automation enabled")}
                </span>
                <div className="rha-drawer-foot-r">
                  <Button
                    size="small"
                    type="primary"
                    loading={saving}
                    disabled={!dirty}
                    icon={<IconCheck />}
                    onClick={() => void saveConfig({ enabled: true })}
                  >
                    {bi("保存修改", "Save Changes")}
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
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
  IconArrowLeft,
  IconArrowRight,
  IconBook,
  IconCheck,
  IconCheckCircle,
  IconClose,
  IconCode,
  IconCopy,
  IconDelete,
  IconDesktop,
  IconDown,
  IconDownload,
  IconExclamationCircle,
  IconFilter,
  IconInfoCircle,
  IconLink,
  IconPlus,
  IconRefresh,
  IconRight,
  IconSafe,
  IconSearch,
  IconStorage,
  IconThunderbolt,
  IconUp,
} from "@arco-design/web-react/icon";
import {
  ClusterView,
  ago,
  api,
  authToken,
  cached,
  can,
  copy,
  csrfToken,
  fullTime,
  putCached,
  useMedia,
} from "../../shared/shared";
import { go } from "../../app/router";
import { FilterChip, Kbd, Segmented, StatusBadge } from "../../design/ui";
import { bi, biv, getLang, useLang, withLang } from "../../app/i18n";
import {
  AgentHostProbe,
  AutomationAgentView,
  ExecutionNode,
  consumeAgentEnrollPrefill,
  isExecutionNodeOnline,
  nodeConnection,
} from "./execution-types";
import { AIHelpButton } from "../ai/aichat";
import "./executions.css";
import "./execution-center.css";
import "./rehearsal-automation.css";

type Registration = { node: ExecutionNode; token: string };
type TargetRegistration = { agent: AutomationAgentView; token: string };
type EnrollRole = "controller" | "target";
type Guide = "install" | "maintain";
type StatusFilter = "all" | "online" | "offline" | "disabled";
type RoleFilter = "all" | "controller" | "target" | "upgrade";
type SelectedItem =
  | { role: "controller"; id: string }
  | { role: "target"; id: string };

type BootstrapInfo = {
  origin: string;
  is_loopback: boolean;
  suggested_urls: string[];
  tls_enabled: boolean;
  tls_self_signed: boolean;
  ca_available: boolean;
  binary_available: boolean;
  version: string;
};

const isLoopbackURL = (raw: string): boolean => {
  try {
    const h = new URL(raw.trim()).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
};

const isLoopbackIP = (ip: string): boolean => {
  const s = ip.trim().toLowerCase();
  return s === "127.0.0.1" || s === "::1" || s === "localhost";
};

const runnerSlug = (name: string, ip: string): string => {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  const base = cleaned || ip.replace(/\./g, "-") || "node";
  return base.slice(0, 36).replace(/[-.]+$/, "") || "node";
};

function Command({ title, children }: { title: string; children: string }) {
  useLang();
  return (
    <div className="exec-command">
      <div>
        <span>{title}</span>
        <Button
          type="text"
          size="mini"
          icon={<IconCopy />}
          onClick={() => copy(children)}
          aria-label={bi(`复制${title}`, `Copy ${title}`)}
        >
          {bi("复制", "Copy")}
        </Button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const serviceUnit = `[Unit]
Description=Kyndryl Delivery Studio Execution Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
UMask=0077
ExecStart=/usr/local/bin/middleware-store execution-node --config /etc/middleware-execution/execution-node.json
Restart=on-failure
RestartSec=10
KillMode=process
TimeoutStopSec=25h

[Install]
WantedBy=multi-user.target`;

function InstallGuide({ bootInfo }: { bootInfo: BootstrapInfo | null }) {
  useLang();
  return (
    <ol className="en-guide-steps">
      <li>
        <span>1</span>
        <div>
          <h3>{bi("只需装在 1 台主控机", "Install on One Control Host Only")}</h3>
          <p>
            {bi(
              "执行器只装在负责调度的主控机（独立管理机或集群内某 1 台机器）上，不需要给每台数据库节点安装执行器。目标业务机的连接在具体交付的「现场执行」里选择「已有 SSH」或「目标 Agent」。",
              "Install the runner only on the single control host (dedicated control host or one cluster node)—never on every database host. Target connectivity is configured inside each delivery via Existing SSH or Target Agent.",
            )}
          </p>
        </div>
      </li>
      <li>
        <span>2</span>
        <div>
          <h3>{bi("下载一键安装包并后台安装（推荐）", "One-Command Background Install (Recommended)")}</h3>
          <p>
            {bi(
              "点击「接入节点」登记后，在第二步选择执行机可达的平台地址，下载 .tar.gz 一键安装包（已打包 Linux x64 执行器、连接配置、CA 证书和 systemd 脚本）。传到主控机执行：",
              "After registering a node, verify the reachable Hub URL in Step 2 and download the self-contained .tar.gz bundle (binary, config, CA cert, and systemd installer). Run on the control host:",
            )}
          </p>
          <Command title={bi("解压并自动安装为后台服务", "Extract & install as systemd service")}>
            {`tar -xzf mw-runner-<node>.tar.gz
sudo bash mw-runner-<node>/install.sh`}
          </Command>
          <p>
            {bi(
              "脚本会自动注册并启动 middleware-execution 后台服务（不占用终端），并自动执行一次连通性校验。查看实时英文运行日志：",
              "The script registers and starts the middleware-execution systemd daemon in the background and runs a live connectivity check. Inspect structured logs with:",
            )}
          </p>
          <Command title={bi("查看服务状态与日志", "Check service status & logs")}>
            {`systemctl status middleware-execution --no-pager
journalctl -u middleware-execution -f`}
          </Command>
        </div>
      </li>
      <li>
        <span>3</span>
        <div>
          <h3>{bi("独立管理机多集群目录约定", "Per-Cluster Directories on Dedicated Hosts")}</h3>
          <p>
            {biv(
              <>
                配置中的 <code>root</code> 默认是{" "}
                <code>/root/middleware-automation</code>
                。独立管理机为每个集群解包到独立路径（如{" "}
                <code>/root/middleware-executions/&lt;集群标识&gt;/middleware-automation</code>
                ），可在交付的准备检查中查看准确路径并加入配置的{" "}
                <code>roots</code> 数组，防止不同集群串用密码或环境。
              </>,
              <>
                Default <code>root</code> is <code>/root/middleware-automation</code>. Dedicated hosts unpack each cluster into its own path (e.g.{" "}
                <code>/root/middleware-executions/&lt;cluster&gt;/middleware-automation</code>
                )—add cluster paths to <code>roots</code> to keep credentials isolated.
              </>,
            )}
          </p>
          <details className="en-service">
            <summary>
              {bi("手工分步安装与文件下载（高级）", "Manual step-by-step installation (Advanced)")}
            </summary>
            <div className="en-downloads">
              <Button
                size="small"
                href={withLang("/api/settings/execution-nodes/binary")}
                icon={<IconDownload />}
              >
                {bi("执行器 · Linux x64", "Runner · Linux x64")}
              </Button>
              {bootInfo?.ca_available && (
                <Button
                  size="small"
                  href={withLang("/api/settings/execution-nodes/ca.pem")}
                  icon={<IconDownload />}
                >
                  {bi("平台 CA 证书 (platform-ca.pem)", "Hub CA Cert (platform-ca.pem)")}
                </Button>
              )}
            </div>
            <Command title={bi("手工安装文件与自检", "Manual file install & check")}>
              {`install -m 0755 middleware-store-linux-amd64 /usr/local/bin/middleware-store
install -d -m 0700 /etc/middleware-execution /var/lib/middleware-execution
install -m 0600 execution-node.json /etc/middleware-execution/execution-node.json
# If using self-signed/private HTTPS cert:
install -m 0644 platform-ca.pem /etc/middleware-execution/platform-ca.pem
# Verify connectivity before starting daemon:
/usr/local/bin/middleware-store execution-node --config /etc/middleware-execution/execution-node.json --check`}
            </Command>
            <Command title="/etc/systemd/system/middleware-execution.service">
              {serviceUnit}
            </Command>
            <Command title={bi("启用后台服务", "Enable background service")}>
              {`systemctl daemon-reload
systemctl enable --now middleware-execution`}
            </Command>
          </details>
        </div>
      </li>
    </ol>
  );
}

function MaintenanceGuide() {
  useLang();
  return (
    <div className="en-maintenance">
      <section>
        <h3>{bi("节点一直没有连接", "Node stays disconnected")}</h3>
        <p>
          {bi(
            "运行一次即时自检即可看到明确报错（如 127.0.0.1 地址错误、缺少 platform-ca.pem 或防火墙阻断），也可以直接把输出贴给右下角 AI 助手：",
            "Run an instant connectivity check to see the exact cause (wrong URL, missing CA cert, or firewall), or paste the output into the AI assistant:",
          )}
        </p>
        <Command title={bi("即时连通性自检与日志", "Connectivity check & logs")}>
          {`/usr/local/bin/middleware-store execution-node --config /etc/middleware-execution/execution-node.json --check
journalctl -u middleware-execution -n 60 --no-pager`}
        </Command>
      </section>
      <section>
        <h3>{bi("更新执行器", "Upgrading the Runner")}</h3>
        <p>
          {bi(
            "先在节点卡片上点击「停止领取」，等待当前步骤结束，再停止服务、更换程序并启动，最后点击「恢复接单」。平台网页更新无需重启执行器。",
            "Click “Pause” on the node card first, wait for running steps to finish, replace the binary, restart the service, then click “Resume”. Web UI updates do not require restarting runners.",
          )}
        </p>
      </section>
      <section>
        <h3>
          {bi(
            "异常中断后的状态待核实",
            "State Pending Verification After Interruption",
          )}
        </h3>
        <p>
          {bi(
            "平台不会自动重跑这个步骤。先核实执行机器和目标机器上的任务均已停止，再停止节点服务，填写该次尝试编号和核实情况：",
            "The platform will not automatically rerun interrupted steps. Confirm tasks have stopped on both execution and target hosts, stop the service, then acknowledge:",
          )}
        </p>
        <Command title={bi("回传核实结果", "Acknowledge stopped state")}>
          {bi(
            `/usr/local/bin/middleware-store execution-node \\
  --config /etc/middleware-execution/execution-node.json \\
  --ack-stopped 尝试编号 --note "现场核实过程和结果"`,
            `/usr/local/bin/middleware-store execution-node \\
  --config /etc/middleware-execution/execution-node.json \\
  --ack-stopped <attempt-id> --note "On-site verification result"`,
          )}
        </Command>
      </section>
      <section>
        <h3>{bi("目标机直连 Agent 状态与日志", "Direct Target Agent Status & Logs")}</h3>
        <p>
          {bi(
            "目标机直连 Agent 以独立 systemd 服务运行，可在目标业务主机上检查服务状态与最近日志：",
            "Direct Target Agents run as dedicated systemd units on the target host:",
          )}
        </p>
        <Command title={bi("检查目标机 Agent 服务与日志", "Check Target Agent service & logs")}>
          {`sudo systemctl status 'middleware-target-agent-*' --no-pager
sudo journalctl -u 'middleware-target-agent-*' -n 60 --no-pager`}
        </Command>
      </section>
      <section>
        <h3>{bi("卸载执行器", "Uninstall Runner")}</h3>
        <p>
          {bi(
            "使用安装包内的 uninstall.sh 可干净移除 systemd 服务、配置与二进制，同时保留历史状态目录。",
            "Run uninstall.sh from the installer bundle to remove the systemd service, config, and binary cleanly.",
          )}
        </p>
      </section>
    </div>
  );
}

const nodeStatusLabel = (key: string, fallback: string) =>
  key === "disabled"
    ? bi("已暂停接单", "Paused")
    : key === "online"
      ? bi("已连接", "Connected")
      : key === "offline"
        ? bi("连接中断", "Disconnected")
        : key === "waiting"
          ? bi("等待连接", "Awaiting connection")
          : fallback;

function formatProbeMem(mb?: number): string {
  if (!mb || mb <= 0) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${mb} MB`;
}

function formatProbeUptime(sec?: number): string {
  if (!sec || sec <= 0) return "—";
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.max(1, Math.floor((sec % 3600) / 60));
  if (days > 0) return bi(`${days} 天 ${hours} 小时`, `${days}d ${hours}h`);
  if (hours > 0) return bi(`${hours} 小时 ${mins} 分`, `${hours}h ${mins}m`);
  return bi(`${mins} 分钟`, `${mins}m`);
}

function AgentLiveProbeSection({
  probe,
  online,
  lastSeen,
  inactive,
  defaultIntervalSec,
}: {
  probe?: AgentHostProbe;
  online: boolean;
  lastSeen?: string;
  inactive?: boolean;
  defaultIntervalSec: number;
}) {
  const interval = probe?.interval_sec || defaultIntervalSec;
  const memPct = Math.min(100, Math.max(0, probe?.mem_used_pct || 0));
  const diskPct = Math.min(100, Math.max(0, probe?.disk_used_pct || 0));
  return (
    <section className="ec-sec">
      <div className="ec-sec-head">
        <div>
          <h2 className="ec-sec-title">
            {bi("实时心跳与主机探针", "Live Heartbeat & Host Probe")}
          </h2>
          <p className="ec-sec-sub">
            {bi(
              `Agent 守护进程在后台每 ${interval} 秒主动上报实时心跳，并每 15 秒零子进程采集本机系统负载、内存与磁盘健康指标（超过 35 秒未收到心跳自动判定离线）。`,
              `Agent daemon reports live heartbeats every ${interval}s and samples zero-fork host load, memory, and disk telemetry every 15s (marked offline after 35s timeout).`,
            )}
          </p>
        </div>
        <span
          className={`ec-sec-badge ${
            inactive ? "" : online ? "is-live" : lastSeen ? "is-warn" : ""
          }`}
        >
          {inactive
            ? bi("已停用 / 已撤销", "Inactive")
            : online
              ? bi(`● 每 ${interval}s 实时上报`, `● Live · Every ${interval}s`)
              : lastSeen
                ? bi("心跳超时中断", "Heartbeat Lost")
                : bi("等待探针上线", "Awaiting Agent")}
        </span>
      </div>

      <div className="ec-surface-card">
        {probe ? (
          <div className="ec-probe-grid">
            <div className="ec-probe-item">
              <span className="ec-probe-lbl">{bi("CPU 负载 (1m / 5m)", "CPU Load (1m / 5m)")}</span>
              <div className="ec-probe-val num">
                <b>{(probe.load1 ?? 0).toFixed(2)}</b>
                <span>
                  / {(probe.load5 ?? 0).toFixed(2)}
                  {probe.cpu_cores ? ` · ${probe.cpu_cores}C` : ""}
                </span>
              </div>
              <small className="ec-probe-sub">
                {probe.arch ? `${probe.arch.toUpperCase()} · ` : ""}
                {lastSeen
                  ? bi(`最近探针 ${ago(lastSeen)}`, `Sampled ${ago(lastSeen)}`)
                  : bi("实时采集中", "Live sampling")}
              </small>
            </div>

            <div className="ec-probe-item">
              <span className="ec-probe-lbl">{bi("内存使用率", "Memory Usage")}</span>
              <div className="ec-probe-val num">
                <b>{probe.mem_total_mb ? `${memPct.toFixed(1)}%` : "—"}</b>
                <span>{formatProbeMem(probe.mem_total_mb)}</span>
              </div>
              <div className="ec-probe-bar" aria-hidden>
                <i
                  className={memPct >= 88 ? "is-bad" : memPct >= 75 ? "is-warn" : ""}
                  style={{ width: `${memPct}%` }}
                />
              </div>
            </div>

            <div className="ec-probe-item">
              <span className="ec-probe-lbl">{bi("根分区磁盘", "Root Disk")}</span>
              <div className="ec-probe-val num">
                <b>{probe.disk_total_gb ? `${diskPct.toFixed(1)}%` : "—"}</b>
                <span>
                  {probe.disk_total_gb ? `${probe.disk_total_gb.toFixed(0)} GB` : "—"}
                </span>
              </div>
              <div className="ec-probe-bar" aria-hidden>
                <i
                  className={diskPct >= 90 ? "is-bad" : diskPct >= 80 ? "is-warn" : ""}
                  style={{ width: `${diskPct}%` }}
                />
              </div>
            </div>

            <div className="ec-probe-item">
              <span className="ec-probe-lbl">{bi("系统与运行时长", "OS & Uptime")}</span>
              <div className="ec-probe-val">
                <b title={probe.os || ""}>{probe.os || "Linux"}</b>
              </div>
              <small className="ec-probe-sub num">
                {probe.uptime_sec
                  ? bi(`持续运行 ${formatProbeUptime(probe.uptime_sec)}`, `Up ${formatProbeUptime(probe.uptime_sec)}`)
                  : probe.kernel || "—"}
              </small>
            </div>
          </div>
        ) : (
          <div className="ec-scope-block">
            <p className="ec-scope-hint">
              {inactive
                ? bi(
                    "当前 Agent 已停用或已撤销授权，不再接收实时心跳上报。",
                    "This Agent is paused or revoked and no longer accepts live heartbeats.",
                  )
                : lastSeen
                  ? bi(
                      `最近心跳时间：${fullTime(lastSeen)}（每 ${interval}s 持续上报；升级至新版 Agent 二进制后可同步展示 CPU、内存、磁盘等实时探针指标）。`,
                      `Last heartbeat: ${fullTime(lastSeen)} (reported every ${interval}s; upgrade the Agent binary to stream live CPU, memory, and disk probe metrics).`,
                    )
                  : bi(
                      `尚未收到实时心跳；在目标主机执行一键安装脚本启动 systemd 守护服务后，Agent 将每 ${interval} 秒自动上报心跳与主机健康探针。`,
                      `No live heartbeat received yet; once installed via systemd, the Agent automatically streams heartbeats every ${interval}s along with host health telemetry.`,
                    )}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

export function ExecutionNodes({
  centerNav,
  initialRole = "all",
}: {
  centerNav?: React.ReactNode;
  initialRole?: RoleFilter;
} = {}) {
  useLang();
  const canManage = can("execution.manage");
  const narrow = useMedia("(max-width: 900px)");

  const [nodes, setNodes] = useState<ExecutionNode[] | null>(
    () => cached<ExecutionNode[]>("/api/settings/execution-nodes") ?? null,
  );
  const [agents, setAgents] = useState<AutomationAgentView[] | null>(
    () => cached<AutomationAgentView[]>("/api/executions/agents") ?? null,
  );
  const [clusters, setClusters] = useState<ClusterView[]>(
    () => cached<ClusterView[]>("/api/clusters") ?? [],
  );
  const [bootInfo, setBootInfo] = useState<BootstrapInfo | null>(null);
  const [error, setError] = useState("");
  const [agentsError, setAgentsError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bundling, setBundling] = useState(false);
  const [bundleError, setBundleError] = useState("");
  const [updating, setUpdating] = useState("");
  const [updatingAgent, setUpdatingAgent] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [enrollRole, setEnrollRole] = useState<EnrollRole>("controller");
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [targetRegistration, setTargetRegistration] = useState<TargetRegistration | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [hubUrl, setHubUrl] = useState(() => location.origin);
  const [includeCA, setIncludeCA] = useState(true);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"independent" | "embedded">("independent");
  const [controller, setController] = useState("");
  const [targetHost, setTargetHost] = useState("");
  const [targetIP, setTargetIP] = useState("");
  const [targetAllowMutating, setTargetAllowMutating] = useState(true);
  const [targetClusters, setTargetClusters] = useState<string[]>([]);
  const [createError, setCreateError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>(initialRole);
  const [onlyWritable, setOnlyWritable] = useState(false);
  const [agentSort, setAgentSort] = useState<"status" | "name" | "heartbeat">("status");
  const [filterOpen, setFilterOpen] = useState(false);
  const [upgradeCmdOpen, setUpgradeCmdOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (initialRole === "target") {
      setRoleFilter("target");
    }
  }, [initialRole]);
  useEffect(() => {
    const onSlash = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          t.closest(".arco-modal,.arco-drawer"))
      )
        return;
      e.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onSlash);
    return () => window.removeEventListener("keydown", onSlash);
  }, []);
  const mounted = useRef(true);
  const busyLockRef = useRef(false);
  const bundleLockRef = useRef(false);
  const updatingLockRef = useRef("");
  const updatingAgentLockRef = useRef("");
  const deletingLockRef = useRef(false);

  const load = async (manual = false) => {
    if (manual) setRefreshing(true);
    const jobs: Promise<void>[] = [];
    if (canManage) {
      jobs.push(
        api<ExecutionNode[]>("/api/settings/execution-nodes")
          .then((result) => {
            putCached("/api/settings/execution-nodes", result);
            if (mounted.current) {
              setNodes(result);
              setError("");
            }
          })
          .catch((e) => {
            if (mounted.current) setError((e as Error).message);
          }),
      );
    } else if (mounted.current) {
      setNodes([]);
    }
    jobs.push(
      api<AutomationAgentView[]>("/api/executions/agents")
        .then((result) => {
          const list = Array.isArray(result) ? result : [];
          putCached("/api/executions/agents", list);
          if (mounted.current) {
            setAgents(list);
            setAgentsError("");
          }
        })
        .catch((e) => {
          if (mounted.current) setAgentsError((e as Error).message);
        }),
    );
    jobs.push(
      api<ClusterView[]>("/api/clusters")
        .then((result) => {
          const list = Array.isArray(result) ? result : [];
          putCached("/api/clusters", list);
          if (mounted.current) setClusters(list);
        })
        .catch(() => {
          /* non-blocking */
        }),
    );
    await Promise.all(jobs);
    if (mounted.current) setRefreshing(false);
  };

  const updateGlobalAgent = async (
    ag: AutomationAgentView,
    payload: {
      action: "update" | "revoke" | "delete";
      allow_mutating?: boolean;
      clusters?: string[];
      add_cluster?: string;
      remove_cluster?: string;
    },
  ) => {
    if (updatingAgentLockRef.current) return;
    updatingAgentLockRef.current = ag.id;
    setUpdatingAgent(ag.id);
    try {
      await api("/api/executions/agents", {
        method: "PATCH",
        body: JSON.stringify({ id: ag.id, ...payload }),
      });
      if (payload.action === "delete" && targetRegistration?.agent.id === ag.id) {
        setTargetRegistration(null);
        setDownloaded(false);
        setBundleError("");
      }
      await load();
      Message.success(
        payload.action === "delete"
          ? bi(`已删除目标机「${ag.host}」的 Agent 记录`, `Deleted target agent "${ag.host}"`)
          : payload.action === "revoke"
            ? bi(`已撤销目标机「${ag.host}」的 Agent 授权`, `Revoked agent on "${ag.host}"`)
            : payload.add_cluster
              ? bi(`已关联集群「${payload.add_cluster}」`, `Bound cluster "${payload.add_cluster}"`)
              : payload.remove_cluster
                ? bi(`已解除集群「${payload.remove_cluster}」关联`, `Unbound cluster "${payload.remove_cluster}"`)
                : payload.clusters !== undefined
                  ? bi(`已更新目标机「${ag.host}」关联授权集群`, `Updated bound clusters for "${ag.host}"`)
                  : bi(`已更新目标机「${ag.host}」写操作权限`, `Updated write permission for "${ag.host}"`),
      );
    } catch (e) {
      Message.error((e as Error).message);
    } finally {
      updatingAgentLockRef.current = "";
      setUpdatingAgent("");
    }
  };

  const loadBootInfo = async () => {
    try {
      const info = await api<BootstrapInfo>(
        "/api/settings/execution-nodes/bootstrap-info",
      );
      if (!mounted.current) return;
      setBootInfo(info);
      setIncludeCA(info.ca_available);
      if (info.is_loopback && info.suggested_urls.length > 0) {
        setHubUrl(info.suggested_urls[0]);
      } else if (info.origin) {
        setHubUrl(info.origin);
      }
    } catch {
      /* fallback to location.origin */
    }
  };

  const all = nodes || [];
  const allAgents = agents || [];
  const registeredNode = all.find((n) => n.id === registration?.node.id);
  const registeredOnline = !!(
    registeredNode && isExecutionNodeOnline(registeredNode)
  );
  const registeredTarget = allAgents.find((a) => a.id === targetRegistration?.agent.id);
  const targetRegisteredOnline = !!(
    registeredTarget && registeredTarget.desired === "active" && registeredTarget.online
  );
  const activeStep2 = !!(registration || targetRegistration);
  const activeStep2Online = registration ? registeredOnline : targetRegisteredOnline;
  const fastPoll = !!(open && activeStep2 && !activeStep2Online);

  useEffect(() => {
    mounted.current = true;
    void load();
    void loadBootInfo();
    const prefill = consumeAgentEnrollPrefill();
    if (prefill && canManage) {
      setEnrollRole(prefill.role === "controller" ? "controller" : "target");
      if (prefill.role === "controller") {
        setName(prefill.host || "");
        setController(prefill.ip || "");
      } else {
        setTargetHost(prefill.host || "");
        setTargetIP(prefill.ip || "");
        setTargetAllowMutating(true);
        setTargetClusters(prefill.cluster ? [prefill.cluster] : []);
      }
      setRegistration(null);
      setTargetRegistration(null);
      setDownloaded(false);
      setCreateError("");
      setBundleError("");
      setOpen(true);
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const intervalMs = fastPoll ? 1500 : 5000;
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, intervalMs);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fastPoll]);

  const begin = (preferredRole?: EnrollRole) => {
    if (!registration && !targetRegistration) {
      const nextRole: EnrollRole =
        preferredRole ?? (roleFilter === "target" ? "target" : "controller");
      setEnrollRole(nextRole);
      setName("");
      setKind("independent");
      setController("");
      setTargetHost("");
      setTargetIP("");
      setTargetAllowMutating(true);
      setTargetClusters([]);
      setCreateError("");
      setBundleError("");
    }
    void loadBootInfo();
    setOpen(true);
  };

  const enrollNextTarget = () => {
    setTargetRegistration(null);
    setRegistration(null);
    setEnrollRole("target");
    setTargetHost("");
    setTargetIP("");
    setTargetAllowMutating(true);
    setTargetClusters([]);
    setDownloaded(false);
    setCreateError("");
    setBundleError("");
  };

  const create = async () => {
    if (busyLockRef.current) return;
    busyLockRef.current = true;
    setBusy(true);
    setCreateError("");
    try {
      if (enrollRole === "target") {
        const res = await api<{
          agent: AutomationAgentView;
          enrollment_token: string;
          bootstrap?: BootstrapInfo;
        }>("/api/executions/agents", {
          method: "POST",
          body: JSON.stringify({
            host: targetHost.trim(),
            ip: targetIP.trim(),
            allow_mutating: targetAllowMutating,
            clusters: targetClusters,
          }),
        });
        setTargetRegistration({ agent: res.agent, token: res.enrollment_token });
        setSelected({ role: "target", id: res.agent.id });
        if (res.bootstrap) {
          setBootInfo(res.bootstrap);
          setIncludeCA(res.bootstrap.ca_available);
          if (res.bootstrap.is_loopback && res.bootstrap.suggested_urls.length > 0) {
            setHubUrl(res.bootstrap.suggested_urls[0]);
          } else if (res.bootstrap.origin) {
            setHubUrl(res.bootstrap.origin);
          }
        }
        setDownloaded(false);
        setBundleError("");
        void load();
      } else {
        const result = await api<Registration>("/api/settings/execution-nodes", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            kind,
            controller_ip: controller.trim(),
          }),
        });
        setRegistration(result);
        setSelected({ role: "controller", id: result.node.id });
        setDownloaded(false);
        setBundleError("");
        void load();
      }
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      busyLockRef.current = false;
      setBusy(false);
    }
  };

  const cleanHubUrl = hubUrl.trim().replace(/\/+$/, "");
  const remoteTargetLoopbackWarn = !!(
    (registration &&
      isLoopbackURL(cleanHubUrl) &&
      !isLoopbackIP(registration.node.controller_ip)) ||
    (targetRegistration &&
      isLoopbackURL(cleanHubUrl) &&
      !isLoopbackIP(targetRegistration.agent.ip))
  );

  const bundleDir = useMemo(() => {
    if (registration) {
      return `mw-runner-${runnerSlug(registration.node.name, registration.node.controller_ip)}`;
    }
    if (targetRegistration) {
      return `mw-target-agent-${runnerSlug(targetRegistration.agent.host, targetRegistration.agent.ip)}`;
    }
    return "mw-runner-node";
  }, [registration, targetRegistration]);
  const bundleFile = `${bundleDir}.tar.gz`;
  const oneLineInstallCmd = `tar -xzf ${bundleFile}\nsudo bash ${bundleDir}/install.sh`;

  const targetConfigJSON = useMemo(() => {
    if (!targetRegistration) return "";
    const obj: Record<string, string> = {
      url: cleanHubUrl || location.origin,
      id: targetRegistration.agent.id,
      enrollment_token: targetRegistration.token,
      state: `/var/lib/middleware-target/${targetRegistration.agent.id}`,
    };
    if (includeCA && bootInfo?.ca_available) {
      obj.ca_file = "/etc/middleware-execution/platform-ca.pem";
    }
    return JSON.stringify(obj, null, 2) + "\n";
  }, [targetRegistration, cleanHubUrl, includeCA, bootInfo?.ca_available]);

  const downloadBundle = async () => {
    if ((!registration && !targetRegistration) || bundleLockRef.current) return;
    bundleLockRef.current = true;
    setBundling(true);
    setBundleError("");
    try {
      const headers = new Headers({
        "Content-Type": "application/json",
        "X-Lang": getLang(),
        "X-CSRF-Token": csrfToken(),
      });
      const tok = authToken();
      if (tok) headers.set("Authorization", `Bearer ${tok}`);
      const endpoint = registration
        ? "/api/settings/execution-nodes/bundle"
        : `/api/executions/agents/${encodeURIComponent(targetRegistration!.agent.id)}/bundle`;
      const bodyPayload = registration
        ? {
            node_id: registration.node.id,
            token: registration.token,
            url: cleanHubUrl,
            include_ca: includeCA && !!bootInfo?.ca_available,
          }
        : {
            token: targetRegistration!.token,
            url: cleanHubUrl,
            include_ca: includeCA && !!bootInfo?.ca_available,
          };
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        credentials: "same-origin",
        body: JSON.stringify(bodyPayload),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = bundleFile;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setDownloaded(true);
      const hostIP = registration
        ? registration.node.controller_ip
        : targetRegistration!.agent.ip;
      Message.success(
        bi(
          `已下载 ${bundleFile}，上传至 ${hostIP} 执行安装命令即可`,
          `Downloaded ${bundleFile}. Transfer to ${hostIP} and run install.sh.`,
        ),
      );
    } catch (e) {
      setBundleError((e as Error).message);
    } finally {
      bundleLockRef.current = false;
      setBundling(false);
    }
  };

  const downloadConfigOnly = () => {
    if (targetRegistration) {
      const url = URL.createObjectURL(
        new Blob([targetConfigJSON], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "target-agent.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloaded(true);
      return;
    }
    if (!registration) return;
    const config: Record<string, string> = {
      url: cleanHubUrl || location.origin,
      token: registration.token,
      root: "/root/middleware-automation",
      state: "/var/lib/middleware-execution",
    };
    if (includeCA && bootInfo?.ca_available) {
      config.ca_file = "/etc/middleware-execution/platform-ca.pem";
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(config, null, 2) + "\n"], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "execution-node.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded(true);
  };

  const finish = () => {
    setOpen(false);
    setRegistration(null);
    setTargetRegistration(null);
    setDownloaded(false);
    setBundleError("");
  };

  const toggle = async (node: ExecutionNode) => {
    if (updatingLockRef.current === node.id) return;
    updatingLockRef.current = node.id;
    setUpdating(node.id);
    try {
      await api("/api/settings/execution-nodes", {
        method: "PATCH",
        body: JSON.stringify({ id: node.id, disabled: !node.disabled }),
      });
      Message.success(
        node.disabled
          ? bi("已恢复领取任务", "Task claiming resumed")
          : bi(
              "已停止领取新任务，已授权步骤仍可完成并回传结果",
              "Paused new task claims; authorized steps can still finish and report",
            ),
      );
      await load();
    } catch (e) {
      Message.error((e as Error).message);
    } finally {
      updatingLockRef.current = "";
      setUpdating("");
    }
  };

  const updateNodeCap = async (
    node: ExecutionNode,
    patch: Partial<Pick<ExecutionNode, "allow_delivery" | "allow_probe" | "allow_rehearsal">>,
  ) => {
    if (updatingLockRef.current === node.id) return;
    updatingLockRef.current = node.id;
    setUpdating(node.id);
    try {
      await api("/api/settings/execution-nodes", {
        method: "PATCH",
        body: JSON.stringify({ id: node.id, ...patch }),
      });
      await load();
      Message.success(
        bi(`已更新执行节点「${node.name}」能力授权`, `Updated capabilities for "${node.name}"`),
      );
    } catch (e) {
      Message.error((e as Error).message);
    } finally {
      updatingLockRef.current = "";
      setUpdating("");
    }
  };

  const remove = (node: ExecutionNode) => {
    Modal.confirm({
      title: bi(
        `删除执行节点「${node.name}」？`,
        `Delete execution node “${node.name}”?`,
      ),
      content: (
        <div className="en-delete-confirm">
          <p>
            {biv(
              <>
                删除后，执行机器 <code>{node.controller_ip}</code>{" "}
                上的执行器将无法再连接平台，需要重新接入才能使用。
              </>,
              <>
                Once deleted, the runner on <code>{node.controller_ip}</code>{" "}
                will no longer be able to connect until re-enrolled.
              </>,
            )}
          </p>
          <p>
            {bi(
              "已完成的执行记录和交付报告会保留。",
              "Completed execution logs and delivery reports are preserved.",
            )}
          </p>
        </div>
      ),
      okText: bi("删除节点", "Delete Node"),
      cancelText: bi("取消", "Cancel"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        if (deletingLockRef.current) return;
        deletingLockRef.current = true;
        try {
          await api("/api/settings/execution-nodes", {
            method: "DELETE",
            body: JSON.stringify({ id: node.id }),
          });
          if (registration?.node.id === node.id) {
            setRegistration(null);
            setDownloaded(false);
            setBundleError("");
          }
          Message.success(
            bi(
              `已删除执行节点「${node.name}」`,
              `Deleted execution node “${node.name}”`,
            ),
          );
          await load();
        } catch (e) {
          Message.error((e as Error).message);
          throw e;
        } finally {
          deletingLockRef.current = false;
        }
      },
    });
  };

  const needsUpgrade = (n: ExecutionNode) =>
    Boolean(n.last_seen) && (n.protocol || 0) < 3;

  const upgradeCount = all.filter(needsUpgrade).length;

  const statusCounts = {
    all: all.length + allAgents.length,
    online:
      all.filter(isExecutionNodeOnline).length +
      allAgents.filter((a) => a.desired === "active" && a.online).length,
    offline:
      all.filter((n) => !n.disabled && !isExecutionNodeOnline(n)).length +
      allAgents.filter((a) => a.desired === "active" && !a.online).length,
    disabled:
      all.filter((n) => n.disabled).length +
      allAgents.filter((a) => a.desired !== "active").length,
  };

  const rows = useMemo(() => {
    if (roleFilter === "target" || onlyWritable) return [];
    const q = query.trim().toLowerCase();
    const list = all.filter((n) => {
      if (roleFilter === "upgrade" && !needsUpgrade(n)) return false;
      const matchStatus =
        statusFilter === "all" ||
        (statusFilter === "online"
          ? isExecutionNodeOnline(n)
          : statusFilter === "disabled"
            ? n.disabled
            : !n.disabled && !isExecutionNodeOnline(n));
      if (!matchStatus) return false;
      if (!q) return true;
      return [n.name, n.controller_ip, ...n.clusters, ...n.ips].some((s) =>
        s.toLowerCase().includes(q),
      );
    });
    if (agentSort === "name") {
      return [...list].sort((a, b) => a.name.localeCompare(b.name));
    }
    if (agentSort === "heartbeat") {
      return [...list].sort((a, b) => (b.last_seen || "").localeCompare(a.last_seen || ""));
    }
    return list;
  }, [all, roleFilter, onlyWritable, statusFilter, query, agentSort]);

  const agentRows = useMemo(() => {
    if (roleFilter === "controller" || roleFilter === "upgrade") return [];
    const q = query.trim().toLowerCase();
    const list = allAgents.filter((a) => {
      if (onlyWritable && !a.allow_mutating) return false;
      const matchStatus =
        statusFilter === "all" ||
        (statusFilter === "online"
          ? a.desired === "active" && a.online
          : statusFilter === "disabled"
            ? a.desired !== "active"
            : a.desired === "active" && !a.online);
      if (!matchStatus) return false;
      if (!q) return true;
      return [
        a.host,
        a.ip,
        a.cluster || "",
        ...(a.clusters || a.matched_clusters || []),
      ].some((s) => s.toLowerCase().includes(q));
    });
    if (agentSort === "name") {
      return [...list].sort((a, b) => a.host.localeCompare(b.host));
    }
    if (agentSort === "heartbeat") {
      return [...list].sort((a, b) => (b.last_seen || "").localeCompare(a.last_seen || ""));
    }
    return list;
  }, [allAgents, roleFilter, onlyWritable, statusFilter, query, agentSort]);

  const extraFilters =
    (roleFilter !== "all" ? 1 : 0) +
    (onlyWritable ? 1 : 0) +
    (agentSort !== "status" ? 1 : 0);
  const hasAnyFilter = Boolean(query.trim()) || statusFilter !== "all" || extraFilters > 0;
  const resetAllFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setRoleFilter("all");
    setOnlyWritable(false);
    setAgentSort("status");
  };

  const activeSelection = useMemo<SelectedItem | null>(() => {
    if (selected?.role === "controller" && rows.some((n) => n.id === selected.id)) {
      return selected;
    }
    if (selected?.role === "target" && agentRows.some((a) => a.id === selected.id)) {
      return selected;
    }
    if (rows.length > 0) return { role: "controller", id: rows[0].id };
    if (agentRows.length > 0) return { role: "target", id: agentRows[0].id };
    return null;
  }, [selected, rows, agentRows]);

  const activeNode = useMemo(() => {
    if (activeSelection?.role !== "controller") return null;
    return rows.find((n) => n.id === activeSelection.id) || null;
  }, [activeSelection, rows]);

  const activeAgent = useMemo(() => {
    if (activeSelection?.role !== "target") return null;
    return agentRows.find((a) => a.id === activeSelection.id) || null;
  }, [activeSelection, agentRows]);

  const activeAgentClusters = useMemo(() => {
    if (!activeAgent) return [];
    const list = activeAgent.clusters ?? activeAgent.matched_clusters ?? [];
    if (list.length > 0) return list;
    return activeAgent.cluster ? [activeAgent.cluster] : [];
  }, [activeAgent]);

  const clusterById = useMemo(() => {
    const m = new Map<string, ClusterView>();
    for (const c of clusters) m.set(c.id, c);
    return m;
  }, [clusters]);

  useEffect(() => {
    setUpgradeCmdOpen(false);
  }, [activeSelection?.role, activeSelection?.id]);

  const reEnrollTarget = (ag: AutomationAgentView) => {
    setRegistration(null);
    setTargetRegistration(null);
    setEnrollRole("target");
    setTargetHost(ag.host || "");
    setTargetIP(ag.ip || "");
    setTargetAllowMutating(ag.allow_mutating !== false);
    const prevBound = ag.clusters ?? ag.matched_clusters ?? (ag.cluster ? [ag.cluster] : []);
    setTargetClusters(prevBound);
    setDownloaded(false);
    setCreateError("");
    setBundleError("");
    void loadBootInfo();
    setOpen(true);
  };

  const loadingList = (!nodes && !error && canManage) || (!agents && !agentsError);

  const upgradeCmd = `${bi(
    "# 1. 将新版执行器上传至控制机（点击上方按钮下载 Linux amd64 二进制）",
    "# 1. Upload the new runner binary to the control host (download Linux amd64 above)",
  )}
sudo install -m 0755 middleware-store-linux-amd64 /usr/local/bin/middleware-store
sudo systemctl restart middleware-execution
sudo systemctl status middleware-execution --no-pager`;

  const showRail = !narrow || !mobileDetail;
  const showDetail = !narrow || mobileDetail;

  return (
    <>
      <div className="md-split">
      {showRail && (
        <aside
          className="md-list"
          aria-label={bi("全平台 Agent 列表", "Platform Agent inventory")}
        >
          <div className="list-head">
            <div className="list-title">
              <h1>{bi("执行中心", "Execution Center")}</h1>
              <div className="ec-row-acts">
                <Button
                  size="small"
                  type="text"
                  icon={<IconRefresh />}
                  loading={refreshing}
                  onClick={() => void load(true)}
                  aria-label={bi("刷新列表", "Refresh list")}
                />
                {canManage && (
                  <Button
                    size="small"
                    type="primary"
                    icon={<IconPlus />}
                    onClick={() => begin()}
                  >
                    {activeStep2 ? bi("继续", "Resume") : bi("接入", "Add")}
                  </Button>
                )}
              </div>
            </div>

            {centerNav}

            <div className="search-row">
              <Input
                ref={(r) => {
                  searchInputRef.current =
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
                placeholder={bi("搜索 Agent 名称、IP 或集群", "Search Agent, IP, or cluster…")}
                aria-label={bi("搜索 Agent", "Search Agents")}
              />
              <Popover
                className="fpanel-pop"
                trigger="click"
                position="bl"
                triggerProps={{ autoFitPosition: true }}
                popupVisible={filterOpen}
                onVisibleChange={setFilterOpen}
                unmountOnExit
                content={
                  <div
                    className="fpanel"
                    role="dialog"
                    aria-label={bi("筛选 Agent", "Filter Agents")}
                  >
                    <section>
                      <h4>{bi("Agent 角色", "Agent Role")}</h4>
                      <Segmented<RoleFilter>
                        size="sm"
                        label={bi("Agent 角色", "Agent Role")}
                        value={roleFilter === "upgrade" ? "controller" : roleFilter}
                        onChange={(v) => setRoleFilter(v)}
                        options={[
                          { value: "all", label: bi("全部", "All") },
                          { value: "controller", label: bi("控制机", "Control") },
                          { value: "target", label: bi("目标机", "Target") },
                        ]}
                      />
                    </section>
                    {(upgradeCount > 0 || allAgents.length > 0) && (
                      <section>
                        <h4>{bi("属性筛选", "Attributes")}</h4>
                        {upgradeCount > 0 && (
                          <Checkbox
                            checked={roleFilter === "upgrade"}
                            onChange={(c) => setRoleFilter(c ? "upgrade" : "all")}
                          >
                            <span className="fpanel-app">
                              <span>{bi("仅显示可升级控制机", "Upgradable control agents only")}</span>
                              <em className="num">{upgradeCount}</em>
                            </span>
                          </Checkbox>
                        )}
                        {allAgents.length > 0 && (
                          <Checkbox
                            checked={onlyWritable}
                            onChange={setOnlyWritable}
                          >
                            <span className="fpanel-app">
                              <span>{bi("仅显示允许写操作目标机", "Writable target agents only")}</span>
                              <em className="num">
                                {allAgents.filter((a) => a.allow_mutating).length}
                              </em>
                            </span>
                          </Checkbox>
                        )}
                      </section>
                    )}
                    <section>
                      <h4>{bi("排序", "Sort")}</h4>
                      <Segmented<"status" | "name" | "heartbeat">
                        size="sm"
                        label={bi("排序", "Sort")}
                        value={agentSort}
                        onChange={setAgentSort}
                        options={[
                          { value: "status", label: bi("状态优先", "Status") },
                          { value: "name", label: bi("名称", "Name") },
                          { value: "heartbeat", label: bi("最近心跳", "Heartbeat") },
                        ]}
                      />
                    </section>
                    <footer>
                      <button
                        type="button"
                        className="link quiet"
                        onClick={() => {
                          setRoleFilter("all");
                          setOnlyWritable(false);
                          setAgentSort("status");
                        }}
                      >
                        {bi("恢复默认", "Reset")}
                      </button>
                      <Button
                        size="small"
                        type="primary"
                        onClick={() => setFilterOpen(false)}
                      >
                        {bi("完成", "Done")}
                      </Button>
                    </footer>
                  </div>
                }
              >
                <Button
                  className={`filter-btn ${extraFilters > 0 ? "on" : ""}`}
                  icon={<IconFilter />}
                  aria-label={bi(
                    `筛选${extraFilters ? `，已设置 ${extraFilters} 项` : ""}`,
                    `Filter${extraFilters ? ` (${extraFilters} active)` : ""}`,
                  )}
                  aria-expanded={filterOpen}
                >
                  {extraFilters > 0 && <em className="num">{extraFilters}</em>}
                </Button>
              </Popover>
            </div>

            <Segmented<StatusFilter>
              size="sm"
              label={bi("按在线状态筛选", "Filter by online status")}
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "all", label: bi("全部", "All"), count: statusCounts.all },
                { value: "online", label: bi("在线", "On"), count: statusCounts.online },
                { value: "offline", label: bi("离线", "Off"), count: statusCounts.offline },
                { value: "disabled", label: bi("停用", "Off"), count: statusCounts.disabled },
              ]}
            />

            <div
              className="ec-role-pills"
              role="group"
              aria-label={bi("按 Agent 角色筛选", "Filter by Agent role")}
            >
              {(canManage || all.length > 0) && (
                <button
                  type="button"
                  className={`ec-role-pill ${roleFilter === "controller" ? "on" : ""}`}
                  aria-pressed={roleFilter === "controller"}
                  onClick={() =>
                    setRoleFilter(roleFilter === "controller" ? "all" : "controller")
                  }
                >
                  <IconDesktop style={{ fontSize: 11 }} />
                  <span>{bi("控制机", "Control")}</span>
                  <em className="num">{all.length}</em>
                </button>
              )}
              <button
                type="button"
                className={`ec-role-pill is-target ${roleFilter === "target" ? "on" : ""}`}
                aria-pressed={roleFilter === "target"}
                onClick={() =>
                  setRoleFilter(roleFilter === "target" ? "all" : "target")
                }
              >
                <IconLink style={{ fontSize: 11 }} />
                <span>{bi("目标机", "Target")}</span>
                <em className="num">{allAgents.length}</em>
              </button>
              {upgradeCount > 0 && (
                <button
                  type="button"
                  className={`ec-role-pill is-upgrade ${roleFilter === "upgrade" ? "on" : ""}`}
                  aria-pressed={roleFilter === "upgrade"}
                  onClick={() =>
                    setRoleFilter(roleFilter === "upgrade" ? "all" : "upgrade")
                  }
                >
                  <span>{bi("可升级", "Upgrade")}</span>
                  <em className="num">{upgradeCount}</em>
                </button>
              )}
            </div>

            {onlyWritable && (
              <div className="active-filters tight">
                <FilterChip
                  size="small"
                  label={bi("仅允许写操作", "Writable only")}
                  onClose={() => setOnlyWritable(false)}
                />
              </div>
            )}

            {hasAnyFilter && !loadingList && (
              <div className="result-line num" aria-live="polite">
                {bi(
                  `显示 ${rows.length + agentRows.length} / ${all.length + allAgents.length} 台 Agent`,
                  `Showing ${rows.length + agentRows.length} of ${all.length + allAgents.length} Agents`,
                )}
                {rows.length + agentRows.length > 0 && (
                  <button type="button" className="link quiet" onClick={resetAllFilters}>
                    {bi("清除筛选", "Clear filters")}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="list-body">
            {loadingList ? (
              <div style={{ padding: 14 }}>
                <Skeleton animation text={{ rows: 5 }} />
              </div>
            ) : rows.length > 0 || agentRows.length > 0 ? (
              <>
                {rows.length > 0 && (
                  <div className="ec-rail-group">
                    <div className="ec-rail-group-h">
                      <span>{bi("控制机", "Control Agents")}</span>
                      <em>{rows.length}</em>
                    </div>
                    {rows.map((node) => {
                      const st = nodeConnection(node);
                      const oldProto = needsUpgrade(node);
                      const isSel = activeNode?.id === node.id;
                      return (
                        <button
                          key={node.id}
                          type="button"
                          className={`ec-rail-row ${isSel ? "on" : ""}`}
                          onClick={() => {
                            setSelected({ role: "controller", id: node.id });
                            setMobileDetail(true);
                          }}
                        >
                          <span className={`ec-state-dot is-${st.key}`} />
                          <div className="ec-rail-row-body">
                            <div className="ec-rail-row-top">
                              <b>{node.name}</b>
                              {oldProto ? (
                                <span className="ec-micro-pill is-upgrade">
                                  {bi("可升级", "Upgrade")}
                                </span>
                              ) : (
                                <span className="ec-micro-pill is-brand">
                                  {bi("控制机", "Ctrl")}
                                </span>
                              )}
                            </div>
                            <div className="ec-rail-row-sub">
                              <code className="mono">{node.controller_ip}</code>
                              <span>
                                {node.clusters.length > 0
                                  ? bi(`${node.clusters.length} 集群`, `${node.clusters.length} cl`)
                                  : node.last_seen
                                    ? ago(node.last_seen)
                                    : bi("待连接", "New")}
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {agentRows.length > 0 && (
                  <div className="ec-rail-group">
                    <div className="ec-rail-group-h">
                      <span>{bi("目标机（免密直连）", "Direct Target Agents")}</span>
                      <em>{agentRows.length}</em>
                    </div>
                    {agentRows.map((ag) => {
                      const isRevoked = ag.desired !== "active";
                      const dotCls = isRevoked
                        ? "is-revoked"
                        : ag.online
                          ? "is-online"
                          : "is-offline";
                      const isSel = activeAgent?.id === ag.id;
                      const boundList = ag.clusters ?? ag.matched_clusters ?? [];
                      const matchCnt =
                        boundList.length > 0 ? boundList.length : ag.cluster ? 1 : 0;
                      return (
                        <button
                          key={ag.id}
                          type="button"
                          className={`ec-rail-row ${isSel ? "on" : ""}`}
                          onClick={() => {
                            setSelected({ role: "target", id: ag.id });
                            setMobileDetail(true);
                          }}
                        >
                          <span className={`ec-state-dot ${dotCls}`} />
                          <div className="ec-rail-row-body">
                            <div className="ec-rail-row-top">
                              <b>{ag.host}</b>
                              <span
                                className={`ec-micro-pill ${ag.allow_mutating ? "is-ok" : ""}`}
                              >
                                {ag.allow_mutating ? bi("可写", "RW") : bi("只读", "RO")}
                              </span>
                            </div>
                            <div className="ec-rail-row-sub">
                              <code className="mono">{ag.ip}</code>
                              <span>
                                {isRevoked
                                  ? bi("已撤销", "Revoked")
                                  : matchCnt > 0
                                    ? bi(`${matchCnt} 集群`, `${matchCnt} cl`)
                                    : ag.online
                                      ? bi("在线", "Online")
                                      : ag.last_seen
                                        ? ago(ag.last_seen)
                                        : bi("待上线", "Pending")}
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <div className="ec-rail-empty">
                <IconLink />
                <span>
                  {all.length === 0 && allAgents.length === 0
                    ? bi("暂无已接入的 Agent", "No Agents connected yet")
                    : bi("没有匹配的 Agent", "No matching Agents")}
                </span>
              </div>
            )}
          </div>
        </aside>
      )}

      {showDetail && (
        <section className="md-detail" aria-live="polite">
          {error && canManage && (
            <div className="ec-detail-banner-wrap enter">
              <div className="en-error" role="alert">
                <IconExclamationCircle />
                <div>
                  <b>{bi("控制机状态未能更新", "Failed to refresh control agents")}</b>
                  <p>{error}</p>
                </div>
                <Button size="small" onClick={() => void load(true)} loading={refreshing}>
                  {bi("重试", "Retry")}
                </Button>
              </div>
            </div>
          )}

          {agentsError && (
            <div className="ec-detail-banner-wrap enter">
              <div className="en-error" role="alert">
                <IconExclamationCircle />
                <div>
                  <b>{bi("目标机 Agent 状态未能更新", "Failed to refresh target agents")}</b>
                  <p>{agentsError}</p>
                </div>
                <Button size="small" onClick={() => void load(true)} loading={refreshing}>
                  {bi("重试", "Retry")}
                </Button>
              </div>
            </div>
          )}

          {activeStep2 && !open && (
            <div className="ec-detail-banner-wrap enter">
              <div className="en-pending" role="status">
                <IconInfoCircle />
                <span>
                  {registration
                    ? biv(
                        <>
                          <b>{registration.node.name}</b>{" "}
                          已登记，继续下载安装包并在控制机完成连接。
                        </>,
                        <>
                          <b>{registration.node.name}</b> is registered—download the
                          installer bundle and finish connecting.
                        </>,
                      )
                    : biv(
                        <>
                          目标机 <b>{targetRegistration?.agent.host}</b> (
                          <code>{targetRegistration?.agent.ip}</code>)
                          已签发直连 Agent，继续下载安装包并完成上线。
                        </>,
                        <>
                          Target Agent for <b>{targetRegistration?.agent.host}</b> (
                          <code>{targetRegistration?.agent.ip}</code>) is ready—download the
                          installer bundle to connect.
                        </>,
                      )}
                </span>
                <Button size="small" type="text" onClick={() => setOpen(true)}>
                  {bi("继续接入", "Continue Setup")} <IconArrowRight />
                </Button>
              </div>
            </div>
          )}

          {activeNode ? (
            (() => {
              const st = nodeConnection(activeNode);
              const oldProto = needsUpgrade(activeNode);
              const badgeState =
                st.key === "online"
                  ? "succeeded"
                  : st.key === "offline"
                    ? "failed"
                    : "pending";
              const deliveryOn = activeNode.allow_delivery !== false;
              const probeOn = activeNode.allow_probe !== false;
              const rehearsalOn = Boolean(activeNode.allow_rehearsal) && !oldProto;
              const enabledCaps =
                (deliveryOn ? 1 : 0) + (probeOn ? 1 : 0) + (rehearsalOn ? 1 : 0);
              const enabledCapSummary = [
                deliveryOn ? bi("交付", "Delivery") : null,
                probeOn ? bi("探针", "Probe") : null,
                rehearsalOn ? bi("演练", "Rehearsal") : null,
              ]
                .filter(Boolean)
                .join(" · ");
              const placementLabel =
                activeNode.kind === "independent"
                  ? bi("独立管理机", "Dedicated Host")
                  : bi("集群内执行机", "In-Cluster Host");
              const targetVer = bootInfo?.version
                ? `v${bootInfo.version.replace(/^v/, "")}`
                : "";
              return (
                <article
                  className="detail enter ec-detail-article"
                  key={activeNode.id}
                >
                  {narrow && (
                    <Button
                      type="text"
                      className="back"
                      icon={<IconArrowLeft />}
                      onClick={() => setMobileDetail(false)}
                    >
                      {bi("Agent 列表", "Agents")}
                    </Button>
                  )}

                  {/* Full-Width Hero Header */}
                  <header className="detail-head app-head ec-hero-head">
                    <div className="ec-hero-glyph is-controller" aria-hidden>
                      <IconDesktop />
                    </div>
                    <div className="app-head-main">
                      <div className="detail-title">
                        <h1>{activeNode.name}</h1>
                        <StatusBadge
                          state={badgeState}
                          label={nodeStatusLabel(st.key, st.label)}
                        />
                        <span className="ec-micro-pill is-brand">
                          {bi("控制机 Agent", "Control Agent")}
                        </span>
                      </div>
                      <div className="detail-meta">
                        <button
                          type="button"
                          className="ec-meta-copy mono"
                          onClick={() =>
                            void copy(
                              activeNode.controller_ip,
                              bi("已复制控制机 IP", "Controller IP copied"),
                            )
                          }
                          title={bi("点击复制 IP", "Copy IP")}
                        >
                          <span>{activeNode.controller_ip}</span>
                          <IconCopy />
                        </button>
                        <span>{placementLabel}</span>
                        {activeNode.version && (
                          <span className="mono">v{activeNode.version}</span>
                        )}
                        <Tooltip
                          content={
                            activeNode.last_seen
                              ? fullTime(activeNode.last_seen)
                              : bi("尚未上报心跳", "No heartbeat yet")
                          }
                          mini
                        >
                          <span>
                            {activeNode.last_seen
                              ? bi(
                                  `最近心跳 ${ago(activeNode.last_seen)}`,
                                  `Heartbeat ${ago(activeNode.last_seen)}`,
                                )
                              : bi("等待首次心跳", "Awaiting first heartbeat")}
                          </span>
                        </Tooltip>
                      </div>
                    </div>
                    <div className="detail-actions">
                      {canManage && (
                        <Button
                          size="small"
                          type={activeNode.disabled ? "primary" : "outline"}
                          loading={updating === activeNode.id}
                          disabled={!!updating && updating !== activeNode.id}
                          onClick={() => void toggle(activeNode)}
                        >
                          {activeNode.disabled
                            ? bi("恢复接单", "Resume")
                            : bi("暂停接单", "Pause")}
                        </Button>
                      )}
                      <Button
                        size="small"
                        type="outline"
                        icon={<IconBook />}
                        onClick={() => setGuide("install")}
                      >
                        {bi("接入指南", "Guide")}
                      </Button>
                      {canManage && (
                        <Tooltip content={bi("删除节点", "Delete node")} mini>
                          <Button
                            size="small"
                            status="danger"
                            icon={<IconDelete />}
                            disabled={!!updating}
                            onClick={() => remove(activeNode)}
                            aria-label={bi(
                              `删除执行节点 ${activeNode.name}`,
                              `Delete execution node ${activeNode.name}`,
                            )}
                          />
                        </Tooltip>
                      )}
                    </div>
                  </header>

                  {/* 4-Column Responsive Telemetry Strip */}
                  <div className="ec-kpi-strip">
                    <div className="ec-kpi-card">
                      <div className="ec-kpi-top">
                        <span className="ec-kpi-label">{bi("连接与接单状态", "Connection & Dispatch")}</span>
                        <span className={`ec-state-dot is-${st.key}`} aria-hidden />
                      </div>
                      <div className="ec-kpi-val">
                        <b>{nodeStatusLabel(st.key, st.label)}</b>
                      </div>
                      <span
                        className={`ec-kpi-sub num ${
                          st.key === "online"
                            ? "is-ok"
                            : st.key === "offline"
                              ? "is-warn"
                              : ""
                        }`}
                      >
                        {st.key === "online" && activeNode.last_seen
                          ? bi(
                              `每 ${activeNode.probe?.interval_sec || 3}s 实时上报 · ${ago(activeNode.last_seen)}`,
                              `Every ${activeNode.probe?.interval_sec || 3}s · ${ago(activeNode.last_seen)}`,
                            )
                          : activeNode.last_seen
                            ? fullTime(activeNode.last_seen)
                            : bi("启动服务后每 3s 实时上报心跳", "Streams live heartbeat every 3s")}
                      </span>
                    </div>

                    <div className="ec-kpi-card">
                      <div className="ec-kpi-top">
                        <span className="ec-kpi-label">{bi("执行器版本与协议", "Runner & Protocol")}</span>
                        {oldProto && (
                          <span className="ec-micro-pill is-upgrade">
                            {bi("可升级", "Upgrade")}
                          </span>
                        )}
                      </div>
                      <div className="ec-kpi-val">
                        <b className="mono">
                          {activeNode.version ? `v${activeNode.version}` : bi("待上报", "Pending")}
                        </b>
                        {activeNode.protocol ? (
                          <span className="ec-kpi-unit mono">v{activeNode.protocol}</span>
                        ) : null}
                      </div>
                      <span
                        className={`ec-kpi-sub ${
                          oldProto
                            ? "is-warn"
                            : (activeNode.protocol || 0) >= 3
                              ? "is-ok"
                              : ""
                        }`}
                      >
                        {oldProto
                          ? bi("旧版协议，升级至 v3 解锁演练自动执行", "Upgrade to v3 to unlock rehearsal automation")
                          : (activeNode.protocol || 0) >= 3
                            ? bi("协议 v3 · 完整自动化就绪", "Protocol v3 · Full automation ready")
                            : bi("上线后自动识别协议版本", "Protocol detected on first check-in")}
                      </span>
                    </div>

                    <div className="ec-kpi-card">
                      <div className="ec-kpi-top">
                        <span className="ec-kpi-label">{bi("能力授权进度", "Capabilities Active")}</span>
                      </div>
                      <div className="ec-kpi-val num">
                        <b>{enabledCaps} / 3</b>
                        <span className="ec-kpi-unit">{bi("已开启", "active")}</span>
                      </div>
                      <span className="ec-kpi-sub">
                        {enabledCapSummary || bi("全部能力均已关闭", "All capabilities disabled")}
                      </span>
                    </div>

                    <div className="ec-kpi-card">
                      <div className="ec-kpi-top">
                        <span className="ec-kpi-label">{bi("授权纳管范围", "Authorized Scope")}</span>
                      </div>
                      <div className="ec-kpi-val num">
                        <b>
                          {bi(
                            `${activeNode.clusters.length} 集群 · ${activeNode.ips.length} 主机`,
                            `${activeNode.clusters.length} cl · ${activeNode.ips.length} hosts`,
                          )}
                        </b>
                      </div>
                      <span className="ec-kpi-sub">{placementLabel}</span>
                    </div>
                  </div>

                  {/* Full-Width Dual-Column Workspace */}
                  <div className="ec-detail-grid">
                    <div className="ec-detail-main">
                      {oldProto && (
                        <section className="ec-upgrade-card" id="ec-upgrade-section">
                          <div className="ec-upgrade-top">
                            <div className="ec-upgrade-top-l">
                              <span className="ec-upgrade-ic" aria-hidden>
                                <IconDownload />
                              </span>
                              <div className="ec-upgrade-copy">
                                <div className="ec-upgrade-title-row">
                                  <b>
                                    {bi(
                                      "升级执行器以解锁变更演练自动执行",
                                      "Upgrade Runner to Unlock Rehearsal Automation",
                                    )}
                                  </b>
                                  <span className="ec-ver-diff mono">
                                    {activeNode.version && targetVer
                                      ? `v${activeNode.version} → ${targetVer}`
                                      : bi("协议 v2 → v3", "Protocol v2 → v3")}
                                  </span>
                                </div>
                                <p>
                                  {bi(
                                    "当前仅支持首次交付与只读探针；替换 Linux amd64 二进制并重启 systemd 即可平滑升级，原有凭据与配置自动保留。",
                                    "Currently limited to initial delivery & read-only probes. Replace the Linux amd64 binary and restart systemd to upgrade in place.",
                                  )}
                                </p>
                              </div>
                            </div>
                            <div className="ec-upgrade-acts">
                              <Button
                                size="small"
                                type="secondary"
                                icon={<IconDownload />}
                                href={withLang("/api/settings/execution-nodes/binary")}
                              >
                                {bi("下载新版二进制", "Download Binary")}
                              </Button>
                              <Button
                                size="small"
                                type="outline"
                                icon={<IconCopy />}
                                onClick={() =>
                                  void copy(
                                    upgradeCmd,
                                    bi("已复制升级命令", "Upgrade commands copied"),
                                  )
                                }
                              >
                                {bi("复制命令", "Copy")}
                              </Button>
                              <button
                                type="button"
                                className="ec-upgrade-toggle"
                                aria-expanded={upgradeCmdOpen}
                                onClick={() => setUpgradeCmdOpen((v) => !v)}
                              >
                                <span>
                                  {upgradeCmdOpen
                                    ? bi("收起步骤", "Hide Steps")
                                    : bi("查看升级步骤", "View Steps")}
                                </span>
                                {upgradeCmdOpen ? <IconUp /> : <IconDown />}
                              </button>
                            </div>
                          </div>
                          {upgradeCmdOpen && (
                            <div className="ec-code-card enter">
                              <div className="ec-code-bar">
                                <span className="mono">
                                  <IconCode />
                                  {bi("控制机平滑升级命令 · bash", "Control Host Upgrade · bash")}
                                </span>
                                <button
                                  type="button"
                                  className="ec-code-copy"
                                  onClick={() =>
                                    void copy(
                                      upgradeCmd,
                                      bi("已复制升级命令", "Upgrade commands copied"),
                                    )
                                  }
                                >
                                  <IconCopy />
                                  <span>{bi("复制", "Copy")}</span>
                                </button>
                              </div>
                              <pre className="ec-code-pre mono">{upgradeCmd}</pre>
                            </div>
                          )}
                        </section>
                      )}

                      {/* Live Heartbeat & Host Telemetry */}
                      <AgentLiveProbeSection
                        probe={activeNode.probe}
                        online={st.key === "online"}
                        lastSeen={activeNode.last_seen}
                        inactive={activeNode.disabled}
                        defaultIntervalSec={3}
                      />

                      {/* Capability Permissions */}
                      <section className="ec-sec">
                        <div className="ec-sec-head">
                          <div>
                            <h2 className="ec-sec-title">
                              {bi("能力授权与安全边界", "Capabilities & Guardrails")}
                            </h2>
                            <p className="ec-sec-sub">
                              {bi(
                                "按需独立启停该控制机可承接的任务类型，所有变更写操作均受集群生产安全门禁二次约束。",
                                "Control which task classes this runner may claim; mutating steps remain guarded by cluster safety gates.",
                              )}
                            </p>
                          </div>
                          <span className="ec-sec-badge num">
                            {bi(`${enabledCaps} / 3 已开启`, `${enabledCaps} / 3 active`)}
                          </span>
                        </div>

                        <div className="ec-surface-card">
                          <div className="ec-cap-item">
                            <div className={`ec-cap-ic ${deliveryOn ? "is-on" : ""}`} aria-hidden>
                              <IconStorage />
                            </div>
                            <div className="ec-cap-body">
                              <div className="ec-cap-title-row">
                                <b>{bi("首次交付部署", "Delivery Runs")}</b>
                                <span className={`ec-cap-state ${deliveryOn ? "is-ok" : ""}`}>
                                  {deliveryOn ? bi("已开启", "Enabled") : bi("已关闭", "Disabled")}
                                </span>
                              </div>
                              <p>
                                {bi(
                                  "允许承接集群首次部署、扩缩容及配置交付的 Ansible 执行批次。",
                                  "Allow claiming initial deployment, scaling, and config delivery runs.",
                                )}
                              </p>
                            </div>
                            <Switch
                              size="small"
                              checked={deliveryOn}
                              loading={updating === activeNode.id}
                              disabled={!canManage || updating === activeNode.id}
                              onChange={(v) =>
                                void updateNodeCap(activeNode, { allow_delivery: v })
                              }
                            />
                          </div>

                          <div className="ec-cap-item">
                            <div className={`ec-cap-ic ${probeOn ? "is-on" : ""}`} aria-hidden>
                              <IconSafe />
                            </div>
                            <div className="ec-cap-body">
                              <div className="ec-cap-title-row">
                                <b>{bi("只读探针采集", "Read-Only Probes")}</b>
                                <span className={`ec-cap-state ${probeOn ? "is-ok" : ""}`}>
                                  {probeOn ? bi("已开启", "Enabled") : bi("已关闭", "Disabled")}
                                </span>
                              </div>
                              <p>
                                {bi(
                                  "允许自动下发 100% 只读基线与变更前状态探针（经静态只读安全门禁校验）。",
                                  "Allow dispatching 100% read-only baseline and pre-change probe scripts.",
                                )}
                              </p>
                            </div>
                            <Switch
                              size="small"
                              checked={probeOn}
                              loading={updating === activeNode.id}
                              disabled={!canManage || updating === activeNode.id}
                              onChange={(v) =>
                                void updateNodeCap(activeNode, { allow_probe: v })
                              }
                            />
                          </div>

                          <div className="ec-cap-item">
                            <div
                              className={`ec-cap-ic ${
                                rehearsalOn ? "is-on" : oldProto ? "is-warn" : ""
                              }`}
                              aria-hidden
                            >
                              <IconThunderbolt />
                            </div>
                            <div className="ec-cap-body">
                              <div className="ec-cap-title-row">
                                <b>{bi("变更演练步骤执行", "Rehearsal Step Execution")}</b>
                                <span
                                  className={`ec-cap-state ${
                                    oldProto ? "is-warn" : rehearsalOn ? "is-ok" : ""
                                  }`}
                                >
                                  {oldProto
                                    ? bi("需升级至 v3", "Requires v3")
                                    : rehearsalOn
                                      ? bi("已开启", "Enabled")
                                      : bi("已关闭", "Disabled")}
                                </span>
                              </div>
                              <p>
                                {bi(
                                  "允许在变更演练工作台执行变更写操作与回滚步骤（受集群生产门禁约束）。",
                                  "Allow executing mutating and rollback steps during rehearsals.",
                                )}
                              </p>
                              {oldProto && (
                                <button
                                  type="button"
                                  className="ec-cap-action-link"
                                  onClick={() => setUpgradeCmdOpen(true)}
                                >
                                  <span>{bi("查看控制机平滑升级命令", "View in-place upgrade steps")}</span>
                                  <IconArrowRight />
                                </button>
                              )}
                            </div>
                            <Switch
                              size="small"
                              checked={Boolean(activeNode.allow_rehearsal)}
                              loading={updating === activeNode.id}
                              disabled={!canManage || oldProto || updating === activeNode.id}
                              onChange={(v) =>
                                void updateNodeCap(activeNode, { allow_rehearsal: v })
                              }
                            />
                          </div>
                        </div>
                      </section>

                      {/* Authorized Clusters & Target Hosts */}
                      <section className="ec-sec">
                        <div className="ec-sec-head">
                          <div>
                            <h2 className="ec-sec-title">
                              {bi("授权集群与放行目标主机", "Authorized Clusters & Target Hosts")}
                            </h2>
                            <p className="ec-sec-sub">
                              {bi(
                                "控制机仅允许对下方已绑定集群及放行列表内的主机下发自动化任务，点击集群直达自动化配置，点击主机可复制 IP。",
                                "This controller can only target bound clusters and allowed hosts below. Click a cluster to open Automation or a host to copy its IP.",
                              )}
                            </p>
                          </div>
                          <span className="ec-sec-badge num">
                            {bi(
                              `${activeNode.clusters.length} 集群 · ${activeNode.ips.length} 主机`,
                              `${activeNode.clusters.length} cl · ${activeNode.ips.length} hosts`,
                            )}
                          </span>
                        </div>

                        <div className="ec-surface-card">
                          <div className="ec-scope-block">
                            <div className="ec-scope-subhead">
                              <span>{bi("已授权集群", "Bound Clusters")}</span>
                              <span className="num">{activeNode.clusters.length}</span>
                            </div>
                            {activeNode.clusters.length === 0 ? (
                              <p className="ec-scope-hint">
                                {bi(
                                  "尚未绑定集群；可在任意集群的「自动化」标签页或交付执行中选择此控制机。",
                                  "No clusters bound yet; select this node in any cluster's Automation tab.",
                                )}
                              </p>
                            ) : (
                              <div className="ec-cluster-grid">
                                {activeNode.clusters.map((cid) => (
                                  <button
                                    key={cid}
                                    type="button"
                                    className="ec-cluster-card"
                                    onClick={() =>
                                      go({ name: "deliveries", id: cid, tab: "automation" })
                                    }
                                  >
                                    <div className="ec-cluster-card-l">
                                      <span className="ec-cluster-ic" aria-hidden>
                                        <IconStorage />
                                      </span>
                                      <div className="ec-cluster-card-txt">
                                        <b className="mono">{cid}</b>
                                        <small>{bi("打开集群自动化与演练", "Open cluster automation")}</small>
                                      </div>
                                    </div>
                                    <IconRight className="ec-cluster-card-arrow" />
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>

                          {activeNode.ips.length > 0 && (
                            <div className="ec-scope-block">
                              <div className="ec-scope-subhead">
                                <span>{bi("放行目标主机 IP", "Allowed Host IPs")}</span>
                                <span className="num">{activeNode.ips.length}</span>
                              </div>
                              <div className="ec-host-grid">
                                {activeNode.ips.map((ip) => {
                                  const isCtrl = ip === activeNode.controller_ip;
                                  return (
                                    <button
                                      key={ip}
                                      type="button"
                                      className={`ec-host-tile ${isCtrl ? "is-ctrl" : ""}`}
                                      onClick={() =>
                                        void copy(ip, bi(`已复制 ${ip}`, `Copied ${ip}`))
                                      }
                                      title={bi("点击复制主机 IP", "Click to copy IP")}
                                    >
                                      <div className="ec-host-tile-l">
                                        <code className="mono">{ip}</code>
                                        {isCtrl && (
                                          <span className="ec-host-tag">
                                            {bi("控制本机", "Ctrl")}
                                          </span>
                                        )}
                                      </div>
                                      <IconCopy className="ec-host-copy" />
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </section>

                      {(st.key === "offline" || st.key === "waiting") && (
                        <div className="ec-diag-bar">
                          <span>
                            {bi(
                              "节点未连上？可让 AI 结合当前地址、CA 证书与 systemd 状态快速生成排查命令。",
                              "Node offline? Let AI generate quick diagnostic commands for URL, CA cert, and systemd.",
                            )}
                          </span>
                          <AIHelpButton
                            variant="pill"
                            topic={`node-offline-${activeNode.id}`}
                            title={bi(`排查节点「${activeNode.name}」未连接`, `Troubleshoot "${activeNode.name}"`)}
                            page={bi("执行中心 · 控制机", "Execution Center · Nodes")}
                            summary={bi(
                              `节点 ${activeNode.name} (${activeNode.controller_ip})，位置=${activeNode.kind}，状态=${st.key}`,
                              `Node ${activeNode.name} (${activeNode.controller_ip}), kind=${activeNode.kind}, state=${st.key}`,
                            )}
                            prompt={bi(
                              `执行节点「${activeNode.name}」(${activeNode.controller_ip}) 当前状态为「${nodeStatusLabel(st.key, st.label)}」，请帮我列出最快定位原因的检查命令和常见坑。`,
                              `Execution node "${activeNode.name}" (${activeNode.controller_ip}) is ${st.key}. Give the quickest diagnostic commands.`,
                            )}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              );
            })()
          ) : activeAgent ? (
            (() => {
              const isRevoked = activeAgent.desired !== "active";
              const badgeState = isRevoked
                ? "pending"
                : activeAgent.online
                  ? "succeeded"
                  : "failed";
              const badgeLabel = isRevoked
                ? bi("已撤销授权", "Revoked")
                : activeAgent.online
                  ? bi("在线运行中", "Online")
                  : bi("离线 / 待启动", "Offline");
              const dotCls = isRevoked
                ? "is-revoked"
                : activeAgent.online
                  ? "is-online"
                  : "is-offline";
              const agentSvc = `middleware-target-agent-${activeAgent.id}`;
              return (
                <article
                  className="detail enter ec-detail-article"
                  key={activeAgent.id}
                >
                  {narrow && (
                    <Button
                      type="text"
                      className="back"
                      icon={<IconArrowLeft />}
                      onClick={() => setMobileDetail(false)}
                    >
                      {bi("Agent 列表", "Agents")}
                    </Button>
                  )}

                  {/* Full-Width Hero Header */}
                  <header className="detail-head app-head ec-hero-head">
                    <div className="ec-hero-glyph is-target" aria-hidden>
                      <IconLink />
                    </div>
                    <div className="app-head-main">
                      <div className="detail-title">
                        <h1>{activeAgent.host}</h1>
                        <StatusBadge state={badgeState} label={badgeLabel} />
                        <span className="ec-micro-pill is-ok">
                          {bi("目标机 Agent · 免密直连", "Target Agent · Direct")}
                        </span>
                      </div>
                      <div className="detail-meta">
                        <button
                          type="button"
                          className="ec-meta-copy mono"
                          onClick={() =>
                            void copy(
                              activeAgent.ip,
                              bi("已复制目标主机 IP", "Target IP copied"),
                            )
                          }
                          title={bi("点击复制 IP", "Copy IP")}
                        >
                          <span>{activeAgent.ip}</span>
                          <IconCopy />
                        </button>
                        <span>
                          {activeAgentClusters.length > 0
                            ? bi(
                                `已关联授权 ${activeAgentClusters.length} 个集群`,
                                `Bound to ${activeAgentClusters.length} cluster(s)`,
                              )
                            : bi("暂未关联集群", "No cluster bound yet")}
                        </span>
                        {activeAgent.version && (
                          <span className="mono">v{activeAgent.version}</span>
                        )}
                        <Tooltip
                          content={
                            activeAgent.last_seen
                              ? bi(
                                  `每 ${activeAgent.probe?.interval_sec || 5}s 实时探针上报 · 最近上报 ${fullTime(activeAgent.last_seen)}`,
                                  `Live probe every ${activeAgent.probe?.interval_sec || 5}s · Last seen ${fullTime(activeAgent.last_seen)}`,
                                )
                              : bi("安装启动后每 5s 自动实时上报心跳与探针", "Streams live heartbeats every 5s once started")
                          }
                          mini
                        >
                          <span>
                            {activeAgent.online && activeAgent.last_seen
                              ? bi(
                                  `实时心跳正常 · ${ago(activeAgent.last_seen)}`,
                                  `Live heartbeat · ${ago(activeAgent.last_seen)}`,
                                )
                              : activeAgent.last_seen
                                ? bi(
                                    `最近心跳 ${ago(activeAgent.last_seen)}`,
                                    `Last heartbeat ${ago(activeAgent.last_seen)}`,
                                  )
                                : isRevoked
                                  ? bi("未部署上线", "Never connected")
                                  : bi("待启动服务（每 5s 实时上报）", "Pending start (5s live poll)")}
                          </span>
                        </Tooltip>
                      </div>
                    </div>
                    <div className="detail-actions">
                      {activeAgentClusters.length === 1 && (
                        <Button
                          size="small"
                          type="outline"
                          icon={<IconThunderbolt />}
                          onClick={() =>
                            go({
                              name: "deliveries",
                              id: activeAgentClusters[0],
                              tab: "automation",
                            })
                          }
                        >
                          {bi("打开集群自动化", "Cluster Automation")}
                        </Button>
                      )}
                      {!isRevoked && (
                        <Button
                          size="small"
                          type="outline"
                          icon={<IconBook />}
                          onClick={() => setGuide("maintain")}
                        >
                          {bi("维护指南", "Guide")}
                        </Button>
                      )}
                      {canManage && isRevoked && (
                        <Button
                          size="small"
                          type="primary"
                          icon={<IconPlus />}
                          onClick={() => reEnrollTarget(activeAgent)}
                        >
                          {bi("重新签发接入", "Re-Enroll")}
                        </Button>
                      )}
                      {canManage && !isRevoked && (
                        <Popconfirm
                          title={bi(
                            `确定撤销 ${activeAgent.host} (${activeAgent.ip}) 的直连 Agent 授权？`,
                            `Revoke agent on ${activeAgent.host} (${activeAgent.ip})?`,
                          )}
                          okText={bi("撤销", "Revoke")}
                          cancelText={bi("取消", "Cancel")}
                          onOk={() =>
                            void updateGlobalAgent(activeAgent, { action: "revoke" })
                          }
                        >
                          <Button
                            size="small"
                            status="danger"
                            loading={updatingAgent === activeAgent.id}
                          >
                            {bi("撤销授权", "Revoke")}
                          </Button>
                        </Popconfirm>
                      )}
                      {canManage && (isRevoked || !activeAgent.online) && (
                        <Popconfirm
                          title={bi(
                            `确定彻底删除 ${activeAgent.host} (${activeAgent.ip}) 的 Agent 记录？`,
                            `Delete agent record for ${activeAgent.host} (${activeAgent.ip})?`,
                          )}
                          okText={bi("删除", "Delete")}
                          cancelText={bi("取消", "Cancel")}
                          onOk={() =>
                            void updateGlobalAgent(activeAgent, { action: "delete" })
                          }
                        >
                          <Button
                            size="small"
                            status="danger"
                            icon={<IconDelete />}
                            loading={updatingAgent === activeAgent.id}
                            aria-label={bi(
                              `删除目标机 Agent ${activeAgent.host}`,
                              `Delete target agent ${activeAgent.host}`,
                            )}
                          />
                        </Popconfirm>
                      )}
                    </div>
                  </header>

                  {/* 4-Column Responsive Telemetry Strip */}
                  <div className="ec-kpi-strip">
                    <div className="ec-kpi-card">
                      <div className="ec-kpi-top">
                        <span className="ec-kpi-label">{bi("实时心跳与运行状态", "Live Heartbeat & State")}</span>
                        <span className={`ec-state-dot ${dotCls}`} aria-hidden />
                      </div>
                      <div className="ec-kpi-val">
                        <b>{badgeLabel}</b>
                      </div>
                      <span
                        className={`ec-kpi-sub num ${
                          activeAgent.online
                            ? "is-ok"
                            : !isRevoked && activeAgent.last_seen
                              ? "is-warn"
                              : ""
                        }`}
                      >
                        {activeAgent.online && activeAgent.last_seen
                          ? bi(
                              `每 ${activeAgent.probe?.interval_sec || 5}s 实时上报 · ${ago(activeAgent.last_seen)}`,
                              `Every ${activeAgent.probe?.interval_sec || 5}s · ${ago(activeAgent.last_seen)}`,
                            )
                          : activeAgent.last_seen
                            ? fullTime(activeAgent.last_seen)
                            : isRevoked
                              ? bi("授权已撤销 · 未部署运行", "Revoked before deployment")
                              : bi("启动后每 5s 实时上报心跳", "Streams live heartbeat every 5s")}
                      </span>
                    </div>

                    <div className="ec-kpi-card">
                      <div className="ec-kpi-top">
                        <span className="ec-kpi-label">{bi("执行权限边界", "Execution Guardrail")}</span>
                      </div>
                      <div className="ec-kpi-val">
                        <b>
                          {isRevoked
                            ? bi("授权已失效", "Token Revoked")
                            : activeAgent.allow_mutating
                              ? bi("读写就绪", "Read & Write")
                              : bi("仅只读探针", "Read-Only")}
                        </b>
                      </div>
                      <span
                        className={`ec-kpi-sub ${
                          isRevoked
                            ? "is-warn"
                            : activeAgent.allow_mutating
                              ? "is-ok"
                              : ""
                        }`}
                      >
                        {isRevoked
                          ? bi("重新签发接入后恢复探针与变更执行", "Re-enroll host to restore execution")
                          : activeAgent.allow_mutating
                            ? bi("允许探针、变更执行与回滚", "Probes, mutations & rollbacks allowed")
                            : bi("仅放行 100% 只读采集命令", "Strictly 100% read-only probes")}
                      </span>
                    </div>

                    <div className="ec-kpi-card">
                      <div className="ec-kpi-top">
                        <span className="ec-kpi-label">{bi("关联授权集群", "Authorized Clusters")}</span>
                      </div>
                      <div className="ec-kpi-val num">
                        <b>{activeAgentClusters.length}</b>
                        <span className="ec-kpi-unit">{bi("个集群", "clusters")}</span>
                      </div>
                      <span className="ec-kpi-sub">
                        {bi("手动选择关联集群，严格跨集群隔离", "Explicitly selected by customer")}
                      </span>
                    </div>

                    <div className="ec-kpi-card">
                      <div className="ec-kpi-top">
                        <span className="ec-kpi-label">{bi("版本与通道", "Version & Transport")}</span>
                      </div>
                      <div className="ec-kpi-val">
                        <b className="mono">
                          {activeAgent.version ? `v${activeAgent.version}` : bi("待上线", "Pending")}
                        </b>
                      </div>
                      <span className="ec-kpi-sub">
                        {bi("HTTPS 主动外连 · 无需 SSH 密码", "Outbound HTTPS · Passwordless")}
                      </span>
                    </div>
                  </div>

                  {/* Full-Width Single-Column Workspace */}
                  <div className="ec-detail-grid">
                    <div className="ec-detail-main">
                      {/* Live Heartbeat & Host Telemetry */}
                      <AgentLiveProbeSection
                        probe={activeAgent.probe}
                        online={activeAgent.online}
                        lastSeen={activeAgent.last_seen}
                        inactive={isRevoked}
                        defaultIntervalSec={5}
                      />

                      {/* Permissions Card */}
                      <section className="ec-sec">
                        <div className="ec-sec-head">
                          <div>
                            <h2 className="ec-sec-title">
                              {bi("执行权限与安全边界", "Permissions & Guardrails")}
                            </h2>
                            <p className="ec-sec-sub">
                              {bi(
                                "目标机 Agent 通过 HTTPS 主动外连平台拉取已授权步骤，可随时按安全策略切换只读或可写模式。",
                                "Target Agent polls authorized steps over outbound HTTPS. Toggle read-only vs. mutating policy anytime.",
                              )}
                            </p>
                          </div>
                          <span className="ec-sec-badge">
                            {isRevoked
                              ? bi("已撤销授权", "Revoked")
                              : activeAgent.allow_mutating
                                ? bi("读写模式", "Read / Write")
                                : bi("只读模式", "Read-Only")}
                          </span>
                        </div>

                        <div className="ec-surface-card">
                          <div className="ec-cap-item">
                            <div
                              className={`ec-cap-ic ${!isRevoked && activeAgent.allow_mutating ? "is-on" : ""}`}
                              aria-hidden
                            >
                              {!isRevoked && activeAgent.allow_mutating ? <IconThunderbolt /> : <IconSafe />}
                            </div>
                            <div className="ec-cap-body">
                              <div className="ec-cap-title-row">
                                <b>{bi("允许执行变更写操作", "Allow Mutating Steps")}</b>
                                <span
                                  className={`ec-cap-state ${
                                    isRevoked
                                      ? "is-warn"
                                      : activeAgent.allow_mutating
                                        ? "is-ok"
                                        : ""
                                  }`}
                                >
                                  {isRevoked
                                    ? bi("已撤销", "Revoked")
                                    : activeAgent.allow_mutating
                                      ? bi("已允许", "Allowed")
                                      : bi("仅只读", "Read-Only")}
                                </span>
                              </div>
                              <p>
                                {bi(
                                  "关闭后该 Agent 仅放行 100% 只读基线与演练前探针，拒绝任何写操作与回滚命令。",
                                  "When off, this agent only accepts 100% read-only probes and blocks mutating commands.",
                                )}
                              </p>
                            </div>
                            <Switch
                              size="small"
                              checked={Boolean(activeAgent.allow_mutating)}
                              loading={updatingAgent === activeAgent.id}
                              disabled={!canManage || isRevoked}
                              onChange={(v) =>
                                void updateGlobalAgent(activeAgent, {
                                  action: "update",
                                  allow_mutating: v,
                                })
                              }
                            />
                          </div>
                        </div>
                      </section>

                      {/* Customer-Selected Bound Clusters */}
                      <section className="ec-sec">
                        <div className="ec-sec-head">
                          <div>
                            <h2 className="ec-sec-title">
                              {bi("关联授权集群", "Authorized Clusters")}
                            </h2>
                            <p className="ec-sec-sub">
                              {bi(
                                "由您自主选择允许调用该目标机 Agent 的集群（不再按 IP 自动关联），保障多套集群之间的严格权限隔离。",
                                "Explicitly choose which clusters are authorized to dispatch tasks to this Target Agent (never auto-matched by IP alone).",
                              )}
                            </p>
                          </div>
                          <span className="ec-sec-badge num">{activeAgentClusters.length}</span>
                        </div>

                        <div className="ec-surface-card">
                          <div className="ec-scope-block">
                            {canManage && !isRevoked && (
                              <div className="ec-bind-picker-row">
                                <Select
                                  showSearch
                                  value={undefined}
                                  disabled={updatingAgent === activeAgent.id}
                                  placeholder={bi(
                                    "选择集群添加到此 Agent（可输入集群名称搜索）…",
                                    "Select a cluster to authorize on this Agent…",
                                  )}
                                  notFoundContent={bi("没有更多可关联的集群", "No more clusters available")}
                                  filterOption={(inputValue, option) => {
                                    const q = inputValue.trim().toLowerCase();
                                    if (!q) return true;
                                    const val = String((option as { props?: { value?: string } })?.props?.value || "").toLowerCase();
                                    const meta = clusterById.get(val);
                                    return (
                                      val.includes(q) ||
                                      (meta?.app_name || "").toLowerCase().includes(q)
                                    );
                                  }}
                                  onChange={(cid) => {
                                    if (!cid) return;
                                    void updateGlobalAgent(activeAgent, {
                                      action: "update",
                                      add_cluster: String(cid),
                                    });
                                  }}
                                >
                                  {clusters
                                    .filter((c) => !activeAgentClusters.includes(c.id))
                                    .map((c) => (
                                      <Select.Option key={c.id} value={c.id}>
                                        <span className="mono" style={{ fontWeight: 600 }}>
                                          {c.id}
                                        </span>
                                        {c.app_name ? (
                                          <span style={{ color: "var(--mute)", marginLeft: 8, fontSize: 12 }}>
                                            {c.app_name} {c.version || ""}
                                          </span>
                                        ) : null}
                                      </Select.Option>
                                    ))}
                                </Select>
                              </div>
                            )}

                            {activeAgentClusters.length === 0 ? (
                              <p className="ec-scope-hint">
                                {isRevoked
                                  ? bi("该 Agent 已撤销授权，当前未关联任何集群。", "This Agent is revoked and has no bound clusters.")
                                  : canManage
                                    ? bi(
                                        "尚未关联任何集群；请在上方下拉框中手动选择需要使用此目标机 Agent 的集群。",
                                        "No clusters bound yet; select the cluster(s) above to authorize this Agent.",
                                      )
                                    : bi("尚未关联任何集群。", "No clusters bound yet.")}
                              </p>
                            ) : (
                              <div className="ec-cluster-grid">
                                {activeAgentClusters.map((cid) => {
                                  const meta = clusterById.get(cid);
                                  return (
                                    <div key={cid} className="ec-cluster-card is-bound-item">
                                      <button
                                        type="button"
                                        className="ec-cluster-card-nav"
                                        onClick={() =>
                                          go({ name: "deliveries", id: cid, tab: "automation" })
                                        }
                                      >
                                        <span className="ec-cluster-ic" aria-hidden>
                                          <IconStorage />
                                        </span>
                                        <div className="ec-cluster-card-txt">
                                          <b className="mono">{cid}</b>
                                          <small>
                                            {meta?.app_name
                                              ? `${meta.app_name} ${meta.version || ""} · ${bi("打开自动化", "Automation")}`
                                              : bi("打开集群自动化与演练", "Open cluster automation")}
                                          </small>
                                        </div>
                                        <IconRight className="ec-cluster-card-arrow" />
                                      </button>
                                      {canManage && !isRevoked && (
                                        <Tooltip
                                          content={bi(`解除与集群 ${cid} 的关联`, `Unbind ${cid}`)}
                                          mini
                                        >
                                          <button
                                            type="button"
                                            className="ec-cluster-unbind"
                                            disabled={updatingAgent === activeAgent.id}
                                            onClick={() =>
                                              void updateGlobalAgent(activeAgent, {
                                                action: "update",
                                                remove_cluster: cid,
                                              })
                                            }
                                            aria-label={bi(`解除关联 ${cid}`, `Unbind ${cid}`)}
                                          >
                                            <IconClose />
                                          </button>
                                        </Tooltip>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      </section>

                      {!isRevoked && !activeAgent.online && (
                        <div className="ec-diag-bar">
                          <span>
                            {bi(
                              "目标机 Agent 暂未上线？检查 systemd 服务状态、HTTPS 连通性或让 AI 快速排查。",
                              "Target Agent offline? Inspect systemd status, HTTPS reachability, or ask AI to troubleshoot.",
                            )}
                          </span>
                          <AIHelpButton
                            variant="pill"
                            topic={`target-agent-offline-${activeAgent.id}`}
                            title={bi(`排查目标机「${activeAgent.host}」Agent 未上线`, `Troubleshoot "${activeAgent.host}"`)}
                            page={bi("执行中心 · 目标机 Agent", "Execution Center · Target Agent")}
                            summary={bi(
                              `目标机 ${activeAgent.host} (${activeAgent.ip})，Agent ID=${activeAgent.id}，上次心跳=${activeAgent.last_seen || "无"}`,
                              `Target ${activeAgent.host} (${activeAgent.ip}), ID=${activeAgent.id}, lastSeen=${activeAgent.last_seen || "none"}`,
                            )}
                            prompt={bi(
                              `目标机直连 Agent「${activeAgent.host}」(${activeAgent.ip}) 当前未上线，服务名为 ${agentSvc}，请给出最快排查日志和网络连通的命令。`,
                              `Direct Target Agent "${activeAgent.host}" (${activeAgent.ip}, service ${agentSvc}) is offline. Give the fastest diagnostic commands.`,
                            )}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              );
            })()
          ) : (
            <div className="detail-none enter">
              <IconLink style={{ fontSize: 28, color: "var(--faint)" }} />
              <h2>
                {all.length === 0 && allAgents.length === 0
                  ? bi("接入第一台 Agent", "Connect Your First Agent")
                  : bi("没有符合筛选条件的 Agent", "No Matching Agents")}
              </h2>
              <p>
                {all.length === 0 && allAgents.length === 0
                  ? bi(
                      "先在此处把需要连接的主机接入平台（支持控制机 SSH/Ansible 或目标机免密直连），后续在任意集群中可直接选用或按 IP 自动匹配。",
                      "Enroll your control or target hosts here first; any cluster can then bind a controller or auto-match target Agents by IP.",
                    )
                  : bi("调整左侧搜索、状态或角色筛选条件以查看其他 Agent。", "Adjust the search, status, or role filter to view other Agents.")}
              </p>
              {all.length === 0 && allAgents.length === 0 ? (
                <div className="ec-row-acts">
                  {canManage && (
                    <>
                      <Button
                        type="primary"
                        icon={<IconPlus />}
                        onClick={() => begin("target")}
                      >
                        {bi("接入目标机 Agent", "Add Target Agent")}
                      </Button>
                      <Button
                        type="outline"
                        icon={<IconDesktop />}
                        onClick={() => begin("controller")}
                      >
                        {bi("接入控制机 Agent", "Add Control Agent")}
                      </Button>
                    </>
                  )}
                </div>
              ) : (
                <Button onClick={resetAllFilters}>
                  {bi("清除筛选", "Clear Filters")}
                </Button>
              )}
            </div>
          )}
        </section>
      )}
      </div>
      <Modal
        className="exec-modal en-modal"
        title={
          activeStep2
            ? targetRegistration
              ? bi("安装并连接目标机 Agent", "Install & Connect Target Agent")
              : bi("安装并连接控制机 Agent", "Install & Connect Control Agent")
            : bi("接入 Agent", "Add Agent")
        }
        visible={open}
        style={{ width: 680, maxWidth: "calc(100vw - 32px)" }}
        maskClosable={false}
        focusLock={false}
        onCancel={() => !busy && !bundling && setOpen(false)}
        footer={
          activeStep2 ? (
            <>
              <span className="en-footer-note">
                {activeStep2Online ? (
                  <>
                    <IconCheck />{" "}
                    {bi("Agent 已在线，可以关闭窗口或继续接入下一台", "Agent is online—close or enroll next host")}
                  </>
                ) : downloaded ? (
                  <>
                    <IconCheck />{" "}
                    {bi("安装包已下载（含专属凭据）", "Installer bundle downloaded")}
                  </>
                ) : (
                  bi(
                    "先下载安装包或复制配置，再完成接入",
                    "Download the installer bundle or copy config before finishing",
                  )
                )}
              </span>
              <div className="ec-row-acts">
                {targetRegistration && (
                  <Button onClick={enrollNextTarget}>
                    {bi("继续接入下一台", "Add Next Host")}
                  </Button>
                )}
                <Button
                  type="primary"
                  disabled={!downloaded && !activeStep2Online}
                  onClick={finish}
                >
                  {bi("完成", "Done")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={() => setOpen(false)}>
                {bi("取消", "Cancel")}
              </Button>
              <Button
                type="primary"
                loading={busy}
                disabled={
                  enrollRole === "target"
                    ? !targetHost.trim() || !targetIP.trim()
                    : !name.trim() || !controller.trim()
                }
                onClick={create}
              >
                {bi("下一步：安装并连接", "Next: Install & Connect")}
              </Button>
            </>
          )
        }
      >
        <div className="en-setup-steps">
          <span className={activeStep2 ? "done" : "current"}>
            <i>{activeStep2 ? <IconCheck /> : 1}</i>
            {bi("选择角色并登记主机", "Choose Role & Host")}
          </span>
          <span aria-hidden className="en-setup-line" />
          <span
            className={
              activeStep2Online ? "done" : activeStep2 ? "current" : ""
            }
          >
            <i>{activeStep2Online ? <IconCheck /> : 2}</i>
            {bi("安装并连接", "Install & Connect")}
          </span>
        </div>
        {!activeStep2 ? (
          <div className="en-form">
            <div className="en-field en-field-wide">
              <span className="en-field-label" id="en-role-label">
                {bi("Agent 角色", "Agent Role")}
              </span>
              <div
                className="en-kind-options"
                role="radiogroup"
                aria-labelledby="en-role-label"
              >
                {(
                  [
                    {
                      value: "controller" as const,
                      title: bi("控制机 Agent（SSH / Ansible）", "Control Agent (SSH / Ansible)"),
                      desc: bi(
                        "装在 1 台管理/跳板机上，通过 SSH 或 Ansible 统一调度多台业务主机与交付任务",
                        "Install on 1 control/bastion host to orchestrate multiple hosts via SSH or Ansible",
                      ),
                    },
                    {
                      value: "target" as const,
                      title: bi("目标机 Agent（免密直连）", "Target Agent (Direct HTTPS)"),
                      desc: bi(
                        "直接装在业务目标机上（主动外连 HTTPS，每 5s 实时探针心跳），无需 SSH 密码，由您自由选择关联集群",
                        "Install on target host (outbound HTTPS, 5s live probe heartbeat, no SSH). Explicitly choose bound clusters",
                      ),
                    },
                  ] as const
                ).map((o) => {
                  const on = enrollRole === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={`en-kind-option${on ? " on" : ""}`}
                      onClick={() => {
                        setEnrollRole(o.value);
                        setCreateError("");
                      }}
                    >
                      <i aria-hidden="true" />
                      <span>
                        <b>{o.title}</b>
                        <small>{o.desc}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {createError && (
              <div className="en-error" role="alert">
                <IconExclamationCircle />
                <span>{createError}</span>
                <AIHelpButton
                  variant="pill"
                  topic="execution-node-register-error"
                  title={bi("登记 Agent 失败", "Agent registration error")}
                  page={bi("接入 Agent", "Add Agent")}
                  error={createError}
                  prompt={bi(
                    `接入 Agent 时报错：${createError}，请告诉我哪里填错了以及该怎么填。`,
                    `Got error registering an Agent: ${createError}. How do I fix it?`,
                  )}
                />
              </div>
            )}

            {enrollRole === "target" ? (
              <div className="en-form-grid">
                <div className="en-field">
                  <label htmlFor="en-target-host">{bi("目标主机名称", "Target Hostname")}</label>
                  <Input
                    id="en-target-host"
                    value={targetHost}
                    onChange={setTargetHost}
                    placeholder={bi("例如：pg-node-01 或 业务库 A", "e.g., pg-node-01")}
                    autoFocus
                  />
                  <small>
                    {bi(
                      "用于在 Agent 列表与演练日志中识别这台主机",
                      "Displayed in Agent inventory and execution logs",
                    )}
                  </small>
                </div>
                <div className="en-field">
                  <label htmlFor="en-target-ip">{bi("目标主机 IP", "Target Host IP")}</label>
                  <Input
                    id="en-target-ip"
                    value={targetIP}
                    onChange={setTargetIP}
                    placeholder={bi("例如：10.0.1.11", "e.g., 10.0.1.11")}
                  />
                  <small>
                    {bi(
                      "需与目标机实际网卡 IP 一致，接入时将核验本机网卡地址",
                      "Must match an active network interface IP on the target host",
                    )}
                  </small>
                </div>
                <div className="en-field en-field-wide">
                  <label>{bi("关联授权集群（可选，支持多选）", "Authorized Clusters (Optional, Multi-Select)")}</label>
                  <Select
                    mode="multiple"
                    allowClear
                    showSearch
                    value={targetClusters}
                    onChange={(vals) => setTargetClusters(vals as string[])}
                    placeholder={bi(
                      "选择允许使用该目标机 Agent 的集群（可留空，接入后随时在详情页添加）",
                      "Select cluster(s) authorized to use this Agent (optional; editable anytime)",
                    )}
                    filterOption={(inputValue, option) => {
                      const q = inputValue.trim().toLowerCase();
                      if (!q) return true;
                      const val = String((option as { props?: { value?: string } })?.props?.value || "").toLowerCase();
                      const meta = clusterById.get(val);
                      return val.includes(q) || (meta?.app_name || "").toLowerCase().includes(q);
                    }}
                  >
                    {clusters.map((c) => (
                      <Select.Option key={c.id} value={c.id}>
                        <span className="mono" style={{ fontWeight: 600 }}>
                          {c.id}
                        </span>
                        {c.app_name ? (
                          <span style={{ color: "var(--mute)", marginLeft: 8, fontSize: 12 }}>
                            {c.app_name} {c.version || ""}
                          </span>
                        ) : null}
                      </Select.Option>
                    ))}
                  </Select>
                  <small>
                    {bi(
                      "仅被选中的集群可向该 Agent 下发只读探针与变更步骤，不再按 IP 自动跨集群匹配",
                      "Only explicitly selected clusters can dispatch tasks to this Agent",
                    )}
                  </small>
                </div>
                <div className="en-field en-field-wide">
                  <div className="ec-modal-switch-row">
                    <div>
                      <b>{bi("允许执行变更写操作", "Allow Mutating Steps")}</b>
                      <small>
                        {bi(
                          "关闭后该目标机仅放行 100% 只读基线与演练前探针；上线后也可随时在详情页切换。",
                          "When off, only 100% read-only probes are allowed; toggleable anytime after enrollment.",
                        )}
                      </small>
                    </div>
                    <Switch
                      size="small"
                      checked={targetAllowMutating}
                      onChange={setTargetAllowMutating}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="en-form-grid">
                <div className="en-field">
                  <label htmlFor="en-name">{bi("节点名称", "Node Name")}</label>
                  <Input
                    id="en-name"
                    value={name}
                    onChange={setName}
                    placeholder={bi(
                      "例如：pass-4 或 生产管理机",
                      "e.g., pass-4 or Prod Control Host",
                    )}
                    autoFocus
                  />
                  <small>
                    {bi(
                      "用于在交付与演练中识别这台主控机",
                      "Displayed when selecting a control host in deliveries and rehearsals",
                    )}
                  </small>
                </div>
                <div className="en-field">
                  <label htmlFor="en-controller">
                    {bi("执行机器 IP", "Control Host IP")}
                  </label>
                  <Input
                    id="en-controller"
                    value={controller}
                    onChange={setController}
                    placeholder={bi("例如：192.168.31.153", "e.g., 192.168.31.153")}
                  />
                  <small>
                    {bi(
                      "安装执行器的主控机 IP，不是数据库节点 IP",
                      "IP of the control host running the executor, not the database nodes",
                    )}
                  </small>
                </div>
                <div className="en-field en-field-wide">
                  <span className="en-field-label en-label-with-help" id="en-kind-label">
                    {bi("安装位置", "Deployment Placement")}
                    <AIHelpButton
                      topic="execution-node-placement"
                      title={bi("独立管理机 vs 集群内机器", "Dedicated vs In-Cluster Host")}
                      page={bi("接入执行节点 · 安装位置", "Add Execution Node · Placement")}
                      prompt={bi(
                        "接入执行节点时，「独立管理机」和「集群内机器」应该怎么选？各自有什么区别和注意事项？",
                        "Should I choose Dedicated Control Host or In-Cluster Host when enrolling an execution node? Explain the differences.",
                      )}
                      tooltip={bi("问 AI：这两种安装位置怎么选？", "Ask AI: Which placement should I choose?")}
                    />
                  </span>
                  <div
                    className="en-kind-options"
                    role="radiogroup"
                    aria-labelledby="en-kind-label"
                  >
                    {(
                      [
                        {
                          value: "independent",
                          title: bi("独立管理机", "Dedicated Control Host"),
                          desc: bi(
                            "不承载数据库，每集群独立目录，可复用管理多套集群",
                            "No workloads, isolated per-cluster directories, reusable across clusters",
                          ),
                        },
                        {
                          value: "embedded",
                          title: bi("集群内机器", "In-Cluster Host"),
                          desc: bi(
                            "没有额外管理机时，复用集群中 1 台机器兼任执行",
                            "Reuses one cluster node as the executor when no dedicated host is available",
                          ),
                        },
                      ] as const
                    ).map((o) => {
                      const on = kind === o.value;
                      return (
                        <button
                          key={o.value}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          tabIndex={on ? 0 : -1}
                          className={`en-kind-option${on ? " on" : ""}`}
                          onClick={() => setKind(o.value)}
                          onKeyDown={(e) => {
                            if (
                              [
                                "ArrowLeft",
                                "ArrowRight",
                                "ArrowUp",
                                "ArrowDown",
                              ].includes(e.key)
                            ) {
                              e.preventDefault();
                              const next =
                                o.value === "independent"
                                  ? "embedded"
                                  : "independent";
                              setKind(next);
                              (
                                e.currentTarget.parentElement?.querySelector(
                                  `[data-kind="${next}"]`,
                                ) as HTMLButtonElement | null
                              )?.focus();
                            }
                          }}
                          data-kind={o.value}
                        >
                          <i aria-hidden="true" />
                          <span>
                            <b>{o.title}</b>
                            <small>{o.desc}</small>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="en-connect">
            <div className="en-registration">
              <IconCheckCircle />
              <div>
                <b>
                  {registration
                    ? bi(
                        `${registration.node.name} 已登记`,
                        `${registration.node.name} Registered`,
                      )
                    : bi(
                        `${targetRegistration!.agent.host} 直连 Agent 已签发`,
                        `${targetRegistration!.agent.host} Direct Agent Ready`,
                      )}
                </b>
                <span>
                  {registration
                    ? biv(
                        <>
                          {registration.node.kind === "independent"
                            ? "独立管理机"
                            : "集群内机器"}{" "}
                          <code>{registration.node.controller_ip}</code> ·{" "}
                          目标机器授权将在交付或集群自动化中完成
                        </>,
                        <>
                          {registration.node.kind === "independent"
                            ? "Dedicated host"
                            : "In-cluster host"}{" "}
                          <code>{registration.node.controller_ip}</code> · Target
                          authorization is configured per delivery or cluster
                        </>,
                      )
                    : biv(
                        <>
                          目标机 <code>{targetRegistration!.agent.ip}</code> ·{" "}
                          {targetRegistration!.agent.clusters &&
                          targetRegistration!.agent.clusters.length > 0
                            ? `已授权关联 ${targetRegistration!.agent.clusters.join("、")}`
                            : "上线后将每 5s 实时上报心跳，可在详情页按需关联集群"}
                        </>,
                        <>
                          Target host <code>{targetRegistration!.agent.ip}</code> ·{" "}
                          {targetRegistration!.agent.clusters &&
                          targetRegistration!.agent.clusters.length > 0
                            ? `Bound to ${targetRegistration!.agent.clusters.join(", ")}`
                            : "Streams live heartbeats every 5s; bind clusters anytime"}
                        </>,
                      )}
                </span>
              </div>
            </div>

            <section>
              <div className="en-sec-head">
                <h3>
                  {registration
                    ? bi(
                        "1. 确认平台访问地址（供主控机回连）",
                        "1. Confirm Reachable Hub URL",
                      )
                    : bi(
                        "1. 确认平台访问地址（HTTPS，供目标机主动外连）",
                        "1. Confirm Reachable Hub URL (HTTPS)",
                      )}
                </h3>
                <AIHelpButton
                  topic="execution-node-hub-url"
                  title={bi("平台访问地址与 CA 证书", "Hub URL & CA Certificate")}
                  page={bi("安装并连接 Agent · 平台地址", "Install Agent · Hub URL")}
                  summary={bi(
                    `主机 ${registration ? registration.node.controller_ip : targetRegistration!.agent.ip}，当前所选平台地址 ${cleanHubUrl}，自签名TLS=${bootInfo?.tls_self_signed ? "是" : "否"}`,
                    `Host ${registration ? registration.node.controller_ip : targetRegistration!.agent.ip}, Hub URL ${cleanHubUrl}, self-signed=${bootInfo?.tls_self_signed}`,
                  )}
                  prompt={bi(
                    `我正在把 ${registration ? registration.node.name : targetRegistration!.agent.host} (${registration ? registration.node.controller_ip : targetRegistration!.agent.ip}) 接入平台，当前填的平台地址是 ${cleanHubUrl}。请帮我确认这个地址和 CA 证书设置有没有问题？`,
                    `I'm connecting ${registration ? registration.node.name : targetRegistration!.agent.host} to ${cleanHubUrl}. Please check if the URL and CA cert setup are valid.`,
                  )}
                  tooltip={bi("问 AI：这里该填什么地址？", "Ask AI: What URL should I enter here?")}
                />
              </div>
              <div className="en-url-picker">
                <Input
                  value={hubUrl}
                  onChange={setHubUrl}
                  placeholder="https://192.168.31.103:8443"
                  aria-label={bi("平台访问地址", "Hub URL")}
                />
                {bootInfo && bootInfo.suggested_urls.length > 0 && (
                  <div className="en-url-chips">
                    <span className="en-url-chips-label">
                      {bi("检测到本机地址：", "Detected addresses:")}
                    </span>
                    <div className="en-url-chip-list">
                      {bootInfo.suggested_urls.map((u) => (
                        <button
                          key={u}
                          type="button"
                          className={`en-url-chip${cleanHubUrl === u ? " on" : ""}`}
                          onClick={() => setHubUrl(u)}
                        >
                          {u}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {remoteTargetLoopbackWarn && (
                  <div className="en-inline-warn" role="alert">
                    <IconExclamationCircle />
                    <span>
                      {bi(
                        `127.0.0.1 / localhost 仅本机可达，远端主机 (${registration ? registration.node.controller_ip : targetRegistration!.agent.ip}) 无法连回平台。请改用上方局域网或公网地址。`,
                        `127.0.0.1 / localhost is only reachable locally—remote host (${registration ? registration.node.controller_ip : targetRegistration!.agent.ip}) cannot reach it. Select a LAN or public URL above.`,
                      )}
                    </span>
                  </div>
                )}
                {bootInfo?.ca_available && (
                  <div className="en-ca-toggle">
                    <Checkbox checked={includeCA} onChange={setIncludeCA}>
                      {bi(
                        "自动打包平台 CA 证书 (platform-ca.pem)",
                        "Include Hub CA certificate (platform-ca.pem)",
                      )}
                    </Checkbox>
                    {bootInfo.tls_self_signed && (
                      <span className="en-ca-tag">
                        {bi("自签名证书 · 推荐勾选", "Self-signed · Recommended")}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </section>

            <section>
              <div className="en-sec-head">
                <h3>
                  {registration
                    ? bi(
                        "2. 下载一键安装包并在主控机执行",
                        "2. Download Bundle & Install as Background Service",
                      )
                    : bi(
                        "2. 下载一键安装包并在目标机执行",
                        "2. Download Bundle & Install on Target Host",
                      )}
                </h3>
                <AIHelpButton
                  topic="execution-node-install-cmd"
                  title={bi("安装包与后台服务说明", "Installer Bundle & Background Service")}
                  page={bi("安装并连接 Agent · 一键安装", "Install Agent · One-Command Install")}
                  command={oneLineInstallCmd}
                  summary={bi(
                    `主机 ${registration ? registration.node.controller_ip : targetRegistration!.agent.ip}，安装包 ${bundleFile}`,
                    `Host ${registration ? registration.node.controller_ip : targetRegistration!.agent.ip}, bundle ${bundleFile}`,
                  )}
                  prompt={bi(
                    "这个 .tar.gz 一键安装包里面包含什么？install.sh 会对我的机器做哪些修改，后面怎么看日志或卸载？",
                    "What is inside the .tar.gz bundle, what does install.sh change on my host, and how do I view logs or uninstall it?",
                  )}
                  tooltip={bi("问 AI：安装包里面有什么？会改什么？", "Ask AI: What does install.sh do?")}
                />
              </div>
              <p>
                {registration
                  ? bi(
                      "安装包已内置 Linux x64 执行器、专属连接配置、CA 证书及 systemd 后台脚本，解压执行一行命令即完成安装、后台启动与连通自检。",
                      "Self-contained bundle with Linux x64 runner, unique credentials, CA cert, and systemd installer. Extract and run one command to install and start.",
                    )
                  : bi(
                      "安装包已内置 Linux x64 轻量 Agent、一次性接入令牌、CA 证书及 systemd 后台脚本，解压以 root 执行后自动外连上线（全程无需 SSH 密码）。",
                      "Self-contained bundle with lightweight Linux x64 Agent, one-time enrollment token, CA cert, and systemd installer—zero SSH passwords required.",
                    )}
              </p>
              {bundleError && (
                <div className="en-error" role="alert">
                  <IconExclamationCircle />
                  <span>{bundleError}</span>
                  <AIHelpButton
                    variant="pill"
                    topic="execution-node-bundle-error"
                    title={bi("生成安装包失败", "Bundle generation failed")}
                    page={bi("安装并连接 Agent", "Install & Connect Agent")}
                    error={bundleError}
                    prompt={bi(
                      `下载 Agent 一键安装包时报错：${bundleError}，请帮我排查原因。`,
                      `Downloading the Agent installer bundle failed: ${bundleError}. Help diagnose.`,
                    )}
                  />
                </div>
              )}
              <div className="en-downloads">
                <Button
                  type="primary"
                  icon={downloaded ? <IconCheck /> : <IconDownload />}
                  loading={bundling}
                  disabled={!cleanHubUrl}
                  onClick={downloadBundle}
                >
                  {downloaded
                    ? bi(`重新下载 ${bundleFile}`, `Re-download ${bundleFile}`)
                    : bi("下载一键安装包 (.tar.gz)", "Download Installer Bundle (.tar.gz)")}
                </Button>
                {targetRegistration && (
                  <Button
                    type="outline"
                    icon={<IconCopy />}
                    onClick={() => {
                      void copy(
                        targetConfigJSON,
                        bi("已复制 target-agent.json 配置", "Copied target-agent.json"),
                      );
                      setDownloaded(true);
                    }}
                  >
                    {bi("复制配置文件 JSON", "Copy Config JSON")}
                  </Button>
                )}
              </div>
              <Command
                title={bi(
                  `上传到 ${registration ? registration.node.controller_ip : targetRegistration!.agent.ip} 后执行（自动后台运行）`,
                  `Run on ${registration ? registration.node.controller_ip : targetRegistration!.agent.ip} (runs in background via systemd)`,
                )}
              >
                {oneLineInstallCmd}
              </Command>
              <details className="en-advanced-files">
                <summary>
                  {bi("高级：单独下载各文件", "Advanced: download individual files")}
                </summary>
                <div className="en-downloads">
                  <Button
                    size="small"
                    href={withLang("/api/settings/execution-nodes/binary")}
                    icon={<IconDownload />}
                  >
                    {bi("执行器 · Linux x64", "Runner · Linux x64")}
                  </Button>
                  <Button
                    size="small"
                    icon={<IconDownload />}
                    onClick={downloadConfigOnly}
                  >
                    {targetRegistration
                      ? bi("连接配置 (target-agent.json)", "Config (target-agent.json)")
                      : bi("连接配置 (execution-node.json)", "Config (execution-node.json)")}
                  </Button>
                  {bootInfo?.ca_available && (
                    <Button
                      size="small"
                      href={withLang("/api/settings/execution-nodes/ca.pem")}
                      icon={<IconDownload />}
                    >
                      {bi("平台 CA 证书 (platform-ca.pem)", "CA Cert (platform-ca.pem)")}
                    </Button>
                  )}
                </div>
              </details>
            </section>

            <div
              className={`en-connection ${activeStep2Online ? "connected" : ""}`}
            >
              <div className="en-connection-left">
                <span className="en-live-dot" />
                <b>
                  {activeStep2Online
                    ? registration
                      ? bi(
                          `控制机已连接${registeredNode?.version ? " · v" + registeredNode.version : ""}，可在集群交付或自动化中直接选用`,
                          `Connected${registeredNode?.version ? " · v" + registeredNode.version : ""}! Ready to bind in deliveries or cluster automation`,
                        )
                      : bi(
                          `目标机 Agent 已上线${registeredTarget?.version ? " · v" + registeredTarget.version : ""}，包含该 IP 的集群将自动匹配`,
                          `Target Agent online${registeredTarget?.version ? " · v" + registeredTarget.version : ""}! Matching clusters will detect it automatically`,
                        )
                    : bi(
                        "等待主机 Agent 连接上线… · 每 1.5 秒自动检测",
                        "Waiting for Agent to connect… · Checking every 1.5s",
                      )}
                </b>
              </div>
              {!activeStep2Online && (
                <AIHelpButton
                  variant="pill"
                  topic={`connect-help-${registration ? registration.node.id : targetRegistration!.agent.id}`}
                  title={bi("排查 Agent 连接问题", "Troubleshoot Agent Connection")}
                  page={bi("安装并连接 Agent · 等待连接", "Install & Connect Agent · Waiting")}
                  summary={bi(
                    `主机 ${registration ? registration.node.name : targetRegistration!.agent.host} (${registration ? registration.node.controller_ip : targetRegistration!.agent.ip})，配置地址 ${cleanHubUrl}，含CA=${includeCA}`,
                    `Host ${registration ? registration.node.name : targetRegistration!.agent.host} (${registration ? registration.node.controller_ip : targetRegistration!.agent.ip}), Hub URL ${cleanHubUrl}, includeCA=${includeCA}`,
                  )}
                  command={oneLineInstallCmd}
                  draft={bi(
                    `我在 ${registration ? registration.node.controller_ip : targetRegistration!.agent.ip} 上执行了安装命令，但页面一直显示等待连接。下面是终端输出：\n`,
                    `I ran the install command on ${registration ? registration.node.controller_ip : targetRegistration!.agent.ip} but it's still waiting to connect. Here is the terminal output:\n`,
                  )}
                  label={bi("启动报错？问 AI", "Stuck? Ask AI")}
                />
              )}
            </div>
          </div>
        )}
      </Modal>
      <Drawer
        title={bi("执行节点指南", "Execution Node Guide")}
        className="en-guide-drawer"
        visible={!!guide}
        width="min(660px, 100vw)"
        onCancel={() => setGuide(null)}
        footer={null}
        focusLock={false}
      >
        <Segmented<Guide>
          label={bi("指南内容", "Guide sections")}
          value={guide || "install"}
          onChange={setGuide}
          options={[
            { value: "install", label: bi("安装与接入", "Install & Connect") },
            {
              value: "maintain",
              label: bi("维护与恢复", "Maintenance & Recovery"),
            },
          ]}
        />
        {guide === "maintain" ? (
          <MaintenanceGuide />
        ) : (
          <InstallGuide bootInfo={bootInfo} />
        )}
      </Drawer>
    </>
  );
}

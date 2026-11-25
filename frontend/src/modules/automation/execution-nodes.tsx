import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Drawer,
  Input,
  Message,
  Modal,
  Popconfirm,
  Skeleton,
  Switch,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowRight,
  IconBook,
  IconCheck,
  IconCheckCircle,
  IconCommand,
  IconCopy,
  IconDelete,
  IconDesktop,
  IconDownload,
  IconExclamationCircle,
  IconInfoCircle,
  IconPlus,
  IconRefresh,
  IconRight,
  IconSafe,
  IconSearch,
  IconSettings,
  IconThunderbolt,
} from "@arco-design/web-react/icon";
import {
  ago,
  api,
  authToken,
  cached,
  can,
  copy,
  csrfToken,
  fullTime,
  putCached,
} from "../../shared/shared";
import { go } from "../../app/router";
import { Segmented } from "../../design/ui";
import { bi, biv, getLang, useLang, withLang } from "../../app/i18n";
import {
  AutomationAgentView,
  ExecutionNode,
  isExecutionNodeOnline,
  nodeConnection,
} from "./execution-types";
import { AIHelpButton } from "../ai/aichat";
import "./executions.css";
import "./execution-center.css";
import "./rehearsal-automation.css";

type Registration = { node: ExecutionNode; token: string };
type Guide = "install" | "maintain";
type Filter = "all" | "online" | "offline" | "upgrade" | "disabled";
type AgentFilter = "all" | "online" | "offline" | "revoked";
type FleetTab = "controllers" | "agents";

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

export function ExecutionNodes({
  initialFleet = "controllers",
  onFleetChange,
  onNodeStatsChange,
}: {
  initialFleet?: FleetTab;
  onFleetChange?: (fleet: FleetTab) => void;
  onNodeStatsChange?: (stats: { online: number; total: number }) => void;
} = {}) {
  useLang();
  const canManage = can("execution.manage");
  const [fleet, setFleet] = useState<FleetTab>(initialFleet);
  useEffect(() => {
    setFleet(initialFleet);
  }, [initialFleet]);

  const [nodes, setNodes] = useState<ExecutionNode[] | null>(
    () => cached<ExecutionNode[]>("/api/settings/execution-nodes") ?? null,
  );
  const [agents, setAgents] = useState<AutomationAgentView[] | null>(
    () => cached<AutomationAgentView[]>("/api/executions/agents") ?? null,
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
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [hubUrl, setHubUrl] = useState(() => location.origin);
  const [includeCA, setIncludeCA] = useState(true);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"independent" | "embedded">("independent");
  const [controller, setController] = useState("");
  const [createError, setCreateError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [agentQuery, setAgentQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
  const mounted = useRef(true);
  const busyLockRef = useRef(false);
  const bundleLockRef = useRef(false);
  const updatingLockRef = useRef("");
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
              onNodeStatsChange?.({
                online: result.filter(isExecutionNodeOnline).length,
                total: result.length,
              });
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
    await Promise.all(jobs);
    if (mounted.current) setRefreshing(false);
  };

  const updateGlobalAgent = async (
    ag: AutomationAgentView,
    payload: { action: "update" | "revoke"; allow_mutating?: boolean },
  ) => {
    if (updatingAgent) return;
    setUpdatingAgent(ag.id);
    try {
      await api("/api/executions/agents", {
        method: "PATCH",
        body: JSON.stringify({ id: ag.id, ...payload }),
      });
      await load();
      Message.success(
        payload.action === "revoke"
          ? bi(`已撤销目标机「${ag.host}」的 Agent 授权`, `Revoked agent on "${ag.host}"`)
          : bi(`已更新目标机「${ag.host}」写操作权限`, `Updated write permission for "${ag.host}"`),
      );
    } catch (e) {
      Message.error((e as Error).message);
    } finally {
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
  const registeredNode = all.find((n) => n.id === registration?.node.id);
  const registeredOnline = !!(
    registeredNode && isExecutionNodeOnline(registeredNode)
  );
  const fastPoll = !!(open && registration && !registeredOnline);

  useEffect(() => {
    mounted.current = true;
    void load();
    void loadBootInfo();
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const intervalMs = fastPoll ? 1500 : 10000;
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

  const begin = () => {
    if (!registration) {
      setName("");
      setKind("independent");
      setController("");
      setCreateError("");
      setBundleError("");
    }
    void loadBootInfo();
    setOpen(true);
  };

  const create = async () => {
    if (busyLockRef.current) return;
    busyLockRef.current = true;
    setBusy(true);
    setCreateError("");
    try {
      const result = await api<Registration>("/api/settings/execution-nodes", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          kind,
          controller_ip: controller.trim(),
        }),
      });
      setRegistration(result);
      setDownloaded(false);
      setBundleError("");
      void load();
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      busyLockRef.current = false;
      setBusy(false);
    }
  };

  const cleanHubUrl = hubUrl.trim().replace(/\/+$/, "");
  const remoteTargetLoopbackWarn = !!(
    registration &&
    isLoopbackURL(cleanHubUrl) &&
    !isLoopbackIP(registration.node.controller_ip)
  );

  const bundleDir = useMemo(() => {
    if (!registration) return "mw-runner-node";
    return `mw-runner-${runnerSlug(registration.node.name, registration.node.controller_ip)}`;
  }, [registration]);
  const bundleFile = `${bundleDir}.tar.gz`;
  const oneLineInstallCmd = `tar -xzf ${bundleFile}\nsudo bash ${bundleDir}/install.sh`;

  const downloadBundle = async () => {
    if (!registration || bundleLockRef.current) return;
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
      const res = await fetch("/api/settings/execution-nodes/bundle", {
        method: "POST",
        headers,
        credentials: "same-origin",
        body: JSON.stringify({
          node_id: registration.node.id,
          token: registration.token,
          url: cleanHubUrl,
          include_ca: includeCA && !!bootInfo?.ca_available,
        }),
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
      Message.success(
        bi(
          `已下载 ${bundleFile}，上传至 ${registration.node.controller_ip} 执行安装命令即可`,
          `Downloaded ${bundleFile}. Transfer to ${registration.node.controller_ip} and run install.sh.`,
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

  const counts = {
    all: all.length,
    online: all.filter(isExecutionNodeOnline).length,
    offline: all.filter((n) => !n.disabled && !isExecutionNodeOnline(n)).length,
    upgrade: all.filter(needsUpgrade).length,
    disabled: all.filter((n) => n.disabled).length,
  };
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((n) => {
      const matchFilter =
        filter === "all" ||
        (filter === "online"
          ? isExecutionNodeOnline(n)
          : filter === "disabled"
            ? n.disabled
            : filter === "upgrade"
              ? needsUpgrade(n)
              : !n.disabled && !isExecutionNodeOnline(n));
      if (!matchFilter) return false;
      if (!q) return true;
      return [n.name, n.controller_ip, ...n.clusters, ...n.ips].some((s) =>
        s.toLowerCase().includes(q),
      );
    });
  }, [all, filter, query]);

  const allAgents = agents || [];
  const agentCounts = {
    all: allAgents.length,
    online: allAgents.filter((a) => a.desired === "active" && a.online).length,
    offline: allAgents.filter((a) => a.desired === "active" && !a.online).length,
    revoked: allAgents.filter((a) => a.desired !== "active").length,
  };
  const agentRows = useMemo(() => {
    const q = agentQuery.trim().toLowerCase();
    return allAgents.filter((a) => {
      const matchFilter =
        agentFilter === "all" ||
        (agentFilter === "online"
          ? a.desired === "active" && a.online
          : agentFilter === "offline"
            ? a.desired === "active" && !a.online
            : a.desired !== "active");
      if (!matchFilter) return false;
      if (!q) return true;
      return [a.host, a.ip, a.cluster, a.mode || ""].some((s) =>
        s.toLowerCase().includes(q),
      );
    });
  }, [allAgents, agentFilter, agentQuery]);

  const detailNode = useMemo(
    () => (detailNodeId ? all.find((n) => n.id === detailNodeId) || null : null),
    [all, detailNodeId],
  );

  const switchFleet = (next: FleetTab) => {
    setFleet(next);
    onFleetChange?.(next);
  };

  const upgradeCmd = `# 1. 将新版执行器上传至控制机（点击上方按钮下载 Linux amd64 二进制）
sudo install -m 0755 middleware-store-linux-amd64 /usr/local/bin/middleware-store
sudo systemctl restart middleware-execution-node
sudo systemctl status middleware-execution-node --no-pager`;

  return (
    <article className="ec-nodes-page enter">
      <header className="ec-page-head">
        <div className="ec-page-title">
          <div className="ec-page-title-row">
            <h1>{bi("执行节点", "Execution Nodes")}</h1>
            <AIHelpButton
              topic="execution-nodes-overview"
              title={bi("执行节点与目标机 Agent 原理", "How Execution Nodes & Agents Work")}
              page={bi("执行中心 · 执行节点", "Execution Center · Nodes")}
              summary={bi(
                `控制机 ${all.length} 台（${counts.online} 台在线）；目标机 Agent ${allAgents.length} 个（${agentCounts.online} 个在线）`,
                `${all.length} control nodes (${counts.online} online); ${allAgents.length} target agents (${agentCounts.online} online)`,
              )}
              prompt={bi(
                "请用最直观的话告诉我：控制机执行节点和目标机直连 Agent 分别适合什么场景？如何一起配合管理集群自动化？",
                "Explain simply when to use Control Host Execution Nodes vs Direct Target Agents and how they work together.",
              )}
              tooltip={bi(
                "问 AI：控制机节点和目标机 Agent 怎么选？",
                "Ask AI: Control Nodes vs Target Agents",
              )}
            />
          </div>
          <p>
            {bi(
              "集中管理全平台控制机执行器与各集群目标机直连 Agent，支持按状态筛选、版本升级与细粒度能力授权。",
              "Manage all control-host runners and cluster target agents in one scalable view.",
            )}
          </p>
        </div>

        <div className="ec-head-acts">
          <Button
            size="small"
            icon={<IconRefresh />}
            loading={refreshing}
            onClick={() => void load(true)}
            aria-label={bi("刷新节点状态", "Refresh node status")}
          />
          <Button size="small" icon={<IconBook />} onClick={() => setGuide("install")}>
            {bi("接入与维护指南", "Setup & Maintenance")}
          </Button>
          {canManage && fleet === "controllers" && (
            <Button size="small" type="primary" icon={<IconPlus />} onClick={begin}>
              {registration
                ? bi("继续接入", "Continue Setup")
                : bi("接入执行节点", "Add Node")}
            </Button>
          )}
        </div>
      </header>

      {/* Fleet Switcher + Search Toolbar */}
      <div className="ec-toolbar-row">
        <Segmented<FleetTab>
          size="sm"
          label={bi("按节点类型切换", "Switch fleet type")}
          value={fleet}
          onChange={switchFleet}
          options={[
            {
              value: "controllers",
              label: bi("控制机节点", "Control Nodes"),
              count: counts.all,
            },
            {
              value: "agents",
              label: bi("目标机直连 Agent", "Direct Target Agents"),
              count: agentCounts.all,
            },
          ]}
        />
        <div className="ec-toolbar-right">
          {fleet === "controllers" ? (
            <Input
              size="small"
              className="ec-search-input"
              prefix={<IconSearch />}
              allowClear
              value={query}
              onChange={setQuery}
              placeholder={bi("搜索节点名、IP 或集群…", "Search node, IP, or cluster…")}
              aria-label={bi("搜索控制机节点", "Search control nodes")}
            />
          ) : (
            <Input
              size="small"
              className="ec-search-input"
              prefix={<IconSearch />}
              allowClear
              value={agentQuery}
              onChange={setAgentQuery}
              placeholder={bi("搜索主机名、IP 或所属集群…", "Search host, IP, or cluster…")}
              aria-label={bi("搜索目标机 Agent", "Search target agents")}
            />
          )}
        </div>
      </div>

      {/* ---- Sub-view 1: Control Host Nodes ---- */}
      {fleet === "controllers" && (
        <>
          {error && (
            <div className="en-error" role="alert">
              <IconExclamationCircle />
              <div>
                <b>{bi("节点状态未能更新", "Failed to refresh node status")}</b>
                <p>{error}</p>
              </div>
              <AIHelpButton
                variant="pill"
                topic="execution-nodes-load-error"
                title={bi("节点状态加载失败", "Failed to refresh nodes")}
                page={bi("执行中心 · 执行节点", "Execution Center · Nodes")}
                error={error}
                prompt={bi(
                  `执行节点页面刷新状态报错：${error}，请帮我分析原因和排查方式。`,
                  `Execution nodes page failed to load: ${error}. Help diagnose.`,
                )}
              />
              <Button size="small" onClick={() => void load(true)} loading={refreshing}>
                {bi("重试", "Retry")}
              </Button>
            </div>
          )}

          {registration && !open && (
            <div className="en-pending" role="status">
              <IconInfoCircle />
              <span>
                {biv(
                  <>
                    <b>{registration.node.name}</b>{" "}
                    已登记，继续下载安装包并在主控机完成连接。
                  </>,
                  <>
                    <b>{registration.node.name}</b> is registered—download the
                    installer bundle and finish connecting.
                  </>,
                )}
              </span>
              <Button size="small" type="text" onClick={() => setOpen(true)}>
                {bi("继续接入", "Continue Setup")} <IconArrowRight />
              </Button>
            </div>
          )}

          {!nodes && !error && (
            <div className="ec-table-card" style={{ padding: 18 }}>
              <Skeleton animation text={{ rows: 5 }} />
            </div>
          )}

          {nodes && !all.length && (
            <section className="en-empty" aria-labelledby="en-empty-title">
              <div className="en-intro">
                <span className="en-hero-icon">
                  <IconDesktop />
                </span>
                <h2 id="en-empty-title">
                  {bi("连接第一台控制机执行节点", "Connect Your First Control Node")}
                </h2>
                <p>
                  {bi(
                    "只需在 1 台主控机安装后台执行器，即可统一调度集群交付、只读探针与变更演练；若目标机无 SSH 免密，也可在各集群「自动化」页直接部署目标机直连 Agent。",
                    "Install one background runner on a control host to orchestrate deliveries, read-only probes, and rehearsals.",
                  )}
                </p>
                {canManage && (
                  <Button type="primary" icon={<IconPlus />} onClick={begin}>
                    {bi("接入执行节点", "Add Node")}
                  </Button>
                )}
              </div>
            </section>
          )}

          {nodes && !!all.length && (
            <>
              <div className="ec-kpi-strip" role="group" aria-label={bi("按节点状态筛选", "Filter nodes by status")}>
                <button
                  type="button"
                  className={`ec-kpi-chip ${filter === "all" ? "is-on" : ""}`}
                  onClick={() => setFilter("all")}
                >
                  <span>{bi("全部节点", "All")}</span>
                  <em>{counts.all}</em>
                </button>
                <button
                  type="button"
                  className={`ec-kpi-chip tone-ok ${filter === "online" ? "is-on" : ""}`}
                  onClick={() => setFilter("online")}
                >
                  <i />
                  <span>{bi("在线", "Online")}</span>
                  <em>{counts.online}</em>
                </button>
                <button
                  type="button"
                  className={`ec-kpi-chip tone-muted ${filter === "offline" ? "is-on" : ""}`}
                  onClick={() => setFilter("offline")}
                >
                  <i />
                  <span>{bi("离线 / 待连接", "Offline")}</span>
                  <em>{counts.offline}</em>
                </button>
                {counts.upgrade > 0 && (
                  <button
                    type="button"
                    className={`ec-kpi-chip tone-warn ${filter === "upgrade" ? "is-on" : ""}`}
                    onClick={() => setFilter("upgrade")}
                  >
                    <i />
                    <span>{bi("待升级", "Upgrade Needed")}</span>
                    <em>{counts.upgrade}</em>
                  </button>
                )}
                {counts.disabled > 0 && (
                  <button
                    type="button"
                    className={`ec-kpi-chip tone-muted ${filter === "disabled" ? "is-on" : ""}`}
                    onClick={() => setFilter("disabled")}
                  >
                    <i />
                    <span>{bi("已停用", "Paused")}</span>
                    <em>{counts.disabled}</em>
                  </button>
                )}
              </div>

              <div className="ec-table-card">
                {rows.length > 0 ? (
                  <div className="ec-table-scroll">
                    <table className="ec-table">
                      <thead>
                        <tr>
                          <th>{bi("节点名称与控制机地址", "Node & Control IP")}</th>
                          <th>{bi("版本与状态", "Version")}</th>
                          <th>{bi("授权范围", "Scope")}</th>
                          <th>{bi("已开启能力", "Capabilities")}</th>
                          <th>{bi("最近心跳", "Heartbeat")}</th>
                          <th className="is-right">{bi("操作", "Actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((node) => {
                          const status = nodeConnection(node);
                          const oldProto = needsUpgrade(node);
                          const scopeTip =
                            node.clusters.length || node.ips.length
                              ? [
                                  node.clusters.length
                                    ? `${bi("集群", "Clusters")}: ${node.clusters.join(", ")}`
                                    : "",
                                  node.ips.length
                                    ? `${bi("主机", "Hosts")}: ${node.ips.join(", ")}`
                                    : "",
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : undefined;
                          return (
                            <tr
                              key={node.id}
                              className="is-clickable"
                              onClick={() => setDetailNodeId(node.id)}
                            >
                              <td>
                                <div className="ec-node-cell">
                                  <span className={`ec-state-dot is-${status.key}`} />
                                  <div className="ec-node-name-stack">
                                    <div className="ec-node-name-top">
                                      <b>{node.name}</b>
                                      <span className="ec-kind-tag">
                                        {node.kind === "independent"
                                          ? bi("独立管理机", "Dedicated")
                                          : bi("集群内", "In-Cluster")}
                                      </span>
                                    </div>
                                    <div className="ec-node-sub">
                                      <code className="mono">{node.controller_ip}</code>
                                      <span>· {nodeStatusLabel(status.key, status.label)}</span>
                                    </div>
                                  </div>
                                </div>
                              </td>

                              <td>
                                <div className="ec-ver-cell">
                                  {oldProto ? (
                                    <Tooltip
                                      content={bi(
                                        "当前执行器为旧版，仅支持交付部署与只读探针；点击查看升级命令以支持变更演练自动执行",
                                        "Older runner version; upgrade to enable automated rehearsal steps",
                                      )}
                                    >
                                      <span className="ec-ver-pill is-upgrade">
                                        {bi("可升级", "Upgrade")}
                                      </span>
                                    </Tooltip>
                                  ) : (node.protocol || 0) >= 3 ? (
                                    <span className="ec-ver-pill is-ok mono">
                                      {node.version ? `v${node.version}` : bi("最新协议", "Ready")}
                                    </span>
                                  ) : (
                                    <span className="ec-ver-pill">
                                      {bi("待首次上线", "Pending")}
                                    </span>
                                  )}
                                  {oldProto && node.version && (
                                    <span className="ec-ver-sub mono">v{node.version}</span>
                                  )}
                                </div>
                              </td>

                              <td>
                                {node.clusters.length > 0 || node.ips.length > 0 ? (
                                  <Tooltip content={scopeTip}>
                                    <span className="ec-scope-pill num">
                                      {bi(
                                        `${node.clusters.length} 集群 · ${node.ips.length} 主机`,
                                        `${node.clusters.length} clusters · ${node.ips.length} hosts`,
                                      )}
                                    </span>
                                  </Tooltip>
                                ) : (
                                  <span className="ec-scope-pill is-empty">
                                    {bi("待交付/演练绑定", "Unbound")}
                                  </span>
                                )}
                              </td>

                              <td>
                                <div className="ec-cap-badges">
                                  <span
                                    className={`ec-cap-chip ${node.allow_delivery !== false ? "is-on" : ""}`}
                                  >
                                    {bi("交付", "Deploy")}
                                  </span>
                                  <span
                                    className={`ec-cap-chip ${node.allow_probe !== false ? "is-on" : ""}`}
                                  >
                                    {bi("探针", "Probe")}
                                  </span>
                                  <Tooltip
                                    content={
                                      oldProto
                                        ? bi("需先升级执行器版本后才可开启变更演练", "Upgrade runner to enable rehearsal steps")
                                        : node.allow_rehearsal
                                          ? bi("已授权执行变更演练步骤", "Authorized for rehearsal steps")
                                          : bi("未开启变更演练步骤执行（点击配置可开启）", "Rehearsal steps off (click Configure)")
                                    }
                                  >
                                    <span
                                      className={`ec-cap-chip ${
                                        oldProto
                                          ? "is-locked"
                                          : node.allow_rehearsal
                                            ? "is-on is-ok"
                                            : ""
                                      }`}
                                    >
                                      {bi("演练", "Rehearsal")}
                                    </span>
                                  </Tooltip>
                                </div>
                              </td>

                              <td>
                                {node.last_seen ? (
                                  <Tooltip content={fullTime(node.last_seen)}>
                                    <span className="ec-heartbeat">{ago(node.last_seen)}</span>
                                  </Tooltip>
                                ) : (
                                  <span className="ec-heartbeat">{bi("从未连接", "Never")}</span>
                                )}
                              </td>

                              <td
                                className="is-right"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="ec-row-acts">
                                  <Button
                                    size="mini"
                                    type="outline"
                                    icon={<IconSettings />}
                                    onClick={() => setDetailNodeId(node.id)}
                                  >
                                    {bi("配置", "Configure")}
                                  </Button>
                                  {canManage && (
                                    <>
                                      <Button
                                        size="mini"
                                        type="text"
                                        loading={updating === node.id}
                                        disabled={!!updating && updating !== node.id}
                                        onClick={() => void toggle(node)}
                                      >
                                        {node.disabled
                                          ? bi("恢复", "Resume")
                                          : bi("停用", "Pause")}
                                      </Button>
                                      <Tooltip content={bi("删除节点", "Delete node")}>
                                        <Button
                                          size="mini"
                                          type="text"
                                          status="danger"
                                          icon={<IconDelete />}
                                          disabled={!!updating}
                                          onClick={() => remove(node)}
                                          aria-label={bi(
                                            `删除执行节点 ${node.name}`,
                                            `Delete execution node ${node.name}`,
                                          )}
                                        />
                                      </Tooltip>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="ec-table-empty">
                    <IconSearch />
                    <b>{bi("没有符合条件的控制机节点", "No matching control nodes")}</b>
                    <Button
                      size="small"
                      type="text"
                      onClick={() => {
                        setQuery("");
                        setFilter("all");
                      }}
                    >
                      {bi("清除筛选", "Clear Filters")}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* ---- Sub-view 2: Global Direct Target Agents ---- */}
      {fleet === "agents" && (
        <>
          {agentsError && (
            <div className="en-error" role="alert">
              <IconExclamationCircle />
              <div>
                <b>{bi("目标机 Agent 列表加载失败", "Failed to load target agents")}</b>
                <p>{agentsError}</p>
              </div>
              <Button size="small" onClick={() => void load(true)} loading={refreshing}>
                {bi("重试", "Retry")}
              </Button>
            </div>
          )}

          {!agents && !agentsError && (
            <div className="ec-table-card" style={{ padding: 18 }}>
              <Skeleton animation text={{ rows: 5 }} />
            </div>
          )}

          {agents && (
            <>
              {allAgents.length > 0 && (
                <div className="ec-kpi-strip" role="group" aria-label={bi("按 Agent 状态筛选", "Filter agents by status")}>
                  <button
                    type="button"
                    className={`ec-kpi-chip ${agentFilter === "all" ? "is-on" : ""}`}
                    onClick={() => setAgentFilter("all")}
                  >
                    <span>{bi("全部 Agent", "All Agents")}</span>
                    <em>{agentCounts.all}</em>
                  </button>
                  <button
                    type="button"
                    className={`ec-kpi-chip tone-ok ${agentFilter === "online" ? "is-on" : ""}`}
                    onClick={() => setAgentFilter("online")}
                  >
                    <i />
                    <span>{bi("在线", "Online")}</span>
                    <em>{agentCounts.online}</em>
                  </button>
                  <button
                    type="button"
                    className={`ec-kpi-chip tone-warn ${agentFilter === "offline" ? "is-on" : ""}`}
                    onClick={() => setAgentFilter("offline")}
                  >
                    <i />
                    <span>{bi("离线 / 待启动", "Offline")}</span>
                    <em>{agentCounts.offline}</em>
                  </button>
                  {agentCounts.revoked > 0 && (
                    <button
                      type="button"
                      className={`ec-kpi-chip tone-muted ${agentFilter === "revoked" ? "is-on" : ""}`}
                      onClick={() => setAgentFilter("revoked")}
                    >
                      <i />
                      <span>{bi("已撤销", "Revoked")}</span>
                      <em>{agentCounts.revoked}</em>
                    </button>
                  )}
                </div>
              )}

              <div className="ec-table-card">
                {agentRows.length > 0 ? (
                  <div className="ec-table-scroll">
                    <table className="ec-table">
                      <thead>
                        <tr>
                          <th>{bi("目标主机与 IP", "Target Host & IP")}</th>
                          <th>{bi("所属集群", "Cluster")}</th>
                          <th>{bi("模式与状态", "Mode & Status")}</th>
                          <th>{bi("允许写操作", "Allow Mutate")}</th>
                          <th>{bi("最近心跳", "Heartbeat")}</th>
                          <th className="is-right">{bi("操作", "Actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agentRows.map((ag) => {
                          const isRevoked = ag.desired !== "active";
                          const dotCls = isRevoked
                            ? "is-revoked"
                            : ag.online
                              ? "is-online"
                              : "is-offline";
                          return (
                            <tr key={ag.id}>
                              <td>
                                <div className="ec-node-cell">
                                  <span className={`ec-state-dot ${dotCls}`} />
                                  <div className="ec-node-name-stack">
                                    <div className="ec-node-name-top">
                                      <b>{ag.host}</b>
                                    </div>
                                    <div className="ec-node-sub">
                                      <code className="mono">{ag.ip}</code>
                                      {ag.version && <span>· v{ag.version}</span>}
                                    </div>
                                  </div>
                                </div>
                              </td>

                              <td>
                                <button
                                  type="button"
                                  className="ec-cluster-link mono"
                                  onClick={() =>
                                    go({ name: "deliveries", id: ag.cluster, tab: "automation" })
                                  }
                                >
                                  <span>{ag.cluster}</span>
                                  <IconRight />
                                </button>
                              </td>

                              <td>
                                <div className="ec-ver-cell">
                                  <span
                                    className={`ec-kind-tag ${ag.mode === "direct" ? "is-brand" : ""}`}
                                  >
                                    {ag.mode === "direct"
                                      ? bi("直连执行模式", "Direct Exec")
                                      : bi("托管 SSH 信任", "SSH Trust")}
                                  </span>
                                  <span className="ec-ver-sub">
                                    {isRevoked
                                      ? bi("已撤销授权", "Revoked")
                                      : ag.online
                                        ? bi("在线运行中", "Online")
                                        : bi("等待主机启动 Agent", "Waiting for daemon")}
                                  </span>
                                </div>
                              </td>

                              <td>
                                <Tooltip
                                  content={bi(
                                    "关闭后该 Agent 仅放行 100% 只读探针，拒绝任何写操作命令",
                                    "When off, only 100% read-only probes are permitted",
                                  )}
                                >
                                  <Switch
                                    size="small"
                                    checked={Boolean(ag.allow_mutating)}
                                    loading={updatingAgent === ag.id}
                                    disabled={!canManage || isRevoked}
                                    onChange={(v) =>
                                      void updateGlobalAgent(ag, {
                                        action: "update",
                                        allow_mutating: v,
                                      })
                                    }
                                  />
                                </Tooltip>
                              </td>

                              <td>
                                {ag.last_seen ? (
                                  <Tooltip content={fullTime(ag.last_seen)}>
                                    <span className="ec-heartbeat">{ago(ag.last_seen)}</span>
                                  </Tooltip>
                                ) : (
                                  <span className="ec-heartbeat">{bi("尚未上线", "Never")}</span>
                                )}
                              </td>

                              <td className="is-right">
                                <div className="ec-row-acts">
                                  <Button
                                    size="mini"
                                    type="text"
                                    onClick={() =>
                                      go({ name: "deliveries", id: ag.cluster, tab: "automation" })
                                    }
                                  >
                                    {bi("集群自动化", "Cluster")}
                                  </Button>
                                  {canManage && !isRevoked && (
                                    <Popconfirm
                                      title={bi(
                                        `确定撤销 ${ag.host} (${ag.ip}) 的直连 Agent 授权？`,
                                        `Revoke agent on ${ag.host} (${ag.ip})?`,
                                      )}
                                      okText={bi("撤销", "Revoke")}
                                      cancelText={bi("取消", "Cancel")}
                                      onOk={() =>
                                        void updateGlobalAgent(ag, { action: "revoke" })
                                      }
                                    >
                                      <Button
                                        size="mini"
                                        type="text"
                                        status="danger"
                                        loading={updatingAgent === ag.id}
                                      >
                                        {bi("撤销", "Revoke")}
                                      </Button>
                                    </Popconfirm>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="ec-table-empty">
                    <IconThunderbolt />
                    <b>
                      {allAgents.length === 0
                        ? bi("暂无已接入的目标机直连 Agent", "No Target Agents Enrolled Yet")
                        : bi("没有符合条件的目标机 Agent", "No matching target agents")}
                    </b>
                    <p>
                      {allAgents.length === 0
                        ? bi(
                            "当集群无 SSH 免密或无独立控制机时，进入任意集群的「自动化」标签页选择「方式 B · 目标机直连 Agent」即可签发一键安装包，上线后会统一汇总在此管理。",
                            "Enroll passwordless outbound Target Agents inside any cluster's Automation tab; all enrolled agents appear here automatically.",
                          )
                        : bi("试试调整筛选条件或清空搜索关键词。", "Try clearing your filter or search query.")}
                    </p>
                    {allAgents.length > 0 ? (
                      <Button
                        size="small"
                        type="text"
                        onClick={() => {
                          setAgentQuery("");
                          setAgentFilter("all");
                        }}
                      >
                        {bi("清除筛选", "Clear Filters")}
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        type="outline"
                        onClick={() => go({ name: "deliveries" })}
                      >
                        {bi("前往集群列表", "Open Clusters")} <IconArrowRight />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* ---- Node Detail & Permissions Slide-Over Drawer ---- */}
      <Drawer
        visible={Boolean(detailNode)}
        width="min(560px, 94vw)"
        unmountOnExit
        title={
          detailNode ? (
            <div className="ec-detail-hero-top">
              <IconDesktop />
              <span>{detailNode.name}</span>
              <span className="ec-kind-tag">
                {detailNode.kind === "independent"
                  ? bi("独立管理机", "Dedicated")
                  : bi("集群内执行机", "In-Cluster")}
              </span>
            </div>
          ) : null
        }
        onCancel={() => setDetailNodeId(null)}
        footer={
          detailNode && (
            <div className="ec-detail-danger" style={{ borderTop: 0, paddingTop: 0 }}>
              {canManage ? (
                <div className="ec-row-acts">
                  <Button
                    size="small"
                    loading={updating === detailNode.id}
                    onClick={() => void toggle(detailNode)}
                  >
                    {detailNode.disabled
                      ? bi("恢复领取任务", "Resume Claims")
                      : bi("暂停领取新任务", "Pause Claims")}
                  </Button>
                  <Button
                    size="small"
                    status="danger"
                    type="outline"
                    icon={<IconDelete />}
                    disabled={!!updating}
                    onClick={() => {
                      const target = detailNode;
                      setDetailNodeId(null);
                      remove(target);
                    }}
                  >
                    {bi("删除节点", "Delete Node")}
                  </Button>
                </div>
              ) : (
                <span />
              )}
              <Button size="small" onClick={() => setDetailNodeId(null)}>
                {bi("关闭", "Close")}
              </Button>
            </div>
          )
        }
      >
        {detailNode &&
          (() => {
            const st = nodeConnection(detailNode);
            const oldProto = needsUpgrade(detailNode);
            return (
              <div className="ec-detail-body">
                <div className="ec-detail-hero">
                  <div className="ec-detail-hero-l">
                    <div className="ec-detail-hero-top">
                      <span className={`ec-state-dot is-${st.key}`} />
                      <b>{nodeStatusLabel(st.key, st.label)}</b>
                      {oldProto ? (
                        <span className="ec-ver-pill is-upgrade">
                          {bi("有新版本可升级", "Upgrade Available")}
                        </span>
                      ) : (detailNode.protocol || 0) >= 3 ? (
                        <span className="ec-ver-pill is-ok">
                          {bi("支持完整自动化能力", "Full Automation Ready")}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {(st.key === "offline" || st.key === "waiting") && (
                    <AIHelpButton
                      variant="pill"
                      topic={`node-offline-${detailNode.id}`}
                      title={bi(`排查节点「${detailNode.name}」未连接`, `Troubleshoot "${detailNode.name}"`)}
                      page={bi("执行中心 · 执行节点", "Execution Center · Nodes")}
                      summary={bi(
                        `节点 ${detailNode.name} (${detailNode.controller_ip})，位置=${detailNode.kind}，状态=${st.key}`,
                        `Node ${detailNode.name} (${detailNode.controller_ip}), kind=${detailNode.kind}, state=${st.key}`,
                      )}
                      prompt={bi(
                        `执行节点「${detailNode.name}」(${detailNode.controller_ip}) 当前状态为「${nodeStatusLabel(st.key, st.label)}」，请帮我列出最快定位原因的检查命令和常见坑（平台地址、CA 证书、systemd 服务）。`,
                        `Execution node "${detailNode.name}" (${detailNode.controller_ip}) is ${st.key}. Give the quickest diagnostic commands.`,
                      )}
                    />
                  )}
                </div>

                <div className="ec-detail-meta">
                  <div className="ec-detail-kv">
                    <span>{bi("控制机 IP", "Control IP")}</span>
                    <code className="mono">{detailNode.controller_ip}</code>
                  </div>
                  <div className="ec-detail-kv">
                    <span>{bi("执行器版本", "Runner Version")}</span>
                    <b className="mono">
                      {detailNode.version ? `v${detailNode.version}` : bi("待首次上报", "Pending")}
                    </b>
                  </div>
                  <div className="ec-detail-kv">
                    <span>{bi("最近心跳", "Last Heartbeat")}</span>
                    <b>
                      {detailNode.last_seen
                        ? fullTime(detailNode.last_seen)
                        : bi("从未连接", "Never")}
                    </b>
                  </div>
                  <div className="ec-detail-kv">
                    <span>{bi("节点标识", "Node ID")}</span>
                    <code className="mono">{detailNode.id}</code>
                  </div>
                </div>

                {oldProto && (
                  <div className="ec-upgrade-box">
                    <div className="ec-upgrade-head">
                      <div>
                        <b>{bi("升级此节点以解锁变更演练自动执行", "Upgrade Runner for Rehearsal Automation")}</b>
                        <p>
                          {bi(
                            "当前节点运行旧版执行器，暂不支持变更演练实时流式执行；替换为最新版二进制并重启服务即可平滑升级（无需重新登记凭据）。",
                            "This node runs an older binary; replace the binary and restart the systemd service to enable live rehearsal execution without re-enrolling.",
                          )}
                        </p>
                      </div>
                      <div className="ec-row-acts">
                        <Button
                          size="mini"
                          type="primary"
                          icon={<IconDownload />}
                          href={withLang("/api/settings/execution-nodes/binary")}
                        >
                          {bi("下载新版二进制", "Download Binary")}
                        </Button>
                        <Button
                          size="mini"
                          type="outline"
                          icon={<IconCopy />}
                          onClick={() => {
                            copy(upgradeCmd);
                            Message.success(bi("已复制升级命令", "Upgrade commands copied"));
                          }}
                        >
                          {bi("复制命令", "Copy")}
                        </Button>
                      </div>
                    </div>
                    <pre className="ec-upgrade-cmd mono">{upgradeCmd}</pre>
                  </div>
                )}

                <div className="ec-detail-sec">
                  <h4>{bi("能力授权", "Capability Permissions")}</h4>
                  <div className="ec-cap-list">
                    <div className="ec-cap-row">
                      <div className="ec-cap-row-l">
                        <b>{bi("首次交付部署", "Delivery Runs")}</b>
                        <p>
                          {bi(
                            "允许承接集群首次部署、扩缩容及配置交付的 Ansible 执行批次。",
                            "Allow claiming initial deployment, scaling, and config delivery runs.",
                          )}
                        </p>
                      </div>
                      <Switch
                        size="small"
                        checked={detailNode.allow_delivery !== false}
                        loading={updating === detailNode.id}
                        disabled={!canManage || updating === detailNode.id}
                        onChange={(v) => void updateNodeCap(detailNode, { allow_delivery: v })}
                      />
                    </div>

                    <div className="ec-cap-row">
                      <div className="ec-cap-row-l">
                        <b>{bi("只读探针采集", "Read-Only Probes")}</b>
                        <p>
                          {bi(
                            "允许自动下发 100% 只读基线与变更前状态探针（经静态安全门禁校验）。",
                            "Allow dispatching 100% read-only baseline and pre-change probe scripts.",
                          )}
                        </p>
                      </div>
                      <Switch
                        size="small"
                        checked={detailNode.allow_probe !== false}
                        loading={updating === detailNode.id}
                        disabled={!canManage || updating === detailNode.id}
                        onChange={(v) => void updateNodeCap(detailNode, { allow_probe: v })}
                      />
                    </div>

                    <div className="ec-cap-row">
                      <div className="ec-cap-row-l">
                        <b>{bi("变更演练步骤执行", "Rehearsal Step Execution")}</b>
                        <p>
                          {bi(
                            "允许在变更演练工作台执行变更写操作与回滚步骤（仍受集群生产门禁约束）。",
                            "Allow executing mutating and rollback steps during rehearsals (subject to cluster prod gates).",
                          )}
                        </p>
                        {oldProto && (
                          <span className="ec-cap-row-warn">
                            {bi("请先在上方升级节点执行器版本后再开启", "Upgrade the runner binary above before enabling")}
                          </span>
                        )}
                      </div>
                      <Switch
                        size="small"
                        checked={Boolean(detailNode.allow_rehearsal)}
                        loading={updating === detailNode.id}
                        disabled={!canManage || oldProto || updating === detailNode.id}
                        onChange={(v) => void updateNodeCap(detailNode, { allow_rehearsal: v })}
                      />
                    </div>
                  </div>
                </div>

                <div className="ec-detail-sec">
                  <h4>
                    {bi(
                      `授权集群 (${detailNode.clusters.length}) 与目标主机 (${detailNode.ips.length})`,
                      `Authorized Clusters (${detailNode.clusters.length}) & Hosts (${detailNode.ips.length})`,
                    )}
                  </h4>
                  <div className="ec-scope-box">
                    <div className="ec-chip-wrap">
                      {detailNode.clusters.length === 0 ? (
                        <span className="ec-ver-sub">
                          {bi("尚未绑定集群，可在交付或集群「自动化」页授权绑定。", "No clusters bound yet; authorize in delivery or Cluster → Automation.")}
                        </span>
                      ) : (
                        detailNode.clusters.map((cid) => (
                          <button
                            key={cid}
                            type="button"
                            className="ec-cluster-link mono"
                            onClick={() => {
                              setDetailNodeId(null);
                              go({ name: "deliveries", id: cid, tab: "automation" });
                            }}
                          >
                            <span>{cid}</span>
                            <IconRight />
                          </button>
                        ))
                      )}
                    </div>
                    {detailNode.ips.length > 0 && (
                      <div className="ec-chip-wrap">
                        {detailNode.ips.map((ip) => (
                          <span key={ip} className="ec-ip-chip mono">
                            {ip}
                            {ip === detailNode.controller_ip && (
                              <small>{bi("控制", "Ctrl")}</small>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}
      </Drawer>
      <Modal
        className="exec-modal en-modal"
        title={
          registration
            ? bi("安装并连接节点", "Install & Connect Node")
            : bi("接入执行节点", "Add Execution Node")
        }
        visible={open}
        style={{ width: 680, maxWidth: "calc(100vw - 32px)" }}
        maskClosable={false}
        focusLock={false}
        onCancel={() => !busy && !bundling && setOpen(false)}
        footer={
          registration ? (
            <>
              <span className="en-footer-note">
                {registeredOnline ? (
                  <>
                    <IconCheck />{" "}
                    {bi("节点已在线，可以关闭此窗口", "Node is online—you can close this window")}
                  </>
                ) : downloaded ? (
                  <>
                    <IconCheck />{" "}
                    {bi("安装包已下载（含专属凭据）", "Installer bundle downloaded")}
                  </>
                ) : (
                  bi(
                    "先下载安装包或连接配置，再完成接入",
                    "Download the installer bundle or config before finishing",
                  )
                )}
              </span>
              <Button
                type="primary"
                disabled={!downloaded && !registeredOnline}
                onClick={finish}
              >
                {bi("完成", "Done")}
              </Button>
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={() => setOpen(false)}>
                {bi("取消", "Cancel")}
              </Button>
              <Button
                type="primary"
                loading={busy}
                disabled={!name.trim() || !controller.trim()}
                onClick={create}
              >
                {bi("下一步：安装并连接", "Next: Install & Connect")}
              </Button>
            </>
          )
        }
      >
        <div className="en-setup-steps">
          <span className={registration ? "done" : "current"}>
            <i>{registration ? <IconCheck /> : 1}</i>
            {bi("登记执行机器", "Register Host")}
          </span>
          <span aria-hidden className="en-setup-line" />
          <span
            className={
              registeredOnline ? "done" : registration ? "current" : ""
            }
          >
            <i>{registeredOnline ? <IconCheck /> : 2}</i>
            {bi("安装并连接", "Install & Connect")}
          </span>
        </div>
        {!registration ? (
          <div className="en-form">
            <p className="en-lead">
              {bi(
                "这里只登记 1 台负责调度的主控机。业务目标机器在具体交付中自动带入并授权，无需在这里逐台填写。",
                "Register only the single control host here. Target workload hosts are automatically populated and authorized inside each delivery.",
              )}
            </p>
            {createError && (
              <div className="en-error" role="alert">
                <IconExclamationCircle />
                <span>{createError}</span>
                <AIHelpButton
                  variant="pill"
                  topic="execution-node-register-error"
                  title={bi("登记节点失败", "Node registration error")}
                  page={bi("接入执行节点", "Add Execution Node")}
                  error={createError}
                  prompt={bi(
                    `登记执行节点时报错：${createError}，请告诉我哪里填错了以及该怎么填。`,
                    `Got error registering an execution node: ${createError}. How do I fix it?`,
                  )}
                />
              </div>
            )}
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
                    "用于在交付中识别这台主控机",
                    "Displayed when selecting an execution node in deliveries",
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
          </div>
        ) : (
          <div className="en-connect">
            <div className="en-registration">
              <IconCheckCircle />
              <div>
                <b>
                  {bi(
                    `${registration.node.name} 已登记`,
                    `${registration.node.name} Registered`,
                  )}
                </b>
                <span>
                  {biv(
                    <>
                      {registration.node.kind === "independent"
                        ? "独立管理机"
                        : "集群内机器"}{" "}
                      <code>{registration.node.controller_ip}</code> ·{" "}
                      目标机器授权将在交付页「现场执行」中完成
                    </>,
                    <>
                      {registration.node.kind === "independent"
                        ? "Dedicated host"
                        : "In-cluster host"}{" "}
                      <code>{registration.node.controller_ip}</code> · Target
                      authorization is configured per delivery
                    </>,
                  )}
                </span>
              </div>
            </div>

            <section>
              <div className="en-sec-head">
                <h3>
                  {bi(
                    "1. 确认平台访问地址（供主控机回连）",
                    "1. Confirm Reachable Hub URL",
                  )}
                </h3>
                <AIHelpButton
                  topic="execution-node-hub-url"
                  title={bi("平台访问地址与 CA 证书", "Hub URL & CA Certificate")}
                  page={bi("安装并连接节点 · 平台地址", "Install Node · Hub URL")}
                  summary={bi(
                    `主控机 ${registration.node.controller_ip}，当前所选平台地址 ${cleanHubUrl}，自签名TLS=${bootInfo?.tls_self_signed ? "是" : "否"}`,
                    `Control host ${registration.node.controller_ip}, Hub URL ${cleanHubUrl}, self-signed=${bootInfo?.tls_self_signed}`,
                  )}
                  prompt={bi(
                    `我正在把执行节点 ${registration.node.name} (${registration.node.controller_ip}) 接入平台，当前填的平台地址是 ${cleanHubUrl}。请帮我确认这个地址和 CA 证书设置有没有问题？`,
                    `I'm connecting node ${registration.node.name} (${registration.node.controller_ip}) to ${cleanHubUrl}. Please check if the URL and CA cert setup are valid.`,
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
                        `127.0.0.1 / localhost 仅本机可达，远端主控机 (${registration.node.controller_ip}) 无法连回平台。请改用上方局域网或公网地址。`,
                        `127.0.0.1 / localhost is only reachable locally—remote host (${registration.node.controller_ip}) cannot reach it. Select a LAN or public URL above.`,
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
                  {bi(
                    "2. 下载一键安装包并在主控机执行",
                    "2. Download Bundle & Install as Background Service",
                  )}
                </h3>
                <AIHelpButton
                  topic="execution-node-install-cmd"
                  title={bi("安装包与后台服务说明", "Installer Bundle & Background Service")}
                  page={bi("安装并连接节点 · 一键安装", "Install Node · One-Command Install")}
                  command={oneLineInstallCmd}
                  summary={bi(
                    `主控机 ${registration.node.controller_ip}，安装包 ${bundleFile}`,
                    `Control host ${registration.node.controller_ip}, bundle ${bundleFile}`,
                  )}
                  prompt={bi(
                    "这个 .tar.gz 一键安装包里面包含什么？install.sh 会对我的主控机做哪些修改，后面怎么看日志或卸载？",
                    "What is inside the .tar.gz bundle, what does install.sh change on my host, and how do I view logs or uninstall it?",
                  )}
                  tooltip={bi("问 AI：安装包里面有什么？会改什么？", "Ask AI: What does install.sh do?")}
                />
              </div>
              <p>
                {bi(
                  "安装包已内置 Linux x64 执行器、专属连接配置、CA 证书及 systemd 后台脚本，解压执行一行命令即完成安装、后台启动与连通自检。",
                  "Self-contained bundle with Linux x64 runner, unique credentials, CA cert, and systemd installer. Extract and run one command to install, start in background, and verify connectivity.",
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
                    page={bi("安装并连接节点", "Install & Connect Node")}
                    error={bundleError}
                    prompt={bi(
                      `下载执行节点一键安装包时报错：${bundleError}，请帮我排查原因。`,
                      `Downloading the execution node installer bundle failed: ${bundleError}. Help diagnose.`,
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
              </div>
              <Command
                title={bi(
                  `上传到 ${registration.node.controller_ip} 后执行（自动后台运行）`,
                  `Run on ${registration.node.controller_ip} (runs in background via systemd)`,
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
                    {bi("连接配置 (execution-node.json)", "Config (execution-node.json)")}
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
              className={`en-connection ${registeredOnline ? "connected" : ""}`}
            >
              <div className="en-connection-left">
                <span className="en-live-dot" />
                <b>
                  {registeredOnline
                    ? bi(
                        `节点已连接${registeredNode?.version ? " · v" + registeredNode.version : ""}，请前往交付页授权并开始自动部署`,
                        `Connected${registeredNode?.version ? " · v" + registeredNode.version : ""}! Return to a delivery to authorize and deploy`,
                      )
                    : bi(
                        "等待执行机器连接… · 每 1.5 秒自动检测",
                        "Waiting for execution host to connect… · Checking every 1.5s",
                      )}
                </b>
              </div>
              {!registeredOnline && (
                <AIHelpButton
                  variant="pill"
                  topic={`connect-help-${registration.node.id}`}
                  title={bi("排查节点连接问题", "Troubleshoot Node Connection")}
                  page={bi("安装并连接节点 · 等待连接", "Install & Connect Node · Waiting")}
                  summary={bi(
                    `主控机 ${registration.node.name} (${registration.node.controller_ip})，配置地址 ${cleanHubUrl}，含CA=${includeCA}`,
                    `Control host ${registration.node.name} (${registration.node.controller_ip}), Hub URL ${cleanHubUrl}, includeCA=${includeCA}`,
                  )}
                  command={oneLineInstallCmd}
                  draft={bi(
                    `我在 ${registration.node.controller_ip} 上执行了安装命令，但页面一直显示等待连接。下面是终端输出：\n`,
                    `I ran the install command on ${registration.node.controller_ip} but it's still waiting to connect. Here is the terminal output:\n`,
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
    </article>
  );
}
